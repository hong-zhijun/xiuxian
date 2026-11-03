import { applyD1Migrations, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { ProgressionAction, ProgressionPanel } from '@xiuxian/contracts';

import { createApp } from '../src/app';
import { dateKeyUtc8 } from '../src/modules/game/constants';
import { SECT_RENAME_COST } from '../src/modules/game/names';
import { actProgression, getProgression } from '../src/modules/game/progressionService';

import { dataOf, errorOf, TestClient, type ApiResult } from './support/authClient';

/**
 * 真实 workerd + D1：账号/鉴权/动作全部走 app；仅日期边界通过 service 的 now 参数控制。
 * 数据不逐用例回滚，每例独立宗门。直接写业务表只准备已有玩家的余额、境界与历史事实，
 * 不 mock 数据库、响应、结算或随机数；余额断言前冻结结算，随机奖励断言总量而非具体抽取。
 */
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

const app = createApp({ logger: { info: () => {}, warn: () => {}, error: () => {} } });
const PANEL = '/api/v1/game/progression';
const ACTION = '/api/v1/game/progression/action';
const DAY = 86_400_000;
let sequence = 0;

interface Fixture {
  api: TestClient;
  sectId: string;
  userId: string;
  discipleId: string;
}
type ActionInput = ProgressionAction extends infer A ? A extends { commandId: string } ? Omit<A, 'commandId'> : never : never;

async function makeSect(): Promise<Fixture> {
  sequence += 1;
  const api = new TestClient(app, env, { 'cf-connecting-ip': `10.81.0.${sequence}` });
  const registered = await api.post('/api/v1/auth/register', {
    account: `progression-${sequence}`, password: 'password-123456',
  });
  expect(registered.status).toBe(200);
  const created = await api.post('/api/v1/game/create-sect', { name: `成长${sequence}宗` });
  expect(created.status).toBe(200);
  const state = dataOf(created).state as { sect: { id: string }; disciples: { id: string }[] };
  const sectId = state.sect.id;
  const row = await env.DB.prepare('SELECT user_id FROM sects WHERE id = ?').bind(sectId).first<{ user_id: string }>();
  expect(row).not.toBeNull();
  await freeze(sectId);
  return { api, sectId, userId: row!.user_id, discipleId: state.disciples[0]!.id };
}

async function freeze(sectId: string, now = Date.now()): Promise<void> {
  await env.DB.prepare('UPDATE sects SET last_settled_at = ? WHERE id = ?').bind(now + DAY, sectId).run();
}
async function setBalance(sectId: string, resourceId: string, value: number): Promise<void> {
  await env.DB.prepare(`INSERT INTO resource_balances(id,sect_id,resource_id,balance,remainder,updated_at)
    VALUES(?,?,?,?,0,?) ON CONFLICT(sect_id,resource_id) DO UPDATE SET balance=excluded.balance,remainder=0`)
    .bind(crypto.randomUUID(), sectId, resourceId, value, Date.now()).run();
}
async function balance(sectId: string, resourceId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT balance FROM resource_balances WHERE sect_id=? AND resource_id=?')
    .bind(sectId, resourceId).first<{ balance: number }>();
  return Number(row?.balance ?? 0);
}
async function reputation(sectId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT reputation FROM sects WHERE id=?').bind(sectId).first<{ reputation: number }>();
  return Number(row!.reputation);
}
async function setReputation(sectId: string, value: number): Promise<void> {
  await env.DB.prepare('UPDATE sects SET reputation=? WHERE id=?').bind(value, sectId).run();
}
async function post(sect: Fixture, input: ActionInput, commandId = crypto.randomUUID()): Promise<ApiResult> {
  await freeze(sect.sectId);
  return sect.api.post(ACTION, { ...input, commandId });
}
function panelOf(result: ApiResult): ProgressionPanel {
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return dataOf(result).progression as ProgressionPanel;
}
async function panel(sect: Fixture): Promise<ProgressionPanel> {
  await freeze(sect.sectId);
  return panelOf(await sect.api.get(PANEL));
}
async function at(sect: Fixture, input: ActionInput, now: number, commandId = crypto.randomUUID()) {
  await freeze(sect.sectId, now);
  return actProgression(env.DB, sect.userId, { ...input, commandId } as ProgressionAction, now);
}
async function seedCheckin(sect: Fixture, options: {
  lastDate: string; streak: number; total?: number; month?: string; makeup?: number; now: number;
}): Promise<void> {
  await env.DB.prepare(`INSERT INTO sect_checkin(sect_id,streak,month_key,total_days,last_checkin_date,
    makeup_used,version,created_at,updated_at) VALUES(?,?,?,?,?,?,0,?,?)`)
    .bind(sect.sectId, options.streak, options.month ?? options.lastDate.slice(0, 7), options.total ?? options.streak,
      options.lastDate, options.makeup ?? 0, options.now - 40 * DAY, options.now).run();
  await env.DB.prepare('INSERT INTO sect_checkin_days(sect_id,date_key,streak,makeup,created_at) VALUES(?,?,?,0,?)')
    .bind(sect.sectId, options.lastDate, options.streak, options.now).run();
  await env.DB.prepare('UPDATE sects SET created_at=? WHERE id=?').bind(options.now - 40 * DAY, sect.sectId).run();
}
async function commandCount(sectId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM progression_commands WHERE sect_id=?').bind(sectId).first<{ n: number }>();
  return Number(row!.n);
}

// 奖励数额用规划中的字面量断言，避免用实现常量复制同一个错误。
describe('成长接口、领取与真实 D1 事务', () => {
  it('GET/POST 要求登录、写入要求 CSRF，严格拒绝注入宗门和日期', async () => {
    const anonymous = new TestClient(app, env);
    expect((await anonymous.get(PANEL)).status).toBe(401);
    expect((await anonymous.post(ACTION, { action: 'checkin', commandId: crypto.randomUUID() })).status).toBe(401);
    const sect = await makeSect();
    const csrf = await sect.api.post(ACTION, { action: 'checkin', commandId: crypto.randomUUID() }, { csrfToken: null });
    expect(csrf.status).toBe(403);
    for (const body of [
      { action: 'checkin', commandId: 'not-a-uuid' },
      { action: 'checkin', commandId: crypto.randomUUID(), sectId: sect.sectId },
      { action: 'makeup', commandId: crypto.randomUUID(), dateKey: '2026-01-01' },
    ]) {
      const rejected = await sect.api.post(ACTION, body);
      expect(rejected.status).toBe(400);
      expect(errorOf(rejected).code).toBe('VALIDATION_ERROR');
    }
    expect(await commandCount(sect.sectId)).toBe(0);
    const view = await panel(sect);
    expect(view.checkin).toMatchObject({ checkedToday: false, totalDays: 0, makeupLimit: 3, makeupCost: '500000' });
    expect(view.achievements.length).toBeGreaterThan(0);
    expect(view.quests.map(chapter => chapter.id)).toEqual(['kaishan', 'lipai', 'yangming', 'wending']);
  });

  it('首次签到发精确最小单位；回放不再发奖，同日新命令与换 payload 被拒', async () => {
    const sect = await makeSect();
    await setBalance(sect.sectId, 'spiritStone', 123_000);
    const commandId = crypto.randomUUID();
    const first = await post(sect, { action: 'checkin' }, commandId);
    expect(panelOf(first).checkin).toMatchObject({ checkedToday: true, totalDays: 1, streak: 1 });
    expect(await balance(sect.sectId, 'spiritStone')).toBe(5_123_000);
    const replay = await post(sect, { action: 'checkin' }, commandId);
    expect(dataOf(replay).result).toEqual(dataOf(first).result);
    expect(await balance(sect.sectId, 'spiritStone')).toBe(5_123_000);
    expect(errorOf(await post(sect, { action: 'checkin' })).code).toBe('INVALID_STATUS');
    expect(errorOf(await post(sect, { action: 'makeup' }, commandId)).code).toBe('VALIDATION_ERROR');
    expect(await commandCount(sect.sectId)).toBe(1);
    const days = await env.DB.prepare('SELECT date_key,makeup FROM sect_checkin_days WHERE sect_id=?').bind(sect.sectId).all();
    expect(days.results).toEqual([{ date_key: dateKeyUtc8(Date.now()), makeup: 0 }]);
  });

  it('并发签到仅一份奖励，同 commandId 并发回放也只有一条凭据', async () => {
    const sect = await makeSect();
    await setBalance(sect.sectId, 'spiritStone', 0);
    const commandId = crypto.randomUUID();
    const responses = await Promise.all([1, 2, 3].map(() => sect.api.post(ACTION, { action: 'checkin', commandId })));
    expect(responses.every(response => response.status === 200), JSON.stringify(responses)).toBe(true);
    expect(await balance(sect.sectId, 'spiritStone')).toBe(5_000_000);
    expect(await commandCount(sect.sectId)).toBe(1);
    expect((await panel(sect)).checkin.totalDays).toBe(1);
    const another = await makeSect();
    await setBalance(another.sectId, 'spiritStone', 0);
    const raced = await Promise.all([1, 2].map(() => another.api.post(ACTION, { action: 'checkin', commandId: crypto.randomUUID() })));
    expect(raced.filter(result => result.status === 200)).toHaveLength(1);
    expect(raced.some(result => result.status >= 500), JSON.stringify(raced)).toBe(false);
    expect(await balance(another.sectId, 'spiritStone')).toBe(5_000_000);
  });

  it('UTC+8 午夜前后计入两天；次日重放旧命令不占用今日签到，断签重新从第1天开始', async () => {
    const sect = await makeSect();
    const midnight = Date.parse('2027-01-02T00:00:00+08:00');
    const commandId = crypto.randomUUID();
    const first = await at(sect, { action: 'checkin' }, midnight - 1, commandId);
    expect(first.progression.checkin).toMatchObject({ dateKey: '2027-01-01', streak: 1 });
    const replay = await at(sect, { action: 'checkin' }, midnight, commandId);
    expect(replay.result).toEqual(first.result);
    expect(replay.progression.checkin).toMatchObject({ dateKey: '2027-01-02', checkedToday: false, totalDays: 1 });
    const herbBefore = await balance(sect.sectId, 'herb');
    const next = await at(sect, { action: 'checkin' }, midnight);
    expect(next.progression.checkin).toMatchObject({ streak: 2, totalDays: 2, checkedToday: true });
    expect(await balance(sect.sectId, 'herb')).toBe(herbBefore + 2_000_000);
    const reset = await at(sect, { action: 'checkin' }, midnight + 2 * DAY);
    expect(reset.progression.checkin).toMatchObject({ streak: 1, totalDays: 3 });
  });

  it('补签扣500灵石、每月最多3次，跨月重置；余额不足和今天已签到均不写凭据', async () => {
    const sect = await makeSect();
    const now = Date.parse('2027-01-10T12:00:00+08:00');
    await seedCheckin(sect, { lastDate: '2027-01-06', streak: 1, now });
    await setBalance(sect.sectId, 'spiritStone', 2_000_000);
    for (const date of ['2027-01-07', '2027-01-08', '2027-01-09']) {
      const result = await at(sect, { action: 'makeup' }, now);
      expect(result.result.message).toContain(date);
    }
    expect(await balance(sect.sectId, 'spiritStone')).toBe(500_000);
    expect((await getProgression(env.DB, sect.userId, now)).progression.checkin.makeupUsed).toBe(3);
    await expect(at(sect, { action: 'makeup' }, now + 2 * DAY)).rejects.toMatchObject({ code: 'INVALID_STATUS' });
    expect(await commandCount(sect.sectId)).toBe(3);
    const february = Date.parse('2027-02-02T12:00:00+08:00');
    const reset = await at(sect, { action: 'makeup' }, february);
    expect(reset.progression.checkin.makeupUsed).toBe(1);
    expect(reset.result.message).toContain('2027-02-01');
    await at(sect, { action: 'checkin' }, february);
    await expect(at(sect, { action: 'makeup' }, february)).rejects.toMatchObject({ code: 'INVALID_STATUS' });
    const poor = await makeSect();
    await seedCheckin(poor, { lastDate: '2027-01-08', streak: 1, now });
    await setBalance(poor.sectId, 'spiritStone', 499_999);
    await expect(at(poor, { action: 'makeup' }, now)).rejects.toMatchObject({ code: 'INVALID_STATUS' });
    expect(await balance(poor.sectId, 'spiritStone')).toBe(499_999);
    expect(await commandCount(poor.sectId)).toBe(0);
  });

  it('成就从真实宗门状态判断资格；并发领取铜奖励只入账一次', async () => {
    const sect = await makeSect();
    await setBalance(sect.sectId, 'spiritStone', 0);
    expect(errorOf(await post(sect, { action: 'claim-achievement', id: 'sect-5' })).code).toBe('INVALID_STATUS');
    expect(await balance(sect.sectId, 'spiritStone')).toBe(0);
    await env.DB.prepare('UPDATE sects SET level=5 WHERE id=?').bind(sect.sectId).run();
    const ready = (await panel(sect)).achievements.find(item => item.id === 'sect-5');
    expect(ready).toMatchObject({ completed: true, claimed: false, progress: 5 });
    const raced = await Promise.all([1, 2].map(() => sect.api.post(ACTION, {
      action: 'claim-achievement', id: 'sect-5', commandId: crypto.randomUUID(),
    })));
    expect(raced.filter(result => result.status === 200)).toHaveLength(1);
    expect(raced.some(result => result.status >= 500), JSON.stringify(raced)).toBe(false);
    expect(await reputation(sect.sectId)).toBe(50);
    expect(await balance(sect.sectId, 'spiritStone')).toBe(20_000_000);
    expect((await panel(sect)).achievements.find(item => item.id === 'sect-5')?.claimed).toBe(true);
  });

  it('主线校验未完成/前置章；老玩家真实境界与派工补认并发领取一次', async () => {
    const sect = await makeSect();
    await setBalance(sect.sectId, 'spiritStone', 0);
    expect(errorOf(await post(sect, { action: 'claim-quest', id: 'kaishan' })).code).toBe('INVALID_STATUS');
    expect(errorOf(await post(sect, { action: 'claim-quest', id: 'lipai' })).code).toBe('INVALID_STATUS');
    await env.DB.prepare('UPDATE sects SET level=2 WHERE id=?').bind(sect.sectId).run();
    await env.DB.prepare("UPDATE disciples SET stage=2,assignment='spiritStone' WHERE id=?").bind(sect.discipleId).run();
    expect((await panel(sect)).quests[0]).toMatchObject({ completed: true, claimed: false });
    const commandId = crypto.randomUUID();
    const raced = await Promise.all([1, 2].map(() => sect.api.post(ACTION, { action: 'claim-quest', id: 'kaishan', commandId })));
    expect(raced.every(result => result.status === 200), JSON.stringify(raced)).toBe(true);
    expect(await balance(sect.sectId, 'spiritStone')).toBe(10_000_000);
    const view = await panel(sect);
    expect(view.quests[0]?.claimed).toBe(true);
    expect(view.quests[1]?.unlocked).toBe(true);
    const stored = await env.DB.prepare('SELECT completed FROM sect_quests WHERE sect_id=?').bind(sect.sectId).first<{ completed: string }>();
    expect(JSON.parse(stored!.completed)).toEqual(['kaishan']);
  });

  it('声望不足不扣款；并发只够一次的兑换不能透支且资源恰好发一份', async () => {
    const sect = await makeSect();
    await setReputation(sect.sectId, 99);
    await setBalance(sect.sectId, 'beastEssence', 0);
    expect(errorOf(await post(sect, { action: 'buy-reputation', id: 'essence-10' })).code).toBe('INVALID_STATUS');
    expect(await reputation(sect.sectId)).toBe(99);
    await setReputation(sect.sectId, 100);
    const raced = await Promise.all([1, 2].map(() => sect.api.post(ACTION, { action: 'buy-reputation', id: 'essence-10', commandId: crypto.randomUUID() })));
    expect(raced.filter(result => result.status === 200)).toHaveLength(1);
    expect(raced.some(result => result.status >= 500), JSON.stringify(raced)).toBe(false);
    expect(await reputation(sect.sectId)).toBe(0);
    expect(await balance(sect.sectId, 'beastEssence')).toBe(10_000);
    const purchase = await env.DB.prepare('SELECT quantity FROM sect_reputation_purchases WHERE sect_id=? AND item_id=?')
      .bind(sect.sectId, 'essence-10').first<{ quantity: number }>();
    expect(purchase?.quantity).toBe(1);
  });

  it('称号只可购买一次，200bp永久加成与外观在后续sync真实持久化', async () => {
    const sect = await makeSect();
    await setReputation(sect.sectId, 1000);
    const bought = await post(sect, { action: 'buy-reputation', id: 'title-rising-star' });
    expect(panelOf(bought)).toMatchObject({ reputation: 500, productionBonusBp: 200 });
    expect(panelOf(bought).cosmetics).toContainEqual({ id: 'rising-star', kind: 'title', name: '后起之秀' });
    expect(errorOf(await post(sect, { action: 'buy-reputation', id: 'title-rising-star' })).code).toBe('INVALID_STATUS');
    expect(await reputation(sect.sectId)).toBe(500);
    expect(panelOf(await post(sect, { action: 'set-title', id: 'rising-star' })).equippedTitle).toBe('rising-star');
    const sync = await sect.api.get('/api/v1/game/sync');
    expect(sync.status).toBe(200);
    const state = dataOf(sync).state as { sect: { progression: { titleId: string | null; productionBonusBp: number } } };
    expect(state.sect.progression).toMatchObject({ titleId: 'rising-star', productionBonusBp: 200 });
    expect(panelOf(await post(sect, { action: 'set-title', id: null }))).toMatchObject({ equippedTitle: null, productionBonusBp: 200 });
    const stored = await env.DB.prepare('SELECT production_bonus_bp,equipped_title FROM sect_progression WHERE sect_id=?')
      .bind(sect.sectId).first();
    expect(stored).toEqual({ production_bonus_bp: 200, equipped_title: null });
  });

  it('改名令购买扣声望、改名优先耗令且不扣灵石，耗尽后恢复原价', async () => {
    const sect = await makeSect();
    await setReputation(sect.sectId, 1000);
    await setBalance(sect.sectId, 'spiritStone', SECT_RENAME_COST);
    expect(panelOf(await post(sect, { action: 'buy-reputation', id: 'rename-token' }))).toMatchObject({ reputation: 0, renameTokens: 1 });
    const invalid = await sect.api.post('/api/v1/game/rename-sect', { name: '一' });
    expect(invalid.status).toBe(400);
    expect((await panel(sect)).renameTokens).toBe(1);
    await freeze(sect.sectId);
    expect((await sect.api.post('/api/v1/game/rename-sect', { name: `令牌${sequence}宗` })).status).toBe(200);
    expect(await balance(sect.sectId, 'spiritStone')).toBe(SECT_RENAME_COST);
    expect((await panel(sect)).renameTokens).toBe(0);
    await freeze(sect.sectId);
    expect((await sect.api.post('/api/v1/game/rename-sect', { name: `灵石${sequence}宗` })).status).toBe(200);
    expect(await balance(sect.sectId, 'spiritStone')).toBe(0);
  });

  it('宗门间命令ID、领取凭据与外观所有权隔离', async () => {
    const owner = await makeSect();
    const other = await makeSect();
    const commandId = crypto.randomUUID();
    await setReputation(owner.sectId, 500);
    expect((await post(owner, { action: 'buy-reputation', id: 'title-rising-star' }, commandId)).status).toBe(200);
    expect(errorOf(await post(other, { action: 'set-title', id: 'rising-star' })).code).toBe('INVALID_STATUS');
    await setBalance(other.sectId, 'spiritStone', 0);
    expect((await post(other, { action: 'checkin' }, commandId)).status).toBe(200);
    expect(await balance(other.sectId, 'spiritStone')).toBe(5_000_000);
    expect((await panel(other)).cosmetics).toEqual([]);
    expect((await panel(other)).productionBonusBp).toBe(0);
    expect((await panel(owner)).checkin.totalDays).toBe(0);
    expect(await commandCount(owner.sectId)).toBe(1);
    expect(await commandCount(other.sectId)).toBe(1);
  });
});
