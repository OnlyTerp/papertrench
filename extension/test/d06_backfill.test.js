/* D-56: legacy wallets (born before D-06's state.startSol snapshot, v3.9.5)
 * kept anchoring every "% since start" — and every SOL-vs-start — on the
 * LIVE "Starting paper balance" setting. Editing the form 10 → 1 SOL on a
 * wallet that actually started at 10 turned a +0.091 SOL session into a
 * +9.109 SOL session (jb's 8/18 report: "exactly 100×" on his numbers).
 *
 * The fix: engine.backfillAnchor re-derives the birth balance from the fill
 * journal (the same identity equityCurvePoints uses:
 *   equity = birth + Σ per-fill steps + open P&L)
 * and freezes it onto state.startSol; anchorStartSol gains the derived
 * middle layer (birth snapshot → derived → setting); the read-only
 * surfaces (popup/overlay/bridge) carry local copies of the derivation.
 *
 * Source-contract tests on observable channels only — the same fixtures the
 * engine's own equityCurvePoints identity was built on.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const E = require('../engine.js');

const read = (name) => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');

/* A wallet exactly as a pre-v3.9.5 content script would have written it:
 * born at 10 SOL (the default), a few closed rounds, no startSol field.
 * The journal is built with the engine's own buy/sell so every field the
 * derivation reads (feeSol, solGross, solNet, pnlSol) is real. */
function legacyWallet({ startSol = 10, feesBps = 100, price = 0.001 } = {}) {
  const settings = E.defaultSettings();
  settings.feeBps = feesBps;
  const st = E.defaultState(settings);
  delete st.startSol; // ← the legacy hole: born before the snapshot existed
  st.cashSol = startSol;

  // Round 1: buy 1 SOL gross, sell the whole bag at 2× (net +~1 SOL after fees)
  const r1 = E.buy(st, settings, { mint: 'MINT1', symbol: 'A', solAmount: 1, priceNative: price, ts: 1000 });
  const sell1 = E.sell(st, settings, { mint: 'MINT1', symbol: 'A', qtyFraction: 1, priceNative: price * 2, ts: 2000 });

  // Round 2: buy 0.5 SOL gross, sell the whole bag at 0.98× (small net loss)
  const r2 = E.buy(st, settings, { mint: 'MINT2', symbol: 'B', solAmount: 0.5, priceNative: price, ts: 3000 });
  const sell2 = E.sell(st, settings, { mint: 'MINT2', symbol: 'B', qtyFraction: 1, priceNative: price * 0.98, ts: 4000 });

  return { st, r1, r2, sell1, sell2, settings };
}

/* The wallet's TRUE birth, replayed from a DIFFERENT route than the fix:
 * the CASH flow. A buy leaves the wallet by solGross + the flat tx cost;
 * a sell enters by solNet (net proceeds). Then the open-position term:
 * cash still holds the gross invested, and the position's cost basis
 * (net + flat) is what the mark replaced — so birth = cashReplay + Σcost − Σmark.
 * (With all bags closed, Σcost → 0 and Σmark → 0, and it degenerates to the
 * plain cash replay.) Works for the base fixture AND the open-position
 * tests without assuming stepOf is right. */
function trueBirth(st) {
  let cash = Number(st.cashSol) || 0;
  for (const t of st.journal || []) {
    if (t.side === 'buy') cash += (Number(t.solGross) || 0) + (Number(t.txCostSol) || 0);
    else if (t.side === 'sell') cash -= (Number(t.solNet) || 0);
  }
  let cost = 0;
  let mark = 0;
  for (const p of Object.values(st.positions || {})) {
    const qty = Number(p.qty) || 0;
    if (qty <= 0) continue;
    cost += Number(p.costSol) || 0;
    mark += qty * (Number(p.lastPriceNative) || 0);
  }
  return cash + cost - mark;
}

test('D-56: derivedBirthSol re-derives the birth balance of a legacy wallet', () => {
  const { st } = legacyWallet();
  const derived = E.derivedBirthSol(st);
  const truth = trueBirth(st);
  assert.ok(Number.isFinite(derived), 'derivation must be finite');
  assert.ok(Math.abs(derived - truth) < 1e-9, `derived ${derived} vs true ${truth}`);
});

test('D-56: derivedBirthSol is stable across open positions (marks move, anchor must not)', () => {
  const { st, settings } = legacyWallet();
  // Open a live bag and re-derive — the anchor must not budge as marks move.
  E.buy(st, settings, { mint: 'MINT3', symbol: 'C', solAmount: 2, priceNative: 0.002, ts: 5000 });
  const before = E.derivedBirthSol(st);
  E.markPosition(st, 'MINT3', 0.005); // 2.5× mark
  const after = E.derivedBirthSol(st);
  assert.ok(Math.abs(before - after) < 1e-9, `anchor moved on a mark: ${before} → ${after}`);
});

