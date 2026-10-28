import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import {
  createApplication, editDraft, finaliseApplication, getApplication, listApplications, rerenderApplication,
  type ApplicationDetail, type ApplicationSummary, type FailCode, type VerifyReport,
} from '../api';

export const POLL_MS = 1500;

export const FAIL_TEXT: Record<FailCode, string> = {
  provider_error: 'The model provider returned an error. Check the provider settings and start again.',
  selection_invalid: 'The model picked CV entries that are not in your master CV.',
  no_match: 'Nothing in your master CV matches this posting.',
  verify_failed: 'The draft failed the fact check.',
  render_failed: 'The Word or PDF files could not be created.',
  internal: 'Something went wrong inside the app. The server log has the details.',
};

/** What each step is doing, in words (shown while it runs). */
export const STEP_TEXT = {
  intake: 'Reading the posting',
  match: 'Matching your master CV',
  draft: 'Writing the draft',
  verify: 'Checking every line against your CV',
  render: 'Creating the Word and PDF files',
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
  const list = ref<ApplicationSummary[]>([]);
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
  const edit = (id: number, ref: string, text: string) => change(() => editDraft(id, [{ ref, text }]));
  const finalise = (id: number, acknowledgeFlagged: boolean) => change(() => finaliseApplication(id, acknowledgeFlagged));
  const rerender = (id: number) => change(() => rerenderApplication(id));
  return { list, current, failure, pollError, open, stop, load, create, edit, finalise, rerender };
});
