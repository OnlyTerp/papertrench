/* The Padre-style positions bar.
 *
 * The bar's whole purpose is tracking tokens whose charts are NOT on screen,
 * so these tests pin the parts that make that trustworthy:
 *   - a batched price payload is grouped per mint by liquidity, not array order
 *   - a position with no fresh quote is flagged stale rather than silently
 *     showing an old number as if it were live
 *   - portfolio totals equal the sum of their parts
 *   - a chip links to the site the position was actually opened on
 */
const test = require('node:test');
const assert = require('node:assert/strict');

global.window = global.window || {};
const Q = require('../quote.js');
require('../sites.js');
require('../engine.js');
const S = global.window.PaperTrenchSites;
const E = global.window.PaperEngine;

const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const WIF = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm';

function pair(mint, symbol, priceNative, liquidityUsd, priceUsd) {
  return {
    chainId: 'solana',
    pairAddress: `pair-${symbol}-${liquidityUsd}`,
    baseToken: { address: mint, symbol, name: symbol },
    priceNative: String(priceNative),
    priceUsd: priceUsd === undefined ? String(priceNative * 200) : String(priceUsd),
    liquidity: { usd: liquidityUsd },
    marketCap: 1e7,
  };
}

/* ---------------- batch payload parsing ---------------- */

test('a batched payload is grouped per mint, keeping the deepest pool for each', () => {
  const prices = Q.pricesFromBatch({
    pairs: [
      pair(BONK, 'BONK', 0.0000009, 500),      // shallow, listed first
      pair(WIF, 'WIF', 0.0019, 90000),
      pair(BONK, 'BONK', 0.0000004, 250000),   // deepest for BONK
      { chainId: 'ethereum', baseToken: { address: BONK }, priceNative: '9', liquidity: { usd: 1e9 } },
      { chainId: 'solana', baseToken: { address: WIF }, priceNative: '0', liquidity: { usd: 1e9 } },
    ],
  });

  assert.equal(Object.keys(prices).length, 2, 'exactly one quote per requested mint');
  assert.equal(prices[BONK].priceNative, 0.0000004,
    'the deepest Solana pool must win, not whichever pair came back first');
  assert.equal(prices[WIF].priceNative, 0.0019);
  assert.equal(prices[BONK].symbol, 'BONK');
});

test('a malformed or empty batch payload yields no prices rather than throwing', () => {
  assert.deepEqual(Q.pricesFromBatch(null), {});
  assert.deepEqual(Q.pricesFromBatch({}), {});
  assert.deepEqual(Q.pricesFromBatch({ pairs: 'nope' }), {});
  assert.deepEqual(Q.pricesFromBatch({ pairs: [null, {}] }), {});
});

/* ---------------- rows the bar renders ---------------- */

function twoPositionState() {
  const settings = E.defaultSettings();
  settings.feeBps = 0;
  const state = E.defaultState(settings);
  const t0 = 1_000_000;
  E.buy(state, settings, {
    ts: t0, mint: BONK, symbol: 'BONK', site: 'padre', priceNative: 0.000001, solAmount: 1,
  });
  E.buy(state, settings, {
    ts: t0 + 1000, mint: WIF, symbol: 'WIF', site: 'photon', priceNative: 0.002, solAmount: 2,
  });
  return { settings, state };
}

test('rows are marked from live batch prices and ordered newest position first', () => {
  const { state } = twoPositionState();

  const rows = Q.positionRows(state, {
    [BONK]: { priceNative: 0.000002, priceUsd: 0.0004 },  // 2x
    [WIF]: { priceNative: 0.001, priceUsd: 0.2 },         // halved
  }, BONK);

  assert.equal(rows.length, 2);
  assert.equal(rows[0].symbol, 'WIF', 'the most recently opened position comes first');

  const bonk = rows.find((r) => r.mint === BONK);
  const wif = rows.find((r) => r.mint === WIF);

  // Derived from the position, not pasted.
  const bonkPos = state.positions[BONK];
  assert.ok(Math.abs(bonk.pnlSol - (bonkPos.qty * 0.000002 - bonkPos.costSol)) < 1e-12);
  assert.equal(bonk.up, true);
  assert.equal(wif.up, false, 'a halved position must read as losing');
  assert.equal(bonk.active, true, 'the on-screen token is flagged active');
  assert.equal(wif.active, false);
  assert.equal(bonk.stale, false, 'a mint with a live quote is not stale');
});

