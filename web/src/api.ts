import { ref } from 'vue';

export type Provider = {
  status: 'ok' | 'not_configured' | 'error'; baseURL: string;
  models: { fast: string; work: string; deep: string };
};
// Payload shapes from docs/week1/review-contract.md (and docs/week2/career-contract.md as types are added).
// All text in them is model- or file-supplied: render as text only.
export type Approval = {
  id: number; proposed_by: string; created_at: string; original_text: string | null;
} & (
  | { action_type: 'vault_conflict'; payload: { path: string; current_hash: string | null; content: string }; current_text: string | null }
  | {
      action_type: 'career_master_import';
      payload: {
        master: string; source_files: string[]; master_hash_before: string | null;
        // Absent for a CV document import (contact.md is already yours).
        contact?: string; contact_hash_before?: string | null;
        stats: { entries: number; bullets: number; skills: number };
      };
    }
);
export type ApprovalPage = { items: Approval[]; more: number; total: number };
export type Decision = 'approve' | 'reject';
export type BatchResult = { id: number; ok: boolean; error?: string }[];

/** Set when any call gets 401; the app then shows how to log in. */
export const needsLogin = ref(false);

export class ApiError extends Error {
  /** `detail` is the server's `{ error }` text; `warnings` (master import) are file names and reasons. Both plain text. */
  constructor(readonly status: number, readonly detail?: string, readonly warnings: string[] = []) {
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
    const body = (await res.json().catch(() => null)) as { error?: unknown; warnings?: unknown } | null;
    const warnings = Array.isArray(body?.warnings) ? body.warnings.filter((w): w is string => typeof w === 'string') : [];
    throw new ApiError(res.status, typeof body?.error === 'string' ? body.error : undefined, warnings);
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
/** `removed`: taken out by the user; it keeps its place so the refs after it keep their index. */
export type Line = { text: string; cites: string[]; removed?: true };
export type HeaderField = 'org' | 'title' | 'start' | 'end' | 'location';
export type Draft = {
  summary: Line | null;
  /** `header`: the user's overrides of the master's entry header. */
  entries: { entry_id: string; bullets: Line[]; header?: Partial<Record<HeaderField, string>>; removed?: true }[];
  skill_ids: string[];
  /** The user's own skills / languages line; absent → the selected skills / the master's languages. */
  skills_text?: string; languages_text?: string;
  letter: { paragraphs: Line[] }; versions: number;
};
/** One change to the draft (contract §8.2); `text` for `set` and `add`, none for `remove`. */
export type DraftEdit = { op?: 'set' | 'remove' | 'add'; ref: string; text?: string };
export type VerifyReport = { ok: boolean; violations: { code: string; ref: string; token?: string }[] };
export type ApplicationSummary = {
  id: number; company: string | null; role_title: string | null; language: 'en' | 'de' | null;
  status: ApplicationStatus; step: ApplicationStep | null; fail_code: FailCode | null;
  follow_up_on: string | null; created_at: string; updated_at: string;
};
export type FileKind = 'cv_docx' | 'letter_docx';
export type ApplicationDetail = ApplicationSummary & {
  requirements: Requirements | null; coverage: { matched: number; total: number } | null; draft: Draft | null;
  /** Lines the user changed (refs as in VerifyReport). */
  edited_refs: string[]; verify: VerifyReport | null;
  /** Cite id → master text; an entry id → its `org | title | start | end | location` header. */
  sources: Record<string, string>;
  /** The master's Languages lines. */
  languages: string[];
  files: { kind: FileKind; bytes: number }[];
  /** Tracking, oldest date first. */
  milestones: Milestone[];
};

export const createApplication = (posting: string) => json<ApplicationSummary>('POST', '/api/career/applications', { posting });
export const listApplications = () => json<ApplicationListItem[]>('GET', '/api/career/applications');
export const getApplication = (id: number) => json<ApplicationDetail>('GET', `/api/career/applications/${id}`);
export const editDraft = (id: number, edits: DraftEdit[]) =>
  json<ApplicationDetail>('PATCH', `/api/career/applications/${id}/draft`, { edits });
export const finaliseApplication = (id: number, acknowledge_flagged: boolean) =>
  json<ApplicationDetail>('POST', `/api/career/applications/${id}/final`, { acknowledge_flagged });
export const rerenderApplication = (id: number) => json<ApplicationDetail>('POST', `/api/career/applications/${id}/render`);
/** A plain link: the browser downloads it with the session cookie (contract §8.2). */
export const fileUrl = (id: number, kind: FileKind) => `/api/career/applications/${id}/files/${kind}`;
export const importMaster = () => json<{ approval_id: number; warnings: string[] }>('POST', '/api/career/master/import');

// Tracking (contract §5, §8.2). `note` is the owner's own text: render as text only.
export type MilestoneKind = 'applied' | 'feedback' | 'interview' | 'offer' | 'rejected' | 'withdrawn' | 'note';
export type Milestone = { id: number; kind: MilestoneKind; on_date: string; note: string | null; created_at: string; updated_at: string };
export type MilestoneInput = { kind: MilestoneKind; on_date: string; note: string };
export type ApplicationListItem = ApplicationSummary & {
  last_milestone: MilestoneKind | null; last_milestone_on: string | null; next_interview: string | null;
};
const appPath = (id: number) => `/api/career/applications/${id}`;
export const addMilestone = (id: number, m: MilestoneInput) => json<ApplicationDetail>('POST', `${appPath(id)}/milestones`, m);
export const editMilestone = (id: number, mid: number, m: MilestoneInput) => json<ApplicationDetail>('PATCH', `${appPath(id)}/milestones/${mid}`, m);
export const deleteMilestone = (id: number, mid: number) => json<ApplicationDetail>('DELETE', `${appPath(id)}/milestones/${mid}`);
export const setFollowUp = (id: number, follow_up_on: string | null) => json<ApplicationDetail>('PATCH', appPath(id), { follow_up_on });
export const createManualApplication = (a: { company: string; role_title: string; applied_on: string }) =>
  json<ApplicationSummary>('POST', '/api/career/applications/manual', a);
