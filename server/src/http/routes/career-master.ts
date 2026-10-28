import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { contactNote, loadContact } from '../../career/contact.ts';
import type { Contact } from '../../career/contact.ts';
import { DocumentError, importDocument, importText } from '../../career/document.ts';
import { buildImport, readExport } from '../../career/linkedin.ts';
import { audit } from '../../db/audit.ts';
import { getLlm } from '../../llm/client.ts';
import type { structured } from '../../llm/client.ts';
import { LlmError } from '../../llm/errors.ts';
import { resolveNotePath, sha256 } from '../../vault/writer.ts';

/**
 * `POST /api/career/master/import` (contract §8.1): reads only `dataDir/career/import/`, proposes `master.md` (and,
 * from LinkedIn CSVs, `contact.md`) as one `career_master_import` approval. Unless LinkedIn's own CSVs map as they
 * are, every supported file is read through the model. `vaultDir` / `dataDir` / `llm` override the config and the
 * real call (tests).
 */
export const careerMasterRoutes =
  (dirs: { vaultDir?: string; dataDir?: string; llm?: typeof structured } = {}): FastifyPluginAsync =>
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
      const { sources, files, warnings } = readExport(importDir);
      if (!sources.length) return reply.code(400).send({ error: 'import_empty', warnings });
      // Fast path: LinkedIn's own CSVs, mapped without a model. Anything else (other names or columns) goes to the model.
      let result = Object.keys(files).length ? buildImport(files) : null;
      let source_files: string[];
      let auditFiles: string[]; // a CV's file name can hold the owner's name: audit only its type
      if (result) {
        source_files = auditFiles = Object.keys(files);
        for (const f of sources) if (!f.known) warnings.push(`${f.name}: skipped: the LinkedIn CSVs were imported instead`);
      } else {
        if (!dirs.llm && !getLlm(api.config)) return reply.code(409).send({ error: 'provider_not_configured' });
        // Contract §1: contact values never reach the model, so they must be known before the CV is read.
        let contact: Contact = {};
        try {
          contact = loadContact(vaultDir);
        } catch {
          warnings.push('career/contact.md has invalid frontmatter; fix it in Obsidian');
        }
        if (!contact.name) {
          const abs = resolveNotePath(vaultDir, 'career/contact.md');
          if (!existsSync(abs)) {
            mkdirSync(dirname(abs), { recursive: true });
            writeFileSync(abs, contactNote('', 'cv-import', new Date()), { flag: 'wx' }); // a new, empty file: yours from the start
            warnings.push('career/contact.md created');
          }
          warnings.push('fill in at least your name in career/contact.md, then import again');
          return reply.code(409).send({ error: 'contact_missing', warnings });
        }
        const { text, used } = await importText(sources, warnings);
        if (!used.length) return reply.code(400).send({ error: 'import_unreadable', warnings });
        try {
          result = await importDocument({ db, config: api.config, contact, ...(dirs.llm ? { llm: dirs.llm } : {}) }, text);
        } catch (err) {
          if (err instanceof LlmError || err instanceof DocumentError) return reply.code(502).send({ error: 'provider_error' });
          throw err;
        }
        source_files = used.map((f) => f.name);
        auditFiles = used.map((f) => `document${extname(f.name).toLowerCase()}`);
      }
      if (!result) return reply.code(400).send({ error: 'import_empty', warnings });

      const { master, contact, stats } = result;
      const payload = JSON.stringify({
        master,
        ...(contact === undefined ? {} : { contact, contact_hash_before: hash('career/contact.md') }),
        source_files,
        master_hash_before: masterHash,
        stats,
      });
      // One pending import at a time: a new one replaces the pending payload.
      const approval_id = db.transaction(() => {
        const row = (replacePending.get(payload) ?? insert.get(payload)) as { id: number };
        audit(db, { actor: 'user', action: 'career.master_import.propose', args: { approval_id: row.id, source_files: auditFiles, stats } });
        return row.id;
      })();
      return reply.code(201).send({ approval_id, warnings: [...warnings, ...result.warnings] });
    });
  };
