/* Tests for the shipped paper-trading engine (engine.js).
 *
 * These drive the real buy()/sell() entry points the overlay calls. Every
 * expectation is DERIVED from the inputs inside the test, so a change in the
 * engine's arithmetic fails here rather than being blessed by a pasted literal.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

// engine.js targets the browser; give it a window to install its global on.
global.window = global.window || {};
require('../engine.js');
const E = global.window.PaperEngine;

const CLOSE = 1e-9;

function freshSettings(over) {
  return Object.assign(E.defaultSettings(), over || {});
}

test('engine installs its public API on the browser global', () => {
  assert.equal(typeof E, 'object');
  for (const fn of ['buy', 'sell', 'defaultState', 'defaultSettings', 'sessionStats', 'markPosition']) {
    assert.equal(typeof E[fn], 'function', `${fn} must be exported`);
  }
});

/* ---------------- criterion 4: fresh wallet is empty ---------------- */

test('a fresh wallet starts at the configured balance with nothing pre-seeded', () => {
  const settings = freshSettings({ balanceStartSol: 10 });
  const state = E.defaultState(settings);

  assert.equal(state.cashSol, settings.balanceStartSol);
  assert.equal(Object.keys(state.positions).length, 0, 'no pre-seeded positions');
  assert.equal(state.journal.length, 0, 'no pre-seeded trades');
  assert.equal(state.rounds.length, 0, 'no pre-seeded round trips');
  assert.equal(state.stats.realizedPnlSol, 0);

  const stats = E.sessionStats(state, settings);
  assert.equal(stats.equitySol, settings.balanceStartSol);
  assert.equal(stats.openPositions, 0);
  assert.equal(stats.rounds, 0);
});

/* ---------------- F-48: fill price provenance receipts ---------------- */

test('F-48: a fill records its price provenance — source and age ride the journal row', () => {
  const settings = freshSettings();
  const state = E.defaultState(settings);
  const buy = E.buy(state, settings, {
    ts: 1_800_000_000_000, mint: 'MintProv', symbol: 'PROV', site: 'lute',
    priceNative: 1e-7, solAmount: 1, chain: 'solana',
    priceSource: 'chart-export', priceAgeMs: 412.7,
  });
  assert.equal(buy.trade.priceSource, 'chart-export');
  assert.equal(buy.trade.priceAgeMs, 413, 'age is stored as whole milliseconds');

  const sell = E.sell(state, settings, {
    ts: 1_800_000_060_000, mint: 'MintProv', qtyFraction: 1,
    priceNative: 1.2e-7, priceSource: 'onchain', priceAgeMs: 95,
  });
  assert.equal(sell.trade.priceSource, 'onchain');
  assert.equal(sell.trade.priceAgeMs, 95);
});

test('host supply provenance rides buy and sell journal rows', () => {
  const settings = freshSettings();
  const state = E.defaultState(settings);
  const witness = { source: 'axiom', url: 'https://axiom.trade/meme/MintSupply' };
  const buy = E.buy(state, settings, {
    ts: 1_800_000_000_000, mint: 'MintSupply', symbol: 'SUP', site: 'axiom',
    priceNative: 1e-7, solAmount: 1, supplySource: 'site-facts',
    hostSupplyWitness: witness,
  });
  assert.equal(buy.trade.supplySource, 'site-facts');
  assert.deepEqual(buy.trade.hostSupplyWitness, witness);
  const sell = E.sell(state, settings, {
    ts: 1_800_000_001_000, mint: 'MintSupply', site: 'axiom',
    qtyFraction: 0.5, priceNative: 1e-7,
    supplySource: 'site-facts', hostSupplyWitness: witness,
  });
  assert.equal(sell.trade.supplySource, 'site-facts');
  assert.deepEqual(sell.trade.hostSupplyWitness, witness);
});

