import type { Database } from '../db/index.ts';
import { enqueue } from '../db/jobs.ts';
import type { JobHandler } from '../jobs/runner.ts';
import { GmailError } from './gmail.ts';
import type { Gmail } from './gmail.ts';

// Finds which mail is new or gone. One page per job, so Career jobs interleave; a job queues its own continuation.
// The cursor moves only after a final page commits, and every write is safe to replay.
const DAY = 86_400;
const HISTORY_DAYS = 30; // D10
const MAX_BACKOFF_S = 64;
const MAX_RETRIES = 6; // then the next 5-minute cycle takes over
const UNITS = { profile: 1, list: 5, history: 2 };
const outOfScope = (label: string) => label === 'TRASH' || label === 'SPAM';

/** 5,000 units a minute per account (spec §3). */
export class RateBudget {
  private spent = new Map<number, { minute: number; units: number }>();
  constructor(
    private limit = 5000,
    private now = () => Date.now(),
  ) {}
  take(accountId: number, units: number): boolean {
    const minute = Math.floor(this.now() / 60_000);
    const cur = this.spent.get(accountId);
    const used = cur?.minute === minute ? cur.units : 0;
    if (used + units > this.limit) return false;
    this.spent.set(accountId, { minute, units: used + units });
    return true;
  }
}

export interface SyncDeps {
  db: Database;
  gmailFor: (accountId: number) => Gmail;
  budget: RateBudget;
  /** Epoch seconds; tests fix it. */
  now?: () => number;
}

