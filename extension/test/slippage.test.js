/* Constant-product (x*y=k) price impact — slippage.js + its engine wiring.
 *
 * TEST-STRENGTH RULE OBSERVED THROUGHOUT: every numeric expectation below was
 * computed BY HAND from the AMM formula (verified independently in exact
 * rational arithmetic), never by calling the function under test. A test that
 * mirrors the logic it checks cannot catch a regression in that logic.
 *
 * The reference pool used almost everywhere is deliberately round so the hand
 * arithmetic is checkable by eye:
 *
 *   baseReserve  = 1,000,000 tokens
 *   quoteReserve = 10 SOL
 *   k            = 10,000,000
 *   spotPrice    = 10 / 1,000,000 = 0.00001 SOL per token
 *
 * Buying 1 SOL (10% of the quote side) into it:
 *   tokensOut = 1,000,000 - 10,000,000/11 = 1,000,000 - 909,090.909… = 90,909.0909…
 *   avgPrice  = 1 / 90,909.0909… = 0.000011          (exactly 1.1 x spot)
 *   impact    = (0.000011/0.00001 - 1) * 100 = 10%   (exactly)
 *   endPrice  = 11 / 909,090.909… = 0.0000121        (exactly 1.21 x spot)
 *
 * That 10% is not a coincidence worth trusting blindly — it falls out of the
 * algebra: for a buy of q/10 into (b, q), avgPrice/spot = (q + q/10)/q = 1.1.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

// engine.js targets the browser; give it a window to install its global on.
global.window = global.window || {};
require('../slippage.js');
require('../engine.js');
const S = require('../slippage.js');
const E = global.window.PaperEngine;

/* The reference pool, and its hand-computed spot price. */
const POOL = { baseReserve: 1000000, quoteReserve: 10 };
const SPOT = 0.00001;

function freshSettings(over) {
  return Object.assign(E.defaultSettings(), {
    balanceStartSol: 1000, feeBps: 0, slippageBps: 0, gasSolPerTx: 0, tipSolPerTx: 0,
  }, over || {});
}

/* ---------------- module: the curve itself ---------------- */

test('slippage.js triple-exports its API on the browser global', () => {
  assert.equal(typeof global.window.PTSlippage, 'object');
  assert.equal(typeof S.quoteBuy, 'function');
  assert.equal(typeof S.quoteSell, 'function');
});

test('a tiny buy barely moves the price (impact well under 0.1%)', () => {
  // 0.001 SOL into a 10 SOL pool = 0.01% of the quote side.
  //   avgPrice/spot = (10 + 0.001)/10 = 1.0001  ->  impact = 0.01% exactly.
  //   tokensOut = 1,000,000 - 10,000,000/10.001 = 99.990000999900…
  const q = S.quoteBuy(Object.assign({ solIn: 0.001 }, POOL));
  assert.ok(q, 'a tiny buy into a healthy pool must quote');
  assert.ok(q.priceImpactPct < 0.1,
    `a 0.01%-of-pool buy must barely move price, got ${q.priceImpactPct}%`);
  assert.ok(Math.abs(q.priceImpactPct - 0.01) < 1e-9,
    `hand-computed impact is exactly 0.01%, got ${q.priceImpactPct}`);
  assert.ok(Math.abs(q.tokensOut - 99.9900009999) < 1e-6,
    `hand-computed tokensOut is 99.9900009999, got ${q.tokensOut}`);
  assert.ok(Math.abs(q.avgPrice - 0.000010001) < 1e-15,
    `hand-computed avgPrice is 0.000010001, got ${q.avgPrice}`);
});

test('a buy sized at 10% of the pool costs exactly the hand-computed 10% impact', () => {
  // Every literal here is derived in the file header, not from the function.
  const q = S.quoteBuy(Object.assign({ solIn: 1 }, POOL));
  assert.ok(q, 'a 1 SOL buy into a 10 SOL pool must quote');
  assert.ok(Math.abs(q.tokensOut - 90909.0909090909) < 1e-6,
    `hand-computed tokensOut is 90909.0909…, got ${q.tokensOut}`);
  assert.ok(Math.abs(q.avgPrice - 0.000011) < 1e-15,
    `hand-computed avgPrice is 0.000011, got ${q.avgPrice}`);
  assert.ok(Math.abs(q.priceImpactPct - 10) < 1e-9,
    `hand-computed impact is exactly 10%, got ${q.priceImpactPct}`);
  assert.ok(Math.abs(q.endPrice - 0.0000121) < 1e-15,
    `hand-computed endPrice is 0.0000121, got ${q.endPrice}`);
  // The defining property of a curve walk: you pay MORE than the pre-trade
  // tick and LESS than the post-trade tick.
  assert.ok(q.avgPrice > SPOT && q.avgPrice < q.endPrice,
    'avgPrice must sit strictly between spot and endPrice');
});

