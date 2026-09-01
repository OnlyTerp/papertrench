const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const ARMED_ROW_KEY = 'pt_armed_row_intent';

function serviceWorker(opts = {}) {
  const values = {
    pt_settings: {
      framesEnabled: false,
      recordingEnabled: false,
      autoReview: false,
    },
    pt_state: { positions: {}, rounds: [], journal: [] },
  };
  let messageListener = null;
  let externalListener = null;
  const fetchCalls = [];
  const captureCalls = [];
  // Real Chrome exposes a storage failure by setting chrome.runtime.lastError
  // for the duration of the callback only; reading it outside a callback is
  // meaningless. The fail flags reproduce that exact shape.
  const failingCallback = (callback, result) => {
    sandbox.chrome.runtime.lastError = { message: 'quota exceeded (test)' };
    try { if (callback) callback(result); }
    finally { delete sandbox.chrome.runtime.lastError; }
  };
  const get = (keys, callback) => {
    if (opts.failReads) { failingCallback(callback, {}); return undefined; }
    const names = Array.isArray(keys) ? keys : Object.keys(keys || {});
    const result = {};
    for (const key of names) if (Object.hasOwn(values, key)) result[key] = values[key];
    if (callback) { callback(result); return undefined; }
    return Promise.resolve(result);
  };
  const set = (update, callback) => {
    if (opts.failWrites) { failingCallback(callback); return Promise.resolve(); }
    Object.assign(values, update);
    if (callback) callback();
    return Promise.resolve();
  };
  const remove = (key, callback) => {
    delete values[key];
    if (callback) callback();
    return Promise.resolve();
  };

  const sandbox = {
    console,
    Promise,
    JSON,
    Math,
    Date,
    Number,
    String,
    Array,
    Object,
    Boolean,
    RegExp,
    Error,
    Set,
    Map,
    URL,
    URLSearchParams,
    AbortController,
    Uint8Array,
    TextEncoder,
    crypto, // attest.js hashes through WebCrypto; Node's global implements it
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval: () => {},
    fetch: async (url) => {
      fetchCalls.push(String(url));
      if (String(url).includes('/topics/history?')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            topic: 'dog coins', start_at: 1_800_000_000, end_at: 1_800_003_600,
            requested_start_at: 1_800_000_000, requested_end_at: 1_800_000_120,
            resolution: 'hour', points: [], coverage: {},
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          generated_at: 1_800_000_001,
          broadcast_mode: false,
          readiness: [],
          sources: {},
          tokens: [{ mint: MINT, name: 'Bonk', symbol: 'BONK', status: 'graduated' }],
          signals: [],
          narratives: [],
          social: {
            topics: [{
              topic: 'dog coins', score: 50, stage: 'rising', platforms: ['tiktok'],
              token_versions: [{ mint: MINT, name: 'Bonk', symbol: 'BONK' }], evidence: [],
            }],
            company_posts: [], platforms: [],
          },
          chat_intelligence: { settings: { enabled: false, window_minutes: 60 }, recent: [], platforms: {} },
        }),
      };
    },
    chrome: {
      storage: {
        local: { get, set, remove },
        session: { get, set, remove },
      },
      runtime: {
        id: 'papertrench-test',
        openOptionsPage: () => {},
        onMessage: { addListener: (listener) => { messageListener = listener; } },
        onMessageExternal: { addListener: (listener) => { externalListener = listener; } },
        onStartup: { addListener: () => {} },
        onInstalled: { addListener: () => {} },
        sendMessage: async () => ({}),
      },
      tabs: {
        query: (query, callback) => callback([]),
        sendMessage: async () => ({}),
        // Records WHICH window is asked for: the whole point of the
        // wrong-tab-screenshot fix is that this argument decides what gets
        // photographed.
        captureVisibleTab: async (windowId) => {
          captureCalls.push(windowId);
          return 'data:image/jpeg;base64,';
        },
        get: async (id) => {
          const tab = values.tabsById && values.tabsById[id];
          if (!tab) throw new Error('no tab ' + id);
          return tab;
        },
        // The warm-links viewer registers these at import time.
        onRemoved: { addListener: () => {} },
        onUpdated: { addListener: () => {} },
        onActivated: { addListener: () => {} },
      },
      windows: { update: async () => ({}) },
      offscreen: {
        hasDocument: async () => false,
        createDocument: async () => {},
      },
      alarms: {
        clear: async () => true,
        create: () => {},
        onAlarm: { addListener: () => {} },
      },
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
    values, fetchCalls, captureCalls,
    get listener() { return messageListener; },
    get external() { return externalListener; },
    get isAllowedEndpoint() { return context.isAllowedEndpoint; },
    get maybeNoteSlowPool() { return context.maybeNoteSlowPool; },
    get rpcPool() { return context.PTRpcPool; },
    armed: {
      read: context.readArmedRowIntent,
      write: context.writeArmedRowIntent,
      clear: context.clearArmedRowIntent,
    },
    get storage() {
      return {
        getSettings: context.getSettings,
        getState: context.getState,
        setState: context.setState,
        getReplays: context.getReplays,
        setReplays: context.setReplays,
      };
    },
  };
}

