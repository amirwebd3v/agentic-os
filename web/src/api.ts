import { ref } from 'vue';
import type { CvSection } from './cv';

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

/** True when logged in; otherwise sets `needsLogin`. Never a failed request: `/session` always answers 200. */
export async function checkSession(): Promise<boolean> {
  const ok = await fetch('/session', { credentials: 'same-origin' }).then((r) => r.json() as Promise<{ ok: boolean }>).then((r) => r.ok, () => true);
  if (!ok) needsLogin.value = true;
  return ok;
}
export const getProvider = () => json<Provider>('GET', '/api/provider');
export const reloadProvider = () => json<Provider>('POST', '/api/provider/reload');
export const listApprovals = (all = false) => json<ApprovalPage>('GET', `/api/approvals?status=pending${all ? '&all=true' : ''}`);
export const decideApproval = (id: number, decision: Decision) =>
  json<{ id: number; status: string }>('POST', `/api/approvals/${id}/decide`, { decision });
export const batchApprovals = (ids: number[], decision: Decision) => json<BatchResult>('POST', '/api/approvals/batch', { ids, decision });

// Career (docs/week2/career-contract.md §4, §6, §8.2). Company, role and draft text are model output: render as text only.
export type ApplicationStatus = 'processing' | 'draft_ready' | 'flagged' | 'needs_answers' | 'failed' | 'final' | 'applied' | 'withdrawn';
export type ApplicationStep = 'intake' | 'match' | 'gaps' | 'draft' | 'verify' | 'ats' | 'company' | 'vacancy' | 'questions' | 'letter' | 'render';
export type FailCode = 'provider_error' | 'selection_invalid' | 'no_match' | 'verify_failed' | 'render_failed' | 'internal';
export type Requirement = { id: string; text: string; kind: 'skill' | 'experience' | 'education' | 'language' | 'other' };
export type Requirements = {
  language: 'en' | 'de'; company: string; role_title: string;
  seniority: 'intern' | 'junior' | 'mid' | 'senior' | 'lead' | 'unspecified';
  location_mode: 'onsite' | 'hybrid' | 'remote' | 'unspecified';
  must_have: Requirement[]; nice_to_have: Requirement[]; injection_suspected: boolean;
};
/** A draft line (career-v2.md §1): stable id, the master lines it cites, and who wrote it. */
export type Line = { id?: string; text: string; cites?: string[]; origin?: 'model' | 'owner' | 'suggestion'; suggestion_id?: string };
/** Draft v2: the same CV shape as the master, plus the letter. `versions` guards against a stale save. */
export type Draft = { v: 2; cv: { sections: CvSection[] }; letter: { paragraphs: Line[] }; versions: number };
export type VerifyReport = { ok: boolean; violations: { code: string; ref: string; token?: string }[] };
export type ApplicationSummary = {
  id: number; company: string | null; role_title: string | null; language: 'en' | 'de' | null;
  status: ApplicationStatus; step: ApplicationStep | null; fail_code: FailCode | null;
  follow_up_on: string | null; created_at: string; updated_at: string;
  /** Set while archived: hidden from Home and the default list, restorable. */
  archived_at: string | null;
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
  /** Every entry of the master (id and `org | title | start | end | location`), to add one the draft lacks. */
  master_entries?: { id: string; header: string }[];
  // career-v2 §3–§5: all model or owner text, rendered as text only.
  context?: { company_name: string | null; company_website: string | null; target_country: string | null; research: string | null } | null;
  gaps?: Gaps | null;
  ats?: (AtsReport & { history: { score: number; draft_version: number; created_at: string }[] }) | null;
  company_brief?: { has_research: boolean; points: Point[] } | null;
  vacancy?: { why_open: Point; business_problem: Point; outcomes: Point[]; priorities: Point[] } | null;
  questions?: { evidence: { need: string; master_ids: string[] }[]; questions: { id: string; text: string; why: string }[] } | null;
  answers?: { answers: { id: string; question_id: string; text: string | null }[]; questions_version: number } | null;
  /** The posting as pasted (owner text, shown in a textarea only). */
  posting?: string | null;
  /** Why the CV or the letter is out of date (#72), null when current. */
  stale?: { cv: 'posting' | 'master' | null; letter: 'posting' | 'context' | 'cv' | null } | null;
  /** A CV refresh can be undone (#73). */
  can_restore?: boolean;
  /** While processing: where this run started and where it stops (#73); null `stop` runs to the end. */
  run?: { from: 'intake' | 'match' | 'company'; stop: 'gaps' | 'ats' | null } | null;
};
export type Point = { id: string; text: string; status: 'verified' | 'assumption'; quotes: string[] };
export type Suggestion = { id: string; section: string; entry_id?: string; text: string; why: string; keyword?: string };
export type Gaps = {
  missing_keywords: { keyword: string; importance: 'must' | 'nice'; in_master: boolean }[];
  weak_sections: { section: string; problem: string }[]; formatting: { problem: string }[]; suggestions: Suggestion[]; dismissed: string[];
};
export type AtsReport = {
  score: number; parts: { name: string; score: number; max: number; notes: string[] }[];
  findings: { severity: 'high' | 'medium' | 'low'; text: string }[]; draft_version: number; created_at: string;
};

