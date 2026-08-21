/* Browser-environment load check + manifest wiring check.
 *
 * Every script the extension loads in a browser page is evaluated here in a
 * browser-LIKE sandbox: `window` exists, and Node's `module`/`require`/`exports`
 * are NOT defined. That is the environment Chrome actually provides, and it is
 * where the earlier "PaperEngine is not a function" failure came from — a file
 * can parse cleanly under Node and still fail to install its global in a page.
 *
 * It also asserts the manifest lists every script its consumers depend on, and
 * that the bridge/content message contract matches end to end.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

/** Minimal but honest stand-in for a page/extension environment. */
function makeBrowserSandbox() {
  const listeners = [];
  const win = {
    addEventListener: (type, fn) => listeners.push({ type, fn }),
    removeEventListener: () => {},
    postMessage: () => {},
    location: { href: 'https://trade.padre.gg/trade/So11111111111111111111111111111111111111112', hostname: 'trade.padre.gg', pathname: '/trade/So11111111111111111111111111111111111111112', search: '' },
    setTimeout: () => 0,
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    fetch: () => Promise.resolve({ ok: false, status: 503, json: async () => ({}), text: async () => '' }),
    WebSocket: function () {},
    EventSource: function () {},
    XMLHttpRequest: function () {},
    MutationObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
    TextDecoder: function () { this.decode = () => ''; },
    ResizeObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
    getComputedStyle: () => ({ right: '18px', top: '84px', position: 'static', display: 'block', visibility: 'visible', opacity: '1' }),
    confirm: () => false,
    navigator: { clipboard: { writeText: () => {} } },
    open: () => null,
  };
  win.window = win;
  win.self = win;

  const el = () => ({
    style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild() {}, removeChild() {}, remove() {}, setAttribute() {}, addEventListener() {},
    replaceChildren() {},
    querySelector: () => null, querySelectorAll: () => [], getBoundingClientRect: () => ({ top: 0, left: 0, width: 600, height: 400 }),
    attachShadow() { return { getElementById: () => el(), querySelectorAll: () => [], appendChild() {} }; },
    innerHTML: '', textContent: '', childNodes: [], children: [], focus() {}, closest: () => null,
    className: '', id: '', tagName: 'DIV', nodeType: 1, attributes: [],
    getAttribute: () => null,
    width: 800, height: 440,
    // Canvas-backed views (the dashboard equity curve) need a 2D context.
    // This mirrors the real CanvasRenderingContext2D surface the chart uses,
    // including the hi-DPI transform and gradient calls.
    getContext: () => ({
      clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {},
      fillRect() {}, fillText() {}, setLineDash() {}, closePath() {}, arc() {},
      save() {}, restore() {}, translate() {}, rotate() {}, setTransform() {},
      createLinearGradient: () => ({ addColorStop() {} }),
    }),
    clientWidth: 760, clientHeight: 260,
  });

  const doc = {
    readyState: 'complete',
    title: 'BONK / SOL',
    body: Object.assign(el(), { innerText: '', nodeType: 1 }),
    documentElement: el(),
    head: el(),
    createElement: () => el(),
    // A real page has the elements these scripts reference; returning a node
    // keeps this check focused on load-time failures rather than markup drift.
    getElementById: () => el(),
    querySelector: () => el(),
    querySelectorAll: () => [],
    addEventListener: () => {},
    createTreeWalker: () => ({ nextNode: () => null, currentNode: null }),
  };

  const sandbox = {
    window: win,
    self: win,
    document: doc,
    location: win.location,
    navigator: win.navigator,
    console,
    fetch: win.fetch,
    setTimeout: win.setTimeout,
    clearTimeout: win.clearTimeout,
    setInterval: win.setInterval,
    clearInterval: win.clearInterval,
    WebSocket: win.WebSocket,
    EventSource: win.EventSource,
    XMLHttpRequest: win.XMLHttpRequest,
    AbortController: function () { this.signal = {}; this.abort = () => {}; },
    MutationObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
    TextDecoder: function () { this.decode = () => ''; },
    ResizeObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
    URLSearchParams,
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
    Set, Map, WeakSet, WeakMap, Promise, JSON, Math, Date, Number, String, Array, Object, Boolean, RegExp, Error,
    isNaN, parseInt, parseFloat, Infinity, NaN, undefined,
    chrome: {
      runtime: {
        id: 'papertrench-test',
        getURL: (p) => 'chrome-extension://test/' + p,
        sendMessage: (msg) => {
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
        local: { get: (k, cb) => { if (typeof cb === 'function') cb({}); return Promise.resolve({}); }, set: (o, cb) => { if (typeof cb === 'function') cb(); return Promise.resolve(); } },
        onChanged: { addListener: () => {} },
      },
      tabs: { query: () => Promise.resolve([{ id: 1 }]), sendMessage: () => Promise.resolve() },
    },
  };
  // Deliberately absent: module, exports, require — exactly like a browser.
  return { sandbox, win };
}

/** Scripts Chrome evaluates in a page/extension context. */
const BROWSER_SCRIPTS = [
  { file: 'engine.js', global: 'PaperEngine' },
  { file: 'attest.js', global: 'PTAttest' },
  { file: 'pnlcard.js', global: 'PTPnlCard' },
  { file: 'recordings.js', global: 'PTRecordings' },
  { file: 'replay.js', global: 'PTReplay' },
  { file: 'quote.js', global: 'PaperQuote' },
  { file: 'sites.js', global: 'PaperTrenchSites' },
  { file: 'resolver.js', global: 'PaperTrenchResolver' },
  { file: 'chart-markers.js', global: 'PTChartMarkers' },
  { file: 'xlinks.js', global: 'PTXLinks' },
  { file: 'warmdest.js', global: 'PTWarmDest' },
  { file: 'xray-core.js', global: 'PTXRay' },
  { file: 'price-bridge.js', global: null },
  { file: 'warm-open-hook.js', global: null },
  { file: 'warm-links.js', global: null },
  { file: 'xwarm-relay.js', global: null },
  { file: 'xwarm-main.js', global: null },
  { file: 'xray-main.js', global: null },
  { file: 'xray-panel.js', global: null },
  { file: 'content.js', global: null },
  { file: 'popup.js', global: null },
  { file: 'dashboard.js', global: null },
];

for (const spec of BROWSER_SCRIPTS) {
  test(`${spec.file} loads in a browser environment (no module/require)`, () => {
    const src = fs.readFileSync(path.join(ROOT, spec.file), 'utf8');
    const { sandbox, win } = makeBrowserSandbox();

    // Dependencies must already be present, mirroring manifest load order.
    const ctx = vm.createContext(sandbox);
    for (const dep of BROWSER_SCRIPTS) {
      if (dep.file === spec.file) break;
      if (!dep.global) continue;
      vm.runInContext(fs.readFileSync(path.join(ROOT, dep.file), 'utf8'), ctx, { filename: dep.file });
    }

    // Confirm the browser illusion is real before asserting on it.
    assert.equal(vm.runInContext('typeof module', ctx), 'undefined', 'module must be undefined');
    assert.equal(vm.runInContext('typeof require', ctx), 'undefined', 'require must be undefined');
    assert.equal(vm.runInContext('typeof window', ctx), 'object', 'window must exist');

    assert.doesNotThrow(
      () => vm.runInContext(src, ctx, { filename: spec.file }),
      `${spec.file} threw while loading in a browser context`
    );

    if (spec.global) {
      assert.equal(
        typeof win[spec.global], 'object',
        `${spec.file} must install window.${spec.global}`
      );
    }
  });
}

test('engine.js installs a usable API under a browser context', () => {
  const { sandbox, win } = makeBrowserSandbox();
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'engine.js'), 'utf8'), ctx, { filename: 'engine.js' });

  // This is the exact failure that shipped: defaultState was not callable.
  assert.equal(typeof win.PaperEngine.defaultState, 'function');
  assert.equal(typeof win.PaperEngine.defaultSettings, 'function');
  const state = win.PaperEngine.defaultState(win.PaperEngine.defaultSettings());
  assert.equal(state.cashSol, win.PaperEngine.defaultSettings().balanceStartSol);
});

