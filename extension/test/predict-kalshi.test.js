/* Adapter lock tests for the Kalshi venue.
 *
 * Kalshi's orderbook endpoint is the single most dangerous payload in this
 * codebase. Two traps:
 *   1. BID LADDERS ONLY — both ask ladders must be synthesized by mirroring.
 *   2. Element 0 is price in DOLLARS as string, element 1 is CONTRACT COUNT.
 *
 * Ported from amogus0471/Paper-Prediction @ e03f715 (MIT).
 */
const test = require('node:test');
const assert = require('node:assert/strict');

global.window = global.window || {};
require('../predict-venues.js');
const V = global.window.PaperPredictVenues;

// ── Kalshi bid-ladders-only — ask synthesis proof ───────────────────

test('Kalshi: YES asks are synthesized by mirroring NO bids', () => {
  // Raw payload: YES bids at 90¢ and 80¢, NO bids at 10¢ and 20¢
  const raw = {
    orderbook_fp: {
      yes_dollars: [['0.9000', '100.00'], ['0.8000', '200.00']],
      no_dollars: [['0.1000', '200.00'], ['0.2000', '100.00']],
    },
  };
  const book = V.kalshiNormalizeBook(raw);

  // YES asks should be mirrors of NO bids: 100-10=90? No — mirror is (100-price).
  // NO bid at 10¢ → YES ask at 90¢ (same size 200)
  // NO bid at 20¢ → YES ask at 80¢ (same size 100)
  // Sorted ascending (best ask first): 80¢, 90¢
  assert.equal(book.yes.asks.length, 2);
  assert.equal(book.yes.asks[0][0], 80, 'best YES ask is 80¢ (mirror of NO bid 20¢)');
  assert.equal(book.yes.asks[0][1], 100, 'size matches NO bid size');
  assert.equal(book.yes.asks[1][0], 90, 'second YES ask is 90¢ (mirror of NO bid 10¢)');
  assert.equal(book.yes.asks[1][1], 200, 'size matches NO bid size');
});

test('Kalshi: NO asks are synthesized by mirroring YES bids', () => {
  const raw = {
    orderbook_fp: {
      yes_dollars: [['0.9000', '100.00'], ['0.8000', '200.00']],
      no_dollars: [['0.1000', '200.00'], ['0.2000', '100.00']],
    },
  };
  const book = V.kalshiNormalizeBook(raw);

  // NO asks are mirrors of YES bids:
  // YES bid at 90¢ → NO ask at 10¢ (size 100)
  // YES bid at 80¢ → NO ask at 20¢ (size 200)
  // Sorted ascending: 10¢, 20¢
  assert.equal(book.no.asks.length, 2);
  assert.equal(book.no.asks[0][0], 10, 'best NO ask is 10¢ (mirror of YES bid 90¢)');
  assert.equal(book.no.asks[0][1], 100, 'size matches YES bid size');
  assert.equal(book.no.asks[1][0], 20, 'second NO ask is 20¢ (mirror of YES bid 80¢)');
  assert.equal(book.no.asks[1][1], 200, 'size matches YES bid size');
});

// ── Element 1 is NEVER read as a price ─────────────────────────────

test('Kalshi: element 0 is price in dollars, element 1 is contract count', () => {
  // [\"0.5000\", \"7.00\"] = price 50¢, size 7 (NOT price 7¢)
  const levels = V.kalshiToLevels([['0.5000', '7.00']]);
  assert.equal(levels.length, 1);
  assert.equal(levels[0][0], 50, 'price is 50 cents (0.50 dollars × 100)');
  assert.equal(levels[0][1], 7, 'size is 7 contracts (element 1 as number)');
});

test('Kalshi: element 1 as price would be catastrophically wrong', () => {
  // [\"0.1500\", \"100.00\"] — if element 1 were read as price, we'd get 100¢
  // which is outside the tradeable range and should be filtered
  const levels = V.kalshiToLevels([['0.1500', '100.00']]);
  assert.equal(levels.length, 1);
  assert.equal(levels[0][0], 15, 'price is 15 cents');
  assert.equal(levels[0][1], 100, 'size is 100 contracts');
  // If element 1 (100.00) were read as cents, price would be 10000 — way off
  assert.ok(levels[0][0] < 100, 'price must be in (0,100) cents range');
});

