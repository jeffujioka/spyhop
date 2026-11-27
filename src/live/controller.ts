// The live panel's controller: the screen it draws and the refresh loop that feeds it, with no DOM
// (src/panel.ts is the page's glue). While shown it asks the worker for the fleet now and then
// REFRESH_INTERVAL_MS after each ask started, or at its answer when that came later, never two
// asks at once, and asks nothing while hidden or once closed. During an ask it draws each Orca
// host's group the worker posts for it (`spyhop.group`) in the place of that host's drawn group;
// the whole answer then replaces the groups and is kept as the last whole fleet, the only source
// of the header's counts. A failed answer keeps what is drawn; a draw that fails is left uncaught,
// for Orca to log as the frame's error. Its only ways out are
// `frame.plugin.request` and `draw(html)`.
import { REFRESH_INTERVAL_MS } from '../core/refresh.js';
import { withGroup } from '../fleet.ts';
import type { OrcaFrameApi } from 'orca/frame';
import { type FleetView, fleetScreen } from './fleet.ts';

// What the controller uses of Orca's Frame API (the global `orca` of an HTML panel).
export type Frame = {
  plugin: { request: OrcaFrameApi['plugin']['request']; on: OrcaFrameApi['plugin']['on'] };
  on(event: 'theme', handler: () => void): unknown;
};

// `show`: the panel is visible or not, as the page reports it; `press`: a control's
// `data-press` value was pressed; `close`: the page goes, and the controller with it.
export type Live = { show(visible: boolean): void; press(target: string): void; close(): void };

const LOADING = '<main data-screen="fleet"><p data-part="loading" class="muted">Reading the Orca agents</p></main>';
const EMPTY = '<main data-screen="fleet"><p class="muted">No Orca agents</p></main>';

export function createLive(frame: Frame, draw: (html: string) => void): Live {
  let view: FleetView = { groups: [], whole: null };
  // the number of the newest ask, which no other ask has, and whether it is unanswered
  let request = 0;
  let asking = false;
  let shown = false;
  let closed = false;
  // the timer of the next ask; null when none is set: it ran out, or the panel was hidden
  let timer: ReturnType<typeof setTimeout> | null = null;

  function redraw() {
    if (view.groups.length > 0) draw(fleetScreen(view));
    else draw(view.whole ? EMPTY : LOADING);
  }

  // Asks the worker, and sets the timer of the next ask, REFRESH_INTERVAL_MS from this one's
  // start. A timer that runs out during an ask leaves the next ask to its answer.
  function ask() {
    timer = setTimeout(() => {
      timer = null;
      if (!asking) ask();
    }, REFRESH_INTERVAL_MS);
    asking = true;
    request += 1;
    frame.plugin
      .request('spyhop.fleet', { request })
      .then(
        (answer) => {
          if (closed) return;
          view = { groups: answer.groups, whole: answer };
          redraw();
        },
        // a failed answer keeps what is drawn; a failed draw is not caught, so Orca logs it
        () => undefined,
      )
      .finally(() => {
        asking = false;
        if (shown && !timer) ask();
      });
  }

  // A group posted for the ask out is drawn; one of an older ask, or of an ask whose answer is
  // in, is not.
  const posts = frame.plugin.on('spyhop.group', (post) => {
    if (!asking || post.request !== request) return;
    view = { ...view, groups: withGroup(view.groups, post.group) };
    redraw();
  });

  function show(visible: boolean) {
    shown = visible && !closed;
    if (!shown && timer) {
      clearTimeout(timer);
      timer = null;
    } else if (shown && !timer && !asking) {
      ask();
    }
  }

  redraw();
  return {
    show,
    // no control is drawn yet: the fleet screen's cards open nothing until the session screen
    press() {},
    close() {
      show(false);
      closed = true;
      posts.dispose();
    },
  };
}
