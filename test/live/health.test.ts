// The Health tab: the failed model calls by type, Orca host and provider, the retries that
// recovered, the typical and slow reply time, the output cut at the maximum length and the
// thinking tokens by model: the real worker's answer from the history store, which its first
// catch-up filled from omp, Claude Code and opencode session files under a temporary home
// (test/helpers/history.ts), drawn and read through the markup's conventions
// (test/helpers/markup.ts). The Orca host starfish-bs is reached through the stand-in `ssh`.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { workspace, opencodeSession, type OpencodeCall } from '../helpers/agent-cards.ts';
import { tempHome } from '../helpers/files.ts';
import { healthTab } from '../../src/live/health.ts';
import type { RangeAnswer } from '../../src/protocol.ts';
import { STORE_FILE } from '../../src/history/store.ts';
import { caughtUp, rangeOf } from '../helpers/history.ts';
import { claudeSession, ompSession, mountOn, type OmpCall, openLive, openOnFleet } from '../helpers/live.ts';
import { attr, figure, listOf, parts, text } from '../helpers/markup.ts';
import { hostListOf, environmentListOf, LOCAL_HOST, STARFISH_LISTS } from '../helpers/orca-answers.ts';
import type { HostWorkspace } from '../helpers/orca-host.ts';

// The clock of these tests: 2026-11-28 15:00 UTC.
const CLOCK = Date.parse('2026-11-28T15:00:00.000Z');

// Epoch ms of `time` (HH:MM, or HH:MM:SS) on 2026-11-27, UTC.
const at = (time: string) => Date.parse(`2026-11-27T${time.length === 5 ? `${time}:00` : time}.000Z`);

const COPILOT = { provider: 'github-copilot', model: 'claude-opus-5.5' };
const COPILOT_MODEL = 'github-copilot/claude-opus-5.5';

// An omp model call at `time` that ended without failure, which took 1 s.
const call = (time: string, more: Partial<OmpCall> = {}): OmpCall => ({ at: at(time), uncached: 10, output: 5, cost: 0.1, duration: 1000, ...more });

// A model call of omp that failed with `error` and spent no tokens.
const failed = (time: string, error: string, more: Partial<OmpCall> = {}): OmpCall => ({ at: at(time), stop: 'error', error, ...more });

// The Health tab of Week once its first catch-up has read what `prepare` wrote under the home.
const healthOf = (prepare: (home: string) => void) => rangeOf([], { tab: 'health', range: 'week', now: CLOCK, prepare }).then(({ html }) => html);

// The omp session of the folder `api` that logs `calls`.
const omp = (calls: OmpCall[]) => (home: string) => ompSession(home, join(home, 'api'), { title: 'api', calls });

// The opencode session of the folder `web` through `provider` on `model`.
const opencode = (calls: OpencodeCall[], provider = 'anthropic', model = 'claude-opus-5.5') => (home: string) =>
  opencodeSession(home, join(home, 'web'), { provider, model, cost: 0, calls });

// An opencode model call that failed with `error` and spent no tokens.
const NONE = { uncached: 0, read: 0, write: 0, output: 0, finish: 'error' as string | null };

// The seconds a figure of a reply time reads.
const seconds = (html: string, name: string) => {
  const words = figure(html, name);
  assert.match(words ?? '', /^\d+\.\d+s$/, name);
  return parseFloat(words!);
};

