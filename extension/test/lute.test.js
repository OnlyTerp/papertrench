/* Lute (lute.gg) site adapter tests + pollution guard locks.
 *
 * Every shape in this fake was captured from the LIVE site on 2026-08-06:
 *
 *  - Token page URL: lute.gg/trade/<base58Address>
 *  - Named routes (compass, momentum, portfolio, discover) are NOT token pages.
 *  - Holder rows carry avgBuyPriceUSD, avgSellPriceUSD, pnlUSD, realizedPnlUSD
 *    — all position-shaped, never market data.
 *  - POSITION_SUBTREE_KEY includes "toptraders" (lute's token event domain).
 *
 * The pollution locks come in the fomo pair-form: the polluted shape never
 * ticks, AND a genuine market snapshot still ticks (the guard must not
 * over-reach). The API routes are NOT in the capture set — the walker is
 * URL-agnostic (the fomo fixtures ship response.url = '' for the same
 * reason), so these locks pin SHAPE behavior; route truth is a live-probe
 * item on the QA matrix.
 *
 * Live re-probe (in-app browser, LOGGED IN, 2026-08-06):
 *  - The loaded token-page title is "BONK ↑ $2.46B • Lute" — symbol plus a
 *    $-keyed MARKET CAP. The default gmgn TITLE_PATTERNS fallback extracts
 *    the cap correctly and the on-chain anchor band validates it; no lute
 *    entry needed. (The pre-load title "Lute • Trade" carries no figure.)
 *  - The chart is the SELF-HOSTED TradingView standalone library
 *    (/charting_library/ bundles). Discovery anchors confirmed live:
 *    iframe id tradingview_*, options bag in window[frameId],
 *    contentWindow.tradingViewApi. The datafeed HAS getMarks (with
 *    markSubscriptions/marksFetched state) — friend-trade marks ARE the
 *    product — so lute is native-marks class, NOT fomo's shapes-only
 *    class. The chart-truth locks at the bottom of this file boot that
 *    captured shape; the walker locks above stay chartless for isolation.
 *  - Named routes live-verified: compass, momentum, portfolio, discover,
 *    predict (missed by the landing corpus), plus bare /trade. Token
 *    pages are LOGIN-GATED: logged-out /trade/<mint> bounces to login.
 *  - The Top Traders UI carries per-trader avg buy/sell MCAPs and PnL
 *    that sit INSIDE the 3x accept band of the live cap — the exact
 *    reason the toptraders subtree taint exists. Wire-format key
 *    spellings ride a WebSocket and remain landing-recon facts.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SITES = fs.readFileSync(path.join(ROOT, 'sites.js'), 'utf8');

const LUTE_MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

function detectAt(href) {
  const url = new URL(href);
  const sandbox = {
    window: {}, self: {},
    location: { href, hostname: url.hostname, pathname: url.pathname, search: url.search },
    URLSearchParams, console,
  };
  vm.createContext(sandbox);
  vm.runInContext(SITES, sandbox, { filename: 'sites.js' });
  const site = sandbox.window.PaperTrenchSites.currentSite();
  return { site, token: site.detect() };
}

/* ====================== Detection ====================== */

test('lute adapter detects a Solana token page', () => {
  const { site, token } = detectAt(`https://lute.gg/trade/${LUTE_MINT}`);
  assert.equal(site.id, 'lute');
  assert.ok(token, 'a token page must produce a detection');
  assert.equal(token.kind, 'mint');
  assert.equal(token.address, LUTE_MINT);
  assert.equal(token.chain, 'solana', 'lute is always Solana');
});

test('lute adapter detects a token page with query string', () => {
  const { site, token } = detectAt(`https://lute.gg/trade/${LUTE_MINT}?ref=abc`);
  assert.equal(site.id, 'lute');
  assert.ok(token);
  assert.equal(token.address, LUTE_MINT);
});

test('lute adapter refuses all named routes (O-10)', () => {
  const named = ['compass', 'momentum', 'portfolio', 'discover'];
  for (const route of named) {
    const { site, token } = detectAt(`https://lute.gg/trade/${route}`);
    assert.equal(site.id, 'lute', `must match lute host for /trade/${route}`);
    assert.equal(token, null, `/trade/${route} must return null (O-10)`);
  }
});

