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
// Structure as in omp.js: the session totals come from an accumulator, `fold(state, entries)`,
// that the caller can build in pieces over a file larger than the tail window; each entry of
// `TOTALS` is a function `(state) => partial stats`. The figures about the end of the file come
// from the text (the tail), which `parseTail` turns into one `session` value; each entry of
// `LATEST` is a function `(session, now) => partial stats`. Beside the stats, `detailOf(state)`
// gives the series of the whole file (src/core/series.js), from the same state.

import { add, parseEntries, tally } from './jsonl.js';
import { burnRate, cacheRate, isNumber } from './shared.js';
import { detailOf, pushRecent } from '../series.js';

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

// A fresh accumulator.
function emptyState() {
  return {
    // timestamps (epoch ms) of the first and the latest user or assistant entry
    firstMessage: undefined,
    lastMessage: undefined,
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
    // the latest `cost-state` entry: { usd, stale }, stale once a response came after it
    logged: undefined,
    compactions: 0,
    // a `compact_boundary` whose trigger is neither `manual` nor `auto` was seen: it may be an
    // automatic compaction under a name this reader does not know, so the count is unknown
    unknownTrigger: false,
    // the context of the session's last responses, oldest first (see `pushRecent`), and the
    // `message.id` of the newest one, whose later blocks replace its context instead of adding one
    recent: [],
    recentId: undefined,
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

// Adds `entries` (in file order, after those already in `state`) to `state`, which it changes
// and returns; without a `state` it starts a new one.
function fold(state, entries) {
  const s = state ?? emptyState();
  for (const entry of entries) {
    const { message } = entry;
    const time = Date.parse(entry.timestamp);
    if ((entry.type === 'user' || entry.type === 'assistant') && message && typeof message === 'object' && isNumber(time)) {
      s.firstMessage ??= time;
      s.lastMessage = time;
      if (entry.type === 'user' && isPrompt(entry)) s.began = time;
      if (entry.type === 'assistant' && message.model !== SYNTHETIC_MODEL) {
        // the turn so far: this reply minus the prompt before it (none: unknown)
        s.latencyMs = isNumber(s.began) ? time - s.began : undefined;
        const parts = contribution(message);
        if (typeof message.id === 'string') {
          const earlier = s.responses.get(message.id);
          if (earlier) credit(s, earlier, -1);
          s.responses.set(message.id, parts);
        }
        credit(s, parts, 1);
        const prompt = promptTokens(message);
        if (prompt !== undefined) {
          if (typeof message.id === 'string' && message.id === s.recentId) s.recent[s.recent.length - 1] = prompt;
          else pushRecent(s.recent, prompt);
          s.recentId = message.id;
        }
        if (s.logged) s.logged.stale = true;
      }
    } else if (entry.type === 'cost-state') {
      s.logged = { usd: entry.totalCostUSD, stale: false };
    } else if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
      const trigger = entry.compactMetadata?.trigger;
      if (trigger === 'auto') s.compactions += 1;
      else if (trigger !== 'manual') s.unknownTrigger = true;
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
      ...(total ? [autocompactions(total, whole)] : []),
      ...LATEST.map((figure) => figure(tail, now)),
      { detail: total && whole ? detailOf(total) : null },
    );
  },
};
