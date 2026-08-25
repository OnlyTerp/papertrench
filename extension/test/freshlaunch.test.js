/* Brand-new coin handling — the sniping path.
 *
 * Two defects are covered here, both reported from live use:
 *
 *   1. FLASHING. A failed resolve called setToken(null), which tore down the
 *      panel and chart markers. The next detect tick rebuilt everything, so an
 *      unindexed coin produced a visible flash loop.
 *
 *   2. CONNECT DELAY. Dexscreener returns `pairs: null` until it has observed a
 *      pool, which on a fresh launch is measurably after the coin exists. With
 *      no anchor, every live chart tick was rejected as `no-anchor`, so the
 *      coin could not be paper-traded during exactly the window snipers care
 *      about.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

global.window = global.window || {};
const Q = require('../quote.js');
require('../engine.js');

const NEW_MINT = '3PTQpne3b7kjJEvDYDMBHSuRjTDUh6HSin2xMyW3pump';
const SOL_USD = 200;

/** The shape Jupiter actually returns (captured from the live API). */
function jupiterPayload(overrides) {
  return [
    {
      id: NEW_MINT,
      name: 'Bark',
      symbol: 'BARK',
      usdPrice: 0.0000021001275121451305,
      mcap: 2100.12,
      liquidity: 2204.47,
      firstPool: { id: 'PooLAddress1111111111111111111111111111111', createdAt: '2026-08-01T04:00:00Z' },
      ...(overrides || {}),
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

/** A Dexscreener pair, for the case where it HAS caught up. */
function dexPair() {
  return {
    chainId: 'solana',
    pairAddress: 'PooLAddress1111111111111111111111111111111',
    baseToken: { address: NEW_MINT, symbol: 'BARK', name: 'Bark' },
    priceNative: '0.0000000105',
    priceUsd: '0.0000021',
    liquidity: { usd: 2204.47 },
    marketCap: 2100.12,
  };
}

/* ---------------- Jupiter parsing ---------------- */

test('a fresh launch resolves from Jupiter when Dexscreener has no pairs yet', () => {
  // This is the exact payload Dexscreener returns for an unindexed mint.
  assert.equal(Q.tokenFromPayload({ schemaVersion: '1.0.0', pairs: null }, NEW_MINT), null,
    'Dexscreener genuinely cannot resolve a brand-new coin');

  const token = Q.tokenFromJupiter(jupiterPayload(), NEW_MINT, SOL_USD);
  assert.ok(token, 'Jupiter must resolve the same coin');
  assert.equal(token.symbol, 'BARK');
  assert.equal(token.mint, NEW_MINT);
  assert.equal(token.priceSource, 'jupiter');

  // Price is DERIVED, not pasted: USD quote converted at the SOL reference.
  const expected = 0.0000021001275121451305 / SOL_USD;
  assert.ok(Math.abs(token.priceNative - expected) / expected < 1e-12,
    'the SOL price must equal usdPrice / solUsd');
  assert.equal(token.priceUsd, 0.0000021001275121451305);
  assert.ok(token.launchedAt > 0, 'launch time must be surfaced');
});

test('the SOL reference rate is read from the same batched response', () => {
  assert.equal(Q.solUsdFromJupiter(jupiterPayload()), SOL_USD);
  assert.equal(Q.solUsdFromJupiter([]), null);
});

test('a coin with no price anywhere yields nothing rather than a fabricated price', () => {
  // Observed live: a launch so new it has no liquidity and no usdPrice field.
  const noPrice = Q.tokenFromJupiter(jupiterPayload({ usdPrice: undefined }), NEW_MINT, SOL_USD);
  assert.equal(noPrice, null, 'no price must mean no token, never a guess');

  const zero = Q.tokenFromJupiter(jupiterPayload({ usdPrice: 0 }), NEW_MINT, SOL_USD);
  assert.equal(zero, null);
});

test('a missing or invalid SOL rate refuses to convert rather than corrupting the price', () => {
  assert.equal(Q.tokenFromJupiter(jupiterPayload(), NEW_MINT, 0), null);
  assert.equal(Q.tokenFromJupiter(jupiterPayload(), NEW_MINT, NaN), null);
  assert.equal(Q.tokenFromJupiter(jupiterPayload(), NEW_MINT, -5), null);
});

test('a Jupiter response for a different mint never resolves this address', () => {
  const other = Q.tokenFromJupiter(jupiterPayload({ id: 'SomeOtherMint111' }), NEW_MINT, SOL_USD);
  assert.equal(other, null, 'entries are matched by mint, not by array position');
});

test('malformed Jupiter payloads are handled without throwing', () => {
  for (const bad of [null, undefined, {}, [], 'nope', { tokens: null }]) {
    assert.equal(Q.tokenFromJupiter(bad, NEW_MINT, SOL_USD), null);
    assert.equal(Q.solUsdFromJupiter(bad), null);
  }
});

/* ---------------- armed-buy survival on mcap-only charts ----------------
 *
 * DEFECT F-16: GMGN's chart feed is mcap-only pre-index (empty candidates,
 * mcap only) and Axiom defaults to mcap view. bootstrapTick rightly refuses
 * to derive a price from an assumed supply — but the armed buy then expired
 * on a 60 s clock while the coin was VISIBLY trading, making the snipe path
 * structurally dead on those charts. Armed buys now expire on QUIET (no
 * validated mcap activity), with a hard cap, never on the base clock alone.
 */
const fsMod = require('node:fs');
const pathMod = require('node:path');

test('an armed buy survives while mcap-only ticks prove the coin is trading', () => {
  const content = fsMod.readFileSync(pathMod.join(__dirname, '..', 'content.js'), 'utf8');

  assert.match(content, /if \(Number\(payload\.mcap\) > 0\) lastMcapTickAt = Date\.now\(\);/,
    'validated mcap-only ticks must stamp market activity even when unfillable');

  const fnStart = content.indexOf('function armedBuyExpired()');
  assert.ok(fnStart !== -1, 'armed-buy expiry must be its own decision function');
  const block = content.slice(fnStart, content.indexOf('\n  }', fnStart) + 4);
  assert.match(block, /ARMED_BUY_MAX_TTL_MS/, 'a hard cap must bound the wait');
  assert.match(block, /lastMcapTickAt/, 'expiry past the base TTL must require market QUIET');

  assert.match(content, /else if \(armedBuyExpired\(\)\)/,
    'the watchdog must consult the quiet-aware expiry, not a bare clock');
  assert.doesNotMatch(content, /else if \(Date\.now\(\) - armedBuy\.at > ARMED_BUY_TTL_MS\)/,
    'the old bare-clock expiry must be gone');
});

/* ---------------- source preference ---------------- */

test('an established token prefers the observed pool quote over the derived one', () => {
  const dex = { mint: NEW_MINT, priceNative: 0.000005, priceSource: 'resolver' };
  const jup = { mint: NEW_MINT, priceNative: 0.0000049, priceSource: 'jupiter' };

  assert.equal(Q.preferResolved(dex, jup).priceSource, 'resolver',
    'the venue price wins when both sources know the token');
  assert.equal(Q.preferResolved(null, jup).priceSource, 'jupiter',
    'Jupiter is used exactly when it is the only source — the fresh-launch case');
  assert.equal(Q.preferResolved(null, null), null);
  assert.equal(Q.preferResolved({ priceNative: 0 }, jup).priceSource, 'jupiter',
    'a zero-priced record must not beat a usable one');
});

/* ---------------- once resolved, the coin is tradeable ---------------- */

test('a Jupiter-resolved anchor lets live chart ticks be accepted immediately', () => {
  const token = Q.tokenFromJupiter(jupiterPayload(), NEW_MINT, SOL_USD);

  // Before the fix there was no anchor at all, so every tick was rejected.
  const noAnchor = Q.validateTick(null, { candidates: [{ value: token.priceNative * 1.1, unit: 'unknown' }] });
  assert.equal(noAnchor.accepted, false);
  assert.equal(noAnchor.reason, 'no-anchor');

  // With the Jupiter anchor the same tick is accepted, so the coin trades.
  const verdict = Q.validateTick(token, {
    candidates: [{ value: token.priceNative * 1.1, unit: 'native' }],
  });
  assert.equal(verdict.accepted, true, 'a fresh launch must be tradeable once anchored');
  assert.ok(Math.abs(verdict.priceNative - token.priceNative * 1.1) < 1e-18);
});

test('an absurd tick is still rejected on a fresh launch', () => {
  const token = Q.tokenFromJupiter(jupiterPayload(), NEW_MINT, SOL_USD);
  const bogus = Q.validateTick(token, { candidates: [{ value: 0.44, unit: 'native' }] });
  assert.equal(bogus.accepted, false,
    'the anchor band must still protect fills on brand-new coins');
  assert.equal(bogus.priceNative, token.priceNative);
});

/* ---------------- honest header while waiting ---------------- */

test('the header never shows the old waiting line (D-38)', () => {
  const pendingToken = { mint: NEW_MINT, symbol: null, name: null, priceNative: null, pending: true };
  const now = 1_000_000;

  const early = Q.headerFields(pendingToken, { now, pendingSince: now - 300 });
  assert.equal(early.pending, true);
  assert.equal(early.searching, false, 'a brief resolve must not shout anything');

  const waiting = Q.headerFields(pendingToken, { now, pendingSince: now - 4000 });
  assert.equal(waiting.searching, true);
  assert.doesNotMatch(waiting.priceText, /waiting for first quote/i,
    'the doomed "waiting for first quote" line must never render again (Terp, D-38)');
  assert.match(waiting.priceText, /f/i,
    'the unpriced header is the neutral live-fetch line only');
  assert.doesNotMatch(waiting.priceText, /\d/, 'a pending header must never show a number');
});

test('a Jupiter-priced token is flagged as a fresh launch in the header', () => {
  const token = Q.tokenFromJupiter(jupiterPayload(), NEW_MINT, SOL_USD);
  const fields = Q.headerFields(token, { now: Date.now(), lastPriceAt: Date.now() });
  assert.equal(fields.freshLaunch, true);
  assert.equal(fields.hasTrustedPrice, true);
  assert.equal(fields.titleIsAddress, false);

  const established = Q.headerFields(
    { mint: NEW_MINT, symbol: 'OLD', priceNative: 0.001, priceSource: 'resolver' },
    { now: Date.now(), lastPriceAt: Date.now() }
  );
  assert.equal(established.freshLaunch, false);
});

/* ---------------- the SHIPPED overlay stops flashing ---------------- */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.join(__dirname, '..');

/**
 * Boot the real content.js against a token that no source can resolve yet,
 * and count how many times the overlay tears the chart down. Before the fix
 * every failed resolve fired a teardown; that loop was the visible flashing.
 */
function runFreshLaunch(opts) {
  const options = opts || {};
  const timers = [];
  let now = 5_000_000;
  const nodesById = {};
  const messages = [];       // postMessage traffic to the MAIN-world bridge
  let resolveCalls = 0;
  let prewatchCalls = 0;
  let jupiterCalls = 0;
  let attempts = 0;
  let lastAttemptAt = -1;
  let winListeners = {};   // window message listeners, so tests can emit bridge ticks

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
        if (!this._listeners[type]) this._listeners[type] = [];
        this._listeners[type].push(fn);
      },
      click() { ((this._listeners && this._listeners.click) || []).forEach((fn) => fn()); },
      querySelectorAll() { return []; },
      value: '',
      querySelector(sel) {
        const m = /data-f="([a-z]+)"/.exec(sel);
        if (m && this._fields[m[1]]) return this._fields[m[1]];
        const cls = /\.([a-z-]+)/.exec(sel);
        if (cls) { this._syn = this._syn || {}; if (!this._syn[cls[1]]) this._syn[cls[1]] = makeNode('span'); return this._syn[cls[1]]; }
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

  // Padre mint-URL by default; tests can point this at a pair-URL site
  // (Axiom) where the pending token's identity is the pair address.
  const url = options.url || `https://trade.padre.gg/trade/solana/${NEW_MINT}`;
  const parsed = new URL(url);
  const win = {
    addEventListener: (type, fn) => {
      if (type === 'message') (winListeners.message = winListeners.message || []).push(fn);
    },
    removeEventListener: () => {},
    postMessage: (msg) => { if (msg && msg.source === 'papertrench-content') messages.push(msg.type); },
    location: { href: url, hostname: parsed.hostname, pathname: parsed.pathname, search: parsed.search },
    getComputedStyle: () => ({ right: '18px', top: '84px' }),
    confirm: () => false,
  };
  win.window = win;

  const storage = { pt_settings: global.window.PaperEngine.defaultSettings() };
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
      const isResolve = s.includes('/tokens/') || s.includes('/pairs/') || s.includes('jup.ag');
      if (isResolve) {
        resolveCalls++;
        // One resolve() fires its lookups in the same tick; count the tick.
        if (now !== lastAttemptAt) { attempts++; lastAttemptAt = now; }
      }
      if (s.includes('jup.ag')) jupiterCalls++;
      // Every source reports "not indexed yet" until the test says otherwise.
      if (options.resolved && options.resolved()) {
        if (s.includes('jup.ag')) {
          return Promise.resolve({ ok: true, status: 200, json: async () => jupiterPayload() });
        }
        // Dexscreener stays blind unless the test opts in, modelling the real
        // window where only Jupiter has indexed a brand-new launch.
        if (options.dexIndexes) {
          return Promise.resolve({ ok: true, status: 200, json: async () => ({ pairs: [dexPair()] }) });
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ pairs: null }) });
      }
      if (s.includes('jup.ag')) return Promise.resolve({ ok: true, status: 200, json: async () => [] });
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ schemaVersion: '1.0.0', pairs: null }) });
    },
    chrome: {
      runtime: {
        id: 'papertrench-test',
        getURL: (p) => 'x/' + p,
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
          if (msg.type === 'pt_onchain_prewatch') {
            // The chain probe. Tests drive it with options.onchainPrewatch so
            // they can model a throttled/failing RPC (D-60) as distinct from
            // "this coin genuinely has no pool".
            prewatchCalls += 1;
            const h = options.onchainPrewatch;
            if (typeof h === 'function') return Promise.resolve(h(msg, prewatchCalls));
            return Promise.resolve(null);
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
        try { t.fn(); } catch (err) { /* asserted below */ }
      }
      for (let k = 0; k < 8; k++) await Promise.resolve();
    }
  }

  // D-38: requestBuy's click-time acquisition beat is async — and now carries
    // the chain-probe leg — so a click on an unpriced token arms several
    // microtask hops later. Flush deeply before asserting.
    async function settle() {
      for (let k = 0; k < 400; k++) await Promise.resolve();
    }

  return {
    advance,
    settle,
    // Each teardown clears the chart — this is the flashing signal.
    teardowns: () => messages.filter((m) => m === 'paper-marker-clear').length,
    resolveCalls: () => resolveCalls,
    prewatchCalls: () => prewatchCalls,
    jupiterCalls: () => jupiterCalls,
    attempts: () => attempts,
    priceText: () => (nodesById['pt-price'] || {}).textContent,
    tokenName: () => (nodesById['pt-token-name'] || {}).textContent,
    // Interaction hooks: drive the shipped UI the way a user would.
    shadowNode: (id) => shadowRoot.getElementById(id),
    clickShadow: (id) => shadowRoot.getElementById(id).click(),
    setInput: (id, v) => { shadowRoot.getElementById(id).value = String(v); },
    buyButtonText: () => (nodesById['pt-buy'] || {}).textContent,
    buyButtonArmed: () => {
      const el = nodesById['pt-buy'];
      return !!(el && el.classList.contains('pt-buy-armed'));
    },
    // Emit a bridge 'tick' exactly the MAIN-world bridge sends it. Tests drive
    // the real handlePageTick path this way — the same path a live chart's
    // first price takes.
    emitTick: (payload) => {
      for (const fn of (winListeners.message || [])) {
        fn({ source: win, origin: null, data: { source: 'papertrench-bridge', type: 'tick', payload } });
      }
    },
    storage: () => storage,
  };
}

