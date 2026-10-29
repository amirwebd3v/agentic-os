import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, test, vi } from 'vitest';
import { expireStale } from '../src/approvals/expire.ts';
import { loadContact } from '../src/career/contact.ts';
import { documentText, scrubContactLike } from '../src/career/document.ts';
import { buildImport, exportDate, readExport, splitBullets } from '../src/career/linkedin.ts';
import { bulletIdBase, parseMaster, serialiseMaster, validateMaster } from '../src/career/master.ts';
import type { Section } from '../src/career/master.ts';
import { approvalRoutes } from '../src/http/routes/approvals.ts';
import { careerMasterRoutes } from '../src/http/routes/career-master.ts';
import type { structured } from '../src/llm/client.ts';
import { LlmError } from '../src/llm/errors.ts';
import { sha256, vaultGit } from '../src/vault/writer.ts';
import { buildTestApp, capturePrompts } from './helpers.ts';

const FIXTURE = join(import.meta.dirname, 'fixtures/career/linkedin');
const NOW = new Date('2026-10-28T10:00:00.000Z');
// Real git under a parallel verify on Windows can take seconds: every test that commits waits for it.
const GIT_WAIT = { timeout: 20_000, interval: 100 };
const dirs: string[] = [];
const tmp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
// Once at the end, and async: right after a vault commit Windows keeps the folder busy (EBUSY) until the event loop runs.
afterAll(() => Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true, maxRetries: 10 }))));

const fixtureImport = () => buildImport(readExport(FIXTURE).files, NOW)!;

const MASTER = `---
id: career-master
area: career
tags: []
sensitivity: 2
source: hand
created: '2026-10-01T00:00:00.000Z'
updated: '2026-10-01T00:00:00.000Z'
---
## Summary
- Backend engineer focused on data pipelines.  ^sum-1

## Experience
### Acme GmbH | Senior Engineer | 2021-03 | 2024-06 | Berlin  ^exp-acme-2021
- Cut the nightly build from 12 to 4 minutes.  ^exp-acme-2021-3f9a1c
- Led a team of 4 engineers.  ^exp-acme-2021-b27e04

### Beispiel AG |  | 2019 | present |   ^exp-beispiel-2019

## Skills
- Python  ^skill-python
`;

test('master.md: parse → serialise round-trips, and the import is valid and stable', () => {
  expect(serialiseMaster(parseMaster(MASTER))).toBe(MASTER);
  const m = parseMaster(MASTER);
  expect(m.sections[1]).toMatchObject({ name: 'Experience', entries: [{ org: 'Acme GmbH', end: '2024-06', bullets: [{}, {}] }, { title: '', location: '' }] });

  const { master } = fixtureImport();
  expect(serialiseMaster(parseMaster(master))).toBe(master);
  expect(fixtureImport().master).toBe(master); // same export → same ids
  const ids = [...master.matchAll(/\^(\S+)$/gm)].map((x) => x[1]);
  expect(ids).toEqual(expect.arrayContaining(['sum-1', 'exp-acme-gmbh-2021', 'exp-acme-gmbh-2021-2', 'edu-tu-berlin-2024', 'crt-the-linux-foundation-2023', 'skill-python', 'lang-german']));
  expect(ids).toContain(`exp-acme-gmbh-2021-${sha256('cut the nightly build from 12 to 4 minutes.').slice(0, 6)}`);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.every((id) => id!.length <= 64)).toBe(true);
});

test('master.md: anything outside the grammar is rejected without quoting the file', () => {
  expect(validateMaster(MASTER)).toBeNull();
  expect(validateMaster(MASTER.replace('^skill-python', '^skill-python  ').replace('## Skills', '## Skills '))).toBeNull(); // trailing spaces
  expect(validateMaster(MASTER.replace('## Skills', '## Hobbies'))).toBe('master.md line 20: unknown section'); // file line, as in Obsidian
  const bad = [
    MASTER.replace('## Skills', '## Hobbies'), // unknown section
    MASTER.replace('## Skills', '## Summary'), // repeated section
    MASTER.replace('  ^skill-python', ''), // bullet without id
    MASTER.replace('^skill-python', '^Skill_Python'), // bad id
    MASTER.replace('^skill-python', '^sum-1'), // duplicate id
    MASTER.replace('2024-06', 'June 2024'), // bad date
    MASTER.replace('Senior Engineer | ', ''), // 4 fields
    MASTER.replace('## Summary\n', ''), // bullet before any section
    MASTER.replace('## Experience\n', '## Experience\n- Secret stray bullet.  ^x-1\n'), // bullet before the first entry
    MASTER.replace('## Skills', 'Free text with a secret'),
    MASTER.replace('sensitivity: 2', 'sensitivity: 9'), // frontmatter
  ];
  for (const text of bad) {
    const err = validateMaster(text);
    expect(err).toMatch(/^master\.md/);
    expect(err).not.toMatch(/secret|Acme|Python|June/i);
  }
});

