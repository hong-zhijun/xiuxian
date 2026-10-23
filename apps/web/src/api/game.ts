import type { BeastIdentity, BeastAttrs, BeastElement, BeastTier, SpiritBeastsPanel, BeastCaptureAction, BeastManageAction, BeastExchangeInput, BeastCommandReceipt } from '@xiuxian/contracts';
import { apiRequest, setCsrfToken } from './client';
import type { AvatarFrameId } from '../utils/avatarFrames';

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
  /** 0051 山河舆图：本宗占着的灵地每小时供奉（最小单位，整点入账）；缺省视为 0。 */
  worldRatePerHour?: string;
  capped: boolean;
  discarded: string;
}

/** 携带的灵兽：beast_json 里的身份（种类 / 品质 / 等级）加上图鉴里的名称、五行、档次与技能。 */
export type SpiritBeastView = BeastIdentity & {
  name: string;
  qualityName: string;
  element: BeastElement;
  elementName: string;
  tier: BeastTier;
  tierName: string;
  skillName: string;
  skillText: string;
  attrs: BeastAttrs;
  image: string;
  avatar: string;
  /** 这只灵兽给弟子加的战力（基点，已按等级折算）：与装备加成一起进同一个括号，战力里已含它。 */
  powerBonusBp: number;
};

export interface DiscipleView {
  spiritBeast?: SpiritBeastView | null;
  captureUntil?: number | null;
  id: string;
  name: string;
  gender: string;
  aptitude: number;
  realmId: string;
  realmName: string;
  /** 境界在服务端境界表里的下标（0 = 最低）：排序用，不按境界名字符串比较。 */
  realmOrder: number;
  stage: number;
  stageName: string;
  cultivation: number;
  requiredCultivation: number | null;
  cultivationRatePerHour: number;
  assignment: string;
  assignmentName: string;
  injuredUntil: string | null;
  /** 重伤卧床（世界 Boss 造成，1 天）：ISO 字符串，格式与 injuredUntil 相同；null = 未重伤。 */
  severeInjuredUntil: string | null;
  canBreakthrough: boolean;
  /** 除灵气外的破境条件都已满足（批量破境按这个挑人，灵气整批合计后再判断）。 */
  breakthroughReadyExceptEnergy: boolean;
  blockedReason: string | null;
  breakthroughCost: string;
  breakthroughChanceBp: number;
  /** 战斗属性（只影响战力，资质只影响修炼）。 */
  attack: number;
  defense: number;
  speed: number;
  /** 0016 幸运 / 体魄（1~100）：只作用于单人定时历练的额外收获与受伤概率。 */
  luck: number;
  physique: number;
  talent: string;
  talentName: string;
  /** 天赋重构：当前境界下的天赋效果（如「矿石产出 +30%」）；无天赋为空串。 */
  talentEffect: string;
  /** 天赋重构：洗髓丹已服 / 剩余次数。 */
  talentRerollUses: number;
  talentRerollRemaining: number;
  /** 0066 功法：主修功法 id / 名称（「无」）/ 参悟等级 / 熟练度基点（0~10000，读时现算）。 */
  techniqueId: string | null;
  techniqueName: string;
  techniqueLevel: number;
  techniqueProficiency: number;
  /** 天赋重构：洗髓丹洗出、待二选一的候选天赋；null = 没有。 */
  talentCandidate: { id: string; name: string; effect: string } | null;
  /** 天赋重构：所任执事职位 id；不是执事为 null。 */
  stewardOffice: string | null;
  /** 天赋重构：执事交接期结束时间（ISO）；不在交接期为 null。 */
  stewardHandoverUntil: string | null;
  /** 天赋重构：不能出战的短原因（「任炼器执事」「执事交接中」）；能出战为 null。 */
  combatBlockedReason: string | null;
  /** 天赋重构 · 丹心：这名弟子每颗聚气丹的修为。 */
  cultivationPillGain: number;
  /** 凝元丹：这名弟子每颗的修为与「服到满」需要几颗（0 = 不可服用）。 */
  greatCultivationPillGain: number;
  greatCultivationPillsToFull: number;
  /** 培元丹：已服 / 剩余次数与「服到满」能服几颗（0 = 不可服用）。 */
  aptitudePillUses: number;
  aptitudePillRemaining: number;
  aptitudePillsToFull: number;
  /** 悟道丹：还能再收多少悟道值（上限 − 已分配 − 未分配余额）。 */
  daoInsightRoom: number;
  /** 天赋重构 · 铁骨：讨伐受伤 / 重伤概率减免（基点）。 */
  bossInjuryReductionBp: number;
  /** 当前战力（服务端按 realms.ts 公式算好）。 */
  combatPower: number;
  /**
   * 0028 装备加成（该弟子已穿装备的 5 项属性之和；没有装备时全 0）。
   * 战力已经计入这份加成，前端不要自己再加；上面的 attack/defense/… 仍是**基础属性**（最高 100）。
   */
  gear: {
    attack: number;
    defense: number;
    speed: number;
    luck: number;
    physique: number;
  };
  /** 0032 装备战力加成（基点，10000 = +100%）：身上装备按品质相加；战力已计入，前端只展示。 */
  gearPowerBonusBp: number;
  /**
   * 灵兽战力加成（基点）：与装备加成一起进战力公式的同一个括号，战力里已经含它。
   * 灵兽卡片用它显示「战力 +X%」；没有灵兽时 0。
   */
  beastPowerBonusBp: number;
  /**
   * 0016 综合评分：**当前**六项属性等权现算，固定一位小数（服务端 names.ts 的
   * attributeScore）。不是战力：境界、修为、天赋都不参与；服务端不落库，
   * 淬体丹改完攻/防/速之后随下一次 sync 自动更新。
   */
  attributeScore: number;
  /** 淬体丹：已服用次数 / 剩余次数与服务端算好的短板预览（null = 无短板或已用完）。 */
  bodyTemperingUses: number;
  bodyTemperingRemaining: number;
  bodyTemperingTarget: 'attack' | 'defense' | 'speed' | null;
  bodyTemperingGain: number;
  /** 聚气丹「服到满」（修为达到突破门槛）需要几颗；0 = 不可服用。 */
  cultivationPillsToFull: number;
  /** 淬体丹「服到满」的逐颗计划（服务端算好）；长度即需要几颗，空 = 不可服用。 */
  bodyTemperingPlan: { attribute: 'attack' | 'defense' | 'speed'; gain: number }[];
  /** 0013 掌门私有备注（单行纯文本，≤60 字；空串 = 未填写）。只在自己的 sync 状态里有值。 */
  note: string;
  /** 0017 头像框样式 id（白名单，见 utils/avatarFrames.ts）：旧、新弟子默认 `classic`。 */
  avatarFrameId: string;
  /** 0038 自定义头像的内容哈希（null = 没有，显示头像框 / 旧式）；公开外观。 */
  avatarHash: string | null;
  /** 0014 历练状态：none / active / ready + 名额与不可出发原因（全部服务端算好，前端只渲染）。 */
  journey: DiscipleJourneyView;
  /** 0051 山河舆图：坐镇的灵地全名（如「青木域 · 百草谷」）；没有坐镇为 null。坐镇中不能转岗、历练、出战。 */
  garrisonSiteName: string | null;

  /** 0019 悟道值：当前可用余额（赌坊赢得，可在弟子详情里分配到属性）。 */
  daoInsight: number;
  /** 0019 已累计分配的悟道值（上限与后端 DAO_INSIGHT_CAP 同口径，服务端保证不超）。 */
  daoInsightUsed: number;
  /** 0019 剩余可分配额度 = max(0, 上限 - daoInsightUsed)，服务端算好。 */
  daoInsightRemaining: number;
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
  /** 还能招几个人（= 弟子上限 − 现有弟子数）。0021 起已无「每日 3 次」上限。 */
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

/** 改名面板（与后端 view.ts 的 RenameView 一一对应）：价格是最小单位，前端 formatAmount 做除法。 */
export interface RenameView {
  /** 宗门改名消耗（灵石，最小单位）。 */
  sectCost: string;
  /** 弟子改名消耗（灵石，最小单位）。 */
  discipleCost: string;
  /** 宗门名长度规则（Unicode 码点）。 */
  sectNameMinChars: number;
  sectNameMaxChars: number;
  /** 弟子名长度规则（Unicode 码点）。 */
  discipleNameMinChars: number;
  discipleNameMaxChars: number;
}

export interface SectStateView {
  /** 0066 功法：宗门已收录的功法（弟子「更换主修」的候选）。 */
  learnedTechniques: { id: string; name: string; level: number; tierName: string; schoolName: string; summary: string }[];
  /** 0066 功法：各功法持有的残卷数（只列 > 0 的）。 */
  techniqueScrolls: Record<string, number>;
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
    /** 0073 宗门头像哈希（null = 没有，顶栏用静态 Logo）。 */
    avatarHash: string | null;
  };
  serverNow: string;
  resources: ResourceView[];
  disciples: DiscipleView[];
  buildings: BuildingView[];
  recruit: RecruitView;
  /** 改名消耗与名称长度规则（0021：宗门 / 弟子改名，规则与价格都由服务端给）。 */
  rename: RenameView;
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
  /** 天赋重构：天赋总表（弟子详情「?」弹窗）。 */
  talents: TalentCatalogEntry[];
  /** 天赋重构：执事堂。 */
  stewards: StewardsView;
  /** 境界一览（弟子详情境界旁的「?」）。 */
  realmCatalog: RealmCatalogEntry[];
  /** 宗门等级一览（首页宗门品阶旁的「?」）。 */
  sectLevelCatalog: SectLevelCatalogEntry[];
  /** 主动挑战的当日次数（每日 3 次；失败/零奖励同样消耗）。 */
  challenge: {
    dailyLimit: number;
    usedToday: number;
    remaining: number;
  };
  /** 0019 赌坊面板：解锁（宗门 2 级，不依赖建筑）与当日次数（20 次/天，论道 + 天机轮共享）。 */
  gambling: {
    unlocked: boolean;
    blockedReason: string | null;
    dailyLimit: number;
    usedToday: number;
    remaining: number;
    stats: {
      total: number;
      wins: number;
      losses: number;
      winRate: number;
      netSpiritStone: number;
      totalInsight: number;
    } | null;
    /** 0020 天机轮：赌坊未解锁时为 null；解锁后带当前格局与档位费用（全部服务端口径）。 */
    wheel: WheelView | null;
    /** 0046 赌石：赌坊未解锁时为 null；解锁后四档（门槛、概率、玄铁个数都是服务端口径）。 */
    stones: StoneGambleView | null;
  };
  /** 0014 宗门历练名额与最近 10 条历练摘要（仅本宗可见，结果由服务端决定）。 */
  journey: JourneyView;
  /** V6 进行中的交互式秘境探索；null = 当前没有（刷新后据此恢复断点）。 */
  activeExploration: ActiveExplorationView | null;
  /** 0025 世界 Boss（讨伐）：是否可出手（按钮角标；只有 sync 会给真值）。 */
  worldBoss: { attackable: boolean };
  /** 0039 镇妖塔：今天还能扫荡（按钮角标；只有 sync / 塔面板会给真值）。 */
  tower?: { sweepable: boolean };
  /** 0040 拍卖行：待领取单数（按钮角标；只有 sync / 拍卖行面板会给真值）。 */
  auction?: { claimable: number };
  /**
   * 坊市面板：材料买卖价 + 可回收的丹药（价格单位都是最小单位灵石，前端只展示、不复算规则）。
   * 买入价 / 卖出价按「1 展示单位材料」计价，买入会被服务端再按材料容量上限挡一次。
   */
  shop: {
    /** 买 1 展示单位材料要花的灵石（最小单位，= 667）。 */
    buyPrice: number;
    /** 卖 1 展示单位材料能得的灵石（最小单位，= 500）。 */
    sellPrice: number;
    /** 兑换 1 个玄铁要花几个神木（展示单位）。 */
    shenmuPerXuantie: number;
    /** 可回收的丹药：有回收价的丹方都会下发（库存为 0 的也在列表里，前端自行标灰）；owned 是库存颗数。 */
    pills: Array<{ id: string; name: string; owned: number; sellPrice: number }>;
  };
}

/** 单个丹方（与后端 view.ts 的 AlchemyRecipeView 一一对应）。 */
export interface AlchemyRecipeView {
  id: string;
  name: string;
  /** 分组（heal / cultivation / attribute / talent）、单字图标与一句话效果（服务端下发）。 */
  category: string;
  glyph: string;
  summary: string;
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
  /** 聚气丹单次修为增益（服务端下发，前端只渲染，不复制丹药常量）。 */
  cultivationPillGain: number;
  /** 单次炼制的数量上限（服务端下发）。 */
  maxCraftQuantity: number;
  /** 天赋重构：丹房执事的折扣文案；配方 cost 已是折后价。没有为 null。 */
  costDiscountText: string | null;
  /** 分组的展示顺序与名称。 */
  categories: { id: string; name: string }[];
}

/** 天赋总表的一行（服务端 talents.ts 的 talentCatalog）。 */
export interface TalentCatalogEntry {
  id: string;
  name: string;
  category: 'production' | 'cultivation' | 'combat' | 'steward';
  categoryName: string;
  condition: string;
  effect: string;
  values: {
    realmId: string;
    realmName: string;
    /** 带符号的百分比文案，如「+25%」。 */
    text: string;
    /** 加成原值（基点，10000 = 100%）；升境界模拟据此算战意加成。 */
    bp: number;
  }[];
}

/** 境界一览的一行（服务端 view.ts 的 RealmCatalogEntry）。 */
export interface RealmCatalogEntry {
  id: string;
  name: string;
  /** 修炼倍率（挂机修炼 / 历练修为 / 修为丹都乘它）。 */
  cultivationMultiplier: number;
  /** 天赋系数文案，如「×2.75」。 */
  talentMultiplierText: string;
  stages: {
    stage: number;
    name: string;
    /** 突破门槛；null = 当前版本最高阶段。 */
    requiredCultivation: number | null;
    /** 破境灵气（最小单位）；最高阶段为 null。 */
    breakthroughCost: string | null;
  }[];
}

/** 宗门等级一览的一行。 */
export interface SectLevelCatalogEntry {
  level: number;
  name: string;
  discipleCapacity: number;
  capacityMultiplier: number;
  /** 升到本级的消耗（最小单位）；1 级为空对象。 */
  upgradeCost: Record<string, string>;
  /** 升到本级的条件文案。 */
  requirements: string[];
}

/** 执事堂的一个职位（全部服务端算好）。 */
export interface StewardOfficeView {
  office: string;
  name: string;
  talentId: string;
  talentName: string;
  discipleId: string | null;
  discipleName: string | null;
  realmName: string | null;
  /** 现任执事的效果；空缺为 null。 */
  effect: string | null;
  /** 执事在外历练，加成暂停。 */
  paused: boolean;
  /** 今天还能不能任命（每职位每天一次）。 */
  canAppointToday: boolean;
}

