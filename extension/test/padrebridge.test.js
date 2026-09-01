/* Padre-specific MAIN-world integration.
 *
 * Padre's production app exposes TradingView as window.tvWidget. These tests
 * drive the shipped price-bridge.js against a faithful fake of the two APIs we
 * rely on: datafeed.subscribeBars for decoded live bars, datafeed.getMarks /
 * activeChart().refreshMarks() for native chart bubbles, and createOrderLine()
 * for Padre-style average fill and exit lines.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const PADRE_UPDATE_FRAME = Uint8Array.from(Buffer.from(
  'kwVVgqR0eXBlpnVwZGF0ZaZ1cGRhdGWCpGFkZHOQp3VwZGF0ZXORg6x0b2tlbkFkZHJlc3PZLEZRVGtncTZHa1l6a3JRRjNCMWNyaGZ2WUdrbjJ1THlNRTI4eFNIYnBwdW1wqGZkdkluVXNky0CoROThzofUqnByaWNlSW5Vc2TLPsoPC1Fz3To=',
  'base64',
));
const PADRE_NEWER_UPDATE_FRAME = Uint8Array.from(Buffer.from(
  'kwVVgqR0eXBlpnVwZGF0ZaZ1cGRhdGWCpGFkZHOQp3VwZGF0ZXORg6x0b2tlbkFkZHJlc3PZLEZRVGtncTZHa1l6a3JRRjNCMWNyaGZ2WUdrbjJ1THlNRTI4eFNIYnBwdW1wqnByaWNlSW5Vc2TLQCP64UeuFHuoZmR2SW5Vc2TNJwY=',
  'base64',
));
const PADRE_OTHER_UPDATE_FRAME = Uint8Array.from(Buffer.from(
  'kwVVgqR0eXBlpnVwZGF0ZaZ1cGRhdGWCpGFkZHOQp3VwZGF0ZXORg6x0b2tlbkFkZHJlc3PZIDExMTExMTExMTExMTExMTExMTExMTExMTExMTExMTExqnByaWNlSW5Vc2TLQB4AAAAAAACoZmR2SW5Vc2TPAAAAAb8I6wA=',
  'base64',
));
const PADRE_NATIVE_RATE_FRAME = Uint8Array.from(Buffer.from(
  'kwVVgqx0b2tlbkFkZHJlc3PZLEZRVGtncTZHa1l6a3JRRjNCMWNyaGZ2WUdrbjJ1THlNRTI4eFNIYnBwdW1wsm5hdGl2ZVByaWNlSW5Vc2RVactAWZfzf6mDcg==',
  'base64',
));

function runBridge(opts = {}) {
  let clock = Date.now();
  const timers = [];
  const emitted = [];
  const listeners = {};
  let dataViewCalls = 0;
  const pendingBlobs = [];
  let realtimeCallback = null;
  let clearMarksCount = 0;
  let refreshMarksCount = 0;
  const orderLines = [];
  const NativeDataView = DataView;

  class TestDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }

  class TestBlob {
    constructor(parts) {
      const bytes = Uint8Array.from(parts[0] || []);
      this.bytes = bytes;
      this.arrayBufferCalls = 0;
      if (opts.deferBlobs) {
        this.promise = new Promise((resolve) => {
          this.resolve = resolve;
        });
        pendingBlobs.push(this);
      }
    }

    arrayBuffer() {
      this.arrayBufferCalls++;
      if (this.promise) return this.promise;
      return Promise.resolve(this.bytes.buffer.slice(
        this.bytes.byteOffset,
        this.bytes.byteOffset + this.bytes.byteLength,
      ));
    }

    resolveFrame() {
      if (this.resolve) {
        this.resolve(this.bytes.buffer.slice(
          this.bytes.byteOffset,
          this.bytes.byteOffset + this.bytes.byteLength,
        ));
        this.resolve = null;
      }
    }
  }

  function TestDataView(...args) {
    dataViewCalls++;
    return new NativeDataView(...args);
  }
  TestDataView.prototype = NativeDataView.prototype;

  function makeOrderLine() {
    const line = { removed: false, values: {}, calls: [] };
    const methods = [
      'setText', 'setQuantity', 'setLineColor', 'setLineStyle', 'setLineWidth',
      'setPrice', 'setBodyFont', 'setBodyTextColor', 'setBodyBorderColor',
      'setBodyBackgroundColor', 'setEditable',
    ];
    for (const method of methods) {
      line[method] = function (value) {
        this.values[method] = value;
        this.calls.push([method, value]);
        return this;
      };
    }
    line.remove = function () { this.removed = true; return this; };
    orderLines.push(line);
    return line;
  }

  const datafeed = {
    subscribeBars(symbolInfo, resolution, callback) {
      realtimeCallback = callback;
    },
    getMarks(symbolInfo, from, to, callback) {
      callback([{ id: 'padre-site-mark', time: from + 1, label: 'M' }]);
    },
  };
  const chart = {
    clearMarks() { clearMarksCount += 1; },
    refreshMarks() { refreshMarksCount += 1; },
    createOrderLine: makeOrderLine,
  };

  function FakeWebSocket() {
    this.listeners = {};
    FakeWebSocket.last = this;
  }
  FakeWebSocket.prototype.addEventListener = function (type, listener) {
    this.listeners[type] = listener;
  };
  FakeWebSocket.prototype.emit = function (data) {
    if (this.listeners.message) this.listeners.message({ data });
  };
  FakeWebSocket.CONNECTING = 0;
  FakeWebSocket.OPEN = 1;
  FakeWebSocket.CLOSING = 2;
  FakeWebSocket.CLOSED = 3;

  function FakeSharedWorker() {
    const listeners = {};
    this.port = {
      addEventListener(type, listener) { listeners[type] = listener; },
      start() {},
      emit(data) { if (listeners.message) listeners.message({ data }); },
    };
  }

  function FakeXHR() {}
  FakeXHR.prototype.send = function () {};
  FakeXHR.prototype.addEventListener = function () {};

  const win = {
    tvWidget: {
      _options: { datafeed },
      activeChart: () => chart,
    },
    fetch: (url) => {
      const isGmgnMcap = String(url).includes('/api/v1/token_mcap_candles/');
      const body = isGmgnMcap
        ? JSON.stringify({ data: { list: [{ close: '123456789.12' }, { close: '123999999.45' }] } })
        : '{}';
      return Promise.resolve({
        url: String(url),
        headers: { get: () => 'application/json' },
        clone: () => ({ text: () => Promise.resolve(body) }),
      });
    },
    XMLHttpRequest: FakeXHR,
    WebSocket: FakeWebSocket,
    SharedWorker: FakeSharedWorker,
    EventSource: undefined,
    addEventListener(type, fn) { listeners[type] = fn; },
    postMessage(message) { emitted.push(message); },
  };
  win.window = win;

  const sandbox = {
    window: win,
    // Turbo host-gates the SharedWorker tap to gmgn.ai, so the harness must
    // carry a real hostname; GMGN-only paths pass a GMGN href.
    location: (() => {
      const href = opts.href || 'https://trade.padre.gg/trade/Mint1';
      return { href, hostname: new URL(href).hostname };
    })(),
    console,
    Date: TestDate,
    Math,
    Number,
    String,
    Array,
    Object,
    Boolean,
    RegExp,
    Error,
    Set,
    WeakSet,
    Symbol,
    JSON,
    ArrayBuffer,
    Uint8Array,
    DataView: TestDataView,
    TextDecoder,
    Blob: TestBlob,
    Promise,
    isFinite,
    setInterval(fn, ms) { timers.push(fn); return timers.length; },
    clearInterval() {},
    setTimeout(fn) { fn(); return 1; },
  };

  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'price-bridge.js'), 'utf8'), ctx, {
    filename: 'price-bridge.js',
  });
  // Run the startup hook after evaluation, like a real interval task.
  for (const fn of timers.slice()) fn();

  return {
    datafeed,
    emitted,
    listeners,
    chart,
    realtime: () => realtimeCallback,
    clearMarksCount: () => clearMarksCount,
    refreshMarksCount: () => refreshMarksCount,
    orderLines,
    win,
    Blob: TestBlob,
    dataViewCalls: () => dataViewCalls,
    pendingBlobs,
    advanceNow(ms) { clock += ms; },
    send(type, payload) {
      listeners.message({
        source: win,
        data: { source: 'papertrench-content', type, payload },
      });
    },
    resolveBlob(index) { pendingBlobs[index].resolveFrame(); },
    openSocket() { return new win.WebSocket('wss://backend.padre.gg/_multiplex?desc=/trenches'); },
  };
}

test('Padre decoded TradingView bars emit an immediate PaperTrench tick', () => {
  const env = runBridge();
  let delivered = null;

  env.datafeed.subscribeBars({}, '15S', (bar) => { delivered = bar; }, 'sub-1', () => {});
  assert.equal(typeof env.realtime(), 'function', 'bridge must wrap subscribeBars before subscription');

  const bar = { time: 1_700_000_000_000, close: 12_345_678 };
  env.realtime()(bar);

  assert.equal(delivered, bar, 'Padre must still receive its original callback unchanged');
  const message = env.emitted.find((m) => m.type === 'tick' && m.payload?.source === 'padre-chart-bar');
  assert.ok(message, 'decoded chart bar must be forwarded immediately');
  assert.equal(message.payload.candidates[0].value, bar.close);
  assert.equal(message.payload.mcap, bar.close,
    'the unknown chart close is offered as mcap so quote validation can identify chart mode');
});

test('Padre MessagePack frames emit mint-tagged USD ticks with their FDV cap', () => {
  const env = runBridge();
  const socket = env.openSocket();
  socket.emit(PADRE_UPDATE_FRAME.buffer);

  const message = env.emitted.find((m) => m.type === 'tick' && m.payload?.source === 'ws');
  assert.ok(message, 'a decoded Padre update must feed the generic tick pipeline');
  assert.equal(message.payload.mint, 'FQTkgq6GkYzkrQF3B1crhfvYGkn2uLyME28xSHbppump');
  assert.equal(message.payload.candidates[0].unit, 'usd');
  assert.equal(message.payload.candidates[0].value, 3.10644703526886e-06);
  assert.equal(message.payload.mcap, 3106.4470352688604);
});

test('Padre Blob frames are decoded without blocking the WebSocket handler', async () => {
  const env = runBridge();
  const socket = env.openSocket();
  socket.emit(new env.Blob([PADRE_UPDATE_FRAME]));
  await Promise.resolve();
  await Promise.resolve();

  assert.ok(env.emitted.some((m) => m.type === 'tick' && m.payload?.source === 'ws'),
    'a Padre Blob frame must reach the same generic tick pipeline');
});

test('Padre Blob frames carry their receive time when conversions complete backwards', async () => {
  const env = runBridge({ deferBlobs: true });
  const socket = env.openSocket();
  socket.emit(new env.Blob([PADRE_UPDATE_FRAME]));
  env.advanceNow(10);
  socket.emit(new env.Blob([PADRE_NEWER_UPDATE_FRAME]));
  assert.equal(env.pendingBlobs.length, 2);

  env.resolveBlob(1);
  await Promise.resolve();
  assert.equal(env.emitted.filter((m) => m.type === 'tick' && m.payload?.source === 'ws').length, 1);
  env.resolveBlob(0);
  await Promise.resolve();
  await Promise.resolve();

  const ticks = env.emitted.filter((m) => m.type === 'tick' && m.payload?.source === 'ws');
  assert.equal(ticks.length, 2);
  assert.equal(ticks[0].payload.candidates[0].value, 9.99);
  assert.equal(ticks[0].payload.at, ticks[1].payload.at + 10);
});

test('a later Padre frame without a quote does not suppress a valid tick', () => {
  const env = runBridge();
  const socket = env.openSocket();
  socket.emit(PADRE_UPDATE_FRAME.buffer);
  socket.emit(PADRE_NATIVE_RATE_FRAME.buffer);

  const ticks = env.emitted.filter((m) => m.type === 'tick' && m.payload?.source === 'ws');
  assert.equal(ticks.length, 1);
  assert.equal(ticks[0].payload.mint, 'FQTkgq6GkYzkrQF3B1crhfvYGkn2uLyME28xSHbppump');
});

test('a Padre frame for another mint does not suppress the first mint', () => {
  const env = runBridge();
  const socket = env.openSocket();
  socket.emit(PADRE_UPDATE_FRAME.buffer);
  socket.emit(PADRE_OTHER_UPDATE_FRAME.buffer);

  const ticks = env.emitted.filter((m) => m.type === 'tick' && m.payload?.source === 'ws');
  assert.equal(ticks.length, 2);
  assert.equal(ticks[0].payload.mint, 'FQTkgq6GkYzkrQF3B1crhfvYGkn2uLyME28xSHbppump');
  assert.equal(ticks[1].payload.mint, '11111111111111111111111111111111');
});

test('Padre binary frames are gated before decoding when feed demand is off', () => {
  const env = runBridge();
  env.send('page-state', { wantsTicks: false });
  const socket = env.openSocket();
  const blob = new env.Blob([PADRE_UPDATE_FRAME]);
  socket.emit(PADRE_UPDATE_FRAME.buffer);
  socket.emit(blob);

  assert.equal(env.dataViewCalls(), 0, 'inactive feeds must not decode binary frames');
  assert.equal(blob.arrayBufferCalls, 0, 'inactive feeds must not copy Blob bodies');
  assert.equal(env.emitted.filter((m) => m.type === 'tick' && m.payload?.source === 'ws').length, 0);
});

test('Padre binary frames decode when feed demand is on', () => {
  const env = runBridge();
  const socket = env.openSocket();
  socket.emit(PADRE_UPDATE_FRAME.buffer);

  assert.ok(env.dataViewCalls() > 0, 'active feeds decode the captured binary envelope');
  assert.ok(env.emitted.some((m) => m.type === 'tick' && m.payload?.source === 'ws'));
});

test('Padre nativePriceInUsdUi is never treated as a token price', () => {
  const env = runBridge();
  env.openSocket().emit(PADRE_NATIVE_RATE_FRAME.buffer);

  assert.ok(!env.emitted.some((m) => m.type === 'tick' && m.payload?.source === 'ws'),
    'the chain SOL/USD rate must not become an unattributed token tick');
});

test('malformed and oversized Padre frames are rejected without throwing', () => {
  const env = runBridge();
  const socket = env.openSocket();
  assert.doesNotThrow(() => {
    socket.emit(PADRE_UPDATE_FRAME.slice(0, 12).buffer);
    socket.emit(new Uint8Array(512 * 1024 + 1).buffer);
  });
  assert.ok(!env.emitted.some((m) => m.type === 'tick' && m.payload?.source === 'ws'),
    'invalid frames must not produce partial ticks');
});

test('non-Padre hosts ignore binary WebSocket frames', () => {
  const env = runBridge({ href: 'https://axiom.trade/pulse' });
  env.openSocket().emit(PADRE_UPDATE_FRAME.buffer);
  assert.ok(!env.emitted.some((m) => m.type === 'tick' && m.payload?.source === 'ws'),
    'binary Padre decoding must remain host-scoped');
});

test('paper buys are merged into Padre native getMarks with hover details', () => {
  const env = runBridge();
  const ts = Date.now();

  env.listeners.message({
    source: env.win,
    data: {
      source: 'papertrench-content',
      type: 'paper-marker',
      payload: {
        ts,
        side: 'buy',
        priceNative: 0.00001234,
        solAmount: 0.5,
        symbol: 'TEST',
      },
    },
  });

  assert.ok(env.clearMarksCount() >= 1, 'adding a marker must clear TradingView mark cache');
  assert.ok(env.refreshMarksCount() >= 1, 'adding a marker must refresh native chart marks');

  let marks = null;
  env.datafeed.getMarks({}, Math.floor(ts / 1000) - 60, Math.floor(ts / 1000) + 60, (result) => {
    marks = result;
  });

  assert.ok(Array.isArray(marks));
  assert.ok(marks.some((m) => m.id === 'padre-site-mark'), 'Padre marks must be preserved');
  const paper = marks.find((m) => String(m.id).startsWith('papertrench-buy-'));
  assert.ok(paper, 'paper buy must be returned through Padre getMarks');
  assert.equal(paper.label, 'B');
  assert.match(paper.text, /Buy \(Paper\)/);
  assert.match(paper.text, /0\.5000 SOL/);
  assert.match(paper.text, /TEST/);
  assert.deepEqual(JSON.parse(JSON.stringify(paper.color)), {
    background: '#17C671',
    border: '#17C671',
  });
});

test('paper sells use Padre native red S marks', () => {
  const env = runBridge();
  const ts = Date.now();

  env.listeners.message({
    source: env.win,
    data: {
      source: 'papertrench-content',
      type: 'paper-marker',
      payload: {
        ts,
        side: 'sell',
        priceNative: 0.00002,
        solAmount: 0.75,
        symbol: 'TEST',
      },
    },
  });

  let marks = null;
  env.datafeed.getMarks({}, Math.floor(ts / 1000) - 1, Math.floor(ts / 1000) + 1, (result) => {
    marks = result;
  });
  const paper = marks.find((m) => String(m.id).startsWith('papertrench-sell-'));
  assert.ok(paper);
  assert.equal(paper.label, 'S');
  assert.match(paper.text, /Sell \(Paper\)/);
  assert.equal(paper.color.background, '#E73A44');
});

test('average paper fills use Padre native order-line styling exactly', () => {
  const env = runBridge();

  env.listeners.message({
    source: env.win,
    data: {
      source: 'papertrench-content',
      type: 'paper-lines',
      // axisBasis is stated: DEFECT C-05 forbids drawing before any bar
      // close when the axis unit is unknown, so the content script's
      // learned basis is part of the contract this test drives.
      payload: { enabled: true, axisBasis: 'usd', avgBuyUsd: 0.00042, avgSellUsd: 0.00069 },
    },
  });

  assert.equal(env.orderLines.length, 2, 'fill and exit must each create one native line');
  const [fill, exit] = env.orderLines;

  // F-30: the label deliberately differs from Padre's own real-position line
  // ('Avg. Fill Price') — a paper line must be unmistakably paper when the
  // user holds BOTH a real and a paper position on the same token.
  assert.equal(fill.values.setText, 'PAPER Avg. Fill');
  assert.equal(fill.values.setPrice, 0.00042);
  assert.equal(fill.values.setLineColor, '#90A8FA99');
  assert.equal(fill.values.setLineStyle, 2);
  assert.equal(fill.values.setLineWidth, 1);
  assert.equal(fill.values.setQuantity, '');
  assert.equal(fill.values.setBodyFont, '11px Inter, sans-serif');
  assert.equal(fill.values.setBodyTextColor, '#90A8FA99');
  assert.equal(fill.values.setBodyBorderColor, '#FFFFFF00');
  assert.equal(fill.values.setBodyBackgroundColor, '#FFFFFF00');
  assert.equal(fill.values.setEditable, false);

  assert.equal(exit.values.setText, 'PAPER Avg. Exit');
  assert.equal(exit.values.setPrice, 0.00069);
  assert.equal(exit.values.setLineColor, '#F7DC8599');
});

test('average lines update in place and are removed when disabled', () => {
  const env = runBridge();
  const send = (type, payload) => env.listeners.message({
    source: env.win,
    data: { source: 'papertrench-content', type, payload },
  });

  // axisBasis stated for the same C-05 reason as above.
  send('paper-lines', { enabled: true, axisBasis: 'usd', avgBuyUsd: 1, avgSellUsd: 2 });
  const [fill, exit] = env.orderLines;
  send('paper-lines', { enabled: true, axisBasis: 'usd', avgBuyUsd: 1.5, avgSellUsd: null });

  assert.equal(env.orderLines.length, 2, 'updating must not create duplicate lines');
  assert.equal(fill.values.setPrice, 1.5, 'average fill line must update in place');
  assert.equal(fill.removed, false);
  assert.equal(exit.removed, true, 'missing exit average must remove only the exit line');

  send('paper-lines-clear');
  assert.equal(fill.removed, true, 'disabling must remove the remaining native line');
});

test('GMGN market-cap candles emit their latest close as the exact chart-scale tick', async () => {
  const env = runBridge();
  await env.win.fetch('https://gmgn.ai/api/v1/token_mcap_candles/sol/TestMint?resolution=1m');
  // The fetch interceptor schedules clone().text(), so let the promise chain drain.
  await Promise.resolve();
  await Promise.resolve();

  const message = env.emitted.find((m) => m.type === 'tick' && m.payload?.source === 'gmgn-mcap-candle');
  assert.ok(message, 'GMGN mcap candle response must emit a chart-scale tick');
  assert.equal(message.payload.candidates.length, 0, 'market cap must not be misclassified as a token price');
  assert.equal(message.payload.mcap, 123999999.45, 'the newest candle close is GMGN\'s active chart value');
});

test('GMGN SharedWorker price messages are forwarded as live page quotes', () => {
  // The SharedWorker tap is scoped to GMGN, the one audited site that carries
  // prices this way — so this test must boot on a GMGN page, not Padre.
  const env = runBridge({ href: 'https://gmgn.ai/sol/token/Mint1' });
  const worker = new env.win.SharedWorker('gmgn-realtime-worker.js');
  const mint = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
  worker.port.emit({ token: { priceUsd: '0.00001234', mint } });

  const message = env.emitted.find((m) => m.type === 'tick' && m.payload?.source === 'shared-worker');
  assert.ok(message, 'the worker port must feed a realtime quote into the bridge');
  assert.equal(message.payload.mint, mint);
  assert.equal(message.payload.candidates[0].value, 0.00001234);
  assert.equal(message.payload.candidates[0].unit, 'usd');
});

test('non-GMGN sites keep their native SharedWorker untouched', () => {
  // The tap has a side effect on an object the host owns (port.start()), and
  // GMGN is the only audited site whose feed rides a SharedWorker — on Padre
  // the wrapper must not install at all (Turbo per-site tap scope).
  const env = runBridge(); // padre href
  const worker = new env.win.SharedWorker('padre-worker.js');
  worker.port.emit({ token: { priceUsd: '0.00001234', mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' } });

  assert.ok(!env.emitted.some((m) => m.type === 'tick' && m.payload?.source === 'shared-worker'),
    'no bridge listener may ride a non-GMGN SharedWorker port');
});