test('F-48: absent provenance stays absent — no invented fields, no negative ages', () => {
  const settings = freshSettings();
  const state = E.defaultState(settings);
  const buy = E.buy(state, settings, {
    ts: 1, mint: 'MintBare', symbol: 'X', site: 'gmgn', priceNative: 1e-7, solAmount: 1,
  });
  assert.ok(!('priceSource' in buy.trade), 'no source claim without a source');
  assert.ok(!('priceAgeMs' in buy.trade), 'no age claim without a timestamp');

  const clocked = E.buy(state, settings, {
    ts: 2, mint: 'MintSkew', symbol: 'Y', site: 'gmgn', priceNative: 1e-7, solAmount: 1,
    priceSource: 'page-feed', priceAgeMs: -30,
  });
  assert.equal(clocked.trade.priceAgeMs, 0, 'clock skew clamps to zero, never a negative age');
});

test('a custom starting balance is honoured', () => {
  const settings = freshSettings({ balanceStartSol: 3.5 });
  assert.equal(E.defaultState(settings).cashSol, 3.5);
});

test('trade feedback is on by default; interrupting alerts stay opt-in', () => {
  const settings = E.defaultSettings();
  // A fill should be unmistakable out of the box.
  assert.equal(settings.tradeEffectsEnabled, true);
  assert.equal(settings.tradeSoundsEnabled, true);
  assert.equal(settings.averagePriceLinesEnabled, true);
  // Hidden-tab bells interrupt the user elsewhere, so they remain opt-in.
  assert.equal(settings.profitAlertsEnabled, false);
  assert.equal(settings.profitAlertPct, 10);
  // The positions bar can be dragged; its saved offsets default to "not yet set"
  // so the first paint auto-measures against the host header.
  assert.equal(Object.hasOwn(settings, 'positionsBarLeft'), true);
  assert.equal(Object.hasOwn(settings, 'positionsBarTop'), true);
  assert.equal(settings.positionsBarLeft, null);
  assert.equal(settings.positionsBarTop, null);
  assert.equal(settings.positionsBarEnabled, true);
});

test('profit alert levels cross once per configured threshold', () => {
  assert.equal(E.profitAlertLevel(9.99, 10), 0);
  assert.equal(E.profitAlertLevel(10, 10), 1);
  assert.equal(E.profitAlertLevel(27, 10), 2);
  assert.equal(E.profitAlertLevel(-12, 10), 0);
  assert.equal(E.profitAlertLevel(50, 0), 0);

  assert.equal(E.crossedProfitAlert(0, 10, 10), 1);
  assert.equal(E.crossedProfitAlert(1, 19.9, 10), null,
    'the +10% bell must not repeat while still inside that level');
  assert.equal(E.crossedProfitAlert(1, 20, 10), 2);
  assert.equal(E.crossedProfitAlert(2, 15, 10), null,
    'dropping below a prior level must not replay it');
  assert.equal(E.crossedProfitAlert(2, 31, 10), 3,
    'only the newest crossed level is returned after a jump');
});

/* ---------------- criterion 4: buy arithmetic ---------------- */

test('buy debits gross SOL and credits the fee-adjusted quantity', () => {
  const settings = freshSettings({ balanceStartSol: 10, feeBps: 100, slippageBps: 0 });
  const state = E.defaultState(settings);

  const spend = 1;
  const price = 0.00000003866;

  E.buy(state, settings, {
    ts: Date.now(), mint: 'MintA', symbol: 'BONK', site: 'padre',
    priceNative: price, priceUsd: 0.000002825, solAmount: spend,
  });

  // Expectation derived from the inputs, not copied from a run.
  const expectedFee = spend * (settings.feeBps / 10000);
  const expectedQty = (spend - expectedFee) / price;

  assert.ok(Math.abs(state.cashSol - (settings.balanceStartSol - spend)) < CLOSE,
    'cash must fall by the GROSS amount spent');

  const pos = state.positions.MintA;
  assert.ok(pos, 'a position must exist after buying');
  assert.ok(Math.abs(pos.qty - expectedQty) / expectedQty < 1e-12,
    `quantity must be (spend - fee) / price; got ${pos.qty}, expected ${expectedQty}`);
  assert.ok(Math.abs(pos.costSol - (spend - expectedFee)) < CLOSE);
  assert.ok(Math.abs(state.stats.feesPaidSol - expectedFee) < CLOSE);
  assert.equal(state.journal.length, 1);
  assert.equal(state.journal[0].side, 'buy');
});

