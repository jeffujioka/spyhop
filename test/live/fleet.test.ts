// The fleet screen (src/live/fleet.ts): the header with the counts by Orca state, the groups by
// Orca host, a card per session that is not done and a folded line per done one, drawn from the
// real worker's answer over session files under a temporary home (test/helpers/live.ts), and
// read through the markup's conventions (test/helpers/markup.ts). And the stylesheet's fonts.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { formatAge, formatCount } from '../../src/core/format.js';
import { STYLE } from '../../src/live/style.ts';
import { NOW, workspace } from '../helpers/agent-cards.ts';
import { claudeCalls, fleetOf, ompAutocompacts, ompCalls, ompWindow } from '../helpers/live.ts';
import { figure, parts, text } from '../helpers/markup.ts';

// `count` contexts rising to `last`, the context after the last call.
const rising = (count: number, last: number) => Array.from({ length: count }, (_, i) => Math.round((last * (i + 1)) / count));

// The workspace `api`/`main` with one working omp agent per title, each linked to the session of
// its title, in the sub-folder `folders[i]` of the workspace folder, with `contexts[i]` of a window
// of 1,000,000 tokens; `autocompacts`: omp's config with its default trigger, else none.
async function workingSessions(sessions: { title: string; folder: string; contexts: number[]; cost?: number }[], autocompacts = false) {
  return fleetOf([{ project: 'api', name: 'main', agents: sessions.map(() => 'working'), titles: sessions.map(({ title }) => `π - ${title}`) }], {
    prepare: (home) => {
      ompWindow(home, 1_000_000);
      if (autocompacts) ompAutocompacts(home);
      for (const { title, folder, contexts, cost } of sessions) ompCalls(home, join(workspace(home, 'api-main'), folder), { title, contexts, cost });
    },
  });
}

test('Counts by state', async () => {
  const { html } = await fleetOf([{ project: 'api', name: 'main', agents: ['done', 'working', 'blocked', 'done', 'working', 'done'] }]);

  const [header] = parts(html, 'data-part', 'header');
  assert.match(text(header), /Spyhop/);
  assert.equal(text(parts(header, 'data-part', 'live')[0]), 'live');
  const [counts] = parts(html, 'data-part', 'counts');
  assert.equal(text(counts), '1 blocked · 2 working · 3 done');
  assert.doesNotMatch(counts, /waiting/);
});

test('No project or workspace rows', async () => {
  const { html } = await fleetOf(
    [
      { project: 'api', name: 'main', agents: ['working'], title: 'π - Write the docs' },
      { project: 'api', name: 'fix-login', agents: ['working'], title: 'π - Fix the login bug' },
    ],
    {
      prepare: (home) => {
        ompCalls(home, join(workspace(home, 'api-main'), 'docs'), { title: 'Write the docs', contexts: [] });
        ompCalls(home, join(workspace(home, 'api-fix-login'), 'login'), { title: 'Fix the login bug', contexts: [] });
      },
    },
  );

  const [group] = parts(html, 'data-part', 'group');
  assert.equal(parts(html, 'data-part', 'group').length, 1);
  assert.equal(parts(group, 'data-host', 'local').length, 1);
  assert.equal(parts(group, 'data-part', 'card').length, 2);
  // the group's text without its cards: its name and its count
  const between = parts(group, 'data-part', 'card').reduce((rest, card) => rest.replace(card, ''), group);
  assert.equal(text(between), 'local · 2');
  for (const word of ['api', 'main', 'fix-login', 'Total', 'Focused']) assert.doesNotMatch(text(html), new RegExp(`\\b${word}\\b`));
});

