// The gate's secrets scan (spec §3, step 3). A hit files the mail as Personal, so a false positive costs little and a
// miss could send a secret to Claude: the patterns lean towards hitting. Mail is untrusted input: every quantifier
// here must have one way to split a string, so a hostile mail can't hang the single worker.
export type SecretKind = 'iban' | 'card' | 'otp' | 'totp' | 'tax_id' | 'passport' | 'reset_link';

const MARK = '[redacted]';

function ibanValid(s: string): boolean {
  if (s.length < 15 || s.length > 34) return false;
  const digits = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rem = 0;
  for (const d of digits) rem = (rem * 10 + Number(d)) % 97;
  return rem === 1;
}

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    const d = Number(digits[digits.length - 1 - i]);
    sum += i % 2 ? (d * 2 > 9 ? d * 2 - 9 : d * 2) : d;
  }
  return sum % 10 === 0;
}

/** A word in capitals can follow a spaced IBAN ("… 00 BIC"), so groups are dropped from the end until the checksum holds. */
function replaceIban(match: string, hit: () => void): string {
  const parts = match.split(' ');
  for (let n = parts.length; n >= 1; n--) {
    if (ibanValid(parts.slice(0, n).join(''))) {
      hit();
      return [MARK, ...parts.slice(n)].join(' ');
    }
  }
  return match;
}

/**
 * Other digits can sit next to a card ("… 1111 12/28", "Order 12345 4111 …"), so every run of whole digit groups is
 * tried. ponytail: a long unspaced run is tried whole only, as windows inside one would pass Luhn by chance; a card
 * glued to other digits is missed; slide a window if one ever shows up.
 */
function replaceCard(match: string, hit: () => void): string {
  const tokens = match.split(/([ -])/); // groups at even indexes, separators at odd
  for (let i = 0; i < tokens.length; i += 2) {
    let digits = '';
    for (let j = i; j < tokens.length; j += 2) {
      digits += tokens[j];
      if (digits.length > 19) break; // keeps a long hostile run linear
      if (digits.length >= 13 && luhn(digits)) {
        hit();
        return [...tokens.slice(0, i), MARK, ...tokens.slice(j + 1)].join('');
      }
    }
  }
  return match;
}

/** Case-insensitive source for a keyword, so a pattern's value part can stay case-sensitive. */
const ci = (word: string) => word.replace(/\p{L}/gu, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`);

const OTP_WORD = String.raw`(?:verification|security|login|log-in|sign-in|confirmation|one[- ]time|access|authentication|auth|2fa|otp|tan|pin|passcode|sicherheits|bestätigungs|einmal|anmelde|verifizierungs)(?:[- ]?codes?|[- ]?password)?`;
const TOTP_WORD = ['secret key', 'setup key', 'totp secret', 'totp', 'recovery code', 'backup code', 'wiederherstellungscode'].map(ci).join('|');
const BASE32 = String.raw`[A-Z2-7]{4}(?:[ -]?[A-Z2-7]{4}){3,}`; // fixed chunks: one way to split
const BACKUP_CODE = String.raw`(?=[a-z-]*\d)[a-z0-9]{4,10}-[a-z0-9]{4,10}`;

const PATTERNS: { kind: SecretKind; re: RegExp }[] = [
  { kind: 'totp', re: /otpauth:\/\/\S+/gi },
  { kind: 'totp', re: new RegExp(String.raw`(?:${TOTP_WORD})[\s\S]{0,40}?\b(?:${BASE32}|${BACKUP_CODE})\b`, 'g') },
  { kind: 'reset_link', re: /https?:\/\/\S{0,200}?(?:(?:password|passwort)[-_/]?(?:reset|recover|change|forgot)|(?:reset|recover|forgot)[-_/]?(?:your[-_])?(?:password|passwort)|\/(?:reset|forgot|recover|verify|confirm|activate)(?:[-_/?]|$)|reset[-_]?token|magic[-_/]?link)\S{0,500}/gi },
  { kind: 'reset_link', re: /(?:reset your password|password reset|passwort zurücksetzen|forgot your password|neues passwort)[\s\S]{0,300}?https?:\/\/\S{1,500}/gi },
  { kind: 'tax_id', re: /(?:steuer[- ]?id|steuerliche identifikationsnummer|identifikationsnummer|idnr|tax id)\D{0,30}\d(?:[ ]?\d){9,12}/gi },
  { kind: 'passport', re: new RegExp(String.raw`(?:${['passport', 'reisepass', 'personalausweis'].map(ci).join('|')})(?:[- ]?(?:[Nn]o\.?|[Nn]r\.?|[Nn]umber|[Nn]ummer))?[^A-Z0-9]{0,10}(?=[A-Z]*\d)[A-Z0-9]{8,9}\b`, 'g') },
  { kind: 'otp', re: new RegExp(String.raw`(?<![\p{L}])${OTP_WORD}\b\D{0,40}\b\d{4,8}\b`, 'giu') },
  { kind: 'otp', re: /\b(?:your|enter|use|this|the)\s+(?:(?!promo|discount|coupon|voucher|rabatt|gutschein)\S{1,20}\s+)?code\b\D{0,20}\b\d{4,8}\b/gi },
  { kind: 'otp', re: /\b\d{4,8}\b(?= is your\b[^\n]{0,30}(?:code|password|otp|pin))/gi },
  { kind: 'otp', re: /\b(?:use|enter)\s+\d{4,8}\b(?=\s+to\s+(?:verify|confirm|log|sign))/gi },
  { kind: 'otp', re: /\bG-\d{6}\b/g },
];

/** Replaces every secret with `[redacted]` and reports which kinds were found. */
export function scrubSecrets(text: string): { text: string; kinds: SecretKind[] } {
  const kinds = new Set<SecretKind>();
  let out = text;
  for (const { kind, re } of PATTERNS) {
    out = out.replace(re, () => {
      kinds.add(kind);
      return MARK;
    });
  }
  // HTML mail turned into text often puts the code alone on a line.
  if (/code|verif|bestätig|anmeld/i.test(text)) {
    out = out.replace(/^[ \t]*\d{6,8}[ \t]*$/gm, () => {
      kinds.add('otp');
      return MARK;
    });
  }
  out = out.replace(/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{2,4}){3,8}\b/g, (m) => replaceIban(m, () => kinds.add('iban')));
  out = out.replace(/(?<![\d.])\d+(?:[ -]\d+)*/g, (m) => (m.replace(/\D/g, '').length < 13 ? m : replaceCard(m, () => kinds.add('card'))));
  return { text: out, kinds: [...kinds] };
}
