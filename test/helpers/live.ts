// What the live panel's tests share: the fleet screen as the real worker's answer draws it, the
// session answer of one card and the session screen drawn from it, the live panel itself, and the
// harness files those answers are read from. `fleetOf` and `sessionOf` mount the real worker on
// this computer's Orca host as the test kit plays it (test/helpers/orca-host.ts), under a temporary
// home, with `TZ` set to UTC and Node's mock clock at NOW; the stand-in `orca` lists no other Orca
// host unless a test gives its lists. `openLive` opens the panel's controller
// (src/live/controller.ts) on such a worker, through the frame the tests play
// (test/helpers/frame.ts); `openOnFleet` waits for its fleet, and `open` opens a session's screen
// from it; `FIX` is the workspace the screen tests open it on, and `folderOf` the folder of a
// workspace's session. The writers put omp and Claude Code session files, omp's model catalogue
// and its config under that home, read by the real read-only programs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mock } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { mountWorker, type MockHostOptions, type TestWorker } from 'orca/testing';
import { sessionDirSlug as claudeSlug } from '../../src/core/providers/claude-sources.js';
import { createLive, type Drawing, type Frame, type Live } from '../../src/live/controller.ts';
import { fleetScreen } from '../../src/live/fleet.ts';
import { sessionScreen } from '../../src/live/session.ts';
import type { CardView, FleetAnswer, SessionAnswer } from '../../src/protocol.ts';
import * as workerModule from '../../src/worker.ts';
import { NOW, ompSessionDir, workspace } from './agent-cards.ts';
import { atTestEnd, setEnv, useTempHome } from './env.ts';
import { frameOf } from './frame.ts';
import { attr, parts, text } from './markup.ts';
import { orcaHost, type HostWorkspace } from './orca-host.ts';
import { standIns } from './stand-ins.ts';

// The model and the provider the omp sessions written here log, unless a test names others.
export const MODEL = 'claude-opus-5.5-1m';
const PROVIDER = 'anthropic';

let worker: TestWorker | undefined;
let live: Live | undefined;
// how many requests the panel `openLive` opened has sent that have not settled
let out = 0;
// The panel is closed, so that it sends no more; a test ends only once what it sent has settled,
// and before its environment is set back (test/helpers/env.ts), since the worker goes on building
// an answer, starting programs, after the panel is gone.
atTestEnd(async () => {
  live?.close();
  live = undefined;
  try {
    await until(() => out === 0);
  } finally {
    await worker?.deactivate();
    worker = undefined;
    mock.timers.reset();
  }
});

// What a test may give `fleetOf` and `sessionOf`: `prepare` runs first with the home, to put files
// under it; `now`: the mock clock's time, NOW when not given; `homes` and `orca` go to the
// stand-ins (test/helpers/stand-ins.ts), so that a test may list and reach another Orca host.
type Mounting = { prepare?: (home: string) => void; now?: number; homes?: Record<string, string>; orca?: Record<string, string> };

// The real worker mounted on this computer's Orca host with `workspaces`, and its fleet answer.
async function mountedFleet(workspaces: HostWorkspace[], { prepare, now = NOW, homes = {}, orca = {} }: Mounting) {
  setEnv('TZ', 'UTC');
  mock.timers.enable({ apis: ['Date'], now });
  const home = useTempHome();
  prepare?.(home);
  standIns({ homes, orca });
  worker = await mountWorker(workerModule, { host: orcaHost(home, { workspaces }) });
  return { mounted: worker, fleet: (await worker.request('spyhop.fleet', { request: 1 })) as FleetAnswer };
}

// The fleet the worker answers on this computer's Orca host with `workspaces`, and the fleet
// screen drawn from that whole answer.
export async function fleetOf(workspaces: HostWorkspace[], mounting: Mounting = {}): Promise<{ answer: FleetAnswer; html: string }> {
  const { fleet: answer } = await mountedFleet(workspaces, mounting);
  return { answer, html: fleetScreen({ groups: answer.groups, whole: answer }) };
}

// The worker's session answer (request 2) for the card `card` picks from the cards of the fleet
// it answered first (request 1), its first card when not given; that fleet answer; and the
// session screen drawn from the answer, with the fleet's card.
export async function sessionOf(
  workspaces: HostWorkspace[],
  { card = (cards) => cards[0].id, ...mounting }: Mounting & { card?: (cards: CardView[]) => string } = {},
): Promise<{ answer: SessionAnswer; fleet: FleetAnswer; html: string }> {
  const { mounted, fleet } = await mountedFleet(workspaces, mounting);
  const cards = fleet.groups.flatMap((group) => group.cards);
  const id = card(cards);
  const answer = (await mounted.request('spyhop.session', { request: 2, card: id })) as SessionAnswer;
  return { answer, fleet, html: sessionScreen(answer.session, { card: cards.find((found) => found.id === id) ?? null, showAll: false }) };
}