test('a sell sized at 10% of the pool returns the hand-computed negative impact', () => {
  // Selling 100,000 tokens (10% of the base side) into (1,000,000, 10):
  //   solOut   = 10 - 10,000,000/1,100,000 = 10 - 9.0909… = 0.909090909…
  //   avgPrice = 0.909090909…/100,000 = 0.00000909090909…
  //   impact   = (0.909090909…/1 - 1) * 100 = -9.090909…%
  //   endPrice = 9.0909…/1,100,000 = 0.0000082644628099…
  const q = S.quoteSell(Object.assign({ tokensIn: 100000 }, POOL));
  assert.ok(q, 'a 10%-of-base sell must quote');
  assert.ok(Math.abs(q.solOut - 0.9090909090909091) < 1e-12,
    `hand-computed solOut is 0.909090909…, got ${q.solOut}`);
  assert.ok(Math.abs(q.priceImpactPct - -9.090909090909092) < 1e-9,
    `hand-computed sell impact is -9.0909…%, got ${q.priceImpactPct}`);
  assert.ok(Math.abs(q.endPrice - 0.000008264462809917356) < 1e-18,
    `hand-computed endPrice is 8.2644628…e-6, got ${q.endPrice}`);
  assert.ok(q.avgPrice < SPOT, 'a seller must receive less than the tick');
});

test('an awkward, non-round pool prices to hand-computed literals too', () => {
  // Round numbers can hide an algebra slip that cancels. Pool (12345, 7.89),
  // buying 2.5:
  //   k         = 97,402.05
  //   tokensOut = 12345 - 97,402.05/10.39 = 2970.4042348411936…
  //   avgPrice  = 2.5/2970.4042348… = 0.00084163628999595…
  //   spot      = 7.89/12345 = 0.000639125151882543…
  //   impact    = 31.685678073510775…%
  const q = S.quoteBuy({ solIn: 2.5, baseReserve: 12345, quoteReserve: 7.89 });
  assert.ok(q, 'an odd pool must still quote');
  assert.ok(Math.abs(q.tokensOut - 2970.4042348411936) < 1e-9,
    `hand-computed tokensOut is 2970.40423484…, got ${q.tokensOut}`);
  assert.ok(Math.abs(q.priceImpactPct - 31.685678073510775) < 1e-9,
    `hand-computed impact is 31.6856780735…%, got ${q.priceImpactPct}`);
});

test('a trade larger than the pool is PRICED, never rejected, and never drains it', () => {
  // Documented rule (slippage.js "OVERSIZED TRADES"): the constant product
  // self-caps, so an oversized order returns a real, catastrophic fill rather
  // than Infinity, NaN, or a refusal. 1000 SOL into a 10 SOL pool:
  //   tokensOut = 1,000,000 - 10,000,000/1010 = 990,099.00990099…
  //   avgPrice  = 1000/990,099.0099… = 0.00101   (exactly 101 x spot)
  //   impact    = 10,000%   (exactly)
  const q = S.quoteBuy(Object.assign({ solIn: 1000 }, POOL));
  assert.ok(q, 'an oversized buy must return a fill, not null — the lesson is the point');
  assert.ok(Number.isFinite(q.tokensOut) && Number.isFinite(q.avgPrice),
    'an oversized buy must never produce Infinity or NaN');
  assert.ok(Math.abs(q.tokensOut - 990099.0099009901) < 1e-6,
    `hand-computed tokensOut is 990099.00990…, got ${q.tokensOut}`);
  assert.ok(Math.abs(q.priceImpactPct - 10000) < 1e-6,
    `hand-computed impact is exactly 10000%, got ${q.priceImpactPct}`);
  assert.ok(q.tokensOut < POOL.baseReserve,
    'the pool can be pushed arbitrarily far but NEVER drained');

  // Symmetric statement on the sell side: 100x the base reserve in.
  //   solOut = 10 - 10,000,000/101,000,000 = 9.900990099009901…
  const sq = S.quoteSell(Object.assign({ tokensIn: 100000000 }, POOL));
  assert.ok(sq, 'an oversized sell must return a fill too');
  assert.ok(Math.abs(sq.solOut - 9.900990099009901) < 1e-9,
    `hand-computed solOut is 9.90099009…, got ${sq.solOut}`);
  assert.ok(sq.solOut < POOL.quoteReserve,
    'a seller can never extract the whole quote side');
});

