// The crosshair and box of the live panel's four charts on hover: the burn rate chart on the
// fleet screen, and the context, tokens and cost charts on the session screen of the card FIX,
// opened by a click. The page runs in headless Chrome on the stand-in for Orca
// (test/page/helpers/), whose worker answers the fleet and the session a test sets
// (test/page/helpers/answers.ts). A test rests the pointer over a point at the x its chart draws
// it at, and reads what the chart then shows: the crosshairs, the dots and the boxes that are
// visible, each box's lines as its text, and the half of the plot the box is in.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import type { Point, SessionView } from '../../src/protocol.ts';
import { answersOf, card, FIX } from './helpers/answers.ts';
import { openPanel } from './helpers/page.ts';

const MINUTE = 60_000;

// The epoch ms of the time of day `clock` ("12:05") on one day, in local time, as the page writes
// its times.
const at = (clock: string) => {
  const [hours, minutes] = clock.split(':').map(Number);
  return new Date(2026, 10, 27, hours, minutes).getTime();
};

// The burn rate of the last hour to 12:48 of the layers ORCA, BOTO, FACT and others: at 12:05
// 4.00, 4.80, 3.00 and 0.50 USD per hour, and at every other minute their newest rates, 2.00,
// 1.00, 0.50 and 0.25.
const BURN_END = at('12:48');
const burnLayers = (
  [
    ['ORCA', 4, 2],
    ['BOTO', 4.8, 1],
    ['FACT', 3, 0.5],
    ['others', 0.5, 0.25],
  ] as const
).map(([name, then, newest]) => {
  const values = Array.from({ length: 60 }, () => newest);
  values[60 - 1 - (BURN_END - at('12:05')) / MINUTE] = then;
  return { name, values };
});

// A session title of 40 characters, longer than a line of the burn rate box holds at 300 px.
const LONG = 'Refactor the session reader for opencode';

// The fleet screen of one card, with the burn rate chart of `layers` above.
const fleetWithBurn = (layers = burnLayers) => openPanel(answersOf(() => ({ cards: [card(FIX)], burn: { layers, endMs: BURN_END } })));

// The session screen of the card FIX, whose session has the charts `charts`, drawn.
async function sessionWith(charts: Partial<SessionView>, chart: string) {
  const { page } = await openPanel(answersOf(() => ({ cards: [card(FIX)], sessions: { [FIX]: charts } })));
  await page.locator('[data-part="card"]', { hasText: FIX }).click();
  await page.locator(`svg[data-chart="${chart}"]`).waitFor();
  return page;
}

// A model call of the tokens chart at `t`, with its tokens.
const call = (t: number, read: number, write: number, uncached: number, output: number): Point => ({ t, n: 1, read, write, uncached, output, cost: null, context: null });

// Rests the pointer over the chart `chart`, halfway down, at the x it draws the point of `t` at.
async function hoverTime(page: Page, chart: string, t: number) {
  const svg = page.locator(`svg[data-chart="${chart}"]`);
  await svg.scrollIntoViewIfNeeded();
  const x = Number(await svg.locator(`[data-cross][data-t="${t}"]`).getAttribute('data-x'));
  const box = (await svg.boundingBox())!;
  await page.mouse.move(box.x + (x / 360) * box.width, box.y + box.height / 2);
}