test('an unindexed coin never tears the chart down (the flashing bug)', async () => {
  const ov = runFreshLaunch({ resolved: () => false });

  await ov.advance(6000);

  // The panel must sit patiently in a pending state, not thrash.
  assert.ok(ov.teardowns() <= 1,
    `an unresolved coin must not repeatedly clear the chart; got ${ov.teardowns()} teardowns`);
  assert.match(ov.priceText() || '', /waiting|fetching/i,
    'the panel must show an honest waiting state while unindexed');
});

test('the overlay retries fast while a new coin is unindexed', async () => {
  const ov = runFreshLaunch({ resolved: () => false });

  await ov.advance(3000);
  const attempts = ov.attempts();

  // The ordinary 800ms detect cadence yields at most ~4 attempts in 3s.
  // Sniping requires materially more, so this threshold is only reachable
  // via the fast-retry loop.
  const ceilingWithoutFastRetry = Math.ceil(3000 / 800);
  assert.ok(attempts > ceilingWithoutFastRetry + 1,
    `a pending launch must be retried faster than the ${ceilingWithoutFastRetry}-attempt ` +
    `baseline; got ${attempts} attempts in 3s`);
});

test('a coin only Jupiter knows still resolves and becomes tradeable', async () => {
  // Dexscreener never indexes this coin during the test; only Jupiter has it.
  // This is the real-world fresh-launch case, and it must work end to end.
  const ov = runFreshLaunch({ resolved: () => true, dexIndexes: false });
  await ov.advance(2500);

  assert.equal(ov.tokenName(), 'BARK',
    'a coin only Jupiter knows must still resolve to a real identity');
  assert.match(ov.priceText() || '', /^\$/,
    'and must show a tradeable level, quoted as a market cap');
});

