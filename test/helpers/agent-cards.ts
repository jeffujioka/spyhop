// What the card tests share: workspace folders and harness session files in a temporary home
// folder (test/helpers/files.ts), and the cards built over it by the real read-only programs
// through the real runner.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAgentCards, type OrcaAgent } from '../../src/agent-cards.ts';
import { cardModel } from '../../src/core/card-model.js';
import { sessionDirSlug as ompSlug } from '../../src/core/providers/omp-sources.js';
import { run, type Run } from '../../src/exec.ts';
import { fixture } from './files.ts';

export const NOW = Date.parse('2026-11-25T12:00:00.000Z');

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

// An omp turn that logs `usd`, as a line of its session file.
export const costTurn = (usd: number) =>
  `${JSON.stringify({
    type: 'message',
    timestamp: '2026-11-25T11:59:00.000Z',
    message: { role: 'assistant', usage: { totalTokens: 100, cost: { total: usd } } },
  })}\n`;

// omp's session folder of the working folder `path`, under `home`.
export const ompSessionDir = (home: string, path: string) => join(home, '.omp/agent/sessions', ompSlug(path, home));

// The folder `path` under `home`, with an omp session of it, which records it as its folder,
// that has logged `usd`, titled `title` when given; returns the session file. Its id is `s1`.
export function ompSessionOf(home: string, path: string, usd = 0.1, title?: string) {
  mkdirSync(path, { recursive: true });
  const dir = ompSessionDir(home, path);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, '2026-11-25T11-58-00-000Z_s1.jsonl');
  const titleLine = title === undefined ? '' : `${JSON.stringify({ type: 'title', title })}\n`;
  const session = { type: 'session', version: 3, id: 's1', timestamp: '2026-11-25T11:58:00.000Z', cwd: path };
  writeFileSync(file, `${titleLine}${JSON.stringify(session)}\n${costTurn(usd)}`);
  return file;
}

// opencode's database under `home`, made from opencode/<name>.sql with the sqlite3 CLI; returns
// its path. basic.sql's sessions are of the folder /work/demo.
export function opencodeDatabase(home: string, name = 'basic') {
  const dir = join(home, '.local/share/opencode');
  mkdirSync(dir, { recursive: true });
  const database = join(dir, 'opencode.db');
  execFileSync('sh', ['-c', 'sqlite3 "$1" < "$2"', 'sh', database, fixture(`opencode/${name}.sql`)]);
  return database;
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

// A card builder over `home`, as the worker keeps one from refresh to refresh: each call is one
// refresh, which reuses what the earlier ones learned. `exec`: the runner the cards read
// through, the real one unless a test wraps it.
export function refreshing(home: string, exec: Run = run) {
  const cards = createAgentCards({ run: exec, home });
  return async (agents: OrcaAgent[]) => (await cards.build(agents, NOW)).map((card) => ({ card, model: cardModel(card, { home }) }));
}

// The cards of a first refresh.
export const cardsOf = (home: string, agents: OrcaAgent[], exec: Run = run) => refreshing(home, exec)(agents);

// The cost and the Tokens figure of a card's spend group, of a card model or a card the worker
// sends the panel.
type Figure = { label: string; value: string };
type Cardlike = { groups: ReadonlyArray<{ id: string; hero?: Figure | null; figures?: Figure[] }> };
const spendOf = (card: Cardlike) => card.groups.find((group) => group.id === 'spend');
export const costOf = (card: Cardlike) => spendOf(card)?.hero?.value;
export const tokensOf = (card: Cardlike) => spendOf(card)?.figures?.find((figure) => figure.label === 'Tokens')?.value;