test('LinkedIn export maps by header name; contact gets the name only; private columns never leak', () => {
  const { master, contact, stats, warnings } = fixtureImport();
  expect(master).toContain('### Acme GmbH | Senior Engineer | 2021-03 | present | Berlin, Germany  ^exp-acme-gmbh-2021\n');
  expect(master).toContain('### Beispiel AG / Labs | Intern | 2019 | 2020 | Hamburg  ^exp-beispiel-ag-labs-2019');
  expect(master).toMatch(/^- Introduced code review {2}\^/m);
  expect(master).toMatch(/^- German \(Native or bilingual proficiency\) {2}\^lang-german$/m);
  expect(master).not.toMatch(/Undated|Musterstraße|1990|12345|LF-0000|example\.com|Mustermann/); // skipped row, private columns, contact
  expect(stats).toEqual({ entries: 5, bullets: 9, skills: 2 }); // 3 summary + 4 + 1 + 1
  expect(warnings).toEqual(['1 row(s) without a start date skipped; add them in Obsidian']);

  const vault = tmp('aos-contact-');
  mkdirSync(join(vault, 'career'));
  writeFileSync(join(vault, 'career/contact.md'), contact!);
  expect(loadContact(vault)).toEqual({ name: 'Erika Mustermann' });
  expect(contact).toMatch(/^phone: ""$/m);

  const positions = 'COMPANY NAME,Title,Description,Location,Started On,Finished On';
  const odd = buildImport({ 'Positions.csv': `${positions},Salary\nX,Y,,,2020,,100000\n`, 'Skills.csv': '"unclosed\n' }, NOW)!;
  expect(odd.warnings).toEqual(['Positions.csv: unknown column "salary" ignored', 'Skills.csv: not a valid CSV, ignored']);
  expect(odd.master).not.toContain('100000');
  expect(buildImport({ 'Skills.csv': 'Name\nPython\n' })).toBeNull(); // needs Profile or Positions
  // A column it reads is missing (another export version or language): null, so the model path takes over.
  expect(buildImport({ 'Positions.csv': `${positions}\nX,Y,,,2020,\n`, 'Skills.csv': 'Skill\nPython\n' }, NOW)).toBeNull();

  expect([exportDate('Mar 2021'), exportDate('2019'), exportDate('2024-10-05'), exportDate('Spring 2020'), exportDate('')]).toEqual(['2021-03', '2019', '2024-10', null, null]);
  expect(splitBullets('* one\r\n\n– two • three')).toEqual(['one', 'two', 'three']);
});

test('the import folder: only plain files, links never followed, at most 5 MB each', () => {
  const data = tmp('aos-import-');
  const dir = join(data, 'career/import');
  mkdirSync(dir, { recursive: true });
  const outside = join(data, 'outside.csv');
  writeFileSync(outside, readFileSync(join(FIXTURE, 'Profile.csv')));
  try {
    symlinkSync(outside, join(dir, 'Profile.csv'), 'file');
  } catch {
    symlinkSync(data, join(dir, 'Profile.csv'), 'junction'); // Windows without symlink rights: a junction is a link too
  }
  mkdirSync(join(dir, 'Positions.csv')); // a folder with a recognised name
  writeFileSync(join(dir, '..Positions.csv'), 'Company Name,Started On\nX,2020\n'); // traversal-looking names aren't LinkedIn's
  writeFileSync(join(dir, 'Positions.csv..'), 'Company Name,Started On\nX,2020\n');
  writeFileSync(join(dir, 'README'), 'x'); // no extension
  const first = readExport(dir);
  expect(first.files).toEqual({});
  expect(first.sources.map((f) => [f.name, f.known])).toEqual([['..Positions.csv', undefined]]);
  expect(first.warnings).toEqual(['Positions.csv..: skipped: unsupported format (.)', 'Profile.csv: skipped: not a plain file', 'README: skipped: unsupported format (no extension)']);
  expect(readExport(join(data, 'missing'))).toEqual({ sources: [], files: {}, warnings: [] });

  writeFileSync(join(dir, 'skills.CSV'), Buffer.alloc(5 * 1024 * 1024 + 1, 'a'));
  writeFileSync(join(dir, 'Languages.csv'), 'Name\nGerman\n');
  const { files, warnings } = readExport(dir);
  expect(files).toEqual({ 'Languages.csv': 'Name\nGerman\n' });
  expect(warnings).toContain('skills.CSV: skipped: larger than 5 MB');
});

async function setup(llm?: typeof structured) {
  const vault = tmp('aos-career-vault-');
  const data = tmp('aos-career-data-');
  await vaultGit(vault, 'init', '-q', '-b', 'main');
  const t = await buildTestApp({ loggedIn: true, plugins: [approvalRoutes({ vaultDir: vault }), careerMasterRoutes({ vaultDir: vault, dataDir: data, ...(llm ? { llm } : {}) })] });
  const importDir = join(data, 'career/import');
  const post = (url: string, payload: object = {}) => t.app.inject(t.authed({ method: 'POST', url, payload }));
  const imp = () => post('/api/career/master/import');
  const pending = () => t.db.prepare(`SELECT id, payload FROM approvals WHERE status = 'pending'`).all() as { id: number; payload: string }[];
  return { ...t, vault, importDir, imp, post, pending };
}

