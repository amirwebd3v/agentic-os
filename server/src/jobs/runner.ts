import type { Database } from '../db/index.ts';
import { claimNext, complete, fail } from '../db/jobs.ts';
import type { Job } from '../db/jobs.ts';

export type JobHandler = (job: Job) => Promise<void>;

const TICK_MS = 2000;

/**
 * Claims and runs one due job. False when nothing was due. A handler error requeues the job (backoff) or, past the
 * kind's attempts cap, fails it and calls `onFailed`. Either way an error naming the job and the error's type is thrown.
 */
export async function runNext(db: Database, handlers: Record<string, JobHandler>, onFailed: (job: Job) => void = () => {}): Promise<boolean> {
  const job = claimNext(db);
  if (!job) return false;
  const handler = handlers[job.kind];
  // Only the type name goes to jobs.error and the log: a message can quote posting or model text (career contract §1).
  // ponytail: no message or stack in the log; log them behind a debug flag if a failure can't be traced from the type
  let name = 'NoHandlerError';
  if (handler) {
    try {
      await handler(job);
      complete(db, job.id);
      return true;
    } catch (err) {
      name = (err instanceof Error ? err.name : typeof err).slice(0, 100);
    }
  }
  if (fail(db, job.id, name)) onFailed(job);
  throw new Error(`job ${job.id} (${job.kind}) failed: ${name}`);
}

// ponytail: one sequential worker, matching jobs.ts's lock model; run kinds in parallel if a slow one starves the rest
/** Drains due jobs every `tickMs`. Returns `stop`, which waits for the running job to finish. */
export function startRunner(
  db: Database,
  handlers: Record<string, JobHandler>,
  onError: (err: unknown) => void,
  onFailed?: (job: Job) => void,
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
      while (!stopped && (await runNext(db, handlers, onFailed)));
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
