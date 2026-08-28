'use strict';
/* Daily Spark core tests (DELIGHT-MAP.md A2) — server/core/spark.js.
 *
 * Pins the WHOLE pure contract: deterministic day pick (order-independent,
 * stable skip, honest no-pool), blind/forward slice laws (the spoiler law
 * lives here at the source), action-grammar validation, the full rubric
 * table (every axis threshold), letter mapping, and the zero-PnL payload
 * law. All charts are synthetic and deterministic. No I/O, no worker —
 * worker-level behavior is pinned separately in worker.test.js.
 */
const test = require('node:test');
const assert = require('node:assert');
const S = require('../core/spark.js');

const MIN = 60000;
const SPIKE_AT = 150; // spike bar index in spikeChart()

/* Synthetic chart builder: deterministic, no RNG.
 * Shape: flat 100 for `flat` bars, then a dip to `dipLow` over 20 bars, a
 * run to `runHigh` over 20 bars, then a giveback to `endClose`. */
function shapeChart({ start = 1_700_000_000_000, bars = 200, flat = 120, dipLow = 90, runHigh = 140, endClose = 120 } = {}) {
  const chart = [];
  for (let i = 0; i < bars; i++) {
    let c;
    if (i < flat) c = 100;
    else if (i < flat + 20) c = 100 - (i - flat) * ((100 - dipLow) / 20);
    else if (i < flat + 40) c = dipLow + (i - flat - 20) * ((runHigh - dipLow) / 20);
    else c = runHigh - (i - flat - 40) * ((runHigh - endClose) / Math.max(1, bars - flat - 40));
    chart.push({ ts: start + i * MIN, o: c, h: c * 1.005, l: c * 0.995, c, v: 1000 });
  }
  return chart;
}

/* Spike-crash chart: flat 100, a 160 spike at bars 150-153, a crash to 70
 * (bars 155-158), recovery to ~100. For chasing / panic-shakeout runs. */
function spikeChart({ start = 1_700_000_000_000, bars = 200, spikeAt = 150, spike = 160, crash = 70 } = {}) {
  const chart = [];
  for (let i = 0; i < bars; i++) {
    let c;
    if (i < spikeAt) c = 100;
    else if (i < spikeAt + 4) c = spike;
    else if (i < spikeAt + 9) c = crash + 10; // crash shelf
    else if (i < spikeAt + 15) c = crash + (spikeAt + 15 - i) * ((100 - crash) / 6);
    else c = 100;
    chart.push({ ts: start + i * MIN, o: c, h: c * 1.005, l: c * 0.995, c, v: 1000 });
  }
  return chart;
}

/* ---- day pick: pure function of (dayKey, candidate set) ---- */

test('dayKeyOf is UTC day', () => {
  assert.equal(S.dayKeyOf(Date.UTC(2026, 7, 29, 23, 30)), '2026-08-29');
  assert.equal(S.dayKeyOf(Date.UTC(2026, 7, 30, 0, 30)), '2026-08-30');
});

test('pickForDay is order-independent over the candidate set', () => {
  const chart = shapeChart();
  const chart2 = shapeChart({ start: 1_700_100_000_000 });
  const a = S.pickForDay('2026-08-29', [{ mint: 'A', chart }, { mint: 'B', chart: chart2 }]);
  const b = S.pickForDay('2026-08-29', [{ mint: 'B', chart: chart2 }, { mint: 'A', chart }]);
  assert.ok(a);
  assert.equal(a.mint, b.mint);
  assert.equal(a.window.tTs, b.window.tTs);
  assert.equal(a.window.off, b.window.off);
});

test('pickForDay same day same set -> identical (determinism)', () => {
  const chart = shapeChart();
  const c1 = S.pickForDay('2026-08-29', [{ mint: 'A', chart }]);
  const c2 = S.pickForDay('2026-08-29', [{ mint: 'A', chart }]);
  assert.equal(c1.window.tTs, c2.window.tTs);
});

test('pickForDay windows stay inside the legal band on any day', () => {
  const chart = shapeChart({ bars: 600 });
  for (const day of ['2026-08-29', '2026-08-30', '2026-08-31']) {
    const d = S.pickForDay(day, [{ mint: 'A', chart }]);
    assert.ok(d && d.window.tTs > chart[10].ts);
    assert.ok(d.window.tTs <= chart[chart.length - 61].ts);
  }
});

