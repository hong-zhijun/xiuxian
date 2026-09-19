import { apiRequest, setCsrfToken } from './client';

/**
 * 游戏与账号接口（类型与后端 modules/game/view.ts 一一对应）。
 *
 * 金额/资源用「最小单位十进制字符串」，1 展示单位 = 1000 最小单位；
 * 前端只做展示格式化，所有 canXxx / blockedReason 都由服务端算好。
 */

export interface UserSummary {
  id: string;
  account: string;
  status: string;
  createdAt: string;
}

export interface MeData {
  user: UserSummary;
  sect: null;
  csrfToken: string;
}

export interface ResourceView {
  id: string;
  name: string;
  balance: string;
  capacity: string;
  ratePerHour: string;
  capped: boolean;
  discarded: string;
}

export interface DiscipleView {
  id: string;
  name: string;
  gender: string;
  aptitude: number;
  realmId: string;
  realmName: string;
  stage: number;
  stageName: string;
  cultivation: number;
  requiredCultivation: number | null;
  cultivationRatePerHour: number;
  assignment: string;
  assignmentName: string;
  injuredUntil: string | null;
  canBreakthrough: boolean;
  blockedReason: string | null;
  breakthroughCost: string;
  breakthroughChanceBp: number;
  /** 战斗属性（只影响战力，资质只影响修炼）。 */
  attack: number;
  defense: number;
  speed: number;
  talent: string;
  talentName: string;
  /** 当前战力（服务端按 realms.ts 公式算好）。 */
  combatPower: number;
  /** 淬体丹：已服用次数 / 剩余次数与服务端算好的短板预览（null = 无短板或已用完）。 */
  bodyTemperingUses: number;
  bodyTemperingRemaining: number;
  bodyTemperingTarget: 'attack' | 'defense' | 'speed' | null;
  bodyTemperingGain: number;
}

export interface BuildingView {
  defId: string;
  name: string;
  level: number;
  maxLevel: number;
  upgradeCost: Record<string, string> | null;
  canUpgrade: boolean;
  blockedReason: string | null;
}

export interface RecruitView {
  cost: Record<string, string>;
  dailyLimit: number;
  usedToday: number;
  remaining: number;
  discipleCount: number;
  discipleCapacity: number;
  canRecruit: boolean;
  blockedReason: string | null;
}

export interface EventLogView {
  id: string;
  eventId: string;
  name: string;
  description: string;
  /** 资源变化：resourceId -> 最小单位数量（带符号）。 */
  effects: Record<string, string>;
  createdAt: string;
}

/** 可选岗位（与后端 view.ts 的 AssignmentOptionView 一一对应）。 */
export interface AssignmentOptionView {
  id: string;
  name: string;
  /** 该岗位当前占用人数（null = 该岗位无人数限制）。 */
  currentCount: number | null;
  /** 该岗位人数上限（null = 无限制）。 */
  maxCount: number | null;
}

export interface SectStateView {
  sect: {
    id: string;
    name: string;
    level: number;
    levelName: string;
    veinLevel: number;
    discipleCapacity: number;
    buildingCapacity: number;
    lastSettledAt: string;
    reputation: number;
    /** 守擂阵容（3 名弟子 id，顺序即出战顺序）；null = 尚未布阵。 */
    defenseLineup: string[] | null;
  };
  serverNow: string;
  resources: ResourceView[];
  disciples: DiscipleView[];
  buildings: BuildingView[];
  recruit: RecruitView;
  /** 可选岗位（含闲置）；有上限的岗位（如采灵）会给出 currentCount / maxCount。 */
  assignments: AssignmentOptionView[];
  /** 最近事件（新→旧，服务端最多返回 10 条）。 */
  recentEvents: EventLogView[];
  settle: {
    durationSeconds: number;
    cappedByOfflineLimit: boolean;
    clockWentBackwards: boolean;
    totalDiscarded: string;
  };
  /** 宗门升级信息；null = 已满级。 */
  sectUpgrade: SectUpgradeView | null;
  /** 炼丹面板（配方/库存/解锁状态，canCraft 与短板预览都由服务端算好）。 */
  alchemy: AlchemyView;
  /** 主动挑战的当日次数（每日 3 次；失败/零奖励同样消耗）。 */
  challenge: {
    dailyLimit: number;
    usedToday: number;
    remaining: number;
  };
}

/** 单个丹方（与后端 view.ts 的 AlchemyRecipeView 一一对应）。 */
export interface AlchemyRecipeView {
  id: string;
  name: string;
  description: string;
  /** 单颗炼制成本（最小单位）。 */
  cost: Record<string, string>;
  /** 当前库存（非负整数）。 */
  owned: number;
  /** 是否可炼制（解锁 + 资源足够一颗；数量 × 成本的精确检查由服务端执行）。 */
  canCraft: boolean;
  blockedReason: string | null;
}

