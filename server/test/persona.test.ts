import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { enqueueIdle } from '../src/chat/idle.ts';
import { DAILY_CAP, nextQuestions, parseBank, personaTurn, tickQuestion, TOPICS } from '../src/chat/modes/persona.ts';
import { startTurn, streamReply } from '../src/chat/stream.ts';
import { parseConfig } from '../src/config.ts';
import { verifyAuditChain } from '../src/db/audit.ts';
import type { Database } from '../src/db/index.ts';
import { approvalRoutes } from '../src/http/routes/approvals.ts';
import { sessionRoutes } from '../src/http/routes/sessions.ts';
import { extractPersona, type PersonaExtraction } from '../src/jobs/extract-persona.ts';
import type { structured } from '../src/llm/client.ts';
import { sha256 } from '../src/vault/writer.ts';
import { buildTestApp, fakeLlm, makeTestDb, setupCategorize } from './helpers.ts';
import type { z } from 'zod';

const TEMPLATE = new URL('../templates/persona-questions.md', import.meta.url);
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Temp vault with the real question bank. */
function tempVault(): string {
  const vault = mkdtempSync(join(tmpdir(), 'aos-persona-'));
  dirs.push(vault);
  mkdirSync(join(vault, 'persona'));
  copyFileSync(TEMPLATE, join(vault, 'persona', '_questions.md'));
  return vault;
}

const newSession = (db: Database, mode: 'chat' | 'persona' = 'persona') =>
  (db.prepare('INSERT INTO sessions (mode) VALUES (?) RETURNING id').get(mode) as { id: number }).id;
const say = (db: Database, sessionId: number, role: 'user' | 'assistant', content: string) =>
  db.prepare('INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)').run(sessionId, role, content);
const asked = (db: Database, sessionId: number) =>
  db.prepare('SELECT question_id FROM persona_questions WHERE session_id = ? ORDER BY rowid').pluck().all(sessionId);

const bank = `- [x] (values) Q1\n- [ ] (values) Q2\n- [ ] (study) Q3`;
test('skips answered questions and respects the daily cap', () => {
  expect(nextQuestions(bank, { askedToday: 0, cap: 10 }).map((q) => q.text)).toEqual(['Q2', 'Q3']);
  expect(nextQuestions(bank, { askedToday: 10, cap: 10 })).toEqual([]);
  expect(nextQuestions(bank, { askedToday: 9, cap: 10, skip: [parseBank(bank)[1]!.id] }).map((q) => q.text)).toEqual(['Q3']);
});

test('the template bank: about 60 questions, every topic, unique explicit ids', () => {
  const text = readFileSync(TEMPLATE, 'utf8');
  const qs = parseBank(text);
  expect(qs.length).toBeGreaterThanOrEqual(55);
  expect(qs.length).toBe(text.split('\n').filter((l) => l.startsWith('- [')).length); // every item line parses
  expect(new Set(qs.map((q) => q.topic))).toEqual(new Set(TOPICS));
  expect(new Set(qs.map((q) => q.id)).size).toBe(qs.length);
  expect(qs.every((q) => q.id.startsWith(`${q.topic}-`) && !q.done)).toBe(true);
});

test('tickQuestion ticks by id once and keeps CRLF', () => {
  const md = '- [ ] (values) A? ^values-1\r\n- [ ] (study) B?\r\n';
  const ticked = tickQuestion(md, 'values-1')!;
  expect(ticked).toBe('- [x] (values) A? ^values-1\r\n- [ ] (study) B?\r\n');
  expect(tickQuestion(ticked, 'values-1')).toBeNull();
  expect(tickQuestion(md, parseBank(md)[1]!.id)).toContain('- [x] (study) B?');
  expect(tickQuestion(md, 'nope')).toBeNull();
});

