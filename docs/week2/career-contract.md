# Career contract (W2-03 … W2-10)

The shapes every Wave 2–5 ticket builds against, so the sessions can run in parallel. Plan: [implementation-plan.md](implementation-plan.md). Same rule as Week 1: if you change a shape, edit this file **in the same PR** and tell the sibling sessions.

## 1. Rules
- **API:** everything is under `/api` behind the `aos_session` cookie. State-changing requests need `Origin` = the app origin **and** `X-AOS: 1` (see [api-contract.md](../week1/api-contract.md)). Errors are `{ "error": "<code>" }` where `<code>` is a **fixed string from §8**, never model, posting or CV text.
- **Privacy:** no prompt, log line, error message, `jobs.payload`, `jobs.error`, `llm_calls.error` or audit `args` contains posting text, CV text or contact values. Payloads carry **ids only**. The text lives in `application_texts` (§5).
- **Never throw text:** throw only typed errors with fixed messages. Never wrap a Zod error (its message can quote the input).
- **Verifier failures are results, not exceptions** (§6), so job retries can't multiply them.
- **Times** are ISO-8601 UTC strings. **Ids** (`^id`) match `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`, ≤ 64 chars.
- **Test data** committed to the repo is synthetic (`server/test/fixtures/career/`). Your real CV and postings stay outside the repo (CLAUDE.md rule 4).

## 2. Files

| Path | Owner | Content |
|---|---|---|
| `vault/career/master.md` | you (user-owned after approval) | The master CV (§3.1) |
| `vault/career/contact.md` | you (user-owned after approval) | Contact details (§3.2) |
| `dataDir/career/import/` | you | LinkedIn export CSVs, dropped here |
| `dataDir/career/template.docx` | you | Your Word CV template |
| `dataDir/career/letter-template.docx` | you, optional | Cover-letter template. If absent, a plain built-in layout is used. |
| `dataDir/career/out/<applicationId>/` | the app | Generated `cv.docx`, `cv.pdf`, `letter.docx`, `letter.pdf`. Never in the vault, never in git. |

## 3. File formats

### 3.1 `career/master.md`
Standard vault frontmatter (`id: career-master`, `area: career`, `sensitivity: 2`, `source`, `created`, `updated`). The body is a strict grammar. Anything else is a parse error and the file is not used.

```md
## Summary
- Backend engineer focused on data pipelines.  ^sum-1

## Experience
### Acme GmbH | Senior Engineer | 2021-03 | 2024-06 | Berlin  ^exp-acme-2021
- Cut the nightly build from 12 to 4 minutes.  ^exp-acme-2021-3f9a1c
- Led a team of 4 engineers.  ^exp-acme-2021-b27e04

## Education
### TU Berlin | MSc Cybersecurity | 2024-10 | present | Berlin  ^edu-tu-berlin-2024
- Thesis on injection defences.  ^edu-tu-berlin-2024-91c0de

## Skills
- Python  ^skill-python
- PostgreSQL  ^skill-postgresql

## Languages
- German (C1)  ^lang-german
```

- Sections are fixed and optional: `Summary`, `Experience`, `Education`, `Skills`, `Languages`, `Projects`, `Certifications`.
- Entry header: `### <org> | <title> | <start> | <end or "present"> | <location>  ^<entry-id>`. Dates are `YYYY` or `YYYY-MM`.
- Bullets end with two spaces and ` ^<id>`, the same convention as persona statements (`review-contract.md`).
- **Ids:** entry id = `exp-`/`edu-`/`prj-`/`crt-` + slug(org, ≤ 20 chars) + `-` + start year (suffix `-2`, `-3` on a clash). Bullet id = entry id + `-` + first 6 hex of sha256(lower-cased trimmed text), truncated so the whole id stays ≤ 64. Ids are unique across the file.
- The import never rewrites ids once the file exists. Edits in Obsidian keep whatever id the line has.
- **No contact values** in this file (§3.2 is the only place).

### 3.2 `career/contact.md`
Frontmatter fields only: `name`, `email`, `phone`, `address`, `url` (all strings, optional), `dob` (`YYYY-MM-DD`, optional), plus the standard keys with `sensitivity: 2`. Body empty.