test('the coin becomes tradeable the moment any source indexes it', async () => {
  let indexed = false;
  const ov = runFreshLaunch({ resolved: () => indexed });

  await ov.advance(2000);
  assert.match(ov.priceText() || '', /waiting|fetching/i, 'still pending before indexing');

  indexed = true;               // the launch appears on Jupiter
  await ov.advance(2000);

  assert.equal(ov.tokenName(), 'BARK', 'the resolved identity must appear');
  assert.match(ov.priceText() || '', /^\$/,
    'a real tradeable level must appear once any source resolves the coin');
});

/* ---------------- armed buys on fresh launches ----------------
 *
 * The SHIPPED defect: on pair-URL sites (Axiom) the pending token's mint is
 * the PAIR address. When the resolver turned that pair into its base mint,
 * setToken() read the mint change as "navigated to another token" and
 * silently dropped the armed buy — at exactly the moment the first quote
 * landed. The button said ARMED forever and nothing executed.
 */

// The pair address dexPair() resolves from — valid base58, 44 chars.
const PAIR_ADDR = 'PooLAddress1111111111111111111111111111111';

test('an armed buy on a pair-URL site executes when the pair resolves', async () => {
  let indexed = false;
  const ov = runFreshLaunch({
    url: `https://axiom.trade/meme/${PAIR_ADDR}`,
    resolved: () => indexed,
    // Dexscreener is the source that indexes the PAIR; Jupiter only knows
    // mints, so it cannot resolve this address — the real Axiom case.
    dexIndexes: true,
  });

  await ov.advance(2000);
  assert.match(ov.priceText() || '', /waiting|fetching/i, 'the pair is still unindexed');

  ov.setInput('pt-custom', '1');
  ov.clickShadow('pt-buy');
  await ov.settle();
  assert.ok(ov.buyButtonArmed(),
    'buying before any quote must arm the intent');

  indexed = true;                 // Dexscreener indexes the pair
  await ov.advance(4000);

  const st = ov.storage().pt_state;
  const pos = st && st.positions && st.positions[NEW_MINT];
  assert.ok(pos && pos.qty > 0,
    'the armed buy must fill once the pair resolves into its base mint');
  assert.ok(pos.qty * pos.lastPriceNative <= 1 + 1e-9, 'the fill respects the armed SOL amount');
  assert.ok(!ov.buyButtonArmed(),
    'the button must leave the armed state after the fill');
});

