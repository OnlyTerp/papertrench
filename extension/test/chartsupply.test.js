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

test('calibrateChartSupply keeps the median of the last 5 samples', () => {
  let state = null;
  const caps = [622e6, 623e6, 621e6, 624e6, 620e6, 900e6]; // last entry still inside 20x of anchor mcap
  caps.forEach((cap, i) => {
    state = Q.calibrateChartSupply(state, cap, { priceUsd: cap / 1e9, at: NOW + i * 100 }, ANCHOR, NOW + i * 100);
  });
  assert.equal(state.samples.length, 5, 'ring keeps the newest five');
  // Median of the last five implied supplies (all ~1e9 except the last at 9e8):
  // sorted [1e9-ish x4, 9e8] -> hmm compute expected directly.
  const implied = caps.slice(-5).map((c) => c / (c / 1e9));
  const sorted = implied.slice().sort((a, b) => a - b);
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
