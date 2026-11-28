// The Trace of a session, as the session screen draws it with Trace pressed: its four Trace lanes
// on one time axis, from the session's first entry to its last, each titled, with what it means
// and its total time, the times of day under them; then the row of each sub-agent, nested under
// the agent that started it, in the order they started (`agentBars` with its status and its depth
// under the main agent).
// Pure: a Trace in, a markup string out.

import { formatLaneTime } from '../core/format.js';
import type { TraceView } from '../protocol.ts';
import { agentBars, laneChart, laneTimes } from './charts.ts';
import { num, titled } from './html.ts';

// Each lane's title and what it means.
const LANES: Record<TraceView['lanes'][number]['lane'], [string, string]> = {
  thinking: ['Thinking', "The main agent's model calls"],
  tools: ['Tools', "The main agent's tool calls"],
  subagents: ['Waiting on sub-agents', 'Its sub-agents run while it runs nothing but the calls that start or await them'],
  developer: ['Waiting on you', 'From a reply that ends a turn to your next prompt'],
};

export function traceScreen({ startMs, endMs, lanes, agents }: TraceView): string {
  const drawn = lanes.map(({ lane, totalMs, spans }) => {
    const [title, meaning] = LANES[lane];
    return `<div data-lane="${lane}">${titled(title, meaning, `${num('laneTime', formatLaneTime(totalMs))}${laneChart(lane, spans, startMs, endMs)}`)}</div>`;
  });
  const rows = agents.map(({ name, status, cost, startMs: start, endMs: end, depth }) => ({ name, kind: '', model: '', task: '', running: null, startMs: start, endMs: end, cost, status, depth: depth + 1 }));
  const subAgents =
    rows.length === 0
      ? ''
      : `<div data-part="trace-agents">${titled('Sub-agents', 'Each from its start to its end, under the agent that started it, with its status and cost', `<div class="agents">${agentBars(rows, new Map([['', 1]]), { status: true, depth: true })}</div>`)}</div>`;
  return `<div data-part="trace">${drawn.join('')}${laneTimes(startMs, endMs)}${subAgents}</div>`;
}
