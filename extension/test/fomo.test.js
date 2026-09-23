/* Fomo (fomo.family) native chart integration + feed honesty.
 *
 * Every shape in this fake was captured from the LIVE, logged-in site on
 * 2026-08-05 — none of it is guessed:
 *
 *  - The TradingView widget is reachable ONLY through React fiber refs near
 *    the standard `tradingview_*` iframe (no window global), like Axiom.
 *  - The datafeed exposes onReady/searchSymbols/resolveSymbol/getBars/
 *    subscribeBars/unsubscribeBars and NO getMarks — the native marks
 *    pipeline has nothing to patch, so fills MUST render as execution
 *    shapes or they render nowhere.
 *  - F-39 (probed 2026-08-05): the PRODUCTION build is the STANDALONE
 *    charting library — createOrderLine/createExecutionShape exist and
 *    THROW "only available on Trading Platform". The liveShape fixture
 *    throws exactly like the field; lines draw as horizontal_line line
 *    tools and fills as PaperTrench DOM bubbles. The legacy fiber fixture
 *    keeps broker primitives: it locks the generic no-getMarks broker
 *    path (the shape other sites may still serve).
 *  - The chart symbol is the Codex composite "MINT:1399811149" (uppercased
 *    by the library), and bars are MARKET-CAP denominated: a 1.3M-cap token
 *    streams closes around 1.4e6, ~1/sec.
 *  - /feed/token responses are a SOCIAL TRADE FEED: items[] of historical,
 *    user-attributed trades (type swap_buy/swap_sell, tradeId, userId,
 *    createdAt) each carrying price/marketCap/fdv keys that are minutes to
 *    HOURS stale. Prices inside them are facts about past trades, not the
 *    market — the F-30 class, one layer out.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function microtasks(n = 6) {
  let p = Promise.resolve();
  for (let i = 0; i < n; i++) p = p.then(() => {});
  return p;
}

const FOMO_MINT = 'Gymbmn9wwMKe4NnmVceyyfpncp9arbwPfSdBsyY9pump';
const FOMO_NETWORK = '1399811149'; // Codex's Solana network id
// Live capture: title "1.3M MC", bar closes ~1.41-1.47e6, price ~$0.0014.
const LIVE_BAR_CLOSE = 1417171.26;
const CURRENT_MCAP = 1400000;
const CURRENT_PRICE_USD = 0.0014;
const CURRENT_PRICE_NATIVE = 0.0000070; // at ~$200/SOL

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
 * Boot the shipped price-bridge.js against a fomo-shaped page. The fake
 * REFUSES what the real site refuses: no window widget global, no getMarks
 * on the datafeed, and the chart symbol only ever the Codex composite.
 */
