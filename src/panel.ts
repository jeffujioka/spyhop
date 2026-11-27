// The live panel's page, Orca's HTML panel (`ui: "html"`), which Orca wraps in a generated page
// with the global `orca` (Orca's Frame API). The only code that touches the DOM: it puts the
// stylesheet in a <style>, makes the controller (src/live/controller.ts) with `orca`, and draws
// each screen the controller makes as the body's markup, keeping the scroll position and the
// focused control across a redraw of the same screen and starting a new screen at the top, as the
// controller says. A click on a control (`data-press`), or Enter or Space on a focused card,
// folded line or row of the attention list (a button by its role, `role="button"`), goes to the
// controller, which also hears when the page is shown or hidden and when it goes.
import { createLive } from './live/controller.ts';
import { STYLE } from './live/style.ts';

const style = document.createElement('style');
style.textContent = STYLE;
document.head.append(style);

const live = createLive(orca, (html, { sameScreen }) => {
  const scroller = document.scrollingElement;
  const top = sameScreen ? (scroller?.scrollTop ?? 0) : 0;
  // The new markup replaces the focused control, which would send the keyboard back to the start
  // on every refresh; the same control is found again by its `data-press` and its kind, the
  // `data-row` of a row of the attention list or the `data-part` of a card or a folded line: a
  // card and its rows share one `data-press`, and a row comes and goes between two refreshes, so
  // a place among them would move the focus to another control. When no control of that kind is
  // drawn any more (the row went, or the card folded as its agent went done), the card or folded
  // line of that `data-press` is focused, and only without one the first control of it.
  const focused = sameScreen ? document.activeElement : null;
  const pressed = focused?.getAttribute('data-press');
  const selector = pressed ? `[data-press="${CSS.escape(pressed)}"]` : null;
  const kindName = focused?.hasAttribute('data-row') ? 'data-row' : focused?.hasAttribute('data-part') ? 'data-part' : null;
  const kind = kindName ? `[${kindName}="${CSS.escape(focused!.getAttribute(kindName)!)}"]` : '';
  document.body.innerHTML = html;
  if (selector) {
    const found = document.querySelector<HTMLElement>(selector + kind) ?? document.querySelector<HTMLElement>(`${selector}[data-part]`) ?? document.querySelector<HTMLElement>(selector);
    found?.focus({ preventScroll: true });
  }
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
document.addEventListener('visibilitychange', () => live.show(document.visibilityState === 'visible'));
window.addEventListener('pagehide', () => live.close());
live.show(document.visibilityState === 'visible');
