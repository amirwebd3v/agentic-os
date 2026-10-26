# Review-queue contract (W1-10 ⇄ W1-11, W1-12 later)

The `approvals` table (migration `0001`) is the only hand-off between the parts that **propose** things and the review queue that **applies** them. Producers insert `status='pending'` rows; only W1-11's `apply` code changes state. If you change a payload, edit this file in the same PR and tell the sibling session.

## Row
`approvals(id, action_type, payload JSON, proposed_by, status 'pending'|'approved'|'rejected'|'expired', created_at, decided_at, original_text, final_text, edit_distance)`

## Action types
| `action_type` | Producer | `payload` | `original_text` | On approve (W1-11) |
|---|---|---|---|---|
| `propose_category` | W1-10 | `{ slug, name, description, reason, parent_slug: string \| null, session_ids: number[] }` | `description` | See below |
| `vault_conflict` | W1-08 (merged) | `{ path, current_hash, content }` | — | Overwrite `path` with `content`, but only if the file's hash still equals `current_hash`; otherwise refresh the conflict. On reject, keep the user's file and record its hash in `vault_notes` as `last_written_by='user'`. Never expires. |
| `persona_statement` | W1-12 (later) | `{ question_id, topic, statement, in_my_words }` | `statement` | Append to `persona/<topic>.md` (W1-12 implements the apply) |

## `propose_category` approval
1. Insert the area as `status='active'`, `created_by='user'`, with `parent_id` taken from `parent_slug`. Use the payload's `slug` as-is. **W1-10 makes the slug** (lowercase, `a-z0-9-`, unique against `areas.slug`), so W1-11 never slugifies.
2. For a **top-level** area, append `- <slug>: <description>` to the `## Areas` list of the vault's `CLAUDE.md` through the W1-08 writer (`createWriter`), so a later boot sync keeps it.
3. Re-file every session in `session_ids` that's still `filing_status='inbox'` by calling `enqueue(db, 'categorize_session', 'recategorize:<sessionId>:<approvalId>', { sessionId, upToMessageId })`, where `upToMessageId` is that session's latest message id. W1-10's job handler does the rest.
4. **Reject** leaves those sessions in `inbox`.

## Producer rules (W1-10)
- **One pending proposal per slug.** If one already exists, append the session to its `session_ids` instead of inserting a second row.
- Every decision is audited (`audit()`): `approval.propose` by the producer, and `approval.approve` / `approval.reject` / `approval.expire` by W1-11.

## Edit before approve
`final_text` is the user's edited text, and `edit_distance` is normalized Levenshtein between `original_text` and `final_text` (0 = unchanged, 1 = rewritten). For `propose_category`, the edited text replaces the description.
