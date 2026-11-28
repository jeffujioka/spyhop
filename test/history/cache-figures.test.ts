// The Cache tab's figures in the daily lines of the history store: the miss cause of each cold
// start, the returns after a turn end by their time away, and the compactions by kind, as the
// catch-up reads them from omp's, Claude Code's and opencode's sessions. The store, the runner and
// the programs are the real ones, under a temporary home, in UTC.
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { run, runBytes } from '../../src/exec.ts';
import { createCatchUp } from '../../src/history/catch-up.ts';
import { historyHosts, listHosts } from '../../src/hosts.ts';
import { openStore, type Store } from '../../src/history/store.ts';
import { expect } from '../core/helpers/expect.ts';
import { opencodeSession } from '../helpers/agent-cards.ts';
import { setEnv, useTempHome } from '../helpers/env.ts';
import { tempHome } from '../helpers/files.ts';
import { STARFISH_LISTS } from '../helpers/orca-answers.ts';
import { readOnlyLine } from '../helpers/read-only.ts';
import { standIns } from '../helpers/stand-ins.ts';
import { withCopilotPrices } from '../helpers/prices.ts';
import { claudeSession, type Compaction, ompCompactsAt, ompSession, ompWindow, type OmpCall } from '../helpers/live.ts';

let store: Store | undefined;
afterEach(() => {
  store?.close();
  store = undefined;
});

// Epoch ms of `time` (HH:MM, or HH:MM:SS) on the day of every session here, 2026-11-25 UTC.
const at = (time: string) => Date.parse(`2026-11-25T${time.length === 5 ? `${time}:00` : time}.000Z`);

const MINUTE = 60_000;

// A model call of 1,000 tokens written to the prompt cache at `time`, which read none: a cold
// start but for the first of a session.
const cold = (time: string, more: Partial<OmpCall> = {}): OmpCall => ({ at: at(time), read: 0, write: 1000, uncached: 10, output: 5, cost: 0.1, writeCost: 0.05, ...more });

// The figures of the daily lines of `store` summed over every day, repo and model, of the repos
// whose folder is one of `folders` when given (opencode's fixture database holds sessions of its
// own).
function sumsOf(opened: Store, folders: string[]) {
  const sums: Record<string, number> = {};
  for (const { repo, figures } of opened.dailyLines('2000-01-01', '2100-01-01')) if (folders.length === 0 || folders.some((folder) => repo.endsWith(`/${folder}`))) for (const [name, value] of Object.entries(figures)) sums[name] = (sums[name] ?? 0) + value;
  return sums;
}

// A catch-up, in UTC, of the home `write` fills with sessions, then `more` runs of it once `between`
// has changed the home; the sums of its daily lines (see `sumsOf`).
async function figuresOf(write: (home: string) => void, ...folders: string[]) {
  return figuresAfter(write, () => {}, 0, ...folders);
}

async function figuresAfter(write: (home: string) => void, between: (home: string) => void, more: number, ...folders: string[]) {
  setEnv('TZ', 'UTC');
  const home = useTempHome();
  write(home);
  store = await openStore(home);
  const catchUp = createCatchUp({ run, runBytes, store, home, log: () => {}, hosts: async () => [], aliasOf: async () => null });
  await catchUp.run();
  for (let i = 0; i < more; i++) {
    between(home);
    await catchUp.run();
  }
  return sumsOf(store, folders);
}

// The figures of `sums` named `names` that are not 0.
const nonZero = (sums: Record<string, number>, ...names: string[]) => Object.fromEntries(names.filter((name) => sums[name] !== 0).map((name) => [name, sums[name]]));

