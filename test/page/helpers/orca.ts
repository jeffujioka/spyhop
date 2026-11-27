// The stand-in for Orca's Frame API that the panel's page sees as its global `orca`, offering only
// what the page calls: `plugin.request`, answered in the test by `answers`, the worker's answer to
// each request name, and recorded in order; `plugin.on` and `on('theme')`, which take a handler and
// never call it, as no worker posts and Orca's theme does not change here. A request with no
// answer fails, as a request to a worker that has no handler for it does.
// A hand-written peer of a published interface, not a test double.
import type { Page } from 'playwright-core';

// The worker's answer to each request name, from the request's input.
export type Answers = Record<string, (input: Record<string, unknown>) => unknown>;
// A request the page made.
export type Asked = { name: string; input: Record<string, unknown> };

// Puts the stand-in on `page`, before any of its scripts runs; the requests it makes from then.
export async function standInOrca(page: Page, answers: Answers): Promise<Asked[]> {
  const requests: Asked[] = [];
  await page.exposeFunction('spyhopRequest', (name: string, input: Record<string, unknown>) => {
    requests.push({ name, input });
    const answer = answers[name];
    if (!answer) throw new Error(`the worker has no answer to ${name}`);
    return answer(input);
  });
  await page.addInitScript(() => {
    const none = () => ({ dispose() {} });
    // exposeFunction puts `spyhopRequest` on the page's global, which its types do not know
    const exposed = globalThis as unknown as { spyhopRequest: (name: string, input: unknown) => Promise<unknown> };
    Object.assign(globalThis, { orca: { plugin: { request: exposed.spyhopRequest, on: none }, on: none } });
  });
  return requests;
}
