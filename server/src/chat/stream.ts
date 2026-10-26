import type Anthropic from '@anthropic-ai/sdk';
import type { Config } from '../config.ts';
import type { Database } from '../db/index.ts';
import { getLlm, stream } from '../llm/client.ts';
import type { LlmConfig } from '../llm/client.ts';
import { mapError } from '../llm/errors.ts';
import type { LlmErrorKind } from '../llm/errors.ts';
import { history, systemPrompt } from './prompt.ts';

/** The slice of the LLM client chat uses; tests swap in `fakeLlm`. */
export interface ChatLlm {
  stream: typeof stream;
  configured: (config: LlmConfig) => boolean;
}

export const realLlm: ChatLlm = { stream, configured: (config) => getLlm(config) !== null };

export type ChatEvent =
  | { user_message_id: number; assistant_message_id: number }
  | { delta: string }
  | { done: true; usage: { input_tokens: number; output_tokens: number; cache_read_tokens: number } }
  | { error: { kind: Exclude<LlmErrorKind, 'aborted'> } };

const FLUSH_MS = 1000;

/** Boot step: replies cut off by a crash or kill keep their partial content as `aborted`. */
export function recoverInterrupted(db: Database): number {
  return db.prepare(`UPDATE messages SET status = 'aborted' WHERE status = 'streaming'`).run().changes;
}

/** Stores the user turn and an empty `streaming` assistant reply. */
export function startTurn(db: Database, sessionId: number, content: string, model: string) {
  return db.transaction(() => {
    const insert = db.prepare('INSERT INTO messages (session_id, role, content, model, status) VALUES (?, ?, ?, ?, ?) RETURNING id');
    const user = insert.get(sessionId, 'user', content, null, 'done') as { id: number };
    const assistant = insert.get(sessionId, 'assistant', '', model, 'streaming') as { id: number };
    return { user_message_id: user.id, assistant_message_id: assistant.id };
  })();
}

interface ReplyDeps {
  db: Database;
  config: Config;
  llm: ChatLlm;
  sessionId: number;
  assistantId: number;
  signal: AbortSignal;
  send: (ev: ChatEvent) => void;
}

/** Streams the reply to `send`, flushing partial text to the DB every second. Never throws for model errors. */
export async function streamReply({ db, config, llm, sessionId, assistantId, signal, send }: ReplyDeps): Promise<void> {
  const update = db.prepare('UPDATE messages SET content = ?, status = ? WHERE id = ?');
  let text = '';
  let saved = '';
  const save = (status: 'streaming' | 'done' | 'aborted' | 'error') => {
    update.run(text, status, assistantId);
    saved = text;
  };
  const timer = setInterval(() => text !== saved && save('streaming'), FLUSH_MS);
  try {
    const events = llm.stream(
      { db, config },
      { pipeline: 'chat', tier: 'work', system: systemPrompt(config.vaultDir), messages: history(db, sessionId), signal },
    );
    let usage: Anthropic.Usage | undefined;
    for await (const ev of events) {
      if (ev.type === 'text') {
        text += ev.text;
        send({ delta: ev.text });
      } else usage = ev.usage;
    }
    if (!usage) throw new Error('stream ended without a final message');
    save('done');
    send({
      done: true,
      usage: { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, cache_read_tokens: usage.cache_read_input_tokens ?? 0 },
    });
  } catch (err) {
    const { kind } = mapError(err);
    if (kind === 'aborted' || signal.aborted) return save('aborted');
    save('error');
    send({ error: { kind } });
  } finally {
    clearInterval(timer);
  }
}
