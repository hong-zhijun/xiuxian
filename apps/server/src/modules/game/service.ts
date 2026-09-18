import type { GameConfigContent } from '@xiuxian/game-core';

import { validatedGameConfig } from '../../config/loadGameConfig';
import { AppError } from '../../http/appError';
import { prepareStatements, type ParameterizedQuery } from '../../infra/db/repository';
import {
  IDLE_ASSIGNMENT,
  SPIRITUAL_ARRAY_BUILDING_ID,
  breakthroughEnergyCost,
  dateKeyUtc8,
  dayStartMs,
  findRealm,
  findSectLevel,
  findStage,
  findTalent,
  nextSectLevel,
  nextStageOf,
  realmIndex,
} from './constants';
import { EVENT_HISTORY_LIMIT, RECENT_EVENTS_IN_SYNC } from './events';
import {
  generateCandidates,
  generateTalent,
  randomAptitude,
  randomDiscipleName,
  randomGender,
  type RecruitCandidate,
} from './names';
import {
  ARENA_BUILDING_ID,
  SECRET_REALMS,
  discipleCombatPower,
  explorationSuccessChanceBp,
  findSecretRealm,
  partyCombatPower,
} from './realms';
import {
  BuildingRepository,
  DiscipleRepository,
  EventLogRepository,
  ExplorationRepository,
  ResourceBalanceRepository,
  SectRepository,
  SparringRepository,
  insertBuildingStatement,
  insertDiscipleStatement,
  insertEventLogStatement,
  insertExplorationStatement,
  insertResourceBalanceStatement,
  insertSectStatement,
  insertSparringLogStatement,
  resourceDeltaStatement,
  updateBuildingLevelStatement,
  updateDiscipleAssignmentStatement,
  updateDiscipleCultivationStatement,
  updateDiscipleInjuryStatement,
  updateDiscipleProgressStatement,
  updateResourceSettledStatement,
  updateSectLevelStatement,
  updateSectRecruitCounterStatement,
  updateSectReputationStatement,
  updateSectSettledStatement,
  type BuildingRow,
  type DiscipleRow,
  type EventLogRow,
  type ResourceBalanceRow,
  type SectRow,
} from './repository';
import { settleEconomy, type SettleResult } from './settle';
import {
  breakthroughChanceBp,
  buildSectStateView,
  eventLogViewFromRow,
  upgradeCost,
  type EventLogView,
  type ExplorationResultView,
  type LeaderboardEntryView,
  type PublicSectView,
  type SecretRealmListView,
  type SectStateView,
  type SparResultView,
} from './view';

/**
 * 游戏服务（一次性可玩版本）。
 *
 * 每个命令都是同一套路：读快照 → 结算（纯函数）→ 校验 → 把「结算写回 + 命令写入」
 * 组装成**一次** D1 batch 提交 → 用内存中的新状态返回给前端。
 * 没有幂等键、没有版本号、没有事务守卫（任务卡明确要求）。
 */

export interface SectSnapshot {
  sect: SectRow;
  disciples: DiscipleRow[];
  buildings: BuildingRow[];
  balances: ResourceBalanceRow[];
  /** 读快照时库里的最近事件行；本次结算刚触发的在本层另行合并（见 view.ts）。 */
  recentEvents: EventLogRow[];
}

/** 全局唯一配置来源：启动期已校验过的配置内容（不在游戏模块里硬编码数值）。 */
export function gameConfig(): GameConfigContent {
  return validatedGameConfig.content;
}

async function loadSnapshot(db: D1Database, userId: string): Promise<SectSnapshot | null> {
  const sect = await new SectRepository(db).findByUserId(userId);
  if (sect === null) {
    return null;
  }
  const [disciples, buildings, balances, recentEvents] = await Promise.all([
    new DiscipleRepository(db).findBySectId(sect.id),
    new BuildingRepository(db).findBySectId(sect.id),
    new ResourceBalanceRepository(db).findBySectId(sect.id),
    new EventLogRepository(db).findRecentBySectId(sect.id, RECENT_EVENTS_IN_SYNC),
  ]);
  return { sect, disciples, buildings, balances, recentEvents };
}

/**
 * 已结算的草稿：结算结果 + 命令附加语句。
 *
 * 结算的写回语句在构造时算好（只写真正变化的行），命令的写入用 `addStatement` 追加，
 * 最后 `commit()` 一次性提交，顺序即数组顺序（先结算，再消耗/产出）。
 */
class SectDraft {
  readonly config: GameConfigContent;
  readonly now: number;
  readonly settleResult: SettleResult;
  /** 当前宗门等级决定的弟子上限。 */
  readonly discipleCapacity: number;
  /** 当前宗门等级决定的建筑上限。 */
  readonly buildingCapacity: number;
  /** 当前宗门等级的资源容量倍率。 */
  readonly capacityMultiplier: number;
  readonly sect: SectRow;
  disciples: DiscipleRow[];
  readonly buildings: BuildingRow[];
  balances: ResourceBalanceRow[];
  readonly recruitUsedToday: number;

  private readonly statements: ParameterizedQuery[] = [];

