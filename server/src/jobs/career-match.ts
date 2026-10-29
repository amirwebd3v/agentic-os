import { z } from 'zod';
import { loadContact } from '../career/contact.ts';
import type { Requirements } from '../career/intake.ts';
import { atStep, coverage, enqueueStep, event, failStep, latest, readMaster, saveText, selectBullets, setApp, TailorError } from '../career/tailor.ts';
import { LlmError } from '../llm/errors.ts';
import type { CareerIntakeDeps } from './career-intake.ts';
import type { JobHandler } from './runner.ts';

const Payload = z.object({ applicationId: z.number().int().positive() });

/** Job `career_match` (contract §4 step 2): requirements → `Selection`, then `career_draft` attempt 1. */
export const careerMatch =
  ({ db, config, llm }: CareerIntakeDeps): JobHandler =>
  async (job) => {
    const p = Payload.safeParse(job.payload);
    if (!p.success) throw new TailorError('career_match: invalid payload');
    const id = p.data.applicationId;
    if (!atStep(db, id, 'match')) return;
    const req = latest<Requirements>(db, id, 'requirements');
    const master = readMaster(config.vaultDir);

    let sel;
    try {
      sel = await selectBullets({ db, config, contact: loadContact(config.vaultDir), ...(llm ? { llm } : {}) }, master, req, job.id);
    } catch (err) {
      if (!(err instanceof LlmError || err instanceof TailorError)) throw err;
      return failStep(db, id, 'match', 'provider_error');
    }
    if (typeof sel === 'string') return failStep(db, id, 'match', sel);

    const { matched, total } = coverage(req, sel);
    const bullets = sel.entries.reduce((n, e) => n + e.bullet_ids.length, 0);
    db.transaction(() => {
      saveText(db, id, 'selection', sel);
      setApp(db, id, { step: 'draft' });
      event(db, id, 'step', { from: 'match', to: 'draft', matched, total, unmatched: sel.unmatched.length, entries: sel.entries.length, bullets, skills: sel.skill_ids.length });
      enqueueStep(db, id, 'draft', 1);
    })();
  };
