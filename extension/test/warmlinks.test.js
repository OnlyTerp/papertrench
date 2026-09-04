/* Warm X links — the instant-post-open path (v2.4.0).
 *
 * The reference design this feature clean-rooms had four defects this suite
 * pins shut: interception gated on userActivation (fires for every real click,
 * so the warm path never ran), a "lock" that was declared but never used, a
 * TTL that closed the tab out from under a reading user, and reveal-after-
 * verify (user waits on DOM polling before seeing anything). PaperTrench's
 * version: capture-phase click interception, a real serialization chain, a
 * single self-sustaining viewer tab with no TTL, and reveal-first with
 * repair-behind-the-eyes.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

/* ---------------- URL classifier ---------------- */

function loadXLinks() {
  const sandbox = { self: {}, URL, Set, String, RegExp };
  sandbox.self.self = sandbox.self;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'xlinks.js'), 'utf8'), sandbox, { filename: 'xlinks.js' });
  return sandbox.self.PTXLinks;
}

test('the classifier routes posts and profiles and refuses everything else', () => {
  const X = loadXLinks();
  // vm-realm objects have a foreign Object.prototype; compare structurally.
  const plain = (v) => (v === null ? null : JSON.parse(JSON.stringify(v)));

  const post = plain(X.classify('https://x.com/someuser/status/1234567890'));
  assert.deepEqual(post, { kind: 'post', handle: 'someuser', postId: '1234567890', url: 'https://x.com/someuser/status/1234567890' });

  // twitter.com and share params canonicalize onto x.com — pushState in the
  // viewer can only target its own origin.
  const legacy = X.classify('https://twitter.com/SomeUser/status/42?s=20');
  assert.equal(legacy.url, 'https://x.com/SomeUser/status/42?s=20');
  assert.equal(legacy.postId, '42');

  const embed = X.classify('https://x.com/i/web/status/777');
  assert.equal(embed.kind, 'post');
  assert.equal(embed.postId, '777');
  assert.equal(embed.handle, null);

  const profile = plain(X.classify('https://x.com/SomeToken'));
  assert.deepEqual(profile, { kind: 'profile', handle: 'sometoken', postId: null, url: 'https://x.com/SomeToken' });

  // The trench-native forms: communities (GMGN rows) and CA searches (Axiom).
  const community = plain(X.classify('https://twitter.com/i/communities/2012484577227419741'));
  assert.deepEqual(community, { kind: 'community', handle: null, postId: null,
    url: 'https://x.com/i/communities/2012484577227419741' });
  const search = plain(X.classify('https://x.com/search?q=bonk&src=typed_query'));
  assert.equal(search.kind, 'search');
  assert.equal(search.url, 'https://x.com/search?q=bonk&src=typed_query');

  // System surfaces, other hosts, other protocols: never warm-routed.
  for (const href of [
    'https://x.com/home', 'https://x.com/search', 'https://x.com/compose/post',
    'https://x.com/i/communities/', 'https://x.com/settings/account',
    'https://x.com/hashtag/bonk', 'https://x.com/intent/tweet?text=hi',
    'https://gmgn.ai/sol/token/abc', 'https://xcom.evil.example/user/status/1',
    'http://x.com/user/status/1', 'not a url', '',
  ]) {
    assert.equal(X.classify(href), null, `${JSON.stringify(href)} must not classify`);
  }
});

/* ---------------- manifest wiring ---------------- */

test('the warm-links scripts are wired into the right worlds in the right order', () => {
  const mainEntry = manifest.content_scripts.find((cs) => cs.js.includes('price-bridge.js'));
  assert.ok(mainEntry.js.indexOf('xlinks.js') < mainEntry.js.indexOf('warm-open-hook.js'),
    'the MAIN-world hook needs the classifier loaded before it');

  const isolatedEntry = manifest.content_scripts.find((cs) => cs.js.includes('content.js'));
  assert.ok(isolatedEntry.js.includes('warm-links.js'),
    'the click interceptor must load on the trading sites');
  assert.ok(isolatedEntry.js.indexOf('xlinks.js') < isolatedEntry.js.indexOf('warm-links.js'),
    'the click interceptor needs the classifier loaded before it');

  const xMain = manifest.content_scripts.find((cs) => cs.js.includes('xwarm-main.js'));
  const xRelay = manifest.content_scripts.find((cs) => cs.js.includes('xwarm-relay.js'));
  assert.equal(xMain.world, 'MAIN', 'the SPA driver must run in the page world to drive X\'s router');
  assert.equal((xRelay.world || 'ISOLATED'), 'ISOLATED', 'the relay needs chrome.runtime, so ISOLATED');
});

test('the permission list is pinned — scripting is the one deliberate addition', () => {
  // v2.4.0 added ZERO permissions by design: static content scripts instead
  // of `scripting`, lazy validation instead of `alarms`. Turbo II DID add
  // `scripting`, deliberately and after exactly the debate this pin exists
  // to force: the opt-in Discord/Telegram/everywhere spread registers its
  // bundle at runtime, which keeps the O-09 property (nothing injected
  // anywhere until the user turns a toggle on) that a static <all_urls>
  // entry would have destroyed. Least privilege is a release property
  // (load.test.js pins the list too; this states the why).
  assert.deepEqual([...manifest.permissions].sort(),
    ['activeTab', 'alarms', 'offscreen', 'scripting', 'sidePanel', 'storage', 'tabs', 'unlimitedStorage'].sort());
});

test('press-time and trajectory prefetch are hints only — a press never claims the click', () => {
  const warmLinks = fs.readFileSync(path.join(ROOT, 'warm-links.js'), 'utf8');
  const pressAt = warmLinks.indexOf("addEventListener('pointerdown'");
  assert.ok(pressAt !== -1, 'the press-time prefetch listener must exist');
  const trajAt = warmLinks.indexOf("addEventListener('mousemove'");
  assert.ok(trajAt !== -1, 'the trajectory sampler must exist');
  const scrollAt = warmLinks.indexOf("addEventListener('scroll'");
  assert.ok(pressAt < trajAt && trajAt < scrollAt, 'both prefetch listeners live before the scroll dismissal');
  const block = warmLinks.slice(pressAt, scrollAt);
  assert.doesNotMatch(block, /preventDefault|stopPropagation/,
    'prefetch signals must never eat the event — claiming belongs to the click path');
  assert.doesNotMatch(block, /pt_warm_open|pt_warmdest_open/,
    'prefetch signals may only ever HINT — opens belong to real clicks');
  assert.match(block, /event\.ctrlKey \|\| event\.metaKey \|\| event\.shiftKey \|\| event\.altKey/,
    'modified presses bypass prefetch exactly like modified clicks bypass routing');
  // All three signals (dwell, press, trajectory) share one dedup budget, so
  // stacking signals can never stack traffic.
  assert.match(warmLinks, /function sendXHint/, 'the shared X hint sender must exist');
  assert.match(warmLinks, /function sendDestHint/, 'the shared destination hint sender must exist');
});

/* ---------------- message contract (string level, wiring.test.js style) ---- */

test('every warm message type sent has a handler on the other side', () => {
  const background = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  const warmLinks = fs.readFileSync(path.join(ROOT, 'warm-links.js'), 'utf8');
  const relay = fs.readFileSync(path.join(ROOT, 'xwarm-relay.js'), 'utf8');

  for (const type of ['pt_warm_open', 'pt_warm_hint', 'pt_warm_oembed', 'pt_warm_prewarm', 'pt_warmsame_hint', 'pt_warmsame_open', 'pt_warmsame_spawn']) {
    assert.match(warmLinks, new RegExp(`type: '${type}'`), `warm-links.js must send ${type}`);
    assert.match(background, new RegExp(`case '${type}'`), `background.js must handle ${type}`);
  }
  assert.match(background, /type: 'pt_warm_spa'/, 'background must send the SPA request');
  assert.match(relay, /msg\.type !== 'pt_warm_spa'/, 'the relay must accept the SPA request');
  assert.match(relay, /type: 'pt_warm_spa_result'/, 'the relay must report the result');
  assert.match(background, /case 'pt_warm_spa_result'/, 'background must consume the result');
  assert.match(background, /type: 'pt_warmsame_ready'/, 'background must push same-terminal readiness');
  assert.match(warmLinks, /message\.type !== 'pt_warmsame_ready'/, 'warm-links must listen for it');
});

/* ---------------- background warm flows ---------------- */