export type NewApplication = { posting: string; company_name?: string; company_website?: string; research?: string; target_country?: string };
export const createApplication = (a: NewApplication) => json<ApplicationSummary>('POST', '/api/career/applications', a);
export const dismissSuggestions = (id: number, dismissed: string[]) => json<ApplicationDetail>('PATCH', `/api/career/applications/${id}/gaps`, { dismissed });
export const checkAts = (id: number) => json<ApplicationDetail>('POST', `/api/career/applications/${id}/ats`);
export const sendAnswers = (id: number, answers: { id: string; text: string | null }[]) =>
  json<ApplicationDetail>('POST', `/api/career/applications/${id}/answers`, { answers });
export const listApplications = () => json<ApplicationListItem[]>('GET', '/api/career/applications');
export const getApplication = (id: number) => json<ApplicationDetail>('GET', `/api/career/applications/${id}`);
/** Saves the whole draft (`409 draft_changed` when `versions` is stale). */
export const saveDraft = (id: number, d: Pick<Draft, 'versions' | 'cv' | 'letter'>) =>
  json<ApplicationDetail>('PUT', `/api/career/applications/${id}/draft`, d);
export const finaliseApplication = (id: number, acknowledge_flagged: boolean) =>
  json<ApplicationDetail>('POST', `/api/career/applications/${id}/final`, { acknowledge_flagged });
export const rerenderApplication = (id: number) => json<ApplicationDetail>('POST', `/api/career/applications/${id}/render`);
/** A plain link: the browser downloads it with the session cookie (contract §8.2). */
export const fileUrl = (id: number, kind: FileKind) => `/api/career/applications/${id}/files/${kind}`;

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
export const renameApplication = (id: number, names: { company?: string; role_title?: string }) =>
  json<ApplicationDetail>('PATCH', appPath(id), names);
export const retryApplication = (id: number) => json<ApplicationDetail>('POST', `${appPath(id)}/retry`);
/** #72: a new posting text re-reads it (202); company fields alone or an unchanged text answer 200. */
export const editPosting = (id: number, a: NewApplication) => json<ApplicationDetail>('PUT', `${appPath(id)}/posting`, a);
/** #73: re-read the posting, rebuild the CV, or start the letter over (202). */
export const refreshPart = (id: number, part: 'posting' | 'cv' | 'letter') => json<ApplicationDetail>('POST', `${appPath(id)}/refresh`, { part });
/** Puts back the CV a refresh replaced (`409 draft_changed` when `versions` is stale). */
export const restoreDraft = (id: number, versions: number) => json<ApplicationDetail>('POST', `${appPath(id)}/draft/restore`, { versions });
export const archiveApplication = (id: number, archived: boolean) => json<ApplicationDetail>('POST', `${appPath(id)}/archive`, { archived });
/** Permanent: the posting, draft, files and notes are deleted (204). */
export const deleteApplication = async (id: number): Promise<void> => void (await call('DELETE', appPath(id)));

// Master CV (contract §8.1). Every text in it is the owner's CV: render as text only.
export type MasterBullet = { id?: string; text: string };
export type MasterEntry = { id?: string; org: string; title: string; start: string; end: string; location: string; bullets: MasterBullet[] };
export type MasterBulletSection = { name: 'Summary' | 'Skills' | 'Languages'; bullets: MasterBullet[] };
export type MasterEntrySection = { name: 'Experience' | 'Education' | 'Projects' | 'Certifications'; entries: MasterEntry[] };
export type MasterSection = MasterBulletSection | MasterEntrySection;
export type MasterState =
  | { exists: false }
  | { exists: true; hash: string; sections: MasterSection[] }
  | { exists: true; hash: string; error: string };
export const getMaster = () => json<MasterState>('GET', '/api/career/master');
export const saveMaster = (hash: string | null, sections: MasterSection[]) => json<MasterState>('PUT', '/api/career/master', { hash, sections });
/** Reads Word CVs and returns the master merged with them; nothing is written (career-v2.md §2). */
export type MasterMerge = { hash: string | null; sections: CvSection[]; added: { entries: number; bullets: number; skills: number; languages: number }; warnings: string[] };
export const parseCvFiles = (files: { name: string; data: string }[]) => json<MasterMerge>('POST', '/api/career/master/parse', { files });
/** Same, from the LinkedIn data export in the import folder; no model involved. */
export const parseLinkedIn = () => json<MasterMerge>('POST', '/api/career/master/parse-linkedin', {});

