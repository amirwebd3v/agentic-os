import { getMaster, saveMaster, type MasterSection } from './api';

/** Where a confirmed line can go in the master CV: a bullet section, or an entry by id. */
export type MasterTarget = { section: 'Summary' | 'Skills' | 'Languages' } | { entry: string };

/**
 * Adds one line the owner confirmed as true to `career/master.md` (the owner's own write, through the master's PUT,
 * so a concurrent Obsidian edit is refused, not overwritten). Returns false when the target no longer exists.
 */
export async function addToMaster(target: MasterTarget, text: string): Promise<boolean> {
  const m = await getMaster();
  if (!m.exists || !('sections' in m)) return false;
  const sections: MasterSection[] = JSON.parse(JSON.stringify(m.sections));
  if ('entry' in target) {
    const entry = sections.flatMap((s) => ('entries' in s ? s.entries : [])).find((e) => e.id === target.entry);
    if (!entry) return false;
    entry.bullets.push({ text });
  } else {
    const s = sections.find((x) => x.name === target.section);
    if (s && 'bullets' in s) s.bullets.push({ text });
    else sections.push({ name: target.section, bullets: [{ text }] });
  }
  await saveMaster(m.hash, sections);
  return true;
}
