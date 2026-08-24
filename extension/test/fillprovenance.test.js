/* F-57 — a lagging aggregator quote must not masquerade as the screen.
 *
 * Field report (8/22): "higher entry without wicks or anything. just filled me
 * at 35k while the coin is moving around 25k" — a 1.4x WORSE entry on a chart
 * that never printed that level.
 *
 * Two independent holes produced it, and both are covered here.
 *
 * 1. PROVENANCE. The F-52 fast path returned the on-screen snapshot whenever
 *    `atClickAge` was under 600ms — and that age derives from `lastPriceAt`,
 *    which the poll loop and requote() ALSO stamp when they adopt a resolver
 *    price into token.priceNative. So an aggregator quote that landed inside
 *    the window was handed back as "the price the trader is looking at": the
 *    ladder was skipped and the chain was never asked. The evidence stream
 *    (F-47) had refused to read that same field for exactly this reason; the
 *    fast path was reading it anyway.
 *
 * 2. BAND. The witness only wakes past FILL_WITNESS_RATIO (2x), a width
 *    calibrated for a live feed where memecoins genuinely 4x between reads.
 *    1.4x sat under it, so nothing examined the candidate at all. And the
 *    witness for a non-'action-resolver' candidate was R.refresh() — the
 *    aggregator — so a lagging read got to confirm itself.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

global.window = global.window || {};
const Q = require('../quote.js');

const ROOT = path.join(__dirname, '..');
const contentJs = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');

// The report's numbers as native prices at 1e9 supply, SOL≈$180.
const MINT = 'oUwiFakeF57RegressionMintxxxxxxxxxxxxxxpump';
const N_MARKET = 25_000 / 1e9 / 180;  // where the coin was actually moving
const N_LAGGED = 35_000 / 1e9 / 180;  // what he got filled at — 1.4x

/** Boot the shipped action-quote ladder. Mirrors quietscreen.test.js. */
function bootLadder(env) {
  const start = contentJs.indexOf('/* -------------------- action-time quotes and fills');
  const end = contentJs.indexOf('/* -------------------- fills --------------------');
  assert.ok(start !== -1 && end > start, 'the action-quote section must exist in content.js');
  const sandbox = {
    console: { debug: (...a) => env.debugLines.push(a.join(' ')) },
    Date, Promise, Set, Number, Boolean, Math, Infinity, JSON, setTimeout,
    Q,
    R: env.R,
    E: { fmt: (v) => String(v) },
    token: env.token,
    lastPriceAt: env.lastPriceAt,
    lastPageTickAt: env.lastPageTickAt !== undefined ? env.lastPageTickAt : env.lastPriceAt,
    pageQuoteSeq: 0,
    pageQuoteWaiters: new Set(),
    site: env.site || { id: 'axiom' },
  };
  const script = contentJs.slice(start, end) + '\n;({ quoteForTrade, pickQuoteForTrade,'
    + ' setEvidence: (v) => { lastAcceptedMarket = v; },'
    + ' getRefusal: () => lastQuoteRefusal });';
  return vm.runInNewContext(script, vm.createContext(sandbox), { filename: 'content.js#action-quotes' });
}

/** The token as the panel holds it after a resolver adoption overwrote the
 *  chart-fed price: token.priceNative IS the aggregator's number now. */
function adoptedToken() {
  return {
    mint: MINT,
    priceNative: N_LAGGED,
    priceUsd: N_LAGGED * 180,
    mcap: 35_000,
    priceSource: 'resolver',
    pending: false,
  };
}

function fakeResolver(overrides) {
  const calls = { onchain: 0, refresh: 0 };
  return {
    calls,
    onchainQuote: async () => { calls.onchain += 1; return overrides.observation || null; },
    refresh: async () => { calls.refresh += 1; return overrides.refreshResult || null; },
  };
}

/* ---------------------------------------------------------------- pure band */

test('F-57: at 1.4x, an aggregator candidate needs a witness and a live feed does not', () => {
  // The exact divergence in the report, judged both ways.
  assert.equal(Q.needsFillWitness(N_LAGGED, N_MARKET, 1_000, 'resolver'), true,
    '35k against a 25k market is a lagging aggregator read, and must be challenged');
  assert.equal(Q.needsFillWitness(N_LAGGED, N_MARKET, 1_000, 'action-resolver'), true,
    'the action-time aggregator quote answers to the same band');
  assert.equal(Q.needsFillWitness(N_LAGGED, N_MARKET, 1_000, 'jupiter'), true);
  assert.equal(Q.needsFillWitness(N_LAGGED, N_MARKET, 1_000, 'gmgn'), true);
  assert.equal(Q.needsFillWitness(N_LAGGED, N_MARKET, 1_000, 'pumpfun'), true);

  // A live feed keeps the wide band: real memecoin moves are violent, and
  // refusing them would be its own defect.
  assert.equal(Q.needsFillWitness(N_LAGGED, N_MARKET, 1_000, 'page-feed'), false,
    'the page feed keeps the 2x window it was calibrated for');
  assert.equal(Q.needsFillWitness(N_LAGGED, N_MARKET, 1_000, 'padre-chart-bar'), false);
  assert.equal(Q.needsFillWitness(N_LAGGED, N_MARKET, 1_000, 'onchain'), false,
    'the chain read answers to onchainContradictsEvidence, not to this band');
});