// What a test may give `openLive` and `openOnFleet`.
type LiveOptions = {
  homes?: Record<string, string>;
  orca?: Record<string, string>;
  held?: string[];
  prepare?: (home: string) => void;
  storage?: MockHostOptions['storage'];
  onDraw?: (html: string, drawing: Drawing) => void;
};

// The live panel opened on this computer's Orca host with `workspaces`, under a temporary home,
// with `TZ` set to UTC and Node's mock clock, of `setTimeout` and `Date`, at NOW: it asks again
// only when a test lets the clock pass. Returns once its first request has started, before it is
// answered. `homes`, `orca` and `held` go to the stand-ins (test/helpers/stand-ins.ts), so the
// stand-in `orca` lists no other Orca host unless `orca` gives its lists; `prepare` runs first
// with the home, to put files under it; `storage`: what the plugin's storage holds at first;
// `onDraw`: called with each drawing and whether it is of the screen drawn before it, as the
// page's own drawing is, so it may throw.
// `html()`: what the panel drew last; `requests(name)`: how many requests `name` it has started;
// `settled(name)`: how many of them were answered or failed, counted before the panel takes the
// answer, so that the panel has taken it by the next turn of the event loop; `calls`: the
// stand-ins' calls.
export async function openLive(workspaces: HostWorkspace[], { homes = {}, orca = {}, held = [], prepare, storage, onDraw }: LiveOptions = {}) {
  setEnv('TZ', 'UTC');
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  const home = useTempHome();
  prepare?.(home);
  const calls = standIns({ homes, orca, held });
  const host = orcaHost(home, { workspaces, storage });
  worker = await mountWorker(workerModule, { host });
  const frame = frameOf(worker);
  const started = new Map<string, number>();
  const ended = new Map<string, number>();
  const request = ((name: string, ...args: unknown[]) => {
    started.set(name, (started.get(name) ?? 0) + 1);
    out += 1;
    return (frame.plugin.request as (name: string, ...args: unknown[]) => Promise<unknown>)(name, ...args).finally(() => {
      out -= 1;
      ended.set(name, (ended.get(name) ?? 0) + 1);
    });
  }) as Frame['plugin']['request'];
  let drawn = '';
  live = createLive({ ...frame, plugin: { ...frame.plugin, request } }, (html, drawing) => {
    drawn = html;
    onDraw?.(html, drawing);
  });
  live.show(true);
  return {
    live,
    html: () => drawn,
    worker,
    host,
    frame,
    calls,
    requests: (name: string) => started.get(name) ?? 0,
    settled: (name: string) => ended.get(name) ?? 0,
  };
}

// The panel `openLive` opens with `options`, once it has drawn the fleet's whole answer;
// `draws()`: how many times it has drawn.
export async function openOnFleet(workspaces: HostWorkspace[], options: LiveOptions = {}) {
  let drawn = 0;
  const opened = await openLive(workspaces, {
    ...options,
    onDraw: (html, drawing) => {
      drawn += 1;
      options.onDraw?.(html, drawing);
    },
  });
  await until(() => opened.html().includes('data-part="counts"'));
  return { ...opened, draws: () => drawn };
}

// This computer's workspace `api`/`main`, with one working omp agent titled `π - Fix the login bug`.
export const FIX: HostWorkspace = { project: 'api', name: 'main', agents: ['working'], title: 'π - Fix the login bug' };

// The folder of the session of `ws`'s agent under `home`.
export const folderOf = (home: string, { project, name }: HostWorkspace) => join(workspace(home, `${project}-${name}`), 'session');

// The title of each session `html` draws: the session screen's header, or the fleet's cards and
// folded lines.
export const titles = (html: string) => parts(html, 'class', 'title grow').map(text);

// The `data-press` value of the card or folded line titled `title` on the fleet screen `html`.
export function pressOf(html: string, title: string) {
  const found = [...parts(html, 'data-part', 'card'), ...parts(html, 'data-part', 'folded')].find((part) => titles(part)[0] === title);
  assert.ok(found, `no card of ${title}: ${html}`);
  return attr(found, 'data-press')!;
}

