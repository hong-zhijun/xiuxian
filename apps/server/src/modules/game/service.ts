import type { GameConfigContent } from '@xiuxian/game-core';

import { validatedGameConfig } from '../../config/loadGameConfig';
import { AppError } from '../../http/appError';
import { prepareStatements, type ParameterizedQuery } from '../../infra/db/repository';
import {
  alchemyUnlockBlockedReason,
  bodyTemperingTarget,
  findPillRecipe,
  BODY_TEMPERING_MAX_USES,
  CULTIVATION_PILL_GAIN,
  type PillAttribute,
  type PillId,
  type PillRecipe,
} from './alchemy';
import {
  CHALLENGE_DAILY_LIMIT,
  asDefenseMode,
  asRewardTier,
  challengeDayStateOf,
  planDefenseLineup,
  rewardTierForLevelDifference,
  shufflePick,
  type ChallengeDayState,
  type DefenseMode,
} from './challenge';
import {
  DEFENSE_LINEUP_SIZE,
  IDLE_ASSIGNMENT,
  RECRUIT_REFRESH_PER_LEVEL,
  SPIRITUAL_ARRAY_BUILDING_ID,
  STONE_MINING_ASSIGNMENT,
  STONE_MINING_LIMIT_HIGH,
  STONE_MINING_LIMIT_LOW,
  STONE_MINING_UNLOCK_SECT_LEVEL,
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
  ChallengeRepository,
  DiscipleRepository,
  EventLogRepository,
  ExplorationRepository,
  PillInventoryRepository,
  ResourceBalanceRepository,
  SectRepository,
  SparringRepository,
  alchemySnapshotGuardStatement,
  challengeSnapshotGuardStatement,
  deleteAlchemySnapshotGuardStatement,
  deleteChallengeSnapshotGuardStatement,
  insertBuildingStatement,
  insertChallengeLogStatement,
  insertDiscipleStatement,
  insertEventLogStatement,
  insertExplorationStatement,
  insertResourceBalanceStatement,
  insertSectStatement,
  insertSparringLogStatement,
  resourceDeltaStatement,
  updateBuildingLevelStatement,
  updateDiscipleAssignmentStatement,
  updateDiscipleBodyTemperingStatement,
  updateDiscipleCultivationStatement,
  updateDiscipleInjuryStatement,
  updateDiscipleProgressStatement,
  updatePillInventoryQuantityStatement,
  updateResourceSettledStatement,
  updateSectChallengeCounterStatement,
  updateSectDefenseLineupStatement,
  updateSectLevelStatement,
  updateSectRecruitCounterStatement,
  updateSectRecruitRefreshStatement,
  updateSectReputationStatement,
  updateSectSettledStatement,
  upsertPillInventoryStatement,
  type BuildingRow,
  type DiscipleRow,
  type EventLogRow,
  type PillInventoryRow,
  type ResourceBalanceRow,
  type SectRow,
} from './repository';
import { settleEconomy, type SettleResult } from './settle';
import {
  breakthroughChanceBp,
  buildSectStateView,
  eventLogViewFromRow,
  upgradeCost,
  type ChallengeBlockedReason,
  type ChallengeRewardPreviewView,
  type EventLogView,
  type ChallengeHistoryEntryView,
  type ChallengeHistoryView,
  type ChallengeResultView,
  type ChallengeRoundView,
  type ExplorationResultView,
  type LeaderboardEntryView,
  type PublicSectChallengeView,
  type PublicSectView,
  type SecretRealmListView,
  type SectStateView,
  type SparHistoryView,
  type SparHistoryEntryView,
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
  /** 丹药库存（可能为空数组；没有行的 pill 视为 0）。 */
  pillInventories: PillInventoryRow[];
  /** 主动挑战的当日次数（0012；日期键过期时已做日志兼容核对）。 */
  challengeDay: ChallengeDayState;
  /** 读快照时库里的最近事件行；本次结算刚触发的在本层另行合并（见 view.ts）。 */
  recentEvents: EventLogRow[];
}

/** 全局唯一配置来源：启动期已校验过的配置内容（不在游戏模块里硬编码数值）。 */
export function gameConfig(): GameConfigContent {
  return validatedGameConfig.content;
}

/**
 * 主动挑战的当日次数口径（计划 4.2）：宗门行的日期键是今天就读 challenge_count，
 * 否则视为 0，但用 challenge_log 的日窗口查询做发布当天兼容核对（旧记录没有日期键）。
 * 展示值 clamp 到 0..3，数据异常不让前端出现负数。
 */
async function loadChallengeDayState(
  db: D1Database,
  sect: SectRow,
  now: number,
): Promise<ChallengeDayState> {
  const dateKey = dateKeyUtc8(now);
  const keyMatches = sect.challenge_date_key === dateKey;
  const legacyUsedToday = keyMatches
    ? 0
    : await new ChallengeRepository(db).countTodayByAttacker(sect.id, dateKey, dayStartMs(now));
  return challengeDayStateOf(sect, now, legacyUsedToday);
}

