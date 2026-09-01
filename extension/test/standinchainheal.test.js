const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

global.window = global.window || {};
require('../engine.js');
const E = global.window.PaperEngine;

const REAL_MINT = 'R' + '1'.repeat(42);
const STAND_IN = 'C' + '2'.repeat(42);
const OTHER_MINT = 'D' + '4'.repeat(42);
const WSOL = 'So11111111111111111111111111111111111111112';

function pairPayload(mint, pair) {
  return {
    pair: {
      chainId: 'solana',
      dexId: 'pumpswap',
      pairAddress: pair,
      baseToken: { address: mint, symbol: 'TEST', name: 'Test' },
      quoteToken: { address: WSOL, symbol: 'SOL' },
      priceNative: '0.000002',
      priceUsd: '0.0004',
      liquidity: { usd: 60000 },
      marketCap: 42000,
    },
  };
}

function runHarness(options = {}) {
  const timers = [];
  let now = 5_000_000;
  const nodesById = {};
  const winListeners = {};
  const chainProbes = [];

  function makeNode(tag) {
    const node = {
      tag, style: { setProperty() {}, removeProperty() {} }, dataset: {}, value: '',
      children: [], childNodes: [], _fields: {},
      classList: {
        _s: new Set(),
        add(...classes) { classes.forEach((value) => this._s.add(value)); },
        remove(...classes) { classes.forEach((value) => this._s.delete(value)); },
        toggle(name, on) { if (on === undefined) this._s.has(name) ? this._s.delete(name) : this._s.add(name); else on ? this._s.add(name) : this._s.delete(name); },
        contains(name) { return this._s.has(name); },
      },
      set textContent(value) { this._text = value; },
      get textContent() { return this._text || ''; },
      set innerHTML(value) {
        this._html = value;
        const fields = /data-f="([a-z]+)"/g;
        let match;
        while ((match = fields.exec(value))) {
          const child = makeNode('span');
          child.dataset.f = match[1];
          this._fields[match[1]] = child;
        }
      },
      get innerHTML() { return this._html || ''; },
      appendChild(child) {
        if (child._parent && child._parent !== this) child._parent.removeChild(child);
        child._parent = this;
        this.children.push(child);
        this.childNodes = this.children;
        return child;
      },
      removeChild(child) {
        const index = this.children.indexOf(child);
        if (index >= 0) this.children.splice(index, 1);
      },
      remove() { if (this._parent) this._parent.removeChild(this); },
      setAttribute() {}, getAttribute() { return null; },
      addEventListener(type, fn) {
        if (!this._listeners) this._listeners = {};
        (this._listeners[type] ||= []).push(fn);
      },
      click() { for (const fn of (this._listeners && this._listeners.click) || []) fn(); },
      querySelectorAll() { return []; },
      querySelector(selector) {
        const match = /data-f="([a-z]+)"/.exec(selector);
        return match && this._fields[match[1]] ? this._fields[match[1]] : makeNode('span');
      },
      getBoundingClientRect() { return { top: 0 }; },
      attachShadow() { return shadowRoot; },
      focus() {}, closest() { return null; },
      get offsetWidth() { return 1; },
    };
    return node;
  }

  const shadowRoot = {
    set innerHTML(value) { this._html = value; },
    get innerHTML() { return this._html || ''; },
    getElementById(id) { return nodesById[id] ||= makeNode('div'); },
    querySelector() { return makeNode('div'); },
    querySelectorAll() { return []; },
    appendChild() {},
  };

  const startUrl = 'https://axiom.trade/pulse';
  const parsedStart = new URL(startUrl);
  const location = {
    href: startUrl, hostname: parsedStart.hostname, pathname: parsedStart.pathname,
    search: parsedStart.search, origin: parsedStart.origin,
  };
  const doc = {
    readyState: 'complete', hidden: false, title: 'pulse',
    body: Object.assign(makeNode('body'), { innerText: '' }),
    documentElement: makeNode('html'), head: makeNode('head'),
    createElement: (tag) => makeNode(tag),
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    addEventListener: () => {}, createTreeWalker: () => ({ nextNode: () => null }),
  };
  const win = {
    addEventListener(type, fn) { (winListeners[type] ||= []).push(fn); },
    removeEventListener() {},
    postMessage() {},
    location,
    getComputedStyle: () => ({ right: '18px', top: '84px' }),
    confirm: () => false,
  };
  win.window = win;

  const settings = E.defaultSettings();
  settings.feeBps = 0;
  settings.gasSolPerTx = 0;
  settings.tipSolPerTx = 0;
  settings.presetsBuy = [options.rowAmount || 0.25];
  const state = E.defaultState(settings);
  if (options.seed) options.seed(state, settings);
  const storage = { pt_settings: settings, pt_state: state };

  const sandbox = {
    window: win, self: win, document: doc, location, console,
    URLSearchParams, URL,
    AbortController: function () { this.signal = {}; this.abort = () => {}; },
    MutationObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
    TextDecoder: function () { this.decode = () => ''; },
    ResizeObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
    Set, Map, WeakSet, WeakMap, Promise, JSON, Math, Number, String, Array, Object,
    Boolean, RegExp, Error, isNaN, parseInt, parseFloat, Infinity, NaN,
    Date: Object.assign(function () {}, { now: () => now, parse: Date.parse }),
    setTimeout: (fn, ms) => { timers.push({ fn, at: now + (ms || 0) }); return timers.length; },
    clearTimeout: () => {},
    clearInterval: (id) => { if (timers[id - 1]) timers[id - 1].dead = true; },
    setInterval: (fn, ms) => { timers.push({ fn, at: now + ms, every: ms }); return timers.length; },
    fetch: (url) => {
      const text = String(url);
      if (text.includes('lite-api.jup.ag')) {
        const query = decodeURIComponent(text.split('query=')[1] || '');
        return Promise.resolve({
          ok: true, status: 200,
          json: async () => query.includes(WSOL) ? [{ id: WSOL, usdPrice: 200 }] : [],
        });
      }
      const match = /\/latest\/dex\/(?:pairs\/solana|tokens)\/([A-Za-z0-9]+)/.exec(text);
      if (match) {
        const result = options.stage ? options.stage(match[1]) : 'blind';
        if (!result || result === 'blind') {
          return Promise.resolve({ ok: true, status: 200, json: async () => ({ pairs: null }) });
        }
        return Promise.resolve({
          ok: true, status: 200,
          json: async () => result.payload || pairPayload(result.mint, result.pair),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ pairs: null }) });
    },
    chrome: {
      runtime: {
        id: 'papertrench-test',
        getURL: (file) => 'x/' + file,
        sendMessage: (message) => {
          if (message && message.type === 'pt_attest_append') {
            return Promise.resolve({ ok: true, seq: 0, head: 'pt-test-head' });
          }
          if (message && message.type === 'pt_state_commit') return Promise.resolve({});
          const resolver = win.PaperTrenchResolver;
          if (!resolver) return Promise.resolve({});
          if (message.type === 'pt_resolve') return resolver.resolve(message.address);
          if (message.type === 'pt_refresh') return resolver.refresh(message.token);
          if (message.type === 'pt_sol_usd') return resolver.solUsd();
          if (message.type === 'pt_batch_prices') return resolver.batchPrices(message.mints);
          if (message.type === 'pt_onchain_prewatch') {
            if (message.pool && message.pool === message.mint) chainProbes.push(message.pool);
            const answer = options.prewatch
              && options.prewatch(message.pool, message.mint);
            return Promise.resolve(answer || null);
          }
          return Promise.resolve({});
        },
        onMessage: { addListener: () => {} },
        openOptionsPage: () => {},
      },
      storage: {
        local: {
          get: (keys, callback) => {
            const out = {};
            for (const key of (Array.isArray(keys) ? keys : [keys])) {
              if (key in storage) out[key] = storage[key];
            }
            if (callback) callback(out);
            return Promise.resolve(out);
          },
          set: (value, callback) => {
            Object.assign(storage, value);
            if (callback) callback();
            return Promise.resolve();
          },
        },
        onChanged: { addListener: () => {} },
      },
      tabs: { query: () => Promise.resolve([{ id: 1 }]), sendMessage: () => Promise.resolve() },
    },
    NodeFilter: { SHOW_TEXT: 4 },
  };

  const ctx = vm.createContext(sandbox);
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const entry = manifest.content_scripts.find((script) => (script.js || []).includes('content.js'));
  for (const file of entry.js) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), ctx, { filename: file });
  }

  async function settle() {
    for (let i = 0; i < 400; i++) await Promise.resolve();
  }
  async function advance(ms, step = 100) {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      now += step;
      for (const timer of timers) {
        if (timer.dead || timer.at > now) continue;
        if (timer.every) timer.at = now + timer.every;
        else timer.dead = true;
        try { timer.fn(); } catch (_) {}
      }
      await settle();
    }
  }
  function rowTick(address, usd) {
    for (const fn of winListeners.message || []) {
      fn({
        source: win,
        origin: location.origin,
        data: {
          source: 'papertrench-bridge', type: 'tick',
          payload: {
            mint: address, symbol: 'TEST', name: 'Test',
            candidates: [{ unit: 'usd', value: usd }],
          },
        },
      });
    }
  }
  function tapChip(address) {
    for (const fn of winListeners.pointerdown || []) fn({ isTrusted: true });
    for (const fn of winListeners.message || []) {
      fn({
        source: win,
        origin: location.origin,
        data: {
          source: 'papertrench-bridge', type: 'row-buy',
          payload: { address },
        },
      });
    }
  }
  return {
    advance, settle, rowTick, tapChip, chainProbes,
    navigate(url) {
      const parsed = new URL(url);
      location.href = url;
      location.hostname = parsed.hostname;
      location.pathname = parsed.pathname;
      location.search = parsed.search;
    },
    storage: () => storage,
  };
}

