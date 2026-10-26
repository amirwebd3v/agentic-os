import matter from 'gray-matter';
import { z } from 'zod';

// YAML turns an unquoted 2026-10-26 into a Date; normalise either form to an ISO string.
const isoDate = z.preprocess((v) => (v instanceof Date ? v.toISOString() : v), z.iso.datetime().or(z.iso.date()));

const FrontmatterSchema = z.object({
  id: z.string().min(1),
  area: z.string().min(1),
  tags: z.array(z.string()).default([]),
  sensitivity: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  source: z.string().min(1),
  created: isoDate,
  updated: isoDate,
});

export type Frontmatter = z.infer<typeof FrontmatterSchema>;

/** Splits a note into validated frontmatter and body. Throws if the frontmatter is missing or invalid. */
export function parseNote(text: string): { fm: Frontmatter; body: string } {
  const file = matter(text, {}); // options object bypasses gray-matter's global content cache
  return { fm: FrontmatterSchema.parse(file.data), body: file.content };
}

export function stringifyNote(body: string, fm: Frontmatter): string {
  return matter.stringify(body, FrontmatterSchema.parse(fm));
}
