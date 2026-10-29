import { z } from 'zod';
import { loadContact } from '../career/contact.ts';
import { extractRequirements, IntakeError } from '../career/intake.ts';
import { enqueueStep, saveText } from '../career/tailor.ts';
import type { Config } from '../config.ts';
import { audit } from '../db/audit.ts';
import type { Database } from '../db/index.ts';
import type { structured } from '../llm/client.ts';
import { LlmError } from '../llm/errors.ts';
import type { JobHandler } from './runner.ts';

export interface CareerIntakeDeps {
  db: Database;
  config: Pick<Config, 'llm' | 'vaultDir'>;
  /** Defaults to the real `structured()`; tests pass a fake. */
  llm?: typeof structured;
}

const Payload = z.object({ applicationId: z.number().int().positive() });
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

/** Job `career_intake` (contract §4 step 1). Expected failures mark the application and return; only fixed messages are thrown. */
export const careerIntake =
  ({ db, config, llm }: CareerIntakeDeps): JobHandler =>
  async (job) => {
    const p = Payload.safeParse(job.payload);
    if (!p.success) throw new IntakeError('career_intake: invalid payload');
    const id = p.data.applicationId;
    const app = db.prepare('SELECT status, step FROM applications WHERE id = ?').get(id) as { status: string; step: string | null } | undefined;
    if (!app) throw new IntakeError('career_intake: application not found');
    if (app.status !== 'processing' || app.step !== 'intake') return; // already past intake: nothing to redo
    const posting = db
      .prepare(`SELECT body FROM application_texts WHERE application_id = ? AND kind = 'posting' ORDER BY version DESC LIMIT 1`)
      .pluck()
      .get(id) as string | undefined;
    if (posting === undefined) throw new IntakeError('career_intake: posting not found');

    let req;
    try {
      req = await extractRequirements({ db, config, contact: loadContact(config.vaultDir), ...(llm ? { llm } : {}) }, posting, job.id);
    } catch (err) {
      if (!(err instanceof LlmError || err instanceof IntakeError)) throw err;
      db.transaction(() => {
        db.prepare(`UPDATE applications SET status = 'failed', fail_code = 'provider_error', updated_at = ${NOW} WHERE id = ?`).run(id);
        db.prepare(`INSERT INTO application_events (application_id, kind, detail) VALUES (?, 'failed', ?)`).run(id, JSON.stringify({ step: 'intake', fail_code: 'provider_error' }));
        audit(db, { actor: 'app', action: 'career.application.fail', args: { application_id: id, step: 'intake', fail_code: 'provider_error' } });
      })();
      return;
    }

    const detail = { from: 'intake', to: 'match', must_have: req.must_have.length, nice_to_have: req.nice_to_have.length, injection_suspected: req.injection_suspected };
    db.transaction(() => {
      saveText(db, id, 'requirements', req); // a retried run (`POST …/retry`) adds a version
      // The posting's company name replaces the one typed on the form; a posting that names none keeps the typed one.
      db.prepare(`UPDATE applications SET company = COALESCE(?, company), role_title = ?, language = ?, step = 'match', updated_at = ${NOW} WHERE id = ?`).run(
        req.company || null,
        req.role_title || null,
        req.language,
        id,
      );
      db.prepare(`INSERT INTO application_events (application_id, kind, detail) VALUES (?, 'step', ?)`).run(id, JSON.stringify(detail));
      audit(db, { actor: 'app', action: 'career.application.step', args: { application_id: id, ...detail } });
      enqueueStep(db, id, 'match', 0);
    })();
  };
