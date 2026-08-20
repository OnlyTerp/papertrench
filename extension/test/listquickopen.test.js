/* #29 — the chart tab after a list buy.
 *
 * Ask (8/9): "add instant open tab on quick buy? idk how this isent there
 * yet for new pairs" — a quick-buy chip fill on a screener list opens a NEW
 * position whose chart the user never saw. The fill tags itself
 * 'list-chip' on the summary copy (never the committed trade — the
 * attestation chain already hashed it), and background opens the site's
 * own chart URL in a background tab when the position is new.
 *
 * Uses the house service-worker harness shape (see background.test.js):
 * importScripts loads the REAL replay/quote/.../sites modules, so the
 * pt_trade_event handler runs its genuine code path. Observable channels
 * only: the message a content script would send, and the chrome.tabs.create
 * calls background makes in response.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

function serviceWorker(opts = {}) {
  const values = {
    pt_settings: { framesEnabled: false, recordingEnabled: false, autoReview: false },
    pt_state: { positions: {}, rounds: [], journal: [] },
  };
  let messageListener = null;
  const createdTabs = [];

  const get = (keys, callback) => {
    const names = Array.isArray(keys) ? keys : Object.keys(keys || {});
    const result = {};
    for (const name of names) if (Object.hasOwn(values, name)) result[name] = values[name];
    if (callback) { callback(result); return undefined; }
    return Promise.resolve(result);
  };
  const set = (update, callback) => {
    Object.assign(values, update);
    if (callback) callback();
    return Promise.resolve();
  };

  const sandbox = {
    console, Promise, JSON, Math, Date, Number, String, Array, Object, Boolean,
    RegExp, Error, Set, Map, URL, URLSearchParams, AbortController,
    Uint8Array, TextEncoder, crypto,
    setTimeout, clearTimeout, setInterval: () => 1, clearInterval: () => {},
    fetch: async () => { throw new Error('network disabled in test'); },
    chrome: {
      runtime: {
        id: 'pt-test-extension',
        lastError: null,
        openOptionsPage: () => {},
        onMessage: { addListener: (l) => { messageListener = l; } },
        onStartup: { addListener: () => {} },
        onInstalled: { addListener: () => {} },
        sendMessage: async () => ({}),
        getURL: (p) => 'chrome-extension://pt-test-extension/' + p,
      },
      storage: { local: { get, set }, onChanged: { addListener: () => {} } },
      tabs: {
        query: (q, callback) => callback([]),
        sendMessage: async () => ({}),
        create: (props) => { createdTabs.push(props); return Promise.resolve({ id: 99 }); },
        captureVisibleTab: async () => 'data:image/jpeg;base64,x',
        get: async (id) => ({ id, active: true, windowId: 3 }),
        onRemoved: { addListener: () => {} },
        onUpdated: { addListener: () => {} },
        onActivated: { addListener: () => {} },
      },
      windows: { update: async () => ({}) },
      offscreen: { hasDocument: async () => false, createDocument: async () => {} },
      alarms: { clear: async () => true, create: () => {}, onAlarm: { addListener: () => {} } },
      notifications: { create: () => {} },
    },
    navigator: { userAgent: 'node-test' },
    performance: { now: () => Date.now() },
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  const context = vm.createContext(sandbox);
  sandbox.importScripts = (...files) => {
    for (const file of files) {
      vm.runInContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), context, { filename: file });
    }
  };
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8'), context, { filename: 'background.js' });
  return {
    values, createdTabs, listener: () => messageListener,
    fire: (message, sender) => new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('handler timed out')), 2000);
      messageListener(message, sender || { tab: { id: 7 } }, (response) => {
        clearTimeout(timeout); resolve(response);
      });
    }),
  };
}

function chipBuy(overrides) {
  return Object.assign({
    type: 'pt_trade_event',
    kind: 'buy',
    opened: true,
    session: { mint: MINT, symbol: 'TEST' },
    trade: {
      id: 't1', sessionId: 's1', ts: Date.now(), side: 'buy',
      mint: MINT, symbol: 'TEST',
      site: 'axiom', pairAddress: null, chain: 'solana',
      source: 'list-chip',
      qty: 1000, priceNative: 0.000001, priceUsd: 0.00015,
      solGross: 0.1, solNet: 0.099, feeSol: 0.001, pnlSol: null, mcap: 150000,
    },
  }, overrides || {});
}

test('a list-chip buy that opens a position opens the chart tab, backgrounded', async () => {
  const worker = serviceWorker();
  await worker.fire(chipBuy());
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(worker.createdTabs.length, 1, 'exactly one chart tab opened');
  const tab = worker.createdTabs[0];
  assert.ok(tab.url.startsWith('https://'), 'real https url: ' + tab.url);
  assert.equal(tab.active, false, 'background tab — never focus-stealing');
});

test('panel buys (no list-chip source) never open a tab', async () => {
  const worker = serviceWorker();
  await worker.fire(chipBuy({ trade: Object.assign({}, chipBuy().trade, { source: null }) }));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(worker.createdTabs.length, 0, 'no tab for panel buys — their chart is on screen');
});

test('chip buys that only add to an existing position open no tab', async () => {
  const worker = serviceWorker();
  await worker.fire(chipBuy({ opened: false }));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(worker.createdTabs.length, 0, 'no tab for adds to existing positions');
});

test('sell events never open a tab, whatever their source', async () => {
  const worker = serviceWorker();
  await worker.fire(chipBuy({ kind: 'sell' }));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(worker.createdTabs.length, 0, 'sells never open tabs');
});

test('listQuickOpen=false keeps chip buys tab-silent', async () => {
  const worker = serviceWorker();
  worker.values.pt_settings.listQuickOpen = false;
  await worker.fire(chipBuy());
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(worker.createdTabs.length, 0, 'setting off = no tab, even for new positions');
});
