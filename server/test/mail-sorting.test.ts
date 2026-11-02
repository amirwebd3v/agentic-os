import { describe, expect, test, vi } from 'vitest';
import type { Database } from '../src/db/index.ts';
import type { Job } from '../src/db/jobs.ts';
import { emailRoutes } from '../src/http/routes/email.ts';
import type { Gmail, GmailMessage } from '../src/mail/gmail.ts';
import { sortMail } from '../src/mail/sorting.ts';
import { RateBudget } from '../src/mail/sync.ts';
import { mailTriage } from '../src/mail/triage.ts';
import { buildTestApp, makeTestDb } from './helpers.ts';

const [BLOG, CAREER, PERSONAL, NOISE] = [1, 3, 5, 6];

const seed = (db: Database) => db.prepare(`INSERT INTO mail_accounts (email) VALUES ('a@example.com')`).run();
const mail = (db: Database, cols: Record<string, unknown> = {}) => {
  const all = { account_id: 1, gmail_id: 'g1', internal_date: '2026-11-01T00:00:00.000Z', state: 'needs_sorting', sender: 'news@example.com', subject: 'Issue 4', ...cols };
  return db.prepare(`INSERT INTO mail_messages (${Object.keys(all).join(',')}) VALUES (${Object.keys(all).map(() => '?').join(',')}) RETURNING id`).pluck().get(...(Object.values(all) as never[])) as number;
};
const row = (db: Database, id: number) => db.prepare('SELECT * FROM mail_messages WHERE id = ?').get(id) as Record<string, unknown>;
const pending = (db: Database) => db.prepare('SELECT gmail_id, owner_category_id FROM mail_pending').all();

describe('sortMail', () => {
  test('into Personal wipes the text at once, and drops any pending fetch', () => {
    const db = makeTestDb();
    seed(db);
    const id = mail(db, { state: 'filed', category_id: BLOG, excerpt: 'text', eligible: 1 });
    db.prepare(`INSERT INTO mail_pending (account_id, gmail_id) VALUES (1, 'g1')`).run();
    expect(sortMail(db, id, PERSONAL)).toBe('ok');
    expect(row(db, id)).toMatchObject({ is_personal: 1, sender: null, subject: null, excerpt: null, eligible: 0, category_id: PERSONAL, source: 'owner' });
    expect(pending(db)).toEqual([]);
  });

  test('from Needs sorting into an idea category files it and fetches its text', () => {
    const db = makeTestDb();
    seed(db);
    const id = mail(db);
    sortMail(db, id, BLOG);
    expect(row(db, id)).toMatchObject({ state: 'filed', category_id: BLOG, source: 'owner', excerpt: null });
    expect(pending(db)).toEqual([{ gmail_id: 'g1', owner_category_id: BLOG }]);
  });

  test('into Noise drops the excerpt and fetches nothing', () => {
    const db = makeTestDb();
    seed(db);
    const id = mail(db, { state: 'filed', category_id: BLOG, excerpt: 'text', eligible: 1 });
    sortMail(db, id, NOISE);
    expect(row(db, id)).toMatchObject({ category_id: NOISE, excerpt: null, eligible: 0, sender: 'news@example.com' });
    expect(pending(db)).toEqual([]);
  });

  test('between idea categories keeps the excerpt and eligibility', () => {
    const db = makeTestDb();
    seed(db);
    const id = mail(db, { state: 'filed', category_id: BLOG, excerpt: 'text', eligible: 1 });
    sortMail(db, id, CAREER);
    expect(row(db, id)).toMatchObject({ category_id: CAREER, excerpt: 'text', eligible: 1 });
    expect(pending(db)).toEqual([]);
  });

  test('out of Personal needs a fetch, also into Noise, which keeps a sender', () => {
    const db = makeTestDb();
    seed(db);
    const id = mail(db, { state: 'filed', category_id: PERSONAL, is_personal: 1, sender: null, subject: null });
    sortMail(db, id, NOISE);
    expect(row(db, id)).toMatchObject({ is_personal: 0, category_id: NOISE });
    expect(pending(db)).toEqual([{ gmail_id: 'g1', owner_category_id: NOISE }]);
  });

  test('records the correction on the decision', () => {
    const db = makeTestDb();
    seed(db);
    const id = mail(db);
    db.prepare(`INSERT INTO decisions (subject_type, subject_id, question, answer) VALUES ('mail', 'g1', 'category', 'Blog ideas'), ('mail', 'g1', 'sensitive', 'false')`).run();
    sortMail(db, id, CAREER);
    expect(db.prepare('SELECT question, final_answer, corrected_by_user FROM decisions ORDER BY id').all()).toEqual([
      { question: 'category', final_answer: 'Career', corrected_by_user: 1 },
      { question: 'sensitive', final_answer: null, corrected_by_user: 0 },
    ]);
  });

  test('an unknown mail or category', () => {
    const db = makeTestDb();
    seed(db);
    expect(sortMail(db, 99, BLOG)).toBe('not_found');
    expect(sortMail(db, mail(db), 99)).toBe('bad_category');
  });
});

