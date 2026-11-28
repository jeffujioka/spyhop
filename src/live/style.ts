// The live panel's stylesheet, which src/panel.ts puts in a <style>. Orca's theme variables give
// the background, text, cards, borders and accent, and Orca's fonts: sans for text, monospace
// with tabular digits for every figure (`.num`). The plugin's own colours, of the context levels
// (`--spy-ok|warning|hot|critical`), the chart series (`--spy-s1..s4`, `--spy-others`) and the
// sub-agent kinds (`--spy-k1..k6`), are set once for Orca's dark theme and once for its light one,
// by the class Orca puts on <html>, so a change of theme recolours the panel in place.
// The panel works from 300 px wide: rows wrap, long words break, and no width is fixed over that.

export const STYLE = `
html.dark {
  --spy-ok: #3fb950; --spy-warning: #d29922; --spy-hot: #f0883e; --spy-critical: #f85149;
  --spy-s1: #58a6ff; --spy-s2: #bc8cff; --spy-s3: #f778ba; --spy-s4: #39c5cf; --spy-others: #8b949e;
  --spy-k1: #58a6ff; --spy-k2: #bc8cff; --spy-k3: #39c5cf; --spy-k4: #f778ba; --spy-k5: #e3b341; --spy-k6: #8b949e;
}
html.light {
  --spy-ok: #1a7f37; --spy-warning: #9a6700; --spy-hot: #bc4c00; --spy-critical: #cf222e;
  --spy-s1: #0969da; --spy-s2: #8250df; --spy-s3: #bf3989; --spy-s4: #1b7c83; --spy-others: #6e7781;
  --spy-k1: #0969da; --spy-k2: #8250df; --spy-k3: #1b7c83; --spy-k4: #bf3989; --spy-k5: #9a6700; --spy-k6: #6e7781;
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 10px; font-family: var(--orca-font-sans); font-size: 13px; line-height: 1.4;
  background: var(--orca-background); color: var(--orca-foreground); overflow-wrap: anywhere;
}
.num { font-family: var(--orca-font-mono); font-variant-numeric: tabular-nums; }
.row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; min-width: 0; }
/* A basis of 10em, not 0, makes a long neighbour (a folder with no break) wrap to its own line
   rather than squeeze the title beside it to a letter a line. */
.grow { flex: 1 1 10em; min-width: 0; }
.muted { color: var(--orca-muted-foreground); }
header { margin-bottom: 4px; }
.logo { font-weight: 650; font-size: 15px; }
.live { color: var(--orca-muted-foreground); font-size: 11.5px; }
.live .dot { background: var(--spy-ok); }
[data-part="counts"] { margin: 6px 0 0; font-size: 12px; }
[data-part="group"], [data-part="attention"] { margin-top: 14px; }
[data-part="group"] > h2, [data-part="attention"] > h2 {
  margin: 0; font-size: 10.5px; font-weight: 500; letter-spacing: .08em; text-transform: uppercase;
  color: var(--orca-muted-foreground);
}
[data-part="card"], [data-part="folded"], [data-row] {
  margin-top: 8px; padding: 10px 12px; min-width: 0; background: var(--orca-card); color: var(--orca-card-foreground);
  border: 1px solid var(--orca-border); border-radius: var(--orca-radius);
}
[data-part="card"]:hover, [data-part="folded"]:hover, [data-row]:hover { background: var(--orca-accent); color: var(--orca-accent-foreground); }
[data-part="folded"], [data-row] { padding: 7px 12px; font-size: 12px; }
.tag { font-size: 10px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--orca-muted-foreground); }
.title { font-weight: 600; }
.meta { margin-top: 2px; font-size: 11.5px; color: var(--orca-muted-foreground); }
.dot { display: inline-block; flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--orca-muted-foreground); }
[data-state="working"] .dot { background: var(--orca-primary); }
[data-state="blocked"] .dot { background: var(--spy-critical); }
[data-state="waiting"] .dot { background: var(--spy-warning); }
[data-state="done"] .dot { background: var(--spy-ok); }
.context { margin-top: 8px; font-size: 11.5px; }
.lvl-ok { --lvl: var(--spy-ok); }
.lvl-warning { --lvl: var(--spy-warning); }
.lvl-hot { --lvl: var(--spy-hot); }
.lvl-critical { --lvl: var(--spy-critical); }
.num[class*="lvl-"] { color: var(--lvl); font-weight: 600; }
.bar { position: relative; width: 100%; height: 5px; margin-top: 4px; border-radius: 3px; background: var(--orca-muted); }
.bar > i { display: block; height: 100%; border-radius: 3px; background: var(--lvl); }
.bar > u { position: absolute; top: -3px; width: 2px; height: 11px; background: var(--orca-muted-foreground); }
svg { display: block; }
[data-chart="spark"] { height: 22px; margin-top: 6px; }
[data-chart="spark"] path { stroke: var(--spy-s1); stroke-width: 1.5; }
.chips { margin-top: 8px; gap: 5px; }
[data-chip] { font-size: 10.5px; padding: 1px 8px; border: 1px solid var(--orca-border); border-radius: 999px; }
[data-chip="warning"] { color: var(--lvl); border-color: var(--lvl); }
.chart, .box, .cost-card, .figures {
  margin-top: 8px; padding: 10px 12px; min-width: 0; background: var(--orca-card); color: var(--orca-card-foreground);
  border: 1px solid var(--orca-border); border-radius: var(--orca-radius);
}
.headline { align-items: baseline; margin: 4px 0 2px; }
.hero { font-size: 22px; font-weight: 650; }
.headline .muted, .axis, .times, .marks, .key, [data-part="cold-note"] { font-size: 11px; }
/* A chart's plot holds its SVG and the values of its scale's lines, laid over it at its left,
   each under its line; the times under it are each at the x of its point. */
.plot { position: relative; margin-top: 4px; }
.plot > [data-label] {
  position: absolute; left: 3px; margin-top: 1px; font-size: 10px; line-height: 1;
  color: var(--orca-muted-foreground); pointer-events: none;
}
.times { position: relative; height: 1.4em; margin-top: 2px; }
.times > [data-time] { position: absolute; top: 0; width: max-content; }
[data-chart="context"], [data-chart="tokens"] { height: 120px; }
[data-chart="cost"] { height: 100px; }
[data-chart="burn"] { height: 80px; }
[data-chart] path, [data-chart] line, [data-chart] polyline { fill: none; vector-effect: non-scaling-stroke; stroke-linecap: round; }
[data-chart="context"] path { stroke: var(--lvl); stroke-width: 2; }
[data-chart="context"].plain path { stroke: var(--spy-s1); }
[data-ref] { stroke-width: 1; stroke-dasharray: 3 3; }
[data-ref="0.75"] { stroke: var(--spy-hot); }
[data-ref="0.9"] { stroke: var(--spy-critical); }
[data-mark] { stroke: var(--orca-muted-foreground); stroke-width: 1; stroke-dasharray: 2 2; }
[data-scale] { stroke: var(--orca-muted-foreground); stroke-width: 1; opacity: .25; }
/* the kinds of tokens, and the costs of a session's own model calls and of its sub-agents */
.k-read { --k: var(--spy-s4); }
.k-write { --k: var(--spy-s3); }
.k-uncached { --k: var(--spy-s1); }
.k-output { --k: var(--spy-s2); }
[data-layer="own"], .k-own { --k: var(--spy-s1); }
[data-layer="sub"], .k-sub { --k: var(--spy-s2); }
[data-bar] rect { fill: var(--k); }
polyline[data-output], [data-layer] path { stroke: var(--k); stroke-width: 1.5; }
[data-layer] path[data-v] { stroke-width: 4; }
/* the burn rate chart's sessions, by their place, and the others; its layers are filled areas */
.k-s1 { --k: var(--spy-s1); }
.k-s2 { --k: var(--spy-s2); }
.k-s3 { --k: var(--spy-s3); }
.k-others { --k: var(--spy-others); }
[data-chart="burn"] [data-layer] path { fill: var(--k); stroke: none; }
.key { gap: 4px 10px; margin-top: 4px; }
.key i, [data-box] i { display: inline-block; width: 8px; height: 8px; margin-right: 4px; border-radius: 2px; background: var(--k, var(--lvl)); }
.key i[class*="lvl-"] { background: var(--lvl); }
/* A chart's crosshair and box, one per point, each hidden until the page shows the one at the
   pointer (data-on): the line across the chart, a dot on each layer in the layer's colour, and
   the box at the top of the chart, in the half (data-on="left|right") the line is not in. */
[data-cross]:not([data-on]), [data-box]:not([data-on]) { display: none; }
[data-cross] line { stroke: var(--orca-foreground); stroke-width: 1; opacity: .5; }
[data-chart] [data-dot] { stroke: var(--k, var(--lvl, var(--spy-s1))); stroke-width: 7; }
/* A box's lines wrap at their spaces, so that no label or value is cut off. */
.plot > [data-box] {
  position: absolute; top: 2px; z-index: 1; max-width: calc(50% - 4px); padding: 2px 5px;
  font-size: 10px; line-height: 1.15; background: var(--orca-card);
  color: var(--orca-card-foreground); border: 1px solid var(--orca-border); border-radius: var(--orca-radius);
  pointer-events: none;
}
.plot > [data-box][data-on="left"] { left: 2px; }
.plot > [data-box][data-on="right"] { right: 2px; }
.marks { gap: 2px 10px; margin-top: 2px; }
[data-part="cold-note"] { margin-top: 6px; }
/* the session screen */
button {
  font: inherit; color: inherit; background: none; border: 1px solid var(--orca-border);
  border-radius: var(--orca-radius); padding: 2px 10px; cursor: pointer;
}
button:hover { background: var(--orca-accent); color: var(--orca-accent-foreground); }
.back { border: none; padding: 0 4px; font-size: 18px; line-height: 1; color: var(--orca-muted-foreground); }
.focus { font-size: 11.5px; }
.figures { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 10px; }
.figure { min-width: 0; font-size: 10.5px; }
.figure > .num { display: block; margin: 2px 0; font-size: 17px; font-weight: 650; }
/* The cost card holds the cost chart's card and the total: the chart's own box gives way to the
   cost card's, and the total goes under the chart's title, before its chart. */
.cost-card { display: flex; flex-direction: column; }
.cost-card > .chart { display: contents; }
.cost-card > .chart > * { order: 2; }
.cost-card > .chart > :first-child { order: 0; }
.cost-card > .headline { order: 1; }
.cost-card > .headline > .num { font-size: 22px; font-weight: 650; }
.box .head { margin-bottom: 4px; }
.box .head .muted { font-size: 11px; }
.box .item, [data-list] .item { font-size: 12px; padding: 2px 0; }
.failed { color: var(--spy-critical); font-size: 11px; }
/* the Sub-agents section: each bar under its label, in the colour of its kind */
.kind-1 { --k: var(--spy-k1); }
.kind-2 { --k: var(--spy-k2); }
.kind-3 { --k: var(--spy-k3); }
.kind-4 { --k: var(--spy-k4); }
.kind-5 { --k: var(--spy-k5); }
.kind-6 { --k: var(--spy-k6); }
.agents { margin-top: 6px; }
.agent { margin-top: 4px; }
.agent .label { font-size: 11.5px; }
.agent .label i { display: inline-block; flex: none; width: 8px; height: 8px; border-radius: 2px; background: var(--k); }
[data-chart="subagents"] { height: 8px; margin-top: 2px; }
[data-chart="subagents"] rect { fill: var(--k); }
.more { margin-top: 6px; font-size: 11px; }
/* the tab bar, the range control, and a range tab's titled figures and charts: each its title,
   the line of what it means under it, then its figure or chart */
[data-part="tabs"], [data-part="range"] { gap: 4px; margin-bottom: 8px; }
[data-part="tabs"] [aria-selected="true"], [data-part="range"] [aria-pressed="true"] {
  background: var(--orca-accent); color: var(--orca-accent-foreground); border-color: var(--orca-primary);
}
section[data-part="figure"] {
  margin-top: 8px; padding: 10px 12px; min-width: 0; background: var(--orca-card); color: var(--orca-card-foreground);
  border: 1px solid var(--orca-border); border-radius: var(--orca-radius);
}
.figures > section[data-part="figure"] { margin: 0; padding: 0; border: none; }
[data-meaning] { margin: 2px 0 4px; font-size: 11px; }
section[data-part="figure"] > .num { display: block; font-size: 17px; font-weight: 650; }
[data-chart^="range-"] { height: 100px; }
[data-chart^="range-"] path { stroke: var(--spy-s1); stroke-width: 1.5; }
[data-chart^="range-"] path[data-key] { stroke-width: 4; }
`;
