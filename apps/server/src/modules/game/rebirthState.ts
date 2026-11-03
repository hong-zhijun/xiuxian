import type { ParameterizedQuery } from '../../infra/db/repository';

export interface SectRebirthState {
  cycle: number;
  dao_yun: number;
  bonus_production_bp: number;
  bonus_breakthrough_bp: number;
  bonus_power_bp: number;
  disciple_capacity_floor: number;
  building_capacity_floor: number;
  version: number;
  last_rebirth_at: number | null;
}
export function emptyRebirthState(): SectRebirthState {
  return { cycle: 0, dao_yun: 0, bonus_production_bp: 0, bonus_breakthrough_bp: 0,
    bonus_power_bp: 0, disciple_capacity_floor: 0, building_capacity_floor: 0, version: 0, last_rebirth_at: null };
}
export async function loadRebirthState(db: D1Database, sectId: string): Promise<SectRebirthState> {
  return await db.prepare(`SELECT cycle,dao_yun,bonus_production_bp,bonus_breakthrough_bp,bonus_power_bp,
    disciple_capacity_floor,building_capacity_floor,version,last_rebirth_at FROM sect_rebirth WHERE sect_id=?`)
    .bind(sectId).first<SectRebirthState>() ?? emptyRebirthState();
}
export function rebirthSnapshotGuard(id: string, sectId: string, state: SectRebirthState): ParameterizedQuery {
  return { sql: `INSERT INTO mutation_guards(command_id,valid) SELECT ?,CASE WHEN
    COALESCE((SELECT version FROM sect_rebirth WHERE sect_id=?),0)=? THEN 1 ELSE 0 END`,
    params: [id,sectId,state.version] };
}
