// The live panel's controller: the screen it draws, the fleet, one session's or a range tab's,
// and the refresh loop that feeds it, with no DOM (src/panel.ts is the page's glue). While shown
// it asks the worker for what the screen draws, the fleet or the session REFRESH_INTERVAL_MS and a
// range tab RANGE_REFRESH_MS after each ask started, or at its answer when that came later, never
// two asks at once, and asks nothing while
// hidden or once closed. During a fleet ask it draws each Orca host's group the
// worker posts for it (`spyhop.group`) in the place of that host's drawn group; the whole answer
// then replaces the groups and is kept as the last whole fleet, the only source of the header's
// counts. Pressing a card or a folded line draws that session's screen at once, from the fleet's
// card, and asks for the session as soon as no ask is out; back draws the last fleet and asks for
// the fleet the same way, as does a session answer that says Orca no longer lists the agent. Show
// all lists every sub-agent of the open session until the screen changes. Focus
// asks the worker to focus the pane of the open session's agent; its answer, and its failure,
// change nothing drawn. The Live tab draws the last fleet, a range tab or range draws that tab
// over the range at once, and each asks for what it draws as soon as no ask is out; pressing the
// tab or the range shown does nothing. The range is Day when the controller starts, and a range
// tab keeps the one pressed last. An answer is drawn only on the screen, the card, the tab and the
// range it was asked for.
// A change of Orca's theme draws nothing: the stylesheet's variables follow it in place. A failed
// answer keeps what is drawn; a draw that fails is left uncaught, for Orca to log as the frame's
// error. Each drawing says whether it is of the screen drawn before it, the fleet, the session
// of the same card or the same range tab, so that the page keeps its scroll position and focus
// across a refresh and starts a new screen at the top. Its only ways out are
// `frame.plugin.request` and `draw(html, drawing)`.
import { RANGE_REFRESH_MS, REFRESH_INTERVAL_MS } from '../core/refresh.js';
import { withGroup } from '../fleet.ts';
import type { OrcaFrameApi } from 'orca/frame';
import type { CardView, Range, RangeAnswer, RangeTab, SessionView } from '../protocol.ts';
import { type FleetView, fleetScreen } from './fleet.ts';
import { sessionScreen } from './session.ts';
import { spendTab } from './spend.ts';
import { tabBar } from './tabs.ts';

// What the controller uses of Orca's Frame API (the global `orca` of an HTML panel).
export type Frame = {
  plugin: { request: OrcaFrameApi['plugin']['request']; on: OrcaFrameApi['plugin']['on'] };
  on(event: 'theme', handler: () => void): unknown;
};

// `show`: the panel is visible or not, as the page reports it; `press`: a control's
// `data-press` value was pressed; `close`: the page goes, and the controller with it.
export type Live = { show(visible: boolean): void; press(target: string): void; close(): void };

// What the page is told of a drawing besides its markup: whether it is of the screen drawn
// before it.
export type Drawing = { sameScreen: boolean };

// The screen drawn: the fleet, the session of the card `id`, with the fleet's card of it (null
// when the fleet drawn has none), its answer once one is in, and whether every sub-agent is
// listed (`showAll`), or the range tab `tab` over `range`, with its answer once one is in.
type Screen =
  | { name: 'fleet' }
  | { name: 'session'; id: string; card: CardView | null; session: SessionView | null; showAll: boolean }
  | { name: 'range'; tab: RangeTab; range: Range; answer: RangeAnswer | null };

const LIVE_TABS = tabBar('live', null);
const LOADING = `<main data-screen="fleet">${LIVE_TABS}<p data-part="loading" class="muted">Reading the Orca agents</p></main>`;
const EMPTY = `<main data-screen="fleet">${LIVE_TABS}<p class="muted">No Orca agents</p></main>`;
const FLEET: Screen = { name: 'fleet' };

// The range tab `screen`: its tab bar, then its answer, or a loading line until one is in.
function rangeScreen({ tab, range, answer }: Extract<Screen, { name: 'range' }>) {
  const body = answer ? spendTab(answer) : '<p data-part="loading" class="muted">Reading the history</p>';
  return `<main data-screen="range" data-tab="${tab}">${tabBar(tab, range)}${body}</main>`;
}

