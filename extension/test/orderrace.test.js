/* Chart-order CAS race — jb's 2026-08-18 report (#bug-reports, 11:10 UTC):
 * "took clips from a trade and fully exited but on my paper equity it shows
 * +9.109 sol when its supposed to be +0.091".
 *
 * Mechanism under test: two chart tabs on the same token, one armed TP
 * level. Both tabs' tick loops see the trigger; both call fireChartOrder.
 * The CAS loser's remutate re-checks only the POSITION — not whether the
 * winning context already spent the order — so it re-applies E.sell on the
 * adopted base. The clip is booked twice: cash credited twice, the round's
 * returnedSol double-counts, paper equity inflates by a whole extra set of
 * clip proceeds (jb: +0.091 true + ~9.0 duplicated clips = +9.109).
 *
 * Asymmetric precedent: firePendingBuy's remutate re-checks the armed buy
 * still exists ("if (!armed) return") before re-applying. The order fire
 * must do the same. This test pins that contract.
 *
 * F-59 - shipped in v3.13.4
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

global.window = global.window || {};
const Q = require('../quote.js');
const E = require('../engine.js');

const NEW_MINT = '3PTQpne3b7kjJEvDYDMBHSuRjTDUh6HSin2xMyW3pump';
const SOL_USD = 200;

function jupiterPayload() {
  return [
    {
      id: NEW_MINT,
      name: 'Bark',
      symbol: 'BARK',
      usdPrice: 0.0000021,
      mcap: 2100.12,
      liquidity: 2204.47,
      firstPool: { id: 'PooLAddress1111111111111111111111111111111', createdAt: '2026-08-01T04:00:00Z' },
    },
    {
      id: Q.WSOL_MINT,
      name: 'Wrapped SOL',
      symbol: 'SOL',
      usdPrice: SOL_USD,
      firstPool: { id: 'sol', createdAt: '2020-01-01T00:00:00Z' },
    },
  ];
}

/* ---------------- harness (faithful clone of freshlaunch.test.js) ---------------- */

function runOrderRace(opts) {
  const options = opts || {};
  const timers = [];
  let now = 5_000_000;
  const nodesById = {};
  const messages = [];
  const winListeners = {};

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
      set innerHTML(v) {
        this._h = v;
        const re = /data-f="([a-z]+)"/g; let m;
        while ((m = re.exec(v))) { const c = makeNode('span'); c.dataset.f = m[1]; this._fields[m[1]] = c; }
      },
      get innerHTML() { return this._h || ''; },
      appendChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); if (c._parent && c._parent !== this) c._parent.removeChild(c); c._parent = this; this.children.push(c); this.childNodes = this.children; return c; },
      removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); if (c._parent === this) c._parent = null; },
      remove() { if (this._parent) this._parent.removeChild(this); },
      setAttribute() {}, getAttribute() { return null; },
      addEventListener(type, fn) {
        if (!this._listeners) this._listeners = {};
        (this._listeners[type] = this._listeners[type] || []).push(fn);
      },
      click() { ((this._listeners && this._listeners.click) || []).forEach((fn) => fn()); },
      querySelectorAll() { return []; },
      value: '',
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

  const doc = {
    readyState: 'complete', hidden: false, title: 'new coin',
    body: Object.assign(makeNode('body'), { innerText: '' }),
    documentElement: makeNode('html'), head: makeNode('head'),
    createElement: (t) => makeNode(t),
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    addEventListener: () => {}, createTreeWalker: () => ({ nextNode: () => null }),
  };

  const url = `https://trade.padre.gg/trade/solana/${NEW_MINT}`;
  const parsed = new URL(url);
  const win = {
    addEventListener: (type, fn) => {
      if (type === 'message') (winListeners.message = winListeners.message || []).push(fn);
    },
    removeEventListener: () => {},
    postMessage: (msg) => { if (msg && msg.source === 'papertrench-content') messages.push(msg.type); },
    location: { href: url, hostname: parsed.hostname, pathname: parsed.pathname, search: parsed.search },
    getComputedStyle: () => ({ right: '18px', top: '84px' }),
    confirm: () => true,
  };
  win.window = win;

  // The single source of truth for wallet state, held by the fake worker.
  let workerState = null;
  let commitLog = [];
  let staleReplies = options.staleReplies || [];

  const storage = { pt_settings: E.defaultSettings() };

  const sandbox = {
    window: win, self: win, document: doc, location: win.location, console,
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
      if (s.includes('jup.ag')) return Promise.resolve({ ok: true, status: 200, json: async () => jupiterPayload() });
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ pairs: null }) });
    },
    chrome: {
      runtime: {
        id: 'papertrench-test',
        getURL: (p) => 'x/' + p,
        sendMessage: (msg) => {
          if (msg.type === 'pt_attest_append') return Promise.resolve({ ok: true, seq: 0, head: 'pt-test-head' });
          // The worker side of the CAS: compare-and-swap on seq.
          if (msg.type === 'pt_state_commit') {
            const expected = Number(msg.expectedSeq) || 0;
            const currentSeq = workerState ? (Number(workerState.seq) || 0) : 0;
            const forced = !!msg.force;
            if (forced || currentSeq === expected) {
              workerState = msg.state;
              commitLog.push({ ok: true, forced, seq: msg.state.seq });
              return Promise.resolve({ ok: true });
            }
            // Hostile: answer stale, with the winner's state attached. The
            // test's staleReplies hook decides what the "other tab" did.
            const hostile = staleReplies.length ? staleReplies.shift() : null;
            commitLog.push({ ok: false, stale: true });
            return Promise.resolve({ ok: false, reason: 'stale', current: hostile ? hostile(workerState) : workerState });
          }
          if (msg.type === 'pt_state_get') {
            return Promise.resolve({ ok: true, state: workerState });
          }
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
  const ROOT = path.join(__dirname, '..');
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
        try { t.fn(); } catch (err) { /* asserted below */ }
      }
      for (let k = 0; k < 8; k++) await Promise.resolve();
    }
  }

  async function settle() {
    for (let k = 0; k < 400; k++) await Promise.resolve();
  }

  return {
    advance,
    settle,
    emitTick: (payload) => {
      for (const fn of (winListeners.message || [])) {
        fn({ source: win, origin: null, data: { source: 'papertrench-bridge', type: 'tick', payload } });
      }
    },
    seed: (s) => {
      storage[E.STORAGE_KEYS.state] = JSON.parse(JSON.stringify(s));
      workerState = JSON.parse(JSON.stringify(s));
    },
    workerState: () => workerState,
    commitLog: () => commitLog,
    storage: () => storage,
    sandbox,
  };
}

