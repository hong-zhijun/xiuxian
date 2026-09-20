import { ParamRepository, type ParameterizedQuery } from '../../infra/db/repository';

import type { PillAttribute } from './alchemy';

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
  /** V5.2 招贤刷新：上次授予额度的宗门等级（与 level 不一致即视为重置）。 */
  recruit_refresh_level: number;
  /** V5.2 招贤刷新：该等级已用的刷新次数（升级重置，不累积）。 */
  recruit_refresh_used: number;
  /** V5 守擂阵容：3 个弟子 id 的 JSON 数组字符串；null = 未设置（不可被挑战）。 */
  defense_lineup: string | null;
  /** 0012 挑战优化：当日已受理场次的 UTC+8 日期键；'' = 尚无新口径计数（迁移前宗门）。 */
  challenge_date_key: string;
  /** 0012 挑战优化：challenge_date_key 对应日期内已受理的挑战场次。 */
  challenge_count: number;
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
  /** 已服用淬体丹次数（上限 BODY_TEMPERING_MAX_USES，见 alchemy.ts）。 */
  body_tempering_count: number;
  /** 0013 掌门私有备注（单行纯文本，≤60 字；只进登录玩家自己的视图）。 */
  note: string;
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

/**
 * 挑战记录行（V5 第三节）；result 从攻方视角：'win' | 'lose'。
 * attacker_lineup / defender_lineup / rounds 是 JSON 字符串快照（见 0009 迁移）。
 * 0012 起新增可空快照列（双方等级 / 奖励档位 / 守擂方式 / 日期键）；旧行这些列为 NULL。
 */
export interface ChallengeLogRow {
  id: string;
  attacker_sect_id: string;
  defender_sect_id: string;
  attacker_lineup: string;
  defender_lineup: string;
  rounds: string;
  result: string;
  reputation_gained: number;
  spirit_stone_gained: number;
  /** 开战时攻方宗门等级；旧记录为 null。 */
  attacker_level: number | null;
  /** 开战时守方宗门等级；旧记录为 null。 */
  defender_level: number | null;
  /** 开战时的奖励档位标识（challenge.ts 的 RewardTier）；旧记录为 null。 */
  reward_tier: string | null;
  /** 'configured' | 'automatic'；旧记录为 null。 */
  defense_mode: string | null;
  /** 本场对应的 UTC+8 日期键；旧记录为 null。 */
  challenge_date_key: string | null;
  created_at: number;
}

export class SectRepository extends ParamRepository {
  async findByUserId(userId: string): Promise<SectRow | null> {
    return this.one<SectRow>({
      sql: `SELECT id, user_id, name, level, vein_level, reputation, last_settled_at, recruit_date_key, recruit_count, recruit_refresh_level, recruit_refresh_used, created_at, defense_lineup, challenge_date_key, challenge_count
            FROM sects WHERE user_id = ?`,
      params: [userId],
    });
  }

  /** 排行榜用：全部宗门，按综合榜顺序（等级 DESC → 声望 DESC → 创建时间 ASC）。 */
  async findAll(): Promise<SectRow[]> {
    return this.all<SectRow>({
      sql: `SELECT id, user_id, name, level, vein_level, reputation, last_settled_at,
                   recruit_date_key, recruit_count, recruit_refresh_level, recruit_refresh_used, created_at, defense_lineup, challenge_date_key, challenge_count
            FROM sects ORDER BY level DESC, reputation DESC, created_at ASC`,
      params: [],
    });
  }

  /** 公开档案 / 切磋用：按 id 查单个宗门。 */
  async findById(sectId: string): Promise<SectRow | null> {
    return this.one<SectRow>({
      sql: `SELECT id, user_id, name, level, vein_level, reputation, last_settled_at,
                   recruit_date_key, recruit_count, recruit_refresh_level, recruit_refresh_used, created_at, defense_lineup, challenge_date_key, challenge_count
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
                   assignment, injured_until, body_tempering_count, note, created_at
            FROM disciples WHERE sect_id = ? ORDER BY created_at ASC, id ASC`,
      params: [sectId],
    });
  }

