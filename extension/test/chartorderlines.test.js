/* Draggable TP/SL order lines — the MAIN-world half.
 *
 * Drives the shipped price-bridge.js against a faithful TradingView fake.
 * The fake carries onMove / onCancel / getPrice because the real broker API
 * does; the "no broker primitives" case is modelled by THROWING what a
 * standalone charting library actually throws (F-39), never by omitting a
 * method — method presence is not capability.
 *
 * The thing under the most scrutiny here is the UNIT INVERSION. The chart's
 * Y axis may be market cap, USD, or native SOL, and a drag hands back
 * getPrice() in whatever unit the axis happens to be in. If that number is
 * treated as a token price, every armed level is silently wrong — the exact
 * class of defect that produced C-02..C-05. These tests pin the round trip
 * in each basis.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function runBridge(opts = {}) {
  const timers = [];
  const emitted = [];
  const listeners = {};
  const orderLines = [];
  let realtimeCallback = null;

  function makeOrderLine() {
    if (opts.brokerThrows) {
      // Verbatim shape of the standalone charting library's refusal (F-39).
      throw new Error('createOrderLine is only available on Trading Platform');
    }
    const line = { removed: false, values: {}, handlers: {} };
    const methods = [
      'setText', 'setQuantity', 'setLineColor', 'setLineStyle', 'setLineWidth',
      'setPrice', 'setBodyFont', 'setBodyTextColor', 'setBodyBorderColor',
      'setBodyBackgroundColor', 'setEditable',
    ];
    for (const m of methods) {
      line[m] = function (v) { this.values[m] = v; return this; };
    }
    line.getPrice = function () { return this.values.setPrice; };
    line.onMove = function (fn) { this.handlers.move = fn; return this; };
    line.onCancel = function (fn) { this.handlers.cancel = fn; return this; };
    line.remove = function () { this.removed = true; return this; };
    /** Simulate a user dragging this line to a new AXIS level. */
    line.dragTo = function (level) {
      this.values.setPrice = level;
      this.handlers.move();
    };
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
    Set, WeakSet, WeakMap, Map, Symbol, JSON, Promise, isFinite,
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
  /** Feed a live bar so an mcap axis has a close to anchor against. */
  const tickBar = (close) => {
    datafeed.subscribeBars({}, '15S', () => {}, 'sub', () => {});
    realtimeCallback({ time: 1_700_000_000_000, close });
  };

  return { emitted, orderLines, send, tickBar, timers, win };
}

const ordersOf = (env) => env.emitted.filter((m) => m.type === 'paper-orders-status');
const moves = (env) => env.emitted.filter((m) => m.type === 'paper-order-moved');
const cancels = (env) => env.emitted.filter((m) => m.type === 'paper-order-cancelled');

/* ---------------- drawing ---------------- */

test('an armed order becomes a draggable, labelled line', () => {
  const env = runBridge();
  env.send('paper-orders', {
    enabled: true, axisBasis: 'native', refPrice: 0.001,
    currentPriceNative: 0.001,
    orders: [{ id: 'o1', kind: 'tp', triggerPrice: 0.002, sizePct: 100, label: 'TP 480K (+100%)' }],
  });

  assert.equal(env.orderLines.length, 1, 'one armed order, one line');
  const line = env.orderLines[0];
  assert.equal(line.values.setPrice, 0.002, 'native axis: the level IS the price');
  assert.equal(line.values.setEditable, true, 'the line must be draggable — that is the feature');
  assert.equal(line.values.setText, 'TP 480K (+100%)');
  assert.equal(line.values.setQuantity, 'ALL', '100% reads as ALL, not "100%"');
  assert.equal(typeof line.handlers.move, 'function', 'a drag handler is wired');
  assert.equal(typeof line.handlers.cancel, 'function', 'a cancel handler is wired');
});

