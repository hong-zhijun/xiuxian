import type { ProgressionAction, ProgressionPanel } from '@xiuxian/contracts';

import type { SectStateView } from './game';
import { apiRequest } from './client';

/** 成长面板接口：状态与动作回执都带最新宗门状态，方便领奖后即时刷新顶栏。 */
export interface ProgressionResponse {
  state: SectStateView;
  progression: ProgressionPanel;
}

export interface ProgressionActionResponse extends ProgressionResponse {
  result?: { message: string };
}

export async function fetchProgression(): Promise<ProgressionResponse> {
  return apiRequest<ProgressionResponse>('/api/v1/game/progression');
}

export async function postProgressionAction(action: ProgressionAction): Promise<ProgressionActionResponse> {
  return apiRequest<ProgressionActionResponse>('/api/v1/game/progression/action', {
    method: 'POST',
    body: action,
  });
}

/** 每次操作都使用独立 UUID；服务端据 commandId 做幂等与并发判定。 */
export function createProgressionCommandId(): string {
  return crypto.randomUUID();
}
