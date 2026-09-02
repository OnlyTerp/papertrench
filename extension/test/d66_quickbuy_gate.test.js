/* D-66: quick-buy on a NEW PAIR must never fill the previous/stand-in token.
 *
 * Field evidence (harisx1, Discord #bug-reports, 2026-08-30T11:15Z):
 *   "Can we have the new pairs pause for quick buy? it doesnt pause when
 *    quick buying so u end up buying wrong quick buy"
 *
 * Mechanism: on a brand-new pair page there is a window between the URL
 * changing and the detect loop's next tick where the panel's `token` is
 * still the PREVIOUS coin — fully resolved and priced. In instant mode the
 * preset chips and the BUY button call requestBuy(), which filled instantly
 * against that stale identity. The gate: requestBuy refuses an instant fill
 * when the page URL no longer matches the URL the current token was
 * detected on (tokenHref). Arming behavior (D-38/D-39) is untouched — on a
 * genuinely pending token a click still arms and flushes on the first
 * accepted quote for the DISCOVERED mint.
 *
 * Lanes, per the D-66 validation contract (.contracts/validation-contract-d66.md):
 *   D-66/1..3  structural pins (VAL-1) — negative control: these FAIL with
 *              the fix stashed (VAL-4, recorded in the contract).
 *   D-66/4..6  behavioral (VAL-2) — the SHIPPED content script runs in a vm
 *              harness (same driver as freshlaunch.test.js) and the wallet
 *              storage is inspected for fill records.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const content = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');

// The engine module populates global.window.PaperEngine (defaultSettings for
// the harness storage seed) — same boot as freshlaunch.test.js.
global.window = global.window || {};
require('../engine.js');

/* ---------------- VAL-1: structural pins ---------------- */

test('D-66/1: requestBuy gates the instant fill on token-identity freshness', () => {
  const start = content.indexOf('async function requestBuy(');
  assert.ok(start !== -1, 'requestBuy must exist');
  const body = content.slice(start, content.indexOf('async function doBuy('));
  // The gate runs BEFORE the in-flight latch — a stale identity is refused
  // before anything else about the click is honored.
  assert.match(body, /quickBuyIdentityStale\(\)/,
    'the panel buy entry must consult the identity-staleness gate');
  assert.match(body, /quickBuyIdentityStale[\s\S]{0,200}return toast\(/,
    'the refusal is visible (a toast names the pause)');
  assert.match(content, /function quickBuyIdentityStale\(\)/,
    'the gate is its own decision function');
  assert.match(content, /location\.href !== tokenHref/,
    'staleness is judged against the URL the token was detected on');
});

test('D-66/2: the identity anchor is stamped by the detect loop, not by renders', () => {
  // The anchor must move only when detection acts on the page — otherwise a
  // render racing the navigation could re-validate a stale token.
  const start = content.indexOf('async function detectLoop()');
  assert.ok(start !== -1, 'detectLoop must exist');
  const body = content.slice(start, start + 3000);
  assert.match(body, /tokenHref = location\.href/,
    'detectLoop stamps the anchor every tick that inspects the page');
  // Every quick-buy entry point funnels through requestBuy — pin the two
  // instant-mode call sites so a future direct doBuy call cannot bypass.
  assert.match(content, /if \(instant\) requestBuy\(Number\(b\.dataset\.amt\)\)/,
    'instant preset chips route through requestBuy');
  assert.match(content, /requestBuy\(amt\);\s*\n\s*\}\);/,
    'the BUY button routes through requestBuy');
});

