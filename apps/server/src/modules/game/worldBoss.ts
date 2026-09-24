import { ARENA_COMBAT_BONUS_BP_PER_LEVEL } from './realms';

/**
 * 世界 Boss（讨伐）的纯规则（docs/世界Boss开发计划.md 第 1、3.1 节）。
 *
 * 与 gambling.ts / journey.ts 同一做法：这里只有常量与纯函数 —— 不读库、不取时间、
 * 不调用 Math.random（随机源通过参数注入），定义硬编码在代码里、不进 game-config。
 *
 * 金额一律是**最小单位**（1 展示单位 = 1000 最小单位）。
 */
export const WORLD_BOSS_DAILY_ATTACKS = 3;
/** 每次出手派出的弟子人数。 */
export const WORLD_BOSS_MIN_PARTY = 1;
export const WORLD_BOSS_MAX_PARTY = 3;

/** 时间线（UTC+8 小时）：08:00 出现、22:00 力竭、23:00 逃走。 */
export const WORLD_BOSS_OPEN_HOUR = 8;
export const WORLD_BOSS_FRENZY_HOUR = 22;
export const WORLD_BOSS_CLOSE_HOUR = 23;

/** 力竭期伤害倍率（22:00~23:00）。 */
export const WORLD_BOSS_FRENZY_MULTIPLIER = 1.5;

/** 暴击倍率与暴击率上限（luck 1~100 → 最高 20%）。 */
export const WORLD_BOSS_CRIT_MULTIPLIER = 1.5;
export const WORLD_BOSS_CRIT_RATE_MAX = 0.2;

/** 伤害浮动区间（均匀随机）。 */
export const WORLD_BOSS_FLUCTUATION_MIN = 0.8;
export const WORLD_BOSS_FLUCTUATION_MAX = 1.2;

/** 只为数字好看：伤害与血量都按同一个比例放大。 */
export const WORLD_BOSS_DAMAGE_SCALE = 100;

/** 血量下限。 */
export const WORLD_BOSS_MIN_HP = 10_000;

/** 打掉这个比例以上算「击退」（而不是单纯逃走）。 */
export const WORLD_BOSS_FLED_THRESHOLD = 0.7;

/** 击退时奖池减半。 */
export const WORLD_BOSS_FLED_POOL_FACTOR = 0.5;

/** 参与奖 / 保底份的产量系数（相对该宗门的每小时产出）。 */
export const WORLD_BOSS_PARTICIPATION_RATE_FACTOR = 0.25;
export const WORLD_BOSS_KILL_POOL_RATE_FACTOR = 1.5;
export const WORLD_BOSS_LAST_HIT_RATE_FACTOR = 0.5;

/** 保底 = 10 × 宗门等级 × 1000（最小单位）。 */
export const WORLD_BOSS_REWARD_FLOOR_UNIT = 10 * 1000;

/** 击杀奖池涉及的资源（按资源分别求和，与配置里的资源 id 对应）。 */
export const WORLD_BOSS_POOL_RESOURCES = ['spiritStone', 'herb', 'ore'] as const;

/** 击杀时必发的丹药（每参与宗门）。 */
export const WORLD_BOSS_KILL_PILL_ID = 'cultivationPill';
/** 当日伤害最高者的额外丹药。 */
export const WORLD_BOSS_TOP_DAMAGE_PILL_ID = 'bodyTemperingPill';

export interface WorldBossDef {
  index: number;
  name: string;
  /** 印章字（圆形印章中间的那个字）。 */
  sealCharacter: string;
  /** 主色（印章与血条的强调色）。 */
  color: string;
  description: string;
}

/** 五只轮换 Boss，按 dayIndex % 5 取用。 */
export const WORLD_BOSSES: readonly WorldBossDef[] = [
  {
    index: 0,
    name: '黑风妖王',
    sealCharacter: '风',
    color: '#7a8c6e',
    description: '盘踞黑风岭的老妖，一口妖风可卷走半座山门。',
  },
  {
    index: 1,
    name: '赤炎火蛟',
    sealCharacter: '蛟',
    color: '#e0654f',
    description: '生于地火熔窟，所过之处草木成灰。',
  },
  {
    index: 2,
    name: '九幽冥蛛',
    sealCharacter: '蛛',
    color: '#8a6bb8',
    description: '自九幽裂隙爬出，丝网能缚住元婴修士的神识。',
  },
  {
    index: 3,
    name: '玄冰狼王',
    sealCharacter: '狼',
    color: '#6fb6d9',
    description: '统领北境狼群，啸声所至万物结霜。',
  },
  {
    index: 4,
    name: '裂山石魔',
    sealCharacter: '魔',
    color: '#b08a5a',
    description: '上古山魂所化，一拳可崩裂峰峦。',
  },
];

