---
title: Development workflow
---

# Development workflow

How every ticket is built. Three plugins are used together, each for a different job:

| Plugin | Role in this project |
|---|---|
| **fullstack-dev-skills** | The *domain expert*. The skills listed in each ticket's `skills` property (e.g. `secure-code-guardian`, `vue-expert`) shape how the code is written and reviewed. |
| **ponytail** | The *scope guard*. Always on at level `full`: the smallest change that meets the ticket's acceptance criteria. It never simplifies away input validation, security, data-loss protection or accessibility. |
| **claude-mem** | The *project memory*. It records tool calls and turns them into observations that are brought back in later sessions, so decisions made in one ticket are known in the next. |

## Backlog

- The board is [[Backlog.base]]: a kanban view by `status` and a table view by `wave`, with point totals.
- Status lives **only** in each ticket's frontmatter: `Backlog → In progress → Review → Done`, plus the `started` and `completed` dates. Don't copy status anywhere else.
- Start a ticket only when every note in its `depends_on` shows `Done`.
- Open this `docs/` folder in Obsidian via *Open folder as vault*. It's separate from the Thesis vault and from the app's personal vault.

## Per-ticket loop

1. **Pick:** the lowest-wave ticket whose dependencies are all `Done`. Set `status: In progress` and `started: <date>`.
2. **Recall:** `/claude-mem:mem-search <ticket topic>` for earlier decisions and gotchas. From the second session on, relevant context is also injected automatically.
3. **Build:** follow the ticket steps with its `skills`. Under ponytail, reuse what already exists, add no new dependency the ticket doesn't name, and mark every deliberate shortcut with a `// ponytail: <ceiling>, <upgrade path>` comment.
4. **Check:** run the ticket's tests, then `pnpm verify` (typecheck + lint + test).
5. **Review** (set `status: Review`):
   - `/ponytail-review` on the diff for over-engineering.
   - `fullstack-dev-skills:code-reviewer` for bugs and quality.
   - Tickets with `secure-code-guardian` in `skills` (W1-03, W1-04) also get a `fullstack-dev-skills:security-reviewer` pass, and so do the security-critical files in W1-07 (`markdown.ts`) and W1-08 (`writer.ts`).
6. **Close:** tick the ticket's acceptance criteria, set `status: Done` and `completed: <date>`, and make one commit per ticket: `W1-0X: <title>`.

## Per wave

- `/ponytail-debt`: collect the `ponytail:` comments into [[debt]], so shortcuts are tracked instead of forgotten.
- Run `/ponytail-audit` once at the end of Week 1, as part of W1-13.
- Once the code exists, run `/claude-mem:learn-codebase` once (optional) to front-load the repo into memory.

## Privacy rule for claude-mem ⚠️

claude-mem sends tool-call observations to an AI provider for compression. Data is stored locally in `~/.claude-mem`. That's fine for the **code repo**, which holds no personal data. **Never run a Claude Code session with claude-mem active against the app's personal vault or `data/` (brain.db, mail, persona).** Doing so would copy your private data into a second memory store and send it to a provider outside the app's own controls. Open those folders only through the app itself, or turn claude-mem off for that session.
