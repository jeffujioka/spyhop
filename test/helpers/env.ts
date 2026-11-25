// Environment variables a test sets: each is set back after the test, as it was before.
import { afterEach } from 'node:test';
import { tempHome } from './files.ts';

// variable -> its value before the test set it (undefined: unset)
const saved = new Map<string, string | undefined>();
afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
});

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
