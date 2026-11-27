// Opens the panel's page (src/panel.ts) in headless Chrome, the copy installed on this Mac, on the
// stand-in for Orca (test/page/helpers/orca.ts), and gives the test the page, to drive with
// Playwright's pointer and keyboard, and the requests the page made. The page is compiled once per
// test file with the project's TypeScript (test/page/tsconfig.json), with no bundler, and served
// from the made-up origin PAGE_ORIGIN as Orca serves a panel: a page whose module is the panel's.
// Chrome is looked for at CHROME, or at SPYHOP_CHROME when set (the page tests' own run without
// Chrome sets it); without it, opening fails and names Google Chrome, so a run never passes by
// skipping its tests. A path the page asks for that the compiled page does not hold is answered
// 404. Each page closes when its test ends, and the browser once the test file's tests have run.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { after, afterEach } from 'node:test';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium, type Locator, type Page } from 'playwright-core';
import { type Answers, type Asked, standInOrca } from './orca.ts';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PAGE_ORIGIN = 'http://spyhop.test';
const HTML = '<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module" src="/panel.js"></script></body></html>';
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

let browser: Promise<Browser> | undefined;
let compiled: string | undefined;
// the pages of the test that runs, closed when it ends
const pages: Page[] = [];
afterEach(async () => {
  await Promise.all(pages.splice(0).map((page) => page.close()));
});
after(async () => {
  await (await browser)?.close();
});

// The folder of the compiled page, compiled on the first call.
function compiledPage() {
  if (compiled) return compiled;
  const out = mkdtempSync(join(tmpdir(), 'spyhop-page-'));
  execFileSync(process.execPath, [join(ROOT, 'node_modules/typescript/bin/tsc'), '-p', join(ROOT, 'test/page/tsconfig.json'), '--outDir', out], { stdio: 'inherit' });
  compiled = out;
  return out;
}

function launch() {
  const chrome = process.env.SPYHOP_CHROME ?? CHROME;
  if (!existsSync(chrome)) throw new Error(`Google Chrome is not installed at ${chrome}: the page tests run it headless`);
  return chromium.launch({ executablePath: chrome, headless: true });
}

// The panel's page, loaded with `answers` as the worker's answers, and the requests it has made.
export async function openPanel(answers: Answers): Promise<{ page: Page; requests: Asked[] }> {
  const out = compiledPage();
  browser ??= launch();
  const page = await (await browser).newPage();
  pages.push(page);
  await page.route(`${PAGE_ORIGIN}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/') return route.fulfill({ contentType: 'text/html', body: HTML });
    const file = join(out, path);
    if (!file.startsWith(out + sep) || !existsSync(file)) return route.fulfill({ status: 404 });
    return route.fulfill({ contentType: 'text/javascript', body: readFileSync(file) });
  });
  const requests = await standInOrca(page, answers);
  await page.goto(`${PAGE_ORIGIN}/`);
  return { page, requests };
}

// Whether `control` has the page's focus.
export const isFocused = (control: Locator) => control.evaluate((element) => element === document.activeElement);
