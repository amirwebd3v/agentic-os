---
title: Ponytail debt ledger
---

# Ponytail debt ledger

Deliberate shortcuts (`ponytail:` comments in the code), collected at the end of Week 1 (2026-10-26, W1-13). Each one is fine at today's scale. The "Upgrade when" column is the trigger to revisit it. Re-run the collection after every wave: `git grep -n "ponytail:" -- server/src web/src scripts`.

| Where | Shortcut | Ceiling | Upgrade when |
|---|---|---|---|
| `server/src/approvals/apply.ts:235` | The persona approve does two renames (topic file + `_questions.md`) that aren't atomic together | If the 2nd rename fails, the statement is saved but the question stays unticked | A tick ever goes missing; then journal both renames |
| `server/src/approvals/apply.ts:261` | A failed COMMIT after the rename leaves the file written but the row pending | The retry sees the new hash and asks again | It happens in practice (needs a disk or DB failure mid-commit) |
| `server/src/chat/prompt.ts:8` | Chars as a token proxy for history (~100k tokens) | Very long chats could hit the context limit | Long chats get cut or rejected; then use token counting |
| `server/src/jobs/categorize-session.ts:52` | Chars as a token proxy for the categorization input (~25k tokens) | Very long sessions are truncated for filing | Filing quality drops on long sessions |
| `server/src/cli/provider-smoke.ts:90` | Batch is only *detected* (GET), never created | No proof batching actually works | A nightly batch job exists (Month 1+; 9router has no batch anyway) |
| `server/src/db/audit.ts:27` | Redaction is by key name only | A secret inside free text would be logged | A secret ever shows up in `args_redacted`; then add value scanning |
| `server/src/db/jobs.ts:41` | No lock token; one worker loop assumed | Parallel workers could double-complete | Jobs run in parallel (see `runner.ts`) |
| `server/src/jobs/runner.ts:25` | One sequential worker | A slow job (e.g. a long Claude call) delays the others | Gmail sync arrives (Month 1) and starves filing; then one worker per kind + a claim token |
| `server/src/http/auth.ts:46` | No logout or session revocation | A stolen cookie stays valid until it expires (30 days) | The UI needs logout, or a device is lost |
| `server/src/http/routes/approvals.ts:74` | "Show more" capped at 200 | Older pending items are hidden | The queue ever exceeds 200 (it shouldn't, with expiry) |
| `server/src/http/routes/approvals.ts:86` | Two vault git commit chains (writer + approvals) can collide | One commit fails and is picked up by the next `add -A` | Missing vault commits are noticed |
| `server/src/http/routes/sessions.ts:43` | No pagination; the session list is capped at 500 | The oldest sessions disappear from the sidebar | You pass ~500 sessions; then add a cursor |
| `server/src/vault/writer.ts:147` | Obsidian save vs. app rename race (microseconds) | One edit could be lost | Ever observed; then re-check under a lock |
| `web/src/components/MessageBubble.vue:7` | Re-renders the whole reply per streamed delta (O(n²)) | Long replies could stutter | Visible lag on long replies |
| `web/src/diff.ts:3` | LCS line diff with O(n·m) memory | Huge notes would be slow to diff | A conflict on a very large note |

## Watch list (not code comments)
- **The Laya decider runs fp16 autocast on Turing** (Laya forces it; there's no switch). Re-check accuracy in the Month 1 Laya-vs-Kev benchmark.
- **`pnpm dev` has no `-k`** on purpose: a sidecar crash must not stop the server. An orphaned sidecar is reaped on the next `pnpm sidecar` (`scripts/sidecar.ts`).
- **The `index.html` fallback in `server/src/app.ts`** is unused while the router is hash-mode; it's kept as a 4-line guard.

## W1-13 over-engineering audit (2026-10-26)
A repo-wide audit found 14 candidates (about −75 lines, −2 deps).

**Applied:**
- Removed the unread `provider-capabilities.json` write from `pnpm smoke`.
- Shared the job `Payload` schema and the `sessionMessages()` query between the filing and persona jobs.
- Dropped `export` from 6 server symbols that nothing imports.

**Kept, and why:**
| Finding | Kept because |
|---|---|
| Replace `chokidar` with `fs.watch` (recursive) | `fs.watch` sends duplicate and rename events on Windows, and `awaitWriteFinish` matters for Obsidian's partial saves. This is data-safety code, and the dependency earns its place. |
| Replace `concurrently` with `pnpm --parallel` | It was tested live (no `-k`, so a sidecar crash doesn't stop the server). The prefixes are useful, and process handling on Windows is the risky part. |
| Move `stage()` into `writer.ts` and share it | This is the atomic-write path of two data-safety features. Merge it when the writer is next touched for another reason. |
| One `sha256` / `isInside` / `oneLine` / `startOfToday` | The `isInside` copies differ on purpose (inclusive vs. exclusive root), and `apply.ts`'s `oneLine` also strips `<>` (CLAUDE.md injection). A cross-module helper file for 1-liners isn't worth the coupling yet. |
| Decider `status()` + the `model`/`maxLen` options | Next step: show decider status in `/api/provider` and the UI. Delete them if Month 1 doesn't use them. |
| The `deep` tier | Month 1 consolidation and synthesis are planned on it (plan §4b). |
| `index.html` fallback vs. hash router | A 4-line guard, kept deliberately (see the watch list). |
| The `makeTestDb()` wrapper | A one-line test helper. Inlining it in 6 files only adds churn. |
| 8 more dead `export` keywords (web types, `session-note.ts`) | Harmless. Clean them up opportunistically. |
