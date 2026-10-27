# Skills map (Week 2)

Which installed skill is used at which step, and why each of the others is not. Each ticket spec in [`tickets/`](tickets/) repeats the rows that apply to it at the step where they apply. Skills are tools for the step in front of you, not a checklist to exhaust: "not used" below is a decision, with its reason.

**Two skill sets.** The skills below are the ones installed in the cloud sessions. The Week 1 plugin *fullstack-dev-skills* (`typescript-pro`, `sql-pro`, `vue-expert`, `secure-code-guardian`, `security-reviewer`, `code-reviewer`; see [[Workflow]]) is installed on your Windows machine, not here. A session running there uses those for the same steps; a cloud session uses `security-review` and `code-review` instead.

## A. The loop every ticket follows

| Step | Skill | What for |
|---|---|---|
| 1 Recall | `claude-mem:mem-search` | Earlier decisions and gotchas on the ticket's topic (search → timeline → fetch only the ids you need). It works here and shows no conflicting decisions so far. |
| 1 Recall | `claude-mem:smart-explore` | Structure of a file (functions, exports) without reading all of it. Use before opening a long file. |
| 2 Learn the library | `claude-mem:make-plan` (phase 0 only) | Documentation discovery before the first line, for tickets that bring a library: `csv-parse` (W2-04), Primer tokens (W2-08), `docxtemplater` (W2-09). |
| 3 Build | `ponytail` (always on, `full`) | Smallest diff; reuse first; a `ponytail:` comment for every deliberate shortcut. Never simplifies security, validation or the verifier. |
| 3 Build | `claude-api` | Structured outputs, effort, caching and prompt shape (W2-05, 07, 10). |
| 3 Build | `anthropic-skills:docx`, `anthropic-skills:pdf` | Template structure and output checks (W2-09). |
| 3 Build (UI) | `impeccable`, `anthropic-skills:design-taste-frontend` | The design sequence in section C (W2-08, 11). |
| 4 Check | `pnpm verify` | Typecheck, lint, all tests. Judge by exit code. |
| 4 Check | `simplify` | Cleanup of the changed code: reuse, efficiency. Quality only, no bug hunting. |
| 4 Check | `ponytail:ponytail-review` | Over-engineering in the diff. |
| 4 Check | `code-review` (`medium`) | Bugs in the diff. Real findings so far: stale queue items, unhandled jobs, a dropped router key. `max` only if you ask. |
| 4 Check | `security-review` | **Required** on W2-03, 04, 05, 07, 09: they handle contact data, untrusted files and text, prompts, or spawn a process. |
| 5 UI check | `run`, `anthropic-skills:built-in-browser` | Start the app, take screenshots at 1280 and 800 px, light and dark, and drive every state. |
| 6 Close | `claude-mem` `save_memory`, `CLAUDE.md` Lessons | Cause → fix for any mistake, in the same PR. |
| Pause | `claude-mem:handoff` | At about 70% of the context window; resume in a fresh window. |

## B. Per wave, per week, per slice

| When | Skill | What for |
|---|---|---|
| Before Wave 2 (coordinator) | `claude-mem:learn-codebase` | Read the (now smaller) repo once. Sessions then use `smart-explore`. |
| Before Wave 2, if using cloud sessions | `session-start-hook` | A SessionStart hook that runs `pnpm install`, so a fresh cloud session can run `pnpm verify` straight away (this one needed it by hand). |
| Wave start and end | `claude-mem:standup` | Read-only comparison across the parallel branches and PRs → one consolidation plan. Useful from 3 sessions up. |
| Every PR | `claude-mem:babysit` | Watch CI and review until the PR is ready; then CLAUDE.md rule 8 applies. |
| Wave end | live run with `run` + `built-in-browser` | The UAT checkpoint in [[Workflow]]. |
| Wave end | `ponytail:ponytail-debt` | Refresh `docs/debt.md` (done for Wave 1: 11 markers, none without a trigger). |
| After Wave 2 | `fewer-permission-prompts` | One pass over the commands the sessions kept asking about. |
| Week end (W2-12) | `ponytail:ponytail-audit`, `claude-mem:pathfinder`, `claude-mem:timeline-report`, `claude-mem:agent-cost-report` | Whole-repo trim; duplicated concerns across the new jobs; the retro narrative; what the agent sessions cost. |
| Week end (W2-12) | `claude-api prompt-audit`, `claude-api cost-optimize` | Audit the three career prompts for dated patterns; check LLM spend per application. |
| Start of the Email and Social slices | `feature-dev:feature-dev`, `anthropic-skills:deep-research` | Explore → clarify → architect, and research the connectors. |

## C. The design sequence (W2-08, W2-11)

1. `impeccable shape` (task, information, states, frequency, constraints), inside the pinned direction in `web/DESIGN.md`.
2. `design-taste-frontend`, once, before building: an anti-slop pass. `DESIGN.md` wins on conflict.
3. Build; verify with `run` + `built-in-browser`.
4. `impeccable critique` → fix → `impeccable polish` → `impeccable harden` (long titles, German text lengths, 100 items, empty and error states) → `impeccable audit` → `impeccable detect --json` on the changed files.
5. `claude-mem:design-is`: a second lens, Rams' ten principles, on the finished page. Act only on material findings.
6. W2-11: `impeccable onboard` for the first-run empty state ("import your master CV"), `impeccable clarify` for status words and button labels.
7. `impeccable document` replaces the seed `web/DESIGN.md` with real tokens.

## D. Every installed skill

