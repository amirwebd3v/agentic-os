import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { loadContact } from '../career/contact.ts';
import { refreshDraft, toDraftV2 } from '../career/draft.ts';
import type { Draft } from '../career/draft.ts';
import type { Requirements } from '../career/intake.ts';
import { atStep, enqueueStep, event, failStep, lastIds, latest, readMaster, saveText, setApp, TailorError, writeDraft } from '../career/tailor.ts';
import type { DraftV1, Retry, Selection } from '../career/tailor.ts';
import type { VerifyReport } from '../career/verify.ts';
import { LlmError } from '../llm/errors.ts';
import { sha256 } from '../vault/writer.ts';
import { latestRow } from './career-steps.ts';
import type { CareerIntakeDeps } from './career-intake.ts';
import type { JobHandler } from './runner.ts';

const Payload = z.object({ applicationId: z.number().int().positive(), attempt: z.union([z.literal(1), z.literal(2)]), stop: z.enum(['gaps', 'ats']).optional() });

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

    let fresh: Draft;
    try {
      fresh = await writeDraft({ db, config, contact: loadContact(config.vaultDir), ...(llm ? { llm } : {}) }, master, req, sel, retry, job.id);
    } catch (err) {
      if (!(err instanceof LlmError || err instanceof TailorError)) throw err;
      return failStep(db, id, 'draft', 'provider_error');
    }
    // A CV refresh (#73) replaces the draft that was there before the run (attempt 2: the one attempt 1 replaced):
    // the owner's lines and the letter carry over. What the CV was built from is recorded for the stale check (#72).
    const prev = latestRow(db, id, 'draft');
    const replaces = attempt === 1 ? prev?.version : prev ? (JSON.parse(prev.body) as Partial<Draft>).built?.cv?.previous : undefined;
    const baseBody =
      replaces === undefined
        ? undefined
        : (db.prepare(`SELECT body FROM application_texts WHERE application_id = ? AND kind = 'draft' AND version = ?`).pluck().get(id, replaces) as string);
    const base = baseBody === undefined ? null : toDraftV2(JSON.parse(baseBody) as Draft | DraftV1, master.master);
    const draft: Draft = base ? refreshDraft(base, fresh, lastIds(db, id, base)) : fresh;
    draft.built = {
      cv: {
        posting: latestRow(db, id, 'posting')!.version,
        master: sha256(readFileSync(join(config.vaultDir, 'career', 'master.md'), 'utf8')),
        job: job.id,
        ...(replaces === undefined ? {} : { previous: replaces }),
      },
      ...(base?.built?.letter && { letter: base.built.letter }),
    };

    // Summary lines and entry bullets, as v1 counted them.
    const lines = draft.cv.sections.reduce(
      (n, s) => n + ('entries' in s ? s.entries.reduce((k, e) => k + e.bullets.length, 0) : s.name === 'Summary' ? s.bullets.length : 0),
      0,
    );
    db.transaction(() => {
      saveText(db, id, 'draft', draft);
      setApp(db, id, { step: 'verify' });
      event(db, id, 'step', { from: 'draft', to: 'verify', attempt, cv_lines: lines, paragraphs: draft.letter.paragraphs.length });
      enqueueStep(db, id, 'verify', attempt, p.data.stop);
    })();
  };
