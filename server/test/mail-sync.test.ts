import { describe, expect, test } from 'vitest';
import type { Database } from '../src/db/index.ts';
import type { Job } from '../src/db/jobs.ts';
import { GmailError } from '../src/mail/gmail.ts';
import type { Gmail, GmailHistory } from '../src/mail/gmail.ts';
import { tokenError } from '../src/mail/oauth.ts';
import { enqueueSyncs, mailSync, RateBudget, syncKey } from '../src/mail/sync.ts';
import { makeTestDb } from './helpers.ts';

const NOW = Date.parse('2026-11-01T00:00:00Z') / 1000;
const DAY = 86_400;

function fake(over: Partial<Gmail> = {}) {
  const calls: string[] = [];
  const gmail: Gmail = {
    getProfile: async () => {
      calls.push('profile');
      return { emailAddress: 'a@example.com', historyId: '100' };
    },
    listMessages: async (q, token) => {
      calls.push(`list ${q} ${token ?? ''}`);
      return token ? { messages: [{ id: 'm3' }] } : { messages: [{ id: 'm1' }, { id: 'm2' }], nextPageToken: 'p2', resultSizeEstimate: 3 };
    },
    listHistory: async (start, token) => {
      calls.push(`history ${start} ${token ?? ''}`);
      return { historyId: '200' };
    },
    getMessage: async () => {
      throw new Error('sync never reads a mail');
    },
    ...over,
  };
  return { gmail, calls };
}

function setup(gmail: Gmail, account: Record<string, unknown> = {}, budget = new RateBudget()) {
  const db = makeTestDb();
  const cols = { email: 'a@example.com', ...account };
  db.prepare(`INSERT INTO mail_accounts (${Object.keys(cols).join(',')}) VALUES (${Object.keys(cols).map(() => '?').join(',')})`).run(...(Object.values(cols) as never[]));
  const handler = mailSync({ db, gmailFor: () => gmail, budget, now: () => NOW });
  const run = () => handler({ payload: { accountId: 1 } } as Job);
  return { db, run, state: () => account1(db), pending: () => db.prepare('SELECT gmail_id FROM mail_pending ORDER BY gmail_id').pluck().all(), queued: () => db.prepare(`SELECT idempotency_key FROM jobs WHERE status = 'queued'`).pluck().all() as string[] };
}
const account1 = (db: Database) => db.prepare('SELECT * FROM mail_accounts WHERE id = 1').get() as Record<string, unknown>;
const stored = (db: Database, id: string) => db.prepare(`INSERT INTO mail_messages (account_id, gmail_id, internal_date, state) VALUES (1, ?, '2026-11-01', 'needs_sorting')`).run(id);

describe('first sync', () => {
  test('lists 30 days page by page, taking the cursor first and saving it only after the last page', async () => {
    const f = fake();
    const t = setup(f.gmail);
    await t.run();
    expect(f.calls).toEqual(['profile', `list after:${NOW - 30 * DAY} `]);
    expect(t.pending()).toEqual(['m1', 'm2']);
    expect(t.state()).toMatchObject({ history_id: null, backfill_done: 0, backfill_page_token: 'p2', estimate: 3 });
    expect(t.queued()).toHaveLength(1);

    await t.run();
    expect(f.calls.slice(2)).toEqual([`list after:${NOW - 30 * DAY} p2`]);
    expect(t.pending()).toEqual(['m1', 'm2', 'm3']);
    expect(t.state()).toMatchObject({ history_id: '100', backfill_done: 1, list_after: null, next_history_id: null, estimate: null });
    expect(t.state()['last_synced_at']).not.toBeNull();
  });

  test('a restart resumes from the stored page token and the first cursor', async () => {
    const f = fake();
    const t = setup(f.gmail, { list_after: NOW - DAY, next_history_id: '50', backfill_page_token: 'p2' });
    await t.run();
    expect(f.calls).toEqual([`list after:${NOW - DAY} p2`]);
    expect(t.state()).toMatchObject({ history_id: '50', backfill_done: 1 });
  });

  test('a mail already stored is not fetched again', async () => {
    const f = fake();
    const t = setup(f.gmail);
    stored(t.db, 'm1');
    await t.run();
    expect(t.pending()).toEqual(['m2']);
  });
});