describe('the fetch after sorting, through triage', () => {
  const b64 = (s: string) => Buffer.from(s).toString('base64url');
  const message = (body: string): GmailMessage => ({ id: 'g1', labelIds: ['INBOX'], internalDate: '1000', payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'news@example.com' }, { name: 'Subject', value: 'Issue 4' }], body: { data: b64(body) } } });
  const run = (db: Database, m: GmailMessage, sensitive = 0.05) =>
    mailTriage({
      db,
      config: { llm: {} } as never,
      gmailFor: () => ({ getMessage: async () => m }) as unknown as Gmail,
      budget: new RateBudget(),
      contact: () => ({}),
      decider: () => ({ status: async () => 'ok', decide: vi.fn(async () => ({ latencyMs: 1, answers: { sensitive: { type: 'noul' as const, noul: sensitive, confidence: 1 }, category: { type: 'choice' as const, choice: 'Career', confidence: 1, probabilities: {} } } })) }),
    })({ id: 1, payload: { accountId: 1 } } as Job);

  test("keeps the owner's category and stores the excerpt, during calibration too", async () => {
    const db = makeTestDb();
    seed(db);
    const id = mail(db);
    sortMail(db, id, BLOG);
    await run(db, message('About Vue'));
    const after = db.prepare('SELECT * FROM mail_messages').get() as Record<string, unknown>;
    expect(after).toMatchObject({ category_id: BLOG, source: 'owner', excerpt: 'About Vue', state: 'filed' });
    expect(pending(db)).toEqual([]);
  });

  test('a mail with a secret or a sensitive one stays in the category and keeps no excerpt', async () => {
    for (const [body, sensitive] of [['Your login code 482913', 0.05], ['About Vue', 0.95]] as const) {
      const db = makeTestDb();
      seed(db);
      sortMail(db, mail(db), BLOG);
      await run(db, message(body), sensitive);
      expect(db.prepare('SELECT * FROM mail_messages').get()).toMatchObject({ category_id: BLOG, source: 'owner', excerpt: null, eligible: 0 });
    }
  });
});

