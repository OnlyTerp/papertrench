'use strict';
// Trench Grid derivation tests (DELIGHT-MAP.md A1). The grid is a pure
// derivation from state + PTGamify — these tests drive the REAL gamify
// module (no stubs) so grade laws and bucketing laws are exercised as
// shipped. Engine-shaped rounds via the same fixture pattern gamify.test.js
// uses; state mirrors storage (rounds newest-first).

const test = require('node:test');
const assert = require('node:assert/strict');

const G = require('../gamify.js');
const Grid = require('../trench-grid.js');

const MINT_A = 'So11111111111111111111111111111111111111112';

const THESIS = { text: 'breakout continuation', tags: [], plan: 'scalp', conviction: 3, targetPct: 50, stopPct: 30, at: 1 };

let seq = 0;
/** Closed round with engine-shaped fields; closedAt pinned into `year`. */
function mkRound(year, month /* 0-based */, day, opts = {}) {
  seq += 1;
  const investedSol = opts.investedSol ?? 1;
  const pnlSol = opts.pnlSol ?? 0.1;
  const closedAt = new Date(year, month, day, 12, 0, 0).getTime() + seq;
  const heldMs = opts.heldMs ?? 60_000;
  return {
    id: 'r' + seq,
    mint: MINT_A,
    symbol: 'TEST',
    openedAt: closedAt - heldMs,
    closedAt,
    heldMs,
    investedSol,
    returnedSol: investedSol + pnlSol,
    pnlSol,
    pnlPct: investedSol > 0 ? (pnlSol / investedSol) * 100 : 0,
    peakPnlSol: opts.peakPnlSol ?? Math.max(0, pnlSol),
    troughPnlSol: opts.troughPnlSol ?? Math.min(0, pnlSol),
    thesis: 'thesis' in opts ? opts.thesis : THESIS,
  };
}

/** State whose rounds arrive newest-first like storage. */
function state(chronologicalRounds) {
  return { rounds: chronologicalRounds.slice().reverse(), journal: [], positions: {}, cashSol: 10 };
}

/** One cell per date key, for readable assertions. */
function byDate(derived) {
  const m = new Map();
  for (const c of derived.cells) m.set(c.date, c);
  return m;
}

test('every day of the year through today exists — empty days are honest gaps, not zeros', () => {
  const now = new Date(2026, 2, 15); // Mar 15 2026
  const d = Grid.derive(state([]), G, now);
  // Jan 1 .. Mar 15 = 31 + 28 + 15
  assert.equal(d.cells.length, 31 + 28 + 15);
  assert.equal(d.cells[0].date, '2026-01-01');
  assert.equal(d.cells[d.cells.length - 1].date, '2026-03-15');
  for (const c of d.cells) {
    assert.equal(c.grade, null);
    assert.equal(c.count, 0);
  }
  assert.equal(d.totals.gradedDays, 0);
});

test('a graded day shows its dominant grade; days stay LOCAL-bucketed', () => {
  const now = new Date(2026, 0, 31);
  const r = mkRound(2026, 0, 10, { pnlSol: -0.2, peakPnlSol: 0, troughPnlSol: -0.25 }); // disciplined red → S
  const d = Grid.derive(state([r]), G, now);
  const cell = byDate(d).get('2026-01-10');
  assert.equal(cell.grade, 'S');
  assert.equal(cell.count, 1);
  assert.deepEqual(cell.rounds, undefined); // letters were internal-only
  assert.equal(d.totals.gradedDays, 1);
  assert.equal(d.totals.gradedRounds, 1);
});