  constructor(
    private readonly db: D1Database,
    private readonly base: SectSnapshot,
    now: number,
  ) {
    this.config = gameConfig();
    this.now = now;

    const levelDef = findSectLevel(Number(base.sect.level));
    this.discipleCapacity = levelDef.discipleCapacity;
    this.buildingCapacity = levelDef.buildingCapacity;
    this.capacityMultiplier = levelDef.capacityMultiplier;

    const lastSettledAt = Number(base.sect.last_settled_at);
    this.settleResult = settleEconomy({
      config: this.config,
      lastSettledAt,
      now,
      resources: base.balances.map((row) => ({
        resourceId: row.resource_id,
        balance: Number(row.balance),
        remainder: Number(row.remainder),
      })),
      disciples: base.disciples.map((row) => ({
        id: row.id,
        aptitude: Number(row.aptitude),
        realmId: row.realm_id,
        stage: Number(row.stage),
        cultivation: Number(row.cultivation),
        cultivationRemainder: Number(row.cultivation_remainder),
        assignment: row.assignment,
        talent: row.talent,
      })),
      capacityMultiplier: this.capacityMultiplier,
      buildingLevels: Object.fromEntries(base.buildings.map((row) => [row.def_id, row.level])),
    });

    this.sect = { ...base.sect, last_settled_at: this.settleResult.lastSettledAt };
    this.balances = base.balances.map((row) => {
      const settled = this.settleResult.resources.find((item) => item.resourceId === row.resource_id);
      if (settled === undefined) {
        return { ...row };
      }
      return { ...row, balance: settled.balance, remainder: settled.remainder };
    });
    this.disciples = base.disciples.map((row) => {
      const settled = this.settleResult.disciples.find((item) => item.id === row.id);
      if (settled === undefined) {
        return { ...row };
      }
      return { ...row, cultivation: settled.cultivation, cultivation_remainder: settled.cultivationRemainder };
    });
    this.buildings = base.buildings.map((row) => ({ ...row }));

    const dateKey = dateKeyUtc8(now);
    this.recruitUsedToday = base.sect.recruit_date_key === dateKey ? Number(base.sect.recruit_count) : 0;
    this.statements = this.settlementStatements(lastSettledAt);
  }

  /** 结算写回：只写发生变化的行，避免无意义的 UPDATE。 */
  private settlementStatements(previousLastSettledAt: number): ParameterizedQuery[] {
    const statements: ParameterizedQuery[] = [];
    if (this.sect.last_settled_at !== previousLastSettledAt) {
      statements.push(updateSectSettledStatement(this.sect.id, this.sect.last_settled_at));
    }
    for (const [index, row] of this.balances.entries()) {
      const before = this.base.balances[index];
      if (before !== undefined && (before.balance !== row.balance || before.remainder !== row.remainder)) {
        statements.push(
          updateResourceSettledStatement(row, Number(row.balance), Number(row.remainder), this.now),
        );
      }
    }
    for (const [index, row] of this.disciples.entries()) {
      const before = this.base.disciples[index];
      if (
        before !== undefined &&
        (before.cultivation !== row.cultivation || before.cultivation_remainder !== row.cultivation_remainder)
      ) {
        statements.push(
          updateDiscipleCultivationStatement(row.id, Number(row.cultivation), Number(row.cultivation_remainder)),
        );
      }
    }
    // 事件落库：与结算写回、命令写入共用同一次 batch（不单独 await 一次 db.batch/execute）。
    for (const event of this.settleResult.events) {
      statements.push(
        insertEventLogStatement({
          id: event.id,
          sectId: this.sect.id,
          eventId: event.eventId,
          description: event.description,
          effects: JSON.stringify(event.effects),
          now: this.now,
        }),
      );
    }
    return statements;
  }

  balanceOf(resourceId: string): number {
    const row = this.balances.find((item) => item.resource_id === resourceId);
    return row === undefined ? 0 : Number(row.balance);
  }

  resourceName(resourceId: string): string {
    return this.config.resources.find((item) => item.id === resourceId)?.name ?? resourceId;
  }

  /** 资源检查 + 扣减（负 delta），不足时抛 INSUFFICIENT_RESOURCE（带缺少数量）。 */
  requireResource(resourceId: string, amount: number): void {
    const balance = this.balanceOf(resourceId);
    if (balance < amount) {
      throw new AppError('INSUFFICIENT_RESOURCE', `${this.resourceName(resourceId)}不足`, {
        resourceId,
        required: String(amount),
        balance: String(balance),
        lacking: String(amount - balance),
      });
    }
    this.balances = this.balances.map((row) =>
      row.resource_id === resourceId
        ? { ...row, balance: Number(row.balance) - amount, updated_at: this.now }
        : row,
    );
    this.addStatement(resourceDeltaStatement(this.sect.id, resourceId, -amount, this.now));
  }

  addStatement(statement: ParameterizedQuery): void {
    this.statements.push(statement);
  }

  addDisciple(row: DiscipleRow): void {
    this.disciples.push(row);
    this.addStatement(insertDiscipleStatement({
      id: row.id,
      sectId: row.sect_id,
      name: row.name,
      gender: row.gender,
      aptitude: Number(row.aptitude),
      attack: Number(row.attack),
      defense: Number(row.defense),
      speed: Number(row.speed),
      talent: row.talent,
      realmId: row.realm_id,
      stage: Number(row.stage),
      assignment: row.assignment,
      now: this.now,
    }));
  }

  discipleById(discipleId: string): DiscipleRow {
    const disciple = this.disciples.find((item) => item.id === discipleId);
    if (disciple === undefined) {
      throw new AppError('NOT_FOUND', '弟子不存在');
    }
    return disciple;
  }

  buildingByDefId(defId: string): BuildingRow {
    const building = this.buildings.find((item) => item.def_id === defId);
    if (building === undefined) {
      throw new AppError('NOT_FOUND', '建筑不存在');
    }
    return building;
  }

  view(): SectStateView {
    // 容量/上限按「当前（可能刚升级的）等级」现算：upgradeSect 之后的同一请求里返回的
    // state 就已经是新倍率/新上限，不需要等下一次 sync。
    const levelDef = findSectLevel(Number(this.sect.level));
    return buildSectStateView({
      config: this.config,
      sect: this.sect,
      disciples: this.disciples,
      buildings: this.buildings,
      balances: this.balances,
      settleResult: this.settleResult,
      now: this.now,
      recruitUsedToday: this.recruitUsedToday,
      recentEventRows: this.base.recentEvents,
      capacityMultiplier: levelDef.capacityMultiplier,
    });
  }

  async commit(): Promise<void> {
    if (this.statements.length === 0) {
      return;
    }
    await this.db.batch(prepareStatements(this.db, this.statements));
  }
}

async function draftFor(db: D1Database, userId: string, now: number): Promise<SectDraft> {
  const snapshot = await loadSnapshot(db, userId);
  if (snapshot === null) {
    throw new AppError('NOT_FOUND', '尚未创建宗门');
  }
  return new SectDraft(db, snapshot, now);
}

/** 读宗门状态：没有宗门返回 null（前端据此显示创建宗门）。 */
export async function getSectState(
  db: D1Database,
  userId: string,
  now: number,
): Promise<SectStateView | null> {
  const snapshot = await loadSnapshot(db, userId);
  if (snapshot === null) {
    return null;
  }
  const draft = new SectDraft(db, snapshot, now);
  await draft.commit();
  return draft.view();
}

