/* PaperTrench — background service worker.
 *
 * Responsibilities:
 *  - Open the dashboard.
 *  - Proxy AI chat calls to a user-configured OpenAI-compatible endpoint.
 *  - Orchestrate optional recording and frame capture.
 *  - Record session replays linking fills, frames, and screen recordings.
 */


if (typeof importScripts === 'function') {
  importScripts('errors.js', 'replay.js', 'quote.js', 'resolver.js', 'onchain.js', 'rpc-pool.js', 'onchain-feed.js', 'recordings.js', 'attest.js', 'xlinks.js', 'warmdest.js', 'xray-core.js', 'pnlcard.js', 'forge-core.js', 'predict-engine.js', 'predict-score.js', 'predict-venues.js', 'sites.js');
}
const RP = self.PTReplay;
const AT = self.PTAttest;
const R = self.PaperTrenchResolver;
const FEED = self.PTOnchainFeed;
const XL = self.PTXLinks;
const XR = self.PTXRay;
const FG = self.PTForge;
const ERRLOG = self.PTErrors || null;

/* -------------------- global error capture (worker) --------------------
 * 114 catch blocks in this file swallow silently, which is correct for the
 * product and useless for triage. These two listeners catch what nothing
 * else did, so a "it stopped working" report has a black box to read.
 * Every call is guarded: the recorder must never be the thing that breaks
 * the service worker. */
function noteError(err, context) {
  try {
    if (ERRLOG) ERRLOG.record(err, context);
  } catch (_) { /* a recorder that throws is worse than no recorder */ }
}

if (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {
  try {
    self.addEventListener('error', (event) => {
      noteError((event && (event.error || event.message)) || 'unknown worker error', {
        scope: 'background',
        kind: 'error',
        filename: (event && event.filename) || null,
        lineno: (event && event.lineno) || null,
      });
    });
    self.addEventListener('unhandledrejection', (event) => {
      noteError((event && event.reason) || 'unknown rejection', {
        scope: 'background',
        kind: 'unhandledrejection',
      });
    });
  } catch (_) { /* listener registration must never abort worker startup */ }
}

/* -------------------- rug guard (holder concentration) --------------------
 * Two chain reads per coin per minute at most: the 20 largest token accounts
 * and the mint's supply. The verdict math itself is pure (PaperQuote.
 * rugVerdict) and excludes accounts the on-chain feed has positively
 * identified as pool/curve reserves — liquidity is not a holder. */
const RUG_CACHE_MS = 60_000;
const rugCache = new Map(); // mint -> { at, verdict }

async function rugScan(mint) {
  const POOLRPC = self.PTRpcPool;
  const O = self.PTOnchain;
  const Q = self.PaperQuote;
  if (!POOLRPC || !O || !Q) return null;
  const largestRes = await POOLRPC.call('getTokenLargestAccounts', [mint, { commitment: 'confirmed' }]);
  const largest = ((largestRes && largestRes.value) || []).map((a) => ({
    address: a && a.address,
    amount: Number(a && a.amount),
  }));
  const mintRes = await POOLRPC.call('getMultipleAccounts', [[mint], { encoding: 'base64', commitment: 'confirmed' }]);
  const mintAccount = mintRes && mintRes.value && mintRes.value[0];
  const info = mintAccount ? O.decodeMint(O.bytesFromBase64(mintAccount.data[0])) : null;
  return Q.rugVerdict({
    largest,
    supply: info && info.supply,
    reserves: FEED && FEED.reserveAccounts ? FEED.reserveAccounts(mint) : [],
  });
}

const DEFAULTS = {
  appEnabled: true,
  balanceStartSol: 10,
  presetsBuy: [0.1, 0.5, 1, 2],
  sellPcts: [25, 50, 75, 100],
  panelBuyEnabled: true,
  panelPresetsEnabled: true,
  feeBps: 100,
  slippageBps: 0,
  recordingEnabled: false,
  framesEnabled: true,
  autoReview: false,
  overlayEnabled: true,
  overlayHideWhenNoToken: true,
  overlayWidth: null,
  overlayHeight: null,
  tradeEffectsEnabled: true,
  tradeSoundsEnabled: true,
  profitAlertsEnabled: false,
  profitAlertPct: 10,
  mcAlertsEnabled: true,
  mcAlertDesktopEnabled: true,
  averagePriceLinesEnabled: true,
  positionsBarEnabled: true,
  positionsBarHidden: false,
  warmXLinksEnabled: false,
  warmHoverCardsEnabled: false,
  warmHoverRowEnabled: false,
  warmHoverBuyEnabled: false,
  warmEverywhereEnabled: false,
  xrayEnabled: false,
  xrayDeepScanEnabled: true,
  settingsRevision: 6,
  aiEndpoint: '',
  aiModel: '',
  aiApiKey: '',
  aiAllowLocalEndpoint: false,
  forgeEnabled: false,
  forgeBrainProvider: 'xai',
  forgeBrainEndpoint: '',
  forgeBrainModel: '',
  forgeBrainKey: '',
  forgeSearchX: true,
  forgeImageProvider: 'openai',
  forgeImageEndpoint: '',
  forgeImageModel: '',
  forgeImageKey: '',
  forgeImageHeaders: '',
  forgeImageBody: '',
  forgeImagePath: '',
  forgeStyle: 'trench',
  forgeVariants: 2,
};

const FRAME_CAP = 80;
const FRAME_INTERVAL_MS = 30_000;
let frameInterval = null;
let recActive = false;
let lastTradeTabId = null;
let replayMutation = Promise.resolve();

const OLD_LOCAL_AI_ENDPOINT = 'http://127.0.0.1:8765/v1';

function migrateBackgroundSettings(settings) {
  const revision = Number(settings.settingsRevision) || 0;
  if (revision < 4) {
    // The default AI endpoint used to point at a local BYOK shim. Treat an
    // unchanged install as empty so the new validator does not immediately
    // block it, and require an explicit opt-in before local/private endpoints
    // are reachable from the background script.
    if (settings.aiEndpoint === OLD_LOCAL_AI_ENDPOINT) {
      settings.aiEndpoint = '';
    }
    settings.aiAllowLocalEndpoint = false;
    settings.settingsRevision = 4;
  }
  return settings;
}

function getSettings() {
  return new Promise((resolve) =>
    chrome.storage.local.get(['pt_settings'], (value) => {
      if (chrome.runtime && chrome.runtime.lastError) {
        console.warn('PaperTrench: settings read failed', chrome.runtime.lastError.message);
        resolve(migrateBackgroundSettings({ ...DEFAULTS }));
        return;
      }
      resolve(migrateBackgroundSettings({ ...DEFAULTS, ...(value.pt_settings || {}) }));
    })
  );
}

function getState() {
  return new Promise((resolve) => chrome.storage.local.get(['pt_state'], (value) => {
    if (chrome.runtime && chrome.runtime.lastError) {
      console.warn('PaperTrench: state read failed', chrome.runtime.lastError.message);
      resolve(null);
      return;
    }
    resolve(value.pt_state || null);
  }));
}

function setState(state) {
  // Every writer must advance the wallet's write counter. Content tabs adopt a
  // stored state only when its seq is STRICTLY greater than their own, so a
  // write that leaves seq unchanged is invisible to open tabs and gets
  // overwritten by their next heartbeat — which is how AI reviews and
  // recording references used to vanish within a second.
  if (state && typeof state === 'object') state.seq = (Number(state.seq) || 0) + 1;
  return new Promise((resolve) => chrome.storage.local.set({ pt_state: state }, () => {
    if (chrome.runtime && chrome.runtime.lastError) {
      console.warn('PaperTrench: state write failed', chrome.runtime.lastError.message);
    }
    resolve();
  }));
}

function getReplays() {
  return new Promise((resolve) => chrome.storage.local.get([RP.STORAGE_KEY], (value) => {
    if (chrome.runtime && chrome.runtime.lastError) {
      console.warn('PaperTrench: replays read failed', chrome.runtime.lastError.message);
      resolve(RP.normalizeReplayList(null));
      return;
    }
    resolve(RP.normalizeReplayList(value[RP.STORAGE_KEY]));
  }));
}

function setReplays(replays) {
  return new Promise((resolve) => chrome.storage.local.set({ [RP.STORAGE_KEY]: replays }, () => {
    if (chrome.runtime && chrome.runtime.lastError) {
      console.warn('PaperTrench: replays write failed', chrome.runtime.lastError.message);
    }
    resolve();
  }));
}

/* ---- shared card-background gallery (extension-origin IndexedDB) ----
 *
 * The Flex composer also runs inside the page overlay now, and a content
 * script's IndexedDB belongs to the SITE origin — uploads made on Axiom
 * would be invisible on Padre and on the dashboard. Routing the gallery
 * through here keeps ONE gallery: this worker shares the extension origin
 * with dashboard.html, so it opens the very 'pt-cardmedia' database
 * dashboard.js reads directly. Blobs cross the message boundary as data
 * URLs (runtime messages are JSON).
 */
const CARDBG_DB_NAME = 'pt-cardmedia';
const CARDBG_DB_STORE = 'backgrounds';

function cardBgDbOpen() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB unavailable')); return; }
    let settled = false;
    const finish = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value); } };
    // Bounded open, like recordings.js: a stalled IndexedDB must degrade to
    // "no gallery", never hang the composer.
    const timer = setTimeout(() => finish(reject, new Error('IndexedDB open timed out')), 5000);
    let request;
    try {
      request = indexedDB.open(CARDBG_DB_NAME, 1);
    } catch (err) {
      finish(reject, err instanceof Error ? err : new Error('IndexedDB open failed'));
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CARDBG_DB_STORE)) {
        db.createObjectStore(CARDBG_DB_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => finish(resolve, request.result);
    request.onerror = () => finish(reject, request.error || new Error('IndexedDB open failed'));
    request.onblocked = () => finish(reject, new Error('IndexedDB open blocked by another tab'));
  });
}

function cardBgDbRequest(db, mode, run) {
  return new Promise((resolve, reject) => {
    const request = run(db.transaction(CARDBG_DB_STORE, mode).objectStore(CARDBG_DB_STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

/** Base64 the blob by hand — service workers have no FileReader/objectURL. */
async function cardBgBlobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return 'data:' + (blob.type || 'image/png') + ';base64,' + btoa(binary);
}

async function cardBgList() {
  const db = await cardBgDbOpen();
  try {
    const entries = await cardBgDbRequest(db, 'readonly', (store) => store.getAll());
    const sorted = (entries || []).sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
    const items = [];
    for (const record of sorted) {
      try {
        items.push({
          id: record.id,
          name: record.name,
          addedAt: record.addedAt,
          dataUrl: await cardBgBlobToDataUrl(record.blob),
        });
      } catch (_) { /* an unreadable blob is simply not offered */ }
    }
    return items;
  } finally {
    try { db.close(); } catch (_) {}
  }
}

async function cardBgAdd(name, dataUrl) {
  if (typeof dataUrl !== 'string' || !/^data:image\//.test(dataUrl)) {
    return { ok: false, reason: 'Card backgrounds must be images.' };
  }
  const blob = await (await fetch(dataUrl)).blob();
  const db = await cardBgDbOpen();
  try {
    const existing = await cardBgDbRequest(db, 'readonly', (store) => store.getAll());
    // Admission is re-checked here, not only at the drop site, so no future
    // call path can slip past the 2 MB / 10-image doctrine. Same pure
    // function the composers use (pnlcard.js is imported above).
    const verdict = self.PTPnlCard.admitUpload(blob, (existing || []).length);
    if (!verdict.ok) return { ok: false, reason: verdict.reason };
    const record = {
      id: 'bg' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      name: String(name || 'background'),
      blob,
      addedAt: Date.now(),
    };
    await cardBgDbRequest(db, 'readwrite', (store) => store.put(record));
    return { ok: true, record: { id: record.id, name: record.name, addedAt: record.addedAt, dataUrl } };
  } finally {
    try { db.close(); } catch (_) {}
  }
}

async function cardBgRemove(id) {
  const db = await cardBgDbOpen();
  try {
    await cardBgDbRequest(db, 'readwrite', (store) => store.delete(String(id)));
    return { ok: true };
  } finally {
    try { db.close(); } catch (_) {}
  }
}

function openDashboard() {
  chrome.runtime.openOptionsPage();
}

/* -------------------- recording orchestration -------------------- */

async function ensureOffscreen() {
  const has = await chrome.offscreen.hasDocument().catch(() => false);
  if (has) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['DISPLAY_MEDIA'],
    justification: 'Record the trading tab while a paper position is open (user-enabled).',
  });
}

async function startRecording(tabId, symbol) {
  if (recActive) return;
  try {
    await ensureOffscreen();
    const response = await chrome.runtime.sendMessage({ type: 'recorder.begin', symbol });
    recActive = !!(response && response.active);
  } catch (error) {
    recActive = false;
    console.warn('recorder begin failed:', error.message);
  }
  broadcastRecStatus();
}

async function stopRecording(roundId) {
  let result = null;
  try {
    result = await chrome.runtime.sendMessage({ type: 'recorder.stop', roundId });
  } catch (error) {
    console.warn('recorder stop failed:', error.message);
  }
  recActive = false;
  broadcastRecStatus();

  const file = result && result.file ? result.file : null;
  if (file && roundId) {
    const state = await getState();
    if (state && Array.isArray(state.rounds)) {
      const round = state.rounds.find((item) => item.id === roundId);
      if (round) {
        round.recordingFile = file;
        // Recorded to IndexedDB, so the dashboard can play the video back
        // instead of falling back to still frames.
        round.recording = result.stored ? {
          id: roundId,
          file,
          startedAt: Number(result.startedAt) || 0,
          endedAt: Number(result.endedAt) || 0,
          size: Number(result.size) || 0,
        } : null;
        await setState(state);
      }
    }
  }
  return file;
}

function broadcastRecStatus() {
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { type: 'pt_rec_status', active: recActive }).catch(() => {});
    }
  });
}

/* -------------------- frame snapshots -------------------- */

/**
 * Capture the trading tab into pt_frames. Returns the stored frame's
 * timestamp on success and null on any refusal or failure, so callers can
 * tell the user the truth instead of assuming the frame exists.
 *
 * `explicit` marks a capture the user just asked for by hand (the overlay's
 * thesis snap). framesEnabled governs the AUTOMATIC captures — a direct
 * "snap this chart" click is its own consent, and everything stays local
 * either way.
 */
async function snapFrame(kind, sessionValue, tabId, explicit) {
  const settings = await getSettings();
  if (!settings.framesEnabled && explicit !== true) return null;
  const session = sessionValue ? RP.normalizeSession(sessionValue) : null;
  // Never photograph whichever window happens to be focused. A frame is only
  // honest when it shows the tab that actually traded, so we capture that
  // tab's own window — and when the tab is gone or hidden, there is no
  // truthful frame, so we skip instead of grabbing some unrelated screen.
  const target = await resolveFrameTab(tabId);
  if (!target) return null;
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(target.windowId, { format: 'jpeg', quality: 45 });
    const small = await downscaleDataUrl(dataUrl, 480);
    const { pt_frames = [] } = await chrome.storage.local.get(['pt_frames']);
    const at = Date.now();
    pt_frames.push({
      t: at,
      kind,
      sessionId: session?.sessionId || null,
      roundId: session?.roundId || null,
      symbol: session?.symbol || null,
      mint: session?.mint || null,
      dataUrl: small,
    });
    while (pt_frames.length > FRAME_CAP) pt_frames.shift();
    await chrome.storage.local.set({ pt_frames });
    return at;
  } catch (error) {
    console.warn('frame capture failed:', error.message);
    return null;
  }
}

/** Resolve the tab a frame should depict: the one that traded, if it still
 * exists and is the visible tab of its window. Anything else is a lie about
 * what was on screen, so it resolves to nothing. */
async function resolveFrameTab(tabId) {
  const id = Number(tabId || lastTradeTabId);
  if (!Number.isFinite(id) || id <= 0) return null;
  let tab = null;
  try { tab = await chrome.tabs.get(id); } catch (_) { tab = null; }
  if (!tab || !tab.active) return null;
  return tab;
}

async function downscaleDataUrl(dataUrl, width) {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    const scale = width / bitmap.width;
    const canvas = new OffscreenCanvas(width, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const output = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.55 });
    const buffer = new Uint8Array(await output.arrayBuffer());
    let binary = '';
    const chunk = 0x8000;
    for (let index = 0; index < buffer.length; index += chunk) {
      binary += String.fromCharCode.apply(null, buffer.subarray(index, index + chunk));
    }
    return 'data:image/jpeg;base64,' + btoa(binary);
  } catch (_) {
    return dataUrl;
  }
}

async function openPositions() {
  const state = await getState();
  return state && state.positions ? Object.values(state.positions) : [];
}

async function refreshFrameInterval() {
  const positions = await openPositions();
  const settings = await getSettings();
  if (positions.length && settings.framesEnabled && !frameInterval) {
    frameInterval = setInterval(async () => {
      const current = await openPositions();
      if (current[0]) await snapFrame('interval', current[0]);
    }, FRAME_INTERVAL_MS);
  } else if ((!positions.length || !settings.framesEnabled) && frameInterval) {
    clearInterval(frameInterval);
    frameInterval = null;
  }
}

/* -------------------- session replay bookkeeping -------------------- */

/**
 * Record the replay record for a paper session.
 *
 * This is pure local bookkeeping: it links a round's fills, chart frames, and
 * screen recording under one session id so the dashboard can play the trade
 * back. No network calls are involved.
 */
function recordReplay(sessionValue, roundValue = null) {
  const session = RP.normalizeSession(sessionValue || roundValue || {});
  replayMutation = replayMutation.catch(() => {}).then(async () => {
    if (!session.mint) return { skipped: true };
    let replays = await getReplays();
    try {
      if (roundValue) ({ replays } = RP.closeReplay(replays, session, roundValue));
      else ({ replays } = RP.upsertReplay(replays, session));
      await setReplays(replays);
      return { ok: true };
    } catch (error) {
      ({ replays } = RP.addReplayError(replays, session, error));
      await setReplays(replays);
      return { error: error.message };
    }
  });
  return replayMutation;
}

/* -------------------- AI proxy -------------------- */

