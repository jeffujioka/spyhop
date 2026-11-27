// The checks of the live panel's page that spyhop-live left to be done by hand: the focus kept on
// the same control through a redraw of the fleet screen, or moved to the card or folded line of
// its session when the control is gone; Enter on a card after redraws; a new screen opened at its
// top; and no request while the page is hidden. The page runs in headless Chrome on the stand-in
// for Orca (test/page/helpers/), whose worker answers the fleet a test sets
// (test/page/helpers/answers.ts) and changes between two refreshes; a test waits for the answer it
// needs to be drawn, by the minutes the answer's cards read, rather than for a time.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Locator, Page } from 'playwright-core';
import { answersOf, blockedRow, card, DOCS, FIX, type Fleet } from './helpers/answers.ts';
import { openPanel } from './helpers/page.ts';

// Waits until the page has drawn the answer to the fleet request `request`.
const drawn = (page: Page, request: number) =>
  page.locator('[data-part="card"] [data-figure="since"]', { hasText: new RegExp(`^${request}m$`) }).first().waitFor();

const cardOf = (page: Page, title: string) => page.locator('[data-part="card"]', { hasText: title });

const isFocused = (control: Locator) => control.evaluate((element) => element === document.activeElement);

// Hides or shows the page as Orca does when it collapses or opens the panel: headless Chrome
// keeps every page visible, so the page's document reads `visibilityState` from here and hears
// its `visibilitychange`.
const setHidden = (page: Page, hidden: boolean) =>
  page.evaluate((hide) => {
    if (hide) Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    else Reflect.deleteProperty(document, 'visibilityState');
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);

test('Enter on a card after redraws', async () => {
  const { page } = await openPanel(answersOf(() => ({ cards: [card(FIX), card(DOCS)] })));
  await drawn(page, 1);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  assert.ok(await isFocused(cardOf(page, DOCS)));

  await drawn(page, 3);
  await page.keyboard.press('Enter');

  await page.locator('main[data-screen="session"] header .title', { hasText: DOCS }).waitFor();
});

test('Focus kept when a row appears', async () => {
  let fleet: Fleet = { cards: [card(FIX), card(DOCS)] };
  const { page } = await openPanel(answersOf(() => fleet));
  await drawn(page, 1);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  assert.ok(await isFocused(cardOf(page, DOCS)));

  const blocked = card(FIX, { state: 'blocked' });
  fleet = { cards: [blocked, card(DOCS)], attention: [blockedRow(blocked)] };
  await page.locator('[data-row="state"]', { hasText: FIX }).waitFor();

  assert.ok(await isFocused(cardOf(page, DOCS)));
});

test('Focus when a row goes', async () => {
  const blocked = card(FIX, { state: 'blocked' });
  let fleet: Fleet = { cards: [blocked, card(DOCS)], attention: [blockedRow(blocked)] };
  const { page } = await openPanel(answersOf(() => fleet));
  await drawn(page, 1);
  await page.keyboard.press('Tab');
  assert.ok(await isFocused(page.locator('[data-row="state"]', { hasText: FIX })));

  fleet = { cards: [card(FIX), card(DOCS)] };
  await page.locator('[data-part="attention"]').waitFor({ state: 'detached' });

  assert.ok(await isFocused(cardOf(page, FIX)));
});

test('Focus when a card folds', async () => {
  let fleet: Fleet = { cards: [card(FIX), card(DOCS)] };
  const { page } = await openPanel(answersOf(() => fleet));
  await drawn(page, 1);
  await page.keyboard.press('Tab');
  assert.ok(await isFocused(cardOf(page, FIX)));

  fleet = { cards: [card(FIX, { state: 'done' }), card(DOCS)] };
  const folded = page.locator('[data-part="folded"]', { hasText: FIX });
  await folded.waitFor();

  assert.ok(await isFocused(folded));
});

test('Session header in view after opening a lower card', async () => {
  const titles = Array.from({ length: 8 }, (_, i) => `Session ${i + 1}`);
  const { page } = await openPanel(answersOf(() => ({ cards: titles.map((title) => card(title)) })));
  await page.setViewportSize({ width: 300, height: 600 });
  await drawn(page, 1);
  await page.mouse.move(150, 300);
  await page.mouse.wheel(0, 10_000);
  await page.waitForFunction(() => scrollY > 0 && scrollY + innerHeight >= document.documentElement.scrollHeight - 1);

  await cardOf(page, titles[7]).click();

  const header = page.locator('main[data-screen="session"] header[data-part="header"]', { hasText: titles[7] });
  await header.waitFor();
  await page.locator('[data-part="loading"]').waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => scrollY), 0);
  const box = await header.boundingBox();
  assert.ok(box && box.y >= 0 && box.y + box.height <= 600, `the header is drawn at ${JSON.stringify(box)}`);
});

test('No request while hidden', async () => {
  const { page, requests } = await openPanel(answersOf(() => ({ cards: [card(FIX)] })));
  await drawn(page, 1);

  await setHidden(page, true);
  const asked = requests.length;
  await page.waitForTimeout(6000);

  assert.equal(requests.length, asked);
  await setHidden(page, false);
  await drawn(page, asked + 1);
  assert.deepEqual(requests.at(-1), { name: 'spyhop.fleet', input: { request: asked + 1 } });
});
