// The page tests' own setup: the panel's page opens in headless Chrome on the stand-in for Orca
// (test/page/helpers/), and a run on a computer without Chrome fails, naming it, instead of
// skipping its tests.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { openPanel } from './helpers/page.ts';

const OPENS = 'opens the panel page on the stand-in for Orca';

test(OPENS, async () => {
  const { page, requests } = await openPanel({
    'spyhop.fleet': ({ request }) => ({ request, groups: [], counts: {}, burn: null, attention: [] }),
  });
  await page.getByText('No Orca agents').waitFor();
  assert.deepEqual(requests, [{ name: 'spyhop.fleet', input: { request: 1 } }]);
});

test('Page tests without Chrome', () => {
  // `npm run test:page` on a computer whose Chrome is not where the tests look for it, running the
  // test above only, which needs Chrome. Without NODE_TEST_CONTEXT, which this run's own test
  // runner sets, the run reports and exits on its own instead of to this one.
  const { NODE_TEST_CONTEXT, ...env } = process.env;
  const run = spawnSync('npm', ['run', 'test:page'], {
    encoding: 'utf8',
    env: { ...env, SPYHOP_CHROME: '/nowhere/Google Chrome', NODE_OPTIONS: `--test-name-pattern="^${OPENS}$"` },
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stdout + run.stderr, /Google Chrome is not installed/);
});
