// The Cache tab's figures in the daily lines of the history store: the miss cause of each cold
// start, the returns after a turn end by their time away, and the compactions by kind, as the
// catch-up reads them from omp's, Claude Code's and opencode's sessions. The store, the runner and
// the programs are the real ones, under a temporary home, in UTC.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { run, runBytes } from '../../src/exec.ts';
import { createCatchUp } from '../../src/history/catch-up.ts';
import { openStore, type Store } from '../../src/history/store.ts';
import { expect } from '../core/helpers/expect.ts';
import { opencodeSession } from '../helpers/agent-cards.ts';
import { setEnv, useTempHome } from '../helpers/env.ts';
import { claudeSession, type Compaction, ompSession, ompWindow, type OmpCall } from '../helpers/live.ts';

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

// A catch-up, in UTC, of the home `write` fills with sessions; the figures of its daily lines
// summed over every day, repo and model, of the repos whose folder is one of `folders` when given
// (opencode's fixture database holds sessions of its own).
async function figuresOf(write: (home: string) => void, ...folders: string[]) {
  setEnv('TZ', 'UTC');
  const home = useTempHome();
  write(home);
  store = await openStore(home);
  await createCatchUp({ run, runBytes, store, home, log: () => {}, hosts: async () => [], aliasOf: async () => null }).run();
  const sums: Record<string, number> = {};
  for (const { repo, figures } of store.dailyLines('2026-01-01', '2026-12-31')) if (folders.length === 0 || folders.some((folder) => repo.endsWith(`/${folder}`))) for (const [name, value] of Object.entries(figures)) sums[name] = (sums[name] ?? 0) + value;
  return sums;
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
      mkdirSync(join(home, '.omp/agent'), { recursive: true });
      writeFileSync(join(home, '.omp/agent/config.yml'), 'compaction:\n  thresholdTokens: 800000\n');
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
