/* Wallet state durability — the "sell button disappears" defect.
 *
 * Reported from live use: while holding a position, the quick-sell buttons
 * (the whole position card) would intermittently vanish. The card renders
 * from `state.positions[token.mint]`, so the real failure was the wallet
 * state itself being replaced or clobbered:
 *
 *   1. FABRICATION. store.get resolved {} for ANY failure, and reloadState()
 *      treated "nothing read" as "fresh wallet". One transient storage error
 *      swapped the live state for an empty default, and the very next
 *      heartbeat mark persisted that wipe to storage.
 *
 *   2. BLIND OVERWRITE. persistSoon() wrote the in-memory state after an
 *      800ms debounce without checking that another tab/popup had written a
 *      NEWER state in the meantime. When the adoption event was missed or
 *      raced, the stale copy clobbered the fresher wallet.
 *
 * The fix makes a failed read distinguishable from an empty result, never
 * fabricates state mid-session, stamps every write with a monotonic `seq`,
 * and makes the debounced writer adopt-and-re-mark instead of clobbering.
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

const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

/**
 * Boot the real content.js with a fake clock, stub network, and a real
 * storage backing. Same shape as the livepnl harness, plus hooks to fail
 * storage reads on demand and to write behind the storage listener's back
 * (simulating a missed adoption event).
 */
