import { SHOP_SELL_PRICE, UNITS_PER_DISPLAY } from './shop';

/**
 * 赌石（赌坊第四个玩法，docs/赌石开发计划.md）——纯定义与纯计算。
 *
 * 与 tower.ts / gambling.ts 同一模式：四档原石的概率与玄铁个数、保底与材料换算都硬编码在这里，
 * 不进 game-config；本文件不读库、不取时间，随机源通过参数注入（测试按取用顺序注入固定序列）。
 *
 * 规则要点：
 * - 四档原石（碎石 / 山料 / 老坑料 / 天外陨石），每档四种结果（垮了 / 小涨 / 大涨 / 天价），
 *   开出的玄铁个数固定（不是区间）；概率用基点，每档四项加起来正好 10000。
 * - 支付：灵石按价格扣；药材 / 矿石按坊市**卖出价**折算（2 材料 = 1 灵石），不能按买入价折算，否则能套利。
 * - 一次切 1 或 10 块，每块独立抽一次，结果逐块累加。
 * - 隐藏保底：按「宗门 + 档位」记连续垮了的次数（存库，不进任何接口）；满 STONE_PITY_BUSTS 次后
 *   下一块排除「垮了」，其余三项按原概率重新归一抽取。
 *
 * 金额一律是**最小单位整数**（1 展示单位 = 1000 最小单位）；概率一律是基点（10000 = 100%）。
 */

/* ---------- 结果与档位 ---------- */

/** 结果 id：垮了 / 小涨 / 大涨 / 天价。 */
export const STONE_OUTCOME_IDS = ['bust', 'small', 'big', 'jackpot'] as const;
export type StoneOutcomeId = (typeof STONE_OUTCOME_IDS)[number];

/** 结果中文名（服务端拼文案与界面共用，不在各处复制）。 */
export const STONE_OUTCOME_NAMES: Record<StoneOutcomeId, string> = {
  bust: '垮了',
  small: '小涨',
  big: '大涨',
  jackpot: '天价',
};

/** 概率总和（基点）：每档四项加起来必须正好等于它。 */
export const STONE_CHANCE_TOTAL_BP = 10_000;

/** 档位 id：碎石 / 山料 / 老坑料 / 天外陨石。 */
export const STONE_TIER_IDS = ['gravel', 'mountain', 'oldPit', 'meteor'] as const;
export type StoneTierId = (typeof STONE_TIER_IDS)[number];

export interface StoneOutcomeDef {
  id: StoneOutcomeId;
  name: string;
  /** 概率（基点，10000 = 100%）。 */
  chanceBp: number;
  /** 开出的玄铁个数（展示单位，固定不是区间）。 */
  xuantie: number;
}

export interface StoneTierDef {
  id: StoneTierId;
  name: string;
  /** 价格（灵石，展示单位）。 */
  price: number;
  /** 宗门门槛（等级）。 */
  minSectLevel: number;
  outcomes: readonly StoneOutcomeDef[];
}

/** 结果定义的小工厂：名字统一从 STONE_OUTCOME_NAMES 取，表里只写概率与个数。 */
function outcome(id: StoneOutcomeId, chanceBp: number, xuantie: number): StoneOutcomeDef {
  return { id, name: STONE_OUTCOME_NAMES[id], chanceBp, xuantie };
}

/**
 * 四档原石（计划 1.2）。格式：概率基点 / 玄铁个数。
 * 期望（展示单位）：碎石 1.02 / 山料 4.25 / 老坑料 17.05 / 天外陨石 82.5（测试逐档核对）。
 */
export const STONE_TIERS: readonly StoneTierDef[] = [
  {
    id: 'gravel',
    name: '碎石',
    price: 150,
    minSectLevel: 2,
    outcomes: [outcome('bust', 4000, 0), outcome('small', 4600, 1), outcome('big', 1200, 3), outcome('jackpot', 200, 10)],
  },
  {
    id: 'mountain',
    name: '山料',
    price: 500,
    minSectLevel: 2,
    outcomes: [outcome('bust', 3500, 0), outcome('small', 4500, 3), outcome('big', 1700, 10), outcome('jackpot', 300, 40)],
  },
  {
    id: 'oldPit',
    name: '老坑料',
    price: 2000,
    minSectLevel: 2,
    outcomes: [outcome('bust', 3000, 0), outcome('small', 4500, 12), outcome('big', 2100, 25), outcome('jackpot', 400, 160)],
  },
  {
    id: 'meteor',
    name: '天外陨石',
    price: 10_000,
    minSectLevel: 6,
    outcomes: [outcome('bust', 2500, 0), outcome('small', 4600, 50), outcome('big', 2500, 110), outcome('jackpot', 400, 800)],
  },
];