function fillExpected(solAmount, priceNative) {
  const settings = E.defaultSettings();
  settings.feeBps = 0;
  settings.gasSolPerTx = 0;
  settings.tipSolPerTx = 0;
  const state = E.defaultState(settings);
  E.buy(state, settings, {
    ts: 1, mint: 'expected', site: 'test',
    priceNative, solAmount,
  });
  return state.positions.expected;
}

test('a missed row identity probe heals both stacks by chain proof', async () => {
  const rowAmount = 0.25;
  const priorAmount = 0.1;
  const priceNative = 0.0004 / 200;
  const expectedPrior = fillExpected(priorAmount, priceNative);
  const expectedRow = fillExpected(rowAmount, priceNative);
  const world = { chart: false };
  const view = runHarness({
    rowAmount,
    seed(state, settings) {
      const seeded = E.buy(state, settings, {
        ts: 1, mint: REAL_MINT, site: 'panel',
        priceNative, solAmount: priorAmount,
      });
      seeded.position.lastPriceNative = expectedPrior.lastPriceNative;
    },
    stage(address) {
      if (!world.chart) return 'blind';
      if (address === REAL_MINT) return { payload: pairPayload(REAL_MINT, REAL_MINT) };
      return 'blind';
    },
    prewatch(pool, mint) {
      if (world.chart && pool === STAND_IN && mint === STAND_IN) {
        return { mint: REAL_MINT, pool: STAND_IN, priceNative };
      }
      return null;
    },
  });

  await view.advance(3000);
  view.rowTick(STAND_IN, 0.0004);
  await view.settle();
  view.tapChip(STAND_IN);
  await view.settle();

  let positions = view.storage().pt_state.positions;
  const fillProbes = view.chainProbes.length;
  assert.ok(positions[STAND_IN], 'a missed proof leaves the row fill under its key');
  assert.equal(positions[STAND_IN].standInKey, true);

  world.chart = true;
  view.navigate(`https://axiom.trade/meme/${REAL_MINT}`);
  await view.advance(3000);
  positions = view.storage().pt_state.positions;
  const merged = positions[REAL_MINT];
  assert.equal(view.chainProbes.length, fillProbes + 1,
    'the chart must use chain proof when the resolver lists no poolAddresses');
  assert.ok(merged, 'chain proof moves the stand-in onto the chart mint');
  assert.equal(positions[STAND_IN], undefined);
  assert.equal(merged.qty, expectedPrior.qty + expectedRow.qty);
  assert.equal(merged.costSol, expectedPrior.costSol + expectedRow.costSol);
  assert.equal(merged.investedSol, expectedPrior.investedSol + expectedRow.investedSol);
  assert.equal(merged.netInvestedSol, expectedPrior.netInvestedSol + expectedRow.netInvestedSol);
  assert.equal(merged.standInKey, undefined);
});