test('a position with no live quote falls back to its stored mark and is flagged stale', () => {
  const { state } = twoPositionState();

  // Only BONK got a fresh price this cycle.
  const rows = Q.positionRows(state, { [BONK]: { priceNative: 0.000002 } }, null);
  const wif = rows.find((r) => r.mint === WIF);

  assert.equal(wif.stale, true, 'no fresh quote must be surfaced as stale, never as live');
  assert.equal(wif.priceNative, state.positions[WIF].lastPriceNative,
    'a stale row shows the last trusted mark rather than inventing a price');
  assert.equal(rows.find((r) => r.mint === BONK).stale, false);
});

test('rows never include closed or zero-quantity positions', () => {
  const { settings, state } = twoPositionState();
  E.sell(state, settings, { ts: 2_000_000, mint: BONK, qtyFraction: 1, priceNative: 0.000002 });

  const rows = Q.positionRows(state, {}, null);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].mint, WIF, 'a fully exited position must leave the bar');
});

/* ---------------- the on-screen token's chip (O-30) ----------------
 *
 * superski (Discord, 2026-08-11): "The pnl on the actual instant trader vs
 * on the hot bar isn't synced sometimes properly". The batch poller
 * deliberately skips the token on screen (its price comes from the page's
 * own feed) — but its LAST batch quote lingered in the live-price map and
 * OUTRANKED the feed, so the chip and the position card marked the same bag
 * from two different venues and disagreed about its P&L.
 */

test('O-30: the on-screen token is marked from the page feed, not a lingering batch quote', () => {
  const { state } = twoPositionState();
  // While BONK was off-screen the poller cached a Dexscreener quote…
  const livePrices = { [BONK]: { priceNative: 0.0000012, priceUsd: 0.00024 } };
  // …but BONK is on screen now and its page feed reads 2e-6.
  const rows = Q.positionRows(state, livePrices, BONK, { priceNative: 0.000002, priceUsd: 0.0004 });

  const bonk = rows.find((row) => row.mint === BONK);
  assert.equal(bonk.priceNative, 0.000002,
    'the chip must mark the same number the position card shows — the page feed');
  assert.equal(bonk.stale, false, 'a live page feed is not stale');
  const wif = rows.find((row) => row.mint === WIF);
  assert.equal(wif.stale, true, 'the other chips keep their own staleness rules');
});

test('O-30: with the page feed quiet, the active chip falls back exactly as before', () => {
  const { state } = twoPositionState();
  const livePrices = { [BONK]: { priceNative: 0.0000012, priceUsd: 0.00024 } };
  const rows = Q.positionRows(state, livePrices, BONK, null);
  const bonk = rows.find((row) => row.mint === BONK);
  assert.equal(bonk.priceNative, 0.0000012,
    'no page quote means the batch quote stays in charge — no behavior change off the fix path');
});

test('O-30: the page quote never prices anyone else\'s chip', () => {
  const { state } = twoPositionState();
  const rows = Q.positionRows(state, {}, BONK, { priceNative: 0.000002 });
  const wif = rows.find((row) => row.mint === WIF);
  assert.equal(wif.stale, true, 'the off-screen chip must not inherit the on-screen feed');
});

test('O-30: the bar wires the page feed through, and setToken clears the stale cache', () => {
  const contentSrc = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

  assert.match(contentSrc, /Q\.positionRows\(state, livePositionPrices, token && token\.mint, activeQuote\)/,
    'renderPositionsBar must hand the page feed quote to the row builder');
  assert.match(contentSrc, /Date\.now\(\) - lastPriceAt < Q\.STALE_AFTER_MS/,
    'the injected quote must be bounded by the same staleness mark the header uses');
  assert.match(contentSrc, /delete livePositionPrices\[token\.mint\]/,
    'a token coming ON screen must shed whatever batch quote was cached while it was off-screen');
});

/* ---------------- portfolio totals ---------------- */

test('portfolio totals equal the sum of their rows', () => {
  const { state } = twoPositionState();
  const rows = Q.positionRows(state, {
    [BONK]: { priceNative: 0.000002 },
    [WIF]: { priceNative: 0.001 },
  }, null);

  const summary = Q.portfolioSummary(rows);
  const expectedPnl = rows.reduce((s, r) => s + r.pnlSol, 0);
  const expectedValue = rows.reduce((s, r) => s + r.valueSol, 0);

  assert.equal(summary.count, 2);
  assert.ok(Math.abs(summary.pnlSol - expectedPnl) < 1e-12);
  assert.ok(Math.abs(summary.valueSol - expectedValue) < 1e-12);
  assert.equal(summary.winners, 1);
  assert.equal(summary.losers, 1);
  assert.equal(summary.up, summary.pnlSol >= 0);
  assert.equal(summary.anyStale, false);
});

