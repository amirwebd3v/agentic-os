import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import type { Database } from '../db/index.ts';
import type { SystemPrompt } from '../llm/client.ts';

const HISTORY_MESSAGES = 40;
// ponytail: chars as a token proxy (~4 chars/token → ~100k tokens), count real tokens if long chats hit the context limit
const HISTORY_CHARS = 400_000;

const missing = (err: unknown): boolean => ['ENOENT', 'ENOTDIR'].includes((err as NodeJS.ErrnoException).code ?? '');

function readOrEmpty(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if (missing(err)) return '';
    throw err;
  }
}

function personaFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.md') && f !== '_questions.md').sort();
  } catch (err) {
    if (missing(err)) return [];
    throw err;
  }
}

/** Vault rules (`CLAUDE.md`) and accepted persona files. A missing vault gives an empty prompt. */
export function systemPrompt(vaultDir: string): SystemPrompt {
  const dir = join(vaultDir, 'persona');
  const persona = personaFiles(dir)
    .map((f) => readOrEmpty(join(dir, f)).trim())
    .filter(Boolean)
    .join('\n\n');
  return { rules: readOrEmpty(join(vaultDir, 'CLAUDE.md')).trim(), persona };
}

/** The last finished turns, oldest first, within the budget. Starts with a user turn; empty replies are skipped. */
export function history(db: Database, sessionId: number): Anthropic.MessageParam[] {
  const rows = db
    .prepare(
      `SELECT role, content FROM messages WHERE session_id = ? AND role IN ('user', 'assistant')
         AND status != 'streaming' AND content != '' ORDER BY id DESC LIMIT ?`,
    )
    .all(sessionId, HISTORY_MESSAGES) as { role: 'user' | 'assistant'; content: string }[];
  const kept: Anthropic.MessageParam[] = [];
  let chars = 0;
  for (const r of rows) {
    chars += r.content.length;
    if (chars > HISTORY_CHARS && kept.length) break;
    kept.unshift(r);
  }
  while (kept[0]?.role === 'assistant') kept.shift();
  return kept;
}
