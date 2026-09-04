/* Warm destination viewers — Instant Everything links (Turbo Tier 1).
 *
 * The X viewer generalized to pump.fun and Solscan: one kept-warm muted tab
 * per family, clicks route as a full navigation in the warm tab, hovers
 * prefetch into the HIDDEN viewer only. This suite pins the same contracts
 * the X path earned the hard way, plus the ones unique to this design:
 * hints never create or reveal, toggle-off only closes never-used hidden
 * viewers, families never cross registrations, and the same-site guard keeps
 * pump.fun links native ON pump.fun.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

/* ---------------- classifier ---------------- */

function loadWarmDest() {
  const sandbox = { self: {}, URL, Set, String, RegExp };
  sandbox.self.self = sandbox.self;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'warmdest.js'), 'utf8'), sandbox, { filename: 'warmdest.js' });
  return sandbox.self.PTWarmDest;
}

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const SIG = '5' + 'k'.repeat(60);

test('the classifier routes pump.fun and solscan shapes and refuses everything else', () => {
  const WD = loadWarmDest();
  const plain = (v) => (v === null ? null : JSON.parse(JSON.stringify(v)));

  const coin = plain(WD.classify(`https://pump.fun/coin/${MINT}`));
  assert.deepEqual(coin, { family: 'pumpfun', kind: 'coin', url: `https://pump.fun/coin/${MINT}` });

  // www canonicalizes onto the bare host; path and query pass byte-for-byte.
  const query = WD.classify(`https://www.pump.fun/coin/${MINT}?include-nsfw=true`);
  assert.equal(query.url, `https://pump.fun/coin/${MINT}?include-nsfw=true`);

  const bare = WD.classify(`https://pump.fun/${MINT}`);
  assert.equal(bare.kind, 'coin');

  const board = WD.classify('https://pump.fun/board');
  assert.equal(board.kind, 'board');

  const token = plain(WD.classify(`https://solscan.io/token/${MINT}`));
  assert.deepEqual(token, { family: 'solscan', kind: 'token', url: `https://solscan.io/token/${MINT}` });

  const account = WD.classify(`https://www.solscan.io/account/${MINT}`);
  assert.equal(account.family, 'solscan');
  assert.equal(account.url, `https://solscan.io/account/${MINT}`);

  const tx = WD.classify(`https://solscan.io/tx/${SIG}`);
  assert.equal(tx.kind, 'tx');

  // Relative hrefs resolve against the page (terminals emit both forms).
  const rel = WD.classify(`/coin/${MINT}`, 'https://pump.fun/board');
  assert.equal(rel && rel.family, 'pumpfun');

  for (const href of [
    'https://pump.fun/how-it-works',           // not a destination page
    'https://pump.fun/coin/notbase58!!!',      // junk address
    `https://solscan.io/token/0xDEADBEEF`,     // EVM shape
    'https://solscan.io/leaderboard',          // not a destination page
    `https://pumpfun.evil.example/coin/${MINT}`, // wrong host
    `http://pump.fun/coin/${MINT}`,            // not https
    'not a url', '',
  ]) {
    assert.equal(WD.classify(href), null, `${JSON.stringify(href)} must not classify`);
  }
});

test('familyOfHost powers the same-site guard', () => {
  const WD = loadWarmDest();
  assert.equal(WD.familyOfHost('pump.fun'), 'pumpfun');
  assert.equal(WD.familyOfHost('www.pump.fun'), 'pumpfun');
  assert.equal(WD.familyOfHost('solscan.io'), 'solscan');
  // Turbo II: dexscreener joined the family matrix, so its links ON
  // dexscreener now stay native via this guard instead of by absence.
  assert.equal(WD.familyOfHost('dexscreener.com'), 'dexscreener');
  assert.equal(WD.familyOfHost('example.com'), null,
    'non-family hosts never trip the same-site guard');
  // warm-links.js must apply it: a pump.fun link ON pump.fun stays native.
  const warmLinks = fs.readFileSync(path.join(ROOT, 'warm-links.js'), 'utf8');
  assert.match(warmLinks, /familyOfHost\(window\.location\.hostname\) === target\.family/,
    'the interceptor must refuse same-family links — the site router beats a tab swap');
});

/* ---------------- manifest + message wiring ---------------- */

test('warmdest.js is wired into the right worlds in the right order', () => {
  const isolatedEntry = manifest.content_scripts.find((cs) => cs.js.includes('content.js'));
  assert.ok(isolatedEntry.js.includes('warmdest.js'),
    'the destination classifier must load on the trading sites');
  assert.ok(isolatedEntry.js.indexOf('warmdest.js') < isolatedEntry.js.indexOf('warm-links.js'),
    'the interceptor needs the classifier loaded before it');
  const background = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  assert.match(background, /importScripts\([^)]*'warmdest\.js'/,
    'the worker needs the classifier for its trust boundary');
});

test('every warmdest message type sent has a handler on the other side', () => {
  const background = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  const warmLinks = fs.readFileSync(path.join(ROOT, 'warm-links.js'), 'utf8');
  for (const type of ['pt_warmdest_open', 'pt_warmdest_hint']) {
    assert.match(warmLinks, new RegExp(`type: '${type}'`), `warm-links.js must send ${type}`);
    assert.match(background, new RegExp(`case '${type}'`), `background.js must handle ${type}`);
  }
  // The prewarm ping is RETIRED (Eyes343/TRNC: tabs appearing without a
  // click read as a malfunction). Nothing may send it; the worker keeps a
  // tolerated no-op case so an old content script gets a polite ok instead
  // of an unknown-type error.
  assert.doesNotMatch(warmLinks, /type: 'pt_warmdest_prewarm'/,
    'warm-links.js must no longer ask for pre-created viewers');
  assert.match(background, /case 'pt_warmdest_prewarm'/,
    'the worker keeps the tolerated no-op case for old content scripts');
});

