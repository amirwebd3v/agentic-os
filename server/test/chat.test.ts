import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { buildApp } from '../src/app.ts';
import { enqueueIdle } from '../src/chat/idle.ts';
import { history, systemPrompt } from '../src/chat/prompt.ts';
import type { Database } from '../src/db/index.ts';
import { areaRoutes } from '../src/http/routes/areas.ts';
import { sessionRoutes } from '../src/http/routes/sessions.ts';
import { buildTestApp, fakeLlm, HOST, ORIGIN } from './helpers.ts';
import type { FakeLlm, TestApp } from './helpers.ts';

const apps: TestApp['app'][] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

async function setup(llm: FakeLlm = fakeLlm(['ok'])) {
  const t = await buildTestApp({ loggedIn: true, plugins: [sessionRoutes(llm), areaRoutes] });
  apps.push(t.app);
  const newSession = async () => (await t.app.inject(t.authed({ method: 'POST', url: '/api/sessions', payload: { mode: 'chat' } }))).json();
  const say = (id: number, content: string) =>
    t.app.inject(t.authed({ method: 'POST', url: `/api/sessions/${id}/messages`, payload: { content } }));
  return { ...t, llm, newSession, say };
}

const events = (body: string) =>
  body
    .split('\n\n')
    .filter(Boolean)
    .map((e) => JSON.parse(e.replace(/^data: /, '')));
const reply = (db: Database) =>
  db.prepare(`SELECT content, status, model FROM messages WHERE role = 'assistant' ORDER BY id DESC`).get() as {
    content: string;
    status: string;
    model: string;
  };

test('streams deltas in contract order and persists both turns', async () => {
  const t = await setup(fakeLlm(['Hel', 'lo']));
  const s = await t.newSession();
  const r = await t.say(s.id, 'hi');
  expect(r.statusCode).toBe(200);
  expect(r.headers['content-type']).toMatch(/^text\/event-stream/);
  expect(r.headers['x-content-type-options']).toBe('nosniff'); // security headers still apply to the stream
  const evs = events(r.body);
  expect(evs[0]).toEqual({ user_message_id: expect.any(Number), assistant_message_id: expect.any(Number) });
  expect(evs.slice(1)).toEqual([
    { delta: 'Hel' },
    { delta: 'lo' },
    { done: true, usage: { input_tokens: 10, output_tokens: 2, cache_read_tokens: 4 } },
  ]);
  expect(reply(t.db)).toEqual({ content: 'Hello', status: 'done', model: t.app.config.llm.models.work });
  expect(t.llm.calls[0]).toMatchObject({ pipeline: 'chat', tier: 'work', messages: [{ role: 'user', content: 'hi' }] });

  await t.say(s.id, 'again');
  expect(t.llm.calls[1]!.messages).toEqual([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'Hello' },
    { role: 'user', content: 'again' },
  ]);
  const got = (await t.app.inject(t.authed({ url: `/api/sessions/${s.id}` }))).json();
  expect(got.messages.map((m: { role: string; status: string }) => `${m.role}:${m.status}`)).toEqual([
    'user:done', 'assistant:done', 'user:done', 'assistant:done',
  ]);
  expect(got.session.last_message_at).toMatch(/Z$/);
});

test('error mid-stream keeps the partial text and ends with the error kind', async () => {
  const t = await setup(fakeLlm(['Hel', 'lo ', 'wor', 'ld'], { delayMs: 600, failAfter: 2 }));
  const s = await t.newSession();
  const evs = events((await t.say(s.id, 'hi')).body);
  expect(evs.at(-1)).toEqual({ error: { kind: 'overloaded' } });
  expect(reply(t.db)).toMatchObject({ status: 'error', content: 'Hello ' });
});

