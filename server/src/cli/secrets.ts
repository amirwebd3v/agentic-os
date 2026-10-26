import { text } from 'node:stream/consumers';
import { SECRET_NAMES, getSecret, isSecretName, setSecret } from '../secrets.ts';

const USAGE = `Usage:
  pnpm secrets set <${SECRET_NAMES.join('|')}>   prompts for the value (hidden)
  pnpm secrets status                  shows which secrets are set`;

/** Reads one line without echoing it. The value never touches argv, so it can't land in shell history. */
async function readHidden(prompt: string): Promise<string> {
  const { stdin, stderr } = process;
  if (!stdin.isTTY) return (await text(stdin)).replace(/\r?\n$/, ''); // piped input: nothing to echo
  stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const done = (fn: () => void) => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stderr.write('\n');
      fn();
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done(() => resolve(value));
        if (ch === '\u0003') return done(() => reject(new Error('Cancelled')));
        if (ch === '\u0008' || ch === '\u007f') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function main(args: string[]): Promise<number> {
  const [cmd, name, ...rest] = args;
  if (cmd === 'status' && name === undefined) {
    for (const n of SECRET_NAMES) console.log(`${n}: ${getSecret(n) === null ? 'unset' : 'set'}`);
    return 0;
  }
  if (cmd === 'set' && name !== undefined && rest.length === 0) {
    if (!isSecretName(name)) {
      console.error(`Unknown secret "${name}". Expected one of: ${SECRET_NAMES.join(', ')}`);
      return 1;
    }
    const value = (await readHidden(`Value for ${name}: `)).trim();
    if (!value) {
      console.error('Empty value, nothing stored.');
      return 1;
    }
    setSecret(name, value);
    console.log(`${name}: stored in Windows Credential Manager (agentic-os)`);
    return 0;
  }
  console.error(USAGE);
  return 1;
}

main(process.argv.slice(2)).then(
  (code) => (process.exitCode = code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : 'Failed');
    process.exitCode = 1;
  },
);