test('import → one pending approval → approve writes both files as the user’s → master_exists', async () => {
  const t = await setup();
  expect((await t.imp()).json()).toEqual({ error: 'import_empty', warnings: [] }); // no folder yet
  mkdirSync(t.importDir, { recursive: true });
  expect((await t.imp()).statusCode).toBe(400);

  cpSync(FIXTURE, t.importDir, { recursive: true });
  const first = await t.imp();
  expect(first.statusCode).toBe(201);
  const { approval_id } = first.json();
  rmSync(join(t.importDir, 'Skills.csv'));
  expect((await t.imp()).json().approval_id).toBe(approval_id); // replaces the pending payload
  expect(t.pending()).toHaveLength(1);
  const payload = JSON.parse(t.pending()[0]!.payload);
  expect(payload).toMatchObject({ master_hash_before: null, contact_hash_before: null, stats: { skills: 0 } });
  expect(payload.source_files).not.toContain('Skills.csv');

  expect(expireStale(t.db, new Date(Date.now() + 365 * 86_400_000))).toBe(0); // never expires

  expect((await t.post(`/api/approvals/${approval_id}/decide`, { decision: 'approve' })).json()).toEqual({ id: approval_id, status: 'approved' });
  const master = readFileSync(join(t.vault, 'career/master.md'), 'utf8');
  expect(master).toBe(payload.master);
  expect(readFileSync(join(t.vault, 'career/contact.md'), 'utf8')).toBe(payload.contact);
  expect(t.db.prepare(`SELECT path, content_hash, last_written_by FROM vault_notes ORDER BY path`).all()).toEqual([
    { path: 'career/contact.md', content_hash: sha256(payload.contact), last_written_by: 'user' },
    { path: 'career/master.md', content_hash: sha256(master), last_written_by: 'user' },
  ]);
  await vi.waitFor(async () => expect(await vaultGit(t.vault, 'log', '--format=%s')).toBe(`aos: approval ${approval_id}\n`), GIT_WAIT);
  expect((await vaultGit(t.vault, 'show', '--name-only', '--format=')).trim().split('\n').sort()).toEqual(['career/contact.md', 'career/master.md']);

  const again = await t.imp();
  expect([again.statusCode, again.json()]).toEqual([409, { error: 'master_exists' }]);

  const audit = t.db.prepare(`SELECT action, args_redacted FROM audit_log WHERE action != 'auth.login'`).all() as { action: string; args_redacted: string }[];
  expect(audit.map((a) => a.action)).toEqual(['career.master_import.propose', 'career.master_import.propose', 'approval.approve']);
  expect(JSON.stringify(audit)).not.toMatch(/Mustermann|Acme|nightly|Python/);
});

test('import approval is hash-checked: a file changed meanwhile → 409, stays pending, nothing written; reject writes nothing', async () => {
  const t = await setup();
  cpSync(FIXTURE, t.importDir, { recursive: true });
  mkdirSync(join(t.vault, 'career'));
  writeFileSync(join(t.vault, 'career/contact.md'), 'mine');
  const { approval_id } = (await t.imp()).json();
  expect(JSON.parse(t.pending()[0]!.payload).contact_hash_before).toBe(sha256('mine'));

  writeFileSync(join(t.vault, 'career/contact.md'), 'mine, edited');
  const res = await t.post(`/api/approvals/${approval_id}/decide`, { decision: 'approve' });
  expect(res.statusCode).toBe(409);
  expect(res.json().error).not.toMatch(/Mustermann|edited/);
  expect(existsSync(join(t.vault, 'career/master.md'))).toBe(false);
  expect(readFileSync(join(t.vault, 'career/contact.md'), 'utf8')).toBe('mine, edited');
  expect(t.pending()).toHaveLength(1);

  expect((await t.post(`/api/approvals/${approval_id}/decide`, { decision: 'reject' })).json().status).toBe('rejected');
  expect(existsSync(join(t.vault, 'career/master.md'))).toBe(false);
  expect(readFileSync(join(t.vault, 'career/contact.md'), 'utf8')).toBe('mine, edited');
});

// --- Follow-up: subfolders and CV documents (.md, .pdf, .docx) ---
const CV = join(import.meta.dirname, 'fixtures/career/cv');
const CONTACT = `---\nname: "Erika Mustermann"\nemail: "erika@example.com"\nphone: "+49 30 1234567"\nurl: "example.com/erika"\n---\n`;
/** Everything contact-like in the fixture CV: the listed values and the second number, address and link. */
const CONTACT_LIKE = /Mustermann|erika|@|1234567|9876543|example\.(?:com|org|net)|https?:/i;

