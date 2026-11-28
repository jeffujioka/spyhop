// The Health tab's figures in the readers: the failed model calls by type, the retries that
// recovered, the reply times, the output cut at the maximum length and the thinking tokens, as the
// catch-up reads them from omp's, Claude Code's and opencode's sessions into the daily lines and
// the replies of the history store. The store, the runner and the programs are the real ones,
// under a temporary home, in UTC.
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { LINE_FIGURES, newInsights, noteCall, takeLines } from '../../src/core/insights.js';
import { failureType, replyBucket, replyQuantile } from '../../src/core/reply-times.js';
import type { Store } from '../../src/history/store.ts';
import { opencodeSession } from '../helpers/agent-cards.ts';
import { caughtUpStore, nonZero, sumsOf } from '../helpers/history.ts';
import { claudeSession, MODEL, ompSession, type ClaudeCall, type OmpCall } from '../helpers/live.ts';
import { expect } from './helpers/expect.ts';

let store: Store | undefined;
afterEach(() => {
  store?.close();
  store = undefined;
});

// Epoch ms of `time` (HH:MM, or HH:MM:SS) on the day of every session here, 2026-11-25 UTC.
const at = (time: string) => Date.parse(`2026-11-25T${time.length === 5 ? `${time}:00` : time}.000Z`);
const DAY = 24 * 60 * 60_000;
const ago = (days: number) => Date.now() - days * DAY;
const RANGE = ['2000-01-01', '2100-01-01'] as const;

// The sums of the daily lines (see sumsOf) after a catch-up of the home `write` fills, then `more`
// runs of it, each once `between` has changed the home.
async function sumsAfter(write: (home: string) => void, between: (home: string) => void = () => {}, more = 0, ...folders: string[]) {
  store = await caughtUpStore(write, between, more);
  return sumsOf(store, folders);
}

// The reply times the store of the last catch-up keeps for `model`: the typical and the slow one
// (ms), null for a model with none, and how many replies it counts.
function repliesOf(model: string) {
  const counts = store!.replies(...RANGE).get(model) ?? new Map<number, number>();
  return { median: replyQuantile(counts, 0.5), slow: replyQuantile(counts, 0.95), count: [...counts.values()].reduce((sum, n) => sum + n, 0) };
}

const NAMES = ['failNetwork', 'failAuth', 'failNotFound', 'failRateLimit', 'failServer', 'failOther'];

describe('failure types', () => {
  test('an error text names its type', () => {
    expect(failureType({ text: "Couldn't reach copilot-api (getaddrinfo ENOTFOUND)" })).toBe('network');
    for (const text of ['read ECONNRESET', 'connect ECONNREFUSED', 'ETIMEDOUT', 'fetch failed']) expect(failureType({ text })).toBe('network');
    expect(failureType({ status: 401 })).toBe('auth');
    expect(failureType({ status: 403 })).toBe('auth');
    expect(failureType({ status: 404 })).toBe('notFound');
    expect(failureType({ status: 429 })).toBe('rateLimit');
    expect(failureType({ status: 503 })).toBe('server');
    // the first HTTP status of a text
    expect(failureType({ text: 'Provider request failed with HTTP 429 Too Many Requests' })).toBe('rateLimit');
    expect(failureType({ text: 'Anthropic stream stalled while waiting for the next event' })).toBe('other');
    expect(failureType({ status: 400 })).toBe('other');
  });

  test('opencode error types name theirs', () => {
    expect(failureType({ type: 'provider.transport', status: 200 })).toBe('network');
    expect(failureType({ type: 'provider.auth' })).toBe('auth');
    expect(failureType({ type: 'provider.invalid-request', status: 404 })).toBe('notFound');
    expect(failureType({ type: 'ContextOverflowError' })).toBe('other');
    expect(failureType({ type: 'something.new' })).toBe('other');
  });
});

describe('reply quantiles', () => {
  test('quantiles are within 10%', () => {
    const counts = new Map<number, number>();
    for (const [seconds, n] of [[1, 60], [3, 35], [20, 5]]) counts.set(replyBucket(seconds * 1000), n);

    expect(replyQuantile(counts, 0.5)! / 1000).toBeGreaterThan(0.9);
    expect(replyQuantile(counts, 0.5)! / 1000).toBeLessThan(1.1);
    expect(replyQuantile(counts, 0.95)! / 1000).toBeGreaterThan(2.7);
    expect(replyQuantile(counts, 0.95)! / 1000).toBeLessThan(3.3);
    expect(replyQuantile(new Map(), 0.5)).toBeNull();
  });
});

