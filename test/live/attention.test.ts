// The attention list of the fleet screen (src/live/fleet.ts), from the worker's answer
// (src/fleet.ts): above the sessions, a row per blocked or waiting Orca agent, per session at 75%
// of its window or more, and per agent not working whose prompt cache goes cold within 2 minutes,
// in that order of kinds, and within a kind the longest held first; each row opens its session's
// screen. Drawn from the real worker's answer over omp and opencode sessions under a temporary
// home, and over a paired Orca server the stand-in `orca` plays (test/helpers/live.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { NOW, opencodeCalls, workspace } from '../helpers/agent-cards.ts';
import { tempHome } from '../helpers/files.ts';
import { FIX, fleetOf, folderOf, type OmpCall, ompAutocompacts, ompSession, ompWindow, openOnFleet, titles, until } from '../helpers/live.ts';
import { attr, figure, parts, text } from '../helpers/markup.ts';
import { JEFF_AGENT_LIST, JEFF_LISTS, JEFF_TERMINAL_LIST } from '../helpers/orca-answers.ts';
import type { HostWorkspace } from '../helpers/orca-host.ts';
import { serverAgent } from '../helpers/server-agent.ts';
import { answer } from '../helpers/stand-ins.ts';

const MINUTE = 60_000;

// An omp session of the fleet: the title of its Orca agent and its session, the agent's Orca
// state, how long it has been in it (ms; none when not given) and the session's model calls.
type Session = { title: string; state: HostWorkspace['agents'][number]; since?: number; calls: OmpCall[] };

// One model call `ago` ms before NOW (a minute when not given) with `context` tokens after it,
// which wrote to a prompt cache that lasts `cttl` (5 minutes or an hour) when given.
const call = (context: number, ago = MINUTE, cttl?: OmpCall['cttl']): OmpCall => ({ at: NOW - ago, output: 100, cost: 0.1, context, cttl });

// A workspace of this computer per session, each with the session's one omp Orca agent.
const workspacesOf = (sessions: Session[]) =>
  sessions.map(({ title, state, since = 0 }, i): HostWorkspace => ({ project: 'api', name: `w${i}`, agents: [state], title: `π - ${title}`, stateStartedAt: NOW - since }));

// The sessions under `home`, of the workspaces `workspacesOf` gives, on a window of 1,000,000
// tokens; with `autocompacts`, omp's config with its default trigger, else none.
function writeSessions(home: string, sessions: Session[], autocompacts = false) {
  ompWindow(home, 1_000_000);
  if (autocompacts) ompAutocompacts(home);
  const workspaces = workspacesOf(sessions);
  sessions.forEach(({ title, calls }, i) => ompSession(home, folderOf(home, workspaces[i]), { title, calls }));
}

// The fleet screen of `sessions`.
async function fleetWith(sessions: Session[], autocompacts = false) {
  const { html } = await fleetOf(workspacesOf(sessions), { prepare: (home) => writeSessions(home, sessions, autocompacts) });
  return html;
}

// The rows of the attention list of the fleet screen `html`, none without one.
const rowsOf = (html: string) => parts(parts(html, 'data-part', 'attention')[0] ?? '', 'data-row');

test('Kinds in order', async () => {
  const html = await fleetWith([
    { title: 'a', state: 'waiting', since: 2 * MINUTE, calls: [call(200_000, MINUTE, '5m')] },
    { title: 'b', state: 'working', calls: [call(800_000)] },
    { title: 'c', state: 'done', calls: [call(300_000, 4 * MINUTE, '5m')] },
  ]);

  const rows = rowsOf(html);
  assert.deepEqual(
    rows.map((row) => [attr(row, 'data-row'), text(row)]),
    [
      ['state', 'waiting a 2m'],
      ['context', 'context b 80%'],
      ['cache', 'cache c cold in 1:00 · 300k to write again'],
    ],
  );
  assert.ok(html.indexOf('data-part="attention"') < html.indexOf('data-part="group"'));
});

test('Empty list is not drawn', async () => {
  const html = await fleetWith([{ title: 'Fix the login bug', state: 'working', calls: [call(200_000)] }]);

  assert.deepEqual(parts(html, 'data-part', 'attention'), []);
});

test('Row opens the session screen', async () => {
  const opened = await openOnFleet([FIX], {
    prepare: (home) => {
      ompWindow(home, 1_000_000);
      ompSession(home, folderOf(home, FIX), { title: 'Fix the login bug', calls: [call(800_000)] });
    },
  });
  const [row] = parts(opened.html(), 'data-row', 'context');
  assert.match(row, /^<[^>]* role="button" tabindex="0"/);

  opened.live.press(attr(row, 'data-press')!);

  assert.equal(attr(opened.html(), 'data-screen'), 'session');
  await until(() => parts(opened.html(), 'data-part', 'loading').length === 0);
  assert.deepEqual(titles(opened.html()), ['Fix the login bug']);
});

