// `pnpm smoke`: checks what the configured provider really supports (plan-review.md §2b).
// Re-run whenever the provider or a model changes. Never prints the key.
import assert, { AssertionError } from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { loadConfig, repoRoot } from '../config.ts';
import { openDb } from '../db/index.ts';
import { getLlm, stream, structured } from '../llm/client.ts';
import { mapError } from '../llm/errors.ts';
import { getSecret } from '../secrets.ts';

type Result = 'pass' | 'fail' | 'skip';
const ICON: Record<Result, string> = { pass: '✅', fail: '❌', skip: '⏭' };
const CHECKS = ['plain', 'stream', 'tools', 'cache', 'batch', 'structured', 'effort', 'errors'] as const;
type Check = (typeof CHECKS)[number];

// Setup not finished yet is not a failure: skip everything and exit 0.
const missing = !getSecret('anthropic')
  ? 'No anthropic key (.env ANTHROPIC_API_KEY or `pnpm secrets set anthropic`)'
  : !existsSync(join(repoRoot, 'agentic-os.json'))
    ? 'No agentic-os.json (copy agentic-os.example.json)'
    : null;
if (missing) {
  console.log(`${missing}: skipping all checks.`);
  for (const name of CHECKS) console.log(`${ICON.skip} ${name}`);
  process.exit(0);
}

/** A capability the provider doesn't offer: recorded as a flag, not a failure. */
class Skip extends Error {}

const config = loadConfig();
const client = getLlm(config)!;
const deps = { db: openDb(':memory:'), config };
const { models } = config.llm;
const TIMEOUT = { timeout: 60_000, maxRetries: 1 };

const textOf = (m: Anthropic.Message) => m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');

const tools: Anthropic.Tool[] = [
  { name: 'get_weather', description: 'Current weather for a city', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } },
  { name: 'get_time', description: 'Current local time for a city', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } },
];

