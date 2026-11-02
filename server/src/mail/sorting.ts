import type { Database } from '../db/index.ts';
import { forgetLearned, ruleKey } from './senders.ts';
import type { SenderHash } from './senders.ts';

interface Row { id: number; account_id: number; gmail_id: string; rfc_message_id: string | null; sender: string | null; excerpt: string | null }
interface Category { id: number; name: string; system: string | null }

/**
 * Files one mail where the owner says, and records the correction. Moving into Personal wipes its text at once.
 * Moving into a category that keeps text, when the mail holds none, fetches it again through triage, which also
 * re-runs the checks: the owner picks the category, but a mail with a secret still keeps no excerpt.
 * The same mail in the other account (D18) moves with it: a mail has exactly one category (D3).
 * `source` is 'owner' for a mail the owner looked at, and 'rule' for one a sender rule moved: only the first counts
 * towards calibration (D12).
 */
export function sortMail(db: Database, mailId: number, categoryId: number, source: 'owner' | 'rule' = 'owner', hash: SenderHash | null = null): 'ok' | 'not_found' | 'bad_category' {
  const picked = db.prepare('SELECT id, account_id, gmail_id, rfc_message_id, sender, sender_hash, excerpt FROM mail_messages WHERE id = ?').get(mailId) as (Row & { sender_hash: string | null }) | undefined;
  if (!picked) return 'not_found';
  const category = db.prepare('SELECT id, name, system FROM mail_categories WHERE id = ?').get(categoryId) as Category | undefined;
  if (!category) return 'bad_category';
  const twins = picked.rfc_message_id
    ? (db.prepare('SELECT id, account_id, gmail_id, rfc_message_id, sender, excerpt FROM mail_messages WHERE rfc_message_id = ? AND id <> ?').all(picked.rfc_message_id, mailId) as Row[])
    : [];

  const refetch = db.prepare(
    `INSERT INTO mail_pending (account_id, gmail_id, owner_category_id) VALUES (?, ?, ?)
     ON CONFLICT (account_id, gmail_id) DO UPDATE SET owner_category_id = excluded.owner_category_id`,
  );
  const move = (row: Row, rowSource: string) => {
    if (category.system === 'personal') {
      // The address goes; a keyed hash stays, so this sender can be recognised next time without reading its mail.
      const senderHash = row.sender && hash ? hash(row.sender) : null;
      db.prepare(`UPDATE mail_messages SET state = 'filed', category_id = ?, suggestion_id = NULL, source = ?, is_personal = 1, eligible = 0, sender = NULL, subject = NULL, excerpt = NULL, sender_hash = COALESCE(?, sender_hash) WHERE id = ?`).run(category.id, rowSource, senderHash, row.id);
      db.prepare('DELETE FROM mail_pending WHERE account_id = ? AND gmail_id = ?').run(row.account_id, row.gmail_id);
      return;
    }
    const keepsText = category.system === null;
    const excerpt = keepsText ? row.excerpt : null;
    // Noise keeps its sender only (owner's decision, 2026-11-02).
    db.prepare(`UPDATE mail_messages SET state = 'filed', category_id = ?, suggestion_id = NULL, source = ?, is_personal = 0, excerpt = ?, eligible = CASE WHEN ? IS NULL THEN 0 ELSE eligible END, subject = CASE WHEN ? = 'noise' THEN NULL ELSE subject END, sender_hash = NULL WHERE id = ?`).run(category.id, rowSource, excerpt, excerpt, category.system, row.id);
    if ((keepsText && excerpt === null) || row.sender === null) refetch.run(row.account_id, row.gmail_id, category.id);
    // Anything else pending for this mail would file it by the older choice: the move above supersedes it.
    else db.prepare('DELETE FROM mail_pending WHERE account_id = ? AND gmail_id = ?').run(row.account_id, row.gmail_id);
  };
  db.transaction(() => {
    if (source === 'owner') forgetLearned(db, picked.sender, picked.sender_hash ?? (picked.sender && hash ? hash(picked.sender) : null), category.id);
    move(picked, source);
    // A twin keeps no text of its own (it was analysed once), so it follows without refetching or counting twice.
    for (const twin of twins) {
      if (category.system === 'personal' || twin.excerpt !== null) move({ ...twin, excerpt: null, sender: twin.sender ?? '' }, 'rule');
      else db.prepare(`UPDATE mail_messages SET state = 'filed', category_id = ?, suggestion_id = NULL, source = 'rule', is_personal = 0, excerpt = NULL, eligible = 0, sender_hash = NULL, subject = CASE WHEN ? = 'noise' THEN NULL ELSE subject END WHERE id = ?`).run(category.id, category.system, twin.id);
    }
    db.prepare(`UPDATE decisions SET final_answer = ?, corrected_by_user = 1 WHERE subject_type = 'mail' AND subject_id = ? AND question = 'category'`).run(category.name, picked.gmail_id);
  })();
  return 'ok';
}

/** Rule for future mail; with `applyStored`, also the mail already here. Returns how many stored mails moved. */
export function setSenderRule(db: Database, sender: string, categoryId: number, applyStored: boolean, hash: SenderHash | null = null): number {
  // The owner's own rule: it replaces a learned or removed one for this sender. A Personal rule keeps only the hash;
  // without the key there is no rule, as an address list of Personal senders is exactly what must not exist.
  const key = ruleKey(db, sender, categoryId, hash);
  if (key) db.prepare(`INSERT INTO mail_sender_rules (sender, category_id) VALUES (?, ?) ON CONFLICT (sender) DO UPDATE SET category_id = excluded.category_id, learned = 0, disabled = 0`).run(key, categoryId);
  if (!applyStored) return 0;
  const ids = db.prepare('SELECT id FROM mail_messages WHERE sender = ?').pluck().all(sender) as number[];
  for (const id of ids) sortMail(db, id, categoryId, 'rule', hash);
  return ids.length;
}