test('a round keeps one stable replay session ID across all fills and closure', () => {
  const settings = freshSettings({ feeBps: 0 });
  const state = E.defaultState(settings);
  const t0 = Date.now();

  const first = E.buy(state, settings, {
    ts: t0, mint: 'MintReplay', symbol: 'RPL', name: 'Replay', site: 'padre', priceNative: 0.001, solAmount: 1,
  });
  const id = first.position.sessionId;
  assert.match(id, /^pts-/);
  assert.equal(first.trade.sessionId, id);

  const second = E.buy(state, settings, {
    ts: t0 + 1000, mint: 'MintReplay', symbol: 'RPL', site: 'padre', priceNative: 0.001, solAmount: 1,
  });
  assert.equal(second.trade.sessionId, id);
  const closed = E.sell(state, settings, {
    ts: t0 + 2000, mint: 'MintReplay', qtyFraction: 1, priceNative: 0.002,
  });
  assert.equal(closed.trade.sessionId, id);
  assert.equal(closed.round.sessionId, id);
  assert.equal(closed.round.name, 'Replay');
});

test('a legacy open position is upgraded with a replay session ID on its next fill', () => {
  const settings = freshSettings({ feeBps: 0 });
  const state = E.defaultState(settings);
  const t0 = Date.now();
  E.buy(state, settings, { ts: t0, mint: 'LegacyMint', symbol: 'OLD', priceNative: 0.001, solAmount: 1 });
  delete state.positions.LegacyMint.sessionId;

  const sold = E.sell(state, settings, { ts: t0 + 1000, mint: 'LegacyMint', qtyFraction: 0.5, priceNative: 0.001 });
  assert.match(sold.trade.sessionId, /^pts-/);
  assert.equal(state.positions.LegacyMint.sessionId, sold.trade.sessionId);
});

test('buying more than the balance is refused and leaves state untouched', () => {
  const settings = freshSettings({ balanceStartSol: 1 });
  const state = E.defaultState(settings);

  assert.throws(() => E.buy(state, settings, {
    ts: Date.now(), mint: 'MintA', symbol: 'X', priceNative: 0.001, solAmount: 5,
  }), /Insufficient/i);

  assert.equal(state.cashSol, 1, 'cash must be unchanged after a refused buy');
  assert.equal(Object.keys(state.positions).length, 0);
});

test('a non-positive price is refused', () => {
  const settings = freshSettings();
  const state = E.defaultState(settings);
  assert.throws(() => E.buy(state, settings, {
    ts: Date.now(), mint: 'MintA', symbol: 'X', priceNative: 0, solAmount: 1,
  }));
});

/* ---------------- criterion 4: full round trip ---------------- */

test('buy then full sell produces correct cash, P&L and exactly one round trip', () => {
  const settings = freshSettings({ balanceStartSol: 10, feeBps: 100, slippageBps: 0 });
  const state = E.defaultState(settings);

  const spend = 1;
  const entry = 0.001;
  const exit = 0.002; // a clean 2x
  const t0 = Date.now();

  E.buy(state, settings, {
    ts: t0, mint: 'MintA', symbol: 'BONK', site: 'padre', priceNative: entry, solAmount: spend,
  });

  const qty = state.positions.MintA.qty;
  const costBasis = state.positions.MintA.costSol;

  const res = E.sell(state, settings, {
    ts: t0 + 60000, mint: 'MintA', qtyFraction: 1, priceNative: exit,
  });

  // Derive the expected exit economics from the inputs.
  const grossOut = qty * exit;
  const exitFee = grossOut * (settings.feeBps / 10000);
  const netOut = grossOut - exitFee;
  const expectedRealized = netOut - costBasis;

  assert.ok(Math.abs(res.trade.pnlSol - expectedRealized) < CLOSE,
    `realized P&L must equal netOut - costBasis; got ${res.trade.pnlSol}, expected ${expectedRealized}`);

  const expectedCash = settings.balanceStartSol - spend + netOut;
  assert.ok(Math.abs(state.cashSol - expectedCash) < CLOSE,
    `cash must be start - spend + netOut; got ${state.cashSol}, expected ${expectedCash}`);

  assert.equal(Object.keys(state.positions).length, 0, 'a full exit must close the position');
  assert.equal(state.rounds.length, 1, 'a full exit must append exactly one round trip');

  const round = state.rounds[0];
  assert.ok(Math.abs(round.investedSol - spend) < CLOSE);
  assert.ok(Math.abs(round.returnedSol - netOut) < CLOSE);
  assert.ok(Math.abs(round.pnlSol - (netOut - spend)) < CLOSE,
    'round P&L is measured against gross invested');
  assert.equal(round.heldMs, 60000);
  assert.ok(round.pnlSol > 0, 'a 2x must be profitable after 1% fees per side');
});