test('a chain proof for a different mint clears the flag without merging', async () => {
  const world = { chart: false };
  const view = runHarness({
    stage: (address) => world.chart && (address === REAL_MINT || address === OTHER_MINT)
      ? { payload: pairPayload(address, address) } : 'blind',
    prewatch: (pool, mint) => world.chart && pool === STAND_IN && mint === STAND_IN
      ? { mint: OTHER_MINT, pool: STAND_IN }
      : null,
  });
  await view.advance(3000);
  view.rowTick(STAND_IN, 0.0004);
  await view.settle();
  view.tapChip(STAND_IN);
  await view.settle();

  world.chart = true;
  view.navigate(`https://axiom.trade/meme/${REAL_MINT}`);
  await view.advance(3000);
  const before = view.chainProbes.length;
  const position = view.storage().pt_state.positions[STAND_IN];
  assert.ok(position);
  assert.equal(position.standInKey, undefined);

  view.navigate(`https://axiom.trade/meme/${OTHER_MINT}`);
  await view.advance(3000);
  assert.equal(view.chainProbes.length, before,
    'a proven-different key is not probed again in this page session');
  assert.ok(view.storage().pt_state.positions[STAND_IN]);
  assert.equal(view.storage().pt_state.positions[STAND_IN].standInKey, undefined);
  assert.equal(view.storage().pt_state.positions[REAL_MINT], undefined);
  assert.equal(view.storage().pt_state.positions[OTHER_MINT], undefined);
});