function warmWorker(opts = {}) {
  const values = {
    pt_settings: {
      framesEnabled: false, recordingEnabled: false, autoReview: false,
      warmXLinksEnabled: opts.enabled !== false,
      ...(opts.settings || {}),
    },
    pt_state: { positions: {}, rounds: [], journal: [] },
  };
  const session = {};
  const tabsById = new Map();
  let nextTabId = 500;
  const fetchCalls = [];
  const calls = { created: [], updated: [], removed: [], sent: [], windows: [] };
  const listeners = {};
  const timers = [];
  let messageListener = null;

  const sandbox = {
    console: { debug: () => {}, warn: () => {}, error: () => {}, log: () => {} },
    Promise, JSON, Math, Date, Number, String, Array, Object, Boolean, RegExp,
    Error, Set, Map, URL, URLSearchParams, AbortController, Uint8Array,
    setTimeout: (fn, ms) => { timers.push({ fn, ms, cleared: false }); return timers.length; },
    clearTimeout: (id) => { const t = timers[id - 1]; if (t) t.cleared = true; },
    setInterval: () => 1,
    clearInterval: () => {},
    fetch: async (url, init) => {
      fetchCalls.push(String(url));
      if (opts.fetchImpl) return opts.fetchImpl(String(url), init);
      return { ok: true, status: 200, json: async () => ({}) };
    },
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
          // Route by the query's URL patterns, the way Chrome does: the warm
          // feature asks two different questions ("any trading tabs open?"
          // and "any x.com tabs to adopt?") and conflating them would let a
          // trading tab be adopted as an X viewer in these tests.
          const urls = Array.isArray(query && query.url) ? query.url : [];
          if (urls.some((u) => u.includes('x.com'))) {
            callback((opts.xTabs || []).filter((t) => tabsById.has(t.id)).map((t) => tabsById.get(t.id)));
            return;
          }
          callback(opts.platformTabs || []);
        },
        sendMessage: async (id, msg) => {
          calls.sent.push({ id, msg });
          if (opts.spaSendFails) throw new Error('Receiving end does not exist');
          return { forwarded: true };
        },
        captureVisibleTab: async () => 'data:image/jpeg;base64,',
        // Chrome fires EVERY registered listener; the background registers
        // more than one per event (viewer lifecycle + destination families),
        // so keeping only the last silently unhooks the earlier ones.
        onRemoved: { addListener: (fn) => { (listeners.onRemovedAll ||= []).push(fn); listeners.onRemoved = (...a) => listeners.onRemovedAll.forEach((f) => f(...a)); } },
        onUpdated: { addListener: (fn) => { (listeners.onUpdatedAll ||= []).push(fn); listeners.onUpdated = (...a) => listeners.onUpdatedAll.forEach((f) => f(...a)); } },
        onActivated: { addListener: (fn) => { (listeners.onActivatedAll ||= []).push(fn); listeners.onActivated = (...a) => listeners.onActivatedAll.forEach((f) => f(...a)); } },
      },
      windows: { update: async (id, props) => { calls.windows.push({ id, props }); } },
      offscreen: { hasDocument: async () => false, createDocument: async () => {} },
    },
  };
  // Pre-existing x.com tabs (adoption candidates) live in the same tab map
  // as everything else so tabs.update/get work on them after adoption.
  for (const t of opts.xTabs || []) {
    tabsById.set(t.id, {
      windowId: 1, index: 0, active: false, pinned: false, audible: false,
      discarded: false, status: 'complete', ...t,
    });
  }
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
    values, session, tabsById, calls, listeners, timers, fetchCalls,
    get listener() { return messageListener; },
    seedViewer(props = {}) {
      const tab = {
        id: nextTabId++, windowId: props.windowId ?? 1, index: 0, active: false,
        url: props.url || 'https://x.com/home', discarded: !!props.discarded, status: 'complete',
      };
      tabsById.set(tab.id, tab);
      session.pt_warm_tab = { tabId: tab.id, used: !!props.used, createdAt: 1 };
      return tab;
    },
    fireTimers(ms) {
      for (const t of timers) {
        if (!t.cleared && t.ms === ms) { t.cleared = true; t.fn(); }
      }
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

const POST = 'https://x.com/degentoken/status/999888777';

test('feature off: an X click opens a plain new tab and registers nothing', async () => {
  const worker = warmWorker({ enabled: false });
  const response = await send(worker.listener, { type: 'pt_warm_open', url: POST });
  assert.equal(response.route, 'new_tab');
  assert.equal(worker.calls.created.length, 1);
  assert.equal(worker.calls.created[0].url, POST);
  assert.equal(worker.session.pt_warm_tab, undefined, 'no viewer registration when the feature is off');
});

test('background refuses to warm-route anything that is not an X post/profile', async () => {
  // The content script is not trusted: URLs are re-classified at this boundary.
  const worker = warmWorker();
  const response = await send(worker.listener, { type: 'pt_warm_open', url: 'https://evil.example/x.com/status/1' });
  assert.equal(response.ok, false);
  assert.equal(worker.calls.created.length, 0, 'nothing may be opened for a non-X URL');
});

test('first click is cold but the new tab immediately becomes the viewer', async () => {
  const worker = warmWorker();
  const response = await send(worker.listener, { type: 'pt_warm_open', url: POST });
  assert.equal(response.route, 'cold_tab');
  const created = worker.calls.created[0];
  assert.equal(created.url, POST);
  assert.equal(created.active, true);
  assert.equal(worker.session.pt_warm_tab.tabId, created.id, 'the cold tab is now the viewer');
  assert.equal(worker.session.pt_warm_tab.used, true);
});

test('with a live viewer: SPA request goes out and the tab is revealed FIRST', async () => {
  const worker = warmWorker();
  const viewer = worker.seedViewer();
  const response = await send(worker.listener, { type: 'pt_warm_open', url: POST });

  assert.equal(response.route, 'spa');
  assert.equal(worker.calls.sent.length, 1);
  assert.equal(worker.calls.sent[0].id, viewer.id);
  assert.equal(worker.calls.sent[0].msg.type, 'pt_warm_spa');
  assert.equal(worker.calls.sent[0].msg.postId, '999888777');

  // Reveal: active + unmuted + window focused — BEFORE any verification result.
  const reveal = worker.calls.updated.find((u) => u.id === viewer.id && u.props.active === true);
  assert.ok(reveal, 'the viewer must be activated immediately');
  assert.equal(reveal.props.muted, false, 'a visible viewer must not stay muted');
  assert.ok(worker.calls.windows.some((w) => w.id === viewer.windowId && w.props.focused === true),
    'the viewer\'s WINDOW must be focused too — multi-monitor setups otherwise see nothing');
  assert.equal(worker.calls.created.length, 0, 'no new tab: the viewer is reused');
  assert.equal(worker.session.pt_warm_tab.tabId, viewer.id, 'the viewer stays registered for the NEXT click');
});

test('a failed SPA result repairs with a full load of the same URL', async () => {
  const worker = warmWorker();
  const viewer = worker.seedViewer();
  await send(worker.listener, { type: 'pt_warm_open', url: POST });
  const requestId = worker.calls.sent[0].msg.requestId;

  await send(worker.listener, { type: 'pt_warm_spa_result', requestId, ok: false, reason: 'verify_timeout' },
    { tab: { id: viewer.id } });
  await worker.settle();
  assert.ok(worker.calls.updated.some((u) => u.id === viewer.id && u.props.url === POST),
    'the repair must navigate the viewer to the exact clicked URL');
});

test('a successful SPA result leaves the viewer alone and disarms the timeout', async () => {
  const worker = warmWorker();
  const viewer = worker.seedViewer();
  await send(worker.listener, { type: 'pt_warm_open', url: POST });
  const requestId = worker.calls.sent[0].msg.requestId;
  const updatesBefore = worker.calls.updated.length;

  await send(worker.listener, { type: 'pt_warm_spa_result', requestId, ok: true }, { tab: { id: viewer.id } });
  worker.fireTimers(6000);
  await worker.settle();
  assert.equal(worker.calls.updated.length, updatesBefore, 'no repair after success, even when the timer fires');
});

test('silence repairs too: the timeout alone triggers the full load', async () => {
  const worker = warmWorker();
  const viewer = worker.seedViewer();
  await send(worker.listener, { type: 'pt_warm_open', url: POST });
  worker.fireTimers(6000);
  await worker.settle();
  assert.ok(worker.calls.updated.some((u) => u.id === viewer.id && u.props.url === POST),
    'no result within the window must fall back to a full load');
});

test('a result from a tab we never messaged is ignored', async () => {
  const worker = warmWorker();
  const viewer = worker.seedViewer();
  await send(worker.listener, { type: 'pt_warm_open', url: POST });
  const requestId = worker.calls.sent[0].msg.requestId;
  const updatesBefore = worker.calls.updated.length;

  await send(worker.listener, { type: 'pt_warm_spa_result', requestId, ok: false, reason: 'spoofed' },
    { tab: { id: 31337 } });
  await worker.settle();
  assert.equal(worker.calls.updated.length, updatesBefore,
    'only the messaged tab may influence the repair decision');
});

test('a second rapid click supersedes the first — no repair back to a stale target', async () => {
  const worker = warmWorker();
  const viewer = worker.seedViewer();
  const POST2 = 'https://x.com/other/status/111222333';

  await send(worker.listener, { type: 'pt_warm_open', url: POST });
  const firstRequest = worker.calls.sent[0].msg.requestId;
  await send(worker.listener, { type: 'pt_warm_open', url: POST2 });

  // The first request's late failure must NOT navigate the tab back to POST.
  await send(worker.listener, { type: 'pt_warm_spa_result', requestId: firstRequest, ok: false, reason: 'late' },
    { tab: { id: viewer.id } });
  worker.fireTimers(6000); // includes the first request's (cleared) timer
  await worker.settle();
  assert.ok(!worker.calls.updated.some((u) => u.props.url === POST),
    'the user clicked past POST; nothing may drag them back to it');
});

test('re-clicking a link the viewer already shows reveals it — no message, no reload', async () => {
  // Seen on video during first manual QA: click a token's X link, go back,
  // click it again — the viewer full-reloaded the same post because the SPA
  // relay was not answering yet. The already-open check must run in the
  // BACKGROUND, before any messaging, so this is instant regardless of the
  // viewer's load state.
  const worker = warmWorker();
  const viewer = worker.seedViewer({ url: POST });
  const response = await send(worker.listener, { type: 'pt_warm_open', url: POST });
  assert.equal(response.route, 'already_open');
  assert.equal(worker.calls.sent.length, 0, 'no SPA round-trip for a target already on screen');
  assert.ok(!worker.calls.updated.some((u) => u.props.url),
    'nothing may be re-navigated — that is the reload this guards against');
  assert.ok(worker.calls.updated.some((u) => u.id === viewer.id && u.props.active === true),
    'the viewer is simply revealed');

  // Same page under the legacy host or a trailing slash still counts.
  const workerB = warmWorker();
  workerB.seedViewer({ url: 'https://twitter.com/degentoken/status/999888777/' });
  const responseB = await send(workerB.listener, { type: 'pt_warm_open', url: POST });
  assert.equal(responseB.route, 'already_open');
});

test('a viewer with no live relay gets a full load in place, not a new tab', async () => {
  const worker = warmWorker({ spaSendFails: true });
  const viewer = worker.seedViewer();
  const response = await send(worker.listener, { type: 'pt_warm_open', url: POST });
  assert.equal(response.route, 'warm_reload');
  // Reveal and navigation are separate calls now (reveal runs concurrently
  // with the ack attempt); both must land on the same viewer tab.
  assert.ok(worker.calls.updated.some((u) => u.id === viewer.id && u.props.active === true),
    'the viewer is revealed');
  assert.ok(worker.calls.updated.some((u) => u.id === viewer.id && u.props.url === POST),
    'and driven to the target with a full load');
  assert.equal(worker.calls.created.length, 0);
});

test('a discarded viewer (Chrome memory pressure) full-loads instead of SPA', async () => {
  const worker = warmWorker();
  worker.seedViewer({ discarded: true });
  const response = await send(worker.listener, { type: 'pt_warm_open', url: POST });
  assert.equal(response.route, 'warm_reload');
  assert.equal(worker.calls.sent.length, 0, 'no SPA message to a tab with no live scripts');
});

test('prewarm is idempotent: many trading tabs, one hidden muted viewer', async () => {
  const worker = warmWorker();
  await send(worker.listener, { type: 'pt_warm_prewarm' });
  await send(worker.listener, { type: 'pt_warm_prewarm' });
  await worker.settle();
  assert.equal(worker.calls.created.length, 1, 'exactly one viewer regardless of how many tabs ask');
  const created = worker.calls.created[0];
  assert.equal(created.active, false, 'the pre-warmed viewer must stay hidden');
  assert.equal(created.autoDiscardable, false,
    'the hidden viewer must stay resident — a discarded viewer silently goes cold');
  assert.ok(worker.calls.updated.some((u) => u.id === created.id && u.props.muted === true),
    'the hidden viewer must be muted — a background feed must never make a sound');
});

test('closing the viewer clears the registration; the next click recovers cold', async () => {
  const worker = warmWorker();
  const viewer = worker.seedViewer();
  worker.tabsById.delete(viewer.id);
  worker.listeners.onRemoved(viewer.id);
  await worker.settle();
  assert.equal(worker.session.pt_warm_tab, undefined);

  const response = await send(worker.listener, { type: 'pt_warm_open', url: POST });
  assert.equal(response.route, 'cold_tab');
});

test('toggling off closes only a never-used hidden viewer', async () => {
  // Unused idle tab: ours, close it.
  const workerA = warmWorker({ enabled: false });
  const idle = workerA.seedViewer({ used: false });
  await send(workerA.listener, { type: 'pt_settings_changed' });
  await workerA.settle();
  assert.ok(workerA.calls.removed.includes(idle.id), 'the hidden idle tab is released on opt-out');

  // Used viewer: the user's tab now — must survive the toggle.
  const workerB = warmWorker({ enabled: false });
  const used = workerB.seedViewer({ used: true });
  await send(workerB.listener, { type: 'pt_settings_changed' });
  await workerB.settle();
  assert.ok(!workerB.calls.removed.includes(used.id), 'a tab the user has seen is never closed by us');
  assert.equal(workerB.session.pt_warm_tab, undefined, 'but the registration is dropped');
});

test('the viewer navigating off X releases it', async () => {
  const worker = warmWorker();
  const viewer = worker.seedViewer();
  worker.listeners.onUpdated(viewer.id, { status: 'loading', url: 'https://example.com/' }, viewer);
  await worker.settle();
  assert.equal(worker.session.pt_warm_tab, undefined, 'a tab steered off X is the user\'s, not our viewer');
});

test('the master switch does NOT outrank the warm-links toggle (speed survives paper-off)', async () => {
  // Maintainer (2026-08-05): appEnabled is the PAPER switch. With paper off
  // and warm links on: clicks still route warm, hovers still prefetch, and
  // the hidden viewer is NOT torn down by a settings echo.
  const worker = warmWorker({ settings: { appEnabled: false } });
  const idle = worker.seedViewer({ used: false });

  const response = await send(worker.listener, { type: 'pt_warm_open', url: POST });
  assert.notEqual(response.route, 'new_tab', 'paper off must not force cold native opens');

  await send(worker.listener, { type: 'pt_settings_changed' });
  await worker.settle();
  assert.ok(!worker.calls.removed.includes(idle.id),
    'paper off never releases the speed plane’s viewer');
});

/* ---------------- hover prefetch (background side) ---------------- */

test('a hint drives the HIDDEN viewer without revealing or claiming it', async () => {
  const worker = warmWorker();
  const viewer = worker.seedViewer();
  await send(worker.listener, { type: 'pt_warm_hint', url: POST });
  await worker.settle();

  assert.equal(worker.calls.sent.length, 1, 'the hint dispatches the SPA prefetch');
  assert.equal(worker.calls.sent[0].id, viewer.id);
  assert.ok(!worker.calls.updated.some((u) => u.props.active === true),
    'a hover must NEVER bring the viewer forward');
  assert.equal(worker.calls.windows.length, 0, 'nor focus any window');
  assert.equal(worker.session.pt_warm_tab.used, false,
    'a prefetched-but-unrevealed viewer is still ours to close on opt-out');
});

test('a hint never touches a viewer the user is looking at', async () => {
  const worker = warmWorker();
  const viewer = worker.seedViewer();
  viewer.active = true;
  await send(worker.listener, { type: 'pt_warm_hint', url: POST });
  await worker.settle();
  assert.equal(worker.calls.sent.length, 0,
    'redirecting a tab mid-read because a cursor crossed a link is hijacking');
});

test('a hint never creates tabs and a dead relay costs nothing', async () => {
  const workerA = warmWorker();
  await send(workerA.listener, { type: 'pt_warm_hint', url: POST });
  await workerA.settle();
  assert.equal(workerA.calls.created.length, 0, 'hover is not intent enough to open a tab');

  const workerB = warmWorker({ spaSendFails: true });
  workerB.seedViewer();
  await send(workerB.listener, { type: 'pt_warm_hint', url: POST });
  await workerB.settle(); // hint responds before its serialized body runs
  workerB.fireTimers(6000);
  await workerB.settle();
  assert.ok(!workerB.calls.updated.some((u) => u.props.url),
    'hover is not intent enough to spend a full reload on either');
});

test('a failed prefetch repairs while still hidden — the fallback IS a prefetch', async () => {
  const worker = warmWorker();
  const viewer = worker.seedViewer();
  await send(worker.listener, { type: 'pt_warm_hint', url: POST });
  await worker.settle(); // hint responds before its serialized body runs
  worker.fireTimers(6000); // SPA route never confirmed
  await worker.settle();
  assert.ok(worker.calls.updated.some((u) => u.id === viewer.id && u.props.url === POST),
    'the hidden viewer full-loads the target, so the click still lands warm');
  assert.ok(!worker.calls.updated.some((u) => u.props.active === true),
    'and stays hidden throughout');
});

/* ---------------- hover preview cards (oEmbed) ---------------- */

const OEMBED_HTML = '<blockquote class="twitter-tweet"><p lang="en" dir="ltr">gm &amp; &lt;3 devs<br>second line</p>&mdash; Degen (@degentoken) <a href="https://twitter.com/degentoken/status/999888777">August 5, 2026</a></blockquote>';

test('the worker fetches oEmbed with dnt, parses honestly, and caches hard', async () => {
  const worker = warmWorker({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ author_name: 'Degen', html: OEMBED_HTML }) }),
  });
  const first = await send(worker.listener, { type: 'pt_warm_oembed', url: POST });
  assert.equal(first.ok, true);
  assert.equal(first.gone, false);
  assert.equal(first.authorName, 'Degen');
  assert.equal(first.text, 'gm & <3 devs\nsecond line', 'entities decoded, <br> to newline, tags stripped');
  assert.equal(first.date, 'August 5, 2026');

  const oembedCalls = worker.fetchCalls.filter((u) => u.includes('publish.twitter.com/oembed'));
  assert.equal(oembedCalls.length, 1);
  assert.ok(oembedCalls[0].includes('dnt=1'), 'every request carries do-not-track');

  await send(worker.listener, { type: 'pt_warm_oembed', url: POST });
  assert.equal(worker.fetchCalls.filter((u) => u.includes('oembed')).length, 1,
    'second hover of the same post must be served from cache');
});