test('F-57: the source argument is optional and defaults to the old, wider band', () => {
  assert.equal(Q.needsFillWitness(N_LAGGED, N_MARKET, 1_000), false,
    'omitting the source must reproduce pre-F-57 behavior exactly');
  assert.equal(Q.needsFillWitness(N_LAGGED, N_MARKET, 1_000, undefined), false);
  assert.equal(Q.needsFillWitness(N_LAGGED, N_MARKET, 1_000, null), false);
});

test('F-57: the tight band is tight enough to catch lag and loose enough to pass drift', () => {
  assert.ok(Q.AGGREGATOR_WITNESS_RATIO > Q.ONSCREEN_AGREE_RATIO,
    'it must not be stricter than the band that calls two sources the same market');
  assert.ok(Q.AGGREGATOR_WITNESS_RATIO < Q.FILL_WITNESS_RATIO,
    'and it must be strictly tighter than the live-feed window, or it changes nothing');

  // Ordinary aggregator drift still fills without paying a round trip.
  assert.equal(Q.needsFillWitness(N_MARKET * 1.05, N_MARKET, 1_000, 'resolver'), false,
    '5% apart is two honest reads of one market');
  assert.equal(Q.needsFillWitness(N_MARKET * 1.12, N_MARKET, 1_000, 'resolver'), false,
    '12% is still inside the band — the guard must not fire on every quote');
  assert.equal(Q.needsFillWitness(N_MARKET * 1.2, N_MARKET, 1_000, 'resolver'), true,
    '20% apart is lag, not news');

  // Absent or aged-out evidence never invents a challenge.
  assert.equal(Q.needsFillWitness(N_LAGGED, 0, 1_000, 'resolver'), false);
  assert.equal(Q.needsFillWitness(N_LAGGED, N_MARKET, Q.FILL_WITNESS_WINDOW_MS + 1, 'resolver'), false,
    'evidence older than the window is not evidence');
});

test('F-57: source classification names the snapshot sources and nothing else', () => {
  ['resolver', 'action-resolver', 'jupiter', 'gmgn', 'pumpfun']
    .forEach((s) => assert.equal(Q.isAggregatorSource(s), true, s + ' is a periodic snapshot'));
  ['page-feed', 'onchain', 'chart-export', 'padre-chart-bar', 'unknown', '', null, undefined]
    .forEach((s) => assert.equal(Q.isAggregatorSource(s), false, String(s) + ' is not an aggregator'));
  assert.equal(Q.witnessRatioFor('resolver'), Q.AGGREGATOR_WITNESS_RATIO);
  assert.equal(Q.witnessRatioFor('page-feed'), Q.FILL_WITNESS_RATIO);
});

/* ------------------------------------------------------------ the ladder */

test('F-57: the 35k fill — an adopted aggregator price cannot ride the fresh-screen path', async () => {
  const debugLines = [];
  const now = Date.now();
  // A chain read that agrees with the market the trader is watching.
  const R = fakeResolver({
    observation: { mint: MINT, priceNative: N_MARKET, observedAt: now, slot: 11 },
  });
  // The shape of the defect: token.priceNative was written 100ms ago — by a
  // RESOLVER adoption. The page's own feed last ticked 4 seconds ago.
  const ladder = bootLadder({
    token: adoptedToken(),
    lastPriceAt: now - 100,
    lastPageTickAt: now - 4_000,
    R,
    debugLines,
  });
  ladder.setEvidence({ priceNative: N_MARKET, at: now - 4_000 });

  const q = await ladder.quoteForTrade();
  assert.ok(q, 'the fill must not be refused — the chain knows the real price');
  assert.ok(Math.abs(q.priceNative - N_MARKET) / N_MARKET < 1e-9,
    `the fill must land at the ~25k the coin is trading at, not the adopted 35k (got ${q.priceNative})`);
  assert.equal(R.calls.onchain > 0, true,
    'the chain round trip must actually be paid — skipping it was the bug');
});

