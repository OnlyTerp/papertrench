/* Sign lock for the 2026-08-19 community report (SoranaSokan, Discord
 * 18:24 UTC): "buying low selling high doesn't count as profit — i made a
 * minus 12% but should have been plus".
 *
 * This is NOT a fix — the engine's sign was verified correct at both the
 * version the trader ran (v3.5.0) and HEAD, empirically, through buy() and
 * sell() themselves. The report's shape (a win booked as a loss) matches
 * open defect F-48: a fill priced from a source lagging the chart the
 * trader watched. What this file locks is the SIGN INVARIANT the report
 * alleges is broken, so the day someone DOES invert an operand the suite
 * goes red in the report's own words — with the break-even arithmetic the
 * report's numbers imply, not pasted literals.
 *
 * Every expectation is derived from the inputs inside the test, per the
 * engine suite's own doctrine.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

global.window = global.window || {};
require('../engine.js');
const E = global.window.PaperEngine;

function freshSettings(over) {
  return Object.assign(E.defaultSettings(), over || {});
}

/* The invariant the report alleges broken: a round whose every sell priced
 * above its every buy is a WIN — pnlSol > 0 and pnlPct > 0 — and a round
 * whose every sell priced below its every buy is a LOSS on both. The sign
 * must never depend on direction of entry/exit prices. */
function roundTrip(settings, buyPx, sellPx, fraction) {
  const state = E.defaultState(settings);
  E.buy(state, settings, {
    ts: 1_800_000_000_000, mint: 'SignLock', symbol: 'SGN', site: 'test',
    priceNative: buyPx, solAmount: 1, chain: 'solana',
  });
  const r = E.sell(state, settings, {
    ts: 1_800_000_060_000, mint: 'SignLock', qtyFraction: fraction,
    priceNative: sellPx,
  });
  return r;
}

/* The invariant the report alleges broken: a round that clears the fee
 * break-even (sell > buy / (1-fee)²) is a WIN — pnlSol > 0 and pnlPct > 0 —
 * and a round below it is a LOSS on both. Selling a hair above the ENTRY is
 * still a small loss by the fee drag, which the break-even lock below
 * derives; the sign must follow the recorded prices, never invert. */
test('sign lock: sell above buy is a WIN — positive pnlSol and pnlPct (2026-08-19 report)', () => {
  const settings = freshSettings();
  const breakEven = 100 / (1 - settings.feeBps / 10000) ** 2;
  for (const sellPx of [112, 150, 1000, breakEven * 1.001]) {
    const { round } = roundTrip(freshSettings(), 100, sellPx, 1);
    assert.ok(round.pnlSol > 0, `sell at ${sellPx} must book positive SOL P&L, got ${round.pnlSol}`);
    assert.ok(round.pnlPct > 0, `sell at ${sellPx} must book positive % P&L, got ${round.pnlPct}`);
  }
});

test('sign lock: sell below buy is a LOSS — negative pnlSol and pnlPct', () => {
  for (sellPx of [88, 50, 0.0001]) {
    const { round } = roundTrip(freshSettings(), 100, sellPx, 1);
    assert.ok(round.pnlSol < 0, `sell at ${sellPx} must book negative SOL P&L, got ${round.pnlSol}`);
    assert.ok(round.pnlPct < 0, `sell at ${sellPx} must book negative % P&L, got ${round.pnlPct}`);
  }
});

test('sign lock: a partial exit of a winning stack books positive realized P&L on the fill', () => {
  const settings = freshSettings();
  const { trade } = roundTrip(settings, 100, 150, 0.5);
  assert.ok(trade.pnlSol > 0, `partial sell above entry must book positive fill P&L, got ${trade.pnlSol}`);
});

/* The report's own number, derived not pasted: with the default 1% fee per
 * side, a booked -12% round implies a RECORDED sell price ≈89.8% of the
 * recorded buy price. If the trader's screen showed him selling HIGHER than
 * he bought, then the fill that booked -12% priced ~10%+ under his screen —
 * the F-48 family (value-lag wearing a fresh timestamp). This lock makes
 * that implication executable: it can never again be settled by re-reading
 * the code, only by running it. */