describe('routes', () => {
  const setup = async () => {
    const t = await buildTestApp({ loggedIn: true, plugins: [emailRoutes({ client: () => null, tokens: { get: () => null, set: () => {}, delete: () => {} } })] });
    seed(t.db);
    const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) => t.app.inject(t.authed({ method, url: `/api/email${url}`, ...(payload ? { payload } : {}) }));
    return { ...t, call };
  };

  test('needs sorting groups by sender, failed mail included', async () => {
    const t = await setup();
    mail(t.db, { gmail_id: 'a', suggestion_id: BLOG });
    mail(t.db, { gmail_id: 'b' });
    mail(t.db, { gmail_id: 'c', state: 'failed', sender: null, subject: null });
    const { groups } = (await t.call('GET', '/needs-sorting')).json();
    expect(groups.map((g: { sender: string | null; mails: unknown[] }) => [g.sender, g.mails.length])).toEqual([['news@example.com', 2], [null, 1]]);
    expect((await t.call('GET', '/overview')).json().needs_sorting).toBe(3);
  });

  test('the overview counts a mail in two accounts once', async () => {
    const t = await setup();
    t.db.prepare(`INSERT INTO mail_accounts (email) VALUES ('b@example.com')`).run();
    mail(t.db, { gmail_id: 'a', state: 'filed', category_id: BLOG, rfc_message_id: '<x>' });
    mail(t.db, { account_id: 2, gmail_id: 'b', state: 'filed', category_id: BLOG, rfc_message_id: '<x>' });
    mail(t.db, { gmail_id: 'c', state: 'filed', category_id: BLOG });
    const { categories } = (await t.call('GET', '/overview')).json();
    expect(categories[0]).toMatchObject({ name: 'Blog ideas', count: 2 });
  });

  test('just this mail makes no rule; always this sender does, and moves stored mail', async () => {
    const t = await setup();
    const a = mail(t.db, { gmail_id: 'a' });
    const b = mail(t.db, { gmail_id: 'b' });
    await t.call('POST', `/mails/${a}/sort`, { category_id: NOISE });
    expect((await t.call('GET', '/overview')).json().rules).toEqual([]);
    expect(row(t.db, b)['state']).toBe('needs_sorting');

    const res = await t.call('POST', `/mails/${a}/sort`, { category_id: NOISE, always: true, apply_stored: true });
    expect(res.json()).toEqual({ moved: 2 });
    expect(row(t.db, b)).toMatchObject({ state: 'filed', category_id: NOISE });
    expect((await t.call('GET', '/overview')).json().rules).toEqual([{ sender: 'news@example.com', category_id: NOISE }]);
    expect((await t.call('DELETE', `/rules?sender=${encodeURIComponent('news@example.com')}`)).json()).toEqual({ ok: true });
    expect((await t.call('DELETE', '/rules?sender=x')).statusCode).toBe(404);
  });

  test('a rule without a sender is refused, and nothing moves', async () => {
    const t = await setup();
    const id = mail(t.db, { state: 'failed', sender: null, subject: null });
    expect((await t.call('POST', `/mails/${id}/sort`, { category_id: NOISE, always: true })).json()).toEqual({ error: 'no_sender' });
    expect(row(t.db, id)['state']).toBe('failed');
  });

  test('categories: add, rename, a taken name, remove, and the system ones stay', async () => {
    const t = await setup();
    const { id } = (await t.call('POST', '/categories', { name: ' Podcasts ' })).json();
    expect((await t.call('POST', '/categories', { name: 'Podcasts' })).statusCode).toBe(409);
    expect((await t.call('POST', '/categories', { name: '   ' })).statusCode).toBe(400);
    expect((await t.call('PATCH', `/categories/${id}`, { name: 'Career' })).statusCode).toBe(409);
    expect((await t.call('PATCH', `/categories/${PERSONAL}`, { name: 'Private' })).statusCode).toBe(200);
    const m = mail(t.db, { state: 'filed', category_id: id, excerpt: 'text', eligible: 1 });
    expect((await t.call('DELETE', `/categories/${id}`)).json()).toEqual({ ok: true });
    expect(row(t.db, m)).toMatchObject({ state: 'needs_sorting', category_id: null, excerpt: null });
    expect((await t.call('DELETE', `/categories/${PERSONAL}`)).json()).toEqual({ error: 'system_category' });
    expect((await t.call('DELETE', '/categories/999')).statusCode).toBe(404);
  });

  test('a Personal mail lists with no text', async () => {
    const t = await setup();
    mail(t.db, { state: 'filed', category_id: PERSONAL, is_personal: 1, sender: null, subject: null });
    expect((await t.call('GET', `/categories/${PERSONAL}/mails`)).json().mails[0]).toMatchObject({ sender: null, subject: null });
  });
});