test('Network errors on one Orca host', async () => {
  const remoteHome = tempHome();
  const infra: HostWorkspace = { project: 'infra', name: 'main', agents: ['working'], hostId: 'ssh:starfish-bs', sessionId: 's1', title: 'π - Deploy it' };
  let home = '';
  const opened = await openOnFleet([infra], {
    now: CLOCK,
    homes: { 'starfish-bs': remoteHome },
    orca: STARFISH_LISTS,
    prepare: (made) => {
      home = made;
      // starfish-bs: 3 omp calls through github-copilot that failed on the network
      ompSession(remoteHome, workspace(made, 'infra-main'), {
        title: 'Deploy it',
        calls: ['10:00', '10:01', '10:02'].map((time) => failed(time, "Couldn't reach copilot-api (getaddrinfo ENOTFOUND)", COPILOT)),
      });
      // this computer: a Claude Code call that failed with 401
      claudeSession(made, join(made, 'web'), { calls: [{ at: at('10:00'), apiError: { status: 401 } }] });
    },
  });
  await caughtUp(home);
  await opened.openTab('health', 'week');

  const html = opened.html();
  assert.deepEqual(listOf(html, 'failed-type'), ['network 3', 'auth 1']);
  assert.deepEqual(listOf(html, 'failed-host'), ['starfish-bs 3', 'local 1']);
  assert.deepEqual(listOf(html, 'failed-provider'), ['github-copilot 3', 'n/a 1']);
  assert.equal(figure(html, 'failed'), '4');
});

test('opencode error types', async () => {
  const html = await healthOf(
    opencode([
      { ...NONE, at: at('10:00'), error: { type: 'provider.transport' } },
      { ...NONE, at: at('10:01'), error: { type: 'provider.auth', status: 401 } },
      { ...NONE, at: at('10:02'), error: { type: 'provider.invalid-request', status: 404 } },
    ]),
  );

  assert.deepEqual(listOf(html, 'failed-type'), ['network 1', 'auth 1', 'not found 1']);
});

test('Interrupted model calls', async () => {
  const html = await healthOf((home) => {
    omp([call('10:00', { stop: 'aborted', error: 'Interrupted by user', uncached: 0, output: 0, cost: undefined })])(home);
    opencode([{ ...NONE, at: at('10:00'), finish: null, error: { type: 'aborted' } }])(home);
  });

  assert.equal(figure(html, 'failed'), '0');
  assert.deepEqual(listOf(html, 'failed-type'), []);
});

test('Retries of omp and opencode', async () => {
  const html = await healthOf((home) => {
    omp([call('10:00', { recovered: true })])(home);
    opencode([
      { uncached: 10, read: 0, write: 0, output: 5, at: at('10:00'), retry: true },
      { uncached: 10, read: 0, write: 0, output: 5, at: at('10:01'), retry: true },
      { ...NONE, at: at('10:02'), error: { type: 'provider.transport' }, retry: true },
    ])(home);
  });

  assert.equal(figure(html, 'retries'), '3');
});

test('Typical and slow', async () => {
  const replies = (time: string, count: number, duration: number) => Array.from({ length: count }, (_, i) => call(time, { at: at(time) + i * 1000, duration, ...COPILOT }));
  const html = await healthOf(omp([...replies('10:00', 60, 1000), ...replies('11:00', 35, 3000), ...replies('12:00', 5, 20_000)]));

  const typical = seconds(html, `typical-${COPILOT_MODEL}`);
  const slow = seconds(html, `slow-${COPILOT_MODEL}`);
  assert.ok(typical >= 0.9 && typical <= 1.1, String(typical));
  assert.ok(slow >= 2.7 && slow <= 3.3, String(slow));
});

test('Reply times of Claude Code', async () => {
  const html = await healthOf((home) =>
    claudeSession(home, join(home, 'cc'), {
      model: 'claude-opus-5-5',
      calls: [{ at: at('10:00:08'), output: 5, tools: [{ name: 'read', answered: at('10:00:09') }] }, { at: at('10:00:15'), output: 5 }],
    }),
  );

  for (const name of ['typical', 'slow']) {
    const reply = seconds(html, `${name}-claude-opus-5-5`);
    assert.ok(reply >= 5.4 && reply <= 6.6, `${name} ${reply}`);
  }
});

test('opencode calls cut at the maximum length', async () => {
  const html = await healthOf((home) => {
    opencodeSession(home, join(home, 'web'), {
      provider: 'anthropic',
      model: 'claude-fable-5',
      cost: 2,
      callCost: 1,
      calls: [
        { uncached: 10, read: 0, write: 0, output: 5, at: at('10:00'), finish: 'length' },
        { uncached: 10, read: 0, write: 0, output: 5, at: at('10:01'), finish: 'length' },
      ],
    });
    // a model with no cut call draws no row
    omp([call('10:00', COPILOT)])(home);
  });

  assert.equal(figure(html, 'cut-anthropic/claude-fable-5'), '2 · $2.00');
  assert.deepEqual(listOf(html, 'cut'), ['anthropic/claude-fable-5 2 · $2.00']);
});

