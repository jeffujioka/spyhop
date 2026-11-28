// Copied from herdr-session-stats (src/providers/claude.js); the session formats are described
// in that repository's docs/.
//
// Claude Code provider: reads the jsonl text of a Claude Code session (herdr-session-stats
// docs/claude-session-format.md) and returns the stats of src/core/providers/index.js that it
// can read. A figure it cannot read is left out, which the registry turns into 'n/a'; nothing
// here estimates one, and there is no price table.
//
// Pure: no Orca API, no file access, no runtime-specific API. `input` is the jsonl text of the
// session or `{ text, sources, state }` (see `claudeProvider`).
//
// Structure as in omp.js: the session totals come from an accumulator,
// `fold(state, entries, opts)`, that the caller can build in pieces over a file larger than the
// tail window; each entry of `TOTALS` is a function `(state) => partial stats`. The figures about
// the end of the file come from the text (the tail), which `parseTail` turns into one `session`
// value; each entry of `LATEST` is a function `(session, now) => partial stats`. Beside the
// stats, `detailOf(state)` gives the series of the whole file (src/core/series.js), from the same
// state. Asked with `{ insights: true }` when the state starts, `fold` also notes in the state's
// daily lines (src/core/insights.js) each response that logs its model, at no cost, and what each
// `cost-state` adds to each model's cost (see `noteCostState`), and the session's Trace lanes: a
// response from the prompt or the tool result it answers to its last block, a tool use from its
// block to its result, a turn's end at a block that stops for no tool use, and the prompts.

import { add, parseEntries, tally } from './jsonl.js';
import { burnRate, cacheRate, isNumber, tokenCount, wholeSession } from './shared.js';
import { addCall, addMinute, detailOf, entryOf, newSeries, pushRecent, retractLastCall, toolAnswered, toolCalled } from '../series.js';
import { newInsights, noteCall, noteCost, notePrompt, noteToolEnd, noteToolStart, noteTurnEnd } from '../insights.js';
import { SUBAGENT_TOOLS } from '../trace.js';
import { absoluteFolder } from './session-files.js';

// A user entry that carries a tool's result continues a turn; any other (not meta) one starts it.
const isPrompt = ({ message, isMeta }) =>
  !isMeta && (typeof message.content === 'string' || (Array.isArray(message.content) && !message.content.some((part) => part?.type === 'tool_result')));

// What Claude Code writes in place of an API reply it never got (an error, an interruption);
// its usage is all zeros and it is no turn.
const SYNTHETIC_MODEL = '<synthetic>';

const inputTokens = (m) => m.usage?.input_tokens;
const outputTokens = (m) => m.usage?.output_tokens;
const cacheRead = (m) => m.usage?.cache_read_input_tokens;
const cacheWrite = (m) => m.usage?.cache_creation_input_tokens;

// A response's four token counts added; one that lacks a count has no total.
function responseTokens(m) {
  const counts = [inputTokens(m), outputTokens(m), cacheRead(m), cacheWrite(m)];
  return counts.every(isNumber) ? counts.reduce((a, b) => a + b, 0) : undefined;
}

