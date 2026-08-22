/* Real-time unrealized P&L tracking.
 *
 * The defect this covers: the overlay held a price that only refreshed every
 * 10-20s (and only when the page feed was silent), so unrealized P&L appeared
 * frozen. These tests pin the two things that must hold:
 *
 *   1. the scheduler asks for a fresh quote on a fast cadence, and
 *   2. the P&L the card displays is recomputed from the newest price.
 *
 * The final test drives the SHIPPED content.js heartbeat with a fake clock and
 * a stub network, asserting the rendered P&L actually changes over time.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const Q = require('../quote.js');

global.window = global.window || {};
require('../engine.js');
const E = global.window.PaperEngine;

/* ---------------- scheduler cadence ---------------- */

test('a fresh quote is requested on a fast cadence, not every 10s', () => {
  assert.ok(Q.POLL_INTERVAL_MS <= 500,
    `poll interval must be sub-500ms for a live feel; got ${Q.POLL_INTERVAL_MS}ms`);

  const now = 1_000_000;
  // Nothing fetched yet and no feed -> must poll immediately.
  assert.equal(Q.shouldRequote({ lastPriceAt: 0, lastPollAt: 0, inFlight: false, hidden: false }, now), true);

  // Just polled -> must wait.
  assert.equal(
    Q.shouldRequote({ lastPriceAt: 0, lastPollAt: now - 100, inFlight: false, hidden: false }, now),
    false
  );

  // Interval elapsed -> poll again.
  assert.equal(
    Q.shouldRequote(
      { lastPriceAt: 0, lastPollAt: now - (Q.POLL_INTERVAL_MS + 1), inFlight: false, hidden: false },
      now
    ),
    true
  );
});

test('polling is suspended while the page feed is supplying fresh ticks', () => {
  const now = 1_000_000;
  const s = { lastPriceAt: now - 100, lastPollAt: now - 5_000, inFlight: false, hidden: false };
  assert.equal(Q.shouldRequote(s, now), false, 'a live feed makes polling redundant');

  // Once the feed goes quiet, polling resumes.
  s.lastPriceAt = now - (Q.FEED_FRESH_MS + 1);
  assert.equal(Q.shouldRequote(s, now), true, 'a silent feed must resume polling');
});

test('a live feed still allows a periodic anchor refresh', () => {
  // The anchor supplies the SOL/USD rate, the implied supply, and the
  // validation band centre. A live feed must NOT starve it forever, or a
  // long session drifts — but the refresh happens at a slow cadence and
  // requote() then re-anchors without overriding the live price level.
  const now = 1_000_000;
  const live = { lastPriceAt: now - 100, inFlight: false, hidden: false };

  assert.equal(
    Q.shouldRequote(Object.assign({}, live, { lastPollAt: now - (Q.ANCHOR_REFRESH_MS + 1) }), now),
    true,
    'an aged anchor must be refreshed even while the feed is live'
  );
  assert.equal(
    Q.shouldRequote(Object.assign({}, live, { lastPollAt: 0 }), now),
    true,
    'a never-fetched anchor must be fetched immediately'
  );
  assert.equal(
    Q.shouldRequote(Object.assign({}, live, { lastPollAt: now - 5_000 }), now),
    false,
    'a recent anchor plus a live feed means no network call'
  );
});

test('requests never stack and hidden tabs do not poll', () => {
  const now = 1_000_000;
  const base = { lastPriceAt: 0, lastPollAt: 0, inFlight: false, hidden: false };

  assert.equal(Q.shouldRequote(Object.assign({}, base, { inFlight: true }), now), false);
  assert.equal(Q.shouldRequote(Object.assign({}, base, { hidden: true }), now), false);
});

test('a price that stops updating is reported stale', () => {
  const now = 1_000_000;
  assert.equal(Q.isPriceStale(now - 500, now), false, 'a recent price is not stale');
  assert.equal(Q.isPriceStale(now - (Q.STALE_AFTER_MS + 1), now), true, 'an old price is stale');
  assert.equal(Q.isPriceStale(0, now), true, 'never having had a price counts as stale');
});

test('the header marks a stale price so a frozen P&L is never shown as live', () => {
  const now = 1_000_000;
  const token = { mint: 'Mint1', symbol: 'BONK', priceNative: 0.00000004, priceUsd: 0.000003 };

  const live = Q.headerFields(token, { lastPriceAt: now - 200, now });
  assert.equal(live.stale, false);

  const frozen = Q.headerFields(token, { lastPriceAt: now - (Q.STALE_AFTER_MS + 1), now });
  assert.equal(frozen.stale, true, 'a frozen quote must be flagged');
});