/* ---------- 保底、批量与支付 ---------- */

/** 隐藏保底上限：连续垮了这么多次后，下一块排除「垮了」（代码里夹取到此上限，表里 CHECK 只写下限）。 */
export const STONE_PITY_BUSTS = 10;

/** 一次请求能切的块数：「切石」与「连切 10 块」两个按钮。 */
export const STONE_BATCH_COUNTS = [1, 10] as const;
export type StoneBatchCount = (typeof STONE_BATCH_COUNTS)[number];

/** 支付方式：灵石 / 药材 / 矿石。 */
export const STONE_PAY_RESOURCES = ['spiritStone', 'herb', 'ore'] as const;
export type StonePayResource = (typeof STONE_PAY_RESOURCES)[number];

/** 赌石记录页：本宗最近多少条（时间倒序，只读）。 */
export const STONE_HISTORY_LIMIT = 20;

/** 1 灵石折几个材料（展示单位）= 1000 / SHOP_SELL_PRICE（= 2）：界面用它预览材料价格。 */
export const STONE_MATERIAL_PER_STONE = UNITS_PER_DISPLAY / SHOP_SELL_PRICE;

/* ---------- 查询与校验 ---------- */

/** 按 id 查档位；未知 id 返回 null（由 service 拒绝）。 */
export function findStoneTier(tierId: string): StoneTierDef | null {
  return STONE_TIERS.find((tier) => tier.id === tierId) ?? null;
}

/** 宗门等级够不够该档门槛：够返回 null，否则返回文案（如「天外陨石需要宗门 6 级」）。 */
export function stoneTierBlockedReason(tier: StoneTierDef, sectLevel: number): string | null {
  return sectLevel >= tier.minSectLevel ? null : `${tier.name}需要宗门 ${tier.minSectLevel} 级`;
}

/** 某档某结果的定义（每档四种结果都齐全，找不到只会是表写错）。 */
export function stoneOutcomeOf(tier: StoneTierDef, outcomeId: StoneOutcomeId): StoneOutcomeDef {
  const found = tier.outcomes.find((item) => item.id === outcomeId);
  if (found === undefined) {
    throw new Error(`赌石档位 ${tier.id} 缺少结果 ${outcomeId}`);
  }
  return found;
}

/* ---------- 金额与期望 ---------- */

/**
 * 切 count 块的花费（最小单位，整数）：
 * - 灵石：价格 × 1000 × count；
 * - 药材 / 矿石：价格 × 1000 × 1000 / SHOP_SELL_PRICE × count（按卖出价折算，不能按买入价，否则能套利）。
 * 例：碎石用矿石付 = 150 × 1000 × 1000 / 500 = 300000（= 300 矿石）。
 */
export function stoneCostUnits(tier: StoneTierDef, payResource: StonePayResource, count: number): number {
  const perStone =
    payResource === 'spiritStone'
      ? tier.price * UNITS_PER_DISPLAY
      : (tier.price * UNITS_PER_DISPLAY * UNITS_PER_DISPLAY) / SHOP_SELL_PRICE;
  return perStone * count;
}

/** 天价个数（展示单位）：该档四种结果里玄铁最多的一项。 */
export function stoneTopPrize(tier: StoneTierDef): number {
  return Math.max(...tier.outcomes.map((item) => item.xuantie));
}

/**
 * 单块的期望玄铁（展示单位）：Σ 概率 × 个数。
 * 先在整数（基点 × 个数）上求和，最后再除以 10000，避免浮点累计误差。
 */
export function stoneExpectedXuantie(tier: StoneTierDef): number {
  const weighted = tier.outcomes.reduce((total, item) => total + item.chanceBp * item.xuantie, 0);
  return weighted / STONE_CHANCE_TOTAL_BP;
}

/* ---------- 抽取与保底推进 ---------- */

/**
 * 抽一块的结果（纯函数）。
 * - busts < STONE_PITY_BUSTS：按四项原概率抽；
 * - busts ≥ STONE_PITY_BUSTS：去掉「垮了」，其余三项按原概率重新归一抽取（只改抽取范围，不改表里的数字）。
 * random 取值 [0, 1)，由调用方注入（测试注入固定序列，服务端传 Math.random）。
 */
