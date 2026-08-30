/* Native chart integration for the sites that broke in production.
 *
 * Three verified-on-site failure modes are locked down here:
 *
 *  1. GMGN upgraded its TradingView build to the ASYNC widget API:
 *     createOrderLine() / createExecutionShape() return Promises. The bridge
 *     must tolerate both the sync and async shapes, or every native line and
 *     fill bubble dies in a swallowed TypeError.
 *
 *  2. Axiom publishes NO window global for its TradingView widget — instances
 *     live in React fiber refs. Discovery must walk the fiber tree from the
 *     standard `tradingview_*` iframe, then patch subscribeBars/getMarks.
 *
 *  3. GMGN's realtime WebSocket announces every trade on `token_activity`
 *     with terse keys (`a` mint, `pu` USD price) that the generic collector
 *     cannot see; the bridge must translate them into mint-tagged USD ticks.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function microtasks(n = 4) {
  let p = Promise.resolve();
  for (let i = 0; i < n; i++) p = p.then(() => {});
  return p;
}

function makeAsyncAdapter(record) {
  const adapter = { removed: false, values: {}, calls: [] };
  const methods = [
    'setText', 'setQuantity', 'setLineColor', 'setLineStyle', 'setLineWidth',
    'setPrice', 'setBodyFont', 'setBodyTextColor', 'setBodyBorderColor',
    'setBodyBackgroundColor', 'setEditable', 'setTextColor', 'setArrowColor',
    'setDirection', 'setTime',
  ];
  for (const method of methods) {
    adapter[method] = function (value) {
      this.values[method] = value;
      this.calls.push([method, value]);
      return this;
    };
  }
  adapter.remove = function () { this.removed = true; return this; };
  record.push(adapter);
  return adapter;
}

/**
 * Boot the shipped price-bridge.js inside a sandbox that mimics the parts of
 * GMGN and Axiom the bridge touches. Everything is opt-in via `opts`.
 */
function runBridge(opts = {}) {
  const timers = [];
  const emitted = [];
  const listeners = {};
  const orderLines = [];
  const execShapes = [];

  // ---- GMGN chart manager behind a React fiber on #global-tv-overlay ----
  // The chart object is replaceable (C-12: GMGN remounts its chart on
  // timeframe changes) and its createExecutionShape can be made to fail N
  // times (C-13: mid-boot charts refuse draws).
  let gmgnShapeFailures = 0;
  function makeGmgnChart() {
    return {
      createOrderLine: () => Promise.resolve(makeAsyncAdapter(orderLines)),
      createExecutionShape: () => {
        if (gmgnShapeFailures > 0) { gmgnShapeFailures -= 1; throw new Error('Value is null'); }
        return Promise.resolve(makeAsyncAdapter(execShapes));
      },
    };
  }
  let gmgnChart = makeGmgnChart();
  let gmgnMounted = Boolean(opts.gmgnMounted);
  const gmgnHost = {};
  Object.defineProperty(gmgnHost, '__reactFiber$test', {
    value: {
      return: null,
      child: null,
      sibling: null,
      memoizedState: {
        memoizedState: {
          current: {
            widgetSubject: {},
            activeChartSubject: {},
            chartsSubject: {},
            getActiveChart: () => gmgnChart,
          },
        },
        next: null,
      },
    },
    enumerable: true,
  });

  // ---- Axiom widgets behind fiber refs near the tradingview iframe ----
  // Axiom keeps a visible chart AND a broken preload chart ("UNKNOWN-..."
  // symbol; every draw call throws "Value is null"). The bridge must rank
  // the real chart first and never die on the preload.
  let axiomRealtime = null;
  let axiomGetMarksCalls = 0;
  let exportRows = opts.exportRows || null; // [[time, o, h, l, close], ...]
  const AXIOM_PAIR = 'H6NXABY6J8MKD2HOMS71R7K3FY9DGVFBQHJYUXZN2S2R';
  const axiomDatafeed = {
    subscribeBars(symbolInfo, resolution, callback) { axiomRealtime = callback; },
    getMarks(symbolInfo, from, to, callback) {
      axiomGetMarksCalls += 1;
      callback([]);
    },
  };
  // C-15 tests: a per-call plan can make the REAL chart refuse createOrderLine
  // (index-based), modelling a chart that accepts the buy line then refuses
  // the sell line mid-boot.
  let axiomOrderLineCalls = 0;
  let axiomOrderLinePlan = null;
  const axiomChart = {
    clearMarks() {},
    refreshMarks() {},
    symbol: () => opts.axiomChartSymbol || `${AXIOM_PAIR}-USD-123`,
    createOrderLine: () => {
      const idx = axiomOrderLineCalls++;
      if (axiomOrderLinePlan && axiomOrderLinePlan(idx)) throw new Error('Value is null');
      return Promise.resolve(makeAsyncAdapter(orderLines));
    },
    createExecutionShape: () => Promise.resolve(makeAsyncAdapter(execShapes)),
    exportData: () => Promise.resolve({
      schema: ['time', 'open', 'high', 'low', 'close'],
      data: exportRows || [],
    }),
  };
  // The preload chart: normally a seriesless shell, but Axiom also preloads
  // charts for OTHER tokens — a real symbol and working API, wrong token.
  let preloadRealtime = null;
  const preloadLines = [];
  const preloadExportRows = opts.preloadExportRows || [];
  const preloadDatafeed = {
    subscribeBars(symbolInfo, resolution, callback) { preloadRealtime = callback; },
    getMarks(symbolInfo, from, to, callback) { callback([]); },
  };
  const preloadChart = opts.wrongTokenPreload
    ? {
        clearMarks() {},
        refreshMarks() {},
        symbol: () => 'ZZZWRONGTOKEN999-USD-1',
        createOrderLine: () => Promise.resolve(makeAsyncAdapter(preloadLines)),
        createExecutionShape: () => { throw new Error('Value is null'); },
        exportData: () => Promise.resolve({ schema: ['time', 'open', 'high', 'low', 'close'], data: preloadExportRows }),
      }
    : {
        clearMarks() {},
        refreshMarks() {},
        symbol: () => 'UNKNOWN-USD-999',
        createOrderLine: () => { throw new Error('Value is null'); },
        createExecutionShape: () => { throw new Error('Value is null'); },
        exportData: () => Promise.resolve({ schema: ['time', 'open', 'high', 'low', 'close'], data: [] }),
      };
  const axiomWidget = opts.swapAccessors
    ? {
        // Some TradingView widgets expose a seriesless shell through
        // activeChart() while chart() carries the real series (Axiom's own
        // drawing code uses chart() exclusively).
        _options: { datafeed: axiomDatafeed },
        activeChart: () => preloadChart,
        chart: () => axiomChart,
        onChartReady: () => {},
      }
    : {
        _options: { datafeed: axiomDatafeed },
        activeChart: () => axiomChart,
        onChartReady: () => {},
      };
  const preloadWidget = {
    _options: { datafeed: preloadDatafeed },
    activeChart: () => preloadChart,
    onChartReady: () => {},
  };
  const axiomParent = {};
  Object.defineProperty(axiomParent, '__reactFiber$ax', {
    value: {
      return: null,
      child: null,
      sibling: null,
      memoizedState: {
        // The PRELOAD widget is deliberately encountered FIRST so ranking,
        // not discovery order, decides which chart gets drawn on.
        memoizedState: { current: preloadWidget },
        next: {
          memoizedState: { current: axiomWidget },
          next: null,
        },
      },
    },
    enumerable: true,
  });
  const axiomIframe = { id: 'tradingview_ab12', parentElement: axiomParent, contentWindow: null };
  // The Axiom DOM can appear LATE (SPA mount) — F-26 stand-down tests flip
  // this on mid-test via env.enableAxiom().
  let axiomVisible = Boolean(opts.axiom);

  // ---- optional screener-row DOM for the chip occlusion tests (O-22) ----
  let panelOverChip = false;
  let rowDomNodes = null;
  function makeChipNode(tag) {
    return {
      tag, style: {}, isConnected: true, children: [],
      classList: { add() {}, remove() {}, contains() { return false; } },
      appendChild(c) { this.children.push(c); c.parentElement = this; return c; },
      remove() { this.isConnected = false; },
      contains(n) { return n === this; },
      setAttribute() {}, getAttribute() { return null; },
      getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    };
  }
  if (opts.rowDom) {
    const anchor = makeChipNode('a');
    anchor.getAttribute = (name) => (name === 'href' ? '/meme/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' : null);
    const row = makeChipNode('div');
    row.getBoundingClientRect = () => ({ top: 100, left: 10, right: 510, bottom: 180, width: 500, height: 80 });
    anchor.parentElement = row;
    const list = makeChipNode('div');
    list.children.push(row);
    row.parentElement = list;
    const body = makeChipNode('body');
    // What elementFromPoint reports where the PANEL sits: the shadow host.
    const hostEl = { id: 'papertrench-host' };
    rowDomNodes = { anchor, row, list, body, hostEl };
  }

  const doc = {
    getElementById: (id) => (id === 'global-tv-overlay' && gmgnMounted ? gmgnHost : null),
    querySelector: (sel) => (axiomVisible && String(sel).includes('iframe[id^="tradingview_"]') ? axiomIframe : null),
    querySelectorAll: (sel) => {
      const s = String(sel);
      if (axiomVisible && s.includes('iframe[id^="tradingview_"]')) return [axiomIframe];
      if (rowDomNodes && s === 'a.testrow') return [rowDomNodes.anchor];
      return [];
    },
  };
  // Style-write accounting for the Turbo read/write-phase tests: every
  // assignment to a created element's style counts as one layout-dirtying
  // write. Cheap Proxy, only active when a test asks for the row DOM.
  let styleWrites = 0;
  function countingChipNode(tag) {
    const node = makeChipNode(tag);
    const plain = node.style;
    node.style = new Proxy(plain, {
      set(target, prop, value) { styleWrites += 1; target[prop] = value; return true; },
    });
    return node;
  }
  if (rowDomNodes) {
    doc.body = rowDomNodes.body;
    doc.createElement = (t) => countingChipNode(t);
    // Probes to the LEFT of the row's right edge hit the row itself; probes
    // near the chip's right-edge anchor hit the PaperTrench shadow host
    // while the fake panel "covers" that spot.
    doc.elementFromPoint = (x) => (panelOverChip && x > 400 ? rowDomNodes.hostEl : rowDomNodes.row);
  }

  function FakeWebSocket() {}
  FakeWebSocket.prototype.addEventListener = () => {};
  FakeWebSocket.CONNECTING = 0;
  FakeWebSocket.OPEN = 1;
  FakeWebSocket.CLOSING = 2;
  FakeWebSocket.CLOSED = 3;

  function FakeXHR() {}
  FakeXHR.prototype.send = function () {};
  FakeXHR.prototype.addEventListener = function () {};

  const win = {
    // opts.fetchResponse(url) lets a test hand the tap an instrumented
    // response (clone counters, content-length headers) per requested URL.
    fetch: (...args) => Promise.resolve(opts.fetchResponse ? opts.fetchResponse(args[0]) : {
      url: '', headers: { get: () => 'application/json' },
      clone: () => ({ text: () => Promise.resolve('{}') }),
    }),
    XMLHttpRequest: FakeXHR,
    WebSocket: FakeWebSocket,
    SharedWorker: undefined,
    EventSource: undefined,
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener(type, fn) { listeners[type] = fn; },
    postMessage(message) { emitted.push(message); },
  };
  win.window = win;

  // Timeouts are collected, not executed: the bridge's retry loops would
  // recurse unboundedly under a synchronous fake. Tests advance them with
  // env.runTimeouts().
  const timeouts = new Map();
  let timeoutSeq = 0;

  const href = opts.href || 'https://gmgn.ai/sol/token/Mint1';
  // Controllable clock: stress tests need to space batches by tens of
  // milliseconds deterministically. Untouched, it follows real time.
  const RealDate = Date;
  let fakeNow = null;
  class TestDate extends RealDate {
    constructor(...args) {
      if (args.length === 0 && fakeNow !== null) { super(fakeNow); } else { super(...args); }
    }
    static now() { return fakeNow !== null ? fakeNow : RealDate.now(); }
  }
  const sandbox = {
    window: win,
    document: doc,
    location: { href, hostname: new URL(href).hostname },
    console, Date: TestDate, Math, Number, String, Array, Object, Boolean, RegExp,
    Error, Set, WeakSet, WeakMap, Map, Symbol, JSON, Promise, isFinite,
    MutationObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
    setInterval(fn) { timers.push(fn); return timers.length; },
    // Functional: the bridge's boot prober clears itself once it succeeds
    // (or gives up), and the stand-down tests depend on that being real.
    clearInterval(id) { if (timers[id - 1]) timers[id - 1] = () => {}; },
    setTimeout(fn) { timeouts.set(++timeoutSeq, fn); return timeoutSeq; },
    clearTimeout(id) { timeouts.delete(id); },
  };

  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'price-bridge.js'), 'utf8'), ctx, {
    filename: 'price-bridge.js',
  });

  return {
    emitted,
    listeners,
    orderLines,
    execShapes,
    win,
    timers,
    mountGmgn: () => { gmgnMounted = true; },
    remountGmgn: () => { gmgnChart = makeGmgnChart(); },
    failGmgnShapes: (n) => { gmgnShapeFailures = n; },
    setAxiomOrderLinePlan: (fn) => { axiomOrderLinePlan = fn; axiomOrderLineCalls = 0; },
    enableAxiom: () => { axiomVisible = true; },
    setPanelOverChip: (on) => { panelOverChip = Boolean(on); },
    rowDebug: () => (typeof win.__ptRowChipDebug === 'function' ? win.__ptRowChipDebug() : []),
    styleWrites: () => styleWrites,
    resetStyleWrites: () => { styleWrites = 0; },
    axiomRealtime: () => axiomRealtime,
    axiomGetMarksCalls: () => axiomGetMarksCalls,
    axiomDatafeed,
    preloadDatafeed,
    preloadRealtime: () => preloadRealtime,
    preloadLines,
    AXIOM_PAIR,
    setExportRows: (rows) => { exportRows = rows; },
    setNow(t) { fakeNow = t; },
    advance(ms) { fakeNow = (fakeNow === null ? RealDate.now() : fakeNow) + ms; },
    send(type, payload) {
      listeners.message({
        source: win,
        data: { source: 'papertrench-content', type, payload },
      });
    },
    runTimers() { for (const fn of timers.slice()) fn(); },
    runTimeouts() {
      const pending = [...timeouts.values()];
      timeouts.clear();
      for (const fn of pending) fn();
    },
  };
}

