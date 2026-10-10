import { applyD1Migrations, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app';
import { dateKeyUtc8, dayStartMs } from '../src/modules/game/constants';
import { DAILY_TASK_IDS, dailyTaskReward } from '../src/modules/game/dailyTasks';

import { dataOf, errorOf, TestClient, type ApiResult } from './support/authClient';

/**
 * 宗门日课（0048 迁移 + dailyTasks.ts + GET /game/daily-tasks、POST /game/daily-tasks/claim、
 * POST /game/daily-tasks/chest；docs/每日任务开发计划.md 第 3.2 节）。
 *
 * 存储说明：本文件一份独立内存 D1，没有逐用例回滚 —— 每个用例用独立账号 / 宗门（前缀递增）。
 * 进度来源表由测试直接写入（与真实业务同一张表、同一列），「今天」「昨天」按服务端的 UTC+8 口径算。
 *
 * 确定性说明：领取 / 开箱前先把结算时间拨到未来（零产出零事件），余额断言才精确。
 * 新宗门（1 级、3 名弟子、容量 6、没建演武场）的可选任务正好是 5 个（讨伐 / 登门挑战 / 切磋 / 历练 / 招募），
 * 所以首次读取的列表是确定的。进度用例直接写入当天的日课行，把列表固定成需要的任务。
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

interface TaskView {
  id: string;
  name: string;
  target: number;
  progress: number;
  completed: boolean;
  claimed: boolean;
  reward: number;
}

interface DailyView {
  dateKey: string;
  tasks: TaskView[];
  chest: { available: boolean; claimed: boolean; description: string };
}

/** 注册 + 建宗门；返回宗门 id 与同步读取函数。 */
async function makeSect(prefix: string): Promise<SectFixture> {
  seq += 1;
  const account = `${prefix}-${seq}`;
  const api = new TestClient(app, env, {
    'cf-connecting-ip': `10.10.${Math.floor(seq / 250)}.${seq % 250}`,
  });
  const registered = await api.post('/api/v1/auth/register', { account, password: PASSWORD });
  expect(registered.status).toBe(200);
  const created = await api.post('/api/v1/game/create-sect', { name: `日课${seq}号` });
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

/* ---------- 日期与数据准备 ---------- */

/** 今天的 UTC+8 日期键（与服务端同一口径）。 */
function todayKey(): string {
  return dateKeyUtc8(Date.now());
}

/** 昨天的日期键。 */
function yesterdayKey(): string {
  return dateKeyUtc8(dayStartMs(Date.now()) - 1);
}

/** 昨天的一个时刻（今天 0 点之前一分钟）：进度不应计入。 */
function yesterdayTs(): number {
  return dayStartMs(Date.now()) - 60_000;
}

/** 把结算时间拨到未来：请求内的结算变成零产出零事件，余额断言才精确。 */
async function freezeSettlement(sectId: string): Promise<void> {
  await env.DB.prepare('UPDATE sects SET last_settled_at = ? WHERE id = ?')
    .bind(Date.now() + 60_000, sectId)
    .run();
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

async function balanceOf(sectId: string, resourceId: string): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT balance FROM resource_balances WHERE sect_id = ? AND resource_id = ?',
  )
    .bind(sectId, resourceId)
    .first<{ balance: number }>();
  return row === null ? 0 : Number(row.balance);
}

async function pillQuantityOf(sectId: string, pillId: string): Promise<number> {
  const row = await env.DB.prepare(
    'SELECT quantity FROM pill_inventories WHERE sect_id = ? AND pill_id = ?',
  )
    .bind(sectId, pillId)
    .first<{ quantity: number }>();
  return row === null ? 0 : Number(row.quantity);
}

/** 直接写入一行日课（替换同一天已有的行）：用来固定任务列表、已领取状态。 */
async function seedDailyRow(
  sectId: string,
  tasks: readonly string[],
  options: { claimed?: readonly string[]; chestClaimed?: boolean; dateKey?: string } = {},
): Promise<void> {
  const dateKey = options.dateKey ?? todayKey();
  const now = Date.now();
  await env.DB.prepare('DELETE FROM daily_tasks WHERE sect_id = ? AND date_key = ?')
    .bind(sectId, dateKey)
    .run();
  await env.DB.prepare(
    `INSERT INTO daily_tasks (sect_id, date_key, tasks, claimed, chest_claimed, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
  )
    .bind(
      sectId,
      dateKey,
      JSON.stringify(tasks),
      JSON.stringify(options.claimed ?? []),
      options.chestClaimed === true ? 1 : 0,
      now,
      now,
    )
    .run();
}

async function dailyRowCount(sectId: string): Promise<number> {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM daily_tasks WHERE sect_id = ?')
    .bind(sectId)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/* ---------- 进度来源：直接写入真实业务表 ---------- */

/** 镇妖塔闯塔：写一行 sect_towers（失败日期 / 次数、最近过层时间由参数决定）；赢输都算闯过。 */
async function setTower(
  sectId: string,
  tower: { failDateKey?: string | null; failCount?: number; maxFloorAt?: number | null },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO sect_towers (sect_id, max_floor, max_floor_at, fail_date_key, fail_count, sweep_date_key, version, updated_at)
     VALUES (?, 1, ?, ?, ?, NULL, 0, ?)
     ON CONFLICT (sect_id) DO UPDATE SET max_floor_at = excluded.max_floor_at,
       fail_date_key = excluded.fail_date_key, fail_count = excluded.fail_count`,
  )
    .bind(sectId, tower.maxFloorAt ?? null, tower.failDateKey ?? null, tower.failCount ?? 0, Date.now())
    .run();
}

/** 今天闯塔失败过一次（失败也算闯塔）。 */
async function failTowerToday(sectId: string): Promise<void> {
  await setTower(sectId, { failDateKey: todayKey(), failCount: 1 });
}

async function insertChallenge(sectId: string, createdAt: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO challenge_log (id, attacker_sect_id, defender_sect_id, attacker_lineup, defender_lineup,
       rounds, result, created_at)
     VALUES (?, ?, ?, '[]', '[]', '[]', 'win', ?)`,
  )
    .bind(crypto.randomUUID(), sectId, sectId, createdAt)
    .run();
}

async function insertExploration(sectId: string, createdAt: number): Promise<void> {
  await env.DB.prepare(
    'INSERT INTO explorations (id, sect_id, realm_id, created_at) VALUES (?, ?, ?, ?)',
  )
    .bind(crypto.randomUUID(), sectId, 'qiRefining', createdAt)
    .run();
}

async function insertRealmExploration(sectId: string, createdAt: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO realm_explorations (id, sect_id, realm_id, total_stages, status, created_at, updated_at)
     VALUES (?, ?, ?, 3, 'completed', ?, ?)`,
  )
    .bind(crypto.randomUUID(), sectId, 'qiRefining', createdAt, createdAt)
    .run();
}