test('persona turn: lists the next questions, records only offered ids, chat sessions get nothing', () => {
  const db = makeTestDb();
  const vault = tempVault();
  expect(personaTurn(db, vault, newSession(db, 'chat'))).toBeNull();
  const s = newSession(db);
  const turn = personaTurn(db, vault, s)!;
  expect(turn.context).toContain('Ask exactly one question per message');
  expect(turn.context).toContain('[values-1] (values) What do you optimize for');
  expect(turn.context).toContain(`0 of ${DAILY_CAP} asked today`);
  turn.record('Thanks. [values-1] What do you optimize for? [made-up-9] [study-1]'); // study-1 is past the first 10
  expect(asked(db, s)).toEqual(['values-1']);
  // Next turn: asked questions are listed and not offered again.
  const next = personaTurn(db, vault, s)!.context;
  expect(next).toContain('Asked in this session:\n- [values-1]');
  expect(next).not.toContain('[values-1] (values)');
  expect(next).toContain('[values-2] (values)');
});

test(`daily cap: ${DAILY_CAP} questions per calendar day across persona sessions`, () => {
  const db = makeTestDb();
  const vault = tempVault();
  const first = newSession(db);
  const ids = parseBank(readFileSync(TEMPLATE, 'utf8')).map((q) => q.id);
  for (const id of ids.slice(0, DAILY_CAP)) personaTurn(db, vault, first)!.record(`[${id}] …?`); // one question per turn
  expect(asked(db, first)).toHaveLength(DAILY_CAP);
  const second = newSession(db);
  const turn = personaTurn(db, vault, second)!;
  expect(turn.context).toContain(`Today's limit of ${DAILY_CAP} questions is reached`);
  turn.record(`[${ids[DAILY_CAP]}]`);
  expect(asked(db, second)).toEqual([]);
  // Yesterday's questions don't count.
  db.prepare(`UPDATE persona_questions SET asked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-2 days')`).run();
  expect(personaTurn(db, vault, second)!.context).toContain(`0 of ${DAILY_CAP} asked today`);
});

test('a persona reply gets the interview context and records the question it asked', async () => {
  const db = makeTestDb();
  const vault = tempVault();
  const config = parseConfig({ vaultDir: vault, dataDir: join(vault, 'data') });
  const s = newSession(db);
  const llm = fakeLlm(['Let us start.\n\n[values-1] What do you ', 'optimize for?']);
  const ids = startTurn(db, s, 'hi', 'm');
  await streamReply({ db, config, llm, sessionId: s, assistantId: ids.assistant_message_id, signal: new AbortController().signal, send: () => {} });
  expect(llm.calls[0]!.system?.context).toContain('persona interview');
  expect(asked(db, s)).toEqual(['values-1']);
});

test('persona sessions are never categorized: /end and the idle timer queue extract_persona', async () => {
  const t = await buildTestApp({ loggedIn: true, plugins: [sessionRoutes(fakeLlm(['ok']))] });
  const persona = newSession(t.db);
  const chat = newSession(t.db, 'chat');
  for (const s of [persona, chat]) say(t.db, s, 'user', 'hi');
  const res = await t.app.inject(t.authed({ method: 'POST', url: `/api/sessions/${persona}/end` }));
  expect(res.json()).toEqual({ queued: true });
  t.db.prepare(`UPDATE messages SET created_at = '2000-01-01T00:00:00.000Z'`).run();
  enqueueIdle(t.db, 5);
  const jobs = t.db.prepare(`SELECT kind, json_extract(payload, '$.sessionId') s FROM jobs ORDER BY id`).all();
  expect(jobs).toEqual([
    { kind: 'extract_persona', s: persona },
    { kind: 'categorize_session', s: chat },
  ]);

  // And the categorize handler itself ignores a persona session.
  const c = await setupCategorize();
  c.db.prepare(`UPDATE sessions SET mode = 'persona' WHERE id = ?`).run(c.sessionId);
  await c.handle({ id: 1, idempotency_key: 'recategorize:x', payload: { sessionId: c.sessionId, upToMessageId: 2 } });
  expect(c.llmCalls).toHaveLength(0);
});

type Statements = z.infer<typeof PersonaExtraction>['statements'];

