import { parseNote, stringifyNote } from '../vault/frontmatter.ts';
import type { Frontmatter } from '../vault/frontmatter.ts';
import { sha256 } from '../vault/writer.ts';

/** `career/master.md` (contract §3.1): standard frontmatter and a strict body grammar. */
export const ENTRY_SECTIONS = { Experience: 'exp', Education: 'edu', Projects: 'prj', Certifications: 'crt' } as const;
export const BULLET_SECTIONS = ['Summary', 'Skills', 'Languages'] as const;
export type EntrySectionName = keyof typeof ENTRY_SECTIONS;
export type BulletSectionName = (typeof BULLET_SECTIONS)[number];

export interface Bullet {
  id: string;
  text: string;
}
export interface Entry {
  id: string;
  org: string;
  title: string;
  start: string; // YYYY or YYYY-MM
  end: string; // YYYY, YYYY-MM or 'present'
  location: string;
  bullets: Bullet[];
}
export type Section = { name: BulletSectionName; bullets: Bullet[] } | { name: EntrySectionName; entries: Entry[] };
export interface Master {
  fm: Frontmatter;
  sections: Section[];
}

/** Fixed messages with line numbers only: never the line itself, which is CV text. */
export class MasterError extends Error {}

export const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE_RE = /^\d{4}(?:-(?:0[1-9]|1[0-2]))?$/;
const BULLET_RE = /^- (.+?) {2}\^(\S+)\s*$/;
const ENTRY_RE = /^### (.+?) {2}\^(\S+)\s*$/;
const SECTION_RE = /^## (.+)$/;

const isEntrySection = (name: string): name is EntrySectionName => Object.hasOwn(ENTRY_SECTIONS, name);
const isBulletSection = (name: string): name is BulletSectionName => (BULLET_SECTIONS as readonly string[]).includes(name);

/** Lower-case a-z0-9 words joined by `-`, at most `max` characters. */
export const slug = (text: string, max: number): string =>
  text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, max)
    .replace(/^-+|-+$/g, '');

/** Hands out ids unique within one file: a clash gets `-2`, `-3`, … */
export function idAllocator(): (base: string) => string {
  const taken = new Set<string>();
  return (base) => {
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    taken.add(id);
    return id;
  };
}

/** Entry id base: section prefix + slug(org, ≤ 20) + start year. */
export const entryIdBase = (section: EntrySectionName, org: string, start: string): string =>
  [ENTRY_SECTIONS[section], slug(org, 20), start.slice(0, 4)].filter(Boolean).join('-');

/** Bullet id base: entry id + first 6 hex of sha256(lower-cased trimmed text), the entry part cut so the whole stays ≤ 64. */
export const bulletIdBase = (entryId: string, text: string): string =>
  `${entryId.slice(0, 57).replace(/-+$/, '')}-${sha256(text.trim().toLowerCase()).slice(0, 6)}`;