/* ---------------- background flows ---------------- */

function destWorker(opts = {}) {
  const values = {
    pt_settings: {
      framesEnabled: false, recordingEnabled: false, autoReview: false,
      warmEverywhereEnabled: opts.enabled !== false,
      ...(opts.settings || {}),
    },
    pt_state: { positions: {}, rounds: [], journal: [] },
  };
  const session = {};
  const tabsById = new Map();
  let nextTabId = 900;
  const calls = { created: [], updated: [], removed: [], windows: [], sent: [] };
  const listeners = {};
  let messageListener = null;

  const sandbox = {
    console: { debug: () => {}, warn: () => {}, error: () => {}, log: () => {} },
    Promise, JSON, Math, Date, Number, String, Array, Object, Boolean, RegExp,
    Error, Set, Map, URL, URLSearchParams, AbortController, Uint8Array,
    setTimeout: (fn) => { return 1; }, clearTimeout: () => {},
    setInterval: () => 1, clearInterval: () => {},
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    chrome: {
      storage: {
        local: {
          get: (keys, callback) => {
            const names = Array.isArray(keys) ? keys : Object.keys(keys || {});
            const result = {};
            for (const key of names) if (Object.hasOwn(values, key)) result[key] = values[key];
            callback(result);
          },
          set: (update, callback) => { Object.assign(values, update); if (callback) callback(); },
        },
        session: {
          get: (keys, callback) => {
            const result = {};
            for (const key of keys) if (Object.hasOwn(session, key)) result[key] = session[key];
            callback(result);
          },
          set: (update, callback) => { Object.assign(session, update); if (callback) callback(); },
          remove: (key, callback) => { delete session[key]; if (callback) callback(); },
        },
      },
      runtime: {
        id: 'papertrench-test',
        openOptionsPage: () => {},
        onMessage: { addListener: (listener) => { messageListener = listener; } },
        onStartup: { addListener: () => {} },
        onInstalled: { addListener: () => {} },
        sendMessage: async () => ({}),
      },
      tabs: {
        create: async (props) => {
          const tab = {
            id: nextTabId++, windowId: props.windowId ?? 1, index: 0,
            active: !!props.active, url: props.url, discarded: false, status: 'complete',
            pinned: false, audible: false,
          };
          tabsById.set(tab.id, tab);
          calls.created.push({ ...props, id: tab.id });
          return tab;
        },
        update: async (id, props) => {
          calls.updated.push({ id, props });
          const tab = tabsById.get(id);
          if (!tab) throw new Error('no tab ' + id);
          if (props.url) tab.url = props.url;
          if (props.active) tab.active = true;
          return tab;
        },
        get: async (id) => {
          const tab = tabsById.get(id);
          if (!tab) throw new Error('no tab ' + id);
          return tab;
        },
        remove: async (id) => { calls.removed.push(id); tabsById.delete(id); },
        query: (query, callback) => {
          const urls = Array.isArray(query && query.url) ? query.url : [];
          if (urls.some((u) => u.includes('x.com'))) { callback([]); return; }
          callback(opts.platformTabs || []);
        },
        sendMessage: async (id, message) => { calls.sent.push({ id, message }); return { forwarded: true }; },
        captureVisibleTab: async () => 'data:image/jpeg;base64,',
        onRemoved: { addListener: (fn) => { (listeners.onRemovedAll ||= []).push(fn); listeners.onRemoved = (...a) => listeners.onRemovedAll.forEach((f) => f(...a)); } },
        onUpdated: { addListener: (fn) => { (listeners.onUpdatedAll ||= []).push(fn); listeners.onUpdated = (...a) => listeners.onUpdatedAll.forEach((f) => f(...a)); } },
        onActivated: { addListener: (fn) => { (listeners.onActivatedAll ||= []).push(fn); listeners.onActivated = (...a) => listeners.onActivatedAll.forEach((f) => f(...a)); } },
      },
      windows: { update: async (id, props) => { calls.windows.push({ id, props }); } },
      offscreen: { hasDocument: async () => false, createDocument: async () => {} },
    },
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  sandbox.importScripts = (...files) => {
    for (const file of files) {
      vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, { filename: file });
    }
  };
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8'), context, { filename: 'background.js' });

  return {
    values, session, tabsById, calls, listeners,
    get listener() { return messageListener; },
    seedDestViewer(family, props = {}) {
      const urls = { pumpfun: 'https://pump.fun/board', solscan: 'https://solscan.io/' };
      const tab = {
        id: nextTabId++, windowId: props.windowId ?? 1, index: 0, active: !!props.active,
        url: props.url || urls[family], discarded: false, status: 'complete',
        pinned: false, audible: false,
      };
      tabsById.set(tab.id, tab);
      session['pt_warm_tab_' + family] = { tabId: tab.id, used: !!props.used, createdAt: 1 };
      return tab;
    },
    settle() { return new Promise((resolve) => setImmediate(resolve)); },
  };
}

function send(listener, message, sender = { tab: { id: 1, windowId: 1, index: 0 } }) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('background response timed out')), 2000);
    const asyncResponse = listener(message, sender, (response) => {
      clearTimeout(timeout);
      resolve(response);
    });
    assert.equal(asyncResponse, true, 'background messages must keep the response channel open');
  });
}

const COIN = `https://pump.fun/coin/${MINT}`;
const TOKEN = `https://solscan.io/token/${MINT}`;

test('feature off: a destination click opens a plain new tab and registers nothing', async () => {
  const worker = destWorker({ enabled: false });
  const response = await send(worker.listener, { type: 'pt_warmdest_open', url: COIN });
  assert.equal(response.route, 'new_tab');
  assert.equal(worker.calls.created.length, 1);
  assert.equal(worker.calls.created[0].url, COIN);
  assert.equal(worker.session.pt_warm_tab_pumpfun, undefined);
});

