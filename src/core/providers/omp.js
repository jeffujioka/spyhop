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
// `detailOf(state)` gives the series of the whole file (src/core/series.js), from the same state,
// with the agent kind and the model a sub-agent's `session_init` entry records, and the times of
// the file's first and last entry, a sub-agent's start and end. Asked with `{ insights: true }`
// when the state starts, `fold` also notes each model call that logs its model in the state's
// daily lines (src/core/insights.js), as `models` counts only such calls, and the session's Trace
// lanes: a model call from its message's `timestamp` to its `completedAt`, a tool call from its
// `tool_execution_start` to its result, a turn's end at a reply that stops it and the developer's
// prompts, the user messages not attributed to an agent; and for the session's summary, the
// newest `title_change` and each status of a sub-agent (a background job of the type `task`,
// keyed by its id) its `async-result` entries deliver.

import { add, parseEntries, tally } from './jsonl.js';
import { burnRate, cacheRate, isNumber, tokenCount, wholeSession } from './shared.js';
import { addCall, addCost, addMinute, detailOf, entryOf, newSeries, pushRecent, toolAnswered, toolCalled } from '../series.js';
import { modelKey, newInsights, noteCall, noteCompaction, noteEntry, noteHorizon, notePrompt, noteStatus, noteToolEnd, noteToolStart, noteTurnEnd } from '../insights.js';
import { SUBAGENT_TOOLS } from '../trace.js';
import { callCost, COPILOT, copilotWriteCost } from '../copilot-prices.js';

// A fresh accumulator. Sums are `tally`s: undefined until an entry carries the value.
function emptyState(opts) {
  return {
    // timestamps (epoch ms, NaN when unreadable) of the first and the latest message entry
    firstMessage: undefined,
    lastMessage: undefined,
    // timestamps (epoch ms) of the first and the latest entry of any type that carries one: a
    // sub-agent's start and end
    firstEntry: undefined,
    lastEntry: undefined,
    totalTokens: tally(),
    costUsd: tally(),
    // the part of `costUsd` of the Copilot calls, priced from the Copilot price table
    copilotUsd: tally(),
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
    // cost and tokens by model, and the sums of the newest minutes (see `addMinute`)
    calls: 0,
    series: newSeries(),
    marks: [],
    cold: { count: 0, tokens: 0, cost: 0 },
    tools: {},
    pending: new Map(),
    // the cost and tokens by `<provider>/<model>`, each with whether the session's own model
    // calls (`main`) and its side calls (`side`) used it
    models: {},
    // the bounded series of the side calls, apart from the model calls', for the cost over time
    sides: newSeries(),
    minutes: [],
    // the `session` entry is the second line of a file, so a state that holds it starts at
    // the top of the file
    fromStart: false,
    // the agent kind and the model of a sub-agent's transcript, as its `session_init` entry
    // records them; null in a file without one, as the main agent's session file is
    kind: null,
    model: null,
    // the time of the `session` entry, which opens a session file: the session's start
    started: undefined,
    // the folder the `session` entry records, null without one
    cwd: null,
    // whether a Copilot call's model is not in the Copilot price table, so the cost is unknown
    unpriced: false,
    // the daily lines of the model calls and the Trace lanes (src/core/insights.js), when asked
    // for when the state starts; else null
    insights: opts?.insights ? newInsights() : null,
    // whether the newest entry that opens or ends a turn left it open: a `message` other than an
    // assistant message that stopped (`stopReason` `stop` or `aborted`), or a `custom_message`;
    // a `session_exit` ends it. Undefined before any such entry.
    turnOpen: undefined,
    // the time of the latest user message or tool result, which the next model call starts after
    asked: undefined,
  };
}

// The stop reasons of an assistant message that ends its turn: any other, such as a tool call's
// `toolUse`, leaves the turn open.
const TURN_ENDS = new Set(['stop', 'aborted']);

// Whether `usage` logs a token sent, read, written or output: a call omp aborted, or that failed
// before the model answered, logs a usage of all zeros (or none), so it sent and wrote nothing.
const spentTokens = (usage) => [usage?.input, usage?.cacheRead, usage?.cacheWrite, usage?.output].some((tokens) => tokenCount(tokens) > 0);

