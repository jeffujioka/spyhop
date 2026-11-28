// The live panel's four charts from the keyboard, and their crosshair and box through a redraw:
// each chart one stop of the Tab key, named by its title, whose crosshair Left, Right, Home and
// End move and Escape hides; and the crosshair of a hovered or a focused chart kept on its time
// when the panel redraws the screen. The page runs in headless Chrome on the stand-in for Orca
// (test/page/helpers/), whose worker answers the fleet and the session a test sets and changes
// between two refreshes; a test waits for the answer it needs to be drawn rather than for a time.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import type { SessionView } from '../../src/protocol.ts';
import { answersOf, card, FIX } from './helpers/answers.ts';
import { at, burnLayersTo, call, crosshairAt, hoverTime, sessionWith, shown, shownOnce } from './helpers/charts.ts';
import { isFocused, openPanel } from './helpers/page.ts';

// The chart named `name`, as the keyboard reaches it.
const chartNamed = (page: Page, name: string) => page.getByRole('group', { name, exact: true });

// The context of an omp session with points at `clocks`, on a window of 1,000,000 tokens.
const contextAt = (...clocks: string[]): SessionView['context'] => ({
  window: 1_000_000,
  latest: 200_000,
  peak: 200_000,
  tokensLeft: 'n/a',
  compactions: 0,
  points: clocks.map((clock, i) => ({ t: at(clock), v: 50_000 * (i + 1) })),
  marks: [],
});

const FOUR = ['10:00', '10:10', '10:20', '10:30'];

// Waits until the chart `chart` has a point at `t`, as the page draws a new answer.
const pointDrawn = (page: Page, chart: string, t: number) => page.locator(`svg[data-chart="${chart}"] [data-cross][data-t="${t}"]`).waitFor({ state: 'attached' });

test('Each chart one Tab stop', async () => {
  const charts: Partial<SessionView> = {
    context: contextAt(...FOUR),
    tokens: { points: FOUR.map((clock) => call(at(clock), 1000, 0, 0, 10)), hitRate: 'n/a', cold: null },
    cost: { harness: 'omp', total: 1, perHour: 'n/a', own: FOUR.map((clock, i) => ({ t: at(clock), v: i + 1 })), noCall: null, sub: 'n/a' },
  };
  const page = await sessionWith(charts, 'cost', true);
  // the last Tab stop before the charts: the switch's Trace, under the header
  await page.locator('[data-press="view:trace"]').focus();

  await page.keyboard.press('Tab');

  assert.ok(await isFocused(chartNamed(page, 'Context')));
  const { crosshairs, boxes } = await crosshairAt(page, 'context', at('10:30'));
  assert.deepEqual(crosshairs, [at('10:30')]);
  assert.equal(boxes.length, 1);
  await page.keyboard.press('Tab');
  assert.ok(await isFocused(chartNamed(page, 'Tokens per model call')));
  await page.keyboard.press('Tab');
  assert.ok(await isFocused(chartNamed(page, 'Cost')));
});

test('Arrow keys move the crosshair', async () => {
  const points = ['10:00', '10:01', '10:02', '10:03', '10:04'].map((clock) => call(at(clock), 1000, 0, 0, 10));
  const page = await sessionWith({ tokens: { points, hitRate: 'n/a', cold: null } }, 'tokens');
  await chartNamed(page, 'Tokens per model call').focus();
  await crosshairAt(page, 'tokens', at('10:04'));

  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');

  const { crosshairs, boxes } = await crosshairAt(page, 'tokens', at('10:02'));
  assert.deepEqual(crosshairs, [at('10:02')]);
  assert.deepEqual(
    boxes.map(({ lines }) => lines[0]),
    ['10:02'],
  );
  await page.keyboard.press('Home');
  assert.deepEqual((await crosshairAt(page, 'tokens', at('10:00'))).crosshairs, [at('10:00')]);
  await page.keyboard.press('End');
  assert.deepEqual((await crosshairAt(page, 'tokens', at('10:04'))).crosshairs, [at('10:04')]);
});

test('Escape hides the box', async () => {
  const page = await sessionWith({ context: contextAt(...FOUR) }, 'context');
  const chart = chartNamed(page, 'Context');
  await chart.focus();
  await crosshairAt(page, 'context', at('10:30'));

  await page.keyboard.press('Escape');

  assert.deepEqual(await shownOnce(page, 'context', ({ crosshairs, boxes }) => crosshairs.length + boxes.length === 0), { crosshairs: [], xs: [], dots: 0, boxes: [] });
  assert.ok(await isFocused(chart));
  await page.keyboard.press('ArrowLeft');
  const { crosshairs, boxes } = await crosshairAt(page, 'context', at('10:20'));
  assert.deepEqual(crosshairs, [at('10:20')]);
  assert.equal(boxes.length, 1);
});

