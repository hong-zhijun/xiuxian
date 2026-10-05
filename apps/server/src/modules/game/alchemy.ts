/**
 * 丹药系统（v1 可玩闭环）——纯定义与纯计算。
 *
 * 与 events.ts / realms.ts 的特定玩法定义同理：配方是少量功能规则，放在游戏模块代码里，
 * 不进 GameConfigContent，也不改公共配置哈希。丹药视图通过登录后的 /game/sync 返回。
 *
 * 本文件只放纯定义和纯计算：不读数据库、不取时间（不调用 Date.now()）、不用随机数。
 * 解锁判断、短板选择等服务端规则都集中在这里，复用于 sync 视图与 craft/use 写路径。
 */

import { talentBonusBp } from './talents';

/** 炼丹解锁：宗门等级下限。 */
export const ALCHEMY_UNLOCK_SECT_LEVEL = 2;
/** 炼丹解锁：附属建筑（灵药园）id；第一版不新增独立炼丹房。 */
export const ALCHEMY_UNLOCK_BUILDING_ID = 'herbGarden';
/** 炼丹解锁：灵药园等级下限。 */
export const ALCHEMY_UNLOCK_BUILDING_LEVEL = 2;
/** 每名弟子最多服用淬体丹次数。 */
export const BODY_TEMPERING_MAX_USES = 10;
/** 单次炼制的数量上限（成本按数量线性相乘，写库语句数与数量无关）。 */
export const MAX_CRAFT_QUANTITY = 99;
/** 单次服药请求的颗数上限（服务端还会按「服到满所需」与库存再截断）。 */
export const MAX_PILL_USE_COUNT = 1000;
/** 聚气丹每颗增加的当前阶段修为。 */
export const CULTIVATION_PILL_GAIN = 120;
/** 凝元丹（大聚气丹）每颗增加的修为 = 10 颗聚气丹；配方也正好是聚气丹的 10 倍。 */
export const GREAT_CULTIVATION_PILL_GAIN = 1200;
/** 悟道丹每颗增加的悟道值（未分配余额，受 DAO_INSIGHT_CAP 的剩余额度限制）。 */
export const INSIGHT_PILL_GAIN = 1;
/** 培元丹每颗增加的资质（封顶 ATTRIBUTE_MAX）。 */
export const APTITUDE_PILL_GAIN = 2;
/** 每名弟子最多服用培元丹次数。 */
export const APTITUDE_PILL_MAX_USES = 5;

export type PillId =
  | 'healingPill'
  | 'cultivationPill'
  | 'bodyTemperingPill'
  | 'talentPill'
  | 'greatCultivationPill'
  | 'insightPill'
  | 'aptitudePill';

export type PillAttribute = 'attack' | 'defense' | 'speed';

export interface PillRecipe {
  id: PillId;
  name: string;
  description: string;
  /** 单颗炼制成本：resourceId -> 最小单位十进制字符串（与配置资源同口径）。 */
  cost: Record<string, string>;
}

/**
 * 第一版丹方基线（03 文档第 3 节）：
 * - 回春丹：清除一名弟子的当前疗伤状态；
 * - 聚气丹：增加 120 点当前阶段修为（不越过突破门槛）；
 * - 淬体丹：自动补最明显的战斗属性短板（每名弟子最多 10 次）。
 * - 洗髓丹（天赋重构）：洗出一个新天赋，玩家二选一（每名弟子最多 5 次，见 talents.ts）。
 * - 凝元丹：1200 修为（= 10 颗聚气丹，配方也是 10 倍），后期免得一颗颗吃。
 * - 悟道丹：悟道值 +1。定价参照赌坊：论道 ×1 押 100 灵石、五五开，期望约 100 灵石换 1 点悟道值
 *   （对手弱时约 54），且每天限次；系统对悟道值的折价是 180 灵石（溢出折算）。悟道丹不限次、
 *   必定到手，所以定在约 300 灵石当量 + 1 神木，约为赌坊期望的 3 倍。
 * - 培元丹：资质 +2，每名弟子最多 5 次（资质封顶 100）。
 * 神木（炼丹专用，只能功勋兑换）只用在洗髓丹 / 悟道丹 / 培元丹，数量刻意压得很少。
 */
