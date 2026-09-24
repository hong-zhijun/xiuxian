import { applyD1Migrations, env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app';
import { dateKeyUtc8, dayStartMs } from '../src/modules/game/constants';
import { attackWorldBoss, getWorldBoss, processWorldBoss } from '../src/modules/game/service';
import {
  WORLD_BOSS_DAILY_ATTACKS,
  WORLD_BOSS_MIN_HP,
  worldBossIndexFor,
} from '../src/modules/game/worldBoss';

import { dataOf, errorOf, TestClient } from './support/authClient';

/**
 * 世界 Boss（讨伐，0025）：服务层 + D1 的集成测试。
 *
 * 存储说明：本文件一份独立内存 D1，没有逐用例回滚 —— 每个用例用独立账号/宗门，
 * Boss 用**互不相同的 UTC+8 日期**（day_key 唯一）隔离；库层面的断言都按宗门 id / day_key 定界。
 *
 * 时间说明：讨伐只在 08:00–23:00（UTC+8）开放，一天一只 Boss。测试完全不依赖真实时钟：
 * service 的三个入口（getWorldBoss / attackWorldBoss / processWorldBoss）都显式收 `now`，
 * 由用例自己决定「现在是第几天几点」。每次都用 `freezeDay` 把宗门的 last_settled_at 拨到
 * **当天 23:59 之后** —— 于是用例里任何一次调用的结算窗口都是 0（零产出零事件），资源断言才精确。
 *
 * 随机说明：出手伤害 = 战力 × 演武场加成 × 浮动 × 暴击 × 力竭 × 100。用例把 Math.random
 * 钉成 0.5（浮动恰为 1.0；暴击率最高 20%，所以一定不暴击），伤害只由队伍战力决定。
 *
 * 广播说明：系统广播按内容计数（不按条数切片）—— 用例之间的 now 是「未来日期」，
 * 按 created_at 排序时新消息未必排在最后。
 */

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

const quietLogger = { info: () => {}, warn: () => {}, error: () => {} } as const;
const app = createApp({ logger: quietLogger });
const PASSWORD = 'password-123456';
const HOUR = 3_600_000;

let seq = 0;

interface SectFixture {
  api: TestClient;
  userId: string;
  sectId: string;
  sectName: string;
  discipleIds: string[];
  state: () => Promise<Record<string, any>>;
}

/** 注册 + 建宗门；返回宗门 id、user id、弟子 id 与同步读取函数。 */
async function makeSect(prefix: string): Promise<SectFixture> {
  seq += 1;
  const account = `${prefix}-${seq}`;
  const api = new TestClient(app, env, {
    'cf-connecting-ip': `10.7.${Math.floor(seq / 250)}.${seq % 250}`,
  });
  const registered = await api.post('/api/v1/auth/register', { account, password: PASSWORD });
  expect(registered.status).toBe(200);
  const created = await api.post('/api/v1/game/create-sect', { name: `讨伐${seq}号` });
  expect(created.status).toBe(200);
  const state = dataOf(created) as Record<string, any>;
  const sectId = state.state.sect.id as string;

  const row = await env.DB.prepare('SELECT user_id, name FROM sects WHERE id = ?')
    .bind(sectId)
    .first<{ user_id: string; name: string }>();
  expect(row).not.toBeNull();

  return {
    api,
    userId: row!.user_id,
    sectId,
    sectName: row!.name,
    discipleIds: (state.state.disciples as { id: string }[]).map((item) => item.id),
    state: async () => {
      const result = await api.get('/api/v1/game/sync');
      expect(result.status).toBe(200);
      return (dataOf(result) as Record<string, any>).state;
    },
  };
}

/* ---------- 时间与库的直接读写辅助 ---------- */

/** 以「今天的 UTC+8 日期」为第 0 天，取第 dayOffset 天 UTC+8 的 hour:minute。 */
function bossNow(dayOffset: number, hour: number, minute = 30): number {
  const parts = dateKeyUtc8(Date.now()).split('-').map(Number);
  const year = parts[0] ?? 1970;
  const month = parts[1] ?? 1;
  const day = parts[2] ?? 1;
  return Date.UTC(year, month - 1, day, hour - 8, minute) + dayOffset * 86_400_000;
}

/**
 * 把结算时间拨到「第 dayOffset 天 23:59 之后」：用例里任何 now 之间的结算窗口都是 0，
 * 资源断言只受被测逻辑影响。
 */
async function freezeDay(sectId: string, dayOffset: number): Promise<void> {
  await env.DB.prepare('UPDATE sects SET last_settled_at = ? WHERE id = ?')
    .bind(bossNow(dayOffset, 23, 59) + 60_000, sectId)
    .run();
}

async function balanceOf(sectId: string, resourceId: string): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT balance FROM resource_balances WHERE sect_id = ? AND resource_id = ?',
  )
    .bind(sectId, resourceId)
    .first<{ balance: number }>();
  return Number(row?.balance ?? 0);
}

