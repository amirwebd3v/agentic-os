# Review-queue contract (W1-10 ⇄ W1-11, W1-12 later)

The `approvals` table (migration `0001`) is the only hand-off between the parts that **propose** things and the review queue that **applies** them. Producers insert `status='pending'` rows; only W1-11's `apply` code changes state. If you change a payload, edit this file in the same PR and tell the sibling session.

## Row
`approvals(id, action_type, payload JSON, proposed_by, status 'pending'|'approved'|'rejected'|'expired', created_at, decided_at, original_text, final_text, edit_distance)`

## Action types
| `action_type` | Producer | `payload` | `original_text` | On approve (W1-11) |
|---|---|---|---|---|
| `propose_category` | W1-10 | `{ slug, name, description, reason, parent_slug: string \| null, session_ids: number[] }` | `description` | See below |
| `vault_conflict` | W1-08 (merged) | `{ path, current_hash, content }` | — | Overwrite `path` with `content`, but only if the file's hash still equals `current_hash`; otherwise refresh the conflict. On reject, keep the user's file and record its hash in `vault_notes` as `last_written_by='user'`. Never expires. |
| `career_master_import` | W2-04 | `{ master, contact, source_files: string[], master_hash_before: string \| null, contact_hash_before: string \| null, stats: { entries, bullets, skills } }` ([career-contract](../week2/career-contract.md) §8.1) | — | Write `career/master.md` and `career/contact.md` in the approval's transaction, each hash-checked against its `*_hash_before` (a file that already holds the proposed text also passes, so a half-applied write can be retried; otherwise `409`, stays pending), with `vault_notes.last_written_by='user'` and a vault commit. Reject writes nothing. One pending at a time: a new import replaces the payload. Never expires. |
| `persona_statement` | W1-12 | `{ question_id, topic, question, statement, in_my_words }` (`question` is the bank text, for display) | `statement` | Append `- <final statement>  ^<question_id>` to `persona/<topic>.md` (created with `sensitivity: 1` frontmatter) and tick the question in `persona/_questions.md`, both hash-checked like `CLAUDE.md`. Reject leaves the question unticked, so it can be asked again. |

## `propose_category` approval
1. Insert the area as `status='active'`, `created_by='user'`, with `parent_id` taken from `parent_slug`. Use the payload's `slug` as-is. **W1-10 makes the slug** (lowercase, `a-z0-9-`, unique against `areas.slug`), so W1-11 never slugifies.
2. For a **top-level** area, append ``- `<slug>` | <name> | do | <description>`` (the line format `parseAreas` reads; any other format stops the boot sync) to the `## Areas` list of the vault's `CLAUDE.md`, so a later boot sync keeps it. `CLAUDE.md` is user-owned and untracked, so `createWriter.writeNote` would only raise a `vault_conflict`. Instead, W1-11 writes it hash-checked (temp file + rename inside the approval's transaction), keeps `vault_notes.last_written_by='user'`, and skips the append when the slug is already listed. If `CLAUDE.md` is missing or malformed, the approval fails and stays `pending`.
3. Re-file every session in `session_ids` that's still `filing_status='inbox'` by calling `enqueue(db, 'categorize_session', 'recategorize:<sessionId>:<approvalId>', { sessionId, upToMessageId })`, where `upToMessageId` is that session's latest message id. W1-10's job handler does the rest.
4. **Reject** leaves those sessions in `inbox`.

## Producer rules (W1-10)
- **One pending proposal per slug.** If one already exists, append the session to its `session_ids` instead of inserting a second row.
- Every decision is audited (`audit()`): `approval.propose` by the producer, and `approval.approve` / `approval.reject` / `approval.expire` by W1-11.

## Edit before approve
`final_text` is the user's edited text, and `edit_distance` is normalized Levenshtein between `original_text` and `final_text` (0 = unchanged, 1 = rewritten). For `propose_category`, the edited text replaces the description.