test('a deleted post reports gone — the rug signal arrives before the click', async () => {
  const worker = warmWorker({ fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }) });
  const result = await send(worker.listener, { type: 'pt_warm_oembed', url: POST });
  assert.equal(result.ok, true);
  assert.equal(result.gone, true);
  await send(worker.listener, { type: 'pt_warm_oembed', url: POST });
  assert.equal(worker.fetchCalls.filter((u) => u.includes('oembed')).length, 1,
    'gone is cached too — a deleted post stays deleted');
});

test('oEmbed is refused for non-posts and when the feature is off — zero traffic', async () => {
  const workerA = warmWorker();
  const community = await send(workerA.listener, { type: 'pt_warm_oembed', url: 'https://x.com/i/communities/123456' });
  assert.equal(community.ok, false);
  const workerB = warmWorker({ enabled: false });
  const off = await send(workerB.listener, { type: 'pt_warm_oembed', url: POST });
  assert.equal(off.ok, false);
  assert.equal(
    workerA.fetchCalls.concat(workerB.fetchCalls).filter((u) => u.includes('oembed')).length, 0,
    'no request may leave the machine for a refused card');
});

test('hover dwell requests a preview only under the card opt-in', () => {
  const off = loadWarmLinks(); // cards default OFF
  off.winListeners.mouseover.fn(clickEvent(POST));
  off.fireTimers();
  assert.equal(off.sent.filter((m) => m.type === 'pt_warm_oembed').length, 0,
    'no oEmbed traffic without the setting');
  assert.equal(off.sent.filter((m) => m.type === 'pt_warm_hint').length, 1,
    'prefetch is unaffected by the card setting');

  const on = loadWarmLinks({ settings: { warmHoverCardsEnabled: true } });
  on.winListeners.mouseover.fn(clickEvent(POST));
  on.fireTimers();
  assert.equal(on.sent.filter((m) => m.type === 'pt_warm_oembed').length, 1);
  assert.equal(on.sent.filter((m) => m.type === 'pt_warm_hint').length, 1);
});

