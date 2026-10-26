import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { RequestListener, Server } from 'node:http';
import { afterEach, describe, expect, test } from 'vitest';
import fixture from './fixtures/systemone-response.json' with { type: 'json' };
import { createDecider } from '../src/decider/client.ts';
import type { Question } from '../src/decider/client.ts';
import { makeTestDb } from './helpers.ts';

const questions: Record<string, Question> = {
  area: { type: 'choice', instructions: 'Which life area?', criteria: { 'admin-finance': 'Bills', career: 'Jobs', health: 'Doctors' } },
  importance: { type: 'score', instructions: 'How important?', criteria: ['ignorable', 'low', 'normal', 'high', 'urgent'] },
  needs_action: { type: 'noul', instructions: 'Does the reader need to act?' },
};

let srv: Server | undefined;
afterEach(() => {
  srv?.close();
  srv = undefined;
});

async function fake(handler: RequestListener): Promise<string> {
  srv = createServer(handler);
  await new Promise<void>((r) => srv!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
}

const json = (body: unknown, status = 200): RequestListener => (_req, res) => {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
};

describe('decider client', () => {
  test('sends bearer key and model, parses the real Laya reply, logs one decisions row per question', async () => {
    let auth = '';
    let sent: { model?: string; questions?: object } = {};
    const baseURL = await fake((req, res) => {
      auth = req.headers.authorization ?? '';
      let body = '';
      req.on('data', (c) => (body += c)).on('end', () => {
        sent = JSON.parse(body);
        json(fixture)(req, res);
      });
    });
    const db = makeTestDb();
    const d = createDecider({ db, baseURL, apiKey: 'k', model: 'multilingual' });
    const out = await d.decide({ subject: 'Invoice' }, questions, { subject: { type: 'email', id: 'm1' } });

    expect(auth).toBe('Bearer k');
    expect(sent.model).toBe('multilingual');
    expect(Object.keys(sent.questions!)).toEqual(['area', 'importance', 'needs_action']);
    expect(out.answers.area).toMatchObject({ type: 'choice', choice: 'admin-finance' });
    expect(out.answers.needs_action!.confidence).toBeGreaterThanOrEqual(0);
    const rows = db.prepare('SELECT subject_type, subject_id, question, answer, backend, model FROM decisions ORDER BY id').all();
    expect(rows).toEqual([
      { subject_type: 'email', subject_id: 'm1', question: 'area', answer: 'admin-finance', backend: 'laya', model: 'multilingual' },
      { subject_type: 'email', subject_id: 'm1', question: 'importance', answer: '1.6727', backend: 'laya', model: 'multilingual' },
      { subject_type: 'email', subject_id: 'm1', question: 'needs_action', answer: 'true', backend: 'laya', model: 'multilingual' },
    ]);
  });

  test('down decider → typed decider_down, not a hang', async () => {
    const d = createDecider({ db: makeTestDb(), baseURL: 'http://127.0.0.1:1', apiKey: 'k', model: 'multilingual' });
    await expect(d.decide({}, questions)).rejects.toMatchObject({ kind: 'decider_down' });
    expect(await d.status()).toBe('down');
  });

  test('a stalled decider times out as decider_down', async () => {
    const baseURL = await fake(() => {}); // never answers
    const d = createDecider({ db: makeTestDb(), baseURL, apiKey: 'k', model: 'multilingual', timeoutMs: 50 });
    await expect(d.decide({}, questions)).rejects.toMatchObject({ kind: 'decider_down' });
  });

  test('401 and malformed replies are decider_error and log nothing', async () => {
    const db = makeTestDb();
    let baseURL = await fake(json({ detail: 'invalid or missing bearer token' }, 401));
    await expect(createDecider({ db, baseURL, apiKey: 'bad', model: 'm' }).decide({}, questions)).rejects.toMatchObject({ kind: 'decider_error' });
    srv!.close();
    baseURL = await fake(json({ answers: { area: fixture.answers.area } })); // skipped two questions
    await expect(createDecider({ db, baseURL, apiKey: 'k', model: 'm' }).decide({}, questions)).rejects.toMatchObject({ kind: 'decider_error' });
    expect(db.prepare('SELECT count(*) n FROM decisions').get()).toEqual({ n: 0 });
  });

  test('status() is ok only for an authorized health reply', async () => {
    const d = createDecider({ db: makeTestDb(), baseURL: await fake(json({ status: 'ok', loaded: ['multilingual'] })), apiKey: 'k', model: 'm' });
    expect(await d.status()).toBe('ok');
    srv!.close();
    // What Laya sends a caller whose key it rejected.
    const wrongKey = createDecider({ db: makeTestDb(), baseURL: await fake(json({ status: 'ok' })), apiKey: 'bad', model: 'm' });
    expect(await wrongKey.status()).toBe('down');
  });
});