test('an armed buy on a mint-URL site also fills from the resolver path', async () => {
  // Padre URLs carry the mint directly, so there is no identity upgrade —
  // but the first price can still land via requote() when the resolver
  // indexes the coin between detect retries. That path must flush too.
  let indexed = false;
  const ov = runFreshLaunch({ resolved: () => indexed });

  await ov.advance(2000);
  ov.setInput('pt-custom', '0.5');
  ov.clickShadow('pt-buy');
  await ov.settle();
  assert.ok(ov.buyButtonArmed());

  indexed = true;
  await ov.advance(4000);

  const st = ov.storage().pt_state;
  const pos = st && st.positions && st.positions[NEW_MINT];
  assert.ok(pos && pos.qty > 0, 'a resolver-delivered first quote must flush the armed buy');
});

test('an armed buy expires visibly when no quote ever arrives', async () => {
  const ov = runFreshLaunch({ resolved: () => false });

  await ov.advance(2000);
  ov.setInput('pt-custom', '1');
  ov.clickShadow('pt-buy');
  await ov.settle();
  assert.ok(ov.buyButtonArmed(), 'the intent arms while unindexed');

  // ARMED_BUY_TTL_MS is 60s. The heartbeat watchdog — not a flushing path
  // that may never run — must expire it and restore the button.
  await ov.advance(61_000);

  assert.ok(!ov.buyButtonArmed(),
    'an armed buy must not sit armed forever when no quote lands');
  const st = ov.storage().pt_state;
  assert.ok(!st || !st.positions || Object.keys(st.positions).length === 0,
    'an expired armed buy must never fill');
});

/* ---------------- the fire path must honor F-16's quiet-aware expiry ----------
 *
 * The 8/20 field reports (CHENG and SoranaSokan, Discord): armed buys that
 * never fire while the chart visibly trades — "armed / waiting for first
 * quotes" on coin after coin. On GMGN/Axiom a pre-index chart emits
 * mcap-only ticks for minutes. F-16 made the WATCHDOG expiry quiet-aware so
 * the intent survives — but flushArmedBuy(), the FIRE path, still consulted
 * the bare 60 s clock. The first real price landing at 61–300 s was accepted
 * by handlePageTick and then killed by the flush it triggered, at the exact
 * moment it became fillable. The fire path must ask armedBuyExpired() — the
 * same predicate the watchdog uses.
 */

// A NON-pump mint: mcap-only ticks cannot price it (no implied supply), so
// they stay what they are on GMGN pre-index — proof of trading, not a quote.
const QUIET_MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

function mcapOnlyTick(mint, mcap) {
  return { mint, source: 'gmgn-mcap-candle', mcap, candidates: [] };
}

test('an armed buy fires on the first price even when it lands after the base TTL', async () => {
  // Structural: the fire path must consult the quiet-aware predicate, and the
  // bare-clock check must be gone from content.js entirely.
  const content = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'content.js'), 'utf8');
  assert.doesNotMatch(content, /Date\.now\(\) - armedBuy\.at > ARMED_BUY_TTL_MS/,
    'the fire path must never judge expiry on the bare base clock');

  // Behavioral: the exact reported journey. The coin never resolves from any
  // API — the chart's own feed is the only source, mcap-only for 90 seconds.
  const ov = runFreshLaunch({
    url: `https://trade.padre.gg/trade/solana/${QUIET_MINT}`,
    resolved: () => false,
  });

  await ov.advance(2000);
  ov.setInput('pt-custom', '1');
  ov.clickShadow('pt-buy');
  await ov.settle();
  assert.ok(ov.buyButtonArmed(), 'the intent arms while the chart is mcap-only');

  // 90 s of mcap-only ticks: past the 60 s base TTL, but the market is LIVE.
  // The F-16 quiet rule must keep the intent armed the whole way.
  for (let i = 0; i < 18; i++) {
    await ov.advance(5_000);
    ov.emitTick(mcapOnlyTick(QUIET_MINT, 9000 + i * 250));
  }
  assert.ok(ov.buyButtonArmed(),
    'an armed buy must survive mcap-only ticks past the base TTL (F-16)');

  // The first real price lands at t≈90 s. This is the exact moment the old
  // bare-clock fire path killed the intent. It must FILL instead.
  ov.emitTick({
    mint: QUIET_MINT, source: 'chart-export',
    candidates: [{ value: 0.00000012, unit: 'native' }],
  });
  await ov.settle();
  await ov.advance(1000);

  const st = ov.storage().pt_state;
  const pos = st && st.positions && st.positions[QUIET_MINT];
  assert.ok(pos && pos.qty > 0,
    'the first price after a long mcap-only wait must FILL, not expire');
  assert.ok(!ov.buyButtonArmed(), 'the button must leave the armed state on fill');
});

