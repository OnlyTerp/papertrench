/* Tests for the shipped quote logic (quote.js).
 *
 * These drive the real exported functions the extension loads in the browser —
 * nothing is re-implemented here, and expectations are computed from the
 * fixture inputs rather than pasted from a previous run.
 *
 * Fixtures are real Dexscreener responses captured from the live API, so the
 * payload shape under test is the shape production actually receives.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Q = require('../quote.js');

const FIX = path.join(__dirname, 'fixtures');
const tokensPayload = JSON.parse(fs.readFileSync(path.join(FIX, 'tokens-bonk.json'), 'utf8'));
const pairPayload = JSON.parse(fs.readFileSync(path.join(FIX, 'pair-bonk.json'), 'utf8'));

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1';
const WSOL = Q.WSOL_MINT;

function solPair(overrides = {}) {
  return {
    chainId: 'solana',
    pairAddress: 'Pair111111111111111111111111111111111111111',
    baseToken: { address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', symbol: 'BONK', name: 'Bonk' },
    quoteToken: { address: USDC, symbol: 'USDC', name: 'USD Coin' },
    priceNative: '0.000003112',
    priceUsd: '0.000003112',
    marketCap: 3112,
    liquidity: { usd: 1000000 },
    ...overrides,
  };
}

/* ---------------- criterion 1: identity + anchor quote ---------------- */