describe('history', () => {
  const page = (h: GmailHistory) => fake({ listHistory: async () => h });

  test('adds new mail; deleted, trashed and spammed mail leave at once; other labels change nothing', async () => {
    const f = page({
      historyId: '200',
      history: [
        { messagesAdded: [{ message: { id: 'new' } }] },
        { messagesDeleted: [{ message: { id: 'gone' } }] },
        { labelsAdded: [{ message: { id: 'trashed' }, labelIds: ['TRASH'] }, { message: { id: 'spam' }, labelIds: ['SPAM'] }, { message: { id: 'kept' }, labelIds: ['STARRED'] }] },
      ],
    });
    const t = setup(f.gmail, { history_id: '100', backfill_done: 1 });
    for (const id of ['gone', 'trashed', 'spam', 'kept']) stored(t.db, id);
    t.db.prepare(`INSERT INTO mail_pending (account_id, gmail_id) VALUES (1, 'trashed')`).run();
    await t.run();
    expect(t.pending()).toEqual(['new']);
    expect(t.db.prepare('SELECT gmail_id FROM mail_messages').pluck().all()).toEqual(['kept']);
    expect(t.state()['history_id']).toBe('200');
  });

  test('mail restored from Trash or out of Spam is fetched again', async () => {
    const f = page({ historyId: '200', history: [{ labelsRemoved: [{ message: { id: 'back' }, labelIds: ['TRASH'] }, { message: { id: 'ham' }, labelIds: ['SPAM'] }, { message: { id: 'read' }, labelIds: ['UNREAD'] }] }] });
    const t = setup(f.gmail, { history_id: '100', backfill_done: 1 });
    await t.run();
    expect(t.pending()).toEqual(['back', 'ham']);
  });

  test('a disconnect during the network call writes nothing back', async () => {
    let db: Database | undefined;
    const during = () => db!.prepare(`UPDATE mail_accounts SET status = 'disconnected', history_id = NULL`).run();
    const f = fake({
      listHistory: async () => {
        during();
        return { historyId: '200', history: [{ messagesAdded: [{ message: { id: 'new' } }] }] };
      },
    });
    const t = setup(f.gmail, { history_id: '100', backfill_done: 1 });
    db = t.db;
    await t.run();
    expect(t.state()).toMatchObject({ status: 'disconnected', history_id: null });
    expect(t.pending()).toEqual([]);

    const failing = fake({
      listHistory: async () => {
        during();
        throw new GmailError('auth');
      },
    });
    const v = setup(failing.gmail, { history_id: '100' });
    db = v.db;
    await v.run();
    expect(v.state()['status']).toBe('disconnected');
  });

  test('the cursor stays until the last page; a crash replays safely', async () => {
    let n = 0;
    const f = fake({ listHistory: async () => (n++ ? { historyId: '300', history: [{ messagesAdded: [{ message: { id: 'b' } }] }] } : { nextPageToken: 'h2', history: [{ messagesAdded: [{ message: { id: 'a' } }] }] }) });
    const t = setup(f.gmail, { history_id: '100', backfill_done: 1 });
    await t.run();
    expect(t.state()).toMatchObject({ history_id: '100', history_page_token: 'h2' });
    await t.run();
    expect(t.state()).toMatchObject({ history_id: '300', history_page_token: null });
    expect(t.pending()).toEqual(['a', 'b']);
  });

  test('a cursor too old (404) re-lists from the last sync minus a day, without an error', async () => {
    const f = fake({ listHistory: async () => Promise.reject(new GmailError('not_found')) });
    const synced = new Date((NOW - 10 * DAY) * 1000).toISOString();
    const t = setup(f.gmail, { history_id: '100', backfill_done: 1, last_synced_at: synced });
    await t.run();
    expect(t.state()).toMatchObject({ history_id: null, list_after: NOW - 11 * DAY, last_error: null });
    expect(t.queued()).toHaveLength(1);
    await t.run();
    expect(f.calls).toContain(`list after:${NOW - 11 * DAY} `);
  });

  test('a recovery never reaches past 30 days', async () => {
    const f = fake({ listHistory: async () => Promise.reject(new GmailError('not_found')) });
    const t = setup(f.gmail, { history_id: '100', last_synced_at: new Date((NOW - 90 * DAY) * 1000).toISOString() });
    await t.run();
    expect(t.state()['list_after']).toBe(NOW - 30 * DAY);
  });

  test('a NULL cursor after a keep-rows disconnect and reconnect takes the listing path', async () => {
    const f = fake();
    const t = setup(f.gmail, { history_id: null, backfill_done: 1, last_synced_at: new Date((NOW - 2 * DAY) * 1000).toISOString() });
    await t.run();
    expect(f.calls[1]).toBe(`list after:${NOW - 3 * DAY} `);
  });
});

