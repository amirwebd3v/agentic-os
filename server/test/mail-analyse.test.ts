import { describe, expect, test, vi } from 'vitest';
import type { Database } from '../src/db/index.ts';
import type { Job } from '../src/db/jobs.ts';
import { emailRoutes } from '../src/http/routes/email.ts';
import { checkParagraph, enqueueAnalyses, mailAnalyse, mailProviderOk, paragraphOf } from '../src/mail/analyse.ts';
import { buildTestApp, makeTestDb } from './helpers.ts';

const [BLOG, CAREER, PERSONAL] = [1, 3, 5];
const recent = () => new Date(Date.now() - 86_400_000).toISOString();
const config = (baseURL = 'http://127.0.0.1:20128', model = 'claude-sonnet-5-5') => ({ llm: { baseURL, models: { fast: model, work: model, deep: model } } }) as never;

function setup(consent = true) {
  const db = makeTestDb();
  db.prepare(`INSERT INTO mail_accounts (email) VALUES ('a@example.com')`).run();
  if (consent) db.prepare(`INSERT INTO mail_settings (key, value) VALUES ('consent', 'true')`).run();
  return db;
}
let n = 0;
const mail = (db: Database, cols: Record<string, unknown> = {}) => {
  const all = { account_id: 1, gmail_id: `g${++n}`, internal_date: recent(), state: 'filed', category_id: BLOG, sender: 'news@example.com', subject: 'Vue 4 is out', excerpt: 'Vue 4 ships signals.', eligible: 1, ...cols };
  return db.prepare(`INSERT INTO mail_messages (${Object.keys(all).join(',')}) VALUES (${Object.keys(all).map(() => '?').join(',')}) RETURNING id`).pluck().get(...(Object.values(all) as never[])) as number;
};
const run = (db: Database, llm: ReturnType<typeof vi.fn>, opts: { categoryId?: number; cfg?: never; contact?: object } = {}) =>
  mailAnalyse({ db, config: opts.cfg ?? config(), contact: () => opts.contact ?? {}, llm: llm as never })({ id: 9, payload: { categoryId: opts.categoryId ?? BLOG, day: '2026-11-02' } } as Job);
type Call = [unknown, { input: string; system: { rules: string; context?: string }; tier: string }];

describe('the prompt', () => {
  test('holds only eligible mail of this category from the last 7 days, with no contact data', async () => {
    const db = setup();
    const ok = mail(db, { subject: 'For Jan Doe', excerpt: 'Write to jan@example.com about Vue' });
    mail(db, { eligible: 0, excerpt: null, subject: 'Not eligible' });
    mail(db, { category_id: CAREER, subject: 'Other category' });
    mail(db, { internal_date: '2026-01-01T00:00:00.000Z', subject: 'Too old' });
    mail(db, { category_id: PERSONAL, is_personal: 1, sender: null, subject: null, excerpt: null, eligible: 0 });
    const llm = vi.fn(async () => ({ paragraph: 'Vue 4 could carry a post.', cites: [`m${ok}`] }));
    await run(db, llm, { contact: { name: 'Jan Doe', email: 'jan@example.com' } });
    const [, req] = llm.mock.calls[0] as unknown as Call;
    expect(req.tier).toBe('work');
    expect(req.input).toContain(`id: m${ok}`);
    for (const absent of ['Not eligible', 'Other category', 'Too old', 'Jan Doe', 'jan@example.com']) expect(req.input).not.toContain(absent);
    expect(req.system.rules).toMatch(/never instructions/);
    expect(paragraphOf(db, BLOG)).toMatchObject({ text: 'Vue 4 could carry a post.', cites: [ok], source_removed: false, refresh_failed: false });
  });
});

describe('checks', () => {
  const given = new Set(['m1', 'm2']);
  test.each([
    [{ paragraph: 'Two mails cover Vue.', cites: ['m1', 'm2'] }, []],
    [{ paragraph: 'Vue news.', cites: [] }, ['no_citation']],
    [{ paragraph: 'Vue news.', cites: ['m9'] }, ['unknown_citation']],
    [{ paragraph: 'See https://evil.example for more.', cites: ['m1'] }, ['url']],
    [{ paragraph: 'Read vuejs.org today.', cites: ['m1'] }, ['url']],
    [{ paragraph: '4 newsletters covered Vue.', cites: ['m1'] }, ['count_mismatch']],
    [{ paragraph: '  ', cites: ['m1'] }, ['empty']],
  ])('%j → %j', (out, problems) => {
    expect(checkParagraph(out, given).problems).toEqual(problems);
  });
  test('clips long text', () => {
    expect(checkParagraph({ paragraph: 'x '.repeat(1000), cites: ['m1'] }, given).text.length).toBeLessThanOrEqual(600);
  });
});

