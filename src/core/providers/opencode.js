// Copied from herdr-session-stats (src/providers/opencode.js); the database layout is described
// in that repository's docs/.
//
// opencode provider: figures from the rows of an opencode session (herdr-session-stats
// docs/opencode-session-format.md) as stats of src/core/providers/index.js. A figure with no
// source in the database is left out, which the registry turns into 'n/a'; nothing here
// estimates one.
//
// Pure: no Orca API, no database or file access, no runtime-specific API. `input` is
// `{ messages, compactions }` (see `opencodeProvider`); the rows are read from the database by
// src/core/providers/opencode-sources.js.
//
// Structure as omp.js: `parseSession` makes one `session` value; each entry of `FIGURES` is a
// function `(session, now) => partial stats`. The rows are the whole session, so `detail` of
// them always gives its series (src/core/series.js).

import { burnRate, isNumber } from './shared.js';
import { detailOf, pushRecent } from '../series.js';

function parseSession({ messages, compactions }) {
  const rows = Array.isArray(messages) ? messages : [];
  const assistants = rows.filter((row) => row?.role === 'assistant');
  // A compaction summary is an assistant message written by the compaction agent, with its own
  // model; the session's model, level, context and turn are those of the messages around it.
  const turns = assistants.filter((row) => row.summary !== 1);
  return { rows, assistants, turns, compactions };
}

// Sum of `pick(assistant message)` over the messages that have it; undefined when none has.
function sumAssistants(session, pick) {
  const values = session.assistants.map(pick).filter(isNumber);
  return values.length ? values.reduce((a, b) => a + b, 0) : undefined;
}

// The message's token total as logged; a message that logged only its parts counts their sum
// when every part is there (they add up to the logged total on every message that has both).
function messageTotal(row) {
  if (isNumber(row.total)) return row.total;
  const parts = [row.input, row.output, row.reasoning, row.cacheRead, row.cacheWrite];
  return parts.every(isNumber) ? parts.reduce((a, b) => a + b, 0) : undefined;
}

// Size of the prompt a message sent: what it read, wrote and sent fresh. Needs all three counts.
function promptTokens(row) {
  const { input, cacheRead, cacheWrite } = row;
  return isNumber(input) && isNumber(cacheRead) && isNumber(cacheWrite) ? input + cacheRead + cacheWrite : undefined;
}

function model({ turns }) {
  const latest = turns.findLast((row) => typeof row.modelId === 'string' && row.modelId);
  return latest ? { model: latest.modelId } : {};
}

// First message to the end of the last one: a turn ends when it completed, a user message at
// its own time.
function span({ rows }) {
  const starts = rows.map((row) => row.created).filter(isNumber);
  const ends = rows.map((row) => (isNumber(row.completed) ? row.completed : row.created)).filter(isNumber);
  return starts.length && ends.length ? { first: Math.min(...starts), last: Math.max(...ends) } : null;
}

function duration(session) {
  const range = span(session);
  return range ? { durationMs: range.last - range.first } : {};
}

function tokens(session) {
  const totalTokens = sumAssistants(session, messageTotal);
  return totalTokens === undefined ? {} : { totalTokens };
}

// Cost the database logged per message (herdr-session-stats decision D5); no price table.
function cost(session) {
  const costUsd = sumAssistants(session, (row) => row.cost);
  return costUsd === undefined ? {} : { costUsd };
}

// Hit rate over the token counts (herdr-session-stats decision D6), from the messages that
// logged all three counts.
function cacheRate({ assistants }) {
  const counted = assistants.filter((row) => promptTokens(row) !== undefined);
  const total = counted.reduce((sum, row) => sum + promptTokens(row), 0);
  if (!counted.length || total <= 0) return {};
  return { cacheHitRate: counted.reduce((sum, row) => sum + row.cacheRead, 0) / total };
}

// A turn is a hit when its cacheRead is above 0 and a miss when it is 0 (herdr-session-stats
// decision D6). A message that sent no prompt (an aborted or failed request) is not a turn.
function cacheTurns({ assistants }) {
  const sent = assistants.filter((row) => promptTokens(row) > 0);
  if (!sent.length) return {};
  const cacheHits = sent.filter((row) => row.cacheRead > 0).length;
  return { cacheHits, cacheMisses: sent.length - cacheHits };
}

// Compactions that finished and that opencode started by itself (herdr-session-stats decision
// D8 (f)); null when the database has no record of them.
function autocompactions({ compactions }) {
  return isNumber(compactions) ? { autocompactions: compactions } : {};
}

// Context usage is the prompt of the latest turn that sent one. The window comes from a
// catalogue outside the database, so the maximum, the percentage and the headroom are not
// figures of this provider.
function context({ turns }) {
  const sizes = turns.map(promptTokens).filter((size) => size > 0);
  return sizes.length ? { contextTokens: sizes.at(-1) } : {};
}

// Burn rate from the session's own duration, cost and token figures.
const burn = (session) => burnRate({ ...duration(session), ...cost(session), ...tokens(session) });

function sinceActivity(session, now) {
  const range = span(session);
  return range && isNumber(now) ? { sinceActivityMs: now - range.last } : {};
}

// Last turn: the latest reply that completed minus the user message that began it (the
// message its `parentId` names).
function latency({ rows, turns }) {
  const reply = turns.findLast((row) => isNumber(row.completed));
  const began = reply && rows.find((row) => row.id === reply.parentId && row.role === 'user');
  return began && isNumber(began.created) ? { latencyMs: reply.completed - began.created } : {};
}

// opencode's `variant` of a message is the reasoning level the user chose for it.
function thinking({ turns }) {
  const latest = turns.findLast((row) => typeof row.modelId === 'string' && row.modelId);
  return typeof latest?.variant === 'string' && latest.variant ? { thinkingLevel: latest.variant } : {};
}

const FIGURES = [
  model,
  duration,
  tokens,
  cost,
  cacheRate,
  cacheTurns,
  autocompactions,
  context,
  burn,
  sinceActivity,
  latency,
  thinking,
];

// The series of the session: the prompt of each assistant message that sent one, a compaction
// summary's included, since each is a model call.
function detail({ assistants }) {
  const recent = [];
  for (const size of assistants.map(promptTokens)) if (size > 0) pushRecent(recent, size);
  return detailOf({ recent });
}

// `input` is `{ messages, compactions }`: `messages`, the session's message rows in order
// (`{ id, role, parentId, created, completed, modelId, variant, summary, cost, total, input,
// output, reasoning, cacheRead, cacheWrite }`, each a number, a string or null as the database
// holds it; `summary` is 1 on a compaction summary), and `compactions`, the number of finished
// automatic compactions of the session or null when the database does not record them.
export const opencodeProvider = {
  readStats(input, now) {
    const session = parseSession(input ?? {});
    return Object.assign({}, ...FIGURES.map((figure) => figure(session, now)), { detail: detail(session) });
  },
};