test('D-56: derivedBirthSol is stable across new fills (the writer race)', () => {
  const { st, settings } = legacyWallet();
  const before = E.derivedBirthSol(st);
  // A concurrent tab lands another round between the read and the write.
  E.buy(st, settings, { mint: 'MINT4', symbol: 'D', solAmount: 0.2, priceNative: 0.001, ts: 6000 });
  E.sell(st, settings, { mint: 'MINT4', symbol: 'D', qtyFraction: 1, priceNative: 0.0015, ts: 7000 });
  const after = E.derivedBirthSol(st);
  assert.ok(Math.abs(before - after) < 1e-9, `anchor moved on new fills: ${before} → ${after}`);
});

test('D-56: backfillAnchor freezes the derived birth onto state.startSol', () => {
  const { st, settings } = legacyWallet();
  const truth = trueBirth(st);
  const wrote = E.backfillAnchor(st, settings);
  assert.strictEqual(wrote, true, 'must write for a legacy wallet');
  assert.ok(Math.abs(st.startSol - truth) < 1e-9, `startSol ${st.startSol} vs true ${truth}`);
  // Idempotent: a second pass leaves the snapshot untouched.
  assert.strictEqual(E.backfillAnchor(st, settings), false);
  assert.ok(Math.abs(st.startSol - truth) < 1e-9, 'second pass must not re-derive');
});

test('D-56: backfillAnchor is a no-op for modern wallets (startSol already set)', () => {
  const modern = E.defaultState(E.defaultSettings()); // born after v3.9.5
  modern.cashSol = 42;
  assert.strictEqual(E.backfillAnchor(modern, E.defaultSettings()), false);
  assert.strictEqual(modern.startSol, 10, 'modern snapshot must not be touched');
});

test('D-56: backfillAnchor is conservative — empty journal or dust equity defers to the setting', () => {
  const noFills = { cashSol: 10, positions: {}, rounds: [], journal: [] };
  assert.strictEqual(E.backfillAnchor(noFills, { balanceStartSol: 7 }), false, 'no fills → no derived anchor');
  assert.strictEqual(noFills.startSol, undefined, 'must not fabricate a snapshot');

  // Dust: a zero-fee buy whose cost basis vanished with it — the derived
  // birth is float dust (1e-9), not a real balance. Writing an anchor
  // there would weld % returns to noise.
  const dust = { cashSol: 1e-9, positions: {}, rounds: [], journal: [{ side: 'buy', ts: 1, solGross: 1, solNet: 1, feeSol: 0 }] };
  assert.strictEqual(E.backfillAnchor(dust, { balanceStartSol: 7 }), false, 'dust → no derived anchor');
});

test('D-56: anchorStartSol — legacy wallet reads the derived birth, NOT the live setting (jb repro)', () => {
  const { st } = legacyWallet();
  const truth = trueBirth(st);
  // jb's exact shape: wallet born at 10, setting later edited to 1.
  const anchored = E.anchorStartSol(st, { balanceStartSol: 1 });
  assert.ok(Math.abs(anchored - truth) < 1e-9,
    `anchor ${anchored} vs birth ${truth} — the setting (1) must lose`);
  // And the modern wallet still beats both.
  const modern = E.defaultState({ balanceStartSol: 25 });
  assert.strictEqual(E.anchorStartSol(modern, { balanceStartSol: 1 }), 25);
});

test('D-56: sessionStats — jb repro: +0.091 SOL stays +0.091 SOL after a 10→1 setting edit', () => {
  // Rebuild jb's numbers from the defect card: legacy wallet, born 10 SOL,
  // one round banked +0.091 SOL, setting edited to 1, then the full exit.
  const settings = E.defaultSettings();
  settings.feeBps = 0; // exact numbers, no fee noise
  const st = E.defaultState(settings);
  delete st.startSol;
  st.cashSol = 10;
  const price = 0.01;
  E.buy(st, settings, { mint: 'JB', symbol: 'JB', solAmount: 1, priceNative: price, ts: 100 });
  // exit at a price that banks exactly +0.091 SOL on the 1 SOL round
  E.sell(st, settings, { mint: 'JB', symbol: 'JB', qtyFraction: 1, priceNative: price * 1.091, ts: 200 });
  const eq = E.equitySol(st);
  assert.ok(Math.abs((eq - 10) - 0.091) < 1e-9, `fixture sanity: equity ${eq}, expected 10.091`);

  const stats = E.sessionStats(st, { balanceStartSol: 1 });
  // The old bug: equityVsStart = 10.091 − 1 = +9.091 (jb saw +9.109 with fees).
  // The fix: equityVsStart = 10.091 − 10 = +0.091.
  assert.ok(Math.abs(stats.equityVsStart - 0.091) < 1e-9,
    `jb repro: ${stats.equityVsStart} SOL — must be +0.091, not +9.091 (the 10→1 setting gap)`);
  // And the persisted backfill makes it survive even without the derived layer.
  E.backfillAnchor(st, settings);
  assert.ok(Math.abs(st.startSol - 10) < 1e-9, `persisted snapshot ${st.startSol}, expected 10`);
});