function runFomoBridge(opts = {}) {
  const timers = [];
  const emitted = [];
  const listeners = {};
  const orderLines = [];
  const execShapes = [];

  let subscribed = null; // { symbolInfo, resolution, callback, uid }
  const fomoDatafeed = {
    onReady() {}, searchSymbols() {}, resolveSymbol() {}, getBars() {},
    subscribeBars(symbolInfo, resolution, callback, uid) {
      subscribed = { symbolInfo, resolution, callback, uid };
    },
    unsubscribeBars() {},
    // NO getMarks — live-verified absence (dfKeys capture 2026-08-05).
  };

  /* F-39, live-probed 2026-08-05: fomo ships the STANDALONE charting
   * library. The broker primitives EXIST on the chart API and THROW
   * "... is only available on Trading Platform" when called — the old
   * fixture implemented them, which is exactly how the suite stayed green
   * while the real site drew nothing. Line tools are the only native
   * drawing surface: createShape resolves an entity id, getShapeById gives
   * setPoints/setProperties, removeEntity removes. The pane/scale
   * internals mirror what the site's own overlay reads (decompiled from
   * the token chunk): _chartWidget.paneWidgets()[0]._div and
   * model().timeScale()/mainSeries().priceScale()/firstValue(). */
  const lineShapes = []; // { id, point, opts, points, props, removed }
  let shapeSeq = 0;
  const RealDateRef = Date;
  const paneT0Sec = Math.floor(RealDateRef.now() / 1000) - 2000;
  const fakePaneDiv = {
    getBoundingClientRect: () => ({ left: 8, top: 4, width: 800, height: 420 }),
  };
  const liveShapeSurface = {
    createOrderLine: () => { throw new Error('createOrderLine is only available on Trading Platform'); },
    createExecutionShape: () => { throw new Error('createExecutionShape is only available on Trading Platform'); },
    createShape(point, shapeOpts) {
      const id = `shape-${++shapeSeq}`;
      const rec = {
        id,
        point,
        opts: shapeOpts,
        points: [{ price: point && point.price }],
        props: Object.assign(
          {},
          shapeOpts && shapeOpts.overrides,
          shapeOpts && shapeOpts.text != null ? { text: shapeOpts.text } : null
        ),
        removed: false,
      };
      rec.api = {
        setPoints(pts) { rec.points = pts; },
        setProperties(props) { Object.assign(rec.props, props); },
      };
      lineShapes.push(rec);
      return Promise.resolve(id); // live-verified: resolves the entity id
    },
    getShapeById(id) {
      const rec = lineShapes.find((s) => s.id === id && !s.removed);
      if (!rec) throw new Error('unknown entity');
      return rec.api;
    },
    removeEntity(id) {
      const rec = lineShapes.find((s) => s.id === id);
      if (rec) rec.removed = true;
    },
    getAllShapes: () => lineShapes.filter((s) => !s.removed).map((s) => ({ id: s.id, name: 'horizontal_line' })),
    _chartWidget: {
      paneWidgets: () => [{ _div: fakePaneDiv }],
      model: () => ({
        timeScale: () => ({ timeToCoordinate: (sec) => (sec - paneT0Sec) / 10 }),
        mainSeries: () => ({
          priceScale: () => ({ priceToCoordinate: (v) => 420 - v / 50000 }),
          // Zooms and scale rebuilds null this out for a frame or two on
          // the real chart — tests drive that via env.setFirstValue.
          firstValue: () => fixtureFirstValue,
        }),
      }),
    },
  };
  let fixtureFirstValue = 1.4e6;
  // Models entering a token page: the chart iframe mounts AFTER the token
  // resolves (and after restored journal fills were already posted).
  let chartVisible = opts.chartVisible !== false;
  const brokerSurface = {
    createOrderLine: () => Promise.resolve(makeAsyncAdapter(orderLines)),
    createExecutionShape: () => Promise.resolve(makeAsyncAdapter(execShapes)),
  };
  const fomoChart = Object.assign({
    symbol: () => `${FOMO_MINT.toUpperCase()}:${FOMO_NETWORK}`,
    exportData: () => Promise.resolve({
      schema: ['time', 'open', 'high', 'low', 'close'],
      data: [],
    }),
  }, opts.liveShape ? liveShapeSurface : brokerSurface);
  const fomoWidget = {
    _options: { datafeed: fomoDatafeed },
    activeChart: () => fomoChart,
    onChartReady: () => {},
  };
  const fiberParent = {};
  // opts.liveShape models what the REAL site showed on 2026-08-05 (probed in
  // a live browser): NO fiber anywhere, the widget api only reachable as
  // contentWindow.tradingViewApi, and the options bag (with the datafeed)
  // parked in window[frameId]. The fiber shape below is kept for the legacy
  // tests but is NOT what production serves.
  if (!opts.liveShape) {
    Object.defineProperty(fiberParent, '__reactFiber$fomo', {
      value: {
        return: null,
        child: null,
        sibling: null,
        memoizedState: { memoizedState: { current: fomoWidget }, next: null },
      },
      enumerable: true,
    });
  }
  const fomoIframe = {
    id: 'tradingview_90d6a',
    parentElement: fiberParent,
    contentWindow: opts.liveShape ? { tradingViewApi: { activeChart: () => fomoChart } } : null,
    getClientRects: () => [{}],
    clientWidth: 800,
    getBoundingClientRect: () => ({ left: 100, top: 50, width: 800, height: 430 }),
  };

  // Minimal element fakes for the F-39 DOM bubble layer: enough tree to
  // append, position, and remove chips, nothing more.
  function makeFakeEl(tag) {
    return {
      tag,
      style: {},
      attrs: {},
      children: [],
      parentNode: null,
      textContent: '',
      title: '',
      setAttribute(k, v) { this.attrs[k] = v; },
      appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
      remove() {
        const p = this.parentNode;
        if (!p) return;
        const i = p.children.indexOf(this);
        if (i >= 0) p.children.splice(i, 1);
        this.parentNode = null;
      },
    };
  }

  const doc = {
    getElementById: () => null,
    querySelector: (sel) => (chartVisible && String(sel).includes('iframe[id^="tradingview_"]') ? fomoIframe : null),
    querySelectorAll: (sel) => (chartVisible && String(sel).includes('iframe[id^="tradingview_"]') ? [fomoIframe] : []),
    createElement: (tag) => makeFakeEl(tag),
    body: makeFakeEl('body'),
  };

  function FakeWebSocket() {}
  FakeWebSocket.prototype.addEventListener = () => {};
  FakeWebSocket.CONNECTING = 0; FakeWebSocket.OPEN = 1;
  FakeWebSocket.CLOSING = 2; FakeWebSocket.CLOSED = 3;
  function FakeXHR() {}
  FakeXHR.prototype.send = function () {};
  FakeXHR.prototype.addEventListener = function () {};

  const win = {
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
  if (opts.liveShape) win[fomoIframe.id] = { datafeed: fomoDatafeed };

  const timeouts = new Map();
  let timeoutSeq = 0;
  // Controllable clock (nativecharts pattern): the stale-clamp tests need
  // minutes to pass between a live bar and a fill, deterministically.
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
    location: {
      href: `https://fomo.family/tokens/solana/${FOMO_MINT}`,
      hostname: 'fomo.family',
    },
    console, Date: TestDate, Math, Number, String, Array, Object, Boolean, RegExp,
    Error, Set, WeakSet, WeakMap, Map, Symbol, JSON, Promise, isFinite,
    MutationObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
    setInterval(fn) { timers.push(fn); return timers.length; },
    clearInterval(id) { if (timers[id - 1]) timers[id - 1] = () => {}; },
    setTimeout(fn) { timeouts.set(++timeoutSeq, fn); return timeoutSeq; },
    clearTimeout(id) { timeouts.delete(id); },
  };
  vm.runInContext(
    fs.readFileSync(path.join(ROOT, 'price-bridge.js'), 'utf8'),
    vm.createContext(sandbox),
    { filename: 'price-bridge.js' }
  );

  return {
    emitted,
    orderLines,
    execShapes,
    lineShapes,
    doc,
    paneT0Sec,
    win,
    fomoDatafeed,
    setNow(t) { fakeNow = t; },
    advance(ms) { fakeNow = (fakeNow === null ? RealDate.now() : fakeNow) + ms; },
    setFirstValue(v) { fixtureFirstValue = v; },
    setChartVisible(v) { chartVisible = Boolean(v); },
    subscribed: () => subscribed,
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
    statuses(type) { return emitted.filter((m) => m.source === 'papertrench-bridge' && m.type === type).map((m) => m.payload); },
  };
}

function announceToken(env) {
  env.send('paper-axis', { mint: FOMO_MINT, symbol: 'Doom', pairAddress: null });
}

/** Run the sweep until discovery, then drive one live mcap bar through the
 *  patched datafeed exactly as fomo's own chart does. */
function bootWithLiveBar(env, close = LIVE_BAR_CLOSE) {
  announceToken(env);
  env.runTimers(); // widget sweep: fiber discovery + datafeed patch
  const sub = {
    symbolInfo: { ticker: `${FOMO_MINT.toUpperCase()}:${FOMO_NETWORK}` },
    resolution: '1',
    uid: `${FOMO_MINT}_#_USD_-_1`,
  };
  env.fomoDatafeed.subscribeBars(sub.symbolInfo, sub.resolution, () => {}, sub.uid);
  const live = env.subscribed();
  live.callback({ time: Date.now(), close, volume: 9556.58 });
  return live;
}

/* ------------------------------------------------------------------ *
 * 1. Discovery and hook status
 * ------------------------------------------------------------------ */