// A fresh accumulator, with daily lines when `opts.insights`.
function emptyState(opts) {
  return {
    // timestamps (epoch ms) of the first and the latest user or assistant entry
    firstMessage: undefined,
    lastMessage: undefined,
    // timestamps (epoch ms) of the first and the latest entry of any type that carries one: a
    // sub-agent's start and end
    firstEntry: undefined,
    lastEntry: undefined,
    // timestamp (epoch ms) of the latest prompt, and the latency of the latest reply: its
    // timestamp minus that of the prompt before it, undefined when unknown
    began: undefined,
    latencyMs: undefined,
    // API responses, once each: Claude Code writes a response as one entry per content block,
    // every one with the response's `message.id` and the same usage. A later entry replaces the
    // earlier, so `responses` keeps what each id added to the tallies, to take it back.
    responses: new Map(),
    totalTokens: tally(),
    input: tally(),
    cacheRead: tally(),
    cacheWrite: tally(),
    // responses that logged a cache read, and those whose cache read was above 0
    cacheReads: tally(),
    cacheHits: tally(),
    // the latest `cost-state` entry: { usd, stale, models }, stale once a response came after it;
    // `models` the cost, USD, by model of the latest one that gives it, its sub-agents' included
    logged: undefined,
    // the cost, USD, by model of the latest `cost-state` whose cost the daily lines noted (see
    // `noteCostState`)
    noted: undefined,
    compactions: 0,
    // a `compact_boundary` whose trigger is neither `manual` nor `auto` was seen: it may be an
    // automatic compaction under a name this reader does not know, so the count is unknown
    unknownTrigger: false,
    // the context of the session's last responses, oldest first (see `pushRecent`), and the
    // `message.id` of the newest one, whose later blocks replace its context instead of adding one
    recent: [],
    recentId: undefined,
    // the session's own responses: how many, their bounded series (src/core/series.js), the
    // compact boundaries with their tokens before and after, the cold starts, the tool uses by
    // tool with the ids of those not answered yet, the tokens by model and the sums of the newest
    // minutes (see `addMinute`). Claude Code logs no cost of a response, so no cost is kept.
    // `last` is what the newest response added, to take it back when a later block of the
    // response replaces it.
    calls: 0,
    series: newSeries(),
    marks: [],
    cold: { count: 0, tokens: 0, cost: null },
    tools: {},
    pending: new Map(),
    models: {},
    minutes: [],
    last: undefined,
    // the time of the latest prompt or tool result, which the next response answers and starts at
    sent: undefined,
    // the folder of the first entry that records an absolute one (see `absoluteFolder`), null
    // before one
    cwd: null,
    // the daily lines (src/core/insights.js), when asked for when the state starts; else null
    insights: opts?.insights ? newInsights() : null,
  };
}

// What a response adds to the tallies: the values of its message that are numbers.
function contribution(message) {
  const read = cacheRead(message);
  return {
    totalTokens: responseTokens(message),
    input: inputTokens(message),
    cacheRead: read,
    cacheWrite: cacheWrite(message),
    cacheReads: isNumber(read) ? 1 : undefined,
    cacheHits: isNumber(read) ? (read > 0 ? 1 : 0) : undefined,
  };
}

function credit(state, parts, sign) {
  for (const [key, value] of Object.entries(parts)) add(state[key], value, sign);
}

// The daily lines' name of the Claude model `name`: a transcript logs a model's id, which may end
// in a date (`claude-haiku-4-5-20251001`), and a `cost-state` keys it with a provider before it
// (`anthropic.`) or a context size after it (`[1m]`); each is dropped, so one model is one line.
const lineModel = (name) =>
  name
    .replace(/^anthropic\./, '')
    .replace(/\[[^\]]*\]$/, '')
    .replace(/-\d{8}$/, '');

// Counts the response `last` (`{ id, call, cold, model, tokens, start }`) in the calls, the
// series, the minutes, the cold starts, the tokens by model and, when it logs its model, the
// daily lines, at no cost, and the Trace lanes from `start`; `sign` -1 takes it back out, which
// only the newest one can.
function count(state, last, sign) {
  if (sign > 0) addCall(state.series, last.call);
  else retractLastCall(state.series, last.call);
  addMinute(state.minutes, last.call.t, { ...last.call, tokens: last.tokens }, sign);
  state.calls += sign;
  if (last.cold) {
    state.cold.count += sign;
    state.cold.tokens += sign * last.call.write;
  }
  if (last.model !== null) entryOf(state.models, last.model, () => ({ cost: null, tokens: 0 })).tokens += sign * last.tokens;
  if (state.insights && last.model !== null) noteCall(state.insights, { ...last.call, start: last.start, end: last.call.t, model: lineModel(last.model), tokens: last.tokens, cost: 0 }, sign);
}

