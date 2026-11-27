// A session's sub-agents: the session screen's Sub-agents section, with its running rows and the
// bars of the sub-agents that started most recently, `Show all`, and the card's sub-agent and
// cache chips, drawn from the real worker's answers over omp and Claude Code session files and
// their sub-agents' transcripts under a temporary home (test/helpers/live.ts), and read through
// the markup's conventions (test/helpers/markup.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NOW, workspace } from '../helpers/agent-cards.ts';
import {
  claudeSession,
  claudeSubAgent,
  FIX,
  fleetOf,
  folderOf,
  ompSession,
  ompSubAgent,
  type OmpCall,
  open,
  openOnFleet,
  sessionOf,
  spent,
} from '../helpers/live.ts';
import { attr, figure, parts, text } from '../helpers/markup.ts';
import type { HostWorkspace } from '../helpers/orca-host.ts';

const MINUTE = 60_000;
// This computer's workspace `web`/`main`, with one working Claude Code agent.
const CLAUDE: HostWorkspace = { project: 'web', name: 'main', agents: ['working'], harness: 'claude' };

// A sub-agent of `subAgents` below: its name (a path for one another started) and its transcript.
type Sub = { name: string } & Parameters<typeof ompSubAgent>[3];

// Writes FIX's omp session under `home`, of one model call of 1 USD and `subAgents`.
const ompWith = (subAgents: Sub[], own: OmpCall[] = [spent(1, NOW - 30 * MINUTE)]) => (home: string) => {
  const path = folderOf(home, FIX);
  ompSession(home, path, { title: 'Fix the login bug', calls: own });
  for (const { name, ...sub } of subAgents) ompSubAgent(home, path, name, sub);
};

// The Sub-agents section of the session screen `html`.
const sectionOf = (html: string) => parts(html, 'data-part', 'subagents')[0];

// Each sub-agent bar of `html`, as its label reads it: its name, kind, model and cost.
const bars = (html: string) => parts(html, 'data-agent').map((bar) => text(parts(bar, 'class', 'row label')[0]));

// The sub-agents `S1` to `S10`, started a minute apart in that order, each at 0.10 USD and ended,
// `S1` to `S5` of the kind `implementer` and `S6` to `S10` of the kind `reviewer`.
const TEN: Sub[] = Array.from({ length: 10 }, (_, i) => {
  const at = NOW - (20 - i) * MINUTE;
  return { name: `S${i + 1}`, init: { at, kind: i < 5 ? 'implementer' : 'reviewer' }, calls: [spent(0.1, at + 1000)] };
});

test('Cost of a Claude Code session with sub-agents', async () => {
  const at10 = Date.parse('2026-11-25T10:00:00.000Z');
  const { html } = await sessionOf([CLAUDE], {
    now: at10 + 3 * 60 * MINUTE + MINUTE,
    prepare: (home) => {
      const path = workspace(home, 'web-main');
      claudeSession(home, path, { calls: [{ at: at10, uncached: 1000 }, { at: at10 + 3 * 60 * MINUTE, uncached: 1000 }], cost: 39.33 });
      claudeSubAgent(home, path, 'a1', { calls: [{ at: at10 + 10 * MINUTE, uncached: 500 }], model: 'haiku' });
      claudeSubAgent(home, path, 'a2', { calls: [{ at: at10 + 20 * MINUTE, uncached: 500 }], model: 'haiku' });
    },
  });

  assert.equal(figure(html, 'cost'), '$39.33');
  assert.equal(figure(html, 'subShare'), 'n/a');
  const [costCard] = parts(html, 'class', 'cost-card');
  assert.equal(figure(costCard, 'total'), '$39.33');
  assert.equal(figure(costCard, 'perHour'), '$13.11/h');
  assert.deepEqual(parts(html, 'data-chart', 'cost'), []);
  assert.equal(figure(sectionOf(html), 'subCost'), 'n/a');
});