// The cost of the model call or side call `logged` (an assistant message or a `model_usage`
// entry), by the Copilot cost rule (`callCost`); undefined, nothing to add, when it logged no usage.
function costOf({ provider, model, usage }) {
  if (!usage) return undefined;
  const tokens = { uncached: tokenCount(usage.input), read: tokenCount(usage.cacheRead), write: tokenCount(usage.cacheWrite), output: tokenCount(usage.output) };
  return callCost(provider, model, tokens, usage.cost?.total);
}

// Adds the cost `spent` of a call of `logged` (see `costOf`) to the session's cost, and a Copilot
// call's to its Copilot part.
function addSpent(s, logged, spent) {
  add(s.costUsd, spent);
  if (logged.provider !== COPILOT) return;
  if (spent === null) s.unpriced = true;
  else add(s.copilotUsd, spent);
}

// Adds `call`, a model call or a side call (`side`) of `logged` that spent tokens and ended at
// `time`, to the minutes, and, when it logs its model, to the models and the daily lines; a model
// call that `ran` from `start` to `end` (epoch ms) runs then in the Trace lanes; `cache`: whether
// it was a cold start, the cost of its cache write (null: none logged) and the lifetime of the
// cache it wrote (null: none logged), for the Cache tab's figures.
function addSpend(s, logged, time, call, side, ran = { start: undefined, end: time }, cache = {}) {
  const tokens = tokenCount(logged.usage.totalTokens);
  addMinute(s.minutes, time, { ...call, tokens });
  const { provider, model } = logged;
  // a call that logs no model is in no model and no daily line: none is filed under a made-up one
  if (typeof model !== 'string') return;
  const key = modelKey(provider, model);
  const byModel = entryOf(s.models, key, () => ({ cost: 0, tokens: 0, main: false, side: false }));
  byModel.cost = addCost(byModel.cost, call.cost);
  byModel.tokens += tokens;
  byModel[side ? 'side' : 'main'] = true;
  if (s.insights && isNumber(ran.end)) noteCall(s.insights, { ...call, ...cache, thinking: s.thinkingLevel ?? null, start: ran.start, end: ran.end, model: key, tokens, side, copilot: provider === COPILOT });
}

