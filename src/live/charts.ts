// The charts of the live panel, as markup: on the fleet screen, the burn rate of the last hour
// stacked by session; on a card, the spark line of a session's recent contexts and the bar of its
// context; on the session screen, the context over the whole session,
// the tokens of each model call, the cost, and the bars of its sub-agents on one time axis. A
// chart is an SVG as wide as its box (`width="100%"` over a `viewBox` 360 wide, stretched with
// `preserveAspectRatio="none"`) with no text of its own: its headline, times, labels and notes are
// HTML around it. Its colours come from the stylesheet (src/live/style.ts), by its classes and
// attributes. Each of the four charts of the burn rate, context, tokens and cost has a round
// scale (`scaleOf`), its faint lines in the SVG and their values laid over it in its plot, and
// times of day under it (`clockMarks`, `timesRow`). A session chart groups neighbouring model
// calls to the room it has (`groupPoints`), and is not drawn without a point.
// Pure: no DOM.

import { formatClock, formatCost, formatCostPerHour, formatPercent, formatTokens, orNa } from '../core/format.js';
import { groupPoints, MINUTE_MS } from '../core/series.js';
import { BURN_NAMED } from '../fleet.ts';
import type { BurnCard, Num, Point, SessionView, SubAgentView } from '../protocol.ts';
import { esc, num } from './html.ts';
import { levelOf } from './levels.ts';

// Width of every chart's viewBox, and the heights of the spark line's and the session charts'.
const WIDTH = 360;
const SPARK_HEIGHT = 40;
const CONTEXT_HEIGHT = 120;
const TOKENS_HEIGHT = 120;
const COST_HEIGHT = 100;
const BURN_HEIGHT = 80;
const AGENT_HEIGHT = 10;
// Room of a session chart, in bars or points, unless its caller gives another.
const ROOM = 120;
// Space kept inside a session chart's edges, so the dots of its first and last points show whole.
const PAD = 4;

type Context = NonNullable<SessionView['context']>;
type Tokens = NonNullable<SessionView['tokens']>;
type Cost = NonNullable<SessionView['cost']>;
type Value = { t: number; v: number };

// A number as an attribute's value, without the noise of floating point: 0.62, not
// 0.6200000000000001.
const valueText = (value: number) => String(+value.toFixed(4));

// A coordinate of a viewBox, to a tenth.
const at = (value: number) => +value.toFixed(1);

// A share 0..1 as a CSS percent, kept within 0% and 100%.
const cssPercent = (share: number) => `${+(Math.min(1, Math.max(0, share)) * 100).toFixed(2)}%`;

// The start tag of the chart `name`, `height` high, with the attributes `attrs` after its name.
const svgOf = (name: string, height: number, attrs = '') =>
  `<svg data-chart="${name}"${attrs} width="100%" viewBox="0 0 ${WIDTH} ${height}" preserveAspectRatio="none">`;

// `values` in at most `room` points, grouped as model calls are: each group dated by its last
// value and taking that value, as the context after the last of the calls, or the cost a
// session had spent by then.
function groupValues(values: Value[], room: number): Value[] {
  const points: Point[] = groupPoints(
    values.map(({ t, v }) => ({ t, n: 1, read: 0, write: 0, uncached: 0, output: 0, cost: null, context: v })),
    room,
  );
  return points.map(({ t, context }) => ({ t, v: context! }));
}

// The x of the time `t` on a chart that spans `times` from the first to the last.
function timeScale(times: number[]) {
  const first = Math.min(...times);
  const span = Math.max(...times) - first;
  return (t: number) => at(span === 0 ? WIDTH / 2 : PAD + ((t - first) / span) * (WIDTH - 2 * PAD));
}

// The y of the value `v` on a chart `height` high, from 0 at the bottom to `top` at the top.
const valueScale = (height: number, top: number) => (v: number) => at(height - PAD - (v / (top || 1)) * (height - 2 * PAD));

// The round scale of a chart `height` high whose highest value is `top`, from 0 at the bottom to
// two steps at the top, the step the smallest of 1, 2 or 5 × 10ⁿ whose double reaches `top` (of
// 1 when `top` is 0): `y` the y of a value, `lines` the SVG's faint lines at 0, one and two
// steps, and `labels` the values of those at one and two steps, as `format` writes them for the
// step, each laid over the chart at its left, under its line.
function scaleOf(height: number, top: number, format: (v: number, step: number) => string) {
  const reach = top || 1;
  const power = 10 ** Math.floor(Math.log10(reach / 2));
  const step = [1, 2, 5, 10].map((m) => +(m * power).toPrecision(12)).find((candidate) => 2 * candidate >= reach)!;
  const y = valueScale(height, 2 * step);
  const values = [0, step, 2 * step];
  return {
    y,
    lines: values.map((v) => `<line data-scale="${valueText(v)}" x1="0" x2="${WIDTH}" y1="${y(v)}" y2="${y(v)}"/>`).join(''),
    labels: values
      .slice(1)
      .map((v) => `<span data-label="${valueText(v)}" class="num" style="top:${cssPercent(y(v) / height)}">${format(v, step)}</span>`)
      .join(''),
  };
}