function send(listener, message) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('background response timed out')), 2000);
    const asyncResponse = listener(message, { tab: { id: 1 } }, (response) => {
      clearTimeout(timeout);
      resolve(response);
    });
    assert.equal(asyncResponse, true, 'background messages must keep the response channel open');
  });
}

test('armed-row mirror write refuses a failed read without clobbering storage', async () => {
  const worker = serviceWorker({ failReads: true });
  const existing = [{ address: MINT, amount: 0.1, at: 1_800_000_000_000 }];
  worker.values[ARMED_ROW_KEY] = existing;

  const result = await worker.armed.write({
    address: 'OtherMint111111111111111111111111111',
    amount: 0.2,
    at: 1_800_000_000_001,
  });

  assert.equal(result, false);
  assert.equal(JSON.stringify(worker.values[ARMED_ROW_KEY]), JSON.stringify(existing));
});

test('armed-row selective clear removes all on a failed read without throwing', async () => {
  const worker = serviceWorker({ failReads: true });
  worker.values[ARMED_ROW_KEY] = [{ address: MINT, amount: 0.1, at: 1_800_000_000_000 }];

  await assert.doesNotReject(() => worker.armed.clear(MINT));
  assert.equal(Object.hasOwn(worker.values, ARMED_ROW_KEY), false);
});

test('concurrent armed-row writes preserve both intents', async () => {
  const worker = serviceWorker();
  const other = 'OtherMint111111111111111111111111111';

  await Promise.all([
    worker.armed.write({ address: MINT, amount: 0.1, at: 1_800_000_000_000 }),
    worker.armed.write({ address: other, amount: 0.2, at: 1_800_000_000_001 }),
  ]);

  assert.equal(worker.values[ARMED_ROW_KEY].length, 2);
  assert.equal(
    JSON.stringify(worker.values[ARMED_ROW_KEY].map((intent) => intent.address)),
    JSON.stringify([MINT, other]),
  );
});

test('concurrent armed-row write and selective clear preserve the other intent', async () => {
  const worker = serviceWorker();
  const other = 'OtherMint111111111111111111111111111';

  await Promise.all([
    worker.armed.write({ address: MINT, amount: 0.1, at: 1_800_000_000_000 }),
    worker.armed.clear(other),
  ]);

  assert.equal(JSON.stringify(worker.values[ARMED_ROW_KEY].map((intent) => intent.address)),
    JSON.stringify([MINT]));
});

test('service worker captures a real pt_trade_event into the replay store', async () => {
  const worker = serviceWorker();
  assert.equal(typeof worker.listener, 'function');
  const openedAt = 1_800_000_000_000;
  const response = await send(worker.listener, {
    type: 'pt_trade_event',
    kind: 'buy',
    opened: true,
    session: {
      sessionId: 'pts-worker-fixture',
      mint: MINT,
      symbol: 'BONK',
      name: 'Bonk',
      site: 'padre',
      openedAt,
    },
    trade: { id: 't1', sessionId: 'pts-worker-fixture', ts: openedAt, side: 'buy' },
  });

  assert.equal(response.ok, true);
  const replays = worker.values.pt_replays;
  assert.equal(replays.length, 1, 'a paper fill must create one session replay');
  assert.equal(replays[0].sessionId, 'pts-worker-fixture');
  assert.equal(replays[0].mint, MINT);

  const closedAt = openedAt + 120_000;
  const closed = await send(worker.listener, {
    type: 'pt_trade_event', kind: 'sell', opened: false,
    session: { sessionId: 'pts-worker-fixture', mint: MINT, symbol: 'BONK', name: 'Bonk',
      site: 'padre', openedAt, closedAt },
    trade: { id: 't2', sessionId: 'pts-worker-fixture', ts: closedAt, side: 'sell' },
    round: { id: 'round-worker', sessionId: 'pts-worker-fixture', mint: MINT, symbol: 'BONK',
      name: 'Bonk', site: 'padre', openedAt, closedAt, heldMs: 120_000,
      investedSol: 1, returnedSol: 1.2, pnlSol: 0.2, pnlPct: 20 },
  });
  assert.equal(closed.ok, true);
  assert.equal(worker.values.pt_replays[0].status, 'closed');
  assert.equal(worker.values.pt_replays[0].roundId, 'round-worker');
});

