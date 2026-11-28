// Copied from herdr-session-stats (src/providers/opencode.js); the database layout is described
// in that repository's docs/.
//
// opencode provider: figures from the rows of an opencode session (herdr-session-stats
// docs/opencode-session-format.md) as stats of src/core/providers/index.js. A figure with no
// source in the database is left out, which the registry turns into 'n/a'; nothing here
// estimates one.
//
// Pure: no Orca API, no database or file access, no runtime-specific API. `input` is
// `{ messages, compactions, tools, loggedCost, sources }` (see `opencodeProvider`), in one shape
// whichever generation of opencode's tables the rows are read from, by
// src/core/providers/opencode-sources.js, which also reads the window from opencode's catalogue.
//
// Structure as omp.js: `parseSession` makes one `session` value; each entry of `FIGURES` is a
// function `(session, now) => partial stats`. The rows are the whole session, so `detail` of
// them always gives its series (src/core/series.js), once its tool calls are read too.

import { burnRate, isNumber, tokenCount } from './shared.js';
import { addCall, addCost, addMinute, detailOf, entryOf, newSeries, pushRecent } from '../series.js';
import { callCost, COPILOT } from '../copilot-prices.js';
import { modelKey, noteCall, noteEntry, noteHorizon, notePrompt, noteThinking, noteTool, noteTurnEnd } from '../insights.js';
import { SUBAGENT_TOOLS } from '../trace.js';

