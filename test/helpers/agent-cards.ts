// What the card tests share: a temporary home folder that holds the harnesses' session files,
// and the cards built over it by the real read-only programs through the real runner.
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { createAgentCards, type OrcaAgent } from '../../src/agent-cards.ts';
import { cardModel } from '../../src/core/card-model.js';
import { run } from '../../src/exec.ts';

export const NOW = Date.parse('2026-11-25T12:00:00.000Z');
export const fixture = (path: string) => new URL(`../fixtures/${path}`, import.meta.url).pathname;

const homes: string[] = [];
after(() => homes.forEach((home) => rmSync(home, { recursive: true, force: true })));

export function tempHome() {
  const home = mkdtempSync(join(tmpdir(), 'spyhop-home-'));
  homes.push(home);
  return home;
}

// A workspace folder under `home`, as Orca reports its path.
export function workspace(home: string, name: string) {
  const path = join(home, 'work', name);
  mkdirSync(path, { recursive: true });
  return path;
}

// Copies session fixtures into `dir`, each under the given file name.
export function sessions(dir: string, files: Record<string, string>) {
  mkdirSync(dir, { recursive: true });
  for (const [name, from] of Object.entries(files)) copyFileSync(fixture(from), join(dir, name));
}

export const agent = (fields: Partial<OrcaAgent>): OrcaAgent => ({
  id: 't1',
  agent: 'omp',
  state: 'working',
  title: null,
  sessionId: null,
  path: null,
  ...fields,
});

export async function cardsOf(home: string, agents: OrcaAgent[]) {
  const cards = await createAgentCards({ run, home }).build(agents, NOW);
  return cards.map((card) => ({ card, model: cardModel(card, { home }) }));
}
