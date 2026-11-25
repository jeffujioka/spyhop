// The files every test shares: the fixtures, and temporary folders removed after the file's
// tests.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