test('Running sub-agents', async () => {
  const { html } = await sessionOf([FIX], {
    prepare: ompWith([
      { name: 'DashFacts', running: true, init: { at: NOW - 9 * MINUTE, kind: 'scout', task: 'what data each harness records' }, calls: [spent(0.92, NOW - 8 * MINUTE)] },
      { name: 'OrcaDocs', running: true, init: { at: NOW - 5 * MINUTE, kind: 'scout', task: 'what a plugin panel can draw' }, calls: [spent(0.27, NOW - 4 * MINUTE)] },
      { name: 'Rev54', init: { at: NOW - 20 * MINUTE, kind: 'reviewer', task: 'review the slice' }, calls: [spent(0.61, NOW - 15 * MINUTE)] },
    ]),
  });

  const section = sectionOf(html);
  assert.equal(text(parts(section, 'class', 'row head')[0]), 'Sub-agents 2 running · 3 in total · $1.80');
  assert.deepEqual(parts(section, 'class', 'row item').map(text), [
    'scout · DashFacts · what data each harness records · 9m · $0.92',
    'scout · OrcaDocs · what a plugin panel can draw · 5m · $0.27',
  ]);
});

test('Eight most recent sub-agents', async () => {
  const { html } = await sessionOf([FIX], { prepare: ompWith(TEN) });

  const section = sectionOf(html);
  const drawn = parts(section, 'data-agent');
  assert.deepEqual(
    bars(section).map((label) => label.split(' · ')[0]),
    ['S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10'],
  );
  for (const label of bars(section)) assert.match(label, / · \$0\.10$/);
  assert.ok(drawn.every((bar) => attr(bar, 'data-cost') === '0.1'));
  const kinds = drawn.map((bar) => /\bkind-\d\b/.exec(attr(bar, 'class')!)![0]);
  assert.equal(new Set(kinds.slice(0, 3)).size, 1);
  assert.equal(new Set(kinds.slice(3)).size, 1);
  assert.notEqual(kinds[0], kinds[3]);
  assert.match(text(section), /\b2 earlier\b/);
  assert.equal(parts(section, 'data-press', 'all').length, 1);
});

test('Show all', async () => {
  const opened = await openOnFleet([FIX], { prepare: ompWith(TEN) });
  await open(opened, 'Fix the login bug');
  assert.equal(bars(opened.html()).length, 8);

  opened.live.press('all');

  assert.deepEqual(
    bars(opened.html()).map((label) => label.split(' · ')[0]),
    TEN.map(({ name }) => name),
  );
  for (const label of bars(opened.html())) assert.match(label, / · \$0\.10$/);
  assert.equal(parts(opened.html(), 'data-press', 'all').length, 0);
  // the screen changes: the session's screen opened again shows the eight latest
  opened.live.press('back');
  await open(opened, 'Fix the login bug');
  assert.equal(bars(opened.html()).length, 8);
});

test('Eight sub-agents or fewer', async () => {
  const { html } = await sessionOf([FIX], {
    prepare: ompWith([
      { name: 'Impl1', calls: [spent(0.1, NOW - 10 * MINUTE)] },
      { name: 'Scout1', calls: [spent(0.1, NOW - 6 * MINUTE)] },
      { name: 'Impl1/Rev1', calls: [spent(0.1, NOW - 8 * MINUTE)] },
    ]),
  });

  const section = sectionOf(html);
  assert.deepEqual(
    bars(section).map((label) => label.split(' · ')[0]),
    ['Impl1', 'Rev1', 'Scout1'],
  );
  assert.deepEqual(parts(section, 'data-press', 'all'), []);
  assert.doesNotMatch(text(section), /earlier/);
});

test('Claude Code sub-agent', async () => {
  const { html } = await sessionOf([CLAUDE], {
    prepare: (home) => {
      const path = workspace(home, 'web-main');
      claudeSession(home, path, { calls: [{ at: NOW - 30 * MINUTE, uncached: 99_900, output: 100 }], cost: 1 });
      claudeSubAgent(home, path, 'a1', {
        calls: [{ at: NOW - 20 * MINUTE, uncached: 74_000, output: 880 }],
        model: 'haiku',
        meta: { agentType: 'claude', description: 'Install k3s on jeff-ubuntu' },
      });
    },
  });

  const section = sectionOf(html);
  assert.deepEqual(bars(section), ['Install k3s on jeff-ubuntu · claude · haiku · n/a']);
  assert.equal(figure(section, 'running'), undefined);
  assert.doesNotMatch(text(section), /running/);
  assert.deepEqual(parts(section, 'class', 'row item'), []);
  assert.equal(figure(html, 'tokens'), '175k');
});

