import { applyD1Migrations, env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app';
import {
  DEBATE_DAILY_LIMIT,
  RACE_BET_MAX,
  RACE_BET_MIN,
  RACE_HORSE_COUNT,
  RACE_LOG_NAME,
  RACE_STEP_COUNT,
} from '../src/modules/game/gambling';

import { dataOf, errorOf, TestClient } from './support/authClient';

/**
 * 赛马（0023 迁移：放宽 dao_debate_log.multiplier + docs/赛马开发计划.md）。
 *
 * 存储说明：本文件一份独立内存 D1，没有逐用例回滚 —— 每个用例用独立账号/宗门（前缀递增），
 * 计数与余额断言都按宗门 id 定界。
 *
 * 确定性说明：
 * - 结算时间拨到未来（时钟回拨 → 零产出零事件），余额变化才只可能来自被断言的那一局；
 * - Math.random 被替换成**固定队列**：前 5 个值决定 5 匹马的权重（1 + floor(r × 5)），
 *   第 6 个值决定冠军（按权重加权），之后的值是动画抖动（0.5 = 不抖）。
 *   于是「押谁、赔率多少、赢还是输」全部可预期；
 * - stub 只在赛马请求期间生效，建宗门 / 冻结结算都用真实随机（stub 在 afterEach 里恢复）。
 */

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

const quietLogger = { info: () => {}, warn: () => {}, error: () => {} } as const;
const app = createApp({ logger: quietLogger });
const PASSWORD = 'password-123456';

/** 今天的 UTC+8 日期键（与 constants.dateKeyUtc8 同口径）。 */
const TODAY = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);

let seq = 0;

interface SectFixture {
  api: TestClient;
  sectId: string;
  state: () => Promise<Record<string, any>>;
  race: (horseIndex: number, betAmount: number) => Promise<Awaited<ReturnType<TestClient['post']>>>;
}

async function makeSect(prefix: string): Promise<SectFixture> {
  seq += 1;
  const api = new TestClient(app, env, {
    'cf-connecting-ip': `10.17.${Math.floor(seq / 250)}.${seq % 250}`,
  });
  const registered = await api.post('/api/v1/auth/register', {
    account: `${prefix}-${seq}`,
    password: PASSWORD,
  });
  expect(registered.status).toBe(200);
  const created = await api.post('/api/v1/game/create-sect', { name: `赛马${String(seq)}号` });
  expect(created.status).toBe(200);
  const state = dataOf(created) as Record<string, any>;

  return {
    api,
    sectId: state.state.sect.id as string,
    state: async () => {
      const result = await api.get('/api/v1/game/sync');
      expect(result.status).toBe(200);
      return (dataOf(result) as Record<string, any>).state as Record<string, any>;
    },
    race: (horseIndex, betAmount) =>
      api.post('/api/v1/game/horse-race', { horseIndex, betAmount }),
  };
}

/* ---------- 库与随机的测试辅助 ---------- */

/** 把结算时间拨到未来：请求内的结算变成零产出零事件，余额断言才精确。 */
async function freezeSettlement(sectId: string): Promise<void> {
  await env.DB.prepare('UPDATE sects SET last_settled_at = ? WHERE id = ?')
    .bind(Date.now() + 60_000, sectId)
    .run();
}

/** 宗门升到赌坊解锁线（2 级）。 */
async function unlockGambling(sectId: string): Promise<void> {
  await env.DB.prepare('UPDATE sects SET level = 2 WHERE id = ?').bind(sectId).run();
}

/** 把灵石余额写成一个确定值（没有余额行时补一行）。 */
async function setSpiritStone(sectId: string, balance: number): Promise<void> {
  const updated = await env.DB.prepare(
    'UPDATE resource_balances SET balance = ? WHERE sect_id = ? AND resource_id = ?',
  )
    .bind(balance, sectId, 'spiritStone')
    .run();
  if (Number(updated.meta.changes) > 0) return;
  await env.DB.prepare(
    `INSERT INTO resource_balances (id, sect_id, resource_id, balance, remainder, updated_at)
     VALUES (?, ?, ?, ?, 0, ?)`,
  )
    .bind(crypto.randomUUID(), sectId, 'spiritStone', balance, Date.now())
    .run();
}

async function spiritStoneOf(sectId: string): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT balance FROM resource_balances WHERE sect_id = ? AND resource_id = ?',
  )
    .bind(sectId, 'spiritStone')
    .first<{ balance: number }>();
  return Number(row?.balance ?? -1);
}

