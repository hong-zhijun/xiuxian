import type { RelationsPanel } from '@xiuxian/contracts';
import { AppError } from '../../http/appError';
import type { ParameterizedQuery } from '../../infra/db/repository';
import { dateKeyUtc8, realmIndex } from './constants';
import { saveMetadata } from './progressionService';
import { draftFor } from './service';
import {
  ATTRIBUTE_CAP, BOND_KIND_NAMES, BOND_KINDS, MENTOR_GRADUATE_ATTRIBUTE_GAIN, REROLL_PILL_ID,
  bondViewOf, canGraduate, canMentor, mentorshipPairLimit, mentorshipViewOf, normalizeBondPair,
  relationRulesText, teachingPointsOf, type ActiveRelationRow, type BondKind, type RelationAction,
} from './relations';

type Draft = Awaited<ReturnType<typeof draftFor>>;
interface Guard { id: string; statement: ParameterizedQuery }
interface Receipt { fingerprint: string; receipt_json: string }

function guard(sql: string, params: (string | number | null)[]): Guard {
  const id = `${crypto.randomUUID()}:relation`;
  return { id, statement: { sql: `INSERT INTO mutation_guards(command_id,valid) SELECT ?,CASE WHEN ${sql} THEN 1 ELSE 0 END`, params: [id, ...params] } };
}

const RELATION_SELECT = `SELECT r.id, r.sect_id, r.kind, r.status, r.mentor_id, r.disciple_id, r.bond_kind,
    r.target_realm_index, r.teaching_value, r.version, r.created_at, r.graduated_at,
    m.name AS mentor_name, d.name AS disciple_name, m.realm_id AS mentor_realm, d.realm_id AS disciple_realm
  FROM disciple_relations r
  JOIN disciples m ON m.id = r.mentor_id AND m.sect_id = r.sect_id
  JOIN disciples d ON d.id = r.disciple_id AND d.sect_id = r.sect_id`;

async function activeRelationsOf(db: D1Database, sectId: string): Promise<ActiveRelationRow[]> {
  return (await db.prepare(`${RELATION_SELECT}
    WHERE r.sect_id = ? AND ((r.kind='mentorship' AND r.status='active') OR (r.kind='bond' AND r.status='active'))
    ORDER BY r.updated_at DESC, r.id`).bind(sectId).all<ActiveRelationRow>()).results;
}

async function recentGraduatedOf(db: D1Database, sectId: string): Promise<ActiveRelationRow[]> {
  return (await db.prepare(`${RELATION_SELECT}
    WHERE r.sect_id = ? AND r.kind='mentorship' AND r.status='graduated'
    ORDER BY r.graduated_at DESC, r.id LIMIT 10`).bind(sectId).all<ActiveRelationRow>()).results;
}

async function panelOf(db: D1Database, d: Draft): Promise<RelationsPanel> {
  const [rows, graduated] = await Promise.all([
    activeRelationsOf(db, d.sect.id),
    recentGraduatedOf(db, d.sect.id),
  ]);
  const mentorships = rows.filter((row) => row.kind === 'mentorship');
  const bonds = rows.filter((row) => row.kind === 'bond');
  const candidates = d.disciples.map((row) => ({ id: row.id, name: row.name, realmName: row.realm_id, realmIndex: realmIndex(row.realm_id) }));
  const pairLimit = mentorshipPairLimit(Number(d.sect.level));
  return {
    mentors: candidates.filter((item) => item.realmIndex >= 3),
    disciples: candidates,
    mentorships: [...mentorships.map(mentorshipViewOf), ...graduated.map(mentorshipViewOf)],
    bonds: bonds.map(bondViewOf),
    pairLimit,
    activePairs: mentorships.length,
    cultivationBonusBp: 1500,
    rerollPillId: REROLL_PILL_ID,
    rerollPills: Math.max(0, d.pillQuantity(REROLL_PILL_ID)),
    rules: relationRulesText(),
  };
}

export async function getRelations(db: D1Database, userId: string, now: number): Promise<{ state: ReturnType<Draft['view']>; relations: RelationsPanel }> {
  const d = await draftFor(db, userId, now, () => 1);
  if (d.hasJourneyReturns) await d.commit();
  return { state: d.view(), relations: await panelOf(db, d) };
}

async function receiptOf(db: D1Database, sectId: string, commandId: string, fingerprint: string): Promise<{ message: string } | null> {
  const row = await db.prepare('SELECT fingerprint,receipt_json FROM relation_commands WHERE sect_id=? AND command_id=?').bind(sectId, commandId).first<Receipt>();
  if (!row) return null;
  if (row.fingerprint !== fingerprint) throw new AppError('VALIDATION_ERROR', '操作标识已用于另一项关系操作');
  return JSON.parse(row.receipt_json) as { message: string };
}

