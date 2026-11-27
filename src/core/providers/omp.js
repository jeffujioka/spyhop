// Copied from herdr-session-stats (src/providers/omp.js); the session formats are described in
// that repository's docs/.
//
// omp provider: reads the jsonl text of an omp session (herdr-session-stats
// docs/omp-session-format.md) and returns the stats of src/core/providers/index.js that it can
// read. A figure it cannot read is left out, which the registry turns into 'n/a'; nothing here
// estimates one.
//
// Pure: no Orca API, no file or database access, no runtime-specific API. `input` is the jsonl
// text of the session or `{ text, sources, state }` (see `ompProvider`).
//
// The figures are of two kinds. The session totals (tokens, cost, premium requests, duration,
// cache counts, burn rate, latency, thinking level, autocompactions) need the whole file, and a
// file can be larger than the tail window the plugin reads for the card: `fold(state, entries)`
// adds entries to an accumulator `state`, so a figure is the same whether the file is folded at
// once or in pieces (the caller reads a big file in chunks and keeps the state, see
// src/core/refresh.js), and each entry of `TOTALS` is a function `(state) => partial stats`. The
// figures about the end of the file (latest model, cache countdown, context, time since
// activity) come from the text, which is the tail: `parseTail` turns it into one `session`
// value and each entry of `LATEST` is a function `(session, now) => partial stats` (`now` is
// epoch ms; only a figure that measures from the present reads it). A later figure is one more
// function in a list, so adding a figure never rewrites an earlier one. Beside the stats,
// `detailOf(state)` gives the series of the whole file (src/core/series.js), from the same state.

import { add, parseEntries, tally } from './jsonl.js';
import { burnRate, cacheRate, isNumber, tokenCount, wholeSession } from './shared.js';
import { addCall, addCost, detailOf, entryOf, newSeries, pushRecent, toolAnswered, toolCalled } from '../series.js';

// A fresh accumulator. Sums are `tally`s: undefined until an entry carries the value.
function emptyState() {
  return {
    // timestamps (epoch ms, NaN when unreadable) of the first and the latest message entry
    firstMessage: undefined,
    lastMessage: undefined,
    totalTokens: tally(),
    costUsd: tally(),
    premiumRequests: tally(),
    input: tally(),
    cacheRead: tally(),
    cacheWrite: tally(),
    // assistant messages that logged a cacheRead, and those whose cacheRead was above 0
    cacheReads: 0,
    cacheHits: 0,
    thinkingLevel: undefined,
    // timestamp (epoch ms) of the latest user message, and the latency of the latest assistant
    // message: its timestamp minus that of the user message before it, undefined when unknown
    began: undefined,
    latencyMs: undefined,
    compactions: 0,
    // the context of the session's last model calls, oldest first (see `pushRecent`)
    recent: [],
    // the session's own model calls: how many, their bounded series (src/core/series.js), the
    // compactions with their tokens before and after, the cold starts (with the cost of their
    // cache writes), the tool calls by tool with the ids of those not answered yet, and the
    // cost and tokens by model
    calls: 0,
    series: newSeries(),
    marks: [],
    cold: { count: 0, tokens: 0, cost: 0 },
    tools: {},
    pending: new Map(),
    models: {},
    // the `session` entry is the second line of a file, so a state that holds it starts at
    // the top of the file
    fromStart: false,
  };
}