test('an empty portfolio summarizes cleanly instead of dividing by zero', () => {
  const summary = Q.portfolioSummary([]);
  assert.equal(summary.count, 0);
  assert.equal(summary.pnlSol, 0);
  assert.equal(summary.pnlPct, 0);
  assert.equal(Number.isFinite(summary.pnlPct), true);
});

test('the summary flags staleness when any single row lacks a live quote', () => {
  const { state } = twoPositionState();
  const rows = Q.positionRows(state, { [BONK]: { priceNative: 0.000002 } }, null);
  assert.equal(Q.portfolioSummary(rows).anyStale, true);
});

/* ---------------- chip navigation ---------------- */

test('a chip links to the site the position was opened on', () => {
  const padre = S.tokenUrlFor(BONK, { siteId: 'padre' });
  const photon = S.tokenUrlFor(BONK, { siteId: 'photon', pairAddress: 'PAIR9' });

  assert.match(padre, /padre\.gg/);
  assert.ok(padre.includes(BONK), 'the mint must appear in the destination URL');
  assert.match(photon, /tinyastro\.io/);
  assert.ok(photon.includes('PAIR9'), 'a pair-routed site must use the pair address');
});

test('every shipped adapter can build a usable token URL', () => {
  for (const adapter of S.ADAPTERS) {
    const url = S.tokenUrlFor(BONK, { siteId: adapter.id, pairAddress: 'PAIR9' });
    assert.match(url, /^https:\/\//, `${adapter.id} must produce an absolute URL`);
    assert.ok(url.includes(BONK) || url.includes('PAIR9'),
      `${adapter.id} URL must identify the token`);
  }
});

test('an unknown site still yields a working Dexscreener link', () => {
  const url = S.tokenUrlFor(BONK, { siteId: 'not-a-real-site' });
  assert.match(url, /dexscreener\.com\/solana\//);
  assert.ok(url.includes(BONK));
});

test('a missing mint produces no link rather than a broken one', () => {
  assert.equal(S.tokenUrlFor('', { siteId: 'padre' }), null);
  assert.equal(S.tokenUrlFor(null, {}), null);
});

/* ---------------- the SHIPPED overlay renders the bar ---------------- */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.join(__dirname, '..');

/**
 * Boot the real content.js against a fake DOM and a stubbed batch endpoint,
 * then inspect the actual chips it produced. This drives the shipped file
 * rather than a re-implementation of its logic.
 */
function runOverlayBar(positions, opts) {
  const options = opts || {};
  const timers = [];
  let now = 2_000_000;
  const nodesById = {};
  const created = [];

  function makeNode(tag) {
    const node = {
      // Recorded, not no-op: the O-15 settle test asserts the bar's inset.
      tag, style: { _props: {}, setProperty(k, v) { this._props[k] = v; }, removeProperty(k) { delete this._props[k]; } }, dataset: {},
      children: [], childNodes: [], _listeners: {},
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
      appendChild(c) {
        // Match DOM semantics: re-appending moves rather than duplicates.
        const i = this.children.indexOf(c);
        if (i >= 0) this.children.splice(i, 1);
        if (c._parent && c._parent !== this) c._parent.removeChild(c);
        c._parent = this;
        this.children.push(c); this.childNodes = this.children; return c;
      },
      removeChild(c) {
        const i = this.children.indexOf(c);
        if (i >= 0) this.children.splice(i, 1);
        if (c._parent === this) c._parent = null;
      },
      // A real node detaches itself from its parent; a no-op stub would hide
      // exactly the cleanup bugs these tests exist to catch.
      remove() { if (this._parent) this._parent.removeChild(this); },
      setAttribute() {}, getAttribute() { return null; },
      addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); },
      fire(type) { (this._listeners[type] || []).forEach((fn) => fn({ target: this, clientX: 0, clientY: 0, preventDefault() {} })); },
      querySelector(sel) {
        const cls = /\.([a-z-]+)/.exec(sel);
        if (cls) {
          const hit = this.children.find((c) => c.classList._s.has(cls[1]));
          if (hit) return hit;
          // Chips build their innards via innerHTML; synthesize stable stand-ins.
          this._syn = this._syn || {};
          if (!this._syn[cls[1]]) this._syn[cls[1]] = makeNode('span');
          return this._syn[cls[1]];
        }
        return makeNode('span');
      },
      querySelectorAll() { return []; },
      getBoundingClientRect() { return { top: 0 }; },
      attachShadow() { return shadowRoot; },
      focus() {}, closest() { return null; },
      get offsetWidth() { return 1; },
    };
    created.push(node);
    return node;
  }

  const shadowRoot = {
    set innerHTML(v) { this._h = v; }, get innerHTML() { return this._h || ''; },
    getElementById(id) { if (!nodesById[id]) nodesById[id] = makeNode('div'); return nodesById[id]; },
    querySelector() { return makeNode('div'); }, querySelectorAll() { return []; },
    appendChild() {},
  };

  const doc = {
    readyState: 'complete', hidden: Boolean(options.hidden), title: 'x',
    body: Object.assign(makeNode('body'), { innerText: '' }),
    documentElement: makeNode('html'), head: makeNode('head'),
    createElement: (t) => makeNode(t),
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    addEventListener: () => {}, createTreeWalker: () => ({ nextNode: () => null }),
    // O-15: the header strip the bar measures. options.headerEdge() names the
    // right edge of the site's painted header, 0 = nothing painted yet.
    elementFromPoint: (x) => {
      const edge = options.headerEdge ? options.headerEdge() : 0;
      if (!(edge > 0) || x >= edge) return null;
      return { getBoundingClientRect: () => ({ width: Math.min(edge, 400), right: edge, top: 8 }) };
    },
  };

  const url = options.url || 'https://example.com/browse';
  const parsedUrl = new URL(url);
  const winListeners = {};
  const win = {
    // Recorded, not no-op: tests forge window events (bridge messages,
    // gestures) exactly the way a page's own scripts would.
    addEventListener: (type, fn) => { (winListeners[type] = winListeners[type] || []).push(fn); },
    removeEventListener: () => {}, postMessage: () => {},
    location: { href: url, origin: parsedUrl.origin, hostname: parsedUrl.hostname, pathname: parsedUrl.pathname, search: '' },
    getComputedStyle: () => ({ right: '18px', top: '84px' }),
    confirm: () => false,
  };
  win.window = win;

  const storage = {
    pt_settings: Object.assign(E.defaultSettings(), options.initialSettings),
    pt_state: options.state,
  };
  const storageListeners = [];
  let batchCalls = 0;
  const sandbox = {
    window: win, self: win, document: doc, location: win.location, console,
    URLSearchParams, URL,
    AbortController: function () { this.signal = {}; this.abort = () => {}; },
    MutationObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
    TextDecoder: function () { this.decode = () => ''; },
    ResizeObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
    Set, Map, WeakSet, WeakMap, Promise, JSON, Math, Number, String, Array, Object,
    Boolean, RegExp, Error, isNaN, parseInt, parseFloat, Infinity, NaN,
    Date: Object.assign(function () {}, { now: () => now }),
    setTimeout: (fn, ms) => { timers.push({ fn, at: now + (ms || 0) }); return timers.length; },
    clearTimeout: () => {}, clearInterval: (id) => { if (timers[id - 1]) timers[id - 1].dead = true; },
    setInterval: (fn, ms) => { timers.push({ fn, at: now + ms, every: ms }); return timers.length; },
    fetch: (u) => {
      const s = String(u);
      if (s.includes('/tokens/') && s.includes(',')) batchCalls++;
      const wanted = decodeURIComponent(s.split('/tokens/')[1] || '').split(',');
      const pairs = [];
      for (const mint of wanted) {
        const px = options.livePrices && options.livePrices[mint];
        if (px) pairs.push(pair(mint, options.symbols?.[mint] || 'TKN', px, 100000));
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ pairs }) });
    },
    chrome: {
      runtime: {
        id: 'papertrench-test',
        getURL: (p) => 'chrome-extension://x/' + p,
        sendMessage: (msg) => {
          // F-14: the worker owns the attest chain; the harness acks appends
          // so a fill does not trip the F-28 failure toast mid-test.
          if (msg.type === 'pt_attest_append') return Promise.resolve({ ok: true, seq: 0, head: 'pt-test-head' });
          const R = win.PaperTrenchResolver;
          if (msg.type === 'pt_resolve') {
            // The test's stand-in for the background resolver: it decides
            // whether an address prices, exactly like pt_resolve in production.
            const data = options.resolve && options.resolve[msg.address];
            return Promise.resolve(data || null);
          }
          if (!R) return Promise.resolve({});
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
          // Chrome notifies every listener on write; reproducing that is what
          // makes the cross-tab path testable at all.
          set: (obj, cb) => {
            const changes = {};
            // Chrome delivers a STRUCTURED CLONE across the process
            // boundary, never the caller's object. Handing back the same
            // reference let a self-write guard match here while it could
            // never match in a browser -- which is exactly how F-41's
            // duplicate-fill bug stayed invisible to this suite. A fake
            // must copy what the platform copies.
            for (const k of Object.keys(obj)) {
              changes[k] = { newValue: JSON.parse(JSON.stringify(obj[k])), oldValue: storage[k] };
            }
            Object.assign(storage, obj);
            for (const fn of storageListeners) { try { fn(changes, 'local'); } catch (e) { /* asserted elsewhere */ } }
            if (cb) cb();
            return Promise.resolve();
          },
        },
        onChanged: { addListener: (fn) => storageListeners.push(fn) },
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
    step = step || 200;
    for (let e = 0; e < ms; e += step) {
      now += step;
      for (let i = 0; i < timers.length; i++) {
        const t = timers[i];
        if (t.dead || t.at > now) continue;
        if (t.every) t.at = now + t.every; else t.dead = true;
        try { t.fn(); } catch (err) { /* surfaced by assertions */ }
      }
      for (let k = 0; k < 8; k++) await Promise.resolve();
    }
  }

  return {
    advance,
    // Publish state the way the extension does. Chrome serializes across the
    // storage boundary, so a listener always receives a DISTINCT object; the
    // structured clone here reproduces that rather than handing back the same
    // reference the content script already holds.
    writeState: (next) => sandbox.chrome.storage.local.set({ pt_state: JSON.parse(JSON.stringify(next)) }),
    // Settings the content script has saved right now (its own writes land here).
    settings: () => storage.pt_settings,
    // Wallet state as stored (positions, rounds, attest chain).
    state: () => storage.pt_state,
    // Deliver any window event to the content script's own listeners — the
    // same channel a malicious page uses to forge bridge traffic.
    fireWindow: (type, ev) => (winListeners[type] || []).forEach((fn) => fn(ev)),
    // Forge a window.postMessage the way page scripts do. Defaults to the
    // page's own origin; pass a foreign one to simulate cross-origin posts.
    fireBridgeMessage: (data, origin) => (winListeners['message'] || []).forEach((fn) => fn({
      source: win, origin: origin === undefined ? parsedUrl.origin : origin, data,
    })),
    // Publish settings the way another tab or the dashboard would.
    writeSettings: (next) => sandbox.chrome.storage.local.set({ pt_settings: JSON.parse(JSON.stringify(next)) }),
    bar: () => nodesById['pt-bar'],
    rail: () => nodesById['pt-bar-rail'],
    total: () => nodesById['pt-bar-total'],
    tab: () => nodesById['pt-bar-tab'],
    hideBtn: () => nodesById['pt-bar-hide'],
    html: () => nodesById['html'],
    root: doc.documentElement,
    batchCalls: () => batchCalls,
    nav: () => win.location.href,
    setHidden: (v) => { doc.hidden = v; },
  };
}

