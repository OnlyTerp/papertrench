'use strict';
// Panel desk data tests (DELIGHT-MAP.md D1). panel-data.js is a pure
// projection of stored state — these drive the REAL module. Streak axes
// ride the real PTGamify (no stubs); engine-shaped fixtures mirror
// gamify.test.js so the shapes are the shipped ones, not invented ones.

const test = require('node:test');
const assert = require('node:assert/strict');

const G = require('../gamify.js');
const P = require('../panel-data.js');

const MINT_A = 'So11111111111111111111111111111111111111112';
const THESIS = { text: 'breakout continuation', tags: [], plan: 'scalp', conviction: 3, targetPct: 50, stopPct: 30, at: 1 };

let seq = 0;
function mkRound(opts = {}) {
  seq += 1;
  const investedSol = opts.investedSol ?? 1;
  const pnlSol = opts.pnlSol ?? 0.1;
  const closedAt = opts.closedAt ?? (1_800_000_000_000 + seq * 300_000);
  return {
    id: 'r' + seq,
    mint: MINT_A,
    symbol: 'TEST',
    openedAt: closedAt - (opts.heldMs ?? 60_000),
    closedAt,
    heldMs: opts.heldMs ?? 60_000,
    investedSol,
    returnedSol: investedSol + pnlSol,
    pnlSol,
    pnlPct: (pnlSol / investedSol) * 100,
    peakPnlSol: Math.max(0, pnlSol),
    troughPnlSol: Math.min(0, pnlSol),
    thesis: 'thesis' in opts ? opts.thesis : THESIS,
    afterExit: opts.afterExit,
  };
}

function mkPos(opts = {}) {
  seq += 1;
  return {
    mint: MINT_A,
    symbol: 'TEST',
    name: 'Test',
    openedAt: opts.openedAt ?? (1_799_000_000_000 + seq),
    qty: opts.qty ?? 100,
    costSol: opts.costSol ?? 0.95,
    investedSol: opts.investedSol ?? 1,
    netInvestedSol: opts.netInvestedSol ?? 0.95,
    thesis: 'thesis' in opts ? opts.thesis : THESIS,
  };
}

function state(rounds, positions) {
  const posMap = {};
  for (const p of positions || []) posMap[p.mint + ':' + p.openedAt] = p;
  return { rounds, positions: posMap, journal: [], cashSol: 10 };
}

test('activeRound picks the freshest open position and measures held time', () => {
  const now = 1_800_000_000_000;
  const older = mkPos({ openedAt: now - 60_000 });
  const newer = mkPos({ openedAt: now - 5_000 });
  const a = P.activeRound(state([], [older, newer]), now);
  assert.equal(a.openedAt, newer.openedAt);
  assert.equal(a.heldMs, 5_000);
  assert.equal(a.thesisMissing, false);
});

test('activeRound flags a missing thesis — the nudge chip drives off this', () => {
  const now = 1_800_000_000_000;
  const p = mkPos({ thesis: null });
  const a = P.activeRound(state([], [p]), now);
  assert.equal(a.thesisMissing, true);
});

test('activeRound is null with no open positions — honest empty desk', () => {
  assert.equal(P.activeRound(state([]), Date.now()), null);
  assert.equal(P.activeRound(state([]), undefined), null);
});

test('openCostSol scales gross by the surviving-cost ratio (popup.js voice)', () => {
  const pos = { investedSol: 2, costSol: 0.5, netInvestedSol: 1 };
  assert.equal(P.openCostSol(pos), 1); // 2 * (0.5/1) — half the stack survives
  assert.equal(P.openCostSol(null), 0);
});

test('afterFeed lists only rounds with an afterExit observation, newest first', () => {
  const t0 = 1_800_000_000_000;
  const watched = mkRound({ closedAt: t0 - 1000, afterExit: { maxPct: 33.1, minPct: -4, samples: 30 } });
  const unwatched = mkRound({ closedAt: t0 - 500 }); // no afterExit — honest gap
  const rows = P.afterFeed(state([unwatched, watched], []));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, watched.id);
  assert.equal(rows[0].maxPct, 33.1);
});

test('afterFeed caps at the limit (default 8, max 20) and sorts newest-first', () => {
  const t0 = 1_800_000_000_000;
  const rounds = [];
  for (let i = 0; i < 25; i++) {
    rounds.push(mkRound({ closedAt: t0 - i * 1000, afterExit: { maxPct: i, minPct: -1, samples: 5 } }));
  }
  const rows = P.afterFeed(state(rounds, []));
  assert.equal(rows.length, 8);
  assert.equal(rows[0].maxPct, 0); // i=0 is newest
  assert.equal(rows[7].maxPct, 7);
  assert.equal(P.afterFeed(state(rounds, []), 99).length, 20, 'hard cap 20');
});

test('deskModel rides the REAL gamify streaks — thesis axis', () => {
  const t0 = 1_800_000_000_000;
  // Storage order is NEWEST-FIRST (engine unshift — gamify.js:47 invariant).
  // mkRound stamps closedAt from the seq counter, so the later-created round
  // is newer and must be stored first.
  const without = mkRound({ thesis: null });
  const withThesis = mkRound({});
  const d = P.deskModel(state([withThesis, without], []), G, t0);
  assert.equal(d.streaks.journal.current, 1);
  assert.equal(d.counts.rounds, 2);
  assert.equal(d.counts.open, 0);
  assert.equal(d.active, null);
});

test('deskModel degrades without gamify — zero chips, never throws', () => {
  const t0 = 1_800_000_000_000;
  const d = P.deskModel(state([mkRound({})], []), null, t0);
  assert.equal(d.streaks.journal.current, 0);
  assert.equal(d.after.length, 0);
});

test('fmtSol signs positive values and 2dp-formats — glanceable desk voice', () => {
  assert.equal(P.fmtSol(1.5), '+1.50 SOL');
  assert.equal(P.fmtSol(-0.25), '-0.25 SOL');
  assert.equal(P.fmtSol(0), '0.00 SOL');
  assert.equal(P.fmtSol(undefined), '0.00 SOL');
});

test('module triple-registers like the other PT* modules', () => {
  // require() path proven by the top-level requires; assert the api shape.
  assert.equal(typeof P.deskModel, 'function');
  assert.equal(typeof P.afterFeed, 'function');
  assert.equal(typeof P.activeRound, 'function');
});