test('a stream that ends without a final message is an error, not a hang', async () => {
  const llm: FakeLlm = { calls: [], configured: () => true, async *stream() { yield { type: 'text', text: 'x' }; } };
  const t = await setup(llm);
  const s = await t.newSession();
  expect(events((await t.say(s.id, 'hi')).body).at(-1)).toEqual({ error: { kind: 'network' } });
  expect(reply(t.db)).toMatchObject({ status: 'error', content: 'x' });
});

test('partial content is flushed to the DB while streaming', async () => {
  const t = await setup(fakeLlm(['a', 'b'], { delayMs: 1600 }));
  const s = await t.newSession();
  const pending = t.say(s.id, 'hi');
  await vi.waitFor(() => expect(reply(t.db)).toMatchObject({ content: 'a', status: 'streaming' }), { timeout: 3000, interval: 50 });
  await pending;
  expect(reply(t.db)).toMatchObject({ content: 'ab', status: 'done' });
});

test('client disconnect aborts the model call and stores the partial reply as aborted', async () => {
  const t = await setup(fakeLlm(['a', 'b', 'c'], { delayMs: 300 }));
  const s = await t.newSession();
  await t.app.listen({ host: '127.0.0.1', port: 0 });
  const { port } = t.app.server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1', port, method: 'POST', path: `/api/sessions/${s.id}/messages`,
        headers: { host: HOST, origin: ORIGIN, cookie: t.cookie, 'x-aos': '1', 'content-type': 'application/json' },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
          if (body.includes('"delta"')) {
            req.destroy();
            resolve();
          }
        });
      },
    );
    req.on('error', (err) => (req.destroyed ? undefined : reject(err)));
    req.end(JSON.stringify({ content: 'hi' }));
  });
  await vi.waitFor(() => expect(reply(t.db)).toMatchObject({ status: 'aborted', content: 'a' }));
  expect(t.llm.calls[0]!.signal?.aborted).toBe(true);
});

test('boot: replies still streaming become aborted and keep their content', async () => {
  const t = await setup();
  const s = await t.newSession();
  t.db.prepare(`INSERT INTO messages (session_id, role, content, status) VALUES (?, 'assistant', 'half a rep', 'streaming')`).run(s.id);
  const rebooted = await buildApp({ db: t.db, config: t.app.config, plugins: [sessionRoutes(fakeLlm([]))], logger: false });
  apps.push(rebooted);
  await rebooted.ready();
  expect(reply(t.db)).toMatchObject({ status: 'aborted', content: 'half a rep' });
});

test('no key: 409 provider_not_configured and nothing stored', async () => {
  const t = await setup(fakeLlm([], { configured: false }));
  const s = await t.newSession();
  const r = await t.say(s.id, 'hi');
  expect(r.statusCode).toBe(409);
  expect(r.json()).toEqual({ error: 'provider_not_configured' });
  expect(t.db.prepare('SELECT COUNT(*) n FROM messages').get()).toEqual({ n: 0 });
});

test('message input limits and unknown sessions', async () => {
  const t = await setup();
  const s = await t.newSession();
  expect((await t.say(s.id, '')).statusCode).toBe(400);
  expect((await t.say(s.id, 'x'.repeat(20_001))).statusCode).toBe(400);
  expect((await t.say(s.id, 'x'.repeat(20_000))).statusCode).toBe(200);
  expect((await t.say(999, 'hi')).statusCode).toBe(404);
  expect((await t.app.inject(t.authed({ url: '/api/sessions/999' }))).statusCode).toBe(404);
  expect((await t.app.inject(t.authed({ url: '/api/sessions/abc' }))).statusCode).toBe(400);
  expect((await t.app.inject(t.authed({ method: 'POST', url: '/api/sessions', payload: { mode: 'x' } }))).statusCode).toBe(400);
});