// Adds `entries` (in file order, after those already in `state`) to `state`, which it changes
// and returns; without a `state` it starts a new one, with daily lines when `opts.insights`.
// Entries that carry no figure are skipped. `opts.autoAt(model)`, asked of each fold, not kept, gives
// the tokens at which omp compacts on its own with `model` (`<provider>/<id>`), undefined or null
// when unknown: a compaction's kind is inferred from it (noteCompaction).
function fold(state, entries, opts) {
  const s = state ?? emptyState(opts);
  for (const e of entries) {
    const at = Date.parse(e.timestamp);
    if (isNumber(at)) {
      s.firstEntry ??= at;
      s.lastEntry = at;
      if (s.insights) noteEntry(s.insights, at);
    }
    const ends = e.type === 'message' && e.message?.role === 'assistant' && TURN_ENDS.has(e.message.stopReason);
    if (e.type === 'message' && e.message) s.turnOpen = !ends;
    else if (e.type === 'custom_message') s.turnOpen = true;
    else if (e.type === 'session_exit') s.turnOpen = false;
    if (e.type === 'session') {
      s.fromStart = true;
      if (isNumber(at)) s.started = at;
      if (typeof e.cwd === 'string') s.cwd = e.cwd;
    } else if (e.type === 'session_init') {
      if (typeof e.agent === 'string') s.kind = e.agent;
      if (typeof e.resolvedModel === 'string') s.model = e.resolvedModel;
    } else if (e.type === 'custom' && e.customType === 'tool_execution_start') {
      if (s.insights) noteToolStart(s.insights, e.data?.toolCallId, Date.parse(e.data?.startedAt), e.data?.toolName);
    } else if (e.type === 'custom_message' && e.customType === 'async-result') {
      if (s.insights) for (const job of Array.isArray(e.details?.jobs) ? e.details.jobs : []) if (job?.type === 'task') noteStatus(s.insights, job.jobId, job.status);
    } else if (e.type === 'title_change') {
      if (s.insights && typeof e.title === 'string') s.insights.title = e.title;
    } else if (e.type === 'model_usage') {
      // a side call (a title, a recap, a prediction of the next prompt): in the session's cost
      // and tokens and its own series, but no model call of the series, the cold starts or the
      // cache figures
      const spent = costOf(e);
      add(s.totalTokens, e.usage?.totalTokens);
      addSpent(s, e, spent);
      if (spentTokens(e.usage)) {
        const call = { t: at, read: 0, write: 0, uncached: 0, output: tokenCount(e.usage.output), cost: spent, context: null };
        addCall(s.sides, call);
        addSpend(s, e, at, call, true);
      }
    } else if (e.type === 'message' && e.message) {
      const time = Date.parse(e.timestamp);
      s.firstMessage ??= time;
      s.lastMessage = time;
      if (e.message.role === 'user') {
        s.began = time;
        s.asked = time;
        if (s.insights && e.message.attribution !== 'agent') notePrompt(s.insights, time);
      } else if (e.message.role === 'assistant') {
        // the call ran from its message's `timestamp` to its `completedAt`, each else the entry's
        const { timestamp: started, completedAt } = e.message;
        const ran = { start: isNumber(started) ? started : time, end: isNumber(completedAt) ? completedAt : time };
        // the turn so far: this reply minus the user message before it (none: unknown)
        const ms = time - s.began;
        s.latencyMs = isNumber(ms) ? ms : undefined;
        const { usage } = e.message;
        const spent = costOf(e.message);
        add(s.totalTokens, usage?.totalTokens);
        addSpent(s, e.message, spent);
        add(s.premiumRequests, usage?.premiumRequests);
        add(s.input, usage?.input);
        add(s.cacheRead, usage?.cacheRead);
        add(s.cacheWrite, usage?.cacheWrite);
        if (isNumber(usage?.cacheRead)) {
          s.cacheReads += 1;
          if (usage.cacheRead > 0) s.cacheHits += 1;
        }
        // A call that spent no token is no model call of the series, of the cold starts or of
        // the spark line. One that logged usage counts, whatever its stop reason.
        if (spentTokens(usage)) {
          const prompt = e.message.contextSnapshot?.promptTokens;
          if (isNumber(prompt)) pushRecent(s.recent, prompt);
          const call = {
            t: time,
            read: tokenCount(usage.cacheRead),
            write: tokenCount(usage.cacheWrite),
            uncached: tokenCount(usage.input),
            output: tokenCount(usage.output),
            cost: spent,
            context: isNumber(prompt) ? prompt : null,
          };
          addCall(s.series, call);
          // a cold start: a call after the first that read nothing from the prompt cache, so it
          // wrote the prompt to the cache again
          const cold = s.calls > 0 && usage.cacheRead === 0;
          const written =
            e.message.provider === COPILOT
              ? copilotWriteCost(e.message.model, call.write, call.uncached + call.read + call.write)
              : isNumber(usage.cost?.cacheWrite) ? usage.cost.cacheWrite : null;
          if (cold) {
            s.cold.count += 1;
            s.cold.tokens += call.write;
            s.cold.cost = addCost(s.cold.cost, written);
          }
          s.calls += 1;
          addSpend(s, e.message, time, call, false, ran, { cold, writeCost: written, lifetimeMs: lifetimeOf(usage) });
        }
        for (const part of Array.isArray(e.message.content) ? e.message.content : []) {
          if (part?.type === 'toolCall') toolCalled(s, part.id, part.name);
        }
        if (s.insights && ends) noteTurnEnd(s.insights, ran.end);
      } else if (e.message.role === 'toolResult') {
        s.asked = time;
        if (s.insights) noteToolEnd(s.insights, e.message.toolCallId, time, SUBAGENT_TOOLS.omp);
        toolAnswered(s, e.message.toolCallId, e.message.isError === true);
      }
    } else if (e.type === 'compaction') {
      s.compactions += 1;
      const before = isNumber(e.tokensBefore) ? e.tokensBefore : null;
      s.marks.push({ t: Date.parse(e.timestamp), before, after: isNumber(e.tokensAfter) ? e.tokensAfter : null });
      if (s.insights) {
        // omp does not mark an automatic compaction: its kind is inferred, against the tokens at
        // which it compacts a call's model
        s.insights.autoAt = opts?.autoAt?.(s.insights.last['']?.model) ?? null;
        noteCompaction(s.insights, { t: at, kind: null, before });
      }
    } else if (e.type === 'thinking_level_change' && typeof e.thinkingLevel === 'string') {
      // the latest change stands
      s.thinkingLevel = e.thinkingLevel;
    }
    // no later call starts before the latest message it answers, nor a later tool call
    if (s.insights) noteHorizon(s.insights, s.asked);
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

// The cost omp logged (herdr-session-stats decision D5), but a Copilot call's from the Copilot
// price table (see `costOf`); n/a once a Copilot call's model is not in the table.
function cost({ costUsd, unpriced }) {
  return unpriced || costUsd.sum === undefined ? {} : { costUsd: costUsd.sum };
}

// A turn is a hit when its cacheRead is above 0 and a miss when it is 0 (herdr-session-stats
// decision D6); a turn that logged no cacheRead is neither.
function cacheTurns({ cacheReads, cacheHits }) {
  return cacheReads > 0 ? { cacheHits, cacheMisses: cacheReads - cacheHits } : {};
}

// The key of `usage.cttl` names the cache lifetime class; its value is a token count
// (herdr-session-stats docs/omp-session-format.md, decision D8 (d)).
const CACHE_LIFETIME_MS = { ephemeral5m: 5 * 60 * 1000, ephemeral1h: 60 * 60 * 1000 };

// The longest cache lifetime the `cttl` of `usage` names, null when it names none.
function lifetimeOf(usage) {
  const lifetimes = Object.keys(usage?.cttl ?? {})
    .map((key) => CACHE_LIFETIME_MS[key])
    .filter(isNumber);
  return lifetimes.length ? Math.max(...lifetimes) : null;
}

// Time left on the prompt cache after the last assistant turn, counted from the turn's
// completion; 0 once it has expired. Only that turn's own cttl counts.
function cacheExpiry({ assistants }, now) {
  const last = assistants.at(-1);
  const lifetime = lifetimeOf(last?.usage);
  const completedAt = isNumber(last?.completedAt)
    ? last.completedAt
    : last?.timestamp + last?.duration;
  if (lifetime === null || !isNumber(completedAt) || !isNumber(now)) return {};
  return { cacheLeftMs: Math.max(0, completedAt + lifetime - now) };
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
export function compactionTrigger(window, key, settings) {
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
      // the series, with the part of the cost of the Copilot calls
      { detail: total && whole ? { ...detailOf(total), copilotUsd: total.copilotUsd.sum ?? 0 } : null },
    );
  },
};

// The fold state of the whole file an `input` (see `ompProvider`) is of: its kept `state`, or
// its text folded when that is the whole file; null when neither is known.
function wholeState({ text, sources, state }) {
  if (state !== undefined) return state;
  return sources?.wholeFile === true ? fold(undefined, parseEntries(text)) : null;
}

// The start of the session of an omp session file read as `input`: the time of its `session`
// entry, from the kept state, or else from the first lines of a text that starts at the top of
// the file (the `session` entry is the first or second line); null when neither tells it.
export function sessionStart(input) {
  if (input.state) return input.state.started ?? null;
  return fold(undefined, parseEntries(input.text.split('\n', 2).join('\n'))).started ?? null;
}

// The turn of a sub-agent's transcript read as `input`: whether its newest entry that opens or
// ends a turn left it open (see `turnOpen` of the state), and the time of its newest entry;
// null when the whole transcript is not known.
export function turnOf(input) {
  const state = wholeState(input);
  return state && { open: state.turnOpen === true, last: isNumber(state.lastEntry) ? state.lastEntry : null };
}

// Whether the fold `state` of a file is that of an ended sub-agent: a transcript (it records a
// `session_init` kind) whose turn is not open.
export function endedSubAgent(state) {
  return typeof state?.kind === 'string' && state.turnOpen !== true;
}