test('F-57: a genuine page tick still takes the fast path and pays nothing', async () => {
  const debugLines = [];
  const now = Date.now();
  const R = fakeResolver({
    observation: { mint: MINT, priceNative: N_LAGGED, observedAt: now, slot: 12 },
  });
  // Same freshness, honest provenance: the page feed is what moved.
  const ladder = bootLadder({
    token: {
      mint: MINT, priceNative: N_MARKET, priceUsd: N_MARKET * 180,
      mcap: 25_000, priceSource: 'padre-chart-bar', pending: false,
    },
    lastPriceAt: now - 100,
    lastPageTickAt: now - 100,
    R,
    debugLines,
  });
  ladder.setEvidence({ priceNative: N_MARKET, at: now - 100 });

  const q = await ladder.quoteForTrade();
  assert.ok(q, 'the fill must not be refused');
  assert.ok(Math.abs(q.priceNative - N_MARKET) / N_MARKET < 1e-9,
    'the number on screen at click time is still the entry (F-52 must survive F-57)');
  assert.equal(R.calls.onchain, 0,
    'a fresh page tick must not pay the chain round trip — that is what F-52 bought');
});

test('F-57: an aggregator candidate is witnessed by the chain, not by the aggregator again', async () => {
  const debugLines = [];
  const now = Date.now();
  // The residual path: the page feed is quiet, the chain has nothing to say,
  // and the ladder falls back to the adopted snapshot — whose source is
  // 'resolver' and whose value is the lagging 35k.
  //
  // This is what makes the witness-independence change load-bearing. The old
  // code named ONE aggregator source ('action-resolver') and sent everything
  // else to R.refresh() — the aggregator. So this candidate was handed to the
  // very service that served it, which of course agreed, and the 35k fill
  // went through wearing a witness's blessing. The chain is the independent
  // source here; it declines to vouch, so the fill is refused.
  const R = fakeResolver({
    observation: null,   // chain silent — no witness available
    refreshResult: { mint: MINT, priceNative: N_LAGGED, priceUsd: N_LAGGED * 180, mcap: 35_000 },
  });
  const ladder = bootLadder({
    token: adoptedToken(),
    lastPriceAt: now - 200,        // inside ACTION_QUOTE_MAX_AGE_MS (350ms)
    lastPageTickAt: now - 4_000,   // but the page feed has been quiet
    R,
    debugLines,
  });
  ladder.setEvidence({ priceNative: N_MARKET, at: now - 2_000 });

  const q = await ladder.quoteForTrade();
  assert.equal(q, null,
    'no independent witness for a 1.4x divergence means no fill — a refused click is re-clickable');
  assert.match(ladder.getRefusal() || '', /Price sources disagree/,
    'and the refusal must say so out loud rather than failing silently');
  assert.ok(debugLines.some((l) => l.includes('fill witness refused')),
    'the refusal leaves a console trail');
  assert.equal(R.calls.refresh, 0,
    'the aggregator must never be asked to vouch for the aggregator');
});

test('F-57: a corroborated aggregator move still fills at the moved level', async () => {
  const debugLines = [];
  const now = Date.now();
  // The market really did run to 35k, and the chain says so too.
  const R = fakeResolver({
    observation: { mint: MINT, priceNative: N_LAGGED * 0.99, observedAt: now, slot: 13 },
    refreshResult: { mint: MINT, priceNative: N_LAGGED, priceUsd: N_LAGGED * 180, mcap: 35_000 },
  });
  const ladder = bootLadder({
    token: adoptedToken(),
    lastPriceAt: now - 4_000,
    lastPageTickAt: now - 4_000,
    R,
    debugLines,
  });
  ladder.setEvidence({ priceNative: N_MARKET, at: now - 2_000 });

  const q = await ladder.quoteForTrade();
  assert.ok(q, 'a real move confirmed by an independent source must fill — the guard must not over-reach');
  assert.ok(q.priceNative > N_MARKET * 1.3,
    `the fill must land at the MOVED level, not be dragged back to the old evidence (got ${q.priceNative})`);
});

/* ----------------------------------------------------------- the plumbing */

test('F-57: only the page feed stamps lastPageTickAt, and a token change clears it', () => {
  const writes = contentJs.match(/^\s*lastPageTickAt = .*$/gm) || [];
  assert.equal(writes.length, 2,
    'exactly two writes: the accepted page tick, and the per-token reset — no more');
  assert.match(contentJs, /lastPriceAt = Date\.now\(\);\s*\n\s*\/\/[^\n]*\n\s*lastPageTickAt = lastPriceAt;\s*\n\s*pageQuoteSeq \+= 1;/,
    'the stamp belongs to handlePageTick, beside the page-quote sequence it already bumps');
  assert.match(contentJs, /lastPriceAt = 0;\s*\n\s*lastPageTickAt = 0;/,
    'a new token clears it alongside lastPriceAt, or the previous coin vouches for this one');

  // Neither resolver adoption may stamp it. Both live in blocks that set
  // priceSource to the resolver and then re-stamp lastPriceAt.
  const adoptions = contentJs.match(/token\.priceSource = [^\n]*resolver'[\s\S]{0,400}?lastPriceAt = Date\.now\(\);/g) || [];
  assert.ok(adoptions.length >= 2, 'both resolver adoption sites must still be found by this test');
  adoptions.forEach((block, i) => {
    assert.ok(!/lastPageTickAt/.test(block),
      `resolver adoption ${i} must not claim the page feed ticked — that was the defect`);
  });
});
