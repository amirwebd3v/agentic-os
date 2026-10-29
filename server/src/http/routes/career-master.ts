import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { fileHash, stage } from '../../approvals/apply.ts';
import { contactNote, loadContact } from '../../career/contact.ts';
import type { Contact } from '../../career/contact.ts';
import { DocumentError, importDocument, importText } from '../../career/document.ts';
import { buildImport, readExport } from '../../career/linkedin.ts';
import { BULLET_SECTIONS, ENTRY_SECTIONS, MasterError, editSections, masterFm, parseMaster, serialiseMaster } from '../../career/master.ts';
import type { Section, SectionEdit } from '../../career/master.ts';
import { audit } from '../../db/audit.ts';
import { getLlm } from '../../llm/client.ts';
import type { structured } from '../../llm/client.ts';
import { LlmError } from '../../llm/errors.ts';
import { parseNote } from '../../vault/frontmatter.ts';
import type { Frontmatter } from '../../vault/frontmatter.ts';
import { gitCommit, resolveNotePath, sha256 } from '../../vault/writer.ts';

const MASTER = 'career/master.md';
// Single-line text: no control characters (a newline would end the line in the grammar).
const line = (min: number, max: number, header = false) => ({
  type: 'string',
  minLength: min,
  maxLength: max,
  pattern: header ? '^[^\\x00-\\x1f\\x7f|]*$' : '^[^\\x00-\\x1f\\x7f]*$',
});
const DATE = '^\\d{4}(?:-(?:0[1-9]|1[0-2]))?$';
const bulletSchema = {
  type: 'object',
  properties: { id: { type: 'string', pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$', maxLength: 64 }, text: line(1, 2000) },
  required: ['text'],
  additionalProperties: false,
};
const putSchema = {
  type: 'object',
  properties: {
    hash: { type: ['string', 'null'], pattern: '^[0-9a-f]{64}$' },
    sections: {
      type: 'array',
      maxItems: 7,
      items: {
        type: 'object',
        properties: {
          name: { enum: [...BULLET_SECTIONS, ...Object.keys(ENTRY_SECTIONS)] },
          bullets: { type: 'array', maxItems: 300, items: bulletSchema },
          entries: {
            type: 'array',
            maxItems: 100,
            items: {
              type: 'object',
              properties: {
                id: bulletSchema.properties.id,
                org: line(0, 120, true),
                title: line(0, 120, true),
                start: { type: 'string', pattern: DATE },
                end: { type: 'string', pattern: `${DATE}|^present$` },
                location: line(0, 120, true),
                bullets: { type: 'array', maxItems: 50, items: bulletSchema },
              },
              required: ['org', 'title', 'start', 'end', 'location', 'bullets'],
              additionalProperties: false,
            },
          },
        },
        required: ['name'],
        additionalProperties: false,
      },
    },
  },
  required: ['hash', 'sections'],
  additionalProperties: false,
};

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

    /** The master as the web app shows it: `error` is the parser's fixed text (line numbers only). */
    const read = () => {
      const abs = resolveNotePath(vaultDir, MASTER);
      if (!existsSync(abs)) return { abs, text: null, hash: null };
      const buf = readFileSync(abs);
      return { abs, text: buf.toString('utf8'), hash: sha256(buf) };
    };
    const view = (text: string, hash: string) => {
      try {
        return { exists: true, hash, sections: parseMaster(text).sections };
      } catch (err) {
        if (err instanceof MasterError) return { exists: true, hash, error: err.message };
        throw err;
      }
    };

    api.get('/career/master', async () => {
      const { text, hash } = read();
      return text === null ? { exists: false } : view(text, hash!);
    });

    // One git process at a time. ponytail: the writer and approvals have their own chains; a failed commit is caught by the next `add -A`
    let committing: Promise<unknown> = Promise.resolve();
    const upsertNote = db.prepare(
      `INSERT INTO vault_notes (path, content_hash, last_written_by) VALUES (?, ?, 'user')
       ON CONFLICT(path) DO UPDATE SET content_hash = excluded.content_hash, last_written_by = 'user'`,
    );

    // The owner's own edit (no approval): replaces the whole master, guarded by the hash the owner last saw.
    api.put<{ Body: { hash: string | null; sections: SectionEdit[] } }>(
      '/career/master',
      { schema: { body: putSchema }, attachValidation: true }, // a fixed code, not Fastify's validation text
      async (req, reply) => {
        if (req.validationError) return reply.code(400).send({ error: 'bad_master' });
        const { abs, text: before, hash: beforeHash } = read();
        if (beforeHash !== req.body.hash) return reply.code(409).send({ error: 'master_changed' }); // edited in Obsidian meanwhile
        let current: Section[] = [];
        let fm: Frontmatter | undefined;
        if (before !== null) {
          try {
            fm = parseNote(before).fm;
            current = parseMaster(before).sections;
          } catch {
            // an unparseable file: its ids are unknown, and it gets fresh frontmatter if that is what's broken
          }
        }
        const now = new Date().toISOString();
        let sections: Section[];
        let text: string;
        try {
          sections = editSections(req.body.sections, current);
          text = serialiseMaster({ fm: fm ? { ...fm, updated: now } : masterFm('web', now), sections });
          // Self-check: the file must read back as exactly what was sent, or the grammar couldn't hold it.
          if (JSON.stringify(parseMaster(text).sections) !== JSON.stringify(sections)) throw new MasterError('master: round trip');
        } catch (err) {
          if (err instanceof MasterError) return reply.code(400).send({ error: 'bad_master' });
          throw err;
        }
        const hash = sha256(text);
        const entries = sections.flatMap((s) => ('entries' in s ? s.entries : []));
        const bullets = sections.reduce((n, s) => n + ('bullets' in s ? s.bullets.length : 0), 0) + entries.reduce((n, e) => n + e.bullets.length, 0);
        const tmp = stage(abs, text);
        let wrote: boolean;
        try {
          wrote = db.transaction(() => {
            if (fileHash(abs) !== beforeHash) return false;
            upsertNote.run(MASTER, hash); // the user's file, at this hash: the watcher sees its own write, the writer won't touch it
            audit(db, { actor: 'user', action: 'career.master.save', args: { sections: sections.length, entries: entries.length, bullets } });
            renameSync(tmp, abs); // throws → everything rolls back
            return true;
          })();
        } finally {
          rmSync(tmp, { force: true });
        }
        if (!wrote) return reply.code(409).send({ error: 'master_changed' });
        committing = committing
          .then(() => gitCommit(vaultDir, `aos: edit ${MASTER}\n\n${MASTER}`))
          .catch((err: unknown) => api.log.warn(`vault commit failed: ${(err as Error).message}`));
        return { exists: true, hash, sections };
      },
    );
  };