describe('miss causes', () => {
  test('Cache lifetime decides expiry', async () => {
    const sums = await figuresOf((home) => {
      ompSession(home, join(home, 'a'), { title: 'a', calls: [cold('10:00:10', { cttl: '5m' }), cold('10:20', { cttl: '5m' })] });
      ompSession(home, join(home, 'b'), { title: 'b', calls: [cold('10:00:10', { cttl: '1h' }), cold('10:20', { cttl: '1h' })] });
    });

    expect(nonZero(sums, 'coldExpired', 'coldOther', 'coldModel', 'coldThinking', 'coldCompaction')).toEqual({ coldExpired: 1, coldOther: 1 });
    // the tokens and the cost of the cache writes, by cause
    expect(nonZero(sums, 'coldTokensExpired', 'coldTokensOther', 'coldCostExpired', 'coldCostOther', 'coldUnpricedExpired', 'coldUnpricedOther')).toEqual({
      coldTokensExpired: 1000,
      coldTokensOther: 1000,
      coldCostExpired: 0.05,
      coldCostOther: 0.05,
    });
  });

  test('Model and thinking-level switches', async () => {
    const sums = await figuresOf((home) =>
      ompSession(home, join(home, 'api'), {
        title: 'api',
        calls: [
          cold('10:00', { model: 'model-a', thinking: 'high' }),
          cold('10:01', { model: 'model-b', thinking: 'high' }),
          cold('10:02', { model: 'model-b', thinking: 'low' }),
        ],
      }),
    );

    expect(nonZero(sums, 'coldExpired', 'coldOther', 'coldModel', 'coldThinking', 'coldCompaction')).toEqual({ coldModel: 1, coldThinking: 1 });
  });

  test('Compaction', async () => {
    const sums = await figuresOf((home) =>
      ompSession(home, join(home, 'api'), {
        title: 'api',
        calls: [cold('10:00'), cold('10:01')],
        compactions: [{ at: at('10:00:30'), before: 300_000, after: 20_000 }],
      }),
    );

    expect(nonZero(sums, 'coldExpired', 'coldOther', 'coldModel', 'coldThinking', 'coldCompaction')).toEqual({ coldCompaction: 1 });
  });

  test('First cause that holds', async () => {
    const sums = await figuresOf((home) =>
      ompSession(home, join(home, 'api'), { title: 'api', calls: [cold('10:00', { model: 'model-a', cttl: '5m' }), cold('10:10', { model: 'model-b' })] }),
    );

    expect(nonZero(sums, 'coldExpired', 'coldOther', 'coldModel', 'coldThinking', 'coldCompaction')).toEqual({ coldExpired: 1 });
  });

  test('opencode cold start after a long gap', async () => {
    const sums = await figuresOf((home) =>
      opencodeSession(home, join(home, 'web'), {
        provider: 'anthropic',
        model: 'claude-opus-5.5',
        cost: 0.2,
        calls: [
          { uncached: 10, read: 0, write: 1000, output: 5, at: at('10:00') },
          { uncached: 10, read: 0, write: 1000, output: 5, at: at('12:00') },
        ],
      }),
      'web',
    );

    expect(nonZero(sums, 'coldExpired', 'coldOther', 'coldModel', 'coldThinking', 'coldCompaction')).toEqual({ coldOther: 1 });
  });
});

describe('Claude Code', () => {
  test('cache split and effort decide the cause, and no write cost is logged', async () => {
    const call = (time: string, more: object) => ({ at: at(time), uncached: 10, write: 1000, output: 5, ...more });
    const sums = await figuresOf((home) =>
      claudeSession(home, join(home, 'cc'), { calls: [call('10:00', { cache: '5m', effort: 'high' }), call('10:10', { effort: 'high' }), call('10:11', { effort: 'low' })] }),
    );

    expect(nonZero(sums, 'coldExpired', 'coldOther', 'coldModel', 'coldThinking', 'coldCompaction')).toEqual({ coldExpired: 1, coldThinking: 1 });
    expect(nonZero(sums, 'coldUnpricedExpired', 'coldUnpricedThinking', 'coldCostExpired', 'coldCostThinking')).toEqual({ coldUnpricedExpired: 1, coldUnpricedThinking: 1 });
  });
});