test('lute adapter refuses non-trade routes (O-10)', () => {
  for (const href of [
    'https://lute.gg/',
    'https://lute.gg/login',
    'https://lute.gg/signup',
    'https://lute.gg/trade',
  ]) {
    const { token } = detectAt(href);
    assert.equal(token, null, `${href} must return null (O-10)`);
  }
});

test('lute adapter refuses short path segments that are not base58', () => {
  const { token } = detectAt('https://lute.gg/trade/sol');
  assert.equal(token, null, 'short slug "sol" must fail the {32,44} length gate');
});

test('lute adapter tokenUrl builds the correct URL', () => {
  const { site } = detectAt(`https://lute.gg/trade/${LUTE_MINT}`);
  const url = site.tokenUrl(LUTE_MINT);
  assert.equal(url, `https://lute.gg/trade/${LUTE_MINT}`);
});

test('lute adapter tokenUrl works for chip navigation', () => {
  const { site } = detectAt(`https://lute.gg/trade/${LUTE_MINT}`);
  const mint = 'Gymbmn9wwMKe4NnmVceyyfpncp9arbwPfSdBsyY9pump';
  const url = site.tokenUrl(mint);
  assert.equal(url, `https://lute.gg/trade/${mint}`);
});

/* ====================== Contract ====================== */

test('lute adapter satisfies the detect() contract shape', () => {
  const { token } = detectAt(`https://lute.gg/trade/${LUTE_MINT}`);
  assert.ok(token);
  assert.equal(typeof token.kind, 'string');
  assert.ok(token.kind === 'mint' || token.kind === 'pair');
  assert.equal(typeof token.address, 'string');
  assert.ok(token.address.length > 0);
  assert.equal(typeof token.chain, 'string');
  assert.equal(token.chain, token.chain.toLowerCase(),
    'chain must be lowercase — it is a map key in quote.js CHAIN_MAP');
});

test('lute adapter always sets chain (foreign chain field)', () => {
  const { token } = detectAt(`https://lute.gg/trade/${LUTE_MINT}`);
  assert.ok(token);
  assert.ok('chain' in token, 'chain field must be present');
  assert.equal(token.chain, 'solana');
});

/* ====================== Pollution guard locks ====================== */

test('POSITION_SUBTREE_KEY includes toptraders (lute domain)', () => {
  const source = fs.readFileSync(path.join(ROOT, 'price-bridge.js'), 'utf8');
  assert.ok(source.includes('toptraders'),
    'POSITION_SUBTREE_KEY must include toptraders for lute holder/toptrader data');
});

test('looksLikePositionRecord catches avgBuyPriceUSD (lute holder shape)', () => {
  const source = fs.readFileSync(path.join(ROOT, 'price-bridge.js'), 'utf8');
  assert.ok(source.includes('avgBuyPriceUSD'),
    'looksLikePositionRecord must recognize avgBuyPriceUSD from lute holder rows');
  assert.ok(source.includes('realizedPnlUSD'),
    'looksLikePositionRecord must recognize realizedPnlUSD from lute holder rows');
});

/* ============ Bounds lock — the {32,44} gate holds BOTH ends ============ */

test('lute adapter length gate is exact at both bounds', () => {
  // 32 is the shortest valid Solana address shape — it must detect...
  const ok = detectAt('https://lute.gg/trade/' + '1'.repeat(32));
  assert.ok(ok.token, '32-char base58 is a valid address shape and must mount');
  // ...and one char outside either bound must refuse. A widened upper bound
  // ({32,45}) or lowered floor would mount the panel on garbage segments.
  assert.equal(detectAt('https://lute.gg/trade/' + '1'.repeat(31)).token, null,
    '31 chars is not an address');
  assert.equal(detectAt('https://lute.gg/trade/' + '1'.repeat(45)).token, null,
    '45 chars is not an address');
});

/* ============ Behavioral pollution locks (the fomo pair-form) ============
 *
 * Boot the shipped price-bridge.js on a lute-shaped page with NO chart
 * surface at all — lute's widget internals are not in the capture set, and
 * the fake must not implement what was never observed (F-39). The generic
 * collect() walker runs on network JSON regardless, which is exactly the
 * surface these guards defend. */