/* ------------------------------------------------------------------ *
 * 1. GMGN async TradingView API
 * ------------------------------------------------------------------ */

test('GMGN average lines survive the async createOrderLine API', async () => {
  const env = runBridge({ gmgnMounted: true });

  env.send('gmgn-lines', {
    enabled: true,
    avgBuyMcap: 250_000_000,
    avgSellMcap: 300_000_000,
    avgBuyText: 'PT Avg Buy $250M',
    avgSellText: 'PT Avg Sell $300M',
  });
  await microtasks();

  assert.equal(env.orderLines.length, 2, 'both average lines must be created');
  const buy = env.orderLines.find((l) => l.values.setPrice === 250_000_000);
  const sell = env.orderLines.find((l) => l.values.setPrice === 300_000_000);
  assert.ok(buy, 'buy line must sit at the buy market cap');
  assert.ok(sell, 'sell line must sit at the sell market cap');
  assert.equal(buy.values.setText, 'PT Avg Buy $250M');
  assert.equal(buy.removed, false);
});

test('GMGN fill markers survive the async createExecutionShape API', async () => {
  const env = runBridge({ gmgnMounted: true });
  const ts = Date.now();

  env.send('gmgn-marker', { ts, mcap: 250_000_000, side: 'buy', text: 'PT Buy $250M' });
  await microtasks();

  assert.equal(env.execShapes.length, 1, 'the fill must be drawn as an execution shape');
  const shape = env.execShapes[0];
  assert.equal(shape.values.setPrice, 250_000_000);
  assert.equal(shape.values.setDirection, 'buy');
  assert.equal(shape.values.setTime, Math.floor(ts / 1000));
  assert.equal(shape.values.setText, 'PT Buy $250M');
  assert.equal(shape.removed, false);
});

test('GMGN markers queued before the chart mounts are drawn once it appears', async () => {
  const env = runBridge({ gmgnMounted: false });
  const ts = Date.now();

  // Journal restore fires before GMGN's chart manager exists.
  env.send('gmgn-marker', { ts, mcap: 100_000_000, side: 'sell', text: 'PT Sell $100M' });
  await microtasks();
  assert.equal(env.execShapes.length, 0, 'no chart yet, nothing to draw');

  env.mountGmgn();
  env.runTimeouts(); // the pending drain retry fires once the chart exists
  await microtasks();

  assert.equal(env.execShapes.length, 1, 'the queued fill must be drawn after mount');
  assert.equal(env.execShapes[0].values.setDirection, 'sell');
});

test('clearing GMGN markers also cancels shapes still being created', async () => {
  const env = runBridge({ gmgnMounted: true });
  env.send('gmgn-marker', { ts: Date.now(), mcap: 100_000_000, side: 'buy' });
  env.send('gmgn-marker-clear', null);
  await microtasks();
  // The shape may resolve after the clear; it must remove itself.
  assert.ok(env.execShapes.every((s) => s.removed), 'late-resolving shapes must self-remove');
});

/* ------------------------------------------------------------------ *
 * 2. Axiom fiber widget discovery
 * ------------------------------------------------------------------ */

test('the Axiom widget is discovered through React fibers and its bars are hooked', () => {
  const env = runBridge({ axiom: true, gmgnMounted: false, href: 'https://axiom.trade/meme/Pair1' });
  env.runTimers();

  assert.equal(typeof env.axiomDatafeed.subscribeBars, 'function');
  // The patch marks itself; subscribing must reach our wrapper.
  let delivered = null;
  env.axiomDatafeed.subscribeBars({}, '1S', (bar) => { delivered = bar; }, 'sub', () => {});
  assert.equal(typeof env.axiomRealtime(), 'function', 'subscribeBars must be wrapped via fiber discovery');

  const bar = { time: 1_700_000_000_000, close: 0.0000042 };
  env.axiomRealtime()(bar);
  assert.equal(delivered, bar, 'Axiom must still receive its own callback');
  const tick = env.emitted.find((m) => m.type === 'tick' && m.payload?.source === 'padre-chart-bar');
  assert.ok(tick, 'Axiom chart bars must emit live ticks');
});

test('fiber-discovered datafeeds serve paper fills through getMarks on non-forced hosts', () => {
  const env = runBridge({ axiom: true, href: 'https://trade.padre.gg/trade/Mint1' });
  env.runTimers();
  const ts = Date.now();

  env.send('paper-marker', {
    ts, side: 'buy', priceNative: 0.00001, priceUsd: 0.0021, mcap: 2_100_000, solAmount: 0.5, symbol: 'AX',
  });

  let marks = null;
  env.axiomDatafeed.getMarks({}, Math.floor(ts / 1000) - 60, Math.floor(ts / 1000) + 60, (r) => { marks = r; });
  assert.ok(Array.isArray(marks));
  assert.ok(marks.some((m) => String(m.id).startsWith('papertrench-buy-')),
    'the paper fill must be served through the fiber-discovered datafeed');
});

test('fills fall back to execution shapes when the site never pulls marks', async () => {
  const env = runBridge({ axiom: true, href: 'https://trade.padre.gg/trade/Mint1' });
  env.runTimers();
  const ts = Date.now();

  // Feed a live bar first so the fallback knows the chart's Y-axis unit
  // (this chart plots market cap).
  env.axiomDatafeed.subscribeBars({}, '1S', () => {}, 'sub', () => {});
  env.axiomRealtime()({ time: ts, close: 2_000_000 });

  env.send('paper-marker', {
    ts, side: 'buy', priceNative: 0.00001, priceUsd: 0.0021, mcap: 2_100_000, solAmount: 0.5, symbol: 'AX',
  });
  // Let the fallback check fire; the site's getMarks was never invoked by the
  // library itself, so the pipeline counts as dead.
  env.runTimeouts();
  await microtasks();

  const shape = env.execShapes.find((s) => s.values.setDirection === 'buy');
  assert.ok(shape, 'with a dead marks pipeline the fill must be drawn as an execution shape');
  assert.equal(shape.values.setPrice, 2_100_000,
    'the shape must sit on the market-cap axis the chart actually displays');
});

test('the shape fallback yields back to native marks when the pipeline revives', async () => {
  const env = runBridge({ axiom: true, href: 'https://trade.padre.gg/trade/Mint1' });
  env.runTimers();
  const ts = Date.now();

  env.send('paper-marker', {
    ts, side: 'buy', priceNative: 0.00001, priceUsd: 0.0021, mcap: 2_100_000, solAmount: 0.5, symbol: 'AX',
  });
  env.runTimeouts(); // fallback check fires, shapes get drawn
  await microtasks();

  // The library starts pulling marks after all (slow boot, not a dead pipeline).
  let marks = null;
  env.axiomDatafeed.getMarks({}, Math.floor(ts / 1000) - 60, Math.floor(ts / 1000) + 60, (r) => { marks = r; });
  await microtasks();

  assert.ok(marks.some((m) => String(m.id).startsWith('papertrench-buy-')),
    'native marks must serve the fill once the pipeline runs');
  assert.ok(env.execShapes.every((s) => s.removed),
    'fallback shapes must be removed so the fill is not drawn twice');
});

test('on Axiom, paper buys render as its native tracked-wallet bubbles', async () => {
  // Contract from Axiom's own bundle (settings atoms): user/tracked trades
  // are TradingView marks — B/S label on a colored circle (default user
  // colors #089981 buy / #f23645 sell, size 25) with "You bought $X at $Y
  // Market Cap" hover text, time snapped to the bar grid. Paper fills must be
  // indistinguishable, and must NOT double as execution shapes while the
  // marks pipeline is alive.
  const env = runBridge({ axiom: true, href: 'https://axiom.trade/meme/Pair1' });
  env.runTimers();
  // Simulate the chart subscribing at 1-minute so times snap to the grid.
  env.axiomDatafeed.subscribeBars({}, '1', () => {}, 'sub', () => {});
  const ts = Date.now();

  env.send('paper-marker', {
    ts, side: 'buy', priceNative: 0.00001, priceUsd: 0.0021, mcap: 2_100_000, solAmount: 0.5, symbol: 'AX',
  });
  await microtasks();
  assert.equal(env.execShapes.length, 0, 'with a live marks pipeline there must be no shape fallback');

  let marks = null;
  env.axiomDatafeed.getMarks({}, Math.floor(ts / 1000) - 120, Math.floor(ts / 1000) + 120, (r) => { marks = r; });
  const mark = marks.find((m) => String(m.id).startsWith('papertrench-buy-'));
  assert.ok(mark, 'the fill must be served through the marks pipeline');
  assert.equal(mark.label, 'B');
  assert.equal(mark.labelFontColor, 'white');
  assert.equal(mark.minSize, 25, 'must match the default userBubbleSize');
  assert.equal(mark.color.background, '#089981', 'must match userBuyBubbleColor');
  assert.equal(mark.color.border, '#08998180');
  assert.match(mark.text, /^You bought \$105\.00 at \$2\.10M Market Cap \(Paper\)$/,
    'hover text must read like Axiom prints its own trade bubbles');
  assert.equal(mark.time, Math.floor(ts / 60000) * 60, 'mark time must snap to the 1-minute bar grid');
});

test('on Axiom, paper sells use the native red sell bubble', () => {
  const env = runBridge({ axiom: true, href: 'https://axiom.trade/meme/Pair1' });
  env.runTimers();
  const ts = Date.now();

  env.send('paper-marker', {
    ts, side: 'sell', priceNative: 0.00002, priceUsd: 0.004, mcap: 4_000_000, solAmount: 0.25, symbol: 'AX',
  });

  let marks = null;
  env.axiomDatafeed.getMarks({}, Math.floor(ts / 1000) - 120, Math.floor(ts / 1000) + 120, (r) => { marks = r; });
  const mark = marks.find((m) => String(m.id).startsWith('papertrench-sell-'));
  assert.ok(mark);
  assert.equal(mark.label, 'S');
  assert.equal(mark.color.background, '#f23645', 'must match userSellBubbleColor');
  assert.match(mark.text, /^You sold \$50\.00 at \$4\.00M Market Cap \(Paper\)$/);
});

test('average fill lines follow a SOL-denominated chart axis', async () => {
  // Axiom's USD/SOL toggle makes the chart plot the token in SOL. The line
  // candidates span USD price, USD market cap, SOL price and SOL market cap;
  // the SOL bar close must select the SOL fill price.
  const env = runBridge({ axiom: true, href: 'https://axiom.trade/meme/Pair1' });
  env.runTimers();
  env.axiomDatafeed.subscribeBars({}, '1', () => {}, 'sub', () => {});
  env.axiomRealtime()({ time: Date.now(), close: 8.2e-8 }); // SOL-mode chart

  env.send('paper-lines', {
    enabled: true,
    avgBuyUsd: 1.72e-5, avgBuyMcap: 17_200,
    avgBuyNative: 8e-8, avgBuyMcapNative: 80,
  });
  await microtasks();

  const line = env.orderLines.find((l) => l.values.setPrice !== undefined);
  assert.ok(line, 'the fill line must be created');
  assert.equal(line.values.setPrice, 8e-8,
    'on a SOL chart the average fill line must sit at the SOL fill price, not ~215x away at the USD one');
});

test('Axiom hover text prints SOL when the chart axis is SOL-denominated', () => {
  const env = runBridge({ axiom: true, href: 'https://axiom.trade/meme/Pair1' });
  env.runTimers();
  env.axiomDatafeed.subscribeBars({}, '1', () => {}, 'sub', () => {});
  env.axiomRealtime()({ time: Date.now(), close: 8.2e-8 });

  const ts = Date.now();
  env.send('paper-marker', {
    ts, side: 'buy', priceNative: 8e-8, priceUsd: 1.72e-5, mcap: 17_200, solAmount: 0.5, symbol: 'AX',
  });

  let marks = null;
  env.axiomDatafeed.getMarks({}, Math.floor(ts / 1000) - 120, Math.floor(ts / 1000) + 120, (r) => { marks = r; });
  const mark = marks.find((m) => String(m.id).startsWith('papertrench-buy-'));
  assert.ok(mark);
  assert.match(mark.text, /^You bought \$107\.50 at 0\.00000008 SOL \(Paper\)$/,
    'the hover price must be in the units the chart is displaying');
});

