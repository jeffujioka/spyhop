// A card's Focus pane button: pressing it asks Orca to focus the pane of the card's Orca agent,
// on this computer and on an SSH workspace, and runs nothing over ssh. The worker reads the
// harnesses' files with the real programs under a temporary home; the `orca` CLI and `ssh`,
// stood in for (test/helpers/stand-ins.ts), list the SSH host `devbox` and log their calls. The
// clock is node:test's mock clock, which no test moves: the panel asks for its tree once, so the
// calls after the press are the press's own.
import { mock } from 'node:test';
import { afterEach, assert, mount, mountWorker, test, type TestPanel, type TestWorker } from 'orca/testing';
import * as panelModule from '../src/panel.tsx';
import * as workerModule from '../src/worker.ts';
import { useTempHome } from './helpers/env.ts';
import { tempHome } from './helpers/files.ts';
import { orcaHost, type HostWorkspace } from './helpers/orca-host.ts';
import { answer, standIns } from './helpers/stand-ins.ts';

let panel: TestPanel | undefined;
let worker: TestWorker | undefined;
afterEach(async () => {
  await panel?.unmount();
  await worker?.deactivate();
  mock.timers.reset();
});

// Orca's id of the SSH target `devbox`, as `orca host list` gives it on this Mac.
const DEVBOX = 'ssh-1795031810693-d3v8ox';

// Opens the panel, with its worker, on Orca's hosts with the one workspace `workspace`, focused,
// presses the Focus pane button of its one card, and returns the terminals Orca was asked to
// focus and the ssh and orca CLI calls the press made.
async function pressFocusPane(workspace: HostWorkspace) {
  const home = useTempHome();
  const calls = standIns({
    homes: { devbox: tempHome() },
    orca: {
      'host list --json': answer({ hosts: [{ kind: 'ssh', name: 'devbox', id: DEVBOX, selector: `--host ssh:${DEVBOX}`, connected: true }] }),
      'environment list --json': answer({ environments: [] }),
    },
  });
  const host = orcaHost(home, { workspaces: [workspace], focused: workspace.name });
  mock.timers.enable({ apis: ['setTimeout'] });
  worker = await mountWorker(workerModule, { host });
  panel = await mount(panelModule, { host });
  const [card] = panel.findAll({ type: 'Card' });
  assert.ok(card);
  const button = panel.findAll({ type: 'Button', text: 'Focus pane' }).find((el) => el.path.startsWith(`${card.path}/`));
  assert.ok(button, JSON.stringify(panel.tree()));
  const [ssh, orca] = [calls.ssh().length, calls.orca().length];

  await panel.press(button);

  assert.deepEqual(panel.errors, []);
  assert.deepEqual(panel.refusals, []);
  assert.deepEqual(worker.refusals, []);
  return {
    focused: host.callsOf('terminal.focus'),
    ssh: calls.ssh().slice(ssh),
    orca: calls.orca().slice(orca),
  };
}

test('Focus pane on this computer', async () => {
  const pressed = await pressFocusPane({ project: 'api', name: 'main', agents: ['working'], terminals: ['local-t1'] });

  assert.deepEqual(pressed.focused, [{ terminalId: 'local-t1' }]);
  assert.deepEqual(pressed.ssh, []);
  assert.deepEqual(pressed.orca, []);
});

test('Focus pane on an SSH workspace', async () => {
  const pressed = await pressFocusPane({
    project: 'infra',
    name: 'deploy',
    agents: ['working'],
    terminals: ['devbox-t2'],
    hostId: `ssh:${DEVBOX}`,
  });

  assert.deepEqual(pressed.focused, [{ terminalId: 'devbox-t2' }]);
  assert.deepEqual(pressed.ssh, []);
  assert.deepEqual(pressed.orca, []);
});
