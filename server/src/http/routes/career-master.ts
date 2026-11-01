import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { fileHash, stage } from '../../approvals/apply.ts';
import { contactNote, loadContact } from '../../career/contact.ts';
import type { Contact } from '../../career/contact.ts';
import { DocumentError, importDocument, importText, scrubContactLike } from '../../career/document.ts';
import { MAX_FILE_BYTES, buildImport, readExport } from '../../career/linkedin.ts';
import { BULLET_SECTIONS, ENTRY_SECTIONS, MasterError, editSections, masterFm, mergeMaster, parseMaster, serialiseMaster } from '../../career/master.ts';
import type { Bullet, Section, SectionEdit } from '../../career/master.ts';
import { redactContact } from '../../career/redact.ts';
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

const MAX_PARSE_FILES = 10;
const B64_MAX = Math.ceil(MAX_FILE_BYTES / 3) * 4; // 5 MB as base64
const ZIP = Buffer.from('PK\x03\x04', 'latin1'); // a .docx is a zip
const parseSchema = {
  type: 'object',
  properties: {
    files: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_PARSE_FILES,
      items: {
        type: 'object',
        properties: { name: line(1, 255), data: { type: 'string', minLength: 1, maxLength: B64_MAX, pattern: '^[A-Za-z0-9+/]*={0,2}$' } },
        required: ['name', 'data'],
        additionalProperties: false,
      },
    },
  },
  required: ['files'],
  additionalProperties: false,
};

/**
 * Drops what `PUT /career/master` would refuse (putSchema's text lengths, control characters) and counts it.
 * `allowed` drops more by the caller's own rule.
 * ponytail: the item counts (50 bullets per entry, 100 entries) aren't cut here; past them the PUT says bad_master.
 */