test('the import folder: subfolders up to three levels; every file is a source or a warning with its reason', () => {
  const dir = join(tmp('aos-import-'), 'import');
  const sub = join(dir, 'Basic_LinkedInDataExport_10-28-2026');
  mkdirSync(join(sub, 'a/b/c'), { recursive: true });
  writeFileSync(join(sub, 'POSITIONS.CSV'), 'Company Name,Started On\nX,2020\n');
  writeFileSync(join(sub, 'a/b/Skills.csv'), 'Name\nDeep\n'); // depth 3: read
  writeFileSync(join(sub, 'a/b/c/Skills.csv'), 'Name\nTooDeep\n'); // depth 4: not
  writeFileSync(join(sub, 'Connections.csv'), 'First Name\nMax\n');
  writeFileSync(join(sub, 'Endorsement_Received_Info.csv'), 'x\n');
  writeFileSync(join(sub, 'Learning.csv'), 'x\n');
  writeFileSync(join(dir, 'export.zip'), 'PK');
  writeFileSync(join(dir, 'cv.xlsx'), 'x');
  writeFileSync(join(dir, 'machine-learning-cv.md'), '# a document is never "not CV data"');
  const { sources, files, warnings } = readExport(dir);
  expect(files).toEqual({ 'Positions.csv': 'Company Name,Started On\nX,2020\n', 'Skills.csv': 'Name\nDeep\n' });
  expect(sources.map((f) => [f.name, f.known])).toEqual([
    ['machine-learning-cv.md', undefined],
    ['Basic_LinkedInDataExport_10-28-2026/POSITIONS.CSV', 'Positions.csv'],
    ['Basic_LinkedInDataExport_10-28-2026/a/b/Skills.csv', 'Skills.csv'],
  ]);
  expect(warnings).toEqual([
    'cv.xlsx: skipped: unsupported format (.xlsx)',
    'export.zip: skipped: a .zip file; unzip it into this folder first',
    'Basic_LinkedInDataExport_10-28-2026/Connections.csv: skipped: not CV data',
    'Basic_LinkedInDataExport_10-28-2026/Endorsement_Received_Info.csv: skipped: not CV data',
    'Basic_LinkedInDataExport_10-28-2026/Learning.csv: skipped: not CV data',
    'Basic_LinkedInDataExport_10-28-2026/a/b/c/: skipped: more than 3 folders deep',
  ]);
});

test('CV text: .md, .docx and .pdf extract; a broken file is null; Windows-1252 text reads; contact-like runs go, dates stay', async () => {
  for (const f of ['cv.md', 'cv.docx', 'cv.pdf']) {
    const text = await documentText(f, readFileSync(join(CV, f)));
    expect(text).toContain('Cut the nightly build from 12 to 4 minutes.');
    expect(text).toContain('Acme GmbH, Senior Engineer, Berlin, 2021-03 - present');
  }
  expect(await documentText('cv.pdf', Buffer.from('%PDF-1.4 not really'))).toBeNull();
  expect(await documentText('cv.docx', Buffer.from('PK nope'))).toBeNull();
  // Not UTF-8: read as Windows-1252, as Excel saves a CSV ("Company,City\nAcme,München").
  expect(await documentText('cv.csv', Buffer.from('Company,City\nAcme,M\xfcnchen', 'latin1'))).toBe('Company: Acme\nCity: München');

  expect(scrubContactLike('a.b@x.de, +49 (0)30 123-4567, 030/1234567, www.x.de, https://x.io/a, x.dev/me')).toBe('[email], [phone], [phone], [url], [url], [url]');
  const kept = '2019 - 2021, 03/2021 - 06/2024, 01.02.1990, 4 to 12 minutes, v1.2.3, e.g. this';
  expect(scrubContactLike(kept)).toBe(kept);
});

/** What a careless model might answer: some text copied, some invented, an id it must not choose. */
const answer = () => ({
  summary: ['Backend engineer focused on data pipelines.', 'Award-winning visionary leader.'],
  experience: [
    { org: 'Acme GmbH', title: 'Senior Engineer', start: '2021-03', end: 'present', location: 'Berlin', bullets: ['Cut the  nightly build from 12 to 4 minutes.', 'Led a team of 40 engineers.'], id: 'evil' },
    { org: 'Fake Corp', title: 'CTO', start: '2015', end: '2018', location: '', bullets: ['Invented everything.'] },
  ],
  education: [],
  projects: [],
  certifications: [],
  skills: ['Python', 'PostgreSQL', 'Rust', 'SQL'], // SQL only inside PostgreSQL
  languages: ['German (C1)'],
});

test('a CV document needs contact.md with a name first: contact_missing creates an empty template once', async () => {
  const llm = capturePrompts(answer);
  const t = await setup(llm.llm);
  mkdirSync(t.importDir, { recursive: true });
  cpSync(join(CV, 'cv.md'), join(t.importDir, 'cv.md'));
  const res = await t.imp();
  expect([res.statusCode, res.json().error]).toEqual([409, 'contact_missing']);
  expect(res.json().warnings).toContain('career/contact.md created');
  const template = readFileSync(join(t.vault, 'career/contact.md'), 'utf8');
  expect(template).toMatch(/^name: ""$/m);
  expect(loadContact(t.vault)).toEqual({});
  expect((await t.imp()).json().error).toBe('contact_missing'); // still no name
  expect(readFileSync(join(t.vault, 'career/contact.md'), 'utf8')).toBe(template); // never overwritten
  expect(llm.calls).toHaveLength(0);
  expect(t.pending()).toHaveLength(0);
});