test('F-38: the LIVE fomo shape — options bag + contentWindow api, NO fiber — hooks bars and draws lines', async () => {
  // Maintainer: "FOMO still doesn't show the buys on the chart nor the
  // line." Reverse-engineered on the real site (2026-08-05): production
  // serves NO fiber; the widget api is contentWindow.tradingViewApi and the
  // datafeed rides the options bag in window[frameId]. The old fiber-shaped
  // fixture passed while production showed nothing — this test IS the live
  // shape, and the composite discovery must hook bars and draw from it.
  const env = runFomoBridge({ liveShape: true });
  env.runTimers(); // sweep: discovery finds the pseudo widget + patches the bag's datafeed

  // The site (re)subscribes after the patch — the next subscription in prod.
  env.fomoDatafeed.subscribeBars({ ticker: 'LIVE' }, '1S', () => {}, 'live-sub');
  const sub = env.subscribed();
  assert.ok(sub, 'the subscription flows through the patched datafeed');
  sub.callback({ time: 1_800_000_032_000, close: 8_200_000 }); // mcap-unit close
  assert.ok(env.emitted.some((m) => m.type === 'tick' && m.payload && m.payload.source === 'padre-chart-bar'),
    'a live fomo bar becomes a bridge tick without any fiber in sight');

  env.send('paper-lines', {
    enabled: true,
    axisBasis: 'mcap',
    currentPriceNative: 5e-9,
    currentPriceUsd: 0.0082,
    avgBuyUsd: 0.0164, // entry at 2x current => line at 2x the close
  });
  await microtasks();
  // F-39: the standalone build THROWS on createOrderLine (the fixture now
  // throws exactly like the field) — the same average line must draw as a
  // locked horizontal_line LINE TOOL instead.
  assert.equal(env.orderLines.length, 0, 'no order line can exist on the standalone build');
  const line = env.lineShapes.find((s) => !s.removed && s.props.text === 'PAPER Avg. Fill');
  assert.ok(line, 'the mcap average line draws as a horizontal_line line tool');
  assert.ok(Math.abs(line.points[0].price - 16_400_000) < 1,
    `levelled from the vetted ledger close x price ratio, got ${line.points[0].price}`);
  assert.equal(line.opts.shape, 'horizontal_line');
  assert.equal(line.opts.lock, true, 'the user must not be able to drag a PAPER line');
  assert.equal(line.opts.disableSave, true, 'PAPER lines must never enter the site-saved layout');
  assert.equal(line.props.linecolor, '#90A8FA99');

  // A DCA moves the average: a fresh spec must MOVE the same line tool via
  // setPoints, not stack a second one.
  env.send('paper-lines', {
    enabled: true,
    axisBasis: 'mcap',
    currentPriceNative: 5e-9,
    currentPriceUsd: 0.0082,
    avgBuyUsd: 0.0123, // now 1.5x current => 1.5x the close
  });
  await microtasks();
  const lines = env.lineShapes.filter((s) => !s.removed && s.props.text === 'PAPER Avg. Fill');
  assert.equal(lines.length, 1, 'the moved average updates in place — never a second line');
  assert.ok(Math.abs(lines[0].points[0].price - 12_300_000) < 1,
    `the line moved to the new frozen level, got ${lines[0].points[0].price}`);
});

test('fomo: fiber-only discovery hooks bars and reports marks UNHOOKED', () => {
  const env = runFomoBridge();
  announceToken(env);
  env.runTimers();

  const statuses = env.statuses('padre-hook-status');
  assert.ok(statuses.length, 'discovery must report a hook status');
  const last = statuses[statuses.length - 1];
  assert.equal(last.barsHooked, true, 'subscribeBars must be patched via the fiber-discovered widget');
  assert.equal(last.marksHooked, false, 'fomo has NO getMarks — claiming a marks hook would suppress every fallback');
  assert.equal(last.nativeCapable, true, 'a usable widget exists, so the content script may route natively');
});

/* ------------------------------------------------------------------ *
 * 2. Live bars through the composite Codex symbol
 * ------------------------------------------------------------------ */

test('fomo: mcap bars tick out under the RESOLVED identity, not the composite symbol', () => {
  const env = runFomoBridge();
  bootWithLiveBar(env);

  const ticks = env.statuses('tick').filter((t) => t && t.source === 'padre-chart-bar');
  assert.ok(ticks.length, 'a live bar must emit a tick');
  const tick = ticks[ticks.length - 1];
  assert.equal(tick.mint, FOMO_MINT, 'the tick must carry the content-resolved mint so the token gate passes');
  assert.equal(tick.mcap, LIVE_BAR_CLOSE, 'the mcap-denominated close must be offered as a cap candidate');
  assert.equal(tick.candidates[0].unit, 'unknown', 'the close is offered for anchor-banding, never asserted as a price');
});

/* ------------------------------------------------------------------ *
 * 3. Fills: execution shapes are the ONLY render path (no getMarks)
 * ------------------------------------------------------------------ */

test('fomo: a paper fill renders as an execution shape at the MCAP level', async () => {
  const env = runFomoBridge();
  bootWithLiveBar(env);

  env.send('paper-lines', {
    enabled: true,
    axisBasis: 'mcap',
    currentPriceNative: CURRENT_PRICE_NATIVE,
    currentPriceUsd: CURRENT_PRICE_USD,
    avgBuyNative: 0.0000065,
    avgBuyUsd: 0.0013,
    avgBuyMcap: 1300000,
  });
  await microtasks();

  env.send('paper-marker', {
    side: 'buy',
    priceNative: 0.0000065,
    priceUsd: 0.0013,
    mcap: 1300000,
    solAmount: 0.5,
    ts: Date.now(),
    symbol: 'Doom',
  });
  // The marks pipeline can never run (nothing was patchable); the 2s
  // verification timer must hand rendering to execution shapes.
  env.runTimeouts();
  await microtasks();

  assert.ok(env.execShapes.length >= 1, 'with no getMarks, the fill MUST appear as an execution shape');
  const shape = env.execShapes[env.execShapes.length - 1];
  const level = shape.values.setPrice;
  // F-31 universal formula on the mcap axis: close x (fillNative/currentNative)
  // = 1417171.26 x (6.5/7.0) ~= 1_316_016. The essential truth: the arrow
  // sits on the MCAP axis, never at the raw USD/SOL price magnitude.
  assert.ok(level > 1e6 && level < 1.5e6,
    `fill level must land on the mcap axis near 1.32M, got ${level}`);
  assert.equal(shape.values.setDirection, 'buy');
});

