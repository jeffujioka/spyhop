// Stand-ins for the two programs a test cannot run for real: `orca` (as ORCA_CLI_COMMAND), which
// answers the commands it is given with recorded output shaped on this Mac's Orca, and `ssh`:
// `ssh -G <alias>` prints the alias's settings, shaped on this Mac's ssh, with the test's
// `controlmaster`, or fails; `ssh <alias> <command>` runs the command after the alias here, under
// the remote host's own home folder (with no `zstd` for an alias the test names), or fails as an
// unreachable host does. Both log each call.
// `orca` holds back the answer to each command the test names until the test releases it, and
// `ssh` every command on an alias the test names, or each of its commands holding a word it names;
// `ssh` also fails, as a dropped connection does, each command on an alias holding a word it names.
// `standIns` sets PATH and ORCA_CLI_COMMAND for the test (test/helpers/env.ts).
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setEnv } from './env.ts';
import { seenIn, tempHome } from './files.ts';

// `{ ok, result }`, as every `orca … --json` answers.
export const answer = (result: unknown) => JSON.stringify({ id: 'local', ok: true, result });

// `homes`: each reachable alias and its home folder; any other alias is unreachable. `orca`: each
// command line and its recorded answer; any other line fails. `controlmaster`: each alias whose
// `ssh -G` answers, and the `controlmaster` it prints; `ssh -G` on any other alias fails. `held`:
// each `orca` command line whose answer is held back, each `ssh <alias>` whose every command on
// that alias is, and each `ssh <alias> <word>` whose commands on that alias that hold the word
// are, each call logged, until `release` of it. `failing`: each `ssh <alias> <word>` whose
// commands on that alias that hold the word exit 255, each call logged, as a dropped connection
// does. `noZstd`: each alias whose PATH puts first a `zstd` that exits 127, as a shell finds no
// program.
export function standIns({
  homes,
  orca,
  controlmaster = {},
  held = [],
  failing = [],
  noZstd = [],
}: {
  homes: Record<string, string>;
  orca: Record<string, string>;
  controlmaster?: Record<string, string>;
  held?: string[];
  failing?: string[];
  noZstd?: string[];
}) {
  const bin = tempHome();
  const log = join(bin, 'calls.log');
  writeFileSync(log, '');
  // each call one line, the program and its arguments separated by tabs, appended in one write
  // while the line is shorter than the shell's write buffer, so that calls running at once (up to
  // eight per host) never interleave their lines
  const logCall = (program: string) =>
    `line='${program}'"$(printf '\\t')"; for a in "$@"; do line="$line$a$(printf '\\t')"; done; printf '%s\\n' "$line" >> '${log}'`;
  // the file whose presence lets what is held as `key` answer, a `/` of the key (a path's) as `%`
  const releaseOf = (key: string) => join(bin, `released ${key.replaceAll('/', '%')}`);
  // the shell's wait for the release of `key`, when the test holds it
  const hold = (key: string) => (held.includes(key) ? `until [ -e '${releaseOf(key)}' ]; do sleep 0.01; done; ` : '');
  const orcaCases = Object.entries(orca).map(([args, output], i) => {
    writeFileSync(join(bin, `orca-${i}.json`), output);
    return `  '${args}') ${hold(args)}cat '${join(bin, `orca-${i}.json`)}' ;;`;
  });
  writeFileSync(
    join(bin, 'orca'),
    ['#!/bin/sh', logCall('orca'), 'case "$*" in', ...orcaCases, `  *) echo '{"ok":false,"error":{"code":"not_found"}}'; exit 1 ;;`, 'esac', ''].join('\n'),
  );
  const noZstdDir = join(bin, 'no-zstd');
  mkdirSync(noZstdDir);
  writeFileSync(join(noZstdDir, 'zstd'), '#!/bin/sh\nexit 127\n');
  chmodSync(join(noZstdDir, 'zstd'), 0o755);
  const withoutZstd = (alias: string) => (noZstd.includes(alias) ? ` PATH='${noZstdDir}':"$PATH"; export PATH;` : '');
  const sshCases = Object.entries(homes).map(
    ([alias, home]) => `  '${alias}') ${hold(`ssh ${alias}`)}HOME='${home}'; export HOME;${withoutZstd(alias)} ;;`,
  );
  // `then` for a command line ($7) on the alias of each `ssh <alias> <word>` of `keys` holding the
  // word, a quote in it written `'\''` as in the line
  const onWord = (keys: string[], then: (key: string) => string) =>
    keys.flatMap((key) => {
      const [program, alias, ...word] = key.split(' ');
      if (program !== 'ssh' || word.length === 0) return [];
      return [`[ "$1" = '${alias}' ] && case "$7" in *'${word.join(' ').replaceAll("'", `'\\''`)}'*) ${then(key)} ;; esac`];
    });
  // the wait of each `ssh <alias> <word>` held, and the drop of each failing
  const wordHolds = onWord(held, (key) => `${hold(key)}:`);
  const wordFails = onWord(failing, () => "echo 'Connection closed' >&2; exit 255");
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
      ...wordHolds,
      ...wordFails,
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
    // lets what is held as `key`, an `orca` command line, `ssh <alias>` or `ssh <alias> <word>`,
    // answer, this call and every later one
    release: (key: string) => writeFileSync(releaseOf(key), ''),
    // resolves once `seen()` holds, asked again at each change of the stand-ins' files (a call
    // logged); rejects when it does not within 5 s
    until: (seen: () => boolean) => seenIn(bin, seen),
  };
}