/** 炼丹面板状态（与后端 view.ts 的 AlchemyView 一一对应）。 */
export interface AlchemyView {
  unlocked: boolean;
  blockedReason: string | null;
  recipes: AlchemyRecipeView[];
}

export interface BreakthroughOutcome {
  discipleId: string;
  discipleName: string;
  success: boolean;
  chanceBp: number;
  roll: number;
  message: string;
}

/** 炼制结果（与后端 service.ts 的 CraftPillOutcome 一一对应）。 */
export interface CraftPillOutcome {
  pillId: string;
  pillName: string;
  quantity: number;
  /** 本次炼制的实际总成本（单颗 × quantity）。 */
  cost: Record<string, string>;
}

/** 服用效果（与后端 service.ts 的 UsePillOutcome['effect'] 一一对应）。 */
export interface PillUseEffect {
  kind: 'heal' | 'cultivation' | 'bodyTempering';
  gain?: number;
  attribute?: 'attack' | 'defense' | 'speed';
}

/** 服用结果（与后端 service.ts 的 UsePillOutcome 一一对应）。 */
export interface UsePillOutcome {
  pillId: string;
  pillName: string;
  discipleId: string;
  discipleName: string;
  effect: PillUseEffect;
}

export interface GameActionData {
  state: SectStateView;
  outcome?:
    | BreakthroughOutcome
    | { discipleName: string; aptitude: number }
    | CraftPillOutcome
    | UsePillOutcome;
}

/** 宗门升级面板信息（与后端 view.ts 的 SectUpgradeView 一一对应）。 */
export interface SectUpgradeView {
  nextLevel: number;
  nextLevelName: string;
  cost: Record<string, string>;
  requirements: { label: string; met: boolean }[];
  canUpgrade: boolean;
  blockedReason: string | null;
}

export async function fetchMe(): Promise<MeData> {
  const data = await apiRequest<MeData>('/api/v1/auth/me');
  setCsrfToken(data.csrfToken);
  return data;
}

export async function login(account: string, password: string): Promise<{ account: string }> {
  const data = await apiRequest<{ user: UserSummary; csrfToken: string }>('/api/v1/auth/login', {
    method: 'POST',
    body: { account, password },
  });
  setCsrfToken(data.csrfToken);
  return { account: data.user.account };
}

export async function register(
  account: string,
  password: string,
  inviteCode?: string,
): Promise<{ account: string }> {
  const body = inviteCode === undefined ? { account, password } : { account, password, inviteCode };
  const data = await apiRequest<{ user: UserSummary; csrfToken: string }>('/api/v1/auth/register', {
    method: 'POST',
    body,
  });
  setCsrfToken(data.csrfToken);
  return { account: data.user.account };
}

export async function logout(): Promise<void> {
  await apiRequest<{ loggedOut: boolean }>('/api/v1/auth/logout', { method: 'POST', body: {} });
  setCsrfToken(null);
}

export async function syncSect(): Promise<SectStateView | null> {
  const data = await apiRequest<{ state: SectStateView | null }>('/api/v1/game/sync');
  return data.state;
}

export async function createSect(name: string): Promise<SectStateView> {
  const data = await apiRequest<GameActionData>('/api/v1/game/create-sect', {
    method: 'POST',
    body: { name },
  });
  return data.state;
}

export async function recruit(choice: number): Promise<GameActionData> {
  return apiRequest<GameActionData>('/api/v1/game/recruit', { method: 'POST', body: { choice } });
}

export async function assign(discipleId: string, assignment: string): Promise<SectStateView> {
  const data = await apiRequest<GameActionData>('/api/v1/game/assign', {
    method: 'POST',
    body: { discipleId, assignment },
  });
  return data.state;
}

export async function upgradeBuilding(defId: string): Promise<SectStateView> {
  const data = await apiRequest<GameActionData>('/api/v1/game/upgrade-building', {
    method: 'POST',
    body: { defId },
  });
  return data.state;
}

export async function breakthrough(discipleId: string): Promise<GameActionData> {
  return apiRequest<GameActionData>('/api/v1/game/breakthrough', {
    method: 'POST',
    body: { discipleId },
  });
}

/** 事件历史（GET /game/events，最近 20 条）。 */
export async function fetchEventLog(): Promise<EventLogView[]> {
  const data = await apiRequest<{ events: EventLogView[] }>('/api/v1/game/events');
  return data.events;
}

export async function upgradeSect(): Promise<SectStateView> {
  const data = await apiRequest<GameActionData>('/api/v1/game/upgrade-sect', {
    method: 'POST',
    body: {},
  });
  return data.state;
}