test('on Axiom, a dead marks pipeline still falls back to execution shapes', async () => {
  const env = runBridge({ axiom: true, href: 'https://axiom.trade/meme/Pair1' });
  env.runTimers();
  const ts = Date.now();

  // C-05: with no bar close the shape's Y unit is unknowable, so the bridge
  // now (correctly) refuses to draw. Feed a live close first — the original
  // pre-fix version of this test drew a first-usable-candidate shape with no
  // evidence, which is exactly the wrong-unit first paint the fix removes.
  env.axiomDatafeed.subscribeBars({}, '1S', () => {}, 'sub', () => {});
  env.axiomRealtime()({ time: ts, close: 2_000_000 });

  env.send('paper-marker', {
    ts, side: 'buy', priceNative: 0.00001, priceUsd: 0.0021, mcap: 2_100_000, solAmount: 0.5, symbol: 'AX',
  });
  env.runTimeouts(); // fallback check fires; the harness's fake library never pulls marks
  await microtasks();

  assert.ok(env.execShapes.some((s) => s.values.setDirection === 'buy'),
    'if TradingView never requests marks the fill must still appear as a shape');
});

test('lines fall back to widget.chart() when activeChart() is a seriesless shell', async () => {
  // Axiom's own line-drawing code calls widget.chart(), not activeChart() —
  // on a multi-chart widget the "active" chart can refuse every draw call.
  const env = runBridge({ axiom: true, swapAccessors: true, href: 'https://axiom.trade/meme/Pair1' });
  env.runTimers();

  // axisBasis is stated because C-05 forbids unit-guessing before any bar
  // close exists (the pre-fix test relied on the first-usable fallback).
  env.send('paper-lines', { enabled: true, axisBasis: 'usd', avgBuyUsd: 0.0021, avgBuyMcap: 2_100_000 });
  await microtasks();

  const line = env.orderLines.find((l) => l.values.setPrice !== undefined);
  assert.ok(line, 'the average line must be created through the working chart accessor');
  assert.equal(line.removed, false);
});

test('lines and shapes land on the real chart, never the broken preload chart', async () => {
  const env = runBridge({ axiom: true, href: 'https://axiom.trade/meme/Pair1' });
  env.runTimers();

  // axisBasis stated: C-05 refuses to draw with no close and no known basis.
  env.send('paper-lines', { enabled: true, axisBasis: 'usd', avgBuyUsd: 0.0021, avgSellUsd: null });
  await microtasks();

  // The preload chart throws on createOrderLine; the ranked selection must
  // have routed the line to the chart with a real symbol.
  const line = env.orderLines.find((l) => l.values.setPrice === 0.0021);
  assert.ok(line, 'the average line must be created on the usable chart');
  assert.equal(line.removed, false);
});

/* ------------------------------------------------------------------ *
 * 2b. Chart-export price peg
 * ------------------------------------------------------------------ */

test('an explicit axis basis from the chart ticks wins over magnitude guessing', async () => {
  // Once a live chart tick validates, the content script knows whether the
  // chart plots price or market cap in USD or SOL — the line must use that,
  // even when the bar close would be ambiguous.
  const env = runBridge({ axiom: true, href: 'https://axiom.trade/meme/Pair1' });
  env.runTimers();

  env.send('paper-lines', {
    enabled: true,
    axisBasis: 'native-mcap',
    avgBuyUsd: 1.72e-5, avgBuyMcap: 17_200,
    avgBuyNative: 8e-8, avgBuyMcapNative: 80,
  });
  await microtasks();

  const line = env.orderLines.find((l) => l.values.setPrice !== undefined);
  assert.ok(line, 'the line must be created');
  assert.equal(line.values.setPrice, 80, 'the SOL market-cap candidate must win when the chart is SOL-MC');
});

test('average market-cap lines are computed from the live bar close, not a stale resolver mcap', async () => {
  // Axiom Final Stretch and freshly-migrated coins can have a resolver mcap
  // that is very different from the chart's own mcap. The bridge must use the
  // live bar close as the current mcap and scale it by avgBuy/currentPrice.
  const env = runBridge({ axiom: true, href: 'https://axiom.trade/meme/Pair1' });
  env.runTimers();
  env.axiomDatafeed.subscribeBars({}, '1', () => {}, 'sub', () => {});
  // Chart is in USD market cap; the average buy USD price is 2.1x the current.
  env.axiomRealtime()({ time: Date.now(), close: 100_000 });

  env.send('paper-lines', {
    enabled: true,
    axisBasis: 'mcap',
    currentPriceNative: 5e-9,
    currentPriceUsd: 0.00021,
    avgBuyUsd: 0.000441,        // 2.1x the current USD price
    avgBuyMcap: 999_999_999,    // stale/wrong resolver mcap, must be ignored
  });
  await microtasks();

  const line = env.orderLines.find((l) => l.values.setPrice !== undefined);
  assert.ok(line, 'the line must be created');
  assert.ok(Math.abs(line.values.setPrice - 210_000) < 0.01,
    'the mcap average line must equal lastBarClose * (avgBuyUsd / currentPriceUsd)');
});

test('F-32: the line level FREEZES per spec — a stale spec can never ride the candle', async () => {
  // Community video (lev, post-v2.2.0): entry $4.4K, line hugging the $6.2K
  // close. Root design flaw: the sweep recomputed close x (avg/current)
  // every second from a MOVING close, so ANY staleness anywhere upstream
  // turned into ratio ~= 1 riding. An average line is a constant level in
  // axis units — computed once per spec, frozen, re-asserted.
  const env = runBridge({ axiom: true, href: 'https://axiom.trade/meme/Pair1' });
  env.runTimers();
  env.axiomDatafeed.subscribeBars({}, '1', () => {}, 'sub', () => {});
  env.axiomRealtime()({ time: Date.now(), close: 100_000 });

  env.send('paper-lines', {
    enabled: true,
    axisBasis: 'mcap',
    currentPriceNative: 5e-9,
    currentPriceUsd: 0.00021,
    avgBuyUsd: 0.000441, // entry at 2.1x current => entry cap 210,000
  });
  await microtasks();
  const line = env.orderLines.find((l) => l.values.setPrice !== undefined);
  assert.ok(line, 'the line must be created');
  assert.ok(Math.abs(line.values.setPrice - 210_000) < 0.01);

  // The market runs +50% with NO fresh spec (whatever upstream link went
  // stale). The old recompute would drag the line to ~315,000.
  env.axiomRealtime()({ time: Date.now() + 1000, close: 150_000 });
  env.runTimers();
  await microtasks();
  env.runTimers();
  await microtasks();
  assert.ok(Math.abs(line.values.setPrice - 210_000) < 0.01,
    'without a fresh spec the level HOLDS — never close x stale-ratio');

  // A fresh spec (content re-posts within 2 s of any move) recomputes — and
  // with honest data the entry cap is invariant: 150k x (0.000441/0.000315)
  // is still 210,000. The truth does not move; only lies did.
  env.send('paper-lines', {
    enabled: true,
    axisBasis: 'mcap',
    currentPriceNative: 7.5e-9,
    currentPriceUsd: 0.000315,
    avgBuyUsd: 0.000441,
  });
  await microtasks();
  assert.ok(Math.abs(line.values.setPrice - 210_000) < 0.01,
    'a fresh spec recomputes to the same TRUE entry level');
});

test('ticks and lines ignore a preload chart showing a DIFFERENT token', async () => {
  // On a busy Axiom session the second widget preloads the previously viewed
  // token. Its closes must never become our ticks, and lines must never land
  // on it — that was the mechanism behind wrong P&L and misplaced avg lines.
  const now = Math.floor(Date.now() / 1000);
  const env = runBridge({
    axiom: true,
    wrongTokenPreload: true,
    href: 'https://axiom.trade/meme/Pair1',
    exportRows: [new Float64Array([now - 1, 1, 2, 0.5, 2_000_000])],
    preloadExportRows: [new Float64Array([now - 1, 1, 2, 0.5, 999_999_999])],
  });

  // The content script tells the bridge which address this page is about.
  env.send('paper-axis', { pairAddress: env.AXIOM_PAIR, mint: null });
  env.runTimers();
  await microtasks(8);

  const exportTicks = env.emitted.filter((m) => m.type === 'tick' && m.payload?.source === 'chart-export');
  assert.ok(exportTicks.length >= 1, 'the matching chart still exports');
  assert.ok(
    exportTicks.every((m) => m.payload.candidates[0].value === 2_000_000),
    'no tick may carry the wrong-token chart close'
  );

  // Bars from the wrong chart's subscription must not emit; ours must.
  env.preloadDatafeed.subscribeBars({ ticker: 'ZZZWRONGTOKEN999-USD-1' }, '1S', () => {}, 's1', () => {});
  env.preloadRealtime()({ time: now * 1000, close: 888_888_888 });
  assert.equal(
    env.emitted.filter((m) => m.type === 'tick' && m.payload?.source === 'padre-chart-bar').length,
    0,
    'wrong-token bars must not emit ticks'
  );
  env.axiomDatafeed.subscribeBars({ ticker: `${env.AXIOM_PAIR}-USD-1` }, '1S', () => {}, 's2', () => {});
  env.axiomRealtime()({ time: now * 1000, close: 2_000_000 });
  assert.ok(env.emitted.some((m) => m.type === 'tick' && m.payload?.source === 'padre-chart-bar'),
    'bars from the matching chart still emit');

  // Average lines land on the matching chart only.
  env.send('paper-lines', { enabled: true, avgBuyUsd: 1.9e6, avgBuyMcap: 1.9e6 });
  await microtasks();
  assert.equal(env.preloadLines.length, 0, 'the wrong-token chart must receive no lines');
  assert.ok(env.orderLines.length >= 1, 'the matching chart received the line');
});

test('average lines fall back to the token symbol when the pair is not in the chart symbol', async () => {
  // On Axiom Final Stretch the chart symbol may only contain the token symbol
  // (e.g. TOKEN/USD) and not the pair/mint address. The bridge must still
  // identify the real chart and draw the line at the right level.
  const now = Math.floor(Date.now() / 1000);
  const env = runBridge({
    axiom: true,
    href: 'https://axiom.trade/meme/Pair1',
    // Override the real chart symbol to a token-symbol-only form.
    axiomChartSymbol: 'BONK/USD-1',
    exportRows: [[now - 1, 1, 2, 0.5, 2_000_000]],
  });
  env.send('paper-axis', { pairAddress: 'DifferentPair123', mint: null, symbol: 'BONK' });
  env.runTimers();
  await microtasks(8);

  env.send('paper-lines', { enabled: true, avgBuyUsd: 0.00001, avgBuyMcap: 2_000_000 });
  await microtasks();

  const line = env.orderLines.find((l) => l.values.setPrice === 2_000_000);
  assert.ok(line, 'the average line must be drawn on the chart whose symbol matches the token ticker');
});

test('the price is pegged to the chart via exportData when live bars never flow', async () => {
  const now = Math.floor(Date.now() / 1000);
  const env = runBridge({
    axiom: true,
    href: 'https://axiom.trade/meme/Pair1',
    // TradingView returns each row as a Float64Array, not a plain Array.
    exportRows: [
      new Float64Array([now - 2, 1, 2, 0.5, 1.9]),
      new Float64Array([now - 1, 1.9, 2.2, 1.8, 2_150_000]),
    ],
  });
  env.runTimers(); // discovers widgets AND fires the export poll once
  await microtasks(8);

  const tick = env.emitted.find((m) => m.type === 'tick' && m.payload?.source === 'chart-export');
  assert.ok(tick, 'with no live bars the newest chart close must still become a tick');
  assert.equal(tick.payload.candidates[0].value, 2_150_000,
    'the tick must carry the last close from the exported series');
  assert.equal(tick.payload.mcap, 2_150_000,
    'the close is offered as mcap too so quote validation can identify chart mode');
});

test('the chart-export poll stands down while live bars are flowing', async () => {
  const now = Math.floor(Date.now() / 1000);
  const env = runBridge({
    axiom: true,
    href: 'https://axiom.trade/meme/Pair1',
    exportRows: [[now - 1, 1, 2, 0.5, 999]],
  });
  // Hook bars and deliver one — the live feed now owns the peg.
  env.runTimers();
  env.axiomDatafeed.subscribeBars({}, '1S', () => {}, 'sub', () => {});
  env.axiomRealtime()({ time: now * 1000, close: 2_000_000 });

  env.emitted.length = 0;
  env.runTimers(); // export poll fires again, must no-op
  await microtasks(8);

  const exportTick = env.emitted.find((m) => m.type === 'tick' && m.payload?.source === 'chart-export');
  assert.equal(exportTick, undefined, 'live bars must suppress the export poll');
});

/* ------------------------------------------------------------------ *
 * 3. GMGN token_activity realtime trades
 * ------------------------------------------------------------------ */