// A cost in dollars as a label of a scale of the step `step`: to the cent, as `formatCost`
// writes it, or to as many decimals as a step under a cent needs, so that no line under a cent
// reads $0.00 or the same as another: $0.002, $0.004.
const usdLabel = (v: number, step: number) => `$${v.toFixed(Math.max(2, -Math.floor(Math.log10(step))))}`;

// A chart's plot: its SVG `svg`, with the labels `labels` laid over it.
const plot = (svg: string, labels: string) => `<div data-part="plot" class="plot">${svg}${labels}</div>`;

// The steps of the times under a chart, from the smallest, before whole days: 1, 2, 5, 10, 15 and
// 30 minutes, then 1, 2, 3, 6 and 12 hours.
const CLOCK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720].map((minutes) => minutes * MINUTE_MS);
const DAY_MS = 24 * 60 * MINUTE_MS;

// The times of day under a chart that spans `times`, at its x `x`: at most five, at round marks
// of local time, the multiples of the smallest step (CLOCK_STEPS, then whole days) that keeps
// them to five; the first and the last of `times` when the span holds no such mark, the last left
// out when it reads as the first.
function clockMarks(times: number[], x: (t: number) => number) {
  const first = Math.min(...times);
  const last = Math.max(...times);
  // local time is the epoch's time less the time zone's offset
  const offset = new Date(first).getTimezoneOffset() * MINUTE_MS;
  let marks: number[] = [];
  for (let i = 0; ; i += 1) {
    const step = i < CLOCK_STEPS.length ? CLOCK_STEPS[i] : (i - CLOCK_STEPS.length + 1) * DAY_MS;
    const start = Math.ceil((first - offset) / step) * step + offset;
    if (start + 5 * step <= last) continue;
    for (let t = start; t <= last; t += step) marks.push(t);
    break;
  }
  if (marks.length === 0) marks = formatClock(last) === formatClock(first) ? [first] : [first, last];
  return timesRow(marks.map((t) => ({ t, x: x(t) })));
}

// The times `marks` under a chart, each written at its x and kept within the chart: shifted left
// by as much of its width as its x is of the chart's, so one at the left edge begins at its x and
// one at the right edge ends at it.
function timesRow(marks: { t: number; x: number }[]) {
  const spans = marks.map(({ t, x }) => {
    const left = cssPercent(x / WIDTH);
    return `<span data-time="${t}" class="num" style="left:${left};transform:translateX(-${left})">${formatClock(t)}</span>`;
  });
  return `<div data-part="times" class="times muted">${spans.join('')}</div>`;
}

// The times of the first and the last of `times`, under the sub-agent bars; one time once.
function axis(times: number[]) {
  const first = formatClock(Math.min(...times));
  const last = formatClock(Math.max(...times));
  return `<div class="row axis muted"><span class="num">${first}</span><span class="grow"></span>${last === first ? '' : `<span class="num">${last}</span>`}</div>`;
}

// A session chart's card: the title `title`, with `aside` beside it, then `body`.
const card = (title: string, aside: string, body: string) => `<div class="chart"><div class="row"><b class="grow">${title}</b>${aside}</div>${body}</div>`;

// The spark line of `contexts`, oldest first, from 0 at the bottom to the largest at the top; ''
// when there is none. One context is drawn as a level line.
export function sparkLine(contexts: number[]): string {
  if (contexts.length === 0) return '';
  const top = Math.max(...contexts) || 1;
  const y = (context: number) => +(SPARK_HEIGHT - 2 - (context / top) * (SPARK_HEIGHT - 4)).toFixed(1);
  const step = contexts.length > 1 ? WIDTH / (contexts.length - 1) : WIDTH;
  const points = contexts.map((context, i) => `${+(i * step).toFixed(1)} ${y(context)}`);
  if (contexts.length === 1) points.push(`${WIDTH} ${y(contexts[0])}`);
  return (
    `${svgOf('spark', SPARK_HEIGHT, ` data-points="${contexts.length}"`)}` +
    `<path d="M${points.join(' L')}" fill="none" vector-effect="non-scaling-stroke"/></svg>`
  );
}

