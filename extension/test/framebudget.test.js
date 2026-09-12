/* Frame-parse budgets (v3.23.0, September list-freeze family).
 *
 * A 20k-node allowance still blows the frame on slow machines when every
 * node is small, and the 10 ms x 500 boot poll probed React fibers and
 * iframes on list pages that never grow a widget. The walk now also stops
 * after a few ms of main-thread time, the boot poll backs off
 * exponentially, and the XHR tap never reads a body with no consumer.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const BRIDGE = fs.readFileSync(path.join(ROOT, 'price-bridge.js'), 'utf8');

function runBridge(body, dateImpl) {
  const timers = [];
  const emitted = [];
  const listeners = {};
  const responseBody = JSON.stringify(body);
  const win = {
    fetch(url) {
      return Promise.resolve({
        url: String(url),
        headers: { get: () => 'application/json' },
        clone: () => ({ text: () => Promise.resolve(responseBody) }),
      });
    },
    XMLHttpRequest: function FakeXHR() {},
    WebSocket: function FakeWebSocket() {},
    SharedWorker: function FakeSharedWorker() {},
    EventSource: undefined,
    addEventListener(type, fn) { listeners[type] = fn; },
    postMessage(message) { emitted.push(message); },
  };
  win.XMLHttpRequest.prototype.send = function () {};
  win.XMLHttpRequest.prototype.addEventListener = function () {};
  win.WebSocket.prototype.addEventListener = function () {};
  win.SharedWorker.prototype.port = { addEventListener() {}, start() {} };
  win.window = win;
  const FakeDate = dateImpl || Date;
  const sandbox = {
    window: win,
    location: { href: 'https://gmgn.ai/sol/token/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', hostname: 'gmgn.ai' },
    console,
    Date: FakeDate, Math, Number, String, Array, Object, Boolean, RegExp, Error,
    Set, WeakSet, Symbol, JSON, Promise, isFinite,
    setInterval(fn) { timers.push(fn); return timers.length; },
    clearInterval() {},
    setTimeout(fn) { fn(); return 1; },
  };
  const ctx = vm.createContext(sandbox);
  vm.runInContext(BRIDGE, ctx, { filename: 'price-bridge.js' });
  for (const fn of timers.slice()) fn();
  return {
    emitted,
    sendContent(type, payload) {
      listeners.message({
        source: win,
        data: { source: 'papertrench-content', type, payload },
      });
    },
    async fetch() {
      await win.fetch('https://gmgn.ai/api/frame');
      for (let i = 0; i < 10; i++) await Promise.resolve();
    },
  };
}

// 400 filler nodes plus the watched target LAST: far under NODE_BUDGET
// (20k), so only the wall-clock budget can stop the walk short of the
// target — and far under the 8 ms budget on a healthy machine, so the
// full walk always reaches the end.
const TARGET_MINT = 'TARGET11111111111111111111111111111111';
function bigFrame(n = 400) {
  const tokens = [];
  for (let i = 0; i < n; i++) {
    // Valid base58 (no 0/O/I/L): each node must open a real record.
    tokens.push({
      mint: 'MNT' + String(i).padStart(29, '1'),
      priceUsd: 0.001 + i * 1e-9,
      symbol: 'T' + i,
    });
  }
  tokens.push({ mint: TARGET_MINT, priceUsd: 0.5, symbol: 'TARGET' });
  return { tokens };
}
test('a slow-machine walk truncates by wall clock, not just node count', async () => {
  // Frozen clock: reachability must not depend on how loaded the machine
  // is (under a full suite the real clock blows the budget on its own).
  function FrozenDate() {}
  FrozenDate.now = () => 1000000;
  const full = runBridge(bigFrame(), FrozenDate);
  full.sendContent('paper-axis', { mint: TARGET_MINT, pairAddress: null, symbol: 'TARGET' });
  await full.fetch();
  const fullHit = full.emitted.some((m) => m.type === 'tick' && m.payload.mint === TARGET_MINT);
  assert.ok(fullHit, 'the full walk must reach the watched record at the end of the frame');

  let calls = 0;
  function JumpingDate() {}
  JumpingDate.now = () => (calls += 1) * 10; // every clock read jumps 10 ms
  const slow = runBridge(bigFrame(), JumpingDate);
  slow.sendContent('paper-axis', { mint: TARGET_MINT, pairAddress: null, symbol: 'TARGET' });
  await slow.fetch();
  const slowHit = slow.emitted.some((m) => m.type === 'tick' && m.payload.mint === TARGET_MINT);
  assert.equal(slowHit, false,
    'the wall-clock budget must truncate the walk before the last record — never grind the frame');
});

test('the boot widget poll backs off instead of hammering at 10 ms', () => {
  assert.doesNotMatch(BRIDGE, /setInterval\(\(\) => \{\s*\n\s*fastChecks \+= 1;/,
    'the fixed 10 ms x 500 fiber/iframe hammer is gone');
  assert.match(BRIDGE, /fastChecks >= 14/,
    'boot discovery stops after a bounded number of probes');
  assert.match(BRIDGE, /fastMs = Math\.min\(1000, Math\.round\(fastMs \* 1\.5\)\)/,
    'probes back off exponentially, dense early for the subscribeBars race');
});

test('the XHR tap never reads a body with no tick consumer', () => {
  const at = BRIDGE.indexOf('XHR.prototype.send = function (body)');
  assert.ok(at > 0, 'the XHR tap must exist');
  const body = BRIDGE.slice(at, BRIDGE.indexOf('};', at) + 2);
  const gate = body.indexOf('if (!feedActive()) return;');
  const read = body.indexOf('this.responseText');
  assert.ok(gate >= 0 && read > gate,
    'feedActive() must gate BEFORE responseText materializes the body (fetch-tap parity)');
});