async function pillCount(sectId: string, pillId: string): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT quantity FROM pill_inventories WHERE sect_id = ? AND pill_id = ?',
  )
    .bind(sectId, pillId)
    .first<{ quantity: number }>();
  return row === null ? 0 : Number(row.quantity);
}

/** 该宗门每小时的产出（最小单位）：与 attackWorldBoss 内部用的是同一个口径。 */
async function ratesOf(fixture: SectFixture): Promise<Record<string, number>> {
  const state = await fixture.state();
  const rates: Record<string, number> = {};
  for (const resource of state.resources as { id: string; ratePerHour: string }[]) {
    rates[resource.id] = Number(resource.ratePerHour);
  }
  return rates;
}

async function bossRow(dayKey: string): Promise<Record<string, any> | null> {
  return env.DB.prepare('SELECT * FROM world_bosses WHERE day_key = ?')
    .bind(dayKey)
    .first<Record<string, any>>();
}

async function hitsOf(bossId: string): Promise<Record<string, any>[]> {
  const result = await env.DB.prepare(
    'SELECT * FROM world_boss_hits WHERE boss_id = ? ORDER BY created_at ASC, attempt_no ASC',
  )
    .bind(bossId)
    .all<Record<string, any>>();
  return result.results ?? [];
}

/** 全服系统广播。 */
async function systemMessages(): Promise<string[]> {
  const result = await env.DB.prepare(
    "SELECT content FROM chat_messages WHERE user_id = 'system'",
  ).all<{ content: string }>();
  return (result.results ?? []).map((row) => row.content);
}

async function countMessages(predicate: (text: string) => boolean): Promise<number> {
  return (await systemMessages()).filter(predicate).length;
}

