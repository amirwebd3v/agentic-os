import { join } from 'node:path';
import type { Database } from '../../db/index.ts';
import { sha256 } from '../../vault/writer.ts';
import { readOrEmpty } from '../prompt.ts';

export const TOPICS = ['values', 'decision-rules', 'writing-style', 'work-style', 'career-goals', 'study', 'boundaries', 'routines'] as const;
export type Topic = (typeof TOPICS)[number];

/** Questions asked per calendar day, across all persona sessions. */
export const DAILY_CAP = 10;
export const BANK_PATH = 'persona/_questions.md';

export interface Question {
  id: string;
  topic: Topic;
  text: string;
  done: boolean;
}

// `- [ ] (topic) Question? ^id`; the `^id` is optional, a hand-added line without one gets an id from its text.
const LINE = /^- \[([ xX])\] \(([a-z-]+)\) (.+?)(?:\s+\^([A-Za-z0-9-]{1,64}))?\s*$/;
const isTopic = (t: string): t is Topic => (TOPICS as readonly string[]).includes(t);

function parseLine(line: string): Question | null {
  const m = LINE.exec(line);
  if (!m || !isTopic(m[2]!)) return null;
  return { id: m[4] ?? `q-${sha256(m[3]!).slice(0, 8)}`, topic: m[2], text: m[3]!, done: m[1] !== ' ' };
}

export const parseBank = (bank: string): Question[] => bank.split(/\r?\n/).flatMap((l) => parseLine(l) ?? []);

/** Unanswered questions in bank order, minus `skip`, limited to what is left of today's cap. */
export function nextQuestions(bank: string, { askedToday, cap, skip = [] }: { askedToday: number; cap: number; skip?: string[] }): Question[] {
  return parseBank(bank)
    .filter((q) => !q.done && !skip.includes(q.id))
    .slice(0, Math.max(0, cap - askedToday));
}

/** The bank with question `id` ticked, or null when it is missing or already ticked. Keeps line endings. */
export function tickQuestion(bank: string, id: string): string | null {
  const lines = bank.split('\n');
  const i = lines.findIndex((l) => {
    const q = parseLine(l.replace(/\r$/, ''));
    return q?.id === id && !q.done;
  });
  if (i < 0) return null;
  lines[i] = lines[i]!.replace('- [ ]', '- [x]');
  return lines.join('\n');
}

const INSTRUCTIONS = `This session is a persona interview. You ask the user questions from their own question bank so their assistant can learn their preferences in their own words. Their answers become statements they review later.

How to interview:
- Ask exactly one question per message, taken from "Next questions" below, in that order. Ask it as a complete, natural question, as written; translate it if the user writes in another language.
- Put the question's id in square brackets at the start of the line, e.g. "[values-1] What do you optimize for…?". Only bank questions get an id tag; never write a bracketed id for anything else.
- After an answer, you may ask one short follow-up (without an id tag) if the answer is vague or ambiguous. Never more than one per question. Then go on to the next question.
- Keep acknowledgements to a few words. Don't summarize, judge, advise, or suggest possible answers.
- Never invent or assume an answer. If the user skips a question or doesn't know, move on.
- Ask only about the user's own preferences. Don't ask about other people.
- When no questions are left, say so in one sentence and tell the user to end the session with the "End session" button; their answers then go to the Review page.
- If the user wants to talk about something else, answer briefly and offer to continue.`;

const startOfToday = (): string => {
  const d = new Date();
  d.setHours(0, 0, 0, 0); // the user's calendar day, not UTC's
  return d.toISOString();
};

/** Question ids asked in a session, oldest first. */
export const askedIn = (db: Database, sessionId: number): string[] =>
  db.prepare('SELECT question_id FROM persona_questions WHERE session_id = ? ORDER BY asked_at, rowid').pluck().all(sessionId) as string[];

/**
 * For a persona session: the interview instructions plus today's questions (the uncached prompt context), and
 * `record(reply)`, which stores the offered question ids the reply asked. Null for other sessions.
 */
export function personaTurn(db: Database, vaultDir: string, sessionId: number): { context: string; record: (reply: string) => void } | null {
  if (db.prepare('SELECT mode FROM sessions WHERE id = ?').pluck().get(sessionId) !== 'persona') return null;
  const bank = readOrEmpty(join(vaultDir, BANK_PATH));
  const askedToday = db.prepare('SELECT COUNT(*) FROM persona_questions WHERE asked_at >= ?').pluck().get(startOfToday()) as number;
  const here = askedIn(db, sessionId);
  // A question waiting in the review queue isn't asked again; a rejected one comes back.
  const pending = db
    .prepare(`SELECT json_extract(payload, '$.question_id') FROM approvals WHERE action_type = 'persona_statement' AND status = 'pending'`)
    .pluck()
    .all() as string[];
  const next = nextQuestions(bank, { askedToday, cap: DAILY_CAP, skip: [...here, ...pending] });
  const all = new Map(parseBank(bank).map((q) => [q.id, q]));

  const asked = here.map((id) => `- [${id}] ${all.get(id)?.text ?? '(no longer in the bank)'}`);
  const state = [
    asked.length ? `Asked in this session:\n${asked.join('\n')}` : 'Nothing asked in this session yet.',
    next.length
      ? `Next questions (${askedToday} of ${DAILY_CAP} asked today):\n${next.map((q) => `- [${q.id}] (${q.topic}) ${q.text}`).join('\n')}`
      : bank
        ? `Next questions: none. ${askedToday >= DAILY_CAP ? `Today's limit of ${DAILY_CAP} questions is reached.` : 'Every open question has been asked.'}`
        : 'Next questions: none. The question bank is missing; tell the user to run `pnpm vault:init`.',
  ];

  const offered = new Set(next.map((q) => q.id));
  const insert = db.prepare('INSERT OR IGNORE INTO persona_questions (session_id, question_id) VALUES (?, ?)');
  return {
    context: `${INSTRUCTIONS}\n\n${state.join('\n\n')}`,
    record(reply) {
      // Only offered ids count, so a reply can't push past the cap or tag a question the bank doesn't have.
      for (const [, id] of reply.matchAll(/\[([A-Za-z0-9-]{1,64})\]/g)) if (offered.has(id!)) insert.run(sessionId, id);
    },
  };
}