test('isAllowedEndpoint blocks SSRF targets and allows public endpoints', () => {
  const worker = serviceWorker();
  const allow = worker.isAllowedEndpoint;
  assert.equal(typeof allow, 'function');

  // Valid public endpoints.
  assert.equal(allow('https://api.openai.com/v1'), true);
  assert.equal(allow('http://api.openai.com/v1'), true);
  assert.equal(allow('https://ai.example.com:8443/path'), true);

  // Non-HTTP(S) and malformed URLs.
  assert.equal(allow('ftp://api.openai.com/v1'), false);
  assert.equal(allow('file:///etc/passwd'), false);
  assert.equal(allow('not a url'), false);
  assert.equal(allow(''), false);

  // URLs with credentials are rejected.
  assert.equal(allow('https://user:pass@api.openai.com/v1'), false);

  // Cloud metadata / link-local always blocked, even with local opt-in.
  assert.equal(allow('http://169.254.169.254/latest/meta-data/'), false);
  assert.equal(allow('http://169.254.169.254/latest/meta-data/', true), false);

  // Localhost / loopback blocked by default, allowed with opt-in.
  assert.equal(allow('http://127.0.0.1:8765/v1'), false);
  assert.equal(allow('http://127.1:8765/v1'), false);
  assert.equal(allow('http://0x7f000001:8765/v1'), false);
  assert.equal(allow('http://2130706433:8765/v1'), false);
  assert.equal(allow('http://localhost:8765/v1'), false);
  assert.equal(allow('http://localhost.:8765/v1'), false, 'trailing-dot localhost must be treated as localhost');
  assert.equal(allow('http://localhost.localdomain:8765/v1'), false);
  assert.equal(allow('http://127.0.0.1:8765/v1', true), true);
  assert.equal(allow('http://localhost:8765/v1', true), true);
  assert.equal(allow('http://localhost.:8765/v1', true), true);

  // Private ranges blocked by default, allowed with opt-in.
  assert.equal(allow('http://10.0.0.1/v1'), false);
  assert.equal(allow('http://172.16.0.1/v1'), false);
  assert.equal(allow('http://192.168.1.1/v1'), false);
  assert.equal(allow('http://100.64.0.1/v1'), false);
  assert.equal(allow('http://10.0.0.1/v1', true), true);
  assert.equal(allow('http://192.168.1.1/v1', true), true);

  // 0.0.0.0 always blocked.
  assert.equal(allow('http://0.0.0.0/v1'), false);
  assert.equal(allow('http://0.0.0.0/v1', true), false);

  // IPv6 loopback and link-local.
  assert.equal(allow('http://[::]/v1'), false, 'unspecified IPv6 must be blocked unconditionally');
  assert.equal(allow('http://[::]/v1', true), false);
  assert.equal(allow('http://[::1]/v1'), false);
  assert.equal(allow('http://[::1]/v1', true), true);
  assert.equal(allow('http://[fe80::1]/v1'), false);
  assert.equal(allow('http://[::ffff:127.0.0.1]/v1'), false);
  assert.equal(allow('http://[::ffff:192.168.1.1]/v1', true), true);
});

test('a failed storage read resolves to safe defaults instead of acting on garbage', async () => {
  // chrome.storage.local.get reports failure via chrome.runtime.lastError in
  // the callback; ignoring it means treating {} as real data. The worker must
  // fall back to defaults (settings), null (state), or an empty list (replays).
  const worker = serviceWorker({ failReads: true });

  const settings = await worker.storage.getSettings();
  assert.equal(settings.framesEnabled, true, 'a failed read falls back to default settings');
  assert.equal(settings.aiEndpoint, '', 'a failed read must not invent an AI endpoint');

  assert.equal(await worker.storage.getState(), null,
    'a failed state read resolves null, never a fake wallet');

  const replays = await worker.storage.getReplays();
  assert.equal(Array.isArray(replays), true, 'a failed replays read resolves a list');
  assert.equal(replays.length, 0, 'a failed replays read resolves an empty list');
});

