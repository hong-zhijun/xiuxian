import { applyD1Migrations, env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import giftSql from '../../../migrations/0075_scratch_card_update_gift.sql?raw';
import { createApp } from '../src/app';
import { getSectState } from '../src/modules/game/service';
import { dataOf, TestClient } from './support/authClient';
import { splitSqlStatements } from './support/sql';

const MIGRATION = '0075_scratch_card_update_gift.sql';
const REWARD = 100_000_000 * 1000;
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.filter(item => item.name !== MIGRATION));

const app = createApp({ logger: { info() {}, warn() {}, error() {} } });
let sequence = 0;
afterEach(() => vi.restoreAllMocks());

async function makeSect() {
  const index = ++sequence;
  const api = new TestClient(app, env, { 'cf-connecting-ip': `10.78.0.${index}` });
  expect((await api.post('/api/v1/auth/register', {
    account: `scratch-gift-${index}`, password: 'scratch-gift-password',
  })).status).toBe(200);
  const created = await api.post('/api/v1/game/create-sect', { name: `更新${index}宗` });
  expect(created.status).toBe(200);
  const sectId = (dataOf(created).state as { sect: { id: string } }).sect.id;
  const sect = await env.DB.prepare('SELECT user_id FROM sects WHERE id = ?')
    .bind(sectId).first<{ user_id: string }>();
  return { sectId, userId: sect!.user_id };
}

async function stoneOf(sectId: string) {
  return Number((await env.DB.prepare(
    "SELECT balance FROM resource_balances WHERE sect_id = ? AND resource_id = 'spiritStone'",
  ).bind(sectId).first<{ balance: number }>())?.balance ?? 0);
}

async function giftsOf(sectId: string) {
  return (await env.DB.prepare(
    "SELECT description, effects FROM event_log WHERE sect_id = ? AND event_id = 'scratchCardUpdateGift'",
  ).bind(sectId).all<{ description: string; effects: string }>()).results;
}

function giftStatements() {
  return splitSqlStatements(giftSql).map(statement => env.DB.prepare(statement));
}

describe('0075 刮刮乐更新奖励', () => {
  it('迁移给所有已有宗门各加一亿灵石，补齐缺失余额，重复部署及后建宗门不再发奖', async () => {
    const first = await makeSect();
    const missing = await makeSect();
    const before = await stoneOf(first.sectId);
    await env.DB.prepare("DELETE FROM resource_balances WHERE sect_id = ? AND resource_id = 'spiritStone'")
      .bind(missing.sectId).run();
    const otherBalances = await env.DB.prepare(
      "SELECT resource_id, balance, remainder FROM resource_balances WHERE sect_id = ? AND resource_id <> 'spiritStone' ORDER BY resource_id",
    ).bind(first.sectId).all();

    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

    expect(await stoneOf(first.sectId)).toBe(before + REWARD);
    expect(await stoneOf(missing.sectId)).toBe(REWARD);
    expect((await env.DB.prepare(
      "SELECT resource_id, balance, remainder FROM resource_balances WHERE sect_id = ? AND resource_id <> 'spiritStone' ORDER BY resource_id",
    ).bind(first.sectId).all()).results).toEqual(otherBalances.results);
    for (const sectId of [first.sectId, missing.sectId]) {
      const gifts = await giftsOf(sectId);
      expect(gifts).toHaveLength(1);
      expect(gifts[0]!.description).toContain('10000 万（1 亿）灵石');
      expect(JSON.parse(gifts[0]!.effects)).toEqual({ spiritStone: String(REWARD) });
    }

    const announcement = await env.DB.prepare(
      "SELECT content FROM chat_messages WHERE id = 'announcement-scratch-card-update-20261024'",
    ).first<{ content: string }>();
    expect(announcement?.content).toContain('10000 万（1 亿）灵石');
    expect(announcement?.content).toContain('刮开 80%');

    const later = await makeSect();
    const laterBalance = await stoneOf(later.sectId);
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    expect(await stoneOf(first.sectId)).toBe(before + REWARD);
    expect(await giftsOf(first.sectId)).toHaveLength(1);
    expect(await stoneOf(later.sectId)).toBe(laterBalance);
    expect(await giftsOf(later.sectId)).toHaveLength(0);
  });

  it('重复执行发奖 SQL 不会重复加款、天机录或全服公告', async () => {
    const { sectId } = await makeSect();
    const before = await stoneOf(sectId);
    await env.DB.batch(giftStatements());
    await env.DB.batch(giftStatements());
    expect(await stoneOf(sectId)).toBe(before + REWARD);
    expect(await giftsOf(sectId)).toHaveLength(1);
    expect(Number((await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM chat_messages WHERE id = 'announcement-scratch-card-update-20261024'",
    ).first<{ total: number }>())?.total)).toBe(1);
  });

  it('一亿奖励超出仓库也保留，离线结算后余额与天机录展示正确', async () => {
    const { sectId, userId } = await makeSect();
    await env.DB.batch(giftStatements());
    const balance = await stoneOf(sectId);
    // 固定为灵药盛开，排除随机事件增减灵石，验证结算不会截断运营福利。
    vi.spyOn(Math, 'random').mockReturnValue(0.2);
    const state = await getSectState(env.DB, userId, Date.now() + 3_600_000);
    expect(state).not.toBeNull();
    const resource = state!.resources.find(item => item.id === 'spiritStone')!;
    expect(balance).toBeGreaterThan(Number(resource.capacity));
    expect(Number(resource.balance)).toBe(balance);
    expect(await stoneOf(sectId)).toBe(balance);
    const gift = state!.recentEvents.find(item => item.eventId === 'scratchCardUpdateGift');
    expect(gift?.name).toBe('刮刮乐更新奖励');
    expect(gift?.effects).toEqual({ spiritStone: String(REWARD) });
  });

  it('事务失败时奖励和发奖凭据一并回滚，重试可完整发放', async () => {
    const { sectId } = await makeSect();
    const before = await stoneOf(sectId);
    await expect(env.DB.batch([
      ...giftStatements(),
      env.DB.prepare("INSERT INTO mutation_guards (command_id, valid) VALUES ('scratch-gift-rollback', 0)"),
    ])).rejects.toThrow();
    expect(await stoneOf(sectId)).toBe(before);
    expect(await giftsOf(sectId)).toHaveLength(0);
    await env.DB.batch(giftStatements());
    expect(await stoneOf(sectId)).toBe(before + REWARD);
    expect(await giftsOf(sectId)).toHaveLength(1);
  });
});