test('a partial sell keeps the position open and books no round trip', () => {
  const settings = freshSettings({ balanceStartSol: 10, feeBps: 100, slippageBps: 0 });
  const state = E.defaultState(settings);
  const t0 = Date.now();

  E.buy(state, settings, { ts: t0, mint: 'MintA', symbol: 'X', priceNative: 0.001, solAmount: 1 });
  const qtyBefore = state.positions.MintA.qty;

  const res = E.sell(state, settings, { ts: t0 + 1000, mint: 'MintA', qtyFraction: 0.5, priceNative: 0.002 });

  assert.equal(res.round, null, 'a partial exit must not close a round trip');
  assert.equal(state.rounds.length, 0);
  assert.ok(Math.abs(state.positions.MintA.qty - qtyBefore * 0.5) / qtyBefore < 1e-12,
    'half the quantity must remain');
});

test('averageFillPrices uses quantity-weighted paper buys and sells', () => {
  const settings = freshSettings({ balanceStartSol: 10, feeBps: 0, slippageBps: 0 });
  const state = E.defaultState(settings);
  const t0 = Date.now();

  E.buy(state, settings, {
    ts: t0, mint: 'MintA', symbol: 'X', priceNative: 0.001, priceUsd: 0.20, solAmount: 1,
  });
  E.buy(state, settings, {
    ts: t0 + 1000, mint: 'MintA', symbol: 'X', priceNative: 0.002, priceUsd: 0.40, solAmount: 1,
  });
  E.sell(state, settings, {
    ts: t0 + 2000, mint: 'MintA', qtyFraction: 0.25, priceNative: 0.003, priceUsd: 0.60,
  });
  E.sell(state, settings, {
    ts: t0 + 3000, mint: 'MintA', qtyFraction: 0.25, priceNative: 0.004, priceUsd: 0.80,
  });

  const fills = state.journal.filter((t) => t.mint === 'MintA');
  const weighted = (side, key) => {
    const selected = fills.filter((t) => t.side === side);
    const qty = selected.reduce((sum, t) => sum + t.qty, 0);
    return selected.reduce((sum, t) => sum + t.qty * t[key], 0) / qty;
  };
  const averages = E.averageFillPrices(state, 'MintA');

  assert.ok(Math.abs(averages.avgBuyNative - weighted('buy', 'priceNative')) < CLOSE);
  assert.ok(Math.abs(averages.avgBuyUsd - weighted('buy', 'priceUsd')) < CLOSE);
  assert.ok(Math.abs(averages.avgSellNative - weighted('sell', 'priceNative')) < CLOSE);
  assert.ok(Math.abs(averages.avgSellUsd - weighted('sell', 'priceUsd')) < CLOSE);
});

