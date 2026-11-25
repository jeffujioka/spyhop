import { describe, test } from 'node:test';
import { cardModel } from '../../src/core/card-model.js';
import { NA, readStats } from '../../src/core/providers/index.js';
import { expect } from './helpers/expect.ts';

const HOME = '/Users/me';

// A card as the card builder makes it, every figure known.
const FULL_STATS = {
  harness: 'omp',
  model: 'claude-sonnet-5.5-1m',
  durationMs: 47_700_000,
  totalTokens: 55_000_000,
  contextTokens: 440_000,
  contextMax: 1_000_000,
  contextPercent: 0.44,
  headroomTokens: 412_000,
  autocompactions: 0,
  cacheHitRate: 0.93,
  cacheHits: 219,
  cacheMisses: 12,
  cacheLeftMs: 95_000,
  costUsd: 11.99,
  burnCostPerHour: 0.9,
  burnTokensPerMin: 69_000,
  sinceActivityMs: 180_000,
  latencyMs: 343_000,
  thinkingLevel: 'medium',
  premiumRequests: 14,
};

function card(overrides = {}, stats = {}) {
  return {
    id: 'p1',
    folder: `${HOME}/projects/jeffujioka`,
    branch: 'main',
    origin: 'https://github.com/jeffujioka/dotfiles.git',
    harness: 'omp',
    harnessName: 'omp',
    title: 'π > Fix the login bug',
    status: 'working',
    focused: false,
    machine: null,
    stats: { ...FULL_STATS, ...stats },
    ...overrides,
  };
}

const model = (overrides, stats) => cardModel(card(overrides, stats), { home: HOME });
const group = (m, id) => m.groups.find((g) => g.id === id);
const figures = (g) => Object.fromEntries(g.figures.map((f) => [f.label, f.value]));