test('CV document import: nothing contact-like reaches the model, invented text is dropped, approve writes master.md only', async () => {
  const llm = capturePrompts(answer);
  const t = await setup(llm.llm);
  mkdirSync(join(t.vault, 'career'));
  writeFileSync(join(t.vault, 'career/contact.md'), CONTACT);
  mkdirSync(join(t.importDir, 'cv'), { recursive: true });
  cpSync(join(CV, 'cv.pdf'), join(t.importDir, 'cv', 'Erika_CV.pdf'));

  const res = await t.imp();
  expect(res.statusCode).toBe(201);
  expect(res.json().warnings).toEqual(['5 item(s) not found word for word in the CV were dropped; add them in Obsidian']);
  expect(llm.calls).toHaveLength(1);
  expect(llm.calls[0]!.input).toContain('Cut the nightly build from 12 to 4 minutes.');
  expect(llm.text()).not.toMatch(CONTACT_LIKE);

  const payload = JSON.parse(t.pending()[0]!.payload);
  expect(payload).not.toHaveProperty('contact');
  expect(payload).toMatchObject({ source_files: ['cv/Erika_CV.pdf'], master_hash_before: null, stats: { entries: 1, bullets: 2, skills: 2 } });
  expect(payload.master).toContain('### Acme GmbH | Senior Engineer | 2021-03 | present | Berlin  ^exp-acme-gmbh-2021\n');
  expect(payload.master).toMatch(/^- Cut the nightly build from 12 to 4 minutes\. {2}\^exp-acme-gmbh-2021-[0-9a-f]{6}$/m);
  expect(payload.master).toMatch(/^- German \(C1\) {2}\^lang-german$/m);
  expect(payload.master).not.toMatch(/Award|40 engineers|Fake Corp|Invented|Rust|evil|Mustermann/);
  expect(validateMaster(payload.master)).toBeNull();
  const audit = t.db.prepare(`SELECT args_redacted FROM audit_log WHERE action = 'career.master_import.propose'`).pluck().get() as string;
  expect(audit).toContain('document.pdf');
  expect(audit).not.toMatch(/Erika/);

  const { approval_id } = res.json();
  expect((await t.post(`/api/approvals/${approval_id}/decide`, { decision: 'approve' })).json().status).toBe('approved');
  expect(readFileSync(join(t.vault, 'career/master.md'), 'utf8')).toBe(payload.master);
  expect(readFileSync(join(t.vault, 'career/contact.md'), 'utf8')).toBe(CONTACT); // the owner's, untouched
  expect(t.db.prepare('SELECT path FROM vault_notes').pluck().all()).toEqual(['career/master.md']);
  await vi.waitFor(async () => expect(await vaultGit(t.vault, 'log', '--format=%s')).toBe(`aos: approval ${approval_id}\n`), GIT_WAIT);
});

test('CV document import: an unreadable file → import_unreadable, a failing model → provider_error, nothing proposed', async () => {
  const failing = capturePrompts(() => {
    throw new LlmError('overloaded', 'upstream 529', 529);
  });
  const t = await setup(failing.llm);
  mkdirSync(join(t.vault, 'career'));
  writeFileSync(join(t.vault, 'career/contact.md'), CONTACT);
  mkdirSync(t.importDir, { recursive: true });
  writeFileSync(join(t.importDir, 'cv.docx'), 'PK broken');
  const bad = await t.imp();
  expect([bad.statusCode, bad.json()]).toEqual([400, { error: 'import_unreadable', warnings: ['cv.docx: skipped: could not be read'] }]);

  rmSync(join(t.importDir, 'cv.docx'));
  cpSync(join(CV, 'cv.docx'), join(t.importDir, 'cv.docx'));
  const res = await t.imp();
  expect([res.statusCode, res.json()]).toEqual([502, { error: 'provider_error' }]);
  expect(failing.text()).not.toMatch(CONTACT_LIKE);
  expect(t.pending()).toHaveLength(0);
});

