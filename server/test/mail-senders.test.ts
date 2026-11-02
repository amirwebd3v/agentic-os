import { describe, expect, test } from 'vitest';
import type { Database } from '../src/db/index.ts';
import { emailRoutes } from '../src/http/routes/email.ts';
import { hashKey, hashPersonalRules, hmacSender, learnRules, ruleFor } from '../src/mail/senders.ts';
import { setSenderRule, sortMail } from '../src/mail/sorting.ts';
import { buildTestApp, makeTestDb } from './helpers.ts';

const [BLOG, CAREER, PERSONAL, NOISE] = [1, 3, 5, 6];
const hash = hmacSender('test-key');
let n = 0;
const mail = (db: Database, cols: Record<string, unknown> = {}) => {
  const all = { account_id: 1, gmail_id: `g${++n}`, internal_date: '2026-11-01', state: 'filed', source: 'owner', sender: 'news@example.com', ...cols };
  return db.prepare(`INSERT INTO mail_messages (${Object.keys(all).join(',')}) VALUES (${Object.keys(all).map(() => '?').join(',')}) RETURNING id`).pluck().get(...(Object.values(all) as never[])) as number;
};
const rules = (db: Database) => db.prepare('SELECT sender, category_id, learned, disabled FROM mail_sender_rules ORDER BY sender').all();
const setup = () => {
  const db = makeTestDb();
  db.prepare(`INSERT INTO mail_accounts (email) VALUES ('a@example.com')`).run();
  return db;
};

describe('learning rules from the owner', () => {
  test('3 mails sorted the same way make a rule; 2 do not; a mixed sender never does', () => {
    const db = setup();
    for (let i = 0; i < 3; i++) mail(db, { category_id: NOISE, sender: 'deals@shop.example' });
    for (let i = 0; i < 2; i++) mail(db, { category_id: BLOG, sender: 'two@example.com' });
    mail(db, { category_id: BLOG, sender: 'mixed@example.com' });
    for (let i = 0; i < 3; i++) mail(db, { category_id: CAREER, sender: 'mixed@example.com' });
    expect(learnRules(db)).toBe(1);
    expect(rules(db)).toEqual([{ sender: 'deals@shop.example', category_id: NOISE, learned: 1, disabled: 0 }]);
  });

  test('only what the owner sorted counts, not what a rule or a model filed', () => {
    const db = setup();
    for (const source of ['rule', 'laya', 'claude']) mail(db, { category_id: NOISE, sender: 'x@example.com', source });
    expect(learnRules(db)).toBe(0);
  });

  test('a Personal sender is learned by its hash, never its address', () => {
    const db = setup();
    for (let i = 0; i < 3; i++) mail(db, { category_id: PERSONAL, is_personal: 1, sender: null, sender_hash: hash('mum@family.example') });
    learnRules(db);
    expect(rules(db)).toEqual([{ sender: hashKey(hash('mum@family.example')), category_id: PERSONAL, learned: 1, disabled: 0 }]);
    expect(JSON.stringify(rules(db))).not.toContain('mum@');
    expect(ruleFor(db, 'mum@family.example', hash('mum@family.example'))).toBe(PERSONAL);
  });

  test("the owner's own rule wins over a learned one, and is never overwritten by learning", () => {
    const db = setup();
    db.prepare(`INSERT INTO mail_sender_rules (sender, category_id) VALUES ('deals@shop.example', ${BLOG})`).run();
    for (let i = 0; i < 3; i++) mail(db, { category_id: NOISE, sender: 'deals@shop.example' });
    learnRules(db);
    expect(ruleFor(db, 'deals@shop.example', null)).toBe(BLOG);
  });

  test('with both a hashed Personal rule and an address rule, Personal wins', () => {
    const db = setup();
    db.prepare(`INSERT INTO mail_sender_rules (sender, category_id, learned) VALUES ('p@example.com', ${BLOG}, 1), (?, ${PERSONAL}, 1)`).run(hashKey(hash('p@example.com')));
    expect(ruleFor(db, 'p@example.com', hash('p@example.com'))).toBe(PERSONAL);
  });

  test('moving a mail against a learned rule switches it off, and it stays off', () => {
    const db = setup();
    const ids = [0, 1, 2].map(() => mail(db, { category_id: NOISE, sender: 'deals@shop.example' }));
    learnRules(db);
    sortMail(db, ids[0]!, BLOG, 'owner', hash);
    learnRules(db);
    expect(ruleFor(db, 'deals@shop.example', null)).toBeUndefined();
  });

  test('moving a mail into Personal keeps the sender hash, and Noise keeps the sender only', () => {
    const db = setup();
    const p = mail(db, { category_id: BLOG, sender: 'friend@mail.example', subject: 'Hi' });
    sortMail(db, p, PERSONAL, 'owner', hash);
    expect(db.prepare('SELECT sender, subject, sender_hash FROM mail_messages WHERE id = ?').get(p)).toEqual({ sender: null, subject: null, sender_hash: hash('friend@mail.example') });
    const q = mail(db, { category_id: BLOG, sender: 'deals@shop.example', subject: 'Sale' });
    sortMail(db, q, NOISE, 'owner', hash);
    expect(db.prepare('SELECT sender, subject FROM mail_messages WHERE id = ?').get(q)).toEqual({ sender: 'deals@shop.example', subject: null });
  });
});