describe('failures', () => {
  const failing = (kind: GmailError['kind'], reason?: string) => fake({ getProfile: async () => Promise.reject(new GmailError(kind, reason)) });

  test.each(['invalid_grant', undefined])('a dead grant (%s) asks for a reconnect and does not retry', async (reason) => {
    const t = setup(failing('auth', reason).gmail);
    await t.run();
    expect(t.state()).toMatchObject({ status: 'reconnect', last_error: 'reconnect' });
    expect(t.queued()).toEqual([]);
  });

  test('a deleted OAuth client says so', async () => {
    const t = setup(failing('auth', 'deleted_client').gmail);
    await t.run();
    expect(t.state()).toMatchObject({ status: 'reconnect', last_error: 'deleted_client' });
  });

  test.each(['server', 'network', 'rate'] as const)('%s backs off without moving the cursor, then waits for the next cycle', async (kind) => {
    const t = setup(failing(kind).gmail, { history_id: null });
    await t.run();
    expect(t.state()).toMatchObject({ failures: 1, last_error: kind, history_id: null });
    const after = t.db.prepare(`SELECT run_after > strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS later FROM jobs`).pluck().get();
    expect(after).toBe(1);

    t.db.prepare('UPDATE mail_accounts SET failures = 6').run();
    t.db.prepare('DELETE FROM jobs').run();
    await t.run();
    expect(t.state()['failures']).toBe(7);
    expect(t.queued()).toEqual([]);
  });

  test('domainPolicy does not retry', async () => {
    const t = setup(failing('bad_request', 'domainPolicy').gmail);
    await t.run();
    expect(t.state()['last_error']).toBe('domain_policy');
    expect(t.queued()).toEqual([]);
  });

  test('a good step clears the failure', async () => {
    const t = setup(fake().gmail, { failures: 3, last_error: 'server' });
    await t.run();
    expect(t.state()).toMatchObject({ failures: 0, last_error: null });
  });

  test('a disconnected or reconnect-needing account does nothing', async () => {
    const f = fake();
    const t = setup(f.gmail, { status: 'reconnect' });
    await t.run();
    expect(f.calls).toEqual([]);
  });

  test('an unexpected error is thrown with its type only, for the runner', async () => {
    const t = setup(fake({ getProfile: async () => Promise.reject(new TypeError('boom')) }).gmail);
    await expect(t.run()).rejects.toThrow(TypeError);
  });
});

describe('rate budget and timer', () => {
  test('out of budget, the step waits a minute and calls nothing', async () => {
    const f = fake();
    const t = setup(f.gmail, {}, new RateBudget(1));
    await t.run();
    expect(f.calls).toEqual([]);
    expect(t.queued()).toHaveLength(1);
  });

  test('the budget is per account and per minute', () => {
    let now = 0;
    const b = new RateBudget(10, () => now);
    expect(b.take(1, 10)).toBe(true);
    expect(b.take(1, 1)).toBe(false);
    expect(b.take(2, 10)).toBe(true);
    now = 60_000;
    expect(b.take(1, 10)).toBe(true);
  });

  test('the timer does not start a second chain beside a live one', () => {
    const db = makeTestDb();
    db.prepare(`INSERT INTO mail_accounts (email) VALUES ('a@example.com'), ('b@example.com')`).run();
    db.prepare(`INSERT INTO jobs (kind, idempotency_key, payload) VALUES ('mail_sync', 'mail_sync:1:list:x', '{"accountId":1}')`).run();
    enqueueSyncs(db, NOW);
    expect(db.prepare('SELECT idempotency_key FROM jobs ORDER BY id').pluck().all()).toEqual(['mail_sync:1:list:x', syncKey(2, NOW)]);
  });

  test.each([
    [{ response: { status: 400, data: { error: 'invalid_grant' } } }, 'auth', 'reconnect'],
    [{ response: { status: 400, data: { error: 'invalid_request' } } }, 'auth', 'reconnect'],
    [{ response: { status: 401, data: { error: 'invalid_client' } } }, 'auth', 'invalid_client'],
    [{ response: { status: 401, data: { error: 'deleted_client' } } }, 'auth', 'deleted_client'],
    [{ response: { status: 503 } }, 'network', undefined],
    [new Error('socket hang up'), 'network', undefined],
  ])('a refused token refresh is classified: %j', (err, kind, reason) => {
    expect(tokenError(err)).toMatchObject({ kind, reason });
  });

  test('the timer queues one job per connected account per 5 minutes', () => {
    const db = makeTestDb();
    db.prepare(`INSERT INTO mail_accounts (email, status) VALUES ('a@example.com', 'connected'), ('b@example.com', 'reconnect')`).run();
    enqueueSyncs(db, NOW);
    enqueueSyncs(db, NOW + 1);
    expect(db.prepare('SELECT idempotency_key FROM jobs').pluck().all()).toEqual([syncKey(1, NOW)]);
    db.prepare(`UPDATE jobs SET status = 'done'`).run();
    enqueueSyncs(db, NOW + 300);
    expect(db.prepare('SELECT count(*) FROM jobs').pluck().get()).toBe(2);
  });
});
