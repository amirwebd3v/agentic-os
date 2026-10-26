import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Database } from 'better-sqlite3';
import { audit } from '../db/audit.ts';

export interface AreaDef {
  slug: string;
  name: string;
  mode: 'do' | 'explain' | 'tutor';
  description: string;
}

const LINE = /^- `([a-z0-9]+(?:-[a-z0-9]+)*)` \| ([^|]+?) \| (do|explain|tutor) \| (.+)$/;

/**
 * Parses the `## Areas` list. Throws on any malformed item or an empty list,
 * because a silently skipped line would archive that area.
 */
export function parseAreas(markdown: string): AreaDef[] {
  const section = /^## Areas[ \t]*$([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(markdown)?.[1];
  if (section === undefined) throw new Error('CLAUDE.md has no "## Areas" section');
  const areas: AreaDef[] = [];
  for (const raw of section.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!/^([-*+]|\d+\.)\s/.test(line)) continue; // any list item, so a bullet in another style throws instead of archiving
    const m = LINE.exec(line);
    if (!m) throw new Error(`Malformed area line in CLAUDE.md (expected "- \`slug\` | Name | mode | description"): ${line}`);
    if (areas.some((a) => a.slug === m[1])) throw new Error(`Duplicate area slug in CLAUDE.md: ${m[1]}`);
    areas.push({ slug: m[1]!, name: m[2]!.trim(), mode: m[3] as AreaDef['mode'], description: m[4]!.trim() });
  }
  if (areas.length === 0) throw new Error('CLAUDE.md "## Areas" lists no areas');
  return areas;
}

/** Upserts the file's top-level areas and archives active top-level ones it no longer lists. Never deletes. */
export function syncAreas(db: Database, areas: AreaDef[]): { changed: number; archived: string[] } {
  return db.transaction(() => {
    const upsert = db.prepare(
      `INSERT INTO areas (slug, name, description, mode, status, created_by) VALUES (@slug, @name, @description, @mode, 'active', 'user')
       ON CONFLICT(slug) DO UPDATE SET name = excluded.name, description = excluded.description, mode = excluded.mode,
         status = CASE WHEN status = 'archived' THEN 'active' ELSE status END
       WHERE name IS NOT excluded.name OR description IS NOT excluded.description OR mode IS NOT excluded.mode OR status = 'archived'`,
    );
    let changed = 0;
    for (const a of areas) changed += upsert.run(a).changes;
    const archived = (
      db
        .prepare(
          `UPDATE areas SET status = 'archived'
           WHERE parent_id IS NULL AND status = 'active' AND slug NOT IN (SELECT value FROM json_each(?)) RETURNING slug`,
        )
        .all(JSON.stringify(areas.map((a) => a.slug))) as { slug: string }[]
    ).map((r) => r.slug);
    if (changed || archived.length) audit(db, { actor: 'app', action: 'areas.sync', args: { changed, archived } });
    return { changed, archived };
  })();
}

/** Boot step: reads `<vault>/CLAUDE.md` and syncs its areas. */
export const syncAreasFromVault = (db: Database, vaultDir: string) =>
  syncAreas(db, parseAreas(readFileSync(join(vaultDir, 'CLAUDE.md'), 'utf8')));