test('GMGN token_activity trades become mint-tagged USD ticks', async () => {
  const env = runBridge({ gmgnMounted: true });

  const frame = JSON.stringify({
    channel: 'token_activity',
    data: [
      {
        a: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
        pu: '0.000002888483390364',
        e: 'buy',
        ca: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
        m: 'MfDuWeqSHEqTFVYZ7LoexgAK9dxk7cy4DFJWjWMGVWa',
      },
    ],
  });

  // Drive the frame through the patched transport layer. The XHR intercept
  // shares forwardJson with the WebSocket wrapper, so this exercises the same
  // parsing the live socket feed hits.
  const XHR = env.win.XMLHttpRequest;
  const xhr = new XHR();
  const loadListeners = [];
  xhr.addEventListener = (type, fn) => { if (type === 'load') loadListeners.push(fn); };
  xhr.responseType = '';
  xhr.responseText = frame;
  xhr.responseURL = 'wss://ws.gmgn.ai/stream';
  xhr.send();
  for (const fn of loadListeners) fn.call(xhr);

  const tick = env.emitted.find((m) => m.type === 'tick' && m.payload?.source === 'gmgn-ws-trade');
  assert.ok(tick, 'a token_activity trade must be forwarded as a live tick');
  assert.equal(tick.payload.mint, 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    'the tick must carry the traded mint so quote validation can match it');
  assert.equal(tick.payload.candidates[0].unit, 'usd');
  assert.ok(Math.abs(tick.payload.candidates[0].value - 0.000002888483390364) < 1e-18);
});

/* ------------------------------------------------------------------ *
 * 3b. Reported from GMGN: "tech doesn't work when volume is high"
 * ------------------------------------------------------------------ */

/** Drive a token_activity frame through the patched transport layer. */
function injectActivityFrame(env, frame, url) {
  const XHR = env.win.XMLHttpRequest;
  const xhr = new XHR();
  const loadListeners = [];
  xhr.addEventListener = (type, fn) => { if (type === 'load') loadListeners.push(fn); };
  xhr.responseType = '';
  xhr.responseText = frame;
  xhr.responseURL = url || 'wss://ws.gmgn.ai/stream';
  xhr.send();
  for (const fn of loadListeners) fn.call(xhr);
}

test('GMGN high-volume frames past the size guard still feed the live price', () => {
  // Under high volume GMGN's token_activity batches grow past the 500KB
  // parse guard that protects the generic collector walk. The guard used to
  // drop those frames BEFORE the token_activity fast path could see them,
  // which killed the live feed exactly when volume peaked — the reported bug.
  const env = runBridge({ gmgnMounted: true });
  const WATCHED = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
  const data = [];
  for (let i = 0; i < 2400; i++) {
    data.push({
      a: WATCHED,
      pu: String(0.0000028 + i * 1e-11),
      e: i % 2 ? 'buy' : 'sell',
      ca: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
      m: 'MfDuWeqSHEqTFVYZ7LoexgAK9dxk7cy4DFJWjWMGVWa',
      h: '5' + String(i).padStart(63, '0'),
    });
  }
  const frame = JSON.stringify({ channel: 'token_activity', data });
  assert.ok(frame.length > 500_000, 'the test frame must outgrow the parse guard');

  env.emitted.length = 0;
  injectActivityFrame(env, frame);

  const tick = env.emitted.find((m) => m.type === 'tick' && m.payload?.source === 'gmgn-ws-trade');
  assert.ok(tick, 'an oversized token_activity frame must still produce a live tick');
  assert.equal(tick.payload.mint, WATCHED);
  assert.ok(Math.abs(tick.payload.candidates[0].value - (0.0000028 + 2399e-11)) < 1e-15,
    'the tick must carry the LATEST trade price in the batch');
});

test('the parse guard still bounds arbitrary huge frames', () => {
  // The guard was raised from 500 KB to 2 MB (F-06): the collector walk is
  // separately bounded by NODE_BUDGET, so the guard only bounds JSON.parse
  // cost. But it must still exist — a truly pathological frame is dropped.
  const env = runBridge({ gmgnMounted: true });
  const huge = JSON.stringify({ channel: 'something_else', data: new Array(240000).fill({ price: 1 }) });
  assert.ok(huge.length > 2_000_000, 'the test frame must outgrow the raised guard');
  env.emitted.length = 0;
  injectActivityFrame(env, huge);
  assert.equal(env.emitted.filter((m) => m.type === 'tick').length, 0,
    'frames beyond the parse guard must stay dropped');
});

test('a mid-size non-GMGN trade frame past the old 500 KB guard now feeds the price', () => {
  // DEFECT F-06: the v1.2.14 guard bypass covered ONLY GMGN token_activity.
  // Every other site's trade batches were still silently dropped at exactly
  // peak volume. With per-record collection and the raised guard, a 700 KB
  // Photon/BullX-style frame must still tick.
  const env = runBridge({});
  const WATCHED = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
  env.send('paper-axis', { mint: WATCHED });

  const trades = [];
  for (let i = 0; i < 6000; i++) {
    trades.push({ mint: WATCHED, price: String(0.001 + i * 1e-7), pad: 'x'.repeat(80) });
  }
  const frame = JSON.stringify({ trades });
  assert.ok(frame.length > 500_000 && frame.length < 2_000_000,
    'the test frame must sit between the old and new guard');

  env.emitted.length = 0;
  injectActivityFrame(env, frame);
  const tick = env.emitted.find((m) => m.type === 'tick' && m.payload?.mint === WATCHED);
  assert.ok(tick, 'a large non-GMGN trade frame must still produce a tick');
});

test('an oversized GMGN mcap-candle response still feeds the chart close', () => {
  // DEFECT F-06 (second half): the guard sat BEFORE the mcap-candle URL
  // handler, so GMGN's own chart feed kept the exact bug v1.2.14 fixed for
  // its trade feed — a hot token's full candle history was dropped whole.
  const env = runBridge({ gmgnMounted: true });
  const WATCHED = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
  env.send('paper-axis', { mint: WATCHED, symbol: 'BONK' });

  const list = [];
  for (let i = 0; i < 40000; i++) {
    list.push({ time: 1_800_000_000 + i, open: 240000 + i, high: 240010 + i, low: 239990 + i, close: 240000 + i });
  }
  const frame = JSON.stringify({ code: 0, data: { list } });
  assert.ok(frame.length > 2_000_000, 'the candle history must outgrow even the raised guard');

  env.emitted.length = 0;
  injectActivityFrame(env, frame, 'https://www.gmgn.ai/api/v1/token_mcap_candles/sol/' + WATCHED);
  const tick = env.emitted.find((m) => m.type === 'tick' && m.payload?.source === 'gmgn-mcap-candle');
  assert.ok(tick, 'the mcap-candle handler must see frames of any size');
  assert.equal(tick.payload.mcap, 240000 + 39999, 'the newest candle close is the tick');
});

/* ------------------------------------------------------------------ *
 * 5. Stress: 10x volume across rapid batches (DEFECT F-07 + harness)
 * ------------------------------------------------------------------ */

/** Base58-safe synthetic mint for filler trades. */
function fillerMint(batch, i) {
  const digits = (batch * 1000 + i).toString(8).split('')
    .map((d) => 'abcdefgh'[Number(d)]).join('');
  return ('M' + digits).padEnd(34, 'z');
}

test('rapid unrelated batches never starve the watched mint (per-mint throttle)', () => {
  // DEFECT F-07: the old throttle was GLOBAL and ran before the batch was
  // inspected. Under high volume, batches arrive < 100 ms apart — a filler
  // batch stamped the clock and the next batch (carrying the watched coin)
  // was discarded whole. The throttle is now per mint.
  const env = runBridge({ gmgnMounted: true });
  const WATCHED = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
  // One clock for everything: the axis message must be stamped on the same
  // (fake) clock the frames arrive on, or the bridge's liveness gate reads
  // the jump as five months of content-script silence and drops the frames.
  env.setNow(1_800_000_000_000);
  env.send('paper-axis', { mint: WATCHED, symbol: 'BONK' });

  let watchedTicks = 0;
  for (let batch = 0; batch < 40; batch++) {
    const filler = [];
    for (let i = 0; i < 300; i++) {
      filler.push({ a: fillerMint(batch, i), pu: '0.001', e: 'buy' });
    }
    injectActivityFrame(env, JSON.stringify({ channel: 'token_activity', data: filler }));
    env.advance(50); // the watched batch lands INSIDE the old global window
    env.emitted.length = 0;
    injectActivityFrame(env, JSON.stringify({
      channel: 'token_activity',
      data: [{ a: WATCHED, pu: String(0.000001 * (batch + 1)), e: 'buy' }],
    }));
    watchedTicks += env.emitted.filter((m) => m.type === 'tick' && m.payload?.mint === WATCHED).length;
    env.advance(100);
  }
  assert.equal(watchedTicks, 40,
    'the watched mint must tick on every round however many unrelated batches land first');
});

test('malformed frames between valid ones do not kill the feed', () => {
  const env = runBridge({ gmgnMounted: true });
  const WATCHED = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
  // Same-clock ordering as above: axis first ON the fake clock.
  env.setNow(1_800_000_000_000);
  env.send('paper-axis', { mint: WATCHED });

  injectActivityFrame(env, '{"channel":"token_activity","data":[{'); // truncated
  injectActivityFrame(env, 'null');
  injectActivityFrame(env, '[]');
  injectActivityFrame(env, 'not json at all');
  env.advance(150);

  env.emitted.length = 0;
  injectActivityFrame(env, JSON.stringify({
    channel: 'token_activity',
    data: [{ a: WATCHED, pu: '0.002', e: 'buy' }],
  }));
  assert.ok(env.emitted.some((m) => m.type === 'tick' && m.payload?.mint === WATCHED),
    'garbage frames must never poison the frames after them');
});

test('the watched mint is never crowded out of a high-volume batch', () => {
  // A hot batch carries trades for many mints; the emit cap plus Map
  // iteration order gave no guarantee the token on screen made the cut. The
  // watched mint must always be emitted first.
  const env = runBridge({ gmgnMounted: true });
  const WATCHED = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
  env.send('paper-axis', { mint: WATCHED, symbol: 'BONK' });

  const data = [];
  const filler = 'abcdefghj'; // valid base58 letters, distinct from the watched mint
  for (let i = 0; i < 9; i++) {
    // Filler mints inserted BEFORE the watched one in batch order.
    data.push({ a: ('Mint' + filler[i]).padEnd(34, '1'), pu: String(0.001 + i * 0.0001), e: 'buy' });
  }
  data.push({ a: WATCHED, pu: '0.000002888483390364', e: 'buy' }); // inserted LAST

  env.emitted.length = 0;
  injectActivityFrame(env, JSON.stringify({ channel: 'token_activity', data }));

  const ticks = env.emitted.filter((m) => m.type === 'tick' && m.payload?.source === 'gmgn-ws-trade');
  assert.ok(ticks.length >= 1, 'the batch must emit ticks');
  assert.equal(ticks[0].payload.mint, WATCHED,
    'the token the user is watching must be the FIRST tick, whatever the batch order');
  assert.equal(ticks[0].payload.symbol, 'BONK', 'the watched tick carries the symbol');
});

/* ------------------------------------------------------------------ *
 * 4. Generic collector: per-token attribution (DEFECTS F-02 / F-03)
 *
 * The old collector flattened a whole frame into one bag: the first base58
 * seen became the tick's mint and up to 32 prices from ANYWHERE in the tree
 * became its candidates. A screener list or multi-pair snapshot therefore
 * attributed token B's price to token A — and the accept band derived USD and
 * market cap from that wrong ratio self-consistently, so it looked plausible
 * on screen. It also read arrays front-first while trade feeds are
 * newest-LAST, so the reported price got OLDER as volume grew.
 * ------------------------------------------------------------------ */

test('a multi-token frame attributes each price to its own token', () => {
  const env = runBridge({});
  const WATCHED = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
  const OTHER = 'MfDuWeqSHEqTFVYZ7LoexgAK9dxk7cy4DFJWjWMGVWa';
  env.send('paper-axis', { mint: WATCHED, symbol: 'BONK' });

  env.emitted.length = 0;
  injectActivityFrame(env, JSON.stringify({
    pairs: [
      { mint: OTHER, priceUsd: '99.5' },
      { mint: WATCHED, priceUsd: '0.0000021' },
    ],
  }));

  const ticks = env.emitted.filter((m) => m.type === 'tick');
  assert.ok(ticks.length >= 1, 'the frame must emit ticks');
  assert.equal(ticks[0].payload.mint, WATCHED, 'the watched token is emitted first');
  assert.ok(ticks[0].payload.candidates.length > 0);
  assert.ok(ticks[0].payload.candidates.every((c) => Math.abs(c.value - 0.0000021) < 1e-12),
    "the watched tick must carry ONLY the watched token's own price");
  for (const t of ticks) {
    if (t.payload.mint === OTHER) {
      assert.ok(t.payload.candidates.every((c) => Math.abs(c.value - 99.5) < 1e-9),
        "the other token's tick must carry only its own price");
    }
  }
});

