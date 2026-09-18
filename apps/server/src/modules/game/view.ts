import type { GameConfigContent } from '@xiuxian/game-core';

import {
  BREAKTHROUGH_ARRAY_BONUS_BP_PER_LEVEL,
  IDLE_ASSIGNMENT,
  SPIRITUAL_ARRAY_BUILDING_ID,
  SCRIPTURE_LIBRARY_BUILDING_ID,
  breakthroughEnergyCost,
  effectiveCapacity,
  findRealm,
  findSectLevel,
  findStage,
  findTalent,
  nextSectLevel,
  realmIndex,
} from './constants';
import { RECENT_EVENTS_IN_SYNC, eventNameOf, type TriggeredEvent } from './events';
import { discipleCombatPower } from './realms';
import type { BuildingRow, DiscipleRow, EventLogRow, ResourceBalanceRow, SectRow } from './repository';
import { cultivationRatePerHour, resourceRates, type DiscipleState, type SettleResult } from './settle';
/**
 * 接口返回的视图类型（前端只读这些字段，不需要再读配置）。
 *
 * 金额类字段用「最小单位十进制字符串」（03 第 1 节：1 展示单位 = 1000 最小单位）；
 * 修为是非负整数，直接用 number。canXxx / blockedReason 由服务端算好，前端不做规则判断。
 */

export interface ResourceView {
  id: string;
  name: string;
  balance: string;
  capacity: string;
  /** 当前产量（最小单位/小时），前端据此本地平滑显示。 */
  ratePerHour: string;
  capped: boolean;
  /** 本段结算因满仓丢弃的量。 */
  discarded: string;
}

export interface EventLogView {
  id: string;
  eventId: string;
  name: string;
  description: string;
  /** resourceId -> 最小单位数量（带符号的十进制字符串）。 */
  effects: Record<string, string>;
  /** ISO 时间字符串。 */
  createdAt: string;
}

export interface DiscipleView {
  id: string;
  name: string;
  gender: string;
  aptitude: number;
  /** V4 战斗属性（1~100）。 */
  attack: number;
  defense: number;
  speed: number;
  /** 天赋 id 与展示名（无/未知天赋时 talentName 为「无」）。 */
  talent: string;
  talentName: string;
  /** 当前战力（展示用，由 realms.ts 的 discipleCombatPower 现算）。 */
  combatPower: number;
  realmId: string;
  realmName: string;
  stage: number;
  stageName: string;
  cultivation: number;
  /** 突破门槛；null 表示已是本版本最高阶段。 */
  requiredCultivation: number | null;
  cultivationRatePerHour: number;
  assignment: string;
  assignmentName: string;
  injuredUntil: string | null;
  canBreakthrough: boolean;
  blockedReason: string | null;
  breakthroughCost: string;
  breakthroughChanceBp: number;
}