function seededState(prices) {
  const settings = E.defaultSettings();
  settings.feeBps = 0;
  const state = E.defaultState(settings);
  E.buy(state, settings, { ts: 1000, mint: BONK, symbol: 'BONK', site: 'padre', priceNative: 0.000001, solAmount: 1 });
  E.buy(state, settings, { ts: 2000, mint: WIF, symbol: 'WIF', site: 'photon', priceNative: 0.002, solAmount: 2 });
  return state;
}

test('the shipped overlay renders a chip per open position on a page with no token', async () => {
  const ov = runOverlayBar(null, {
    state: seededState(),
    livePrices: { [BONK]: 0.000002, [WIF]: 0.001 },
    symbols: { [BONK]: 'BONK', [WIF]: 'WIF' },
  });

  await ov.advance(3000);

  const rail = ov.rail();
  assert.ok(rail, 'the bar rail must exist');
  assert.equal(rail.children.length, 2, `expected 2 chips, got ${rail.children.length}`);
  assert.equal(ov.bar().classList.contains('pt-hidden'), false, 'the bar must be visible while positions are open');
  assert.ok(ov.batchCalls() > 0, 'off-screen positions must be priced via the batch endpoint');

  // One winner, one loser — colored by total P&L, never tick direction.
  const classes = rail.children.map((c) => (c.classList.contains('pt-green') ? 'green' : c.classList.contains('pt-red') ? 'red' : 'none'));
  assert.ok(classes.includes('green'), 'the 2x position must render green');
  assert.ok(classes.includes('red'), 'the halved position must render red');
});

