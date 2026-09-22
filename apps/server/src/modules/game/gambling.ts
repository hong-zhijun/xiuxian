/**
 * 赌坊系统（论道赌局，第一版）——纯定义与纯计算。
 *
 * 与 alchemy.ts / challenge.ts 同一模式：规则是少量玩法常量，放在游戏模块代码里，
 * 不进 GameConfigContent，也不改公共配置哈希；赌坊面板通过登录后的 /game/sync 返回。
 *
 * 本文件只放纯定义和纯计算：不读数据库、不取时间（不调用 Date.now()）；随机只出现在两处 ——
 * 论道对手属性（Math.random，只影响本轮对手）与天机轮格局（seed 驱动的线性同余，必须可复现）。
 * 解锁判断、赌注/奖励换算、每日次数归一、幸运侦查文案都集中在这里，
 * 复用于 sync 视图、daoDebate 写路径与 allocateDaoInsight 写路径。
 *
 * 金额一律是**最小单位整数**（1 展示单位 = 1000 最小单位，前端 formatAmount 会除）；
 * 倍率只能是 1 / 2 / 3 三档（计划 3）。论道的胜负**不在这里**判定（由 service 的 jev
 * 集成 + 降级胜率决定），本文件只提供降级胜率常量。
 */

import { PILL_IDS, type PillId } from './alchemy';
import { dateKeyUtc8 } from './constants';

/** 赌坊解锁：宗门等级下限（不依赖建筑）。 */
export const GAMBLING_UNLOCK_SECT_LEVEL = 2;

/** 每日次数上限（UTC+8 自然日重置，全宗门共享计数）：论道赌局与天机轮**共享**这 20 次。 */
export const DEBATE_DAILY_LIMIT = 20;

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
 * 与 DEBATE_TIER_PROBABILITIES 的中间档对齐：50/42/34。
 */
export const DEGRADED_WIN_RATES: Record<Multiplier, number> = { 1: 5000, 2: 4200, 3: 3400 };

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
 * 倍率决定对手总体强度（对手六项属性之和 ≈ 弟子六项之和 × 该系数）。
 * 1x 势均力敌，2x 略强，3x 明显强但不至于碾压。
 */
export const REVEAL_OPPONENT_FACTOR: Record<Multiplier, number> = { 1: 1.00, 2: 1.12, 3: 1.25 };

/**
 * 每项属性的独立权重幅度：权重在 [1-spread, 1+spread] 间均匀随机，
 * 再归一化让六项之和精确等于目标总值。这样对手有长短板而不是均匀拉高。
 */
export const OPPONENT_WEIGHT_SPREAD = 0.40;

/**
 * 生成对手六项属性（纯展示 + 送入 jev）。
 *
 * 1. 先给每项一个 [1-spread, 1+spread] 的随机权重；
 * 2. 算目标总值 = 弟子六项之和 × 倍率系数；
 * 3. 把权重归一化使 Σ(弟子[i] × w[i]) = 目标总值；
 * 4. 对手[i] = round(弟子[i] × w[i])，保底 1，不封顶（弟子封 100 但对手不必）。
 */
