import { applyD1Migrations, env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app';
import { dateKeyUtc8, effectiveCapacity, findSectLevel, findStage } from '../src/modules/game/constants';
import { worldGarrisonFreeGuardStatement } from '../src/modules/game/repository';
import {
  assignDisciple,
  attackWorldBoss,
  attackWorldSite,
  challengeSect,
  gameConfig,
  getPublicSect,
  getWorld,
  processWorldSites,
  startRealmExplore,
  withdrawWorldSite,
} from '../src/modules/game/service';

import { dataOf, envWith, errorOf, TestClient, type ApiResult } from './support/authClient';

/**
 * 0051 山河舆图：服务层 + D1 的集成测试（docs/山河舆图开发计划.md 2.8）。
 *
 * 存储说明：本文件一份独立内存 D1；14 处灵地是全服共享的行，每个用例开头先把它们清成无主。
 * 宗门各用独立账号。服务层命令都显式收 now（NOW 起的若干小时）；HTTP 路由用的是真实时间，
 * 只用来断言入参校验、归属与坐镇拦截这类与时间无关的结果。
 * 结算窗口：宗门的 last_settled_at 拨到 FAR（未来），宗门自己的产出为 0，余额断言只受灵地影响。
 *
 * 随机说明：对决 / 受伤用 Math.random，用例用 vi.spyOn 钉住：
 * 0.5 = 浮动系数 1.0、不受伤（进攻方 p 对妖兽 0.9p，必胜）；0 = 进攻方必败且全员受伤（有主灵地）。
 */

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

const app = createApp({ logger: { info: () => {}, warn: () => {}, error: () => {} } });
const PASSWORD = 'password-123456';
/** UTC+8 12:00：讨伐开放时段内。 */
const NOW = Date.UTC(2026, 5, 1, 4, 0);
const FAR = NOW + 30 * 86_400_000;
const HOUR = 3_600_000;
const MIN = 60_000;

let seq = 0;

interface SectFixture {
  api: TestClient;
  userId: string;
  sectId: string;
  sectName: string;
  /** 注册时的 3 名弟子（之后另加的不在这里）。 */
  discipleIds: string[];
}

/** strong = 满属性渡劫期（打得过别人）；否则炼气一层属性 1。 */
async function makeSect(level: number, strong = true): Promise<SectFixture> {
  seq += 1;
  const api = new TestClient(app, env, { 'cf-connecting-ip': `10.53.${Math.floor(seq / 250)}.${seq % 250}` });
  expect((await api.post('/api/v1/auth/register', { account: `world-${seq}`, password: PASSWORD })).status).toBe(200);
  const created = await api.post('/api/v1/game/create-sect', { name: `舆图${seq}号` });
  expect(created.status).toBe(200);
  const sectId = (dataOf(created) as Record<string, any>).state.sect.id as string;
  const row = await env.DB.prepare('SELECT user_id, name FROM sects WHERE id = ?')
    .bind(sectId)
    .first<{ user_id: string; name: string }>();
  await env.DB.prepare('UPDATE sects SET level = ?, last_settled_at = ? WHERE id = ?').bind(level, FAR, sectId).run();
  await setStrength(sectId, strong);
  return { api, userId: row!.user_id, sectId, sectName: row!.name, discipleIds: await discipleIdsOf(sectId) };
}

async function discipleIdsOf(sectId: string): Promise<string[]> {
  const rows = await env.DB.prepare('SELECT id FROM disciples WHERE sect_id = ? ORDER BY created_at, id')
    .bind(sectId)
    .all<{ id: string }>();
  return rows.results.map((item) => item.id);
}

async function setStrength(sectId: string, strong: boolean): Promise<void> {
  const attr = strong ? 100 : 1;
  await env.DB.prepare(
    `UPDATE disciples SET realm_id = ?, stage = ?, attack = ?, defense = ?, speed = ?, luck = ?, physique = ?
     WHERE sect_id = ?`,
  )
    .bind(strong ? 'tribulation' : 'qiRefining', strong ? 3 : 1, attr, attr, attr, attr, attr, sectId)
    .run();
}

/** 把守军打弱（属性 1、炼气一层）：之后的斗法里它几乎必败。 */
async function weaken(sectId: string): Promise<void> {
  await setStrength(sectId, false);
}

/** 直接写库加一名弟子（绕过招募）。 */
async function addDisciple(sectId: string, name: string, talent = 'none'): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO disciples (id, sect_id, name, gender, aptitude, attack, defense, speed, talent,
        realm_id, stage, cultivation, cultivation_remainder, assignment, injured_until, body_tempering_count, created_at)
     VALUES (?, ?, ?, 'male', 50, 50, 50, 50, ?, 'qiRefining', 1, 0, 0, 'idle', NULL, 0, ?)`,
  )
    .bind(id, sectId, name, talent, NOW)
    .run();
  return id;
}

async function addEquipment(sectId: string, discipleId: string | null, slot: 'weapon' | 'armor'): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO equipment (id, sect_id, disciple_id, slot, quality, name, main_attr, main_value,
        sub_attr, sub_value, source, created_at)
     VALUES (?, ?, ?, ?, 'common', '凡品·测试器', ?, 4, 'luck', 1, 'forge', ?)`,
  )
    .bind(id, sectId, discipleId, slot, slot === 'armor' ? 'defense' : 'attack', NOW)
    .run();
  return id;
}

