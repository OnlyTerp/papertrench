/* B12 — the row scan's React fiber walk is bounded.
 *
 * cheng.4848 / ark_trades13, 9/11-9/21: "the page is unresponsive, can't
 * click anything, F12 gets no response". addressFromRowFiber runs for every
 * list row without an address link, every few seconds. It capped fibers and
 * depth but not breadth, and re-walked shared objects once per fiber: a row
 * whose props reference a 2,000-item list cost 90 ms, sixty such rows over
 * half a second in one task. This runs the bridge's real function. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'price-bridge.js'), 'utf8');
const start = src.indexOf('  function addressFromRowFiber(row) {');
const end = src.indexOf('  /** The market cap the tapped row', start);
assert.ok(start > 0 && end > start, 'addressFromRowFiber exists in the bridge');
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ROW_ADDR_RE = /[1-9A-HJ-NP-Za-km-z]{32,44}|0x[0-9a-fA-F]{40}/;
const addressFromRowFiber = new Function('BASE58_RE', 'ROW_ADDR_RE', 'EVM_ADDR_RE',
  src.slice(start, end) + '; return addressFromRowFiber;')(BASE58_RE, ROW_ADDR_RE, /^0x[0-9a-fA-F]{40}$/);

const ADDR = 'So11111111111111111111111111111111111111112';
let reads = 0;
const counted = (obj) => new Proxy(obj, { get(t, k, r) { reads += 1; return Reflect.get(t, k, r); } });

function row(width, withAddress) {
  const big = Array.from({ length: width }, (_, i) => counted({ id: i, price: i * 1.1, label: 'r' + i, meta: { a: 1, b: { c: 2 } } }));
  let root = null;
  let prev = null;
  for (let i = 0; i < 100; i++) {
    const f = {
      memoizedProps: {
        rows: big, className: 'x', style: { a: 1 }, children: [{ props: { rows: big } }],
        ...(withAddress && i === 3 ? { token: { pairAddress: ADDR } } : {}),
      },
    };
    if (!root) root = f; else prev.child = f;
    prev = f;
  }
  const el = {};
  Object.defineProperty(el, '__reactFiber$abc', { value: root, enumerable: true });
  return el;
}

test('a row whose props reference a huge shared list is not walked item by item', () => {
  reads = 0;
  addressFromRowFiber(row(2000, false));
  assert.ok(reads < 20_000, `bounded property reads for a row with no address (got ${reads})`);
});

test('the walk still finds the address the row carries', () => {
  assert.equal(addressFromRowFiber(row(200, true)), ADDR);
  assert.equal(addressFromRowFiber(row(10, true)), ADDR);
  assert.equal(addressFromRowFiber(row(10, false)), null);
});
