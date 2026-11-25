// The palette command that shows the panel, and its key. Orca has no plugin API that shows a
// plugin's own panel, so the command asks the `orca` CLI to (`orca plugin open`), with the key
// Orca installed the plugin under. A test has no Orca app to show it in, so it stands in for the
// CLI only (test/helpers/stand-ins.ts); the worker and the manifest are the real ones.
import { readFileSync } from 'node:fs';
import { afterEach, assert, mockHost, mountWorker, test, type TestWorker } from 'orca/testing';
import * as workerModule from '../src/worker.ts';
import { answer, standIns } from './helpers/stand-ins.ts';

let worker: TestWorker | undefined;
afterEach(async () => {
  await worker?.deactivate();
  worker = undefined;
});

const manifest = JSON.parse(readFileSync(new URL('../orca-plugin.json', import.meta.url), 'utf8'));

test('Palette command and key', async () => {
  const [command] = manifest.contributes.commands;
  assert.deepEqual(command, { id: 'spyhop.show', title: 'Spyhop: Show session stats' });
  assert.deepEqual(manifest.contributes.keybindings, [{ command: 'spyhop.show', key: 'Mod+Alt+Shift+S' }]);

  // `orca plugin list`, shaped as Orca lists plugins (a panel as `{ id, title, … }`):
  // a folder install of spyhop beside other plugins of that id, one with no such panel and one
  // listed without `panels`
  const cli = standIns({
    homes: {},
    orca: {
      'plugin list --json': answer({
        plugins: [
          { pluginKey: 'stablyai.orca-excalidraw', status: 'idle', panels: [] },
          { pluginKey: 'other.spyhop', status: 'idle' },
          { pluginKey: 'acme.spyhop', status: 'idle', panels: [] },
          {
            pluginKey: 'local.spyhop',
            status: 'idle',
            panels: [{ id: 'spyhop', title: 'Spyhop' }],
          },
        ],
      }),
      'plugin open local.spyhop --panel spyhop --json': answer({ shown: true }),
    },
  });
  worker = await mountWorker(workerModule, { host: mockHost(), commands: [command.id] });

  await worker.command(command.id);

  assert.deepEqual(cli.orca(), ['plugin list --json', 'plugin open local.spyhop --panel spyhop --json']);
  assert.deepEqual(worker.refusals, []);
});
