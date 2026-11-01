import { CONTACT_FIELDS } from './contact.ts';
import type { Contact, ContactField } from './contact.ts';

const MIN_CHARS = 3; // shorter values would hit ordinary words and numbers
const placeholder = (field: ContactField) => `{{CONTACT_${field.toUpperCase()}}}`;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The literal, with any whitespace run matching any other. */
const lit = (s: string) => s.trim().split(/\s+/).map(esc).join('\\s+');
/** Not inside a longer word, so `Jan Doe` leaves `Jan Doerr` alone. */
const word = (src: string) => `(?<![\\p{L}\\p{N}])(?:${src})(?![\\p{L}\\p{N}])`;
const PHONE_SEP = '(?:\\(0\\)|[\\s\\-./()])*'; // includes the German `+49 (0)30` trunk zero

/** Each variant as [regex source, length of the text it stands for]. Longer variants win where they overlap. */
function variants(field: ContactField, value: string): [string, number][] {
  switch (field) {
    case 'email':
      return [[esc(value), value.length]];
    case 'phone': {
      const digits = value.replace(/\(0\)|\D/g, '').replace(/^00/, '');
      const run = (d: string) => [...d].join(PHONE_SEP);
      // Also the other form of the same number, `+49 30 1234567` <-> `030 1234567`: country code 1-3 digits, trunk 0.
      const tails = /^\D*(?:\+|00)/.test(value) ? [1, 2, 3].map((k) => digits.slice(k)) : digits.startsWith('0') ? [digits.slice(1)] : [];
      return [
        [`(?:\\+|00)?${run(digits)}`, digits.length],
        ...tails.filter((t) => t.length >= 6).map((t): [string, number] => [`(?:(?:\\+|00)\\d{1,3}${PHONE_SEP}|0)${run(t)}`, digits.length]),
      ];
    }
    case 'url': {
      const core = value.replace(/^[a-z][a-z\d+.-]*:\/\//i, '').replace(/^www\./i, '').replace(/\/+$/, '');
      return [[`(?:https?://)?(?:www\\.)?${esc(core)}/?`, core.length]];
    }
    case 'address': {
      // ponytail: every single line is redacted too, so a line like "Germany" also hides that word in a posting; fine for prompts; match whole lines only if it hides a word the model needs.
      const lines = value.split(/[\n,]/).map((l) => l.trim()).filter((l) => l.length >= MIN_CHARS);
      const whole: [string, number][] = lines.length > 1 ? [[lines.map(lit).join('[\\s,]+'), value.length]] : [];
      return [...whole, ...lines.map((l): [string, number] => [lit(l), l.length])];
    }
    case 'name': {
      // Full name, `First Last`, `Last, First Middle`, `Last, First`. Never a lone given name: too many false hits.
      const t = value.split(/\s+/);
      const first = t[0]!;
      const last = t.at(-1)!;
      const forms = t.length < 2 ? [lit(value)] : [lit(value), lit(`${first} ${last}`), `${esc(last)},\\s*${lit(t.slice(0, -1).join(' '))}`, `${esc(last)},\\s*${esc(first)}`];
      return forms.map((src) => [word(src), value.length]);
    }
    case 'dob': {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
      // ponytail: ISO and numeric day-first (01.02.1990, 1/2/1990) only; add month-first or month names if a CV ever carries them.
      return m ? [[esc(value), 10], [`(?<!\\d)0?${Number(m[3])}[./]\\s*0?${Number(m[2])}[./]\\s*${m[1]}`, 10]] : [[lit(value), value.length]];
    }
  }
}

/**
 * Replaces every contact value in `text` with its `{{CONTACT_*}}` placeholder (contract §3.3).
 * Matches e-mail and URL case-insensitively, a URL with or without scheme, `www.` and trailing slash, a phone in any
 * spacing with or without `+`/`00`, the address whole and line by line, and the name as described in `variants`.
 * One pass, so an inserted placeholder is never matched again and a name inside the address goes with the address.
 */
export function redactContact(text: string, contact: Contact): string {
  const alts: { src: string; len: number; field: ContactField }[] = [];
  for (const field of CONTACT_FIELDS) {
    const value = contact[field]?.trim();
    if (!value || value.length < MIN_CHARS) continue;
    for (const [src, len] of variants(field, value)) if (len >= MIN_CHARS) alts.push({ src, len, field });
  }
  if (!alts.length) return text;
  alts.sort((a, b) => b.len - a.len);
  const re = new RegExp(alts.map((a) => `(${a.src})`).join('|'), 'giu');
  return text.replace(re, (...groups: unknown[]) => placeholder(alts[groups.slice(1).findIndex((g) => g !== undefined)]!.field));
}

/** Puts the values back (render only, contract §7). An empty field renders as nothing; an unknown placeholder stays for the verifier. */
export function restoreContact(text: string, contact: Contact): string {
  return text.replace(/\{\{CONTACT_([A-Z]+)\}\}/g, (m, name: string) => {
    const field = name.toLowerCase() as ContactField;
    return CONTACT_FIELDS.includes(field) ? (contact[field] ?? '') : m;
  });
}

/** The last call of every function that builds text for a model. No other code path may build prompt text. */
export const promptSafe = (contact: Contact, text: string): string => redactContact(text, contact);
