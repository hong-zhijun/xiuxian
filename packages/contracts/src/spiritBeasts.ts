export type BeastElement = 'metal' | 'wood' | 'water' | 'fire' | 'earth';
export type BeastTier = 'spirit' | 'rare' | 'divine';
export type BeastQuality = 'common' | 'spirit' | 'treasure' | 'immortal';
export interface BeastAttrs { attack: number; defense: number; speed: number; luck: number; physique: number }
export interface BeastIdentity { id: string; speciesId: string; quality: BeastQuality; level: number }
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
  rules: string[];
}
export type BeastCaptureAction = 'attack' | 'restrain' | 'capture' | 'leave';
