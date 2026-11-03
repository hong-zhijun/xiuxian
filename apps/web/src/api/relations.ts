import type { RelationsAction, RelationsPanel } from '@xiuxian/contracts';

import type { SectStateView } from './game';
import { apiRequest } from './client';

/** 师徒与羁绊面板：状态与回执都带最新宗门状态，便于同步顶栏。 */
export interface RelationsResponse {
  state: SectStateView;
  relations: RelationsPanel;
}
export interface RelationsActionResponse extends RelationsResponse {
  result: { message: string };
}

export async function fetchRelations(): Promise<RelationsResponse> {
  return apiRequest<RelationsResponse>('/api/v1/game/relations');
}

export async function postRelationAction(action: RelationsAction): Promise<RelationsActionResponse> {
  return apiRequest<RelationsActionResponse>('/api/v1/game/relations/action', { method: 'POST', body: action });
}