function isForbiddenIPv4(a, b, c, d, allowLocal) {
  if (a === 0) return true;                                 // 0.0.0.0/8
  if (a === 10) return !allowLocal;                         // 10.0.0.0/8
  if (a === 127) return !allowLocal;                        // 127.0.0.0/8
  if (a === 169 && b === 254) return true;                  // 169.254.0.0/16 link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return !allowLocal;  // 172.16.0.0/12
  if (a === 192 && b === 168) return !allowLocal;           // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return !allowLocal; // 100.64.0.0/10 CGNAT
  if ((a === 192 && b === 0 && c === 0) ||                  // 192.0.0.0/24
      (a === 192 && b === 0 && c === 2) ||                  // 192.0.2.0/24 TEST-NET-1
      (a === 198 && b === 51 && c === 100) ||               // 198.51.100.0/24 TEST-NET-2
      (a === 203 && b === 0 && c === 113) ||                // 203.0.113.0/24 TEST-NET-3
      (a === 198 && (b === 18 || b === 19))) {             // 198.18.0.0/15 benchmark
    return !allowLocal;
  }
  if (a >= 224 && a <= 239) return true;                    // 224.0.0.0/4 multicast
  if (a >= 240) return true;                                // 240.0.0.0/4 + 255.255.255.255
  return false;
}

function isForbiddenIPv6(ip, allowLocal) {
  // The unspecified address resolves to loopback on many systems; block it
  // unconditionally just like 0.0.0.0/8.
  if (ip === '::') return true;
  if (ip === '::1') return !allowLocal;
  const lower = ip.toLowerCase();
  if (lower.startsWith('::ffff:') || lower.startsWith('::ffff:0:')) {
    const rest = lower.replace(/^::ffff(:0)?:/, '');
    if (rest.includes('.')) {
      const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(rest);
      if (ipv4) return isForbiddenIPv4(Number(ipv4[1]), Number(ipv4[2]), Number(ipv4[3]), Number(ipv4[4]), allowLocal);
    }
    const parts = rest.split(':').filter(Boolean);
    if (parts.length) {
      const lastTwo = parts.slice(-2);
      const high = parseInt(lastTwo[0] || '0', 16);
      const low = parseInt(lastTwo[1] || '0', 16);
      return isForbiddenIPv4((high >> 8) & 255, high & 255, (low >> 8) & 255, low & 255, allowLocal);
    }
  }
  if (/^fe[89ab][0-9a-f]{0,2}:/i.test(ip) || /^fe[89ab][0-9a-f]{0,2}$/i.test(ip)) return true;    // fe80::/10 link-local
  if (/^f[c-d][0-9a-f]{0,2}:/i.test(ip) || /^f[c-d][0-9a-f]{0,2}$/i.test(ip)) return !allowLocal;   // fc00::/7 unique local
  if (/^fe[c-f][0-9a-f]{0,2}:/i.test(ip) || /^fe[c-f][0-9a-f]{0,2}$/i.test(ip)) return !allowLocal; // fec0::/10 site-local (deprecated)
  if (/^ff[0-9a-f]{0,2}:/i.test(ip) || /^ff[0-9a-f]{0,2}$/i.test(ip)) return true;                  // ff00::/8 multicast
  return false;
}

function isForbiddenHost(host, allowLocal) {
  // Strip an optional trailing dot (FQDN form) so "localhost." is treated the
  // same as "localhost" by the literal and IP checks.
  const lower = host.toLowerCase().replace(/\.$/, '');
  if (lower === 'localhost' || lower === 'localhost.localdomain' || lower.endsWith('.localhost')) {
    return !allowLocal;
  }
  if (lower.includes(':')) {
    const ip = lower.replace(/^\[|\]$/g, '');
    return isForbiddenIPv6(ip, allowLocal);
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(lower);
  if (ipv4) {
    return isForbiddenIPv4(Number(ipv4[1]), Number(ipv4[2]), Number(ipv4[3]), Number(ipv4[4]), allowLocal);
  }
  return false;
}

function isAllowedEndpoint(url, allowLocal = false) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (parsed.username || parsed.password) return false;
    return !isForbiddenHost(parsed.hostname, allowLocal);
  } catch (_) {
    return false;
  }
}

async function aiChat({ messages, maxTokens }) {
  const settings = await getSettings();
  const endpoint = (settings.aiEndpoint || '').replace(/\/+$/, '');
  if (!endpoint) return { error: 'No AI endpoint configured (open the dashboard → Settings)' };
  if (!isAllowedEndpoint(endpoint, settings.aiAllowLocalEndpoint)) {
    return { error: 'AI endpoint URL is not allowed. Enable local/private endpoints in Settings if you run a self-hosted endpoint, otherwise use a public endpoint.' };
  }
  const body = {
    model: settings.aiModel || 'default',
    messages,
    temperature: 0.3,
  };
  if (maxTokens) body.max_tokens = maxTokens;
  try {
    const response = await fetch(endpoint + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(settings.aiApiKey ? { Authorization: 'Bearer ' + settings.aiApiKey } : {}),
      },
      body: JSON.stringify(body),
      redirect: 'error',
    });
    if (!response.ok) return { error: `AI endpoint returned ${response.status}` };
    const json = await response.json();
    return { reply: json?.choices?.[0]?.message?.content || '' };
  } catch (error) {
    return { error: 'AI request failed: ' + error.message };
  }
}


/**
 * List the models the configured endpoint serves — or, when the caller
 * passes overrides, the endpoint the caller supplies.
 *
 * D-29: the dashboard's "Test AI endpoint" button used to persist the entire
 * unsaved settings form to storage just so this function would read the right
 * endpoint. Overrides let the probe use the form values with NOTHING written;
 * they pass through the exact same isAllowedEndpoint gate as saved settings,
 * so this widens no security surface — it only changes where the values come
 * from. (`model` is accepted for interface symmetry; the /models listing does
 * not need it.)
 */
async function aiModels(overrides) {
  const settings = await getSettings();
  const o = overrides && typeof overrides === 'object' ? overrides : {};
  const endpoint = String(typeof o.endpoint === 'string' ? o.endpoint : (settings.aiEndpoint || '')).replace(/\/+$/, '');
  const allowLocal = typeof o.aiAllowLocalEndpoint === 'boolean'
    ? o.aiAllowLocalEndpoint
    : Boolean(settings.aiAllowLocalEndpoint);
  const apiKey = typeof o.apiKey === 'string' ? o.apiKey : (settings.aiApiKey || '');
  if (!endpoint) return { models: [] };
  if (!isAllowedEndpoint(endpoint, allowLocal)) {
    return { models: [], error: 'AI endpoint URL is not allowed. Enable local/private endpoints in Settings if you run a self-hosted endpoint, otherwise use a public endpoint.' };
  }
  try {
    const response = await fetch(endpoint + '/models', {
      headers: apiKey ? { Authorization: 'Bearer ' + apiKey } : {},
      redirect: 'error',
    });
    if (!response.ok) return { models: [] };
    const json = await response.json();
    return { models: (json.data || []).map((model) => model.id).filter(Boolean) };
  } catch (error) {
    return { models: [], error: error.message };
  }
}

/* -------------------- Forge (banner generator) --------------------
 *
 * Every provider call in this feature happens HERE and nowhere else. The
 * content script sends facts and receives pixels; the keys never enter a page
 * context, so a hostile dex cannot read them out of the DOM or a JS global.
 *
 * Custom endpoints go through the same isAllowedEndpoint gate as the AI
 * coach — this feature widens the number of keys a user holds, not the set of
 * hosts they can be pointed at.
 */

const FORGE_BRIEF_TTL_MS = 10 * 60_000;
const forgeBriefCache = new Map();   // briefKey -> { at, brief }
const forgeBriefInflight = new Map(); // briefKey -> Promise
const FORGE_TIMEOUT_MS = 90_000;

function forgeConfig(settings) {
  return {
    allowLocal: settings.aiAllowLocalEndpoint === true,
    brain: {
      id: settings.forgeBrainProvider || '',
      endpoint: settings.forgeBrainEndpoint || '',
      apiKey: settings.forgeBrainKey || '',
      model: settings.forgeBrainModel || '',
      useSearch: settings.forgeSearchX !== false,
    },
    hands: {
      id: settings.forgeImageProvider || '',
      endpoint: settings.forgeImageEndpoint || '',
      apiKey: settings.forgeImageKey || '',
      model: settings.forgeImageModel || '',
      headersJson: settings.forgeImageHeaders || '',
      bodyTemplate: settings.forgeImageBody || '',
      responsePath: settings.forgeImagePath || '',
    },
  };
}

function forgeSecrets(cfg) {
  return [cfg.brain.apiKey, cfg.hands.apiKey].filter(Boolean);
}

function forgeClean(text, secrets) {
  return FG.redact(text, secrets).slice(0, 300);
}

/**
 * One request, with the two robustness moves this feature needs:
 *  - a timeout, because an image model that hangs would otherwise pin the
 *    panel on "Generating…" forever;
 *  - an optional single retry with one body key removed. `search_parameters`
 *    and `size` are the two fields whose exact acceptance we cannot verify
 *    from inside this repo, so we send them hopefully and survive being
 *    wrong instead of assuming we are right.
 */
async function forgeFetch(req, secrets, allowLocal) {
  if (req.error) return { error: req.error };
  if (!isAllowedEndpoint(req.url, allowLocal)) {
    return { error: 'That endpoint is not allowed. Enable local/private endpoints in Settings if it is self-hosted.' };
  }

  const attempt = async (body, form) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FORGE_TIMEOUT_MS);
    try {
      const init = { method: 'POST', headers: Object.assign({}, req.headers), redirect: 'error', signal: controller.signal };
      if (form) {
        const fd = new FormData();
        for (const k of Object.keys(form)) fd.append(k, String(form[k]));
        delete init.headers['Content-Type'];   // FormData sets its own boundary
        init.body = fd;
      } else {
        init.body = JSON.stringify(body);
      }
      const res = await fetch(req.url, init);
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch (_) { json = null; }
      if (!res.ok) {
        const detail = (json && json.error && (json.error.message || json.error.type)) || text.slice(0, 200);
        return { status: res.status, error: `${res.status} — ${forgeClean(detail, secrets)}` };
      }
      if (!json) return { error: 'The provider replied with something that is not JSON.' };
      return { json };
    } catch (e) {
      const msg = e && e.name === 'AbortError'
        ? `Timed out after ${FORGE_TIMEOUT_MS / 1000}s`
        : forgeClean((e && e.message) || 'request failed', secrets);
      return { error: msg };
    } finally {
      clearTimeout(timer);
    }
  };

  let out = await attempt(req.body, req.form);
  if (out.error && req.retryWithout && req.body && (req.body[req.retryWithout] !== undefined)) {
    const trimmed = Object.assign({}, req.body);
    delete trimmed[req.retryWithout];
    const second = await attempt(trimmed, null);
    if (!second.error) return second;
  }
  return out;
}

/** Narrative research. Cached and de-duplicated so the prefetch and the
 *  panel's own request never become two bills for the same answer. */
function forgeBrief(facts) {
  const key = FG.briefKey(facts);
  const hit = forgeBriefCache.get(key);
  if (hit && Date.now() - hit.at < FORGE_BRIEF_TTL_MS) return Promise.resolve({ brief: hit.brief });
  const flying = forgeBriefInflight.get(key);
  if (flying) return flying;

  const run = (async () => {
    const settings = await getSettings();
    const cfg = forgeConfig(settings);
    if (!cfg.brain.id) return { error: 'No narrative AI configured — describe the art yourself, or set one up in Settings.' };
    const provider = FG.brainById(cfg.brain.id);
    if (!provider) return { error: 'Unknown narrative provider.' };
    const req = FG.buildResearchRequest(provider, cfg.brain, facts);
    const out = await forgeFetch(req, forgeSecrets(cfg), cfg.allowLocal);
    if (out.error) return { error: out.error };
    const brief = FG.parseResearch(provider, out.json);
    if (!brief) return { error: 'The narrative AI answered, but with nothing usable in it.' };
    forgeBriefCache.set(key, { at: Date.now(), brief });
    if (forgeBriefCache.size > 40) forgeBriefCache.delete(forgeBriefCache.keys().next().value);
    return { brief };
  })().finally(() => { forgeBriefInflight.delete(key); });

  forgeBriefInflight.set(key, run);
  return run;
}

function forgeB64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Crop what the provider gave us to the exact slot size. Image APIs only
 * serve a handful of sizes, so a 3:1 header is always a centre-crop of a
 * wider-than-tall render rather than a squashed square.
 */
async function forgeFit(buffer, spec) {
  const bmp = await createImageBitmap(new Blob([buffer]));
  const plan = FG.planFit(bmp.width, bmp.height, spec);
  try {
    if (plan.exact) return { dataUrl: 'data:image/png;base64,' + forgeB64(buffer), w: bmp.width, h: bmp.height };
    const canvas = new OffscreenCanvas(plan.dw, plan.dh);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bmp, plan.sx, plan.sy, plan.sw, plan.sh, 0, 0, plan.dw, plan.dh);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const buf = await blob.arrayBuffer();
    return { dataUrl: 'data:image/png;base64,' + forgeB64(buf), w: plan.dw, h: plan.dh };
  } finally {
    if (bmp && typeof bmp.close === 'function') bmp.close();
  }
}

