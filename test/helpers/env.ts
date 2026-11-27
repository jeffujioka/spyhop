// Environment variables a test sets: each is set back after the test, as it was before, once what
// the helpers end at the end of a test (`atTestEnd`) has ended. A program the worker starts reads
// `PATH` and ORCA_CLI_COMMAND then, so one started after the environment is set back runs this
// computer's real `orca` and `ssh`, or the next test's stand-ins.
import { afterEach } from 'node:test';
import { tempHome } from './files.ts';

// variable -> its value before the test set it (undefined: unset)
const saved = new Map<string, string | undefined>();
// what ends at the end of each test, in this order, before the environment is set back
const endings: (() => unknown)[] = [];
afterEach(async () => {
  try {
    for (const end of endings) await end();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    saved.clear();
  }
});

// Runs `end` at the end of each test, before the environment is set back.
export function atTestEnd(end: () => unknown) {
  endings.push(end);
}

export function setEnv(key: string, value: string) {
  if (!saved.has(key)) saved.set(key, process.env[key]);
  process.env[key] = value;
}

// A temporary home folder, set as HOME for the test.
export function useTempHome() {
  const home = tempHome();
  setEnv('HOME', home);
  return home;
}