test('a chain rekey clears the flag when no real-mint stack exists', async () => {
  const world = { chart: false };
  const view = runHarness({
    stage: (address) => world.chart && address === REAL_MINT
      ? { payload: pairPayload(REAL_MINT, REAL_MINT) } : 'blind',
    prewatch: (pool, mint) => world.chart && pool === STAND_IN && mint === STAND_IN
      ? { mint: REAL_MINT, pool: STAND_IN } : null,
  });
  await view.advance(3000);
  view.rowTick(STAND_IN, 0.0004);
  await view.settle();
  view.tapChip(STAND_IN);
  await view.settle();

  world.chart = true;
  view.navigate(`https://axiom.trade/meme/${REAL_MINT}`);
  await view.advance(3000);
  const position = view.storage().pt_state.positions[REAL_MINT];
  assert.ok(position);
  assert.equal(position.standInKey, undefined);
});

test('each stand-in key gets at most one chain probe per page session', async () => {
  const world = { chart: false };
  const view = runHarness({
    stage: (address) => world.chart && (address === REAL_MINT || address === OTHER_MINT)
      ? { payload: pairPayload(address, address) } : 'blind',
    prewatch: () => null,
  });
  await view.advance(3000);
  view.rowTick(STAND_IN, 0.0004);
  await view.settle();
  view.tapChip(STAND_IN);
  await view.settle();

  world.chart = true;
  view.navigate(`https://axiom.trade/meme/${REAL_MINT}`);
  await view.advance(3000);
  const probes = view.chainProbes.filter((key) => key === STAND_IN).length;
  assert.ok(probes > 0, 'the flagged key must be probed on the chart page');
  assert.equal(view.storage().pt_state.positions[STAND_IN].standInKey, true,
    'a failed proof leaves the key eligible on a later page');
  view.navigate(`https://axiom.trade/meme/${OTHER_MINT}`);
  await view.advance(3000);
  view.navigate(`https://axiom.trade/meme/${REAL_MINT}`);
  await view.advance(3000);
  assert.equal(view.chainProbes.filter((key) => key === STAND_IN).length, probes);
});