// Rests the pointer over the middle of the element `selector` of the chart `chart`.
async function hoverOver(page: Page, chart: string, selector: string, nth: number) {
  const element = page.locator(`svg[data-chart="${chart}"] ${selector}`).nth(nth);
  await element.scrollIntoViewIfNeeded();
  const box = (await element.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

// What a chart shows of its crosshair and box: the time of each visible crosshair, the visible
// dots, and each visible box's lines and the half of the plot it is in, `top` and `bottom` its
// edges' distances from the plot's top and `plot` the plot's height, in px.
type Shown = { crosshairs: number[]; dots: number; boxes: { lines: (string | null)[]; half: string; top: number; bottom: number; plot: number }[] };

// What the chart `chart` shows of its crosshair and box.
function shown(page: Page, chart: string): Promise<Shown> {
  return page.locator(`svg[data-chart="${chart}"]`).evaluate((svg) => {
    const plot = svg.parentElement!;
    const area = plot.getBoundingClientRect();
    const middle = area.left + area.width / 2;
    // shown when neither it nor what holds it is `display: none`; Chrome's checkVisibility()
    // reads an SVG element in a hidden group as visible
    const visible = (element: Element) => {
      for (let at: Element | null = element; at; at = at.parentElement) if (getComputedStyle(at).display === 'none') return false;
      return true;
    };
    return {
      crosshairs: [...svg.querySelectorAll('[data-cross]')].filter(visible).map((cross) => Number(cross.getAttribute('data-t'))),
      dots: [...svg.querySelectorAll('[data-dot]')].filter(visible).length,
      boxes: [...plot.querySelectorAll('[data-box]')].filter(visible).map((box) => {
        const { left, right, top, bottom } = box.getBoundingClientRect();
        return {
          lines: [...box.children].map((line) => line.textContent),
          half: right <= middle ? 'left' : left >= middle ? 'right' : 'both',
          top: top - area.top,
          bottom: bottom - area.top,
          plot: area.height,
        };
      }),
    };
  });
}

// What the chart `chart` shows once `done` holds of it, or after 10 s, as the page draws it.
async function shownOnce(page: Page, chart: string, done: (now: Shown) => boolean) {
  const until = Date.now() + 10_000;
  let now = await shown(page, chart);
  while (!done(now) && Date.now() < until) {
    await page.waitForTimeout(50);
    now = await shown(page, chart);
  }
  return now;
}

// What the chart `chart` shows once it shows a crosshair at `t`.
const crosshairAt = (page: Page, chart: string, t: number) => shownOnce(page, chart, ({ crosshairs }) => crosshairs.includes(t));

// The widths of the panel the boxes are checked at: the sidebar's, and a wider one.
const WIDTHS = [300, 420];

test('Crosshair and box on the burn rate chart', async () => {
  const { page } = await fleetWithBurn();
  await page.locator('svg[data-chart="burn"]').waitFor();

  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 800 });
    await hoverTime(page, 'burn', at('12:05'));

    const { crosshairs, dots, boxes } = await crosshairAt(page, 'burn', at('12:05'));
    assert.deepEqual(crosshairs, [at('12:05')]);
    assert.equal(dots, 4);
    assert.equal(boxes.length, 1);
    assert.deepEqual(boxes[0].lines, ['12:05', 'total $12.30/h', 'ORCA $4.00/h', 'BOTO $4.80/h', 'FACT $3.00/h', 'others $0.50/h']);
    assert.equal(boxes[0].half, 'right');
    assert.ok(boxes[0].top < 4, `the box is ${boxes[0].top} px under the chart's top`);
    assert.ok(boxes[0].bottom <= boxes[0].plot, `at ${width} px the box ends ${boxes[0].bottom} px down a plot ${boxes[0].plot} px high`);
    const key = await page.locator('[data-part="burn"] .key').first().textContent();
    for (const rate of ['ORCA $2.00/h', 'BOTO $1.00/h', 'FACT $0.50/h', 'others $0.25/h']) assert.ok(key?.includes(rate), `the key reads ${key}`);
  }

  // ORCA named LONG: its line is cut short, with an ellipsis, and the box still ends in the plot
  const { page: long } = await fleetWithBurn(burnLayers.map((layer, k) => (k === 0 ? { ...layer, name: LONG } : layer)));
  await long.locator('svg[data-chart="burn"]').waitFor();
  for (const width of WIDTHS) {
    await long.setViewportSize({ width, height: 800 });
    await hoverTime(long, 'burn', at('12:05'));

    const { boxes } = await crosshairAt(long, 'burn', at('12:05'));
    const [line] = boxes[0].lines.filter((text) => text?.startsWith('Refactor'));
    assert.match(line ?? '', /^Refactor[^…]*… \$4\.00\/h$/);
    assert.ok(boxes[0].bottom <= boxes[0].plot, `at ${width} px the box of ${LONG} ends ${boxes[0].bottom} px down a plot ${boxes[0].plot} px high`);
    const key = await long.locator('[data-part="burn"] .key').first().textContent();
    assert.ok(key?.includes(`${LONG} $2.00/h`), `the key reads ${key}`);
  }
});

test('Box away from the pointer', async () => {
  const { page } = await fleetWithBurn();
  await page.locator('svg[data-chart="burn"]').waitFor();
  await hoverTime(page, 'burn', at('12:05'));
  await crosshairAt(page, 'burn', at('12:05'));

  await hoverTime(page, 'burn', at('12:40'));

  const { crosshairs, boxes } = await crosshairAt(page, 'burn', at('12:40'));
  assert.deepEqual(crosshairs, [at('12:40')]);
  assert.equal(boxes.length, 1);
  assert.equal(boxes[0].half, 'left');
  assert.ok(boxes[0].top < 4, `the box is ${boxes[0].top} px under the chart's top`);
  assert.equal(boxes[0].lines[0], '12:40');
});

