// The session summaries, sub-agent rows and Traces the catch-up keeps in the history store: one
// summary per harness session that is not a sub-agent, its sub-agents counted in it, and the
// Trace of its lanes and sub-agents, with no text of a prompt, a task or a tool call kept. The
// store, the runner and the programs are the real ones, under a temporary home; the first catch-up
// runs in the real worker on orca/testing's mock host (test/helpers/live.ts).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { run, runBytes } from '../../src/exec.ts';
import { createCatchUp } from '../../src/history/catch-up.ts';
import { openStore, STORE_FILE, type Store } from '../../src/history/store.ts';
import { expect } from '../core/helpers/expect.ts';
import { NOW, opencodeSession } from '../helpers/agent-cards.ts';
import { setEnv, useTempHome } from '../helpers/env.ts';
import { caughtUp, storeOf } from '../helpers/history.ts';
import { claudeSession, claudeSubAgent, mountOn, ompSession, ompSubAgent, spent } from '../helpers/live.ts';

let store: Store | undefined;
afterEach(() => {
  store?.close();
  store = undefined;
});

// A catch-up of this computer over a new temporary home, in UTC.
async function catchUpOf() {
  setEnv('TZ', 'UTC');
  const home = useTempHome();
  store = await openStore(home);
  const catchUp = createCatchUp({ run, runBytes, store, home, log: () => {}, hosts: async () => [] });
  return { home, store, catchUp };
}

// The ids of the sessions the store of `home` keeps a summary of.
function summarized(home: string) {
  const db = storeOf(home);
  try {
    return db.prepare('SELECT id FROM sessions ORDER BY id').all().map(({ id }) => id);
  } finally {
    db.close();
  }
}

const omp = (file: string) => `local\0omp\0${file}`;

