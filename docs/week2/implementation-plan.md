# AOS-W2 Implementation Plan: the OS layer

*Created 2026-10-26. Source: the video "The 3-Step System to Build an Agentic OS in 2026" (Charlie Automates), filtered through [plan-review.md](../plan-review.md). This is one short wave that runs before Month 1. The build loop is still [[Workflow]], extended by §2.*

## Decisions (from your answers, 2026-10-26)
| Video idea | Our version | Why |
|---|---|---|
| Brain = Obsidian + Graphify | Keep the existing vault. **No Graphify.** | Community plugins are banned in the vault (§0d). The graph view is deferred. |
| SEED (idea → planning doc) | Ticket spec files. Use `claude-mem:make-plan` for ideas that have no ticket yet. | We already write specs. Only *new* ideas need an ideation step. |
| PAUL plan → apply → unify → loop | The per-ticket loop. **Unify** = tick the acceptance criteria + update the Project status + `save_memory`. | It's the same loop, and the status already lives in one place. |
| `paul pause` / `paul resume` | `claude-mem:handoff` at ~70% context, then resume in a fresh window | A mid-ticket compaction loses decisions. |
| `/goal` ("run until you need me") | Each wave brief says "build until the UAT checkpoint, then stop" | It matches rule 8: push nothing after "ready". |
| UAT checkpoints | A formal **UAT** step: the coordinator does a live run between waves | The retro found that live runs catch more than the per-PR checks do. |
| Agentic dashboard | **W2-03/04/05:** daily brief + review + workflow buttons | This is the main deliverable. |
| Hermes on a VPS + MCP | **W2-07:** a local stdio MCP wrapper only (plan N3) | No VPS, no always-on agent, no new exfiltration surface. |
| Railway deploy, phone app | **W2-06:** local "ship" = `pnpm build` at `127.0.0.1:3000` + a PWA install | You chose to stay local. The threat model is unchanged. |
| API keys typed into a settings page | **Rejected.** Keys stay in `.env` / Credential Manager. | CLAUDE.md rules 2–3. |

**Out of scope:** the graph view, phone access, Instagram/YouTube metrics, hybrid search (Month 1).

## 1. Tickets
| # | Ticket | Pts | Wave | Depends on | Skills |
|---|---|---|---|---|---|
| W2-01 | **Build-loop upgrade** (docs only): add §2 to `Workflow.md`, plus the UAT step, handoff at ~70% context, and an optional status line that shows context % | 1 | 1 | — | claude-mem, ponytail |
| W2-02 | **Design context:** `impeccable init` → `PRODUCT.md`, `impeccable document` → `DESIGN.md` from `web/src/style.css` | 1 | 1 | — | impeccable |
| W2-03 | **`GET /api/dashboard`:** pending-review count + the oldest 5, sessions from the last 7 days grouped by area, the flagged/inbox count, and failed jobs from the last 24 h. Reuse the existing queries in `routes/sessions.ts` and `routes/approvals.ts`. | 2 | 2 | — | typescript-pro, ponytail |
| W2-04 | **`POST /api/workflows/:name`**, with an allow-list of names: `refile-flagged` (enqueues `categorize_session` with idempotent keys) and `expire-proposals` (`approvals/expire.ts`). An unknown name → 404. Every call is audited. The response returns the job count. | 2 | 2 | — | secure-code-guardian, ponytail |
| W2-05 | **Dashboard UI:** `DashboardView.vue` at `#/dashboard`, a sidebar link, cards for the brief, the review queue (approve/reject inline through the existing store) and workflows. "Persona round" reuses the new-session picker. | 3 | 3 | 02, 03, 04 | vue-expert, impeccable, design-taste-frontend |
| W2-06 | **Local ship:** `manifest.webmanifest` + icon + `pnpm start` (build, then serve :3000). The app installs as a PWA from Edge/Chrome. The CSP stays strict. | 1 | 2 | — | ponytail |
| W2-07 | **MCP stdio wrapper** (`server/src/cli/mcp.ts`, `@modelcontextprotocol/sdk`), read-only tools: `list_areas`, `list_sessions(area?)`, `get_session_summary(id)`. No writes. Sensitivity ≥ 2 is never returned. | 2 | 2 | — | typescript-pro, secure-code-guardian |
| W2-08 | **Verify + retro:** acceptance run, `ponytail-audit`, `ponytail-debt` → `debt.md`, `impeccable audit` on the dashboard, Lessons | 1 | 4 | all | ponytail, impeccable, claude-mem |

