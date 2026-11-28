// The Copilot price table a test prices calls with: `withCopilotPrices(prices)` makes the table
// (src/core/copilot-prices.js) hold exactly `prices` for the test, and its published entries are
// put back at the test's end (test/helpers/env.ts), so a test never depends on GitHub's prices.
import { COPILOT_PRICES, type Price } from '../../src/core/copilot-prices.js';
import { atTestEnd } from './env.ts';

const published = { ...COPILOT_PRICES };

atTestEnd(() => withCopilotPrices(published));

export function withCopilotPrices(prices: Record<string, Price>) {
  for (const model of Object.keys(COPILOT_PRICES)) delete COPILOT_PRICES[model];
  Object.assign(COPILOT_PRICES, prices);
}