async function loadSnapshot(
  db: D1Database,
  userId: string,
  now: number,
): Promise<SectSnapshot | null> {
  const sect = await new SectRepository(db).findByUserId(userId);
  if (sect === null) {
    return null;
  }
  const [disciples, buildings, balances, pillInventories, recentEvents, challengeDay] =
    await Promise.all([
      new DiscipleRepository(db).findBySectId(sect.id),
      new BuildingRepository(db).findBySectId(sect.id),
      new ResourceBalanceRepository(db).findBySectId(sect.id),
      new PillInventoryRepository(db).findBySectId(sect.id),
      new EventLogRepository(db).findRecentBySectId(sect.id, RECENT_EVENTS_IN_SYNC),
      loadChallengeDayState(db, sect, now),
    ]);
  return { sect, disciples, buildings, balances, pillInventories, challengeDay, recentEvents };
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
  /** 丹药库存（可变：炼制加、服用减；与写库语句一起在 commit 一次性提交）。 */
  pillInventories: PillInventoryRow[];
  /** 主动挑战的当日次数（可变：挑战受理后在本层更新，随 view() 返回新口径）。 */
  challengeDay: ChallengeDayState;
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
    this.pillInventories = base.pillInventories.map((row) => ({ ...row }));
    this.challengeDay = base.challengeDay;

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
      bodyTemperingCount: Number(row.body_tempering_count),
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

  /** 当前宗门某丹药的库存（非负整数；没有库存行视为 0）。 */
  pillQuantity(pillId: string): number {
    const row = this.pillInventories.find((item) => item.pill_id === pillId);
    return row === undefined ? 0 : Number(row.quantity);
  }

  /** 服用前置检查 + 扣库存 1（内存与写库语句一起追加；库存不足抛 INVALID_STATUS）。 */
  requirePill(pillId: string): void {
    const row = this.pillInventories.find((item) => item.pill_id === pillId);
    const quantity = row === undefined ? 0 : Number(row.quantity);
    if (quantity < 1) {
      throw new AppError('INVALID_STATUS', '丹药库存不足');
    }
    const updated: PillInventoryRow = { ...row!, quantity: quantity - 1, updated_at: this.now };
    this.pillInventories = this.pillInventories.map((item) =>
      item.id === updated.id ? updated : item,
    );
    this.addStatement(updatePillInventoryQuantityStatement(updated, updated.quantity, this.now));
  }

  /** 炼制入库 +quantity（首次用 upsert 创建库存行；同一 (sect, pill) 永远只有一行）。 */
  addPill(pillId: string, quantity: number): void {
    const existing = this.pillInventories.find((item) => item.pill_id === pillId);
    let row: PillInventoryRow;
    if (existing === undefined) {
      row = {
        id: crypto.randomUUID(),
        sect_id: this.sect.id,
        pill_id: pillId,
        quantity,
        updated_at: this.now,
      };
      this.pillInventories = [...this.pillInventories, row];
    } else {
      row = { ...existing, quantity: Number(existing.quantity) + quantity, updated_at: this.now };
      this.pillInventories = this.pillInventories.map((item) =>
        item.id === row.id ? row : item,
      );
    }
    this.addStatement(upsertPillInventoryStatement(this.sect.id, pillId, row.quantity, this.now));
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
      pillInventories: this.pillInventories,
      challengeDay: this.challengeDay,
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

  async commitAlchemy(pillId: string, discipleId?: string): Promise<void> {
    const commandId = crypto.randomUUID();
    const disciple = discipleId === undefined
      ? undefined
      : this.base.disciples.find((row) => row.id === discipleId);
    const guard = alchemySnapshotGuardStatement(commandId, {
      sect: this.base.sect,
      balances: this.base.balances,
      buildings: this.base.buildings,
      pillId,
      pillQuantity: this.base.pillInventories.find((row) => row.pill_id === pillId)?.quantity ?? 0,
      ...(disciple === undefined ? {} : { disciple }),
    });
    try {
      await this.db.batch(prepareStatements(this.db, [
        guard,
        ...this.statements,
        deleteAlchemySnapshotGuardStatement(commandId),
      ]));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/CHECK constraint failed: (?:valid = 1|mutation_guards)/i.test(message)) {
        throw new AppError('INVALID_STATUS', '宗门状态已变化，请刷新后重试');
      }
      throw error;
    }
  }

  /**
   * 挑战 batch（0012）：守卫 + 结算 + 计数/奖励/日志 + 清理守卫一次提交。
   *
   * 并发保护（计划 5.7）：
   * - 首条 mutation_guards 快照语句在 batch 执行时重新校验攻方宗门行（等级/声望/
   *   结算时间/挑战日期键/计数）、资源余额与守方等级/阵容；任何一个并发改动都会让
   *   CHECK 失败并回滚整批，所以「成功场次 <= 3」和「奖励与日志同生共死」由数据库保证。
   * - challenge_log 的唯一部分索引（attacker, defender, challenge_date_key）兜底同日
   *   同目标的并发挑战，冲突映射成 DAILY_LIMIT 业务错误，不向前端暴露 SQL。
   */
  async commitChallenge(target: { id: string; level: number; defenseLineup: string | null }): Promise<void> {
    const commandId = crypto.randomUUID();
    const guard = challengeSnapshotGuardStatement(commandId, {
      sect: this.base.sect,
      balances: this.base.balances,
      target,
    });
    try {
      await this.db.batch(prepareStatements(this.db, [
        guard,
        ...this.statements,
        deleteChallengeSnapshotGuardStatement(commandId),
      ]));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/CHECK constraint failed: (?:valid = 1|mutation_guards)/i.test(message)) {
        throw new AppError('INVALID_STATUS', '宗门状态已变化，请刷新后重试');
      }
      if (/UNIQUE constraint failed: challenge_log/i.test(message)) {
        throw new AppError('DAILY_LIMIT', '今日已挑战过该宗门（同一目标每日 1 次）');
      }
      throw error;
    }
  }
}

async function draftFor(db: D1Database, userId: string, now: number): Promise<SectDraft> {
  const snapshot = await loadSnapshot(db, userId, now);
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
  const snapshot = await loadSnapshot(db, userId, now);
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
      body_tempering_count: 0,
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
        bodyTemperingCount: 0,
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
        recruit_refresh_level: config.sect.initialLevel,
        recruit_refresh_used: 0,
        defense_lineup: null,
        challenge_date_key: '',
        challenge_count: 0,
        created_at: now,
      },
      disciples,
      buildings,
      balances,
      pillInventories: [],
      challengeDay: challengeDayStateOf(
        { challenge_date_key: '', challenge_count: 0 },
        now,
      ),
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
  /** V5.2：本境界已用的招贤刷新次数（升级重置，按归一化后的值）。 */
  refreshUsed: number;
  /** V5.2：本境界的招贤刷新额度（RECRUIT_REFRESH_PER_LEVEL）。 */
  refreshLimit: number;
  /** V5.2：还剩几次刷新（= limit - used，不小于 0）。 */
  refreshRemaining: number;
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
 * 招贤刷新额度的唯一归一化入口（读取 / 预览 / 刷新 / 招募共用）：
 * 宗门等级与「上次授予等级」不一致时视为已用 0 次（升级即重置，未用次数不累积）。
 * 返回写入用的 level（当前等级）与 used，以及展示用的 limit / remaining。
 * 归一化只发生在内存里，读取路径不会因此落库。
 */
