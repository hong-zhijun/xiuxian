export interface RebirthBonuses {
  productionBp: number;
  breakthroughBp: number;
  powerBp: number;
}
export interface RebirthShopItem {
  id: string;
  name: string;
  cost: number;
  description: string;
  purchased: number;
  limit: number;
  canBuy: boolean;
  blockedReason: string | null;
}
export interface RebirthPanel {
  cycle: number;
  daoYun: number;
  version: number;
  eligible: boolean;
  blockedReasons: string[];
  gainDaoYun: number;
  retainPercent: number;
  bonuses: RebirthBonuses;
  nextBonuses: RebirthBonuses;
  discipleCapacityFloor: number;
  buildingCapacityFloor: number;
  previewResources: { id: string; name: string; before: string; after: string }[];
  retained: string[];
  reset: string[];
  shop: RebirthShopItem[];
}
export type RebirthAction =
  | { action: 'rebirth'; commandId: string; expectedVersion: number }
  | { action: 'buy'; id: string; commandId: string; expectedVersion: number };
