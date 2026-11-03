export interface DiscipleRelationCandidate {
  id: string;
  name: string;
  realmName: string;
  realmIndex: number;
}
export interface MentorshipView {
  id: string;
  mentorId: string;
  mentorName: string;
  discipleId: string;
  discipleName: string;
  targetRealmName: string;
  teachingValue: number;
  graduated: boolean;
  canGraduate: boolean;
  startedAt: string;
}
export interface BondView {
  id: string;
  firstId: string;
  firstName: string;
  secondId: string;
  secondName: string;
  kind: 'fellow' | 'partner' | 'rival';
  name: string;
  powerBonusBp: number;
}
export interface RelationsPanel {
  mentors: DiscipleRelationCandidate[];
  disciples: DiscipleRelationCandidate[];
  mentorships: MentorshipView[];
  bonds: BondView[];
  pairLimit: number;
  activePairs: number;
  cultivationBonusBp: number;
  rerollPillId: string;
  rerollPills: number;
  rules: string[];
}
export type RelationsAction =
  | { action: 'mentor'; mentorId: string; discipleId: string; commandId: string }
  | { action: 'graduate' | 'cancel-mentor' | 'reroll-bond'; id: string; commandId: string };
