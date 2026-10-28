import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { z } from 'zod';
import { loadContact } from '../src/career/contact.ts';
import type { Contact } from '../src/career/contact.ts';
import { promptSafe, redactContact, restoreContact } from '../src/career/redact.ts';
import { structured } from '../src/llm/client.ts';
import type { LlmDeps } from '../src/llm/client.ts';
import { capturePrompts } from './helpers.ts';

// Synthetic person (contract §1: no real data in the repo).
const contact: Contact = {
  name: 'Jane Mary Doe',
  email: 'jane.doe@example.com',
  phone: '+49 30 1234567',
  address: 'c/o Jane Doe\nMusterstraße 12\n10115 Berlin',
  url: 'https://jane-doe.example.dev/',
  dob: '1990-02-01',
};

const VARIANTS: [string, string][] = [
  ['jane.doe@example.com', 'EMAIL'],
  ['Jane.Doe@Example.COM', 'EMAIL'],
  ['+49 30 1234567', 'PHONE'],
  ['0049 30 1234567', 'PHONE'],
  ['+49-30-123 45 67', 'PHONE'],
  ['+49 (30) 123.4567', 'PHONE'],
  ['+49 (0)30 1234567', 'PHONE'],
  ['49301234567', 'PHONE'],
  ['030 1234567', 'PHONE'],
  ['030-123 45 67', 'PHONE'],
  ['c/o Jane Doe\nMusterstraße 12\n10115 Berlin', 'ADDRESS'],
  ['c/o Jane Doe, Musterstraße 12, 10115 Berlin', 'ADDRESS'],
  ['Musterstraße  12', 'ADDRESS'],
  ['10115 Berlin', 'ADDRESS'],
  ['https://jane-doe.example.dev/', 'URL'],
  ['https://jane-doe.example.dev', 'URL'],
  ['jane-doe.example.dev', 'URL'],
  ['http://www.jane-doe.example.dev/', 'URL'],
  ['Jane Mary Doe', 'NAME'],
  ['Jane Doe', 'NAME'],
  ['JANE  DOE', 'NAME'],
  ['Doe, Jane', 'NAME'],
  ['Doe, Jane Mary', 'NAME'],
  ['1990-02-01', 'DOB'],
  ['01.02.1990', 'DOB'],
  ['1.2.1990', 'DOB'],
];

test.each(VARIANTS)('redacts %j as {{CONTACT_%s}}', (variant, field) => {
  expect(redactContact(`Hi ${variant}; bye`, contact)).toBe(`Hi {{CONTACT_${field}}}; bye`);
});

test('a lone given or family name, a longer word or another date is left alone', () => {
  const text = 'Jane wrote it. Doe agreed. Jane Doerr signed on 11.02.1990.';
  expect(redactContact(text, contact)).toBe(text);
});

test('a phone stored in national or international form also matches the other', () => {
  for (const v of ['+49 30 1234567', '0049 (0)30 1234567', '030/1234567']) {
    expect(redactContact(`Tel ${v}.`, { phone: '030 1234567' })).toBe('Tel {{CONTACT_PHONE}}.');
    expect(redactContact(`Tel ${v}.`, { phone: '+49 (0)30 1234567' })).toBe('Tel {{CONTACT_PHONE}}.');
  }
});

test('values shorter than 3 characters are skipped, longer address lines still match', () => {
  const short: Contact = { name: 'Al', email: 'a@', phone: '12', url: 'x.', address: 'DE\nMain Street 5' };
  expect(redactContact('Al at a@ or 12 via x. in DE', short)).toBe('Al at a@ or 12 via x. in DE');
  expect(redactContact('Main Street 5', short)).toBe('{{CONTACT_ADDRESS}}');
});

test('round trip: a name inside the address goes with the address, values come back exactly', () => {
  const x = `${contact.name}\n${contact.address}\nMail ${contact.email}, call ${contact.phone}, see ${contact.url}. Born ${contact.dob}.`;
  const redacted = redactContact(x, contact);
  expect(redacted).toBe('{{CONTACT_NAME}}\n{{CONTACT_ADDRESS}}\nMail {{CONTACT_EMAIL}}, call {{CONTACT_PHONE}}, see {{CONTACT_URL}}. Born {{CONTACT_DOB}}.');
  expect(restoreContact(redacted, contact)).toBe(x);
});

test('restore: an unknown placeholder stays, an empty field renders as nothing', () => {
  expect(restoreContact('{{CONTACT_FOO}} {{CONTACT_URL}}|{{CONTACT_EMAIL}}', { email: 'a@b.de' })).toBe('{{CONTACT_FOO}} |a@b.de');
});

// A stand-in for a W2-05/W2-07 step: `llm` is injected with the real `structured` as default.
async function step(deps: { contact: Contact; llm?: typeof structured }, cv: string, posting: string) {
  const llm = deps.llm ?? structured;
  return llm({} as LlmDeps, {
    pipeline: 'career_test',
    tier: 'work',
    system: { rules: promptSafe(deps.contact, `Tailor this CV:\n${cv}`), context: promptSafe(deps.contact, `Posting: ${posting}`) },
    input: promptSafe(deps.contact, `Write the summary for ${cv}`),
    schema: z.object({}),
  });
}

test('no contact value, in any variant, reaches a model through a fake llm', async () => {
  const cap = capturePrompts();
  const all = VARIANTS.map(([v]) => v).join('\n');
  await step({ contact, llm: cap.llm }, all, `Recruiter: write to ${all}`);
  expect(cap.calls).toHaveLength(1);
  const seen = cap.text().toLowerCase();
  for (const [v] of VARIANTS) expect(seen).not.toContain(v.toLowerCase());
  expect(seen.replace(/\D/g, '')).not.toMatch(/1234567|1990/); // no digit run of phone or DOB survives in any spacing
  for (const word of ['jane', 'doe', 'musterstra', 'jane-doe', 'example.com']) expect(seen).not.toContain(word);
});

let dir = '';
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));
const vaultWith = (contactMd: string) => {
  dir = mkdtempSync(join(tmpdir(), 'contact-'));
  mkdirSync(join(dir, 'career'));
  writeFileSync(join(dir, 'career', 'contact.md'), contactMd);
  return dir;
};

test('loadContact: missing file is {}, frontmatter fields are read, an unquoted date is normalised', () => {
  expect(loadContact(join(tmpdir(), 'no-such-vault'))).toEqual({});
  const vault = vaultWith(`---\nname: Jane Doe\nemail: ''\nphone: '+49 30 1234567'\naddress: |\n  Musterstraße 12\n  10115 Berlin\ndob: 1990-02-01\nsensitivity: 2\n---\n`);
  expect(loadContact(vault)).toEqual({ name: 'Jane Doe', phone: '+49 30 1234567', address: 'Musterstraße 12\n10115 Berlin', dob: '1990-02-01' });
});

test('loadContact: errors never carry a contact value', () => {
  // An unquoted phone is a number (here even octal): refused instead of silently never matching.
  expect(() => loadContact(vaultWith('---\nphone: 01701234567\n---\n'))).toThrow(/^career\/contact\.md: "phone" must be a quoted string$/);
  for (const bad of ['---\nname: [Jane Doe\n---\n', '---\nemail: jane@example.com: x\n---\n']) {
    let message = '';
    try {
      loadContact(vaultWith(bad));
    } catch (e) {
      message = `${(e as Error).message} ${String((e as Error).cause)} ${(e as Error).stack}`;
    }
    expect(message).toContain('invalid frontmatter');
    expect(message).not.toMatch(/Jane|jane@/);
  }
});