test('a partial-size order shows its size on the line', () => {
  const env = runBridge();
  env.send('paper-orders', {
    enabled: true, axisBasis: 'native', refPrice: 0.001, currentPriceNative: 0.001,
    orders: [{ id: 'o1', kind: 'sl', triggerPrice: 0.0005, sizePct: 50 }],
  });
  assert.equal(env.orderLines[0].values.setQuantity, '50%');
});

test('two orders draw two lines, and dropping one removes only that line', () => {
  const env = runBridge();
  const base = { enabled: true, axisBasis: 'native', refPrice: 0.001, currentPriceNative: 0.001 };
  env.send('paper-orders', {
    ...base,
    orders: [
      { id: 'tp1', kind: 'tp', triggerPrice: 0.002, sizePct: 100 },
      { id: 'sl1', kind: 'sl', triggerPrice: 0.0005, sizePct: 100 },
    ],
  });
  assert.equal(env.orderLines.length, 2);

  // The take profit fired; only the stop is still armed.
  env.send('paper-orders', { ...base, orders: [{ id: 'sl1', kind: 'sl', triggerPrice: 0.0005, sizePct: 100 }] });
  assert.equal(env.orderLines[0].removed, true, 'the spent order loses its line');
  assert.equal(env.orderLines[1].removed, false, 'the live order keeps its line');
});

test('clearing removes every line', () => {
  const env = runBridge();
  env.send('paper-orders', {
    enabled: true, axisBasis: 'native', refPrice: 0.001, currentPriceNative: 0.001,
    orders: [{ id: 'o1', kind: 'tp', triggerPrice: 0.002, sizePct: 100 }],
  });
  env.send('paper-orders-clear');
  assert.equal(env.orderLines[0].removed, true);
  assert.ok(ordersOf(env).some((m) => m.payload.action === 'clear' && m.payload.ok));
});

/* ---------------- the unit inversion ---------------- */

test('on a MARKET CAP axis the line is drawn in cap, and a drag comes back as price', () => {
  const env = runBridge();
  // The chart's live bar close is the cap the current price represents.
  env.tickBar(240_000);
  env.send('paper-orders', {
    enabled: true, axisBasis: 'mcap', refPrice: 0.001, currentPriceNative: 0.001,
    orders: [{ id: 'o1', kind: 'tp', triggerPrice: 0.002, sizePct: 100 }],
  });

  const line = env.orderLines[0];
  assert.equal(line.values.setPrice, 480_000,
    'double the price is double the cap — the line is drawn in the axis unit');

  // User drags it down to 360K MC.
  line.dragTo(360_000);
  const move = moves(env).pop();
  assert.equal(move.payload.ok, true);
  assert.ok(Math.abs(move.payload.triggerPrice - 0.0015) < 1e-12,
    '360K of a 240K-at-0.001 token is 0.0015 — the cap is inverted back to a price');
});

test('on a USD axis the drag inverts through the USD rate', () => {
  const env = runBridge();
  env.send('paper-orders', {
    enabled: true, axisBasis: 'usd',
    refPrice: 0.001,           // trigger prices are quoted in SOL
    currentPriceNative: 0.001,
    currentPriceUsd: 0.24,     // ...and the axis is USD
    orders: [{ id: 'o1', kind: 'tp', triggerPrice: 0.002, sizePct: 100 }],
  });
  assert.equal(env.orderLines[0].values.setPrice, 0.48, 'drawn in USD');

  env.orderLines[0].dragTo(0.36);
  const move = moves(env).pop();
  assert.ok(Math.abs(move.payload.triggerPrice - 0.0015) < 1e-12,
    'the USD level comes back as a SOL price');
});