test('ties round DOWN to the worse letter — same law as the calendar dots', () => {
  const now = new Date(2026, 0, 31);
  const s = mkRound(2026, 0, 20, { pnlSol: -0.2, peakPnlSol: 0, troughPnlSol: -0.25 }); // S
  const f = mkRound(2026, 0, 20, {
    pnlSol: -0.5, peakPnlSol: 0.4, troughPnlSol: -0.6,
    thesis: null, // no thesis + round-tripped shape → worst grade territory
  });
  const d = Grid.derive(state([s, f]), G, now);
  const cell = byDate(d).get('2026-01-20');
  assert.equal(cell.count, 2);
  assert.notEqual(cell.grade, 'S', 'a split day must not round up to the better story');
});

test('multi-year hygiene: last year\'s rounds never leak into this year\'s grid', () => {
  const now = new Date(2026, 5, 1);
  const old = mkRound(2025, 11, 30, {});
  const d = Grid.derive(state([old]), G, now);
  assert.equal(d.totals.gradedRounds, 0);
  for (const c of d.cells) assert.equal(c.grade, null);
});

test('rounds closed before the seeded window (future clock skew) do not crash or phantom-grade', () => {
  const now = new Date(2026, 0, 5);
  const future = mkRound(2026, 11, 25, {}); // "closed" in December, clock says Jan 5
  const d = Grid.derive(state([future]), G, now);
  assert.equal(d.totals.gradedRounds, 0);
});

test('bestRun counts consecutive graded days across weeks, resets on gaps', () => {
  const now = new Date(2026, 0, 31);
  const r1 = mkRound(2026, 0, 1, {});
  const r2 = mkRound(2026, 0, 2, {});
  const r3 = mkRound(2026, 0, 4, {}); // gap on Jan 3
  const d = Grid.derive(state([r1, r2, r3]), G, now);
  const jan1 = byDate(d).get('2026-01-01');
  const jan2 = byDate(d).get('2026-01-02');
  const jan3 = byDate(d).get('2026-01-03');
  const jan4 = byDate(d).get('2026-01-04');
  assert.equal(jan1.bestRun, 1);
  assert.equal(jan2.bestRun, 2);
  assert.equal(jan3.bestRun, 0, 'gap day is empty');
  assert.equal(jan4.bestRun, 1, 'run restarts after the gap');
  assert.equal(d.totals.bestRun, 2);
});

test('streak chip rides on the REAL gamify streaks — thesis axis, not P&L', () => {
  const now = new Date(2026, 0, 31);
  const withThesis = mkRound(2026, 0, 3, {});
  const without = mkRound(2026, 0, 2, { thesis: null });
  const d = Grid.derive(state([without, withThesis]), G, now);
  assert.equal(d.streak.journal.current, 1, 'only the latest round has a thesis');
  assert.equal(d.streak.journal.best, 1);
});

test('missing gamify degrades to empty cells and zero streaks — never throws', () => {
  const now = new Date(2026, 0, 3);
  const r = mkRound(2026, 0, 2, {});
  const d = Grid.derive(state([r]), null, now);
  assert.equal(d.totals.gradedRounds, 0);
  assert.equal(d.streak.journal.current, 0);
});

test('cellClass maps grades to palette classes, empty to tg-empty', () => {
  assert.equal(Grid.cellClass({ grade: 'S' }), 'tg-cell tg-s');
  assert.equal(Grid.cellClass({ grade: 'F' }), 'tg-cell tg-f');
  assert.equal(Grid.cellClass({ grade: null }), 'tg-cell tg-empty');
  assert.equal(Grid.cellClass(null), 'tg-cell tg-empty');
});

test('gradeRank is total: S worst-first order, unknown letters rank worst', () => {
  assert.equal(Grid.gradeRank('S'), 0);
  assert.equal(Grid.gradeRank('F'), 5);
  assert.equal(Grid.gradeRank('x'), 5);
  assert.equal(Grid.gradeRank(undefined), 5);
});

test('monthOffsets are Mon-first day-of-week offsets for the year', () => {
  const offs = Grid.monthOffsets(2026);
  assert.equal(offs.length, 12);
  // Jan 1 2026 is a Thursday → Mon-first offset 3.
  assert.equal(offs[0], 3);
});
