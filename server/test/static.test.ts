import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test, expect } from 'vitest';
import { HOST, buildTestApp } from './helpers.ts';

// Regression (found by W1-07): with web/dist present, @fastify/static's wildcard answered unknown /api/* with 404
// before the session check, leaking which API paths exist to unauthenticated callers.
function fakeDist(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aos-dist-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>AOS</title>');
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');
  return dir;
}

describe('serving the built web app', () => {
  test('unknown /api paths still need a session when web/dist exists', async () => {
    const { app } = await buildTestApp({ webDist: fakeDist() });
    expect((await app.inject({ url: '/api/nope', headers: { host: HOST } })).statusCode).toBe(401);
  });

  test('serves index.html, built assets, and the SPA shell for client-side routes', async () => {
    const { app } = await buildTestApp({ webDist: fakeDist() });
    const html = { host: HOST, accept: 'text/html' };
    expect((await app.inject({ url: '/', headers: html })).body).toContain('<title>AOS</title>');
    expect((await app.inject({ url: '/assets/app.js', headers: { host: HOST } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/sessions/5', headers: html })).body).toContain('<title>AOS</title>');
  });

  test('missing assets are 404, not the SPA shell', async () => {
    const { app } = await buildTestApp({ webDist: fakeDist() });
    expect((await app.inject({ url: '/assets/missing.js', headers: { host: HOST, accept: 'text/html' } })).statusCode).toBe(404);
  });
});
