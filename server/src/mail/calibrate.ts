import type { Database } from '../db/index.ts';

// Turns the owner's first 200 sorted mails into per-category thresholds (D12, spec §5 "Calibration"). Auto-filing on
// Laya alone starts only at ≥ 95% precision for a category, and only if no mail the owner filed as Personal was
// called "not sensitive" by Laya. Counts only: no mail text is read.
export const PRECISION = 0.95;
export const MIN_SUPPORT = 5; // fewer confident picks than this prove nothing

export interface CategoryReport { id: number; name: string; picked: number; threshold: number | null; precision: number | null }
export interface CalibrationReport {
  sorted: number;
  /** Mails the owner filed as Personal that Laya called not sensitive. Must be 0 for any auto-filing. */
  sensitiveMissed: number;
  categories: CategoryReport[];
  /** R3: how often Laya picked one of Blog ideas / Social ideas when the owner chose the other. */
  blogSocialConfusion: number;
}

interface Pick { owner: string; laya: string; confidence: number }

/** The lowest confidence at which Laya's picks of this category are right at least 95% of the time. */
function thresholdFor(name: string, picks: Pick[]): Omit<CategoryReport, 'id' | 'name'> {
  const mine = picks.filter((p) => p.laya === name).sort((a, b) => b.confidence - a.confidence);
  let right = 0;
  let threshold: number | null = null;
  let precision: number | null = null;
  for (let i = 0; i < mine.length; i++) {
    const p = mine[i]!;
    if (p.owner === name) right++;
    const n = i + 1;
    const next = mine[i + 1];
    // Only cut between distinct confidences: a threshold can't split two picks with the same score.
    if (n >= MIN_SUPPORT && right / n >= PRECISION && (!next || next.confidence < p.confidence)) {
      threshold = p.confidence;
      precision = right / n;
    }
  }
  return { threshold, precision, picked: mine.length };
}

export function calibrationReport(db: Database): CalibrationReport {
  const rows = db
    .prepare(
      `SELECT c.name AS owner, d.question, d.answer, d.confidence FROM mail_messages m
       JOIN mail_categories c ON c.id = m.category_id
       JOIN decisions d ON d.subject_type = 'mail' AND d.subject_id = m.gmail_id
       WHERE m.source = 'owner' AND m.state = 'filed'`,
    )
    .all() as { owner: string; question: string; answer: string; confidence: number }[];
  const personal = (db.prepare(`SELECT name FROM mail_categories WHERE system = 'personal'`).pluck().get() as string) ?? 'Personal';
  const picks: Pick[] = rows.filter((r) => r.question === 'category').map((r) => ({ owner: r.owner, laya: r.answer, confidence: r.confidence }));
  // `answer` for the noul question is "true" when Laya leaned sensitive (≥ 0.5). Anything below counts as a miss,
  // which is stricter than the gate's own "not sensitive" band.
  const sensitiveMissed = rows.filter((r) => r.question === 'sensitive' && r.owner === personal && r.answer !== 'true').length;
  const categories = (db.prepare('SELECT id, name, system FROM mail_categories ORDER BY id').all() as { id: number; name: string; system: string | null }[])
    .filter((c) => c.system !== 'personal') // Personal is never auto-filed from a category pick: only the sensitive answer files it
    .map((c) => ({ id: c.id, name: c.name, ...thresholdFor(c.name, picks) }));
  const pair = new Set(['Blog ideas', 'Social ideas']);
  return {
    sorted: db.prepare(`SELECT count(*) FROM mail_messages WHERE source = 'owner'`).pluck().get() as number,
    sensitiveMissed,
    categories,
    blogSocialConfusion: picks.filter((p) => pair.has(p.owner) && pair.has(p.laya) && p.owner !== p.laya).length,
  };
}

/** Saves the thresholds the report allows. With any sensitive mail missed, nothing auto-files (R3's fallback applies). */
export function applyCalibration(db: Database, report: CalibrationReport): Record<number, number> {
  const thresholds: Record<number, number> =
    report.sensitiveMissed > 0 ? {} : Object.fromEntries(report.categories.filter((c) => c.threshold !== null).map((c) => [c.id, c.threshold!]));
  db.prepare(`INSERT INTO mail_settings (key, value) VALUES ('thresholds', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(thresholds));
  return thresholds;
}
