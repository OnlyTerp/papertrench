/* Order-line thickness reaches the TradingView line (feedback batch:
 * "." asked for thicker order lines, 2026-08-19).
 *
 * Drives the shipped bridge with the chartorderlines harness shape: a
 * paper-orders spec carrying lineWidth must land on setLineWidth.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function runBridge(opts = {}) {
  // Same shape as chartorderlines.test.js: the bridge discovers the chart
  // through window.tvWidget (the Padre/Axiom global seam).
  const timers = [];
  const emitted = [];
  const listeners = {};
  const orderLines = [];
  let realtimeCallback = null;

  function makeOrderLine() {
    if (opts.brokerThrows) throw new Error('createOrderLine is only available on Trading Platform');
    const line = { removed: false, values: {}, handlers: {} };
    for (const m of ['setText', 'setQuantity', 'setLineColor', 'setLineStyle', 'setLineWidth',
      'setPrice', 'setBodyFont', 'setBodyTextColor', 'setBodyBorderColor',
      'setBodyBackgroundColor', 'setEditable']) {
      line[m] = function (v) { this.values[m] = v; return this; };
    }
    line.getPrice = function () { return this.values.setPrice; };
    line.onMove = function (fn) { this.handlers.move = fn; return this; };
    line.onCancel = function (fn) { this.handlers.cancel = fn; return this; };
    line.remove = function () { this.removed = true; return this; };
    orderLines.push(line);
    return line;
  }

  const datafeed = { subscribeBars(s, r, cb) { realtimeCallback = cb; }, getMarks(s, f, t, cb) { cb([]); } };
  const chart = { clearMarks() {}, refreshMarks() {}, createOrderLine: makeOrderLine };

  function FakeWebSocket() {}
  FakeWebSocket.prototype.addEventListener = () => {};
  FakeWebSocket.CONNECTING = 0; FakeWebSocket.OPEN = 1;
  FakeWebSocket.CLOSING = 2; FakeWebSocket.CLOSED = 3;
  function FakeSharedWorker() {
    this.port = { addEventListener() {}, start() {} };
  }
  function FakeXHR() {}
  FakeXHR.prototype.send = function () {};
  FakeXHR.prototype.addEventListener = function () {};

  const win = {
    tvWidget: { _options: { datafeed }, activeChart: () => chart },
    fetch: () => Promise.resolve({
      url: '', headers: { get: () => 'application/json' },
      clone: () => ({ text: () => Promise.resolve('{}') }),
    }),
    XMLHttpRequest: FakeXHR, WebSocket: FakeWebSocket,
    SharedWorker: FakeSharedWorker, EventSource: undefined,
    addEventListener(type, fn) { listeners[type] = fn; },
    postMessage(message) { emitted.push(message); },
  };
  win.window = win;

  const sandbox = {
    window: win,
    location: (() => {
      const href = opts.href || 'https://trade.padre.gg/trade/Mint1';
      return { href, hostname: new URL(href).hostname };
    })(),
    console, Date, Math, Number, String, Array, Object, Boolean, RegExp, Error,
    Set, WeakSet, WeakMap, Map, Symbol, JSON, Promise, isFinite, URL,
    setInterval(fn) { timers.push(fn); return timers.length; },
    clearInterval() {},
    setTimeout(fn) { fn(); return 1; },
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'price-bridge.js'), 'utf8'), ctx,
    { filename: 'price-bridge.js' });
  for (const fn of timers.slice()) fn();

  const send = (type, payload) => {
    listeners.message({ source: win, data: { source: 'papertrench-content', type, payload } });
  };
  return { emitted, orderLines, send };
}

/* ---------------- TP/SL line width ---------------- */

test('lineWidth rides the paper-orders spec onto setLineWidth', () => {
  const env = runBridge();
  // Native axis: levels are prices; no bar needed.
  env.send('paper-orders', {
    enabled: true, axisBasis: 'native', refPrice: 0.001, currentPriceNative: 0.001,
    lineWidth: 3,
    orders: [{ id: 'o1', kind: 'tp', triggerPrice: 0.002, sizePct: 100 }],
  });
  assert.equal(env.orderLines.length, 1);
  assert.equal(env.orderLines[0].values.setLineWidth, 3,
    'the thickness setting must reach the chart line');
});

test('absent lineWidth keeps the historical 2px default', () => {
  const env = runBridge();
  env.send('paper-orders', {
    enabled: true, axisBasis: 'native', refPrice: 0.001, currentPriceNative: 0.001,
    orders: [{ id: 'o1', kind: 'tp', triggerPrice: 0.002, sizePct: 100 }],
  });
  assert.equal(env.orderLines[0].values.setLineWidth, 2,
    'old content scripts (no lineWidth) must see the exact old look');
});

test('lineWidth is clamped to 1..4', () => {
  const env = runBridge();
  env.send('paper-orders', {
    enabled: true, axisBasis: 'native', refPrice: 0.001, currentPriceNative: 0.001,
    lineWidth: 99,
    orders: [{ id: 'o1', kind: 'tp', triggerPrice: 0.002, sizePct: 100 }],
  });
  assert.equal(env.orderLines[0].values.setLineWidth, 4, 'the bridge clamps hostile input');
  // 0 / NaN / undefined are all falsy -> the `|| 2` default: zero-width is
  // not a valid choice, so it falls back to the historical width, not 1.
  for (const bad of [0, NaN, undefined]) {
    const env2 = runBridge();
    env2.send('paper-orders', {
      enabled: true, axisBasis: 'native', refPrice: 0.001, currentPriceNative: 0.001,
      lineWidth: bad,
      orders: [{ id: 'o1', kind: 'tp', triggerPrice: 0.002, sizePct: 100 }],
    });
    assert.equal(env2.orderLines[0].values.setLineWidth, 2,
      `falsy width ${bad} falls back to the 2px default`);
  }
  const env3 = runBridge();
  env3.send('paper-orders', {
    enabled: true, axisBasis: 'native', refPrice: 0.001, currentPriceNative: 0.001,
    lineWidth: 0.4,
    orders: [{ id: 'o1', kind: 'tp', triggerPrice: 0.002, sizePct: 100 }],
  });
  assert.equal(env3.orderLines[0].values.setLineWidth, 1,
    'a fractional width below 1 rounds/clamps up to thin');
});

test('a thickness change alone redraws existing lines (content-side signature)', () => {
  const content = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  const sync = content.slice(content.indexOf('function syncChartOrders('), content.indexOf('function requestBuy'));
  assert.ok(sync.length > 100, 'syncChartOrders slice sanity');
  assert.match(sync, /const orderLineWidth = Math\.max\(1, Math\.min\(4, Math\.round\(/,
    'the width must be computed once per sync');
  assert.match(sync, /'\|' \+ orderLineWidth;/,
    'and it must participate in the repost signature — same orders + new thickness must repost');
});