test('the hard cap still bounds the wait when mcap ticks never stop', async () => {
  const ov = runFreshLaunch({
    url: `https://trade.padre.gg/trade/solana/${QUIET_MINT}`,
    resolved: () => false,
  });

  await ov.advance(2000);
  ov.setInput('pt-custom', '1');
  ov.clickShadow('pt-buy');
  await ov.settle();
  assert.ok(ov.buyButtonArmed());

  // 305 s of live mcap ticks: quiet-aware expiry must still surrender at the
  // hard cap — a quiet-aware wait may not become an eternal one.
  for (let i = 0; i < 61; i++) {
    await ov.advance(5_000);
    ov.emitTick(mcapOnlyTick(QUIET_MINT, 9000 + i * 250));
  }

  assert.ok(!ov.buyButtonArmed(),
    'ARMED_BUY_MAX_TTL_MS must expire the intent even while ticks keep coming');
  const st = ov.storage().pt_state;
  assert.ok(!st || !st.positions || Object.keys(st.positions).length === 0,
    'a hard-capped armed buy must never fill');
});

/* ---------------- F-34: fresh pump.fun launches must be priceable ----------
 *
 * Maintainer video: a 39-second-old coin on Axiom, chart in MCap mode,
 * "ARMED — 0.5 SOL ON FIRST QUOTE" forever. Every chart close was mcap-scale
 * and bootstrapTick refused it ("no implied supply") — but pump.fun supply
 * is a protocol constant (1e9), so those closes CAN price the coin. All four
 * readings of an unlabelled value are judged against the sane band and the
 * tick is priced only when exactly one fits.
 */

test('F-34: an mcap-mode chart close bootstraps a pump-family coin', () => {
  const pending = { mint: 'GAcMLQLWHRM9XmQjvkkpDjinXBuvn7uYhLQ5cerQpump', pending: true };
  const rate = 150; // USD per SOL
  // The screenshot case: $7.15K USD market cap on the chart.
  const verdict = Q.bootstrapTick(pending, {
    mint: pending.mint, source: 'chart-export',
    candidates: [{ value: 7150, unit: 'unknown' }],
  }, rate);
  assert.equal(verdict.accepted, true, 'a USD-mcap close must price a pump coin');
  assert.equal(verdict.basis, 'mcap');
  assert.ok(Math.abs(verdict.priceUsd - 7150 / 1e9) < 1e-15, 'unit price = mcap / constant supply');
  assert.ok(Math.abs(verdict.priceNative - 7150 / 1e9 / rate) < 1e-15);
  assert.equal(verdict.mcap, 7150);
});

test('F-34: a SOL-denominated mcap close (small number!) bootstraps too', () => {
  const pending = { mint: 'GAcMLQLWHRM9XmQjvkkpDjinXBuvn7uYhLQ5cerQpump', pending: true };
  const rate = 150;
  // The same $7.15K cap with the chart's USD/SOL toggle on SOL: ~47.7 SOL.
  // Below the old magnitude floor, so it used to fall through to unit-price
  // logic and be refused as implausible.
  const verdict = Q.bootstrapTick(pending, {
    mint: pending.mint, source: 'chart-export',
    candidates: [{ value: 47.7, unit: 'unknown' }],
  }, rate);
  assert.equal(verdict.accepted, true, 'a SOL-mcap close must price a pump coin');
  assert.equal(verdict.basis, 'native-mcap');
  assert.ok(Math.abs(verdict.priceNative - 47.7 / 1e9) < 1e-15, 'native unit price = SOL mcap / supply');
});