test('background state writes advance the seq counter so tabs adopt them', async () => {
  // DEFECT D-13: content tabs adopt a stored state only when its seq is
  // STRICTLY greater than their own. The background's writers (AI review,
  // recording refs) wrote at the seq they read — invisible to every tab and
  // overwritten by the next 800 ms heartbeat. That is how AI reviews and
  // recording filenames vanished from the dashboard within a second.
  const worker = serviceWorker();

  await worker.storage.setState({ seq: 5, cashSol: 3 });
  assert.equal(worker.values.pt_state.seq, 6,
    'a background write must land strictly ahead of the seq it read');

  await worker.storage.setState({ cashSol: 3 });
  assert.equal(worker.values.pt_state.seq, 1,
    'a state missing seq starts the counter rather than staying invisible');
});

test('a failed storage write resolves instead of hanging the caller', async () => {
  const worker = serviceWorker({ failWrites: true });

  // Both writes must settle — an unresolved promise here would wedge every
  // awaiting message handler in the worker.
  await worker.storage.setState({ cashSol: 5 });
  await worker.storage.setReplays([]);

  assert.equal(worker.values.pt_state.positions instanceof Object, true,
    'the failed write must not corrupt what storage already held');
});

test('ai proxy blocks disallowed endpoints and fetches allowed ones', async () => {
  const worker = serviceWorker();

  // Malicious cloud metadata endpoint is rejected with no network call.
  worker.values.pt_settings = {
    aiEndpoint: 'http://169.254.169.254/latest/meta-data/',
    aiAllowLocalEndpoint: false,
  };
  const blocked = await send(worker.listener, { type: 'pt_ai_chat', messages: [], maxTokens: 100 });
  assert.ok(blocked.error, 'blocked endpoint must return an error');
  assert.equal(worker.fetchCalls.length, 0, 'no network call for blocked endpoint');

  // Public endpoint is fetched.
  worker.values.pt_settings = {
    aiEndpoint: 'https://api.openai.com/v1',
    aiAllowLocalEndpoint: false,
  };
  const models = await send(worker.listener, { type: 'pt_ai_models' });
  assert.equal(Array.isArray(models.models), true);
  assert.ok(worker.fetchCalls.some((u) => u.startsWith('https://api.openai.com/v1/models')), 'public endpoint is fetched');

  // Local endpoint is rejected unless explicitly allowed.
  worker.values.pt_settings = {
    aiEndpoint: 'http://127.0.0.1:8765/v1',
    aiAllowLocalEndpoint: false,
  };
  const localBlocked = await send(worker.listener, { type: 'pt_ai_models' });
  assert.ok(localBlocked.error, 'local endpoint blocked when opt-in is off');

  worker.values.pt_settings = {
    aiEndpoint: 'http://127.0.0.1:8765/v1',
    aiAllowLocalEndpoint: true,
  };
  worker.fetchCalls.length = 0;
  const localAllowed = await send(worker.listener, { type: 'pt_ai_models' });
  assert.equal(Array.isArray(localAllowed.models), true);
  assert.ok(worker.fetchCalls.some((u) => u.startsWith('http://127.0.0.1:8765/v1/models')), 'local endpoint fetched when opt-in is on');

  // Legacy default local endpoint is migrated to empty and rejected.
  worker.values.pt_settings = {
    aiEndpoint: 'http://127.0.0.1:8765/v1',
    aiAllowLocalEndpoint: false,
    settingsRevision: 3,
  };
  const migrated = await send(worker.listener, { type: 'pt_ai_chat', messages: [], maxTokens: 100 });
  assert.ok(migrated.error, 'legacy default endpoint is migrated away');
});

test('a blank endpoint keeps the coach off: chat errors, models return empty, no fetch', async () => {
  const worker = serviceWorker();
  worker.values.pt_settings = { aiEndpoint: '', aiAllowLocalEndpoint: true };

  const chat = await send(worker.listener, {
    type: 'pt_ai_chat', messages: [{ role: 'user', content: 'hi' }], maxTokens: 50,
  });
  assert.ok(chat.error, 'chat with no endpoint must error instead of guessing one');
  assert.match(chat.error, /No AI endpoint configured/i);

  const models = await send(worker.listener, { type: 'pt_ai_models' });
  assert.equal(models.models.length, 0, 'no endpoint means no models, silently');
  assert.equal(worker.fetchCalls.length, 0,
    'an empty endpoint must never reach the network — it is the coach being off');
});

/* -------------------- frame snapshots: right tab only -------------------- */