test('the trust boundary re-classifies: junk from the content script opens nothing', async () => {
  const worker = destWorker();
  const response = await send(worker.listener, { type: 'pt_warmdest_open', url: 'https://evil.example/coin/' + MINT });
  assert.equal(response.ok, false);
  assert.equal(worker.calls.created.length, 0);
});

test('first click is cold but the new tab immediately becomes the family viewer', async () => {
  const worker = destWorker();
  const response = await send(worker.listener, { type: 'pt_warmdest_open', url: COIN });
  assert.equal(response.route, 'cold_tab');
  assert.equal(worker.calls.created[0].url, COIN);
  assert.equal(worker.calls.created[0].active, true);
  const reg = worker.session.pt_warm_tab_pumpfun;
  assert.ok(reg && reg.used === true, 'the cold tab registers as the (used) viewer');
});

test('with a warm viewer, a click is one navigate-and-reveal — no tab churn', async () => {
  const worker = destWorker();
  const viewer = worker.seedDestViewer('pumpfun');
  const response = await send(worker.listener, { type: 'pt_warmdest_open', url: COIN });
  assert.equal(response.route, 'warm_nav');
  assert.equal(worker.calls.created.length, 0, 'no new tab may be created');
  const update = worker.calls.updated.find((u) => u.id === viewer.id);
  assert.ok(update && update.props.url === COIN && update.props.active === true,
    'the viewer navigates to the target and is revealed in one call');
});

test('a viewer already parked on the target just reveals', async () => {
  const worker = destWorker();
  const viewer = worker.seedDestViewer('pumpfun', { url: COIN });
  const response = await send(worker.listener, { type: 'pt_warmdest_open', url: COIN });
  assert.equal(response.route, 'already_open');
  const update = worker.calls.updated.find((u) => u.id === viewer.id);
  assert.ok(update && !update.props.url, 'no reload of a page already showing the target');
});

test('families never cross: a solscan click cannot touch the pumpfun viewer', async () => {
  const worker = destWorker();
  const pumpViewer = worker.seedDestViewer('pumpfun');
  const response = await send(worker.listener, { type: 'pt_warmdest_open', url: TOKEN });
  assert.equal(response.route, 'cold_tab', 'solscan has no viewer yet — cold path');
  assert.ok(!worker.calls.updated.some((u) => u.id === pumpViewer.id && u.props.url),
    'the pumpfun viewer must not be navigated by a solscan open');
  assert.ok(worker.session.pt_warm_tab_solscan, 'solscan registers its own viewer');
});

test('a hover hint navigates the HIDDEN viewer and never reveals it', async () => {
  const worker = destWorker();
  const viewer = worker.seedDestViewer('pumpfun');
  await send(worker.listener, { type: 'pt_warmdest_hint', url: COIN });
  await worker.settle();
  const update = worker.calls.updated.find((u) => u.id === viewer.id);
  assert.ok(update && update.props.url === COIN, 'the hint drives the prefetch navigation');
  assert.ok(!update.props.active, 'a hover must never reveal');
  assert.equal(worker.calls.windows.length, 0, 'a hover must never focus a window');
  assert.equal(worker.session.pt_warm_tab_pumpfun.used, false,
    'a hint does not claim the viewer for the user');
});

test('hints never create tabs and never touch a viewer the user is reading', async () => {
  const worker = destWorker();
  await send(worker.listener, { type: 'pt_warmdest_hint', url: COIN });
  await worker.settle();
  assert.equal(worker.calls.created.length, 0, 'no viewer, no hint tab');

  const activeViewer = worker.seedDestViewer('solscan', { active: true });
  await send(worker.listener, { type: 'pt_warmdest_hint', url: TOKEN });
  await worker.settle();
  assert.ok(!worker.calls.updated.some((u) => u.id === activeViewer.id),
    'an active viewer is being READ — hover prefetch must not navigate it');
});

test('the prewarm ping is a no-op — NOTHING is created without a click', async () => {
  // Doctrine change after two independent reports of the same confusion
  // (Eyes343: "open every time you open/refresh the DEX"; TRNC: "when i
  // load up it randomly opens solscan and pump.fun website"). The
  // session-scoped closed-marker patch evaporated with every browser
  // restart, so the tabs came back each morning by construction. Viewer
  // creation now lives in the click path alone, for every family.
  const worker = destWorker({ platformTabs: [{ id: 7 }] });
  await send(worker.listener, { type: 'pt_warmdest_prewarm' });
  await send(worker.listener, { type: 'pt_warmdest_prewarm' });
  await worker.settle();
  assert.equal(worker.calls.created.length, 0,
    'no tab may ever be created by a prewarm ping');
  assert.equal(worker.session.pt_warm_tab_pumpfun, undefined, 'no registration either');
  assert.equal(worker.session.pt_warm_tab_solscan, undefined);
});

test('toggle-off closes only never-used hidden viewers and clears every registration', async () => {
  const worker = destWorker();
  const idle = worker.seedDestViewer('pumpfun');            // never used, hidden
  const used = worker.seedDestViewer('solscan', { used: true }); // the user's now
  worker.values.pt_settings.warmEverywhereEnabled = false;
  await send(worker.listener, { type: 'pt_settings_changed' });
  await worker.settle();
  assert.ok(worker.calls.removed.includes(idle.id), 'the idle viewer is ours to close');
  assert.ok(!worker.calls.removed.includes(used.id), 'a used viewer belongs to the user');
  assert.equal(worker.session.pt_warm_tab_pumpfun, undefined);
  assert.equal(worker.session.pt_warm_tab_solscan, undefined);
});

test('steering a viewer off its family releases it', async () => {
  const worker = destWorker();
  const viewer = worker.seedDestViewer('pumpfun');
  worker.listeners.onUpdated(viewer.id, { status: 'loading', url: 'https://example.com/' }, viewer);
  await worker.settle();
  assert.equal(worker.session.pt_warm_tab_pumpfun, undefined,
    'a viewer the user navigated elsewhere is their tab now');
});

