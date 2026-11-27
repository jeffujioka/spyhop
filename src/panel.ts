// The live panel's page, Orca's HTML panel (`ui: "html"`), which Orca wraps in a generated page
// with the global `orca` (Orca's Frame API). The only code that touches the DOM: it puts the
// stylesheet in a <style>, makes the controller (src/live/controller.ts) with `orca`, and draws
// each screen the controller makes as the body's markup, keeping the scroll position across
// redraws. A click on a control (`data-press`) goes to the controller, which also hears when the
// page is shown or hidden and when it goes.
import { createLive } from './live/controller.ts';
import { STYLE } from './live/style.ts';

const style = document.createElement('style');
style.textContent = STYLE;
document.head.append(style);

const live = createLive(orca, (html) => {
  const scroller = document.scrollingElement;
  const top = scroller?.scrollTop ?? 0;
  document.body.innerHTML = html;
  if (scroller) scroller.scrollTop = top;
});

document.addEventListener('click', (event) => {
  const control = (event.target as Element | null)?.closest('[data-press]');
  if (control) live.press(control.getAttribute('data-press')!);
});
document.addEventListener('visibilitychange', () => live.show(document.visibilityState === 'visible'));
window.addEventListener('pagehide', () => live.close());
live.show(document.visibilityState === 'visible');
