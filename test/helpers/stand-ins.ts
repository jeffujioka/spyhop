// Stand-ins for the two programs a test cannot run for real: `orca` (as ORCA_CLI_COMMAND), which
// answers the commands it is given with recorded output shaped on this Mac's Orca, and `ssh`:
// `ssh -G <alias>` prints the alias's settings, shaped on this Mac's ssh, with the test's
// `controlmaster`, or fails; `ssh <alias> <command>` runs the command after the alias here, under
// the remote host's own home folder, or fails as an unreachable host does. Both log each call.
// `standIns` sets PATH and ORCA_CLI_COMMAND for the test (test/helpers/env.ts).
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setEnv } from './env.ts';
import { tempHome } from './files.ts';

// `{ ok, result }`, as every `orca … --json` answers.
export const answer = (result: unknown) => JSON.stringify({ id: 'local', ok: true, result });

// `homes`: each reachable alias and its home folder; any other alias is unreachable. `orca`: each
// command line and its recorded answer; any other line fails. `controlmaster`: each alias whose
// `ssh -G` answers, and the `controlmaster` it prints; `ssh -G` on any other alias fails.
export function standIns({
  homes,
  orca,
  controlmaster = {},
}: {
  homes: Record<string, string>;
  orca: Record<string, string>;
  controlmaster?: Record<string, string>;
}) {
  const bin = tempHome();
  const log = join(bin, 'calls.log');
  writeFileSync(log, '');
  // each call one line, the program and its arguments separated by tabs, appended in one write
  // while the line is shorter than the shell's write buffer, so that calls running at once (up to
  // four per host) never interleave their lines
  const logCall = (program: string) =>
    `line='${program}'"$(printf '\\t')"; for a in "$@"; do line="$line$a$(printf '\\t')"; done; printf '%s\\n' "$line" >> '${log}'`;
  const orcaCases = Object.entries(orca).map(([args, output], i) => {
    writeFileSync(join(bin, `orca-${i}.json`), output);
    return `  '${args}') cat '${join(bin, `orca-${i}.json`)}' ;;`;
  });
  writeFileSync(
    join(bin, 'orca'),
    ['#!/bin/sh', logCall('orca'), 'case "$*" in', ...orcaCases, `  *) echo '{"ok":false,"error":{"code":"not_found"}}'; exit 1 ;;`, 'esac', ''].join('\n'),
  );
  const sshCases = Object.entries(homes).map(([alias, home]) => `  '${alias}') HOME='${home}'; export HOME ;;`);
  const settingsCases = Object.entries(controlmaster).map(
    ([alias, value]) => `    '${alias}') printf 'host %s\\nuser dev\\nhostname %s\\nport 22\\ncontrolmaster ${value}\\ncontrolpersist no\\n' "$2" "$2"; exit 0 ;;`,
  );
  const reuse = `-o ControlMaster=auto -o ControlPath=/tmp/spyhop-${process.getuid!()}/%C -o ControlPersist=60`;
  writeFileSync(
    join(bin, 'ssh'),
    [
      '#!/bin/sh',
      logCall('ssh'),
      'if [ "$1" = -G ]; then',
      '  [ $# -eq 2 ] || exit 255',
      '  case "$2" in',
      ...settingsCases,
      '    *) echo "/Users/dev/.ssh/config: line 3: Bad configuration option: $2" >&2; exit 255 ;;',
      '  esac',
      'fi',
      'case "$1" in',
      ...sshCases,
      '  *) echo "ssh: connect to host $1 port 22: Connection refused" >&2; exit 255 ;;',
      'esac',
      // spyhop's options for reusing connections, when given, come after ConnectTimeout, in full
      `[ $# -eq 13 ] && [ "$6 $7 $8 $9 \${10} \${11}" = '${reuse}' ] && set -- "$1" "$2" "$3" "$4" "$5" "\${12}" "\${13}"`,
      '[ "$2 $3 $4 $5 $6" = "-o BatchMode=yes -o ConnectTimeout=5 --" ] && [ $# -eq 7 ] || exit 255',
      'exec /bin/sh -c "$7"',
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'orca'), 0o755);
  chmodSync(join(bin, 'ssh'), 0o755);
  setEnv('ORCA_CLI_COMMAND', join(bin, 'orca'));
  setEnv('PATH', `${bin}:${process.env.PATH}`);
  const calls = () =>
    readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\t').slice(0, -1));
  return {
    // the calls that run a command on a host, each its arguments after `ssh`
    ssh: () => calls().filter(([program, first]) => program === 'ssh' && first !== '-G').map(([, ...args]) => args),
    // the aliases `ssh -G` was asked about, one per call
    sshSettings: () => calls().filter(([program, first]) => program === 'ssh' && first === '-G').map(([, , alias]) => alias),
    orca: () => calls().filter(([program]) => program === 'orca').map(([, ...args]) => args.join(' ')),
  };
}
