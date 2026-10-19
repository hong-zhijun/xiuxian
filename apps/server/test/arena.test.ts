import { applyD1Migrations, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { getArena, getHub, processArenaTournament, setArenaLineup } from '../src/modules/game/service';

import { dataOf, TestClient } from './support/authClient';

/**
 * 0053 宗门大比：服务层 + D1 的集成测试（docs/宗门大比开发计划.md）。
 *
 * 时间全部用显式的 now（UTC+8）：周一 10:30 报名、12:30 结算；周日 12:30 结算日赛并发放赛季奖。
 * 对决里有 Math.random，所以只断言与胜负无关的结构：人数、场次、积分守恒、分层、奖励只发一次等。
 */

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

const app = createApp({ logger: { info: () => {}, warn: () => {}, error: () => {} } });
const PASSWORD = 'password-123456';
const MON_1030 = Date.UTC(2026, 5, 1, 2, 30);
const MON_1230 = Date.UTC(2026, 5, 1, 4, 30);
const MON_1240 = Date.UTC(2026, 5, 1, 4, 40);
const SUN_1230 = Date.UTC(2026, 5, 7, 4, 30);

let seq = 0;

interface Fixture {
  api: TestClient;
  userId: string;
  sectId: string;
  discipleIds: string[];
}

/** 直接写库加一名弟子（绕过招募）：属性 / 境界统一，便于断言战力关系。 */
async function addDisciple(sectId: string, attr: number, realm: string): Promise<void> {
  seq += 1;
  await env.DB.prepare(
    `INSERT INTO disciples (id, sect_id, name, gender, aptitude, attack, defense, speed, luck, physique, talent,
        realm_id, stage, cultivation, cultivation_remainder, assignment, injured_until, body_tempering_count, created_at)
     VALUES (?, ?, ?, 'male', 50, ?, ?, ?, ?, ?, 'none', ?, 3, 0, 0, 'idle', NULL, 0, ?)`,
  )
    .bind(crypto.randomUUID(), sectId, `弟子${String(seq)}`, attr, attr, attr, attr, attr, realm, Date.UTC(2026, 0, 1) + seq)
    .run();
}

/** 注册 + 建宗（得到 3 名弟子），再补到 7 人，属性与境界统一。 */
async function makeSect(level: number, attr: number, realm: string): Promise<Fixture> {
  seq += 1;
  const api = new TestClient(app, env, { 'cf-connecting-ip': `10.54.${Math.floor(seq / 250)}.${seq % 250}` });
  expect((await api.post('/api/v1/auth/register', { account: `arena-${String(seq)}`, password: PASSWORD })).status).toBe(200);
  const created = await api.post('/api/v1/game/create-sect', { name: `大比${String(seq)}号` });
  expect(created.status).toBe(200);
  const sectId = (dataOf(created) as Record<string, any>).state.sect.id as string;
  const row = await env.DB.prepare('SELECT user_id FROM sects WHERE id = ?').bind(sectId).first<{ user_id: string }>();
  await env.DB.prepare('UPDATE sects SET level = ? WHERE id = ?').bind(level, sectId).run();
  await env.DB.prepare(
    'UPDATE disciples SET realm_id = ?, stage = 3, attack = ?, defense = ?, speed = ?, luck = ?, physique = ? WHERE sect_id = ?',
  )
    .bind(realm, attr, attr, attr, attr, attr, sectId)
    .run();
  for (let i = 0; i < 4; i += 1) await addDisciple(sectId, attr, realm);
  const rows = await env.DB.prepare('SELECT id FROM disciples WHERE sect_id = ? ORDER BY created_at, id')
    .bind(sectId)
    .all<{ id: string }>();
  return { api, userId: row!.user_id, sectId, discipleIds: rows.results.map((item) => item.id) };
}

async function spiritOf(sectId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT balance FROM resource_balances WHERE sect_id = ? AND resource_id = 'spiritStone'",
  )
    .bind(sectId)
    .first<{ balance: number }>();
  return Number(row?.balance ?? 0);
}