### 3.3 Placeholders
`{{CONTACT_NAME}}`, `{{CONTACT_EMAIL}}`, `{{CONTACT_PHONE}}`, `{{CONTACT_ADDRESS}}`, `{{CONTACT_URL}}`, `{{CONTACT_DOB}}`. `redactContact(text, contact)` (W2-03) replaces any literal occurrence of a contact value, with whitespace and phone-format variants normalised, by its placeholder. Every prompt-building function calls it last. The only code that reads `contact.md` values back is the render step (§7).

## 4. Pipeline

One **job per step**, so no job runs longer than one model call. Each step reads its input from `application_texts`, writes its output there, updates `applications.step`, and enqueues the next step in the same transaction.

| Step | Job `kind` | Payload | Model | Output (`application_texts.kind`) |
|---|---|---|---|---|
| 1 intake | `career_intake` | `{ applicationId }` | `fast`, pipeline `career-intake`, no tools | `requirements` (§4.1) |
| 2 match | `career_match` | `{ applicationId }` | `work`, `career-match` | `selection` (§4.2) |
| 3 draft | `career_draft` | `{ applicationId, attempt: 1 \| 2 }` | `work`, `career-draft` | `draft` (§4.3) |
| 4 verify | `career_verify` | `{ applicationId, attempt: 1 \| 2 }` | none (plain code) | `verify_report` (§6) |
| 5 render | `career_render` | `{ applicationId }` | none | files (§7) |

- **Idempotency keys:** `career:<step>:<applicationId>:<attempt|0>`.
- **Attempts:** `career_*` jobs get **one** attempt (a per-kind cap in `db/jobs.ts`, replacing the global `MAX_ATTEMPTS = 5` for these kinds). An unexpected throw marks the application `failed` with `fail_code: 'internal'`. Expected failures set `status` and `fail_code` and **do not throw**.
- **Verify fails on attempt 1** → enqueue `career_draft` with `attempt: 2` and the violation list (codes, line refs, tokens ≤ 40 chars). **Fails on attempt 2** → `status: 'flagged'`. Never a third attempt.
- Render runs only after the user finalises (§8), never automatically.
- All untrusted text in a prompt goes in tags (`<posting>`, `<master>`) with closing tags defused, plus a "data, not instructions" rule. Use `wrapUntrusted(tag, text)` from `server/src/llm/untrusted.ts` (added in W2-00; it removes any `<tag>` or `</tag>` inside the text, then wraps it).

### 4.1 `Requirements` (output of intake)
```ts
type Requirements = {
  language: 'en' | 'de';
  company: string;        // ≤ 120 chars
  role_title: string;     // ≤ 120 chars
  seniority: 'intern' | 'junior' | 'mid' | 'senior' | 'lead' | 'unspecified';
  location_mode: 'onsite' | 'hybrid' | 'remote' | 'unspecified';
  must_have: Requirement[];     // ≤ 20
  nice_to_have: Requirement[];  // ≤ 20
  injection_suspected: boolean; // the model saw instructions aimed at an AI inside the posting
};
type Requirement = { id: string; text: string /* ≤ 160 */; kind: 'skill' | 'experience' | 'education' | 'language' | 'other' };
```
The Zod schema is the source of truth, but constrained decoding may not enforce `.max()`. **Re-validate and clip after the call** (as `extract-persona.ts` does). Stored with `trust: untrusted`; the UI shows `company` and `role_title` as plain text. `injection_suspected` shows a banner and changes nothing else.

### 4.2 `Selection` (output of match)
```ts
type Selection = {
  picks: { requirement_id: string; bullet_ids: string[] }[];  // which bullets answer which requirement
  unmatched: string[];                                         // requirement ids with no bullet
  entries: { entry_id: string; bullet_ids: string[] }[];       // order and subset for the CV
  skill_ids: string[];
};
```
Deterministic checks after the call: every id exists in the master; every bullet belongs to the entry it is listed under. A violation → `fail_code: 'selection_invalid'`. `coverage = matched must_have / total must_have`, computed by code, shown on the page.