test('closing a viewer clears its registration and does NOT respawn it', async () => {
  const worker = destWorker({ platformTabs: [{ id: 7 }] });
  const viewer = worker.seedDestViewer('pumpfun');
  worker.tabsById.delete(viewer.id);
  worker.listeners.onRemoved(viewer.id, { isWindowClosing: false });
  await worker.settle();
  assert.equal(worker.session.pt_warm_tab_pumpfun, undefined, 'registration cleared');
  assert.equal(worker.calls.created.length, 0,
    'destination viewers do not respawn — a closed viewer stays closed until the next click');
});

test('a closed viewer stays closed whatever pings arrive; only a real click revives the family', async () => {
  // The click creates; the user's close is an instruction; nothing between
  // those two events may create a tab. (Eyes343's refresh-infestation and
  // TRNC's load-up report are both this rule, violated.)
  const worker = destWorker({ platformTabs: [{ id: 7 }] });
  await send(worker.listener, { type: 'pt_warmdest_open', url: COIN });
  await worker.settle();
  assert.ok(worker.session.pt_warm_tab_pumpfun, 'a real click creates the family viewer');
  const createdAfterClick = worker.calls.created.length;

  const pumpId = worker.session.pt_warm_tab_pumpfun.tabId;
  worker.tabsById.delete(pumpId);
  worker.listeners.onRemoved(pumpId, { isWindowClosing: false });
  await worker.settle();

  // The DEX refreshes — an old content script pings prewarm, twice.
  await send(worker.listener, { type: 'pt_warmdest_prewarm' });
  await send(worker.listener, { type: 'pt_warmdest_prewarm' });
  await worker.settle();
  assert.equal(worker.calls.created.length, createdAfterClick,
    'nothing may resurrect a viewer the user closed');
  assert.equal(worker.session.pt_warm_tab_pumpfun, undefined, 'no zombie registration either');

  // A real pump.fun click is the user asking for the destination again.
  await send(worker.listener, { type: 'pt_warmdest_open', url: COIN });
  await worker.settle();
  assert.ok(worker.session.pt_warm_tab_pumpfun, 'the click recreates the family viewer');
  assert.equal(worker.session.pt_warm_tab_pumpfun_closed, undefined,
    'the stay-closed marker is lifted by the click');
});

/* ---------------- Turbo receipts (local route timings) ---------------- */

test('every routed open leaves a local receipt: route count + bounded timing ring', async () => {
  const worker = destWorker({ settings: { warmXLinksEnabled: true } });

  // Destination cold open → dest:cold_tab receipt.
  await send(worker.listener, { type: 'pt_warmdest_open', url: COIN });
  await worker.settle();
  // X cold open (no viewer, no adoptable tab) → x:cold_tab receipt.
  await send(worker.listener, { type: 'pt_warm_open', url: 'https://x.com/degen/status/1' });
  await worker.settle();
  // Warm follow-up on the registered pumpfun viewer → dest:warm_nav receipt.
  await send(worker.listener, { type: 'pt_warmdest_open', url: TOKEN.replace('token', 'account') === TOKEN ? TOKEN : COIN + '?fresh=1' });
  await worker.settle();

  const stats = worker.values.pt_turbo_stats || {};
  assert.equal(stats['dest:cold_tab'] && stats['dest:cold_tab'].count, 1,
    'the first destination open records its cold route');
  assert.equal(stats['x:cold_tab'] && stats['x:cold_tab'].count, 1,
    'the X cold route records too');
  assert.equal(stats['dest:warm_nav'] && stats['dest:warm_nav'].count, 1,
    'the warm follow-up records as warm_nav');
  for (const key of Object.keys(stats)) {
    assert.ok(Array.isArray(stats[key].ring), `${key} must carry a timing ring`);
    assert.ok(stats[key].ring.every((v) => Number.isFinite(v)), `${key} ring holds numbers only`);
  }
});

