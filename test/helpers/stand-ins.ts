// Stand-ins for the two programs a test cannot run for real: `orca` (as ORCA_CLI_COMMAND), which
// answers the commands it is given with recorded output shaped on this Mac's Orca, and
// `ssh <alias> <command>`, which runs the command after the alias here, under the remote host's
// own home folder, or fails as an unreachable host does. Both log each call.
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempHome } from './agent-cards.ts';

// `{ ok, result }`, as every `orca … --json` answers.
export const answer = (result: unknown) => JSON.stringify({ id: 'local', ok: true, result });

// `homes`: each reachable alias and its home folder; any other alias is unreachable. `orca`: each
// command line and its recorded answer; any other line fails.
export function standIns({ homes, orca }: { homes: Record<string, string>; orca: Record<string, string> }) {
  const bin = tempHome();
  const log = join(bin, 'calls.log');
  writeFileSync(log, '');
  // each call one line, its arguments separated by tabs
  const logCall = `for a in "$@"; do printf '%s\\t' "$a"; done >> '${log}'; printf '\\n' >> '${log}'`;
  const orcaCases = Object.entries(orca).map(([args, output], i) => {
    writeFileSync(join(bin, `orca-${i}.json`), output);
    return `  '${args}') cat '${join(bin, `orca-${i}.json`)}' ;;`;
  });
  writeFileSync(
    join(bin, 'orca'),
    ['#!/bin/sh', `printf 'orca\\t' >> '${log}'`, logCall, 'case "$*" in', ...orcaCases, `  *) echo '{"ok":false,"error":{"code":"not_found"}}'; exit 1 ;;`, 'esac', ''].join('\n'),
  );
  const sshCases = Object.entries(homes).map(([alias, home]) => `  '${alias}') HOME='${home}'; export HOME ;;`);
  writeFileSync(
    join(bin, 'ssh'),
    [
      '#!/bin/sh',
      `printf 'ssh\\t' >> '${log}'`,
      logCall,
      'case "$1" in',
      ...sshCases,
      '  *) echo "ssh: connect to host $1 port 22: Connection refused" >&2; exit 255 ;;',
      'esac',
      '[ "$2 $3 $4" = "-o BatchMode=yes --" ] && [ $# -eq 5 ] || exit 255',
      'exec /bin/sh -c "$5"',
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'orca'), 0o755);
  chmodSync(join(bin, 'ssh'), 0o755);
  process.env.ORCA_CLI_COMMAND = join(bin, 'orca');
  process.env.PATH = `${bin}:${process.env.PATH}`;
  const calls = () =>
    readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\t').slice(0, -1));
  return {
    ssh: () => calls().filter(([program]) => program === 'ssh').map(([, ...args]) => args),
    orca: () => calls().filter(([program]) => program === 'orca').map(([, ...args]) => args.join(' ')),
  };
}