test('repeated ticks update chips in place instead of duplicating them', async () => {
  const ov = runOverlayBar(null, {
    state: seededState(),
    livePrices: { [BONK]: 0.000002, [WIF]: 0.001 },
  });

  await ov.advance(3000);
  const first = ov.rail().children.length;
  await ov.advance(8000);
  assert.equal(ov.rail().children.length, first,
    'the rail must not accumulate duplicate chips across renders');
});

test('the bar stays hidden when no paper positions are open', async () => {
  const settings = E.defaultSettings();
  const ov = runOverlayBar(null, { state: E.defaultState(settings), livePrices: {} });
  await ov.advance(2500);
  assert.equal(ov.bar().classList.contains('pt-hidden'), true,
    'an empty portfolio must not show a bar');
  assert.equal(ov.batchCalls(), 0, 'no positions means no batch requests');
});

test('hiding the bar collapses it to a restore tab and releases the page offset', async () => {
  const ov = runOverlayBar(null, {
    state: seededState(),
    livePrices: { [BONK]: 0.000002, [WIF]: 0.001 },
  });
  await ov.advance(3000);
  assert.equal(ov.bar().classList.contains('pt-hidden'), false);

  ov.hideBtn().fire('click');
  assert.equal(ov.bar().classList.contains('pt-hidden'), true, 'the bar must hide on demand');
  assert.equal(ov.tab().style.display, 'flex', 'a restore tab must appear');

  ov.tab().fire('click');
  assert.equal(ov.bar().classList.contains('pt-hidden'), false, 'the tab must bring the bar back');
});

