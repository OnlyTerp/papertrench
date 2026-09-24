/* Auto exits — TP/SL presets armed after every buy, plus the trailing stop.
 *
 * s0berr's ask: "presets for TP and SL and trailing SL so I don't have to
 * set them after every buy." What is locked here:
 *
 *   - 'trail' is an order kind: its trigger rides the peak (peak × (1 − pct))
 *     and fires on the honest-fill rule — the observed price, never the level
 *   - armAutoExits re-bases the configured set on the position's AVERAGE
 *     entry inside the buy mutation, replacing only auto:true orders —
 *     manually armed levels are never touched
 *   - MAX_ORDERS_PER_MINT bounds the whole list; legs that do not fit are
 *     skipped and reported, never silently dropped into a partial set
 *   - disabled = no orders, empty legs = off
 */
const test = require('node:test');
const assert = require('node:assert/strict');

global.window = global.window || {};
require('../engine.js');
const E = global.window.PaperEngine;

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const T0 = 1_700_000_000_000;

function settingsWith(over) {
  return E.mergeSettings(Object.assign({
    feeBps: 0, slippageBps: 0, gasSolPerTx: 0, tipSolPerTx: 0,
  }, over || {}));
}

function walletWithPosition(price = 0.001, sol = 1, over) {
  const settings = settingsWith(over);
  const state = E.defaultState(settings);
  E.buy(state, settings, { mint: MINT, symbol: 'BONK', solAmount: sol, priceNative: price, ts: T0 });
  return { state, settings };
}

/* ---------------- trailing stop: the order model ---------------- */

test('a trailing stop normalizes to peak + derived trigger', () => {
  const o = E.normalizeOrder({ kind: 'trail', trailPct: 25 }, 0.001, T0);
  assert.equal(o.kind, 'trail');
  assert.equal(o.trailPct, 25);
  assert.equal(o.peakPrice, 0.001);
  assert.equal(o.triggerPrice, 0.00075);
});

test('trailPct is clamped to 1..95 and junk is refused', () => {
  assert.equal(E.normalizeOrder({ kind: 'trail', trailPct: 'abc' }, 0.001, T0), null);
  assert.equal(E.normalizeOrder({ kind: 'trail' }, 0.001, T0), null);
  assert.equal(E.normalizeOrder({ kind: 'trail', trailPct: 0 }, 0.001, T0).trailPct, 1);
  assert.equal(E.normalizeOrder({ kind: 'trail', trailPct: 200 }, 0.001, T0).trailPct, 95);
  // No reference and no carried peak: nothing to trail from.
  assert.equal(E.normalizeOrder({ kind: 'trail', trailPct: 25 }, null, T0), null);
});

test('updateTrailPeaks ratchets the trigger up with the peak, never down', () => {
  const { state } = walletWithPosition(0.001);
  E.addOrder(state, MINT, { kind: 'trail', trailPct: 25 }, 0.001, T0);
  const o = E.ordersFor(state, MINT)[0];

  assert.equal(E.updateTrailPeaks(state, MINT, 0.0015), true);
  assert.equal(o.peakPrice, 0.0015);
  assert.ok(Math.abs(o.triggerPrice - 0.001125) < 1e-12);

  // A dip below the peak moves nothing — the stop holds its level.
  assert.equal(E.updateTrailPeaks(state, MINT, 0.0012), false);
  assert.ok(Math.abs(o.triggerPrice - 0.001125) < 1e-12);

  // Junk inputs are ignored.
  assert.equal(E.updateTrailPeaks(state, MINT, NaN), false);
  assert.equal(E.updateTrailPeaks(state, MINT, -1), false);
});