### 4.3 `Draft` (output of draft)
```ts
type Line = { text: string; cites: string[] };  // cites: 1–5 bullet or skill ids
type Draft = {
  summary: Line | null;                          // text ≤ 300
  entries: { entry_id: string; bullets: Line[] }[];  // each text ≤ 300
  skill_ids: string[];
  letter: { paragraphs: Line[] };                // 3–5 paragraphs, each text ≤ 700
  versions: number;                              // increases on each user edit (§8)
};
```
**Employer, title, dates and location are never model output.** The render step copies them from the master by `entry_id`. Contact values appear only as placeholders (§3.3).

## 5. Database: migration `0005_career.sql`
Committed by the coordinator before Wave 2 starts, so sessions don't collide. Conventions follow `0001_init.sql`.

```sql
CREATE TABLE applications (
  id           INTEGER PRIMARY KEY,
  company      TEXT,
  role_title   TEXT,
  language     TEXT CHECK (language IN ('en', 'de')),
  status       TEXT NOT NULL DEFAULT 'processing'
               CHECK (status IN ('processing', 'draft_ready', 'flagged', 'failed', 'final', 'applied', 'withdrawn')),
  step         TEXT CHECK (step IN ('intake', 'match', 'draft', 'verify', 'render')),
  fail_code    TEXT,
  master_hash  TEXT NOT NULL,   -- sha256 of master.md when the run started
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX applications_status_updated ON applications (status, updated_at);

CREATE TABLE application_texts (
  application_id INTEGER NOT NULL REFERENCES applications(id),
  kind           TEXT NOT NULL CHECK (kind IN ('posting', 'requirements', 'selection', 'draft', 'verify_report')),
  version        INTEGER NOT NULL DEFAULT 1,
  body           TEXT NOT NULL,   -- raw text for 'posting', JSON for the rest
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (application_id, kind, version)
);

CREATE TABLE application_files (
  id             INTEGER PRIMARY KEY,
  application_id INTEGER NOT NULL REFERENCES applications(id),
  kind           TEXT NOT NULL CHECK (kind IN ('cv_docx', 'cv_pdf', 'letter_docx', 'letter_pdf')),
  relpath        TEXT NOT NULL,   -- relative to dataDir/career/out
  sha256         TEXT NOT NULL,
  bytes          INTEGER NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (application_id, kind)
);

CREATE TABLE application_events (
  id             INTEGER PRIMARY KEY,
  application_id INTEGER NOT NULL REFERENCES applications(id),
  ts             TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  kind           TEXT NOT NULL CHECK (kind IN ('created', 'step', 'failed', 'retry', 'edited', 'final', 'rendered')),
  detail         TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(detail))   -- ids, counts, codes only
);
CREATE TRIGGER application_events_no_update BEFORE UPDATE ON application_events BEGIN SELECT RAISE(ABORT, 'application_events is append-only'); END;
CREATE TRIGGER application_events_no_delete BEFORE DELETE ON application_events BEGIN SELECT RAISE(ABORT, 'application_events is append-only'); END;
```
- **Applications are never deleted in v1** (the append-only trigger would block a cascade). `withdrawn` is the end state. A purge ticket comes later.
- `applied` and `withdrawn` are reserved for the tracker. No v1 code sets them.
- Update `server/test/db.test.ts` (it pins `user_version` and the table list).

## 6. Verifier (plain code, no model)
Runs in `career_verify`. Input: `Draft`, the master, `Requirements`. Output stored as `verify_report`:
```ts
type VerifyReport = { ok: boolean; violations: { code: ViolationCode; ref: string; token?: string /* ≤ 40 chars */ }[] };
type ViolationCode = 'unknown_cite' | 'wrong_entry' | 'missing_cite' | 'unsupported_number' | 'unsupported_entity'
                   | 'contact_leak' | 'bad_placeholder' | 'too_long' | 'too_many_lines';
```
`ref` is a line reference: `cv.summary`, `cv.entries.<entry_id>.<index>`, `letter.<index>`.