// Notes in the daily lines what the `cost-state` that gives `models` (see `costByModel`) adds to
// each model's cost: its cost less that of the previous `cost-state` the daily lines noted (0
// without one). A cost below the one before starts the session's cost again (a restart), so the
// `cost-state`'s costs are noted whole and no day is negative. A `cost-state` has no timestamp, so
// it counts on the day of the entry before it; one before any dated entry notes nothing, and the
// next one that does notes its cost.
function noteCostState(s, models) {
  if (!s.insights || !isNumber(s.lastEntry)) return;
  const before = s.noted ?? {};
  const restart = Object.entries(models).some(([model, usd]) => usd < (before[model] ?? 0));
  for (const [model, usd] of Object.entries(models)) noteCost(s.insights, s.lastEntry, lineModel(model), restart ? usd : usd - (before[model] ?? 0));
  s.noted = models;
}

// Adds `entries` (in file order, after those already in `state`) to `state`, which it changes
// and returns; without a `state` it starts a new one, with daily lines when `opts.insights`.
function fold(state, entries, opts) {
  const s = state ?? emptyState(opts);
  for (const entry of entries) {
    const { message } = entry;
    s.cwd ??= absoluteFolder(entry.cwd);
    const time = Date.parse(entry.timestamp);
    if (isNumber(time)) {
      s.firstEntry ??= time;
      s.lastEntry = time;
    }
    if ((entry.type === 'user' || entry.type === 'assistant') && message && typeof message === 'object' && isNumber(time)) {
      s.firstMessage ??= time;
      s.lastMessage = time;
      if (entry.type === 'user' && !entry.isMeta) {
        // a prompt or a tool result, which the next response answers
        s.sent = time;
        if (isPrompt(entry)) {
          s.began = time;
          if (s.insights) notePrompt(s.insights, time);
        }
      }
      if (entry.type === 'assistant' && message.model !== SYNTHETIC_MODEL) {
        // the turn so far: this reply minus the prompt before it (none: unknown)
        s.latencyMs = isNumber(s.began) ? time - s.began : undefined;
        const parts = contribution(message);
        const id = typeof message.id === 'string' ? message.id : undefined;
        const earlier = id === undefined ? undefined : s.responses.get(id);
        if (earlier) credit(s, earlier, -1);
        if (id !== undefined) s.responses.set(id, parts);
        credit(s, parts, 1);
        const prompt = promptTokens(message);
        if (prompt !== undefined) {
          if (id !== undefined && id === s.recentId) s.recent[s.recent.length - 1] = prompt;
          else pushRecent(s.recent, prompt);
          s.recentId = id;
        }
        // A later block of the newest response replaces it in the series, as in the tallies. A
        // block of an older one, written again after other responses, cannot be taken out of a
        // point merged since; its response is in the series already, so it adds nothing there.
        const newest = id !== undefined && id === s.last?.id;
        // a response starts at what it answers; its later blocks keep its start
        const start = newest ? s.last.start : (s.sent ?? time);
        if (newest) count(s, s.last, -1);
        if (newest || !earlier) {
          const call = {
            t: time,
            read: tokenCount(cacheRead(message)),
            write: tokenCount(cacheWrite(message)),
            uncached: tokenCount(inputTokens(message)),
            output: tokenCount(outputTokens(message)),
            cost: null,
            context: prompt ?? null,
          };
          // a cold start: a response after the first that read nothing from the prompt cache
          const cold = s.calls > 0 && cacheRead(message) === 0;
          const model = typeof message.model === 'string' ? message.model : null;
          s.last = { id, call, cold, model, tokens: tokenCount(responseTokens(message)), start };
          count(s, s.last, 1);
        }
        for (const part of Array.isArray(message.content) ? message.content : []) {
          if (part?.type === 'tool_use') {
            toolCalled(s, part.id, part.name);
            if (s.insights) noteToolStart(s.insights, part.id, time, part.name);
          }
        }
        if (s.insights && typeof message.stop_reason === 'string' && message.stop_reason !== 'tool_use') noteTurnEnd(s.insights, time);
        if (s.logged) s.logged.stale = true;
      }
      if (entry.type === 'user' && Array.isArray(message.content)) {
        for (const part of message.content) {
          if (part?.type !== 'tool_result') continue;
          if (s.insights) noteToolEnd(s.insights, part.tool_use_id, time, SUBAGENT_TOOLS['claude-code']);
          toolAnswered(s, part.tool_use_id, part.is_error === true);
        }
      }
    } else if (entry.type === 'cost-state') {
      const models = costByModel(entry.modelUsage);
      if (models) noteCostState(s, models);
      s.logged = { usd: entry.totalCostUSD, stale: false, models: models ?? s.logged?.models };
    } else if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
      const { trigger, preTokens, postTokens } = entry.compactMetadata ?? {};
      if (trigger === 'auto') s.compactions += 1;
      else if (trigger !== 'manual') s.unknownTrigger = true;
      s.marks.push({ t: time, before: isNumber(preTokens) ? preTokens : null, after: isNumber(postTokens) ? postTokens : null });
    }
  }
  return s;
}