test('row mode: a hover anywhere on the row previews its best X link', () => {
  // The user-reported pain: the X icon is 14px and the site cards demand you
  // hit it. Row mode resolves the hovered element's row (nearest ancestor
  // with 1-3 X links) and previews the best one — post over community over
  // profile — from a rest anywhere on the row. Off by default.
  const page = loadWarmLinks({ settings: { warmHoverRowEnabled: true } });
  const postAnchor = fakeAnchor(POST);
  const communityAnchor = fakeAnchor('https://x.com/i/communities/555');
  const row = {
    tagName: 'DIV',
    querySelectorAll: (sel) => (sel === 'a[href]' ? [communityAnchor, postAnchor] : []),
    parentElement: null,
    contains: () => true,
  };
  const cell = { tagName: 'TD', closest: () => null, querySelectorAll: () => [], parentElement: row, contains: () => false };
  page.winListeners.mouseover.fn({ target: cell, composedPath: () => [cell, row] });
  page.fireTimers();
  const hint = page.sent.find((m) => m.type === 'pt_warm_hint');
  assert.ok(hint, 'the row hover must prefetch');
  assert.equal(hint.url, POST, 'the post outranks the community as the preview target');
  assert.equal(page.sent.filter((m) => m.type === 'pt_warm_oembed').length, 1,
    'row mode implies the preview');

  // Default-off: the same hover does nothing.
  const off = loadWarmLinks();
  off.winListeners.mouseover.fn({ target: cell, composedPath: () => [cell, row] });
  off.fireTimers();
  assert.equal(off.sent.filter((m) => m.type !== 'pt_warm_prewarm').length, 0,
    'row hovering must be inert unless explicitly enabled');
});

/* ---------------- quick-buy hover (the held-hotkey stand-in) ---------------- */

const AXIOM_PILL = { left: 900, top: 300, right: 980, bottom: 328, width: 80, height: 28 };
const CARD_W = 452;
const CARD_H = 160;

function fakeBuyButton(text, opts = {}) {
  const btn = {
    tagName: 'BUTTON',
    textContent: text,
    isConnected: opts.isConnected !== false,
    querySelectorAll: () => [],
    parentElement: opts.parent || null,
    getAttribute: () => null,
    getBoundingClientRect: () => opts.rect || AXIOM_PILL,
    closest: (sel) => {
      if (sel === '#pt-rowbuy-layer') return opts.ptChip ? { id: 'pt-rowbuy-layer' } : null;
      if (sel === 'button,[role="button"]') return btn;
      return null;
    },
  };
  return btn;
}

function fakeTokenRow(anchors) {
  return {
    tagName: 'DIV',
    querySelectorAll: (sel) => (sel === 'a[href]' ? anchors : []),
    parentElement: null,
    contains: () => true,
  };
}

/** The card is the only thing warm-links appends to body. */
function cardOf(page) { return page.dom.body.children[0] || null; }
const tick = () => new Promise((resolve) => setImmediate(resolve));

function overlaps(card, pill) {
  const left = parseFloat(card.style.left);
  const top = parseFloat(card.style.top);
  return left < pill.right && left + CARD_W > pill.left
    && top < pill.bottom && top + CARD_H > pill.top;
}