| Rule | Code |
|---|---|
| Every line has 1–5 `cites`, and every cite exists in the master | `missing_cite`, `unknown_cite` |
| A CV bullet's cites belong to the entry it is listed under | `wrong_entry` |
| **Numbers** (`\d+(?:[.,]\d+)*%?`, decimal comma normalised) in a line all appear in the text of its cited bullets | `unsupported_number` |
| **Entities** in a line all appear in its cited text. Entities are: acronyms (≥ 2 capitals), tokens with a digit or an inner capital or `+ # .` (`C++`, `Node.js`, `PostgreSQL`), and, **for `en` only**, capitalised words that are not sentence-initial. German capitalises all nouns, so it uses the first three kinds only. Comparison is case-insensitive on whole tokens split on spaces and hyphens. | `unsupported_entity` |
| Letter paragraphs may additionally use the posting's `company` and `role_title` | (allowed set) |
| No email, phone or URL pattern anywhere in the draft | `contact_leak` |
| `{{...}}` only in the six known placeholders | `bad_placeholder` |
| Summary ≤ 300, bullet ≤ 300, letter paragraph ≤ 700 chars; ≤ 18 CV bullets; letter 3–5 paragraphs | `too_long`, `too_many_lines` |

**Known limit:** the verifier can't catch exaggeration by wording ("led" for "helped"), and thresholds will need tuning on the golden set (W2-10), especially for German inflections. The user's review is the last check.

## 7. Render (`career_render`)
- Data passed to the template (the template syntax belongs to W2-09 and its library):
```ts
type RenderModel = {
  contact: { name?: string; email?: string; phone?: string; address?: string; url?: string; dob?: string };  // from contact.md only here
  summary: string | null;
  entries: { section: 'experience' | 'education' | 'projects' | 'certifications'; org: string; title: string; start: string; end: string; location: string; bullets: string[] }[];  // org/title/dates copied from the master by entry_id
  skills: string[]; languages: string[];
  letter: { company: string; role_title: string; date: string; paragraphs: string[] };
};
```
- Placeholders in the final text are replaced by the contact values at this step only.
- **PDF through Word:** `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/word-export.ps1 -In <docx> -Out <pdf>`. Both paths must resolve inside `dataDir/career/out/`, arguments are passed as an array (no shell string), Word runs hidden with alerts off, a 60 s timeout kills the process, and a hung Word never blocks the docx.
- After rendering: a page-count check (CV ≤ 2 pages by default, shown as a warning, not a failure).
- Failure → `fail_code: 'render_failed'`, status stays `final`, the draft is untouched, and `POST …/render` retries.

## 8. HTTP API

### 8.1 Master import (W2-04)
| Method & path | Body | Response |
|---|---|---|
| `POST /api/career/master/import` | — | Reads the CSVs in `dataDir/career/import/`, builds `master.md` + `contact.md`, and creates a `career_master_import` approval. `201 { approval_id }`. `409 master_exists` if `career/master.md` already exists. `400 import_empty` if no recognised file. |

**v1 imports from the LinkedIn CSVs only**: `Profile.csv`, `Positions.csv`, `Education.csv`, `Skills.csv`, `Languages.csv`, `Certifications.csv`. These are the usual names in the export; W2-04 checks them against a real export. Your Word CV is the output template (§2), not an import source.

**Approval row** (`review-contract.md` gets a matching row in the same PR):

| `action_type` | Producer | `payload` | `original_text` | On approve |
|---|---|---|---|---|
| `career_master_import` | W2-04 | `{ master: string, contact: string, source_files: string[], master_hash_before: string \| null, contact_hash_before: string \| null, stats: { entries: number, bullets: number, skills: number } }` | `null` (not editable in the queue; edit in Obsidian afterwards) | Write `career/master.md` and `career/contact.md` inside the approval's transaction, hash-checked against `*_hash_before` (mismatch → `409`, stays pending), `vault_notes.last_written_by='user'`, vault git commit. Reject writes nothing. **Never expires** (add to the exemption in `approvals/expire.ts`). One pending import at a time: a new import replaces the pending payload. |