  async findById(discipleId: string): Promise<DiscipleRow | null> {
    return this.one<DiscipleRow>({
      sql: `SELECT id, sect_id, name, gender, aptitude, attack, defense, speed, talent,
                   realm_id, stage, cultivation, cultivation_remainder,
                   assignment, injured_until, body_tempering_count, note, created_at
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

/**
 * 丹药库存行（0011 迁移）：同一宗门同一 pill_id 只有一行（UNIQUE 约束）。
 * quantity 是非负整数，没有行视为 0；pill_id 是代码常量（alchemy.ts），不建外键。
 */
export interface PillInventoryRow {
  id: string;
  sect_id: string;
  pill_id: string;
  quantity: number;
  updated_at: number;
}

export class PillInventoryRepository extends ParamRepository {
  async findBySectId(sectId: string): Promise<PillInventoryRow[]> {
    return this.all<PillInventoryRow>({
      sql: `SELECT id, sect_id, pill_id, quantity, updated_at
            FROM pill_inventories WHERE sect_id = ? ORDER BY pill_id ASC`,
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

  /** 该宗门参与的切磋记录（攻/守都算），新的在前。 */
  async findBySectId(sectId: string, limit: number): Promise<SparringLogRow[]> {
    return this.all<SparringLogRow>({
      sql: `SELECT id, attacker_sect_id, defender_sect_id, attacker_disciple_id, defender_disciple_id,
                   attacker_power, defender_power, result, reputation_gained, created_at
            FROM sparring_log
            WHERE attacker_sect_id = ? OR defender_sect_id = ?
            ORDER BY created_at DESC LIMIT ?`,
      params: [sectId, sectId, limit],
    });
  }

  /** 该宗门的胜负统计（作为攻方的战绩）。 */
  async statsBySectId(sectId: string): Promise<{ wins: number; losses: number; draws: number }> {
    const rows = await this.all<{ result: string; cnt: number }>({
      sql: `SELECT result, COUNT(*) AS cnt FROM sparring_log
            WHERE attacker_sect_id = ? GROUP BY result`,
      params: [sectId],
    });
    let wins = 0, losses = 0, draws = 0;
    for (const row of rows) {
      if (row.result === 'win') wins = Number(row.cnt);
      else if (row.result === 'lose') losses = Number(row.cnt);
      else draws = Number(row.cnt);
    }
    return { wins, losses, draws };
  }
}

/**
 * 挑战记录（V5 第三节）：每日限次的窗口统计、演武录展示与胜负统计。
 *
 * 与旧 SparringRepository 的区别：每日限次只按攻方（挑战发起方）统计；
 * 胜负统计要把「被挑战」的记录从守方视角翻转。
 */
export class ChallengeRepository extends ParamRepository {
  /**
   * 该宗门今日（UTC+8）已受理的挑战场次，兼容 0012 迁移前的旧记录：
   * 新记录带 challenge_date_key，旧记录只有 created_at —— 两种口径都算「今天」。
   * 只在宗门行的日期键不是今天时作为兼容核对使用（正常路径读 sects.challenge_count）。
   */
  async countTodayByAttacker(sectId: string, dateKey: string, dayStartMs: number): Promise<number> {
    const row = await this.one<{ total: number }>({
      sql: `SELECT COUNT(*) AS total FROM challenge_log
            WHERE attacker_sect_id = ?
              AND (challenge_date_key = ? OR (challenge_date_key IS NULL AND created_at >= ?))`,
      params: [sectId, dateKey, dayStartMs],
    });
    return Number(row?.total ?? 0);
  }

  /** 今日是否已挑战过指定目标（同一攻方对同一守方每天最多 1 场；兼容旧记录日窗口）。 */
  async hasChallengedTargetToday(
    attackerSectId: string,
    defenderSectId: string,
    dateKey: string,
    dayStartMs: number,
  ): Promise<boolean> {
    const row = await this.one<{ total: number }>({
      sql: `SELECT COUNT(*) AS total FROM challenge_log
            WHERE attacker_sect_id = ? AND defender_sect_id = ?
              AND (challenge_date_key = ? OR (challenge_date_key IS NULL AND created_at >= ?))`,
      params: [attackerSectId, defenderSectId, dateKey, dayStartMs],
    });
    return Number(row?.total ?? 0) > 0;
  }

  /** 该宗门参与的挑战记录（攻/守都算），新的在前。 */
  async findBySectId(sectId: string, limit: number): Promise<ChallengeLogRow[]> {
    return this.all<ChallengeLogRow>({
      sql: `SELECT * FROM challenge_log
            WHERE attacker_sect_id = ? OR defender_sect_id = ?
            ORDER BY created_at DESC LIMIT ?`,
      params: [sectId, sectId, limit],
    });
  }

  /** 该宗门的胜负统计（从自身视角；被挑战的记录要翻转结果）。 */
  async statsBySectId(sectId: string): Promise<{ wins: number; losses: number }> {
    const atkRows = await this.all<{ result: string; cnt: number }>({
      sql: 'SELECT result, COUNT(*) AS cnt FROM challenge_log WHERE attacker_sect_id = ? GROUP BY result',
      params: [sectId],
    });
    const defRows = await this.all<{ result: string; cnt: number }>({
      sql: 'SELECT result, COUNT(*) AS cnt FROM challenge_log WHERE defender_sect_id = ? GROUP BY result',
      params: [sectId],
    });
    let wins = 0;
    let losses = 0;
    for (const row of atkRows) {
      if (row.result === 'win') wins += Number(row.cnt);
      else losses += Number(row.cnt);
    }
    for (const row of defRows) {
      // 守方：攻方 win = 我方 lose，攻方 lose = 我方 win。
      if (row.result === 'win') losses += Number(row.cnt);
      else wins += Number(row.cnt);
    }
    return { wins, losses };
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
  /** 淬体丹服用次数；新建弟子一律传 0。 */
  bodyTemperingCount: number;
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
             realm_id, stage, cultivation, cultivation_remainder, assignment, injured_until,
             body_tempering_count, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, NULL, ?, ?)`,
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
      row.bodyTemperingCount,
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

/**
 * 探索失败写回：只改伤势冷却，**不**碰境界/阶段/修为（与突破写回区分开）。
 * 传 null 表示清除伤势（回春丹），与设置冷却共用同一条 UPDATE。
 */
export function updateDiscipleInjuryStatement(
  discipleId: string,
  injuredUntil: number | null,
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
 
/**
 * 招贤刷新写回（V5.2）：记录「本次授予额度的宗门等级 + 该等级已用刷新次数」。
 * 升级后 level 变化即视为重置（归一化在 service 层），这里只写新的等级与已用次数。
 */
export function updateSectRecruitRefreshStatement(
  sectId: string,
  level: number,
  used: number,
): ParameterizedQuery {
  return {
    sql: 'UPDATE sects SET recruit_refresh_level = ?, recruit_refresh_used = ? WHERE id = ?',
    params: [level, used, sectId],
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

/**
 * 守擂阵容写回（V5 2.2 / 0013）：defense_lineup 是弟子 id 数组的 JSON 字符串；
 * 传 null = 清空阵容（驱逐守擂成员时与删除弟子同一 batch 写入）。
 */
export function updateSectDefenseLineupStatement(
  sectId: string,
  lineupJson: string | null,
): ParameterizedQuery {
  return {
    sql: 'UPDATE sects SET defense_lineup = ? WHERE id = ?',
    params: [lineupJson, sectId],
  };
}

/**
 * 0013 备注写回：note 已在服务层 trim 并校验（≤60 字、单行、无控制字符）。
 * 与驱逐删除保持一致用 `id + sect_id` 双条件：身份写错行时影响 0 行（批内快照守卫再兜一层）。
 */
export function updateDiscipleNoteStatement(
  discipleId: string,
  sectId: string,
  note: string,
): ParameterizedQuery {
  return {
    sql: 'UPDATE disciples SET note = ? WHERE id = ? AND sect_id = ?',
    params: [note, discipleId, sectId],
  };
}

/** 0013 驱逐：id + sect_id 双条件删除；弟子已不属于本宗时影响 0 行（配合快照守卫兜底）。 */
export function deleteDiscipleStatement(discipleId: string, sectId: string): ParameterizedQuery {
  return {
    sql: 'DELETE FROM disciples WHERE id = ? AND sect_id = ?',
    params: [discipleId, sectId],
  };
}

/**
 * 挑战记录写入（V5 第三节）：阵容与每轮结果都是 JSON 字符串快照。
 * 0012 起同时写入开战快照（双方等级 / 奖励档位 / 守擂方式 / 日期键）。
 */
export function insertChallengeLogStatement(row: {
  id: string;
  attackerSectId: string;
  defenderSectId: string;
  attackerLineup: string;
  defenderLineup: string;
  rounds: string;
  result: string;
  reputationGained: number;
  spiritStoneGained: number;
  /** 开战快照：攻方宗门等级。 */
  attackerLevel: number;
  /** 开战快照：守方宗门等级。 */
  defenderLevel: number;
  /** 开战快照：奖励档位标识（challenge.ts 的 RewardTier）。 */
  rewardTier: string;
  /** 开战快照：守擂方式（'configured' | 'automatic'）。 */
  defenseMode: string;
  /** 本场 UTC+8 日期键（唯一部分索引据此防同日重复目标）。 */
  challengeDateKey: string;
  now: number;
}): ParameterizedQuery {
  return {
    sql: `INSERT INTO challenge_log (id, attacker_sect_id, defender_sect_id, attacker_lineup,
            defender_lineup, rounds, result, reputation_gained, spirit_stone_gained,
            attacker_level, defender_level, reward_tier, defense_mode, challenge_date_key, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      row.id,
      row.attackerSectId,
      row.defenderSectId,
      row.attackerLineup,
      row.defenderLineup,
      row.rounds,
      row.result,
      row.reputationGained,
      row.spiritStoneGained,
      row.attackerLevel,
      row.defenderLevel,
      row.rewardTier,
      row.defenseMode,
      row.challengeDateKey,
      row.now,
    ],
  };
}

/**
 * 挑战计数写回（0012）：受理一场战斗时把攻方的日期键归一到今天、计数 +1。
 * 条件判断在 mutation_guards 快照语句里完成（batch 首条），这里只负责写入。
 */
export function updateSectChallengeCounterStatement(
  sectId: string,
  dateKey: string,
  count: number,
): ParameterizedQuery {
  return {
    sql: 'UPDATE sects SET challenge_date_key = ?, challenge_count = ? WHERE id = ?',
    params: [dateKey, count, sectId],
  };
}

/**
 * 挑战 batch 的首条语句（与炼丹的 alchemySnapshotGuardStatement 同一模式）：
 * 快照过期时插入 valid=0 触发 mutation_guards 的 CHECK，让同批的结算、计数、奖励、
 * 日志一起回滚。校验攻方宗门行（等级/声望/结算时间/挑战日期键/计数）、全部资源余额、
 * 攻方出战弟子仍属于本宗（0013：与驱逐交错时不出现幽灵出战），以及守方宗门的等级
 * 与守擂阵容（奖励档位与阵容都以开战快照为准）。
 */
export function challengeSnapshotGuardStatement(
  commandId: string,
  snapshot: {
    sect: SectRow;
    balances: readonly ResourceBalanceRow[];
    members: readonly { id: string }[];
    target: {
      id: string;
      level: number;
      defenseLineup: string | null;
    };
  },
): ParameterizedQuery {
  const { sect, balances, members, target } = snapshot;
  const checks = [
    `EXISTS (SELECT 1 FROM sects WHERE id = ? AND level = ? AND reputation = ?
      AND last_settled_at = ? AND challenge_date_key = ? AND challenge_count = ?)`,
    `EXISTS (SELECT 1 FROM sects WHERE id = ? AND level = ? AND defense_lineup IS ?)`,
  ];
  const params: (string | number | null)[] = [
    commandId,
    sect.id, sect.level, sect.reputation,
    sect.last_settled_at, sect.challenge_date_key, sect.challenge_count,
    target.id, target.level, target.defenseLineup,
  ];

  for (const row of balances) {
    checks.push(
      'EXISTS (SELECT 1 FROM resource_balances WHERE id = ? AND sect_id = ? AND balance = ? AND remainder = ?)',
    );
    params.push(row.id, sect.id, row.balance, row.remainder);
  }
  for (const member of members) {
    checks.push('EXISTS (SELECT 1 FROM disciples WHERE id = ? AND sect_id = ?)');
    params.push(member.id, sect.id);
  }

  return {
    sql: `INSERT INTO mutation_guards (command_id, valid)
          SELECT ?, CASE WHEN ${checks.join(' AND ')} THEN 1 ELSE 0 END`,
    params,
  };
}

export function deleteChallengeSnapshotGuardStatement(commandId: string): ParameterizedQuery {
  return {
    sql: 'DELETE FROM mutation_guards WHERE command_id = ?',
    params: [commandId],
  };
}

/* ---------- 丹药系统（0011 迁移 + alchemy.ts） ---------- */

/**
 * 库存 upsert：首次炼制创建行；同一 (sect_id, pill_id) 重复炼制复用同一行
 * （UNIQUE 冲突时改写 quantity / updated_at），保证每宗门每丹药只有一条库存记录。
 */
export function upsertPillInventoryStatement(
  sectId: string,
  pillId: string,
  quantity: number,
  now: number,
): ParameterizedQuery {
  return {
    sql: `INSERT INTO pill_inventories (id, sect_id, pill_id, quantity, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (sect_id, pill_id)
          DO UPDATE SET quantity = excluded.quantity, updated_at = excluded.updated_at`,
    params: [crypto.randomUUID(), sectId, pillId, quantity, now],
  };
}

/** 库存数量写回（服用后减 1）；只用于库存行已存在且数量已检查过的场景。 */
export function updatePillInventoryQuantityStatement(
  row: PillInventoryRow,
  quantity: number,
  now: number,
): ParameterizedQuery {
  return {
    sql: 'UPDATE pill_inventories SET quantity = ?, updated_at = ? WHERE id = ?',
    params: [quantity, now, row.id],
  };
}

/**
 * 淬体丹写回：只更新补短板的那一个属性列 + 服用次数。
 * 列名来自 PillAttribute 的固定映射（不拼用户输入），一次只改一列。
 */
export function updateDiscipleBodyTemperingStatement(
  discipleId: string,
  attribute: PillAttribute,
  attributeValue: number,
  bodyTemperingCount: number,
): ParameterizedQuery {
  const column =
    attribute === 'attack' ? 'attack' : attribute === 'defense' ? 'defense' : 'speed';
  return {
    sql: `UPDATE disciples SET ${column} = ?, body_tempering_count = ? WHERE id = ?`,
    params: [attributeValue, bodyTemperingCount, discipleId],
  };
}

/**
 * 炼丹 batch 的首条语句：快照过期时插入 valid=0，触发 mutation_guards 的 CHECK，
 * 让同批的结算、资源扣减、库存和弟子更新一起回滚。
 */
export function alchemySnapshotGuardStatement(
  commandId: string,
  snapshot: {
    sect: SectRow;
    balances: readonly ResourceBalanceRow[];
    buildings: readonly BuildingRow[];
    pillId: string;
    pillQuantity: number;
    disciple?: DiscipleRow;
  },
): ParameterizedQuery {
  const { sect, balances, buildings, pillId, pillQuantity, disciple } = snapshot;
  const checks = [
    'EXISTS (SELECT 1 FROM sects WHERE id = ? AND level = ? AND last_settled_at = ?)',
    'COALESCE((SELECT quantity FROM pill_inventories WHERE sect_id = ? AND pill_id = ?), 0) = ?',
  ];
  const params: (string | number | null)[] = [
    commandId,
    sect.id, sect.level, sect.last_settled_at,
    sect.id, pillId, pillQuantity,
  ];

  for (const row of balances) {
    checks.push('EXISTS (SELECT 1 FROM resource_balances WHERE id = ? AND sect_id = ? AND balance = ? AND remainder = ?)');
    params.push(row.id, sect.id, row.balance, row.remainder);
  }
  for (const row of buildings) {
    checks.push('EXISTS (SELECT 1 FROM buildings WHERE id = ? AND sect_id = ? AND level = ?)');
    params.push(row.id, sect.id, row.level);
  }
  if (disciple !== undefined) {
    checks.push(`EXISTS (SELECT 1 FROM disciples WHERE id = ? AND sect_id = ?
      AND realm_id = ? AND stage = ? AND cultivation = ? AND cultivation_remainder = ?
      AND attack = ? AND defense = ? AND speed = ? AND body_tempering_count = ?
      AND injured_until IS ? AND assignment = ?)`);
    params.push(
      disciple.id, sect.id, disciple.realm_id, disciple.stage,
      disciple.cultivation, disciple.cultivation_remainder,
      disciple.attack, disciple.defense, disciple.speed, disciple.body_tempering_count,
      disciple.injured_until, disciple.assignment,
    );
  }

  return {
    sql: `INSERT INTO mutation_guards (command_id, valid)
          SELECT ?, CASE WHEN ${checks.join(' AND ')} THEN 1 ELSE 0 END`,
    params,
  };
}

export function deleteAlchemySnapshotGuardStatement(commandId: string): ParameterizedQuery {
  return {
    sql: 'DELETE FROM mutation_guards WHERE command_id = ?',
    params: [commandId],
  };
}

/* ---------- 弟子管理（0013 迁移：备注 / 驱逐 / 布阵的快照守卫） ---------- */

/**
 * 弟子命令 batch 的首条语句（与炼丹/挑战守卫同一模式）：快照过期时插入 valid=0，
 * 触发 mutation_guards 的 CHECK，让同批的结算写回与命令写入一起回滚。
 *
 * 校验：
 * - 宗门行（等级/结算时间）与全部资源余额：防止与任何并发命令双重结算；
 * - members 每名弟子仍属于本宗：备注/驱逐/布阵提交时的成员有效性核对，
 *   驱逐与服药/布阵/挑战交错时不会出现幽灵成功或失效手动阵容；
 * - defenseLineup（可选）：读到的守擂阵容快照在提交时未变（驱逐守擂成员用，
 *   阵容若被并发改动，「是否需要清空阵容」的判断就不再可靠，整批回滚）。
 */
export function discipleSnapshotGuardStatement(
  commandId: string,
  snapshot: {
    sect: SectRow;
    balances: readonly ResourceBalanceRow[];
    members: readonly { id: string }[];
    defenseLineup?: string | null;
  },
): ParameterizedQuery {
  const { sect, balances, members, defenseLineup } = snapshot;
  const checks = [
    'EXISTS (SELECT 1 FROM sects WHERE id = ? AND level = ? AND last_settled_at = ?)',
  ];
  const params: (string | number | null)[] = [commandId, sect.id, sect.level, sect.last_settled_at];

  for (const row of balances) {
    checks.push(
      'EXISTS (SELECT 1 FROM resource_balances WHERE id = ? AND sect_id = ? AND balance = ? AND remainder = ?)',
    );
    params.push(row.id, sect.id, row.balance, row.remainder);
  }
  for (const member of members) {
    checks.push('EXISTS (SELECT 1 FROM disciples WHERE id = ? AND sect_id = ?)');
    params.push(member.id, sect.id);
  }
  if (defenseLineup !== undefined) {
    checks.push('EXISTS (SELECT 1 FROM sects WHERE id = ? AND defense_lineup IS ?)');
    params.push(sect.id, defenseLineup);
  }

  return {
    sql: `INSERT INTO mutation_guards (command_id, valid)
          SELECT ?, CASE WHEN ${checks.join(' AND ')} THEN 1 ELSE 0 END`,
    params,
  };
}

export function deleteDiscipleSnapshotGuardStatement(commandId: string): ParameterizedQuery {
  return {
    sql: 'DELETE FROM mutation_guards WHERE command_id = ?',
    params: [commandId],
  };
}