/** A persona session that asked values-1 and writing-style-3, a temp vault, and a fake `structured()`. */
function setupExtract(statements: Statements, db: Database = makeTestDb(), vault = tempVault()) {
  const config = parseConfig({ vaultDir: vault, dataDir: join(vault, 'data') });
  const s = newSession(db);
  say(db, s, 'assistant', '[values-1] What do you optimize for?');
  say(db, s, 'user', 'Mostly   for time with my family, honestly.');
  say(db, s, 'assistant', '[writing-style-3] When do you write "Sie"?');
  say(db, s, 'user', 'Immer Sie, außer bei Kommilitonen.');
  for (const q of ['values-1', 'writing-style-3']) db.prepare('INSERT INTO persona_questions (session_id, question_id) VALUES (?, ?)').run(s, q);
  const calls: { input: string; context: string | undefined }[] = [];
  const llm = (async (_deps, req) => {
    calls.push({ input: req.input, context: req.system?.context });
    return { statements } as never;
  }) as typeof structured;
  const handle = extractPersona({ db, config, llm });
  const last = (db.prepare('SELECT MAX(id) FROM messages').pluck().get() as number);
  const run = () => handle({ id: 1, payload: { sessionId: s, upToMessageId: last } });
  const approvals = () =>
    (db.prepare(`SELECT * FROM approvals WHERE action_type = 'persona_statement' ORDER BY id`).all() as { payload: string; original_text: string }[]).map(
      (a) => ({ ...a, payload: JSON.parse(a.payload) as Record<string, string> }),
    );
  return { db, vault, s, calls, run, approvals };
}

test('extract: one approval per answered question; invented quotes and unasked questions are dropped', async () => {
  const t = setupExtract([
    { question_id: 'values-1', topic: 'study', statement: ' Optimizes for  time with family. ', in_my_words: 'for time with my family' },
    { question_id: 'values-1', topic: 'values', statement: 'Duplicate', in_my_words: 'honestly' },
    { question_id: 'writing-style-3', topic: 'writing-style', statement: 'Always uses Sie.', in_my_words: 'I always use Sie' },
    { question_id: 'routines-1', topic: 'routines', statement: 'Never asked', in_my_words: 'honestly' },
  ]);
  await t.run();
  expect(t.calls[0]!.input).toContain('<transcript>');
  expect(t.calls[0]!.context).toContain('values-1 (values)');
  expect(t.approvals()).toEqual([
    expect.objectContaining({
      original_text: 'Optimizes for time with family.',
      payload: {
        question_id: 'values-1',
        topic: 'values', // from the bank, not the model
        question: 'What do you optimize for when two good options conflict?',
        statement: 'Optimizes for time with family.',
        in_my_words: 'for time with my family',
      },
    }),
  ]);
  expect(verifyAuditChain(t.db)).toBe(true);
  // Re-running the same job, or a later one, proposes nothing twice.
  await t.run();
  t.db.prepare('UPDATE sessions SET last_categorized_message_id = NULL').run();
  await t.run();
  expect(t.approvals()).toHaveLength(1);
  expect(t.calls).toHaveLength(2); // the second run was a no-op
  expect(t.calls[1]!.context).not.toContain('values-1');
});

async function setupApprove() {
  const vault = tempVault();
  const app = await buildTestApp({ loggedIn: true, plugins: [approvalRoutes({ vaultDir: vault })] });
  const t = setupExtract(
    [
      { question_id: 'values-1', topic: 'values', statement: 'Optimizes for time with family.', in_my_words: 'for time with my family' },
      { question_id: 'writing-style-3', topic: 'writing-style', statement: 'Uses Sie except with classmates.', in_my_words: 'Immer Sie, außer bei Kommilitonen.' },
    ],
    app.db,
    vault,
  );
  await t.run();
  const decide = (id: number, body: object) => app.app.inject(app.authed({ method: 'POST', url: `/api/approvals/${id}/decide`, payload: body }));
  const file = (rel: string) => readFileSync(join(t.vault, rel), 'utf8');
  const row = (id: number) => app.db.prepare('SELECT status, final_text, edit_distance FROM approvals WHERE id = ?').get(id);
  return { ...t, app, decide, file, row };
}

