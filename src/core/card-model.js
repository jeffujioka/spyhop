// Copied from herdr-session-stats (src/card-model.js).
//
// The view model of a card: what the card shows, in which groups and order, and in which tone.
// Pure and runtime-neutral (no Orca import): the plugin's panel only draws it, mapping each tone
// to a color of the theme, so the decisions of what stands out are tested without Orca.
//
// `cardModel(card, { home })` takes a card as the card builder makes it (src/agent-cards.ts) and
// this computer's `home` folder (a folder on another Orca host is written in full), and returns
//
//   { id, focused, groups: [identity, context, spend, cache, activity] }
//
// always the five groups in this order, so the cards do not jump between refreshes. A figure is
// `{ value, tone }` (and `label` when it has one); a value that reads 'n/a' has the tone `dim`,
// any other `normal` unless said otherwise:
//
//   identity  { id, status: { tone, label }, name, session, path, branch, remote, machine,
//               harness, model }   the status tone is the agent's status (working, blocked,
//               waiting, done, idle), `dim` when unknown; `session` is the session's title as a figure,
//               null when there is none; `branch`, `remote` and `machine` are strings or null
//   context   { id, title, hero, gauge, figures }   hero: the usage percent with the window
//               as its label, in the gauge's tone; gauge: { fraction, tickFraction, tone },
//               the fill (usage over window) and the compaction trigger's place on the window,
//               each null when unknown, the tone `ok`, `warning`, `danger` or `dim`
//   spend     { id, title, hero, figures }   hero: the cost
//   cache     { id, title, hero, bar, figures }   hero: the time left, `ok`, `warning` or `dim`;
//               bar: { fraction, tone } of the hit rate, null when unknown
//   activity  { id, title, hero: null, figures }
//
// The `title` of a group is its heading in capitals; `figures` are `{ label, value, tone }`.

import { formatCost, formatDuration, formatFolderName, formatHomePath, formatPercent, formatRemote, formatSessionTitle, formatTokens, orNa } from './format.js';
import { NA } from './providers/index.js';

// A context is near compaction at these shares: of the compaction trigger when it is known,
// else of the window. [warning, danger]
const TRIGGER_LIMITS = [0.75, 0.9];
const WINDOW_LIMITS = [0.7, 0.85];

// The prompt cache is about to go cold at this time left, or less.
const CACHE_WARNING_MS = 60 * 1000;

const STATUSES = ['working', 'blocked', 'waiting', 'done', 'idle'];

const figure = (value, tone = 'normal') => ({ value, tone: value === NA ? 'dim' : tone });
const labeled = (label, value) => ({ label, ...figure(value) });
const clamp = (share) => Math.min(1, Math.max(0, share));
const toneOf = (share, [warning, danger]) => (share >= danger ? 'danger' : share >= warning ? 'warning' : 'ok');

// The gauge of the context. The trigger is the usage plus the headroom; when the headroom is
// used up the trigger is at or before the usage, so the tick sits at the usage.
function contextGauge({ contextTokens, contextMax, contextPercent, headroomTokens }) {
  const fraction = contextPercent === NA ? null : clamp(contextPercent);
  const trigger = contextTokens !== NA && headroomTokens !== NA ? contextTokens + headroomTokens : null;
  const tickFraction =
    trigger === null || contextMax === NA ? null : headroomTokens === 0 ? fraction : clamp(trigger / contextMax);
  let tone = 'dim';
  if (fraction !== null) tone = trigger > 0 ? toneOf(contextTokens / trigger, TRIGGER_LIMITS) : toneOf(contextPercent, WINDOW_LIMITS);
  return { fraction, tickFraction, tone };
}

function contextGroup(stats) {
  const gauge = contextGauge(stats);
  return {
    id: 'context',
    title: 'CONTEXT',
    hero: { ...figure(formatPercent(stats.contextPercent), gauge.tone), label: stats.contextMax === NA ? '' : `of ${formatTokens(stats.contextMax)}` },
    gauge,
    figures: [
      labeled('Used', orNa(stats.contextTokens, formatTokens)),
      labeled('Headroom', orNa(stats.headroomTokens, formatTokens)),
      labeled('Compactions', orNa(stats.autocompactions, String)),
    ],
  };
}

function spendGroup(stats) {
  return {
    id: 'spend',
    title: 'SPEND',
    hero: { ...figure(formatCost(stats.costUsd)), label: '' },
    figures: [
      labeled('Burn', orNa(stats.burnCostPerHour, (usd) => `${formatCost(usd)}/h`)),
      labeled('Tokens', orNa(stats.totalTokens, formatTokens)),
      labeled('Rate', orNa(stats.burnTokensPerMin, (tokens) => `${formatTokens(Math.round(tokens))}/min`)),
    ],
  };
}

// A cold cache (nothing left) is as much a warning as one about to go cold.
function cacheGroup(stats) {
  const left = stats.cacheLeftMs;
  const cold = left === 0;
  return {
    id: 'cache',
    title: 'CACHE',
    hero: {
      ...figure(cold ? 'cold' : formatDuration(left), left <= CACHE_WARNING_MS ? 'warning' : 'ok'),
      label: cold ? '' : 'left',
    },
    bar: stats.cacheHitRate === NA ? null : { fraction: clamp(stats.cacheHitRate), tone: 'ok' },
    figures: [
      labeled('Hit rate', formatPercent(stats.cacheHitRate)),
      labeled('Hits', orNa(stats.cacheHits, String)),
      labeled('Misses', orNa(stats.cacheMisses, String)),
    ],
  };
}

function activityGroup(stats) {
  return {
    id: 'activity',
    title: 'ACTIVITY',
    hero: null,
    figures: [
      labeled('Session', formatDuration(stats.durationMs)),
      labeled('Active', orNa(stats.sinceActivityMs, (ms) => `${formatDuration(ms)} ago`)),
      labeled('Last turn', formatDuration(stats.latencyMs)),
      labeled('Thinking', stats.thinkingLevel),
      labeled('Premium', orNa(stats.premiumRequests, String)),
    ],
  };
}

function identityGroup({ folder, title, branch, origin, harness, harnessName, status, machine, stats }, home) {
  return {
    id: 'identity',
    status: { tone: STATUSES.includes(status) ? status : 'dim', label: status ?? NA },
    name: figure(formatFolderName(folder)),
    session: formatSessionTitle(title, folder, harness),
    path: figure(formatHomePath(folder, machine ? null : home)),
    branch: branch ?? null,
    remote: formatRemote(origin),
    machine: machine ?? null,
    harness: figure(harnessName),
    model: figure(stats.model),
  };
}

// `home`: this computer's home folder.
export function cardModel(card, { home }) {
  const { stats } = card;
  return {
    id: card.id,
    focused: card.focused === true,
    groups: [identityGroup(card, home), contextGroup(stats), spendGroup(stats), cacheGroup(stats), activityGroup(stats)],
  };
}
