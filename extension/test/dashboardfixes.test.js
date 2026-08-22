/* Dashboard/popup/background defect-fix regression tests.
 *
 * Covers the DEFECTS.md batch fixed together in this change:
 *
 *   D-04  AI-review click disabled the NOTES button (shared data-id)
 *   D-05  replay button always read "▶ 0 moments" (checkpoints never written)
 *   D-07  Best/Worst tiles hardcoded green/red and dropped the sign
 *   D-10  quick-sell presets accepted > 100%
 *   D-11  negative fee/slippage accepted — negative fees MINT free SOL
 *   D-15  failed storage read fabricated a fresh wallet, then persisted it
 *   D-16  init() unawaited/uncaught — any throw = permanently blank dashboard
 *   D-21  AI sendMessage rejections hung the UI at "Analyzing…" forever
 *   D-23  slippage ≥ 10000 made every sell throw a misleading feed error
 *   D-24  Settings rendered blank (and unbindable) on corrupt preset arrays
 *   D-25  a failed settings save was completely invisible
 *   D-29  "Test AI endpoint" persisted the entire unsaved form
 *   D-30  popup toggle label went stale on the storage-fallback path
 *   D-32  journal "Market cap" column mixed mcap and SOL prices
 *   D-33  calendar month chip broke in year-first locales ("202")
 *   D-38  reset ignored the starting balance typed into the form
 *   D-42  silent input coercions (0 balance → 10, uncapped preset lists)
 *   D-47  "Saved." written into the AI-test span and never cleared
 *   D-51  dashboard reset double-bumped seq (engine owns the bump)
 *   D-52  sessionStats counted break-even rounds as losses
 *
 * Wave 2 (accounting semantics + refresh architecture):
 *
 *   D-01  equity curve floated above true equity by cumulative buy fees
 *   D-02  "Realized P&L" was rounds-only while calendar/journal counted
 *         partial exits — same trade, three different numbers
 *   D-03  the chain replay disagreed with honest local state (gross vs net
 *         buy cost + partial exits), flagging untampered wallets as edited,
 *         with the absurd "0 problems found · derived P&L differs" line
 *   D-08  open-position % (net-of-fee) vs closed-round % (gross invested)
 *   D-17  session AI review answer wiped by the staged refresh
 *   D-18  leaderboard verification flickered to "Checking…" ~1/s, re-running
 *         SHA-256 over the whole chain; in-flight verifies landed detached
 *   D-19  settings save clobbered every content-script settings write
 *   D-20  open round-note editor destroyed the moment focus left it
 *   D-22  saveState was read-modify-write with no conflict handling
 *   D-26  emptying replays mid-playback → TypeError loop every 1.1 s
 *   D-27  fingerprint blind to in-place round mutations (review/note/thesis)
 *   D-28  tables reset scroll/hover ~1/s (marks + timeAgo churn)
 *   D-34  any focused input froze the ENTIRE dashboard refresh
 *
 * Wave 3 (dashboard value pack):
 *
 *   CSV   journal + rounds Export CSV: RFC-4180-safe escaping, documented
 *         stable column order, client-side Blob download with URL revoke
 *   ONBD  onboarding checklist on Overview: steps computed from real state,
 *         dismissal persisted as pt_settings.onboardingDismissed (added at
 *         write time only — engine.js untouched)
 *   D-40  replay scrub rebuilt the whole view twice per animation frame —
 *         buildReplayView memoized per (replay identity, session, cursor)
 *   D-45  share-card drop target advertised GIF animation it never delivered
 *   D-46  dead renderMomentMedia/renderReplayTape/formatUnix deleted
 *   D-49  coach prompts stamped fills in UTC ISO while the calendar buckets
 *         local days — stamps are local time with an explicit UTC offset
 *   D-50  frame data URLs interpolated unescaped into src attributes
 *
 * Engine fixes are exercised behaviourally through the real API; the
 * background override path is driven through the real service worker in a vm
 * sandbox; dashboard.js/popup.js (no DOM harness exists) are pinned with
 * source contracts in the statepersist.test.js style: assert the fixed shape
 * exists and the buggy shape is gone.
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
const AT = require('../attest.js');

const dashJs = fs.readFileSync(path.join(ROOT, 'dashboard.js'), 'utf8');
const popupJs = fs.readFileSync(path.join(ROOT, 'popup.js'), 'utf8');

/** Slice a top-level function body (functions in these files close at col 0). */
function fnBlock(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start !== -1, `${marker} must exist`);
  const end = source.indexOf('\n}', start);
  assert.ok(end !== -1, `${marker} must terminate`);
  return source.slice(start, end + 2);
}

/* ---------------- D-52: break-even rounds (engine, behavioural) ------------ */

test('D-52: a break-even round is neither a win nor a loss', () => {
  const settings = E.defaultSettings();
  const state = E.defaultState(settings);
  state.rounds = [
    { pnlSol: 1.5, pnlPct: 15 },
    { pnlSol: -0.5, pnlPct: -5 },
    { pnlSol: 0, pnlPct: 0 }, // scratched — exactly break-even
  ];
  const stats = E.sessionStats(state, settings);
  assert.equal(stats.rounds, 3);
  assert.equal(stats.wins, 1);
  assert.equal(stats.losses, 1, 'a scratched trade must not be branded a loss');
  assert.equal(stats.winRate, 50, 'the win rate is judged over decided rounds only');
});

test('D-52: all-break-even and empty sessions report a 0 win rate, not NaN', () => {
  const settings = E.defaultSettings();
  const scratched = E.defaultState(settings);
  scratched.rounds = [{ pnlSol: 0 }, { pnlSol: 0 }];
  const stats = E.sessionStats(scratched, settings);
  assert.equal(stats.wins, 0);
  assert.equal(stats.losses, 0);
  assert.equal(stats.winRate, 0);

  const empty = E.sessionStats(E.defaultState(settings), settings);
  assert.equal(empty.winRate, 0);
  assert.ok(!Number.isNaN(empty.winRate));
});

/* ---------------- D-29: endpoint test overrides (background, behavioural) --
 *
 * The real service worker is booted in a vm sandbox (same shape as
 * background.test.js) so the pt_ai_models message path runs for real: the
 * probe must hit the OVERRIDE endpoint, honour the override key and local
 * opt-in through the same isAllowedEndpoint gate, and write NOTHING.
 */