const checks: Record<Check, () => Promise<string | void>> = {
  async plain() {
    const m = await client.messages.create({ model: models.fast, max_tokens: 1024, messages: [{ role: 'user', content: 'Reply with the word: pong' }] }, TIMEOUT);
    assert(textOf(m).length > 0, 'empty text');
    assert(m.usage?.input_tokens > 0, 'no usage');
  },
  async stream() {
    let text = '';
    let usage: Anthropic.Usage | undefined;
    for await (const ev of stream(deps, { pipeline: 'smoke', tier: 'fast', messages: [{ role: 'user', content: 'Count from 1 to 5.' }] })) {
      if (ev.type === 'text') text += ev.text;
      else usage = ev.usage;
    }
    assert(text.length > 0, 'no text deltas');
    assert(usage && usage.output_tokens > 0, 'no final usage');
  },
  async tools() {
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: 'Call get_weather for Paris and get_time for Tokyo, both in parallel, then summarise.' }];
    const first = await client.messages.create({ model: models.work, max_tokens: 2048, tools, messages }, TIMEOUT);
    const uses = first.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    assert(uses.length > 0, `no tool_use (stop_reason ${first.stop_reason})`);
    messages.push(
      { role: 'assistant', content: first.content },
      { role: 'user', content: uses.map((u) => ({ type: 'tool_result' as const, tool_use_id: u.id, content: u.name === 'get_weather' ? '18°C, cloudy' : '21:04' })) },
    );
    const second = await client.messages.create({ model: models.work, max_tokens: 2048, tools, messages }, TIMEOUT);
    assert(textOf(second).length > 0, `no final text after tool_result (stop_reason ${second.stop_reason})`);
    return `${uses.length} tool call(s)${uses.length > 1 ? ', parallel' : ', not parallel'}`;
  },
  async cache() {
    const rules = Array.from({ length: 700 }, (_, i) => `Rule ${i}: keep answers short, cite the vault note, never invent facts.`).join('\n');
    const call = () =>
      client.messages.create(
        { model: models.work, max_tokens: 256, system: [{ type: 'text', text: rules, cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: 'Say ok.' }] },
        TIMEOUT,
      );
    await call();
    const { usage } = await call();
    assert((usage.cache_read_input_tokens ?? 0) > 0, `cache_read_input_tokens = ${usage.cache_read_input_tokens ?? 'absent'}`);
    return `${usage.cache_read_input_tokens} tokens read from cache`;
  },
  async batch() {
    // ponytail: GET /v1/messages/batches proves the endpoint without creating a batch; create one when a nightly job needs it.
    await client.messages.batches.list({ limit: 1 }, TIMEOUT).catch((err: unknown) => {
      throw mapError(err).status === 404 ? new Skip('endpoint absent (404)') : err;
    });
  },
  async structured() {
    const out = await structured(deps, {
      pipeline: 'smoke', tier: 'work', input: 'Extract: Jane Doe, jane@example.com, wants a demo.',
      schema: z.object({ name: z.string(), email: z.string(), demo: z.boolean() }),
    });
    assert(out.name.includes('Jane'), `unexpected output ${JSON.stringify(out)}`);
    const Contact = z.object({ name: z.string(), email: z.string() }).strict();
    const strictTool: Anthropic.Tool = {
      name: 'save_contact', description: 'Save a contact', strict: true,
      input_schema: { type: 'object', properties: { name: { type: 'string' }, email: { type: 'string' } }, required: ['name', 'email'], additionalProperties: false },
    };
    const m = await client.messages.create(
      { model: models.work, max_tokens: 2048, tools: [strictTool], messages: [{ role: 'user', content: 'Use the save_contact tool to save Jane Doe, jane@example.com.' }] },
      TIMEOUT,
    );
    const use = m.content.find((b) => b.type === 'tool_use');
    assert(use && Contact.safeParse(use.input).success, `strict tool input invalid: ${JSON.stringify(use?.input)}`);
  },
  async effort() {
    // Plan R2: does the provider pass `output_config.effort` through? `work` tier, since Haiku 4.5 rejects effort.
    const out = await structured(deps, { pipeline: 'smoke', tier: 'work', effort: 'low', input: 'Extract: Jane Doe wants a demo.', schema: z.object({ name: z.string() }) });
    assert(out.name.includes('Jane'), `unexpected output ${JSON.stringify(out)}`);
    return `accepted by ${models.work}`;
  },
  async errors() {
    const kinds = [];
    for (const req of [
      () => client.messages.create({ model: 'no-such-model-aos-smoke', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }, TIMEOUT),
      () => new Anthropic({ apiKey: 'invalid-aos-smoke', baseURL: config.llm.baseURL, maxRetries: 0 }).messages.create({ model: models.fast, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }, TIMEOUT),
    ]) {
      const kind = await req().then(() => 'accepted', (err: unknown) => mapError(err).kind);
      kinds.push(kind);
    }
    assert(kinds[0] === 'bad_request', `invalid model → ${kinds[0]}`);
    // A proxy without REQUIRE_API_KEY accepts any key: worth knowing, not a client bug.
    return `invalid model → ${kinds[0]}, invalid key → ${kinds[1]}`;
  },
};

console.log(`Provider ${config.llm.baseURL} · fast=${models.fast} work=${models.work} deep=${models.deep}\n`);
const results = {} as Record<Check, { result: Result; note?: string }>;
for (const name of CHECKS) {
  try {
    const note = await checks[name]();
    results[name] = { result: 'pass', ...(note ? { note } : {}) };
  } catch (err) {
    if (err instanceof Skip) {
      results[name] = { result: 'skip', note: err.message };
      console.log(`${ICON.skip} ${name.padEnd(10)} ${err.message}`);
      continue;
    }
    const e = err instanceof AssertionError ? { kind: 'assert', status: undefined, message: err.message } : mapError(err);
    results[name] = { result: 'fail', note: `${e.kind}${e.status ? ` ${e.status}` : ''}: ${e.message.slice(0, 160)}` };
  }
  console.log(`${ICON[results[name].result]} ${name.padEnd(10)} ${results[name].note ?? ''}`);
}

const ok = (c: Check) => results[c].result === 'pass';
// ponytail: results are only printed; persist them when a feature needs to read capability flags.
// Cache and batch are capability flags, not failures: only the core path decides the exit code.
process.exitCode = (['plain', 'stream', 'errors'] as const).every(ok) ? 0 : 1;
