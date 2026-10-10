import { GAMBLING_UNLOCK_SECT_LEVEL } from './gambling';
import { MARKET_UNLOCK_SECT_LEVEL } from './market';
import { seededRandom } from './names';
import { UNITS_PER_DISPLAY } from './shop';
import { TOWER_UNLOCK_SECT_LEVEL } from './tower';
import { VEIN_UNLOCK_SECT_LEVEL } from './veins';

/**
 * 宗门日课（每日任务，docs/每日任务开发计划.md）——纯定义与纯计算。
 *
 * 与 stoneGamble.ts / tower.ts 同一模式：任务池、奖励与宝箱常量都硬编码在这里，不进 game-config；
 * 本文件不读库、不取时间，随机源 / 种子通过参数注入（测试用固定种子或固定随机序列）。
 *
 * 规则要点：
 * - 任务池 10 个。进度全部从现有记录统计（service.ts 的 dailyProgressOf），这里只管定义与抽取。
 * - 每宗门每天第一次读取时抽 5 个并落库（之后一整天不变）：只从「出现条件」满足的任务里抽，
 *   至少 2 个「轻松」（可选不够时有几个算几个），最多 1 个「PvP」，不重复。
 * - 单个任务奖励：领取时的宗门等级 × 50 灵石；当天抽到的任务全部领取后可开一个日课宝箱。
 *
 * 金额一律是最小单位（1 展示单位 = 1000 最小单位）。
 */

/* ---------- 任务池 ---------- */

/** 任务 id（顺序即任务池表的顺序）。 */
export const DAILY_TASK_IDS = [
  'bossHit',
  'explore',
  'challenge',
  'spar',
  'gamble',
  'journey',
  'towerSweep',
  'recruit',
  'stockTrade',
  'veinAttack',
] as const;
export type DailyTaskId = (typeof DAILY_TASK_IDS)[number];

/** 类别：轻松 / 普通 / PvP（抽取约束只认这三类）。 */
export type DailyTaskCategory = 'easy' | 'normal' | 'pvp';

export interface DailyTaskDef {
  id: DailyTaskId;
  name: string;
  /** 目标次数（进度显示为 min(实际次数, 目标)）。 */
  target: number;
  category: DailyTaskCategory;
}

/** 任务池（计划 1.1）。进度来源与出现条件见 service.ts 的 dailyProgressOf / dailyTaskAvailableIds。 */
export const DAILY_TASKS: readonly DailyTaskDef[] = [
  { id: 'bossHit', name: '讨伐出手', target: 3, category: 'normal' },
  { id: 'explore', name: '秘境探索', target: 2, category: 'normal' },
  { id: 'challenge', name: '登门挑战', target: 1, category: 'pvp' },
  { id: 'spar', name: '切磋', target: 2, category: 'normal' },
  { id: 'gamble', name: '赌坊玩法', target: 3, category: 'normal' },
  { id: 'journey', name: '派弟子历练', target: 1, category: 'easy' },
  { id: 'towerSweep', name: '镇妖塔扫荡', target: 1, category: 'easy' },
  { id: 'recruit', name: '招募弟子', target: 1, category: 'easy' },
  { id: 'stockTrade', name: '灵股交易', target: 1, category: 'easy' },
  { id: 'veinAttack', name: '灵脉抢夺', target: 1, category: 'pvp' },
];

/** 按 id 查任务定义；未知 id 返回 null（调用方据此拒绝）。 */
export function findDailyTask(taskId: string): DailyTaskDef | null {
  return DAILY_TASKS.find((task) => task.id === taskId) ?? null;
}

/** 是不是任务池里的 id（读库拿到的 JSON 也要过这一关，防止脏数据混进来）。 */
export function isDailyTaskId(value: string): value is DailyTaskId {
  return (DAILY_TASK_IDS as readonly string[]).includes(value);
}

/* ---------- 抽取与奖励常量 ---------- */

/** 每天抽几个任务。 */
export const DAILY_TASK_COUNT = 5;
/** 至少几个「轻松」（可选的轻松不够时有几个算几个）。 */
export const DAILY_TASK_MIN_EASY = 2;
/** 最多几个 PvP。 */
export const DAILY_TASK_MAX_PVP = 1;
/** 单个任务的灵石奖励：领取时的宗门等级 × 这个数（展示单位）。 */
export const DAILY_TASK_STONE_PER_LEVEL = 50;

/* ---------- 日课宝箱常量 ---------- */

/** 玄铁个数（展示单位，闭区间，均匀随机整数）。 */
export const DAILY_CHEST_XUANTIE_RANGE: readonly [number, number] = [3, 5];
/** 神木个数（展示单位，闭区间，均匀随机整数）。 */
export const DAILY_CHEST_SHENMU_RANGE: readonly [number, number] = [1, 2];
/** 丹药候选：从中均匀随机 1 颗。 */
export const DAILY_CHEST_PILL_IDS = ['healingPill', 'cultivationPill', 'bodyTemperingPill'] as const;
export type DailyChestPillId = (typeof DAILY_CHEST_PILL_IDS)[number];

function rangeText([min, max]: readonly [number, number]): string {
  return min === max ? String(min) : `${String(min)}~${String(max)}`;
}

/** 宝箱内容文案（接口与界面共用，不在各处复制）。 */
export const DAILY_CHEST_DESCRIPTION = `玄铁 ${rangeText(DAILY_CHEST_XUANTIE_RANGE)}、神木 ${rangeText(DAILY_CHEST_SHENMU_RANGE)}、随机丹药 1 颗`;