function fillEvent(sessionId) {
  const ts = 1_800_000_000_000;
  return {
    type: 'pt_trade_event', kind: 'buy', opened: true,
    session: { sessionId, mint: MINT, symbol: 'BONK', name: 'Bonk', site: 'padre', openedAt: ts },
    trade: { id: 't1', sessionId, ts, side: 'buy' },
  };
}

test('a fill snapshot photographs the trading tab’s own window, not the focused one', async () => {
  const worker = serviceWorker();
  worker.values.pt_settings = Object.assign({}, worker.values.pt_settings,
    { framesEnabled: true, recordingEnabled: false });
  // The trading tab is id 1 (that is what sender.tab.id reports), active in
  // window 3. Whatever window the user is actually looking at is irrelevant.
  worker.values.tabsById = { 1: { id: 1, active: true, windowId: 3 } };

  await send(worker.listener, fillEvent('pts-frame-window'));

  assert.deepEqual(worker.captureCalls, [3],
    'captureVisibleTab must be asked for the trading tab’s window (3), never the focused window');
});

test('when the trading tab is hidden there is no honest frame, so none is captured', async () => {
  const worker = serviceWorker();
  worker.values.pt_settings = Object.assign({}, worker.values.pt_settings,
    { framesEnabled: true, recordingEnabled: false });
  // The tab that traded is no longer the visible tab of its window.
  worker.values.tabsById = { 1: { id: 1, active: false, windowId: 3 } };

  await send(worker.listener, fillEvent('pts-frame-hidden'));

  assert.deepEqual(worker.captureCalls, [],
    'a hidden trading tab must skip the frame instead of photographing some other screen');
});

test('a closed trading tab yields no frame either', async () => {
  const worker = serviceWorker();
  worker.values.pt_settings = Object.assign({}, worker.values.pt_settings,
    { framesEnabled: true, recordingEnabled: false });
  worker.values.tabsById = {}; // tab 1 no longer exists

  await send(worker.listener, fillEvent('pts-frame-closed'));

  assert.deepEqual(worker.captureCalls, [],
    'a vanished tab cannot be depicted; the frame must be skipped, not guessed');
});

test('an explicit thesis snap captures even with automatic frames off, and answers honestly', async () => {
  const worker = serviceWorker();
  // framesEnabled: false is the harness default — the AUTOMATIC captures are
  // off. A hand-triggered snap from the thesis composer is its own consent.
  worker.values.tabsById = { 1: { id: 1, active: true, windowId: 3 } };

  const reply = await send(worker.listener, {
    type: 'pt_snap_frame', kind: 'thesis', explicit: true,
    session: { sessionId: 'pts-thesis-snap', mint: MINT, symbol: 'BONK' },
  });

  assert.deepEqual(worker.captureCalls, [3], 'the explicit snap must actually capture');
  assert.equal(reply.ok, true);
  assert.ok(Number(reply.at) > 0, 'the reply carries the frame timestamp the thesis will reference');
  const frame = worker.values.pt_frames[worker.values.pt_frames.length - 1];
  assert.equal(frame.kind, 'thesis');
  assert.equal(frame.sessionId, 'pts-thesis-snap');
  assert.equal(frame.t, reply.at, 'the stored frame and the reply must name the same moment');
});

test('a non-explicit snap request stays behind the frames setting', async () => {
  const worker = serviceWorker();
  worker.values.tabsById = { 1: { id: 1, active: true, windowId: 3 } };

  const reply = await send(worker.listener, {
    type: 'pt_snap_frame', kind: 'fill',
    session: { sessionId: 'pts-gated-snap', mint: MINT },
  });

  assert.deepEqual(worker.captureCalls, [], 'frames off means no automatic capture');
  assert.equal(reply.ok, false, 'and the caller is told no frame exists, not a blanket ok');
});

test('an explicit snap of a hidden tab still refuses — consent does not create a truthful frame', async () => {
  const worker = serviceWorker();
  worker.values.tabsById = { 1: { id: 1, active: false, windowId: 3 } };

  const reply = await send(worker.listener, {
    type: 'pt_snap_frame', kind: 'thesis', explicit: true,
    session: { sessionId: 'pts-thesis-hidden', mint: MINT },
  });

  assert.deepEqual(worker.captureCalls, [], 'a hidden tab cannot be honestly depicted, explicit or not');
  assert.equal(reply.ok, false);
});