/* ---------------- manifest wiring ---------------- */

test('every manifest-declared script exists on disk', () => {
  const declared = [];
  for (const cs of manifest.content_scripts || []) declared.push(...(cs.js || []), ...(cs.css || []));
  if (manifest.background && manifest.background.service_worker) declared.push(manifest.background.service_worker);
  for (const war of manifest.web_accessible_resources || []) declared.push(...(war.resources || []));

  assert.ok(declared.length > 0, 'manifest must declare scripts');
  for (const rel of declared) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `manifest references missing file: ${rel}`);
  }
});

test('the content script list includes every global the content script reads', () => {
  const contentSrc = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  const entry = manifest.content_scripts.find((cs) => (cs.js || []).includes('content.js'));
  assert.ok(entry, 'manifest must declare content.js');
  const js = entry.js;

  // Globals the content script consumes -> the file that installs each.
  const provider = {
    PaperEngine: 'engine.js',
    PaperQuote: 'quote.js',
    PaperTrenchSites: 'sites.js',
    PaperTrenchResolver: 'resolver.js',
    PTChartMarkers: 'chart-markers.js',
  };

  for (const [globalName, file] of Object.entries(provider)) {
    if (!new RegExp('window\\.' + globalName).test(contentSrc)) continue;
    assert.ok(js.includes(file),
      `content.js reads window.${globalName} but the manifest does not load ${file}`);
    assert.ok(js.indexOf(file) < js.indexOf('content.js'),
      `${file} must load before content.js`);
  }

  assert.ok(js.includes('content.js'), 'content.js must be in the content script list');
});