Web: add the case to the `Approval` union in `web/src/api.ts` and to `ApprovalCard.vue` (title + counts + a `<pre>` preview of `master`, text only).

### 8.2 Applications (W2-06, W2-07, W2-08, W2-09)
| Method & path | Body | Response |
|---|---|---|
| `POST /api/career/applications` | `{ posting: string }` (1–30 000 chars) | `202 ApplicationSummary` with `status:'processing', step:'intake'`. `409 provider_not_configured`, `409 master_missing`, `400 posting_too_long`. |
| `GET /api/career/applications` | — | `ApplicationSummary[]`, newest first, max 100 |
| `GET /api/career/applications/:id` | — | `ApplicationDetail` (`404 not_found`) |
| `PATCH /api/career/applications/:id/draft` | `{ edits: { ref: string; text: string }[] }` (1–50 edits, each text ≤ 700) | `ApplicationDetail`. `409 wrong_status` unless `draft_ready` or `flagged`. `400 bad_ref`. |
| `POST /api/career/applications/:id/final` | `{ acknowledge_flagged?: boolean }` | `202 ApplicationDetail` with `status:'final', step:'render'`. `409 flagged_not_acknowledged` when `flagged` and not acknowledged. |
| `POST /api/career/applications/:id/render` | — | `202`. Retries a failed render. `409 wrong_status` unless `final`. |
| `GET /api/career/applications/:id/files/:kind` | — | The file (`kind` ∈ `cv_docx`, `cv_pdf`, `letter_docx`, `letter_pdf`). `404 not_found` / `409 files_not_ready`. |

**Polling:** the UI polls `GET …/:id` every 1.5 s while `status` is `processing` or `step` is `render`, and stops on any other state. There is no SSE and no generic jobs API.

**Download headers:** `Content-Disposition: attachment; filename="<fixed ASCII name>"`, a fixed content type (`application/vnd.openxmlformats-officedocument.wordprocessingml.document` or `application/pdf`), `Cache-Control: no-store`. The file is looked up **by database id**, never by a client path. The global CSP is **not** loosened, so there is no in-browser PDF preview.

**Edits:** each edit replaces one line's `text` (cites unchanged), bumps `draft.versions`, writes a new `application_texts` row (`version + 1`), and adds an `edited` event with `{ lines, edit_distance }` (mean normalised Levenshtein per edited line). User-edited lines are not re-verified; they are yours.

```ts
type ApplicationStatus = 'processing' | 'draft_ready' | 'flagged' | 'failed' | 'final' | 'applied' | 'withdrawn';
type ApplicationStep = 'intake' | 'match' | 'draft' | 'verify' | 'render';
type ApplicationSummary = {
  id: number; company: string | null; role_title: string | null; language: 'en' | 'de' | null;
  status: ApplicationStatus; step: ApplicationStep | null; fail_code: FailCode | null;
  created_at: string; updated_at: string;
};
type ApplicationDetail = ApplicationSummary & {
  requirements: Requirements | null;
  coverage: { matched: number; total: number } | null;
  draft: Draft | null;
  edited_refs: string[];                 // lines the user changed
  verify: VerifyReport | null;
  sources: Record<string, string>;       // cite id -> master text (bullets and skills), so the page can show each line's source
  files: { kind: 'cv_docx' | 'cv_pdf' | 'letter_docx' | 'letter_pdf'; bytes: number }[];
};
```

### 8.3 Errors
Fixed codes only: `provider_not_configured`, `master_missing`, `master_exists`, `import_empty`, `posting_too_long`, `not_found`, `wrong_status`, `bad_ref`, `flagged_not_acknowledged`, `files_not_ready`.

`FailCode` (stored in `applications.fail_code`): `provider_error`, `selection_invalid`, `no_match` (nothing selected), `verify_failed`, `render_failed`, `internal`.

## 9. Audit
Through `audit()`, with ids, counts and codes only (the redaction there works by key name, so **never** put text in `args`):