/* ---------- 出现条件 ---------- */

/** 决定任务出现条件的宗门处境（由 service 从宗门快照、建筑、镇妖塔行取值）。 */
export interface DailyTaskSituation {
  sectLevel: number;
  /** 演武场等级（0 = 没建）：秘境探索的前置。 */
  arenaLevel: number;
  /** 镇妖塔历史最高层（0 = 还没闯过）：扫荡的前置。 */
  towerMaxFloor: number;
  /** 当前弟子数与弟子上限：还招得进人时才抽得到「招募弟子」。 */
  discipleCount: number;
  discipleCapacity: number;
}

/** 此刻出现条件满足的任务（按任务池顺序）。 */
export function dailyTaskAvailableIds(situation: DailyTaskSituation): DailyTaskId[] {
  return DAILY_TASKS.filter((task) => isAvailable(task.id, situation)).map((task) => task.id);
}

function isAvailable(taskId: DailyTaskId, situation: DailyTaskSituation): boolean {
  switch (taskId) {
    case 'explore':
      return situation.arenaLevel > 0;
    case 'gamble':
      return situation.sectLevel >= GAMBLING_UNLOCK_SECT_LEVEL;
    case 'towerSweep':
      return situation.sectLevel >= TOWER_UNLOCK_SECT_LEVEL && situation.towerMaxFloor > 0;
    case 'recruit':
      return situation.discipleCount < situation.discipleCapacity;
    case 'stockTrade':
      return situation.sectLevel >= MARKET_UNLOCK_SECT_LEVEL;
    case 'veinAttack':
      return situation.sectLevel >= VEIN_UNLOCK_SECT_LEVEL;
    // 讨伐出手 / 登门挑战 / 切磋 / 派弟子历练：没有出现条件。
    default:
      return true;
  }
}

/* ---------- 抽取 ---------- */

/**
 * 当天抽任务（纯函数，计划 1.2）。同一组可选任务 + 同一个种子永远得到同一结果，结果按任务池顺序排列。
 * 步骤：
 * 1. 可选任务按种子洗牌（重复的 id 只算一次）；
 * 2. 先从轻松里保底取 min(DAILY_TASK_MIN_EASY, 轻松可选数) 个；
 * 3. 再按洗牌顺序补齐到 min(DAILY_TASK_COUNT, 可选数) 个，PvP 最多 DAILY_TASK_MAX_PVP 个。
 * 注意：PvP 上限优先于数量。只有可选任务里 PvP 占大头时才会少抽，正常处境下可选任务远多于 5 个，不会发生。
 */
export function pickDailyTasks(availableIds: readonly DailyTaskId[], seed: string): DailyTaskId[] {
  const random = seededRandom(seed);
  const pool = shuffled(
    DAILY_TASKS.filter((task) => availableIds.includes(task.id)),
    random,
  );
  const target = Math.min(DAILY_TASK_COUNT, pool.length);
  const picked: DailyTaskDef[] = [];

  for (const task of pool.filter((item) => item.category === 'easy').slice(0, DAILY_TASK_MIN_EASY)) {
    picked.push(task);
  }
  for (const task of pool) {
    if (picked.length >= target) break;
    if (picked.includes(task)) continue;
    if (task.category === 'pvp' && picked.filter((item) => item.category === 'pvp').length >= DAILY_TASK_MAX_PVP) {
      continue;
    }
    picked.push(task);
  }
  return DAILY_TASKS.filter((task) => picked.includes(task)).map((task) => task.id);
}

/** Fisher–Yates 洗牌（随机源注入，结果只由随机序列决定）。 */
function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    const current = result[index]!;
    result[index] = result[swapIndex]!;
    result[swapIndex] = current;
  }
  return result;
}

/* ---------- 奖励与宝箱 ---------- */

/** 单个任务的灵石奖励（最小单位）：领取时的宗门等级 × 50 灵石（展示单位）。 */
export function dailyTaskReward(sectLevel: number): number {
  return Math.max(0, Math.floor(sectLevel)) * DAILY_TASK_STONE_PER_LEVEL * UNITS_PER_DISPLAY;
}

export interface DailyChestRoll {
  /** 玄铁个数（展示单位）。 */
  xuantie: number;
  /** 神木个数（展示单位）。 */
  shenmu: number;
  pillId: DailyChestPillId;
}

/**
 * 开日课宝箱（纯函数）：随机源取用顺序固定 —— 玄铁、神木、丹药各取一次。
 * random 取值 [0, 1)，由调用方注入（服务端传 Math.random，测试注入固定值）。
 */
export function rollDailyChest(random: () => number): DailyChestRoll {
  const xuantie = randomIntIn(DAILY_CHEST_XUANTIE_RANGE, random);
  const shenmu = randomIntIn(DAILY_CHEST_SHENMU_RANGE, random);
  const pillId = DAILY_CHEST_PILL_IDS[randomIndexOf(DAILY_CHEST_PILL_IDS.length, random)]!;
  return { xuantie, shenmu, pillId };
}

/** 闭区间内的均匀随机整数；random 贴近 1 时夹到上界。 */
function randomIntIn([min, max]: readonly [number, number], random: () => number): number {
  return min + Math.min(max - min, Math.floor(random() * (max - min + 1)));
}

/** [0, length) 内的均匀随机下标；random 贴近 1 时夹到末位。 */
function randomIndexOf(length: number, random: () => number): number {
  return Math.min(length - 1, Math.floor(random() * length));
}