// Out to the switch's Trace button under the header, not to another chart, whose own crosshair
// would take the place of this one's whether or not the focus leaving hides it.
test('Tab out of a chart takes its crosshair away', async () => {
  const page = await sessionWith({ context: contextAt(...FOUR) }, 'context', true);
  await chartNamed(page, 'Context').focus();
  await crosshairAt(page, 'context', at('10:30'));

  await page.keyboard.press('Shift+Tab');

  assert.ok(await isFocused(page.locator('[data-press="view:trace"]')));
  assert.deepEqual(await shownOnce(page, 'context', ({ crosshairs, boxes }) => crosshairs.length + boxes.length === 0), { crosshairs: [], xs: [], dots: 0, boxes: [] });
});

test('Hovered minute through a redraw', async () => {
  // the newest minute of the burn rate the worker answers: 12:48 while the clock reads 12:48:50,
  // 12:49 once it reads 12:49:01
  let end = at('12:48');
  const { page } = await openPanel(answersOf(() => ({ cards: [card(FIX)], burn: { layers: burnLayersTo(end), endMs: end } })));
  await page.locator('svg[data-chart="burn"]').waitFor();
  await hoverTime(page, 'burn', at('12:05'));
  const before = await crosshairAt(page, 'burn', at('12:05'));

  end = at('12:49');
  await pointDrawn(page, 'burn', at('12:49'));

  const { crosshairs, xs, boxes } = await crosshairAt(page, 'burn', at('12:05'));
  assert.deepEqual(crosshairs, [at('12:05')]);
  assert.ok(xs[0] < before.xs[0], `the crosshair moved from ${before.xs[0]} to ${xs[0]}`);
  assert.deepEqual(
    boxes.map(({ lines }) => lines.slice(0, 2)),
    [['12:05', 'total $12.30/h']],
  );
});

test('Focused chart through a redraw', async () => {
  let clocks = FOUR;
  const page = await sessionWith(() => ({ context: contextAt(...clocks) }), 'context');
  const chart = chartNamed(page, 'Context');
  await chart.focus();
  await crosshairAt(page, 'context', at('10:30'));
  await page.keyboard.press('ArrowLeft');
  await crosshairAt(page, 'context', at('10:20'));

  clocks = [...FOUR, '10:40'];
  await pointDrawn(page, 'context', at('10:40'));

  assert.ok(await isFocused(chart));
  const { crosshairs, boxes } = await crosshairAt(page, 'context', at('10:20'));
  assert.deepEqual(crosshairs, [at('10:20')]);
  assert.deepEqual(
    boxes.map(({ lines }) => lines[0]),
    ['10:20'],
  );
});

test('Crosshair on the first point after its time', async () => {
  // the point of 10:20 gone from the next answer, as when the chart groups its points anew
  let clocks = FOUR;
  const page = await sessionWith(() => ({ context: contextAt(...clocks) }), 'context');
  await hoverTime(page, 'context', at('10:20'));
  await crosshairAt(page, 'context', at('10:20'));

  clocks = ['10:00', '10:10', '10:25', '10:30', '10:40'];
  await pointDrawn(page, 'context', at('10:40'));

  const { crosshairs, boxes } = await crosshairAt(page, 'context', at('10:25'));
  assert.deepEqual(crosshairs, [at('10:25')]);
  assert.deepEqual(
    boxes.map(({ lines }) => lines[0]),
    ['10:25'],
  );
});

test('Hovered chart through a redraw while another has the focus', async () => {
  let clocks = FOUR;
  const tokens = { points: FOUR.map((clock) => call(at(clock), 1000, 0, 0, 10)), hitRate: 'n/a' as const, cold: null };
  const page = await sessionWith(() => ({ context: contextAt(...clocks), tokens }), 'tokens');
  const chart = chartNamed(page, 'Context');
  await chart.focus();
  await crosshairAt(page, 'context', at('10:30'));
  await hoverTime(page, 'tokens', at('10:10'));
  await crosshairAt(page, 'tokens', at('10:10'));

  clocks = [...FOUR, '10:40'];
  await pointDrawn(page, 'context', at('10:40'));

  assert.ok(await isFocused(chart));
  assert.deepEqual((await shown(page, 'tokens')).crosshairs, [at('10:10')]);
  assert.deepEqual((await shown(page, 'context')).crosshairs, []);
});

test('Focused chart the pointer left through a redraw', async () => {
  let clocks = FOUR;
  const page = await sessionWith(() => ({ context: contextAt(...clocks) }), 'context');
  const chart = chartNamed(page, 'Context');
  await chart.focus();
  await hoverTime(page, 'context', at('10:10'));
  await crosshairAt(page, 'context', at('10:10'));
  const header = (await page.locator('header[data-part="header"]').boundingBox())!;
  await page.mouse.move(header.x + 2, header.y + header.height / 2);
  await shownOnce(page, 'context', ({ crosshairs }) => crosshairs.length === 0);

  clocks = [...FOUR, '10:40'];
  await pointDrawn(page, 'context', at('10:40'));

  assert.ok(await isFocused(chart));
  assert.deepEqual(await shown(page, 'context'), { crosshairs: [], xs: [], dots: 0, boxes: [] });
});
