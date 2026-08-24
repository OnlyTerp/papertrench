/* F-61 — the stranded stand-in bag at the graduation boundary (jb, 8/17).
 *
 * Report: "buy via final stretch, hold until bond, then open from the bonding
 * section: the buy does not show." The Pulse row buy runs on a LIST page; the
 * resolver cascade can miss a pre-graduation bonding coin entirely, so the
 * row-feed fallback commits the fill under the CLICK address — on Axiom that
 * is the pair/curve STAND-IN, not the mint. The coin then graduates (new AMM
 * pool, new pair address) off-page. Reopening it later from the bonded
 * listing resolves the REAL mint: a key the wallet never held. The card
 * renders empty, the bar chip goes dead, and unlike P0-3's in-context stash
 * bridge nothing links the two sessions — the page was closed between.
 *
 * Fix 1 (commit-time heal, content.js fillRowBuy): a row-fed candidate whose
 * mint is missing or the echoed click address gets ONE bounded prewatch
 * probe; a discovered real mint re-keys the candidate before commit.
 * Fix 2 (migration backstop, content.js detectLoop/requote + quote.js
 * tokenFromPayload): the resolver record now carries poolAddresses — every
 * pool Dexscreener lists for the base mint, including the graduated
 * bonding-era pair. Any OPEN position keyed by one of those pools is the
 * same coin under its stand-in; it rekeys onto the real mint.
 *
 * This file drives the SHIPPED content.js in the migration.test.js harness
 * shape.
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

const REAL_MINT  = 'R' + '1'.repeat(42);
const CURVE      = 'C' + '2'.repeat(42);
const NEW_POOL   = 'P' + '3'.repeat(42);
const OTHER_MINT = 'D' + '4'.repeat(42);
const WSOL = 'So11111111111111111111111111111111111111112';

function dexPayload(mint, pair) {
  return {
    pairs: [{
      chainId: 'solana',
      dexId: 'pumpswap',
      pairAddress: pair,
      baseToken: { address: mint, symbol: 'GRAD', name: 'Graduated' },
      quoteToken: { address: WSOL, symbol: 'SOL' },
      priceNative: '0.0000021',
      priceUsd: '0.00042',
      liquidity: { usd: 60000 },
      marketCap: 42000,
    }],
  };
}

/** The /tokens/<mint> answer AFTER graduation: BOTH pools listed under the
 * same base mint — the migrated AMM pool AND the (dead) bonding-era curve.
 * This is what Dexscreener keeps forever for graduated pump coins. */
function migratedTokenPayload() {
  return {
    pairs: [{
      chainId: 'solana',
      dexId: 'pumpswap',
      pairAddress: NEW_POOL,
      baseToken: { address: REAL_MINT, symbol: 'GRAD', name: 'Graduated' },
      quoteToken: { address: WSOL, symbol: 'SOL' },
      priceNative: '0.0000042',
      priceUsd: '0.00084',
      liquidity: { usd: 120000 },
      marketCap: 84000,
    }, {
      chainId: 'solana',
      dexId: 'pumpfun',
      pairAddress: CURVE,
      baseToken: { address: REAL_MINT, symbol: 'GRAD', name: 'Graduated' },
      quoteToken: { address: WSOL, symbol: 'SOL' },
      priceNative: '0.0000039',
      priceUsd: '0.00078',
      liquidity: { usd: 100 },
      marketCap: 78000,
    }],
  };
}

/**
 * Boot the shipped content.js on an Axiom Pulse list page (final stretch).
 */