test('the generic collector reads the newest trades in a batch, not the oldest', () => {
  const env = runBridge({});
  const WATCHED = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
  env.send('paper-axis', { mint: WATCHED });

  const trades = [];
  for (let i = 0; i < 500; i++) {
    trades.push({ mint: WATCHED, price: String(0.001 + i * 0.000001) });
  }
  env.emitted.length = 0;
  injectActivityFrame(env, JSON.stringify({ trades }));

  const tick = env.emitted.find((m) => m.type === 'tick' && m.payload?.mint === WATCHED);
  assert.ok(tick, 'the batch must tick for the watched mint');
  const newest = 0.001 + 499 * 0.000001;
  assert.ok(tick.payload.candidates.some((c) => Math.abs(c.value - newest) < 1e-12),
    'the newest trade in the batch must be among the candidates (arrays are newest-last)');
});

test('a frame with no token identifier still emits an unattributed tick for anchor banding', () => {
  const env = runBridge({});
  env.emitted.length = 0;
  injectActivityFrame(env, JSON.stringify({ ohlcv: { close: '0.00042' } }));

  const tick = env.emitted.find((m) => m.type === 'tick');
  assert.ok(tick, 'identifier-less frames must still tick — downstream banding validates them');
  assert.equal(tick.payload.mint, null);
});

/* ------------------------------------------------------------------ *
 * 6. Lifecycle stand-down protocol (DEFECTS O-03/C-18, O-04/C-17)
 *
 * The MAIN-world bridge cannot observe extension death. Two mechanisms
 * cover it: an explicit 'standdown' message (overlay disabled, extension
 * teardown) that erases every native drawing at once, and a liveness
 * watchdog — after 5 minutes without ANY content-script message the 1 s
 * sweep stops re-asserting lines. The content script keeps a 30 s
 * 'bridge-ping' heartbeat while enabled, so an alive-but-quiet overlay
 * never trips the watchdog.
 * ------------------------------------------------------------------ */

test('O-03/C-18: standdown erases native lines, marks and GMGN artifacts at once', async () => {
  const env = runBridge({ gmgnMounted: true, axiom: true, href: 'https://axiom.trade/meme/Pair1' });
  env.runTimers();
  const ts = Date.now();

  env.send('paper-lines', { enabled: true, axisBasis: 'usd', avgBuyUsd: 0.0021 });
  env.send('gmgn-lines', { enabled: true, avgBuyMcap: 250_000_000, avgSellMcap: 300_000_000 });
  env.send('gmgn-marker', { ts, mcap: 250_000_000, side: 'buy', text: 'PT Buy $250M' });
  env.send('paper-marker', {
    ts, side: 'buy', priceNative: 0.00001, priceUsd: 0.0021, mcap: 2_100_000, solAmount: 0.5, symbol: 'AX',
  });
  await microtasks();
  assert.ok(env.orderLines.some((l) => !l.removed), 'lines exist before the standdown');
  assert.ok(env.execShapes.some((s) => !s.removed), 'shapes exist before the standdown');

  const linesBefore = env.orderLines.length;
  env.send('standdown', null);
  await microtasks();

  assert.ok(env.orderLines.every((l) => l.removed), 'every native average line must be removed');
  assert.ok(env.execShapes.every((s) => s.removed), 'every native execution shape must be removed');
  let marks = null;
  env.axiomDatafeed.getMarks({}, 0, Math.floor(ts / 1000) + 600, (r) => { marks = r; });
  assert.ok(marks.every((m) => !String(m.id).startsWith('papertrench-')),
    'no paper mark may be served after a standdown');

  // The sweep is silenced immediately — it must not recreate anything.
  env.runTimers();
  env.runTimers();
  await microtasks();
  assert.equal(env.orderLines.length, linesBefore, 'a stood-down bridge must not draw new lines');
});

test('O-04/C-17: 5 minutes of content silence stops the line re-assert sweep; any message revives it', async () => {
  const env = runBridge({ axiom: true, href: 'https://axiom.trade/meme/Pair1' });
  env.runTimers(); // boot prober patches the widget and retires itself

  // axisBasis stated: C-05 refuses to draw with no close and no known basis.
  env.send('paper-lines', { enabled: true, axisBasis: 'usd', avgBuyUsd: 0.0021 });
  await microtasks();
  const line = env.orderLines.find((l) => l.values.setPrice === 0.0021);
  assert.ok(line, 'the line must exist before silence');

  env.runTimers(); // an alive bridge re-asserts the line every sweep
  const aliveCalls = line.calls.length;
  assert.ok(aliveCalls > 0, 'the sweep must have touched the line while alive');

  env.advance(6 * 60_000); // no content-script message for 6 minutes
  env.runTimers();
  env.runTimers();
  assert.equal(line.calls.length, aliveCalls,
    'a silent content script means a dead extension — the sweep must stop repainting');

  env.send('bridge-ping', null); // the 30 s heartbeat (or any message) lands
  env.runTimers();
  assert.ok(line.calls.length > aliveCalls,
    'one content-script message must revive the sweep');
});

/* ------------------------------------------------------------------ *
 * 7. DEFECT F-26: widget sweep stands down on chartless pages
 * ------------------------------------------------------------------ */

test('F-26: after a minute of empty scans the widget sweep drops to a slow cadence', () => {
  const env = runBridge({}); // page with no TradingView widget at all
  const original = env.axiomDatafeed.subscribeBars;

  // Exhaust the 10 ms boot prober (self-clears after 500 empty checks) and
  // push the 1 s sweep far past its miss limit. Time is NOT advanced, so the
  // content-silence watchdog stays out of the picture.
  for (let i = 0; i < 500; i++) env.runTimers();

  // A widget appears while the sweep is standing down: off-cadence ticks
  // must NOT scan for it, the every-10th tick must find it. (The fiber-scan
  // cache holds results for 3 s; step past it so the next real scan is
  // fresh — well inside the 5-minute liveness window.)
  env.enableAxiom();
  env.advance(3200);
  let patchedAt = null;
  for (let i = 1; i <= 10 && patchedAt === null; i++) {
    env.runTimers();
    if (env.axiomDatafeed.subscribeBars !== original) patchedAt = i;
  }
  assert.ok(patchedAt !== null, 'the slow cadence must still discover the chart within 10 ticks');
  assert.ok(patchedAt > 1, 'during stand-down the sweep must not scan on every tick');

  // The export poll is gated on the same miss counter (source contract —
  // there is nothing to export on a page that has no widget).
  const bridgeSrc = fs.readFileSync(path.join(ROOT, 'price-bridge.js'), 'utf8');
  const pollAt = bridgeSrc.indexOf('function pollChartClose()');
  const gateAt = bridgeSrc.indexOf('widgetSweepMisses >= WIDGET_SWEEP_MISS_LIMIT) return;', pollAt);
  assert.ok(pollAt !== -1 && gateAt !== -1 && gateAt - pollAt < 600,
    'pollChartClose must stand down with the widget sweep');
});