async function debateCounter(sectId: string): Promise<{ key: string; count: number }> {
  const row = await env.DB.prepare(
    'SELECT debate_date_key, debate_count FROM sects WHERE id = ?',
  )
    .bind(sectId)
    .first<{ debate_date_key: string; debate_count: number }>();
  return { key: row?.debate_date_key ?? '', count: Number(row?.debate_count ?? 0) };
}

async function debateLogs(sectId: string): Promise<Record<string, any>[]> {
  const rows = await env.DB.prepare(
    'SELECT * FROM dao_debate_log WHERE sect_id = ? ORDER BY created_at ASC',
  )
    .bind(sectId)
    .all<Record<string, any>>();
  return rows.results ?? [];
}

/** 全服系统广播（user_id = 'system'）。 */
async function systemMessages(): Promise<Record<string, any>[]> {
  const rows = await env.DB.prepare(
    "SELECT * FROM chat_messages WHERE user_id = 'system' ORDER BY created_at ASC",
  ).all<Record<string, any>>();
  return rows.results ?? [];
}

/**
 * 替换 Math.random 为固定队列：先按顺序吐出 values，用完后一直返回 fallback。
 * 权重 = 1 + floor(r × 5)：0.05 → 1、0.85 → 5。
 */
function stubRandom(values: number[], fallback = 0.5): void {
  // 同一个用例里第二次调用（例如先转轮再赛马）时先撤掉上一次的 spy，避免两层 spy 叠加。
  vi.restoreAllMocks();
  const queue = [...values];
  vi.spyOn(Math, 'random').mockImplementation(() =>
    queue.length > 0 ? (queue.shift() as number) : fallback,
  );
}

/**
 * 一局的随机队列：权重 5 次 + 冠军 1 次，前面还要留出**结算事件**的那一次消耗
 * （events.ts 的 triggerEvents 即使零时长也会摇一次 `random() < fractional`）。
 * 队列用完后的 fallback 0.5 落在动画抖动上（0.5 = 不抖），所以不必逐个列 35 次。
 */
function raceRandom(weights: number[], winnerRoll: number): number[] {
  return [0.5, ...weights, winnerRoll];
}

afterEach(() => {
  vi.restoreAllMocks();
});

/* ---------- 解锁与校验 ---------- */

describe('赛马：解锁与参数校验', () => {
  it('宗门未到 2 级：拒绝（INVALID_STATUS），不写记录、不扣次数', async () => {
    const sect = await makeSect('race-locked');
    await setSpiritStone(sect.sectId, 1_000_000);
    await freezeSettlement(sect.sectId);

    const result = await sect.race(0, RACE_BET_MIN);

    expect(errorOf(result).code).toBe('INVALID_STATUS');
    expect(await debateLogs(sect.sectId)).toHaveLength(0);
    expect((await debateCounter(sect.sectId)).count).toBe(0);
    expect(await spiritStoneOf(sect.sectId)).toBe(1_000_000);
  });

  it('赌注越界（低于下限 / 高于上限）与越界的马号都由 schema 挡下（VALIDATION_ERROR）', async () => {
    const sect = await makeSect('race-bad-input');
    await unlockGambling(sect.sectId);
    await setSpiritStone(sect.sectId, 10_000_000);
    await freezeSettlement(sect.sectId);

    for (const bad of [
      { horseIndex: 0, betAmount: RACE_BET_MIN - 1 },
      { horseIndex: 0, betAmount: RACE_BET_MAX + 1 },
      { horseIndex: 0, betAmount: 0 },
      { horseIndex: RACE_HORSE_COUNT, betAmount: RACE_BET_MIN },
      { horseIndex: -1, betAmount: RACE_BET_MIN },
    ]) {
      const result = await sect.api.post('/api/v1/game/horse-race', bad);
      expect(errorOf(result).code, `非法请求应被拒：${JSON.stringify(bad)}`).toBe(
        'VALIDATION_ERROR',
      );
    }
    // 一条记录都没写、次数也没动
    expect(await debateLogs(sect.sectId)).toHaveLength(0);
    expect((await debateCounter(sect.sectId)).count).toBe(0);
  });

  it('灵石不足：拒绝且不消耗次数、不写记录（余额差 1 个最小单位也拦得住）', async () => {
    const sect = await makeSect('race-poor');
    await unlockGambling(sect.sectId);
    await setSpiritStone(sect.sectId, RACE_BET_MIN - 1);
    await freezeSettlement(sect.sectId);

    const result = await sect.race(0, RACE_BET_MIN);

    expect(errorOf(result).code).toBe('INSUFFICIENT_RESOURCE');
    expect(await spiritStoneOf(sect.sectId)).toBe(RACE_BET_MIN - 1);
    expect(await debateLogs(sect.sectId)).toHaveLength(0);
    expect((await debateCounter(sect.sectId)).count).toBe(0);
  });

  it('每日次数用尽：DAILY_LIMIT（与论道 / 天机轮共享同一列）', async () => {
    const sect = await makeSect('race-daily-limit');
    await unlockGambling(sect.sectId);
    await setSpiritStone(sect.sectId, 1_000_000);
    await env.DB.prepare('UPDATE sects SET debate_date_key = ?, debate_count = ? WHERE id = ?')
      .bind(TODAY, DEBATE_DAILY_LIMIT, sect.sectId)
      .run();
    await freezeSettlement(sect.sectId);

    const result = await sect.race(0, RACE_BET_MIN);

    expect(errorOf(result).code).toBe('DAILY_LIMIT');
    expect(await spiritStoneOf(sect.sectId)).toBe(1_000_000);
    expect(await debateLogs(sect.sectId)).toHaveLength(0);
  });
});