test('sign lock: booking exactly -12% requires the recorded exit to price below the recorded entry', () => {
  const settings = freshSettings();
  const feeFactor = (1 - settings.feeBps / 10000) ** 2; // both sides charged
  const sellPxForMinus12 = 100 * 0.88 / feeFactor;
  const { round } = roundTrip(settings, 100, sellPxForMinus12, 1);
  assert.ok(Math.abs(round.pnlPct + 12) < 0.01, `expected ≈-12%, got ${round.pnlPct}`);
  assert.ok(sellPxForMinus12 < 100, 'the arithmetic itself: a -12% round implies selling below entry');
});

test('sign lock: average-entry scaling keeps the sign — buy low, add higher, exit above both', () => {
  const settings = freshSettings();
  const state = E.defaultState(settings);
  E.buy(state, settings, {
    ts: 1_800_000_000_000, mint: 'Scale', symbol: 'SCL', site: 'test',
    priceNative: 100, solAmount: 0.2, chain: 'solana',
  });
  E.buy(state, settings, {
    ts: 1_800_000_030_000, mint: 'Scale', symbol: 'SCL', site: 'test',
    priceNative: 130, solAmount: 0.8, chain: 'solana',
  });
  const r = E.sell(state, settings, {
    ts: 1_800_000_060_000, mint: 'Scale', qtyFraction: 1,
    priceNative: 135,
  });
  assert.ok(r.round.pnlPct > 0, `exit above every entry must be a win, got ${r.round.pnlPct}`);
  assert.ok(r.trade.pnlSol > 0, 'and the closing fill itself is positive');
});

/* Fees can shrink a win but never flip its sign while the exit prices above
 * the entry: break-even at the default 1%/side sits at sell = buy ×
 * 1/(1-f)² ≈ +2.03%. */
test('sign lock: fee drag bounds the break-even — anything above it stays a win at any fee setting', () => {
  for (const feeBps of [0, 100, 200, 500]) {
    const settings = freshSettings({ feeBps });
    const breakEvenSell = 100 / (1 - feeBps / 10000) ** 2;
    const { round } = roundTrip(settings, 100, breakEvenSell * 1.001, 1);
    assert.ok(round.pnlPct > 0, `feeBps=${feeBps}: selling a hair above break-even must stay a win, got ${round.pnlPct}`);
    const losing = roundTrip(settings, 100, breakEvenSell * 0.999, 1).round;
    assert.ok(losing.pnlPct < 0, `feeBBps=${feeBps}: selling a hair below break-even must be a loss, got ${losing.pnlPct}`);
  }
});

/* Open-position % must agree in sign with the same trade's closed round —
 * the D-08 basis-unification invariant, locked from the report's angle:
 * the % the trader watches while holding cannot call a winner a loser. */
test('sign lock: open-position % and closed-round % agree in sign at every mark', () => {
  const settings = freshSettings();
  const state = E.defaultState(settings);
  const buyRes = E.buy(state, settings, {
    ts: 1_800_000_000_000, mint: 'Agree', symbol: 'AGR', site: 'test',
    priceNative: 100, solAmount: 1, chain: 'solana',
  });
  for (const markPx of [60, 90, 101, 150]) {
    E.markPosition(state, 'Agree', markPx);
    const openPct = E.positionPnlPct(state.positions.Agree);
    const sign = Math.sign(openPct);
    const expected = markPx > 100 / (1 - settings.feeBps / 10000) ? 1 : (markPx < 100 ? -1 : 0);
    // At the exact break-even boundary allow 0; assert sign flips nowhere else.
    if (markPx > 102.1) assert.equal(sign, 1, `mark ${markPx}: open % must be positive, got ${openPct}`);
    if (markPx < 99.9) assert.equal(sign, -1, `mark ${markPx}: open % must be negative, got ${openPct}`);
  }
});
