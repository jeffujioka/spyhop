// The palette command that shows the panel, and its key. Orca has no plugin API that shows a
// plugin's own panel, so the command asks the `orca` CLI to (`orca plugin open`), with the key
// Orca installed the plugin under. A test has no Orca app to show it in, so it stands in for the
// CLI only (test/helpers/stand-ins.ts); the worker and the manifest are the real ones, under a
// temporary home, so that its catch-ups never read or write the real one's.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, assert, mockHost, mountWorker, test, type TestWorker } from 'orca/testing';
import { STORE_FILE } from '../src/history/store.ts';
import * as workerModule from '../src/worker.ts';
import { useTempHome } from './helpers/env.ts';
import { answer, standIns } from './helpers/stand-ins.ts';

let worker: TestWorker | undefined;
afterEach(async () => {
  await worker?.deactivate();
  worker = undefined;
});

const manifest = JSON.parse(readFileSync(new URL('../orca-plugin.json', import.meta.url), 'utf8'));

test('Palette command and key', async () => {
  const [command] = manifest.contributes.commands;
  const home = useTempHome();
  assert.deepEqual(command, { id: 'spyhop.show', title: 'Spyhop: Show session stats' });
  assert.deepEqual(manifest.contributes.keybindings, [{ command: 'spyhop.show', key: 'Mod+Alt+Shift+S' }]);

  // `orca plugin list`, shaped as Orca lists plugins (a panel as `{ id, title, … }`):
  // a folder install of spyhop beside other plugins of that id, one with no such panel, one
  // listed without `panels` and a Git install of spyhop listed first but disabled, which Orca
  // refuses to open a panel of (it shares the key, so only one spyhop is enabled)
  const cli = standIns({
    homes: {},
    orca: {
      'plugin list --json': answer({
        plugins: [
          {
            pluginKey: 'jeffujioka.spyhop',
            status: 'disabled',
            panels: [{ id: 'spyhop', title: 'Spyhop' }],
          },
          { pluginKey: 'stablyai.orca-excalidraw', status: 'idle', panels: [] },
          { pluginKey: 'other.spyhop', status: 'idle' },
          { pluginKey: 'acme.spyhop', status: 'idle', panels: [] },
          {
            pluginKey: 'local.spyhop',
            status: 'running',
            panels: [{ id: 'spyhop', title: 'Spyhop' }],
          },
        ],
      }),
      'plugin open local.spyhop --panel spyhop --json': answer({ shown: true }),
    },
  });
  worker = await mountWorker(workerModule, { host: mockHost(), commands: [command.id] });

  await worker.command(command.id);

  // the catch-up lists Orca's hosts at the worker's start
  assert.deepEqual(cli.orca().filter((args) => !/^(host|environment) list --json$/.test(args)), ['plugin list --json', 'plugin open local.spyhop --panel spyhop --json']);
  assert.deepEqual(worker.refusals, []);
  // the worker's history store is the test's home's, once its catch-up has ended
  await worker.deactivate();
  worker = undefined;
  assert.ok(existsSync(join(home, STORE_FILE)));
});
