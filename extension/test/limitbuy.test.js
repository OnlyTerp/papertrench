/* N2 — armed limit buys (Ideas channel: ".dgreatest — Bring limit order").
 * A limit buy is an ENTRY, not an exit: no position required, cash locked at
 * arm time, fired at the observed price when the market drops to the level. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const ROOT = path.resolve(import.meta.dirname, '..');
const enginePath = path.join(ROOT, 'engine.js');
const E = (await import('node:module'))
  .createRequire(import.meta.url)(enginePath);

function freshState(cash = 10) {
  return {
    cashSol: cash,
    positions: {},
    orders: {},
    pendingBuys: {},
    chain: [],
    sessionId: 's1',
    fills: {},
  };
}

test('addPendingBuy locks free SOL and refuses overspend', () => {
  const s = freshState(10);
  const o1 = E.addPendingBuy(s, {}, 'mintA', { ts: 1, triggerPrice: 0.5, solAmount: 6 });
  assert.ok(o1.id && o1.lockedSol === 6, 'first bid armed and locked');
  assert.equal(E.lockedBuySol(s), 6);
  // 6 locked, only 4 free — a 5 bid must refuse.
  assert.throws(() => E.addPendingBuy(s, {}, 'mintB', { ts: 2, triggerPrice: 0.4, solAmount: 5 }),
    /Not enough free SOL/);
  // 4 fits exactly.
  const o2 = E.addPendingBuy(s, {}, 'mintB', { ts: 3, triggerPrice: 0.3, solAmount: 4 });
  assert.equal(E.lockedBuySol(s), 10, 'everything locked now');
  E.removePendingBuy(s, 'mintB', o2.id);
  assert.equal(E.lockedBuySol(s), 6, 'cancel unlocks');
});

test('triggeredPendingBuys fires on drop-through, highest level first', () => {
  const s = freshState(10);
  E.addPendingBuy(s, {}, 'm', { ts: 1, triggerPrice: 0.5, solAmount: 1 });
  E.addPendingBuy(s, {}, 'm', { ts: 2, triggerPrice: 0.3, solAmount: 1 });
  // Price ABOVE all levels: nothing fires.
  assert.equal(E.triggeredPendingBuys(s, 'm', 0.9).length, 0);
  // Price 0.4: only the 0.5 bid is through.
  assert.deepEqual(E.triggeredPendingBuys(s, 'm', 0.4).map((o) => o.triggerPrice), [0.5]);
  // Knife to 0.2: both, highest first (closest to the top of the fall).
  assert.deepEqual(E.triggeredPendingBuys(s, 'm', 0.2).map((o) => o.triggerPrice), [0.5, 0.3]);
});

test('armed entries expire after 24h and unlock', () => {
  const s = freshState(10);
  E.addPendingBuy(s, {}, 'm', { ts: Date.now() - 25 * 3600 * 1000, triggerPrice: 0.5, solAmount: 2 });
  assert.equal(E.lockedBuySol(s), 2, 'stale entry still locked before sweep');
  const n = E.expirePendingBuys(s, Date.now());
  assert.equal(n, 1);
  assert.equal(E.lockedBuySol(s), 0, 'sweep released the cash');
  assert.equal(E.pendingBuysFor(s, 'm').length, 0);
});

test('max 8 armed entries per mint', () => {
  const s = freshState(100);
  for (let i = 0; i < 8; i += 1) E.addPendingBuy(s, {}, 'm', { ts: i, triggerPrice: 0.1 + i / 100, solAmount: 1 });
  assert.throws(() => E.addPendingBuy(s, {}, 'm', { ts: 99, triggerPrice: 0.5, solAmount: 1 }), /At most/);
});

test('content wires the tick-path fire and the panel UI', () => {
  const content = readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  assert.match(content, /evaluatePendingBuys\(\);/,
    'armed buys are judged on the tick path, next to evaluateChartOrders');
  assert.match(content, /E\.triggeredPendingBuys\(state, token\.mint, observed\)/);
  assert.match(content, /function armLimitBuy\(\)/);
  assert.match(content, /id="pt-limit-price"/, 'the panel has the limit price input');
  assert.match(content, /id="pt-limit-arm"/, 'the panel has the ARM button');
  assert.match(content, /function renderLimitBuys\(\)/, 'armed bids render with a cancel ×');
  assert.match(content, /That limit is at or above the live price — just press BUY/,
    'a bid above market is refused with the reason');
});