export interface BuildingView {
  defId: string;
  name: string;
  level: number;
  maxLevel: number;
  /** 升到下一级的消耗（最小单位）；已满级为 null。 */
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

export interface AssignmentOptionView {
  id: string;
  name: string;
}

/** 宗门升级信息：条件逐条给前端（前端不做规则判断，只渲染 ✓/✗）。 */
export interface SectUpgradeView {
  nextLevel: number;
  nextLevelName: string;
  cost: Record<string, string>;
  requirements: { label: string; met: boolean }[];
  canUpgrade: boolean;
  blockedReason: string | null;
}

export interface SectStateView {
  sect: {
    id: string;
    name: string;
    level: number;
    /** 等级名称（例如「散修驻地」）。 */
    levelName: string;
    /** 声望（V3 多人互动）：切磋胜利 +10，失败/平局不变。 */
    reputation: number;
    veinLevel: number;
    discipleCapacity: number;
    buildingCapacity: number;
    lastSettledAt: string;
  };
  serverNow: string;
  resources: ResourceView[];
  disciples: DiscipleView[];
  buildings: BuildingView[];
  recruit: RecruitView;
  assignments: AssignmentOptionView[];
  /** 最近触发的事件（新的在前，最多 10 条）。 */
  recentEvents: EventLogView[];
  /** 本次结算的摘要（前端可选展示）。 */
  settle: {
    durationSeconds: number;
    cappedByOfflineLimit: boolean;
    clockWentBackwards: boolean;
    totalDiscarded: string;
  };
  /** 宗门升级信息。null = 已满级。 */
  sectUpgrade: SectUpgradeView | null;
}

/** 秘境列表视图（GET /game/realms）：规则（锁定/次数）由服务端算好，前端只渲染。 */
export interface SecretRealmListView {
  id: string;
  name: string;
  description: string;
  difficulty: number;
  entryCost: Record<string, string>;
  rewards: Record<string, string>;
  minParty: number;
  maxParty: number;
  /** 每日探索次数上限；null = 不限。 */
  dailyLimit: number | null;
  /** 今日已探索次数（仅 dailyLimit !== null 时统计，其余为 0）。 */
  usedToday: number;
  requiredSectLevel: number;
  /** 宗门等级不足 = true。 */
  locked: boolean;
  /** 宗门是否已建造演武场（没有则不能探索）。 */
  hasArena: boolean;
}

/** 单次探索结果（POST /game/explore 的 result）。 */
export interface ExplorationResultView {
  realmName: string;
  success: boolean;
  /** 本次成功率（基点，0~10000）。 */
  chanceBp: number;
  /** 本次随机掷点（0~9999）。 */
  roll: number;
  /** 成功时的实际奖励（最小单位）；失败为空对象。 */
  rewards: Record<string, string>;
  memberNames: string[];
  message: string;
}

/** 排行榜条目（V3 第二节）：综合榜，等级 → 声望 → 创建时间。 */
export interface LeaderboardEntryView {
  sectId: string;
  name: string;
  level: number;
  levelName: string;
  reputation: number;
  discipleCount: number;
  /** 最高境界弟子（用于展示「镇派之宝」）。 */
  topDisciple: {
    name: string;
    realmName: string;
    stageName: string;
  } | null;
  /** 是否是当前用户自己的宗门。 */
  isMe: boolean;
}

/**
 * 公开档案（V3 第三节）：只暴露安全字段，**不含**资源余额、修为进度、岗位、
 * 伤势、招募计数与建筑升级消耗。
 */
export interface PublicSectView {
  sectId: string;
  name: string;
  level: number;
  levelName: string;
  reputation: number;
  disciples: PublicDiscipleView[];
  buildings: PublicBuildingView[];
  createdAt: string;
}

/** 公开档案里的弟子：名字/性别/境界/阶段/资质 + V4 的战斗属性与天赋。 */
export interface PublicDiscipleView {
  id: string;
  name: string;
  gender: string;
  aptitude: number;
  attack: number;
  defense: number;
  speed: number;
  talent: string;
  talentName: string;
  realmName: string;
  stageName: string;
}

/** 公开档案里的建筑：只有名称与等级，不含升级消耗。 */
export interface PublicBuildingView {
  name: string;
  level: number;
}

/** 切磋历史条目（GET /game/spar-history）。 */
export interface SparHistoryEntryView {
  id: string;
  attackerSectId: string;
  attackerSectName: string;
  defenderSectId: string;
  defenderSectName: string;
  attackerPower: number;
  defenderPower: number;
  /** 从攻方视角：'win' | 'lose' | 'draw'。 */
  result: string;
  reputationGained: number;
  /** 当前用户是攻方还是守方。 */
  role: 'attacker' | 'defender';
  createdAt: string;
}

/** 切磋战绩统计。 */
export interface SparStatsView {
  wins: number;
  losses: number;
  draws: number;
  total: number;
}

/** 切磋历史（GET /game/spar-history 的 data）。 */
export interface SparHistoryView {
  entries: SparHistoryEntryView[];
  stats: SparStatsView;
}

/** 单次切磋结果（POST /game/spar 的 result）。 */
export interface SparResultView {
  myDiscipleName: string;
  targetDiscipleName: string;
  targetSectName: string;
  myPower: number;
  targetPower: number;
  result: 'win' | 'lose' | 'draw';
  reputationGained: number;
  spiritStoneGained: number;
  message: string;
}

export interface SectStateInput {
  config: GameConfigContent;
  sect: SectRow;
  disciples: readonly DiscipleRow[];
  buildings: readonly BuildingRow[];
  balances: readonly ResourceBalanceRow[];
  settleResult: SettleResult;
  /** 库里的最近事件行；本次结算刚触发的事件在 buildSectStateView 里合并进来。 */
  recentEventRows: readonly EventLogRow[];
  now: number;
  /** 今日已招募次数（由调用方按日期 key 归一）。 */
  recruitUsedToday: number;
  /** 宗门等级的资源容量倍率（影响所有资源的实际容量）。 */
  capacityMultiplier: number;
}

export function buildSectStateView(input: SectStateInput): SectStateView {
  const {
    config,
    sect,
    disciples,
    buildings,
    balances,
    settleResult,
    now,
    recruitUsedToday,
    recentEventRows,
    capacityMultiplier,
  } = input;
  // 速率按「当前状态」现算，而不是沿用本次结算用的旧状态：派工 / 升级藏经阁返回的那一帧里，
  // 前端看到的「每时产出」与静修速率就已经是新值（结算本身仍只用旧状态计已经过去的那段时间）。
  const libraryLevel =
    buildings.find((building) => building.def_id === SCRIPTURE_LIBRARY_BUILDING_ID)?.level ?? 0;
  const resourceRatesNow = resourceRates(config, disciples.map(toDiscipleState));
  const ratesByDisciple = new Map(
    disciples.map((disciple) => [
      disciple.id,
      cultivationRatePerHour(config, toDiscipleState(disciple), libraryLevel),
    ]),
  );

  // 容量/上限一律按「当前（可能刚升级的）等级」现算，升级当次返回的就是新数值。
  const levelDef = findSectLevel(Number(sect.level));

  const balancesByResource = new Map(balances.map((row) => [row.resource_id, Number(row.balance)]));
  const arrayLevel =
    buildings.find((building) => building.def_id === SPIRITUAL_ARRAY_BUILDING_ID)?.level ?? 0;
  const energyBalance = balancesByResource.get('spiritualEnergy') ?? 0;
  const energyName = config.resources.find((resource) => resource.id === 'spiritualEnergy')?.name ?? '灵气';

  const resources: ResourceView[] = config.resources.map((definition) => {
    const row = balances.find((item) => item.resource_id === definition.id);
    const settled = settleResult.resources.find((item) => item.resourceId === definition.id);
    return {
      id: definition.id,
      name: definition.name,
      balance: String(row?.balance ?? 0),
      capacity: String(effectiveCapacity(definition.capacity, capacityMultiplier)),
      ratePerHour: String(resourceRatesNow.get(definition.id) ?? 0),
      capped: settled?.capped ?? false,
      discarded: String(settled?.discarded ?? 0),
    };
  });

  const assignmentNames = new Map<string, string>([
    [IDLE_ASSIGNMENT, '闲置'],
    ...config.positions.map((position) => [position.id, position.name] as const),
  ]);

  const discipleViews: DiscipleView[] = disciples.map((disciple) => {
    const realm = findRealm(disciple.realm_id);
    const stage = findStage(disciple.realm_id, disciple.stage);
    const cost = breakthroughEnergyCost(disciple.stage);
    const chanceBp = breakthroughChanceBp(config, arrayLevel);
    const injured = disciple.injured_until !== null && disciple.injured_until > now;

    let blockedReason: string | null = null;
    if (stage.requiredCultivation === null) {
      blockedReason = '已达本版本最高境界（后续境界待开放）';
    } else if (injured) {
      blockedReason = `疗伤中（剩 ${Math.ceil(((disciple.injured_until ?? 0) - now) / 1000)} 秒）`;
    } else if (disciple.cultivation < stage.requiredCultivation) {
      blockedReason = `修为不足（需要 ${String(stage.requiredCultivation)}）`;
    } else if (energyBalance < cost) {
      blockedReason = `${energyName}不足（需要 ${String(cost)}）`;
    }

    return {
      id: disciple.id,
      name: disciple.name,
      gender: disciple.gender,
      aptitude: disciple.aptitude,
      attack: Number(disciple.attack),
      defense: Number(disciple.defense),
      speed: Number(disciple.speed),
      talent: disciple.talent,
      talentName: findTalent(disciple.talent)?.name ?? '无',
      combatPower: discipleCombatPower(
        disciple.realm_id,
        Number(disciple.stage),
        Number(disciple.attack),
        Number(disciple.defense),
        Number(disciple.speed),
        disciple.talent,
      ),
      realmId: realm.id,
      realmName: realm.name,
      stage: disciple.stage,
      stageName: stage.name,
      cultivation: Number(disciple.cultivation),
      requiredCultivation: stage.requiredCultivation,
      cultivationRatePerHour: ratesByDisciple.get(disciple.id) ?? 0,
      assignment: disciple.assignment,
      assignmentName: assignmentNames.get(disciple.assignment) ?? disciple.assignment,
      injuredUntil: disciple.injured_until === null ? null : new Date(disciple.injured_until).toISOString(),
      canBreakthrough: blockedReason === null,
      blockedReason,
      breakthroughCost: String(cost),
      breakthroughChanceBp: chanceBp,
    };
  });

  const buildingViews: BuildingView[] = buildings.map((building) => {
    const definition = config.buildings.find((item) => item.id === building.def_id);
    const maxLevel = definition?.maxLevel ?? 1;
    if (definition === undefined || building.level >= maxLevel) {
      return {
        defId: building.def_id,
        name: definition?.name ?? building.def_id,
        level: building.level,
        maxLevel,
        upgradeCost: null,
        canUpgrade: false,
        blockedReason: '已满级',
      };
    }

    const cost = upgradeCost(definition.upgradeCostPerLevel, building.level);
    const lacking = Object.entries(cost).find(
      ([resourceId, amount]) => (balancesByResource.get(resourceId) ?? 0) < Number(amount),
    );
    const resourceName =
      lacking === undefined
        ? ''
        : (config.resources.find((resource) => resource.id === lacking[0])?.name ?? lacking[0]);

    return {
      defId: building.def_id,
      name: definition.name,
      level: building.level,
      maxLevel,
      upgradeCost: cost,
      canUpgrade: lacking === undefined,
      blockedReason: lacking === undefined ? null : `${resourceName}不足`,
    };
  });

  const discipleCapacity = levelDef.discipleCapacity;
  const buildingCapacity = levelDef.buildingCapacity;
  const recruitRemaining = Math.max(0, config.recruitment.dailyLimit - recruitUsedToday);
  const recruitCost = { ...config.recruitment.cost };
  const recruitLacking = Object.entries(recruitCost).find(
    ([resourceId, amount]) => (balancesByResource.get(resourceId) ?? 0) < Number(amount),
  );
  const recruitBlockedReason =
    disciples.length >= discipleCapacity
      ? '弟子上限已满'
      : recruitRemaining <= 0
        ? '今日招募次数已用完'
        : recruitLacking !== undefined
          ? `${
              config.resources.find((resource) => resource.id === recruitLacking[0])?.name ??
              recruitLacking[0]
            }不足`
          : null;

  const sectUpgrade = buildSectUpgradeView({
    config,
    sectLevel: Number(sect.level),
    disciples,
    buildings,
    balancesByResource,
  });

  return {
    sect: {
      id: sect.id,
      name: sect.name,
      level: sect.level,
      levelName: levelDef.name,
      reputation: Number(sect.reputation) || 0,
      veinLevel: sect.vein_level,
      discipleCapacity,
      buildingCapacity,
      lastSettledAt: new Date(sect.last_settled_at).toISOString(),
    },
    serverNow: new Date(now).toISOString(),
    resources,
    disciples: discipleViews,
    buildings: buildingViews,
    recruit: {
      cost: recruitCost,
      dailyLimit: config.recruitment.dailyLimit,
      usedToday: recruitUsedToday,
      remaining: recruitRemaining,
      discipleCount: disciples.length,
      discipleCapacity,
      canRecruit: recruitBlockedReason === null,
      blockedReason: recruitBlockedReason,
    },
    assignments: [
      { id: IDLE_ASSIGNMENT, name: '闲置' },
      ...config.positions.map((position) => ({ id: position.id, name: position.name })),
    ],
    recentEvents: mergeRecentEvents(settleResult.events, recentEventRows, now, RECENT_EVENTS_IN_SYNC),
    settle: {
      durationSeconds: Math.floor(settleResult.durationMs / 1000),
      cappedByOfflineLimit: settleResult.cappedByOfflineLimit,
      clockWentBackwards: settleResult.clockWentBackwards,
      totalDiscarded: String(settleResult.totalDiscarded),
    },
    sectUpgrade,
  };
}

/** 宗门升级信息：已满级返回 null。 */
function buildSectUpgradeView(input: {
  config: GameConfigContent;
  sectLevel: number;
  disciples: readonly DiscipleRow[];
  buildings: readonly BuildingRow[];
  balancesByResource: ReadonlyMap<string, number>;
}): SectUpgradeView | null {
  const { config, sectLevel, disciples, buildings, balancesByResource } = input;
  const next = nextSectLevel(sectLevel);
  if (next === null) {
    return null;
  }

  const requirements: { label: string; met: boolean }[] = [];
  const blockedReasons: string[] = [];

  // 建筑条件
  for (const req of next.buildingRequirements) {
    const building = buildings.find((item) => item.def_id === req.defId);
    const buildingName = config.buildings.find((item) => item.id === req.defId)?.name ?? req.defId;
    const currentLevel = building?.level ?? 0;
    const met = currentLevel >= req.minLevel;
    requirements.push({ label: `${buildingName} ${req.minLevel}级（当前${currentLevel}级）`, met });
    if (!met) {
      blockedReasons.push(`${buildingName}等级不足`);
    }
  }

  // 弟子境界条件
  for (const req of next.discipleRequirements) {
    const realmName = findRealm(req.minRealmId).name;
    const requiredRealmIndex = realmIndex(req.minRealmId);
    const qualified = disciples.filter(
      (disciple) => realmIndex(disciple.realm_id) >= requiredRealmIndex,
    ).length;
    const met = qualified >= req.count;
    requirements.push({ label: `${req.count}名${realmName}弟子（当前${qualified}名）`, met });
    if (!met) {
      blockedReasons.push(`${realmName}弟子不足`);
    }
  }

  // 资源条件
  for (const [resourceId, amount] of Object.entries(next.upgradeCost)) {
    const balance = balancesByResource.get(resourceId) ?? 0;
    if (balance < Number(amount)) {
      const resourceName =
        config.resources.find((item) => item.id === resourceId)?.name ?? resourceId;
      blockedReasons.push(`${resourceName}不足`);
    }
  }

  return {
    nextLevel: next.level,
    nextLevelName: next.name,
    cost: next.upgradeCost,
    requirements,
    canUpgrade: blockedReasons.length === 0,
    blockedReason: blockedReasons.length > 0 ? blockedReasons.join('；') : null,
  };
}

/** 升级消耗 = 配置里的每级消耗 × 当前等级（03 第 2 节：灵石 50×当前等级、矿石 10×当前等级）。 */
export function upgradeCost(
  costPerLevel: Record<string, string>,
  currentLevel: number,
): Record<string, string> {
  const cost: Record<string, string> = {};
  for (const [resourceId, amount] of Object.entries(costPerLevel)) {
    cost[resourceId] = String(Number(amount) * Math.max(1, currentLevel));
  }
  return cost;
}

/** 突破成功率（基点）：基础 + 聚灵阵等级加成，再按配置 clamp。 */
export function breakthroughChanceBp(config: GameConfigContent, arrayLevel: number): number {
  const base =
    config.breakthrough.baseChanceBp +
    Math.max(0, arrayLevel - 1) * BREAKTHROUGH_ARRAY_BONUS_BP_PER_LEVEL;
  return Math.min(config.breakthrough.maxChanceBp, Math.max(config.breakthrough.minChanceBp, base));
}

/**
 * 把「库里的最近事件」与「本次结算刚触发的事件」合并去重（按 id）、新的在前、截取 limit 条。
 * 刚插入的行在本请求读快照时还不存在，所以必须与本次触发的事件合并，不能只查库。
 */
export function mergeRecentEvents(
  triggered: readonly TriggeredEvent[],
  rows: readonly EventLogRow[],
  now: number,
  limit: number,
): EventLogView[] {
  const seen = new Set<string>();
  const merged: EventLogView[] = [];
  for (const event of triggered) {
    if (seen.has(event.id)) {
      continue;
    }
    seen.add(event.id);
    merged.push(triggeredEventView(event, now));
  }
  for (const row of rows) {
    if (seen.has(row.id)) {
      continue;
    }
    seen.add(row.id);
    merged.push(eventLogViewFromRow(row));
  }
  // createdAt 相同（同一轮结算触发的 2~3 个事件）时用 id 兜底，与库里的
  // `ORDER BY created_at DESC, id DESC` 保持同一顺序：这样「刚触发」的这一帧
  // 和下一次 sync 从库里读出来的顺序不会跳变。
  merged.sort((a, b) => {
    if (a.createdAt !== b.createdAt) {
      return a.createdAt < b.createdAt ? 1 : -1;
    }
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
  return merged.slice(0, limit);
}

/** event_log 行 -> 视图；name 由事件定义按 event_id 反查，查不到用 event_id 兜底。 */
export function eventLogViewFromRow(row: EventLogRow): EventLogView {
  return {
    id: row.id,
    eventId: row.event_id,
    name: eventNameOf(row.event_id),
    description: row.description,
    effects: parseEffects(row.effects),
    createdAt: new Date(Number(row.created_at)).toISOString(),
  };
}

function triggeredEventView(event: TriggeredEvent, now: number): EventLogView {
  return {
    id: event.id,
    eventId: event.eventId,
    name: event.name,
    description: event.description,
    effects: { ...event.effects },
    createdAt: new Date(now).toISOString(),
  };
}

/** effects 列的 JSON 解析；非法输入退化为空对象，避免脏数据让整个 state 读取失败。 */
function parseEffects(text: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object') {
      return {};
    }
    const effects: Record<string, string> = {};
    for (const [resourceId, amount] of Object.entries(parsed as Record<string, unknown>)) {
      effects[resourceId] = String(amount);
    }
    return effects;
  } catch {
    return {};
  }
}

/** 弟子行 → 速率计算用的形状（与 service.ts 构造 settleEconomy 入参的映射保持一致）。 */
function toDiscipleState(row: DiscipleRow): DiscipleState {
  return {
    id: row.id,
    aptitude: Number(row.aptitude),
    realmId: row.realm_id,
    stage: Number(row.stage),
    cultivation: Number(row.cultivation),
    cultivationRemainder: Number(row.cultivation_remainder),
    assignment: row.assignment,
    talent: row.talent,
  };
}