/** 创建宗门：初始弟子/建筑/资源按配置一次写入。 */
export async function createSect(
  db: D1Database,
  userId: string,
  name: string,
  now: number,
): Promise<SectStateView> {
  const config = gameConfig();
  const existing = await new SectRepository(db).findByUserId(userId);
  if (existing !== null) {
    throw new AppError('STATE_CONFLICT', '你已经创建过宗门');
  }

  const sectId = crypto.randomUUID();
  const statements: ParameterizedQuery[] = [
    insertSectStatement({
      id: sectId,
      userId,
      name,
      level: config.sect.initialLevel,
      veinLevel: config.sect.initialVeinLevel,
      now,
    }),
  ];

  const disciples: DiscipleRow[] = config.sect.initialDisciples.map((template) => {
    const row: DiscipleRow = {
      id: crypto.randomUUID(),
      sect_id: sectId,
      name: randomDiscipleName(),
      gender: randomGender(),
      aptitude: randomAptitude(),
      // 初始弟子只生成一次，属性/天赋用 Math.random 版本即可（V4 第八节）。
      attack: randomAptitude(),
      defense: randomAptitude(),
      speed: randomAptitude(),
      talent: generateTalent(Math.random),
      realm_id: template.realm,
      stage: template.stage,
      cultivation: 0,
      cultivation_remainder: 0,
      assignment: template.assignment,
      injured_until: null,
      created_at: now,
    };
    statements.push(
      insertDiscipleStatement({
        id: row.id,
        sectId,
        name: row.name,
        gender: row.gender,
        aptitude: row.aptitude,
        attack: row.attack,
        defense: row.defense,
        speed: row.speed,
        talent: row.talent,
        realmId: row.realm_id,
        stage: row.stage,
        assignment: row.assignment,
        now,
      }),
    );
    return row;
  });

  const buildings: BuildingRow[] = config.sect.initialBuildings.map((template) => {
    const row: BuildingRow = {
      id: crypto.randomUUID(),
      sect_id: sectId,
      def_id: template.defId,
      level: template.level,
      created_at: now,
    };
    statements.push(
      insertBuildingStatement({ id: row.id, sectId, defId: row.def_id, level: row.level, now }),
    );
    return row;
  });

  const balances: ResourceBalanceRow[] = config.resources.map((resource) => {
    const row: ResourceBalanceRow = {
      id: crypto.randomUUID(),
      sect_id: sectId,
      resource_id: resource.id,
      balance: Number(resource.startAmount),
      remainder: 0,
      updated_at: now,
    };
    statements.push(
      insertResourceBalanceStatement({
        id: row.id,
        sectId,
        resourceId: row.resource_id,
        balance: row.balance,
        remainder: 0,
        now,
      }),
    );
    return row;
  });

  await db.batch(prepareStatements(db, statements));

  const draft = new SectDraft(
    db,
    {
      sect: {
        id: sectId,
        user_id: userId,
        name,
        level: config.sect.initialLevel,
        vein_level: config.sect.initialVeinLevel,
        reputation: 0,
        last_settled_at: now,
        recruit_date_key: dateKeyUtc8(now),
        recruit_count: 0,
        created_at: now,
      },
      disciples,
      buildings,
      balances,
      recentEvents: [],
    },
    now,
  );
  return draft.view();
}

/** 招募候选人预览（GET /game/recruit-preview 的 data）。 */
export interface RecruitPreview {
  candidates: RecruitCandidate[];
  canRecruit: boolean;
  blockedReason: string | null;
  cost: Record<string, string>;
}

/** 招募判定文案（预览与招募共用）：null = 可以招募。 */
function recruitBlockedReason(input: {
  config: GameConfigContent;
  discipleCount: number;
  discipleCapacity: number;
  recruitUsedToday: number;
  balanceOf: (resourceId: string) => number;
}): string | null {
  const { config, discipleCount, discipleCapacity, recruitUsedToday, balanceOf } = input;
  if (discipleCount >= discipleCapacity) {
    return '弟子上限已满';
  }
  if (recruitUsedToday >= config.recruitment.dailyLimit) {
    return '今日招募次数已用完';
  }
  const lacking = Object.entries(config.recruitment.cost).find(
    ([resourceId, amount]) => balanceOf(resourceId) < Number(amount),
  );
  if (lacking !== undefined) {
    const resourceName =
      config.resources.find((resource) => resource.id === lacking[0])?.name ?? lacking[0];
    return `${resourceName}不足`;
  }
  return null;
}

/**
 * 招募预览（V4 5.4）：**只读快照，不做结算**——与排行榜同理，预览不该有副作用
 * （否则长离线后打开一次弹窗就触发了结算与随机事件）。
 *
 * 候选人与 recruitDisciple 用完全相同的 seed 生成（宗门 id + UTC+8 自然日 +
 * 「今日已招募次数」），因此「预览 → 招募」拿到的是同一批人；招募成功后该计数 +1，
 * 下一次打开预览就是新的一批。
 */
export async function previewRecruit(
  db: D1Database,
  userId: string,
  now: number,
): Promise<RecruitPreview> {
  const config = gameConfig();
  const sect = await new SectRepository(db).findByUserId(userId);
  if (sect === null) {
    throw new AppError('NOT_FOUND', '尚未创建宗门');
  }
  const [disciples, balances] = await Promise.all([
    new DiscipleRepository(db).findBySectId(sect.id),
    new ResourceBalanceRepository(db).findBySectId(sect.id),
  ]);

  const dateKey = dateKeyUtc8(now);
  // 与 SectDraft 的 recruitUsedToday 同一归一逻辑：日期 key 不匹配时视为 0（跨天重置）。
  const recruitUsedToday = sect.recruit_date_key === dateKey ? Number(sect.recruit_count) : 0;
  const discipleCapacity = findSectLevel(Number(sect.level)).discipleCapacity;

  const blockedReason = recruitBlockedReason({
    config,
    discipleCount: disciples.length,
    discipleCapacity,
    recruitUsedToday,
    balanceOf: (resourceId) =>
      Number(balances.find((row) => row.resource_id === resourceId)?.balance ?? 0),
  });

  return {
    candidates: generateCandidates(sect.id, dateKey, recruitUsedToday),
    canRecruit: blockedReason === null,
    blockedReason,
    cost: { ...config.recruitment.cost },
  };
}

