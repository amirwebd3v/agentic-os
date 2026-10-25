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

- **The board is the GitHub Project [Agentic OS](https://github.com/users/amirwebd3v/projects/1)**, linked to the private repo [amirwebd3v/agentic-os](https://github.com/amirwebd3v/agentic-os). It has one issue per ticket, with **Points**, **Wave** and **Risk** fields, the `week1` label and the "Week 1" milestone.
- **Status lives only in the Project:** `Todo → In Progress → Done`. "Review" means an open pull request for the ticket.
- **The ticket files** in `week1/tickets/` are the *specs* (steps, tests, acceptance criteria). Each one links to its issue via the `issue` property. Edit the spec file, not the issue body.
- **Dependencies** are native GitHub "blocked by" links. Start an issue only when it shows no open blockers.
- You can still open this `docs/` folder in Obsidian (*Open folder as vault*) to read the specs with working wikilinks. It's separate from the Thesis vault and from the app's personal vault.

## Per-ticket loop

1. **Pick:** the lowest-Wave issue with no open blockers. Set it to **In Progress** and create the branch `w1-0X-<slug>`.
2. **Recall:** `/claude-mem:mem-search <ticket topic>` for earlier decisions and gotchas. From the second session on, relevant context is also injected automatically.
3. **Build:** follow the ticket steps with its `skills`. Under ponytail, reuse what already exists, add no new dependency the ticket doesn't name, and mark every deliberate shortcut with a `// ponytail: <ceiling>, <upgrade path>` comment.
4. **Check:** run the ticket's tests, then `pnpm verify` (typecheck + lint + test).
5. **Review:** open a pull request with `Closes #<issue>` in its body, then run:
   - `/ponytail-review` on the diff for over-engineering.
   - `fullstack-dev-skills:code-reviewer` for bugs and quality.
   - Tickets with `secure-code-guardian` in `skills` (W1-03, W1-04) also get a `fullstack-dev-skills:security-reviewer` pass, and so do the security-critical files in W1-07 (`markdown.ts`) and W1-08 (`writer.ts`).
6. **Close:** tick the acceptance criteria in the spec file, then merge the pull request (one squash commit per ticket: `W1-0X: <title>`). The issue closes, and the Project moves it to **Done**. If it doesn't move automatically, enable the Project's built-in "Item closed → Done" workflow.

## Per wave

- `/ponytail-debt`: collect the `ponytail:` comments into [[debt]], so shortcuts are tracked instead of forgotten.
- Run `/ponytail-audit` once at the end of Week 1, as part of W1-13.
- Once the code exists, run `/claude-mem:learn-codebase` once (optional) to front-load the repo into memory.

## Privacy rule for claude-mem ⚠️

claude-mem sends tool-call observations to an AI provider for compression. Data is stored locally in `~/.claude-mem`. That's fine for the **code repo**, which holds no personal data. **Never run a Claude Code session with claude-mem active against the app's personal vault or `data/` (brain.db, mail, persona).** Doing so would copy your private data into a second memory store and send it to a provider outside the app's own controls. Open those folders only through the app itself, or turn claude-mem off for that session.