describe('omp', () => {
  const call = (time: string, more: Partial<OmpCall> = {}): OmpCall => ({ at: at(time), uncached: 10, output: 5, cost: 0.1, duration: 1000, ...more });
  const failed = (time: string, error: string, more: Partial<OmpCall> = {}): OmpCall => ({ at: at(time), stop: 'error', error, ...more });

  test('failed calls book their type only', async () => {
    const sums = await sumsAfter((home) =>
      ompSession(home, join(home, 'api'), {
        title: 'api',
        calls: [
          call('10:00'),
          failed('10:01', "Couldn't reach copilot-api (getaddrinfo ENOTFOUND)"),
          failed('10:02', "Couldn't reach copilot-api (getaddrinfo ENOTFOUND)"),
          failed('10:03', "Couldn't reach copilot-api (getaddrinfo ENOTFOUND)"),
          failed('10:04', '429 Too Many Requests'),
        ],
      }),
    );

    expect(nonZero(sums, ...NAMES)).toEqual({ failNetwork: 3, failRateLimit: 1 });
    // the failed calls are no model call, and have no token, cost or reply time
    expect(nonZero(sums, 'calls', 'tokens', 'cost', 'costNa')).toEqual({ calls: 1, tokens: 15, cost: 0.1 });
    expect([...store!.replies(...RANGE).values()].map((counts) => [...counts.values()].reduce((sum, n) => sum + n, 0))).toEqual([1]);
  });

  test('a failed call that spent tokens is no cold start and no call before the next one', async () => {
    const sums = await sumsAfter((home) =>
      ompSession(home, join(home, 'api'), {
        title: 'api',
        calls: [
          call('10:00', { read: 100, model: 'model-a' }),
          failed('10:01', 'Anthropic stream stalled', { read: 0, uncached: 2, output: 8, cost: 0.1, model: 'model-b' }),
          call('10:02', { read: 0, model: 'model-a' }),
        ],
      }),
    );

    expect(nonZero(sums, 'coldOther', 'coldModel', 'failOther', 'calls')).toEqual({ coldOther: 1, failOther: 1, calls: 3 });
  });

  test('an interrupted call is no failure', async () => {
    const sums = await sumsAfter((home) => {
      ompSession(home, join(home, 'api'), { title: 'api', calls: [call('10:00', { stop: 'aborted', error: 'Interrupted by user', uncached: 0, output: 0, cost: undefined })] });
      opencodeSession(home, join(home, 'web'), {
        provider: 'anthropic',
        model: 'claude-opus-5.5',
        cost: 0,
        calls: [{ uncached: 0, read: 0, write: 0, output: 0, at: at('10:00'), finish: null, error: { type: 'aborted' } }],
      });
    });

    expect(nonZero(sums, ...NAMES)).toEqual({});
  });

  test('a call that spent tokens and failed is still a call, and its recovered retry counts', async () => {
    const sums = await sumsAfter((home) =>
      ompSession(home, join(home, 'api'), {
        title: 'api',
        calls: [failed('10:00', 'Anthropic stream stalled while waiting for the next event', { uncached: 2, output: 8, cost: 0.1, recovered: true, duration: 900_000 }), call('10:01')],
      }),
    );

    expect(nonZero(sums, ...NAMES, 'retries', 'calls')).toEqual({ failOther: 1, retries: 1, calls: 2 });
    // only the call that did not fail has a reply time
    expect([...store!.replies(...RANGE).values()].map((counts) => [...counts.values()].reduce((sum, n) => sum + n, 0))).toEqual([1]);
  });

  test('a call cut at the maximum length counts with its cost, and omp logs no thinking tokens', async () => {
    const sums = await sumsAfter((home) => ompSession(home, join(home, 'api'), { title: 'api', calls: [call('10:00', { stop: 'length', cost: 0.25 }), call('10:01', { stop: 'length' , cost: undefined }), call('10:02')] }));

    expect(nonZero(sums, 'cutCalls', 'cutCost', 'cutCostNa', 'thinkingCalls', 'thinkingTokens')).toEqual({ cutCalls: 2, cutCost: 0.25, cutCostNa: 1 });
  });

  test('reply times by model, kept as the file grows and gone when it is read again from its start', async () => {
    const calls = [
      ...Array.from({ length: 60 }, (_, i) => call('10:00', { at: at('10:00') + i * 1000, duration: 1000 })),
      ...Array.from({ length: 35 }, (_, i) => call('11:00', { at: at('11:00') + i * 1000, duration: 3000 })),
      ...Array.from({ length: 5 }, (_, i) => call('12:00', { at: at('12:00') + i * 1000, duration: 20_000 })),
    ];
    let file = '';
    await sumsAfter(
      (home) => (file = ompSession(home, join(home, 'api'), { title: 'api', calls })),
      () => appendFileSync(file, `${JSON.stringify({ type: 'message', timestamp: '2026-11-25T13:00:00.000Z', message: { role: 'assistant', provider: 'anthropic', model: MODEL, usage: { input: 1, output: 1, totalTokens: 2 }, duration: 1000 } })}\n`),
      1,
    );

    const models = [...store!.replies(...RANGE).keys()];
    expect(models).toHaveLength(1);
    const { median, slow, count } = repliesOf(models[0]);
    expect(count).toBe(101);
    expect(median! / 1000).toBeGreaterThan(0.9);
    expect(median! / 1000).toBeLessThan(1.1);
    expect(slow! / 1000).toBeGreaterThan(2.7);
    expect(slow! / 1000).toBeLessThan(3.3);
    // days outside the range have none
    expect(store!.replies('2026-11-26', '2026-11-30').size).toBe(0);
  });
});

