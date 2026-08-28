'use strict';
// Trench Wrapped derivation tests (DELIGHT-MAP.md B1) — extension/wrapped.js.
// The recap is a pure derivation from state + PTGamify; these tests drive the
// REAL wrapped module (no stubs) so the monthly-window law, the worst-letter
// tie law, the recovery/symmetry math, and the no-PnL payload law are
// exercised as shipped. Engine-shaped rounds via the same fixture pattern
// gamify.test.js uses.

const test = require('node:test');
const assert = require('node:assert/strict');

const W = require('../wrapped.js');
const G = require('../gamify.js');

const MINT_A = 'So11111111111111111111111111111111111111112';

const THESIS = { text: 'breakout continuation', tags: [], plan: 'scalp', conviction: 3, targetPct: 50, stopPct: 30, at: 1 };

let seq = 0;
/** Closed round with engine-shaped fields; closedAt pinned into `month`. */
function mkRound(year, month /* 0-based */, day, opts = {}) {
  seq += 1;
  const investedSol = opts.investedSol ?? 1;
  const pnlSol = opts.pnlSol ?? 0.1;
  const closedAt = new Date(year, month, day, 12, 0, 0).getTime() + seq;
  const heldMs = opts.heldMs ?? 60_000;
  return {
    id: 'r' + seq,
    mint: MINT_A,
    symbol: opts.symbol || 'TEST',
    openedAt: closedAt - heldMs,
    closedAt,
    investedSol,
    pnlSol,
    heldMs,
    thesis: opts.thesis === undefined ? THESIS : opts.thesis,
    afterExit: opts.afterExit || null,
  };
}

/** A minimal gamify stub that mirrors PTGamify.roundGrade's verdicts. */
function stubGamify(verdicts) {
  return {
    roundGrade(state, round) {
      const v = verdicts[round.id] || { letter: 'B', verdict: 'good', parts: [] };
      return { letter: v.letter, verdict: v.verdict, parts: v.parts || [] };
    },
  };
}

const NOW = new Date(2026, 7, 20, 15, 30, 0); // Aug 20, 2026

test('monthly window: only rounds closed in the current month count', () => {
  // Storage order is newest-first (engine unshift) — mirror it.
  const state = {
    rounds: [
      mkRound(2026, 7, 5, { pnlSol: 0.1 }),   // Aug 5 — in
      mkRound(2026, 6, 20, { pnlSol: 0.2 }),  // Jul 20 — out
      mkRound(2026, 7, 1, { pnlSol: -0.1 }),  // Aug 1 — in
    ],
  };
  const m = W.derive(state, stubGamify({}), NOW);
  assert.ok(m, 'model exists');
  assert.equal(m.month, '2026-08');
  assert.equal(m.rounds, 2, 'only August rounds count');
  assert.equal(m.monthName, 'August');
  assert.equal(m.year, 2026);
});

test('no rounds in the month -> null (honest empty)', () => {
  const state = { rounds: [mkRound(2026, 6, 20, { pnlSol: 0.2 })] };
  assert.equal(W.derive(state, stubGamify({}), NOW), null);
});

test('discipline letter: worst letter of the month wins (rounds DOWN law)', () => {
  const state = {
    rounds: [
      mkRound(2026, 7, 1, { pnlSol: 0.1 }),  // A
      mkRound(2026, 7, 2, { pnlSol: 0.1 }),  // B
      mkRound(2026, 7, 3, { pnlSol: -0.1 }), // D
    ],
  };
  const verdicts = {
    [state.rounds[0].id]: { letter: 'A', verdict: 'good', parts: [] },
    [state.rounds[1].id]: { letter: 'B', verdict: 'good', parts: [] },
    [state.rounds[2].id]: { letter: 'D', verdict: 'round-tripped', parts: [{ id: 'round-trip' }] },
  };
  const m = W.derive(state, stubGamify(verdicts), NOW);
  assert.equal(m.letter, 'D', 'worst letter wins, never rounded up');
  assert.equal(m.letterCounts.A, 1);
  assert.equal(m.letterCounts.B, 1);
  assert.equal(m.letterCounts.D, 1);
  assert.equal(m.cleanExits, 2, 'clean exits exclude the round-trip');
});