/** Parses `master.md`. Throws `MasterError` on anything outside the grammar. */
export function parseMaster(text: string): Master {
  let parsed: ReturnType<typeof parseNote>;
  try {
    parsed = parseNote(text);
  } catch {
    throw new MasterError('master.md: missing or invalid frontmatter'); // never wrap: a YAML/Zod message can quote the file
  }
  const sections: Section[] = [];
  const ids = new Set<string>();
  const seen = new Set<string>();
  let section: Section | undefined;
  let entry: Entry | undefined;

  const checkId = (id: string, n: number): string => {
    if (!ID_RE.test(id) || id.length > 64) throw new MasterError(`master.md line ${n}: invalid id`);
    if (ids.has(id)) throw new MasterError(`master.md line ${n}: duplicate id`);
    ids.add(id);
    return id;
  };

  const lines = parsed.body.split(/\r?\n/);
  const offset = text.split(/\r?\n/).length - lines.length; // report file line numbers, as Obsidian shows them
  lines.forEach((line, i) => {
    const n = offset + i + 1;
    if (!line.trim()) return;
    const head = SECTION_RE.exec(line);
    if (head) {
      const name = head[1]!.trim();
      if (seen.has(name)) throw new MasterError(`master.md line ${n}: section repeated`);
      seen.add(name);
      if (isEntrySection(name)) section = { name, entries: [] };
      else if (isBulletSection(name)) section = { name, bullets: [] };
      else throw new MasterError(`master.md line ${n}: unknown section`);
      sections.push(section);
      entry = undefined;
      return;
    }
    const e = ENTRY_RE.exec(line);
    if (e) {
      if (!section || !('entries' in section)) throw new MasterError(`master.md line ${n}: entry outside an entry section`);
      const fields = e[1]!.split('|').map((f) => f.trim());
      if (fields.length !== 5) throw new MasterError(`master.md line ${n}: an entry needs 5 fields`);
      const [org, title, start, end, location] = fields as [string, string, string, string, string];
      if (!DATE_RE.test(start) || (end !== 'present' && !DATE_RE.test(end))) throw new MasterError(`master.md line ${n}: invalid date`);
      entry = { id: checkId(e[2]!, n), org, title, start, end, location, bullets: [] };
      section.entries.push(entry);
      return;
    }
    const b = BULLET_RE.exec(line);
    if (b && section) {
      const bullet = { id: checkId(b[2]!, n), text: b[1]!.trim() };
      if (!bullet.text) throw new MasterError(`master.md line ${n}: empty bullet`);
      if ('bullets' in section) section.bullets.push(bullet);
      else if (entry) entry.bullets.push(bullet);
      else throw new MasterError(`master.md line ${n}: bullet before the first entry`);
      return;
    }
    throw new MasterError(`master.md line ${n}: not part of the grammar`);
  });
  return { fm: parsed.fm, sections };
}

/** The canonical text of a master: `parseMaster(serialiseMaster(m))` gives `m` back. */
export function serialiseMaster({ fm, sections }: Master): string {
  const bullet = (b: Bullet) => `- ${b.text}  ^${b.id}`;
  const entry = (e: Entry) =>
    [`### ${[e.org, e.title, e.start, e.end, e.location].join(' | ')}  ^${e.id}`, ...e.bullets.map(bullet)].join('\n');
  const body = sections
    .map((s) => `## ${s.name}\n${'bullets' in s ? s.bullets.map(bullet).join('\n') : s.entries.map(entry).join('\n\n')}`)
    .join('\n\n');
  return stringifyNote(`${body}\n`, fm);
}

/** `null` when `text` is a valid master, else the (fixed, text-free) reason. */
export function validateMaster(text: string): string | null {
  try {
    parseMaster(text);
    return null;
  } catch (err) {
    if (err instanceof MasterError) return err.message;
    throw err;
  }
}

/** An entry before it has ids: `texts` become its bullets. */
export type EntryDraft = Omit<Entry, 'id' | 'bullets'> & { texts: string[] };
export interface MasterDraft {
  summary: string[];
  entries: Partial<Record<EntrySectionName, EntryDraft[]>>;
  skills: string[];
  /** Like `German (C1)`: the id comes from the part before ` (`. */
  languages: string[];
}

/** Fresh frontmatter for a new `master.md`. */
export const masterFm = (source: string, stamp: string): Frontmatter => ({
  id: 'career-master',
  area: 'career',
  tags: [],
  sensitivity: 2,
  source,
  created: stamp,
  updated: stamp,
});

/**
 * Gives a draft its ids (by code only: neither an export nor a model ever picks one), serialises it and checks the
 * result. Empty sections are left out; `null` when nothing is left.
 */
