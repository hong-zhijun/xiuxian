import type { RebirthAction, RebirthPanel } from '@xiuxian/contracts';

import type { SectStateView } from './game';
import { apiRequest } from './client';

export interface RebirthResponse {
  state: SectStateView;
  rebirth: RebirthPanel;
}

export interface RebirthActionResponse extends RebirthResponse {
  result: { message: string };
}

export function fetchRebirth(): Promise<RebirthResponse> {
  return apiRequest<RebirthResponse>('/api/v1/game/rebirth');
}

/** 同一次操作重试必须传回原始 commandId 和 expectedVersion。 */
export function postRebirthAction(action: RebirthAction): Promise<RebirthActionResponse> {
  return apiRequest<RebirthActionResponse>('/api/v1/game/rebirth/action', {
    method: 'POST',
    body: action,
  });
}