/** 妖王一关（讨伐用）：day_key 取 NOW 那天。 */
async function insertBoss(now: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO world_bosses
       (id, day_key, stage, boss_index, affix, round_damage, max_hp, hp, status,
        killer_sect_id, half_announced, rewarded_at, created_at, ended_at)
     VALUES (?, ?, 1, 0, 'ironclad', 30000, 1000000, 1000000, 'active', NULL, 0, NULL, ?, NULL)`,
  )
    .bind(crypto.randomUUID(), dateKeyUtc8(now), now)
    .run();
}

async function resetWorldSites(): Promise<void> {
  await env.DB.prepare(
    `UPDATE world_sites SET holder_sect_id = NULL, holder_name = NULL, garrison = NULL, held_since = NULL,
       protected_until = NULL, settled_at = NULL, rare_hours = 0, withdrawn_sect_id = NULL, withdrawn_until = NULL`,
  ).run();
}

async function siteRow(siteId: string): Promise<Record<string, any>> {
  return (await env.DB.prepare('SELECT * FROM world_sites WHERE id = ?').bind(siteId).first<Record<string, any>>())!;
}

async function balanceOf(sectId: string, resourceId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT balance FROM resource_balances WHERE sect_id = ? AND resource_id = ?')
    .bind(sectId, resourceId)
    .first<{ balance: number }>();
  return Number(row?.balance ?? 0);
}

async function assignmentOf(discipleId: string): Promise<string> {
  const row = await env.DB.prepare('SELECT assignment FROM disciples WHERE id = ?')
    .bind(discipleId)
    .first<{ assignment: string }>();
  return row?.assignment ?? '';
}

async function nameOf(discipleId: string): Promise<string> {
  const row = await env.DB.prepare('SELECT name FROM disciples WHERE id = ?')
    .bind(discipleId)
    .first<{ name: string }>();
  return row?.name ?? '';
}

async function eventCount(sectId: string, eventId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS cnt FROM event_log WHERE sect_id = ? AND event_id = ?')
    .bind(sectId, eventId)
    .first<{ cnt: number }>();
  return Number(row?.cnt ?? 0);
}

/** 某宗门的山河纪事（按 kind 过滤；不传 kind 则全部）。 */
async function logsOf(sectId: string, kind?: 'battle' | 'withdraw' | 'settle'): Promise<Record<string, any>[]> {
  const rows = await env.DB.prepare(
    `SELECT * FROM world_site_logs WHERE sect_id = ? ${kind === undefined ? '' : 'AND kind = ?'} ORDER BY created_at, id`,
  )
    .bind(...(kind === undefined ? [sectId] : [sectId, kind]))
    .all<Record<string, any>>();
  return rows.results;
}

/** 钉住随机数：0.5 = 浮动取 1.0、不受伤；0 = 进攻方必败且全员受伤。 */
function pinRandom(value: number): void {
  vi.spyOn(Math, 'random').mockReturnValue(value);
}

/** 直接调用服务层时用的 Env（服务层的全局类型，与 HTTP 测试客户端的类型不同，这里只做一次收窄）。 */
function serviceEnv(overrides: Record<string, string>): Env {
  return envWith(env, overrides) as unknown as Env;
}

type Refusal = { code: string; message: string };

/** 服务层调用应当被拦下：返回业务错误码与文案。 */
async function refusedOf(call: () => Promise<unknown>): Promise<Refusal> {
  try {
    await call();
  } catch (error) {
    const found = error as { code?: unknown; message?: unknown };
    return { code: String(found.code), message: String(found.message) };
  }
  throw new Error('应当被拦下，实际成功了');
}

/** HTTP 调用应当失败：返回业务错误码与文案。 */
function httpRefusal(result: ApiResult): Refusal {
  expect(result.status).toBeGreaterThanOrEqual(400);
  const error = errorOf(result);
  return { code: error.code, message: error.message };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('山河舆图 · 开辟与名额', () => {
  it('3 级才开放；名额随等级分档（3～5 级 1 处），满额后不能再开辟', async () => {
    await resetWorldSites();
    const low = await makeSect(2);
    expect(
      await refusedOf(() => attackWorldSite(env.DB, low.userId, { siteId: 'east-lingdi', discipleIds: low.discipleIds }, NOW)),
    ).toMatchObject({ code: 'INVALID_STATUS' });

    const sect = await makeSect(3);
    pinRandom(0.5);
    const first = await attackWorldSite(env.DB, sect.userId, { siteId: 'east-lingdi', discipleIds: sect.discipleIds }, NOW);
    expect(first.result.battle).toMatchObject({ siteId: 'east-lingdi', won: true, defenderName: null });
    expect(first.result.message).toContain('开辟「青木域 · 百草谷」');
    expect(first.world).toMatchObject({ cap: 1, held: 1, battlesUsed: 1, battlesLeft: 9 });

    expect(
      await refusedOf(() => attackWorldSite(env.DB, sect.userId, { siteId: 'west-lingdi', discipleIds: sect.discipleIds }, NOW)),
    ).toMatchObject({ code: 'CAPACITY_FULL' });
  });

  it('开辟妖兽：3 人坐镇、岗位变修炼、禁制护持 4 小时；结算从下一个整点开始', async () => {
    await resetWorldSites();
    const sect = await makeSect(3);
    const [a, b, c] = sect.discipleIds as [string, string, string];
    await env.DB.prepare("UPDATE disciples SET assignment = 'herbGathering' WHERE sect_id = ?").bind(sect.sectId).run();
    const now = NOW + 20 * MIN;
    const versionBefore = Number((await siteRow('east-lingdi')).version);
    pinRandom(0.5);
    const result = await attackWorldSite(env.DB, sect.userId, { siteId: 'east-lingdi', discipleIds: [a, b, c] }, now);

    const row = await siteRow('east-lingdi');
    expect(row).toMatchObject({
      holder_sect_id: sect.sectId,
      holder_name: sect.sectName,
      held_since: now,
      protected_until: now + 4 * HOUR,
      settled_at: NOW + HOUR,
      rare_hours: 0,
    });
    expect(JSON.parse(row.garrison as string)).toEqual([a, b, c]);
    // 每次写入 version +1（守卫靠它挡并发）；这个文件里的灵地是共享的，所以比较的是前后差。
    expect(Number(row.version)).toBe(versionBefore + 1);
    expect(await assignmentOf(a)).toBe('cultivating');
    expect(await assignmentOf(b)).toBe('cultivating');
    expect(await assignmentOf(c)).toBe('cultivating');
    // 回执里的状态直接带上坐镇的灵地名
    const garrisoned = result.state.disciples.filter((item) => item.garrisonSiteName === '青木域 · 百草谷');
    expect(garrisoned.map((item) => item.id).sort()).toEqual([a, b, c].sort());
    expect(result.world.sites.find((site) => site.id === 'east-lingdi')).toMatchObject({
      holder: { sectId: sect.sectId, isMe: true },
      action: 'mine',
      garrisonPower: expect.any(Number),
    });
  });
});

describe('山河舆图 · 坐镇锁定（计划 2.4 第 3、4 条）', () => {
  it('坐镇弟子被拦下：讨伐 / 镇妖塔 / 转岗 / 批量转岗 / 任执事 / 历练 / 论道 / 驱逐 / 穿装备 / 卸装备 / 取下装备 / 秘境探索 / 交互式秘境 / 守擂阵容 / 比斗 / 山河斗法', async () => {
    await resetWorldSites();
    const owner = await makeSect(6);
    const rival = await makeSect(3);
    const [m0, m1, m2] = owner.discipleIds as [string, string, string];
    const x0 = await addDisciple(owner.sectId, '备用甲');
    const x1 = await addDisciple(owner.sectId, '备用乙');
    const x2 = await addDisciple(owner.sectId, '备用丙');
    const bagItem = await addEquipment(owner.sectId, null, 'weapon');
    const wornItem = await addEquipment(owner.sectId, m0, 'armor');
    await insertBoss(NOW);

    pinRandom(0.5);
    await attackWorldSite(env.DB, owner.userId, { siteId: 'east-lingdi', discipleIds: [m0, m1, m2] }, NOW);
    // 前置：m0 有天赋（任执事）、已筑基（能外出历练）；它身上穿着一件装备。
    await env.DB.prepare(
      "UPDATE disciples SET talent = 'forging', realm_id = 'foundationEstablishment', stage = 1 WHERE id = ?",
    )
      .bind(m0)
      .run();

    const cases: { name: string; probe: () => Promise<Refusal> }[] = [
      {
        name: '讨伐',
        probe: () => refusedOf(() => attackWorldBoss(env.DB, owner.userId, { discipleIds: [m0] }, NOW)),
      },
      {
        name: '镇妖塔',
        probe: async () =>
          httpRefusal(await owner.api.post('/api/v1/game/tower/challenge', { discipleIds: [m0, m1, m2, x0, x1] })),
      },
      {
        name: '转岗',
        probe: async () =>
          httpRefusal(await owner.api.post('/api/v1/game/assign', { discipleId: m0, assignment: 'herbGathering' })),
      },
      {
        name: '批量转岗',
        probe: async () =>
          httpRefusal(await owner.api.post('/api/v1/game/assign-batch', { discipleIds: [m0], assignment: 'herbGathering' })),
      },
      {
        name: '任执事',
        probe: async () => httpRefusal(await owner.api.post('/api/v1/game/steward/appoint', { office: 'forging', discipleId: m0 })),
      },
      {
        name: '历练',
        probe: async () =>
          httpRefusal(
            await owner.api.post('/api/v1/game/start-journey', { discipleId: m0, direction: 'gathering', durationSeconds: 7200 }),
          ),
      },
      {
        name: '论道',
        probe: async () =>
          httpRefusal(
            await owner.api.post('/api/v1/game/dao-debate', {
              discipleId: m0,
              betMode: 'preset_spirit_stone',
              multiplier: 1,
              rewardType: 'resource',
            }),
          ),
      },
      {
        name: '驱逐',
        probe: async () => httpRefusal(await owner.api.post('/api/v1/game/expel-disciple', { discipleId: m0 })),
      },
      {
        name: '穿装备',
        probe: async () => httpRefusal(await owner.api.post('/api/v1/game/equip', { equipmentId: bagItem, discipleId: m0 })),
      },
      {
        name: '卸下装备',
        probe: async () => httpRefusal(await owner.api.post('/api/v1/game/unequip', { equipmentId: wornItem })),
      },
      {
        name: '取下装备（原穿戴者坐镇）',
        probe: async () => httpRefusal(await owner.api.post('/api/v1/game/equip', { equipmentId: wornItem, discipleId: x1 })),
      },
      {
        name: '秘境探索',
        probe: async () =>
          httpRefusal(await owner.api.post('/api/v1/game/explore', { realmId: 'mistyForest', discipleIds: [m0] })),
      },
      {
        name: '交互式秘境探索',
        probe: () =>
          refusedOf(() =>
            startRealmExplore(
              env.DB,
              serviceEnv({ REALM_EXPLORE_ENABLED: 'true', OPENROUTER_API_KEY: '' }),
              owner.userId,
              'mistyForest',
              [m0],
              NOW,
            ),
          ),
      },
      {
        name: '守擂阵容',
        probe: async () => httpRefusal(await owner.api.post('/api/v1/game/set-defense-lineup', { discipleIds: [m0, x0, x1] })),
      },
      {
        name: '比斗（我方出战）',
        probe: async () =>
          httpRefusal(
            await owner.api.post('/api/v1/game/challenge', { targetSectId: rival.sectId, discipleIds: [m0, x0, x1] }),
          ),
      },
      {
        name: '山河斗法',
        probe: () =>
          refusedOf(() =>
            attackWorldSite(env.DB, owner.userId, { siteId: 'west-lingdi', discipleIds: [m0, x0, x1] }, NOW),
          ),
      },
    ];
    for (const item of cases) {
      const refusal = await item.probe();
      expect(refusal.code, item.name).toBe('INVALID_STATUS');
      expect(refusal.message, item.name).toContain('坐镇');
    }

    // 历练预览也要给出原因（前端据此禁用按钮）
    const preview = await owner.api.get(`/api/v1/game/journey-preview?discipleId=${m0}`);
    expect(preview.status).toBe(200);
    expect(dataOf(preview)).toMatchObject({ canStart: false });
    expect(String((dataOf(preview) as Record<string, any>).blockedReason)).toContain('坐镇');

    // 没有坐镇的弟子不受影响：x2 可以正常转岗、穿装备。
    const free = await owner.api.post('/api/v1/game/assign', { discipleId: x2, assignment: 'herbGathering' });
    expect(free.status).toBe(200);
    const equipped = await owner.api.post('/api/v1/game/equip', { equipmentId: bagItem, discipleId: x2 });
    expect(equipped.status).toBe(200);
  });

  it('并发守卫：出战的人在提交时已在别处坐镇，守卫判为失效（只有都不在坐镇名单里才放行）', async () => {
    await resetWorldSites();
    const sect = await makeSect(3);
    const [a, b, c] = sect.discipleIds as [string, string, string];
    const free = await addDisciple(sect.sectId, '空闲甲');
    pinRandom(0.5);
    await attackWorldSite(env.DB, sect.userId, { siteId: 'east-lingdi', discipleIds: [a, b, c] }, NOW);

    // mutation_guards.valid 有 CHECK (valid = 1)：守卫失效时 INSERT 会报这条 CHECK（runGuardedBatch 同样按它判冲突）。
    const passes = async (ids: string[]): Promise<boolean> => {
      const guardId = crypto.randomUUID();
      const statement = worldGarrisonFreeGuardStatement(guardId, ids);
      try {
        await env.DB.prepare(statement.sql)
          .bind(...(statement.params ?? []))
          .run();
      } catch (error) {
        expect(String(error)).toContain('CHECK constraint failed: valid = 1');
        return false;
      }
      await env.DB.prepare('DELETE FROM mutation_guards WHERE command_id = ?').bind(guardId).run();
      return true;
    };
    expect(await passes([free])).toBe(true);
    expect(await passes([free, a])).toBe(false);
    expect(await passes([b])).toBe(false);
  });

  it('破境、服药、改备注不受坐镇影响', async () => {
    await resetWorldSites();
    const sect = await makeSect(3);
    const [a, b, c] = sect.discipleIds as [string, string, string];
    pinRandom(0.5);
    await attackWorldSite(env.DB, sect.userId, { siteId: 'east-lingdi', discipleIds: [a, b, c] }, NOW);

    // a：筑基前的炼气一层，修为已满（可以破境）
    const stage = findStage('qiRefining', 1);
    await env.DB.prepare("UPDATE disciples SET realm_id = 'qiRefining', stage = 1, cultivation = ? WHERE id = ?")
      .bind(stage.requiredCultivation ?? 0, a)
      .run();
    const broke = await sect.api.post('/api/v1/game/breakthrough', { discipleId: a });
    expect(broke.status).toBe(200);

    // 炼丹（服药）解锁：宗门 2 级 + 灵药园 2 级（同 severe-injury 的夹具）。
    await env.DB.prepare("UPDATE buildings SET level = 2 WHERE sect_id = ? AND def_id = 'herbGarden'")
      .bind(sect.sectId)
      .run();
    await env.DB.prepare(
      "INSERT INTO pill_inventories (id, sect_id, pill_id, quantity, updated_at) VALUES (?, ?, 'cultivationPill', 2, ?)",
    )
      .bind(crypto.randomUUID(), sect.sectId, NOW)
      .run();
    // b 是满属性的渡劫期（已是最高阶段，服丹会被拦）：降到炼气一层、修为 0 再服药。
    await env.DB.prepare("UPDATE disciples SET realm_id = 'qiRefining', stage = 1, cultivation = 0 WHERE id = ?")
      .bind(b)
      .run();
    const pill = await sect.api.post('/api/v1/game/use-pill', { pillId: 'cultivationPill', discipleId: b, count: 1 });
    expect(pill.status).toBe(200);

    const noted = await sect.api.post('/api/v1/game/set-disciple-note', { discipleId: c, note: '闭关中' });
    expect(noted.status).toBe(200);
    const state = (dataOf(noted) as Record<string, any>).state;
    expect(state.disciples.find((item: { id: string }) => item.id === c)).toMatchObject({
      note: '闭关中',
      garrisonSiteName: '青木域 · 百草谷',
    });
  });
});

describe('山河舆图 · 斗法（计划 1.4）', () => {
  it('斗法夺地：胜者接手并坐镇、守军解锁、原主结算到易主时刻、天机录「灵地失陷」', async () => {
    await resetWorldSites();
    const holder = await makeSect(3);
    const raider = await makeSect(3);
    const [h0, h1, h2] = holder.discipleIds as [string, string, string];
    pinRandom(0.5);
    await attackWorldSite(env.DB, holder.userId, { siteId: 'east-lingdi', discipleIds: [h0, h1, h2] }, NOW);
    await weaken(holder.sectId);

    const at = NOW + 5 * HOUR;
    const won = await attackWorldSite(env.DB, raider.userId, { siteId: 'east-lingdi', discipleIds: raider.discipleIds }, at);
    expect(won.result.battle).toMatchObject({ won: true, defenderName: holder.sectName });
    expect(won.result.battle?.rounds.every((round) => round.winner === 'attacker')).toBe(true);
    expect(won.result.message).toContain('夺下「青木域 · 百草谷」');

    expect(await siteRow('east-lingdi')).toMatchObject({
      holder_sect_id: raider.sectId,
      held_since: at,
      protected_until: at + 4 * HOUR,
      settled_at: at,
      rare_hours: 0,
    });
    expect(JSON.parse((await siteRow('east-lingdi')).garrison as string)).toEqual(raider.discipleIds);
    expect(won.state.disciples.find((item) => item.id === raider.discipleIds[0])).toMatchObject({
      garrisonSiteName: '青木域 · 百草谷',
      assignment: 'cultivating',
    });

    // 原主结算：NOW → 易主时刻 共 5 个整点，药材 75000 / 时。
    expect(await balanceOf(holder.sectId, 'herb')).toBe(40_000 + 5 * 75_000);
    const settle = await logsOf(holder.sectId, 'settle');
    expect(settle).toHaveLength(1);
    expect(JSON.parse(settle[0]!.effects as string)).toEqual({ herb: String(5 * 75_000) });
    expect(await eventCount(holder.sectId, 'siteLost')).toBe(1);

    // 原守军解锁：可以转岗了
    const freed = await assignDisciple(env.DB, holder.userId, h0, 'herbGathering', at + MIN);
    expect(freed.disciples.find((item) => item.id === h0)?.garrisonSiteName).toBeNull();
  });

  it('斗法失败：守住；攻方每人 30% 轻伤（疗伤 30 分钟）；守方天机录「击退来犯」', async () => {
    await resetWorldSites();
    const holder = await makeSect(3);
    const weak = await makeSect(3, false);
    pinRandom(0.5);
    await attackWorldSite(env.DB, holder.userId, { siteId: 'east-lingdi', discipleIds: holder.discipleIds }, NOW);

    const at = NOW + 5 * HOUR;
    // 0 = 进攻方浮动最低、且每人都判定受伤（0 < 30%）
    pinRandom(0);
    const lost = await attackWorldSite(
      env.DB,
      weak.userId,
      { siteId: 'east-lingdi', discipleIds: weak.discipleIds },
      at,
    );
    expect(lost.result.battle).toMatchObject({ won: false, defenderName: holder.sectName });
    expect(lost.result.battle?.injured).toHaveLength(3);
    expect(lost.result.message).toContain('失败');

    expect(await siteRow('east-lingdi')).toMatchObject({
      holder_sect_id: holder.sectId,
      protected_until: NOW + 4 * HOUR,
    });
    const injured = await env.DB.prepare('SELECT COUNT(*) AS cnt FROM disciples WHERE sect_id = ? AND injured_until = ?')
      .bind(weak.sectId, at + 30 * MIN)
      .first<{ cnt: number }>();
    expect(Number(injured?.cnt)).toBe(3);
    expect(await eventCount(holder.sectId, 'siteHeld')).toBe(1);
    expect(await eventCount(holder.sectId, 'siteLost')).toBe(0);
  });

  it('斗法的限制：禁制护持、等级差（低 3 级及以上）、不能抢自己的、每日 10 次', async () => {
    await resetWorldSites();
    const holder = await makeSect(3);
    pinRandom(0.5);
    await attackWorldSite(env.DB, holder.userId, { siteId: 'east-lingdi', discipleIds: holder.discipleIds }, NOW);

    const early = await makeSect(3);
    const protectedRefusal = await refusedOf(() =>
      attackWorldSite(env.DB, early.userId, { siteId: 'east-lingdi', discipleIds: early.discipleIds }, NOW + HOUR),
    );
    expect(protectedRefusal).toMatchObject({ code: 'INVALID_STATUS' });
    expect(protectedRefusal.message).toContain('禁制护持');

    const bully = await makeSect(6);
    const gapRefusal = await refusedOf(() =>
      attackWorldSite(env.DB, bully.userId, { siteId: 'east-lingdi', discipleIds: bully.discipleIds }, NOW + 5 * HOUR),
    );
    expect(gapRefusal).toMatchObject({ code: 'INVALID_STATUS' });
    expect(gapRefusal.message).toContain('比你低 3 级以上');

    expect(
      await refusedOf(() =>
        attackWorldSite(env.DB, holder.userId, { siteId: 'east-lingdi', discipleIds: [] }, NOW + 5 * HOUR),
      ),
    ).toMatchObject({ code: 'INVALID_STATUS', message: '这处灵地已经是你的了' });

    // 同一天第 10 次斗法后，第 11 次被拦（驱妖开辟也计入；这里直接写 10 条今天的斗法纪事）。
    for (let index = 0; index < 10; index += 1) {
      await env.DB.prepare(
        `INSERT INTO world_site_logs (id, kind, sect_id, sect_name, target_sect_id, target_name, site_id, won, rounds, effects, created_at)
         VALUES (?, 'battle', ?, '记录', NULL, NULL, 'west-lingdi', 0, '[]', NULL, ?)`,
      )
        .bind(crypto.randomUUID(), early.sectId, NOW + HOUR)
        .run();
    }
    expect(
      await refusedOf(() =>
        attackWorldSite(env.DB, early.userId, { siteId: 'north-lingdi', discipleIds: early.discipleIds }, NOW + 2 * HOUR),
      ),
    ).toMatchObject({ code: 'DAILY_LIMIT' });
  });

  it('比斗：守方坐镇弟子不上场（自动守擂只从其余弟子里抽）；可应战的弟子不足 3 人时整宗不能应战', async () => {
    await resetWorldSites();
    const target = await makeSect(3);
    const [t0, t1, t2] = target.discipleIds as [string, string, string];
    const t3 = await addDisciple(target.sectId, '替补甲');
    const t4 = await addDisciple(target.sectId, '替补乙');
    const t5 = await addDisciple(target.sectId, '替补丙');
    pinRandom(0.5);
    await attackWorldSite(env.DB, target.userId, { siteId: 'west-lingdi', discipleIds: [t0, t1, t2] }, NOW);

    const challenger = await makeSect(3);
    const preview = await getPublicSect(env.DB, target.sectId, challenger.userId, NOW + HOUR);
    expect(preview.challenge).toMatchObject({ canChallenge: true, blockedReason: null });

    const fought = await challengeSect(env.DB, challenger.userId, target.sectId, challenger.discipleIds, NOW + HOUR, serviceEnv({ OPENROUTER_API_KEY: '' }));
    const reserve = [await nameOf(t3), await nameOf(t4), await nameOf(t5)];
    expect(fought.result.rounds.length).toBeGreaterThan(0);
    for (const round of fought.result.rounds) {
      expect(reserve).toContain(round.defenderName);
    }

    // 另一个宗门：三人全部坐镇 → 没有可应战的守方
    const empty = await makeSect(3);
    pinRandom(0.5);
    await attackWorldSite(env.DB, empty.userId, { siteId: 'north-lingdi', discipleIds: empty.discipleIds }, NOW);
    const challenger2 = await makeSect(3, true);
    const emptyPreview = await getPublicSect(env.DB, empty.sectId, challenger2.userId, NOW + HOUR);
    expect(emptyPreview.challenge).toMatchObject({ canChallenge: false, blockedReason: 'defender_insufficient' });
    expect(
      await refusedOf(() => challengeSect(env.DB, challenger2.userId, empty.sectId, challenger2.discipleIds, NOW + HOUR, serviceEnv({ OPENROUTER_API_KEY: '' }))),
    ).toMatchObject({ code: 'INVALID_STATUS', message: '对方门下弟子不足 3 人，暂时无法应战' });
  });
});

describe('山河舆图 · 整点供奉（计划 1.5）', () => {
  it('同一宗门的多处灵地合并为一条「灵地供奉」纪事；不满一小时不给；祖脉每 6 小时得 1 个玄铁、余数留存', async () => {
    await resetWorldSites();
    const owner = await makeSect(6);
    const a = owner.discipleIds as [string, string, string];
    const b = [
      await addDisciple(owner.sectId, '乙甲'),
      await addDisciple(owner.sectId, '乙乙'),
      await addDisciple(owner.sectId, '乙丙'),
    ] as [string, string, string];
    pinRandom(0.5);
    await attackWorldSite(env.DB, owner.userId, { siteId: 'east-lingdi', discipleIds: a }, NOW);
    await attackWorldSite(env.DB, owner.userId, { siteId: 'west-lingdi', discipleIds: b }, NOW);

    await processWorldSites(env.DB, NOW + 3 * HOUR + 10 * MIN);
    expect(await balanceOf(owner.sectId, 'herb')).toBe(40_000 + 3 * 75_000);
    expect(await balanceOf(owner.sectId, 'ore')).toBe(40_000 + 3 * 75_000);
    const settle = await logsOf(owner.sectId, 'settle');
    expect(settle).toHaveLength(1);
    expect(JSON.parse(settle[0]!.effects as string)).toEqual({ herb: '225000', ore: '225000' });
    expect(await siteRow('east-lingdi')).toMatchObject({ settled_at: NOW + 3 * HOUR });

    // 不满一小时：NOW+20min 占领，结算从 NOW+1h 起算；到 NOW+1h30min 什么都不给。
    const late = await makeSect(3);
    await attackWorldSite(env.DB, late.userId, { siteId: 'north-lingdi', discipleIds: late.discipleIds }, NOW + 20 * MIN);
    expect(await siteRow('north-lingdi')).toMatchObject({ settled_at: NOW + HOUR });
    await processWorldSites(env.DB, NOW + HOUR + 30 * MIN);
    expect(await balanceOf(late.sectId, 'spiritStone')).toBe(200_000);
    expect(await logsOf(late.sectId, 'settle')).toHaveLength(0);
    await processWorldSites(env.DB, NOW + 2 * HOUR + 10 * MIN);
    expect(await balanceOf(late.sectId, 'spiritStone')).toBe(200_000 + 50_000);

    // 祖脉：神木 / 玄铁，每坐镇满 6 个整点小时得 1 个，余数留到下次。
    const zu = await makeSect(3);
    pinRandom(0.5);
    const energyStart = await balanceOf(zu.sectId, 'spiritualEnergy');
    await attackWorldSite(env.DB, zu.userId, { siteId: 'center-xuantie', discipleIds: zu.discipleIds }, NOW);
    const broadcast = await env.DB.prepare("SELECT COUNT(*) AS cnt FROM chat_messages WHERE content LIKE '【山河】%'")
      .first<{ cnt: number }>();
    expect(Number(broadcast?.cnt)).toBeGreaterThanOrEqual(1);
    await processWorldSites(env.DB, NOW + 5 * HOUR + 10 * MIN);
    expect(await balanceOf(zu.sectId, 'xuantie')).toBe(0);
    expect(await siteRow('center-xuantie')).toMatchObject({ rare_hours: 5 });
    await processWorldSites(env.DB, NOW + 6 * HOUR + 10 * MIN);
    expect(await balanceOf(zu.sectId, 'xuantie')).toBe(1_000);
    expect(await siteRow('center-xuantie')).toMatchObject({ rare_hours: 0 });
    expect(await balanceOf(zu.sectId, 'spiritualEnergy')).toBe(energyStart + 6 * 80_000);
  });

  it('入账不超过仓库上限：溢出的部分作废，余额停在上限', async () => {
    await resetWorldSites();
    const sect = await makeSect(3);
    pinRandom(0.5);
    await attackWorldSite(env.DB, sect.userId, { siteId: 'east-lingdi', discipleIds: sect.discipleIds }, NOW);
    const herb = gameConfig().resources.find((item) => item.id === 'herb');
    const cap = effectiveCapacity(herb?.capacity ?? '0', findSectLevel(3).capacityMultiplier);
    await env.DB.prepare("UPDATE resource_balances SET balance = ? WHERE sect_id = ? AND resource_id = 'herb'")
      .bind(cap - 10_000, sect.sectId)
      .run();
    await processWorldSites(env.DB, NOW + 3 * HOUR + MIN);
    expect(await balanceOf(sect.sectId, 'herb')).toBe(cap);
  });

  it('占领者宗门已不存在：整点结算时灵地回到无主', async () => {
    await resetWorldSites();
    await env.DB.prepare(
      `UPDATE world_sites SET holder_sect_id = 'ghost-sect', holder_name = '幽灵宗', garrison = '["ghost"]',
         held_since = ?, protected_until = NULL, settled_at = ?, rare_hours = 0 WHERE id = 'east-fudi'`,
    )
      .bind(NOW, NOW)
      .run();
    await processWorldSites(env.DB, NOW + 2 * HOUR);
    expect(await siteRow('east-fudi')).toMatchObject({ holder_sect_id: null, garrison: null, settled_at: null });
  });

  it('定时结算顺带清理 3 天前的纪事（之内的保留）', async () => {
    await resetWorldSites();
    const sect = await makeSect(3);
    const insert = (createdAt: number) =>
      env.DB.prepare(
        `INSERT INTO world_site_logs (id, kind, sect_id, sect_name, target_sect_id, target_name, site_id, won, rounds, effects, created_at)
         VALUES (?, 'withdraw', ?, '旧', NULL, NULL, 'east-lingdi', NULL, NULL, NULL, ?)`,
      )
        .bind(crypto.randomUUID(), sect.sectId, createdAt)
        .run();
    await insert(NOW - 4 * 86_400_000);
    await insert(NOW - 86_400_000);
    await processWorldSites(env.DB, NOW);
    const left = await logsOf(sect.sectId);
    expect(left.map((row) => Number(row.created_at))).toEqual([NOW - 86_400_000]);
  });
});

describe('山河舆图 · 撤回与纪事', () => {
  it('撤回山门：坐镇弟子立刻解锁，灵地回到妖兽手里，已满的整点结算给自己', async () => {
    await resetWorldSites();
    const sect = await makeSect(3);
    const [a, b, c] = sect.discipleIds as [string, string, string];
    pinRandom(0.5);
    await attackWorldSite(env.DB, sect.userId, { siteId: 'east-lingdi', discipleIds: [a, b, c] }, NOW + 20 * MIN);

    // NOW+1h 起算，到 NOW+3h10min 已满 2 个整点（药材 150000）。
    const out = await withdrawWorldSite(env.DB, sect.userId, { siteId: 'east-lingdi' }, NOW + 3 * HOUR + 10 * MIN);
    expect(out.result.message).toBe('已撤回山门，放弃「青木域 · 百草谷」');
    expect(await siteRow('east-lingdi')).toMatchObject({
      holder_sect_id: null,
      garrison: null,
      held_since: null,
      protected_until: null,
      settled_at: null,
      rare_hours: 0,
    });
    expect(await balanceOf(sect.sectId, 'herb')).toBe(40_000 + 2 * 75_000);
    expect((await logsOf(sect.sectId, 'settle'))[0]?.effects).toBe('{"herb":"150000"}');
    expect(await logsOf(sect.sectId, 'withdraw')).toHaveLength(1);

    const freed = await assignDisciple(env.DB, sect.userId, a, 'herbGathering', NOW + 3 * HOUR + 11 * MIN);
    expect(freed.disciples.find((item) => item.id === a)?.garrisonSiteName).toBeNull();
    expect(await assignmentOf(a)).toBe('herbGathering');

    // 不是自己占着的，不能撤回
    expect(
      await refusedOf(() => withdrawWorldSite(env.DB, sect.userId, { siteId: 'east-lingdi' }, NOW + 4 * HOUR)),
    ).toMatchObject({ code: 'INVALID_STATUS' });
  });

  it('撤回冷却：撤回后 24 小时内本宗不能再开辟 / 斗法这一处（防强队夺地后换弱队），别的宗门不受影响', async () => {
    await resetWorldSites();
    const sect = await makeSect(3);
    // 弱宗：满 24 小时后强宗斗法必胜（浮动钉在 1.0）。
    const other = await makeSect(3, false);
    const [a, b, c] = sect.discipleIds as [string, string, string];
    pinRandom(0.5);
    await attackWorldSite(env.DB, sect.userId, { siteId: 'east-lingdi', discipleIds: [a, b, c] }, NOW);
    await withdrawWorldSite(env.DB, sect.userId, { siteId: 'east-lingdi' }, NOW + HOUR);
    expect(await siteRow('east-lingdi')).toMatchObject({
      withdrawn_sect_id: sect.sectId,
      withdrawn_until: NOW + HOUR + 24 * HOUR,
    });

    // 本宗：换人也进不去，面板给出冷却原因
    const panel = await getWorld(env.DB, sect.userId, NOW + 2 * HOUR);
    const site = panel.world.sites.find((item) => item.id === 'east-lingdi')!;
    expect(site.action).toBeNull();
    expect(site.blockedReason).toContain('刚撤回山门，冷却中');
    expect(
      await refusedOf(() => attackWorldSite(env.DB, sect.userId, { siteId: 'east-lingdi', discipleIds: [a, b, c] }, NOW + 2 * HOUR)),
    ).toMatchObject({ code: 'INVALID_STATUS' });
    // 别的灵地照常可打
    await attackWorldSite(env.DB, sect.userId, { siteId: 'west-lingdi', discipleIds: [a, b, c] }, NOW + 2 * HOUR);
    expect((await siteRow('west-lingdi')).holder_sect_id).toBe(sect.sectId);
    await withdrawWorldSite(env.DB, sect.userId, { siteId: 'west-lingdi' }, NOW + 3 * HOUR);

    // 别的宗门不受影响：可以直接开辟；易主后冷却仍在（撤回者 24 小时内也不能来斗法）
    const [x, y, z] = other.discipleIds as [string, string, string];
    await attackWorldSite(env.DB, other.userId, { siteId: 'east-lingdi', discipleIds: [x, y, z] }, NOW + 3 * HOUR);
    expect((await siteRow('east-lingdi')).holder_sect_id).toBe(other.sectId);
    expect(
      await refusedOf(() =>
        attackWorldSite(env.DB, sect.userId, { siteId: 'east-lingdi', discipleIds: [a, b, c] }, NOW + 8 * HOUR),
      ),
    ).toMatchObject({ code: 'INVALID_STATUS' });

    // 满 24 小时后冷却解除
    await attackWorldSite(env.DB, sect.userId, { siteId: 'east-lingdi', discipleIds: [a, b, c] }, NOW + 25 * HOUR + MIN);
    expect((await siteRow('east-lingdi')).holder_sect_id).toBe(sect.sectId);
  });

  it('山河纪事：天下只列斗法与撤回（不含供奉）；本宗列与自己有关的全部', async () => {
    await resetWorldSites();
    const owner = await makeSect(3);
    const raider = await makeSect(3, true);
    const bystander = await makeSect(3);
    pinRandom(0.5);
    await attackWorldSite(env.DB, owner.userId, { siteId: 'east-lingdi', discipleIds: owner.discipleIds }, NOW);
    await weaken(owner.sectId);
    await attackWorldSite(env.DB, raider.userId, { siteId: 'east-lingdi', discipleIds: raider.discipleIds }, NOW + 5 * HOUR);

    // 灵地日志在同一个文件里是共享的，这里只看本用例两家宗门的纪事。
    const all = await getWorld(env.DB, bystander.userId, NOW + 5 * HOUR + MIN, 'all');
    expect(all.world.scope).toBe('all');
    expect(all.world.logs.some((item) => item.kind === 'settle')).toBe(false);
    const ours = all.world.logs.filter(
      (item) => item.text.includes(owner.sectName) || item.text.includes(raider.sectName),
    );
    expect(ours.map((item) => item.kind)).toEqual(['battle', 'battle']);
    expect(ours[0]?.text).toBe(`${raider.sectName}夺下「青木域 · 百草谷」，击败${owner.sectName}`);
    expect(ours[1]?.text).toBe(`${owner.sectName}驱妖开辟「青木域 · 百草谷」`);
    expect(ours[0]).toMatchObject({ siteId: 'east-lingdi', won: true });
    expect(ours[0]?.rounds?.length).toBeGreaterThan(0);

    expect((await getWorld(env.DB, bystander.userId, NOW + 5 * HOUR + MIN, 'mine')).world.logs).toHaveLength(0);

    const mineOwner = await getWorld(env.DB, owner.userId, NOW + 5 * HOUR + MIN, 'mine');
    expect(mineOwner.world.scope).toBe('mine');
    expect(mineOwner.world.logs.map((item) => item.kind).sort()).toEqual(['battle', 'battle', 'settle']);
    expect(mineOwner.world.logs.find((item) => item.kind === 'settle')?.text).toBe('灵地供奉：药材 +375');

    const mineRaider = await getWorld(env.DB, raider.userId, NOW + 5 * HOUR + MIN, 'mine');
    expect(mineRaider.world.logs.map((item) => item.kind)).toEqual(['battle']);
  });
});

describe('山河舆图 · 接口', () => {
  it('GET /game/world 返回面板（scope 参数校验）；攻击 / 撤回的入参与归属校验；成功后可撤回', async () => {
    await resetWorldSites();
    const sect = await makeSect(3);
    const [a, b, c] = sect.discipleIds as [string, string, string];

    const panel = await sect.api.get('/api/v1/game/world');
    expect(panel.status).toBe(200);
    const data = dataOf(panel) as Record<string, any>;
    expect(data.world).toMatchObject({ unlocked: true, cap: 1, held: 0, scope: 'all', partySize: 3 });
    expect(data.world.sites).toHaveLength(14);
    expect(data.world.regions).toHaveLength(5);
    expect((await sect.api.get('/api/v1/game/world?scope=mine')).status).toBe(200);
    const badScope = await sect.api.get('/api/v1/game/world?scope=nope');
    expect(badScope.status).toBe(400);
    expect(errorOf(badScope).code).toBe('VALIDATION_ERROR');

    const shortParty = await sect.api.post('/api/v1/game/world/attack', { siteId: 'east-lingdi', discipleIds: [a, b] });
    expect(shortParty.status).toBe(400);
    const unknown = await sect.api.post('/api/v1/game/world/attack', { siteId: 'nowhere', discipleIds: [a, b, c] });
    expect(errorOf(unknown).code).toBe('NOT_FOUND');
    const notMine = await sect.api.post('/api/v1/game/world/withdraw', { siteId: 'east-lingdi' });
    expect(errorOf(notMine).code).toBe('INVALID_STATUS');

    pinRandom(0.5);
    const opened = await sect.api.post('/api/v1/game/world/attack', { siteId: 'east-lingdi', discipleIds: [a, b, c] });
    expect(opened.status).toBe(200);
    expect(dataOf(opened)).toMatchObject({ result: { battle: { won: true } }, world: { held: 1 } });
    const withdrawn = await sect.api.post('/api/v1/game/world/withdraw', { siteId: 'east-lingdi' });
    expect(withdrawn.status).toBe(200);
    expect(dataOf(withdrawn)).toMatchObject({ world: { held: 0 } });
  });
});
