// How the tests read the live panel's markup (src/live/*.ts), by the conventions the views write
// it in: the parts, figures and charts are elements marked by `data-*` attributes, and every text
// is escaped (src/live/html.ts), so no attribute value or text holds a `<` or a `>`. The markup is
// a string, read here without a DOM, as the views make it in Node.

// Elements that have no end tag.
const VOID: Record<string, true> = { area: true, br: true, col: true, embed: true, hr: true, img: true, input: true, link: true, meta: true, source: true, track: true, wbr: true };

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
const decode = (text: string) => text.replace(/&(amp|lt|gt|quot|#39);/g, (_, name: string) => ENTITIES[name]);

// The attributes of a start tag's text after its name: name -> value, '' for one without a value.
function attributes(text: string) {
  const found = new Map<string, string>();
  for (const [, name, value = ''] of text.matchAll(/([^\s=/]+)(?:="([^"]*)")?/g)) found.set(name, decode(value));
  return found;
}

// The end of the element whose start tag `start` matched at `start.index`: after its end tag, or
// after the start tag of an element with no end tag.
function endOf(html: string, start: RegExpExecArray) {
  const [tag, name] = start;
  const after = start.index + tag.length;
  if (tag.endsWith('/>') || VOID[name.toLowerCase()]) return after;
  const tags = new RegExp(`<(/?)${name}(?=[\\s/>])[^>]*>`, 'g');
  tags.lastIndex = after;
  let depth = 1;
  for (let found = tags.exec(html); found; found = tags.exec(html)) {
    if (found[1]) depth -= 1;
    else if (!found[0].endsWith('/>')) depth += 1;
    if (depth === 0) return found.index + found[0].length;
  }
  throw new Error(`<${name}> at ${start.index} has no end tag`);
}

// The markup of each element of `html` that has the attribute `attr`, with the value `value` when
// given, in the order they start; nested ones too.
export function parts(html: string, attr: string, value?: string): string[] {
  const found: string[] = [];
  const starts = /<([a-zA-Z][\w-]*)([^>]*)>/g;
  for (let start = starts.exec(html); start; start = starts.exec(html)) {
    const attrs = attributes(start[2].replace(/\/$/, ''));
    if (!attrs.has(attr) || (value !== undefined && attrs.get(attr) !== value)) continue;
    found.push(html.slice(start.index, endOf(html, start)));
  }
  return found;
}

// The text of the first figure `name` of `html` (`data-figure="<name>"`), undefined when it has
// none.
export function figure(html: string, name: string): string | undefined {
  const [found] = parts(html, 'data-figure', name);
  return found === undefined ? undefined : text(found);
}

// The text `html` shows, as one line: every tag is a break between words, and each run of white
// space one space.
export function text(html: string): string {
  return decode(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}
