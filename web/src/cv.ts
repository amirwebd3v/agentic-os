// One CV shape for the master and every tailored draft (docs/week2/career-v2.md §1), and the helpers both editors use.
// All text in it is the owner's CV or model output: bound with v-model and rendered with {{ }} only.

export const SECTION_ORDER = ['Summary', 'Experience', 'Education', 'Projects', 'Certifications', 'Skills', 'Languages'] as const;
export type SectionName = (typeof SECTION_ORDER)[number];
export type BulletSectionName = 'Summary' | 'Skills' | 'Languages';
export type EntrySectionName = Exclude<SectionName, BulletSectionName>;
const ENTRY_SECTIONS: readonly SectionName[] = ['Experience', 'Education', 'Projects', 'Certifications'];

/** `origin` and `cites` exist on draft lines; `new` / `from` mark what an imported Word CV would add to the master. */
export type CvLine = { id?: string; text: string; cites?: string[]; origin?: 'model' | 'owner' | 'suggestion'; new?: true; from?: string };
export type CvEntry = {
  id?: string; source?: string; org: string; title: string; start: string; end: string; location: string; bullets: CvLine[]; new?: true; from?: string;
};
export type CvSection = { name: BulletSectionName; bullets: CvLine[] } | { name: EntrySectionName; entries: CvEntry[] };

export const isEntries = (s: CvSection): s is Extract<CvSection, { entries: CvEntry[] }> => 'entries' in s;
export const blankEntry = (): CvEntry => ({ org: '', title: '', start: '', end: 'present', location: '', bullets: [{ text: '' }] });
export const blankSection = (name: SectionName): CvSection =>
  ENTRY_SECTIONS.includes(name) ? { name: name as EntrySectionName, entries: [blankEntry()] } : { name: name as BulletSectionName, bullets: [{ text: '' }] };

const DATE = /^\d{4}(-(0[1-9]|1[0-2]))?$/;
export const badStart = (e: CvEntry) => !DATE.test(e.start.trim());
export const badEnd = (e: CvEntry) => e.end.trim() !== 'present' && !DATE.test(e.end.trim());

/** Entries that can't be saved: a title or lines but no name, or a date outside `2021` / `2021-03` / `present`. */
export const problems = (sections: CvSection[]): string[] =>
  sections.flatMap((s) =>
    isEntries(s)
      ? s.entries.flatMap((e) => ((e.org || e.title) && (badStart(e) || badEnd(e) || !e.org.trim()) ? [`${s.name}: ${e.org || e.title}`] : []))
      : [],
  );

/** As saved: text trimmed, empty lines, entries and sections dropped, the import marks (`new`, `from`) stripped. */
export function cleaned<T extends CvSection>(sections: T[]): T[] {
  const line = ({ new: _n, from: _f, ...l }: CvLine) => ({ ...l, text: l.text.trim() });
  const lines = (list: CvLine[]) => list.map(line).filter((l) => l.text);
  return sections
    .map((s) => {
      if (!isEntries(s)) return { ...s, bullets: lines(s.bullets) };
      const entries = s.entries
        .map(({ new: _n, from: _f, ...e }) => ({
          ...e, org: e.org.trim(), title: e.title.trim(), start: e.start.trim(), end: e.end.trim(), location: e.location.trim(), bullets: lines(e.bullets),
        }))
        .filter((e) => e.org || e.title || e.bullets.length);
      return { ...s, entries };
    })
    .filter((s) => (isEntries(s) ? s.entries.length : s.bullets.length)) as T[];
}

/** Lines in reading order, for keyboard moves and counts. */
export const allLines = (sections: CvSection[]): CvLine[] => sections.flatMap((s) => (isEntries(s) ? s.entries.flatMap((e) => e.bullets) : s.bullets));