describe('Claude Code', () => {
  const call = (time: string, more: Partial<ClaudeCall> = {}): ClaudeCall => ({ at: at(time), uncached: 10, output: 5, ...more });

  test('a Claude Code API error is a failed call', async () => {
    const sums = await sumsAfter((home) =>
      claudeSession(home, join(home, 'cc'), { model: 'claude-opus-5-5', calls: [call('10:00'), call('10:01', { apiError: { status: 401 } }), call('10:02', { apiError: { status: null } })] }),
    );

    expect(nonZero(sums, ...NAMES, 'calls', 'tokens')).toEqual({ failAuth: 1, failOther: 1, calls: 1, tokens: 15 });
    // it counts under the model of the call before it
    expect(store!.dailyLines(...RANGE).map((line) => [line.model, line.figures.failAuth])).toEqual([['claude-opus-5-5', 1]]);
  });

  test('an API error before any call counts under n/a', async () => {
    await sumsAfter((home) => claudeSession(home, join(home, 'cc'), { calls: [call('10:00', { apiError: { status: 404 } })] }));

    expect(store!.dailyLines(...RANGE).map((line) => [line.model, line.figures.failNotFound, line.figures.calls])).toEqual([['n/a', 1, 0]]);
  });

  test('a streamed reply counts its thinking, its cut and its reply time once', async () => {
    const sums = await sumsAfter((home) =>
      claudeSession(home, join(home, 'cc'), {
        model: 'claude-opus-5-5',
        calls: [call('10:00:15', { prompted: at('10:00:09'), blocks: [at('10:00:11'), at('10:00:13')], thinking: 183, stop: 'max_tokens' })],
      }),
    );

    // Claude Code logs no cost per call, so the cost of a cut call reads n/a
    expect(nonZero(sums, 'calls', 'thinkingCalls', 'thinkingTokens', 'cutCalls', 'cutCost', 'cutCostNa')).toEqual({ calls: 1, thinkingCalls: 1, thinkingTokens: 183, cutCalls: 1, cutCostNa: 1 });
    const { median, slow, count } = repliesOf('claude-opus-5-5');
    expect(count).toBe(1);
    for (const ms of [median!, slow!]) {
      expect(ms / 1000).toBeGreaterThan(5.4);
      expect(ms / 1000).toBeLessThan(6.6);
    }
  });

  test('a response that logs no thinking tokens counts no thinking call', async () => {
    const sums = await sumsAfter((home) => claudeSession(home, join(home, 'cc'), { calls: [call('10:00', { prompted: at('09:59:55') })] }));

    expect(nonZero(sums, 'thinkingCalls', 'thinkingTokens', 'cutCalls')).toEqual({});
  });
});