function microtasks(n = 6) {
  let p = Promise.resolve();
  for (let i = 0; i < n; i++) p = p.then(() => {});
  return p;
}

function jsonResponse(body) {
  return {
    url: '',
    headers: { get: (h) => (String(h).toLowerCase() === 'content-type' ? 'application/json' : String(body.length)) },
    clone: () => ({ text: () => Promise.resolve(body) }),
  };
}

function runLuteBridge(opts = {}) {
  const emitted = [];
  const listeners = {};
  const timers = [];
  const timeouts = new Map();
  let timeoutSeq = 0;

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
    querySelector: () => null,     // no widget iframe: nothing was captured, so nothing exists
    querySelectorAll: () => [],
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

  const sandbox = {
    window: win,
    document: doc,
    location: { href: `https://lute.gg/trade/${LUTE_MINT}`, hostname: 'lute.gg' },
    console, Date, Math, Number, String, Array, Object, Boolean, RegExp,
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
    win,
    send(type, payload) {
      listeners.message({
        source: win,
        data: { source: 'papertrench-content', type, payload },
      });
    },
    statuses(type) { return emitted.filter((m) => m.source === 'papertrench-bridge' && m.type === type).map((m) => m.payload); },
  };
}

function announceLuteToken(env) {
  env.send('paper-axis', { mint: LUTE_MINT, symbol: 'LUTE', pairAddress: null });
}

// Rows under lute's "toptraders" key, carrying plain entry `price` fields and
// NO other position markers — only the POSITION_SUBTREE_KEY taint stands
// between these numbers and the live price.
const TOPTRADERS_FIXTURE = JSON.stringify({
  data: {
    toptraders: [
      { address: LUTE_MINT, price: 0.00313, amountUSD: 3947.36, wallet: 'trader-one' },
      { address: LUTE_MINT, price: 0.00427, amountUSD: 2827.4, wallet: 'trader-two' },
    ],
  },
});

test('lute: toptraders entry prices never become price candidates, even mint-tagged', async () => {
  const env = runLuteBridge({ fetchResponse: () => jsonResponse(TOPTRADERS_FIXTURE) });
  announceLuteToken(env);

  await env.win.fetch('https://lute.gg/__shape_fixture__');
  await microtasks(10);

  const stale = [0.00313, 0.00427];
  const polluted = env.statuses('tick').filter((t) => t
    && Array.isArray(t.candidates) && t.candidates.some((c) => stale.includes(c.value)));
  assert.equal(polluted.length, 0,
    'a toptraders row is someone\'s HISTORY — its price must never tick: '
    + JSON.stringify(polluted[0] || null));
});

// Live rows carry avgBuyPriceUSD/avgSellPriceUSD/pnlUSD/realizedPnlUSD
// together (see header); each fixture below is reduced to a SINGLE marker so
// each looksLikePositionRecord clause is locked in isolation — removing one
// clause reds its own test instead of hiding behind the other.
const AVGBUY_ROW_FIXTURE = JSON.stringify({
  holderRow: { address: LUTE_MINT, price: 0.00358, avgBuyPriceUSD: 0.00358, amount: 1250000 },
});
const REALIZED_ROW_FIXTURE = JSON.stringify({
  holderRow: { address: LUTE_MINT, price: 0.00592, realizedPnlUSD: -220.4, amount: 88000 },
});

test('lute: a row carrying avgBuyPriceUSD is a position record — its price never ticks', async () => {
  const env = runLuteBridge({ fetchResponse: () => jsonResponse(AVGBUY_ROW_FIXTURE) });
  announceLuteToken(env);

  await env.win.fetch('https://lute.gg/__shape_fixture__');
  await microtasks(10);

  const polluted = env.statuses('tick').filter((t) => t
    && Array.isArray(t.candidates) && t.candidates.some((c) => c.value === 0.00358));
  assert.equal(polluted.length, 0,
    'avgBuyPriceUSD marks a position record — F-30, lute spelling');
});

test('lute: a row carrying realizedPnlUSD is a position record — its price never ticks', async () => {
  const env = runLuteBridge({ fetchResponse: () => jsonResponse(REALIZED_ROW_FIXTURE) });
  announceLuteToken(env);

  await env.win.fetch('https://lute.gg/__shape_fixture__');
  await microtasks(10);

  const polluted = env.statuses('tick').filter((t) => t
    && Array.isArray(t.candidates) && t.candidates.some((c) => c.value === 0.00592));
  assert.equal(polluted.length, 0,
    'realizedPnlUSD marks a position record — F-30, lute spelling');
});

