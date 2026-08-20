/* Lifetime flow stats — bought / held / sold SOL (jb, #ideas 2026-08-19:
 * "able to see how much u've bought/held/sold whilst trading").
 *
 * The engine test drives real buys/sells and derives every expectation from
 * the inputs; the popup test pins the journal-derived helper so historical
 * wallets (pre-feature states with no new accumulator) get correct numbers.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

global.window = global.window || {};
require('../engine.js');
const E = global.window.PaperEngine;

const ROOT = path.join(__dirname, '..');

function freshSettings(over) {
  return Object.assign(E.defaultSettings(), over || {});
}

const MINT_A = 'MintAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const MINT_B = 'MintBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
let clock = 1_800_000_000_000;
const tick = () => (clock += 5_000);

function buyAt(state, settings, mint, solAmt, priceNative) {
  const r = E.buy(state, settings, {
    mint, symbol: 'FLOW', site: 'gmgn', ts: tick(),
    solAmount: solAmt, priceNative, priceUsd: priceNative * 150,
  });
  assert.ok(!r.error, 'buy must fill: ' + JSON.stringify(r));
  return r;
}

function sellPct(state, settings, mint, pct, priceNative) {
  const r = E.sell(state, settings, {
    mint, qtyFraction: pct / 100, priceNative, priceUsd: priceNative * 150,
    ts: tick(), symbol: 'FLOW', site: 'gmgn',
  });
  assert.ok(!r.error, 'sell must fill: ' + JSON.stringify(r));
  return r;
}

test('flow stats: bought/held/sold track the journal and open cost basis', () => {
  const settings = freshSettings({ balanceStartSol: 10 });
  const state = E.defaultState(settings);

  // Nothing traded: all zeros.
  let stats = E.sessionStats(state, settings);
  assert.equal(stats.boughtSol, 0);
  assert.equal(stats.heldSol, 0);
  assert.equal(stats.soldSol, 0);

  // Buy 2 SOL of A at 0.001.
  buyAt(state, settings, MINT_A, 2, 0.001);
  stats = E.sessionStats(state, settings);
  const buy1Net = stats.boughtSol;
  assert.ok(Math.abs(buy1Net - 2) < 1e-6,
    `bought must be the journal's net SOL out (${buy1Net})`);
  assert.ok(Math.abs(stats.heldSol - buy1Net) < 1e-6,
    'a fully-open position holds exactly its cost');

  // Buy 1 more SOL of A — bought accumulates, held grows.
  buyAt(state, settings, MINT_A, 1, 0.002);
  stats = E.sessionStats(state, settings);
  const boughtAfterTwo = stats.boughtSol;
  assert.ok(Math.abs(boughtAfterTwo - 3) < 1e-6, 'bought accumulates across fills');
  assert.ok(Math.abs(stats.heldSol - boughtAfterTwo) < 1e-6, 'held tracks both fills');

  // Sell HALF of A back at 0.003 (ABOVE the ~0.00133 avg cost): sold is the
  // gross PROCEEDS — more SOL than half the cost, because price appreciated —
  // and held drops to the SURVIVING half of the cost basis.
  const halfExit = sellPct(state, settings, MINT_A, 50, 0.003);
  stats = E.sessionStats(state, settings);
  assert.ok(Math.abs(stats.soldSol - halfExit.trade.solGross) < 1e-6,
    `sold must equal the journal's sell gross proceeds (${stats.soldSol} vs ${halfExit.trade.solGross})`);
  assert.ok(stats.soldSol > boughtAfterTwo / 2,
    'selling half at a higher price returns MORE than half the cost in SOL');
  assert.ok(Math.abs(stats.heldSol - boughtAfterTwo / 2) < 1e-6,
    `held must be the surviving cost basis after a half exit (${stats.heldSol} vs ${boughtAfterTwo / 2})`);

  // Full exit: held returns to zero while bought/sold keep their totals.
  const fullExit = sellPct(state, settings, MINT_A, 100, 0.004);
  stats = E.sessionStats(state, settings);
  assert.equal(stats.heldSol, 0, 'a fully-exited position holds nothing');
  assert.ok(Math.abs(stats.boughtSol - boughtAfterTwo) < 1e-6, 'bought is lifetime, not open');
  assert.ok(Math.abs(stats.soldSol - halfExit.trade.solGross - fullExit.trade.solGross) < 1e-6,
    'sold is lifetime proceeds across both exits');
});

test('flow stats: two tokens hold independently', () => {
  const settings = freshSettings({ balanceStartSol: 10 });
  const state = E.defaultState(settings);

  buyAt(state, settings, MINT_A, 1, 0.001);
  buyAt(state, settings, MINT_B, 0.5, 0.01);

  const stats = E.sessionStats(state, settings);
  assert.ok(Math.abs(stats.boughtSol - 1.5) < 1e-6, 'bought spans both tokens');
  assert.ok(Math.abs(stats.heldSol - 1.5) < 1e-6, 'held spans both open positions');

  // Close only B: A still holds its full cost.
  sellPct(state, settings, MINT_B, 100, 0.02);
  const after = E.sessionStats(state, settings);
  assert.ok(Math.abs(after.heldSol - 1) < 1e-6, 'closing B leaves exactly A\u2019s cost held');
});

/* ---------------- popup helper ---------------- */

test('popup journalFlow derives bought/held/sold from a legacy state alone', () => {
  // A wallet from BEFORE the feature: journal rows + positions, nothing else.
  const popupSrc = fs.readFileSync(path.join(ROOT, 'popup.js'), 'utf8');
  const ctx = { console, Math, Number, Object, parseFloat };
  vm.createContext(ctx);
  const start = popupSrc.indexOf('function journalFlow(');
  const end = popupSrc.indexOf('/** Equity = cash');
  assert.ok(start !== -1 && end > start, 'journalFlow must exist in popup.js');
  vm.runInContext(popupSrc.slice(start, end), ctx);

  const journal = [
    { side: 'buy', solGross: 1.0, solNet: -0.99 },
    { side: 'buy', solGross: 2.0, solNet: -1.98 },
    { side: 'sell', solGross: 1.25, solNet: 1.2375 },
  ];
  const positions = {
    M1: { grossOpenCostSol: 1.5 },
    M2: { grossOpenCostSol: 0.25 },
  };
  const flow = ctx.journalFlow(journal, positions);
  assert.equal(flow.boughtSol, 3, 'bought = sum of buy solGross (order size)');
  assert.equal(flow.soldSol, 1.25, 'sold = sum of sell solGross (order size)');
  assert.equal(flow.heldSol, 1.75, 'held = surviving open cost basis');
});

test('dashboard surfaces the flow KPI', () => {
  const dash = fs.readFileSync(path.join(ROOT, 'dashboard.js'), 'utf8');
  assert.match(dash, /Flow — bought \/ held \/ sold/,
    'the sidebar KPI must exist');
  assert.match(dash, /stats\.boughtSol, 2\).*stats\.heldSol, 2\).*stats\.soldSol, 2/,
    'all three flow numbers must render');
});
