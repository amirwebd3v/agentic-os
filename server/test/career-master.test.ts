import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { expireStale } from '../src/approvals/expire.ts';
import { loadContact } from '../src/career/contact.ts';
import { buildImport, exportDate, readExport, splitBullets } from '../src/career/linkedin.ts';
import { parseMaster, serialiseMaster, validateMaster } from '../src/career/master.ts';
import { approvalRoutes } from '../src/http/routes/approvals.ts';
import { careerMasterRoutes } from '../src/http/routes/career-master.ts';
import { sha256, vaultGit } from '../src/vault/writer.ts';
import { buildTestApp } from './helpers.ts';

const FIXTURE = join(import.meta.dirname, 'fixtures/career/linkedin');
const NOW = new Date('2026-10-28T10:00:00.000Z');
const dirs: string[] = [];
const tmp = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

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
  writeFileSync(join(vault, 'career/contact.md'), contact);
  expect(loadContact(vault)).toEqual({ name: 'Erika Mustermann' });
  expect(contact).toMatch(/^phone: ""$/m);

  const odd = buildImport({ 'Positions.csv': 'COMPANY NAME,Title,Started On,Salary\nX,Y,2020,100000\n', 'Skills.csv': '"unclosed\n' }, NOW)!;
  expect(odd.warnings).toEqual(['Positions.csv: unknown column "salary" ignored', 'Skills.csv: not a valid CSV, ignored']);
  expect(odd.master).not.toContain('100000');
  expect(buildImport({ 'Skills.csv': 'Name\nPython\n' })).toBeNull(); // needs Profile or Positions

  expect([exportDate('Mar 2021'), exportDate('2019'), exportDate('2024-10-05'), exportDate('Spring 2020'), exportDate('')]).toEqual(['2021-03', '2019', '2024-10', null, null]);
  expect(splitBullets('* one\r\n\n– two • three')).toEqual(['one', 'two', 'three']);
});

test('the import folder: only plain files directly inside, at most 5 MB each', () => {
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
  writeFileSync(join(dir, '..Positions.csv'), 'Company Name,Started On\nX,2020\n'); // traversal-looking names don't match
  writeFileSync(join(dir, 'Positions.csv..'), 'Company Name,Started On\nX,2020\n');
  expect(readExport(dir)).toEqual({ files: {}, warnings: [] });
  expect(readExport(join(data, 'missing'))).toEqual({ files: {}, warnings: [] });

  writeFileSync(join(dir, 'skills.CSV'), Buffer.alloc(5 * 1024 * 1024 + 1, 'a'));
  writeFileSync(join(dir, 'Languages.csv'), 'Name\nGerman\n');
  expect(readExport(dir)).toEqual({ files: { 'Languages.csv': 'Name\nGerman\n' }, warnings: ['Skills.csv: larger than 5 MB, ignored'] });
});

async function setup() {
  const vault = tmp('aos-career-vault-');
  const data = tmp('aos-career-data-');
  await vaultGit(vault, 'init', '-q', '-b', 'main');
  const t = await buildTestApp({ loggedIn: true, plugins: [approvalRoutes({ vaultDir: vault }), careerMasterRoutes({ vaultDir: vault, dataDir: data })] });
  const importDir = join(data, 'career/import');
  const post = (url: string, payload: object = {}) => t.app.inject(t.authed({ method: 'POST', url, payload }));
  const imp = () => post('/api/career/master/import');
  const pending = () => t.db.prepare(`SELECT id, payload FROM approvals WHERE status = 'pending'`).all() as { id: number; payload: string }[];
  return { ...t, vault, importDir, imp, post, pending };
}

test('import → one pending approval → approve writes both files as the user’s → master_exists', async () => {
  const t = await setup();
  expect((await t.imp()).json()).toEqual({ error: 'import_empty' }); // no folder yet
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
  await vi.waitFor(async () => expect(await vaultGit(t.vault, 'log', '--format=%s')).toBe(`aos: approval ${approval_id}\n`));
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
