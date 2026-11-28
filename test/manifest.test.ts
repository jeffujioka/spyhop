// The plugin's manifest as Orca loads it: one HTML panel, the palette command and its key, the
// status bar item that keeps the worker running and shows the panel, and the four capabilities
// the plugin needs, no other. `orca plugin validate` is Orca's own check of
// it: the CLI the guide names, ORCA_CLI_COMMAND when set, else `orca` on PATH.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (file: string) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));

test('Manifest of the new panel', () => {
  // throws when the CLI exits with anything but 0
  execFileSync(process.env.ORCA_CLI_COMMAND || 'orca', ['plugin', 'validate', '.', '--json'], { cwd: new URL('..', import.meta.url) });

  const manifest = read('orca-plugin.json');
  assert.deepEqual([manifest.id, manifest.version], ['spyhop', '0.2.0']);
  assert.deepEqual(
    manifest.contributes.panels.map(({ id, ui, entry }: Record<string, string>) => ({ id, ui, entry })),
    [{ id: 'spyhop', ui: 'html', entry: 'src/panel.ts' }],
  );
  assert.deepEqual(
    manifest.capabilities.map(({ kind }: { kind: string }) => kind),
    ['workspace:read', 'agent:read', 'workspace:write', 'storage:own'],
  );
  assert.deepEqual(manifest.contributes.keybindings, [{ command: 'spyhop.show', key: 'Mod+Alt+Shift+S' }]);
  assert.deepEqual(manifest.contributes.statusBarItems, [{ id: 'spyhop', icon: 'bar-chart-3', command: 'spyhop.show' }]);
  assert.equal(read('package.json').version, '0.2.0');
});