async function forgeOneImage(provider, cfg, opts, secrets, allowLocal) {
  const req = FG.buildImageRequest(provider, cfg.hands, opts);
  if (req.error) return { error: req.error };
  const out = await forgeFetch(req, secrets, allowLocal);
  if (out.error) return { error: out.error };
  const parsed = FG.parseImages(out.json, req.responsePath);
  if (!parsed.images.length) return { error: forgeClean(parsed.error || 'no image in the reply', secrets) };

  const first = parsed.images[0];
  let buffer = null;
  if (first.b64) {
    try {
      const bin = atob(first.b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      buffer = arr.buffer;
    } catch (_) { return { error: 'The provider sent image data this build could not decode.' }; }
  } else if (first.url) {
    // A provider CDN is still a URL we were handed by a remote party: it goes
    // through the same gate as everything else.
    if (!isAllowedEndpoint(first.url, allowLocal)) return { error: 'The provider pointed at an address that is not allowed.' };
    try {
      const res = await fetch(first.url, { redirect: 'error' });
      if (!res.ok) return { error: `Could not fetch the generated image (${res.status}).` };
      buffer = await res.arrayBuffer();
    } catch (e) { return { error: forgeClean('Could not fetch the generated image: ' + ((e && e.message) || ''), secrets) }; }
  }
  if (!buffer) return { error: 'The provider replied with no image payload.' };

  try {
    return await forgeFit(buffer, opts.spec);
  } catch (e) {
    return { error: forgeClean('Could not resize the image: ' + ((e && e.message) || ''), secrets) };
  }
}

async function forgeImages(message) {
  const settings = await getSettings();
  const cfg = forgeConfig(settings);
  if (!cfg.hands.id) return { error: 'No image AI configured. Open the dashboard → Settings → Forge.' };
  const provider = FG.handsById(cfg.hands.id);
  if (!provider) return { error: 'Unknown image provider.' };

  const facts = message.facts || {};
  const spec = message.spec && message.spec.w ? message.spec : FG.ASSET_KINDS[FG.DEFAULT_KIND];
  // The user's own words win. Only fall back to research when they left it
  // blank — nobody wants their description quietly overridden.
  let brief = null;
  if (message.subject) {
    brief = { subject: message.subject };
  } else {
    const res = await forgeBrief(facts);
    brief = res && res.brief ? res.brief : null;
  }

  const prompt = FG.buildImagePrompt({
    facts, brief, spec, styleId: message.styleId, withTicker: message.withTicker === true,
  });

  const n = Math.max(1, Math.min(4, Number(message.n) || 2));
  const secrets = forgeSecrets(cfg);
  const results = await Promise.all(
    Array.from({ length: n }, () => forgeOneImage(provider, cfg, { prompt, spec }, secrets, cfg.allowLocal)),
  );
  const images = results.filter((r) => r && r.dataUrl);
  if (!images.length) {
    const firstErr = results.find((r) => r && r.error);
    return { error: (firstErr && firstErr.error) || 'The image AI returned nothing.' };
  }
  return { images, prompt };
}

async function autoReview(roundId) {
  const state = await getState();
  if (!state) return;
  const round = (state.rounds || []).find((item) => item.id === roundId);
  if (!round) return;
  const trades = (state.journal || []).filter((trade) => round.tradeIds.includes(trade.id));
  const prompt = buildRoundReviewPrompt(round, trades);
  const { reply, error } = await aiChat({ messages: prompt, maxTokens: 1800 });
  round.aiReview = {
    t: Date.now(),
    text: reply || ('AI review failed: ' + error),
    ok: !error,
  };
  await setState(state);
}

/**
 * D-49: coach prompts stamp times in LOCAL time with an explicit UTC-offset
 * suffix, matching the dashboard's P&L calendar (which buckets days in local
 * time). A bare UTC ISO stamp put fills near midnight on a different day
 * than the calendar the user sees, so the coach's "day" observations
 * disagreed with the grid. Same helper as dashboard.js formatLocalStamp.
 */
function formatLocalStamp(ms) {
  const d = new Date(Number(ms) || 0);
  const pad = (n) => String(n).padStart(2, '0');
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} `
    + `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function buildRoundReviewPrompt(round, trades) {
  const lines = trades
    .sort((a, b) => a.ts - b.ts)
    .map((trade) => `${formatLocalStamp(trade.ts)} ${trade.side.toUpperCase()} ${trade.qty.toFixed(4)} ${trade.symbol} @ ${trade.priceNative} SOL (gross ${trade.solGross.toFixed(3)} SOL${trade.pnlSol !== undefined ? `, realized ${trade.pnlSol >= 0 ? '+' : ''}${trade.pnlSol.toFixed(4)}` : ''})`)
    .join('\n');
  return [
    {
      role: 'system',
      content:
        'You are a brutally honest but constructive Solana memecoin trading coach. Review this paper-trade round trip. Analyze entries, exits, sizing, and hold time against the P&L path, and name specific bad habits if present. Be concrete and short.',
    },
    {
      role: 'user',
      content:
        `Round trip on ${round.symbol} (${round.mint})\n` +
        `Opened: ${formatLocalStamp(round.openedAt)}  Closed: ${formatLocalStamp(round.closedAt)}  Held: ${(round.heldMs / 60000).toFixed(1)} min\n` +
        `Invested: ${round.investedSol.toFixed(4)} SOL  Returned: ${round.returnedSol.toFixed(4)} SOL\n` +
        `P&L: ${round.pnlSol >= 0 ? '+' : ''}${round.pnlSol.toFixed(4)} SOL (${round.pnlPct.toFixed(1)}%)\n` +
        `Peak unrealized P&L: +${round.peakPnlSol.toFixed(4)} SOL   Worst: ${round.troughPnlSol.toFixed(4)} SOL\n\n` +
        `Fills:\n${lines}` +
        '\n\nGive: (1) verdict, (2) what was done right, (3) what was done wrong, (4) one bad habit, and (5) one concrete fix for next time.',
    },
  ];
}

/* -------------------- Turbo receipts (local route timings) -----------------
 *
 * Speed claims get receipts or they do not get made. Every warm route
 * records how long the background took from receiving the click to
 * dispatching the navigation / revealing the viewer — measured on THIS
 * machine, stored locally under one key, shown in the popup as medians.
 * That is exactly what the number is and all it is: background routing
 * latency, not page-ready time. No telemetry; nothing ever leaves the
 * device; the ring holds the last 50 samples per route.
 */
const TURBO_STATS_KEY = 'pt_turbo_stats';
const TURBO_RING_MAX = 50;
let turboChain = Promise.resolve();
function turboNote(route, ms) {
  turboChain = turboChain.catch(() => {}).then(() => new Promise((resolve) => {
    try {
      chrome.storage.local.get([TURBO_STATS_KEY], (value) => {
        if (chrome.runtime && chrome.runtime.lastError) { resolve(); return; }
        const stats = (value && value[TURBO_STATS_KEY]) || {};
        const entry = stats[route] || { count: 0, ring: [] };
        entry.count += 1;
        if (Number.isFinite(ms)) {
          entry.ring.push(Math.round(ms));
          if (entry.ring.length > TURBO_RING_MAX) entry.ring.splice(0, entry.ring.length - TURBO_RING_MAX);
        }
        stats[route] = entry;
        chrome.storage.local.set({ [TURBO_STATS_KEY]: stats }, () => resolve());
      });
    } catch (_) { resolve(); }
  }));
}

/* Fill receipts. The one interaction that most defines this product had no
 * instrument at all: routing had a median, page jank had a rate, the FILL had
 * nothing. Stages arrive already differenced by the content script (monotonic
 * performance.now deltas — never a wall clock, which must never be confusable
 * with a fill's attestation ts) and are folded here, on the SAME write chain as
 * the route timings and the jank merge, so three writers can never lose each
 * other's read-modify-write on the one stats key.
 *
 * Stored per kind ('buy'/'sell') as a bounded ring per stage. Nothing
 * page-derived is accepted — no mint, no symbol, no hostname — so this key
 * gains no attacker-writable string, and every value is re-validated here
 * rather than trusted from the content script. */
const TURBO_FILL_STAGES = ['quoteMs', 'commitMs', 'paintMs', 'totalMs'];
function turboFillNote(message) {
  const kind = message && message.kind === 'sell' ? 'sell' : 'buy';
  const sample = {};
  for (const stage of TURBO_FILL_STAGES) {
    const value = Math.round(Number(message && message[stage]));
    // A negative or non-finite stage is a broken measurement, not a fast one.
    if (!Number.isFinite(value) || value < 0) return;
    sample[stage] = value;
  }
  turboChain = turboChain.catch(() => {}).then(() => new Promise((resolve) => {
    try {
      chrome.storage.local.get([TURBO_STATS_KEY], (value) => {
        if (chrome.runtime && chrome.runtime.lastError) { resolve(); return; }
        const stats = (value && value[TURBO_STATS_KEY]) || {};
        const fills = stats.fills || {};
        const entry = fills[kind] || { count: 0 };
        entry.count += 1;
        for (const stage of TURBO_FILL_STAGES) {
          if (!Array.isArray(entry[stage])) entry[stage] = [];
          entry[stage].push(sample[stage]);
          if (entry[stage].length > TURBO_RING_MAX) {
            entry[stage].splice(0, entry[stage].length - TURBO_RING_MAX);
          }
        }
        fills[kind] = entry;
        stats.fills = fills;
        chrome.storage.local.set({ [TURBO_STATS_KEY]: stats }, () => resolve());
      });
    } catch (_) { resolve(); }
  }));
}

/* Page jank receipts. Content scripts sample the browser's own 'longtask'
 * entries (any main-thread task over 50 ms) and flush ONE aggregate at most
 * every minute — never a per-event write. The merge lives here, on the same
 * write chain as the route timings, so the two writers can never lose each
 * other's read-modify-write on the one stats key.
 *
 * Bounded like every receipt: at most TURBO_JANK_SITES_MAX sites (stalest
 * evicted first), each holding lifetime totals plus a ring of the last
 * TURBO_RING_MAX flush windows — the ring is what lets the dashboard show
 * "lately vs earlier" honestly instead of a diluted lifetime average.
 * Local only; nothing here may ever grow a network path.
 */
const TURBO_JANK_SITES_MAX = 12;
function turboJankNote(site, sample) {
  const host = (typeof site === 'string' && site) ? site.slice(0, 80) : null;
  const count = Math.round(Number(sample && sample.count));
  const blockedMs = Math.round(Number(sample && sample.blockedMs));
  const sampledMs = Math.round(Number(sample && sample.sampledMs));
  // A flush with no watched time can only produce a nonsense rate — drop it.
  if (!host || !Number.isFinite(count) || count < 0) return;
  if (!Number.isFinite(blockedMs) || blockedMs < 0) return;
  if (!Number.isFinite(sampledMs) || sampledMs <= 0) return;
  turboChain = turboChain.catch(() => {}).then(() => new Promise((resolve) => {
    try {
      chrome.storage.local.get([TURBO_STATS_KEY], (value) => {
        if (chrome.runtime && chrome.runtime.lastError) { resolve(); return; }
        const stats = (value && value[TURBO_STATS_KEY]) || {};
        const jank = stats.pageJank || {};
        const entry = jank[host] || { count: 0, blockedMs: 0, sampledMs: 0, ring: [] };
        entry.count += count;
        entry.blockedMs += blockedMs;
        entry.sampledMs += sampledMs;
        entry.updatedAt = Date.now();
        if (!Array.isArray(entry.ring)) entry.ring = [];
        entry.ring.push({ t: entry.updatedAt, c: count, b: blockedMs, s: sampledMs });
        if (entry.ring.length > TURBO_RING_MAX) entry.ring.splice(0, entry.ring.length - TURBO_RING_MAX);
        jank[host] = entry;
        const hosts = Object.keys(jank);
        if (hosts.length > TURBO_JANK_SITES_MAX) {
          hosts.sort((a, b) => ((jank[a] && jank[a].updatedAt) || 0) - ((jank[b] && jank[b].updatedAt) || 0));
          for (const stale of hosts.slice(0, hosts.length - TURBO_JANK_SITES_MAX)) delete jank[stale];
        }
        stats.pageJank = jank;
        chrome.storage.local.set({ [TURBO_STATS_KEY]: stats }, () => resolve());
      });
    } catch (_) { resolve(); }
  }));
}

/* -------------------- warm X links (instant post opens) --------------------
 *
 * Opt-in (warmXLinksEnabled, default off). One muted background tab is kept
 * hydrated on x.com; clicking an X post/profile link on a trading site routes
 * into it via an in-page SPA navigation (~0.5s) instead of a cold tab (~3.5s).
 *
 * Single-viewer model: after a click the SAME tab stays registered as the
 * viewer, so every subsequent click is a warm SPA hop in an already-hydrated
 * page — no per-click tab churn, no idle-tab TTL bookkeeping, and nothing to
 * recycle out from under the user. Modified clicks bypass the feature in the
 * content script, so multi-tab comparison workflows still work natively.
 *
 * Reveal-first: the viewer is brought to front the moment the SPA request is
 * acked, BEFORE verification. Perceived latency is one message round-trip;
 * verification runs behind the user's eyes and repairs with a full load of the
 * same URL only if the in-page route did not actually arrive.
 *
 * The viewer tab id lives in chrome.storage.session: gone with the browser
 * session (matching the tab itself), survives service-worker restarts.
 * No alarms, no telemetry, no remote flags — the only gate is the user's own
 * toggle, and the only logging is console.debug on this machine.
 */

/** Maintainer (2026-08-05): the master switch is the PAPER switch — turning
 * PaperTrench off must NOT take the speed plane down with it. Each speed
 * feature runs on its own toggle alone. */
function warmFeatureOn(settings) {
  return settings.warmXLinksEnabled === true;
}

const WARM_IDLE_URL = 'https://x.com/home';
const WARM_SPA_TIMEOUT_MS = 6000;
const WARM_STORAGE_KEY = 'pt_warm_tab';
// Mirrors the manifest's trading-site matches; used only to decide whether
// enabling the toggle should pre-warm immediately.
const WARM_PLATFORM_URLS = [
  'https://axiom.trade/*', 'https://*.axiom.trade/*', 'https://*.padre.gg/*',
  'https://*.tinyastro.io/*', 'https://gmgn.ai/*', 'https://*.gmgn.ai/*',
  'https://*.bullx.io/*', 'https://dexscreener.com/*', 'https://*.dexscreener.com/*',
  'https://birdeye.so/*', 'https://*.birdeye.so/*', 'https://jup.ag/*',
  'https://*.jup.ag/*', 'https://pump.fun/*', 'https://*.pump.fun/*',
  'https://fomo.family/*', 'https://*.fomo.family/*',
  'https://lute.gg/*',
];

// One in-flight SPA request per viewer tab; a newer click supersedes the
// older one so a late failure can never "repair" the tab back to a stale
// target the user already clicked past.
const warmPending = new Map(); // tabId -> { requestId, url, timer }

// All read-modify-write of the viewer registration is serialized through this
// chain — the reference design declared a lock and then never used it, which
// let two rapid clicks race createTab and leak a hidden tab.
let warmChain = Promise.resolve();
function warmSerial(fn) {
  const next = warmChain.catch(() => {}).then(fn);
  warmChain = next.catch(() => {});
  return next;
}

function readWarmTab() {
  return new Promise((resolve) => chrome.storage.session.get([WARM_STORAGE_KEY], (value) => {
    if (chrome.runtime && chrome.runtime.lastError) { resolve(null); return; }
    resolve(value[WARM_STORAGE_KEY] || null);
  }));
}
function writeWarmTab(state) {
  return new Promise((resolve) => chrome.storage.session.set({ [WARM_STORAGE_KEY]: state }, () => resolve()));
}
function clearWarmTabState() {
  return new Promise((resolve) => chrome.storage.session.remove(WARM_STORAGE_KEY, () => resolve()));
}

/* D-42 (Bug 3): an armed row snipe must survive the navigation to the coin's
 * chart. The armed intent used to live ONLY in the board tab's content
 * script — "when this page context dies, the intent dies with it" — so the
 * tap-that-armed-then-navigated pattern (exactly what a sniping trader does:
 * chip, then click the coin) silently cancelled the buy: no fill, no
 * position, no chart line. The SW holds the intent in storage.session (dies
 * with the browser, like the intent always should) and the coin's own chart
 * page adopts it into its own D-39 armedBuy machinery, TTL and all. */
const ARMED_ROW_KEY = 'pt_armed_row_intent';
const ARMED_ROW_MAX = 3;
let armedRowChain = Promise.resolve();
function normalizeArmedRowIntents(value) {
  const list = Array.isArray(value) ? value : (value && value.address ? [value] : []);
  return list.filter((intent) => intent && typeof intent.address === 'string'
    && Number(intent.amount) > 0 && Number.isFinite(Number(intent.at)));
}
function readArmedRowList() {
  return new Promise((resolve) => chrome.storage.session.get([ARMED_ROW_KEY], (value) => {
    if (chrome.runtime && chrome.runtime.lastError) {
      resolve({ ok: false, list: [] });
      return;
    }
    resolve({ ok: true, list: normalizeArmedRowIntents(value[ARMED_ROW_KEY]) });
  }));
}
function readArmedRowIntent() {
  return readArmedRowList().then((read) => read.list);
}
function armedRowSerial(fn) {
  const next = armedRowChain.then(fn, fn);
  armedRowChain = next.then(() => {}, () => {});
  return next;
}
function writeArmedRowIntent(intent) {
  return armedRowSerial(async () => {
    const read = await readArmedRowList();
    if (!read.ok) return false;
    const list = read.list;
    const index = list.findIndex((item) => item.address === intent.address);
    if (index !== -1) {
      list[index] = { address: intent.address, amount: intent.amount, at: intent.at };
    } else {
      list.push({ address: intent.address, amount: intent.amount, at: intent.at });
    }
    while (list.length > ARMED_ROW_MAX) list.shift();
    await new Promise((resolve) => chrome.storage.session.set(
      { [ARMED_ROW_KEY]: list }, () => resolve(),
    ));
    return true;
  });
}
function clearArmedRowIntent(address) {
  return armedRowSerial(async () => {
    if (!address) {
      return new Promise((resolve) => chrome.storage.session.remove(ARMED_ROW_KEY, () => resolve()));
    }
    const read = await readArmedRowList();
    if (!read.ok) {
      return new Promise((resolve) => chrome.storage.session.remove(ARMED_ROW_KEY, () => resolve()));
    }
    const remaining = read.list.filter((intent) => intent.address !== address);
    if (!remaining.length) {
      return new Promise((resolve) => chrome.storage.session.remove(ARMED_ROW_KEY, () => resolve()));
    }
    return new Promise((resolve) => chrome.storage.session.set(
      { [ARMED_ROW_KEY]: remaining }, () => resolve(),
    ));
  });
}

/** The registered viewer tab, revalidated against reality: it must still exist
 * and still be on X. Anything else clears the registration — a tab the user
 * closed or navigated elsewhere is their tab, not our viewer. */
async function validWarmTab() {
  const state = await readWarmTab();
  if (!state || !Number.isFinite(state.tabId)) return null;
  let tab = null;
  try { tab = await chrome.tabs.get(state.tabId); } catch (_) { tab = null; }
  let host = '';
  try { host = new URL((tab && (tab.pendingUrl || tab.url)) || '').hostname; } catch (_) { host = ''; }
  if (!tab || !XL.isXHost(host)) {
    await clearWarmTabState();
    return null;
  }
  return { tab, state };
}

async function warmReveal(tab, url) {
  // Muted only while hidden; a viewer the user is looking at must play media
  // normally. Passing url makes this the full-load route in one call.
  const props = url ? { url, active: true, muted: false } : { active: true, muted: false };
  try { await chrome.tabs.update(tab.id, props); } catch (_) {}
  // active:true selects the tab within its window; if the viewer lives in
  // another window that window must also be focused or nothing visibly happens
  // on a multi-window setup.
  try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (_) {}
}

/** An x.com tab the user already has open can BE the viewer. Routing into it
 * is what people expect — "open it in my X tab" — and it is exactly the case
 * from the field where a lost registration made the cold path spawn a
 * duplicate x.com tab NEXT TO the one already sitting there (lev's community
 * link "opens them separately"). Never a tab the user is looking at, never a
 * pinned one, never one playing audio — those are in use, and a viewer gets
 * silently navigated by clicks and hover prefetch. Prefer a tab parked on
 * /home (nothing to lose there), then the most recently used. */
async function warmAdoptableTab() {
  const tabs = await new Promise((resolve) => chrome.tabs.query({
    url: ['https://x.com/*', 'https://*.x.com/*', 'https://twitter.com/*', 'https://*.twitter.com/*'],
  }, (result) => resolve(result || [])));
  const candidates = tabs.filter((tab) => tab && Number.isFinite(tab.id)
    && !tab.active && !tab.pinned && !tab.audible);
  if (!candidates.length) return null;
  const parked = candidates.filter((tab) => {
    try { return new URL(tab.pendingUrl || tab.url || '').pathname === '/home'; } catch (_) { return false; }
  });
  const pool = parked.length ? parked : candidates;
  return pool.reduce((best, tab) => ((tab.lastAccessed || 0) > (best.lastAccessed || 0) ? tab : best));
}

/** Ensure a viewer exists: adopt an existing X tab, else create the hidden
 * one. Callers must already hold warmSerial. Adopted tabs register as
 * used:true — they are the user's tabs, so a later toggle-off must never
 * close them. */
async function warmEnsureViewerLocked() {
  const settings = await getSettings();
  if (!warmFeatureOn(settings)) return;
  if (await validWarmTab()) return;
  const adopted = await warmAdoptableTab();
  if (adopted) {
    await writeWarmTab({ tabId: adopted.id, used: true, createdAt: Date.now() });
    console.debug('PaperTrench warm links: adopted an existing X tab as the viewer');
    return;
  }
  const tab = await chrome.tabs.create({ url: WARM_IDLE_URL, active: false });
  try { await chrome.tabs.update(tab.id, { muted: true }); } catch (_) {}
  await writeWarmTab({ tabId: tab.id, used: false, createdAt: Date.now() });
}

/** Pre-create the hidden viewer so the session's FIRST click is already warm.
 * Idempotent under warmSerial: n trading tabs announcing themselves create
 * one viewer, not n. */
function warmPrewarm() {
  return warmSerial(warmEnsureViewerLocked);
}

function warmSupersede(tabId) {
  const pending = warmPending.get(tabId);
  if (pending) {
    clearTimeout(pending.timer);
    warmPending.delete(tabId);
  }
}

function warmRepair(tabId, requestId, reason) {
  const pending = warmPending.get(tabId);
  if (!pending || pending.requestId !== requestId) return; // superseded
  warmSupersede(tabId);
  console.debug('PaperTrench warm links: SPA route failed (' + reason + '), falling back to a full load');
  chrome.tabs.update(tabId, { url: pending.url }).catch(() => {});
}

function warmSpaResult(message, sender) {
  const tabId = sender && sender.tab ? sender.tab.id : null;
  if (!Number.isFinite(tabId)) return;
  const pending = warmPending.get(tabId);
  // Results are hints from a page-adjacent world: only the tab we actually
  // messaged may report, and only for the request that is still live.
  if (!pending || pending.requestId !== message.requestId) return;
  if (message.ok === true) {
    if (message.reason === 'x_error_page') {
      console.debug('PaperTrench warm links: target renders X\'s error page (deleted post?) — shown as-is, no reload');
    }
    warmSupersede(tabId);
    return;
  }
  warmRepair(tabId, message.requestId, message.reason || 'spa_failed');
}

/** Same X page, regardless of x.com/twitter.com host or trailing slash.
 * Re-clicking a token's X link is the most common flow there is — the viewer
 * already showing that exact post must simply be revealed, never re-loaded
 * (and never even messaged: a mid-load viewer has no relay yet, and the old
 * fallback answered that with a redundant full reload of the same URL). */
function sameXTarget(a, b) {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    if (!XL.isXHost(ua.hostname) || !XL.isXHost(ub.hostname)) return false;
    return ua.pathname.replace(/\/+$/, '') === ub.pathname.replace(/\/+$/, '')
      && ua.search === ub.search;
  } catch (_) {
    return false;
  }
}

