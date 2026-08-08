const test = require('node:test');
const assert = require('node:assert/strict');
global.window = global.window || {};
require('../predict-engine.js');
const E = global.window.PaperPredictEngine;

// ── Shared ladders ────────────────────────────────────────────────────────
const yes = { bids: [[80, 100], [79, 200]], asks: [[81, 150], [82, 300]] };
const no  = { bids: [[19, 150], [18, 300]], asks: [[20, 100], [21, 200]] };

// ═══════════════════════════════════════════════════════════════════════════
// 1. walkBook property tests
// ═══════════════════════════════════════════════════════════════════════════

test('walkBook: average fill price lies between the touched levels', () => {
  const levels = [[81, 150], [82, 300]];
  const r = E.walkBook(levels, { kind: 'qty', qty: 200 });
  assert.ok(r.totalQty > 0, 'should fill something');
  assert.ok(r.avgPrice >= 81, `avgPrice ${r.avgPrice} should be >= best ask 81`);
  assert.ok(r.avgPrice <= 82, `avgPrice ${r.avgPrice} should be <= worst ask 82`);
});

test('walkBook: cost equals sum of (qty × price) for each fill', () => {
  const levels = [[81, 150], [82, 300]];
  const r = E.walkBook(levels, { kind: 'qty', qty: 300 });
  const recomputedCost = r.fills.reduce(
    (sum, f) => E.roundMoney(sum + f.notional), 0
  );
  assert.strictEqual(r.cost, recomputedCost,
    `cost ${r.cost} must equal sum of fill notionals ${recomputedCost}`);
});

test('walkBook: fills never exceed visible depth', () => {
  const levels = [[81, 150], [82, 300]];
  const totalAvailable = 150 + 300;
  const r = E.walkBook(levels, { kind: 'qty', qty: 9999 });
  assert.ok(r.totalQty <= totalAvailable,
    `totalQty ${r.totalQty} must not exceed depth ${totalAvailable}`);
});

test('walkBook: partial fill when order exceeds book depth', () => {
  const levels = [[81, 150], [82, 100]];
  const r = E.walkBook(levels, { kind: 'qty', qty: 9999 });
  assert.strictEqual(r.partial, true, 'should be partial');
  assert.ok(r.unfilledQty > 0, 'should have unfilled qty');
  assert.strictEqual(r.totalQty, 250, 'should fill exactly the available 150+100');
});

test('walkBook: empty book returns zero qty', () => {
  const r = E.walkBook([], { kind: 'qty', qty: 100 });
  assert.strictEqual(r.totalQty, 0);
  assert.strictEqual(r.cost, 0);
  assert.strictEqual(r.fills.length, 0);
  // Empty book with a qty target is partial — nothing was filled
  assert.strictEqual(r.partial, true);
  assert.strictEqual(r.unfilledQty, 100);
});

test('walkBook: notional target — budget constraint respected (cost <= notional)', () => {
  const levels = [[81, 150], [82, 300]];
  const budget = 50; // $50
  const r = E.walkBook(levels, { kind: 'notional', usd: budget });
  assert.ok(r.cost <= budget,
    `cost ${r.cost} must not exceed budget ${budget}`);
});

