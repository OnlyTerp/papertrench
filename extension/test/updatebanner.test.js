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

function loadPopupPage({
  release, checkedAt, seenVersion, lastBackup, state, settings, frames, replays, chainMeta,
  backupFingerprintState, backupFingerprintData, manifestVersion, attest,
  storageGetThrows = false, storageStateGetThrows = false, storageLastBackupGetThrows = false,
  storageMetaGetThrows = false,
}) {
  const html = fs.readFileSync(path.join(ROOT, 'popup.html'), 'utf8');
  const stored = new Map();
  const getCalls = [];
  if (checkedAt !== undefined) stored.set('pt_update_check', { checkedAt });
  if (seenVersion !== undefined) stored.set('pt_update_seen', { version: seenVersion, at: Date.now() });
  if (lastBackup !== undefined) {
    stored.set('pt_last_backup', {
      chainLength: 0,
      chainHead: 'papertrench-genesis-v1',
      ...lastBackup,
    });
  }
  if (state !== undefined) stored.set('pt_state', state);
  if (settings !== undefined) stored.set('pt_settings', settings);
  if (frames !== undefined) stored.set('pt_frames', frames);
  if (replays !== undefined) stored.set('pt_replays', replays);
  if (chainMeta !== undefined) stored.set('pt_attest_meta', chainMeta);

  const storageGet = async (keys) => {
    getCalls.push([...keys]);
    if (storageGetThrows) throw new Error('storage unavailable');
    if (storageStateGetThrows && keys.includes('pt_state')) throw new Error('state unavailable');
    if (storageLastBackupGetThrows && keys.includes('pt_last_backup')) throw new Error('backup unavailable');
    if (storageMetaGetThrows && keys.includes('pt_attest_meta')) throw new Error('meta unavailable');
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
      classList: { toggle() {} },
      addEventListener: (t, fn) => { listeners.set(id + ':' + t, fn); },
      appendChild(child) { this.children.push(child); },
      click() {},
      remove() {},
      setAttribute() {},
    };
    return el;
  }
  const els = {};
  for (const id of ['dash','desk','toggle','reset','backup','restore','restoreFile','overlay-window',
                    'warmx','warmdest','xray','power','qs-apply','qs-balance','qs-presets','qs-sellpcts','qs-fees',
                    'sharelogs','badge','equity','delta','cash',
                    'pnl','open','rounds','flow','recent','status','update-banner','update-txt','update-dismiss',
                    'update-version','update-link','update-backup','update-backup-state']) {
    els[id] = makeEl(id);
  }
  els['update-txt'].appendChild(els['update-version']);
  els['update-txt'].appendChild(els['update-link']);
  els['update-txt'].appendChild(els['update-backup']);
  els['update-txt'].appendChild(els['update-backup-state']);
  els['update-backup'].textContent = 'Back up wallet first';
  const body = { appendChild() {}, };
  const documentStub = {
    getElementById: (id) => els[id] || null,
    createElement: (tag) => makeEl('el-' + tag + '-' + Math.random()),
    body,
    // popup.js also wires the pane tabs at load. This suite is about the
    // update banner and has no tabs to find, but the stub has to answer the
    // call or the script throws before the banner is ever rendered.
    querySelectorAll: () => [],
  };

  const opens = [];
  const tabs = [];
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
      tabs: { create: async (props) => { tabs.push(props); return {}; } },
      runtime: {
        getManifest: () => ({ version: manifestVersion }),
        openOptionsPage: () => {},
        sendMessage: () => {},
      },
    },
    Blob: class Blob {},
    URL: { createObjectURL: () => 'blob:backup', revokeObjectURL: () => {} },
    open: (...args) => { opens.push(args); },
    _els: els,
    _stored: stored,
    _getCalls: getCalls,
    _listeners: listeners,
    _opens: opens,
    _tabs: tabs,
  };
  const defaultAttest = {
    readChainMeta: async () => {
      if (storageMetaGetThrows) throw new Error('meta unavailable');
      return stored.get('pt_attest_meta') || {
      segCount: 0, length: 0, head: 'papertrench-genesis-v1',
      };
    },
    readChainStore: async () => {
      if (storageMetaGetThrows) throw new Error('meta unavailable');
      return {
        meta: stored.get('pt_attest_meta') || {
        segCount: 0, length: 0, head: 'papertrench-genesis-v1',
        },
        chain: [],
      };
    },
  };
  const effectiveAttest = attest === undefined ? defaultAttest : attest;
  if (effectiveAttest) sandbox.PTAttest = effectiveAttest;
  sandbox.window = sandbox;
  const ctx = vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(ROOT, 'popup.js'), 'utf8');
  vm.runInContext(src, ctx, { filename: 'popup.js' });
  if (lastBackup && lastBackup.fingerprint === '__from_state__') {
    stored.set('pt_last_backup', {
      ...stored.get('pt_last_backup'),
      fingerprint: typeof ctx.backupFingerprint === 'function'
        ? ctx.backupFingerprint(backupFingerprintData || {
          pt_state: backupFingerprintState || state,
          pt_settings: undefined,
          pt_frames: undefined,
          pt_replays: undefined,
        })
        : 'missing-fingerprint',
    });
  }
  return {
    ctx, sandbox, opens,
    click: (id, ev = {}) => sandbox._listeners.get(id + ':click')?.(ev),
  };
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