test('approve appends the statement to persona/<topic>.md and ticks the question; reject does neither', async () => {
  const t = await setupApprove();
  expect((await t.decide(1, { decision: 'approve' })).json()).toEqual({ id: 1, status: 'approved' });
  const values = t.file('persona/values.md');
  expect(values).toBe('---\nsensitivity: 1\n---\n\n# values\n\n- Optimizes for time with family.  ^values-1\n');
  const bankText = t.file('persona/_questions.md');
  expect(bankText).toContain('- [x] (values) What do you optimize for when two good options conflict? ^values-1');
  expect(bankText.match(/- \[x\]/g)).toHaveLength(1);
  expect(t.app.db.prepare(`SELECT path, content_hash FROM vault_notes ORDER BY path`).all()).toEqual([
    { path: 'persona/_questions.md', content_hash: sha256(bankText) },
    { path: 'persona/values.md', content_hash: sha256(values) },
  ]);

  expect((await t.decide(2, { decision: 'reject' })).json()).toEqual({ id: 2, status: 'rejected' });
  expect(existsSync(join(t.vault, 'persona/writing-style.md'))).toBe(false);
  expect(t.file('persona/_questions.md')).toContain('- [ ] (writing-style) In German, when do you write "Sie" and when "du"? ^writing-style-3');
});

test('an edited statement is written and stored with its edit distance; a second one appends', async () => {
  const t = await setupApprove();
  writeFileSync(join(t.vault, 'persona/writing-style.md'), '---\nsensitivity: 1\n---\n\n# writing-style\n\n- Signs off with "Beste Grüße".  ^writing-style-4');
  const edited = 'Uses Sie with everyone except fellow students.';
  expect((await t.decide(2, { decision: 'approve', final_text: edited })).statusCode).toBe(200);
  expect(t.row(2)).toMatchObject({ status: 'approved', final_text: edited });
  expect((t.row(2) as { edit_distance: number }).edit_distance).toBeGreaterThan(0);
  expect(t.file('persona/writing-style.md')).toMatch(/\^writing-style-4\n- Uses Sie with everyone except fellow students\. {2}\^writing-style-3\n$/);
});

test('a statement already in the file is not appended twice (retry after a half-applied approval)', async () => {
  const t = await setupApprove();
  writeFileSync(join(t.vault, 'persona/values.md'), '# values\n\n- Optimizes for time with family.  ^values-1\n');
  expect((await t.decide(1, { decision: 'approve' })).statusCode).toBe(200);
  expect(t.file('persona/values.md')).toBe('# values\n\n- Optimizes for time with family.  ^values-1\n');
  expect(t.file('persona/_questions.md')).toContain('- [x] (values)');
});

test('a re-answered question is appended next to the old statement; a missing bank still approves', async () => {
  const t = await setupApprove();
  writeFileSync(join(t.vault, 'persona/values.md'), '# values\n\n- Used to optimize for speed.  ^values-1\n');
  rmSync(join(t.vault, 'persona/_questions.md'));
  expect((await t.decide(1, { decision: 'approve' })).json()).toEqual({ id: 1, status: 'approved' });
  expect(t.file('persona/values.md')).toBe(
    '# values\n\n- Used to optimize for speed.  ^values-1\n- Optimizes for time with family.  ^values-1\n',
  );
});

test('only the first offered tag in a reply is recorded; a pending question is skipped, a rejected one comes back', () => {
  const db = makeTestDb();
  const vault = tempVault();
  const s = newSession(db);
  personaTurn(db, vault, s)!.record('[values-1] and next [values-2]');
  expect(asked(db, s)).toEqual(['values-1']);

  const other = newSession(db);
  const propose = (status: string) =>
    db.prepare(`INSERT INTO approvals (action_type, payload, proposed_by, status) VALUES ('persona_statement', ?, 'persona', ?)`).run(
      JSON.stringify({ question_id: 'values-2' }),
      status,
    );
  propose('pending');
  expect(personaTurn(db, vault, other)!.context).not.toContain('[values-2]');
  db.prepare(`UPDATE approvals SET status = 'rejected'`).run();
  expect(personaTurn(db, vault, other)!.context).toContain('[values-2] (values)');
});