export function generateOpponentAttrs(
  discipleAttrs: Record<BettableAttribute, number>,
  multiplier: Multiplier,
): Record<BettableAttribute, number> {
  const factor = REVEAL_OPPONENT_FACTOR[multiplier];
  const spread = OPPONENT_WEIGHT_SPREAD;

  const rawWeights: number[] = [];
  for (let i = 0; i < BETTABLE_ATTRIBUTES.length; i++) {
    rawWeights.push(1 - spread + Math.random() * 2 * spread);
  }

  let discipleTotal = 0;
  let weightedTotal = 0;
  for (let i = 0; i < BETTABLE_ATTRIBUTES.length; i++) {
    const v = Number(discipleAttrs[BETTABLE_ATTRIBUTES[i]!]) || 0;
    discipleTotal += v;
    weightedTotal += v * rawWeights[i]!;
  }

  const targetTotal = discipleTotal * factor;
  const scale = weightedTotal > 0 ? targetTotal / weightedTotal : 1;

  const result = {} as Record<BettableAttribute, number>;
  for (let i = 0; i < BETTABLE_ATTRIBUTES.length; i++) {
    const attr = BETTABLE_ATTRIBUTES[i]!;
    const v = Number(discipleAttrs[attr]) || 0;
    result[attr] = Math.max(1, Math.round(v * rawWeights[i]! * scale));
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

/* ---------- 五档胜率（choice 题型 → 概率映射） ---------- */

/** jev choice 题的五个档位 key（从弟子优势到对手优势）。 */
export const DEBATE_TIER_KEYS = [
  'disciple_clear',
  'disciple_slight',
  'even',
  'opponent_slight',
  'opponent_clear',
] as const;
export type DebateTier = (typeof DEBATE_TIER_KEYS)[number];

/** 每个档位对应的固定胜率。 */
export const DEBATE_TIER_PROBABILITIES: Record<DebateTier, number> = {
  disciple_clear: 0.65,
  disciple_slight: 0.55,
  even: 0.50,
  opponent_slight: 0.42,
  opponent_clear: 0.34,
};

/** 倍率锚：防止模型把不同倍率都判成同一档导致梯度丢失。 */
export const DEBATE_TIER_ANCHOR: Record<Multiplier, number> = { 1: 0.50, 2: 0.42, 3: 0.34 };
export const DEBATE_TIER_ANCHOR_RANGE = 0.06;

/**
 * 根据 jev 返回的 choice probabilities 加权计算胜率，再用倍率锚 clamp。
 *
 * p = Σ(档位概率 × 模型给的档位权重)，归一化后 clamp 到 [anchor - range, anchor + range]。
 * 返回 null 表示输入无效（触发降级）。
 */
export function debateTierProbability(
  probabilities: Record<string, number> | undefined,
  multiplier: Multiplier,
): number | null {
  if (probabilities === undefined) return null;

  let weightedSum = 0;
  let totalWeight = 0;
  for (const tier of DEBATE_TIER_KEYS) {
    const w = Number(probabilities[tier]);
    if (!Number.isFinite(w) || w < 0) continue;
    weightedSum += DEBATE_TIER_PROBABILITIES[tier] * w;
    totalWeight += w;
  }
  if (totalWeight <= 0) return null;

  const raw = weightedSum / totalWeight;
  const anchor = DEBATE_TIER_ANCHOR[multiplier];
  const lo = anchor - DEBATE_TIER_ANCHOR_RANGE;
  const hi = anchor + DEBATE_TIER_ANCHOR_RANGE;
  return Math.min(hi, Math.max(lo, raw));
}

/* ---------- 天机轮（0020 迁移 + 计划 2）：8 格转盘 ---------- */

/** 转盘格数（8 等分，每格 45°）。 */
export const WHEEL_SLOT_COUNT = 8;

/** 投入档位（1x~5x）；费用 = WHEEL_SPIN_COST × 档位。 */
export const WHEEL_TIERS = [1, 2, 3, 4, 5] as const;
export type WheelTier = (typeof WHEEL_TIERS)[number];

/** 1x 档费用（最小单位 = 展示 50）。 */
export const WHEEL_SPIN_COST = 50_000;

/** 重置费用（最小单位 = 展示 100）；重置不消耗每日次数，也不限次数。 */
export const WHEEL_RESET_COST = 100_000;

/** 格子倍率范围（含两端，一位小数）。 */
export const WHEEL_MULTIPLIER_MIN = 0.8;
export const WHEEL_MULTIPLIER_MAX = 1.5;

/** 大额灵石格的额外倍率：奖励 = 投入 × 格子倍率 × 3。 */
export const WHEEL_BIG_MULTIPLIER = 3;

/** 各格子类型的落格权重：大奖概率低、谢谢惠顾概率偏高、普通格居中。 */
export const WHEEL_SLOT_WEIGHTS: Record<WheelSlotType, number> = {
  big_spirit_stone: 1,
  spirit_stone: 2,
  herb: 2,
  ore: 2,
  pill: 2,
  nothing: 3,
};

/** 根据格子列表的类型权重做加权随机选格，返回命中的下标。 */
export function wheelWeightedPick(slots: readonly WheelSlot[], roll: number): number {
  let total = 0;
  for (const slot of slots) total += WHEEL_SLOT_WEIGHTS[slot.type];
  const target = roll * total;
  let acc = 0;
  for (let i = 0; i < slots.length; i++) {
    acc += WHEEL_SLOT_WEIGHTS[slots[i]!.type];
    if (target < acc) return i;
  }
  return slots.length - 1;
}

/** 大额灵石固定 1 格。 */
export const WHEEL_BIG_SLOTS = 1;
/** 谢谢惠顾固定 2 格。 */
export const WHEEL_NOTHING_SLOTS = 2;
/** 小额灵石的随机格数；剩下的 1~3 格给草药/矿石/丹药。 */
export const WHEEL_SMALL_SLOTS_MIN = 2;
export const WHEEL_SMALL_SLOTS_MAX = 4;

/** 特殊格（草药 / 矿石 / 丹药）的候选类型：每种最多出现 1 格。 */
const WHEEL_SPECIAL_TYPES = ['herb', 'ore', 'pill'] as const;

/** 格子类型（与计划 4.1 的 view 口径一致）。 */
export type WheelSlotType =
  | 'spirit_stone'
  | 'big_spirit_stone'
  | 'herb'
  | 'ore'
  | 'pill'
  | 'nothing';

/** 一个转盘格：类型 + 倍率 + 丹药（格局由 seed 确定性生成）。 */
export interface WheelSlot {
  type: WheelSlotType;
  /**
   * 格子倍率（0.8~1.5，一位小数）；谢谢惠顾为 0。
   * 丹药格也带倍率（格局只由 seed 决定，同一 seed 每次一样），但**不参与奖励计算**：
   * 丹药数量只跟投入档位走（计划 2.6）。
   */
  multiplier: number;
  /** 丹药格命中的丹药 id（同样由 seed 决定，所以格面文案稳定）；非丹药格为 null。 */
  pillId: PillId | null;
}

/** 转盘奖励（写入 dao_debate_log.reward_detail，口径见计划 3.2）。 */
export type WheelRewardDetail =
  | { type: 'resource'; resourceId: string; amount: string }
  | { type: 'pill'; pillId: string; quantity: number }
  | { type: 'none' };

/** 某一档的转动费用（最小单位）= 1x 费用 × 档位。 */
export function wheelSpinCost(tier: WheelTier): number {
  return WHEEL_SPIN_COST * tier;
}

/**
 * 32 位无符号线性同余伪随机（Numerical Recipes 系数）。
 * 全程整数运算（Math.imul）→ 跨平台一致，同一个 seed 永远给出同一串数。
 * 这里刻意**不用** Math.random：格局必须可复现（计划 6.1）。
 */
function wheelRandomOf(seed: number): () => number {
  let state = Math.floor(seed) >>> 0;
  if (state === 0) {
    // seed 0（新宗门）也必须有一个有效状态，否则整串随机数恒为 0。
    state = 0x9e3779b9;
  }
  const nextState = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  // 暖机两次再开始取值：LCG 的头两个输出与 seed 的高位强相关（小 seed 时连乘都没进位，
  // 第一个取值会稳定落在同一个区间）。生产路径的 seed 是 wheelLayoutSeed 的大整数混合结果，
  // 本来就不会踩到这一点；暖机是为了让 generateWheelSlots 对任意 seed（含单测里 0~N 的小整数）
  // 都给出打散的格局。
  nextState();
  nextState();
  return () => nextState() / 4_294_967_296;
}

/** 闭区间 [min, max] 的确定性整数（random() 恒 < 1，所以不会溢出上界）。 */
function wheelInt(random: () => number, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1));
}