/** Open a brand-new viewer next to the tab that was clicked, when possible. */
async function warmCreateViewer(url, sender) {
  const opener = sender && sender.tab;
  if (opener && Number.isFinite(opener.id)) {
    try {
      return await chrome.tabs.create({
        url, active: true,
        windowId: opener.windowId, index: opener.index + 1, openerTabId: opener.id,
      });
    } catch (_) { /* opener window vanished mid-click */ }
  }
  return chrome.tabs.create({ url, active: true });
}

/** Hover prefetch: drive the HIDDEN viewer to the hovered target so the
 * eventual click is only a reveal. Strictly weaker than a click — it never
 * creates a tab, never reveals, never touches a viewer the user is looking
 * at, and never claims the tab as used. If the in-page route fails, the
 * normal repair full-loads the target while still hidden — which is itself a
 * prefetch: even with X's router refusing the SPA trick, the click lands on
 * a fully loaded page. A hint with no live relay does nothing at all: a
 * hover is not intent enough to spend a reload on. */
function warmHint(rawUrl, settings) {
  if (!warmFeatureOn(settings)) return Promise.resolve();
  const target = XL.classify(String(rawUrl || ''));
  if (!target) return Promise.resolve();
  return warmSerial(async () => {
    const valid = await validWarmTab();
    if (!valid) return;
    const { tab } = valid;
    if (tab.active) return;
    if (tab.discarded === true || tab.status === 'unloaded') return;
    if (sameXTarget(tab.pendingUrl || tab.url || '', target.url)) return;
    warmSupersede(tab.id);
    const requestId = 'pth-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36);
    const pending = { requestId, url: target.url, timer: null };
    warmPending.set(tab.id, pending);
    pending.timer = setTimeout(() => warmRepair(tab.id, requestId, 'hint_timeout'), WARM_SPA_TIMEOUT_MS);
    try {
      await chrome.tabs.sendMessage(tab.id, {
        type: 'pt_warm_spa',
        requestId,
        url: target.url,
        kind: target.kind,
        handle: target.handle,
        postId: target.postId,
      });
      console.debug('PaperTrench warm links: prefetch dispatched for hover target');
    } catch (_) {
      warmSupersede(tab.id);
    }
  });
}

async function warmOpen(rawUrl, sender, settings) {
  // Re-classify at this trust boundary; content-script input is not trusted.
  const target = XL.classify(String(rawUrl || ''));
  if (!target) return { ok: false, error: 'not an X post or profile URL' };

  if (!warmFeatureOn(settings)) {
    // Toggle raced off between click and message: behave like a native open.
    await warmCreateViewer(target.url, sender);
    console.debug('PaperTrench warm links: route=new_tab (feature disabled)');
    return { ok: true, route: 'new_tab' };
  }

  return warmSerial(async () => {
    const startedAt = Date.now();
    let valid = await validWarmTab();

    if (!valid) {
      // No registered viewer. Before spawning a separate tab, adopt an X tab
      // the user already keeps — the field failure was exactly a community
      // link opening in a fresh tab NEXT TO the user's own x.com tab. The
      // adopted tab goes through the normal warm route below (the relay
      // scripts run on every x.com tab, so SPA works there too).
      const adopted = await warmAdoptableTab();
      if (adopted) {
        const state = { tabId: adopted.id, used: true, createdAt: Date.now() };
        await writeWarmTab(state);
        valid = { tab: adopted, state };
        console.debug('PaperTrench warm links: route continues in an adopted X tab');
      }
    }

    if (!valid) {
      // Cold path — and the new tab immediately becomes the viewer, so only
      // the first click of a session (or after the user closes the viewer)
      // ever pays the cold price.
      const tab = await warmCreateViewer(target.url, sender);
      await writeWarmTab({ tabId: tab.id, used: true, createdAt: Date.now() });
      console.debug('PaperTrench warm links: route=cold_tab (no viewer yet; this tab is now the viewer)');
      turboNote('x:cold_tab', Date.now() - startedAt);
      return { ok: true, route: 'cold_tab' };
    }

    const { tab, state } = valid;
    warmSupersede(tab.id);

    // Already showing (or already loading) this exact target: reveal, done.
    if (sameXTarget(tab.pendingUrl || tab.url || '', target.url)) {
      await warmReveal(tab);
      await writeWarmTab({ ...state, used: true });
      console.debug('PaperTrench warm links: route=already_open');
      turboNote('x:already_open', Date.now() - startedAt);
      return { ok: true, route: 'already_open' };
    }

    // A tab Chrome discarded under memory pressure has no live content scripts
    // to SPA through — but a full load in it still beats a cold tab (process,
    // connections, and X's service-worker cache are warm).
    if (tab.discarded === true || tab.status === 'unloaded') {
      await warmReveal(tab, target.url);
      await writeWarmTab({ ...state, used: true });
      console.debug('PaperTrench warm links: route=warm_reload (viewer was discarded)');
      turboNote('x:warm_reload', Date.now() - startedAt);
      return { ok: true, route: 'warm_reload' };
    }

    const requestId = 'ptw-' + startedAt.toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36);
    const pending = { requestId, url: target.url, timer: null };
    warmPending.set(tab.id, pending);
    pending.timer = setTimeout(() => warmRepair(tab.id, requestId, 'timeout'), WARM_SPA_TIMEOUT_MS);

    // SPA request and reveal fire CONCURRENTLY — the ack round-trip is off
    // the critical path; verification and any repair happen behind the
    // user's eyes.
    const acked = chrome.tabs.sendMessage(tab.id, {
      type: 'pt_warm_spa',
      requestId,
      url: target.url,
      kind: target.kind,
      handle: target.handle,
      postId: target.postId,
    }).then(() => true, () => false);
    await warmReveal(tab);
    await writeWarmTab({ ...state, used: true });

    if (!(await acked)) {
      // No relay in the tab (still loading, or scripts not injected yet).
      // Already revealed; just drive the full load.
      warmSupersede(tab.id);
      try { await chrome.tabs.update(tab.id, { url: target.url }); } catch (_) {}
      console.debug('PaperTrench warm links: route=warm_reload (no relay in viewer)');
      turboNote('x:warm_reload', Date.now() - startedAt);
      return { ok: true, route: 'warm_reload' };
    }

    console.debug('PaperTrench warm links: SPA route dispatched in ' + (Date.now() - startedAt) + 'ms');
    turboNote('x:spa', Date.now() - startedAt);
    return { ok: true, route: 'spa' };
  });
}

/* Hover tweet cards: X's public oEmbed endpoint returns a post's author and
 * text for any status URL — no auth, no cookies, and `dnt=1` asks for no
 * tracking. Fetched from the worker (host_permissions covers it), cached hard
 * (positive AND gone results — a deleted post stays deleted), and requested
 * only on the same hover dwell that fires the prefetch, never on the click
 * path. A 404 here is the pre-click rug signal: the card can say "post
 * unavailable" before the trader spends a click on it.
 * This is PaperTrench's ONLY third-party call besides the price APIs and the
 * user's own endpoints — documented in docs/PERMISSIONS.md and README. */
const WARM_OEMBED_URL = 'https://publish.twitter.com/oembed';
const WARM_OEMBED_TIMEOUT_MS = 3500;
const WARM_OEMBED_CACHE_MAX = 200;
const warmOembedCache = new Map(); // canonical post url -> result

function decodeOembedEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&mdash;/g, '—');
}

/** Text + date out of the oEmbed blockquote HTML. No DOM in a worker, so
 * this is string surgery on a format that has been stable for a decade. */
function parseOembedHtml(html) {
  const p = /<p[^>]*>([\s\S]*?)<\/p>/.exec(String(html));
  const text = p
    ? decodeOembedEntities(p[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''))
    : '';
  const date = /<\/p>[\s\S]*?<a[^>]*>([^<]+)<\/a>\s*<\/blockquote>/.exec(String(html));
  return { text: text.slice(0, 600), date: date ? decodeOembedEntities(date[1]) : null };
}

async function warmOembed(rawUrl, settings) {
  if (!warmFeatureOn(settings)) return { ok: false };
  const target = XL.classify(String(rawUrl || ''));
  if (!target || target.kind !== 'post') return { ok: false }; // oEmbed does posts only
  const cached = warmOembedCache.get(target.url);
  if (cached) return cached;

  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), WARM_OEMBED_TIMEOUT_MS);
  let result = null;
  try {
    const response = await fetch(
      WARM_OEMBED_URL + '?omit_script=1&dnt=1&hide_thread=1&url=' + encodeURIComponent(target.url),
      { signal: controller.signal, redirect: 'follow' }
    );
    if (response.status === 404 || response.status === 403) {
      result = { ok: true, gone: true, url: target.url };
    } else if (response.ok) {
      const json = await response.json();
      const parsed = parseOembedHtml(json.html || '');
      result = {
        ok: true, gone: false, url: target.url,
        authorName: String(json.author_name || '').slice(0, 80),
        text: parsed.text, date: parsed.date,
      };
    }
  } catch (_) {
    // Network trouble: report nothing and cache nothing — the next hover may
    // succeed, and the card simply not appearing costs the user zero.
  } finally {
    clearTimeout(abortTimer);
  }
  if (!result) return { ok: false };
  if (warmOembedCache.size >= WARM_OEMBED_CACHE_MAX) {
    warmOembedCache.delete(warmOembedCache.keys().next().value);
  }
  warmOembedCache.set(target.url, result);
  return result;
}

async function warmSettingsChanged(settings) {
  if (warmFeatureOn(settings)) {
    // Toggled on with trading tabs already open? Warm up right away.
    const tabs = await new Promise((resolve) => chrome.tabs.query({ url: WARM_PLATFORM_URLS }, (result) => resolve(result || [])));
    if (tabs.length) warmPrewarm().catch(() => {});
    return;
  }
  const state = await readWarmTab();
  if (!state) return;
  await clearWarmTabState();
  // Only an idle, never-used, still-hidden viewer is ours to close. Once used
  // (or found and focused by the user) the tab belongs to the user.
  if (state.used) return;
  try {
    const tab = await chrome.tabs.get(state.tabId);
    if (tab && !tab.active) await chrome.tabs.remove(state.tabId);
  } catch (_) { /* already gone */ }
}

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  warmSupersede(tabId);
  warmSerial(async () => {
    const state = await readWarmTab();
    if (!state || state.tabId !== tabId) return;
    await clearWarmTabState();
    // An accidentally-closed viewer must not degrade the feature until the
    // user rediscovers the toggle ("I closed the x tab and had to turn
    // instant mode off and on to get the hot tab open" — lev). While the
    // toggle is on and a trading tab is open, a fresh hidden viewer takes
    // its place immediately; turning the feature off remains the one way to
    // not have a viewer. A closing WINDOW is the browser going away, not the
    // user aiming at our tab — never spawn tabs into a shutdown.
    if (removeInfo && removeInfo.isWindowClosing) return;
    const settings = await getSettings();
    if (!warmFeatureOn(settings)) return;
    const trading = await new Promise((resolve) => chrome.tabs.query({ url: WARM_PLATFORM_URLS }, (result) => resolve(result || [])));
    if (!trading.length) return;
    await warmEnsureViewerLocked();
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'loading') return;
  warmSerial(async () => {
    const state = await readWarmTab();
    if (!state || state.tabId !== tabId) return;
    const url = changeInfo.url || (tab && (tab.pendingUrl || tab.url)) || '';
    if (!url) return;
    let host = '';
    try { host = new URL(url).hostname; } catch (_) { host = ''; }
    if (!XL.isXHost(host)) {
      // The user steered the viewer off X — release it, it is theirs.
      warmSupersede(tabId);
      await clearWarmTabState();
    }
  });
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  warmSerial(async () => {
    const state = await readWarmTab();
    if (!state || state.tabId !== activeInfo.tabId || state.used) return;
    // The user found the hidden idle tab on their own: unmute it and mark it
    // used so a later toggle-off will not close a tab they are reading.
    await writeWarmTab({ ...state, used: true });
    try { await chrome.tabs.update(activeInfo.tabId, { muted: false }); } catch (_) {}
  });
});

/* ------------- warm destination viewers (Instant Everything links) --------
 *
 * Turbo Tier 1: the X viewer generalized to the two NON-X cold destinations
 * every token row on the supported terminals carries — pump.fun and solscan.
 * Opt-in (warmEverywhereEnabled, default off), and structurally simpler than
 * the X route on purpose:
 *
 *   - One kept-warm muted tab per family, registered in storage.session.
 *   - Clicks route as a FULL navigation in the warm tab (tabs.update + reveal).
 *     No SPA relay: solscan carries no PaperTrench scripts at all, and a full
 *     load in an already-hot renderer (live connections, HTTP cache, service
 *     worker) is the honest, unbreakable version of fast for these sites.
 *   - Hover prefetch navigates the HIDDEN viewer only. Hints never create
 *     tabs, never touch a tab the user is looking at (X contract, verbatim).
 *   - Same ownership rules: used/found tabs belong to the user; toggle-off
 *     closes only a never-used, still-hidden viewer. A closed viewer does NOT
 *     respawn (unlike X): two respawning background tabs would read as an
 *     infestation — the next click simply recreates its viewer cold.
 *
 * The X path above is untouched: different messages, different storage keys,
 * shared warmSerial (tab bookkeeping stays single-file) and shared warmReveal.
 */

const WD = self.PTWarmDest;

function warmDestFeatureOn(settings) {
  return settings.warmEverywhereEnabled === true;
}

const WARM_DEST_FAMILIES = {
  // EVERY family is click-created now — idleUrl is dead by doctrine. The
  // pump.fun/Solscan pair used to pre-create at trading-page load "so the
  // session's first click is warm", and users kept reading the appearing
  // tabs as a malfunction: Eyes343 ("open every time you open/refresh the
  // DEX", patched with a session-scoped closed-marker) and then TRNC anyway
  // ("when i load up it randomly opens solscan and pump.fun website") —
  // the session marker evaporates with every browser restart, so the tabs
  // came back each morning by construction. Two independent reports of the
  // same confusion is the answer: PaperTrench never opens a tab the user
  // did not click for. The first click pays cold and becomes the viewer;
  // every click after that is warm; hover hints only ever navigate a
  // viewer that a real click created.
  pumpfun: {
    storageKey: 'pt_warm_tab_pumpfun',
    idleUrl: null,
    hostRe: /(^|\.)pump\.fun$/,
    label: 'pump.fun',
  },
  solscan: {
    storageKey: 'pt_warm_tab_solscan',
    idleUrl: null,
    hostRe: /(^|\.)solscan\.io$/,
    label: 'Solscan',
  },
  // The main terminals (maintainer's call: Padre, Axiom, GMGN). Terminal
  // pages are HEAVY besides: pre-creation here would mean up to five muted
  // background tabs, which reads as an infestation, not a feature.
  axiom: {
    storageKey: 'pt_warm_tab_axiom',
    idleUrl: null,
    hostRe: /(^|\.)axiom\.trade$/,
    label: 'Axiom',
  },
  padre: {
    storageKey: 'pt_warm_tab_padre',
    idleUrl: null,
    hostRe: /(^|\.)padre\.gg$/,
    label: 'Padre',
  },
  gmgn: {
    storageKey: 'pt_warm_tab_gmgn',
    idleUrl: null,
    hostRe: /(^|\.)gmgn\.ai$/,
    label: 'GMGN',
  },
  // Terminal rules apply, plus one of fomo's own: token pages are
  // login-gated, so a pre-created viewer would idle on the marketing shell
  // for logged-out users. Click-created only, like every terminal.
  fomo: {
    storageKey: 'pt_warm_tab_fomo',
    idleUrl: null,
    hostRe: /(^|\.)fomo\.family$/,
    label: 'Fomo',
  },
  // Turbo II: the rest of the supported-terminal matrix. Terminal rules,
  // verbatim — click-created only, never pre-warmed. Dexscreener and Birdeye
  // are lighter pages than the trade terminals, but "prewarm reads as an
  // infestation" is about tab count, not page weight, so they follow suit.
  bullx: {
    storageKey: 'pt_warm_tab_bullx',
    idleUrl: null,
    hostRe: /(^|\.)bullx\.io$/,
    label: 'BullX',
  },
  photon: {
    storageKey: 'pt_warm_tab_photon',
    idleUrl: null,
    hostRe: /(^|\.)tinyastro\.io$/,
    label: 'Photon',
  },
  dexscreener: {
    storageKey: 'pt_warm_tab_dexscreener',
    idleUrl: null,
    hostRe: /(^|\.)dexscreener\.com$/,
    label: 'Dexscreener',
  },
  birdeye: {
    storageKey: 'pt_warm_tab_birdeye',
    idleUrl: null,
    hostRe: /(^|\.)birdeye\.so$/,
    label: 'Birdeye',
  },
  jupiter: {
    storageKey: 'pt_warm_tab_jupiter',
    idleUrl: null,
    hostRe: /(^|\.)jup\.ag$/,
    label: 'Jupiter',
  },
  lute: {
    storageKey: 'pt_warm_tab_lute',
    idleUrl: null,
    hostRe: /(^|\.)lute\.gg$/,
    label: 'Lute',
  },
};

function readWarmDestTab(family) {
  const spec = WARM_DEST_FAMILIES[family];
  return new Promise((resolve) => chrome.storage.session.get([spec.storageKey], (value) => {
    if (chrome.runtime && chrome.runtime.lastError) { resolve(null); return; }
    resolve(value[spec.storageKey] || null);
  }));
}
function writeWarmDestTab(family, state) {
  const spec = WARM_DEST_FAMILIES[family];
  return new Promise((resolve) => chrome.storage.session.set({ [spec.storageKey]: state }, () => resolve()));
}
function clearWarmDestTab(family) {
  const spec = WARM_DEST_FAMILIES[family];
  return new Promise((resolve) => chrome.storage.session.remove(spec.storageKey, () => resolve()));
}

/** The family's registered viewer, revalidated against reality (the X rule:
 * a tab the user closed or steered elsewhere is theirs, not our viewer). */
async function validWarmDestTab(family) {
  const spec = WARM_DEST_FAMILIES[family];
  const state = await readWarmDestTab(family);
  if (!state || !Number.isFinite(state.tabId)) return null;
  let tab = null;
  try { tab = await chrome.tabs.get(state.tabId); } catch (_) { tab = null; }
  let host = '';
  try { host = new URL((tab && (tab.pendingUrl || tab.url)) || '').hostname; } catch (_) { host = ''; }
  if (!tab || !spec.hostRe.test(host)) {
    await clearWarmDestTab(family);
    return null;
  }
  return { tab, state };
}