/**
 * 招募三选一（V4 5.4）：结算 → 检查次数/上限/资源 → 取确定性候选人 `choice` →
 * 扣灵石 + 新建弟子 + 更新计数（**只有一次** `commit()`，单次 D1 batch）。
 */
export async function recruitDisciple(
  db: D1Database,
  userId: string,
  choice: number,
  now: number,
): Promise<{
  state: SectStateView;
  outcome: {
    discipleName: string;
    aptitude: number;
    attack: number;
    defense: number;
    speed: number;
    talent: string;
    talentName: string;
  };
}> {
  const draft = await draftFor(db, userId, now);
  const { config } = draft;

  if (draft.disciples.length >= draft.discipleCapacity) {
    throw new AppError('CAPACITY_FULL', '弟子已满，先升级宗门或遣散弟子（本版本暂不支持遣散）');
  }
  if (draft.recruitUsedToday >= config.recruitment.dailyLimit) {
    throw new AppError('DAILY_LIMIT', '今日招募次数已用完', {
      dailyLimit: config.recruitment.dailyLimit,
    });
  }

  for (const [resourceId, amount] of Object.entries(config.recruitment.cost)) {
    draft.requireResource(resourceId, Number(amount));
  }

  // 与 previewRecruit 同 seed、同顺序生成：预览里第 N 张卡就是这里的 candidates[N]。
  // schema 已把 choice 限制在 0~2，这里再兜一层，越界直接报错而不是写入脏数据。
  const candidates = generateCandidates(draft.sect.id, dateKeyUtc8(now), draft.recruitUsedToday);
  const candidate = candidates[choice];
  if (candidate === undefined) {
    throw new AppError('VALIDATION_ERROR', '候选人不存在', { choice });
  }

  const disciple: DiscipleRow = {
    id: crypto.randomUUID(),
    sect_id: draft.sect.id,
    name: candidate.name,
    gender: candidate.gender,
    aptitude: candidate.aptitude,
    attack: candidate.attack,
    defense: candidate.defense,
    speed: candidate.speed,
    talent: candidate.talent,
    realm_id: 'qiRefining',
    stage: 1,
    cultivation: 0,
    cultivation_remainder: 0,
    assignment: IDLE_ASSIGNMENT,
    injured_until: null,
    created_at: now,
  };
  draft.addDisciple(disciple);
  draft.addStatement(
    updateSectRecruitCounterStatement(draft.sect.id, dateKeyUtc8(now), draft.recruitUsedToday + 1),
  );
  draft.sect.recruit_date_key = dateKeyUtc8(now);
  draft.sect.recruit_count = draft.recruitUsedToday + 1;

  await draft.commit();
  return {
    state: draft.view(),
    outcome: {
      discipleName: disciple.name,
      aptitude: Number(disciple.aptitude),
      attack: Number(disciple.attack),
      defense: Number(disciple.defense),
      speed: Number(disciple.speed),
      talent: disciple.talent,
      talentName: candidate.talentName,
    },
  };
}

/** 派工：结算 → 校验岗位 → 更新弟子岗位。 */
export async function assignDisciple(
  db: D1Database,
  userId: string,
  discipleId: string,
  assignment: string,
  now: number,
): Promise<SectStateView> {
  const draft = await draftFor(db, userId, now);
  const validAssignments = new Set<string>([
    IDLE_ASSIGNMENT,
    ...draft.config.positions.map((position) => position.id),
  ]);
  if (!validAssignments.has(assignment)) {
    throw new AppError('VALIDATION_ERROR', '未知岗位', { assignment });
  }

  const disciple = draft.discipleById(discipleId);
  const nextAssignment = assignment;
  draft.addStatement(updateDiscipleAssignmentStatement(disciple.id, nextAssignment));
  disciple.assignment = nextAssignment;

  await draft.commit();
  return draft.view();
}

/** 升级建筑：结算 → 检查等级上限与资源 → 扣资源 + 等级 +1。 */
export async function upgradeBuilding(
  db: D1Database,
  userId: string,
  defId: string,
  now: number,
): Promise<SectStateView> {
  const draft = await draftFor(db, userId, now);
  const building = draft.buildingByDefId(defId);
  const definition = draft.config.buildings.find((item) => item.id === defId);
  if (definition === undefined) {
    throw new AppError('NOT_FOUND', '建筑未在配置中定义');
  }
  if (building.level >= definition.maxLevel) {
    throw new AppError('INVALID_STATUS', `${definition.name}已达最高等级`, {
      maxLevel: definition.maxLevel,
    });
  }

  const cost = upgradeCost(definition.upgradeCostPerLevel, building.level);
  for (const [resourceId, amount] of Object.entries(cost)) {
    draft.requireResource(resourceId, Number(amount));
  }

  const nextLevel = building.level + 1;
  draft.addStatement(updateBuildingLevelStatement(building.id, nextLevel));
  building.level = nextLevel;

  await draft.commit();
  return draft.view();
}

export interface BreakthroughOutcome {
  discipleId: string;
  discipleName: string;
  success: boolean;
  chanceBp: number;
  roll: number;
  message: string;
}