| Skill | Use | Where or why not |
|---|---|---|
| `impeccable:impeccable` | **Used** | W2-02 (done), W2-08, W2-11, W2-12 (section C) |
| `anthropic-skills:design-taste-frontend` | **Used** | W2-08, once |
| `claude-api` | **Used** | W2-05, 07, 10 (`build-eval`, `hillclimb`), W2-12 (`prompt-audit`, `cost-optimize`). Already used to settle R1–R3. |
| `anthropic-skills:docx` | **Used** | W2-09: starter templates, tag checks, inspecting `document.xml` |
| `anthropic-skills:pdf` | **Used** | W2-09: check page count and text of generated PDFs |
| `ponytail:ponytail` | **Used** | Always on |
| `ponytail:ponytail-review` | **Used** | Every PR |
| `ponytail:ponytail-debt` | **Used** | End of every wave |
| `ponytail:ponytail-audit` | **Used** | W2-12 |
| `ponytail:ponytail-gain`, `ponytail:ponytail-help` | Reference | Information only; not a step |
| `code-review` | **Used** | Every PR |
| `security-review` | **Used** | W2-03, 04, 05, 07, 09, and the whole slice in W2-12 |
| `simplify` | **Used** | After each build |
| `run` | **Used** | UAT after each wave; UI tickets |
| `anthropic-skills:built-in-browser` | **Used** | Screenshots in UI checks |
| `anthropic-skills:chrome-browser` | Alternative | Only if the in-app browser can't do a check |
| `feature-dev:feature-dev` | **Used** | Planning review (done); start of Email and Social |
| `anthropic-skills:deep-research` | **Used** | Email and Social connector research; any claim marked unverified |
| `claude-mem:mem-search`, `claude-mem:smart-explore` | **Used** | Step 1 of every ticket |
| `claude-mem:make-plan` | **Used** | Phase 0 (documentation discovery) in W2-04, 08, 09 |
| `claude-mem:handoff` | **Used** | Pause and resume at about 70% context |
| `claude-mem:learn-codebase` | **Used** | Once, before Wave 2 |
| `claude-mem:standup` | **Used** | Wave start and end |
| `claude-mem:babysit` | **Used** | Every PR |
| `claude-mem:design-is` | **Used** | W2-08, after `critique` |
| `claude-mem:pathfinder`, `claude-mem:timeline-report`, `claude-mem:agent-cost-report` | **Used** | W2-12 |
| `claude-mem:do`, `claude-mem:build` | Alternative | One-session automation (`make-plan` → `do` → `babysit`) for a small ticket if you prefer it over a separate session. Default: separate sessions, as in Week 1. |
| `claude-mem:what-the` | On demand | A plain-English explanation of anything, when you ask |
| `claude-mem:oh-my-issues` | Later | When the GitHub backlog grows past this slice |
| `claude-mem:weekly-digests` | Later | Useful once the project spans several weeks |
| `claude-mem:owner-goals`, `claude-mem:request-progress` | Optional | Dashboards inside claude-mem; not part of the build |
| `claude-mem:backup-setup` | Optional | Local snapshots of the claude-mem database; separate from the `brain.db` backup planned before Email |
| `claude-mem:cloud-sync`, `claude-mem:knowledge-agent`, `claude-mem:screenpipe` | **Not used** | They copy memories, build knowledge bases from memory, or read screen and audio history. That contradicts the privacy rule for the career files ([[Workflow]]). |
| `claude-mem:how-it-works`, `claude-mem:mode-creator`, `claude-mem:ccs-align` | Not used | Reference or claude-mem's own configuration |
| `claude-mem:build-and-release`, `claude-mem:release`, `claude-mem:version-bump`, `claude-mem:childhood` | Not used | Release automation for plugins; this app has no release process |
| `claude-mem:wowerpoint` | Not used | Turns a document into a slide deck; none needed |
| `session-start-hook` | **Used** (optional) | Before Wave 2, if cloud sessions are used |
| `fewer-permission-prompts` | **Used** | Once, after Wave 2 |
| `update-config` | On demand | If a hook or permission change is needed |
| `loop` | Not used | PR events arrive through subscription; `babysit` covers the rest |
| `workflow-authoring` (and the `Workflow` tool) | Not used by default | Only if you explicitly ask for a multi-agent workflow ("use a workflow") |
| `init` | Not used | `CLAUDE.md` exists; changes go in as Lessons |
| `plugin-authoring`, `cowork-plugin-management:*` | Not used | We aren't building a plugin |
| `keybindings-help` | Not used | Unrelated |
| `dataviz` | Not used | The Quiet Ledger has no charts. If one is ever added (W2-11 or later), load it first. |
| `artifact-design`, `artifact-capabilities`, `artifact-diagramming`, `anthropic-skills:docs` | Optional | Only to publish the plan as a private shareable page, if you want to show it to someone |
| `anthropic-skills:google-workspace` | Not in the pipeline | Would route mail through Claude's connector. Ad-hoc use only, later |
| `anthropic-skills:computer-use` | Not used | Nothing here controls a desktop app; the Word PDF check is yours on Windows |
| `anthropic-skills:skill-creator` | Later | If a workflow repeats enough to package (for example the tailoring runbook) |
| `anthropic-skills:xlsx`, `anthropic-skills:pptx` | Not used | No spreadsheet or deck is produced |
| `anthropic-skills:thesis-supervisor` | Not used | A separate project |
| `anthropic-skills:import-memory`, `anthropic-skills:morning`, `anthropic-skills:youtube-summarizer` | Not used | Unrelated to the build (the video was summarised during planning) |
