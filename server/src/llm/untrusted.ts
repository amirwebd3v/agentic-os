const TAG = /^[a-z][a-z_]*$/;

/** Removes every `<tag>` / `</tag>` from untrusted text, so it can't close the block that wraps it. */
export function defuse(tag: string, text: string): string {
  if (!TAG.test(tag)) throw new Error('invalid tag name'); // tags are constants in code, never data
  return text.replace(new RegExp(`<\\s*/?\\s*${tag}\\b[^>]*(?:>|$)`, 'gi'), '');
}

/** `<tag>…</tag>` around untrusted text. The system prompt must also say the block is data, not instructions. */
export const wrapUntrusted = (tag: string, text: string): string => `<${tag}>\n${defuse(tag, text)}\n</${tag}>`;
