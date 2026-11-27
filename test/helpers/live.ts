// What the live panel's tests share: the fleet screen as the real worker's answer draws it, the
// live panel itself, and the harness files that answer is read from. `fleetOf` mounts the real
// worker on this computer's Orca host as the test kit plays it (test/helpers/orca-host.ts), under
// a temporary home, with `TZ` set to UTC and Node's mock clock at NOW; the stand-in `orca` lists
// no other Orca host. `openLive` opens the panel's controller (src/live/controller.ts) on such a
// worker, through the frame the tests play (test/helpers/frame.ts). The writers put omp and Claude
// Code session files, omp's model catalogue and its config under that home, read by the real
// read-only programs.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, mock } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { mountWorker, type MockHostOptions, type TestWorker } from 'orca/testing';
import { sessionDirSlug as claudeSlug } from '../../src/core/providers/claude-sources.js';
import { createLive, type Frame, type Live } from '../../src/live/controller.ts';
import { fleetScreen } from '../../src/live/fleet.ts';
import type { FleetAnswer } from '../../src/protocol.ts';
import * as workerModule from '../../src/worker.ts';
import { NOW, ompSessionDir } from './agent-cards.ts';
import { setEnv, useTempHome } from './env.ts';
import { frameOf } from './frame.ts';
import { orcaHost, type HostWorkspace } from './orca-host.ts';
import { standIns } from './stand-ins.ts';

// The model and the provider the omp sessions written here log, unless a test names others.
export const MODEL = 'claude-opus-5.5-1m';
const PROVIDER = 'anthropic';

let worker: TestWorker | undefined;
let live: Live | undefined;
afterEach(async () => {
  live?.close();
  live = undefined;
  await worker?.deactivate();
  worker = undefined;
  mock.timers.reset();
});

// The fleet the worker answers on this computer's Orca host with `workspaces`, and the fleet
// screen drawn from that whole answer. `prepare` runs first with the home, to put files under it;
// `now`: the mock clock's time, NOW when not given.
export async function fleetOf(
  workspaces: HostWorkspace[],
  { prepare, now = NOW }: { prepare?: (home: string) => void; now?: number } = {},
): Promise<{ answer: FleetAnswer; html: string }> {
  setEnv('TZ', 'UTC');
  mock.timers.enable({ apis: ['Date'], now });
  const home = useTempHome();
  prepare?.(home);
  standIns({ homes: {}, orca: {} });
  worker = await mountWorker(workerModule, { host: orcaHost(home, { workspaces }) });
  const answer = (await worker.request('spyhop.fleet', { request: 1 })) as FleetAnswer;
  return { answer, html: fleetScreen({ groups: answer.groups, whole: answer }) };
}

// The live panel opened on this computer's Orca host with `workspaces`, under a temporary home,
// with `TZ` set to UTC and Node's mock clock, of `setTimeout` and `Date`, at NOW: it asks again
// only when a test lets the clock pass. Returns once its first request has started, before it is
// answered. `homes`, `orca` and `held` go to the stand-ins (test/helpers/stand-ins.ts), so the
// stand-in `orca` lists no other Orca host unless `orca` gives its lists; `prepare` runs first
// with the home, to put files under it; `storage`: what the plugin's storage holds at first;
// `onDraw`: called with each drawing, as the page's own drawing is, so it may throw.
// `html()`: what the panel drew last; `requests(name)`: how many requests `name` it has started;
// `calls`: the stand-ins' calls.
export async function openLive(
  workspaces: HostWorkspace[],
  {
    homes = {},
    orca = {},
    held = [],
    prepare,
    storage,
    onDraw,
  }: {
    homes?: Record<string, string>;
    orca?: Record<string, string>;
    held?: string[];
    prepare?: (home: string) => void;
    storage?: MockHostOptions['storage'];
    onDraw?: (html: string) => void;
  } = {},
) {
  setEnv('TZ', 'UTC');
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  const home = useTempHome();
  prepare?.(home);
  const calls = standIns({ homes, orca, held });
  const host = orcaHost(home, { workspaces, storage });
  worker = await mountWorker(workerModule, { host });
  const frame = frameOf(worker);
  const started = new Map<string, number>();
  const request = ((name: string, ...args: unknown[]) => {
    started.set(name, (started.get(name) ?? 0) + 1);
    return (frame.plugin.request as (name: string, ...args: unknown[]) => Promise<unknown>)(name, ...args);
  }) as Frame['plugin']['request'];
  let drawn = '';
  live = createLive({ ...frame, plugin: { ...frame.plugin, request } }, (html) => {
    drawn = html;
    onDraw?.(html);
  });
  live.show(true);
  return { live, html: () => drawn, worker, host, frame, calls, requests: (name: string) => started.get(name) ?? 0 };
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
  mkdirSync(path, { recursive: true });
  const dir = ompSessionDir(home, path);
  mkdirSync(dir, { recursive: true });
  const call = (i: number, context?: number) => ({
    type: 'message',
    timestamp: new Date(NOW - 60_000 + i).toISOString(),
    message: {
      role: 'assistant',
      provider: PROVIDER,
      model,
      usage: { totalTokens: 100, cost: { total: i === 0 ? cost : 0 } },
      ...(context === undefined ? {} : { contextSnapshot: { promptTokens: context } }),
    },
  });
  const calls = contexts.length === 0 ? [call(0)] : contexts.map((context, i) => call(i, context));
  const lines = [{ type: 'title', title }, { type: 'session', version: 3, id: 's1', timestamp: '2026-11-25T11:58:00.000Z', cwd: path }, ...calls];
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
  const dir = join(home, '.claude/projects', claudeSlug(path));
  mkdirSync(dir, { recursive: true });
  const lines = contexts.map((context, i) => ({
    type: 'assistant',
    uuid: `a${i}`,
    sessionId: 'c1',
    isSidechain: false,
    cwd: path,
    timestamp: new Date(NOW - 60_000 + i).toISOString(),
    message: {
      id: `msg_${i}`,
      role: 'assistant',
      model: 'claude-opus-4-6',
      content: [{ type: 'text', text: '[text]' }],
      usage: { input_tokens: context, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 10 },
    },
  }));
  writeFileSync(join(dir, 'c1.jsonl'), lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
}