// Positive control: a genuine mint-tagged market snapshot with none of the
// position markers must keep flowing — the lute guards must not over-reach.
const SNAPSHOT_FIXTURE = JSON.stringify({
  address: LUTE_MINT,
  symbol: 'LUTE',
  priceUSD: '0.0161',
  marketCap: '13000000',
  liquidity: '250000',
});

test('lute: a genuine market snapshot still ticks (guards must not over-reach)', async () => {
  const env = runLuteBridge({ fetchResponse: () => jsonResponse(SNAPSHOT_FIXTURE) });
  announceLuteToken(env);

  await env.win.fetch('https://lute.gg/__shape_fixture__');
  await microtasks(10);

  const snapshotTicks = env.statuses('tick').filter((t) => t
    && Array.isArray(t.candidates) && t.candidates.some((c) => c.value === 0.0161));
  assert.ok(snapshotTicks.length >= 1,
    'market snapshots without position markers must keep flowing');
});

/* ============ Chart-truth locks (live-captured shape, 2026-08-06) ============
 *
 * Field defect (WhiteBull, MC axis): the SELL booked at a ~20% stale level
 * (33.1K) while the chart the trader watched sat at ~41K — a winning trade
 * rendered as -9.6%. Below the F-47 witness ratio, the only defense is the
 * chart peg staying alive. These locks boot the shipped price-bridge.js
 * against lute's LIVE-CAPTURED chart shape and pin every link of that peg:
 *
 *  - Chart symbol: "MINT:LUTE/USD" (uppercased by the library; captured as
 *    DEZXAZ8Z…:BONK/USD on the real site).
 *  - Discovery: NO fiber anywhere; the options bag (with the datafeed and a
 *    brokerFactory) sits in window[frameId], and the widget api is
 *    contentWindow.tradingViewApi — the F-38 composite, lute flavor.
 *  - Datafeed: subscribeBars keyed on symbolInfo.base_name[0], DEDUPED by
 *    subscriber uid ("if (this.active.has(n)) return") — a subscription made
 *    before our patch is never re-made. getMarks EXISTS (friend-trade marks
 *    are the product).
 *  - exportData: resolves { schema, data } rows, close at index 4, in the
 *    axis unit (USD here, captured close 0.000027938; the MC toggle makes
 *    the same series stream mcap — the unit:'unknown' contract downstream).
 *  - Broker primitives THROW like the standalone build. brokerFactory was
 *    PRESENT in the live bag but never CALLED on the real site — F-39:
 *    presence is not capability, so the fake keeps the conservative floor.
 */

const LUTE_EXPORT_CLOSE = 0.000027938030166638182; // captured BONK close, 2026-08-06