// Adds `entries` (in file order, after those already in `state`) to `state`, which it changes
// and returns; without a `state` it starts a new one. Entries that carry no figure are skipped.
function fold(state, entries) {
  const s = state ?? emptyState();
  for (const e of entries) {
    if (e.type === 'session') {
      s.fromStart = true;
    } else if (e.type === 'message' && e.message) {
      const time = Date.parse(e.timestamp);
      s.firstMessage ??= time;
      s.lastMessage = time;
      if (e.message.role === 'user') {
        s.began = time;
      } else if (e.message.role === 'assistant') {
        // the turn so far: this reply minus the user message before it (none: unknown)
        const ms = time - s.began;
        s.latencyMs = isNumber(ms) ? ms : undefined;
        const { usage } = e.message;
        add(s.totalTokens, usage?.totalTokens);
        add(s.costUsd, usage?.cost?.total);
        add(s.premiumRequests, usage?.premiumRequests);
        add(s.input, usage?.input);
        add(s.cacheRead, usage?.cacheRead);
        add(s.cacheWrite, usage?.cacheWrite);
        if (isNumber(usage?.cacheRead)) {
          s.cacheReads += 1;
          if (usage.cacheRead > 0) s.cacheHits += 1;
        }
        // A call omp aborted, or that failed before the model answered, logs a usage of all
        // zeros (or none): it sent and wrote nothing, so it is no model call of the series, of
        // the cold starts or of the spark line. One that logged usage counts, whatever its
        // stop reason.
        const kinds = [usage?.input, usage?.cacheRead, usage?.cacheWrite, usage?.output];
        if (kinds.some((tokens) => tokenCount(tokens) > 0)) {
          const prompt = e.message.contextSnapshot?.promptTokens;
          if (isNumber(prompt)) pushRecent(s.recent, prompt);
          const call = {
            t: time,
            read: tokenCount(usage.cacheRead),
            write: tokenCount(usage.cacheWrite),
            uncached: tokenCount(usage.input),
            output: tokenCount(usage.output),
            cost: isNumber(usage.cost?.total) ? usage.cost.total : null,
            context: isNumber(prompt) ? prompt : null,
          };
          addCall(s.series, call);
          // a cold start: a call after the first that read nothing from the prompt cache, so it
          // wrote the prompt to the cache again
          if (s.calls > 0 && usage.cacheRead === 0) {
            s.cold.count += 1;
            s.cold.tokens += call.write;
            s.cold.cost = addCost(s.cold.cost, isNumber(usage.cost?.cacheWrite) ? usage.cost.cacheWrite : null);
          }
          s.calls += 1;
          if (typeof e.message.model === 'string') {
            const byModel = entryOf(s.models, e.message.model, () => ({ cost: 0, tokens: 0 }));
            byModel.cost = addCost(byModel.cost, call.cost);
            byModel.tokens += tokenCount(usage.totalTokens);
          }
        }
        for (const part of Array.isArray(e.message.content) ? e.message.content : []) {
          if (part?.type === 'toolCall') toolCalled(s, part.id, part.name);
        }
      } else if (e.message.role === 'toolResult') {
        toolAnswered(s, e.message.toolCallId, e.message.isError === true);
      }
    } else if (e.type === 'compaction') {
      s.compactions += 1;
      s.marks.push({
        t: Date.parse(e.timestamp),
        before: isNumber(e.tokensBefore) ? e.tokensBefore : null,
        after: isNumber(e.tokensAfter) ? e.tokensAfter : null,
      });
    } else if (e.type === 'thinking_level_change' && typeof e.thinkingLevel === 'string') {
      // the latest change stands
      s.thinkingLevel = e.thinkingLevel;
    }
  }
  return s;
}

// The messages and the assistant messages of a text, for the figures about the end of the file.
function parseTail(entries) {
  const messages = entries.filter((e) => e.type === 'message' && e.message);
  const assistants = messages.filter((e) => e.message.role === 'assistant').map((e) => e.message);
  return { messages, assistants };
}

function model({ assistants }) {
  const latest = assistants.at(-1)?.model;
  return typeof latest === 'string' && latest ? { model: latest } : {};
}

// First to last message, by the entries' own ISO timestamps (present on every message entry).
function duration({ firstMessage, lastMessage }) {
  return isNumber(firstMessage) && isNumber(lastMessage) ? { durationMs: lastMessage - firstMessage } : {};
}

function tokens({ totalTokens }) {
  return totalTokens.sum === undefined ? {} : { totalTokens: totalTokens.sum };
}

// Cost the harness logged (herdr-session-stats decision D5); no price table.
function cost({ costUsd }) {
  return costUsd.sum === undefined ? {} : { costUsd: costUsd.sum };
}

