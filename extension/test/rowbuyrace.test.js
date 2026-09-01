/* Regression harness for the two independent row-buy entry paths.
 *
 * The test boots the shipped content script with a deferred identity lookup
 * for the clicked row. That leaves its real doRowBuy path in flight while a
 * board tick wakes the armed-row path for another token.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const CONTENT = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
const ENGINE = fs.readFileSync(path.join(ROOT, 'engine.js'), 'utf8');

const A = 'A'.repeat(32);
const B = 'B'.repeat(32);

function bootRace() {
  let clock = Date.now();
  class HarnessDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }
  const listeners = new Map();
  const storage = {};
  let bIdentityPending = true;
  let bIdentityRequested = false;
  let releaseBIdentity;
  const bIdentity = new Promise((resolve) => { releaseBIdentity = resolve; });
  const messages = [];
  let settings;
  let initialState;

  const win = {
    PaperEngine: null,
    PaperQuote: {
      STALE_AFTER_MS: 60_000,
      positionRows: () => [],
      portfolioSummary: () => ({ up: false }),
    },
    PaperTrenchSites: {},
    PaperTrenchResolver: {},
    PTChartMarkers: {},
    PTTitleFeed: {},
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener() {},
    postMessage() {},
    location: {
      href: 'https://axiom.trade/pulse',
      hostname: 'axiom.trade',
      pathname: '/pulse',
      search: '',
    },
  };

  function sendMessage(payload) {
    messages.push(payload);
    if (payload.type === 'pt_resolve') {
      if (payload.address === B) {
        return Promise.resolve({
          mint: B,
          pairAddress: null,
          symbol: 'B',
          name: 'Token B',
          priceNative: 1,
          priceUsd: 100,
          mcap: 100_000,
          priceSource: 'resolver',
        });
      }
      return Promise.resolve(null);
    }
    if (payload.type === 'pt_onchain_prewatch') {
      const address = payload.mint || payload.pool;
      if (address === B) {
        bIdentityRequested = true;
        return bIdentityPending ? bIdentity : Promise.resolve({ mint: B });
      }
      if (address === A) return Promise.resolve({ mint: A });
      return Promise.resolve(null);
    }
    if (payload.type === 'pt_sol_usd') return Promise.resolve(100);
    if (payload.type === 'pt_state_commit') return Promise.resolve({ ok: true });
    if (payload.type === 'pt_attest_append') return Promise.resolve({ ok: true });
    return Promise.resolve({});
  }

  const document = {
    readyState: 'loading',
    hidden: false,
    body: null,
    documentElement: {},
    addEventListener(type, fn) {
      if (!listeners.has(`document:${type}`)) listeners.set(`document:${type}`, []);
      listeners.get(`document:${type}`).push(fn);
    },
    removeEventListener() {},
    createElement: () => ({
      style: {},
      classList: { add() {}, remove() {}, toggle() {} },
      appendChild() {},
      addEventListener() {},
    }),
    querySelector: () => null,
    querySelectorAll: () => [],
  };

  const chrome = {
    runtime: {
      id: 'papertrench-test',
      lastError: null,
      sendMessage,
      onMessage: { addListener() {} },
    },
    storage: {
      local: {
        get(keys, callback) {
          const out = {};
          for (const key of (Array.isArray(keys) ? keys : [keys])) {
            if (key in storage) out[key] = storage[key];
          }
          callback(out);
        },
        set(values, callback) {
          Object.assign(storage, values);
          if (callback) callback();
        },
      },
      onChanged: { addListener() {}, removeListener() {} },
    },
  };

  const sandbox = {
    window: win,
    self: win,
    document,
    location: win.location,
    chrome,
    console,
    URL,
    URLSearchParams,
    Promise,
    JSON,
    Math,
    Date: HarnessDate,
    Number,
    String,
    Array,
    Object,
    Boolean,
    RegExp,
    Error,
    Set,
    Map,
    WeakSet,
    WeakMap,
    Infinity,
    NaN,
    parseInt,
    parseFloat,
    isNaN,
    AbortController: function () { this.signal = {}; this.abort = () => {}; },
    MutationObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
    ResizeObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
    NodeFilter: { SHOW_TEXT: 4 },
    fetch: () => Promise.resolve({ ok: false, status: 404, json: async () => ({}) }),
    setTimeout: () => 1,
    clearTimeout() {},
    setInterval: () => 1,
    clearInterval() {},
    requestAnimationFrame: (fn) => { fn(); return 1; },
    cancelAnimationFrame() {},
    performance: { now: () => 1 },
  };
  vm.createContext(sandbox);
  vm.runInContext(ENGINE, sandbox, { filename: 'engine.js' });
  win.PaperEngine = sandbox.window.PaperEngine;
  settings = win.PaperEngine.defaultSettings();
  settings.balanceStartSol = 100;
  initialState = win.PaperEngine.defaultState(settings);
  storage.pt_state = initialState;
  storage.pt_settings = settings;

  const end = CONTENT.lastIndexOf('\n})();');
  assert.ok(end > 0, 'content script has its IIFE terminator');
  const instrumented = CONTENT.slice(0, end)
    + `
  window.__rowHarness = {
    doRowBuy,
    noteRowPrice,
    flushRowArmed,
    getState: () => state,
    setSite: (next) => { site = next; },
    getRowArmed: () => rowArmed,
    getRowArmedFlushing: () => rowArmedFlushing,
  };
`
    + CONTENT.slice(end);
  vm.runInContext(instrumented, sandbox, { filename: 'content.js' });
  const harness = sandbox.window.__rowHarness;
  harness.setSite({ id: 'axiom', rowBuy: { kind: 'pair' } });

  return {
    harness,
    storage,
    isBIdentityRequested: () => bIdentityRequested,
    releaseB() {
      bIdentityPending = false;
      releaseBIdentity({ mint: B });
    },
    messages,
    setNow(next) { clock = next; },
  };
}

async function waitFor(predicate) {
  for (let i = 0; i < 2000; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  assert.fail('timed out waiting for the row-buy harness');
}

test('an armed row fill defers behind a different clicked row fill', async () => {
  const race = bootRace();
  const { harness } = race;

  // Drive A through the real cascade miss so it arms rather than touching
  // the closure's rowArmed state directly.
  const arm = harness.doRowBuy(A);
  await arm;
  assert.ok(harness.getRowArmed(), 'A should remain armed after an unpriced click');

  // B has a price, but its identity lookup is intentionally held open. This
  // is the in-flight window in which the board tick for A can wake its flush.
  const clickB = harness.doRowBuy(B);
  await waitFor(() => race.isBIdentityRequested());
  assert.equal(race.isBIdentityRequested(), true, 'B should be mid-fill before the tick');

  harness.noteRowPrice({
    mint: A,
    candidates: [{ unit: 'usd', value: 100 }],
    symbol: 'A',
    name: 'Token A',
  });
  await waitFor(() => harness.getRowArmedFlushing());
  await waitFor(() => !harness.getRowArmedFlushing());

  const midJournal = Array.from(harness.getState().journal, (trade) => trade.mint);
  assert.deepEqual(midJournal, [],
    'the armed A fill stays deferred while clicked B is still in flight');
  assert.ok(harness.getRowArmed(), 'the deferred A intent must remain armed');

  race.releaseB();
  await clickB;
  assert.deepEqual(Array.from(harness.getState().journal, (trade) => trade.mint), [B],
    'the direct B intent commits exactly once');

  // The next board wake retries the still-armed intent after the direct
  // commit releases the shared latch.
  harness.noteRowPrice({
    mint: A,
    candidates: [{ unit: 'usd', value: 100 }],
    symbol: 'A',
    name: 'Token A',
  });
  await waitFor(() => harness.getState().journal.length === 2);
  assert.deepEqual(Array.from(harness.getState().journal, (trade) => trade.mint), [A, B],
    'the deferred A intent commits exactly once on a later wake');
});

test('an armed row fill commits on its first available price without competition', async () => {
  const race = bootRace();
  const { harness } = race;

  await harness.doRowBuy(A);
  assert.ok(harness.getRowArmed(), 'A should arm when its cascade cannot price');
  harness.noteRowPrice({
    mint: A,
    candidates: [{ unit: 'usd', value: 100 }],
    symbol: 'A',
    name: 'Token A',
  });
  await waitFor(() => harness.getState().journal.length === 1 && !harness.getRowArmed());

  assert.deepEqual(Array.from(harness.getState().journal, (trade) => trade.mint), [A]);
  assert.equal(harness.getRowArmed(), null, 'a successful armed fill clears its intent');
});

test('a priced row click still commits without an armed intent', async () => {
  const race = bootRace();
  const { harness } = race;

  const clickB = harness.doRowBuy(B);
  await waitFor(() => race.isBIdentityRequested());
  race.releaseB();
  await clickB;
  await waitFor(() => harness.getState().journal.length === 1);

  assert.deepEqual(Array.from(harness.getState().journal, (trade) => trade.mint), [B]);
  assert.equal(harness.getRowArmed(), null, 'a priced click does not create an armed intent');
});

test('a row buy still expires at its existing TTL', async () => {
  const race = bootRace();
  const { harness } = race;

  await harness.doRowBuy(A);
  const armedAt = harness.getRowArmed().at;
  race.setNow(armedAt + 60_001);
  await harness.flushRowArmed();

  assert.equal(harness.getRowArmed(), null, 'an expired armed intent is cleared');
  assert.equal(harness.getState().journal.length, 0, 'an expired intent does not fill');
});