test("quick-buy hover: the site's own pill previews the row's tweet, and the card never covers the pill", async () => {
  // The ask (2026-08-11): terminals hide the launch tweet behind a HELD
  // hotkey. Put it on the control the cursor is already on — the site's own
  // quick-buy pill — with no key held. The pill is identified from sites.js's
  // live-verified rowBuy.buyButtonPattern, never guessed.
  const page = loadWarmLinks({
    withSites: true, dom: true,
    settings: { warmHoverBuyEnabled: true },
    respond: (msg) => (msg.type === 'pt_warm_oembed'
      ? { ok: true, gone: false, url: POST, authorName: 'launcher', text: 'gm', date: 'Aug 11, 2026' }
      : {}),
  });
  const row = fakeTokenRow([fakeAnchor(POST)]);
  const pill = fakeBuyButton('0.5 SOL', { parent: row }); // Axiom's instant-buy pill

  page.winListeners.mouseover.fn({ target: pill, composedPath: () => [pill, row] });
  assert.equal(page.sent.filter((m) => m.type === 'pt_warm_oembed').length, 0,
    'nothing may fire before the dwell — a cursor crossing a column of pills must not spam');

  // The dwell VALUE is part of the contract, not just its existence: pills
  // sit in one vertical column, so a cursor travelling down a list crosses
  // every one of them. Zero delay makes the card strobe; row mode's 350ms
  // makes a stand-in for a held key feel broken.
  const scheduled = page.timers.filter((t) => !t.cleared);
  assert.equal(scheduled.length, 1, 'the pill hover schedules exactly one dwell');
  assert.ok(scheduled[0].ms > 0,
    'a zero-delay dwell is no dwell — it fires on entry and strobes down a column of pills');
  assert.ok(scheduled[0].ms < 350,
    'and it must beat row mode\'s 350ms — this trigger stands in for a key you HELD');
  page.fireTimers();

  const asked = page.sent.filter((m) => m.type === 'pt_warm_oembed');
  assert.equal(asked.length, 1, 'resting on the pill asks for that row\'s post');
  assert.equal(asked[0].url, POST);
  assert.equal(page.sent.filter((m) => m.type === 'pt_warm_hint').length, 1,
    'and prefetches it, exactly as the icon hover does');
  await tick();

  const card = cardOf(page);
  assert.ok(card, 'the card must actually mount');
  assert.equal(card.style.display, 'block');
  assert.equal(card.getAttribute('data-url'), POST);

  // THE safety rule. The card is itself a click target that opens X, and this
  // trigger fires while the cursor sits on a button that spends real money —
  // a card over that button eats the click the trader aimed at it.
  assert.equal(overlaps(card, AXIOM_PILL), false,
    'the card may never overlap the real-money button that summoned it');
  // Anchored ON the pill, not on the row's 14px X icon (which fakeAnchor puts
  // at x=10 — far from the cursor). Exact, because "somewhere to the left"
  // is also satisfied by a card parked at the other end of the row.
  assert.equal(parseFloat(card.style.left), AXIOM_PILL.left - 10 - CARD_W,
    'the card hangs off the pill\'s left edge with a 10px gap');
  assert.equal(parseFloat(card.style.top), AXIOM_PILL.top + AXIOM_PILL.height / 2 - CARD_H / 2,
    'and is centered on the pill vertically');
});

test('a cramped viewport still never puts the card over the pill', () => {
  // The interesting failure mode is not the roomy case. On a narrow window
  // neither side fits, and a naive clamp-into-view lands the card straight on
  // top of the button — the one outcome placeCard exists to prevent.
  const narrow = { left: 200, top: 300, right: 280, bottom: 328, width: 80, height: 28 };
  const page = loadWarmLinks({
    withSites: true, dom: true, view: { width: 500, height: 900 },
    settings: { warmHoverBuyEnabled: true },
    respond: (msg) => (msg.type === 'pt_warm_oembed'
      ? { ok: true, gone: false, url: POST, authorName: 'launcher', text: 'gm' } : {}),
  });
  const row = fakeTokenRow([fakeAnchor(POST)]);
  const pill = fakeBuyButton('0.5 SOL', { parent: row, rect: narrow });
  page.winListeners.mouseover.fn({ target: pill, composedPath: () => [pill, row] });
  page.fireTimers();
  return tick().then(() => {
    const card = cardOf(page);
    assert.ok(card, 'the card still shows — cramped is not a reason to withhold it');
    assert.equal(overlaps(card, narrow), false,
      'no viewport is small enough to justify covering the buy button');
  });
});

test('quick-buy hover is opt-in, needs Instant X links, and stays inert where no pill is verified', () => {
  const row = fakeTokenRow([fakeAnchor(POST)]);
  const pill = fakeBuyButton('0.5 SOL', { parent: row });
  const hover = (page) => {
    page.winListeners.mouseover.fn({ target: pill, composedPath: () => [pill, row] });
    page.fireTimers();
    return page.sent.filter((m) => m.type === 'pt_warm_oembed').length;
  };

  assert.equal(hover(loadWarmLinks({ withSites: true })), 0,
    'default off: the pill is an ordinary button until the setting says otherwise');

  // Setting on, Instant X links off (destination warming carries the handler).
  assert.equal(hover(loadWarmLinks({
    withSites: true, enabled: false,
    settings: { warmHoverBuyEnabled: true, warmEverywhereEnabled: true },
  })), 0, 'the preview is X machinery — without Instant X links there is nothing to preview with');

  // GMGN declares a rowBuy block but NO buyButtonPattern. Deciding for
  // ourselves which of its buttons spends money is exactly the invention this
  // feature refuses: no verified pattern, no feature, no guess.
  assert.equal(hover(loadWarmLinks({
    withSites: true, href: 'https://gmgn.ai/trenches',
    settings: { warmHoverBuyEnabled: true },
  })), 0, 'a site with no declared pill stays inert');
});

test("the trigger is the TERMINAL's pill — not PaperTrench's own chip, and not prose that merely says SOL", () => {
  const row = fakeTokenRow([fakeAnchor(POST)]);
  const page = () => loadWarmLinks({ withSites: true, settings: { warmHoverBuyEnabled: true } });
  const hover = (btn) => {
    const p = page();
    p.winListeners.mouseover.fn({ target: btn, composedPath: () => [btn, row] });
    p.fireTimers();
    return p.sent.filter((m) => m.type === 'pt_warm_oembed').length;
  };

  // Our paper-buy chip carries pill-shaped text and sits in a row. It is
  // excluded structurally (#pt-rowbuy-layer), not by hoping its label differs
  // — the request was explicitly about the terminal's button, not ours.
  assert.equal(hover(fakeBuyButton('0.5 SOL', { parent: row, ptChip: true })), 0,
    "PaperTrench's own chip must never be the trigger");

  // Padre's pattern is a bare \bSOL\b: without a length ceiling every card,
  // banner and panel containing the word becomes a buy button.
  assert.equal(hover(fakeBuyButton('Buy 0.5 SOL of this token right now on Axiom', { parent: row })), 0,
    'prose-length labels are panels and cards, never a pill');

  assert.equal(hover(fakeBuyButton('Filters', { parent: row })), 0,
    'a button that does not match the site pattern is just a button');

  // A pill whose row got recycled out from under the dwell must not preview a
  // token that is no longer there.
  assert.equal(hover(fakeBuyButton('0.5 SOL', { parent: row, isConnected: false })), 0,
    'a detached pill previews nothing');
});

test('the icon-hover card still lands below its anchor — the pill rule is additive, not a rewrite', async () => {
  const page = loadWarmLinks({
    dom: true,
    settings: { warmHoverCardsEnabled: true },
    respond: (msg) => (msg.type === 'pt_warm_oembed'
      ? { ok: true, gone: false, url: POST, authorName: 'launcher', text: 'gm' }
      : {}),
  });
  page.winListeners.mouseover.fn(clickEvent(POST));
  page.fireTimers();
  await tick();
  const card = cardOf(page);
  // fakeAnchor's rect is left 10 / bottom 24; the historical placement is
  // flush-left under the anchor with an 8px gap.
  assert.equal(parseFloat(card.style.left), 10);
  assert.equal(parseFloat(card.style.top), 32);
});

test('the dashboard exposes and persists all four Instant X links settings', () => {
  const dash = fs.readFileSync(path.join(ROOT, 'dashboard.js'), 'utf8');
  for (const id of ['set-warm-x', 'set-warm-cards', 'set-warm-row', 'set-warm-buy', 'set-warm-sameterminal']) {
    assert.match(dash, new RegExp(`id="${id}"`), `${id} must be in the settings form`);
  }
  for (const key of ['warmXLinksEnabled', 'warmHoverCardsEnabled', 'warmHoverRowEnabled', 'warmHoverBuyEnabled', 'warmSameSiteEnabled']) {
    assert.match(dash, new RegExp(`${key}: document\\.getElementById`), `${key} must be persisted on save`);
  }
});

/* ---------------- trading-site click interception ---------------- */

/* A DOM small enough to be honest and real enough to run the card path.
 * The preview card is built with createElement + attachShadow and positioned
 * from getBoundingClientRect, so a fake that only records listeners can never
 * test WHERE the card lands — and "where" is a safety rule once the trigger
 * is a real-money buy button. */
function fakeDom() {
  const make = (tag) => {
    const el = {
      tagName: String(tag).toUpperCase(),
      children: [], style: {}, className: '', textContent: '', attrs: {},
      isConnected: false, firstChild: null, shadow: null,
      rect: { left: 0, top: 0, right: 452, bottom: 160, width: 452, height: 160 },
      attachShadow: () => ({ append: (...nodes) => { el.shadow = nodes; } }),
      addEventListener: () => {},
      appendChild: (child) => {
        el.children.push(child); child.isConnected = true;
        el.firstChild = el.children[0]; return child;
      },
      removeChild: (child) => {
        el.children = el.children.filter((c) => c !== child);
        el.firstChild = el.children[0] || null; return child;
      },
      setAttribute: (k, v) => { el.attrs[k] = v; },
      getAttribute: (k) => (k in el.attrs ? el.attrs[k] : null),
      getBoundingClientRect: () => el.rect,
    };
    return el;
  };
  const body = make('body');
  body.isConnected = true;
  return { body, createElement: make, addEventListener: () => {} };
}