// ── Sorting proof ──────────────────────────────────────────────────

test('Kalshi: bids sorted best-first (descending), asks best-first (ascending)', () => {
  const raw = {
    orderbook_fp: {
      // Deliberately worst-first ordering (as Kalshi might return)
      yes_dollars: [['0.8000', '200.00'], ['0.9000', '100.00'], ['0.7000', '300.00']],
      no_dollars: [['0.2000', '100.00'], ['0.1000', '200.00'], ['0.3000', '50.00']],
    },
  };
  const book = V.kalshiNormalizeBook(raw);

  // YES bids: descending (90, 80, 70)
  assert.equal(book.yes.bids[0][0], 90);
  assert.equal(book.yes.bids[1][0], 80);
  assert.equal(book.yes.bids[2][0], 70);

  // YES asks: ascending (mirrors of NO bids: 80, 90, 70 → sorted: 70, 80, 90)
  for (let i = 1; i < book.yes.asks.length; i++) {
    assert.ok(book.yes.asks[i][0] >= book.yes.asks[i - 1][0],
      `YES asks must be ascending: ${book.yes.asks[i - 1][0]} <= ${book.yes.asks[i][0]}`);
  }

  // NO bids: descending
  assert.equal(book.no.bids[0][0], 30);
  assert.equal(book.no.bids[1][0], 20);
  assert.equal(book.no.bids[2][0], 10);

  // NO asks: ascending
  for (let i = 1; i < book.no.asks.length; i++) {
    assert.ok(book.no.asks[i][0] >= book.no.asks[i - 1][0],
      `NO asks must be ascending: ${book.no.asks[i - 1][0]} <= ${book.no.asks[i][0]}`);
  }
});

// ── Mirror invariant check on normalized book ──────────────────────

test('Kalshi: properly mirrored book passes invariant check', () => {
  const raw = {
    orderbook_fp: {
      yes_dollars: [['0.9000', '100.00'], ['0.8000', '200.00']],
      no_dollars: [['0.1000', '200.00'], ['0.2000', '100.00']],
    },
  };
  const book = V.kalshiNormalizeBook(raw);
  const inv = V.checkBookInvariants(book.yes, book.no);
  assert.equal(inv.ok, true, 'properly mirrored book must pass');
  assert.equal(inv.violations.length, 0);
  assert.ok(inv.checked > 0, 'at least one pair checked');
});

test('Kalshi: broken mirror fails invariant check', () => {
  const yes = {
    bids: [[90, 100], [85, 50]], // extra 85 bid with no matching ask
    asks: [[10, 200], [20, 100]], // missing the 15¢ ask that 85 bid implies
  };
  const no = {
    bids: [[10, 200], [20, 100]],
    asks: [[10, 100], [15, 200]], // best NO ask is 15, but best YES bid is 90 → 100-90=10 ≠ 15
  };
  const inv = V.checkBookInvariants(yes, no);
  assert.equal(inv.ok, false, 'broken mirror must fail');
  assert.ok(inv.violations.length > 0, 'violations listed');
});

// ── Edge cases ─────────────────────────────────────────────────────

test('Kalshi: empty orderbook → empty ladders', () => {
  const book = V.kalshiNormalizeBook({});
  assert.equal(book.yes.bids.length, 0);
  assert.equal(book.yes.asks.length, 0);
  assert.equal(book.no.bids.length, 0);
  assert.equal(book.no.asks.length, 0);
});

test('Kalshi: price at 0 or 100 → filtered out', () => {
  const levels = V.kalshiToLevels([['0.0000', '100.00'], ['1.0000', '100.00']]);
  assert.equal(levels.length, 0, 'prices at 0¢ and 100¢ are not tradeable');
});

test('Kalshi: size of 0 → filtered out', () => {
  const levels = V.kalshiToLevels([['0.5000', '0.00']]);
  assert.equal(levels.length, 0, 'zero size is filtered');
});
