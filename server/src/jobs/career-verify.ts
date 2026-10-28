import { z } from 'zod';
import { loadContact } from '../career/contact.ts';
import type { Requirements } from '../career/intake.ts';
import { atStep, event, latest, readMaster, saveText, setApp, TailorError } from '../career/tailor.ts';
import type { Draft } from '../career/tailor.ts';
import { verifyDraft } from '../career/verify.ts';
import type { Config } from '../config.ts';
import type { Database } from '../db/index.ts';
import { enqueue } from '../db/jobs.ts';
import type { JobHandler } from './runner.ts';

const Payload = z.object({ applicationId: z.number().int().positive(), attempt: z.union([z.literal(1), z.literal(2)]) });

/**
 * Job `career_verify` (contract §4 step 4, §6): plain code. Pass → `draft_ready`; fail on attempt 1 → `career_draft`
 * attempt 2; fail on attempt 2 → `flagged`. There is no third attempt. The report is stored, never thrown.
 */
export const careerVerify =
  ({ db, config }: { db: Database; config: Pick<Config, 'vaultDir'> }): JobHandler =>
  async (job) => {
    const p = Payload.safeParse(job.payload);
    if (!p.success) throw new TailorError('career_verify: invalid payload');
    const { applicationId: id, attempt } = p.data;
    if (!atStep(db, id, 'verify')) return;
    const report = verifyDraft(
      latest<Draft>(db, id, 'draft'),
      readMaster(config.vaultDir),
      latest<Requirements>(db, id, 'requirements'),
      loadContact(config.vaultDir),
    );
    const counts = { attempt, violations: report.violations.length, codes: [...new Set(report.violations.map((v) => v.code))] };

    db.transaction(() => {
      saveText(db, id, 'verify_report', report);
      if (report.ok) {
        setApp(db, id, { status: 'draft_ready' });
        event(db, id, 'status', { step: 'verify', status: 'draft_ready', ...counts });
      } else if (attempt === 1) {
        setApp(db, id, { step: 'draft' });
        event(db, id, 'retry', { from: 'verify', to: 'draft', ...counts });
        enqueue(db, 'career_draft', `career:draft:${id}:2`, { applicationId: id, attempt: 2 });
      } else {
        setApp(db, id, { status: 'flagged', fail_code: 'verify_failed' });
        event(db, id, 'status', { step: 'verify', status: 'flagged', fail_code: 'verify_failed', ...counts });
      }
    })();
  };