export async function actRelations(db: D1Database, userId: string, input: RelationAction, now: number): Promise<{ state: ReturnType<Draft['view']>; relations: RelationsPanel; result: { message: string } }> {
  const d = await draftFor(db, userId, now);
  const fingerprint = JSON.stringify({ action: input.action, mentorId: 'mentorId' in input ? input.mentorId : null, discipleId: 'discipleId' in input ? input.discipleId : null, id: 'id' in input ? input.id : null });
  const previous = await receiptOf(db, d.sect.id, input.commandId, fingerprint);
  if (previous) return { ...(await getRelations(db, userId, now)), result: previous };

  const guards: Guard[] = [];
  let message: string;

  if (input.action === 'mentor') {
    const mentor = d.disciples.find((row) => row.id === input.mentorId);
    const disciple = d.disciples.find((row) => row.id === input.discipleId);
    if (!mentor || !disciple) throw new AppError('NOT_FOUND', '弟子不存在');
    if (mentor.id === disciple.id) throw new AppError('INVALID_STATUS', '不能收自己为徒');
    if (!canMentor(mentor.realm_id, disciple.realm_id)) {
      throw new AppError('INVALID_STATUS', '师傅需元婴以上，且与徒弟相差至少两个大境界');
    }
    const existing = await activeRelationsOf(db, d.sect.id);
    const mine = existing.filter((row) => row.kind === 'mentorship');
    if (mine.some((row) => row.disciple_id === disciple.id)) throw new AppError('INVALID_STATUS', '该弟子已拜师');
    if (mine.some((row) => row.mentor_id === disciple.id)) throw new AppError('INVALID_STATUS', '该弟子正在带徒，不能同时拜师');
    const limit = mentorshipPairLimit(Number(d.sect.level));
    if (limit <= 0) throw new AppError('INVALID_STATUS', '宗门 3 级开放师徒；升级后开放更多名额');
    if (mine.filter((row) => row.mentor_id === mentor.id).length >= limit) throw new AppError('INVALID_STATUS', '该师傅的收徒名额已满');
    if (mine.length >= limit) throw new AppError('INVALID_STATUS', `本宗师徒名额已满（${String(limit)} 对）`);
    const target = realmIndex(mentor.realm_id);
    const id = crypto.randomUUID();
    guards.push(
      guard('EXISTS(SELECT 1 FROM disciples WHERE id=? AND sect_id=? AND realm_id=?)', [mentor.id, d.sect.id, mentor.realm_id]),
      guard('EXISTS(SELECT 1 FROM disciples WHERE id=? AND sect_id=? AND realm_id=?)', [disciple.id, d.sect.id, disciple.realm_id]),
      guard("NOT EXISTS(SELECT 1 FROM disciple_relations WHERE sect_id=? AND kind='mentorship' AND status='active' AND disciple_id=?)", [d.sect.id, disciple.id]),
      guard("NOT EXISTS(SELECT 1 FROM disciple_relations WHERE sect_id=? AND kind='mentorship' AND status='active' AND mentor_id=?)", [d.sect.id, disciple.id]),
    );
    d.addStatement({
      sql: `INSERT INTO disciple_relations(id,sect_id,kind,status,mentor_id,disciple_id,bond_kind,target_realm_index,teaching_value,version,mentor_bonus,created_at,updated_at)
        VALUES(?,?,'mentorship','active',?,?,NULL,?,0,1,'{}',?,?)`,
      params: [id, d.sect.id, mentor.id, disciple.id, target, now, now],
    });
    message = `${mentor.name}收${disciple.name}为徒，徒弟修为速度 +15%。`;
  } else if (input.action === 'graduate') {
    const row = (await activeRelationsOf(db, d.sect.id)).find((item) => item.id === input.id && item.kind === 'mentorship');
    if (!row) throw new AppError('NOT_FOUND', '没有进行中的师徒关系');
    if (!canGraduate(row.disciple_realm, Number(row.target_realm_index ?? 0))) throw new AppError('INVALID_STATUS', '徒弟尚未达到拜师时师傅的境界');
    const mentor = d.disciples.find((item) => item.id === row.mentor_id);
    if (!mentor) throw new AppError('NOT_FOUND', '师傅已不在宗门');
    const attack = Math.min(ATTRIBUTE_CAP, Number(mentor.attack) + MENTOR_GRADUATE_ATTRIBUTE_GAIN);
    const defense = Math.min(ATTRIBUTE_CAP, Number(mentor.defense) + MENTOR_GRADUATE_ATTRIBUTE_GAIN);
    const speed = Math.min(ATTRIBUTE_CAP, Number(mentor.speed) + MENTOR_GRADUATE_ATTRIBUTE_GAIN);
    guards.push(guard("EXISTS(SELECT 1 FROM disciple_relations WHERE id=? AND sect_id=? AND version=? AND status='active')", [row.id, d.sect.id, row.version]));
    d.addStatement({ sql: `UPDATE disciple_relations SET status='graduated',graduated_at=?,version=version+1,mentor_bonus=?,updated_at=? WHERE id=? AND sect_id=?`,
      params: [now, JSON.stringify({ attack: attack - Number(mentor.attack), defense: defense - Number(mentor.defense), speed: speed - Number(mentor.speed) }), now, row.id, d.sect.id] });
    d.addStatement({ sql: 'UPDATE disciples SET attack=?,defense=?,speed=? WHERE id=? AND sect_id=?', params: [attack, defense, speed, mentor.id, d.sect.id] });
    mentor.attack = attack; mentor.defense = defense; mentor.speed = speed;
    message = `${row.disciple_name}出师，${row.mentor_name}三项基础属性各 +1。`;
  } else if (input.action === 'cancel-mentor') {
    const row = (await activeRelationsOf(db, d.sect.id)).find((item) => item.id === input.id && item.kind === 'mentorship');
    if (!row) throw new AppError('NOT_FOUND', '没有进行中的师徒关系');
    guards.push(guard("EXISTS(SELECT 1 FROM disciple_relations WHERE id=? AND sect_id=? AND version=? AND status='active')", [row.id, d.sect.id, row.version]));
    d.addStatement({ sql: `UPDATE disciple_relations SET status='cancelled',cancelled_at=?,version=version+1,updated_at=? WHERE id=? AND sect_id=?`, params: [now, now, row.id, d.sect.id] });
    message = `${row.mentor_name}与${row.disciple_name}解除师徒关系。`;
  } else {
    const row = (await activeRelationsOf(db, d.sect.id)).find((item) => item.id === input.id && item.kind === 'bond');
    if (!row) throw new AppError('NOT_FOUND', '没有这条羁绊');
    if (d.pillQuantity(REROLL_PILL_ID) <= 0) throw new AppError('INSUFFICIENT_RESOURCE', '需要 1 颗洗髓丹才能重洗羁绊');
    const current = (row.bond_kind ?? 'fellow') as BondKind;
    const next = BOND_KINDS[(BOND_KINDS.indexOf(current) + 1 + Math.floor(Math.random() * (BOND_KINDS.length - 1))) % BOND_KINDS.length]!;
    guards.push(
      guard("EXISTS(SELECT 1 FROM disciple_relations WHERE id=? AND sect_id=? AND version=? AND status='active')", [row.id, d.sect.id, row.version]),
      guard('COALESCE((SELECT quantity FROM pill_inventories WHERE sect_id=? AND pill_id=?),0)=?', [d.sect.id, REROLL_PILL_ID, d.pillQuantity(REROLL_PILL_ID)]),
    );
    d.removePill(REROLL_PILL_ID, 1);
    d.addStatement({ sql: "UPDATE disciple_relations SET bond_kind=?,version=version+1,updated_at=? WHERE id=? AND sect_id=?", params: [next, now, row.id, d.sect.id] });
    message = `${row.mentor_name}与${row.disciple_name}的羁绊变为「${BOND_KIND_NAMES[next]}」。`;
  }

  saveMetadata(d);
  const result = { message };
  d.addStatement({ sql: 'INSERT INTO relation_commands(sect_id,command_id,fingerprint,receipt_json,created_at) VALUES(?,?,?,?,?)', params: [d.sect.id, input.commandId, fingerprint, JSON.stringify(result), now] });
  try {
    await d.commit({ extraGuards: guards });
  } catch (error) {
    const replay = await receiptOf(db, d.sect.id, input.commandId, fingerprint);
    if (replay) return { ...(await getRelations(db, userId, now)), result: replay };
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) throw new AppError('INVALID_STATUS', '关系状态已变化，请刷新后重试');
    throw error;
  }
  return { ...(await getRelations(db, userId, now)), result };
}

