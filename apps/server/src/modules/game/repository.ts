import { ParamRepository, type ParameterizedQuery } from '../../infra/db/repository';

/**
 * 游戏仓储（一次性可玩版本）。
 *
 * 说明：本版本「读状态 → 算结果 → 写回去」，写操作由 service 组装成**一次** D1 batch。
 * 因此这里除了读方法（await），还提供纯函数形式的语句构造器（`...Statement`）——
 * batch 需要的是 D1PreparedStatement，而不是已 await 的结果。
 */

export interface SectRow {
  id: string;
  user_id: string;
  name: string;
  level: number;
  vein_level: number;
  /** 声望（V3 切磋胜利 +10）；排行榜排序与顶栏展示用。 */
  reputation: number;
  last_settled_at: number;
  recruit_date_key: string;
  recruit_count: number;
  created_at: number;
}

export interface DiscipleRow {
  id: string;
  sect_id: string;
  name: string;
  gender: string;
  aptitude: number;
  /** V4 战斗属性（1~100）与天赋 id；战力与产出加成来源。 */
  attack: number;
  defense: number;
  speed: number;
  talent: string;
  realm_id: string;
  stage: number;
  cultivation: number;
  cultivation_remainder: number;
  assignment: string;
  injured_until: number | null;
  created_at: number;
}

export interface BuildingRow {
  id: string;
  sect_id: string;
  def_id: string;
  level: number;
  created_at: number;
}

export interface ResourceBalanceRow {
  id: string;
  sect_id: string;
  resource_id: string;
  balance: number;
  remainder: number;
  updated_at: number;
}

export interface EventLogRow {
  id: string;
  sect_id: string;
  event_id: string;
  description: string;
  /** JSON：resourceId -> 带符号的最小单位数量字符串。 */
  effects: string;
  created_at: number;
}

export interface ExplorationRow {
  id: string;
  sect_id: string;
  realm_id: string;
  /** JSON 数组字符串：本次派遣的弟子 id。 */
  party: string;
  /** 0=失败，1=成功。 */
  success: number;
  /** JSON 对象字符串：成功时的实际奖励（resourceId -> 最小单位数量字符串）。 */
  rewards: string;
  created_at: number;
}

/** 切磋记录行（V3 第四节）；result 从攻方视角：'win' | 'lose' | 'draw'。 */
export interface SparringLogRow {
  id: string;
  attacker_sect_id: string;
  defender_sect_id: string;
  attacker_disciple_id: string;
  defender_disciple_id: string;
  attacker_power: number;
  defender_power: number;
  result: string;
  reputation_gained: number;
  created_at: number;
}

export class SectRepository extends ParamRepository {
  async findByUserId(userId: string): Promise<SectRow | null> {
    return this.one<SectRow>({
      sql: `SELECT id, user_id, name, level, vein_level, reputation, last_settled_at, recruit_date_key, recruit_count, created_at
            FROM sects WHERE user_id = ?`,
      params: [userId],
    });
  }

  /** 排行榜用：全部宗门，按综合榜顺序（等级 DESC → 声望 DESC → 创建时间 ASC）。 */
  async findAll(): Promise<SectRow[]> {
    return this.all<SectRow>({
      sql: `SELECT id, user_id, name, level, vein_level, reputation, last_settled_at,
                   recruit_date_key, recruit_count, created_at
            FROM sects ORDER BY level DESC, reputation DESC, created_at ASC`,
      params: [],
    });
  }

  /** 公开档案 / 切磋用：按 id 查单个宗门。 */
  async findById(sectId: string): Promise<SectRow | null> {
    return this.one<SectRow>({
      sql: `SELECT id, user_id, name, level, vein_level, reputation, last_settled_at,
                   recruit_date_key, recruit_count, created_at
            FROM sects WHERE id = ?`,
      params: [sectId],
    });
  }
}

export class DiscipleRepository extends ParamRepository {
  async findBySectId(sectId: string): Promise<DiscipleRow[]> {
    return this.all<DiscipleRow>({
      sql: `SELECT id, sect_id, name, gender, aptitude, attack, defense, speed, talent,
                   realm_id, stage, cultivation, cultivation_remainder,
                   assignment, injured_until, created_at
            FROM disciples WHERE sect_id = ? ORDER BY created_at ASC, id ASC`,
      params: [sectId],
    });
  }