test('price-bridge.js loads in MAIN world at document_start before Padre opens its feed', () => {
  const bridgeEntry = manifest.content_scripts.find((cs) => (cs.js || []).includes('price-bridge.js'));
  assert.ok(bridgeEntry, 'manifest must declare price-bridge.js as a content script');
  assert.equal(bridgeEntry.run_at, 'document_start', 'the bridge must install before page WebSockets open');
  assert.equal(bridgeEntry.world, 'MAIN', 'the bridge must patch the page\'s actual WebSocket/datafeed objects');

  const contentSrc = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  assert.doesNotMatch(contentSrc, /getURL\(['"]price-bridge\.js['"]\)/,
    'content.js must not inject the bridge late at document_idle');
});

test('dashboard loads its modules before dashboard.js', () => {
  const html = fs.readFileSync(path.join(ROOT, 'dashboard.html'), 'utf8');
  const engineAt = html.indexOf('src="engine.js"');
  const attestAt = html.indexOf('src="attest.js"');
  const pnlCardAt = html.indexOf('src="pnlcard.js"');
  const recordingsAt = html.indexOf('src="recordings.js"');
  const replayAt = html.indexOf('src="replay.js"');
  const dashboardAt = html.indexOf('src="dashboard.js"');
  assert.ok(engineAt >= 0 && attestAt > engineAt && pnlCardAt > attestAt
    && recordingsAt > pnlCardAt && replayAt > recordingsAt && dashboardAt > replayAt,
    'dashboard script order must be engine → attest → pnlcard → recordings → replay → dashboard');
});

test('the manifest requests only the permissions the extension actually uses', () => {
  // Least privilege matters for a public release: every extra permission is a
  // reason for someone to distrust the extension.
  // N1 (8/21): `alarms` joined for exactly two named wakes — the update
  // check (users had no way to learn a release shipped) and the limit-buy
  // TTL sweep. Any OTHER alarm use must extend this allowlist consciously.
  assert.deepEqual([...manifest.permissions].sort(),
    ['activeTab', 'alarms', 'offscreen', 'scripting', 'storage', 'tabs', 'unlimitedStorage'].sort());
  const bg = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  const alarmNames = [...bg.matchAll(/chrome\.alarms\.create\('([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(alarmNames)].sort(), ['pt_pending_buy_sweep', 'pt_update_check'],
    'alarms exist for the update check and the limit-buy TTL sweep only');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(manifest.version, pkg.version,
    'manifest.json and package.json must agree on the version');
});

/* ---------------- message contract ---------------- */

test('content and background share one consolidated paper-fill event', () => {
  const contentSrc = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  const backgroundSrc = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  assert.match(contentSrc, /type: 'pt_trade_event'/);
  assert.match(backgroundSrc, /case 'pt_trade_event'/);
  assert.match(contentSrc, /session: summarizeSession/);
});

test('the bridge message type and source match what the content script handles', () => {
  const bridgeSrc = fs.readFileSync(path.join(ROOT, 'price-bridge.js'), 'utf8');
  const contentSrc = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');

  // Source tag must agree.
  const bridgeTag = /const OUT_TAG = '([^']+)'/.exec(bridgeSrc);
  assert.ok(bridgeTag, 'bridge must define an OUT_TAG');
  assert.ok(contentSrc.includes(`'${bridgeTag[1]}'`),
    `content.js must filter on the bridge's source tag ${bridgeTag[1]}`);

  // Every type the bridge emits that carries price data must be handled.
  const emitted = [...bridgeSrc.matchAll(/emit\('([^']+)'/g)].map((m) => m[1]);
  assert.ok(emitted.includes('tick'), 'bridge must emit a tick message');

  const handled = [...contentSrc.matchAll(/ev\.type === '([^']+)'/g)].map((m) => m[1]);
  assert.ok(handled.includes('tick'),
    `content.js must handle the 'tick' message; it handles: ${handled.join(', ') || '(none)'}`);
});

test('the resolver global the content script reads is the one the resolver installs', () => {
  const resolverSrc = fs.readFileSync(path.join(ROOT, 'resolver.js'), 'utf8');
  const contentSrc = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');

  const installed = /window\.(PaperTrench\w+) = /.exec(resolverSrc);
  assert.ok(installed, 'resolver must install a window global');
  assert.ok(contentSrc.includes('window.' + installed[1]),
    `content.js must read window.${installed[1]}`);
});

test('quoteForTrade fills honestly: fresh sources first, stale snapshots bounded by the UI staleness mark', () => {
  // DEFECTS F-01 / F-13 / F-20 / F-52. The old contract here pinned a
  // 10-second stale-fill window for page-fed tokens — which was the DEFAULT
  // path, filled while the header itself showed "stale", and pre-empted even
  // a successful action-time resolver refresh. The ladder: fresh on-screen
  // price (age judged at click, before any async hop — F-52) → chain
  // authority on a quiet screen → click-time snapshot → fresh page tick →
  // pending window for unresolved launches → one resolver refresh → 3 s last
  // resort for every source alike → refuse with a visible reason.
  const contentSrc = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  const fnStart = contentSrc.indexOf('async function pickQuoteForTrade()');
  assert.ok(fnStart !== -1, 'quoteForTrade must exist');
  const block = contentSrc.slice(fnStart, contentSrc.indexOf('\n  }', fnStart) + 4);

  // F-13: the click-time snapshot is captured BEFORE the service-worker round
  // trip, so that trip cannot consume the snapshot's freshness budget.
  const snapAt = block.indexOf('const atClick = quoteSnapshot()');
  const chainAt = block.indexOf('await R.onchainQuote');
  assert.ok(snapAt !== -1 && chainAt !== -1 && snapAt < chainAt,
    'the click-time snapshot must be taken before the first async hop');

  // F-01: the 10-second fallback is gone; the last resort matches the header
  // staleness bound and is not wider for page-fed tokens than resolver-fed.
  assert.doesNotMatch(contentSrc, /ACTION_FALLBACK_MAX_AGE_MS/,
    'the 10 s stale-fill window must not exist anywhere');
  assert.match(contentSrc, /const STALE_FILL_MAX_AGE_MS = 3000/,
    'the last-resort fill bound must match STALE_AFTER_MS in quote.js');
  assert.doesNotMatch(block, /token\.pending \|\| token\.priceSource !== 'resolver'/,
    'stale fills must not get a wider window for page-fed tokens');

  // The fresh-launch sniping path stays alive: a pending token may fill from
  // the on-screen price within its own bounded window.
  assert.match(block, /PENDING_ACTION_MAX_AGE_MS/,
    'pending fresh launches keep a bounded on-screen fill window');

  // A successful action-time resolver refresh must beat any stale snapshot:
  // the last resort appears AFTER the action-resolver return in the ladder.
  const freshUse = block.indexOf("source: 'action-resolver'");
  const lastResort = block.indexOf('STALE_FILL_MAX_AGE_MS', freshUse);
  assert.ok(freshUse !== -1 && lastResort > freshUse,
    'the stale snapshot must be the LAST resort, after the resolver refresh');
});

test('the positions bar has a draggable grip and saves its position', () => {
  const contentSrc = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');

  assert.match(contentSrc, /id="pt-bar-grip"/,
    'the positions bar markup must include a drag grip');
  assert.match(contentSrc, /function setupBarDrag/,
    'a drag setup function must wire the grip to mouse events');
  assert.match(contentSrc, /settings\.positionsBarLeft\s*=/,
    'dragging must persist the left offset to settings');
  assert.match(contentSrc, /settings\.positionsBarTop\s*=/,
    'dragging must persist the top offset to settings');
});

test('live ticks are validated against a trusted anchor, not the last tick', () => {
  const contentSrc = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');

  assert.match(contentSrc, /function tokenAnchor/,
    'a tokenAnchor helper must exist to return the trusted resolver price');
  assert.match(contentSrc, /token\.anchor\s*=/,
    'setToken or requote must save a resolver anchor on the token');
  assert.match(contentSrc, /const anchor = tokenAnchor\(\)/,
    'handlePageTick must use an anchor from tokenAnchor');
  assert.match(contentSrc, /Q\.validateTick\(anchor,/,
    'handlePageTick must validate against the anchor, not the live price');
  assert.match(contentSrc, /payload\.mint.*token\.mint/,
    'ticks with a mismatched mint must be rejected');
});

test('the overlay visibility can be toggled between master and auto-hide controls', () => {
  const engineSrc = fs.readFileSync(path.join(ROOT, 'engine.js'), 'utf8');
  const contentSrc = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  const dashboardSrc = fs.readFileSync(path.join(ROOT, 'dashboard.js'), 'utf8');
  const popupSrc = fs.readFileSync(path.join(ROOT, 'popup.js'), 'utf8');

  assert.match(engineSrc, /overlayHideWhenNoToken:\s*true/,
    'the default must hide the overlay when no token is detected');
  const revMatch = engineSrc.match(/SETTINGS_REVISION = (\d+)/);
  assert.ok(revMatch && Number(revMatch[1]) >= 6,
    'settings revision must be at least 6 (positions bar collapse persistence)');
  assert.match(contentSrc, /function updateOverlayVisibility/,
    'content.js must hide the main panel when no token is present');
  assert.match(contentSrc, /function toggleOverlayAutoHide/,
    'content.js must have a quick auto-hide toggle in the panel header');
  assert.match(contentSrc, /function toggleOverlayEnabled/,
    'content.js must support the master overlay toggle');
  assert.match(contentSrc, /setPanelVisible/,
    'content.js must keep the positions bar visible while hiding the panel');
  assert.match(dashboardSrc, /set-overlay-auto-hide/,
    'dashboard settings must expose the auto-hide toggle');
  assert.match(popupSrc, /overlayEnabled/,
    'popup.js must control the master overlay switch');
});

test('the trade tab is resizable and persists its size', () => {
  const engineSrc = fs.readFileSync(path.join(ROOT, 'engine.js'), 'utf8');
  const contentSrc = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  const dashboardSrc = fs.readFileSync(path.join(ROOT, 'dashboard.js'), 'utf8');

  assert.match(engineSrc, /overlayWidth:\s*null/,
    'engine defaults must store a null overlay width');
  assert.match(engineSrc, /overlayHeight:\s*null/,
    'engine defaults must store a null overlay height');
  assert.match(contentSrc, /class="pt-resize"/,
    'the trade tab markup must include a resize handle');
  assert.match(contentSrc, /function onOverlayResizeStart/,
    'the content script must implement drag-to-resize');
  assert.match(contentSrc, /function applyOverlaySize/,
    'the content script must re-apply the saved overlay size');
  assert.match(dashboardSrc, /overlayWidth.*overlayHeight|overlay size/,
    'dashboard settings save must not wipe overlay size');
});

test('average mcap lines are drawn from the live bar close, not a stale resolver mcap', () => {
  const bridgeSrc = fs.readFileSync(path.join(ROOT, 'price-bridge.js'), 'utf8');

  assert.match(bridgeSrc, /function mcapLevelFromClose/,
    'the bridge must compute mcap line levels from the live bar close');
  assert.match(bridgeSrc, /currentPriceNative|currentPriceUsd/,
    'paper-lines payload must include the current token price for scaling');
});

test('armed buys survive a pair address resolving into its base mint', () => {
  const contentSrc = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');

  // On pair-URL sites (Axiom, Photon, BullX) the pending token's mint is the
  // PAIR address. When it resolves, the mint changes — that upgrade must
  // rebind the armed buy, not drop it, or the snipe dies on the first quote.
  assert.match(contentSrc, /sameTokenResolving/,
    'setToken must recognise a pending pair resolving into its mint');
  assert.match(contentSrc, /armedBuy\.mint = token\.mint/,
    'the armed intent must be rebound to the resolved mint');
});

test('armed buys flush from every price path and expire visibly', () => {
  const contentSrc = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');

  // The resolver path delivers the first quote for most fresh launches; it
  // must flush the armed buy just like page ticks and setToken do.
  const requoteBody = contentSrc.slice(
    contentSrc.indexOf('async function requote'),
    contentSrc.indexOf('function stopPriceLoop')
  );
  assert.match(requoteBody, /flushArmedBuy\(\)/,
    'requote must flush the armed buy when it adopts the first price');

  // The heartbeat is the universal watchdog: it flushes whatever the price
  // source was, and it expires stale intents even when no path ever flushes.
  const loopBody = contentSrc.slice(
    contentSrc.indexOf('function startPriceLoop'),
    contentSrc.indexOf('async function requote')
  );
  assert.match(loopBody, /flushArmedBuy\(\)/,
    'the heartbeat must flush an armed buy once any price exists');
  assert.match(loopBody, /Armed buy expired/,
    'the heartbeat must expire an armed buy that never got a quote');
});

test('state writes are seq-stamped and a failed read never fabricates a wallet', () => {
  const contentSrc = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  const engineSrc = fs.readFileSync(path.join(ROOT, 'engine.js'), 'utf8');

  // A failed storage read resolves null — distinct from "succeeded but empty"
  // — so reloadState can keep the in-memory wallet instead of inventing a
  // fresh one that the next heartbeat mark would then persist.
  assert.match(contentSrc, /resolve\(null\)/,
    'store.get must surface failures as null, not as an empty result');
  assert.match(contentSrc, /if \(stored === null\) return/,
    'reloadState must keep the current state when the read fails');

  assert.match(contentSrc, /function persistStateNow/,
    'all state writes must go through one stamping writer');
  assert.match(contentSrc, /state\.seq = \(Number\(state\.seq\) \|\| 0\) \+ 1/,
    'every write must bump the monotonic state seq');
  assert.match(contentSrc, /Number\(storedState\.seq\) > Number\(state\.seq\)/,
    'the debounced writer must detect a newer state in storage and adopt it');
  assert.match(engineSrc, /seq: 0/,
    'a fresh wallet starts at seq 0');
});

test('post-close notes let the lesson be written after the outcome', () => {
  const dashboardSrc = fs.readFileSync(path.join(ROOT, 'dashboard.js'), 'utf8');
  const dashboardHtml = fs.readFileSync(path.join(ROOT, 'dashboard.html'), 'utf8');

  assert.match(dashboardSrc, /function renderNoteCell/,
    'every closed round must render a note cell');
  assert.match(dashboardSrc, /function editRoundNote/,
    'notes must be editable at any time, not just at close');
  assert.match(dashboardSrc, /<th>Notes<\/th>/,
    'the rounds table must have a dedicated Notes column');
  assert.match(dashboardHtml, /\.round-note \{/,
    'the note cell must be styled');

  // The seq-durability rule applies to notes too: a fill can land while the
  // note is being written, so the save annotates the FRESHEST state.
  // (D-22: the loadAll-then-saveState read-modify-write became
  // mutateState(), which re-reads fresh state INSIDE its retry loop and
  // re-applies the note on a concurrent seq bump instead of losing a write.)
  const saveBody = dashboardSrc.slice(dashboardSrc.indexOf('function editRoundNote'));
  assert.match(saveBody, /await mutateState\(\(fresh\) => \{[\s\S]*?if \(text\) target\.note = \{ text, t: Date\.now\(\) \};/,
    'saving a note must annotate the freshly read state so it can never clobber a fill');
  assert.match(saveBody, /else delete target\.note;/,
    'clearing the text must remove the note entirely');

  // And the AI coach must actually read what the trader wrote.
  assert.match(dashboardSrc, /engage with it directly/,
    'the coach system prompt must tell the model to engage with the note');
  assert.match(dashboardSrc, /Post-trade note \(written after the outcome\)/,
    'the note must be included in the coach prompt');
});

test('the leaderboard compares by return on bankroll, not absolute SOL', () => {
  const dashboardSrc = fs.readFileSync(path.join(ROOT, 'dashboard.js'), 'utf8');

  // ROI is derived from the wallet's BIRTH balance (D-06 anchor) in both
  // places a result is shown (the evidence card and the standings
  // placeholder) — editing the starting-balance setting mid-wallet must
  // never rewrite a live wallet's return.
  const roiHits = dashboardSrc.match(/\(stats\.realizedPnlSol \/ E\.anchorStartSol\(state, settings\)\) \* 100/g) || [];
  assert.ok(roiHits.length >= 2,
    'both the evidence card and the standings row must compute ROI on the birth-anchored bankroll');
  assert.ok(!/realizedPnlSol \/ settings\.balanceStartSol/.test(dashboardSrc),
    'no ROI site may divide by the live setting');
  assert.match(dashboardSrc, /% ROI/, 'the ROI figure must be shown next to absolute P&L');
  assert.match(dashboardSrc, /Declared starting bankroll/,
    'the bankroll itself must be displayed so the percentage is checkable');
  assert.match(dashboardSrc, /Bankroll travels with the record/,
    'the rationale must be stated where the leaderboard explains itself');
});

test('the AI coach explains itself when no endpoint is configured', () => {
  const dashboardSrc = fs.readFileSync(path.join(ROOT, 'dashboard.js'), 'utf8');

  // Since the SSRF revision the endpoint defaults to BLANK, so "AI not
  // working" usually means "not configured yet" — the test button must say
  // exactly that instead of pretending it tried something.
  const testHandler = dashboardSrc.slice(dashboardSrc.indexOf("'test-ai'"));
  assert.match(testHandler, /if \(!settingsNow\.aiEndpoint\)/,
    'the test button must short-circuit before any network attempt');
  assert.match(testHandler, /AI coach is off/,
    'an empty endpoint must be reported as the coach being off, with setup steps');

  assert.match(dashboardSrc, /Blank turns the AI coach off\./,
    'the settings form must explain what an empty endpoint means');
  assert.match(dashboardSrc, /No models reachable\. Check the endpoint URL/,
    'the failure message must name the usual causes (URL, service, local toggle)');
});

test('hiding the positions bar is a saved setting, not a per-page flag', () => {
  const engineSrc = fs.readFileSync(path.join(ROOT, 'engine.js'), 'utf8');
  const backgroundSrc = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  const contentSrc = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');

  assert.match(engineSrc, /positionsBarHidden: false/,
    'the engine default must carry the collapse state');
  assert.match(backgroundSrc, /positionsBarHidden: false/,
    'the background defaults must carry it too — the two defaults must stay in sync');
  assert.match(engineSrc, /if \(revision < 6\) \{\s*merged\.positionsBarHidden/,
    'revision 6 must migrate existing installs to the new key');

  assert.match(contentSrc, /function setBarHidden\(hidden\) \{[\s\S]*?store\.set\(\{ \[E\.STORAGE_KEYS\.settings\]: settings \}\)/,
    'collapsing or expanding must persist the choice to settings');
  // One read at boot, one in the settings watcher: both must derive the flag
  // from storage, never from page-local memory.
  const reads = contentSrc.match(/positionsBarHidden = settings\.positionsBarHidden === true;/g) || [];
  assert.equal(reads.length, 2,
    'both the boot path and the storage watcher must restore the saved state');
});

test('the attest chain is never truncated', () => {
  const contentSrc = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  const attestSrc = fs.readFileSync(path.join(ROOT, 'attest.js'), 'utf8');
  const backgroundSrc = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');

  // Reported defect: a 5000-link cap silently spliced the head off the chain.
  // verifyChain re-verifies from GENESIS and replayChain needs every fill, so
  // truncation made verification fail and derived P&L wrong for heavy traders
  // with nothing actually tampered. The chain must grow without bound — the
  // manifest grants unlimitedStorage, so retention is safe. Since F-14 the
  // chain lives in attest.js's segmented store behind the worker's single
  // writer, so the no-truncation scan covers the store code itself.
  assert.doesNotMatch(attestSrc, /chain\.length\s*>\s*5000/,
    'the 5000-link cap is what broke verifyChain and replayChain');
  assert.doesNotMatch(attestSrc, /splice\(0,/,
    'no head-splice of any kind may exist in the segment store');
  assert.match(attestSrc, /appendToChainStore/,
    'the segmented append is where retention is enforced now');

  // F-14: content.js must not hold the chain at all any more — a tab-local
  // copy is exactly the multi-tab race and O(lifetime) fill cost that was
  // removed. Fills travel to the worker's single writer instead.
  assert.doesNotMatch(contentSrc, /attestChain/,
    'a tab-local chain reintroduces the F-14 race and per-fill cost');
  assert.match(contentSrc, /sendMessage\(\{ type: 'pt_attest_append', trade \}\)/,
    'commitFill must hand the fill to the worker');
  assert.match(backgroundSrc, /case 'pt_attest_append':/,
    'the worker must own the append');
  assert.match(backgroundSrc, /'attest\.js'/,
    'the worker must import the chain store it writes');
});

test('popup backup/restore protects the wallet across reinstalls', () => {
  const popupJs = fs.readFileSync(path.join(ROOT, 'popup.js'), 'utf8');
  const popupHtml = fs.readFileSync(path.join(ROOT, 'popup.html'), 'utf8');

  // The backup must carry every storage key, or a restore silently drops data.
  for (const key of ['pt_state', 'pt_settings', 'pt_frames', 'pt_replays']) {
    assert.ok(popupJs.includes(key), `BACKUP_KEYS must include ${key}`);
  }
  // F-14: the attest chain lives in segmented storage, so the backup must
  // bundle it explicitly (as one array) and the restore must round-trip it —
  // a wallet whose verifiable record died in a reinstall defeats the point.
  assert.match(popupJs, /pt_attest_chain/,
    'the backup must carry the attestation chain');
  assert.match(popupJs, /readChainStore/,
    'the chain must be read from the segmented store, not from pt_state');
  assert.match(popupJs, /chainSegments\(chainLinks\)/,
    'restore must re-segment the bundled chain back into the store');
  assert.match(popupJs, /attestChain: stored\.pt_attest_chain/,
    'the backup pt_state must keep a legacy in-state copy — restoring on a '
    + 'pre-segmentation version must not silently lose the record');
  assert.match(popupHtml, /src="attest\.js"/,
    'the popup needs the chain helpers loaded before popup.js');
  assert.match(popupJs, /app: 'papertrench-backup'/,
    'the export envelope must be identifiable');
  assert.match(popupJs, /format: 1/, 'the envelope must be versioned for future migrations');

  // Restore must validate before writing — a foreign JSON must never clobber
  // the wallet.
  assert.match(popupJs, /data\.pt_state/, 'restore must check pt_state exists before writing');
  assert.match(popupJs, /confirm\(/, 'restore is destructive — it must ask first');

  assert.match(popupHtml, /id="backup"/, 'the backup button must exist in the popup');
  assert.match(popupHtml, /id="restore"/, 'the restore button must exist in the popup');
  assert.match(popupHtml, /type="file"/, 'restore needs a file picker');
});

test('fill errors reach the trader — withState no longer swallows them', () => {
  const contentSrc = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');

  // The reported defect: buy/sell buttons did nothing and showed no toast
  // when a fill failed (insufficient balance, token changed, storage error).
  // Root cause: withState returned the CAUGHT chain, so the throw never
  // reached the catch that toasts. The chain itself stays resilient, but the
  // caller must receive the real result or error.
  const fn = contentSrc.slice(
    contentSrc.indexOf('function withState('),
    contentSrc.indexOf('async function reloadState'));
  assert.ok(fn.length > 0, 'withState must be locatable');
  assert.doesNotMatch(fn, /mutationChain;\s*$/, 'must not return the caught chain directly');
  assert.match(fn, /return run/, 'the caller must get the un-caught promise');

  // And the buy/sell toasts must still be wired to that error.
  assert.match(contentSrc, /toast\(err\.message \|\| 'Buy failed'\)/);
  assert.match(contentSrc, /toast\(err\.message \|\| 'Sell failed'\)/);
});

test('quoteForTrade prices a fresh screen at the price on screen (F-33 → F-52)', () => {
  // F-33 established that the chain path CAN be systematically wrong (a
  // starved vault leg filled 13% under the Padre chart for a whole session),
  // so a fresh screen won the DIVERGENCE case. F-52 (superski) closed the
  // inconsistency that remained: inside the 6% agree band the chain still
  // overrode the number the trader clicked on, so recorded entries landed a
  // few percent above or below "the actual entry". The rule is now uniform —
  // an on-screen price inside the sub-second window prices the fill, and the
  // chain round trip is only paid when the screen is quiet.
  const contentSrc = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  const fnStart = contentSrc.indexOf('async function pickQuoteForTrade()');
  const block = contentSrc.slice(fnStart, contentSrc.indexOf('\n  }', fnStart) + 4);

  assert.match(block, /const screenFresh = atClick && atClickAge <= ONCHAIN_SCREEN_CHECK_MAX_AGE_MS/,
    'freshness is judged at click time, before any async hop');
  assert.match(contentSrc, /const ONCHAIN_SCREEN_CHECK_MAX_AGE_MS = 600/,
    'the fill-at-screen window must stay sub-second so a stale display never rides it');
  const screenReturnAt = block.indexOf('if (screenFresh) return atClick');
  const chainHopAt = block.indexOf('await R.onchainQuote');
  assert.ok(screenReturnAt !== -1, 'a fresh screen must fill at the on-screen price, unconditionally');
  assert.ok(chainHopAt !== -1 && screenReturnAt < chainHopAt,
    'the chain round trip must not even be paid when the screen is fresh');
});