/* ---------------- "it follows me everywhere" — hide state persists ----------------
 *
 * The complaint: hide the bar once, and it pops back on the next page, the
 * next tab, the next session. The fix makes the collapsed state a saved
 * setting, so every new context starts from the user's choice.
 */

test('hiding the bar saves the collapse as a setting, and restoring saves that too', async () => {
  const ov = runOverlayBar(null, {
    state: seededState(),
    livePrices: { [BONK]: 0.000002, [WIF]: 0.001 },
  });
  await ov.advance(3000);
  assert.equal(ov.settings().positionsBarHidden, false, 'the bar starts expanded');

  ov.hideBtn().fire('click');
  assert.equal(ov.settings().positionsBarHidden, true,
    'hiding must persist to settings, not just to this page\'s memory');
  assert.equal(ov.settings().settingsRevision, E.SETTINGS_REVISION,
    'the save must carry the current revision so the migration never re-adopts the default');

  ov.tab().fire('click');
  assert.equal(ov.settings().positionsBarHidden, false,
    'restoring must persist too — the choice is sticky in BOTH directions');
});

test('a saved hidden state keeps the bar collapsed on a fresh page', async () => {
  const ov = runOverlayBar(null, {
    state: seededState(),
    livePrices: { [BONK]: 0.000002, [WIF]: 0.001 },
    initialSettings: { positionsBarHidden: true, settingsRevision: E.SETTINGS_REVISION },
  });

  await ov.advance(3000);

  assert.equal(ov.bar().classList.contains('pt-hidden'), true,
    'the bar must not "follow" a user who already hid it');
  assert.equal(ov.tab().style.display, 'flex', 'the restore tab is the only visible trace');

  ov.tab().fire('click');
  assert.equal(ov.bar().classList.contains('pt-hidden'), false,
    'one click brings it back');
  assert.equal(ov.settings().positionsBarHidden, false);
});

test('a hide toggled from another tab or the dashboard applies live, without a reload', async () => {
  const ov = runOverlayBar(null, {
    state: seededState(),
    livePrices: { [BONK]: 0.000002, [WIF]: 0.001 },
  });
  await ov.advance(3000);
  assert.equal(ov.bar().classList.contains('pt-hidden'), false);

  // Another context saves the setting the normal way (at the current revision).
  ov.writeSettings(Object.assign(E.defaultSettings(), {
    settingsRevision: E.SETTINGS_REVISION, positionsBarHidden: true,
  }));
  await ov.advance(400);
  assert.equal(ov.bar().classList.contains('pt-hidden'), true,
    'the storage watcher must collapse the bar when the setting changes elsewhere');
  assert.equal(ov.tab().style.display, 'flex');

  ov.writeSettings(Object.assign(E.defaultSettings(), {
    settingsRevision: E.SETTINGS_REVISION, positionsBarHidden: false,
  }));
  await ov.advance(400);
  assert.equal(ov.bar().classList.contains('pt-hidden'), false,
    'and expand it again when the setting flips back');
});