describe('returns and compactions', () => {
  test('Returns by time away', async () => {
    const sums = await figuresOf((home) =>
      ompSession(home, join(home, 'api'), {
        title: 'api',
        calls: [
          cold('10:00', { stop: 'stop' }),
          // 2 minutes away, the next call read from the cache
          cold('10:02', { prompted: at('10:01:59'), read: 900, stop: 'stop' }),
          // 20 minutes, cold
          cold('10:22', { prompted: at('10:21:59'), stop: 'stop' }),
          // 40 minutes, read
          cold('11:02', { prompted: at('11:01:59'), read: 900, stop: 'stop' }),
          // 3 hours, cold
          cold('14:02', { prompted: at('14:01:59'), stop: 'stop' }),
        ],
      }),
    );

    expect(nonZero(sums, 'returnsUnder5', 'returnsColdUnder5', 'returnsTo60', 'returnsColdTo60', 'returnsOver60', 'returnsColdOver60')).toEqual({
      returnsUnder5: 1,
      returnsTo60: 2,
      returnsColdTo60: 1,
      returnsOver60: 1,
      returnsColdOver60: 1,
    });
  });

  test('omp compactions inferred', async () => {
    const compactions: Compaction[] = [
      { at: at('10:00:30'), before: 820_000, after: 20_000 },
      { at: at('10:30'), before: 300_000, after: 20_000 },
      { at: at('10:31'), before: 300_000, after: 20_000 },
    ];
    const sums = await figuresOf((home) => {
      ompWindow(home, 1_000_000);
      // omp compacts on its own at 800,000 tokens
      ompCompactsAt(home, 800_000);
      ompSession(home, join(home, 'api'), { title: 'api', calls: [cold('10:00'), cold('10:18', { read: 100 }), cold('10:30:30', { read: 100 })], compactions });
    });

    expect(nonZero(sums, 'compactionsFull', 'compactionsIdle', 'compactionsManual', 'compactionsInferred')).toEqual({ compactionsFull: 1, compactionsIdle: 1, compactionsManual: 1, compactionsInferred: 3 });
  });

  test('Claude Code and opencode compactions', async () => {
    const sums = await figuresOf((home) => {
      claudeSession(home, join(home, 'cc'), {
        calls: [
          { at: at('10:00'), uncached: 10, output: 5 },
          { at: at('10:10'), uncached: 10, output: 5 },
        ],
        compactions: [
          { at: at('10:01'), trigger: 'auto', before: 150_000, after: 10_000 },
          { at: at('10:05'), trigger: 'manual', before: 150_000, after: 10_000 },
        ],
      });
      opencodeSession(home, join(home, 'web'), {
        provider: 'anthropic',
        model: 'claude-opus-5.5',
        cost: 0.2,
        calls: [{ uncached: 10, read: 0, write: 1000, output: 5, at: at('10:00') }],
        compactions: [{ at: at('10:30'), reason: 'manual' }],
      });
    }, 'cc', 'web');

    expect(nonZero(sums, 'compactionsFull', 'compactionsIdle', 'compactionsManual', 'compactionsInferred')).toEqual({ compactionsFull: 1, compactionsManual: 2 });
  });
});

const DAY = 24 * 60 * MINUTE;
const ago = (days: number) => Date.now() - days * DAY;
const WRITE = { uncached: 10, read: 0, write: 1000, output: 5 };

describe('opencode spans', () => {
  // a session of two calls and a compaction and a prompt between them, whose first read splits at
  // the 30 days of the first phase
  const session = (home: string) =>
    opencodeSession(home, join(home, 'web'), {
      provider: 'anthropic',
      model: 'claude-opus-5.5',
      cost: 0.2,
      calls: [
        { ...WRITE, at: ago(40) },
        { ...WRITE, at: ago(20), prompted: ago(31) },
      ],
      compactions: [{ at: ago(35), reason: 'manual' }],
    });
  const figures = ['coldOther', 'coldCompaction', 'compactionsManual', 'returnsOver60', 'returnsColdOver60'];

  test('a first read split between the phases counts what one span does', async () => {
    const sums = await figuresOf(session, 'web');

    expect(nonZero(sums, ...figures)).toEqual({ coldCompaction: 1, compactionsManual: 1, returnsOver60: 1, returnsColdOver60: 1 });
  });

  test('the days a later catch-up reads again keep their cold start', async () => {
    const sums = await figuresAfter(
      (home) =>
        opencodeSession(home, join(home, 'web'), {
          provider: 'anthropic',
          model: 'claude-opus-5.5',
          cost: 0.2,
          calls: [
            { ...WRITE, at: ago(15) },
            { ...WRITE, at: ago(5) },
          ],
        }),
      () => {},
      1,
      'web',
    );

    expect(nonZero(sums, 'coldOther', 'coldExpired')).toEqual({ coldOther: 1 });
  });

  test('a Copilot cold start is priced from the price table, and a reason `auto` is a full context', async () => {
    withCopilotPrices({ 'claude-opus-5.5': { input: 500, cachedInput: 50, cacheWrite: 625, output: 2500, tiers: [] } });
    const sums = await figuresOf(
      (home) =>
        opencodeSession(home, join(home, 'web'), {
          provider: 'github-copilot',
          model: 'claude-opus-5.5',
          cost: 0.2,
          calls: [
            { ...WRITE, at: ago(3) },
            { ...WRITE, uncached: 0, write: 160_000, output: 0, at: ago(2) },
          ],
          compactions: [{ at: ago(2.5), reason: 'auto' }],
        }),
      'web',
    );

    expect(sums.coldCostCompaction).toBeCloseTo(1, 9);
    expect(nonZero(sums, 'coldUnpricedCompaction', 'compactionsFull', 'compactionsManual')).toEqual({ compactionsFull: 1 });
  });
});

