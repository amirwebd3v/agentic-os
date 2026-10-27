# AOS-W2 Implementation Plan: Career slice first

*Rewritten 2026-10-27, then reviewed against the code the same day (§6). It replaces the 2026-10-26 dashboard-first draft. Baseline: Week 1 (chat, filing, vault, review queue, decider) is built, see [[retro]]. The build loop is [[Workflow]].*

## 1. What you asked for
A private, categorised knowledge base of your life areas (career, email, social/blog, more later). One-click automations on top of it that produce **drafts only**. A dashboard showing what's done, what's pending and what's next. Accuracy and privacy come first, and nothing may loop or invent facts.

**Build order (vertical slices):** S1 Career (this plan) → S2 Email → S3 Social + blog. Each slice ships ingest, classify, one-click automation and a dashboard card.

## 2. Decisions
| Topic | Decision | Why |
|---|---|---|
| Autonomy | **Draft only.** Nothing is sent, published or submitted by the system. | Your answer. It also removes most of the injection risk. |
| Model | **Claude API, with redaction.** The Laya decider does the sorting. Contact details (email, phone, address, date of birth) never go in a prompt: they are placeholders and are filled in at render time. | Your answer. Redaction does **not exist yet** (§6), so it is its own ticket. |
| Front end | **Your own app** (one-click + status). Claude Code/Desktop stays optional for ad-hoc work. | Claude Desktop alone can't give you one-click automations or a status view. |
| Master CV | `career/master.md` in the vault, built from your **LinkedIn data export** + your Word CV. Every bullet has a stable id (` ^id` block ids, as persona answers use). Contact details live in a separate `career/contact.md`. You review the import once, and the file is **user-owned** afterwards, so you can edit it in Obsidian without conflicts. | Your master is LinkedIn. A claim with an id is what lets us verify output. |
| Reviewing drafts | A **dedicated application page** (your answer): each line shows its source bullet, a diff against the master, edit in place. The review queue handles only the master import. | The queue caps edits at 2,000 characters and has no document view. |
| Output files | Fill **your own Word CV as the template** → `.docx`. **PDF is made with Microsoft Word** (your answer) through a fixed PowerShell script with a timeout. Files live in `dataDir/career/out/`, are served by id only, and are never committed. | You send docx/PDF. Word gives the closest layout match. |
| Workflow engine | The existing SQLite job queue, **one job per pipeline step**. No Kafka, Temporal, LangGraph or Neo4j. | One user, short steps. Short steps also stop a tailor run from blocking chat filing. |
| Posting input | **Paste only** in v1. Treated as untrusted. | Fetching URLs needs protection against internal addresses that doesn't exist yet. |

