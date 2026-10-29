const TAG = /^[a-z][a-z_]*$/;

/** Removes every `<tag>` / `</tag>` from untrusted text, so it can't close the block that wraps it. */
export function defuse(tag: string, text: string): string {
  if (!TAG.test(tag)) throw new Error('invalid tag name'); // tags are constants in code, never data
  return text.replace(new RegExp(`<\\s*/?\\s*${tag}\\b[^>]*(?:>|$)`, 'gi'), '');
}

/** Every block tag a prompt uses. A block's text loses all of them, so it can't close its block or fake another one. */
const WRAPPER_TAGS = [
  'posting', 'cv', 'master', 'requirements', 'selection', 'previous_draft', 'violations',
  'research', 'context', 'company', 'vacancy', 'evidence', 'answers', 'previous_letter',
];

/** `<tag>…</tag>` around untrusted text. The system prompt must also say the block is data, not instructions. */
export function wrapUntrusted(tag: string, text: string): string {
  if (!WRAPPER_TAGS.includes(tag)) throw new Error('unregistered wrapper tag'); // add it to WRAPPER_TAGS
  return `<${tag}>\n${WRAPPER_TAGS.reduce((t, w) => defuse(w, t), text)}\n</${tag}>`;
}
