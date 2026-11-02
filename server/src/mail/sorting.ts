import type { Database } from '../db/index.ts';

interface Row { id: number; account_id: number; gmail_id: string; sender: string | null; excerpt: string | null }
interface Category { id: number; name: string; system: string | null }

/**
 * Files one mail where the owner says, and records the correction. Moving into Personal wipes its text at once.
 * Moving into a category that keeps text, when the mail holds none, fetches it again through triage, which also
 * re-runs the checks: the owner picks the category, but a mail with a secret still keeps no excerpt.
 */
export function sortMail(db: Database, mailId: number, categoryId: number): 'ok' | 'not_found' | 'bad_category' {
  const row = db.prepare('SELECT id, account_id, gmail_id, sender, excerpt FROM mail_messages WHERE id = ?').get(mailId) as Row | undefined;
  if (!row) return 'not_found';
  const category = db.prepare('SELECT id, name, system FROM mail_categories WHERE id = ?').get(categoryId) as Category | undefined;
  if (!category) return 'bad_category';

  const refetch = db.prepare(
    `INSERT INTO mail_pending (account_id, gmail_id, owner_category_id) VALUES (?, ?, ?)
     ON CONFLICT (account_id, gmail_id) DO UPDATE SET owner_category_id = excluded.owner_category_id`,
  );
  db.transaction(() => {
    if (category.system === 'personal') {
      db.prepare(`UPDATE mail_messages SET state = 'filed', category_id = ?, suggestion_id = NULL, source = 'owner', is_personal = 1, eligible = 0, sender = NULL, subject = NULL, excerpt = NULL WHERE id = ?`).run(category.id, mailId);
      db.prepare('DELETE FROM mail_pending WHERE account_id = ? AND gmail_id = ?').run(row.account_id, row.gmail_id);
    } else {
      const keepsText = category.system === null;
      const excerpt = keepsText ? row.excerpt : null;
      db.prepare(`UPDATE mail_messages SET state = 'filed', category_id = ?, suggestion_id = NULL, source = 'owner', is_personal = 0, excerpt = ?, eligible = CASE WHEN ? IS NULL THEN 0 ELSE eligible END WHERE id = ?`).run(category.id, excerpt, excerpt, mailId);
      if ((keepsText && excerpt === null) || row.sender === null) refetch.run(row.account_id, row.gmail_id, category.id);
    }
    db.prepare(`UPDATE decisions SET final_answer = ?, corrected_by_user = 1 WHERE subject_type = 'mail' AND subject_id = ? AND question = 'category'`).run(category.name, row.gmail_id);
  })();
  return 'ok';
}

/** Rule for future mail; with `applyStored`, also the mail already here. Returns how many stored mails moved. */
export function setSenderRule(db: Database, sender: string, categoryId: number, applyStored: boolean): number {
  db.prepare(`INSERT INTO mail_sender_rules (sender, category_id) VALUES (?, ?) ON CONFLICT (sender) DO UPDATE SET category_id = excluded.category_id`).run(sender, categoryId);
  if (!applyStored) return 0;
  const ids = db.prepare('SELECT id FROM mail_messages WHERE sender = ?').pluck().all(sender) as number[];
  for (const id of ids) sortMail(db, id, categoryId);
  return ids.length;
}
