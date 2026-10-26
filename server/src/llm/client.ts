import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';
import type { Config } from '../config.ts';
import type { Database } from '../db/index.ts';
import { getSecret } from '../secrets.ts';
import { LlmError, mapError } from './errors.ts';
import { recordCall } from './ledger.ts';

export type Tier = keyof Config['llm']['models'];
export type LlmConfig = Pick<Config, 'llm'>;

export interface LlmDeps {
  db: Database;
  config: LlmConfig;
}

/** Ordered stable → volatile so the cached prefix survives: rules and persona carry cache_control, context does not. */
export interface SystemPrompt {
  rules?: string;
  persona?: string;
  context?: string;
}

interface CallBase {
  pipeline: string;
  tier: Tier;
  system?: SystemPrompt;
  jobId?: number;
  signal?: AbortSignal;
}

export type StreamEvent = { type: 'text'; text: string } | { type: 'done'; usage: Anthropic.Usage };

// The SDK's own retry (exponential backoff, honours retry-after) covers 408/409/429/5xx and connection errors,
// i.e. rate_limit, overloaded and network. 4xx and auth are never retried.
const MAX_RETRIES = 3;
const MAX_TOKENS = 16000;

let cached: { key: string; baseURL: string; client: Anthropic } | null = null;
let authFailed = false;

/** The SDK client, or null when no `anthropic` secret is set. Rebuilt when the key or base URL changes. */
export function getLlm(config: LlmConfig): Anthropic | null {
  const key = getSecret('anthropic');
  if (!key) return (cached = null);
  const { baseURL } = config.llm;
  if (cached?.key !== key || cached.baseURL !== baseURL) {
    // Everything explicit: the SDK must never fall back to ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN from process.env.
    cached = { key, baseURL, client: new Anthropic({ apiKey: key, authToken: null, baseURL, maxRetries: MAX_RETRIES }) };
    authFailed = false;
  }
  return cached.client;
}

/** Drops the cached client so the next call re-reads the secret. Backs `POST /api/provider/reload`. */
export function reloadLlm(): void {
  cached = null;
  authFailed = false;
}

export function providerStatus(config: LlmConfig) {
  const status = !getLlm(config) ? 'not_configured' : authFailed ? 'error' : 'ok';
  return { status, baseURL: config.llm.baseURL, models: config.llm.models } as const;
}

export function systemBlocks(system: SystemPrompt = {}): Anthropic.TextBlockParam[] {
  const cache = { cache_control: { type: 'ephemeral' } } as const;
  return [
    ...(system.rules ? [{ type: 'text' as const, text: system.rules, ...cache }] : []),
    ...(system.persona ? [{ type: 'text' as const, text: system.persona, ...cache }] : []),
    ...(system.context ? [{ type: 'text' as const, text: system.context }] : []),
  ];
}

function requireLlm(config: LlmConfig): Anthropic {
  const client = getLlm(config);
  if (!client) throw new LlmError('auth', 'LLM provider not configured: set ANTHROPIC_API_KEY in .env or run `pnpm secrets set anthropic`');
  return client;
}

function fail(deps: LlmDeps, req: CallBase, model: string, started: number, err: unknown): LlmError {
  const e = mapError(err);
  if (e.kind === 'auth') authFailed = true;
  recordCall(deps.db, { pipeline: req.pipeline, model, latencyMs: Date.now() - started, error: `${e.kind}: ${e.message}`.slice(0, 500), jobId: req.jobId ?? null });
  return e;
}

/** Streams text deltas, then one `done` event with the final usage. Every call lands in `llm_calls`. */
export async function* stream(deps: LlmDeps, req: CallBase & { messages: Anthropic.MessageParam[] }): AsyncGenerator<StreamEvent> {
  const model = deps.config.llm.models[req.tier];
  const started = Date.now();
  let settled = false;
  let s: ReturnType<Anthropic['messages']['stream']> | undefined;
  try {
    s = requireLlm(deps.config).messages.stream(
      { model, max_tokens: MAX_TOKENS, system: systemBlocks(req.system), messages: req.messages },
      { signal: req.signal },
    );
    for await (const ev of s) {
      if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') yield { type: 'text', text: ev.delta.text };
    }
    const { usage } = await s.finalMessage();
    authFailed = false;
    recordCall(deps.db, { pipeline: req.pipeline, model, latencyMs: Date.now() - started, usage, jobId: req.jobId ?? null });
    settled = true;
    yield { type: 'done', usage };
  } catch (err) {
    settled = true;
    throw fail(deps, req, model, started, err);
  } finally {
    // The consumer stopped iterating early: stop the request and still record the call.
    if (!settled) {
      s?.abort();
      fail(deps, req, model, started, new LlmError('aborted', 'consumer stopped reading'));
    }
  }
}

/** One user turn in, a Zod-validated object out (`output_config.format` via `messages.parse`). */
export async function structured<T>(deps: LlmDeps, req: CallBase & { input: string; schema: z.ZodType<T> }): Promise<T> {
  const model = deps.config.llm.models[req.tier];
  const started = Date.now();
  try {
    const res = await requireLlm(deps.config).messages.parse(
      {
        model,
        max_tokens: MAX_TOKENS,
        system: systemBlocks(req.system),
        messages: [{ role: 'user', content: req.input }],
        output_config: { format: zodOutputFormat(req.schema) },
      },
      { signal: req.signal },
    );
    if (res.parsed_output == null) throw new LlmError('bad_request', `no structured output (stop_reason: ${res.stop_reason})`);
    authFailed = false;
    recordCall(deps.db, { pipeline: req.pipeline, model, latencyMs: Date.now() - started, usage: res.usage, jobId: req.jobId ?? null });
    return res.parsed_output as T;
  } catch (err) {
    throw fail(deps, req, model, started, err);
  }
}