test('averageFillPrices persists from the latest round after a full close', () => {
  const settings = freshSettings({ balanceStartSol: 10, feeBps: 0, slippageBps: 0 });
  const state = E.defaultState(settings);
  const t0 = Date.now();

  E.buy(state, settings, {
    ts: t0, mint: 'MintA', symbol: 'X', priceNative: 0.001, priceUsd: 0.20, solAmount: 1,
  });
  E.sell(state, settings, {
    ts: t0 + 1000, mint: 'MintA', qtyFraction: 1, priceNative: 0.002, priceUsd: 0.40,
  });

  assert.equal(state.positions.MintA, undefined);
  const averages = E.averageFillPrices(state, 'MintA');
  assert.equal(averages.avgBuyUsd, 0.20);
  assert.equal(averages.avgSellUsd, 0.40);
});

test('latestClosedPnl reports the realized result of a partial sell', () => {
  const settings = freshSettings({ balanceStartSol: 10, feeBps: 100, slippageBps: 0 });
  const state = E.defaultState(settings);
  const t0 = Date.now();

  E.buy(state, settings, { ts: t0, mint: 'MintA', symbol: 'X', priceNative: 0.001, solAmount: 1 });
  const { trade } = E.sell(state, settings, {
    ts: t0 + 1000, mint: 'MintA', qtyFraction: 0.5, priceNative: 0.002,
  });

  const closed = E.latestClosedPnl(state, 'MintA');
  assert.equal(closed.kind, 'partial');
  assert.equal(closed.closedAt, trade.ts);
  assert.ok(Math.abs(closed.pnlSol - trade.pnlSol) < CLOSE);
  assert.ok(closed.pnlPct > 0, 'a profitable partial exit must show a positive realized percentage');
  assert.ok(Math.abs(closed.returnedSol - trade.solNet) < CLOSE);
});

test('latestClosedPnl switches to full round-trip P&L after the final sell', () => {
  const settings = freshSettings({ balanceStartSol: 10, feeBps: 100, slippageBps: 0 });
  const state = E.defaultState(settings);
  const t0 = Date.now();

  E.buy(state, settings, { ts: t0, mint: 'MintA', symbol: 'X', priceNative: 0.001, solAmount: 1 });
  E.sell(state, settings, { ts: t0 + 1000, mint: 'MintA', qtyFraction: 0.5, priceNative: 0.0015 });
  const { round } = E.sell(state, settings, {
    ts: t0 + 2000, mint: 'MintA', qtyFraction: 1, priceNative: 0.002,
  });

  const closed = E.latestClosedPnl(state, 'MintA');
  assert.equal(closed.kind, 'round');
  assert.ok(Math.abs(closed.pnlSol - round.pnlSol) < CLOSE);
  assert.ok(Math.abs(closed.pnlPct - round.pnlPct) < CLOSE);
  assert.ok(Math.abs(closed.returnedSol - round.returnedSol) < CLOSE);
});

test('selling with no open position is refused', () => {
  const settings = freshSettings();
  const state = E.defaultState(settings);
  assert.throws(() => E.sell(state, settings, {
    ts: Date.now(), mint: 'Nope', qtyFraction: 1, priceNative: 0.001,
  }), /No open paper position/i);
});

test('a losing round trip books a negative realized P&L', () => {
  const settings = freshSettings({ balanceStartSol: 10, feeBps: 100, slippageBps: 0 });
  const state = E.defaultState(settings);
  const t0 = Date.now();

  E.buy(state, settings, { ts: t0, mint: 'MintA', symbol: 'X', priceNative: 0.001, solAmount: 1 });
  E.sell(state, settings, { ts: t0 + 5000, mint: 'MintA', qtyFraction: 1, priceNative: 0.0005 });

  const round = state.rounds[0];
  assert.ok(round.pnlSol < 0, 'halving the price must lose money');
  assert.ok(state.cashSol < settings.balanceStartSol);
  assert.equal(E.sessionStats(state, settings).wins, 0);
});

test('fees make a flat round trip a net loss', () => {
  const settings = freshSettings({ balanceStartSol: 10, feeBps: 100, slippageBps: 0 });
  const state = E.defaultState(settings);
  const t0 = Date.now();
  const price = 0.001;

  E.buy(state, settings, { ts: t0, mint: 'MintA', symbol: 'X', priceNative: price, solAmount: 1 });
  E.sell(state, settings, { ts: t0 + 1000, mint: 'MintA', qtyFraction: 1, priceNative: price });

  assert.ok(state.rounds[0].pnlSol < 0, 'round-tripping at the same price must lose the fees');
  assert.ok(state.cashSol < settings.balanceStartSol);
});

