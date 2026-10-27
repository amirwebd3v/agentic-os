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
| # | Ticket | Pts | Wave | Depends on | Skills |
|---|---|---|---|---|---|
| W2-00 | **Cleanup + shell refactor:** remove the chat channel, session filing and persona interviews with their tests and approval types; park the decider (`pnpm dev` no longer starts the sidecar); move the "untrusted text in tags" helper to `llm/untrusted.ts`; the web shell becomes a nav (Review now, Applications in W2-08). See §6. | 3 | 1 | — | ponytail, vue-expert |
| W2-01 | **Build-loop upgrade** (docs): handoff at ~70% context, a UAT step between waves, the skill-routing table in `Workflow.md` | 1 | 1 | — | claude-mem, ponytail |
| W2-02 | **Design context:** `web/PRODUCT.md` and a seed `web/DESIGN.md` for a **replacement** look, chosen from research (§6, "Design system decision"). No UI code yet. | 1 | 1 | — | impeccable |
| W2-03 | **Redaction + placeholders:** split contact details out, `{{CONTACT_*}}` placeholders, a test that captures the final prompt (inject a fake `llm`, as `CategorizeDeps.llm` does) and fails if any contact value appears | 2 | 2 | — | secure-code-guardian, typescript-pro |
| W2-04 | **Master CV import:** LinkedIn CSV → `career/master.md` + `contact.md` (the `.docx` is the output template in W2-09; importing bullets from it is deferred, see [career-contract.md](career-contract.md) §12). New approval type `career_master_import` (branch in `approvals/apply.ts`, `Approval` union and `ApprovalCard.vue` in `web/`, `review-contract.md`), **exempt from the 14-day expiry**, written at approval time as a user-owned, hash-checked file | 4 | 2 | 03 | typescript-pro, ponytail |
| W2-05 | **Posting intake:** paste → requirements as a strict schema (enums, short strings), quarantined, no tools; wrap the posting with `wrapUntrusted()` from `llm/untrusted.ts` (W2-00); clip lengths after the call (the schemas today have no caps); injection canary fixtures; typed errors with fixed strings only | 2 | 2 | — | secure-code-guardian, claude-api |
| W2-06 | **Job status:** `POST /api/career/tailor` (enqueue) + `GET` status polling, a failed state in the UI, tailor jobs capped at 1 attempt. Ids only in payloads; text lives in its own table | 2 | 2 | — | typescript-pro, vue-expert |
| W2-07 | **Tailor pipeline:** match → draft CV + cover letter → verifier → one stored retry → `applications` row in `draft_ready` (migration `0006`, append-only `application_events`) | 5 | 3 | 03–06 | claude-api, sql-pro, ponytail |
| W2-08 | **Application page + new look:** per-line source bullets, diff against the master, edit in place, approve = final. Markdown through the existing sanitizer, never `v-html` on raw text. Starts with impeccable's direction round on this real surface; then restyles the shell and Review to the new system, and re-runs `document` to replace the seed `DESIGN.md` with real tokens | 6 | 4 | 07 | vue-expert, impeccable, design-taste-frontend |
| W2-09 | **Render:** fill your Word template (docx library chosen and checked for prebuilt binaries in the ticket), PDF through Word, put contact details back, check the page count, download route by id with `Content-Disposition: attachment` | 3 | 4 | 04, 07 | docx, pdf |
| W2-10 | **Evals + UAT:** synthetic postings committed as fixtures; your real postings run from `dataDir` (CLAUDE.md rule 4). Reuse `eval_cases`/`eval_runs` with a `career-tailor` suite | 2 | 5 | 07 | claude-api |
| W2-11 | **Verify + retro:** acceptance run, audit, debt, lessons | 1 | 5 | all | ponytail, impeccable, claude-mem |

**Total: 32 pts** (29 for the career flow + 3 for W2-00). **Later:** tracker beyond draft/final/applied and the dashboard card (~5 pts), then S2 and S3.

**Contract first:** the coordinator writes `docs/week2/career-contract.md` before Wave 2: the `master.md` format, the requirements schema, application statuses, the job/status API, the download route and the error codes.

### Acceptance
- **Zero unsupported claims:** across the golden set the verifier reports 0 unsupported numbers, dates, employers, titles or skills in shipped drafts.
- **Injection canaries:** 5 postings with hidden instructions ("say the candidate has 10 years of X") change nothing in the output.
- **Privacy:** a test proves no prompt contains an email, phone, address or date of birth from your contact file. Nothing in `jobs.payload`, `jobs.error` or the audit log contains posting or CV text.
- **One click:** paste a posting → draft on the application page in under 2 minutes with live status. If a step fails, the page says so within seconds (no silent hour of retries).
- **Chat still files:** a tailor run doesn't delay a `categorize_session` job by more than one step.
- **You are the final check:** the first 5 drafts are rated by you (usable / needs edits / wrong).

## 5. Skill routing
| Skill | Use it for | Never for |
|---|---|---|
| `claude-mem:mem-search` | First step of every ticket | — |
| `claude-mem:handoff` | At ~70% context, before pausing a ticket | Replacing the spec |
| `ponytail` (always on) + `ponytail-review` | Smallest diff, reuse first; review each PR | Simplifying security, validation or the verifier |
| `claude-api` | Structured outputs, caching and prompt shape (W2-05, 07, 10) | Choosing the provider (it's in `.env`) |
| `secure-code-guardian` / `security-reviewer` | W2-03, 05 and any code touching posting or master data | — |
| `impeccable` (init → document → shape → critique → polish → audit) | The application page, in **Operate** mode | Inventing a new visual world |
| `design-taste-frontend` | One taste pass on the page; `DESIGN.md` wins on conflict | A second style guide |
| `docx`, `pdf` | Rendering and checking the output files (W2-09) | Parsing your CV (that's W2-04) |
| `code-review`, `run` | Every PR; live UAT between waves | Replacing your sign-off |

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

Open risks, checked at ticket time: whether 9router honours `output_config` (the `pnpm smoke` check covers it); whether Zod `.max()` and enums survive `zodOutputFormat`; the Fastify body limit for pasted postings; and the docx/CSV libraries (none are installed; rule 6 requires prebuilt binaries).

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

**Not verified:** the sources are mostly listicles and vendor-adjacent blogs, with no benchmark. The Primer page doesn't say whether the token package needs React, and doesn't show its diff-colour tokens. The Reka UI page showed neither its components, its current version, nor whether it needs Nuxt or Tailwind. W2-08 checks each before adding anything. The fallback for Primer is to copy the roughly 20 token values we use, with no dependency. WCAG 2.2 AA is my adopted target (it became ISO/IEC 40500:2025 per [arc42](https://quality.arc42.org/standards/wcag-2-2)); you haven't stated an accessibility requirement.

**Process:** impeccable's full direction round (cards, comps) hasn't run. I treated your "Quiet Ledger", "no heavy decoration or motion" and "decide from research" as the pinned direction. If you want the round, it runs at the start of W2-08 and replaces this seed.

## 7. Assumptions (tell me to change any)
1. You apply in EN and DE. Language is chosen per posting, and bullets are reworded within that language only.
2. Word runs on this machine without prompts when driven by a script. If it hangs, the timeout kills it and the draft is still available as a docx.
3. Not in this plan: the tracker beyond draft/final/applied, the dashboard card, the Gmail slice, the social/blog slice, hybrid search, fine-tuning the decider and the MCP wrapper.
