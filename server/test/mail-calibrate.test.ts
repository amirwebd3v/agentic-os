import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import type { Database } from '../src/db/index.ts';
import { wrapUntrusted } from '../src/llm/untrusted.ts';
import { applyCalibration, calibrationReport } from '../src/mail/calibrate.ts';
import { checkParagraph } from '../src/mail/analyse.ts';
import { excerptOf } from '../src/mail/gate.ts';
import { makeTestDb } from './helpers.ts';

const IDS: Record<string, number> = { 'Blog ideas': 1, 'Social ideas': 2, Career: 3, 'Software development': 4, Personal: 5, Noise: 6 };
let n = 0;
/** A mail the owner sorted into `owner`, which Laya called `laya` at `confidence`. */
function sorted(db: Database, owner: string, laya: string, confidence: number, sensitive = 'false') {
  const id = `g${++n}`;
  const personal = owner === 'Personal';
  db.prepare(`INSERT INTO mail_messages (account_id, gmail_id, internal_date, state, category_id, source, is_personal, sender) VALUES (1, ?, '2026-11-01', 'filed', ?, 'owner', ?, ?)`).run(id, IDS[owner], personal ? 1 : 0, personal ? null : 's');
  db.prepare(`INSERT INTO decisions (subject_type, subject_id, question, answer, confidence) VALUES ('mail', ?, 'category', ?, ?), ('mail', ?, 'sensitive', ?, 0.9)`).run(id, laya, confidence, id, sensitive);
}
const setup = () => {
  const db = makeTestDb();
  db.prepare(`INSERT INTO mail_accounts (email) VALUES ('a@example.com')`).run();
  return db;
};

describe('calibration', () => {
  test('a threshold where precision reaches 95%, none without enough picks', () => {
    const db = setup();
    for (const c of [0.99, 0.97, 0.95, 0.93, 0.91, 0.9]) sorted(db, 'Career', 'Career', c);
    sorted(db, 'Noise', 'Career', 0.5); // a wrong pick below the bar
    for (const c of [0.9, 0.8]) sorted(db, 'Blog ideas', 'Blog ideas', c);
    const r = calibrationReport(db);
    expect(r.sorted).toBe(9);
    expect(r.categories.find((c) => c.name === 'Career')).toMatchObject({ picked: 7, threshold: 0.9, precision: 1 });
    expect(r.categories.find((c) => c.name === 'Blog ideas')).toMatchObject({ threshold: null });
    expect(r.categories.map((c) => c.name)).not.toContain('Personal');
    expect(applyCalibration(db, r)).toEqual({ 3: 0.9 });
    expect(JSON.parse(db.prepare(`SELECT value FROM mail_settings WHERE key = 'thresholds'`).pluck().get() as string)).toEqual({ 3: 0.9 });
  });

  test('a threshold never splits picks with the same confidence', () => {
    const db = setup();
    for (let i = 0; i < 5; i++) sorted(db, 'Career', 'Career', 0.9);
    sorted(db, 'Noise', 'Career', 0.9);
    expect(calibrationReport(db).categories.find((c) => c.name === 'Career')!.threshold).toBeNull();
  });

  test('one Personal mail Laya called not sensitive stops all auto-filing', () => {
    const db = setup();
    for (const c of [0.99, 0.97, 0.95, 0.93, 0.91]) sorted(db, 'Career', 'Career', c);
    sorted(db, 'Personal', 'Career', 0.4, 'false');
    const r = calibrationReport(db);
    expect(r.sensitiveMissed).toBe(1);
    expect(applyCalibration(db, r)).toEqual({});
  });

  test('R3: Blog and Social confusion is counted', () => {
    const db = setup();
    sorted(db, 'Blog ideas', 'Social ideas', 0.7);
    sorted(db, 'Social ideas', 'Blog ideas', 0.7);
    sorted(db, 'Social ideas', 'Social ideas', 0.7);
    expect(calibrationReport(db).blogSocialConfusion).toBe(2);
  });
});

describe('golden set and canaries, offline', () => {
  const golden = JSON.parse(readFileSync(new URL('./fixtures/mail/golden.json', import.meta.url), 'utf8')) as {
    mails: { id: string; expect: string; sensitive: boolean; body: string }[];
    canaries: { id: string; control: string; inject: string }[];
  };

  test('20 synthetic mails over every category, and 15 canaries with real controls', () => {
    expect(golden.mails).toHaveLength(20);
    expect(new Set(golden.mails.map((m) => m.expect))).toEqual(new Set(Object.keys(IDS)));
    expect(golden.mails.filter((m) => m.sensitive).every((m) => m.expect === 'Personal')).toBe(true);
    expect(golden.canaries).toHaveLength(15);
    for (const c of golden.canaries) expect(golden.mails.some((m) => m.id === c.control)).toBe(true);
  });

  test("no canary can close its mail block or plant markup in what Claude reads", () => {
    for (const c of golden.canaries) {
      const control = golden.mails.find((m) => m.id === c.control)!;
      const input = wrapUntrusted('mail', excerptOf(`${control.body}\n\n${c.inject}`, {}));
      expect(input.match(/<\/?mail\b/g)).toEqual(['<mail', '</mail']);
    }
  });

  test('the paragraph canary (link and a false count) fails the checks', () => {
    expect(checkParagraph({ paragraph: '10 newsletters covered this, see https://evil.example/claim', cites: ['m1'] }, new Set(['m1'])).problems).toEqual(['url', 'count_mismatch']);
  });
});
