// Text put into the live panel's markup, escaped, so that a title or a folder name that holds
// markup is shown as text and never read as tags; the same in an attribute's quoted value.

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char]);
}