/** 确定性 Fisher–Yates 洗牌（用自己那串随机数，不动全局 Math.random）。 */
function wheelShuffle<T>(random: () => number, items: readonly T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = wheelInt(random, 0, i);
    const swap = result[i]!;
    result[i] = result[j]!;
    result[j] = swap;
  }
  return result;
}

/**
 * 转盘格局种子 = 宗门 id 与 wheel_seed 的混合（纯函数，计划 3.1）。
 *
 * sect_id 走一遍 FNV-1a 32 位哈希再与 wheel_seed 混合：不同宗门、同一宗门的不同 seed
 * 都会得到不同格局；同一 (sect_id, wheel_seed) 永远一致 —— 所以每次 sync 下发的转盘都一样，
 * 只有重置（wheel_seed + 1）才变。
 */
export function wheelLayoutSeed(sectId: string, wheelSeed: number): number {
  let hash = 2166136261;
  for (let i = 0; i < sectId.length; i += 1) {
    hash = Math.imul(hash ^ sectId.charCodeAt(i), 16777619);
  }
  const seed = (Number.isFinite(wheelSeed) ? Math.floor(wheelSeed) : 0) >>> 0;
  return (hash ^ Math.imul(seed + 1, 2654435761)) >>> 0;
}

/**
 * 生成 8 格转盘格局（**确定性纯函数**：同一个 seed 永远同一布局，计划 2.1）。
 *
 * 固定：大额灵石 1 格 + 谢谢惠顾 2 格；随机：小额灵石 2~4 格，
 * 剩下的 1~3 格从草药 / 矿石 / 丹药里取（每种最多 1 格）。
 * 格子排布、每格倍率与丹药种类全部由 seed 决定，所以重启、换设备都不会让转盘变样。
 */