async function insertJourney(sectId: string, startedAt: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO disciple_journeys (id, sect_id, disciple_id, disciple_name, direction, duration_seconds,
       original_assignment, started_at, ends_at, reward_cultivation, injury_chance_bp, created_at)
     VALUES (?, ?, ?, '历练弟子', 'daoSeeking', 7200, 'cultivating', ?, ?, 0, 0, ?)`,
  )
    .bind(crypto.randomUUID(), sectId, crypto.randomUUID(), startedAt, startedAt + 7_200_000, startedAt)
    .run();
}

async function insertStockTrade(sectId: string, createdAt: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO stock_trades (id, sect_id, stock_id, side, shares, price, amount, fee, profit, created_at)
     VALUES (?, ?, 'tiangong', 'buy', 1, 1000, 1000, 3, 0, ?)`,
  )
    .bind(crypto.randomUUID(), sectId, createdAt)
    .run();
}

async function insertVeinBattle(sectId: string, createdAt: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO vein_battles (id, vein_id, attacker_sect_id, attacker_name, defender_sect_id, defender_name,
       won, rounds, created_at)
     VALUES (?, 'vein-1', ?, '攻方', ?, '守方', 1, '[]', ?)`,
  )
    .bind(crypto.randomUUID(), sectId, sectId, createdAt)
    .run();
}

/** 一只测试用世界 Boss（讨伐出手要挂在 Boss 上）；day_key 用唯一值，不影响真实的今日 Boss。 */
async function insertWorldBoss(): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO world_bosses (id, day_key, stage, boss_index, affix, round_damage, max_hp, hp, status,
       killer_sect_id, half_announced, rewarded_at, created_at, ended_at)
     VALUES (?, ?, 1, 0, 'ironclad', 30000, 1000000, 1000000, 'active', NULL, 0, NULL, ?, NULL)`,
  )
    .bind(id, `daily-test-${id}`, Date.now())
    .run();
  return id;
}

