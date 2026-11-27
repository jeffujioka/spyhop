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
[data-part="group"] { margin-top: 14px; }
[data-part="group"] > h2 {
  margin: 0; font-size: 10.5px; font-weight: 500; letter-spacing: .08em; text-transform: uppercase;
  color: var(--orca-muted-foreground);
}
[data-part="card"], [data-part="folded"] {
  margin-top: 8px; padding: 10px 12px; min-width: 0; background: var(--orca-card); color: var(--orca-card-foreground);
  border: 1px solid var(--orca-border); border-radius: var(--orca-radius);
}
[data-part="card"]:hover, [data-part="folded"]:hover { background: var(--orca-accent); color: var(--orca-accent-foreground); }
[data-part="folded"] { padding: 7px 12px; font-size: 12px; }
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
`;