// The bar of a context at `percent` of its window, filled to it in the colour of its level, with
// a mark where the harness compacts on its own (`compactAt`, a share of the window), none when
// that is not known.
export function contextBar(percent: number, compactAt: Num): string {
  const mark = typeof compactAt === 'number';
  return (
    `<div data-part="bar" class="bar lvl-${levelOf(percent)}" data-fill="${valueText(percent)}"${mark ? ` data-mark="${valueText(compactAt)}"` : ''}>` +
    `<i style="width:${cssPercent(percent)}"></i>${mark ? `<u style="left:${cssPercent(compactAt)}"></u>` : ''}</div>`
  );
}

// The context over the whole session, in at most `room` points. With a window, each point is
// the context's share of it, its segment in the colour of its level, with lines at 75% and 90%
// whose percents are written beside the chart, so no level is told by colour alone; under the
// latest percent, the peak, the compactions and the tokens left before the harness
// compacts on its own. Without one (class `plain`), each point is the context in tokens, with no
// percent and no level, under the latest tokens and the peak. Each compaction is marked at its
// time, with its tokens before and after.
export function contextChart(context: Context, room = ROOM): string {
  if (context.points.length === 0) return '';
  const { window, latest, peak, marks } = context;
  const shares = typeof window === 'number';
  const points = groupValues(context.points, room).map(({ t, v }) => ({ t, v: shares ? v / window : v }));
  const times = [...points.map(({ t }) => t), ...marks.map(({ t }) => t)];
  const x = timeScale(times);
  const scale = scaleOf(CONTEXT_HEIGHT, Math.max(shares ? 1 : 0, ...points.map(({ v }) => v)), shares ? formatPercent : formatTokens);
  const { y } = scale;
  const refs = shares ? [0.75, 0.9].map((share) => `<line data-ref="${share}" x1="0" x2="${WIDTH}" y1="${y(share)}" y2="${y(share)}"/>`).join('') : '';
  const lines = marks.map(({ t, before, after }) => `<line data-mark data-t="${t}" data-before="${before}" data-after="${after}" x1="${x(t)}" x2="${x(t)}" y1="0" y2="${CONTEXT_HEIGHT}"/>`).join('');
  // each point a segment from the point before it, in the colour of its level; the first a dot
  const xy = points.map(({ t, v }) => `${x(t)} ${y(v)}`);
  const line = points
    .map(({ t, v }, i) => `<path data-t="${t}" data-v="${valueText(v)}"${shares ? ` class="lvl-${levelOf(v)}"` : ''} d="M${xy[i - 1] ?? xy[i]} L${xy[i]}"/>`)
    .join('');
  const notes = marks.map(({ t, before, after }) => `<span>compacted <span class="num">${formatClock(t)}</span> <span class="num">${orNa(before, formatTokens)} → ${orNa(after, formatTokens)}</span></span>`).join('');
  const refKeys = shares ? '<div class="row key muted"><span><i class="lvl-hot"></i><span class="num">75%</span></span><span><i class="lvl-critical"></i><span class="num">90%</span></span></div>' : '';
  return card(
    'Context',
    '',
    `<div class="row headline">${contextHeadline(context)}</div>` +
      plot(`${svgOf('context', CONTEXT_HEIGHT, shares ? '' : ' class="plain"')}${scale.lines}${refs}${lines}${line}</svg>`, scale.labels) +
      `${clockMarks(times, x)}${refKeys}${notes ? `<div class="row marks muted">${notes}</div>` : ''}`,
  );
}

// The headline of the context chart: with a window, the latest percent in the colour of its
// level, then the peak percent, the compactions and the tokens left before the harness compacts
// on its own; without one, the latest tokens and the peak.
function contextHeadline({ window, latest, peak, compactions, tokensLeft }: Context) {
  if (window === 'n/a') return `${num('latest', orNa(latest, formatTokens), 'hero')}<span class="muted">peak ${num('peak', orNa(peak, formatTokens))}</span>`;
  const share = latest === 'n/a' ? latest : latest / window;
  return (
    num('latest', formatPercent(share), `hero${share === 'n/a' ? '' : ` lvl-${levelOf(share)}`}`) +
    `<span class="muted">peak ${num('peak', formatPercent(peak === 'n/a' ? peak : peak / window))} · ` +
    `${num('compactions', String(compactions))} compaction${compactions === 1 ? '' : 's'} · ${num('tokensLeft', orNa(tokensLeft, formatTokens))} left</span>`
  );
}

