import { z } from 'zod';
import { BULLET_SECTIONS, ENTRY_SECTIONS } from './master.ts';
import type { Entry, EntrySectionName, Master } from './master.ts';
import type { DraftV1 } from './tailor.ts';

/** Draft v2 (career-v2.md §1): one CV document shape for the master and every tailored CV. */
export const ORIGINS = ['model', 'owner', 'suggestion'] as const;
export const SECTION_ORDER = ['Summary', 'Experience', 'Education', 'Projects', 'Certifications', 'Skills', 'Languages'] as const;
const ENTRY_NAMES = Object.keys(ENTRY_SECTIONS) as [EntrySectionName, ...EntrySectionName[]];

export const CvLine = z
  .object({
    id: z.string(),
    text: z.string(),
    cites: z.array(z.string()),
    origin: z.enum(ORIGINS),
    suggestion_id: z.string().optional(), // `s-<n>` of the gap suggestion an `origin: 'suggestion'` line came from (§3)
  })
  .strict();
export const CvEntry = z
  .object({
    id: z.string(),
    source: z.string().optional(), // the master entry id; none for the owner's own entry
    org: z.string(),
    title: z.string(),
    start: z.string(),
    end: z.string(),
    location: z.string(),
    bullets: z.array(CvLine),
  })
  .strict();
export const CvSection = z.union([
  z.object({ name: z.enum(BULLET_SECTIONS), bullets: z.array(CvLine) }).strict(),
  z.object({ name: z.enum(ENTRY_NAMES), entries: z.array(CvEntry) }).strict(),
]);
export const CvDoc = z.object({ sections: z.array(CvSection) }).strict();
export const Draft = z
  .object({ v: z.literal(2), cv: CvDoc, letter: z.object({ paragraphs: z.array(CvLine) }).strict(), versions: z.number().int().positive() })
  .strict();
export type CvLine = z.infer<typeof CvLine>;
export type CvEntry = z.infer<typeof CvEntry>;
export type CvSection = z.infer<typeof CvSection>;
export type CvDoc = z.infer<typeof CvDoc>;
export type Draft = z.infer<typeof Draft>;
export type Origin = (typeof ORIGINS)[number];

const HEADER_FIELDS = ['org', 'title', 'start', 'end', 'location'] as const;
const items = (line: string) => line.split(',').map((s) => s.trim()).filter(Boolean);

/**
 * A stored draft as v2. A v1 draft is converted (removed items dropped, the user's header, skills and languages
 * edits kept, master section order with master header values); a v2 one is returned as is. Ids are `l-<n>` / `e-<n>`
 * in document order. `fromModel`: every line is `model` (the model's own output); otherwise a v1 line with no cites
 * was the user's (`owner`). `master` null (missing): headers come from the user's edits only, skills from ids are lost.
 */
export function toDraftV2(d: DraftV1 | Draft, master: Pick<Master, 'sections'> | null, fromModel = false): Draft {
  if ('v' in d && d.v === 2) return d;
  const v1 = d as DraftV1;
  let n = 0;
  let e = 0;
  const line = (text: string, cites: string[]): CvLine => ({ id: `l-${++n}`, text, cites, origin: fromModel || cites.length ? 'model' : 'owner' });
  const live = <T extends { removed?: true | undefined }>(xs: T[]) => xs.filter((x) => !x.removed);
  const mSections = master?.sections ?? [];
  const where = new Map<string, { section: string; entry: Entry }>();
  for (const s of mSections) if ('entries' in s) for (const entry of s.entries) where.set(entry.id, { section: s.name, entry });
  const bulletsOf = (name: string) => mSections.flatMap((s) => (s.name === name && 'bullets' in s ? s.bullets : []));
  const skills = new Map(bulletsOf('Skills').map((b) => [b.id, b.text]));

  const sections: CvSection[] = [];
  for (const name of new Set<string>([...mSections.map((s) => s.name), ...SECTION_ORDER])) {
    let bullets: CvLine[] | undefined;
    if (name === 'Summary') bullets = v1.summary && !v1.summary.removed ? [line(v1.summary.text, v1.summary.cites)] : [];
    else if (name === 'Skills')
      // An unknown skill id has no text to show: it is dropped (the model never writes a skill's text).
      bullets = v1.skills_text !== undefined ? items(v1.skills_text).map((t) => line(t, [])) : v1.skill_ids.flatMap((id) => (skills.has(id) ? [line(skills.get(id)!, [id])] : []));
    else if (name === 'Languages')
      bullets = v1.languages_text !== undefined ? items(v1.languages_text).map((t) => line(t, [])) : bulletsOf('Languages').map((b) => line(b.text, [b.id]));
    if (bullets) {
      if (bullets.length) sections.push({ name: name as (typeof BULLET_SECTIONS)[number], bullets });
      continue;
    }
    // An entry the master no longer has keeps its place under Experience, with the user's header edits only.
    const entries = live(v1.entries)
      .filter((x) => (where.get(x.entry_id)?.section ?? 'Experience') === name)
      .map((x): CvEntry => {
        const m = where.get(x.entry_id)?.entry;
        const h = Object.fromEntries(HEADER_FIELDS.map((f) => [f, x.header?.[f] ?? m?.[f] ?? ''])) as Record<(typeof HEADER_FIELDS)[number], string>;
        return { id: `e-${++e}`, source: x.entry_id, ...h, bullets: live(x.bullets).map((b) => line(b.text, b.cites)) };
      });
    if (entries.length) sections.push({ name: name as EntrySectionName, entries });
  }
  return { v: 2, cv: { sections }, letter: { paragraphs: live(v1.letter.paragraphs).map((p) => line(p.text, p.cites)) }, versions: v1.versions };
}

/** Every line of a draft (CV in section order, then the letter), with the entry it sits under. */
export function* draftLines(d: Draft): Generator<{ line: CvLine; section: string; entry?: CvEntry }> {
  for (const s of d.cv.sections) {
    if ('bullets' in s) for (const line of s.bullets) yield { line, section: s.name };
    else for (const entry of s.entries) for (const line of entry.bullets) yield { line, section: s.name, entry };
  }
  for (const line of d.letter.paragraphs) yield { line, section: 'letter' };
}
