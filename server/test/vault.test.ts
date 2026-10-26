import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Database } from '../src/db/index.ts';
import { parseAreas, syncAreas } from '../src/vault/areas.ts';
import { parseNote } from '../src/vault/frontmatter.ts';
import { VAULT_FOLDERS, initVault } from '../src/vault/init.ts';
import { watchVault } from '../src/vault/watch.ts';
import { createWriter } from '../src/vault/writer.ts';
import { makeTestDb } from './helpers.ts';

const template = readFileSync(new URL('../templates/CLAUDE.md', import.meta.url), 'utf8');
const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
const count = (db: Database, sql: string) => (db.prepare(sql).get() as { n: number }).n;

let dir: string, db: Database, w: ReturnType<typeof createWriter>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vault-'));
  db = makeTestDb();
  w = createWriter({ db, vaultDir: dir, commit: false });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test('never overwrites a user-edited note', () => {
  expect(w.writeNote('wiki/a.md', 'v1', { area: 'career' })).toBe('written');
  writeFileSync(join(dir, 'wiki/a.md'), 'edited in obsidian');
  expect(w.writeNote('wiki/a.md', 'v2', { area: 'career' })).toBe('conflict');
  expect(readFileSync(join(dir, 'wiki/a.md'), 'utf8')).toBe('edited in obsidian');
  expect(count(db, "SELECT count(*) n FROM approvals WHERE action_type='vault_conflict'")).toBe(1);
  const payload = JSON.parse((db.prepare('SELECT payload FROM approvals').get() as { payload: string }).payload);
  expect(payload).toMatchObject({ path: 'wiki/a.md' });
  expect(parseNote(payload.content).body.trim()).toBe('v2');
});

test('never overwrites a file the app did not write', () => {
  mkdirSync(join(dir, 'inbox'));
  writeFileSync(join(dir, 'inbox/mine.md'), 'my own note');
  expect(w.writeNote('inbox/mine.md', 'x', { area: 'career' })).toBe('conflict');
  expect(readFileSync(join(dir, 'inbox/mine.md'), 'utf8')).toBe('my own note');
});

test('rewrites its own note atomically, keeping id and created', () => {
  w.writeNote('wiki/a.md', 'v1', { area: 'career', tags: ['x'] });
  const first = parseNote(readFileSync(join(dir, 'wiki/a.md'), 'utf8'));
  expect(first.fm).toMatchObject({ area: 'career', tags: ['x'], sensitivity: 1, source: 'app' });
  expect(w.writeNote('wiki/a.md', 'v2', { area: 'career' })).toBe('written');
  const second = parseNote(readFileSync(join(dir, 'wiki/a.md'), 'utf8'));
  expect(second.body.trim()).toBe('v2');
  expect(second.fm.id).toBe(first.fm.id);
  expect(second.fm.created).toBe(first.fm.created);
  expect(existsSync(join(dir, 'wiki/a.md.tmp'))).toBe(false);
  expect(db.prepare('SELECT last_written_by FROM vault_notes WHERE path = ?').get('wiki/a.md')).toEqual({ last_written_by: 'app' });
});

test('rejects path traversal and protected folders', () => {
  for (const p of ['../outside.md', 'wiki/../../outside.md', join(tmpdir(), 'abs.md'), 'C:evil.md', '.git/hooks/x.md', '.obsidian/x.md', 'wiki/a.txt', '']) {
    expect(() => w.writeNote(p, 'x', { area: 'career' }), p).toThrow();
  }
  expect(count(db, 'SELECT count(*) n FROM vault_notes')).toBe(0);
});