function fitForPut(sections: Section[], allowed: (text: string) => boolean = () => true): { sections: Section[]; dropped: number } {
  let dropped = 0;
  const ok = (t: string, max: number) => (t.length <= max && !/\p{Cc}/u.test(t) && allowed(t)) || (dropped++, false);
  const lines = (bs: Bullet[]) => bs.filter((b) => ok(b.text, 2000));
  const fitted = sections.map((s): Section =>
    'bullets' in s
      ? { ...s, bullets: lines(s.bullets) }
      : { ...s, entries: s.entries.filter((e) => [e.org, e.title, e.location].every((f) => ok(f, 120))).map((e) => ({ ...e, bullets: lines(e.bullets) })) },
  );
  return { sections: fitted, dropped };
}

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

    /** `null` when the file is outside the grammar. */
    const sectionsOf = (text: string): Section[] | null => {
      try {
        return parseMaster(text).sections;
      } catch (err) {
        if (err instanceof MasterError) return null;
        throw err;
      }
    };
    const contactOrWarn = (warnings: string[]): Contact => {
      try {
        return loadContact(vaultDir);
      } catch {
        warnings.push('career/contact.md has invalid frontmatter; fix it in Obsidian');
        return {};
      }
    };
    /** The response of both merge routes. `args` go to the audit log: counts only. */
    const merged = (hash: string | null, current: Section[], incoming: { from: string; sections: Section[] }[], warnings: string[], args: Record<string, unknown>) => {
      const { sections, added } = mergeMaster(current, incoming);
      audit(db, { actor: 'user', action: 'career.master.parse', args: { ...args, ...added } });
      return { hash, sections, added, warnings };
    };

    api.get('/career/master', async () => {
      const { text, hash } = read();
      return text === null ? { exists: false } : view(text, hash!);
    });

    // Word CVs → the current master merged with each (career-v2 §2). Writes nothing: the client PUTs what the owner keeps.
    // File names go back in `warnings` and `from` only: never logged or audited (they can hold the owner's name).
    api.post<{ Body: { files: { name: string; data: string }[] } }>(
      '/career/master/parse',
      { bodyLimit: MAX_PARSE_FILES * (B64_MAX + 1024), schema: { body: parseSchema }, attachValidation: true },
      async (req, reply) => {
        if (req.validationError) return reply.code(400).send({ error: 'bad_upload' });
        const files = req.body.files.map((f) => ({ name: f.name, data: Buffer.from(f.data, 'base64') }));
        const wrong = files.filter((f) => extname(f.name).toLowerCase() !== '.docx' || !f.data.subarray(0, 4).equals(ZIP));
        if (wrong.length) return reply.code(400).send({ error: 'import_unreadable', warnings: wrong.map((f) => `${f.name}: skipped: not a .docx file`) });
        if (!dirs.llm && !getLlm(api.config)) return reply.code(409).send({ error: 'provider_not_configured' });
        const warnings: string[] = [];
        const contact = contactOrWarn(warnings);
        if (!contact.name) {
          warnings.push('fill in at least your name in career/contact.md, then try again'); // unlike the import, creates nothing
          return reply.code(409).send({ error: 'contact_missing', warnings });
        }
        const { text, hash } = read();
        const current = text === null ? [] : sectionsOf(text);
        if (!current) return reply.code(409).send({ error: 'bad_master' }); // fix it in Obsidian first

        const incoming: { from: string; sections: Section[] }[] = [];
        for (const f of files) {
          const { text: cv, used } = await importText([f], warnings); // one call per file, so every new item knows its file
          if (!used.length) continue;
          let result;
          try {
            result = await importDocument({ db, config: api.config, contact, ...(dirs.llm ? { llm: dirs.llm } : {}) }, cv);
          } catch (err) {
            if (err instanceof LlmError || err instanceof DocumentError) return reply.code(502).send({ error: 'provider_error' });
            throw err;
          }
          if (!result) {
            warnings.push(`${f.name}: skipped: nothing found to import`);
            continue;
          }
          const { sections, dropped } = fitForPut(parseMaster(result.master).sections);
          warnings.push(...result.warnings.map((w) => `${f.name}: ${w}`));
          if (dropped) warnings.push(`${f.name}: ${dropped} item(s) too long for the editor were dropped`);
          incoming.push({ from: f.name, sections });
        }
        if (!incoming.length) return reply.code(400).send({ error: 'import_unreadable', warnings });
        return merged(hash, current, incoming, warnings, { files: files.length, read: incoming.length });
      },
    );

    // LinkedIn's data export in the import folder → the current master merged with it. No model, no fallback to one,
    // and nothing written. With no master yet, `POST /career/master/import` is the first-time path (it also proposes contact.md).
    api.post('/career/master/parse-linkedin', async (_req, reply) => {
      const { text, hash } = read();
      if (text === null) return reply.code(409).send({ error: 'master_missing' });
      const current = sectionsOf(text);
      if (!current) return reply.code(409).send({ error: 'bad_master' });
      const { sources, files, warnings } = readExport(importDir);
      if (files['Profile.csv'] === undefined && files['Positions.csv'] === undefined) return reply.code(400).send({ error: 'import_empty', warnings });
      for (const f of sources) if (!f.known) warnings.push(`${f.name}: skipped: only LinkedIn's own CSVs are read here`);
      let result;
      try {
        result = buildImport(files);
      } catch (err) {
        if (!(err instanceof MasterError)) throw err; // text the master grammar can't hold
        result = null;
      }
      if (!result) return reply.code(400).send({ error: 'linkedin_unreadable', warnings });
      warnings.push(...result.warnings);
      // Master lines reach the model later. The export's contact columns are never mapped, but free text can hold the same
      // details: such a line is left out, as in a Word import. The address lines would hit ordinary places ("Berlin"), so not those.
      // ponytail: scrubContactLike also hits `Node.js/TS` and `1.000.000`; the warning below says so, and the owner adds them by hand.
      const known = [{ ...contactOrWarn(warnings), address: '', dob: '' }, { name: result.name ?? '' }];
      const allowed = (t: string) => scrubContactLike(t) === t && known.every((c) => redactContact(t, c) === t);
      const { sections, dropped } = fitForPut(parseMaster(result.master).sections, allowed);
      if (dropped) warnings.push(`${dropped} item(s) with contact details or too long for the editor were left out; add them by hand`);
      return merged(hash, current, [{ from: 'LinkedIn export', sections }], warnings, { files: Object.keys(files).length, read: 1, source: 'linkedin' });
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