async function count(sql: string, ...params: unknown[]): Promise<number> {
  const row = await env.DB.prepare(sql).bind(...params).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

describe('宗门大比（0053）', () => {
  it('报名 → 12 点结算（只发一次）→ 战报与榜单 → 周日赛季收官', async () => {
    const strong = await makeSect(3, 100, 'tribulation');
    const mid = await makeSect(2, 60, 'foundationEstablishment');
    const weak = await makeSect(2, 10, 'qiRefining');
    const low = await makeSect(1, 90, 'tribulation');

    // 宗门等级 1：不能参赛，面板仍可读。
    const locked = await getArena(env.DB, low.userId, MON_1030);
    expect(locked.unlocked).toBe(false);
    expect(locked.canRegister).toBe(false);
    expect(locked.allEntries.individual.map((entry) => entry.sectId)).not.toContain(low.sectId);

    // 报名窗口内：三个宗门都是「自动参赛」；宗门战暂不限制总战力（teamPowerCap 为 null）。
    const before = await getArena(env.DB, strong.userId, MON_1030);
    expect(before.unlocked).toBe(true);
    expect(before.canRegister).toBe(true);
    expect(before.settled).toBe(false);
    expect(before.settleInMs).toBeGreaterThan(0);
    expect(before.allEntries.individual).toHaveLength(3);
    expect(before.allEntries.individual.every((entry) => entry.auto)).toBe(true);
    expect(before.teamPowerCap).toBeNull();

    // 最强宗门把前 5 人报成团队赛：不再受战力上限限制，照常生效。
    await setArenaLineup(env.DB, strong.userId, 'team', strong.discipleIds.slice(0, 5), MON_1030);
    // 中等宗门：个人赛报两人、团队赛报一人，手动报名生效。
    const individualView = await setArenaLineup(env.DB, mid.userId, 'individual', mid.discipleIds.slice(0, 2), MON_1030);
    expect(individualView.myIndividualEntry?.auto).toBe(false);
    expect(individualView.myIndividualEntry?.disciples).toHaveLength(2);
    const teamView = await setArenaLineup(env.DB, mid.userId, 'team', mid.discipleIds.slice(0, 1), MON_1030);
    expect(teamView.myTeamEntry?.disciples).toHaveLength(1);

    // 重伤卧床的弟子不能报名。
    await env.DB.prepare('UPDATE disciples SET severe_injured_until = ? WHERE id = ?')
      .bind(MON_1030 + 86_400_000, weak.discipleIds[0])
      .run();
    await expect(setArenaLineup(env.DB, weak.userId, 'individual', [weak.discipleIds[0]!], MON_1030)).rejects.toMatchObject({
      code: 'INVALID_STATUS',
    });
    // 12 点之后报名窗口关闭。
    await expect(setArenaLineup(env.DB, mid.userId, 'individual', mid.discipleIds.slice(0, 1), MON_1230)).rejects.toMatchObject({
      code: 'INVALID_STATUS',
    });

    // 结算：个人赛 12 人（5 + 2 + 5，低等级宗门不参赛），团队赛 3 宗。
    // 瑞士轮 5 轮：个人赛每轮最多 6 场（12/2），但受跨宗 + 不重复配对限制实际更少；
    // 团队赛 3 宗只有 C(3,2)=3 种配对，所以最多 3 场。
    const spiritBefore = await spiritOf(strong.sectId);
    await processArenaTournament(env.DB, MON_1230);
    expect(await count("SELECT COUNT(*) AS n FROM arena_individual_scores WHERE date_key = '2026-06-01'")).toBe(12);
    expect(await count("SELECT COUNT(*) AS n FROM arena_team_scores WHERE date_key = '2026-06-01'")).toBe(3);
    const indMatchCount = await count("SELECT COUNT(*) AS n FROM arena_individual_matches WHERE date_key = '2026-06-01'");
    expect(indMatchCount).toBeGreaterThan(0);
    expect(indMatchCount).toBeLessThanOrEqual(30);
    expect(await count("SELECT COUNT(*) AS n FROM arena_team_matches WHERE date_key = '2026-06-01'")).toBe(3);
    // 每名参赛弟子一份日赛奖励，每个参赛宗门一份宗门奖励。
    expect(await count("SELECT COUNT(*) AS n FROM arena_rewards WHERE date_key = '2026-06-01'")).toBe(12 + 3);
    expect(await count("SELECT COUNT(*) AS n FROM event_log WHERE event_id = 'arenaReward' AND sect_id = ?", strong.sectId)).toBe(1);
    expect(await spiritOf(strong.sectId)).toBeGreaterThan(spiritBefore);

    // 重复结算：什么都不变（守卫 + 当日积分行）。
    const spiritAfter = await spiritOf(strong.sectId);
    await processArenaTournament(env.DB, MON_1240);
    expect(await spiritOf(strong.sectId)).toBe(spiritAfter);
    expect(await count("SELECT COUNT(*) AS n FROM arena_rewards WHERE date_key = '2026-06-01'")).toBe(15);
    expect(await count("SELECT COUNT(*) AS n FROM arena_individual_matches WHERE date_key = '2026-06-01'")).toBe(indMatchCount);

    // 结算后的面板：战报按轮、榜单排序、未报名的宗门按实际出场名单显示（auto）。
    const after = await getArena(env.DB, strong.userId, MON_1240);
    expect(after.settled).toBe(true);
    expect(after.canRegister).toBe(false);
    expect(after.settleInMs).toBeNull();
    expect(after.dateKey).toBe('2026-06-01');
    expect(after.individualMatches).toHaveLength(indMatchCount);
    expect(Math.max(...after.individualMatches.map((match) => match.round))).toBeGreaterThan(1);
    expect(after.teamMatches).toHaveLength(3);
    expect(after.teamMatches[0]!.duels.length).toBeGreaterThan(0);
    expect(after.teamMatches[0]!.duels[0]!.rounds.length).toBeGreaterThan(0);
    expect(after.dailyIndividualRanking).toHaveLength(12);
    expect(after.dailyIndividualRanking[0]!.points).toBeGreaterThanOrEqual(after.dailyIndividualRanking[1]!.points);
    expect(after.dailyTeamRanking).toHaveLength(3);
    expect(after.myIndividualEntry?.auto).toBe(true);

    const hub = await getHub(env.DB, strong.userId, MON_1240);
    expect(hub.arena).toMatchObject({ unlocked: true, settled: true });
    expect(hub.arena.myIndividualRank).not.toBeNull();
    expect(hub.arena.myTeamRank).not.toBeNull();
    expect((await getHub(env.DB, low.userId, MON_1240)).arena).toMatchObject({ unlocked: false, settled: false });

    // 周日：先结算当天的日赛（没报名的都按自动参赛），再发一次赛季奖励。
    await processArenaTournament(env.DB, SUN_1230);
    expect(await count("SELECT COUNT(*) AS n FROM arena_seasons WHERE id = '2026-W23' AND settled = 1")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM arena_rewards WHERE kind = 'season_team'")).toBe(3);
    expect(await count("SELECT COUNT(*) AS n FROM arena_rewards WHERE kind = 'season_individual'")).toBe(3);
    const seasonSpirit = await spiritOf(strong.sectId);
    await processArenaTournament(env.DB, SUN_1230 + 600_000);
    expect(await spiritOf(strong.sectId)).toBe(seasonSpirit);
    expect(await count("SELECT COUNT(*) AS n FROM arena_rewards WHERE kind = 'season_team'")).toBe(3);

    // 下周一 10 点（还没到结算时点）的定时任务会检查上一纪的赛季奖励：已发过，不会重发。
    await processArenaTournament(env.DB, Date.UTC(2026, 5, 8, 2, 0));
    expect(await spiritOf(strong.sectId)).toBe(seasonSpirit);
    expect(await count("SELECT COUNT(*) AS n FROM arena_rewards WHERE kind = 'season_team'")).toBe(3);

    const season = await getArena(env.DB, mid.userId, SUN_1230 + 600_000);
    expect(season.seasonId).toBe('2026-W23');
    expect(season.seasonTeamRanking).toHaveLength(3);
    expect(season.seasonIndividualRanking.length).toBeGreaterThan(0);
    expect(season.seasonIndividualRanking[0]!.points).toBeGreaterThanOrEqual(season.seasonIndividualRanking[1]!.points);
  });
});