function runStrandedBag(opts) {
  const options = opts || {};
  const timers = [];
  let now = 5_000_000;
  const nodesById = {};
  const messages = [];
  const winListeners = {};
  const bridgeEvents = [];

  function makeNode(tag) {
    const node = {
      tag, style: { setProperty() {}, removeProperty() {} }, dataset: {}, value: '',
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
      set innerHTML(v) {
        this._h = v;
        const re = /data-f="([a-z]+)"/g; let m;
        while ((m = re.exec(v))) { const c = makeNode('span'); c.dataset.f = m[1]; this._fields[m[1]] = c; }
      },
      get innerHTML() { return this._h || ''; },
      appendChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); if (c._parent && c._parent !== this) c._parent.removeChild(c); c._parent = this; this.children.push(c); this.childNodes = this.children; return c; },
      removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); },
      remove() { if (this._parent) this._parent.removeChild(this); },
      setAttribute() {}, getAttribute() { return null; },
      addEventListener(type, fn) {
        if (!this._listeners) this._listeners = {};
        if (!this._listeners[type]) this._listeners[type] = [];
        this._listeners[type].push(fn);
      },
      click() { ((this._listeners && this._listeners.click) || []).forEach((fn) => fn()); },
      querySelectorAll() { return []; },
      querySelector(sel) {
        const m = /data-f="([a-z]+)"/.exec(sel);
        if (m && this._fields[m[1]]) return this._fields[m[1]];
        return makeNode('span');
      },
      getBoundingClientRect() { return { top: 0 }; },
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

  const startUrl = 'https://axiom.trade/pulse';
  const parsedStart = new URL(startUrl);
  const location = {
    href: startUrl, hostname: parsedStart.hostname,
    pathname: parsedStart.pathname, search: parsedStart.search,
  };

  const doc = {
    readyState: 'complete', hidden: false, title: 'pulse',
    body: Object.assign(makeNode('body'), { innerText: '' }),
    documentElement: makeNode('html'), head: makeNode('head'),
    createElement: (t) => makeNode(t),
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    addEventListener: () => {}, createTreeWalker: () => ({ nextNode: () => null }),
  };

  const win = {
    addEventListener(type, fn) { (winListeners[type] = winListeners[type] || []).push(fn); },
    removeEventListener() {},
    postMessage: (msg) => { if (msg && msg.source === 'papertrench-content') messages.push(msg.type); },
    location,
    getComputedStyle: () => ({ right: '18px', top: '84px' }),
    confirm: () => false,
  };
  win.window = win;

  // Seeded wallet: the exact state the reported bug leaves behind — a bag
  // committed under the stand-in curve address by a row buy that never
  // resolved. (Rows on a list page have no loaded token; no swapStash.)
  const seeded = E.defaultState();
  seeded.positions[CURVE] = {
    mint: CURVE, qty: 2_000_000, costSol: 0.4, investedSol: 0.4,
    netInvestedSol: 0.4, openedAt: 12345, sessionId: 'pt-test',
  };
  const storage = { pt_settings: E.defaultSettings(), pt_state: seeded };

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
    clearTimeout: () => {}, clearInterval: (id) => { if (timers[id - 1]) timers[id - 1].dead = true; },
    setInterval: (fn, ms) => { timers.push({ fn, at: now + ms, every: ms }); return timers.length; },
    fetch: (u) => {
      const s = String(u);
      // Jupiter: the SOL/USD reference query; tokens stay unknown there.
      if (s.includes('lite-api.jup.ag')) {
        const q = decodeURIComponent(s.split('query=')[1] || '');
        if (q.includes(WSOL)) {
          return Promise.resolve({ ok: true, status: 200, json: async () => [{ id: WSOL, usdPrice: 200 }] });
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => [] });
      }
      // Dexscreener resolve endpoints, routed by the test's stage().
      const m = /\/latest\/dex\/(?:pairs\/solana|tokens)\/([A-Za-z0-9]+)/.exec(s);
      if (m) {
        const r = options.stage(m[1]);
        if (!r || r === 'blind') return Promise.resolve({ ok: true, status: 200, json: async () => ({ pairs: null }) });
        return Promise.resolve({ ok: true, status: 200, json: async () => r.payload || dexPayload(r.mint, r.pair) });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ pairs: null }) });
    },
    chrome: {
      runtime: {
        id: 'papertrench-test',
        getURL: (p) => 'x/' + p,
        sendMessage: (msg) => {
          if (msg && msg.type === 'pt_attest_append') return Promise.resolve({ ok: true, seq: 0, head: 'pt-test-head' });
          if (msg && msg.type === 'pt_state_commit') return Promise.resolve({}); // worker absent: forces the direct-write fallback
          const R = win.PaperTrenchResolver;
          if (!R) return Promise.resolve({});
          if (msg.type === 'pt_resolve') return R.resolve(msg.address);
          if (msg.type === 'pt_refresh') return R.refresh(msg.token);
          if (msg.type === 'pt_sol_usd') return R.solUsd();
          if (msg.type === 'pt_batch_prices') return R.batchPrices(msg.mints);
          if (msg.type === 'pt_onchain_prewatch') {
            // F-61 Fix 1 path: the background's prewatch probe. The test's
            // stage() decides whether the chain can identify the click
            // address (a bonding curve -> its mint; a pool -> its base).
            const answer = options.prewatch && options.prewatch(msg.pool, msg.mint);
            return Promise.resolve(answer || null);
          }
          return Promise.resolve({});
        },
        onMessage: { addListener: () => {} },
        openOptionsPage: () => {},
      },
      storage: {
        local: {
          get: (keys, cb) => { const out = {}; for (const k of (Array.isArray(keys) ? keys : [keys])) if (k in storage) out[k] = storage[k]; if (cb) cb(out); return Promise.resolve(out); },
          set: (obj, cb) => { Object.assign(storage, obj); if (cb) cb(); return Promise.resolve(); },
        },
        onChanged: { addListener: () => {} },
      },
      tabs: { query: () => Promise.resolve([{ id: 1 }]), sendMessage: () => Promise.resolve() },
    },
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
        try { t.fn(); } catch (err) { /* asserted via outcomes */ }
      }
      for (let k = 0; k < 8; k++) await Promise.resolve();
    }
  }

  async function settle() {
    for (let k = 0; k < 400; k++) await Promise.resolve();
  }

  /** Simulate the OS gesture the chip tap itself constitutes. */
  function gesture() {
    for (const fn of winListeners.pointerdown || []) fn({ isTrusted: true });
  }

  /** A MAIN-world bridge 'row-buy' message, as the injected chip posts it. */
  function tapChip(address) {
    gesture();
    for (const fn of winListeners.message || []) {
      fn({
        source: win, origin: location.origin,
        data: { source: 'papertrench-bridge', type: 'row-buy', payload: { address } },
      });
    }
  }

  /** A MAIN-world bridge row tick — the Pulse row's own price print. */
  function rowTick(address, usd) {
    for (const fn of winListeners.message || []) {
      fn({
        source: win, origin: location.origin,
        data: {
          source: 'papertrench-bridge', type: 'tick',
          payload: { mint: address, symbol: 'GRAD', name: 'Graduated', candidates: [{ unit: 'usd', value: usd }] },
        },
      });
    }
  }

  return {
    advance, settle, gesture, tapChip, rowTick,
    navigate(url) {
      const p = new URL(url);
      location.href = url; location.pathname = p.pathname;
      location.hostname = p.hostname; location.search = p.search;
    },
    shadowNode: (id) => shadowRoot.getElementById(id),
    clickShadow: (id) => shadowRoot.getElementById(id).click(),
    setInput: (id, v) => { shadowRoot.getElementById(id).value = String(v); },
    buyButtonText: () => (nodesById['pt-buy'] || {}).textContent || '',
    buyButtonArmed: () => {
      const el = nodesById['pt-buy'];
      return !!(el && el.classList.contains('pt-buy-armed'));
    },
    storage: () => storage,
    CURVE, REAL_MINT, NEW_POOL, OTHER_MINT,
  };
}

