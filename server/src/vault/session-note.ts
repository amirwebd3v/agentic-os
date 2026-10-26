import { existsSync, readFileSync, rmSync } from 'node:fs';
import type { Database } from 'better-sqlite3';
import type { SessionFiling } from '../chat/filing-schema.ts';
import { resolveNotePath, sha256 } from './writer.ts';
import type { createWriter } from './writer.ts';

type Writer = ReturnType<typeof createWriter>;

export interface NoteArea {
  slug: string;
  name: string;
  description: string | null;
}

/**
 * Model text is untrusted: one line, so it can't open a heading, list or code fence of its own; `<` escaped, so
 * Obsidian renders no HTML; `[`/`]` escaped, so no links, remote images (`![](url)`) or note embeds (`![[note]]`).
 */
export const line = (text: string): string =>
  oneLine(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/[[\]]/g, '\\$&');

/** Collapses whitespace for single-line db fields (titles, names); not escaped, the UI escapes on render. */
export const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Lowercase `a-z0-9-`, the slug alphabet of `areas.slug`. Empty when nothing Latin is left. */
export const slugify = (text: string): string =>
  text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 50)
    .replace(/^-+|-+$/g, '');

export const indexPath = (areaSlug: string): string => `wiki/${areaSlug}/_index.md`;

/** `wiki/<area>/sessions/` for a filed session, `inbox/sessions/` while it waits for review. */
export const notePath = (area: NoteArea | null, fileName: string): string =>
  `${area ? `wiki/${area.slug}` : 'inbox'}/sessions/${fileName}`;

const section = (heading: string, items: string[], marker = '-'): string =>
  items.length ? `\n## ${heading}\n\n${items.map((i) => `${marker} ${line(i)}`).join('\n')}\n` : '';

export function renderSessionNote(
  f: SessionFiling,
  { sessionId, area, subarea }: { sessionId: number; area: NoteArea | null; subarea: string | null },
): string {
  const filed = area
    ? `Area: [[${indexPath(area.slug).slice(0, -3)}|${line(area.name)}]]${subarea ? ` · Sub-area: ${line(subarea)}` : ''}`
    : 'Area: not filed yet (inbox)';
  const todos = f.todos.map((t) => `${t.text}${t.due ? ` (due ${t.due})` : ''}`);
  return [
    `# ${line(f.title) || `Session ${sessionId}`}\n\n${filed} · Session ${sessionId}\n`,
    `\n## Summary\n\n${line(f.summary)}\n`,
    section('Decisions', f.decisions),
    section('To-dos', todos, '- [ ]'),
    section('Facts about me', f.facts_about_me),
    section('Preferences', f.preferences),
    section('Open questions', f.open_questions),
    section('Lessons', f.lessons),
  ].join('');
}

/** Creates `wiki/<area>/_index.md` unless the file or its db row already exists (the user may own it). */
export function ensureAreaIndex(db: Database, writer: Writer, vaultDir: string, area: NoteArea): void {
  const rel = indexPath(area.slug);
  if (existsSync(resolveNotePath(vaultDir, rel)) || db.prepare('SELECT 1 FROM vault_notes WHERE path = ?').get(rel)) return;
  writer.writeNote(rel, `# ${line(area.name)}\n\n${line(area.description ?? '')}\n`, { area: area.slug });
}

/**
 * Deletes a note the app wrote and nobody touched since (db row is `app` and the hash matches).
 * Used when a re-filed session's note moves; a user-edited note stays where it is.
 */
export function removeOwnNote(db: Database, vaultDir: string, rel: string): void {
  const abs = resolveNotePath(vaultDir, rel);
  const row = db.prepare('SELECT content_hash, last_written_by FROM vault_notes WHERE path = ?').get(rel) as
    | { content_hash: string; last_written_by: string }
    | undefined;
  if (row?.last_written_by !== 'app' || !existsSync(abs) || sha256(readFileSync(abs)) !== row.content_hash) return;
  rmSync(abs);
  db.prepare('DELETE FROM vault_notes WHERE path = ?').run(rel);
}