/** 突破：结算 → 门槛/冷却/灵气检查 → 扣灵气 → 抽一次随机。 */
export async function breakthrough(
  db: D1Database,
  userId: string,
  discipleId: string,
  now: number,
): Promise<{ state: SectStateView; outcome: BreakthroughOutcome }> {
  const draft = await draftFor(db, userId, now);
  const disciple = draft.discipleById(discipleId);
  const { config } = draft;

  const stage = findStage(disciple.realm_id, disciple.stage);
  if (stage.requiredCultivation === null) {
    throw new AppError('INVALID_STATUS', '已达本版本最高境界');
  }
  if (disciple.injured_until !== null && Number(disciple.injured_until) > now) {
    const remainingSeconds = Math.ceil((Number(disciple.injured_until) - now) / 1000);
    throw new AppError('COOLDOWN_ACTIVE', '突破失败后的调息尚未结束', { remainingSeconds });
  }
  if (Number(disciple.cultivation) < stage.requiredCultivation) {
    throw new AppError('INVALID_STATUS', '修为不足，先让弟子修炼', {
      required: stage.requiredCultivation,
      cultivation: Number(disciple.cultivation),
    });
  }

  const cost = breakthroughEnergyCost(disciple.stage);
  draft.requireResource('spiritualEnergy', cost);

  const arrayLevel =
    draft.buildings.find((building) => building.def_id === SPIRITUAL_ARRAY_BUILDING_ID)?.level ?? 0;
  const chanceBp = breakthroughChanceBp(config, arrayLevel);
  const roll = Math.floor(Math.random() * 10_000);
  const success = roll < chanceBp;

  if (success) {
    const next = nextStageOf(disciple.realm_id, disciple.stage);
    if (next === null) {
      throw new AppError('INVALID_STATUS', '已达本版本最高境界');
    }
    draft.addStatement(
      updateDiscipleProgressStatement(disciple.id, {
        realmId: next.realmId,
        stage: next.stage,
        cultivation: 0,
        remainder: 0,
        injuredUntil: null,
      }),
    );
    disciple.realm_id = next.realmId;
    disciple.stage = next.stage;
    disciple.cultivation = 0;
    disciple.cultivation_remainder = 0;
    disciple.injured_until = null;
  } else {
    const kept = Math.floor((stage.requiredCultivation * config.breakthrough.failureKeepBp) / 10_000);
    const injuredUntil = now + config.breakthrough.cooldownSeconds * 1000;
    draft.addStatement(
      updateDiscipleProgressStatement(disciple.id, {
        realmId: disciple.realm_id,
        stage: disciple.stage,
        cultivation: kept,
        remainder: 0,
        injuredUntil,
      }),
    );
    disciple.cultivation = kept;
    disciple.cultivation_remainder = 0;
    disciple.injured_until = injuredUntil;
  }

  await draft.commit();
  return {
    state: draft.view(),
    outcome: {
      discipleId: disciple.id,
      discipleName: disciple.name,
      success,
      chanceBp,
      roll,
      message: success
        ? `${disciple.name} 突破成功，境界提升`
        : `${disciple.name} 突破失败，修为跌落（保留 ${String(
            Math.floor((stage.requiredCultivation * config.breakthrough.failureKeepBp) / 10_000),
          )}）`,
    },
  };
}

/**
 * 升级宗门：结算 → 条件判定（资源/建筑/弟子境界）→ 扣资源 + 提级 + 解锁新建筑（一次 batch）。
 *
 * 条件全部来自 SECT_LEVELS（数据），这里只做判定与报错；容量/上限在 view() 里按新等级现算。
 */
export async function upgradeSect(
  db: D1Database,
  userId: string,
  now: number,
): Promise<SectStateView> {
  const draft = await draftFor(db, userId, now);
  const next = nextSectLevel(Number(draft.sect.level));
  if (next === null) {
    throw new AppError('INVALID_STATUS', '宗门已达最高品阶');
  }

  // 1. 资源条件：不足时 requireResource 抛 INSUFFICIENT_RESOURCE（带缺少数量），满足则直接扣减。
  for (const [resourceId, amount] of Object.entries(next.upgradeCost)) {
    draft.requireResource(resourceId, Number(amount));
  }

  // 2. 建筑条件
  for (const requirement of next.buildingRequirements) {
    const building = draft.buildings.find((row) => row.def_id === requirement.defId);
    const buildingName =
      draft.config.buildings.find((item) => item.id === requirement.defId)?.name ??
      requirement.defId;
    if (building === undefined || building.level < requirement.minLevel) {
      throw new AppError(
        'INVALID_STATUS',
        `${buildingName}需要 ${requirement.minLevel} 级（当前 ${building?.level ?? 0} 级）`,
      );
    }
  }

  // 3. 弟子境界条件
  for (const requirement of next.discipleRequirements) {
    const requiredRealmIndex = realmIndex(requirement.minRealmId);
    const qualified = draft.disciples.filter(
      (disciple) => realmIndex(disciple.realm_id) >= requiredRealmIndex,
    ).length;
    if (qualified < requirement.count) {
      const realmName = findRealm(requirement.minRealmId).name;
      throw new AppError(
        'INVALID_STATUS',
        `需要 ${requirement.count} 名${realmName}及以上弟子（当前 ${qualified} 名）`,
      );
    }
  }

  // 4. 提级
  draft.sect.level = next.level;
  draft.addStatement(updateSectLevelStatement(draft.sect.id, next.level));

  // 5. 自动解锁（创建）本等级带来的新建筑；已存在则跳过，避免重复建筑行。
  for (const defId of next.unlockBuildings) {
    if (draft.buildings.some((row) => row.def_id === defId)) {
      continue;
    }
    const buildingRow: BuildingRow = {
      id: crypto.randomUUID(),
      sect_id: draft.sect.id,
      def_id: defId,
      level: 1,
      created_at: now,
    };
    draft.buildings.push(buildingRow);
    draft.addStatement(
      insertBuildingStatement({
        id: buildingRow.id,
        sectId: draft.sect.id,
        defId,
        level: 1,
        now,
      }),
    );
  }

  await draft.commit();
  return draft.view();
}

/**
 * 读最近事件（GET /game/events）：只查库即可（本次请求没有结算，不产生新事件）。
 * 没有宗门时返回空列表，避免在创建宗门页误报错。
 */
export async function listRecentEvents(db: D1Database, userId: string): Promise<EventLogView[]> {
  const sect = await new SectRepository(db).findByUserId(userId);
  if (sect === null) {
    return [];
  }
  const rows = await new EventLogRepository(db).findRecentBySectId(sect.id, EVENT_HISTORY_LIMIT);
  return rows.map(eventLogViewFromRow);
}