test('longest recovery: longest red->green span in days', () => {
  // Newest-first storage order (engine unshift): Aug 12 first.
  const state = {
    rounds: [
      mkRound(2026, 7, 12, { pnlSol: 0.1 }),  // green Aug 12
      mkRound(2026, 7, 5, { pnlSol: -0.1 }),  // red Aug 5
      mkRound(2026, 7, 3, { pnlSol: 0.1 }),   // green Aug 3
      mkRound(2026, 7, 1, { pnlSol: -0.1 }),  // red Aug 1
    ],
  };
  const m = W.derive(state, stubGamify({}), NOW);
  assert.ok(m.longestRecovery, 'recovery exists');
  assert.equal(m.longestRecovery.days, 7, 'longest red->green span');
});

test('hold symmetry: average green hold vs red hold', () => {
  const state = {
    rounds: [
      mkRound(2026, 7, 1, { pnlSol: 0.1, heldMs: 120_000 }),   // green 2m
      mkRound(2026, 7, 2, { pnlSol: -0.1, heldMs: 600_000 }),  // red 10m
      mkRound(2026, 7, 3, { pnlSol: 0.1, heldMs: 360_000 }),   // green 6m
    ],
  };
  const m = W.derive(state, stubGamify({}), NOW);
  assert.ok(m.holdSymmetry, 'symmetry exists');
  assert.equal(m.holdSymmetry.greenAvgMs, 240_000, 'avg green hold 4m');
  assert.equal(m.holdSymmetry.redAvgMs, 600_000, 'avg red hold 10m');
  assert.equal(m.holdSymmetry.ratio, 0.4, 'green/red ratio');
});

test('one that got away: biggest After maxPct this month', () => {
  const state = {
    rounds: [
      mkRound(2026, 7, 1, { pnlSol: 0.1, afterExit: { maxPct: 40, minPct: -5 } }),
      mkRound(2026, 7, 2, { pnlSol: 0.1, afterExit: { maxPct: 120, minPct: -10 } }),
      mkRound(2026, 7, 3, { pnlSol: -0.1, afterExit: null }),  // no After data
    ],
  };
  const m = W.derive(state, stubGamify({}), NOW);
  assert.ok(m.oneThatGotAway, 'got-away exists');
  assert.equal(m.oneThatGotAway.maxPct, 120, 'biggest maxPct');
  assert.equal(m.oneThatGotAway.symbol, 'TEST');
});

test('NO PNL FIELDS in the payload — the recap is process, never money', () => {
  const state = {
    rounds: [
      mkRound(2026, 7, 1, { pnlSol: 0.5 }),
      mkRound(2026, 7, 2, { pnlSol: -0.3 }),
    ],
  };
  const m = W.derive(state, stubGamify({}), NOW);
  assert.ok(m, 'model exists');
  const json = JSON.stringify(m);
  for (const key of ['pnlSol', 'profit', 'loss', 'roi', 'usd', 'sol']) {
    assert.ok(!json.includes(key), 'payload must not carry ' + key);
  }
});

test('journal rate: fraction of rounds with a written thesis', () => {
  const state = {
    rounds: [
      mkRound(2026, 7, 1, { pnlSol: 0.1, thesis: THESIS }),
      mkRound(2026, 7, 2, { pnlSol: 0.1, thesis: null }),
      mkRound(2026, 7, 3, { pnlSol: 0.1, thesis: { text: '  ' } }), // empty thesis
    ],
  };
  const m = W.derive(state, stubGamify({}), NOW);
  assert.equal(m.journalRate, 1 / 3, 'only substantive theses count');
});

test('fmtDuration: compact human durations', () => {
  assert.equal(W.fmtDuration(45_000), '1m');
  assert.equal(W.fmtDuration(120_000), '2m');
  assert.equal(W.fmtDuration(3_600_000), '1h');
  assert.equal(W.fmtDuration(8_040_000), '2h 14m');
  assert.equal(W.fmtDuration(-1), '—');
});