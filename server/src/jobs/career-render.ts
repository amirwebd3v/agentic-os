import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Docxtemplater from 'docxtemplater';
import PizZip from 'pizzip';
import { z } from 'zod';
import { CONTACT_FIELDS, loadContact } from '../career/contact.ts';
import type { Contact, ContactField } from '../career/contact.ts';
import type { Requirements } from '../career/intake.ts';
import { restoreContact } from '../career/redact.ts';
import { event, latest, readMaster } from '../career/tailor.ts';
import type { Draft, MasterIndex } from '../career/tailor.ts';
import type { Config } from '../config.ts';
import type { Database } from '../db/index.ts';
import { isInside, sha256 } from '../vault/writer.ts';
import type { JobHandler } from './runner.ts';

/** Fixed messages only (contract §1). */
export class RenderError extends Error {}

export const FILE_KINDS = ['cv_docx', 'letter_docx'] as const;
export type FileKind = (typeof FILE_KINDS)[number];

const STARTERS = fileURLToPath(new URL('../../templates/career/', import.meta.url));
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/** `dataDir/career/out`, where every generated file lives (contract §2). */
export const outRoot = (dataDir: string): string => resolve(dataDir, 'career', 'out');

/** `rel` resolved against `root`; throws unless it lands strictly inside. */
export function inside(root: string, rel: string): string {
  const path = resolve(root, rel);
  if (!isInside(path, root)) throw new RenderError('path outside the output folder');
  return path;
}

// ---------- model (contract §7: the tags a template can use) ----------

type RenderEntry = { first: boolean; org: string; title: string; start: string; end: string; location: string; bullets: string[] };
const SECTION_KEY = { Experience: 'experience', Education: 'education', Projects: 'projects', Certifications: 'certifications' } as const;
type SectionKey = (typeof SECTION_KEY)[keyof typeof SECTION_KEY];
export type RenderModel = Record<ContactField | 'summary' | 'skills_text' | 'languages_text' | 'company' | 'role_title' | 'date', string> &
  Record<SectionKey, RenderEntry[]> & { skills: string[]; languages: string[]; paragraphs: string[] };

/**
 * The data both templates get. Employer, title, dates and place come from the master by `entry_id`, never from the
 * draft; contact placeholders are restored here and nowhere else (contract §3.3).
 */
export function renderModel(draft: Draft, m: MasterIndex, contact: Contact, req: Pick<Requirements, 'company' | 'role_title'>, now: Date): RenderModel {
  const text = (l: { text: string }) => restoreContact(l.text, contact);
  const sections: Record<SectionKey, RenderEntry[]> = { experience: [], education: [], projects: [], certifications: [] };
  for (const d of draft.entries) {
    const s = m.master.sections.find((x) => 'entries' in x && x.entries.some((e) => e.id === d.entry_id));
    const e = m.entries.get(d.entry_id);
    if (!s || !e) throw new RenderError('draft entry missing in master');
    const list = sections[SECTION_KEY[s.name as keyof typeof SECTION_KEY]];
    const end = e.end === 'present' && m.language === 'de' ? 'heute' : e.end;
    list.push({ first: !list.length, org: e.org, title: e.title, start: e.start, end, location: e.location, bullets: d.bullets.map(text) });
  }
  const skills = draft.skill_ids.flatMap((id) => (m.skills.has(id) ? [m.sources.get(id)!] : []));
  const langSection = m.master.sections.find((s) => s.name === 'Languages');
  const languages = langSection && 'bullets' in langSection ? langSection.bullets.map((b) => b.text) : [];
  return {
    ...(Object.fromEntries(CONTACT_FIELDS.map((f) => [f, contact[f] ?? ''])) as Record<ContactField, string>),
    summary: draft.summary ? text(draft.summary) : '',
    ...sections,
    skills,
    skills_text: skills.join(', '),
    languages,
    languages_text: languages.join(', '),
    company: req.company,
    role_title: req.role_title,
    date: new Intl.DateTimeFormat(m.language === 'de' ? 'de-DE' : 'en-GB', { dateStyle: 'long' }).format(now),
    paragraphs: draft.letter.paragraphs.map(text),
  };
}

/** Fills a `.docx` template. Data values are never parsed as tags, so a bullet with `{` or `{{x}}` stays literal. */
export function fillDocx(template: Buffer, data: RenderModel): Buffer {
  const doc = new Docxtemplater(new PizZip(template), { paragraphLoop: true, linebreaks: true, nullGetter: () => '' });
  doc.render(data);
  return doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// ---------- job ----------

const Payload = z.object({ applicationId: z.number().int().positive() });

const record = (db: Database, id: number, kind: FileKind, buf: Buffer) =>
  db
    .prepare('INSERT INTO application_files (application_id, kind, relpath, sha256, bytes) VALUES (?, ?, ?, ?, ?)')
    .run(id, kind, `${id}/${kind.replace('_', '.')}`, sha256(buf), buf.length);

/**
 * Job `career_render` (contract §7): fills the CV and letter templates into `dataDir/career/out/<id>/`. A throw (a
 * missing or broken template) ends through `failCareerJob` as `render_failed` (status stays `final`; `POST …/render`
 * retries).
 */
export const careerRender =
  ({ db, config }: { db: Database; config: Pick<Config, 'vaultDir' | 'dataDir'> }): JobHandler =>
  async (job) => {
    const p = Payload.safeParse(job.payload);
    if (!p.success) throw new RenderError('career_render: invalid payload');
    const id = p.data.applicationId;
    const app = db.prepare('SELECT status, step FROM applications WHERE id = ?').get(id) as { status: string; step: string | null } | undefined;
    if (app?.status !== 'final' || app.step !== 'render') return;

    const root = outRoot(config.dataDir);
    const dir = inside(root, String(id));
    db.prepare('DELETE FROM application_files WHERE application_id = ?').run(id);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });

    const master = readMaster(config.vaultDir);
    const data = renderModel(latest<Draft>(db, id, 'draft'), master, loadContact(config.vaultDir), latest<Requirements>(db, id, 'requirements'), new Date());
    const docs = [
      { name: 'cv', own: 'template.docx', starter: 'cv-template.docx' },
      { name: 'letter', own: 'letter-template.docx', starter: 'letter-template.docx' },
    ] as const;
    const filled = docs.map((d) => {
      const own = join(config.dataDir, 'career', d.own);
      const buf = fillDocx(readFileSync(existsSync(own) ? own : join(STARTERS, d.starter)), data);
      writeFileSync(join(dir, `${d.name}.docx`), buf);
      return buf;
    });
    db.transaction(() => {
      docs.forEach((d, i) => record(db, id, `${d.name}_docx`, filled[i]!));
      db.prepare(`UPDATE applications SET step = NULL, fail_code = NULL, updated_at = ${NOW} WHERE id = ?`).run(id);
      event(db, id, 'rendered', { files: docs.length });
    })();
  };