/* ------------------------------------------------------------------ *
 * 3b. F-39: the PRODUCTION build — DOM bubbles, because broker
 *     primitives throw on the standalone charting library
 * ------------------------------------------------------------------ */

function sendMcapLines(env) {
  env.send('paper-lines', {
    enabled: true,
    axisBasis: 'mcap',
    currentPriceNative: CURRENT_PRICE_NATIVE,
    currentPriceUsd: CURRENT_PRICE_USD,
    avgBuyNative: 0.0000065,
    avgBuyUsd: 0.0013,
    avgBuyMcap: 1300000,
  });
}

const CHIP = /translate3d\((-?[\d.]+)px,\s*(-?[\d.]+)px/;

test('F-39: on the standalone build a paper fill renders as a PT DOM bubble at the exact axis level', async () => {
  const env = runFomoBridge({ liveShape: true });
  const t0 = Date.now();
  env.setNow(t0);
  bootWithLiveBar(env);
  sendMcapLines(env);
  await microtasks();

  env.send('paper-marker', {
    side: 'buy',
    priceNative: 0.0000065,
    priceUsd: 0.0013,
    mcap: 1300000,
    solAmount: 0.5,
    ts: t0,
    symbol: 'Doom',
  });
  // The marks pipeline can never run and execution shapes THROW — the 2s
  // verification timer must hand rendering to the DOM bubble layer.
  env.runTimeouts();
  await microtasks();

  assert.equal(env.execShapes.length, 0, 'nothing can spawn broker shapes on this build');
  const host = env.doc.body.children.find((el) => 'data-pt-bubbles' in el.attrs);
  assert.ok(host, 'the bubble overlay host mounts on <body>, never inside the page tree');
  const chips = host.children.filter((el) => el.attrs['data-pt-bubble']);
  assert.equal(chips.length, 1, 'one fill, one bubble');
  const chip = chips[0];
  assert.equal(chip.attrs['data-pt-bubble'], 'buy');
  assert.equal(chip.textContent, '▲');
  assert.match(chip.title, /\(Paper\)/, 'the tooltip must disclose the fill is paper (F-30)');
  assert.equal(chip.style.visibility, 'visible');

  // The chip is CENTERED on the fill's own axis level. Level = close x
  // (fillNative/currentNative) — the F-31 universal formula; coordinates
  // ride the same internal scales the site's own overlay reads.
  const level = LIVE_BAR_CLOSE * (0.0000065 / CURRENT_PRICE_NATIVE);
  const expectedY = 50 + 4 + (420 - level / 50000) - 10;
  const snapped = Math.floor(t0 / 60000) * 60; // 1-minute grid from the live subscription
  const expectedX = 100 + 8 + (snapped - env.paneT0Sec) / 10 - 10;
  const m = CHIP.exec(chip.style.transform || '');
  assert.ok(m, `the chip must be positioned via translate3d, got "${chip.style.transform}"`);
  assert.ok(Math.abs(Number(m[1]) - expectedX) < 0.6, `x ${m[1]} vs expected ${expectedX}`);
  assert.ok(Math.abs(Number(m[2]) - expectedY) < 0.6, `y ${m[2]} vs expected ${expectedY}`);
});

test('F-39: same-bar fills stack upward and a sell reads as a red down-chip', async () => {
  const env = runFomoBridge({ liveShape: true });
  const t0 = Date.now();
  env.setNow(t0);
  bootWithLiveBar(env);
  sendMcapLines(env);
  await microtasks();

  const fill = (side, priceNative, priceUsd, mcap) => env.send('paper-marker', {
    side, priceNative, priceUsd, mcap, solAmount: 0.25, ts: t0, symbol: 'Doom',
  });
  fill('buy', 0.0000065, 0.0013, 1300000);
  fill('buy', 0.0000065, 0.0013, 1300000); // same level, same snapped bar
  fill('sell', 0.0000072, 0.00144, 1440000);
  env.runTimeouts();
  await microtasks();

  const host = env.doc.body.children.find((el) => 'data-pt-bubbles' in el.attrs);
  assert.ok(host);
  const chips = host.children.filter((el) => el.attrs['data-pt-bubble']);
  assert.equal(chips.length, 3, 'every fill gets a chip');
  const buys = chips.filter((c) => c.attrs['data-pt-bubble'] === 'buy');
  assert.equal(buys.length, 2);
  const ys = buys.map((c) => Number(CHIP.exec(c.style.transform)[2]));
  assert.ok(Math.abs(Math.abs(ys[0] - ys[1]) - 23) < 0.01,
    `the second same-bar buy lifts one chip step (20px + 3px gap), got dy=${Math.abs(ys[0] - ys[1])}`);
  const sell = chips.find((c) => c.attrs['data-pt-bubble'] === 'sell');
  assert.ok(sell, 'the sell renders its own chip');
  assert.equal(sell.textContent, '▼');
});

test('F-39: standdown removes every bubble and the overlay host itself', async () => {
  const env = runFomoBridge({ liveShape: true });
  const t0 = Date.now();
  env.setNow(t0);
  bootWithLiveBar(env);
  sendMcapLines(env);
  await microtasks();
  env.send('paper-marker', {
    side: 'buy', priceNative: 0.0000065, priceUsd: 0.0013, mcap: 1300000,
    solAmount: 0.5, ts: t0, symbol: 'Doom',
  });
  env.runTimeouts();
  await microtasks();
  assert.ok(env.doc.body.children.some((el) => 'data-pt-bubbles' in el.attrs), 'bubbles exist before standdown');

  env.send('standdown');
  assert.equal(env.doc.body.children.find((el) => 'data-pt-bubbles' in el.attrs), undefined,
    '"PaperTrench off" must leave the page exactly as it found it');
});

function chipOf(env) {
  const host = env.doc.body.children.find((el) => 'data-pt-bubbles' in el.attrs);
  return host && host.children.find((el) => el.attrs['data-pt-bubble']);
}

test('F-32-for-bubbles: the chip level FREEZES — quiet ledgers, moving closes and zoom churn never move or hide it', async () => {
  // Maintainer field report (2026-08-05, first live test of the layer):
  // "for a second you can see it, but then it disappears… blinks in while
  // zooming… moving a little bit with the chart." Three symptoms, one
  // cause: the level was recomputed every frame from moving evidence.
  const env = runFomoBridge({ liveShape: true });
  const t0 = Date.now();
  env.setNow(t0);
  bootWithLiveBar(env);
  sendMcapLines(env);
  await microtasks();
  env.send('paper-marker', {
    side: 'buy', priceNative: 0.0000065, priceUsd: 0.0013, mcap: 1300000,
    solAmount: 0.5, ts: t0, symbol: 'Doom',
  });
  env.runTimeouts();
  await microtasks();
  const chip = chipOf(env);
  assert.ok(chip && chip.style.visibility === 'visible', 'the chip draws');
  const placed = chip.style.transform;

  // 1) A quiet token: every ledger entry ages past BAR_CLOSE_FRESH_MS with
  //    no new bars. The fill did not stop being real — the chip must stay.
  env.advance(60_000);
  env.runTimers(); // sweep -> drawShapeFallback -> fresh layout
  assert.equal(chip.style.visibility, 'visible', 'a stale ledger must not evaporate a placed fill');
  assert.equal(chip.style.transform, placed, 'a stale ledger must not move a placed fill');

  // 2) The chart keeps ticking and the spec keeps re-posting (C-01): the
  //    close and the current price both move — the LEVEL is already frozen.
  const live = env.subscribed();
  live.callback({ time: Date.now(), close: 9_000_000, volume: 1 });
  env.send('paper-lines', {
    enabled: true, axisBasis: 'mcap',
    currentPriceNative: 0.000009, currentPriceUsd: 0.0018,
    avgBuyNative: 0.0000065, avgBuyUsd: 0.0013, avgBuyMcap: 1300000,
  });
  await microtasks();
  env.runTimers();
  assert.equal(chip.style.transform, placed,
    'a moving market must never move a FILLED order\'s chip — the level is frozen (F-32)');

  // 3) Zoom churn: firstValue nulls out for a frame. Keep position, no blink.
  env.setFirstValue(null);
  env.runTimers();
  assert.equal(chip.style.visibility, 'visible', 'a transient internals gap must not blink the chip');
  assert.equal(chip.style.transform, placed);
  env.setFirstValue(1.4e6);
  env.runTimers();
  assert.equal(chip.style.visibility, 'visible');
});

test('F-41: a quiet token keeps its average line — a STALE ledger must not veto the export close', async () => {
  // Maintainer: bubbles showed, the average line never did. The bubbles were
  // frozen while evidence was fresh; the line recomputed every 2 s repost and
  // hit vettedMcapClose's `if (barCloseLedger.size) return null` — which
  // refused the perfectly good export-poll close merely because the ledger
  // held an entry, even an entirely STALE one. The level then fell back to
  // the resolver's own cap, which on a chart whose visible band is a few
  // percent wide is off-screen.
  const env = runFomoBridge({ liveShape: true });
  const t0 = Date.now();
  env.setNow(t0);
  bootWithLiveBar(env, 8_000_000); // one live cap bar -> ledger entry

  // The token goes quiet: every ledger entry ages past BAR_CLOSE_FRESH_MS,
  // while the chart's own last close (8.0M) is still known.
  env.advance(60_000);

  env.send('paper-lines', {
    enabled: true,
    axisBasis: 'mcap',
    currentPriceNative: CURRENT_PRICE_NATIVE,
    currentPriceUsd: CURRENT_PRICE_USD,
    currentMcap: 8_000_000,
    avgBuyNative: CURRENT_PRICE_NATIVE,
    avgBuyUsd: CURRENT_PRICE_USD,
    // A resolver cap that DISAGREES with the chart's by 40% — off-screen if
    // it is ever used as the level.
    avgBuyMcap: 4_800_000,
  });
  await microtasks();

  const line = env.lineShapes.find((s) => !s.removed && s.props.text === 'PAPER Avg. Fill');
  assert.ok(line, 'a quiet token must still draw its average line');
  const level = line.points[0].price;
  assert.ok(Math.abs(level - 8_000_000) < 1000,
    `the line must ride the chart's own close (8.0M), not the resolver cap (4.8M) — got ${level}`);
});

test('F-41: the line HOLDS its level across price reposts, and still follows a DCA', async () => {
  // Freeze parity with bubbles: a repost that changes only the live price
  // must not recompute (and possibly relocate) a correct line.
  const env = runFomoBridge({ liveShape: true });
  const t0 = Date.now();
  env.setNow(t0);
  bootWithLiveBar(env, 8_000_000);

  const post = (over) => env.send('paper-lines', Object.assign({
    enabled: true,
    axisBasis: 'mcap',
    currentPriceNative: CURRENT_PRICE_NATIVE,
    currentPriceUsd: CURRENT_PRICE_USD,
    currentMcap: 8_000_000,
    avgBuyNative: CURRENT_PRICE_NATIVE,
    avgBuyUsd: CURRENT_PRICE_USD,
  }, over));

  post({});
  await microtasks();
  const first = env.lineShapes.find((s) => !s.removed && s.props.text === 'PAPER Avg. Fill');
  assert.ok(first, 'the line draws');
  const placed = first.points[0].price;

  // The market moves and the spec re-posts (C-01) — same average, new prices.
  env.advance(30_000); // and the ledger goes stale underneath it
  post({ currentPriceNative: CURRENT_PRICE_NATIVE * 1.2, currentPriceUsd: CURRENT_PRICE_USD * 1.2, currentMcap: 9_600_000 });
  await microtasks();
  const held = env.lineShapes.filter((s) => !s.removed && s.props.text === 'PAPER Avg. Fill');
  assert.equal(held.length, 1, 'still exactly one average line');
  assert.equal(held[0].points[0].price, placed,
    'a moving market must not move the average line — the average did not change');

  // A DCA DOES change the average, and the line must follow it.
  post({ avgBuyNative: CURRENT_PRICE_NATIVE * 1.1, avgBuyUsd: CURRENT_PRICE_USD * 1.1 });
  await microtasks();
  const moved = env.lineShapes.filter((s) => !s.removed && s.props.text === 'PAPER Avg. Fill');
  assert.equal(moved.length, 1);
  assert.notEqual(moved[0].points[0].price, placed,
    'a changed average MUST move the line');
});

test('F-41: an uncomputable level HOLDS the line; only "no average" removes it', async () => {
  // "No level" and "no line" are different facts. When a wanted average
  // briefly cannot be converted onto the axis (the chart flips Price/MCap
  // and the conversion inputs lapse for a post), the line on screen is still
  // the correct constant in axis units — destroying it is how a held
  // position lost its average line and got it back only on the next tick.
  const env = runFomoBridge({ liveShape: true });
  env.setNow(Date.now());
  bootWithLiveBar(env, 8_000_000);

  env.send('paper-lines', {
    enabled: true, axisBasis: 'mcap',
    currentPriceNative: CURRENT_PRICE_NATIVE, currentPriceUsd: CURRENT_PRICE_USD,
    currentMcap: 8_000_000,
    avgBuyNative: CURRENT_PRICE_NATIVE, avgBuyUsd: CURRENT_PRICE_USD,
  });
  await microtasks();
  const drawn = env.lineShapes.filter((s) => !s.removed && s.props.text === 'PAPER Avg. Fill');
  assert.equal(drawn.length, 1, 'the line draws');
  const level = drawn[0].points[0].price;

  // The axis flips and the conversion inputs are momentarily gone: the buy
  // average is still WANTED, but no level can be computed for it.
  env.send('paper-lines', {
    enabled: true, axisBasis: 'native',
    currentPriceNative: 0, currentPriceUsd: 0,
    avgBuyNative: 0, avgBuyUsd: CURRENT_PRICE_USD,
  });
  await microtasks();
  const held = env.lineShapes.filter((s) => !s.removed && s.props.text === 'PAPER Avg. Fill');
  assert.equal(held.length, 1, 'a wanted average whose level lapsed must KEEP its line');
  assert.equal(held[0].points[0].price, level, 'and must not move it to a guess');

  // Closing the position IS "no average" — that must remove the line.
  env.send('paper-lines', {
    enabled: true, axisBasis: 'mcap',
    currentPriceNative: CURRENT_PRICE_NATIVE, currentPriceUsd: CURRENT_PRICE_USD,
    avgBuyNative: 0, avgBuyUsd: 0,
  });
  await microtasks();
  const gone = env.lineShapes.filter((s) => !s.removed && s.props.text === 'PAPER Avg. Fill');
  assert.equal(gone.length, 0, 'no average means no line — that removal is intended');
});

test('F-41: one fill posted twice is ONE bubble — the bridge keys marks by fill id', async () => {
  const env = runFomoBridge({ liveShape: true });
  const t0 = Date.now();
  env.setNow(t0);
  bootWithLiveBar(env);
  sendMcapLines(env);
  await microtasks();

  const fill = {
    side: 'buy', fillId: 'trade-abc-1', priceNative: 0.0000065, priceUsd: 0.0013,
    mcap: 1300000, solAmount: 0.5, ts: t0, symbol: 'Doom',
  };
  env.send('paper-marker', fill);
  // The same fill again (a journal replay, or a storage echo upstream).
  env.send('paper-marker', Object.assign({}, fill, { ts: t0 + 1500 }));
  env.runTimeouts();
  await microtasks();

  const host = env.doc.body.children.find((el) => 'data-pt-bubbles' in el.attrs);
  const chips = host.children.filter((el) => el.attrs['data-pt-bubble']);
  assert.equal(chips.length, 1, 'one fill id, one bubble, however many times it is posted');
  const statuses = env.statuses('paper-marker-status');
  assert.ok(statuses.some((status) => status.duplicate === true),
    'the bridge must SAY it recognized a duplicate rather than silently dropping it');
});

test('F-39 entry replay: fills posted BEFORE the chart exists draw once it appears — the off-chart snipe scenario', async () => {
  // Maintainer: quick-buy from a row snipe off the chart, then open the
  // chart — bubble and average line must be there on load-in. The content
  // script already replays the journal at resolve time; this locks the
  // bridge half: marks and specs that arrive while NO chart exists must
  // draw the moment discovery finds one.
  const env = runFomoBridge({ liveShape: true, chartVisible: false });
  const t0 = Date.now();
  env.setNow(t0);
  announceToken(env);
  env.runTimers(); // discovery finds nothing — the iframe is not mounted yet
  sendMcapLines(env);
  env.send('paper-marker', {
    side: 'buy', priceNative: 0.0000065, priceUsd: 0.0013, mcap: 1300000,
    solAmount: 0.5, ts: t0, symbol: 'Doom',
  });
  env.runTimeouts(); // 2s verification: fallback active, still nothing to draw on
  await microtasks();
  assert.equal(chipOf(env), undefined, 'no chart, no chip — nothing to glue to yet');

  // The chart mounts (page finished loading) and its datafeed subscribes
  // under the composite Codex symbol — the needle gate must recognize it.
  env.setChartVisible(true);
  env.runTimers(); // sweep: discovery + datafeed patch
  env.fomoDatafeed.subscribeBars(
    { ticker: `${FOMO_MINT.toUpperCase()}:${FOMO_NETWORK}` }, '1', () => {}, `${FOMO_MINT}_#_USD_-_1`
  );
  env.subscribed().callback({ time: Date.now(), close: LIVE_BAR_CLOSE, volume: 1 });
  env.runTimers(); // sweep retry: fallback draw finds the chart now
  await microtasks();
  env.runTimers();
  const chip = chipOf(env);
  assert.ok(chip, 'the restored fill draws once the chart exists');
  assert.equal(chip.style.visibility, 'visible');
  const m = CHIP.exec(chip.style.transform || '');
  const level = LIVE_BAR_CLOSE * (0.0000065 / CURRENT_PRICE_NATIVE);
  const expectedY = 50 + 4 + (420 - level / 50000) - 10;
  assert.ok(Math.abs(Number(m[2]) - expectedY) < 0.6,
    `the late-drawn chip still lands on the exact fill level, got ${m && m[2]}`);
  const line = env.lineShapes.find((s) => !s.removed && s.props.text === 'PAPER Avg. Fill');
  assert.ok(line, 'the average line also draws on late chart arrival');
});

/* ------------------------------------------------------------------ *
 * 4. Average lines on the mcap axis
 * ------------------------------------------------------------------ */

test('fomo: the average line lands on the mcap axis via the vetted live close', async () => {
  const env = runFomoBridge();
  bootWithLiveBar(env);

  env.send('paper-lines', {
    enabled: true,
    axisBasis: 'mcap',
    currentPriceNative: CURRENT_PRICE_NATIVE,
    currentPriceUsd: CURRENT_PRICE_USD,
    avgBuyNative: 0.0000065,
    avgBuyUsd: 0.0013,
    avgBuyMcap: 1300000,
  });
  await microtasks();

  assert.ok(env.orderLines.length >= 1, 'the buy average must draw a native order line');
  const line = env.orderLines[env.orderLines.length - 1];
  const level = line.values.setPrice;
  assert.ok(level > 1e6 && level < 1.5e6,
    `average line must land on the mcap axis near 1.32M, got ${level}`);
});

/* ------------------------------------------------------------------ *
 * 5. Stale live-bar state must not drag fresh fills into the past
 * ------------------------------------------------------------------ */

test('fomo: a fill placed while live bars are STALE keeps its own time', async () => {
  const env = runFomoBridge();
  const t0 = Date.now();
  env.setNow(t0);
  bootWithLiveBar(env); // live bar stamped at t0

  env.send('paper-lines', {
    enabled: true,
    axisBasis: 'mcap',
    currentPriceNative: CURRENT_PRICE_NATIVE,
    currentPriceUsd: CURRENT_PRICE_USD,
    avgBuyNative: 0.0000065,
    avgBuyUsd: 0.0013,
    avgBuyMcap: 1300000,
  });
  await microtasks();

  // Five minutes pass with NO live bars (fomo subscribed before the patch,
  // or volume died) — the export peg owns the price now. F-31's clamp
  // guards millisecond feed skew; clamping a fresh SELL back onto a
  // five-minute-old candle renders it far left of the action — the user
  // reads that as "my sell never showed up".
  env.advance(5 * 60_000);
  const sellTs = t0 + 5 * 60_000;
  env.send('paper-marker', {
    side: 'sell',
    priceNative: 0.0000072,
    priceUsd: 0.00144,
    mcap: 1440000,
    solAmount: 0.5,
    ts: sellTs,
    symbol: 'Doom',
  });
  env.runTimeouts();
  await microtasks();

  const sell = env.execShapes.find((s) => s.values.setDirection === 'sell');
  assert.ok(sell, 'the sell must draw as a shape');
  const drawnSec = sell.values.setTime;
  assert.ok(Math.abs(drawnSec - Math.floor(sellTs / 1000)) <= 60,
    `a stale live-bar time must not drag the fill back: drawn at ${drawnSec}, `
    + `fill was at ${Math.floor(sellTs / 1000)} (delta ${Math.floor(sellTs / 1000) - drawnSec}s)`);
});

/* ------------------------------------------------------------------ *
 * 6. The status surface must name what it is doing (X-Ray dock lesson)
 * ------------------------------------------------------------------ */

test('fomo: marker status admits shapes own rendering on a no-getMarks site', async () => {
  const env = runFomoBridge();
  bootWithLiveBar(env);
  env.send('paper-marker', {
    side: 'buy', priceNative: 0.0000065, priceUsd: 0.0013, mcap: 1300000,
    solAmount: 0.5, ts: Date.now(), symbol: 'Doom',
  });
  env.runTimeouts();
  await microtasks();
  // A second fill reports status AFTER the fallback engaged.
  env.send('paper-marker', {
    side: 'buy', priceNative: 0.0000066, priceUsd: 0.00132, mcap: 1320000,
    solAmount: 0.5, ts: Date.now(), symbol: 'Doom',
  });
  await microtasks();

  const statuses = env.statuses('paper-marker-status').filter((s) => s && s.action === 'add');
  const last = statuses[statuses.length - 1];
  assert.equal(last.shapeFallback, true,
    'the status must say execution shapes own rendering, or the UI shows "marks connecting…" forever');
  assert.ok(last.shapesDrawn >= 1, 'and how many fills are actually on the chart');
});

test('fomo: a lines refusal names its reason', async () => {
  const env = runFomoBridge();
  announceToken(env);
  env.runTimers(); // discovery, but NO bar has ever ticked and exports are empty

  // A fresh-launch fill: only the NATIVE average is known (C-07's shape —
  // no USD rate yet), no resolver mcap, and no bar close has ever arrived.
  // The level is genuinely uncomputable; the status must say so.
  env.send('paper-lines', {
    enabled: true,
    axisBasis: 'mcap',
    currentPriceNative: CURRENT_PRICE_NATIVE,
    avgBuyNative: 0.0000065,
  });
  await microtasks();

  const statuses = env.statuses('paper-lines-status').filter((s) => s && s.action === 'sync');
  const last = statuses[statuses.length - 1];
  assert.ok(last, 'a sync attempt must report');
  assert.equal(last.ok, false,
    'a wanted level with no close is NOT ok — "LINES ✓" with nothing drawn is a silent false-success');
  assert.ok(typeof last.reason === 'string' && last.reason.startsWith('no-level'),
    'a refused line must NAME the reason — "lines connecting…" forever is the X-Ray dock failure again');
});

/* ------------------------------------------------------------------ *
 * 7. The social feed must never tick the price
 * ------------------------------------------------------------------ */

// Shaped exactly like the live /feed/token response (items abridged, ids and
// handles anonymized, magnitudes preserved: this token trades at ~$0.0014 /
// 1.4M cap NOW; the feed carries trades from when it was ~$0.00118 / 1.18M).
const FEED_FIXTURE = JSON.stringify({
  success: true,
  message: 'Token feed retrieved successfully',
  responseObject: {
    items: [
      {
        type: 'swap_buy',
        id: '00000000-1111-2222-3333-444444444444',
        tradeId: '55555555-6666-7777-8888-999999999999',
        createdAt: '2026-08-05T16:01:00.000Z',
        userId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        displayName: 'trader one',
        userHandle: 'traderone',
        profilePictureLink: 'https://example.invalid/p1.jpg',
        usdAmount: 30,
        marketCap: 1180000,
        fdv: 1180000,
        price: 0.00118,
      },
      {
        type: 'swap_sell',
        id: '10000000-1111-2222-3333-444444444444',
        tradeId: '65555555-6666-7777-8888-999999999999',
        createdAt: '2026-08-05T14:22:00.000Z',
        userId: 'baaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        displayName: 'trader two',
        userHandle: 'tradertwo',
        profilePictureLink: 'https://example.invalid/p2.jpg',
        usdAmount: 21.85,
        marketCap: 1620000,
        fdv: 1620000,
        price: 0.00162,
      },
    ],
    hasNextPage: false,
  },
  statusCode: 200,
});

// Positive control, shaped like /proxy/filterTokens: a genuine MARKET
// snapshot (no trade attribution) whose price must keep flowing, tagged.
const OTHER_MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const SNAPSHOT_FIXTURE = JSON.stringify({
  success: true,
  message: 'Successfully fetched 1 cached, 0 fresh',
  responseObject: [{
    change5m: '-0.004',
    liquidity: '250000',
    marketCap: '13000000',
    priceUSD: '0.0161',
    token: { address: OTHER_MINT, decimals: 9, networkId: 1399811149, name: 'Bonk', symbol: 'BONK' },
  }],
  statusCode: 200,
});

function jsonResponse(body) {
  return {
    url: '',
    headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'application/json' : String(body.length)) },
    clone: () => ({ text: () => Promise.resolve(body) }),
  };
}