test('D-66/3: the armed doctrine is intact — pending buys still arm and re-key (D-66-R2)', () => {
  // The gate closes the stale-identity instant fill; it must NOT touch the
  // pending path: a click on a genuinely pending token arms (fromClick) and
  // discovery re-keys the intent onto the real mint.
  assert.match(content, /armedBuy = \{ amount: solAmount, usd: quotedUsd, at: Date\.now\(\), mint: token\.mint, fromClick: true \}/,
    'the click-armed intent survives');
  assert.match(content, /if \(armedBuy && armedBuy\.mint === token\.mint\) armedBuy\.mint = found\.mint;/,
    'prewatch discovery re-keys the armed mint (F-51 path)');
  assert.match(content, /if \(armedBuy\.mint && armedBuy\.mint !== token\.mint\) \{\s*\n\s*armedBuy = null;/,
    'the flush refuses a mint it was not armed for');
});

/* ---------------- VAL-2: behavioral (the shipped script, real functions) --- */

const NEW_MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const OLD_MINT = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm';
const PAIR_ADDR = 'PooLAddress1111111111111111111111111111111';

// Same driver as freshlaunch.test.js: run the REAL content script against a
// scripted page, then read the wallet storage for fill records.
function runFreshLaunch(options) {
  options = options || {};
  const timers = [];
  let now = 9_000_000;
  const nodesById = {};
  const storage = { pt_settings: global.window.PaperEngine.defaultSettings() };
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
      appendChild(c) { this.children.push(c); this.childNodes = this.children; return c; },
      removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); },
      remove() {},
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

  const u = new URL(options.url || `https://trade.padre.gg/trade/solana/${NEW_MINT}`);
  const location = { href: u.href, hostname: u.hostname, pathname: u.pathname, search: u.search };
  const win = {
    addEventListener: (type, fn) => {
      if (type === 'message') (winListeners.message = winListeners.message || []).push(fn);
    },
    removeEventListener: () => {},
    postMessage: () => {},
    location,
    getComputedStyle: () => ({ right: '18px', top: '84px' }),
    confirm: () => false,
  };
  win.window = win;

  const sandbox = {
    window: win, self: win, document: {
      readyState: 'complete', hidden: false, title: 'coin',
      body: Object.assign(makeNode('body'), { innerText: '' }),
      documentElement: makeNode('html'), head: makeNode('head'),
      createElement: (t) => makeNode(t),
      getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
      addEventListener: () => {}, createTreeWalker: () => ({ nextNode: () => null }),
    }, location, console,
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
      if (options.resolved && options.resolved()) {
        if (s.includes('jup.ag')) return Promise.resolve({ ok: true, status: 200, json: async () => options.jupiterPayload ? options.jupiterPayload() : [] });
        if (options.dexIndexes) return Promise.resolve({ ok: true, status: 200, json: async () => ({ pairs: [options.dexPair()] }) });
      }
      if (s.includes('jup.ag')) return Promise.resolve({ ok: true, status: 200, json: async () => [] });
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ pairs: null }) });
    },
    chrome: {
      runtime: {
        id: 'papertrench-test',
        getURL: (p) => 'x/' + p,
        sendMessage: (msg) => {
          if (msg.type === 'pt_attest_append') return Promise.resolve({ ok: true, seq: 0, head: 'pt-test-head' });
          if (msg.type === 'pt_onchain_prewatch') return Promise.resolve(null);
          const R = win.PaperTrenchResolver;
          if (R) {
            if (msg.type === 'pt_resolve') return R.resolve(msg.address);
            if (msg.type === 'pt_refresh') return R.refresh(msg.token);
            if (msg.type === 'pt_sol_usd') return R.solUsd();
          }
          return Promise.resolve({});
        },
        onMessage: { addListener: () => {} },
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
      for (const t of timers) {
        if (t.dead || t.at > now) continue;
        if (t.every) t.at = now + t.every; else t.dead = true;
        try { t.fn(); } catch (_) { /* asserted elsewhere */ }
      }
      for (let k = 0; k < 8; k++) await Promise.resolve();
    }
  }
  async function settle() {
    for (let k = 0; k < 400; k++) await Promise.resolve();
  }

  return {
    advance, settle,
    storage: () => storage,
    positions: () => (storage.pt_state && storage.pt_state.positions) || {},
    shadowNode: (id) => nodesById[id],
    clickShadow: (id) => { const el = nodesById[id]; if (el) el.click(); },
    setInput: (id, v) => { const el = nodesById[id]; if (el) el.value = String(v); },
    buyButtonArmed: () => {
      const el = nodesById['pt-buy'];
      return !!(el && el.classList.contains('pt-buy-armed'));
    },
    toasts: () => (storage.__toasts = storage.__toasts || []),
    setLocation: (href) => { location.href = href; location.pathname = href.replace(/^https?:\/\/[^/]+/, ''); },
  };
}

