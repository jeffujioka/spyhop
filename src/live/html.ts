// Text put into the live panel's markup, escaped, so that a title or a folder name that holds
// markup is shown as text and never read as tags; the same in an attribute's quoted value. And
// the markup of a figure, which every screen writes alike, and of a range tab's titled figure.

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

// The figure `name` (`data-figure`), reading `value`, in the font of figures (`.num`), with the
// classes `classes` beside it when given (a level's colour, a headline's size).
export function num(name: string, value: string, classes = ''): string {
  return `<span class="num${classes ? ` ${classes}` : ''}" data-figure="${name}">${esc(value)}</span>`;
}

// A figure or chart of the range tabs (`data-part="figure"`, named by its title): its title in
// plain words, under it the one line of what it means, then `body`.
export function titled(title: string, meaning: string, body: string): string {
  return `<section data-part="figure" data-name="${esc(title)}"><b data-title>${esc(title)}</b><p data-meaning class="muted">${esc(meaning)}</p>${body}</section>`;
}