test('resolves identity and anchor quote from the /tokens payload shape', () => {
  const token = Q.tokenFromPayload(tokensPayload, 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');

  assert.ok(token, 'expected a resolved token record');
  assert.equal(typeof token.symbol, 'string');
  assert.ok(token.symbol.length > 0, 'symbol must be present');
  assert.ok(token.name && token.name.length > 0, 'name must be present');
  assert.ok(token.priceNative > 0, 'anchor price must be positive');

  // The symbol must be a real ticker, never a stand-in for the address.
  assert.notEqual(token.symbol, token.mint);
  assert.ok(!token.symbol.includes('…'), 'symbol must not be a truncated address');

  // Identity must match the fixture's own data, not a hardcoded literal.
  const expected = tokensPayload.pairs.find((p) => p.pairAddress === token.pairAddress);
  assert.ok(expected, 'selected pair must come from the payload');
  assert.equal(token.symbol, expected.baseToken.symbol);
  assert.equal(token.name, expected.baseToken.name);
  assert.equal(token.mint, expected.baseToken.address);
  assert.equal(token.priceNative, Number(expected.priceNative));
});

test('resolves identity from the single-pair payload shape', () => {
  const token = Q.tokenFromPayload(pairPayload, 'ignored-fallback');

  assert.ok(token, 'expected a resolved token record');
  assert.equal(token.symbol, pairPayload.pair.baseToken.symbol);
  assert.equal(token.mint, pairPayload.pair.baseToken.address);
  assert.equal(token.pairAddress, pairPayload.pair.pairAddress);
  assert.ok(token.priceNative > 0);
});

test('selects the deepest-liquidity solana pair when several are present', () => {
  const solana = tokensPayload.pairs.filter(
    (p) => p.chainId === 'solana' && Number(p.priceNative) > 0
  );
  assert.ok(solana.length > 1, 'fixture must contain multiple candidate pairs');

  // Compute the expected winner from the fixture itself.
  const deepest = solana.reduce((a, b) =>
    Number((b.liquidity || {}).usd || 0) > Number((a.liquidity || {}).usd || 0) ? b : a
  );

  // The fixture must not let "return the first pair" pass by coincidence,
  // otherwise this assertion proves nothing.
  assert.notEqual(
    solana[0].pairAddress,
    deepest.pairAddress,
    'fixture must order a non-deepest pair first for this test to be meaningful'
  );

  const picked = Q.pickBestPair(tokensPayload.pairs);
  assert.equal(picked.pairAddress, deepest.pairAddress);
});

test('ignores non-solana pairs and pairs without a usable price', () => {
  const mixed = {
    pairs: [
      { chainId: 'ethereum', priceNative: '999', liquidity: { usd: 1e12 }, baseToken: { symbol: 'ETH' } },
      { chainId: 'solana', priceNative: '0', liquidity: { usd: 1e11 }, baseToken: { symbol: 'ZERO' } },
      {
        chainId: 'solana', priceNative: '0.5', liquidity: { usd: 10 }, pairAddress: 'good',
        baseToken: { address: 'MintGood', symbol: 'GOOD', name: 'Good Token' },
        quoteToken: { address: WSOL, symbol: 'SOL', name: 'Wrapped SOL' },
      },
    ],
  };
  const token = Q.tokenFromPayload(mixed, 'fallback');
  assert.equal(token.symbol, 'GOOD');
  assert.equal(token.priceNative, 0.5);
});

test('returns null when no usable pair exists', () => {
  assert.equal(Q.tokenFromPayload({ pairs: [] }, 'x'), null);
  assert.equal(Q.tokenFromPayload(null, 'x'), null);
});

test('converts a USDC-quoted Solana pair through SOL/USD and records the rate', () => {
  const rec = Q.normalizePair(solPair(), solPair().baseToken.address, { solUsd: 102 });
  assert.ok(rec);
  assert.ok(Math.abs(rec.priceNative - 0.000003112 / 102) < 1e-18);
  assert.equal(rec.solUsdAtResolve, 102);
});

test('refuses a non-SOL-quoted Solana pair without a SOL/USD rate', () => {
  assert.equal(Q.normalizePair(solPair(), solPair().baseToken.address), null);
  assert.equal(Q.normalizePair(solPair(), solPair().baseToken.address, { solUsd: 0 }), null);
});

test('token payload falls back to a shallower WSOL pool when the deeper pool needs a missing rate', () => {
  const mint = solPair().baseToken.address;
  const usdc = solPair({ liquidity: { usd: 1000000 } });
  const wsol = solPair({
    pairAddress: 'WsolPair1111111111111111111111111111111111111',
    quoteToken: { address: WSOL, symbol: 'SOL', name: 'Wrapped SOL' },
    priceNative: '0.00000003112',
    liquidity: { usd: 500000 },
  });
  const token = Q.tokenFromPayload({ pairs: [wsol, usdc] }, mint);
  assert.ok(token);
  assert.equal(token.pairAddress, wsol.pairAddress);
  assert.equal(token.priceNative, Number(wsol.priceNative));
});

test('token payload keeps the deepest USDC pool when its conversion rate is available', () => {
  const mint = solPair().baseToken.address;
  const usdc = solPair({ liquidity: { usd: 1000000 } });
  const wsol = solPair({
    pairAddress: 'WsolPair1111111111111111111111111111111111111',
    quoteToken: { address: WSOL, symbol: 'SOL', name: 'Wrapped SOL' },
    priceNative: '0.00000003112',
    liquidity: { usd: 500000 },
  });
  const token = Q.tokenFromPayload({ pairs: [wsol, usdc] }, mint, { solUsd: 102 });
  assert.ok(token);
  assert.equal(token.pairAddress, usdc.pairAddress);
  assert.ok(Math.abs(token.priceNative - Number(usdc.priceUsd) / 102) < 1e-18);
});

test('token payload with only a USDC pool refuses without a conversion rate', () => {
  const mint = solPair().baseToken.address;
  assert.equal(Q.tokenFromPayload({ pairs: [solPair()] }, mint), null);
});

test('token payload ranks a deep pool ahead of malformed liquidity', () => {
  const mint = solPair().baseToken.address;
  const shallow = solPair({
    pairAddress: 'ShallowPair111111111111111111111111111111111111',
    quoteToken: { address: WSOL, symbol: 'SOL', name: 'Wrapped SOL' },
    priceNative: '0.00000001',
    liquidity: { usd: 100 },
  });
  const malformed = solPair({
    pairAddress: 'MalformedPair1111111111111111111111111111111111',
    quoteToken: { address: WSOL, symbol: 'SOL', name: 'Wrapped SOL' },
    priceNative: '0.00000002',
    liquidity: { usd: 'not-a-number' },
  });
  const deep = solPair({
    pairAddress: 'DeepPair11111111111111111111111111111111111111',
    quoteToken: { address: WSOL, symbol: 'SOL', name: 'Wrapped SOL' },
    priceNative: '0.00000003',
    liquidity: { usd: 10000 },
  });
  const token = Q.tokenFromPayload({ pairs: [shallow, malformed, deep] }, mint);
  assert.equal(token.pairAddress, deep.pairAddress);
});

test('requested-as-quote identity still selects a WSOL-base pair', () => {
  const mint = solPair().baseToken.address;
  const pair = solPair({
    baseToken: { address: WSOL, symbol: 'SOL', name: 'Wrapped SOL' },
    quoteToken: { address: mint, symbol: 'BONK', name: 'Bonk' },
    priceNative: '800000',
  });
  const token = Q.tokenFromPayload({ pairs: [pair] }, mint);
  assert.ok(token);
  assert.equal(token.mint, mint);
  assert.equal(token.priceNative, 1 / 800000);
});

test('keeps WSOL-quoted Solana normalization unchanged for either requested side', () => {
  const baseRequested = solPair({
    baseToken: { address: solPair().baseToken.address, symbol: 'BONK', name: 'Bonk' },
    quoteToken: { address: WSOL, symbol: 'SOL', name: 'Wrapped SOL' },
    priceNative: '0.00000125',
    priceUsd: '0.00025',
  });
  const quoteRequested = solPair({
    baseToken: { address: WSOL, symbol: 'SOL', name: 'Wrapped SOL' },
    quoteToken: { address: solPair().baseToken.address, symbol: 'BONK', name: 'Bonk' },
    priceNative: '800000',
    priceUsd: '0.00025',
  });

  const base = Q.normalizePair(baseRequested, baseRequested.baseToken.address);
  const quote = Q.normalizePair(quoteRequested, quoteRequested.quoteToken.address);
  assert.equal(base.priceNative, 0.00000125);
  assert.equal(base.solUsdAtResolve, null);
  assert.equal(quote.priceNative, 1 / 800000);
  assert.equal(quote.solUsdAtResolve, null);
});

test('converts a USDC-quoted Solana pair in the batch path', () => {
  const mint = solPair().baseToken.address;
  const out = Q.pricesFromBatch({ pairs: [solPair()] }, { solUsd: 102 });
  assert.ok(out[mint]);
  assert.ok(Math.abs(out[mint].priceNative - 0.000003112 / 102) < 1e-18);
  assert.equal(out[mint].solUsdAtResolve, 102);
});

test('batch pricing falls back to a shallower WSOL pool without a rate', () => {
  const mint = solPair().baseToken.address;
  const usdc = solPair({ liquidity: { usd: 1000000 } });
  const wsol = solPair({
    pairAddress: 'WsolPair1111111111111111111111111111111111111',
    quoteToken: { address: WSOL, symbol: 'SOL', name: 'Wrapped SOL' },
    priceNative: '0.00000003112',
    liquidity: { usd: 500000 },
  });
  const out = Q.pricesFromBatch({ pairs: [wsol, usdc] });
  assert.equal(out[mint].pairAddress, wsol.pairAddress);
});

test('batch pricing keeps the deepest USDC pool when its rate is available', () => {
  const mint = solPair().baseToken.address;
  const usdc = solPair({ liquidity: { usd: 1000000 } });
  const wsol = solPair({
    pairAddress: 'WsolPair1111111111111111111111111111111111111',
    quoteToken: { address: WSOL, symbol: 'SOL', name: 'Wrapped SOL' },
    priceNative: '0.00000003112',
    liquidity: { usd: 500000 },
  });
  const out = Q.pricesFromBatch({ pairs: [wsol, usdc] }, { solUsd: 102 });
  assert.equal(out[mint].pairAddress, usdc.pairAddress);
  assert.ok(Math.abs(out[mint].priceNative - Number(usdc.priceUsd) / 102) < 1e-18);
});

test('batch pricing with only a USDC pool refuses without a conversion rate', () => {
  const mint = solPair().baseToken.address;
  assert.deepEqual(Q.pricesFromBatch({ pairs: [solPair()] }), {});
});

test('batch pricing ranks a deep pool ahead of malformed liquidity', () => {
  const mint = solPair().baseToken.address;
  const shallow = solPair({
    pairAddress: 'ShallowPair111111111111111111111111111111111111',
    quoteToken: { address: WSOL, symbol: 'SOL', name: 'Wrapped SOL' },
    priceNative: '0.00000001',
    liquidity: { usd: 100 },
  });
  const malformed = solPair({
    pairAddress: 'MalformedPair1111111111111111111111111111111111',
    quoteToken: { address: WSOL, symbol: 'SOL', name: 'Wrapped SOL' },
    priceNative: '0.00000002',
    liquidity: { usd: 'not-a-number' },
  });
  const deep = solPair({
    pairAddress: 'DeepPair11111111111111111111111111111111111111',
    quoteToken: { address: WSOL, symbol: 'SOL', name: 'Wrapped SOL' },
    priceNative: '0.00000003',
    liquidity: { usd: 10000 },
  });
  const out = Q.pricesFromBatch({ pairs: [shallow, malformed, deep] });
  assert.equal(out[mint].pairAddress, deep.pairAddress);
});

test('BONK USDC pricing keeps the SOL mark near the booked entry', () => {
  const mint = solPair().baseToken.address;
  const rec = Q.normalizePair(solPair(), mint, { solUsd: 102 });
  const mark = Q.positionMark({ qty: 1, costSol: rec.priceNative }, rec.priceNative, rec.priceUsd);
  assert.ok(mark);
  assert.equal(mark.valueSol, rec.priceNative);
  assert.ok(Math.abs(mark.pnlSol) < 1e-18);
  assert.ok(rec.priceNative < 0.000003112 / 100,
    'the USD-denominated raw price must not be used as SOL');
});

/* ---------------- criterion 2: tick validation ---------------- */

// Anchor built from the real fixture, so the magnitudes under test are real.
function anchor() {
  return Q.tokenFromPayload(tokensPayload, 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
}

test('accepts a page tick consistent with the anchor and adopts its price', () => {
  const a = anchor();
  const moved = a.priceNative * 1.35; // a plausible intra-session move

  const verdict = Q.validateTick(a, { candidates: [{ value: moved, unit: 'native' }] });

  assert.equal(verdict.accepted, true, 'in-band tick must be accepted');
  assert.equal(verdict.priceNative, moved, 'accepted tick must become the price');
});

test('rejects the bogus 0.44 SOL tick and leaves the trusted price unchanged', () => {
  const a = anchor();
  // This is the exact defect observed in the shipped build: a ~3.9e-8 SOL token
  // displaying 0.44 SOL scraped from an unrelated number on the page.
  assert.ok(a.priceNative < 1e-6, 'fixture anchor should be a sub-micro price');

  const verdict = Q.validateTick(a, { candidates: [{ value: 0.44, unit: 'native' }] });

  assert.equal(verdict.accepted, false, '0.44 SOL must be rejected');
  assert.equal(verdict.reason, 'out-of-band');
  assert.equal(verdict.priceNative, a.priceNative, 'previously trusted price must survive');
});

test('rejects a tick belonging to a different mint', () => {
  const a = anchor();
  const verdict = Q.validateTick(a, {
    mint: 'SomeOtherMintAddressThatIsNotOurs11111111',
    candidates: [{ value: a.priceNative, unit: 'native' }],
  });

  assert.equal(verdict.accepted, false);
  assert.equal(verdict.reason, 'mint-mismatch');
  assert.equal(verdict.priceNative, a.priceNative);
});

test('rejects ticks when there is no anchor to validate against', () => {
  const verdict = Q.validateTick(null, { candidates: [{ value: 0.44, unit: 'native' }] });
  assert.equal(verdict.accepted, false);
  assert.equal(verdict.reason, 'no-anchor');
  assert.equal(verdict.priceNative, null);
});

test('rejects an empty candidate list', () => {
  const verdict = Q.validateTick(anchor(), { candidates: [] });
  assert.equal(verdict.accepted, false);
  assert.equal(verdict.reason, 'no-candidates');
});

test('a USD-only live tick immediately moves the SOL price by the same ratio', () => {
  const a = anchor();
  assert.ok(a.priceUsd > 0, 'fixture should carry a usd price');
  const verdict = Q.validateTick(a, { candidates: [{ value: a.priceUsd * 1.1, unit: 'usd' }] });

  assert.equal(verdict.accepted, true);
  assert.equal(verdict.basis, 'usd');
  assert.ok(Math.abs(verdict.priceNative - a.priceNative * 1.1) / a.priceNative < 1e-12,
    'USD ticks must update SOL P&L instead of leaving the native price frozen');
});

test('a Padre market-cap chart tick derives the live token price instantly', () => {
  const a = anchor();
  assert.ok(a.mcap > 0, 'fixture should carry a market cap anchor');
  const verdict = Q.validateTick(a, { candidates: [], mcap: a.mcap * 1.25, source: 'padre-chart-bar' });

  assert.equal(verdict.accepted, true);
  assert.equal(verdict.basis, 'mcap');
  assert.ok(Math.abs(verdict.priceNative - a.priceNative * 1.25) / a.priceNative < 1e-12);
  assert.equal(verdict.mcap, a.mcap * 1.25);
});

test('a SOL-denominated market-cap chart tick is accepted and converted', () => {
  // Axiom's USD/SOL toggle in MC mode plots the cap in SOL. That value
  // matches neither the USD price band nor the USD market-cap band, and was
  // previously rejected — freezing the price (and the P&L) on SOL-MC charts.
  const a = anchor();
  assert.ok(a.mcap > 0 && a.priceUsd > 0);
  const solMcap = a.mcap * (a.priceNative / a.priceUsd);
  const moved = solMcap * 1.1;

  const verdict = Q.validateTick(a, {
    candidates: [{ value: moved, unit: 'unknown' }],
    mcap: moved,
    source: 'padre-chart-bar',
  });

  assert.equal(verdict.accepted, true, 'SOL market-cap ticks must validate');
  assert.equal(verdict.basis, 'native-mcap');
  assert.ok(Math.abs(verdict.priceNative - a.priceNative * 1.1) / a.priceNative < 1e-12,
    'the SOL price must move by the chart ratio');
  assert.ok(Math.abs(verdict.mcap - a.mcap * 1.1) / a.mcap < 1e-12,
    'the USD market cap must move by the same ratio');
});

test('a price-only tick moves the market cap by the same ratio', () => {
  // Supply is constant tick to tick, so the headline market cap must follow
  // every accepted price move. Before this, a live trade feed (GMGN
  // token_activity) updated the price while the displayed cap stayed frozen
  // at the last resolver quote.
  const a = anchor();
  assert.ok(a.mcap > 0, 'fixture should carry a market cap anchor');

  const native = Q.validateTick(a, { candidates: [{ value: a.priceNative * 1.2, unit: 'native' }] });
  assert.equal(native.accepted, true);
  assert.ok(Math.abs(native.mcap - a.mcap * 1.2) / a.mcap < 1e-12,
    'a native price move must scale the market cap');

  const usd = Q.validateTick(a, { candidates: [{ value: a.priceUsd * 0.9, unit: 'usd' }] });
  assert.equal(usd.accepted, true);
  assert.ok(Math.abs(usd.mcap - a.mcap * 0.9) / a.mcap < 1e-12,
    'a USD-only trade tick must scale the market cap too');
});

test('band edges: just-inside is accepted, just-outside is rejected', () => {
  const a = anchor();
  const ratio = Q.ACCEPT_RATIO;

  const inside = Q.validateTick(a, {
    candidates: [{ value: a.priceNative * (ratio * 0.9), unit: 'native' }],
  });
  assert.equal(inside.accepted, true, 'inside the band must be accepted');

  const outside = Q.validateTick(a, {
    candidates: [{ value: a.priceNative * (ratio * 1.1), unit: 'native' }],
  });
  assert.equal(outside.accepted, false, 'outside the band must be rejected');

  // Symmetric on the downside.
  const belowOutside = Q.validateTick(a, {
    candidates: [{ value: a.priceNative / (ratio * 1.1), unit: 'native' }],
  });
  assert.equal(belowOutside.accepted, false, 'band must be symmetric');
});

/* ---------------- bootstrap from an on-screen price ---------------- */

const SOL_USD = 200;

function pendingToken() {
  return { mint: '3PTQpne3b7kjJEvDYDMBHSuRjTDUh6HSin2xMyW3pump', pending: true };
}

test('a pending token boots from a tiny chart close treated as native SOL', () => {
  const v = 1.05e-8; // native SOL price
  const verdict = Q.bootstrapTick(pendingToken(), {
    source: 'chart-export',
    candidates: [{ value: v, unit: 'unknown', key: 'chartExportClose' }],
    mcap: v,
  }, SOL_USD);

  assert.equal(verdict.accepted, true, 'a tiny unknown close must bootstrap as native');
  assert.equal(verdict.priceNative, v);
  assert.equal(verdict.priceUsd, v * SOL_USD);
  assert.equal(verdict.basis, 'native');
});

test('a pending token boots from a USD chart close using the SOL rate', () => {
  const usd = 0.0000021;
  const verdict = Q.bootstrapTick(pendingToken(), {
    source: 'padre-chart-bar',
    candidates: [{ value: usd, unit: 'unknown', key: 'padreChartClose' }],
    mcap: usd,
  }, SOL_USD);

  assert.equal(verdict.accepted, true, 'a USD close must convert to native');
  assert.equal(verdict.priceUsd, usd);
  assert.ok(Math.abs(verdict.priceNative - usd / SOL_USD) < 1e-18);
  assert.equal(verdict.basis, 'usd');
});

test('a GMGN mint-tagged USD trade bootstraps without ambiguity', () => {
  const mint = pendingToken().mint;
  const usd = 0.000123;
  const verdict = Q.bootstrapTick(pendingToken(), {
    source: 'gmgn-ws-trade',
    mint,
    candidates: [{ value: usd, unit: 'usd', key: 'tokenActivityPriceUsd' }],
  }, SOL_USD);

  assert.equal(verdict.accepted, true);
  assert.equal(verdict.priceUsd, usd);
  assert.equal(verdict.priceNative, usd / SOL_USD);
  assert.equal(verdict.basis, 'ws-usd');
});

test('bootstrap refuses a USD price when the SOL rate is not yet available', () => {
  const usd = 0.0000021;
  const verdict = Q.bootstrapTick(pendingToken(), {
    source: 'chart-export',
    candidates: [{ value: usd, unit: 'unknown', key: 'chartExportClose' }],
    mcap: usd,
  }, 0);

  assert.equal(verdict.accepted, false);
  assert.equal(verdict.reason, 'no-sol-rate');
});

test('bootstrap refuses a market-cap-only tick because supply is unknown', () => {
  const verdict = Q.bootstrapTick(pendingToken(), {
    source: 'gmgn-mcap-candle',
    candidates: [],
    mcap: 1234567,
  }, SOL_USD);

  assert.equal(verdict.accepted, false);
  assert.equal(verdict.reason, 'mcap-only-no-supply');
});

test('bootstrap refuses an untrusted or mismatched source', () => {
  const other = 'SomeOtherMint11111111111111111111111111111';
  const own = pendingToken().mint;

  const mismatch = Q.bootstrapTick(pendingToken(), {
    source: 'gmgn-ws-trade',
    mint: other,
    candidates: [{ value: 0.0001, unit: 'usd' }],
  }, SOL_USD);
  assert.equal(mismatch.accepted, false, 'mint mismatch must be rejected');

  const stray = Q.bootstrapTick(pendingToken(), {
    source: 'ws',
    candidates: [{ value: 0.0001, unit: 'usd' }],
  }, SOL_USD);
  assert.equal(stray.accepted, false, 'untrusted generic source must be rejected');
});

/* ---- F-25: rate-aware unit disambiguation refuses instead of guessing ---- */

test('F-25: an unknown close plausible as BOTH units is refused, never guessed', () => {
  // 5e-7 at rate 200: read as USD it is a sane memecoin price (~$500 mcap
  // at 1e9 supply); read as native SOL it implies 1e-4 USD (~$100K mcap) —
  // also sane. The old heuristic hardcoded "assume USD", so a genuinely
  // SOL-denominated close here was divided by the rate a second time and
  // the first fill landed ~200x low. Honest absence beats that number.
  for (const v of [1e-7, 2e-7, 5e-7]) {
    const verdict = Q.bootstrapTick(pendingToken(), {
      source: 'chart-export',
      candidates: [{ value: v, unit: 'unknown', key: 'chartExportClose' }],
    }, SOL_USD);
    assert.equal(verdict.accepted, false, `ambiguous close ${v} must be refused`);
    assert.equal(verdict.reason, 'ambiguous-unit');
    assert.equal(verdict.priceNative, null, 'no price may be fabricated from a guess');
    assert.equal(verdict.priceUsd, null);
  }
});

test('F-25: just past the ambiguous band, a single sane reading is accepted', () => {
  // 6e-7 as native implies 1.2e-4 USD — outside the sane pre-index band —
  // so only the USD reading survives and the tick is unambiguous again.
  const v = 6e-7;
  const verdict = Q.bootstrapTick(pendingToken(), {
    source: 'chart-export',
    candidates: [{ value: v, unit: 'unknown', key: 'chartExportClose' }],
  }, SOL_USD);
  assert.equal(verdict.accepted, true, 'exactly one plausible reading must still bootstrap');
  assert.equal(verdict.basis, 'usd');
  assert.equal(verdict.priceUsd, v);
  assert.ok(Math.abs(verdict.priceNative - v / SOL_USD) < 1e-18);
});

test('F-25: an unknown close implausible under EITHER reading is refused', () => {
  // 0.5 read as USD is a $500M-mcap coin, read as native it is $100 per
  // token — neither is a coin still waiting for its first index.
  const verdict = Q.bootstrapTick(pendingToken(), {
    source: 'chart-export',
    candidates: [{ value: 0.5, unit: 'unknown', key: 'chartExportClose' }],
  }, SOL_USD);
  assert.equal(verdict.accepted, false);
  assert.equal(verdict.reason, 'implausible-unit');
});

test('F-25: with no rate the original magnitude heuristic is kept', () => {
  // Rate-awareness must not regress the rateless path: a tiny close still
  // bootstraps as native (without a fabricated USD side), and a mid-range
  // close still waits for the rate.
  const tiny = Q.bootstrapTick(pendingToken(), {
    source: 'chart-export',
    candidates: [{ value: 1.05e-8, unit: 'unknown', key: 'chartExportClose' }],
  }, 0);
  assert.equal(tiny.accepted, true);
  assert.equal(tiny.basis, 'native');
  assert.equal(tiny.priceUsd, null, 'no rate means no USD side may be invented');

  const mid = Q.bootstrapTick(pendingToken(), {
    source: 'chart-export',
    candidates: [{ value: 5e-7, unit: 'unknown', key: 'chartExportClose' }],
  }, 0);
  assert.equal(mid.accepted, false);
  assert.equal(mid.reason, 'no-sol-rate');
});

test('F-25: an explicit native price gains a rate-aware sanity floor', () => {
  // Declared-native dust (1e-11 SOL -> 2e-9 USD -> $2 mcap) is not a coin;
  // the old branch accepted anything under 1 SOL with no floor at all.
  const dust = Q.bootstrapTick(pendingToken(), {
    source: 'chart-export',
    candidates: [{ value: 1e-11, unit: 'native' }],
  }, SOL_USD);
  assert.equal(dust.accepted, false);
  assert.equal(dust.reason, 'native-implausible');

  // A sane declared-native price still bootstraps.
  const sane = Q.bootstrapTick(pendingToken(), {
    source: 'chart-export',
    candidates: [{ value: 1.05e-8, unit: 'native' }],
  }, SOL_USD);
  assert.equal(sane.accepted, true);
  assert.equal(sane.priceNative, 1.05e-8);

  // Without a rate there is nothing to judge against: behavior unchanged.
  const noRate = Q.bootstrapTick(pendingToken(), {
    source: 'chart-export',
    candidates: [{ value: 1e-11, unit: 'native' }],
  }, 0);
  assert.equal(noRate.accepted, true, 'the rateless declared-native path must be untouched');
});

test('the header switches from "waiting" to a price after bootstrap', () => {
  const token = { ...pendingToken(), priceNative: 1.05e-8, priceUsd: 1.05e-8 * SOL_USD };
  const h = Q.headerFields(token, { now: Date.now(), pendingSince: 0, lastPriceAt: Date.now() });

  assert.equal(h.pending, false);
  assert.equal(h.hasTrustedPrice, true);
  assert.doesNotMatch(h.priceText, /waiting for first quote/i, 'price must replace the waiting text');
  assert.match(h.priceText, /SOL/);
});

test('after bootstrap, later chart ticks refine the price like a normal anchor', () => {
  // A bootstrap token has a price but no Dexscreener anchor yet. The next
  // on-screen bar should still be validated against the bootstrap price.
  const native = 1.05e-8;
  const token = { ...pendingToken(), priceNative: native, priceUsd: native * SOL_USD };
  const moved = native * 1.3;

  const verdict = Q.validateTick(token, {
    source: 'chart-export',
    candidates: [{ value: moved, unit: 'unknown', key: 'chartExportClose' }],
    mcap: moved,
  });

  assert.equal(verdict.accepted, true);
  assert.ok(Math.abs(verdict.priceNative - moved) < 1e-18);
  assert.equal(verdict.basis, 'native');
});

/* ---------------- criterion 3: header fields ---------------- */

test('header shows the real name and the address as DISTINCT fields', () => {
  const token = anchor();
  const h = Q.headerFields(token);

  assert.equal(h.title, token.symbol, 'title must be the real ticker');
  assert.equal(h.address, Q.shortAddress(token.mint));
  assert.notEqual(h.title, h.address, 'name and address must not be the same field');
  assert.equal(h.titleIsAddress, false, 'title must never be the contract address');
  assert.equal(h.pending, false);
  assert.equal(h.hasTrustedPrice, true);
  // Traders quote memecoins by market cap, so that is the headline figure.
  assert.equal(h.priceIsMarketCap, true);
  assert.match(h.priceText, /^\$/, 'the headline reads as a market cap');
});

test('header reports an explicit pending state instead of a fabricated price', () => {
  const h = Q.headerFields({ mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', symbol: 'Bonk', priceNative: null });

  assert.equal(h.pending, true);
  assert.equal(h.hasTrustedPrice, false);
  assert.doesNotMatch(h.priceText, /\d/, 'pending header must contain no numeric price');
});

test('header with no token at all is a clean empty state', () => {
  const h = Q.headerFields(null);
  assert.equal(h.title, 'No token');
  assert.equal(h.address, '');
  assert.equal(h.pending, true);
});

test('header never substitutes the address when identity is unknown', () => {
  // D-41: the short mint (DezX…B263) IS shown now — it reads as identity,
  // not as the CA; the full address still never becomes the title.
  const h = Q.headerFields({ mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', symbol: null, name: null, priceNative: 1 });
  assert.equal(h.title, 'DezX…B263');
  assert.equal(h.titleIsAddress, false);
});

// D-41: a just-launched coin has no symbol yet — the SHORTENED mint is the
// identity (full CA never, dead-end "Unknown token" never). The title heals
// the moment a tick carries the symbol (content.js backfills token.symbol).
test('header shows the short mint for a symbol-less new launch', () => {
  const h = Q.headerFields({ mint: 'HMzvsEEmtzHhvZNw9uwbaG85HCTmFnkbhzUx16cy7ca3', symbol: null, name: null, priceNative: 0.000001 });
  assert.equal(h.title, 'HMzv…7ca3');
  assert.equal(h.titleIsAddress, false);
});

test('a resolved symbol always wins over the mint fallback', () => {
  const h = Q.headerFields({ mint: 'HMzvsEEmtzHhvZNw9uwbaG85HCTmFnkbhzUx16cy7ca3', symbol: 'CATE', name: null, priceNative: 1 });
  assert.equal(h.title, 'CATE');
});

/* ---------------- F-33 guard: chain fill vs on-screen price ---------------- */

test('fillSourcesAgree: sub-second drift passes, double-digit divergence fails', () => {
  // Genuine drift between a processed-commitment chain read and a live chart
  // tick is a few percent at the very worst inside 600ms.
  assert.equal(Q.fillSourcesAgree(1.00e-7, 1.00e-7), true, 'identical prices agree');
  assert.equal(Q.fillSourcesAgree(1.03e-7, 1.00e-7), true, '3% apart is the same market');
  assert.equal(Q.fillSourcesAgree(1.00e-7, 1.05e-7), true, '5% apart still agrees, either direction');

  // The reported failure: chain path filling ~13% under the on-screen chart.
  assert.equal(Q.fillSourcesAgree(0.885e-7, 1.00e-7), false,
    'a 13%-low chain read must NOT be allowed to fill silently');
  assert.equal(Q.fillSourcesAgree(1.2e-7, 1.00e-7), false, 'and 20% high fails the same way');

  // Nothing to compare -> no objection; the ladder decides on freshness alone.
  assert.equal(Q.fillSourcesAgree(0, 1e-7), true);
  assert.equal(Q.fillSourcesAgree(1e-7, null), true);
  assert.ok(Q.ONSCREEN_AGREE_RATIO > 1 && Q.ONSCREEN_AGREE_RATIO < 1.2,
    'the agreement band must stay tight — wide enough for real drift, far under a broken read');
});
/* ---------------- D-38 resolver venue layer ---------------- */

/* A fresh launch, minutes old: neither aggregator knows it, but the two
 * terminal quotation APIs (GMGN docs endpoint, pump.fun coin API) that
 * draw the very chart on screen already price it. */

const GMGN_PAYLOAD = {
  code: 0,
  data: {
    mint: '5oyPYDcR48bfFD3v8XTkorpTksSQWkUva4ELS4CxkqVLH',
    symbol: 'TEST',
    name: 'Test Coin',
    price: '0.00001234',
    marketCap: '1234000',
    liquidity: '30000',
  },
};

const PUMP_PAYLOAD = {
  mint: '5oyPYDcR48bfFD3v8XTkorpTksSQWkUva4ELS4CxkqVLH',
  symbol: 'PTEST',
  name: 'Pump Test',
  price: 0.00002,
  marketCap: 20000000,
  totalSupply: '999999999',
};

const ADDR_D38 = '5oyPYDcR48bfFD3v8XTkorpTksSQWkUva4ELS4CxkqVLH';

test('tokenFromGmgn turns a venue quotation into a SOL-priced record', () => {
  const rec = Q.tokenFromGmgn(GMGN_PAYLOAD, ADDR_D38, 200);
  assert.ok(rec, 'a sane GMGN quotation must normalize');
  assert.equal(rec.priceSource, 'gmgn');
  assert.equal(rec.symbol, 'TEST');
  assert.ok(Math.abs(rec.priceNative - 0.00001234 / 200) < 1e-15, 'priceNative = USD / SOL rate');
  assert.equal(rec.priceUsd, 0.00001234);
  assert.equal(rec.mcap, 1234000);
  assert.equal(rec.mint, ADDR_D38);
});

test('tokenFromGmgn prefers the { code, data } family but tolerates the flat one', () => {
  const flat = Q.tokenFromGmgn({ ...GMGN_PAYLOAD.data, market_cap: '1234000' }, ADDR_D38, 200);
  assert.ok(flat, 'flat (no wrapper) quotation normalizes too');
  assert.equal(flat.priceUsd, 0.00001234);
  const viaCap = Q.tokenFromGmgn({ data: { ...GMGN_PAYLOAD.data, marketCap: undefined, market_cap: '1234000' } }, ADDR_D38, 200);
  assert.equal(viaCap.mcap, 1234000, 'market_cap spelling accepted');
});

test('tokenFromPumpfun accepts the flat family with raw or whole supply', () => {
  const rec = Q.tokenFromPumpfun(PUMP_PAYLOAD, ADDR_D38, 200);
  assert.ok(rec, 'a sane pump.fun payload must normalize');
  assert.equal(rec.priceSource, 'pumpfun');
  assert.ok(Math.abs(rec.priceNative - 0.00002 / 200) < 1e-11, 'USD price / rate');
  // Raw supply with mint decimals (1e9 tokens x 1e6) still passes the
  // relative band check when the mcap says raw scale.
  const raw = Q.tokenFromPumpfun({ ...PUMP_PAYLOAD, totalSupply: '999999999000000', marketCap: 2e10 }, 'x', 200);
  assert.ok(raw, 'raw decimal-scaled supply must reference consistently');
});

test('venue quotes refuse what a venue cannot honestly claim', () => {
  assert.equal(Q.tokenFromGmgn(GMGN_PAYLOAD, ADDR_D38, 0), null, 'no SOL/USD rate refutes the fill');
  assert.equal(Q.tokenFromGmgn({ ...GMGN_PAYLOAD, data: { ...GMGN_PAYLOAD.data, price: '0' } }, ADDR_D38, 200), null, 'a zero price is not a price');
  assert.equal(Q.tokenFromGmgn({ ...GMGN_PAYLOAD, data: { ...GMGN_PAYLOAD.data, price: '1e9' } }, ADDR_D38, 200), null, 'an absurd price refutes');
  // Market cap that cannot match ANY sane supply: unit mixture, refused.
  assert.equal(Q.tokenFromGmgn({ ...GMGN_PAYLOAD, data: { ...GMGN_PAYLOAD.data, price: '250', marketCap: '0.5' } }, ADDR_D38, 200), null,
    'a $0.50 cap at $250/coin implies 0.002 supply — a unit mixture, not a quote');
  assert.equal(Q.tokenFromVenueQuote(null, ADDR_D38, 200, 'gmgn'), null, 'null payload refused');
  const noMcap = Q.tokenFromPumpfun({ ...PUMP_PAYLOAD, marketCap: 'bad' }, ADDR_D38, 200);
  assert.equal(noMcap && noMcap.mcap, null, 'unparsable mcap is surfaced absent, never fatal');
});