// The messages and the API responses of a text, for the figures about the end of the file.
function parseTail(entries) {
  // user and assistant entries, with the entry's own ISO timestamp as epoch ms
  const messages = [];
  // responses once each, dated by their last block
  const assistants = [];
  const slots = new Map();
  for (const entry of entries) {
    const { message } = entry;
    const time = Date.parse(entry.timestamp);
    if ((entry.type === 'user' || entry.type === 'assistant') && message && typeof message === 'object' && isNumber(time)) {
      const synthetic = entry.type === 'assistant' && message.model === SYNTHETIC_MODEL;
      messages.push({ role: entry.type, time, prompt: entry.type === 'user' && isPrompt(entry), synthetic });
      if (entry.type === 'assistant' && !synthetic) {
        const response = { message, time };
        const slot = typeof message.id === 'string' ? slots.get(message.id) : undefined;
        if (slot === undefined) {
          if (typeof message.id === 'string') slots.set(message.id, assistants.length);
          assistants.push(response);
        } else {
          assistants[slot] = response;
        }
      }
    }
  }
  return { messages, assistants };
}

function model({ assistants }) {
  const latest = assistants.at(-1)?.message.model;
  return typeof latest === 'string' && latest ? { model: latest } : {};
}

// First to last message, by the entries' own ISO timestamps.
function duration({ firstMessage, lastMessage }) {
  return isNumber(firstMessage) ? { durationMs: lastMessage - firstMessage } : {};
}

function tokens({ totalTokens }) {
  return totalTokens.sum === undefined ? {} : { totalTokens: totalTokens.sum };
}

// A response is a hit when its cache read is above 0 and a miss when it is 0
// (herdr-session-stats decision D6); one that logged no cache read is neither.
// (`cacheHits` is a tally that gets a 0 or a 1 for every response that `cacheReads` counts.)
function cacheTurns({ cacheReads, cacheHits }) {
  return cacheReads.sum === undefined ? {} : { cacheHits: cacheHits.sum, cacheMisses: cacheReads.sum - cacheHits.sum };
}

// `usage.cache_creation` splits the tokens written to the cache by lifetime class.
const CACHE_LIFETIME_MS = {
  ephemeral_5m_input_tokens: 5 * 60 * 1000,
  ephemeral_1h_input_tokens: 60 * 60 * 1000,
};

// Time left on the prompt cache after the last response, counted from its last block; 0 once
// it has expired. The class is the one the response wrote tokens under; a response that wrote
// none, or logged no split, leaves it unknown.
function cacheExpiry({ assistants }, now) {
  const last = assistants.at(-1);
  const written = last?.message.usage?.cache_creation ?? {};
  const lifetimes = Object.keys(CACHE_LIFETIME_MS)
    .filter((key) => written[key] > 0)
    .map((key) => CACHE_LIFETIME_MS[key]);
  if (!lifetimes.length || !isNumber(now)) return {};
  return { cacheLeftMs: Math.max(0, last.time + Math.max(...lifetimes) - now) };
}

