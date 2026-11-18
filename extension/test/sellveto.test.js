/* B3 — a sell must not book a lagging aggregator price the live chain contradicts.
 * soramonk 8/21: "bought at 17k and sold at 40k but shows sold at 17k". The chain
 * read was demoted for disagreeing with 20 s-old evidence, and the aggregator
 * snapshot that AGREED with that old evidence priced the sell unchallenged. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.join(__dirname, '..');
global.window = global.window || {};
const Q = require(path.join(ROOT, 'quote.js'));
const contentJs = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
const MINT = 'B3ProbeMintxxxxxxxxxxxxxxxxxxxxxxxxxxxxxpump';
const n = (mc) => mc / 1e9 / 180;

function boot(env) {
  const start = contentJs.indexOf('/* -------------------- action-time quotes and fills');
  const end = contentJs.indexOf('/* -------------------- fills --------------------');
  const sandbox = {
    console: { debug: (...a) => env.debug.push(a.join(' ')) },
    Date, Promise, Set, Number, Boolean, Math, Infinity, JSON, setTimeout,
    Q, R: env.R, E: { fmt: String }, token: env.token,
    lastPriceAt: env.lastPriceAt, lastPageTickAt: env.lastPageTickAt,
    pageQuoteSeq: 0, pageQuoteWaiters: new Set(), site: { id: 'axiom' },
    state: env.state,
  };
  return vm.runInNewContext(contentJs.slice(start, end)
    + '\n;({ quoteForTrade, setEvidence: (v) => { lastAcceptedMarket = v; }, getRefusal: () => lastQuoteRefusal });',
    vm.createContext(sandbox));
}

test('B3: bought 17k, chain says 40k on a quiet screen, lagging aggregator says 18k -> the sell is refused, not booked at 18k', async () => {
  const now = Date.now();
  const debug = [];
  const R = {
    onchainQuote: async () => ({ mint: MINT, priceNative: n(40_000), observedAt: now, slot: 5 }),
    refresh: async () => ({ mint: MINT, priceNative: n(18_000), priceUsd: n(18_000) * 180, mcap: 18_000 }),
  };
  const L = boot({
    debug, R,
    token: { mint: MINT, priceNative: n(40_000), priceUsd: n(40_000) * 180, mcap: 40_000, priceSource: 'page-feed', pending: false },
    lastPriceAt: now - 4000, lastPageTickAt: now - 4000,
  });
  // The buy fill (content.js:4375) is the freshest accepted evidence: 20 s ago.
  L.setEvidence({ priceNative: n(17_000), at: now - 20_000 });
  const q = await L.quoteForTrade();
  assert.equal(q, null, 'a sell must not book at the lagging aggregator after the chain disagreed');
});

test('B3: aggregator candidate 1.4x off evidence, chain witness 1.25x -> refused: an aggregator is vouched for only inside its own band', async () => {
  const now = Date.now();
  const debug = [];
  const R = {
    onchainQuote: async () => ({ mint: MINT, priceNative: n(28_000), observedAt: now, slot: 5 }),
    refresh: async () => ({ mint: MINT, priceNative: n(35_000), priceUsd: n(35_000) * 180, mcap: 35_000 }),
  };
  const L = boot({
    debug, R,
    token: { mint: MINT, priceNative: n(25_000), priceUsd: n(25_000) * 180, mcap: 25_000, priceSource: 'page-feed', pending: false },
    lastPriceAt: now - 4000, lastPageTickAt: now - 4000,
  });
  L.setEvidence({ priceNative: n(25_000), at: now - 5_000 });
  const q = await L.quoteForTrade();
  assert.equal(q, null, 'chain 28k must not vouch for an aggregator 35k');
});

