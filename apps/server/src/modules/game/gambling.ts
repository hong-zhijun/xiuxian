/**
 * 赌坊系统（论道赌局，第一版）——纯定义与纯计算。
 *
 * 与 alchemy.ts / challenge.ts 同一模式：规则是少量玩法常量，放在游戏模块代码里，
 * 不进 GameConfigContent，也不改公共配置哈希；赌坊面板通过登录后的 /game/sync 返回。
 *
 * 本文件只放纯定义和纯计算：不读数据库、不取时间（不调用 Date.now()）、不用随机数。
 * 解锁判断、赌注/奖励换算、每日次数归一、幸运侦查文案都集中在这里，
 * 复用于 sync 视图、daoDebate 写路径与 allocateDaoInsight 写路径。
 *
 * 金额一律是**最小单位整数**（1 展示单位 = 1000 最小单位，前端 formatAmount 会除）；
 * 倍率只能是 1 / 2 / 3 三档（计划 3）。论道的胜负**不在这里**判定（由 service 的 jev
 * 集成 + 降级胜率决定），本文件只提供降级胜率常量。
 */

import { dateKeyUtc8 } from './constants';

/** 赌坊解锁：宗门等级下限（不依赖建筑）。 */
export const GAMBLING_UNLOCK_SECT_LEVEL = 2;

/** 每日论道上限（UTC+8 自然日重置，全宗门共享计数）。 */
export const DEBATE_DAILY_LIMIT = 10;

/** 每个弟子悟道值的累计分配上限。 */
export const DAO_INSIGHT_CAP = 50;

/**
 * 属性上限：悟道值加点后任何属性都不得超过它（= 100）。
 * 直接复用仓库已有的 names.ts 常量（与 0016 迁移的 CHECK、历练的属性夹取同一口径），
 * 不在这里另造一份 100。
 */
export { ATTRIBUTE_MAX } from './names';

/** 赌注模式。 */
export type BetMode = 'preset_spirit_stone' | 'free_resource' | 'attribute';

/** 倍率（三档）。 */
export type Multiplier = 1 | 2 | 3;

/** 可赌资源白名单。 */
export const BETTABLE_RESOURCES = ['spiritStone', 'herb', 'ore'] as const;
export type BettableResource = (typeof BETTABLE_RESOURCES)[number];

/** 可赌属性白名单（同时也是悟道值可加点属性）。 */
export const BETTABLE_ATTRIBUTES = [
  'attack',
  'defense',
  'speed',
  'aptitude',
  'luck',
  'physique',
] as const;
export type BettableAttribute = (typeof BETTABLE_ATTRIBUTES)[number];

/** 属性展示名（侦查文案与结果文案共用，不在各处复制中文）。 */
export const ATTRIBUTE_LABELS: Record<BettableAttribute, string> = {
  attack: '攻击',
  defense: '防御',
  speed: '身法',
  aptitude: '资质',
  luck: '幸运',
  physique: '体魄',
};

/** 系统预设灵石赌注额（最小单位）。 */
export const PRESET_STAKES: Record<Multiplier, number> = { 1: 100000, 2: 200000, 3: 300000 };

/** 系统预设：赢的灵石奖励（最小单位）。 */
export const PRESET_RESOURCE_REWARDS: Record<Multiplier, number> = {
  1: 180000,
  2: 360000,
  3: 540000,
};

/** 系统预设：赢的悟道值奖励。 */
export const PRESET_INSIGHT_REWARDS: Record<Multiplier, number> = { 1: 1, 2: 2, 3: 3 };

/** 自由输入模式的最小赌注（最小单位 = 展示 10）。 */
export const FREE_BET_MIN = 10000;

/** 自由输入模式的赢倍率（赢得的资源 = 实际赌注 × 1.8，向下取整）。 */
export const FREE_BET_WIN_MULTIPLIER = 1.8;

/** 属性赌注：押上的属性点。 */
export const ATTRIBUTE_STAKES: Record<Multiplier, number> = { 1: 1, 2: 2, 3: 3 };