test('F-34: non-pump coins keep the old refusal — supply must never be guessed', () => {
  const pending = { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', pending: true };
  const verdict = Q.bootstrapTick(pending, {
    mint: pending.mint, source: 'chart-export',
    candidates: [{ value: 7150, unit: 'unknown' }],
  }, 150);
  assert.equal(verdict.accepted, false);
  assert.equal(verdict.reason, 'mcap-no-supply',
    'an arbitrary SPL token has no implied supply; only the pump constant is a fact');
});

test('F-34: the pumpCurve flag stands in when only the pair address is known', () => {
  // Axiom /meme/<pair> pages: the pending token's mint is the CURVE address
  // (no pump suffix); prewatch sets pumpCurve after identifying it on-chain.
  const pending = { mint: '5oyPYDcR48bfFD3v8XTkorTksSQWkUva4ELS4CxkqVLH', pending: true, pumpCurve: true };
  const verdict = Q.bootstrapTick(pending, {
    mint: pending.mint, source: 'chart-export',
    candidates: [{ value: 7150, unit: 'unknown' }],
  }, 150);
  assert.equal(verdict.accepted, true);
  assert.equal(Q.isPumpFamily({ mint: '5oyPY...' }), false, 'a bare pair address proves nothing');
  assert.equal(Q.isPumpFamily(pending), true, 'the on-chain identification does');
});

test('F-34: an mcap-only tick (no candidates) prices a pump coin the same way', () => {
  const pending = { mint: 'J5mUdr6WTmXRXH1N5k7houLDLEZbEeeEuavEWFofpump', pending: true };
  const verdict = Q.bootstrapTick(pending, {
    mint: pending.mint, source: 'gmgn-mcap-candle', mcap: 12000, candidates: [],
  }, 150);
  assert.equal(verdict.accepted, true);
  assert.equal(verdict.basis, 'mcap');
  assert.ok(Math.abs(verdict.priceUsd - 12000 / 1e9) < 1e-15);
});

test('F-34: ambiguity still refuses — a cap that reads sane both ways is not guessed', () => {
  const pending = { mint: 'J5mUdr6WTmXRXH1N5k7houLDLEZbEeeEuavEWFofpump', pending: true };
  // At a $25 SOL price, 3500 reads sane as BOTH a $3.5K USD cap and a
  // 3500-SOL ($87.5K) cap. Guessing between them is a ~25x error; refuse.
  const verdict = Q.bootstrapTick(pending, {
    mint: pending.mint, source: 'chart-export',
    candidates: [{ value: 3500, unit: 'unknown' }],
  }, 25);
  assert.equal(verdict.accepted, false);
  assert.equal(verdict.reason, 'ambiguous-unit');

  // And a value below the pump launch floor under EVERY reading is refused:
  // 0.5 as "0.5 SOL of market cap = a $100 coin" was the trap the dedicated
  // mcap floor exists for.
  const dust = Q.bootstrapTick(pending, {
    mint: pending.mint, source: 'chart-export',
    candidates: [{ value: 0.5, unit: 'unknown' }],
  }, 200);
  assert.equal(dust.accepted, false);
  assert.equal(dust.reason, 'implausible-unit');
});

const Onchain = require('../onchain.js');

/* ---------------- F-34: bonding-curve derivation (the sniping path) --------
 *
 * findProgramAddress(["bonding-curve", mint], pumpProgram), reimplemented
 * dependency-free (sha256 via crypto.subtle + an ed25519 on-curve check in
 * BigInt). The five vectors below are REAL mainnet pairs captured live from
 * Dexscreener on 2026-08-05 — mint on the right, its actual bonding-curve
 * account on the left. If the derivation drifts from Solana's PDA rules in
 * any way, these stop matching.
 */

const PDA_VECTORS = [
  ['5oyPYDcR48bfFD3v8XTkorTksSQWkUva4ELS4CxkqVLH', 'B88dwNrMyZ3ZZvq8ZXHnbisWzG5WQ5EaJ3dud1REpump'],
  ['Qi7huaHpf9BtXtnWcDkfPDDuh5q47szrRMujM2hffCQ', 'gEpuehYi7jfT6tDNa2BWKJqmytBR2B8SHfXXMi7pump'],
  ['81cnbWuwj6HDQ52T4m3FRVWF8Ms6oxEaDgfpxMPMQNhr', 'J5mUdr6WTmXRXH1N5k7houLDLEZbEeeEuavEWFofpump'],
  ['G4ULaaknSX4p8ZCttUFQagXU2WL3g6To1AeWp87zMmyV', 'GAcMLQLWHRM9XmQjvkkpDjinXBuvn7uYhLQ5cerQpump'],
  ['F2DpuAtYcCJLSMhtdgntEiC1hjoDNp96ehCVavZYkU2o', '8kwNiiRZHTGud5tcKcDkPsV7hwtGHQiCB4p7wZ2ppump'],
];

test('F-34: derivePumpCurve reproduces five real mainnet curve addresses', async () => {
  for (const [curve, mint] of PDA_VECTORS) {
    const derived = await Onchain.derivePumpCurve(mint);
    assert.equal(derived, curve, `curve PDA for ${mint}`);
  }
});

test('F-34: derivation refuses garbage without throwing', async () => {
  assert.equal(await Onchain.derivePumpCurve('not-base58-0OIl'), null);
  assert.equal(await Onchain.derivePumpCurve(''), null);
  assert.equal(await Onchain.derivePumpCurve(null), null);
});

test('F-34: the on-curve check agrees with reality on known points', () => {
  // The system program id (32 zero bytes) decompresses to a valid curve
  // point (y=0 → x²=−1, solvable mod 2²⁵⁵−19); every PDA, by construction,
  // must NOT.
  assert.equal(Onchain.isOnCurve(new Uint8Array(32)), true,
    'the system program id is an on-curve point');
  for (const [curve] of PDA_VECTORS) {
    assert.equal(Onchain.isOnCurve(Onchain.b58decode(curve)), false,
      curve + ' is a PDA and must be off-curve');
  }
});

/* ---------------- measured supply: non-pump launchpads bootstrap too -------
 *
 * The Padre re-report of the F-34 screen: a brand-new NON-pump coin (letsbonk
 * and friends — no "pump" suffix, no derivable curve) on an MCap-mode chart.
 * The pump constant cannot price it and no aggregator knows it, so the armed
 * buy sat on "waiting for first quote" forever while the site's own chart
 * ticked away. The prewatch probe now reads the coin's supply OFF THE MINT
 * ACCOUNT (token.supplyUi, whole tokens) — a protocol fact, not scraped page
 * data — and bootstrapTick prices mcap-scale readings through it under the
 * same exactly-one-sane discipline. Measured-supply coins get the generic
 * sanity band, NOT pump's tighter launch-cap band: nothing pins their
 * starting cap.
 */

const BONK_MINT = 'BonkMint1111111111111111111111111111111bonk';

test('measured supply: an mcap-only tick prices a non-pump coin', () => {
  const pending = { mint: BONK_MINT, pending: true, supplyUi: 1e9 };
  const rate = 200;
  const verdict = Q.bootstrapTick(pending, {
    mint: BONK_MINT, source: 'padre-chart-bar', mcap: 8000,
  }, rate);
  assert.equal(verdict.accepted, true, 'a measured supply makes the mcap readable');
  assert.equal(verdict.basis, 'mcap');
  assert.ok(Math.abs(verdict.priceUsd - 8000 / 1e9) < 1e-15, 'unit price = mcap / measured supply');
  assert.ok(Math.abs(verdict.priceNative - 8000 / 1e9 / rate) < 1e-15);
});

test('measured supply: an MCap-mode chart close prices a non-pump coin', () => {
  // The Padre screenshot: chart in MCap display, ~$39K cap, unlabelled close.
  const pending = { mint: BONK_MINT, pending: true, supplyUi: 1e9 };
  const verdict = Q.bootstrapTick(pending, {
    mint: BONK_MINT, source: 'chart-export',
    candidates: [{ value: 39000, unit: 'unknown' }],
  }, 200);
  assert.equal(verdict.accepted, true);
  assert.equal(verdict.basis, 'mcap', 'only the USD-mcap reading of 39000 is sane');
  assert.ok(Math.abs(verdict.priceUsd - 39000 / 1e9) < 1e-15);
  assert.equal(verdict.mcap, 39000);
});

test('measured supply: two sane readings still refuse — measured never loosens F-25', () => {
  // At supply 1e9 and rate 200, a close of 200 reads sanely as BOTH a USD
  // mcap (unit 2e-7) and a SOL mcap (unit 4e-5). Guessing between them is
  // the double-division corruption; the tick must be refused.
  const pending = { mint: BONK_MINT, pending: true, supplyUi: 1e9 };
  const verdict = Q.bootstrapTick(pending, {
    mint: BONK_MINT, source: 'chart-export',
    candidates: [{ value: 200, unit: 'unknown' }],
  }, 200);
  assert.equal(verdict.accepted, false);
  assert.equal(verdict.reason, 'ambiguous-unit');
});

test('measured supply: no supply and no pump suffix still refuses mcap readings', () => {
  // The pre-probe state of the same coin: nothing measured, nothing implied.
  const pending = { mint: BONK_MINT, pending: true };
  const close = Q.bootstrapTick(pending, {
    mint: BONK_MINT, source: 'chart-export',
    candidates: [{ value: 39000, unit: 'unknown' }],
  }, 200);
  assert.equal(close.accepted, false);
  assert.equal(close.reason, 'mcap-no-supply');
  const mcOnly = Q.bootstrapTick(pending, {
    mint: BONK_MINT, source: 'padre-chart-bar', mcap: 8000,
  }, 200);
  assert.equal(mcOnly.accepted, false);
  assert.equal(mcOnly.reason, 'mcap-only-no-supply',
    'a supply nobody measured must never price a fill');
});

test('measured supply: pump-family coins keep their tighter launch-cap band', () => {
  // At a $1K cap the two bands split: for a pump coin the USD reading
  // (unit 1e-6) sits below the 3e-6 protocol launch floor and the SOL
  // reading (unit 2e-4) is above both bands — refused. For a
  // measured-supply coin the USD reading lands inside the generic sanity
  // band and is the only sane one — accepted.
  const rate = 200;
  const pump = { mint: 'GAcMLQLWHRM9XmQjvkkpDjinXBuvn7uYhLQ5cerQpump', pending: true };
  const bonk = { mint: BONK_MINT, pending: true, supplyUi: 1e9 };
  const tickOf = (mint) => ({ mint, source: 'padre-chart-bar', mcap: 1000 });
  assert.equal(Q.bootstrapTick(pump, tickOf(pump.mint), rate).accepted, false,
    'pump launches near $4K — a $1K cap reading is not credible for one');
  assert.equal(Q.bootstrapTick(bonk, tickOf(bonk.mint), rate).accepted, true,
    'nothing pins a measured-supply launchpad to pump’s starting cap');
});

test('measured supply: bootstrapSupply prefers the measured value and refuses the rest', () => {
  assert.equal(Q.bootstrapSupply({ mint: BONK_MINT, supplyUi: 5e8 }), 5e8);
  assert.equal(Q.bootstrapSupply({ mint: 'GAcMLQLWHRM9XmQjvkkpDjinXBuvn7uYhLQ5cerQpump' }), 1e9,
    'the pump constant remains the fallback for pump-family coins');
  assert.equal(Q.bootstrapSupply({ mint: BONK_MINT }), null,
    'no measurement and no protocol constant -> no supply, honestly');
});


/* ---------------- D-39: the first quote fills a CLICK (F-54 roll-on) ------
 *
 * Field reports (Terp x3, rashawn; seeded by sednation): fresh-launch snipes
 * filled at a stale/lagging first quote — a 20k-MC coin recorded at 6k. The
 * fill witness (F-47) guards divergence against ACCEPTED evidence, but at
 * bootstrap there is no prior evidence: the first tick is self-witnessing.
 * Old F-54 demanded a second source before an armed buy may fill. Terp's
 * 8/21 roll-on ("no blockers or delays") supersedes it: a click-armed buy
 * fills on the FIRST accepted quote — the chart is up, the site's own data
 * prices the coin, and a delayed paper fill is worse than an honest one.
 * The corroboration gate now applies only to intents never clicked into
 * existence (structural lock below).
 */

test('D-39: a click-armed buy fills on the very FIRST lone quote — no corroboration wait', async () => {
  let indexed = false;
  const ov = runFreshLaunch({ resolved: () => indexed });

  await ov.advance(2000);
  assert.match(ov.priceText() || '', /waiting|fetching/i, 'pending before indexing');

  ov.setInput('pt-custom', '1');
  ov.clickShadow('pt-buy');
  await ov.settle();
  assert.ok(ov.buyButtonArmed(), 'the intent arms while unindexed');

  // A short indexed window: requote is single-flight (>=300ms apart), so
  // at most a beat or two of adoptions land while the coin is visible to
  // the resolver — nowhere near the two-source wait the old F-54 demanded.
  indexed = true;
  await ov.advance(700);
  indexed = false;
  await ov.advance(2000);

  // D-39 (Terp 8/21, "no blockers or delays"): the first accepted quote
  // FILLS a click-armed buy. The chart is on screen — the site's own data
  // prices that coin — waiting on a second source is a delay, not a guard.
  const st = ov.storage().pt_state;
  assert.ok(st && st.positions && Object.keys(st.positions).length > 0,
    'the first accepted quote must FILL the click-armed buy immediately');
  assert.ok(!ov.buyButtonArmed(),
    'the armed cue clears the moment the fill lands');
});

test('D-39: corroboration gates non-click intents only — the wiring is structural', () => {
  const content = fsMod.readFileSync(pathMod.join(__dirname, '..', 'content.js'), 'utf8');

  // The counter must exist and reset when the panel switches coins.
  assert.match(content, /let acceptedTickCount = 0;/,
    'the accepted-tick counter must exist');
  assert.match(content, /acceptedTickCount = 0;/,
    'it must reset when the on-screen token changes');

  // Page ticks count.
  assert.match(content, /acceptedTickCount \+= 1;/,
    'accepted page ticks must increment corroboration');

  // The resolver path is an independent source and counts too.
  const resolverIdx = content.indexOf('F-54: a resolver quote IS the independent second source');
  assert.ok(resolverIdx !== -1,
    'the resolver adoption site must document its corroboration role');
  const afterResolver = content.slice(resolverIdx, resolverIdx + 600);
  assert.match(afterResolver, /acceptedTickCount \+= 1;/,
    'a resolver quote must corroborate the bootstrap price');

  // The gate itself: click-created intents skip corroboration entirely;
  // the guard survives for intents never clicked into existence.
  const fnStart = content.indexOf('function flushArmedBuy()');
  const fnEnd = content.indexOf('function renderBuyButton()', fnStart);
  const fn = content.slice(fnStart, fnEnd);
  assert.match(fn, /armedBuy\.fromClick !== true && acceptedTickCount < 2/,
    'the corroboration gate must apply ONLY to non-click intents (D-19)');
  const guardIdx = fn.indexOf('acceptedTickCount < 2');
  const buyIdx = fn.indexOf('doBuy(');
  assert.ok(guardIdx !== -1 && buyIdx !== -1 && guardIdx < buyIdx,
    'the gate must still run before the fill');
});

test('D-39: the click acquisition leads with the board row price, and arming is silent', () => {
  const content = fsMod.readFileSync(pathMod.join(__dirname, '..', 'content.js'), 'utf8');

  const fnStart = content.indexOf('async function acquireClickQuote');
  const chunk = content.slice(fnStart, fnStart + 2000);
  const rowIdx = chunk.indexOf('recentRowPrices.get(addr)');
  const resolveIdx = chunk.indexOf('R.resolve(addr');
  assert.ok(rowIdx !== -1 && resolveIdx !== -1 && rowIdx < resolveIdx,
    'the captured row price must be consulted BEFORE the resolver (instant board→chart adopt)');

  assert.doesNotMatch(content, /Buy armed — fires the instant the first quote lands/,
    'the arming narration toast must be gone forever');
  assert.doesNotMatch(content, /Buy armed/, 'no arming narration may exist in any form');
});

test('D-60: a failed chain probe does not permanently strand the coin', async () => {
  // newws300, 2026-08-24: "'Fetching live price' 100% of the time ... can
  // only buy once coin has aged like 20-30 seconds."
  //
  // The chain knows a launch instantly (a live probe prices an 8-second-old
  // coin in ~150ms), so a panel still waiting 20-30s is not waiting on the
  // chain — it is waiting on an AGGREGATOR to index the coin, which is what
  // happens when the chain probe has been switched off. prewatchPending
  // latched `prewatchedAddress` before the probe resolved and never cleared
  // it on failure, so ONE throttled RPC read disabled the fast path for the
  // whole life of that token.
  let calls = 0;
  const ov = runFreshLaunch({
    // No aggregator ever answers — this coin is younger than every indexer,
    // which is the whole point. The chain is the only source that knows it.
    resolvePrice: null,
    onchainPrewatch: (msg, n) => {
      calls = n;
      // First probe fails the way a throttled public endpoint does: no answer.
      if (n === 1) return null;
      // The chain was fine all along.
      return {
        mint: msg.mint || 'So1anaFreshMint111111111111111111111111111',
        pool: 'Poo1Fresh1111111111111111111111111111111111',
        poolKind: 'pump-curve',
        priceNative: 3.2e-8,
        decimals: 6,
      };
    },
  });
  await ov.settle();
  // Step the clock in detect-loop increments and record WHEN the price lands.
  let pricedAfterMs = null;
  for (let elapsed = 0; elapsed < 8000 && pricedAfterMs === null; elapsed += 400) {
    await ov.advance(400);
    const shown = String(ov.priceText() || '');
    if (shown && !/Fetching|^—$/.test(shown)) pricedAfterMs = elapsed + 400;
  }

  // The property that matters is not "the probe ran again" — the harness
  // re-navigates and that would pass by accident. It is HOW LONG the coin
  // sits unpriced after a transient failure.
  //
  // There is a slow safety-net re-probe at `pendingAttempts % 5` on the
  // 800ms detect loop: a retry only every ~4s, first firing on the 5th
  // attempt. That net is why a stranded coin eventually recovered at all,
  // and its cadence is the reported "20-30 seconds". Releasing the latch on
  // failure lets the very next detect pass re-probe instead, so the coin is
  // priced within a pass or two rather than several seconds later.
  assert.ok(calls >= 2, `the probe must be retried after a failure; ran ${calls}x`);
  assert.ok(pricedAfterMs !== null,
    'the coin must end up priced once the chain answers');
  assert.ok(pricedAfterMs <= 800,
    `the retry must be prompt, not the ~4s safety net; took ${pricedAfterMs}ms`);
});

test('D-60: the click asks the chain whenever no source priced it', () => {
  // The chain probe inside acquireClickQuote was gated on `token.pending`,
  // which means "the panel has never had a price". But the block it guards
  // already knows the stronger fact: NO source produced a usable price for
  // this click. A token whose pending flag was cleared without a live price
  // could therefore never reach the chain — the one source that always knows.
  const content = fsMod.readFileSync(pathMod.join(__dirname, '..', 'content.js'), 'utf8');
  const fnStart = content.indexOf('async function acquireClickQuote');
  assert.ok(fnStart !== -1, 'acquireClickQuote must exist');
  const fnEnd = content.indexOf('\n  async function', fnStart + 10);
  const fn = content.slice(fnStart, fnEnd === -1 ? fnStart + 4000 : fnEnd);

  const probeIdx = fn.indexOf("R.onchainPrewatch({ pool: addr })");
  assert.ok(probeIdx !== -1, 'the click must be able to probe the chain');

  // The guard immediately above the probe must not require token.pending.
  const guard = fn.slice(0, probeIdx);
  const lastIf = guard.lastIndexOf('if (');
  const condition = guard.slice(lastIf, guard.indexOf('{', lastIf));
  assert.doesNotMatch(condition, /token\.pending/,
    'the chain probe must not be gated on token.pending (D-60)');
  assert.match(condition, /priceNative/,
    'it stays gated on "no source produced a price", which is the real condition');
});