describe('a card groups its figures', () => {
  test('a card groups its figures', () => {
    const m = model();

    // five groups in a fixed order, so the cards never jump between refreshes
    expect(m.groups.map((g) => g.id)).toEqual(['identity', 'context', 'spend', 'cache', 'activity']);
    expect(m.id).toBe('p1');

    expect(group(m, 'identity')).toMatchObject({
      status: { tone: 'working', label: 'working' },
      name: { value: 'jeffujioka' },
      session: { value: 'Fix the login bug' },
      path: { value: '~/projects/jeffujioka' },
      branch: 'main',
      remote: 'github.com/jeffujioka/dotfiles',
      machine: null,
      harness: { value: 'omp' },
      model: { value: 'claude-sonnet-5.5-1m' },
    });

    const context = group(m, 'context');
    expect(context.title).toBe('CONTEXT');
    expect(context.hero).toMatchObject({ value: '44%', label: 'of 1M' });
    // the gauge: the fill is the usage over the window, the tick the compaction trigger
    // (usage plus headroom)
    expect(context.gauge.fraction).toBeCloseTo(0.44);
    expect(context.gauge.tickFraction).toBeCloseTo(0.852);
    expect(figures(context)).toEqual({ Used: '440k', Headroom: '412k', Compactions: '0' });

    const spend = group(m, 'spend');
    expect(spend.title).toBe('SPEND');
    expect(spend.hero).toMatchObject({ value: '$11.99' });
    expect(figures(spend)).toEqual({ Burn: '$0.90/h', Tokens: '55M', Rate: '69k/min' });

    const cache = group(m, 'cache');
    expect(cache.title).toBe('CACHE');
    expect(cache.hero).toMatchObject({ value: '1m 35s', label: 'left' });
    expect(cache.bar.fraction).toBeCloseTo(0.93);
    expect(figures(cache)).toEqual({ 'Hit rate': '93%', Hits: '219', Misses: '12' });

    const activity = group(m, 'activity');
    expect(activity.title).toBe('ACTIVITY');
    expect(figures(activity)).toEqual({
      Session: '13h 15m',
      Active: '3m 00s ago',
      'Last turn': '5m 43s',
      Thinking: 'medium',
      Premium: '14',
    });

    // the session title: the pane's title without the harness prefix, so two cards of one
    // folder can be told apart; none when the session is untitled (its title is the folder's name)
    const session = (title, overrides) => group(model({ title, ...overrides }), 'identity').session;
    expect(session('π > Fix the login bug')).toEqual({ value: 'Fix the login bug', tone: 'normal' });
    expect(session('π > \uE0A0 Fix the login bug').value).toBe('\uE0A0 Fix the login bug');
    expect(session('\uE0A0 Fix the login bug').value).toBe('\uE0A0 Fix the login bug');
    expect(session('π > jeffujioka')).toBeNull();
    expect(session('jeffujioka')).toBeNull();
    expect(session('π >  ')).toBeNull();
    expect(session(null)).toBeNull();
    // another harness: the title as it is, unless it is the folder's name
    expect(session('Refactor the parser', { harness: 'claude-code' }).value).toBe('Refactor the parser');
    expect(session('π > Refactor', { harness: 'claude-code' }).value).toBe('π > Refactor');
    expect(session('jeffujioka', { harness: 'claude-code' })).toBeNull();
  });

  test('a card of the focused pane says so', () => {
    expect(model({ focused: true }).focused).toBe(true);
    expect(model({ focused: false }).focused).toBe(false);
    expect(model({ focused: undefined }).focused).toBe(false);
  });

  test('the folder, the remote and the machine are written for reading', () => {
    const identity = (overrides) => group(model(overrides), 'identity');

    // home is shown as ~, elsewhere the full path; the name is the folder's own name
    expect(identity({ folder: HOME })).toMatchObject({ name: { value: 'me' }, path: { value: '~' } });
    expect(identity({ folder: '/srv/app' })).toMatchObject({ name: { value: 'app' }, path: { value: '/srv/app' } });
    // a folder on another machine is not under this computer's home
    expect(identity({ folder: `${HOME}/x`, machine: 'bs' })).toMatchObject({ path: { value: `${HOME}/x` }, machine: 'bs' });
    // a folder named like the home's start but not inside it
    expect(identity({ folder: `${HOME}-old/x` }).path.value).toBe(`${HOME}-old/x`);

    // scheme, credentials already masked, user and `.git` are left out
    const remote = (origin) => identity({ origin }).remote;
    expect(remote('git@github.com:jeffujioka/dotfiles.git')).toBe('github.com/jeffujioka/dotfiles');
    expect(remote('https://***@gitlab.example.com/team/app.git')).toBe('gitlab.example.com/team/app');
    expect(remote('ssh://git@host.example:2222/team/app')).toBe('host.example:2222/team/app');
    expect(remote(null)).toBeNull();
    // a folder without git has neither line
    expect(identity({ branch: null, origin: null })).toMatchObject({ branch: null, remote: null });
  });
});