test('a round trip through any basis returns the level it started from', () => {
  // The property that matters: draw(x) then drag-back must be identity, or a
  // line the user never touched would drift every repost.
  for (const basis of ['native', 'usd', 'mcap']) {
    const env = runBridge();
    if (basis === 'mcap') env.tickBar(240_000);
    env.send('paper-orders', {
      enabled: true, axisBasis: basis, refPrice: 0.001,
      currentPriceNative: 0.001, currentPriceUsd: 0.24,
      orders: [{ id: 'o1', kind: 'sl', triggerPrice: 0.0007, sizePct: 100 }],
    });
    const line = env.orderLines[0];
    line.dragTo(line.values.setPrice);   // "drag" it exactly where it already is
    const move = moves(env).pop();
    assert.ok(Math.abs(move.payload.triggerPrice - 0.0007) < 1e-12,
      `${basis}: an untouched line must report the level unchanged`);
  }
});

test('with no bar close yet, an mcap axis draws NOTHING rather than guessing', () => {
  const env = runBridge();
  // No tickBar(): the cap the current price represents is unknown.
  env.send('paper-orders', {
    enabled: true, axisBasis: 'mcap', refPrice: 0.001, currentPriceNative: 0.001,
    orders: [{ id: 'o1', kind: 'tp', triggerPrice: 0.002, sizePct: 100 }],
  });
  assert.equal(env.orderLines.length, 0,
    'a level that cannot be converted is absent, never approximated');
});

test('a drag that cannot be inverted is refused and the line snaps back', () => {
  const env = runBridge();
  env.tickBar(240_000);
  env.send('paper-orders', {
    enabled: true, axisBasis: 'mcap', refPrice: 0.001, currentPriceNative: 0.001,
    orders: [{ id: 'o1', kind: 'tp', triggerPrice: 0.002, sizePct: 100 }],
  });
  const line = env.orderLines[0];

  line.dragTo(0);                      // a nonsense level
  const move = moves(env).pop();
  assert.equal(move.payload.ok, false, 'the wallet is told the drag failed');
  assert.equal(move.payload.reason, 'axis-unit-unknown');
  assert.equal(line.values.setPrice, 480_000,
    'the line is put back where the wallet still believes it is');
});

/* ---------------- cancel + capability ---------------- */

test('the cancel button reports the order id back to the wallet', () => {
  const env = runBridge();
  env.send('paper-orders', {
    enabled: true, axisBasis: 'native', refPrice: 0.001, currentPriceNative: 0.001,
    orders: [{ id: 'o1', kind: 'sl', triggerPrice: 0.0005, sizePct: 100 }],
  });
  env.orderLines[0].handlers.cancel();
  assert.equal(cancels(env).pop().payload.id, 'o1');
});

test('a chart with no broker primitives says so once instead of drawing dead lines', () => {
  // F-39: a standalone charting library THROWS on createOrderLine. A locked
  // horizontal_line would look identical and refuse to move, which is worse
  // than not offering the drag at all — so the feature withdraws and says why.
  const env = runBridge({ brokerThrows: true });
  env.send('paper-orders', {
    enabled: true, axisBasis: 'native', refPrice: 0.001, currentPriceNative: 0.001,
    orders: [{ id: 'o1', kind: 'tp', triggerPrice: 0.002, sizePct: 100 }],
  });

  const status = ordersOf(env).find((m) => m.payload.reason === 'no-draggable-lines');
  assert.ok(status, 'the content script is told this chart cannot carry a draggable line');
  assert.equal(status.payload.ok, false);
  assert.equal(env.orderLines.length, 0, 'nothing is drawn');
});

/* ---------------- lifecycle ---------------- */

test('junk orders are filtered before anything is drawn', () => {
  const env = runBridge();
  env.send('paper-orders', {
    enabled: true, axisBasis: 'native', refPrice: 0.001, currentPriceNative: 0.001,
    orders: [
      { id: '', kind: 'tp', triggerPrice: 0.002 },        // no id
      { id: 'o2', kind: 'tp', triggerPrice: 0 },          // no level
      { id: 'o3', kind: 'tp', triggerPrice: 'banana' },   // not a number
      { id: 'o4', kind: 'tp', triggerPrice: 0.002, sizePct: 100 },  // the only good one
    ],
  });
  assert.equal(env.orderLines.length, 1);
});

