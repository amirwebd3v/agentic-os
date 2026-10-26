import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitCommit, vaultGit } from './writer.ts';

const templates = fileURLToPath(new URL('../../templates/', import.meta.url));

export const VAULT_FOLDERS = ['persona', 'wiki', 'journal', 'inbox', 'outputs', 'exports', 'attachments', '.obsidian'];

const SEED_FILES: Record<string, () => string> = {
  '.gitignore': () => ['attachments/', '.obsidian/workspace*.json', '.obsidian/cache', '.trash/', ''].join('\n'),
  '.obsidian/app.json': () =>
    JSON.stringify({ attachmentFolderPath: 'attachments', newLinkFormat: 'shortest', useMarkdownLinks: false }, null, 2) + '\n',
  'CLAUDE.md': () => readFileSync(join(templates, 'CLAUDE.md'), 'utf8'),
  'persona/_questions.md': () => readFileSync(join(templates, 'persona-questions.md'), 'utf8'),
};

/**
 * Idempotent: creates what is missing and never touches existing files.
 * Refuses a vault repo with a remote, since the vault must never leave this machine.
 * Returns the vault-relative paths it created.
 */
export async function initVault(vaultDir: string): Promise<string[]> {
  mkdirSync(vaultDir, { recursive: true });
  if (!existsSync(join(vaultDir, '.git'))) await vaultGit(vaultDir, 'init', '-q', '-b', 'main');
  const remotes = (await vaultGit(vaultDir, 'remote')).trim();
  if (remotes) throw new Error(`The vault repo has a remote (${remotes.split('\n').join(', ')}). Remove it: the vault must stay local.`);

  for (const folder of VAULT_FOLDERS) mkdirSync(join(vaultDir, folder), { recursive: true });
  const created: string[] = [];
  for (const [rel, content] of Object.entries(SEED_FILES)) {
    const abs = join(vaultDir, rel);
    if (existsSync(abs)) continue;
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content(), { flag: 'wx' });
    created.push(rel);
  }
  if (created.length) await gitCommit(vaultDir, 'aos: init vault');
  return created;
}