/* ---------------- the displayed P&L follows the price ---------------- */

function openPosition(entryPrice, spend) {
  const settings = E.defaultSettings();
  const state = E.defaultState(settings);
  E.buy(state, settings, {
    ts: Date.now(), mint: 'Mint1', symbol: 'BONK', site: 'padre',
    priceNative: entryPrice, priceUsd: entryPrice * 200, solAmount: spend,
  });
  return { settings, state, pos: state.positions.Mint1 };
}

test('unrealized P&L recomputes from the current price on every mark', () => {
  const entry = 0.001;
  const { pos } = openPosition(entry, 1);

  const flat = Q.positionMark(pos, entry, null);
  const up = Q.positionMark(pos, entry * 2, null);
  const down = Q.positionMark(pos, entry * 0.5, null);

  // Expectations derived from the position itself, not pasted literals.
  assert.ok(Math.abs(flat.pnlSol - (pos.qty * entry - pos.costSol)) < 1e-12);
  assert.ok(Math.abs(up.pnlSol - (pos.qty * entry * 2 - pos.costSol)) < 1e-12);
  assert.ok(Math.abs(down.pnlSol - (pos.qty * entry * 0.5 - pos.costSol)) < 1e-12);

  assert.ok(up.pnlSol > flat.pnlSol, 'a higher price must raise unrealized P&L');
  assert.ok(down.pnlSol < flat.pnlSol, 'a lower price must lower unrealized P&L');
  assert.equal(up.up, true);
  assert.equal(down.up, false);
});

test('P&L percentage and USD value track the same price move', () => {
  const entry = 0.001;
  const { pos } = openPosition(entry, 2);

  const m = Q.positionMark(pos, entry * 1.5, entry * 1.5 * 200);
  assert.ok(Math.abs(m.pnlPct - (m.pnlSol / pos.costSol) * 100) < 1e-9);
  assert.ok(Math.abs(m.pnlUsd - m.pnlSol * 200) < 1e-6, 'USD P&L must use the token\'s own rate');
});

test('a sequence of price ticks produces a strictly moving P&L', () => {
  const entry = 0.001;
  const { pos } = openPosition(entry, 1);

  const prices = [entry, entry * 1.1, entry * 1.25, entry * 1.2, entry * 1.6];
  const pnls = prices.map((p) => Q.positionMark(pos, p, null).pnlSol);

  for (let i = 1; i < pnls.length; i++) {
    assert.notEqual(pnls[i], pnls[i - 1], `tick ${i} must change the P&L`);
    // Direction must follow the price.
    assert.equal(pnls[i] > pnls[i - 1], prices[i] > prices[i - 1]);
  }
  assert.equal(new Set(pnls).size, pnls.length, 'every distinct price gives a distinct P&L');
});

test('markPosition keeps the engine peak/trough in step with live ticks', () => {
  const { state, pos } = openPosition(0.001, 1);

  E.markPosition(state, 'Mint1', 0.003);
  const peak = pos.peakPnlSol;
  E.markPosition(state, 'Mint1', 0.0004);
  const trough = pos.troughPnlSol;

  assert.ok(peak > 0 && trough < 0);
  // The card's number must agree with the engine's mark at the same price.
  const m = Q.positionMark(pos, 0.0004, null);
  assert.ok(Math.abs(m.pnlSol - trough) < 1e-12,
    'the displayed P&L must equal the engine mark at the same price');
});

/* ---------------- the shipped heartbeat, driven on a fake clock ---------------- */

/**
 * Load the real content.js in a browser-like context with controllable timers
 * and a stub network, then advance time and observe the rendered P&L text.
 * This exercises the shipped loop rather than a re-implementation of it.
 */
