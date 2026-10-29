import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import {
  createApplication, finaliseApplication, saveDraft, getApplication, listApplications, rerenderApplication,
  type ApplicationDetail, type ApplicationListItem, type ApplicationSummary, type Draft, type FailCode, type MilestoneKind, type VerifyReport,
} from '../api';

export const POLL_MS = 1500;

export const FAIL_TEXT: Record<FailCode, string> = {
  provider_error: 'The model provider returned an error. Check the provider settings and start again.',
  selection_invalid: 'The model picked CV entries that are not in your master CV.',
  no_match: 'Nothing in your master CV matches this posting.',
  verify_failed: 'The draft failed the fact check.',
  render_failed: 'Check that your own Word template, if you use one, opens in Word.',
  internal: 'Something went wrong inside the app. The server log has the details.',
};

/** What each step is doing, in words (shown while it runs). */
export const STEP_TEXT = {
  intake: 'Reading the posting',
  match: 'Matching your master CV',
  gaps: 'Finding gaps against the posting',
  draft: 'Writing the CV',
  verify: 'Checking every line against your CV',
  ats: 'Scoring it like an ATS',
  company: 'Reading your notes on the company',
  vacancy: 'Working out what the role is for',
  questions: 'Looking for missing evidence',
  letter: 'Writing the cover letter',
  render: 'Creating the Word files',
} as const;

/** A step is still running: intake to verify while `processing`, render after `final` (a failed render sets `step: null`). */
const busy = (a: ApplicationSummary) => a.status === 'processing' || (a.status === 'final' && a.step === 'render');

/** Every state in words (DESIGN.md: status is never colour alone), plus a tone for the label's tint. */
export function statusLabel(a: ApplicationSummary): { text: string; tone: 'working' | 'ready' | 'attention' | 'danger' | 'done' } {
  if (a.status === 'processing') return { text: a.step ? STEP_TEXT[a.step] : 'Working', tone: 'working' };
  if (busy(a)) return { text: 'Creating files', tone: 'working' };
  if (a.status === 'final' && a.fail_code === 'render_failed') return { text: 'Files failed', tone: 'danger' };
  return {
    draft_ready: { text: 'Ready for review', tone: 'ready' },
    flagged: { text: 'Needs your check', tone: 'attention' },
    needs_answers: { text: 'Waiting for your answers', tone: 'attention' },
    failed: { text: 'Failed', tone: 'danger' },
    final: { text: 'Final', tone: 'done' },
    applied: { text: 'Applied', tone: 'done' },
    withdrawn: { text: 'Withdrawn', tone: 'done' },
  }[a.status] as ReturnType<typeof statusLabel>;
}

type Violation = VerifyReport['violations'][number];
const VIOLATION_TEXT: Record<string, string> = {
  unknown_cite: 'cites a line that is not in your master CV',
  wrong_entry: 'cites a bullet from a different job',
  missing_cite: 'needs 1 to 5 source lines',
  unsupported_number: 'has a number the source lines do not',
  unsupported_entity: 'names something the source lines do not',
  contact_leak: 'looks like contact details',
  bad_placeholder: 'has an unknown placeholder',
  too_long: 'is too long',
  too_many_lines: 'has too many lines',
};
/** A verifier finding in words; `token` is model text and stays plain text wherever this is shown. */
export const violationText = (v: Violation) =>
  `${VIOLATION_TEXT[v.code] ?? v.code}${v.token ? `: “${v.token}”` : ''}`;