export function buildMaster(d: MasterDraft, source: string, now: Date) {
  const id = idAllocator();
  const named = (prefix: string, texts: string[], key = (t: string) => t) =>
    [...new Set(texts)].map((text) => ({ id: id([prefix, slug(key(text), 40)].filter(Boolean).join('-')), text }));
  const all: Section[] = [
    { name: 'Summary', bullets: d.summary.map((text, i) => ({ id: id(`sum-${i + 1}`), text })) },
    ...(Object.keys(ENTRY_SECTIONS) as EntrySectionName[]).map(
      (name): Section => ({
        name,
        entries: (d.entries[name] ?? []).map(({ texts, ...rest }) => {
          const entryId = id(entryIdBase(name, rest.org, rest.start));
          return { ...rest, id: entryId, bullets: texts.map((text) => ({ id: id(bulletIdBase(entryId, text)), text })) };
        }),
      }),
    ),
    { name: 'Skills', bullets: named('skill', d.skills) },
    { name: 'Languages', bullets: named('lang', d.languages, (t) => t.replace(/\s*\(.*$/, '')) },
  ];
  const sections = all.filter((s) => ('bullets' in s ? s.bullets : s.entries).length > 0);
  if (!sections.length) return null;
  const master = serialiseMaster({ fm: masterFm(source, now.toISOString()), sections });
  parseMaster(master); // self-check: what goes into the queue is valid by construction
  const jobs = sections.flatMap((s) => ('entries' in s ? s.entries : []));
  const stats = { entries: jobs.length, bullets: jobs.reduce((n, e) => n + e.bullets.length, d.summary.length), skills: new Set(d.skills).size };
  return { master, stats };
}

type BulletEdit = { id?: string; text: string };
/** A section as the owner edits it in the web app: an item without `id` is new. */
export interface SectionEdit {
  name: string;
  bullets?: BulletEdit[];
  entries?: (Omit<Entry, 'id' | 'bullets'> & { id?: string; bullets: BulletEdit[] })[];
}

/**
 * The owner's edit of the whole master. An id sent must be in `current` (an entry's for an entry, a bullet's for a
 * bullet) and is used once; it is kept. New items get ids by `buildMaster`'s rules, never one that stays. Empty
 * sections are dropped. Throws `MasterError` (fixed text) on anything the grammar can't hold.
 */
export function editSections(input: SectionEdit[], current: Section[]): Section[] {
  const entryIds = new Set(current.flatMap((s) => ('entries' in s ? s.entries.map((e) => e.id) : [])));
  const bulletIds = new Set(current.flatMap((s) => ('entries' in s ? s.entries.flatMap((e) => e.bullets) : s.bullets).map((b) => b.id)));
  const id = idAllocator();
  const keep = (sent: string | undefined, known: Set<string>) => {
    if (sent === undefined) return;
    if (!known.delete(sent)) throw new MasterError('master: unknown or repeated id'); // deleted: a second use is unknown
    id(sent); // taken before any new id is handed out
  };
  const seen = new Set<string>();
  for (const s of input) {
    if (seen.has(s.name)) throw new MasterError('master: section repeated');
    seen.add(s.name);
    const shapeOk = isEntrySection(s.name) ? s.entries && !s.bullets : isBulletSection(s.name) && s.bullets && !s.entries;
    if (!shapeOk) throw new MasterError('master: invalid section');
    for (const b of s.bullets ?? []) keep(b.id, bulletIds);
    for (const e of s.entries ?? []) {
      keep(e.id, entryIds);
      for (const b of e.bullets) keep(b.id, bulletIds);
    }
  }
  // Trimmed as the parser trims; `  ^` would read as an id, `|` in a header as a field break.
  const clean = (t: string, header = false) => {
    const v = t.trim();
    if (/ {2}\^/.test(v) || (header && v.includes('|'))) throw new MasterError('master: text breaks the grammar');
    return v;
  };
  const bullet = (b: BulletEdit, i: number, base: (text: string, i: number) => string): Bullet => {
    const text = clean(b.text);
    if (!text) throw new MasterError('master: empty bullet');
    return { id: b.id ?? id(base(text, i)), text };
  };
  const named = (prefix: string, text: string) => [prefix, slug(text, 40)].filter(Boolean).join('-');
  const bases: Record<BulletSectionName, (text: string, i: number) => string> = {
    Summary: (_, i) => `sum-${i + 1}`,
    Skills: (t) => named('skill', t),
    Languages: (t) => named('lang', t.replace(/\s*\(.*$/, '')),
  };
  const sections = input.map((s): Section => {
    if (!isEntrySection(s.name)) {
      const name = s.name as BulletSectionName;
      return { name, bullets: s.bullets!.map((b, i) => bullet(b, i, bases[name])) };
    }
    const name = s.name;
    const entries = s.entries!.map((e) => {
      const [org, title, location] = [e.org, e.title, e.location].map((f) => clean(f, true)) as [string, string, string];
      const entryId = e.id ?? id(entryIdBase(name, org, e.start));
      return { id: entryId, org, title, start: e.start, end: e.end, location, bullets: e.bullets.map((b, i) => bullet(b, i, (t) => bulletIdBase(entryId, t))) };
    });
    return { name, entries };
  });
  return sections.filter((s) => ('bullets' in s ? s.bullets : s.entries).length > 0);
}