test('pickForDay skips charts too short to host a window (stable skip)', () => {
  const long = shapeChart();
  const short = shapeChart({ bars: 50 });
  const pick = S.pickForDay('2026-08-29', [{ mint: 'B', chart: short }, { mint: 'A', chart: long }]);
  assert.equal(pick.mint, 'A');
});

test('pickForDay returns null when nothing qualifies (honest no-pool)', () => {
  assert.equal(S.pickForDay('2026-08-29', []), null);
  const short = shapeChart({ bars: 50 });
  assert.equal(S.pickForDay('2026-08-29', [{ mint: 'A', chart: short }]), null);
});

/* ---- slice laws: the spoiler law enforced at the source ---- */

test('sliceBlind: only bars at or before T, capped at PRE_BARS', () => {
  const chart = shapeChart();
  const tTs = chart[130].ts;
  const blind = S.sliceBlind(chart, tTs);
  assert.equal(blind.length, S.PRE_BARS);
  for (const b of blind) assert.ok(b.ts <= tTs);
  assert.equal(blind[blind.length - 1].ts, tTs); // last bar IS the T bar
});

test('forwardSlice: strictly after T, bounded by step', () => {
  const chart = shapeChart();
  const tTs = chart[130].ts;
  for (const step of [1, 2, 3, 4]) {
    const fwd = S.forwardSlice(chart, tTs, step);
    assert.ok(fwd.length > 0);
    for (const b of fwd) assert.ok(b.ts > tTs, 'no bar at/behind T leaks forward');
    assert.ok(fwd.every((b) => b.ts <= tTs + step * S.STEP_BARS * MIN));
  }
  const clamp = S.forwardSlice(chart, tTs, 99);
  const full = S.forwardSlice(chart, tTs, 4);
  assert.equal(clamp.length, full.length);
});

/* ---- action grammar ---- */

test('validateActions: legal runs', () => {
  const tTs = 1_700_000_000_000 + 130 * MIN;
  assert.ok(S.validateActions([{ type: 'pass', ts: tTs + MIN }], tTs).ok);
  const run = S.validateActions([
    { type: 'buy', ts: tTs + 10 * MIN }, { type: 'sell', ts: tTs + 30 * MIN },
  ], tTs);
  assert.ok(run.ok);
  assert.equal(run.heldToEnd, false);
  const held = S.validateActions([{ type: 'buy', ts: tTs + 10 * MIN }], tTs);
  assert.ok(held.ok && held.heldToEnd === true);
});

test('validateActions: rejects broken grammar', () => {
  const tTs = 1_700_000_000_000 + 130 * MIN;
  assert.equal(S.validateActions([], tTs).error, 'empty');
  assert.equal(S.validateActions([{ type: 'flap', ts: tTs + MIN }], tTs).error, 'bad-action');
  assert.equal(S.validateActions([{ type: 'sell', ts: tTs + MIN }], tTs).error, 'must-open');
  assert.equal(S.validateActions([{ type: 'buy', ts: tTs + MIN }, { type: 'buy', ts: tTs + 2 * MIN }], tTs).error, 'must-close');
  assert.equal(S.validateActions([{ type: 'buy', ts: tTs + MIN }, { type: 'sell', ts: tTs + 2 * MIN }, { type: 'sell', ts: tTs + 3 * MIN }], tTs).error, 'too-many');
  assert.equal(S.validateActions([{ type: 'pass', ts: tTs + MIN }, { type: 'buy', ts: tTs + 2 * MIN }], tTs).error, 'pass-not-alone');
  assert.equal(S.validateActions([{ type: 'buy', ts: tTs + 30 * MIN }, { type: 'sell', ts: tTs + 10 * MIN }], tTs).error, 'non-monotonic');
  assert.equal(S.validateActions([{ type: 'buy', ts: tTs - MIN }], tTs).error, 'action-out-of-window');
  assert.equal(S.validateActions([{ type: 'buy', ts: tTs + 61 * MIN }], tTs).error, 'action-out-of-window');
});