test('walkBook: floor-never-round — quantity always floored to 2 dp', () => {
  // At 99c, $100 buys 101.01… → floorQty → 101.01 (not 101.02)
  const levels = [[99, 500]];
  const r = E.walkBook(levels, { kind: 'notional', usd: 100 });
  for (const f of r.fills) {
    const scaled = f.qty * 100;
    assert.strictEqual(scaled, Math.floor(scaled),
      `fill qty ${f.qty} should be floored, not rounded`);
  }
  // Verify floor rather than round: 100/0.99 = 101.0101… → floor = 101.01
  assert.strictEqual(r.totalQty, 101.01,
    `totalQty should be 101.01 (floored), got ${r.totalQty}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Depth cap tests
// ═══════════════════════════════════════════════════════════════════════════

test('depth cap: order at exactly 5% of depth passes', () => {
  const yesBook = { bids: [[80, 100], [79, 200]], asks: [[81, 150], [82, 300]] };
  const noBook  = { bids: [[19, 150], [18, 300]], asks: [[20, 100], [21, 200]] };
  const asks = yesBook.asks; // buying YES → takes from asks
  const depth = E.depthNotional(asks); // 367.50
  const fivePct = depth * E.MAX_DEPTH_FRACTION; // 18.375

  // Find a notional that produces cost exactly at or just below 5%
  // At 81c: $18.37 → floor(18.37/0.81) = floor(22.679) = 22.67 → cost = 18.3627
  const r = E.walkBook(asks, { kind: 'notional', usd: 18.37 });
  assert.ok(r.cost <= fivePct,
    `cost ${r.cost} should be <= 5% depth threshold ${fivePct}`);

  // priceOrder should NOT throw for this order
  const snap = {
    yes_bids: yesBook.bids, yes_asks: yesBook.asks,
    no_bids: noBook.bids, no_asks: noBook.asks,
    captured_at: new Date().toISOString(),
  };
  const market = { status: 'open', close_time: '2099-12-31', tick_cents: 1, min_order_size: 0.01 };
  assert.doesNotThrow(() => {
    E.priceOrder({ snap, market, side: 'buy', outcome: 'yes', realism: 'instant', target: { kind: 'notional', usd: 18.37 } });
  }, 'order at or below 5% depth should pass');
});

test('depth cap: order above 5% of depth is rejected with size_exceeds_depth', () => {
  const yesBook = { bids: [[80, 100], [79, 200]], asks: [[81, 150], [82, 300]] };
  const noBook  = { bids: [[19, 150], [18, 300]], asks: [[20, 100], [21, 200]] };
  const asks = yesBook.asks;
  const depth = E.depthNotional(asks);
  const fivePct = depth * E.MAX_DEPTH_FRACTION;

  // At 81c: $18.39 → floor(18.39/0.81) = floor(22.7037) = 22.70 → cost = 18.387
  const r = E.walkBook(asks, { kind: 'notional', usd: 18.39 });
  assert.ok(r.cost > fivePct,
    `cost ${r.cost} should exceed 5% threshold ${fivePct} for this test to be valid`);

  const snap = {
    yes_bids: yesBook.bids, yes_asks: yesBook.asks,
    no_bids: noBook.bids, no_asks: noBook.asks,
    captured_at: new Date().toISOString(),
  };
  const market = { status: 'open', close_time: '2099-12-31', tick_cents: 1, min_order_size: 0.01 };
  assert.throws(() => {
    E.priceOrder({ snap, market, side: 'buy', outcome: 'yes', realism: 'instant', target: { kind: 'notional', usd: 18.39 } });
  }, (err) => err.code === 'size_exceeds_depth',
    'should reject with size_exceeds_depth');
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Resolution lockout tests
// ═══════════════════════════════════════════════════════════════════════════

test('resolution lockout: bid=98, ask=99 (spread<2, bid>=97) → rejected', () => {
  const ladder = { bids: [[98, 100]], asks: [[99, 100]] };
  assert.throws(() => {
    E.assertNotResolved(ladder);
  }, (err) => err.code === 'resolution_lockout',
    'near-certainty high-price book should lock out');
});

test('resolution lockout: bid=2, ask=3 (spread<2, ask<=3) → rejected', () => {
  const ladder = { bids: [[2, 100]], asks: [[3, 100]] };
  assert.throws(() => {
    E.assertNotResolved(ladder);
  }, (err) => err.code === 'resolution_lockout',
    'near-certainty low-price book should lock out');
});

test('resolution lockout: bid=50, ask=52 (spread=2) → allowed', () => {
  const ladder = { bids: [[50, 100]], asks: [[52, 100]] };
  assert.doesNotThrow(() => {
    E.assertNotResolved(ladder);
  }, 'spread of exactly 2 should not lock out');
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Mirror invariant tests
// ═══════════════════════════════════════════════════════════════════════════

test('mirror invariant: valid mirror (yes_ask == 100 - no_bid) → ok=true', () => {
  const result = E.checkBookInvariants(yes, no);
  assert.strictEqual(result.ok, true, `should be ok, violations: ${result.violations}`);
  assert.strictEqual(result.violations.length, 0);
  assert.ok(result.checked > 0, 'should have checked at least one pair');
});

test('mirror invariant: broken mirror → ok=false, violations listed', () => {
  const badYes = { bids: [[70, 100]], asks: [[75, 150]] };
  const badNo  = { bids: [[25, 100]], asks: [[30, 150]] };
  // yes_ask (75) should be 100 - no_bid (100-25=75) ✓
  // no_ask (30) should be 100 - yes_bid (100-70=30) ✓
  // yes_bid (70) should be 100 - no_ask (100-30=70) ✓
  // no_bid (25) should be 100 - yes_ask (100-75=25) ✓
  // Hmm, these actually all match. Let me use truly broken values.
  const brokenYes = { bids: [[70, 100]], asks: [[76, 150]] };
  const brokenNo  = { bids: [[25, 100]], asks: [[30, 150]] };
  // yes_ask (76) vs 100 - no_bid (75) → delta 1 → violation
  // no_bid (25) vs 100 - yes_ask (24) → delta 1 → violation
  const result = E.checkBookInvariants(brokenYes, brokenNo);
  assert.strictEqual(result.ok, false, 'broken mirror should not be ok');
  assert.ok(result.violations.length > 0, 'should list violations');
});

test('mirror invariant: one-sided book (empty bids) → ok=true', () => {
  const oneSidedYes = { bids: [], asks: [[81, 150]] };
  const oneSidedNo  = { bids: [[19, 150]], asks: [[20, 100]] };
  const result = E.checkBookInvariants(oneSidedYes, oneSidedNo);
  assert.strictEqual(result.ok, true,
    `one-sided book should pass, got violations: ${result.violations}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. priceMovedAgainstUser tests
// ═══════════════════════════════════════════════════════════════════════════

test('priceMovedAgainstUser: buy — 2% move → false (within tolerance)', () => {
  // PRICE_MOVE_TOLERANCE = 0.02
  // 2% of 100 = 2 → delta/quoted = 2/100 = 0.02 → NOT > 0.02
  assert.strictEqual(E.priceMovedAgainstUser(100, 102, 'buy'), false);
});

test('priceMovedAgainstUser: buy — 3% move → true (exceeds tolerance)', () => {
  assert.strictEqual(E.priceMovedAgainstUser(100, 103, 'buy'), true);
});

test('priceMovedAgainstUser: sell — price dropped 3% → true', () => {
  // For sell: delta = quotedPrice - filledPrice = 100 - 97 = 3
  // 3/100 = 0.03 > 0.02 → true
  assert.strictEqual(E.priceMovedAgainstUser(100, 97, 'sell'), true);
});

test('priceMovedAgainstUser: zero quoted price → false', () => {
  assert.strictEqual(E.priceMovedAgainstUser(0, 50, 'buy'), false);
  assert.strictEqual(E.priceMovedAgainstUser(0, 50, 'sell'), false);
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. takerLevels tests
// ═══════════════════════════════════════════════════════════════════════════

test('takerLevels: buy takes from asks', () => {
  const ladder = { bids: [[80, 100]], asks: [[81, 150]] };
  const levels = E.takerLevels(ladder, 'buy');
  assert.strictEqual(levels, ladder.asks,
    'buy side should consume asks');
});

test('takerLevels: sell takes from bids', () => {
  const ladder = { bids: [[80, 100]], asks: [[81, 150]] };
  const levels = E.takerLevels(ladder, 'sell');
  assert.strictEqual(levels, ladder.bids,
    'sell side should consume bids');
});
