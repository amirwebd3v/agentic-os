import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { createApplication, getApplication, listApplications, type ApplicationDetail, type ApplicationSummary, type FailCode } from '../api';

export const POLL_MS = 1500;

export const FAIL_TEXT: Record<FailCode, string> = {
  provider_error: 'The model provider returned an error. Check the provider settings and start again.',
  selection_invalid: 'The model picked CV entries that are not in your master CV.',
  no_match: 'Nothing in your master CV matches this posting.',
  verify_failed: 'The draft failed the fact check.',
  render_failed: 'The Word or PDF files could not be created.',
  internal: 'Something went wrong inside the app. The server log has the details.',
};

/** A step is still running: intake to verify while `processing`, render after `final`. */
const busy = (a: ApplicationSummary) => a.status === 'processing' || (a.status === 'final' && a.step === 'render');

/** Applications; `open(id)` loads one and polls it every 1.5 s while a step runs. */
export const useCareerStore = defineStore('career', () => {
  const list = ref<ApplicationSummary[]>([]);
  const current = ref<ApplicationDetail | null>(null);
  const pollError = ref(false);
  const failure = computed(() => (current.value?.status === 'failed' ? FAIL_TEXT[current.value.fail_code ?? 'internal'] : null));

  let timer: ReturnType<typeof setTimeout> | undefined;
  let seq = 0; // an older open() that resolves late must not overwrite or re-arm a newer one
  const stop = () => {
    seq++;
    clearTimeout(timer);
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
    if (mine !== seq) return;
    current.value = app;
    pollError.value = false;
    if (busy(app)) timer = setTimeout(() => open(id).catch(() => (pollError.value = true)), POLL_MS);
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
  return { list, current, failure, pollError, open, stop, load, create };
});