function sameDestUrl(a, b) {
  try {
    const ua = new URL(a); const ub = new URL(b);
    return ua.hostname.replace(/^www\./, '') === ub.hostname.replace(/^www\./, '')
      && ua.pathname.replace(/\/+$/, '') === ub.pathname.replace(/\/+$/, '')
      && ua.search === ub.search;
  } catch (_) { return false; }
}

async function warmDestOpen(rawUrl, sender, settings) {
  // Trust boundary: the terminal-side world only SUGGESTS a URL; what
  // navigates is what the shared classifier re-derives here.
  const target = WD && WD.classify(String(rawUrl || ''));
  if (!target) return { ok: false, reason: 'unclassified' };

  const createNext = async (active) => {
    const props = { url: target.url, active };
    if (sender && sender.tab) {
      props.windowId = sender.tab.windowId;
      props.index = sender.tab.index + 1;
      props.openerTabId = sender.tab.id;
    }
    try { return await chrome.tabs.create(props); }
    catch (_) { return chrome.tabs.create({ url: target.url, active }); }
  };

  if (!warmDestFeatureOn(settings)) {
    await createNext(true);
    return { ok: true, route: 'new_tab' };
  }

  return warmSerial(async () => {
    const startedAt = Date.now();
    // A real click is the user re-requesting this destination — it lifts the
    // stay-closed marker the closed viewer left behind.
    await writeWarmDestClosed(target.family, false);
    const valid = await validWarmDestTab(target.family);
    if (!valid) {
      // Cold path — the new tab immediately becomes the family viewer, so
      // only the FIRST open pays the cold price.
      const tab = await createNext(true);
      if (tab && Number.isFinite(tab.id)) {
        await writeWarmDestTab(target.family, { tabId: tab.id, used: true, createdAt: Date.now() });
      }
      console.debug('PaperTrench warm dest: route=cold_tab (' + target.family + ')');
      turboNote('dest:cold_tab', Date.now() - startedAt);
      return { ok: true, route: 'cold_tab' };
    }

    const { tab, state } = valid;
    const already = sameDestUrl((tab.pendingUrl || tab.url || ''), target.url);
    // Full-load route in one call: reveal carries the url unless the viewer
    // is already parked on the exact target.
    await warmReveal(tab, already ? undefined : target.url);
    await writeWarmDestTab(target.family, { ...state, used: true });
    console.debug('PaperTrench warm dest: route=' + (already ? 'already_open' : 'warm_nav')
      + ' (' + target.family + ') in ' + (Date.now() - startedAt) + 'ms');
    turboNote(already ? 'dest:already_open' : 'dest:warm_nav', Date.now() - startedAt);
    return { ok: true, route: already ? 'already_open' : 'warm_nav' };
  });
}

/** Hover prefetch: strictly weaker than a click. Never creates a tab, never
 * reveals, never navigates a tab the user is actually looking at. */
async function warmDestHint(rawUrl, settings) {
  if (!warmDestFeatureOn(settings)) return;
  const target = WD && WD.classify(String(rawUrl || ''));
  if (!target) return;
  return warmSerial(async () => {
    const valid = await validWarmDestTab(target.family);
    if (!valid) return;
    const { tab } = valid;
    if (tab.active) return;
    if (sameDestUrl((tab.pendingUrl || tab.url || ''), target.url)) return;
    try { await chrome.tabs.update(tab.id, { url: target.url }); } catch (_) {}
  });
}

/* The user closing a viewer is an instruction, not an accident. Community
 * report (Eyes343, 2026-08-05): pump.fun + Solscan "open every time you
 * open/refresh the DEX" — the per-page settings edge in warm-links.js fires
 * pt_warmdest_prewarm on EVERY trading-page load, and prewarm recreated any
 * missing viewer, including ones the user had just closed. The click path
 * already honored "a closed viewer does NOT respawn"; prewarm now does too:
 * a session-scoped closed marker blocks re-creation until the user actually
 * asks for that destination again (a real click clears it). */
function warmDestClosedKey(family) {
  return WARM_DEST_FAMILIES[family].storageKey + '_closed';
}
function readWarmDestClosed(family) {
  return new Promise((resolve) => chrome.storage.session.get([warmDestClosedKey(family)], (value) => {
    if (chrome.runtime && chrome.runtime.lastError) { resolve(false); return; }
    resolve(Boolean(value[warmDestClosedKey(family)]));
  }));
}
function writeWarmDestClosed(family, closed) {
  return new Promise((resolve) => {
    if (closed) chrome.storage.session.set({ [warmDestClosedKey(family)]: Date.now() }, () => resolve());
    else chrome.storage.session.remove(warmDestClosedKey(family), () => resolve());
  });
}

// warmDestPrewarm used to live here — pre-creating the pump.fun/Solscan
// viewers at trading-page load. Removed with the idleUrl doctrine change
// above: viewer creation is click-only, everywhere, so no code path may
// create a destination tab outside warmDestOpen.

async function warmDestSettingsChanged(settings) {
  if (warmDestFeatureOn(settings)) {
    return;
  }
  for (const family of Object.keys(WARM_DEST_FAMILIES)) {
    const state = await readWarmDestTab(family);
    if (!state) continue;
    await clearWarmDestTab(family);
    if (state.used) continue; // used or user-found tabs are the user's
    try {
      const tab = await chrome.tabs.get(state.tabId);
      if (tab && !tab.active) await chrome.tabs.remove(state.tabId);
    } catch (_) { /* already gone */ }
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  warmSerial(async () => {
    for (const family of Object.keys(WARM_DEST_FAMILIES)) {
      const state = await readWarmDestTab(family);
      if (state && state.tabId === tabId) {
        await clearWarmDestTab(family);
        // Only the USER closes a tab we still track: our own toggle-off path
        // clears the record before removing the tab. Remember the closure so
        // prewarm stops resurrecting it (Eyes343's "opens on every refresh").
        await writeWarmDestClosed(family, true);
      }
    }
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'loading') return;
  warmSerial(async () => {
    for (const family of Object.keys(WARM_DEST_FAMILIES)) {
      const state = await readWarmDestTab(family);
      if (!state || state.tabId !== tabId) continue;
      const url = changeInfo.url || (tab && (tab.pendingUrl || tab.url)) || '';
      if (!url) continue;
      let host = '';
      try { host = new URL(url).hostname; } catch (_) { host = ''; }
      if (!WARM_DEST_FAMILIES[family].hostRe.test(host)) {
        // The user steered the viewer off its family — release it, it is theirs.
        await clearWarmDestTab(family);
      }
    }
  });
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  warmSerial(async () => {
    for (const family of Object.keys(WARM_DEST_FAMILIES)) {
      const state = await readWarmDestTab(family);
      if (!state || state.tabId !== activeInfo.tabId || state.used) continue;
      await writeWarmDestTab(family, { ...state, used: true });
      try { await chrome.tabs.update(activeInfo.tabId, { muted: false }); } catch (_) {}
    }
  });
});

/* ------------- Instant Links beyond the terminals (opt-in spread) ---------
 *
 * Turbo II: token and X links do not only appear on trading sites — they get
 * pasted into Discord channels and Telegram chats all day. With a per-site
 * opt-in, the SAME interceptor bundle (classifiers + warm-links, ISOLATED
 * world only, no MAIN-world hook) registers on those sites at runtime via
 * chrome.scripting.
 *
 * The O-09 line survives intact: the MANIFEST's content scripts stay narrow,
 * nothing injects anywhere by default, and every registration below exists
 * only while its own toggle is on. "Every site" is the maximal opt-in — it
 * still excludes the terminals and x.com (their built-ins own those), and the
 * interceptor's own contract holds everywhere it lands: only a classified
 * token/X link is ever touched, every other click stays native, and a dead
 * classifier means a native click, never a swallowed one.
 */

const INSTANT_SITE_JS = ['xlinks.js', 'warmdest.js', 'trajectory.js', 'warm-links.js'];
const INSTANT_SITE_SPECS = [
  {
    id: 'pt-instant-discord',
    settingsKey: 'instantDiscordEnabled',
    matches: ['https://discord.com/*', 'https://*.discord.com/*'],
  },
  {
    id: 'pt-instant-telegram',
    settingsKey: 'instantTelegramEnabled',
    matches: ['https://web.telegram.org/*'],
  },
  {
    id: 'pt-instant-everywhere',
    settingsKey: 'instantAllSitesEnabled',
    matches: ['https://*/*'],
    // The terminals and X keep their static built-ins (double injection is
    // guarded in warm-links.js, but clean registration beats a guard), and
    // the dashboard's own site never needs an interceptor.
    excludeMatches: [
      ...WARM_PLATFORM_URLS,
      'https://x.com/*', 'https://*.x.com/*',
      'https://twitter.com/*', 'https://*.twitter.com/*',
      'https://papertrench.com/*', 'https://www.papertrench.com/*',
    ],
  },
];

let instantChain = Promise.resolve();
function instantSerial(fn) {
  const next = instantChain.catch(() => {}).then(fn);
  instantChain = next.catch(() => {});
  return next;
}

/** Make reality match the toggles: register what is wanted, unregister what
 * is not. Idempotent — safe to run at every worker start and settings save. */
function instantSitesReconcile() {
  return instantSerial(async () => {
    if (!chrome.scripting || !chrome.scripting.getRegisteredContentScripts) return;
    const settings = await getSettings();
    const wantedIds = new Set(INSTANT_SITE_SPECS
      .filter((spec) => settings[spec.settingsKey] === true)
      .map((spec) => spec.id));
    let existing = [];
    try {
      existing = await chrome.scripting.getRegisteredContentScripts({
        ids: INSTANT_SITE_SPECS.map((spec) => spec.id),
      });
    } catch (_) { existing = []; }
    const existingIds = new Set(existing.map((script) => script.id));
    const drop = [...existingIds].filter((id) => !wantedIds.has(id));
    if (drop.length) {
      try { await chrome.scripting.unregisterContentScripts({ ids: drop }); } catch (_) {}
    }
    const add = INSTANT_SITE_SPECS.filter((spec) => wantedIds.has(spec.id) && !existingIds.has(spec.id));
    if (add.length) {
      try {
        await chrome.scripting.registerContentScripts(add.map((spec) => ({
          id: spec.id,
          matches: spec.matches,
          excludeMatches: spec.excludeMatches,
          js: INSTANT_SITE_JS,
          runAt: 'document_idle',
          persistAcrossSessions: true,
        })));
      } catch (_) {}
    }
  });
}

// Registrations persist across sessions; the worker-start reconcile exists
// for the update path (this build introducing the feature) and for settings
// that changed while no worker was alive to hear pt_settings_changed.
instantSitesReconcile().catch(() => {});

/* -------------------- X-Ray (account intel ledger) --------------------
 *
 * Opt-in (xrayEnabled, default off). The x.com MAIN world digests the page's
 * OWN GraphQL responses into derived facts; this worker is the ledger that
 * remembers them across visits and the arbiter that decides whether a deep
 * scan may spend a request.
 *
 * Three properties this section is responsible for:
 *
 *  - REVALIDATION. A digest arrives from a page-adjacent world, so every
 *    field is re-checked here before it can touch stored state. A hostile
 *    page can, at worst, write plausible-looking entries about accounts into
 *    a local ledger — no request is issued on its say-so beyond the budget
 *    below, and nothing leaves the device.
 *  - BUDGET. Deep scans are bounded per account (cooldown) and globally
 *    (a rolling per-minute cap) and are only ever executed by the page
 *    itself, with its own session, against its own origin. This worker never
 *    issues an X request — X-Ray adds no network call to the service worker.
 *  - HONEST STORAGE. Watch-window history is what THIS device saw, and the
 *    first sighting timestamp is never overwritten, so the panel can always
 *    say how long "no change seen" has actually been true for.
 */

const XRAY_STORAGE_KEY = 'pt_xray';
const XRAY_SCAN_COOLDOWN_MS = 6 * 60 * 60 * 1000; // per account, per op
const XRAY_SCAN_PER_MINUTE = 10;
const XRAY_TWEET_PAGES = 4; // deep-scan paging depth per profile visit
const xrayScanStamps = [];
const xrayPending = new Map(); // requestId -> { restId, op, plannedAt }

function xrayFeatureOn(settings) {
  // Speed plane: X-Ray survives "PaperTrench off" on its own toggle.
  return settings.xrayEnabled === true;
}

let xrayChain = Promise.resolve();
function xraySerial(fn) {
  const next = xrayChain.catch(() => {}).then(fn);
  xrayChain = next.catch(() => {});
  return next;
}

function readLedger() {
  return new Promise((resolve) => chrome.storage.local.get([XRAY_STORAGE_KEY], (value) => {
    if (chrome.runtime && chrome.runtime.lastError) { resolve(XR.emptyLedger()); return; }
    const stored = value[XRAY_STORAGE_KEY];
    if (!stored || typeof stored !== 'object') { resolve(XR.emptyLedger()); return; }
    resolve({
      accounts: stored.accounts && typeof stored.accounts === 'object' ? stored.accounts : {},
      handleIdx: stored.handleIdx && typeof stored.handleIdx === 'object' ? stored.handleIdx : {},
      order: Array.isArray(stored.order) ? stored.order : [],
      ops: stored.ops && typeof stored.ops === 'object' ? stored.ops : {},
    });
  }));
}

function writeLedger(ledger) {
  return new Promise((resolve) => chrome.storage.local.set({ [XRAY_STORAGE_KEY]: ledger }, () => resolve()));
}

/* ---- revalidation of page-adjacent input ---- */

const XRAY_HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
const XRAY_ID_RE = /^\d{1,25}$/;

function xrayCleanUser(u) {
  if (!u || typeof u !== 'object') return null;
  if (!XRAY_ID_RE.test(String(u.restId)) || !XRAY_HANDLE_RE.test(String(u.handle))) return null;
  const text = (v, cap) => (typeof v === 'string' ? v.slice(0, cap) : null);
  const count = (v) => (Number.isFinite(v) && v >= 0 && v < 1e10 ? Math.floor(v) : null);
  const stamp = (v) => (Number.isFinite(v) && v > 0 && v < 4102444800000 ? v : null);
  const avatar = typeof u.avatar === 'string' && /^https:\/\//.test(u.avatar) ? u.avatar.slice(0, 300) : null;
  return {
    restId: String(u.restId),
    handle: String(u.handle),
    name: text(u.name, XR.LIMITS.nameChars),
    bio: text(u.bio, XR.LIMITS.bioChars),
    urls: Array.isArray(u.urls) ? u.urls.filter((x) => typeof x === 'string').slice(0, 12).map((x) => x.slice(0, 600)) : [],
    avatar,
    createdAt: stamp(u.createdAt),
    followers: count(u.followers),
    following: count(u.following),
    verified: u.verified === true,
  };
}

function xrayCleanTweet(t) {
  if (!t || typeof t !== 'object') return null;
  if (!XRAY_ID_RE.test(String(t.id))) return null;
  const cas = Array.isArray(t.cas)
    ? t.cas.filter((c) => isSolanaAddress(c)).slice(0, 12)
    : [];
  return {
    id: String(t.id),
    authorId: XRAY_ID_RE.test(String(t.authorId)) ? String(t.authorId) : null,
    createdAt: Number.isFinite(t.createdAt) && t.createdAt > 0 && t.createdAt < 4102444800000 ? t.createdAt : null,
    cas,
  };
}

function xrayCleanDigest(digest) {
  if (!digest || typeof digest !== 'object') return null;
  if (typeof digest.op !== 'string' || !XR.OPS.has(digest.op)) return null;
  const users = (Array.isArray(digest.users) ? digest.users : [])
    .slice(0, XR.LIMITS.maxUsersPerDigest).map(xrayCleanUser).filter(Boolean);
  const tweets = (Array.isArray(digest.tweets) ? digest.tweets : [])
    .slice(0, XR.LIMITS.maxTweetsPerDigest).map(xrayCleanTweet).filter(Boolean);
  let opShape = null;
  if (digest.opShape && typeof digest.opShape === 'object'
      && typeof digest.opShape.op === 'string' && XR.REPLAY_OPS.has(digest.opShape.op)
      && typeof digest.opShape.url === 'string'
      && digest.opShape.headers && typeof digest.opShape.headers === 'object') {
    let sameOrigin = false;
    try { sameOrigin = XL.isXHost(new URL(digest.opShape.url).hostname); } catch (_) { sameOrigin = false; }
    if (sameOrigin) {
      const headers = {};
      for (const k of Object.keys(digest.opShape.headers).slice(0, 8)) {
        const v = digest.opShape.headers[k];
        if (typeof v === 'string') headers[String(k).toLowerCase().slice(0, 40)] = v.slice(0, 400);
      }
      opShape = { op: digest.opShape.op, url: digest.opShape.url.slice(0, 2000), headers };
    }
  }
  return {
    op: digest.op,
    users,
    tweets,
    cursor: typeof digest.cursor === 'string' ? digest.cursor.slice(0, 400) : null,
    subjectRestId: XRAY_ID_RE.test(String(digest.subjectRestId)) ? String(digest.subjectRestId) : null,
    followersTarget: XRAY_ID_RE.test(String(digest.followersTarget)) ? String(digest.followersTarget) : null,
    scan: digest.scan && typeof digest.scan === 'object' && typeof digest.scan.requestId === 'string'
      ? { requestId: digest.scan.requestId.slice(0, 80), status: digest.scan.status }
      : null,
    opShape,
  };
}

/** The account a digest is about, resolved against the route the panel says
 * it is on. Route handle wins where the payload is ambiguous — a follower
 * list contains a hundred users and only one of them is the subject. */
function xraySubjectId(ledger, digest, routeHandle) {
  if (digest.subjectRestId) return digest.subjectRestId;
  if (digest.followersTarget) return digest.followersTarget;
  if (routeHandle && XRAY_HANDLE_RE.test(routeHandle)) {
    const known = ledger.handleIdx[routeHandle.toLowerCase()];
    if (known) return known;
    const hit = digest.users.find((u) => u.handle.toLowerCase() === routeHandle.toLowerCase());
    if (hit) return hit.restId;
  }
  return null;
}

function xrayRecordFor(ledger, user, now) {
  const existing = ledger.accounts[user.restId] || null;
  const { record, changed } = XR.observeUser(existing, user, now);
  ledger.accounts[user.restId] = record;
  ledger.handleIdx[record.handle] = record.restId;
  XR.touchAccount(ledger, record.restId);
  return { record, changed };
}

async function xrayObserve(message, settings) {
  if (!xrayFeatureOn(settings)) return { ok: false };
  const digest = xrayCleanDigest(message.digest);
  if (!digest) return { ok: false };
  const routeHandle = typeof message.handle === 'string' && XRAY_HANDLE_RE.test(message.handle)
    ? message.handle.toLowerCase() : null;

  return xraySerial(async () => {
    const now = Date.now();
    const ledger = await readLedger();

    if (digest.opShape) {
      ledger.ops[digest.opShape.op] = {
        url: digest.opShape.url, headers: digest.opShape.headers, at: now,
      };
    }
    if (digest.scan) {
      const pending = xrayPending.get(digest.scan.requestId);
      if (pending) {
        xrayPending.delete(digest.scan.requestId);
        const failed = digest.scan.status !== 200;
        const record = ledger.accounts[pending.restId];
        if (record) record.lastDeepScanAt = now;
        if (failed && (digest.scan.status === 'no_shape' || Number(digest.scan.status) >= 400)) {
          // The remembered shape no longer works (X rotated its query id, or
          // rate-limited us). Forget it rather than retry it every visit.
          delete ledger.ops[pending.op];
        }
      }
    }

    // Every user in the payload gets its own record — that is what makes a
    // notable follower's own history available the moment you click through.
    for (const user of digest.users) xrayRecordFor(ledger, user, now);

    const subjectId = xraySubjectId(ledger, digest, routeHandle);
    let intel = null;
    let scanAgain = false;

    if (subjectId && ledger.accounts[subjectId]) {
      const record = ledger.accounts[subjectId];
      XR.observeTweets(record, digest.tweets, now);

      if (XR.FOLLOWER_OPS.has(digest.op) && digest.followersTarget === subjectId) {
        const source = digest.op === 'FollowersYouKnow' ? 'you_follow' : 'followers';
        const others = digest.users.filter((u) => u.restId !== subjectId && u.followers !== null);
        if (others.length) XR.mergeSmart(record, others, source, now);
      }
      if (digest.cursor && (digest.op === 'UserTweets' || digest.op === 'UserTweetsAndReplies')) {
        record.scanCursor = digest.cursor;
      }
      XR.touchAccount(ledger, subjectId);
      intel = XR.assembleIntel(record, now);
      scanAgain = digest.scan !== null && digest.scan.status === 200;
    }

    await writeLedger(ledger);
    return { ok: true, intel, scanAgain };
  });
}

async function xrayGet(message, settings) {
  if (!xrayFeatureOn(settings)) return { ok: false };
  const handle = typeof message.handle === 'string' && XRAY_HANDLE_RE.test(message.handle)
    ? message.handle.toLowerCase() : null;
  if (!handle) return { ok: false };
  const ledger = await readLedger();
  const restId = ledger.handleIdx[handle];
  const record = restId ? ledger.accounts[restId] : null;
  if (!record) return { ok: true, intel: null };
  return { ok: true, intel: XR.assembleIntel(record, Date.now()) };
}

/** Decide the ONE request (if any) worth spending on this account right now.
 * Preference order: tweet history first (CA history is the highest-value
 * missing piece and needs paging), then the followers-you-know edge, then a
 * follower page. Returns null when the budget says no — the passive layer
 * keeps working regardless. */
async function xrayPlan(message, settings) {
  if (!xrayFeatureOn(settings)) return { ok: false };
  if (settings.xrayDeepScanEnabled === false) return { ok: true, scan: null };
  if (!XRAY_ID_RE.test(String(message.restId))) return { ok: false };

  const now = Date.now();
  while (xrayScanStamps.length && now - xrayScanStamps[0] > 60_000) xrayScanStamps.shift();
  if (xrayScanStamps.length >= XRAY_SCAN_PER_MINUTE) return { ok: true, scan: null };
  for (const [id, pending] of xrayPending) {
    if (now - pending.plannedAt > 30_000) xrayPending.delete(id);
  }
  if (xrayPending.size >= 2) return { ok: true, scan: null };

  return xraySerial(async () => {
    const ledger = await readLedger();
    const record = ledger.accounts[String(message.restId)];
    if (!record) return { ok: true, scan: null };

    let op = null;
    let cursor = null;
    const pagesLeft = (record.tweetRing.length / 20) < XRAY_TWEET_PAGES;
    if (record.scanCursor && pagesLeft && ledger.ops.UserTweets) {
      op = 'UserTweets';
      cursor = record.scanCursor;
    } else if (now - (record.lastDeepScanAt || 0) > XRAY_SCAN_COOLDOWN_MS) {
      if (!record.smartAt && ledger.ops.FollowersYouKnow) op = 'FollowersYouKnow';
      else if (!record.smartAt && ledger.ops.BlueVerifiedFollowers) op = 'BlueVerifiedFollowers';
      else if (!record.tweetRing.length && ledger.ops.UserTweets) op = 'UserTweets';
    }
    if (!op) return { ok: true, scan: null };

    const shape = ledger.ops[op];
    if (!shape) return { ok: true, scan: null };
    const requestId = 'ptx-' + now.toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36);
    xrayPending.set(requestId, { restId: String(message.restId), op, plannedAt: now });
    xrayScanStamps.push(now);
    record.lastDeepScanAt = now;
    if (op === 'UserTweets' && cursor) record.scanCursor = null; // consumed
    await writeLedger(ledger);

    return {
      ok: true,
      scan: {
        requestId,
        op,
        userId: String(message.restId),
        cursor,
        count: op === 'UserTweets' ? 40 : 20,
        shape: { url: shape.url, headers: shape.headers },
      },
    };
  });
}

