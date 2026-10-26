---
id: W1-12
title: "Persona interview mode"
epic: AOS-W1
issue: https://github.com/amirwebd3v/agentic-os/issues/12
points: 2
wave: 6
risk: Low
depends_on:
  - "[[W1-06-chat-backend]]"
  - "[[W1-10-categorization]]"
  - "[[W1-11-review-queue]]"
skills:
  - prompt-engineer
---

# W1-12 — Persona interview mode

**Points:** 2 · **Risk:** Low · **Depends on:** W1-06, W1-10 (job runner), W1-11 · **Skill/agent:** `prompt-engineer`
Overview: [plan-review.md N7, §6 "Acting like me"](../../plan-review.md) · Plan: [implementation-plan.md](../implementation-plan.md)

## Summary
A chat session in `mode='persona'` interviews you, up to 10 questions a day, from a question bank you own. At the end of the session, Claude turns your answers into persona statements. Each one goes to the review queue, and when you approve it, it's appended to `vault/persona/<topic>.md`. Accepted persona files are then loaded into every chat prompt as a cached block (W1-05).

## Implementation steps
1. **Question bank** `vault/persona/_questions.md`, created by `vault:init`, about 60 questions. Each line looks like `- [ ] (values) What do you optimize for when two good options conflict?`. Topics: `values`, `decision-rules`, `writing-style` (EN and DE, email tone, sign-offs), `work-style`, `career-goals`, `study`, `boundaries` (what the OS must never do on your behalf), `routines`. **Ask about your preferences only, never about profiles of other people.**
2. **Persona mode prompt** (`server/src/chat/modes/persona.ts`): pick the next unanswered questions, at most 10 per calendar day. Ask one at a time, and allow at most 1 follow-up per question. Never invent answers. The question IDs asked are stored on the session.
3. **On end** (job `extract_persona`): Claude structured output →
   ```ts
   z.object({ statements: z.array(z.object({ question_id: z.string(), topic: z.enum([...topics]),
     statement: z.string(), in_my_words: z.string() })) })
   ```
   `statement` is the normalized rule ("Prefers short emails without pleasantries in German work contexts"). `in_my_words` is a verbatim quote of your answer. Each statement becomes an `approvals` row (`persona_statement`, `original_text = statement`).
4. **On approve:** append `- <final statement>  ^<question_id>` to `persona/<topic>.md` with frontmatter `sensitivity: 1`, and tick the question in `_questions.md`. Both writes go through the writer.
5. **Prompt inclusion:** `prompt.ts` loads all `persona/*.md` except `_questions.md`, in sorted order (stable, so the cache can hit).

## Files
| File | Action |
|---|---|
| `server/src/chat/modes/persona.ts`, `server/src/jobs/extract-persona.ts`, `server/templates/persona-questions.md` | Create |
| `server/test/persona.test.ts` | Create |

## Tests
```ts
import { test, expect } from 'vitest';
import { nextQuestions } from '../src/chat/modes/persona';

const bank = `- [x] (values) Q1\n- [ ] (values) Q2\n- [ ] (study) Q3`;
test('skips answered questions and respects the daily cap', () => {
  expect(nextQuestions(bank, { askedToday: 0, cap: 10 }).map(q => q.text)).toEqual(['Q2', 'Q3']);
  expect(nextQuestions(bank, { askedToday: 10, cap: 10 })).toEqual([]);
});
```

## Acceptance criteria
- [x] A persona session asks one question at a time and stops at 10 for the day.
- [x] Ending it creates proposals. Approving one writes `persona/<topic>.md`, ticks the question, and creates a git commit.
- [x] The next normal chat's system prompt includes the accepted statement, and `cache_read_tokens > 0` on the second message (with a key).