// Presses the card or folded line titled `title` of the drawn fleet, which draws its session's
// screen at once, and waits for its session's answer.
export async function open({ live, html }: { live: Live; html: () => string }, title: string) {
  live.press(pressOf(html(), title));
  assert.equal(attr(html(), 'data-screen'), 'session');
  await until(() => parts(html(), 'data-part', 'loading').length === 0);
}

// Resolves once `seen()` holds, asked again at each turn of the event loop, so after what the
// last turn started has run; rejects when it does not within 5 s of real time.
export async function until(seen: () => boolean) {
  const end = performance.now() + 5000;
  while (!seen()) {
    if (performance.now() > end) throw new Error(`not seen within 5 s: ${seen}`);
    await setImmediate();
  }
}

// The folder `path`, with an omp session of it titled `title`, which records it as its folder and
// logs one model call per context of `contexts` (each the prompt's tokens), of `model`, the first
// call costing `cost`, the others nothing; with no context, one call that logs no context.
export function ompCalls(home: string, path: string, { title, contexts, cost = 0.1, model = MODEL }: { title: string; contexts: number[]; cost?: number; model?: string }) {
  const call = (i: number, context?: number): OmpCall => ({ at: NOW - 60_000 + i, output: 100, cost: i === 0 ? cost : 0, context });
  ompSession(home, path, { title, model, calls: contexts.length === 0 ? [call(0)] : contexts.map((context, i) => call(i, context)) });
}

// One model call of an omp session, at `at` (epoch ms): the prompt tokens it read from the cache,
// wrote to it and sent uncached, its output tokens, its cost and the cost of its cache write
// (USD), its premium requests, and the context after it; each one not given is not logged.
// `prompted`: the time of the user message the call answers, none when not given; `tools`: the
// tool calls it makes, each answered right after it.
export type OmpCall = {
  at: number;
  read?: number;
  write?: number;
  uncached?: number;
  output?: number;
  cost?: number;
  writeCost?: number;
  premium?: number;
  context?: number;
  prompted?: number;
  tools?: ToolCall[];
};
// A tool call of the tool `name`, whose result says it failed when `failed`.
export type ToolCall = { name: string; failed?: boolean };
// A compaction at `at` (epoch ms) from `before` tokens of context to `after`.
export type Compaction = { at: number; before: number; after: number };

// The `count` calls of the tool `name`, of which the first `failed` failed.
export const toolCalls = (name: string, count: number, failed = 0): ToolCall[] => Array.from({ length: count }, (_, i) => ({ name, failed: i < failed }));

