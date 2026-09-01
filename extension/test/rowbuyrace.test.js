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
const QUOTE = fs.readFileSync(path.join(ROOT, 'quote.js'), 'utf8');
const SITES = fs.readFileSync(path.join(ROOT, 'sites.js'), 'utf8');

const A = 'A'.repeat(32);
const B = 'B'.repeat(32);
const C = 'C'.repeat(32);
const PAIR = 'P'.repeat(32);

function bootRace(options = {}) {
  let clock = Date.now();
  class HarnessDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])); }
    static now() { return clock; }
  }
  const listeners = new Map();
  const timers = [];
  const storage = {};
  let bIdentityPending = true;
  let bIdentityRequested = false;
  let releaseBIdentity;
  const bIdentity = new Promise((resolve) => { releaseBIdentity = resolve; });
  let cIdentityPending = true;
  let cIdentityRequested = false;
  let releaseCIdentity;
  const cIdentity = new Promise((resolve) => { releaseCIdentity = resolve; });
  let aIdentityPending = options.holdAIdentity === true;
  let aIdentityRequested = false;
  let aIdentityRequestCount = 0;
  let releaseAIdentity;
  const aIdentity = new Promise((resolve) => { releaseAIdentity = resolve; });
  let pairIdentityPending = options.holdPairIdentity === true;
  let pairIdentityRequested = false;
  let releasePairIdentity;
  const pairIdentity = new Promise((resolve) => { releasePairIdentity = resolve; });
  let stateReadPending = false;
  let stateReadRequested = false;
  let releaseStateRead;
  const stateRead = new Promise((resolve) => { releaseStateRead = resolve; });
  let solUsdPending = options.holdSolUsd === true;
  let solUsdRequested = false;
  let releaseSolUsd;
  const solUsd = new Promise((resolve) => { releaseSolUsd = resolve; });
  const messages = [];
  let settings;
  let initialState;

  function scheduleTimer(fn, ms, every) {
    timers.push({ fn, at: clock + (ms || 0), every: every || 0, dead: false });
    return timers.length;
  }

  function clearTimer(id) {
    if (timers[id - 1]) timers[id - 1].dead = true;
  }

  async function advance(ms, step) {
    step = step || 100;
    for (let left = ms; left > 0; left -= step) {
      clock += Math.min(step, left);
      for (const timer of timers) {
        if (timer.dead || timer.at > clock) continue;
        if (timer.every) timer.at = clock + timer.every;
        else timer.dead = true;
        timer.fn();
      }
      for (let i = 0; i < 8; i++) await Promise.resolve();
    }
  }

  const nodesById = {};
  function makeNode(tag) {
    return {
      tag,
      id: '',
      style: { setProperty() {}, removeProperty() {} },
      dataset: {},
      className: '',
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      children: [],
      get childNodes() { return this.children; },
      appendChild(child) { this.children.push(child); return child; },
      querySelector() { return makeNode('div'); },
      querySelectorAll() { return []; },
      remove() {},
      addEventListener() {},
      removeEventListener() {},
      setAttribute() {},
      getAttribute() { return null; },
      getBoundingClientRect() { return { top: 0, left: 0, right: 0, width: 0, height: 0 }; },
      attachShadow() { return shadowRoot; },
      focus() {},
      set innerHTML(value) { this._html = value; },
      get innerHTML() { return this._html || ''; },
      textContent: '',
      offsetWidth: 1,
    };
  }
  const shadowRoot = {
    set innerHTML(value) { this._html = value; },
    get innerHTML() { return this._html || ''; },
    getElementById(id) {
      if (!nodesById[id]) nodesById[id] = makeNode('div');
      return nodesById[id];
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    appendChild() {},
  };

  const win = {
    PaperEngine: null,
    PaperQuote: {
      STALE_AFTER_MS: 60_000,
      positionRows: () => [],
      portfolioSummary: () => ({ up: false }),
    },
    PaperTrenchSites: {},
    PaperTrenchResolver: {},
    PTChartMarkers: { destroyChartMarkers() {} },
    PTTitleFeed: {},
    innerWidth: 1400,
    innerHeight: 1050,
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
        if (options.unpricedB) return Promise.resolve(null);
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
      if (payload.address === C) {
        return Promise.resolve({
          mint: C,
          pairAddress: null,
          symbol: 'C',
          name: 'Token C',
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
      if (address === C) {
        cIdentityRequested = true;
        return cIdentityPending ? cIdentity : Promise.resolve({ mint: C });
      }
      if (address === A) {
        aIdentityRequested = true;
        aIdentityRequestCount += 1;
        return aIdentityPending ? aIdentity : Promise.resolve({ mint: A });
      }
      if (address === PAIR) {
        pairIdentityRequested = true;
        return pairIdentityPending ? pairIdentity : Promise.resolve({ mint: B, pool: PAIR });
      }
      return Promise.resolve(null);
    }
    if (payload.type === 'pt_sol_usd') {
      solUsdRequested = true;
      if (options.solUsdFails) return Promise.reject(new Error('rate unavailable'));
      return solUsdPending ? solUsd : Promise.resolve(100);
    }
    if (payload.type === 'pt_state_commit') return Promise.resolve({ ok: true });
    if (payload.type === 'pt_attest_append') return Promise.resolve({ ok: true });
    return Promise.resolve({});
  }

  const document = {
    readyState: 'loading',
    hidden: false,
    body: makeNode('body'),
    documentElement: {},
    addEventListener(type, fn) {
      if (!listeners.has(`document:${type}`)) listeners.set(`document:${type}`, []);
      listeners.get(`document:${type}`).push(fn);
    },
    removeEventListener() {},
    createElement: (tag) => makeNode(tag),
    getElementById: () => null,
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
          const requestedKeys = Array.isArray(keys) ? keys : [keys];
          if (stateReadPending && requestedKeys.includes('pt_state')) {
            stateReadRequested = true;
            stateRead.then(() => {
              const out = {};
              for (const key of requestedKeys) {
                if (key in storage) out[key] = storage[key];
              }
              callback(out);
            });
            return;
          }
          const out = {};
          for (const key of requestedKeys) {
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
    setTimeout: (fn, ms) => scheduleTimer(fn, ms),
    clearTimeout: clearTimer,
    setInterval: (fn, ms) => scheduleTimer(fn, ms, ms),
    clearInterval: clearTimer,
    requestAnimationFrame: (fn) => { fn(); return 1; },
    cancelAnimationFrame() {},
    performance: { now: () => 1 },
  };
  vm.createContext(sandbox);
  vm.runInContext(ENGINE, sandbox, { filename: 'engine.js' });
  vm.runInContext(QUOTE, sandbox, { filename: 'quote.js' });
  vm.runInContext(SITES, sandbox, { filename: 'sites.js' });
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
    enableOverlay,
    getState: () => state,
    setSite: (next) => { site = next; },
    getRowArmed: () => rowArmed,
    getRowArmedFlushing: () => rowArmedFlushing,
    getRowBuyInFlight: () => rowBuyInFlight,
    getRowBuyInFlightAt: () => rowBuyInFlightAt,
    getRowBuyOwner: () => rowBuyOwner,
    getRowArmedFlushTimer: () => rowArmedFlushTimer,
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
    isCIdentityRequested: () => cIdentityRequested,
    isAIdentityRequested: () => aIdentityRequested,
    getAIdentityRequestCount: () => aIdentityRequestCount,
    releaseAIdentity() {
      aIdentityPending = false;
      releaseAIdentity({ mint: A });
    },
    setHoldAIdentity(value) { aIdentityPending = value; },
    isPairIdentityRequested: () => pairIdentityRequested,
    releasePairIdentity() {
      pairIdentityPending = false;
      releasePairIdentity({ mint: B, pool: PAIR });
    },
    isStateReadRequested: () => stateReadRequested,
    setHoldStateRead(value) { stateReadPending = value; },
    releaseStateRead() {
      stateReadPending = false;
      releaseStateRead();
    },
    releaseB() {
      bIdentityPending = false;
      releaseBIdentity({ mint: B });
    },
    releaseC() {
      cIdentityPending = false;
      releaseCIdentity({ mint: C });
    },
    isSolUsdRequested: () => solUsdRequested,
    releaseSolUsd() {
      solUsdPending = false;
      releaseSolUsd(100);
    },
    messages,
    setNow(next) { clock = next; },
    advance,
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

test('a newer armed intent survives an older flush commit', async () => {
  const race = bootRace({ unpricedB: true, holdSolUsd: true });
  const { harness } = race;

  await harness.doRowBuy(A);
  const firstIntent = harness.getRowArmed();
  assert.ok(firstIntent, 'A should arm when its cascade cannot price');

  harness.noteRowPrice({
    mint: A,
    candidates: [{ unit: 'usd', value: 100 }],
    symbol: 'A',
    name: 'Token A',
  });
  await waitFor(() => race.isSolUsdRequested());
  assert.equal(harness.getRowArmedFlushing(), true, 'A should be flushing its newly available price');

  race.releaseB();
  await harness.doRowBuy(B);
  const secondIntent = harness.getRowArmed();
  assert.ok(secondIntent, 'B should arm after its own cascade misses');
  assert.notEqual(secondIntent, firstIntent, 'each unpriced click gets a fresh intent object');
  assert.equal(
    race.messages.filter((message) => message.type === 'pt_armed_row_arm').length,
    2,
    'the service worker receives both armed intents',
  );

  race.releaseSolUsd();
  await waitFor(() => harness.getState().journal.length === 1);
  await waitFor(() => !harness.getRowArmedFlushing());
  assert.deepEqual(Array.from(harness.getState().journal, (trade) => trade.mint), [A]);
  assert.equal(harness.getRowArmed(), secondIntent,
    'the older A flush cannot discard newer B');
  assert.equal(
    race.messages.filter((message) => message.type === 'pt_armed_row_clear').length,
    0,
    'the older flush cannot clear B from the service worker',
  );
  assert.ok(harness.getRowArmedFlushTimer(),
    'the repeating armed flush remains alive for B');

  harness.noteRowPrice({
    mint: B,
    candidates: [{ unit: 'usd', value: 100 }],
    symbol: 'B',
    name: 'Token B',
  });
  await waitFor(() => harness.getState().journal.length === 2);
  assert.deepEqual(Array.from(harness.getState().journal, (trade) => trade.mint), [B, A],
    'the newer B intent subsequently commits exactly once');
  await waitFor(() => harness.getRowArmed() === null);
  assert.equal(harness.getRowArmed(), null, 'B clears only after its own successful fill');
  assert.equal(
    race.messages.filter((message) => message.type === 'pt_armed_row_clear').length,
    1,
    'the service worker mirror clears once for the filled B intent',
  );
});

test('a timed-out row buy cannot release a newer latch owner', async () => {
  const race = bootRace();
  const { harness } = race;

  const first = harness.doRowBuy(B);
  await waitFor(() => race.isBIdentityRequested());
  const firstAt = harness.getRowBuyInFlightAt();
  const firstOwner = harness.getRowBuyOwner();

  await harness.enableOverlay();
  race.setNow(firstAt + 20_001);
  await race.advance(1);
  assert.equal(harness.getRowBuyInFlight(), false,
    'the bar watchdog releases a buy that exceeds the latch age');
  assert.notEqual(harness.getRowBuyOwner(), firstOwner,
    'the watchdog supersedes the timed-out operation');

  const second = harness.doRowBuy(C);
  await waitFor(() => race.isCIdentityRequested());
  const secondOwner = harness.getRowBuyOwner();
  assert.equal(harness.getRowBuyInFlight(), true, 'the second buy acquires the freed latch');
  assert.notEqual(secondOwner, firstOwner, 'the second buy has a new generation');

  race.releaseB();
  await first;
  assert.equal(harness.getRowBuyInFlight(), true,
    'the first buy finishing cannot clear the second buy latch');
  assert.equal(harness.getRowBuyOwner(), secondOwner,
    'the second buy remains the latch owner');

  await harness.doRowBuy(A);
  assert.equal(harness.getRowBuyInFlight(), true,
    'a third click is refused while the second buy remains in flight');
  assert.equal(harness.getRowBuyOwner(), secondOwner,
    'the refused third click cannot take ownership');
  assert.deepEqual(Array.from(harness.getState().journal, (trade) => trade.mint), [],
    'the superseded first operation never commits alongside the newer owner');

  race.releaseC();
  await second;
  assert.deepEqual(Array.from(harness.getState().journal, (trade) => trade.mint), [C],
    'only the non-superseded operation commits');
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

test('a fresh Padre row tick wins before the resolver and carries its cap', async () => {
  const race = bootRace();
  const { harness } = race;

  harness.noteRowPrice({
    mint: B,
    candidates: [{ unit: 'usd', value: 0.0032 }],
    mcap: 3200,
    symbol: 'B',
    name: 'Token B',
  });
  const buy = harness.doRowBuy(B);
  await waitFor(() => race.isBIdentityRequested());
  race.releaseB();
  await buy;

  assert.deepEqual(Array.from(harness.getState().journal, (trade) => trade.mint), [B]);
  assert.equal(harness.getState().journal[0].priceNative, 0.000032);
  assert.equal(harness.getState().journal[0].priceUsd, 0.0032);
  assert.equal(harness.getState().journal[0].mcap, 3200);
  assert.equal(
    race.messages.filter((message) => message.type === 'pt_resolve').length,
    0,
    'a fresh row tick skips resolver pricing',
  );
});

test('a stale Padre row tick falls through to the resolver cascade', async () => {
  const race = bootRace();
  const { harness } = race;

  harness.noteRowPrice({
    mint: B,
    candidates: [{ unit: 'usd', value: 0.0032 }],
    mcap: 3200,
  });
  race.setNow(Date.now() + 120_001);
  const buy = harness.doRowBuy(B);
  await waitFor(() => race.isBIdentityRequested());
  race.releaseB();
  await buy;

  assert.equal(
    race.messages.filter((message) => message.type === 'pt_resolve').length,
    1,
    'an expired row tick must use the existing resolver cascade',
  );
  assert.equal(harness.getState().journal[0].priceNative, 1);
  assert.equal(harness.getState().journal[0].mcap, 100_000);
});

test('a fresh row tick without SOL/USD falls through rather than guessing', async () => {
  const race = bootRace({ solUsdFails: true });
  const { harness } = race;

  harness.noteRowPrice({
    mint: B,
    candidates: [{ unit: 'usd', value: 0.0032 }],
    mcap: 3200,
  });
  const buy = harness.doRowBuy(B);
  await waitFor(() => race.isBIdentityRequested());
  race.releaseB();
  await buy;

  assert.equal(
    race.messages.filter((message) => message.type === 'pt_resolve').length,
    1,
    'without a conversion rate the row tick must fall through',
  );
  assert.equal(harness.getState().journal[0].priceNative, 0.000032);
  assert.ok(Math.abs(harness.getState().journal[0].mcap - 3.2) < 1e-9);
});

test('a row-props quote fills at the tapped price without resolver or identity lookup', async () => {
  const race = bootRace();
  const { harness } = race;

  await harness.doRowBuy(PAIR, null, {
    mint: B,
    pair: PAIR,
    priceSol: 0.000032,
    priceUsd: 0.0032,
    mcapUsd: 3200,
    supply: 100_000_000,
  });

  assert.deepEqual(Array.from(harness.getState().journal, (trade) => trade.mint), [B]);
  assert.equal(harness.getRowArmed(), null, 'a valid row-props quote never arms');
  assert.equal(
    race.messages.filter((message) => message.type === 'pt_resolve').length,
    0,
    'row-props pricing skips the resolver cascade',
  );
  assert.equal(
    race.messages.filter((message) => message.type === 'pt_onchain_prewatch').length,
    0,
    'an authoritative row-props mint skips identity probing',
  );
  assert.equal(harness.getState().journal[0].priceNative, 0.000032);
});

test('a USD-only GMGN row-props quote converts with the site rate', async () => {
  const race = bootRace();
  const { harness } = race;

  const buy = harness.doRowBuy(B, null, {
    mint: B,
    pair: PAIR,
    priceUsd: 0.0032,
    mcapUsd: 3200,
    supply: 1_000_000,
  });
  await waitFor(() => race.isBIdentityRequested());
  race.releaseB();
  await buy;

  assert.deepEqual(Array.from(harness.getState().journal, (trade) => trade.mint), [B]);
  assert.equal(harness.getState().journal[0].priceNative, 0.000032);
  assert.equal(
    race.messages.filter((message) => message.type === 'pt_resolve').length,
    0,
    'a reconciled GMGN quote skips the resolver cascade',
  );
});

test('a USD-only row-props quote without a SOL/USD rate falls back', async () => {
  const race = bootRace({ solUsdFails: true });
  const { harness } = race;

  const buy = harness.doRowBuy(B, null, {
    mint: B,
    pair: PAIR,
    priceUsd: 0.0032,
    mcapUsd: 3200,
    supply: 1_000_000,
  });
  await waitFor(() => race.isBIdentityRequested());
  race.releaseB();
  await buy;

  assert.deepEqual(Array.from(harness.getState().journal, (trade) => trade.mint), [B]);
  assert.equal(harness.getState().journal[0].priceNative, 1);
  assert.equal(
    race.messages.filter((message) => message.type === 'pt_resolve').length,
    1,
    'an unavailable conversion rate uses the resolver cascade',
  );
  assert.equal(harness.getRowArmed(), null, 'a quote with no conversion rate does not arm');
});

test('row-props validation has its own exact address check', () => {
  assert.match(CONTENT, /const ROW_ADDR_RE = \/\[1-9A-HJ-NP-Za-km-z\]\{32,44\}\//);
  assert.match(CONTENT, /const ROW_ADDR_EXACT_RE = \/\^\[1-9A-HJ-NP-Za-km-z\]\{32,44\}\$\//);
});

test('an invalid row-props identity falls back to the resolver', async () => {
  const race = bootRace();
  const { harness } = race;

  const buy = harness.doRowBuy(B, null, {
    mint: A,
    pair: PAIR,
    priceSol: 1,
    priceUsd: 100,
    mcapUsd: 100_000,
  });
  await waitFor(() => race.isBIdentityRequested());
  race.releaseB();
  await buy;

  assert.deepEqual(Array.from(harness.getState().journal, (trade) => trade.mint), [B],
    'a foreign row quote falls back to the tapped address');
  assert.equal(harness.getRowArmed(), null, 'a foreign row quote cannot arm');
  assert.equal(
    race.messages.filter((message) => message.type === 'pt_resolve').length,
    1,
    'a rejected row quote uses the resolver cascade',
  );
});

test('an inconsistent row-props SOL/USD rate falls back to the resolver', async () => {
  const race = bootRace();
  const { harness } = race;

  const buy = harness.doRowBuy(B, null, {
    mint: B,
    priceSol: 1,
    priceUsd: 1000,
  });
  await waitFor(() => race.isBIdentityRequested());
  race.releaseB();
  await buy;

  assert.deepEqual(Array.from(harness.getState().journal, (trade) => trade.mint), [B]);
  assert.equal(harness.getState().journal[0].priceNative, 1);
  assert.equal(
    race.messages.filter((message) => message.type === 'pt_resolve').length,
    1,
    'an inconsistent row quote is discarded before the resolver cascade',
  );
  assert.equal(harness.getRowArmed(), null);
});

test('a coherent row-props quote survives when SOL/USD lookup fails', async () => {
  const race = bootRace({ solUsdFails: true });
  const { harness } = race;

  await harness.doRowBuy(PAIR, null, {
    mint: B,
    pair: PAIR,
    priceSol: 0.000032,
    priceUsd: 0.0032,
  });

  assert.deepEqual(Array.from(harness.getState().journal, (trade) => trade.mint), [B]);
  assert.equal(harness.getState().journal[0].priceNative, 0.000032);
  assert.equal(
    race.messages.filter((message) => message.type === 'pt_resolve').length,
    0,
    'an unavailable SOL/USD rate does not force the resolver cascade',
  );
});

test('a pair-only row-props quote is repaired to the canonical mint', async () => {
  const race = bootRace();
  const { harness } = race;

  await harness.doRowBuy(PAIR, null, {
    pair: PAIR,
    priceSol: 0.000032,
  });

  assert.deepEqual(Array.from(harness.getState().journal, (trade) => trade.mint), [B]);
  assert.equal(
    race.messages.filter((message) => message.type === 'pt_onchain_prewatch').length,
    1,
    'a pair-only quote must perform the identity prewatch',
  );
});

test('a superseded direct row buy does not commit after watchdog release', async () => {
  const race = bootRace({ holdPairIdentity: true });
  const { harness } = race;

  const first = harness.doRowBuy(PAIR, null, {
    pair: PAIR,
    priceSol: 0.000032,
  });
  await waitFor(() => race.isPairIdentityRequested());
  race.releasePairIdentity();
  race.setHoldStateRead(true);
  await waitFor(() => race.isStateReadRequested());
  const startedAt = harness.getRowBuyInFlightAt();

  await harness.enableOverlay();
  race.setNow(startedAt + 20_001);
  await race.advance(1);
  const second = harness.doRowBuy(PAIR, null, {
    mint: B,
    pair: PAIR,
    priceSol: 0.000032,
  });
  await waitFor(() => harness.getRowBuyOwner() > 1);
  race.releaseStateRead();
  await second;
  await first;

  assert.deepEqual(Array.from(harness.getState().journal, (trade) => trade.mint), [B],
    'a watchdog-superseded direct operation must not commit');
  assert.equal(harness.getRowBuyInFlight(), false);
});

test('a superseded armed flush does not commit and stays armed', async () => {
  const race = bootRace();
  const { harness } = race;

  await harness.doRowBuy(A);
  assert.ok(harness.getRowArmed(), 'A should be armed before its retry');
  race.setHoldAIdentity(true);
  const aIdentityRequests = race.getAIdentityRequestCount();
  harness.noteRowPrice({
    mint: A,
    candidates: [{ unit: 'usd', value: 100 }],
    symbol: 'A',
    name: 'Token A',
  });
  await waitFor(() => race.getAIdentityRequestCount() > aIdentityRequests);
  const startedAt = harness.getRowBuyInFlightAt();

  await harness.enableOverlay();
  race.setNow(startedAt + 20_001);
  await race.advance(1);
  await harness.doRowBuy(PAIR, null, {
    mint: B,
    pair: PAIR,
    priceSol: 0.000032,
  });
  race.releaseAIdentity();
  await waitFor(() => !harness.getRowArmedFlushing());

  assert.deepEqual(Array.from(harness.getState().journal, (trade) => trade.mint), [B],
    'a watchdog-superseded armed operation must not commit');
  assert.equal(harness.getRowArmed().address, A,
    'a superseded armed intent remains available for retry');

  harness.noteRowPrice({
    mint: A,
    candidates: [{ unit: 'usd', value: 100 }],
    symbol: 'A',
    name: 'Token A',
  });
  await waitFor(() => harness.getState().journal.length === 2);
  assert.equal(harness.getState().journal[0].mint, A,
    'the retained armed intent commits on a later wake');
});

test('a coherent row-props quote fills when SOL/USD lookup hangs', async () => {
  const race = bootRace({ holdSolUsd: true });
  const { harness } = race;

  const buy = harness.doRowBuy(PAIR, null, {
    mint: B,
    pair: PAIR,
    priceSol: 0.000032,
    priceUsd: 0.0032,
  });
  await waitFor(() => race.isSolUsdRequested());
  await race.advance(2_001);
  await buy;

  assert.deepEqual(Array.from(harness.getState().journal, (trade) => trade.mint), [B]);
  assert.equal(
    race.messages.filter((message) => message.type === 'pt_resolve').length,
    0,
    'a timed-out SOL/USD witness does not force resolver pricing',
  );
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
