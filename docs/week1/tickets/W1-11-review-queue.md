---
id: W1-11
title: "Review queue + edit distance"
epic: AOS-W1
issue: https://github.com/amirwebd3v/agentic-os/issues/11
points: 3
wave: 5
risk: Low
depends_on:
  - "[[W1-02-database]]"
  - "[[W1-04-server-security]]"
  - "[[W1-07-chat-ui]]"
skills:
  - vue-expert
  - typescript-pro
---

# W1-11 — Review queue (approve / edit / reject) with edit-distance capture

**Points:** 3 · **Risk:** Low · **Depends on:** W1-02, W1-04, W1-07 · **Skill/agent:** `vue-expert`, `typescript-pro`
Overview: [plan-review.md §8 risk 1 (queue fatigue)](../../plan-review.md) · Plan: [implementation-plan.md](../implementation-plan.md)

## Summary
One queue for everything the system proposes: categories, persona statements and vault conflicts. Edits are stored as ground truth (normalized edit distance). Batch actions and a daily cap keep the queue from growing faster than you can review it.

## Implementation steps
1. **API** (`server/src/http/routes/approvals.ts`):
   - `GET /api/approvals?status=pending`: oldest first, **capped at 15 per day**, with the rest hidden behind "show more".
   - `POST /api/approvals/:id/decide { decision: 'approve'|'reject', final_text? }`.
   - `POST /api/approvals/batch { ids[], decision }`.
2. **Handlers per `action_type`** (`server/src/approvals/apply.ts`):
   - `propose_category`: insert into `areas` as `active`, append the area to the `## Areas` list in `CLAUDE.md` through the writer, then re-run categorization for the inbox sessions that were waiting on it.
   - `persona_statement`: append to `persona/<topic>.md` (W1-12).
   - `vault_conflict`: approve = overwrite with the proposal (after a final hash check); reject = keep your version and update the recorded hash.
   - Every decision is audited (`approver='user'`).
3. **Edit distance:** `server/src/approvals/edit-distance.ts` computes normalized Levenshtein between `original_text` and `final_text` (0 = unchanged, 1 = rewritten). It's about 15 lines, no dependency.
4. **Expiry:** at boot and daily, pending proposals older than 14 days are set to `expired`, except `vault_conflict`, which never expires.
5. **UI:** `ReviewView.vue` shows cards by type, Approve / Edit / Reject buttons, checkboxes for batch actions, a count badge in the sidebar, and a diff view for vault conflicts (simple line diff).

## Files
| File | Action |
|---|---|
| `server/src/http/routes/approvals.ts`, `server/src/approvals/{apply,edit-distance,expire}.ts` | Create |
| `web/src/views/ReviewView.vue`, `web/src/components/ApprovalCard.vue` | Create |
| `server/test/approvals.test.ts` | Create |

## Tests — `server/test/approvals.test.ts`
```ts
import { test, expect } from 'vitest';
import { editDistance } from '../src/approvals/edit-distance';
import { setupApprovals } from './helpers';

test('normalized edit distance', () => {
  expect(editDistance('abc', 'abc')).toBe(0);
  expect(editDistance('abc', 'xyz')).toBe(1);
  expect(editDistance('kitten', 'sitting')).toBeCloseTo(3 / 7);
});
test('approving a category activates it and is audited', async () => {
  const t = await setupApprovals();
  const id = t.propose('propose_category', { name: 'Job search', description: 'd' });
  await t.decide(id, 'approve');
  expect(t.area('job-search')?.status).toBe('active');
  expect(t.auditActions()).toContain('approval.approve');
});
test('stale proposals expire, conflicts do not', async () => {
  const t = await setupApprovals({ now: '2026-11-20' });
  t.propose('persona_statement', {}, '2026-11-01');
  t.propose('vault_conflict', {}, '2026-11-01');
  t.expire();
  expect(t.statuses()).toEqual(['expired', 'pending']);
});
```

## Acceptance criteria
- [x] Approving a proposed top-level area activates it, updates `CLAUDE.md`, and re-files the waiting inbox sessions. (See docs/week1/acceptance.md.)
- [x] Editing before approving stores `edit_distance`. (See docs/week1/acceptance.md.)
- [x] No more than 15 items are shown per day. Batch reject works. (See docs/week1/acceptance.md.)
