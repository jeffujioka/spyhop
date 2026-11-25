import { describe, test } from 'node:test';
import { cardModel } from '../../src/core/card-model.js';
import { formatTokens } from '../../src/core/format.js';
import { NA, readStats } from '../../src/core/providers/index.js';
import { parseEntries } from '../../src/core/providers/jsonl.js';
import { ompProvider } from '../../src/core/providers/omp.js';
import { fixtureText } from '../helpers/files.ts';
import { ompMessage } from './helpers/entries.ts';
import { expect } from './helpers/expect.ts';

const NOW = Date.parse('2026-11-02T12:00:00.000Z');

// What the card shows of the context: the hero of its context group, the usage percent with
// the window as its label.
const context = (stats) => cardModel({ id: 'p', folder: null, harnessName: 'omp', stats }, { home: '/h' }).groups[1].hero;

// One synthetic assistant message entry whose prompt held `promptTokens` tokens.
const assistant = (promptTokens, extra = {}) =>
  ompMessage('assistant', '2026-11-02T11:00:00.000Z', null, { contextSnapshot: { promptTokens }, ...extra });

// The omp provider through the registry, which fills every figure it leaves out with n/a.
// The sources are plain values, as the card builder hands them in: `models` is the model list of
// the session's provider in omp's catalogue (absent = catalogue unreadable), `compaction` the
// compaction block of omp's config (undefined = config unreadable; `{}` = no compaction key).
function provider(sources) {
  const compaction = 'compaction' in sources ? sources.compaction : {};
  return {
    readStats: (text, now) =>
      readStats('omp', { text, sources: { catalogue: sources.models ?? null, compaction: compaction ?? null } }, now),
  };
}

const window200k = [{ id: 'm', contextWindow: 200_000 }];