/* -------------------- attestation chain (DEFECT F-14) --------------------
 *
 * The chain used to live inside pt_state, so every tab appended to its own
 * copy and full-state writes raced each other across tabs — last write wins,
 * links lost, and every fill serialized the whole lifetime chain. The worker
 * is now the ONLY writer: content tabs send pt_attest_append, and all
 * read-modify-write of the segmented store is serialized through one promise
 * chain, exactly like warmSerial. The chain is still never truncated —
 * segmentation (attest.js) bounds the per-fill cost instead.
 */

// Same shape as warmSerial: the declared-but-unused lock is the bug class
// this pattern exists to prevent.
let attestChainMutex = Promise.resolve();
function attestSerial(fn) {
  const next = attestChainMutex.catch(() => {}).then(fn);
  attestChainMutex = next.catch(() => {});
  return next;
}

// Chain storage must REFUSE to fake success: a failed read resolving {}
// would make the next append re-anchor at GENESIS and fork the record —
// the evidence-store cousin of D-15's fabricated empty wallet.
function attestGet(keys) {
  return new Promise((resolve, reject) => chrome.storage.local.get(keys, (value) => {
    if (chrome.runtime && chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
    resolve(value || {});
  }));
}
function attestSet(obj) {
  return new Promise((resolve, reject) => chrome.storage.local.set(obj, () => {
    if (chrome.runtime && chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
    resolve();
  }));
}

/**
 * One-time move of state.attestChain into the segmented store. Protocol-safe:
 * the state write goes through setState, which advances the seq write counter
 * so open tabs adopt the slimmer state instead of clobbering it on their next
 * heartbeat.
 *
 * Idempotent and fork-safe, because a not-yet-reloaded tab from the previous
 * extension version can still write a state that carries attestChain:
 *  - links already in the store (same hash, or same fill id) are skipped;
 *  - legacy links that extend the current head are moved with their hashes
 *    intact — verifiability is PRESERVED, never recomputed when a pure move
 *    is possible;
 *  - legacy links that fork (their prev no longer matches the head) are
 *    re-committed from their fill facts onto the current head. The facts —
 *    id, mint, side, qty, price, amounts, ts — survive; only the envelope
 *    hash is new, and the fold is logged.
 * Callers must hold attestSerial.
 */
async function migrateAttestChainLocked() {
  // A tab can append to state.attestChain between our read and our strip;
  // re-read and fold again rather than deleting evidence we never saw.
  for (let attempt = 0; attempt < 3; attempt++) {
    const state = await getState();
    if (!state || !Object.hasOwn(state, 'attestChain')) return;
    const legacy = Array.isArray(state.attestChain) ? state.attestChain : [];

    if (legacy.length) {
      const { meta, chain } = await AT.readChainStore(attestGet);
      if (!meta.length) {
        // Fresh store: a pure move, every hash exactly as committed.
        await attestSet(AT.chainSegments(legacy));
      } else {
        const knownHashes = new Set(chain.map((l) => l && l.hash));
        const knownIds = new Set(chain.map((l) => l && l.id));
        const merged = chain.slice();
        let folded = 0;
        for (const link of legacy) {
          if (!link || knownHashes.has(link.hash) || knownIds.has(link.id)) continue;
          const head = merged.length ? merged[merged.length - 1].hash : AT.GENESIS;
          let next = link;
          if (link.prev !== head) {
            // Forked by a mixed-version race — re-commit the facts.
            next = await AT.appendFill(head, link);
            folded++;
          }
          next.seq = merged.length;
          merged.push(next);
          knownHashes.add(next.hash);
          knownIds.add(next.id);
        }
        if (merged.length > chain.length) await attestSet(AT.chainSegments(merged));
        if (folded) console.warn(`PaperTrench: re-committed ${folded} attest link(s) from a pre-update tab onto the current head`);
      }
    }

    // Strip the legacy copy — but only if it still matches what was folded;
    // otherwise loop and fold the newcomers first.
    const fresh = await getState();
    if (!fresh || !Object.hasOwn(fresh, 'attestChain')) return;
    const freshLegacy = Array.isArray(fresh.attestChain) ? fresh.attestChain : [];
    const sameTail = freshLegacy.length === legacy.length
      && (freshLegacy.length === 0 || freshLegacy[freshLegacy.length - 1].hash === legacy[legacy.length - 1].hash);
    if (sameTail) {
      delete fresh.attestChain;
      await setState(fresh);
      return;
    }
  }
  // Convergence is handed to the storage watcher below rather than looping
  // forever against a hyperactive pre-update tab.
}

// Once per worker life is enough: after migration, no NEW state carries a
// chain. The storage watcher re-arms the check if a pre-update tab writes
// one back.
let attestMigrated = false;
async function ensureAttestMigratedLocked() {
  if (attestMigrated) return;
  attestMigrated = true; // before the await; a failure re-arms below
  try {
    await migrateAttestChainLocked();
  } catch (error) {
    attestMigrated = false;
    throw error;
  }
}

function attestAppend(trade) {
  if (!trade || typeof trade !== 'object') return Promise.resolve({ ok: false, error: 'invalid trade' });
  return attestSerial(async () => {
    await ensureAttestMigratedLocked();
    const link = await AT.appendToChainStore(attestGet, attestSet, trade);
    return { ok: true, seq: link.seq, head: link.hash };
  }).catch((error) => ({ ok: false, error: (error && error.message) || String(error) }));
}

function attestMigrate() {
  return attestSerial(() => {
    attestMigrated = false;
    return ensureAttestMigratedLocked();
  }).then(() => ({ ok: true }), (error) => ({ ok: false, error: (error && error.message) || String(error) }));
}

// A pre-update tab writing attestChain back into pt_state re-arms migration.
if (chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.pt_state) return;
    const next = changes.pt_state.newValue;
    if (next && Array.isArray(next.attestChain) && next.attestChain.length) {
      attestMigrated = false;
      attestSerial(ensureAttestMigratedLocked).catch(() => {});
    }
  });
}

/* -------------------- message routing -------------------- */

const BASE58_RE = /^[A-HJ-NP-Za-km-z1-9]{32,44}$/;
const MAX_MINTS_PER_BATCH = 100;

function isSolanaAddress(s) {
  return typeof s === 'string' && BASE58_RE.test(s);
}

/* Multichain trust boundary (docs/MULTICHAIN.md): the validators stay
 * STRICT — they become chain-aware, never looser. A claimed chain must be a
 * known fomo slug, and the address must match THAT chain's shape exactly. */
const EVM_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const KNOWN_CHAINS = ['solana', 'base', 'monad', 'bnb', 'ethereum', 'hyperliquid', 'robinhood'];

function isEvmAddress(s) {
  return typeof s === 'string' && EVM_ADDR_RE.test(s);
}

function chainOfClaim(chain) {
  return typeof chain === 'string' && KNOWN_CHAINS.indexOf(chain) >= 0 ? chain : null;
}

function isAddressForChain(s, chain) {
  return chain === 'solana' || !chain ? isSolanaAddress(s) : isEvmAddress(s);
}

function sanitizeMints(list) {
  if (!Array.isArray(list)) return null;
  const clean = list.filter((m) => isSolanaAddress(m) || isEvmAddress(m));
  return clean.length ? clean.slice(0, MAX_MINTS_PER_BATCH) : null;
}

/** chains map for a batch: only known slugs, only for mints in the batch. */
function sanitizeChains(map, mints) {
  if (!map || typeof map !== 'object' || !Array.isArray(mints)) return undefined;
  const out = {};
  for (const mint of mints) {
    const chain = chainOfClaim(map[mint]);
    if (chain && chain !== 'solana' && isEvmAddress(mint)) out[mint] = chain;
  }
  return Object.keys(out).length ? out : undefined;
}

function isValidTokenForRefresh(t) {
  if (!t || typeof t !== 'object') return false;
  const chain = chainOfClaim(t.chain) || 'solana';
  if (!isAddressForChain(t.mint, chain)) return false;
  if (t.pairAddress && !(isSolanaAddress(t.pairAddress) || (chain !== 'solana' && isEvmAddress(t.pairAddress)))) return false;
  return true;
}