export function createLive(frame: Frame, draw: (html: string, drawing: Drawing) => void): Live {
  let view: FleetView = { groups: [], whole: null };
  let screen: Screen = FLEET;
  // the number of the newest ask, which no other ask has, and whether it is unanswered
  let request = 0;
  let asking = false;
  // the range of the range tabs, kept for the controller's life
  let range: Range = 'day';
  // whether the screen changed during an ask, so that its answer is followed by an ask at once
  let due = false;
  let shown = false;
  let closed = false;
  // the timer of the next ask; null when none is set: it ran out, or the panel was hidden
  let timer: ReturnType<typeof setTimeout> | null = null;
  // the screen drawn last, `fleet`, the id of the session's card or the range tab; null before
  // the first drawing
  let drawn: string | null = null;

  function redraw() {
    const now = screen.name === 'session' ? `session:${screen.id}` : screen.name === 'range' ? `range:${screen.tab}` : 'fleet';
    const drawing = { sameScreen: now === drawn };
    drawn = now;
    if (screen.name === 'session') draw(sessionScreen(screen.session, { card: screen.card, showAll: screen.showAll, now: Date.now() }), drawing);
    else if (screen.name === 'range') draw(rangeScreen(screen), drawing);
    else if (view.groups.length > 0) draw(fleetScreen(view), drawing);
    else draw(view.whole ? EMPTY : LOADING, drawing);
  }

  // Asks the worker for what the screen draws, and sets the timer of the next ask,
  // REFRESH_INTERVAL_MS from this one's start, RANGE_REFRESH_MS on a range tab. A timer that runs
  // out during an ask leaves the next ask to its answer.
  function ask() {
    clearTimeout(timer ?? undefined);
    timer = setTimeout(
      () => {
        timer = null;
        if (!asking) ask();
      },
      screen.name === 'range' ? RANGE_REFRESH_MS : REFRESH_INTERVAL_MS,
    );
    asking = true;
    due = false;
    request += 1;
    const asked = screen;
    // a failed answer keeps what is drawn; a failed draw is not caught, so Orca logs it
    const kept = () => undefined;
    const answered =
      asked.name === 'session'
        ? frame.plugin.request('spyhop.session', { request, card: asked.id }).then(({ session }) => {
            if (closed || screen.name !== 'session' || screen.id !== asked.id) return;
            if (session) screen = { ...screen, session };
            else showFleet();
            redraw();
          }, kept)
        : asked.name === 'range'
          ? frame.plugin.request('spyhop.range', { request, tab: asked.tab, range: asked.range }).then((answer) => {
              if (closed || screen.name !== 'range' || screen.tab !== asked.tab || screen.range !== asked.range) return;
              screen = { ...screen, answer };
              redraw();
            }, kept)
          : frame.plugin.request('spyhop.fleet', { request }).then((answer) => {
              if (closed) return;
              view = { groups: answer.groups, whole: answer };
              if (screen.name === 'fleet') redraw();
            }, kept);
    answered.finally(() => {
      asking = false;
      if (shown && (!timer || due)) ask();
    });
  }

  // The fleet screen, with the fleet asked for as soon as no ask is out.
  function showFleet() {
    screen = FLEET;
    askSoon();
  }

  // Asks at once, or at the answer of the ask out; nothing while hidden.
  function askSoon() {
    if (asking) due = true;
    else if (shown) ask();
  }

  // Draws `next` and asks for it as soon as no ask is out.
  function switchTo(next: Screen) {
    screen = next;
    redraw();
    askSoon();
  }

  // A group posted for the fleet ask out is drawn on the fleet screen; one of an older ask, or of
  // an ask whose answer is in, is not.
  const posts = frame.plugin.on('spyhop.group', (post) => {
    if (!asking || post.request !== request || screen.name !== 'fleet') return;
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

  function press(target: string) {
    if (closed) return;
    if (target.startsWith('open:')) {
      const id = decodeURIComponent(target.slice('open:'.length));
      const card = view.groups.flatMap((group) => group.cards).find((found) => found.id === id) ?? null;
      screen = { name: 'session', id, card, session: null, showAll: false };
      askSoon();
      redraw();
    } else if (target === 'tab:live') {
      if (screen.name !== 'fleet') switchTo(FLEET);
    } else if (target.startsWith('tab:')) {
      const tab = target.slice('tab:'.length) as RangeTab;
      if (screen.name !== 'range' || screen.tab !== tab) switchTo({ name: 'range', tab, range, answer: null });
    } else if (target.startsWith('range:') && screen.name === 'range' && target !== `range:${screen.range}`) {
      range = target.slice('range:'.length) as Range;
      switchTo({ ...screen, range, answer: null });
    } else if (target === 'back' && screen.name === 'session') {
      showFleet();
      redraw();
    } else if (target === 'all' && screen.name === 'session') {
      screen = { ...screen, showAll: true };
      redraw();
    } else if (target === 'focus' && screen.name === 'session') {
      // the pane of the card the screen's header is drawn from; whether Orca focused it, or why
      // not, is the worker's to log, and changes nothing drawn
      const pane = (screen.session?.card ?? screen.card)?.pane;
      if (pane) frame.plugin.request('spyhop.focus', pane).catch(() => undefined);
    }
  }

  redraw();
  return {
    show,
    press,
    close() {
      show(false);
      closed = true;
      posts.dispose();
    },
  };
}
