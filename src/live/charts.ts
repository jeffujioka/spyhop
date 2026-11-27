// The charts of the live panel's cards, as markup: the spark line of a session's recent contexts
// and the bar of its context. A chart is an SVG as wide as its box (`width="100%"` over a
// `viewBox` 360 wide, stretched with `preserveAspectRatio="none"`) with no text of its own, and
// its colours come from the stylesheet (src/live/style.ts), by its classes and attributes.
// Pure: no DOM.

import type { Num } from '../protocol.ts';
import { levelOf } from './levels.ts';

// Width of every chart's viewBox, and the height of the spark line's.
const WIDTH = 360;
const SPARK_HEIGHT = 40;

// A share 0..1 as an attribute's value, without the noise of floating point: 0.62, not
// 0.6200000000000001.
const shareText = (share: number) => String(+share.toFixed(4));

// A share 0..1 as a CSS percent, kept within 0% and 100%.
const cssPercent = (share: number) => `${+(Math.min(1, Math.max(0, share)) * 100).toFixed(2)}%`;

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
    `<svg data-chart="spark" data-points="${contexts.length}" width="100%" viewBox="0 0 ${WIDTH} ${SPARK_HEIGHT}" preserveAspectRatio="none">` +
    `<path d="M${points.join(' L')}" fill="none" vector-effect="non-scaling-stroke"/></svg>`
  );
}

// The bar of a context at `percent` of its window, filled to it in the colour of its level, with
// a mark where the harness compacts on its own (`compactAt`, a share of the window), none when
// that is not known.
export function contextBar(percent: number, compactAt: Num): string {
  const mark = typeof compactAt === 'number';
  return (
    `<div data-part="bar" class="bar lvl-${levelOf(percent)}" data-fill="${shareText(percent)}"${mark ? ` data-mark="${shareText(compactAt)}"` : ''}>` +
    `<i style="width:${cssPercent(percent)}"></i>${mark ? `<u style="left:${cssPercent(compactAt)}"></u>` : ''}</div>`
  );
}