**Total:** 13 pts. **Must-have line:** W2-01, W2-03, W2-04, W2-05 and W2-08 (9 pts).

**Contract first:** before Wave 2, the coordinator writes `docs/week2/dashboard-contract.md` with the JSON shapes for W2-03/04, so W2-05 can build against it in parallel (this worked in Week 1).

### Acceptance (UAT checkpoint after each wave)
- **W2-03/04:** `pnpm verify` is green. An unknown workflow → 404. Calling `refile-flagged` twice enqueues no duplicates. Every call creates an audit row.
- **W2-05:** the dashboard loads in under 300 ms with 100 sessions. Approve/reject works from the card and the sidebar badge updates. It's keyboard-only usable, works in light and dark mode, and works at 1280 px and 800 px widths.
- **W2-06:** installed from `127.0.0.1:3000`, it opens in its own window. Requests with a wrong Host still get 403.
- **W2-07:** in a Claude Code profile **with claude-mem off**, `list_sessions` returns your sessions. A T2 session never appears.

## 2. Skill routing: which skill, when, and for what
Every ticket brief copies the rows that match its `skills` field.

| Skill | Use it for | When | Never for |
|---|---|---|---|
| `claude-mem:mem-search` | Earlier decisions and gotchas on the ticket's topic | **Step 1 of every ticket** | — |
| `claude-mem:make-plan` | Turning a new idea into a spec (the SEED step) | Only for ideas with no ticket yet | Re-planning a ticket that's already specced |
| `claude-mem:handoff` | Pause/resume with full context | Context ~70%, or before ending a session mid-ticket | Replacing the ticket spec |
| `save_memory` (project `Agentic OS`) | Cause → fix after a mistake, plus one note per merged ticket | The "unify" step | Personal data |
| `ponytail` (always on, `full`) | Smallest diff, reuse first, `ponytail:` comments | While writing any code | Simplifying security, validation, a11y or data-loss guards |
| `ponytail-review` | Over-engineering check on the PR diff | Every PR | — |
| `ponytail-debt` / `ponytail-audit` | Collect shortcuts / do a repo-wide trim | debt at the end of each wave, audit in W2-08 | — |
| `impeccable init` / `document` | `PRODUCT.md` + `DESIGN.md`, the single design source of truth | W2-02, once | Backend tickets |
| `impeccable shape` → build → `critique` → `polish` | Dashboard UX in **Operate** mode (scanability over expression) | W2-05, in this order | Inventing a new visual world: refine the existing tokens |
| `impeccable audit` | a11y, responsive and performance checks | W2-05 before the PR, W2-08 | — |
| `design-taste-frontend` | A taste lens against generic "AI dashboard" output (stat-tile soup, gradients, fake charts) | W2-05, **once**, between `shape` and the build | Overriding `DESIGN.md`. On conflict, DESIGN.md wins and the taste note goes into the PR. |
| `code-review` / `security-reviewer` | Bugs; trust boundaries | Every PR; W2-04, W2-07 | — |
| `run` (Playwright) | Screenshots and a live check for UAT | W2-05, W2-06 | Replacing the human UAT sign-off |

### Guardrails
1. **The claude-mem privacy rule ([[Workflow]]) also covers MCP.** Calling the W2-07 tools from a session with claude-mem active copies brain data into `~/.claude-mem`. Use MCP only in a profile with claude-mem disabled. W2-07 documents this in the README.
2. **One design authority.** impeccable writes `DESIGN.md`. design-taste-frontend critiques against it and never adds a second style.
3. **Dashboard text stays code-generated.** Labels and counts come from code. Session titles render through the existing `markdown.ts` sanitizer, never through `v-html` on raw text.
4. **Workflows are an allow-list of existing job kinds.** There's no free-form command endpoint, and no LLM output picks a workflow.

## 3. Waves
| Wave | Tickets | Parallel sessions |
|---|---|---|
| 1 | W2-01, W2-02 | 2 (docs) |
| 2 | Contract file, then W2-03, W2-04, W2-06, W2-07 | 4 |
| 3 | W2-05 | 1 |
| 4 | W2-08 | coordinator |

UAT live run between waves 2→3 and 3→4. Merge per CLAUDE.md rule 8.