// Email (docs/week3/email-spec.md). Read-only access to Gmail; no token ever reaches the browser.
export type MailAccount = { id: number; email: string; status: 'connected' | 'reconnect' | 'disconnected'; backfill_done: 0 | 1; last_synced_at: string | null; last_error?: string | null; triage_error?: string | null; pending?: number; estimate?: number | null };
export type ConnectFlow = 'idle' | 'waiting' | 'connected' | 'cancelled' | 'wrong_scope' | 'failed' | 'timed_out';
export type MailAccounts = { setup: boolean; flow: ConnectFlow; reason?: string | null; accounts: MailAccount[] };
export const getMailAccounts = () => json<MailAccounts>('GET', '/api/email/accounts');
export const connectMailAccount = () => json<{ url: string }>('POST', '/api/email/accounts/connect', {});
export const disconnectMailAccount = (id: number, keep: boolean) => json<{ revoked: boolean }>('DELETE', `/api/email/accounts/${id}?keep=${keep ? 1 : 0}`);
// The paragraph is model text from mail: render as text only.
export type MailParagraph = { text: string; cites: number[]; created_at: string; cost_usd: number | null; source_removed: boolean; refresh_failed: boolean };
export type MailCategory = { id: number; name: string; system: 'personal' | 'noise' | null; count: number; refreshing?: number; paragraph?: MailParagraph | null };
export type MailOverview = { calibration: { done: number; total: number; calibrating: boolean }; consent?: boolean; provider_ok?: boolean; categories: MailCategory[]; needs_sorting: number; rules: { sender: string; category_id: number; learned?: 0 | 1 }[] };
export const setMailConsent = (consent: boolean) => json<MailOverview>('PUT', '/api/email/settings', { consent });
export const refreshParagraphs = () => json<{ queued: number }>('POST', '/api/email/analyses/refresh', {});
export const saveIdea = (categoryId: number) => json<{ saved: boolean; path: string }>('POST', `/api/email/categories/${categoryId}/ideas`, {});
export const clearParagraphs = () => json<{ ok: true }>('DELETE', '/api/email/analyses');
// Sender and subject are mail text: render as text only. A Personal mail has neither.
export type MailRow = { id: number; gmail_id: string; state?: 'needs_sorting' | 'failed'; sender: string | null; subject: string | null; internal_date: string; account: string };
export type SenderGroup = { sender: string | null; suggestion_id: number | null; mails: MailRow[] };
export const getMailOverview = () => json<MailOverview>('GET', '/api/email/overview');
export const getNeedsSorting = () => json<{ groups: SenderGroup[] }>('GET', '/api/email/needs-sorting');
export const getCategoryMails = (id: number) => json<{ mails: MailRow[] }>('GET', `/api/email/categories/${id}/mails`);
export const sortMail = (id: number, categoryId: number, opts: { always?: boolean; apply_stored?: boolean } = {}) => json<{ moved: number }>('POST', `/api/email/mails/${id}/sort`, { category_id: categoryId, ...opts });
export const deleteSenderRule = (sender: string) => json<{ ok: true }>('DELETE', `/api/email/rules?sender=${encodeURIComponent(sender)}`);
export const addMailCategory = (name: string) => json<{ id: number }>('POST', '/api/email/categories', { name });
export const renameMailCategory = (id: number, name: string) => json<{ ok: true }>('PATCH', `/api/email/categories/${id}`, { name });
export const removeMailCategory = (id: number) => json<{ ok: true }>('DELETE', `/api/email/categories/${id}`);
/** Built by code from ids, never taken from a mail. */
export const gmailLink = (m: Pick<MailRow, 'gmail_id' | 'account'>) => `https://mail.google.com/mail/?authuser=${encodeURIComponent(m.account)}#all/${encodeURIComponent(m.gmail_id)}`;

// Dashboard (career-v2.md §6): counts and aggregates only.
export type Usage = { calls: number; input_tokens: number; output_tokens: number; failures?: number; cost: number | null };
export type Dashboard = {
  ai: { days: (Usage & { day: string })[]; by_pipeline: (Usage & { pipeline: string })[]; totals: Usage; priced: boolean };
  system: {
    provider: Provider['status']; approvals_pending: number; jobs: { queued: number; running: number; failed_7d: number };
    vault_notes: number; last_vault_commit: string | null;
  };
  areas: {
    career: {
      by_status: Partial<Record<ApplicationStatus, number>>; archived: number; new_this_week: number; needs_you: number;
      master: { exists: boolean; entries: number | null; lines: number | null };
    };
    email: { connected: boolean }; social: { connected: boolean };
  };
};
export const getDashboard = () => json<Dashboard>('GET', '/api/dashboard');
