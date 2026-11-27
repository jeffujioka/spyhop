// How the page tests of the charts (test/page/charts.page.ts, test/page/keyboard.page.ts) set
// them up and read them: the times of one day, the burn rate layers and model calls they draw,
// the session screen of the card FIX, the pointer resting over a point, and what a chart then
// shows of its crosshairs, dots and boxes, waited for as the page draws it rather than slept for.
import type { Page } from 'playwright-core';
import { MINUTE_MS } from '../../../src/core/series.js';
import type { Point, SessionView } from '../../../src/protocol.ts';
import { answersOf, card, FIX } from './answers.ts';
import { openPanel } from './page.ts';

// The epoch ms of the time of day `clock` ("12:05") on one day, in local time, as the page writes
// its times.
export const at = (clock: string) => {
  const [hours, minutes] = clock.split(':').map(Number);
  return new Date(2026, 10, 27, hours, minutes).getTime();
};

// The burn rate of the hour to the minute `end` of the layers ORCA, BOTO, FACT and others: at
// 12:05 4.00, 4.80, 3.00 and 0.50 USD per hour, and at every other minute their newest rates,
// 2.00, 1.00, 0.50 and 0.25.
export const burnLayersTo = (end: number) =>
  (
    [
      ['ORCA', 4, 2],
      ['BOTO', 4.8, 1],
      ['FACT', 3, 0.5],
      ['others', 0.5, 0.25],
    ] as const
  ).map(([name, then, newest]) => {
    const values = Array.from({ length: 60 }, () => newest);
    values[60 - 1 - (end - at('12:05')) / MINUTE_MS] = then;
    return { name, values };
  });

// A model call of the tokens chart at `t`, with its tokens.
export const call = (t: number, read: number, write: number, uncached: number, output: number): Point => ({ t, n: 1, read, write, uncached, output, cost: null, context: null });

// The session screen of the card FIX, whose session has the charts `charts`, opened by a click
// once its chart `chart` is drawn; the card has a pane when `pane`, so the header has its Focus
// button. `charts` is read at each refresh: a test changes what the next answer gives through it.
export async function sessionWith(charts: Partial<SessionView> | (() => Partial<SessionView>), chart: string, pane = false) {
  const read = typeof charts === 'function' ? charts : () => charts;
  const of = card(FIX, pane ? { pane: { terminalId: 'term-1' } } : {});
  const { page } = await openPanel(answersOf(() => ({ cards: [of], sessions: { [FIX]: read() } })));
  await page.locator('[data-part="card"]', { hasText: FIX }).click();
  await page.locator(`svg[data-chart="${chart}"]`).waitFor();
  return page;
}

// Rests the pointer over the chart `chart`, halfway down, at the x it draws the point of `t` at.
export async function hoverTime(page: Page, chart: string, t: number) {
  const svg = page.locator(`svg[data-chart="${chart}"]`);
  await svg.scrollIntoViewIfNeeded();
  const x = Number(await svg.locator(`[data-cross][data-t="${t}"]`).getAttribute('data-x'));
  const box = (await svg.boundingBox())!;
  await page.mouse.move(box.x + (x / 360) * box.width, box.y + box.height / 2);
}

// What a chart shows of its crosshair and box: the time and x of each visible crosshair, the
// visible dots, and each visible box's lines and the half of the plot it is in, `top` and
// `bottom` its edges' distances from the plot's top and `plot` the plot's height, in px.
export type Shown = {
  crosshairs: number[];
  xs: number[];
  dots: number;
  boxes: { lines: (string | null)[]; half: string; top: number; bottom: number; plot: number }[];
};

// What the chart `chart` shows of its crosshair and box, read in one go, so that no redraw takes
// the chart out from under the reading.
export function shown(page: Page, chart: string): Promise<Shown> {
  return page.evaluate((name) => {
    const svg = document.querySelector(`svg[data-chart="${name}"]`)!;
    const plot = svg.parentElement!;
    const area = plot.getBoundingClientRect();
    const middle = area.left + area.width / 2;
    // shown when neither it nor what holds it is `display: none`; Chrome's checkVisibility()
    // reads an SVG element in a hidden group as visible
    const visible = (element: Element) => {
      for (let at: Element | null = element; at; at = at.parentElement) if (getComputedStyle(at).display === 'none') return false;
      return true;
    };
    const crosses = [...svg.querySelectorAll('[data-cross]')].filter(visible);
    return {
      crosshairs: crosses.map((cross) => Number(cross.getAttribute('data-t'))),
      xs: crosses.map((cross) => Number(cross.getAttribute('data-x'))),
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
  }, chart);
}

// What the chart `chart` shows once `done` holds of it, or after 10 s, as the page draws it.
export async function shownOnce(page: Page, chart: string, done: (now: Shown) => boolean) {
  const until = Date.now() + 10_000;
  let now = await shown(page, chart);
  while (!done(now) && Date.now() < until) {
    await page.waitForTimeout(50);
    now = await shown(page, chart);
  }
  return now;
}

// What the chart `chart` shows once it shows a crosshair at `t`.
export const crosshairAt = (page: Page, chart: string, t: number) => shownOnce(page, chart, ({ crosshairs }) => crosshairs.includes(t));