test('a hidden tab backs off from polling instead of hammering the API', async () => {
  const ov = runOverlayBar(null, {
    state: seededState(),
    livePrices: { [BONK]: 0.000002, [WIF]: 0.001 },
    hidden: true,
  });

  await ov.advance(12000);
  assert.ok(ov.batchCalls() <= 1,
    `a background tab must poll at most once in 12s; got ${ov.batchCalls()}`);
});

test('closing a position releases its chip and cached quote', async () => {
  const settings = E.defaultSettings();
  settings.feeBps = 0;
  const state = E.defaultState(settings);
  E.buy(state, settings, { ts: 1000, mint: BONK, symbol: 'BONK', site: 'padre', priceNative: 0.000001, solAmount: 1 });
  E.buy(state, settings, { ts: 2000, mint: WIF, symbol: 'WIF', site: 'photon', priceNative: 0.002, solAmount: 2 });

  const ov = runOverlayBar(null, {
    state,
    livePrices: { [BONK]: 0.000002, [WIF]: 0.001 },
  });
  await ov.advance(3000);
  assert.equal(ov.rail().children.length, 2);

  // Fully exit one position and publish it the way a real sell does, through
  // the storage the content script watches.
  E.sell(state, settings, { ts: 3000, mint: BONK, qtyFraction: 1, priceNative: 0.000002 });
  ov.writeState(state);
  await ov.advance(2000);

  assert.equal(ov.rail().children.length, 1,
    'a closed position must lose its chip rather than linger in the rail');
});

/* ---------------- layout: left-anchored, adaptive ---------------- */