function serviceWorker() {
  const values = {
    pt_settings: { framesEnabled: false, recordingEnabled: false, autoReview: false, settingsRevision: 6 },
    pt_state: { positions: {}, rounds: [], journal: [] },
  };
  const writes = [];
  const fetchCalls = [];
  let messageListener = null;

  const sandbox = {
    console, Promise, JSON, Math, Date, Number, String, Array, Object, Boolean,
    RegExp, Error, Set, Map, URL, URLSearchParams, AbortController, Uint8Array,
    setTimeout, clearTimeout,
    setInterval: () => 1,
    clearInterval: () => {},
    fetch: async (url, opts) => {
      fetchCalls.push({ url: String(url), opts: opts || {} });
      if (String(url).endsWith('/models')) {
        return { ok: true, status: 200, json: async () => ({ data: [{ id: 'model-a' }, { id: 'model-b' }] }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    },
    chrome: {
      storage: {
        local: {
          get: (keys, callback) => {
            const names = Array.isArray(keys) ? keys : Object.keys(keys || {});
            const result = {};
            for (const key of names) if (Object.hasOwn(values, key)) result[key] = values[key];
            if (callback) { callback(result); return undefined; }
            return Promise.resolve(result);
          },
          set: (update, callback) => {
            writes.push(Object.keys(update));
            Object.assign(values, update);
            if (callback) callback();
            return Promise.resolve();
          },
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
        query: (query, callback) => callback([]),
        sendMessage: async () => ({}),
        captureVisibleTab: async () => 'data:image/jpeg;base64,',
        get: async () => { throw new Error('no tab'); },
        // The warm-links viewer registers these at import time.
        onRemoved: { addListener: () => {} },
        onUpdated: { addListener: () => {} },
        onActivated: { addListener: () => {} },
      },
      windows: { update: async () => ({}) },
      offscreen: { hasDocument: async () => false, createDocument: async () => {} },
      alarms: { clear: async () => true, create: () => {}, onAlarm: { addListener: () => {} } },
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
  return { values, writes, fetchCalls, get listener() { return messageListener; } };
}

function send(listener, message) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('background response timed out')), 2000);
    listener(message, { tab: { id: 1 } }, (response) => {
      clearTimeout(timeout);
      resolve(response);
    });
  });
}

test('D-29: pt_ai_models probes the override endpoint and writes nothing', async () => {
  const worker = serviceWorker();
  const response = await send(worker.listener, {
    type: 'pt_ai_models',
    overrides: {
      endpoint: 'https://ai.example.com/v1',
      apiKey: 'sk-test',
      model: 'gpt-x',
      aiAllowLocalEndpoint: false,
    },
  });
  assert.deepEqual(response.models, ['model-a', 'model-b']);
  const modelCalls = worker.fetchCalls.filter((c) => c.url.endsWith('/models'));
  assert.equal(modelCalls.length, 1);
  assert.equal(modelCalls[0].url, 'https://ai.example.com/v1/models',
    'the probe must hit the OVERRIDE endpoint, not the (empty) saved one');
  assert.equal(modelCalls[0].opts.headers.Authorization, 'Bearer sk-test',
    'the override key must authorise the probe');
  assert.deepEqual(worker.writes, [],
    'testing the endpoint must not write ANY storage key — the old handler persisted the whole unsaved form');
});

test('D-29: override endpoints still pass the isAllowedEndpoint SSRF gate', async () => {
  const worker = serviceWorker();
  const blocked = await send(worker.listener, {
    type: 'pt_ai_models',
    overrides: { endpoint: 'http://127.0.0.1:8765/v1', aiAllowLocalEndpoint: false },
  });
  assert.ok(blocked.error, 'a local endpoint without the local opt-in must be refused');
  // .length, not deepEqual: the refusal array is built inside the vm realm,
  // so its prototype is the sandbox's Array and deepStrictEqual would reject
  // two identical-looking empties.
  assert.equal(blocked.models.length, 0);
  assert.equal(worker.fetchCalls.filter((c) => c.url.endsWith('/models')).length, 0,
    'no request may leave for a refused endpoint');

  const allowed = await send(worker.listener, {
    type: 'pt_ai_models',
    overrides: { endpoint: 'http://127.0.0.1:8765/v1', aiAllowLocalEndpoint: true },
  });
  assert.deepEqual(allowed.models, ['model-a', 'model-b'],
    'the explicit local opt-in carried by the form must be honoured');
  assert.deepEqual(worker.writes, [], 'still nothing written');
});

test('D-29: pt_ai_models without overrides keeps using saved settings', async () => {
  const worker = serviceWorker();
  worker.values.pt_settings.aiEndpoint = 'https://saved.example.com/v1';
  const response = await send(worker.listener, { type: 'pt_ai_models' });
  assert.deepEqual(response.models, ['model-a', 'model-b']);
  const modelCalls = worker.fetchCalls.filter((c) => c.url.endsWith('/models'));
  assert.equal(modelCalls[0].url, 'https://saved.example.com/v1/models');
});

test('D-29: the dashboard test button sends overrides instead of persisting the form', () => {
  const bind = fnBlock(dashJs, 'function bindSettings()');
  const testIdx = bind.indexOf("getElementById('test-ai')");
  assert.ok(testIdx !== -1, 'the test button handler must exist');
  const testBlock = bind.slice(testIdx);
  assert.doesNotMatch(testBlock, /store\.set\(/,
    'the endpoint test must not write storage at all');
  assert.match(testBlock, /type: 'pt_ai_models',\s*\n\s*overrides: \{/,
    'the form values must travel as message overrides');
  for (const field of [
    'endpoint: settingsNow.aiEndpoint',
    'apiKey: settingsNow.aiApiKey',
    'aiAllowLocalEndpoint: settingsNow.aiAllowLocalEndpoint',
  ]) {
    assert.ok(testBlock.includes(field), `the override must carry ${field}`);
  }
});

/* ---------------- D-04 / D-21: AI review button targeting + rejections ----- */

test('D-04: the AI-review button has its own attribute and runReview targets it', () => {
  const rounds = fnBlock(dashJs, 'function renderRounds(el)');
  assert.match(rounds, /class="btn-sec review-btn" data-review-id=/,
    'the review button must carry data-review-id, not the shared data-id');

  const review = fnBlock(dashJs, 'async function runReview(roundId)');
  assert.match(review, /button\.review-btn\[data-review-id=/,
    'runReview must select the review button by its own attribute');
  assert.doesNotMatch(review, /`button\[data-id="\$\{roundId\}"\]`/,
    'the old bare data-id selector grabbed the NOTES button (first in the row) instead');

  const rebind = fnBlock(dashJs, 'function rebindSection(id, el)');
  assert.match(rebind, /runReview\(button\.dataset\.reviewId\)/,
    'the click binding must pass the id from the new attribute');
});

test('D-21: both AI sendMessage calls handle rejection and restore the UI', () => {
  const review = fnBlock(dashJs, 'async function runReview(roundId)');
  assert.match(review, /try \{[\s\S]*pt_ai_chat[\s\S]*\} catch \(err\) \{\s*\n\s*fail\(err\);/,
    'a rejected review call must route through the failure path, not reject unhandled');
  assert.match(review, /b\.disabled = false;[\s\S]*b\.textContent = 'AI review';/,
    'the failure path must re-enable the button and restore its label');

  const session = fnBlock(dashJs, 'async function runSessionReview()');
  assert.match(session, /try \{\s*\n\s*resp = await chrome\.runtime\.sendMessage/,
    'the session review call must be wrapped');
  // (D-17 moved the output into module state: setSessionReview stores the
  // text/error pair and re-renders the coach section from it, so the error
  // both shows immediately AND survives later refreshes.)
  assert.match(session, /catch \(err\) \{[\s\S]*setSessionReview\('Error: '[\s\S]*true\);/,
    'a rejected session review must land in the persisted output state as an error');
});

/* ---------------- D-05: replay button label ------------------------------- */

test('D-05: the replay button no longer counts the never-written checkpoints array', () => {
  const rounds = fnBlock(dashJs, 'function renderRounds(el)');
  assert.doesNotMatch(rounds, /checkpoints\.length|moments</,
    'replay.checkpoints is initialised [] and written nowhere — any count from it is a lie');
  assert.match(rounds, /replay-btn" data-session="\$\{esc\(replay\.sessionId\)\}">▶ Replay</,
    'the button reads plain "▶ Replay"');
});

/* ---------------- D-07: best/worst tiles ---------------------------------- */

test('D-07: best/worst tiles are coloured by actual sign and always signed', () => {
  const overview = fnBlock(dashJs, 'function renderOverview(el)');
  assert.match(overview, /statTile\('Best round'[\s\S]*?best && best\.pnlSol < 0 \? 'red' : 'green'/,
    'a negative best round (all-losing session) must render red');
  assert.match(overview, /statTile\('Worst round'[\s\S]*?worst && worst\.pnlSol >= 0 \? 'green' : 'red'/,
    'a positive worst round (all-winning session) must render green');
  assert.match(overview, /statTile\('Worst round', worst \? `\$\{worst\.pnlSol >= 0 \? '\+' : ''\}/,
    'the worst tile must carry an explicit sign');
  assert.doesNotMatch(overview, /: '—', 'green',/,
    'the hardcoded green tone must be gone');
  assert.doesNotMatch(overview, /: '—', 'red',/,
    'the hardcoded red tone must be gone');
});

/* ---------------- D-10/D-11/D-23/D-42: settings validation ---------------- */

test('D-10/D-11/D-23/D-42: form values are validated, never passed raw', () => {
  const gather = fnBlock(dashJs, 'function gatherSettingsFromForm(');

  // The exact coercions that minted free SOL / broke sells must be gone.
  assert.doesNotMatch(gather, /balanceStartSol: Number\(document\.getElementById\('set-balance'\)\.value\) \|\| 10/,
    'an invalid (or 0) balance must not silently become 10');
  assert.doesNotMatch(gather, /feeBps: Number\(document\.getElementById\('set-fee'\)\.value\) \|\| 0/,
    'a negative feeBps must be impossible — engine.js:214 turns it into free SOL');
  assert.doesNotMatch(gather, /slippageBps: Number\(document\.getElementById\('set-slippage'\)\.value\) \|\| 0/,
    'slippage ≥ 10000 makes every sell throw "No live price available"');

  // The fixed shape: bounded integers, bounded/deduped/capped preset lists.
  assert.match(gather, /clampInt\('set-fee', 0, 1000/, 'fee bps clamped to integer 0..1000');
  assert.match(gather, /clampInt\('set-slippage', 0, 2000/, 'slippage bps clamped to integer 0..2000');
  assert.match(gather, /numberList\('set-sellpcts', 100, [^,]+, \{ dedupe: true \}\)/,
    'quick-sell presets: > 0, ≤ 100, deduplicated');
  assert.match(gather, /numberList\('set-presets', 1000,/,
    'quick-buy presets: > 0, ≤ 1000');
  assert.match(gather, /values\.slice\(0, 8\)/, 'preset lists capped at 8 entries');
  assert.match(gather, /new Set\(values\)/, 'dedupe goes through a Set');
  assert.match(gather, /balanceNum >= 0\.1/, 'the balance floor is 0.1 SOL');
  assert.match(gather, /notes\.push\(`starting balance/,
    'a rejected balance must be reported, not silently replaced');
  assert.match(gather, /notes\.push/, 'every coercion is reported through notes');
});

/* ---------------- D-15: failed reads never fabricate a wallet ------------- */

test('D-15: dashboard storage reads fail soft and failed reads block writes', () => {
  const storeIdx = dashJs.indexOf('const store = {');
  assert.ok(storeIdx !== -1);
  const storeBlock = dashJs.slice(storeIdx, dashJs.indexOf('\n};', storeIdx) + 3);
  assert.match(storeBlock, /chrome\.runtime\.lastError\) \{ resolve\(null\); return; \}/,
    'store.get must resolve null on lastError — a failed read is NOT empty storage');

  const load = fnBlock(dashJs, 'async function loadAll(changedKeys)');
  assert.match(load, /if \(s === null\) \{/,
    'loadAll must branch on the failed-read sentinel instead of fabricating a fresh wallet');
  assert.match(load, /storageReadFailed = true;/, 'the failure must latch a module flag');
  assert.match(load, /renderStorageErrorBanner\(\)/, 'the failure must be visible');

  // D-22 restructured saveState() into mutateState(); the D-15 refusal must
  // survive the restructure — writing while blind is still how a fabricated
  // wallet destroys the real one.
  const saveStateBlock = fnBlock(dashJs, 'async function mutateState(');
  assert.match(saveStateBlock, /if \(storageReadFailed\) throw unreadable\(\);/,
    'mutateState must refuse while storage is unreadable — persisting a fabricated wallet destroys the real one');
  const saveSettingsBlock = fnBlock(dashJs, 'async function saveSettings()');
  assert.match(saveSettingsBlock, /if \(storageReadFailed\) \{\s*\n\s*throw new Error/,
    'saveSettings must refuse for the same reason');

  const banner = fnBlock(dashJs, 'function renderStorageErrorBanner()');
  assert.match(banner, /Storage read failed/, 'the banner must say what happened');
  assert.match(banner, /banner\.remove\(\)/, 'the banner must clear once a read succeeds');
});

/* ---------------- D-16: boot failures are visible ------------------------- */

test('D-16: a throw during init renders an error card instead of a blank page', () => {
  assert.match(dashJs, /init\(\)\.catch\(renderInitError\);/,
    'init must be fired with a catch');
  assert.doesNotMatch(dashJs, /^init\(\);$/m,
    'the bare unawaited init() call must be gone');
  const card = fnBlock(dashJs, 'function renderInitError(err)');
  assert.match(card, /createElement\('button'\)/, 'the card must offer a reload button');
  assert.match(card, /location\.reload\(\)/);
  assert.match(card, /\.textContent = \(err && err\.message\) \? err\.message : String\(err\)/,
    'the message is set via textContent — plain DOM, no markup injection');
});

/* ---------------- D-24: settings render survives corrupt arrays ----------- */

test('D-24: Settings renders (and stays bindable) with corrupt preset arrays', () => {
  const rs = fnBlock(dashJs, 'function renderSettings(el)');
  assert.match(rs, /Array\.isArray\(settings\.sellPcts\) \? settings\.sellPcts : DEFAULTS\.sellPcts/,
    'sellPcts must fall back to defaults at render time');
  assert.match(rs, /Array\.isArray\(settings\.presetsBuy\) \? settings\.presetsBuy : DEFAULTS\.presetsBuy/,
    'presetsBuy must fall back to defaults at render time');
  assert.doesNotMatch(rs, /settings\.sellPcts\.join/,
    'no unguarded .join on possibly-corrupt settings — it blanked the whole tab');
  assert.doesNotMatch(rs, /settings\.presetsBuy\.join/);
});

/* ---------------- D-25 / D-47: save status -------------------------------- */

test('D-25/D-47: save reports into its own status element, shows failures, auto-clears', () => {
  const save = fnBlock(dashJs, 'async function saveFromForm()');
  assert.match(save, /getElementById\('save-status'\)/,
    'the save flow must use its own status element');
  assert.doesNotMatch(save, /ai-test-result/,
    'the AI-test output span must never receive save status again');
  assert.match(save, /catch \(err\) \{[\s\S]*Save failed/,
    'a failed save must be shown (the old "Saved." wrote after the await, unconditionally)');
  assert.match(save, /setTimeout\([\s\S]*?2500\)/,
    'the plain confirmation must clear itself after ~2.5s');

  const rs = fnBlock(dashJs, 'function renderSettings(el)');
  assert.match(rs, /id="save-status"/,
    'the status element must render next to the Save button');
});

/* ---------------- D-30: popup fallback label ------------------------------ */

test('D-30: the popup fallback toggle re-renders so the label matches reality', () => {
  const block = fnBlock(popupJs, 'async function toggleOverlay()');
  assert.match(block, /chrome\.storage\.local\.set\(\{ pt_settings: newSettings \}\);[\s\S]*await load\(\);/,
    'after the storage-only fallback write the button label must be refreshed');
});

/* ---------------- D-32: honest market-cap column -------------------------- */

test('D-32: the journal Market cap column never shows a SOL price', () => {
  const journal = fnBlock(dashJs, 'function renderJournal(el)');
  assert.match(journal, /\$\{mcapLevel\(t\)\}/,
    'the mcap column must render through the mcap-only helper');
  assert.doesNotMatch(journal, /fillLevel\(t\)/,
    'the price-fallback helper must not feed the Market cap column');

  const mcap = fnBlock(dashJs, 'function mcapLevel(trade)');
  assert.match(mcap, /'—'/, 'an unknown mcap renders a plain em-dash');
  assert.doesNotMatch(mcap, /SOL/,
    'a SOL price must never appear under the Market cap header');

  const fill = fnBlock(dashJs, 'function fillLevel(trade)');
  assert.match(fill, /price > 0 \? PC\.formatPrice\(price\) \+ ' SOL' : '—'/,
    'fillLevel itself can no longer emit the "— SOL" corpse for a missing price');
});

/* ---------------- D-33: locale-safe month chip ---------------------------- */

test('D-33: the calendar best/worst chip asks the locale for the short month', () => {
  const cal = fnBlock(dashJs, 'function renderCalendar(el)');
  assert.doesNotMatch(cal, /monthName\.split\(' '\)\[0\]\.slice\(0, 3\)/,
    'slicing the long locale string renders "202" in year-first locales (ja-JP, hu-HU)');
  assert.match(cal, /\{ month: 'short' \}/,
    'the short month must come from toLocaleDateString directly');
  assert.match(cal, /\$\{monthShort\} \$\{t\.bestDay\.day\}/);
  assert.match(cal, /\$\{monthShort\} \$\{t\.worstDay\.day\}/);
});

/* ---------------- D-38 / D-51: reset -------------------------------------- */

function resetBlock() {
  const bind = fnBlock(dashJs, 'function bindSettings()');
  const start = bind.indexOf("getElementById('reset-all')");
  const end = bind.indexOf("getElementById('test-ai')");
  assert.ok(start !== -1 && end !== -1 && end > start, 'reset handler must exist before the test handler');
  return bind.slice(start, end);
}

test('D-38: reset honours a valid starting balance typed into the form', () => {
  const block = resetBlock();
  assert.match(block, /getElementById\('set-balance'\)/,
    'reset must read the form balance, not only the stale saved settings');
  assert.match(block, /formBalance >= 0\.1/,
    'only a valid (≥ 0.1 SOL) form balance is adopted');
  assert.match(block, /write\.pt_settings = settings/,
    'the adopted balance must be persisted so the reset wallet and saved settings agree');
});

test('D-51: dashboard reset does not double-bump seq — the engine owns the bump', () => {
  const block = resetBlock();
  assert.match(block, /E\.resetState\(settings, state\.seq\)/,
    'the reset must inherit the live seq through resetState');
  assert.doesNotMatch(block, /state\.seq = \(Number\(state\.seq\) \|\| 0\) \+ 1/,
    'resetState already advanced seq past the inherited base; a second bump lies about write count');
});

test('D-51 companion: engine resetState advances seq past the inherited base', () => {
  const fresh = E.resetState(E.defaultSettings(), 41);
  assert.equal(fresh.seq, 42, 'resetState owns the single seq bump');
});

/* ======================= wave 2 ======================= */

function wave2Settings(over) {
  return Object.assign(E.defaultSettings(), { balanceStartSol: 10, feeBps: 100, slippageBps: 0 }, over || {});
}

/* ---------------- D-02: realized P&L includes partial exits --------------- */

test('D-02: a partial exit shows up in realized P&L everywhere, immediately', () => {
  const settings = wave2Settings();
  const state = E.defaultState(settings);
  const t0 = 1_700_000_000_000;

  E.buy(state, settings, { ts: t0, mint: 'MintA', symbol: 'X', priceNative: 0.001, solAmount: 1 });
  const { trade } = E.sell(state, settings, { ts: t0 + 1000, mint: 'MintA', qtyFraction: 0.5, priceNative: 0.002 });

  const stats = E.sessionStats(state, settings);
  assert.equal(stats.rounds, 0, 'no round has closed — the old rounds-only sum reported +0 here');
  assert.ok(trade.pnlSol > 0, 'the partial exit banked real profit');
  assert.ok(Math.abs(stats.realizedPnlSol - trade.pnlSol) < 1e-9,
    'sessionStats must report the banked partial, not the rounds-only 0');
  assert.ok(Math.abs(stats.realizedPnlSol - state.stats.realizedPnlSol) < 1e-9,
    'the figure IS the per-sell accumulator sell() maintains');

  // Close the rest: the total stays the per-sell definition — the same one
  // the calendar and journal sum — so one trade shows ONE number.
  E.sell(state, settings, { ts: t0 + 2000, mint: 'MintA', qtyFraction: 1, priceNative: 0.002 });
  const closed = E.sessionStats(state, settings);
  const perSellSum = state.journal
    .filter((t) => t.side === 'sell')
    .reduce((s, t) => s + t.pnlSol, 0);
  assert.ok(Math.abs(closed.realizedPnlSol - perSellSum) < 1e-9,
    'realized P&L must equal the sum of per-sell results (the calendar definition)');
  // The rounds-only sum differs by exactly the buy fee (net cost basis);
  // that fee is reported separately in feesPaidSol, not hidden inside P&L.
  const roundSum = state.rounds.reduce((s, r) => s + r.pnlSol, 0);
  const buyFees = state.journal.filter((t) => t.side === 'buy').reduce((s, t) => s + t.feeSol, 0);
  assert.ok(Math.abs((closed.realizedPnlSol - roundSum) - buyFees) < 1e-9,
    'the definitions differ by the buy fee — the accumulator uses the net cost basis');
});

test('D-02: a legacy state without the accumulator falls back to the journal', () => {
  const settings = wave2Settings();
  const state = E.defaultState(settings);
  const t0 = 1_700_000_000_000;
  E.buy(state, settings, { ts: t0, mint: 'MintA', symbol: 'X', priceNative: 0.001, solAmount: 1 });
  const { trade } = E.sell(state, settings, { ts: t0 + 1000, mint: 'MintA', qtyFraction: 0.5, priceNative: 0.002 });

  delete state.stats.realizedPnlSol; // restored backup from an older build
  const stats = E.sessionStats(state, settings);
  assert.ok(Math.abs(stats.realizedPnlSol - trade.pnlSol) < 1e-9,
    'the journal sells carry the same per-sell definition and must back-fill it');
});

test('D-02: the popup uses the same per-sell definition', () => {
  const block = fnBlock(popupJs, 'function computeStats(state, settings)');
  assert.doesNotMatch(block, /rounds\.reduce\(\(s, r\) => s \+ \(r\.pnlSol \|\| 0\), 0\)/,
    'the rounds-only sum reported +0 for a trade the dashboard calendar showed as +2');
  assert.match(block, /state\.stats \|\| \{\}\)\.realizedPnlSol/,
    'the popup must read the per-sell accumulator');
  assert.match(block, /t\.side === 'sell' \? \(Number\(t\.pnlSol\) \|\| 0\) : 0/,
    'with the journal fallback for legacy states');
});

/* ---------------- D-03: the chain agrees with honest local state ---------- */

/** Build a verifiable chain from the engine journal (oldest first). */
async function chainFromJournal(state) {
  const chain = [];
  let prev = AT.GENESIS;
  for (const t of [...state.journal].reverse()) {
    const link = await AT.appendFill(prev, t);
    link.seq = chain.length;
    chain.push(link);
    prev = link.hash;
  }
  return chain;
}

test('D-03: partial exits and fees no longer read as TAMPERING', async () => {
  const settings = wave2Settings(); // 1% per side — the default
  const state = E.defaultState(settings);
  const t0 = 1_700_000_000_000;

  E.buy(state, settings, { ts: t0, mint: 'MintA', symbol: 'X', priceNative: 0.001, solAmount: 1 });
  E.sell(state, settings, { ts: t0 + 1000, mint: 'MintA', qtyFraction: 0.5, priceNative: 0.002 });

  // Mid-round, partial exit banked, fees paid — an honest wallet.
  let chain = await chainFromJournal(state);
  let stats = E.sessionStats(state, settings);
  let match = AT.claimMatchesChain(
    { realizedPnlSol: stats.realizedPnlSol }, chain, settings.balanceStartSol, 1e-6
  );
  assert.equal(match.ok, true,
    `an untampered wallet must verify mid-round; derived differs by ${match.diff} SOL`);

  // And after the round closes, with a second position still open.
  E.sell(state, settings, { ts: t0 + 2000, mint: 'MintA', qtyFraction: 1, priceNative: 0.0015 });
  E.buy(state, settings, { ts: t0 + 3000, mint: 'MintB', symbol: 'Y', priceNative: 0.005, solAmount: 2 });
  chain = await chainFromJournal(state);
  stats = E.sessionStats(state, settings);
  match = AT.claimMatchesChain(
    { realizedPnlSol: stats.realizedPnlSol }, chain, settings.balanceStartSol, 1e-6
  );
  assert.equal(match.ok, true,
    `the chain replay must agree by construction; derived differs by ${match.diff} SOL`);

  // Actual tampering is still caught.
  const inflated = AT.claimMatchesChain(
    { realizedPnlSol: stats.realizedPnlSol + 5 }, chain, settings.balanceStartSol, 1e-6
  );
  assert.equal(inflated.ok, false, 'an edited claim must still be flagged');
});

test('D-03: replayChain books buy cost at the NET amount, like the engine', async () => {
  // Buy 1 gross (0.99 net after the 1% fee), sell all for 1.9602 net.
  const buyLink = await AT.appendFill(AT.GENESIS, {
    id: 'b', mint: 'MintA', side: 'buy', qty: 990, priceNative: 0.001,
    solGross: 1, solNet: 0.99, ts: 1,
  });
  const sellLink = await AT.appendFill(buyLink.hash, {
    id: 's', mint: 'MintA', side: 'sell', qty: 990, priceNative: 0.002,
    solGross: 1.98, solNet: 1.9602, ts: 2,
  });
  const replayed = AT.replayChain([buyLink, sellLink], 10);
  // Engine definition: net proceeds − net cost = 1.9602 − 0.99 = 0.9702.
  // The old gross-cost replay derived 0.9602 — off by the buy fee, so every
  // fee-paying wallet was branded tampered.
  assert.ok(Math.abs(replayed.realizedPnlSol - 0.9702) < 1e-9,
    `expected the net-cost realized 0.9702, got ${replayed.realizedPnlSol}`);
  // Cash still moves by the committed cash-basis amounts (gross out, net in).
  assert.ok(Math.abs(replayed.cashSol - (10 - 1 + 1.9602)) < 1e-9);
});

test('D-03: a mismatch renders as one coherent sentence', () => {
  assert.doesNotMatch(dashJs, /found · derived P&L differs by/,
    'the absurd "0 problems found · derived P&L differs by X SOL" line must be gone');
  const view = fnBlock(dashJs, 'function lbVerifyView(chain, stats)');
  assert.match(view, /every hash verifies, but the displayed realized P&L differs from the chain-derived result by/,
    'a value mismatch on an intact chain must say exactly that');
  assert.match(view, /found in the chain, and the P&L it derives differs from the displayed figure by/,
    'broken links plus a value mismatch must read as one sentence');
  assert.match(view, /found in the chain`/,
    'broken links alone must not drag in a P&L clause');
});

/* ---------------- D-01: the equity curve converges on equitySol ----------- */

/* ---- D-51: the curve survives the journal cap (truncation divergence) ---- */

function tripsWallet(trips, over) {
  // Fee-free round trips at a fixed profit, so the arithmetic is hand-checkable
  // and the only thing under test is what truncation does to the walk.
  const settings = wave2Settings(Object.assign({ feeBps: 0 }, over || {}));
  const state = E.defaultState(settings);
  let ts = 1_700_000_000_000;
  for (let i = 0; i < trips; i++) {
    const mint = 'M' + (i % 7);
    ts += 1000;
    E.buy(state, settings, { ts, mint, symbol: 'S', priceNative: 0.001, solAmount: 0.5 });
    ts += 1000;
    E.sell(state, settings, { ts, mint, qtyFraction: 1, priceNative: 0.00102 });
  }
  return { state, settings, ts };
}

test('D-51: past the journal cap the curve still lands on equitySol', () => {
  // pruneJournal keeps the newest 2000 fills. Beyond that the dropped fills'
  // P&L is in cashSol but missing from the walk, so a curve anchored at the
  // starting balance froze while the equity KPI beside it kept climbing —
  // two numbers on one screen disagreeing, by more the older the account got.
  for (const trips of [1001, 1200, 1600]) {
    const { state, settings, ts } = tripsWallet(trips);
    assert.equal(state.journal.length, 2000, `the fixture must be truncated at ${trips} trips`);
    const pts = E.equityCurvePoints(state, settings.balanceStartSol, { now: ts + 1000 });
    const last = pts[pts.length - 1].eq;
    assert.ok(Math.abs(last - E.equitySol(state)) < 1e-9,
      `at ${trips} trips the curve must land on equitySol; got ${last} vs ${E.equitySol(state)}`);
  }
  // And the divergence must really have been there to fix: anchoring at the
  // starting balance (what the code did) is provably wrong at this size.
  const { state, settings } = tripsWallet(1600);
  const walked = state.journal.slice().sort((a, b) => a.ts - b.ts)
    .reduce((s, t) => s + (t.side === 'sell' ? (Number(t.pnlSol) || 0) : -(Number(t.feeSol) || 0)), 0);
  assert.ok(Math.abs((settings.balanceStartSol + walked) - E.equitySol(state)) > 1,
    'the start-anchored walk must be off by a large margin, or this test proves nothing');
});

test('D-51: a truncated curve starts at the oldest fill it can speak for', () => {
  const { state, settings, ts } = tripsWallet(1600);
  const pts = E.equityCurvePoints(state, settings.balanceStartSol, { now: ts + 1000 });
  const oldestRetained = state.journal.slice().sort((a, b) => a.ts - b.ts)[0];
  assert.equal(pts[0].t, oldestRetained.ts,
    'a truncated curve must not claim to begin at account open — it begins where its data does');
  assert.ok(pts[0].eq > settings.balanceStartSol,
    'and it must begin at the equity actually reached by then, not the starting balance');
  // Every point must still be exact relative to the last one.
  const step = pts[pts.length - 1].eq - pts[pts.length - 2].eq;
  assert.ok(Number.isFinite(step), 'the walk stays finite');
});

test('D-51: an unknowable equity draws NOTHING, never a confident line', () => {
  // The tempting "fix" here is to rescue a non-finite derivation by falling
  // back to the starting balance, which keeps the historical points finite.
  // That is the wrong trade. When cashSol is unknowable the KPI honestly
  // reads "—", and a start-anchored walk would draw a confident curve — with
  // a green/red profit verdict — for a wallet whose equity nobody can
  // compute. Absent beats plausible-but-unsupported.
  const settings = wave2Settings();
  const t0 = 1_700_000_000_000;

  const mk = () => {
    const state = E.defaultState(settings);
    E.buy(state, settings, { ts: t0, mint: 'A', symbol: 'A', priceNative: 0.001, solAmount: 1 });
    E.sell(state, settings, { ts: t0 + 2000, mint: 'A', qtyFraction: 1, priceNative: 0.0012 });
    E.buy(state, settings, { ts: t0 + 3000, mint: 'B', symbol: 'B', priceNative: 0.002, solAmount: 1 });
    return state;
  };

  // Corrupt cash: equity is unknowable, and the curve must not pretend.
  const cashBroken = mk();
  cashBroken.cashSol = NaN;
  assert.ok(!Number.isFinite(E.equitySol(cashBroken)), 'the KPI itself is unknowable here');
  const ptsCash = E.equityCurvePoints(cashBroken, settings.balanceStartSol, { now: t0 + 4000 });
  assert.ok(ptsCash.some((p) => !Number.isFinite(p.eq)),
    'a wallet whose equity cannot be computed must not render a drawable curve');

  // Corrupt mark: the renderer takes min/max across the series, so the
  // non-finite tail already empties the chart — the series must carry it.
  const markBroken = mk();
  markBroken.positions.B.lastPriceNative = NaN;
  const ptsMark = E.equityCurvePoints(markBroken, settings.balanceStartSol, { now: t0 + 4000 });
  assert.ok(ptsMark.some((p) => !Number.isFinite(p.eq)),
    'a broken mark must reach the series rather than be quietly absorbed');
});

test('D-51: a complete journal draws exactly the curve it always drew', () => {
  // The derived anchor must be a strict generalization: on a book whose
  // journal covers every fill it has to reproduce the old output exactly,
  // anchor value and anchor timestamp included.
  const { state, settings, ts } = tripsWallet(300);
  assert.ok(state.journal.length < 2000, 'this fixture must NOT be truncated');
  const pts = E.equityCurvePoints(state, settings.balanceStartSol, { now: ts + 1000 });
  assert.equal(pts[0].eq, settings.balanceStartSol,
    'a complete journal anchors on the caller\'s own starting figure, bit for bit');
  assert.equal(pts[0].t, state.startedAt, 'and at account open');
  assert.ok(Math.abs(pts[pts.length - 1].eq - E.equitySol(state)) < 1e-9);
});

test('D-01: the curve final point equals equitySol, open positions included', () => {
  const settings = wave2Settings();
  const state = E.defaultState(settings);
  const t0 = 1_700_000_000_000;

  E.buy(state, settings, { ts: t0, mint: 'MintA', symbol: 'A', priceNative: 0.001, solAmount: 1 });
  E.buy(state, settings, { ts: t0 + 1000, mint: 'MintB', symbol: 'B', priceNative: 0.002, solAmount: 2 });
  E.markPosition(state, 'MintA', 0.0015);
  E.sell(state, settings, { ts: t0 + 2000, mint: 'MintA', qtyFraction: 1, priceNative: 0.0015 });
  E.markPosition(state, 'MintB', 0.001); // open position, halved

  const pts = E.equityCurvePoints(state, settings.balanceStartSol, { now: t0 + 3000 });
  const last = pts[pts.length - 1].eq;
  assert.ok(Math.abs(last - E.equitySol(state)) < 1e-9,
    `the curve must land on equitySol; got ${last} vs ${E.equitySol(state)}`);

  // The old accumulation (sell pnlSol only, no buy-fee debit) floated above
  // true equity by exactly the cumulative buy fees.
  const buyFees = state.journal.filter((t) => t.side === 'buy').reduce((s, t) => s + t.feeSol, 0);
  const naive = settings.balanceStartSol
    + state.journal.filter((t) => t.side === 'sell').reduce((s, t) => s + t.pnlSol, 0)
    + Object.values(state.positions).reduce((s, p) => s + E.unrealizedPnl(p), 0);
  assert.ok(buyFees > 0, 'the scenario must actually pay buy fees');
  assert.ok(Math.abs((naive - last) - buyFees) < 1e-9,
    'the divergence being fixed is exactly the cumulative buy fees');

  // Fully closed: the curve ends on cash, which IS equity with nothing open.
  E.sell(state, settings, { ts: t0 + 4000, mint: 'MintB', qtyFraction: 1, priceNative: 0.001 });
  const flat = E.equityCurvePoints(state, settings.balanceStartSol, { now: t0 + 5000 });
  assert.ok(Math.abs(flat[flat.length - 1].eq - state.cashSol) < 1e-9,
    'with all positions closed the curve must end exactly on cash');
});

test('D-01: legacy buys without feeSol fall back to solGross − solNet', () => {
  const settings = wave2Settings();
  const state = E.defaultState(settings);
  const t0 = 1_700_000_000_000;
  E.buy(state, settings, { ts: t0, mint: 'MintA', symbol: 'A', priceNative: 0.001, solAmount: 1 });
  E.sell(state, settings, { ts: t0 + 1000, mint: 'MintA', qtyFraction: 1, priceNative: 0.002 });

  const withFee = E.equityCurvePoints(state, settings.balanceStartSol, { now: t0 + 2000 });
  for (const t of state.journal) if (t.side === 'buy') delete t.feeSol; // pre-feeSol journal
  const legacy = E.equityCurvePoints(state, settings.balanceStartSol, { now: t0 + 2000 });
  assert.ok(Math.abs(withFee[withFee.length - 1].eq - legacy[legacy.length - 1].eq) < 1e-9,
    'the solGross − solNet fallback must reproduce the same curve');
  assert.ok(Math.abs(legacy[legacy.length - 1].eq - state.cashSol) < 1e-9,
    'and still converge on equity');
});

test('D-01: the dashboard draws the engine curve, not its own walk', () => {
  const draw = fnBlock(dashJs, 'function drawEquityCurve()');
  assert.match(draw, /E\.equityCurvePoints\(state, start\)/,
    'the canvas must plot the fee-correct engine points');
  assert.doesNotMatch(draw, /pnl \+= \(t\.pnlSol \|\| 0\)/,
    'the old sell-only accumulation floated above equity by the buy fees');
});

/* ---------------- D-08: one percentage basis, open and closed ------------- */

test('D-08: open % uses the gross-invested basis; only the sell fee moves it at close', () => {
  const settings = wave2Settings(); // 1% per side
  const state = E.defaultState(settings);
  const t0 = 1_700_000_000_000;

  E.buy(state, settings, { ts: t0, mint: 'MintA', symbol: 'X', priceNative: 0.001, solAmount: 1 });
  const pos = state.positions.MintA;

  // Flat market: the position is worth its NET cost against a GROSS spend —
  // the buy fee is already a real 1% loss, exactly what a closed flat round
  // reports (minus the exit fee). The old pnl/costSol basis said 0%.
  const flatPct = E.positionPnlPct(pos);
  const expectedFlat = ((pos.qty * pos.lastPriceNative) / pos.investedSol - 1) * 100;
  assert.ok(Math.abs(flatPct - expectedFlat) < 1e-9);
  assert.ok(Math.abs(flatPct - (-settings.feeBps / 100)) < 1e-6,
    `a flat open position is down exactly the buy fee; got ${flatPct}%`);

  // A partial exit at an unchanged price must not move the percentage: the
  // surviving stack keeps its proportional gross basis.
  E.markPosition(state, 'MintA', 0.002);
  const beforePartial = E.positionPnlPct(pos);
  E.sell(state, settings, { ts: t0 + 1000, mint: 'MintA', qtyFraction: 0.5, priceNative: 0.002 });
  const afterPartial = E.positionPnlPct(pos);
  assert.ok(Math.abs(beforePartial - afterPartial) < 1e-9,
    'selling half at the same price must not change the remaining stack\'s %');

  // Full close at the same price: the % moves by the SELL fees alone — a
  // real cost — never by the ~2×feeBps accounting jump of the old bases.
  const beforeClose = E.positionPnlPct(pos);
  const { round } = E.sell(state, settings, { ts: t0 + 2000, mint: 'MintA', qtyFraction: 1, priceNative: 0.002 });
  const sellFees = state.journal.filter((t) => t.side === 'sell').reduce((s, t) => s + t.feeSol, 0);
  const expectedJump = (sellFees / round.investedSol) * 100;
  assert.ok(Math.abs((beforeClose - round.pnlPct) - expectedJump) < 1e-6,
    `the close must move the % by the sell fees only; open ${beforeClose}%, closed ${round.pnlPct}%`);
});

test('D-08: the dashboard open-positions % goes through the shared basis', () => {
  const open = fnBlock(dashJs, 'function renderOpenPositions()');
  assert.match(open, /E\.positionPnlPct\(p\)/,
    'the open % must come from the engine, on the gross-invested basis');
  assert.doesNotMatch(open, /pnl \/ p\.costSol/,
    'the net-of-fee denominator is what made the % jump ~2×feeBps at close');
});

/* ---------------- D-22: mutate-with-retry state writes -------------------- */

/** Run the SHIPPED mutateState against a scriptable storage stub. */
function mutateHarness(initialState) {
  const src = fnBlock(dashJs, 'async function mutateState(');
  const stored = { pt_state: initialState };
  const calls = { gets: 0, sets: 0 };
  let interfere = null;
  const store = {
    get: async () => {
      calls.gets += 1;
      if (interfere) interfere(calls.gets, stored);
      if (stored.pt_state === null) return null; // simulated unreadable storage
      return { pt_state: JSON.parse(JSON.stringify(stored.pt_state)) };
    },
    set: async (obj) => { calls.sets += 1; stored.pt_state = obj.pt_state; },
  };
  // D-40 wired mutateState to invalidate the replay-view memo on adoption;
  // the harness only needs it to exist.
  // The worker's serialized CAS commit (pt_state_commit), faked with the
  // same semantics: refuse a stale base with the current state, otherwise
  // land the write. Structured-clone at both edges like real Chrome — a
  // reference-sharing fake is how storage bugs hide from tests.
  const sandbox = {
    store,
    invalidateReplayView: () => {},
    chrome: {
      runtime: {
        sendMessage: async (msg) => {
          if (!msg || msg.type !== 'pt_state_commit') return {};
          calls.commits = (calls.commits || 0) + 1;
          const cur = stored.pt_state;
          const curSeq = cur ? (Number(cur.seq) || 0) : 0;
          if (!msg.force && cur && curSeq !== (Number(msg.expectedSeq) || 0)) {
            return { ok: false, reason: 'stale', current: JSON.parse(JSON.stringify(cur)) };
          }
          stored.pt_state = JSON.parse(JSON.stringify(msg.state));
          return { ok: true, seq: Number(msg.state.seq) || 0 };
        },
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `let storageReadFailed = false; let state = null;\n${src}\nthis.mutateState = mutateState; this.adopted = () => state;`,
    sandbox
  );
  return {
    mutate: (fn, retries) => sandbox.mutateState(fn, retries),
    adopted: () => sandbox.adopted(),
    stored, calls,
    setInterfere: (fn) => { interfere = fn; },
  };
}

test('D-22: a clean write reads fresh state, applies the mutation, bumps seq once', async () => {
  const h = mutateHarness({ seq: 5, rounds: [{ id: 'r1' }], journal: [], positions: {} });
  await h.mutate((fresh) => { fresh.rounds[0].note = { text: 'lesson', t: 1 }; });
  assert.equal(h.stored.pt_state.seq, 6, 'exactly one seq bump per write');
  assert.equal(h.stored.pt_state.rounds[0].note.text, 'lesson');
  assert.equal(h.adopted().seq, 6, 'the written state is adopted locally');
});

test('D-22: a concurrent seq bump triggers re-read and re-apply, not a lost write', async () => {
  const h = mutateHarness({ seq: 5, rounds: [{ id: 'r1' }], journal: [], positions: {} });
  // Between the base read (get #1) and the pre-write check (get #2), a
  // trading tab lands a fill: seq moves and a new round appears — exactly
  // the write the old blind read-modify-write would have destroyed.
  h.setInterfere((n, stored) => {
    if (n === 2) {
      stored.pt_state.seq = 6;
      stored.pt_state.rounds.unshift({ id: 'r2' });
    }
  });
  let applications = 0;
  await h.mutate((fresh) => {
    applications += 1;
    const target = fresh.rounds.find((r) => r.id === 'r1');
    target.note = { text: 'kept', t: 1 };
  });
  assert.equal(applications, 2, 'the mutation must be re-applied on the fresher state');
  assert.equal(h.stored.pt_state.seq, 7, 'written strictly above the concurrent write');
  assert.equal(h.stored.pt_state.rounds.length, 2, 'the concurrent fill survives');
  assert.equal(h.stored.pt_state.rounds.find((r) => r.id === 'r1').note.text, 'kept',
    'and the note survives WITH it — nobody loses');
});

test('D-22: retries are bounded and an unreadable read refuses to write', async () => {
  const contended = mutateHarness({ seq: 1, rounds: [], journal: [], positions: {} });
  contended.setInterfere((n, stored) => {
    if (n % 2 === 0) stored.pt_state.seq += 1; // every check sees a newer seq
  });
  await assert.rejects(
    () => contended.mutate((fresh) => { fresh.touched = true; }),
    /NOT saved/,
    'endless contention must surface, not spin forever'
  );
  assert.equal(contended.calls.sets, 0, 'nothing may be written under contention');

  const unreadable = mutateHarness(null);
  await assert.rejects(
    () => unreadable.mutate((fresh) => { fresh.touched = true; }),
    /unreadable/,
    'a failed read must refuse the write (D-15) — never fabricate and persist'
  );
});

test('D-22: the AI review write goes through the same retry path', () => {
  const review = fnBlock(dashJs, 'async function runReview(roundId)');
  assert.match(review, /await mutateState\(\(fresh\) => \{/,
    'the review annotation must be a retried mutation');
  assert.doesNotMatch(review, /await saveState\(\)/,
    'the blind read-modify-write saveState is gone');
});

/* ---------------- D-27/D-28: the fingerprint sees what matters ------------ */

/** Run the SHIPPED dataFingerprint against synthetic module state. */
function fingerprintOf(stateObj) {
  const src = fnBlock(dashJs, 'function dataFingerprint()');
  const sandbox = {
    state: stateObj, frames: [], replays: [], recordings: {}, settings: {},
    // The fingerprint also covers the PERPS book, which is a separate
    // module variable and a separate storage key. Absent here on purpose:
    // a dashboard with no perps activity must still fingerprint cleanly.
    perpsState: null,
    JSON, Number, Object,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${src}\nthis.fp = dataFingerprint();`, sandbox);
  return sandbox.fp;
}

function fpState(over) {
  return Object.assign({
    cashSol: 9,
    journal: [{ id: 't1' }],
    rounds: [{ id: 'r1' }],
    positions: { MintA: { mint: 'MintA', qty: 100, lastPriceNative: 0.001 } },
  }, over || {});
}

test('D-28: heartbeat price marks do not churn the fingerprint', () => {
  const a = fingerprintOf(fpState());
  const b = fingerprintOf(fpState({
    positions: { MintA: { mint: 'MintA', qty: 100, lastPriceNative: 0.002 } },
  }));
  assert.equal(a, b,
    'a live mark moves every 800 ms; including it rebuilt the visible table each second');

  const c = fingerprintOf(fpState({
    positions: { MintA: { mint: 'MintA', qty: 50, lastPriceNative: 0.001 } },
  }));
  assert.notEqual(a, c, 'a QUANTITY change is a real fill and must repaint');
});

test('D-27: in-place round mutations move the fingerprint', () => {
  const base = fingerprintOf(fpState());
  const cases = {
    aiReview: { id: 'r1', aiReview: { t: 123, text: 'x', ok: true } },
    note: { id: 'r1', note: { text: 'lesson', t: 124 } },
    thesis: { id: 'r1', thesis: { text: 'momentum', tags: ['momentum'] } },
    recordingFile: { id: 'r1', recordingFile: 'clip.webm' },
    recording: { id: 'r1', recording: { id: 'rec1' } },
  };
  for (const [field, round] of Object.entries(cases)) {
    const fp = fingerprintOf(fpState({ rounds: [round] }));
    assert.notEqual(fp, base,
      `a ${field} written in place must repaint — with D-13 fixed these writes land, but the dashboard never showed them`);
  }
});

test('D-28: live values update in place — no section rebuild on a price tick', () => {
  const live = fnBlock(dashJs, 'function updateOpenPositionMarks()');
  assert.match(live, /node\.textContent = /, 'live P&L is a text-node update');
  assert.doesNotMatch(live, /innerHTML/, 'the updater must never rebuild markup');

  const times = fnBlock(dashJs, 'function updateRelativeTimes()');
  assert.match(times, /dataset\.relTs/, 'relative labels refresh from their own timestamp');
  assert.doesNotMatch(times, /innerHTML/);

  const derived = fnBlock(dashJs, 'function refreshLiveDerived()');
  assert.match(derived, /renderSidebar\(\)/);
  assert.match(derived, /updateOpenPositionMarks\(\)/);
  assert.match(derived, /updateRelativeTimes\(\)/);

  const journal = fnBlock(dashJs, 'function renderJournal(el)');
  assert.match(journal, /data-rel-ts="\$\{Number\(t\.ts\) \|\| 0\}"/,
    'journal timestamps carry their ts so the label can refresh without a rebuild');
  const open = fnBlock(dashJs, 'function renderOpenPositions()');
  assert.match(open, /data-pos-row/, 'position rows are addressable for in-place updates');
  assert.match(open, /data-pos-pnl/, 'the live P&L node is addressable');
});

/* ---------------- D-20/D-34: per-section busy ----------------------------- */

test('D-20/D-34: busy is judged per section; an open note editor counts by presence', () => {
  const busy = fnBlock(dashJs, 'function isUserBusy()');
  assert.match(busy, /section && section\.contains\(active\)/,
    'a focused input only freezes the section that contains it (D-34)');
  assert.match(busy, /querySelector\('\.note-input'\)/,
    'an open note editor freezes rounds by DOM presence, focus or not (D-20)');
  assert.match(busy, /currentSection === 'rounds'/,
    'the editor check is scoped to the rounds section');
});

/* ---------------- D-17: the session review answer survives refreshes ------ */

test('D-17: the session review lives in module state and is re-injected on render', () => {
  const coach = fnBlock(dashJs, 'function renderCoach(el)');
  assert.match(coach, /sessionReview \? esc\(sessionReview\.text\) : ''/,
    'the staged coach markup must carry the stored answer — live-DOM-only writes were wiped');

  const helper = fnBlock(dashJs, 'function setSessionReview(text, error)');
  assert.match(helper, /sessionReview = \{ text, error: Boolean\(error\) \};/,
    'every stage of the review persists in module state');
  assert.match(helper, /renderSection\('coach'\)/,
    'the render path paints it, attached or not');

  const session = fnBlock(dashJs, 'async function runSessionReview()');
  assert.doesNotMatch(session, /out\.textContent/,
    'the answer must never be written into the live DOM alone');
});

/* ---------------- D-18: memoized chain verification ----------------------- */

test('D-18: verification is memoized by chain fingerprint and lands via re-render', () => {
  const keyFn = fnBlock(dashJs, 'function lbVerifyKey(chain, stats)');
  assert.match(keyFn, /chain\.length/, 'the fingerprint covers the length');
  assert.match(keyFn, /chain\[chain\.length - 1\]\.hash/,
    'and the head hash — each link commits to its predecessor, so head pins content');

  const bind = fnBlock(dashJs, 'async function bindLeaderboard(el)');
  assert.match(bind, /if \(lbVerifyCache && lbVerifyCache\.key === key\) return;/,
    'a cache hit must skip SHA-256 over the whole chain entirely');
  assert.match(bind, /lbVerifyInFlightKey === key\) return;/,
    'a verify already in flight for this chain must not be duplicated');
  assert.doesNotMatch(bind, /box\.innerHTML/,
    'the verdict must never be written into a possibly-detached node');
  assert.match(bind, /if \(currentSection === 'leaderboard'\) renderSection\('leaderboard'\);/,
    'the landing re-renders from the cache instead — the rebind cache hit stops recursion');

  const render = fnBlock(dashJs, 'function renderLeaderboard(el)');
  assert.match(render, /lbVerifyView\(chain, stats\)/,
    'the staged markup paints the memoized verdict synchronously, so "Checking…" never flickers back');
});

/* ---------------- D-19: settings save merges over a FRESH read ------------ */

test('D-19: save lays only form-controlled keys over freshly read settings', () => {
  const save = fnBlock(dashJs, 'async function saveFromForm()');
  assert.match(save, /await store\.get\(\['pt_settings'\]\)/,
    'the save must re-read pt_settings at save time — the module copy is frozen while the tab is open');
  assert.match(save, /E\.mergeSettings\(stored\.pt_settings\)/,
    'the fresh stored copy is the base');
  assert.match(save, /\{ \.\.\.freshSettings, \.\.\.gatherSettingsFromForm\(notes, freshSettings\) \}/,
    'only the form keys are laid over it');
  assert.match(save, /if \(stored === null\) \{/,
    'an unreadable read must refuse the save (D-15 discipline)');

  const gather = fnBlock(dashJs, 'function gatherSettingsFromForm(');
  assert.doesNotMatch(gather, /\.\.\.settings/,
    'gather spreading the stale module settings is what reverted every content-script write');
  for (const key of ['overlayWidth', 'overlayHeight', 'positionsBarLeft', 'positionsBarTop', 'positionsBarHidden', 'leaderboardIdentity']) {
    assert.ok(!gather.includes(key),
      `${key} is content-script/leaderboard state, not a form field — the form must not carry it`);
  }
});

/* ---------------- D-26: replay teardown ----------------------------------- */

test('D-26: emptying replays mid-playback stops the timer instead of looping TypeErrors', () => {
  const render = fnBlock(dashJs, 'function renderReplay(el)');
  const emptyBranch = render.slice(render.indexOf('if (!replays.length)'), render.indexOf('let replay ='));
  assert.match(emptyBranch, /stopReplayPlayback\(\);/,
    'the empty branch must stop frame playback before dropping the shell');
  assert.match(emptyBranch, /releaseReplayShell\(\);/,
    'and release the shell (which clears replayTimer and the video-sync rAF)');

  const toggle = fnBlock(dashJs, 'function toggleReplayPlayback()');
  assert.match(toggle, /const replay = currentReplay\(\);\s*\n\s*if \(!replay\) \{ stopReplayPlayback\(\); return; \}/,
    'the 1.1 s tick must stop itself when the current replay has vanished');

  const build = fnBlock(dashJs, 'function buildReplayView(replay)');
  assert.match(build, /if \(!replay\) \{/,
    'a missing replay degrades to an empty view, never a TypeError');
});

test("D-12: the replay shell identity covers the round outcome and session count", () => {
  const dash = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'dashboard.js'), 'utf8');
  const fnStart = dash.indexOf("function renderReplay(");
  const block = dash.slice(fnStart, dash.indexOf("\nfunction buildReplayView", fnStart));
  assert.match(block, /replay\.status/,
    "a round closing while the user watches must rebuild the hero (it showed OPEN forever)");
  assert.match(block, /replays\.length/,
    "a new session must be able to appear in the list");
  assert.doesNotMatch(block, /replayShell\.sessionId !== replay\.sessionId\) \{/,
    "the old sessionId-only reuse condition must be gone");
});

/* ======================= wave 3: dashboard value pack ======================= */

/* ---------------- CSV export (behavioural through the shipped helpers) ----- */

/** Run the SHIPPED CSV seam (csvEscape…roundsCsv) against the real engine. */
function csvApi() {
  const start = dashJs.indexOf('function csvEscape');
  const end = dashJs.indexOf('function downloadCsv');
  assert.ok(start !== -1 && end > start, 'the pure CSV seam must sit at the top of dashboard.js');
  const sandbox = { E, JSON, Number, String, Array, Object, Math, Date, Boolean };
  vm.createContext(sandbox);
  vm.runInContext(
    `${dashJs.slice(start, end)}\nthis.api = { csvEscape, buildCsv, csvIso, flattenThesis, journalCsv, roundsCsv, JOURNAL_CSV_COLUMNS, ROUNDS_CSV_COLUMNS };`,
    sandbox
  );
  return sandbox.api;
}

test('CSV: csvEscape is RFC-4180-safe and never turns a missing value into 0', () => {
  const { csvEscape } = csvApi();
  assert.equal(csvEscape('BONK'), 'BONK', 'plain values pass through unquoted');
  assert.equal(csvEscape(0), '0', 'a real zero survives');
  assert.equal(csvEscape('a,b'), '"a,b"', 'commas force quoting');
  assert.equal(csvEscape('say "hi"'), '"say ""hi"""', 'embedded quotes are doubled');
  assert.equal(csvEscape('line1\nline2'), '"line1\nline2"', 'LF forces quoting');
  assert.equal(csvEscape('cr\rhere'), '"cr\rhere"', 'CR forces quoting');
  assert.equal(csvEscape(null), '', 'null exports as an EMPTY field');
  assert.equal(csvEscape(undefined), '', 'undefined exports as an EMPTY field');
});

test('CSV: buildCsv emits the header first with CRLF line endings', () => {
  const { buildCsv } = csvApi();
  assert.equal(buildCsv(['a', 'b'], [['1', 'x,y']]), 'a,b\r\n1,"x,y"\r\n');
});

test('CSV: the journal export carries the documented columns, oldest first', () => {
  const api = csvApi();
  // join, not deepEqual: the array is built inside the vm realm, so its
  // prototype is the sandbox's Array and deepStrictEqual would reject it.
  assert.equal(api.JOURNAL_CSV_COLUMNS.join(','),
    'ts,side,symbol,mint,site,qty,priceNative,priceUsd,solGross,feeSol,solNet,pnlSol,mcap',
    'the column order is a documented contract — reordering breaks consumers');

  // Newest-first journal (the stored order); a symbol with a comma; a buy
  // with no pnlSol and no mcap — both must export EMPTY, never 0.
  const csv = api.journalCsv([
    { ts: Date.UTC(2026, 0, 2, 3, 4, 5), side: 'sell', symbol: 'BONK', mint: 'M2', site: 'padre', qty: 10, priceNative: 0.002, priceUsd: 0.4, solGross: 0.02, feeSol: 0.0002, solNet: 0.0198, pnlSol: 0.01, mcap: 240000 },
    { ts: Date.UTC(2026, 0, 1, 0, 0, 0), side: 'buy', symbol: 'A,B', mint: 'M1', site: 'axiom', qty: 5, priceNative: 0.001, priceUsd: 0.2, solGross: 1, feeSol: 0.01, solNet: 0.99, mcap: null },
  ]);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], api.JOURNAL_CSV_COLUMNS.join(','));
  assert.equal(lines[1], '2026-01-01T00:00:00.000Z,buy,"A,B",M1,axiom,5,0.001,0.2,1,0.01,0.99,,',
    'oldest fill first; ISO timestamp; missing pnlSol/mcap stay empty');
  assert.equal(lines[2], '2026-01-02T03:04:05.000Z,sell,BONK,M2,padre,10,0.002,0.4,0.02,0.0002,0.0198,0.01,240000');
  assert.equal(lines[3], '', 'the document is CRLF-terminated');
  assert.equal(lines.length, 4);
});

test('CSV: the rounds export flattens afterExit, thesis, and the exit grade honestly', () => {
  const api = csvApi();
  // join, not deepEqual: vm-realm array (see the journal columns test).
  assert.equal(api.ROUNDS_CSV_COLUMNS.join(','),
    'openedAt,closedAt,symbol,mint,site,heldMs,investedSol,returnedSol,entryMcapUsd,exitMcapUsd,pnlSol,pnlPct,'
    + 'peakPnlSol,troughPnlSol,afterExit.maxPct,afterExit.minPct,afterExit.samples,thesis,exitGrade');

  // A REAL closed round from the engine, then annotated the way the app does.
  const settings = wave2Settings();
  const state = E.defaultState(settings);
  const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
  E.buy(state, settings, { ts: t0, mint: 'MintA', symbol: 'X', site: 'padre', priceNative: 0.001, solAmount: 1 });
  const { round } = E.sell(state, settings, { ts: t0 + 60000, mint: 'MintA', site: 'padre', qtyFraction: 1, priceNative: 0.002 });
  round.afterExit = { maxPct: 120, minPct: -35, samples: 7 };
  round.thesis = { text: 'dip, buy the fear', tags: ['momentum', 'dip'], plan: 'scale out', targetPct: 50, stopPct: 20 };

  const bare = { ...round, id: 'r-bare', afterExit: undefined, thesis: undefined, closedAt: round.closedAt + 1000 };

  const csv = api.roundsCsv([bare, round], state); // stored newest-first on purpose
  const lines = csv.split('\r\n');
  assert.equal(lines[0], api.ROUNDS_CSV_COLUMNS.join(','));

  // Oldest (annotated) round first.
  assert.match(lines[1], new RegExp(`^${new Date(round.openedAt).toISOString()},${new Date(round.closedAt).toISOString()},X,MintA,padre,`));
  assert.match(lines[1], /,120,-35,7,/, 'observed afterExit extremes export as-is');
  assert.ok(lines[1].includes('"dip, buy the fear | tags: momentum/dip | plan: scale out | target: +50% | stop: -20%"'),
    'the thesis flattens to one quoted field (it contains a comma)');
  const grade = E.exitQuality(round);
  assert.ok(grade && lines[1].endsWith(',' + grade.verdict),
    'the exit grade is the same verdict the Rounds table shows');

  // The bare round: afterExit and thesis export as EMPTY fields — an honest
  // gap, never fabricated zeros.
  assert.match(lines[2], /,,,,/, 'missing afterExit fields and thesis stay empty');
  assert.doesNotMatch(lines[2], /,0,0,0,/, 'no zeros are invented for an unobserved After');
});

test('CSV: both cards render an Export CSV button wired to the revoked-URL download', () => {
  const journal = fnBlock(dashJs, 'function renderJournal(el)');
  assert.match(journal, /id="journal-export"/, 'the Journal card header carries the button');
  const rounds = fnBlock(dashJs, 'function renderRounds(el)');
  assert.match(rounds, /id="rounds-export"/, 'the Rounds card header carries the button');

  const rebind = fnBlock(dashJs, 'function rebindSection(id, el)');
  assert.match(rebind, /downloadCsv\(`papertrench-journal-\$\{csvStamp\(\)\}\.csv`, journalCsv\(state\.journal\)\)/,
    'the journal button downloads journalCsv');
  assert.match(rebind, /downloadCsv\(`papertrench-rounds-\$\{csvStamp\(\)\}\.csv`, roundsCsv\(state\.rounds, state\)\)/,
    'the rounds button downloads roundsCsv (state rides along for the U4 mcap columns)');

  const dl = fnBlock(dashJs, 'function downloadCsv(filename, text)');
  assert.match(dl, /new Blob\(\[text\], \{ type: 'text\/csv' \}\)/, 'generated client-side as a Blob');
  assert.match(dl, /URL\.createObjectURL/, 'served through an object URL');
  assert.match(dl, /revokeObjectURL/, 'the object URL is revoked — the popup backup pattern');
});

/* ---------------- onboarding checklist ------------------------------------ */

/** Run the SHIPPED onboardingSteps against synthetic state. */
function stepsOf(stateObj) {
  const src = fnBlock(dashJs, 'function onboardingSteps(state)');
  const sandbox = { Object, Math, Number, String, Array, Boolean };
  vm.createContext(sandbox);
  vm.runInContext(`${src}\nthis.run = onboardingSteps;`, sandbox);
  return sandbox.run(stateObj);
}

function doneById(steps) {
  return Object.fromEntries(steps.map((s) => [s.id, s.done]));
}

test('ONBD: every step is computed from real state — nothing pre-checked', () => {
  const empty = stepsOf({ journal: [], rounds: [], positions: {} });
  assert.equal(empty.length, 6);
  assert.deepEqual(Object.values(doneById(empty)), [false, false, false, false, false, false],
    'a fresh wallet has done nothing, so nothing is checked');
  assert.equal(empty.find((s) => s.id === 'graduation').progress, '0 / 50');
});

test('ONBD: each signal flips exactly its own step', () => {
  const base = { journal: [], rounds: [], positions: {} };
  assert.equal(doneById(stepsOf({ ...base, journal: [{ side: 'buy' }] })).buy, true);
  assert.equal(doneById(stepsOf({ ...base, journal: [{ side: 'sell' }] })).buy, false,
    'a sell alone is not a first buy');
  assert.equal(doneById(stepsOf({ ...base, positions: { M: { thesis: { text: 'x' } } } })).thesis, true,
    'a thesis on an OPEN position counts');
  assert.equal(doneById(stepsOf({ ...base, rounds: [{ thesis: { text: 'x' } }] })).thesis, true,
    'a thesis carried onto a closed round counts');
  assert.equal(doneById(stepsOf({ ...base, rounds: [{}] })).round, true);
  assert.equal(doneById(stepsOf({ ...base, rounds: [{ afterExit: { maxPct: 1, minPct: -1, samples: 2 } }] })).after, true);
  assert.equal(doneById(stepsOf({ ...base, rounds: [{ note: { text: 'lesson' } }] })).review, true);
  assert.equal(doneById(stepsOf({ ...base, rounds: [{ aiReview: { t: 1 } }] })).review, true);
  assert.equal(doneById(stepsOf({ ...base, rounds: [{ note: { text: '' } }] })).review, false,
    'an empty note is not a review');
});

test('ONBD: the review step checks itself once every doing-step is done', () => {
  const steps = stepsOf({
    journal: [{ side: 'buy' }],
    rounds: [{ thesis: { text: 'x' }, afterExit: { maxPct: 1, minPct: -1, samples: 1 } }],
    positions: {},
  });
  const done = doneById(steps);
  assert.equal(done.buy && done.thesis && done.round && done.after, true);
  assert.equal(done.review, true, 'the habit clearly exists — the card must not nag');
});

test('ONBD: the graduation step tracks 50 rounds with honest progress', () => {
  const rounds49 = Array.from({ length: 49 }, (_, i) => ({ id: 'r' + i }));
  const at49 = stepsOf({ journal: [], rounds: rounds49, positions: {} });
  assert.equal(doneById(at49).graduation, false);
  assert.equal(at49.find((s) => s.id === 'graduation').progress, '49 / 50');
  const at50 = stepsOf({ journal: [], rounds: [...rounds49, { id: 'r49' }], positions: {} });
  assert.equal(doneById(at50).graduation, true);
});

test('ONBD: shown until completed, then permanently hidden via pt_settings', () => {
  const render = fnBlock(dashJs, 'function renderOnboarding()');
  assert.match(render, /if \(settings\.onboardingDismissed === true\) return '';/,
    'a persisted dismissal hides the card for good');
  assert.match(render, /doneCount === steps\.length/,
    'completion is judged over ALL steps');
  assert.match(render, /persistOnboardingDismissal\(\);\s*\n\s*return '';/,
    'a completed checklist persists its own dismissal and renders nothing');
  assert.match(render, /id="onboard-dismiss"/, 'one dismiss button');
  assert.match(render, /I know my way around/, 'with the promised label');
  assert.match(render, /id="onboard-coach"/, 'the graduation row links the coach section');

  const overview = fnBlock(dashJs, 'function renderOverview(el)');
  assert.match(overview, /\$\{renderOnboarding\(\)\}/, 'the card renders on the Overview');

  const bind = fnBlock(dashJs, 'function bindOnboarding(el)');
  assert.match(bind, /persistOnboardingDismissal\(\)/);
  assert.match(bind, /nav button\[data-section="coach"\]/,
    'the coach link navigates through the real nav');
});

test('ONBD: dismissal is written over a FRESH read and engine.js is untouched', () => {
  const persist = fnBlock(dashJs, 'async function persistOnboardingDismissal()');
  assert.match(persist, /store\.get\(\['pt_settings'\]\)/,
    'D-19 discipline: the key is laid over freshly read settings, never the stale module copy');
  assert.match(persist, /if \(stored === null\) return;/,
    'D-15 discipline: an unreadable read refuses the write');
  assert.match(persist, /fresh\.onboardingDismissed = true;[\s\S]*await store\.set\(\{ pt_settings: fresh \}\);[\s\S]*settings = fresh;/,
    'the in-memory copy is adopted only AFTER the write lands');

  const gather = fnBlock(dashJs, 'function gatherSettingsFromForm(');
  assert.ok(!gather.includes('onboardingDismissed'),
    'the key is not a form field — the fresh-read merge preserves it across settings saves');

  const engineSrc = fs.readFileSync(path.join(ROOT, 'engine.js'), 'utf8');
  assert.ok(!engineSrc.includes('onboardingDismissed'),
    'absent-key defaults handle it — engine.js must not know the key exists');
});

/* ---------------- D-40: memoized replay view ------------------------------ */

/** Run the SHIPPED buildReplayView + invalidate against counting stubs. */
function replayViewHarness(eventTimes) {
  const invalidate = dashJs.match(/function invalidateReplayView\(\) \{ replayViewCache = null; \}/);
  assert.ok(invalidate, 'the shipped invalidate helper must exist');
  const src = [
    'let replayViewCache = null;',
    invalidate[0],
    fnBlock(dashJs, 'function buildReplayView(replay)'),
  ].join('\n');
  const calls = { builds: 0 };
  const sandbox = {
    Number, Math, Boolean, Object, Array,
    replayCursor: 0,
    replayRound: () => null,
    replayTrades: () => [],
    replayFrames: () => [],
    replayRecording: () => null,
    RP: { buildReplayEvents: () => { calls.builds += 1; return eventTimes.map((at) => ({ at })); } },
  };
  vm.createContext(sandbox);
  vm.runInContext(
    `${src}\nthis.build = buildReplayView; this.invalidate = invalidateReplayView; this.setCursor = (n) => { replayCursor = n; };`,
    sandbox
  );
  return { build: sandbox.build, invalidate: sandbox.invalidate, setCursor: sandbox.setCursor, calls };
}

test('D-40: an unchanged (replay, cursor) pair is served from the memo', () => {
  const h = replayViewHarness([10, 20]);
  const A = { sessionId: 's1', openedAt: 100 };
  const first = h.build(A);
  const second = h.build(A);
  assert.equal(h.calls.builds, 1, 'the second call must not rebuild the event list');
  assert.equal(first, second, 'the identical view object is returned');
  assert.equal(first.event.at, 10);
});

test('D-40: a cursor move, an invalidation, or a reloaded replay object rebuilds', () => {
  const h = replayViewHarness([10, 20]);
  const A = { sessionId: 's1', openedAt: 100 };
  h.build(A);
  h.setCursor(1);
  const moved = h.build(A);
  assert.equal(h.calls.builds, 2, 'a cursor change invalidates');
  assert.equal(moved.event.at, 20);
  h.build(A);
  assert.equal(h.calls.builds, 2, 'and the moved cursor is itself memoized');

  h.invalidate();
  h.build(A);
  assert.equal(h.calls.builds, 3, 'explicit invalidation forces a rebuild');

  // A reloaded replay list produces NEW objects for the same sessionId; the
  // identity key means a stale view can never be served across a data reload.
  h.build({ sessionId: 's1', openedAt: 100 });
  assert.equal(h.calls.builds, 4);
});

test('D-40: an out-of-range cursor clamps, then memoizes at the clamped index', () => {
  const h = replayViewHarness([10, 20]);
  const A = { sessionId: 's1', openedAt: 100 };
  h.setCursor(99);
  const clamped = h.build(A);
  assert.equal(clamped.event.at, 20, 'the cursor clamps to the last event');
  h.build(A);
  assert.equal(h.calls.builds, 1, 'the post-clamp cursor is a memo hit');
});

test('D-40: the D-26 degraded empty view survives and is never cached', () => {
  const h = replayViewHarness([10, 20]);
  const A = { sessionId: 's1', openedAt: 100 };
  h.build(A);
  const empty = h.build(null);
  // .length, not deepEqual: the empty array is a vm-realm array.
  assert.equal(empty.events.length, 0, 'a missing replay still degrades to an empty view');
  assert.equal(empty.replay, null);
  h.build(A);
  assert.equal(h.calls.builds, 1, 'the null call must not have evicted the cached view');
});

test('D-40: every data-refresh path invalidates the memo', () => {
  const load = fnBlock(dashJs, 'async function loadAll(changedKeys)');
  assert.match(load, /invalidateReplayView\(\);/, 'loadAll replaces state/frames/replays');
  const mutate = fnBlock(dashJs, 'async function mutateState(');
  assert.match(mutate, /invalidateReplayView\(\);/, 'mutateState adopts a fresh state');
  const recs = fnBlock(dashJs, 'async function loadRecordings()');
  assert.match(recs, /invalidateReplayView\(\);/, 'loadRecordings swaps the recordings map');
  assert.match(resetBlock(), /invalidateReplayView\(\)/, 'reset wipes everything the view is built from');
});

/* ---------------- D-45 / D-46 / D-49 / D-50 ------------------------------- */

test('D-45: the share-card drop target no longer promises GIF animation', () => {
  const html = fs.readFileSync(path.join(ROOT, 'dashboard.html'), 'utf8');
  assert.doesNotMatch(html, /image \/ GIF/,
    'the old label advertised animation the canvas composer does not deliver');
  assert.match(html, /a GIF renders as a still/,
    'the honest label says exactly what happens');
});

test('D-46: the dead render functions are gone and the live ones remain', () => {
  assert.doesNotMatch(dashJs, /function renderMomentMedia/,
    'renderMomentMedia was dead code drifting from syncReplayMedia');
  assert.doesNotMatch(dashJs, /function renderReplayTape/,
    'renderReplayTape was dead code drifting from syncTape');
  assert.doesNotMatch(dashJs, /function formatUnix/,
    'formatUnix had zero call sites');
  assert.match(dashJs, /function syncReplayMedia/, 'the live media renderer remains');
  assert.match(dashJs, /function syncTape/, 'the live tape renderer remains');
});

/** Run a SHIPPED formatLocalStamp (dashboard or background copy). */
function localStampFn(source, name) {
  const src = fnBlock(source, 'function formatLocalStamp(ms)');
  const sandbox = { Date, Number, String, Math };
  vm.createContext(sandbox);
  vm.runInContext(`${src}\nthis.run = formatLocalStamp;`, sandbox);
  assert.ok(typeof sandbox.run === 'function', `${name} must ship formatLocalStamp`);
  return sandbox.run;
}

test('D-49: coach stamps are local time with an explicit UTC offset', () => {
  const backgroundJs = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  for (const [source, name] of [[dashJs, 'dashboard.js'], [backgroundJs, 'background.js']]) {
    const stamp = localStampFn(source, name);
    const ts = Date.UTC(2026, 6, 15, 12, 34, 56);
    const out = stamp(ts);
    assert.match(out, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC[+-]\d{2}:\d{2}$/,
      `${name}: the stamp carries an explicit UTC-offset suffix`);
    // The rendered clock must be the LOCAL clock for that instant (whatever
    // this machine's zone is), and the suffix must encode that zone's offset.
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    const local = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    assert.equal(out.slice(0, 19), local, `${name}: the date-time part is local time`);
    const offsetMin = -d.getTimezoneOffset();
    const sign = offsetMin >= 0 ? '+' : '-';
    const abs = Math.abs(offsetMin);
    assert.equal(out.slice(20), `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`,
      `${name}: the suffix encodes the real zone offset`);
  }
});

test('D-49: both coach prompt builders use the local stamp, never bare UTC ISO', () => {
  const coach = fnBlock(dashJs, 'function buildCoachMessages(round, trades, roundFrames)');
  assert.match(coach, /formatLocalStamp\(t\.ts\)/);
  assert.doesNotMatch(coach, /toISOString/,
    'a UTC ISO stamp puts midnight fills on a different day than the calendar');

  const backgroundJs = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  const prompt = fnBlock(backgroundJs, 'function buildRoundReviewPrompt(round, trades)');
  assert.match(prompt, /formatLocalStamp\(trade\.ts\)/);
  assert.match(prompt, /formatLocalStamp\(round\.openedAt\)/);
  assert.match(prompt, /formatLocalStamp\(round\.closedAt\)/);
  assert.doesNotMatch(prompt, /toISOString/);
});

test('D-50: frame data URLs are escaped into src attributes', () => {
  assert.ok(dashJs.includes('src="${esc(relatedFrame.dataUrl)}"'),
    'the replay frame image escapes its data URL');
  assert.ok(dashJs.includes('src="${esc(f.dataUrl)}"'),
    'the coach frame strip escapes its data URLs');
  assert.doesNotMatch(dashJs, /src="\$\{relatedFrame\.dataUrl\}"/,
    'no unescaped interpolation remains');
  assert.doesNotMatch(dashJs, /src="\$\{f\.dataUrl\}"/);
});

test('D-43: the poll is a 30s hidden-gated safety net; storage events stay primary', () => {
  // The 4s full-storage deserialize (state + up to 80 base64 frames) ran for
  // the tab's lifetime, hidden or not, duplicating the onChanged path.
  assert.doesNotMatch(dashJs, /refreshLiveDerived\).catch\(\(\) => \{\}\); \}, 4000\)/,
    'the 4s always-on poll must be gone');
  assert.match(dashJs, /if \(document\.hidden\) return;\s*\n\s*refreshIfChanged\(\)\.then\(refreshLiveDerived\)/,
    'the safety-net poll must skip hidden tabs');
  assert.match(dashJs, /\}, 30_000\)/, 'the safety net runs at 30s');
  assert.match(dashJs, /visibilitychange/,
    'returning to the tab must refresh immediately instead of waiting out the net');
  assert.match(dashJs, /some\(\(key\) => key in changes\)/,
    'the event-driven refresh path must remain the primary');
});

test('D-39: recordings reload only when the replay list changes, plus on Replay entry', () => {
  const loadAllFn = fnBlock(dashJs, 'async function loadAll(changedKeys)');
  assert.match(loadAllFn, /replayFingerprint !== lastRecordingsFingerprint/,
    'an unchanged replay list must not reopen IndexedDB');
  const nav = fnBlock(dashJs, 'function bindNav()');
  assert.match(nav, /currentSection === 'replay'\) \{\s*\n\s*loadRecordings\(\)/,
    'entering Replay refreshes recordings for late-saving videos');
});
