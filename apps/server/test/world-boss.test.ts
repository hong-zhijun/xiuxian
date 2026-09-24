import { applyD1Migrations, env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app';
import { SEVERE_INJURY_MS, dateKeyUtc8, dayStartMs } from '../src/modules/game/constants';
import { attackWorldBoss, getWorldBoss, processWorldBoss } from '../src/modules/game/service';
import {
  WORLD_BOSS_COOLDOWN_MS,
  WORLD_BOSS_INJURY_DURATION_MS,
  WORLD_BOSS_KILL_POOL_RATE_FACTOR,
  WORLD_BOSS_LAST_HIT_RATE_FACTOR,
  WORLD_BOSS_MIN_HP,
  WORLD_BOSS_ROUNDS_PER_STAGE,
  bossIndexFor,
  dayIndexUtc8,
  rankRewardMultiplier,
  rewardFloor,
  stageMaxHp,
  stageRewardMultiplier,
} from '../src/modules/game/worldBoss';

import { dataOf, errorOf, TestClient } from './support/authClient';

/**
 * 世界 Boss 二期（连战 · 随机词缀 · 疲劳/受伤/重伤）：服务层 + D1 的集成测试。
 *
 * 存储说明：本文件一份独立内存 D1，没有逐用例回滚 —— 每个用例用独立账号/宗门，
 * 关卡用**互不相同的 UTC+8 日期**（day_key 唯一）隔离；断言都按宗门 id / day_key 定界。
 *
 * 时间说明：讨伐只在 08:00–23:00 开放。service 的三个入口都显式收 `now`，
 * 用例自己决定「现在是第几天几点」；同时把宗门的 last_settled_at 拨到当天 23:59 之后
 * （结算窗口为 0），资源断言只受被测逻辑影响。
 *
 * 随机说明：伤害浮动 / 暴击 / 受伤 / 重伤都用 Math.random，用例按「取用顺序」注入固定值：
 * 每名弟子先判重伤（1 个随机数），未重伤再判受伤（第 2 个），全部判完才轮到伤害（浮动 + 暴击）。
 */

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

const quietLogger = { info: () => {}, warn: () => {}, error: () => {} } as const;
const app = createApp({ logger: quietLogger });
const PASSWORD = 'password-123456';
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

let seq = 0;

interface SectFixture {
  api: TestClient;
  userId: string;
  sectId: string;
  sectName: string;
  discipleIds: string[];
  state: () => Promise<Record<string, any>>;
}

async function makeSect(prefix: string): Promise<SectFixture> {
  seq += 1;
  const account = `${prefix}-${seq}`;
  const api = new TestClient(app, env, {
    'cf-connecting-ip': `10.5.${Math.floor(seq / 250)}.${seq % 250}`,
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

/* ---------- 时间与库的直接读写 ---------- */

/** 以「今天的 UTC+8 日期」为第 0 天，取第 dayOffset 天 UTC+8 的 hour:minute。 */
function dayAt(dayOffset: number, hour: number, minute = 30): number {
  const parts = dateKeyUtc8(Date.now()).split('-').map(Number);
  return (
    Date.UTC(parts[0] ?? 1970, (parts[1] ?? 1) - 1, parts[2] ?? 1, hour - 8, minute) +
    dayOffset * DAY_MS
  );
}

/** 把结算时间拨到「第 dayOffset 天 23:59 之后」：用例里任何 now 之间的结算窗口都是 0。 */
async function freezeDay(sectId: string, dayOffset: number): Promise<void> {
  await env.DB.prepare('UPDATE sects SET last_settled_at = ? WHERE id = ?')
    .bind(dayAt(dayOffset, 23, 59) + 60_000, sectId)
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

async function ratesOf(fixture: SectFixture): Promise<Record<string, number>> {
  const state = await fixture.state();
  const rates: Record<string, number> = {};
  for (const resource of state.resources as { id: string; ratePerHour: string }[]) {
    rates[resource.id] = Number(resource.ratePerHour);
  }
  return rates;
}

/** 直接造一关（绕开出现逻辑，专测出手 / 连战 / 逃走 / 发奖）。 */
async function insertBoss(input: {
  dayKey: string;
  now: number;
  stage?: number;
  bossIndex?: number;
  affix?: string;
  roundDamage?: number;
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
       (id, day_key, stage, boss_index, affix, round_damage, max_hp, hp, status,
        killer_sect_id, half_announced, rewarded_at, created_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  )
    .bind(
      id,
      input.dayKey,
      input.stage ?? 1,
      input.bossIndex ?? 0,
      input.affix ?? 'ironclad',
      input.roundDamage ?? 30_000,
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

async function bossRow(dayKey: string, stage = 1): Promise<Record<string, any> | null> {
  return env.DB.prepare('SELECT * FROM world_bosses WHERE day_key = ? AND stage = ?')
    .bind(dayKey, stage)
    .first<Record<string, any>>();
}

async function countBossRows(dayKey: string): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS total FROM world_bosses WHERE day_key = ?')
    .bind(dayKey)
    .first<{ total: number }>();
  return Number(row?.total ?? 0);
}

async function hitsOf(bossId: string): Promise<Record<string, any>[]> {
  const result = await env.DB.prepare(
    'SELECT * FROM world_boss_hits WHERE boss_id = ? ORDER BY created_at ASC',
  )
    .bind(bossId)
    .all<Record<string, any>>();
  return result.results ?? [];
}

async function battleRows(sectId: string): Promise<Record<string, any>[]> {
  const result = await env.DB.prepare(
    'SELECT * FROM disciple_boss_battles WHERE sect_id = ? ORDER BY created_at ASC',
  )
    .bind(sectId)
    .all<Record<string, any>>();
  return result.results ?? [];
}

/** 直接塞疲劳记录（用来把「本次是这一小时第几次」推到目标档位）。 */
async function addBattles(sectId: string, discipleId: string, count: number, now: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await env.DB.prepare(
      'INSERT INTO disciple_boss_battles (id, disciple_id, sect_id, created_at) VALUES (?, ?, ?, ?)',
    )
      .bind(crypto.randomUUID(), discipleId, sectId, now - 60_000 * (index + 1))
      .run();
  }
}


async function discipleRow(discipleId: string): Promise<Record<string, any>> {
  const row = await env.DB.prepare('SELECT * FROM disciples WHERE id = ?')
    .bind(discipleId)
    .first<Record<string, any>>();
  expect(row).not.toBeNull();
  return row!;
}

async function systemMessages(): Promise<string[]> {
  const result = await env.DB.prepare(
    "SELECT content FROM chat_messages WHERE user_id = 'system'",
  ).all<{ content: string }>();
  return (result.results ?? []).map((row) => row.content);
}

async function countMessages(predicate: (text: string) => boolean): Promise<number> {
  return (await systemMessages()).filter(predicate).length;
}

/** 断言 Promise 抛出的业务错误（没有抛错时返回 null）。 */
async function errorCodeOf(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return (error as { code?: string }).code ?? 'UNKNOWN';
  }
}

async function errorDetailsOf(promise: Promise<unknown>): Promise<Record<string, unknown> | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    return (error as { details?: Record<string, unknown> }).details ?? null;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('世界 Boss 二期：出现（Cron）', () => {
  it('08:00 之前不出现；08:30 的 Cron 建出第 1 关（带词缀）并广播一次', async () => {
    const fixture = await makeSect('spawn');
    await freezeDay(fixture.sectId, 0);
    const dayKey = dateKeyUtc8(dayAt(0, 9));

    await processWorldBoss(env.DB, dayAt(0, 7));
    expect(await bossRow(dayKey, 1)).toBeNull();

    const spawns = await countMessages((text) => text.includes('降临'));
    await processWorldBoss(env.DB, dayAt(0, 8, 30));
    const row = (await bossRow(dayKey, 1))!;
    expect(row.status).toBe('active');
    expect(Number(row.stage)).toBe(1);
    expect(Number(row.boss_index)).toBe(bossIndexFor(dayIndexUtc8(dayAt(0, 8, 30)), 1));
    expect(['ironclad', 'swift', 'brute', 'eerie', 'berserk']).toContain(row.affix as string);
    // 血量 = max(10000, 一轮伤害 × 3)；这个宗门活跃着，所以一轮伤害 > 0
    const roundDamage = Number(row.round_damage);
    expect(roundDamage).toBeGreaterThan(0);
    expect(Number(row.max_hp)).toBe(Math.max(WORLD_BOSS_MIN_HP, roundDamage * WORLD_BOSS_ROUNDS_PER_STAGE));
    expect(Number(row.hp)).toBe(Number(row.max_hp));
    expect(Number(row.half_announced)).toBe(0);
    expect(row.rewarded_at).toBeNull();
    expect(row.ended_at).toBeNull();
    expect(await countMessages((text) => text.includes('降临'))).toBe(spawns + 1);

    // 再跑两次：day_key + stage 唯一 → 不重复建、不重复广播。
    await processWorldBoss(env.DB, dayAt(0, 12));
    await processWorldBoss(env.DB, dayAt(0, 18));
    expect(await countBossRows(dayKey)).toBe(1);
    expect(await countMessages((text) => text.includes('降临'))).toBe(spawns + 1);
  });

  it('补位：最新一关已击杀却没有下一关（如一期旧 Boss，round_damage = 0）→ Cron 生成下一关并重算一轮伤害', async () => {
    const fixture = await makeSect('catchup');
    await freezeDay(fixture.sectId, 60);
    const now = dayAt(60, 10);
    const dayKey = dateKeyUtc8(now);
    await insertBoss({ dayKey, now: dayAt(60, 9), status: 'killed', hp: 0, roundDamage: 0, rewardedAt: dayAt(60, 9) });

    await processWorldBoss(env.DB, now);
    const next = (await bossRow(dayKey, 2))!;
    expect(next.status).toBe('active');
    const roundDamage = Number(next.round_damage);
    expect(roundDamage).toBeGreaterThan(0);
    expect(Number(next.max_hp)).toBe(stageMaxHp(roundDamage, 2));

    // 有进行中的关卡时不再补位
    await processWorldBoss(env.DB, dayAt(60, 11));
    expect(await countBossRows(dayKey)).toBe(2);
  });
});

describe('世界 Boss 二期：面板', () => {
  it('面板给出关卡 / 词缀 / 冷却 / 疲劳 / 连斩数与最高纪录', async () => {
    const fixture = await makeSect('panel');
    const now = dayAt(3, 10);
    await freezeDay(fixture.sectId, 3);
    await insertBoss({
      dayKey: dateKeyUtc8(now),
      now,
      stage: 2,
      bossIndex: 1,
      affix: 'eerie',
      roundDamage: 20_000,
      maxHp: stageMaxHp(20_000, 2),
    });

    const panel = await getWorldBoss(env.DB, fixture.userId, now);
    expect(panel.boss.phase).toBe('open');
    expect(panel.boss.attackable).toBe(true);
    expect(panel.boss.cooldownSeconds).toBe(0);
    expect(panel.boss.fatigue).toEqual({});
    expect(panel.boss.boss).not.toBeNull();
    expect(panel.boss.boss!.stage).toBe(2);
    expect(panel.boss.boss!.def.displayName).toBe('第 2 关 · 赤炎火蛟');
    expect(panel.boss.boss!.affix).toEqual({
      id: 'eerie',
      name: '邪祟',
      effect: '暴击率翻倍',
      tip: '派幸运高的弟子',
      sortAttribute: 'luck',
    });
    expect(panel.boss.boss!.maxHp).toBe(stageMaxHp(20_000, 2));
    expect(panel.boss.ranks).toEqual([]);
    expect(panel.boss.hits).toEqual([]);
    expect(panel.boss.boss!.phase).toBe('open');
    // view 里的角标与面板一致
    expect(panel.state.worldBoss.attackable).toBe(true);

    // 早上没到 08:00：未出现 + 提示 08:00 降临
    const early = await getWorldBoss(env.DB, fixture.userId, dayAt(4, 7));
    expect(early.boss.phase).toBe('before');
    expect(early.boss.attackable).toBe(false);
    expect(early.boss.opensAt).toBe(dayStartMs(dayAt(4, 7)) + 8 * HOUR_MS);

    // 23:00 之后：closed、不能再出手
    const closed = await getWorldBoss(env.DB, fixture.userId, dayAt(3, 23));
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
    const strict = await fixture.api.post('/api/v1/game/world-boss/attack', {
      discipleIds: [fixture.discipleIds[0]!],
      extra: 1,
    });
    expect(strict.status).toBe(400);
  });
});

describe('世界 Boss 二期：出手', () => {
  it('出手写出手记录与疲劳记录、扣血，但不再发参与奖', async () => {
    const fixture = await makeSect('attack');
    const now = dayAt(5, 10);
    await freezeDay(fixture.sectId, 5);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const bossId = await insertBoss({ dayKey: dateKeyUtc8(now), now, affix: 'ironclad' });
    const member = fixture.discipleIds[0]!;
    const stoneBefore = await balanceOf(fixture.sectId, 'spiritStone');

    const result = await attackWorldBoss(env.DB, fixture.userId, { discipleIds: [member] }, now);
    expect(result.result.crit).toBe(false);
    expect(result.result.frenzy).toBe(false);
    expect(result.result.damage).toBeGreaterThan(0);
    expect(result.result.actualDamage).toBe(result.result.damage);
    expect(result.result.lastHit).toBe(false);
    expect(result.result.nextStage).toBeNull();
    expect(result.result.members).toEqual([
      { discipleId: member, discipleName: expect.any(String), outcome: 'normal' },
    ]);

    const row = (await bossRow(dateKeyUtc8(now), 1))!;
    expect(Number(row.hp)).toBe(1_000_000 - result.result.damage);

    const hits = await hitsOf(bossId);
    expect(hits).toHaveLength(1);
    expect(JSON.parse(hits[0]!.disciple_ids as string)).toEqual([member]);
    expect(JSON.parse(hits[0]!.injured_names as string)).toEqual([]);
    expect(JSON.parse(hits[0]!.severe_names as string)).toEqual([]);
    expect(Number(hits[0]!.damage)).toBe(result.result.damage);

    // 疲劳记录：本次出战的每名弟子各一行。
    expect((await battleRows(fixture.sectId)).length).toBe(1);

    // 二期取消参与奖：资源余额一分没动。
    expect(await balanceOf(fixture.sectId, 'spiritStone')).toBe(stoneBefore);

    // 面板：疲劳表、冷却、榜单
    expect(result.boss.fatigue[member]).toBe(1);
    expect(result.boss.cooldownSeconds).toBeGreaterThan(0);
    expect(result.boss.ranks).toHaveLength(1);
    expect(result.boss.ranks[0]!.isMe).toBe(true);
    expect(result.boss.hits).toHaveLength(1);
  });

  it('冷却 10 秒：拒绝时给出剩余秒数，过了就能再打', async () => {
    const fixture = await makeSect('cooldown');
    const now = dayAt(6, 10);
    await freezeDay(fixture.sectId, 6);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    await insertBoss({ dayKey: dateKeyUtc8(now), now });
    const discipleIds = [fixture.discipleIds[0]!];
    await attackWorldBoss(env.DB, fixture.userId, { discipleIds }, now);

    const details = await errorDetailsOf(
      attackWorldBoss(env.DB, fixture.userId, { discipleIds }, now + 3_000),
    );
    expect(details).not.toBeNull();
    expect(Number(details!.remainingSeconds)).toBe(7);
    expect(
      await errorCodeOf(attackWorldBoss(env.DB, fixture.userId, { discipleIds }, now + 3_000)),
    ).toBe('COOLDOWN_ACTIVE');

    // 冷却结束后照常出手
    const ok = await attackWorldBoss(
      env.DB,
      fixture.userId,
      { discipleIds },
      now + WORLD_BOSS_COOLDOWN_MS,
    );
    expect(ok.result.damage).toBeGreaterThan(0);
    expect(ok.boss.hits).toHaveLength(2);
    expect(ok.boss.fatigue[discipleIds[0]!]).toBe(2);
  });

  it('疲劳 3 次起会重伤：这一刀不计伤害、写库、广播、之后不能再出战', async () => {
    const fixture = await makeSect('severe');
    const now = dayAt(7, 10);
    await freezeDay(fixture.sectId, 7);
    const member = fixture.discipleIds[0]!;
    await insertBoss({ dayKey: dateKeyUtc8(now), now });
    // 这一小时已经出战 3 次 → 本次的重伤概率 30%
    await addBattles(fixture.sectId, member, 3, now);
    // 第 1 个随机数给重伤判定（0.01 < 0.3 → 重伤），之后给伤害的浮动与暴击
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const before = await countMessages((text) => text.includes('重创'));
    const result = await attackWorldBoss(env.DB, fixture.userId, { discipleIds: [member] }, now);
    expect(result.result.members).toEqual([
      { discipleId: member, discipleName: expect.any(String), outcome: 'severe' },
    ]);
    // 全员重伤 → 伤害 0，但记录照写
    expect(result.result.damage).toBe(0);
    expect(result.result.actualDamage).toBe(0);
    expect((await bossRow(dateKeyUtc8(now), 1))!.hp).toBe(1_000_000);

    const row = await discipleRow(member);
    expect(Number(row.severe_injured_until)).toBeGreaterThanOrEqual(now + SEVERE_INJURY_MS - 1000);
    const hits = await hitsOf((await bossRow(dateKeyUtc8(now), 1))!.id as string);
    expect(JSON.parse(hits[0]!.severe_names as string)).toHaveLength(1);
    expect(await countMessages((text) => text.includes('重创'))).toBe(before + 1);
    expect(result.boss.fatigue[member]).toBe(4);

    // 重伤之后不能再出战（走的是阶段一的统一拦截）
    expect(
      await errorCodeOf(
        attackWorldBoss(env.DB, fixture.userId, { discipleIds: [member] }, now + 60_000),
      ),
    ).toBe('INVALID_STATUS');
  });

  it('普通受伤写 injured_until（30 分钟），伤害照常计算', async () => {
    const fixture = await makeSect('injured');
    const now = dayAt(8, 10);
    await freezeDay(fixture.sectId, 8);
    const member = fixture.discipleIds[0]!;
    await insertBoss({ dayKey: dateKeyUtc8(now), now });
    // 第 1 个随机数给重伤（疲劳 0 → 概率 0，不会重伤），第 2 个给受伤（0.01 < 8% → 受伤）
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const result = await attackWorldBoss(env.DB, fixture.userId, { discipleIds: [member] }, now);
    expect(result.result.members[0]!.outcome).toBe('injured');
    expect(result.result.damage).toBeGreaterThan(0);
    const row = await discipleRow(member);
    expect(Number(row.injured_until)).toBeGreaterThanOrEqual(now + WORLD_BOSS_INJURY_DURATION_MS - 1000);
    expect(Number(row.severe_injured_until) || 0).toBe(0);
  });

  it('「狂暴」让重伤概率翻倍：同样的随机数在铁甲下不算重伤', async () => {
    const berserkFixture = await makeSect('berserk');
    const ironcladFixture = await makeSect('ironclad');
    const berserkNow = dayAt(9, 10);
    const ironcladNow = dayAt(12, 10);
    await freezeDay(berserkFixture.sectId, 9);
    await freezeDay(ironcladFixture.sectId, 12);
    const berserkMember = berserkFixture.discipleIds[0]!;
    const ironcladMember = ironcladFixture.discipleIds[0]!;
    // 两个宗门各自打自己那一天的关卡（day_key + stage 唯一，不能共用同一天）。
    await insertBoss({ dayKey: dateKeyUtc8(berserkNow), now: berserkNow, affix: 'berserk' });
    await insertBoss({ dayKey: dateKeyUtc8(ironcladNow), now: ironcladNow, affix: 'ironclad' });
    await addBattles(berserkFixture.sectId, berserkMember, 3, berserkNow);
    await addBattles(ironcladFixture.sectId, ironcladMember, 3, ironcladNow);
    // 体魄固定在 50：狂暴档 30% × 2 = 60%，铁甲档只有 30%（弟子体魄是随机的，必须钉住）。
    await env.DB.prepare('UPDATE disciples SET physique = 50 WHERE id = ?').bind(berserkMember).run();
    await env.DB.prepare('UPDATE disciples SET physique = 50 WHERE id = ?').bind(ironcladMember).run();

    // 0.5 < 0.6（狂暴 30%×2）→ 重伤
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const berserkResult = await attackWorldBoss(
      env.DB,
      berserkFixture.userId,
      { discipleIds: [berserkMember] },
      berserkNow,
    );
    expect(berserkResult.result.members[0]!.outcome).toBe('severe');

    // 同样的 0.5，铁甲档只有 30% → 不重伤
    vi.restoreAllMocks();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const ironcladResult = await attackWorldBoss(
      env.DB,
      ironcladFixture.userId,
      { discipleIds: [ironcladMember] },
      ironcladNow,
    );
    expect(ironcladResult.result.members[0]!.outcome).toBe('normal');
  });
});

describe('世界 Boss 二期：连战', () => {
  it('打死立刻开下一关（血量 ×1.6、换 Boss 与词缀），且不会重复生成', async () => {
    const fixture = await makeSect('chain');
    const now = dayAt(10, 10);
    await freezeDay(fixture.sectId, 10);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const dayKey = dateKeyUtc8(now);
    await insertBoss({ dayKey, now, stage: 1, hp: 100, maxHp: 1_000_000, roundDamage: 20_000 });
    const before = await countMessages((text) => text.includes('一击斩落'));

    const result = await attackWorldBoss(
      env.DB,
      fixture.userId,
      { discipleIds: [fixture.discipleIds[0]!] },
      now,
    );
    expect(result.result.lastHit).toBe(true);
    expect(result.result.nextStage).toBe(2);
    expect(result.result.bossHp).toBe(0);

    // 第 2 关：换 Boss、换词缀、血量 = 一轮伤害 × 6
    const stage2 = (await bossRow(dayKey, 2))!;
    expect(stage2.status).toBe('active');
    expect(Number(stage2.max_hp)).toBe(stageMaxHp(20_000, 2));
    expect(Number(stage2.boss_index)).toBe(bossIndexFor(dayIndexUtc8(now), 2));
    expect(Number(stage2.round_damage)).toBe(20_000);
    // 面板直接切到新关卡
    expect(result.boss.boss!.stage).toBe(2);
    expect(result.boss.boss!.status).toBe('active');
    expect(result.boss.killedToday).toBe(1);
    expect(result.boss.bestStage).toBe(1);

    // 广播：击杀 + 下一关降临
    expect(await countMessages((text) => text.includes('一击斩落'))).toBe(before + 1);
    expect(await countMessages((text) => text.includes('已降临'))).toBe(1);

    // Cron 不会重复建：今天已经有第 1 关，也有第 2 关
    await processWorldBoss(env.DB, dayAt(10, 12));
    expect(await countBossRows(dayKey)).toBe(2);
  });

  it('22:30 力竭期打死仍然会立刻开下一关（伤害 ×1.5）', async () => {
    const fixture = await makeSect('chain-late');
    const now = dayAt(11, 22, 30);
    await freezeDay(fixture.sectId, 11);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const dayKey = dateKeyUtc8(now);
    await insertBoss({ dayKey, now, stage: 1, hp: 100, maxHp: 1_000_000, roundDamage: 20_000 });

    const result = await attackWorldBoss(
      env.DB,
      fixture.userId,
      { discipleIds: [fixture.discipleIds[0]!] },
      now,
    );
    expect(result.result.frenzy).toBe(true);
    expect(result.result.lastHit).toBe(true);
    expect(result.result.nextStage).toBe(2);
    expect((await bossRow(dayKey, 2))!.status).toBe('active');
  });
});

describe('世界 Boss 二期：Cron 逃走与发奖', () => {
  it('击杀发奖：基础份 × 关卡系数 × 排名倍数 + 丹药 + 最后一击，且只发一次', async () => {
    const fixture = await makeSect('reward');
    const now = dayAt(20, 10);
    await freezeDay(fixture.sectId, 20);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const dayKey = dateKeyUtc8(now);
    const rates = await ratesOf(fixture);

    await insertBoss({ dayKey, now, stage: 2, hp: 100, maxHp: 1_000_000, roundDamage: 20_000 });
    const killed = await attackWorldBoss(
      env.DB,
      fixture.userId,
      { discipleIds: [fixture.discipleIds[0]!] },
      now,
    );
    expect(killed.result.lastHit).toBe(true);
    // 连战会顺手开出第 3 关，把它挪走以免干扰发奖断言
    await env.DB.prepare('DELETE FROM world_bosses WHERE day_key = ? AND stage = 3')
      .bind(dayKey)
      .run();

    const before = {
      spiritStone: await balanceOf(fixture.sectId, 'spiritStone'),
      herb: await balanceOf(fixture.sectId, 'herb'),
      ore: await balanceOf(fixture.sectId, 'ore'),
      cultivationPill: await pillCount(fixture.sectId, 'cultivationPill'),
      bodyTemperingPill: await pillCount(fixture.sectId, 'bodyTemperingPill'),
    };

    const rewardNotices = await countMessages((text) => text.includes('讨伐奖励已发放'));
    await processWorldBoss(env.DB, dayAt(20, 14));
    const noticesAfterReward = await countMessages((text) => text.includes('讨伐奖励已发放'));
    expect(noticesAfterReward).toBeGreaterThan(rewardNotices);

    // 只有一个参与宗门 → 排名 1（×1.5），第 2 关（×1.2）：factor = 1.8
    const factor = stageRewardMultiplier(2) * rankRewardMultiplier(1);
    const share = (rate: number): number =>
      Math.floor(Math.max(rate * WORLD_BOSS_KILL_POOL_RATE_FACTOR, rewardFloor(1)) * factor);
    const lastHit = Math.floor(
      Math.max((rates.spiritStone ?? 0) * WORLD_BOSS_LAST_HIT_RATE_FACTOR, rewardFloor(1)) * stageRewardMultiplier(2),
    );

    expect((await balanceOf(fixture.sectId, 'spiritStone')) - before.spiritStone).toBe(
      share(rates.spiritStone ?? 0) + lastHit,
    );
    expect((await balanceOf(fixture.sectId, 'herb')) - before.herb).toBe(share(rates.herb ?? 0));
    expect((await balanceOf(fixture.sectId, 'ore')) - before.ore).toBe(share(rates.ore ?? 0));
    expect((await pillCount(fixture.sectId, 'cultivationPill')) - before.cultivationPill).toBe(1);
    expect((await pillCount(fixture.sectId, 'bodyTemperingPill')) - before.bodyTemperingPill).toBe(1);
    expect((await bossRow(dayKey, 2))!.rewarded_at).not.toBeNull();

    // 再跑两次 Cron：rewarded_at 已写 → 不再发
    await processWorldBoss(env.DB, dayAt(20, 15));
    await processWorldBoss(env.DB, dayAt(20, 16));
    expect(await countMessages((text) => text.includes('讨伐奖励已发放'))).toBe(noticesAfterReward);
    expect(await pillCount(fixture.sectId, 'cultivationPill')).toBe(before.cultivationPill + 1);
    expect(await balanceOf(fixture.sectId, 'herb')).toBe(before.herb + share(rates.herb ?? 0));
  });

  it('排名倍数按「对该关的总伤害」分配：伤害高的拿 ×1.5', async () => {
    const first = await makeSect('rank-a');
    const second = await makeSect('rank-b');
    const now = dayAt(30, 10);
    await freezeDay(first.sectId, 30);
    await freezeDay(second.sectId, 30);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const dayKey = dateKeyUtc8(now);
    const ratesA = await ratesOf(first);
    const ratesB = await ratesOf(second);

    // 两个宗门打同一关：A 派 1 人、B 派 3 人。把血量压到「A 打完之后只剩 1 点」，
    // B 的那一刀必定打死，而且 B 的总伤害（= A 的伤害 + 1）一定高于 A → B 排名第 1。
    const bossId = await insertBoss({ dayKey, now, maxHp: 10_000_000, roundDamage: 20_000 });
    const firstHit = await attackWorldBoss(
      env.DB,
      first.userId,
      { discipleIds: [first.discipleIds[0]!] },
      now,
    );
    await env.DB.prepare('UPDATE world_bosses SET hp = ? WHERE id = ?')
      .bind(firstHit.result.actualDamage + 1, bossId)
      .run();
    const killing = await attackWorldBoss(
      env.DB,
      second.userId,
      { discipleIds: second.discipleIds.slice(0, 3) },
      now,
    );
    expect(killing.result.lastHit).toBe(true);

    const beforeA = {
      spiritStone: await balanceOf(first.sectId, 'spiritStone'),
      herb: await balanceOf(first.sectId, 'herb'),
    };
    const beforeB = {
      spiritStone: await balanceOf(second.sectId, 'spiritStone'),
      herb: await balanceOf(second.sectId, 'herb'),
    };

    // 连战会开出第 2 关，删掉它以免 Cron 把它一起处理
    await env.DB.prepare('DELETE FROM world_bosses WHERE day_key = ? AND stage = 2')
      .bind(dayKey)
      .run();
    await processWorldBoss(env.DB, dayAt(30, 14));

    const factorA = stageRewardMultiplier(1) * rankRewardMultiplier(2);
    const factorB = stageRewardMultiplier(1) * rankRewardMultiplier(1);
    const shareOf = (rate: number, factor: number): number =>
      Math.floor(Math.max(rate * WORLD_BOSS_KILL_POOL_RATE_FACTOR, rewardFloor(1)) * factor);

    expect((await balanceOf(first.sectId, 'herb')) - beforeA.herb).toBe(
      shareOf(ratesA.herb ?? 0, factorA),
    );
    expect((await balanceOf(second.sectId, 'herb')) - beforeB.herb).toBe(
      shareOf(ratesB.herb ?? 0, factorB),
    );
    // 只有伤害第 1 名的 B 拿淬体丹；聚气丹两个宗门各一颗
    expect(await pillCount(first.sectId, 'cultivationPill')).toBe(1);
    expect(await pillCount(second.sectId, 'cultivationPill')).toBe(1);
    expect(await pillCount(first.sectId, 'bodyTemperingPill')).toBe(0);
    expect(await pillCount(second.sectId, 'bodyTemperingPill')).toBe(1);
    // 最后一击奖只给最后一击的宗门（B），灵石会比 A 多出这一份
    const lastHit = Math.floor(
      Math.max((ratesB.spiritStone ?? 0) * WORLD_BOSS_LAST_HIT_RATE_FACTOR, rewardFloor(1)) * stageRewardMultiplier(1),
    );
    expect((await balanceOf(second.sectId, 'spiritStone')) - beforeB.spiritStone).toBe(
      shareOf(ratesB.spiritStone ?? 0, factorB) + lastHit,
    );
    expect((await balanceOf(first.sectId, 'spiritStone')) - beforeA.spiritStone).toBe(
      shareOf(ratesA.spiritStone ?? 0, factorA),
    );
  });

  it('击退（≥70%）资源减半、没有丹药与最后一击', async () => {
    const fixture = await makeSect('repel');
    const now = dayAt(40, 10);
    await freezeDay(fixture.sectId, 40);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const dayKey = dateKeyUtc8(now);
    const rates = await ratesOf(fixture);

    const bossId = await insertBoss({ dayKey, now, maxHp: 1_000_000, roundDamage: 20_000 });
    await attackWorldBoss(env.DB, fixture.userId, { discipleIds: [fixture.discipleIds[0]!] }, now);
    // 模拟「打到剩 20%」再等到 23:00
    await env.DB.prepare('UPDATE world_bosses SET hp = 200000 WHERE id = ?').bind(bossId).run();

    const before = {
      spiritStone: await balanceOf(fixture.sectId, 'spiritStone'),
      herb: await balanceOf(fixture.sectId, 'herb'),
      cultivationPill: await pillCount(fixture.sectId, 'cultivationPill'),
      bodyTemperingPill: await pillCount(fixture.sectId, 'bodyTemperingPill'),
    };

    await processWorldBoss(env.DB, dayAt(40, 23));
    const row = (await bossRow(dayKey, 1))!;
    expect(row.status).toBe('fled');
    expect(row.rewarded_at).not.toBeNull();

    const panel = await getWorldBoss(env.DB, fixture.userId, dayAt(40, 23));
    expect(panel.boss.boss!.fledOutcome).toBe('repelled');

    const halved = (rate: number): number =>
      Math.floor(
        Math.max(rate * WORLD_BOSS_KILL_POOL_RATE_FACTOR, rewardFloor(1)) *
          stageRewardMultiplier(1) *
          rankRewardMultiplier(1) *
          0.5,
      );
    expect((await balanceOf(fixture.sectId, 'herb')) - before.herb).toBe(halved(rates.herb ?? 0));
    expect((await balanceOf(fixture.sectId, 'spiritStone')) - before.spiritStone).toBe(
      halved(rates.spiritStone ?? 0),
    );
    expect(await pillCount(fixture.sectId, 'cultivationPill')).toBe(before.cultivationPill);
    expect(await pillCount(fixture.sectId, 'bodyTemperingPill')).toBe(before.bodyTemperingPill);
  });

  it('不足 70% 逃走：什么也不发', async () => {
    const fixture = await makeSect('escape');
    const now = dayAt(41, 10);
    await freezeDay(fixture.sectId, 41);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const dayKey = dateKeyUtc8(now);

    await insertBoss({ dayKey, now, maxHp: 1_000_000, roundDamage: 20_000 });
    await attackWorldBoss(env.DB, fixture.userId, { discipleIds: [fixture.discipleIds[0]!] }, now);

    const before = {
      spiritStone: await balanceOf(fixture.sectId, 'spiritStone'),
      herb: await balanceOf(fixture.sectId, 'herb'),
      cultivationPill: await pillCount(fixture.sectId, 'cultivationPill'),
    };
    await processWorldBoss(env.DB, dayAt(41, 23));
    const row = (await bossRow(dayKey, 1))!;
    expect(row.status).toBe('fled');
    expect(row.rewarded_at).not.toBeNull();
    expect(Number(row.hp)).toBeGreaterThan(Number(row.max_hp) * 0.3);

    expect(await balanceOf(fixture.sectId, 'spiritStone')).toBe(before.spiritStone);
    expect(await balanceOf(fixture.sectId, 'herb')).toBe(before.herb);
    expect(await pillCount(fixture.sectId, 'cultivationPill')).toBe(before.cultivationPill);
  });

  it('Cron 顺带清理 2 天前的疲劳记录', async () => {
    const fixture = await makeSect('cleanup');
    const now = dayAt(50, 10);
    await freezeDay(fixture.sectId, 50);
    const member = fixture.discipleIds[0]!;

    await env.DB.prepare(
      'INSERT INTO disciple_boss_battles (id, disciple_id, sect_id, created_at) VALUES (?, ?, ?, ?)',
    )
      .bind(crypto.randomUUID(), member, fixture.sectId, now - 3 * DAY_MS)
      .run();
    await addBattles(fixture.sectId, member, 1, now);
    expect((await battleRows(fixture.sectId)).length).toBe(2);

    await processWorldBoss(env.DB, now);
    const left = await battleRows(fixture.sectId);
    expect(left).toHaveLength(1);
    expect(Number(left[0]!.created_at)).toBeGreaterThan(now - 2 * DAY_MS);
  });
});
