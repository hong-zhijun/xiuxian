import { applyD1Migrations, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { challengeTower, getSectState, getTower, sweepTower } from '../src/modules/game/service';
import { BAG_CAPACITY } from '../src/modules/game/equipment';
import { TOWER_DAILY_FAILS, towerClearReward, towerSweepReward } from '../src/modules/game/tower';

import { dataOf, errorOf, TestClient } from './support/authClient';

/**
 * 0039 镇妖塔：服务层 + D1 的集成测试。
 *
 * 存储说明：本文件一份独立内存 D1，没有逐用例回滚 —— 每个用例用独立账号 / 宗门。
 * 时间说明：service 入口显式收 `now`；用例把宗门的 last_settled_at 拨到 now（结算窗口为 0），
 * 资源断言只受被测逻辑影响。「明天」= now + 1 天。
 * 胜负说明：战斗用 Math.random，所以胜负靠「实力悬殊」锁定 —— 必胜用 5 名渡劫后期满属性弟子打第 1 层，
 * 必败用 5 名炼气一层、属性 1 的弟子打第 61 层。
 */

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

const quietLogger = { info: () => {}, warn: () => {}, error: () => {} } as const;
const app = createApp({ logger: quietLogger });
const PASSWORD = 'password-123456';
const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 5, 1, 4, 0); // UTC+8 当天 12:00

let seq = 0;

interface SectFixture {
  api: TestClient;
  userId: string;
  sectId: string;
  discipleIds: string[];
}

/** 建宗（2 级）+ 补到 5 名弟子；strong = 渡劫后期满属性，否则炼气一层属性 1。 */
async function makeSect(prefix: string, options: { strong: boolean; level?: number }): Promise<SectFixture> {
  seq += 1;
  const api = new TestClient(app, env, {
    'cf-connecting-ip': `10.9.${Math.floor(seq / 250)}.${seq % 250}`,
  });
  const registered = await api.post('/api/v1/auth/register', { account: `${prefix}-${seq}`, password: PASSWORD });
  expect(registered.status).toBe(200);
  const created = await api.post('/api/v1/game/create-sect', { name: `镇塔${seq}号` });
  expect(created.status).toBe(200);
  const sectId = (dataOf(created) as Record<string, any>).state.sect.id as string;
  const row = await env.DB.prepare('SELECT user_id FROM sects WHERE id = ?').bind(sectId).first<{ user_id: string }>();

  for (let index = 0; index < 2; index += 1) {
    await env.DB.prepare(
      `INSERT INTO disciples (id, sect_id, name, gender, aptitude, attack, defense, speed, talent,
          realm_id, stage, cultivation, cultivation_remainder, assignment, injured_until, body_tempering_count, created_at)
       VALUES (?, ?, ?, 'male', 50, 50, 50, 50, 'none', 'qiRefining', 1, 0, 0, 'idle', NULL, 0, ?)`,
    )
      .bind(crypto.randomUUID(), sectId, `塔${seq}徒${index}`, NOW)
      .run();
  }
  const attr = options.strong ? 100 : 1;
  await env.DB.prepare(
    `UPDATE disciples SET realm_id = ?, stage = ?, attack = ?, defense = ?, speed = ?, luck = ?, physique = ?
     WHERE sect_id = ?`,
  )
    .bind(options.strong ? 'tribulation' : 'qiRefining', options.strong ? 3 : 1, attr, attr, attr, attr, attr, sectId)
    .run();
  await env.DB.prepare('UPDATE sects SET level = ? WHERE id = ?').bind(options.level ?? 2, sectId).run();
  await freeze(sectId, NOW);

  const ids = await env.DB.prepare('SELECT id FROM disciples WHERE sect_id = ? ORDER BY created_at, id')
    .bind(sectId)
    .all<{ id: string }>();
  return { api, userId: row!.user_id, sectId, discipleIds: ids.results.map((item) => item.id) };
}

/** 结算拨到 at：之后用 at 调 service，结算窗口为 0。 */
async function freeze(sectId: string, at: number): Promise<void> {
  await env.DB.prepare('UPDATE sects SET last_settled_at = ? WHERE id = ?').bind(at, sectId).run();
}

async function balanceOf(sectId: string, resourceId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT balance FROM resource_balances WHERE sect_id = ? AND resource_id = ?')
    .bind(sectId, resourceId)
    .first<{ balance: number }>();
  return Number(row?.balance ?? 0);
}