test('Longest in its state first', async () => {
  const html = await fleetWith([
    { title: 'a', state: 'blocked', since: 6 * MINUTE, calls: [call(200_000)] },
    { title: 'b', state: 'waiting', since: 9 * MINUTE, calls: [call(200_000)] },
    { title: 'c', state: 'working', calls: [call(200_000)] },
  ]);

  assert.deepEqual(rowsOf(html).map(text), ['waiting b 9m', 'blocked a 6m']);
});

test('Context at 75% or more', async () => {
  const html = await fleetWith(
    [
      { title: 'Fix the login bug', state: 'working', calls: [call(800_000)] },
      { title: 'Write the docs', state: 'working', calls: [call(740_000)] },
    ],
    true,
  );

  assert.deepEqual(rowsOf(html).map(text), ['context Fix the login bug 80% · 50k left']);
});

test('Longest at 75% or more first', async () => {
  // listed after the one at 75% or more longer, so that only the order by time can put it first
  const html = await fleetWith([
    { title: 'b', state: 'working', calls: [call(500_000, 30 * MINUTE), call(760_000, 5 * MINUTE), call(920_000)] },
    { title: 'a', state: 'working', calls: [call(500_000, 30 * MINUTE), call(760_000, 20 * MINUTE), call(780_000)] },
  ]);

  const rows = rowsOf(html);
  assert.deepEqual(rows.map(text), ['context a 78%', 'context b 92%']);
  assert.equal(figure(rows[1], 'tokensLeft'), undefined);
});

test('Cache about to go cold', async () => {
  const html = await fleetWith([{ title: 'Fix the login bug', state: 'done', calls: [call(620_000, 4 * MINUTE + 18_000, '5m')] }]);

  const rows = rowsOf(html);
  assert.deepEqual(rows.map(text), ['cache Fix the login bug cold in 0:42 · 620k to write again']);
  assert.equal(figure(rows[0], 'coldIn'), '0:42');
  assert.equal(figure(rows[0], 'rewriteTokens'), '620k');
});

test('Cache that goes cold soonest first', async () => {
  const html = await fleetWith([
    { title: 'a', state: 'done', calls: [call(200_000, 3 * MINUTE + 30_000, '5m')] },
    { title: 'b', state: 'done', calls: [call(200_000, 4 * MINUTE + 30_000, '5m')] },
  ]);

  assert.deepEqual(rowsOf(html).map(text), ['cache b cold in 0:30 · 200k to write again', 'cache a cold in 1:30 · 200k to write again']);
});

test('Cache row of a one-hour cache', async () => {
  const sessions: Session[] = [{ title: 'Fix the login bug', state: 'done', calls: [call(28_871, 58 * MINUTE + 30_000, '1h')] }];
  const { answer, html } = await fleetOf(workspacesOf(sessions), { prepare: (home) => writeSessions(home, sessions) });

  const rows = rowsOf(html);
  assert.deepEqual(rows.map(text), ['cache Fix the login bug cold in 1:30 · 29k to write again']);
  assert.equal(figure(rows[0], 'coldIn'), '1:30');
  assert.equal(answer.attention[0].rewriteTokens, 28_871);
});

test('Sessions that get no cache row', async () => {
  const sessions: Session[] = [
    { title: 'working', state: 'working', calls: [call(200_000, 4 * MINUTE, '5m')] },
    { title: 'cold', state: 'done', calls: [call(200_000, 6 * MINUTE, '5m')] },
    { title: 'later', state: 'done', calls: [call(200_000, 2 * MINUTE, '5m')] },
  ];
  const opencode: HostWorkspace = { project: 'web', name: 'main', agents: ['done'], harness: 'opencode' };
  const { html } = await fleetOf([...workspacesOf(sessions), opencode], {
    prepare: (home) => {
      writeSessions(home, sessions);
      opencodeCalls(home, workspace(home, 'web-main'), { provider: 'github-copilot', model: 'claude-haiku-5.5', contexts: [40_000] });
    },
  });

  // the opencode agent links to its session, whose context is read
  const folded = parts(html, 'data-part', 'folded').find((line) => text(line).includes('web-main'));
  assert.equal(figure(folded!, 'tokens'), '40k');
  assert.deepEqual(parts(html, 'data-row', 'cache'), []);
});

test('Agent of a paired Orca server', async () => {
  const remoteHome = tempHome();
  const listed = { ...serverAgent(join(remoteHome, 'work/spyhop-main'), 'main', 'tab1:leaf2', { state: 'blocked' }), updatedAt: new Date(NOW - 6 * MINUTE).toISOString() };
  const { html } = await fleetOf([], {
    homes: { jeff: remoteHome },
    orca: { ...JEFF_LISTS, [JEFF_AGENT_LIST]: answer({ agents: [listed] }), [JEFF_TERMINAL_LIST]: answer({ terminals: [], totalCount: 0, truncated: false }) },
  });

  const [card] = parts(parts(html, 'data-host', 'jeff')[0], 'data-part', 'card');
  assert.match(text(card), /blocked · 6m/);
  const rows = rowsOf(html);
  assert.equal(rows.length, 1);
  assert.equal(attr(rows[0], 'data-row'), 'state');
  assert.equal(figure(rows[0], 'since'), '6m');
});
