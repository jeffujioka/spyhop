// The one seam through which spyhop runs a program: `run(command, args, options)` resolves to
// `{ code, stdout, stderr }`, the exec shape the core (src/core) is written for. Only read-only
// programs go through it. On this computer no shell string is used; on another Orca host
// (`on`: the alias of its SSH target) the program runs as `ssh <alias> -o BatchMode=yes -o
// ConnectTimeout=5 -- <line>`, the line being the program and its arguments, each quoted for the
// remote shell, after `cd <cwd> &&` when a folder is given. At most SSH_AT_ONCE programs run on
// one alias at once, the others waiting their turn, so a host's SSH server never sees more new
// connections than its default limit lets through. An alias that starts with `-`, which ssh
// would read as an option, is refused as an unreachable host. A program that exits non-zero
// (ssh too, as for an unreachable host) resolves with its code; one that cannot start, runs past
// the timeout or prints past the output cap rejects, and the core reads n/a for what it asked.

import { execFile } from 'node:child_process';
import { createLimit } from './core/limit.js';

// Longest any one program may run, from its start.
export const RUN_TIMEOUT_MS = 10 * 1000;

// Most a program may print on stdout or stderr; the session reader's scan blocks fit within it.
export const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

// Most programs run at once on one other Orca host: below sshd's default `MaxStartups 10`.
const SSH_AT_ONCE = 4;

export type RunResult = { code: number; stdout: string; stderr: string };
export type RunOptions = { cwd?: string; on?: string | null };
export type Run = (command: string, args: string[], options?: RunOptions) => Promise<RunResult>;

// A word as the remote POSIX shell reads it back unchanged.
const quote = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`;

// alias -> the limit its programs run under
const hosts = new Map<string, (task: () => Promise<RunResult>) => Promise<RunResult>>();

function execute(program: string, argv: string[], cwd: string | undefined) {
  const { promise, resolve, reject } = Promise.withResolvers<RunResult>();
  execFile(program, argv, { cwd, timeout: RUN_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8' }, (error, stdout, stderr) => {
    if (!error) resolve({ code: 0, stdout, stderr });
    else if (typeof error.code === 'number') resolve({ code: error.code, stdout, stderr });
    else reject(error);
  });
  return promise;
}

export const run: Run = async (command, args, options = {}) => {
  const { on, cwd } = options;
  if (!on) return execute(command, args, cwd);
  if (on.startsWith('-')) return { code: 255, stdout: '', stderr: `spyhop: alias ${on} reads as an ssh option` };
  const line = [command, ...args].map(quote).join(' ');
  // BatchMode: ssh never asks for a password or a host key, it fails instead
  const argv = [on, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '--', cwd ? `'cd' ${quote(cwd)} && ${line}` : line];
  if (!hosts.has(on)) hosts.set(on, createLimit(SSH_AT_ONCE));
  return hosts.get(on)!(() => execute('ssh', argv, undefined));
};