async function insertBossHit(bossId: string, sectId: string, createdAt: number): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO world_boss_hits (id, boss_id, sect_id, sect_name, disciple_names, damage, created_at)
     VALUES (?, ?, ?, '测试宗', '[]', 100, ?)`,
  )
    .bind(crypto.randomUUID(), bossId, sectId, createdAt)
    .run();
}

/* ---------- 请求 ---------- */

function getDaily(sect: SectFixture): Promise<ApiResult> {
  return sect.api.get('/api/v1/game/daily-tasks');
}

function claimTask(sect: SectFixture, taskId: string): Promise<ApiResult> {
  return sect.api.post('/api/v1/game/daily-tasks/claim', { taskId });
}

function openChest(sect: SectFixture): Promise<ApiResult> {
  return sect.api.post('/api/v1/game/daily-tasks/chest', {});
}

function dailyOf(result: ApiResult): DailyView {
  return (dataOf(result) as { dailyTasks: DailyView }).dailyTasks;
}

function taskOf(view: DailyView, taskId: string): TaskView {
  const found = view.tasks.find((task) => task.id === taskId);
  if (found === undefined) throw new Error(`今天的日课里没有 ${taskId}`);
  return found;
}

/* ---------- 面板与抽取 ---------- */

describe('宗门日课：首次生成与稳定性', () => {
  it('新宗门首次 GET 生成当天的 5 个任务并落库；再次 GET 完全相同', async () => {
    const sect = await makeSect('dt-first');
    const first = await getDaily(sect);
    expect(first.status).toBe(200);
    const view = dailyOf(first);
    expect(view.dateKey).toBe(todayKey());
    // 1 级、3 名弟子（容量 6）、没建演武场：可选的只有这 4 个，全部抽中，顺序即任务池顺序。
    expect(view.tasks.map((task) => task.id)).toEqual(['bossHit', 'challenge', 'journey', 'recruit']);
    expect(view.tasks.every((task) => task.reward === dailyTaskReward(1))).toBe(true);
    expect(view.chest).toEqual({ available: false, claimed: false, description: '玄铁 3~5、神木 1~2、随机丹药 1 颗' });

    const second = await getDaily(sect);
    expect(dailyOf(second)).toEqual(view);
    expect(await dailyRowCount(sect.sectId)).toBe(1);
  });

  it('当天的列表一旦落库，之后宗门升级解锁了新玩法也不改（只在跨天时换）', async () => {
    const sect = await makeSect('dt-stable');
    const before = dailyOf(await getDaily(sect));
    await env.DB.prepare('UPDATE sects SET level = 3 WHERE id = ?').bind(sect.sectId).run();
    const after = dailyOf(await getDaily(sect));
    expect(after.tasks.map((task) => task.id)).toEqual(before.tasks.map((task) => task.id));
  });

  it('并发的首次读取只会留下一份列表，且每个请求拿到的是同一份', async () => {
    const sect = await makeSect('dt-race');
    const results = await Promise.all([getDaily(sect), getDaily(sect), getDaily(sect)]);
    const listings = results.map((result) => dailyOf(result).tasks.map((task) => task.id).join(','));
    expect(new Set(listings).size).toBe(1);
    expect(await dailyRowCount(sect.sectId)).toBe(1);
  });

  it('日课不进 /game/sync（同步返回的 state 里没有日课字段）', async () => {
    const sect = await makeSect('dt-sync');
    await getDaily(sect);
    const synced = await sect.api.get('/api/v1/game/sync');
    expect(synced.status).toBe(200);
    expect(dataOf(synced).state).not.toHaveProperty('dailyTasks');
  });
});

describe('宗门日课：进度统计（只数本宗、今天的记录）', () => {
  it('每种来源都能计数；昨天的记录不计；进度截到目标', async () => {
    const sect = await makeSect('dt-progress');
    await freezeSettlement(sect.sectId);
    const today = Date.now();
    const yesterday = yesterdayTs();
    const bossId = await insertWorldBoss();

    // 讨伐出手：今天 2 次（目标 3），昨天 1 次不计。
    await insertBossHit(bossId, sect.sectId, today);
    await insertBossHit(bossId, sect.sectId, today);
    await insertBossHit(bossId, sect.sectId, yesterday);
    // 秘境探索：explorations + realm_explorations 今天各 1（目标 2），昨天的 explorations 不计。
    await insertExploration(sect.sectId, today);
    await insertRealmExploration(sect.sectId, today);
    await insertExploration(sect.sectId, yesterday);
    // 登门挑战：今天 1（目标 1），昨天不计。
    await insertChallenge(sect.sectId, today);
    await insertChallenge(sect.sectId, yesterday);
    // 赌坊玩法：论道计数 debate_date_key = 今天 时才算（目标 3，这里 2）。
    await env.DB.prepare('UPDATE sects SET debate_date_key = ?, debate_count = 2 WHERE id = ?')
      .bind(todayKey(), sect.sectId)
      .run();
    // 派弟子历练：今天 1（目标 1），昨天的不计。
    await insertJourney(sect.sectId, today);
    await insertJourney(sect.sectId, yesterday);
    // 镇妖塔扫荡：sweep_date_key = 今天 → 1；闯塔：max_floor_at 是今天（今天过了新层）→ 1。
    await env.DB.prepare(
      `INSERT INTO sect_towers (sect_id, max_floor, max_floor_at, fail_count, sweep_date_key, version, updated_at)
       VALUES (?, 1, ?, 0, ?, 0, ?)`,
    )
      .bind(sect.sectId, today, todayKey(), today)
      .run();
    // 招募弟子：recruit_date_key = 今天 且 recruit_count ≥ 1。
    await env.DB.prepare('UPDATE sects SET recruit_date_key = ?, recruit_count = 1 WHERE id = ?')
      .bind(todayKey(), sect.sectId)
      .run();
    // 灵股交易：今天 1 笔，昨天的不计。
    await insertStockTrade(sect.sectId, today);
    await insertStockTrade(sect.sectId, yesterday);
    // 灵脉抢夺：今天 1 场。
    await insertVeinBattle(sect.sectId, today);

    await seedDailyRow(sect.sectId, [...DAILY_TASK_IDS]);
    const view = dailyOf(await getDaily(sect));

    expect(taskOf(view, 'bossHit')).toMatchObject({ progress: 2, target: 3, completed: false });
    expect(taskOf(view, 'explore')).toMatchObject({ progress: 2, target: 2, completed: true });
    expect(taskOf(view, 'challenge')).toMatchObject({ progress: 1, target: 1, completed: true });
    expect(taskOf(view, 'towerClimb')).toMatchObject({ progress: 1, target: 1, completed: true });
    expect(taskOf(view, 'gamble')).toMatchObject({ progress: 2, target: 3, completed: false });
    expect(taskOf(view, 'journey')).toMatchObject({ progress: 1, target: 1, completed: true });
    expect(taskOf(view, 'towerSweep')).toMatchObject({ progress: 1, target: 1, completed: true });
    expect(taskOf(view, 'recruit')).toMatchObject({ progress: 1, target: 1, completed: true });
    expect(taskOf(view, 'stockTrade')).toMatchObject({ progress: 1, target: 1, completed: true });
    expect(taskOf(view, 'veinAttack')).toMatchObject({ progress: 1, target: 1, completed: true });
  });

  it('只有昨天的记录：今天的进度全部为 0', async () => {
    const sect = await makeSect('dt-yesterday');
    const yesterday = yesterdayTs();
    const bossId = await insertWorldBoss();
    await insertBossHit(bossId, sect.sectId, yesterday);
    // 镇妖塔：昨天失败过、昨天过过层，今天都不算闯塔。
    await setTower(sect.sectId, { failDateKey: dateKeyUtc8(yesterday), failCount: 2, maxFloorAt: yesterday });
    await insertChallenge(sect.sectId, yesterday);
    await insertJourney(sect.sectId, yesterday);
    await seedDailyRow(sect.sectId, ['bossHit', 'challenge', 'towerClimb', 'journey']);

    const view = dailyOf(await getDaily(sect));
    for (const task of view.tasks) {
      expect(task).toMatchObject({ progress: 0, completed: false, claimed: false });
    }
  });
});

/* ---------- 领取 ---------- */

describe('宗门日课：领取单个任务', () => {
  it('未完成拒绝；完成后领取得「等级 × 50 灵石」；重复领取拒绝；不在今天列表的任务拒绝', async () => {
    const sect = await makeSect('dt-claim');
    await freezeSettlement(sect.sectId);
    await setBalance(sect.sectId, 'spiritStone', 0);
    await seedDailyRow(sect.sectId, ['towerClimb', 'journey']);

    const early = await claimTask(sect, 'towerClimb');
    expect(early.status).toBe(409);
    expect(errorOf(early).code).toBe('INVALID_STATUS');

    // 闯塔失败也算完成。
    await failTowerToday(sect.sectId);
    const claimed = await claimTask(sect, 'towerClimb');
    expect(claimed.status).toBe(200);
    const payload = dataOf(claimed) as { result: Record<string, unknown>; dailyTasks: DailyView };
    // 1 级宗门：1 × 50 灵石 = 50000 最小单位。
    expect(payload.result).toMatchObject({ taskId: 'towerClimb', spiritStone: 50_000 });
    expect(await balanceOf(sect.sectId, 'spiritStone')).toBe(50_000);
    expect(taskOf(payload.dailyTasks, 'towerClimb')).toMatchObject({ claimed: true, completed: true });

    const again = await claimTask(sect, 'towerClimb');
    expect(again.status).toBe(409);
    expect(errorOf(again).code).toBe('INVALID_STATUS');

    const notInList = await claimTask(sect, 'towerSweep');
    expect(notInList.status).toBe(400);
    expect(errorOf(notInList).code).toBe('VALIDATION_ERROR');

    const unknown = await claimTask(sect, 'nope');
    expect(unknown.status).toBe(400);
    expect(errorOf(unknown).code).toBe('VALIDATION_ERROR');

    // 被拒的请求不动余额。
    expect(await balanceOf(sect.sectId, 'spiritStone')).toBe(50_000);
  });

  it('奖励按领取时的宗门等级计：升到 10 级后领取得 500000 最小单位', async () => {
    const sect = await makeSect('dt-level');
    await freezeSettlement(sect.sectId);
    await setBalance(sect.sectId, 'spiritStone', 0);
    await seedDailyRow(sect.sectId, ['journey']);
    await env.DB.prepare('UPDATE sects SET level = 10 WHERE id = ?').bind(sect.sectId).run();

    await insertJourney(sect.sectId, Date.now());
    const claimed = await claimTask(sect, 'journey');
    expect(claimed.status).toBe(200);
    expect(dataOf(claimed).result).toMatchObject({ spiritStone: 500_000 });
    expect(dataOf(claimed).result).toMatchObject({ spiritStone: dailyTaskReward(10) });
    expect(await balanceOf(sect.sectId, 'spiritStone')).toBe(500_000);
  });

  it('同一个任务并发点两次：只成功一次，灵石只入账一份', async () => {
    const sect = await makeSect('dt-double');
    await freezeSettlement(sect.sectId);
    await setBalance(sect.sectId, 'spiritStone', 0);
    await seedDailyRow(sect.sectId, ['towerClimb']);
    await failTowerToday(sect.sectId);

    const results = await Promise.all([claimTask(sect, 'towerClimb'), claimTask(sect, 'towerClimb')]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect(await balanceOf(sect.sectId, 'spiritStone')).toBe(50_000);
  });
});

/* ---------- 宝箱 ---------- */

describe('宗门日课：日课宝箱', () => {
  it('任务没全部领完拒绝；全部领完后开箱入账玄铁 / 神木 / 丹药；重复开箱拒绝', async () => {
    const sect = await makeSect('dt-chest');
    await freezeSettlement(sect.sectId);
    await setBalance(sect.sectId, 'spiritStone', 0);
    await setBalance(sect.sectId, 'xuantie', 0);
    await setBalance(sect.sectId, 'shenmu', 0);
    await seedDailyRow(sect.sectId, ['towerClimb', 'journey']);

    const tooEarly = await openChest(sect);
    expect(tooEarly.status).toBe(409);
    expect(errorOf(tooEarly).code).toBe('INVALID_STATUS');

    await failTowerToday(sect.sectId);
    await insertJourney(sect.sectId, Date.now());
    expect((await claimTask(sect, 'towerClimb')).status).toBe(200);

    // 还差 journey 没领。
    const halfway = await openChest(sect);
    expect(halfway.status).toBe(409);
    expect(errorOf(halfway).code).toBe('INVALID_STATUS');

    expect((await claimTask(sect, 'journey')).status).toBe(200);
    const ready = dailyOf(await getDaily(sect));
    expect(ready.chest).toMatchObject({ available: true, claimed: false });

    const pillsBefore = await Promise.all(
      ['healingPill', 'cultivationPill', 'bodyTemperingPill'].map((pillId) => pillQuantityOf(sect.sectId, pillId)),
    );
    const opened = await openChest(sect);
    expect(opened.status).toBe(200);
    const payload = dataOf(opened) as { result: Record<string, any>; dailyTasks: DailyView };
    const { xuantie, shenmu, pillId, pillName } = payload.result;
    expect(xuantie).toBeGreaterThanOrEqual(3);
    expect(xuantie).toBeLessThanOrEqual(5);
    expect(shenmu).toBeGreaterThanOrEqual(1);
    expect(shenmu).toBeLessThanOrEqual(2);
    expect(['healingPill', 'cultivationPill', 'bodyTemperingPill']).toContain(pillId);
    expect(typeof pillName).toBe('string');
    expect(payload.result.message).toContain('日课宝箱');

    expect(await balanceOf(sect.sectId, 'xuantie')).toBe(xuantie * 1000);
    expect(await balanceOf(sect.sectId, 'shenmu')).toBe(shenmu * 1000);
    const pillIndex = ['healingPill', 'cultivationPill', 'bodyTemperingPill'].indexOf(pillId);
    expect(await pillQuantityOf(sect.sectId, pillId)).toBe(pillsBefore[pillIndex]! + 1);
    expect(payload.dailyTasks.chest).toMatchObject({ available: false, claimed: true });

    const again = await openChest(sect);
    expect(again.status).toBe(409);
    expect(errorOf(again).code).toBe('INVALID_STATUS');
    expect(await balanceOf(sect.sectId, 'xuantie')).toBe(xuantie * 1000);
  });

  it('同时点两次开箱：只开成功一次，丹药只多一颗', async () => {
    const sect = await makeSect('dt-chest-double');
    await freezeSettlement(sect.sectId);
    await setBalance(sect.sectId, 'xuantie', 0);
    await setBalance(sect.sectId, 'shenmu', 0);
    await seedDailyRow(sect.sectId, ['journey'], { claimed: ['journey'] });

    const pillTotal = async (): Promise<number> => {
      const counts = await Promise.all(
        ['healingPill', 'cultivationPill', 'bodyTemperingPill'].map((pillId) => pillQuantityOf(sect.sectId, pillId)),
      );
      return counts.reduce((sum, count) => sum + count, 0);
    };
    const before = await pillTotal();
    const results = await Promise.all([openChest(sect), openChest(sect)]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect((await pillTotal()) - before).toBe(1);
  });
});

/* ---------- 跨天 ---------- */

describe('宗门日课：跨天', () => {
  it('把今天的行改成昨天后再读：生成新的一天，旧的领取状态不带过来', async () => {
    const sect = await makeSect('dt-day');
    await freezeSettlement(sect.sectId);
    await seedDailyRow(sect.sectId, ['journey'], { claimed: ['journey'], chestClaimed: true });
    await env.DB.prepare('UPDATE daily_tasks SET date_key = ? WHERE sect_id = ? AND date_key = ?')
      .bind(yesterdayKey(), sect.sectId, todayKey())
      .run();

    const view = dailyOf(await getDaily(sect));
    expect(view.dateKey).toBe(todayKey());
    expect(view.tasks.length).toBeGreaterThan(0);
    expect(view.tasks.every((task) => !task.claimed)).toBe(true);
    expect(view.chest).toMatchObject({ available: false, claimed: false });

    // 昨天那一行原样保留（只是不再读它）。
    const old = await env.DB.prepare('SELECT claimed, chest_claimed FROM daily_tasks WHERE sect_id = ? AND date_key = ?')
      .bind(sect.sectId, yesterdayKey())
      .first<{ claimed: string; chest_claimed: number }>();
    expect(JSON.parse(old?.claimed ?? '[]')).toEqual(['journey']);
    expect(Number(old?.chest_claimed)).toBe(1);
    expect(await dailyRowCount(sect.sectId)).toBe(2);
  });
});

/* ---------- 切磋换成闯塔：旧日课行兼容 ---------- */

describe('宗门日课：旧日课行里的切磋', () => {
  it('当天已抽到「切磋」的行：读取时去掉切磋，剩下的任务领完就能开宝箱', async () => {
    const sect = await makeSect('dt-legacy-spar');
    await freezeSettlement(sect.sectId);
    await seedDailyRow(sect.sectId, ['bossHit', 'spar', 'journey']);

    const view = dailyOf(await getDaily(sect));
    expect(view.tasks.map((task) => task.id)).toEqual(['bossHit', 'journey']);

    const bossId = await insertWorldBoss();
    for (let index = 0; index < 3; index += 1) {
      await insertBossHit(bossId, sect.sectId, Date.now());
    }
    await insertJourney(sect.sectId, Date.now());
    expect((await claimTask(sect, 'bossHit')).status).toBe(200);
    expect((await claimTask(sect, 'journey')).status).toBe(200);

    const chest = await openChest(sect);
    expect(chest.status).toBe(200);
    expect(dailyOf(chest).chest).toMatchObject({ claimed: true, available: false });
  });

  it('闯塔赢输都算：今天过了新层（没有失败）也算完成', async () => {
    const sect = await makeSect('dt-climb-win');
    await seedDailyRow(sect.sectId, ['towerClimb']);
    await setTower(sect.sectId, { maxFloorAt: Date.now() });
    expect(taskOf(dailyOf(await getDaily(sect)), 'towerClimb')).toMatchObject({ progress: 1, completed: true });
  });
});