test('Start and end from the entries', async () => {
  const at = (clock: string) => Date.parse(`2026-11-25T${clock}.000Z`);
  const { html } = await sessionOf([FIX], {
    now: at('12:20:00'),
    prepare: ompWith(
      [
        {
          name: 'Impl1',
          init: { at: at('12:10:00'), kind: 'implementer' },
          calls: [spent(0.1, at('12:11:00')), spent(0.1, at('12:14:00'))],
          compactions: [{ at: at('12:14:30'), before: 1000, after: 100 }],
        },
      ],
      [spent(1, at('12:05:00'))],
    ),
  });

  const [bar] = parts(sectionOf(html), 'data-agent');
  assert.equal(attr(bar, 'data-start'), String(at('12:10:00')));
  assert.equal(attr(bar, 'data-end'), String(at('12:14:30')));
});

test('Value the harness did not record', async () => {
  const { html } = await sessionOf([FIX], { prepare: ompWith([{ name: 'Impl1', calls: [spent(0.1, NOW - 10 * MINUTE)] }]) });

  const [bar] = parts(sectionOf(html), 'data-agent');
  assert.ok(bar);
  assert.equal(attr(bar, 'data-kind'), 'n/a');
  assert.match(parts(bar, 'data-chart', 'subagents')[0], /<rect/);
  assert.deepEqual(bars(html), ['Impl1 · n/a · n/a · $0.10']);
});

// A call that read 93 of its prompt's 100 tokens from the cache and wrote none to it.
const cached = (at: number): OmpCall => ({ at, read: 93, write: 0, uncached: 7, output: 10, cost: 1 });

test('Sub-agent and cache chips', async () => {
  const writeOmp = ompWith(
    [
      { name: 'Impl1', running: true, calls: [spent(0.1, NOW - 10 * MINUTE)] },
      { name: 'Impl2', running: true, calls: [spent(0.1, NOW - 9 * MINUTE)] },
      { name: 'Rev1', calls: [spent(0.1, NOW - 8 * MINUTE)] },
    ],
    [cached(NOW - 30 * MINUTE)],
  );
  const { html } = await fleetOf([FIX, CLAUDE], {
    prepare: (home) => {
      writeOmp(home);
      // Claude Code does not tell whether a sub-agent runs: its chip says how many there are
      const path = workspace(home, 'web-main');
      claudeSession(home, path, { calls: [{ at: NOW - 30 * MINUTE, uncached: 1000 }], cost: 1 });
      claudeSubAgent(home, path, 'a1', { calls: [{ at: NOW - 20 * MINUTE, uncached: 500 }], model: 'haiku' });
      claudeSubAgent(home, path, 'a2', { calls: [{ at: NOW - 10 * MINUTE, uncached: 500 }], model: 'haiku' });
    },
  });

  const cards = parts(html, 'data-part', 'card');
  const card = cards.find((found) => text(found).startsWith('Fix the login bug'))!;
  assert.deepEqual(parts(card, 'data-chip').map(text), ['2 sub-agents running', '3 in total', 'cache 93%']);
  assert.deepEqual(parts(card, 'data-chip', 'subagents').map(text), ['2 sub-agents running', '3 in total']);
  assert.deepEqual(parts(card, 'data-chip', 'cache').map(text), ['cache 93%']);
  const claudeCard = cards.find((found) => text(found).includes('Claude Code'))!;
  assert.deepEqual(parts(claudeCard, 'data-chip', 'subagents').map(text), ['2 sub-agents']);
});

test('Card of a session without sub-agents', async () => {
  const { html } = await fleetOf([FIX], { prepare: ompWith([], [cached(NOW - 30 * MINUTE)]) });

  const [card] = parts(html, 'data-part', 'card');
  assert.deepEqual(parts(card, 'data-chip', 'cache').map(text), ['cache 93%']);
  assert.deepEqual(parts(card, 'data-chip', 'subagents'), []);
});
