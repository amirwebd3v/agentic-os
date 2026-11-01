# Agentic OS: rules for every Claude session in this repo

Every session reads this file automatically, including parallel sessions in `.claude/worktrees/`. Keep it short. A rule earns its place by preventing a real mistake.

## Where things are
- **Docs are local only.** `docs/` is gitignored and was removed from history (2026-10-29). It exists only in the main checkout, `E:\Projects\Agentic OS\docs\`: a worktree session reads it by that absolute path; a cloud session has no docs and asks the owner. Never commit a file under `docs/`.
- **Original review (threat model, architecture):** `docs/plan-review.md`
- **Career (current):** spec `docs/week2/career-v2.md` (wins over `career-contract.md` where they differ); status and open work in `docs/week2/implementation-plan.md` §0; shapes `docs/week2/career-contract.md`. **UI:** `web/DESIGN.md`, `web/PRODUCT.md`.
- **Build loop:** `docs/Workflow.md` (fullstack-dev-skills + ponytail + claude-mem)
- **Backlog:** GitHub Project https://github.com/users/amirwebd3v/projects/1. Status lives only there.

## Skills by task
Every session sees all installed skills with their descriptions; pick by the task, combine as many as apply, skip the rest. The ones this repo relies on:
- **Always:** `ponytail` (on by default). Before a ticket: `claude-mem:mem-search` on its topic; `claude-mem:smart-explore` before reading a long file.
- **Build:** `typescript-pro`, `vue-expert`, `sql-pro` (migrations, queries), `api-designer` (new routes), `claude-api` + `prompt-engineer` (any LLM prompt or model call), `anthropic-skills:docx` (Word templates and output), `dataviz` (any chart).
- **UI:** `impeccable` (shape → critique → polish → harden → audit) with `web/DESIGN.md` as the direction; `design-taste-frontend` once before building a new screen; check with `run` + the built-in browser.
- **Bugs:** `debugging-wizard` (root cause first). **Tests:** `test-master`, `playwright-expert`.
- **Check before a PR:** `pnpm verify`, then `simplify`, `ponytail:ponytail-review`, `code-review`. Add `security-reviewer` (cloud: `security-review`) when the change touches auth, uploads, prompts, contact data or spawns a process.
- **New slice or big decision:** `feature-dev:feature-dev`, `architecture-designer`, `the-fool` (pre-mortem), `anthropic-skills:deep-research`.
- **Not used on purpose:** `claude-mem:cloud-sync`, `knowledge-agent`, `screenpipe` (they copy data off this machine).
- **claude-mem** stays off only for sessions reading email in the personal category. Everything else is allowed, including real CVs, postings and the vault.

## Hard rules
1. **Green or no push.** The `pre-push` hook runs `pnpm verify`. Never use `--no-verify`. Judge a check by its exit code, never by grepping its output. A Claude Code hook (`.claude/settings.json` → `scripts/guard-command.mjs`, self-test `--test`) blocks that flag, a `gh pr merge` without `--match-head-commit`, and force-adding `docs/`.
2. **Secrets.**
   - Keys live in `.env` (gitignored) or Windows Credential Manager.
   - Never print, log, commit or paste a key value. When inspecting `.env`, mask it: `sed -E 's/(KEY|TOKEN)=.*/\1=<redacted>/'`.
3. **App config comes from `.env` only**, through `readAppEnv()` / `loadConfig()` in `server/src/config.ts`.
   - Never read `ANTHROPIC_*` from `process.env`: Claude Code exports its own `ANTHROPIC_BASE_URL`.
   - Tests never read the real `.env` (`AOS_ENV_FILE=''` is set in `server/vitest.config.ts`).
4. **No personal data in this repo, logs or error messages.** The vault and data dirs live outside it (enforced by `parseConfig`). Throw typed errors with fixed messages; never put model, posting, CV or user text in an error, log, job payload or audit arg.
5. **TypeScript stays `~6.0.x`.** typescript-eslint supports only `<6.1`.
6. **Native packages:** use the prebuilt binaries.
   - There's no Visual Studio on this machine.
   - Don't add a package to `pnpm.onlyBuiltDependencies` unless it truly has to compile.
   - `better-sqlite3` belongs in `ignoredBuiltDependencies`.
7. **gh** is `C:\Program Files\GitHub CLI\gh.exe`.
   - Its keyring login is invisible to the sandboxed Bash, so run gh unsandboxed or from PowerShell.
   - The git protocol is https.
8. **Merging a session's PR:** run `pnpm verify` yourself at the PR's head commit first, on this Windows machine, also for a cloud session's PR. A session's report is not proof. Then merge exactly that commit: `gh pr merge <N> --squash --match-head-commit <verified-sha>`, which refuses if the head moved. Always pass the PR number and check `state=MERGED` afterwards. After reporting a PR ready, a session pushes nothing more unless the coordinator asks.
9. **Stacked PRs:** merge bottom-up. After each squash-merge, retarget the next PR to `main`, merge `origin/main` into its branch (`-X ours`; a modify/delete conflict keeps the branch's side), check `git diff <verified-head> HEAD` is empty (if not, `git checkout <verified-head> -- <those files>`: main's non-conflicting hunks still come in), push normally (no force-push) and merge that commit.
10. **Every change has an issue and a review on GitHub**, all from the owner's account (`gh` is logged in as `amirwebd3v`):
    - **Before building:** an issue per ticket or feature, `--assignee amirwebd3v`, a label (`enhancement`, `bug`, `documentation`, `weekN`), added to Project 1 (`gh project item-add 1 --owner amirwebd3v --url <issue>`).
    - **Each real bug or review finding** gets its own issue (`review-finding` or `bug`), assigned the same way, closed by the PR that fixes it.
    - **The PR** is assigned to `amirwebd3v` and its body says `Fixes #N` for every issue it closes.
    - **Before merging:** run the review (`code-review`, plus `security-reviewer` when rule-worthy) and post it on the PR with `gh pr review <N> --comment --body-file <file>`: what was checked, findings with `file:line`, and the issue opened for each. GitHub doesn't let the author approve their own PR, so it's a comment review.