export const PILL_RECIPES: readonly PillRecipe[] = [
  {
    id: 'healingPill',
    name: '回春丹',
    description: '清除一名弟子的疗伤状态，立刻可以再度出战或突破。',
    cost: { herb: '10000', spiritStone: '15000' },
  },
  {
    id: 'cultivationPill',
    name: '聚气丹',
    description: '为一名弟子增加 120 点当前阶段修为，不越过突破门槛。',
    cost: { herb: '25000', spiritualEnergy: '15000', spiritStone: '10000' },
  },
  {
    id: 'bodyTemperingPill',
    name: '淬体丹',
    description: '自动补齐一名弟子最明显的战斗属性短板，每名弟子最多服用 10 次。',
    cost: { herb: '40000', ore: '20000', spiritStone: '30000' },
  },
  {
    id: 'talentPill',
    name: '洗髓丹',
    description: '洗出一个新天赋（不会与当前相同），可选择保留原天赋或换成新天赋；每名弟子最多服用 5 次。',
    cost: { herb: '300000', spiritStone: '300000', shenmu: '3000' },
  },
  {
    id: 'greatCultivationPill',
    name: '凝元丹',
    description: '为一名弟子增加 1200 点当前阶段修为（相当于 10 颗聚气丹），不越过突破门槛。',
    cost: { herb: '250000', spiritualEnergy: '150000', spiritStone: '100000' },
  },
  {
    id: 'insightPill',
    name: '悟道丹',
    description: '为一名弟子增加 1 点悟道值（受悟道值累计上限限制），可在弟子详情分配到属性。',
    cost: { spiritStone: '250000', herb: '100000', shenmu: '1000' },
  },
  {
    id: 'aptitudePill',
    name: '培元丹',
    description: '为一名弟子增加 2 点资质（最高 100），每名弟子最多服用 5 次。',
    cost: { herb: '200000', spiritualEnergy: '150000', spiritStone: '150000', shenmu: '2000' },
  },
];

export const PILL_IDS: readonly PillId[] = PILL_RECIPES.map((recipe) => recipe.id);

/**
 * 天赋重构 · 丹道：丹房执事让全宗炼丹消耗按比例降低（discountBp 基点）。
 * 每项资源各自向下取整；discountBp ≤ 0 时原样返回。
 */
export function discountedPillCost(
  cost: Readonly<Record<string, string>>,
  discountBp: number,
): Record<string, string> {
  const keep = 10_000 - Math.min(10_000, Math.max(0, discountBp));
  const out: Record<string, string> = {};
  for (const [resourceId, amount] of Object.entries(cost)) {
    out[resourceId] = String(Math.floor((Number(amount) * keep) / 10_000));
  }
  return out;
}

/** 按 id 查配方；未知 id（客户端乱传）返回 undefined，由调用方抛 NOT_FOUND。 */
export function findPillRecipe(pillId: string): PillRecipe | undefined {
  return PILL_RECIPES.find((recipe) => recipe.id === pillId);
}

/** 未解锁时的统一文案（sync 视图与 craft/use 报错共用同一句）。 */
export const ALCHEMY_LOCKED_REASON = `炼丹尚未开启，需要宗门 ${ALCHEMY_UNLOCK_SECT_LEVEL} 级、灵药园 ${ALCHEMY_UNLOCK_BUILDING_LEVEL} 级`;

/**
 * 解锁判断（只在服务端实现）：宗门等级达标 且 附属建筑（灵药园）等级达标。
 * buildingLevels 是 defId -> level 表；没有灵药园行视为 0 级。
 */
export function isAlchemyUnlocked(sectLevel: number, buildingLevels: Record<string, number>): boolean {
  return (
    sectLevel >= ALCHEMY_UNLOCK_SECT_LEVEL &&
    (buildingLevels[ALCHEMY_UNLOCK_BUILDING_ID] ?? 0) >= ALCHEMY_UNLOCK_BUILDING_LEVEL
  );
}

/** 同一判断的文案版：解锁返回 null，未解锁返回 ALCHEMY_LOCKED_REASON。 */
export function alchemyUnlockBlockedReason(
  sectLevel: number,
  buildingLevels: Record<string, number>,
): string | null {
  return isAlchemyUnlocked(sectLevel, buildingLevels) ? null : ALCHEMY_LOCKED_REASON;
}

/**
 * 成本里第一个余额不足的资源（炼制 canCraft 判断用）。
 * 返回 resourceId；全部足够返回 null。数量 × quantity 的精确检查仍由 craft 服务执行。
 */
export function firstInsufficientResource(
  cost: Record<string, string>,
  balanceOf: (resourceId: string) => number,
): string | null {
  for (const [resourceId, amount] of Object.entries(cost)) {
    if (balanceOf(resourceId) < Number(amount)) {
      return resourceId;
    }
  }
  return null;
}

/** 淬体丹短板判定的固定属性顺序（gap 并列时先到先得）。 */
const PILL_ATTRIBUTE_ORDER: readonly PillAttribute[] = ['attack', 'defense', 'speed'];

/**
 * 单项短板的提升量：`min(5, max(1, 1 + floor(gap / 10)), 100 - 当前属性)`。
 * gap > 0 时结果至少为 1（gap > 0 蕴含当前属性 < 100，所以 100 - attr >= 1）。
 */
export function bodyTemperingGain(gap: number, currentValue: number): number {
  return Math.min(5, Math.max(1, 1 + Math.floor(gap / 10)), 100 - currentValue);
}

