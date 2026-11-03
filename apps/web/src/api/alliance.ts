import type { AllianceAction, AllianceChatMessage, AlliancePanel } from '@xiuxian/contracts';

import type { SectStateView } from './game';
import { ApiError, apiRequest } from './client';

export interface AllianceResponse {
  state: SectStateView;
  alliance: AlliancePanel;
}
export interface AllianceActionResponse extends AllianceResponse {
  result: { message: string };
}
export interface AllianceChatResponse { messages: AllianceChatMessage[] }
export interface AllianceChatInput { allianceId: string; content: string; commandId: string }

export function fetchAlliance(): Promise<AllianceResponse> {
  return apiRequest<AllianceResponse>('/api/v1/game/alliance');
}
export function postAllianceAction(action: AllianceAction): Promise<AllianceActionResponse> {
  return apiRequest<AllianceActionResponse>('/api/v1/game/alliance/action', { method: 'POST', body: action });
}

/** 频道读取支持取消；只在本模块补充，避免扩大全局 apiRequest 的修改范围。 */
export async function fetchAllianceChat(allianceId: string, signal: AbortSignal): Promise<AllianceChatResponse> {
  let response: Response;
  try {
    response = await fetch(`/api/v1/game/alliance/chat?allianceId=${encodeURIComponent(allianceId)}`, {
      headers: { accept: 'application/json' }, credentials: 'same-origin', signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new ApiError('NETWORK_ERROR', '仙盟频道连接失败，请重试', 0);
  }
  const text = await response.text();
  let envelope: { ok: boolean; data?: AllianceChatResponse; error?: { code?: string; message?: string } };
  try {
    envelope = JSON.parse(text) as typeof envelope;
  } catch {
    throw new ApiError('BAD_RESPONSE', `仙盟频道响应异常（HTTP ${response.status}）`, response.status);
  }
  if (!envelope.ok || envelope.data === undefined) {
    throw new ApiError(envelope.error?.code ?? 'UNKNOWN_ERROR', envelope.error?.message ?? '频道暂不可用', response.status);
  }
  return envelope.data;
}
export function postAllianceChat(input: AllianceChatInput): Promise<AllianceChatResponse> {
  return apiRequest<AllianceChatResponse>('/api/v1/game/alliance/chat', { method: 'POST', body: input });
}
