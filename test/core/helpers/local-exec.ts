// An `exec(command, args, options)` that runs local programs, the read-only ones the session reader runs,
// over a map of path -> bytes (a Buffer or a string): each file of the map is written below a
// temporary folder, and the real `tail` and `dd` read it there through the real runner
// (src/exec.ts), with the same output cap:
//   tail -c N -- path        the last N bytes
//   tail -c +N -- path       from byte N (1-based) to the end
//   dd if=path bs=B skip=K count=1      block K of size B, with dd's report on stderr
// A test changes a file by setting it in the map; the change is written before the next call.
// Any other command rejects, as a program that cannot start does. Every call is kept with its
// arguments as the reader passed them (the map's paths) and the bytes it served, so a test can
// say what a refresh read.
//
// `faults`: `before(call)` runs before a call is served (a test acts on the files there);
// `fail(call)` returns true to make the call exit 1; `ddReport`: 'none' for a dd that reports
// nothing, or a function of the block's length that returns the statistics line (any wording).
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after } from 'node:test';
import { MAX_OUTPUT_BYTES, run } from '../../../src/exec.ts';

export const EXEC_CAP = MAX_OUTPUT_BYTES;

type Content = string | Buffer;
type Call = { command: string; args: string[]; options?: unknown; served: number };
type Faults = { before?: (call: Call) => unknown; fail?: (call: Call) => boolean; ddReport?: 'none' | ((length: number) => string) };

const roots: string[] = [];
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

export function localExec(files: Map<string, Content>, faults: Faults = {}) {
  const root = mkdtempSync(join(tmpdir(), 'spyhop-files-'));
  roots.push(root);
  const calls: Call[] = [];
  // path -> the content last written for it
  const written = new Map<string, Content>();

  // The file of `path` on disk, written again when the map changed; null when the map has none.
  function onDisk(path: string) {
    const content = files.get(path);
    if (content === undefined) return null;
    const real = join(root, path);
    if (written.get(path) !== content) {
      mkdirSync(dirname(real), { recursive: true });
      writeFileSync(real, content);
      written.set(path, content);
    }
    return real;
  }

  async function exec(command: string, args: string[] = [], options?: unknown) {
    const call: Call = { command, args, options, served: 0 };
    calls.push(call);
    faults.before?.(call);
    if (faults.fail?.(call)) return { code: 1, stdout: '', stderr: `${command}: failed` };
    if (command === 'tail' && args[0] === '-c' && args[2] === '--') {
      const real = onDisk(args[3]);
      if (real === null) return { code: 1, stdout: '', stderr: `tail: ${args[3]}: No such file or directory` };
      const size = statSync(real).size;
      const result = await run('tail', [args[0], args[1], '--', real]);
      call.served = args[1].startsWith('+') ? Math.max(0, size - Number(args[1].slice(1)) + 1) : Math.min(size, Number(args[1]));
      return result;
    }
    if (command === 'dd' && args.length === 4 && args[0].startsWith('if=') && args[3] === 'count=1') {
      const path = args[0].slice(3);
      const real = onDisk(path);
      if (real === null) return { code: 1, stdout: '', stderr: `dd: ${path}: No such file or directory` };
      const result = await run('dd', [`if=${real}`, args[1], args[2], args[3]]);
      call.served = Number(/^(\d+) bytes/m.exec(result.stderr)?.[1] ?? 0);
      if (faults.ddReport === 'none') return { ...result, stderr: '' };
      if (typeof faults.ddReport === 'function') {
        const records = call.served ? 1 : 0;
        return { ...result, stderr: `${records}+0 records in\n${records}+0 records out\n${faults.ddReport(call.served)}\n` };
      }
      return result;
    }
    throw new Error(`cannot start ${command}`);
  }
  const served = (from = 0) => calls.slice(from).reduce((sum, call) => sum + call.served, 0);
  return { exec, calls, served };
}
