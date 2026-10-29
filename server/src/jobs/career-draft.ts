import { z } from 'zod';
import { loadContact } from '../career/contact.ts';
import { toDraftV2 } from '../career/draft.ts';
import type { Draft } from '../career/draft.ts';
import type { Requirements } from '../career/intake.ts';
import { atStep, enqueueStep, event, failStep, latest, readMaster, saveText, setApp, TailorError, writeDraft } from '../career/tailor.ts';
import type { DraftV1, Retry, Selection } from '../career/tailor.ts';
import type { VerifyReport } from '../career/verify.ts';
import { LlmError } from '../llm/errors.ts';
import type { CareerIntakeDeps } from './career-intake.ts';
import type { JobHandler } from './runner.ts';

const Payload = z.object({ applicationId: z.number().int().positive(), attempt: z.union([z.literal(1), z.literal(2)]) });

/** Job `career_draft` (contract §4 step 3): a v2 `Draft`, then `career_verify`. Attempt 2 reads the stored violations. */
export const careerDraft =
  ({ db, config, llm }: CareerIntakeDeps): JobHandler =>
  async (job) => {
    const p = Payload.safeParse(job.payload);
    if (!p.success) throw new TailorError('career_draft: invalid payload');
    const { applicationId: id, attempt } = p.data;
    if (!atStep(db, id, 'draft')) return;
    const req = latest<Requirements>(db, id, 'requirements');
    const sel = latest<Selection>(db, id, 'selection');
    const master = readMaster(config.vaultDir);
    // The payload carries ids only (contract §1): the violation list comes from the stored report.
    const retry: Retry | undefined =
      attempt === 2
        ? { draft: toDraftV2(latest<Draft | DraftV1>(db, id, 'draft'), master.master), violations: latest<VerifyReport>(db, id, 'verify_report').violations }
        : undefined;

    let draft: Draft;
    try {
      draft = await writeDraft({ db, config, contact: loadContact(config.vaultDir), ...(llm ? { llm } : {}) }, master, req, sel, retry, job.id);
    } catch (err) {
      if (!(err instanceof LlmError || err instanceof TailorError)) throw err;
      return failStep(db, id, 'draft', 'provider_error');
    }

    // Summary lines and entry bullets, as v1 counted them.
    const lines = draft.cv.sections.reduce(
      (n, s) => n + ('entries' in s ? s.entries.reduce((k, e) => k + e.bullets.length, 0) : s.name === 'Summary' ? s.bullets.length : 0),
      0,
    );
    db.transaction(() => {
      saveText(db, id, 'draft', draft);
      setApp(db, id, { step: 'verify' });
      event(db, id, 'step', { from: 'draft', to: 'verify', attempt, cv_lines: lines, paragraphs: draft.letter.paragraphs.length });
      enqueueStep(db, id, 'verify', attempt);
    })();
  };
