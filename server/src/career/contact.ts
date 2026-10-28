import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';

export const CONTACT_FIELDS = ['name', 'email', 'phone', 'address', 'url', 'dob'] as const;
export type ContactField = (typeof CONTACT_FIELDS)[number];
/** `career/contact.md` frontmatter (contract §3.2). Absent or empty fields are left out. */
export type Contact = Partial<Record<ContactField, string>>;

/** Fixed messages only: a YAML error quotes the file, i.e. contact values. */
export class ContactError extends Error {}

/** Reads `career/contact.md`. Only redaction (`redact.ts`) and render may call this. A missing file gives `{}`. */
export function loadContact(vaultDir: string): Contact {
  let data: Record<string, unknown>;
  try {
    data = matter(readFileSync(join(vaultDir, 'career', 'contact.md'), 'utf8'), {}).data; // `{}` bypasses gray-matter's cache
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new ContactError('career/contact.md is unreadable or has invalid frontmatter');
  }
  const contact: Contact = {};
  for (const field of CONTACT_FIELDS) {
    let v = data[field];
    if (v == null) continue;
    if (field === 'dob' && v instanceof Date) v = v.toISOString().slice(0, 10); // YAML turns an unquoted date into a Date
    // An unquoted phone becomes a number (leading zeros lost, `0170…` even read as octal), which would then never match.
    if (typeof v !== 'string') throw new ContactError(`career/contact.md: "${field}" must be a quoted string`);
    if (v.trim()) contact[field] = v.trim();
  }
  return contact;
}