function recruitRefreshQuota(
  sect: Pick<SectRow, 'level' | 'recruit_refresh_level' | 'recruit_refresh_used'>,
): { level: number; used: number; limit: number; remaining: number } {
  const level = Number(sect.level);
  const used = level === Number(sect.recruit_refresh_level) ? Number(sect.recruit_refresh_used) : 0;
  return {
    level,
    used,
    limit: RECRUIT_REFRESH_PER_LEVEL,
    remaining: Math.max(0, RECRUIT_REFRESH_PER_LEVEL - used),
  };
}

/**
 * 招募预览（V4 5.4）：**只读快照，不做结算**——与排行榜同理，预览不该有副作用
 * （否则长离线后打开一次弹窗就触发了结算与随机事件）。
 *
 * 候选人与 recruitDisciple 用完全相同的 seed 参数生成（宗门 id + UTC+8 自然日 +
 * 「今日已招募次数」+ 归一化后的「本境界已用刷新次数」），因此「预览 → 招募」拿到的是同一批人；
 * 招募成功后「今日已招募次数」+1、刷新后刷新序号 +1，下一次打开预览就是新的一批。
 *
 * 刷新额度只按归一化后的值计算返回，**不写库**（读取路径不能有副作用）。
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
  const quota = recruitRefreshQuota(sect);

  const blockedReason = recruitBlockedReason({
    config,
    discipleCount: disciples.length,
    discipleCapacity,
    recruitUsedToday,
    balanceOf: (resourceId) =>
      Number(balances.find((row) => row.resource_id === resourceId)?.balance ?? 0),
  });

  return {
    candidates: generateCandidates(sect.id, dateKey, recruitUsedToday, quota.used),
    canRecruit: blockedReason === null,
    blockedReason,
    cost: { ...config.recruitment.cost },
    refreshUsed: quota.used,
    refreshLimit: quota.limit,
    refreshRemaining: quota.remaining,
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
  // 刷新序号取归一化后的「本境界已用刷新次数」，与预览（含刷新接口返回的那一批）保持同一组参数。
  // schema 已把 choice 限制在 0~2，这里再兜一层，越界直接报错而不是写入脏数据。
  const refreshSeq = recruitRefreshQuota(draft.sect).used;
  const candidates = generateCandidates(
    draft.sect.id,
    dateKeyUtc8(now),
    draft.recruitUsedToday,
    refreshSeq,
  );
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
    body_tempering_count: 0,
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
 
/**
 * 招贤台刷新（V5.2）：结算 → 校验本境界刷新额度 → used+1（并把授予等级写成当前等级）
 * → 用「刷新后的 used」作刷新序号生成新一批候选人。
 *
 * 刷新免费：不扣资源、不动每日招募次数（recruit_count 与刷新计数相互独立）；
 * 额度按「升级即重置」归一化（见 recruitRefreshQuota）。只做一次 `draft.commit()`。
 * 返回的 preview 与随后 recruitDisciple 使用同一组 seed 参数（refreshSeq = 刷新后的 used），
 * 保证「预览第 N 张 = 招募时 candidates[N]」。次数用尽抛 DAILY_LIMIT。
 */
