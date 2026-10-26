import type Anthropic from '@anthropic-ai/sdk';
import type { Database } from '../db/index.ts';

export interface LlmCall {
  pipeline: string;
  model: string;
  latencyMs: number;
  usage?: Anthropic.Usage | null;
  error?: string | null;
  jobId?: number | null;
}

/** One `llm_calls` row per call, successful or not. */
export function recordCall(db: Database, call: LlmCall): void {
  db.prepare(
    `INSERT INTO llm_calls (pipeline, model, input_tokens, output_tokens, cache_read_tokens, latency_ms, error, job_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    call.pipeline,
    call.model,
    call.usage?.input_tokens ?? null,
    call.usage?.output_tokens ?? null,
    call.usage?.cache_read_input_tokens ?? null,
    Math.round(call.latencyMs),
    call.error ?? null,
    call.jobId ?? null,
  );
}