  async findById(discipleId: string): Promise<DiscipleRow | null> {
    return this.one<DiscipleRow>({
      sql: `SELECT id, sect_id, name, gender, aptitude, attack, defense, speed, talent,
                   realm_id, stage, cultivation, cultivation_remainder,
                   assignment, injured_until, created_at
            FROM disciples WHERE id = ?`,
      params: [discipleId],
    });
  }

  async countBySectId(sectId: string): Promise<number> {
    const row = await this.one<{ total: number }>({
      sql: 'SELECT COUNT(*) AS total FROM disciples WHERE sect_id = ?',
      params: [sectId],
    });
    return Number(row?.total ?? 0);
  }
}

export class BuildingRepository extends ParamRepository {
  async findBySectId(sectId: string): Promise<BuildingRow[]> {
    return this.all<BuildingRow>({
      sql: 'SELECT id, sect_id, def_id, level, created_at FROM buildings WHERE sect_id = ? ORDER BY created_at ASC, id ASC',
      params: [sectId],
    });
  }
}

export class ResourceBalanceRepository extends ParamRepository {
  async findBySectId(sectId: string): Promise<ResourceBalanceRow[]> {
    return this.all<ResourceBalanceRow>({
      sql: `SELECT id, sect_id, resource_id, balance, remainder, updated_at
            FROM resource_balances WHERE sect_id = ? ORDER BY resource_id ASC`,
      params: [sectId],
    });
  }
}

