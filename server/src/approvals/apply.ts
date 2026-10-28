import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Database } from 'better-sqlite3';
import { z } from 'zod';
import { audit } from '../db/audit.ts';
import { resolveNotePath, sha256 } from '../vault/writer.ts';
import { editDistance } from './edit-distance.ts';

export type Decision = 'approve' | 'reject';

/** A decision that can't be applied; `status` is the HTTP code the route sends. */
export class ApprovalError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

interface ApprovalRow {
  id: number;
  action_type: string;
  payload: string;
  status: string;
  original_text: string | null;
}

const MAX_TEXT = 2000;
const ConflictPayload = z.object({ path: z.string().min(1), current_hash: z.string().nullable(), content: z.string() });
const ImportPayload = z.object({
  master: z.string(),
  contact: z.string(),
  master_hash_before: z.string().nullable(),
  contact_hash_before: z.string().nullable(),
});

/** Writes `text` beside `abs` and fsyncs it; the caller renames it into place as the last step of its transaction. */
function stage(abs: string, text: string): string {
  mkdirSync(dirname(abs), { recursive: true });
  const tmp = `${abs}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, 'wx');
  try {
    writeFileSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return tmp;
}

const fileHash = (abs: string): string | null => (existsSync(abs) ? sha256(readFileSync(abs)) : null);

/**
 * Applies one decision atomically: the status change, the audit entry and every DB side effect commit together,
 * and a vault file is renamed into place inside that transaction, so a failed write leaves the row `pending`.
 * Returns the vault path(s) written, one per line, if any, so the caller can commit them to the vault's git.
 */
export function decide(
  db: Database,
  vaultDir: string,
  id: number,
  decision: Decision,
  finalText?: string,
): { status: 'approved' | 'rejected'; wrote: string | undefined } {
  const row = db.prepare('SELECT id, action_type, payload, status, original_text FROM approvals WHERE id = ?').get(id) as
    | ApprovalRow
    | undefined;
  if (!row) throw new ApprovalError(404, 'not found');
  if (row.status !== 'pending') throw new ApprovalError(409, `already ${row.status}`);
  if (finalText !== undefined && (decision === 'reject' || row.original_text === null)) {
    throw new ApprovalError(400, 'final_text only applies when approving an editable proposal');
  }
  // Levenshtein is O(n·m) and original_text comes from a model: cap it like final_text.
  if (finalText !== undefined && row.original_text!.length > MAX_TEXT) throw new ApprovalError(400, 'this proposal is too long to edit');
  const status = decision === 'approve' ? 'approved' : 'rejected';
  const final = decision === 'approve' && row.original_text !== null ? (finalText ?? row.original_text) : null;
  const distance = final === null ? null : editDistance(row.original_text!, final);

  const staged: string[] = [];
  let wrote: string | undefined;
  let effect = () => {};
  const payload: unknown = JSON.parse(row.payload);
  const upsertNote = db.prepare(
    `INSERT INTO vault_notes (path, content_hash, last_written_by) VALUES (?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET content_hash = excluded.content_hash, last_written_by = excluded.last_written_by`,
  );

  // Every staged temp file is removed on the way out, whatever throws, so `git add -A` never commits one.
  try {
    // Payloads are parsed strictly only to approve: a malformed one (a producer bug) must still be rejectable.
    if (row.action_type === 'vault_conflict' && decision === 'approve') {
      const p = ConflictPayload.parse(payload);
      const abs = resolveNotePath(vaultDir, p.path);
      const current = fileHash(abs);
      if (current !== p.current_hash) {
        // Edited again since the conflict was raised: show the new state instead of clobbering it.
        db.prepare('UPDATE approvals SET payload = ? WHERE id = ?').run(JSON.stringify({ ...p, current_hash: current }), id);
        throw new ApprovalError(409, 'the file changed since this conflict was raised; review it again');
      }
      const tmp = stage(abs, p.content);
      staged.push(tmp);
      wrote = p.path;
      effect = () => {
        if (fileHash(abs) !== p.current_hash) throw new ApprovalError(409, 'the file changed during the write; review it again');
        upsertNote.run(p.path, sha256(p.content), 'app');
        renameSync(tmp, abs); // throws → everything rolls back
      };
    } else if (row.action_type === 'vault_conflict') {
      // Keep the user's file and make it theirs, so the writer won't overwrite it without asking again.
      const p = ConflictPayload.safeParse(payload);
      if (p.success) {
        const { path } = p.data;
        const current = fileHash(resolveNotePath(vaultDir, path));
        effect = () => {
          if (current) upsertNote.run(path, current, 'user');
          else db.prepare(`UPDATE vault_notes SET last_written_by = 'user' WHERE path = ?`).run(path);
        };
      }
    } else if (row.action_type === 'career_master_import' && decision === 'approve') {
      // Both files become the user's (contract §8.1). A file already holding the proposed text counts as unchanged,
      // so a retry after a half-applied write (first rename done, then a throw) can finish instead of 409ing forever.
      const p = ImportPayload.parse(payload);
      const files = (
        [
          ['career/master.md', p.master, p.master_hash_before],
          ['career/contact.md', p.contact, p.contact_hash_before],
        ] as const
      ).map(([path, text, before]) => {
        const abs = resolveNotePath(vaultDir, path);
        const unchanged = () => [before, sha256(text)].includes(fileHash(abs));
        if (!unchanged()) throw new ApprovalError(409, `${path} changed since the import; reject this and import again`);
        return { path, text, abs, unchanged, tmp: '' };
      });
      for (const f of files) staged.push((f.tmp = stage(f.abs, f.text)));
      wrote = files.map((f) => f.path).join('\n');
      effect = () => {
        for (const f of files) {
          if (!f.unchanged()) throw new ApprovalError(409, `${f.path} changed during the write; reject this and import again`);
          upsertNote.run(f.path, sha256(f.text), 'user');
          renameSync(f.tmp, f.abs);
        }
      };
    } else if (decision === 'approve') {
      throw new ApprovalError(409, `this version can't approve ${row.action_type}; reject it to clear it`);
    }

    db.transaction(() => {
      const changed = db
        .prepare(
          `UPDATE approvals SET status = ?, decided_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), final_text = ?, edit_distance = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .run(status, final, distance, id).changes;
      if (changed !== 1) throw new ApprovalError(409, 'already decided');
      audit(db, {
        actor: 'user',
        action: `approval.${decision}`,
        args: { id, action_type: row.action_type, edit_distance: distance },
        decision: status,
        approver: 'user',
      });
      effect(); // file rename last: if it throws, nothing above is kept
    })();
    // ponytail: a failed COMMIT after the rename leaves the file written but the row pending; the retry sees the new
    // hash (conflict refreshed, or the area already listed) and recovers. Needs a disk-full at commit time.
  } finally {
    for (const tmp of staged) rmSync(tmp, { force: true });
  }
  return { status, wrote };
}