/* ---- rubric table: thresholds pinned through the real gradeRun ---- */

test('rubric: floor entry green, T-close entry yellow, top-chase red', () => {
  const chart = shapeChart({ flat: 120, dipLow: 90, runHigh: 140, endClose: 115 });
  const tTs = chart[130].ts;
  const atFloor = S.gradeRun(S.validateActions([{ type: 'buy', ts: tTs + 20 * MIN }], tTs), chart, tTs);
  assert.equal(atFloor.axes.find((a) => a.key === 'entry').tone, 'green', 'floor fill grades green');
  const atT = S.gradeRun(S.validateActions([{ type: 'buy', ts: tTs + MIN }], tTs), chart, tTs);
  assert.equal(atT.axes.find((a) => a.key === 'entry').tone, 'yellow', 'T close into a -10% floor is yellow');
  // Spike-crash: T mid-flat (20 before the spike); buying the 160 spike
  // then riding the crash to 70 = chasing > 1.25x the entry-window low.
  const chart2 = spikeChart();
  const tTs2 = chart2[SPIKE_AT - 20].ts;
  const late = S.gradeRun(S.validateActions([{ type: 'buy', ts: tTs2 + 30 * MIN }], tTs2), chart2, tTs2);
  assert.equal(late.axes.find((a) => a.key === 'entry').tone, 'red', 'buying the spike is red');
});

test('rubric: near-top exit is green or yellow, never red', () => {
  const chart = shapeChart({ flat: 120, dipLow: 90, runHigh: 140, endClose: 120 });
  const tTs = chart[130].ts;
  const g = S.gradeRun(S.validateActions([
    { type: 'buy', ts: tTs + 20 * MIN }, { type: 'sell', ts: tTs + 58 * MIN },
  ], tTs), chart, tTs);
  assert.ok(['green', 'yellow'].includes(g.axes.find((a) => a.key === 'exit').tone),
    'near-top exit tone, got ' + (g.axes.find((a) => a.key === 'exit') || {}).tone);
});

test('rubric: heldToEnd auto-exit grades without error', () => {
  const chart = shapeChart();
  const tTs = chart[130].ts;
  const held = S.gradeRun(S.validateActions([{ type: 'buy', ts: tTs + 20 * MIN }], tTs), chart, tTs);
  assert.equal(held.heldToEnd, true);
  assert.ok(['S', 'A', 'B', 'C', 'D'].includes(held.grade));
  assert.equal(held.axes.length, 3);
});

test('rubric: pass grades on the read axis only', () => {
  const chart = shapeChart({ flat: 120, dipLow: 60, runHigh: 75, endClose: 62 });
  const tTs = chart[130].ts;
  const pg = S.gradeRun(S.validateActions([{ type: 'pass', ts: tTs + MIN }], tTs), chart, tTs);
  assert.equal(pg.passed, true);
  assert.equal(pg.axes.length, 1);
  assert.equal(pg.axes[0].key, 'read');
  assert.equal(pg.axes[0].emoji, S.EMOJI.green);
  assert.match(pg.story, /dodged|skipped/);
  const chart2 = shapeChart({ flat: 120, dipLow: 95, runHigh: 160, endClose: 150 });
  const pg2 = S.gradeRun(S.validateActions([{ type: 'pass', ts: tTs + MIN }], tTs), chart2, tTs);
  assert.equal(pg2.axes[0].emoji, S.EMOJI.red);
  assert.match(pg2.story, /paid after T/);
});

test('rubric: selling at the held low is a panic (nerve red)', () => {
  // Spike-crash: buy mid-flat (T +5), the spike-crash to 70 is a 100/70 =
  // 1.43 dip (>= 1.15), and the sell lands ON the crash low -> panic red.
  const chart = spikeChart();
  const tTs = chart[SPIKE_AT - 20].ts;
  const panicRun = S.validateActions([{ type: 'buy', ts: tTs + 5 * MIN }, { type: 'sell', ts: tTs + 25 * MIN }], tTs);
  const g = S.gradeRun(panicRun, chart, tTs);
  assert.equal(g.axes.find((a) => a.key === 'nerve').tone, 'red', 'selling at the held low is panic');
  // Same chart, but hold THROUGH the crash and sell after recovery: green.
  const steady = S.gradeRun(S.validateActions([
    { type: 'buy', ts: tTs + 5 * MIN }, { type: 'sell', ts: tTs + 55 * MIN },
  ], tTs), chart, tTs);
  assert.equal(steady.axes.find((a) => a.key === 'nerve').tone, 'green', 'held through the shake is green');
});

