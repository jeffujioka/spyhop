// Text put into the live panel's markup, escaped, so that a title or a folder name that holds
// markup is shown as text and never read as tags; the same in an attribute's quoted value. And
// the markup of a figure, which every screen writes alike.

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

// The figure `name` (`data-figure`), reading `value`, in the font of figures (`.num`), with the
// classes `classes` beside it when given (a level's colour, a headline's size).
export function num(name: string, value: string, classes = ''): string {
  return `<span class="num${classes ? ` ${classes}` : ''}" data-figure="${name}">${esc(value)}</span>`;
}
