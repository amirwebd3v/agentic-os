// Claude Code PreToolUse hook (.claude/settings.json): blocks shell commands that break CLAUDE.md hard rules.
// Reads the hook's JSON on stdin; exit 2 blocks the call and shows stderr to the model.
const RULES = [
  [/\bgit\b[^\n|;&]*\s--no-verify\b/, 'Rule 1: never use --no-verify; fix what pnpm verify reports.'],
  [/\bgh(\.exe)?["']?\s+pr\s+merge\b(?![^\n|;&]*--match-head-commit)/, 'Rule 8: verify the PR head, then gh pr merge <N> --squash --match-head-commit <sha>.'],
  [/\bgit\s+add\b[^\n|;&]*\s(-f|--force)\b[^\n|;&]*\bdocs\b/, 'docs/ is local only (CLAUDE.md): never force-add it.'],
  [/\b(?:mail_messages|mail_sender_rules)\b|\/api\/email\b/, 'Real mail stays out of Claude sessions (CLAUDE.md): use synthetic fixtures, and the owner runs anything on real mail.'],
];

export const blocked = (cmd) => RULES.find(([re]) => re.test(cmd))?.[1];

if (process.argv[2] === '--test') {
  const yes = ['git push --no-verify', 'git commit -m x --no-verify', '& "C:\\Program Files\\GitHub CLI\\gh.exe" pr merge 64 --squash', 'gh pr merge 5', 'git add -f docs/plan.md', 'sqlite3 brain.db "SELECT * FROM mail_messages"', 'sqlite3 brain.db .dump mail_sender_rules', 'curl http://127.0.0.1:3000/api/email/needs-sorting'];
  const no = ['git push origin main', 'gh pr merge 64 --squash --match-head-commit abc', 'git add docs', 'echo no-verify', 'gh pr view 64', 'pnpm --filter server exec vitest run test/mail-gate.test.ts', 'curl http://127.0.0.1:3000/api/emails'];
  for (const c of yes) if (!blocked(c)) throw new Error(`should block: ${c}`);
  for (const c of no) if (blocked(c)) throw new Error(`should allow: ${c}`);
  console.log('guard-command: ok');
} else {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const why = blocked(JSON.parse(input || '{}').tool_input?.command ?? '');
  if (why) {
    process.stderr.write(why);
    process.exit(2);
  }
}