test('a trailing stop fires when price falls to its level and fills at the observed price', () => {
  const { state, settings } = walletWithPosition(0.001);
  const order = E.addOrder(state, MINT, { kind: 'trail', trailPct: 25, sizePct: 100 }, 0.001, T0);
  E.updateTrailPeaks(state, MINT, 0.002); // doubled — trigger now 0.0015

  // Above the trigger: nothing fires.
  assert.equal(E.triggeredOrders(state, MINT, 0.0016).length, 0);
  // A gap straight THROUGH the level still fires — and the trade records
  // what was asked vs what the market gave (the honest-fill rule).
  const due = E.triggeredOrders(state, MINT, 0.0012);
  assert.equal(due.length, 1);
  assert.equal(due[0].id, order.id);
  const fill = E.sell(state, settings, {
    ts: T0 + 1, mint: MINT, qtyFraction: 1, priceNative: 0.0012, order,
  });
  assert.equal(fill.trade.orderKind, 'trail');
  assert.equal(fill.trade.triggerPrice, 0.0015);
  assert.equal(fill.trade.priceNative, 0.0012);
  assert.ok(fill.trade.triggerSlipPct < 0, 'the gap past the level is recorded, not hidden');
});

test('a dragged trailing stop re-bases its peak instead of snapping back', () => {
  const { state } = walletWithPosition(0.001);
  const o = E.addOrder(state, MINT, { kind: 'trail', trailPct: 25 }, 0.001, T0);
  E.updateTrailPeaks(state, MINT, 0.002); // trigger 0.0015
  E.moveOrder(state, MINT, o.id, 0.0018, null);
  assert.equal(o.triggerPrice, 0.0018);
  assert.ok(Math.abs(o.peakPrice - 0.0024) < 1e-12, 'peak re-based so the ratchet keeps working');
});

/* ---------------- armAutoExits ---------------- */

const AUTO = {
  autoExitsEnabled: true,
  autoTp1Pct: 100, autoTp1SizePct: 50,
  autoTp2Pct: null, autoSlPct: 30, autoTrailPct: null,
};

test('disabled = no orders', () => {
  const { state, settings } = walletWithPosition(0.001, 1, { autoExitsEnabled: false, autoTp1Pct: 100, autoSlPct: 30 });
  assert.equal(E.armAutoExits(state, settings, MINT, 0.001, null, T0), null);
  assert.equal(E.ordersFor(state, MINT).length, 0);
});

test('the configured set arms relative to the average entry', () => {
  const { state, settings } = walletWithPosition(0.001, 1, AUTO);
  const armed = E.armAutoExits(state, settings, MINT, 0.001, 1e8, T0);
  assert.equal(armed.armed, 2);
  const orders = E.ordersFor(state, MINT);
  const tp = orders.find((o) => o.kind === 'tp');
  const sl = orders.find((o) => o.kind === 'sl');
  assert.ok(tp && sl);
  assert.ok(Math.abs(tp.triggerPrice - 0.002) < 1e-12, 'TP +100% over entry');
  assert.equal(tp.sizePct, 50);
  assert.ok(Math.abs(sl.triggerPrice - 0.0007) < 1e-12, 'SL −30% under entry');
  assert.ok(tp.auto && sl.auto, 'auto orders are tagged');
});

test('all four legs can arm, including the trailing stop', () => {
  const { state, settings } = walletWithPosition(0.001, 1,
    Object.assign({}, AUTO, { autoTp2Pct: 300, autoTp2SizePct: 100, autoTrailPct: 40 }));
  const armed = E.armAutoExits(state, settings, MINT, 0.001, null, T0);
  assert.equal(armed.armed, 4);
  const trail = E.ordersFor(state, MINT).find((o) => o.kind === 'trail');
  assert.equal(trail.trailPct, 40);
  assert.ok(Math.abs(trail.triggerPrice - 0.0006) < 1e-12);
});

test('adding to a position re-bases the exits on the new average entry', () => {
  const { state, settings } = walletWithPosition(0.001, 1, AUTO);
  E.armAutoExits(state, settings, MINT, 0.001, null, T0);
  // Double the bag at a higher price: 1000 @0.001 + 500 @0.002 tokens for
  // 2 SOL total — avg entry 0.001333, so TP +100% lands at 0.002667.
  E.buy(state, settings, { mint: MINT, symbol: 'BONK', solAmount: 1, priceNative: 0.002, ts: T0 + 1 });
  const armed = E.armAutoExits(state, settings, MINT, 0.002, null, T0 + 1);
  const tp = armed.orders.find((o) => o.kind === 'tp');
  assert.ok(Math.abs(tp.triggerPrice - 2 / 1500 * 2) < 1e-12,
    `re-based on avg 0.001333: TP +100% = ${tp.triggerPrice}`);
  // The old set was REPLACED, not stacked.
  assert.equal(E.ordersFor(state, MINT).filter((o) => o.auto).length, 2);
});