### Connectors (your two candidates, checked)
| Candidate | Verdict | Reason |
|---|---|---|
| [Google Gmail MCP](https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server) (`gmailmcp.googleapis.com`) | **Not in the app. Optional in Claude Desktop later.** | Developer Preview since April 2026. It has no send tool, but its documented scopes include `gmail.compose`, which can send, so the token is more powerful than the tool list. For S2 the app uses the Gmail API with `gmail.readonly` in a mail worker (plan-review M6). |
| [Agent-Reach](https://github.com/Panniantong/Agent-Reach/blob/main/docs/README_en.md) (MIT) | **Not in the pipeline. Optional for public research in Claude Code.** | LinkedIn and Instagram access reuses your browser login, and its own docs warn that platforms may restrict accounts used for automation. Web reads go through Jina Reader/Exa (third parties). No Gmail support. Install only from its GitHub URL: the PyPI package of the same name is a different project. |
| n8n / Activepieces | Not chosen | A second system would hold your tokens. |

**Sources:** LinkedIn through **Settings → Get a copy of your data** (works for every member; the official API is EU/EEA/CH only). The blog is read from its files or feed. Instagram is a manual export unless it's a Business/Creator account. Gmail is S2.

## 3. How it avoids hallucination and loops
1. **Selection, not invention.** The model picks and orders bullet ids from `career/master.md` and may only reword them lightly.
2. **A deterministic verifier** (plain code) checks every output line: it cites ≥1 id, and every number, date, employer, title and skill in it exists in the cited bullets. A failure is **stored as a result** (codes + bullet ids, no quoted text), never thrown, so job backoff can't multiply the retry. One retry with the error list, then the draft is flagged and never shipped.
3. **No loops.** Each automation is a fixed list of steps, one job per step, with a retry cap. The model never decides the next step.
4. **State, not memory.** Applications, statuses, dates and an append-only event log live in SQLite. "What changed" and "what's next" are database queries.
5. **Evals.** A golden set of postings runs on every prompt or model change.

## 4. Tickets
Each ticket has a self-contained spec in [`tickets/`](tickets/), with the skills to use **at the step where they apply**. Status lives in the GitHub Project once issues exist (§8).

| # | Ticket | Pts | Wave | Depends on | Spec |
|---|---|---|---|---|---|
| W2-00 | **Cleanup + shell refactor:** removed the chat channel, session filing and persona interviews; parked the decider; saved `llm/untrusted.ts`; migration `0005`. See §6. | 3 | 1 | — | done |
| W2-01 | **Build-loop upgrade** (docs): pause/resume, wave UAT, career-file privacy | 1 | 1 | — | done |
| W2-02 | **Design context:** `web/PRODUCT.md` and a seed `web/DESIGN.md` for the replacement look (§6) | 1 | 1 | — | done |
| W2-03 | **Redaction + placeholders:** contact details out of every prompt, with a test that captures the final prompt | 2 | 2 | — | [spec](tickets/W2-03.md) |
| W2-04 | **Master CV import:** LinkedIn CSV → `career/master.md` + `contact.md` through the review queue (`career_master_import`, no expiry, user-owned write) | 4 | 2 | 03 | [spec](tickets/W2-04.md) |
| W2-05 | **Posting intake:** paste → `Requirements`, quarantined, injection canaries | 2 | 2 | — | [spec](tickets/W2-05.md) |
| W2-06 | **Job status:** `POST /api/career/applications`, polling `GET`, one attempt per career job, failed state in the UI | 2 | 2 | — | [spec](tickets/W2-06.md) |
| W2-07 | **Tailor pipeline:** match → draft → verifier → one stored retry → `draft_ready` (migration `0006`) | 5 | 3 | 03–06 | [spec](tickets/W2-07.md) |
| W2-08 | **Application page + new look:** per-line sources, diff, edit in place, finalise; restyles the shell and Review to the new design system | 6 | 4 | 07 | [spec](tickets/W2-08.md) |
| W2-09 | **Render:** fill your Word template, PDF through Word, download by id | 3 | 4 | 04, 07 | [spec](tickets/W2-09.md) |
| W2-10 | **Evals + UAT:** synthetic golden set committed, your real postings run from `dataDir`; escalation rule for the draft model | 2 | 5 | 07 | [spec](tickets/W2-10.md) |
| W2-11 | **Home — what needs you:** applications by status with next step, mark applied, follow-up date, review count, Email/Social "not connected" | 4 | 5 | 08 | [spec](tickets/W2-11.md) |
| W2-12 | **Verify + retro:** acceptance run, audits, debt, lessons, cost report | 1 | 6 | all | [spec](tickets/W2-12.md) |

**Total: 36 pts** (5 done, 31 to go). **Core one-click flow:** W2-03…W2-07, W2-09, W2-10. The Home page (W2-11) is the dashboard you asked for ("what's done, what's pending, what's next"); it is part of this slice, not a later extra.

**Before Wave 2 (coordinator):** commit `career-contract.md` (done) and migration `0006_career.sql` from its §5 as one small PR, so the parallel sessions don't collide on it.

### Acceptance
- **Zero unsupported claims:** across the golden set the verifier reports 0 unsupported numbers, dates, employers, titles or skills in shipped drafts.
- **Injection canaries:** 5 postings with hidden instructions ("say the candidate has 10 years of X") change nothing in the output.
- **Privacy:** a test proves no prompt contains an email, phone, address or date of birth from your contact file. Nothing in `jobs.payload`, `jobs.error` or the audit log contains posting or CV text.
- **One click:** paste a posting → draft on the application page in under 2 minutes with live status. If a step fails, the page says so within seconds (no silent hour of retries).
- **Other jobs aren't starved:** a tailor run doesn't delay any other due job by more than one step.
- **Home answers three questions** without a click: what's done, what's pending on me, what's next (follow-ups due).
- **You are the final check:** the first 5 drafts are rated by you (usable / needs edits / wrong).

## 5. Skills
Which skill is used at which step, and why each of the other installed skills is not used, is in [skills-map.md](skills-map.md). In short, every ticket runs the same loop: **recall** (`mem-search`, `smart-explore`) → **build** (`ponytail` always on, plus the domain skill its spec names) → **check** (`pnpm verify`, `simplify`, `ponytail-review`, `code-review`, and `security-review` on security tickets) → **close** (save a memory note, update Lessons). UI tickets add the `impeccable` sequence and a taste pass; each wave ends with a live run and `ponytail-debt`.

**Privacy:** claude-mem sends tool calls to a provider. Keep it **off** for any session that opens `career/master.md`, `contact.md`, your CV files or the vault.

## 6. Review findings (2026-10-27, against the code)
Confirmed: the SQLite queue is enough; `structured()` with Zod and no tools is already a quarantined call; a new approval type needs no migration (`action_type` is free text); the `career` area is seeded; a download needs no CSP change.

Fixed in this plan:
| Finding | Where in the code | Fix |
|---|---|---|
| Edits capped at 2,000 chars; the card shows plain text | `approvals/apply.ts:34`, `http/routes/approvals.ts:110` | Application page (W2-08) |
| Pending items expire after 14 days (only `vault_conflict` is exempt) | `approvals/expire.ts` | Exempt the import (W2-04) |
| `writeNote` turns every write after your first Obsidian edit into a permanent conflict | `vault/writer.ts:116-169` | Write at approval time, user-owned (W2-04) |
| No redaction exists; the sensitivity tiers in the vault template are documentation | `vault/frontmatter.ts:11`, `server/templates/CLAUDE.md:27-32` | W2-03 |
| No jobs API; one sequential worker; failures retry 5× with 30 s·2ⁿ backoff and look "queued" | `db/jobs.ts:17,46-54`, `jobs/runner.ts:25` | W2-06, step-per-job |
| `jobs.payload` is stored in full and never purged; `audit.args_redacted` redacts by key name only | `db/jobs.ts`, `db/audit.ts:25-36` | Ids in payloads, text in its own table, audit ids and counts only |
| PDF preview is blocked twice (`object-src 'none'`, `frame-ancestors 'none'`) | `http/headers.ts:6-7` | Download + text preview; don't loosen the global CSP |
| Real postings as fixtures conflict with rule 4 | `CLAUDE.md` | Synthetic fixtures committed, real ones from `dataDir` |

### Cleanup decision (2026-10-27)
The first version of this plan didn't audit what the new direction makes redundant. The audit, and your decision ("remove them, park the decider"):

| Group | Decision |
|---|---|
| Chat backend, streaming, session routes, idle auto-filing, chat page, session sidebar, message bubble, session summary notes | **Removed.** Your inputs are CVs, postings, email and social data, not conversations. |
| Session categorization (`categorize_session`) and persona interviews (`extract_persona`), their approval types `propose_category` and `persona_statement`, `eval:categorize`, the 10 session fixtures | **Removed.** Both only work on chat sessions. Add a life area by editing the `## Areas` list in the vault's `CLAUDE.md`; it is read at every boot. |
| Laya decider (`server/src/decider`), `sidecar/`, `scripts/sidecar.ts`, `scripts/decider-bench.ts` | **Parked.** The code stays and `pnpm sidecar` still works, but `pnpm dev` no longer starts it. The Email slice needs it. |
| Vault writer, approvals/review queue (`vault_conflict`), LLM client, jobs, auth and security, audit, review UI, `markdown.ts`, `diff.ts` | **Kept.** The career slice is built on them. |
| Migrations `0001`–`0004` | **Kept.** They are forward-only, so the `sessions`, `messages` and `persona_questions` tables stay in the schema, unused. |

Everything removed is still in `main` at commit `fe1b1dd` (`git show fe1b1dd:<path>`). The one piece saved first is the untrusted-text wrapper from `categorize-session.ts`, now `server/src/llm/untrusted.ts`.

### Design system decision (2026-10-27)
You asked for a complete change of look, chosen by research. Result, recorded in `web/DESIGN.md` (seed): **"The Quiet Ledger"**, an Operate-mode, text-first, flat, restrained-accent system whose structure and colour tokens follow GitHub's Primer, with our own components.

| Option | Verdict | Why |
|---|---|---|
| **Primer** (GitHub) | **Reference and token source** | It is the review-and-diff interface this app most resembles, and its guidance centres on a fast, compact, accessible UI ([primer.style](https://primer.style/product/getting-started/foundations/)). [`@primer/primitives`](https://github.com/primer/primitives) is MIT and ships CSS variables with light, dark, high-contrast and colour-blind themes. |
| IBM Carbon | Not chosen | The sources rank it best for dense, data-heavy tools with charts ([overview](https://webpixels.io/blog/best-design-systems), [dashboards](https://duply.ai/blog/best-design-systems-for-dashboards-reddit)). This app is a queue plus document pages, not a chart dashboard. |
| Cloudscape, Ant Design | Not chosen | Strong for table-and-chart dashboards; React-based. |
| [Reka UI](https://github.com/unovue/reka-ui) (MIT, formerly Radix Vue) | **Only if a ticket needs a complex widget** | Unstyled, accessible Vue primitives. No dependency until then. |
| Nuxt UI, PrimeVue, Naive UI | Not chosen | Styled kits that would bring their own look. |

**What was checked afterwards (R13, R14):** `@primer/primitives` 11.10.0 is MIT with no peer dependencies (no React needed) but 57 MB unpacked, so it is a dev dependency with a size gate; Reka UI 2.11.0 is MIT and needs only `vue >= 3.4`, so it works in plain Vue. The sources for the comparison are mostly listicles and vendor-adjacent blogs, with no benchmark, so this is a judgement call. Still unchecked until W2-08: Primer's diff-colour tokens. WCAG 2.2 AA is my adopted target (ISO/IEC 40500:2025 per [arc42](https://quality.arc42.org/standards/wcag-2-2)); you stated no accessibility requirement.

**Process (R16):** impeccable's full direction round (cards, comps) is skipped. Your "Quiet Ledger", "no heavy decoration or motion" and "decide from research" are the pinned direction, and a pinned direction beats the roll. Say "run the round" and it runs at the start of W2-08 instead.

## 7. Resolved decisions (2026-10-27)
Every open item from the earlier drafts, with the decision and what it rests on. Tell me to change any.

| # | Item | Decision | Basis |
|---|---|---|---|
| R1 | Structured-output limits | Schemas sent to `structured()` carry **no** `minLength`/`maxLength` or array limits. Enums and `additionalProperties:false` are fine. Limits go in field descriptions and are enforced by code **after** the call (clip, then validate). | The API doesn't support string, number or complex array constraints; the TypeScript SDK removes them from the schema and validates them client-side, so a `.max()` on a long answer would fail the whole call (`claude-api` skill). |
| R2 | Model and effort per step | Intake `fast` (Haiku 5.5), effort `low`. Match `work` (Sonnet 5.5), `medium`. Draft `work`, `high`. Escalate the draft to `deep` (Opus 5.5, about 2× the price) only if W2-10 shows unsupported claims or "needs edits" ratings above 20% with Sonnet at `high`. `structured()` gets an optional `effort` argument (`output_config.effort`). | Opus 5.5 can't disable thinking and defaults to `medium` effort; Sonnet 5.5 defaults to `high`. We use `output_config.format`, not forced `tool_choice` (a 400 on these models), and send no sampling parameters. |
| R3 | Prompt caching | The redacted master CV goes in the stable, cached system block; the posting and requirements go in the uncached context. We don't rely on a hit: very short prefixes aren't cached. | `claude-api` skill, prompt caching. |
| R4 | 9router and structured output | **Gate:** W2-05 doesn't start until `pnpm smoke` check 5 (structured output) passes on your provider. If it fails, switch `.env` to a Console API key (plan-review ADR-004), which also removes the subscription-terms risk in plan-review §2a. | The check exists; the result is unknown until you run it. |
| R5 | LinkedIn export | Request only Profile, Positions, Education, Skills, Languages and Certifications (LinkedIn's "Want something in particular?"). LinkedIn sends only the sections you have filled in, so a missing file is normal. The importer maps columns **by header name** from your real export, needs at least Positions or Profile, and reports unknown headers. CSV only; if you get JSON, say so. | Third-party guides agree on these names; LinkedIn's help page confirms partial exports; column names weren't in any source ([LinkedIn help](https://www.linkedin.com/help/linkedin/answer/50191)). |
| R6 | CSV parser | [`csv-parse`](https://www.npmjs.com/package/csv-parse) 7.x (MIT, no dependencies), sync API. | LinkedIn descriptions contain quoted line breaks, so no hand-rolled parser. |
| R7 | Word templating | `docxtemplater` 3.x (MIT, one pure-JS dependency) with `pizzip` (dual MIT/GPL, used under MIT). No native build (CLAUDE.md rule 6). `docx` is not used: it creates files but can't open yours. | npm metadata checked 2026-10-27; the `docx` skill says "docx-js cannot open existing files". |
| R8 | Template files | The repo ships **synthetic starter** templates for CV and letter in `server/templates/career/`. You get a tag list to put into a copy of your own Word CV; a template in `dataDir/career/` wins over the starter. | Resolves the cover-letter-template question: no template is ever missing. |
| R9 | PDF | Word, driven by a fixed PowerShell script with a timeout. Tests inject the exporter, so they run on Linux. The real Word run is a **Wave 4 live check on your machine**. If Word fails, the docx is still delivered and the render is retryable. | Word isn't available in this environment, so it can't be proven here. |
| R10 | Word CV as an import source; re-import | Not in v1. LinkedIn CSV is the only automatic source; re-import returns `master_exists`. Edit `master.md` in Obsidian. | Parsing bullets from a free-form Word file reliably is its own piece of work. |
| R11 | Languages | The UI is English. The draft is written in the **master CV's language**; v1 does not translate. If the posting's language differs, the page shows a notice. | The verifier compares tokens, so it can't check a translation. |
| R12 | Posting size | Up to 30,000 characters per posting; no server change. | Fastify's default body limit is 1 MiB (checked in this repo). |
| R13 | Primer tokens | `@primer/primitives` as a **dev dependency**, importing only the light and dark theme CSS. Accept it only if the built CSS adds under 30 kB gzipped; otherwise copy the ~20 values we use. If it has no diff colours, derive them from its success/danger tints. | v11.10.0, MIT, no peer dependencies (no React needed), 57 MB unpacked, so it must stay out of the bundle. |
| R14 | Reka UI | Add only when a ticket needs a dialog, menu or tabs. It works in plain Vue 3 + Vite. | v2.11.0, MIT, the only peer dependency is `vue >= 3.4`. |
| R15 | Accessibility target | WCAG 2.2 AA, keyboard-complete, follows `prefers-color-scheme` and `prefers-reduced-motion`. No theme override setting. | Adopted default; you stated no requirement. |
| R16 | impeccable direction round | Skipped. Your Quiet Ledger choice is the pinned direction. W2-08 runs `shape`, `critique`, `polish` and `audit` inside it. Say "run the round" to get cards and comps instead. | The skill: a user-pinned direction beats the roll. |
| R17 | Tracker and dashboard | In scope as W2-11: `applied` / `withdrawn` statuses, a follow-up date, and the Home page. | Your requirement was a status view of what's done, pending and next. |
| R18 | Next slices | Email (S2) starts after S1 acceptance, then Social and blog (S3). Each starts with `feature-dev` (explore, architect) and `deep-research` on its connectors. Email uses a Gmail `readonly` mail worker and brings the parked decider back. Before S2 touches real mail: the backup milestone from plan-review (`brain.db` and the vault, with a restore test). | `master.md` is in a local git repo, but `brain.db` has no backup today. |
| R19 | Existing vault | Manual steps for you are in `docs/debt.md` ("If you already use a Week 1 vault"). | `vault:init` never overwrites existing files. |
| R20 | Wave order | Wave 2: W2-03…06 (4 parallel sessions). Wave 3: W2-07. Wave 4: W2-08 and 09. Wave 5: W2-10 and 11. Wave 6: W2-12. A live run (UAT) after every wave. | Week 1 retro. |

## 8. Needs from you
Only you can supply these. None blocks Wave 2 except where marked.
1. **Run `pnpm smoke`** on your Windows machine (blocks W2-05 and W2-07; R4).
2. **Request the LinkedIn export** with the six categories and drop the files in `dataDir/career/import/` (needed for W2-04 acceptance; R5).
3. **Tell me the language(s) of your LinkedIn profile** (English, German or both). Default: English (R11).
4. **Your Word CV** for W2-09: I'll give you the tag list to add to a copy, or you start from the starter template.
5. **Two or three real job postings** for UAT in Wave 5, kept outside the repo.
6. **Update your existing vault** (R19) and run `pnpm vault:init`.
7. **OK to create the GitHub issues** for W2-03…W2-12 in your private repo and add them to the Project (shared state, so I'm asking).