export interface StewardsView {
  offices: StewardOfficeView[];
  handoverHours: number;
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
  kind: 'heal' | 'cultivation' | 'bodyTempering' | 'talentReroll' | 'insight' | 'aptitude';
  /** 洗髓丹洗出的候选天赋（待二选一）。 */
  candidate?: { id: string; name: string; effect: string };
  /** 总提升量。 */
  gain?: number;
  /** 淬体丹第一颗补的属性。 */
  attribute?: 'attack' | 'defense' | 'speed';
  /** 淬体丹各属性的累计提升量（连服时可能补到不止一项）。 */
  gains?: Partial<Record<'attack' | 'defense' | 'speed', number>>;
}

/** 服用结果（与后端 service.ts 的 UsePillOutcome 一一对应）。 */
export interface UsePillOutcome {
  pillId: string;
  pillName: string;
  discipleId: string;
  discipleName: string;
  /** 实际服用颗数（服务端按「服到满所需」与库存截断）。 */
  count: number;
  effect: PillUseEffect;
}

export interface GameActionData {
  state: SectStateView;
  outcome?:
    | BreakthroughOutcome
    | RecruitOutcome
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

/** 修改密码：成功后本账号其他设备的会话全部失效，当前会话保留（revokedSessions = 下线的设备数）。 */
export async function changePassword(
  oldPassword: string,
  newPassword: string,
): Promise<{ revokedSessions: number }> {
  return apiRequest<{ changed: boolean; revokedSessions: number }>('/api/v1/auth/change-password', {
    method: 'POST',
    body: { oldPassword, newPassword },
  });
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

/** 招贤：choice 是弹窗里选中的候选人序号；batch 是预览下发的批次标识（0016，过期会被拒）。 */
export async function recruit(choice: number, batch: string): Promise<GameActionData> {
  return apiRequest<GameActionData>('/api/v1/game/recruit', {
    method: 'POST',
    body: { choice, batch },
  });
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

/** 批量命令里被跳过的弟子（与后端 service.ts 的 BatchSkippedDisciple 一一对应）。 */
export interface BatchSkippedDisciple {
  discipleId: string;
  discipleName: string;
  reason: string;
}

/** 批量换岗结果（POST /game/assign-batch 的 outcome）。 */
export interface AssignBatchOutcome {
  assignment: string;
  assignmentName: string;
  assigned: { discipleId: string; discipleName: string }[];
  skipped: BatchSkippedDisciple[];
}

/** 批量破境结果（POST /game/breakthrough-batch 的 outcome）。 */
export interface BreakthroughBatchOutcome {
  results: BreakthroughOutcome[];
  skipped: BatchSkippedDisciple[];
  /** 本次共消耗的灵气（最小单位）。 */
  energySpent: string;
}

/** 批量疗伤结果（POST /game/heal-batch 的 outcome）。 */
export interface HealBatchOutcome {
  healed: { discipleId: string; discipleName: string }[];
  skipped: BatchSkippedDisciple[];
  pillsUsed: number;
  /** autoCraft 时现炼并直接服下的颗数（库存够时为 0）。 */
  crafted: number;
  /** 现炼花掉的资源（最小单位）。 */
  craftCost: Record<string, string>;
}

/** 批量换岗：按数组顺序逐个转，不符合条件的由服务端跳过并列出原因。 */
export async function assignBatch(
  discipleIds: string[],
  assignment: string,
): Promise<{ state: SectStateView; outcome: AssignBatchOutcome }> {
  return apiRequest<{ state: SectStateView; outcome: AssignBatchOutcome }>('/api/v1/game/assign-batch', {
    method: 'POST',
    body: { discipleIds, assignment },
  });
}

/** 批量破境：不满足条件的跳过；灵气须够全部可破境弟子，否则整批拒绝。 */
export async function breakthroughBatch(
  discipleIds: string[],
): Promise<{ state: SectStateView; outcome: BreakthroughBatchOutcome }> {
  return apiRequest<{ state: SectStateView; outcome: BreakthroughBatchOutcome }>(
    '/api/v1/game/breakthrough-batch',
    { method: 'POST', body: { discipleIds } },
  );
}

/**
 * 批量疗伤（回春丹一人一颗）：无伤 / 重伤 / 在外的跳过；库存须够全部伤员，否则整批拒绝。
 * autoCraft = true（一键疗伤）：库存不够时服务端按配方现炼差额，资源也不够才拒绝。
 */
export async function healBatch(
  discipleIds: string[],
  autoCraft = false,
): Promise<{ state: SectStateView; outcome: HealBatchOutcome }> {
  return apiRequest<{ state: SectStateView; outcome: HealBatchOutcome }>('/api/v1/game/heal-batch', {
    method: 'POST',
    body: autoCraft ? { discipleIds, autoCraft } : { discipleIds },
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
  /** 成功时的概率掉落说明（如「玄铁 1~2（15%）」）；没有则为 null。 */
  bonusDropText: string | null;
  minParty: number;
  maxParty: number;
  dailyLimit: number | null;
  usedToday: number;
  requiredSectLevel: number;
  locked: boolean;
  hasArena: boolean;
  /** V6：是否开放交互式「探索」（未开放时只显示「速通」）。 */
  exploreEnabled: boolean;
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

/** 一键速通结果：自动执行该秘境今日剩余次数。 */
export interface RealmSpeedrunAllResult {
  realmName: string;
  plannedAttempts: number;
  completedAttempts: number;
  successes: number;
  failures: number;
  runs: ExplorationResult[];
  rewards: Record<string, string>;
  healedNames: string[];
  pillsUsed: number;
  crafted: number;
  craftCost: Record<string, string>;
  stopReason: string | null;
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

export async function speedrunAll(
  realmId: string,
): Promise<{ state: SectStateView; result: RealmSpeedrunAllResult }> {
  return apiRequest<{ state: SectStateView; result: RealmSpeedrunAllResult }>(
    '/api/v1/game/explore/speedrun-all',
    { method: 'POST', body: { realmId } },
  );
}

/** 江湖榜条目（与后端 view.ts 的 LeaderboardEntryView 一一对应）。 */
export interface LeaderboardEntryView {
  sectId: string;
  name: string;
  level: number;
  levelName: string;
  reputation: number;
  /** 0073 宗门头像哈希（null = 没有，榜单显示宗门名首字）。 */
  avatarHash: string | null;
  /** 门人战力：战力最高的 5 名弟子的含装备战力合计（综合榜第三排序键，也显示在榜行）。 */
  sectPower: number;
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
  /** 境界下标 / 阶段 / 境界 id（排序、头像配色用；境界不能按名称字符串比较）。 */
  realmOrder: number;
  stage: number;
  realmId: string;
  /** 0038 自定义头像哈希（null = 没有）。 */
  avatarHash: string | null;
  /** 当前战力（服务端现算；只由已公开的字段算出，不泄漏私有属性）。 */
  combatPower: number;
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
  /** 0073 宗门头像哈希（null = 没有；公开外观，按内容哈希取图）。 */
  avatarHash: string | null;
  /** 镇妖塔历史最高层（0 = 一层都还没过）。 */
  towerFloor: number;
  /** 已收录的功法数量（参悟到 1 级及以上才算）。 */
  techniqueCount: number;
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

/** 弟子榜单条目（与后端 view.ts 的 DiscipleLeaderboardEntryView 一一对应）。 */
export interface DiscipleLeaderboardEntryView {
  rank: number;
  discipleId: string;
  discipleName: string;
  gender: string;
  realmId: string;
  frameId: string;
  /** 0038 自定义头像哈希（null = 没有）。 */
  avatarHash: string | null;
  sectId: string;
  sectName: string;
  realmName: string;
  stageName: string;
  realmOrder: number;
  stage: number;
  combatPower: number;
  attributeScore: number;
  talent: string;
  talentName: string;
  /** 战力加成（基点）= 装备 + 灵兽：两者进同一个括号，装备榜也按它排行。 */
  gearPowerBonusBp: number;
  /** 装备榜才有：三个部位各穿了什么品质（没穿的部位 quality 为 null）。 */
  gearSlots?: DiscipleLeaderboardGearSlotView[];
  /** 装备榜才有：携带的灵兽（类型 + 名字，例如「神兽 庚金白虎」）；没带为 null。 */
  spiritBeast?: DiscipleLeaderboardBeastView | null;
  isMe: boolean;
}

export interface DiscipleLeaderboardGearSlotView {
  slot: string;
  slotName: string;
  quality: string | null;
  qualityName: string | null;
  color: string | null;
}

/** 装备榜一行里的灵兽：只给列表要显示的「类型 + 名字」。 */
export interface DiscipleLeaderboardBeastView {
  name: string;
  /** 类型 id（spirit / rare / divine）：按它取色（与灵兽弹窗同一个色板）。 */
  tier: string;
  tierName: string;
}

export interface DiscipleLeaderboardView {
  byCombatPower: DiscipleLeaderboardEntryView[];
  byAttributeScore: DiscipleLeaderboardEntryView[];
  /** 0032 装备榜：没穿装备的不上榜。 */
  byEquipment: DiscipleLeaderboardEntryView[];
}

export async function fetchDiscipleLeaderboard(): Promise<DiscipleLeaderboardView> {
  return apiRequest<DiscipleLeaderboardView>('/api/v1/game/disciple-leaderboard');
}

/** 天骄榜点开的弟子公开档案（任何登录玩家可看；不含掌门备注等私有字段）。 */
export interface DiscipleProfileView {
  discipleId: string;
  name: string;
  gender: string;
  realmId: string;
  frameId: string;
  /** 0038 自定义头像哈希（null = 没有）。 */
  avatarHash: string | null;
  sectId: string;
  sectName: string;
  /** 是不是观看者自己宗门的弟子。 */
  isMe: boolean;
  realmName: string;
  stageName: string;
  talent: string;
  talentName: string;
  talentDescription: string;
  /** 基础属性（最高 100，不含装备）。 */
  aptitude: number;
  attack: number;
  defense: number;
  speed: number;
  luck: number;
  physique: number;
  /** 装备加成（已穿装备 5 项之和）。 */
  gear: { attack: number; defense: number; speed: number; luck: number; physique: number };
  /** 战力（计入装备，与天骄榜同口径）。 */
  combatPower: number;
  /** 综合评分（六项基础属性等权，不计装备）。 */
  attributeScore: number;
  bodyTemperingUses: number;
  daoInsightUsed: number;
  /** 当前伤势：severe = 重伤卧床，injured = 负伤，null = 无。 */
  injury: 'severe' | 'injured' | null;
  /** 已穿戴的装备（按部位排序）。 */
  equipment: EquipmentItemView[];
  /** 携带的灵兽（null = 未携带）：与弟子详情同一个构造口径。 */
  spiritBeast: SpiritBeastView | null;
  /**
   * 主修功法：未修习时 techniqueId 为 null，techniqueName 与弟子详情同一口径（服务端对空值返回「无」，
   * 卡片上显示成「未修习」是前端的事）。
   */
  techniqueId: string | null;
  techniqueName: string;
  /** 功法等级来自该弟子所在宗门的 sect_techniques 行。 */
  techniqueLevel: number;
  /** 熟练度（基点，0~10000）。 */
  techniqueProficiency: number;
}

export async function fetchDiscipleProfile(discipleId: string): Promise<DiscipleProfileView> {
  return apiRequest<DiscipleProfileView>(
    `/api/v1/game/disciple-profile/${encodeURIComponent(discipleId)}`,
  );
}

export interface ChatMessageView {
  id: string;
  sectName: string;
  content: string;
  isMe: boolean;
  isSystem: boolean;
  createdAt: string;
}

export async function fetchChatMessages(afterId?: string): Promise<ChatMessageView[]> {
  const url = afterId
    ? `/api/v1/game/chat?after=${encodeURIComponent(afterId)}`
    : '/api/v1/game/chat';
  const data = await apiRequest<{ messages: ChatMessageView[] }>(url);
  return data.messages;
}

export async function sendChatMessage(content: string): Promise<ChatMessageView[]> {
  const data = await apiRequest<{ messages: ChatMessageView[] }>('/api/v1/game/chat', {
    method: 'POST',
    body: { content },
  });
  return data.messages;
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

/** 招贤结果（与后端 service.ts 的 recruitDisciple outcome 一一对应）。 */
export interface RecruitOutcome {
  discipleName: string;
  aptitude: number;
  luck: number;
  physique: number;
  attack: number;
  defense: number;
  speed: number;
  /** 六项属性等权现算的综合评分（一位小数）。 */
  attributeScore: number;
  talent: string;
  talentName: string;
}

/** 招募候选人（与后端 names.ts 的 RecruitCandidate 一一对应，含六属性与综合评分）。 */
export interface RecruitCandidate {
  name: string;
  gender: string;
  aptitude: number;
  attack: number;
  defense: number;
  speed: number;
  /** 0016 幸运 / 体魄（1~100）：只作用于单人定时历练。 */
  luck: number;
  physique: number;
  talent: string;
  talentName: string;
  /** 天赋重构：入门时（炼气）的天赋效果。 */
  talentEffect: string;
  /** 0016 综合评分：当前六项属性等权现算，一位小数（服务端算好，前端不另算）。 */
  attributeScore: number;
}

/** 招募预览（GET /game/recruit-preview）：同一批候选人刷新不变，「换一批」后换人。 */
export interface RecruitPreview {
  candidates: RecruitCandidate[];
  /**
   * 0016 批次标识：这批候选人来自哪一次生成机会。招募时必须原样回传；
   * 与当前批次不一致（跨天 / 换过一批 / 已招过一次 / 版本变化）时服务端拒绝且不扣费。
   */
  batch: string;
  canRecruit: boolean;
  blockedReason: string | null;
  cost: Record<string, string>;
  /** 本境界已用刷新次数。 */
  refreshUsed: number;
  /** 本境界刷新额度（宗门晋升后重置）。 */
  refreshLimit: number;
  /** 还剩几次免费刷新。 */
  refreshRemaining: number;
  /** 下一次刷新要花的灵石（最小单位）：还有免费次数时为 0，用完后每次 100 灵石。 */
  refreshCost: number;
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

/**
 * 服用丹药（POST /game/use-pill）：目标弟子必须属于当前宗门，返回写库后的完整状态与服用效果。
 * count = 想服几颗（「服到满」传所需颗数）；服务端会按所需与库存截断，实际颗数见 outcome.count。
 */
export async function usePill(pillId: string, discipleId: string, count = 1): Promise<{
  state: SectStateView;
  outcome: UsePillOutcome;
}> {
  return apiRequest<{ state: SectStateView; outcome: UsePillOutcome }>('/api/v1/game/use-pill', {
    method: 'POST',
    body: { pillId, discipleId, count },
  });
}

/** 洗髓丹二选一回执（与后端 service.ts 的 TalentChoiceOutcome 一一对应）。 */
export interface TalentChoiceOutcome {
  discipleId: string;
  discipleName: string;
  accepted: boolean;
  talent: string;
  talentName: string;
  /** 因换掉天赋而卸任的职位名；没有为 null。 */
  leftOffice: string | null;
}

/** 天赋重构：洗髓丹二选一（accept = true 换成新天赋，false 保留原天赋）。 */
export async function chooseTalent(
  discipleId: string,
  accept: boolean,
): Promise<{ state: SectStateView; outcome: TalentChoiceOutcome }> {
  return apiRequest<{ state: SectStateView; outcome: TalentChoiceOutcome }>('/api/v1/game/talent-choice', {
    method: 'POST',
    body: { discipleId, accept },
  });
}

/** 天赋重构：任命执事（天赋 / 每日一次 / 在外 / 守擂都由服务端校验）。 */
export async function appointSteward(office: string, discipleId: string): Promise<{ state: SectStateView }> {
  return apiRequest<{ state: SectStateView }>('/api/v1/game/steward/appoint', {
    method: 'POST',
    body: { office, discipleId },
  });
}

/** 天赋重构：卸任执事（原执事进入交接期，期间不能出战）。 */
export async function dismissSteward(office: string): Promise<{ state: SectStateView }> {
  return apiRequest<{ state: SectStateView }>('/api/v1/game/steward/dismiss', {
    method: 'POST',
    body: { office },
  });
}

/**
 * 0013 保存弟子私有备注（POST /game/set-disciple-note）：note 为空串表示清空；
 * 服务端 trim 后校验「单行纯文本、≤60 个 Unicode 字符」，返回写库后的完整状态。
 */
export async function setDiscipleNote(discipleId: string, note: string): Promise<SectStateView> {
  const data = await apiRequest<{ state: SectStateView }>('/api/v1/game/set-disciple-note', {
    method: 'POST',
    body: { discipleId, note },
  });
  return data.state;
}

/**
 * 0038 上传弟子自定义头像（POST /game/set-disciple-avatar-image）：
 * data 是浏览器压缩好的成品（utils/avatarImage.ts 的 compressAvatar），服务端按文件头再校验。
 */
export async function setDiscipleAvatarImage(
  discipleId: string,
  mime: string,
  data: string,
): Promise<SectStateView> {
  const result = await apiRequest<{ state: SectStateView }>(
    '/api/v1/game/set-disciple-avatar-image',
    { method: 'POST', body: { discipleId, mime, data } },
  );
  return result.state;
}

/** 0038 移除弟子自定义头像（POST /game/clear-disciple-avatar-image），回到头像框 / 旧式。 */
export async function clearDiscipleAvatarImage(discipleId: string): Promise<SectStateView> {
  const result = await apiRequest<{ state: SectStateView }>(
    '/api/v1/game/clear-disciple-avatar-image',
    { method: 'POST', body: { discipleId } },
  );
  return result.state;
}

/**
 * 0073 上传宗门头像（POST /game/set-sect-avatar-image）：与弟子头像同一个成品口径，
 * data 是浏览器里裁剪压缩好的图片（utils/avatarImage.ts 的 compressAvatar），服务端按文件头再校验。
 */
export async function setSectAvatarImage(mime: string, data: string): Promise<SectStateView> {
  const result = await apiRequest<{ state: SectStateView }>('/api/v1/game/set-sect-avatar-image', {
    method: 'POST',
    body: { mime, data },
  });
  return result.state;
}

/** 0073 移除宗门头像（POST /game/clear-sect-avatar-image），回到静态宗门 Logo。 */
export async function clearSectAvatarImage(): Promise<SectStateView> {
  const result = await apiRequest<{ state: SectStateView }>('/api/v1/game/clear-sect-avatar-image', {
    method: 'POST',
  });
  return result.state;
}

/**
 * 0017 设置弟子头像框（POST /game/set-disciple-avatar-frame）：
 * frameId 只接受白名单里的固定 id（`classic` / `frame01`–`frame20`），不是自由上传；
 * 跨宗或不存在按 `NOT_FOUND` 处理，重复保存同一个值不产生任何副作用。
 */
export async function setDiscipleAvatarFrame(
  discipleId: string,
  frameId: AvatarFrameId,
): Promise<SectStateView> {
  const data = await apiRequest<{ state: SectStateView }>(
    '/api/v1/game/set-disciple-avatar-frame',
    { method: 'POST', body: { discipleId, frameId } },
  );
  return data.state;
}

/**
 * 0021 宗门改名（POST /game/rename-sect）：一次 500 灵石（价目由 state.rename.sectCost 给出）。
 * 名称规则（2-12 个码点、单行纯文本）与灵石余额都由服务端最终裁决；
 * 提交的名字与当前名字相同则不扣费、不写库（服务端显式早退）。
 */
export async function renameSect(name: string): Promise<SectStateView> {
  const data = await apiRequest<{ state: SectStateView }>('/api/v1/game/rename-sect', {
    method: 'POST',
    body: { name },
  });
  return data.state;
}

/**
 * 0021 弟子改名（POST /game/rename-disciple）：一次 50 灵石、2-6 个码点。
 * 与私有备注同一规则：在外历练期间也能改；历史记录（历练 / 赌坊）里的姓名快照不回填。
 */
export async function renameDisciple(discipleId: string, name: string): Promise<SectStateView> {
  const data = await apiRequest<{ state: SectStateView }>('/api/v1/game/rename-disciple', {
    method: 'POST',
    body: { discipleId, name },
  });
  return data.state;
}

/** 驱逐回执（与后端 service.ts 的 ExpelDiscipleOutcome 一一对应）。 */
export interface ExpelDiscipleOutcome {
  discipleId: string;
  discipleName: string;
  /** 该弟子被驱逐前占用手动守擂阵容，阵容已被同批清空（需要重新布阵）。 */
  lineupCleared: boolean;
  /** 驱逐后宗门剩余弟子数（< 3 时无法组成主动挑战阵容、也不能被挑战）。 */
  remainingDisciples: number;
}

/**
 * 0013 驱逐弟子（POST /game/expel-disciple）：只允许自己的现存弟子；
 * 不返还资源/招募次数，不降低宗门等级；成功后该弟子不再出现在返回的 state 里。
 */
export async function expelDisciple(discipleId: string): Promise<{
  state: SectStateView;
  outcome: ExpelDiscipleOutcome;
}> {
  return apiRequest<{ state: SectStateView; outcome: ExpelDiscipleOutcome }>(
    '/api/v1/game/expel-disciple',
    { method: 'POST', body: { discipleId } },
  );
}

/* ---------- 0014 弟子历练 ---------- */

/** 历练方向（与后端 journey.ts 的白名单一致）。 */
export type JourneyDirection = 'daoSeeking' | 'gathering';

/** 单条历练对弟子的归约状态（none = 没有未领取记录）。 */
export type JourneyStatusView = 'none' | 'active' | 'ready';

/** 历练结果（只在到期后公开；未领取时 claimedAt 为 null）。 */
export interface JourneyOutcomeView {
  /** 0061 是否被紧急召回（召回的记录收获全部作废、不会受伤）。 */
  recalled: boolean;
  /** 返程实际入账的修为（受返程门槛封顶；最高阶段为 0）。 */
  cultivationAwarded: number;
  /** 出发时快照的计划修为（含额外收获，未按门槛截断）。 */
  cultivationPlanned: number;
  /** 资源奖励（最小单位；领取时一次性入账）。 */
  resources: Record<string, string>;
  extraHarvest: boolean;
  injured: boolean;
  injuryChanceBp: number;
  /** 伤势复原时间（从到期时间起算 30 分钟）；未受伤为 null。 */
  injuredUntil: string | null;
  completedAt: string | null;
  claimedAt: string | null;
  /** 额外奖励：机遇（修为加倍）/ 悟道（领取时悟道值 +1）/ 淬炼的属性名（领取时 +1）。 */
  fortune: boolean;
  insight: boolean;
  attributeName: string | null;
}

/** 单个弟子的历练状态（DiscipleView.journey）。 */
export interface DiscipleJourneyView {
  status: JourneyStatusView;
  /** 未领取记录 id；status = 'none' 时为 null。 */
  journeyId: string | null;
  direction: JourneyDirection | null;
  directionName: string | null;
  durationSeconds: number | null;
  startedAt: string | null;
  endsAt: string | null;
  /** 出发前岗位名（原岗位名额仍为该弟子保留）。 */
  originalAssignmentName: string | null;
  /** 已到期待领取时给出结果；未到期一律 null（服务端不泄漏结果）。 */
  outcome: JourneyOutcomeView | null;
  canStart: boolean;
  blockedReason: string | null;
}

/** 最近历练摘要条目（仅本宗可见）。 */
export interface JourneyRecordView {
  id: string;
  discipleId: string;
  discipleName: string;
  direction: JourneyDirection;
  directionName: string;
  durationSeconds: number;
  status: 'active' | 'ready' | 'claimed';
  startedAt: string;
  endsAt: string;
  /** 未到期为 null。 */
  outcome: JourneyOutcomeView | null;
}

/** 宗门历练面板：名额 + 最近 10 条摘要。 */
export interface JourneyView {
  /** 尚未到期的在外人数（已到期待领取不占名额）。 */
  activeCount: number;
  maxConcurrent: number;
  minAtHome: number;
  recent: JourneyRecordView[];
}

/** 单档时长的预览（GET /game/journey-preview 的 data；不展示随机结果）。 */
export interface JourneyDurationPreviewView {
  durationSeconds: number;
  durationLabel: string;
  /** 保底修为（已按当前剩余突破门槛截断；最高阶段为 0）。 */
  cultivation: number;
  /** true = 受当前突破门槛限制，展示为「最多」。 */
  cultivationCapped: boolean;
  /** 保底资源（最小单位）。 */
  resources: Record<string, string>;
  /** 额外收获概率（基点）：由**幸运**决定（1500 + (幸运 − 50) × 10；幸运 50 即 15%）。 */
  extraChanceBp: number;
  /** 实际受伤概率（基点，已按出发时战力与体魄调整并 clamp 到方向下限）。 */
  injuryChanceBp: number;
  /** 机遇（保底修为再 +100%）/ 悟道（悟道值 +1）/ 淬炼（随机属性 +1）的概率（基点）。 */
  fortuneChanceBp: number;
  insightChanceBp: number;
  attributeChanceBp: number;
  /** 预计返程时间（服务器时间基准）。 */
  endsAt: string;
}

/** 单个方向的预览。 */
export interface JourneyDirectionPreviewView {
  direction: JourneyDirection;
  name: string;
  description: string;
  /** 本方向当前是否可选；false 时 blockedReason 说明原因。 */
  available: boolean;
  blockedReason: string | null;
  durations: JourneyDurationPreviewView[];
}

/** 历练预览（只读，不结算、不写库；最终资格以 POST /game/start-journey 为准）。 */
export interface JourneyPreviewView {
  discipleId: string;
  discipleName: string;
  canStart: boolean;
  blockedReason: string | null;
  activeCount: number;
  maxConcurrent: number;
  directions: JourneyDirectionPreviewView[];
  serverNow: string;
}

/** 领取回执（POST /game/claim-journey 的 outcome）：本次实际入账的结果。 */
export interface JourneyClaimOutcomeView {
  journeyId: string;
  discipleId: string;
  discipleName: string;
  direction: JourneyDirection;
  directionName: string;
  cultivationAwarded: number;
  resources: Record<string, string>;
  /** 本次入账的资源（最小单位，十进制字符串）。 */
  extraHarvest: boolean;
  injured: boolean;
  injuredUntil: string | null;
  endsAt: string;
  /** 额外奖励的实际结果文案（如「淬炼有成，幸运 +1」）。 */
  bonusTexts: string[];
  message: string;
}

/**
 * 0014 历练预览（GET /game/journey-preview）：只读，不做挂机结算。
 * 资格、奖励、概率与阻止原因全部由服务端算好，前端不复制任何公式。
 */
export async function fetchJourneyPreview(discipleId: string): Promise<JourneyPreviewView> {
  return apiRequest<JourneyPreviewView>(
    `/api/v1/game/journey-preview?discipleId=${encodeURIComponent(discipleId)}`,
  );
}

/** 0014 出发历练：方向与时长由预览给出，服务端重新校验并返回写库后的完整状态。 */
export async function startJourney(
  discipleId: string,
  direction: JourneyDirection,
  durationSeconds: number,
): Promise<SectStateView> {
  const data = await apiRequest<{ state: SectStateView }>('/api/v1/game/start-journey', {
    method: 'POST',
    body: { discipleId, direction, durationSeconds },
  });
  return data.state;
}

/** 0014 领取历练收获：资源一次性入账，返回最新状态与实际结果（重复领取不会重复发奖）。 */
export async function claimJourney(
  journeyId: string,
): Promise<{ state: SectStateView; outcome: JourneyClaimOutcomeView }> {
  return apiRequest<{ state: SectStateView; outcome: JourneyClaimOutcomeView }>(
    '/api/v1/game/claim-journey',
    { method: 'POST', body: { journeyId } },
  );
}

/** 0061 紧急召回回执（POST /game/recall-journey 的 outcome）：召回的历练一无所获。 */
export interface JourneyRecallOutcomeView {
  journeyId: string;
  discipleId: string;
  discipleName: string;
  direction: JourneyDirection;
  directionName: string;
  message: string;
}

/** 0061 紧急召回：在外弟子立刻归队，本趟收获全部作废、不会受伤，免费。 */
export async function recallJourney(
  journeyId: string,
): Promise<{ state: SectStateView; outcome: JourneyRecallOutcomeView }> {
  return apiRequest<{ state: SectStateView; outcome: JourneyRecallOutcomeView }>(
    '/api/v1/game/recall-journey',
    { method: 'POST', body: { journeyId } },
  );
}

/* ---------- V6：交互式秘境探索 ---------- */

/** 一个遭遇选项（与后端 view.ts 的 EncounterChoiceView 一一对应）。 */
export interface EncounterChoiceView {
  id: string;
  label: string;
  riskHint: string;
  risk: 'safe' | 'normal' | 'risky';
}

/** 一次遭遇的展示内容（与后端 view.ts 的 EncounterView 一一对应）。 */
export interface EncounterView {
  name: string;
  description: string;
  choices: EncounterChoiceView[];
}

/** 进行中的交互探索（与后端 view.ts 的 ActiveExplorationView 一一对应）。 */
export interface ActiveExplorationView {
  id: string;
  realmId: string;
  realmName: string;
  totalStages: number;
  /** 已完成的关卡数（0 = 还没走完第一关）。 */
  currentStage: number;
  encounter: EncounterView;
  /** 运行中的奖励账本；真正的资源入账发生在整场结束时。 */
  rewardsCollected: Record<string, string>;
}

/** 判定结果（与后端 service.ts 的 ExploreOutcome 一致）。 */
export type ExploreOutcome = 'great_success' | 'success' | 'failure';

/** 一次选择的判定结果（与后端 view.ts 的 ExploreChoiceResultView 一一对应）。 */
export interface ExploreChoiceResult {
  outcome: ExploreOutcome;
  stageRewards: Record<string, string>;
  injury: { discipleName: string; until: string } | null;
  /** null = 这场探索结束了（通关或失败）。 */
  nextEncounter: EncounterView | null;
  /** 通关时整场入账的总奖励；未通关为 null。 */
  finalRewards: Record<string, string> | null;
  message: string;
}

/** 查询当前进行中的探索（刷新后恢复断点）；没有则 null。 */
export async function fetchActiveExploration(): Promise<ActiveExplorationView | null> {
  const data = await apiRequest<{ exploration: ActiveExplorationView | null }>(
    '/api/v1/game/realm-explore/active',
  );
  return data.exploration;
}

/** 开始交互探索（扣入场费 + 建记录 + 抽第一关遭遇）。 */
export async function startRealmExplore(
  realmId: string,
  discipleIds: string[],
): Promise<{ state: SectStateView; exploration: ActiveExplorationView }> {
  return apiRequest<{ state: SectStateView; exploration: ActiveExplorationView }>(
    '/api/v1/game/realm-explore/start',
    { method: 'POST', body: { realmId, discipleIds } },
  );
}

/** 提交一次选择（服务端判定；Decisions 不可用时自动降级，前端无感）。 */
export async function chooseRealmExplore(
  explorationId: string,
  choiceId: string,
): Promise<{ state: SectStateView; result: ExploreChoiceResult }> {
  return apiRequest<{ state: SectStateView; result: ExploreChoiceResult }>(
    '/api/v1/game/realm-explore/choose',
    { method: 'POST', body: { explorationId, choiceId } },
  );
}

/** 放弃探索（已获奖励照常入账，不退入场费）。 */
export async function abandonRealmExplore(
  explorationId: string,
): Promise<{ state: SectStateView }> {
  return apiRequest<{ state: SectStateView }>('/api/v1/game/realm-explore/abandon', {
    method: 'POST',
    body: { explorationId },
  });
}

/* ---------- 0019 赌坊（论道赌局） ---------- */

/** 六项可赌 / 可加点属性（与后端 gambling.ts 的 BETTABLE_ATTRIBUTES 同口径）。 */
export type DaoAttribute = 'attack' | 'defense' | 'speed' | 'aptitude' | 'luck' | 'physique';

/** 论道赌局入参（与后端 daoDebateRequestSchema 一一对应；多余字段会被服务端 400 拒绝）。 */
export interface DaoDebateInput {
  discipleId: string;
  betMode: 'preset_spirit_stone' | 'free_resource' | 'attribute';
  multiplier: 1 | 2 | 3;
  /** 模式「系统预设灵石」必填：赢灵石还是赢悟道值。 */
  rewardType?: 'resource' | 'insight';
  /** 模式「自由输入资源」必填：可赌资源白名单。 */
  resourceId?: 'spiritStone' | 'herb' | 'ore';
  /** 模式「自由输入资源」必填：赌注的**最小单位整数**（>= 10000）；展示单位 ×1000 后传入。 */
  amount?: number;
  /** 模式「属性赌注」必填：押注的属性。 */
  attribute?: DaoAttribute;
}

/** 论道赌局结果（与后端 view.ts 的 DaoDebateResultView 一一对应）。 */
export interface DaoDebateResult {
  discipleId: string;
  discipleName: string;
  betMode: string;
  multiplier: number;
  result: 'win' | 'lose';
  /** 赌注 / 奖励描述与 message 都由服务端拼好，前端只展示，不自己算数值。 */
  stakeDescription: string;
  rewardDescription: string;
  /** 幸运侦查提示（纯展示，不参与胜负）；幸运不足时为空数组。 */
  revealHints: string[];
  /** 对手六项属性（纯展示）。 */
  opponent: Record<string, number>;
  /**
   * 弟子下注当时的六项属性快照（与 opponent 同一时刻）。结算会改属性，
   * 所以对峙界面要读这里，而不是实时的 state.disciples。
   */
  discipleAttributes: Record<string, number>;
  /** jev 原始胜率（0~1）；null = 本次判定走了本地降级、没用模型。 */
  winProbability: number | null;
  message: string;
}

/** 悟道值加点回执（与后端 view.ts 的 InsightAllocateOutcome 一一对应）。 */
export interface InsightAllocateOutcome {
  discipleId: string;
  discipleName: string;
  attribute: string;
  points: number;
  /** 加点后的该属性值。 */
  newValue: number;
  /** 加点后剩余的可用悟道值。 */
  remainingInsight: number;
  /** 加点后累计已分配点数（上限 DAO_INSIGHT_CAP）。 */
  totalUsed: number;
}

/**
 * 0019 论道赌局（POST /game/dao-debate）：解锁、每日次数、弟子归属、余额与胜负
 * 全部由服务端裁决，返回写库后的完整状态与结果。
 */
export async function daoDebate(
  input: DaoDebateInput,
): Promise<{ state: SectStateView; result: DaoDebateResult }> {
  return apiRequest<{ state: SectStateView; result: DaoDebateResult }>('/api/v1/game/dao-debate', {
    method: 'POST',
    body: input,
  });
}

/** 赌坊详细记录条目（与后端 view.ts 的 DebateHistoryEntryView 一一对应）。 */
export interface DebateHistoryEntry {
  id: string;
  discipleName: string;
  betMode: string;
  multiplier: number;
  result: 'win' | 'lose';
  stakeDetail: string;
  rewardDetail: string;
  winProbability: number | null;
  createdAt: string;
}

/** 赌坊详细记录分页（与后端 view.ts 的 DebateHistoryView 一一对应）。 */
export interface DebateHistoryPage {
  entries: DebateHistoryEntry[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  /** 战绩汇总（只在这里返回；sync 里的 gambling.stats 已不再下发）。 */
  stats: NonNullable<SectStateView['gambling']['stats']>;
}

/** 0019 赌坊详细记录（GET /game/debate-history?page=N）：只读、分页、不结算。 */
export async function fetchDebateHistory(page = 1): Promise<DebateHistoryPage> {
  return apiRequest<DebateHistoryPage>(`/api/v1/game/debate-history?page=${String(page)}`);
}

/** 0019 分配悟道值（POST /game/allocate-dao-insight）：points 1~50，服务端再做归属与上限校验。 */
export async function allocateDaoInsight(
  discipleId: string,
  attribute: DaoAttribute,
  points: number,
): Promise<{ state: SectStateView; outcome: InsightAllocateOutcome }> {
  return apiRequest<{ state: SectStateView; outcome: InsightAllocateOutcome }>(
    '/api/v1/game/allocate-dao-insight',
    { method: 'POST', body: { discipleId, attribute, points } },
  );
}

/* ---------- 0020 天机轮（赌坊第二个玩法） ---------- */

/** 天机轮的单个格子（与后端 view.ts 的 WheelSlotView 一一对应）。 */
export interface WheelSlotView {
  /** 'spirit_stone' | 'big_spirit_stone' | 'herb' | 'ore' | 'pill' | 'nothing'。 */
  type: string;
  /** 格子倍率（0.8~1.5）；谢谢惠顾为 0，丹药格带值但不参与奖励计算。 */
  multiplier: number;
  /** 服务端拼好的格面文案（如「灵石 ×1.3」「谢谢惠顾」）—— 前端只渲染，不自己拼。 */
  label: string;
}

/**
 * 天机轮面板（与后端 view.ts 的 WheelView 一一对应）：赌坊未解锁时为 null。
 * 格局由服务端按 seed 确定性生成，档位费用与重置费用也由服务端下发。
 */
export interface WheelView {
  seed: number;
  slots: WheelSlotView[];
  /** 各档位的转动费用（最小单位；1 展示单位 = 1000 最小单位）。 */
  costs: { tier: number; cost: number }[];
  /** 重置费用（最小单位）。 */
  resetCost: number;
}

/** 天机轮转动入参（与后端 wheelSpinRequestSchema 一一对应）：投入档位 1~5。 */
export interface WheelSpinInput {
  tier: number;
}

/** 天机轮转动结果（与后端 view.ts 的 WheelSpinResultView 一一对应）。 */
export interface WheelSpinResult {
  /** 命中的格子下标（对应 state.gambling.wheel.slots 的顺序）。 */
  slotIndex: number;
  tier: number;
  /** 本次实际扣掉的灵石（最小单位）。 */
  cost: string;
  /** 命中格子的格面文案（结果面板直接渲染）。 */
  slotLabel: string;
  reward: {
    type: 'resource' | 'pill' | 'none';
    /** type = 'resource' 时有值。 */
    resourceId?: string;
    /** type = 'resource' 时有值（最小单位）。 */
    amount?: string;
    /** type = 'pill' 时有值。 */
    pillId?: string;
    pillName?: string;
    quantity?: number;
  };
  /** 服务端拼好的结果文案。 */
  message: string;
}

/**
 * 0020 天机轮转动（POST /game/wheel-spin）：扣费、落格、发奖与每日次数
 * 全部由服务端裁决，返回写库后的完整状态与结果。
 */
export async function wheelSpin(
  input: WheelSpinInput,
): Promise<{ state: SectStateView; result: WheelSpinResult }> {
  return apiRequest<{ state: SectStateView; result: WheelSpinResult }>(
    '/api/v1/game/wheel-spin',
    { method: 'POST', body: input },
  );
}

/** 0020 天机轮重置（POST /game/wheel-reset）：扣重置费、格局整盘重排，不消耗每日次数。 */
export async function wheelReset(): Promise<{ state: SectStateView }> {
  return apiRequest<{ state: SectStateView }>('/api/v1/game/wheel-reset', { method: 'POST' });
}

/* ---------- 0024 灵兽竞逐（赌坊第三个玩法） ---------- */

export interface RaceBeastView {
  index: number;
  name: string;
  weight: number;
  winRate: number;
  pool: string;
  odds: number;
}

export interface RaceMyBetView {
  beastIndex: number;
  beastName: string;
  amount: string;
}

export interface RaceStateView {
  roundKey: string;
  phase: 'betting' | 'sealed' | 'settled' | 'closed';
  remainingSeconds: number;
  beasts: RaceBeastView[];
  totalPool: string;
  myBets: RaceMyBetView[];
  myTotalBet: string;
  winnerIndex: number | null;
  ranks: number[] | null;
  steps: number[][] | null;
  myWinnings: string | null;
  betFeed: RaceBetFeedView[];
}

export interface RaceBetFeedView {
  sectName: string;
  beastIndex: number;
  beastName: string;
  amount: string;
}

export async function fetchRaceState(): Promise<{ state: SectStateView; race: RaceStateView }> {
  return apiRequest<{ state: SectStateView; race: RaceStateView }>(
    '/api/v1/game/race-state',
  );
}

export async function placeRaceBet(
  beastIndex: number,
  betAmount: number,
): Promise<{ state: SectStateView; race: RaceStateView }> {
  return apiRequest<{ state: SectStateView; race: RaceStateView }>(
    '/api/v1/game/race-bet',
    { method: 'POST', body: { beastIndex, betAmount } },
  );
}

export interface RaceBeastStatView {
  index: number;
  name: string;
  wins: number;
  winRate: number;
}

export interface RaceHistoryRoundView {
  roundKey: string;
  winnerIndex: number;
  winnerName: string;
  totalPool: string;
  winnerOdds: number;
  settledAt: number;
}

export interface RaceHistoryView {
  beastStats: RaceBeastStatView[];
  rounds: RaceHistoryRoundView[];
  total: number;
  page: number;
  pageSize: number;
}

export async function fetchRaceHistory(page: number): Promise<RaceHistoryView> {
  return apiRequest<RaceHistoryView>(`/api/v1/game/race-history?page=${String(page)}`);
}

/* ---------- 0046 赌石（赌坊第四个玩法） ---------- */

/** 赌石档位 id（与后端 stoneGamble.ts 的 STONE_TIER_IDS 同口径）。 */
export type StoneTierId = 'gravel' | 'mountain' | 'oldPit' | 'meteor';

/** 赌石支付方式（与后端 STONE_PAY_RESOURCES 同口径）：灵石按价格扣，药材 / 矿石按卖出价折算。 */
export type StonePayResource = 'spiritStone' | 'herb' | 'ore';

/** 赌石结果 id（与后端 STONE_OUTCOME_IDS 同口径）。 */
export type StoneOutcomeId = 'bust' | 'small' | 'big' | 'jackpot';

/** 赌石的一种结果（与后端 view.ts 的 StoneOutcomeView 一一对应）。 */
export interface StoneOutcomeView {
  id: StoneOutcomeId;
  name: string;
  /** 概率（基点，10000 = 100%）。 */
  chanceBp: number;
  /** 开出的玄铁个数（展示单位，固定不是区间）。 */
  xuantie: number;
}

/** 赌石的一个档位（与后端 view.ts 的 StoneTierView 一一对应）。 */
export interface StoneTierView {
  id: StoneTierId;
  name: string;
  /** 价格（灵石，展示单位）；材料价格 = 价格 × materialPerStone。 */
  price: number;
  minSectLevel: number;
  /** 宗门等级够不够本档门槛（前端预检，服务端再判）。 */
  unlocked: boolean;
  /** 不够门槛时的服务端文案（如「天外陨石需要宗门 6 级」）；够则为 null。 */
  blockedReason: string | null;
  /** 单块平均能开出的玄铁（展示单位，两位小数）。 */
  expectedXuantie: number;
  /** 天价（展示单位）。 */
  topPrize: number;
  outcomes: StoneOutcomeView[];
}

/** 赌石面板（与后端 view.ts 的 StoneGambleView 一一对应）：赌坊未解锁时整体为 null。 */
export interface StoneGambleView {
  /** 1 灵石折几个材料（展示单位）。 */
  materialPerStone: number;
  tiers: StoneTierView[];
}

/** 切石回执（与后端 view.ts 的 StoneGambleResultView 一一对应）。 */
export interface StoneGambleResult {
  tier: StoneTierId;
  tierName: string;
  /** 切开的块数：1 或 10。 */
  count: number;
  payResource: StonePayResource;
  /** 花费（最小单位）。 */
  cost: number;
  /** 共得玄铁（最小单位）。 */
  xuantie: number;
  /** 每块的结果（切开的顺序）。 */
  outcomes: StoneOutcomeId[];
  /** 四种结果各几块（之和等于 count）。 */
  counts: Record<StoneOutcomeId, number>;
  /** 服务端拼好的结果文案，原样展示。 */
  message: string;
}

/**
 * 赌石切开（POST /game/stone-gamble）：扣料、抽结果、记保底与记录都在服务端，
 * 返回写库后的完整状态与回执。count 只能是 1（切石）或 10（连切 10 块）。
 */
export async function stoneGamble(
  tier: StoneTierId,
  payResource: StonePayResource,
  count: 1 | 10,
): Promise<{ state: SectStateView; result: StoneGambleResult }> {
  return apiRequest<{ state: SectStateView; result: StoneGambleResult }>('/api/v1/game/stone-gamble', {
    method: 'POST',
    body: { tier, payResource, count },
  });
}

/* ---------- 坊市（材料买卖与丹药回收） ---------- */

/** 可交易材料（与后端 shop.ts 的 SHOP_TRADABLE_RESOURCES 同口径）：灵石与灵气都不可买卖。 */
export type ShopResourceId = 'herb' | 'ore';

/** 买入回执（与后端 shop.ts 的 ShopBuyResult 一一对应）。 */
export interface ShopBuyResult {
  action: 'buy';
  resourceId: string;
  resourceName: string;
  /** 买入的**展示单位**数量（= 服务端入账的最小单位 ÷ 1000）。 */
  amount: number;
  /** 花费灵石（最小单位）。 */
  cost: number;
  /** 服务端拼好的文案。 */
  message: string;
}

/** 卖出材料回执（与后端 shop.ts 的 ShopSellResult 一一对应）。 */
export interface ShopSellResult {
  action: 'sell';
  resourceId: string;
  resourceName: string;
  /** 卖出的**展示单位**数量。 */
  amount: number;
  /** 获得灵石（最小单位）。 */
  revenue: number;
  message: string;
}

/** 售丹回执（与后端 shop.ts 的 ShopSellPillResult 一一对应）。 */
export interface ShopSellPillResult {
  action: 'sell-pill';
  pillId: string;
  pillName: string;
  /** 卖出的颗数。 */
  quantity: number;
  /** 获得灵石（最小单位）。 */
  revenue: number;
  message: string;
}

/**
 * 坊市买入材料（POST /game/shop-buy）：amount 是**展示单位整数**（≥ 1）。
 * 余额、可交易白名单与材料容量上限全部由服务端裁决，返回写库后的完整状态与回执。
 */
export async function shopBuy(
  resourceId: ShopResourceId,
  amount: number,
): Promise<{ state: SectStateView; result: ShopBuyResult }> {
  return apiRequest<{ state: SectStateView; result: ShopBuyResult }>('/api/v1/game/shop-buy', {
    method: 'POST',
    body: { resourceId, amount },
  });
}

/** 坊市卖出材料（POST /game/shop-sell）：amount 是**展示单位整数**（≥ 1），库存由服务端校验。 */
export async function shopSell(
  resourceId: ShopResourceId,
  amount: number,
): Promise<{ state: SectStateView; result: ShopSellResult }> {
  return apiRequest<{ state: SectStateView; result: ShopSellResult }>('/api/v1/game/shop-sell', {
    method: 'POST',
    body: { resourceId, amount },
  });
}

/** 坊市卖出丹药（POST /game/shop-sell-pill）：quantity 是颗数（≥ 1），库存由服务端校验。 */
export async function shopSellPill(
  pillId: string,
  quantity: number,
): Promise<{ state: SectStateView; result: ShopSellPillResult }> {
  return apiRequest<{ state: SectStateView; result: ShopSellPillResult }>(
    '/api/v1/game/shop-sell-pill',
    { method: 'POST', body: { pillId, quantity } },
  );
}

/** 兑换方向（与后端 shop.ts 的 SHOP_EXCHANGE_DIRECTIONS 同口径）：toXuantie = 神木 → 玄铁，toShenmu = 玄铁 → 神木。 */
export type ShopExchangeDirection = 'toXuantie' | 'toShenmu';

/** 神木 ⇄ 玄铁回执（与后端 view.ts 的 ShopExchangeResultView 一一对应）。 */
export interface ShopExchangeResult {
  action: 'exchange';
  direction: ShopExchangeDirection;
  /** 这一笔的玄铁数量（展示单位，两个方向都按玄铁计）。 */
  amount: number;
  /** 付出的资源（最小单位）。 */
  cost: number;
  /** 换得的资源（最小单位）。 */
  gained: number;
  message: string;
}

/** 坊市神木 ⇄ 玄铁（POST /game/shop-exchange）：amount 两个方向都是玄铁数量（展示单位整数，≥ 1）。 */
export async function shopExchange(
  direction: ShopExchangeDirection,
  amount: number,
): Promise<{ state: SectStateView; result: ShopExchangeResult }> {
  return apiRequest<{ state: SectStateView; result: ShopExchangeResult }>('/api/v1/game/shop-exchange', {
    method: 'POST',
    body: { direction, amount },
  });
}

/* ---------- 0025/0027 世界 Boss（讨伐，二期） ---------- */

export interface WorldBossDefView {
  index: number;
  name: string;
  /** 带关卡的显示名（如「第 2 关 · 赤炎火蛟」）。 */
  displayName: string;
  sealCharacter: string;
  color: string;
  description: string;
}

/** 词缀推荐排序属性（与 DisciplePicker 的 extraSort 同一个联合类型）。 */
export type WorldBossSortAttribute = 'attack' | 'defense' | 'speed' | 'luck' | 'physique';

/** 本关随机词缀。 */
export interface WorldBossAffixView {
  id: string;
  name: string;
  /** 效果文案（一行，保持简短）。 */
  effect: string;
  /** 配队提示。 */
  tip: string;
  /** 推荐排序属性（追加到选人组件的排序按钮里）。 */
  sortAttribute: WorldBossSortAttribute;
}

export interface WorldBossRankView {
  sectId: string;
  sectName: string;
  damage: number;
  attempts: number;
  isTopDamage: boolean;
  isLastHit: boolean;
  isMe: boolean;
}

export interface WorldBossHitView {
  sectId: string;
  sectName: string;
  discipleNames: string[];
  /** 本次受伤（普通受伤，30 分钟）的弟子名。 */
  injuredNames: string[];
  /** 本次被打成重伤（静养 1 天）的弟子名。 */
  severeNames: string[];
  damage: number;
  isCrit: boolean;
  isLastHit: boolean;
  createdAt: number;
}

/** 未出现 / 讨伐中 / 力竭中 / 已结束（UTC+8 时间段）。 */
export type WorldBossPhase = 'before' | 'open' | 'frenzy' | 'closed';

export interface WorldBossCurrentView {
  elementName?: string;
  id: string;
  dayKey: string;
  /** 第几关（每天从 1 开始，连战递增）。 */
  stage: number;
  def: WorldBossDefView;
  affix: WorldBossAffixView;
  maxHp: number;
  hp: number;
  status: 'active' | 'killed' | 'fled';
  phase: WorldBossPhase;
  killerSectName: string | null;
  fledOutcome: 'repelled' | 'escaped' | null;
  endedAt: number | null;
}

/** 一次出手里某名弟子的判定结果。 */
export interface WorldBossMemberOutcomeView {
  discipleId: string;
  discipleName: string;
  outcome: 'normal' | 'injured' | 'severe';
}

export interface WorldBossView {
  boss: WorldBossCurrentView | null;
  phase: WorldBossPhase;
  /** 今天的出现时间（毫秒），未出现时用于「08:00 降临」提示。 */
  opensAt: number;
  remainingSeconds: number;
  /** 今日已连斩 N 只。 */
  killedToday: number;
  /** 史上最高「一天连斩 M 只」。 */
  bestStage: number;
  /** 出手冷却剩余秒数（0 = 可以出手）。 */
  cooldownSeconds: number;
  /** 本宗门弟子疲劳表：弟子 id → 最近 60 分钟的出战次数。 */
  fatigue: Record<string, number>;
  /** 最近 60 分钟内每次出战讨伐的时间（毫秒，升序），用于「冒进冷却」倒计时。 */
  fatigueTimes: Record<string, number[]>;
  /** 此刻能否出手：Boss 在讨伐中 + 开放时段。 */
  attackable: boolean;
  /** 本宗门今天已出手次数。 */
  attacksToday: number;
  /** 是否已打开服务端自动讨伐。 */
  autoEnabled: boolean;
  /** 自动讨伐最近一次暂停原因；正常运行或尚未暂停时为 null。 */
  autoPauseReason: string | null;
  /** 自动讨伐最近一次调度时间。 */
  autoLastRunAt: number | null;
  ranks: WorldBossRankView[];
  hits: WorldBossHitView[];
  topHit: WorldBossHitView | null;
  /**
   * 奖励预览：当前关卡、按本宗门此刻产出算的各名次奖励；rank 4 = 第 4 名及以后；资源为最小单位。
   * dropDescription 是 0028 的装备掉落说明（服务端拼好，前端直接渲染）。
   */
  rewardPreview: {
    stage: number;
    tiers: { rank: number; multiplier: number; resources: Record<string, number>; topDamagePill: boolean }[];
    lastHitStone: number;
    /** 击杀时每种丹药的颗数（第 4 关起 2 颗）。 */
    pillCount: number;
    dropDescription: string;
    /** 三期：本关伤害占比 100% 时的功勋（展示单位）；实际按 √占比 折算，保底 2。 */
    meritFullShare: number;
    /** 本关击杀的玄铁：伤害占比 ≥ minSharePercent% 才有，第 1 名拿 top；below = 不足门槛时的数量。 */
    xuantie: { top: number; others: number; below: number; minSharePercent: number };
    /** 深关神木（展示单位）：第 6 关起 = 本关玄铁的一半（向上取整），之前全是 0。 */
    shenmu: { top: number; others: number; below: number };
  } | null;
  /**
   * 三期：本宗门在当前关的掉落概率（boss 为 null 时为 null）。
   * 伤害占比与概率都由服务端算好（高档 = 75% × √占比，仙品档 25% × √占比），前端只渲染，不复制公式。
   */
  myDrop: {
    /** 本宗门对本关的伤害占比（0~1；还没出手为 0）。 */
    damageShare: number;
    /** 击杀时掉高档装备的概率（0~1）。 */
    highChance: number;
    /** 高档品质名（第 1～2 关灵品、第 3～4 关宝品、第 5 关起仙品）。 */
    highQualityName: string;
    /** 低档品质名。 */
    lowQualityName: string;
  } | null;
}

export interface WorldBossAttackResultView {
  damage: number;
  actualDamage: number;
  crit: boolean;
  frenzy: boolean;
  lastHit: boolean;
  bossHp: number;
  bossMaxHp: number;
  /** 击杀后立刻开出的下一关关卡号；没击杀为 null。 */
  nextStage: number | null;
  /** 本次每名弟子的判定结果（正常 / 受伤 / 重伤）。 */
  members: WorldBossMemberOutcomeView[];
  /** 功法加成（整数百分比；没有功法为 0）。 */
  techniqueBonusPercent: number;
  beastSummary?: string[];
}

export async function fetchWorldBoss(): Promise<{ state: SectStateView; boss: WorldBossView }> {
  return apiRequest<{ state: SectStateView; boss: WorldBossView }>('/api/v1/game/world-boss');
}

export async function attackWorldBoss(discipleIds: string[]): Promise<{
  state: SectStateView;
  result: WorldBossAttackResultView;
  boss: WorldBossView;
}> {
  return apiRequest<{
    state: SectStateView;
    result: WorldBossAttackResultView;
    boss: WorldBossView;
  }>('/api/v1/game/world-boss/attack', { method: 'POST', body: { discipleIds } });
}

export async function setWorldBossAuto(enabled: boolean): Promise<{
  state: SectStateView;
  boss: WorldBossView;
}> {
  return apiRequest<{ state: SectStateView; boss: WorldBossView }>('/api/v1/game/world-boss/auto', {
    method: 'POST',
    body: { enabled },
  });
}

/**
 * 三期功勋兑换入参（与后端 worldBossExchangeRequestSchema 一一对应；多余字段会被服务端 400 拒绝）。
 * 部位 / 主属性的组合合法性（法器必须选身法 / 幸运等）由服务端校验。
 */
/** 功勋兑换（GET /game/merit-shop）：分类（标签页）、价目、可选部位都由服务端给。 */
export interface MeritShopView {
  categories: { id: string; name: string }[];
  items: {
    id: string;
    name: string;
    /** 价格（功勋，展示单位）。 */
    cost: number;
    category: string;
    /** 装备类的品质与品质色；资源类为 null。 */
    quality: string | null;
    /** 资源类（玄铁 / 神木）兑换得到的资源 id；其它类为 null。 */
    resourceId: string | null;
    /** 丹药类（洗髓丹）兑换得到的丹药 id；其它类为 null。 */
    pillId: string | null;
    /** 0066 功法类：兑换得到哪门功法的残卷；其它类为 null。 */
    techniqueId: string | null;
    color: string | null;
  }[];
  slots: EquipmentSlotView[];
  /** 资源类一次最多兑换几个。 */
  maxResourceQuantity: number;
}

export async function fetchMeritShop(): Promise<MeritShopView> {
  const data = await apiRequest<{ shop: MeritShopView }>('/api/v1/game/merit-shop');
  return data.shop;
}

export interface BossMeritExchangeInput {
  /** xuantie（玄铁）| spirit（灵品）| treasure（宝品）| immortal（仙品）。 */
  itemId: string;
  /** 换玄铁时的个数（1~100）；换装备只能缺省或 1。 */
  quantity?: number;
  /** 换装备时的部位（weapon / armor / artifact）；换玄铁不许带。 */
  slot?: string;
  /** 法器必须带（speed / luck）；其它部位不许带。 */
  mainAttr?: string;
}

/** 功勋兑换回执（POST /game/world-boss/exchange 的 outcome，与后端 service.ts 的 BossMeritExchangeOutcome 一一对应）。 */
export interface BossMeritExchangeOutcome {
  itemId: string;
  /** 花掉的功勋（最小单位）。 */
  cost: number;
  /** 兑换到的玄铁（最小单位）；兑换装备时为 0。 */
  xuantie: number;
  /** 兑换到的资源（玄铁 / 神木，amount 为最小单位）；不是资源时为 null。 */
  resource: { resourceId: string; name: string; amount: number } | null;
  /** 兑换到的丹药；不是丹药时为 null。 */
  pill: { pillId: string; name: string; quantity: number } | null;
  /** 兑换到的装备；兑换玄铁时为 null。 */
  equipment: { id: string; name: string; quality: string; slot: string; slotName: string } | null;
  /** 0066 兑换到的功法残卷（张）；不是残卷时为 null。 */
  scroll: { techniqueId: string; name: string; quantity: number } | null;
}

/**
 * 三期功勋兑换（POST /game/world-boss/exchange）：价格、余额、背包与部位都最终由服务端裁决，
 * 必定成功、不需要炼器坊；成功返回写库后的完整状态与兑换回执。
 */
export async function exchangeBossMerit(
  input: BossMeritExchangeInput,
): Promise<{ state: SectStateView; outcome: BossMeritExchangeOutcome }> {
  return apiRequest<{ state: SectStateView; outcome: BossMeritExchangeOutcome }>(
    '/api/v1/game/world-boss/exchange',
    { method: 'POST', body: input },
  );
}

/* ---------- 0028 装备（炼器 / 背包 / 穿戴 / 分解） ---------- */

/** 装备部位（与后端 equipment.ts 的 EQUIPMENT_SLOTS 同口径）。 */
export type EquipmentSlotId = 'weapon' | 'armor' | 'artifact';

/** 法器可选的主属性（只有法器需要玩家选，其余部位由服务端按规则固定）。 */
export type EquipmentMainAttr = 'speed' | 'luck';

/**
 * 单件装备视图（背包卡片与弟子装备格共用）。
 * 品质名 / 颜色、部位名与属性名都由服务端下发，前端只渲染，不复制一份规则表。
 */
export interface EquipmentItemView {
  id: string;
  /** weapon | armor | artifact。 */
  slot: EquipmentSlotId;
  slotName: string;
  /** common | spirit | treasure | immortal。 */
  quality: string;
  qualityName: string;
  /** 品质色（卡片边框用），如 `#fbbf24`。 */
  color: string;
  /** `{品质名}·{部位名}`，如「仙品·紫金葫芦」。 */
  name: string;
  mainAttr: string;
  mainAttrName: string;
  mainValue: number;
  subAttr: string;
  subAttrName: string;
  subValue: number;
  source: 'forge' | 'boss' | 'tower' | 'merchant';
  /** 0032 穿在身上时给弟子的战力加成（基点，按品质；0044 起再加祭炼重数的部分）。 */
  powerBonusBp: number;
  /** 0044 祭炼重数 0~12。 */
  refineLevel: number;
  /** 0044 祭炼预览（全部由服务端算好；next = null 表示已到十二重）。 */
  refine: {
    maxLevel: number;
    next: {
      level: number;
      /** 基础成功率（基点）。**不含**隐藏补偿，也不要加任何「补偿」字段。 */
      successBp: number;
      /** 本次消耗（最小单位字符串），只含 > 0 的资源。 */
      cost: Record<string, string>;
      mainGain: number;
      subGain: number;
      /** 成功后这件装备的战力加成增加多少（基点）：refinePowerBonusBp(next) - refinePowerBonusBp(当前)。 */
      powerBonusGainBp: number;
    } | null;
  };
  /**
   * 洗练预览（全部由服务端算好；品质不认识时为 null）：副属性拆成基础 + 祭炼，
   * 洗练只重洗基础部分（subMin~subMax），祭炼部分原样保留。
   */
  reroll: {
    subBase: number;
    subRefine: number;
    subMin: number;
    subMax: number;
    /** 两种模式各自的单次消耗（最小单位字符串）。 */
    cost: Record<RerollMode, Record<string, string>>;
  } | null;
  /** 穿在谁身上；null = 在背包里（背包 = 本宗未穿戴的装备）。 */
  discipleId: string | null;
  discipleName: string | null;
  createdAt: string;
}

/** 一个可炼部位；法器的 mainAttrChoices 非空（玩家必须选身法或幸运）。 */
export interface EquipmentSlotView {
  id: EquipmentSlotId;
  name: string;
  mainAttrChoices: { id: string; name: string }[];
}

/**
 * 装备面板视图（GET /game/equipment）。
 * 解锁判断、背包计数、炼器价格、可选部位与主属性候选、分解返还都由服务端算好。
 */
export interface EquipmentView {
  unlocked: boolean;
  blockedReason: string | null;
  /** 背包已用件数（穿在身上的不占背包）。 */
  bagCount: number;
  bagCapacity: number;
  /** 单次炼器消耗（最小单位）。 */
  forgeCost: Record<string, string>;
  /** 一期只能炼的品质（凡品）。 */
  forgeQuality: string;
  forgeQualityName: string;
  /** 装备二期：炼器坊等级（决定可炼的最高品质）。 */
  workshopLevel: number;
  /** 仙品保底：当前层数（每层下次仙品成功率 +10%，出仙品清零）与上限。 */
  forgePity: number;
  forgePityMax: number;
  /** 天赋重构：炼器执事的成功率加成文案；没有执事为 null（概率里已经算上）。 */
  stewardBonusText: string | null;
  /** 装备二期：各品质炼造选项（消耗为最小单位；unlocked = 炼器坊等级已够）。 */
  forgeOptions: {
    quality: string;
    name: string;
    color: string;
    workshopLevel: number;
    unlocked: boolean;
    cost: Record<string, string>;
    /** 成功 / 降级 / 失败概率（0~1）。 */
    odds: { success: number; downgrade: number; fail: number };
  }[];
  slots: EquipmentSlotView[];
  /** 品质 id → 分解返还的矿石（**展示单位**，直接显示数字即可）。 */
  salvageOre: Record<string, number>;
  /** 本宗全部装备（背包 + 已穿戴），新的在前。 */
  items: EquipmentItemView[];
  /** 0044 祭炼说明（「说明」弹窗用）：每个品质冲 1～12 重的基础成功率、消耗与加成。 */
  refineGuide: RefineGuideView;
}

/** 祭炼说明表：成功率只给基础值；消耗是最小单位字符串，只含 > 0 的资源。 */
export interface RefineGuideView {
  maxLevel: number;
  qualities: {
    id: string;
    name: string;
    color: string;
    /** 主属性固定值（未祭炼）；升境界模拟用它算自定义装备。 */
    mainValue: number;
    /** 副属性数值区间（整数，含两端）。 */
    subMin: number;
    subMax: number;
    /** 品质战力加成（基点，未祭炼）；加上祭炼累计的 powerBonusGainBp 即当前加成。 */
    powerBonusBp: number;
    rows: {
      level: number;
      successBp: number;
      cost: Record<string, string>;
      mainGain: number;
      subGain: number;
      powerBonusGainBp: number;
    }[];
  }[];
}

/** 炼器回执（POST /game/forge-equipment 的 outcome）。 */
export interface ForgeEquipmentOutcome {
  /** success = 所选品质；downgrade = 低一档；fail = 没出装备（refund 为返还的灵石 / 矿石）。 */
  result: 'success' | 'downgrade' | 'fail';
  equipmentId: string | null;
  name: string | null;
  slot: string;
  slotName: string;
  quality: string | null;
  refund: Record<string, number>;
  cost: Record<string, string>;
  /** 炼完后的仙品保底层数（只有炼仙品会变）。 */
  forgePity: number;
}

/** 穿戴 / 卸下回执（POST /game/equip、/game/unequip 的 outcome）。 */
export interface EquipChangeOutcome {
  equipmentId: string;
  name: string;
  slot: EquipmentSlotId;
  slotName: string;
  /** 现在穿在谁身上；卸下后为 null（已回背包）。 */
  discipleId: string | null;
  discipleName: string | null;
  /** 换装时被顶替回背包的那件装备名；没有为 null。 */
  replacedName: string | null;
}

/** 分解回执（POST /game/salvage-equipment 的 outcome）。 */
export interface SalvageEquipmentOutcome {
  /** 实际分解的件数（已去重）。 */
  count: number;
  /** 返还的矿石（**最小单位**，用 formatAmount 显示）。 */
  ore: number;
  /** 装备二期：返还的玄铁（最小单位）。 */
  xuantie: number;
}

/** 祭炼回执（POST /game/refine-equipment 的 outcome）。 */
export interface RefineEquipmentOutcome {
  equipmentId: string;
  name: string;
  success: boolean;
  /** 祭炼前 / 后的重数（失败时两者相等）。 */
  fromLevel: number;
  toLevel: number;
  /** 本次实际扣掉的材料（最小单位字符串）。 */
  cost: Record<string, string>;
}

/** 洗练模式：attr = 种类与数值一起洗，value = 锁定种类只洗数值。两种都直接覆盖。 */
export type RerollMode = 'attr' | 'value';

/** 洗练回执（POST /game/reroll-equipment 的 outcome）；数值都含祭炼加成。 */
export interface RerollEquipmentOutcome {
  equipmentId: string;
  name: string;
  mode: RerollMode;
  from: { subAttr: string; subAttrName: string; subValue: number };
  to: { subAttr: string; subAttrName: string; subValue: number };
  /** 本次实际扣掉的材料（最小单位字符串）。 */
  cost: Record<string, string>;
}

/** 0028 读取装备面板（GET /game/equipment）：只读，不结算；装备明细不放进 /game/sync。 */
export async function fetchEquipment(): Promise<{
  state: SectStateView;
  equipment: EquipmentView;
}> {
  return apiRequest<{ state: SectStateView; equipment: EquipmentView }>('/api/v1/game/equipment');
}

/** 0028 炼器（POST /game/forge-equipment）：法器必须给 mainAttr（speed / luck），其他部位不能给。 */
export async function forgeEquipment(
  slot: EquipmentSlotId,
  mainAttr?: EquipmentMainAttr,
  quality?: string,
): Promise<{ state: SectStateView; outcome: ForgeEquipmentOutcome }> {
  return apiRequest<{ state: SectStateView; outcome: ForgeEquipmentOutcome }>(
    '/api/v1/game/forge-equipment',
    {
      method: 'POST',
      body: {
        slot,
        ...(mainAttr === undefined ? {} : { mainAttr }),
        ...(quality === undefined ? {} : { quality }),
      },
    },
  );
}

/** 0028 穿戴（POST /game/equip）：目标弟子与装备归属、在外 / 重伤都由服务端校验。 */
export async function equipItem(
  equipmentId: string,
  discipleId: string,
): Promise<{ state: SectStateView; outcome: EquipChangeOutcome }> {
  return apiRequest<{ state: SectStateView; outcome: EquipChangeOutcome }>('/api/v1/game/equip', {
    method: 'POST',
    body: { equipmentId, discipleId },
  });
}

/** 0028 卸下（POST /game/unequip）：装备回背包；背包满时服务端会拒绝。 */
export async function unequipItem(
  equipmentId: string,
): Promise<{ state: SectStateView; outcome: EquipChangeOutcome }> {
  return apiRequest<{ state: SectStateView; outcome: EquipChangeOutcome }>(
    '/api/v1/game/unequip',
    { method: 'POST', body: { equipmentId } },
  );
}

/** 0028 分解（POST /game/salvage-equipment）：1~50 件（重复 id 由服务端去重），只能分解背包里的。 */
export async function salvageEquipment(
  equipmentIds: string[],
): Promise<{ state: SectStateView; outcome: SalvageEquipmentOutcome }> {
  return apiRequest<{ state: SectStateView; outcome: SalvageEquipmentOutcome }>(
    '/api/v1/game/salvage-equipment',
    { method: 'POST', body: { equipmentIds } },
  );
}

/** 0044 祭炼（POST /game/refine-equipment）：一次冲 1 重；成败、扣料都以服务端为准。 */
export async function refineEquipment(
  equipmentId: string,
): Promise<{ state: SectStateView; outcome: RefineEquipmentOutcome }> {
  return apiRequest<{ state: SectStateView; outcome: RefineEquipmentOutcome }>(
    '/api/v1/game/refine-equipment',
    { method: 'POST', body: { equipmentId } },
  );
}

/** 洗练（POST /game/reroll-equipment）：重洗副属性的基础部分，结果以服务端为准、直接覆盖。 */
export async function rerollEquipment(
  equipmentId: string,
  mode: RerollMode,
): Promise<{ state: SectStateView; outcome: RerollEquipmentOutcome }> {
  return apiRequest<{ state: SectStateView; outcome: RerollEquipmentOutcome }>(
    '/api/v1/game/reroll-equipment',
    { method: 'POST', body: { equipmentId, mode } },
  );
}

/* ---------- 0039 镇妖塔 ---------- */

export interface TowerAffixView {
  id: string;
  name: string;
  effect: string;
  tip: string;
  /** 前端「推荐排序属性」。 */
  sortAttribute: 'attack' | 'defense' | 'speed' | 'luck' | 'physique';
}

/** 守关妖物（血量 / 攻击已 × 100，与战报同一口径；身法、标准属性、标准战力是原值）。 */
export interface TowerMonsterView {
  elementName?: string;
  floor: number;
  name: string;
  isBoss: boolean;
  affix: TowerAffixView | null;
  hp: number;
  attack: number;
  speed: number;
  standardAttr: number;
  standardPower: number;
}

/** 镇妖塔面板。资源数量一律是最小单位。 */
export interface TowerView {
  unlocked: boolean;
  unlockSectLevel: number;
  partySize: number;
  maxRounds: number;
  maxFloor: number;
  nextFloor: number;
  monster: TowerMonsterView;
  clearReward: Record<string, number>;
  /** 下一层首通送的装备品质（每 30 层一件）；背包满时不能挑战这一层。 */
  clearEquipment: { quality: string; qualityName: string } | null;
  bagCount: number;
  bagCapacity: number;
  upcoming: {
    floor: number;
    name: string;
    isBoss: boolean;
    affixName: string | null;
    standardPower: number;
    equipmentQualityName: string | null;
  }[];
  dailyFails: number;
  failsUsed: number;
  failsLeft: number;
  sweptToday: boolean;
  sweepReward: Record<string, number>;
  rareFloor: number;
  affixes: TowerAffixView[];
  ranks: { rank: number; sectId: string; sectName: string; maxFloor: number; isMe: boolean }[];
  myRank: number | null;
}

export interface TowerHitView {
  discipleId: string;
  name: string;
  damage: number;
  crit: boolean;
  extra: boolean;
  /** 本次出手触发的功法标签（如 ['剑气']）。 */
  tags?: string[];
}

export interface TowerRoundView {
  round: number;
  teamFirst: boolean;
  poisonDamage: number;
  hits: TowerHitView[];
  monsterDamage: number;
  monsterHp: number;
  teamHp: number;
  /** 血身：本回合结束的回血记录。 */
  heals?: { discipleId: string; name: string; amount: number }[];
}

export interface TowerChallengeResultView {
  floor: number;
  monsterName: string;
  isBoss: boolean;
  affix: TowerAffixView | null;
  won: boolean;
  failReason: 'wiped' | 'timeout' | null;
  rounds: TowerRoundView[];
  monsterMaxHp: number;
  teamMaxHp: number;
  vigor: number;
  teamFirst: boolean;
  reward: Record<string, number>;
  equipment: { id: string; name: string; quality: string; qualityName: string; slot: string; slotName: string } | null;
  members: { discipleId: string; name: string; power: number }[];
  message: string;
  /** 功法结算摘要：每名触发过标志效果的弟子一条。 */
  techniqueSummary: TechniqueSummaryView[];
}

export interface TowerSweepResultView {
  maxFloor: number;
  reward: Record<string, number>;
  message: string;
}

export async function fetchTower(): Promise<{ state: SectStateView; tower: TowerView }> {
  return apiRequest<{ state: SectStateView; tower: TowerView }>('/api/v1/game/tower');
}

export async function challengeTower(discipleIds: string[]): Promise<{
  state: SectStateView;
  tower: TowerView;
  result: TowerChallengeResultView;
}> {
  return apiRequest<{ state: SectStateView; tower: TowerView; result: TowerChallengeResultView }>(
    '/api/v1/game/tower/challenge',
    { method: 'POST', body: { discipleIds } },
  );
}

export async function sweepTower(): Promise<{ state: SectStateView; tower: TowerView; result: TowerSweepResultView }> {
  return apiRequest<{ state: SectStateView; tower: TowerView; result: TowerSweepResultView }>(
    '/api/v1/game/tower/sweep',
    { method: 'POST' },
  );
}

/* ---------- 0066 功法（藏经阁 / 主修 / 镇妖塔胜率预估） ---------- */

/** 结算摘要的一行（镇妖塔）：bonusDamage 只统计标志效果额外带来的伤害（不含代价）。 */
export interface TechniqueSummaryView {
  discipleId: string;
  name: string;
  techniqueId: string;
  techniqueName: string;
  triggers: number;
  bonusDamage: number;
  healed: number;
  hpBonus: number;
}

/** 藏经阁里的一门功法。残卷与灵石为最小单位。 */
export interface TechniqueCatalogView {
  id: string;
  name: string;
  school: string;
  schoolName: string;
  tier: string;
  tierName: string;
  tag: string;
  /** 一句话简介。 */
  summary: string;
  towerGain: string;
  cost: string;
  bossGain: string;
  learned: boolean;
  level: number;
  scrolls: number;
  learnScrolls: number;
  learnRemaining: number;
  upgradeScrolls: number | null;
  upgradeStone: number | null;
  scrollName: string;
  levelFactor: number;
  disciplesUsing: number;
}

/** 功法商店的一个品阶（玄 / 地）今日状态。灵石为最小单位。 */
export interface TechniqueShopTierView {
  tier: 'xuan' | 'di';
  tierName: string;
  price: number;
  quota: number;
  bought: number;
  remaining: number;
  /** 藏经阁几级起开放该品阶（额度为 0 时显示「藏经阁 N 级开放」）。 */
  openLevel: number;
}

/** 功法商店（藏经阁「商店」标签页）。 */
export interface TechniqueShopView {
  unlocked: boolean;
  scriptureLevel: number;
  /** 今天（UTC+8）。 */
  dateKey: string;
  tiers: TechniqueShopTierView[];
  /** 下一级藏经阁的额度提示；已满级为 null。 */
  nextLevelHint: string | null;
}

export interface TechniqueLibraryView {
  unlocked: boolean;
  scriptureLevel: number;
  maxLevel: number;
  schools: { id: string; name: string }[];
  items: TechniqueCatalogView[];
  shop: TechniqueShopView;
}

/** 镇妖塔胜率预估：胜率为 0~100 的整数。 */
export interface TowerPreviewView {
  floor: number;
  samples: number;
  winRate: number;
  avgRounds: number;
}

export async function fetchTechniques(): Promise<{ library: TechniqueLibraryView }> {
  return apiRequest<{ library: TechniqueLibraryView }>('/api/v1/game/techniques');
}

export async function learnTechnique(techniqueId: string): Promise<{
  state: SectStateView;
  library: TechniqueLibraryView;
  result: { message: string };
}> {
  return apiRequest<{ state: SectStateView; library: TechniqueLibraryView; result: { message: string } }>(
    '/api/v1/game/techniques/learn',
    { method: 'POST', body: { techniqueId } },
  );
}

export async function upgradeTechnique(techniqueId: string): Promise<{
  state: SectStateView;
  library: TechniqueLibraryView;
  result: { message: string };
}> {
  return apiRequest<{ state: SectStateView; library: TechniqueLibraryView; result: { message: string } }>(
    '/api/v1/game/techniques/upgrade',
    { method: 'POST', body: { techniqueId } },
  );
}

/** 功法商店购买残卷（只限玄 / 地阶；扣灵石，计入当天该品阶额度）。 */
export async function buyTechniqueScrolls(
  techniqueId: string,
  quantity: number,
): Promise<{ state: SectStateView; library: TechniqueLibraryView; result: { message: string } }> {
  return apiRequest<{ state: SectStateView; library: TechniqueLibraryView; result: { message: string } }>(
    '/api/v1/game/techniques/shop/buy',
    { method: 'POST', body: { techniqueId, quantity } },
  );
}

/** 设置 / 更换 / 卸下主修（techniqueId 为 null 即卸下）。 */
export async function setDiscipleTechnique(discipleId: string, techniqueId: string | null): Promise<SectStateView> {
  const data = await apiRequest<{ state: SectStateView }>('/api/v1/game/disciples/technique', {
    method: 'POST',
    body: { discipleId, techniqueId },
  });
  return data.state;
}

/** 镇妖塔胜率预估（服务端模拟 50 场，不扣次数、不写库）。 */
export async function previewTower(discipleIds: string[]): Promise<TowerPreviewView> {
  const data = await apiRequest<{ preview: TowerPreviewView }>('/api/v1/game/tower/preview', {
    method: 'POST',
    body: { discipleIds },
  });
  return data.preview;
}

/* ---------- 0053 宗门大比（斗法台 / 宗门战；每日 12:00 结算，周日收官） ---------- */

/** 名册上的一名弟子（战力计入装备）。 */
export interface ArenaFighterView {
  id: string;
  name: string;
  realmName: string;
  stageName: string;
  combatPower: number;
}

export interface ArenaDuelHitView {
  fighterId: string;
  name: string;
  damage: number;
  crit: boolean;
  extra: boolean;
  /** 0066 功法标志效果标签（如 ['剑气']）。 */
  tags?: string[];
}

export interface ArenaDuelRoundView {
  round: number;
  firstId: string;
  hits: ArenaDuelHitView[];
  /** 回合结束时的剩余血量（与 fighterAMaxHp 同一口径）。 */
  fighterAHp: number;
  fighterBHp: number;
  /** 0066 功法（血身）：回合结束时的回血。 */
  heals?: { fighterId: string; name: string; amount: number }[];
}

/** 一场 1v1 的详情（团队赛车轮战每场都有）。 */
export interface ArenaDuelView {
  fighterA: { id: string; name: string; power: number; hpPct: number };
  fighterB: { id: string; name: string; power: number; hpPct: number };
  winnerId: string | null;
  fighterAMaxHp: number;
  fighterBMaxHp: number;
  rounds: ArenaDuelRoundView[];
}

export interface ArenaIndividualMatchView {
  id: string;
  /** 所在层（同一层里每名弟子最多一场）。 */
  round: number;
  fighterA: { id: string; name: string; sectName: string; power: number; hpPct: number };
  fighterB: { id: string; name: string; sectName: string; power: number; hpPct: number };
  winnerId: string | null;
}

export interface ArenaTeamMatchView {
  id: string;
  round: number;
  sectA: { id: string; name: string; kills: number };
  sectB: { id: string; name: string; kills: number };
  winnerSectId: string;
  duels: ArenaDuelView[];
}

/** 一个宗门的参赛名单。auto = true 时是系统择优选出（掌门未点将）。 */
export interface ArenaEntryView {
  sectId: string;
  sectName: string;
  sectLevel: number;
  auto: boolean;
  disciples: ArenaFighterView[];
}

export interface ArenaRankingView {
  rank: number;
  /** 个人赛为弟子 id，团队赛为宗门 id。 */
  id: string;
  name: string;
  sectName?: string;
  points: number;
  wins: number;
  losses: number;
}

/** 宗门大比面板（GET /api/v1/game/arena 与报名回执）。 */
export interface ArenaView {
  unlocked: boolean;
  settled: boolean;
  canRegister: boolean;
  /** 距今日结算的毫秒数（未结算且未过 12 点才有；已结算为 null）。 */
  settleInMs: number | null;
  teamPowerCap: number | null;
  seasonId: string;
  /** 战报与日榜所属日期（最近一次结算；从未结算为 null）。 */
  dateKey: string | null;
  myIndividualEntry: ArenaEntryView | null;
  myTeamEntry: ArenaEntryView | null;
  allEntries: { individual: ArenaEntryView[]; team: ArenaEntryView[] };
  individualMatches: ArenaIndividualMatchView[];
  teamMatches: ArenaTeamMatchView[];
  dailyIndividualRanking: ArenaRankingView[];
  dailyTeamRanking: ArenaRankingView[];
  seasonIndividualRanking: ArenaRankingView[];
  seasonTeamRanking: ArenaRankingView[];
}

export async function fetchArena(): Promise<ArenaView> {
  const data = await apiRequest<{ arena: ArenaView }>('/api/v1/game/arena');
  return data.arena;
}

/** 呈报出战名册（个人赛 / 团队赛；discipleIds 的顺序即出战顺序）。 */
export async function setArenaLineup(kind: 'individual' | 'team', discipleIds: string[]): Promise<ArenaView> {
  const data = await apiRequest<{ arena: ArenaView }>('/api/v1/game/arena/lineup', {
    method: 'POST',
    body: { kind, discipleIds },
  });
  return data.arena;
}

/* ---------- 0048 宗门日课（每天 5 个小任务 + 日课宝箱） ---------- */

/** 日课任务 id（与后端 dailyTasks.ts 的 DAILY_TASK_IDS 同口径）。 */
export type DailyTaskId =
  | 'bossHit'
  | 'explore'
  | 'challenge'
  | 'spar'
  | 'gamble'
  | 'journey'
  | 'towerSweep'
  | 'recruit'
  | 'stockTrade'
  | 'veinAttack';

/** 日课里的一个任务：进度已截到目标；奖励是领取时的灵石（最小单位）。 */
export interface DailyTaskView {
  id: DailyTaskId;
  name: string;
  target: number;
  progress: number;
  completed: boolean;
  claimed: boolean;
  /** 领取可得的灵石（最小单位）。 */
  reward: number;
}

export interface DailyChestView {
  /** 可开：当天任务全部领取且宝箱还没开。 */
  available: boolean;
  claimed: boolean;
  description: string;
}

/** 日课面板（GET /game/daily-tasks 的 dailyTasks）。 */
export interface DailyTasksView {
  /** UTC+8 日期键：跨天后整份日课换新。 */
  dateKey: string;
  tasks: DailyTaskView[];
  chest: DailyChestView;
}

/** 领取回执（与后端 view.ts 的 DailyTaskClaimResultView 一一对应）。 */
export interface DailyTaskClaimResult {
  taskId: DailyTaskId;
  /** 入账的灵石（最小单位）。 */
  spiritStone: number;
  message: string;
}

/** 开箱回执（与后端 view.ts 的 DailyChestResultView 一一对应）：玄铁 / 神木为展示单位整数。 */
export interface DailyChestResult {
  xuantie: number;
  shenmu: number;
  pillId: string;
  pillName: string;
  message: string;
}

/** 今天的日课（GET /game/daily-tasks）：第一次读取时服务端抽好任务落库，之后一整天不变。 */
export async function fetchDailyTasks(): Promise<{ state: SectStateView; dailyTasks: DailyTasksView }> {
  return apiRequest<{ state: SectStateView; dailyTasks: DailyTasksView }>('/api/v1/game/daily-tasks');
}

/** 领取一个已完成的任务（POST /game/daily-tasks/claim）：完成与否、是否已领都由服务端裁决。 */
export async function claimDailyTask(taskId: DailyTaskId): Promise<{
  state: SectStateView;
  dailyTasks: DailyTasksView;
  result: DailyTaskClaimResult;
}> {
  return apiRequest<{ state: SectStateView; dailyTasks: DailyTasksView; result: DailyTaskClaimResult }>(
    '/api/v1/game/daily-tasks/claim',
    { method: 'POST', body: { taskId } },
  );
}

/** 开日课宝箱（POST /game/daily-tasks/chest）：当天任务全部领取后才能开，一天一次。 */
export async function openDailyChest(): Promise<{
  state: SectStateView;
  dailyTasks: DailyTasksView;
  result: DailyChestResult;
}> {
  return apiRequest<{ state: SectStateView; dailyTasks: DailyTasksView; result: DailyChestResult }>(
    '/api/v1/game/daily-tasks/chest',
    { method: 'POST', body: {} },
  );
}

/* ---------- 0040 拍卖行 ---------- */

export interface AuctionEquipmentView {
  quality: string;
  qualityName: string;
  slot: string;
  slotName: string;
  mainAttr: string;
  mainAttrName: string;
  mainValue: number;
  subAttr: string;
  subAttrName: string;
  subValue: number;
  /** 0044 祭炼重数（拍卖单里装备的重数，上架 / 下架都保留）。 */
  refineLevel: number;
}

/** 一单。价格一律最小单位灵石；时间是毫秒时间戳。 */
export interface AuctionLotView {
  id: string;
  kind: 'equipment' | 'pill' | 'resource';
  itemId: string;
  itemName: string;
  quantity: number;
  equipment: AuctionEquipmentView | null;
  sellerName: string;
  isSystem: boolean;
  isMine: boolean;
  startPrice: number;
  buyoutPrice: number | null;
  currentPrice: number | null;
  /** 下一口最低出价；不能再出价时为 null。 */
  minNextBid: number | null;
  bidCount: number;
  leaderName: string | null;
  isLeading: boolean;
  status: 'active' | 'sold' | 'expired' | 'cancelled';
  endsAt: number;
  endedAt: number | null;
  fee: number;
  claimable: 'buyer' | 'seller' | null;
  /** 我是领先者且离结束超过 2 小时：可以撤销出价。 */
  retractable: boolean;
  /** 撤销要赔给卖家的违约金（最小单位）；我不是领先者时为 null。 */
  retractPenalty: number | null;
}

export interface AuctionListableView {
  equipment: (AuctionEquipmentView & { id: string; name: string; minPrice: number })[];
  pills: { pillId: string; name: string; quantity: number; unitMinPrice: number }[];
  resources: { resourceId: string; name: string; quantity: number; unitMinPrice: number }[];
}

export interface AuctionView {
  merchant: { name: string; present: boolean; leavesAt: number | null; remainingLots: number };
  unlocked: boolean;
  unlockSectLevel: number;
  feeBp: number;
  bidStepBp: number;
  retractPenaltyBp: number;
  retractCutoffHours: number;
  durationHours: number;
  maxActiveListings: number;
  myActiveCount: number;
  maxPrice: number;
  pillMaxQuantity: number;
  resourceMaxQuantity: number;
  bagCount: number;
  bagCapacity: number;
  hall: AuctionLotView[];
  myLots: AuctionLotView[];
  myBids: AuctionLotView[];
  claimableCount: number;
  listable: AuctionListableView;
}

export interface AuctionActionResponse {
  state: SectStateView;
  auction: AuctionView;
  result: { message: string };
}

export async function fetchAuction(): Promise<{ state: SectStateView; auction: AuctionView }> {
  return apiRequest<{ state: SectStateView; auction: AuctionView }>('/api/v1/game/auction');
}

/** 上架：价格是展示单位整数（灵石个数）。 */
export async function listAuctionItem(body: {
  kind: 'equipment' | 'pill' | 'resource';
  equipmentId?: string;
  pillId?: string;
  resourceId?: string;
  quantity?: number;
  startPrice: number;
  buyoutPrice?: number;
}): Promise<AuctionActionResponse> {
  return apiRequest<AuctionActionResponse>('/api/v1/game/auction/list', { method: 'POST', body });
}

/** 出价：价格是展示单位整数。 */
export async function bidAuction(lotId: string, price: number): Promise<AuctionActionResponse> {
  return apiRequest<AuctionActionResponse>('/api/v1/game/auction/bid', { method: 'POST', body: { lotId, price } });
}

export async function buyoutAuction(lotId: string): Promise<AuctionActionResponse> {
  return apiRequest<AuctionActionResponse>('/api/v1/game/auction/buyout', { method: 'POST', body: { lotId } });
}

export async function cancelAuction(lotId: string): Promise<AuctionActionResponse> {
  return apiRequest<AuctionActionResponse>('/api/v1/game/auction/cancel', { method: 'POST', body: { lotId } });
}

/** 撤销出价（领先者、离结束超过 2 小时；扣 5% 违约金给卖家）。 */
export async function retractAuctionBid(lotId: string): Promise<AuctionActionResponse> {
  return apiRequest<AuctionActionResponse>('/api/v1/game/auction/retract', { method: 'POST', body: { lotId } });
}

export async function claimAuction(lotId: string): Promise<AuctionActionResponse> {
  return apiRequest<AuctionActionResponse>('/api/v1/game/auction/claim', { method: 'POST', body: { lotId } });
}

/* ---------- 0051 山河舆图（全服 14 处灵地：驱妖开辟 / 斗法夺地 / 坐镇 / 灵地供奉） ---------- */

/** 一回合（与后端 view.ts 的 WorldRoundView 一一对应）。 */
export interface WorldRoundView {
  round: number;
  attackerName: string;
  attackerPower: number;
  /** 守方这一回合缺席（被驱逐 / 重伤 / 妖兽已无）时为 null。 */
  defenderName: string | null;
  defenderPower: number | null;
  winner: 'attacker' | 'defender';
}

/** 一处灵地。产出是最小单位 / 小时；时间是 ISO 字符串。 */
export interface WorldSiteView {
  id: string;
  name: string;
  regionId: string;
  regionName: string;
  tier: 'lingdi' | 'fudi' | 'dongtian' | 'zumai';
  tierName: string;
  outputs: { resourceId: string; name: string; perHour: number }[];
  /** 祖脉的稀有材料（每坐镇满 everyHours 个整点小时得 amount 个）；其余为 null。 */
  rare: { resourceId: string; name: string; everyHours: number; amount: number } | null;
  /** 占领者；无主（盘踞妖兽）为 null。 */
  holder: { sectId: string; name: string; level: number; isMe: boolean } | null;
  /** 坐镇弟子（按回合顺序）；absent = 已离宗 / 重伤卧床，这一回合缺席。 */
  garrison: { discipleId: string; name: string; realmName: string; power: number; absent: boolean }[];
  /** 在场坐镇弟子战力之和（未计守方 +10%）。 */
  garrisonPower: number;
  /** 禁制护持截止（还在护持内才有值）。 */
  protectedUntil: string | null;
  /** 我能做什么：beast 驱妖开辟 / battle 斗法 / mine 我占着（可撤回山门）/ null 不能动。 */
  action: 'beast' | 'battle' | 'mine' | null;
  blockedReason: string | null;
}

export interface WorldRegionView {
  id: string;
  name: string;
  /** 主产资源 id 与名字（中州为 null）。 */
  resourceId: string | null;
  resourceName: string | null;
}

/** 山河纪事的一条：text 是服务端拼好的一句话。 */
export interface WorldLogView {
  id: string;
  kind: 'battle' | 'withdraw' | 'settle';
  /** ISO 时间。 */
  createdAt: string;
  text: string;
  /** 斗法 / 撤回的灵地 id；供奉为 null。 */
  siteId: string | null;
  /** 斗法：进攻方是否获胜；其余为 null。 */
  won: boolean | null;
  /** 斗法回合；其余为 null。 */
  rounds: WorldRoundView[] | null;
}

/** 山河舆图面板（GET /game/world 与各命令回执里的 world）。 */
export interface WorldPanelView {
  unlocked: boolean;
  unlockSectLevel: number;
  /** 本宗镇守名额上限 / 已占处数。 */
  cap: number;
  held: number;
  dailyBattles: number;
  battlesUsed: number;
  battlesLeft: number;
  /** 禁制护持时长（小时）。 */
  protectHours: number;
  levelGap: number;
  partySize: number;
  regions: WorldRegionView[];
  sites: WorldSiteView[];
  /** 纪事筛选：all 天下 / mine 本宗（命令回执里的 world 固定为 all）。 */
  scope: 'all' | 'mine';
  logs: WorldLogView[];
}

/** 这一战（驱妖开辟 / 斗法）的战报。 */
export interface WorldBattleResultView {
  siteId: string;
  siteName: string;
  /** 守方宗门名；妖兽为 null。 */
  defenderName: string | null;
  won: boolean;
  rounds: WorldRoundView[];
  /** 进攻失败时受伤的弟子名。 */
  injured: string[];
}

/** 山河舆图命令回执（POST /game/world/attack 与 /game/world/withdraw）。 */
export interface WorldActionResponse {
  state: SectStateView;
  world: WorldPanelView;
  result: { message: string; battle: WorldBattleResultView | null };
}

/** 山河舆图面板（GET /game/world?scope=all|mine）：打开时 / 操作后 / 点刷新时请求。 */
export async function fetchWorld(scope: 'all' | 'mine' = 'all'): Promise<{ state: SectStateView; world: WorldPanelView }> {
  return apiRequest<{ state: SectStateView; world: WorldPanelView }>(`/api/v1/game/world?scope=${scope}`);
}

/** 驱妖开辟（无主，对 3 只妖兽）或斗法夺地（有主）：discipleIds 即出战顺序（回合顺序）。 */
export async function attackWorldSite(siteId: string, discipleIds: string[]): Promise<WorldActionResponse> {
  return apiRequest<WorldActionResponse>('/api/v1/game/world/attack', { method: 'POST', body: { siteId, discipleIds } });
}

/** 撤回山门：灵地回到盘踞妖兽手里，坐镇弟子立即解锁，没有禁制。 */
export async function withdrawWorldSite(siteId: string): Promise<WorldActionResponse> {
  return apiRequest<WorldActionResponse>('/api/v1/game/world/withdraw', { method: 'POST', body: { siteId } });
}

/* ---------- 0043 灵股行情 ---------- */

export interface StockMarginPositionView {
  side: 'long' | 'short';
  shares: number;
  entryPrice: number;
  margin: number;
  leverage: number;
  liquidationPrice: number;
  unrealizedPnl: number;
  equity: number;
  marginRatio: number;
  liquidationRisk: boolean;
  openedAt: number;
}

export interface StockHoldingView {
  shares: number;
  cost: number;
  avgPrice: number;
  marketValue: number;
  profit: number;
  profitPct: number;
  sellableAt: number | null;
  /** 挂着卖单锁住的股数。 */
  locked: number;
  /** 可用股数（持有 − 锁定）：手动卖出与新卖单只能用这些。 */
  available: number;
}

/** 一支股票（价格 / 金额都是最小单位灵石）。 */
export interface StockView {
  id: string;
  name: string;
  code: string;
  sector: string;
  description: string;
  price: number;
  prevPrice: number;
  change24hPct: number;
  high24h: number;
  low24h: number;
  holding: StockHoldingView | null;
  marginPosition: StockMarginPositionView | null;
}

export interface MarketNewsView {
  id: string;
  at: number;
  stockId: string | null;
  stockName: string;
  direction: 1 | -1;
  title: string;
}

export interface StockTradeView {
  id: string;
  stockId: string;
  stockName: string;
  side: 'buy' | 'sell';
  shares: number;
  price: number;
  amount: number;
  fee: number;
  profit: number;
  createdAt: number;
}

export interface MarketView {
  unlocked: boolean;
  unlockSectLevel: number;
  feeBp: number;
  holdMinutes: number;
  dailyTrades: number;
  tradesUsed: number;
  tradesLeft: number;
  positionCap: number;
  maxSharesPerTrade: number;
  serverNow: number;
  nextTickAt: number;
  index: { value: number; change24hPct: number };
  stocks: StockView[];
  news: MarketNewsView[];
  myTrades: StockTradeView[];
  marginTrades: {
    id: string;
    stockId: string;
    stockName: string;
    action: 'open' | 'close' | 'liquidate';
    side: 'long' | 'short';
    shares: number;
    price: number;
    fee: number;
    margin: number;
    pnl: number;
    createdAt: number;
  }[];
  myProfit: number;
  ranks: { rank: number; sectName: string; profit: number; isMe: boolean }[];
  orders: MarketOrdersView;
}

/* ---------- 0049 灵股挂单 ---------- */

export type MarketOrderKind = 'limit_buy' | 'limit_sell' | 'stop_sell';

/** 一张挂单（金额是最小单位；时间是 ISO 字符串）。 */
export interface MarketOrderView {
  id: string;
  stockId: string;
  stockName: string;
  kind: MarketOrderKind;
  kindName: string;
  shares: number;
  triggerPrice: number;
  /** 限价买冻结的灵石（含手续费）；卖单为 0。 */
  reserved: number;
  status: 'open' | 'filled' | 'cancelled' | 'expired';
  statusName: string;
  fillPrice: number | null;
  filledAt: string | null;
  /** filled / user / expired / position_cap / no_shares；未结束为 null。 */
  closeReason: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface MarketOrdersView {
  open: MarketOrderView[];
  recent: MarketOrderView[];
  maxOpen: number;
  ttlHours: number;
}

export type MarketChartRange = '1h' | '6h' | '1d' | '7d';

export interface MarketChartView {
  stockId: string;
  range: MarketChartRange;
  candleMinutes: number;
  candles: { t: number; o: number; h: number; l: number; c: number }[];
}

export interface MarketTradeResultView {
  side: 'buy' | 'sell';
  stockId: string;
  stockName: string;
  shares: number;
  price: number;
  amount: number;
  fee: number;
  profit: number;
  message: string;
}

export async function fetchMarket(): Promise<{ state: SectStateView; market: MarketView }> {
  return apiRequest<{ state: SectStateView; market: MarketView }>('/api/v1/game/market');
}

export async function fetchMarketChart(stockId: string, range: MarketChartRange): Promise<{ chart: MarketChartView }> {
  return apiRequest<{ chart: MarketChartView }>(
    `/api/v1/game/market/chart?stockId=${encodeURIComponent(stockId)}&range=${range}`,
  );
}

export interface MarketMarginTradeResultView {
  action: 'open' | 'close';
  side: 'long' | 'short';
  stockId: string;
  stockName: string;
  shares: number;
  price: number;
  fee: number;
  margin: number;
  pnl: number;
  message: string;
}

export async function tradeStock(
  stockId: string,
  side: 'buy' | 'sell',
  shares: number,
): Promise<{ state: SectStateView; market: MarketView; result: MarketTradeResultView }> {
  return apiRequest<{ state: SectStateView; market: MarketView; result: MarketTradeResultView }>(
    '/api/v1/game/market/trade',
    { method: 'POST', body: { stockId, side, shares } },
  );
}

export async function tradeStockMargin(
  stockId: string,
  action: 'open' | 'close',
  shares: number,
  side?: 'long' | 'short',
): Promise<{ state: SectStateView; market: MarketView; result: MarketMarginTradeResultView }> {
  return apiRequest<{ state: SectStateView; market: MarketView; result: MarketMarginTradeResultView }>(
    '/api/v1/game/market/margin',
    { method: 'POST', body: { stockId, action, shares, side } },
  );
}

/** 下挂单：触发价是最小单位整数；限价买会冻结灵石，卖单锁股数。 */
export async function placeStockOrder(
  stockId: string,
  kind: MarketOrderKind,
  shares: number,
  triggerPrice: number,
): Promise<{ state: SectStateView; market: MarketView }> {
  return apiRequest<{ state: SectStateView; market: MarketView }>('/api/v1/game/market/orders', {
    method: 'POST',
    body: { stockId, kind, shares, triggerPrice },
  });
}

/** 撤单（只能撤本宗未完成的单；冻结的灵石原路退回）。 */
export async function cancelStockOrder(orderId: string): Promise<{ state: SectStateView; market: MarketView }> {
  return apiRequest<{ state: SectStateView; market: MarketView }>('/api/v1/game/market/orders/cancel', {
    method: 'POST',
    body: { orderId },
  });
}

/* ---------- 首页功能区：各玩法状态摘要 ---------- */

/** 各玩法此刻的状态摘要（GET /game/hub）；首页状态卡片与待办浮窗用。金额是最小单位。 */
export interface HubView {
  worldBoss: {
    phase: 'before' | 'open' | 'frenzy' | 'closed';
    stage: number | null;
    hpPercent: number | null;
    attackable: boolean;
  };
  tower: { unlocked: boolean; maxFloor: number; sweepable: boolean; failsLeft: number };
  /** 秘境：今天在已开放的秘境里还能探几次（各秘境每日次数相加）。 */
  explore: { remaining: number; total: number };
  /** 0051 山河舆图：镇守名额与失陷情况（只读汇总）。 */
  world: {
    unlocked: boolean;
    /** 镇守名额上限。 */
    cap: number;
    /** 本宗正占着的灵地数。 */
    held: number;
    /** 还能开辟 / 夺下几处（max(0, cap − held)）。 */
    freeSlots: number;
    /** 近 24 小时被夺、且现在不在本宗手里的灵地数。 */
    lostCount: number;
    /** 这些灵地各自最近一次失陷的时刻（毫秒，服务端时钟）；首页只提示比「已看过」更新的。 */
    lostAt?: number[];
  };
  auction: { unlocked: boolean; claimable: number; myActive: number; merchantStock: number };
  market: { unlocked: boolean; holdings: number; profit: number; profitPct: number };
  /** 宗门大比：今天是否已结算，本宗今日两赛制的名次（未结算 / 未参赛为 null）。 */
  arena: { unlocked: boolean; settled: boolean; myIndividualRank: number | null; myTeamRank: number | null };
}

export async function fetchHub(): Promise<{ hub: HubView }> {
  return apiRequest<{ hub: HubView }>('/api/v1/game/hub');
}

export interface SpiritBeastActionData { state:SectStateView; beasts:SpiritBeastsPanel; receipt:BeastCommandReceipt|null }
export function fetchSpiritBeasts() { return apiRequest<SpiritBeastActionData>('/api/v1/game/spirit-beasts'); }
export function startBeastCapture(areaId:string,discipleId:string,commandId:string) { return apiRequest<{state:SectStateView;beasts:SpiritBeastsPanel}>('/api/v1/game/beast-capture/start',{method:'POST',body:{areaId,discipleId,commandId}}); }
export function actBeastCapture(sessionId:string,version:number,action:BeastCaptureAction,commandId:string) { return apiRequest<{state:SectStateView;beasts:SpiritBeastsPanel}>('/api/v1/game/beast-capture/action',{method:'POST',body:{sessionId,version,action,commandId}}); }
export function manageSpiritBeast(beastId:string,version:number,action:BeastManageAction,commandId:string,discipleId?:string,locked?:boolean) { return apiRequest<SpiritBeastActionData>('/api/v1/game/spirit-beasts/manage',{method:'POST',body:{beastId,version,action,commandId,...(discipleId?{discipleId}:{}),...(locked===undefined?{}:{locked})}}); }
export function releaseSpiritBeasts(beasts:{beastId:string;version:number}[],commandId:string) { return apiRequest<SpiritBeastActionData>('/api/v1/game/spirit-beasts/release-batch',{method:'POST',body:{beasts,commandId}}); }
export function exchangeSpiritBeast(input:BeastExchangeInput) { return apiRequest<SpiritBeastActionData>('/api/v1/game/spirit-beasts/exchange',{method:'POST',body:input}); }
