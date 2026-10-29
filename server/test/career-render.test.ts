import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import PizZip from 'pizzip';
import { afterAll, expect, test } from 'vitest';
import type { Requirements } from '../src/career/intake.ts';
import { readMaster, saveText } from '../src/career/tailor.ts';
import type { Draft } from '../src/career/tailor.ts';
import { enqueue } from '../src/db/jobs.ts';
import { careerRoutes, failCareerJob, failStuckApplications } from '../src/http/routes/career.ts';
import { careerRender, fillDocx, inside, outRoot, renderModel } from '../src/jobs/career-render.ts';
import { runNext } from '../src/jobs/runner.ts';
import { buildTestApp } from './helpers.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'career');
const STARTERS = join(import.meta.dirname, '..', 'templates', 'career');
const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};

const N = 'exp-northwind-logistics-2021';
const E = 'edu-hochschule-bremen-2015';
const CONTACT_VALUES = ['Jane Mary Doe', 'jane.doe@example.com', '+49 30 1234567', 'jane-doe.example.dev'];
const REQ = { language: 'en', company: 'Marlowe Freight Technologies', role_title: 'Platform Engineer', must_have: [], nice_to_have: [] } as unknown as Requirements;
const DRAFT: Draft = {
  summary: { text: 'Platform engineer with 6 years in DevOps.', cites: ['sum-1'] },
  entries: [
    { entry_id: N, bullets: [{ text: 'Cut deploy time from 40 to 9 minutes; kept {braces}, {{x}} and {#loop} literal.', cites: [`${N}-1a2b3c`] }] },
    { entry_id: E, bullets: [{ text: 'Thesis on container scheduling.', cites: [`${E}-6a7b8c`] }] },
  ],
  skill_ids: ['skill-terraform', 'skill-aws'],
  letter: {
    paragraphs: [
      { text: 'I am applying for the Platform Engineer role.', cites: ['sum-1'] },
      { text: 'I cut deploy time from 40 to 9 minutes.', cites: [`${N}-1a2b3c`] },
      { text: 'Reach me at {{CONTACT_EMAIL}} or {{CONTACT_PHONE}}; {{CONTACT_ADDRESS}} is empty. Regards, {{CONTACT_NAME}}', cites: ['sum-1'] },
    ],
  },
  versions: 1,
};

/** The paragraphs of a generated `.docx`, as plain text. */
const docxText = (buf: Buffer) =>
  new PizZip(buf)
    .file('word/document.xml')!
    .asText()
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');

/** A vault with the synthetic master and contact, a data dir, the app, and an application at `status`. */
async function setup(status = 'final', step: string | null = 'render') {
  const vaultDir = tmp('aos-render-vault-');
  const dataDir = tmp('aos-render-data-');
  mkdirSync(join(vaultDir, 'career'));
  for (const f of ['master.md', 'contact.md']) copyFileSync(join(FIXTURES, f), join(vaultDir, 'career', f));
  const t = await buildTestApp({ loggedIn: true, plugins: [careerRoutes({ vaultDir, dataDir })] });
  const id = t.db.prepare(`INSERT INTO applications (status, step, language, master_hash) VALUES (?, ?, 'en', 'h') RETURNING id`).pluck().get(status, step) as number;
  saveText(t.db, id, 'requirements', REQ);
  saveText(t.db, id, 'draft', DRAFT);
  const config = { vaultDir, dataDir };
  const render = () => careerRender({ db: t.db, config })({ payload: { applicationId: id } } as never);
  const req = (method: 'GET' | 'POST', path: string, payload?: object) =>
    t.app.inject(t.authed({ method, url: `/api/career/applications/${id}${path}`, ...(payload ? { payload } : {}) }));
  const state = () => t.db.prepare('SELECT status, step, fail_code FROM applications WHERE id = ?').get(id);
  /** Everything outside `application_texts`: must hold ids, counts and codes only. */
  const dump = () =>
    ['applications', 'application_events', 'application_files', 'jobs', 'audit_log'].map((tb) => JSON.stringify(t.db.prepare(`SELECT * FROM ${tb}`).all())).join('\n');
  return { ...t, id, vaultDir, dataDir, config, render, req, state, dump };
}

// ---------- model and template ----------

