// The rows of a card's identity group: Session, Branch, Remote and Machine are drawn only when
// they have a value, and Path, Harness and Model always, in one order on every card. The worker
// and the panel are the real ones, on this computer's Orca host as the test kit plays it
// (`openPanel`, test/helpers/orca-host.ts); the worker reads with the real programs under a
// temporary home, the SSH target `devbox` through the stand-in `ssh` (test/helpers/stand-ins.ts),
// which runs them here.
import { execFileSync } from 'node:child_process';
import { assert, test, type TestPanel } from 'orca/testing';
import { workspace } from './helpers/agent-cards.ts';
import { tempHome } from './helpers/files.ts';
import { DEVBOX, DEVBOX_LISTS } from './helpers/orca-answers.ts';
import { openPanel } from './helpers/orca-host.ts';
import { row } from './helpers/panel.ts';

// The identity rows of the one card `view` draws under the workspace row `name`, each its label
// and its value, in the order drawn.
function identityRows(view: TestPanel, name: string) {
  const [identity, ...others] = view.findAll({ type: 'KeyValue', label: 'IDENTITY' }).filter((el) => el.path.startsWith(`${row(view, name)!.path}/`));
  assert.ok(identity && others.length === 0, JSON.stringify(view.tree()));
  return (identity.props.items as { label: string; value: unknown }[]).map(({ label, value }) => [label, value]);
}

test('Local card in a folder that is no git repository', async () => {
  const view = await openPanel([{ project: 'notes', name: 'scratch', agents: ['working'] }], { focused: 'scratch' });

  assert.deepEqual(identityRows(view, 'scratch'), [
    ['Path', '~/work/notes-scratch'],
    ['Harness', 'omp'],
    ['Model', 'n/a'],
  ]);
});

test('Card on another Orca host draws Machine', async () => {
  let folder = '';
  const view = await openPanel(
    [{ project: 'infra', name: 'deploy', agents: ['working'], hostId: `ssh:${DEVBOX}`, title: 'π - Fix the login bug' }],
    {
      focused: 'deploy',
      homes: { devbox: tempHome() },
      orca: DEVBOX_LISTS,
      // the workspace folder, which the stand-in `ssh` reaches by the same path, is a git
      // repository on `main` with an origin
      prepare: (home) => {
        folder = workspace(home, 'infra-deploy');
        execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: folder });
        execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/infra.git'], { cwd: folder });
      },
    },
  );

  assert.deepEqual(identityRows(view, 'deploy'), [
    ['Session', 'Fix the login bug'],
    ['Path', folder],
    ['Branch', 'main'],
    ['Remote', 'github.com/acme/infra'],
    ['Machine', 'devbox'],
    ['Harness', 'omp'],
    ['Model', 'n/a'],
  ]);
});