/* ---------------- marking positions ---------------- */

test('markPosition tracks peak and trough unrealized P&L', () => {
  const settings = freshSettings({ feeBps: 0, slippageBps: 0 });
  const state = E.defaultState(settings);
  const t0 = Date.now();

  E.buy(state, settings, { ts: t0, mint: 'MintA', symbol: 'X', priceNative: 0.001, solAmount: 1 });

  E.markPosition(state, 'MintA', 0.003); // up
  E.markPosition(state, 'MintA', 0.0005); // down

  const pos = state.positions.MintA;
  assert.ok(pos.peakPnlSol > 0, 'peak must record the profitable excursion');
  assert.ok(pos.troughPnlSol < 0, 'trough must record the drawdown');
  assert.ok(pos.peakPnlSol > pos.troughPnlSol);
});

test('equity reflects cash plus marked position value', () => {
  const settings = freshSettings({ balanceStartSol: 10, feeBps: 0, slippageBps: 0 });
  const state = E.defaultState(settings);

  E.buy(state, settings, { ts: Date.now(), mint: 'MintA', symbol: 'X', priceNative: 0.001, solAmount: 2 });
  E.markPosition(state, 'MintA', 0.002); // position doubles

  const pos = state.positions.MintA;
  const expectedEquity = state.cashSol + pos.qty * 0.002;
  assert.ok(Math.abs(E.equitySol(state) - expectedEquity) < CLOSE);
  assert.ok(E.equitySol(state) > settings.balanceStartSol, 'a 2x on half the wallet must raise equity');
});

/* ---------------- settings migration ---------------- */

test('an existing install adopts the new feedback defaults exactly once', () => {
  // Stored settings normally beat defaults, so a user who installed while these
  // were off would never see them without an explicit migration.
  const legacy = {
    balanceStartSol: 10,
    tradeEffectsEnabled: false,
    tradeSoundsEnabled: false,
    averagePriceLinesEnabled: false,
  };

  const migrated = E.mergeSettings(legacy);
  assert.equal(migrated.tradeEffectsEnabled, true);
  assert.equal(migrated.tradeSoundsEnabled, true);
  assert.equal(migrated.averagePriceLinesEnabled, true);
  assert.equal(migrated.settingsRevision, E.SETTINGS_REVISION);
  assert.equal(migrated.balanceStartSol, 10, 'unrelated settings must survive');
});

test('a deliberate opt-out after the migration is never overridden', () => {
  const optedOut = {
    settingsRevision: E.SETTINGS_REVISION,
    tradeEffectsEnabled: false,
    tradeSoundsEnabled: false,
    averagePriceLinesEnabled: false,
  };

  const merged = E.mergeSettings(optedOut);
  assert.equal(merged.tradeEffectsEnabled, false,
    'once migrated, the user\'s own choice wins');
  assert.equal(merged.tradeSoundsEnabled, false);
  assert.equal(merged.averagePriceLinesEnabled, false);
});

test('mergeSettings on a fresh install just returns the defaults', () => {
  const fresh = E.mergeSettings(null);
  assert.equal(fresh.tradeEffectsEnabled, true);
  assert.equal(fresh.balanceStartSol, E.DEFAULT_SETTINGS.balanceStartSol);
  assert.equal(fresh.aiEndpoint, '', 'fresh install ships with no AI endpoint');
  assert.equal(fresh.aiAllowLocalEndpoint, false, 'fresh install defaults local/private AI off');
});

test('mergeSettings migrates the old default local AI endpoint away', () => {
  const legacy = {
    settingsRevision: 3,
    aiEndpoint: 'http://127.0.0.1:8765/v1',
  };
  const migrated = E.mergeSettings(legacy);
  assert.equal(migrated.aiEndpoint, '', 'old default local endpoint is cleared');
  assert.equal(migrated.aiAllowLocalEndpoint, false, 'local/private opt-in defaults off');
  assert.equal(migrated.settingsRevision, E.SETTINGS_REVISION);
});

