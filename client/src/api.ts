import type { EvidenceFormValues, GraphState, MergeResult, OrderQueryResult, PruneResult, RedundantEdge } from './types';

export class ApiError extends Error {
  status: number;
  payload: { message?: string; cycle?: string[]; selfLoop?: boolean };
  constructor(status: number, payload: { message?: string; cycle?: string[]; selfLoop?: boolean }) {
    super(payload.message ?? `请求失败（${status}）`);
    this.status = status;
    this.payload = payload;
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = (await res.json().catch(() => ({}))) as { message?: string; cycle?: string[]; selfLoop?: boolean };
  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}

function json(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export const api = {
  state: () => request<GraphState>('/api/state'),
  createEvidence: (body: EvidenceFormValues) => request<GraphState>('/api/evidence', json('POST', body)),
  updateEvidence: (id: string, body: EvidenceFormValues) => request<GraphState>(`/api/evidence/${id}`, json('PUT', body)),
  deleteEvidence: (id: string) => request<GraphState>(`/api/evidence/${id}`, { method: 'DELETE' }),
  mergeEvidence: (sourceId: string, targetId: string) =>
    request<MergeResult>('/api/evidence/merge', json('POST', { sourceId, targetId })),
  createEdge: (fromId: string, toId: string) => request<GraphState>('/api/edges', json('POST', { fromId, toId })),
  deleteEdge: (id: number) => request<GraphState>(`/api/edges/${id}`, { method: 'DELETE' }),
  redundancy: () => request<{ redundant: RedundantEdge[] }>('/api/redundancy'),
  pruneEdges: (edgeIds: number[]) => request<PruneResult>('/api/edges/prune', json('POST', { edgeIds })),
  orderQuery: (a: string, b: string) =>
    request<OrderQueryResult>(`/api/order-query?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`),
  importSnapshot: (payload: unknown) => request<GraphState>('/api/import', json('POST', payload)),
  seed: () => request<GraphState>('/api/seed', { method: 'POST' }),
};
