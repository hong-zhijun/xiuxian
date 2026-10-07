import { PILL_RECIPES, findPillRecipe } from './alchemy';
import { FORGE_RECIPES, type EquipmentQuality } from './equipment';

/**
 * 拍卖行（docs/拍卖行开发计划.md）——纯定义与纯计算。
 *
 * 与 shop.ts / tower.ts 同一做法：规则是少量玩法常量，放在游戏模块代码里，不进 game-config；
 * 本文件不读库、不取时间、不用随机数。
 *
 * 规则要点：
 * - 宗门 3 级解锁；可交易：背包里的装备、丹药、玄铁 / 神木。
 * - 上架即托管：物品从卖家扣走，存进拍卖单；出价即冻结：灵石从出价者扣走，被超价时原路退回。
 * - 24 小时竞价，可选一口价；到期价高者得，没人出价则退回卖家（都要到「待领取」里领）。
 * - 成交扣 10% 手续费（灵石直接销毁）；起拍价不低于物品成本的 20%（挡小号低价转移资源）。
 *
 * 金额一律是最小单位（1 展示单位 = 1000 最小单位）；价格输入是展示单位整数。
 */

export const AUCTION_UNLOCK_SECT_LEVEL = 3;
/** 拍卖时长。 */
export const AUCTION_DURATION_MS = 24 * 3_600_000;
/** 每个宗门同时在拍的单数上限。 */
export const AUCTION_MAX_ACTIVE_LISTINGS = 10;
/** 成交手续费（基点，1000 = 10%）：从卖家所得里扣，灵石直接销毁。 */
export const AUCTION_FEE_BP = 1000;
/** 撤销出价的违约金（基点，500 = 5%）：从退款里扣，赔给卖家。 */
export const AUCTION_RETRACT_PENALTY_BP = 500;
/** 拍卖结束前这么久之内不能撤销出价（留时间给别人重新出价）。 */
export const AUCTION_RETRACT_CUTOFF_MS = 2 * 3_600_000;
/** 加价幅度：下一口至少比当前价高 5%（且至少 1 灵石）。 */
export const AUCTION_BID_STEP_BP = 500;
/** 价格上限（展示单位）。 */
export const AUCTION_MAX_PRICE = 99_999_999;
/** 一单最多几颗丹药 / 几个材料。 */
export const AUCTION_PILL_MAX_QUANTITY = 99;
export const AUCTION_RESOURCE_MAX_QUANTITY = 999;
/** 大厅一次最多列出多少单（按结束时间先后）。 */
export const AUCTION_HALL_LIMIT = 200;

/** 1 展示单位 = 1000 最小单位。 */
const UNIT = 1000;

export type AuctionKind = 'equipment' | 'pill' | 'resource';
export const AUCTION_KINDS: readonly AuctionKind[] = ['equipment', 'pill', 'resource'];

/** 可拍卖的材料（药材 / 矿石坊市就能买卖，不进拍卖行；功勋不可交易）。 */
export const AUCTION_RESOURCES: readonly { id: string; name: string }[] = [
  { id: 'xuantie', name: '玄铁' },
  { id: 'shenmu', name: '神木' },
];

export function findAuctionResource(resourceId: string): { id: string; name: string } | undefined {
  return AUCTION_RESOURCES.find((item) => item.id === resourceId);
}

/* ---------- 最低起拍价 ---------- */

/** 最低起拍价 = 物品成本 × 20%。 */
export const AUCTION_FLOOR_BP = 2000;
/** 折算成本时，1 个玄铁 / 神木按 50 灵石算。 */
export const AUCTION_RARE_STONE_VALUE = 50;

/** 一份配方成本折算成灵石（最小单位）：灵石 / 灵气 / 药材 / 矿石按 1:1，玄铁 / 神木各按 50 灵石。 */
function costValueOf(cost: Readonly<Record<string, string>>): number {
  let total = 0;
  for (const [resourceId, amount] of Object.entries(cost)) {
    const value = Number(amount);
    if (!Number.isFinite(value)) continue;
    total += findAuctionResource(resourceId) === undefined ? value : value * AUCTION_RARE_STONE_VALUE;
  }
  return total;
}

/** 单件 / 单颗 / 单个的最低价（最小单位，向上取整到整灵石，至少 1 灵石）。 */
export function auctionUnitFloor(kind: AuctionKind, itemId: string): number {
  let value: number;
  if (kind === 'equipment') {
    const recipe = FORGE_RECIPES.find((item) => item.quality === itemId);
    value = recipe === undefined ? 0 : costValueOf(recipe.cost);
  } else if (kind === 'pill') {
    const recipe = findPillRecipe(itemId);
    value = recipe === undefined ? 0 : costValueOf(recipe.cost);
  } else {
    value = findAuctionResource(itemId) === undefined ? 0 : AUCTION_RARE_STONE_VALUE * UNIT;
  }
  const floor = Math.ceil((value * AUCTION_FLOOR_BP) / 10_000 / UNIT) * UNIT;
  return Math.max(UNIT, floor);
}

