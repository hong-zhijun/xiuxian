import { applyD1Migrations, env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ScratchCardTicket } from '@xiuxian/contracts';
import { createApp } from '../src/app';
import { dateKeyUtc8 } from '../src/modules/game/constants';
import * as scratchRules from '../src/modules/game/scratchCards';
import { dataOf, errorOf, TestClient, type ApiResult } from './support/authClient';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
const app = createApp({ logger: { info() {}, warn() {}, error() {} } });
let sequence = 0;
afterEach(() => vi.restoreAllMocks());

async function fixture(level = 2) {
  const id = ++sequence;
  const client = new TestClient(app, env, { 'cf-connecting-ip': `10.27.0.${id}` });
  expect((await client.post('/api/v1/auth/register', { account: `scratch-${id}`, password: 'scratch-test-password' })).status).toBe(200);
  const created = await client.post('/api/v1/game/create-sect', { name: `刮签${id}宗` });
  const sectId = (dataOf(created).state as { sect: { id: string } }).sect.id;
  await env.DB.prepare('UPDATE sects SET level = ?, last_settled_at = ? WHERE id = ?').bind(level, Date.now() + 600_000, sectId).run();
  await env.DB.prepare("UPDATE resource_balances SET balance = 1000000 WHERE sect_id = ? AND resource_id = 'spiritStone'").bind(sectId).run();
  return { client, sectId };
}

async function ledger(sectId: string) {
  const row = await env.DB.prepare(`SELECT
    (SELECT balance FROM resource_balances WHERE sect_id = ? AND resource_id = 'spiritStone') AS balance,
    (SELECT debate_count FROM sects WHERE id = ?) AS used,
    (SELECT COUNT(*) FROM dao_debate_log WHERE sect_id = ? AND bet_mode = 'scratch') AS receipts`).bind(sectId, sectId, sectId).first<{ balance: number; used: number; receipts: number }>();
  return row!;
}
const buy = (client: TestClient, requestId = crypto.randomUUID(), tier = 'basic', mode = 'triple') => client.post('/api/v1/game/scratch-cards/buy', { requestId, tier, mode });
const ticketOf = (response: ApiResult) => dataOf(response).ticket as ScratchCardTicket;

