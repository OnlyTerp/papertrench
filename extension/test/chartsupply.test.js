/* C-32 — the cap feed's supply convention is learned, not assumed.
 *
 * GMGN PONS, reproduced live on v3.23.4 and v3.25.0 (%TEMP%\pt-pons):
 * GMGN's mcap candles plot a ~1B-supply cap ($622M) while the resolver
 * anchor's cap is on ~684M circulating ($426M). validateTick's mcap basis
 * derived price as anchor x ratio, printing $0.91 against the market's
 * $0.622; interleaved token_activity USD ticks flipped it back — 78 outlier
 * samples in five minutes, and a buy at $0.6228 sold 3 s later at $0.9104
 * for +44% booked on a flat tape.
 *
 * Under test: calibrateChartSupply pairs a cap tick with the freshest
 * accepted direct price to learn the chart's own supply, and validateTick
 * converts caps through it. Without calibration the legacy ratio path is
 * unchanged.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const Q = require('../quote.js');

const NOW = 1_000_000;
// PONS-shaped anchor: resolver cap on ~684M supply, GMGN cap on ~1B.
const ANCHOR = {
  mint: '0x39dBED3a2bd333467115dE45665cC57F813C4571',
  chain: 'robinhood',
  priceNative: 0.0053494,
  priceUsd: 0.6228,
  mcap: 426_071_420,
};
const CHART_CAP = 622_811_520;   // GMGN's 1B-basis cap
const DIRECT = { priceUsd: 0.6228, at: NOW - 500 };

test('calibrateChartSupply learns the chart supply from a fresh direct price', () => {
  const state = Q.calibrateChartSupply(null, CHART_CAP, DIRECT, ANCHOR, NOW);
  assert.ok(state.supply > 0);
  assert.ok(Math.abs(state.supply - CHART_CAP / 0.6228) / (CHART_CAP / 0.6228) < 1e-9);
});

test('calibrateChartSupply ignores a stale direct price (>3 s)', () => {
  const state = Q.calibrateChartSupply(null, CHART_CAP, { priceUsd: 0.6228, at: NOW - 3001 }, ANCHOR, NOW);
  assert.equal(state.supply, null);
  assert.equal(state.samples.length, 0);
});

test('calibrateChartSupply ignores an implied supply outside the anchor band', () => {
  // implied = cap/price 100x off the anchor supply: a different unit, not a convention.
  const state = Q.calibrateChartSupply(null, CHART_CAP * 100, DIRECT, ANCHOR, NOW);
  assert.equal(state.samples.length, 0, 'out-of-band cap is not evidence');
  const anchorSupply = ANCHOR.mcap / ANCHOR.priceUsd;
  const wild = Q.calibrateChartSupply(null, CHART_CAP, { priceUsd: 0.6228 / 100, at: NOW }, ANCHOR, NOW);
  assert.equal(wild.samples.length, 0);
  assert.ok(anchorSupply > 0);
});

test('calibrateChartSupply keeps the median of the last 15 samples', () => {
  let state = null;
  const caps = [];
  for (let i = 0; i < 17; i++) caps.push(620e6 + i * 1e6);
  caps.push(900e6); // still inside 20x of anchor mcap
  caps.forEach((cap, i) => {
    state = Q.calibrateChartSupply(state, cap, { priceUsd: cap / 1e9, at: NOW + i * 100 }, ANCHOR, NOW + i * 100);
  });
  assert.equal(state.samples.length, 15, 'ring keeps the newest fifteen');
  const implied = caps.slice(-15).map((c) => c / (c / 1e9));
  const sorted = implied.slice().sort((x, y) => x - y);
  assert.equal(state.supply, sorted[sorted.length >> 1]);
});

test('calibrateChartSupply with no anchor cap learns nothing', () => {
  const state = Q.calibrateChartSupply(null, CHART_CAP, DIRECT, { ...ANCHOR, mcap: null }, NOW);
  assert.equal(state.supply, null);
});

test('validateTick: calibrated cap derives the price the chart actually plots', () => {
  const chartSupply = CHART_CAP / 0.6228; // ~1B — GMGN's convention
  const verdict = Q.validateTick(ANCHOR, { mint: ANCHOR.mint, mcap: CHART_CAP, candidates: [] }, { chartSupply });
  assert.equal(verdict.accepted, true);
  assert.equal(verdict.basis, 'mcap');
  assert.ok(Math.abs(verdict.priceUsd - 0.6228) / 0.6228 < 0.01, `expected ~0.6228, got ${verdict.priceUsd}`);
  assert.equal(verdict.mcap, CHART_CAP);
});

test('validateTick: uncalibrated cap keeps the legacy anchor-ratio result', () => {
  const verdict = Q.validateTick(ANCHOR, { mint: ANCHOR.mint, mcap: CHART_CAP, candidates: [] });
  assert.equal(verdict.accepted, true);
  assert.equal(verdict.basis, 'mcap');
  const ratio = CHART_CAP / ANCHOR.mcap;
  assert.ok(Math.abs(verdict.priceUsd - ANCHOR.priceUsd * ratio) < 1e-12,
    `legacy ratio ${verdict.priceUsd} != ${ANCHOR.priceUsd * ratio} (the 0.91 bug)`);
});

test('validateTick: a calibrated cap still inside the mcap band but absurd as a price derives nothing', () => {
  // Cap inside the 20x MC band but its implied USD price lands outside the
  // USD band once converted through the chart's supply: no mcap-derived
  // price, tick rejected out-of-band. (25M is 17x off the cap anchor but the
  // ~1B supply makes it a 25x price drop — inconsistent evidence, refused.)
  const chartSupply = CHART_CAP / 0.6228;
  const verdict = Q.validateTick(ANCHOR,
    { mint: ANCHOR.mint, mcap: 25_000_000, candidates: [] },
    { chartSupply });
  assert.equal(verdict.accepted, false);
  assert.equal(verdict.reason, 'out-of-band');
});

test('validateTick: without chartSupply a USD candidate still wins over the cap', () => {
  const verdict = Q.validateTick(ANCHOR, {
    mint: ANCHOR.mint, mcap: CHART_CAP,
    candidates: [{ value: 0.6229, unit: 'usd', key: 'tokenActivityPriceUsd' }],
  }, { chartSupply: CHART_CAP / 0.6228 });
  assert.equal(verdict.accepted, true);
  assert.equal(verdict.basis, 'usd');
  assert.ok(Math.abs(verdict.priceUsd - 0.6229) < 1e-9);
});

/* Live 2026-11-18, Axiom GARY (a 1e9 pump coin): the learned supply read
 * 1.0907B and wandered across six values in 75 s, because each sample pairs
 * a chart-bar cap with a direct price up to 3 s older. "Avg entry MC" read
 * $41.0K against a true $37.6K. A learned supply that sits near the supply
 * the protocol itself fixes is that supply plus timing noise. */