function loadWarmLinks(opts = {}) {
  const posted = [];
  const sent = [];
  const timers = [];
  const domListeners = {};
  const winListeners = {};
  const href = opts.href || 'https://axiom.trade/meme/PAIR';
  const hostname = new URL(href).hostname;
  const location = { href, origin: new URL(href).origin, hostname, pathname: new URL(href).pathname, search: '' };
  const view = opts.view || { width: 1440, height: 900 };
  const win = {
    addEventListener: (type, fn, capture) => { winListeners[type] = { fn, capture: capture === true }; },
    postMessage: (data) => posted.push(data),
    location,
    innerWidth: view.width,
    innerHeight: view.height,
  };
  win.window = win;
  win.self = win;
  const dom = opts.dom
    ? fakeDom()
    : { addEventListener: (type, fn, capture) => { domListeners[type] = { fn, capture }; } };
  const sandbox = {
    window: win, self: win, location,
    document: dom,
    chrome: {
      runtime: {
        id: 'papertrench-test',
        sendMessage: (msg) => { sent.push(msg); return Promise.resolve(opts.respond ? opts.respond(msg) : {}); },
        lastError: undefined,
      },
      storage: {
        local: { get: (keys, cb) => cb({ pt_settings: { warmXLinksEnabled: opts.enabled !== false, ...(opts.settings || {}) } }) },
        onChanged: { addListener: () => {} },
      },
    },
    setTimeout: (fn, ms) => { timers.push({ fn, ms, cleared: false }); return timers.length; },
    clearTimeout: (id) => { const t = timers[id - 1]; if (t) t.cleared = true; },
    Date,
    URL, console, Promise, JSON, Object, String, Boolean,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'xlinks.js'), 'utf8'), sandbox, { filename: 'xlinks.js' });
  // The REAL adapters, on purpose: the quick-buy trigger reads which button is
  // a buy button out of sites.js, so a stub here would test the stub. Loading
  // the shipped file means dropping Axiom's rowBuy spec breaks this suite.
  if (opts.withSites) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'sites.js'), 'utf8'), sandbox, { filename: 'sites.js' });
  }
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'warm-links.js'), 'utf8'), sandbox, { filename: 'warm-links.js' });
  const fireTimers = () => { for (const t of timers) if (!t.cleared) { t.cleared = true; t.fn(); } };
  return { posted, sent, timers, fireTimers, domListeners, winListeners, win, dom };
}

function fakeAnchor(href) {
  return {
    tagName: 'A', href,
    getAttribute: (name) => (name === 'href' ? href : null),
    getBoundingClientRect: () => ({ left: 10, top: 10, right: 24, bottom: 24, width: 14, height: 14 }),
  };
}

function clickEvent(href, mods = {}) {
  const event = {
    button: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
    defaultPrevented: false,
    target: { closest: (sel) => (sel === 'a[href]' ? fakeAnchor(href) : null) },
    prevented: false, stopped: false,
    preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; },
    ...mods,
  };
  return event;
}

test('a plain click on an X post link is claimed and routed', () => {
  const page = loadWarmLinks();
  const click = page.winListeners.click;
  assert.ok(click, 'the click listener must sit on WINDOW — the first capture node, ahead of any site handler');
  assert.equal(click.capture, true,
    'must be capture phase: it runs before site handlers (no double open) and catches target=_blank anchors');

  const event = clickEvent(POST);
  click.fn(event);
  assert.equal(event.prevented, true);
  assert.equal(event.stopped, true);
  assert.equal(page.sent.filter((m) => m.type === 'pt_warm_open').length, 1);
  assert.equal(page.sent.find((m) => m.type === 'pt_warm_open').url, POST);
});

test('the anchor is found through composedPath when shadow DOM hides it from closest', () => {
  // Shadow retargeting points event.target at the shadow HOST for listeners
  // out on window, so target.closest never sees the anchor — the exact way a
  // web-component-rendered row would silently defeat interception.
  const page = loadWarmLinks();
  const event = clickEvent(POST, {
    target: { closest: () => null },
    composedPath: () => [{ tagName: 'svg' }, fakeAnchor(POST), { tagName: 'DIV' }],
  });
  page.winListeners.click.fn(event);
  assert.equal(event.prevented, true, 'the composedPath anchor must be honored');
  assert.equal(page.sent.filter((m) => m.type === 'pt_warm_open').length, 1);
});

test('GMGN community links and Axiom-style CA searches warm-route too', () => {
  // The first field report ("works on Padre, not GMGN/Axiom") came down to
  // link forms: GMGN trench rows link x.com/i/communities/<id>, and Axiom's
  // X affordance is a search for the CA. Both used to fall through natively.
  const page = loadWarmLinks();
  const community = clickEvent('https://x.com/i/communities/2012484577227419741');
  page.winListeners.click.fn(community);
  assert.equal(community.prevented, true, 'community links must be claimed');

  const search = clickEvent('https://x.com/search?q=So11111111111111111111111111111111111111112');
  page.winListeners.click.fn(search);
  assert.equal(search.prevented, true, 'CA searches must be claimed');

  const sent = page.sent.filter((m) => m.type === 'pt_warm_open').map((m) => m.url);
  assert.deepEqual(sent, [
    'https://x.com/i/communities/2012484577227419741',
    'https://x.com/search?q=So11111111111111111111111111111111111111112',
  ]);
});

test('modified clicks and non-X links pass through untouched', () => {
  const page = loadWarmLinks();
  const click = page.winListeners.click.fn;

  for (const event of [
    clickEvent(POST, { ctrlKey: true }),
    clickEvent(POST, { metaKey: true }),
    clickEvent(POST, { shiftKey: true }),
    clickEvent(POST, { button: 1 }),
    clickEvent('https://gmgn.ai/sol/token/abc'),
    clickEvent('https://x.com/intent/tweet?text=gm'),
  ]) {
    click(event);
    assert.equal(event.prevented, false, 'native behavior must win');
  }
  assert.equal(page.sent.filter((m) => m.type === 'pt_warm_open').length, 0);
});

test('hovering an X link for the dwell sends a prefetch hint; a graze does not', () => {
  const page = loadWarmLinks();
  const hover = page.winListeners.mouseover;
  assert.ok(hover && hover.capture, 'the hover listener must exist at capture phase');

  hover.fn(clickEvent(POST)); // same event shape works: target.closest is all it reads
  assert.equal(page.sent.filter((m) => m.type === 'pt_warm_hint').length, 0,
    'nothing may be sent before the dwell elapses — a cursor grazing links must not spam hints');
  page.fireTimers();
  const hints = page.sent.filter((m) => m.type === 'pt_warm_hint');
  assert.equal(hints.length, 1);
  assert.equal(hints[0].url, POST);

  // Hovering the same link again within the repeat window stays silent.
  hover.fn(clickEvent(POST));
  page.fireTimers();
  assert.equal(page.sent.filter((m) => m.type === 'pt_warm_hint').length, 1);

  // Non-X links never hint.
  hover.fn(clickEvent('https://gmgn.ai/sol/token/abc'));
  page.fireTimers();
  assert.equal(page.sent.filter((m) => m.type === 'pt_warm_hint').length, 1);
});

test('with the feature disabled the click listener touches nothing', () => {
  const page = loadWarmLinks({ enabled: false });
  const event = clickEvent(POST);
  page.winListeners.click.fn(event);
  assert.equal(event.prevented, false);
  assert.equal(page.sent.filter((m) => m.type === 'pt_warm_open').length, 0);
});

test('the MAIN-world hook forwards only after the ISOLATED world says enabled', () => {
  const posted = [];
  const winListeners = [];
  const nativeCalls = [];
  const win = {
    addEventListener: (type, fn) => { if (type === 'message') winListeners.push(fn); },
    postMessage: (data) => posted.push(data),
    open: (...args) => { nativeCalls.push(args); return { native: true }; },
    location: { href: 'https://axiom.trade/meme/PAIR', origin: 'https://axiom.trade' },
  };
  win.window = win;
  win.self = win;
  const sandbox = { window: win, self: win, URL, console, String, Object, Boolean, JSON };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'xlinks.js'), 'utf8'), sandbox, { filename: 'xlinks.js' });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'warm-open-hook.js'), 'utf8'), sandbox, { filename: 'warm-open-hook.js' });

  // Before any state message: fail-safe native passthrough.
  win.open(POST);
  assert.equal(nativeCalls.length, 1, 'unknown state must behave natively');

  for (const fn of winListeners) fn({ source: win, data: { source: 'papertrench-warmstate', enabled: true } });

  const fake = win.open(POST, '_blank');
  assert.equal(nativeCalls.length, 1, 'an X post open is intercepted once enabled');
  assert.equal(fake.closed, false, 'callers get a workable stand-in window');
  const forwarded = posted.find((m) => m && m.source === 'papertrench-warmhook');
  assert.equal(forwarded.url, POST);

  win.open('https://google.com');
  assert.equal(nativeCalls.length, 2, 'non-X opens stay native even when enabled');
});

