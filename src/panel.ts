// The live panel's page, Orca's HTML panel (`ui: "html"`), which Orca wraps in a generated page
// with the global `orca` (Orca's Frame API). The only code that touches the DOM: it puts the
// stylesheet in a <style>, makes the controller (src/live/controller.ts) with `orca`, and draws
// each screen the controller makes as the body's markup, keeping the scroll position and the
// focused control across a redraw of the same screen and starting a new screen at the top, as the
// controller says. A click on a control (`data-press`), or Enter or Space on a focused card,
// folded line or row of the attention list (a button by its role, `role="button"`), goes to the
// controller, which also hears when the page is shown or hidden and when it goes. The pointer
// over a chart shows its crosshair and box (src/live/charts.ts) at the point nearest it, and a
// chart, one stop of the Tab key, shows them while it has the focus, moved by the keyboard.
import { createLive } from './live/controller.ts';
import { STYLE } from './live/style.ts';

const style = document.createElement('style');
style.textContent = STYLE;
document.head.append(style);

// The crosshair of the chart `chart` (its `data-chart`) at its point of the time `t`, shown with
// that point's box unless `hidden`, as Escape leaves it on a focused chart; null when there is
// none. A redraw of the same screen puts it again on the point of that time, or on the first
// point after it when that time is no longer a point.
let crosshair: { chart: string; t: number; hidden?: boolean } | null = null;

// The crosshairs of the chart `svg`, one per point, oldest first.
const crossesOf = (svg: Element) => Array.from(svg.querySelectorAll('[data-cross]'));

// The chart of `element` when it is a chart's plot, the stop of the Tab key; null for anything else.
const chartOf = (element: EventTarget | null) => (element instanceof HTMLElement && element.matches('.plot') ? element.querySelector<SVGSVGElement>('svg[data-chart]') : null);

// Hides the crosshair and box shown, and puts the crosshair on `next`, on the point of its time
// or the first after it, showing it unless `hidden`, with its box in the half of the chart its
// point is not in; none when `next` is null or its chart has no point from that time on.
function showCrosshair(next: typeof crosshair) {
  document.querySelectorAll('[data-cross][data-on], [data-box][data-on]').forEach((shown) => shown.removeAttribute('data-on'));
  const svg = next ? document.querySelector<SVGSVGElement>(`svg[data-chart="${next.chart}"]`) : null;
  const cross = svg ? crossesOf(svg).find((found) => Number(found.getAttribute('data-t')) >= next!.t) : undefined;
  const t = cross?.getAttribute('data-t');
  const box = t ? svg!.parentElement?.querySelector(`[data-box][data-t="${t}"]`) : null;
  crosshair = cross && box ? { ...next!, t: Number(t) } : null;
  if (!cross || !box || next!.hidden) return;
  cross.setAttribute('data-on', '');
  box.setAttribute('data-on', Number(cross.getAttribute('data-x')) < svg!.viewBox.baseVal.width / 2 ? 'right' : 'left');
}

const live = createLive(orca, (html, { sameScreen }) => {
  const scroller = document.scrollingElement;
  const top = sameScreen ? (scroller?.scrollTop ?? 0) : 0;
  // The new markup replaces the focused control, which would send the keyboard back to the start
  // on every refresh; the same control is found again by its `data-press` and its kind, the
  // `data-row` of a row of the attention list or the `data-part` of a card or a folded line: a
  // card and its rows share one `data-press`, and a row comes and goes between two refreshes, so
  // a place among them would move the focus to another control. When no control of that kind is
  // drawn any more (the row went, or the card folded as its agent went done), the card or folded
  // line of that `data-press` is focused, and only without one the first control of it. A
  // focused chart, which has no `data-press`, is found again by its `data-chart`.
  const focused = sameScreen ? document.activeElement : null;
  const pressed = focused?.getAttribute('data-press');
  const selector = pressed ? `[data-press="${CSS.escape(pressed)}"]` : null;
  const kindName = focused?.hasAttribute('data-row') ? 'data-row' : focused?.hasAttribute('data-part') ? 'data-part' : null;
  const kind = kindName ? `[${kindName}="${CSS.escape(focused!.getAttribute(kindName)!)}"]` : '';
  const focusedChart = chartOf(focused)?.dataset.chart;
  // taken before the markup goes, as Chrome tells a focused chart it loses the focus as it goes,
  // and shown once the focus is back, so that the chart taking the focus again does not move it
  const kept = sameScreen ? crosshair : null;
  document.body.innerHTML = html;
  if (selector) {
    const found = document.querySelector<HTMLElement>(selector + kind) ?? document.querySelector<HTMLElement>(`${selector}[data-part]`) ?? document.querySelector<HTMLElement>(selector);
    found?.focus({ preventScroll: true });
  }
  if (focusedChart) document.querySelector(`svg[data-chart="${focusedChart}"]`)?.closest<HTMLElement>('.plot')?.focus({ preventScroll: true });
  showCrosshair(kept);
  if (scroller) scroller.scrollTop = top;
});

