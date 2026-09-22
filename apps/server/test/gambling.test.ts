import { applyD1Migrations, env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app';
import { DAO_INSIGHT_CAP, DEBATE_DAILY_LIMIT } from '../src/modules/game/gambling';

import {
  gamblingSnapshotGuardStatement,
  type DiscipleRow,
  type ResourceBalanceRow,
  type SectRow,
} from '../src/modules/game/repository';

import { dataOf, errorOf, TestClient, type ApiResult } from './support/authClient';

/**
 * 赌坊（0019 迁移 + gambling.ts）：论道赌局与悟道值加点。
 *
 * 存储说明：本文件一份独立内存 D1，没有逐用例回滚 —— 每个用例用独立账号/宗门
 * （前缀递增），涉及计数的断言都按宗门 id 定界。
 *
 * 确定性说明：
 * - 结算时间拨到未来（时钟回拨 → 零产出零事件），资源与次数断言才精确；
 * - 测试环境没有 OPENROUTER_API_KEY → 胜率走 gambling.ts 的降级常量（1x = 50%），
 *   且 `win_probability` 落库为 NULL；
 * - Math.random 被 stub 成固定值（0.01 = 必胜，0.99 = 必败），胜负完全确定；
 *   stub 只在论道请求期间生效，建宗门/招募仍用真实随机。
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
  discipleIds: string[];
  state: () => Promise<Record<string, any>>;
}

/** 注册 + 建宗门；返回宗门 id、弟子 id 与同步读取函数。 */
async function makeSect(prefix: string): Promise<SectFixture> {
  seq += 1;
  const account = `${prefix}-${seq}`;
  const api = new TestClient(app, env, {
    'cf-connecting-ip': `10.9.${Math.floor(seq / 250)}.${seq % 250}`,
  });
  const registered = await api.post('/api/v1/auth/register', { account, password: PASSWORD });
  expect(registered.status).toBe(200);
  const created = await api.post('/api/v1/game/create-sect', { name: `赌坊${seq}号` });
  expect(created.status).toBe(200);
  const state = dataOf(created) as Record<string, any>;
  return {
    api,
    sectId: state.state.sect.id as string,
    discipleIds: (state.state.disciples as { id: string }[]).map((item) => item.id),
    state: async () => {
      const result = await api.get('/api/v1/game/sync');
      expect(result.status).toBe(200);
      return (dataOf(result) as Record<string, any>).state;
    },
  };
}

/** 把结算时间拨到未来：请求内的结算变成零产出零事件，完全确定。 */
async function freezeSettlement(sectId: string): Promise<void> {
  await env.DB.prepare('UPDATE sects SET last_settled_at = ? WHERE id = ?')
    .bind(Date.now() + 60_000, sectId)
    .run();
}

/** 宗门升级到赌坊解锁线（2 级）。 */
async function unlockGambling(sectId: string): Promise<void> {
  await env.DB.prepare('UPDATE sects SET level = 2 WHERE id = ?').bind(sectId).run();
}

/** 把某项资源余额写成一个确定值（没有余额行时补一行）。 */
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

async function discipleRow(discipleId: string): Promise<Record<string, any>> {
  const row = await env.DB.prepare('SELECT * FROM disciples WHERE id = ?')
    .bind(discipleId)
    .first<Record<string, any>>();
  expect(row).not.toBeNull();
  return row!;
}

/** 直接构造弟子的赌注/属性前置状态（绕过接口，专测服务端判定）。 */
async function setDiscipleFields(
  discipleId: string,
  fields: Record<string, number>,
): Promise<void> {
  const columns = Object.keys(fields);
  const assignments = columns.map((column) => `${column} = ?`).join(', ');
  await env.DB.prepare(`UPDATE disciples SET ${assignments} WHERE id = ?`)
    .bind(...columns.map((column) => fields[column]), discipleId)
    .run();
}

async function debateCounter(sectId: string): Promise<{ key: string; count: number }> {
  const row = await env.DB.prepare(
    'SELECT debate_date_key, debate_count FROM sects WHERE id = ?',
  )
    .bind(sectId)
    .first<{ debate_date_key: string; debate_count: number }>();
  return { key: row!.debate_date_key, count: Number(row!.debate_count) };
}

async function debateLogs(sectId: string): Promise<Record<string, any>[]> {
  const rows = await env.DB.prepare(
    'SELECT * FROM dao_debate_log WHERE sect_id = ? ORDER BY created_at ASC',
  )
    .bind(sectId)
    .all<Record<string, any>>();
  return rows.results ?? [];
}

/** 让该弟子处于「在外历练」状态（直接造一条未领取的历练记录）。 */
async function sendAway(sectId: string, discipleId: string, now: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO disciple_journeys (
       id, sect_id, disciple_id, disciple_name, direction, duration_seconds, original_assignment,
       started_at, ends_at, completed_at, claimed_at, reward_cultivation, reward_resources,
       extra_harvest, injured, injury_chance_bp, cultivation_awarded, created_at
     ) VALUES (?, ?, ?, ?, 'daoSeeking', 7200, 'idle', ?, ?, NULL, NULL, 0, '{}', 0, 0, 1000, NULL, ?)`,
  )
    .bind(crypto.randomUUID(), sectId, discipleId, '在外弟子', now, now + 7_200_000, now)
    .run();
}

/** 固定 Math.random：0.01 → 必胜；0.99 → 必败（降级胜率最高 0.5）。 */
function forceWin(): void {
  vi.spyOn(Math, 'random').mockReturnValue(0.01);
}

function forceLose(): void {
  vi.spyOn(Math, 'random').mockReturnValue(0.99);
}

afterEach(() => {
  vi.restoreAllMocks();
});

function debate(sect: SectFixture, body: Record<string, unknown>): Promise<ApiResult> {
  return sect.api.post('/api/v1/game/dao-debate', body);
}

function allocate(sect: SectFixture, body: Record<string, unknown>): Promise<ApiResult> {
  return sect.api.post('/api/v1/game/allocate-dao-insight', body);
}

/* ---------- 解锁与 sync 面板 ---------- */

describe('赌坊解锁与面板状态', () => {
  it('1 级宗门：面板未解锁、论道被拒且不消耗次数', async () => {
    const sect = await makeSect('gh-lock');
    await freezeSettlement(sect.sectId);
    await setBalance(sect.sectId, 'spiritStone', 1_000_000);

    const state = await sect.state();
    expect(state.gambling.unlocked).toBe(false);
    expect(state.gambling.blockedReason).toContain('2 级');
    expect(state.gambling.dailyLimit).toBe(DEBATE_DAILY_LIMIT);
    expect(state.gambling.remaining).toBe(DEBATE_DAILY_LIMIT);

    forceWin();
    const rejected = await debate(sect, {
      discipleId: sect.discipleIds[0],
      betMode: 'preset_spirit_stone',
      multiplier: 1,
      rewardType: 'resource',
    });
    expect(rejected.status).toBeGreaterThanOrEqual(400);
    expect(errorOf(rejected).code).toBe('INVALID_STATUS');
    // 未解锁的失败不能留下任何痕迹。
    expect(await debateCounter(sect.sectId)).toEqual({ key: '', count: 0 });
    expect(await debateLogs(sect.sectId)).toHaveLength(0);
    expect(await balanceOf(sect.sectId, 'spiritStone')).toBe(1_000_000);
  });

  it('2 级宗门：面板解锁、弟子带悟道值三字段，次数随论道更新', async () => {
    const sect = await makeSect('gh-panel');
    await freezeSettlement(sect.sectId);
    await unlockGambling(sect.sectId);
    await setBalance(sect.sectId, 'spiritStone', 1_000_000);

    const before = await sect.state();
    expect(before.gambling.unlocked).toBe(true);
    expect(before.gambling.blockedReason).toBeNull();
    expect(before.gambling.usedToday).toBe(0);
    const discipleView = (before.disciples as Record<string, any>[]).find(
      (item) => item.id === sect.discipleIds[0],
    );
    expect(discipleView, 'sync 视图里必须有该弟子').toBeTruthy();
    expect(discipleView!.daoInsight).toBe(0);
    expect(discipleView!.daoInsightUsed).toBe(0);
    expect(discipleView!.daoInsightRemaining).toBe(DAO_INSIGHT_CAP);

    forceWin();
    const played = await debate(sect, {
      discipleId: sect.discipleIds[0],
      betMode: 'preset_spirit_stone',
      multiplier: 1,
      rewardType: 'insight',
    });
    expect(played.status).toBe(200);
    const playedState = (dataOf(played) as Record<string, any>).state;
    expect(playedState.gambling.usedToday).toBe(1);
    expect(playedState.gambling.remaining).toBe(DEBATE_DAILY_LIMIT - 1);
    const after = await sect.state();
    expect(after.gambling.usedToday).toBe(1);
    expect(after.gambling.remaining).toBe(DEBATE_DAILY_LIMIT - 1);
  });

  it('UTC+8 跨日重置：昨天的计数不影响今天，论道后按今天重新从 1 开始', async () => {
    const sect = await makeSect('gh-day');
    await freezeSettlement(sect.sectId);
    await unlockGambling(sect.sectId);
    await setBalance(sect.sectId, 'spiritStone', 1_000_000);
    await env.DB.prepare('UPDATE sects SET debate_date_key = ?, debate_count = ? WHERE id = ?')
      .bind('1970-01-01', DEBATE_DAILY_LIMIT, sect.sectId)
      .run();

    const state = await sect.state();
    expect(state.gambling.usedToday).toBe(0);
    expect(state.gambling.remaining).toBe(DEBATE_DAILY_LIMIT);

    forceWin();
    const played = await debate(sect, {
      discipleId: sect.discipleIds[0],
      betMode: 'preset_spirit_stone',
      multiplier: 1,
      rewardType: 'resource',
    });
    expect(played.status).toBe(200);
    expect(await debateCounter(sect.sectId)).toEqual({ key: TODAY, count: 1 });
  });
});

/* ---------- 模式 A：系统预设灵石 ---------- */

describe('模式 A：系统预设灵石', () => {
  it('落败：扣掉赌注、次数 +1、写一条 lose 记录（降级时 win_probability 为 NULL）', async () => {
    const sect = await makeSect('gh-a-lose');
    await freezeSettlement(sect.sectId);
    await unlockGambling(sect.sectId);
    await setBalance(sect.sectId, 'spiritStone', 1_000_000);

    forceLose();
    const result = await debate(sect, {
      discipleId: sect.discipleIds[0],
      betMode: 'preset_spirit_stone',
      multiplier: 2,
      rewardType: 'resource',
    });
    expect(result.status).toBe(200);
    const payload = dataOf(result) as Record<string, any>;
    expect(payload.result.result).toBe('lose');
    expect(payload.result.stakeDescription).toContain('灵石 200');
    expect(payload.result.rewardDescription).toBe('无');
    expect(payload.result.winProbability).toBeNull();
    expect(payload.state.gambling.usedToday).toBe(1);

    // 2x 赌注 = 200000 最小单位 → 1_000_000 - 200_000
    expect(await balanceOf(sect.sectId, 'spiritStone')).toBe(800_000);
    const logs = await debateLogs(sect.sectId);
    expect(logs).toHaveLength(1);
    expect(logs[0].result).toBe('lose');
    expect(logs[0].bet_mode).toBe('preset_spirit_stone');
    expect(logs[0].multiplier).toBe(2);
    expect(JSON.parse(logs[0].stake_detail)).toEqual({
      resourceId: 'spiritStone',
      amount: '200000',
    });
    expect(JSON.parse(logs[0].reward_detail)).toEqual({ type: 'none' });
    expect(logs[0].win_probability).toBeNull();
  });

  it('胜出赢灵石：赌注不动、奖励 +180000（1x）', async () => {
    const sect = await makeSect('gh-a-win');
    await freezeSettlement(sect.sectId);
    await unlockGambling(sect.sectId);
    await setBalance(sect.sectId, 'spiritStone', 1_000_000);

    forceWin();
    const result = await debate(sect, {
      discipleId: sect.discipleIds[0],
      betMode: 'preset_spirit_stone',
      multiplier: 1,
      rewardType: 'resource',
    });
    expect(result.status).toBe(200);
    expect((dataOf(result) as Record<string, any>).result.result).toBe('win');
    expect(await balanceOf(sect.sectId, 'spiritStone')).toBe(1_180_000);
    const logs = await debateLogs(sect.sectId);
    expect(JSON.parse(logs[0].reward_detail)).toEqual({
      type: 'resource',
      resourceId: 'spiritStone',
      amount: '180000',
    });
  });

  it('胜出赢悟道值：1x +1 / 3x +3，余额不动', async () => {
    const sect = await makeSect('gh-a-insight');
    await freezeSettlement(sect.sectId);
    await unlockGambling(sect.sectId);
    await setBalance(sect.sectId, 'spiritStone', 1_000_000);

    forceWin();
    const first = await debate(sect, {
      discipleId: sect.discipleIds[0],
      betMode: 'preset_spirit_stone',
      multiplier: 3,
      rewardType: 'insight',
    });
    expect(first.status).toBe(200);
    expect(await balanceOf(sect.sectId, 'spiritStone')).toBe(1_000_000);
    expect((await discipleRow(sect.discipleIds[0])).dao_insight).toBe(3);

    const state = await sect.state();
    const view = (state.disciples as Record<string, any>[]).find(
      (item) => item.id === sect.discipleIds[0],
    );
    expect(view, 'sync 视图里必须有该弟子').toBeTruthy();
    expect(view!.daoInsight).toBe(3);
  });

  it('参数与余额校验：缺 rewardType / 余额不足 / 倍率越界都被拒且不消耗次数', async () => {
    const sect = await makeSect('gh-a-check');
    await freezeSettlement(sect.sectId);
    await unlockGambling(sect.sectId);
    await setBalance(sect.sectId, 'spiritStone', 50_000);

    forceWin();
    const noRewardType = await debate(sect, {
      discipleId: sect.discipleIds[0],
      betMode: 'preset_spirit_stone',
      multiplier: 1,
    });
    expect(errorOf(noRewardType).code).toBe('VALIDATION_ERROR');

    const poor = await debate(sect, {
      discipleId: sect.discipleIds[0],
      betMode: 'preset_spirit_stone',
      multiplier: 1,
      rewardType: 'resource',
    });
    expect(errorOf(poor).code).toBe('INSUFFICIENT_RESOURCE');

    const badMultiplier = await debate(sect, {
      discipleId: sect.discipleIds[0],
      betMode: 'preset_spirit_stone',
      multiplier: 4,
      rewardType: 'resource',
    });
    expect(badMultiplier.status).toBe(400);

    expect(await debateCounter(sect.sectId)).toEqual({ key: '', count: 0 });
    expect(await balanceOf(sect.sectId, 'spiritStone')).toBe(50_000);
  });
});

/* ---------- 模式 B：自由输入资源 ---------- */

describe('模式 B：自由输入资源', () => {
  it('落败按 输入 × 倍率 扣；胜出按 floor(输入 × 倍率 × 1.8) 发', async () => {
    const sect = await makeSect('gh-b');
    await freezeSettlement(sect.sectId);
    await unlockGambling(sect.sectId);
    await setBalance(sect.sectId, 'herb', 1_000_000);

    forceLose();
    const lost = await debate(sect, {
      discipleId: sect.discipleIds[0],
      betMode: 'free_resource',
      multiplier: 2,
      resourceId: 'herb',
      amount: 10_000,
    });
    expect(lost.status).toBe(200);
    // 输入 10000 × 倍率 2 = 20000
    expect(await balanceOf(sect.sectId, 'herb')).toBe(980_000);

    forceWin();
    const won = await debate(sect, {
      discipleId: sect.discipleIds[0],
      betMode: 'free_resource',
      multiplier: 2,
      resourceId: 'herb',
      amount: 10_000,
    });
    expect(won.status).toBe(200);
    // floor(20000 × 1.8) = 36000
    expect(await balanceOf(sect.sectId, 'herb')).toBe(1_016_000);

    const logs = await debateLogs(sect.sectId);
    expect(logs).toHaveLength(2);
    expect(JSON.parse(logs[1].reward_detail)).toEqual({
      type: 'resource',
      resourceId: 'herb',
      amount: '36000',
    });
  });

  it('低于最小赌注、白名单外资源、非法数量都被拒', async () => {
    const sect = await makeSect('gh-b-check');
    await freezeSettlement(sect.sectId);
    await unlockGambling(sect.sectId);
    await setBalance(sect.sectId, 'ore', 1_000_000);

    forceWin();
    const tooSmall = await debate(sect, {
      discipleId: sect.discipleIds[0],
      betMode: 'free_resource',
      multiplier: 1,
      resourceId: 'ore',
      amount: 9_999,
    });
    expect(errorOf(tooSmall).code).toBe('VALIDATION_ERROR');

    const notBettable = await debate(sect, {
      discipleId: sect.discipleIds[0],
      betMode: 'free_resource',
      multiplier: 1,
      resourceId: 'spiritualEnergy',
      amount: 10_000,
    });
    expect(errorOf(notBettable).code).toBe('VALIDATION_ERROR');

    const notInteger = await debate(sect, {
      discipleId: sect.discipleIds[0],
      betMode: 'free_resource',
      multiplier: 1,
      resourceId: 'ore',
      amount: 10_000.5,
    });
    expect(notInteger.status).toBe(400);

    expect(await debateCounter(sect.sectId)).toEqual({ key: '', count: 0 });
    expect(await balanceOf(sect.sectId, 'ore')).toBe(1_000_000);
  });
});

/* ---------- 模式 C：属性赌注 ---------- */

describe('模式 C：属性赌注', () => {
  it('落败扣属性点（可以扣到 0）；胜出发悟道值', async () => {
    const sect = await makeSect('gh-c');
    await freezeSettlement(sect.sectId);
    await unlockGambling(sect.sectId);
    await setDiscipleFields(sect.discipleIds[0], { attack: 3, dao_insight: 0 });

    forceLose();
    const lost = await debate(sect, {
      discipleId: sect.discipleIds[0],
      betMode: 'attribute',
      multiplier: 3,
      attribute: 'attack',
    });
    expect(lost.status).toBe(200);
    expect((await discipleRow(sect.discipleIds[0])).attack).toBe(0);
    // 对峙界面读的是下注前的属性快照：落败扣点之后，快照里的攻击仍是 3（与 opponent 同源）。
    const lostPayload = dataOf(lost) as Record<string, any>;
    expect(lostPayload.result.discipleAttributes.attack).toBe(3);
    const lostDisciple = (lostPayload.state.disciples as { id: string; attack: number }[]).find(
      (row) => row.id === sect.discipleIds[0],
    );
    expect(lostDisciple?.attack).toBe(0);
    expect(JSON.parse((await debateLogs(sect.sectId))[0].stake_detail)).toEqual({
      attribute: 'attack',
      points: 3,
    });

    forceWin();
    const won = await debate(sect, {
      discipleId: sect.discipleIds[0],
      betMode: 'attribute',
      multiplier: 2,
      attribute: 'defense',
    });
    expect(won.status).toBe(200);
    // 2x 的悟道值奖励 = 4
    expect((await discipleRow(sect.discipleIds[0])).dao_insight).toBe(4);
    // 属性赌注赢的时候属性不动（defense 仍是建号时的值）。
    const row = await discipleRow(sect.discipleIds[0]);
    expect(JSON.parse((await debateLogs(sect.sectId))[1].reward_detail)).toEqual({
      type: 'insight',
      insight: 4,
    });
    expect(row.attack).toBe(0);
  });

  it('属性不足、缺 attribute、属性白名单外都被拒', async () => {
    const sect = await makeSect('gh-c-check');
    await freezeSettlement(sect.sectId);
    await unlockGambling(sect.sectId);
    await setDiscipleFields(sect.discipleIds[0], { speed: 2 });

    forceWin();
    const notEnough = await debate(sect, {
      discipleId: sect.discipleIds[0],
      betMode: 'attribute',
      multiplier: 3,
      attribute: 'speed',
    });
    expect(errorOf(notEnough).code).toBe('INVALID_STATUS');

    const missing = await debate(sect, {
      discipleId: sect.discipleIds[0],
      betMode: 'attribute',
      multiplier: 1,
    });
    expect(errorOf(missing).code).toBe('VALIDATION_ERROR');

    const unknownAttribute = await debate(sect, {
      discipleId: sect.discipleIds[0],
      betMode: 'attribute',
      multiplier: 1,
      attribute: 'charisma',
    });
    expect(unknownAttribute.status).toBe(400);

    expect(await debateCounter(sect.sectId)).toEqual({ key: '', count: 0 });
  });
});

/* ---------- 每日限次、弟子资格、归属 ---------- */

describe('论道限次与资格', () => {
  it('当日已满 10 次 → DAILY_LIMIT；第 10 次仍可进行', async () => {
    const sect = await makeSect('gh-limit');
    await freezeSettlement(sect.sectId);
    await unlockGambling(sect.sectId);
    await setBalance(sect.sectId, 'spiritStone', 1_000_000);
    await setDiscipleFields(sect.discipleIds[0], { attack: 50 });

    forceWin();
    await env.DB.prepare('UPDATE sects SET debate_date_key = ?, debate_count = ? WHERE id = ?')
      .bind(TODAY, 9, sect.sectId)
      .run();
    const tenth = await debate(sect, {
      discipleId: sect.discipleIds[0],
      betMode: 'preset_spirit_stone',
      multiplier: 1,
      rewardType: 'insight',
    });
    expect(tenth.status).toBe(200);
    expect(await debateCounter(sect.sectId)).toEqual({ key: TODAY, count: 10 });

    // 已用满：再来一次被拒，且不写记录、不发奖。
    const rejected = await debate(sect, {
      discipleId: sect.discipleIds[0],
      betMode: 'preset_spirit_stone',
      multiplier: 1,
      rewardType: 'insight',
    });
    expect(errorOf(rejected).code).toBe('DAILY_LIMIT');
    expect(await debateLogs(sect.sectId)).toHaveLength(1);
    expect((await discipleRow(sect.discipleIds[0])).dao_insight).toBe(1);
  });

  it('受伤弟子与在外历练的弟子都不能参赌（也不消耗次数）', async () => {
    const sect = await makeSect('gh-elig');
    await freezeSettlement(sect.sectId);
    await unlockGambling(sect.sectId);
    await setBalance(sect.sectId, 'spiritStone', 1_000_000);
    const [first, second] = sect.discipleIds as [string, string];

    await setDiscipleFields(first, { injured_until: Date.now() + 600_000 });
    forceWin();
    const injured = await debate(sect, {
      discipleId: first,
      betMode: 'preset_spirit_stone',
      multiplier: 1,
      rewardType: 'resource',
    });
    expect(errorOf(injured).code).toBe('INVALID_STATUS');

    await sendAway(sect.sectId, second, Date.now());
    const away = await debate(sect, {
      discipleId: second,
      betMode: 'preset_spirit_stone',
      multiplier: 1,
      rewardType: 'resource',
    });
    expect(errorOf(away).code).toBe('INVALID_STATUS');

    expect(await debateCounter(sect.sectId)).toEqual({ key: '', count: 0 });
    expect(await debateLogs(sect.sectId)).toHaveLength(0);
  });

  it('跨宗与不存在的 discipleId 一律 NOT_FOUND', async () => {
    const mine = await makeSect('gh-own');
    const other = await makeSect('gh-other');
    await freezeSettlement(mine.sectId);
    await unlockGambling(mine.sectId);
    await setBalance(mine.sectId, 'spiritStone', 1_000_000);

    forceWin();
    const foreign = await debate(mine, {
      discipleId: other.discipleIds[0],
      betMode: 'preset_spirit_stone',
      multiplier: 1,
      rewardType: 'resource',
    });
    expect(errorOf(foreign).code).toBe('NOT_FOUND');

    const missing = await debate(mine, {
      discipleId: 'nobody',
      betMode: 'preset_spirit_stone',
      multiplier: 1,
      rewardType: 'resource',
    });
    expect(errorOf(missing).code).toBe('NOT_FOUND');
    expect(await debateLogs(mine.sectId)).toHaveLength(0);
    expect(await debateLogs(other.sectId)).toHaveLength(0);
  });
});

/* ---------- 悟道值加点 ---------- */

describe('悟道值加点', () => {
  it('成功：属性 + 点数、余额减少、累计已分配增加（回执与状态一致）', async () => {
    const sect = await makeSect('gh-alloc');
    await freezeSettlement(sect.sectId);
    await setDiscipleFields(sect.discipleIds[0], {
      dao_insight: 5,
      dao_insight_used: 12,
      defense: 50,
    });

    const result = await allocate(sect, {
      discipleId: sect.discipleIds[0],
      attribute: 'defense',
      points: 3,
    });
    expect(result.status).toBe(200);
    const payload = dataOf(result) as Record<string, any>;
    expect(payload.outcome).toMatchObject({
      attribute: 'defense',
      points: 3,
      newValue: 53,
      remainingInsight: 2,
      totalUsed: 15,
    });
    const row = await discipleRow(sect.discipleIds[0]);
    expect(row.defense).toBe(53);
    expect(row.dao_insight).toBe(2);
    expect(row.dao_insight_used).toBe(15);

    // sync 视图同步反映新值（daoInsightRemaining 是「剩余可分配额度」）。
    const view = ((await sect.state()).disciples as Record<string, any>[]).find(
      (item) => item.id === sect.discipleIds[0],
    );
    expect(view, 'sync 视图里必须有该弟子').toBeTruthy();
    expect(view!.defense).toBe(53);
    expect(view!.daoInsight).toBe(2);
    expect(view!.daoInsightUsed).toBe(15);
    expect(view!.daoInsightRemaining).toBe(DAO_INSIGHT_CAP - 15);

    // 悟道值加点不消耗论道次数、也不写论道记录。
    expect(await debateCounter(sect.sectId)).toEqual({ key: '', count: 0 });
    expect(await debateLogs(sect.sectId)).toHaveLength(0);
  });

  it('余额不足 / 超出累计 50 上限 / 超出属性 100 上限都被拒且不写库', async () => {
    const sect = await makeSect('gh-alloc-check');
    await freezeSettlement(sect.sectId);
    const discipleId = sect.discipleIds[0] as string;

    await setDiscipleFields(discipleId, { dao_insight: 1, dao_insight_used: 0, attack: 50 });
    const poor = await allocate(sect, { discipleId, attribute: 'attack', points: 2 });
    expect(errorOf(poor).code).toBe('INVALID_STATUS');

    await setDiscipleFields(discipleId, {
      dao_insight: 10,
      dao_insight_used: DAO_INSIGHT_CAP - 1,
    });
    const capped = await allocate(sect, { discipleId, attribute: 'attack', points: 2 });
    expect(errorOf(capped).code).toBe('INVALID_STATUS');

    await setDiscipleFields(discipleId, {
      dao_insight: 10,
      dao_insight_used: 0,
      defense: 100,
    });
    const maxed = await allocate(sect, { discipleId, attribute: 'defense', points: 1 });
    expect(errorOf(maxed).code).toBe('INVALID_STATUS');

    // 参数层防线：0 点 / 超 50 点 / 属性白名单外。
    await setDiscipleFields(discipleId, { dao_insight: 10, dao_insight_used: 0, attack: 50 });
    const zero = await allocate(sect, { discipleId, attribute: 'attack', points: 0 });
    expect(zero.status).toBe(400);
    const tooMany = await allocate(sect, { discipleId, attribute: 'attack', points: 51 });
    expect(tooMany.status).toBe(400);
    const unknown = await allocate(sect, { discipleId, attribute: 'charisma', points: 1 });
    expect(unknown.status).toBe(400);

    const row = await discipleRow(discipleId);
    expect(row.attack).toBe(50);
    expect(row.defense).toBe(100);
    expect(row.dao_insight).toBe(10);
    expect(row.dao_insight_used).toBe(0);
  });

  it('跨宗弟子 NOT_FOUND，且不动他人悟道值', async () => {
    const mine = await makeSect('gh-alloc-own');
    const other = await makeSect('gh-alloc-other');
    await freezeSettlement(mine.sectId);
    await setDiscipleFields(other.discipleIds[0], { dao_insight: 4 });

    const result = await allocate(mine, {
      discipleId: other.discipleIds[0],
      attribute: 'attack',
      points: 1,
    });
    expect(errorOf(result).code).toBe('NOT_FOUND');
    expect((await discipleRow(other.discipleIds[0])).dao_insight).toBe(4);
  });
});

/* ---------- 迁移约束（0019） ---------- */

describe('0019 迁移的数据库约束', () => {
  it('dao_insight 不能为负、dao_insight_used 不能超过 50、倍率只能是 1~3', async () => {
    const sect = await makeSect('gh-db');
    const discipleId = sect.discipleIds[0] as string;

    await expect(
      env.DB.prepare('UPDATE disciples SET dao_insight = -1 WHERE id = ?').bind(discipleId).run(),
    ).rejects.toThrow(/CHECK/i);

    await expect(
      env.DB.prepare('UPDATE disciples SET dao_insight_used = 51 WHERE id = ?')
        .bind(discipleId)
        .run(),
    ).rejects.toThrow(/CHECK/i);

    await expect(
      env.DB.prepare(
        `INSERT INTO dao_debate_log (id, sect_id, disciple_id, disciple_name, bet_mode, multiplier,
           stake_detail, result, reward_detail, win_probability, created_at)
         VALUES (?, ?, ?, ?, 'attribute', 4, '{}', 'win', '{}', NULL, ?)`,
      )
        .bind(crypto.randomUUID(), sect.sectId, discipleId, '甲', Date.now())
        .run(),
    ).rejects.toThrow(/CHECK/i);
  });

  it('新宗门与旧弟子的默认值：debate 计数为 0/空、悟道值为 0', async () => {
    const sect = await makeSect('gh-default');
    expect(await debateCounter(sect.sectId)).toEqual({ key: '', count: 0 });
    const row = await discipleRow(sect.discipleIds[0]);
    expect(Number(row.dao_insight)).toBe(0);
    expect(Number(row.dao_insight_used)).toBe(0);
  });
});

/* ---------- 复盘补测：发奖不动「累计已分配」、幸运/体魄下限、守卫覆盖面 ---------- */

describe('发奖与属性扣减的边界', () => {
  it('胜出发悟道值不会覆盖「累计已分配」列（并发加点的上限口径）', async () => {
    const sect = await makeSect('gh-a-used');
    await freezeSettlement(sect.sectId);
    await unlockGambling(sect.sectId);
    await setBalance(sect.sectId, 'spiritStone', 1_000_000);
    await setDiscipleFields(sect.discipleIds[0], { dao_insight: 0, dao_insight_used: 12 });

    forceWin();
    const result = await debate(sect, {
      discipleId: sect.discipleIds[0],
      betMode: 'preset_spirit_stone',
      multiplier: 2,
      rewardType: 'insight',
    });
    expect(result.status).toBe(200);
    const row = await discipleRow(sect.discipleIds[0]);
    expect(row.dao_insight).toBe(2);
    // 这一列只由加点写入；发奖写回时必须保持原值（否则累计 50 上限会被静默重置）。
    expect(row.dao_insight_used).toBe(12);

    const state = await sect.state();
    const view = (state.disciples as Record<string, any>[]).find(
      (item) => item.id === sect.discipleIds[0],
    );
    expect(view!.daoInsight).toBe(2);
    expect(view!.daoInsightUsed).toBe(12);
    expect(view!.daoInsightRemaining).toBe(DAO_INSIGHT_CAP - 12);
  });

  it('幸运 / 体魄最低保留 1 点：押到 0 会被服务端拒绝（不落到数据库 CHECK 上）', async () => {
    const sect = await makeSect('gh-floor');
    await freezeSettlement(sect.sectId);
    await unlockGambling(sect.sectId);
    const discipleId = sect.discipleIds[0] as string;
    await setDiscipleFields(discipleId, { luck: 3 });

    forceLose();
    // 3 点押 3x（3 点）会扣到 0，而 0016 的 CHECK 是 1..100 —— 必须在这里被挡住。
    const rejected = await debate(sect, {
      discipleId,
      betMode: 'attribute',
      multiplier: 3,
      attribute: 'luck',
    });
    expect(errorOf(rejected).code).toBe('INVALID_STATUS');
    expect((await discipleRow(discipleId)).luck).toBe(3);
    expect(await debateCounter(sect.sectId)).toEqual({ key: '', count: 0 });

    // 押到下限 1 点是允许的（3 点押 2x = 扣 2 点）。
    const allowed = await debate(sect, {
      discipleId,
      betMode: 'attribute',
      multiplier: 2,
      attribute: 'luck',
    });
    expect(allowed.status).toBe(200);
    expect((await discipleRow(discipleId)).luck).toBe(1);
    expect(await debateCounter(sect.sectId)).toEqual({ key: TODAY, count: 1 });
  });
});

describe('赌坊快照守卫（0019）', () => {
  /** 库里真实的宗门行 / 弟子行 / 资源行：守卫只比较这些值，不在测试里手写行字面量。 */
  async function guardRows(
    sectId: string,
    discipleId: string,
  ): Promise<{ sectRow: SectRow; disciple: DiscipleRow; balances: ResourceBalanceRow[] }> {
    const sectRow = await env.DB.prepare('SELECT * FROM sects WHERE id = ?')
      .bind(sectId)
      .first<SectRow>();
    const disciple = await env.DB.prepare('SELECT * FROM disciples WHERE id = ?')
      .bind(discipleId)
      .first<DiscipleRow>();
    const balances = await env.DB.prepare('SELECT * FROM resource_balances WHERE sect_id = ?')
      .bind(sectId)
      .all<ResourceBalanceRow>();
    expect(sectRow, '必须有宗门行').not.toBeNull();
    expect(disciple, '必须有弟子行').not.toBeNull();
    return { sectRow: sectRow!, disciple: disciple!, balances: balances.results ?? [] };
  }

  function placeholders(sql: string): number {
    return (sql.match(/\?/g) ?? []).length;
  }

  it('占位符与参数严格一一对应；只发悟道值奖励时也校验弟子行', async () => {
    const sect = await makeSect('gh-guard');
    const discipleId = sect.discipleIds[0] as string;
    const { sectRow, disciple, balances } = await guardRows(sect.sectId, discipleId);
    const now = Date.now();

    const noDisciple = gamblingSnapshotGuardStatement('cmd-a', {
      sect: sectRow,
      balances,
      resourceId: null,
      now,
    });
    const withDisciple = gamblingSnapshotGuardStatement('cmd-b', {
      sect: sectRow,
      balances,
      resourceId: 'spiritStone',
      disciple: { row: disciple },
      now,
    });
    const withAttribute = gamblingSnapshotGuardStatement('cmd-c', {
      sect: sectRow,
      balances,
      resourceId: 'spiritStone',
      disciple: { row: disciple, attribute: 'luck' },
      now,
    });
    const withAway = gamblingSnapshotGuardStatement('cmd-d', {
      sect: sectRow,
      balances,
      resourceId: 'spiritStone',
      disciple: { row: disciple, attribute: 'luck' },
      rejectAway: true,
      now,
    });

    for (const statement of [noDisciple, withDisciple, withAttribute, withAway]) {
      expect(placeholders(statement.sql)).toBe((statement.params ?? []).length);
    }
    // 只要传了弟子，就必须有弟子行校验（漏掉它会覆盖并发加点写下的 dao_insight*）。
    expect(withDisciple.sql).toContain('FROM disciples');
    expect(noDisciple.sql).not.toContain('FROM disciples');
    // 属性列来自白名单，且只多一个绑定参数。
    expect(withAttribute.sql).toContain('luck = ?');
    expect((withAttribute.params ?? []).length).toBe((withDisciple.params ?? []).length + 1);
    // rejectAway 再加两个参数（弟子 id + now）。
    expect((withAway.params ?? []).length).toBe((withAttribute.params ?? []).length + 2);
  });

  it('读快照之后弟子行被并发改动 → 整批回滚，不会按旧值写回', async () => {
    const sect = await makeSect('gh-guard-stale');
    const discipleId = sect.discipleIds[0] as string;
    const { sectRow, disciple, balances } = await guardRows(sect.sectId, discipleId);
    const guard = gamblingSnapshotGuardStatement('cmd-stale', {
      sect: sectRow,
      balances,
      resourceId: null,
      disciple: { row: disciple },
      now: Date.now(),
    });

    // 模拟并发：另一个请求在读快照之后改了 dao_insight_used。
    await setDiscipleFields(discipleId, { dao_insight_used: 20 });

    await expect(
      env.DB.batch([
        env.DB.prepare(guard.sql).bind(...(guard.params ?? [])),
        env.DB.prepare('UPDATE disciples SET dao_insight = 99 WHERE id = ?').bind(discipleId),
      ]),
    ).rejects.toThrow(/CHECK/i);

    // 整批回滚：并发写入保留，命令写入没有生效，守卫行也被回滚掉。
    const row = await discipleRow(discipleId);
    expect(row.dao_insight_used).toBe(20);
    expect(row.dao_insight).toBe(disciple.dao_insight);
    const guards = await env.DB.prepare(
      'SELECT COUNT(*) AS total FROM mutation_guards WHERE command_id = ?',
    )
      .bind('cmd-stale')
      .first<{ total: number }>();
    expect(Number(guards!.total)).toBe(0);
  });
});
