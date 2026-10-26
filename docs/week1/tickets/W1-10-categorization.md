---
id: W1-10
title: "Session categorization + summary note"
epic: AOS-W1
issue: https://github.com/amirwebd3v/agentic-os/issues/10
points: 5
wave: 5
risk: High
depends_on:
  - "[[W1-05-llm-client]]"
  - "[[W1-06-chat-backend]]"
  - "[[W1-08-vault]]"
  - "[[W1-09-sidecar-decider]]"
skills:
  - prompt-engineer
  - typescript-pro
---

# W1-10 — Session categorization + summary note (decider → Claude cascade)

**Points:** 5 · **Risk:** High (core value, accuracy target) · **Depends on:** W1-05, W1-06, W1-08, W1-09 · **Skill/agent:** `prompt-engineer`, `typescript-pro`
Overview: [plan-review.md §0a, M12, §1 taxonomy](../../plan-review.md) · Plan: [implementation-plan.md](../implementation-plan.md)

## Summary
When a session ends or goes idle, a job runs:

1. The decider picks the area instantly.
2. Claude (structured output) confirms or corrects the area, may propose a new sub-area or top-level area, and writes the summary.
3. A Markdown summary note goes into `vault/wiki/<area>/sessions/`.

Because nothing is calibrated yet, **every model filing is `flagged`** (M12). The Month 1 golden set will unlock `auto`.

## Implementation steps
1. **Job handler** `server/src/jobs/categorize-session.ts` (kind `categorize_session`, payload `{ sessionId, upToMessageId }`), run by a simple loop in `server/src/jobs/runner.ts` that claims a job every 2 s.
2. **Input prep:** session transcript up to `upToMessageId`. For the decider, pass the title + first user message + last 6 turns, truncated to about 1,000 tokens (Laya's default context).
3. **Stage 1, decider:**
   ```ts
   questions: { area: { type: 'choice', instructions: 'Which life area is this conversation mainly about?',
                        criteria: { ...activeTopLevelAreas /* slug → description */ } } }
   ```
   **No `none` / catch-all option** (verified live 2026-10-26: with one, Laya picked `none` at ~0.45 for clear EN/DE cases; without it, EN/DE/FA were all correct). "Doesn't fit" is expressed by low confidence, and Claude decides about new areas.
   Record the result in `decisions`. If the decider is down, skip to stage 2 with no hint.
4. **Stage 2, Claude** (`tier: 'work'`, structured output). The system prompt contains the taxonomy and filing rules from `CLAUDE.md` and the decider's hint with its confidence. Schema:
   ```ts
   const SessionFiling = z.object({
     area_slug: z.string().nullable(),               // existing active area or null
     subarea: z.object({ slug: z.string(), name: z.string(), existing: z.boolean() }).nullable(),
     propose_top_level: z.object({ name: z.string(), description: z.string(), reason: z.string() }).nullable(),
     tags: z.array(z.string()),
     title: z.string(),
     summary: z.string(),                            // 3-6 sentences
     decisions: z.array(z.string()), todos: z.array(z.object({ text: z.string(), due: z.string().nullable() })),
     facts_about_me: z.array(z.string()), preferences: z.array(z.string()),
     open_questions: z.array(z.string()), lessons: z.array(z.string()),
   });
   ```
   When the decider's confidence is under `escalateBelow` (0.6), the prompt explicitly asks Claude whether a new area is needed.
5. **Apply the result:**
   - Set `sessions.area_id`, `area_confidence` (the decider confidence when Claude agrees, else null), `filing_status='flagged'`, and `title` if it's still the default.
   - **New top level:** an `approvals` row (`propose_category`). The session waits in `inbox` until you decide.
   - **New sub-area:** an `areas` row with `status='proposed'`. It auto-activates when 3 sessions use it, or when you approve it.
   - `area_slug=null` with no proposal → `filing_status='inbox'`.
   - **Never** overwrite `filing_status='user'`.
6. **Summary note:** `writeNote('wiki/<area>/sessions/<yyyy-mm-dd>-<slug>.md', …)` with frontmatter (`id`, `area`, `tags`, `sensitivity: 1`, `source: session:<id>`), sections for Summary, Decisions, To-dos, Facts about me, Preferences, Open questions, Lessons, and a `[[wikilink]]` to the area index note `wiki/<area>/_index.md` (created if missing). Re-categorizing the same session updates the same note, still under the conflict guard.
7. **Eval script** `pnpm eval:categorize` runs on 10 fixture chats in `server/test/fixtures/sessions/*.json`, each `{ messages, expected_area }`. Write them in EN/DE, plus one Persian and one that should trigger a "new area" proposal. It calls the real decider and Claude and prints a confusion table. It also writes `eval_runs`, so add `eval_cases` and `eval_runs` to migration `0003` (`0002` is W1-04's login tokens).

## Files
| File | Action |
|---|---|
| `server/src/jobs/{runner,categorize-session}.ts`, `server/src/chat/filing-schema.ts`, `server/src/vault/session-note.ts` | Create |
| `server/migrations/0003_evals.sql`, `server/test/fixtures/sessions/*.json` (10), `scripts/eval-categorize.ts` | Create |
| `server/test/categorize.test.ts` | Create (fake decider + fake LLM) |

## Tests — `server/test/categorize.test.ts`
```ts
import { test, expect } from 'vitest';
import { setupCategorize } from './helpers'; // test db + temp vault + fakes

test('files session as flagged and writes summary note', async () => {
  const t = await setupCategorize({ decider: { area: { choice: 'software-development', confidence: 0.9 } },
    llm: { area_slug: 'software-development', subarea: null, propose_top_level: null, title: 'Vue bug',
           summary: 's', tags: [], decisions: ['use pinia'], todos: [], facts_about_me: [], preferences: [], open_questions: [], lessons: [] } });
  await t.run();
  expect(t.session().filing_status).toBe('flagged');
  expect(t.noteText()).toContain('use pinia');
});
test('new top-level area becomes an approval, never auto-created', async () => {
  const t = await setupCategorize({ decider: { area: { choice: 'career', confidence: 0.3 } },
    llm: { area_slug: null, subarea: null, propose_top_level: { name: 'Job search', description: 'd', reason: 'r' }, title: 't',
           summary: 's', tags: [], decisions: [], todos: [], facts_about_me: [], preferences: [], open_questions: [], lessons: [] } });
  await t.run();
  expect(t.approvals('propose_category')).toHaveLength(1);
  expect(t.areaExists('job-search')).toBe(false);
  expect(t.session().filing_status).toBe('inbox');
});
test('user filing is never overwritten', async () => {
  const t = await setupCategorize({ userFiled: 'career' });
  await t.run();
  expect(t.session().filing_status).toBe('user');
});
test('decider down → still files via Claude', async () => {
  const t = await setupCategorize({ deciderDown: true });
  await t.run();
  expect(t.session().area_id).not.toBeNull();
});
```

## Acceptance criteria
- [x] `pnpm eval:categorize` (with a key): **at least 9 of 10** sessions get the expected area. The "new area" case produces a proposal, not a new area.
- [x] Re-running the job for the same `(session, lastMsg)` is a no-op (idempotent).
- [ ] The summary note opens in Obsidian with valid frontmatter and a working wikilink.
