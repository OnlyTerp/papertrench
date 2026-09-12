/* predict-content boot locks (A6).
 *
 * The master switch lives in the EXTENSION's chrome.storage.local. Reading
 * venue localStorage instead means the toggle never works AND a hostile
 * venue page can flip extension configuration from its own origin.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function bootPredictContent({ chromeSettings, venueSettings }) {
  const mounted = { badge: 0, ticket: 0 };
  const sandbox = {
    console,
    JSON, Promise, isFinite,
    setTimeout, clearTimeout,
    setInterval: (fn, ms) => { const t = setInterval(fn, ms); if (t.unref) t.unref(); return t; },
    clearInterval,
    addEventListener() {},
    location: { href: 'https://kalshi.com/markets/kx/kalshi/kx-26dec31', hostname: 'kalshi.com' },
    document: {
      readyState: 'complete', title: 'Kalshi Test',
      body: { appendChild() { mounted.badge += 1; } },
      createElement: () => ({ style: {}, set textContent(v) { this._t = v; } }),
      addEventListener() {},
    },
    MutationObserver: function () { this.observe = () => {}; this.disconnect = () => {}; },
    localStorage: { getItem: () => (venueSettings === undefined ? null : JSON.stringify(venueSettings)) },
    chrome: {
      storage: {
        local: {
          get: (keys, cb) => setImmediate(() => cb(
            chromeSettings === undefined ? {} : { pt_settings: chromeSettings },
          )),
        },
      },
    },
    PaperPredictSites: { detect: () => ({ venue: 'kalshi', marketId: 'KX-TEST' }) },
    PaperPredictTicket: { mount() { mounted.ticket += 1; }, unmount() {} },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'predict-content.js'), 'utf8'), ctx, {
    filename: 'predict-content.js',
  });
  return (async () => {
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
    return mounted;
  })();
}

test('A6: overlayEnabled=false in extension storage prevents the mount', async () => {
  const m = await bootPredictContent({ chromeSettings: { overlayEnabled: false } });
  assert.equal(m.ticket, 0, 'a disabled overlay must not mount its ticket');
  assert.equal(m.badge, 0, 'a disabled overlay must not paint its badge');
});

test('A6: the overlay mounts when the switch is on or unset', async () => {
  for (const chromeSettings of [{ overlayEnabled: true }, undefined]) {
    const m = await bootPredictContent({ chromeSettings });
    assert.equal(m.ticket, 1, `ticket mounts (settings ${JSON.stringify(chromeSettings)})`);
    assert.equal(m.badge, 1, `badge paints (settings ${JSON.stringify(chromeSettings)})`);
  }
});

test('A6: venue localStorage cannot flip the extension switch', async () => {
  // The venue page writes pt_settings into ITS OWN origin storage trying to
  // kill the overlay. The extension must not even look there.
  const m = await bootPredictContent({
    chromeSettings: { overlayEnabled: true },
    venueSettings: { overlayEnabled: false },
  });
  assert.equal(m.ticket, 1, 'venue-origin storage must be ignored entirely');
});

/* B6: SPA re-detect without a subtree MutationObserver. The observer woke on
 * every DOM mutation of high-churn venue SPAs just to compare one string.
 * Navigation events + a 1s URL poll catch every route change the observer
 * did, at ~zero cost (the token side's own doctrine: events + poll backstop).
 */
function bootForNav() {
  const listeners = {};
  let unmounted = 0;
  const sandbox = {
    console, JSON, Promise,
    setTimeout, clearTimeout,
    setInterval: (fn, ms) => { const t = setInterval(fn, ms); if (t.unref) t.unref(); sandbox._poll = fn; return t; },
    clearInterval,
    location: { href: 'https://kalshi.com/markets/a/b/c', hostname: 'kalshi.com' },
    document: {
      readyState: 'complete', title: 'T', body: { appendChild() {} },
      createElement: () => ({ style: {} }), addEventListener() {},
    },
    // NOTE: no MutationObserver. Booting without one is the point.
    localStorage: { getItem: () => null },
    chrome: { storage: { local: { get: (keys, cb) => setImmediate(() => cb({})), set() {} } } },
    PaperPredictSites: { detect: () => ({ venue: 'kalshi', marketId: 'KX' }) },
    PaperPredictTicket: { mount() {}, unmount() { unmounted += 1; } },
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'predict-content.js'), 'utf8'), ctx, { filename: 'predict-content.js' });
  return { sandbox, listeners, unmounted: () => unmounted };
}

test('B6: the content script boots with no MutationObserver anywhere near it', async () => {
  const { listeners, sandbox } = bootForNav();
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
  assert.ok((listeners.popstate || []).length >= 1, 'popstate re-detect is wired');
  assert.ok((listeners.hashchange || []).length >= 1, 'hashchange re-detect is wired');
  assert.equal(typeof sandbox._poll, 'function', 'a poll backstop catches pushState navs the events miss');
});

test('B6: a route change remounts; a quiet poll does not', async () => {
  const { sandbox, listeners, unmounted } = bootForNav();
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
  sandbox._poll();
  assert.equal(unmounted(), 0, 'no URL change, no remount');
  sandbox.location.href = 'https://kalshi.com/markets/x/y/z';
  for (const fn of listeners.popstate) fn();
  assert.equal(unmounted(), 1, 'a route change remounts the overlay');
  sandbox.location.href = 'https://kalshi.com/markets/p/q/r';
  sandbox._poll();
  assert.equal(unmounted(), 2, 'the poll catches navs no event fired for');
});