test('Claude Code calls cut at the maximum length have no cost', async () => {
  const html = await healthOf((home) => claudeSession(home, join(home, 'cc'), { model: 'claude-opus-5-5', calls: [{ at: at('10:00'), output: 5, stop: 'max_tokens' }] }));

  assert.equal(figure(html, 'cut-claude-opus-5-5'), '1 · n/a');
  assert.match(text(parts(html, 'data-part', 'left-out-cut')[0]), /Claude Code/);
});

test('Thinking tokens by model', async () => {
  const html = await healthOf((home) => {
    claudeSession(home, join(home, 'cc'), { model: 'claude-opus-5-5', calls: [{ at: at('10:00'), output: 5, thinking: 183 }] });
    opencode([{ uncached: 10, read: 0, write: 0, output: 5, at: at('10:00'), reasoning: 1000 }], 'openai', 'gpt-5.4')(home);
    omp([call('10:00', COPILOT)])(home);
  });

  assert.deepEqual(listOf(html, 'thinking'), ['openai/gpt-5.4 1,000', 'claude-opus-5-5 183', `${COPILOT_MODEL} n/a`]);
  assert.equal(figure(html, 'thinking-claude-opus-5-5'), '183');
  const [note] = parts(html, 'data-part', 'left-out-thinking');
  assert.match(text(note), /omp/);
});

test('Retries without Claude Code', async () => {
  const html = await healthOf((home) => {
    omp([call('10:00', { recovered: true }), call('10:01', { recovered: true }), call('10:02')])(home);
    claudeSession(home, join(home, 'cc'), { model: 'claude-opus-5-5', calls: [{ at: at('10:00'), output: 5 }] });
  });

  assert.equal(figure(html, 'retries'), '2');
  assert.match(text(parts(html, 'data-part', 'left-out-retries')[0]), /Claude Code/);
});

test('an empty range draws zero figures and no rows', async () => {
  const html = await healthOf(() => {});

  assert.equal(figure(html, 'failed'), '0');
  assert.equal(figure(html, 'retries'), '0');
  for (const list of ['failed-type', 'failed-host', 'failed-provider', 'replies', 'cut', 'thinking']) assert.deepEqual(listOf(html, list), [], list);
  assert.equal(parts(html, 'data-chart').length, 0);
});

test('Every figure has a data-title and a data-meaning', async () => {
  const html = await healthOf((home) => {
    omp([call('10:00', { ...COPILOT, recovered: true }), failed('10:01', 'Connection ECONNRESET', COPILOT)])(home);
  });

  const figures = parts(html, 'data-part', 'figure');
  assert.ok(figures.length >= 6, String(figures.length));
  for (const titled of figures) {
    assert.notEqual(text(parts(titled, 'data-title')[0] ?? ''), '', titled);
    assert.notEqual(text(parts(titled, 'data-meaning')[0] ?? ''), '', titled);
  }
});

test('the range tabs keep their range when the tab changes to Health and back', async () => {
  const opened = await openLive([], { now: CLOCK });
  await opened.openTab('spend', 'month');
  await opened.openTab('health');
  const pressed = (html: string) => parts(parts(html, 'data-part', 'range')[0], 'aria-pressed', 'true').map(text);

  assert.deepEqual(pressed(opened.html()), ['Month']);
  assert.equal(attr(parts(opened.html(), 'aria-selected', 'true')[0], 'data-press'), 'tab:health');
  await opened.openTab('cache');
  assert.deepEqual(pressed(opened.html()), ['Month']);
});