/**
 * 探索秘境（V2-2 第五、八节）：结算 → 逐项校验 → 扣入场费 → 一次随机判定 → 发奖 / 弟子受伤。
 *
 * 校验顺序（全部失败都在任何写库之前抛出，见下方说明）：
 *   1. 秘境 id 存在（NOT_FOUND）
 *   2. 宗门等级 >= 秘境要求（INVALID_STATUS）
 *   3. 已建造演武场（INVALID_STATUS）
 *   4. 队伍人数在 [minParty, maxParty]（VALIDATION_ERROR）
 *   5. 队伍无重复弟子（VALIDATION_ERROR）
 *   6. 每个弟子存在、且不在疗伤冷却中（NOT_FOUND / INVALID_STATUS）
 *   7. 每日次数未用完（DAILY_LIMIT，按 UTC+8 自然日窗口统计）
 *   8. 入场费足够（INSUFFICIENT_RESOURCE，由 draft.requireResource 扣减）
 *
 * 写回：结算写回 + 入场费扣减 + （成功时）奖励 + （失败时）弟子伤势 + 探索记录，
 * 全部挂在同一个 draft 上，最后只做**一次** `draft.commit()`（单次 D1 batch）。
 * 也就是说任何一步抛错都不会产生半写：进程内的内存状态丢弃，DB 未被触碰。
 *
 * 奖励按文档原样直接加到余额，**不夹容量上限**（与结算里的 room 截断规则不同，这是任务文档
 * 给定的行为）：余额可能因此超过容量，下一次结算的 room=0（或低于容量）会丢弃产出的那部分。
 */
export async function exploreSectRealm(
  db: D1Database,
  userId: string,
  realmId: string,
  discipleIds: string[],
  now: number,
): Promise<{ state: SectStateView; result: ExplorationResultView }> {
  const draft = await draftFor(db, userId, now);
  const realm = findSecretRealm(realmId);
  if (!realm) {
    throw new AppError('NOT_FOUND', '秘境不存在');
  }

  // 1. 宗门等级检查
  if (Number(draft.sect.level) < realm.requiredSectLevel) {
    throw new AppError('INVALID_STATUS', `需要宗门 ${realm.requiredSectLevel} 级才能进入`);
  }

  // 2. 演武场检查：宗门必须有演武场才能探索（V2-1 在 4 级解锁）
  const arena = draft.buildings.find((b) => b.def_id === ARENA_BUILDING_ID);
  if (!arena) {
    throw new AppError('INVALID_STATUS', '需要先建造演武场');
  }

  // 3. 队伍人数检查
  if (discipleIds.length < realm.minParty || discipleIds.length > realm.maxParty) {
    throw new AppError('VALIDATION_ERROR', `需要 ${realm.minParty}~${realm.maxParty} 名弟子`);
  }

  // 4. 去重检查
  if (new Set(discipleIds).size !== discipleIds.length) {
    throw new AppError('VALIDATION_ERROR', '不能派遣重复弟子');
  }

  // 5. 弟子存在性与状态检查（不能是受伤弟子）
  const members: {
    realmId: string;
    stage: number;
    attack: number;
    defense: number;
    speed: number;
    talent: string;
    name: string;
  }[] = [];
  for (const id of discipleIds) {
    const disciple = draft.discipleById(id);
    if (disciple.injured_until !== null && Number(disciple.injured_until) > now) {
      throw new AppError('INVALID_STATUS', `${disciple.name}正在疗伤，无法出战`);
    }
    members.push({
      realmId: disciple.realm_id,
      stage: Number(disciple.stage),
      attack: Number(disciple.attack),
      defense: Number(disciple.defense),
      speed: Number(disciple.speed),
      talent: disciple.talent,
      name: disciple.name,
    });
  }

  // 6. 每日次数检查（独立的 DB 读取，不参与 draft 的 batch）
  if (realm.dailyLimit !== null) {
    const dayStart = dayStartMs(now);
    const used = await new ExplorationRepository(db).countTodayBySectAndRealm(
      draft.sect.id,
      realmId,
      dayStart,
    );
    if (used >= realm.dailyLimit) {
      throw new AppError('DAILY_LIMIT', `今日${realm.name}探索次数已用完（${realm.dailyLimit}次/天）`);
    }
  }

  // 7. 扣资源（入场费）
  for (const [resourceId, amount] of Object.entries(realm.entryCost)) {
    draft.requireResource(resourceId, Number(amount));
  }

  // 8. 计算战力与成功率
  const power = partyCombatPower(members);
  const arenaLevel = arena.level;
  const chanceBp = explorationSuccessChanceBp(power, realm.difficulty, arenaLevel);
  const roll = Math.floor(Math.random() * 10_000);
  const success = roll < chanceBp;

  // 9. 成功：发放奖励（不夹容量上限，见函数头说明）
  const actualRewards: Record<string, string> = {};
  if (success) {
    for (const [resourceId, amount] of Object.entries(realm.rewards)) {
      draft.addStatement(resourceDeltaStatement(draft.sect.id, resourceId, Number(amount), now));
      draft.balances = draft.balances.map((row) =>
        row.resource_id === resourceId
          ? { ...row, balance: Number(row.balance) + Number(amount), updated_at: now }
          : row,
      );
      actualRewards[resourceId] = amount;
    }
  }

  // 10. 失败：队伍里所有弟子受伤（冷却 10 分钟）；只改 injured_until，不碰境界/修为
  const INJURY_DURATION_MS = 10 * 60 * 1000;
  if (!success) {
    for (const id of discipleIds) {
      const injuredUntil = now + INJURY_DURATION_MS;
      draft.addStatement(updateDiscipleInjuryStatement(id, injuredUntil));
      const disciple = draft.disciples.find((item) => item.id === id);
      if (disciple !== undefined) {
        disciple.injured_until = injuredUntil;
      }
    }
  }

  // 11. 写入探索记录
  const explorationId = crypto.randomUUID();
  draft.addStatement(
    insertExplorationStatement({
      id: explorationId,
      sectId: draft.sect.id,
      realmId,
      party: JSON.stringify(discipleIds),
      success,
      rewards: JSON.stringify(actualRewards),
      now,
    }),
  );

  await draft.commit();
  return {
    state: draft.view(),
    result: {
      realmName: realm.name,
      success,
      chanceBp,
      roll,
      rewards: actualRewards,
      memberNames: members.map((m) => m.name),
      message: success
        ? `探索${realm.name}成功！获得丰厚奖励。`
        : `探索${realm.name}失败，弟子受伤需疗养。`,
    },
  };
}