// A turn is a hit when its cacheRead is above 0 and a miss when it is 0 (herdr-session-stats
// decision D6); a turn that logged no cacheRead is neither.
function cacheTurns({ cacheReads, cacheHits }) {
  return cacheReads > 0 ? { cacheHits, cacheMisses: cacheReads - cacheHits } : {};
}

// The key of `usage.cttl` names the cache lifetime class; its value is a token count
// (herdr-session-stats docs/omp-session-format.md, decision D8 (d)).
const CACHE_LIFETIME_MS = { ephemeral5m: 5 * 60 * 1000 };

// Time left on the prompt cache after the last assistant turn, counted from the turn's
// completion; 0 once it has expired. Only that turn's own cttl counts.
function cacheExpiry({ assistants }, now) {
  const last = assistants.at(-1);
  const lifetimes = Object.keys(last?.usage?.cttl ?? {})
    .map((key) => CACHE_LIFETIME_MS[key])
    .filter(isNumber);
  const completedAt = isNumber(last?.completedAt)
    ? last.completedAt
    : last?.timestamp + last?.duration;
  if (!lifetimes.length || !isNumber(completedAt) || !isNumber(now)) return {};
  return { cacheLeftMs: Math.max(0, completedAt + Math.max(...lifetimes) - now) };
}

// Compactions recorded in the session (herdr-session-stats docs/omp-session-format.md,
// decision D8 (a)): omp does not mark automatic ones, so this counts all `compaction` entries.
// Counting needs the whole file: the count of a state that holds only a tail window would be
// too low, so unless the state is the whole file's it reads n/a, never 0 (herdr-session-stats
// decision D4).
function autocompactions({ compactions }, whole) {
  return whole ? { autocompactions: compactions } : {};
}

// Window of the latest assistant message's model, from omp's model catalogue
// (herdr-session-stats decision D8 (b)).
function contextWindow(catalogue, { provider, model } = {}) {
  if (typeof provider !== 'string' || typeof model !== 'string' || !Array.isArray(catalogue)) return undefined;
  const window = catalogue.find((entry) => entry?.id === model)?.contextWindow;
  return isNumber(window) && window > 0 ? window : undefined;
}

// The default reserve and its 15% floor are omp's own rule: omp://compaction.md "Settings and
// defaults" (`compaction.reserveTokens`: "the effective reserve is `max(floor(contextWindow x
// 0.15), configuredReserve ?? 16384)`") and omp://settings.md (`compaction.thresholdTokens`,
// `thresholdPercent`, `modelThresholds`); the code of omp 18.20.2 agrees. On a 1M window the
// trigger is 850,000.
const DEFAULT_RESERVE = 16384;

// Trigger of the reserve-based default. Not evaluated (undefined) for a window whose 15% is
// under the default reserve, where omp's doc only says the budget "uses the proportional
// reserve when the unset default is impractical on a small window" (omp://compaction.md),
// without saying where that starts; nor for a reserve that reaches the whole window.
function reserveTrigger(window, configured) {
  const floor = Math.floor(window * 0.15);
  const explicit = isNumber(configured);
  if (!explicit && floor < DEFAULT_RESERVE) return undefined;
  const reserve = Math.max(floor, explicit ? configured : DEFAULT_RESERVE);
  return reserve < window ? window - reserve : undefined;
}

// A `modelThresholds` key is `provider/model-id` or a `*`-terminated prefix of it.
function hasModelThreshold(modelThresholds, key) {
  if (!modelThresholds || typeof modelThresholds !== 'object') return false;
  return Object.keys(modelThresholds).some((pattern) =>
    pattern.endsWith('*') ? key.startsWith(pattern.slice(0, -1)) : pattern === key,
  );
}

// Tokens at which omp autocompacts, from the `compaction` block of its config; undefined when
// it cannot be known: config unreadable, autocompaction off, or a per-model entry for this
// model, whose scaling the plugin does not evaluate. Project-level config files
// are not read, so a setting made only there is not seen.
function compactionTrigger(window, key, settings) {
  if (!settings || settings.enabled === false) return undefined;
  if (settings.modelThresholdsEnabled !== false && hasModelThreshold(settings.modelThresholds, key)) {
    return undefined;
  }
  const { thresholdTokens, thresholdPercent, reserveTokens } = settings;
  // a fixed trigger at or past the window compacts like the default
  if (isNumber(thresholdTokens) && thresholdTokens > 0 && thresholdTokens < window) return thresholdTokens;
  if (!(isNumber(thresholdTokens) && thresholdTokens > 0) && isNumber(thresholdPercent) && thresholdPercent > 0) {
    return Math.floor((window * Math.min(99, Math.max(1, thresholdPercent))) / 100);
  }
  return reserveTrigger(window, reserveTokens);
}