test('the bar anchors to the left header space, not over the site controls', () => {
  const css = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  const block = /\.pt-bar \{([\s\S]*?)\}/.exec(css);
  assert.ok(block, 'the bar must define a positioning block');

  assert.match(block[1], /left:\s*var\(--pt-bar-left/,
    'the bar must be anchored from the LEFT so it fills the empty header space');
  assert.match(block[1], /right:\s*auto/,
    'anchoring right would place it over the site\'s own wallet/settings buttons');
});

test('the measured offset is clamped to a sane range', () => {
  const src = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  const fn = src.slice(src.indexOf('function measureBarLeft'), src.indexOf('function positionBar'));

  assert.match(fn, /MIN_LEFT/, 'a floor prevents covering the site logo');
  assert.match(fn, /MAX_LEFT/, 'a ceiling prevents drifting off into the page');
  assert.match(fn, /try \{[\s\S]*catch/,
    'measurement must degrade to a default rather than throwing on exotic layouts');
});

test('the P&L row is given its own full-width line so the USD value is not clipped', () => {
  const src = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');

  // The reported defect: "· +$1,234.56" was cut off on the right.
  assert.match(src, /class="row row-pnl"/,
    'the P&L row must use the dedicated full-width layout');
  const rule = /\.pt-pos \.pnl \{([\s\S]*?)\}/.exec(src);
  assert.ok(rule, '.pt-pos .pnl must be styled');
  assert.match(rule[1], /width:\s*100%/, 'the P&L value must span the card');
  assert.match(rule[1], /white-space:\s*normal/,
    'the P&L must be allowed to wrap rather than be truncated');
  assert.doesNotMatch(rule[1], /text-overflow:\s*ellipsis/,
    'the P&L value must never be ellipsised — it is the number being watched');
});

/* ---------------- a website must never be able to trigger a trade ----------------
 *
 * Reported defect: bridge messages are plain postMessage calls, and any script
 * on the page can forge { source:'papertrench-bridge', type:'row-buy' }. Before
 * the fix the content script honoured that and ran a fill with no user input.
 * A fill is now only allowed inside a window that began with a genuine,
 * trusted user gesture.
 */

const ROW_BUY_ADDR = BONK;

function rowBuyForge(address) {
  return { source: 'papertrench-bridge', type: 'row-buy', payload: { address: address || ROW_BUY_ADDR } };
}

function pricedResolve() {
  return {
    [ROW_BUY_ADDR]: {
      mint: ROW_BUY_ADDR, symbol: 'BONK', name: 'Bonk',
      priceNative: 0.000001, priceUsd: 0.0002, mcap: 1e6,
    },
  };
}

function openPositionCount(ov) {
  // A null state means no fill ever wrote the wallet — i.e. zero positions.
  const st = ov.state();
  return st ? Object.keys(st.positions || {}).length : 0;
}

test('a genuine tap still fills: trusted gesture + bridge row-buy opens the position', async () => {
  const ov = runOverlayBar(null, {
    url: 'https://axiom.trade/pulse',
    state: null,
    resolve: pricedResolve(),
  });

  await ov.advance(1200);
  // The user really taps the chip: the OS delivers a trusted pointerdown.
  ov.fireWindow('pointerdown', { isTrusted: true });
  ov.fireBridgeMessage(rowBuyForge());
  await ov.advance(1200);

  assert.equal(openPositionCount(ov), 1,
    'a real gesture followed by the chip tap must still fill — the fix must not break buying');
});

test('a website posting row-buy with no gesture gets nothing', async () => {
  const ov = runOverlayBar(null, {
    url: 'https://axiom.trade/pulse',
    state: null,
    resolve: pricedResolve(),
  });

  await ov.advance(1200);
  // No gesture of any kind — a silent script-driven forge.
  ov.fireBridgeMessage(rowBuyForge());
  await ov.advance(1200);

  assert.equal(openPositionCount(ov), 0,
    'a forged row-buy without a user gesture must not open a position');
});

test('a synthetic (script-dispatched) gesture does not count as a gesture', async () => {
  const ov = runOverlayBar(null, {
    url: 'https://axiom.trade/pulse',
    state: null,
    resolve: pricedResolve(),
  });

  await ov.advance(1200);
  // Page scripts can dispatchEvent a pointerdown, but it arrives untrusted.
  ov.fireWindow('pointerdown', { isTrusted: false });
  ov.fireBridgeMessage(rowBuyForge());
  await ov.advance(1200);

  assert.equal(openPositionCount(ov), 0,
    'an isTrusted=false gesture must not arm the trade window');
});

test('a trusted gesture is only valid inside the trade window', async () => {
  const ov = runOverlayBar(null, {
    url: 'https://axiom.trade/pulse',
    state: null,
    resolve: pricedResolve(),
  });

  await ov.advance(1200);
  ov.fireWindow('pointerdown', { isTrusted: true });
  // The user taps something else and walks away; far later a script forges.
  await ov.advance(30_000);
  ov.fireBridgeMessage(rowBuyForge());
  await ov.advance(1200);

  assert.equal(openPositionCount(ov), 0,
    'a gesture must expire — a stale tap cannot authorise a later forged fill');
});

test('a cross-origin postMessage is never read as bridge traffic', async () => {
  const ov = runOverlayBar(null, {
    url: 'https://axiom.trade/pulse',
    state: null,
    resolve: pricedResolve(),
  });

  await ov.advance(1200);
  ov.fireWindow('pointerdown', { isTrusted: true });
  // An iframe from another origin posts the same payload.
  ov.fireBridgeMessage(rowBuyForge(), 'https://evil.example');
  await ov.advance(1200);

  assert.equal(openPositionCount(ov), 0,
    'a message from a foreign origin must be dropped before any trade logic runs');
});

/* ---------------- O-15: the bar measures until the header settles ------- */

test('O-15: a late-painting header is measured when it arrives, not missed forever', async () => {
  // The header paints LATE — after the old fixed 400ms/1500ms samples would
  // both have fired and given up on the fallback inset over the site's nav.
  let edge = 0;
  const ov = runOverlayBar(null, {
    url: 'https://axiom.trade/pulse',
    state: seededState(),
    resolve: pricedResolve(),
    headerEdge: () => edge,
  });

  await ov.advance(2000);
  assert.equal(ov.bar().style._props['--pt-bar-left'], '210px',
    'with no header painted the bar sits at the fallback inset');

  edge = 300; // the site header finally paints, 2s in
  await ov.advance(1600); // two settle beats
  assert.equal(ov.bar().style._props['--pt-bar-left'], '318px',
    'the settle loop must pick up the real header edge (+18px clearance)');
});

test('O-15: a user-saved coordinate ends the measuring — their placement wins', async () => {
  let edge = 300;
  const ov = runOverlayBar(null, {
    url: 'https://axiom.trade/pulse',
    state: seededState(),
    resolve: pricedResolve(),
    headerEdge: () => edge,
    initialSettings: { positionsBarLeft: 42, positionsBarTop: 9 },
  });

  await ov.advance(2400);
  assert.equal(ov.bar().style._props['--pt-bar-left'], '42px',
    'a dragged bar keeps its saved place; measuring must not fight the user');
});
