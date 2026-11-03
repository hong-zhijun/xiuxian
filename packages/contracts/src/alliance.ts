export interface AllianceSummary {
  id: string;
  name: string;
  leaderSectId: string;
  members: { sectId: string; name: string; level: number; contribution: number; joinedAt: string }[];
  memberLimit: number;
  active: boolean;
  isLeader: boolean;
  version: number;
}
export interface AllianceBossView {
  id: string;
  name: string;
  weekKey: string;
  maxHp: number;
  remainingHp: number;
  damage: number;
  attacksToday: number;
  attackLimit: number;
  canAttack: boolean;
  blockedReason: string | null;
  endsAt: string;
  ranking: { sectId: string; name: string; damage: number; rank: number }[];
}
export interface AlliancePanel {
  alliance: AllianceSummary | null;
  available: { id: string; name: string; members: number; memberLimit: number; active: boolean }[];
  invites: { id: string; allianceId: string; allianceName: string; expiresAt: string }[];
  boss: AllianceBossView | null;
  merit: number;
  reputation: number;
  createCost: number;
  joinCooldownUntil: string | null;
  shop: { id: string; name: string; cost: number; description: string; canBuy: boolean; blockedReason: string | null }[];
}
export interface AllianceChatMessage {
  id: string;
  sectName: string;
  content: string;
  isMe: boolean;
  createdAt: string;
}
export type AllianceAction =
  | { action: 'create'; name: string; commandId: string }
  | { action: 'invite'; sectId: string; commandId: string }
  | { action: 'accept'; inviteId: string; commandId: string }
  | { action: 'leave' | 'disband'; commandId: string }
  | { action: 'transfer' | 'kick'; sectId: string; commandId: string }
  | { action: 'attack'; discipleIds: string[]; commandId: string }
  | { action: 'buy'; id: string; commandId: string };
