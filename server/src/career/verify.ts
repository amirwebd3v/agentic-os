import { CONTACT_FIELDS } from './contact.ts';
import type { Contact } from './contact.ts';
import { scrubContactLike } from './document.ts';
import type { Requirements } from './intake.ts';
import { ID_RE } from './master.ts';
import { redactContact } from './redact.ts';
import type { CvLine, Draft } from './draft.ts';
import type { MasterIndex } from './tailor.ts';

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
  | 'too_many_lines'
  | 'letter_length'
  | 'cliche';
export interface Violation {
  code: ViolationCode;
  ref: string;
  token?: string;
}
export interface VerifyReport {
  ok: boolean;
  violations: Violation[];
}

const MAX = { summary: 300, bullet: 300, paragraph: 1200, bullets: 18, minParagraphs: 3, maxParagraphs: 5, cites: 5, token: 40, minWords: 250, maxWords: 350 } as const;
/**
 * Phrases a letter must not use (career-v2.md §5); the letter prompt bans a longer list. Matched whole-word and
 * case-insensitively, a space or hyphen matching either; the violation's token is the phrase from this list, never
 * the letter's text.
 */
export const CLICHES = ['passionate', 'team player', 'proven track record', 'results-driven', 'think outside the box', 'perfect fit', 'dream job', 'I am writing to express'] as const;
const CLICHE_RE = CLICHES.map((c) => [c, new RegExp(`(?<!\\p{L})${c.split(/[\s-]+/).join('[\\s-]+')}(?!\\p{L})`, 'iu')] as const);

export interface VerifyOptions {
  /** Check the letter (default). The CV-only verify after `draft` runs before the letter exists. */
  letter?: boolean;
  /** Letter-only cite targets beyond the master: answer ids (`a-<n>`) and verified company points (`c-<n>`) → their text. */
  sources?: ReadonlyMap<string, string>;
  /** More whole phrases the letter may name (the company name typed on the form). */
  phrases?: string[];
}
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
 * Checks a draft against the master (contract §6, career-v2.md §1): every model line traced to the lines it cites,
 * by plain code. Refs: a line id (`l-7`), an entry id (`e-2`: its `source` is unknown), or `cv`, `letter`, `cv.skills`.
 * Owner and suggestion lines are not checked against cites, only for contact leaks and placeholders.
 * ponytail: numbers written as words ("four") and wording ("led" for "helped") pass; the user's review is the last check.
 */
export function verifyDraft(
  draft: Draft,
  m: MasterIndex,
  req: Pick<Requirements, 'company' | 'role_title'>,
  contact: Contact = {},
  opts: VerifyOptions = {},
): VerifyReport {
  const out = new Map<string, Violation>();
  const add = (code: ViolationCode, ref: string, token?: string) => {
    const v: Violation = token === undefined ? { code, ref } : { code, ref, token: token.slice(0, MAX.token).replace(/[\uD800-\uDBFF]$/, '') };
    out.set(JSON.stringify(v), v);
  };
  const idToken = (id: string) => (ID_RE.test(id) ? id : undefined); // a token is never free text here

  /**
   * `entry`: the line sits under an entry, so each cite must be a bullet of the entry's `source`.
   * `phrases`: whole strings a line may also use (the letter's company and role title), never their loose tokens.
   */
  const check = (l: CvLine, max: number, entry?: { source?: string | undefined }, phrases: string[] = [], extra?: ReadonlyMap<string, string>) => {
    const ref = l.id;
    const model = l.origin === 'model';
    if (model && l.text.length > max) add('too_long', ref);
    if (model && (l.cites.length < 1 || l.cites.length > MAX.cites)) add('missing_cite', ref);
    const cited: string[] = [];
    for (const c of model ? l.cites : []) {
      const src = m.sources.get(c) ?? extra?.get(c);
      if (src === undefined) add('unknown_cite', ref, idToken(c));
      else if (entry && (entry.source === undefined || m.owner.get(c) !== entry.source)) add('wrong_entry', ref, c);
      else cited.push(src);
    }
    // No token for a leak, and the checks below run on the redacted text, so no token ever carries the value.
    let text = redactContact(scrubContactLike(l.text), contact);
    if (text !== l.text) add('contact_leak', ref);
    for (const p of PLACEHOLDERS) text = text.replaceAll(p, ' ');
    if (/\{\{|\}\}/.test(text)) add('bad_placeholder', ref, /\{\{[^}]*\}?\}?/.exec(text)?.[0]);
    if (!model) return;
    if (extra) for (const [c, re] of CLICHE_RE) if (re.test(text)) add('cliche', ref, c);
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

  let bullets = 0;
  for (const s of draft.cv.sections) {
    if ('entries' in s) {
      for (const e of s.entries) {
        if (e.source !== undefined && !m.entries.has(e.source)) add('unknown_cite', e.id, idToken(e.source));
        for (const b of e.bullets) check(b, MAX.bullet, e);
        bullets += e.bullets.length;
      }
    } else if (s.name === 'Skills') {
      // A model skill line is the master's text, copied by code: only its ids need checking.
      for (const l of s.bullets) {
        if (l.origin !== 'model') check(l, Infinity);
        else for (const c of l.cites.length ? l.cites : ['']) if (!m.skills.has(c)) add('unknown_cite', 'cv.skills', idToken(c));
      }
    } else for (const l of s.bullets) check(l, s.name === 'Summary' ? MAX.summary : Infinity); // Languages: master text, copied by code
  }
  if (bullets > MAX.bullets) add('too_many_lines', 'cv');
  if (opts.letter !== false) {
    const { paragraphs } = draft.letter;
    if (paragraphs.length < MAX.minParagraphs || paragraphs.length > MAX.maxParagraphs) add('too_many_lines', 'letter');
    const words = paragraphs.reduce((n, p) => n + (p.text.match(/\S+/g)?.length ?? 0), 0);
    if (words < MAX.minWords || words > MAX.maxWords) add('letter_length', 'letter');
    for (const p of paragraphs) check(p, MAX.paragraph, undefined, [req.company, req.role_title, ...(opts.phrases ?? [])], opts.sources ?? new Map());
  }

  const violations = [...out.values()];
  return { ok: violations.length === 0, violations };
}
