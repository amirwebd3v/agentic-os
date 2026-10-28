import { closeSync, constants, fstatSync, openSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'csv-parse/sync';
import { bulletIdBase, entryIdBase, idAllocator, parseMaster, serialiseMaster, slug } from './master.ts';
import type { Bullet, Entry, EntrySectionName, Section } from './master.ts';

/** Columns of LinkedIn's data export ("Get a copy of your data"), lower-cased. Others are reported, not guessed at. */
const KNOWN = {
  'Profile.csv': ['first name', 'last name', 'maiden name', 'address', 'birth date', 'headline', 'summary', 'industry', 'zip code', 'geo location', 'twitter handles', 'websites', 'instant messengers'],
  'Positions.csv': ['company name', 'title', 'description', 'location', 'started on', 'finished on'],
  'Education.csv': ['school name', 'start date', 'end date', 'notes', 'degree name', 'activities'],
  'Skills.csv': ['name'],
  'Languages.csv': ['name', 'proficiency'],
  'Certifications.csv': ['name', 'url', 'authority', 'started on', 'finished on', 'license number'],
} as const;
export type LinkedInFile = keyof typeof KNOWN;
export const LINKEDIN_FILES = Object.keys(KNOWN) as LinkedInFile[];
export const MAX_FILE_BYTES = 5 * 1024 * 1024;

type Row = Record<string, string | undefined>;

/**
 * Reads the recognised export files from `dir` (never a client path). Only plain files directly in `dir` count:
 * symlinks, junctions and folders are skipped, and `O_NOFOLLOW` (where the OS has it) closes the swap race.
 * Warnings name files and limits only.
 */
export function readExport(dir: string): { files: Partial<Record<LinkedInFile, string>>; warnings: string[] } {
  const files: Partial<Record<LinkedInFile, string>> = {};
  const warnings: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name);
  } catch {
    return { files, warnings }; // no import folder yet
  }
  for (const file of LINKEDIN_FILES) {
    const name = names.find((n) => n.toLowerCase() === file.toLowerCase());
    if (!name) continue;
    let fd: number;
    try {
      fd = openSync(join(dir, name), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch {
      warnings.push(`${file}: unreadable, ignored`);
      continue;
    }
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) continue;
      if (st.size > MAX_FILE_BYTES) warnings.push(`${file}: larger than 5 MB, ignored`);
      else files[file] = readFileSync(fd, 'utf8');
    } finally {
      closeSync(fd);
    }
  }
  return { files, warnings };
}

