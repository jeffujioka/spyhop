// The worker's answers the page tests give the stand-in for Orca (test/page/helpers/orca.ts), in
// the shapes of the panel <-> worker contract (src/protocol.ts): the fleet of the cards a test
// draws, in one group of this computer, and the session of each of its cards. A test changes its
// fleet between two refreshes by changing what `fleet` returns. Each fleet answer's cards have
// been in their state as many minutes as the request's number, so that a test sees which answer
// the page drew last: the answer to the request 3 reads `3m` on each card.
import type { AttentionRow, CardView, FleetAnswer, SessionAnswer, SessionView } from '../../../src/protocol.ts';
import type { Answers } from './orca.ts';

export const FIX = 'Fix the login bug';
export const DOCS = 'Write the docs';

const MINUTE = 60_000;

// The card of the session titled `title`, its id, of an omp agent working in this computer's
// folder `spyhop`; `fields` change any of it.
export function card(title: string, fields: Partial<CardView> = {}): CardView {
  return {
    id: title,
    state: 'working',
    stateSinceMs: MINUTE,
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
export const blockedRow = (of: CardView): AttentionRow => ({ kind: 'state', card: of.id, title: of.title, state: 'blocked', sinceMs: MINUTE });

// The fleet a test draws: its cards, and the rows of its attention list.
export type Fleet = { cards: CardView[]; attention?: AttentionRow[] };

// The answer to the fleet request `request`.
export function fleetAnswer(request: number, { cards, attention = [] }: Fleet): FleetAnswer {
  const counts: FleetAnswer['counts'] = {};
  for (const { state } of cards) counts[state as keyof FleetAnswer['counts']] = (counts[state as keyof FleetAnswer['counts']] ?? 0) + 1;
  return {
    request,
    groups: [{ id: 'local', name: 'This computer', count: cards.length, cards: cards.map((drawn) => ({ ...drawn, stateSinceMs: request * MINUTE })) }],
    counts,
    burn: { perHour: 'n/a', total: 'n/a', tokensPerMin: 'n/a', cacheHitRate: 'n/a', running: 'n/a', leftOut: 0, layers: 'n/a', endMs: request * MINUTE },
    attention,
  };
}

// The session of `of`, read in part: its figures, models and Session section, with no chart.
export function session(of: CardView): SessionView {
  return {
    card: of,
    linked: true,
    path: of.folder,
    figures: { cost: of.cost, subShare: 'n/a', tokens: 'n/a', cacheShare: 'n/a', calls: 'n/a', failedTools: 'n/a', durationMs: 'n/a', startMs: 'n/a' },
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
// of each of its cards (null, as for an agent Orca no longer lists, for a card not in it).
export function answersOf(fleet: () => Fleet): Answers {
  return {
    'spyhop.fleet': ({ request }): FleetAnswer => fleetAnswer(request as number, fleet()),
    'spyhop.session': ({ request, card: id }): SessionAnswer => {
      const of = fleet().cards.find((found) => found.id === id);
      return { request: request as number, session: of ? session(of) : null };
    },
  };
}
