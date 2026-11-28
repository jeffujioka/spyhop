// The Trace lanes of a session: on one time axis, the spans (`[start, end]`, epoch ms, oldest
// first, none overlapping) of what it was doing, each lane with its total time. A lane draws at
// most TRACE_SPANS spans: past that, the two spans with the shortest gap between them are joined
// into one, from the first one's start to the second one's end, while its total stays the sum of
// its spans before they were joined: the lane keeps the gaps it joined (`gaps`, oldest first), so
// a span noted later in one of them adds its time there.

export const TRACE_SPANS = 240;

// The tools that start or await sub-agents, by provider id (src/core/providers/index.js): the
// main agent's time in them is no busy time, since its sub-agents do the work.
export const SUBAGENT_TOOLS = { omp: ['task', 'await'], 'claude-code': ['Task', 'Agent'], opencode: ['task', 'subagent'] };

export const newLane = () => ({ spans: [], totalMs: 0, gaps: [] });

// The index of the first of `gaps` that ends after `t`.
function gapAfter(gaps, t) {
  let [low, high] = [0, gaps.length];
  while (low < high) {
    const mid = (low + high) >> 1;
    if (gaps[mid][1] <= t) low = mid + 1;
    else high = mid;
  }
  return low;
}

// Adds the span from `start` to `end` to `lane`: merged with the spans it overlaps or touches, its
// time that no span covers yet added to the total. A span that does not run forward is none.
export function addSpan(lane, start, end) {
  if (!(Number.isFinite(start) && Number.isFinite(end) && end > start)) return;
  const { spans } = lane;
  // where it goes by its start, nearly always last
  let at = spans.length;
  while (at > 0 && spans[at - 1][0] > start) at -= 1;
  const from = at > 0 && spans[at - 1][1] >= start ? at - 1 : at;
  let to = at;
  while (to < spans.length && spans[to][0] <= end) to += 1;
  let [first, last, covered] = [start, end, 0];
  for (const [s, e] of spans.slice(from, to)) {
    covered += Math.max(0, Math.min(e, end) - Math.max(s, start));
    first = Math.min(first, s);
    last = Math.max(last, e);
  }
  // a joined gap it overlaps was covered by no span: its time counts, and it is a gap no more
  const { gaps } = lane;
  const inside = gapAfter(gaps, start);
  let past = inside;
  const kept = [];
  for (; past < gaps.length && gaps[past][0] < end; past += 1) {
    const [s, e] = gaps[past];
    covered -= Math.min(e, end) - Math.max(s, start);
    if (s < start) kept.push([s, start]);
    if (e > end) kept.push([end, e]);
  }
  gaps.splice(inside, past - inside, ...kept);
  lane.totalMs += end - start - covered;
  spans.splice(from, to - from, [first, last]);
  if (spans.length > TRACE_SPANS) {
    let shortest = 0;
    for (let i = 1; i < spans.length - 1; i += 1) if (spans[i + 1][0] - spans[i][1] < spans[shortest + 1][0] - spans[shortest][1]) shortest = i;
    const gap = [spans[shortest][1], spans[shortest + 1][0]];
    gaps.splice(gapAfter(gaps, gap[0]), 0, gap);
    spans.splice(shortest, 2, [spans[shortest][0], spans[shortest + 1][1]]);
  }
}

// Drops the gaps of `lane` that end by `horizon` (epoch ms), before which no span noted later
// starts: no later span can add their time, so the gaps a lane keeps stay as few as the spans
// still to come can reach.
export function pruneGaps(lane, horizon) {
  lane.gaps.splice(0, gapAfter(lane.gaps, horizon));
}

// The parts of `spans` that no span of `busy` covers, both oldest first.
export function minus(spans, busy) {
  const left = [];
  for (const [start, end] of spans) {
    let from = start;
    for (const [s, e] of busy) {
      if (s >= end) break;
      if (e <= from) continue;
      if (s > from) left.push([from, s]);
      from = e;
      if (from >= end) break;
    }
    if (from < end) left.push([from, end]);
  }
  return left;
}

// The Trace of a session (TraceView of src/protocol.ts, but its axis): of its `lanes` (`thinking`,
// `tools`, `busy` and `developer`, see newInsights of src/core/insights.js), all but `busy`, and
// `subagents`, the main agent's wait on its sub-agents: the spans of the sub-agents it started
// itself not covered by `busy`, joined to TRACE_SPANS. `agents`: its sub-agents, `{ key, parent,
// name, startMs, endMs, cost, running }` each, `parent` the key of the one that started it, null
// (or a key none has) for the main agent, a time or `cost` null when not known; each row under
// the agent that started it, in the order they started, with its status: `running` while it runs,
// else the one `statuses` (key -> status) holds, else n/a.
export function traceOf(lanes, agents, statuses) {
  const keys = new Set(agents.map(({ key }) => key));
  const parentOf = ({ parent }) => (parent !== null && keys.has(parent) ? parent : null);
  const started = newLane();
  for (const agent of agents) if (parentOf(agent) === null) addSpan(started, agent.startMs, agent.endMs);
  const waiting = newLane();
  for (const [start, end] of minus(started.spans, lanes.busy.spans)) addSpan(waiting, start, end);
  const rows = [];
  const seen = new Set();
  const under = (parent, depth) => {
    const children = agents.filter((agent) => parentOf(agent) === parent && !seen.has(agent.key)).sort((a, b) => (a.startMs ?? Infinity) - (b.startMs ?? Infinity));
    for (const { key, name, startMs, endMs, cost, running } of children) {
      seen.add(key);
      rows.push({ name, status: running ? 'running' : (statuses.get(key) ?? 'n/a'), cost: cost ?? 'n/a', startMs: startMs ?? 'n/a', endMs: endMs ?? 'n/a', depth });
      under(key, depth + 1);
    }
  };
  under(null, 0);
  const view = (lane, { totalMs, spans }) => ({ lane, totalMs, spans });
  return {
    lanes: [view('thinking', lanes.thinking), view('tools', lanes.tools), view('subagents', waiting), view('developer', lanes.developer)],
    agents: rows,
  };
}
