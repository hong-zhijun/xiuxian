import type { ParameterizedQuery } from '../../infra/db/repository';

/** Account-wide growth rewards; kept separate from the sect's spendable resources. */
export interface SectProgressionState {
  version: number;
  production_bonus_bp: number;
  rename_tokens: number;
  equipped_frame: string | null;
  equipped_title: string | null;
}
export function emptyProgressionState(): SectProgressionState {
  return { version: 0, production_bonus_bp: 0, rename_tokens: 0, equipped_frame: null, equipped_title: null };
}
export async function loadProgressionState(db: D1Database, sectId: string): Promise<SectProgressionState> {
  return await db.prepare(
    'SELECT version, production_bonus_bp, rename_tokens, equipped_frame, equipped_title FROM sect_progression WHERE sect_id = ?',
  ).bind(sectId).first<SectProgressionState>() ?? emptyProgressionState();
}
/** Prevent an old settlement from overwriting balances after a growth reward changed the rate. */
export function progressionSnapshotGuard(id: string, sectId: string, state: SectProgressionState): ParameterizedQuery {
  return {
    sql: `INSERT INTO mutation_guards (command_id, valid)
          SELECT ?, CASE WHEN COALESCE((SELECT version FROM sect_progression WHERE sect_id = ?), 0) = ?
          THEN 1 ELSE 0 END`,
    params: [id, sectId, state.version],
  };
}