// --- Any format, no fixed file or column names ---
test('any file and column names: tables, text and JSON reach the model as text; other people’s data, file names and the over-budget rest never do', async () => {
  const llm = capturePrompts(answer);
  const t = await setup(llm.llm);
  mkdirSync(join(t.vault, 'career'));
  writeFileSync(join(t.vault, 'career/contact.md'), CONTACT);
  const sub = join(t.importDir, 'export');
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(t.importDir, 'Lebenslauf_Zebrafink.csv'), 'Arbeitgeber,Rolle,Zeitraum,Ort,Leer\nAcme GmbH,Senior Engineer,2021-03 bis heute,Berlin,\n');
  writeFileSync(join(sub, 'Positions.csv'), 'Firma,Position,Beginn\nBeispiel AG,Intern,2019\n'); // LinkedIn's name, other columns
  writeFileSync(join(sub, 'Profile.csv'), 'Headline,Address,Birth Date,Zip Code\nBackend engineer,Musterweg 5,1990-01-01,10115\n'); // private columns dropped
  writeFileSync(join(sub, 'Connections.csv'), 'First Name,Last Name,Company\nZacharias,Quellenfeld,Foo AG\n');
  writeFileSync(join(t.importDir, 'Zebrafink-notes.txt'), 'Cut the nightly build from 12 to 4 minutes.\n');
  writeFileSync(join(t.importDir, 'Zebrafink-profile.json'), '{"skills":["Python","PostgreSQL"],"languages":["German (C1)"]}');
  writeFileSync(join(t.importDir, 'Zebrafink-big.txt'), 'lorem '.repeat(9000)); // 54,000 characters: over the budget
  writeFileSync(join(t.importDir, 'cv.xlsx'), 'PK');
  writeFileSync(join(t.importDir, 'cv.doc'), 'old Word');

  const res = await t.imp();
  expect(res.statusCode).toBe(201);
  expect(res.json().warnings).toEqual(
    expect.arrayContaining([
      'cv.doc: skipped: unsupported format (.doc)',
      'cv.xlsx: skipped: unsupported format (.xlsx)',
      'export/Connections.csv: skipped: not CV data',
      'Zebrafink-big.txt: skipped: over the size budget',
    ]),
  );
  expect(llm.calls).toHaveLength(1);
  const input = llm.calls[0]!.input;
  expect(input).toContain('--- file 1 (txt) ---\nCut the nightly build'); // documents first, then data files, smallest first
  expect(input).toContain('Arbeitgeber: Acme GmbH\nRolle: Senior Engineer\nZeitraum: 2021-03 bis heute\nOrt: Berlin\n');
  expect(input).not.toContain('Leer:'); // empty cells are left out
  expect(input).toContain('Firma: Beispiel AG\nPosition: Intern\nBeginn: 2019');
  expect(input).toContain('"skills": [\n    "Python",');
  expect(input).toContain('Headline: Backend engineer\n');
  expect(input).not.toMatch(/lorem|Musterweg|1990|10115|Address|Birth/);
  expect(llm.text()).not.toMatch(/Zebrafink|Lebenslauf|Positions|Profile|Connections|Zacharias|Quellenfeld|\.csv|\.json|\.txt/);
  expect(llm.text()).not.toMatch(CONTACT_LIKE);

  const payload = JSON.parse(t.pending()[0]!.payload);
  expect(payload.source_files.sort()).toEqual(['Lebenslauf_Zebrafink.csv', 'Zebrafink-notes.txt', 'Zebrafink-profile.json', 'export/Positions.csv', 'export/Profile.csv']);
  expect(payload).not.toHaveProperty('contact');
  expect(payload.master).toMatch(/^### Acme GmbH \| Senior Engineer \| 2021-03 \| present \| Berlin {2}\^exp-acme-gmbh-2021$/m);
  expect(payload.master).toMatch(/^- Cut the nightly build from 12 to 4 minutes\. {2}\^/m);
  const audit = t.db.prepare(`SELECT args_redacted FROM audit_log WHERE action = 'career.master_import.propose'`).pluck().get() as string;
  expect(audit).not.toMatch(/Zebrafink|Lebenslauf|Positions/);
});

test('nothing usable: only unsupported files → import_empty, supported but empty → import_unreadable, both explained', async () => {
  const t = await setup(capturePrompts(answer).llm);
  mkdirSync(join(t.vault, 'career'));
  writeFileSync(join(t.vault, 'career/contact.md'), CONTACT);
  mkdirSync(t.importDir, { recursive: true });
  writeFileSync(join(t.importDir, 'cv.pages'), 'x');
  writeFileSync(join(t.importDir, 'messages.csv'), 'From,To,Content\nA,B,hi\n');
  expect((await t.imp()).json()).toEqual({
    error: 'import_empty',
    warnings: ['cv.pages: skipped: unsupported format (.pages)', 'messages.csv: skipped: not CV data'],
  });
  writeFileSync(join(t.importDir, 'cv.json'), '  \n');
  writeFileSync(join(t.importDir, 'table.tsv'), 'Header only\n');
  expect((await t.imp()).json()).toEqual({
    error: 'import_unreadable',
    warnings: ['cv.pages: skipped: unsupported format (.pages)', 'messages.csv: skipped: not CV data', 'cv.json: skipped: no text', 'table.tsv: skipped: no text'],
  });
});

// --- The owner's direct edits: GET / PUT /api/career/master ---

