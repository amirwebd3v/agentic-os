import { z } from 'zod';
import { loadContact } from '../career/contact.ts';
import type { Requirements } from '../career/intake.ts';
import { atStep, enqueueStep, event, latest, readMaster, saveText, setApp, TailorError } from '../career/tailor.ts';
import { toDraftV2 } from '../career/draft.ts';
import type { Draft } from '../career/draft.ts';
import type { DraftV1 } from '../career/tailor.ts';
import { verifyDraft } from '../career/verify.ts';
import type { Config } from '../config.ts';
import type { Database } from '../db/index.ts';
import { wholeDraftReport } from './career-steps.ts';
import type { JobHandler } from './runner.ts';

const Payload = z.object({ applicationId: z.number().int().positive(), attempt: z.union([z.literal(1), z.literal(2)]), stop: z.enum(['gaps', 'ats']).optional() });

/**
 * Job `career_verify` (contract §4 step 4, §6): plain code, the CV only (the letter comes later, career-v2.md §5).
 * Pass → `career_ats`; fail on attempt 1 → `career_draft` attempt 2; fail on attempt 2 → `career_ats` too: the run
 * goes on and `letter_verify`, which checks the whole draft again, ends it `flagged`. The report is stored, never thrown.
 */
export const careerVerify =
  ({ db, config }: { db: Database; config: Pick<Config, 'vaultDir'> }): JobHandler =>
  async (job) => {
    const p = Payload.safeParse(job.payload);
    if (!p.success) throw new TailorError('career_verify: invalid payload');
    const { applicationId: id, attempt } = p.data;
    if (!atStep(db, id, 'verify')) return;
    const master = readMaster(config.vaultDir);
    const draft = toDraftV2(latest<Draft | DraftV1>(db, id, 'draft'), master.master);
    const report = verifyDraft(
      draft,
      master,
      latest<Requirements>(db, id, 'requirements'),
      loadContact(config.vaultDir),
      { letter: false },
    );
    const counts = { attempt, violations: report.violations.length, codes: [...new Set(report.violations.map((v) => v.code))] };

    db.transaction(() => {
      // A CV refresh keeps the letter and ends at ats, where the latest report sets the status: so that report must
      // cover the kept letter too, checked against the master as it is now (#73 review).
      const keep = !!p.data.stop && draft.letter.paragraphs.length > 0 && (report.ok || attempt === 2);
      saveText(db, id, 'verify_report', keep ? wholeDraftReport(db, id, draft, config.vaultDir) : report);
      if (report.ok || attempt === 2) {
        setApp(db, id, { step: 'ats' });
        event(db, id, 'step', { from: 'verify', to: 'ats', ...counts });
        enqueueStep(db, id, 'ats', 0, p.data.stop);
      } else {
        setApp(db, id, { step: 'draft' });
        event(db, id, 'retry', { from: 'verify', to: 'draft', ...counts });
        enqueueStep(db, id, 'draft', 2, p.data.stop);
      }
    })();
  };