// pt_state_commit serialization: one write finishes (read + compare + set)
// before the next begins, whatever context it came from.
let stateCommitQueue = Promise.resolve();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return;

  (async () => {
    const settings = await getSettings();
    switch (message.type) {
      case 'pt_open_dashboard':
        openDashboard();
        sendResponse({ ok: true });
        break;

      /* Support export: pull the error black box for a bug report. The
       * content script records into its OWN buffer (separate world), so a
       * report can carry both halves. No UI — this is a pull-only channel. */
      case 'pt_errors_snapshot': {
        let entries = [];
        try { entries = ERRLOG ? ERRLOG.snapshot() : []; } catch (_) { entries = []; }
        if (Array.isArray(message.entries) && message.entries.length) {
          // Entries forwarded from a content script, already redacted there.
          try { entries = entries.concat(message.entries); } catch (_) { /* keep worker half */ }
        }
        sendResponse({ ok: true, scope: 'background', entries });
        break;
      }
      case 'pt_errors_clear': {
        try { if (ERRLOG) ERRLOG.clear(); } catch (_) { /* nothing to clear */ }
        sendResponse({ ok: true });
        break;
      }
      /* Content scripts have no importScripts and live in a separate world;
       * this lets them push a page-side error into the worker's buffer. */
      case 'pt_errors_record': {
        noteError(message.message || 'content error', message.context || { scope: 'content' });
        sendResponse({ ok: true });
        break;
      }

      // D-42: armed row snipe persistence (see writeArmedRowIntent above).
      case 'pt_armed_row_arm': {
        const intent = message.intent || null;
        if (intent) await writeArmedRowIntent(intent);
        sendResponse({ ok: true });
        break;
      }
      case 'pt_armed_row_get': {
        sendResponse(await readArmedRowIntent());
        break;
      }
      case 'pt_armed_row_clear': {
        await clearArmedRowIntent(message.address);
        sendResponse({ ok: true });
        break;
      }

      case 'pt_trade_event': {
        const session = RP.normalizeSession(message.session || message.round || {});
        if (sender.tab && sender.tab.id) lastTradeTabId = sender.tab.id;
        if (message.opened && settings.recordingEnabled) await startRecording(sender.tab?.id, session.symbol);
        await snapFrame(message.kind || message.trade?.side || 'fill', session, sender.tab?.id);
        if (message.round && settings.recordingEnabled) await stopRecording(message.round.id);
        await recordReplay(session, message.round || null);
        await refreshFrameInterval();
        // #29: a quick-buy chip on a screener list opens a NEW position in a
        // token whose chart the user never opened. If the fill came from a
        // list page (no chart for THIS mint can be on screen there) the
        // chart opens for them — as a background tab, never stealing focus
        // (the v3.1.0 lesson: "PaperTrench never opens a tab you didn't
        // click for" — this IS the click's consequence, so it is allowed,
        // but it stays a background tab until the user goes to it).
        if (message.kind === 'buy' && message.opened && message.trade
            && message.trade.source === 'list-chip' && settings.listQuickOpen !== false) {
          try {
            const url = self.PaperTrenchSites
              && self.PaperTrenchSites.tokenUrlFor(message.trade.mint, {
                siteId: message.trade.site || null,
                pairAddress: message.trade.pairAddress || null,
                chain: message.trade.chain || 'solana',
              });
            if (url) chrome.tabs.create({ url, active: false });
          } catch (_) { /* a failed tab open must never fail the fill event */ }
        }
        if (message.round && settings.autoReview && message.round.id) {
          autoReview(message.round.id).catch(() => {});
        }
        sendResponse({ ok: true });
        break;
      }

      // Compatibility with PaperTrench 0.4 content scripts still alive in an
      // already-open tab while the extension service worker updates.
      case 'pt_round_opened': {
        const session = RP.normalizeSession(message.session || {
          mint: message.mint,
          symbol: message.symbol,
          openedAt: Date.now(),
        });
        if (settings.recordingEnabled) await startRecording(sender.tab?.id, session.symbol);
        await snapFrame('buy', session, sender.tab?.id);
        await recordReplay(session);
        await refreshFrameInterval();
        sendResponse({ ok: true });
        break;
      }

      case 'pt_round_closed': {
        const session = RP.normalizeSession(message.session || message.round || {});
        if (settings.recordingEnabled) await stopRecording(message.round?.id);
        await snapFrame('sell', session, sender.tab?.id);
        await recordReplay(session, message.round || null);
        await refreshFrameInterval();
        if (settings.autoReview && message.round?.id) autoReview(message.round.id).catch(() => {});
        sendResponse({ ok: true });
        break;
      }

      case 'pt_snap_frame': {
        const at = await snapFrame(message.kind || 'fill', message.session || message,
          sender.tab?.id, message.explicit === true);
        await refreshFrameInterval();
        // The honest answer, not a blanket ok: the overlay's thesis snap
        // stamps the frame reference onto the thesis only when a frame
        // actually landed in pt_frames.
        sendResponse({ ok: at !== null, at });
        break;
      }



      case 'pt_settings_changed':
        await refreshFrameInterval();
        await warmSettingsChanged(settings);
        await warmDestSettingsChanged(settings);
        await instantSitesReconcile();
        sendResponse({ ok: true });
        break;

      // ------------------------- wallet commit (single writer) ------------
      // Every pt_state write flows through here, strictly serialized, with a
      // seq compare-and-swap. Before this existed, each context wrote the
      // whole state blob with chrome.storage.local.set directly, and two
      // writers reading the same base clobbered each other — the ~800ms
      // heartbeat in one tab could overwrite a fill just made in another,
      // which is exactly "I placed several buys and the position vanished,
      // then came back with false P&L" (LYAR field report, twice). A stale
      // writer now gets {stale, current} back and must adopt-and-reapply
      // instead of clobbering; `force` is for the user-singular writers that
      // ARE the new truth (wallet reset, backup restore).
      case 'pt_state_commit': {
        const job = async () => {
          const incoming = message.state;
          if (!incoming || typeof incoming !== 'object') return { ok: false, reason: 'bad-state' };
          const stored = await getState();
          if (!message.force) {
            const baseSeq = Number(message.expectedSeq) || 0;
            const storedSeq = stored ? (Number(stored.seq) || 0) : 0;
            if (stored && storedSeq !== baseSeq) {
              return { ok: false, reason: 'stale', current: stored };
            }
          }
          // NOT setState(): that helper bumps seq itself, and the committing
          // tab has already stamped seq/updatedAt — its own-write suppression
          // (F-41 stamp) depends on what lands being byte-identical.
          await new Promise((resolve) =>
            chrome.storage.local.set({ pt_state: incoming }, () => resolve()));
          return { ok: true, seq: Number(incoming.seq) || 0 };
        };
        // Strict serialization: a commit never reads while another writes.
        const run = stateCommitQueue.then(job, job);
        stateCommitQueue = run.catch(() => {});
        sendResponse(await run);
        break;
      }

      // ------------------------- site relay (site-bridge.js) --------------
      // The papertrench.com content script carries the same two requests the
      // externally_connectable path serves, plus the sign-in identity echo.
      // The sender URL is re-checked here: every content script this
      // extension runs shares chrome.runtime.sendMessage, and a compromised
      // trading-site page must not be able to write the linked identity or
      // read the record through the relay's message types.
      case 'pt_site_identity': {
        if (!senderOnBridgeOrigin(sender)) { sendResponse({ ok: false, reason: 'origin-not-allowed' }); break; }
        const handle = typeof message.handle === 'string' ? message.handle : '';
        if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) { sendResponse({ ok: false, reason: 'bad-handle' }); break; }
        const existing = settings.leaderboardIdentity || null;
        // The site's word is the verified truth (it holds the X session), so
        // it may overwrite a manually-typed claim — but an identical linked
        // state is not re-written, so a signed-in tab left open cannot churn
        // storage on every /api/me poll.
        if (!existing || existing.handle !== handle || existing.verified !== true) {
          // Minimal read-modify-write on the RAW stored object: writing the
          // defaults-merged copy back would pin today's defaults into
          // storage for users who never customized them.
          await new Promise((resolve) =>
            chrome.storage.local.get(['pt_settings'], (value) => {
              const raw = (value && value.pt_settings) || {};
              raw.leaderboardIdentity = {
                handle, verified: true, linkedAt: Date.now(), source: 'site',
              };
              chrome.storage.local.set({ pt_settings: raw }, () => resolve());
            }));
        }
        sendResponse({ ok: true });
        break;
      }

      case 'pt_bridge_ping': {
        if (!senderOnBridgeOrigin(sender)) { sendResponse({ ok: false, reason: 'origin-not-allowed' }); break; }
        // The wallet rides on the ping so the site can show a balance without
        // a second round trip — and ONLY when Site sync is on, which is the
        // same consent gate the record itself sits behind. With it off this
        // stays exactly what it was: a yes/no about the extension existing.
        sendResponse({
          ok: true,
          bridgeEnabled: settings.leaderboardBridge === true,
          wallet: settings.leaderboardBridge === true ? await bridgeWallet() : null,
        });
        break;
      }

      case 'pt_bridge_get_record':
        if (!senderOnBridgeOrigin(sender)) { sendResponse({ ok: false, reason: 'origin-not-allowed' }); break; }
        sendResponse(await bridgeRecord());
        break;

      case 'pt_warmdest_open':
        sendResponse(await warmDestOpen(message.url, sender, settings));
        break;

      case 'pt_warmdest_hint':
        warmDestHint(message.url, settings).catch(() => {});
        sendResponse({ ok: true });
        break;

      // pt_warmdest_prewarm existed here until the click-only doctrine
      // (TRNC/Eyes343 reports); an old content script still sending it gets
      // a polite no-op instead of an "unknown type" error.
      case 'pt_warmdest_prewarm':
        sendResponse({ ok: true });
        break;

      case 'pt_turbo_jank':
        turboJankNote(message.site, message);
        sendResponse({ ok: true });
        break;

      case 'pt_turbo_fill':
        turboFillNote(message);
        sendResponse({ ok: true });
        break;

      case 'pt_warm_open':
        sendResponse(await warmOpen(message.url, sender, settings));
        break;

      case 'pt_warm_hint':
        warmHint(message.url, settings).catch(() => {});
        sendResponse({ ok: true });
        break;

      case 'pt_warm_oembed':
        sendResponse(await warmOembed(message.url, settings));
        break;

      case 'pt_warm_prewarm':
        warmPrewarm().catch(() => {});
        sendResponse({ ok: true });
        break;

      case 'pt_warm_spa_result':
        warmSpaResult(message, sender);
        sendResponse({ ok: true });
        break;

      case 'pt_xray_observe':
        sendResponse(await xrayObserve(message, settings));
        break;

      case 'pt_xray_get':
        sendResponse(await xrayGet(message, settings));
        break;

      case 'pt_xray_plan':
        sendResponse(await xrayPlan(message, settings));
        break;

      // The in-page Flex composer's gallery. A content script's IndexedDB is
      // site-origin; these three keep uploads in the ONE extension-origin
      // gallery the dashboard composer reads directly.
      case 'pt_cardbg_list':
        try { sendResponse({ ok: true, items: await cardBgList() }); }
        catch (e) { sendResponse({ ok: false, items: [], error: e && e.message }); }
        break;

      case 'pt_cardbg_add':
        try { sendResponse(await cardBgAdd(message.name, message.dataUrl)); }
        catch (e) { sendResponse({ ok: false, error: e && e.message }); }
        break;

      case 'pt_cardbg_remove':
        try { sendResponse(await cardBgRemove(message.id)); }
        catch (e) { sendResponse({ ok: false, error: e && e.message }); }
        break;

      case 'pt_clear_recordings':
        // The popup's reset promises recordings go too, but the popup is
        // deliberately storage-only — IndexedDB cleanup runs here (D-36).
        try { await self.PTRecordings.clear(); sendResponse({ ok: true }); }
        catch (e) { sendResponse({ ok: false, error: e && e.message }); }
        break;

      case 'pt_ai_chat':
        sendResponse(await aiChat({ messages: message.messages, maxTokens: message.maxTokens }));
        break;

      case 'pt_ai_models':
        // D-29: optional overrides carry the dashboard's UNSAVED form values
        // for the endpoint test; aiModels validates them through the same
        // isAllowedEndpoint gate and persists nothing.
        sendResponse(await aiModels(message.overrides));
        break;

      case 'pt_forge_prewarm':
        // Fire-and-forget: the panel has not opened yet, and the point is
        // that the brief is already home when it does.
        forgeBrief(message.facts).catch(() => {});
        sendResponse({ ok: true });
        break;

      case 'pt_forge_brief':
        sendResponse(await forgeBrief(message.facts));
        break;

      case 'pt_forge_image':
        sendResponse(await forgeImages(message));
        break;

      case 'pt_rec_query':
        sendResponse({ active: recActive });
        break;

      case 'pt_recording_toggle':
        if (!message.enabled && recActive) await stopRecording(null);
        sendResponse({ ok: true });
        break;

      // Price resolution is done from the service worker so it is not subject to
      // the page origin's CORS or CSP. The content script supplies only mints
      // and addresses; the background decides which public APIs to call.
      case 'pt_resolve': {
        const chain = chainOfClaim(message.chain) || 'solana';
        if (!isAddressForChain(message.address, chain)) { sendResponse(null); break; }
        const maxAgeMs = Number(message.maxAgeMs);
        const opts = {};
        if (Number.isFinite(maxAgeMs) && maxAgeMs >= 0) opts.maxAgeMs = maxAgeMs;
        if (chain !== 'solana') opts.chain = chain;
        try { sendResponse(await R.resolve(message.address, opts)); } catch (e) { sendResponse(null); }
        break;
      }

      case 'pt_sol_usd':
        try { sendResponse(await R.solUsd()); } catch (e) { sendResponse(0); }
        break;

      case 'pt_refresh':
        if (!isValidTokenForRefresh(message.token)) { sendResponse(null); break; }
        try { sendResponse(await R.refresh(message.token)); } catch (e) { sendResponse(null); }
        break;

      case 'pt_batch_prices': {
        const mints = sanitizeMints(message.mints);
        if (!mints) { sendResponse({}); break; }
        const chains = sanitizeChains(message.chains, mints);
        try { sendResponse(await R.batchPrices(mints, chains)); } catch (e) { sendResponse({}); }
        break;
      }

      // Begin streaming live pool state for the token on screen. Prices then
      // arrive from chain state at `processed` commitment instead of from an
      // aggregator running ~2-3s behind.
      case 'pt_onchain_watch': {
        if (!FEED || !isSolanaAddress(message.mint) || !isSolanaAddress(message.pool)) {
          sendResponse({ live: false });
          break;
        }
        try {
          // An empty rpcUrl is the normal case: the keyless public pool.
          const settings = await getSettings();
          FEED.configure({ rpcUrl: settings.rpcUrl || null });
          sendResponse({ live: await FEED.watch(message.mint, message.pool) });
          // The moment slowness hurts is the moment worth checking for it.
          maybeNoteSlowPool(settings).catch(() => {});
        } catch (e) { sendResponse({ live: false }); }
        break;
      }

      case 'pt_onchain_unwatch':
        if (FEED && isSolanaAddress(message.mint)) FEED.unwatch(message.mint);
        sendResponse({ ok: true });
        break;

      // Rug guard: holder concentration read from chain state, cached a
      // minute per mint so arming, buying and re-buying do not multiply RPC
      // reads. Null means "could not see the chain" — the guard then stands
      // aside instead of blocking on an invented number.
      case 'pt_rug_check': {
        if (!isSolanaAddress(message.mint)) { sendResponse(null); break; }
        const cached = rugCache.get(message.mint);
        if (cached && Date.now() - cached.at < RUG_CACHE_MS) { sendResponse(cached.verdict); break; }
        try {
          const verdict = await rugScan(message.mint);
          if (verdict) {
            rugCache.set(message.mint, { at: Date.now(), verdict });
            if (rugCache.size > 200) rugCache.delete(rugCache.keys().next().value);
          }
          sendResponse(verdict);
        } catch (e) { sendResponse(null); }
        break;
      }

      // Pre-index launch: turn a curve address (Axiom pair pages) or a pump
      // mint (Padre /t/ pages) into a live watched feed + immediate first
      // quote, before any aggregator has heard of the coin. Null means "not
      // a live pump curve" and the caller keeps waiting on the resolver.
      case 'pt_onchain_prewatch': {
        const pool = isSolanaAddress(message.pool) ? message.pool : null;
        const mint = isSolanaAddress(message.mint) ? message.mint : null;
        if (!FEED || (!pool && !mint)) { sendResponse(null); break; }
        try {
          const settings = await getSettings();
          FEED.configure({ rpcUrl: settings.rpcUrl || null });
          sendResponse(await FEED.prewatch({ pool, mint }));
          // The sniping path is where a throttled region bleeds — check here.
          maybeNoteSlowPool(settings).catch(() => {});
        } catch (e) { sendResponse(null); }
        break;
      }

      case 'pt_onchain_identify': {
        const pool = isSolanaAddress(message.pool) ? message.pool : null;
        const mint = isSolanaAddress(message.mint) ? message.mint : null;
        if (!FEED || (!pool && !mint)) { sendResponse(null); break; }
        try {
          const settings = await getSettings();
          FEED.configure({ rpcUrl: settings.rpcUrl || null });
          sendResponse(await FEED.identify({ pool, mint }));
        } catch (e) { sendResponse(null); }
        break;
      }

      // The authoritative price at click time. Null means no fresh on-chain
      // observation exists, and the caller must not invent one.
      case 'pt_onchain_quote':
        if (!FEED || !isSolanaAddress(message.mint)) { sendResponse(null); break; }
        sendResponse(FEED.currentQuote(message.mint));
        break;

      // F-14: the single writer for the attestation chain. Content tabs send
      // the fill here instead of rewriting the whole chain inside pt_state;
      // appends are serialized so multi-tab fills can never fork the record.
      // {ok:false} — never a throw — so commitFill can honour F-28's
      // tell-the-user-once contract.
      case 'pt_attest_append':
        sendResponse(await attestAppend(message.trade));
        break;

      // The dashboard nudges this when it still sees a legacy in-state chain,
      // so the move happens even if the user never fills again.
      case 'pt_attest_migrate':
        sendResponse(await attestMigrate());
        break;

      // Prediction market: quote and submit orders via venue API.
      case 'PREDICT_QUOTE': {
        const PE = self.PaperPredictEngine;
        const PV = self.PaperPredictVenues;
        if (!PV) { sendResponse({ ok: false, message: 'Prediction venues not loaded' }); break; }
        if (!PE) { sendResponse({ ok: false, message: 'Prediction engine not loaded' }); break; }
        try {
          const adapter = PV.adapterFor(message.venue);
          if (!adapter) { sendResponse({ ok: false, message: 'Unknown venue: ' + message.venue }); break; }

          // The book is fetched HERE, in the service worker, because it holds
          // the host permissions — a content script asking a venue API for a
          // cross-origin book would need CORS the venue does not grant.
          const book = await adapter.fetchBook(message.marketId);
          if (!book) {
            sendResponse({ ok: false, message: 'No live book for this market right now.' });
            break;
          }

          // The adapter speaks {yes:{bids,asks}}, the engine speaks
          // {yes_bids, yes_asks}. One translation, in one place.
          const snap = {
            yes_bids: book.yes.bids, yes_asks: book.yes.asks,
            no_bids: book.no.bids, no_asks: book.no.asks,
            captured_at: book.capturedAt,
          };
          const market = {
            status: 'open',
            close_time: book.closeTime || null,
            tick_cents: book.tickCents || 1,
            min_order_size: book.minOrderSize || 1,
          };
          const qty = Number(message.qty);
          const notional = Number(message.notional);
          const target = qty > 0 ? { kind: 'qty', qty }
            : notional > 0 ? { kind: 'notional', usd: notional }
            : null;
          if (!target) { sendResponse({ ok: false, message: 'Enter a quantity first.' }); break; }

          const priced = PE.priceOrder({
            snap,
            market,
            side: message.side || 'buy',
            outcome: message.outcome || 'yes',
            realism: message.realism || 'realistic',
            target,
          });

          sendResponse({ ok: true, data: {
            venue: message.venue,
            marketId: message.marketId,
            side: message.side || 'buy',
            outcome: message.outcome || 'yes',
            realism: message.realism || 'realistic',
            avgPrice: priced.avgPrice,
            qty: priced.qty,
            cost: priced.cost,
            fee: priced.fee,
            totalCost: priced.totalCost,
            bookMid: priced.bookMid,
            // The ticket renders `slippageBps` — the engine calls it
            // `slippage`. One name at the boundary, or render throws on
            // undefined.toFixed() and the panel goes blank.
            slippageBps: priced.slippage,
            partial: !!(priced.walk && priced.walk.partial),
            // Which market this price is actually FOR. A Kalshi event page
            // holds many markets; quoting one of them without naming it puts
            // a true number next to the wrong question.
            resolvedMarketId: book.marketId,
            marketTitle: book.marketTitle || null,
            viaEvent: !!book.viaEvent,
            siblingCount: book.siblingCount || 0,
            quotedAt: new Date().toISOString(),
          } });
        } catch (e) {
          // priceOrder throws {code, message} for every honest refusal —
          // closed market, no liquidity, size over the depth cap, a book that
          // failed its mirror invariant. Those messages are written for the
          // user, so they are passed through rather than flattened.
          sendResponse({ ok: false, code: e && e.code, message: (e && e.message) || String(e) });
        }
        break;
      }
      case 'PREDICT_SUBMIT': {
        // Deliberately still refused, and named precisely rather than left as
        // a dev stub: a paper FILL needs a positions ledger under the
        // pt_pred_ namespace (rule 3's latency replay, the position cap, and
        // settlement all write to it) and that store does not exist yet.
        // Quoting is real; filling is not, and the panel says so.
        sendResponse({ ok: false, code: 'not_implemented',
          message: 'Paper fills are not enabled yet — quotes are live, the positions ledger is still being built.' });
        break;
      }

      default:
        sendResponse({ error: 'unknown message type' });
    }
  })().catch((error) => sendResponse({ error: error.message }));

  return true;
});

/* -------------------- re-injection after reload/update --------------------
 *
 * Chrome does NOT re-inject content scripts into tabs that were already open
 * when an extension is reloaded, updated, or re-enabled. Those tabs keep the
 * ORPHANED old scripts: their globals survive but every chrome.* handle is
 * invalidated, so the panel is dead and can never come back on its own — while
 * the page looks completely normal. The extension simply reads as broken, and
 * the only cure is a refresh the user has no reason to suspect. In development
 * that is every reload; in the wild it is every auto-update, on every open
 * terminal tab at once.
 *
 * So on install/update/enable we re-inject the manifest's own script sets into
 * the tabs the manifest already claims. Two rules keep it honest:
 *
 *   - ONLY the ISOLATED world. The MAIN-world bridge never touches chrome.*,
 *     so a reload does not kill it; injecting a second copy would risk
 *     double-initialising the page world for no gain. Only what dies returns.
 *   - ONLY where the resident instance PROVES it is dead (window.__ptAlive).
 *     A second live content.js would mount a second panel, so presence is not
 *     enough — the beacon reports its chrome handle, which an orphan loses.
 *
 * The corpse left behind is already handled: it shut itself down when its
 * context died (O-04/C-17), and createUI() removes a leftover host before
 * rebuilding (O-05).
 */