/** 秘境（与后端 view.ts 的 SecretRealmListView 一一对应）。 */
export interface SecretRealmView {
  id: string;
  name: string;
  description: string;
  difficulty: number;
  entryCost: Record<string, string>;
  rewards: Record<string, string>;
  minParty: number;
  maxParty: number;
  dailyLimit: number | null;
  usedToday: number;
  requiredSectLevel: number;
  locked: boolean;
  hasArena: boolean;
}

/** 一次探索的结果（与后端 view.ts 的 ExplorationResultView 一一对应）。 */
export interface ExplorationResult {
  realmName: string;
  success: boolean;
  chanceBp: number;
  roll: number;
  rewards: Record<string, string>;
  memberNames: string[];
  message: string;
}

export async function fetchSecretRealms(): Promise<SecretRealmView[]> {
  const data = await apiRequest<{ realms: SecretRealmView[] }>('/api/v1/game/realms');
  return data.realms;
}

export async function explore(
  realmId: string,
  discipleIds: string[],
): Promise<{ state: SectStateView; result: ExplorationResult }> {
  return apiRequest<{ state: SectStateView; result: ExplorationResult }>('/api/v1/game/explore', {
    method: 'POST',
    body: { realmId, discipleIds },
  });
}

/** 江湖榜条目（与后端 view.ts 的 LeaderboardEntryView 一一对应）。 */
export interface LeaderboardEntryView {
  sectId: string;
  name: string;
  level: number;
  levelName: string;
  reputation: number;
  discipleCount: number;
  /** 最高境界弟子（「镇派之宝」）；尚无可战弟子时为 null。 */
  topDisciple: {
    name: string;
    realmName: string;
    stageName: string;
  } | null;
  /** 是否是当前用户自己的宗门。 */
  isMe: boolean;
}

/** 公开档案里的弟子：只有能公开的字段（没有修为 / 岗位 / 受伤）。 */
export interface PublicDiscipleView {
  id: string;
  name: string;
  gender: string;
  aptitude: number;
  realmName: string;
  stageName: string;
  attack: number;
  defense: number;
  speed: number;
  talent: string;
  talentName: string;
}

/** 公开档案里的建筑：只有名字和等级（没有升级消耗）。 */
export interface PublicBuildingView {
  name: string;
  level: number;
}

/** 别人宗门的公开档案（与后端 view.ts 的 PublicSectView 一一对应）。 */
export interface PublicSectView {
  sectId: string;
  name: string;
  level: number;
  levelName: string;
  reputation: number;
  disciples: PublicDiscipleView[];
  buildings: PublicBuildingView[];
  /** 是否已设置**有效**的手动守擂阵容（不代表能否挑战；自动守擂也可挑战）。 */
  hasDefenseLineup: boolean;
  /** 挑战预览（相对当前用户）；观看者没有宗门时为 null。 */
  challenge: PublicSectChallengeView | null;
  createdAt: string;
}

/** 不可挑战的稳定原因码（与后端 view.ts 的 ChallengeBlockedReason 一致）。 */
export type ChallengeBlockedReason =
  | 'self'
  | 'daily_limit'
  | 'already_challenged_today'
  | 'defender_insufficient';

/** 守擂方式：有效手动阵容 / 临时自动守擂。 */
export type DefenseMode = 'configured' | 'automatic';

/** 奖励档位稳定标识（与后端 challenge.ts 的 RewardTier 一致）。 */
export type RewardTier =
  | 'lower_3_plus_no_reward'
  | 'lower_2'
  | 'lower_1'
  | 'equal'
  | 'higher_1'
  | 'higher_2'
  | 'higher_3_plus';

/** 「若胜利」的确切奖励预览（数值来自服务端档位表，前端不复制分支）。 */
export interface ChallengeRewardPreviewView {
  tier: RewardTier;
  reputation: number;
  spiritStone: number;
}

/** 公开档案里的挑战预览（与后端 view.ts 的 PublicSectChallengeView 一一对应）。 */
export interface PublicSectChallengeView {
  canChallenge: boolean;
  blockedReason: ChallengeBlockedReason | null;
  /** 守方弟子不足时为 null。 */
  defenseMode: DefenseMode | null;
  dailyLimit: number;
  usedToday: number;
  remaining: number;
  alreadyChallengedToday: boolean;
  /** 守方等级 - 攻方等级。 */
  levelDifference: number;
  rewardPreview: ChallengeRewardPreviewView;
}

/** 挑战中的一轮（战报用，带双方弟子名字）。 */
export interface ChallengeRoundView {
  round: number;
  attackerName: string;
  defenderName: string;
  attackerPower: number;
  defenderPower: number;
  winner: 'attacker' | 'defender';
}