/**
 * 秘境列表（V2-2 第六节）：只读，不结算、不写库。
 * 没有宗门时返回空列表（与 GET /game/events 一致，避免创建宗门页误报错）。
 */
export async function listSecretRealms(
  db: D1Database,
  userId: string,
  now: number,
): Promise<SecretRealmListView[]> {
  const snapshot = await loadSnapshot(db, userId);
  if (snapshot === null) {
    return [];
  }

  const sectLevel = Number(snapshot.sect.level);
  const dayStart = dayStartMs(now);
  const arena = snapshot.buildings.find((b) => b.def_id === ARENA_BUILDING_ID);
  const views: SecretRealmListView[] = [];

  for (const realm of SECRET_REALMS) {
    const locked = sectLevel < realm.requiredSectLevel;
    let usedToday = 0;
    if (realm.dailyLimit !== null && !locked) {
      usedToday = await new ExplorationRepository(db).countTodayBySectAndRealm(
        snapshot.sect.id,
        realm.id,
        dayStart,
      );
    }
    views.push({
      id: realm.id,
      name: realm.name,
      description: realm.description,
      difficulty: realm.difficulty,
      entryCost: realm.entryCost,
      rewards: realm.rewards,
      minParty: realm.minParty,
      maxParty: realm.maxParty,
      dailyLimit: realm.dailyLimit,
      usedToday,
      requiredSectLevel: realm.requiredSectLevel,
      locked,
      hasArena: arena !== undefined,
    });
  }
  return views;
}

/** 每日切磋总次数上限（V3 第四节；同一目标另有每日 1 次限制）。 */
const SPARRING_DAILY_LIMIT = 5;

/** 切磋奖励（最小单位）：只有胜利发放。 */
const SPARRING_WIN_REPUTATION = 10;
const SPARRING_WIN_SPIRIT_STONE = 5_000;

/** 实际战力 = 基础战力 × (0.85 ~ 1.15)（V3 第 4.2 节）。 */
function fluctuatedPower(basePower: number): number {
  return Math.floor(basePower * (0.85 + Math.random() * 0.3));
}

/** 镇派弟子：境界（realmIndex）→ 阶段 → 资质逐级比较取最高；没有弟子返回 null。 */
function topDiscipleOf(disciples: readonly DiscipleRow[]): LeaderboardEntryView['topDisciple'] {
  let best: DiscipleRow | null = null;
  for (const disciple of disciples) {
    if (
      best === null ||
      realmIndex(disciple.realm_id) > realmIndex(best.realm_id) ||
      (realmIndex(disciple.realm_id) === realmIndex(best.realm_id) &&
        (Number(disciple.stage) > Number(best.stage) ||
          (Number(disciple.stage) === Number(best.stage) &&
            Number(disciple.aptitude) > Number(best.aptitude))))
    ) {
      best = disciple;
    }
  }
  if (best === null) {
    return null;
  }
  return {
    name: best.name,
    realmName: findRealm(best.realm_id).name,
    stageName: findStage(best.realm_id, Number(best.stage)).name,
  };
}

/**
 * 江湖榜（V3 第二节）：综合榜，只读、不结算、不写库。
 *
 * 排序由 SQL 决定（等级 DESC → 声望 DESC → 创建时间 ASC，见 SectRepository.findAll）；
 * 3~5 个宗门不优化查询，逐个宗门查弟子列表找镇派弟子。
 */
export async function listLeaderboard(
  db: D1Database,
  userId: string,
): Promise<LeaderboardEntryView[]> {
  const sectRepository = new SectRepository(db);
  const discipleRepository = new DiscipleRepository(db);
  const [sects, mySect] = await Promise.all([
    sectRepository.findAll(),
    sectRepository.findByUserId(userId),
  ]);
  const mySectId = mySect?.id ?? null;

  const entries: LeaderboardEntryView[] = [];
  for (const sect of sects) {
    const disciples = await discipleRepository.findBySectId(sect.id);
    entries.push({
      sectId: sect.id,
      name: sect.name,
      level: Number(sect.level),
      levelName: findSectLevel(Number(sect.level)).name,
      reputation: Number(sect.reputation) || 0,
      discipleCount: disciples.length,
      topDisciple: topDiscipleOf(disciples),
      isMe: sect.id === mySectId,
    });
  }
  return entries;
}

/**
 * 公开档案（V3 第三节）：只读、不结算、不写库。
 *
 * 只返回安全字段——**不含**资源余额、弟子修为/岗位/伤势、建筑升级消耗与招募计数；
 * 宗门不存在抛 NOT_FOUND。
 */
export async function getPublicSect(db: D1Database, sectId: string): Promise<PublicSectView> {
  const sect = await new SectRepository(db).findById(sectId);
  if (sect === null) {
    throw new AppError('NOT_FOUND', '宗门不存在');
  }

  const [disciples, buildings] = await Promise.all([
    new DiscipleRepository(db).findBySectId(sectId),
    new BuildingRepository(db).findBySectId(sectId),
  ]);
  const config = gameConfig();

  return {
    sectId: sect.id,
    name: sect.name,
    level: Number(sect.level),
    levelName: findSectLevel(Number(sect.level)).name,
    reputation: Number(sect.reputation) || 0,
    disciples: disciples.map((disciple) => ({
      id: disciple.id,
      name: disciple.name,
      gender: disciple.gender,
      aptitude: Number(disciple.aptitude),
      attack: Number(disciple.attack),
      defense: Number(disciple.defense),
      speed: Number(disciple.speed),
      talent: disciple.talent,
      talentName: findTalent(disciple.talent)?.name ?? '无',
      realmName: findRealm(disciple.realm_id).name,
      stageName: findStage(disciple.realm_id, Number(disciple.stage)).name,
    })),
    buildings: buildings.map((building) => ({
      name: config.buildings.find((item) => item.id === building.def_id)?.name ?? building.def_id,
      level: Number(building.level),
    })),
    createdAt: new Date(Number(sect.created_at)).toISOString(),
  };
}

