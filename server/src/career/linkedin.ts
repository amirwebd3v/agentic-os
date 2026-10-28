import { closeSync, constants, fstatSync, openSync, readdirSync, readFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { extname, join } from 'node:path';
import { parse } from 'csv-parse/sync';
import { contactNote } from './contact.ts';
import { buildMaster } from './master.ts';
import type { EntryDraft } from './master.ts';

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
/** CV documents the import reads when there is no LinkedIn CSV. */
export const DOCUMENT_EXTS = ['.md', '.pdf', '.docx'];
const MAX_DEPTH = 2;

type Row = Record<string, string | undefined>;

/**
 * `abs` as a plain file of at most 5 MB, opened with `O_NOFOLLOW` (where the OS has it) so a swapped-in symlink
 * isn't followed; `read: false` only stats it. `undefined` (with a warning naming `label`) otherwise.
 */
function plainFile(abs: string, label: string, warnings: string[], read = true): { mtimeMs: number; data?: Buffer } | undefined {
  let fd: number;
  try {
    fd = openSync(abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    warnings.push(`${label}: unreadable, ignored`);
    return undefined;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return undefined;
    if (st.size > MAX_FILE_BYTES) {
      warnings.push(`${label}: larger than 5 MB, ignored`);
      return undefined;
    }
    return { mtimeMs: st.mtimeMs, ...(read ? { data: readFileSync(fd) } : {}) };
  } finally {
    closeSync(fd);
  }
}

export interface ExportFiles {
  files: Partial<Record<LinkedInFile, string>>;
  /** Only when no LinkedIn CSV was found: the most recently modified `.md`/`.pdf`/`.docx`. `name` is relative to `dir`. */
  document?: { name: string; data: Buffer };
  warnings: string[];
}

/**
 * Reads the import folder `dir` (never a client path) and its subfolders up to two levels down, e.g. an extracted
 * `Basic_LinkedInDataExport_…/`. Only plain files count: symlinks and junctions are skipped, never followed, and a
 * known CSV name matches by basename, case-insensitive (the shallowest, then alphabetically first, wins).
 * Warnings name files and limits only.
 */
export function readExport(dir: string): ExportFiles {
  const files: Partial<Record<LinkedInFile, string>> = {};
  const warnings: string[] = [];
  const csvs = new Map<LinkedInFile, string>();
  const docs: string[] = [];
  // ponytail: a subfolder swapped for a link between readdir calls would be followed (O_NOFOLLOW guards the last
  // step only); the folder is the owner's own. Open each level with O_DIRECTORY|O_NOFOLLOW if that ever matters.
  const walk = (rel: string, depth: number) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(join(dir, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    } catch {
      return; // no import folder yet, or a folder gone meanwhile
    }
    for (const d of entries.filter((e) => e.isFile())) {
      const name = rel ? `${rel}/${d.name}` : d.name;
      const lower = d.name.toLowerCase();
      const csv = LINKEDIN_FILES.find((f) => f.toLowerCase() === lower);
      if (csv) {
        if (csvs.has(csv)) warnings.push(`${name}: another ${csv} is used, ignored`);
        else csvs.set(csv, name);
      } else if (extname(lower) === '.zip') warnings.push(`${name}: a .zip file; unzip it into this folder first`);
      else if (DOCUMENT_EXTS.includes(extname(lower))) docs.push(name);
    }
    if (depth < MAX_DEPTH) for (const d of entries.filter((e) => e.isDirectory())) walk(rel ? `${rel}/${d.name}` : d.name, depth + 1);
  };
  walk('', 0);

  for (const [file, name] of csvs) {
    const data = plainFile(join(dir, name), file, warnings)?.data;
    if (data) files[file] = data.toString('utf8');
  }
  if (Object.keys(files).length > 0 || docs.length === 0) return { files, warnings };

  const dated = docs.flatMap((name) => {
    const f = plainFile(join(dir, name), name, warnings, false);
    return f ? [{ name, mtimeMs: f.mtimeMs }] : [];
  });
  const [latest, ...rest] = dated.sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (!latest) return { files, warnings };
  if (rest.length) warnings.push(`using ${latest.name}, the newest; ignored ${rest.map((d) => d.name).join(', ')}`);
  const data = plainFile(join(dir, latest.name), latest.name, warnings)?.data;
  return data ? { files, document: { name: latest.name, data }, warnings } : { files, warnings };
}

export const clean = (s: string | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();
/** Entry header fields can't hold the `|` separator. */
export const field = (s: string | undefined): string => clean(s).replaceAll('|', '/');

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
  /** Absent for a document import: the owner's `contact.md` already exists and is not part of the proposal. */
  contact?: string;
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

  // A row without a usable start date can't get an id (contract §3.1); you add it by hand.
  let skipped = 0;
  const entries = (list: Row[], startCol: string, endCol: string, map: (r: Row) => Omit<EntryDraft, 'start' | 'end'>): EntryDraft[] =>
    list.flatMap((r) => {
      const start = exportDate(r[startCol]);
      if (!start) return (skipped++, []);
      return [{ ...map(r), start, end: exportDate(r[endCol]) ?? 'present' }];
    });

  const built = buildMaster(
    {
      summary: profile ? [clean(profile.headline), ...splitBullets(profile.summary)].filter(Boolean) : [],
      entries: {
        Experience: entries(positions, 'started on', 'finished on', (r) => ({
          org: field(r['company name']),
          title: field(r.title),
          location: field(r.location),
          texts: splitBullets(r.description),
        })),
        Education: entries(rows('Education.csv'), 'start date', 'end date', (r) => ({
          org: field(r['school name']),
          title: field(r['degree name']),
          location: '',
          texts: [...splitBullets(r.notes), ...splitBullets(r.activities)],
        })),
        Certifications: entries(rows('Certifications.csv'), 'started on', 'finished on', (r) => ({ org: field(r.authority), title: field(r.name), location: '', texts: [] })),
      },
      skills: rows('Skills.csv').map((r) => clean(r.name)).filter(Boolean),
      languages: rows('Languages.csv')
        .map((r) => [clean(r.name), clean(r.proficiency)] as const)
        .filter(([lang]) => lang)
        .map(([lang, level]) => (level ? `${lang} (${level})` : lang)),
    },
    'linkedin-import',
    now,
  );
  if (skipped) warnings.push(`${skipped} row(s) without a start date skipped; add them in Obsidian`);
  if (!built) return null;
  const name = profile ? clean(`${clean(profile['first name'])} ${clean(profile['last name'])}`) : '';
  return { ...built, contact: contactNote(name, 'linkedin-import', now), warnings };
}