// The tokens of each model call, in at most `room` bars, in their order: the prompt tokens read
// from the cache, written to it and not cached, stacked, and the output tokens as a line on a
// scale of their own; the session's cache hit rate beside the title, and under the chart a note
// of the cold starts, none without one.
export function tokensChart(tokens: Tokens, room = ROOM): string {
  if (tokens.points.length === 0) return '';
  const points: Point[] = groupPoints(tokens.points, room);
  const slot = WIDTH / points.length;
  const width = at(slot * 0.7);
  const { y: promptScale, lines: scaleLines, labels: scaleLabels } = scaleOf(TOKENS_HEIGHT, Math.max(...points.map(({ read, write, uncached }) => read + write + uncached)), formatTokens);
  // the left of the bar `i`
  const barX = (i: number) => at(i * slot + (slot - width) / 2);
  const outputScale = valueScale(TOKENS_HEIGHT, Math.max(...points.map(({ output }) => output)));
  const bars = points
    .map(({ read, write, uncached, output }, i) => {
      let below = 0;
      const rects = (
        [
          ['k-read', read],
          ['k-write', write],
          ['k-uncached', uncached],
        ] as const
      )
        .map(([kind, value]) => {
          const top = promptScale(below + value);
          const rect = `<rect class="${kind}" x="${barX(i)}" y="${top}" width="${width}" height="${at(promptScale(below) - top)}"/>`;
          below += value;
          return rect;
        })
        .join('');
      return `<g data-bar data-read="${read}" data-write="${write}" data-uncached="${uncached}" data-output="${output}">${rects}</g>`;
    })
    .join('');
  const output = `<polyline data-output class="k-output" points="${points.map(({ output: value }, i) => `${at((i + 0.5) * slot)} ${outputScale(value)}`).join(' ')}"/>`;
  const keys = [
    ['k-read', 'read from cache'],
    ['k-write', 'written to cache'],
    ['k-uncached', 'not cached'],
    ['k-output', 'output'],
  ]
    .map(([kind, name]) => `<span><i class="${kind}"></i>${name}</span>`)
    .join('');
  const { cold } = tokens;
  const note = cold
    ? `<div data-part="cold-note" class="muted"><span class="num">${cold.count}</span> cold start${cold.count === 1 ? '' : 's'} · <span class="num">${formatTokens(cold.tokens)}</span> written again · <span class="num">${formatCost(cold.cost)}</span></div>`
    : '';
  return card(
    'Tokens per model call',
    `<span class="muted">cache hit ${num('hitRate', formatPercent(tokens.hitRate))}</span>`,
    // the faint lines over the bars, so that a bar does not hide them
    plot(`${svgOf('tokens', TOKENS_HEIGHT)}${bars}${scaleLines}${output}</svg>`, scaleLabels) +
      // the first bar and every n-th one after it, at most five, each with the time of its last call
      timesRow(points.flatMap(({ t }, i) => (i % Math.ceil(points.length / 5) === 0 ? [{ t, x: barX(i) + width / 2 }] : []))) +
      `<div class="row key muted">${keys}</div>${note}`,
  );
}

// What the session had spent at the time `t` (epoch ms), USD: on its own model calls and on its
// sub-agents, each the last value of its series at or before `t`, 0 before the first, n/a when
// the series cannot be read.
export function costAt(cost: Cost, t: number): { own: Num; sub: Num } {
  const spent = (series: Value[] | 'n/a'): Num => (series === 'n/a' ? series : series.reduce((last, point) => (point.t <= t ? point.v : last), 0));
  return { own: spent(cost.own), sub: spent(cost.sub) };
}