/** 属性赌注：赢的悟道值。 */
export const ATTRIBUTE_INSIGHT_REWARDS: Record<Multiplier, number> = { 1: 2, 2: 4, 3: 6 };

/**
 * 降级胜率（基点）：没有 OPENROUTER_API_KEY 或 Decisions 调用失败时使用。
 * 倍率越高押得越凶、对手越强，所以胜率越低（计划 4.4）。
 */
export const DEGRADED_WIN_RATES: Record<Multiplier, number> = { 1: 5000, 2: 4000, 3: 3000 };

/**
 * 倍率对应的对手强度描述（同时进 jev 状态文本与结果文案）。
 * 计划 4.1 的 multiplierHint 原文。
 */
export const MULTIPLIER_HINTS: Record<Multiplier, string> = {
  1: '势均力敌的对手',
  2: '略强于己的对手',
  3: '远超己身的对手',
};

/** 幸运侦查阈值：>= 70 给 1 条侦查提示。 */
export const LUCK_REVEAL_THRESHOLD_1 = 70;
/** 幸运侦查阈值：>= 85 给 2 条侦查提示。 */
export const LUCK_REVEAL_THRESHOLD_2 = 85;

/** 悟道值可分配到的属性白名单（与赌注属性相同，六项）。 */
export const INSIGHT_ALLOCATABLE_ATTRIBUTES = BETTABLE_ATTRIBUTES;

/** 未解锁时的统一文案（sync 视图与 daoDebate 报错共用同一句）。 */
export const GAMBLING_LOCKED_REASON = `赌坊尚未开启，需要宗门 ${GAMBLING_UNLOCK_SECT_LEVEL} 级`;

/** 解锁判断（只在服务端实现）：宗门等级达标即解锁，不依赖任何建筑。 */
export function isGamblingUnlocked(sectLevel: number): boolean {
  return sectLevel >= GAMBLING_UNLOCK_SECT_LEVEL;
}

/** 同一判断的文案版：解锁返回 null，否则返回 GAMBLING_LOCKED_REASON。 */
export function gamblingUnlockBlockedReason(sectLevel: number): string | null {
  return isGamblingUnlocked(sectLevel) ? null : GAMBLING_LOCKED_REASON;
}

/** 可赌资源白名单收窄（请求里的 resourceId 是自由字符串，必须过这一关）。 */
export function isBettableResource(value: string): value is BettableResource {
  return (BETTABLE_RESOURCES as readonly string[]).includes(value);
}

/** 自由输入模式的实际赌注 = 输入数量 × 倍率（整数，无小数）。 */
export function freeBetStake(amount: number, multiplier: Multiplier): number {
  return amount * multiplier;
}

/**
 * 自由输入模式的赢奖励 = floor(实际赌注 × 1.8)。
 * 用 Math.floor 截断到整数最小单位（计划 14.1：资源操作一律整数）。
 */
export function freeBetReward(amount: number, multiplier: Multiplier): number {
  return Math.floor(freeBetStake(amount, multiplier) * FREE_BET_WIN_MULTIPLIER);
}

/** 侦查数量：0 / 1 / 2（纯函数，只看幸运）。 */
export function revealCount(luck: number): number {
  if (luck >= LUCK_REVEAL_THRESHOLD_2) {
    return 2;
  }
  return luck >= LUCK_REVEAL_THRESHOLD_1 ? 1 : 0;
}

/**
 * 倍率决定对手强度基准（对手该项属性 ≈ 弟子该项属性 × 该系数）：
 * 倍率越高，模型之外展示给玩家的对手也越强，侦查文案才与「远强于己」的说法自洽。
 */
export const REVEAL_OPPONENT_FACTOR: Record<Multiplier, number> = { 1: 1, 2: 1.15, 3: 1.35 };

/**
 * 生成对手六项属性（纯展示）：基准 = 弟子属性 × 倍率系数，
 * 再加 ±15% 随机扰动让每次对手不完全一样，最终夹到 1~100。
 */
