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
8. **Merging a session's PR:** run `pnpm verify` yourself at the PR's head commit first. A session's report is not proof.

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
