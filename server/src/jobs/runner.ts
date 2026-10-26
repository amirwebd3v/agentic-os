import type { Database } from '../db/index.ts';
import { claimNext, complete, fail } from '../db/jobs.ts';
import type { Job } from '../db/jobs.ts';

export type JobHandler = (job: Job) => Promise<void>;

const TICK_MS = 2000;

/** Claims and runs one due job. False when nothing was due. A handler error requeues the job (backoff) and is rethrown. */
export async function runNext(db: Database, handlers: Record<string, JobHandler>): Promise<boolean> {
  const job = claimNext(db);
  if (!job) return false;
  try {
    const handler = handlers[job.kind];
    if (!handler) throw new Error(`no handler for job kind "${job.kind}"`);
    await handler(job);
    complete(db, job.id);
  } catch (err) {
    fail(db, job.id, (err instanceof Error ? err.message : String(err)).slice(0, 1000));
    throw err;
  }
  return true;
}

// ponytail: one sequential worker, matching jobs.ts's lock model; run kinds in parallel if a slow one starves the rest
/** Drains due jobs every `tickMs`. Returns `stop`, which waits for the running job to finish. */
export function startRunner(
  db: Database,
  handlers: Record<string, JobHandler>,
  onError: (err: unknown) => void,
  tickMs = TICK_MS,
): () => Promise<void> {
  let stopped = false;
  let current: Promise<void> = Promise.resolve();
  let timer: NodeJS.Timeout | undefined;
  const schedule = () => {
    timer = setTimeout(() => (current = tick()), tickMs);
    timer.unref();
  };
  const tick = async () => {
    try {
      while (!stopped && (await runNext(db, handlers)));
    } catch (err) {
      onError(err);
    }
    if (!stopped) schedule();
  };
  schedule();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await current;
  };
}
