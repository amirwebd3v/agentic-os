import { describe, expect, test } from 'vitest';
import type { Contact } from '../src/career/contact.ts';
import { excerptOf, gate, storedFields } from '../src/mail/gate.ts';
import type { GateAnswers, GateContext, GateStep, MailFacts } from '../src/mail/gate.ts';
import { scrubSecrets } from '../src/mail/secrets.ts';
import { makeTestDb } from './helpers.ts';

const [BLOG, CAREER, PERSONAL, NOISE] = [1, 3, 5, 6] as const;
const ctx = (over: Partial<GateContext> = {}): GateContext => ({
  categories: [1, 2, 3, 4, 5, 6],
  personalId: PERSONAL,
  noiseId: NOISE,
  rule: null,
  calibrating: false,
  consent: true,
  thresholds: { [BLOG]: 0.8, [CAREER]: 0.8, [NOISE]: 0.8 },
  sensitiveYes: 0.8,
  sensitiveNo: 0.2,
  ...over,
});
const mail = (over: Partial<MailFacts> = {}): MailFacts => ({ labels: ['INBOX'], bulk: true, secretsHit: false, ...over });
const laya = (sensitive: number, category: number, confidence: number): GateAnswers => ({ laya: { sensitive, category, confidence } });

describe('gate branches, in order', () => {
  test.each([[['SPAM']], [['TRASH']], [['DRAFT']], [['SENT']]])('skips %j', (labels) => {
    expect(gate(mail({ labels }), ctx())).toEqual({ action: 'skip' });
  });
  test('mail to yourself and archived mail are received mail', () => {
    expect(gate(mail({ labels: ['SENT', 'INBOX'] }), ctx()).action).toBe('ask_laya');
    expect(gate(mail({ labels: [] }), ctx()).action).toBe('ask_laya');
  });

  test('a Personal rule files at once and asks no model', () => {
    expect(gate(mail(), ctx({ rule: PERSONAL }))).toEqual({ action: 'file', category: PERSONAL, source: 'rule', eligible: false, keepText: false });
  });
  test('any other rule files but still needs Laya for eligibility', () => {
    expect(gate(mail({ bulk: false }), ctx({ rule: BLOG })).action).toBe('ask_laya');
    expect(gate(mail({ bulk: false }), ctx({ rule: BLOG }), laya(0.1, CAREER, 0.9))).toEqual({ action: 'file', category: BLOG, source: 'rule', eligible: true, keepText: true });
    expect(gate(mail(), ctx({ rule: BLOG }), laya(0.9, CAREER, 0.9))).toMatchObject({ category: BLOG, eligible: false, keepText: false });
    expect(gate(mail({ secretsHit: true }), ctx({ rule: BLOG }), laya(0.1, CAREER, 0.9))).toMatchObject({ category: BLOG, eligible: false, keepText: false });
  });

  test('a mail that talks to the model goes to the owner, with no model; under a rule it keeps no text', () => {
    expect(gate(mail({ injection: true }), ctx())).toEqual({ action: 'needs_sorting', suggestion: null });
    expect(gate(mail({ injection: true }), ctx({ rule: BLOG }), laya(0.1, BLOG, 0.9))).toMatchObject({ category: BLOG, eligible: false, keepText: false });
  });

  test('a secrets hit is Personal before any model sees it', () => {
    expect(gate(mail({ secretsHit: true }), ctx())).toEqual({ action: 'file', category: PERSONAL, source: 'secrets', eligible: false, keepText: false });
  });

  test('calibration sends everything to Needs sorting, with the suggestion, and never asks Claude', () => {
    expect(gate(mail(), ctx({ calibrating: true }), laya(0.1, BLOG, 0.99))).toEqual({ action: 'needs_sorting', suggestion: BLOG });
    expect(gate(mail(), ctx({ calibrating: true }), laya(0.9, BLOG, 0.99))).toEqual({ action: 'needs_sorting', suggestion: BLOG });
  });

  test('sensitive is Personal; unsure waits for the owner', () => {
    expect(gate(mail(), ctx(), laya(0.9, BLOG, 0.99))).toEqual({ action: 'file', category: PERSONAL, source: 'laya', eligible: false, keepText: false });
    expect(gate(mail(), ctx(), laya(0.5, BLOG, 0.99))).toEqual({ action: 'needs_sorting', suggestion: BLOG });
    expect(gate(mail(), ctx(), laya(0.1, PERSONAL, 0.4))).toEqual({ action: 'needs_sorting', suggestion: PERSONAL });
  });

  test('confident files; eligibility needs bulk or a rule', () => {
    expect(gate(mail(), ctx(), laya(0.1, BLOG, 0.9))).toEqual({ action: 'file', category: BLOG, source: 'laya', eligible: true, keepText: true });
    expect(gate(mail({ bulk: false }), ctx(), laya(0.1, BLOG, 0.9))).toMatchObject({ category: BLOG, eligible: false });
    expect(gate(mail(), ctx(), laya(0.1, NOISE, 0.9))).toMatchObject({ category: NOISE, eligible: false });
  });

  test('not confident: Claude only if D7 passes with consent on', () => {
    expect(gate(mail(), ctx(), laya(0.1, BLOG, 0.5))).toEqual({ action: 'ask_claude' });
    expect(gate(mail({ bulk: false }), ctx(), laya(0.1, BLOG, 0.5)).action).toBe('needs_sorting');
    expect(gate(mail(), ctx({ consent: false }), laya(0.1, BLOG, 0.5)).action).toBe('needs_sorting');
    expect(gate(mail(), ctx({ thresholds: {} }), laya(0.1, BLOG, 0.99))).toEqual({ action: 'ask_claude' });
  });

  test("Claude's answer files, and a category off the list goes to Needs sorting", () => {
    expect(gate(mail(), ctx(), { ...laya(0.1, BLOG, 0.5), claude: { category: CAREER } })).toEqual({ action: 'file', category: CAREER, source: 'claude', eligible: true, keepText: true });
    expect(gate(mail(), ctx(), { ...laya(0.1, BLOG, 0.5), claude: { category: 99 } })).toEqual({ action: 'needs_sorting', suggestion: BLOG });
    expect(gate(mail(), ctx(), { ...laya(0.1, BLOG, 0.5), claude: { category: PERSONAL } })).toMatchObject({ category: PERSONAL, eligible: false });
  });

  test("a stale Claude answer can't get past consent or D7", () => {
    const claude = { category: CAREER };
    expect(gate(mail(), ctx({ consent: false }), { ...laya(0.1, BLOG, 0.5), claude }).action).toBe('needs_sorting');
    expect(gate(mail({ bulk: false }), ctx(), { ...laya(0.1, BLOG, 0.5), claude }).action).toBe('needs_sorting');
  });

  test('a Laya category off the list is no suggestion', () => {
    expect(gate(mail({ bulk: false }), ctx(), laya(0.1, 99, 0.99))).toEqual({ action: 'needs_sorting', suggestion: null });
  });
});