describe('what the catch-up cannot know', () => {
  test('a compaction of omp without its config or catalogue is idle or manual, never full', async () => {
    const sums = await figuresOf((home) =>
      ompSession(home, join(home, 'api'), { title: 'api', calls: [cold('10:00'), cold('10:30', { read: 1 })], compactions: [{ at: at('10:20'), before: 900_000, after: 20_000 }] }),
    );

    expect(nonZero(sums, 'compactionsFull', 'compactionsIdle', 'compactionsManual', 'compactionsInferred')).toEqual({ compactionsIdle: 1, compactionsInferred: 1 });
  });

  test('omp config and catalogue are read again by each catch-up', async () => {
    const sums = await figuresAfter(
      (home) => ompSession(home, join(home, 'first'), { title: 'first', calls: [cold('10:00'), cold('10:01', { read: 1 })], compactions: [{ at: at('10:00:30'), before: 820_000, after: 20_000 }] }),
      (home) => {
        ompWindow(home, 1_000_000);
        ompCompactsAt(home, 800_000);
        ompSession(home, join(home, 'second'), { title: 'second', calls: [cold('10:00'), cold('10:01', { read: 1 })], compactions: [{ at: at('10:00:30'), before: 820_000, after: 20_000 }] });
      },
      1,
    );

    expect(nonZero(sums, 'compactionsFull', 'compactionsManual')).toEqual({ compactionsFull: 1, compactionsManual: 1 });
  });

  test('a compaction of an unknown Claude Code trigger is inferred', async () => {
    const sums = await figuresOf((home) =>
      claudeSession(home, join(home, 'cc'), {
        calls: [
          { at: at('10:00'), uncached: 10, output: 5 },
          { at: at('10:02'), uncached: 10, output: 5 },
        ],
        compactions: [{ at: at('10:01'), trigger: 'overflow', before: 150_000, after: 10_000 }],
      }),
    );

    expect(nonZero(sums, 'compactionsFull', 'compactionsIdle', 'compactionsManual', 'compactionsInferred')).toEqual({ compactionsManual: 1, compactionsInferred: 1 });
  });

  test('a cold start of omp that logs no cache write cost is unpriced', async () => {
    const sums = await figuresOf((home) => ompSession(home, join(home, 'api'), { title: 'api', calls: [cold('10:00'), cold('10:01', { writeCost: undefined })] }));

    expect(nonZero(sums, 'coldUnpricedOther', 'coldCostOther')).toEqual({ coldUnpricedOther: 1 });
  });
});

describe('another Orca host', () => {
  test('omp config and catalogue are read on the host, by read-only commands', async () => {
    setEnv('TZ', 'UTC');
    const remoteHome = tempHome();
    ompWindow(remoteHome, 1_000_000);
    ompCompactsAt(remoteHome, 800_000);
    ompSession(remoteHome, join(remoteHome, 'api'), { title: 'api', calls: [cold('10:00'), cold('10:01', { read: 1 })], compactions: [{ at: at('10:00:30'), before: 820_000, after: 20_000 }] });
    const home = useTempHome();
    const calls = standIns({ homes: { 'starfish-bs': remoteHome }, orca: STARFISH_LISTS });
    store = await openStore(home);
    await createCatchUp({ run, runBytes, store, home, log: () => {}, hosts: async () => historyHosts(await listHosts(run)), aliasOf: async () => null }).run();

    expect(nonZero(sumsOf(store, []), 'compactionsFull', 'compactionsManual')).toEqual({ compactionsFull: 1 });
    expect(calls.ssh().filter((args) => args[0] !== 'starfish-bs' || !readOnlyLine(args.at(-1)!))).toEqual([]);
  });
});