const masterRoutes = async () => {
  const t = await setup();
  const file = join(t.vault, 'career/master.md');
  const get = () => t.app.inject(t.authed({ method: 'GET', url: '/api/career/master' }));
  const put = (payload: object) => t.app.inject(t.authed({ method: 'PUT', url: '/api/career/master', payload }));
  const notes = () => t.db.prepare(`SELECT path, content_hash, last_written_by FROM vault_notes`).all();
  const saves = () => t.db.prepare(`SELECT args_redacted FROM audit_log WHERE action = 'career.master.save'`).pluck().all().map((a) => JSON.parse(a as string));
  const seed = (text = MASTER) => {
    mkdirSync(join(t.vault, 'career'), { recursive: true });
    writeFileSync(file, text);
    return sha256(text);
  };
  return { ...t, file, get, put, notes, saves, seed };
};

test('GET: missing → exists false; valid → the parsed sections with ids; unparseable → the fixed error', async () => {
  const t = await masterRoutes();
  expect((await t.get()).json()).toEqual({ exists: false });
  const hash = t.seed();
  expect((await t.get()).json()).toEqual({ exists: true, hash, sections: parseMaster(MASTER).sections });
  const bad = MASTER.replace('## Skills', '## Secret hobbies');
  t.seed(bad);
  expect((await t.get()).json()).toEqual({ exists: true, hash: sha256(bad), error: 'master.md line 20: unknown section' });
});

test('PUT creates the master from scratch: ids by code, the user’s file, committed, audit counts only', async () => {
  const t = await masterRoutes();
  const sections = [
    { name: 'Summary', bullets: [{ text: 'Backend engineer.' }] },
    { name: 'Experience', entries: [{ org: 'Acme GmbH', title: 'Engineer', start: '2021-03', end: 'present', location: 'Berlin', bullets: [{ text: ' Cut builds. ' }] }] },
    { name: 'Projects', entries: [] }, // empty: dropped
    { name: 'Skills', bullets: [{ text: 'Python' }, { text: 'Python' }] },
    { name: 'Languages', bullets: [{ text: 'German (C1)' }] },
  ];
  const res = await t.put({ hash: null, sections });
  expect(res.statusCode).toBe(200);
  const text = readFileSync(t.file, 'utf8');
  expect(res.json()).toEqual({ exists: true, hash: sha256(text), sections: parseMaster(text).sections });
  expect((await t.get()).json()).toEqual(res.json());
  const ids = parseMaster(text).sections.flatMap((s) => ('bullets' in s ? s.bullets : s.entries.flatMap((e) => [e, ...e.bullets]))).map((x) => x.id);
  expect(ids).toEqual(['sum-1', 'exp-acme-gmbh-2021', bulletIdBase('exp-acme-gmbh-2021', 'Cut builds.'), 'skill-python', 'skill-python-2', 'lang-german']);
  expect(text).toContain('- Cut builds.  ^'); // trimmed
  expect(parseMaster(text).fm).toMatchObject({ id: 'career-master', area: 'career', sensitivity: 2, source: 'web' });
  expect(t.notes()).toEqual([{ path: 'career/master.md', content_hash: sha256(text), last_written_by: 'user' }]);
  await vi.waitFor(async () => expect(await vaultGit(t.vault, 'log', '--format=%s')).toBe('aos: edit career/master.md\n'), GIT_WAIT);
  expect(t.saves()).toEqual([{ sections: 4, entries: 1, bullets: 5 }]);
});

test('PUT edits: kept ids stay, new items get fresh ids that never clash, reorder and delete, frontmatter kept', async () => {
  const t = await masterRoutes();
  const hash = t.seed();
  const res = await t.put({
    hash,
    sections: [
      { name: 'Skills', bullets: [{ text: 'Go' }, { id: 'skill-python', text: 'Python 3' }] }, // moved first, reordered
      { name: 'Summary', bullets: [{ id: 'sum-1', text: 'Backend engineer.' }, { text: 'Second line.' }] },
      {
        name: 'Experience',
        entries: [
          { id: 'exp-beispiel-2019', org: 'Beispiel AG', title: 'Dev', start: '2019', end: 'present', location: '', bullets: [] },
          {
            id: 'exp-acme-2021',
            org: 'Acme GmbH',
            title: 'Senior Engineer',
            start: '2021-03',
            end: '2024-06',
            location: 'Berlin',
            bullets: [{ text: 'New bullet.' }, { id: 'exp-acme-2021-b27e04', text: 'Led a team of 5 engineers.' }], // 3f9a1c deleted
          },
          { org: 'Acme', title: 'Intern', start: '2021', end: '2021', location: '', bullets: [] }, // base exp-acme-2021 is taken
        ],
      },
    ],
  });
  expect(res.statusCode).toBe(200);
  const m = parseMaster(readFileSync(t.file, 'utf8'));
  expect(res.json().sections).toEqual(m.sections);
  expect(m.sections.map((s) => s.name)).toEqual(['Skills', 'Summary', 'Experience']);
  expect(m.sections[0]).toEqual({ name: 'Skills', bullets: [{ id: 'skill-go', text: 'Go' }, { id: 'skill-python', text: 'Python 3' }] });
  expect(m.sections[1]).toEqual({ name: 'Summary', bullets: [{ id: 'sum-1', text: 'Backend engineer.' }, { id: 'sum-2', text: 'Second line.' }] });
  const exp = m.sections[2] as Extract<Section, { entries: unknown }>;
  expect(exp.entries.map((e) => e.id)).toEqual(['exp-beispiel-2019', 'exp-acme-2021', 'exp-acme-2021-2']);
  expect(exp.entries[1]!.bullets).toEqual([
    { id: bulletIdBase('exp-acme-2021', 'New bullet.'), text: 'New bullet.' },
    { id: 'exp-acme-2021-b27e04', text: 'Led a team of 5 engineers.' },
  ]);
  expect(m.fm).toMatchObject({ created: '2026-10-01T00:00:00.000Z', source: 'hand' });
  expect(m.fm.updated).not.toBe('2026-10-01T00:00:00.000Z');
  expect(t.saves()).toEqual([{ sections: 3, entries: 3, bullets: 6 }]);
  expect(JSON.stringify(t.saves())).not.toMatch(/Acme|Beispiel|Python|engineer/i);

  // The old hash is stale now: 409, nothing written.
  const now = readFileSync(t.file, 'utf8');
  expect([(await t.put({ hash, sections: [] })).statusCode, readFileSync(t.file, 'utf8')]).toEqual([409, now]);
  await vi.waitFor(async () => expect(await vaultGit(t.vault, 'log', '--format=%s')).toBe('aos: edit career/master.md\n'), GIT_WAIT);
});

