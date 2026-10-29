import { join } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { openDb } from './db/index.ts';
import { createLoginToken, loginUrl } from './http/auth.ts';
import { approvalRoutes } from './http/routes/approvals.ts';
import { areaRoutes } from './http/routes/areas.ts';
import { careerMasterRoutes } from './http/routes/career-master.ts';
import { careerRoutes, failCareerJob } from './http/routes/career.ts';
import { dashboardRoutes } from './http/routes/dashboard.ts';
import { providerRoutes } from './http/routes/provider.ts';
import { careerDraft } from './jobs/career-draft.ts';
import { careerIntake } from './jobs/career-intake.ts';
import { careerMatch } from './jobs/career-match.ts';
import { careerRender } from './jobs/career-render.ts';
import { careerAts, careerCompany, careerGaps, careerLetter, careerLetterVerify, careerQuestions, careerVacancy } from './jobs/career-steps.ts';
import { careerVerify } from './jobs/career-verify.ts';
import { startRunner } from './jobs/runner.ts';
import { syncAreasFromVault } from './vault/areas.ts';
import { watchVault } from './vault/watch.ts';

// Feature plugins, mounted under /api behind the session check. One line per ticket.
const plugins: FastifyPluginAsync[] = [providerRoutes, areaRoutes, approvalRoutes(), careerRoutes(), careerMasterRoutes(), dashboardRoutes()];

const config = loadConfig();
const db = openDb(join(config.dataDir, 'brain.db'));
const app = await buildApp({ db, config, plugins, dev: process.argv.includes('--dev') });
try {
  syncAreasFromVault(db, config.vaultDir);
} catch (err) {
  // A CLAUDE.md typo must not take the app down: keep the current areas and say why.
  app.log.error(`Area sync skipped (run \`pnpm vault:init\` if the vault is missing): ${(err as Error).message}`);
}
watchVault({ db, vaultDir: config.vaultDir });
// Job handlers by kind, one line per kind. The career pipeline registers its own.
const stopRunner = startRunner(
  db,
  {
    career_intake: careerIntake({ db, config }),
    career_match: careerMatch({ db, config }),
    career_gaps: careerGaps({ db, config }),
    career_draft: careerDraft({ db, config }),
    career_verify: careerVerify({ db, config }),
    career_ats: careerAts({ db, config }),
    career_company: careerCompany({ db, config }),
    career_vacancy: careerVacancy({ db, config }),
    career_questions: careerQuestions({ db, config }),
    career_letter: careerLetter({ db, config }),
    career_letter_verify: careerLetterVerify({ db, config }),
    career_render: careerRender({ db, config }),
  },
  (err) => app.log.error(err, 'job failed'),
  (job) => failCareerJob(db, job),
);
app.addHook('onClose', async () => {
  await stopRunner();
});
await app.listen({ host: '127.0.0.1', port: config.server.port });
console.log(`Open ${loginUrl(config.server.port, createLoginToken(db))}`);