document.addEventListener('click', (event) => {
  const control = (event.target as Element | null)?.closest('[data-press]');
  if (control) live.press(control.getAttribute('data-press')!);
});
// A <button> turns Enter and Space into a click of its own; a card, a folded line or a row of the
// attention list, a button only by its role, is pressed here, and Space does not scroll the page.
document.addEventListener('keydown', (event) => {
  const control = event.target as Element | null;
  if ((event.key !== 'Enter' && event.key !== ' ') || !control?.matches('[role="button"][data-press]')) return;
  event.preventDefault();
  live.press(control.getAttribute('data-press')!);
});
// On a focused chart, Left and Right move its crosshair one point from the point it is on (its
// newest when it has none), Home and End to its first and last point, and the page does not
// scroll; Escape hides it and its box, still on that point, until the next of those keys.
document.addEventListener('keydown', (event) => {
  const svg = chartOf(event.target);
  if (!svg) return;
  const chart = svg.dataset.chart!;
  const on = crosshair?.chart === chart ? crosshair : null;
  if (event.key === 'Escape') {
    if (on) showCrosshair({ ...on, hidden: true });
    return;
  }
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const times = crossesOf(svg).map((cross) => Number(cross.getAttribute('data-t')));
  const from = on ? times.indexOf(on.t) : times.length - 1;
  const to = event.key === 'Home' ? 0 : event.key === 'End' ? times.length - 1 : Math.min(times.length - 1, Math.max(0, from + (event.key === 'ArrowLeft' ? -1 : 1)));
  showCrosshair({ chart, t: times[to] });
});
// A chart that takes the focus shows its crosshair on its newest point, unless the crosshair is
// on it already, as the pointer or a redraw left it; when the focus leaves the chart, its
// crosshair goes.
document.addEventListener('focusin', (event) => {
  const svg = chartOf(event.target);
  if (svg && crosshair?.chart !== svg.dataset.chart) showCrosshair({ chart: svg.dataset.chart!, t: Number(crossesOf(svg).at(-1)!.getAttribute('data-t')) });
});
document.addEventListener('focusout', (event) => {
  if (crosshair?.chart === chartOf(event.target)?.dataset.chart) showCrosshair(null);
});
document.addEventListener('visibilitychange', () => live.show(document.visibilityState === 'visible'));
window.addEventListener('pagehide', () => live.close());
live.show(document.visibilityState === 'visible');

// The pointer over a chart's plot shows the crosshair of the point whose x is nearest it; leaving
// the plot hides it. A plot that a redraw took out from under the pointer is not left.
document.addEventListener('pointermove', (event) => {
  const svg = (event.target as Element | null)?.closest('.plot')?.querySelector<SVGSVGElement>('svg[data-chart]');
  if (!svg) return;
  const { left, width } = svg.getBoundingClientRect();
  const x = ((event.clientX - left) / width) * svg.viewBox.baseVal.width;
  const off = (cross: Element) => Math.abs(Number(cross.getAttribute('data-x')) - x);
  const nearest = crossesOf(svg).reduce<Element | null>((best, cross) => (!best || off(cross) < off(best) ? cross : best), null);
  if (!nearest) return;
  const chart = svg.dataset.chart!;
  const t = Number(nearest.getAttribute('data-t'));
  if (crosshair?.chart !== chart || crosshair.t !== t || crosshair.hidden) showCrosshair({ chart, t });
});
document.addEventListener('pointerout', (event) => {
  const plot = (event.target as Element | null)?.closest('.plot');
  if (plot?.isConnected && !plot.contains(event.relatedTarget as Node | null)) showCrosshair(null);
});