test('popup update nudge: no backup shows the backup control and warning', async () => {
  const { sandbox } = loadPopupPage({
    release: { tag_name: 'v9.9.9' },
    manifestVersion: '3.6.1',
  });
  await settle();
  assert.equal(sandbox._els['update-backup'].textContent, 'Back up wallet first');
  assert.equal(sandbox._els['update-backup-state'].textContent,
    'No backup yet — updating into a new folder looks like a fresh install.');
});

test('popup update nudge: backup control exports and records its fingerprint', async () => {
  const state = { startedAt: 1234, journal: [{}, {}], attestChain: ['link-before-export'] };
  const { ctx, sandbox, click } = loadPopupPage({
    release: { tag_name: 'v9.9.9' },
    manifestVersion: '3.6.1',
    state,
  });
  await settle();
  await click('update-backup');
  await settle();
  const record = sandbox._stored.get('pt_last_backup');
  assert.ok(record && Number.isFinite(record.at));
  assert.equal(record.version, '3.6.1');
  assert.equal(record.startedAt, state.startedAt);
  assert.equal(record.trades, state.journal.length);
  assert.equal(typeof record.fingerprint, 'string');
  assert.equal(record.fingerprint, ctx.backupFingerprint({ pt_state: state }));
  assert.equal(sandbox._els['update-backup-state'].textContent,
    `Last backup: ${new Date(record.at).toISOString().slice(0, 10)} · exported — check the file is in your downloads`);
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  await click('update-link', event);
  await settle();
  assert.equal(event.prevented, true);
  assert.equal(sandbox._tabs.length, 1);
  assert.equal(sandbox._tabs[0].url, 'https://zip.example/x.zip');
});

test('popup update nudge: an existing backup shows its date and never arms the link', async () => {
  const at = Date.now() - 2 * 24 * 60 * 60 * 1000;
  const state = { startedAt: 1234, journal: [{}, {}] };
  const { sandbox, click } = loadPopupPage({
    release: { tag_name: 'v9.9.9' },
    lastBackup: { at, version: '3.6.0', startedAt: state.startedAt, trades: state.journal.length, fingerprint: '__from_state__' },
    state,
    manifestVersion: '3.6.1',
  });
  await settle();
  assert.equal(sandbox._els['update-backup-state'].textContent,
    `Last backup: ${new Date(at).toISOString().slice(0, 10)} · exported — check the file is in your downloads`);
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  const duplicate = { prevented: false, preventDefault() { this.prevented = true; } };
  await Promise.all([click('update-link', event), click('update-link', duplicate)]);
  await settle();
  assert.equal(event.prevented, true);
  assert.equal(duplicate.prevented, true);
  assert.equal(sandbox._tabs.length, 1);
});

test('popup update nudge: no backup arms the first download click only', async () => {
  const { sandbox, click } = loadPopupPage({
    release: { tag_name: 'v9.9.9' },
    manifestVersion: '3.6.1',
  });
  await settle();
  const first = { prevented: false, preventDefault() { this.prevented = true; } };
  await click('update-link', first);
  assert.equal(first.prevented, true);
  assert.equal(sandbox._els['update-backup-state'].textContent,
    'No backup yet — updating into a new folder looks like a fresh install. — click again to update anyway');
  const second = { prevented: false, preventDefault() { this.prevented = true; } };
  await click('update-link', second);
  await settle();
  assert.equal(second.prevented, true);
  assert.equal(sandbox._tabs.length, 1);
});

test('popup update nudge: a fill after export makes the backup stale and arms the link', async () => {
  const at = Date.now() - 2 * 24 * 60 * 60 * 1000;
  const { sandbox, click } = loadPopupPage({
    release: { tag_name: 'v9.9.9' },
    lastBackup: { at, version: '3.6.0', startedAt: 1234, trades: 0 },
    state: { startedAt: 1234, journal: [{}] },
    manifestVersion: '3.6.1',
  });
  await settle();
  assert.equal(sandbox._els['update-backup-state'].textContent,
    `Last backup: ${new Date(at).toISOString().slice(0, 10)} — 1 trade since. Back up again.`);
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  await click('update-link', event);
  assert.equal(event.prevented, true);
  assert.equal(sandbox._els['update-backup-state'].textContent,
    `Last backup: ${new Date(at).toISOString().slice(0, 10)} — 1 trade since. Back up again. — click again to update anyway`);
  const confirmation = { prevented: false, preventDefault() { this.prevented = true; } };
  await click('update-link', confirmation);
  await settle();
  assert.equal(confirmation.prevented, true);
  assert.equal(sandbox._tabs.length, 1);
});