function parseSession({ messages, compactions, tools, loggedCost, sources }) {
  const rows = Array.isArray(messages) ? messages : [];
  const assistants = rows.filter((row) => row?.role === 'assistant');
  // A compaction summary is an assistant message written by the compaction agent, with its own
  // model; the session's model, level, context and turn are those of the messages around it.
  const turns = assistants.filter((row) => row.summary !== 1);
  const window = isNumber(sources?.window) && sources.window > 0 ? sources.window : null;
  return { rows, assistants, turns, compactions, tools: Array.isArray(tools) ? tools : null, loggedCost: isNumber(loggedCost) ? loggedCost : null, window };
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

// A message that sent and wrote nothing (an aborted or failed request) is no model call.
const isCall = (row) => [row.input, row.cacheRead, row.cacheWrite, row.output].some((count) => tokenCount(count) > 0);

// The cost of the assistant message `row`, by the Copilot cost rule (`callCost`).
function costOf(row) {
  const tokens = { uncached: tokenCount(row.input), read: tokenCount(row.cacheRead), write: tokenCount(row.cacheWrite), output: tokenCount(row.output) };
  return callCost(row.providerId, row.modelId, tokens, row.cost);
}

// The sum of the costs of the session's messages (see costOf); undefined when none has one, or
// once a Copilot call's model is not in the Copilot price table.
function callsCost(session) {
  if (session.assistants.some((row) => row.providerId === COPILOT && costOf(row) === null)) return undefined;
  return sumAssistants(session, costOf);
}

// Adds `rows`, `historyRowsQuery`'s rows of opencode-sources.js, to `ins` (src/core/insights.js):
// the model calls (see isCall) to its daily lines, each on the day it was created (the day a
// catch-up reads it again by), under its model with its provider, at the cost of costOf, with the
// tokens `tokens` counts of it (none for a call that logs no total and not all its parts); a row
// that logs no model is in no line. The rows of the root session (`own`) also run in its Trace,
// from the first of their times to the last: a call from its `created` to where its first tool
// call starts, else to its `completed`; a tool call from its `start` (else its message's
// `created`) to its `end` (else its message's `completed`); a turn ends when a call that is no
// compaction summary completes with a `finish` other than `tool-calls`, or none (an aborted or a
// failed one), and a user message is a prompt. No span of a later row starts before this one's
// `created`, as the rows come by `created`.
export function opencodeInsights(rows, ins) {
  for (const row of rows) {
    noteHorizon(ins, row.created);
    const own = row.own === 1;
    if (own) {
      noteEntry(ins, row.created);
      noteEntry(ins, row.completed);
    }
    if (row.role === 'user') {
      if (own && isNumber(row.created)) notePrompt(ins, row.created);
    } else if (row.role === 'tool') {
      const [start, end] = [isNumber(row.start) ? row.start : row.created, isNumber(row.end) ? row.end : row.completed];
      if (own) noteTool(ins, start, end, SUBAGENT_TOOLS.opencode.includes(row.name));
    } else {
      if (isCall(row) && typeof row.modelId === 'string' && isNumber(row.created)) {
        const [uncached, read, write, output] = [row.input, row.cacheRead, row.cacheWrite, row.output].map(tokenCount);
        const tokens = tokenCount(messageTotal(row));
        noteCall(ins, { end: row.created, model: modelKey(row.providerId, row.modelId), tokens, uncached, read, write, output, cost: costOf(row), copilot: row.providerId === COPILOT });
        if (own) noteThinking(ins, row.created, [row.toolStart, row.completed, row.created].find(isNumber));
      }
      const endsTurn = row.finish !== 'tool-calls' && row.summary !== 1;
      if (own && endsTurn && isNumber(row.completed)) noteTurnEnd(ins, row.completed);
    }
  }
}

// Cost the database logged (herdr-session-stats decision D5): a current session's is the total
// opencode keeps for it, which can be above the sum of its messages' costs; a legacy session's
// is that sum. A session with a Copilot call costs the sum of its calls, each Copilot call priced
// from the Copilot price table (D27).
function cost(session) {
  const priced = session.assistants.some((row) => row.providerId === COPILOT && isCall(row));
  const costUsd = session.loggedCost !== null && !priced ? session.loggedCost : callsCost(session);
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

// Context usage is the prompt of the latest turn that sent one; the maximum is the window of the
// session's model in opencode's catalogue, and the percentage needs both. opencode knows no
// compaction point to read, so the headroom is no figure of this provider.
function context({ turns, window }) {
  const sizes = turns.map(promptTokens).filter((size) => size > 0);
  const figures = window === null ? {} : { contextMax: window };
  if (!sizes.length) return figures;
  figures.contextTokens = sizes.at(-1);
  if (window !== null) figures.contextPercent = figures.contextTokens / window;
  return figures;
}

// Burn rate from the session's own duration, token figures and the costs of its model calls, as
// its cost chart adds them up.
const burn = (session) => burnRate({ ...duration(session), costUsd: callsCost(session), ...tokens(session) });

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

// The session's own model calls (see isCall). A sub-agent with none, which logs no cost until
// its first call, then spent nothing (card-view.ts `spentOf`).
const modelCalls = ({ assistants }) => ({ calls: assistants.filter(isCall).length });

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
  modelCalls,
];

// The series of the session: the prompt of each assistant message that sent one, a compaction
// summary's included, since each is a model call. Without its tool calls the session's series
// is not whole, and only `recent` is given.
function detail(session) {
  const { assistants, tools } = session;
  const recent = [];
  for (const size of assistants.map(promptTokens)) if (size > 0) pushRecent(recent, size);
  if (!tools) return detailOf({ recent });
  // opencode logs no cost of a call's cache writes, so the cold starts have no cost.
  const series = newSeries();
  const cold = { count: 0, tokens: 0, cost: null };
  const models = {};
  const minutes = [];
  let calls = 0;
  // the cost of the Copilot calls, priced from the Copilot price table
  let copilotUsd = 0;
  for (const row of assistants) {
    if (!isCall(row)) continue;
    const prompt = promptTokens(row);
    const call = {
      t: isNumber(row.completed) ? row.completed : row.created,
      read: tokenCount(row.cacheRead),
      write: tokenCount(row.cacheWrite),
      uncached: tokenCount(row.input),
      output: tokenCount(row.output),
      cost: costOf(row),
      context: prompt > 0 ? prompt : null,
    };
    addCall(series, call);
    if (row.providerId === COPILOT && isNumber(call.cost)) copilotUsd += call.cost;
    // A call counts in the minute it was made, by `created`, with its own cost: a current
    // session's minutes sum the costs of its calls, not the total opencode keeps for it (D18).
    addMinute(minutes, row.created, { ...call, tokens: tokenCount(messageTotal(row)) });
    // a cold start: a call after the first that read nothing from the prompt cache
    if (calls > 0 && row.cacheRead === 0) {
      cold.count += 1;
      cold.tokens += call.write;
    }
    calls += 1;
    if (typeof row.modelId === 'string' && row.modelId) {
      const key = typeof row.providerId === 'string' && row.providerId ? `${row.providerId}/${row.modelId}` : row.modelId;
      const byModel = entryOf(models, key, () => ({ cost: 0, tokens: 0 }));
      byModel.cost = addCost(byModel.cost, call.cost);
      byModel.tokens += tokenCount(messageTotal(row));
    }
  }
  const byTool = {};
  for (const { name, status } of tools) {
    if (typeof name !== 'string') continue;
    const tool = entryOf(byTool, name, () => ({ calls: 0, failed: 0 }));
    tool.calls += 1;
    if (status === 'error') tool.failed += 1;
  }
  // a compaction is a summary that did not end with an error; opencode logs no context before
  // or after it
  const marks = assistants.filter((row) => row.summary === 1 && row.error == null).map((row) => ({ t: row.created, before: null, after: null }));
  const range = span(session);
  return { ...detailOf({ recent, series, marks, cold, tools: byTool, models, minutes, firstEntry: range?.first, lastEntry: range?.last }), copilotUsd };
}

// `input` is `{ messages, compactions, tools, loggedCost, sources }`: `messages`, the session's
// message rows in order (`{ id, role, parentId, created, completed, modelId, providerId,
// variant, summary, cost, total, input, output, reasoning, cacheRead, cacheWrite, error }`, each
// a number, a string or null as the database holds it; `summary` is 1 on a compaction summary,
// `error` names the error a message ended with), `compactions`, the number of finished automatic
// compactions of the session or null when the database does not record them, `tools`, the
// session's tool calls in order (`{ name, status }`, `status` 'error' on one that failed), null
// when they could not be read, `loggedCost`, the session's total cost as opencode keeps it
// (current tables), null when it keeps none, and `sources.window`, the window opencode's model
// catalogue holds for the provider and model of the session's latest turn, null when unknown.
export const opencodeProvider = {
  readStats(input, now) {
    const session = parseSession(input ?? {});
    return Object.assign({}, ...FIGURES.map((figure) => figure(session, now)), { detail: detail(session) });
  },
};