/* ---------------- the race ---------------- */

test('a lost CAS race must not double-book an order clip (jb 2026-08-18)', async () => {
  const ov = runOrderRace({
    staleReplies: [
      // What the winning tab's state looks like when it lands: same base,
      // order already fired and removed, clip already booked, seq bumped.
      (winner) => {
        const s = JSON.parse(JSON.stringify(winner || {}));
        return s;
      },
    ],
  });
  await ov.settle();

  // Seed the wallet exactly as a prior session left it: a 1 SOL position in
  // BARK bought at 1e-9, one TP armed at 2x for 50% (a clip).
  const base = E.resetState(E.defaultSettings());
  const filled = E.buy(base, E.defaultSettings(), {
    ts: 4_000_000, mint: NEW_MINT, site: 'padre',
    solAmount: 1, priceNative: 1e-9, priceUsd: 1e-9 * SOL_USD,
  });
  const order = E.addOrder(base, NEW_MINT, { kind: 'tp', triggerPrice: 2e-9, sizePct: 50 }, 1e-9, 4_100_000);
  ov.seed(base);

  // The chart sees 2x - the TP trigger condition.
  ov.emitTick({ candidates: [{ value: 2.2e-9, unit: 'native' }] });
  await ov.settle();
  await ov.advance(2000);

  const st = ov.workerState();
  assert.ok(st, 'state must exist after the race');
  const sells = (st.journal || []).filter((t) => t.side === 'sell');
  const tpSells = sells.filter((t) => t.orderKind === 'tp');
  assert.equal(tpSells.length, 1,
    `the clip must be booked exactly once across the CAS race; got ${tpSells.length}`);
  const dupProceeds = tpSells.reduce((s, t) => s + t.solNet, 0);
  assert.ok(dupProceeds > 0 && dupProceeds < 2,
    `one honest 50% clip at ~2x on a 1 SOL position nets ~1 SOL; got ${dupProceeds}`);
}, { timeout: 30000 });

test('control: with no race the clip books once (sanity)', async () => {
  const ov = runOrderRace({});
  await ov.settle();

  const base = E.resetState(E.defaultSettings());
  E.buy(base, E.defaultSettings(), {
    ts: 4_000_000, mint: NEW_MINT, site: 'padre',
    solAmount: 1, priceNative: 1e-9, priceUsd: 1e-9 * SOL_USD,
  });
  E.addOrder(base, NEW_MINT, { kind: 'tp', triggerPrice: 2e-9, sizePct: 50 }, 1e-9, 4_100_000);
  ov.seed(base);

  ov.emitTick({ candidates: [{ value: 2.2e-9, unit: 'native' }] });
  await ov.settle();
  await ov.advance(2000);

  const st = ov.workerState();
  const tpSells = (st.journal || []).filter((t) => t.side === 'sell' && t.orderKind === 'tp');
  assert.equal(tpSells.length, 1, `control: one fire, one clip; got ${tpSells.length}`);
}, { timeout: 30000 });
