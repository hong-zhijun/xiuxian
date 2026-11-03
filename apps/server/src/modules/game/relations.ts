import { z } from 'zod';
import type { BondView, DiscipleRelationCandidate, MentorshipView, RelationsPanel } from '@xiuxian/contracts';
import { realmIndex, REALMS } from './constants';

/** 师徒与羁绊规则（纯定义，不读库、不取时间）。配置项集中在这里，便于平衡调整。 */
export const MENTOR_MIN_REALM_INDEX = 3; // 元婴
export const MENTOR_REALM_GAP = 2; // 至少低两个大境界
export const APPRENTICE_CULTIVATION_BONUS_BP = 1500; // 徒弟修为 +15%
export const TEACHING_PER_POINT = 100; // 每 100 修为 = 1 传道值
export const MENTOR_GRADUATE_ATTRIBUTE_GAIN = 1; // 出师时师傅三项属性各 +1
export const ATTRIBUTE_CAP = 100;
export const REROLL_PILL_ID = 'talentPill';
export const BOND_KINDS = ['fellow', 'partner', 'rival'] as const;
export type BondKind = (typeof BOND_KINDS)[number];
export const BOND_KIND_NAMES: Record<BondKind, string> = { fellow: '同门', partner: '道侣', rival: '宿敌' };
export const BOND_POWER_BP: Record<BondKind, number> = { fellow: 500, partner: 800, rival: 1000 };

/** 同时最多几对师徒：宗门 3 / 5 / 8 级 → 1 / 2 / 3 对。 */
export function mentorshipPairLimit(sectLevel: number): number {
  if (sectLevel >= 8) return 3;
  if (sectLevel >= 5) return 2;
  if (sectLevel >= 3) return 1;
  return 0;
}

/** 目标境界：拜师时师傅的境界下标（徒弟达到即出师），避免师傅继续升级让目标漂移。 */
export function mentorTargetRealmIndex(mentorRealmId: string): number {
  return realmIndex(mentorRealmId);
}

export function canMentor(mentorRealmId: string, discipleRealmId: string): boolean {
  return realmIndex(mentorRealmId) >= MENTOR_MIN_REALM_INDEX
    && realmIndex(mentorRealmId) - realmIndex(discipleRealmId) >= MENTOR_REALM_GAP;
}

/** 出师判定：徒弟当前境界下标达到拜师时记录的目标。 */
export function canGraduate(discipleRealmId: string, targetRealmIndex: number): boolean {
  return realmIndex(discipleRealmId) >= targetRealmIndex;
}

export function teachingPointsOf(teachingValue: number): number {
  return Math.floor(Math.max(0, teachingValue) / TEACHING_PER_POINT);
}

export const relationActionSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('mentor'), mentorId: z.string().min(1).max(64), discipleId: z.string().min(1).max(64), commandId: z.string().min(1).max(64) }),
  z.strictObject({ action: z.literal('graduate'), id: z.string().min(1).max(64), commandId: z.string().min(1).max(64) }),
  z.strictObject({ action: z.literal('cancel-mentor'), id: z.string().min(1).max(64), commandId: z.string().min(1).max(64) }),
  z.strictObject({ action: z.literal('reroll-bond'), id: z.string().min(1).max(64), commandId: z.string().min(1).max(64) }),
]);

export interface ActiveRelationRow {
  id: string;
  sect_id: string;
  kind: 'mentorship' | 'bond';
  status: 'active' | 'graduated' | 'cancelled';
  mentor_id: string;
  disciple_id: string;
  bond_kind: BondKind | null;
  target_realm_index: number | null;
  teaching_value: number;
  version: number;
  created_at: number;
  graduated_at: number | null;
  mentor_name: string;
  disciple_name: string;
  mentor_realm: string;
  disciple_realm: string;
}

export function candidateOf(row: { id: string; name: string; realm_id: string }): DiscipleRelationCandidate {
  return { id: row.id, name: row.name, realmName: row.realm_id, realmIndex: realmIndex(row.realm_id) };
}

export function mentorshipViewOf(row: ActiveRelationRow): MentorshipView {
  const targetIndex = row.target_realm_index ?? 0;
  return {
    id: row.id,
    mentorId: row.mentor_id,
    mentorName: row.mentor_name,
    discipleId: row.disciple_id,
    discipleName: row.disciple_name,
    targetRealmName: REALMS[targetIndex]?.name ?? String(targetIndex),
    teachingValue: teachingPointsOf(Number(row.teaching_value)),
    graduated: row.status === 'graduated',
    canGraduate: row.status === 'active' && canGraduate(row.disciple_realm, targetIndex),
    startedAt: new Date(Number(row.created_at)).toISOString(),
  };
}

export function bondViewOf(row: ActiveRelationRow): BondView {
  const kind = (row.bond_kind ?? 'fellow') as BondKind;
  return {
    id: row.id,
    firstId: row.mentor_id,
    firstName: row.mentor_name,
    secondId: row.disciple_id,
    secondName: row.disciple_name,
    kind,
    name: BOND_KIND_NAMES[kind],
    powerBonusBp: BOND_POWER_BP[kind],
  };
}

export function relationRulesText(): string[] {
  return [
    `师傅需达到元婴及以上，徒弟需比师傅低 ${String(MENTOR_REALM_GAP)} 个大境界以上。`,
    `徒弟同时只能有一位师傅；师傅同时可带 ${String(mentorshipPairLimit(99))} 对弟子（宗门 3 / 5 / 8 级各开放 1 / 2 / 3 对）。`,
    `师徒期间徒弟修炼速度 +${String(APPRENTICE_CULTIVATION_BONUS_BP / 100)}%，每积累 ${String(TEACHING_PER_POINT)} 修为师傅获得 1 点传道值。`,
    `徒弟达到拜师时师傅的境界即可出师，师傅三项基础属性各 +1（上限 ${String(ATTRIBUTE_CAP)}）。`,
    '每名弟子最多一条羁绊，同门 +5%、道侣 +8%、宿敌 +10% 战力，需两人同时出战才生效。',
    '羁绊可用洗髓丹重洗缘分，每次 1 颗。',
  ];
}

export function normalizeBondPair(a: string, b: string): { first: string; second: string } {
  return a < b ? { first: a, second: b } : { first: b, second: a };
}

export type RelationAction = z.infer<typeof relationActionSchema>;
export type RelationsPayload = RelationsPanel;
