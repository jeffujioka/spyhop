// The one seam through which spyhop runs a program: `run(command, args, options)` resolves to
// `{ code, stdout, stderr }`, the exec shape the core (src/core) is written for. Only read-only
// programs go through it. On this computer no shell string is used; on another Orca host
// (`on`: the alias of its SSH target) the program runs as `ssh <alias> -o BatchMode=yes --
// <line>`, the line being the program and its arguments, each quoted for the remote shell, after
// `cd <cwd> &&` when a folder is given. A program that exits non-zero (ssh too, as for an
// unreachable host) resolves with its code; one that cannot start, runs past the timeout or
// prints past the output cap rejects, and the core reads n/a for what it asked.

import { execFile } from 'node:child_process';

// Longest any one program may run.
export const RUN_TIMEOUT_MS = 10 * 1000;

// Most a program may print on stdout or stderr; the session reader's scan blocks fit within it.
export const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export type RunResult = { code: number; stdout: string; stderr: string };
export type RunOptions = { cwd?: string; on?: string | null };
export type Run = (command: string, args: string[], options?: RunOptions) => Promise<RunResult>;

// A word as the remote POSIX shell reads it back unchanged.
const quote = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`;

export const run: Run = (command, args, options = {}) => {
  const { promise, resolve, reject } = Promise.withResolvers<RunResult>();
  const { on, cwd } = options;
  let [program, argv] = [command, args];
  if (on) {
    const line = [command, ...args].map(quote).join(' ');
    // BatchMode: ssh never asks for a password or a host key, it fails instead
    [program, argv] = ['ssh', [on, '-o', 'BatchMode=yes', '--', cwd ? `'cd' ${quote(cwd)} && ${line}` : line]];
  }
  execFile(
    program,
    argv,
    { cwd: on ? undefined : cwd, timeout: RUN_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8' },
    (error, stdout, stderr) => {
      if (!error) resolve({ code: 0, stdout, stderr });
      else if (typeof error.code === 'number') resolve({ code: error.code, stdout, stderr });
      else reject(error);
    },
  );
  return promise;
};
