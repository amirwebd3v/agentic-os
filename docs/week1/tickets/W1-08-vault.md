---
id: W1-08
title: "Vault conventions, CLAUDE.md, writer, watcher"
epic: AOS-W1
issue: https://github.com/amirwebd3v/agentic-os/issues/8
points: 3
wave: 3
risk: Medium
depends_on:
  - "[[W1-01-scaffold]]"
  - "[[W1-02-database]]"
skills:
  - typescript-pro
---

# W1-08 — Vault: Obsidian conventions, `CLAUDE.md`, safe writer, watcher

**Points:** 3 · **Risk:** Medium (data integrity) · **Depends on:** W1-01, W1-02 · **Skill/agent:** `typescript-pro`
Overview: [plan-review.md §0d, M4, M5](../../plan-review.md) · Plan: [implementation-plan.md](../implementation-plan.md)

## Summary
Create the separate `vault` git repo as a normal Obsidian vault and write `CLAUDE.md`, which holds the taxonomy, tiers, never-rules and filing rules. Build a writer that never overwrites your edits and commits its own changes, plus a watcher that records edits you make in Obsidian.

## Implementation steps
1. **`pnpm vault:init`** (`server/src/cli/vault-init.ts`), idempotent:
   - `git init -b main` in `vaultDir`, with **no remote** added.
   - Folders: `persona/ wiki/ journal/ inbox/ outputs/ exports/ attachments/ .obsidian/`.
   - `.gitignore`: `attachments/`, `.obsidian/workspace*.json`, `.obsidian/cache`, `.trash/`.
   - `.obsidian/app.json`: `{ "attachmentFolderPath": "attachments", "newLinkFormat": "shortest", "useMarkdownLinks": false }`.
   - The `CLAUDE.md` template (below) and the persona question bank (W1-12).
2. **`CLAUDE.md` template.** You'll edit it. Sections:
   - **Areas (top level, fixed):** `software-development`, `studies` (MSc cybersecurity, mode `tutor`), `career`, `admin-finance`, `health`, `home-household`, `relationships-social`, `learning-reading`, `projects-side`, `personal-reflection`. Each has a one-line description, which the decider uses as `criteria` text.
   - **Sensitivity tiers** T0–T3 with examples. **Never ingest (T3):** passwords, 2FA seeds and codes, card or bank numbers, ID scans, tax IDs.
   - **Filing rules:** top-level areas need your approval. Subareas are proposed and become active after 3 items or your approval. Sessions have one primary area plus tags.
   - **Behaviour rules:** never send anything. Never profile third parties. In study areas, explain and ask before solving.
   - **Area modes:** `do | explain | tutor`.
3. **Area sync:** at boot, parse the `## Areas` list from `CLAUDE.md` and upsert it into `areas`. Areas removed from the file are archived, never deleted.
4. **`server/src/vault/frontmatter.ts`:** a Zod schema `{ id, area, tags[], sensitivity: 0|1|2, source, created, updated }`, read and written via `gray-matter`.
5. **`server/src/vault/writer.ts`:** `writeNote(relPath, body, fm)`:
   1. If the file exists and `sha256(current) !== vault_notes.content_hash`, it was edited outside the app. **Don't write.** Create an `approvals` row (`action_type='vault_conflict'`, payload = proposed content) and return `'conflict'`.
   2. Otherwise write to `<file>.tmp`, then `rename`, and upsert `vault_notes(hash, last_written_by='app')`.
   3. Batch commits: `git add -A && git commit -m "aos: <summary>"` via `execFile('git', …)`, debounced 30 s.
   Paths are always resolved and checked to stay inside `vaultDir`, so `..` traversal is impossible.
6. **`server/src/vault/watch.ts`:** `chokidar.watch('**/*.md', { cwd: vaultDir, ignored: ['.git/**', '.obsidian/**', 'attachments/**'], awaitWriteFinish: true })`. On change, if the hash differs from the recorded one, set `last_written_by='user'`, update the hash and audit `vault.user_edit`. Month 1 adds re-indexing here.

## Files
| File | Action |
|---|---|
| `server/src/cli/vault-init.ts`, `server/src/vault/{frontmatter,writer,watch,areas}.ts`, `server/templates/CLAUDE.md` | Create |
| `server/test/vault.test.ts` | Create (uses a temp dir) |

## Tests — `server/test/vault.test.ts`
```ts
import { test, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { makeTestDb } from './helpers';
import { createWriter } from '../src/vault/writer';

let dir: string, db: any, w: ReturnType<typeof createWriter>;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'vault-')); db = makeTestDb(); w = createWriter({ db, vaultDir: dir, commit: false }); });

test('never overwrites a user-edited note', () => {
  expect(w.writeNote('wiki/a.md', 'v1', { area: 'career' })).toBe('written');
  writeFileSync(join(dir, 'wiki/a.md'), 'edited in obsidian');
  expect(w.writeNote('wiki/a.md', 'v2', { area: 'career' })).toBe('conflict');
  expect(readFileSync(join(dir, 'wiki/a.md'), 'utf8')).toBe('edited in obsidian');
  expect(db.prepare("SELECT count(*) n FROM approvals WHERE action_type='vault_conflict'").get().n).toBe(1);
});
test('rejects path traversal', () => {
  expect(() => w.writeNote('../outside.md', 'x', { area: 'career' })).toThrow();
});
```

## Acceptance criteria
- [ ] `pnpm vault:init` creates a vault that opens cleanly in Obsidian.
- [ ] Editing a note in Obsidian is recorded (audit row) within 5 s, and the app then refuses to overwrite it (a conflict appears in Review).
- [x] `git -C <vault> remote -v` is empty, and `git -C <vault> log` shows app commits.