test('manual area change sets filing_status user and records one correction', async () => {
  const t = await setup();
  const s = await t.newSession();
  expect(s).toMatchObject({ mode: 'chat', area_id: null, filing_status: null, title: null });
  const patch = (payload: object) => t.app.inject(t.authed({ method: 'PATCH', url: `/api/sessions/${s.id}`, payload }));
  const dev = t.areaId('software-development');

  const r = await patch({ area_id: dev, title: ' Pinia store ' });
  expect(r.json()).toMatchObject({ area_id: dev, area_slug: 'software-development', filing_status: 'user', title: 'Pinia store' });
  await patch({ area_id: dev }); // same area: a confirmation, not a correction
  await patch({ title: 'Renamed' });
  const decisions = () => t.db.prepare('SELECT subject_type, subject_id, question, answer, final_answer, corrected_by_user FROM decisions').all();
  expect(decisions()).toEqual([
    { subject_type: 'session', subject_id: String(s.id), question: 'area', answer: null, final_answer: 'software-development', corrected_by_user: 1 },
  ]);

  await patch({ area_id: t.areaId('career') });
  expect(decisions()).toHaveLength(2);
  expect(decisions()[1]).toMatchObject({ answer: 'software-development', final_answer: 'career' });

  expect((await patch({ area_id: 9999 })).statusCode).toBe(400);
  expect((await patch({})).statusCode).toBe(400);
  expect((await patch({ title: 'x'.repeat(201) })).statusCode).toBe(400);
});

test('list filters by area and text, newest activity first; areas list', async () => {
  const t = await setup();
  const a = await t.newSession();
  const b = await t.newSession();
  await t.app.inject(t.authed({ method: 'PATCH', url: `/api/sessions/${a.id}`, payload: { area_id: t.areaId('health'), title: 'Sleep 100%' } }));
  await t.say(b.id, 'about vue_router');
  const list = async (qs = '') => (await t.app.inject(t.authed({ url: `/api/sessions${qs}` }))).json().map((s: { id: number }) => s.id);
  expect(await list()).toEqual([b.id, a.id]);
  expect(await list('?area=health')).toEqual([a.id]);
  expect(await list('?q=vue_r')).toEqual([b.id]);
  expect(await list('?q=100%25')).toEqual([a.id]);
  expect(await list('?q=_')).toEqual([b.id]); // `_` is literal, not a wildcard

  const areas = (await t.app.inject(t.authed({ url: '/api/areas' }))).json();
  expect(areas).toHaveLength(10);
  expect(areas[0]).toEqual({ id: expect.any(Number), slug: 'software-development', name: 'Software development', parent_id: null, status: 'active', mode: 'do' });
});

test('listing 100 sessions takes under 100 ms', async () => {
  const t = await setup();
  t.db.transaction(() => {
    for (let i = 0; i < 100; i++) {
      const { id } = t.db.prepare('INSERT INTO sessions (title) VALUES (?) RETURNING id').get(`s${i}`) as { id: number };
      for (let j = 0; j < 20; j++) t.db.prepare(`INSERT INTO messages (session_id, role, content) VALUES (?, 'user', ?)`).run(id, 'lorem ipsum '.repeat(50));
    }
  })();
  await t.app.inject(t.authed({ url: '/api/sessions' })); // warm up
  const started = performance.now();
  const r = await t.app.inject(t.authed({ url: '/api/sessions?q=ipsum' }));
  const ms = performance.now() - started;
  console.log(`list 100 sessions: ${ms.toFixed(1)} ms`);
  expect(r.json()).toHaveLength(100);
  expect(ms).toBeLessThan(100);
});