describe('session summaries', () => {
  test('Summary of a session with sub-agents', async () => {
    const { home, store, catchUp } = await catchUpOf();
    const folder = join(home, 'deploy');
    const main = ompSession(home, folder, {
      title: 'Ship the deploy script',
      calls: [spent(1, NOW - 60_000)],
      results: [{ at: NOW - 20_000, jobs: [{ jobId: 'Impl1', status: 'completed' }] }],
    });
    const impl = ompSubAgent(home, folder, 'Impl1', {
      calls: [spent(0.3, NOW - 50_000)],
      parent: main,
      results: [{ at: NOW - 30_000, jobs: [{ jobId: 'Rev1', status: 'failed' }] }],
    });
    ompSubAgent(home, folder, 'Impl1/Rev1', { calls: [spent(0.2, NOW - 40_000)], parent: impl });

    await catchUp.run();

    const summary = store.summary(omp(main))!;
    expect(summary).toMatchObject({ title: 'Ship the deploy script', harness: 'omp', host: 'local', subAgents: 2 });
    expect(summary.cost).toBeCloseTo(1.5, 9);
    expect(summarized(home)).toEqual([omp(main)]);
    const agents = store.trace(omp(main))!.agents.map(({ name, status, cost, depth }) => ({ name, status, cost, depth }));
    expect(agents).toEqual([
      { name: 'Impl1', status: 'completed', cost: 0.3, depth: 0 },
      { name: 'Rev1', status: 'failed', cost: 0.2, depth: 1 },
    ]);
  });

  test('Prompt and tool output not kept', async () => {
    const { home, store, catchUp } = await catchUpOf();
    const folder = join(home, 'deploy');
    const main = ompSession(home, folder, {
      title: 'Deploy',
      calls: [
        {
          ...spent(1, NOW - 60_000),
          prompted: NOW - 70_000,
          prompt: 'deploy with sk-test-123',
          tools: [
            { name: 'bash', args: 'echo args-789', output: 'hello-from-bash' },
            { name: 'task', args: 'check task-text-456', output: 'task-text-456 done' },
          ],
        },
      ],
      results: [{ at: NOW - 20_000, jobs: [{ jobId: 'Impl1', status: 'completed' }], text: 'check task-text-456: hello-from-bash' }],
    });
    ompSubAgent(home, folder, 'Impl1', { calls: [spent(0.3, NOW - 50_000)], init: { at: NOW - 55_000, kind: 'task', task: 'check task-text-456' }, parent: main });

    await catchUp.run();

    expect(store.summary(omp(main))?.subAgents).toBe(1);
    const file = join(home, STORE_FILE);
    const bytes = [file, `${file}-wal`].filter(existsSync).map((path) => readFileSync(path).toString('latin1')).join('');
    for (const secret of ['sk-test-123', 'task-text-456', 'args-789', 'hello-from-bash']) expect(bytes.includes(secret)).toBe(false);
  });

  test('History store created by the first catch-up', async () => {
    let main = '';
    const { home, host } = await mountOn([], {
      prepare: (at) => {
        expect(existsSync(join(at, STORE_FILE))).toBe(false);
        main = ompSession(at, join(at, 'api'), { title: 'Fix the login bug', calls: [{ ...spent(0.4), started: NOW - 61_000 }] });
      },
    });
    await caughtUp(home);

    store = await openStore(home);
    expect(store.dailyLines('2026-11-25', '2026-11-25').map(({ figures }) => figures.cost)).toEqual([0.4]);
    expect(store.summary(omp(main))?.title).toBe('Fix the login bug');
    const thinking = store.trace(omp(main))!.lanes.find(({ lane }) => lane === 'thinking')!;
    expect(thinking.spans).toEqual([[NOW - 61_000, NOW - 60_000]]);
    const keys = Object.keys(host.data().storage as Record<string, unknown>);
    expect(keys.filter((key) => !key.startsWith('session-totals'))).toEqual([]);
  });

  test('a title is the newest the harness logged', async () => {
    const { home, store, catchUp } = await catchUpOf();
    const changed = ompSession(home, join(home, 'api'), {
      title: 'First',
      calls: [spent(0.1)],
      titles: [
        { at: NOW - 90_000, title: 'Second' },
        { at: NOW - 80_000, title: 'Newest' },
      ],
    });
    const rewritten = ompSession(home, join(home, 'web'), { title: 'Draft', calls: [spent(0.1)] });
    const claude = claudeSession(home, join(home, 'docs'), { calls: [{ at: NOW - 60_000, output: 10 }], title: 'Write the docs' });
    opencodeSession(home, join(home, 'cli'), { provider: 'anthropic', model: 'm', calls: [{ uncached: 1, read: 0, write: 0, output: 1 }], cost: 0.1, id: 'ses_t', title: 'Explore the repo' });
    await catchUp.run();
    // omp rewrites the first line in place when the title changes
    writeFileSync(rewritten, readFileSync(rewritten, 'utf8').replace('"title":"Draft"', '"title":"Final"') + `${JSON.stringify({ type: 'custom', note: 'x' })}\n`);

    await catchUp.run();

    expect([omp(changed), omp(rewritten), `local\0claude\0${claude}`, 'local\0opencode\0ses_t'].map((id) => store.summary(id)?.title)).toEqual([
      'Newest',
      'Final',
      'Write the docs',
      'Explore the repo',
    ]);
  });

  test('sub-agent rows of Claude Code and opencode', async () => {
    const { home, store, catchUp } = await catchUpOf();
    const docs = join(home, 'docs');
    const claude = claudeSession(home, docs, { calls: [{ at: NOW - 60_000, output: 10, tools: [{ name: 'Task', answered: NOW - 30_000, status: 'completed' }] }] });
    claudeSubAgent(home, docs, 'a1', { calls: [{ at: NOW - 50_000, output: 10 }], model: 'claude-haiku-4-5', meta: { agentType: 'general', description: 'Find the docs', toolUseId: 'toolu_0_0' } });
    const cli = join(home, 'cli');
    const base = { provider: 'anthropic', model: 'm', cost: 0.1 };
    const call = (child: string, status: string) => ({ uncached: 1, read: 0, write: 0, output: 1, tools: [{ name: 'subagent', status, child }] });
    opencodeSession(home, cli, { ...base, id: 'ses_p', title: 'Ship it', calls: [call('ses_c', 'completed')] });
    opencodeSession(home, cli, { ...base, id: 'ses_c', title: 'Explore the repo', parent: 'ses_p', calls: [call('ses_g', 'error')], update: true });
    opencodeSession(home, cli, { ...base, id: 'ses_g', title: 'Read the tests', parent: 'ses_c', calls: [{ uncached: 1, read: 0, write: 0, output: 1 }], update: true });

    await catchUp.run();

    const rows = (id: string) => store.trace(id)!.agents.map(({ name, status, cost, depth }) => ({ name, status, cost, depth }));
    expect(rows(`local\0claude\0${claude}`)).toEqual([{ name: 'Find the docs', status: 'completed', cost: 'n/a', depth: 0 }]);
    expect(rows('local\0opencode\0ses_p')).toEqual([
      { name: 'Explore the repo', status: 'completed', cost: 0.1, depth: 0 },
      { name: 'Read the tests', status: 'error', cost: 0.1, depth: 1 },
    ]);
    expect(store.summary('local\0opencode\0ses_p')).toMatchObject({ title: 'Ship it', subAgents: 2 });
    expect(store.summary('local\0opencode\0ses_c')).toBe(null);
  });
});