describe('刮刮乐 HTTP / D1 结算', () => {
  it.each([['numbers', 20], ['lines', 17], ['duel', 0]] as const)('%s 按自己的票面规则结算，多项奖励合并入账并能幂等恢复', async (mode, multiplier) => {
    const { client, sectId } = await fixture();
    vi.spyOn(Math, 'random').mockReturnValue(0.9999);
    const requestId = crypto.randomUUID();
    const first = await buy(client, requestId, 'basic', mode);
    expect(first.status).toBe(200);
    const ticket = ticketOf(first);
    expect(ticket.mode).toBe(mode);
    expect(ticket.multiplier).toBe(multiplier);
    expect(Number(ticket.reward)).toBe(50_000 * multiplier);
    expect(ticket.multiplier).toBe(ticket.wins.reduce((sum, win) => sum + win.multiplier, 0));
    const before = await ledger(sectId);
    expect(before).toEqual({ balance: 950_000 + 50_000 * multiplier, used: 1, receipts: 1 });
    expect(ticketOf(await buy(client, requestId, 'basic', mode))).toEqual(ticket);
    expect(errorOf(await buy(client, requestId, 'basic', 'triple')).code).toBe('INVALID_STATUS');
    expect(await ledger(sectId)).toEqual(before);
    const history = dataOf(await client.get('/api/v1/game/debate-history')) as Record<string, any>;
    expect(history.stats.netSpiritStone).toBe(50_000 * (multiplier - 1));
  });

  it.each([[1, 0.5], [3, 3.5]])('比大小赢%s局：半倍小奖与全胜额外奖励准确入账', async (wins, multiplier) => {
    const { client, sectId } = await fixture();
    const sequence = [0, 0, 0, ...Array.from({ length: 3 }, (_, index) => index < wins ? 0.9999 : 0)];
    const card = scratchRules.rollScratchCard(() => sequence.shift() ?? 0, 'duel');
    vi.spyOn(scratchRules, 'rollScratchCard').mockReturnValue(card);
    const response = await buy(client, crypto.randomUUID(), 'basic', 'duel');
    expect(response.status).toBe(200);
    expect(ticketOf(response).multiplier).toBe(multiplier);
    expect(await ledger(sectId)).toEqual({ balance: 950_000 + 50_000 * multiplier, used: 1, receipts: 1 });
  });

  it('旧版单玩法的历史票可恢复，省略玩法的旧客户端请求仍返回同一张票', async () => {
    const { client, sectId } = await fixture();
    vi.spyOn(Math, 'random').mockReturnValue(0.7);
    const requestId = crypto.randomUUID();
    const ticket = ticketOf(await buy(client, requestId));
    const oldTicket = { ...ticket } as Record<string, unknown>;
    for (const key of ['mode', 'modeName', 'cells', 'targets', 'wins']) delete oldTicket[key];
    await env.DB.prepare('UPDATE dao_debate_log SET reward_detail = ? WHERE id = ?').bind(JSON.stringify({ type: 'resource', amount: ticket.reward, resourceId: 'spiritStone', ticket: oldTicket }), ticket.id).run();
    const restored = dataOf(await client.get('/api/v1/game/scratch-cards')).ticket as ScratchCardTicket;
    expect(restored.mode).toBe('triple');
    expect(restored.cells).toHaveLength(9);
    expect(restored.wins[0]!.multiplier).toBe(ticket.multiplier);
    const before = await ledger(sectId);
    expect(ticketOf(await client.post('/api/v1/game/scratch-cards/buy', { tier: 'basic', requestId }))).toEqual(restored);
    expect(await ledger(sectId)).toEqual(before);
  });

  it('购票扣款、奖额、次数、票面与记录在同一事务保存', async () => {
    const { client, sectId } = await fixture();
    vi.spyOn(Math, 'random').mockReturnValue(0.9999);
    const response = await buy(client);
    expect(response.status).toBe(200);
    const ticket = ticketOf(response);
    expect(ticket).toMatchObject({ cost: '50000', reward: '2500000', netGain: '2450000', multiplier: 50, winningSymbol: 'dragon' });
    expect(ticket.symbols.filter(symbol => symbol === 'dragon')).toHaveLength(3);
    expect(await ledger(sectId)).toEqual({ balance: 3_450_000, used: 1, receipts: 1 });
    const history = dataOf(await client.get('/api/v1/game/debate-history')) as Record<string, any>;
    expect(history.entries[0].betMode).toBe('scratch');
    expect(history.stats.netSpiritStone).toBe(2_450_000);
    expect((dataOf(response).state as Record<string, any>).gambling.usedToday).toBe(1);
  });

  it('未中奖与回本奖都准确扣款，不把票价当作额外奖金', async () => {
    const { client, sectId } = await fixture();
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.1);
    expect(ticketOf(await buy(client)).reward).toBe('0');
    expect((await ledger(sectId)).balance).toBe(950_000);
    random.mockReturnValue(0.7);
    const ticket = ticketOf(await buy(client));
    expect(ticket).toMatchObject({ reward: '50000', netGain: '0', multiplier: 1 });
    expect(await ledger(sectId)).toEqual({ balance: 950_000, used: 2, receipts: 2 });
  });

  it('重复购票返回原票，次数用完后仍可恢复，篡改同编号档位会被拒绝', async () => {
    const { client, sectId } = await fixture();
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const requestId = crypto.randomUUID();
    const first = ticketOf(await buy(client, requestId));
    await env.DB.prepare('UPDATE sects SET debate_date_key = ?, debate_count = 50 WHERE id = ?').bind(dateKeyUtc8(Date.now()), sectId).run();
    const before = await ledger(sectId);
    expect(ticketOf(await buy(client, requestId))).toEqual(first);
    expect(dataOf(await client.get(`/api/v1/game/scratch-cards?requestId=${requestId}`)).ticket).toEqual(first);
    const changed = await buy(client, requestId, 'lucky');
    expect(errorOf(changed).code).toBe('INVALID_STATUS');
    expect(await ledger(sectId)).toEqual(before);
    expect(errorOf(await buy(client)).code).toBe('DAILY_LIMIT');
  });

  it('同一编号并发购票只扣一次、只开一张，并向所有重试返回同一结果', async () => {
    const { client, sectId } = await fixture();
    vi.spyOn(Math, 'random').mockReturnValue(0.9999);
    const requestId = crypto.randomUUID();
    const results = await Promise.all(Array.from({ length: 4 }, () => buy(client, requestId)));
    expect(results.map(result => result.status)).toEqual([200, 200, 200, 200]);
    for (const response of results) expect(ticketOf(response)).toEqual(ticketOf(results[0]!));
    expect(await ledger(sectId)).toEqual({ balance: 3_450_000, used: 1, receipts: 1 });
  });

  it('不同编号并发争抢最后一次额度，最多一张提交成功', async () => {
    const { client, sectId } = await fixture();
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    await env.DB.prepare('UPDATE sects SET debate_date_key = ?, debate_count = 49 WHERE id = ?').bind(dateKeyUtc8(Date.now()), sectId).run();
    const results = await Promise.all(Array.from({ length: 4 }, () => buy(client)));
    expect(results.filter(response => response.status === 200)).toHaveLength(1);
    expect(await ledger(sectId)).toEqual({ balance: 950_000, used: 50, receipts: 1 });
  });

  it('余额只够一张时，并发购票不会透支', async () => {
    const { client, sectId } = await fixture();
    await env.DB.prepare("UPDATE resource_balances SET balance = 50000 WHERE sect_id = ? AND resource_id = 'spiritStone'").bind(sectId).run();
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const results = await Promise.all([buy(client), buy(client)]);
    expect(results.filter(response => response.status === 200)).toHaveLength(1);
    expect(await ledger(sectId)).toEqual({ balance: 0, used: 1, receipts: 1 });
  });

  it('宗门之间的票签隔离，同编号可独立购买，读取历史不再扣费', async () => {
    const one = await fixture(), two = await fixture();
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const requestId = crypto.randomUUID();
    const first = ticketOf(await buy(one.client, requestId));
    expect(dataOf(await two.client.get(`/api/v1/game/scratch-cards?requestId=${requestId}`)).ticket).toBeNull();
    expect(ticketOf(await buy(two.client, requestId)).id).not.toBe(first.id);
    expect(dataOf(await one.client.get('/api/v1/game/scratch-cards')).ticket).toEqual(first);
    expect(await ledger(one.sectId)).toEqual({ balance: 950_000, used: 1, receipts: 1 });
  });

  it('未解锁、余额不足、非法参数或伪造奖额都不会留下购票记录', async () => {
    const { client, sectId } = await fixture(1);
    expect(errorOf(await buy(client)).code).toBe('INVALID_STATUS');
    await env.DB.prepare('UPDATE sects SET level = 2 WHERE id = ?').bind(sectId).run();
    for (const input of [
      { tier: 'basic', requestId: 'invalid' },
      { tier: 'invalid', requestId: crypto.randomUUID() },
      { tier: 'basic', requestId: crypto.randomUUID(), reward: '999999999' },
    ]) expect((await client.post('/api/v1/game/scratch-cards/buy', input)).status).toBe(400);
    await env.DB.prepare("UPDATE resource_balances SET balance = 49999 WHERE sect_id = ? AND resource_id = 'spiritStone'").bind(sectId).run();
    expect(errorOf(await buy(client)).code).toBe('INSUFFICIENT_RESOURCE');
    expect(await ledger(sectId)).toEqual({ balance: 49_999, used: 0, receipts: 0 });
  });

  it('复用登录和CSRF保护', async () => {
    const anonymous = new TestClient(app, env);
    expect((await anonymous.get('/api/v1/game/scratch-cards')).status).toBe(401);
    const { client, sectId } = await fixture();
    expect((await client.post('/api/v1/game/scratch-cards/buy', { tier: 'basic', requestId: crypto.randomUUID() }, { csrfToken: null })).status).toBe(403);
    expect((await ledger(sectId)).receipts).toBe(0);
  });
});