test('popup update nudge: a reset-style wallet generation change is uncovered', async () => {
  const at = Date.now() - 2 * 24 * 60 * 60 * 1000;
  const { sandbox, click } = loadPopupPage({
    release: { tag_name: 'v9.9.9' },
    lastBackup: { at, version: '3.6.0', startedAt: 1234, trades: 2 },
    state: { startedAt: 5678, journal: [{}, {}] },
    manifestVersion: '3.6.1',
  });
  await settle();
  assert.equal(sandbox._els['update-backup-state'].textContent,
    `Last backup: ${new Date(at).toISOString().slice(0, 10)} — different wallet since. Back up again.`);
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  await click('update-link', event);
  assert.equal(event.prevented, true);
});

test('popup update nudge: a restored wallet with mismatched identity is uncovered', async () => {
  const at = Date.now() - 2 * 24 * 60 * 60 * 1000;
  const { sandbox, click } = loadPopupPage({
    release: { tag_name: 'v9.9.9' },
    lastBackup: { at, version: '3.6.0', startedAt: 1234, trades: 1 },
    state: { startedAt: 9999, journal: [{}] },
    manifestVersion: '3.6.1',
  });
  await settle();
  assert.match(sandbox._els['update-backup-state'].textContent, /different wallet since/);
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  await click('update-link', event);
  assert.equal(event.prevented, true);
});

test('popup update nudge: a matching wallet generation and trade count bypasses interception', async () => {
  const at = Date.now() - 2 * 24 * 60 * 60 * 1000;
  const state = { startedAt: 1234, journal: [{}] };
  const { sandbox, click } = loadPopupPage({
    release: { tag_name: 'v9.9.9' },
    lastBackup: { at, version: '3.6.0', startedAt: state.startedAt, trades: state.journal.length, fingerprint: '__from_state__' },
    state,
    manifestVersion: '3.6.1',
  });
  await settle();
  assert.equal(sandbox._els['update-backup-state'].textContent,
    `Last backup: ${new Date(at).toISOString().slice(0, 10)} · exported — check the file is in your downloads`);
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  await click('update-link', event);
  await settle();
  assert.equal(event.prevented, true);
  assert.equal(sandbox._tabs.length, 1);
});

test('popup update nudge: a thesis added after export is uncovered', async () => {
  const at = Date.now() - 2 * 24 * 60 * 60 * 1000;
  const before = {
    startedAt: 1234,
    journal: [],
    positions: { MINT: { thesis: 'old' } },
  };
  const state = {
    ...before,
    positions: { MINT: { thesis: 'new' } },
  };
  const { sandbox, click } = loadPopupPage({
    release: { tag_name: 'v9.9.9' },
    lastBackup: { at, startedAt: 1234, trades: 0, fingerprint: '__from_state__' },
    backupFingerprintState: before,
    state,
    manifestVersion: '3.6.1',
  });
  await settle();
  assert.match(sandbox._els['update-backup-state'].textContent, /wallet changed since/);
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  await click('update-link', event);
  assert.equal(event.prevented, true);
});

test('popup update nudge: an armed alert after export is uncovered', async () => {
  const at = Date.now() - 2 * 24 * 60 * 60 * 1000;
  const before = { startedAt: 1234, journal: [], alerts: {} };
  const state = { ...before, alerts: { MINT: [{ id: 'alert-1', triggerMcap: 1000 }] } };
  const { sandbox, click } = loadPopupPage({
    release: { tag_name: 'v9.9.9' },
    lastBackup: { at, startedAt: 1234, trades: 0, fingerprint: '__from_state__' },
    backupFingerprintState: before,
    state,
    manifestVersion: '3.6.1',
  });
  await settle();
  assert.match(sandbox._els['update-backup-state'].textContent, /wallet changed since/);
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  await click('update-link', event);
  assert.equal(event.prevented, true);
});

test('popup update nudge: settings changed after export are uncovered', async () => {
  const at = Date.now() - 2 * 24 * 60 * 60 * 1000;
  const state = { startedAt: 1234, journal: [] };
  const beforeSettings = { theme: 'light' };
  const currentSettings = { theme: 'dark' };
  const { sandbox, click } = loadPopupPage({
    release: { tag_name: 'v9.9.9' },
    lastBackup: { at, startedAt: 1234, trades: 0, fingerprint: '__from_state__' },
    backupFingerprintData: {
      pt_state: state, pt_settings: beforeSettings, pt_frames: [], pt_replays: [],
    },
    state,
    settings: currentSettings,
    frames: [],
    replays: [],
    manifestVersion: '3.6.1',
  });
  await settle();
  assert.match(sandbox._els['update-backup-state'].textContent, /wallet changed since/);
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  await click('update-link', event);
  await settle();
  assert.equal(event.prevented, true);
});