test('mergeSettings preserves a deliberately chosen public AI endpoint', () => {
  const custom = {
    settingsRevision: 3,
    aiEndpoint: 'https://ai.example.com/v1',
  };
  const merged = E.mergeSettings(custom);
  assert.equal(merged.aiEndpoint, 'https://ai.example.com/v1');
  assert.equal(merged.aiAllowLocalEndpoint, false);
});

test('revision 5 adds the trade-tab buy toggles, on by default', () => {
  // An install saved under revision 4 has no record of the new keys; the
  // migration adopts the defaults once so the buy section stays visible.
  const rev4 = { settingsRevision: 4, balanceStartSol: 7 };

  const migrated = E.mergeSettings(rev4);
  assert.equal(migrated.panelBuyEnabled, true);
  assert.equal(migrated.panelPresetsEnabled, true);
  assert.equal(migrated.settingsRevision, E.SETTINGS_REVISION);
  assert.equal(migrated.balanceStartSol, 7, 'unrelated settings must survive');

  // And a deliberate opt-out recorded at revision 5 is never overridden.
  const optedOut = { settingsRevision: 5, panelBuyEnabled: false, panelPresetsEnabled: false };
  const merged = E.mergeSettings(optedOut);
  assert.equal(merged.panelBuyEnabled, false);
  assert.equal(merged.panelPresetsEnabled, false);
});

test('revision 6 persists the positions bar collapse state', () => {
  // An install saved under revision 5 has never seen the key; the migration
  // adopts the expanded default ONCE so nobody's bar collapses uninvited.
  const rev5 = { settingsRevision: 5, balanceStartSol: 7 };

  const migrated = E.mergeSettings(rev5);
  assert.equal(migrated.positionsBarHidden, false, 'the bar starts expanded after migration');
  assert.equal(migrated.settingsRevision, E.SETTINGS_REVISION);
  assert.equal(migrated.balanceStartSol, 7, 'unrelated settings must survive');

  // And a deliberate collapse recorded at revision 6 is never overridden by
  // a later migration.
  const collapsed = { settingsRevision: E.SETTINGS_REVISION, positionsBarHidden: true };
  const merged = E.mergeSettings(collapsed);
  assert.equal(merged.positionsBarHidden, true);
});

test('revision 7 clears orphaned AI credentials left behind with no usable endpoint', () => {
  // An install that stored a key/model for the removed insecure local default
  // (or for no endpoint at all) would silently send that stale key to whatever
  // endpoint the user pastes next. The migration clears the orphans once.
  const rev6 = {
    settingsRevision: 6,
    aiEndpoint: 'http://127.0.0.1:8765/v1',
    aiApiKey: 'stale-key',
    aiModel: 'stale-model',
    balanceStartSol: 7,
  };
  const migrated = E.mergeSettings(rev6);
  assert.equal(migrated.aiApiKey, '', 'orphaned API key is cleared');
  assert.equal(migrated.aiModel, '', 'orphaned model is cleared');
  assert.equal(migrated.settingsRevision, E.SETTINGS_REVISION);
  assert.equal(migrated.balanceStartSol, 7, 'unrelated settings must survive');

  // Credentials tied to a deliberately configured public endpoint survive.
  const configured = {
    settingsRevision: 6,
    aiEndpoint: 'https://ai.example.com/v1',
    aiApiKey: 'live-key',
    aiModel: 'live-model',
  };
  const kept = E.mergeSettings(configured);
  assert.equal(kept.aiApiKey, 'live-key');
  assert.equal(kept.aiModel, 'live-model');

  // A local-endpoint user who explicitly opted in keeps their credentials too.
  const optedIn = {
    settingsRevision: 6,
    aiEndpoint: 'http://127.0.0.1:8765/v1',
    aiAllowLocalEndpoint: true,
    aiApiKey: 'local-key',
  };
  const keptLocal = E.mergeSettings(optedIn);
  assert.equal(keptLocal.aiApiKey, 'local-key',
    'an explicit local opt-in is a deliberate choice and is never wiped');
});