test('disabled means no lines at all', () => {
  const env = runBridge();
  env.send('paper-orders', {
    enabled: false, axisBasis: 'native', refPrice: 0.001, currentPriceNative: 0.001,
    orders: [{ id: 'o1', kind: 'tp', triggerPrice: 0.002, sizePct: 100 }],
  });
  assert.equal(env.orderLines.length, 0);
});

test('standdown erases the order lines with everything else', () => {
  const env = runBridge();
  env.send('paper-orders', {
    enabled: true, axisBasis: 'native', refPrice: 0.001, currentPriceNative: 0.001,
    orders: [{ id: 'o1', kind: 'tp', triggerPrice: 0.002, sizePct: 100 }],
  });
  env.send('standdown');
  assert.equal(env.orderLines[0].removed, true,
    'a disabled overlay leaves nothing of PaperTrench on the chart');
});

test('a repost at a new level MOVES the line instead of rebuilding it', () => {
  // Rebuilding would drop a drag in progress on another line, and would make
  // the chart flicker on every wallet write.
  const env = runBridge();
  const base = { enabled: true, axisBasis: 'native', refPrice: 0.001, currentPriceNative: 0.001 };
  env.send('paper-orders', { ...base, orders: [{ id: 'o1', kind: 'tp', triggerPrice: 0.002, sizePct: 100 }] });
  env.send('paper-orders', { ...base, orders: [{ id: 'o1', kind: 'tp', triggerPrice: 0.003, sizePct: 100 }] });

  assert.equal(env.orderLines.length, 1, 'still one line object — not rebuilt');
  assert.equal(env.orderLines[0].values.setPrice, 0.003, 'moved to the new level');
  assert.equal(env.orderLines[0].removed, false);
});

test('an untouched order line NEVER moves between mcap-axis reposts (D-42 Bug 6)', () => {
  // Live report: "the TP and SL set by papertrench move dynamically with MC
  // movement — it should be a fixed MC". The stored trigger is absolute, but
  // the draw math anchored one side on the live bar close and the other on
  // the stale post-time price, so every redraw re-derived a different level.
  // Now: the per-post axis-unit snapshot (refPrice + its unit level) defines
  // the conversion, and an unchanged order's line is not even re-set.
  const env = runBridge();
  // The chart must have a bar before the bridge can hold a widget (see the
  // mcap drag test above).
  env.tickBar(50_000);
  const trigger = 0.002;
  const post = (currentPriceNative) => env.send('paper-orders', {
    enabled: true, axisBasis: 'mcap', refPrice: 0.001,
    // D-42: the per-post unit snapshot — the mcap the axis showed when
    // refPrice was captured. Supply is constant, so this pair is a fixed
    // conversion: level = refMcap × trigger/refPrice, identical on every
    // redraw no matter where the market has run.
    refMcap: 50_000,
    currentPriceNative,
    orders: [{ id: 'o1', kind: 'tp', triggerPrice: trigger, sizePct: 100 }],
  });
  post(0.001);
  const level1 = env.orderLines[0].values.setPrice;
  assert.ok(level1 > 0, 'the line drew at a positive axis level');
  // The market runs 4x between sweeps; the SAME order must sit at the SAME
  // axis level — a fixed MC, not one that drifts with the live price.
  post(0.004);
  const level2 = env.orderLines[0].values.setPrice;
  assert.equal(level2, level1, 'the TP line did not move when MC moved');
  // A THIRD sweep at the same live price must not even call setPrice again
  // (the old code re-set every line every 1 s sweep — TradingView treats
  // that as a move and the line visibly "walks").
  const before = env.orderLines[0].values.setPrice;
  delete env.orderLines[0].values.setPrice;
  post(0.004);
  assert.equal(env.orderLines[0].values.setPrice, undefined,
    'an unchanged level is not re-set on the sweep');
  assert.equal(before, level1);
});