test('Personal is never eligible, across every combination', () => {
  const values = [0, 0.5, 1];
  for (const bulk of [true, false]) for (const secretsHit of [true, false]) for (const consent of [true, false]) for (const calibrating of [true, false]) {
    for (const rule of [null, BLOG, PERSONAL]) for (const s of values) for (const c of values) for (const category of [BLOG, PERSONAL, NOISE, 99]) for (const claude of [undefined, { category: PERSONAL }, { category: BLOG }]) {
      const step = gate(mail({ bulk, secretsHit }), ctx({ consent, calibrating, rule }), { laya: { sensitive: s, category, confidence: c }, ...(claude && { claude }) });
      if (step.action === 'file' && step.category === PERSONAL) expect(step.eligible).toBe(false);
      if (step.action === 'file' && step.eligible) {
        expect(secretsHit).toBe(false);
        expect(s).toBeLessThanOrEqual(0.2);
        expect(bulk || rule !== null).toBe(true);
      }
      if (step.action === 'file' && step.source === 'claude') expect([consent, bulk, secretsHit, calibrating]).toEqual([true, true, false, false]);
      if (step.action === 'ask_claude') {
        expect([consent, bulk, secretsHit, calibrating]).toEqual([true, true, false, false]);
        expect(s).toBeLessThanOrEqual(0.2);
      }
    }
  }
});