test('Names are data: none draws markup', async () => {
  const remoteHome = tempHome();
  const evil = 'st"<u>x';
  const infra: HostWorkspace = { project: 'infra', name: 'main', agents: ['working'], hostId: 'ssh:starfish-bs', sessionId: 's1', title: 'π - Deploy it' };
  let home = '';
  const opened = await openOnFleet([infra], {
    now: CLOCK,
    homes: { [evil]: remoteHome },
    orca: { 'host list --json': hostListOf(LOCAL_HOST, { kind: 'ssh', id: 'starfish-bs', name: evil, selector: '--host ssh:starfish-bs', connected: true }), 'environment list --json': environmentListOf() },
    prepare: (made) => {
      home = made;
      ompSession(remoteHome, workspace(made, 'infra-main'), {
        title: 'Deploy it',
        calls: [failed('10:00', 'ENOTFOUND', { provider: 'pr"<i>v', model: 'mo"<b>d' }), call('10:01', { provider: 'pr"<i>v', model: 'mo"<b>d', stop: 'length', recovered: true })],
      });
    },
  });
  await caughtUp(home);
  await opened.openTab('health', 'week');

  const html = opened.html();
  for (const injected of ['<u>', '<i>v', '<b>d']) assert.ok(!html.includes(injected), injected);
  assert.deepEqual(listOf(html, 'failed-host'), [`${evil} 1`]);
  assert.deepEqual(listOf(html, 'failed-provider'), ['pr"<i>v 1']);
  for (const name of [`failed-host-${evil}`, 'failed-provider-pr"<i>v', 'typical-pr"<i>v/mo"<b>d', 'slow-pr"<i>v/mo"<b>d', 'cut-pr"<i>v/mo"<b>d', 'thinking-pr"<i>v/mo"<b>d']) {
    assert.equal(parts(html, 'data-figure', name).length, 1, name);
  }
});

test('Rows keep their order', async () => {
  const html = await healthOf((home) => {
    omp([
      failed('10:00', 'ENOTFOUND', { provider: 'b', model: 'm' }),
      failed('10:01', 'ENOTFOUND', { provider: 'a', model: 'm' }),
      failed('10:02', 'ENOTFOUND', { provider: 'c', model: 'm' }),
      failed('10:03', 'ENOTFOUND', { provider: 'c', model: 'm' }),
      call('10:04', { provider: 'z', model: 'm', stop: 'length', duration: 1000 }),
      call('10:05', { provider: 'a', model: 'm', stop: 'length', duration: 1000 }),
      call('10:06', { provider: 'm1', model: 'm', stop: 'length', duration: 1000 }),
      call('10:07', { provider: 'm1', model: 'm', stop: 'length', duration: 1000 }),
    ])(home);
  });

  // most first, equal counts by name
  assert.deepEqual(listOf(html, 'failed-provider'), ['c 2', 'a 1', 'b 1']);
  assert.deepEqual(listOf(html, 'failed-host'), ['local 4']);
  assert.deepEqual(listOf(html, 'cut').map((row) => row.split(' ')[0]), ['m1/m', 'a/m', 'z/m']);
  // by model name
  assert.deepEqual(listOf(html, 'replies').map((row) => row.split(' ')[0]), ['a/m', 'm1/m', 'z/m']);
});

test('Reply times name which is typical and which is slow', async () => {
  const html = await healthOf(omp([call('10:00', { ...COPILOT, duration: 1000 })]));

  assert.deepEqual(listOf(html, 'replies').map((row) => row.replace(/\d+\.\d+s/g, 'T')), [`${COPILOT_MODEL} typical T · slow T`]);
});

test('a store that cannot be opened draws n/a figures and no rows', async () => {
  // a folder where the store's file should be
  const { mounted } = await mountOn([], { now: CLOCK, prepare: (home) => mkdirSync(join(home, STORE_FILE), { recursive: true }) });
  const answer = (await mounted.request('spyhop.range', { request: 1, tab: 'health', range: 'week' })) as RangeAnswer;

  const html = healthTab(answer);
  assert.equal(figure(html, 'failed'), 'n/a');
  assert.equal(figure(html, 'retries'), 'n/a');
  assert.deepEqual(listOf(html, 'failed-type'), []);
});