/** 直接造一只 Boss（绕开出现逻辑，专测出手 / 逃走 / 发奖）。 */
async function insertBoss(input: {
  dayKey: string;
  now: number;
  bossIndex?: number;
  level?: number;
  maxHp?: number;
  hp?: number;
  status?: string;
  killerSectId?: string | null;
  halfAnnounced?: number;
  rewardedAt?: number | null;
}): Promise<string> {
  const id = crypto.randomUUID();
  const maxHp = input.maxHp ?? 1_000_000;
  await env.DB.prepare(
    `INSERT INTO world_bosses
       (id, day_key, boss_index, level, max_hp, hp, status, killer_sect_id,
        half_announced, rewarded_at, created_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  )
    .bind(
      id,
      input.dayKey,
      input.bossIndex ?? 0,
      input.level ?? 1,
      maxHp,
      input.hp ?? maxHp,
      input.status ?? 'active',
      input.killerSectId ?? null,
      input.halfAnnounced ?? 0,
      input.rewardedAt ?? null,
      input.now,
    )
    .run();
  return id;
}

/** 一条尚未到期的历练记录（直接落库，绕过出发接口的其它前置条件）。 */
async function startJourneyAt(input: {
  sectId: string;
  discipleId: string;
  name: string;
  now: number;
  endsAt: number;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO disciple_journeys
       (id, sect_id, disciple_id, disciple_name, direction, duration_seconds,
        original_assignment, started_at, ends_at, completed_at, claimed_at,
        reward_cultivation, reward_resources, extra_harvest, injured, injury_chance_bp,
        cultivation_awarded, created_at)
     VALUES (?, ?, ?, ?, 'gathering', 21600, 'idle', ?, ?, NULL, NULL, 0, '{}', 0, 0, 0, NULL, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      input.sectId,
      input.discipleId,
      input.name,
      input.now - HOUR,
      input.endsAt,
      input.now,
    )
    .run();
}

/** 断言 Promise 抛出的业务错误码（没有抛错时返回 undefined）。 */
async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('世界 Boss：出现（Cron）', () => {
  it('08:00 之前不出现；出现后重复触发也只创建一次、广播一次', async () => {
    const fixture = await makeSect('spawn');
    const noon = bossNow(0, 12, 30);
    const dayKey = dateKeyUtc8(noon);
    await freezeDay(fixture.sectId, 0);

    // 07:00：还没到 08:00 → 不出现；面板给出「08:00 降临」。
    await processWorldBoss(env.DB, bossNow(0, 7));
    expect(await bossRow(dayKey)).toBeNull();
    const early = await getWorldBoss(env.DB, fixture.userId, bossNow(0, 7, 0));
    expect(early.boss.boss).toBeNull();
    expect(early.boss.phase).toBe('before');
    expect(early.boss.attackable).toBe(false);
    expect(early.boss.remainingSeconds).toBeGreaterThan(0);
    expect(early.boss.opensAt).toBe(dayStartMs(bossNow(0, 7)) + 8 * HOUR);

    // 12:30：第一次 Cron → 创建当天 Boss 并广播一次。
    const spawns = await countMessages((text) => text.includes('降临'));
    await processWorldBoss(env.DB, noon);
    const row = await bossRow(dayKey);
    expect(row).not.toBeNull();
    expect(row!.status).toBe('active');
    expect(row!.boss_index).toBe(worldBossIndexFor(noon));
    expect(Number(row!.hp)).toBe(Number(row!.max_hp));
    expect(Number(row!.max_hp)).toBeGreaterThanOrEqual(WORLD_BOSS_MIN_HP);
    expect(Number(row!.half_announced)).toBe(0);
    expect(row!.rewarded_at).toBeNull();
    expect(row!.ended_at).toBeNull();
    expect(await countMessages((text) => text.includes('降临'))).toBe(spawns + 1);

    // 再触发两次（同一天）：day_key 唯一 → 不重复创建、不重复广播。
    await processWorldBoss(env.DB, bossNow(0, 14));
    await processWorldBoss(env.DB, bossNow(0, 18));
    const count = await env.DB.prepare('SELECT COUNT(*) AS total FROM world_bosses WHERE day_key = ?')
      .bind(dayKey)
      .first<{ total: number }>();
    expect(Number(count?.total)).toBe(1);
    expect(await countMessages((text) => text.includes('降临'))).toBe(spawns + 1);
  });

  it('第二天的等级：前一天击杀则 +1、逃走则 −1', async () => {
    // 第 300 天：击杀、等级 3、已发奖 → 第 301 天出现的是 4 级。
    await insertBoss({
      dayKey: dateKeyUtc8(bossNow(300, 13)),
      now: bossNow(300, 13),
      level: 3,
      hp: 0,
      status: 'killed',
      rewardedAt: bossNow(300, 23),
    });
    const upDay = bossNow(301, 12, 30);
    await processWorldBoss(env.DB, upDay);
    const up = await bossRow(dateKeyUtc8(upDay));
    expect(Number(up?.level)).toBe(4);

    // 第 310 天：逃走、等级 3、已发奖 → 第 311 天出现的是 2 级。
    await insertBoss({
      dayKey: dateKeyUtc8(bossNow(310, 13)),
      now: bossNow(310, 13),
      level: 3,
      hp: 900_000,
      status: 'fled',
      rewardedAt: bossNow(310, 23),
    });
    const downDay = bossNow(311, 12, 30);
    await processWorldBoss(env.DB, downDay);
    const down = await bossRow(dateKeyUtc8(downDay));
    expect(Number(down?.level)).toBe(2);
  });
});

describe('世界 Boss：面板与接口', () => {
  it('面板给出阶段、次数与今日榜单；GET /game/world-boss 返回同一份数据', async () => {
    const fixture = await makeSect('panel');
    const noon = bossNow(4, 12, 30);
    await freezeDay(fixture.sectId, 4);
    await processWorldBoss(env.DB, noon);

    const panel = await getWorldBoss(env.DB, fixture.userId, bossNow(4, 13));
    expect(panel.boss.phase).toBe('open');
    expect(panel.boss.dailyLimit).toBe(WORLD_BOSS_DAILY_ATTACKS);
    expect(panel.boss.usedToday).toBe(0);
    expect(panel.boss.remaining).toBe(WORLD_BOSS_DAILY_ATTACKS);
    expect(panel.boss.attackable).toBe(true);
    expect(panel.boss.boss).not.toBeNull();
    expect(panel.boss.boss!.dayKey).toBe(dateKeyUtc8(noon));
    expect(panel.boss.boss!.status).toBe('active');
    expect(panel.boss.boss!.level).toBeGreaterThanOrEqual(1);
    expect(panel.boss.ranks).toEqual([]);
    expect(panel.boss.hits).toEqual([]);
    expect(panel.boss.remainingSeconds).toBeGreaterThan(0);
    // view 里的角标与面板一致（只有 sync / 本接口会给真值）。
    expect(panel.state.worldBoss.attackable).toBe(true);

    // 接口在真实时钟下返回同一份数据（合成日期只有 service 直调才能造）。
    const realtime = await getWorldBoss(env.DB, fixture.userId, Date.now());
    const viaApi = await fixture.api.get('/api/v1/game/world-boss');
    expect(viaApi.status).toBe(200);
    const data = dataOf(viaApi) as Record<string, any>;
    expect(data.boss.dailyLimit).toBe(realtime.boss.dailyLimit);
    expect(data.boss.phase).toBe(realtime.boss.phase);
    expect(data.boss.usedToday).toBe(realtime.boss.usedToday);
    expect(data.state.worldBoss).toHaveProperty('attackable');

    // 23:00 之后攻击面关闭。
    const closed = await getWorldBoss(env.DB, fixture.userId, bossNow(4, 23));
    expect(closed.boss.phase).toBe('closed');
    expect(closed.boss.attackable).toBe(false);
    expect(closed.boss.remainingSeconds).toBe(0);
  });

  it('出手入参校验：1~3 名、去重、多余字段一律 400', async () => {
    const fixture = await makeSect('validate');
    const empty = await fixture.api.post('/api/v1/game/world-boss/attack', { discipleIds: [] });
    expect(empty.status).toBe(400);
    expect(errorOf(empty).code).toBe('VALIDATION_ERROR');

    const tooMany = await fixture.api.post('/api/v1/game/world-boss/attack', {
      discipleIds: ['a', 'b', 'c', 'd'],
    });
    expect(tooMany.status).toBe(400);
    expect(errorOf(tooMany).code).toBe('VALIDATION_ERROR');

    const strict = await fixture.api.post('/api/v1/game/world-boss/attack', {
      discipleIds: [fixture.discipleIds[0]!],
      extra: 1,
    });
    expect(strict.status).toBe(400);
    expect(errorOf(strict).code).toBe('VALIDATION_ERROR');
  });
});

describe('世界 Boss：出手', () => {
  it('未出现 / 不在开放时段时出手被拒', async () => {
    const fixture = await makeSect('reject');
    const discipleIds = [fixture.discipleIds[0]!];
    const noon = bossNow(5, 13);
    await freezeDay(fixture.sectId, 5);

    expect(
      await codeOf(attackWorldBoss(env.DB, fixture.userId, { discipleIds }, bossNow(5, 7))),
    ).toBe('INVALID_STATUS');
    expect(
      await codeOf(attackWorldBoss(env.DB, fixture.userId, { discipleIds }, bossNow(5, 23))),
    ).toBe('INVALID_STATUS');
    // 开放时段但今天还没有 Boss
    expect(await codeOf(attackWorldBoss(env.DB, fixture.userId, { discipleIds }, noon))).toBe(
      'NOT_FOUND',
    );
  });

  it('出手扣血、写出手记录、立即发参与奖', async () => {
    const fixture = await makeSect('attack');
    const noon = bossNow(6, 12, 30);
    const attackNow = bossNow(6, 13);
    await freezeDay(fixture.sectId, 6);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const rates = await ratesOf(fixture);
    const bossId = await insertBoss({ dayKey: dateKeyUtc8(attackNow), now: noon });

    const balanceBefore = await balanceOf(fixture.sectId, 'spiritStone');
    const result = await attackWorldBoss(
      env.DB,
      fixture.userId,
      { discipleIds: [fixture.discipleIds[0]!] },
      attackNow,
    );

    // 浮动 1.0、不暴击、非力竭：伤害 = 队伍战力 × 100
    expect(result.result.crit).toBe(false);
    expect(result.result.frenzy).toBe(false);
    expect(result.result.damage).toBeGreaterThan(0);
    expect(result.result.actualDamage).toBe(result.result.damage);
    expect(result.result.lastHit).toBe(false);

    // 参与奖 = max(灵石产出 × 0.25, 10 × 宗门等级(1) × 1000) × 加成(Boss 1 级 → 1.0)
    const expected = Math.floor(Math.max((rates.spiritStone ?? 0) * 0.25, 10_000));
    expect(result.result.participationReward).toBe(String(expected));
    expect((await balanceOf(fixture.sectId, 'spiritStone')) - balanceBefore).toBe(expected);

    // 出手记录与扣血
    const row = (await bossRow(dateKeyUtc8(attackNow)))!;
    expect(Number(row.hp)).toBe(1_000_000 - result.result.damage);
    const hits = await hitsOf(bossId);
    expect(hits).toHaveLength(1);
    expect(Number(hits[0]!.attempt_no)).toBe(1);
    expect(Number(hits[0]!.damage)).toBe(result.result.damage);
    expect(Number(hits[0]!.is_crit)).toBe(0);
    expect(Number(hits[0]!.is_last_hit)).toBe(0);
    expect(hits[0]!.sect_id).toBe(fixture.sectId);
    expect(JSON.parse(hits[0]!.disciple_names as string)).toHaveLength(1);

    // 面板随之更新：今日次数与榜单
    expect(result.boss.usedToday).toBe(1);
    expect(result.boss.remaining).toBe(WORLD_BOSS_DAILY_ATTACKS - 1);
    expect(result.boss.ranks).toHaveLength(1);
    expect(result.boss.ranks[0]!.sectId).toBe(fixture.sectId);
    expect(result.boss.ranks[0]!.damage).toBe(result.result.damage);
    expect(result.boss.ranks[0]!.isMe).toBe(true);
    expect(result.boss.hits).toHaveLength(1);
    expect(result.boss.topHit?.damage).toBe(result.result.damage);
  });

  it('每宗每日 3 次，第 4 次被拒', async () => {
    const fixture = await makeSect('limit');
    await freezeDay(fixture.sectId, 7);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const bossId = await insertBoss({ dayKey: dateKeyUtc8(bossNow(7, 14)), now: bossNow(7, 12, 30) });
    const discipleIds = [fixture.discipleIds[0]!];

    for (let attempt = 1; attempt <= WORLD_BOSS_DAILY_ATTACKS; attempt += 1) {
      const result = await attackWorldBoss(env.DB, fixture.userId, { discipleIds }, bossNow(7, 14));
      expect(result.boss.usedToday).toBe(attempt);
      expect(result.boss.remaining).toBe(WORLD_BOSS_DAILY_ATTACKS - attempt);
    }

    expect(
      await codeOf(attackWorldBoss(env.DB, fixture.userId, { discipleIds }, bossNow(7, 15))),
    ).toBe('DAILY_LIMIT');
    expect(await hitsOf(bossId)).toHaveLength(WORLD_BOSS_DAILY_ATTACKS);
  });

  it('派在外历练 / 疗伤中的弟子被拒', async () => {
    const fixture = await makeSect('blocked');
    const attackNow = bossNow(8, 13);
    await freezeDay(fixture.sectId, 8);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    await insertBoss({ dayKey: dateKeyUtc8(attackNow), now: bossNow(8, 12, 30) });
    const [away, injured, healthy] = fixture.discipleIds as [string, string, string];

    await startJourneyAt({
      sectId: fixture.sectId,
      discipleId: away,
      name: '在外弟子',
      now: attackNow,
      endsAt: attackNow + 5 * HOUR,
    });
    await env.DB.prepare('UPDATE disciples SET injured_until = ? WHERE id = ?')
      .bind(attackNow + 10 * 60_000, injured)
      .run();

    expect(
      await codeOf(attackWorldBoss(env.DB, fixture.userId, { discipleIds: [away] }, attackNow)),
    ).toBe('INVALID_STATUS');
    expect(
      await codeOf(attackWorldBoss(env.DB, fixture.userId, { discipleIds: [injured] }, attackNow)),
    ).toBe('INVALID_STATUS');
    // 不在本宗的 id 一律 NOT_FOUND
    expect(
      await codeOf(
        attackWorldBoss(env.DB, fixture.userId, { discipleIds: [crypto.randomUUID()] }, attackNow),
      ),
    ).toBe('NOT_FOUND');
    // 健康的弟子照常出手（同一名弟子重复传入先被去重）
    const ok = await attackWorldBoss(
      env.DB,
      fixture.userId,
      { discipleIds: [healthy, healthy] },
      attackNow,
    );
    expect(ok.result.damage).toBeGreaterThan(0);
    expect(ok.boss.usedToday).toBe(1);
  });

  it('打空血量：击杀、killer_sect_id、最后一击标记与广播', async () => {
    const fixture = await makeSect('kill');
    const attackNow = bossNow(9, 13);
    await freezeDay(fixture.sectId, 9);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    await insertBoss({ dayKey: dateKeyUtc8(attackNow), now: bossNow(9, 12, 30), hp: 100, maxHp: 1_000_000 });
    const killText = `【讨伐】${fixture.sectName}一击斩落`;
    const kills = await countMessages((text) => text.includes(killText));

    const result = await attackWorldBoss(
      env.DB,
      fixture.userId,
      { discipleIds: [fixture.discipleIds[0]!] },
      attackNow,
    );
    expect(result.result.damage).toBeGreaterThan(100);
    expect(result.result.actualDamage).toBe(100);
    expect(result.result.lastHit).toBe(true);
    expect(result.result.bossHp).toBe(0);
    expect(result.result.bossMaxHp).toBe(1_000_000);

    const row = (await bossRow(dateKeyUtc8(attackNow)))!;
    expect(row.status).toBe('killed');
    expect(row.killer_sect_id).toBe(fixture.sectId);
    expect(row.ended_at).not.toBeNull();
    expect(Number(row.hp)).toBe(0);

    const hits = await hitsOf(row.id as string);
    expect(hits).toHaveLength(1);
    expect(Number(hits[0]!.is_last_hit)).toBe(1);

    expect(result.boss.boss!.status).toBe('killed');
    expect(result.boss.attackable).toBe(false);
    expect(result.boss.boss!.killerSectName).toBe(fixture.sectName);

    expect(await countMessages((text) => text.includes(killText))).toBe(kills + 1);
    expect(
      await countMessages((text) => text.includes(fixture.sectName) && text.includes('讨伐成功')),
    ).toBe(1);
  });

  it('血量首次跌破一半只广播一次', async () => {
    const fixture = await makeSect('half');
    await freezeDay(fixture.sectId, 10);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    // 血量本来就不到一半（half_announced 仍为 0）：第一次出手补广播并置标记，之后不再广播。
    await insertBoss({
      dayKey: dateKeyUtc8(bossNow(10, 13)),
      now: bossNow(10, 12, 30),
      hp: 200_000,
      maxHp: 1_000_000,
    });
    const discipleIds = [fixture.discipleIds[0]!];
    const halves = await countMessages((text) => text.includes('不足一半'));

    await attackWorldBoss(env.DB, fixture.userId, { discipleIds }, bossNow(10, 13));
    expect(await countMessages((text) => text.includes('不足一半'))).toBe(halves + 1);

    await attackWorldBoss(env.DB, fixture.userId, { discipleIds }, bossNow(10, 14));
    expect(await countMessages((text) => text.includes('不足一半'))).toBe(halves + 1);
  });

  it('刷新史上最强一击时广播', async () => {
    const fixture = await makeSect('top');
    await freezeDay(fixture.sectId, 11);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    await insertBoss({ dayKey: dateKeyUtc8(bossNow(11, 13)), now: bossNow(11, 12, 30) });
    // 把出战弟子拔到大能境界：这一击的伤害必定超过其它用例留下的纪录。
    await env.DB.prepare(
      "UPDATE disciples SET realm_id = 'spiritTransformation', stage = 3, attack = 100, defense = 100, speed = 100 WHERE id = ?",
    )
      .bind(fixture.discipleIds[0]!)
      .run();
    const discipleIds = [fixture.discipleIds[0]!];
    const isRecord = (text: string): boolean =>
      text.includes('刷新史上最强一击') && text.includes(fixture.sectName);
    const records = await countMessages(isRecord);

    // 超过全表纪录 → 广播刷新。
    const first = await attackWorldBoss(env.DB, fixture.userId, { discipleIds }, bossNow(11, 13));
    expect(await countMessages(isRecord)).toBe(records + 1);
    expect(
      await countMessages((text) => text.includes(fixture.sectName) && text.includes(String(first.result.damage))),
    ).toBe(1);

    // 同样的队伍再打一次（伤害相同）→ 没有超过纪录，不再广播。
    await attackWorldBoss(env.DB, fixture.userId, { discipleIds }, bossNow(11, 14));
    expect(await countMessages(isRecord)).toBe(records + 1);
  });
});

describe('世界 Boss：Cron 发奖', () => {
  it('击杀发奖：奖池按伤害占比分配 + 丹药，且只发一次', async () => {
    const fixture = await makeSect('reward');
    const dayKey = dateKeyUtc8(bossNow(20, 13));
    await freezeDay(fixture.sectId, 20);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const rates = await ratesOf(fixture);
    await insertBoss({ dayKey, now: bossNow(20, 12, 30), hp: 100, maxHp: 1_000_000 });
    const killed = await attackWorldBoss(
      env.DB,
      fixture.userId,
      { discipleIds: [fixture.discipleIds[0]!] },
      bossNow(20, 13),
    );
    expect(killed.result.lastHit).toBe(true);

    const before = {
      spiritStone: await balanceOf(fixture.sectId, 'spiritStone'),
      herb: await balanceOf(fixture.sectId, 'herb'),
      ore: await balanceOf(fixture.sectId, 'ore'),
      cultivationPill: await pillCount(fixture.sectId, 'cultivationPill'),
      bodyTemperingPill: await pillCount(fixture.sectId, 'bodyTemperingPill'),
    };

    await processWorldBoss(env.DB, bossNow(20, 14));

    // 只有一个参与宗门 → 伤害占比 1.0，奖池全额归它：max(产出 × 1.5, 保底 10000) × 加成(1.0)。
    const pool = (rate: number): number => Math.floor(Math.max(rate * 1.5, 10_000));
    // 最后一击奖：灵石 max(产出 × 0.5, 保底) × 加成。
    const lastHit = Math.floor(Math.max((rates.spiritStone ?? 0) * 0.5, 10_000));

    expect((await balanceOf(fixture.sectId, 'spiritStone')) - before.spiritStone).toBe(
      pool(rates.spiritStone ?? 0) + lastHit,
    );
    expect((await balanceOf(fixture.sectId, 'herb')) - before.herb).toBe(pool(rates.herb ?? 0));
    expect((await balanceOf(fixture.sectId, 'ore')) - before.ore).toBe(pool(rates.ore ?? 0));
    expect((await pillCount(fixture.sectId, 'cultivationPill')) - before.cultivationPill).toBe(1);
    expect((await pillCount(fixture.sectId, 'bodyTemperingPill')) - before.bodyTemperingPill).toBe(1);
    expect((await bossRow(dayKey))!.rewarded_at).not.toBeNull();

    // 再跑两次 Cron：rewarded_at 已写 → 一分钱都不再发。
    await processWorldBoss(env.DB, bossNow(20, 15));
    await processWorldBoss(env.DB, bossNow(20, 16));
    expect(await balanceOf(fixture.sectId, 'spiritStone')).toBe(
      before.spiritStone + pool(rates.spiritStone ?? 0) + lastHit,
    );
    expect(await balanceOf(fixture.sectId, 'herb')).toBe(before.herb + pool(rates.herb ?? 0));
    expect(await balanceOf(fixture.sectId, 'ore')).toBe(before.ore + pool(rates.ore ?? 0));
    expect(await pillCount(fixture.sectId, 'cultivationPill')).toBe(before.cultivationPill + 1);
    expect(await pillCount(fixture.sectId, 'bodyTemperingPill')).toBe(
      before.bodyTemperingPill + 1,
    );
  });

  it('击退（≥70%）：奖池减半、没有丹药', async () => {
    const fixture = await makeSect('repel');
    await freezeDay(fixture.sectId, 31);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const rates = await ratesOf(fixture);
    const discipleIds = [fixture.discipleIds[0]!];

    // 先用一只打不死的 Boss 测出本次出手的伤害（同一队伍 + 固定随机源 → 伤害相同）。
    await insertBoss({ dayKey: dateKeyUtc8(bossNow(31, 13)), now: bossNow(31, 12, 30) });
    const probe = await attackWorldBoss(env.DB, fixture.userId, { discipleIds }, bossNow(31, 13));

    // 血量设成「这一击正好打掉 80%」→ 既没击杀、也算击退（≥70%）。
    const fledDayKey = dateKeyUtc8(bossNow(30, 13));
    const fledHp = Math.ceil(probe.result.damage / 0.8);
    await insertBoss({ dayKey: fledDayKey, now: bossNow(30, 12, 30), hp: fledHp, maxHp: fledHp });
    const hit = await attackWorldBoss(env.DB, fixture.userId, { discipleIds }, bossNow(30, 13));
    expect(hit.result.lastHit).toBe(false);
    expect(hit.result.actualDamage).toBe(probe.result.damage);

    const before = {
      spiritStone: await balanceOf(fixture.sectId, 'spiritStone'),
      herb: await balanceOf(fixture.sectId, 'herb'),
      cultivationPill: await pillCount(fixture.sectId, 'cultivationPill'),
      bodyTemperingPill: await pillCount(fixture.sectId, 'bodyTemperingPill'),
    };

    // 23:00 的 Cron：逃走（已击退）+ 发奖（奖池减半）。隔夜/未来的 Boss 行都不受影响。
    await processWorldBoss(env.DB, bossNow(30, 23));
    const row = (await bossRow(fledDayKey))!;
    expect(row.status).toBe('fled');
    expect(row.rewarded_at).not.toBeNull();
    expect((await bossRow(dateKeyUtc8(bossNow(31, 13))))!.status).toBe('active');

    const panel = await getWorldBoss(env.DB, fixture.userId, bossNow(30, 23));
    expect(panel.boss.boss!.fledOutcome).toBe('repelled');
    expect(panel.boss.attackable).toBe(false);

    // 奖池减半 = 击杀奖池的一半（先按份求和再减半）。
    const halved = (rate: number): number => Math.floor(Math.floor(Math.max(rate * 1.5, 10_000)) * 0.5);
    expect((await balanceOf(fixture.sectId, 'spiritStone')) - before.spiritStone).toBe(
      halved(rates.spiritStone ?? 0),
    );
    expect((await balanceOf(fixture.sectId, 'herb')) - before.herb).toBe(halved(rates.herb ?? 0));
    // 击退没有丹药、也没有最高伤害 / 最后一击奖。
    expect(await pillCount(fixture.sectId, 'cultivationPill')).toBe(before.cultivationPill);
    expect(await pillCount(fixture.sectId, 'bodyTemperingPill')).toBe(before.bodyTemperingPill);
  });

  it('不足 70% 逃走：只有已经发过的参与奖', async () => {
    const fixture = await makeSect('escape');
    const dayKey = dateKeyUtc8(bossNow(40, 13));
    await freezeDay(fixture.sectId, 40);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    await insertBoss({ dayKey, now: bossNow(40, 12, 30), maxHp: 1_000_000 });
    await attackWorldBoss(
      env.DB,
      fixture.userId,
      { discipleIds: [fixture.discipleIds[0]!] },
      bossNow(40, 13),
    );

    const before = {
      spiritStone: await balanceOf(fixture.sectId, 'spiritStone'),
      herb: await balanceOf(fixture.sectId, 'herb'),
      ore: await balanceOf(fixture.sectId, 'ore'),
      cultivationPill: await pillCount(fixture.sectId, 'cultivationPill'),
    };

    await processWorldBoss(env.DB, bossNow(40, 23));
    const row = (await bossRow(dayKey))!;
    expect(row.status).toBe('fled');
    expect(row.rewarded_at).not.toBeNull();
    expect(Number(row.hp)).toBeGreaterThan(Number(row.max_hp) * 0.3);

    const panel = await getWorldBoss(env.DB, fixture.userId, bossNow(40, 23));
    expect(panel.boss.boss!.fledOutcome).toBe('escaped');

    expect(await balanceOf(fixture.sectId, 'spiritStone')).toBe(before.spiritStone);
    expect(await balanceOf(fixture.sectId, 'herb')).toBe(before.herb);
    expect(await balanceOf(fixture.sectId, 'ore')).toBe(before.ore);
    expect(await pillCount(fixture.sectId, 'cultivationPill')).toBe(before.cultivationPill);
  });
});
