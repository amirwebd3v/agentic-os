import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type Anthropic from '@anthropic-ai/sdk';
import { onTestFinished } from 'vitest';
import type { FastifyInstance, FastifyPluginAsync, FastifyServerOptions, InjectOptions } from 'fastify';
import { buildApp } from '../src/app.ts';
import { parseConfig } from '../src/config.ts';
import { openDb } from '../src/db/index.ts';
import type { Database } from '../src/db/index.ts';
import type { SessionFiling } from '../src/chat/filing-schema.ts';
import { enqueueCategorize, lastMessageId } from '../src/chat/idle.ts';
import type { ChatLlm } from '../src/chat/stream.ts';
import { enqueue } from '../src/db/jobs.ts';
import { DeciderError } from '../src/decider/client.ts';
import { createLoginToken } from '../src/http/auth.ts';
import { categorizeSession } from '../src/jobs/categorize-session.ts';
import type { CategorizeDeps } from '../src/jobs/categorize-session.ts';
import { runNext } from '../src/jobs/runner.ts';
import type { structured, SystemPrompt } from '../src/llm/client.ts';
import { LlmError } from '../src/llm/errors.ts';
import { createWriter } from '../src/vault/writer.ts';

type CategorizeDecider = NonNullable<CategorizeDeps['decider']>;

/** In-memory database with all migrations applied. Extend here for per-ticket fixtures. */
export function makeTestDb(): Database {
  return openDb(':memory:');
}

export const HOST = '127.0.0.1:3000';
export const ORIGIN = `http://${HOST}`;

export interface TestApp {
  app: FastifyInstance;
  db: Database;
  /** `aos_session=<token>` when `loggedIn`, else empty. */
  cookie: string;
  /** An unused one-time login token. */
  loginToken: string;
  /** Adds the host, origin, cookie and `x-aos` headers a logged-in browser tab would send. */
  authed: (req: InjectOptions) => InjectOptions;
  /** Id of an area by slug (seeded by migration 0001). */
  areaId: (slug: string) => number;
}

/**
 * App on an in-memory db, port 3000, logging off. `plugins` mount under `/api` like in main.ts.
 * `webDist` defaults to a missing dir so a local `pnpm build` can't change test results.
 */
export async function buildTestApp({
  loggedIn = false,
  plugins = [],
  logger = false,
  webDist = join(tmpdir(), 'aos-no-web-dist'),
}: {
  loggedIn?: boolean;
  plugins?: FastifyPluginAsync[];
  logger?: FastifyServerOptions['logger'];
  webDist?: string;
} = {}): Promise<TestApp> {
  const db = makeTestDb();
  const config = parseConfig({ vaultDir: join(tmpdir(), 'aos-test-vault'), dataDir: join(tmpdir(), 'aos-test-data') });
  const app = await buildApp({ db, config, plugins, logger, webDist });
  let cookie = '';
  if (loggedIn) {
    const r = await app.inject({ url: `/login?t=${createLoginToken(db)}`, headers: { host: HOST } });
    cookie = String(r.headers['set-cookie']).split(';')[0] ?? '';
  }
  const authed = (req: InjectOptions): InjectOptions => ({
    ...req,
    headers: { host: HOST, origin: ORIGIN, cookie, 'x-aos': '1', ...req.headers },
  });
  const areaId = (slug: string) => (db.prepare('SELECT id FROM areas WHERE slug = ?').get(slug) as { id: number }).id;
  return { app, db, cookie, loginToken: createLoginToken(db), authed, areaId };
}

export interface FakeLlm extends ChatLlm {
  /** Every `stream()` request, for prompt assertions. */
  calls: Parameters<ChatLlm['stream']>[1][];
}

/**
 * Stand-in for the LLM client's `stream()`: yields `chunks` `delayMs` apart, then `done`.
 * `failAfter: n` throws an `overloaded` LlmError after n chunks; `configured: false` acts like a missing key.
 * Honours the request's abort signal like the SDK does.
 */
export function fakeLlm(
  chunks: string[],
  { delayMs = 0, failAfter, configured = true }: { delayMs?: number; failAfter?: number; configured?: boolean } = {},
): FakeLlm {
  const calls: FakeLlm['calls'] = [];
  return {
    calls,
    configured: () => configured,
    async *stream(_deps, req) {
      calls.push(req);
      for (const [i, text] of chunks.entries()) {
        if (i === failAfter) throw new LlmError('overloaded', 'fake failure', 529);
        try {
          await sleep(delayMs, undefined, { signal: req.signal });
        } catch {
          throw new LlmError('aborted', 'request aborted');
        }
        yield { type: 'text', text };
      }
      yield { type: 'done', usage: { input_tokens: 10, output_tokens: chunks.length, cache_read_input_tokens: 4 } as Anthropic.Usage };
    },
  };
}

const DEFAULT_FILING: SessionFiling = {
  area_slug: 'software-development',
  subarea: null,
  propose_top_level: null,
  tags: [],
  title: 'Vue bug',
  summary: 's',
  decisions: [],
  todos: [],
  facts_about_me: [],
  preferences: [],
  open_questions: [],
  lessons: [],
};

