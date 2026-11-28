// Whether a command line `ssh` runs on a remote Orca host only reads: what the remote tests ask
// of every command the plugin runs there.

// The script the runner wraps a program in to compress its output (src/history/catch-up.ts).
const ZSTD_SCRIPT = 'exec 4>&1; s=$( { { "$@"; echo $? >&3; } | zstd -q -c >&4; } 3>&1 ); exit $s';

// Whether one program with its arguments only reads.
function readsOnly([program, ...args]: string[]): boolean {
  switch (program) {
    case 'cd':
    case 'uname':
    case 'printenv':
    case 'cat':
    case 'head':
    case 'tail':
    case 'stat':
    case '/usr/bin/stat':
      return true;
    case 'dd':
      return !args.some((arg) => arg.startsWith('of='));
    case 'find': {
      const exec = args.indexOf('-exec');
      return !args.some((arg) => ['-delete', '-execdir', '-ok', '-fprint'].includes(arg)) && (exec < 0 || readsOnly(args.slice(exec + 1, -2)));
    }
    case 'git':
      return (args[0] === 'branch' && args[1] === '--show-current') || (args[0] === 'remote' && args[1] === 'get-url');
    case 'zstd':
      return args.length === 1 && args[0] === '-V';
    // a read-only program whose output the runner compresses, keeping its exit code
    // (src/history/catch-up.ts)
    case 'sh':
      return args[0] === '-c' && args[1] === ZSTD_SCRIPT && args[2] === 'sh' && readsOnly(args.slice(3));
    case 'sqlite3':
      return args[0] === '-readonly';
    default:
      return false;
  }
}

// Whether a command line `ssh` runs on the remote host is programs joined by `&&` that only
// read, every word of them quoted: in single quotes, a quote within the word written `'\''` as
// the plugin's runner (src/exec.ts) writes it.
export function readOnlyLine(line: string): boolean {
  const words = line.match(/(?:'[^']*'|\\')+|&&/g) ?? [];
  if (words.join(' ') !== line) return false;
  const commands: string[][] = [[]];
  for (const word of words) {
    if (word === '&&') commands.push([]);
    else commands.at(-1)!.push(word.replace(/'([^']*)'|\\'/g, (_, inside: string | undefined) => inside ?? "'"));
  }
  return commands.every((command) => command.length > 0 && readsOnly(command));
}
