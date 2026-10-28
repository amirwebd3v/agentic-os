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

// Career (docs/week2/career-contract.md §4, §6, §8.2). Company, role and draft text are model output: render as text only.
export type ApplicationStatus = 'processing' | 'draft_ready' | 'flagged' | 'failed' | 'final' | 'applied' | 'withdrawn';
export type ApplicationStep = 'intake' | 'match' | 'draft' | 'verify' | 'render';
export type FailCode = 'provider_error' | 'selection_invalid' | 'no_match' | 'verify_failed' | 'render_failed' | 'internal';
export type Requirement = { id: string; text: string; kind: 'skill' | 'experience' | 'education' | 'language' | 'other' };
export type Requirements = {
  language: 'en' | 'de'; company: string; role_title: string;
  seniority: 'intern' | 'junior' | 'mid' | 'senior' | 'lead' | 'unspecified';
  location_mode: 'onsite' | 'hybrid' | 'remote' | 'unspecified';
  must_have: Requirement[]; nice_to_have: Requirement[]; injection_suspected: boolean;
};
export type Line = { text: string; cites: string[] };
export type Draft = {
  summary: Line | null; entries: { entry_id: string; bullets: Line[] }[]; skill_ids: string[];
  letter: { paragraphs: Line[] }; versions: number;
};
export type VerifyReport = { ok: boolean; violations: { code: string; ref: string; token?: string }[] };
export type ApplicationSummary = {
  id: number; company: string | null; role_title: string | null; language: 'en' | 'de' | null;
  status: ApplicationStatus; step: ApplicationStep | null; fail_code: FailCode | null;
  follow_up_on: string | null; created_at: string; updated_at: string;
};
export type ApplicationDetail = ApplicationSummary & {
  requirements: Requirements | null; coverage: { matched: number; total: number } | null; draft: Draft | null;
  edited_refs: string[]; verify: VerifyReport | null; sources: Record<string, string>;
  files: { kind: 'cv_docx' | 'cv_pdf' | 'letter_docx' | 'letter_pdf'; bytes: number }[];
};

export const createApplication = (posting: string) => json<ApplicationSummary>('POST', '/api/career/applications', { posting });
export const listApplications = () => json<ApplicationSummary[]>('GET', '/api/career/applications');
export const getApplication = (id: number) => json<ApplicationDetail>('GET', `/api/career/applications/${id}`);
