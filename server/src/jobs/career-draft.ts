import { z } from 'zod';
import { loadContact } from '../career/contact.ts';
import type { Requirements } from '../career/intake.ts';
import { atStep, enqueueStep, event, failStep, latest, readMaster, saveText, setApp, TailorError, writeDraft } from '../career/tailor.ts';
import type { Draft, Retry, Selection } from '../career/tailor.ts';
import type { VerifyReport } from '../career/verify.ts';
import { LlmError } from '../llm/errors.ts';
import type { CareerIntakeDeps } from './career-intake.ts';
import type { JobHandler } from './runner.ts';

const Payload = z.object({ applicationId: z.number().int().positive(), attempt: z.union([z.literal(1), z.literal(2)]) });

/** Job `career_draft` (contract §4 step 3): `Draft`, then `career_verify`. Attempt 2 reads the stored violations. */
export const careerDraft =
  ({ db, config, llm }: CareerIntakeDeps): JobHandler =>
  async (job) => {
    const p = Payload.safeParse(job.payload);
    if (!p.success) throw new TailorError('career_draft: invalid payload');
    const { applicationId: id, attempt } = p.data;
    if (!atStep(db, id, 'draft')) return;
    const req = latest<Requirements>(db, id, 'requirements');
    const sel = latest<Selection>(db, id, 'selection');
    // The payload carries ids only (contract §1): the violation list comes from the stored report.
    const retry: Retry | undefined =
      attempt === 2 ? { draft: latest<Draft>(db, id, 'draft'), violations: latest<VerifyReport>(db, id, 'verify_report').violations } : undefined;
    const master = readMaster(config.vaultDir);

    let draft;
    try {
      draft = await writeDraft({ db, config, contact: loadContact(config.vaultDir), ...(llm ? { llm } : {}) }, master, req, sel, retry, job.id);
    } catch (err) {
      if (!(err instanceof LlmError || err instanceof TailorError)) throw err;
      return failStep(db, id, 'draft', 'provider_error');
    }

    const lines = draft.entries.reduce((n, e) => n + e.bullets.length, draft.summary ? 1 : 0);
    db.transaction(() => {
      saveText(db, id, 'draft', draft);
      setApp(db, id, { step: 'verify' });
      event(db, id, 'step', { from: 'draft', to: 'verify', attempt, cv_lines: lines, paragraphs: draft.letter.paragraphs.length });
      enqueueStep(db, id, 'verify', attempt);
    })();
  };
