export type ScratchCardTier = 'basic' | 'lucky' | 'fortune';
export type ScratchCardMode = 'triple' | 'numbers' | 'duel' | 'lines';
export interface ScratchCardBuyInput { tier: ScratchCardTier; requestId: string; mode?: ScratchCardMode }
export type ScratchSymbol = 'coin' | 'sword' | 'pill' | 'crane' | 'dragon';

export interface ScratchCardModeView {
  id: ScratchCardMode;
  name: string;
  tagline: string;
  description: string;
  rules: string[];
  rewardRules: { label: string; payout: string }[];
  maxMultiplier: number;
  winChanceBp: number;
  returnRateBp: number;
}
export interface ScratchCardCell {
  value: string;
  label: string;
  multiplier: number;
  winning: boolean;
}
export interface ScratchCardWin { label: string; multiplier: number; indexes: number[] }

export interface ScratchCardPanel {
  modes: ScratchCardModeView[];
  tiers: { id: ScratchCardTier; name: string; cost: string; maxReward: string }[];
  prizes: { symbol: ScratchSymbol; name: string; glyph: string; multiplier: number; chanceBp: number }[];
  blankChanceBp: number;
  returnRateBp: number;
}

/** All amounts use the game's minimum unit (1 displayed spirit stone = 1000). */
export interface ScratchCardTicket {
  id: string;
  requestId: string;
  tier: ScratchCardTier;
  tierName: string;
  mode: ScratchCardMode;
  modeName: string;
  cells: ScratchCardCell[];
  targets: number[];
  wins: ScratchCardWin[];
  cost: string;
  reward: string;
  netGain: string;
  multiplier: number;
  symbols: ScratchSymbol[];
  winningSymbol: ScratchSymbol | null;
  createdAt: string;
  message: string;
}