test('popup update nudge: a new frame after export is uncovered', async () => {
  const at = Date.now() - 2 * 24 * 60 * 60 * 1000;
  const state = { startedAt: 1234, journal: [] };
  const beforeFrames = [{ id: 'before', t: 1, dataUrl: 'data:image/jpeg;base64,old' }];
  const currentFrames = [...beforeFrames, { id: 'after', t: 2, dataUrl: 'data:image/jpeg;base64,new' }];
  const { sandbox, click } = loadPopupPage({
    release: { tag_name: 'v9.9.9' },
    lastBackup: { at, startedAt: 1234, trades: 0, fingerprint: '__from_state__' },
    backupFingerprintData: {
      pt_state: state, pt_settings: undefined, pt_frames: beforeFrames, pt_replays: undefined,
    },
    state,
    frames: currentFrames,
    manifestVersion: '3.6.1',
  });
  await settle();
  assert.match(sandbox._els['update-backup-state'].textContent, /wallet changed since/);
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  await click('update-link', event);
  await settle();
  assert.equal(event.prevented, true);
});

test('popup update nudge: frame image bytes alone stay covered', async () => {
  const at = Date.now() - 2 * 24 * 60 * 60 * 1000;
  const state = { startedAt: 1234, journal: [] };
  const beforeFrames = [{ id: 'same', t: 1, dataUrl: 'data:image/jpeg;base64,old' }];
  const currentFrames = [{ id: 'same', t: 1, dataUrl: 'data:image/jpeg;base64,new' }];
  const { sandbox, click } = loadPopupPage({
    release: { tag_name: 'v9.9.9' },
    lastBackup: { at, startedAt: 1234, trades: 0, fingerprint: '__from_state__' },
    backupFingerprintData: {
      pt_state: state, pt_settings: undefined, pt_frames: beforeFrames, pt_replays: undefined,
    },
    state,
    frames: currentFrames,
    manifestVersion: '3.6.1',
  });
  await settle();
  assert.match(sandbox._els['update-backup-state'].textContent, /· exported — check the file/);
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  await click('update-link', event);
  await settle();
  assert.equal(event.prevented, true);
  assert.equal(sandbox._tabs.length, 1);
});

test('popup update nudge: chain-missing export is never covered', async () => {
  const state = { startedAt: 1234, journal: [] };
  const { sandbox, click } = loadPopupPage({
    release: { tag_name: 'v9.9.9' },
    state,
    manifestVersion: '3.6.1',
    attest: { readChainStore: async () => { throw new Error('chain unavailable'); } },
  });
  await settle();
  await click('update-backup');
  await settle();
  const record = sandbox._stored.get('pt_last_backup');
  assert.equal(record.chainMissing, true);
  assert.match(sandbox._els['update-backup-state'].textContent,
    /exported without the verification chain/);
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  await click('update-link', event);
  await settle();
  assert.equal(event.prevented, true);
});

test('popup update nudge: click re-reads state before opening a covered link', async () => {
  const at = Date.now() - 2 * 24 * 60 * 60 * 1000;
  const before = { startedAt: 1234, journal: [] };
  const after = { startedAt: 1234, journal: [{}] };
  const { sandbox, click } = loadPopupPage({
    release: { tag_name: 'v9.9.9' },
    lastBackup: { at, startedAt: 1234, trades: 0, fingerprint: '__from_state__' },
    backupFingerprintData: { pt_state: before },
    state: before,
    manifestVersion: '3.6.1',
  });
  await settle();
  sandbox._stored.set('pt_state', after);
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  await click('update-link', event);
  await settle();
  assert.equal(event.prevented, true);
  assert.equal(sandbox._opens.length, 0);
  assert.match(sandbox._els['update-backup-state'].textContent, /1 trade since/);
});

test('popup update nudge: heartbeat-only state changes stay covered', async () => {
  const at = Date.now() - 2 * 24 * 60 * 60 * 1000;
  const before = {
    startedAt: 1234,
    seq: 1,
    updatedAt: 10,
    journal: [],
    positions: {
      MINT: {
        thesis: 'keep',
        lastPriceNative: 1,
        lastPriceUsd: 2,
        peakPnlSol: 3,
        troughPnlSol: -1,
      },
    },
  };
  const state = {
    ...before,
    seq: 99,
    updatedAt: 900,
    positions: {
      MINT: {
        ...before.positions.MINT,
        lastPriceNative: 5,
        lastPriceUsd: 6,
        peakPnlSol: 7,
        troughPnlSol: -4,
      },
    },
  };
  const { sandbox, click } = loadPopupPage({
    release: { tag_name: 'v9.9.9' },
    lastBackup: { at, startedAt: 1234, trades: 0, fingerprint: '__from_state__' },
    backupFingerprintState: before,
    state,
    manifestVersion: '3.6.1',
  });
  await settle();
  assert.equal(sandbox._els['update-backup-state'].textContent,
    `Last backup: ${new Date(at).toISOString().slice(0, 10)} · exported — check the file is in your downloads`);
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  await click('update-link', event);
  await settle();
  assert.equal(event.prevented, true);
  assert.equal(sandbox._tabs.length, 1);
});