export function generateOpponentAttrs(
  discipleAttrs: Record<BettableAttribute, number>,
  multiplier: Multiplier,
): Record<BettableAttribute, number> {
  const result = {} as Record<BettableAttribute, number>;
  for (const attr of BETTABLE_ATTRIBUTES) {
    const base = (Number(discipleAttrs[attr]) || 0) * REVEAL_OPPONENT_FACTOR[multiplier];
    const jitter = 0.85 + Math.random() * 0.3;
    result[attr] = Math.max(1, Math.min(100, Math.round(base * jitter)));
  }
  return result;
}

/** 侦查结论阈值（弟子值 / 对手基准值）；从高到低判定。 */
const REVEAL_VERDICTS: readonly { min: number; text: string }[] = [
  { min: 1.2, text: '远不如你' },
  { min: 1.02, text: '略逊于你' },
  { min: 0.98, text: '与你相当' },
  { min: 0.8, text: '略强于你' },
  { min: 0, text: '远超你' },
];

/**
 * 生成侦查文案（纯函数，计划 4.5）。
 *
 * - 数量由幸运决定（revealCount）；幸运不足时不返回任何提示；
 * - **不调用 jev、不影响胜负**：文案只按「弟子属性 + 倍率」确定性生成，
 *   本轮看哪几项由 `倍率 + luck / 20` 的偏移决定（同一弟子同一倍率结果稳定，
 *   不同弟子/不同倍率看到的项不同），对手基准 = 弟子该项属性 × 倍率系数。
 */
export function generateRevealHints(
  discipleAttrs: Record<BettableAttribute, number>,
  multiplier: Multiplier,
  luck: number,
): string[] {
  const count = revealCount(luck);
  if (count === 0) {
    return [];
  }
  const offset = (multiplier - 1 + Math.floor(luck / 20)) % BETTABLE_ATTRIBUTES.length;
  const hints: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const attribute =
      BETTABLE_ATTRIBUTES[(offset + index) % BETTABLE_ATTRIBUTES.length] ?? 'attack';
    const mine = Number(discipleAttrs[attribute]) || 0;
    const opponent = mine * REVEAL_OPPONENT_FACTOR[multiplier];
    const ratio = opponent > 0 ? mine / opponent : 1;
    const verdict =
      REVEAL_VERDICTS.find((item) => ratio >= item.min)?.text ?? '远超你';
    hints.push(`对手${ATTRIBUTE_LABELS[attribute]}${verdict}`);
  }
  return hints;
}

/** 论道计数的最小行形状（sects 行的 debate_* 两列）。 */
export interface DebateDayCountRow {
  debate_date_key: string;
  debate_count: number;
}

/** 论道当日次数状态（与 challenge.ts 的 ChallengeDayState 同一模式）。 */
export interface DebateDayState {
  /** 本次请求的 UTC+8 日期键。 */
  dateKey: string;
  /** 归一化后的当日已受理次数（0..DEBATE_DAILY_LIMIT）。 */
  usedToday: number;
  /** 当日剩余次数 = max(0, 上限 - usedToday)。 */
  remaining: number;
  /** 宗门行的日期键是否就是今天；false 时 usedToday 视为 0（跨天重置）。 */
  keyMatches: boolean;
}

/**
 * 宗门行口径的当日已用次数：日期键与今天一致取 debate_count，否则视为 0（跨天重置）。
 * 与挑战不同，赌坊是 0019 新表新列，不存在需要按日志窗口兼容核对的旧记录。
 */
export function debateDayStateOf(sect: DebateDayCountRow, now: number): DebateDayState {
  const dateKey = dateKeyUtc8(now);
  const keyMatches = sect.debate_date_key === dateKey;
  const raw = keyMatches ? Number(sect.debate_count) : 0;
  const usedToday = Math.min(DEBATE_DAILY_LIMIT, Math.max(0, raw));
  return {
    dateKey,
    usedToday,
    remaining: Math.max(0, DEBATE_DAILY_LIMIT - usedToday),
    keyMatches,
  };
}
