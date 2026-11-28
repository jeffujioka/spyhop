// The one seam through which spyhop runs a program: `run(command, args, options)` resolves to
// `{ code, stdout, stderr }`, the exec shape the core (src/core) is written for. Only read-only
// programs go through it. On this computer no shell string is used; on another Orca host
// (`on`: the alias of its SSH target) the program runs as `ssh <alias> -o BatchMode=yes -o
// ConnectTimeout=5 -- <line>`, the line being the program and its arguments, each quoted for the
// remote shell, after `cd <cwd> &&` when a folder is given. Unless the alias's own ssh settings
// (`ssh -G <alias>`, read on this computer at most once every SETTINGS_TTL_MS) already reuse
// connections, `-o ControlMaster=auto -o ControlPath=/tmp/spyhop-<uid>/%C -o ControlPersist=60`
// follows ConnectTimeout, so the alias's programs share one connection; when `ssh -G` fails, or
// the socket folder is a symlink or another user's, nothing is added. At most OWNED_AT_ONCE of
// an alias's programs run at once with those options, and at most SHARED_AT_ONCE without them,
// the others waiting their turn, so a host's SSH server never sees more sessions on spyhop's
// connection, or more new connections, than its default limits let through. An alias that starts with `-`,
// which ssh would read as an option, is refused as an unreachable host. A program that exits non-zero
// (ssh too, as for an unreachable host) resolves with its code; one that cannot start, runs past
// the timeout or prints past the output cap rejects, and the core reads n/a for what it asked.
// `runBytes` runs a program the same way, its stdout given as the bytes it printed.

import { execFile } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { createLimit } from './core/limit.js';
import { createTtlCache } from './core/ttl-cache.js';

// Longest any one program may run, from its start.
export const RUN_TIMEOUT_MS = 10 * 1000;

// Most a program may print on stdout or stderr; the session reader's scan blocks fit within it.
export const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

// Most programs run at once on an alias to whose ssh calls spyhop adds its own options for
// reusing connections: that connection is spyhop's alone, and this is below sshd's default
// `MaxSessions 10` on one connection.
const OWNED_AT_ONCE = 8;

// Most programs run at once on any other alias, whose connection is shared with the user's other
// ssh sessions or where each program is a new connection: below sshd's default `MaxStartups 10`.
const SHARED_AT_ONCE = 4;

// How long an alias's `ssh -G` settings are kept before they are read again.
const SETTINGS_TTL_MS = 60 * 1000;

// The `controlmaster` values, as `ssh -G` prints them (`yes` as `true`), of an alias whose own
// settings already reuse connections.
const REUSING = ['auto', 'true', 'ask', 'autoask'];

export type RunResult = { code: number; stdout: string; stderr: string };
export type RunOptions = { cwd?: string; on?: string | null };
export type Run = (command: string, args: string[], options?: RunOptions) => Promise<RunResult>;
export type BytesResult = { code: number; stdout: Buffer; stderr: string };
export type RunBytes = (command: string, args: string[], options?: RunOptions) => Promise<BytesResult>;

// A word as the remote POSIX shell reads it back unchanged.
export const quote = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`;

// alias, after `owned ` for its ssh calls with spyhop's options for reusing connections and
// `shared ` for those without -> the limit those programs run under. An alias whose settings
// change has its calls of either kind under that kind's own limit.
const limits = new Map<string, (task: () => Promise<BytesResult>) => Promise<BytesResult>>();

// alias -> the options its ssh calls add for reusing connections, as its `ssh -G` settings ask
const reuse = createTtlCache(SETTINGS_TTL_MS);

function execute(program: string, argv: string[], cwd: string | undefined) {
  const { promise, resolve, reject } = Promise.withResolvers<BytesResult>();
  execFile(program, argv, { cwd, timeout: RUN_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'buffer' }, (error, stdout, stderr) => {
    if (!error) resolve({ code: 0, stdout, stderr: stderr.toString('utf8') });
    else if (typeof error.code === 'number') resolve({ code: error.code, stdout, stderr: stderr.toString('utf8') });
    else reject(error);
  });
  return promise;
}

// The options that make an alias's ssh calls share one connection: none when the alias's own
// settings already do, when `ssh -G` fails, or when the socket folder cannot be kept the user's
// alone; the socket lives on this computer only, in a folder of mode 700.
async function reuseOptions(alias: string): Promise<string[]> {
  const settings = await execute('ssh', ['-G', alias], undefined).catch(() => null);
  if (settings?.code !== 0) return [];
  if (REUSING.includes(/^controlmaster (\S+)$/m.exec(settings.stdout.toString('utf8'))?.[1] ?? '')) return [];
  const uid = process.getuid!();
  const folder = `/tmp/spyhop-${uid}`;
  try {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    // a symlink, which another local user may have left there, or a folder of another user's is
    // not used; a folder left with a wider mode is narrowed
    const found = lstatSync(folder);
    if (!found.isDirectory() || found.uid !== uid) return [];
    chmodSync(folder, 0o700);
  } catch {
    return [];
  }
  return ['-o', 'ControlMaster=auto', '-o', `ControlPath=${folder}/%C`, '-o', 'ControlPersist=60'];
}

export const runBytes: RunBytes = async (command, args, options = {}) => {
  const { on, cwd } = options;
  if (!on) return execute(command, args, cwd);
  if (on.startsWith('-')) return { code: 255, stdout: Buffer.alloc(0), stderr: `spyhop: alias ${on} reads as an ssh option` };
  const line = [command, ...args].map(quote).join(' ');
  const reusing: string[] = await reuse(on, Date.now(), () => reuseOptions(on));
  // BatchMode: ssh never asks for a password or a host key, it fails instead
  const argv = [on, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', ...reusing, '--', cwd ? `'cd' ${quote(cwd)} && ${line}` : line];
  const owned = reusing.length > 0;
  const key = `${owned ? 'owned' : 'shared'} ${on}`;
  if (!limits.has(key)) limits.set(key, createLimit(owned ? OWNED_AT_ONCE : SHARED_AT_ONCE));
  return limits.get(key)!(() => execute('ssh', argv, undefined));
};

export const run: Run = async (command, args, options) => {
  const { code, stdout, stderr } = await runBytes(command, args, options);
  return { code, stdout: stdout.toString('utf8'), stderr };
};