/* ---------- 一局的完整结算 ---------- */

describe('赛马：一局的结算与记录', () => {
  it('输：恰好扣赌注、次数 +1、记录里存赔率×10 与 { type: none }，且不广播', async () => {
    const sect = await makeSect('race-lose');
    await unlockGambling(sect.sectId);
    await setSpiritStone(sect.sectId, 1_000_000);
    await freezeSettlement(sect.sectId);

    // 权重 [5,5,5,5,1]（总 21），冠军 roll 0.99 → target 20.79 落在最后一匹（最弱的那匹）
    stubRandom(raceRandom([0.85, 0.85, 0.85, 0.85, 0.05], 0.99));
    const bet = 100_000;
    const result = await sect.race(0, bet);

    expect(result.status).toBe(200);
    const body = dataOf(result) as Record<string, any>;
    const race = body.result as Record<string, any>;

    // 押的是第 0 匹（赔率 3.8），冠军是第 4 匹 → 输
    expect(race.result).toBe('lose');
    expect(race.winnerIndex).toBe(4);
    expect(race.selectedIndex).toBe(0);
    expect(race.odds).toBe(3.8);
    expect(race.rewardAmount).toBe('0');

    // 余额恰好少一个赌注
    expect(await spiritStoneOf(sect.sectId)).toBe(1_000_000 - bet);
    // 视图与库一致
    const state = await sect.state();
    expect(Number(state.resources.find((item: any) => item.id === 'spiritStone').balance)).toBe(
      1_000_000 - bet,
    );

    // 次数 +1（与论道 / 天机轮同一列）
    const counter = await debateCounter(sect.sectId);
    expect(counter.key).toBe(TODAY);
    expect(counter.count).toBe(1);

    // 记录：disciple_id = ''、disciple_name = '赛马'、multiplier = 赔率 × 10、reward = none
    const logs = await debateLogs(sect.sectId);
    expect(logs).toHaveLength(1);
    const log = logs[0]!;
    expect(log.bet_mode).toBe('horse_race');
    expect(log.disciple_id).toBe('');
    expect(log.disciple_name).toBe(RACE_LOG_NAME);
    expect(log.result).toBe('lose');
    expect(Number(log.multiplier)).toBe(38);
    expect(JSON.parse(log.reward_detail)).toEqual({ type: 'none' });
    expect(JSON.parse(log.stake_detail)).toEqual({
      amount: String(bet),
      horseIndex: 0,
      horseName: '赤兔',
      odds: 3.8,
    });
    expect(Number(log.win_probability)).toBeCloseTo(5 / 21, 10);

    // 赔率没到大奖线，也没有广播
    expect(await systemMessages()).toHaveLength(0);
  });

  it('赢：发奖 = floor(赌注 × 赔率)，记录写 resource 奖励；冷门（≥8x）触发全服广播', async () => {
    const sect = await makeSect('race-win');
    await unlockGambling(sect.sectId);
    await setSpiritStone(sect.sectId, 1_000_000);
    await freezeSettlement(sect.sectId);

    // 权重 [1,5,5,5,5]（总 21），冠军 roll 0.01 → target 0.21 落在最弱的第 0 匹（赔率 18.9 = 冷门）
    stubRandom(raceRandom([0.05, 0.85, 0.85, 0.85, 0.85], 0.01));
    const bet = 100_000;
    // 与 service 同一口径：+1e-6 抵消 double 误差（100000 × 18.9 会算成 1889999.9999999998）
    const reward = Math.floor(bet * 18.9 + 1e-6);
    const result = await sect.race(0, bet);

    expect(result.status).toBe(200);
    const body = dataOf(result) as Record<string, any>;
    const race = body.result as Record<string, any>;
    expect(race.result).toBe('win');
    expect(race.winnerIndex).toBe(0);
    expect(race.odds).toBe(18.9);
    expect(race.rewardAmount).toBe(String(reward));

    // 计划第 5 节：赌注无条件扣（步骤 11），赢时再按赔率发奖（步骤 9）→ 净入 = 奖金 − 赌注。
    // 这样庄家抽水恰好是 10%：EV = p × (赔率 − 1) − (1 − p) = p × 赔率 − 1 = −0.1。
    expect(await spiritStoneOf(sect.sectId)).toBe(1_000_000 - bet + reward);

    const logs = await debateLogs(sect.sectId);
    expect(logs[0]!.result).toBe('win');
    expect(Number(logs[0]!.multiplier)).toBe(189);
    expect(JSON.parse(logs[0]!.reward_detail)).toEqual({
      type: 'resource',
      resourceId: 'spiritStone',
      amount: String(reward),
    });

    // 冷门广播（计划 2.6）：赔率 ≥ 8 且押中 → 一条系统消息
    const messages = await systemMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0]!.sect_name).toBe('系统');
    expect(String(messages[0]!.content)).toContain('赛马');
    expect(String(messages[0]!.content)).toContain('押中冷门赤兔');
    expect(String(messages[0]!.content)).toContain('18.9x');
  });

  it('响应里的动画数据自洽：5 匹马 × 8 步、名次是 1~5 的排列、冠军名次为 1', async () => {
    const sect = await makeSect('race-payload');
    await unlockGambling(sect.sectId);
    await setSpiritStone(sect.sectId, 1_000_000);
    await freezeSettlement(sect.sectId);

    stubRandom(raceRandom([0.05, 0.85, 0.85, 0.85, 0.85], 0.01));
    const body = dataOf(await sect.race(2, RACE_BET_MIN)) as Record<string, any>;
    const race = body.result as Record<string, any>;

    expect(race.horses).toHaveLength(RACE_HORSE_COUNT);
    expect(race.ranks).toHaveLength(RACE_HORSE_COUNT);
    expect([...race.ranks].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(race.ranks[race.winnerIndex]).toBe(1);
    expect(race.steps).toHaveLength(RACE_HORSE_COUNT);
    for (const series of race.steps) {
      expect(series).toHaveLength(RACE_STEP_COUNT);
    }
    // 冠军的最后一步是 1.0（前端动画终点对齐名次的依据）
    expect(race.steps[race.winnerIndex][RACE_STEP_COUNT - 1]).toBe(1);
    // 押中的赔率与 horses 里那匹一致
    expect(race.odds).toBe(race.horses[2].odds);
    expect(typeof race.message).toBe('string');
  });

  it('与天机轮共享次数列：先转一次轮、再赛一局 → 计数为 2', async () => {
    const sect = await makeSect('race-shared-counter');
    await unlockGambling(sect.sectId);
    await setSpiritStone(sect.sectId, 1_000_000);
    await freezeSettlement(sect.sectId);

    stubRandom([0.5]);
    const spun = await sect.api.post('/api/v1/game/wheel-spin', { tier: 1 });
    expect(spun.status).toBe(200);
    // 转盘落到哪一格由权重随机决定（这里只关心它消耗了 1 次），以转完之后的余额为基线。
    const balanceAfterWheel = await spiritStoneOf(sect.sectId);

    stubRandom(raceRandom([0.05, 0.85, 0.85, 0.85, 0.85], 0.01));
    await freezeSettlement(sect.sectId);
    const raced = await sect.race(0, RACE_BET_MIN);
    expect(raced.status).toBe(200);
    // 赛马这一局押中 18.9x：先扣赌注、再发奖（净 = 奖金 − 赌注）
    expect(await spiritStoneOf(sect.sectId)).toBe(
      balanceAfterWheel - RACE_BET_MIN + Math.floor(RACE_BET_MIN * 18.9 + 1e-6),
    );

    // 两个玩法写的是同一列计数：轮 1 次 + 赛 1 次 = 2
    expect((await debateCounter(sect.sectId)).count).toBe(2);
    const logs = await debateLogs(sect.sectId);
    expect(logs.map((row) => row.bet_mode)).toEqual(['wheel', 'horse_race']);
  });
});
