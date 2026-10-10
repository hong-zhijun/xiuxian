import { applyD1Migrations, env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

import { GAME_CONFIG_CONTENT } from '@xiuxian/game-config';

import { createApp } from '../src/app';
import { dateKeyUtc8, effectiveCapacity, findSectLevel } from '../src/modules/game/constants';
import { DEBATE_DAILY_LIMIT } from '../src/modules/game/gambling';
import { toMinUnits } from '../src/modules/game/shop';
import {
  STONE_OUTCOME_IDS,
  STONE_PITY_BUSTS,
  STONE_TIERS,
  type StoneOutcomeId,
  type StoneTierDef,
} from '../src/modules/game/stoneGamble';

import { dataOf, errorOf, TestClient, type ApiResult } from './support/authClient';

/**
 * 赌石（0046 / 0047 迁移 + stoneGamble.ts + POST /game/stone-gamble；记录并入赌坊记录 dao_debate_log）：
 * 赌坊第四个玩法（docs/赌石开发计划.md 第 3.2 节）。
 *
 * 存储说明：本文件一份独立内存 D1，没有逐用例回滚 —— 每个用例用独立账号 / 宗门，
 * 涉及余额与记录的断言都按宗门 id 定界。
 *
 * 确定性说明：切石前先把结算时间拨到未来（零产出零事件），余额断言才精确。抽取随机（Math.random），
 * 因此多数断言只针对与结果无关的不变量（块数、花费、玄铁 = 结果换算、保底推进）；
 * 需要确定结果的用例（保底、天价播报）用 vi.spyOn(Math, 'random') 固定随机值：
 * 0 落在第一项（垮了，保底生效后是小涨），0.999 落在最后一项（天价）。
 */

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

const quietLogger = { info: () => {}, warn: () => {}, error: () => {} } as const;
const app = createApp({ logger: quietLogger });
const PASSWORD = 'password-123456';

let seq = 0;

interface SectFixture {
  api: TestClient;
  sectId: string;
  state: () => Promise<Record<string, any>>;
}

interface StoneLogRow {
  id: string;
  sect_id: string;
  tier: string;
  count: number;
  pay_resource: string;
  cost: number;
  xuantie: number;
  result: string;
  bust_count: number;
  small_count: number;
  big_count: number;
  jackpot_count: number;
  created_at: number;
}

/** 注册 + 建宗门；返回宗门 id 与同步读取函数（赌石与弟子无关，不需要弟子 id）。 */
async function makeSect(prefix: string): Promise<SectFixture> {
  seq += 1;
  const account = `${prefix}-${seq}`;
  const api = new TestClient(app, env, {
    'cf-connecting-ip': `10.9.${Math.floor(seq / 250)}.${seq % 250}`,
  });
  const registered = await api.post('/api/v1/auth/register', { account, password: PASSWORD });
  expect(registered.status).toBe(200);
  const created = await api.post('/api/v1/game/create-sect', { name: `赌石${seq}号` });
  expect(created.status).toBe(200);
  const state = dataOf(created) as Record<string, any>;
  return {
    api,
    sectId: state.state.sect.id as string,
    state: async () => {
      const result = await api.get('/api/v1/game/sync');
      expect(result.status).toBe(200);
      return (dataOf(result) as Record<string, any>).state;
    },
  };
}

/** 把结算时间拨到未来：请求内的结算变成零产出零事件，余额断言才精确。 */
async function freezeSettlement(sectId: string): Promise<void> {
  await env.DB.prepare('UPDATE sects SET last_settled_at = ? WHERE id = ?')
    .bind(Date.now() + 60_000, sectId)
    .run();
}

/** 宗门等级（直接写库，与 gambling.test.ts 同款）。 */
async function setSectLevel(sectId: string, level: number): Promise<void> {
  await env.DB.prepare('UPDATE sects SET level = ? WHERE id = ?').bind(level, sectId).run();
}

/** 把某项资源余额写成一个确定值（没有余额行时补一行，与 shop.test.ts 同款）。 */
async function setBalance(sectId: string, resourceId: string, balance: number): Promise<void> {
  const updated = await env.DB.prepare(
    'UPDATE resource_balances SET balance = ? WHERE sect_id = ? AND resource_id = ?',
  )
    .bind(balance, sectId, resourceId)
    .run();
  if (Number(updated.meta.changes) > 0) {
    return;
  }
  await env.DB.prepare(
    `INSERT INTO resource_balances (id, sect_id, resource_id, balance, remainder, updated_at)
     VALUES (?, ?, ?, ?, 0, ?)`,
  )
    .bind(crypto.randomUUID(), sectId, resourceId, balance, Date.now())
    .run();
}

async function balanceOf(sectId: string, resourceId: string): Promise<number | null> {
  const row = await env.DB.prepare(
    'SELECT balance FROM resource_balances WHERE sect_id = ? AND resource_id = ?',
  )
    .bind(sectId, resourceId)
    .first<{ balance: number }>();
  return row === null ? null : Number(row.balance);
}

/** 直接写某宗门某档的连续垮了次数（绝对值 upsert，与服务端写回同口径）。 */
async function setBusts(sectId: string, tierId: string, busts: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO stone_gamble_busts (sect_id, tier, busts, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (sect_id, tier)
     DO UPDATE SET busts = excluded.busts, updated_at = excluded.updated_at`,
  )
    .bind(sectId, tierId, busts, Date.now())
    .run();
}

async function bustsOf(sectId: string, tierId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT busts FROM stone_gamble_busts WHERE sect_id = ? AND tier = ?')
    .bind(sectId, tierId)
    .first<{ busts: number }>();
  return row === null ? 0 : Number(row.busts);
}

/** 赌坊记录里本宗的赌石行（bet_mode = 'stone'），把 JSON 明细摊平成便于断言的形状。 */
async function logRowsOf(sectId: string): Promise<StoneLogRow[]> {
  const result = await env.DB.prepare(
    `SELECT id, sect_id, multiplier, result, stake_detail, reward_detail, created_at
     FROM dao_debate_log WHERE sect_id = ? AND bet_mode = 'stone' ORDER BY created_at ASC`,
  )
    .bind(sectId)
    .all<{ id: string; sect_id: string; multiplier: number; result: string; stake_detail: string; reward_detail: string; created_at: number }>();
  return result.results.map((row) => {
    const stake = JSON.parse(row.stake_detail) as { resourceId: string; amount: string; tier: string };
    const reward = JSON.parse(row.reward_detail) as { amount: string; counts: Record<StoneOutcomeId, number> };
    return {
      id: row.id,
      sect_id: row.sect_id,
      tier: stake.tier,
      count: Number(row.multiplier),
      pay_resource: stake.resourceId,
      cost: Number(stake.amount),
      xuantie: Number(reward.amount),
      result: row.result,
      bust_count: reward.counts.bust,
      small_count: reward.counts.small,
      big_count: reward.counts.big,
      jackpot_count: reward.counts.jackpot,
      created_at: Number(row.created_at),
    };
  });
}

async function logCountOf(sectId: string): Promise<number> {
  return (await logRowsOf(sectId)).length;
}

async function chatCountOf(content: string): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE content = ?')
    .bind(content)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/** 1 级宗门（无建筑）下某项资源的容量：配置基础容量 × 等级倍率（与服务端校验同一口径，单位最小单位）。 */
function capacityAtLevel(resourceId: string, level: number): number {
  const definition = GAME_CONFIG_CONTENT.resources.find((resource) => resource.id === resourceId);
  expect(definition, `配置里必须有 ${resourceId}`).toBeTruthy();
  return effectiveCapacity(definition!.capacity, findSectLevel(level).capacityMultiplier);
}

function tierDefOf(tierId: string): StoneTierDef {
  const tier = STONE_TIERS.find((item) => item.id === tierId);
  if (tier === undefined) {
    throw new Error(`缺少档位 ${tierId}`);
  }
  return tier;
}

/** 玄铁（展示单位）= Σ 各结果块数 × 该结果的固定个数：只依赖计划表，与随机结果无关。 */
function xuantieFromCounts(tierId: string, counts: Record<StoneOutcomeId, number>): number {
  const tier = tierDefOf(tierId);
  return STONE_OUTCOME_IDS.reduce(
    (sum, id) => sum + counts[id] * tier.outcomes.find((item) => item.id === id)!.xuantie,
    0,
  );
}

/** 结果序列数出各结果块数（与服务端返回的 counts 应当一致）。 */
function countsOf(outcomes: readonly string[]): Record<StoneOutcomeId, number> {
  const counts: Record<StoneOutcomeId, number> = { bust: 0, small: 0, big: 0, jackpot: 0 };
  for (const outcome of outcomes) {
    counts[outcome as StoneOutcomeId] += 1;
  }
  return counts;
}

/** 保底推进（与 stoneGamble.ts 的 nextStoneBusts 同一规则）：按结果序列逐块推进。 */
function bustsAfter(start: number, outcomes: readonly string[]): number {
  return outcomes.reduce(
    (busts, outcome) => (outcome === 'bust' ? Math.min(STONE_PITY_BUSTS, busts + 1) : 0),
    start,
  );
}

/** 固定 Math.random 的返回值执行一段请求，结束后恢复。 */
async function withRandom<T>(value: number, body: () => Promise<T>): Promise<T> {
  const spy = vi.spyOn(Math, 'random').mockReturnValue(value);
  try {
    return await body();
  } finally {
    spy.mockRestore();
  }
}

function stone(sect: SectFixture, body: Record<string, unknown>): Promise<ApiResult> {
  return sect.api.post('/api/v1/game/stone-gamble', body);
}

/* ---------- 解锁与门槛（计划 1.1 / 1.4） ---------- */

describe('赌石：解锁与门槛', () => {
  it('1 级宗门（赌坊未开）：stones 为 null，切石 INVALID_STATUS，余额与记录都不变', async () => {
    const sect = await makeSect('stn-locked');
    await freezeSettlement(sect.sectId);
    await setBalance(sect.sectId, 'spiritStone', 1_000_000);

    expect((await sect.state()).gambling.stones).toBeNull();

    const rejected = await stone(sect, { tier: 'gravel', payResource: 'spiritStone', count: 1 });
    expect(rejected.status).toBe(409);
    expect(errorOf(rejected).code).toBe('INVALID_STATUS');
    expect(errorOf(rejected).message).toContain('赌坊尚未开启');
    expect(await balanceOf(sect.sectId, 'spiritStone')).toBe(1_000_000);
    expect(await logCountOf(sect.sectId)).toBe(0);
  });

  it('2 级宗门：四档全部下发，天外陨石未解锁并给出门槛文案；买天外陨石 INVALID_STATUS', async () => {
    const sect = await makeSect('stn-lvl2');
    await setSectLevel(sect.sectId, 2);
    await freezeSettlement(sect.sectId);
    await setBalance(sect.sectId, 'spiritStone', 100_000_000);

    const stones = (await sect.state()).gambling.stones as Record<string, any>;
    expect(stones.tiers.map((tier: Record<string, any>) => [tier.id, tier.unlocked])).toEqual([
      ['gravel', true],
      ['mountain', true],
      ['oldPit', true],
      ['meteor', false],
    ]);
    expect(stones.tiers[0].blockedReason).toBeNull();
    expect(stones.tiers[3].blockedReason).toBe('天外陨石需要宗门 6 级');

    const before = await balanceOf(sect.sectId, 'spiritStone');
    const rejected = await stone(sect, { tier: 'meteor', payResource: 'spiritStone', count: 1 });
    expect(rejected.status).toBe(409);
    expect(errorOf(rejected).code).toBe('INVALID_STATUS');
    expect(errorOf(rejected).message).toBe('天外陨石需要宗门 6 级');
    expect(await balanceOf(sect.sectId, 'spiritStone')).toBe(before);
    expect(await logCountOf(sect.sectId)).toBe(0);
  });

  it('6 级宗门可以切天外陨石：扣 1000 万最小单位灵石（10000 灵石）', async () => {
    const sect = await makeSect('stn-lvl6');
    await setSectLevel(sect.sectId, 6);
    await freezeSettlement(sect.sectId);
    await setBalance(sect.sectId, 'spiritStone', 100_000_000);
    await setBalance(sect.sectId, 'xuantie', 0);

    const cut = await stone(sect, { tier: 'meteor', payResource: 'spiritStone', count: 1 });
    expect(cut.status).toBe(200);
    const payload = dataOf(cut) as Record<string, any>;
    expect(payload.result).toMatchObject({ tier: 'meteor', tierName: '天外陨石', count: 1, cost: 10_000_000 });
    expect(await balanceOf(sect.sectId, 'spiritStone')).toBe(100_000_000 - 10_000_000);
  });
});

/* ---------- 三种支付（计划 1.3 / 3.2） ---------- */

describe('赌石：三种支付', () => {
  it('灵石买碎石：扣 价格 × 1000，玄铁 + result.xuantie，写一条记录，返回的 state 同步变化', async () => {
    const sect = await makeSect('stn-pay-stone');
    await setSectLevel(sect.sectId, 2);
    await freezeSettlement(sect.sectId);
    await setBalance(sect.sectId, 'spiritStone', 1_000_000);
    await setBalance(sect.sectId, 'xuantie', 0);

    const cut = await stone(sect, { tier: 'gravel', payResource: 'spiritStone', count: 1 });
    expect(cut.status).toBe(200);
    const payload = dataOf(cut) as Record<string, any>;
    expect(payload.result).toMatchObject({
      tier: 'gravel',
      tierName: '碎石',
      count: 1,
      payResource: 'spiritStone',
      cost: 150_000,
    });
    expect(payload.result.outcomes).toHaveLength(1);
    expect(payload.result.xuantie).toBe(toMinUnits(xuantieFromCounts('gravel', payload.result.counts)));

    expect(await balanceOf(sect.sectId, 'spiritStone')).toBe(1_000_000 - 150_000);
    expect(await balanceOf(sect.sectId, 'xuantie')).toBe(payload.result.xuantie);
    const xuantieView = (payload.state.resources as Record<string, any>[]).find((item) => item.id === 'xuantie');
    expect(xuantieView?.balance).toBe(String(payload.result.xuantie));

    const rows = await logRowsOf(sect.sectId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tier: 'gravel',
      count: 1,
      pay_resource: 'spiritStone',
      cost: 150_000,
      xuantie: payload.result.xuantie,
    });
  });

  it('药材买山料：按卖出价折算，扣 价格 × 2000 最小单位（500 灵石 = 100 万最小单位药材）', async () => {
    const sect = await makeSect('stn-pay-herb');
    await setSectLevel(sect.sectId, 2);
    await freezeSettlement(sect.sectId);
    await setBalance(sect.sectId, 'herb', 5_000_000);
    await setBalance(sect.sectId, 'xuantie', 0);

    const cut = await stone(sect, { tier: 'mountain', payResource: 'herb', count: 1 });
    expect(cut.status).toBe(200);
    const payload = dataOf(cut) as Record<string, any>;
    expect(payload.result).toMatchObject({ tier: 'mountain', payResource: 'herb', cost: 1_000_000 });
    expect(await balanceOf(sect.sectId, 'herb')).toBe(5_000_000 - 1_000_000);
    expect(await balanceOf(sect.sectId, 'xuantie')).toBe(payload.result.xuantie);
    expect((await logRowsOf(sect.sectId))[0]).toMatchObject({ pay_resource: 'herb', cost: 1_000_000 });
  });

  it('矿石买老坑料：扣 4000000 最小单位矿石（2000 灵石按卖出价折算）', async () => {
    const sect = await makeSect('stn-pay-ore');
    await setSectLevel(sect.sectId, 2);
    await freezeSettlement(sect.sectId);
    await setBalance(sect.sectId, 'ore', 5_000_000);
    await setBalance(sect.sectId, 'xuantie', 0);

    const cut = await stone(sect, { tier: 'oldPit', payResource: 'ore', count: 1 });
    expect(cut.status).toBe(200);
    const payload = dataOf(cut) as Record<string, any>;
    expect(payload.result).toMatchObject({ tier: 'oldPit', payResource: 'ore', cost: 4_000_000 });
    expect(await balanceOf(sect.sectId, 'ore')).toBe(5_000_000 - 4_000_000);
    expect(await balanceOf(sect.sectId, 'xuantie')).toBe(payload.result.xuantie);
  });
});

/* ---------- 连切 10 块（计划 1.4 / 3.2） ---------- */

describe('赌石：连切 10 块', () => {
  it('连切 10 块：扣 10 倍；counts 之和 = 10；玄铁 = 各块结果换算；只写一行记录', async () => {
    const sect = await makeSect('stn-ten');
    await setSectLevel(sect.sectId, 2);
    await freezeSettlement(sect.sectId);
    await setBalance(sect.sectId, 'spiritStone', 10_000_000);
    await setBalance(sect.sectId, 'xuantie', 0);

    const cut = await stone(sect, { tier: 'gravel', payResource: 'spiritStone', count: 10 });
    expect(cut.status).toBe(200);
    const payload = dataOf(cut) as Record<string, any>;
    const result = payload.result as Record<string, any>;

    expect(result.outcomes).toHaveLength(10);
    expect(result.counts).toEqual(countsOf(result.outcomes));
    expect(Object.values(result.counts as Record<string, number>).reduce((sum, value) => sum + value, 0)).toBe(10);
    expect(result.cost).toBe(1_500_000);
    expect(result.message).toContain('切开 10 块碎石');
    expect(result.xuantie).toBe(toMinUnits(xuantieFromCounts('gravel', result.counts)));

    expect(await balanceOf(sect.sectId, 'spiritStone')).toBe(10_000_000 - 1_500_000);
    expect(await balanceOf(sect.sectId, 'xuantie')).toBe(result.xuantie);

    const rows = await logRowsOf(sect.sectId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      count: 10,
      cost: 1_500_000,
      xuantie: result.xuantie,
      bust_count: result.counts.bust,
      small_count: result.counts.small,
      big_count: result.counts.big,
      jackpot_count: result.counts.jackpot,
    });
  });
});

/* ---------- 余额与玄铁容量（计划 1.3 / 1.4 / 3.2） ---------- */

describe('赌石：余额与玄铁容量', () => {
  it('余额不足：INSUFFICIENT_RESOURCE，余额不变，没有记录', async () => {
    const sect = await makeSect('stn-poor');
    await setSectLevel(sect.sectId, 2);
    await freezeSettlement(sect.sectId);
    await setBalance(sect.sectId, 'spiritStone', 1_499_999);
    await setBalance(sect.sectId, 'xuantie', 0);

    const rejected = await stone(sect, { tier: 'gravel', payResource: 'spiritStone', count: 10 });
    expect(rejected.status).toBe(409);
    const error = errorOf(rejected);
    expect(error.code).toBe('INSUFFICIENT_RESOURCE');
    expect(error.details?.resourceId).toBe('spiritStone');
    expect(await balanceOf(sect.sectId, 'spiritStone')).toBe(1_499_999);
    expect(await balanceOf(sect.sectId, 'xuantie')).toBe(0);
    expect(await logCountOf(sect.sectId)).toBe(0);
  });

  it('玄铁容量装不下一块天价：切石与连切都拒绝（CAPACITY_FULL），余额与记录不变', async () => {
    const sect = await makeSect('stn-full');
    await setSectLevel(sect.sectId, 2);
    await freezeSettlement(sect.sectId);
    await setBalance(sect.sectId, 'spiritStone', 10_000_000);
    const capacity = capacityAtLevel('xuantie', 2);
    // 剩余 9999 最小单位；碎石天价 10 玄铁 = 10000 最小单位 → 一块都装不下。
    await setBalance(sect.sectId, 'xuantie', capacity - 9_999);

    for (const count of [1, 10]) {
      const rejected = await stone(sect, { tier: 'gravel', payResource: 'spiritStone', count });
      expect(rejected.status).toBe(409);
      const error = errorOf(rejected);
      expect(error.code).toBe('CAPACITY_FULL');
      expect(error.details?.resourceId).toBe('xuantie');
      expect(error.details?.capacity).toBe(String(capacity));
      expect(error.details?.balance).toBe(String(capacity - 9_999));
      expect(error.details?.room).toBe('0');
      expect(error.message).toContain('装不下一块碎石的天价 10 个');
    }

    expect(await balanceOf(sect.sectId, 'spiritStone')).toBe(10_000_000);
    expect(await balanceOf(sect.sectId, 'xuantie')).toBe(capacity - 9_999);
    expect(await logCountOf(sect.sectId)).toBe(0);
  });

  it('容量只够 1 块天价：连切 10 照常通过，整批入账可以顶过容量', async () => {
    const sect = await makeSect('stn-room');
    await setSectLevel(sect.sectId, 2);
    await freezeSettlement(sect.sectId);
    await setBalance(sect.sectId, 'spiritStone', 10_000_000);
    const capacity = capacityAtLevel('xuantie', 2);
    await setBalance(sect.sectId, 'xuantie', capacity - 10_000);

    // 固定随机值 0.999：每块都是天价（10 个），10 块共 100 个，远超剩余的 10 个空位。
    const spy = vi.spyOn(Math, 'random').mockReturnValue(0.999);
    try {
      const result = await stone(sect, { tier: 'gravel', payResource: 'spiritStone', count: 10 });
      expect(result.status).toBe(200);
      const data = dataOf(result) as Record<string, any>;
      expect(data.result.xuantie).toBe(100_000);
    } finally {
      spy.mockRestore();
    }
    expect(await balanceOf(sect.sectId, 'xuantie')).toBe(capacity - 10_000 + 100_000);
    expect(await logCountOf(sect.sectId)).toBe(1);
  });
});

/* ---------- 非法参数（计划 3.2） ---------- */

/** 赌坊今日已用次数（直接写库，与 gambling.test.ts 同款）。 */
async function setDebateUsed(sectId: string, used: number): Promise<void> {
  await env.DB.prepare('UPDATE sects SET debate_date_key = ?, debate_count = ? WHERE id = ?')
    .bind(dateKeyUtc8(Date.now()), used, sectId)
    .run();
}

async function debateUsedOf(sectId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT debate_count FROM sects WHERE id = ?')
    .bind(sectId)
    .first<{ debate_count: number }>();
  return Number(row!.debate_count);
}

/* ---------- 赌坊每日次数 ---------- */

describe('赌石：赌坊每日次数', () => {
  it('每切一块占 1 次：切石 +1、连切 10 块 +10，返回的 state 同步', async () => {
    const sect = await makeSect('stn-day');
    await setSectLevel(sect.sectId, 2);
    await freezeSettlement(sect.sectId);
    await setBalance(sect.sectId, 'spiritStone', 10_000_000);
    await setDebateUsed(sect.sectId, 3);

    const single = await stone(sect, { tier: 'gravel', payResource: 'spiritStone', count: 1 });
    expect(single.status).toBe(200);
    expect(await debateUsedOf(sect.sectId)).toBe(4);

    const batch = await stone(sect, { tier: 'gravel', payResource: 'spiritStone', count: 10 });
    expect(batch.status).toBe(200);
    expect(await debateUsedOf(sect.sectId)).toBe(14);
    const data = dataOf(batch) as Record<string, any>;
    expect(data.state.gambling.usedToday).toBe(14);
    expect(data.state.gambling.remaining).toBe(DEBATE_DAILY_LIMIT - 14);
  });

  it('次数用完：DAILY_LIMIT，不扣钱、不写记录、不加计数', async () => {
    const sect = await makeSect('stn-day-out');
    await setSectLevel(sect.sectId, 2);
    await freezeSettlement(sect.sectId);
    await setBalance(sect.sectId, 'spiritStone', 10_000_000);
    await setDebateUsed(sect.sectId, DEBATE_DAILY_LIMIT);

    const rejected = await stone(sect, { tier: 'gravel', payResource: 'spiritStone', count: 1 });
    expect(rejected.status).toBe(409);
    expect(errorOf(rejected).code).toBe('DAILY_LIMIT');
    expect(await balanceOf(sect.sectId, 'spiritStone')).toBe(10_000_000);
    expect(await logCountOf(sect.sectId)).toBe(0);
    expect(await debateUsedOf(sect.sectId)).toBe(DEBATE_DAILY_LIMIT);
  });

  it('只剩 5 次：连切 10 块整批拒绝，切 1 块照常', async () => {
    const sect = await makeSect('stn-day-few');
    await setSectLevel(sect.sectId, 2);
    await freezeSettlement(sect.sectId);
    await setBalance(sect.sectId, 'spiritStone', 10_000_000);
    await setDebateUsed(sect.sectId, DEBATE_DAILY_LIMIT - 5);

    const rejected = await stone(sect, { tier: 'gravel', payResource: 'spiritStone', count: 10 });
    expect(rejected.status).toBe(409);
    const error = errorOf(rejected);
    expect(error.code).toBe('DAILY_LIMIT');
    expect(error.message).toContain('只剩 5 次');
    expect(await logCountOf(sect.sectId)).toBe(0);

    const single = await stone(sect, { tier: 'gravel', payResource: 'spiritStone', count: 1 });
    expect(single.status).toBe(200);
    expect(await debateUsedOf(sect.sectId)).toBe(DEBATE_DAILY_LIMIT - 4);
  });
});

describe('赌石：非法参数', () => {
  it('count = 2、未知档位、payResource = xuantie、多余字段都返回 400，且不动任何数据', async () => {
    const sect = await makeSect('stn-invalid');
    await setSectLevel(sect.sectId, 2);
    await freezeSettlement(sect.sectId);
    await setBalance(sect.sectId, 'spiritStone', 10_000_000);
    await setBalance(sect.sectId, 'xuantie', 0);

    const bodies: Record<string, unknown>[] = [
      { tier: 'gravel', payResource: 'spiritStone', count: 2 },
      { tier: 'unknownStone', payResource: 'spiritStone', count: 1 },
      { tier: 'gravel', payResource: 'xuantie', count: 1 },
      { tier: 'gravel', payResource: 'spiritStone', count: 1, amount: 1 },
    ];
    for (const body of bodies) {
      const rejected = await stone(sect, body);
      expect(rejected.status).toBe(400);
      expect(errorOf(rejected).code).toBe('VALIDATION_ERROR');
    }

    expect(await balanceOf(sect.sectId, 'spiritStone')).toBe(10_000_000);
    expect(await balanceOf(sect.sectId, 'xuantie')).toBe(0);
    expect(await logCountOf(sect.sectId)).toBe(0);
  });
});

/* ---------- 隐藏保底（计划 1.5 / 3.2） ---------- */

describe('赌石：隐藏保底', () => {
  it('保底次数已到 10：下一块不出「垮了」，并把次数清零（读表断言）', async () => {
    const sect = await makeSect('stn-pity');
    await setSectLevel(sect.sectId, 2);
    await freezeSettlement(sect.sectId);
    await setBalance(sect.sectId, 'spiritStone', 10_000_000);
    await setBalance(sect.sectId, 'xuantie', 0);
    await setBusts(sect.sectId, 'mountain', STONE_PITY_BUSTS);

    const cut = await stone(sect, { tier: 'mountain', payResource: 'spiritStone', count: 1 });
    expect(cut.status).toBe(200);
    const payload = dataOf(cut) as Record<string, any>;
    expect(payload.result.outcomes[0]).not.toBe('bust');
    expect(payload.result.counts.bust).toBe(0);
    expect(await bustsOf(sect.sectId, 'mountain')).toBe(0);
    // 保底不进任何接口返回：响应里不出现次数字段或相关文案。
    expect(JSON.stringify(payload)).not.toMatch(/busts|保底/);
  });

  it('连续垮 10 次：固定随机值下，第 11 块被保底排除「垮了」（小涨为第一项）', async () => {
    const sect = await makeSect('stn-pity-seq');
    await setSectLevel(sect.sectId, 2);
    await freezeSettlement(sect.sectId);
    await setBalance(sect.sectId, 'spiritStone', 10_000_000);
    await setBalance(sect.sectId, 'xuantie', 0);

    // 随机值 0 → 每块都落在第一项「垮了」：连切 10 块全部垮了，次数写到 10。
    const first = await withRandom(0, () => stone(sect, { tier: 'gravel', payResource: 'spiritStone', count: 10 }));
    expect(first.status).toBe(200);
    expect((dataOf(first) as Record<string, any>).result.counts).toEqual({ bust: 10, small: 0, big: 0, jackpot: 0 });
    expect(await bustsOf(sect.sectId, 'gravel')).toBe(STONE_PITY_BUSTS);

    // 第 11 块：保底排除垮了，剩下三项的第一项是小涨。
    const second = await withRandom(0, () => stone(sect, { tier: 'gravel', payResource: 'spiritStone', count: 1 }));
    expect(second.status).toBe(200);
    expect((dataOf(second) as Record<string, any>).result.outcomes).toEqual(['small']);
    expect(await bustsOf(sect.sectId, 'gravel')).toBe(0);
  });

  it('连切 10 块时次数逐块推进：写回的次数 = 按本次结果序列推进的结果（与随机无关）', async () => {
    const sect = await makeSect('stn-busts-walk');
    await setSectLevel(sect.sectId, 2);
    await freezeSettlement(sect.sectId);
    await setBalance(sect.sectId, 'spiritStone', 10_000_000);
    await setBalance(sect.sectId, 'xuantie', 0);
    await setBusts(sect.sectId, 'gravel', 7);

    const cut = await stone(sect, { tier: 'gravel', payResource: 'spiritStone', count: 10 });
    expect(cut.status).toBe(200);
    const result = (dataOf(cut) as Record<string, any>).result as Record<string, any>;
    expect(await bustsOf(sect.sectId, 'gravel')).toBe(bustsAfter(7, result.outcomes as string[]));
  });
});

/* ---------- 记录与历史（计划 1.7 / 3.2） ---------- */

describe('赌石：并入赌坊记录', () => {
  it('每次请求写一行赌坊记录（bet_mode = stone）；赌坊记录接口能看到，灵石花费计入战绩净值', async () => {
    const sect = await makeSect('stn-history');
    await setSectLevel(sect.sectId, 2);
    await freezeSettlement(sect.sectId);
    await setBalance(sect.sectId, 'spiritStone', 10_000_000);
    await setBalance(sect.sectId, 'herb', 10_000_000);
    await setBalance(sect.sectId, 'xuantie', 0);

    expect((await stone(sect, { tier: 'gravel', payResource: 'spiritStone', count: 1 })).status).toBe(200);
    // 间隔一毫秒以上，保证两条记录的时间戳不同（排序断言才确定）。
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await stone(sect, { tier: 'mountain', payResource: 'herb', count: 10 })).status).toBe(200);

    const rows = await logRowsOf(sect.sectId);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.result).toBe(row.xuantie > 0 ? 'win' : 'lose');
    }

    const history = await sect.api.get('/api/v1/game/debate-history?page=1');
    expect(history.status).toBe(200);
    const page = dataOf(history) as Record<string, any>;
    const entries = page.entries as Record<string, any>[];
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ betMode: 'stone', discipleName: '赌石', multiplier: 10 });
    expect(JSON.parse(entries[0]!.stakeDetail as string)).toMatchObject({
      resourceId: 'herb',
      amount: '10000000',
      tier: 'mountain',
      tierName: '山料',
      count: 10,
    });
    expect(JSON.parse(entries[1]!.stakeDetail as string)).toMatchObject({ resourceId: 'spiritStone', amount: '150000', tierName: '碎石' });
    expect(JSON.parse(entries[1]!.rewardDetail as string)).toMatchObject({ type: 'resource', resourceId: 'xuantie' });

    // 战绩净灵石：只有灵石付的那一块计入（-150 灵石），药材付款与玄铁奖励都不算灵石。
    expect(page.stats.total).toBe(2);
    expect(page.stats.netSpiritStone).toBe(-150_000);
  });
});

/* ---------- 面板数据（计划 2.6 / 3.2） ---------- */

describe('赌石：面板数据', () => {
  it('2 级宗门：四档价格 / 期望 / 天价 / 概率齐全，材料换算 2；1 级宗门为 null', async () => {
    const sect = await makeSect('stn-panel');
    await setSectLevel(sect.sectId, 2);
    const stones = (await sect.state()).gambling.stones as Record<string, any>;

    expect(stones.materialPerStone).toBe(2);
    expect(stones.tiers.map((tier: Record<string, any>) => tier.price)).toEqual([150, 500, 2000, 10_000]);
    expect(stones.tiers.map((tier: Record<string, any>) => tier.expectedXuantie)).toEqual([1.02, 4.25, 17.05, 82.5]);
    expect(stones.tiers.map((tier: Record<string, any>) => tier.topPrize)).toEqual([10, 40, 160, 800]);
    for (const tier of stones.tiers as Record<string, any>[]) {
      expect(tier.outcomes.reduce((sum: number, item: Record<string, any>) => sum + item.chanceBp, 0)).toBe(10_000);
      expect(tier.outcomes.map((item: Record<string, any>) => item.name)).toEqual(['垮了', '小涨', '大涨', '天价']);
    }
    // 保底次数不进面板。
    expect(JSON.stringify(stones)).not.toMatch(/busts|保底/);

    const low = await makeSect('stn-panel-low');
    expect((await low.state()).gambling.stones).toBeNull();
  });
});

/* ---------- 全服播报（计划 1.6 / 3.2） ---------- */

describe('赌石：全服播报', () => {
  it('每开出一块天价播一条（commit 之后）：固定随机值 0.999 时连切 10 块播 10 条；垮了不播', async () => {
    const sect = await makeSect('stn-jackpot');
    await setSectLevel(sect.sectId, 2);
    await freezeSettlement(sect.sectId);
    await setBalance(sect.sectId, 'spiritStone', 10_000_000);
    await setBalance(sect.sectId, 'xuantie', 0);
    const sectName = (await sect.state()).sect.name as string;
    const content = `【赌石】${sectName}切开一块碎石，开出天价玄铁 ×10！`;
    const before = await chatCountOf(content);

    // 随机值 0.999 落在最后一项：碎石每块都是天价（10 玄铁）。
    const cut = await withRandom(0.999, () => stone(sect, { tier: 'gravel', payResource: 'spiritStone', count: 10 }));
    expect(cut.status).toBe(200);
    const result = (dataOf(cut) as Record<string, any>).result as Record<string, any>;
    expect(result.counts).toEqual({ bust: 0, small: 0, big: 0, jackpot: 10 });
    expect(result.xuantie).toBe(toMinUnits(100));
    expect(await chatCountOf(content)).toBe(before + 10);

    // 随机值 0 → 全部垮了（保底还没到），不播报。
    const quiet = await withRandom(0, () => stone(sect, { tier: 'gravel', payResource: 'spiritStone', count: 1 }));
    expect(quiet.status).toBe(200);
    expect(await chatCountOf(content)).toBe(before + 10);
  });
});