test('Done agent as one line', async () => {
  const { html } = await fleetOf([{ project: 'api', name: 'main', agents: ['done'], title: 'π - Review the tunnel' }], {
    prepare: (home) => {
      ompWindow(home, 1_000_000);
      ompAutocompacts(home);
      ompCalls(home, join(workspace(home, 'api-main'), 'chapo'), { title: 'Review the tunnel', contexts: rising(20, 340_000), cost: 9.25 });
    },
  });

  const folded = parts(html, 'data-part', 'folded');
  assert.equal(folded.length, 1);
  assert.deepEqual(parts(html, 'data-part', 'card'), []);
  assert.equal(text(folded[0]), 'Review the tunnel chapo 34% $9.25');
  assert.equal(figure(folded[0], 'cost'), '$9.25');
  for (const attr of ['data-chart', 'data-chip']) assert.deepEqual(parts(folded[0], attr), []);
  // a control the keyboard reaches and presses, as a <button> is
  assert.match(folded[0], /^<div [^>]*role="button" tabindex="0"[^>]*data-press="open:/);
  for (const part of ['bar', 'burn']) assert.deepEqual(parts(folded[0], 'data-part', part), []);
});

test('Card of a working omp agent', async () => {
  const { html } = await fleetOf([{ project: 'api', name: 'main', agents: ['working'], title: 'π - Review the plan' }], {
    prepare: (home) => {
      const boto = join(workspace(home, 'api-main'), 'boto');
      mkdirSync(boto, { recursive: true });
      execFileSync('git', ['init', '-q', '-b', 'feat/jaci'], { cwd: boto });
      ompCalls(home, boto, { title: 'Review the plan', contexts: [], cost: 16.05 });
    },
  });

  const [card] = parts(html, 'data-part', 'card');
  assert.match(card, /^<[^>]* data-state="working"/);
  // a control the keyboard reaches and presses, as a <button> is
  assert.match(card, /^<article [^>]*role="button" tabindex="0"[^>]*data-press="open:/);
  assert.equal(figure(card, 'cost'), '$16.05');
  assert.match(text(card), /boto · feat\/jaci · omp · claude-opus-5\.5-1m working · /);
});

test('Folder that is no git repository', async () => {
  const { html } = await workingSessions([{ title: 'Look around', folder: 'projects', contexts: [] }]);

  const [card] = parts(html, 'data-part', 'card');
  assert.match(text(card), / projects · omp · claude-opus-5\.5-1m working · /);
});

test('Agent on this computer', async () => {
  const { html } = await fleetOf([{ project: 'api', name: 'main', agents: ['working'], title: 'π - Fix it', stateStartedAt: NOW - 180_000 }], {
    prepare: (home) => ompCalls(home, join(workspace(home, 'api-main'), 'boto'), { title: 'Fix it', contexts: [] }),
  });

  const [card] = parts(html, 'data-part', 'card');
  assert.match(text(card), /working · 3m/);
});

test('Context of an omp session', async () => {
  const { html } = await workingSessions([{ title: 'Fix the login bug', folder: 'login', contexts: rising(40, 620_000) }], true);

  const [card] = parts(html, 'data-part', 'card');
  assert.equal(figure(card, 'percent'), '62%');
  assert.match(text(card), /620k \/ 1M/);
  const [bar] = parts(card, 'data-part', 'bar');
  assert.match(bar, /^<[^>]* class="[^"]*\blvl-warning\b/);
  assert.match(bar, /^<[^>]* data-fill="0\.62"/);
  assert.match(bar, /^<[^>]* data-mark="0\.85"/);
  const [spark] = parts(card, 'data-chart', 'spark');
  assert.match(spark, /^<svg[^>]* data-points="30"/);
});

test('Short session with no known compaction point', async () => {
  const { html } = await workingSessions([{ title: 'Fix the login bug', folder: 'login', contexts: rising(12, 200_000) }]);

  const [card] = parts(html, 'data-part', 'card');
  assert.match(parts(card, 'data-chart', 'spark')[0], /^<svg[^>]* data-points="12"/);
  const [bar] = parts(card, 'data-part', 'bar');
  assert.match(bar, /data-fill="0\.2"/);
  assert.doesNotMatch(bar, /data-mark/);
});

test('Warning chip at 75% or more', async () => {
  const { html } = await workingSessions(
    [
      { title: 'Near the end', folder: 'near', contexts: rising(10, 800_000) },
      { title: 'Well within', folder: 'within', contexts: rising(10, 620_000) },
      // 74.6% of the window, which the card writes 75%
      { title: 'At the rounded bound', folder: 'rounded', contexts: rising(10, 746_000) },
    ],
    true,
  );

  const [near, within, rounded] = parts(html, 'data-part', 'card');
  assert.deepEqual(parts(near, 'data-chip', 'warning').map(text), ['50k left']);
  assert.deepEqual(parts(within, 'data-chip', 'warning'), []);
  assert.equal(figure(rounded, 'percent'), '75%');
  assert.equal(parts(rounded, 'data-chip', 'warning').length, 1);
});

test('Levels at their bounds', async () => {
  const percents = [59, 60, 74, 75, 89, 90];
  const { html } = await workingSessions(percents.map((percent) => ({ title: `At ${percent}`, folder: `at${percent}`, contexts: rising(5, percent * 10_000) })));

  const cards = parts(html, 'data-part', 'card');
  assert.deepEqual(
    cards.map((card) => /\blvl-(\w+)\b/.exec(parts(card, 'data-part', 'bar')[0])?.[1]),
    ['ok', 'warning', 'warning', 'hot', 'hot', 'critical'],
  );
  assert.deepEqual(cards.map((card) => figure(card, 'percent')), percents.map((percent) => `${percent}%`));
});

test('Card of a session without a window', async () => {
  const { html } = await fleetOf([{ project: 'web', name: 'main', agents: ['working'], harness: 'claude' }], {
    prepare: (home) => claudeCalls(home, workspace(home, 'web-main'), rising(12, 120_000)),
  });

  const [card] = parts(html, 'data-part', 'card');
  assert.equal(figure(card, 'tokens'), '120k');
  assert.match(parts(card, 'data-chart', 'spark')[0], /^<svg[^>]* data-points="12"/);
  assert.equal(figure(card, 'percent'), undefined);
  assert.equal(figure(card, 'window'), undefined);
  // no percent of a window: the cache chip's percent is the cache hit rate
  assert.doesNotMatch(text(parts(card, 'class', 'context')[0]), /%/);
  assert.deepEqual(parts(card, 'data-part', 'bar'), []);
  assert.deepEqual(parts(card, 'data-chip', 'warning'), []);
  assert.deepEqual(parts(html, 'data-part', 'attention'), []);
});

test('Figures and text', async () => {
  const { html } = await workingSessions([{ title: 'Fix the login bug', folder: 'login', contexts: [], cost: 1.2 }]);

  const [card] = parts(html, 'data-part', 'card');
  assert.match(parts(card, 'data-figure', 'cost')[0], /^<[^>]* class="num"/);
  assert.equal(figure(card, 'cost'), '$1.20');
  const [, titleAttrs] = /<\w+([^>]*)>Fix the login bug</.exec(card) ?? [];
  assert.notEqual(titleAttrs, undefined);
  assert.doesNotMatch(titleAttrs, /\bnum\b/);
  assert.match(STYLE, /\.num\s*\{[^}]*font-family:\s*var\(--orca-font-mono\)[^}]*\}/);
  assert.match(STYLE, /\.num\s*\{[^}]*font-variant-numeric:\s*tabular-nums[^}]*\}/);
  assert.match(STYLE, /body\s*\{[^}]*font-family:\s*var\(--orca-font-sans\)[^}]*\}/);
});