test('F-26: a paper-axis message returns the stood-down sweep to the fast cadence', () => {
  const env = runBridge({});
  const original = env.axiomDatafeed.subscribeBars;
  for (let i = 0; i < 500; i++) env.runTimers(); // stand the sweep down

  env.send('paper-axis', { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' });
  env.enableAxiom();
  env.advance(3200); // step past the fiber-scan cache
  env.runTimers(); // FIRST tick after the message must scan again
  assert.notEqual(env.axiomDatafeed.subscribeBars, original,
    'a token announcement must restore the fast sweep immediately');
});

/* ------------------------------------------------------------------ *
 * 8. DEFECT O-22: chips occluded by the PaperTrench overlay stand down
 *
 * The chip layer deliberately sits BELOW the panel/bar in z-order (a chip
 * must never cover the trade panel), so a chip under the panel would be
 * invisible yet unclickable — a dead control. The placement logic probes
 * the chip's own anchor point with elementFromPoint; everything the
 * overlay draws retargets to the #papertrench-host shadow host, so one id
 * check covers panel, bar, pill and toasts.
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * 9. Chart-truth batch: lines/markers land where they belong
 * ------------------------------------------------------------------ */

test('C-05: no average line before a bar close reveals the axis unit; it appears when evidence arrives', async () => {
  const env = runBridge({ axiom: true, href: 'https://axiom.trade/meme/Pair1' });
  env.runTimers();

  // No close, no axisBasis: the unit is unknowable. The old first-usable
  // fallback painted the USD price (~0.002) on an axis in millions here.
  env.send('paper-lines', { enabled: true, avgBuyUsd: 0.002, avgBuyMcap: 2_000_000 });
  await microtasks();
  assert.equal(env.orderLines.length, 0,
    'honest absence: with no evidence of the axis unit, nothing may be drawn');

  env.axiomDatafeed.subscribeBars({}, '1S', () => {}, 'sub', () => {});
  env.axiomRealtime()({ time: Date.now(), close: 2_100_000 }); // mcap-scale close
  env.runTimers(); // the 1 s sweep re-syncs the stored spec
  await microtasks();

  const line = env.orderLines.find((l) => l.values.setPrice !== undefined);
  assert.ok(line, 'the line must appear once the close reveals the unit');
  assert.equal(line.values.setPrice, 2_000_000,
    'and sit at the mcap candidate, not nine orders away at the USD price');
});

test('C-07: a native-only average draws on a USD axis via the current rate — or refuses without one', async () => {
  const env = runBridge({ axiom: true, href: 'https://axiom.trade/meme/Pair1' });
  env.runTimers();

  // Fills that predate the SOL/USD rate: avgBuyUsd is null, the native
  // average is known. The old basis branch hard-returned null here.
  env.send('paper-lines', { enabled: true, axisBasis: 'usd', avgBuyNative: 8e-8 });
  await microtasks();
  assert.equal(env.orderLines.length, 0,
    'no rate means no conversion — no line rather than a wrong-unit one');

  env.send('paper-lines', {
    enabled: true, axisBasis: 'usd', avgBuyNative: 8e-8,
    currentPriceNative: 5e-8, currentPriceUsd: 1e-5,
  });
  await microtasks();
  let line = env.orderLines.find((l) => !l.removed && l.values.setPrice !== undefined);
  assert.ok(line, 'the known-good native average must fall through (C-07)');
  assert.ok(Math.abs(line.values.setPrice - 1.6e-5) < 1e-18,
    'converted via the spec rate: 8e-8 x (1e-5 / 5e-8)');

  // Mirror image: native axis with only the USD average known.
  env.send('paper-lines-clear', null);
  env.send('paper-lines', {
    enabled: true, axisBasis: 'native', avgBuyUsd: 1e-5,
    currentPriceNative: 5e-8, currentPriceUsd: 1e-5,
  });
  await microtasks();
  line = env.orderLines.find((l) => !l.removed && l.values.setPrice !== undefined);
  assert.ok(line, 'the USD average must convert onto a native axis');
  assert.ok(Math.abs(line.values.setPrice - 5e-8) < 1e-20,
    'converted via the spec rate: 1e-5 x (5e-8 / 1e-5)');
});

test('C-08: GMGN lines and markers are corrected by the live candle close, not resolver supply', async () => {
  const env = runBridge({ gmgnMounted: true });
  // GMGN's own chart feed: the candle close IS the value on its Y axis.
  // Here GMGN counts 3x the supply the resolver implies (migrated coin).
  injectActivityFrame(env, JSON.stringify({ code: 0, data: { list: [{ close: 300_000_000 }] } }),
    'https://www.gmgn.ai/api/v1/token_mcap_candles/sol/Mint1');

  env.send('gmgn-lines', {
    enabled: true,
    avgBuyMcap: 50_000_000,   // resolver-implied entry cap
    currentMcap: 100_000_000, // resolver-implied current cap
  });
  env.send('gmgn-marker', { ts: Date.now(), mcap: 50_000_000, side: 'buy', text: 'PT Buy' });
  await microtasks();

  const line = env.orderLines.find((l) => l.values.setPrice !== undefined);
  assert.ok(line, 'the average line must draw');
  assert.equal(line.values.setPrice, 150_000_000,
    'line level = close x (avg / current): the candle close is ground truth for GMGN’s cap definition');
  const shape = env.execShapes.find((s) => s.values.setDirection === 'buy');
  assert.ok(shape, 'the fill marker must draw');
  assert.equal(shape.values.setPrice, 150_000_000,
    'fill markers get the exact same close correction');
});

test('C-16: a capless fill is queued and drawn once the cap becomes derivable', async () => {
  const env = runBridge({ gmgnMounted: true });
  const ts = Date.now();

  // A fill made before the SOL/USD rate warmed: no priceUsd, so no honest
  // mcap (C-09) — only its SOL price. The old code refused it outright and
  // the fill stayed unmarked for the whole session.
  env.send('gmgn-marker', { ts, mcap: null, priceNative: 5e-8, side: 'buy', text: 'PT Buy' });
  env.runTimeouts();
  await microtasks();
  assert.equal(env.execShapes.length, 0, 'nothing is drawn while the level is unknowable');

  // Evidence arrives: GMGN's own candle close plus a current SOL price.
  injectActivityFrame(env, JSON.stringify({ code: 0, data: { list: [{ close: 250_000_000 }] } }),
    'https://www.gmgn.ai/api/v1/token_mcap_candles/sol/Mint1');
  env.send('gmgn-lines', { enabled: true, currentPriceNative: 1e-7 });
  env.runTimeouts();
  await microtasks();

  const shape = env.execShapes.find((s) => s.values.setDirection === 'buy');
  assert.ok(shape, 'the queued fill must be replayed once the cap resolves');
  assert.equal(shape.values.setPrice, 125_000_000,
    'level = close x (fillNative / currentNative): the fill expressed on GMGN’s own axis');
});

test('C-13: failed GMGN shape draws are re-queued with bounded retries, never lost', async () => {
  const env = runBridge({ gmgnMounted: true });
  env.failGmgnShapes(2); // a mid-boot chart refuses the first two draws
  env.send('gmgn-marker', { ts: Date.now(), mcap: 100_000_000, side: 'buy', text: 'PT Buy' });
  await microtasks();
  assert.equal(env.execShapes.length, 0, 'the first draw failed');

  env.runTimeouts(); // retry 1 — fails again
  await microtasks();
  env.runTimeouts(); // retry 2 — the chart accepts now
  await microtasks();

  const shape = env.execShapes.find((s) => s.values.setDirection === 'buy');
  assert.ok(shape,
    'the failed payload must be retried until it draws (the old drain spliced the queue and discarded it)');
  assert.equal(shape.values.setPrice, 100_000_000);
});

test('C-12: a GMGN chart remount re-queues and redraws the fill shapes', async () => {
  const env = runBridge({ gmgnMounted: true });
  env.send('gmgn-marker', { ts: Date.now(), mcap: 100_000_000, side: 'buy', text: 'PT Buy' });
  await microtasks();
  assert.equal(env.execShapes.length, 1, 'the fill is drawn on the first chart');

  env.remountGmgn(); // timeframe change: fresh chart instance, shapes died with the old one
  env.runTimers();   // the 1 s sweep detects the chart identity change
  await microtasks();

  assert.equal(env.execShapes.length, 2, 'the fill must be redrawn on the new chart');
  assert.equal(env.execShapes[0].removed, true, 'the dead chart’s adapter is released');
  assert.equal(env.execShapes[1].removed, false);
  assert.equal(env.execShapes[1].values.setPrice, 100_000_000);
});

test('C-14: bare-letter resolutions parse and marks snap to the daily grid', () => {
  const env = runBridge({ axiom: true, href: 'https://axiom.trade/meme/Pair1' });
  env.runTimers();
  // TradingView sends a bare 'D' for daily charts; resolutionToMs used to
  // return null for it, silently keeping the previous grid.
  env.axiomDatafeed.subscribeBars({}, 'D', () => {}, 'sub', () => {});
  const ts = Date.now();
  env.send('paper-marker', {
    ts, side: 'buy', priceNative: 0.00001, priceUsd: 0.0021, mcap: 2_100_000, solAmount: 0.5, symbol: 'AX',
  });

  let marks = null;
  env.axiomDatafeed.getMarks({}, 0, Math.floor(ts / 1000) + 86_400, (r) => { marks = r; });
  const mark = marks.find((m) => String(m.id).startsWith('papertrench-buy-'));
  assert.ok(mark);
  assert.equal(mark.time, Math.floor(ts / 86_400_000) * 86_400,
    'a daily chart must snap marks to the day grid');
});

test('C-14: existing marks re-snap when the chart resolution changes', () => {
  const env = runBridge({ axiom: true, href: 'https://axiom.trade/meme/Pair1' });
  env.runTimers();
  env.axiomDatafeed.subscribeBars({}, '1S', () => {}, 's1', () => {});
  const ts = Date.now();
  env.send('paper-marker', {
    ts, side: 'buy', priceNative: 0.00001, priceUsd: 0.0021, mcap: 2_100_000, solAmount: 0.5, symbol: 'AX',
  });

  let marks = null;
  env.axiomDatafeed.getMarks({}, 0, Math.floor(ts / 1000) + 60, (r) => { marks = r; });
  let mark = marks.find((m) => String(m.id).startsWith('papertrench-buy-'));
  assert.equal(mark.time, Math.floor(ts / 1000), 'first snapped to the 1 s grid');

  // The user flips to 1-minute candles: TradingView re-subscribes. Marks
  // snapped to the old grid would be silently DROPPED by the library —
  // they must re-snap from their original fill timestamps.
  env.axiomDatafeed.subscribeBars({}, '1', () => {}, 's2', () => {});
  env.runTimeouts(); // deferred clear+refresh after the re-snap
  env.axiomDatafeed.getMarks({}, 0, Math.floor(ts / 1000) + 60, (r) => { marks = r; });
  mark = marks.find((m) => String(m.id).startsWith('papertrench-buy-'));
  assert.equal(mark.time, Math.floor(ts / 60_000) * 60,
    'the same mark must land on the 1-minute grid after the switch');
});

test('C-14: a preload chart cannot overwrite the visible chart’s snapping grid', () => {
  const env = runBridge({ axiom: true, wrongTokenPreload: true, href: 'https://axiom.trade/meme/Pair1' });
  env.send('paper-axis', { pairAddress: env.AXIOM_PAIR, mint: null });
  env.runTimers();

  // The visible chart runs 1-second candles; Axiom's hidden preload widget
  // subscribes for ANOTHER token at 60-minute candles.
  env.axiomDatafeed.subscribeBars({ ticker: `${env.AXIOM_PAIR}-USD-1` }, '1S', () => {}, 's1', () => {});
  env.preloadDatafeed.subscribeBars({ ticker: 'ZZZWRONGTOKEN999-USD-1' }, '60', () => {}, 's2', () => {});

  const ts = Date.now();
  env.send('paper-marker', {
    ts, side: 'buy', priceNative: 0.00001, priceUsd: 0.0021, mcap: 2_100_000, solAmount: 0.5, symbol: 'AX',
  });
  let marks = null;
  env.axiomDatafeed.getMarks({}, 0, Math.floor(ts / 1000) + 60, (r) => { marks = r; });
  const mark = marks.find((m) => String(m.id).startsWith('papertrench-buy-'));
  assert.equal(mark.time, Math.floor(ts / 1000),
    'the mark must snap to the VISIBLE chart’s 1 s grid, not the preload’s hour grid');
});

test('C-15: a sell-line failure never tears the working buy line onto the preload chart', async () => {
  const env = runBridge({ axiom: true, href: 'https://axiom.trade/meme/Pair1' });
  env.runTimers();
  // The real chart accepts the FIRST order line (the buy) then refuses —
  // the mid-boot state where the sell line fails while the buy is live.
  env.setAxiomOrderLinePlan((i) => i >= 1);

  env.send('paper-lines', { enabled: true, axisBasis: 'usd', avgBuyUsd: 0.0021, avgSellUsd: 0.003 });
  await microtasks(); // the buy adapter resolves and binds to the real chart

  env.runTimers();    // the 1 s sweep re-syncs; the sell still fails here
  await microtasks();

  const live = env.orderLines.filter((l) => !l.removed && l.values.setPrice !== undefined);
  assert.equal(live.length, 1, 'exactly the working buy line remains');
  assert.equal(live[0].values.setPrice, 0.0021,
    'the buy line must stay put — the old fall-through tore it off and rebuilt it on the seriesless preload');
  assert.equal(env.preloadLines.length, 0, 'nothing may land on the preload chart');

  // The chart finishes booting: the sell line completes on the SAME chart.
  env.setAxiomOrderLinePlan(null);
  env.runTimers();
  await microtasks();
  const prices = env.orderLines.filter((l) => !l.removed).map((l) => l.values.setPrice).sort();
  assert.deepEqual(prices, [0.0021, 0.003], 'both lines live on the working chart after recovery');
});

test('C-19: the bridge advertises native capability wherever a widget exists', () => {
  // Photon is NOT in the hardcoded native set — discovery is site-agnostic,
  // and the capability flag is what routes such sites down the native path.
  const env = runBridge({ axiom: true, href: 'https://photon-sol.tinyastro.io/en/lp/Pair1' });
  env.runTimers();
  const status = env.emitted.filter((m) => m.type === 'padre-hook-status').pop();
  assert.ok(status, 'widget discovery must emit a hook status');
  assert.equal(status.payload.nativeCapable, true,
    'a discovered widget must be advertised regardless of the site');
});

test('C-19: with no widget, the paper-axis ack reports nativeCapable false', () => {
  const env = runBridge({});
  env.runTimers();
  env.emitted.length = 0;
  env.send('paper-axis', { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' });
  const status = env.emitted.filter((m) => m.type === 'padre-hook-status').pop();
  assert.ok(status, 'paper-axis must be answered with a capability snapshot');
  assert.equal(status.payload.nativeCapable, false,
    'no widget: the content script falls back to the SVG rail after its grace period');
});

test('O-22: a chip whose spot the overlay covers is hidden, and returns when it moves away', () => {
  const env = runBridge({ rowDom: true, href: 'https://axiom.trade/pulse' });
  const spec = {
    amount: 0.1, size: 1,
    linkSelectors: ['a.testrow'],
    placement: 'float',
    buyButtonPattern: null,
    containerMode: 'heuristic',
  };

  env.send('row-scan', spec);
  let chips = env.rowDebug();
  assert.equal(chips.length, 1, 'the screener row must get its chip');
  assert.notEqual(chips[0].display, 'none', 'an unobstructed chip is visible');

  // The panel now covers the chip's anchor: the periodic sweep must stand
  // the chip down rather than leave a dead control under the panel.
  env.setPanelOverChip(true);
  env.runTimers();
  chips = env.rowDebug();
  assert.equal(chips.length, 1, 'the chip entry survives while occluded');
  assert.equal(chips[0].display, 'none', 'an occluded chip must be hidden');

  // The user drags the panel away: the next sweep restores the chip.
  env.setPanelOverChip(false);
  env.runTimers();
  chips = env.rowDebug();
  assert.notEqual(chips[0].display, 'none', 'the chip must return when the overlay moves');
});

test("F-18: the chip observer never watches character data (feed-thread starvation)", () => {
  const bridge = fs.readFileSync(path.join(ROOT, "price-bridge.js"), "utf8");
  const at = bridge.indexOf("rowChipObserver.observe(");
  const line = bridge.slice(at, bridge.indexOf(");", at));
  assert.doesNotMatch(line, /characterData/,
    "every price-digit update used to schedule a forced-layout chip walk on the thread the feed parses on");
  assert.match(line, /childList: true, subtree: true/,
    "row shifts (node changes) must still reposition chips immediately");
});

/* ------------------------------------------------------------------ *
 * F-30 (community report, post-v2.0): holding a REAL position on the
 * same token polluted the paper feed — the site streams the user own
 * entry average (avgPrice / positions subtrees) and the collector took
 * it as a live market tick, so the paper average line landed at a level
 * "blended" between the real buy and the paper buy.
 * ------------------------------------------------------------------ */

test("F-30: a real position avgPrice never becomes a market tick", () => {
  const env = runBridge({});
  const WATCHED = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
  env.send("paper-axis", { mint: WATCHED, symbol: "BONK" });
  env.emitted.length = 0;
  // The shape a terminal streams while the user holds a real position:
  // the live trade price and the user entry average, side by side.
  injectActivityFrame(env, JSON.stringify({
    data: { mint: WATCHED, lastPrice: "0.00003400", avgPrice: "0.00001700" },
  }));
  const ticks = env.emitted.filter((m) => m.type === "tick" && m.payload?.mint === WATCHED);
  assert.ok(ticks.length >= 1, "the live price must still tick");
  for (const t of ticks) {
    assert.ok(t.payload.candidates.every((c) => Math.abs(c.value - 0.000034) < 1e-12),
      "the user real entry average must never appear among price candidates");
  }
});

test("F-30: prices inside a positions subtree are the user, not the market", () => {
  const env = runBridge({});
  const WATCHED = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
  env.send("paper-axis", { mint: WATCHED, symbol: "BONK" });
  env.emitted.length = 0;
  injectActivityFrame(env, JSON.stringify({
    positions: [{ mint: WATCHED, price: "0.00001700", marketCap: "9999" }],
    trade: { mint: WATCHED, price: "0.00003400" },
  }));
  const ticks = env.emitted.filter((m) => m.type === "tick" && m.payload?.mint === WATCHED);
  assert.ok(ticks.length >= 1, "the sibling trade price must still tick");
  for (const t of ticks) {
    assert.ok(t.payload.candidates.every((c) => Math.abs(c.value - 0.000034) < 1e-12),
      "a positions-subtree price must never be a candidate");
    assert.notEqual(t.payload.mcap, 9999, "a positions-subtree cap must never be the market cap");
  }
});

test("F-30: the paper average lines never impersonate the real-position lines", () => {
  const bridge = fs.readFileSync(path.join(ROOT, "price-bridge.js"), "utf8");
  assert.doesNotMatch(bridge, /choose = .*Avg\. Fill Price|setText\(.Avg\. Fill Price.\)|\x27Avg\. Fill Price\x27/,
    "Padre labels the user REAL line exactly Avg. Fill Price — ours must differ");
  assert.match(bridge, /PAPER Avg\. Fill/);
  assert.match(bridge, /PAPER Avg\. Exit/);
});

/* ------------------------------------------------------------------ *
 * F-29: bridge code runs inside HOST chart callbacks — a PaperTrench
 * throw there must never break the site's own chart. The preamble work
 * (noteResolution / barSymbolMatches / emitPadreBar / marksInRange) is
 * contained so the host callback ALWAYS runs.
 * ------------------------------------------------------------------ */

test('F-29: a throwing bridge preamble never breaks the host bar callback', () => {
  const env = runBridge({ axiom: true, href: 'https://axiom.trade/meme/Pair1' });
  env.runTimers();
  let delivered = null;
  env.axiomDatafeed.subscribeBars({}, '1S', (bar) => { delivered = bar; }, 'sub', () => {});

  // A bar whose close getter throws poisons emitPadreBar mid-preamble —
  // the shape of any future bug in our half of the wrapper.
  const poisoned = { time: Date.now(), get close() { throw new Error('paper-trench boom'); } };
  env.axiomRealtime()(poisoned);

  assert.equal(delivered, poisoned,
    'the HOST site must receive its own realtime bar even when our preamble throws');
});

test('F-29: a throwing preamble in getMarks still hands the site its marks', () => {
  const env = runBridge({ axiom: true, href: 'https://axiom.trade/meme/Pair1' });
  env.runTimers();

  let marks = null;
  // The resolution argument reaches noteResolution -> String(res), so a
  // poisoned toString throws inside our preamble, before the host callback.
  const poison = { toString() { throw new Error('paper-trench boom'); } };
  env.axiomDatafeed.getMarks({}, 0, Math.floor(Date.now() / 1000) + 60, (r) => { marks = r; }, poison);

  assert.ok(Array.isArray(marks),
    'the HOST data callback must run whatever our preamble does');
});

test('F-29: source contract — host-callback preambles are contained', () => {
  const bridge = fs.readFileSync(path.join(ROOT, 'price-bridge.js'), 'utf8');
  const sub = bridge.slice(bridge.indexOf('function subscribeBars('), bridge.indexOf('function patchPadreMarks'));
  assert.match(sub, /try\s*\{[^}]*noteResolution\(resolution\);\s*\n?\s*\} catch/,
    'the subscribe-time resolution note must be contained');
  assert.match(sub, /try\s*\{[^}]*emitPadreBar\(bar, resolution, subscriberUID\);\s*\n?\s*\} catch/,
    'the per-bar preamble must be contained so onRealtimeCallback always runs');
  const marksFn = bridge.slice(bridge.indexOf('function getMarks('), bridge.indexOf('function frameVisible'));
  assert.match(marksFn, /try \{ ours = marksInRange\(from, to\); \} catch/,
    'the merged callback must never lose the site marks to our merge');
});

/* ------------------------------------------------------------------ *
 * C-26: GMGN execution-shape marker times snap to the bar grid, like
 * the Padre/Axiom mark path. The grid is noted from GMGN's own candle
 * request URL (?resolution=...).
 * ------------------------------------------------------------------ */

test('C-26: GMGN fill markers snap a mid-bar timestamp to the bar boundary', async () => {
  const env = runBridge({ gmgnMounted: true });
  // GMGN's chart feed names its bar grid in the candle request itself.
  injectActivityFrame(env, JSON.stringify({ code: 0, data: { list: [{ close: 250_000_000 }] } }),
    'https://www.gmgn.ai/api/v1/token_mcap_candles/sol/Mint1?resolution=1m&limit=500');

  const ts = 1_700_000_000_000 + 37_000; // 37 s into a minute bar
  env.send('gmgn-marker', { ts, mcap: 250_000_000, side: 'buy', text: 'PT Buy' });
  await microtasks();

  const shape = env.execShapes.find((s) => s.values.setDirection === 'buy');
  assert.ok(shape, 'the fill must draw');
  assert.equal(shape.values.setTime, Math.floor(ts / 60_000) * 60,
    'a mid-bar fill must land on the minute-bar boundary');
  assert.notEqual(shape.values.setTime, Math.floor(ts / 1000),
    'the raw floor-to-second time sat off the bar grid');
});

test('C-26: a timeframe change re-snaps requeued GMGN fills onto the new grid', async () => {
  const env = runBridge({ gmgnMounted: true });
  injectActivityFrame(env, JSON.stringify({ code: 0, data: { list: [{ close: 250_000_000 }] } }),
    'https://www.gmgn.ai/api/v1/token_mcap_candles/sol/Mint1?resolution=1m');
  const ts = 1_700_000_000_000 + 37_000;
  env.send('gmgn-marker', { ts, mcap: 250_000_000, side: 'buy', text: 'PT Buy' });
  await microtasks();
  assert.equal(env.execShapes[0].values.setTime, Math.floor(ts / 60_000) * 60);

  // The user flips to 1-second candles: GMGN refetches candles AND remounts
  // its chart (C-12); the requeued fill must re-snap onto the new grid.
  injectActivityFrame(env, JSON.stringify({ code: 0, data: { list: [{ close: 251_000_000 }] } }),
    'https://www.gmgn.ai/api/v1/token_mcap_candles/sol/Mint1?resolution=1s');
  env.remountGmgn();
  env.runTimers();
  await microtasks();

  const redrawn = env.execShapes[env.execShapes.length - 1];
  assert.equal(redrawn.removed, false);
  assert.equal(redrawn.values.setTime, Math.floor(ts / 1000),
    'after the switch the same fill must land on the 1 s grid');
});

/* ------------------------------------------------------------------ *
 * F-31 (community screenshot, Padre mcap chart): fill bubbles floated
 * above the candles and right of the last bar while the avg line sat
 * exactly right — shapes used the RAW resolver-implied fill mcap while
 * lines used the live-close correction, and no time clamp existed.
 * ------------------------------------------------------------------ */

test("F-31: fill shapes use the same close-corrected level math as the avg lines", () => {
  const bridge = fs.readFileSync(path.join(ROOT, "price-bridge.js"), "utf8");
  const fnStart = bridge.indexOf("function shapeLevelFor(");
  assert.ok(fnStart !== -1, "a shared shape-level function must exist");
  const block = bridge.slice(fnStart, bridge.indexOf("\n  }", fnStart) + 4);
  assert.match(block, /close \* \(levels\.native \/ currentNative\)/,
    "the universal formula: close x price ratio — supply cancels, the chart own cap definition wins");
  assert.match(block, /vettedMcapClose\(spec\)/,
    "F-35: on a declared mcap axis the ratio close must be unit-vetted, never whichever series ticked last");
  const drawStart = bridge.indexOf("function drawShapeFallback(");
  const drawBlock = bridge.slice(drawStart, bridge.indexOf("\n  }", drawStart) + 4);
  assert.match(drawBlock, /shapeLevelFor\(levels\)/,
    "the fallback must route through the shared level function");
  assert.doesNotMatch(drawBlock, /const level = pickAxisLevel\(/,
    "the raw uncorrected pick must be gone from the draw path");
});

test("F-31: paper shapes and marks can never render ahead of the newest bar", () => {
  const bridge = fs.readFileSync(path.join(ROOT, "price-bridge.js"), "utf8");
  // The clamp target must be the FRESHNESS-GATED bar time: an always-on
  // clamp drags fills minutes into the past when live bars are stale (the
  // fomo missing-sell), and no clamp at all re-opens the F-31 float.
  assert.match(bridge, /Math\.min\(mark\.time, capSec\)/,
    "shape time must clamp to the freshness-gated last bar");
  assert.match(bridge, /function freshBarTimeSec/,
    "the clamp target must exist as the gated helper");
  assert.match(bridge, /lastLiveBarAt <= BAR_CLOSE_FRESH_MS/,
    "a stale live-bar time may not clamp — the export peg owns stale pages");
  const marksStart = bridge.indexOf("function marksInRange(");
  const marksBlock = bridge.slice(marksStart, bridge.indexOf("\n  }", marksStart) + 4);
  assert.match(marksBlock, /clamp/, "marks must clamp before the range filter");
  assert.match(marksBlock, /freshBarTimeSec\(\)/,
    "the getMarks clamp must use the same gated target");
  assert.match(bridge, /lastBarTimeSec = barTimeMs > 1e12/,
    "emitPadreBar must record the newest bar chart time");
  assert.match(bridge, /lastBarTimeSec = 0;/,
    "the bar time must reset on token change");
});

/* ------------------------------------------------------------------ *
 * Turbo: the feed-demand gate — no consumer, no parse
 *
 * Ticks feed exactly two things: the page's resolved token and the
 * screener row chips. The bridge must stop parsing the site's frames
 * the instant neither exists ('standdown', page-state wantsTicks:false)
 * and resume the instant demand is proven again (paper-axis, row-scan).
 * The fetch tap must gate BEFORE the body copy — clone().text() is the
 * cost, not just JSON.parse.
 * ------------------------------------------------------------------ */

test('Turbo: standdown stops frame parsing instantly; a revived axis restores it', () => {
  const env = runBridge({ gmgnMounted: true });
  const WATCHED = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
  env.setNow(1_800_000_000_000);
  env.send('paper-axis', { mint: WATCHED });

  env.emitted.length = 0;
  injectActivityFrame(env, JSON.stringify({
    channel: 'token_activity', data: [{ a: WATCHED, pu: '0.001', e: 'buy' }],
  }));
  assert.ok(env.emitted.some((m) => m.type === 'tick' && m.payload?.mint === WATCHED),
    'with a resolved token, frames must tick');

  env.advance(150);
  env.send('standdown');
  env.emitted.length = 0;
  injectActivityFrame(env, JSON.stringify({
    channel: 'token_activity', data: [{ a: WATCHED, pu: '0.002', e: 'buy' }],
  }));
  assert.equal(env.emitted.filter((m) => m.type === 'tick').length, 0,
    'after standdown ("PaperTrench off") the page must not pay for a single parse');

  env.advance(150);
  env.send('paper-axis', { mint: WATCHED });
  env.emitted.length = 0;
  injectActivityFrame(env, JSON.stringify({
    channel: 'token_activity', data: [{ a: WATCHED, pu: '0.003', e: 'buy' }],
  }));
  assert.ok(env.emitted.some((m) => m.type === 'tick' && m.payload?.mint === WATCHED),
    'a revived content script restores the feed with its first axis message');
});

test('Turbo: page-state wantsTicks:false gates frames; a row scan proves demand again', () => {
  // rowDom: the row-scan message drives the real chip machinery, which needs
  // the harness's chip-capable document (createElement, elementFromPoint).
  const env = runBridge({ gmgnMounted: true, rowDom: true });
  const WATCHED = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
  env.setNow(1_800_000_000_000);

  env.send('page-state', { wantsTicks: false });
  env.emitted.length = 0;
  injectActivityFrame(env, JSON.stringify({
    channel: 'token_activity', data: [{ a: WATCHED, pu: '0.001', e: 'buy' }],
  }));
  assert.equal(env.emitted.filter((m) => m.type === 'tick').length, 0,
    'a page with no tick consumer must not parse frames');

  // A chip scan is proof of a consumer regardless of message ordering.
  env.advance(150);
  env.send('row-scan', {
    amount: 0.1, size: 1, linkSelectors: [], placement: 'badge', containerMode: 'heuristic',
  });
  env.emitted.length = 0;
  injectActivityFrame(env, JSON.stringify({
    channel: 'token_activity', data: [{ a: WATCHED, pu: '0.002', e: 'buy' }],
  }));
  assert.ok(env.emitted.some((m) => m.type === 'tick'),
    'an active chip page must get its mint-tagged ticks back');
});

test('Turbo: the fetch tap never copies a body while the feed is gated', async () => {
  let cloned = 0;
  const env = runBridge({
    fetchResponse: (url) => ({
      url,
      headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'application/json' : null) },
      clone: () => { cloned += 1; return { text: () => Promise.resolve('{}') }; },
    }),
  });
  env.setNow(1_800_000_000_000);
  env.send('standdown');

  await env.win.fetch('https://gmgn.ai/api/v1/anything');
  await microtasks();
  assert.equal(cloned, 0, 'a gated feed must skip clone().text() entirely — the copy IS the cost');

  env.advance(150);
  env.send('paper-axis', { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' });
  await env.win.fetch('https://gmgn.ai/api/v1/anything');
  await microtasks();
  assert.equal(cloned, 1, 'restored demand must restore the tap');
});

test('Turbo: oversized fetch bodies are dropped before the copy; mcap candles stay exempt', async () => {
  const clonedUrls = [];
  const env = runBridge({
    fetchResponse: (url) => ({
      url,
      headers: {
        get: (h) => {
          const name = String(h).toLowerCase();
          if (name === 'content-type') return 'application/json';
          if (name === 'content-length') return String(3_000_000);
          return null;
        },
      },
      clone: () => {
        clonedUrls.push(url);
        return { text: () => Promise.resolve('{"code":0,"data":{"list":[{"close":1}]}}') };
      },
    }),
  });

  await env.win.fetch('https://gmgn.ai/api/v1/rank_list_giant');
  await env.win.fetch('https://gmgn.ai/api/v1/token_mcap_candles/sol/Mint1?resolution=1m');
  await microtasks();

  assert.deepEqual(clonedUrls, ['https://gmgn.ai/api/v1/token_mcap_candles/sol/Mint1?resolution=1m'],
    'a body the parse guard would drop must not be copied — except the audited candles route');
});

test('Turbo source contract: the content script publishes page-state demand', () => {
  const content = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  const setTokenBody = content.slice(
    content.indexOf('function setToken('),
    content.indexOf('let lastWantsTicks'),
  );
  assert.match(setTokenBody, /publishPageState\(\);/,
    'every token change must republish feed demand');
  assert.match(content, /sendPadreMarker\('page-state', \{ wantsTicks: wants \}\)/,
    'the demand signal must reach the bridge as page-state');
  assert.match(content, /lastWantsTicks = null;/,
    'teardown must reset the publisher so a re-enable re-announces');
  assert.match(content, /settings\.listQuickBuyEnabled !== false\s*\n?\s*&& site\.rowBuy\.listPaths\.test\(location\.pathname\)/,
    'chip pages count as demand only while chips are enabled and on a list path');
});

/* ------------------------------------------------------------------ *
 * Turbo: chip layout is read-phase/write-phase with diffed writes
 * ------------------------------------------------------------------ */

test('Turbo: a steady-state chip sweep performs zero style writes', () => {
  const env = runBridge({ rowDom: true, href: 'https://axiom.trade/pulse' });
  env.send('row-scan', {
    amount: 0.1, size: 1,
    linkSelectors: ['a.testrow'],
    placement: 'float',
    buyButtonPattern: null,
    containerMode: 'heuristic',
  });
  const chips = env.rowDebug();
  assert.equal(chips.length, 1, 'the screener row must get its chip');
  assert.ok(env.styleWrites() > 0, 'first placement must of course write styles');

  // Nothing moved: the 1s sweep must not touch a single style property.
  env.resetStyleWrites();
  env.runTimers();
  assert.equal(env.styleWrites(), 0,
    'an unmoved chip must cost zero style writes — writes are what dirty layout for the next read');
});

test('Turbo source contract: the chip sweep separates reads from writes', () => {
  const bridge = fs.readFileSync(path.join(ROOT, 'price-bridge.js'), 'utf8');
  const measure = bridge.slice(
    bridge.indexOf('function positionRowChip('),
    bridge.indexOf('function applyRowChip('),
  );
  assert.doesNotMatch(measure, /\.style\./,
    'the measure phase must never write styles — that is the reflow interleave (F-18 class)');
  const sweep = bridge.slice(
    bridge.indexOf('function sweepRowChips('),
    bridge.indexOf('let rowChipRaf'),
  );
  assert.match(sweep, /Phase R/, 'the sweep must document its read phase');
  assert.match(sweep, /applyRowChip/, 'writes must route through the diffed applier');
});

/* ------------------------------------------------------------------ *
 * F-37: marks snap to the grid of the series that TICKS
 * ------------------------------------------------------------------ */

test('F-37: a same-token subscription at another resolution cannot teleport new marks', async () => {
  // Maintainer repro: first buy lands on the right bar, the second buy
  // "teleports to a random spot". Padre multi-preset panels subscribe the
  // SAME token at other resolutions; the snap grid followed whichever
  // subscription came LAST, so a hidden 1m series moved every new mark to
  // minute boundaries — up to 59 s away on a 1 s chart.
  const env = runBridge({ axiom: true, href: 'https://axiom.trade/meme/Pair1' });
  env.runTimers();

  env.axiomDatafeed.subscribeBars({}, '1S', () => {}, 'visible-1s', () => {});
  const oneSecSeries = env.axiomRealtime();
  // The hidden preset panel subscribes LAST, at 1 minute.
  env.axiomDatafeed.subscribeBars({}, '1', () => {}, 'hidden-1m', () => {});
  // But the VISIBLE chart is the one that streams.
  const base = 1_800_000_000_000; // a minute boundary
  oneSecSeries({ time: base + 32_000, close: 100_000 });

  // The fill lands ON the newest bar (the F-31 clamp is not in play):
  // 32 s past the minute, where the 1 s and 1 m grids disagree by 32 s.
  const ts = base + 32_000;
  env.send('paper-marker', {
    ts, side: 'buy', priceNative: 0.00001, priceUsd: 0.0021, mcap: 2_100_000, solAmount: 0.5, symbol: 'AX',
  });
  await microtasks();

  let marks = null;
  env.axiomDatafeed.getMarks({}, Math.floor(base / 1000) - 120, Math.floor(base / 1000) + 120, (r) => { marks = r; });
  await microtasks();
  const mark = marks.find((m) => String(m.id).startsWith('papertrench-buy-'));
  assert.ok(mark, 'the fill must be served as a native mark');
  assert.equal(mark.time, Math.floor(ts / 1000),
    'the mark snaps to the TICKING 1 s grid — never the idle 1 m series that subscribed last');
});

/* ------------------------------------------------------------------ *
 * F-35: per-series unit vetting for average-line level math
 * ------------------------------------------------------------------ */

test('F-35: a price-mode series ticking last cannot poison the mcap line level', async () => {
  // Padre multichart: the SAME token streams in mcap mode on one chart and
  // price mode on another. Both pass the C-14 token gate, so whichever
  // series ticked last owned the single global close — and the frozen level
  // multiplied avg/current into a PRICE-unit close, landing the line ~1e9
  // off, locked there by the F-32 freeze until the next spec.
  const env = runBridge({ axiom: true, href: 'https://axiom.trade/meme/Pair1' });
  env.runTimers();

  env.axiomDatafeed.subscribeBars({}, '1', () => {}, 'subMcap', () => {});
  const mcapSeries = env.axiomRealtime();
  env.axiomDatafeed.subscribeBars({}, '1', () => {}, 'subPrice', () => {});
  const priceSeries = env.axiomRealtime();

  mcapSeries({ time: Date.now(), close: 100_000 });      // mcap-unit close
  priceSeries({ time: Date.now(), close: 0.00021 });     // price-unit close, ticks LAST

  env.send('paper-lines', {
    enabled: true,
    axisBasis: 'mcap',
    currentPriceNative: 5e-9,
    currentPriceUsd: 0.00021,
    avgBuyUsd: 0.000441, // entry at 2.1x current => entry cap 210,000
  });
  await microtasks();

  const line = env.orderLines.find((l) => l.values.setPrice !== undefined);
  assert.ok(line, 'the line must be created');
  assert.ok(Math.abs(line.values.setPrice - 210_000) < 0.01,
    'the mcap level must come from the mcap-unit series even when the price-unit series ticked last');
});

test('F-35: with only price-unit closes on an mcap axis, draw NO line rather than a wrong one', async () => {
  // Mode toggle: the user flips the chart from price to mcap. Until the
  // first mcap-unit bar lands, the only closes available are price-unit —
  // scaling one by avg/current produces a price-magnitude level on an mcap
  // axis. The honest output is no line at all (C-07 doctrine).
  const env = runBridge({ axiom: true, href: 'https://axiom.trade/meme/Pair1' });
  env.runTimers();

  env.axiomDatafeed.subscribeBars({}, '1', () => {}, 'subPrice', () => {});
  env.axiomRealtime()({ time: Date.now(), close: 0.00021 }); // price-unit only

  env.send('paper-lines', {
    enabled: true,
    axisBasis: 'mcap',
    currentPriceNative: 5e-9,
    currentPriceUsd: 0.00021,
    avgBuyUsd: 0.000441,
  });
  await microtasks();

  assert.equal(env.orderLines.filter((l) => l.values.setPrice !== undefined).length, 0,
    'no line may be drawn from a price-unit close on an mcap axis');

  // The first mcap-unit bar plus the next spec re-post produce the true level.
  env.axiomRealtime()({ time: Date.now(), close: 100_000 });
  env.send('paper-lines', {
    enabled: true,
    axisBasis: 'mcap',
    currentPriceNative: 5e-9,
    currentPriceUsd: 0.00021,
    avgBuyUsd: 0.000441,
  });
  await microtasks();
  const line = env.orderLines.find((l) => l.values.setPrice !== undefined);
  assert.ok(line, 'the line must appear once an mcap-unit close exists');
  assert.ok(Math.abs(line.values.setPrice - 210_000) < 0.01);
});

test('F-35: a spec arriving while the line is still being created wins over the stale captured level', async () => {
  // createOrderLine is async on Axiom/GMGN. The creation closure captured
  // the level at issue time; a DCA that moved the average while the promise
  // was in flight configured the line at the OLD average until some later
  // sweep happened to re-assert it.
  const env = runBridge({ axiom: true, href: 'https://axiom.trade/meme/Pair1' });
  env.runTimers();

  env.axiomDatafeed.subscribeBars({}, '1', () => {}, 'subMcap', () => {});
  env.axiomRealtime()({ time: Date.now(), close: 100_000 });

  env.send('paper-lines', {
    enabled: true,
    axisBasis: 'mcap',
    currentPriceNative: 5e-9,
    currentPriceUsd: 0.00021,
    avgBuyUsd: 0.000441, // level 210,000
  });
  // No microtask flush yet: the DCA spec lands while creation is pending.
  env.send('paper-lines', {
    enabled: true,
    axisBasis: 'mcap',
    currentPriceNative: 5e-9,
    currentPriceUsd: 0.00021,
    avgBuyUsd: 0.00063, // level 300,000
  });
  await microtasks();

  const line = env.orderLines.find((l) => l.values.setPrice !== undefined);
  assert.ok(line, 'the line must be created');
  assert.ok(Math.abs(line.values.setPrice - 300_000) < 0.01,
    'the resolved line must carry the newest level, not the one captured at issue time');
});

/* ------------------------------------------------------------------
 * GMGN lines: the two protections the paper path has and this one didn't.
 *
 * D-64 (v3.18.0) made the LEVEL computable on fresh launches via the C-16
 * native-ratio lane, and re-armed the sweep on either level source. Both of
 * those are upstream and are not re-litigated here. Two gaps survive it:
 *
 *  1. syncGmgnAverageLines still called syncLineSlot with FIVE arguments.
 *     The sixth is `wanted`, which separates "there is no line" (clear it)
 *     from "a line is wanted, its level is momentarily uncomputable" (keep
 *     it, retry) — F-41's split. undefined is falsy, so every uncomputable
 *     tick destroyed a correct line and reported success. D-64 made levels
 *     computable more often, not always: gmgnLastCandleClose resets to 0 on
 *     every token switch and BOTH level lanes need it.
 *
 *  2. D-63 taught the paper path that an off-range line feeds the host
 *     autoscale and wrecks the axis. GMGN draws through the same
 *     createOrderLine on the same TradingView chart and never got that fix.
 * ------------------------------------------------------------------ */

test('GMGN: a wanted line survives a tick whose level is uncomputable', async () => {
  const env = runBridge({ gmgnMounted: true });
  env.runTimers();

  // Supply known: the line draws.
  env.send('gmgn-lines', {
    enabled: true, avgBuyMcap: 250_000_000, avgBuyNative: 0.0000031,
    currentMcap: 240_000_000, currentPriceNative: 0.0000030,
    avgBuyText: 'PT Avg Buy $250M',
  });
  await microtasks();
  assert.ok(env.orderLines.some((l) => !l.removed),
    'precondition: the line draws while a level can be computed');

  // Same position, next tick: no mcap (fresh-launch shape) and no current
  // native to build the ratio from, so neither lane yields a level — but
  // avgBuyNative still says a line IS wanted.
  env.send('gmgn-lines', {
    enabled: true, avgBuyMcap: null, avgBuyNative: 0.0000031,
    currentPriceNative: null, avgBuyText: 'PT Avg Buy $250M',
  });
  await microtasks();

  assert.ok(env.orderLines.some((l) => !l.removed),
    'a wanted line must not be destroyed because one tick could not compute its level');
});

test('GMGN gets D-63 parity: an off-range line is cleared, not drawn into autoscale', () => {
  const src = fs.readFileSync(path.join(ROOT, 'price-bridge.js'), 'utf8');
  const start = src.indexOf('function syncGmgnAverageLines()');
  assert.ok(start >= 0, 'the GMGN line sync must ship');
  const block = src.slice(start, start + 4000);

  assert.match(block, /offVisibleRange\(chart,\s*\[buyLevel\]\)/,
    'the GMGN buy level must be vetted against the visible range, as D-63 does for paper');
  assert.match(block, /offVisibleRange\(chart,\s*\[sellLevel\]\)/,
    'and the sell level separately — one bad side must not veto the good one');
  assert.match(block, /buyOffRange[\s\S]{0,400}clearLineSlot/,
    'an off-range verdict must CLEAR the slot so it stops feeding autoscale');
  assert.match(block, /lastGmgnLineReason\s*=\s*'off-range/,
    'off-range must name itself, per the status-honesty law');
  assert.match(block, /buyOffRange \? false\s*\n?\s*:\s*syncLineSlot/,
    'an off-range side must not be passed to syncLineSlot at all — it would recreate the line');
});

test('GMGN: the line sync passes `wanted`, and shares one want-rule with the sweep', () => {
  const src = fs.readFileSync(path.join(ROOT, 'price-bridge.js'), 'utf8');
  assert.match(src, /syncLineSlot\(gmgnBuySlot,[^)]*wantsBuy\)/,
    'the buy line must pass the wanted flag through');
  assert.match(src, /syncLineSlot\(gmgnSellSlot,[^)]*wantsSell\)/,
    'the sell line must pass the wanted flag through');
  // The sweep re-arms the sync; if they disagreed about "wanted", the sweep
  // would re-arm forever a sync that then declines to draw.
  const wants = src.match(/gmgnWants\('Buy'\)/g) || [];
  assert.ok(wants.length >= 2,
    'sweep and sync must share one want-rule rather than each carrying its own copy');
});