describe('review findings', () => {
  test('"Always this sender" into Personal stores the hash, never the address; old address rules are converted', () => {
    const db = setup();
    const id = mail(db, { state: 'needs_sorting', source: null, sender: 'friend@mail.example' });
    setSenderRule(db, 'friend@mail.example', PERSONAL, true, hash);
    expect(rules(db)).toEqual([{ sender: hashKey(hash('friend@mail.example')), category_id: PERSONAL, learned: 0, disabled: 0 }]);
    expect(db.prepare('SELECT sender FROM mail_messages WHERE id = ?').pluck().get(id)).toBeNull();
    db.prepare(`INSERT INTO mail_sender_rules (sender, category_id) VALUES ('old@mail.example', ${PERSONAL})`).run();
    hashPersonalRules(db, hash);
    expect(JSON.stringify(rules(db))).not.toContain('@');
    expect(ruleFor(db, 'old@mail.example', hash('old@mail.example'))).toBe(PERSONAL);
  });

  test('without the key, a Personal rule is not made at all', () => {
    const db = setup();
    setSenderRule(db, 'friend@mail.example', PERSONAL, false, null);
    expect(rules(db)).toEqual([]);
  });

  test('moving a rule-filed mail into Personal turns the learned rule off for good', () => {
    const db = setup();
    for (let i = 0; i < 3; i++) mail(db, { category_id: NOISE, sender: 'deals@shop.example' });
    learnRules(db);
    const filedByRule = mail(db, { category_id: NOISE, sender: 'deals@shop.example', source: 'rule' });
    sortMail(db, filedByRule, PERSONAL, 'owner', hash);
    learnRules(db);
    expect(ruleFor(db, 'deals@shop.example', null)).toBeUndefined();
    expect(rules(db)).toContainEqual({ sender: 'deals@shop.example', category_id: NOISE, learned: 1, disabled: 1 });
  });

  test('a Noise twin keeps no subject, and a mail moved out of Personal drops its hash', () => {
    const db = setup();
    db.prepare(`INSERT INTO mail_accounts (email) VALUES ('b@example.com')`).run();
    const a = mail(db, { category_id: CAREER, rfc_message_id: '<x>', subject: 'Hi', excerpt: 'text', eligible: 1 });
    const b = mail(db, { account_id: 2, category_id: CAREER, rfc_message_id: '<x>', subject: 'Hi', source: 'rule' });
    sortMail(db, a, NOISE, 'owner', hash);
    expect(db.prepare('SELECT subject FROM mail_messages WHERE id = ?').pluck().get(b)).toBeNull();
    const p = mail(db, { category_id: PERSONAL, is_personal: 1, sender: null, sender_hash: hash('x@example.com') });
    sortMail(db, p, BLOG, 'owner', hash);
    expect(db.prepare('SELECT sender_hash FROM mail_messages WHERE id = ?').pluck().get(p)).toBeNull();
  });
});

describe('rules route', () => {
  test('stopping a learned rule disables it for good; removing your own rule deletes it', async () => {
    const t = await buildTestApp({ loggedIn: true, plugins: [emailRoutes({ client: () => null, tokens: { get: () => null, set: () => {}, delete: () => {} }, senderHash: () => hash })] });
    t.db.prepare(`INSERT INTO mail_accounts (email) VALUES ('a@example.com')`).run();
    for (let i = 0; i < 3; i++) mail(t.db, { category_id: NOISE, sender: 'deals@shop.example' });
    learnRules(t.db);
    t.db.prepare(`INSERT INTO mail_sender_rules (sender, category_id) VALUES ('mine@example.com', ${BLOG})`).run();
    const del = (s: string) => t.app.inject(t.authed({ method: 'DELETE', url: `/api/email/rules?sender=${encodeURIComponent(s)}` }));
    expect((await del('deals@shop.example')).json()).toEqual({ ok: true });
    expect((await del('mine@example.com')).json()).toEqual({ ok: true });
    learnRules(t.db);
    expect(rules(t.db)).toEqual([{ sender: 'deals@shop.example', category_id: NOISE, learned: 1, disabled: 1 }]);
    expect((await t.app.inject(t.authed({ method: 'GET', url: '/api/email/overview' }))).json().rules).toEqual([]);
  });
});