test('clean positions and clean pages add no chain-heal probes', async () => {
  const cleanPosition = runHarness({
    seed(state, settings) {
      E.buy(state, settings, {
        ts: 1, mint: REAL_MINT, site: 'panel',
        priceNative: 0.000002, solAmount: 0.1,
      });
    },
    stage: (address) => address === REAL_MINT
      ? { payload: pairPayload(REAL_MINT, REAL_MINT) } : 'blind',
    prewatch: () => null,
  });
  cleanPosition.navigate(`https://axiom.trade/meme/${REAL_MINT}`);
  await cleanPosition.advance(3000);
  assert.equal(cleanPosition.chainProbes.length, 0);

  const cleanPage = runHarness({ stage: () => 'blind', prewatch: () => null });
  await cleanPage.advance(3000);
  assert.equal(cleanPage.chainProbes.length, 0);
});

test('a row fill whose identity probe succeeds is not marked as stand-in', async () => {
  const view = runHarness({
    stage: () => 'blind',
    prewatch: (pool, mint) => pool === STAND_IN && mint === STAND_IN
      ? { mint: REAL_MINT, pool: STAND_IN, priceNative: 0.000002 }
      : null,
  });
  await view.advance(3000);
  view.rowTick(STAND_IN, 0.0004);
  await view.settle();
  view.tapChip(STAND_IN);
  await view.settle();
  const positions = view.storage().pt_state.positions;
  assert.ok(positions[REAL_MINT]);
  assert.equal(positions[REAL_MINT].standInKey, undefined);
  assert.equal(positions[STAND_IN], undefined);
});

test('a requote with no poolAddresses still heals a flagged stand-in', async () => {
  const rowAmount = 0.25;
  const priceNative = 0.0004 / 200;
  const expectedRow = fillExpected(rowAmount, priceNative);
  const world = { chainAnswers: false };
  const view = runHarness({
    rowAmount,
    // Only the chart mint is indexed, and its record carries a lone `pair`:
    // the F-61 poolAddresses backstop never arms on this coin.
    stage: (address) => address === REAL_MINT
      ? { payload: pairPayload(REAL_MINT, REAL_MINT) } : 'blind',
    prewatch: (pool, mint) => world.chainAnswers && pool === STAND_IN && mint === STAND_IN
      ? { mint: REAL_MINT, pool: STAND_IN, priceNative } : null,
  });

  // The chart is adopted BEFORE the flagged bag exists, so setToken's pass
  // has nothing to probe and only the requote heartbeat can heal it.
  view.navigate(`https://axiom.trade/meme/${REAL_MINT}`);
  await view.advance(3000);
  assert.equal(view.chainProbes.length, 0);

  view.rowTick(STAND_IN, 0.0004);
  await view.settle();
  view.tapChip(STAND_IN);
  await view.settle();
  const fillProbes = view.chainProbes.filter((key) => key === STAND_IN).length;
  assert.equal(view.storage().pt_state.positions[STAND_IN].standInKey, true);

  world.chainAnswers = true;
  await view.advance(6000);
  const positions = view.storage().pt_state.positions;
  assert.equal(view.chainProbes.filter((key) => key === STAND_IN).length - fillProbes, 1,
    'the requote heal probes the flagged key exactly once');
  assert.equal(positions[STAND_IN], undefined);
  assert.ok(positions[REAL_MINT]);
  assert.equal(positions[REAL_MINT].qty, expectedRow.qty);
  assert.equal(positions[REAL_MINT].standInKey, undefined);
});
