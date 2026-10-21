export type BeastElement = 'metal' | 'wood' | 'water' | 'fire' | 'earth';
export type BeastTier = 'spirit' | 'rare' | 'divine';
export type BeastQuality = 'common' | 'spirit' | 'treasure' | 'immortal';
export interface BeastAttrs { attack: number; defense: number; speed: number; luck: number; physique: number }
export interface BeastIdentity { id: string; speciesId: string; quality: BeastQuality; level: number }
export type BeastManageAction = 'equip' | 'unequip' | 'upgrade' | 'lock' | 'release' | 'quality-breakthrough';
export type BeastExchangeInput =
  | { mode: 'random'; tier: BeastTier; commandId: string }
  | { mode: 'specific'; tier: BeastTier; speciesId: string; commandId: string };
export interface BeastResourceCost { beastEssence: string; spiritStone: string; spiritualEnergy: string }
export interface BeastCommandReceipt {
  commandId: string;
  kind: 'release' | 'release-batch' | 'quality-breakthrough' | 'exchange';
  beast: BeastIdentity;
  /** 批量放生：本次放生的全部灵兽（beast 为其中第一只）。 */
  released?: BeastIdentity[];
  previousQuality: BeastQuality | null;
  resourceChanges: Partial<Record<keyof BeastResourceCost, { direction: 'credit' | 'debit'; amount: string }>>;
}
export interface BeastExchangeOffer {
  tier: BeastTier; tierName: string; requiredSectLevel: number; unlocked: boolean;
  randomCost: string; specificCost: string; speciesIds: string[];
}
export interface BeastSpeciesView {
  id: string; name: string; tier: BeastTier; tierName: string; element: BeastElement; elementName: string;
  glyph: string; skillName: string; skillText: string; attrs: BeastAttrs;
  /** 512px 立绘，打开详情/遭遇时才加载。 */
  image: string | null;
  /** 96px 头像，列表只加载这一张。 */
  avatar: string | null;
}
export interface SpiritBeastView extends BeastIdentity {
  species: BeastSpeciesView; qualityName: string; attrs: BeastAttrs; skillText: string;
  discipleId: string | null; discipleName: string | null; locked: boolean; version: number;
  upgradeCost: { spiritStone: number; spiritualEnergy: number } | null;
  releaseReward: { beastEssence: string };
  qualityBreakthrough: null | {
    nextQuality: BeastQuality; nextQualityName: string; cost: BeastResourceCost;
    attrs: BeastAttrs; skillText: string; blockedReason: string | null;
  };
  upgradePreview: null | { level: number; attrs: BeastAttrs; skillText: string };
}
export interface BeastAreaView {
  id: string; name: string; description: string; requiredSectLevel: number; unlocked: boolean;
  cost: number; speciesIds: string[];
}
export interface BeastCaptureView {
  id: string; version: number; status: 'active' | 'caught' | 'killed' | 'escaped' | 'defeated' | 'left' | 'expired';
  areaId: string; discipleId: string; discipleName: string; species: BeastSpeciesView;
  hp: number; maxHp: number; targetHp: number; targetMaxHp: number;
  round: number; attempts: number; maxRounds: number; maxAttempts: number; captureRate: number;
  expiresAt: number; logs: string[]; caught: SpiritBeastView | null;
}
export interface SpiritBeastsPanel {
  unlocked: boolean; unlockLevel: number; capacity: number; maxLevel: number; dailyLimit: number; remaining: number;
  items: SpiritBeastView[]; species: BeastSpeciesView[]; areas: BeastAreaView[];
  collection: { speciesId: string; seen: number; caught: number; bestQuality: BeastQuality | null }[];
  active: BeastCaptureView | null; recent: BeastCaptureView | null;
  reservedSlots: number; availableSlots: number; exchangeOffers: BeastExchangeOffer[];
  rules: string[];
}
export type BeastCaptureAction = 'attack' | 'restrain' | 'capture' | 'leave';
