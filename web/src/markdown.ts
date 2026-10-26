import { Marked, type Tokens } from 'marked';
import DOMPurify from 'dompurify';

// Model replies are untrusted. Anything that makes the browser fetch a URL (img, link, style, iframe, form...)
// would let a prompt-injected reply leak data, so this file is the exfiltration defence. CSP backs it up.

/** Inline raster images only. SVG is left out on purpose, and nothing remote ever loads. */
const SAFE_IMG = /^data:image\/(?:png|jpe?g|gif|webp|avif);base64,[a-z0-9+/=\s]*$/i;

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const marked = new Marked({
  async: false,
  gfm: true,
  renderer: {
    // A link becomes inert text that shows where it points; it is never clickable.
    link({ href, tokens }: Tokens.Link) {
      const text = this.parser.parseInline(tokens);
      return `<span class="link" title="${esc(href)}">${text} (${esc(href)})</span>`;
    },
    image({ href, text }: Tokens.Image) {
      if (SAFE_IMG.test(href)) return `<img src="${esc(href)}" alt="${esc(text)}">`;
      return text ? `[image blocked: ${esc(text)}]` : '[image blocked]';
    },
  },
});

// Own instance, so these hooks never leak into another DOMPurify user. Allowlists, not denylists:
// no a, no style, no id/name (DOM clobbering), no data-*, no srcset/background/poster/action.
const purify = DOMPurify(window);
const PURIFY_CONFIG = {
  ALLOWED_TAGS: [
    'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'b', 'i', 'del', 's', 'sub', 'sup',
    'kbd', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'span', 'img',
  ],
  ALLOWED_ATTR: ['src', 'alt', 'title', 'class', 'align', 'start'],
  FORBID_TAGS: ['style', 'iframe', 'form', 'svg', 'math'],
  FORBID_ATTR: ['style'],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
};
// Raw HTML in a reply skips the marked renderer above, so <img> is checked again here. The hooks run inside
// DOMPurify's inert document, where nothing loads.
purify.addHook('uponSanitizeAttribute', (node, data) => {
  if (data.attrName === 'src' && !(node.nodeName === 'IMG' && SAFE_IMG.test(data.attrValue))) data.keepAttr = false;
});
purify.addHook('afterSanitizeAttributes', (node) => {
  if (node.nodeName === 'IMG' && !node.hasAttribute('src')) node.remove();
});

/** The only way model output becomes HTML. Its result is the only thing ever passed to v-html. */
export function renderMarkdown(src: string): string {
  return purify.sanitize(marked.parse(src) as string, PURIFY_CONFIG);
}