const clean = (s: string | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();
/** Entry header fields can't hold the `|` separator. */
const field = (s: string | undefined): string => clean(s).replaceAll('|', '/');

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
/** LinkedIn writes `Mar 2021` or `2021`; ISO dates are accepted too. Anything else is `null`. */
export function exportDate(s: string | undefined): string | null {
  const v = clean(s);
  let m = /^(\d{4})(?:-(\d{2}))?(?:-\d{2})?$/.exec(v);
  if (m) return m[2] && +m[2] >= 1 && +m[2] <= 12 ? `${m[1]}-${m[2]}` : m[1]!;
  m = /^([a-z]{3})[a-z]*\.? (\d{4})$/i.exec(v);
  const month = m ? MONTHS.indexOf(m[1]!.toLowerCase()) : -1;
  return month < 0 ? null : `${m![2]}-${String(month + 1).padStart(2, '0')}`;
}

/** One bullet per line or per bullet character; list markers at a line start are dropped. */
export const splitBullets = (text: string | undefined): string[] =>
  (text ?? '')
    .split(/\r?\n|\r|[•●▪◦·]/)
    .map((l) => clean(l.replace(/^\s*[-*–—]\s+/, '')))
    .filter(Boolean);

export interface ImportResult {
  master: string;
  contact: string;
  stats: { entries: number; bullets: number; skills: number };
  warnings: string[];
}

/**
 * Maps the export to `master.md` and `contact.md` text. `null` when neither `Profile.csv` nor `Positions.csv` has
 * anything to import. Warnings name files, columns and counts, never cell values.
 */
export function buildImport(files: Partial<Record<LinkedInFile, string>>, now = new Date()): ImportResult | null {
  const warnings: string[] = [];
  const rows = (file: LinkedInFile): Row[] => {
    const text = files[file];
    if (text === undefined) return [];
    let headers: string[] = [];
    let parsed: Row[];
    try {
      parsed = parse(text, {
        bom: true,
        columns: (h: string[]) => (headers = h.map((c) => c.trim().toLowerCase())),
        skip_empty_lines: true,
        relax_column_count: true,
      }) as Row[];
    } catch {
      warnings.push(`${file}: not a valid CSV, ignored`); // never the parser's message: it can quote a cell
      return [];
    }
    for (const h of headers) if (!(KNOWN[file] as readonly string[]).includes(h)) warnings.push(`${file}: unknown column "${h}" ignored`);
    return parsed;
  };

  const profile = rows('Profile.csv')[0];
  const positions = rows('Positions.csv');
  if (!profile && positions.length === 0) return null;

  const id = idAllocator();
  const bullets = (entryId: string, texts: string[]): Bullet[] => texts.map((text) => ({ id: id(bulletIdBase(entryId, text)), text }));
  let skipped = 0;
  const entries = (section: EntrySectionName, list: Row[], map: (r: Row) => Omit<Entry, 'id' | 'bullets'> & { texts: string[] } | null) =>
    list.flatMap((r) => {
      const e = map(r);
      if (!e) return (skipped++, []);
      const { texts, ...rest } = e;
      const entryId = id(entryIdBase(section, rest.org, rest.start));
      return [{ ...rest, id: entryId, bullets: bullets(entryId, texts) }];
    });
  // A row without a usable start date can't get an id (contract §3.1); you add it by hand.
  const dated = (r: Row, startCol: string, endCol: string) => {
    const start = exportDate(r[startCol]);
    return start ? { start, end: exportDate(r[endCol]) ?? 'present' } : null;
  };

  const summary = profile ? [clean(profile.headline), ...splitBullets(profile.summary)].filter(Boolean) : [];
  const skills = [...new Set(rows('Skills.csv').map((r) => clean(r.name)))].filter(Boolean);
  const all: Section[] = [
    { name: 'Summary', bullets: summary.map((text, i) => ({ id: id(`sum-${i + 1}`), text })) },
    {
      name: 'Experience',
      entries: entries('Experience', positions, (r) => {
        const d = dated(r, 'started on', 'finished on');
        return d && { org: field(r['company name']), title: field(r.title), location: field(r.location), ...d, texts: splitBullets(r.description) };
      }),
    },
    {
      name: 'Education',
      entries: entries('Education', rows('Education.csv'), (r) => {
        const d = dated(r, 'start date', 'end date');
        return d && { org: field(r['school name']), title: field(r['degree name']), location: '', ...d, texts: [...splitBullets(r.notes), ...splitBullets(r.activities)] };
      }),
    },
    {
      name: 'Certifications',
      entries: entries('Certifications', rows('Certifications.csv'), (r) => {
        const d = dated(r, 'started on', 'finished on');
        return d && { org: field(r.authority), title: field(r.name), location: '', ...d, texts: [] };
      }),
    },
    { name: 'Skills', bullets: skills.map((text) => ({ id: id(['skill', slug(text, 40)].filter(Boolean).join('-')), text })) },
    {
      name: 'Languages',
      bullets: rows('Languages.csv')
        .map((r) => [clean(r.name), clean(r.proficiency)] as const)
        .filter(([lang]) => lang)
        .map(([lang, level]) => ({ id: id(['lang', slug(lang, 40)].filter(Boolean).join('-')), text: level ? `${lang} (${level})` : lang })),
    },
  ];
  const sections = all.filter((s) => ('bullets' in s ? s.bullets : s.entries).length > 0);
  if (skipped) warnings.push(`${skipped} row(s) without a start date skipped; add them in Obsidian`);

  const stamp = now.toISOString();
  const fm = { area: 'career', tags: [], sensitivity: 2 as const, source: 'linkedin-import', created: stamp, updated: stamp };
  const master = serialiseMaster({ fm: { id: 'career-master', ...fm }, sections });
  parseMaster(master); // self-check: what goes into the queue is valid by construction

  // contact.md (§3.2): JSON strings are valid double-quoted YAML, and loadContact refuses unquoted numbers.
  const name = profile ? clean(`${clean(profile['first name'])} ${clean(profile['last name'])}`) : '';
  const contact = [
    '---',
    'id: career-contact',
    ...Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`),
    ...(['name', 'email', 'phone', 'address', 'url'] as const).map((k) => `${k}: ${JSON.stringify(k === 'name' ? name : '')}`),
    '---',
    '',
  ].join('\n');

  const jobs = sections.flatMap((s) => ('entries' in s ? s.entries : []));
  const stats = { entries: jobs.length, bullets: jobs.reduce((n, e) => n + e.bullets.length, summary.length), skills: skills.length };
  return { master, contact, stats, warnings };
}
