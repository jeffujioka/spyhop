// What the card tests share: workspace folders and harness session files in a temporary home
// folder (test/helpers/files.ts), and the cards built over it by the real read-only programs
// through the real runner.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type BuiltCard, createAgentCards, type OrcaAgent } from '../../src/agent-cards.ts';
import { cardView } from '../../src/card-view.ts';
import { formatCost, formatTokens, orNa } from '../../src/core/format.js';
import { sessionDirSlug as ompSlug } from '../../src/core/providers/omp-sources.js';
import { TAIL_BYTES } from '../../src/core/refresh.js';
import { run, type Run } from '../../src/exec.ts';
import type { CardView } from '../../src/protocol.ts';
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

// A sub-agent transcript of the omp session file `sessionFile`: `name` is its path in the folder
// beside the session file, without `.jsonl` (`Impl1`, or `Impl1/Rev1` for a sub-agent that
// `Impl1` started), and `lines` its lines, each ending in a newline. Returns the transcript's
// path.
export function subAgentFile(sessionFile: string, name: string, lines: string[]) {
  const file = join(sessionFile.replace(/\.jsonl$/, ''), `${name}.jsonl`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, lines.join(''));
  return file;
}

// Lines no figure reads, longer together than the window a refresh reads from a file's end.
export const PADDING = `${JSON.stringify({ type: 'custom', note: 'x'.repeat(2000) })}\n`.repeat(Math.ceil((TAIL_BYTES * 1.5) / 2000));

// opencode's database under `home`, made from opencode/<name>.sql with the sqlite3 CLI; returns
// its path. basic.sql's sessions are of the folder /work/demo.
export function opencodeDatabase(home: string, name = 'basic') {
  const dir = join(home, '.local/share/opencode');
  mkdirSync(dir, { recursive: true });
  const database = join(dir, 'opencode.db');
  execFileSync('sh', ['-c', 'sqlite3 "$1" < "$2"', 'sh', database, fixture(`opencode/${name}.sql`)]);
  return database;
}

// The model calls of an opencode session: those of `model` of the provider `provider`, one per
// context.
export type OpencodeCalls = { provider: string; model: string; contexts: number[] };

// The session `ses_window` of the folder `folder` in opencode's database under `home` (made from
// current.sql), in the current tables: one model call of `model` of the provider `provider` per
// context of `contexts` (each the prompt's tokens, read from the cache but for 100 sent fresh),
// at 0.10 USD each, and opencode's own total of 0.40 USD; returns the database's path.
export function opencodeCalls(home: string, folder: string, { provider, model, contexts }: OpencodeCalls) {
  const at = (i: number) => NOW - 60_000 * (contexts.length - i);
  const rows = contexts.map((context, i) => {
    const data = {
      time: { created: at(i), completed: at(i) + 1000 },
      agent: 'build',
      model: { id: model, providerID: provider, variant: 'high' },
      content: [],
      finish: 'stop',
      cost: 0.1,
      tokens: { input: 100, output: 50, reasoning: 0, cache: { read: context - 100, write: 0 } },
    };
    return `INSERT INTO session_message VALUES ('w${i}', 'ses_window', 'assistant', ${i + 1}, ${at(i)}, ${at(i) + 1000}, ${sqlText(JSON.stringify(data))});`;
  });
  const session = `INSERT INTO session_v2 VALUES ('ses_window', 'prj', NULL, 's', ${sqlText(folder)}, 't', '2.0.0', 0.40, NULL, NULL, ${at(0)}, ${at(contexts.length - 1) + 1000}, NULL);`;
  const database = opencodeDatabase(home, 'current');
  execFileSync('sqlite3', [database, [session, ...rows].join('\n')]);
  return database;
}

// `text` as an SQL string literal.
export const sqlText = (text: string) => `'${text.replaceAll("'", "''")}'`;

// opencode's model catalogue under `home`: test/fixtures/opencode/models.json, which holds a
// `limit.context` of 200,000 for `github-copilot`'s `claude-haiku-5.5`.
export function opencodeCatalogue(home: string) {
  const dir = join(home, '.cache/opencode');
  mkdirSync(dir, { recursive: true });
  copyFileSync(fixture('opencode/models.json'), join(dir, 'models.json'));
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
  return async (agents: OrcaAgent[]) =>
    (await cards.build(agents, NOW)).map((card) => ({ card, view: cardView(card, { home, pane: null, now: NOW }) }));
}

// The cards of a first refresh.
export const cardsOf = (home: string, agents: OrcaAgent[], exec: Run = run) => refreshing(home, exec)(agents);

// The cost of a card's view, and the tokens of a built card, as the panel writes them.
export const costOf = (view: CardView): string => formatCost(view.cost);
export const tokensOf = (card: BuiltCard): string => orNa(card.stats.totalTokens, formatTokens);