test('manual orders survive; the cap bounds the whole list', () => {
  const { state, settings } = walletWithPosition(0.001, 1,
    Object.assign({}, AUTO, { autoTp2Pct: 200, autoTrailPct: 40 }));
  // Seven manual orders leave room for exactly one auto leg.
  for (let i = 0; i < 7; i++) {
    E.addOrder(state, MINT, { kind: 'tp', triggerPrice: 0.002 + i * 0.0001 }, 0.001, T0);
  }
  const armed = E.armAutoExits(state, settings, MINT, 0.001, null, T0);
  assert.equal(armed.armed, 1, 'only one auto order fits beside 7 manual');
  assert.equal(armed.skipped, 3);
  const orders = E.ordersFor(state, MINT);
  assert.equal(orders.length, 8);
  assert.equal(orders.filter((o) => !o.auto).length, 7, 'manual orders untouched');
});

test('a full close still clears the armed set', () => {
  const { state, settings } = walletWithPosition(0.001, 1, AUTO);
  E.armAutoExits(state, settings, MINT, 0.001, null, T0);
  E.sell(state, settings, { ts: T0 + 1, mint: MINT, qtyFraction: 1, priceNative: 0.0012 });
  assert.equal(E.ordersFor(state, MINT).length, 0, 'no orders fire into a closed position');
});

/* ---------------- settings normalization ---------------- */

test('mergeSettings clamps and nulls the auto-exit legs', () => {
  const s = E.mergeSettings({
    autoExitsEnabled: 'yes', // truthy junk is not true
    autoTp1Pct: 50000, autoTp1SizePct: 250,
    autoTp2Pct: '', autoSlPct: 0, autoTrailPct: '40',
    autoSlSizePct: 'junk',
  });
  assert.equal(s.autoExitsEnabled, false);
  assert.equal(s.autoTp1Pct, 10000);
  assert.equal(s.autoTp1SizePct, 100);
  assert.equal(s.autoTp2Pct, null);
  assert.equal(s.autoSlPct, null, 'a 0% stop is off, not a stop at entry');
  assert.equal(s.autoTrailPct, 40, 'numeric strings accepted');
  assert.equal(s.autoSlSizePct, 100);
});

test('defaults: auto exits off, TP1 +100% on half, SL −30% on all', () => {
  const s = E.mergeSettings(null);
  assert.equal(s.autoExitsEnabled, false);
  assert.equal(s.autoTp1Pct, 100);
  assert.equal(s.autoTp1SizePct, 50);
  assert.equal(s.autoTp2Pct, null);
  assert.equal(s.autoSlPct, 30);
  assert.equal(s.autoTrailPct, null);
});