test('fomo: historical social-feed trades never become price candidates', async () => {
  const env = runFomoBridge({
    fetchResponse: (url) => jsonResponse(String(url).includes('/feed/token') ? FEED_FIXTURE : SNAPSHOT_FIXTURE),
  });
  announceToken(env); // liveness + feed demand

  await env.win.fetch(`https://prod-api.fomo.family/feed/token?tokenAddress=${FOMO_MINT}`);
  await microtasks(10);

  const stale = [0.00118, 0.00162, 1180000, 1620000];
  const polluted = env.statuses('tick').filter((t) => {
    const values = [];
    if (t && Array.isArray(t.candidates)) for (const c of t.candidates) values.push(c.value);
    if (t && t.mcap) values.push(t.mcap);
    return values.some((v) => stale.includes(v));
  });
  assert.equal(polluted.length, 0,
    'user-attributed historical trades are facts about the PAST, never live price candidates: ' +
    JSON.stringify(polluted[0] || null));
});

// Shaped exactly like the live /hodlers/top response (captured 2026-08-05):
// per-token objects tagged with tokenAddress (the CURRENT mint), holding
// topHolders[] rows that each carry tradeId, a NESTED user object, and the
// holder's ENTRY `price` plus pnl/costBasis/averageEntryPrice. Entry prices
// near the live price pass the accept band — they ticked the P&L.
const HODLERS_FIXTURE = JSON.stringify({
  success: true,
  message: 'Successfully fetched top hodlers',
  responseObject: [{
    tokenAddress: FOMO_MINT,
    networkId: 1399811149,
    topHolders: [
      {
        user: { id: 'aaaa-1', handle: 'holderone', displayName: 'holder one' },
        tradeId: '11111111-2222-3333-4444-555555555555',
        humanAmount: 16100000,
        price: 0.00121, // entry price, hours old, inside the 3x band of 0.0014
        value: 3947.36,
        pnl: -1030.54,
        unrealizedPnl: -1030.54,
        realizedPnl: 0,
        costBasis: 4977.9,
        averageEntryPrice: 0.00121,
        comment: null,
        numReplies: 3,
        showComment: true,
        averageHoldTimeSeconds: 60180,
      },
      {
        user: { id: 'aaaa-2', handle: 'holdertwo', displayName: 'holder two' },
        tradeId: '61111111-2222-3333-4444-555555555555',
        humanAmount: 11500000,
        price: 0.00187,
        value: 2827.4,
        pnl: 5149.9,
        unrealizedPnl: 5149.9,
        realizedPnl: 0,
        costBasis: 1200.1,
        averageEntryPrice: 0.00187,
        comment: null,
        numReplies: 1,
        showComment: true,
        averageHoldTimeSeconds: 93720,
      },
    ],
    totalHolders: 768,
  }],
  statusCode: 200,
});