// The folder `path`, with an omp session of it titled `title`, which records it as its folder and
// logs `calls` of `model` and `compactions`, in the order of their times; `thinking`: the
// thinking level it was set to at its start, none when not given.
export function ompSession(
  home: string,
  path: string,
  { title, calls, compactions = [], model = MODEL, thinking }: { title: string; calls: OmpCall[]; compactions?: Compaction[]; model?: string; thinking?: string },
) {
  mkdirSync(path, { recursive: true });
  const dir = ompSessionDir(home, path);
  mkdirSync(dir, { recursive: true });
  const timestamp = (at: number) => new Date(at).toISOString();
  const message = ({ at, read, write, uncached, output, cost, writeCost, premium, context, tools = [] }: OmpCall, i: number) => {
    const tokens = { input: uncached, cacheRead: read, cacheWrite: write, output };
    const usage = {
      ...Object.fromEntries(Object.entries(tokens).filter(([, value]) => value !== undefined)),
      totalTokens: Object.values(tokens).reduce<number>((sum, value) => sum + (value ?? 0), 0),
      ...(cost === undefined ? {} : { cost: { total: cost, ...(writeCost === undefined ? {} : { cacheWrite: writeCost }) } }),
      ...(premium === undefined ? {} : { premiumRequests: premium }),
    };
    const id = (j: number) => `call-${i}-${j}`;
    const content = tools.map(({ name }, j) => ({ type: 'toolCall', id: id(j), name }));
    const results = tools.map(({ failed = false }, j) => ({ type: 'message', timestamp: timestamp(at), message: { role: 'toolResult', toolCallId: id(j), isError: failed } }));
    return {
      at,
      lines: [
        {
          type: 'message',
          timestamp: timestamp(at),
          message: { role: 'assistant', provider: PROVIDER, model, usage, content, ...(context === undefined ? {} : { contextSnapshot: { promptTokens: context } }) },
        },
        ...results,
      ],
    };
  };
  const prompts = calls.flatMap(({ prompted }) => (prompted === undefined ? [] : [{ at: prompted, lines: [{ type: 'message', timestamp: timestamp(prompted), message: { role: 'user', content: '[text]' } }] }]));
  const compaction = ({ at, before, after }: Compaction) => ({ at, lines: [{ type: 'compaction', timestamp: timestamp(at), tokensBefore: before, tokensAfter: after }] });
  const entries = [...calls.map(message), ...prompts, ...compactions.map(compaction)].sort((a, b) => a.at - b.at).flatMap(({ lines }) => lines);
  const start = '2026-11-25T11:58:00.000Z';
  const level = thinking === undefined ? [] : [{ type: 'thinking_level_change', timestamp: start, thinkingLevel: thinking }];
  const lines = [{ type: 'title', title }, { type: 'session', version: 3, id: 's1', timestamp: start, cwd: path }, ...level, ...entries];
  writeFileSync(join(dir, '2026-11-25T11-58-00-000Z_s1.jsonl'), lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
}

// omp's model catalogue under `home`, with `window` tokens as the window of `model`.
export function ompWindow(home: string, window: number, model = MODEL) {
  const dir = join(home, '.omp/agent');
  mkdirSync(dir, { recursive: true });
  const models = JSON.stringify([{ id: model, contextWindow: window }]).replaceAll("'", "''");
  const sql = `CREATE TABLE model_cache (provider_id TEXT, models TEXT, updated_at INTEGER); INSERT INTO model_cache VALUES ('${PROVIDER}:default', '${models}', 1);`;
  execFileSync('sqlite3', [join(dir, 'models.db'), sql]);
}

// omp's config under `home`, which leaves autocompaction on with omp's defaults: on a window of
// 1,000,000 tokens, omp compacts at 850,000. Without it the point is not known.
export function ompAutocompacts(home: string) {
  const dir = join(home, '.omp/agent');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.yml'), 'compaction:\n  enabled: true\n');
}

// A Claude Code session of the folder `path`, which it records, with one model call per context
// of `contexts` (each the prompt's input tokens, with no cache).
export function claudeCalls(home: string, path: string, contexts: number[]) {
  claudeSession(home, path, { calls: contexts.map((context, i) => ({ at: NOW - 60_000 + i, uncached: context, output: 10 })) });
}

// One model call of a Claude Code session, at `at` (epoch ms): the prompt tokens it read from the
// cache, wrote to it and sent uncached, and its output tokens, 0 for each one not given; `tools`:
// the tool uses it makes, each answered right after it.
export type ClaudeCall = { at: number; read?: number; write?: number; uncached?: number; output?: number; tools?: ToolCall[] };

// A Claude Code session of the folder `path`, which it records, with `calls` and `compactions`
// (automatic ones), in the order of their times.
export function claudeSession(home: string, path: string, { calls, compactions = [] }: { calls: ClaudeCall[]; compactions?: Compaction[] }) {
  const dir = join(home, '.claude/projects', claudeSlug(path));
  mkdirSync(dir, { recursive: true });
  const entry = (at: number) => ({ sessionId: 'c1', isSidechain: false, cwd: path, timestamp: new Date(at).toISOString() });
  const response = ({ at, read = 0, write = 0, uncached = 0, output = 0, tools = [] }: ClaudeCall, i: number) => {
    const id = (j: number) => `toolu_${i}_${j}`;
    const uses = tools.map(({ name }, j) => ({ type: 'tool_use', id: id(j), name, input: {} }));
    const results = tools.map(({ failed = false }, j) => ({ type: 'tool_result', tool_use_id: id(j), is_error: failed, content: '[text]' }));
    return {
      at,
      lines: [
        {
          type: 'assistant',
          uuid: `a${i}`,
          ...entry(at),
          message: {
            id: `msg_${i}`,
            role: 'assistant',
            model: 'claude-opus-4-6',
            content: [{ type: 'text', text: '[text]' }, ...uses],
            usage: { input_tokens: uncached, cache_creation_input_tokens: write, cache_read_input_tokens: read, output_tokens: output },
          },
        },
        ...(results.length === 0 ? [] : [{ type: 'user', uuid: `u${i}`, ...entry(at), message: { role: 'user', content: results } }]),
      ],
    };
  };
  const boundary = ({ at, before, after }: Compaction) => ({
    at,
    lines: [{ type: 'system', subtype: 'compact_boundary', ...entry(at), compactMetadata: { trigger: 'auto', preTokens: before, postTokens: after } }],
  });
  const entries = [...calls.map(response), ...compactions.map(boundary)].sort((a, b) => a.at - b.at).flatMap(({ lines }) => lines);
  writeFileSync(join(dir, 'c1.jsonl'), entries.map((line) => `${JSON.stringify(line)}\n`).join(''));
}