/* ---------------- x.com SPA driver ---------------- */

function loadSpaDriver(opts = {}) {
  const posted = [];
  const pushes = [];
  const dispatched = [];
  const intervals = [];
  let now = 1000;
  const winListeners = [];
  const win = {
    addEventListener: (type, fn) => { if (type === 'message') winListeners.push(fn); },
    postMessage: (data) => posted.push(data),
    dispatchEvent: (ev) => dispatched.push(ev),
    history: { pushState: (state, title, url) => pushes.push(url) },
    location: {
      origin: 'https://x.com', pathname: opts.pathname || '/home', search: '',
    },
  };
  win.window = win;
  win.self = win;
  const doc = {
    title: opts.title || 'Home / X',
    body: {},
    querySelector: (sel) => (opts.matches && opts.matches(sel)) || null,
  };
  const sandbox = {
    window: win, self: win, document: doc,
    MutationObserver: function (fn) { this.observe = () => {}; this.disconnect = () => {}; this.fn = fn; },
    PopStateEvent: function (type, init) { this.type = type; this.state = init && init.state; },
    performance: { now: () => (now += 300) },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    clearInterval: () => {},
    URL, console, String, Object, Boolean, JSON,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'xwarm-main.js'), 'utf8'), sandbox, { filename: 'xwarm-main.js' });
  return {
    posted, pushes, dispatched, intervals, doc, win,
    request(msg) { for (const fn of winListeners) fn({ source: win, data: msg }); },
    tick() { for (const i of intervals) i.fn(); },
  };
}

const SPA_REQUEST = {
  source: 'papertrench-xwarm-request', requestId: 'req-1',
  url: POST, kind: 'post', handle: 'degentoken', postId: '999888777',
};

test('the driver pushes state, wakes the router, and confirms on the post anchor', () => {
  let arrived = false;
  const page = loadSpaDriver({
    matches: (sel) => (arrived && sel.includes('/status/999888777') ? {} : null),
  });
  page.request(SPA_REQUEST);

  assert.deepEqual(page.pushes, ['/degentoken/status/999888777']);
  assert.ok(page.dispatched.some((ev) => ev.type === 'popstate'),
    'X\'s router listens on popstate; without the dispatch nothing navigates');
  assert.equal(page.posted.length, 0, 'no verdict before the content actually lands');

  arrived = true;
  page.tick();
  const result = page.posted.find((m) => m.source === 'papertrench-xwarm-result');
  assert.equal(result.ok, true);
  assert.equal(result.requestId, 'req-1');
});

test('a notification-count title change is NOT proof of navigation', () => {
  const page = loadSpaDriver({ title: 'Home / X' });
  page.request(SPA_REQUEST);
  // "(2) Home / X" is the same page with unread notifications — the defect
  // this guards against is declaring success while stranding the user on
  // their feed, which suppresses the repair that would have saved them.
  page.doc.title = '(2) Home / X';
  page.tick();
  assert.equal(page.posted.length, 0, 'count-prefix churn must not read as arrival');

  page.doc.title = 'degen (@degentoken) on X';
  page.tick();
  const result = page.posted.find((m) => m.source === 'papertrench-xwarm-result');
  assert.equal(result.ok, true, 'a genuine title change is the arrival fallback');
});

test('a community request drives the router and confirms on title movement', () => {
  // Communities have no per-target DOM signal we can rely on; the title
  // moving off the previous page is the arrival check. The relay and driver
  // must pass the kind through instead of collapsing it to "post".
  const page = loadSpaDriver({ title: 'Home / X' });
  page.request({
    source: 'papertrench-xwarm-request', requestId: 'req-c1',
    url: 'https://x.com/i/communities/2012484577227419741', kind: 'community',
    handle: null, postId: null,
  });
  assert.deepEqual(page.pushes, ['/i/communities/2012484577227419741']);
  page.doc.title = 'Lunar Rodeo / X';
  page.tick();
  const result = page.posted.find((m) => m.source === 'papertrench-xwarm-result');
  assert.equal(result.ok, true);
});

test('already on the target: instant success, no navigation', () => {
  const page = loadSpaDriver({ pathname: '/degentoken/status/999888777' });
  page.request(SPA_REQUEST);
  assert.equal(page.pushes.length, 0);
  const result = page.posted.find((m) => m.source === 'papertrench-xwarm-result');
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'already_here');
});

test('a deleted tweet shows X\'s error page instantly — never a repair reload', () => {
  // Field report: deleted launch tweets felt buggy and SLOW. The old code
  // treated the freshly rendered "this post doesn't exist" as a FAILED
  // navigation and repaired with a full reload of the same dead URL — which
  // costs seconds to display the identical error. The error page IS the
  // answer (a deleted launch tweet is trading signal); confirm and stop.
  let errored = false;
  const page = loadSpaDriver({
    matches: (sel) => (errored && sel.includes('error-detail') ? {} : null),
  });
  page.request(SPA_REQUEST);
  errored = true;
  page.tick();
  const result = page.posted.find((m) => m.source === 'papertrench-xwarm-result');
  assert.equal(result.ok, true, 'ok:true means the background arms NO repair — no reload');
  assert.equal(result.reason, 'x_error_page');
});

test('an error already on screen BEFORE the navigation proves nothing', () => {
  // If "error present" counted as arrival unconditionally, a viewer parked
  // on a dead post would instantly "confirm" every later navigation while
  // actually stuck. A pre-existing error must fall through to the timeout,
  // whose repair full-loads the real target.
  const page = loadSpaDriver({
    matches: (sel) => (sel.includes('error-detail') ? {} : null), // error from the start
  });
  page.request(SPA_REQUEST);
  for (let i = 0; i < 25 && !page.posted.length; i++) page.tick();
  const result = page.posted.find((m) => m.source === 'papertrench-xwarm-result');
  assert.equal(result.ok, false, 'a stale error page must not be mistaken for arrival');
  assert.equal(result.reason, 'verify_timeout');
});

test('classification never rewrites the link: path and query survive byte-for-byte', () => {
  // The other half of the deleted-tweet report: make sure WE cannot be the
  // reason a tweet looks dead. The only transform classify may perform is
  // host canonicalization onto x.com — path and query pass through intact.
  const X = loadXLinks();
  for (const [href, expected] of [
    ['https://x.com/CNBC/status/2085027940358627775?s=20&t=Ab_9x', 'https://x.com/CNBC/status/2085027940358627775?s=20&t=Ab_9x'],
    ['https://twitter.com/user_name/status/123/photo/1', 'https://x.com/user_name/status/123/photo/1'],
    ['https://x.com/i/web/status/999', 'https://x.com/i/web/status/999'],
    ['https://x.com/search?q=%24BONK%20ca&src=typed_query&f=live', 'https://x.com/search?q=%24BONK%20ca&src=typed_query&f=live'],
    ['https://mobile.twitter.com/i/communities/2012484577227419741?src=row', 'https://x.com/i/communities/2012484577227419741?src=row'],
  ]) {
    const got = X.classify(href);
    assert.ok(got, `${href} must classify`);
    assert.equal(got.url, expected, `${href} must not be rewritten beyond host canonicalization`);
  }
});

/* ------------- accidental close: the hot tab comes back (lev) ------------- */

test('closing the viewer respawns a fresh hidden one while a trading tab is open', async () => {
  // "i accidentally closed the x tab and i have to turn instant mode on off
  // to make it work again or to get the hot tab open" — the toggle is the
  // way to NOT have a viewer; an accidental close must heal itself.
  const worker = warmWorker({ platformTabs: [{ id: 9 }] });
  const viewer = worker.seedViewer();
  worker.tabsById.delete(viewer.id);
  worker.listeners.onRemoved(viewer.id, { isWindowClosing: false });
  await worker.settle();

  assert.equal(worker.calls.created.length, 1, 'a replacement viewer must be created');
  const created = worker.calls.created[0];
  assert.equal(created.url, 'https://x.com/home');
  assert.equal(created.active, false, 'the replacement stays hidden — no focus theft on a close');
  assert.ok(worker.calls.updated.some((u) => u.id === created.id && u.props.muted === true),
    'the replacement is muted like every hidden viewer');
  assert.equal(worker.session.pt_warm_tab.tabId, created.id, 'and it is registered');
  assert.equal(worker.session.pt_warm_tab.used, false);
});