export class EventLogRepository extends ParamRepository {
  /** 最近触发的事件（新的在前）；name 由事件定义按 event_id 反查。 */
  async findRecentBySectId(sectId: string, limit: number): Promise<EventLogRow[]> {
    return this.all<EventLogRow>({
      sql: `SELECT id, sect_id, event_id, description, effects, created_at
            FROM event_log WHERE sect_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
      params: [sectId, limit],
    });
  }
}

export class ExplorationRepository extends ParamRepository {
  /** 今日（UTC+8 自然日窗口，created_at >= dayStartMs）该宗门在指定秘境的探索次数。 */
  async countTodayBySectAndRealm(
    sectId: string,
    realmId: string,
    dayStartMs: number,
  ): Promise<number> {
    const row = await this.one<{ total: number }>({
      sql: 'SELECT COUNT(*) AS total FROM explorations WHERE sect_id = ? AND realm_id = ? AND created_at >= ?',
      params: [sectId, realmId, dayStartMs],
    });
    return Number(row?.total ?? 0);
  }

  /** 最近探索记录（新的在前）。 */
  async findRecentBySectId(sectId: string, limit: number): Promise<ExplorationRow[]> {
    return this.all<ExplorationRow>({
      sql: `SELECT id, sect_id, realm_id, party, success, rewards, created_at
            FROM explorations WHERE sect_id = ? ORDER BY created_at DESC LIMIT ?`,
      params: [sectId, limit],
    });
  }
}

/** 切磋记录（V3 第四节）：只做每日限次的窗口统计与写入，排行/展示不读它。 */
export class SparringRepository extends ParamRepository {
  /** 今日（UTC+8 自然日窗口，created_at >= dayStartMs）该宗门作为攻方的切磋次数。 */
  async countTodayByAttacker(sectId: string, dayStartMs: number): Promise<number> {
    const row = await this.one<{ total: number }>({
      sql: 'SELECT COUNT(*) AS total FROM sparring_log WHERE attacker_sect_id = ? AND created_at >= ?',
      params: [sectId, dayStartMs],
    });
    return Number(row?.total ?? 0);
  }

  /** 今日该攻方对同一防方的切磋次数（同目标每日 1 次）。 */
  async countTodayByPair(
    attackerSectId: string,
    defenderSectId: string,
    dayStartMs: number,
  ): Promise<number> {
    const row = await this.one<{ total: number }>({
      sql: 'SELECT COUNT(*) AS total FROM sparring_log WHERE attacker_sect_id = ? AND defender_sect_id = ? AND created_at >= ?',
      params: [attackerSectId, defenderSectId, dayStartMs],
    });
    return Number(row?.total ?? 0);
  }
}

export interface NewDisciple {
  id: string;
  sectId: string;
  name: string;
  gender: string;
  aptitude: number;
  attack: number;
  defense: number;
  speed: number;
  talent: string;
  realmId: string;
  stage: number;
  assignment: string;
  now: number;
}

export interface NewBuilding {
  id: string;
  sectId: string;
  defId: string;
  level: number;
  now: number;
}

export interface NewResourceBalance {
  id: string;
  sectId: string;
  resourceId: string;
  balance: number;
  remainder: number;
  now: number;
}

export interface NewEventLog {
  id: string;
  sectId: string;
  eventId: string;
  description: string;
  /** JSON：resourceId -> 带符号的最小单位数量字符串。 */
  effects: string;
  now: number;
}

export function insertSectStatement(row: {
  id: string;
  userId: string;
  name: string;
  level: number;
  veinLevel: number;
  now: number;
}): ParameterizedQuery {
  return {
    sql: `INSERT INTO sects (id, user_id, name, level, vein_level, last_settled_at, recruit_date_key, recruit_count, created_at)
          VALUES (?, ?, ?, ?, ?, ?, '', 0, ?)`,
    params: [row.id, row.userId, row.name, row.level, row.veinLevel, row.now, row.now],
  };
}

export function insertDiscipleStatement(row: NewDisciple): ParameterizedQuery {
  return {
    sql: `INSERT INTO disciples
            (id, sect_id, name, gender, aptitude, attack, defense, speed, talent,
             realm_id, stage, cultivation, cultivation_remainder, assignment, injured_until, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, NULL, ?)`,
    params: [
      row.id,
      row.sectId,
      row.name,
      row.gender,
      row.aptitude,
      row.attack,
      row.defense,
      row.speed,
      row.talent,
      row.realmId,
      row.stage,
      row.assignment,
      row.now,
    ],
  };
}

export function insertBuildingStatement(row: NewBuilding): ParameterizedQuery {
  return {
    sql: `INSERT INTO buildings (id, sect_id, def_id, level, created_at) VALUES (?, ?, ?, ?, ?)`,
    params: [row.id, row.sectId, row.defId, row.level, row.now],
  };
}

export function insertResourceBalanceStatement(row: NewResourceBalance): ParameterizedQuery {
  return {
    sql: `INSERT INTO resource_balances (id, sect_id, resource_id, balance, remainder, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
    params: [row.id, row.sectId, row.resourceId, row.balance, row.remainder, row.now],
  };
}

export function insertEventLogStatement(row: NewEventLog): ParameterizedQuery {
  return {
    sql: `INSERT INTO event_log (id, sect_id, event_id, description, effects, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
    params: [row.id, row.sectId, row.eventId, row.description, row.effects, row.now],
  };
}

export function insertExplorationStatement(row: {
  id: string;
  sectId: string;
  realmId: string;
  /** JSON 数组字符串。 */
  party: string;
  success: boolean;
  /** JSON 对象字符串：成功时的实际奖励。 */
  rewards: string;
  now: number;
}): ParameterizedQuery {
  return {
    sql: `INSERT INTO explorations (id, sect_id, realm_id, party, success, rewards, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    params: [row.id, row.sectId, row.realmId, row.party, row.success ? 1 : 0, row.rewards, row.now],
  };
}

/** 结算写回：宗门最后结算时间 + 招募计数（计数为 null 时不变）。 */
export function updateSectSettledStatement(
  sectId: string,
  lastSettledAt: number,
  recruit?: { dateKey: string; count: number },
): ParameterizedQuery {
  if (recruit === undefined) {
    return {
      sql: 'UPDATE sects SET last_settled_at = ? WHERE id = ?',
      params: [lastSettledAt, sectId],
    };
  }
  return {
    sql: 'UPDATE sects SET last_settled_at = ?, recruit_date_key = ?, recruit_count = ? WHERE id = ?',
    params: [lastSettledAt, recruit.dateKey, recruit.count, sectId],
  };
}

/** 宗门升级写回：只改等级（条件判定与容量重算在 service/view 层）。 */
export function updateSectLevelStatement(sectId: string, level: number): ParameterizedQuery {
  return {
    sql: 'UPDATE sects SET level = ? WHERE id = ?',
    params: [level, sectId],
  };
}

/** 结算写回：资源余额与余数。 */
export function updateResourceSettledStatement(
  row: ResourceBalanceRow,
  balance: number,
  remainder: number,
  now: number,
): ParameterizedQuery {
  return {
    sql: 'UPDATE resource_balances SET balance = ?, remainder = ?, updated_at = ? WHERE id = ?',
    params: [balance, remainder, now, row.id],
  };
}

/** 结算写回：弟子修为与余数。 */
export function updateDiscipleCultivationStatement(
  discipleId: string,
  cultivation: number,
  remainder: number,
): ParameterizedQuery {
  return {
    sql: 'UPDATE disciples SET cultivation = ?, cultivation_remainder = ? WHERE id = ?',
    params: [cultivation, remainder, discipleId],
  };
}

/** 资源增减（消耗用负数），只用于已经检查过余额的场景。 */
export function resourceDeltaStatement(
  sectId: string,
  resourceId: string,
  delta: number,
  now: number,
): ParameterizedQuery {
  return {
    sql: 'UPDATE resource_balances SET balance = balance + ?, updated_at = ? WHERE sect_id = ? AND resource_id = ?',
    params: [delta, now, sectId, resourceId],
  };
}

export function updateDiscipleAssignmentStatement(discipleId: string, assignment: string): ParameterizedQuery {
  return {
    sql: 'UPDATE disciples SET assignment = ? WHERE id = ?',
    params: [assignment, discipleId],
  };
}

export function updateBuildingLevelStatement(buildingId: string, level: number): ParameterizedQuery {
  return {
    sql: 'UPDATE buildings SET level = ? WHERE id = ?',
    params: [level, buildingId],
  };
}

/** 突破结果写回：境界/阶段/修为/余数/伤势冷却。 */
export function updateDiscipleProgressStatement(
  discipleId: string,
  progress: {
    realmId: string;
    stage: number;
    cultivation: number;
    remainder: number;
    injuredUntil: number | null;
  },
): ParameterizedQuery {
  return {
    sql: `UPDATE disciples
          SET realm_id = ?, stage = ?, cultivation = ?, cultivation_remainder = ?, injured_until = ?
          WHERE id = ?`,
    params: [
      progress.realmId,
      progress.stage,
      progress.cultivation,
      progress.remainder,
      progress.injuredUntil,
      discipleId,
    ],
  };
}

/** 探索失败写回：只改伤势冷却，**不**碰境界/阶段/修为（与突破写回区分开）。 */
export function updateDiscipleInjuryStatement(
  discipleId: string,
  injuredUntil: number,
): ParameterizedQuery {
  return {
    sql: 'UPDATE disciples SET injured_until = ? WHERE id = ?',
    params: [injuredUntil, discipleId],
  };
}

/** 招募计数写回（每日次数按 UTC+8 自然日重置）。 */
export function updateSectRecruitCounterStatement(
  sectId: string,
  dateKey: string,
  count: number,
): ParameterizedQuery {
  return {
    sql: 'UPDATE sects SET recruit_date_key = ?, recruit_count = ? WHERE id = ?',
    params: [dateKey, count, sectId],
  };
}

/** 切磋记录写入（V3 第四节）。 */
export function insertSparringLogStatement(row: {
  id: string;
  attackerSectId: string;
  defenderSectId: string;
  attackerDiscipleId: string;
  defenderDiscipleId: string;
  attackerPower: number;
  defenderPower: number;
  result: string;
  reputationGained: number;
  now: number;
}): ParameterizedQuery {
  return {
    sql: `INSERT INTO sparring_log (id, attacker_sect_id, defender_sect_id, attacker_disciple_id,
            defender_disciple_id, attacker_power, defender_power, result, reputation_gained, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      row.id,
      row.attackerSectId,
      row.defenderSectId,
      row.attackerDiscipleId,
      row.defenderDiscipleId,
      row.attackerPower,
      row.defenderPower,
      row.result,
      row.reputationGained,
      row.now,
    ],
  };
}

/** 声望增减（切磋胜利 +10）；与资源写回同一 batch。 */
export function updateSectReputationStatement(sectId: string, delta: number): ParameterizedQuery {
  return {
    sql: 'UPDATE sects SET reputation = reputation + ? WHERE id = ?',
    params: [delta, sectId],
  };
}