test('buy then immediately sell back LOSES money — the property that proves impact is real', () => {
  // Buy 1 SOL of the reference pool, then sell every token received straight
  // back into the SAME reserve snapshot. On a flat multiplier this round trip
  // is exactly break-even; on a real curve it cannot be.
  //   tokensOut = 90,909.0909…
  //   selling those back: solOut = 10 - 10,000,000/1,090,909.0909… = 0.8333333…
  //   loss = 1 - 0.833333… = 0.1666666… SOL (16.666…%)
  const bought = S.quoteBuy(Object.assign({ solIn: 1 }, POOL));
  const soldBack = S.quoteSell(Object.assign({ tokensIn: bought.tokensOut }, POOL));
  assert.ok(bought && soldBack);
  assert.ok(soldBack.solOut < 1,
    `a round trip must lose money, got ${soldBack.solOut} SOL back from 1 SOL`);
  assert.ok(Math.abs(soldBack.solOut - 0.8333333333333334) < 1e-12,
    `hand-computed round-trip return is 0.8333333…, got ${soldBack.solOut}`);
  assert.ok(Math.abs((1 - soldBack.solOut) - 0.16666666666666666) < 1e-12,
    `hand-computed round-trip loss is 0.1666666… SOL, got ${1 - soldBack.solOut}`);
});

test('every degenerate input returns the null invalid marker, never a plausible number', () => {
  const bad = [
    ['no argument at all', undefined],
    ['null', null],
    ['a number instead of an object', 7],
    ['empty object', {}],
    ['missing reserves', { solIn: 1 }],
    ['missing base side', { solIn: 1, quoteReserve: 10 }],
    ['missing quote side', { solIn: 1, baseReserve: 1000000 }],
    ['zero base reserve', { solIn: 1, baseReserve: 0, quoteReserve: 10 }],
    ['zero quote reserve', { solIn: 1, baseReserve: 1000000, quoteReserve: 0 }],
    ['negative base reserve', { solIn: 1, baseReserve: -1000000, quoteReserve: 10 }],
    ['negative quote reserve', { solIn: 1, baseReserve: 1000000, quoteReserve: -10 }],
    ['NaN base reserve', { solIn: 1, baseReserve: NaN, quoteReserve: 10 }],
    ['NaN quote reserve', { solIn: 1, baseReserve: 1000000, quoteReserve: NaN }],
    ['Infinite base reserve', { solIn: 1, baseReserve: Infinity, quoteReserve: 10 }],
    ['Infinite quote reserve', { solIn: 1, baseReserve: 1000000, quoteReserve: Infinity }],
    ['null reserves', { solIn: 1, baseReserve: null, quoteReserve: null }],
    ['undefined reserves', { solIn: 1, baseReserve: undefined, quoteReserve: undefined }],
    ['missing amount', Object.assign({}, POOL)],
    ['zero amount', Object.assign({ solIn: 0 }, POOL)],
    ['negative amount', Object.assign({ solIn: -1 }, POOL)],
    ['NaN amount', Object.assign({ solIn: NaN }, POOL)],
    ['Infinite amount', Object.assign({ solIn: Infinity }, POOL)],
  ];
  for (const [label, input] of bad) {
    assert.equal(S.quoteBuy(input), null, `quoteBuy must refuse: ${label}`);
    // Same case with the sell-side amount name, so both entry points are covered.
    const asSell = (input && typeof input === 'object')
      ? Object.assign({}, input, { tokensIn: input.solIn })
      : input;
    assert.equal(S.quoteSell(asSell), null, `quoteSell must refuse: ${label}`);
  }
  assert.equal(S.spotPrice({ baseReserve: 0, quoteReserve: 10 }), null,
    'spotPrice must refuse a dead pool too');
});