// Compactions Claude Code itself started: `compact_boundary` entries whose
// `compactMetadata.trigger` is `auto`. Counting needs the whole file: the count of a state that
// holds only a tail window would be too low, so unless the state is the whole file's it is
// unknown, never 0. It is also unknown when a boundary names a trigger other than `manual` and
// `auto`, which could be an automatic one.
function autocompactions({ compactions, unknownTrigger }, whole) {
  return whole && !unknownTrigger ? { autocompactions: compactions } : {};
}

// The prompt of a response: input plus the cache it read and wrote; undefined unless it logged
// all three.
function promptTokens(m) {
  const counts = [inputTokens(m), cacheRead(m), cacheWrite(m)];
  return counts.every(isNumber) ? counts.reduce((a, b) => a + b, 0) : undefined;
}

// Context usage is the prompt of the latest response. The files hold no window for the model, so
// there is no maximum, percentage or headroom.
function context({ assistants }) {
  const m = assistants.at(-1)?.message;
  const used = m && promptTokens(m);
  return used === undefined ? {} : { contextTokens: used };
}

// Cost is the session total Claude Code logs in a `cost-state` entry (herdr-session-stats
// decision D5), which it writes when a session is saved, not per turn. A response after the
// last such entry is not in it, so the total is stale and is not shown.
function cost({ logged }) {
  return logged && !logged.stale && isNumber(logged.usd) ? { costUsd: logged.usd } : {};
}

// The cost, USD, a `cost-state`'s `modelUsage` gives each model (`modelUsage[model].costUSD`,
// where it is a number); undefined when it gives none. A fold replaces it whole, never changes it,
// so the `detail` of `readStats` holds it as it is.
function costByModel(modelUsage) {
  if (!modelUsage || typeof modelUsage !== 'object') return undefined;
  const costs = Object.entries(modelUsage).flatMap(([model, usage]) => (isNumber(usage?.costUSD) ? [[model, usage.costUSD]] : []));
  return costs.length > 0 ? Object.fromEntries(costs) : undefined;
}

// Token burn from the session's own duration and token figures. A cost per hour would divide
// a total logged at save time by the time read here, so there is none.
const burn = (state) => burnRate({ ...duration(state), ...tokens(state) });

// Time since the last message entry, by its ISO timestamp, like the duration.
function sinceActivity({ messages }, now) {
  return messages.length && isNumber(now) ? { sinceActivityMs: now - messages.at(-1).time } : {};
}

// Last turn: the last reply of the API (a placeholder written for a reply it never made is
// none) minus the prompt that began its turn (the nearest prompt before it; the tool results
// in between do not begin one). Kept by `fold`, so a turn whose prompt lies before the tail
// window still has its latency.
function latency({ latencyMs }) {
  return isNumber(latencyMs) ? { latencyMs } : {};
}

const TOTALS = [duration, tokens, cacheRate, cacheTurns, cost, burn, latency];
const LATEST = [model, cacheExpiry, context, sinceActivity];

// `input` is the jsonl text, or `{ text, sources, state }`:
//   - `text` is the file's text, or its tail window when the file is larger;
//   - `state` is the accumulator of `fold` over the whole file, which the caller keeps for a
//     file larger than the tail window; `null` when it could not be built, so the session
//     totals read n/a. Without one, the text is folded, and counts as the whole file only when
//     `sources.wholeFile` is true (a Claude Code file has no header to tell it by);
//   - `sources.wholeFile`: true when the text is the whole file and not a tail window. A source
//     that is absent reads as unknown.
export const claudeProvider = {
  fold,

  readStats(input, now) {
    const { text, sources, state } = typeof input === 'string' ? { text: input } : input;
    const entries = parseEntries(text);
    const tail = parseTail(entries);
    const total = state === undefined ? fold(undefined, entries) : state;
    const whole = state !== undefined || sources?.wholeFile === true;
    return Object.assign(
      {},
      ...(total ? TOTALS.map((figure) => figure(total)) : []),
      ...(total ? [autocompactions(total, whole), wholeSession(total, whole)] : []),
      ...LATEST.map((figure) => figure(tail, now)),
      { detail: total && whole ? { ...detailOf(total), costs: total.logged?.models ?? null } : null },
    );
  },
};
