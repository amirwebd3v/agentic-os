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
  /** From `injectionSuspected`: the mail talks to the model. */
  injection?: boolean;
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
  /** `keepText` is false for a mail that isn't clean: filed by a rule, but Laya called it sensitive or the scan hit. */
  | { action: 'file'; category: number; source: 'rule' | 'secrets' | 'laya' | 'claude'; eligible: boolean; keepText: boolean }
  | { action: 'needs_sorting'; suggestion: number | null };

export function gate(mail: MailFacts, ctx: GateContext, answers: GateAnswers = {}): GateStep {
  const { labels } = mail;
  const skipped = labels.some((l) => l === 'SPAM' || l === 'TRASH' || l === 'DRAFT') || (labels.includes('SENT') && !labels.includes('INBOX'));
  if (skipped) return { action: 'skip' };

  if (ctx.rule === ctx.personalId) return { action: 'file', category: ctx.personalId, source: 'rule', eligible: false, keepText: false };
  // A rule picks the category but doesn't excuse the checks: eligibility still needs Laya and a clean scan (D7).
  if (ctx.rule === null && mail.secretsHit) return { action: 'file', category: ctx.personalId, source: 'secrets', eligible: false, keepText: false };
  // A mail that talks to the model is sorted by the owner, and no model sees it: both can be steered.
  if (ctx.rule === null && mail.injection) return { action: 'needs_sorting', suggestion: null };

  const { laya, claude } = answers;
  if (!laya) return { action: 'ask_laya' };
  const sensitive = laya.sensitive >= ctx.sensitiveYes ? 'yes' : laya.sensitive <= ctx.sensitiveNo ? 'no' : 'unsure';
  // D7, apart from the consent switch, which only guards calls: a mail stays eligible while consent is off. A mail
  // under a rule that talks to the model keeps no text, so it never reaches a paragraph prompt either.
  const clean = sensitive === 'no' && !mail.secretsHit && !mail.injection;
  const eligibleIn = (category: number, approved: boolean) => clean && (mail.bulk || approved) && category !== ctx.personalId && category !== ctx.noiseId;

  if (ctx.rule !== null) return { action: 'file', category: ctx.rule, source: 'rule', eligible: eligibleIn(ctx.rule, true), keepText: clean };

  const known = ctx.categories.includes(laya.category);
  const suggestion = known ? laya.category : null;
  if (ctx.calibrating) return { action: 'needs_sorting', suggestion };
  if (sensitive === 'yes') return { action: 'file', category: ctx.personalId, source: 'laya', eligible: false, keepText: false };
  // D4: unsure counts as Personal until the owner decides, so it never reaches Claude or auto-files elsewhere.
  if (sensitive === 'unsure' || laya.category === ctx.personalId) return { action: 'needs_sorting', suggestion };

  const threshold = ctx.thresholds[laya.category];
  if (known && threshold !== undefined && laya.confidence >= threshold) {
    return { action: 'file', category: laya.category, source: 'laya', eligible: eligibleIn(laya.category, false), keepText: clean };
  }
  if (!clean || !mail.bulk || !ctx.consent) return { action: 'needs_sorting', suggestion };
  if (!claude) return { action: 'ask_claude' };
  if (!ctx.categories.includes(claude.category)) return { action: 'needs_sorting', suggestion };
  return { action: 'file', category: claude.category, source: 'claude', eligible: eligibleIn(claude.category, false), keepText: true };
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

/**
 * The spec's storage table. Personal keeps nothing; a mail that isn't clean keeps no excerpt, whatever its category.
 * `sender` stays raw so the owner can sort and match rules; the prompt builder (E6) redacts it. The body is scanned
 * again here, so a caller that scanned too little can't make a mail with a secret eligible.
 */
export function storedFields(
  step: Extract<GateStep, { action: 'file' | 'needs_sorting' }>,
  mail: { sender: string; subject: string; body: string },
  ctx: Pick<GateContext, 'personalId' | 'noiseId'>,
  contact: Contact,
): StoredFields {
  const subject = redactContact(scrubSecrets(mail.subject).text, contact);
  if (step.action === 'needs_sorting') return { sender: mail.sender, subject, excerpt: null, is_personal: 0, eligible: 0 };
  if (step.category === ctx.personalId) return { sender: null, subject: null, excerpt: null, is_personal: 1, eligible: 0 };
  const keep = step.keepText && step.category !== ctx.noiseId && scrubSecrets(mail.body).kinds.length === 0;
  const excerpt = keep ? excerptOf(mail.body, contact) : null;
  return { sender: mail.sender, subject, excerpt, is_personal: 0, eligible: step.eligible && excerpt ? 1 : 0 };
}
