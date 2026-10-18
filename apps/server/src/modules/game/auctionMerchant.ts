import { auctionMinPrice, type AuctionEquipmentSnapshot } from './auction';
import { generateEquipment, resolveMainAttr, type EquipmentQuality, type EquipmentSlot } from './equipment';
import { MERCHANT_SCROLL_TIERS, scrollItemIdOf, TECHNIQUES } from './techniques';

export const MERCHANT_NAME = '云游商人';
export const MERCHANT_STAY_MS = 6 * 3_600_000;
export const MERCHANT_MIN_GAP_MS = 2 * 3_600_000;
export const MERCHANT_MAX_GAP_MS = 4 * 3_600_000;

const EQUIPMENT_START_PRICE: Record<EquipmentQuality, number> = {
  common: 100, spirit: 350, treasure: 1000, immortal: 2500,
};

export interface MerchantGoods {
  kind: 'equipment' | 'resource';
  itemId: string;
  itemName: string;
  quantity: number;
  equipmentJson: string | null;
  startPrice: number;
  buyoutPrice: number;
}

function integer(min: number, max: number, random: () => number): number {
  return min + Math.min(max - min, Math.max(0, Math.floor(random() * (max - min + 1))));
}

export function merchantGapMs(random: () => number): number {
  return integer(MERCHANT_MIN_GAP_MS / 60_000, MERCHANT_MAX_GAP_MS / 60_000, random) * 60_000;
}

/** 凡 / 灵 / 宝 / 仙权重 20 / 35 / 30 / 15，四档都可能出现。 */
export function merchantQuality(random: () => number): EquipmentQuality {
  const roll = random();
  if (roll < 0.2) return 'common';
  if (roll < 0.55) return 'spirit';
  if (roll < 0.85) return 'treasure';
  return 'immortal';
}

/** 每次 8～12 单，装备约六成；材料至少各有一单玄铁和神木。 */
export function generateMerchantGoods(random: () => number): MerchantGoods[] {
  const count = integer(8, 12, random);
  const equipmentCount = Math.round(count * 0.6);
  const goods: MerchantGoods[] = [];
  for (let index = 0; index < equipmentCount; index += 1) {
    const quality = merchantQuality(random);
    const slot = (['weapon', 'armor', 'artifact'] as const)[integer(0, 2, random)] as EquipmentSlot;
    const equipment = generateEquipment({ slot, quality, mainAttr: resolveMainAttr(slot, undefined, random)!, random });
    const snapshot: AuctionEquipmentSnapshot = { ...equipment, source: 'merchant', refineLevel: 0 };
    const startPrice = Math.max(auctionMinPrice('equipment', quality, 1), Math.ceil(integer(90, 110, random) * EQUIPMENT_START_PRICE[quality] / 100) * 1000);
    goods.push({ kind: 'equipment', itemId: quality, itemName: equipment.name, quantity: 1,
      equipmentJson: JSON.stringify(snapshot), startPrice,
      buyoutPrice: Math.ceil(startPrice * integer(180, 220, random) / 100 / 1000) * 1000 });
  }
  for (let index = equipmentCount; index < count; index += 1) {
    const resource = index === equipmentCount ? 'xuantie' : index === equipmentCount + 1 ? 'shenmu'
      : random() < 0.5 ? 'xuantie' : 'shenmu';
    const quantity = integer(5, 20, random);
    const startPrice = quantity * integer(25, 40, random) * 1000;
    goods.push({ kind: 'resource', itemId: resource, itemName: resource === 'xuantie' ? '玄铁' : '神木',
      quantity, equipmentJson: null, startPrice, buyoutPrice: quantity * integer(50, 75, random) * 1000 });
  }
  return goods;
}

/**
 * 功法残卷货品（docs/功法开发计划.md 第 5 节）：只出玄阶、地阶，每组 2～5 张；
 * 起拍 / 一口价为「每张」价目（玄阶 20k～30k / 40k～60k，地阶 60k～90k / 120k～180k，最小单位），
 * 整单按张数乘。沿用 kind: 'resource' 的拍卖 / 一口价流程，交付时进 sect_techniques.scrolls。
 */
function techniqueScrollGood(random: () => number): MerchantGoods {
  const tier = random() < 0.6 ? MERCHANT_SCROLL_TIERS[0]! : MERCHANT_SCROLL_TIERS[1]!;
  const pool = TECHNIQUES.filter((item) => item.tier === tier);
  const technique = pool[Math.min(pool.length - 1, Math.max(0, Math.floor(random() * pool.length)))]!;
  const quantity = integer(2, 5, random);
  const perStart = tier === 'xuan' ? integer(20, 30, random) : integer(60, 90, random);
  const perBuyout = tier === 'xuan' ? integer(40, 60, random) : integer(120, 180, random);
  return {
    kind: 'resource',
    itemId: scrollItemIdOf(technique.id),
    itemName: `${technique.name}残卷`,
    quantity,
    equipmentJson: null,
    startPrice: quantity * perStart * 1000,
    buyoutPrice: quantity * perBuyout * 1000,
  };
}

/**
 * 每次到访的残卷：从材料单里换掉 1～2 单（从末尾算起，保底的玄铁与神木两单不动）。
 * 换而不加：商人每次的上架单数仍是 8～12 单（拍卖行的库存与公告口径不变）。
 */
export function withTechniqueScrolls(goods: readonly MerchantGoods[], random: () => number): MerchantGoods[] {
  const materialIndexes = goods.flatMap((item, index) => (item.kind === 'resource' ? [index] : []));
  const replaceable = materialIndexes.slice(2);
  const groups = Math.min(replaceable.length, 1 + Math.floor(random() * 2));
  const result = [...goods];
  for (let group = 0; group < groups; group += 1) {
    result[replaceable[replaceable.length - 1 - group]!] = techniqueScrollGood(random);
  }
  return result;
}
