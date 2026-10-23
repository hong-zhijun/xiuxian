import { applyD1Migrations, env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import giftSql from '../../../migrations/0074_friday_gift.sql?raw';
import { createApp } from '../src/app';
import { getSectState } from '../src/modules/game/service';
import { dataOf, TestClient } from './support/authClient';
import { runSql } from './support/sql';

/**
 * 0074 周五下班福利（一次性数据迁移）。
 *
 * 测试库的迁移在建宗门之前就跑完了（那时没有宗门，福利不发给任何人），
 * 所以这里先建宗门，再把同一份迁移 SQL 手动执行一次来验证它的效果。
 * 本文件一份独立内存 D1，每个用例用独立账号，断言按宗门 id 定界。
 */
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

const quietLogger = { info: () => {}, warn: () => {}, error: () => {} } as const;
const app = createApp({ logger: quietLogger });
let seq = 0;

async function makeSect(): Promise<{ userId: string; sectId: string }> {
  seq += 1;
  const api = new TestClient(app, env, { 'cf-connecting-ip': `10.77.0.${seq}` });
  const registered = await api.post('/api/v1/auth/register', {
    account: `friday-${seq}`,
    password: 'password-123456',
  });
  expect(registered.status).toBe(200);
  const created = await api.post('/api/v1/game/create-sect', { name: `周五${seq}号` });
  expect(created.status).toBe(200);
  const sectId = (dataOf(created) as { state: { sect: { id: string } } }).state.sect.id;
  const row = await env.DB.prepare('SELECT user_id FROM sects WHERE id = ?')
    .bind(sectId)
    .first<{ user_id: string }>();
  return { userId: row!.user_id, sectId };
}

async function energyOf(sectId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT balance FROM resource_balances WHERE sect_id = ? AND resource_id = 'spiritualEnergy'",
  )
    .bind(sectId)
    .first<{ balance: number }>();
  return Number(row?.balance ?? 0);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('0074 周五下班福利', () => {
  it('每个宗门灵气 +10000（展示单位），天机录留一条「周五福利」，并发一条全服公告', async () => {
    const { sectId } = await makeSect();
    const before = await energyOf(sectId);

    await runSql(env.DB, giftSql);

    // 10000 展示单位 = 10000000 最小单位。
    expect(await energyOf(sectId)).toBe(before + 10_000_000);

    const events = await env.DB.prepare(
      "SELECT description, effects FROM event_log WHERE sect_id = ? AND event_id = 'fridayGift'",
    )
      .bind(sectId)
      .all<{ description: string; effects: string }>();
    expect(events.results).toHaveLength(1);
    expect(JSON.parse(events.results[0]!.effects)).toEqual({ spiritualEnergy: '10000000' });

    const announcement = await env.DB.prepare(
      "SELECT content FROM chat_messages WHERE id = 'announcement-friday-gift-20261023'",
    ).first<{ content: string }>();
    expect(announcement?.content).toContain('周五下班');
    expect(announcement?.content).toContain('10000 灵气');
  });

  it('超出容量的灵气照样保留，天机录里的展示名是「周五福利」', async () => {
    const { userId, sectId } = await makeSect();
    await runSql(env.DB, giftSql);
    const energy = await energyOf(sectId);
    // 新宗门 1 级的灵气容量是 3000000（最小单位），这份福利 10000000 远超它 —— 说明没有夹容量。
    expect(energy).toBeGreaterThan(3_000_000);

    // 过 1 小时结算：福利只发一次，余额不会因为满仓被截断。
    // random 钉 0 → 结算必然触发的事件是第一个（灵石矿脉 +80 灵石），不会动灵气；灵气满仓也不再自然产出。
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const state = await getSectState(env.DB, userId, Date.now() + 3_600_000);
    if (state === null) throw new Error('宗门不存在');
    expect(await energyOf(sectId)).toBe(energy);
    const resources = state.resources as { id: string; balance: string }[];
    expect(Number(resources.find((item) => item.id === 'spiritualEnergy')!.balance)).toBe(energy);

    const gift = state.recentEvents.find((item) => item.eventId === 'fridayGift');
    expect(gift?.name).toBe('周五福利');
    expect(gift?.effects).toEqual({ spiritualEnergy: '10000000' });
  });
});