test('a closing window never triggers a respawn', async () => {
  const worker = warmWorker({ platformTabs: [{ id: 9 }] });
  const viewer = worker.seedViewer();
  worker.tabsById.delete(viewer.id);
  worker.listeners.onRemoved(viewer.id, { isWindowClosing: true });
  await worker.settle();
  assert.equal(worker.calls.created.length, 0, 'spawning tabs into a browser shutdown is hostile');
  assert.equal(worker.session.pt_warm_tab, undefined, 'the registration is still cleared');
});

test('no trading tab open: a closed viewer stays closed', async () => {
  const worker = warmWorker(); // platformTabs defaults to none
  const viewer = worker.seedViewer();
  worker.tabsById.delete(viewer.id);
  worker.listeners.onRemoved(viewer.id, { isWindowClosing: false });
  await worker.settle();
  assert.equal(worker.calls.created.length, 0, 'a viewer with nobody to serve is not respawned');
});

test('feature off: a closed viewer is never respawned', async () => {
  const worker = warmWorker({ enabled: false, platformTabs: [{ id: 9 }] });
  const viewer = worker.seedViewer();
  worker.tabsById.delete(viewer.id);
  worker.listeners.onRemoved(viewer.id, { isWindowClosing: false });
  await worker.settle();
  assert.equal(worker.calls.created.length, 0);
});

/* ------------- adoption: the user's own X tab IS the viewer (lev) ---------- */

test('a click with no registered viewer adopts the existing X tab instead of opening a separate one', async () => {
  // Field failure: a community link opened in a fresh tab NEXT TO the x.com
  // tab the user already kept ("it opens them separately").
  const worker = warmWorker({ xTabs: [{ id: 71, url: 'https://x.com/home' }] });
  const response = await send(worker.listener, {
    type: 'pt_warm_open', url: 'https://x.com/i/communities/2028091248674840898',
  });

  assert.equal(response.ok, true);
  assert.equal(worker.calls.created.length, 0, 'no separate tab — the existing X tab is the viewer');
  assert.equal(worker.session.pt_warm_tab.tabId, 71, 'the existing tab is now registered');
  assert.equal(worker.session.pt_warm_tab.used, true, 'adopted tabs are the user\'s: toggle-off never closes them');
  assert.ok(worker.calls.sent.some((s) => s.id === 71 && s.msg.type === 'pt_warm_spa'
    && s.msg.url === 'https://x.com/i/communities/2028091248674840898'),
    'the community target rides the SPA route into the adopted tab');
  assert.ok(worker.calls.updated.some((u) => u.id === 71 && u.props.active === true),
    'the adopted tab is revealed');
});

test('adoption never claims a tab the user is looking at, nor a pinned or audible one', async () => {
  const worker = warmWorker({
    xTabs: [
      { id: 72, url: 'https://x.com/somebody/status/1', active: true },
      { id: 73, url: 'https://x.com/home', pinned: true },
      { id: 74, url: 'https://x.com/i/spaces/xyz', audible: true },
    ],
  });
  const response = await send(worker.listener, { type: 'pt_warm_open', url: POST });
  assert.equal(response.route, 'cold_tab', 'tabs in use are left alone — a fresh viewer is created');
  assert.equal(worker.calls.created.length, 1);
  assert.equal(worker.session.pt_warm_tab.tabId, worker.calls.created[0].id);
});

test('destination viewers are click-created ONLY — no code path opens a tab the user did not click for', () => {
  // Two independent field reports of the same confusion (Eyes343: "open
  // every time you open/refresh the DEX"; TRNC: "when i load up it randomly
  // opens solscan and pump.fun website") — the pre-created viewers read as
  // a malfunction, and the session-scoped closed-marker patch evaporated
  // with every browser restart. Doctrine now: viewer creation lives in the
  // click path alone, for every family.
  const src = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  const families = src.slice(src.indexOf('const WARM_DEST_FAMILIES'), src.indexOf('function warmDestFamilyFor') === -1 ? src.indexOf('const WD =') + 4000 : src.indexOf('function warmDestFamilyFor'));
  assert.doesNotMatch(families, /idleUrl: 'http/,
    'no destination family may carry a pre-creation URL');
  assert.doesNotMatch(src, /function warmDestPrewarm/,
    'the prewarm creator must stay deleted — creation is click-only');
});

test('prewarm adopts an existing X tab rather than spawning a second one', async () => {
  const worker = warmWorker({ xTabs: [{ id: 75, url: 'https://x.com/home' }] });
  await send(worker.listener, { type: 'pt_warm_prewarm' });
  await worker.settle();
  assert.equal(worker.calls.created.length, 0, 'one X surface, not two');
  assert.equal(worker.session.pt_warm_tab.tabId, 75);
  assert.equal(worker.session.pt_warm_tab.used, true);
});

test('adoption prefers a tab parked on /home over one parked on a thread', async () => {
  const worker = warmWorker({
    xTabs: [
      { id: 76, url: 'https://x.com/somebody/status/42', lastAccessed: 2000 },
      { id: 77, url: 'https://x.com/home', lastAccessed: 1000 },
    ],
  });
  await send(worker.listener, { type: 'pt_warm_prewarm' });
  await worker.settle();
  assert.equal(worker.session.pt_warm_tab.tabId, 77,
    'a /home tab has nothing to lose to a navigation; a parked thread might be someone\'s reading');
});

test('the Turbo III socket pre-warm injects hints, never claims, and cleans up', () => {
  const warmLinks = fs.readFileSync(path.join(ROOT, 'warm-links.js'), 'utf8');
  assert.match(warmLinks, /preconnectTargets/,
    'the spread reuses the shared family table, never a private host list');
  assert.match(warmLinks, /setAttribute\('rel', 'preconnect'\)/,
    'destinations are warmed with preconnect hints');
  assert.match(warmLinks, /setAttribute\('rel', 'dns-prefetch'\)/,
    '...plus a dns-prefetch fallback where preconnect is ignored');
  assert.match(warmLinks, /syncPreconnects\(\)/,
    'the hints follow the toggles');
  assert.match(warmLinks, /pressPreconnect\(href\)/,
    'an unclassified cross-origin press warms its own origin');
  assert.match(warmLinks, /PRESS_PRECONNECT_MAX/,
    'the press catch-all is bounded');
  // Toggle-off means nothing injected: the marked tags come back out.
  assert.match(warmLinks, /querySelectorAll\('link\[' \+ PRECONNECT_MARK/,
    'disabling both toggles removes the injected hints');
  assert.match(warmLinks, /pressPreconnected\.clear\(\)/,
    '...and resets the press budget with them');
});

test('warmdest loads before the interceptor that preconnects from its table', () => {
  const isolatedEntry = manifest.content_scripts.find((cs) => cs.js.includes('content.js'));
  assert.ok(isolatedEntry.js.indexOf('warmdest.js') < isolatedEntry.js.indexOf('warm-links.js'),
    'preconnectTargets must be loaded before the interceptor uses it');
});

test('same-site dwell prefetch is a hint: scoped, single-slot, and cleanable', () => {
  const warmLinks = fs.readFileSync(path.join(ROOT, 'warm-links.js'), 'utf8');
  assert.match(warmLinks, /sameSitePrefetchable/,
    'selection reuses the shared classifier, never a private URL list');
  assert.match(warmLinks, /SAME_SITE_PREFETCH_FAMILIES/,
    'rollout stays scoped to the goal terminals');
  assert.match(warmLinks, /speculationrules/,
    'delivery is a speculation-rules prefetch, not a hidden tab');
  assert.match(warmLinks, /eagerness: 'immediate'/,
    'the rule fires on insert — the dwell already did the waiting');
  assert.match(warmLinks, /el\.textContent = JSON\.stringify/,
    'page-controlled hrefs go in as text, never HTML');
  assert.match(warmLinks, /prefetchRuleEl\.remove\(\)/,
    'one rule slot, latest wins');
  assert.match(warmLinks, /dropPrefetchRule\(\)/,
    'toggle-off drops the rule with the hints');
  // A press gives ~100ms — never enough for a document to complete — so the
  // press path must not prefetch; dwell only.
  const pressAt = warmLinks.indexOf("addEventListener('pointerdown'");
  const scrollAt = warmLinks.indexOf("addEventListener('scroll'");
  const block = warmLinks.slice(pressAt, scrollAt);
  assert.doesNotMatch(block, /prefetchSameSite/,
    'press-time prefetch would be pure waste');
});
