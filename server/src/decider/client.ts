import { z } from 'zod';
import type { Database } from '../db/index.ts';

// Client for the Jev System One wire format (`POST /v1/systemone`). Laya serves it locally; Kev or
// Jev drop in by changing `baseURL`. The schema follows a real Laya response
// (test/fixtures/systemone-response.json) and ignores fields we don't use.

export type Question =
  | { type: 'choice'; instructions: string; criteria: Readonly<Record<string, string>> | readonly string[] }
  | { type: 'score'; instructions: string; criteria: readonly string[] }
  | { type: 'noul'; instructions: string; criteria?: { true?: string; false?: string } };

const Probabilities = z.record(z.string(), z.number());
const AnswerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('choice'), choice: z.string(), confidence: z.number(), probabilities: Probabilities }),
  z.object({ type: z.literal('score'), score: z.number(), confidence: z.number(), probabilities: Probabilities }),
  z.object({ type: z.literal('noul'), noul: z.number(), confidence: z.number() }),
]);
const ResponseSchema = z.object({ answers: z.record(z.string(), AnswerSchema) });

export type Answer = z.infer<typeof AnswerSchema>;

export interface DecideResult {
  answers: Record<string, Answer>;
  latencyMs: number;
}

export interface DecideOptions {
  /** What the decision is about; logged on every `decisions` row. */
  subject?: { type: string; id: string };
}

/** `decider_down`: unreachable, timed out or 5xx, so fall back to Claude. `decider_error`: 4xx or a malformed reply. */
export class DeciderError extends Error {
  constructor(
    readonly kind: 'decider_down' | 'decider_error',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'DeciderError';
  }
}

export interface DeciderConfig {
  db: Database;
  baseURL: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
}

const answerText = (a: Answer): string =>
  a.type === 'choice' ? a.choice : a.type === 'score' ? String(a.score) : String(a.noul >= 0.5);

export function createDecider({ db, baseURL, apiKey, model, timeoutMs = 5000 }: DeciderConfig) {
  const base = baseURL.replace(/\/+$/, '');
  const headers = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' };
  const insert = db.prepare(
    `INSERT INTO decisions (subject_type, subject_id, question, answer, confidence, backend, model)
     VALUES (?, ?, ?, ?, ?, 'laya', ?)`,
  );

  async function post(body: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${base}/v1/systemone`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new DeciderError('decider_down', `decider unreachable at ${base}: ${(err as Error).message}`, { cause: err });
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      throw new DeciderError(res.status >= 500 ? 'decider_down' : 'decider_error', `decider HTTP ${res.status}: ${detail}`);
    }
    try {
      return await res.json();
    } catch (err) {
      throw new DeciderError('decider_down', 'decider sent an unreadable body', { cause: err });
    }
  }

  return {
    async decide(state: unknown, questions: Record<string, Question>, opts: DecideOptions = {}): Promise<DecideResult> {
      const t0 = performance.now();
      const raw = await post({ state, questions, model });
      const latencyMs = Math.round(performance.now() - t0);
      const parsed = ResponseSchema.safeParse(raw);
      if (!parsed.success) throw new DeciderError('decider_error', `decider reply failed validation: ${parsed.error.message}`);
      const { answers } = parsed.data;
      const missing = Object.keys(questions).filter((q) => !answers[q]);
      if (missing.length) throw new DeciderError('decider_error', `decider skipped questions: ${missing.join(', ')}`);

      const { type, id } = opts.subject ?? { type: 'adhoc', id: '' };
      db.transaction(() => {
        for (const q of Object.keys(questions)) {
          const a = answers[q]!;
          insert.run(type, id, q, answerText(a), a.confidence, model);
        }
      })();
      return { answers, latencyMs };
    },

    /** For `/api/provider`. When it reports `down`, callers go straight to Claude. */
    // Laya answers an unauthenticated /health with a bare {status:'ok'}; only an accepted key gets `loaded`.
    async status(): Promise<'ok' | 'down'> {
      try {
        const res = await fetch(`${base}/health`, { headers, signal: AbortSignal.timeout(timeoutMs) });
        const body = res.ok ? ((await res.json()) as { status?: unknown; loaded?: unknown }) : null;
        return body?.status === 'ok' && Array.isArray(body.loaded) ? 'ok' : 'down';
      } catch {
        return 'down';
      }
    },
  };
}