describe('context gauge shows how near compaction is', () => {
  // usage `used` of a 1M window, the trigger at `trigger` tokens (undefined: not known)
  const gauge = (used, trigger) =>
    group(
      model(
        {},
        {
          contextTokens: used,
          contextMax: 1_000_000,
          contextPercent: used / 1_000_000,
          headroomTokens: trigger === undefined ? NA : Math.max(0, trigger - used),
        },
      ),
      'context',
    ).gauge;

  test('context gauge tone', () => {
    // with the trigger known: ok below 75% of it, warning from 75%, danger from 90%
    expect(gauge(100_000, 800_000).tone).toBe('ok');
    expect(gauge(599_000, 800_000).tone).toBe('ok');
    expect(gauge(600_000, 800_000).tone).toBe('warning');
    expect(gauge(719_000, 800_000).tone).toBe('warning');
    expect(gauge(720_000, 800_000).tone).toBe('danger');
    expect(gauge(900_000, 800_000).tone).toBe('danger');
    // the tick is the trigger's place on the window; once the usage is past it (no headroom
    // left) the trigger is at or before the usage, and the tick sits at the usage
    expect(gauge(100_000, 800_000).tickFraction).toBeCloseTo(0.8);
    expect(gauge(900_000, 800_000).tickFraction).toBeGreaterThan(0);

    // without a trigger the same limits apply to 70% and 85% of the window
    expect(gauge(690_000).tone).toBe('ok');
    expect(gauge(700_000).tone).toBe('warning');
    expect(gauge(849_000).tone).toBe('warning');
    expect(gauge(850_000).tone).toBe('danger');
    expect(gauge(690_000).tickFraction).toBeNull();

    // an unknown usage is dim, with no fill
    const unknown = group(model({}, { contextTokens: NA, contextPercent: NA, headroomTokens: NA }), 'context');
    expect(unknown.gauge).toMatchObject({ tone: 'dim', fraction: null });
    expect(unknown.hero).toMatchObject({ value: NA, tone: 'dim' });
    // the hero percent takes the gauge's tone
    expect(group(model({}, { contextTokens: 900_000, contextPercent: 0.9, headroomTokens: 0 }), 'context').hero.tone).toBe('danger');
  });
});

describe('cache countdown shows its tone', () => {
  const left = (cacheLeftMs) => group(model({}, { cacheLeftMs }), 'cache').hero;

  test('cache countdown tone', () => {
    expect(left(61_000)).toMatchObject({ value: '1m 01s', label: 'left', tone: 'ok' });
    expect(left(60_000)).toMatchObject({ value: '1m 00s', tone: 'warning' });
    expect(left(1_000).tone).toBe('warning');
    // already cold
    expect(left(0)).toMatchObject({ value: 'cold', label: '', tone: 'warning' });
    // unknown
    expect(left(NA)).toMatchObject({ value: NA, tone: 'dim' });
  });
});

describe('agent status colors the card dot', () => {
  test('status dot tone', () => {
    for (const status of ['working', 'blocked', 'done', 'idle']) {
      expect(group(model({ status }), 'identity').status).toEqual({ tone: status, label: status });
    }
    expect(group(model({ status: null }), 'identity').status).toEqual({ tone: 'dim', label: NA });
    expect(group(model({ status: undefined }), 'identity').status.tone).toBe('dim');
  });
});

describe('unknown figures are dimmed', () => {
  // every `{ value, tone }` of a model, wherever it sits
  const toned = (m) =>
    m.groups.flatMap((g) => [g.name, g.session, g.path, g.harness, g.model, g.hero, ...(g.figures ?? [])]).filter(Boolean);

  test('unknown figures are dimmed', () => {
    // a card with no session: every figure reads n/a, and every one of them is dim
    const unlinked = { ...readStats('', null, 0), harness: 'omp' };
    const m = cardModel(card({ status: 'idle' }, unlinked), { home: HOME });
    const unknown = toned(m).filter((f) => f.value === NA);
    expect(unknown.length).toBeGreaterThanOrEqual(15);
    expect(unknown.every((f) => f.tone === 'dim')).toBe(true);
    // the gauge and the cache bar have nothing to draw
    expect(group(m, 'context').gauge).toMatchObject({ fraction: null, tone: 'dim' });
    expect(group(m, 'cache').bar).toBeNull();

    // a known figure is not dimmed
    const known = toned(model()).filter((f) => f.value !== NA);
    expect(known.length).toBeGreaterThan(15);
    expect(known.some((f) => f.tone === 'dim')).toBe(false);
    // the folder and the harness read from the pane stay as they are
    expect(group(m, 'identity')).toMatchObject({ name: { value: 'jeffujioka', tone: 'normal' }, harness: { value: 'omp', tone: 'normal' }, model: { value: NA, tone: 'dim' } });
    // a card with no folder reads n/a, dim
    expect(group(cardModel(card({ folder: null }), { home: HOME }), 'identity')).toMatchObject({
      name: { value: NA, tone: 'dim' },
      path: { value: NA, tone: 'dim' },
    });
  });
});
