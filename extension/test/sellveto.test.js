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


test('B3 mirror: a chain read that contradicts FRESH evidence does not veto the aggregator that agrees with it', async () => {
  // The F-48 shape: the chain read is the one lagging. Evidence accepted 5 s
  // ago says 10k, the resolver says 10k, the chain says 30k. That sell has
  // always filled at 10k and must keep filling: only OLD evidence loses the
  // tie to the chain.
  const now = Date.now();
  const debug = [];
  const R = {
    onchainQuote: async () => ({ mint: MINT, priceNative: n(30_000), observedAt: now, slot: 5 }),
    refresh: async () => ({ mint: MINT, priceNative: n(10_000), priceUsd: n(10_000) * 180, mcap: 10_000 }),
  };
  const L = boot({
    debug, R,
    token: { mint: MINT, priceNative: n(10_000), priceUsd: n(10_000) * 180, mcap: 10_000, priceSource: 'page-feed', pending: false },
    lastPriceAt: now - 4000, lastPageTickAt: now - 4000,
  });
  L.setEvidence({ priceNative: n(10_000), at: now - 5_000 });
  const q = await L.quoteForTrade();
  assert.ok(q, `the sell fills (refusal: ${L.getRefusal()})`);
  assert.ok(Math.abs(q.priceNative - n(10_000)) / n(10_000) < 1e-9, 'at the price the fresh evidence and the resolver agree on');
});

function reopened(markMc, candidateMc, markAgeMs) {
  const now = Date.now();
  const R = {
    onchainQuote: async () => null,
    refresh: async () => ({ mint: MINT, priceNative: n(candidateMc), priceUsd: n(candidateMc) * 180, mcap: candidateMc }),
    workerQuote: async () => null,
    solUsd: async () => 180,
  };
  return boot({
    debug: [], R,
    token: { mint: MINT, priceNative: n(candidateMc), priceUsd: n(candidateMc) * 180, mcap: candidateMc, priceSource: 'resolver', pending: false },
    lastPriceAt: now - 4000, lastPageTickAt: 0,
    state: { positions: { [MINT]: { lastPriceNative: n(markMc), lastMarkAt: now - markAgeMs } } },
  });
}

test('a reopened coin that really moved 1.4x since its last mark can be sold when no second source answers', async () => {
  // The position mark is the phantom guard's anchor (F-56) and was treated
  // as fresh evidence whatever its age, so an aggregator price just 1.15x
  // from a ten-minute-old mark needed a witness; with the chain throttled
  // and the worker down the sell was refused. Lag explains a gap against
  // evidence from seconds ago, not against a mark from ten minutes ago.
  const L = reopened(17_000, 24_000, 600_000);
  const q = await L.quoteForTrade();
  assert.ok(q, `the sell fills (refusal: ${L.getRefusal()})`);
});

test('the phantom guard still holds on a reopened coin: a 2.4x price over an old mark needs a witness', async () => {
  const L = reopened(17_000, 40_800, 600_000);
  const q = await L.quoteForTrade();
  assert.equal(q, null, 'no witness, no fill (AMERICOIN: a 14x sell on a dust print)');
});

test('a mark from seconds ago keeps the tight aggregator band', async () => {
  const L = reopened(17_000, 24_000, 5_000);
  const q = await L.quoteForTrade();
  assert.equal(q, null, 'a 1.4x gap against fresh evidence is lag until a witness says otherwise');
});