/* ---------------- site bridge (leaderboard sync) ----------------
 *
 * The one external surface the extension has. These tests lock its three
 * promises: only papertrench.com is answered, nothing is served until the
 * user turns Site sync on, and what IS served is the same buildSubmission
 * evidence the manual export produces — never a diverging second story.
 */

function sendExternal(listener, message, sender) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('bridge response timed out')), 2000);
    listener(message, sender, (response) => { clearTimeout(timeout); resolve(response); });
  });
}

const SITE_SENDER = { origin: 'https://papertrench.com' };

function bridgeTrade(over) {
  return Object.assign({
    id: 'bt1', sessionId: 'pts-bridge', mint: MINT, side: 'buy',
    qty: 1000, priceNative: 0.001, solGross: 1, solNet: 0.99, ts: 1_000_000,
  }, over || {});
}

test('the bridge refuses every origin but papertrench.com', async () => {
  const worker = serviceWorker();
  const res = await sendExternal(worker.external,
    { type: 'pt_bridge_get_record' }, { origin: 'https://evil.example' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'origin-not-allowed');
});

test('the bridge is off by default — the site is told, never served', async () => {
  const worker = serviceWorker();
  const res = await sendExternal(worker.external, { type: 'pt_bridge_get_record' }, SITE_SENDER);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'bridge-disabled');
  const ping = await sendExternal(worker.external, { type: 'pt_bridge_ping' }, SITE_SENDER);
  assert.equal(ping.ok, true);
  assert.equal(ping.bridgeEnabled, false);
});

test('with Site sync on, the bridge serves buildSubmission evidence from the real chain', async () => {
  const worker = serviceWorker();
  worker.values.pt_settings = Object.assign({}, worker.values.pt_settings,
    { leaderboardBridge: true, balanceStartSol: 10 });
  const first = await send(worker.listener, { type: 'pt_attest_append', trade: bridgeTrade() });
  assert.equal(first.ok, true, first.error);
  const second = await send(worker.listener, { type: 'pt_attest_append', trade: bridgeTrade({
    id: 'bt2', side: 'sell', priceNative: 0.002, solGross: 2, solNet: 1.98, ts: 1_060_000,
  }) });
  assert.equal(second.ok, true, second.error);

  const res = await sendExternal(worker.external, { type: 'pt_bridge_get_record' }, SITE_SENDER);
  assert.equal(res.ok, true);
  assert.equal(res.payload.chain.length, 2);
  assert.equal(res.payload.head, res.payload.chain[1].hash);
  assert.equal(res.payload.claim.startingBalanceSol, 10);
  // The claim mirrors the chain replay — one story, told twice.
  assert.ok(Math.abs(res.payload.claim.realizedPnlSol - (1.98 - 0.99)) < 1e-9);
  assert.equal(typeof res.payload.trustModel, 'string');
});

test('an empty chain is not served as evidence of anything', async () => {
  const worker = serviceWorker();
  worker.values.pt_settings = Object.assign({}, worker.values.pt_settings,
    { leaderboardBridge: true });
  const res = await sendExternal(worker.external, { type: 'pt_bridge_get_record' }, SITE_SENDER);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'chain-empty');
});

test('unknown bridge requests are refused by name', async () => {
  const worker = serviceWorker();
  const res = await sendExternal(worker.external, { type: 'pt_bridge_drop_tables' }, SITE_SENDER);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'unknown-request');
});

/* ---------------- site relay: internal bridge cases (site-bridge.js) -------
 *
 * Unpacked installs have machine-specific ids the site can never message, so
 * a content script on papertrench.com relays the same two bridge requests
 * INTERNALLY — plus the sign-in identity echo that turns the dashboard's
 * gray chip green (field report: site sign-in "only takes me to the
 * website"; the loop never closed). Every content script this extension
 * runs shares chrome.runtime.sendMessage, so the background must re-gate
 * these types on the SENDER's origin: a compromised trading-site page must
 * not write the linked identity or read the record through relay types.
 */

function sendFrom(listener, message, sender) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('relay response timed out')), 2000);
    listener(message, sender, (response) => { clearTimeout(timeout); resolve(response); });
  });
}

const RELAY_SENDER = { tab: { id: 7, url: 'https://papertrench.com/leaderboard.html' } };
const FOREIGN_SENDER = { tab: { id: 8, url: 'https://axiom.trade/meme/whatever' } };