function runOverlay(priceSeries, opts = {}) {
  const timers = [];
  let now = 1_000_000;

  const textOf = {};
  function makeNode(tag) {
    const node = {
      tag, style: {}, dataset: {}, childNodes: [], _fields: {}, value: '',
      classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
        toggle(c, on) { if (on === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else if (on) this._s.add(c); else this._s.delete(c); },
        contains(c) { return this._s.has(c); } },
      children: [],
      set textContent(v) {
        this._t = v;
        if (this.dataset.f) textOf[this.dataset.f] = v;
        // A real DOM DROPS every child when textContent is set. Without that
        // here, a rebuilt card appends beside the old one and children[0]
        // stays the FIRST card ever built — so fieldText() reads a detached
        // node and reports whatever it last held. That made the position card
        // untestable the moment it started being built before a position
        // existed rather than after.
        if (v === '') { this.children.length = 0; if (this._fields) this._fields = {}; }
      },
      get textContent() { return this._t || ''; },
      set innerHTML(v) {
        this._h = v;
        // Materialise a child node per data-f attribute so querySelector and
        // subsequent textContent writes land on stable, inspectable nodes.
        const re = /data-f="([a-z]+)"/g; let m;
        while ((m = re.exec(v))) {
          const child = makeNode('span');
          child.dataset.f = m[1];
          this._fields[m[1]] = child;
        }
      },
      get innerHTML() { return this._h || ''; },
      appendChild(c) { this.children.push(c); this.childNodes.push(c); },
      removeChild() {}, remove() {}, setAttribute() {},
      addEventListener(type, fn) {
        if (!this._listeners) this._listeners = {};
        if (!this._listeners[type]) this._listeners[type] = [];
        this._listeners[type].push(fn);
      },
      click() { (this._listeners && this._listeners.click || []).forEach((fn) => fn()); },
      querySelector(sel) {
        const m = /data-f="([a-z]+)"/.exec(sel);
        if (m && this._fields && this._fields[m[1]]) return this._fields[m[1]];
        return makeNode('span');
      },
      querySelectorAll() { return []; },
      getBoundingClientRect() { return { top: 0 }; },
      attachShadow() { return shadowRoot; },
      focus() {}, closest() { return null; },
      get offsetWidth() { return 1; },
    };
    return node;
  }

  const shadowNodes = {};
  const shadowRoot = {
    innerHTML: '',
    getElementById(id) {
      if (!shadowNodes[id]) shadowNodes[id] = makeNode('div');
      return shadowNodes[id];
    },
    querySelectorAll() { return []; },
    querySelector() { return makeNode('div'); },
    appendChild() {},
  };

  const doc = {
    readyState: 'complete', hidden: false, title: 'BONK',
    body: Object.assign(makeNode('body'), { innerText: '' }),
    documentElement: makeNode('html'), head: makeNode('head'),
    createElement: (t) => makeNode(t),
    getElementById: () => null,
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener: () => {},
    createTreeWalker: () => ({ nextNode: () => null }),
  };

  const url = 'https://trade.padre.gg/trade/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
  const win = {
    addEventListener: () => {}, removeEventListener: () => {}, postMessage: () => {},
    location: { href: url, hostname: 'trade.padre.gg', pathname: '/trade/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', search: '' },
    getComputedStyle: () => ({ right: '18px', top: '84px' }),
    confirm: () => false,
  };
  win.window = win;

  let priceIdx = 0;
  let fetchCount = 0;
  const storage = {};
  const storageListeners = [];
  const sandbox = {
    window: win, self: win, document: doc, location: win.location, console,
    URLSearchParams, URL,
    AbortController: function () { this.signal = {}; this.abort = () => {}; },
    MutationObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
    TextDecoder: function () { this.decode = () => ''; },
    ResizeObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
    Set, Map, WeakSet, WeakMap, Promise, JSON, Math, Number, String, Array, Object,
    Boolean, RegExp, Error, isNaN, parseInt, parseFloat,
    Date: Object.assign(function () {}, { now: () => now }),
    setTimeout: (fn, ms) => { timers.push({ fn, at: now + (ms || 0), every: null }); return timers.length; },
    clearTimeout: () => {}, clearInterval: (id) => { if (timers[id - 1]) timers[id - 1].dead = true; },
    setInterval: (fn, ms) => { timers.push({ fn, at: now + ms, every: ms }); return timers.length; },
    // Every network quote returns the next price in the series, or is driven
    // by test options (Jupiter-only resolve, failing refresh, etc.).
    fetch: (u) => {
      fetchCount++;
      const url = String(u);
      // Resolver refresh path asks for a re-resolve and can be forced to fail
      // to simulate a freshly migrated coin that has not been re-indexed yet.
      if (opts.refreshFails && url.includes(opts.refreshFails)) {
        return Promise.resolve({ ok: false, status: 404, json: async () => ({}), text: async () => '' });
      }
      // Dexscreener lookups miss for fresh launches / migrations.
      if (opts.jupiterFirst && (url.includes('dexscreener.com') || url.includes('/tokens/'))) {
        return Promise.resolve({ ok: false, status: 404, json: async () => ({}), text: async () => '' });
      }
      // Jupiter price payload for the same mint.
      if (url.includes('jup.ag')) {
        const p = priceSeries[Math.min(priceIdx, priceSeries.length - 1)];
        return Promise.resolve({
          ok: true, status: 200,
          json: async () => ({
            data: {
              'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263': {
                id: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
                mintSymbol: 'BONK', price: String(p * 200),
              },
            },
          }),
        });
      }
      const p = priceSeries[Math.min(priceIdx, priceSeries.length - 1)];
      const body = {
        pair: {
          chainId: 'solana', pairAddress: 'PAIR1', dexId: 'raydium',
          baseToken: { address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', symbol: 'BONK', name: 'Bonk' },
          priceNative: String(p), priceUsd: String(p * 200), liquidity: { usd: 500000 }, marketCap: 1e8,
        },
      };
      return Promise.resolve({ ok: true, status: 200, json: async () => body });
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
      // A real storage backing so a paper position written by the test is
      // visible to the content script's own state reload.
      storage: {
        local: {
          get: (keys, cb) => {
            const out = {};
            const list = Array.isArray(keys) ? keys : [keys];
            for (const k of list) if (k in storage) out[k] = storage[k];
            if (cb) cb(out);
            return Promise.resolve(out);
          },
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
            for (const fn of storageListeners) { try { fn(changes, 'local'); } catch (e) {} }
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

  // Advance the fake clock, firing due timers and draining promises.
  async function advance(ms, step) {
    step = step || 100;
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      now += step;
      for (let i = 0; i < timers.length; i++) {
        const t = timers[i];
        if (t.dead || t.at > now) continue;
        if (t.every) t.at = now + t.every; else t.dead = true;
        try { t.fn(); } catch (e) { /* surfaced via assertions */ }
      }
      // Let any awaited fetch chains settle.
      for (let k = 0; k < 6; k++) await Promise.resolve();
    }
  }

  /**
   * Write a real paper position into the same storage the content script
   * reads, using the shipped engine, so the overlay renders a genuine card.
   */
  function openPaperPosition(spendSol) {
    const settings = E.defaultSettings();
    const state = E.defaultState(settings);
    const entry = priceSeries[Math.min(priceIdx, priceSeries.length - 1)];
    E.buy(state, settings, {
      ts: now, mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
      symbol: 'BONK', site: 'padre', priceNative: entry, priceUsd: entry * 200,
      solAmount: spendSol,
    });
    storage.pt_settings = settings;
    // Route through the same set() the extension uses, so the content script's
    // storage listener fires exactly as it would in Chrome.
    sandbox.chrome.storage.local.set({ pt_state: state });
    return Boolean(state.positions['DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263']);
  }

  /** Read the live text of a position-card field from the built card. */
  function fieldText(name) {
    const host = shadowNodes['pt-position'];
    const card = host && host.children[0];
    const node = card && card._fields && card._fields[name];
    return node ? node.textContent : undefined;
  }

  /** Read the live CSS classes of a position-card field. */
  function fieldClasses(name) {
    const host = shadowNodes['pt-position'];
    const card = host && host.children[0];
    const node = card && card._fields && card._fields[name];
    return node && node.classList ? new Set(node.classList._s) : new Set();
  }

  /** The price the ENGINE last marked the position at (persisted state). */
  function markedPrice() {
    const st = storage.pt_state;
    const pos = st && st.positions && st.positions['DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'];
    return pos ? pos.lastPriceNative : 0;
  }

  /** Programmatically click an element in the shadow root by id. */
  function clickById(id) {
    const node = shadowNodes[id];
    if (node && typeof node.click === 'function') node.click();
  }

  /** Set the value of a shadow input. */
  function setValue(id, v) {
    const node = shadowNodes[id];
    if (node) node.value = String(v);
  }

  /** Read the persisted state object. */
  function currentState() {
    return storage.pt_state;
  }

  return {
    advance, shadowNodes, openPaperPosition, fieldText, fieldClasses, markedPrice,
    clickById, setValue, currentState,
    nextPrice: () => { priceIdx++; },
    fetchCount: () => fetchCount,
  };
}

test('the shipped heartbeat re-quotes repeatedly instead of idling for 10s+', async () => {
  const series = [0.001, 0.0012, 0.0015, 0.0019];
  const ov = runOverlay(series);

  await ov.advance(1200);           // detection + first resolve
  const afterResolve = ov.fetchCount();
  assert.ok(afterResolve > 0, 'the overlay must fetch a quote on load');

  // Across 6 seconds the old build could re-quote at most once (10s interval,
  // further gated). The heartbeat must issue several.
  await ov.advance(6000);
  const polls = ov.fetchCount() - afterResolve;

  const maxUnderOldBehaviour = 1;
  assert.ok(
    polls > maxUnderOldBehaviour,
    `expected repeated re-quotes over 6s; got ${polls} (old 10s path would give <= ${maxUnderOldBehaviour})`
  );

  // Cadence must match the declared budget rather than hammering the API.
  const expected = Math.floor(6000 / Q.POLL_INTERVAL_MS);
  assert.ok(polls <= expected + 2, `polling must respect the interval; got ${polls} in 6s`);
});

test('the rendered unrealized P&L changes as the live price moves', async () => {
  const series = [0.001, 0.002, 0.004];
  const ov = runOverlay(series);

  await ov.advance(1200);           // resolve the token
  assert.ok(ov.openPaperPosition(1), 'must be able to open a paper position');
  await ov.advance(600);            // let the card build

  // Capture the P&L text at each successive market price.
  const samples = [];
  for (let i = 0; i < series.length; i++) {
    ov.nextPrice();
    await ov.advance(2500);
    const t = ov.fieldText('pnl');
    if (t) samples.push(t);
  }

  assert.ok(samples.length >= 2, `expected repeated P&L renders; got ${samples.length}`);
  assert.notEqual(samples[0], samples[samples.length - 1],
    `unrealized P&L must move with the price; it stayed at "${samples[0]}"`);

  // A rising series must end profitable.
  const last = samples[samples.length - 1];
  assert.match(last, /^\+/, `a rising price must show a positive P&L; got "${last}"`);

  // The engine's own mark must keep pace with what the card shows, otherwise
  // peak/trough tracking and the closed round-trip record would drift away
  // from the number the user watched.
  const marked = ov.markedPrice();
  assert.ok(marked > 0, 'the engine position must have been marked');
  const latest = series[series.length - 1];
  assert.ok(Math.abs(marked - latest) / latest < 1e-9,
    `engine mark (${marked}) must equal the live price (${latest}) the card rendered`);
});

test('a rising tick while the position is still down stays entirely red', async () => {
  const ov = runOverlay([0.001, 0.0005, 0.0006]);

  await ov.advance(1200);
  assert.ok(ov.openPaperPosition(1));
  await ov.advance(600);

  ov.nextPrice();
  await ov.advance(2500); // fall to 0.0005
  ov.nextPrice();
  await ov.advance(2500); // bounce to 0.0006, still below entry

  assert.match(ov.fieldText('pnl'), /^-/, 'total P&L must still be negative');
  const classes = ov.fieldClasses('pnl');
  assert.equal(classes.has('pt-red'), true, 'losing P&L text must be red');
  assert.equal(classes.has('pt-green'), false, 'losing P&L must never be green');
  assert.equal(classes.has('pt-flash-down'), true,
    'a bounce while still losing must use the red loss flash');
  assert.equal(classes.has('pt-flash-up'), false,
    'tick direction must not create a green flash while total P&L is negative');
});

test('a falling tick while the position is still up stays entirely green', async () => {
  const ov = runOverlay([0.001, 0.002, 0.0015]);

  await ov.advance(1200);
  assert.ok(ov.openPaperPosition(1));
  await ov.advance(600);

  ov.nextPrice();
  await ov.advance(2500); // rise to 0.002
  ov.nextPrice();
  await ov.advance(2500); // pull back to 0.0015, still above entry

  assert.match(ov.fieldText('pnl'), /^\+/, 'total P&L must still be positive');
  const classes = ov.fieldClasses('pnl');
  assert.equal(classes.has('pt-green'), true, 'profitable P&L text must be green');
  assert.equal(classes.has('pt-red'), false, 'profitable P&L must never be red');
  assert.equal(classes.has('pt-flash-up'), true,
    'a pullback while still profitable must use the green profit flash');
  assert.equal(classes.has('pt-flash-down'), false,
    'tick direction must not create a red flash while total P&L is positive');
});

test('the quick-sell row never moves when the P&L wraps (gibsonandjustin)', () => {
  // "When i buy, the bottom click to sell keeps moving when i am in profit
  // or not" — the 21px P&L line wraps to two lines as the number grows (a
  // sign flip, an extra digit, the USD part) and un-wraps as it shrinks,
  // and the sell buttons sit directly below it. The card must reserve the
  // two-line space permanently so the row is a stable click target.
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
  const pnlBlock = src.slice(src.indexOf('.pt-pos .pnl {'), src.indexOf('.pt-pos .pnl .usd-part'));
  assert.match(pnlBlock, /min-height: calc\(2 \* 1\.25em \+ 10px\);/,
    'the P&L block must reserve its wrapped height, or the sell row shifts under the cursor');
});