const DEFAULT_CHAT = [
  { role: 'user', content: 'My Vue component loses state after a route change.' },
  { role: 'assistant', content: 'Move the state into a Pinia store.' },
] as const;

export interface CategorizeOptions {
  /** Decider answers by question; `deciderDown` makes every call throw `decider_down`. */
  decider?: Record<string, { choice: string; confidence: number }>;
  deciderDown?: boolean;
  /** Claude's filing, merged over a valid default (`software-development`, title "Vue bug"). */
  llm?: Partial<SessionFiling>;
  /** Files the first session as `user` in this area before the job runs. */
  userFiled?: string;
}

/**
 * W1-10: in-memory db, temp vault (no git commits), fake decider and fake `structured()`, one session with a short chat.
 * `run()` queues `categorize_session` like the idle timer does and lets the runner take it.
 */
export async function setupCategorize({ decider, deciderDown = false, llm = {}, userFiled }: CategorizeOptions = {}) {
  const db = makeTestDb();
  const vaultDir = mkdtempSync(join(tmpdir(), 'aos-cat-'));
  onTestFinished(() => rmSync(vaultDir, { recursive: true, force: true }));
  const config = parseConfig({ vaultDir, dataDir: join(tmpdir(), 'aos-test-data') });
  const areaId = (slug: string) => (db.prepare('SELECT id FROM areas WHERE slug = ?').get(slug) as { id: number } | undefined)?.id;

  const deciderCalls: Parameters<CategorizeDecider['decide']>[] = [];
  const llmCalls: { system: SystemPrompt | undefined; input: string }[] = [];
  let filing: SessionFiling = { ...DEFAULT_FILING, ...llm };
  let duringLlm = () => {};
  const fakeDecider: CategorizeDecider = {
    async decide(...args) {
      deciderCalls.push(args);
      if (deciderDown) throw new DeciderError('decider_down', 'fake: down');
      const answers = Object.fromEntries(
        Object.entries(decider ?? { area: { choice: 'software-development', confidence: 0.9 } }).map(([q, a]) => {
          db.prepare(`INSERT INTO decisions (subject_type, subject_id, question, answer, confidence, backend) VALUES (?, ?, ?, ?, ?, 'fake')`).run(
            args[2]?.subject?.type ?? 'adhoc', args[2]?.subject?.id ?? '', q, a.choice, a.confidence,
          );
          return [q, { type: 'choice' as const, probabilities: {}, ...a }];
        }),
      );
      return { answers, latencyMs: 1 };
    },
  };
  const fakeStructured = (async (_deps, req) => {
    llmCalls.push({ system: req.system, input: req.input });
    duringLlm();
    return structuredClone(filing);
  }) as typeof structured;
  const writer = createWriter({ db, vaultDir, commit: false });
  const handle = categorizeSession({ db, config, writer, decider: fakeDecider, llm: fakeStructured });

  const newSession = (messages: readonly { role: string; content: string }[] = DEFAULT_CHAT): number => {
    const id = (db.prepare(`INSERT INTO sessions (mode) VALUES ('chat') RETURNING id`).get() as { id: number }).id;
    for (const m of messages) db.prepare('INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)').run(id, m.role, m.content);
    return id;
  };
  const sessionId = newSession();
  if (userFiled) db.prepare(`UPDATE sessions SET filing_status = 'user', area_id = ? WHERE id = ?`).run(areaId(userFiled), sessionId);

  const session = (id = sessionId) =>
    db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as {
      area_id: number | null;
      area_confidence: number | null;
      filing_status: string | null;
      title: string | null;
      tags: string;
      summary_path: string | null;
      last_categorized_message_id: number | null;
    };
  return {
    db,
    vaultDir,
    sessionId,
    deciderCalls,
    llmCalls,
    handle,
    newSession,
    areaId,
    /** Replaces Claude's answer for the next runs. */
    setLlm: (patch: Partial<SessionFiling>) => (filing = { ...DEFAULT_FILING, ...patch }),
    /** Runs while Claude "answers", e.g. a user filing the session meanwhile. */
    setDuringLlm: (fn: () => void) => (duringLlm = fn),
    /** Queues the job (default key `categorize:<sid>:<lastMsg>`) and runs everything due. */
    async run(id = sessionId, key?: string) {
      const upTo = lastMessageId(db, id)!;
      if (key) enqueue(db, 'categorize_session', key, { sessionId: id, upToMessageId: upTo });
      else enqueueCategorize(db, id, upTo);
      while (await runNext(db, { categorize_session: handle }));
    },
    session,
    note: (rel: string) => readFileSync(join(vaultDir, rel), 'utf8'),
    noteText: (id = sessionId) => readFileSync(join(vaultDir, session(id).summary_path!), 'utf8'),
    noteExists: (rel: string) => existsSync(join(vaultDir, rel)),
    approvals: (type: string) =>
      (db.prepare('SELECT * FROM approvals WHERE action_type = ? ORDER BY id').all(type) as { id: number; payload: string; status: string; original_text: string | null }[]).map(
        (a) => ({ ...a, payload: JSON.parse(a.payload) as Record<string, unknown> }),
      ),
    areaExists: (slug: string) => areaId(slug) !== undefined,
  };
}