test('pt_site_identity from papertrench.com stores a verified linked identity', async () => {
  const worker = serviceWorker();
  const reply = await sendFrom(worker.listener, { type: 'pt_site_identity', handle: 'amogus0471' }, RELAY_SENDER);
  assert.equal(reply.ok, true);
  const stored = worker.values.pt_settings.leaderboardIdentity;
  assert.ok(stored, 'the identity must be persisted');
  assert.equal(stored.handle, 'amogus0471');
  assert.equal(stored.verified, true, 'the site holds the X session — its word is the verified truth');
  assert.equal(stored.source, 'site');
});

test('the site link overwrites a hand-typed claim, but an identical link never re-writes', async () => {
  const worker = serviceWorker();
  worker.values.pt_settings.leaderboardIdentity = { handle: 'oldclaim', verified: false, linkedAt: 1 };
  await sendFrom(worker.listener, { type: 'pt_site_identity', handle: 'realhandle' }, RELAY_SENDER);
  const first = worker.values.pt_settings.leaderboardIdentity;
  assert.equal(first.handle, 'realhandle', 'the verified site identity replaces the local claim');
  await sendFrom(worker.listener, { type: 'pt_site_identity', handle: 'realhandle' }, RELAY_SENDER);
  // Reference equality: the fake stores objects by reference, so a re-write
  // would swap the object. A signed-in tab polls /api/me repeatedly and each
  // poll echoes the identity — identical echoes must not churn storage.
  assert.equal(worker.values.pt_settings.leaderboardIdentity, first,
    'an identical link must be a no-op write');
});

test('pt_site_identity refuses foreign senders and malformed handles', async () => {
  const worker = serviceWorker();
  const foreign = await sendFrom(worker.listener, { type: 'pt_site_identity', handle: 'legit' }, FOREIGN_SENDER);
  assert.equal(foreign.ok, false);
  assert.equal(foreign.reason, 'origin-not-allowed');
  const malformed = await sendFrom(worker.listener,
    { type: 'pt_site_identity', handle: 'not a handle <b>' }, RELAY_SENDER);
  assert.equal(malformed.ok, false);
  assert.equal(malformed.reason, 'bad-handle');
  assert.equal(worker.values.pt_settings.leaderboardIdentity, undefined,
    'nothing may be stored on a refused link');
});

/* ---------------- slow-pool notice: solve it for everyone ------------------
 *
 * cojica456 (Balkans): every keyless public endpoint slow from their region;
 * a free personal endpoint pasted into Settings made launches instant — a
 * fix they had to discover alone. The worker now reads the pool's own
 * measurements and says the fix out loud, exactly once, only when the user
 * has no personal endpoint. No telemetry leaves the machine.
 */

test('a persistently slow public pool writes the notice exactly once', async () => {
  const worker = serviceWorker();
  worker.rpcPool._reset();
  for (let i = 0; i < 12; i++) worker.rpcPool.reportSuccess('publicnode', 1200);
  await worker.maybeNoteSlowPool({});
  assert.ok(worker.values.pt_rpc_notice, 'the notice must be written');
  assert.ok(worker.values.pt_rpc_notice.bestMs > 750, 'it carries the measured number');
  assert.ok(worker.values.pt_rpc_slow_told, 'the told flag makes it once-per-install');
  const first = worker.values.pt_rpc_notice;
  await worker.maybeNoteSlowPool({});
  assert.equal(worker.values.pt_rpc_notice, first, 'a second check never nags');
});

test('the notice never fires for users who already set their own endpoint', async () => {
  const worker = serviceWorker();
  worker.rpcPool._reset();
  for (let i = 0; i < 12; i++) worker.rpcPool.reportSuccess('publicnode', 1500);
  await worker.maybeNoteSlowPool({ rpcUrl: 'https://example-rpc.test' });
  assert.equal(worker.values.pt_rpc_notice, undefined,
    'they already solved it — telling them again is noise');
});

test('thin evidence never triggers the notice — one slow call is not a region', async () => {
  const worker = serviceWorker();
  worker.rpcPool._reset();
  for (let i = 0; i < 3; i++) worker.rpcPool.reportSuccess('publicnode', 2000);
  await worker.maybeNoteSlowPool({});
  assert.equal(worker.values.pt_rpc_notice, undefined, 'needs real sample depth');
  worker.rpcPool._reset();
  for (let i = 0; i < 20; i++) worker.rpcPool.reportSuccess('publicnode', 200);
  await worker.maybeNoteSlowPool({});
  assert.equal(worker.values.pt_rpc_notice, undefined, 'a fast pool has nothing to confess');
});