test('a title with markup is shown as text', async () => {
  const { html } = await workingSessions([{ title: '<b>&"x', folder: 'odd', contexts: [] }]);

  assert.match(html, /&lt;b&gt;&amp;&quot;x/);
  assert.doesNotMatch(html, /<b>&"x/);
});

// A guard of the texts of an age and a count, no scenario of the spec.
test('ages and counts as the panel writes them', () => {
  assert.deepEqual([45_000, 180_000, 7_500_000, 'n/a' as const].map(formatAge), ['45s', '3m', '2h 05m', 'n/a']);
  assert.deepEqual([1206, 7, 1_000_000, 'n/a' as const].map(formatCount), ['1,206', '7', '1,000,000', 'n/a']);
});

// A guard of a format the spec leaves open, no scenario of it: a folded line without a window
// shows its tokens in place of the percent.
test('a folded line without a window shows its tokens', async () => {
  const { html } = await fleetOf([{ project: 'web', name: 'main', agents: ['done'], harness: 'claude' }], {
    prepare: (home) => claudeCalls(home, workspace(home, 'web-main'), rising(12, 120_000)),
  });

  const [line] = parts(html, 'data-part', 'folded');
  assert.equal(figure(line, 'tokens'), '120k');
  assert.equal(figure(line, 'percent'), undefined);
  // the cost of a Claude Code session that logs none reads n/a, which is the cost, not the context
  assert.doesNotMatch(text(line), /%/);
});

