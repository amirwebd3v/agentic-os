import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { buildImport, readExport } from '../../career/linkedin.ts';
import { audit } from '../../db/audit.ts';
import { resolveNotePath, sha256 } from '../../vault/writer.ts';

/**
 * `POST /api/career/master/import` (contract §8.1): reads only `dataDir/career/import/`, proposes `master.md` and
 * `contact.md` as one `career_master_import` approval. `vaultDir` / `dataDir` override the config (tests).
 */
export const careerMasterRoutes =
  (dirs: { vaultDir?: string; dataDir?: string } = {}): FastifyPluginAsync =>
  async (api) => {
    const { db } = api;
    const vaultDir = dirs.vaultDir ?? api.config.vaultDir;
    const importDir = join(dirs.dataDir ?? api.config.dataDir, 'career', 'import');
    const hash = (rel: string) => {
      const abs = resolveNotePath(vaultDir, rel);
      return existsSync(abs) ? sha256(readFileSync(abs)) : null;
    };
    const replacePending = db.prepare(
      `UPDATE approvals SET payload = ? WHERE action_type = 'career_master_import' AND status = 'pending' RETURNING id`,
    );
    const insert = db.prepare(`INSERT INTO approvals (action_type, payload, proposed_by) VALUES ('career_master_import', ?, 'app') RETURNING id`);

    api.post('/career/master/import', async (_req, reply) => {
      const masterHash = hash('career/master.md');
      if (masterHash) return reply.code(409).send({ error: 'master_exists' }); // v1 has no re-import (R10): edit it in Obsidian
      const { files, warnings: readWarnings } = readExport(importDir);
      const result = buildImport(files);
      if (!result) return reply.code(400).send({ error: 'import_empty' });

      const { master, contact, stats, warnings } = result;
      const source_files = Object.keys(files);
      const payload = JSON.stringify({
        master,
        contact,
        source_files,
        master_hash_before: masterHash,
        contact_hash_before: hash('career/contact.md'),
        stats,
      });
      // One pending import at a time: a new one replaces the pending payload.
      const approval_id = db.transaction(() => {
        const row = (replacePending.get(payload) ?? insert.get(payload)) as { id: number };
        audit(db, { actor: 'user', action: 'career.master_import.propose', args: { approval_id: row.id, source_files, stats } });
        return row.id;
      })();
      return reply.code(201).send({ approval_id, warnings: [...readWarnings, ...warnings] });
    });
  };
