import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Database } from 'better-sqlite3';
import { z } from 'zod';
import { lastMessageId } from '../chat/idle.ts';
import { audit } from '../db/audit.ts';
import { enqueue } from '../db/jobs.ts';
import { parseAreas } from '../vault/areas.ts';
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

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CategoryPayload = z.object({
  slug: z.string().max(64).regex(SLUG),
  name: z.string().min(1).max(100),
  description: z.string().max(2000),
  parent_slug: z.string().nullable(),
  session_ids: z.array(z.number().int()).max(1000),
});
const ConflictPayload = z.object({ path: z.string().min(1), current_hash: z.string().nullable(), content: z.string() });

const oneLine = (s: string) => s.replace(/<!--|-->/g, '').replace(/\s+/g, ' ').trim();

/** Inserts an area line after the last item of `## Areas`, in the `- \`slug\` | Name | mode | description` form `parseAreas` reads. */
export function appendAreaLine(markdown: string, slug: string, name: string, description: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => /^## Areas[ \t]*\r?$/.test(l));
  let last = start;
  for (let i = start + 1; i < lines.length && !lines[i]!.startsWith('## '); i++) if (/^\s*- /.test(lines[i]!)) last = i;
  const eol = lines[last]!.endsWith('\r') ? '\r' : '';
  lines.splice(last + 1, 0, `- \`${slug}\` | ${oneLine(name).replace(/\|/g, '/')} | do | ${oneLine(description) || name}${eol}`);
  return lines.join('\n');
}

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
 * Returns the vault path written, if any, so the caller can commit it to the vault's git.
 */
export function decide(
  db: Database,
  vaultDir: string,
  id: number,
  decision: Decision,
  finalText?: string,
): { status: 'approved' | 'rejected'; wrote?: string } {
  const row = db.prepare('SELECT id, action_type, payload, status, original_text FROM approvals WHERE id = ?').get(id) as
    | ApprovalRow
    | undefined;
  if (!row) throw new ApprovalError(404, 'not found');
  if (row.status !== 'pending') throw new ApprovalError(409, `already ${row.status}`);
  if (finalText !== undefined && (decision === 'reject' || row.original_text === null)) {
    throw new ApprovalError(400, 'final_text only applies when approving an editable proposal');
  }
  const status = decision === 'approve' ? 'approved' : 'rejected';
  const final = decision === 'approve' && row.original_text !== null ? (finalText ?? row.original_text) : null;
  const distance = final === null ? null : editDistance(row.original_text!, final);

  let tmp: string | undefined;
  let wrote: string | undefined;
  let effect = () => {};
  const payload: unknown = JSON.parse(row.payload);

  if (row.action_type === 'vault_conflict') {
    const p = ConflictPayload.parse(payload);
    const abs = resolveNotePath(vaultDir, p.path);
    const upsertNote = db.prepare(
      `INSERT INTO vault_notes (path, content_hash, last_written_by) VALUES (?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET content_hash = excluded.content_hash, last_written_by = excluded.last_written_by`,
    );
    if (decision === 'approve') {
      const current = fileHash(abs);
      if (current !== p.current_hash) {
        // Edited again since the conflict was raised: show the new state instead of clobbering it.
        db.prepare('UPDATE approvals SET payload = ? WHERE id = ?').run(JSON.stringify({ ...p, current_hash: current }), id);
        throw new ApprovalError(409, 'the file changed since this conflict was raised; review it again');
      }
      tmp = stage(abs, p.content);
      wrote = p.path;
      effect = () => {
        if (fileHash(abs) !== p.current_hash) throw new ApprovalError(409, 'the file changed during the write; review it again');
        upsertNote.run(p.path, sha256(p.content), 'app');
        renameSync(tmp!, abs); // throws → everything rolls back
      };
    } else {
      // Keep the user's file and make it theirs, so the writer won't overwrite it without asking again.
      const current = fileHash(abs);
      effect = () => {
        if (current) upsertNote.run(p.path, current, 'user');
        else db.prepare(`UPDATE vault_notes SET last_written_by = 'user' WHERE path = ?`).run(p.path);
      };
    }
  } else if (row.action_type === 'propose_category') {
    const p = CategoryPayload.parse(payload);
    if (decision === 'approve') {
      const description = final ?? p.description;
      const parent = p.parent_slug
        ? (db.prepare(`SELECT id FROM areas WHERE slug = ? AND status = 'active'`).get(p.parent_slug) as { id: number } | undefined)
        : undefined;
      if (p.parent_slug && !parent) throw new ApprovalError(409, `parent area ${p.parent_slug} is not active`);

      let claudeMd: { abs: string; hash: string; text: string } | undefined;
      if (!parent) {
        // Top-level areas live in CLAUDE.md; boot sync archives any it doesn't list. The user owns that file, so it
        // is hash-checked and stays `last_written_by='user'` instead of going through the writer (which would only raise a conflict).
        const abs = resolveNotePath(vaultDir, 'CLAUDE.md');
        const current = readFileSync(abs, 'utf8');
        let listed: boolean;
        try {
          listed = parseAreas(current).some((a) => a.slug === p.slug);
        } catch (err) {
          throw new ApprovalError(409, `fix CLAUDE.md first: ${(err as Error).message}`);
        }
        if (!listed) {
          const text = appendAreaLine(current, p.slug, p.name, description);
          claudeMd = { abs, hash: sha256(current), text };
          tmp = stage(abs, text);
          wrote = 'CLAUDE.md';
        }
      }

      effect = () => {
        db.prepare(
          `INSERT INTO areas (parent_id, slug, name, description, status, created_by) VALUES (?, ?, ?, ?, 'active', 'user')
           ON CONFLICT(slug) DO UPDATE SET status = 'active'`,
        ).run(parent?.id ?? null, p.slug, p.name, description);
        const inbox = db
          .prepare(`SELECT id FROM sessions WHERE filing_status = 'inbox' AND id IN (SELECT value FROM json_each(?))`)
          .all(JSON.stringify(p.session_ids)) as { id: number }[];
        for (const { id: sessionId } of inbox) {
          const upToMessageId = lastMessageId(db, sessionId);
          if (upToMessageId !== null) enqueue(db, 'categorize_session', `recategorize:${sessionId}:${id}`, { sessionId, upToMessageId });
        }
        if (claudeMd) {
          if (fileHash(claudeMd.abs) !== claudeMd.hash) throw new ApprovalError(409, 'CLAUDE.md changed during the write; try again');
          db.prepare(
            `INSERT INTO vault_notes (path, content_hash, last_written_by) VALUES ('CLAUDE.md', ?, 'user')
             ON CONFLICT(path) DO UPDATE SET content_hash = excluded.content_hash, last_written_by = 'user'`,
          ).run(sha256(claudeMd.text));
          renameSync(tmp!, claudeMd.abs);
        }
      };
    }
    // Reject: the sessions stay in the inbox.
  } else if (decision === 'approve') {
    throw new ApprovalError(409, `approving ${row.action_type} is not supported yet`);
  }

  try {
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
  } finally {
    if (tmp) rmSync(tmp, { force: true });
  }
  return wrote ? { status, wrote } : { status };
}