export function generateWheelSlots(seed: number): WheelSlot[] {
  const random = wheelRandomOf(seed);

  const smallCount = wheelInt(random, WHEEL_SMALL_SLOTS_MIN, WHEEL_SMALL_SLOTS_MAX);
  const specialCount = WHEEL_SLOT_COUNT - WHEEL_BIG_SLOTS - WHEEL_NOTHING_SLOTS - smallCount;
  const specials = wheelShuffle(random, WHEEL_SPECIAL_TYPES).slice(0, specialCount);

  // 固定格 + 随机格一共正好 8 格（2~4 格小额时剩余 1~3 格特殊格）。
  const types: WheelSlotType[] = [
    'big_spirit_stone',
    ...Array<WheelSlotType>(WHEEL_NOTHING_SLOTS).fill('nothing'),
    ...Array<WheelSlotType>(smallCount).fill('spirit_stone'),
    ...specials,
  ];

  return wheelShuffle(random, types).map((type) => {
    if (type === 'nothing') {
      return { type, multiplier: 0, pillId: null };
    }
    // 倍率只取一位小数：0.8 / 0.9 / … / 1.5（8 档均匀取）。
    const multiplier =
      (WHEEL_MULTIPLIER_MIN * 10 +
        wheelInt(random, 0, Math.round((WHEEL_MULTIPLIER_MAX - WHEEL_MULTIPLIER_MIN) * 10))) /
      10;
    if (type === 'pill') {
      return {
        type,
        multiplier,
        pillId: PILL_IDS[wheelInt(random, 0, PILL_IDS.length - 1)] ?? null,
      };
    }
    return { type, multiplier, pillId: null };
  });
}

/**
 * 格面文案（计划 4.1 的 label）：服务端拼好，前端只渲染。
 *
 * 资源名与丹药名由调用方传进来 —— 唯一一份中文名词表在配置与 alchemy.ts，
 * 这里不复制第二份。大额灵石显示的是**实际结算倍率**（格子倍率 × 3），
 * 玩家一眼就能看出这格更肥；丹药格显示数量随档位走（×1~5）。
 */
export function wheelSlotLabel(
  slot: WheelSlot,
  names: { resource: (resourceId: string) => string; pill: (pillId: string) => string },
): string {
  switch (slot.type) {
    case 'nothing':
      return '谢谢惠顾';
    case 'pill':
      return slot.pillId === null ? '丹药' : `${names.pill(slot.pillId)} ×1~${String(WHEEL_TIERS.length)}`;
    case 'big_spirit_stone':
      return `${names.resource('spiritStone')} ×${(slot.multiplier * WHEEL_BIG_MULTIPLIER).toFixed(1)}`;
    case 'herb':
    case 'ore':
      return `${names.resource(slot.type)} ×${slot.multiplier.toFixed(1)}`;
    default:
      return `${names.resource('spiritStone')} ×${slot.multiplier.toFixed(1)}`;
  }
}

/**
 * 结算一格奖励（纯函数，计划 2.6）。
 *
 * 金额一律是**最小单位整数**：资源类 = floor(投入 × 格子倍率)，大额灵石再 ×3；
 * 丹药 = 投入档位颗数（1x→1 颗 … 5x→5 颗），**不受格子倍率影响**；谢谢惠顾 = 无奖励。
 */
export function wheelReward(slot: WheelSlot, tier: WheelTier, cost: number): WheelRewardDetail {
  if (slot.type === 'nothing') {
    return { type: 'none' };
  }
  if (slot.type === 'pill') {
    return slot.pillId === null
      ? { type: 'none' }
      : { type: 'pill', pillId: slot.pillId, quantity: tier };
  }
  const multiplier =
    slot.type === 'big_spirit_stone' ? slot.multiplier * WHEEL_BIG_MULTIPLIER : slot.multiplier;
  return {
    type: 'resource',
    // 两种灵石格都落到同一个资源 'spiritStone'（big_spirit_stone 只是更肥的那一格，
    // 不是另一种资源 —— 否则会在 resource_balances 里凭空多出一条配置里没有的余额）。
    resourceId: slot.type === 'herb' || slot.type === 'ore' ? slot.type : 'spiritStone',
    // 投入是 50000 的倍数、倍率是一位小数 → 数学上的积一定是 5000 的整数倍；
    // 这里加的 1e-6 只是消掉 0.1 的二进制表示带来的浮点噪声（否则会莫名少 1 点最小单位）。
    amount: String(Math.floor(cost * multiplier + 1e-6)),
  };
}
