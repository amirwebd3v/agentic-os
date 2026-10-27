---
title: Ponytail debt ledger
---

# Ponytail debt ledger

Deliberate shortcuts (`ponytail:` comments in the code), collected at the end of Week 1 (2026-10-26, W1-13). Each one is fine at today's scale. The "Upgrade when" column is the trigger to revisit it. Re-run the collection after every wave: `git grep -n "ponytail:" -- server/src web/src scripts`.

| Where | Shortcut | Ceiling | Upgrade when |
|---|---|---|---|
| `server/src/approvals/apply.ts:136` | A failed COMMIT after the rename leaves the file written but the row pending | The retry sees the new hash and asks again | It happens in practice (needs a disk or DB failure mid-commit) |
| `server/src/cli/provider-smoke.ts:89` | Batch is only *detected* (GET), never created | No proof batching actually works | A nightly batch job exists (Month 1+; 9router has no batch anyway) |
| `server/src/cli/provider-smoke.ts:146` | Smoke results are only printed, never stored | A feature can't read provider capability flags | A feature needs them (for example batch or caching on/off) |
| `server/src/db/audit.ts:27` | Redaction is by key name only | A secret inside free text would be logged | A secret ever shows up in `args_redacted`; then add value scanning |
| `server/src/db/jobs.ts:41` | No lock token; one worker loop assumed | Parallel workers could double-complete | Jobs run in parallel (see `runner.ts`) |
| `server/src/jobs/runner.ts:25` | One sequential worker | A slow job (e.g. a long Claude call) delays the others | Gmail sync arrives (Month 1) and starves filing; then one worker per kind + a claim token |
| `server/src/http/auth.ts:46` | No logout or session revocation | A stolen cookie stays valid until it expires (30 days) | The UI needs logout, or a device is lost |
| `server/src/http/routes/approvals.ts:74` | "Show more" capped at 200 | Older pending items are hidden | The queue ever exceeds 200 (it shouldn't, with expiry) |
| `server/src/http/routes/approvals.ts:86` | Two vault git commit chains (writer + approvals) can collide | One commit fails and is picked up by the next `add -A` | Missing vault commits are noticed |
| `server/src/vault/writer.ts:147` | Obsidian save vs. app rename race (microseconds) | One edit could be lost | Ever observed; then re-check under a lock |
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

## W2-00 cleanup (2026-10-27)
The chat channel, session categorization and persona interviews were removed (see [[week2/implementation-plan]], "Cleanup decision"). Left behind on purpose:
- **Tables** `sessions`, `messages` and `persona_questions` stay in the schema: migrations are forward-only. Migration `0005_retire_week1_chat.sql` expires pending `propose_category` / `persona_statement` approvals and fails queued `categorize_session` / `extract_persona` jobs, so nothing is left that the app can no longer apply.
- **No caller yet:** `createWriter()` (`vault/writer.ts`, tested), `GET /api/areas`, and the `systemBlocks()` persona block in `llm/client.ts`. The career and email slices decide whether they use them. Delete any that is still unused after the Email slice.
- **Review-queue editing** (`final_text`, `edit_distance`) still works on the server, but no UI sends it: the application page (W2-08) has its own edit flow.
- **The decider** (`server/src/decider`, `sidecar/`, `scripts/sidecar.ts`, `scripts/decider-bench.ts`) is parked: `pnpm dev` doesn't start it. Its `status()` and `model`/`maxLen` options were already flagged as "delete if unused"; decide at the Email slice.

### If you already use a Week 1 vault (a manual step for the owner)
`pnpm vault:init` never touches existing files, so an existing vault keeps its old text:
- Run `pnpm vault:init` once: it creates the new `career/` folder.
- In the vault's `CLAUDE.md`, under "Filing rules", the lines about subareas proposed by the app and "every session has one primary area" no longer describe the app. Replace them with the two lines in `server/templates/CLAUDE.md`. In "Folders", replace the `persona/` line with the `career/` one.
- The `persona/` folder and its notes can stay (they are yours) or be deleted. Nothing reads them now.