test('render model: employer, title and dates from the master; placeholders restored only here; braces in a bullet stay literal', () => {
  const vault = tmp('aos-render-model-');
  mkdirSync(join(vault, 'career'));
  copyFileSync(join(FIXTURES, 'master.md'), join(vault, 'career', 'master.md'));
  const contact = { name: 'Jane Mary Doe', email: 'jane.doe@example.com', phone: '+49 30 1234567' };
  const model = renderModel(DRAFT, readMaster(vault), contact, REQ, new Date('2026-10-28T12:00:00Z'));
  expect(model.experience).toEqual([
    { first: true, org: 'Northwind Logistics', title: 'DevOps Engineer', start: '2021-03', end: 'present', location: 'Hamburg', bullets: [DRAFT.entries[0]!.bullets[0]!.text] },
  ]);
  expect(model.education[0]).toMatchObject({ first: true, org: 'Hochschule Bremen', title: 'BSc Computer Science', start: '2015', end: '2018' });
  expect(model).toMatchObject({ projects: [], certifications: [], skills_text: 'Terraform, AWS', languages_text: 'English (C1), German (native)', date: '28 October 2026', address: '', salutation: 'Dear Hiring Manager,', closing: 'Kind regards,' });
  expect(renderModel(DRAFT, { ...readMaster(vault), language: 'de' }, contact, REQ, new Date())).toMatchObject({ salutation: 'Sehr geehrte Damen und Herren,', closing: 'Mit freundlichen Grüßen' });
  expect(model.paragraphs[2]).toBe('Reach me at jane.doe@example.com or +49 30 1234567;  is empty. Regards, Jane Mary Doe');
  expect(() => renderModel({ ...DRAFT, entries: [{ entry_id: 'exp-nowhere-2020', bullets: [] }] }, readMaster(vault), contact, REQ, new Date())).toThrow('draft entry missing in master');

  const cv = docxText(fillDocx(readFileSync(join(STARTERS, 'cv-template.docx')), model));
  expect(cv).toContain('Jane Mary Doe\n');
  expect(cv).toContain('DevOps Engineer, Northwind Logistics\n2021-03 – present · Hamburg');
  expect(cv).toContain('kept {braces}, {{x}} and {#loop} literal.');
  expect(cv).toContain('Terraform, AWS');
  expect(cv).not.toMatch(/Projects|Certifications|undefined/); // empty sections and their headings disappear
  const letter = docxText(fillDocx(readFileSync(join(STARTERS, 'letter-template.docx')), model));
  expect(letter).toContain('Marlowe Freight Technologies\nPlatform Engineer\n');
  expect(letter).toContain('Reach me at jane.doe@example.com');
  expect(letter).toContain('Dear Hiring Manager,\nI am applying');
  expect(letter).toContain('Kind regards,\nJane Mary Doe');
  expect(letter).not.toMatch(/\{|undefined/);
});

test('render model: the header, skills and languages edits win over the master; removed items vanish; added lines render', async () => {
  const t = await setup('draft_ready', null);
  const patch = await t.app.inject(
    t.authed({
      method: 'PATCH',
      url: `/api/career/applications/${t.id}/draft`,
      payload: {
        edits: [
          { ref: `cv.entries.${N}.header.title`, text: 'Platform Lead' },
          { ref: `cv.entries.${N}.header.end`, text: '2026-09' },
          { op: 'remove', ref: `cv.entries.${N}.header.location` },
          { op: 'remove', ref: `cv.entries.${N}.0` },
          { op: 'add', ref: `cv.entries.${N}`, text: 'Mentored two engineers; reach {{CONTACT_EMAIL}}.' },
          { op: 'remove', ref: `cv.entries.${E}` },
          { op: 'remove', ref: 'cv.summary' },
          { ref: 'cv.skills', text: 'Kubernetes ,  Go,,' },
          { ref: 'cv.languages', text: 'English (C2)' },
          { op: 'remove', ref: 'letter.1' },
          { op: 'add', ref: 'letter', text: 'An added closing paragraph.' },
        ],
      },
    }),
  );
  expect(patch.statusCode).toBe(200);
  const draft = (patch.json() as { draft: Draft }).draft;
  const model = renderModel(draft, readMaster(t.vaultDir), { email: 'jane.doe@example.com' }, REQ, new Date('2026-10-28T12:00:00Z'));
  expect(model.experience).toEqual([
    {
      first: true, org: 'Northwind Logistics', title: 'Platform Lead', start: '2021-03', end: '2026-09', location: '',
      bullets: ['Mentored two engineers; reach jane.doe@example.com.'],
    },
  ]);
  expect(model).toMatchObject({ education: [], summary: '', skills: ['Kubernetes', 'Go'], skills_text: 'Kubernetes, Go', languages: ['English (C2)'], languages_text: 'English (C2)' });
  expect(model.paragraphs).toEqual([DRAFT.letter.paragraphs[0]!.text, expect.stringContaining('Reach me at jane.doe@example.com'), 'An added closing paragraph.']);

  const cv = docxText(fillDocx(readFileSync(join(STARTERS, 'cv-template.docx')), model));
  for (const s of ['Platform Lead', 'Northwind Logistics', '2026-09', 'Mentored two engineers; reach jane.doe@example.com.', 'Kubernetes, Go', 'English (C2)']) expect(cv).toContain(s);
  for (const s of ['DevOps Engineer', 'Hamburg', 'Cut deploy time', 'Hochschule Bremen', 'Education', 'Platform engineer with', 'Terraform', 'German']) expect(cv).not.toContain(s);
  const letter = docxText(fillDocx(readFileSync(join(STARTERS, 'letter-template.docx')), model));
  expect(letter).toContain('An added closing paragraph.');
  expect(letter).not.toContain('I cut deploy time');
});

// ---------- job ----------

test('render: both docx files in out/<id>/, step leaves render, a rendered event; no contact value or draft text outside the files', async () => {
  const t = await setup();
  expect(t.dump()).not.toMatch(new RegExp(CONTACT_VALUES.map((v) => v.replace(/[.+]/g, '\\$&')).join('|'))); // before: nowhere
  await t.render();
  expect(t.state()).toEqual({ status: 'final', step: null, fail_code: null });
  const files = t.db.prepare('SELECT kind, relpath, sha256, bytes FROM application_files ORDER BY kind').all() as { kind: string; relpath: string; sha256: string; bytes: number }[];
  expect(files.map((f) => [f.kind, f.relpath])).toEqual([
    ['cv_docx', `${t.id}/cv.docx`],
    ['letter_docx', `${t.id}/letter.docx`],
  ]);
  const cv = readFileSync(join(outRoot(t.dataDir), files[0]!.relpath));
  expect(files[0]!.bytes).toBe(cv.length);
  expect(docxText(cv)).toContain('jane.doe@example.com');
  for (const v of CONTACT_VALUES) expect(t.dump()).not.toContain(v);
  expect(t.dump()).not.toContain('deploy time');
  expect(t.db.prepare("SELECT detail FROM application_events WHERE kind = 'rendered'").pluck().get()).toBe('{"files":2}');
  expect(((await t.req('GET', '')).json() as { files: unknown[] }).files).toHaveLength(2);
});

test('a template in dataDir/career wins over the starter', async () => {
  const t = await setup();
  const own = new PizZip(readFileSync(join(STARTERS, 'letter-template.docx')));
  own.file('word/document.xml', own.file('word/document.xml')!.asText().replace('{company}', 'OWN-TEMPLATE {company}'));
  mkdirSync(join(t.dataDir, 'career'), { recursive: true });
  writeFileSync(join(t.dataDir, 'career', 'letter-template.docx'), own.generate({ type: 'nodebuffer' }));
  await t.render();
  expect(docxText(readFileSync(join(outRoot(t.dataDir), String(t.id), 'letter.docx')))).toContain('OWN-TEMPLATE Marlowe');
  expect(docxText(readFileSync(join(outRoot(t.dataDir), String(t.id), 'cv.docx')))).not.toContain('OWN-TEMPLATE');
});

test('an unexpected throw in career_render is render_failed (not failed/internal) and retryable; a crash mid-render is swept on boot', async () => {
  const t = await setup();
  mkdirSync(join(t.dataDir, 'career'), { recursive: true });
  writeFileSync(join(t.dataDir, 'career', 'template.docx'), 'not a zip');
  enqueue(t.db, 'career_render', `career:render:${t.id}:0`, { applicationId: t.id });
  const handlers = { career_render: careerRender({ db: t.db, config: t.config }) };
  await expect(runNext(t.db, handlers, (job) => failCareerJob(t.db, job))).rejects.toThrow(/career_render/);
  expect(t.state()).toEqual({ status: 'final', step: null, fail_code: 'render_failed' });
  expect(t.db.prepare("SELECT detail FROM application_events WHERE kind = 'failed'").pluck().get()).toBe('{"code":"render_failed"}');

  rmSync(join(t.dataDir, 'career', 'template.docx'));
  expect((await t.req('POST', '/render')).statusCode).toBe(202);
  expect((await t.req('POST', '/render')).json()).toEqual({ error: 'wrong_status' }); // already rendering
  expect(t.db.prepare(`SELECT idempotency_key FROM jobs ORDER BY id`).pluck().all()).toEqual([`career:render:${t.id}:0`, `career:render:${t.id}:1`]);
  expect(await runNext(t.db, handlers, (job) => failCareerJob(t.db, job))).toBe(true);
  expect(t.state()).toEqual({ status: 'final', step: null, fail_code: null });

  // A render job that was running at a crash is failed by stale-lock recovery; boot sweeps its application.
  t.db.prepare(`UPDATE applications SET step = 'render' WHERE id = ?`).run(t.id);
  failStuckApplications(t.db);
  expect(t.state()).toEqual({ status: 'final', step: null, fail_code: 'render_failed' });
});

test('a render job for an application that is not final at render does nothing', async () => {
  const t = await setup('draft_ready', null);
  await t.render();
  expect(t.db.prepare('SELECT count(*) FROM application_files').pluck().get()).toBe(0);
  expect(existsSync(join(outRoot(t.dataDir), String(t.id)))).toBe(false);
});

// ---------- routes ----------

test('POST final: draft_ready → final/render with a render job; flagged needs the acknowledgement; other states are wrong_status', async () => {
  const t = await setup('processing', 'verify');
  expect((await t.req('POST', '/final', {})).json()).toEqual({ error: 'wrong_status' });
  expect((await t.app.inject(t.authed({ method: 'POST', url: '/api/career/applications/999/final', payload: {} }))).json()).toEqual({ error: 'not_found' });
  t.db.prepare(`UPDATE applications SET status = 'flagged', step = 'verify', fail_code = 'verify_failed'`).run();
  expect((await t.req('POST', '/final', {})).json()).toEqual({ error: 'flagged_not_acknowledged' });
  expect((await t.req('POST', '/final', { acknowledge_flagged: 'yes' })).json()).toEqual({ error: 'flagged_not_acknowledged' });
  const res = await t.req('POST', '/final', { acknowledge_flagged: true });
  expect(res.statusCode).toBe(202);
  expect(res.json()).toMatchObject({ id: t.id, status: 'final', step: 'render', fail_code: null, draft: DRAFT, files: [] });
  expect(t.db.prepare('SELECT kind, idempotency_key, payload FROM jobs').get()).toEqual({
    kind: 'career_render', idempotency_key: `career:render:${t.id}:0`, payload: JSON.stringify({ applicationId: t.id }),
  });
  expect((await t.req('POST', '/final', { acknowledge_flagged: true })).json()).toEqual({ error: 'wrong_status' });
  const audit = t.db.prepare("SELECT args_redacted FROM audit_log WHERE action = 'career.application.final'").pluck().get() as string;
  expect(JSON.parse(audit)).toEqual({ id: t.id, flagged: true });

  const t2 = await setup('draft_ready', null);
  const ok = await t2.req('POST', '/final'); // no body at all
  expect([ok.statusCode, (ok.json() as { step: string }).step]).toEqual([202, 'render']);
});

test('GET files: fixed headers, served by id; wrong kind or id → 404; not rendered → 409; a stored path outside out/ is refused', async () => {
  const t = await setup();
  expect((await t.req('GET', '/files/cv_docx')).json()).toEqual({ error: 'files_not_ready' });
  await t.render();
  const docx = await t.req('GET', '/files/cv_docx');
  expect(docx.statusCode).toBe(200);
  expect(docx.headers).toMatchObject({
    'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'content-disposition': `attachment; filename="application-${t.id}-cv.docx"`,
    'cache-control': 'no-store',
  });
  expect(docx.headers['content-security-policy']).toContain("default-src 'self'");
  expect(docx.rawPayload.equals(readFileSync(join(outRoot(t.dataDir), String(t.id), 'cv.docx')))).toBe(true);
  const letter = await t.req('GET', '/files/letter_docx');
  expect(letter.headers['content-disposition']).toBe(`attachment; filename="application-${t.id}-letter.docx"`);

  for (const path of ['/files/cv_pdf', '/files/letter_pdf', '/files/cv', '/files/..%2F..%2Fbrain.db', '/files/CV_DOCX']) expect((await t.req('GET', path)).json()).toEqual({ error: 'not_found' });
  expect((await t.app.inject(t.authed({ url: '/api/career/applications/999/files/cv_docx' }))).json()).toEqual({ error: 'not_found' });
  const audit = t.db.prepare("SELECT args_redacted FROM audit_log WHERE action = 'career.file.download'").pluck().all() as string[];
  expect(audit.map((a) => JSON.parse(a))).toEqual([{ id: t.id, kind: 'cv_docx' }, { id: t.id, kind: 'letter_docx' }]);

  writeFileSync(join(t.dataDir, 'secret.txt'), 'outside');
  t.db.prepare(`UPDATE application_files SET relpath = '../secret.txt' WHERE kind = 'cv_docx'`).run();
  expect((await t.req('GET', '/files/cv_docx')).json()).toEqual({ error: 'files_not_ready' });
});

test('inside: a path outside out/ is refused', () => {
  const root = tmp('aos-render-out-');
  expect(inside(root, '7/cv.docx')).toBe(join(root, '7', 'cv.docx'));
  for (const rel of ['..', '../x.docx', '', root.slice(0, -1)]) expect(() => inside(root, rel)).toThrow('path outside the output folder');
});