// The cost of the session over time, in at most `room` points of time: a step line of what it
// had spent on its own model calls and one of its sub-agents (`costAt`), each drawn only when
// its series can be read and holds a point. The total, and where it comes from, are the session
// screen's to write.
export function costChart(cost: Cost, room = ROOM): string {
  const layers = (['own', 'sub'] as const).filter((name) => {
    const series = cost[name];
    return series !== 'n/a' && series.length > 0;
  });
  if (layers.length === 0) return '';
  const all = layers.flatMap((name) => cost[name] as Value[]).sort((a, b) => a.t - b.t);
  const times = groupValues(all, room).map(({ t }) => t);
  const spent = times.map((t) => costAt(cost, t));
  const x = timeScale(times);
  const scale = scaleOf(COST_HEIGHT, Math.max(...layers.flatMap((name) => spent.map((then) => then[name] as number))), usdLabel);
  const { y } = scale;
  const drawn = layers
    .map((name) => {
      const values = spent.map((then) => then[name] as number);
      const points = values.map((v, i): [number, number] => [x(times[i]), y(v)]);
      const steps = points.map(([px, py], i) => (i === 0 ? `M${px} ${py}` : `L${px} ${points[i - 1][1]} L${px} ${py}`)).join(' ');
      const dots = points.map(([px, py], i) => `<path data-t="${times[i]}" data-v="${valueText(values[i])}" d="M${px} ${py} L${px} ${py}"/>`).join('');
      return `<g data-layer="${name}" data-last="${valueText(values.at(-1)!)}"><path d="${steps}"/>${dots}</g>`;
    })
    .join('');
  const last = costAt(cost, times.at(-1)!);
  const keys = layers.map((name) => `<span><i class="k-${name}"></i>${name === 'own' ? 'own turns' : 'sub-agents'} <span class="num">${formatCost(last[name])}</span></span>`).join('');
  return card('Cost', '', `${plot(`${svgOf('cost', COST_HEIGHT)}${scale.lines}${drawn}</svg>`, scale.labels)}${clockMarks(times, x)}<div class="row key muted">${keys}</div>`);
}

// The burn rate of each minute of `layers`, oldest first, the newest at `endMs`, stacked: each
// layer an area over those before it, a named session's in the colour of its place and the
// others' in their own, with the minutes' times under it, under a key of each layer's name and
// its newest rate. '' without a layer, or when they cannot be read.
export function burnChart(layers: BurnCard['layers'], endMs: number): string {
  if (layers === 'n/a' || layers.length === 0) return '';
  const count = layers[0].values.length;
  const times = Array.from({ length: count }, (_, i) => endMs - (count - 1 - i) * MINUTE_MS);
  const x = timeScale(times);
  const below = Array.from({ length: count }, () => 0);
  const scale = scaleOf(BURN_HEIGHT, Math.max(...below.map((_, i) => layers.reduce((sum, { values }) => sum + values[i], 0))), (v, step) => `${usdLabel(v, step)}/h`);
  const edge = () => below.map((v, i) => `${x(times[i])} ${scale.y(v)}`);
  const kinds = layers.map((_, k) => (k < BURN_NAMED ? `k-s${k + 1}` : 'k-others'));
  const drawn = layers.map(({ name, values }, k) => {
    const lower = edge().reverse();
    values.forEach((v, i) => (below[i] += v));
    return `<g data-layer="${esc(name)}" data-last="${valueText(values.at(-1)!)}" class="${kinds[k]}"><path d="M${edge().join(' L')} L${lower.join(' L')} Z"/></g>`;
  });
  const keys = layers
    .map(({ name, values }, k) => `<span><i class="${kinds[k]}"></i>${esc(name)} ${num('layerPerHour', formatCostPerHour(values.at(-1)!))}</span>`)
    .join('');
  // the faint lines over the areas, so that an area does not hide them
  return `${plot(`${svgOf('burn', BURN_HEIGHT)}${drawn.join('')}${scale.lines}</svg>`, scale.labels)}${clockMarks(times, x)}<div class="row key muted">${keys}</div>`;
}

// The bars of the sub-agents `agents`, in their order, each on its own line of one time axis that
// spans them all: from its start to its end, in the colour of its kind (`kind-<k>`, k from
// `kinds`), under its label: its name, kind, model and cost. One whose start or end is not known
// has its label and no bar.
export function agentBars(agents: SubAgentView[], kinds: Map<string, number>): string {
  const times = agents.flatMap(({ startMs, endMs }) => (startMs === 'n/a' || endMs === 'n/a' ? [] : [startMs, endMs]));
  const x = timeScale(times);
  const drawn = agents.map(({ name, kind, model, startMs, endMs, cost }) => {
    const bar = startMs === 'n/a' || endMs === 'n/a' ? '' : `<rect x="${x(startMs)}" y="1" width="${Math.max(1, at(x(endMs) - x(startMs)))}" height="${AGENT_HEIGHT - 2}" rx="2"/>`;
    return (
      `<div data-agent data-kind="${esc(kind)}" data-start="${startMs}" data-end="${endMs}" data-cost="${cost === 'n/a' ? cost : valueText(cost)}" class="agent kind-${kinds.get(kind)}">` +
      `<div class="row label"><i></i><span class="grow">${[name, kind, model].map(esc).join(' · ')}</span> · <span class="num">${formatCost(cost)}</span></div>` +
      `${svgOf('subagents', AGENT_HEIGHT)}${bar}</svg></div>`
    );
  });
  return `${drawn.join('')}${times.length > 0 ? axis(times) : ''}`;
}