/* ---------------- engine wiring ---------------- */

test('engine buyPrice walks the curve when reserves are known', () => {
  const settings = freshSettings();
  // 1 SOL into the reference pool -> avgPrice/spot = 1.1, applied to the tick.
  const px = E.buyPrice(SPOT, settings, Object.assign({ solIn: 1 }, POOL));
  assert.ok(Math.abs(px - 0.000011) < 1e-15,
    `hand-computed curve buy price is 0.000011, got ${px}`);
  // And the whole point: a DIFFERENT size gets a DIFFERENT price.
  const tiny = E.buyPrice(SPOT, settings, Object.assign({ solIn: 0.001 }, POOL));
  assert.ok(Math.abs(tiny - 0.000010001) < 1e-15,
    `hand-computed tiny buy price is 0.000010001, got ${tiny}`);
  assert.ok(px > tiny, 'a bigger buy must fill WORSE than a smaller one');
});

test('engine sellPrice walks the curve when reserves are known', () => {
  const settings = freshSettings();
  // 100,000 tokens out -> avgPrice/spot = 0.909090909…, applied to the tick.
  const px = E.sellPrice(SPOT, settings, Object.assign({ tokensIn: 100000 }, POOL));
  assert.ok(Math.abs(px - 0.000009090909090909091) < 1e-18,
    `hand-computed curve sell price is 9.0909090909e-6, got ${px}`);
  const tiny = E.sellPrice(SPOT, settings, Object.assign({ tokensIn: 100 }, POOL));
  assert.ok(px < tiny, 'a bigger sell must fill WORSE than a smaller one');
});

test('engine falls back to the flat slippageBps when no reserves are available', () => {
  // The fallback is load-bearing: off-pump.fun venues, replays, and every
  // pre-existing caller have no pool to walk. slippageBps must still rule.
  const settings = freshSettings({ slippageBps: 200 }); // 2%
  assert.ok(Math.abs(E.buyPrice(SPOT, settings) - 0.0000102) < 1e-18,
    'no context at all must use the flat 2% cushion');
  assert.ok(Math.abs(E.buyPrice(SPOT, settings, { solIn: 1 }) - 0.0000102) < 1e-18,
    'a size with no reserves must use the flat cushion');
  assert.ok(Math.abs(E.buyPrice(SPOT, settings, Object.assign({}, POOL)) - 0.0000102) < 1e-18,
    'reserves with no size must use the flat cushion');
  assert.ok(Math.abs(E.sellPrice(SPOT, settings) - 0.0000098) < 1e-18,
    'the sell fallback must mirror it');
  // A half-known pool is not a pool.
  assert.ok(Math.abs(E.buyPrice(SPOT, settings, { solIn: 1, quoteReserve: 10 }) - 0.0000102) < 1e-18,
    'a pool missing one side must not be guessed at');
});

test('a real buy through the engine fills worse the bigger it is', () => {
  const settings = freshSettings();
  const order = (solAmount) => ({
    mint: 'MintSizeMattersAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    symbol: 'SIZE', site: 'test', ts: 1700000000000,
    priceNative: SPOT, solAmount,
    baseReserve: POOL.baseReserve, quoteReserve: POOL.quoteReserve,
  });

  const small = E.buy(E.defaultState(settings), settings, order(0.001));
  const large = E.buy(E.defaultState(settings), settings, order(1));

  // Hand-computed: with feeBps 0 the net SOL equals the gross, so these are
  // the same two prices asserted above.
  assert.ok(Math.abs(small.trade.priceNative - 0.000010001) < 1e-15,
    `hand-computed small fill is 0.000010001, got ${small.trade.priceNative}`);
  assert.ok(Math.abs(large.trade.priceNative - 0.000011) < 1e-15,
    `hand-computed large fill is 0.000011, got ${large.trade.priceNative}`);
  assert.ok(large.trade.priceNative > small.trade.priceNative,
    'THE BUG: a 1 SOL buy must not fill at the same price as a 0.001 SOL buy');

  // Tokens received per SOL spent must fall as size rises.
  const perSolSmall = small.trade.qty / 0.001;
  const perSolLarge = large.trade.qty / 1;
  assert.ok(perSolLarge < perSolSmall,
    'a bigger buy must receive fewer tokens per SOL');
});