/** Runs INSIDE the tab, in our isolated world. Serialisable: no closures. */
function ptLivenessProbe() {
  try {
    return typeof window.__ptAlive === 'function' && window.__ptAlive() === true;
  } catch (_) {
    return false;
  }
}

function reinjectQueryTabs(matches) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.query({ url: matches }, (tabs) => {
        if (chrome.runtime && chrome.runtime.lastError) { resolve([]); return; }
        resolve(Array.isArray(tabs) ? tabs : []);
      });
    } catch (_) {
      resolve([]);
    }
  });
}

let reinjectInFlight = false;

async function reinjectOpenTabs(reason) {
  if (reinjectInFlight) return { reason, skipped: 'in-flight' };
  reinjectInFlight = true;
  const report = { reason, alive: 0, injected: 0, failed: 0 };
  try {
    const manifest = chrome.runtime.getManifest();
    // The manifest is the single source of truth: a file added to an entry is
    // re-injected for free, and no list can drift out of sync with what Chrome
    // itself injects.
    const entries = (manifest.content_scripts || [])
      .filter((entry) => !entry.world || entry.world === 'ISOLATED')
      .filter((entry) => Array.isArray(entry.js) && entry.js.length);

    for (const entry of entries) {
      const tabs = await reinjectQueryTabs(entry.matches);
      for (const tab of tabs) {
        if (!tab || typeof tab.id !== 'number') continue;
        // Every step is per-tab contained: one page Chrome refuses to script
        // (a PDF viewer, a policy-blocked host, a tab closing mid-sweep) must
        // never strand the tabs after it.
        let alive = false;
        try {
          const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: ptLivenessProbe,
          });
          alive = Boolean(results && results[0] && results[0].result);
        } catch (_) {
          continue;
        }
        if (alive) { report.alive += 1; continue; }
        try {
          // Styles first, so the panel never paints unstyled.
          if (Array.isArray(entry.css) && entry.css.length) {
            await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: entry.css });
          }
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: entry.js });
          report.injected += 1;
        } catch (_) {
          report.failed += 1;
        }
      }
    }
  } catch (_) { /* no capability, no sweep: never break the install */ }
  reinjectInFlight = false;
  return report;
}

chrome.runtime.onStartup.addListener(() => {
  refreshFrameInterval().catch(() => {});
});
chrome.runtime.onInstalled.addListener((details) => {
  refreshFrameInterval().catch(() => {});
  // F-14: move a legacy in-state chain out at update time, not lazily on the
  // next fill — deterministic for the install, free for every later wake.
  attestSerial(ensureAttestMigratedLocked).catch(() => {});
  reinjectOpenTabs((details && details.reason) || 'installed').catch(() => {});
  // N1 (Discord 8/21, ark_trades13/amogus_0471): three users asked publicly
  // how to update — the extension is unpacked, so Chrome never updates it
  // and users kept trading on stale builds with known-fixed bugs. Check the
  // GitHub releases feed on every install/update so the notice is immediate.
  // (Rechecks are alarm-driven — a self-rescheduling setTimeout chain would
  // hold every unit-harness process open forever; that timer is why CI hung.)
  runUpdateCheck().catch(() => {});
});
refreshFrameInterval().catch(() => {});

/* ------------------------- update notice (N1) ---------------------------
 * The extension ships unpacked (no update_url), so Chrome will never update
 * it — the ONLY way users learn a fix shipped is if the extension itself
 * says so. This polls the public GitHub releases feed, compares the newest
 * tag against the running manifest version, and stores the result; the
 * dashboard + a toast on trading pages read it. It contacts exactly one
 * host (api.github.com, the same host the download link points at), sends
 * no user data (a bare GET), runs at most every 6 h (plus on install), and
 * is fully opt-out via settings.updateCheckEnabled = false. This is the one
 * deliberate exception to the no-phone-home doctrine, made because users
 * staying on broken builds is worse than one version header leaving the
 * machine — the same reasoning as the leaderboard's answer-only bridge.
 * (The 6h period lives on the pt_update_check alarm, not a timer.)
 */
const UPDATE_FEED_URL = 'https://api.github.com/repos/OnlyTerp/papertrench/releases/latest';

async function fetchLatestRelease() {
  const res = await fetch(UPDATE_FEED_URL, {
    headers: { Accept: 'application/vnd.github+json' },
    // No caching: a stale 304/max-age would suppress the notice for hours
    // after a release lands.
    cache: 'no-store',
  });
  if (!res.ok) return null;
  const rel = await res.json().catch(() => null);
  if (!rel || typeof rel.tag_name !== 'string') return null;
  return {
    tag: rel.tag_name.replace(/^v/i, ''),
    url: typeof rel.html_url === 'string' ? rel.html_url : null,
    notes: typeof rel.body === 'string' ? rel.body.slice(0, 500) : null,
  };
}

function isNewerVersion(latest, current) {
  const a = String(latest).split('.').map((n) => parseInt(n, 10) || 0);
  const b = String(current).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

async function runUpdateCheck() {
  let stored = null;
  try { stored = await chrome.storage.local.get(['pt_settings', 'pt_update_notice']); } catch (_) { return; }
  const settings = stored && stored.pt_settings;
  // Opt-out is honored instantly, and an existing notice is cleared with it.
  if (settings && settings.updateCheckEnabled === false) {
    if (stored.pt_update_notice) chrome.storage.local.remove('pt_update_notice').catch(() => {});
    return;
  }
  const rel = await fetchLatestRelease().catch(() => null);
  if (!rel) return; // network/refusal/down — silent; never nag on failure
  const running = chrome.runtime.getManifest().version;
  const notice = isNewerVersion(rel.tag, running)
    ? { latest: rel.tag, running, url: rel.url, notes: rel.notes, at: Date.now() }
    : null;
  const prev = stored.pt_update_notice || null;
  // Write only on change — a steady "no update" state costs zero writes.
  if (!notice && prev) chrome.storage.local.remove('pt_update_notice').catch(() => {});
  else if (notice && (!prev || prev.latest !== notice.latest)) {
    chrome.storage.local.set({ pt_update_notice: notice }).catch(() => {});
  }
}

// The SW dies on idle; an alarm survives. The pt_update_check alarm wakes a
// sleeping SW twice a day — no timer chain (a self-rescheduling setTimeout
// holds unit-harness processes open forever; that is what hung CI).
if (chrome.alarms && typeof chrome.alarms.create === 'function') {
  chrome.alarms.create('pt_update_check', { periodInMinutes: 360 });
  // N2: armed limit buys carry a 24h TTL. A chart page sweeps its OWN mints
  // on every boot, but a bid on a coin whose tab never reopens would hold
  // its SOL forever — this daily sweep releases expired locks for everyone.
  chrome.alarms.create('pt_pending_buy_sweep', { periodInMinutes: 720 });
}
if (chrome.alarms && typeof chrome.alarms.onAlarm === 'object' && chrome.alarms.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm && alarm.name === 'pt_update_check') runUpdateCheck().catch(() => {});
    if (alarm && alarm.name === 'pt_pending_buy_sweep') sweepPendingBuys().catch(() => {});
  });
}

async function sweepPendingBuys() {
  try {
    const got = await new Promise((resolve) => {
      if (chrome.runtime.lastError) { resolve(null); return; }
      chrome.storage.local.get(['pt_state'], (v) => resolve(v || {}));
    });
    const state = got && got.pt_state;
    if (!state || typeof state !== 'object' || !state.pendingBuys) return;
    // engine.js is not loaded in the SW (it is a classic script with a
    // window global); the TTL sweep is 10 lines and inlined here on
    // purpose. The 24h TTL mirrors engine.js PENDING_BUY_TTL_MS.
    const TTL_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();
    let expired = 0;
    for (const mint of Object.keys(state.pendingBuys)) {
      const list = state.pendingBuys[mint];
      if (!Array.isArray(list)) continue;
      const keep = list.filter((o) => now - o.ts <= TTL_MS);
      expired += list.length - keep.length;
      if (keep.length) state.pendingBuys[mint] = keep;
      else delete state.pendingBuys[mint];
    }
    if (expired > 0) {
      await new Promise((resolve) => {
        chrome.storage.local.set({ pt_state: state }, () => resolve());
      });
    }
  } catch (_) { /* a failed sweep must never wake the SW with an error */ }
}

/* -------------------- site bridge (leaderboard sync) --------------------
 * The extension's ONLY external surface, and it is answer-only: the site
 * (allow-listed in manifest.json's externally_connectable) asks, on a user
 * click over there, and this listener replies. Nothing here initiates a
 * connection, fetches, or pushes — the no-phone-home doctrine survives the
 * leaderboard. Gate: the dashboard's "Site sync" toggle
 * (settings.leaderboardBridge), off by default. The payload is the same
 * buildSubmission() JSON the manual export produces, so both hand-off paths
 * are byte-equivalent evidence. */

/* ------------------- slow-pool notice (solve it for everyone) -------------
 *
 * Field report (cojica456, Balkans): every keyless public endpoint was slow
 * from their region, launches crawled, and the fix — a free personal RPC
 * endpoint pasted into Settings — took two minutes once they DISCOVERED it
 * themselves. Nobody should have to discover it. The pool measures its own
 * latency; when the best public endpoint stays slow across real evidence
 * and the user has no personal endpoint configured, the product says the
 * fix out loud, exactly once. No telemetry leaves the machine — this is
 * the extension reading its own numbers.
 */
const SLOW_POOL_MS = 750;
const SLOW_POOL_MIN_SAMPLES = 12;

/* A pool can fail without ever being SLOW, and that is the common case.
 * poolLatency() is built from reportSuccess() alone, so a throttled or
 * policy-blocked endpoint contributes no sample: the one endpoint still
 * answering reports its own healthy latency and bestMs stays under the
 * threshold while most reads are dying. ticket-0010 (fomo.family,
 * 2026-08-29) is the shape — a console full of "http 429 getMultipleAccounts
 * @ tatum" and "http 403 … @ publicnode", the price taking "a very long
 * time", and the user asking whether there is a fix. There is, it is the
 * same two-minute fix, and this notice existed to say so but could not see
 * the failure. Half of recent attempts failing is a pool that cannot do its
 * job, whatever the survivors' latency says. */
const FAILING_POOL_RATE = 0.5;
const FAILING_POOL_MIN_ATTEMPTS = 12;

async function maybeNoteSlowPool(settings) {
  try {
    if (settings && settings.rpcUrl) return; // they already fixed it
    if (!self.PTRpcPool || typeof PTRpcPool.poolLatency !== 'function') return;
    const measured = PTRpcPool.poolLatency();
    const stress = typeof PTRpcPool.poolStress === 'function' ? PTRpcPool.poolStress() : null;

    const slow = Boolean(measured
      && measured.samples >= SLOW_POOL_MIN_SAMPLES
      && measured.bestMs > SLOW_POOL_MS);
    const failing = Boolean(stress
      && stress.attempts >= FAILING_POOL_MIN_ATTEMPTS
      && stress.failRate >= FAILING_POOL_RATE);
    if (!slow && !failing) return;

    const flags = await new Promise((resolve) =>
      chrome.storage.local.get(['pt_rpc_slow_told'], (v) => resolve(v || {})));
    if (flags.pt_rpc_slow_told) return; // once per install, never a nag
    // Name which one it is: "slow from your region" is the wrong sentence to
    // read when the endpoints are refusing you outright, and the wrong
    // sentence makes a correct fix look irrelevant.
    const notice = { reason: failing ? 'failing' : 'slow', at: Date.now() };
    if (measured) { notice.bestMs = measured.bestMs; notice.samples = measured.samples; }
    if (stress) { notice.failRate = Math.round(stress.failRate * 100) / 100; notice.attempts = stress.attempts; }
    await new Promise((resolve) => chrome.storage.local.set({
      pt_rpc_slow_told: Date.now(),
      pt_rpc_notice: notice,
    }, () => resolve()));
  } catch (_) { /* a notice must never break a price path */ }
}

const BRIDGE_ORIGINS = new Set(['https://papertrench.com', 'https://www.papertrench.com']);

/** True when an INTERNAL message really came from our content script on a
 * bridge origin. Every injected page shares chrome.runtime.sendMessage, so
 * the relay's message types must be origin-gated here exactly like the
 * external path — presence of a sender.tab URL on the allowlist is the
 * proof. */
function senderOnBridgeOrigin(sender) {
  const url = sender && ((sender.tab && sender.tab.url) || sender.url) || '';
  try { return BRIDGE_ORIGINS.has(new URL(url).origin); } catch (_) { return false; }
}

/**
 * D-56: the birth balance re-derived from the fill journal alone — the
 * anchor for LEGACY wallets created before D-06's state.startSol snapshot
 * (v3.9.5). Same identity as engine.derivedBirthSol (the service worker
 * doesn't load engine.js, so the rule is inlined here and the test suite
 * pins both to the same fixture):
 *
 *   equity = birth + Σ per-fill steps + open P&L
 *   birth  = equity − open P&L − Σ steps
 *
 * where a BUY steps −(its fee: the cash that became cost basis) and a SELL
 * steps +(its per-sell pnlSol: net proceeds − cost share). Returns 0 when
 * the journal can't support the derivation (empty or non-finite) — 0 means
 * "no derived anchor", deferring to the setting fallback.
 */
function derivedBirthAnchor(state) {
  if (!state || typeof state !== 'object') return 0;
  const journal = ((state.journal) || [])
    .slice().sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
  if (!journal.length) return 0;
  let openValue = 0;
  let openPnl = 0;
  for (const p of Object.values(state.positions || {})) {
    const qty = Number(p && p.qty) || 0;
    const px = Number(p && p.lastPriceNative) || 0;
    if (qty <= 0) continue;
    openValue += qty * px;
    openPnl += qty * px - (Number(p.costSol) || 0);
  }
  const equity = (Number(state.cashSol) || 0) + openValue;
  let walked = 0;
  for (const t of journal) {
    if (t.side === 'buy') {
      const feeRaw = Number(t.feeSol);
      const fee = Number.isFinite(feeRaw) && feeRaw >= 0
        ? feeRaw
        : (Number.isFinite(Number(t.solNet))
          ? Math.max(0, (Number(t.solGross) || 0) - Number(t.solNet))
          : 0);
      walked -= fee;
    } else if (t.side === 'sell') {
      walked += Number(t.pnlSol) || 0;
    }
  }
  const derived = equity - openPnl - walked;
  return Number.isFinite(derived) ? derived : 0;
}

/**
 * The wallet summary the site header shows: cash, equity, open positions.
 *
 * Deliberately NOT a chain replay. bridgeRecord exists to hand over evidence
 * and costs a full verification; this is a number for a header chip and must
 * not make opening papertrench.com expensive.
 *
 * Equity marks open bags at the last price the extension itself observed —
 * the same figure the popup and the positions bar already display, so the
 * site cannot disagree with the app about the user's own balance. No price
 * is fetched to produce it: an unmarked bag contributes its last known mark
 * or nothing, never a guess.
 */
async function bridgeWallet() {
  const state = (await getState()) || {};
  const cash = Number(state.cashSol) || 0;
  const positions = state.positions && typeof state.positions === 'object' ? state.positions : {};
  let open = 0;
  let held = 0;
  for (const pos of Object.values(positions)) {
    const qty = Number(pos && pos.qty) || 0;
    if (!(qty > 0)) continue;
    open += 1;
    const px = Number(pos.lastPriceNative) || 0;
    if (px > 0) held += qty * px;
  }
  return {
    cashSol: cash,
    equitySol: cash + held,
    openPositions: open,
    // Says whether every open bag actually had a mark. The site can then
    // show the number plainly or say it is partial, rather than presenting
    // an understated equity as though it were complete.
    marked: open === 0 || held > 0,
  };
}
async function bridgeRecord() {
  const settings = await getSettings();
  if (!settings.leaderboardBridge) return { ok: false, reason: 'bridge-disabled' };
  const { chain } = await AT.readChainStore(attestGet);
  if (!chain.length) return { ok: false, reason: 'chain-empty' };
  // D-06: the chain replay denominates on the wallet's birth balance — the
  // same anchor every local % return reads, so the site-side replay can
  // never disagree with the number the trader sees. (engine.js isn't loaded
  // in the service worker, so the anchor rule is inlined: birth snapshot
  // first, live setting only as a legacy fallback.)
  // D-56: legacy wallets (pre-v3.9.5) never got the birth snapshot, so the
  // raw setting fallback welded their replay denominator to the live form.
  // Re-derive the birth from the journal (same identity as
  // engine.derivedBirthSol: equity − open P&L − Σ per-fill steps) and trust
  // it before the setting. The derivation is stable across fills, so the
  // bridge and the local display agree even before a tab persists the
  // backfill.
  const state = (await getState()) || {};
  const start = (Number(state.startSol) || 0) > 0
    ? Number(state.startSol)
    : (derivedBirthAnchor(state) > 0
      ? derivedBirthAnchor(state)
      : (Number(settings.balanceStartSol) || 0));
  // The claim mirrors the chain-derived replay on purpose: the server ranks
  // on its own replay anyway, and a bridge claim that disagreed with the
  // chain would only flag honest users whose local display drifted.
  const replayed = AT.replayChain(chain, start);
  return {
    ok: true,
    payload: AT.buildSubmission({
      chain,
      identity: settings.leaderboardIdentity || null,
      startingBalanceSol: start,
      stats: {
        equitySol: replayed.cashSol,
        realizedPnlSol: replayed.realizedPnlSol,
        rounds: replayed.rounds,
        wins: replayed.wins,
        losses: replayed.losses,
      },
    }),
  };
}

if (chrome.runtime.onMessageExternal) {
  chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
    const origin = sender && (sender.origin || (sender.url ? new URL(sender.url).origin : '')) || '';
    if (!BRIDGE_ORIGINS.has(origin)) {
      sendResponse({ ok: false, reason: 'origin-not-allowed' });
      return false;
    }
    (async () => {
      switch (message && message.type) {
        // Install/state probe, so the site can say "enable Site sync in the
        // dashboard" instead of showing a dead button. Reveals presence and
        // the toggle state, nothing else.
        case 'pt_bridge_ping': {
          const settings = await getSettings();
          sendResponse({ ok: true, bridgeEnabled: settings.leaderboardBridge === true });
          break;
        }
        case 'pt_bridge_get_record':
          sendResponse(await bridgeRecord());
          break;
        default:
          sendResponse({ ok: false, reason: 'unknown-request' });
      }
    })().catch((error) => sendResponse({ ok: false, reason: (error && error.message) || 'error' }));
    return true;
  });
}