describe('secrets scan', () => {
  const secrets: [string, string, string][] = [
    ['iban', 'Your IBAN: DE89370400440532013000.', 'DE89370400440532013000'],
    ['iban', 'IBAN DE89 3704 0044 0532 0130 00 BIC COBADEFF', '0532 0130'],
    ['iban', 'Pay GB82 WEST 1234 5698 7654 32 today', 'WEST 1234'],
    ['card', 'Card 4111 1111 1111 1111 expires', '4111 1111'],
    ['card', 'card number 5500-0055-5555-5559', '5500-0055'],
    ['card', 'Amex 378282246310005 on file', '378282246310005'],
    ['card', 'Card 4111 1111 1111 1111 12/28', '4111 1111'],
    ['card', 'Order 12345 4111 1111 1111 1111', '4111 1111'],
    ['otp', 'Your verification code is 482913.', '482913'],
    ['otp', '482913 is your Example login code', '482913'],
    ['otp', 'Ihr Bestätigungscode: 7731', '7731'],
    ['otp', 'one-time password: 90817263', '90817263'],
    ['otp', 'Your OTP 551204 expires soon', '551204'],
    ['otp', 'Your verification code:\n\n482913', '482913'],
    ['otp', 'Your code: 482913', '482913'],
    ['otp', 'Enter code 482913', '482913'],
    ['otp', 'Use 482913 to verify your account', '482913'],
    ['otp', 'G-482913 is your Google code', '482913'],
    ['otp', 'Your Uber code is 1234', '1234'],
    ['otp', 'Confirm your sign-in\n  482913  \nThanks', '482913'],
    ['totp', 'otpauth://totp/Example:a?secret=JBSWY3DPEHPK3PXP', 'JBSWY3DPEHPK3PXP'],
    ['totp', 'Your setup key: JBSW Y3DP EHPK 3PXP', 'JBSW Y3DP'],
    ['totp', 'Setup key\nJBSWY3DPEHPK3PXP', 'JBSWY3DPEHPK3PXP'],
    ['totp', 'backup codes: abcd-1234 efgh-5678', 'abcd-1234'],
    ['tax_id', 'Ihre Steuer-ID: 12 345 678 901', '345 678'],
    ['tax_id', 'Identifikationsnummer 12345678901', '12345678901'],
    ['tax_id', 'Steuer-ID:\n12345678901', '12345678901'],
    ['passport', 'Passport number L01X00T47 is valid', 'L01X00T47'],
    ['passport', 'Personalausweis Nr. T22000129', 'T22000129'],
    ['passport', 'Passport number\nL01X00T47', 'L01X00T47'],
    ['reset_link', 'Go to https://example.com/password-reset?t=abc123', 'abc123'],
    ['reset_link', 'To reset your password, open https://example.com/u/x9y8 now', 'x9y8'],
    ['reset_link', 'Open https://example.com/reset/abc123', 'abc123'],
    ['reset_link', 'Open https://example.com/verify?token=abc123', 'abc123'],
  ];
  test.each(secrets)('%s: %s', (kind, text, secret) => {
    const out = scrubSecrets(text);
    expect(out.kinds).toContain(kind);
    expect(out.text).not.toContain(secret);
    expect(out.text).toContain('[redacted]');
  });

  test.each([
    'Issue 2026 of the newsletter has 12 links',
    'Use promo code 2026 for 20% off',
    'Call +49 30 1234567 or write to us',
    'Invoice 1234567890123 is not a card',
    'Read https://example.com/password-managers-compared today',
    'DE89 is a nice word, ABCD 1234 EFGH too',
    'Passport holders can read this guide',
    'Use your recovery codes when you lose access',
    'A well-known recovery code tutorial',
    'Tracking 1234567890123456789012 arrives soon',
  ])('leaves ordinary text alone: %s', (text) => {
    expect(scrubSecrets(text)).toEqual({ text, kinds: [] });
  });

  test.each([
    ['base32', 'backup codes: ' + 'a'.repeat(5000) + '1'],
    ['spaced', 'setup key ' + 'ABCD '.repeat(5000) + '!'],
    ['links', 'http://'.repeat(5000)],
    ['digits', '1 '.repeat(20000)],
    ['labels', 'code '.repeat(20000)],
  ])('a hostile mail cannot stall the scan: %s', (_, text) => {
    const t0 = performance.now();
    scrubSecrets(text);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

describe('what is stored', () => {
  const contact = { name: 'Jan Doe', email: 'jan@example.com' } as Contact;
  const m = { sender: 'news@example.com', subject: 'Issue 4', body: 'Hello Jan Doe,\n  write to jan@example.com  now' };
  const c = { personalId: PERSONAL, noiseId: NOISE };
  const file = (category: number, eligible = true, keepText = true): GateStep & { action: 'file' } => ({ action: 'file', category, source: 'laya', eligible, keepText });

  test('Personal keeps nothing', () => {
    expect(storedFields(file(PERSONAL, false, false), m, c, contact)).toEqual({ sender: null, subject: null, excerpt: null, is_personal: 1, eligible: 0 });
  });
  test('Needs sorting and Noise keep sender and subject, no excerpt', () => {
    expect(storedFields({ action: 'needs_sorting', suggestion: null }, m, c, contact)).toEqual({ sender: m.sender, subject: m.subject, excerpt: null, is_personal: 0, eligible: 0 });
    expect(storedFields(file(NOISE, false), m, c, contact)).toMatchObject({ sender: m.sender, excerpt: null, eligible: 0 });
  });
  test('an idea category keeps a redacted excerpt without contact details', () => {
    const out = storedFields(file(BLOG), m, c, contact);
    expect(out.eligible).toBe(1);
    expect(out.excerpt).not.toContain('Jan Doe');
    expect(out.excerpt).not.toContain('jan@example.com');
    expect(out.excerpt).not.toMatch(/\s{2}|\n/);
  });
  test('a mail that is not clean keeps no excerpt and is not eligible', () => {
    expect(storedFields(file(BLOG, false, false), m, c, contact)).toMatchObject({ excerpt: null, eligible: 0 });
  });
  test('a secret the caller missed still stops the excerpt', () => {
    expect(storedFields(file(BLOG), { ...m, body: 'Your login code 482913' }, c, contact)).toMatchObject({ excerpt: null, eligible: 0 });
  });
  test('secrets and contact details are out of a stored subject', () => {
    expect(storedFields(file(BLOG), { ...m, subject: 'Your login code 482913' }, c, contact).subject).not.toContain('482913');
    expect(storedFields(file(BLOG), { ...m, subject: 'Jan Doe, your invoice' }, c, contact).subject).not.toContain('Jan Doe');
  });
  test('excerpts are capped', () => {
    expect(excerptOf('x '.repeat(5000), contact).length).toBeLessThanOrEqual(1500);
  });
});

describe('schema', () => {
  const setup = () => {
    const db = makeTestDb();
    const account = db.prepare(`INSERT INTO mail_accounts (email) VALUES ('a@example.com') RETURNING id`).pluck().get() as number;
    const insert = (cols: Record<string, unknown>) => {
      const all = { account_id: account, gmail_id: 'g1', internal_date: '2026-11-01T00:00:00Z', state: 'filed', ...cols };
      db.prepare(`INSERT INTO mail_messages (${Object.keys(all).join(',')}) VALUES (${Object.keys(all).map(() => '?').join(',')})`).run(...(Object.values(all) as never[]));
    };
    return { db, insert };
  };

  test('seeds the six categories, with Personal and Noise marked', () => {
    const { db } = setup();
    expect(db.prepare('SELECT name FROM mail_categories ORDER BY id').pluck().all()).toEqual(['Blog ideas', 'Social ideas', 'Career', 'Software development', 'Personal', 'Noise']);
    expect(db.prepare('SELECT name FROM mail_categories WHERE system IS NOT NULL ORDER BY id').pluck().all()).toEqual(['Personal', 'Noise']);
  });
  test.each([[{ sender: 'x' }], [{ subject: 'x' }], [{ excerpt: 'x' }], [{ eligible: 1 }]])('refuses a Personal row holding %j', (cols) => {
    expect(() => setup().insert({ is_personal: 1, category_id: 5, ...cols })).toThrow(/CHECK/);
  });
  test('refuses an excerpt on an unfiled row', () => {
    expect(() => setup().insert({ state: 'needs_sorting', excerpt: 'x' })).toThrow(/CHECK/);
  });
  test('refuses a Personal category without the flag, and the flag without the category', () => {
    expect(() => setup().insert({ category_id: 5, sender: 'x' })).toThrow(/disagrees/);
    expect(() => setup().insert({ is_personal: 1 })).toThrow(/disagrees/);
    const { db, insert } = setup();
    insert({ category_id: 1, sender: 'x' });
    expect(() => db.prepare('UPDATE mail_messages SET category_id = 5').run()).toThrow(/disagrees/);
  });
  test('Personal and Noise cannot be removed', () => {
    const { db } = setup();
    expect(() => db.prepare("DELETE FROM mail_categories WHERE system = 'personal'").run()).toThrow(/system category/);
    expect(() => db.prepare("DELETE FROM mail_categories WHERE system = 'noise'").run()).toThrow(/system category/);
  });
  test('removing a category moves its mail to Needs sorting and drops the excerpt', () => {
    const { db, insert } = setup();
    insert({ category_id: 3, sender: 'x', excerpt: 'text', eligible: 1, source: 'laya' });
    db.prepare("DELETE FROM mail_categories WHERE name = 'Career'").run();
    expect(db.prepare('SELECT state, category_id, excerpt, eligible, sender FROM mail_messages').get()).toEqual({ state: 'needs_sorting', category_id: null, excerpt: null, eligible: 0, sender: 'x' });
  });
  test('a Personal row with ids and category is fine', () => {
    expect(() => setup().insert({ is_personal: 1, category_id: 5 })).not.toThrow();
  });
});