test('a learned supply near the protocol-known supply snaps to the known one', () => {
  const pump = { mint: 'EXnbUHrDf3C9xUc4reCDRCgqk3txn9ttV6PhGQzhpump' };
  assert.equal(Q.steadyChartSupply(pump, 1_020_000_000), 1e9, 'a couple of percent of timing noise is not a convention');
  assert.equal(Q.steadyChartSupply(pump, 985_000_000), 1e9);
  // The pump constant is a default, not a reading: a coin with burned supply
  // (live: 959.7M) must keep its own learned supply.
  assert.equal(Q.steadyChartSupply(pump, 959_734_990), 959_734_990);
  assert.equal(Q.steadyChartSupply(Object.assign({ supplyUi: 959_734_990 }, pump), 1_000_000_000), 959_734_990,
    'and once the supply was read from the mint account, that reading wins');
  assert.equal(Q.steadyChartSupply({ mint: 'x', supplyUi: 250_000_000 }, 262_000_000), 250_000_000,
    'a supply measured from the mint account is known too');
});

test('a learned supply far from the known one is a real chart convention and is kept (C-32)', () => {
  const pump = { mint: 'EXnbUHrDf3C9xUc4reCDRCgqk3txn9ttV6PhGQzhpump' };
  assert.equal(Q.steadyChartSupply(pump, 684_000_000), 684_000_000, 'a circulating-supply chart stays on its own basis');
  assert.equal(Q.steadyChartSupply(ANCHOR, CHART_CAP / 0.6228), CHART_CAP / 0.6228, 'no known supply: the learned one stands');
});

test('nothing learned means nothing to steady: the legacy path decides', () => {
  assert.equal(Q.steadyChartSupply({ mint: 'EXnbUHrDf3C9xUc4reCDRCgqk3txn9ttV6PhGQzhpump' }, null), null);
  assert.equal(Q.steadyChartSupply(null, 0), null);
});

test('calibration pairs a cap only with a direct price from the same moment, and medians over many samples', () => {
  // A trending coin: the direct price is 2 s older than the cap tick and 6%
  // lower. That pair says "supply 1.06B" on a 1e9 coin; it is not evidence.
  const anchor = { mint: 'EXnbUHrDf3C9xUc4reCDRCgqk3txn9ttV6PhGQzhpump', priceUsd: 0.00004, mcap: 40_000 };
  let state = Q.calibrateChartSupply(null, 42_400, { priceUsd: 0.00004, at: NOW - 2000 }, anchor, NOW);
  assert.equal(state.supply, null, 'a 2 s-old price is not paired');
  // Same-moment pairs with a few outliers: the median holds the true supply.
  state = null;
  for (let i = 0; i < 15; i++) {
    const cap = i % 5 === 0 ? 43_600 : 40_000; // 3 of 15 samples 9% high
    state = Q.calibrateChartSupply(state, cap, { priceUsd: 0.00004, at: NOW - 100 }, anchor, NOW);
  }
  assert.ok(Math.abs(state.supply - 1e9) / 1e9 < 1e-9, `median of 15 ignores the outliers (got ${state.supply})`);
});
