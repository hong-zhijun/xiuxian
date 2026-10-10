import { applyD1Migrations, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { upgradeBuilding } from '../src/modules/game/service';

import { dataOf, TestClient } from './support/authClient';

/**
 * 灵石开源 · 灵矿扩到 10 级：6～10 级的宗门等级门槛、分档消耗、满级拒绝，以及灵石速率随等级变化。
 * 与 spirit-array.test.ts 同一做法：last_settled_at 拨到 now（结算窗口为 0），余额断言只受升级影响。
 */

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

const app = createApp({ logger: { info: () => {}, warn: () => {}, error: () => {} } });
const NOW = Date.UTC(2026, 5, 1, 4, 0);

async function makeSect(): Promise<{ userId: string; sectId: string }> {
  const api = new TestClient(app, env, { 'cf-connecting-ip': '10.22.0.1' });
  expect((await api.post('/api/v1/auth/register', { account: 'mine-1', password: 'password-123456' })).status).toBe(200);
  const created = await api.post('/api/v1/game/create-sect', { name: '灵矿宗' });
  const sectId = (dataOf(created) as Record<string, any>).state.sect.id as string;
  const row = await env.DB.prepare('SELECT user_id FROM sects WHERE id = ?').bind(sectId).first<{ user_id: string }>();
  await env.DB.prepare('UPDATE sects SET level = 5, last_settled_at = ? WHERE id = ?').bind(NOW, sectId).run();
  await env.DB.prepare("UPDATE buildings SET level = 5 WHERE sect_id = ? AND def_id = 'missionHall'").bind(sectId).run();
  for (const [resourceId, balance] of [['spiritStone', 50_000_000], ['ore', 30_000_000], ['xuantie', 100_000]] as const) {
    await env.DB.prepare('UPDATE resource_balances SET balance = ? WHERE sect_id = ? AND resource_id = ?')
      .bind(balance, sectId, resourceId)
      .run();
  }
  return { userId: row!.user_id, sectId };
}

async function balanceOf(sectId: string, resourceId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT balance FROM resource_balances WHERE sect_id = ? AND resource_id = ?')
    .bind(sectId, resourceId)
    .first<{ balance: number }>();
  return Number(row?.balance ?? 0);
}

describe('灵矿 6～10 级', () => {
  it('宗门等级不够拒绝；够了按分档扣费；10 级封顶；灵石速率跟着涨', async () => {
    const { userId, sectId } = await makeSect();
    await expect(upgradeBuilding(env.DB, userId, 'missionHall', NOW)).rejects.toMatchObject({ code: 'INVALID_STATUS' });

    await env.DB.prepare('UPDATE sects SET level = 10 WHERE id = ?').bind(sectId).run();
    const stone = await balanceOf(sectId, 'spiritStone');
    const ore = await balanceOf(sectId, 'ore');
    const level6 = await upgradeBuilding(env.DB, userId, 'missionHall', NOW);
    expect(await balanceOf(sectId, 'spiritStone')).toBe(stone - 1_000_000);
    expect(await balanceOf(sectId, 'ore')).toBe(ore - 1_500_000);
    expect(level6.buildings.find((building) => building.defId === 'missionHall')).toMatchObject({ level: 6, maxLevel: 10 });
    const stoneRate6 = Number(level6.resources.find((resource) => resource.id === 'spiritStone')?.ratePerHour);

    let state = level6;
    for (let level = 7; level <= 10; level += 1) {
      state = await upgradeBuilding(env.DB, userId, 'missionHall', NOW);
    }
    expect(state.buildings.find((building) => building.defId === 'missionHall')?.level).toBe(10);
    expect(await balanceOf(sectId, 'xuantie')).toBe(100_000 - 30_000);
    expect(Number(state.resources.find((resource) => resource.id === 'spiritStone')?.ratePerHour)).toBeGreaterThan(stoneRate6);
    await expect(upgradeBuilding(env.DB, userId, 'missionHall', NOW)).rejects.toMatchObject({ code: 'INVALID_STATUS' });
  });
});
