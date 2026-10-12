import { applyD1Migrations, env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import giftSql from '../../../migrations/0050_monday_gift.sql?raw';
import { createApp } from '../src/app';
import { getSectState } from '../src/modules/game/service';
import { dataOf, TestClient } from './support/authClient';
import { runSql } from './support/sql';

/**
 * 0050 周一上班福利（一次性数据迁移）。
 *
 * 测试库的迁移在建宗门之前就跑完了（那时没有宗门，福利不发给任何人），
 * 所以这里先建宗门，再把同一份迁移 SQL 手动执行一次来验证它的效果。
 * 本文件一份独立内存 D1，每个用例用独立账号，断言按宗门 id 定界。
 */
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

const quietLogger = { info: () => {}, warn: () => {}, error: () => {} } as const;
const app = createApp({ logger: quietLogger });
const HOUR_MS = 3_600_000;
let seq = 0;

async function makeSect(): Promise<{ userId: string; sectId: string }> {
  seq += 1;
  const api = new TestClient(app, env, { 'cf-connecting-ip': `10.50.0.${seq}` });
  const registered = await api.post('/api/v1/auth/register', { account: `monday-${seq}`, password: 'password-123456' });
  expect(registered.status).toBe(200);
  const created = await api.post('/api/v1/game/create-sect', { name: `福利${seq}号` });
  expect(created.status).toBe(200);
  const sectId = (dataOf(created) as { state: { sect: { id: string } } }).state.sect.id;
  const row = await env.DB.prepare('SELECT user_id FROM sects WHERE id = ?').bind(sectId).first<{ user_id: string }>();
  return { userId: row!.user_id, sectId };
}

async function balanceOf(sectId: string, resourceId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT balance FROM resource_balances WHERE sect_id = ? AND resource_id = ?')
    .bind(sectId, resourceId)
    .first<{ balance: number }>();
  return Number(row?.balance ?? 0);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('0050 周一上班福利', () => {
  it('每个宗门灵石 +10000、矿石 +10000，并在天机录留一条记录', async () => {
    const { sectId } = await makeSect();
    const stoneBefore = await balanceOf(sectId, 'spiritStone');
    const oreBefore = await balanceOf(sectId, 'ore');

    await runSql(env.DB, giftSql);

    expect(await balanceOf(sectId, 'spiritStone')).toBe(stoneBefore + 10_000_000);
    expect(await balanceOf(sectId, 'ore')).toBe(oreBefore + 10_000_000);
    const events = await env.DB.prepare(
      "SELECT description, effects FROM event_log WHERE sect_id = ? AND event_id = 'mondayGift'",
    )
      .bind(sectId)
      .all<{ description: string; effects: string }>();
    expect(events.results).toHaveLength(1);
    expect(JSON.parse(events.results[0]!.effects)).toEqual({ spiritStone: '10000000', ore: '10000000' });
  });

  it('超出容量的福利在结算与随机事件后仍保留，天机录显示「周一福利」', async () => {
    const { userId, sectId } = await makeSect();
    await runSql(env.DB, giftSql);
    const stone = await balanceOf(sectId, 'spiritStone');
    const ore = await balanceOf(sectId, 'ore');
    // 新宗门 1 级：灵石容量 5000、矿石容量 2000，福利后都已超出。
    expect(stone).toBeGreaterThan(5_000_000);
    expect(ore).toBeGreaterThan(2_000_000);

    // 过 1 小时结算：random 钉 0 → 必然触发事件且都是第一个事件（灵石矿脉 +80 灵石）。
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const state = await getSectState(env.DB, userId, Date.now() + HOUR_MS);
    if (state === null) throw new Error('宗门不存在');

    const resources = state.resources as { id: string; balance: string }[];
    expect(Number(resources.find((item) => item.id === 'spiritStone')!.balance)).toBe(stone);
    expect(Number(resources.find((item) => item.id === 'ore')!.balance)).toBe(ore);
    expect(await balanceOf(sectId, 'spiritStone')).toBe(stone);

    const gift = state.recentEvents.find((item) => item.eventId === 'mondayGift');
    expect(gift?.name).toBe('周一福利');
    expect(gift?.effects).toEqual({ spiritStone: '10000000', ore: '10000000' });
  });
});