async function setMaxFloor(sectId: string, floor: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO sect_towers (sect_id, max_floor, max_floor_at, fail_count, version, updated_at)
     VALUES (?, ?, ?, 0, 1, ?)
     ON CONFLICT (sect_id) DO UPDATE SET max_floor = excluded.max_floor, version = version + 1`,
  )
    .bind(sectId, floor, NOW, NOW)
    .run();
}

describe('镇妖塔', () => {
  it('宗门 1 级未解锁；面板照样能看', async () => {
    const sect = await makeSect('lock', { strong: true, level: 1 });
    const panel = await getTower(env.DB, sect.userId, NOW);
    expect(panel.tower.unlocked).toBe(false);
    expect(panel.tower.nextFloor).toBe(1);
    await expect(challengeTower(env.DB, sect.userId, { discipleIds: sect.discipleIds }, NOW)).rejects.toMatchObject({
      code: 'INVALID_STATUS',
    });
  });

  it('入参校验：必须 5 人、不能重复、不能有疗伤中的弟子', async () => {
    const sect = await makeSect('validate', { strong: true });
    const four = await sect.api.post('/api/v1/game/tower/challenge', { discipleIds: sect.discipleIds.slice(0, 4) });
    expect(four.status).toBe(400);
    expect(errorOf(four).code).toBe('VALIDATION_ERROR');

    const duplicated = [...sect.discipleIds.slice(0, 4), sect.discipleIds[0]!];
    await expect(challengeTower(env.DB, sect.userId, { discipleIds: duplicated }, NOW)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });

    await env.DB.prepare('UPDATE disciples SET injured_until = ? WHERE id = ?')
      .bind(NOW + 60_000, sect.discipleIds[0])
      .run();
    await expect(challengeTower(env.DB, sect.userId, { discipleIds: sect.discipleIds }, NOW)).rejects.toMatchObject({
      code: 'INVALID_STATUS',
    });
    // 什么都没写：还没有进度行
    const row = await env.DB.prepare('SELECT * FROM sect_towers WHERE sect_id = ?').bind(sect.sectId).first();
    expect(row).toBeNull();
  });

  it('胜利：最高层 +1、发通关奖励、上排行榜；可以接着打下一层', async () => {
    const sect = await makeSect('win', { strong: true });
    const stoneBefore = await balanceOf(sect.sectId, 'spiritStone');
    const herbBefore = await balanceOf(sect.sectId, 'herb');

    const first = await challengeTower(env.DB, sect.userId, { discipleIds: sect.discipleIds }, NOW);
    expect(first.result.won).toBe(true);
    expect(first.result.floor).toBe(1);
    expect(first.result.rounds.length).toBeGreaterThan(0);
    expect(first.result.reward).toEqual(towerClearReward(1));
    expect(first.tower.maxFloor).toBe(1);
    expect(first.tower.nextFloor).toBe(2);
    expect(first.tower.failsUsed).toBe(0);
    expect(first.tower.myRank).not.toBeNull();
    expect(first.tower.ranks.some((rank) => rank.isMe && rank.maxFloor === 1)).toBe(true);
    expect(await balanceOf(sect.sectId, 'spiritStone')).toBe(stoneBefore + towerClearReward(1).spiritStone!);
    expect(await balanceOf(sect.sectId, 'herb')).toBe(herbBefore + towerClearReward(1).herb!);

    const second = await challengeTower(env.DB, sect.userId, { discipleIds: sect.discipleIds }, NOW + 1000);
    expect(second.result.floor).toBe(2);
    expect(second.tower.maxFloor).toBe(2);
  });

  it('失败：只扣次数、不发奖、层数不变；用完 5 次当天不能再打，次日重置', async () => {
    const sect = await makeSect('lose', { strong: false });
    await setMaxFloor(sect.sectId, 60);
    const stoneBefore = await balanceOf(sect.sectId, 'spiritStone');

    for (let index = 0; index < TOWER_DAILY_FAILS; index += 1) {
      const result = await challengeTower(env.DB, sect.userId, { discipleIds: sect.discipleIds }, NOW + index);
      expect(result.result.won).toBe(false);
      expect(result.result.floor).toBe(61);
      expect(result.result.reward).toEqual({});
      expect(result.tower.failsUsed).toBe(index + 1);
      expect(result.tower.maxFloor).toBe(60);
    }
    expect(await balanceOf(sect.sectId, 'spiritStone')).toBe(stoneBefore);
    await expect(
      challengeTower(env.DB, sect.userId, { discipleIds: sect.discipleIds }, NOW + 10),
    ).rejects.toMatchObject({ code: 'DAILY_LIMIT' });

    const tomorrow = NOW + DAY_MS;
    await freeze(sect.sectId, tomorrow);
    const panel = await getTower(env.DB, sect.userId, tomorrow);
    expect(panel.tower.failsUsed).toBe(0);
    expect(panel.tower.failsLeft).toBe(TOWER_DAILY_FAILS);
    const again = await challengeTower(env.DB, sect.userId, { discipleIds: sect.discipleIds }, tomorrow);
    expect(again.tower.failsUsed).toBe(1);
  });

  it('扫荡：没过第 1 层不能扫；按最高层发奖、一天一次、次日可再扫；sync 角标跟着变', async () => {
    const sect = await makeSect('sweep', { strong: true });
    await expect(sweepTower(env.DB, sect.userId, NOW)).rejects.toMatchObject({ code: 'INVALID_STATUS' });

    await challengeTower(env.DB, sect.userId, { discipleIds: sect.discipleIds }, NOW);
    const synced = await getSectState(env.DB, sect.userId, NOW + 1);
    expect(synced?.tower.sweepable).toBe(true);

    const oreBefore = await balanceOf(sect.sectId, 'ore');
    const swept = await sweepTower(env.DB, sect.userId, NOW + 2);
    expect(swept.result.maxFloor).toBe(1);
    expect(swept.result.reward).toEqual(towerSweepReward(1));
    expect(swept.tower.sweptToday).toBe(true);
    expect(await balanceOf(sect.sectId, 'ore')).toBe(oreBefore + towerSweepReward(1).ore!);
    await expect(sweepTower(env.DB, sect.userId, NOW + 3)).rejects.toMatchObject({ code: 'DAILY_LIMIT' });
    const afterSweep = await getSectState(env.DB, sect.userId, NOW + 4);
    expect(afterSweep?.tower.sweepable).toBe(false);

    const tomorrow = NOW + DAY_MS;
    await freeze(sect.sectId, tomorrow);
    const next = await sweepTower(env.DB, sect.userId, tomorrow);
    expect(next.result.maxFloor).toBe(1);
  });

  it('每 30 层送装备：背包满时开打前就拒绝（不扣次数）；腾出位置后打赢入背包', async () => {
    const sect = await makeSect('gear', { strong: true });
    await setMaxFloor(sect.sectId, 29);
    for (let index = 0; index < BAG_CAPACITY; index += 1) {
      await env.DB.prepare(
        `INSERT INTO equipment (id, sect_id, disciple_id, slot, quality, name, main_attr, main_value,
            sub_attr, sub_value, source, created_at)
         VALUES (?, ?, NULL, 'weapon', 'common', '凡铁剑', 'attack', 8, 'luck', 2, 'forge', ?)`,
      )
        .bind(crypto.randomUUID(), sect.sectId, NOW)
        .run();
    }
    const panel = await getTower(env.DB, sect.userId, NOW);
    expect(panel.tower.nextFloor).toBe(30);
    expect(panel.tower.clearEquipment).toEqual({ quality: 'spirit', qualityName: '灵品' });
    expect(panel.tower.bagCount).toBe(BAG_CAPACITY);
    await expect(challengeTower(env.DB, sect.userId, { discipleIds: sect.discipleIds }, NOW)).rejects.toMatchObject({
      code: 'INVALID_STATUS',
    });
    expect((await getTower(env.DB, sect.userId, NOW)).tower.failsUsed).toBe(0);

    await env.DB.prepare('DELETE FROM equipment WHERE sect_id = ?').bind(sect.sectId).run();
    const won = await challengeTower(env.DB, sect.userId, { discipleIds: sect.discipleIds }, NOW + 1);
    expect(won.result.won).toBe(true);
    expect(won.result.equipment?.quality).toBe('spirit');
    const stored = await env.DB.prepare('SELECT quality, source FROM equipment WHERE sect_id = ?')
      .bind(sect.sectId)
      .all<{ quality: string; source: string }>();
    expect(stored.results).toEqual([{ quality: 'spirit', source: 'tower' }]);
    expect(won.tower.clearEquipment).toBeNull();
  });

  it('奖励不超过资源容量：仓库满了那一项到账 0', async () => {
    const sect = await makeSect('cap', { strong: true });
    await env.DB.prepare("UPDATE resource_balances SET balance = 999999999 WHERE sect_id = ? AND resource_id = 'spiritStone'")
      .bind(sect.sectId)
      .run();
    const result = await challengeTower(env.DB, sect.userId, { discipleIds: sect.discipleIds }, NOW);
    expect(result.result.won).toBe(true);
    expect(result.result.reward.spiritStone).toBe(0);
    expect(result.result.reward.herb).toBe(towerClearReward(1).herb);
    expect(await balanceOf(sect.sectId, 'spiritStone')).toBe(999999999);
  });
});