test('PUT on a stale hash (edited in Obsidian meanwhile) → 409 master_changed, nothing written', async () => {
  const t = await masterRoutes();
  const sections = [{ name: 'Summary', bullets: [{ text: 'Hi.' }] }];
  const res = await t.put({ hash: sha256('something else'), sections });
  expect([res.statusCode, res.json()]).toEqual([409, { error: 'master_changed' }]);
  expect(existsSync(t.file)).toBe(false);
  const hash = t.seed();
  expect((await t.put({ hash: null, sections })).json()).toEqual({ error: 'master_changed' }); // it exists now
  expect(readFileSync(t.file, 'utf8')).toBe(MASTER);
  expect([t.notes(), t.saves()]).toEqual([[], []]);
  expect((await t.put({ hash, sections })).statusCode).toBe(200);
  await vi.waitFor(async () => expect(await vaultGit(t.vault, 'log', '--format=%s')).toBe('aos: edit career/master.md\n'), GIT_WAIT);
});

test('PUT rejects a bad shape, a broken line and an unknown or repeated id with 400 bad_master, writing nothing', async () => {
  const t = await masterRoutes();
  const hash = t.seed();
  const entry = { id: 'exp-acme-2021', org: 'Acme GmbH', title: 'T', start: '2021', end: 'present', location: '', bullets: [] };
  const exp = (e: object) => [{ name: 'Experience', entries: [{ ...entry, ...e }] }];
  const bad = [
    { sections: [] }, // no hash
    { hash, sections: [{ name: 'Hobbies', bullets: [{ text: 'x' }] }] },
    { hash, sections: [{ name: 'Skills', bullets: [{ text: 'a' }] }, { name: 'Skills', bullets: [{ text: 'b' }] }] }, // repeated section
    { hash, sections: [{ name: 'Experience', bullets: [{ text: 'x' }] }] }, // wrong kind of section
    { hash, sections: [{ name: 'Skills', bullets: [{ text: 'Secret\nline' }] }] }, // newline
    { hash, sections: [{ name: 'Skills', bullets: [{ text: 'Secret  ^injected' }] }] }, // would read as an id
    { hash, sections: [{ name: 'Skills', bullets: [{ text: '   ' }] }] }, // empty after trimming
    { hash, sections: [{ name: 'Skills', bullets: [{ text: 'x'.repeat(2001) }] }] },
    { hash, sections: exp({ org: 'Secret | Org' }) }, // `|` in a header field
    { hash, sections: exp({ start: 'June 2021' }) },
    { hash, sections: exp({ end: '2021-13' }) },
    { hash, sections: exp({ title: undefined }) },
    { hash, sections: exp({ id: 'exp-nope-2020' }) }, // unknown id
    { hash, sections: exp({ id: 'skill-python' }) }, // a bullet's id on an entry
    { hash, sections: [{ name: 'Skills', bullets: [{ id: 'skill-python', text: 'a' }, { id: 'skill-python', text: 'b' }] }] }, // repeated id
    { hash, sections: [{ name: 'Skills', bullets: [{ id: 'Bad_Id', text: 'a' }] }] },
  ];
  for (const payload of bad) {
    const res = await t.put(payload);
    expect([res.statusCode, res.json()]).toEqual([400, { error: 'bad_master' }]);
  }
  expect(readFileSync(t.file, 'utf8')).toBe(MASTER);
  expect([t.notes(), t.saves()]).toEqual([[], []]);
});
