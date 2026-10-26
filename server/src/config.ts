import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const repoRoot = resolve(fileURLToPath(import.meta.url), '../../..');

// Sync clients corrupt SQLite WAL files and fight git locks.
const dataPath = z
  .string()
  .min(1)
  .refine((p) => !/onedrive/i.test(p), 'must not be inside OneDrive or another sync folder');

const ConfigSchema = z.object({
  vaultDir: dataPath,
  dataDir: dataPath,
  server: z.object({ port: z.number().int().min(1).max(65535).default(3000) }).prefault({}),
  llm: z
    .object({
      baseURL: z.url().default('https://api.anthropic.com'),
      models: z
        .object({
          fast: z.string().default('claude-haiku-5-5'),
          work: z.string().default('claude-sonnet-5-5'),
          deep: z.string().default('claude-opus-5-5'),
        })
        .prefault({}),
    })
    .prefault({}),
  decider: z
    .object({
      baseURL: z.url().default('http://127.0.0.1:8009'),
      model: z.string().default('multilingual'),
      escalateBelow: z.number().min(0).max(1).default(0.6),
    })
    .prefault({}),
  session: z.object({ idleMinutes: z.number().int().positive().default(15) }).prefault({}),
});

export type Config = z.infer<typeof ConfigSchema>;

const isInside = (child: string, parent: string): boolean => {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** Validates raw config; personal data must live outside the code repo so it can never be committed. */
export function parseConfig(raw: unknown, root: string = repoRoot): Config {
  const config = ConfigSchema.parse(raw);
  for (const key of ['vaultDir', 'dataDir'] as const) {
    if (isInside(config[key], root)) throw new Error(`${key} must be outside the code repo (${root})`);
  }
  return config;
}

export function loadConfig(path: string = resolve(repoRoot, 'agentic-os.json')): Config {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`Config not found at ${path}. Copy agentic-os.example.json to agentic-os.json and edit the paths.`);
  }
  return parseConfig(JSON.parse(text));
}