export function rollStone(tier: StoneTierDef, busts: number, random: () => number): StoneOutcomeId {
  const pitied = busts >= STONE_PITY_BUSTS;
  const pool = pitied ? tier.outcomes.filter((item) => item.id !== 'bust') : tier.outcomes;
  const total = pool.reduce((sum, item) => sum + item.chanceBp, 0);
  const target = random() * total;
  let acc = 0;
  for (const item of pool) {
    acc += item.chanceBp;
    if (target < acc) return item.id;
  }
  // 浮点兜底（random 贴近 1 时）：落在池子的最后一项。
  return pool[pool.length - 1]!.id;
}

/** 保底次数推进：开出「垮了」+1（夹到 STONE_PITY_BUSTS）；开出其他任何结果清零。 */
export function nextStoneBusts(busts: number, outcomeId: StoneOutcomeId): number {
  if (outcomeId !== 'bust') return 0;
  return Math.min(STONE_PITY_BUSTS, Math.max(0, busts) + 1);
}

/** 连切的结算结果。 */
export interface StoneCutResult {
  /** 每块的结果（顺序即切开的顺序）。 */
  outcomes: StoneOutcomeId[];
  /** 四种结果各几块（之和恒等于 count）。 */
  counts: Record<StoneOutcomeId, number>;
  /** 共得玄铁（展示单位，各块固定个数之和）。 */
  xuantie: number;
  /** 连切结束后的保底次数（写回 stone_gamble_busts）。 */
  nextBusts: number;
}

/**
 * 连切 count 块（纯函数）：逐块「先抽、再推进次数」，所以连切 10 块时第 3 块触发保底后清零、第 4 块起重新计（计划 1.5）。
 * 随机源取用顺序：第 1 块、第 2 块……每块恰好取一次随机数。
 */
export function cutStones(
  tier: StoneTierDef,
  count: number,
  busts: number,
  random: () => number,
): StoneCutResult {
  const outcomes: StoneOutcomeId[] = [];
  const counts: Record<StoneOutcomeId, number> = { bust: 0, small: 0, big: 0, jackpot: 0 };
  let xuantie = 0;
  let current = busts;
  for (let index = 0; index < count; index += 1) {
    const outcomeId = rollStone(tier, current, random);
    current = nextStoneBusts(current, outcomeId);
    outcomes.push(outcomeId);
    counts[outcomeId] += 1;
    xuantie += stoneOutcomeOf(tier, outcomeId).xuantie;
  }
  return { outcomes, counts, xuantie, nextBusts: current };
}

/* ---------- 文案（服务端拼好，前端原样展示） ---------- */

/** 结果文案展示顺序：天价 → 大涨 → 小涨 → 垮了（与计划 2.6 的示例一致）。 */
const STONE_MESSAGE_ORDER: readonly StoneOutcomeId[] = ['jackpot', 'big', 'small', 'bust'];

/**
 * 一次请求的结果文案：
 * - 单块：`切开一块山料，大涨！开出玄铁 ×10`；垮了则为 `切开一块碎石，垮了，什么也没开出`；
 * - 连切：`切开 10 块山料，开出玄铁 ×52（天价 1 块、大涨 2 块、小涨 4 块、垮了 3 块）`（只列出现过的结果）。
 */
export function stoneResultMessage(tierName: string, cut: StoneCutResult): string {
  if (cut.outcomes.length === 1) {
    const outcomeId = cut.outcomes[0]!;
    if (outcomeId === 'bust') {
      return `切开一块${tierName}，垮了，什么也没开出`;
    }
    return `切开一块${tierName}，${STONE_OUTCOME_NAMES[outcomeId]}！开出玄铁 ×${cut.xuantie}`;
  }
  const parts = STONE_MESSAGE_ORDER.filter((id) => cut.counts[id] > 0).map(
    (id) => `${STONE_OUTCOME_NAMES[id]} ${cut.counts[id]} 块`,
  );
  return `切开 ${cut.outcomes.length} 块${tierName}，开出玄铁 ×${cut.xuantie}（${parts.join('、')}）`;
}

/** 天价全服播报（计划 1.6）：每块天价各播一条，个数取该档天价的玄铁数。 */
export function stoneJackpotBroadcast(sectName: string, tierName: string, xuantie: number): string {
  return `【赌石】${sectName}切开一块${tierName}，开出天价玄铁 ×${xuantie}！`;
}