test('rubric: floor-in top-out is A/S; chase+dump is C/D', () => {
  // T = bar 90 — the LAST legal seed offset for a 200-bar chart (quartile
  // window is 50..90): the top at bar 150 is exactly 60 bars later, the
  // aftermath boundary the client can still reach. floor-in = buying the
  // 90-low, top-out = selling the 140-high; the chase probe pins the
  // out-of-window law on the same chart.
  const chart = shapeChart({ flat: 120, dipLow: 90, runHigh: 140, endClose: 135 });
  const tTs = chart[90].ts;
  const best = S.gradeRun(S.validateActions([
    { type: 'buy', ts: tTs + MIN }, { type: 'sell', ts: chart[150].ts },
  ], tTs), chart, tTs);
  assert.ok(['A', 'S'].includes(best.grade), 'floor-in top-out should be A/S, got ' + JSON.stringify(best));
  assert.equal(best.axes.find((a) => a.key === 'exit').tone, 'green', 'selling the top grades green exit');
  assert.equal(best.axes.find((a) => a.key === 'entry').tone, 'green', 'floor fill grades green entry');
  const late = S.validateActions([
    { type: 'buy', ts: tTs + 61 * MIN }, { type: 'sell', ts: tTs + 61 * MIN + 5 * MIN },
  ], tTs);
  assert.equal(late.error, 'action-out-of-window', '+61min buy is outside the aftermath window');
  const worst = S.gradeRun(late, chart, tTs);
  assert.ok(worst.error, 'gradeRun surfaces the validation error, never a phantom grade');
});

test('gradeRun refuses to grade an invalid run (returns the error, never crashes)', () => {
  const chart = shapeChart();
  const tTs = chart[130].ts;
  const bad = S.validateActions([], tTs); // empty -> error object
  const out = S.gradeRun(bad, chart, tTs);
  assert.equal(out.error, 'invalid-run:empty');
  // garbage input too
  assert.equal(S.gradeRun(null, chart, tTs).error, 'invalid-run:unknown');
  assert.equal(S.gradeRun({ ok: true }, chart, tTs).error, 'invalid-run:unknown');
});

test('gradeRun result carries NO numeric outcome fields (zero-PnL law)', () => {
  const chart = shapeChart();
  const tTs = chart[130].ts;
  const run = S.gradeRun(S.validateActions([{ type: 'buy', ts: tTs + 20 * MIN }, { type: 'sell', ts: tTs + 58 * MIN }], tTs), chart, tTs);
  const banned = /"(o|h|l|c|v|price|pnl|sol|usd|ratio|chase|gaveUp|airBelow|dip|rip)"\s*:/;
  assert.ok(!banned.test(JSON.stringify(run)), 'grade payload must not leak prices/ratios: ' + JSON.stringify(run));
  const pass = S.gradeRun(S.validateActions([{ type: 'pass', ts: tTs + MIN }], tTs), chart, tTs);
  assert.ok(!banned.test(JSON.stringify(pass)));
});

test('result card names the honest aftermath framing', () => {
  const chart = shapeChart();
  const tTs = chart[130].ts;
  const g = S.gradeRun(S.validateActions([{ type: 'buy', ts: tTs + 20 * MIN }], tTs), chart, tTs);
  assert.match(g.story, /graded against what followed/);
});

test('daySeed + fnv1a are stable', () => {
  assert.equal(S.fnv1a('spark:2026-08-29'), S.fnv1a('spark:2026-08-29'));
  assert.notEqual(S.fnv1a('spark:2026-08-29'), S.fnv1a('spark:2026-08-30'));
  assert.equal(S.daySeed('2026-08-29'), S.daySeed('2026-08-29'));
});
