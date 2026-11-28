// The worker's answers the page tests give the stand-in for Orca (test/page/helpers/orca.ts), in
// the shapes of the panel <-> worker contract (src/protocol.ts): the fleet of the cards a test
// draws, in one group of this computer, with the burn rate card it gives, and the session of each
// of its cards, with the charts it gives. A test changes its fleet between two refreshes by
// changing what `fleet` returns. Each fleet answer's cards have been in their state as many
// minutes as the request's number, so that a test sees which answer the page drew last: the
// answer to the request 3 reads `3m` on each card. A range tab is answered with the Spend tab a
// test gives for its range, and with none for a range it gives none of.
import { MINUTE_MS } from '../../../src/core/series.js';
import type { AttentionRow, BurnCard, CardView, FleetAnswer, Range, RangeAnswer, RangeTab, SessionAnswer, SessionView, SpendView } from '../../../src/protocol.ts';
import type { Answers } from './orca.ts';

export const FIX = 'Fix the login bug';
export const DOCS = 'Write the docs';

// The card of the session titled `title`, its id, of an omp agent working in this computer's
// folder `spyhop`; `fields` change any of it.
export function card(title: string, fields: Partial<CardView> = {}): CardView {
  return {
    id: title,
    state: 'working',
    stateSinceMs: MINUTE_MS,
    title,
    folder: 'spyhop',
    branch: 'main',
    harness: 'omp',
    model: 'claude-opus-5.5-1m',
    cost: 0.1,
    reading: null,
    context: { tokens: 50_000, window: 200_000, percent: 0.25, compactAt: 'n/a', spark: [20_000, 50_000] },
    tokensLeft: 'n/a',
    cacheHitRate: 0.9,
    subAgents: null,
    burnPerHour: 'n/a',
    pane: null,
    ...fields,
  };
}

// The attention list's row of the blocked agent of `of`, blocked for a minute.
export const blockedRow = (of: CardView): AttentionRow => ({ kind: 'state', card: of.id, title: of.title, state: 'blocked', sinceMs: MINUTE_MS });

// The fleet a test draws: its cards, the rows of its attention list, what it gives of the burn
// rate card, and what it gives of the session of each card, by the card's id.
export type Fleet = { cards: CardView[]; attention?: AttentionRow[]; burn?: Partial<BurnCard>; sessions?: Record<string, Partial<SessionView>> };

// The answer to the fleet request `request`.
function fleetAnswer(request: number, { cards, attention = [], burn }: Fleet): FleetAnswer {
  const counts: FleetAnswer['counts'] = {};
  for (const { state } of cards) {
    const key = state as keyof FleetAnswer['counts'];
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return {
    request,
    groups: [{ id: 'local', name: 'This computer', count: cards.length, cards: cards.map((drawn) => ({ ...drawn, stateSinceMs: request * MINUTE_MS })) }],
    counts,
    burn: { perHour: 'n/a', total: 'n/a', tokensPerMin: 'n/a', cacheHitRate: 'n/a', running: 'n/a', leftOut: 0, layers: 'n/a', endMs: request * MINUTE_MS, ...burn },
    attention,
  };
}

// The session of `of`, read in part: its figures, models and Session section, with no chart.
function session(of: CardView): SessionView {
  return {
    card: of,
    linked: true,
    path: of.folder,
    figures: { cost: of.cost, subShare: 'n/a', tokens: 'n/a', cacheShare: 'n/a', calls: 'n/a', failedTools: 'n/a', durationMs: 'n/a', startMs: 'n/a' },
    costFrom: { copilot: 0, logged: of.cost },
    context: null,
    tokens: null,
    cost: null,
    subAgents: null,
    tools: null,
    models: { by: 'cost', rows: [{ model: of.model, main: true, subAgents: 0, value: of.cost }] },
    session: { startedMs: 'n/a', thinking: 'n/a', latencyMs: 'n/a', premium: 'n/a', branch: of.branch, remote: null, host: null },
  };
}

// The worker's answers over the fleet `fleet` returns at each request: the fleet, and the session
// of each of its cards, with what the fleet gives of it (null, as for an agent Orca no longer
// lists, for a card not in it); and each range tab, the Spend tab with what `spend` gives of its
// range.
export function answersOf(fleet: () => Fleet, spend: Partial<Record<Range, SpendView>> = {}): Answers {
  return {
    'spyhop.fleet': ({ request }): FleetAnswer => fleetAnswer(request as number, fleet()),
    'spyhop.session': ({ request, card: id }): SessionAnswer => {
      const { cards, sessions } = fleet();
      const of = cards.find((found) => found.id === id);
      return { request: request as number, session: of ? { ...session(of), ...sessions?.[of.id] } : null };
    },
    'spyhop.range': ({ request, tab, range }): RangeAnswer => ({
      request: request as number,
      tab: tab as RangeTab,
      range: range as Range,
      spend: tab === 'spend' ? (spend[range as Range] ?? null) : null,
      notRead: [],
    }),
  };
}