export interface BodyTemperingTarget {
  attribute: PillAttribute;
  gain: number;
  /** 与另两项均值（向下取整）的差距；恒 > 0。 */
  gap: number;
}

/**
 * 淬体丹补短板（服务端自动选择，客户端不能指定属性）：
 * 对每个候选属性算 otherAverage = floor(另两项之和 / 2)、gap = otherAverage - 当前属性，
 * 只有 gap > 0 的属性可补；选 gap 最大者，并列按 attack -> defense -> speed。
 * 没有可补属性（三项均衡）返回 null。
 */
export function bodyTemperingTarget(
  attack: number,
  defense: number,
  speed: number,
): BodyTemperingTarget | null {
  const values: Record<PillAttribute, number> = { attack, defense, speed };
  let best: BodyTemperingTarget | null = null;
  for (const attribute of PILL_ATTRIBUTE_ORDER) {
    const otherSum = PILL_ATTRIBUTE_ORDER.filter((item) => item !== attribute).reduce(
      (sum, item) => sum + values[item],
      0,
    );
    const gap = Math.floor(otherSum / 2) - values[attribute];
    if (gap <= 0) {
      continue;
    }
    // 严格大于：并列时保留先出现的属性（固定顺序 attack -> defense -> speed）。
    if (best === null || gap > best.gap) {
      best = { attribute, gain: bodyTemperingGain(gap, values[attribute]), gap };
    }
  }
  return best;
}

/**
 * 天赋重构 · 丹心：这名弟子每颗聚气丹的修为 = floor(基础 × (1 + 丹心加成))，加成随境界提高；
 * 没有丹心天赋时就是基础值。base 缺省为聚气丹（120），凝元丹传 GREAT_CULTIVATION_PILL_GAIN。
 */
export function cultivationPillGainOf(
  talent: string,
  realmId: string,
  base: number = CULTIVATION_PILL_GAIN,
): number {
  const bp = talentBonusBp(talent, realmId, 'pillAffinity');
  return Math.floor((base * (10_000 + bp)) / 10_000);
}

/** 修为类丹药（聚气丹 / 凝元丹）的基础每颗修为；不是修为类返回 null。 */
export function cultivationPillBaseGain(pillId: string): number | null {
  if (pillId === 'cultivationPill') return CULTIVATION_PILL_GAIN;
  if (pillId === 'greatCultivationPill') return GREAT_CULTIVATION_PILL_GAIN;
  return null;
}

/**
 * 培元丹「服到满」能服几颗：受剩余次数与资质上限限制（最后一颗可能只加 1 点）。
 * 已满次数或资质已到上限返回 0。
 */
export function aptitudePillsToFull(aptitude: number, uses: number, aptitudeMax: number): number {
  const byUses = Math.max(0, APTITUDE_PILL_MAX_USES - uses);
  const byCap = Math.max(0, Math.ceil((aptitudeMax - aptitude) / APTITUDE_PILL_GAIN));
  return Math.min(byUses, byCap);
}

/**
 * 聚气丹「服到满」需要几颗：服到修为恰好达到突破门槛（最后一颗可能只生效一部分）。
 * 已达门槛或已是本版本最高阶段（门槛为 null）返回 0。gainPerPill 缺省为基础增益（无丹心）。
 */
export function cultivationPillsToFull(
  cultivation: number,
  requiredCultivation: number | null,
  gainPerPill: number = CULTIVATION_PILL_GAIN,
): number {
  if (requiredCultivation === null || cultivation >= requiredCultivation) {
    return 0;
  }
  return Math.ceil((requiredCultivation - cultivation) / Math.max(1, gainPerPill));
}

export interface BodyTemperingStep {
  attribute: PillAttribute;
  gain: number;
}

/**
 * 淬体丹连服计划：从当前属性出发逐颗补短板（每颗都按补完上一颗后的属性重新选短板），
 * 直到服满 BODY_TEMPERING_MAX_USES 次、没有短板，或达到 maxPills 颗。
 * 每颗提升至少 1 且次数有上限，循环必然结束。
 */
export function bodyTemperingPlan(
  attack: number,
  defense: number,
  speed: number,
  uses: number,
  maxPills = BODY_TEMPERING_MAX_USES,
): BodyTemperingStep[] {
  const values: Record<PillAttribute, number> = { attack, defense, speed };
  const steps: BodyTemperingStep[] = [];
  while (uses + steps.length < BODY_TEMPERING_MAX_USES && steps.length < maxPills) {
    const target = bodyTemperingTarget(values.attack, values.defense, values.speed);
    if (target === null) {
      break;
    }
    values[target.attribute] += target.gain;
    steps.push({ attribute: target.attribute, gain: target.gain });
  }
  return steps;
}
