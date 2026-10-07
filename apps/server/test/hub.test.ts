import { applyD1Migrations, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { getHub, occupyVein } from '../src/modules/game/service';

import { dataOf, TestClient } from './support/authClient';

/**
 * 首页功能区状态摘要（GET /game/hub）：只读汇总讨伐 / 镇妖塔 / 灵脉 / 拍卖行 / 灵股的状态。
 * 本文件一份独立内存 D1，10 条灵脉初始都是无主。
 */

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

const app = createApp({ logger: { info: () => {}, warn: () => {}, error: () => {} } });
const NOW = Date.UTC(2026, 5, 1, 4, 0);

let seq = 0;

async function makeSect(level: number): Promise<{ api: TestClient; userId: string; sectId: string; discipleIds: string[] }> {
  seq += 1;
  const api = new TestClient(app, env, { 'cf-connecting-ip': `10.51.0.${seq}` });
  expect((await api.post('/api/v1/auth/register', { account: `hub-${seq}`, password: 'password-123456' })).status).toBe(200);
  const created = await api.post('/api/v1/game/create-sect', { name: `总览${seq}号` });
  const state = (dataOf(created) as Record<string, any>).state;
  const sectId = state.sect.id as string;
  const row = await env.DB.prepare('SELECT user_id FROM sects WHERE id = ?').bind(sectId).first<{ user_id: string }>();
  await env.DB.prepare('UPDATE sects SET level = ?, last_settled_at = ? WHERE id = ?').bind(level, NOW, sectId).run();
  return { api, userId: row!.user_id, sectId, discipleIds: (state.disciples as { id: string }[]).map((item) => item.id) };
}

describe('首页功能区状态', () => {
  it('按宗门等级给出解锁状态；灵脉无主可进驻条数按档位门槛算', async () => {
    const low = await makeSect(2);
    const lowHub = await getHub(env.DB, low.userId, NOW);
    expect(lowHub.tower.unlocked).toBe(true);
    expect(lowHub.veins.unlocked).toBe(false);
    expect(lowHub.auction.unlocked).toBe(false);
    expect(lowHub.market.unlocked).toBe(false);

    const mid = await makeSect(3);
    const midHub = await getHub(env.DB, mid.userId, NOW);
    expect(midHub.veins.freeCount).toBe(6);
    // 没有演武场：只有两个不需要演武场的低阶秘境开放，各 3 次
    expect(midHub.explore).toEqual({ remaining: 6, total: 6 });
    expect(midHub.tower.failsLeft).toBe(5);
    const top = await makeSect(9);
    expect((await getHub(env.DB, top.userId, NOW)).veins.freeCount).toBe(10);
  });

  it('占了灵脉后显示名字与产出；接口可用', async () => {
    const sect = await makeSect(3);
    await occupyVein(env.DB, sect.userId, { veinId: 'vein-small-1', discipleIds: sect.discipleIds }, NOW);
    const hub = await getHub(env.DB, sect.userId, NOW + 1);
    expect(hub.veins.holding).toEqual({ name: '青竹泉眼', ratePerHour: 25_000 });
    expect(hub.market).toMatchObject({ holdings: 0, profit: 0 });

    const response = await sect.api.get('/api/v1/game/hub');
    expect(response.status).toBe(200);
    expect((dataOf(response) as Record<string, any>).hub.veins.holding.name).toBe('青竹泉眼');
  });
});