// Context usage is the latest prompt size the harness logged (`contextSnapshot.promptTokens`);
// the window, the percentage and the headroom need the model's window, and the headroom also
// the trigger. Each is left out when its input is unknown.
function context({ assistants, sources }) {
  const figures = {};
  const used = assistants.map((m) => m.contextSnapshot?.promptTokens).filter(isNumber).at(-1);
  if (used !== undefined) figures.contextTokens = used;
  const window = contextWindow(sources.catalogue, assistants.at(-1));
  if (window === undefined) return figures;
  figures.contextMax = window;
  if (used === undefined) return figures;
  figures.contextPercent = used / window;
  const { provider, model } = assistants.at(-1);
  const trigger = compactionTrigger(window, `${provider}/${model}`, sources.compaction);
  if (trigger !== undefined) figures.headroomTokens = Math.max(0, trigger - used);
  return figures;
}

// Burn rate from the session's own duration, cost and token figures.
const burn = (state) => burnRate({ ...duration(state), ...cost(state), ...tokens(state) });

// Time since the last message entry, by its ISO timestamp, like the duration.
function sinceActivity({ messages }, now) {
  const last = Date.parse(messages.at(-1)?.timestamp);
  return isNumber(last) && isNumber(now) ? { sinceActivityMs: now - last } : {};
}

// Last turn: the last assistant message minus the user message that began its turn (the
// nearest user message before it), both by their entries' ISO timestamps. Kept by `fold`, so a
// turn whose user message lies before the tail window still has its latency.
function latency({ latencyMs }) {
  return isNumber(latencyMs) ? { latencyMs } : {};
}

function thinking({ thinkingLevel }) {
  return thinkingLevel ? { thinkingLevel } : {};
}

function premium({ premiumRequests }) {
  return premiumRequests.sum === undefined ? {} : { premiumRequests: premiumRequests.sum };
}

const TOTALS = [duration, tokens, cost, cacheRate, cacheTurns, burn, latency, thinking, premium];
const LATEST = [model, cacheExpiry, context, sinceActivity];

// `input` is the jsonl text, or `{ text, sources, state }`:
//   - `text` is the file's text, or its tail window when the file is larger;
//   - `state` is the accumulator of `fold` over the whole file, which the caller keeps for a
//     file larger than the tail window; `null` when it could not be built, so the session
//     totals read n/a. Without one, the text is folded, and counts as the whole file when it
//     starts at the top of the file (it holds the `session` entry) or `sources.wholeFile` is
//     true;
//   - `sources` holds what the caller read besides the text, already read (the plugin reads
//     them asynchronously): `catalogue`, the model entries (`{ id, contextWindow }`) of the
//     session's provider from omp's newest catalogue row; `compaction`, the `compaction`
//     block of omp's config (`{}` when it has none); and `wholeFile`, true when the text is
//     the whole file. A source that could not be read is null or absent.
export const ompProvider = {
  fold,

  readStats(input, now) {
    const { text, sources, state } = typeof input === 'string' ? { text: input } : input;
    const entries = parseEntries(text);
    const tail = { ...parseTail(entries), sources: sources ?? {} };
    const total = state === undefined ? fold(undefined, entries) : state;
    const whole = state !== undefined || total.fromStart || sources?.wholeFile === true;
    return Object.assign(
      {},
      ...(total ? TOTALS.map((figure) => figure(total)) : []),
      ...(total ? [autocompactions(total, whole), wholeSession(total, whole)] : []),
      ...LATEST.map((figure) => figure(tail, now)),
      { detail: total && whole ? detailOf(total) : null },
    );
  },
};

