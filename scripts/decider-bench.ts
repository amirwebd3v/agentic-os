// `pnpm --filter @agentic-os/server exec tsx ../scripts/decider-bench.ts` with `pnpm sidecar` running.
// 50 sequential calls (3 questions each) against the sidecar, then p50/p95 and GPU memory.
import { execFileSync } from 'node:child_process';
import { openDb } from '../server/src/db/index.ts';
import { createDecider } from '../server/src/decider/client.ts';
import { getSecret } from '../server/src/secrets.ts';

const apiKey = getSecret('laya');
if (!apiKey) throw new Error('No laya key yet: run `pnpm sidecar` once first.');
// The sidecar's fixed address (scripts/sidecar.ts); the bench writes to a throwaway in-memory db.
const d = createDecider({ db: openDb(':memory:'), baseURL: 'http://127.0.0.1:8009', apiKey, model: 'multilingual' });

const state = { subject: 'Invoice #4411 due Friday', from: 'billing@example.com', body: 'Please pay the attached October hosting invoice by Friday.' };
const questions = {
  area: { type: 'choice', instructions: 'Which life area does this email belong to?', criteria: { 'admin-finance': 'Bills, banking, taxes', career: 'Jobs and work', health: 'Doctors and fitness' } },
  importance: { type: 'score', instructions: 'How important is this email?', criteria: ['ignorable', 'low', 'normal', 'high', 'urgent'] },
  needs_action: { type: 'noul', instructions: 'Does the reader need to do something?' },
} as const;

await d.decide(state, questions); // warm-up: first CUDA call pays kernel load
const ms: number[] = [];
for (let i = 0; i < 50; i++) ms.push((await d.decide(state, questions)).latencyMs);
ms.sort((a, b) => a - b);
const pct = (p: number): number => ms[Math.ceil((p / 100) * ms.length) - 1]!;
console.log(`decider-bench: 50 calls x 3 questions  p50 ${pct(50)} ms  p95 ${pct(95)} ms  max ${ms.at(-1)} ms`);
console.log(`nvidia-smi memory.used: ${execFileSync('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader'], { encoding: 'utf8' }).trim()}`);
