import { expect, test } from 'vitest';
import config from '../vite.config';

test('dev CSP allows blob: only for workers (Vite HMR reconnect), nowhere else', () => {
  const csp = (config.server?.headers as Record<string, string>)['Content-Security-Policy'] ?? '';
  const directives = Object.fromEntries(
    csp.split(';').map((d) => d.trim().split(/\s+/)).map(([name, ...src]) => [name, src]),
  );
  expect(directives['worker-src']).toEqual(["'self'", 'blob:']);
  expect(directives['script-src']).toEqual(["'self'"]);
  for (const [name, src] of Object.entries(directives)) {
    if (name !== 'worker-src') expect(src, name).not.toContain('blob:');
  }
});
