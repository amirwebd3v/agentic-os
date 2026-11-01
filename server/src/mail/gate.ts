import { redactContact } from '../career/redact.ts';
import type { Contact } from '../career/contact.ts';
import { scrubSecrets } from './secrets.ts';

// The triage gate (spec §3). A pure function: it never calls a model. It returns what it needs next (`ask_laya`,
// `ask_claude`), the caller (E4) gets that answer and calls again, so every branch is testable without a model.

export interface MailFacts {
  labels: readonly string[];
  /** Has `List-Unsubscribe` or `List-Id`. */
  bulk: boolean;
  /** From `scrubSecrets` over the sender, subject and body. */
  secretsHit: boolean;
}

export interface GateContext {
  /** Every category the models may pick, by id. */
  categories: readonly number[];
  personalId: number;
  noiseId: number;
  /** The category of this sender's rule, if the owner made one. */
  rule: number | null;
  /** Still in the first 200 mails (D12). */
  calibrating: boolean;
  /** The "Allow Claude analysis" switch (D17). */
  consent: boolean;
  /** Per category, the Laya confidence needed to file without asking. A category with none is never auto-filed. */
  thresholds: Readonly<Record<number, number>>;
  sensitiveYes: number;
  sensitiveNo: number;
}

export interface GateAnswers {
  /** `sensitive` is Laya's noul: 1 is sensitive. */
  laya?: { sensitive: number; category: number; confidence: number };
  claude?: { category: number };
}

export type GateStep =
  | { action: 'skip' }
  | { action: 'ask_laya' }
  | { action: 'ask_claude' }
  | { action: 'file'; category: number; source: 'rule' | 'secrets' | 'laya' | 'claude'; eligible: boolean }
  | { action: 'needs_sorting'; suggestion: number | null };

export function gate(mail: MailFacts, ctx: GateContext, answers: GateAnswers = {}): GateStep {
  const { labels } = mail;
  const skipped = labels.some((l) => l === 'SPAM' || l === 'TRASH' || l === 'DRAFT') || (labels.includes('SENT') && !labels.includes('INBOX'));
  if (skipped) return { action: 'skip' };

  if (ctx.rule === ctx.personalId) return { action: 'file', category: ctx.personalId, source: 'rule', eligible: false };
  // A rule picks the category but doesn't excuse the checks: eligibility still needs Laya and a clean scan (D7).
  if (ctx.rule === null && mail.secretsHit) return { action: 'file', category: ctx.personalId, source: 'secrets', eligible: false };

  const { laya, claude } = answers;
  if (!laya) return { action: 'ask_laya' };
  const sensitive = laya.sensitive >= ctx.sensitiveYes ? 'yes' : laya.sensitive <= ctx.sensitiveNo ? 'no' : 'unsure';
  // D7, apart from the consent switch, which only guards calls: a mail stays eligible while consent is off.
  const clean = sensitive === 'no' && !mail.secretsHit;
  const eligibleIn = (category: number, approved: boolean) => clean && (mail.bulk || approved) && category !== ctx.personalId && category !== ctx.noiseId;

  if (ctx.rule !== null) return { action: 'file', category: ctx.rule, source: 'rule', eligible: eligibleIn(ctx.rule, true) };

  const known = ctx.categories.includes(laya.category);
  const suggestion = known ? laya.category : null;
  if (ctx.calibrating) return { action: 'needs_sorting', suggestion };
  if (sensitive === 'yes') return { action: 'file', category: ctx.personalId, source: 'laya', eligible: false };
  // D4: unsure counts as Personal until the owner decides, so it never reaches Claude or auto-files elsewhere.
  if (sensitive === 'unsure' || laya.category === ctx.personalId) return { action: 'needs_sorting', suggestion };

  const threshold = ctx.thresholds[laya.category];
  if (known && threshold !== undefined && laya.confidence >= threshold) {
    return { action: 'file', category: laya.category, source: 'laya', eligible: eligibleIn(laya.category, false) };
  }
  if (claude) {
    if (!ctx.categories.includes(claude.category)) return { action: 'needs_sorting', suggestion };
    return { action: 'file', category: claude.category, source: 'claude', eligible: eligibleIn(claude.category, false) };
  }
  if (clean && mail.bulk && ctx.consent) return { action: 'ask_claude' };
  return { action: 'needs_sorting', suggestion };
}

const EXCERPT_CHARS = 1500;

/** Trimmed, with secrets and the owner's contact details out. The only text that may ever be stored from a body. */
export function excerptOf(body: string, contact: Contact): string {
  return redactContact(scrubSecrets(body).text, contact).replace(/\s+/g, ' ').trim().slice(0, EXCERPT_CHARS);
}

export interface StoredFields {
  sender: string | null;
  subject: string | null;
  excerpt: string | null;
  is_personal: 0 | 1;
  eligible: 0 | 1;
}

/** The spec's storage table. Personal keeps nothing; a mail that hit the scan keeps no excerpt, whatever its category. */
export function storedFields(
  step: Extract<GateStep, { action: 'file' | 'needs_sorting' }>,
  mail: { sender: string; subject: string; body: string; secretsHit: boolean },
  ctx: Pick<GateContext, 'personalId' | 'noiseId'>,
  contact: Contact,
): StoredFields {
  const scrub = (s: string) => scrubSecrets(s).text;
  if (step.action === 'needs_sorting') return { sender: mail.sender, subject: scrub(mail.subject), excerpt: null, is_personal: 0, eligible: 0 };
  if (step.category === ctx.personalId) return { sender: null, subject: null, excerpt: null, is_personal: 1, eligible: 0 };
  const excerpt = step.category === ctx.noiseId || mail.secretsHit ? null : excerptOf(mail.body, contact);
  return { sender: mail.sender, subject: scrub(mail.subject), excerpt, is_personal: 0, eligible: step.eligible && excerpt ? 1 : 0 };
}