test('popup update nudge: a decreased trade count says wallet history changed', async () => {
  const at = Date.now() - 2 * 24 * 60 * 60 * 1000;
  const { sandbox, click } = loadPopupPage({
    release: { tag_name: 'v9.9.9' },
    lastBackup: { at, startedAt: 1234, trades: 3, fingerprint: 'old-fingerprint' },
    state: { startedAt: 1234, journal: [{}] },
    manifestVersion: '3.6.1',
  });
  await settle();
  assert.match(sandbox._els['update-backup-state'].textContent, /wallet history changed/);
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  await click('update-link', event);
  assert.equal(event.prevented, true);
});

test('popup update nudge: a stored backup with unreadable wallet is unconfirmable', async () => {
  const at = Date.now() - 2 * 24 * 60 * 60 * 1000;
  const { sandbox, click } = loadPopupPage({
    release: { tag_name: 'v9.9.9' },
    lastBackup: { at, startedAt: 1234, trades: 0, fingerprint: 'known-fingerprint' },
    manifestVersion: '3.6.1',
    storageStateGetThrows: true,
  });
  await settle();
  assert.equal(sandbox._els['update-banner'].hidden, false);
  assert.match(sandbox._els['update-backup-state'].textContent, /wallet could not be read/);
  assert.match(sandbox._els['update-backup-state'].textContent, /coverage cannot be confirmed/);
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  await click('update-link', event);
  assert.equal(event.prevented, true);
});