interface Account {
  id: number;
  status: string;
  history_id: string | null;
  backfill_page_token: string | null;
  list_after: number | null;
  next_history_id: string | null;
  history_page_token: string | null;
  failures: number;
  last_synced_at: string | null;
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

export const syncKey = (accountId: number, epochSeconds: number) => `mail_sync:${accountId}:${Math.floor(epochSeconds / 300)}`;

/**
 * The 5-minute timer's one job: the unique key dedupes a wake-up against the regular tick. An account with a live job
 * is skipped: its keys hold the page token, so a second chain would never merge with the first.
 */
export function enqueueSyncs(db: Database, epochSeconds = Date.now() / 1000): void {
  const ids = db
    .prepare(
      `SELECT id FROM mail_accounts a WHERE status = 'connected' AND NOT EXISTS (
         SELECT 1 FROM jobs WHERE kind = 'mail_sync' AND status IN ('queued', 'running') AND json_extract(payload, '$.accountId') = a.id)`,
    )
    .pluck()
    .all() as number[];
  for (const id of ids) enqueue(db, 'mail_sync', syncKey(id, epochSeconds), { accountId: id });
}

export const mailSync =
  ({ db, gmailFor, budget, now = () => Date.now() / 1000 }: SyncDeps): JobHandler =>
  async (job) => {
    const accountId = (job.payload as { accountId?: unknown } | null)?.accountId;
    if (typeof accountId !== 'number') throw new Error('mail_sync: invalid payload');
    const account = db.prepare('SELECT * FROM mail_accounts WHERE id = ?').get(accountId) as Account | undefined;
    if (account?.status !== 'connected') return;

    const again = (key: string, delaySeconds = 0) => enqueue(db, 'mail_sync', `mail_sync:${accountId}:${key}`, { accountId }, delaySeconds);
    const addPending = db.prepare(
      `INSERT INTO mail_pending (account_id, gmail_id) SELECT @accountId, @id
       WHERE NOT EXISTS (SELECT 1 FROM mail_messages WHERE account_id = @accountId AND gmail_id = @id)
       ON CONFLICT DO NOTHING`,
    );
    const pendingAll = (ids: string[]) => ids.forEach((id) => addPending.run({ accountId, id }));
    const removeAll = (ids: string[]) => {
      for (const id of ids) {
        db.prepare('DELETE FROM mail_messages WHERE account_id = ? AND gmail_id = ?').run(accountId, id);
        db.prepare('DELETE FROM mail_pending WHERE account_id = ? AND gmail_id = ?').run(accountId, id);
      }
    };
    /** The owner can disconnect during a network call. Nothing may be written back after that. */
    const disconnected = () => db.prepare(`SELECT status FROM mail_accounts WHERE id = ?`).pluck().get(accountId) !== 'connected';
    const healthy = () => db.prepare('UPDATE mail_accounts SET failures = 0, last_error = NULL WHERE id = ?').run(accountId);
    const outOfBudget = (units: number) => {
      if (budget.take(accountId, units)) return false;
      again(`budget:${Math.floor(now() / 60)}`, 60);
      return true;
    };

    /** A NULL cursor (first run, reconnect after a disconnect) or an expired one both list; only the window differs. */
    const startListing = () => {
      const floor = now() - HISTORY_DAYS * DAY;
      const synced = account.last_synced_at ? Date.parse(account.last_synced_at) / 1000 - DAY : floor;
      const after = Math.floor(Math.max(floor, synced));
      db.prepare('UPDATE mail_accounts SET history_id = NULL, history_page_token = NULL, list_after = ?, next_history_id = NULL, backfill_page_token = NULL WHERE id = ?').run(after, accountId);
      return after;
    };

    async function listStep(): Promise<void> {
      if (outOfBudget(UNITS.profile + UNITS.list)) return;
      const gmail = gmailFor(accountId as number);
      const after = account!.list_after ?? startListing();
      // Taken before paging: a mail arriving during the listing is picked up by history from this earlier cursor.
      let cursor = account!.list_after === null ? null : account!.next_history_id;
      if (!cursor) {
        cursor = (await gmail.getProfile()).historyId;
        db.prepare('UPDATE mail_accounts SET next_history_id = ? WHERE id = ?').run(cursor, accountId);
      }
      const token = account!.list_after === null ? null : account!.backfill_page_token;
      const page = await gmail.listMessages(`after:${after}`, token ?? undefined);
      if (disconnected()) return;
      db.transaction(() => {
        pendingAll((page.messages ?? []).map((m) => m.id));
        if (page.nextPageToken) {
          db.prepare('UPDATE mail_accounts SET backfill_page_token = ?, estimate = COALESCE(estimate, ?) WHERE id = ?').run(page.nextPageToken, page.resultSizeEstimate ?? null, accountId);
        } else {
          db.prepare(
            `UPDATE mail_accounts SET history_id = next_history_id, next_history_id = NULL, list_after = NULL, backfill_page_token = NULL,
               backfill_done = 1, estimate = NULL, last_synced_at = ${NOW} WHERE id = ?`,
          ).run(accountId);
        }
      })();
      healthy();
      if (page.nextPageToken) again(`list:${after}:${page.nextPageToken}`);
    }

    async function historyStep(): Promise<void> {
      if (outOfBudget(UNITS.history)) return;
      const start = account!.history_id!;
      let page;
      try {
        page = await gmailFor(accountId as number).listHistory(start, account!.history_page_token ?? undefined);
      } catch (err) {
        if (!(err instanceof GmailError) || err.kind !== 'not_found') throw err;
        // A normal path after a long sleep: history no longer reaches the cursor.
        const after = startListing();
        again(`recover:${after}`);
        return;
      }
      if (disconnected()) return;
      db.transaction(() => {
        for (const h of page.history ?? []) {
          pendingAll((h.messagesAdded ?? []).map((m) => m.message.id));
          removeAll((h.messagesDeleted ?? []).map((m) => m.message.id));
          // Mail bodies don't change, so a label matters only when it takes the mail out of scope.
          removeAll((h.labelsAdded ?? []).filter((l) => l.labelIds?.some(outOfScope)).map((l) => l.message.id));
          // Restored from Trash or out of Spam: Gmail reports only the label change, so it counts as new mail.
          pendingAll((h.labelsRemoved ?? []).filter((l) => l.labelIds?.some(outOfScope)).map((l) => l.message.id));
        }
        if (page.nextPageToken) {
          db.prepare('UPDATE mail_accounts SET history_page_token = ? WHERE id = ?').run(page.nextPageToken, accountId);
        } else {
          db.prepare(`UPDATE mail_accounts SET history_id = COALESCE(?, history_id), history_page_token = NULL, last_synced_at = ${NOW} WHERE id = ?`).run(page.historyId ?? null, accountId);
        }
      })();
      healthy();
      if (page.nextPageToken) again(`history:${start}:${page.nextPageToken}`);
    }

    try {
      await (account.history_id && account.list_after === null ? historyStep() : listStep());
    } catch (err) {
      if (!(err instanceof GmailError)) throw err;
      if (disconnected()) return;
      if (err.kind === 'auth') {
        // No retry loop: a revoked or expired grant needs the owner. The other account carries on.
        const code = err.reason === 'deleted_client' || err.reason === 'invalid_client' ? err.reason : 'reconnect';
        db.prepare(`UPDATE mail_accounts SET status = 'reconnect', last_error = ? WHERE id = ?`).run(code, accountId);
        return;
      }
      const failures = account.failures + 1;
      db.prepare('UPDATE mail_accounts SET failures = ?, last_error = ? WHERE id = ?').run(failures, err.reason === 'domainPolicy' ? 'domain_policy' : err.kind, accountId);
      const retryable = err.kind === 'rate' || err.kind === 'server' || err.kind === 'network';
      if (retryable && failures <= MAX_RETRIES) again(`retry:${Math.floor(now())}:${failures}`, Math.min(MAX_BACKOFF_S, 2 ** failures));
    }
  };