/** 等级 1~5 对应的血量系数（1.4 节的表）。 */
const LEVEL_HP_COEFFICIENTS: readonly number[] = [0.8, 0.9, 1.0, 1.1, 1.2];

/** 中文阶数，与 REALMS 的写法一致（一~五）。 */
const LEVEL_NAMES: readonly string[] = ['一', '二', '三', '四', '五'];

export const WORLD_BOSS_MIN_LEVEL = 1;
export const WORLD_BOSS_MAX_LEVEL = LEVEL_HP_COEFFICIENTS.length;

/** Boss 阶段：未出现 / 讨伐中 / 力竭中 / 已结束。 */
export type WorldBossPhase = 'before' | 'open' | 'frenzy' | 'closed';

/**
 * 阶段判定（UTC+8 小时整数）：
 * 08:00 前 before；08:00~22:00 open；22:00~23:00 frenzy；23:00 起 closed。
 */
export function worldBossPhaseOf(now: number): WorldBossPhase {
  const hour = new Date(now + 8 * 3_600_000).getUTCHours();
  if (hour < WORLD_BOSS_OPEN_HOUR) return 'before';
  if (hour >= WORLD_BOSS_CLOSE_HOUR) return 'closed';
  if (hour >= WORLD_BOSS_FRENZY_HOUR) return 'frenzy';
  return 'open';
}

/** 可以出手的阶段（力竭期仍能出手，只是伤害更高）。 */
export function isWorldBossAttackable(phase: WorldBossPhase): boolean {
  return phase === 'open' || phase === 'frenzy';
}

/** 当天 UTC+8 日期距 1970-01-01 的天数（轮换下标用）。 */
export function dayIndexUtc8(now: number): number {
  return Math.floor((now + 8 * 3_600_000) / 86_400_000);
}

/** 当天出现的 Boss 下标。 */
export function worldBossIndexFor(now: number): number {
  const index = dayIndexUtc8(now) % WORLD_BOSSES.length;
  return index < 0 ? index + WORLD_BOSSES.length : index;
}

export function worldBossDefAt(index: number): WorldBossDef {
  const normalized =
    ((index % WORLD_BOSSES.length) + WORLD_BOSSES.length) % WORLD_BOSSES.length;
  return WORLD_BOSSES[normalized]!;
}

/** 等级夹取到 1~5（脏数据退化为 1）。 */
export function clampBossLevel(level: number): number {
  if (!Number.isFinite(level)) return WORLD_BOSS_MIN_LEVEL;
  return Math.min(WORLD_BOSS_MAX_LEVEL, Math.max(WORLD_BOSS_MIN_LEVEL, Math.floor(level)));
}

/**
 * 当天等级：前一天被击杀则 +1，否则 −1，夹取 1~5；没有前一天记录则为 1。
 */
export function nextBossLevel(prevLevel: number | null, prevKilled: boolean): number {
  if (prevLevel === null) return WORLD_BOSS_MIN_LEVEL;
  return clampBossLevel(clampBossLevel(prevLevel) + (prevKilled ? 1 : -1));
}

/** 血量系数。 */
export function bossHpCoefficient(level: number): number {
  return LEVEL_HP_COEFFICIENTS[clampBossLevel(level) - 1]!;
}

/** 奖励加成 = 1 + 0.1 ×（Boss 等级 − 1）。 */
export function bossRewardMultiplier(level: number): number {
  return 1 + 0.1 * (clampBossLevel(level) - 1);
}

/** 显示名带等级：黑风妖王 · 三阶。 */
export function bossDisplayName(index: number, level: number): string {
  const def = worldBossDefAt(index);
  const name = LEVEL_NAMES[clampBossLevel(level) - 1]!;
  return `${def.name} · ${name}阶`;
}

/**
 * Boss 血量 = max(10000, floor(Σ 各活跃宗门的理论日伤害 × 血量系数))。
 * `sectTheoreticals` 是**已经算好**的每宗门理论日伤害（不含浮动/暴击/力竭的期望值）。
 */
export function computeMaxHp(sectTheoreticals: readonly number[], level: number): number {
  const total = sectTheoreticals.reduce((sum, value) => sum + Math.max(0, value), 0);
  return Math.max(WORLD_BOSS_MIN_HP, Math.floor(total * bossHpCoefficient(level)));
}

/** 单宗门理论日伤害（期望值：不计浮动/暴击/力竭，按 1.0 算）。 */
export function theoreticalDailyDamage(input: {
  /** 该宗门战力最高的 3 名弟子的 partyCombatPower 之和。 */
  topPartyPower: number;
  /** 演武场等级。 */
  arenaLevel: number;
  /** 每日出手次数。 */
  dailyAttacks?: number;
}): number {
  const attacks = input.dailyAttacks ?? WORLD_BOSS_DAILY_ATTACKS;
  const arenaMultiplier = arenaCombatMultiplier(input.arenaLevel);
  return Math.floor(input.topPartyPower * arenaMultiplier * attacks * WORLD_BOSS_DAMAGE_SCALE);
}