test('receipts stay local and bounded (source contract)', () => {
  const background = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  assert.match(background, /TURBO_RING_MAX = 50/, 'the ring is bounded');
  assert.match(background, /entry\.ring\.splice\(0, entry\.ring\.length - TURBO_RING_MAX\)/,
    'oldest samples are dropped, never the newest');
  // The stats key is only ever written via chrome.storage.local — no fetch,
  // no external sink may ever touch it. The slice covers turboNote AND the
  // Tier 3 jank merge (turboJankNote), which lives in the same block.
  const turboBlock = background.slice(
    background.indexOf('const TURBO_STATS_KEY'),
    background.indexOf('warm X links (instant post opens)'),
  );
  assert.doesNotMatch(turboBlock, /fetch\(/, 'receipts never leave the device');
  assert.match(turboBlock, /TURBO_JANK_SITES_MAX = 12/, 'the jank site table is bounded');
  assert.match(turboBlock, /function turboJankNote\(/,
    'the jank merge shares the block — and therefore this contract');

  // Tier 3 widens the pt_turbo_stats surface to content.js (the sampler) and
  // dashboard.js (the card). Same rules, verbatim: no fetch anywhere near the
  // key — and the sampler may not even touch storage directly, because every
  // write must flow through the background write chain (turboChain) or two
  // writers could silently lose each other's read-modify-write.
  const content = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  const samplerBlock = content.slice(
    content.indexOf('Turbo receipts: page jank sampling'),
    content.indexOf('async function init()'),
  );
  assert.match(samplerBlock, /pt_turbo_jank/, 'the sampler flushes through the background');
  assert.doesNotMatch(samplerBlock, /fetch\(/, 'jank samples never leave the device');
  assert.doesNotMatch(samplerBlock, /chrome\.storage/,
    'the sampler holds no storage path of its own');

  const dash = fs.readFileSync(path.join(ROOT, 'dashboard.js'), 'utf8');
  const cardBlock = dash.slice(
    dash.indexOf('Turbo receipts: dashboard card'),
    dash.indexOf('function renderSettings('),
  );
  assert.doesNotMatch(cardBlock, /fetch\(/, 'the card computes locally');
  assert.doesNotMatch(cardBlock, /storage\.local\.set|store\.set/,
    'the card is read-only over the stats key');
});

/* ------------- the main terminals: Axiom / Padre / GMGN families ------- */

test('the classifier routes the main terminals token pages and refuses their other routes', () => {
  const WD = loadWarmDest();

  const axiom = WD.classify(`https://axiom.trade/meme/${MINT}`);
  assert.equal(axiom && axiom.family, 'axiom');
  assert.equal(axiom.url, `https://axiom.trade/meme/${MINT}`);
  assert.equal(WD.classify(`https://axiom.trade/t/${MINT}`).family, 'axiom');

  const padre = WD.classify(`https://trade.padre.gg/trade/solana/${MINT}`);
  assert.equal(padre && padre.family, 'padre');
  assert.equal(padre.url, `https://trade.padre.gg/trade/solana/${MINT}`);

  const gmgn = WD.classify(`https://gmgn.ai/sol/token/${MINT}?chain=sol`);
  assert.equal(gmgn && gmgn.family, 'gmgn');
  assert.equal(gmgn.url, `https://gmgn.ai/sol/token/${MINT}?chain=sol`,
    'query passes byte-for-byte');

  const fomo = WD.classify(`https://fomo.family/tokens/solana/${MINT}?ref=abc`);
  assert.equal(fomo && fomo.family, 'fomo');
  assert.equal(fomo.url, `https://fomo.family/tokens/solana/${MINT}?ref=abc`,
    'query passes byte-for-byte');
  assert.equal(WD.classify(`https://www.fomo.family/tokens/solana/${MINT}`).url,
    `https://fomo.family/tokens/solana/${MINT}`, 'www canonicalizes to the bare host');

  const lute = WD.classify(`https://lute.gg/trade/${MINT}?ref=abc`);
  assert.equal(lute && lute.family, 'lute');
  assert.equal(lute.url, `https://lute.gg/trade/${MINT}?ref=abc`,
    'query passes byte-for-byte');
  assert.equal(WD.classify(`https://www.lute.gg/trade/${MINT}`).url,
    `https://lute.gg/trade/${MINT}`, 'www canonicalizes to the bare host');

  // The O-10/O-11 discipline carries over: wallet/portfolio/EVM routes and
  // the terminals own list pages must never warm-route.
  for (const href of [
    `https://axiom.trade/portfolio/${MINT}`,
    'https://axiom.trade/pulse',
    `https://trade.padre.gg/wallet/${MINT}`,
    `https://gmgn.ai/eth/token/${MINT}`,
    `https://gmgn.ai/sol/address/${MINT}`,
    `https://fomo.family/tokens/base/0xabcdef1234567891abcdef1234567891abcdef12`,
    `https://fomo.family/tokens/robinhood/0xdc29db7d4396ed738710a5373a30afc197e7268a`,
    'https://fomo.family/u/sometrader',
    'https://fomo.family/profile/sometrader',
    'https://fomo.family/token',
    'https://lute.gg/trade/compass',
    'https://lute.gg/trade',
    'https://lute.gg/login',
  ]) {
    assert.equal(WD.classify(href), null, `${JSON.stringify(href)} must not classify`);
  }

  assert.equal(WD.familyOfHost('axiom.trade'), 'axiom');
  assert.equal(WD.familyOfHost('trade.padre.gg'), 'padre');
  assert.equal(WD.familyOfHost('gmgn.ai'), 'gmgn');
  assert.equal(WD.familyOfHost('fomo.family'), 'fomo');
  assert.equal(WD.familyOfHost('lute.gg'), 'lute');
});

test('terminal viewers are never pre-created — first click pays, then it is warm', async () => {
  const worker = destWorker({ platformTabs: [{ id: 7 }] });
  await send(worker.listener, { type: 'pt_warmdest_prewarm' });
  await worker.settle();
  assert.equal(worker.calls.created.length, 0,
    'nothing is pre-created — for terminals or anyone else (click-only doctrine)');

  const AXIOM_URL = `https://axiom.trade/meme/${MINT}`;
  const first = await send(worker.listener, { type: 'pt_warmdest_open', url: AXIOM_URL });
  assert.equal(first.route, 'cold_tab', 'the first terminal hop pays cold');
  assert.ok(worker.session.pt_warm_tab_axiom, 'and the tab becomes the Axiom viewer');

  const second = await send(worker.listener, {
    type: 'pt_warmdest_open',
    url: `https://axiom.trade/t/${MINT}`,
  });
  assert.equal(second.route, 'warm_nav', 'every hop after that is a warm navigate-and-reveal');
});

/* ------------- Turbo II: the remaining terminal families ------------- */

test('the new terminal families classify their token routes and refuse the rest', () => {
  const WD = loadWarmDest();
  const WSOL = 'So11111111111111111111111111111111111111112';

  const bullx = WD.classify(`https://neo.bullx.io/terminal?chainId=1399811149&address=${MINT}`);
  assert.equal(bullx && bullx.family, 'bullx');
  assert.equal(bullx.url, `https://neo.bullx.io/terminal?chainId=1399811149&address=${MINT}`,
    'query passes byte-for-byte');
  assert.equal(WD.classify(`https://bullx.io/terminal?address=${MINT}`).family, 'bullx',
    'a missing chainId defaults to Solana; the whole-base58 address gate still holds');

  const photonLp = WD.classify(`https://photon-sol.tinyastro.io/en/lp/${MINT}`);
  assert.equal(photonLp && photonLp.family, 'photon');
  assert.equal(photonLp.url, `https://photon-sol.tinyastro.io/en/lp/${MINT}`);
  assert.equal(WD.classify(`https://photon-sol.tinyastro.io/zh/r/${MINT}`).family, 'photon',
    'the locale prefix varies; /r/<mint> is Photon\'s own mint route (O-12)');

  assert.equal(WD.classify(`https://dexscreener.com/solana/${MINT}`).family, 'dexscreener');

  const birdeye = WD.classify(`https://birdeye.so/token/${MINT}?chain=solana`);
  assert.equal(birdeye && birdeye.family, 'birdeye');
  assert.equal(birdeye.url, `https://birdeye.so/token/${MINT}?chain=solana`);

  assert.equal(WD.classify(`https://jup.ag/tokens/${MINT}`).family, 'jupiter');
  assert.equal(WD.classify(`https://jup.ag/swap/SOL-${MINT}`).family, 'jupiter');
  assert.equal(WD.classify(`https://jup.ag/swap?inputMint=${WSOL}&outputMint=${MINT}`).family,
    'jupiter', 'the query form the app rewrites itself into');

  // O-10/O-11 carries over: wallet routes, EVM shapes, non-Solana chains,
  // and quote-only swaps must never warm-route.
  for (const href of [
    'https://neo.bullx.io/terminal?chainId=1&address=0x1234567890abcdef1234567890abcdef12345678',
    'https://neo.bullx.io/terminal?chainId=1399811149&address=0x1234567890abcdef1234567890abcdef12345678',
    'https://neo.bullx.io/portfolio',
    'https://photon-sol.tinyastro.io/en/discover',
    'https://dexscreener.com/ethereum/0x1234567890abcdef1234567890abcdef12345678',
    'https://dexscreener.com/watchlist',
    `https://birdeye.so/token/${MINT}?chain=ethereum`,
    `https://birdeye.so/profile/${MINT}`,
    `https://jup.ag/portfolio/${MINT}`,
    'https://jup.ag/swap/SOL-USDC',
    `https://jup.ag/swap?inputMint=${WSOL}&outputMint=${WSOL}`,
  ]) {
    assert.equal(WD.classify(href), null, `${JSON.stringify(href)} must not classify`);
  }

  assert.equal(WD.familyOfHost('neo.bullx.io'), 'bullx');
  assert.equal(WD.familyOfHost('photon-sol.tinyastro.io'), 'photon');
  assert.equal(WD.familyOfHost('birdeye.so'), 'birdeye');
  assert.equal(WD.familyOfHost('jup.ag'), 'jupiter');
});

test('the new families ride the click-created viewer flow, never prewarm', async () => {
  const worker = destWorker({ platformTabs: [{ id: 7 }] });
  await send(worker.listener, { type: 'pt_warmdest_prewarm' });
  await worker.settle();
  assert.equal(worker.calls.created.length, 0,
    'nothing is pre-created for any family (click-only doctrine)');

  const DEX_URL = `https://dexscreener.com/solana/${MINT}`;
  const first = await send(worker.listener, { type: 'pt_warmdest_open', url: DEX_URL });
  assert.equal(first.route, 'cold_tab', 'the first hop pays cold');
  assert.ok(worker.session.pt_warm_tab_dexscreener, 'and the tab becomes the family viewer');

  const second = await send(worker.listener, { type: 'pt_warmdest_open', url: `${DEX_URL}?t=1` });
  assert.equal(second.route, 'warm_nav', 'every hop after that is a warm navigate-and-reveal');
});

test('the positions-bar chip hop routes cross-terminal through the warm viewer (source contract)', () => {
  const content = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  const fn = content.slice(
    content.indexOf('function openPositionChart('),
    content.indexOf('function measureBarLeft('),
  );
  assert.match(fn, /pt_warmdest_open/,
    'a cross-terminal chip hop must offer the warm route');
  assert.match(fn, /familyOfHost\(location\.hostname\) !== dest\.family/,
    'same-terminal hops keep the native same-tab swap');
  assert.match(fn, /window\.location\.href = url/,
    'the native hop must remain as the fallback');
});

test('preconnect targets cover every family exactly once, plus x.com (Turbo III)', () => {
  const WD = loadWarmDest();
  // One known-good token URL per family, mirroring the classify gates above.
  // If a canonical host moves in classify() but not in the preconnect table,
  // this is the test that goes red.
  const samples = [
    ['pumpfun', `https://pump.fun/coin/${MINT}`],
    ['solscan', `https://solscan.io/token/${MINT}`],
    ['axiom', `https://axiom.trade/meme/${MINT}`],
    ['padre', `https://trade.padre.gg/trade/solana/${MINT}`],
    ['gmgn', `https://gmgn.ai/sol/token/${MINT}`],
    ['fomo', `https://fomo.family/tokens/solana/${MINT}`],
    ['bullx', `https://neo.bullx.io/terminal?address=${MINT}`],
    ['photon', `https://photon-sol.tinyastro.io/en/lp/${MINT}`],
    ['dexscreener', `https://dexscreener.com/solana/${MINT}`],
    ['birdeye', `https://birdeye.so/token/${MINT}?chain=solana`],
    ['jupiter', `https://jup.ag/tokens/${MINT}`],
    ['lute', `https://lute.gg/trade/${MINT}`],
  ];
  const origins = new Map();
  for (const [family, href] of samples) {
    const target = WD.classify(href);
    assert.ok(target, `${href} must classify`);
    assert.equal(target.family, family);
    const origin = target.url.slice(0, target.url.indexOf('/', 8));
    assert.match(origin, /^https:\/\/[^/]+$/, 'canonical origins carry no path');
    origins.set(family, origin);
  }
  assert.equal(origins.size, 12, 'twelve families, twelve distinct origins');

  // From a neutral page every origin plus the X origins is wanted.
  const neutral = WD.preconnectTargets('example.com');
  assert.equal(neutral.length, 15);
  assert.ok(neutral.includes('https://x.com'), 'x.com is always included');
  assert.ok(neutral.includes('https://pbs.twimg.com'), 'viewer images ride along');
  assert.ok(neutral.includes('https://abs.twimg.com'), 'viewer static assets ride along');
  for (const origin of origins.values()) {
    assert.ok(neutral.includes(origin), `${origin} must be preconnected`);
  }

  // From inside a family its own origin drops out — same-origin sockets are
  // already warm — while every other family stays.
  for (const [family, href] of samples) {
    const host = new URL(href).hostname;
    const targets = WD.preconnectTargets(host);
    assert.equal(targets.length, 14, `exactly one exclusion on ${host}`);
    assert.ok(!targets.includes(origins.get(family)), `own origin excluded on ${host}`);
    assert.ok(targets.includes('https://x.com'), 'x.com survives the filter');
  }
});

test('same-site prefetch names only own-family token URLs in scope (Turbo III round 2)', () => {
  const WD = loadWarmDest();
  const FIVE = ['gmgn', 'axiom', 'padre', 'lute', 'fomo'];
  const own = [
    [`https://gmgn.ai/sol/token/${MINT}`, 'gmgn.ai'],
    [`https://axiom.trade/meme/${MINT}`, 'axiom.trade'],
    [`https://trade.padre.gg/trade/solana/${MINT}`, 'trade.padre.gg'],
    [`https://fomo.family/tokens/solana/${MINT}`, 'fomo.family'],
    [`https://lute.gg/trade/${MINT}`, 'lute.gg'],
  ];
  for (const [href, host] of own) {
    assert.equal(WD.sameSitePrefetchable(href, href, host, FIVE), href);
  }
  // Cross-family refuses: a gmgn link seen from axiom is a viewer job.
  assert.equal(
    WD.sameSitePrefetchable(`https://gmgn.ai/sol/token/${MINT}`, 'https://axiom.trade/', 'axiom.trade', FIVE),
    null);
  // A token shape on an out-of-scope family refuses (pump.fun not listed).
  assert.equal(
    WD.sameSitePrefetchable(`https://pump.fun/coin/${MINT}`, 'https://pump.fun/board', 'pump.fun', FIVE),
    null);
  // Non-token routes refuse even in scope.
  assert.equal(
    WD.sameSitePrefetchable('https://trade.padre.gg/portfolio', 'https://trade.padre.gg/', 'trade.padre.gg', FIVE),
    null);
  // Relative hrefs resolve against the page.
  assert.equal(
    WD.sameSitePrefetchable(`/meme/${MINT}`, 'https://axiom.trade/', 'axiom.trade', FIVE),
    `https://axiom.trade/meme/${MINT}`);
  // Garbage never throws, just refuses.
  assert.equal(WD.sameSitePrefetchable('not a url', 'https://axiom.trade/', 'axiom.trade', FIVE), null);
  assert.equal(WD.sameSitePrefetchable(null, 'https://axiom.trade/', 'axiom.trade', FIVE), null);
});

/* ---------------- same-terminal chart opens (Turbo III) ---------------- */

const GMGN_A = `https://gmgn.ai/sol/token/${MINT}`;
const GMGN_B = 'https://gmgn.ai/sol/token/7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const ON_GMGN = { tab: { id: 1, windowId: 1, index: 0, url: 'https://gmgn.ai/?chain=sol' } };
const sameWorker = (opts = {}) => destWorker({ enabled: false, platformTabs: opts.platformTabs, settings: { warmSameSiteEnabled: true, ...(opts.settings || {}) } });

test('same-terminal: the first click stays native and spawns a HIDDEN viewer parked on that page', async () => {
  const worker = sameWorker();
  const hint = await send(worker.listener, { type: 'pt_warmsame_hint', url: GMGN_A }, ON_GMGN);
  assert.deepEqual({ viewer: hint.viewer, ready: hint.ready }, { viewer: false, ready: false }, 'a hover never creates a tab');
  assert.equal(worker.calls.created.length, 0);

  const spawn = await send(worker.listener, { type: 'pt_warmsame_spawn', url: GMGN_A }, ON_GMGN);
  assert.equal(spawn.route, 'spawned');
  assert.equal(worker.calls.created.length, 1, 'the click created exactly one tab');
  const created = worker.calls.created[0];
  assert.equal(created.active, false, 'the spawned viewer stays hidden — the click itself went native');
  assert.equal(created.autoDiscardable, false, 'and stays resident');
  assert.equal(created.url, GMGN_A);
  assert.ok(worker.calls.updated.some((u) => u.id === created.id && u.props.muted === true), 'muted');
  assert.equal(worker.session.pt_warm_tab_gmgn.tabId, created.id, 'registered as the gmgn family viewer');
  assert.equal(worker.session.pt_warm_tab_gmgn.used, false, 'never shown, so toggle-off may close it');

  const again = await send(worker.listener, { type: 'pt_warmsame_spawn', url: GMGN_B }, ON_GMGN);
  assert.equal(again.route, 'viewer_exists', 'a second click never spawns a second viewer');
  assert.equal(worker.calls.created.length, 1);
});

test('same-terminal: hover navigates the hidden viewer; readiness is pushed to the asking tab on load complete', async () => {
  const worker = sameWorker();
  const viewer = worker.seedDestViewer('gmgn', { url: GMGN_A });
  viewer.status = 'loading';
  const hint = await send(worker.listener, { type: 'pt_warmsame_hint', url: GMGN_B }, ON_GMGN);
  assert.deepEqual({ viewer: hint.viewer, ready: hint.ready }, { viewer: true, ready: false });
  assert.ok(worker.calls.updated.some((u) => u.id === viewer.id && u.props.url === GMGN_B), 'the viewer was sent to the hovered token');
  assert.equal(worker.calls.sent.length, 0, 'nothing is ready yet');

  // A loading event for some OTHER page (a superseded hint) says nothing.
  worker.listeners.onUpdated(viewer.id, { status: 'complete' }, { ...viewer, url: GMGN_A });
  assert.equal(worker.calls.sent.length, 0, 'a complete for a different URL is not readiness');

  worker.listeners.onUpdated(viewer.id, { status: 'complete' }, { ...viewer, url: GMGN_B });
  assert.equal(worker.calls.sent.length, 1, 'readiness is pushed exactly once');
  assert.deepEqual(JSON.parse(JSON.stringify(worker.calls.sent[0])), { id: 1, message: { type: 'pt_warmsame_ready', url: GMGN_B } });
});

test('same-terminal: a viewer already parked and loaded answers ready immediately; the click reveals it', async () => {
  const worker = sameWorker();
  const viewer = worker.seedDestViewer('gmgn', { url: GMGN_B });
  const hint = await send(worker.listener, { type: 'pt_warmsame_hint', url: GMGN_B }, ON_GMGN);
  assert.equal(hint.ready, true);
  const open = await send(worker.listener, { type: 'pt_warmsame_open', url: GMGN_B }, ON_GMGN);
  assert.equal(open.route, 'warm_reveal');
  assert.ok(worker.calls.updated.some((u) => u.id === viewer.id && u.props.active === true), 'revealed');
  assert.equal(worker.calls.created.length, 0, 'no new tab');
  assert.equal(worker.session.pt_warm_tab_gmgn.used, true, 'a revealed viewer belongs to the user');
  assert.ok(worker.values.pt_turbo_stats['same:warm_reveal'].count >= 1, 'receipted as a warm route');
});

test('same-terminal: the viewer never takes a click from ITSELF, nor from a tab the user is looking at', async () => {
  const worker = sameWorker();
  const viewer = worker.seedDestViewer('gmgn', { url: GMGN_A });
  const fromViewer = { tab: { id: viewer.id, windowId: 1, index: 0, url: GMGN_A } };
  const hint = await send(worker.listener, { type: 'pt_warmsame_hint', url: GMGN_B }, fromViewer);
  assert.equal(hint.viewer, false, 'from the viewer tab, there is no viewer to warm');
  assert.equal(worker.calls.updated.length, 0, 'the tab the user is on is never navigated by a hover');
  const spawn = await send(worker.listener, { type: 'pt_warmsame_spawn', url: GMGN_B }, fromViewer);
  assert.equal(spawn.route, 'viewer_exists', 'and no second viewer is spawned for it');

  viewer.active = true;
  const hint2 = await send(worker.listener, { type: 'pt_warmsame_hint', url: GMGN_B }, ON_GMGN);
  assert.equal(hint2.viewer, false, 'an active viewer is the user\'s reading, not a hint target');
  assert.equal(worker.calls.updated.length, 0);
});

test('same-terminal: cross-family and off-terminal asks refuse; the flag off refuses everything', async () => {
  const worker = sameWorker();
  worker.seedDestViewer('gmgn', { url: GMGN_A });
  const fromAxiom = { tab: { id: 1, windowId: 1, index: 0, url: 'https://axiom.trade/pulse' } };
  assert.equal((await send(worker.listener, { type: 'pt_warmsame_hint', url: GMGN_B }, fromAxiom)).ok, false, 'a gmgn link on axiom is a cross-site job');
  const pump = { tab: { id: 1, windowId: 1, index: 0, url: 'https://pump.fun/board' } };
  assert.equal((await send(worker.listener, { type: 'pt_warmsame_spawn', url: `https://pump.fun/coin/${MINT}` }, pump)).ok, false, 'pump.fun is not in scope');
  assert.equal(worker.calls.created.length, 0);

  const off = destWorker({ enabled: false });
  assert.equal((await send(off.listener, { type: 'pt_warmsame_spawn', url: GMGN_A }, ON_GMGN)).ok, false);
  assert.equal(off.calls.created.length, 0, 'flag off: no tab, ever');
});

test('same-terminal: a click whose viewer moved falls through to the ordinary destination route, never a swallowed click', async () => {
  const worker = sameWorker({ settings: { warmEverywhereEnabled: true } });
  worker.seedDestViewer('gmgn', { url: GMGN_A });
  // Content believed B was ready; the viewer is actually on A.
  const open = await send(worker.listener, { type: 'pt_warmsame_open', url: GMGN_B }, ON_GMGN);
  assert.equal(open.ok, true);
  assert.equal(open.route, 'warm_nav', 'the destination route navigates the viewer and reveals it');
});

test('same-terminal: turning the flag off closes an unused hidden viewer, keeps one the user has seen', async () => {
  const worker = sameWorker();
  const hidden = worker.seedDestViewer('gmgn', { url: GMGN_A });
  const seen = worker.seedDestViewer('axiom', { url: `https://axiom.trade/meme/${MINT}`, used: true });
  worker.values.pt_settings.warmSameSiteEnabled = false;
  await send(worker.listener, { type: 'pt_settings_changed' });
  await worker.settle();
  assert.ok(worker.calls.removed.includes(hidden.id), 'the never-shown viewer goes');
  assert.ok(!worker.calls.removed.includes(seen.id), 'the user\'s tab stays');
});

test('same-terminal: the content side only claims a click the background already called ready (source contract)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'warm-links.js'), 'utf8');
  const click = src.slice(src.indexOf("addEventListener('click'"), src.indexOf('/* Hover prefetch.'));
  assert.match(click, /sameReady && sameReady\.url === same/, 'reveal only for the exact URL reported ready');
  assert.match(click, /pt_warmsame_spawn/, 'otherwise the click stays native and asks for a viewer');
  const spawnAt = click.indexOf('pt_warmsame_spawn');
  assert.doesNotMatch(click.slice(spawnAt, spawnAt + 400), /preventDefault/, 'the spawn path never eats the click');
  assert.match(src, /message\.url === sameHintUrl\) sameReady/, 'a stale readiness notice for a page the cursor left is ignored');
  assert.match(src, /if \(sameHintUrl !== url\) sameReady = null/, 'moving the viewer invalidates readiness');
});
