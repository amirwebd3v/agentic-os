import { closeSync, constants, fstatSync, openSync, readdirSync, readFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import { extname, join } from 'node:path';
import { parse } from 'csv-parse/sync';
import { contactNote } from './contact.ts';
import { buildMaster } from './master.ts';
import type { EntryDraft } from './master.ts';

/**
 * The columns `buildImport` reads from LinkedIn's data export ("Get a copy of your data"), lower-cased. Only the
 * optional fast path uses these names: a known CSV missing one of them goes to the model instead.
 */
const KNOWN = {
  'Profile.csv': ['first name', 'last name', 'headline', 'summary'],
  'Positions.csv': ['company name', 'title', 'description', 'location', 'started on', 'finished on'],
  'Education.csv': ['school name', 'start date', 'end date', 'notes', 'degree name', 'activities'],
  'Skills.csv': ['name'],
  'Languages.csv': ['name', 'proficiency'],
  'Certifications.csv': ['name', 'authority', 'started on', 'finished on'],
} as const;
/**
 * Private columns of the export (contact details, §3.2): never mapped, and dropped from any table before the model
 * sees it. Only ever removes data, so no export can fail on these names.
 */
export const PRIVATE_COLUMNS = ['maiden name', 'address', 'birth date', 'zip code', 'geo location', 'twitter handles', 'websites', 'instant messengers'];
/** Export columns left out on purpose: dropped without a warning. */
const IGNORED = [...PRIVATE_COLUMNS, 'industry', 'url', 'license number'];
export type LinkedInFile = keyof typeof KNOWN;
export const LINKEDIN_FILES = Object.keys(KNOWN) as LinkedInFile[];
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** Formats the import reads: documents (sent to the model first) and data files. Anything else gets a warning. */
const DOCUMENT_EXTS = ['.md', '.txt', '.pdf', '.docx'];
export const DATA_EXTS = ['.csv', '.tsv', '.json'];
const MAX_DEPTH = 3;
/**
 * ponytail: a basename heuristic for the parts of a LinkedIn export that aren't the owner's CV: other people's names
 * (connections, messages, contacts, endorsements…) and activity noise. Privacy rule: such a file is never even read,
 * so third-party names can't reach the model. Data files only, so a CV document named `machine-learning.pdf` is still
 * read; a false hit is a warning, never silent. Extend the list when an export grows a new file.
 */
const NOT_CV =
  /connection|message|invitation|contact|endorsement|recommendation|follow|reaction|comment|share|vote|search.?quer|login|registration|receipt|(?<![a-z])ads?(?![a-z])|ad.?targeting|inference|saved|event|learning|job.?application|email|phone|identity|verification|security/i;

type Row = Record<string, string | undefined>;

/**
 * `abs` as a plain file of at most 5 MB, opened with `O_NOFOLLOW` (where the OS has it) so a swapped-in symlink isn't
 * followed. `undefined` (with a warning naming `name`) otherwise.
 */
function plainFile(abs: string, name: string, warnings: string[]): Buffer | undefined {
  let fd: number;
  try {
    fd = openSync(abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    warnings.push(`${name}: skipped: unreadable`);
    return undefined;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) warnings.push(`${name}: skipped: not a plain file`);
    else if (st.size > MAX_FILE_BYTES) warnings.push(`${name}: skipped: larger than 5 MB`);
    else return readFileSync(fd);
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/** A file of the import folder. `name` is relative to it and never goes to the model (it can hold your name). */
export interface ImportFile {
  name: string;
  data: Buffer;
  /** Set on the first file (in scan order) with this LinkedIn name: the fast path's input. */
  known?: LinkedInFile;
}

export interface ExportFiles {
  /** Every readable file in a supported format that may be CV data, in scan order. */
  sources: ImportFile[];
  /** The `known` sources' text, for `buildImport`. */
  files: Partial<Record<LinkedInFile, string>>;
  warnings: string[];
}

/**
 * Reads the import folder `dir` (never a client path) and its subfolders up to three levels down, e.g. an extracted
 * `Basic_LinkedInDataExport_…/`. Only plain files count: symlinks and junctions are skipped, never followed. Every
 * file is either a source or named in a warning with the reason (file names and limits only, never content).
 */
export function readExport(dir: string): ExportFiles {
  const sources: ImportFile[] = [];
  const files: Partial<Record<LinkedInFile, string>> = {};
  const warnings: string[] = [];
  // ponytail: a subfolder swapped for a link between readdir calls would be followed (O_NOFOLLOW guards the last
  // step only); the folder is the owner's own. Open each level with O_DIRECTORY|O_NOFOLLOW if that ever matters.
  const walk = (rel: string, depth: number) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(join(dir, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
    } catch {
      return; // no import folder yet, or a folder gone meanwhile
    }
    for (const d of entries.filter((e) => !e.isDirectory())) {
      const name = rel ? `${rel}/${d.name}` : d.name;
      const ext = extname(d.name).toLowerCase();
      if (!d.isFile()) warnings.push(`${name}: skipped: not a plain file`); // a link or junction: never followed
      else if (ext === '.zip') warnings.push(`${name}: skipped: a .zip file; unzip it into this folder first`);
      else if (!DOCUMENT_EXTS.includes(ext) && !DATA_EXTS.includes(ext)) warnings.push(`${name}: skipped: unsupported format (${ext || 'no extension'})`);
      else if (DATA_EXTS.includes(ext) && NOT_CV.test(d.name)) warnings.push(`${name}: skipped: not CV data`);
      else {
        const data = plainFile(join(dir, name), name, warnings);
        if (!data) continue;
        const known = LINKEDIN_FILES.find((f) => f.toLowerCase() === d.name.toLowerCase() && !(f in files));
        if (known) files[known] = data.toString('utf8');
        sources.push({ name, data, ...(known ? { known } : {}) });
      }
    }
    for (const d of entries.filter((e) => e.isDirectory())) {
      const sub = rel ? `${rel}/${d.name}` : d.name;
      if (depth < MAX_DEPTH) walk(sub, depth + 1);
      else warnings.push(`${sub}/: skipped: more than ${MAX_DEPTH} folders deep`);
    }
  };
  walk('', 0);
  return { sources, files, warnings };
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
  /** The name in the export's `Profile.csv`, also in `contact`. */
  name?: string;
  stats: { entries: number; bullets: number; skills: number };
  warnings: string[];
}

/**
 * Maps the export to `master.md` and `contact.md` text. `null` when neither `Profile.csv` nor `Positions.csv` has
 * anything to import, or when a file lacks a column it reads (another export version or language: the model path
 * takes over). Warnings name files, columns and counts, never cell values.
 */
export function buildImport(files: Partial<Record<LinkedInFile, string>>, now = new Date()): ImportResult | null {
  const warnings: string[] = [];
  let mismatch = false;
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
    const known: readonly string[] = KNOWN[file];
    if (!known.every((c) => headers.includes(c))) mismatch = true;
    for (const h of headers) if (!known.includes(h) && !IGNORED.includes(h)) warnings.push(`${file}: unknown column "${h}" ignored`);
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
  if (!built || mismatch) return null;
  const name = profile ? clean(`${clean(profile['first name'])} ${clean(profile['last name'])}`) : '';
  return { ...built, contact: contactNote(name, 'linkedin-import', now), name, warnings };
}