test('Pointer leaves the chart', async () => {
  const { page } = await fleetWithBurn();
  await page.locator('svg[data-chart="burn"]').waitFor();
  await hoverTime(page, 'burn', at('12:05'));
  await crosshairAt(page, 'burn', at('12:05'));

  const counts = (await page.locator('[data-part="counts"]').boundingBox())!;
  await page.mouse.move(counts.x + 2, counts.y + counts.height / 2);

  assert.deepEqual(await shownOnce(page, 'burn', ({ crosshairs, boxes }) => crosshairs.length + boxes.length === 0), { crosshairs: [], dots: 0, boxes: [] });
});

test('Box of the context chart', async () => {
  const context: SessionView['context'] = {
    window: 1_000_000,
    latest: 221_000,
    peak: 880_000,
    tokensLeft: 'n/a',
    compactions: 1,
    points: [
      { t: at('12:30'), v: 880_000 },
      { t: at('12:45'), v: 221_000 },
    ],
    marks: [{ t: at('12:40'), before: 880_000, after: 221_000 }],
  };
  const page = await sessionWith({ context }, 'context');

  await hoverTime(page, 'context', at('12:45'));

  const { boxes } = await crosshairAt(page, 'context', at('12:45'));
  assert.deepEqual(
    boxes.map(({ lines }) => lines),
    [['12:45', '22% · 221,000 tokens', 'compacted 12:40 880,000 → 221,000']],
  );
});

test('Context box of many compactions', async () => {
  // four compactions between the points of 12:00 and 12:30: the box gives the two newest
  const compactions = ['12:05', '12:10', '12:15', '12:20'];
  const context: SessionView['context'] = {
    window: 1_000_000,
    latest: 221_000,
    peak: 880_000,
    tokensLeft: 'n/a',
    compactions: compactions.length,
    points: [
      { t: at('12:00'), v: 880_000 },
      { t: at('12:30'), v: 221_000 },
    ],
    marks: compactions.map((clock) => ({ t: at(clock), before: 880_000, after: 221_000 })),
  };
  const page = await sessionWith({ context }, 'context');

  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 800 });
    await hoverTime(page, 'context', at('12:30'));

    const { boxes } = await crosshairAt(page, 'context', at('12:30'));
    assert.deepEqual(
      boxes.map(({ lines }) => lines),
      [['12:30', '22% · 221,000 tokens', 'compacted 12:15 880,000 → 221,000', 'compacted 12:20 880,000 → 221,000', '+2 more compactions']],
    );
    assert.ok(boxes[0].bottom <= boxes[0].plot, `at ${width} px the box ends ${boxes[0].bottom} px down a plot ${boxes[0].plot} px high`);
  }
});

test('Box of one model call', async () => {
  const points = [call(at('10:00'), 0, 40_000, 10_000, 300), call(at('10:05'), 40_000, 10_000, 0, 500), call(at('10:10'), 50_000, 0, 0, 200)];
  const page = await sessionWith({ tokens: { points, hitRate: 'n/a', cold: null } }, 'tokens');

  await hoverOver(page, 'tokens', '[data-bar]', 1);

  const { boxes } = await crosshairAt(page, 'tokens', at('10:05'));
  assert.deepEqual(
    boxes.map(({ lines }) => lines),
    [['10:05', 'read from cache 40,000', 'written to cache 10,000', 'not cached 0', 'output 500']],
  );
});

test('Box of the cost chart', async () => {
  const cost: SessionView['cost'] = {
    harness: 'omp',
    total: 4.5,
    perHour: 'n/a',
    own: [
      { t: at('10:00'), v: 1 },
      { t: at('11:00'), v: 3 },
    ],
    noCall: null,
    sub: [
      { t: at('10:20'), v: 0.5 },
      { t: at('10:40'), v: 2 },
    ],
  };
  const page = await sessionWith({ cost }, 'cost');

  await hoverTime(page, 'cost', at('10:40'));

  const { boxes } = await crosshairAt(page, 'cost', at('10:40'));
  assert.deepEqual(
    boxes.map(({ lines }) => lines),
    [['10:40', 'own $1.00', 'sub-agents $2.00', 'total $3.00']],
  );
});

test('Box of grouped model calls', async () => {
  // 400 calls a minute apart from 10:00, in the session chart's 120 bars of room: 100 bars of 4
  const points = Array.from({ length: 400 }, (_, i) => call(at('10:00') + i * MINUTE, 1000, 0, 0, 10));
  const page = await sessionWith({ tokens: { points, hitRate: 'n/a', cold: null } }, 'tokens');

  await hoverOver(page, 'tokens', '[data-bar]', 1);

  const { boxes } = await crosshairAt(page, 'tokens', at('10:07'));
  assert.deepEqual(
    boxes.map(({ lines }) => lines),
    [['4 calls between 10:03 and 10:07', 'read from cache 4,000', 'written to cache 0', 'not cached 0', 'output 40']],
  );
});