/* ---------------- source contracts: the read-only surfaces ---------------- */

test('D-56: popup carries the derived-anchor layer (self-contained, no engine.js)', () => {
  const src = read('popup.js');
  assert.match(src, /function derivedAnchor\(/, 'popup.js must define derivedAnchor');
  assert.match(src, /function anchorFor\(/, 'popup.js must define anchorFor');
  // Both anchor sites go through it — no raw setting fallback left in a
  // vs-start computation.
  assert.match(src, /equityVsStart: equity - anchorFor\(state, settings\)/);
  assert.match(src, /const anchor = anchorFor\(state, settings\)/);
  // The derived layer sits BETWEEN snapshot and setting.
  assert.match(src, /function anchorFor\(state, settings\) \{[\s\S]{0,220}?Number\(state && state\.startSol\)[\s\S]{0,220}?derivedAnchor\(state\)[\s\S]{0,220}?settings && settings\.balanceStartSol/s);
  // The derivation rule itself: buy debits its fee, sell credits its pnl.
  assert.match(src, /t\.side === 'buy'[\s\S]{0,300}?t\.feeSol[\s\S]{0,300}?t\.solGross[\s\S]{0,300}?t\.solNet/s);
  assert.match(src, /t\.side === 'sell'[\s\S]{0,160}?t\.pnlSol/s);
});

test('D-56: overlay carries the derived-anchor layer', () => {
  const src = read('overlay.js');
  assert.match(src, /function derivedAnchor\(/);
  assert.match(src, /function anchorFor\(/);
  assert.match(src, /equityVsStart: equity - anchorFor\(state, settings\)/);
  assert.match(src, /const anchor = anchorFor\(state, settings\)/);
});

test('D-56: background bridge denominates the chain replay on the derived birth', () => {
  const src = read('background.js');
  assert.match(src, /function derivedBirthAnchor\(state\)/);
  // bridgeRecord: snapshot → derived → setting, in that order.
  assert.match(src, /const start = \(Number\(state\.startSol\) \|\| 0\) > 0[\s\S]{0,200}?derivedBirthAnchor\(state\) > 0[\s\S]{0,200}?derivedBirthAnchor\(state\)[\s\S]{0,200}?settings\.balanceStartSol/s);
});

test('D-56: content.js + dashboard.js persist the backfill on first load', () => {
  const content = read('content.js');
  // reloadState: backfill after the stored state lands.
  assert.match(content, /if \(stored\[E\.STORAGE_KEYS\.state\]\) state = stored\[E\.STORAGE_KEYS\.state\];[\s\S]{0,400}?E\.backfillAnchor\(state, settings\)/s);
  // adoptState: backfill the adopted state before the re-render.
  assert.match(content, /function adoptState\(next\) \{[\s\S]{0,400}?state = next;[\s\S]{0,400}?E\.backfillAnchor\(state, settings\)/s);

  const dash = read('dashboard.js');
  assert.match(dash, /state = s\.pt_state \|\| E\.defaultState\(settings\);[\s\S]{0,800}?E\.backfillAnchor\(state, settings\)/s);
  assert.match(dash, /mutateState\(\(fresh\) => \{ E\.backfillAnchor\(fresh, settings\); \}\)/);
});

test('D-56: engine exports the derivation + backfill for the surfaces and tests', () => {
  for (const name of ['derivedBirthSol', 'backfillAnchor', 'stepOf']) {
    assert.strictEqual(typeof E[name], 'function', `engine must export ${name}`);
  }
});

test('D-56: popup freshState snapshots the birth balance (a popup-born wallet is not a legacy wallet)', () => {
  const src = read('popup.js');
  assert.match(src, /function freshState\(settings\) \{[\s\S]{0,300}?cashSol: settings\.balanceStartSol[,;][\s\S]{0,600}?startSol: settings\.balanceStartSol[,;]/s);
});

test('D-56: the curve and the backfill share ONE step rule (no drift)', () => {
  const { st } = legacyWallet();
  // The curve's anchor (derived from the SAME state, start = the true birth)
  // and the backfill's derivation must agree to float tolerance: they walk
  // the journal by the same stepOf, so the two anchors cannot diverge.
  const truth = trueBirth(st);
  const pts = E.equityCurvePoints(st, truth);
  assert.ok(pts.length >= 2, 'curve must have points');
  const derived = E.derivedBirthSol(st);
  assert.ok(Math.abs(pts[0].eq - derived) < 1e-9,
    `curve anchor ${pts[0].eq} vs derived ${derived} — two walks, two truths`);
});
