import { ref } from 'vue';

export type Provider = {
  status: 'ok' | 'not_configured' | 'error'; baseURL: string;
  models: { fast: string; work: string; deep: string };
};
// Payload shapes from docs/week1/review-contract.md (and docs/week2/career-contract.md as types are added).
// All text in them is model- or file-supplied: render as text only.
export type Approval = {
  id: number; proposed_by: string; created_at: string; original_text: string | null;
} & { action_type: 'vault_conflict'; payload: { path: string; current_hash: string | null; content: string }; current_text: string | null };
export type ApprovalPage = { items: Approval[]; more: number; total: number };
export type Decision = 'approve' | 'reject';
export type BatchResult = { id: number; ok: boolean; error?: string }[];

/** Set when any call gets 401; the app then shows how to log in. */
export const needsLogin = ref(false);

export class ApiError extends Error {
  /** `detail` is the server's `{ error }` text, shown to the user as plain text. */
  constructor(readonly status: number, readonly detail?: string) {
    super(`HTTP ${status}`);
  }
}

async function call(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? { 'X-AOS': '1' } : { 'X-AOS': '1', 'Content-Type': 'application/json' },
    body: body === undefined ? null : JSON.stringify(body),
    signal: signal ?? null,
  });
  if (res.status === 401) needsLogin.value = true;
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    throw new ApiError(res.status, typeof body?.error === 'string' ? body.error : undefined);
  }
  return res;
}
const json = async <T>(method: string, path: string, body?: unknown): Promise<T> =>
  (await call(method, path, body)).json() as Promise<T>;

export const getProvider = () => json<Provider>('GET', '/api/provider');
export const reloadProvider = () => json<Provider>('POST', '/api/provider/reload');
export const listApprovals = (all = false) => json<ApprovalPage>('GET', `/api/approvals?status=pending${all ? '&all=true' : ''}`);
export const decideApproval = (id: number, decision: Decision) =>
  json<{ id: number; status: string }>('POST', `/api/approvals/${id}/decide`, { decision });
export const batchApprovals = (ids: number[], decision: Decision) => json<BatchResult>('POST', '/api/approvals/batch', { ids, decision });
