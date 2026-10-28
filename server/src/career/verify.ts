import { CONTACT_FIELDS } from './contact.ts';
import type { Contact } from './contact.ts';
import { scrubContactLike } from './document.ts';
import type { Requirements } from './intake.ts';
import { ID_RE } from './master.ts';
import { redactContact } from './redact.ts';
import type { Draft, DraftLine, MasterIndex } from './tailor.ts';

/** Contract §6. A result, never thrown. */
export type ViolationCode =
  | 'unknown_cite'
  | 'wrong_entry'
  | 'missing_cite'
  | 'unsupported_number'
  | 'unsupported_entity'
  | 'contact_leak'
  | 'bad_placeholder'
  | 'too_long'
  | 'too_many_lines';
export interface Violation {
  code: ViolationCode;
  ref: string;
  token?: string;
}
export interface VerifyReport {
  ok: boolean;
  violations: Violation[];
}

const MAX = { summary: 300, bullet: 300, paragraph: 700, bullets: 18, minParagraphs: 3, maxParagraphs: 5, cites: 5, token: 40 } as const;
const PLACEHOLDERS = new Set(CONTACT_FIELDS.map((f) => `{{CONTACT_${f.toUpperCase()}}}`));

const NUMBER = /\p{Nd}+(?:[.,]\p{Nd}+)*(?:\s?%)?/gu;
/** Decimal comma and `40 %` normalised, so `4,5` matches `4.5` and `40 %` matches `40%`. */
const numbers = (s: string) => (s.match(NUMBER) ?? []).map((n) => n.replace(/\s/g, '').replace(/,/g, '.'));

/** Whole tokens split on spaces and hyphens, outer punctuation and a possessive `'s` removed. `start`: sentence-initial. */
function tokens(s: string): { t: string; start: boolean }[] {
  const raw = s.split(/[\s\-‐‑–—]+/).filter(Boolean);
  return raw
    .map((r, i) => ({
      t: r.replace(/^[^\p{L}\p{N}+#]+|[^\p{L}\p{N}+#]+$/gu, '').replace(/['’]s$/u, ''),
      start: i === 0 || /[.!?:]["'’”)\]]*$/u.test(raw[i - 1]!),
    }))
    .filter((x) => x.t);
}

/** Acronyms, tokens with a digit (and a letter), an inner capital or `+ # .`; for `en` also capitalised non-initial words. */
const isEntity = ({ t, start }: { t: string; start: boolean }, language: 'en' | 'de') =>
  /\p{Lu}.*\p{Lu}/u.test(t) ||
  (/\p{N}/u.test(t) && /\p{L}/u.test(t)) ||
  /.\p{Lu}/u.test(t) ||
  /[+#.]/.test(t) ||
  (language === 'en' && !start && t.length > 1 && /^\p{Lu}/u.test(t));

/**
 * Checks a draft against the master (contract §6): every line traced to the lines it cites, by plain code.
 * Refs: `cv.summary`, `cv.entries.<entry_id>.<index>`, `letter.<index>` (from 0), plus `cv.skills`, `cv`, `letter`.
 * ponytail: numbers written as words ("four") and wording ("led" for "helped") pass; the user's review is the last check.
 */
export function verifyDraft(draft: Draft, m: MasterIndex, req: Pick<Requirements, 'company' | 'role_title'>, contact: Contact = {}): VerifyReport {
  const out = new Map<string, Violation>();
  const add = (code: ViolationCode, ref: string, token?: string) => {
    const v: Violation = token === undefined ? { code, ref } : { code, ref, token: token.slice(0, MAX.token).replace(/[\uD800-\uDBFF]$/, '') };
    out.set(JSON.stringify(v), v);
  };

  /** `phrases`: whole strings a line may also use (the letter's company and role title), never their loose tokens. */
  const check = (ref: string, l: DraftLine, max: number, entryId?: string, phrases: string[] = []) => {
    if (l.text.length > max) add('too_long', ref);
    if (l.cites.length < 1 || l.cites.length > MAX.cites) add('missing_cite', ref);
    const cited: string[] = [];
    for (const c of l.cites) {
      const src = m.sources.get(c);
      if (src === undefined) add('unknown_cite', ref, ID_RE.test(c) ? c : undefined); // a token is never free text here
      else if (entryId !== undefined && m.owner.get(c) !== entryId) add('wrong_entry', ref, c);
      else cited.push(src);
    }
    // No token for a leak, and the checks below run on the redacted text, so no token ever carries the value.
    let text = redactContact(scrubContactLike(l.text), contact);
    if (text !== l.text) add('contact_leak', ref);
    for (const p of PLACEHOLDERS) text = text.replaceAll(p, ' ');
    if (/\{\{|\}\}/.test(text)) add('bad_placeholder', ref, /\{\{[^}]*\}?\}?/.exec(text)?.[0]);
    // Whole phrases only: a posting can't widen what the letter may claim by stuffing words into its company name.
    for (const p of phrases) if (p.trim()) text = text.replace(new RegExp(p.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu'), ' ');

    const source = cited.join('\n');
    const nums = new Set(numbers(source));
    for (const n of numbers(text)) if (!nums.has(n)) add('unsupported_number', ref, n);
    const known = new Set(tokens(source).map((x) => x.t.toLowerCase()));
    for (const x of tokens(text)) {
      if (!/^\p{N}+$/u.test(x.t.replace(/[.,%]/g, '')) && isEntity(x, m.language) && !known.has(x.t.toLowerCase())) add('unsupported_entity', ref, x.t);
    }
  };

  if (draft.summary) check('cv.summary', draft.summary, MAX.summary);
  let bullets = 0;
  for (const e of draft.entries) {
    if (!m.entries.has(e.entry_id)) add('unknown_cite', `cv.entries.${e.entry_id}`, e.entry_id);
    e.bullets.forEach((b, i) => check(`cv.entries.${e.entry_id}.${i}`, b, MAX.bullet, e.entry_id));
    bullets += e.bullets.length;
  }
  if (bullets > MAX.bullets) add('too_many_lines', 'cv');
  for (const s of draft.skill_ids) if (!m.skills.has(s)) add('unknown_cite', 'cv.skills', ID_RE.test(s) ? s : undefined);
  const { paragraphs } = draft.letter;
  if (paragraphs.length < MAX.minParagraphs || paragraphs.length > MAX.maxParagraphs) add('too_many_lines', 'letter');
  paragraphs.forEach((p, i) => check(`letter.${i}`, p, MAX.paragraph, undefined, [req.company, req.role_title]));

  const violations = [...out.values()];
  return { ok: violations.length === 0, violations };
}
