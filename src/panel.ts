// The live panel's page, Orca's HTML panel (`ui: "html"`), which Orca wraps in a generated page
// with the global `orca` (Orca's Frame API). The only code that touches the DOM: it puts the
// stylesheet in a <style>, makes the controller (src/live/controller.ts) with `orca`, and draws
// each screen the controller makes as the body's markup, keeping the scroll position and the
// focused control across a redraw of the same screen and starting a new screen at the top, as the
// controller says. A click on a control (`data-press`), or Enter or Space on a focused card or
// folded line (a button by its role, `role="button"`), goes to the controller, which also hears
// when the page is shown or hidden and when it goes.
import { createLive } from './live/controller.ts';
import { STYLE } from './live/style.ts';

const style = document.createElement('style');
style.textContent = STYLE;
document.head.append(style);

const live = createLive(orca, (html, { sameScreen }) => {
  const scroller = document.scrollingElement;
  const top = sameScreen ? (scroller?.scrollTop ?? 0) : 0;
  // The new markup replaces the focused control, which would send the keyboard back to the start
  // on every refresh; the same control is found again by its `data-press`, unique on a screen.
  const pressed = sameScreen ? document.activeElement?.getAttribute('data-press') : null;
  document.body.innerHTML = html;
  if (pressed) document.querySelector<HTMLElement>(`[data-press="${CSS.escape(pressed)}"]`)?.focus({ preventScroll: true });
  if (scroller) scroller.scrollTop = top;
});

document.addEventListener('click', (event) => {
  const control = (event.target as Element | null)?.closest('[data-press]');
  if (control) live.press(control.getAttribute('data-press')!);
});
// A <button> turns Enter and Space into a click of its own; a card or a folded line, a button
// only by its role, is pressed here, and Space does not scroll the page.
document.addEventListener('keydown', (event) => {
  const control = event.target as Element | null;
  if ((event.key !== 'Enter' && event.key !== ' ') || !control?.matches('[role="button"][data-press]')) return;
  event.preventDefault();
  live.press(control.getAttribute('data-press')!);
});
document.addEventListener('visibilitychange', () => live.show(document.visibilityState === 'visible'));
window.addEventListener('pagehide', () => live.close());
live.show(document.visibilityState === 'visible');
