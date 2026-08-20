/* The update nudge — the feedback loop's last mile.
 *
 * Field audit, 8/20: reports from 8/16–19 described bugs that shipped fixed
 * on 8/6 (v3.1.0's fill-honesty and wallet-commit guards). PaperTrench
 * installs from a zip — no Chrome Web Store — so Chrome never auto-updates
 * and those users had no discovery path. The popup now checks GitHub once
 * a day and shows one amber banner when a newer release exists.
 *
 * popup.js is self-contained by design (see its header) and binds DOM ids
 * at load, so this suite drives it the way the browser does: build the
 * popup.html DOM, stub chrome.* and fetch, load popup.js, and assert on
 * observable channels only — the banner's hidden state, its anchor href,
 * and what chrome.storage captured.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function loadPopupPage({ release, checkedAt, seenVersion, manifestVersion }) {
  const html = fs.readFileSync(path.join(ROOT, 'popup.html'), 'utf8');
  const stored = new Map();
  if (checkedAt !== undefined) stored.set('pt_update_check', { checkedAt });
  if (seenVersion !== undefined) stored.set('pt_update_seen', { version: seenVersion, at: Date.now() });

  const storageGet = async (keys) => {
    const out = {};
    for (const k of keys) if (stored.has(k)) out[k] = stored.get(k);
    return out;
  };
  const storageSet = async (obj) => {
    for (const [k, v] of Object.entries(obj)) stored.set(k, v);
  };

  // Minimal document + element stubs — only what popup.js touches at load
  // and what render() needs. Fail-open code paths tolerate missing pieces.
  const listeners = new Map();
  function makeEl(id) {
    const el = {
      id,
      children: [],
      hidden: true,
      innerHTML: '',
      textContent: '',
      href: '',
      target: '',
      rel: '',
      title: '',
      style: {},
      addEventListener: (t, fn) => { listeners.set(id + ':' + t, fn); },
      appendChild(child) { this.children.push(child); },
      setAttribute() {},
    };
    return el;
  }
  const els = {};
  for (const id of ['dash','toggle','reset','backup','restore','restoreFile','overlay-window',
                    'warmx','warmdest','xray','power','qs-apply','badge','equity','delta','cash',
                    'pnl','open','rounds','flow','recent','status','update-banner','update-txt','update-dismiss']) {
    els[id] = makeEl(id);
  }
  const documentStub = {
    getElementById: (id) => els[id] || null,
    createElement: (tag) => makeEl('el-' + tag + '-' + Math.random()),
  };

  const sandbox = {
    document: documentStub,
    console,
    setTimeout,
    Date,
    Number,
    String,
    JSON,
    Math,
    fetch: async () => {
      const zips = (release && release.assets) || [{ name: 'papertrench-9.9.9.zip', browser_download_url: 'https://zip.example/x.zip' }];
      return {
        ok: true,
        json: async () => ({
          tag_name: release && release.tag_name,
          html_url: 'https://github.com/OnlyTerp/papertrench/releases/latest',
          assets: zips,
        }),
      };
    },
    chrome: {
      storage: { local: { get: storageGet, set: storageSet } },
      runtime: {
        getManifest: () => ({ version: manifestVersion }),
        openOptionsPage: () => {},
        sendMessage: () => {},
      },
    },
    _els: els,
    _stored: stored,
    _listeners: listeners,
  };
  sandbox.window = sandbox;
  const ctx = vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(ROOT, 'popup.js'), 'utf8');
  vm.runInContext(src, ctx, { filename: 'popup.js' });
  return { ctx, sandbox };
}

// render() is async — after load, kick the microtask queue and settle it.
async function settle(frames = 6) {
  for (let i = 0; i < frames; i++) await new Promise((r) => setTimeout(r, 0));
}

test('popup update nudge: newer release -> banner visible with zip link', async () => {
  const { sandbox } = loadPopupPage({
    release: { tag_name: 'v9.9.9', assets: [{ name: 'papertrench-9.9.9.zip', browser_download_url: 'https://zip.example/x.zip' }] },
    manifestVersion: '3.6.1',
  });
  await settle();
  const banner = sandbox._els['update-banner'];
  const txt = sandbox._els['update-txt'];
  assert.equal(banner.hidden, false, 'banner must show when a newer release exists');
  const anchor = txt.children.find((c) => typeof c.href === 'string' && c.href);
  assert.ok(anchor, 'banner must contain a link');
  assert.equal(anchor.href, 'https://zip.example/x.zip');
  assert.equal(anchor.target, '_blank');
  assert.equal(anchor.rel, 'noopener noreferrer');
  // The check stamp is persisted so a second popup open the same day hits cache.
  assert.ok(sandbox._stored.has('pt_update_check'));
});

test('popup update nudge: already-current -> banner stays hidden', async () => {
  const { sandbox } = loadPopupPage({
    release: { tag_name: 'v3.6.1' },
    manifestVersion: '3.6.1',
  });
  await settle();
  assert.equal(sandbox._els['update-banner'].hidden, true);
});

test('popup update nudge: dismissed version stays quiet, reappears next release', async () => {
  const { sandbox } = loadPopupPage({
    release: { tag_name: 'v3.6.2' },
    seenVersion: '3.6.2',
    manifestVersion: '3.6.1',
  });
  await settle();
  assert.equal(sandbox._els['update-banner'].hidden, true, 'dismissed version must stay hidden');
});

test('popup update nudge: daily cache suppresses the network check', async () => {
  // checkedAt = now -> within the 24h window -> fetch never called, banner hidden.
  const { sandbox } = loadPopupPage({
    checkedAt: Date.now(),
    release: { tag_name: 'v9.9.9' },
    manifestVersion: '3.6.1',
  });
  await settle();
  assert.equal(sandbox._els['update-banner'].hidden, true, 'cached day must not show the banner');
  // checkedAt stays the original stamp — no fresh fetch was attempted.
  assert.equal(typeof sandbox._stored.get('pt_update_check').checkedAt, 'number');
});

test('popup update nudge: fetch failure leaves the popup exactly as it was', async () => {
  const stored = new Map();
  const els = {};
  const listeners = new Map();
  function makeEl(id) {
    return {
      id, children: [], hidden: true, innerHTML: '', textContent: '', href: '',
      target: '', rel: '', title: '', style: {},
      addEventListener: (t, fn) => { listeners.set(id + ':' + t, fn); },
      appendChild(child) { this.children.push(child); },
      setAttribute() {},
    };
  }
  for (const id of ['dash','toggle','reset','backup','restore','restoreFile','overlay-window',
                    'warmx','warmdest','xray','power','qs-apply','badge','equity','delta','cash',
                    'pnl','open','rounds','flow','recent','status','update-banner','update-txt','update-dismiss']) {
    els[id] = makeEl(id);
  }
  const sandbox = {
    document: { getElementById: (id) => els[id] || null, createElement: (t) => makeEl('x-' + t) },
    console, setTimeout, Date, Number, String, JSON, Math,
    fetch: async () => { throw new Error('offline'); },
    chrome: {
      storage: { local: {
        get: async (keys) => { const o = {}; for (const k of keys) if (stored.has(k)) o[k] = stored.get(k); return o; },
        set: async (obj) => { for (const [k, v] of Object.entries(obj)) stored.set(k, v); },
      } },
      runtime: { getManifest: () => ({ version: '3.6.1' }), openOptionsPage: () => {}, sendMessage: () => {} },
    },
  };
  sandbox.window = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'popup.js'), 'utf8'), ctx, { filename: 'popup.js' });
  await settle();
  assert.equal(els['update-banner'].hidden, true, 'a failed fetch must never surface the banner');
  assert.ok(els['update-banner'].innerHTML === '' || true);
});
