import { applyD1Migrations, env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app';
import { attackWorldSite, getHub } from '../src/modules/game/service';

import { dataOf, TestClient } from './support/authClient';

/**
 * 首页功能区状态摘要（GET /game/hub）：只读汇总讨伐 / 镇妖塔 / 山河舆图 / 拍卖行 / 灵股的状态。
 * 本文件一份独立内存 D1；14 处灵地是全服共享的行，每个用例开头先清成无主。
 */

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

const app = createApp({ logger: { info: () => {}, warn: () => {}, error: () => {} } });
const NOW = Date.UTC(2026, 5, 1, 4, 0);
const HOUR = 3_600_000;

let seq = 0;

interface SectFixture {
  api: TestClient;
  userId: string;
  sectId: string;
  discipleIds: string[];
}

/** strong = 满属性渡劫期（打得过普通守方）；否则炼气一层属性 1（打不过）。 */
async function makeSect(level: number, strong = false): Promise<SectFixture> {
  seq += 1;
  const api = new TestClient(app, env, { 'cf-connecting-ip': `10.51.${Math.floor(seq / 250)}.${seq % 250}` });
  expect((await api.post('/api/v1/auth/register', { account: `hub-${seq}`, password: 'password-123456' })).status).toBe(200);
  const created = await api.post('/api/v1/game/create-sect', { name: `总览${seq}号` });
  const state = (dataOf(created) as Record<string, any>).state;
  const sectId = state.sect.id as string;
  const row = await env.DB.prepare('SELECT user_id FROM sects WHERE id = ?').bind(sectId).first<{ user_id: string }>();
  await env.DB.prepare('UPDATE sects SET level = ?, last_settled_at = ? WHERE id = ?').bind(level, NOW, sectId).run();
  const attr = strong ? 100 : 1;
  await env.DB.prepare(
    `UPDATE disciples SET realm_id = ?, stage = ?, attack = ?, defense = ?, speed = ?, luck = ?, physique = ?
     WHERE sect_id = ?`,
  )
    .bind(strong ? 'tribulation' : 'qiRefining', strong ? 3 : 1, attr, attr, attr, attr, attr, sectId)
    .run();
  const ids = await env.DB.prepare('SELECT id FROM disciples WHERE sect_id = ? ORDER BY created_at, id')
    .bind(sectId)
    .all<{ id: string }>();
  return { api, userId: row!.user_id, sectId, discipleIds: ids.results.map((item) => item.id) };
}

async function resetWorldSites(): Promise<void> {
  await env.DB.prepare(
    `UPDATE world_sites SET holder_sect_id = NULL, holder_name = NULL, garrison = NULL, held_since = NULL,
       protected_until = NULL, settled_at = NULL, rare_hours = 0`,
  ).run();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('首页功能区状态', () => {
  it('按宗门等级给出山河舆图的解锁、名额与空位；近 24 小时的失陷只算现在不在本宗手里的', async () => {
    await resetWorldSites();
    const low = await makeSect(2);
    expect(await getHub(env.DB, low.userId, NOW)).toMatchObject({
      world: { unlocked: false, cap: 0, held: 0, freeSlots: 0, lostCount: 0 },
    });
    expect((await getHub(env.DB, low.userId, NOW)).tower.unlocked).toBe(true);
    expect((await getHub(env.DB, low.userId, NOW)).auction.unlocked).toBe(false);
    expect((await getHub(env.DB, low.userId, NOW)).market.unlocked).toBe(false);

    const mid = await makeSect(3);
    expect(await getHub(env.DB, mid.userId, NOW)).toMatchObject({
      world: { unlocked: true, cap: 1, held: 0, freeSlots: 1, lostCount: 0 },
    });
    // 没有演武场：只有两个不需要演武场的低阶秘境开放，各 3 次
    expect((await getHub(env.DB, mid.userId, NOW)).explore).toEqual({ remaining: 6, total: 6 });
    expect((await getHub(env.DB, mid.userId, NOW)).tower.failsLeft).toBe(5);

    const top = await makeSect(9);
    expect((await getHub(env.DB, top.userId, NOW)).world).toMatchObject({ cap: 3, freeSlots: 3 });
  });

  it('占了灵地后显示名额与空位；被夺后在失陷数里（近 24 小时内），接口可用', async () => {
    await resetWorldSites();
    const holder = await makeSect(3);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    await attackWorldSite(env.DB, holder.userId, { siteId: 'east-lingdi', discipleIds: holder.discipleIds }, NOW);
    expect(await getHub(env.DB, holder.userId, NOW + 1)).toMatchObject({
      world: { held: 1, freeSlots: 0, lostCount: 0 },
    });

    // 4 小时禁制护持过后，满属性的一宗把这处灵地夺走。
    const raider = await makeSect(3, true);
    const won = await attackWorldSite(
      env.DB,
      raider.userId,
      { siteId: 'east-lingdi', discipleIds: raider.discipleIds },
      NOW + 5 * HOUR,
    );
    expect(won.result.battle?.won).toBe(true);
    expect(await getHub(env.DB, holder.userId, NOW + 5 * HOUR + 1)).toMatchObject({
      world: { held: 0, freeSlots: 1, lostCount: 1 },
    });
    expect(await getHub(env.DB, raider.userId, NOW + 5 * HOUR + 1)).toMatchObject({
      world: { held: 1, freeSlots: 0, lostCount: 0 },
    });

    // 接口用的是真实时间（24 小时窗口早已过去），这里只核对与时间无关的字段。
    const response = await holder.api.get('/api/v1/game/hub');
    expect(response.status).toBe(200);
    expect((dataOf(response) as Record<string, any>).hub.world).toMatchObject({ unlocked: true, cap: 1, held: 0 });
  });
});
