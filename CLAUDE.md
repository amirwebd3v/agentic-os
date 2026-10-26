# Agentic OS: rules for every Claude session in this repo

Every session reads this file automatically, including parallel sessions in `.claude/worktrees/`. Keep it short. A rule earns its place by preventing a real mistake.

## Where things are
- **Plan:** `docs/plan-review.md`
- **Week 1 plan:** `docs/week1/implementation-plan.md`
- **Ticket specs:** `docs/week1/tickets/*.md`
- **Build loop:** `docs/Workflow.md` (fullstack-dev-skills + ponytail + claude-mem)
- **Backlog:** GitHub Project https://github.com/users/amirwebd3v/projects/1. Status lives only there.

## Hard rules
1. **Green or no push.** The `pre-push` hook runs `pnpm verify`. Never use `--no-verify`. Judge a check by its exit code, never by grepping its output.
2. **Secrets.**
   - Keys live in `.env` (gitignored) or Windows Credential Manager.
   - Never print, log, commit or paste a key value. When inspecting `.env`, mask it: `sed -E 's/(KEY|TOKEN)=.*/\1=<redacted>/'`.
3. **App config comes from `.env` only**, through `readAppEnv()` / `loadConfig()` in `server/src/config.ts`.
   - Never read `ANTHROPIC_*` from `process.env`: Claude Code exports its own `ANTHROPIC_BASE_URL`.
   - Tests never read the real `.env` (`AOS_ENV_FILE=''` is set in `server/vitest.config.ts`).
4. **No personal data in this repo.** The vault and data dirs live outside it (enforced by `parseConfig`).
5. **TypeScript stays `~6.0.x`.** typescript-eslint supports only `<6.1`.
6. **Native packages:** use the prebuilt binaries.
   - There's no Visual Studio on this machine.
   - Don't add a package to `pnpm.onlyBuiltDependencies` unless it truly has to compile.
   - `better-sqlite3` belongs in `ignoredBuiltDependencies`.
7. **gh** is `C:\Program Files\GitHub CLI\gh.exe`.
   - Its keyring login is invisible to the sandboxed Bash, so run gh unsandboxed or from PowerShell.
   - The git protocol is https.
8. **Merging a session's PR:** run `pnpm verify` yourself at the PR's head commit first. A session's report is not proof. Then merge exactly that commit: `gh pr merge <N> --squash --match-head-commit <verified-sha>`, which refuses if the head moved. After reporting a PR ready, a session pushes nothing more unless the coordinator asks.

## Learning loop: when a mistake happens
1. Fix it.
2. **Prevent it mechanically** if you can: a test, lint rule, hook or schema check beats a written rule.
3. Otherwise add a one-line rule under *Lessons* below, **in the same PR**.
4. Save a claude-mem note (`save_memory`, project `Agentic OS`) with cause → fix. Before starting a ticket, run `mem-search` on its topic.

## Lessons (append, newest last)
- 2026-10-26: a grep-filtered check hid a failing lint and it was pushed. → `pre-push` hook (rule 1).
- 2026-10-26: `onlyBuiltDependencies: [better-sqlite3]` forced node-gyp and broke `pnpm install`. → rule 6.
- 2026-10-26: when a test fails, re-derive the *correct* behaviour before editing the code or the test. In the `..data` case, the test's assumption was wrong.
- 2026-10-26: very long temp paths break native installs. Verify a PR in the session's own worktree instead.
- 2026-10-26: claude-mem's worker needs Bun at `~/.bun/bin/bun.exe`. If memory tools fail, check `~/.claude-mem/logs` first.
- 2026-10-26: Claude Code's inherited `ANTHROPIC_BASE_URL` would override the app's 9router URL. → rule 3, with a test.
- 2026-10-26: git hooks export `GIT_DIR`. A `git -C <other repo>` run inside one (vault tests under pre-push) retargeted the code repo, and `git init` set `core.bare=true` for every worktree. → `vaultGit()` strips `GIT_*` (with a test) and `pre-push` unsets `GIT_*` before verify. Spawn git for any other repo with a clean env.
- 2026-10-26: a vault test spawning real git took 5.19 s against vitest's 5 s default and failed one verify at random. → `testTimeout: 30_000` in `server/vitest.config.ts`. Re-run a failure once before blaming the diff, then fix the flakiness at the root.
- 2026-10-26: `gh pr merge` without a number targets the *current* branch's PR. After `gh pr create --head <other>` it silently merged nothing. → Always pass the PR number, and confirm `state=MERGED` before reporting a merge.
- 2026-10-26: on Windows a hard-killed `pnpm sidecar` leaves uv → python running (port 8009 + ~1.6 GB VRAM). → `scripts/sidecar.ts` reaps a stale `laya` listener on start, and refuses to kill anything else. Tested live in all three cases.
- 2026-10-26: tools installed mid-session (winget: uv, bun) aren't on PATH in already-running shells. Prefer fixed install locations (`~/.bun/bin`) and don't mistake ENOENT in an old shell for a bug.
- 2026-10-26: a catch-all `none` option pulls Laya away from correct answers (0.45 `none` on clear EN/DE cases). → Decider questions never offer a catch-all; low confidence escalates instead (W1-10 spec).
- 2026-10-26: `buildTestApp` used the real `web/dist`, so tests changed result after `pnpm build`, and static's wildcard returned 404 instead of 401 for unknown `/api/*`. → Test helpers never depend on build artifacts (`webDist` is injected), and static uses `wildcard: false`. Found by W1-07.
- 2026-10-26: stopping a backgrounded `pnpm … tsx src/main.ts` left node holding its port (same as the sidecar case). → After stopping a dev server, check the port with `netstat -ano` and stop that PID once its command line confirms it is yours.
- 2026-10-26: `/tmp` is shared by parallel sessions. A `pnpm verify > /tmp/v.log` showed a sibling worktree's failure as if it were ours. → Write logs and scratch files to the session's own scratchpad, never a fixed `/tmp` name.
- 2026-10-26: four sessions pushed to their PR branch after it was verified and merged; the late commits were stranded and needed follow-up PRs. → rule 8: `--match-head-commit`, and no pushes after reporting ready.
- 2026-10-26: `mapError` copied local error messages verbatim, so a parse error on truncated model output could put personal text into `llm_calls.error`, job errors and logs (found by W1-12). → Errors without a status keep only their type name and no `cause` (tested). Never put model or user text in an error message.