test('F-61 report: Pulse row buy under the stand-in heals at the migrated pool', async () => {
  // Phase 1 — the Pulse list page, world pre-graduation: the coin is a
  // bonding curve that NO source can identify or price (the resolver's
  // exact blind window at the final stretch). The row's own tick prints.
  const world = { stage: 'bonding' };
  const ov = runStrandedBag({
    stage: (addr) => {
      if (world.stage === 'bonding') return 'blind';
      // Post-graduation: the NEW pool answers with BOTH pools listed under
      // the real mint — Dexscreener's forever-listing of graduated coins.
      if (addr === REAL_MINT) return { payload: migratedTokenPayload() };
      // The old curve still resolves to the same base mint (it stays listed).
      if (addr === CURVE) return { mint: REAL_MINT, pair: CURVE };
      return 'blind';
    },
    prewatch: (pool, mint) => {
      // Pre-graduation the chain CAN classify the curve: it knows the curve
      // account and its mint — the identity heal Fix 1 relies on.
      if (world.stage === 'bonding' && (pool === CURVE || mint === CURVE)) {
        return { mint: REAL_MINT, pool: CURVE, poolKind: 'pump-curve', priceNative: 0.000002 };
      }
      return null;
    },
  });

  await ov.advance(3000);
  // The Pulse row prints its own live price (USD) for the curve address.
  ov.rowTick(CURVE, 0.0004);
  await ov.settle();
  // The chip tap: a real gesture + bridge row-buy for the curve address.
  ov.tapChip(CURVE);
  await ov.settle();

  // FIX 1 ASSERT — the fill must commit under the REAL mint already at buy
  // time: the prewatch probe discovered the identity. The seeded stand-in
  // bag is a LEGACY stranding (pre-fix wallet state) — merging it is the
  // backstop's job at reopen, not the candidate heal's.
  let positions = ov.storage().pt_state.positions || {};
  assert.ok(positions[REAL_MINT],
    'Fix 1: the row buy must commit under the REAL mint (prewatch identity heal)');
  assert.ok(positions[REAL_MINT].qty > 0 && positions[REAL_MINT].qty < 2_000_000,
    'Fix 1: the fill opened a FRESH real-mint bag (the 0.1 SOL fill, ~50k tokens)');
  assert.ok(positions[CURVE] && positions[CURVE].qty === 2_000_000,
    'the legacy stand-in bag stays put until the backstop heals it');

  // Phase 2 — graduation. The page was closed; the world moves on. The
  // bonded listing now opens the coin by its REAL mint.
  world.stage = 'graduated';
  ov.navigate(`https://axiom.trade/meme/${REAL_MINT}?chain=sol`);
  await ov.advance(4000);

  // FIX 2 ASSERT — the backstop healed the stranded legacy bag: the stand-in
  // key is vacated and everything lives under the real mint, ONE bag.
  positions = ov.storage().pt_state.positions || {};
  assert.ok(positions[REAL_MINT], 'the real-mint bag survives the reopen');
  assert.ok(!positions[CURVE],
    'Fix 2: the stand-in key must be vacated by the poolAddresses backstop');
  assert.ok(positions[REAL_MINT].qty > 2_000_000,
    'one merged bag under the real mint (legacy seed + fresh fill)');
});