/* ---------------- reset must outrun in-flight writers ----------------
 *
 * Reported defect: after a reset, the old wallet reappeared. Root cause: the
 * reset wrote seq 0, and any still-open trading tab holding the pre-reset
 * state (seq N > 0) saw storage as NOT newer, so its next heartbeat mark
 * clobbered the reset and resurrected the old wallet.
 */
test('resetState inherits the write counter so the reset wins the race', () => {
  const settings = freshSettings({ balanceStartSol: 10 });

  // A tab mid-session has written the wallet 50 times.
  const inFlightSeq = 50;
  const fresh = E.resetState(settings, inFlightSeq);

  assert.ok(fresh.seq > inFlightSeq,
    'the reset state must be strictly newer than anything a running tab holds');
  assert.equal(fresh.cashSol, settings.balanceStartSol, 'the reset is still a fresh wallet');
  assert.equal(Object.keys(fresh.positions).length, 0);
});

test('a reset with no known prior state starts just above zero', () => {
  const fresh = E.resetState(freshSettings());
  assert.ok(fresh.seq >= 1, 'even a first-ever reset must not sit at seq 0');
});

/* ---------------- reported: avg fills not accurate ----------------
 *
 * The USD average used to weight only the fills that happened to record a
 * USD price. Fresh-launch fills often pre-date the USD tick (priceUsd: null),
 * so the displayed "Avg. Fill Price" covered a SUBSET of the real fills —
 * e.g. 1 of 3 buys. The honest answer when the USD set is incomplete is
 * null, and content.js already derives USD from the complete native average
 * at the live SOL/USD rate in that case.
 */
test('the USD average refuses to cover only the fills that recorded USD', () => {
  const settings = freshSettings({ balanceStartSol: 10, feeBps: 0, slippageBps: 0 });
  const state = E.defaultState(settings);
  const t0 = Date.now();

  // Three buys: the first two pre-date the USD tick (fresh launch), the
  // third has it. A partial-coverage USD average would be the bug.
  E.buy(state, settings, { ts: t0, mint: 'MintB', symbol: 'Y', priceNative: 0.001, priceUsd: null, solAmount: 1 });
  E.buy(state, settings, { ts: t0 + 1000, mint: 'MintB', symbol: 'Y', priceNative: 0.002, priceUsd: null, solAmount: 1 });
  E.buy(state, settings, { ts: t0 + 2000, mint: 'MintB', symbol: 'Y', priceNative: 0.004, priceUsd: 0.80, solAmount: 1 });

  const averages = E.averageFillPrices(state, 'MintB');

  assert.equal(averages.avgBuyUsd, null,
    'an incomplete USD set must yield null, never a subset-weighted number');
  // The native average must still cover ALL three fills, quantity-weighted.
  const fills = state.journal.filter((t) => t.mint === 'MintB' && t.side === 'buy');
  const qty = fills.reduce((s, t) => s + t.qty, 0);
  const native = fills.reduce((s, t) => s + t.qty * t.priceNative, 0) / qty;
  assert.ok(Math.abs(averages.avgBuyNative - native) < CLOSE,
    'the native average is the ground truth and must cover every fill');
});

test('the USD average is used directly when every fill recorded USD', () => {
  const settings = freshSettings({ balanceStartSol: 10, feeBps: 0, slippageBps: 0 });
  const state = E.defaultState(settings);
  const t0 = Date.now();

  E.buy(state, settings, { ts: t0, mint: 'MintC', symbol: 'Z', priceNative: 0.001, priceUsd: 0.20, solAmount: 1 });
  E.buy(state, settings, { ts: t0 + 1000, mint: 'MintC', symbol: 'Z', priceNative: 0.002, priceUsd: 0.40, solAmount: 1 });

  const averages = E.averageFillPrices(state, 'MintC');
  assert.ok(averages.avgBuyUsd > 0, 'complete USD coverage keeps the recorded USD average');
});
