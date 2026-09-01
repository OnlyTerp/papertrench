/* Extension-context invalidation.
 *
 * Reloading or updating the extension kills the content script's context, but
 * the already-injected copy keeps running in the page. Reported symptom:
 *
 *   Uncaught (in promise) Error: Extension context invalidated.
 *   content.js:66
 *
 * ...repeating, with the page visibly flashing. The cause was that this script
 * is driven by several timers (100ms heartbeat, 250ms fast retry, 800ms detect,
 * 1s positions bar); each tick called chrome.storage and produced a fresh
 * rejection, while renders kept running against a half-dead overlay.
 *
 * These tests drive the SHIPPED content.js and assert it shuts down exactly
 * once, silently, and removes its UI.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
global.window = global.window || {};
require('../engine.js');
const E = global.window.PaperEngine;

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

/**
 * Boot the real content script, then simulate the extension being reloaded by
 * dropping chrome.runtime.id and making every chrome API throw — which is
 * precisely what Chrome does to an orphaned content script.
 */
function runInvalidation() {
  const timers = [];
  let now = 9_000_000;
  const nodesById = {};
  let hostAttached = false;
  const rejections = [];
  const consoleErrors = [];
  let chromeCallsAfterKill = 0;
  let killed = false;

  function makeNode(tag) {
    const node = {
      tag, style: { setProperty() {}, removeProperty() {} }, dataset: {},
      children: [], childNodes: [], _fields: {},
      classList: {
        _s: new Set(),
        add(...c) { c.forEach((x) => this._s.add(x)); },
        remove(...c) { c.forEach((x) => this._s.delete(x)); },
        toggle(c, on) { if (on === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else if (on) this._s.add(c); else this._s.delete(c); },
        contains(c) { return this._s.has(c); },
      },
      set textContent(v) { this._t = v; },
      get textContent() { return this._t || ''; },
      set innerHTML(v) { this._h = v; },
      get innerHTML() { return this._h || ''; },
      appendChild(c) { this.children.push(c); this.childNodes = this.children; if (c && c.id === 'papertrench-host') hostAttached = true; return c; },
      removeChild() {}, remove() { if (this.id === 'papertrench-host') hostAttached = false; },
      setAttribute() {}, getAttribute() { return null; },
      addEventListener() {}, removeEventListener() {},
      querySelector() { return makeNode('span'); }, querySelectorAll() { return []; },
      getBoundingClientRect() { return { top: 0, right: 0, width: 0 }; },
      attachShadow() { return shadowRoot; },
      focus() {}, closest() { return null; },
      get offsetWidth() { return 1; },
    };
    return node;
  }

  const shadowRoot = {
    set innerHTML(v) { this._h = v; }, get innerHTML() { return this._h || ''; },
    getElementById(id) { if (!nodesById[id]) nodesById[id] = makeNode('div'); return nodesById[id]; },
    querySelector() { return makeNode('div'); }, querySelectorAll() { return []; }, appendChild() {},
  };

  const doc = {
    readyState: 'complete', hidden: false, title: 'x',
    body: Object.assign(makeNode('body'), { innerText: '' }),
    documentElement: makeNode('html'), head: makeNode('head'),
    createElement: (t) => makeNode(t),
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    elementFromPoint: () => null,
    addEventListener: () => {}, createTreeWalker: () => ({ nextNode: () => null }),
  };

  const url = `https://trade.padre.gg/trade/solana/${MINT}`;
  const win = {
    addEventListener: () => {}, removeEventListener: () => {}, postMessage: () => {},
    location: { href: url, hostname: 'trade.padre.gg', pathname: `/trade/solana/${MINT}`, search: '' },
    getComputedStyle: () => ({ right: '18px', top: '84px' }),
    confirm: () => false,
  };
  win.window = win;

  const storage = { pt_settings: E.defaultSettings() };

  /** Any chrome API touched after the reload behaves exactly as Chrome's does. */
  function guardKilled() {
    if (!killed) return false;
    chromeCallsAfterKill += 1;
    throw new Error('Extension context invalidated.');
  }

  const chromeStub = {
    runtime: {
      id: 'papertrench-test',
      getURL: (p) => 'chrome-extension://x/' + p,
      sendMessage: (...args) => { guardKilled(); return Promise.resolve({}); },
      onMessage: { addListener: () => {} },
      openOptionsPage: () => { guardKilled(); },
      lastError: null,
    },
    storage: {
      local: {
        get: (keys, cb) => {
          guardKilled();
          const out = {};
          for (const k of (Array.isArray(keys) ? keys : [keys])) if (k in storage) out[k] = storage[k];
          if (cb) cb(out);
          return Promise.resolve(out);
        },
        set: (obj, cb) => { guardKilled(); Object.assign(storage, obj); if (cb) cb(); return Promise.resolve(); },
      },
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
    tabs: { query: () => Promise.resolve([{ id: 1 }]), sendMessage: () => Promise.resolve() },
  };

  const sandbox = {
    window: win, self: win, document: doc, location: win.location,
    console: {
      log: () => {}, warn: () => {}, info: () => {},
      error: (...a) => consoleErrors.push(a.join(' ')),
    },
    URLSearchParams, URL,
    AbortController: function () { this.signal = {}; this.abort = () => {}; },
    MutationObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
    TextDecoder: function () { this.decode = () => ''; },
    ResizeObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
    Set, Map, WeakSet, WeakMap, Promise, JSON, Math, Number, String, Array, Object,
    Boolean, RegExp, Error, isNaN, parseInt, parseFloat, Infinity, NaN,
    Date: Object.assign(function () {}, { now: () => now, parse: Date.parse }),
    setTimeout: (fn, ms) => { timers.push({ fn, at: now + (ms || 0) }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].dead = true; },
    setInterval: (fn, ms) => { timers.push({ fn, at: now + ms, every: ms }); return timers.length; },
    clearInterval: (id) => { if (timers[id - 1]) timers[id - 1].dead = true; },
    fetch: () => Promise.resolve({
      ok: true, status: 200,
      json: async () => ({
        pair: {
          chainId: 'solana', pairAddress: 'PAIR1',
          baseToken: { address: MINT, symbol: 'BONK', name: 'Bonk' },
          quoteToken: { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL' },
          priceNative: '0.000001', priceUsd: '0.0002',
          liquidity: { usd: 500000 }, marketCap: 1e8,
        },
      }),
    }),
    chrome: chromeStub,
    NodeFilter: { SHOW_TEXT: 4 },
  };

  const ctx = vm.createContext(sandbox);
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const entry = manifest.content_scripts.find((cs) => (cs.js || []).includes('content.js'));
  for (const f of entry.js) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
  }

  async function advance(ms, step) {
    step = step || 100;
    for (let e = 0; e < ms; e += step) {
      now += step;
      for (let i = 0; i < timers.length; i++) {
        const t = timers[i];
        if (t.dead || t.at > now) continue;
        if (t.every) t.at = now + t.every; else t.dead = true;
        // An unguarded timer body throwing IS the reported bug.
        try { t.fn(); } catch (err) { rejections.push(String(err && err.message)); }
      }
      for (let k = 0; k < 8; k++) await Promise.resolve();
    }
  }

  return {
    advance,
    /** Drive the shipped store.get() the way an in-flight await would. */
    callStoreDirectly: async () => {
      const errs = [];
      try {
        const fn = win.__ptStore || null;
        assert.ok(fn, 'the shipped store must be reachable for this test to mean anything');
        if (fn) await fn.get(['pt_state']);
      } catch (e) { errs.push(String(e && e.message)); }
      return errs;
    },
    /** Drive the shipped sendMessage() after the context dies. */
    callSendMessageDirectly: async () => {
      const errs = [];
      try {
        const fn = win.__ptSend || null;
        assert.ok(fn, 'the shipped sendMessage must be reachable for this test to mean anything');
        if (fn) await fn({ type: 'pt_open_dashboard' });
      } catch (e) { errs.push(String(e && e.message)); }
      return errs;
    },
    /** Simulate the extension being reloaded / updated. */
    killExtension: () => { killed = true; chromeStub.runtime.id = undefined; },
    rejections: () => rejections,
    consoleErrors: () => consoleErrors,
    chromeCallsAfterKill: () => chromeCallsAfterKill,
    hostAttached: () => hostAttached,
    liveTimers: () => timers.filter((t) => !t.dead && t.every).length,
  };
}

test('an invalidated context produces no repeating errors', async () => {
  const ov = runInvalidation();
  await ov.advance(2000);                 // normal operation
  const before = ov.rejections().length;

  ov.killExtension();                     // user reloads the extension
  await ov.advance(6000);                 // many timer ticks would have fired

  const after = ov.rejections().length - before;
  assert.equal(after, 0,
    `a dead context must not throw on every tick; got ${after} errors ` +
    `(${ov.rejections().slice(0, 3).join(' | ')})`);
  assert.equal(ov.consoleErrors().length, 0,
    'shutdown must be quiet, not an error storm in the page console');
});

test('the overlay removes itself from the page instead of thrashing', async () => {
  const ov = runInvalidation();
  await ov.advance(2000);
  assert.equal(ov.hostAttached(), true, 'the overlay must be mounted while healthy');

  ov.killExtension();
  await ov.advance(3000);

  assert.equal(ov.hostAttached(), false,
    'an orphaned overlay must remove itself rather than keep re-rendering');
});

test('every recurring timer stops after invalidation', async () => {
  const ov = runInvalidation();
  await ov.advance(2000);
  assert.ok(ov.liveTimers() > 0, 'timers must be running while healthy');

  ov.killExtension();
  await ov.advance(4000);

  assert.equal(ov.liveTimers(), 0,
    'leaving intervals alive is what made the page flash; all must be cleared');
});

test('chrome APIs are not touched again once the context is gone', async () => {
  const ov = runInvalidation();
  await ov.advance(2000);

  ov.killExtension();
  await ov.advance(6000);

  // One probe as the shutdown is detected is acceptable; a storm is not.
  assert.ok(ov.chromeCallsAfterKill() <= 1,
    `a dead context must be detected and then left alone; got ` +
    `${ov.chromeCallsAfterKill()} chrome calls after the reload`);
});

test('the extension works normally while the context is alive', async () => {
  const ov = runInvalidation();
  await ov.advance(3000);

  assert.equal(ov.hostAttached(), true, 'the overlay must mount and stay mounted');
  assert.equal(ov.rejections().length, 0, 'healthy operation must not throw');
  assert.ok(ov.liveTimers() > 0, 'the heartbeat must keep running');
});

test('a trade committed as the extension dies fails quietly, not into the console', async () => {
  // The dangerous path: an async operation already in flight when the context
  // dies still reaches chrome.storage. The managed timers cannot help here,
  // so store/sendMessage must fail soft on their own.
  const ov = runInvalidation();
  await ov.advance(2000);

  ov.killExtension();
  const errors = await ov.callStoreDirectly();

  assert.equal(errors.length, 0,
    `an in-flight storage call must not reject into the page; got: ${errors.join(' | ')}`);
});

test('messaging the background after a reload never rejects', async () => {
  const ov = runInvalidation();
  await ov.advance(2000);

  ov.killExtension();
  const errors = await ov.callSendMessageDirectly();

  assert.equal(errors.length, 0,
    `sendMessage must swallow a dead context; got: ${errors.join(' | ')}`);
});
