import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Database } from 'better-sqlite3';
import { z } from 'zod';
import { lastMessageId } from '../chat/idle.ts';
import { BANK_PATH, tickQuestion, TOPICS } from '../chat/modes/persona.ts';
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

const MAX_TEXT = 2000;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CategoryPayload = z.object({
  slug: z.string().max(64).regex(SLUG),
  name: z.string().trim().min(1).max(100),
  description: z.string().max(MAX_TEXT),
  parent_slug: z.string().nullable(),
  session_ids: z.array(z.number().int()).max(1000),
});
const ConflictPayload = z.object({ path: z.string().min(1), current_hash: z.string().nullable(), content: z.string() });
const PersonaPayload = z.object({ question_id: z.string().regex(/^[A-Za-z0-9-]{1,64}$/), topic: z.enum(TOPICS) });

// No `<`/`>`: model text must not open or close the HTML comment `parseAreas` strips.
const oneLine = (s: string) => s.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
/** Blanks comments but keeps line numbers, so a commented-out example item is never the insertion point. */
const maskComments = (s: string) => s.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));

/** Inserts an area line after the last item of `## Areas`, in the `- \`slug\` | Name | mode | description` form `parseAreas` reads. */
function appendAreaLine(markdown: string, slug: string, name: string, description: string): string {
  const lines = markdown.split('\n');
  const masked = maskComments(markdown).split('\n');
  const start = masked.findIndex((l) => /^## Areas[ \t]*\r?$/.test(l));
  let last = start;
  for (let i = start + 1; i < masked.length && !masked[i]!.startsWith('## '); i++) if (/^\s*- /.test(masked[i]!)) last = i;
  const eol = lines[last]!.endsWith('\r') ? '\r' : '';
  lines.splice(last + 1, 0, `- \`${slug}\` | ${oneLine(name).replace(/\|/g, '/')} | do | ${oneLine(description) || oneLine(name)}${eol}`);
  return lines.join('\n');
}

const listedSlugs = (markdown: string): string[] | null => {
  try {
    return parseAreas(markdown).map((a) => a.slug);
  } catch {
    return null;
  }
};

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
    } else if (row.action_type === 'propose_category' && decision === 'approve') {
      const p = CategoryPayload.parse(payload);
      const description = final ?? p.description;
      const parent = p.parent_slug
        ? (db.prepare(`SELECT id FROM areas WHERE slug = ? AND status = 'active'`).get(p.parent_slug) as { id: number } | undefined)
        : undefined;
      if (p.parent_slug && !parent) throw new ApprovalError(409, `parent area ${p.parent_slug} is not active`);

      let claudeMd: { abs: string; hash: string; text: string; tmp: string } | undefined;
      if (!parent) {
        // Top-level areas live in CLAUDE.md; boot sync archives any it doesn't list. The user owns that file, so it
        // is hash-checked and stays `last_written_by='user'` instead of going through the writer (which would only raise a conflict).
        const abs = resolveNotePath(vaultDir, 'CLAUDE.md');
        if (!existsSync(abs)) throw new ApprovalError(409, 'CLAUDE.md is missing; run `pnpm vault:init`');
        const current = readFileSync(abs, 'utf8');
        const slugs = listedSlugs(current);
        if (!slugs) throw new ApprovalError(409, 'fix the "## Areas" list in CLAUDE.md first');
        if (!slugs.includes(p.slug)) {
          const text = appendAreaLine(current, p.slug, p.name, description);
          // Parse it back: whatever the payload holds, the file must list exactly one more area, this one.
          if (listedSlugs(text)?.join() !== [...slugs, p.slug].join()) {
            throw new ApprovalError(400, 'this area can’t be written to CLAUDE.md as proposed');
          }
          claudeMd = { abs, hash: sha256(current), text, tmp: stage(abs, text) };
          staged.push(claudeMd.tmp);
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
          upsertNote.run('CLAUDE.md', sha256(claudeMd.text), 'user');
          renameSync(claudeMd.tmp, claudeMd.abs);
        }
      };
    } else if (row.action_type === 'persona_statement' && decision === 'approve') {
      const p = PersonaPayload.parse(payload);
      const statement = (final ?? '').replace(/\s+/g, ' ').trim();
      if (!statement) throw new ApprovalError(400, 'the statement is empty');
      // Both files are the user's to edit in Obsidian, so they are hash-checked like CLAUDE.md rather than going through the writer.
      const writes: { rel: string; abs: string; hash: string | null; text: string; tmp: string }[] = [];
      const add = (rel: string, abs: string, hash: string | null, text: string) => {
        writes.push({ rel, abs, hash, text, tmp: stage(abs, text) });
        staged.push(writes.at(-1)!.tmp);
      };
      const topicRel = `persona/${p.topic}.md`;
      const topicAbs = resolveNotePath(vaultDir, topicRel);
      // One read per file: the hash checked before the rename is the hash of the text the change was built from.
      const read = (abs: string) => (existsSync(abs) ? readFileSync(abs) : null);
      const before = read(topicAbs);
      const line = `- ${statement}  ^${p.question_id}`;
      // Skipped when this exact line is there: a retry after a half-applied approval must not append twice.
      if (!before?.toString('utf8').split(/\r?\n/).includes(line)) {
        const head = before === null ? `---\nsensitivity: 1\n---\n\n# ${p.topic}\n\n` : before.toString('utf8').replace(/\s*$/, '\n');
        add(topicRel, topicAbs, before && sha256(before), `${head}${line}\n`);
      }
      const bankAbs = resolveNotePath(vaultDir, BANK_PATH);
      const bank = read(bankAbs);
      const ticked = bank && tickQuestion(bank.toString('utf8'), p.question_id);
      if (bank && ticked) add(BANK_PATH, bankAbs, sha256(bank), ticked); // a question deleted from the bank has nothing to tick
      wrote = writes[0]?.rel;
      const keepOwner = db.prepare(
        `INSERT INTO vault_notes (path, content_hash, last_written_by) VALUES (?, ?, 'user')
         ON CONFLICT(path) DO UPDATE SET content_hash = excluded.content_hash`,
      );
      effect = () => {
        for (const w of writes) {
          if (fileHash(w.abs) !== w.hash) throw new ApprovalError(409, `${w.rel} changed during the write; try again`);
          keepOwner.run(w.rel, sha256(w.text));
        }
        // ponytail: two renames aren't atomic together; if the second fails the first stays, and the retry skips the
        // statement already appended (exact-line check) and ticks again. Needs a locked file between two renames.
        for (const w of writes) renameSync(w.tmp, w.abs);
      };
    } else if (row.action_type !== 'propose_category' && decision === 'approve') {
      throw new ApprovalError(409, `approving ${row.action_type} is not supported yet`);
    }
    // Rejecting a category: the sessions stay in the inbox, only the row changes.

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