test('F-61 negative: a different coin never inherits the stand-in bag', async () => {
  const world = { stage: 'bonding' };
  const ov = runStrandedBag({
    stage: (addr) => {
      if (world.stage === 'bonding') return 'blind';
      // The reopened page is a DIFFERENT coin entirely.
      if (addr === OTHER_MINT) return { mint: OTHER_MINT, pair: NEW_POOL };
      return 'blind';
    },
    prewatch: (pool, mint) => {
      if (world.stage === 'bonding' && (pool === CURVE || mint === CURVE)) {
        return { mint: REAL_MINT, pool: CURVE, poolKind: 'pump-curve', priceNative: 0.000002 };
      }
      return null;
    },
  });

  await ov.advance(3000);
  ov.rowTick(CURVE, 0.0004);
  await ov.settle();
  ov.tapChip(CURVE);
  await ov.settle();

  world.stage = 'graduated';
  ov.navigate(`https://axiom.trade/meme/${OTHER_MINT}?chain=sol`);
  await ov.advance(4000);

  const positions = ov.storage().pt_state.positions || {};
  assert.ok(positions[CURVE],
    'an unrelated coin page must never eat the stand-in bag');
  assert.ok(!positions[OTHER_MINT] || positions[OTHER_MINT].qty <= 0,
    'nothing may be created for the unrelated coin');
  assert.ok(!positions[REAL_MINT] || positions[REAL_MINT].qty <= 2_000_000 + 1e9,
    'the healed bag must not leak onto the other coin');
});

test('F-61 legacy path: prewatch silent, fill keys the stand-in honestly', async () => {
  // The chain probe misses (RPC blind, foreign shape, whatever): Fix 1 keeps
  // the legacy behavior — the fill commits under the row's own address. The
  // seeded stand-in bag grows; no crash, no refusal.
  const ov = runStrandedBag({
    stage: () => 'blind',
    prewatch: () => null,
  });

  await ov.advance(3000);
  ov.rowTick(CURVE, 0.0004);
  await ov.settle();
  ov.tapChip(CURVE);
  await ov.settle();

  const positions = ov.storage().pt_state.positions || {};
  assert.ok(positions[CURVE],
    'a silent probe keeps the honest legacy keying (the row address)');
  assert.ok(positions[CURVE].qty > 2_000_000,
    'the seeded bag grew by the fill');
});