test('idle trigger enqueues categorize_session once per last message; /end too', async () => {
  const t = await setup();
  const s = await t.newSession();
  const add = (ago: string) =>
    (t.db
      .prepare(`INSERT INTO messages (session_id, role, content, created_at) VALUES (?, 'user', 'x', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?)) RETURNING id`)
      .get(s.id, ago) as { id: number }).id;
  const jobs = () => t.db.prepare('SELECT kind, idempotency_key k, payload FROM jobs ORDER BY id').all() as { kind: string; k: string; payload: string }[];

  add('-1 minutes');
  expect(enqueueIdle(t.db, 15)).toBe(0); // not idle yet
  const m1 = add('-20 minutes');
  t.db.prepare(`UPDATE messages SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 minutes')`).run();
  expect(enqueueIdle(t.db, 15)).toBe(1);
  expect(enqueueIdle(t.db, 15)).toBe(0);
  expect(jobs()).toEqual([{ kind: 'categorize_session', k: `categorize:${s.id}:${m1}`, payload: JSON.stringify({ sessionId: s.id, upToMessageId: m1 }) }]);

  t.db.prepare('UPDATE sessions SET last_categorized_message_id = ?').run(m1);
  expect(enqueueIdle(t.db, 15)).toBe(0);
  const m2 = add('-20 minutes');
  expect(enqueueIdle(t.db, 15)).toBe(1);

  const end = () => t.app.inject(t.authed({ method: 'POST', url: `/api/sessions/${s.id}/end` }));
  const r = await end();
  expect(r.statusCode).toBe(202);
  expect(r.json()).toEqual({ queued: false }); // already queued by the idle trigger for m2
  const m3 = add('-0 minutes');
  expect((await end()).json()).toEqual({ queued: true });
  expect(jobs().map((j) => j.k)).toEqual([`categorize:${s.id}:${m1}`, `categorize:${s.id}:${m2}`, `categorize:${s.id}:${m3}`]);
});

test('401 without a session and 403 without X-AOS on every new route', async () => {
  const t = await setup();
  const s = await t.newSession();
  const routes = [
    ['GET', '/api/areas'],
    ['GET', '/api/sessions'],
    ['POST', '/api/sessions'],
    ['GET', `/api/sessions/${s.id}`],
    ['PATCH', `/api/sessions/${s.id}`],
    ['POST', `/api/sessions/${s.id}/end`],
    ['POST', `/api/sessions/${s.id}/messages`],
  ] as const;
  for (const [method, url] of routes) {
    expect((await t.app.inject(t.authed({ method, url, headers: { cookie: '' } }))).statusCode, `${method} ${url}`).toBe(401);
    if (method !== 'GET') expect((await t.app.inject(t.authed({ method, url, headers: { 'x-aos': '' } }))).statusCode, `${method} ${url}`).toBe(403);
  }
  expect(t.llm.calls).toHaveLength(0);
});

test('prompt: vault rules plus sorted persona files, _questions.md excluded; missing vault is empty', () => {
  const vault = mkdtempSync(join(tmpdir(), 'aos-chat-vault-'));
  try {
    mkdirSync(join(vault, 'persona'));
    writeFileSync(join(vault, 'CLAUDE.md'), '# Rules\n');
    writeFileSync(join(vault, 'persona', 'b-values.md'), 'B');
    writeFileSync(join(vault, 'persona', 'a-style.md'), 'A');
    writeFileSync(join(vault, 'persona', '_questions.md'), 'Q');
    writeFileSync(join(vault, 'persona', 'notes.txt'), 'T');
    expect(systemPrompt(vault)).toEqual({ rules: '# Rules', persona: 'A\n\nB' });
    expect(systemPrompt(join(vault, 'nope'))).toEqual({ rules: '', persona: '' });
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

test('history skips empty replies and never starts with an assistant turn', async () => {
  const t = await setup();
  const s = await t.newSession();
  const ins = t.db.prepare('INSERT INTO messages (session_id, role, content, status) VALUES (?, ?, ?, ?)');
  ins.run(s.id, 'assistant', 'orphan', 'done');
  ins.run(s.id, 'user', 'q', 'done');
  ins.run(s.id, 'assistant', '', 'aborted');
  ins.run(s.id, 'assistant', 'partial', 'aborted');
  ins.run(s.id, 'assistant', '', 'streaming');
  expect(history(t.db, s.id)).toEqual([
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'partial' },
  ]);
});
