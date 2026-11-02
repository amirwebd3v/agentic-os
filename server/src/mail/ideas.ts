import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import matter from 'gray-matter';
import type { Database } from '../db/index.ts';
import { gitCommit, resolveNotePath } from '../vault/writer.ts';
import { paragraphOf } from './analyse.ts';

/**
 * "Save idea" (D9): a note the owner owns from then on, in `ideas/`. Its name comes from the paragraph's hash, so
 * saving twice is a no-op, and it survives its mails' removal. The paragraph is model text drawn from strangers'
 * mail, so the note says so (`trust: untrusted`) and quotes it rather than letting it act as Markdown.
 */
export async function saveIdea(db: Database, vaultDir: string, categoryId: number): Promise<{ saved: boolean; path: string } | null> {
  const category = db.prepare('SELECT name, system FROM mail_categories WHERE id = ?').get(categoryId) as { name: string; system: string | null } | undefined;
  if (!category || category.system !== null) return null;
  const paragraph = paragraphOf(db, categoryId);
  if (!paragraph) return null;

  const hash = createHash('sha256').update(paragraph.text).digest('hex').slice(0, 10);
  const slug = category.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'category';
  const path = `ideas/${paragraph.created_at.slice(0, 10)}-${slug}-${hash}.md`;
  const abs = resolveNotePath(vaultDir, path);
  if (existsSync(abs)) return { saved: false, path };

  // Links are built here from ids; the mail's own text never supplies one.
  const links = paragraph.cites.length
    ? (db.prepare(`SELECT m.gmail_id, a.email FROM mail_messages m JOIN mail_accounts a ON a.id = m.account_id WHERE m.id IN (${paragraph.cites.map(() => '?').join(',')})`).all(...paragraph.cites) as { gmail_id: string; email: string }[])
    : [];
  const quote = paragraph.text.replace(/[\\`*_[\]<>#|]/g, (c) => `\\${c}`);
  const body = [
    `# ${category.name} idea`,
    '',
    `> ${quote}`,
    '',
    'Written by Claude from your mail. Check it before you act on it.',
    '',
    '## Sources',
    '',
    ...(links.length ? links.map((l, i) => `- [Mail ${i + 1}](https://mail.google.com/mail/?authuser=${encodeURIComponent(l.email)}#all/${encodeURIComponent(l.gmail_id)})`) : ['- The mails are no longer here.']),
    '',
  ].join('\n');
  const now = new Date().toISOString();
  const text = matter.stringify(body, { id: randomUUID(), area: 'ideas', tags: ['idea', slug], sensitivity: 1, source: 'email', trust: 'untrusted', created: now, updated: now });

  mkdirSync(dirname(abs), { recursive: true });
  let fd: number;
  try {
    fd = openSync(abs, 'wx'); // never overwrites: a second save, or the owner's own edit, keeps what is there
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return { saved: false, path };
    throw err;
  }
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
  await gitCommit(vaultDir, `aos: save idea\n\n${path}`).catch(() => undefined); // the note is saved; a missed commit is picked up by the next one
  return { saved: true, path };
}
