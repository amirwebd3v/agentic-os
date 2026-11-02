import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { Database } from '../src/db/index.ts';
import { saveIdea } from '../src/mail/ideas.ts';
import { makeTestDb } from './helpers.ts';

const [BLOG, PERSONAL] = [1, 5];
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(text = 'Vue 4 could carry a *post* <script>x</script> [link](javascript:x)') {
  const vault = mkdtempSync(join(tmpdir(), 'aos-ideas-'));
  dirs.push(vault);
  const db = makeTestDb();
  db.prepare(`INSERT INTO mail_accounts (email) VALUES ('a@example.com')`).run();
  const id = db.prepare(`INSERT INTO mail_messages (account_id, gmail_id, internal_date, state, category_id, sender, subject, excerpt, eligible) VALUES (1, 'g/1', '2026-11-01', 'filed', ${BLOG}, 's', 'Secret subject', 'Secret excerpt', 1) RETURNING id`).pluck().get() as number;
  db.prepare(`INSERT INTO mail_analyses (category_id, day, text, cites, status, created_at) VALUES (${BLOG}, '2026-11-02', ?, ?, 'ok', '2026-11-02T08:00:00.000Z')`).run(text, JSON.stringify([id]));
  return { db, vault, id };
}
const notes = (vault: string) => readdirSync(join(vault, 'ideas'));

describe('save idea', () => {
  test('writes an untrusted note with the paragraph quoted and links built from ids, and no mail text', async () => {
    const { db, vault } = setup();
    const out = await saveIdea(db, vault, BLOG);
    expect(out).toMatchObject({ saved: true, path: expect.stringMatching(/^ideas\/2026-11-02-blog-ideas-[0-9a-f]{10}\.md$/) });
    const note = readFileSync(join(vault, out!.path), 'utf8');
    expect(note).toMatch(/trust: untrusted/);
    expect(note).toMatch(/source: email/);
    expect(note).toContain('> Vue 4 could carry a \\*post\\* \\<script\\>x\\</script\\> \\[link\\](javascript:x)');
    expect(note).toContain('(https://mail.google.com/mail/?authuser=a%40example.com#all/g%2F1)');
    expect(note).not.toContain('Secret');
  });

  test('saving twice is a no-op, and an edited note is never overwritten', async () => {
    const { db, vault } = setup();
    const first = await saveIdea(db, vault, BLOG);
    writeFileSync(join(vault, first!.path), 'my own words');
    expect(await saveIdea(db, vault, BLOG)).toEqual({ saved: false, path: first!.path });
    expect(readFileSync(join(vault, first!.path), 'utf8')).toBe('my own words');
    expect(notes(vault)).toHaveLength(1);
  });

  test('the note survives its mail being removed, and a later save says so', async () => {
    const { db, vault, id } = setup();
    db.prepare('DELETE FROM mail_messages WHERE id = ?').run(id);
    const out = await saveIdea(db, vault, BLOG);
    expect(readFileSync(join(vault, out!.path), 'utf8')).toContain('The mails are no longer here.');
  });

  test('no paragraph, or a Personal category, saves nothing', async () => {
    const { db, vault } = setup();
    expect(await saveIdea(db, vault, PERSONAL)).toBeNull();
    expect(await saveIdea(db, vault, 3)).toBeNull();
    expect(await saveIdea(db as Database, vault, 999)).toBeNull();
  });
});