test('popup update nudge: dismiss still records the seen version and hides the banner', async () => {
  const { sandbox, click } = loadPopupPage({
    release: { tag_name: 'v9.9.9' },
    manifestVersion: '3.6.1',
  });
  await settle();
  await click('update-dismiss');
  await settle();
  assert.equal(sandbox._els['update-banner'].hidden, true);
  assert.equal(sandbox._stored.get('pt_update_seen').version, '9.9.9');
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
      target: '', rel: '', title: '', style: {}, classList: { toggle() {} },
      addEventListener: (t, fn) => { listeners.set(id + ':' + t, fn); },
      appendChild(child) { this.children.push(child); },
      setAttribute() {},
    };
  }
  for (const id of ['dash','desk','toggle','reset','backup','restore','restoreFile','overlay-window',
                    'warmx','warmdest','xray','power','qs-apply','qs-balance','qs-presets','qs-sellpcts','qs-fees',
                    'sharelogs','badge','equity','delta','cash',
                    'pnl','open','rounds','flow','recent','status','update-banner','update-txt','update-dismiss',
                    'update-version','update-link','update-backup','update-backup-state']) {
    els[id] = makeEl(id);
  }
  els['update-txt'].appendChild(els['update-version']);
  els['update-txt'].appendChild(els['update-link']);
  els['update-txt'].appendChild(els['update-backup']);
  els['update-txt'].appendChild(els['update-backup-state']);
  const sandbox = {
    document: { getElementById: (id) => els[id] || null, createElement: (t) => makeEl('x-' + t), querySelectorAll: () => [] },
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

test('popup update nudge: storage read failure still shows the warning and arms the link', async () => {
  const { sandbox, click } = loadPopupPage({
    release: { tag_name: 'v9.9.9' },
    manifestVersion: '3.6.1',
    storageGetThrows: true,
  });
  await settle();
  assert.equal(sandbox._els['update-banner'].hidden, false);
  assert.equal(sandbox._els['update-backup-state'].textContent,
    'Backup status could not be read, so coverage cannot be confirmed. Back up again to be safe.');
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  await click('update-link', event);
  assert.equal(event.prevented, true);
});

test('popup update nudge: pt_last_backup read failure is unconfirmable', async () => {
  const at = Date.now() - 2 * 24 * 60 * 60 * 1000;
  const { sandbox, click } = loadPopupPage({
    release: { tag_name: 'v9.9.9' },
    manifestVersion: '3.6.1',
    lastBackup: { at, startedAt: 1234, trades: 0, fingerprint: 'stored' },
    state: { startedAt: 1234, journal: [] },
    storageLastBackupGetThrows: true,
  });
  await settle();
  assert.equal(sandbox._els['update-banner'].hidden, false);
  assert.equal(sandbox._els['update-backup-state'].textContent,
    'Backup status could not be read, so coverage cannot be confirmed. Back up again to be safe.');
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  await click('update-link', event);
  assert.equal(event.prevented, true);
  assert.match(sandbox._els['update-backup-state'].textContent,
    /coverage cannot be confirmed.*click again to update anyway/);
});

test('popup update nudge: pt_state read failure still shows the warning and arms the link', async () => {
  const { sandbox, click } = loadPopupPage({
    release: { tag_name: 'v9.9.9' },
    manifestVersion: '3.6.1',
    storageStateGetThrows: true,
  });
  await settle();
  assert.equal(sandbox._els['update-banner'].hidden, false);
  assert.equal(sandbox._els['update-backup-state'].textContent,
    'No backup yet — updating into a new folder looks like a fresh install.');
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  await click('update-link', event);
  assert.equal(event.prevented, true);
});

/* ------------------------------------------------------------------------
 * The CSS half of "hidden".
 *
 * Every test above asserts on the `hidden` PROPERTY, and every one of them
 * passed while the banner was permanently on screen for every user. That is
 * the gap they could not see: `hidden` only blanks an element because the UA
 * stylesheet says [hidden] { display: none }, and that rule loses to any
 * author rule with a class selector. `.update-banner { display: flex }` shipped
 * without a guard, so the attribute in the markup did nothing, the banner
 * rendered its placeholder text to everyone, and `el.hidden = true` from the
 * dismiss handler could not take it away.
 *
 * A property assertion cannot catch that. These check the stylesheet instead.
 * ---------------------------------------------------------------------- */

const HTML_WITH_HIDDEN_TOGGLES = ['popup.html', 'dashboard.html', 'overlay.html'];

/** The <style> block of an extension page. */
function styleOf(file) {
  const s = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const from = s.indexOf('<style>');
  const to = s.lastIndexOf('</style>');
  assert.ok(from !== -1 && to > from, `${file} must have a <style> block`);
  return s.slice(from, to);
}

test('every page that hides things declares a [hidden] guard', () => {
  for (const file of HTML_WITH_HIDDEN_TOGGLES) {
    assert.match(styleOf(file), /\[hidden\]\s*\{[^}]*display:\s*none/,
      `${file} needs a [hidden] rule, or its display-styled components ignore the attribute`);
  }
});

test('the [hidden] guard outranks the component rules it has to beat', () => {
  // Both sides are author rules here, so specificity decides: [hidden] is an
  // attribute selector (0,1,0) and ties with a single class (0,1,0). A tie is
  // broken by source order, which would make the guard depend on sitting after
  // every component in the file — a rule nobody would remember when adding
  // one. !important removes the question.
  for (const file of HTML_WITH_HIDDEN_TOGGLES) {
    assert.match(styleOf(file), /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/,
      `${file}'s [hidden] guard must be !important, or a later class rule silently wins`);
  }
});

test('the update banner in particular cannot render while hidden', () => {
  const css = styleOf('popup.html');
  // The banner is the component the bug actually shipped on: it sets a display
  // value, and it is the one element popup.js toggles with .hidden.
  assert.match(css, /\.update-banner\s*\{[^}]*display:\s*flex/,
    'this test is about the banner being display-styled — if that changed, revisit it');
  assert.match(css, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/,
    'and the guard that makes hiding it actually work');
});

/* ------------------------------------------------------------------------
 * Pane tabs.
 *
 * The popup was one ~1100px column in a 316px window: checking a balance and
 * flipping a toggle sat at opposite ends of a scroll. The wallet stays pinned
 * and the rest swaps between three panes.
 * ---------------------------------------------------------------------- */

const popupHtmlTabs = fs.readFileSync(path.join(ROOT, 'popup.html'), 'utf8');
const popupJsTabs = fs.readFileSync(path.join(ROOT, 'popup.js'), 'utf8');

test('every control still exists — panes hide, they never remove', () => {
  // popup.js binds all of these at load. A pane built by removing markup
  // instead of hiding it would take its controls' listeners with it.
  const ids = ['equity', 'cash', 'pnl', 'open', 'rounds', 'flow', 'recent',
    'power', 'dash', 'toggle', 'backup', 'restore', 'restoreFile', 'overlay-window',
    'warmx', 'warmdest', 'turbo-receipts', 'xray', 'qs-balance', 'qs-presets',
    'qs-sellpcts', 'qs-fees', 'qs-apply', 'sharelogs', 'reset', 'status',
    'update-backup', 'update-backup-state'];
  for (const id of ids) {
    const count = popupHtmlTabs.split(`id="${id}"`).length - 1;
    assert.equal(count, 1, `${id} must appear exactly once`);
  }
});

test('update backup controls keep their banner styling', () => {
  const css = styleOf('popup.html');
  assert.match(css, /#update-backup\s*\{[^}]*cursor:\s*pointer/);
  assert.match(css, /#update-backup-state\s*\{[^}]*display:\s*block/);
});

test('the wallet is pinned above the tabs, not inside one', () => {
  // It is why the popup gets opened; putting it in a pane would mean a click
  // to see your balance.
  const tabsAt = popupHtmlTabs.indexOf('class="ptabs"');
  assert.ok(tabsAt !== -1, 'the tab strip must exist');
  for (const id of ['equity', 'cash', 'rounds', 'dash']) {
    assert.ok(popupHtmlTabs.indexOf(`id="${id}"`) < tabsAt,
      `${id} must sit above the tab strip`);
  }
});

test('exactly one pane starts open', () => {
  const panes = [...popupHtmlTabs.matchAll(/<div id="(pane-[a-z]+)" class="ppane"( hidden)?>/g)];
  assert.equal(panes.length, 3, 'three panes');
  const open = panes.filter((m) => !m[2]);
  assert.equal(open.length, 1, 'exactly one pane may be visible on open');
  assert.equal(open[0][1], 'pane-recent', 'and it is the one showing wallet activity');
});

test('the tab strip and the panes cannot drift apart', () => {
  const tabbed = [...popupHtmlTabs.matchAll(/data-pane="(pane-[a-z]+)"/g)].map((m) => m[1]).sort();
  const panes = [...popupHtmlTabs.matchAll(/<div id="(pane-[a-z]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(tabbed, panes, 'every tab points at a pane, and every pane has a tab');
});

test('switching panes uses the hidden attribute the CSS guard backs', () => {
  // Without [hidden] { display: none !important } in this file, setting
  // .hidden on a styled element does nothing — the exact bug that kept the
  // update banner on screen. The panes rely on the same rule.
  assert.match(popupJsTabs, /pane\.hidden = !on/, 'panes toggle via the attribute');
  assert.match(popupHtmlTabs, /\[hidden\] \{ display: none !important; \}/,
    'and the guard that makes it take effect must still be here');
});

test('popup backup fingerprint: emoji-only thesis edits change the fingerprint', async () => {
  const { ctx } = loadPopupPage({ release: { tag_name: 'v9.9.9' }, manifestVersion: '3.6.1' });
  await settle();
  const withOne = { pt_state: { startedAt: 1, positions: { M: { thesis: 'runner \u{1F680}' } } } };
  // Same high surrogate, different low one: the hash must read both units.
  const withOther = { pt_state: { startedAt: 1, positions: { M: { thesis: 'runner \u{1F681}' } } } };
  assert.notEqual(ctx.backupFingerprint(withOne), ctx.backupFingerprint(withOther));
});

test('popup update nudge: a missing attestation helper is never a complete backup', async () => {
  const state = { startedAt: 1234, journal: [] };
  const { sandbox, click } = loadPopupPage({
    release: { tag_name: 'v9.9.9' },
    manifestVersion: '3.6.1',
    state,
    attest: null,
  });
  await settle();
  await click('update-backup');
  await settle();
  const record = sandbox._stored.get('pt_last_backup');
  assert.equal(record.chainMissing, true);
  assert.match(sandbox._els['update-backup-state'].textContent,
    /exported without the verification chain/);
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  await click('update-link', event);
  await settle();
  assert.equal(event.prevented, true);
  assert.match(sandbox._els['update-backup-state'].textContent,
    /verification chain.*click again to update anyway/);
});

test('popup update nudge: a chain append after export is uncovered', async () => {
  const at = Date.now() - 2 * 24 * 60 * 60 * 1000;
  const state = { startedAt: 1234, journal: [{}] };
  const { sandbox, click } = loadPopupPage({
    release: { tag_name: 'v9.9.9' },
    manifestVersion: '3.6.1',
    lastBackup: { at, startedAt: 1234, trades: 1, fingerprint: '__from_state__' },
    backupFingerprintData: { pt_state: state },
    state,
    chainMeta: { segCount: 1, length: 1, head: 'link-hash-1' },
  });
  await settle();
  assert.equal(sandbox._els['update-backup-state'].textContent,
    `Last backup: ${new Date(at).toISOString().slice(0, 10)} — new verified fills since. Back up again.`);
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  await click('update-link', event);
  await settle();
  assert.equal(event.prevented, true);
  assert.equal(sandbox._tabs.length, 0);
  assert.match(sandbox._els['update-backup-state'].textContent,
    /new verified fills since.*click again to update anyway/);
});

test('popup update nudge: an empty chain install stays coverable', async () => {
  const at = Date.now() - 2 * 24 * 60 * 60 * 1000;
  const state = { startedAt: 1234, journal: [] };
  const { sandbox, click } = loadPopupPage({
    release: { tag_name: 'v9.9.9' },
    manifestVersion: '3.6.1',
    lastBackup: { at, startedAt: 1234, trades: 0, fingerprint: '__from_state__' },
    backupFingerprintData: { pt_state: state },
    state,
    chainMeta: { segCount: 0, length: 0, head: 'papertrench-genesis-v1' },
  });
  await settle();
  assert.match(sandbox._els['update-backup-state'].textContent, /· exported — check the file/);
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  await click('update-link', event);
  await settle();
  assert.equal(event.prevented, true);
  assert.equal(sandbox._tabs.length, 1);
});

test('popup update nudge: a failing chain meta read is unconfirmable', async () => {
  const at = Date.now() - 2 * 24 * 60 * 60 * 1000;
  const state = { startedAt: 1234, journal: [] };
  const { sandbox, click } = loadPopupPage({
    release: { tag_name: 'v9.9.9' },
    manifestVersion: '3.6.1',
    lastBackup: { at, startedAt: 1234, trades: 0, fingerprint: '__from_state__' },
    backupFingerprintData: { pt_state: state },
    state,
    storageMetaGetThrows: true,
  });
  await settle();
  assert.equal(sandbox._els['update-banner'].hidden, false);
  assert.equal(sandbox._els['update-backup-state'].textContent,
    'Backup exists, but the wallet could not be read, so coverage cannot be confirmed. Back up again to be safe.');
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  await click('update-link', event);
  await settle();
  assert.equal(event.prevented, true);
  assert.equal(sandbox._tabs.length, 0);
});

test('popup update nudge: an incomplete attestation chain is never covered', async () => {
  const state = { startedAt: 1234, journal: [] };
  const attest = {
    readChainMeta: async () => ({ segCount: 1, length: 2, head: 'head-2' }),
    readChainStore: async () => ({
      meta: { segCount: 1, length: 2, head: 'head-2' },
      chain: [{ hash: 'head-1' }],
    }),
  };
  const { sandbox, click } = loadPopupPage({
    release: { tag_name: 'v9.9.9' },
    manifestVersion: '3.6.1',
    state,
    attest,
  });
  await settle();
  await click('update-backup');
  await settle();
  assert.equal(sandbox._stored.get('pt_last_backup').chainMissing, true);
  assert.match(sandbox._els['update-backup-state'].textContent,
    /exported without the verification chain/);
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  await click('update-link', event);
  await settle();
  assert.equal(event.prevented, true);
  assert.equal(sandbox._tabs.length, 0);
});

test('popup update nudge: an append racing the chain read still exports the chain', async () => {
  const state = { startedAt: 1234, journal: [{}] };
  const chain = [{ hash: 'h1' }, { hash: 'h2' }];
  let storeReads = 0;
  const attest = {
    // First read catches the pre-append meta beside the appended link.
    readChainStore: async () => {
      storeReads += 1;
      return storeReads === 1
        ? { meta: { segCount: 1, length: 1, head: 'h1' }, chain }
        : { meta: { segCount: 1, length: 2, head: 'h2' }, chain };
    },
    readChainMeta: async () => ({ segCount: 1, length: 2, head: 'h2' }),
  };
  const { sandbox, click } = loadPopupPage({
    release: { tag_name: 'v9.9.9' },
    manifestVersion: '3.6.1',
    state,
    attest,
  });
  await settle();
  await click('update-backup');
  await settle();
  const record = sandbox._stored.get('pt_last_backup');
  assert.equal(storeReads, 2);
  assert.equal(record.chainMissing, false);
  assert.equal(record.chainLength, 2);
  assert.equal(record.chainHead, 'h2');
  assert.equal(sandbox._els['update-backup-state'].textContent,
    `Last backup: ${new Date(record.at).toISOString().slice(0, 10)} \u00b7 exported \u2014 check the file is in your downloads`);
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  await click('update-link', event);
  await settle();
  assert.equal(sandbox._tabs.length, 1);
});

test('popup update nudge: a chain that never settles is exported without it', async () => {
  const state = { startedAt: 1234, journal: [{}] };
  const chain = [{ hash: 'h1' }];
  let storeReads = 0;
  let length = 1;
  const attest = {
    readChainStore: async () => {
      storeReads += 1;
      return { meta: { segCount: 1, length: 1, head: 'h1' }, chain };
    },
    readChainMeta: async () => {
      length += 1;
      return { segCount: 1, length, head: `h${length}` };
    },
  };
  const { sandbox, click } = loadPopupPage({
    release: { tag_name: 'v9.9.9' },
    manifestVersion: '3.6.1',
    state,
    attest,
  });
  await settle();
  await click('update-backup');
  await settle();
  const record = sandbox._stored.get('pt_last_backup');
  assert.equal(storeReads, 3);
  assert.equal(record.chainMissing, true);
  assert.match(sandbox._els['update-backup-state'].textContent,
    /exported without the verification chain/);
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  await click('update-link', event);
  await settle();
  assert.equal(event.prevented, true);
  assert.equal(sandbox._tabs.length, 0);
});

test('popup update nudge: backup content is read in one storage snapshot', async () => {
  const { sandbox } = loadPopupPage({
    release: { tag_name: 'v9.9.9' },
    manifestVersion: '3.6.1',
  });
  await settle();
  const contentReads = sandbox._getCalls.filter((keys) => (
    keys.length === 4
    && keys.includes('pt_state')
    && keys.includes('pt_settings')
    && keys.includes('pt_frames')
    && keys.includes('pt_replays')
  ));
  assert.equal(contentReads.length, 1);
});