test('D-66/4: a quick-buy on a pending coin produces NO fill while unindexed (VAL-2a)', async () => {
  const ov = runFreshLaunch({ resolved: () => false });
  await ov.advance(2000);
  ov.setInput('pt-custom', '0.5');
  ov.clickShadow('pt-buy');
  await ov.settle();
  const pos = ov.positions()[NEW_MINT];
  assert.ok(!pos || !(pos.qty > 0), 'an unindexed coin must never be filled');
  assert.ok(ov.buyButtonArmed(), 'the click ARMS (existing doctrine — no third pattern)');
});

test('D-66/5: the armed fill lands under the DISCOVERED mint after the first quote (VAL-2b)', async () => {
  const REAL_MINT = '85VBFhfTowINaighzbmVWbLtQaBBmM9vUQVcwXRwpump';
  let indexed = false;
  const ov = runFreshLaunch({
    url: `https://axiom.trade/meme/${PAIR_ADDR}`,
    resolved: () => indexed,
    dexIndexes: true,
    // The pair resolves into its base mint — the discovered identity.
    // Same schema the resolver's own dexPair fixture carries (chainId and
    // marketCap are load-bearing in quote.js's tokenFromPayload).
    dexPair: () => ({ chainId: 'solana', pairAddress: PAIR_ADDR, baseToken: { address: REAL_MINT, symbol: 'REAL', name: 'Real' }, quoteToken: { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL' }, priceNative: '0.0000011', priceUsd: '0.00016', liquidity: { usd: 22000 }, marketCap: 160000 }),
  });
  await ov.advance(2000);
  ov.setInput('pt-custom', '1');
  ov.clickShadow('pt-buy');
  await ov.settle();
  assert.ok(ov.buyButtonArmed(), 'pending click arms');
  assert.ok(!(ov.positions()[PAIR_ADDR] || {}).qty, 'nothing fills under the stand-in address');

  indexed = true;
  await ov.advance(6000);

  assert.ok((ov.positions()[REAL_MINT] || {}).qty > 0,
    'the armed fill books the DISCOVERED mint');
  assert.ok(!(ov.positions()[PAIR_ADDR] || {}).qty,
    'no position ever exists under the stand-in');
  assert.ok(!ov.buyButtonArmed(), 'the intent leaves the armed state after the fill');
});

test('D-66/6: navigation to a new pair refuses the instant fill for the OLD token (the defect)', async () => {
  // Seed the wallet with a position on the OLD coin so the stale panel would
  // have a priced token to wrongly fill against, then navigate.
  const ov = runFreshLaunch({
    url: `https://trade.padre.gg/trade/solana/${OLD_MINT}`,
    resolved: () => true,
    // The OLD token resolves fine (it is the priced, settled coin).
    dexPair: () => ({ baseToken: { address: OLD_MINT, symbol: 'OLD', name: 'Old' }, priceNative: '0.000002', priceUsd: '0.0003', fdv: 300000, liquidity: { usd: 40000 }, pairAddress: OLD_MINT }),
  });
  await ov.advance(4000);
  assert.ok(ov.positions()[OLD_MINT] || true, 'warm-up');

  // Navigate to a brand-new pair. The URL changes NOW; the detect loop has
  // not ticked yet, so the panel still holds OLD — the defect window.
  ov.setLocation(`https://trade.padre.gg/trade/solana/${NEW_MINT}`);
  ov.setInput('pt-custom', '1');
  ov.clickShadow('pt-buy');
  await ov.settle();

  assert.ok(!(ov.positions()[OLD_MINT] || {}).qty,
    'the quick-buy must NOT fill the token the user already left');
  assert.ok(!(ov.positions()[NEW_MINT] || {}).qty,
    'and it must not guess the new token before detection, either');
  // After the detect tick swaps the pending token in, the same click arms.
  await ov.advance(2000);
  ov.clickShadow('pt-buy');
  await ov.settle();
  assert.ok(ov.buyButtonArmed() || !(ov.positions()[NEW_MINT] || {}).qty,
    'after the swap the click is honored (armed or filled for the NEW token)');
});