function runOverlay(priceSeries, opts) {
  const options = opts || {};
  const timers = [];
  let now = 1_000_000;
  let failGets = 0;

  function makeNode(tag) {
    const node = {
      tag, style: { setProperty() {}, removeProperty() {} }, dataset: {}, childNodes: [], _fields: {}, value: '',
      classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
        toggle(c, on) { if (on === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else if (on) this._s.add(c); else this._s.delete(c); return this._s.has(c); },
        contains(c) { return this._s.has(c); } },
      children: [],
      set textContent(v) {
        this._t = v;
        if (v === '') { this.children = []; this.childNodes = this.children; this._fields = {}; }
      },
      get textContent() { return this._t || ''; },
      set innerHTML(v) {
        this._h = v;
        this.children = []; this.childNodes = this.children; this._fields = {};
        const re = /data-f="([a-z]+)"/g; let m;
        while ((m = re.exec(v))) {
          const child = makeNode('span');
          child.dataset.f = m[1];
          this._fields[m[1]] = child;
          this.children.push(child);
        }
        const presets = /<button class="(pt-preset[^"]*)" data-amt="([^"]+)"/g;
        while ((m = presets.exec(v))) {
          const child = makeNode('button');
          child.className = m[1];
          child.dataset.amt = m[2];
          this.children.push(child);
        }
      },
      get innerHTML() { return this._h || ''; },
      appendChild(c) { this.children.push(c); this.childNodes = this.children; c._parent = this; return c; },
      removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); },
      remove() { if (this._parent) this._parent.removeChild(this); },
      setAttribute() {},
      addEventListener(type, fn) {
        if (!this._listeners) this._listeners = {};
        if (!this._listeners[type]) this._listeners[type] = [];
        this._listeners[type].push(fn);
      },
      click() { ((this._listeners && this._listeners.click) || []).forEach((fn) => fn()); },
      querySelector(sel) {
        const m = /data-f="([a-z]+)"/.exec(sel);
        if (m && this._fields && this._fields[m[1]]) return this._fields[m[1]];
        return makeNode('span');
      },
      querySelectorAll(sel) {
        if (sel === '.pt-preset') {
          return this.children.filter((c) => String(c.className || '').startsWith('pt-preset'));
        }
        return [];
      },
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

  const url = `https://trade.padre.gg/trade/${BONK}`;
  // Bridge traffic hooks: everything content.js posts toward the MAIN-world
  // bridge is recorded, and bridge->content messages can be dispatched into
  // the captured 'message' listeners (drives handlePageTick for the C-01 /
  // C-06 line-spec re-post contracts).
  const winListeners = {};
  const posted = [];
  const win = {
    addEventListener: (type, fn) => { (winListeners[type] = winListeners[type] || []).push(fn); },
    removeEventListener: (type, fn) => {
      const arr = winListeners[type];
      if (arr) { const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); }
    },
    postMessage: (message) => { posted.push(message); },
    location: { href: url, hostname: 'trade.padre.gg', pathname: `/trade/${BONK}`, search: '' },
    getComputedStyle: () => ({ right: '18px', top: '84px' }),
    confirm: () => false,
  };
  win.window = win;

  let priceIdx = 0;
  const storage = {};
  // Settings the install already has before the content script boots.
  if (options.initialSettings) {
    storage.pt_settings = Object.assign(E.defaultSettings(), options.initialSettings);
  }
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
    fetch: () => {
      const p = priceSeries[Math.min(priceIdx, priceSeries.length - 1)];
      const body = {
        pair: {
          chainId: 'solana', pairAddress: 'PAIR1', dexId: 'raydium',
          baseToken: { address: BONK, symbol: 'BONK', name: 'Bonk' },
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
          if (msg.type === 'pt_resolve' && options.resolveRecord) {
            return Promise.resolve({ ...options.resolveRecord });
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
          get: (keys, cb) => {
            // Emulate a transient storage failure: lastError set, empty value.
            if (failGets > 0) {
              failGets--;
              sandbox.chrome.runtime.lastError = { message: 'transient failure' };
              if (cb) cb({});
              sandbox.chrome.runtime.lastError = undefined;
              return Promise.resolve({});
            }
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
      for (let k = 0; k < 6; k++) await Promise.resolve();
    }
  }

  /** Write a paper position through the normal storage path (listeners fire). */
  function openPaperPosition(spendSol) {
    const settings = E.defaultSettings();
    const state = E.defaultState(settings);
    const entry = priceSeries[Math.min(priceIdx, priceSeries.length - 1)];
    E.buy(state, settings, {
      ts: now, mint: BONK, symbol: 'BONK', site: 'padre',
      priceNative: entry, priceUsd: entry * 200, solAmount: spendSol,
    });
    storage.pt_settings = settings;
    sandbox.chrome.storage.local.set({ pt_state: state });
    return Boolean(state.positions[BONK]);
  }

  /** The position card's quick-sell buttons currently in the DOM. */
  function sellButtons() {
    const host = shadowNodes['pt-position'];
    const card = host && host.children[0];
    const row = card && card._fields && card._fields.sell;
    if (!row) return [];
    return row.children.filter((c) => c.className === 'pt-sell');
  }

  function clickPreset(index) {
    const presets = shadowNodes['pt-buy-presets'] && shadowNodes['pt-buy-presets'].children;
    const button = presets && presets[index];
    if (!button) throw new Error(`missing buy preset ${index}`);
    button.click();
    return button;
  }

  return {
    advance,
    openPaperPosition,
    clickPreset,
    sellButtons,
    storage: () => storage,
    shadowNodes,
    /** Everything content.js posted toward the MAIN-world bridge. */
    posted,
    /** Deliver a bridge->content message into the captured listeners. */
    dispatchBridge: (type, payload) => {
      for (const fn of (winListeners.message || []).slice()) {
        fn({ source: win, origin: '', data: { source: 'papertrench-bridge', type, payload } });
      }
    },
    /** Fail the next N storage reads the way a transient Chrome error would. */
    failGets: (n) => { failGets = n; },
    /** A write from "another tab" whose adoption event this tab misses. */
    externalWriteSilently: (obj) => Object.assign(storage, obj),
    setValue: (id, v) => { if (shadowNodes[id]) shadowNodes[id].value = String(v); },
    clickById: (id) => { if (shadowNodes[id]) shadowNodes[id].click(); },
    nextPrice: () => { priceIdx++; },
  };
}

test('a transient storage read failure must not fabricate an empty wallet', async () => {
  const ov = runOverlay([0.001, 0.0012]);

  await ov.advance(1200);                  // resolve the token
  assert.ok(ov.openPaperPosition(1), 'position opens before the failure');
  await ov.advance(600);
  const qtyBefore = ov.storage().pt_state.positions[BONK].qty;
  assert.ok(qtyBefore > 0);

  // The next reloadState() happens inside the buy's withState. Before the
  // fix it read {} (failure) and swapped in a default state; the fill then
  // persisted over the real wallet, deleting the open position.
  ov.failGets(1);
  ov.setValue('pt-custom', '0.5');
  ov.clickById('pt-buy');
  await ov.advance(1500);

  const st = ov.storage().pt_state;
  const pos = st && st.positions && st.positions[BONK];
  assert.ok(pos, 'the open position must survive a failed storage read');
  assert.ok(pos.qty > qtyBefore, 'the new buy must add to the existing stack');
  assert.ok(st.cashSol < 9.5, 'cash must reflect BOTH fills, not a fresh wallet');
});

test('the debounced writer adopts newer external state instead of clobbering it', async () => {
  const ov = runOverlay([0.001, 0.0012]);

  await ov.advance(1200);                  // resolve; this tab holds no position

  // Another tab opens a position and writes a newer seq, but this tab misses
  // the onChanged adoption (throttled event, startup race). The in-memory
  // state here is still the empty wallet.
  const settings = E.defaultSettings();
  const foreign = E.defaultState(settings);
  E.buy(foreign, settings, {
    ts: 1_500_000, mint: BONK, symbol: 'BONK', site: 'axiom',
    priceNative: 0.001, priceUsd: 0.2, solAmount: 2,
  });
  foreign.seq = 500;
  ov.externalWriteSilently({ pt_state: foreign });

  ov.nextPrice();
  await ov.advance(3000);                  // heartbeat re-quotes, marks, persists

  const st = ov.storage().pt_state;
  assert.ok(st.positions && st.positions[BONK],
    'the heartbeat persist must never clobber a newer wallet state');
  assert.ok(Number(st.seq) > 500, 'the adopted write must carry the seq lineage forward');
});

test('the quick-sell buttons render for a position adopted from another tab', async () => {
  const ov = runOverlay([0.001, 0.0012]);

  await ov.advance(1200);
  // The ladder is permanent now — reported as the sell buttons not always
  // being there. With nothing held they are present and INERT, which is a
  // stronger contract than absence: a disabled control cannot fire a sell,
  // and it also cannot vanish from under the cursor.
  const idle = ov.sellButtons();
  assert.ok(idle.length > 0, 'the sell ladder must stay on screen with no position');
  assert.ok(idle.every((b) => b.disabled === true),
    'and every one of them must be disabled while there is nothing to sell');

  assert.ok(ov.openPaperPosition(1));
  await ov.advance(600);

  const buttons = ov.sellButtons();
  assert.equal(buttons.length, 4, 'the position card must offer the four quick-sell buttons');
  assert.deepEqual(buttons.map((b) => b.textContent), ['25%', '50%', '75%', '100%']);
});

test('the panel flow line mirrors engine totals after a real panel fill', async () => {
  const ov = runOverlay([0.001, 0.0012]);
  await ov.advance(1200);

  ov.clickPreset(0);
  await ov.advance(1500);

  const settings = Object.assign(E.defaultSettings(), ov.storage().pt_settings || {});
  const state = ov.storage().pt_state;
  const stats = E.sessionStats(state, settings);
  assert.equal(
    ov.shadowNodes['pt-flow'].textContent,
    `In ${E.fmt(stats.boughtSol, 2)} · holding ${E.fmt(stats.heldSol, 2)} · out ${E.fmt(stats.soldSol, 2)} SOL`,
  );
});

test('the panel flow line updates when a position is sold', async () => {
  const ov = runOverlay([0.001, 0.0012]);
  await ov.advance(1200);

  ov.clickPreset(0);
  await ov.advance(1500);
  const settings = Object.assign(E.defaultSettings(), ov.storage().pt_settings || {});
  const before = E.sessionStats(ov.storage().pt_state, settings);

  const sell = ov.sellButtons()[1];
  assert.ok(sell, 'the 50% sell button must render after the panel fill');
  sell.click();
  await ov.advance(1500);

  const after = E.sessionStats(ov.storage().pt_state, settings);
  assert.ok(after.soldSol > before.soldSol, 'selling increases lifetime outflow');
  assert.ok(after.heldSol < before.heldSol, 'selling reduces open cost basis');
  assert.equal(
    ov.shadowNodes['pt-flow'].textContent,
    `In ${E.fmt(after.boughtSol, 2)} · holding ${E.fmt(after.heldSol, 2)} · out ${E.fmt(after.soldSol, 2)} SOL`,
  );
});

test('a fresh wallet renders zero lifetime flow values', async () => {
  const ov = runOverlay([0.001]);
  await ov.advance(1200);

  const settings = Object.assign(E.defaultSettings(), ov.storage().pt_settings || {});
  const stats = E.sessionStats(E.defaultState(settings), settings);
  assert.equal(
    ov.shadowNodes['pt-flow'].textContent,
    `In ${E.fmt(stats.boughtSol, 2)} · holding ${E.fmt(stats.heldSol, 2)} · out ${E.fmt(stats.soldSol, 2)} SOL`,
  );
});

test('foreign-chain panels keep lifetime flow denominated in SOL', async () => {
  const ov = runOverlay([0.001], {
    resolveRecord: {
      mint: BONK, pairAddress: 'PAIR1', symbol: 'BONK', name: 'Bonk',
      priceNative: 0.001, priceUsd: 0.2, chain: 'bsc', solUsdAtResolve: 200,
    },
  });
  await ov.advance(1200);

  assert.match(ov.shadowNodes['pt-flow'].textContent, /SOL$/,
    'lifetime flow must keep its SOL label on foreign-chain panels');
  assert.doesNotMatch(ov.shadowNodes['pt-flow'].textContent, /\$/,
    'lifetime flow must not use the current token USD denomination');
});

test('the lifetime flow line is hidden by micro density', () => {
  const content = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
  assert.match(content,
    /<div class="pt-flow" id="pt-flow" title="Lifetime flow: total bought, cost still held open, total sold back out\."><\/div>/,
    'the panel body must carry the lifetime flow element and tooltip');
  assert.match(content, /els\.flow = shadow\.getElementById\('pt-flow'\);/,
    'the lifetime flow element must be registered with the panel elements');
  const micro = content.slice(
    content.indexOf('.pt-box.pt-micro #pt-thesis'),
    content.indexOf('.pt-box.pt-focus', content.indexOf('.pt-box.pt-micro #pt-thesis')),
  );
  assert.match(micro, /\.pt-box\.pt-micro #pt-flow/,
    'micro density must hide the lifetime flow line');
});

/* ---------------- overlay buy-section toggles ----------------
 *
 * The user-facing option to remove the quick buys. Drives the shipped
 * content.js with the toggles already saved, and asserts exactly which
 * controls disappear.
 */

test('the whole buy section disappears when panelBuyEnabled is off', async () => {
  // Saved at the current revision, so the one-time migration does not
  // re-adopt the defaults over this opt-out.
  const ov = runOverlay([0.001], {
    initialSettings: { panelBuyEnabled: false, settingsRevision: E.SETTINGS_REVISION },
  });

  await ov.advance(1200);                  // token resolves, panel renders

  for (const id of ['pt-buy-label', 'pt-buy-presets', 'pt-custom', 'pt-buy']) {
    assert.equal(ov.shadowNodes[id].style.display, 'none',
      `${id} must be hidden when the buy section is switched off`);
  }
});

test('the preset row hides alone while the BUY button stays', async () => {
  const ov = runOverlay([0.001], {
    initialSettings: { panelPresetsEnabled: false, settingsRevision: E.SETTINGS_REVISION },
  });

  await ov.advance(1200);

  assert.equal(ov.shadowNodes['pt-buy-presets'].style.display, 'none',
    'the one-tap presets must be hidden');
  assert.notEqual(ov.shadowNodes['pt-buy'].style.display, 'none',
    'the BUY button must remain available');
  // The free-text amount box is OFF by default as of the panel declutter —
  // the preset row it duplicates is now eight configurable boxes. It is
  // hidden, never removed, so BUY and limit-arm still read it.
  assert.equal(ov.shadowNodes['pt-custom'].style.display, 'none',
    'the custom amount box is opt-in now');
});

test('with both toggles on, every buy control is visible', async () => {
  const ov = runOverlay([0.001]);

  await ov.advance(1200);

  for (const id of ['pt-buy-label', 'pt-buy-presets', 'pt-buy']) {
    assert.notEqual(ov.shadowNodes[id].style.display, 'none',
      `${id} must be visible with default settings`);
  }
});

test('the custom amount box returns when the setting is switched on', async () => {
  // Off by default, but nothing is removed — the request was for panel space,
  // not for the capability. BUY reads this element either way and falls back
  // to the selected preset when it is empty, so hiding it can never strand a
  // trader without a way to size an order.
  const ov = runOverlay([0.001], {
    initialSettings: { panelCustomAmount: true, settingsRevision: E.SETTINGS_REVISION },
  });
  await ov.advance(1200);
  assert.notEqual(ov.shadowNodes['pt-custom'].style.display, 'none',
    'switching it on must bring the box back');
});

test('the buy-section switch still outranks the custom-amount setting', async () => {
  const ov = runOverlay([0.001], {
    initialSettings: {
      panelBuyEnabled: false, panelCustomAmount: true,
      settingsRevision: E.SETTINGS_REVISION,
    },
  });
  await ov.advance(1200);
  assert.equal(ov.shadowNodes['pt-custom'].style.display, 'none',
    'a view-only trade tab shows no buy controls at all');
});
/* ---------------- reported: panel forgets its place on refresh ----------------
 *
 * levv6x: "make it remember its place — every time I refresh or open a new
 * tab it gets back to top right". The panel drag only updated the DOM; the
 * positions bar already persists its dragged position, but the panel's drop
 * handler threw it away, so every page booted at the CSS default (top-right).
 * Two contracts pin the fix:
 *   1. behavioral — a saved panelRight/panelTop is applied at mount;
 *   2. source — the drop handler persists both coordinates to storage.
 */
test('a saved panel position is restored at mount instead of top-right', async () => {
  const ov = runOverlay([0.001], { initialSettings: { panelRight: 320, panelTop: 240 } });

  await ov.advance(1200);

  assert.equal(ov.shadowNodes['pt-box'].style.right, '320px',
    'the dragged horizontal position must survive a page load');
  assert.equal(ov.shadowNodes['pt-box'].style.top, '240px',
    'the dragged vertical position must survive a page load');
});

test('a saved panel position never lands off-screen on a smaller window', async () => {
  // Saved on a wide monitor, opened in an 800x600 window: the clamp keeps the
  // header reachable so the panel can always be dragged back.
  const ov = runOverlay([0.001], { initialSettings: { panelRight: 5000, panelTop: 4000 } });

  await ov.advance(1200);

  const right = parseInt(ov.shadowNodes['pt-box'].style.right);
  const top = parseInt(ov.shadowNodes['pt-box'].style.top);
  assert.ok(Number.isFinite(right) && right <= 760,
    'the panel must stay horizontally reachable');
  assert.ok(Number.isFinite(top) && top <= 552,
    'the panel header must stay vertically grabbable');
});

test('the panel drop handler persists the dragged position (O-19: clamped, Number.isFinite)', () => {
  // The pointer listeners cannot be driven from this harness, so pin the
  // contract in source: the drop must clamp, then write BOTH coordinates to
  // settings, then persist them — and it must NOT go through the old
  // `parseInt(x) || fallback` parsing that turned a legitimate 0 into the
  // default and made edge-parked panels jump when re-dragged (DEFECT O-19).
  const content = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  assert.match(content, /settings\.panelRight = pos\.right/,
    'the drop must record the clamped horizontal position');
  assert.match(content, /settings\.panelTop = pos\.top/,
    'the drop must record the clamped vertical position');
  const drop = content.indexOf('settings.panelRight = pos.right');
  const persist = content.indexOf('store.set({ [E.STORAGE_KEYS.settings]: settings })', drop);
  assert.ok(drop !== -1 && persist !== -1 && persist - drop < 400,
    'the recorded position must be written to storage immediately after the drop');
  // O-19: no position read anywhere may fall back through `parseInt(...) ||`.
  assert.doesNotMatch(content, /parseInt\([^)]*\.(right|top|left)\)\s*\|\|/,
    'position parsing must use Number.isFinite semantics, never parseInt-or-default');
  assert.match(content, /function finitePx\(/,
    'a shared Number.isFinite pixel parser must exist');
  assert.match(content, /return Number\.isFinite\(n\) \? n : fallback;/,
    'finitePx must fall back only on non-finite values, never on 0');
});

/* ---------------- requested: Axiom-style focus mode ----------------
 *
 * levv6x: "make the trading tab like axiom and other platforms for more
 * optimised and less distracted trades". Focus mode (opt-in setting
 * panelFocusMode) toggles the .pt-focus class on the panel box, and the
 * shipped CSS hides every decoration under it. The execution controls
 * (token, price, balance, buy, sell) must stay.
 */
test('focus mode off keeps the decorated panel', async () => {
  const ov = runOverlay([0.001]);
  await ov.advance(1200);
  assert.equal(ov.shadowNodes['pt-box'].classList.contains('pt-focus'), false,
    'the default panel keeps its banner, sparkline and info cards');
});

test('focus mode strips the decoration via the pt-focus class', async () => {
  const ov = runOverlay([0.001], {
    initialSettings: { panelFocusMode: true, settingsRevision: E.SETTINGS_REVISION },
  });
  await ov.advance(1200);
  assert.equal(ov.shadowNodes['pt-box'].classList.contains('pt-focus'), true,
    'the setting must land on the panel box as a class');

  // The shipped CSS must actually hide every decoration under that class,
  // and leave the execution controls alone.
  const content = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  // Wave 1: the diagonal watermark is gone entirely — the banner is the
  // panel's single honesty cue, so focus mode has one less thing to hide.
  // Wave 2: the sparkline and balance card are gone from EVERY mode, so the
  // focus list shrinks again — it hides only what still exists.
  for (const selector of ['.pt-banner', '.pt-footer', '#pt-thesis', '#pt-closed']) {
    assert.ok(content.includes(`.pt-box.pt-focus ${selector}`),
      `focus mode must hide ${selector}`);
  }
});

test('the dashboard exposes and persists the focus mode toggle', () => {
  const E2 = require('../engine.js');
  assert.equal(E2.DEFAULT_SETTINGS.panelFocusMode, false,
    'focus mode is opt-in: the decorated panel stays the default');
  const dashJs = fs.readFileSync(path.join(ROOT, 'dashboard.js'), 'utf8');
  assert.match(dashJs, /id="set-focus-mode"/);
  assert.match(dashJs, /panelFocusMode: document\.getElementById\('set-focus-mode'\)\.checked/,
    'the toggle must be persisted with the rest of the settings');
});

/* ---------------- reported: sell button disappearing (saannta, v1.2.13) ----
 *
 * Root cause: disableOverlay() and shutdown() destroyed the shadow DOM but
 * left posEls pointing to detached nodes. On re-enable, renderPosition()
 * saw a truthy posEls and skipped buildPositionCard — so the new card was
 * built without sell buttons (the rebuild was short-circuited by the stale
 * cache). The user sees an empty position card with no way to sell.
 *
 * The fix nulls posEls in both teardown paths. Pin the contract in source
 * because the harness cannot drive the full disable/enable cycle through
 * the storage listener (externalWriteSilently intentionally skips it).
 */
test('disableOverlay and shutdown null posEls so sell buttons rebuild', () => {
  const content = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');

  // disableOverlay must null posEls after destroying the shadow tree.
  const disableFn = content.indexOf('function disableOverlay()');
  assert.ok(disableFn !== -1, 'disableOverlay must exist');
  const disableBlock = content.slice(disableFn, content.indexOf('\n  }', disableFn) + 4);
  assert.match(disableBlock, /posEls\s*=\s*null/,
    'disableOverlay must null posEls to prevent stale-cache sell-button loss');

  // shutdown must do the same — it also destroys the shadow tree.
  const shutdownFn = content.indexOf('function shutdown(reason)');
  assert.ok(shutdownFn !== -1, 'shutdown must exist');
  const shutdownBlock = content.slice(shutdownFn, content.indexOf('\n  }', shutdownFn) + 4);
  assert.match(shutdownBlock, /posEls\s*=\s*null/,
    'shutdown must null posEls to prevent stale-cache sell-button loss');
});

/* ---------------- DEFECTS O-01 / O-02: wrong token after fast navigation ----
 *
 * O-02: detectLoop committed lastHref BEFORE its `if (resolving) return`
 * guard. A navigation landing while a resolve was in flight was recorded as
 * handled and then ignored on every later tick — the panel kept showing (and
 * doBuy kept FILLING) the previous token on the new token's page.
 *
 * O-01: a resolve that finished after the user navigated away was adopted
 * unconditionally, resurrecting the old token — price loop, markers, panel —
 * on a page it does not belong to.
 *
 * Pinned in source because the harness cannot drive detectLoop's async timing
 * (real timers + an in-flight resolver promise racing a location change).
 */
test('detectLoop cannot swallow a navigation or adopt a stale resolve', () => {
  const content = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  const fnStart = content.indexOf('async function detectLoop()');
  assert.ok(fnStart !== -1, 'detectLoop must exist');
  const block = content.slice(fnStart, content.indexOf('\n  }', fnStart) + 4);

  // O-02 — the old shape: lastHref committed on the line right after the
  // same-URL early return, i.e. before the resolving guard. Must be gone.
  assert.doesNotMatch(block,
    /if \(location\.href === lastHref && settled\) return;\s*\n\s*lastHref = location\.href;/,
    'lastHref must not be committed before the resolving guard — a navigation during an in-flight resolve would be swallowed forever');

  // O-02 — the new shape: the main commit happens only after the resolving
  // gate has been passed.
  assert.match(block, /resolving = true;\s*\n\s*lastHref = location\.href;/,
    'lastHref for a resolve tick is committed only once the tick actually starts the resolve');

  // O-01 — a resolve landing after navigation must be discarded, not adopted.
  assert.match(block, /await R\.resolve\([^)]*\);[\s\S]*?if \(location\.href !== resolveHref\) return;/,
    'a resolve result must be dropped when the page navigated while it was in flight');
});

/* ---------------- DEFECT F-15: double-tap sell fills twice ----------------
 *
 * doBuy is guarded by buyInFlight, but doSell had no guard at all. Two fast
 * taps on "SELL 50%" both quoted and both committed — the second sold 50% of
 * the REMAINDER (75% total), silently, with two success toasts.
 */
test('doSell carries a re-entrancy guard symmetric with buyInFlight', () => {
  const content = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  const fnStart = content.indexOf('async function doSell(fraction)');
  assert.ok(fnStart !== -1, 'doSell must exist');
  const block = content.slice(fnStart, content.indexOf('\n  }', fnStart) + 4);

  assert.match(block, /if \(sellInFlight\) return toast/,
    'a sell while one is in flight must be refused, not stacked');
  assert.match(block, /sellInFlight = true;/,
    'doSell must arm the guard before quoting');
  assert.match(block, /finally\s*\{\s*\n?\s*sellInFlight = false;/,
    'the guard must clear in finally so a failed sell does not brick selling');
});

/* ---------------- DEFECT D-14: restore resurrection race ------------------
 *
 * resetWallet lands its write strictly ahead of every open tab
 * (fresh.seq = baseSeq + 1), but restoreWallet wrote the backup's seq
 * verbatim. A backup taken at seq 40 restored over a live wallet at seq 900
 * was silently overwritten by the trading tab's next heartbeat — the user's
 * restore vanished within a second.
 */
test('restoreWallet lands the restored wallet ahead of every live writer', () => {
  const popup = fs.readFileSync(path.join(ROOT, 'popup.js'), 'utf8');
  const fnStart = popup.indexOf('async function restoreWallet');
  assert.ok(fnStart !== -1, 'restoreWallet must exist');
  const block = popup.slice(fnStart, popup.indexOf('\n}', fnStart) + 2);

  assert.match(block, /chrome\.storage\.local\.get\(\['pt_state'\]\)/,
    'restore must read the live wallet seq before writing');
  assert.match(block, /Math\.max\(liveSeq, backupSeq\) \+ 1/,
    'the restored seq must land strictly greater than both the live and backup counters');
});

/* ---------------- DEFECT D-41: the backup says what it does NOT carry ------
 *
 * IndexedDB screen recordings (tens of MB) are deliberately excluded from
 * the backup file. The UI must state that plainly after a successful backup
 * instead of silently overpromising — the user otherwise learns the truth
 * only after the original machine is gone.
 */
test('D-41: a successful backup states that recordings are not in the file', () => {
  const popup = fs.readFileSync(path.join(ROOT, 'popup.js'), 'utf8');
  const fnStart = popup.indexOf('async function backupWallet');
  assert.ok(fnStart !== -1, 'backupWallet must exist');
  const block = popup.slice(fnStart, popup.indexOf('\n}', fnStart) + 2);

  assert.match(block, /recordings stay on this machine and are not in the file/,
    'the status line must state the honest scope of the backup');
  assert.doesNotMatch(block, /indexedDB\.open|pt_recordings/i,
    'the backup itself still deliberately excludes the recording store');
});

/* ==================== ONE drag system (Phase 3) ====================
 *
 * DEFECTS O-16..O-21, O-25, O-26, O-19. Panel, minimized pill, positions
 * bar and the collapsed POSITIONS tab all drag through a single helper with
 * pointer events, both-bounds clamping and per-mount listener teardown.
 * The pointer stream cannot be driven end-to-end from this harness, so the
 * drag mechanics are pinned in source; everything the harness can reach
 * behaviorally (mount restore, pill state, toasts) is driven for real.
 */

const contentSrc = () => fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');

test('O-25/O-26: one shared drag helper serves every floating element, on pointer events', () => {
  const content = contentSrc();
  assert.match(content, /function makeDraggable\(handle, spec\)/,
    'the single shared drag helper must exist');
  const uses = content.match(/makeDraggable\(/g) || [];
  assert.ok(uses.length >= 5, // definition + panel header, pill, bar grip, bar tab
    `panel header, pill, bar grip and POSITIONS tab must all use the helper; found ${uses.length - 1} uses`);
  // O-25: pointer events with capture — no mouse-only drags anywhere.
  assert.match(content, /handle\.addEventListener\('pointerdown', onDown\)/);
  assert.match(content, /setPointerCapture/,
    'pointer capture is what makes touch drags work');
  assert.doesNotMatch(content, /addEventListener\('mousedown'/,
    'no bespoke mouse-only drag may remain');
  assert.doesNotMatch(content, /addEventListener\('mousemove'/,
    'the leaked window mousemove listeners must be gone (O-26)');
  // O-26: whatever the helper registers is torn down with the mount.
  const helper = content.slice(content.indexOf('function makeDraggable'), content.indexOf('// Drag controllers'));
  assert.match(helper, /onMountCleanup\(/,
    'the helper must register its listeners for per-mount teardown');
  assert.match(content, /function runMountCleanups\(\)/);
  assert.match(content, /onTeardown\(runMountCleanups\)/,
    'mount cleanups must also run at extension shutdown');
  const disableBlock = content.slice(content.indexOf('function disableOverlay()'));
  assert.match(disableBlock, /runMountCleanups\(\)/,
    'disabling the overlay must tear down the per-mount listeners (O-26)');
});

test('O-16/O-17/O-18: both floating elements clamp on BOTH bounds and re-clamp on resize', () => {
  const content = contentSrc();
  // Panel: upper and lower bounds, header kept reachable.
  const panelClamp = content.slice(content.indexOf('function clampPanelPos'), content.indexOf('function clampBarPos'));
  assert.match(panelClamp, /Math\.max\(0, Math\.min\(finitePx\(right, 18\), vw - keep\)\)/,
    'the panel must clamp right on both bounds (O-17)');
  assert.match(panelClamp, /Math\.max\(0, Math\.min\(finitePx\(top, 84\), vh - 48\)\)/,
    'the panel must clamp top so the header stays grabbable');
  // Bar: the grip is the LEFTMOST child, so left >= 0 — the old 4-rect.width
  // lower bound parked the grip off-screen and PERSISTED it (O-16).
  const barClamp = content.slice(content.indexOf('function clampBarPos'), content.indexOf('function readPanelPos'));
  assert.match(barClamp, /Math\.max\(0, Math\.min\(finitePx\(left, 210\), vw - DRAG_KEEP_PX\)\)/,
    'the bar must clamp left on both bounds with the grip kept on screen');
  assert.doesNotMatch(content, /4 - rect\.width/,
    'the escape-hatch lower bound that let the grip leave the screen must be gone');
  // O-18: one resize handler re-clamps BOTH elements, and positionBar itself
  // clamps rather than re-asserting the saved coordinate.
  // Each responsibility asserted BY NAME rather than pinning the whole body,
  // so a handler that legitimately grows keeps this contract meaningful
  // instead of failing for the wrong reason. What O-18 guarantees is that ONE
  // resize handler re-clamps BOTH elements — not that it does only that.
  const onResize = content.slice(
    content.indexOf('const onWindowResize = ()'),
    content.indexOf("window.addEventListener('resize', onWindowResize)"));
  assert.match(onResize, /positionBar\(\)/, 'window resize must re-clamp the BAR (O-18)');
  assert.match(onResize, /reclampPanel\(\)/, 'window resize must re-clamp the PANEL (O-18)');
  assert.equal(
    (content.match(/window\.addEventListener\('resize', onWindowResize\)/g) || []).length, 1,
    'exactly ONE resize handler owns the re-clamp — a second would race it');
  // Added 2026-08-06 with the scrollbar cleanup: a narrower window can turn a
  // rail that fitted into one that overflows, so the overflow fade is
  // re-evaluated alongside the clamps rather than waiting for the next render.
  assert.match(onResize, /syncRailFade\(\)/,
    'window resize must also re-evaluate the positions-rail overflow fade');
  // positionBar grew an optional measured-left parameter for the O-15 settle
  // loop; the O-18 clamp contract is unchanged.
  const positionBarFn = content.slice(content.indexOf('function positionBar('), content.indexOf('function applyBarOffset'));
  assert.match(positionBarFn, /clampBarPos\(/,
    'positionBar must clamp the saved coordinate instead of re-asserting it (O-18)');
});

test('O-21: the collapsed POSITIONS tab is itself a drag handle sharing the bar position', () => {
  const content = contentSrc();
  const barDrag = content.slice(content.indexOf('function setupBarDrag()'), content.indexOf('function openDashboard'));
  assert.match(barDrag, /makeDraggable\(els\.barGrip, barSpec\)/,
    'the grip drags the bar');
  assert.match(barDrag, /barTabDrag = makeDraggable\(els\.barTab, barSpec\)/,
    'the collapsed tab must be movable through the same spec');
  // A drop on the tab must not be mistaken for the expand tap.
  assert.match(content, /if \(barTabDrag && barTabDrag\.justDragged\(\)\) return;/,
    'a drag drop on the tab must not re-expand the bar');
});

test('O-19: a panel parked at 0 is restored at 0, never snapped to the default', async () => {
  const ov = runOverlay([0.001], { initialSettings: { panelRight: 0, panelTop: 240 } });
  await ov.advance(1200);
  assert.equal(ov.shadowNodes['pt-box'].style.right, '0px',
    'a legitimate 0 coordinate must survive the mount restore');
  assert.equal(ov.shadowNodes['pt-box'].style.top, '240px');
});

test('O-20/O-27: the minimized pill takes the panel position and shows as a flex row', async () => {
  const ov = runOverlay([0.001]);
  await ov.advance(1200);

  ov.clickById('pt-min');
  const pill = ov.shadowNodes['pt-pill'];
  assert.equal(pill.style.display, 'flex',
    'the pill is styled as a flex row; display:block broke its centering (O-27)');
  assert.match(String(pill.style.right), /px$/,
    'the pill must be positioned where the panel is, not left at the CSS top-right (O-20)');
  assert.match(String(pill.style.top), /px$/);
  // And in source: the pill is a drag handle whose drop does not restore.
  const content = contentSrc();
  assert.match(content, /pillDrag = makeDraggable\(els\.pill, panelSpec\)/,
    'the pill itself must be draggable through the shared helper');
  assert.match(content, /if \(pillDrag && pillDrag\.justDragged\(\)\) return;/,
    'a drag drop on the pill must not restore the panel');
});

/* ==================== toasts (DEFECT O-28) ==================== */

test('O-28: toasts hold their slot for their lifetime and queue instead of overwriting', async () => {
  const ov = runOverlay([0.001]);
  await ov.advance(1200);

  // Ten refusal toasts in one burst (the BUY button with no amount picked).
  for (let i = 0; i < 10; i++) ov.clickById('pt-buy');
  const root = ov.shadowNodes['pt-toast-root'];

  assert.equal(root.children.length, 8,
    'eight slots on screen; the overflow must QUEUE, not overprint slot 0');
  const tops = new Set(root.children.map((c) => c.style.top));
  assert.equal(tops.size, 8, 'no two visible toasts may share a slot');

  // Once the first wave expires, the queued two take their slots.
  await ov.advance(4400);
  assert.equal(root.children.length, 2,
    'queued toasts must appear after the visible ones expire');
});

test('O-28: the toast stack anchors to the panel side and clears its header', () => {
  const content = contentSrc();
  const base = content.slice(content.indexOf('function toastBase()'), content.indexOf('function toast(msg)'));
  assert.match(base, /readPanelPos\(\)/,
    'the stack must follow the panel: same right coordinate as the dragged panel');
  assert.match(base, /pos\.top \+ \(panelH > 0 \? panelH \+ 10 : 48\)/,
    'the stack must start below the panel (or clear the header band when hidden)');
  assert.doesNotMatch(content, /toastN/,
    'the 4-slot modulo counter that overprinted toasts must be gone');
});

/* ==================== lifecycle teardown (Phase 3) ==================== */

test('O-03/C-18: disabling the overlay tears down chart, title, chain and bridge state', () => {
  const content = contentSrc();
  const start = content.indexOf('function disableOverlay()');
  assert.ok(start !== -1);
  const block = content.slice(start, content.indexOf('async function init()', start));
  assert.match(block, /R\.onchainUnwatch\(token\.mint\)/,
    'the background pool subscription must be released');
  assert.match(block, /stopTitleSignal\(\)/,
    'the title observer must stop');
  assert.match(block, /CM\.destroyChartMarkers\(\)/,
    'the SVG overlay, its observers and scan timer must be destroyed');
  for (const msg of ['paper-marker-clear', 'paper-lines-clear', 'gmgn-lines-clear', 'standdown']) {
    assert.ok(block.includes(`sendPadreMarker('${msg}')`),
      `disableOverlay must send ${msg} so native chart drawings disappear`);
  }
  assert.match(block, /token = null;/,
    'the token must be nulled so nothing keeps rendering it');
});

test('O-04/C-17: shutdown() destroys chart markers and stands the bridge down', () => {
  const content = contentSrc();
  const start = content.indexOf('function shutdown(reason)');
  const block = content.slice(start, content.indexOf('\n  }', start) + 4);
  assert.match(block, /CM\.destroyChartMarkers\(\)/,
    'extension reload must remove the SVG overlay, observers and scan timer');
  assert.match(block, /sendPadreMarker\('standdown'\)/,
    'the MAIN-world bridge cannot see extension death — it must be told');
});

test('O-04/C-17: the overlay heartbeats the bridge so silence means death', () => {
  const content = contentSrc();
  assert.match(content, /bridgePingTimer = managedInterval\(\(\) => sendPadreMarker\('bridge-ping'\), 30_000\)/,
    'an alive-but-quiet overlay must keep pinging or the bridge watchdog would trip');
  const stops = content.slice(content.indexOf('function stopOverlays()'), content.indexOf('async function enableOverlay()'));
  assert.match(stops, /bridgePingTimer/,
    'the ping must stop with the overlay so a disabled overlay reads as silence');
});

test('O-05: createUI adopts-or-replaces a leftover host and enableOverlay is idempotent', () => {
  const content = contentSrc();
  const create = content.slice(content.indexOf('function createUI()'), content.indexOf('function bindUI()'));
  assert.doesNotMatch(create, /if \(document\.getElementById\(HOST_ID\)\) return;/,
    'the early return that left `host` null (and stacked timers forever) must be gone');
  assert.match(create, /const existing = document\.getElementById\(HOST_ID\);/,
    'an existing host node must be detected');
  assert.match(create, /existing\.remove/,
    'and removed so the rebuild always owns a fresh mount');
  const enable = content.slice(content.indexOf('async function enableOverlay()'), content.indexOf('function disableOverlay()'));
  assert.match(enable, /if \(host\) return;/,
    'a live overlay must be a no-op — never a second timer set');
});

test('O-06: a bad resize end can never latch resizingOverlay forever', () => {
  const content = contentSrc();
  const start = content.indexOf('async function onOverlayResizeEnd()');
  const block = content.slice(start, content.indexOf('\n  }', start) + 4);
  // Updated with the four-corner/capture rework: the guard now reads the
  // captured snapshot (start), and the flag still clears BEFORE it.
  const clearAt = block.indexOf('resizingOverlay = false;');
  const guardAt = block.indexOf('if (!start || !els.box)');
  assert.ok(clearAt !== -1 && guardAt !== -1 && clearAt < guardAt,
    'the flag must clear BEFORE any early return, or applyOverlaySize dies for the page');
});

test('O-29/O-07: the row-buy debounce cannot fire into a torn-down overlay', () => {
  const content = contentSrc();
  const block = content.slice(content.indexOf('function startRowBuyObserver()'), content.indexOf('/** Paper-buy the first preset amount'));
  assert.match(block, /if \(contextDead \|\| !host\) return;/,
    'the debounced scan must check the overlay is still mounted');
  assert.match(block, /clearTimeout\(rowBuyDebounce\)/,
    'stopping the observer must also cancel a pending debounce');
  const stops = content.slice(content.indexOf('function stopOverlays()'), content.indexOf('async function enableOverlay()'));
  assert.match(stops, /stopRowBuyObserver\(\)/,
    'the overlay teardown must go through the shared stop path');
});

test('C-20: GMGN never mounts the SVG overlay it cannot use', () => {
  const content = contentSrc();
  assert.match(content, /function usesSvgMarkers\(\)/,
    'a single predicate must decide where the SVG overlay applies');
  assert.match(content, /!\(site && site\.id === 'gmgn'\)/,
    'GMGN is native-drawn and must be excluded from the SVG route');
  assert.match(content, /if \(usesSvgMarkers\(\)\) CM\.initChartMarkers\(\);/,
    'initChartMarkers must be gated on the predicate, so GMGN never mutates its chart container');
  assert.doesNotMatch(content, /if \(CM && !usesNativeChart\(\)\) CM\.tickPrice/,
    'price ticks must not feed an overlay that never renders on GMGN');
});

test('O-24: the host-isolation rule targets the real host element', () => {
  const css = fs.readFileSync(path.join(ROOT, 'content.css'), 'utf8');
  assert.match(css, /#papertrench-host \{[\s\S]{0,40}all: initial;/,
    'the ID selector must guard the host element');
  assert.doesNotMatch(css, /(^|\n)papertrench-host\s*\{/,
    'the dead TYPE selector (matched nothing; host is a div) must be gone');
});

/* ==================== chart-truth: line spec re-posts ====================
 *
 * DEFECT C-01 (the community's "lines aren't where they need to be"): on
 * mcap axes the bridge computes the average line as
 * lastBarClose x (avg / current) — but `current*` lives in the paper-lines
 * spec, which was posted ONLY at resolve/fill/settings time. The frozen
 * ratio pinned near 1 and the "average" line rode the live candle. The spec
 * must now re-post as the market moves: immediately on a >0.5% move, and on
 * a 2 s cadence otherwise. DEFECT C-06: an axis-basis change (Price⇄MCap,
 * USD⇄SOL toggle) re-posts immediately, bypassing the throttle.
 */

test('C-01: the paper-lines spec re-posts on price moves so currentPrice* tracks the market', async () => {
  const ov = runOverlay([0.001]);
  await ov.advance(1200);                  // resolve the token
  assert.ok(ov.openPaperPosition(1), 'a position exists so average lines are live');
  await ov.advance(600);                   // adoption posts the first spec

  const linePosts = () => ov.posted.filter((m) => m.type === 'paper-lines');
  assert.ok(linePosts().length >= 1, 'opening a position must put a line spec on the wire');

  // A +5% validated chart tick (beyond the 0.5% move threshold) must
  // re-post the spec at once, carrying the tick's price as currentPrice*.
  ov.posted.length = 0;
  ov.dispatchBridge('tick', {
    source: 'padre-chart-bar',
    candidates: [{ value: 0.00105, unit: 'unknown', key: 'padreChartClose' }],
    mcap: null, mint: null, symbol: null,
  });
  let posts = linePosts();
  assert.ok(posts.length >= 1, 'a >0.5% move must re-post the line spec immediately (C-01)');
  assert.ok(Math.abs(posts[posts.length - 1].payload.currentPriceNative - 0.00105) < 1e-12,
    'the re-posted spec must carry the moved price, not the fill-time one');

  // A tiny follow-up move inside the 2 s window is throttled — the re-post
  // path must not turn every tick into a postMessage storm.
  ov.posted.length = 0;
  await ov.advance(100);
  ov.dispatchBridge('tick', {
    source: 'padre-chart-bar',
    candidates: [{ value: 0.00105105, unit: 'unknown', key: 'padreChartClose' }], // +0.1%
    mcap: null, mint: null, symbol: null,
  });
  assert.equal(linePosts().length, 0,
    'a <0.5% move inside the 2 s window must not re-post (throttle)');

  // Another decisive move re-posts again regardless of the cadence clock.
  ov.posted.length = 0;
  ov.dispatchBridge('tick', {
    source: 'padre-chart-bar',
    candidates: [{ value: 0.00107, unit: 'unknown', key: 'padreChartClose' }], // ~+1.8%
    mcap: null, mint: null, symbol: null,
  });
  posts = linePosts();
  assert.ok(posts.length >= 1, 'every decisive move must re-post');
  assert.ok(Math.abs(posts[posts.length - 1].payload.currentPriceNative - 0.00107) < 1e-12);
});

test('C-06: a chart unit toggle re-posts the spec immediately with the new axis basis', async () => {
  const ov = runOverlay([0.001]);
  await ov.advance(1200);
  assert.ok(ov.openPaperPosition(1));
  await ov.advance(600);

  // The chart first validates in USD price mode (anchor priceUsd = 0.2).
  ov.posted.length = 0;
  ov.dispatchBridge('tick', {
    source: 'padre-chart-bar',
    candidates: [{ value: 0.2, unit: 'unknown', key: 'padreChartClose' }],
    mcap: null, mint: null, symbol: null,
  });
  let posts = ov.posted.filter((m) => m.type === 'paper-lines');
  assert.ok(posts.length >= 1, 'the first learned basis must post a spec');
  assert.equal(posts[posts.length - 1].payload.axisBasis, 'usd');

  // The user flips the chart to market cap: the next validated tick carries
  // basis "mcap" and the spec must re-post AT ONCE — inside the 2 s window
  // and far below the 0.5% move threshold, so only the basis-change path
  // can produce this post (the old code re-asserted the stale unit for up
  // to a full fill cycle).
  ov.posted.length = 0;
  await ov.advance(100);
  ov.dispatchBridge('tick', {
    source: 'padre-chart-bar',
    candidates: [],
    mcap: 100_100_000, // anchor mcap 1e8, +0.1%
    mint: null, symbol: null,
  });
  posts = ov.posted.filter((m) => m.type === 'paper-lines');
  assert.ok(posts.length >= 1, 'a basis change must bypass the repost throttle (C-06)');
  assert.equal(posts[posts.length - 1].payload.axisBasis, 'mcap',
    'the re-posted spec must carry the NEW axis basis');
});

/* ==================== chart-truth: routing & unit honesty ==================== */

test('C-19: native routing is capability-based with a bounded SVG grace fallback', () => {
  const content = contentSrc();
  assert.match(content, /let bridgeNativeCapable = false/,
    'the bridge-reported capability flag must exist');
  assert.match(content, /NATIVE_PROBE_GRACE_MS/,
    'the SVG fallback must wait out a discovery grace period');
  assert.match(content, /return bridgeNativeCapable \|\| nativeChartPending\(\);/,
    'usesNativeChart must consult the capability, not only the hardcoded site set');
  assert.match(content, /noteNativeCapability\(ev\.payload\)/,
    'padre-hook-status must feed the capability flag');
  // The bridge answers every paper-axis with a capability snapshot, so a
  // late-loading content script still learns about an existing widget.
  const bridgeSrc = fs.readFileSync(path.join(ROOT, 'price-bridge.js'), 'utf8');
  assert.match(bridgeSrc, /nativeCapable: findTradingViewWidgets\(\)\.length > 0/,
    'the bridge must answer paper-axis with a capability snapshot');
  assert.match(bridgeSrc, /nativeCapable: true/,
    'widget discovery must advertise the capability');
});

test('C-09/C-16: no USD price means no fabricated mcap — the fill ships its SOL price instead', () => {
  const content = contentSrc();
  const fn = content.slice(
    content.indexOf('function genericChartPoint'),
    content.indexOf('/* -------------------- price handling --------------------')
  );
  // C-09: the old code substituted the SOL price for USD and multiplied it
  // into a USD-implied supply — ~150x low on GMGN. Only a genuine USD price
  // may enter the mcap derivation.
  assert.match(fn, /const usd = Number\(priceUsd\) > 0 \? Number\(priceUsd\) : null;/,
    'only a genuine USD price may seed the derivation');
  assert.match(fn, /liveSupply && usd > 0 \? usd \* liveSupply : null/,
    'the supply may only multiply a genuine USD price');
  // C-16: the capless GMGN fill still carries its SOL price so the bridge
  // can queue it and price it from the live candle close later.
  assert.match(content, /priceNative: Number\(fill\.priceNative\) > 0 \? Number\(fill\.priceNative\) : null,/,
    'the gmgn-marker payload must carry the SOL fill price for deferred pricing');
});

test("F-28: a failed attestation link tells the user once instead of silently diverging the chain", () => {
  const content = fs.readFileSync(path.join(ROOT, "content.js"), "utf8");
  const fnStart = content.indexOf("async function commitFill(");
  const block = content.slice(fnStart, content.indexOf("\n  let attestFailureToasted", fnStart));
  assert.match(block, /attestFailureToasted = true;[\s\S]{0,120}toast\(/,
    "the first attestation failure must surface a toast — verifyChain otherwise reports a mismatch the user cannot explain");
});

test("F-31: the mcap-headline sub-line says what its number IS", () => {
  const content = fs.readFileSync(path.join(ROOT, "content.js"), "utf8");
  assert.doesNotMatch(content, /`MC · \$\{f\.priceUsdText/,
    "the old label read as: the MC IS this tiny price");
  assert.match(content, /`Price \$\{f\.priceUsdText/,
    "the sub-line labels the unit price as a price");
});

test("F-32 DIAGNOSTIC: mcap-band ticks (real Padre MCap mode) must re-post the spec", async () => {
  const ov = runOverlay([0.001]);
  await ov.advance(1200);
  assert.ok(ov.openPaperPosition(1), "position open");
  await ov.advance(600);
  const linePosts = () => ov.posted.filter((m) => m.type === "paper-lines");
  assert.ok(linePosts().length >= 1, "initial spec posted");

  // Real Padre in MCap mode: close arrives as BOTH an unknown candidate and
  // tick.mcap — validating via the MCAP band (basis mcap), not the native
  // band the existing C-01 test drives. Resolver anchor: mcap 1e8 at
  // priceNative 0.001. Drive the cap +50% across several ticks.
  let stale = null;
  for (let i = 1; i <= 5; i++) {
    ov.posted.length = 0;
    await ov.advance(2500);
    const cap = 1e8 * (1 + i * 0.1);
    ov.dispatchBridge("tick", {
      source: "padre-chart-bar",
      candidates: [{ value: cap, unit: "unknown", key: "padreChartClose" }],
      mcap: cap, mint: null, symbol: null,
    });
    const posts = linePosts();
    if (!posts.length) { stale = `tick ${i} (cap ${cap}) produced NO re-post`; break; }
    const cur = posts[posts.length - 1].payload.currentPriceNative;
    const expected = 0.001 * (1 + i * 0.1);
    if (Math.abs(cur / expected - 1) > 0.02) { stale = `tick ${i}: spec current ${cur} vs expected ${expected}`; break; }
  }
  assert.equal(stale, null, stale || "ok");
});

test("focus mode is compact and carries the two-step quick reset (community: lev)", () => {
  const content = fs.readFileSync(path.join(ROOT, "content.js"), "utf8");
  // The position-detail rows hide in focus; P&L and quick sell stay.
  assert.match(content, /\.pt-box\.pt-focus \.pt-pos \.pt-detail \{ display: none; \}/);
  assert.match(content, /class="row pt-detail"><span class="k">Position size/);
  assert.doesNotMatch(content, /class="row pt-detail"[^\n]*Unrealized/,
    "unrealized P&L must STAY visible in focus mode");
  // Compact density rules exist.
  assert.match(content, /\.pt-box\.pt-focus \{ font-size: 12px; \}/);
  // Quick reset: focus-only visibility, two-step inline confirm, no popup.
  // Wave 1 (F-B14): the two-tap ⟲ is the panel's ONE reset in every mode —
  // always visible, and the footer's standing confirm() link is gone.
  assert.match(content, /#pt-quickreset \{ display: inline-flex; \}/);
  assert.doesNotMatch(content, /id="pt-reset"/,
    'no standing destructive link on a trading surface');
  const fnStart = content.indexOf("function onQuickResetTap(");
  const block = content.slice(fnStart, content.indexOf("\n  }", fnStart) + 4);
  assert.match(block, /3000/, "the armed window is bounded");
  assert.doesNotMatch(content.slice(content.indexOf("async function quickResetWallet")), /confirm\(/,
    "no confirmation popup — the two-step tap IS the confirmation");
  const resetStart = content.indexOf("async function quickResetWallet(");
  const resetBlock = content.slice(resetStart, content.indexOf("\n  }", resetStart) + 4);
  assert.match(resetBlock, /E\.resetState\(settings, state\.seq\)/,
    "engine owns the seq bump so other tabs adopt the reset");
  assert.match(resetBlock, /pt_clear_recordings/, "recordings are erased like every other reset path");
  assert.match(resetBlock, /paper-lines-clear/, "chart drawings of the old wallet are cleared");
});

/* ---------------- the site's paper-balance chip ----------------
 *
 * papertrench.com cannot know your paper wallet on its own — it lives in the
 * extension, on your machine. The chip is fed over the same bridge the
 * leaderboard Sync uses, so the tests are about the gate and the cost.
 */

const bgSrc = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');

function walletFn() {
  const at = bgSrc.indexOf('async function bridgeWallet(');
  assert.ok(at !== -1, 'bridgeWallet must exist');
  return bgSrc.slice(at, bgSrc.indexOf('\n}', at) + 2);
}

test('the wallet is only handed over when Site sync is on', () => {
  // Same consent gate the record sits behind. With it off, the ping stays
  // exactly what it was: a yes/no about the extension existing.
  assert.match(bgSrc, /leaderboardBridge === true \? await bridgeWallet\(\) : null/,
    'the balance must never ride an un-consented ping');
});

test('the header chip costs no network and no chain replay', () => {
  // bridgeRecord exists to hand over evidence and verifies the whole chain.
  // Opening papertrench.com must not pay that for a header chip.
  const fn = walletFn();
  assert.ok(!/fetch\(/.test(fn), 'no price may be fetched to answer this');
  assert.ok(!/replayChain|readChainStore/.test(fn), 'and no chain replay');
});

test('an unpriced bag contributes its last mark or nothing, never a guess', () => {
  const fn = walletFn();
  assert.match(fn, /const px = Number\(pos\.lastPriceNative\) \|\| 0;/);
  assert.match(fn, /if \(px > 0\) held \+= qty \* px;/,
    'a bag with no mark adds nothing rather than an invented value');
  assert.match(fn, /marked:/,
    'and the reply must say whether every open bag was actually marked');
});

test('the site says nothing at all when it has not been told', () => {
  const site = fs.readFileSync(path.join(__dirname, '..', '..', 'site', 'nav-wallet.js'), 'utf8');
  assert.match(site, /if \(!wallet\) return;/, 'no answer renders no chip');
  assert.match(site, /reply\.ok && reply\.bridgeEnabled/, 'and a refusal renders no chip');
  // Nothing may reach the page except through render(), and render() must
  // refuse before it builds anything. build() is the only thing that touches
  // the slot, and only render() may call it.
  const render = site.slice(site.indexOf('function render('), site.indexOf('/* ---------- first answer'));
  assert.ok(render.indexOf('if (!wallet) return;') < render.indexOf('build()'),
    'a missing wallet must return before the chip is built');
  assert.ok(render.indexOf('Number.isFinite(equity)') < render.indexOf('build()'),
    'a non-numeric equity must return before the chip is built');
  const builders = site.match(/slot\.appendChild/g) || [];
  assert.ok(builders.length > 0, 'the chip has to get onto the page somehow');
  const buildFn = site.slice(site.indexOf('function build()'), site.indexOf('function render('));
  assert.equal((buildFn.match(/slot\.appendChild/g) || []).length, builders.length,
    'every append must live in build(), so render() is the only entry point');
});

test('the chip always labels the money as paper', () => {
  const site = fs.readFileSync(path.join(__dirname, '..', '..', 'site', 'nav-wallet.js'), 'utf8');
  assert.match(site, /nav-wallet-tag">PAPER</,
    'this number shares a bar with a leaderboard and a sign-in — it must never read as real');
});