/** 招募时随机为新弟子牵一条羁绊：优先同境界、无羁绊的同门。 */
export function bondForNewDisciple(d: Draft, newDiscipleId: string, now: number): { guard: Guard; statement: ParameterizedQuery } | null {
  const taken = new Set(d.disciples.filter((row) => row.bond_partner_id).map((row) => row.id));
  const partners = d.disciples.filter((row) => row.id !== newDiscipleId && !taken.has(row.id));
  if (partners.length === 0) return null;
  const partner = partners[Math.floor(Math.random() * partners.length)]!;
  const pair = normalizeBondPair(newDiscipleId, partner.id);
  const kind = BOND_KINDS[Math.floor(Math.random() * BOND_KINDS.length)]!;
  return {
    guard: guard("NOT EXISTS(SELECT 1 FROM disciple_relations WHERE sect_id=? AND kind='bond' AND status='active' AND (mentor_id IN (?,?) OR disciple_id IN (?,?)))", [d.sect.id, pair.first, pair.second, pair.first, pair.second]),
    statement: {
      sql: `INSERT INTO disciple_relations(id,sect_id,kind,status,mentor_id,disciple_id,bond_kind,target_realm_index,teaching_value,version,mentor_bonus,created_at,updated_at)
        VALUES(?,?,'bond','active',?,?,?,NULL,0,1,'{}',?,?)`,
      params: [crypto.randomUUID(), d.sect.id, pair.first, pair.second, kind, now, now],
    },
  };
}

/** 今日日期键（供服务层统一取时区；关系模块本身不单独统计日限）。 */
export function relationDateKey(now: number): string {
  return dateKeyUtc8(now);
}

export { teachingPointsOf };