test('fomo: holder ENTRY prices never tick the live price, even mint-tagged', async () => {
  const env = runFomoBridge({
    fetchResponse: () => jsonResponse(HODLERS_FIXTURE),
  });
  announceToken(env);

  await env.win.fetch(`https://prod-api.fomo.family/hodlers/top?tokens=${FOMO_MINT}`);
  await microtasks(10);

  const stale = [0.00121, 0.00187];
  const polluted = env.statuses('tick').filter((t) => t
    && Array.isArray(t.candidates) && t.candidates.some((c) => stale.includes(c.value)));
  assert.equal(polluted.length, 0,
    'a holder record (tradeId + nested user + costBasis/pnl) is someone\'s POSITION, '
    + 'not the market — F-30, one shape out: ' + JSON.stringify(polluted[0] || null));
});

test('fomo: a genuine market snapshot still ticks, mint-tagged (guard must not over-reach)', async () => {
  const env = runFomoBridge({
    fetchResponse: () => jsonResponse(SNAPSHOT_FIXTURE),
  });
  announceToken(env);

  await env.win.fetch('https://prod-api.fomo.family/proxy/filterTokens');
  await microtasks(10);

  // filterTokens nests priceUSD BESIDE the token{address} record, so the
  // candidate legitimately flows untagged — downstream anchor-banding is the
  // validator. The guard must not stop it: no trade attribution here.
  const snapshotTicks = env.statuses('tick').filter((t) => t
    && Array.isArray(t.candidates) && t.candidates.some((c) => c.value === 0.0161));
  assert.ok(snapshotTicks.length >= 1,
    'market snapshots without trade attribution must keep flowing (downstream banding validates them)');
});