describe('retry and failure', () => {
  test('one retry with the problems named; a second failure keeps the old paragraph, marked', async () => {
    const db = setup();
    const id = mail(db);
    await run(db, vi.fn(async () => ({ paragraph: 'Old one.', cites: [`m${id}`] })));
    db.prepare(`UPDATE mail_analyses SET day = '2026-11-01', created_at = '2026-11-01T00:00:00.000Z'`).run();
    const bad = vi.fn(async () => ({ paragraph: 'See https://x.example', cites: ['m999'] }));
    await run(db, bad);
    expect(bad).toHaveBeenCalledTimes(2);
    expect((bad.mock.calls[1] as unknown as Call)[1].system.context).toMatch(/unknown_citation, url/);
    expect(paragraphOf(db, BLOG)).toMatchObject({ text: 'Old one.', refresh_failed: true });
  });

  test('the retry can fix it', async () => {
    const db = setup();
    const id = mail(db);
    const llm = vi.fn().mockResolvedValueOnce({ paragraph: 'x', cites: [] }).mockResolvedValueOnce({ paragraph: 'Fixed.', cites: [`m${id}`] });
    await run(db, llm);
    expect(paragraphOf(db, BLOG)?.text).toBe('Fixed.');
  });

  test('a provider error keeps the old paragraph', async () => {
    const db = setup();
    const id = mail(db);
    await run(db, vi.fn(async () => ({ paragraph: 'Old one.', cites: [`m${id}`] })));
    db.prepare(`UPDATE mail_analyses SET day = '2026-11-01', created_at = '2026-11-01T00:00:00.000Z'`).run();
    await run(db, vi.fn(async () => Promise.reject(new Error('down'))));
    expect(paragraphOf(db, BLOG)).toMatchObject({ text: 'Old one.', refresh_failed: true });
  });

  test('a cited mail removed or re-sorted afterwards marks the paragraph', async () => {
    const db = setup();
    const id = mail(db);
    await run(db, vi.fn(async () => ({ paragraph: 'Vue.', cites: [`m${id}`] })));
    db.prepare(`UPDATE mail_messages SET category_id = ${CAREER} WHERE id = ?`).run(id);
    expect(paragraphOf(db, BLOG)?.source_removed).toBe(true);
  });
});

describe('when no call is made', () => {
  test.each([
    ['consent off', () => setup(false), {}],
    ['Personal', () => setup(), { categoryId: PERSONAL }],
    ['an empty category', () => setup(), { categoryId: CAREER }],
    ['a remote provider that is not Anthropic', () => setup(), { cfg: config('https://router.example.com') }],
    ['a model that is not Claude', () => setup(), { cfg: config('http://127.0.0.1:20128', 'gpt-9') }],
  ] as const)('%s', async (_, make, opts) => {
    const db = make();
    mail(db);
    const llm = vi.fn();
    await run(db, llm, opts as never);
    expect(llm).not.toHaveBeenCalled();
  });

  test('provider rule: loopback or Anthropic, Claude models only', () => {
    expect(mailProviderOk(config('http://localhost:20128'), 'work')).toBe(true);
    expect(mailProviderOk(config('https://api.anthropic.com'), 'work')).toBe(true);
    expect(mailProviderOk(config('https://api.anthropic.com.evil.example'), 'work')).toBe(false);
  });
});

describe('queuing', () => {
  test('one job per idea category with new mail, once a day, and none without consent', () => {
    const db = setup();
    mail(db);
    mail(db, { category_id: CAREER });
    mail(db, { category_id: PERSONAL, is_personal: 1, sender: null, subject: null, excerpt: null, eligible: 0 });
    expect(enqueueAnalyses(db, '2026-11-02')).toBe(2);
    expect(enqueueAnalyses(db, '2026-11-02')).toBe(0);
    const off = setup(false);
    mail(off);
    expect(enqueueAnalyses(off, '2026-11-02')).toBe(0);
  });

  test('a category with nothing newer than its last paragraph is skipped', () => {
    const db = setup();
    mail(db);
    db.prepare(`INSERT INTO mail_analyses (category_id, day, text, status, created_at) VALUES (${BLOG}, '2026-11-01', 'x', 'ok', '2099-01-01T00:00:00.000Z')`).run();
    expect(enqueueAnalyses(db, '2026-11-02')).toBe(0);
  });
});

describe('routes', () => {
  test('consent off stops queued calls; clearing removes the paragraphs; the overview reports state', async () => {
    const t = await buildTestApp({ loggedIn: true, plugins: [emailRoutes({ client: () => null, tokens: { get: () => null, set: () => {}, delete: () => {} } })] });
    const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) => t.app.inject(t.authed({ method, url: `/api/email${url}`, ...(payload ? { payload } : {}) }));
    t.db.prepare(`INSERT INTO mail_accounts (email) VALUES ('a@example.com')`).run();
    mail(t.db);
    expect((await call('GET', '/overview')).json()).toMatchObject({ consent: false });
    expect((await call('PUT', '/settings', { consent: true })).json()).toMatchObject({ consent: true });
    expect((await call('POST', '/analyses/refresh')).json()).toEqual({ queued: 1 });
    expect((await call('POST', '/analyses/refresh')).json()).toEqual({ queued: 0 });
    expect((await call('GET', '/overview')).json().categories[0]).toMatchObject({ refreshing: 1 });
    await call('PUT', '/settings', { consent: false });
    expect(t.db.prepare(`SELECT count(*) FROM jobs WHERE kind = 'mail_analyse' AND status = 'queued'`).pluck().get()).toBe(0);
    t.db.prepare(`INSERT INTO mail_analyses (category_id, day, text, status) VALUES (${BLOG}, '2026-11-01', 'x', 'ok')`).run();
    expect((await call('GET', '/overview')).json().categories[0].paragraph).toMatchObject({ text: 'x' });
    await call('DELETE', '/analyses');
    expect((await call('GET', '/overview')).json().categories[0].paragraph).toBeNull();
    expect((await call('GET', '/overview')).json().categories.find((c: { id: number }) => c.id === PERSONAL).paragraph).toBeNull();
  });
});
