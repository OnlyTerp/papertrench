/* D-06: editing the starting balance must never fabricate P&L.
 *
 * The old code used settings.balanceStartSol as BOTH the wallet's birth
 * cash AND every "% since start" denominator. Editing the setting
 * mid-wallet retroactively rewrote return: a 10-SOL wallet marked down to
 * 1 SOL turned +1 SOL realized into "+100%" overnight — history the
 * trader never lived.
 *
 * The fix: defaultState() snapshots the birth balance onto state.startSol
 * at reset, engine.anchorStartSol(state, settings) reads that snapshot
 * (setting only as legacy fallback), and every ROI denominator sites off
 * the anchor. The setting keeps naming exactly what it says: what the
 * NEXT wallet starts with.
 *
 * Source-contract tests on observable channels only.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const E = require('../engine.js');

const read = (name) => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

test('D-06: defaultState snapshots the birth balance as state.startSol', () => {
  const st = E.defaultState({ balanceStartSol: 25 });
  assert.strictEqual(st.startSol, 25);
  assert.strictEqual(st.cashSol, 25);
});

test('D-06: anchorStartSol reads the birth snapshot, ignoring the live setting', () => {
  const st = E.defaultState({ balanceStartSol: 10 });
  // mid-wallet edit: setting drops to 1, wallet was BORN at 10
  const anchored = E.anchorStartSol(st, { balanceStartSol: 1 });
  assert.strictEqual(anchored, 10);
});

test('D-06: anchorStartSol falls back to the setting for legacy states without startSol', () => {
  const legacy = { cashSol: 10, positions: {}, rounds: [], journal: [] };
  assert.strictEqual(E.anchorStartSol(legacy, { balanceStartSol: 7 }), 7);
  // and never throws on junk
  assert.strictEqual(E.anchorStartSol(null, { balanceStartSol: 7 }), 7);
  assert.strictEqual(E.anchorStartSol(legacy, {}), 0);
});

test('D-06: sessionStats equityVsStart stays anchored after a mid-wallet edit', () => {
  const st = E.defaultState({ balanceStartSol: 10 });
  // wallet doubles: cash 20, no positions/rounds
  st.cashSol = 20;
  const stats = E.sessionStats(st, { balanceStartSol: 1 }); // setting edited to 1
  // anchored to birth (10): +10 SOL, not +19
  assert.ok(Math.abs((stats.equityVsStart) - (10)) < Math.pow(10, -(9)));
});

test('D-06: riskProfile sizes grades against the birth anchor, not the setting', () => {
  const st = E.defaultState({ balanceStartSol: 10 });
  st.rounds = [
    { investedSol: 5, pnlSol: 1 },
    { investedSol: 5, pnlSol: -1 },
  ];
  const rp = E.riskProfile(st, { balanceStartSol: 100 }); // setting edited to 100
  // sizes graded vs birth 10: 50% each → avg 50, max 50, oversized 0 (vs 100 they'd be 5%)
  assert.ok(Math.abs((rp.avgSizePct) - (50)) < Math.pow(10, -(6)));
  assert.ok(Math.abs((rp.maxSizePct) - (50)) < Math.pow(10, -(6)));
});

test('D-06: the popup/overlay/background compute sites reference the anchor, never raw settings', () => {
  // popup.js and overlay.js inline the rule (they don't load engine.js);
  // background.js inlines it too (service worker doesn't importScripts engine).
  // The contract: no raw `settings.balanceStartSol` arithmetic remains in
  // any % / equityVsStart / ROI computation outside DEFAULTS/init contexts.
  const popup = read('popup.js');
  const overlay = read('overlay.js');
  const background = read('background.js');

  // equityVsStart sites must gate on state.startSol first
  const eqStartRe = /equityVsStart:\s*equity\s*-\s*settings\.balanceStartSol/;
  assert.strictEqual(eqStartRe.test(popup), false);
  assert.strictEqual(eqStartRe.test(overlay), false);

  // pct sites must reference the anchor var, not the setting directly
  const pctRe = /equityVsStart\s*\/\s*settings\.balanceStartSol/;
  assert.strictEqual(pctRe.test(popup), false);
  assert.strictEqual(pctRe.test(overlay), false);

  // background bridge: replay start gates on state.startSol
  assert.strictEqual(/replayChain\(\s*chain,\s*Number\(settings\.balanceStartSol\)/.test(background), false);
  assert.strictEqual(/state\.startSol/.test(background), true);
});

test('D-06: dashboard ROI denominators route through E.anchorStartSol', () => {
  const dash = read('dashboard.js');
  // all ROI/pct denominators now anchor
  const rawUses = dash.match(/\/\s*settings\.balanceStartSol/g) || [];
  assert.strictEqual(rawUses.length, 0);
  // and the anchor is actually used
  assert.strictEqual(dash.includes('E.anchorStartSol'), true);
});

test('D-06: reset keeps working — new wallet born at the NEW setting', () => {
  const st = E.resetState({ balanceStartSol: 42 });
  assert.strictEqual(st.cashSol, 42);
  assert.strictEqual(st.startSol, 42);
});

test('D-06: startGame (Trench Season) snapshots startSol at season start', () => {
  // startGame must also seed startSol so season wallets are anchored too
  const st = E.startGame ? E.startGame('season', { balanceStartSol: 15 }) : null;
  if (st) {
    assert.strictEqual(Number(st.startSol), 15);
    assert.strictEqual(st.cashSol, 15);
  }
});