test('a fee-free, gas-free engine round trip still LOSES money on the curve', () => {
  // Zero fees, zero gas, zero flat slippage, an unmoved price tick. Under the
  // old flat multiplier this round trip closed at exactly 0.00 SOL P&L. On a
  // real curve it must lose the hand-computed 0.1666666… SOL:
  //   buy  1 SOL at 0.000011      -> 90,909.0909… tokens
  //   sell 90,909.0909… tokens at 0.00000916666… -> 0.8333333… SOL
  const settings = freshSettings();
  const MINT = 'MintRoundTripBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
  let state = E.defaultState(settings);
  const cashBefore = state.cashSol;

  E.buy(state, settings, {
    mint: MINT, symbol: 'RT', site: 'test', ts: 1700000000000,
    priceNative: SPOT, solAmount: 1,
    baseReserve: POOL.baseReserve, quoteReserve: POOL.quoteReserve,
  });
  const sold = E.sell(state, settings, {
    mint: MINT, ts: 1700000001000, qtyFraction: 1,
    priceNative: SPOT,
    baseReserve: POOL.baseReserve, quoteReserve: POOL.quoteReserve,
  });

  assert.ok(Math.abs(sold.trade.priceNative - 0.000009166666666666666) < 1e-18,
    `hand-computed exit price is 9.16666…e-6, got ${sold.trade.priceNative}`);
  assert.ok(Math.abs(sold.trade.solNet - 0.8333333333333334) < 1e-9,
    `hand-computed proceeds are 0.8333333… SOL, got ${sold.trade.solNet}`);

  const roundTripPnl = state.cashSol - cashBefore;
  assert.ok(roundTripPnl < 0,
    `a curve round trip must lose money, got ${roundTripPnl} SOL`);
  assert.ok(Math.abs(roundTripPnl - -0.16666666666666666) < 1e-9,
    `hand-computed round-trip P&L is -0.1666666… SOL, got ${roundTripPnl}`);
});

test('with no reserves the engine round trip is still exactly break-even', () => {
  // Guards the fallback path in the other direction: the legacy behaviour that
  // every existing test depends on must be untouched when no pool is known.
  const settings = freshSettings();
  const MINT = 'MintLegacyPathCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
  let state = E.defaultState(settings);
  const cashBefore = state.cashSol;

  E.buy(state, settings, {
    mint: MINT, symbol: 'LG', site: 'test', ts: 1700000000000,
    priceNative: SPOT, solAmount: 1,
  });
  E.sell(state, settings, { mint: MINT, ts: 1700000001000, qtyFraction: 1, priceNative: SPOT });

  assert.ok(Math.abs((state.cashSol - cashBefore) - 0) < 1e-9,
    `with feeBps 0, slippageBps 0 and no pool, a flat round trip nets 0, got ${state.cashSol - cashBefore}`);
});

test('the curve is charged on SOL that reaches the pool, not on the fee skim', () => {
  // Fee first, curve second. With feeBps 1000 (10%), a 1 SOL order sends only
  // 0.9 SOL into the pool, so the fill must match a fee-free 0.9 SOL buy:
  //   avgPrice/spot = (10 + 0.9)/10 = 1.09  ->  px = 0.0000109
  const settings = freshSettings({ feeBps: 1000 });
  const res = E.buy(E.defaultState(settings), settings, {
    mint: 'MintFeeOrderDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD',
    symbol: 'FEE', site: 'test', ts: 1700000000000,
    priceNative: SPOT, solAmount: 1,
    baseReserve: POOL.baseReserve, quoteReserve: POOL.quoteReserve,
  });
  assert.ok(Math.abs(res.trade.priceNative - 0.0000109) < 1e-15,
    `hand-computed post-fee curve price is 0.0000109, got ${res.trade.priceNative}`);
});

test('reserves may also arrive nested under o.reserves', () => {
  const settings = freshSettings();
  const px = E.buyPrice(SPOT, settings, { solIn: 1, reserves: Object.assign({}, POOL) });
  assert.ok(Math.abs(px - 0.000011) < 1e-15,
    `nested reserves must price identically to flat ones, got ${px}`);
});