`career.master_import.propose`, `career.application.create`, `career.application.step`, `career.application.fail`, `career.application.edit`, `career.application.final`, `career.file.download`. Approving the import is already audited by `approval.approve`.

## 10. Tests every ticket brings
| Ticket | Must prove |
|---|---|
| W2-03 | A fake `llm` captures the final prompt of every step; no contact value appears (inject `llm` as a dependency whose default is `structured`, as the removed `categorizeSession` did: `git show fe1b1dd:server/src/jobs/categorize-session.ts`). Variants: phone with spaces, e-mail in a different case. |
| W2-04 | Parse → serialise round-trips `master.md`; ids are stable; a bad grammar is rejected; approval writes both files hash-checked; the import approval doesn't expire; a second import returns `master_exists`. |
| W2-05 | 5 injection-canary postings (`server/test/fixtures/career/canary-*.txt`) produce a valid `Requirements`, `injection_suspected` where applicable, and no other change. Closing tags in the posting are defused. |
| W2-06 | `career_*` jobs run once; an unexpected throw sets `failed/internal`; `jobs.error` contains no posting text; a `categorize_session` job enqueued during a run starts before the run's next step. |
| W2-07 | Each verifier rule, one fixture each; attempt 2 then `flagged`; no third attempt; the audit and event rows contain no text. |
| W2-08 | Edits, `flagged` acknowledgement, polling states; all text rendered as text (no `v-html` on raw text). |
| W2-09 | Placeholders replaced only at render; the download route serves by id, wrong kind → 404, headers as in §8.2; the Word step times out cleanly. |
| W2-10 | The golden set (synthetic fixtures committed; your real postings run from `dataDir`) reports 0 unsupported claims; the `career-tailor` suite reuses `eval_cases` / `eval_runs`. |

## 11. File ownership (to avoid conflicts, as in Week 1)
| Ticket | Owns |
|---|---|
| W2-00 | Everything removed in the plan's "Cleanup decision"; `server/src/llm/untrusted.ts`; `web/src/App.vue`, `router.ts`, `style.css` and the shell nav; `package.json` scripts; `README.md`; the `Approval` union is reduced to `vault_conflict` (W2-04 adds `career_master_import`) |
| W2-03 | `server/src/career/redact.ts` + test |
| W2-04 | `server/src/career/{master,linkedin}.ts`, `routes/career-master.ts`, the `career_master_import` branch in `approvals/apply.ts`, the exemption in `approvals/expire.ts`, `web` `Approval` union and `ApprovalCard.vue`, `review-contract.md` row, `VAULT_FOLDERS` + template "Folders" line |
| W2-05 | `server/src/career/intake.ts`, `jobs/career-intake.ts`, canary fixtures |
| W2-06 | `db/jobs.ts` (per-kind attempts), `routes/career.ts` (endpoints in §8.2 except files), `web/src/stores/career.ts`, the career section of `web/src/api.ts` |
| W2-07 | `jobs/career-{match,draft,verify}.ts`, `server/src/career/verify.ts`, prompts |
| W2-08 | `web/src/views/ApplicationView.vue`, `web/src/components/*` for it, router entry |
| W2-09 | `jobs/career-render.ts`, `scripts/word-export.ps1`, the files route |
| Shared, mechanical | `main.ts` plugin and handler lines, `pnpm-lock.yaml`, `CLAUDE.md` Lessons: resolve on merge, as in Week 1 |

## 12. Open items (decide at ticket time)
1. **Word `.docx` as an import source** (bullets from your Word CV) is not in v1. LinkedIn CSV is the only automatic source. If your Word CV has better bullets than LinkedIn, say so and I'll add an import path.
2. **Letter template:** do you have a separate Word cover-letter template? If not, the built-in plain layout is used.
3. **Re-importing** after you've edited `master.md` is not supported in v1 (`master_exists`). Edit the file in Obsidian.
4. **docx and CSV libraries** aren't chosen. Each must be pure JS or a prebuilt binary (CLAUDE.md rule 6) and have its licence checked in the ticket.
5. **Whether 9router honours `output_config`** is covered by `pnpm smoke`. Run it before W2-05.
