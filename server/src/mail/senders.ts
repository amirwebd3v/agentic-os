import { createHmac, randomBytes } from 'node:crypto';
import { Entry } from '@napi-rs/keyring';
import type { Database } from '../db/index.ts';

// Sender rules: the owner's own ("Always this sender") and learned ones, made from 3+ mails the owner sorted the same
// way. A Personal sender is known only by a keyed hash: the key lives in Credential Manager, so the database alone
// can't be checked against a list of addresses.
export const LEARN_AFTER = 3;

export type SenderHash = (address: string) => string;
export const hmacSender = (key: string): SenderHash => (address) => createHmac('sha256', key).update(address.trim().toLowerCase()).digest('hex').slice(0, 32);
export const hashKey = (hash: string) => `#${hash}`;

let cached: SenderHash | null | undefined;
/** Null when Credential Manager can't be used: Personal senders then just aren't remembered. */
export function credentialManagerHash(): SenderHash | null {
  if (cached !== undefined) return cached;
  try {
    const entry = new Entry('agentic-os', 'mail:sender-key');
    let key = entry.getPassword();
    if (!key) {
      key = randomBytes(32).toString('base64url');
      entry.setPassword(key);
    }
    cached = hmacSender(key);
  } catch {
    cached = null;
  }
  return cached;
}

/** The rule for this sender: the owner's own before a learned one, and Personal first when both match. */
export function ruleFor(db: Database, sender: string | null, hash: string | null): number | undefined {
  const keys = [sender, hash && hashKey(hash)].filter((k): k is string => !!k);
  if (!keys.length) return undefined;
  return db
    .prepare(
      `SELECT r.category_id FROM mail_sender_rules r JOIN mail_categories c ON c.id = r.category_id
       WHERE r.disabled = 0 AND r.sender IN (${keys.map(() => '?').join(',')})
       ORDER BY r.learned, c.system = 'personal' DESC LIMIT 1`,
    )
    .pluck()
    .get(...keys) as number | undefined;
}

/** Senders the owner sorted 3+ times, always into the same category. Never overrides a rule or brings back a removed one. */
export function learnRules(db: Database): number {
  return db
    .prepare(
      `INSERT INTO mail_sender_rules (sender, category_id, learned)
       SELECT key, min(category_id), 1 FROM (
         SELECT COALESCE(sender, '#' || sender_hash) AS key, category_id FROM mail_messages
         WHERE source = 'owner' AND state = 'filed' AND category_id IS NOT NULL AND (sender IS NOT NULL OR sender_hash IS NOT NULL))
       GROUP BY key HAVING count(*) >= ? AND count(DISTINCT category_id) = 1
       ON CONFLICT (sender) DO NOTHING`,
    )
    .run(LEARN_AFTER).changes;
}

/**
 * The owner moved a mail somewhere a learned rule disagrees with: the rule is switched off, not deleted, so learning
 * can't bring it back (a move into Personal moves that mail's history to the hash key, leaving the old key unmixed).
 */
export function forgetLearned(db: Database, sender: string | null, hash: string | null, categoryId: number): void {
  const keys = [sender, hash && hashKey(hash)].filter((k): k is string => !!k);
  if (keys.length) db.prepare(`UPDATE mail_sender_rules SET disabled = 1 WHERE learned = 1 AND disabled = 0 AND category_id <> ? AND sender IN (${keys.map(() => '?').join(',')})`).run(categoryId, ...keys);
}

/** The key a rule for this category is stored under: a Personal sender by its hash only, never its address. */
export function ruleKey(db: Database, sender: string, categoryId: number, hash: SenderHash | null): string | null {
  const personal = db.prepare(`SELECT 1 FROM mail_categories WHERE id = ? AND system = 'personal'`).get(categoryId);
  if (!personal) return sender;
  return hash ? hashKey(hash(sender)) : null;
}

/** Rules made before Personal senders were hashed: their addresses become hashes. Runs at startup. */
export function hashPersonalRules(db: Database, hash: SenderHash | null): void {
  if (!hash) return;
  const rows = db
    .prepare(`SELECT r.sender, r.category_id, r.learned, r.disabled FROM mail_sender_rules r JOIN mail_categories c ON c.id = r.category_id WHERE c.system = 'personal' AND r.sender NOT LIKE '#%'`)
    .all() as { sender: string; category_id: number; learned: number; disabled: number }[];
  db.transaction(() => {
    for (const r of rows) {
      db.prepare('INSERT INTO mail_sender_rules (sender, category_id, learned, disabled) VALUES (?, ?, ?, ?) ON CONFLICT (sender) DO NOTHING').run(hashKey(hash(r.sender)), r.category_id, r.learned, r.disabled);
      db.prepare('DELETE FROM mail_sender_rules WHERE sender = ?').run(r.sender);
    }
  })();
}