11. **Nothing posted names Claude.** No `Co-Authored-By: Claude` line, no "Generated with Claude Code" line, in commits, PRs, issues or reviews. This overrides any default attribution.
12. **Map every scenario before designing a feature.** List the states the thing can be in (processing, failed, final, archived, empty, very large), what happens when an input changes afterwards (edited, stale, deleted), retries and regenerating, unsaved edits, concurrent changes, and how the owner undoes it. Put every open choice to the owner with a recommendation before building, and show the list in the design. Missed on the application page: no posting edit, no refresh (#72, #73).

## Learning loop: when a mistake happens
1. Fix it.
2. **Prevent it mechanically** if you can: a test, lint rule, hook or schema check beats a written rule.
3. Otherwise add a one-line rule under *Lessons* below, **in the same PR**.
4. Save a claude-mem note (`save_memory`, project `Agentic OS`) with cause → fix. Before starting a ticket, run `mem-search` on its topic.

## Lessons (append, newest last)
- 2026-11-01: a worktree session can't edit the main checkout's `docs/` (a hook blocks it). → Put the exact edits in the shared notes folder for the session in the main checkout; don't work around the hook.
- 2026-10-26: when a test fails, re-derive the *correct* behaviour before editing the code or the test. In the `..data` case, the test's assumption was wrong.
- 2026-10-26: very long temp paths break native installs. Verify a PR in the session's own worktree instead.
- 2026-10-26: claude-mem's worker needs Bun at `~/.bun/bin/bun.exe`. If memory tools fail, check `~/.claude-mem/logs` first.
- 2026-10-26: git hooks export `GIT_*`; spawning git for another repo inherited them. → Spawn git for any other repo with a clean env, as `vaultGit()` does.
- Git-spawning tests are slow on Windows (5 s timeout, EBUSY on sync `rm`). → `testTimeout: 30_000`, async `rm` in afterEach, generous `vi.waitFor`. Re-run a failure once before blaming the diff, then fix the flakiness at the root.
- 2026-10-26: tools installed mid-session (winget: uv, bun) aren't on PATH in already-running shells. Prefer fixed install locations (`~/.bun/bin`) and don't mistake ENOENT in an old shell for a bug.
- 2026-10-26: test helpers never depend on build artifacts (`web/dist`).
- 2026-10-26: stopping a backgrounded `pnpm … tsx src/main.ts` left node holding its port. → After stopping a dev server, check the port with `netstat -ano` and stop that PID once its command line confirms it is yours.
- 2026-10-26: `/tmp` is shared by parallel sessions. A `pnpm verify > /tmp/v.log` showed a sibling worktree's failure as if it were ours. → Write logs and scratch files to the session's own scratchpad, never a fixed `/tmp` name.
- 2026-10-27: `/code-review <sha>` checked out that commit and left a detached HEAD, so the next commit and my edits landed off the branch. → After any review skill run `git branch --show-current` before committing, and review a past commit with `git show` or a worktree, not a checkout.
- 2026-11-01: a decider test flaked "under load", but the cause was `fetch` refusing a random port on its bad-port list. → Print the error's `cause` before believing a timing theory; a test server for `fetch` must avoid ports ≤ 10080.
