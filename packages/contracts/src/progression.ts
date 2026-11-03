import { z } from 'zod';

export interface ProgressionReward {
  resources?: Record<string, string>;
  pills?: Record<string, number>;
  reputation?: number;
  scrolls?: { tier: 'xuan' | 'di' | 'tian'; quantity: number };
  cosmetic?: { id: string; name: string; kind: 'frame' | 'title' };
  equipmentBox?: boolean;
  renameToken?: number;
  description: string;
}
export interface CheckinView {
  dateKey: string;
  streak: number;
  totalDays: number;
  checkedToday: boolean;
  nextDay: number;
  days: { day: number; reward: ProgressionReward }[];
  makeupDate: string | null;
  makeupUsed: number;
  makeupLimit: number;
  makeupCost: string;
  canMakeup: boolean;
  blockedReason: string | null;
  milestone: string;
}
export interface AchievementView {
  id: string;
  category: string;
  name: string;
  description: string;
  tier: 'bronze' | 'silver' | 'gold';
  target: number;
  progress: number;
  completed: boolean;
  claimed: boolean;
  reward: ProgressionReward;
}
export type ProgressionDestination = 'sect' | 'disciples' | 'alchemy' | 'equipment' | 'tower' | 'realms' | 'challenge' | 'boss' | 'auction' | 'market' | 'world';
export interface QuestStepView {
  id: string;
  name: string;
  description: string;
  target: number;
  progress: number;
  completed: boolean;
  destination: ProgressionDestination;
}
export interface QuestChapterView {
  id: string;
  name: string;
  steps: QuestStepView[];
  unlocked: boolean;
  completed: boolean;
  claimed: boolean;
  reward: ProgressionReward;
}
export interface ReputationShopItem {
  id: string;
  name: string;
  cost: number;
  reward: ProgressionReward;
  purchased: number;
  limit: number | null;
  canBuy: boolean;
  blockedReason: string | null;
}
export interface ProgressionCosmetic {
  id: string;
  name: string;
  kind: 'frame' | 'title';
}
export interface ProgressionPanel {
  checkin: CheckinView;
  achievements: AchievementView[];
  quests: QuestChapterView[];
  reputation: number;
  reputationShop: ReputationShopItem[];
  cosmetics: ProgressionCosmetic[];
  equippedFrame: string | null;
  equippedTitle: string | null;
  productionBonusBp: number;
  renameTokens: number;
}
const command = { commandId: z.uuid() };
export const progressionActionSchema = z.discriminatedUnion('action', [
  z.strictObject({ ...command, action: z.literal('checkin') }),
  z.strictObject({ ...command, action: z.literal('makeup') }),
  z.strictObject({ ...command, action: z.literal('claim-achievement'), id: z.string().min(1).max(64) }),
  z.strictObject({ ...command, action: z.literal('claim-quest'), id: z.string().min(1).max(64) }),
  z.strictObject({ ...command, action: z.literal('buy-reputation'), id: z.string().min(1).max(64) }),
  z.strictObject({ ...command, action: z.literal('set-frame'), id: z.string().min(1).max(64).nullable() }),
  z.strictObject({ ...command, action: z.literal('set-title'), id: z.string().min(1).max(64).nullable() }),
]);
export type ProgressionAction = z.infer<typeof progressionActionSchema>;