/** 演武场加成 = 1 + 演武场等级 × 0.1（复用每级 1000 基点）。 */
export function arenaCombatMultiplier(arenaLevel: number): number {
  return 1 + (arenaLevel * ARENA_COMBAT_BONUS_BP_PER_LEVEL) / 10_000;
}

/**
 * 一次出手的伤害与是否暴击。
 *
 * 伤害 = floor(队伍战力 × 演武场加成 × 浮动 × 暴击倍率 × 力竭倍率 × DAMAGE_SCALE)
 * 浮动 = 0.8~1.2 均匀随机；暴击率 = luck 平均值 / 100 × 20%，暴击倍率 1.5。
 *
 * 随机源按固定顺序取用：先浮动、后暴击判定（测试可据此注入固定序列）。
 */
export function rollDamage(input: {
  partyPower: number;
  arenaLevel: number;
  /** 出战弟子的 luck 平均值。 */
  avgLuck: number;
  /** 是否处于力竭期（22:00~23:00）。 */
  frenzy: boolean;
  random: () => number;
}): { damage: number; crit: boolean } {
  const fluctuation =
    WORLD_BOSS_FLUCTUATION_MIN +
    input.random() * (WORLD_BOSS_FLUCTUATION_MAX - WORLD_BOSS_FLUCTUATION_MIN);
  const critRate = (input.avgLuck / 100) * WORLD_BOSS_CRIT_RATE_MAX;
  const crit = input.random() < critRate;
  const damage = Math.floor(
    input.partyPower *
      arenaCombatMultiplier(input.arenaLevel) *
      fluctuation *
      (crit ? WORLD_BOSS_CRIT_MULTIPLIER : 1) *
      (input.frenzy ? WORLD_BOSS_FRENZY_MULTIPLIER : 1) *
      WORLD_BOSS_DAMAGE_SCALE,
  );
  return { damage, crit };
}

/** 保底(L) = 10 × 宗门等级 × 1000（最小单位）。 */
export function rewardFloor(sectLevel: number): number {
  return WORLD_BOSS_REWARD_FLOOR_UNIT * Math.max(1, Math.floor(sectLevel));
}

/** 参与奖（每次出手立即发）：灵石 max(rate×0.25, 保底) × 加成。 */
export function participationReward(
  rateStone: number,
  sectLevel: number,
  bossLevel: number,
): number {
  const base = Math.max(
    rateStone * WORLD_BOSS_PARTICIPATION_RATE_FACTOR,
    rewardFloor(sectLevel),
  );
  return Math.floor(base * bossRewardMultiplier(bossLevel));
}

/** 最后一击奖：灵石 max(rate×0.5, 保底) × 加成。 */
export function lastHitReward(rateStone: number, sectLevel: number, bossLevel: number): number {
  const base = Math.max(rateStone * WORLD_BOSS_LAST_HIT_RATE_FACTOR, rewardFloor(sectLevel));
  return Math.floor(base * bossRewardMultiplier(bossLevel));
}

/**
 * 击杀奖池里某宗门的「基础份」：灵石/药材/矿石各 max(rate(r)×1.5, 保底) × 加成。
 * `rates` 缺项按 0 算（该宗门没有这项产出时只吃保底）。
 */
export function killPoolBaseShare(
  rates: Readonly<Record<string, number>>,
  sectLevel: number,
  bossLevel: number,
): Record<string, number> {
  const share: Record<string, number> = {};
  for (const resourceId of WORLD_BOSS_POOL_RESOURCES) {
    const rate = rates[resourceId] ?? 0;
    const base = Math.max(rate * WORLD_BOSS_KILL_POOL_RATE_FACTOR, rewardFloor(sectLevel));
    share[resourceId] = Math.floor(base * bossRewardMultiplier(bossLevel));
  }
  return share;
}

/** 击退时奖池减半。 */
export function halvePool(pool: number): number {
  return Math.floor(pool * WORLD_BOSS_FLED_POOL_FACTOR);
}

/**
 * 按伤害占比分奖池（向下取整）：
 * 每个宗门分得 floor(奖池 × 该宗门伤害 / 总伤害)，总和天然不超过奖池。
 */
export function splitPool(pool: number, damages: readonly number[]): number[] {
  const total = damages.reduce((sum, damage) => sum + Math.max(0, damage), 0);
  if (total <= 0 || pool <= 0) {
    return damages.map(() => 0);
  }
  return damages.map((damage) => Math.floor((pool * Math.max(0, damage)) / total));
}

/** 已击退？打掉的血量比例达到阈值（含）。 */
export function isFledByDamage(maxHp: number, hp: number): boolean {
  if (maxHp <= 0) return false;
  return (maxHp - hp) / maxHp >= WORLD_BOSS_FLED_THRESHOLD;
}