describe('omp session: context window and autocompactions', () => {
  test('usage over max', () => {
    const stats = provider({ models: window200k }).readStats(assistant(50_000), NOW);

    expect(stats.contextTokens).toBe(50_000);
    expect(stats.contextMax).toBe(200_000);
    expect(stats.contextPercent).toBe(0.25);
    expect(context(stats)).toMatchObject({ value: '25%', label: 'of 200k' });

    // a max without any logged usage still shows, with the percentage as n/a
    const unused = provider({ models: window200k }).readStats(assistant(undefined, { contextSnapshot: undefined }), NOW);
    expect(unused.contextPercent).toBe(NA);
    expect(context(unused)).toMatchObject({ value: NA, label: 'of 200k' });
  });

  test('usage is the latest assistant message that carries a snapshot', () => {
    const text = [assistant(50_000), assistant(80_000), assistant(undefined, { contextSnapshot: undefined })].join('\n');
    const stats = provider({ models: window200k }).readStats(text, NOW);

    expect(stats.contextTokens).toBe(80_000);
    expect(context(stats)).toMatchObject({ value: '40%', label: 'of 200k' });
  });

  test('a one-million window reads 1M', () => {
    const models = [{ id: 'claude-sonnet-5.5-1m', contextWindow: 1_000_000 }];
    const text = assistant(250_000, { model: 'claude-sonnet-5.5-1m' });

    expect(context(provider({ models }).readStats(text, NOW))).toMatchObject({ value: '25%', label: 'of 1M' });
    // a size that rounds up to a thousand k is written in M
    expect(formatTokens(999_500)).toBe('1M');
    expect(formatTokens(999_499)).toBe('999k');
  });

  test('unknown max is n/a', () => {
    const text = assistant(50_000);
    // a trigger is configured, so only the missing window can make the headroom unknown
    const compaction = { thresholdTokens: 150_000 };

    for (const models of [undefined, [], [{ id: 'other', contextWindow: 200_000 }]]) {
      const stats = provider({ models, compaction }).readStats(text, NOW);

      expect(stats.contextMax).toBe(NA);
      expect(stats.contextPercent).toBe(NA);
      expect(stats.headroomTokens).toBe(NA);
      expect(context(stats)).toMatchObject({ value: NA, label: '' });
    }
  });

  test('counts autocompactions', () => {
    const stats = provider({ models: window200k }).readStats(fixtureText('omp/compacted.jsonl'), NOW);

    expect(stats.autocompactions).toBe(2);
  });

  test('a whole session without a compaction reads 0', () => {
    expect(provider({ models: window200k }).readStats(fixtureText('omp/basic.jsonl'), NOW).autocompactions).toBe(0);
  });

  test('a state over the whole file stands for a tail window', () => {
    // the card reader folds the whole file in chunks (src/core/refresh.js); the provider takes
    // that state as is
    const whole = fixtureText('omp/compacted.jsonl');
    const tail = whole.split('\n').slice(8).join('\n');
    const state = ompProvider.fold(undefined, parseEntries(whole));

    expect(readStats('omp', { text: tail, state }, NOW).autocompactions).toBe(2);
    expect(readStats('omp', { text: tail, state: null }, NOW).autocompactions).toBe(NA);
  });

  test('unknown compactions is n/a', () => {
    // a tail window that starts after the session header cannot say how many compactions the
    // earlier part held, even when it holds one itself
    const tail = fixtureText('omp/compacted.jsonl').split('\n').slice(8).join('\n');
    const stats = provider({ models: window200k }).readStats(tail, NOW);

    expect(tail).toContain('"type":"compaction"');
    expect(stats.autocompactions).toBe(NA);
  });

  test('headroom', () => {
    const million = [{ id: 'm', contextWindow: 1_000_000 }];
    const headroom = (models, compaction, used = 600_000) =>
      provider({ models, compaction }).readStats(assistant(used), NOW).headroomTokens;

    // omp's default: window minus max(15% of the window, 16,384), here 850,000 and 170,000
    expect(headroom(million, {})).toBe(250_000);
    expect(headroom(window200k, {}, 50_000)).toBe(120_000);
    // a window under ~109k, where omp's small-window fallback applies, is not evaluated
    expect(headroom([{ id: 'm', contextWindow: 100_000 }], {}, 50_000)).toBe(NA);
    // a reserve that swallows the window is not evaluated either
    expect(headroom(million, { reserveTokens: 1_000_000 })).toBe(NA);
    // an explicit reserve above the 15% floor
    expect(headroom(million, { reserveTokens: 200_000 })).toBe(200_000);
    // an explicit token trigger wins over a percentage
    expect(headroom(million, { thresholdTokens: 700_000, thresholdPercent: 50 })).toBe(100_000);
    // a percentage of the window
    expect(headroom(million, { thresholdPercent: 80 })).toBe(200_000);
    // a token trigger at or past the window falls back to the default
    expect(headroom(million, { thresholdTokens: 1_000_000 })).toBe(250_000);
    // usage past the trigger leaves nothing
    expect(headroom(million, {}, 900_000)).toBe(0);
  });

  test('unknown trigger is n/a headroom', () => {
    const text = assistant(50_000);
    const unknowns = [
      undefined, // config unreadable
      { modelThresholds: { 'p/m': 'f90000' } }, // a per-model entry spyhop does not evaluate
      { modelThresholds: { 'p/*': '80%' } },
      { enabled: false }, // no autocompaction at all
    ];

    for (const compaction of unknowns) {
      const stats = provider({ models: window200k, compaction }).readStats(text, NOW);

      expect(stats.headroomTokens).toBe(NA);
      // the context over max still shows
      expect(context(stats)).toMatchObject({ value: '25%', label: 'of 200k' });
    }
  });

  test('a model threshold for another model does not hide the headroom', () => {
    const compaction = { modelThresholds: { 'p/other': 'f90000', 'q/*': 90000 } };
    const stats = provider({ models: window200k, compaction }).readStats(assistant(50_000), NOW);

    expect(stats.headroomTokens).toBe(120_000);
  });

  test('model thresholds off leave the default', () => {
    const compaction = { modelThresholdsEnabled: false, modelThresholds: { 'p/m': 'f90000' } };
    const stats = provider({ models: window200k, compaction }).readStats(assistant(50_000), NOW);

    expect(stats.headroomTokens).toBe(120_000);
  });
});
