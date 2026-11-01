// The gate's secrets scan (spec §3, step 3). A hit files the mail as Personal, so a false positive costs little and a
// miss could send a secret to Claude: the patterns lean towards hitting.
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

const OTP_WORD = String.raw`(?:verification|security|login|log-in|sign-in|confirmation|one[- ]time|access|authentication|auth|2fa|otp|tan|pin|passcode|sicherheits|bestätigungs|einmal|anmelde|verifizierungs)(?:[- ]?codes?|[- ]?password)?`;

const PATTERNS: { kind: SecretKind; re: RegExp }[] = [
  { kind: 'totp', re: /otpauth:\/\/\S+/gi },
  { kind: 'totp', re: /\b(?:secret key|setup key|totp(?: secret)?|recovery codes?|backup codes?|wiederherstellungscodes?)\b[^\n]{0,30}?(?:\b[A-Z2-7]{4,}(?:[ -]?[A-Z2-7]{4,})+\b|\b[A-Z2-7]{16,}\b|\b[a-z0-9]{4,}-[a-z0-9]{4,}\b)/gi },
  { kind: 'reset_link', re: /https?:\/\/\S*(?:(?:password|passwort)[-_/]?(?:reset|recover|change|forgot)|(?:reset|recover|forgot)[-_/]?(?:your[-_])?(?:password|passwort)|reset[-_]?token|magic[-_]?link)\S*/gi },
  { kind: 'reset_link', re: /(?:reset your password|password reset|passwort zurücksetzen|forgot your password|neues passwort)[\s\S]{0,300}?https?:\/\/\S+/gi },
  { kind: 'tax_id', re: /(?:steuer[- ]?id|steuerliche identifikationsnummer|identifikationsnummer|idnr|tax id)[^\d\n]{0,30}\d[\d ]{9,13}\d/gi },
  { kind: 'passport', re: /(?:[Pp]assport|[Rr]eisepass|[Pp]ersonalausweis|PASSPORT)(?:[- ]?(?:[Nn]o\.?|[Nn]r\.?|[Nn]umber|[Nn]ummer))?[^A-Z0-9\n]{0,10}(?=[A-Z]*\d)[A-Z0-9]{8,9}\b/g },
  { kind: 'otp', re: new RegExp(String.raw`(?<![\p{L}])${OTP_WORD}\b[^\n\d]{0,30}\b\d{4,8}\b`, 'giu') },
  { kind: 'otp', re: /\b\d{4,8}\b(?= is your\b[^\n]{0,30}(?:code|password|otp|pin))/gi },
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
  out = out.replace(/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{2,4}){3,8}\b/g, (m) => replaceIban(m, () => kinds.add('iban')));
  out = out.replace(/(?<![\d.])\d(?:[ -]?\d){12,18}(?![\d])/g, (m) => {
    if (!luhn(m.replace(/\D/g, ''))) return m;
    kinds.add('card');
    return MARK;
  });
  return { text: out, kinds: [...kinds] };
}