/* ---------------- pt_state_commit: the wallet single-writer ----------------
 *
 * Before this existed every context wrote pt_state with a bare storage.set:
 * two writers reading the same base both stamped seq N+1 and the second
 * silently ate the first. In live use that was one tab's ~800ms heartbeat
 * eating a fill just made in another — "I placed several buys and the
 * position vanished, then came back with false P&L" (LYAR field report,
 * twice). The worker now serializes every write and refuses a stale base.
 */

test('pt_state_commit: a matching base lands verbatim, a stale base is refused with current', async () => {
  const worker = serviceWorker();
  worker.values.pt_state = { seq: 5, positions: {}, journal: [] };
  const landed = await sendFrom(worker.listener, {
    type: 'pt_state_commit',
    state: { seq: 6, updatedAt: 1, positions: {}, journal: [{ id: 'f1', side: 'buy' }] },
    expectedSeq: 5,
  }, RELAY_SENDER);
  assert.equal(landed.ok, true);
  assert.equal(worker.values.pt_state.seq, 6, 'the committed seq is the writer\'s stamp, not a re-bump');
  const stale = await sendFrom(worker.listener, {
    type: 'pt_state_commit',
    state: { seq: 6, updatedAt: 2, positions: {}, journal: [] },
    expectedSeq: 5,
  }, RELAY_SENDER);
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'stale');
  assert.equal(stale.current.journal[0].id, 'f1',
    'the refused writer is handed the truth it must adopt');
});

test('pt_state_commit: the LYAR race — a stale heartbeat can no longer eat a fill', async () => {
  const worker = serviceWorker();
  worker.values.pt_state = { seq: 10, positions: {}, journal: [] };
  // Tab A lands a fill off base 10.
  const fill = await sendFrom(worker.listener, {
    type: 'pt_state_commit',
    state: {
      seq: 11, updatedAt: 100,
      positions: { MintA: { qty: 1000, costSol: 1 } },
      journal: [{ id: 'fill-1', side: 'buy', mint: 'MintA' }],
    },
    expectedSeq: 10,
  }, RELAY_SENDER);
  assert.equal(fill.ok, true);
  // Tab B's heartbeat, still holding base 10 (it read before A wrote — the
  // exact interleaving that used to erase the position from the wallet).
  const heartbeat = await sendFrom(worker.listener, {
    type: 'pt_state_commit',
    state: { seq: 11, updatedAt: 101, positions: {}, journal: [] },
    expectedSeq: 10,
  }, RELAY_SENDER);
  assert.equal(heartbeat.ok, false, 'the blind overwrite must be refused');
  assert.ok(worker.values.pt_state.positions.MintA,
    'the position survives in storage');
  assert.equal(worker.values.pt_state.journal[0].id, 'fill-1',
    'the fill survives in storage');
  assert.ok(heartbeat.current.positions.MintA,
    'the refused heartbeat is handed the state WITH the fill to adopt');
});

test('pt_state_commit: force lands regardless — a reset or restore is the new truth', async () => {
  const worker = serviceWorker();
  worker.values.pt_state = { seq: 42, positions: { MintA: { qty: 1 } }, journal: [{ id: 'old' }] };
  const reset = await sendFrom(worker.listener, {
    type: 'pt_state_commit',
    state: { seq: 43, updatedAt: 7, positions: {}, journal: [] },
    force: true,
    expectedSeq: 0,
  }, RELAY_SENDER);
  assert.equal(reset.ok, true);
  assert.deepEqual(worker.values.pt_state.journal, [], 'the reset wallet stands');
});

test('relayed bridge requests honor the origin gate and the Site-sync toggle', async () => {
  const worker = serviceWorker();
  const foreignPing = await sendFrom(worker.listener, { type: 'pt_bridge_ping' }, FOREIGN_SENDER);
  assert.equal(foreignPing.reason, 'origin-not-allowed');
  const ping = await sendFrom(worker.listener, { type: 'pt_bridge_ping' }, RELAY_SENDER);
  assert.equal(ping.ok, true);
  assert.equal(ping.bridgeEnabled, false, 'off is the default on purpose');
  const rec = await sendFrom(worker.listener, { type: 'pt_bridge_get_record' }, RELAY_SENDER);
  assert.equal(rec.ok, false);
  assert.equal(rec.reason, 'bridge-disabled', 'the toggle gates the relay exactly like the external path');
  worker.values.pt_settings.leaderboardBridge = true;
  const empty = await sendFrom(worker.listener, { type: 'pt_bridge_get_record' }, RELAY_SENDER);
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, 'chain-empty', 'toggle on: the relay reaches the same record path');
});
