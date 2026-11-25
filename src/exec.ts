// The one seam through which spyhop runs a program: `run(command, args, options)` resolves to
// `{ code, stdout, stderr }`, the exec shape the core (src/core) is written for. Only read-only
// programs go through it, with no shell string. A program that exits non-zero resolves with its
// code; one that cannot start, runs past the timeout or prints past the output cap rejects, and
// the core reads n/a for what it asked.

import { execFile } from 'node:child_process';

// Longest any one program may run.
export const RUN_TIMEOUT_MS = 10 * 1000;

// Most a program may print on stdout or stderr; the session reader's scan blocks fit within it.
export const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export type RunResult = { code: number; stdout: string; stderr: string };
export type RunOptions = { cwd?: string };
export type Run = (command: string, args: string[], options?: RunOptions) => Promise<RunResult>;

export const run: Run = (command, args, options = {}) => {
  const { promise, resolve, reject } = Promise.withResolvers<RunResult>();
  execFile(
    command,
    args,
    { cwd: options.cwd, timeout: RUN_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8' },
    (error, stdout, stderr) => {
      if (!error) resolve({ code: 0, stdout, stderr });
      else if (typeof error.code === 'number') resolve({ code: error.code, stdout, stderr });
      else reject(error);
    },
  );
  return promise;
};
