/* P0-3 — the graduation/rekey disappearing buy (Discord report: jb).
 *
 * Timeline: the user is on a pump.fun bonding-curve page on a pair-URL site
 * (Axiom); the pending token's identity is the curve address. They buy
 * (position keyed under the stand-in) and/or arm a buy. The curve graduates
 * — the page redirects to the coin's new AMM pool URL. After the redirect
 * the armed buy was dropped and the bag went invisible: the detect loop
 * treated the URL change as a coin switch, and the old stand-in address
 * appeared in NEITHER the new record's pairAddress nor srcAddress.
 *
 * The fix stashes the replaced identity at the swap and settles it once the
 * resolver answers for the new page: Dexscreener keeps a graduated curve
 * listed under the same base mint forever, so resolving the OLD address
 * returns the real mint on both sides of a migration. Same mint => same
 * coin => restore the armed intent and rekey the bag. Anything else => a
 * genuine coin switch; the legacy drop semantics stand.
 *
 * This file drives the SHIPPED content.js in the same VM harness shape as
 * freshlaunch.test.js.
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

/**
 * Boot the shipped content.js on an Axiom curve page with a seeded bag.
 *
 * `stage(addr)` maps an address to 'blind' | { mint, pair } — the test
 * flips it over time to model the migration.
 */
function runMigration(opts) {
  const options = opts || {};
  const timers = [];
  let now = 5_000_000;
  const nodesById = {};
  const messages = [];

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

  const startUrl = `https://axiom.trade/meme/${CURVE}?chain=sol`;
  const parsedStart = new URL(startUrl);
  const location = {
    href: startUrl, hostname: parsedStart.hostname,
    pathname: parsedStart.pathname, search: parsedStart.search,
  };

  const doc = {
    readyState: 'complete', hidden: false, title: 'graduation',
    body: Object.assign(makeNode('body'), { innerText: '' }),
    documentElement: makeNode('html'), head: makeNode('head'),
    createElement: (t) => makeNode(t),
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    addEventListener: () => {}, createTreeWalker: () => ({ nextNode: () => null }),
  };

  const win = {
    addEventListener: () => {}, removeEventListener: () => {},
    postMessage: (msg) => { if (msg && msg.source === 'papertrench-content') messages.push(msg.type); },
    location,
    getComputedStyle: () => ({ right: '18px', top: '84px' }),
    confirm: () => false,
  };
  win.window = win;

  // Seeded wallet: a bag committed under the stand-in curve address, the
  // exact state a buy on the curve page leaves behind.
  const seeded = E.defaultState();
  seeded.positions[CURVE] = {
    mint: CURVE, qty: 1_000_000, costSol: 0.5, investedSol: 0.5,
    netInvestedSol: 0.5, openedAt: 12345, sessionId: 'pt-test',
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
        return Promise.resolve({ ok: true, status: 200, json: async () => dexPayload(r.mint, r.pair) });
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

  // D-38: requestBuy's click-time acquisition beat is async, so a click on an
  // unpriced token arms one microtask flush later. Flush before asserting.
  async function settle() {
    for (let k = 0; k < 32; k++) await Promise.resolve();
  }

  return {
    advance,
    settle,
    navigate(url) {
      const p = new URL(url);
      location.href = url; location.pathname = p.pathname;
      location.hostname = p.hostname; location.search = p.search;
    },
    shadowNode: (id) => shadowRoot.getElementById(id),
    clickShadow: (id) => shadowRoot.getElementById(id).click(),
    setInput: (id, v) => { shadowRoot.getElementById(id).value = String(v); },
    buyButtonText: () => (nodesById['pt-buy'] || {}).textContent || '',
    storage: () => storage,
    CURVE, REAL_MINT, NEW_POOL, OTHER_MINT,
  };
}

test('P0-3 positive: graduation rekeys the bag and revives the armed buy', async () => {
  // Before the migration nobody knows the coin: curve blind, pool blind.
  const world = { curve: 'blind', pool: 'blind' };
  const ov = runMigration({
    stage: (addr) => (addr === ov_CURVE(ov) ? world.curve
      : addr === ov_NEW_POOL(ov) ? world.pool : 'blind'),
  });
  function ov_CURVE() { return CURVE; }
  function ov_NEW_POOL() { return NEW_POOL; }

  // Phase 1 — the curve page: pending stand-in, armed buy, seeded bag.
  await ov.advance(3000);
  assert.match(ov.buyButtonText(), /waiting|quoted|—/i,
    'the panel must be live on the curve page');
  ov.setInput('pt-custom', '0.5');
  ov.clickShadow('pt-buy');
  await ov.settle();
  assert.match(ov.buyButtonText(), /ARMED/,
    'a buy on a pending curve page must arm, not fail');

  // Phase 2 — graduation: URL redirects to the migration pool; the world
  // now indexes BOTH sides under the same base mint (what Dexscreener does
  // for graduated pump coins — verified on-chain 2026-08-20).
  world.pool = { mint: REAL_MINT, pair: NEW_POOL };
  world.curve = { mint: REAL_MINT, pair: CURVE };
  ov.navigate(`https://axiom.trade/meme/${NEW_POOL}?chain=sol`);
  await ov.advance(4000);

  // The armed intent survived the graduation and FIRED at the migrated
  // pool's first quote (the F-54 flush): the button is back to plain BUY.
  // A plain "dropped" armed buy would also show BUY, so the PROOF is the
  // rekeyed bag growing — the seeded 1M tokens plus the 0.5 SOL fill.
  assert.doesNotMatch(ov.buyButtonText(), /ARMED/,
    'the armed buy must fire at the first quote on the migrated pool');
  // The bag rekeyed from the stand-in curve to the real mint, in storage.
  const positions = ov.storage().pt_state.positions || {};
  assert.ok(positions[REAL_MINT], 'the position must live under the real mint after graduation');
  assert.ok(!positions[CURVE], 'the stand-in key must be vacated');
  assert.ok(positions[REAL_MINT].qty > 1_000_000,
    'the armed buy must have FIRED on the real mint — the bag grew past the seed');
  assert.ok((positions[REAL_MINT].costSol || 0) > 0.5,
    'the fill added cost on top of the seeded bag');
});

test('P0-3 negative: a different coin never inherits the armed buy or the bag', async () => {
  const world = { curve: 'blind', pool: 'blind' };
  const ov = runMigration({
    stage: (addr) => (addr === CURVE ? world.curve
      : addr === NEW_POOL ? world.pool : 'blind'),
  });

  await ov.advance(3000);
  ov.setInput('pt-custom', '0.5');
  ov.clickShadow('pt-buy');
  await ov.settle();
  assert.match(ov.buyButtonText(), /ARMED/,
    'armed before the navigation');

  // The new page is a DIFFERENT coin: the old address resolves to a
  // different mint than the new page's record.
  world.pool = { mint: OTHER_MINT, pair: NEW_POOL };
  world.curve = { mint: REAL_MINT, pair: CURVE };
  ov.navigate(`https://axiom.trade/meme/${NEW_POOL}?chain=sol`);
  await ov.advance(4000);

  assert.doesNotMatch(ov.buyButtonText(), /ARMED/,
    'an armed buy for one coin must never fire on a different coin');
  const positions = ov.storage().pt_state.positions || {};
  assert.ok(positions[CURVE], 'the stand-in bag is preserved, not inherited by the other coin');
  assert.ok(!positions[OTHER_MINT], 'nothing may be created for the unrelated coin');
  assert.ok(!positions[REAL_MINT] || positions[REAL_MINT].qty !== 1_000_000,
    'the bag must not silently jump to a different coin page');
});
