// `pnpm mail:calibrate` (E8): after you have sorted your first 200 mails, shows per category how often Laya's pick
// matched yours and the threshold that would auto-file it at ≥ 95% precision. Counts only, never mail text.
// `pnpm mail:calibrate --apply` saves those thresholds; with any sensitive mail missed it saves none (spec R3).
import { join } from 'node:path';
import { loadConfig } from '../server/src/config.ts';
import { openDb } from '../server/src/db/index.ts';
import { applyCalibration, calibrationReport, MIN_SUPPORT, PRECISION } from '../server/src/mail/calibrate.ts';

const db = openDb(join(loadConfig().dataDir, 'brain.db'));
const report = calibrationReport(db);
console.log(`Sorted by you: ${report.sorted}`);
console.log(`Personal mail Laya called not sensitive: ${report.sensitiveMissed} (must be 0 for any auto-filing)`);
console.log(`Blog ideas and Social ideas confused: ${report.blogSocialConfusion} times (R3: consider merging them if high)\n`);
for (const c of report.categories) {
  const at = c.threshold === null ? `no threshold (needs ${MIN_SUPPORT}+ picks at ${PRECISION * 100}% precision)` : `auto-files at confidence ≥ ${c.threshold.toFixed(2)}, ${(c.precision! * 100).toFixed(0)}% precise`;
  console.log(`${c.name.padEnd(22)} Laya picked ${String(c.picked).padStart(3)}  ${at}`);
}
if (process.argv.includes('--apply')) {
  const saved = applyCalibration(db, report);
  console.log(`\nSaved thresholds for ${Object.keys(saved).length} ${Object.keys(saved).length === 1 ? 'category' : 'categories'}.`);
} else console.log('\nNothing saved. Run with --apply to save these thresholds.');