/** 一次挑战的结果（与后端 view.ts 的 ChallengeResultView 一一对应）。 */
export interface ChallengeResultView {
  targetSectName: string;
  rounds: ChallengeRoundView[];
  result: 'win' | 'lose';
  reputationGained: number;
  spiritStoneGained: number;
  message: string;
  /** 开战快照：双方宗门等级与等级差（守方 - 攻方）。 */
  attackerLevel: number;
  defenderLevel: number;
  levelDifference: number;
  rewardTier: RewardTier;
  defenseMode: DefenseMode;
}

/** 挑战历史条目（从自己视角看）。 */
export interface ChallengeHistoryEntryView {
  id: string;
  attackerSectName: string;
  defenderSectName: string;
  rounds: ChallengeRoundView[];
  /** 从攻方视角的胜负。 */
  result: string;
  role: 'attacker' | 'defender';
  reputationGained: number;
  spiritStoneGained: number;
  /** 0012 开战快照；旧记录为 null（前端不伪造值）。 */
  attackerLevel: number | null;
  defenderLevel: number | null;
  levelDifference: number | null;
  rewardTier: RewardTier | null;
  defenseMode: DefenseMode | null;
  createdAt: string;
}

export interface ChallengeHistoryView {
  entries: ChallengeHistoryEntryView[];
  stats: { wins: number; losses: number; total: number };
}

export async function fetchLeaderboard(): Promise<LeaderboardEntryView[]> {
  const data = await apiRequest<{ entries: LeaderboardEntryView[] }>('/api/v1/game/leaderboard');
  return data.entries;
}

export async function fetchPublicSect(sectId: string): Promise<PublicSectView> {
  const data = await apiRequest<{ sect: PublicSectView }>(`/api/v1/game/sect/${sectId}`);
  return data.sect;
}

/** 设置守擂阵容（固定 3 人，顺序即出战顺序）。 */
export async function setDefenseLineup(discipleIds: string[]): Promise<SectStateView> {
  const data = await apiRequest<{ state: SectStateView }>('/api/v1/game/set-defense-lineup', {
    method: 'POST',
    body: { discipleIds },
  });
  return data.state;
}

/** 发起 3v3 挑战（攻方 3 人，顺序即对阵顺序）。 */
export async function challenge(
  targetSectId: string,
  discipleIds: string[],
): Promise<{ state: SectStateView; result: ChallengeResultView }> {
  return apiRequest<{ state: SectStateView; result: ChallengeResultView }>('/api/v1/game/challenge', {
    method: 'POST',
    body: { targetSectId, discipleIds },
  });
}

export async function fetchChallengeHistory(): Promise<ChallengeHistoryView> {
  return apiRequest<ChallengeHistoryView>('/api/v1/game/challenge-history');
}

/** 招募候选人（与后端 names.ts 的 RecruitCandidate 一一对应）。 */
export interface RecruitCandidate {
  name: string;
  gender: string;
  aptitude: number;
  attack: number;
  defense: number;
  speed: number;
  talent: string;
  talentName: string;
}

/** 招募预览（GET /game/recruit-preview）：同一批候选人刷新不变，「换一批」后换人。 */
export interface RecruitPreview {
  candidates: RecruitCandidate[];
  canRecruit: boolean;
  blockedReason: string | null;
  cost: Record<string, string>;
  /** 本境界已用刷新次数。 */
  refreshUsed: number;
  /** 本境界刷新额度（宗门晋升后重置）。 */
  refreshLimit: number;
  /** 还剩几次刷新。 */
  refreshRemaining: number;
}

export async function fetchRecruitPreview(): Promise<RecruitPreview> {
  return apiRequest<RecruitPreview>('/api/v1/game/recruit-preview');
}

/** 换一批有缘人（POST /game/recruit-refresh）：消耗 1 次本境界刷新额度，返回新一批候选人与最新状态。 */
export async function refreshRecruitPreview(): Promise<{
  state: SectStateView;
  preview: RecruitPreview;
}> {
  return apiRequest<{ state: SectStateView; preview: RecruitPreview }>(
    '/api/v1/game/recruit-refresh',
    { method: 'POST' },
  );
}

/** 炼制丹药（POST /game/craft-pill）：quantity 1~5，返回写库后的完整状态与炼制结果。 */
export async function craftPill(pillId: string, quantity: number): Promise<{
  state: SectStateView;
  outcome: CraftPillOutcome;
}> {
  return apiRequest<{ state: SectStateView; outcome: CraftPillOutcome }>('/api/v1/game/craft-pill', {
    method: 'POST',
    body: { pillId, quantity },
  });
}

/** 服用丹药（POST /game/use-pill）：目标弟子必须属于当前宗门，返回写库后的完整状态与服用效果。 */
export async function usePill(pillId: string, discipleId: string): Promise<{
  state: SectStateView;
  outcome: UsePillOutcome;
}> {
  return apiRequest<{ state: SectStateView; outcome: UsePillOutcome }>('/api/v1/game/use-pill', {
    method: 'POST',
    body: { pillId, discipleId },
  });
}