/**
 * 切磋（V3 第 4.3 节）：结算 → 逐项校验 → 战力浮动判定 → 胜利发奖 + 写切磋记录。
 *
 * 校验顺序（全部失败都在任何写库之前抛出）：
 *   1. 自己的宗门快照（draftFor，顺带结算）
 *   2. 目标宗门存在（NOT_FOUND）
 *   3. 不能打自己（VALIDATION_ERROR）
 *   4. 今日切磋总次数 < 5（DAILY_LIMIT，UTC+8 自然日窗口）
 *   5. 今日未与同一目标切磋过（DAILY_LIMIT）
 *   6. 攻方弟子存在 + 不在疗伤中（NOT_FOUND / INVALID_STATUS）
 *   7. 防方弟子存在且属于目标宗门（NOT_FOUND）；**不**检查防方伤势
 *   8. 双方战力（基础战力 ±15% 浮动）→ > 胜、< 负、== 平
 *   9. 胜利：声望 +10、灵石 +5000（写库语句 + 内存状态一起更新）
 *  10. 写 sparring_log
 *  11. 只做**一次** `draft.commit()`，返回 state + 切磋结果
 *
 * 也就是说任何一步抛错都不会产生半写：内存状态丢弃、DB 未被触碰。
 */
export async function sparWithSect(
  db: D1Database,
  userId: string,
  targetSectId: string,
  myDiscipleId: string,
  targetDiscipleId: string,
  now: number,
): Promise<{ state: SectStateView; result: SparResultView }> {
  const draft = await draftFor(db, userId, now);

  const targetSect = await new SectRepository(db).findById(targetSectId);
  if (targetSect === null) {
    throw new AppError('NOT_FOUND', '对方宗门不存在');
  }
  if (targetSect.id === draft.sect.id) {
    throw new AppError('VALIDATION_ERROR', '不能切磋自己的宗门');
  }

  const dayStart = dayStartMs(now);
  const sparring = new SparringRepository(db);
  if ((await sparring.countTodayByAttacker(draft.sect.id, dayStart)) >= SPARRING_DAILY_LIMIT) {
    throw new AppError('DAILY_LIMIT', `今日切磋次数已用完（${SPARRING_DAILY_LIMIT} 次/天）`);
  }
  if ((await sparring.countTodayByPair(draft.sect.id, targetSect.id, dayStart)) >= 1) {
    throw new AppError('DAILY_LIMIT', `今日已与${targetSect.name}切磋过（同一目标每日 1 次）`);
  }

  const myDisciple = draft.discipleById(myDiscipleId);
  if (myDisciple.injured_until !== null && Number(myDisciple.injured_until) > now) {
    throw new AppError('INVALID_STATUS', `${myDisciple.name}正在疗伤，无法出战`);
  }

  // 防方弟子只校验存在性与归属：受伤状态不影响防方（V3 第 4.1 节）。
  const targetDisciple = await new DiscipleRepository(db).findById(targetDiscipleId);
  if (targetDisciple === null || targetDisciple.sect_id !== targetSect.id) {
    throw new AppError('NOT_FOUND', '对方弟子不存在');
  }

  const myPower = fluctuatedPower(
    discipleCombatPower(
      myDisciple.realm_id,
      Number(myDisciple.stage),
      Number(myDisciple.attack),
      Number(myDisciple.defense),
      Number(myDisciple.speed),
      myDisciple.talent,
    ),
  );
  const targetPower = fluctuatedPower(
    discipleCombatPower(
      targetDisciple.realm_id,
      Number(targetDisciple.stage),
      Number(targetDisciple.attack),
      Number(targetDisciple.defense),
      Number(targetDisciple.speed),
      targetDisciple.talent,
    ),
  );
  const result: SparResultView['result'] =
    myPower > targetPower ? 'win' : myPower < targetPower ? 'lose' : 'draw';

  const reputationGained = result === 'win' ? SPARRING_WIN_REPUTATION : 0;
  const spiritStoneGained = result === 'win' ? SPARRING_WIN_SPIRIT_STONE : 0;
  if (result === 'win') {
    draft.addStatement(updateSectReputationStatement(draft.sect.id, reputationGained));
    draft.addStatement(
      resourceDeltaStatement(draft.sect.id, 'spiritStone', spiritStoneGained, now),
    );
    // 内存状态同步更新：本次返回的 state 里就是新声望 / 新灵石余额。
    draft.sect.reputation = (Number(draft.sect.reputation) || 0) + reputationGained;
    draft.balances = draft.balances.map((row) =>
      row.resource_id === 'spiritStone'
        ? { ...row, balance: Number(row.balance) + spiritStoneGained, updated_at: now }
        : row,
    );
  }

  draft.addStatement(
    insertSparringLogStatement({
      id: crypto.randomUUID(),
      attackerSectId: draft.sect.id,
      defenderSectId: targetSect.id,
      attackerDiscipleId: myDisciple.id,
      defenderDiscipleId: targetDisciple.id,
      attackerPower: myPower,
      defenderPower: targetPower,
      result,
      reputationGained,
      now,
    }),
  );

  // 唯一的一次 commit：结算写回 + 奖励 + 切磋记录同一个 batch。
  await draft.commit();
  return {
    state: draft.view(),
    result: {
      myDiscipleName: myDisciple.name,
      targetDiscipleName: targetDisciple.name,
      targetSectName: targetSect.name,
      myPower,
      targetPower,
      result,
      reputationGained,
      spiritStoneGained,
      message: sparMessage(result, myDisciple.name, targetDisciple.name, spiritStoneGained),
    },
  };
}

/** 切磋结果文案（胜/负/平）。 */
function sparMessage(
  result: SparResultView['result'],
  myName: string,
  targetName: string,
  spiritStoneGained: number,
): string {
  if (result === 'win') {
    return `${myName} 击败了 ${targetName}，宗门声望 +${SPARRING_WIN_REPUTATION}，获得灵石 ${String(
      spiritStoneGained,
    )}`;
  }
  if (result === 'lose') {
    return `${myName} 不敌 ${targetName}，切磋落败（无损失）`;
  }
  return `${myName} 与 ${targetName} 战成平手`;
}