function runLuteChartBridge(opts = {}) {
  const timers = [];
  const timeouts = new Map();
  let timeoutSeq = 0;
  const emitted = [];
  const listeners = {};

  // Site-side datafeed: dedupe + base_name identity, captured semantics.
  const activeSubs = new Map();
  const luteDatafeed = {
    onReady() {}, searchSymbols() {}, resolveSymbol() {}, getBars() {},
    subscribeBars(symbolInfo, resolution, callback, uid) {
      const address = symbolInfo && symbolInfo.base_name && symbolInfo.base_name[0];
      if (!address || activeSubs.has(uid)) return; // live-captured dedupe
      activeSubs.set(uid, { symbolInfo, resolution, callback, uid });
    },
    unsubscribeBars(uid) { activeSubs.delete(uid); },
    getMarks(symbolInfo, from, to, onDataCallback) {
      // The site's own friend-trade marks; empty is a valid live answer.
      setTimeout(() => onDataCallback([]), 0);
    },
  };

  const exportRows = [[1786061580, LUTE_EXPORT_CLOSE, LUTE_EXPORT_CLOSE, LUTE_EXPORT_CLOSE, LUTE_EXPORT_CLOSE]];
  const lineShapes = [];
  let shapeSeq = 0;
  const fakePaneDiv = {
    getBoundingClientRect: () => ({ left: 8, top: 4, width: 800, height: 420 }),
  };
  const luteChart = {
    symbol: () => `${LUTE_MINT.toUpperCase()}:LUTE/USD`,
    resolution: () => '1S',
    exportData: () => Promise.resolve({
      schema: [
        { type: 'time' },
        { type: 'value', plotTitle: 'open' },
        { type: 'value', plotTitle: 'high' },
        { type: 'value', plotTitle: 'low' },
        { type: 'value', plotTitle: 'close' },
      ],
      data: exportRows.slice(),
    }),
    createOrderLine: () => { throw new Error('createOrderLine is only available on Trading Platform'); },
    createExecutionShape: () => { throw new Error('createExecutionShape is only available on Trading Platform'); },
    createShape(point, shapeOpts) {
      const id = `lute-shape-${++shapeSeq}`;
      const rec = {
        id, point, opts: shapeOpts,
        points: [{ price: point && point.price }],
        props: Object.assign({}, shapeOpts && shapeOpts.overrides,
          shapeOpts && shapeOpts.text != null ? { text: shapeOpts.text } : null),
        removed: false,
      };
      rec.api = {
        setPoints(pts) { rec.points = pts; },
        setProperties(props) { Object.assign(rec.props, props); },
      };
      lineShapes.push(rec);
      return Promise.resolve(id);
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
    refreshMarks() {},
    _chartWidget: {
      paneWidgets: () => [{ _div: fakePaneDiv }],
      model: () => ({
        timeScale: () => ({ timeToCoordinate: () => 100 }),
        mainSeries: () => ({
          priceScale: () => ({ priceToCoordinate: () => 200 }),
          firstValue: () => LUTE_EXPORT_CLOSE,
        }),
      }),
    },
  };

  const luteIframe = {
    id: 'tradingview_4bddc', // captured frame id shape
    parentElement: {},       // NO fiber anywhere — captured absence
    contentWindow: { tradingViewApi: { activeChart: () => luteChart } },
    getClientRects: () => [{}],
    clientWidth: 800,
    getBoundingClientRect: () => ({ left: 100, top: 50, width: 800, height: 430 }),
  };

  function makeFakeEl(tag) {
    return {
      tag, style: {}, attrs: {}, children: [], parentNode: null, textContent: '', title: '',
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
    querySelector: (sel) => (String(sel).includes('iframe[id^="tradingview_"]') ? luteIframe : null),
    querySelectorAll: (sel) => (String(sel).includes('iframe[id^="tradingview_"]') ? [luteIframe] : []),
    createElement: (tag) => makeFakeEl(tag),
    body: makeFakeEl('body'),
    hidden: false,
  };

  function FakeWebSocket() {}
  FakeWebSocket.prototype.addEventListener = () => {};
  FakeWebSocket.CONNECTING = 0; FakeWebSocket.OPEN = 1;
  FakeWebSocket.CLOSING = 2; FakeWebSocket.CLOSED = 3;
  function FakeXHR() {}
  FakeXHR.prototype.send = function () {};
  FakeXHR.prototype.addEventListener = function () {};

  const win = {
    fetch: () => Promise.resolve({
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
  // The captured options bag: datafeed + broker wiring in window[frameId].
  win[luteIframe.id] = {
    datafeed: luteDatafeed,
    brokerFactory: () => ({}),
    brokerConfig: {},
    overrides: {},
    disabledFeatures: [],
    enabledFeatures: [],
  };

  // THE FIELD RACE: the site subscribed BEFORE the extension ever ran, and
  // the dedupe above means it will never subscribe again on its own.
  if (opts.preSubscribe !== false) {
    luteDatafeed.subscribeBars(
      {
        base_name: [LUTE_MINT],
        name: 'LUTE', symbol: 'LUTE',
        ticker: `${LUTE_MINT.toUpperCase()}:LUTE/USD`,
      },
      '1S',
      opts.siteCallback || (() => {}),
      'site-initial-sub'
    );
  }

  const sandbox = {
    window: win,
    document: doc,
    location: { href: `https://lute.gg/trade/${LUTE_MINT}`, hostname: 'lute.gg' },
    console, Date, Math, Number, String, Array, Object, Boolean, RegExp,
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
    win,
    datafeed: luteDatafeed,
    activeSubs,
    lineShapes,
    setExportClose(v) { exportRows[0] = [exportRows[0][0] + 1, v, v, v, v]; },
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

test('lute chart: the no-fiber bag shape is discovered — bars AND marks hook, native capable', async () => {
  const env = runLuteChartBridge();
  announceLuteToken(env);
  env.runTimers(); // widget sweep: composite discovery + datafeed patch
  await microtasks(6);

  const statuses = env.statuses('padre-hook-status');
  assert.ok(statuses.length, 'discovery must report a hook status');
  const last = statuses[statuses.length - 1];
  assert.equal(last.barsHooked, true,
    'subscribeBars must be patched via the bag-discovered datafeed');
  assert.equal(last.marksHooked, true,
    'lute HAS getMarks (friend marks are the product) — the native marks pipeline must hook');
  assert.equal(last.nativeCapable, true,
    'a usable widget exists, so the content script may route natively');
});

test('lute chart: a subscription made BEFORE the patch still pegs the price — export closes flow', async () => {
  const env = runLuteChartBridge();
  announceLuteToken(env);
  env.runTimers();          // sweep discovers + patches; site never re-subscribes
  env.runTimers();          // export poll now sees the ranked, symbol-matched chart
  await microtasks(10);

  const exports_ = env.statuses('tick').filter((t) => t && t.source === 'chart-export');
  assert.ok(exports_.length >= 1,
    'with the bar hook starved by the pre-patch subscription, exportData IS the peg');
  const tick = exports_[exports_.length - 1];
  assert.equal(tick.candidates[0].key, 'chartExportClose');
  assert.equal(tick.candidates[0].value, LUTE_EXPORT_CLOSE,
    'the pegged close is the chart the trader is looking at');
  assert.equal(tick.candidates[0].unit, 'unknown',
    'MC/$ toggle means the unit is unknowable here — downstream anchors decide');
  assert.equal(tick.mint, LUTE_MINT, 'the close is mint-tagged for the watched token');
});

test('lute chart: 61 sweep ticks with a live chart never stand the export peg down (F-26)', async () => {
  // No paper-axis announce here on purpose: the ONLY thing keeping the miss
  // counter at zero must be the discovery itself seeing the widget. If the
  // bag-path discovery ever stops setting lastWidgetScanFound, the export
  // peg dies exactly one minute in — the field shape of the stale sell.
  const env = runLuteChartBridge();
  for (let i = 0; i < 61; i++) env.runTimers();
  await microtasks(10);

  const fresh = 0.000031;
  env.setExportClose(fresh);
  env.runTimers();
  await microtasks(10);

  const pegged = env.statuses('tick').filter((t) => t && t.source === 'chart-export'
    && t.candidates && t.candidates.some((c) => c.value === fresh));
  assert.ok(pegged.length >= 1,
    'a chart that is visibly alive must still be pegging after a minute of sweeps');
});

test('lute chart: a post-patch (re)subscription streams live bars to us AND to the site (F-29)', async () => {
  const env = runLuteChartBridge();
  announceLuteToken(env);
  env.runTimers(); // patch lands

  const siteBars = [];
  env.datafeed.subscribeBars(
    {
      base_name: [LUTE_MINT],
      name: 'LUTE', symbol: 'LUTE',
      ticker: `${LUTE_MINT.toUpperCase()}:LUTE/USD`,
    },
    '1S',
    (bar) => siteBars.push(bar),
    'post-patch-sub'
  );
  const sub = env.activeSubs.get('post-patch-sub');
  assert.ok(sub, 'the wrapped subscription must still reach the site datafeed');

  const liveBar = { time: Date.now(), close: 0.000029, volume: 12.5 };
  sub.callback(liveBar);
  await microtasks(6);

  const barTicks = env.statuses('tick').filter((t) => t && t.source === 'padre-chart-bar'
    && t.candidates && t.candidates.some((c) => c.value === 0.000029));
  assert.ok(barTicks.length >= 1, 'a live lute bar becomes a mint-tagged bridge tick');
  assert.equal(barTicks[barTicks.length - 1].mint, LUTE_MINT);
  assert.equal(siteBars.length, 1,
    'the site\'s own callback must receive every bar our preamble sees (F-29)');
});