/** Applications; `open(id)` loads one and polls it every 1.5 s while a step runs. */
export const useCareerStore = defineStore('career', () => {
  const list = ref<ApplicationListItem[]>([]);
  const current = ref<ApplicationDetail | null>(null);
  const pollError = ref(false);
  const failure = computed(() => {
    const a = current.value;
    if (a?.status === 'failed') return FAIL_TEXT[a.fail_code ?? 'internal'];
    return a?.fail_code === 'render_failed' ? FAIL_TEXT.render_failed : null;
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  let seq = 0; // an older open() that resolves late must not overwrite or re-arm a newer one
  const stop = () => {
    seq++;
    clearTimeout(timer);
  };
  const show = (app: ApplicationDetail) => {
    current.value = app;
    pollError.value = false;
    if (busy(app)) timer = setTimeout(() => open(app.id).catch(() => (pollError.value = true)), POLL_MS);
  };
  /** Rejects only while it is still the latest call. */
  const open = async (id: number): Promise<void> => {
    stop();
    const mine = seq;
    let app: ApplicationDetail;
    try {
      app = await getApplication(id);
    } catch (err) {
      if (mine === seq) throw err;
      return;
    }
    if (mine === seq) show(app);
  };
  const load = async () => {
    list.value = await listApplications();
  };
  /** Starts a run and opens it. Rejects with the API's ApiError (e.g. `master_missing`). */
  const create = async (posting: string) => {
    const created = await createApplication(posting);
    await open(created.id);
    return created.id;
  };
  /** A change that answers with the new detail; polling resumes from it. Rejects with the ApiError. */
  const change = async (fn: () => Promise<ApplicationDetail>) => {
    stop();
    const mine = seq;
    const app = await fn();
    if (mine === seq) show(app);
  };
  const edit = (id: number, d: Pick<Draft, 'versions' | 'cv' | 'letter'>) => change(() => saveDraft(id, d));
  const finalise = (id: number, acknowledgeFlagged: boolean) => change(() => finaliseApplication(id, acknowledgeFlagged));
  const rerender = (id: number) => change(() => rerenderApplication(id));
  return { list, current, failure, pollError, open, stop, load, create, change, edit, finalise, rerender };
});

// ---------- tracking ----------
export const MILESTONE_TEXT: Record<MilestoneKind, string> = {
  applied: 'Applied', feedback: 'Feedback', interview: 'Interview', offer: 'Offer', rejected: 'Rejected', withdrawn: 'Withdrawn', note: 'Note',
};
/** Today as `YYYY-MM-DD` in local time. */
export const today = (d = new Date()) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
/** A `YYYY-MM-DD` date in words, read as a local day. */
export const dayText = (d: string) => new Date(`${d}T00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

// ---------- home and filters ----------
export type Group = 'needs' | 'follow' | 'progress' | 'done';
/**
 * Where an application belongs on Home and the owner's next step, in words. A final draft still needs you: the app
 * never sends anything, so it waits until you send it and mark it applied.
 */
export function nextStep(a: ApplicationListItem, day = today()): { group: Group; text: string } {
  if (a.status === 'processing') return { group: 'progress', text: a.step ? `${STEP_TEXT[a.step]}…` : 'Working…' };
  if (a.status === 'final' && a.step === 'render') return { group: 'progress', text: `${STEP_TEXT.render}…` };
  if (a.status === 'failed') return { group: 'needs', text: 'The run stopped. Retry it' };
  if (a.status === 'final' && a.fail_code === 'render_failed') return { group: 'needs', text: 'Create the files again' };
  if (a.status === 'draft_ready') return { group: 'needs', text: 'Read the draft and finalise it' };
  if (a.status === 'flagged') return { group: 'needs', text: 'Check the marked lines' };
  if (a.status === 'needs_answers') return { group: 'needs', text: 'Answer the questions for the cover letter' };
  if (a.follow_up_on && a.follow_up_on <= day && a.status !== 'withdrawn')
    return { group: 'follow', text: a.follow_up_on < day ? `Follow up, due ${dayText(a.follow_up_on)}` : 'Follow up today' };
  if (a.status === 'final') return { group: 'needs', text: 'Send the files yourself, then mark it applied' };
  if (a.next_interview) return { group: 'done', text: `Interview ${dayText(a.next_interview)}` };
  if (a.last_milestone) return { group: 'done', text: `${MILESTONE_TEXT[a.last_milestone]}, ${dayText(a.last_milestone_on!)}` };
  return { group: 'done', text: a.status === 'withdrawn' ? 'Withdrawn' : 'Applied' };
}
