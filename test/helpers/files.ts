// The files every test shares: the fixtures, temporary folders removed after the file's tests,
// and the wait for a change in a folder.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { watch } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

export const fixture = (path: string) => new URL(`../fixtures/${path}`, import.meta.url).pathname;
export const fixtureText = (path: string) => readFileSync(fixture(path), 'utf8');

const folders: string[] = [];
after(() => folders.forEach((folder) => rmSync(folder, { recursive: true, force: true })));

// A new empty temporary folder, a home folder or any other, removed after the file's tests.
export function tempHome() {
  const folder = mkdtempSync(join(tmpdir(), 'spyhop-'));
  folders.push(folder);
  return folder;
}

// Resolves once `seen()` holds, asked again at each change in `folder`; rejects when it does not
// within 5 s.
export async function seenIn(folder: string, seen: () => boolean) {
  const changes = watch(folder, { signal: AbortSignal.timeout(5000) });
  try {
    while (!seen()) await changes.next();
  } finally {
    await changes.return();
  }
}