/* ---------------- through the real content script ----------------
 *
 * The shipped content.js boots in the statepersist harness (fake clock,
 * stub network, real storage). A panel buy must arm the configured set
 * inside the same committed write, and a trail must ride the peak up and
 * fire on the drop — fills at the OBSERVED price, position cleared.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.join(__dirname, '..');

function loadOverlayHarness() {
  const source = fs.readFileSync(path.join(__dirname, 'statepersist.test.js'), 'utf8');
  const start = source.indexOf('function runOverlay');
  const end = source.indexOf('\n}\n\ntest(', start);
  const runOverlay = new Function('ROOT', 'fs', 'path', 'vm', 'E', 'BONK',
    `${source.slice(start, end + 2)}; return runOverlay;`)(
    ROOT, fs, path, vm, E, 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
  return runOverlay;
}

test('a buy arms the configured set, and the trail rides the peak then fires', async () => {
  const runOverlay = loadOverlayHarness();
  const ov = runOverlay([0.001, 0.002, 0.002, 0.0014, 0.0014], {
    initialSettings: {
      autoExitsEnabled: true,
      autoTp1Pct: null, autoSlPct: null,
      autoTrailPct: 25, autoTrailSizePct: 100,
    },
  });
  await ov.advance(1500); // token resolves, price marks at 0.001
  ov.clickPreset(0);
  ov.clickById('pt-buy');
  for (let w = 0; w < 12000 && !((ov.storage().pt_state || {}).positions || {})[MINT]; w += 200) {
    await ov.advance(200);
  }
  const state1 = ov.storage().pt_state;
  const pos = state1.positions[MINT];
  assert.ok(pos && pos.qty > 0, 'the panel buy filled');
  const orders = (state1.orders && state1.orders[MINT]) || [];
  const trail = orders.find((o) => o.kind === 'trail');
  assert.ok(trail && trail.auto === true, 'a buy arms the auto trailing stop');
  assert.equal(trail.trailPct, 25);
  assert.ok(Math.abs(trail.peakPrice - pos.avgPriceNative) < 1e-12
    || Math.abs(trail.peakPrice - 0.001) < 1e-9,
    `peak starts at the entry (${trail.peakPrice})`);

  // Price doubles: the trail's trigger must ratchet up with the peak.
  ov.nextPrice(); // 0.002
  await ov.advance(2500);
  const trailed = ov.storage().pt_state.orders[MINT].find((o) => o.kind === 'trail');
  assert.ok(Math.abs(trailed.peakPrice - 0.002) < 1e-9, `peak ${trailed.peakPrice} should have risen to 0.002`);
  assert.ok(Math.abs(trailed.triggerPrice - 0.0015) < 1e-9);

  // The drop: 0.0014 < trigger 0.0015 — the trail fires on the tick,
  // filling at the observed 0.0014, not the level.
  ov.nextPrice(); ov.nextPrice(); // 0.0014
  for (let w = 0; w < 6000 && ov.storage().pt_state.positions[MINT]; w += 200) {
    await ov.advance(200);
  }
  assert.ok(!ov.storage().pt_state.positions[MINT], 'the trailing stop sold the bag');
  const exit = ov.storage().pt_state.journal.find((j) => j.side === 'sell');
  assert.equal(exit.orderKind, 'trail');
  assert.ok(Math.abs(exit.priceNative - 0.0014) < 1e-9, 'filled at the observed price');
  assert.ok(Math.abs(exit.triggerPrice - 0.0015) < 1e-9);
});

test('updateTrailPeaks with an order id touches only that order', () => {
  const { state } = walletWithPosition(0.001);
  const a = E.addOrder(state, MINT, { kind: 'trail', trailPct: 25 }, 0.001, T0);
  const b = E.addOrder(state, MINT, { kind: 'trail', trailPct: 25 }, 0.001, T0 + 1);
  E.updateTrailPeaks(state, MINT, 0.002, a.id);
  assert.equal(a.peakPrice, 0.002);
  assert.equal(b.peakPrice, 0.001, "a sibling trail is not dragged up by another id's mark");
});

test('armAutoExits seeds the trail peak at the current price, not the entry', () => {
  // Bought high, dumped: avg 0.002 but the live price is 0.001 — a trail
  // seeded at the average would sit its trigger at 0.0015 and market-sell
  // the bag on the very next tick.
  const { state, settings } = walletWithPosition(0.002, 1,
    Object.assign({}, AUTO, { autoTrailPct: 25 }));
  const armed = E.armAutoExits(state, settings, MINT, 0.001, null, T0);
  const trail = armed.orders.find((o) => o.kind === 'trail');
  assert.ok(Math.abs(trail.peakPrice - 0.001) < 1e-12, `peak at the live price (got ${trail.peakPrice})`);
  assert.ok(trail.triggerPrice < 0.001, 'trigger below the live price — cannot fire on the next tick');
});

test('re-basing carries the previous auto trail peak forward', () => {
  const { state, settings } = walletWithPosition(0.001, 1,
    Object.assign({}, AUTO, { autoTrailPct: 25 }));
  E.armAutoExits(state, settings, MINT, 0.001, null, T0);
  E.updateTrailPeaks(state, MINT, 0.003); // the trail rode a 3x
  E.buy(state, settings, { mint: MINT, symbol: 'BONK', solAmount: 1, priceNative: 0.002, ts: T0 + 1 });
  const armed = E.armAutoExits(state, settings, MINT, 0.002, null, T0 + 1);
  const trail = armed.orders.find((o) => o.kind === 'trail');
  assert.ok(Math.abs(trail.peakPrice - 0.003) < 1e-12,
    `adding to a winner keeps the earned peak (got ${trail.peakPrice})`);
  // …but never below the CURRENT price either — a fresh high re-seeds it.
  const armed2 = E.armAutoExits(state, settings, MINT, 0.004, null, T0 + 2);
  assert.ok(Math.abs(armed2.orders.find((o) => o.kind === 'trail').peakPrice - 0.004) < 1e-12);
});

test('legs already past the current price are skipped with a reason', () => {
  // Average-down deep: 1 SOL @ 0.002 then 1 SOL @ 0.0006 — avg ~0.00092,
  // so SL −30% would arm at ~0.00065 ABOVE the live 0.0006: a market sell
  // wearing a stop's costume. It must be skipped, not armed.
  const { state, settings } = walletWithPosition(0.002, 1,
    Object.assign({}, AUTO, { autoTrailPct: 25 }));
  E.buy(state, settings, { mint: MINT, symbol: 'BONK', solAmount: 1, priceNative: 0.0006, ts: T0 + 1 });
  const armed = E.armAutoExits(state, settings, MINT, 0.0006, null, T0 + 1);
  const sl = armed.skippedLegs.find((s) => s.kind === 'sl');
  assert.ok(sl && sl.reason === 'below', 'the stale SL is refused with a reason');
  assert.ok(!E.ordersFor(state, MINT).some((o) => o.kind === 'sl'), 'no SL order armed');
  assert.ok(armed.orders.some((o) => o.kind === 'tp'), 'the valid TP still arms');

  // …and the mirror: a TP the price already passed is skipped too.
  const { state: s2, settings: set2 } = walletWithPosition(0.0005, 1, AUTO);
  const armed2 = E.armAutoExits(s2, set2, MINT, 0.002, null, T0);
  const tp = armed2.skippedLegs.find((s) => s.kind === 'tp');
  assert.ok(tp && tp.reason === 'above', 'TP +100% = 0.001 is below the live 0.002');
  assert.ok(!E.ordersFor(s2, MINT).some((o) => o.kind === 'tp'));
});

test('a session high from BEFORE the buy cannot arm the trail above the live price', async () => {
  const runOverlay = loadOverlayHarness();
  // Watch the coin run to 2x and dump back to 1x BEFORE buying: the old
  // mint-level session peak would ratchet the fresh trail to 0.002, its
  // trigger lands at 0.0015 above the live 0.001, and the buy sells itself
  // on the next tick. High-water marks are per ORDER id now — a trail only
  // rises on prices observed while it is armed.
  const ov = runOverlay([0.001, 0.002, 0.001, 0.001], {
    initialSettings: {
      autoExitsEnabled: true,
      autoTp1Pct: null, autoSlPct: null,
      autoTrailPct: 25, autoTrailSizePct: 100,
    },
  });
  await ov.advance(1500); // resolves at 0.001
  ov.nextPrice();
  await ov.advance(2500); // pump to 0.002 — no position, no trail
  ov.nextPrice();
  await ov.advance(2500); // dumped back to 0.001
  ov.clickPreset(0);
  ov.clickById('pt-buy');
  for (let w = 0; w < 12000 && !((ov.storage().pt_state || {}).positions || {})[MINT]; w += 200) {
    await ov.advance(200);
  }
  assert.ok(ov.storage().pt_state.positions[MINT], 'the buy filled at 0.001');
  // More ticks at the live price — the trail must NOT fire on the pre-buy
  // high. This is the regression the per-order marks exist for.
  await ov.advance(4000);
  const st = ov.storage().pt_state;
  assert.ok(st.positions[MINT], 'a trail cannot fire on a high it never saw');
  const trail = (st.orders[MINT] || []).find((o) => o.kind === 'trail');
  assert.ok(trail && Math.abs(trail.peakPrice - 0.001) < 1e-9,
    `peak seeds at the entry, not the session high (got ${trail && trail.peakPrice})`);
});

test('re-buying the same mint arms a fresh trail that inherits no old peak', async () => {
  const runOverlay = loadOverlayHarness();
  const ov = runOverlay([0.001, 0.003, 0.002, 0.002, 0.002], {
    initialSettings: {
      autoExitsEnabled: true,
      autoTp1Pct: null, autoSlPct: null,
      autoTrailPct: 25, autoTrailSizePct: 100,
    },
  });
  await ov.advance(1500);
  ov.clickPreset(0);
  ov.clickById('pt-buy'); // buy @0.001
  for (let w = 0; w < 12000 && !((ov.storage().pt_state || {}).positions || {})[MINT]; w += 200) {
    await ov.advance(200);
  }
  ov.nextPrice();
  await ov.advance(2500); // 0.003 — trail ratchets, trigger 0.00225
  ov.nextPrice();
  for (let w = 0; w < 12000 && ov.storage().pt_state.positions[MINT]; w += 200) {
    await ov.advance(200); // 0.002 < 0.00225 — the trail exits
  }
  assert.ok(!ov.storage().pt_state.positions[MINT], 'the trail closed the first round');
  // Re-buy the same mint at 0.002. The old order's 0.003 mark is dead with
  // its id — the new trail seeds at the new fill and must not sell itself.
  ov.clickPreset(0);
  ov.clickById('pt-buy');
  for (let w = 0; w < 12000 && !((ov.storage().pt_state || {}).positions || {})[MINT]; w += 200) {
    await ov.advance(200);
  }
  await ov.advance(4000);
  const st = ov.storage().pt_state;
  assert.ok(st.positions[MINT], 'the re-buy stays open — no inherited peak');
  const trail = (st.orders[MINT] || []).find((o) => o.kind === 'trail');
  assert.ok(trail && Math.abs(trail.peakPrice - 0.002) < 1e-9,
    `new trail seeds at the new fill (got ${trail && trail.peakPrice})`);
});

test('an adopted stale base cannot lower a trail this tab already ratcheted', async () => {
  const runOverlay = loadOverlayHarness();
  const ov = runOverlay([0.001, 0.002, 0.002, 0.002], {
    initialSettings: {
      autoExitsEnabled: true,
      autoTp1Pct: null, autoSlPct: null,
      autoTrailPct: 25, autoTrailSizePct: 100,
    },
  });
  await ov.advance(1500);
  ov.clickPreset(0);
  ov.clickById('pt-buy'); // buy @0.001
  for (let w = 0; w < 12000 && !((ov.storage().pt_state || {}).positions || {})[MINT]; w += 200) {
    await ov.advance(200);
  }
  ov.nextPrice();
  await ov.advance(2500); // 0.002 — this tab ratcheted the trail to peak 0.002
  const trailed = ov.storage().pt_state.orders[MINT].find((o) => o.kind === 'trail');
  assert.ok(Math.abs(trailed.peakPrice - 0.002) < 1e-9, 'setup: peak is 0.002');

  // Another writer (a second tab that never saw 0.002) commits a state
  // whose copy of the SAME order id still sits at the entry peak.
  const stale = JSON.parse(JSON.stringify(ov.storage().pt_state));
  const staleTrail = stale.orders[MINT].find((o) => o.kind === 'trail');
  staleTrail.peakPrice = 0.001;
  staleTrail.triggerPrice = 0.00075;
  stale.seq = (Number(stale.seq) || 0) + 50;
  ov.externalWriteSilently({ pt_state: stale });

  // This tab's next write hits the seq wall, adopts `current`, re-applies —
  // adoptState raises the adopted trail back to its own id's mark.
  ov.clickPreset(0);
  ov.clickById('pt-buy');
  let peak = 0;
  for (let w = 0; w < 12000; w += 200) {
    await ov.advance(200);
    const tr = ((ov.storage().pt_state || {}).orders || {})[MINT] || [];
    const t = tr.find((o) => o.kind === 'trail');
    if (t && Math.abs(t.peakPrice - 0.002) < 1e-9) { peak = t.peakPrice; break; }
  }
  assert.ok(Math.abs(peak - 0.002) < 1e-9,
    `the adoption merge kept this id's earned peak (got ${peak})`);
});