/** 一单的最低起拍价（最小单位）：单价下限 × 数量。 */
export function auctionMinPrice(kind: AuctionKind, itemId: string, quantity: number): number {
  return auctionUnitFloor(kind, itemId) * Math.max(1, Math.floor(quantity));
}

/* ---------- 竞价与手续费 ---------- */

/** 下一口的最低出价（最小单位）：没人出过价 = 起拍价；否则当前价 ×1.05 向上取整到整灵石，且至少 +1 灵石。 */
export function auctionMinNextBid(lot: { startPrice: number; currentPrice: number | null }): number {
  if (lot.currentPrice === null) return lot.startPrice;
  const stepped = Math.ceil((lot.currentPrice * (10_000 + AUCTION_BID_STEP_BP)) / 10_000 / UNIT) * UNIT;
  return Math.max(lot.currentPrice + UNIT, stepped);
}

/** 手续费（最小单位，向下取整）。 */
export function auctionFee(price: number): number {
  return Math.floor((Math.max(0, price) * AUCTION_FEE_BP) / 10_000);
}

/** 撤销出价的违约金（最小单位，向下取整）：赔给卖家，其余退回出价者。 */
export function auctionRetractPenalty(price: number): number {
  return Math.floor((Math.max(0, price) * AUCTION_RETRACT_PENALTY_BP) / 10_000);
}

/** 现在还能不能撤销：领先者、竞价中，且离结束超过 2 小时。 */
export function canRetractAuctionBid(lot: { endsAt: number; isLeading: boolean; active: boolean }, now: number): boolean {
  return lot.active && lot.isLeading && lot.endsAt - now > AUCTION_RETRACT_CUTOFF_MS;
}

/** 卖家实得 = 成交价 − 手续费。 */
export function auctionSellerProceeds(price: number): number {
  return Math.max(0, price) - auctionFee(price);
}

/** 能拍卖的丹药 id（全部配方）。 */
export function isAuctionPill(pillId: string): boolean {
  return PILL_RECIPES.some((recipe) => recipe.id === pillId);
}

/** 装备品质 id 校验（拍卖单里存品质，算最低价用）。 */
export function isAuctionEquipmentQuality(quality: string): quality is EquipmentQuality {
  return FORGE_RECIPES.some((recipe) => recipe.quality === quality);
}

/* ---------- 托管的装备快照 ---------- */

/** 上架时把装备行整份存进拍卖单（原行删掉）；交付时按它重新插一行（新 id）。 */
export interface AuctionEquipmentSnapshot {
  slot: string;
  quality: string;
  name: string;
  mainAttr: string;
  mainValue: number;
  subAttr: string;
  subValue: number;
  source: string;
}

/** 解析快照；脏数据返回 null（交付时按 INVALID_STATUS 拒绝，不会插出坏装备）。 */
export function parseEquipmentSnapshot(raw: string | null): AuctionEquipmentSnapshot | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Partial<AuctionEquipmentSnapshot>;
    if (
      typeof value.slot !== 'string' ||
      typeof value.quality !== 'string' ||
      typeof value.name !== 'string' ||
      typeof value.mainAttr !== 'string' ||
      typeof value.mainValue !== 'number' ||
      typeof value.subAttr !== 'string' ||
      typeof value.subValue !== 'number' ||
      typeof value.source !== 'string'
    ) {
      return null;
    }
    return value as AuctionEquipmentSnapshot;
  } catch {
    return null;
  }
}

/* ---------- 同一网络不能互相交易 ---------- */

/**
 * 交易用的「网络标识」：IPv4 原样；IPv6 取前 64 位（同一宽带下的手机 / 电脑前缀相同，后半段常变）。
 * 拿不到来源（'unknown' / 空串 / 解析失败）返回 null —— 这时不做同网络检查，不误拦正常玩家。
 * 只用于比对；落库前由调用方再做一次哈希，库里不存明文。
 */
export function auctionNetworkKey(ip: string): string | null {
  const raw = ip.trim().toLowerCase();
  if (raw === '' || raw === 'unknown') return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(raw)) return raw;
  if (!raw.includes(':')) return null;
  // IPv6：去掉 zone（%eth0），展开 :: 后取前 4 段。
  const address = raw.split('%')[0]!;
  const [head = '', tail] = address.split('::');
  if (address.split('::').length > 2) return null;
  const headParts = head === '' ? [] : head.split(':');
  const tailParts = tail === undefined || tail === '' ? [] : tail.split(':');
  const missing = 8 - headParts.length - tailParts.length;
  if (tail === undefined ? headParts.length !== 8 : missing < 0) return null;
  const parts = [...headParts, ...Array<string>(tail === undefined ? 0 : missing).fill('0'), ...tailParts];
  if (parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  return parts
    .slice(0, 4)
    .map((part) => part.replace(/^0+(?=.)/, ''))
    .join(':');
}