test('rejects a parent folder that links outside the vault', () => {
  const outside = mkdtempSync(join(tmpdir(), 'outside-'));
  try {
    symlinkSync(outside, join(dir, 'link'), 'junction');
    expect(() => w.writeNote('link/x.md', 'x', { area: 'career' })).toThrow(/escapes/);
    expect(existsSync(join(outside, 'x.md'))).toBe(false);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('frontmatter accepts unquoted YAML dates', () => {
  const { fm } = parseNote('---\nid: a\narea: career\nsensitivity: 0\nsource: user\ncreated: 2026-10-26\nupdated: 2026-10-26T10:00:00Z\n---\nbody');
  expect(fm).toMatchObject({ created: '2026-10-26T00:00:00.000Z', updated: '2026-10-26T10:00:00.000Z', tags: [] });
  expect(() => parseNote('---\narea: career\n---\n')).toThrow();
});

test('watcher records an Obsidian edit, and the writer then refuses to overwrite', async () => {
  w.writeNote('wiki/a.md', 'v1', { area: 'career' });
  const watcher = watchVault({ db, vaultDir: dir });
  try {
    await new Promise<void>((r) => watcher.once('ready', () => r()));
    writeFileSync(join(dir, 'wiki/a.md'), 'edited in obsidian');
    writeFileSync(join(dir, 'wiki/ignored.txt'), 'not a note');
    await vi.waitFor(() => expect(count(db, "SELECT count(*) n FROM audit_log WHERE action = 'vault.user_edit'")).toBe(1), {
      timeout: 5000,
    });
  } finally {
    await watcher.close();
  }
  expect(db.prepare('SELECT last_written_by FROM vault_notes WHERE path = ?').get('wiki/a.md')).toEqual({ last_written_by: 'user' });
  expect(w.writeNote('wiki/a.md', 'v2', { area: 'career' })).toBe('conflict');
  expect(readFileSync(join(dir, 'wiki/a.md'), 'utf8')).toBe('edited in obsidian');
});

test('initVault is idempotent, local-only, and the writer commits to it', async () => {
  expect(await initVault(dir)).toEqual(['.gitignore', '.obsidian/app.json', 'CLAUDE.md', 'persona/_questions.md']);
  for (const f of VAULT_FOLDERS) expect(existsSync(join(dir, f)), f).toBe(true);
  expect(JSON.parse(readFileSync(join(dir, '.obsidian/app.json'), 'utf8'))).toEqual({
    attachmentFolderPath: 'attachments',
    newLinkFormat: 'shortest',
    useMarkdownLinks: false,
  });
  expect(git(dir, 'remote').trim()).toBe('');

  writeFileSync(join(dir, 'CLAUDE.md'), 'my rules');
  expect(await initVault(dir)).toEqual([]);
  expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toBe('my rules');

  const committing = createWriter({ db, vaultDir: dir });
  committing.writeNote('journal/2026-10-26.md', 'hello', { area: 'personal-reflection' });
  await committing.flush();
  expect(git(dir, 'log', '--format=%s')).toMatch(/^aos: update 1 note\naos: init vault\n$/);

  git(dir, 'remote', 'add', 'origin', 'https://example.com/x.git');
  await expect(initVault(dir)).rejects.toThrow(/remote/);
});

test('template areas match the seeded ones, so first sync only adds descriptions', () => {
  const areas = parseAreas(template);
  const seeded = db.prepare('SELECT slug, name, mode FROM areas ORDER BY id').all();
  expect(areas.map(({ slug, name, mode }) => ({ slug, name, mode }))).toEqual(seeded);
  expect(syncAreas(db, areas)).toEqual({ changed: 10, archived: [] });
  expect(syncAreas(db, areas)).toEqual({ changed: 0, archived: [] });
});

test('removed areas are archived, never deleted, and come back when re-listed', () => {
  const areas = parseAreas(template);
  syncAreas(db, areas.filter((a) => a.slug !== 'health'));
  expect(db.prepare("SELECT status FROM areas WHERE slug = 'health'").get()).toEqual({ status: 'archived' });
  expect(count(db, 'SELECT count(*) n FROM areas')).toBe(10);
  expect(syncAreas(db, areas).changed).toBe(1);
  expect(db.prepare("SELECT status FROM areas WHERE slug = 'health'").get()).toEqual({ status: 'active' });
});

test('a malformed or empty area list stops the sync instead of archiving', () => {
  expect(() => parseAreas(template.replace('- `health` | Health | do |', '- health | Health | do |'))).toThrow(/Malformed/);
  expect(() => parseAreas('# Rules\n\n## Areas\n\n## Other\n- `x` | X | do | y')).toThrow(/no areas/);
  expect(() => parseAreas('# Rules')).toThrow(/no "## Areas"/);
});