describe('opencode', () => {
  const WRITE = { uncached: 10, read: 0, write: 1000, output: 5 };
  const NONE = { uncached: 0, read: 0, write: 0, output: 0, finish: 'error' };
  const session = (calls: object[], more: object = {}) => (home: string) =>
    opencodeSession(home, join(home, 'web'), { provider: 'anthropic', model: 'claude-opus-5.5', cost: 0.2, calls: calls as never, ...more });

  test('error types name theirs, and a retry that ended in an error is none that recovered', async () => {
    const sums = await sumsAfter(
      session([
        { ...NONE, at: at('10:00'), error: { type: 'provider.transport' } },
        { ...NONE, at: at('10:01'), error: { type: 'provider.auth', status: 401 } },
        { ...NONE, at: at('10:02'), error: { type: 'provider.invalid-request', status: 404 } },
        { ...NONE, at: at('10:03'), error: { type: 'provider.transport' }, retry: true },
        { ...WRITE, at: at('10:04') },
      ]),
      () => {},
      0,
      'web',
    );

    expect(nonZero(sums, ...NAMES, 'retries', 'calls')).toEqual({ failNetwork: 2, failAuth: 1, failNotFound: 1, calls: 1 });
  });

  test('a failed call that spent tokens is no cold start and no call before the next one', async () => {
    const sums = await sumsAfter(
      session([
        { ...WRITE, read: 100, at: at('10:00') },
        { ...WRITE, read: 0, model: 'claude-other', finish: 'error', error: { type: 'provider.transport' }, at: at('10:01') },
        { ...WRITE, read: 0, at: at('10:02') },
      ]),
      () => {},
      0,
      'web',
    );

    expect(nonZero(sums, 'coldOther', 'coldModel', 'failNetwork', 'calls')).toEqual({ coldOther: 1, failNetwork: 1, calls: 3 });
  });

  test('a retry without an error recovered', async () => {
    const sums = await sumsAfter(session([{ ...WRITE, at: at('10:00'), retry: true }, { ...WRITE, at: at('10:01'), retry: true }, { ...WRITE, at: at('10:02') }]), () => {}, 0, 'web');

    expect(nonZero(sums, 'retries', 'calls')).toEqual({ retries: 2, calls: 3 });
  });

  test('calls cut at the maximum length count with their cost; reasoning tokens are thinking', async () => {
    const sums = await sumsAfter(
      session([
        { ...WRITE, at: at('10:00'), finish: 'length', reasoning: 400 },
        { ...WRITE, at: at('10:01'), finish: 'length', reasoning: 600 },
        { ...WRITE, at: at('10:02') },
      ]),
      () => {},
      0,
      'web',
    );

    expect(nonZero(sums, 'cutCalls', 'cutCost', 'thinkingCalls', 'thinkingTokens')).toEqual({ cutCalls: 2, cutCost: 0.2, thinkingCalls: 3, thinkingTokens: 1000 });
  });

  test('reply times are kept through a split first read and a later catch-up', async () => {
    const write = session([
      { ...WRITE, at: ago(40), took: 1000 },
      { ...WRITE, at: ago(20), took: 3000 },
      { ...WRITE, at: ago(5), took: 3000 },
      { ...WRITE, at: ago(2), took: 20_000 },
    ]);
    await sumsAfter(write, () => {}, 1);

    const { count, median } = repliesOf('anthropic/claude-opus-5.5');
    expect(count).toBe(4);
    expect(median! / 1000).toBeGreaterThan(2.7);
    expect(median! / 1000).toBeLessThan(3.3);
  });

  test('the open days a later catch-up reads again do not count their replies twice', async () => {
    await sumsAfter(
      session([{ ...WRITE, at: ago(5), took: 3000 }, { ...WRITE, at: ago(2), took: 3000 }]),
      (home) =>
        opencodeSession(home, join(home, 'web'), {
          provider: 'anthropic',
          model: 'claude-opus-5.5',
          cost: 0.2,
          id: 'ses_two',
          update: true,
          calls: [{ ...WRITE, at: ago(1), took: 3000 }],
        }),
      1,
      'web',
    );

    expect(repliesOf('anthropic/claude-opus-5.5').count).toBe(3);
  });
});

describe('noteCall taken back', () => {
  test('a call taken back with sign -1 leaves no Health figure and no reply', () => {
    const ins = newInsights();
    const call = { end: at('10:00'), model: 'p/m', tokens: 15, uncached: 10, read: 0, write: 0, output: 5, cost: 0.5, recovered: true, cut: true, thinkingTokens: 7, replyMs: 3000, failure: null, aborted: false };
    const failed = { ...call, cost: null, failure: 'network', recovered: false };
    noteCall(ins, call, 1);
    noteCall(ins, failed, 1);
    const [line] = [...ins.open.values()];
    expect(nonZero(line.figures, 'retries', 'cutCalls', 'cutCost', 'cutCostNa', 'thinkingCalls', 'thinkingTokens', 'failNetwork')).toEqual({
      retries: 1,
      cutCalls: 2,
      cutCost: 0.5,
      cutCostNa: 1,
      thinkingCalls: 2,
      thinkingTokens: 14,
      failNetwork: 1,
    });
    expect(Object.values(line.replies ?? {})).toEqual([1]);

    noteCall(ins, failed, -1);
    noteCall(ins, call, -1);
    expect(nonZero(line.figures, ...LINE_FIGURES)).toEqual({});
    expect(Object.values(line.replies ?? {})).toEqual([0]);
    expect(takeLines(ins)).toHaveLength(1);
  });
});