export async function refreshRecruit(
  db: D1Database,
  userId: string,
  now: number,
): Promise<{ state: SectStateView; preview: RecruitPreview }> {
  const draft = await draftFor(db, userId, now);
  const quota = recruitRefreshQuota(draft.sect);

  if (quota.used >= RECRUIT_REFRESH_PER_LEVEL) {
    throw new AppError('DAILY_LIMIT', '本境界的招贤刷新次数已用完（宗门晋升后重置）', {
      refreshLimit: RECRUIT_REFRESH_PER_LEVEL,
      refreshUsed: quota.used,
    });
  }

  const nextUsed = quota.used + 1;
  draft.addStatement(updateSectRecruitRefreshStatement(draft.sect.id, quota.level, nextUsed));
  draft.sect.recruit_refresh_level = quota.level;
  draft.sect.recruit_refresh_used = nextUsed;

  await draft.commit();

  // 与 recruitDisciple 共用同一判定：刷新只换人，不改变能否招募的规则。
  const blockedReason = recruitBlockedReason({
    config: draft.config,
    discipleCount: draft.disciples.length,
    discipleCapacity: draft.discipleCapacity,
    recruitUsedToday: draft.recruitUsedToday,
    balanceOf: (resourceId) => draft.balanceOf(resourceId),
  });

  return {
    state: draft.view(),
    preview: {
      candidates: generateCandidates(
        draft.sect.id,
        dateKeyUtc8(now),
        draft.recruitUsedToday,
        nextUsed,
      ),
      canRecruit: blockedReason === null,
      blockedReason,
      cost: { ...draft.config.recruitment.cost },
      refreshUsed: nextUsed,
      refreshLimit: RECRUIT_REFRESH_PER_LEVEL,
      refreshRemaining: Math.max(0, RECRUIT_REFRESH_PER_LEVEL - nextUsed),
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

  // V5.1 改动三：采灵岗位有人数上限（宗门 6 级前 1 人、6 级起 2 人）。
  // item.id !== discipleId：弟子本来就在采灵岗位时，重复派工不该算占位。
  if (assignment === STONE_MINING_ASSIGNMENT) {
    const limit =
      Number(draft.sect.level) >= STONE_MINING_UNLOCK_SECT_LEVEL
        ? STONE_MINING_LIMIT_HIGH
        : STONE_MINING_LIMIT_LOW;
    const currentCount = draft.disciples.filter(
      (item) => item.assignment === STONE_MINING_ASSIGNMENT && item.id !== discipleId,
    ).length;
    if (currentCount >= limit) {
      throw new AppError('CAPACITY_FULL', `采灵岗位已满（上限 ${limit} 人）`);
    }
  }

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

const SPAR_HISTORY_LIMIT = 20;

/** 切磋历史（GET /game/spar-history）：最近 20 条 + 攻方胜负统计。 */
export async function listSparHistory(db: D1Database, userId: string): Promise<SparHistoryView> {
  const sect = await new SectRepository(db).findByUserId(userId);
  if (sect === null) {
    return { entries: [], stats: { wins: 0, losses: 0, draws: 0, total: 0 } };
  }

  const sparRepo = new SparringRepository(db);
  const [rows, stats] = await Promise.all([
    sparRepo.findBySectId(sect.id, SPAR_HISTORY_LIMIT),
    sparRepo.statsBySectId(sect.id),
  ]);

  const sectIds = new Set<string>();
  for (const row of rows) {
    sectIds.add(row.attacker_sect_id);
    sectIds.add(row.defender_sect_id);
  }
  const sectRepo = new SectRepository(db);
  const sectNames = new Map<string, string>();
  for (const id of sectIds) {
    const s = await sectRepo.findById(id);
    sectNames.set(id, s?.name ?? '未知宗门');
  }

  const entries: SparHistoryEntryView[] = rows.map((row) => ({
    id: row.id,
    attackerSectId: row.attacker_sect_id,
    attackerSectName: sectNames.get(row.attacker_sect_id) ?? '未知宗门',
    defenderSectId: row.defender_sect_id,
    defenderSectName: sectNames.get(row.defender_sect_id) ?? '未知宗门',
    attackerPower: Number(row.attacker_power),
    defenderPower: Number(row.defender_power),
    result: row.result,
    reputationGained: Number(row.reputation_gained),
    role: row.attacker_sect_id === sect.id ? 'attacker' : 'defender',
    createdAt: new Date(Number(row.created_at)).toISOString(),
  }));

  return {
    entries,
    stats: { ...stats, total: stats.wins + stats.losses + stats.draws },
  };
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
  const snapshot = await loadSnapshot(db, userId, now);
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
const SPARRING_WIN_SPIRIT_STONE = 100_000;

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
 *
 * 0012 挑战预览：相对当前用户计算可挑战状态、阻止原因、守擂方式、当日次数、
 * 是否已挑战过、等级差与「若胜利」的确切奖励。只报告守擂方式，不暴露临时自动
 * 阵容的人选与顺序（自动阵容只在挑战真正受理时生成）。观看者自己没有宗门时
 * `challenge` 为 null（前端渲染为不可挑战）。
 */
export async function getPublicSect(
  db: D1Database,
  sectId: string,
  viewerUserId: string,
  now: number,
): Promise<PublicSectView> {
  const sect = await new SectRepository(db).findById(sectId);
  if (sect === null) {
    throw new AppError('NOT_FOUND', '宗门不存在');
  }

  const [disciples, buildings, viewerSect] = await Promise.all([
    new DiscipleRepository(db).findBySectId(sectId),
    new BuildingRepository(db).findBySectId(sectId),
    new SectRepository(db).findByUserId(viewerUserId),
  ]);
  const config = gameConfig();

  const plan = planDefenseLineup(sect.defense_lineup, disciples);
  let challenge: PublicSectChallengeView | null = null;
  if (viewerSect !== null) {
    const isSelf = viewerSect.id === sect.id;
    const challengeDay = await loadChallengeDayState(db, viewerSect, now);
    const alreadyChallengedToday = !isSelf
      ? await new ChallengeRepository(db).hasChallengedTargetToday(
          viewerSect.id,
          sect.id,
          challengeDay.dateKey,
          dayStartMs(now),
        )
      : false;

    let blockedReason: ChallengeBlockedReason | null = null;
    if (isSelf) {
      blockedReason = 'self';
    } else if (challengeDay.remaining <= 0) {
      blockedReason = 'daily_limit';
    } else if (alreadyChallengedToday) {
      blockedReason = 'already_challenged_today';
    } else if (!plan.canDefend) {
      blockedReason = 'defender_insufficient';
    }

    const levelDifference = Number(sect.level) - Number(viewerSect.level);
    const reward = rewardTierForLevelDifference(levelDifference);
    const preview: ChallengeRewardPreviewView = {
      tier: reward.tier,
      reputation: reward.reputation,
      spiritStone: reward.spiritStone,
    };
    challenge = {
      canChallenge: blockedReason === null,
      blockedReason,
      defenseMode: plan.canDefend ? plan.mode : null,
      dailyLimit: CHALLENGE_DAILY_LIMIT,
      usedToday: challengeDay.usedToday,
      remaining: challengeDay.remaining,
      alreadyChallengedToday,
      levelDifference,
      rewardPreview: preview,
    };
  }

  return {
    sectId: sect.id,
    name: sect.name,
    level: Number(sect.level),
    levelName: findSectLevel(Number(sect.level)).name,
    reputation: Number(sect.reputation) || 0,
    // 「有效手动守擂阵容」：3 个不重复、仍属于本宗的弟子；无效阵容不算已布阵。
    hasDefenseLineup: plan.canDefend && plan.mode === 'configured',
    challenge,
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
      spiritStoneGained / 1000,
    )}`;
  }
  if (result === 'lose') {
    return `${myName} 不敌 ${targetName}，切磋落败（无损失）`;
  }
  return `${myName} 与 ${targetName} 战成平手`;
}

/** 挑战历史展示条数上限（与旧的切磋历史一致）。 */
const CHALLENGE_HISTORY_LIMIT = 20;

/** 挑战单轮结果（V5 3.2）；单轮平局（浮动后战力恰好相等）算守方胜。 */
interface RoundResult {
  round: number;
  attackerPower: number;
  defenderPower: number;
  winner: 'attacker' | 'defender';
}

/** 挑战阵容成员快照：id + 名字 + 基础战力（浮动前的 discipleCombatPower）。 */
interface ChallengeMember {
  discipleId: string;
  name: string;
  power: number;
}

/**
 * 3v3 逐对决斗（V5 3.2）：每轮取双方同序号弟子，战力 ±15% 浮动后高者胜该轮；
 * 先赢满 2 轮者胜整场（第 3 轮只在 1:1 时打）。单轮平局算守方胜。
 */
function resolveChallenge(
  attackerMembers: readonly ChallengeMember[],
  defenderMembers: readonly ChallengeMember[],
): { rounds: RoundResult[]; result: 'win' | 'lose' } {
  const rounds: RoundResult[] = [];
  let attackerWins = 0;
  let defenderWins = 0;

  for (let i = 0; i < DEFENSE_LINEUP_SIZE; i++) {
    if (attackerWins >= 2 || defenderWins >= 2) {
      break;
    }
    const aPower = fluctuatedPower(attackerMembers[i].power);
    const dPower = fluctuatedPower(defenderMembers[i].power);
    const winner: RoundResult['winner'] = aPower > dPower ? 'attacker' : 'defender';
    rounds.push({ round: i + 1, attackerPower: aPower, defenderPower: dPower, winner });
    if (winner === 'attacker') {
      attackerWins++;
    } else {
      defenderWins++;
    }
  }

  return { rounds, result: attackerWins >= 2 ? 'win' : 'lose' };
}

/** 挑战记录里的阵容 JSON 快照 → 成员数组；非法输入退化为空数组。 */
function parseLineupMembers(text: string): ChallengeMember[] {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      return [];
    }
    const members: ChallengeMember[] = [];
    for (const item of parsed) {
      if (item === null || typeof item !== 'object') {
        continue;
      }
      const row = item as Record<string, unknown>;
      members.push({
        discipleId: typeof row.discipleId === 'string' ? row.discipleId : '',
        name: typeof row.name === 'string' ? row.name : '未知',
        power: Number(row.power) || 0,
      });
    }
    return members;
  } catch {
    return [];
  }
}

/** 挑战记录里的每轮结果 JSON → RoundResult[]；非法输入退化为空数组。 */
function parseRoundResults(text: string): RoundResult[] {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      return [];
    }
    const rounds: RoundResult[] = [];
    for (const item of parsed) {
      if (item === null || typeof item !== 'object') {
        continue;
      }
      const row = item as Record<string, unknown>;
      rounds.push({
        round: Number(row.round),
        attackerPower: Number(row.attackerPower),
        defenderPower: Number(row.defenderPower),
        winner: row.winner === 'attacker' ? 'attacker' : 'defender',
      });
    }
    return rounds;
  } catch {
    return [];
  }
}

/** 把逐轮结果与双方阵容（按序号）拼成带名字的战报视图。 */
function toChallengeRoundViews(
  results: readonly RoundResult[],
  attackerMembers: readonly ChallengeMember[],
  defenderMembers: readonly ChallengeMember[],
): ChallengeRoundView[] {
  return results.map((result) => ({
    round: result.round,
    attackerName: attackerMembers[result.round - 1]?.name ?? '未知',
    defenderName: defenderMembers[result.round - 1]?.name ?? '未知',
    attackerPower: result.attackerPower,
    defenderPower: result.defenderPower,
    winner: result.winner,
  }));
}

/**
 * 设置守擂阵容（V5 2.2）：结算 → 去重 → 逐个校验归属（不存在抛 NOT_FOUND）→ 写回。
 *
 * 注意：受伤的弟子**可以**放进守擂阵容（守擂是预设的，不检查伤势）。
 * 只有一次 `draft.commit()`：结算写回 + 阵容更新同一个 batch。
 */
export async function setDefenseLineup(
  db: D1Database,
  userId: string,
  discipleIds: string[],
  now: number,
): Promise<SectStateView> {
  const draft = await draftFor(db, userId, now);

  if (discipleIds.length !== DEFENSE_LINEUP_SIZE) {
    throw new AppError('VALIDATION_ERROR', `守擂阵容需要 ${DEFENSE_LINEUP_SIZE} 名弟子`);
  }
  if (new Set(discipleIds).size !== discipleIds.length) {
    throw new AppError('VALIDATION_ERROR', '不能重复选择同一名弟子');
  }
  for (const id of discipleIds) {
    // 归属校验：只看自己的弟子，不存在（含不属于本宗）抛 NOT_FOUND。
    draft.discipleById(id);
  }

  const lineupJson = JSON.stringify(discipleIds);
  draft.addStatement(updateSectDefenseLineupStatement(draft.sect.id, lineupJson));
  draft.sect.defense_lineup = lineupJson;

  await draft.commit();
  return draft.view();
}

/**
 * 挑战（3v3 逐对决斗，0012 优化版）：结算 → 固定顺序校验 → 守方阵容快照 → 逐对决斗
 * → 奖励按等级差档位 → 计数/奖励/日志/结算一次受保护 batch 提交。
 *
 * 校验顺序（全部失败都在任何写库之前抛出，不消耗次数）：
 *   1. 自己的宗门快照（draftFor，顺带结算）
 *   2. 目标宗门存在、不是自己（NOT_FOUND / VALIDATION_ERROR）
 *   3. 攻方当日计数（UTC+8 归一 + 发布当天日志兼容核对）< 3（DAILY_LIMIT）
 *   4. 今日未挑战过该目标（DAILY_LIMIT；并发兜底靠唯一部分索引）
 *   5. 攻方恰好 3 名不重复、属于自己且未受伤的弟子（VALIDATION_ERROR / NOT_FOUND / INVALID_STATUS）
 *   6. 一次性加载守方当前全部弟子
 *   7. 守方阵容：有效手动阵容按原顺序；无效/未设置但弟子 >= 3 → 临时自动守擂
 *      （等概率不重复抽 3 名、随机排序、可含受伤弟子）；弟子 < 3 拒绝（INVALID_STATUS）
 *   8. 快照双方等级 → 等级差 → 奖励档位（奖励以开战快照为准）
 *   9. resolveChallenge 逐对决斗；胜利按档位发奖（失败/`<=-3` 胜利都是 0）
 *  10. commitChallenge：守卫 + 结算写回 + 计数 + 奖励 + 挑战日志（含快照）同一 batch；
 *      「受理一场战斗」的边界就是整个 batch 成功。
 */
export async function challengeSect(
  db: D1Database,
  userId: string,
  targetSectId: string,
  discipleIds: string[],
  now: number,
): Promise<{ state: SectStateView; result: ChallengeResultView }> {
  const draft = await draftFor(db, userId, now);

  // 2. 目标存在且不是自己
  const targetSect = await new SectRepository(db).findById(targetSectId);
  if (targetSect === null) {
    throw new AppError('NOT_FOUND', '对方宗门不存在');
  }
  if (targetSect.id === draft.sect.id) {
    throw new AppError('VALIDATION_ERROR', '不能挑战自己的宗门');
  }

  // 3. 当日次数（UTC+8 归一；日期键过期时做日志兼容核对）
  const challengeDay = draft.challengeDay;
  if (challengeDay.remaining <= 0) {
    throw new AppError('DAILY_LIMIT', `今日挑战次数已用完（${CHALLENGE_DAILY_LIMIT} 次/天）`);
  }

  // 4. 同一目标每日 1 次（先查给友好报错；并发兜底在唯一部分索引）
  const challengeRepository = new ChallengeRepository(db);
  if (
    await challengeRepository.hasChallengedTargetToday(
      draft.sect.id,
      targetSect.id,
      challengeDay.dateKey,
      dayStartMs(now),
    )
  ) {
    throw new AppError('DAILY_LIMIT', `今日已挑战过${targetSect.name}（同一目标每日 1 次）`);
  }

  // 5. 攻方阵容：不重复、属于自己、未受伤
  if (discipleIds.length !== DEFENSE_LINEUP_SIZE) {
    throw new AppError('VALIDATION_ERROR', `攻方阵容需要 ${DEFENSE_LINEUP_SIZE} 名弟子`);
  }
  if (new Set(discipleIds).size !== discipleIds.length) {
    throw new AppError('VALIDATION_ERROR', '不能派遣重复弟子');
  }
  const attackerMembers: ChallengeMember[] = [];
  for (const id of discipleIds) {
    const disciple = draft.discipleById(id);
    if (disciple.injured_until !== null && Number(disciple.injured_until) > now) {
      throw new AppError('INVALID_STATUS', `${disciple.name}正在疗伤，无法出战`);
    }
    attackerMembers.push({
      discipleId: disciple.id,
      name: disciple.name,
      power: discipleCombatPower(
        disciple.realm_id,
        Number(disciple.stage),
        Number(disciple.attack),
        Number(disciple.defense),
        Number(disciple.speed),
        disciple.talent,
      ),
    });
  }

  // 6-7. 守方阵容：有效手动阵容按原顺序；否则临时自动守擂（弟子 < 3 拒绝，不消耗次数）
  const defenderDisciples = await new DiscipleRepository(db).findBySectId(targetSect.id);
  const plan = planDefenseLineup(targetSect.defense_lineup, defenderDisciples);
  if (!plan.canDefend) {
    throw new AppError('INVALID_STATUS', '对方门下弟子不足 3 人，暂时无法应战');
  }
  const defenseMode: DefenseMode = plan.mode;
  let defenderMembers: ChallengeMember[];
  if (plan.mode === 'configured') {
    // 手动阵容按玩家设置的顺序使用；成员此刻必然都在守方（planDefenseLineup 已校验）。
    defenderMembers = plan.manualIds.map((id) => {
      const disciple = defenderDisciples.find((row) => row.id === id)!;
      return {
        discipleId: disciple.id,
        name: disciple.name,
        power: discipleCombatPower(
          disciple.realm_id,
          Number(disciple.stage),
          Number(disciple.attack),
          Number(disciple.defense),
          Number(disciple.speed),
          disciple.talent,
        ),
      };
    });
  } else {
    // 自动守擂：等概率不重复抽 3 名并随机排序，可含受伤弟子；
    // 战斗、返回结果和历史记录使用同一份快照。
    const candidates = defenderDisciples.map((disciple) => ({
      discipleId: disciple.id,
      name: disciple.name,
      power: discipleCombatPower(
        disciple.realm_id,
        Number(disciple.stage),
        Number(disciple.attack),
        Number(disciple.defense),
        Number(disciple.speed),
        disciple.talent,
      ),
    }));
    defenderMembers = shufflePick(candidates, DEFENSE_LINEUP_SIZE);
  }

  // 8. 开战快照：等级差与奖励档位（不从之后状态反推）
  const attackerLevel = Number(draft.sect.level);
  const defenderLevel = Number(targetSect.level);
  const levelDifference = defenderLevel - attackerLevel;
  const rewardTier = rewardTierForLevelDifference(levelDifference);

  // 9. 解算战斗 + 按档位发奖（失败与 `<=-3` 的胜利都是 0）
  const resolved = resolveChallenge(attackerMembers, defenderMembers);
  const roundViews = toChallengeRoundViews(resolved.rounds, attackerMembers, defenderMembers);
  const attackerWins = resolved.rounds.filter((round) => round.winner === 'attacker').length;
  const defenderWins = resolved.rounds.filter((round) => round.winner === 'defender').length;

  const reputationGained = resolved.result === 'win' ? rewardTier.reputation : 0;
  const spiritStoneGained = resolved.result === 'win' ? rewardTier.spiritStone : 0;
  if (resolved.result === 'win' && (reputationGained > 0 || spiritStoneGained > 0)) {
    draft.addStatement(updateSectReputationStatement(draft.sect.id, reputationGained));
    draft.addStatement(resourceDeltaStatement(draft.sect.id, 'spiritStone', spiritStoneGained, now));
    // 内存状态同步更新：本次返回的 state 里就是新声望 / 新灵石余额。
    draft.sect.reputation = (Number(draft.sect.reputation) || 0) + reputationGained;
    draft.balances = draft.balances.map((row) =>
      row.resource_id === 'spiritStone'
        ? { ...row, balance: Number(row.balance) + spiritStoneGained, updated_at: now }
        : row,
    );
  }

  // 10-1. 计数写回：日期键归一到今天、计数 = 已用 + 1（内存同步，返回的 state 就是新值）。
  const usedAfter = challengeDay.usedToday + 1;
  draft.addStatement(
    updateSectChallengeCounterStatement(draft.sect.id, challengeDay.dateKey, usedAfter),
  );
  draft.sect.challenge_date_key = challengeDay.dateKey;
  draft.sect.challenge_count = usedAfter;

  // 10-2. 挑战日志（含开战快照；阵容与 rounds 是当场实际出战快照）。
  draft.addStatement(
    insertChallengeLogStatement({
      id: crypto.randomUUID(),
      attackerSectId: draft.sect.id,
      defenderSectId: targetSect.id,
      attackerLineup: JSON.stringify(attackerMembers),
      defenderLineup: JSON.stringify(defenderMembers),
      rounds: JSON.stringify(resolved.rounds),
      result: resolved.result,
      reputationGained,
      spiritStoneGained,
      attackerLevel,
      defenderLevel,
      rewardTier: rewardTier.tier,
      defenseMode,
      challengeDateKey: challengeDay.dateKey,
      now,
    }),
  );

  // 10-3. 唯一的一次受保护提交：守卫 + 结算 + 计数 + 奖励 + 日志同一个 batch。
  await draft.commitChallenge({
    id: targetSect.id,
    level: defenderLevel,
    defenseLineup: targetSect.defense_lineup,
  });

  // 13. 提交成功后返回含最新剩余次数的 state 与完整战斗结果。
  draft.challengeDay = {
    ...challengeDay,
    usedToday: usedAfter,
    remaining: Math.max(0, CHALLENGE_DAILY_LIMIT - usedAfter),
  };

  return {
    state: draft.view(),
    result: {
      targetSectName: targetSect.name,
      rounds: roundViews,
      result: resolved.result,
      reputationGained,
      spiritStoneGained,
      attackerLevel,
      defenderLevel,
      levelDifference,
      rewardTier: rewardTier.tier,
      defenseMode,
      message: challengeMessage(
        resolved.result,
        targetSect.name,
        attackerWins,
        defenderWins,
        reputationGained,
        spiritStoneGained,
      ),
    },
  };
}

/** 挑战结果文案（胜/负/零奖励胜）；灵石用展示单位。 */
function challengeMessage(
  result: 'win' | 'lose',
  targetSectName: string,
  attackerWins: number,
  defenderWins: number,
  reputationGained: number,
  spiritStoneGained: number,
): string {
  const score = `${String(attackerWins)}:${String(defenderWins)}`;
  if (result === 'win') {
    if (reputationGained === 0 && spiritStoneGained === 0) {
      return `你的阵容 ${score} 击败了 ${targetSectName}！对方等级过低，此胜没有奖励（已消耗 1 次挑战）。`;
    }
    return `你的阵容 ${score} 击败了 ${targetSectName}！声望 +${String(reputationGained)}，灵石 +${String(
      spiritStoneGained / 1000,
    )}`;
  }
  return `你的阵容 ${score} 不敌 ${targetSectName}，挑战失败（无奖励，已消耗 1 次挑战）`;
}

/**
 * 挑战历史（GET /game/challenge-history，V5 4.1）：最近 20 条 + 自身视角胜负统计。
 *
 * `role` 标识当前用户是攻方还是守方；记录的 `result` 存的是攻方视角，
 * 前端可结合 `role` 展示「自己的胜负」；`stats` 已经在服务端翻转为自身视角。
 */
export async function listChallengeHistory(
  db: D1Database,
  userId: string,
): Promise<ChallengeHistoryView> {
  const sect = await new SectRepository(db).findByUserId(userId);
  if (sect === null) {
    return { entries: [], stats: { wins: 0, losses: 0, total: 0 } };
  }

  const challengeRepository = new ChallengeRepository(db);
  const [rows, stats] = await Promise.all([
    challengeRepository.findBySectId(sect.id, CHALLENGE_HISTORY_LIMIT),
    challengeRepository.statsBySectId(sect.id),
  ]);

  const sectIds = new Set<string>();
  for (const row of rows) {
    sectIds.add(row.attacker_sect_id);
    sectIds.add(row.defender_sect_id);
  }
  const sectRepository = new SectRepository(db);
  const sectNames = new Map<string, string>();
  for (const id of sectIds) {
    const target = await sectRepository.findById(id);
    sectNames.set(id, target?.name ?? '未知宗门');
  }

  const entries: ChallengeHistoryEntryView[] = rows.map((row) => {
    const attackerMembers = parseLineupMembers(row.attacker_lineup);
    const defenderMembers = parseLineupMembers(row.defender_lineup);
    // 0012 快照：旧记录这些列为 NULL，原样透传（前端不伪造等级差/档位/守擂方式）。
    const attackerLevel = row.attacker_level === null ? null : Number(row.attacker_level);
    const defenderLevel = row.defender_level === null ? null : Number(row.defender_level);
    return {
      id: row.id,
      attackerSectName: sectNames.get(row.attacker_sect_id) ?? '未知宗门',
      defenderSectName: sectNames.get(row.defender_sect_id) ?? '未知宗门',
      rounds: toChallengeRoundViews(parseRoundResults(row.rounds), attackerMembers, defenderMembers),
      result: row.result,
      role: row.attacker_sect_id === sect.id ? 'attacker' : 'defender',
      reputationGained: Number(row.reputation_gained),
      spiritStoneGained: Number(row.spirit_stone_gained),
      attackerLevel,
      defenderLevel,
      // 等级差口径：守方等级 - 攻方等级（与开战预览/结果一致）
      levelDifference:
        attackerLevel === null || defenderLevel === null ? null : defenderLevel - attackerLevel,
      rewardTier: asRewardTier(row.reward_tier),
      defenseMode: asDefenseMode(row.defense_mode),
      createdAt: new Date(Number(row.created_at)).toISOString(),
    };
  });

  return {
    entries,
    stats: { wins: stats.wins, losses: stats.losses, total: stats.wins + stats.losses },
  };
}

/* ---------- 丹药系统（0011 迁移 + alchemy.ts） ---------- */

/** 炼制结果（POST /game/craft-pill 的 outcome）。 */
export interface CraftPillOutcome {
  pillId: PillId;
  pillName: string;
  quantity: number;
  /** 本次炼制的实际总成本（单颗 × quantity，最小单位）。 */
  cost: Record<string, string>;
}

/** 服用结果（POST /game/use-pill 的 outcome）。 */
export interface UsePillOutcome {
  pillId: PillId;
  pillName: string;
  discipleId: string;
  discipleName: string;
  effect: {
    kind: 'heal' | 'cultivation' | 'bodyTempering';
    /** cultivation / bodyTempering 的提升量。 */
    gain?: number;
    /** bodyTempering 服务端自动选中的短板属性。 */
    attribute?: PillAttribute;
  };
}

/** 建筑等级表（defId -> level），炼丹解锁判断用。 */
function buildingLevelsOf(buildings: readonly BuildingRow[]): Record<string, number> {
  return Object.fromEntries(buildings.map((row) => [row.def_id, row.level]));
}

/** 炼丹解锁检查（只在服务端实现；未解锁时 craft/use 一律 INVALID_STATUS）。 */
function requireAlchemyUnlocked(draft: SectDraft): void {
  const reason = alchemyUnlockBlockedReason(
    Number(draft.sect.level),
    buildingLevelsOf(draft.buildings),
  );
  if (reason !== null) {
    throw new AppError('INVALID_STATUS', reason);
  }
}

/** 配方查找：未知 pill id 抛 NOT_FOUND（不写库）。 */
function requirePillRecipe(pillId: string): PillRecipe {
  const recipe = findPillRecipe(pillId);
  if (recipe === undefined) {
    throw new AppError('NOT_FOUND', '未知丹方');
  }
  return recipe;
}

/**
 * 炼制丹药（即时命令，无队列）：结算 → 解锁/配方/资源校验 → 扣资源 + 库存 +quantity，
 * 只做**一次** `draft.commitAlchemy()`（单次 D1 batch，首条校验快照）。
 * 资源不足或快照冲突整次失败，不产生半写。
 */
export async function craftPill(
  db: D1Database,
  userId: string,
  pillId: string,
  quantity: number,
  now: number,
): Promise<{ state: SectStateView; outcome: CraftPillOutcome }> {
  const draft = await draftFor(db, userId, now);
  requireAlchemyUnlocked(draft);
  const recipe = requirePillRecipe(pillId);

  // 单次成本 = 单颗成本 × quantity；requireResource 逐项检查并扣减（不足抛 INSUFFICIENT_RESOURCE）。
  const cost: Record<string, string> = {};
  for (const [resourceId, amount] of Object.entries(recipe.cost)) {
    const total = Number(amount) * quantity;
    draft.requireResource(resourceId, total);
    cost[resourceId] = String(total);
  }

  draft.addPill(recipe.id, quantity);

  await draft.commitAlchemy(recipe.id);
  return {
    state: draft.view(),
    outcome: { pillId: recipe.id, pillName: recipe.name, quantity, cost },
  };
}

/**
 * 服用丹药（三条路径共用一套校验顺序）：
 *   结算 → 解锁检查 → 配方检查 → 弟子归属（discipleById 只在当前宗门里找）
 *   → 状态检查（不满足抛 INVALID_STATUS，且都在任何写库之前）
 *   → 扣库存 1 + 效果写回，只做**一次** `draft.commitAlchemy()`。
 *
 * - 回春丹：只清除有效伤势（injured_until > now），不碰修为/境界/属性。
 * - 聚气丹：修为 +min(120, 门槛 - 当前)，不越过突破门槛；cultivation_remainder 保持不变；
 *   已达本版本最高阶段或修为已满门槛的弟子不能用。
 * - 淬体丹：服务端自动选短板（attack -> defense -> speed），每名弟子最多 10 次；
 *   没有短板时拒绝。不使用随机数。
 */
export async function usePill(
  db: D1Database,
  userId: string,
  pillId: string,
  discipleId: string,
  now: number,
): Promise<{ state: SectStateView; outcome: UsePillOutcome }> {
  const draft = await draftFor(db, userId, now);
  requireAlchemyUnlocked(draft);
  const recipe = requirePillRecipe(pillId);
  const disciple = draft.discipleById(discipleId);

  if (recipe.id === 'healingPill') {
    if (disciple.injured_until === null || Number(disciple.injured_until) <= now) {
      throw new AppError('INVALID_STATUS', `${disciple.name}没有需要治疗的伤势`);
    }
    draft.requirePill(recipe.id);
    draft.addStatement(updateDiscipleInjuryStatement(disciple.id, null));
    disciple.injured_until = null;
    await draft.commitAlchemy(recipe.id, disciple.id);
    return {
      state: draft.view(),
      outcome: {
        pillId: recipe.id,
        pillName: recipe.name,
        discipleId: disciple.id,
        discipleName: disciple.name,
        effect: { kind: 'heal' },
      },
    };
  }

  if (recipe.id === 'cultivationPill') {
    const stage = findStage(disciple.realm_id, Number(disciple.stage));
    if (stage.requiredCultivation === null) {
      throw new AppError('INVALID_STATUS', `${disciple.name}已达本版本最高阶段，无法再服用聚气丹`);
    }
    if (Number(disciple.cultivation) >= stage.requiredCultivation) {
      throw new AppError('INVALID_STATUS', `${disciple.name}修为已达突破门槛，请先突破再服用聚气丹`);
    }
    const gain = Math.min(
      CULTIVATION_PILL_GAIN,
      stage.requiredCultivation - Number(disciple.cultivation),
    );
    draft.requirePill(recipe.id);
    const cultivation = Number(disciple.cultivation) + gain;
    // 修为余数保持不变：不因服药丢弃离线结算的小数余量。
    draft.addStatement(
      updateDiscipleCultivationStatement(disciple.id, cultivation, Number(disciple.cultivation_remainder)),
    );
    disciple.cultivation = cultivation;
    await draft.commitAlchemy(recipe.id, disciple.id);
    return {
      state: draft.view(),
      outcome: {
        pillId: recipe.id,
        pillName: recipe.name,
        discipleId: disciple.id,
        discipleName: disciple.name,
        effect: { kind: 'cultivation', gain },
      },
    };
  }

  // bodyTemperingPill
  const uses = Number(disciple.body_tempering_count);
  if (uses >= BODY_TEMPERING_MAX_USES) {
    throw new AppError(
      'INVALID_STATUS',
      `${disciple.name}已服用淬体丹 ${BODY_TEMPERING_MAX_USES} 次，药力已满`,
    );
  }
  const target = bodyTemperingTarget(
    Number(disciple.attack),
    Number(disciple.defense),
    Number(disciple.speed),
  );
  if (target === null) {
    throw new AppError('INVALID_STATUS', `${disciple.name}没有需要补齐的属性短板`);
  }
  draft.requirePill(recipe.id);
  const nextValue = Number(disciple[target.attribute]) + target.gain;
  const nextUses = uses + 1;
  disciple[target.attribute] = nextValue;
  disciple.body_tempering_count = nextUses;
  draft.addStatement(
    updateDiscipleBodyTemperingStatement(disciple.id, target.attribute, nextValue, nextUses),
  );
  await draft.commitAlchemy(recipe.id, disciple.id);
  return {
    state: draft.view(),
    outcome: {
      pillId: recipe.id,
      pillName: recipe.name,
      discipleId: disciple.id,
      discipleName: disciple.name,
      effect: { kind: 'bodyTempering', gain: target.gain, attribute: target.attribute },
    },
  };
}
