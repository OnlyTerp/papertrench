/* PaperTrench — dashboard/options page. */

'use strict';

const E = window.PaperEngine;
if (!E) {
  document.body.innerHTML =
    '<div style="padding:40px;color:#f85149;font-family:system-ui">' +
    'engine.js failed to load. Reload the extension at chrome://extensions.</div>';
  throw new Error('PaperEngine missing');
}

const RP = window.PTReplay;
if (!RP) throw new Error('PTReplay module missing');
const RC = window.PTRecordings;
if (!RC) throw new Error('PTRecordings store missing');
const AT = window.PTAttest;
const FG = window.PTForge;

/* Forge settings helpers — the provider lists live in forge-core.js so the
 * dashboard, the worker and the tests all read one registry. */
function forgeOptions(registry, selected) {
  return Object.keys(registry).map((id) => {
    const p = registry[id];
    return `<option value="${esc(p.id)}" ${selected === p.id ? 'selected' : ''}>${esc(p.label)}</option>`;
  }).join('');
}
function forgePick(registry, selected) {
  return registry[selected] || registry[Object.keys(registry)[0]];
}
function forgeBlurb(registry, selected) {
  const p = forgePick(registry, selected);
  return (p && p.blurb) || '';
}
function forgeEndpointHint(registry, selected) {
  const p = forgePick(registry, selected);
  return (p && p.endpoint) || 'https://…';
}
function forgeModelHint(registry, selected) {
  const p = forgePick(registry, selected);
  return (p && p.modelHint) || 'model name';
}
if (!AT) throw new Error('PTAttest module missing');
const PC = window.PTPnlCard;
if (!PC) throw new Error('PTPnlCard module missing');

/* ---------- CSV export: pure helpers (kept together as a testable seam) ----
 *
 * Data ownership is part of the trust story: the journal and the closed
 * rounds export as plain CSV, generated entirely client-side — nothing
 * leaves the machine. RFC-4180 escaping: a field containing a comma, a
 * double quote, a CR, or an LF is wrapped in double quotes with embedded
 * quotes doubled. null/undefined render as EMPTY fields — a missing number
 * stays missing, it never becomes 0.
 */
function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Header + rows (arrays of fields) → one CRLF-terminated CSV document. */
function buildCsv(header, rows) {
  return [header, ...rows]
    .map((row) => row.map(csvEscape).join(','))
    .join('\r\n') + '\r\n';
}

/** ISO 8601 or empty — an unknown timestamp exports as an empty field. */
function csvIso(ms) {
  const value = Number(ms);
  return Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : '';
}

/** One field per thesis: the text plus the structured parts, pipe-joined. */
function flattenThesis(thesis) {
  if (!thesis) return '';
  const parts = [];
  if (thesis.text) parts.push(thesis.text);
  if (Array.isArray(thesis.tags) && thesis.tags.length) parts.push(`tags: ${thesis.tags.join('/')}`);
  if (thesis.plan) parts.push(`plan: ${thesis.plan}`);
  if (thesis.targetPct !== null && thesis.targetPct !== undefined) parts.push(`target: +${thesis.targetPct}%`);
  if (thesis.stopPct !== null && thesis.stopPct !== undefined) parts.push(`stop: -${thesis.stopPct}%`);
  return parts.join(' | ');
}

// Stable, documented column orders — the header row IS the format contract.
const JOURNAL_CSV_COLUMNS = [
  'ts', 'side', 'symbol', 'mint', 'site', 'qty', 'priceNative', 'priceUsd',
  'solGross', 'feeSol', 'solNet', 'pnlSol', 'mcap',
];
const ROUNDS_CSV_COLUMNS = [
  'openedAt', 'closedAt', 'symbol', 'mint', 'site', 'heldMs', 'investedSol',
  'returnedSol', 'pnlSol', 'pnlPct', 'peakPnlSol', 'troughPnlSol',
  'afterExit.maxPct', 'afterExit.minPct', 'afterExit.samples', 'thesis', 'exitGrade',
];

/** The full journal, oldest first, in JOURNAL_CSV_COLUMNS order. */
function journalCsv(journal) {
  const rows = [...(journal || [])]
    .sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0))
    .map((t) => [
      csvIso(t.ts), t.side, t.symbol, t.mint, t.site, t.qty,
      t.priceNative, t.priceUsd, t.solGross, t.feeSol, t.solNet, t.pnlSol, t.mcap,
    ]);
  return buildCsv(JOURNAL_CSV_COLUMNS, rows);
}

/**
 * Closed rounds, oldest first, in ROUNDS_CSV_COLUMNS order. The After
 * exports observed extremes only — a round without an observed hour exports
 * EMPTY afterExit fields, never zeros. The exit grade is the same verdict
 * the Rounds table shows, or empty when the round cannot be graded.
 */
function roundsCsv(rounds) {
  const rows = [...(rounds || [])]
    .sort((a, b) => (Number(a.closedAt) || 0) - (Number(b.closedAt) || 0))
    .map((r) => {
      const after = r.afterExit || null;
      const quality = E.exitQuality(r);
      return [
        csvIso(r.openedAt), csvIso(r.closedAt), r.symbol, r.mint, r.site,
        r.heldMs, r.investedSol, r.returnedSol, r.pnlSol, r.pnlPct,
        r.peakPnlSol, r.troughPnlSol,
        after ? after.maxPct : null, after ? after.minPct : null,
        after ? after.samples : null,
        flattenThesis(r.thesis),
        quality ? quality.verdict : '',
      ];
    });
  return buildCsv(ROUNDS_CSV_COLUMNS, rows);
}

/**
 * Client-side download, mirroring the popup backup pattern: Blob → object
 * URL → synthetic click → revoke shortly after.
 */
function downloadJson(filename, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function downloadCsv(filename, text) {
  const blob = new Blob([text], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function csvStamp() { return new Date().toISOString().slice(0, 10); }

const DEFAULTS = E.DEFAULT_SETTINGS;
let settings = E.defaultSettings();
let state = E.defaultState(settings);
let frames = [];
let replays = [];
let selectedReplayId = null;
let replayCursor = 0;
let replayTimer = null;
let recordings = {};        // roundId -> stored recording (blob included)
const recordingUrls = {};   // roundId -> object URL, created lazily
let turboStats = {};        // pt_turbo_stats: route timings + pageJank, read-only here
let preferFrameOverVideo = false;
let lastFingerprint = '';
let replayShell = null;   // persistent replay DOM, so the video survives updates
let replayRaf = null;     // requestAnimationFrame handle for video-driven sync
// D-17: the session AI review lives in module state and is re-injected into
// the staged markup on every render. It used to be written into the live DOM
// only, so the next staged refresh (whose markup still held the empty box)
// wiped the answer seconds after it appeared.
let sessionReview = null; // { text, error }
// D-18: chain verification is memoized by a cheap fingerprint (length + head
// hash + the claim inputs). Without it every staged leaderboard render showed
// the "Checking…" placeholder again and re-ran SHA-256 over the WHOLE chain
// ~once a second — and an in-flight verify could land in a detached node.
let lbVerifyCache = null;      // { key, valid, problems, ok, diff, derivedPnlSol }
let lbVerifyInFlightKey = null;
// F-14: the attestation chain lives in its own segmented storage keys
// (pt_attest_seg_<n> + pt_attest_meta), not inside pt_state. loadAll reads it
// here; renderLeaderboard/bindLeaderboard consume this array in exactly the
// format buildSubmission has always taken.
let attestChain = [];
let attestChainLoaded = false; // false until a chain read has actually succeeded
let attestMigrateNudged = false;
/**
 * Storage access that fails soft — same contract as content.js's store helper:
 * get() resolves null when the read FAILED (chrome.runtime.lastError or a
 * throw) and {} when it succeeded but nothing is stored. Callers must never
 * treat a failed read as "empty wallet" — loadAll would fabricate a fresh
 * state and the next note/review save would persist that empty wallet over
 * the real one at seq+1 (D-15).
 *
 * set() rejects on failure so a lost write can be shown instead of being
 * silently swallowed (D-25).
 */
const store = {
  get: (keys) => new Promise((resolve) => {
    try {
      chrome.storage.local.get(keys, (value) => {
        if (chrome.runtime && chrome.runtime.lastError) { resolve(null); return; }
        resolve(value || {});
      });
    } catch (_) { resolve(null); }
  }),
  set: (obj) => new Promise((resolve, reject) => {
    try {
      chrome.storage.local.set(obj, () => {
        if (chrome.runtime && chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message || 'storage write failed'));
          return;
        }
        resolve();
      });
    } catch (err) { reject(err); }
  }),
};
// D-15: true while the most recent storage read failed. The dashboard keeps
// rendering whatever it already holds and refuses every write until a later
// read succeeds — writing while blind is how a fabricated empty wallet
// overwrites the real one.
let storageReadFailed = false;

const SECTIONS = ['overview', 'game', 'calendar', 'journal', 'rounds', 'perps', 'replay', 'leaderboard', 'coach', 'settings'];
let currentSection = 'overview';
// The PERPS book (pt_perps). Deliberately a separate variable from
// `state`: nothing in this file may sum the two.
let perpsState = null;

async function init() {
  await loadAll();
  bindNav();
  bindShareCard();
  renderSidebar();
  renderSection(currentSection);
  // Seed the baseline so the first poll does not re-render an unchanged page.
  lastFingerprint = dataFingerprint();
  // Refresh on CHANGE, not on a timer.
  //
  // The previous build re-rendered the whole section every 5 seconds whether
  // anything had changed or not. Because renderSection() clears the section
  // first, that wiped scroll position, focus, half-typed settings, and the
  // replay's video element — the "constantly refreshing" behaviour.
  //
  // chrome.storage fires onChanged whenever the extension writes, so that is
  // the correct trigger. The interval that remains only refreshes derived
  // values (relative timestamps, live position marks) and is skipped entirely
  // when nothing is actually different.
  watchDashboardStorage();
  // D-28: live-derived values (open-position P&L, relative timestamps, the
  // sidebar equity) update IN PLACE after each change check — they never
  // rebuild a section, so scroll and hover survive the 800 ms heartbeat.
  // D-43: storage.onChanged (watchDashboardStorage) is the PRIMARY refresh
  // path — every relevant write in this profile fires it instantly. This
  // interval is only a safety net for a missed event, so it runs at 30 s,
  // not 4 s, and never while the tab is hidden: a background dashboard
  // deserializing the full state plus up to 80 base64 frames every 4 s
  // bought nothing. Returning to the tab refreshes immediately.
  setInterval(() => {
    if (document.hidden) return;
    refreshIfChanged().then(refreshLiveDerived).catch(() => {});
  }, 30_000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshIfChanged().then(refreshLiveDerived).catch(() => {});
  });

  // The overlay's Flex button lands here: #flex=<mint> opens the share
  // composer for that coin — the open position if one exists (the partial-
  // exit case), else the newest round. One-shot: the hash is cleared so a
  // reload of this tab is just the dashboard.
  const flexMatch = /[#&]flex=([^&]+)/.exec(location.hash || '');
  if (flexMatch) {
    const mint = decodeURIComponent(flexMatch[1]);
    try { history.replaceState(null, '', location.pathname); } catch (_) {}
    if ((state.positions || {})[mint]) {
      openShareCardForPosition(mint);
    } else {
      const round = (state.rounds || []).find((r) => r.mint === mint);
      if (round) openShareCard(round.id);
    }
  }
}

/**
 * D-16: init() used to be fired unawaited with no catch — any throw (legacy
 * state shapes, a corrupt backup, a renderer bug) left a permanently blank
 * dashboard with no message at all. Failures now render a plain-DOM error
 * card: message plus a reload button, built without innerHTML so the error
 * path itself can never throw on odd content.
 */
function renderInitError(err) {
  try {
    console.error('PaperTrench dashboard failed to initialise', err);
    const card = document.createElement('div');
    card.id = 'init-error';
    card.style.cssText =
      'max-width:560px;margin:60px auto;padding:24px 26px;'
      + 'background:#12161E;border:1px solid rgba(255,95,86,.45);border-radius:14px;'
      + 'color:#EAEFF7;font-family:system-ui,sans-serif';
    const title = document.createElement('h2');
    title.textContent = 'Dashboard failed to load';
    title.style.cssText = 'margin:0 0 8px;font-size:16px';
    const message = document.createElement('p');
    message.textContent = (err && err.message) ? err.message : String(err);
    message.style.cssText = 'margin:0 0 14px;color:#8D97A9;font-size:13px;word-break:break-word';
    const reload = document.createElement('button');
    reload.textContent = 'Reload dashboard';
    reload.style.cssText =
      'padding:8px 14px;border:1px solid rgba(255,255,255,.2);border-radius:8px;'
      + 'background:rgba(255,255,255,.06);color:#EAEFF7;cursor:pointer';
    reload.addEventListener('click', () => location.reload());
    card.append(title, message, reload);
    document.body.appendChild(card);
  } catch (_) { /* the error path must never throw */ }
}


/**
 * A cheap signature of everything the dashboard renders.
 *
 * Comparing this avoids the expense of a deep diff while still catching real
 * changes: a new fill, a closed round, a settings edit, or a fresh replay
 * checkpoint all move at least one of these numbers.
 */
function dataFingerprint() {
  const positions = Object.values(state.positions || {});
  const perpsPositions = perpsState ? Object.values(perpsState.positions || {}) : [];
  return [
    // Perps: a fill, a close or a liquidation must repaint the tab. Like
    // the spot line above, position IDENTITY and SIZE only — never the
    // mark, which would churn the fingerprint on every tick.
    perpsState ? (perpsState.journal || []).length : -1,
    perpsState ? (perpsState.rounds || []).length : -1,
    perpsPositions.map((p) => `${p.id}:${p.marginUsd0}`).join(','),
    (state.journal || []).length,
    (state.rounds || []).length,
    positions.length,
    // D-28: position IDENTITY and SIZE only — never the live price mark.
    // lastPriceNative moves on every 800 ms heartbeat, so including it made
    // the fingerprint churn ~1/s and renderSection replaceChildren'd the
    // visible table constantly (scroll and hover reset each second). Live
    // P&L is painted in place by refreshLiveDerived() instead.
    positions.map((p) => `${p.mint}:${p.qty}`).join(','),
    // D-27: in-place round mutations (AI review, note, thesis, recording
    // refs) change no array length, so the fingerprint could not see them —
    // with D-13 fixed those writes land in storage but the dashboard never
    // repainted. Cheap per-round markers (timestamps/lengths) catch them.
    (state.rounds || []).map((r) => [
      r.aiReview ? (Number(r.aiReview.t) || 1) : 0,
      r.note && r.note.text ? `${Number(r.note.t) || 1}.${r.note.text.length}` : 0,
      r.thesis ? ((r.thesis.text || '').length + ((r.thesis.tags || []).length)) : 0,
      r.recordingFile || '',
      r.recording ? 1 : 0,
    ].join(':')).join(','),
    Number(state.cashSol).toFixed(6),
    frames.length,
    replays.length,
    replays.reduce((sum, r) => sum + (r.checkpoints ? r.checkpoints.length : 0), 0),
    Object.keys(recordings).length,
    JSON.stringify(settings),
    // The Trench Rank card renders day-keyed values (today's drill, today's
    // reps) that change at local midnight with NO state change — the C-10
    // rule says the fingerprint must cover everything rendered, so the local
    // day joins it (same bucketing as gamify.dayKey / the calendar, D-49).
    new Date().toDateString(),
  ].join('|');
}

/** Re-render only when something the user can see has actually changed.
 *
 * changedKeys (optional) is the key set from a storage.onChanged echo. It is
 * passed straight through to loadAll, which uses it to skip re-reading the
 * megabyte-scale records that demonstrably did not change. Omit it — as the
 * first paint, the visibility return and the 30 s safety net all do — for a
 * full read. */
async function refreshIfChanged(changedKeys) {
  // Never yank the ground out from under an interaction.
  if (isUserBusy()) return;
  await loadAll(changedKeys);
  const next = dataFingerprint();
  if (next === lastFingerprint) return;
  lastFingerprint = next;
  renderSidebar();
  renderSection(currentSection);
}

/**
 * D-28: paint live-derived values IN PLACE — no section is ever rebuilt here.
 *
 * The heartbeat moves open-position marks every ~800 ms and relative
 * timestamps age every second; rebuilding a table for either reset scroll and
 * hover ~once a second. These updaters touch text nodes (and the sidebar,
 * which contains no interactive state) and nothing else.
 */
function refreshLiveDerived() {
  renderSidebar(); // has its own identical-markup guard
  updateOpenPositionMarks();
  updateRelativeTimes();
  // The curve's head point carries live unrealized P&L; a canvas redraw
  // destroys no DOM state.
  if (currentSection === 'overview') drawEquityCurve();
}

/** D-28: live open-position P&L — update the marked text nodes, never rebuild. */
function updateOpenPositionMarks() {
  document.querySelectorAll('[data-pos-row]').forEach((row) => {
    const p = (state.positions || {})[row.dataset.posRow];
    if (!p) return; // closed — the fingerprint change rebuilds the section
    const node = row.querySelector('[data-pos-pnl]');
    if (!node) return;
    const pnl = E.unrealizedPnl(p);
    // D-08: gross-invested basis, same as closed rounds.
    const pct = E.positionPnlPct(p);
    const win = pnl >= 0;
    node.classList.toggle('green', win);
    node.classList.toggle('red', !win);
    node.textContent = `${win ? '+' : ''}${fmt(pnl)} SOL (${win ? '+' : ''}${pct.toFixed(1)}%)`;
    const qtyNode = row.querySelector('[data-pos-qty]');
    if (qtyNode) qtyNode.textContent = `${fmt(p.qty, 2)} tokens`;
  });
}

/**
 * D-28: relative timestamps ("12s", "3m") are refreshed in place on the
 * change-check timer. Rendering them as churning markup made every staged
 * rebuild differ from the live DOM by nothing but the clock.
 */
function updateRelativeTimes() {
  document.querySelectorAll('[data-rel-ts]').forEach((node) => {
    const ts = Number(node.dataset.relTs);
    if (!(ts > 0)) return;
    const label = timeAgo(ts);
    if (node.textContent !== label) node.textContent = label;
  });
}

/**
 * True while the user is mid-interaction with the CURRENT section.
 *
 * Rebuilding under a focused input destroys what they are typing; rebuilding a
 * playing video restarts it. Neither is ever worth a refresh.
 *
 * D-34: busy is judged per section. Only the visible section is ever
 * rebuilt by a refresh, so only interactions INSIDE it may freeze it — a
 * focused replay scrubber must not freeze the journal, and a focused input
 * that lives outside the sections (the share-card modal) must not freeze
 * anything at all.
 */
function isUserBusy() {
  const section = document.getElementById(currentSection);
  const active = document.activeElement;
  if (active && /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)
      && section && section.contains(active)) return true;
  if (currentSection === 'replay' && replayPlaying()) return true;
  // D-20: an OPEN round-note editor counts as busy by its DOM presence,
  // focus or not. The focus-only check meant one click outside the textarea
  // let the next refresh destroy the editor and everything typed into it.
  if (currentSection === 'rounds' && section && section.querySelector('.note-input')) return true;
  // Settings is a form: rebuilding it would silently discard unsaved edits,
  // and nothing on that screen benefits from a background refresh anyway.
  if (currentSection === 'settings') return true;
  return false;
}

/**
 * React to extension writes immediately instead of waiting for a poll.
 *
 * This is what makes a fill appear in the journal the moment it happens while
 * still leaving the page completely still when nothing is going on.
 */
function watchDashboardStorage() {
  if (!chrome.storage || !chrome.storage.onChanged) return;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const relevant = ['pt_state', 'pt_settings', 'pt_frames', 'pt_turbo_stats', RP.STORAGE_KEY, AT.CHAIN_META_KEY]
      .some((key) => key in changes);
    if (!relevant) return;
    // A HIDDEN dashboard paints nothing, so re-reading the world to repaint it
    // is pure cost — and the trading tab writes the wallet on an ~800 ms
    // heartbeat while a position is open, so this listener fired ~75x a minute
    // into a tab nobody was looking at, each time deserializing the wallet, the
    // frame ring and the whole attestation chain. Nothing is missed by
    // returning: the visibilitychange handler does a FULL refresh on the way
    // back in, and the 30 s net covers a missed event.
    if (document.hidden) return;
    // D-28: heartbeat writes carry fresh live marks; paint them in place.
    // Only the keys that actually changed are re-read — see loadAll.
    refreshIfChanged(new Set(Object.keys(changes))).then(refreshLiveDerived).catch(() => {});
  });
}

/**
 * Load what the dashboard renders from.
 *
 * changedKeys is the key set from a storage.onChanged echo, or undefined for a
 * full read. Two records here are megabyte-scale and change far more rarely
 * than the wallet does — the capture-frame ring (up to 80 base64 JPEGs) and the
 * segmented attestation chain — yet every wallet heartbeat used to re-read and
 * re-deserialize both to repaint a journal row. When the echo proves they did
 * not change, they are not re-read; the in-memory copies are already correct.
 *
 * The D-15 discipline is unchanged: a FAILED read (null) still keeps whatever
 * is in memory and raises the banner. Skipping a read is not a failed read —
 * it is knowing the answer already.
 */
async function loadAll(changedKeys) {
  const wantFrames = !changedKeys || changedKeys.has('pt_frames');
  const keys = ['pt_state', 'pt_settings', 'pt_turbo_stats', 'pt_perps', RP.STORAGE_KEY];
  if (wantFrames) keys.push('pt_frames');
  const s = await store.get(keys);
  if (s === null) {
    // D-15: the read FAILED — this is not "empty storage". Keep whatever is
    // already in memory, show a banner, and block writes until a read
    // succeeds. Fabricating a fresh wallet here and then saving a note would
    // persist an empty wallet over the real one.
    storageReadFailed = true;
    renderStorageErrorBanner();
    return;
  }
  storageReadFailed = false;
  renderStorageErrorBanner();
  settings = E.mergeSettings(s.pt_settings);
  state = s.pt_state || E.defaultState(settings);
  if (wantFrames) frames = s.pt_frames || [];
  turboStats = s.pt_turbo_stats || {};
  // The perps book is revision-wrapped by its content script ({rev, state}).
  // A shape that is not a book degrades to null so the tab says "nothing
  // yet" rather than throwing on a half-written record.
  const perpsRec = s.pt_perps && s.pt_perps.state;
  perpsState = perpsRec && typeof perpsRec === 'object' && perpsRec.positions
    && typeof perpsRec.cashUsd === 'number' ? perpsRec : null;
  replays = RP.normalizeReplayList(s[RP.STORAGE_KEY]);

  // F-14: the chain lives in segmented storage. A failed read keeps the
  // previous in-memory chain — same D-15 discipline as the wallet: an
  // unreadable record must never repaint as "no trades committed yet". A
  // state that still carries a legacy in-state chain (the worker has not
  // migrated yet) is readable as-is; the nudge asks the worker to move it.
  // The chain is re-read when its own meta key changed, when a legacy in-state
  // chain is present (the worker has not migrated it yet, so state IS the
  // chain), or when nothing has been loaded yet. A wallet heartbeat that did
  // not touch the chain cannot have changed it.
  const legacyInState = Array.isArray(state.attestChain) && state.attestChain.length > 0;
  const wantChain = !changedKeys || changedKeys.has(AT.CHAIN_META_KEY) || legacyInState || !attestChainLoaded;
  if (wantChain) {
    try {
      const { meta, chain } = await AT.readChainStore(async (keys) => {
        const value = await store.get(keys);
        if (value === null) throw new Error('attest store unreadable');
        return value;
      });
      attestChain = !meta.length && legacyInState ? state.attestChain : chain;
      attestChainLoaded = true;
    } catch (_) { /* keep the previous chain */ }
  }
  if (!attestMigrateNudged && Array.isArray(state.attestChain) && state.attestChain.length) {
    attestMigrateNudged = true;
    chrome.runtime.sendMessage({ type: 'pt_attest_migrate' }).catch(() => {});
  }
  // D-40: everything the replay view is derived from was just replaced.
  invalidateReplayView();
  if (!selectedReplayId && replays[0]) selectedReplayId = replays[0].sessionId;

  // Videos are not needed to paint anything except Replay, and they come from
  // IndexedDB, which can be slow or unavailable. Awaiting them here meant a
  // stalled database left the ENTIRE dashboard blank, with no error to explain
  // it. Kick the load off without blocking the first paint, then repaint the
  // Replay view only if recordings actually arrived.
  //
  // D-39: recordings only change when a new replay lands — reopening the
  // database on every refresh bought nothing. Reload them only when the
  // replay list itself changed; replay-section ENTRY also refreshes (bindNav)
  // for videos that finish saving after their replay row appeared.
  const replayFingerprint = replays.map((r) => r.sessionId).join('|');
  if (replayFingerprint !== lastRecordingsFingerprint) {
    lastRecordingsFingerprint = replayFingerprint;
    loadRecordings()
      .then(() => {
        if (Object.keys(recordings).length && currentSection === 'replay') renderSection('replay');
      })
      .catch(() => {});
  }
}
let lastRecordingsFingerprint = null;

/**
 * D-15: a visible, plain-DOM banner while storage is unreadable, removed the
 * moment a read succeeds. Without it a failed read looked exactly like a
 * fresh wallet.
 */
function renderStorageErrorBanner() {
  let banner = document.getElementById('pt-storage-error');
  if (!storageReadFailed) { if (banner) banner.remove(); return; }
  if (banner) return;
  banner = document.createElement('div');
  banner.id = 'pt-storage-error';
  banner.textContent =
    'Storage read failed — showing the last data this page loaded. Saving is '
    + 'disabled until a read succeeds. Reload the dashboard if this persists.';
  banner.style.cssText =
    'background:rgba(255,95,86,.14);border-bottom:1px solid rgba(255,95,86,.45);'
    + 'color:#FFB3AE;padding:9px 26px;font-size:12.5px;font-weight:600';
  document.body.insertBefore(banner, document.body.firstChild);
}

async function saveSettings() {
  // D-15: never write over storage we could not read — the in-memory copy
  // may be a fabricated default or stale.
  if (storageReadFailed) {
    throw new Error('Storage is unreadable — settings were NOT saved. Reload the dashboard and try again.');
  }
  await store.set({ pt_settings: settings });
}

/**
 * D-22: every dashboard state write goes through mutate-with-retry.
 *
 * The old saveState() was a blind read-modify-write: the dashboard and a
 * trading tab both holding seq N would each write N+1 and the loser's change
 * simply vanished. This mirrors the philosophy of content.js's persistSoon
 * writer: read the FRESHEST stored state, apply the mutation to that copy,
 * bump seq exactly once, and re-check the stored seq immediately before
 * writing — if another writer bumped it in between, re-read and re-apply the
 * mutation on the newer state (bounded retries).
 *
 * `mutate(fresh)` receives the freshly read state and edits it in place; a
 * throw inside it aborts the save. On success the written state is adopted
 * as the module's own.
 */
async function mutateState(mutate, retries = 3) {
  const unreadable = () => new Error(
    'Storage is unreadable — the wallet was NOT saved. Reload the dashboard and try again.'
  );
  // D-15: never write over storage we could not read — persisting a
  // fabricated in-memory state is how a note-save destroys the real wallet.
  if (storageReadFailed) throw unreadable();
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const stored = await store.get(['pt_state']);
    if (stored === null) throw unreadable();
    const fresh = stored.pt_state;
    if (!fresh || typeof fresh !== 'object') {
      // A successful read with nothing stored: there is no wallet to
      // annotate, and writing one from here would fabricate it (D-15).
      throw new Error('No saved wallet found to update.');
    }
    const baseSeq = Number(fresh.seq) || 0;
    mutate(fresh);
    // Bump the write counter exactly once: every writer must advance seq, or
    // a lagging content tab (which only adopts when storage's seq is strictly
    // greater) clobbers this write with a stale copy.
    fresh.seq = baseSeq + 1;
    fresh.updatedAt = Date.now();
    // Conflict check: if another writer advanced seq between our read and
    // now, our base is stale — loop and re-apply the mutation on the newer
    // state instead of overwriting it.
    const check = await store.get(['pt_state']);
    if (check === null) throw unreadable();
    const checkSeq = Number(check.pt_state && check.pt_state.seq) || 0;
    if (checkSeq !== baseSeq) continue;
    // The check above narrows the race; the worker's serialized CAS commit
    // CLOSES it — a base that went stale between check and write comes back
    // {stale} instead of clobbering, and the loop re-applies on the newer
    // state like it already knows how to.
    const committed = await chrome.runtime.sendMessage({
      type: 'pt_state_commit', state: fresh, expectedSeq: baseSeq,
    }).catch(() => null);
    if (!committed) { await store.set({ pt_state: fresh }); } // worker unreachable
    else if (!committed.ok) continue;
    state = fresh;
    // D-40: the adopted state carries new journal/rounds — replay views
    // built from the old one are stale.
    invalidateReplayView();
    return fresh;
  }
  throw new Error('Another tab kept writing the wallet — the change was NOT saved. Try again.');
}

function bindNav() {
  // Outside <nav> on purpose: nav buttons switch sections via data-section,
  // and this one opens a window instead.
  const overlayLaunch = document.getElementById('stream-overlay-btn');
  if (overlayLaunch) {
    overlayLaunch.addEventListener('click', () => {
      chrome.windows.create({
        url: chrome.runtime.getURL('overlay.html'),
        type: 'popup',
        width: 440,
        height: 560,
      });
    });
  }
  document.querySelectorAll('nav button').forEach((b) => {
    b.addEventListener('click', () => {
      currentSection = b.dataset.section;
      if (currentSection !== 'replay') { stopReplayPlayback(); releaseReplayShell(); }
      // D-39: entering Replay refreshes recordings once — a video that
      // finished saving after its replay row appeared is picked up here.
      if (currentSection === 'replay') {
        loadRecordings()
          .then(() => { if (currentSection === 'replay') renderSection('replay'); })
          .catch(() => {});
      }
      document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('active', x === b));
      SECTIONS.forEach((id) => document.getElementById(id).classList.toggle('hidden', id !== currentSection));
      renderSection(currentSection);
    });
  });
}

/**
 * Render a section without ever showing an empty frame.
 *
 * The old implementation blanked the element (`innerHTML = ''`) and then
 * rebuilt it. Between those two steps the browser could paint, so the section
 * visibly flashed empty. Sections are now built off-screen and swapped in one
 * operation — and if the resulting markup is identical to what is already on
 * screen, nothing is touched at all.
 *
 * The replay owns its own DOM lifecycle (it holds a live <video>), so it is
 * excluded from this path.
 */
function renderSection(id) {
  const el = document.getElementById(id);
  if (!el) return;

  if (id === 'replay') { renderReplay(el); return; }

  // Build into a detached element: nothing here is ever painted.
  const staged = document.createElement('div');
  if (id === 'overview') renderOverview(staged);
  else if (id === 'game') renderGame(staged);
  else if (id === 'calendar') renderCalendar(staged);
  else if (id === 'journal') renderJournal(staged);
  else if (id === 'rounds') renderRounds(staged);
  else if (id === 'perps') renderPerps(staged);
  else if (id === 'leaderboard') renderLeaderboard(staged);
  else if (id === 'coach') renderCoach(staged);
  else if (id === 'settings') renderSettings(staged);

  // Identical output means there is nothing to repaint.
  if (el.innerHTML === staged.innerHTML) return;

  // replaceChildren swaps in a single mutation, so no empty frame exists.
  if (typeof el.replaceChildren === 'function') el.replaceChildren(...staged.childNodes);
  else el.innerHTML = staged.innerHTML;
  rebindSection(id, el);
}


/**
 * Attach event handlers after a section's markup is live in the document.
 *
 * Sections are rendered into a detached element to avoid a visible empty
 * frame, which means handlers cannot be bound during render — the nodes are
 * not yet reachable from `document`.
 */
function rebindSection(id, el) {
  if (id === 'overview') {
    bindOnboarding(el);
    // The canvas needs real layout before it can be sized and drawn.
    drawEquityCurve();
    return;
  }
  if (id === 'calendar') { bindCalendar(el); return; }
  if (id === 'journal') {
    const exportBtn = el.querySelector('#journal-export');
    if (exportBtn) exportBtn.addEventListener('click', () =>
      downloadCsv(`papertrench-journal-${csvStamp()}.csv`, journalCsv(state.journal)));
    return;
  }
  if (id === 'rounds') {
    const exportBtn = el.querySelector('#rounds-export');
    if (exportBtn) exportBtn.addEventListener('click', () =>
      downloadCsv(`papertrench-rounds-${csvStamp()}.csv`, roundsCsv(state.rounds)));
    el.querySelectorAll('.review-btn').forEach((button) =>
      button.addEventListener('click', () => runReview(button.dataset.reviewId)));
    el.querySelectorAll('.replay-btn').forEach((button) =>
      button.addEventListener('click', () => openReplay(button.dataset.session)));
    el.querySelectorAll('.share-btn').forEach((button) =>
      button.addEventListener('click', () => openShareCard(button.dataset.id)));
    el.querySelectorAll('.note-btn').forEach((button) =>
      button.addEventListener('click', () => editRoundNote(button)));
    return;
  }
  if (id === 'coach') {
    const run = el.querySelector('#coach-session');
    if (run) run.addEventListener('click', runSessionReview);
    return;
  }
  if (id === 'leaderboard') { bindLeaderboard(el); return; }
  if (id === 'settings') bindSettings();
  if (id === 'game') bindGame(el);
}

/** Start/end game sessions — the ONLY writes the Game tab makes, and both go
 *  through mutateState's seq protocol like every other dashboard write. */
function bindGame(el) {
  el.querySelectorAll('[data-game-start]').forEach((button) =>
    button.addEventListener('click', async () => {
      const id = button.dataset.gameStart;
      try {
        await mutateState((fresh) => { E.startGame(fresh, id, Date.now()); });
        renderSection('game');
      } catch (err) { console.warn('start game failed', err); }
    }));
  const end = el.querySelector('#game-end');
  if (end) {
    end.addEventListener('click', async () => {
      try {
        await mutateState((fresh) => { E.endGame(fresh); });
        renderSection('game');
      } catch (err) { console.warn('end game failed', err); }
    });
  }
}

/* ---------- sidebar ---------- */

/* Gaming Mode semantics (maintainer, corrected 2026-08-05): the wall is at
 * the dashboard door, not inside it. The Game tab and every dashboard
 * gamification surface are ALWAYS here — you opt in by navigating. The
 * toggle governs the ON-CHART surfaces only (grade toasts, streak chips,
 * ambient HUD), which is why no dashboard renderer consults it. */

function renderSidebar() {
  const sb = document.getElementById('sidebar');
  if (!sb) return;
  const stats = E.sessionStats(state, settings);
  const up = stats.equityVsStart >= 0;
  const pct = settings.balanceStartSol ? (stats.equityVsStart / settings.balanceStartSol) * 100 : 0;
  const winRate = stats.winRate === null ? null : stats.winRate;

  const markup = `
    <div class="kpi hero">
      <div class="lab">Paper equity</div>
      <div class="num ${up ? 'green' : 'red'}">${fmt(stats.equitySol, 2)} <span style="font-size:13px;font-weight:700;opacity:.6">SOL</span></div>
      <div class="sub ${up ? 'green' : 'red'}">${up ? '▲' : '▼'} ${up ? '+' : ''}${fmt(stats.equityVsStart, 3)} SOL (${up ? '+' : ''}${pct.toFixed(1)}%)</div>
      ${equitySparkline()}
    </div>
    <div class="kpi">
      <div class="lab">Realized P&amp;L</div>
      <div class="num ${stats.realizedPnlSol >= 0 ? 'green' : 'red'}">${stats.realizedPnlSol >= 0 ? '+' : ''}${fmt(stats.realizedPnlSol, 3)}</div>
      <div class="sub">${stats.trades} fills · ${fmt(stats.feesPaidSol, 3)} SOL fees</div>
    </div>
    <div class="kpi">
      <div class="lab">Win rate</div>
      <div class="num">${winRate === null ? '—' : winRate.toFixed(0) + '%'}</div>
      ${winRateBar(stats)}
      <div class="sub">${stats.wins}W · ${stats.losses}L</div>
    </div>
    <div class="kpi">
      <div class="lab">Open / Rounds</div>
      <div class="num">${stats.openPositions} <span style="opacity:.35">/</span> ${stats.rounds}</div>
      <div class="sub ${stats.unrealizedSol >= 0 ? 'green' : 'red'}">${stats.unrealizedSol >= 0 ? '+' : ''}${fmt(stats.unrealizedSol, 3)} SOL unrealized</div>
    </div>
    <div class="kpi">
      <div class="lab">Flow — bought / held / sold</div>
      <div class="num" style="font-size:16px">${fmt(stats.boughtSol, 2)} <span style="opacity:.35">/</span> ${fmt(stats.heldSol, 2)} <span style="opacity:.35">/</span> ${fmt(stats.soldSol, 2)} <span style="font-size:11px;font-weight:700;opacity:.6">SOL</span></div>
      <div class="sub">Lifetime: what went in, what's still on, what came back out</div>
    </div>
  `;
  // Writing identical markup still forces a repaint; skip it.
  if (sb.innerHTML !== markup) sb.innerHTML = markup;
}

/** Win/loss proportion bar — instant read on consistency. */
function winRateBar(stats) {
  const total = stats.wins + stats.losses;
  if (!total) return '';
  const w = (stats.wins / total) * 100;
  return `
    <div style="display:flex;height:4px;margin-top:8px;border-radius:99px;overflow:hidden;background:rgba(255,255,255,.08)">
      <div style="width:${w}%;background:var(--green)"></div>
      <div style="width:${100 - w}%;background:var(--red);opacity:.75"></div>
    </div>`;
}

/** Tiny equity trend in the sidebar, built from realized round results. */
function equitySparkline() {
  const rounds = [...(state.rounds || [])].reverse();
  if (rounds.length < 2) return '';
  let eq = settings.balanceStartSol;
  const pts = [eq];
  for (const r of rounds) { eq += Number(r.pnlSol) || 0; pts.push(eq); }

  const w = 100, h = 30, pad = 3;
  const min = Math.min(...pts), max = Math.max(...pts);
  const span = max - min || Math.abs(max) || 1;
  const step = w / (pts.length - 1);
  const y = (v) => pad + (h - pad * 2) * (1 - (v - min) / span);
  const d = pts.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(2)},${y(v).toFixed(2)}`).join(' ');
  const up = pts[pts.length - 1] >= pts[0];
  const c = up ? '#34D399' : '#FF5F56';

  return `<svg class="spark-mini" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <defs><linearGradient id="kpiSpark" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${c}" stop-opacity=".3"/><stop offset="100%" stop-color="${c}" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="${d} L${w},${h} L0,${h} Z" fill="url(#kpiSpark)"/>
    <path d="${d}" fill="none" stroke="${c}" stroke-width="1.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

/* ---------- onboarding checklist ---------- */

/**
 * The first-session checklist, computed entirely from real state — nothing is
 * ever checked off that did not actually happen. Shown on the Overview until
 * every step is done (or the trader dismisses it), then permanently hidden
 * via pt_settings.onboardingDismissed. The key is only ever ADDED at
 * dismissal time; an absent key just means "still new here" (engine defaults
 * handle absence — engine.js is untouched).
 */
function onboardingSteps(state) {
  const journal = (state && state.journal) || [];
  const rounds = (state && state.rounds) || [];
  const positions = Object.values((state && state.positions) || {});
  const firstBuy = journal.some((t) => t && t.side === 'buy');
  const thesisWritten = positions.some((p) => p && p.thesis)
    || rounds.some((r) => r && r.thesis);
  const firstRound = rounds.length > 0;
  const afterObserved = rounds.some((r) => r && r.afterExit);
  // "Reviewed" means a note or an AI review on any round. Once every doing
  // step is done the habit clearly exists, so the box checks itself instead
  // of nagging about a specific feature.
  const reviewed = rounds.some((r) => r && ((r.note && r.note.text) || r.aiReview))
    || (firstBuy && thesisWritten && firstRound && afterObserved);
  return [
    { id: 'buy', done: firstBuy, label: 'Make your first paper buy',
      sub: 'Open a coin on a supported site and hit BUY (PAPER). Fake money, real price.' },
    { id: 'thesis', done: thesisWritten, label: 'Write a thesis while a position is open',
      sub: 'Say why, before you know the outcome. Nobody grades the prose.' },
    { id: 'round', done: firstRound, label: 'Close your first round trip',
      sub: 'Sell all the way out and the round lands in Rounds, graded.' },
    { id: 'after', done: afterObserved, label: 'See The After',
      sub: 'An hour after an exit, what the coin actually did lands on the round.' },
    { id: 'review', done: reviewed, label: 'Review a closed round',
      sub: 'Add a note (or run an AI review) on a round — the lesson is the point.' },
    { id: 'graduation', done: rounds.length >= 50, label: '50 rounds toward the graduation bar',
      sub: 'Ten trades prove nothing. The honest sample starts at 50.',
      progress: `${Math.min(rounds.length, 50)} / 50` },
  ];
}

let onboardingDismissInFlight = false;

/**
 * Persist onboardingDismissed: true into pt_settings. D-19 discipline: the
 * one key is laid over a FRESH read, never the stale module copy; D-15
 * discipline: an unreadable read refuses the write and keeps the card (it
 * costs nothing and retries next render). The in-memory copy is adopted only
 * after the write lands.
 */
async function persistOnboardingDismissal() {
  if (onboardingDismissInFlight || settings.onboardingDismissed === true) return;
  onboardingDismissInFlight = true;
  try {
    if (storageReadFailed) return;
    const stored = await store.get(['pt_settings']);
    if (stored === null) return;
    const fresh = E.mergeSettings(stored.pt_settings);
    fresh.onboardingDismissed = true;
    await store.set({ pt_settings: fresh });
    settings = fresh;
  } catch (_) {
    // A failed write keeps the card — no state was changed.
  } finally {
    onboardingDismissInFlight = false;
  }
}

function renderOnboarding() {
  if (settings.onboardingDismissed === true) return '';
  const steps = onboardingSteps(state);
  const doneCount = steps.filter((s) => s.done).length;
  if (doneCount === steps.length) {
    // Cleared for real: persist the dismissal so the card never returns.
    persistOnboardingDismissal();
    return '';
  }
  const icon = (done) => (done
    ? '<span class="green" style="font-weight:800">✓</span>'
    : '<span class="dim" style="font-weight:800">○</span>');
  return `
    <div class="card" id="onboarding-card" style="margin-bottom:16px">
      <h3>Finding your way around <span class="tag">${doneCount}/${steps.length}</span>
        <button class="btn-sec" id="onboard-dismiss" style="margin-left:auto">I know my way around</button>
      </h3>
      <p class="dim" style="margin-top:0;font-size:12.5px;line-height:1.55">
        Six things worth doing once. Each checks itself off from your real
        record, and this card leaves for good when you're done with it.
      </p>
      ${steps.map((s) => `
        <div class="stat" style="align-items:center">
          <span>${icon(s.done)} <strong style="color:var(--text);font-size:12.5px">${esc(s.label)}</strong>
            <span class="dim" style="display:block;font-size:11px;margin-top:2px">${esc(s.sub)}</span></span>
          ${s.id === 'graduation'
            ? `<span style="white-space:nowrap;font-weight:750">${esc(s.progress)}
                <button class="btn-sec" id="onboard-coach" style="margin-left:8px;padding:4px 10px;font-size:11px">Graduation bar →</button></span>`
            : ''}
        </div>`).join('')}
    </div>`;
}

/** Wire the checklist's two buttons once the overview markup is live. */
function bindOnboarding(el) {
  const dismiss = el.querySelector('#onboard-dismiss');
  if (dismiss) {
    dismiss.addEventListener('click', async () => {
      dismiss.disabled = true;
      await persistOnboardingDismissal();
      lastFingerprint = dataFingerprint();
      renderSection('overview');
    });
  }
  const coach = el.querySelector('#onboard-coach');
  if (coach) {
    coach.addEventListener('click', () => {
      const nav = document.querySelector('nav button[data-section="coach"]');
      if (nav) nav.click();
    });
  }
}

/* ---------- overview ---------- */

function renderOverview(el) {
  const stats = E.sessionStats(state, settings);
  const best = [...(state.rounds || [])].sort((a, b) => b.pnlSol - a.pnlSol)[0];
  const worst = [...(state.rounds || [])].sort((a, b) => a.pnlSol - b.pnlSol)[0];

  // D-07: the Best/Worst tiles are coloured by the ACTUAL sign of the value
  // (a session of only losses has a negative "best" round, and vice versa),
  // and every value carries an explicit sign — the old Worst tile dropped it.
  el.innerHTML = `
    ${renderOnboarding()}
    <div class="grid2" style="margin-bottom:16px">
      ${statTile('Best round', best ? `${best.pnlSol >= 0 ? '+' : ''}${fmt(best.pnlSol, 3)} SOL` : '—', best && best.pnlSol < 0 ? 'red' : 'green', best ? `${best.symbol} · ${best.pnlPct >= 0 ? '+' : ''}${best.pnlPct.toFixed(1)}%` : 'No closed rounds yet')}
      ${statTile('Worst round', worst ? `${worst.pnlSol >= 0 ? '+' : ''}${fmt(worst.pnlSol, 3)} SOL` : '—', worst && worst.pnlSol >= 0 ? 'green' : 'red', worst ? `${worst.symbol} · ${worst.pnlPct >= 0 ? '+' : ''}${worst.pnlPct.toFixed(1)}%` : 'No closed rounds yet')}
    </div>
    ${renderTrenchRank()}
    <div class="grid2">
      <div class="card"><h3>Equity curve</h3><canvas class="chart" id="eq-canvas"></canvas></div>
      <div class="card"><h3>Recent round trips</h3><div id="rounds-mini"></div></div>
    </div>
    <div class="card" style="margin-top:16px"><h3>Live open positions</h3><div id="open-pos"></div></div>
  `;
  const miniRounds = el.querySelector('#rounds-mini');
  if (miniRounds) miniRounds.innerHTML = renderMiniRounds();
  const openPos = el.querySelector('#open-pos');
  if (openPos) {
    openPos.innerHTML = renderOpenPositions();
    // The "still holding" flex — share an OPEN position mid-trade, like the
    // real terminals do. Fresh nodes per render, so direct binding is safe.
    openPos.querySelectorAll('.share-open-btn').forEach((button) =>
      button.addEventListener('click', () => openShareCardForPosition(button.dataset.mint)));
  }
  // The canvas must be in the document before it can be measured and drawn.
}

function statTile(label, value, tone, sub) {
  return `
    <div class="card" style="padding:15px 16px">
      <div class="lab" style="font-size:9.5px;font-weight:700;letter-spacing:1.1px;text-transform:uppercase;color:var(--faint)">${esc(label)}</div>
      <div class="${tone}" style="margin-top:5px;font-size:23px;font-weight:800;letter-spacing:-0.6px">${esc(value)}</div>
      <div class="dim" style="margin-top:3px;font-size:11.5px">${esc(sub || '')}</div>
    </div>`;
}

/* ---------------- Trench Rank (docs/GAMIFY.md UI pass) ---------------- */

/** A thin progress bar; done bars go green, working bars amber. */
function rankBar(progress, done) {
  const pct = Math.round(Math.max(0, Math.min(1, Number(progress) || 0)) * 100);
  return `<div class="rank-bar"><div class="rank-bar-fill${done ? ' done' : ''}" style="width:${pct}%"></div></div>`;
}

/** One streak stat: flame only from 3 up — below that it is noise, not fire. */
function streakStat(label, s) {
  const cur = s && Number.isFinite(s.current) ? s.current : 0;
  const best = s && Number.isFinite(s.best) ? s.best : 0;
  const flame = cur >= 3 ? '🔥 ' : '';
  return `
    <div class="stat" title="${esc(`Best: ${best}`)}">
      <span class="dim">${esc(label)}</span>
      <span class="mono">${flame}${cur > 0 ? cur : '—'}</span>
    </div>`;
}

/**
 * The Trench Rank card: rank + level, the next gate's progress, discipline
 * streaks, today's drill, and the badge case. Everything is derived live by
 * PTGamify from the same journal every other surface reads — this card can
 * disagree with nothing (GAMIFY.md doctrine 2/4). Soft-degrades to nothing
 * when gamify.js is absent, like the graduation panel does (D-16 class).
 */
function renderTrenchRank() {
  const G = window.PTGamify;
  if (!G) return '';
  const r = G.rank(state);
  if (!r) return '';
  const now = Date.now();
  const rep = G.reps(state, now);
  const st = G.streaks(state);
  const drill = G.drills(state, now);
  const badges = G.badges(state);

  const gates = r.next ? r.next.requirements.map((g) => `
      <div class="rank-gate" title="${esc(g.label)}">
        <span class="rank-gate-label">${g.done ? '<span class="green">✓</span> ' : ''}${esc(g.label)}</span>
        ${rankBar(g.progress, g.done)}
      </div>`).join('') : '';

  const badgeCase = badges.map((b) => {
    const when = b.earnedAt ? ` — ${formatDateTime(b.earnedAt)}` : '';
    return `<span class="tag badge${b.earned ? ' earned' : ''}" title="${esc(b.detail + (b.earned ? when : ''))}">${esc(b.label)}</span>`;
  }).join('');

  const repsLine = rep.today.capped
    ? 'Rep cap reached — tired reps don’t count. Review, don’t grind.'
    : rep.today.diminished
      ? `Rep ${rep.today.count} today — past ${G.REP_FULL_PER_DAY} they count half.`
      : `${rep.today.count} of ${G.REP_FULL_PER_DAY} full-credit reps used today.`;

  return `
    <div class="card" style="margin-top:16px">
      <h3>Trench Rank
        <span style="margin-left:auto;font-weight:700;color:var(--amber)">TIER ${r.tier} · ${esc(r.name.toUpperCase())}</span>
      </h3>
      <div class="dim" style="font-size:11.5px;margin-bottom:10px">
        LVL ${rep.level} · ${fmt(rep.total, 1)} reps — ${esc(repsLine)}
      </div>
      ${r.next ? `
      <div class="lab" style="font-size:9.5px;font-weight:700;letter-spacing:1.1px;text-transform:uppercase;color:var(--faint);margin-bottom:6px">Next: ${esc(r.next.name)}</div>
      ${gates}` : `
      <div class="green" style="font-size:12.5px;margin-bottom:6px">Graduated — the bar is passed. The next step is not in this extension.</div>`}
      <div class="rank-streaks">
        ${streakStat('Journal streak', st.journal)}
        ${streakStat('Clean exits', st.cleanExit)}
        ${streakStat('No revenge', st.noRevenge)}
      </div>
      <div class="stat" title="${esc(drill.detail)}">
        <span class="dim">Today’s drill: ${esc(drill.label)}</span>
        <span class="mono">${drill.done ? '<span class="green">DONE</span>' : drill.progress >= drill.target ? '<span class="red">NOT MET</span>' : `${drill.progress}/${drill.target}`}</span>
      </div>
      <div class="rank-badges">${badgeCase}</div>
    </div>`;
}

/* ---------------- the Game tab (docs/GAMIFY.md, community-requested) ------
 * The full profile: ladder with every tier, the chart-bound trading games,
 * challenge tracks, grade distribution, and the badge case. Everything is
 * the same derived PTGamify data the overview card reads — this tab can
 * disagree with nothing. Games are RULESETS over real paper trading on real
 * charts: no synthetic market, no guess-the-candle, and the loop still ends
 * at graduation on purpose.
 */
function renderGame(el) {
  const G = window.PTGamify;
  if (!G) { el.innerHTML = `<div class="card">${emptyState('Game module not loaded', 'gamify.js is missing from this build.')}</div>`; return; }
  const r = G.rank(state);
  if (!r) { el.innerHTML = `<div class="card">${emptyState('Game module not ready', 'mastery.js is missing from this build.')}</div>`; return; }
  const now = Date.now();
  const rep = G.reps(state, now);
  const st = G.streaks(state);
  const drill = G.drills(state, now);
  const games = G.games(state, now);
  const challenges = G.challenges(state);
  const badges = G.badges(state);

  // Grade distribution over the recent window — one pass, same map the
  // rounds table uses (never per-cell recomputation).
  const tally = { S: 0, A: 0, B: 0, C: 0, D: 0, F: 0 };
  let graded = 0;
  for (const round of (state.rounds || []).slice(0, 30)) {
    const g = G.roundGrade(state, round);
    if (!g) continue;
    tally[g.letter] += 1;
    graded += 1;
  }
  const GRADE_TONE = { S: 'var(--violet)', A: 'var(--green)', B: 'var(--blue)', C: 'var(--amber)', D: 'var(--red)', F: 'var(--red)' };
  const distro = graded ? Object.keys(tally).map((l) => `
      <div class="game-grade" title="${tally[l]} of your last ${graded} graded rounds">
        <span class="mono" style="color:${GRADE_TONE[l]};font-weight:800">${l}</span>
        <div class="rank-bar"><div class="rank-bar-fill" style="width:${Math.round((tally[l] / graded) * 100)}%;background:${GRADE_TONE[l]}"></div></div>
        <span class="dim mono" style="font-size:11px">${tally[l]}</span>
      </div>`).join('') : `<div class="dim" style="font-size:12px">No graded rounds yet — close a round and the receipt starts here.</div>`;

  const ladder = G.RANKS.map((tier) => {
    const stateCls = tier.tier < r.tier ? 'done' : tier.tier === r.tier ? 'current' : '';
    return `
      <div class="game-tier ${stateCls}">
        <span class="mono tier-num">T${tier.tier}</span>
        <span class="tier-name">${esc(tier.name)}</span>
        ${tier.tier < r.tier ? '<span class="green">✓</span>' : tier.tier === r.tier ? '<span class="tier-here">YOU</span>' : ''}
      </div>`;
  }).join('');

  const gates = r.next ? r.next.requirements.map((g) => `
      <div class="rank-gate" title="${esc(g.label)}">
        <span class="rank-gate-label">${g.done ? '<span class="green">✓</span> ' : ''}${esc(g.label)}</span>
        ${rankBar(g.progress, g.done)}
      </div>`).join('') : '';

  // The session panel: a game the user explicitly STARTED, scored live over
  // the rounds closed since. Terminal results stay until dismissed here.
  const session = typeof G.gameSession === 'function' ? G.gameSession(state) : null;
  const sessionPanel = session ? (() => {
    const label = { gauntlet: 'The Gauntlet', 'one-shot': 'One-Shot', 'score-attack': 'Score Attack' }[session.id] || session.id;
    const tone = session.status === 'won' ? 'green' : session.status === 'live' ? 'amber' : 'red';
    const headline = session.status === 'live'
      ? (session.id === 'score-attack' && session.score !== null ? `${session.score.toFixed(0)}% avg` : `${session.progress}/${session.target}`)
      : session.status.toUpperCase();
    return `
    <div class="card game-session">
      <h3>GAME ON — ${esc(label)}
        <button class="btn-sec" id="game-end" style="margin-left:auto">${session.status === 'live' ? 'End game' : 'Dismiss result'}</button>
      </h3>
      <div class="${tone}" style="font-size:21px;font-weight:850;letter-spacing:-0.4px">${esc(headline)}</div>
      <div class="dim" style="font-size:11.5px;margin-top:3px">${esc(session.detail)} · ${session.rounds} round${session.rounds === 1 ? '' : 's'} this session — go trade it on the chart, the HUD is riding along.</div>
    </div>`;
  })() : '';

  const gameCards = games.map((g) => {
    let status = '';
    if (g.id === 'gauntlet') {
      status = `
        <div class="stat"><span class="dim">Run</span><span class="mono">${g.progress}/${g.target}</span></div>
        <div class="stat"><span class="dim">Best run</span><span class="mono">${g.best}</span></div>
        <div class="stat"><span class="dim">Completed</span><span class="mono">${g.completions}×</span></div>
        ${rankBar(g.progress / g.target, g.progress >= g.target)}`;
    } else if (g.id === 'one-shot') {
      const verdict = g.today.verdict === 'won' ? '<span class="green">WON</span>'
        : g.today.verdict === 'missed' ? '<span class="amber">MISSED</span>'
          : g.today.verdict === 'busted' ? '<span class="red">BUSTED</span>'
            : '<span class="dim">no round yet</span>';
      status = `
        <div class="stat"><span class="dim">Days won</span><span class="mono">${g.wins}</span></div>
        <div class="stat"><span class="dim">Today (${g.today.rounds} round${g.today.rounds === 1 ? '' : 's'})</span><span class="mono">${verdict}</span></div>`;
    } else if (g.id === 'score-attack') {
      status = `
        <div class="stat"><span class="dim">High score</span><span class="mono">${g.best ? `${g.best.score.toFixed(0)}% avg · ${g.best.rounds} rounds` : '—'}</span></div>
        <div class="stat"><span class="dim">Today</span><span class="mono">${g.today.rounds >= 1 ? `${g.today.avg === null ? '—' : g.today.avg.toFixed(0) + '% avg'} · ${g.today.rounds}/3 rounds` : '—'}</span></div>`;
    }
    const isRunning = session && session.id === g.id;
    return `
      <div class="card game-card">
        <h3>${esc(g.label)}</h3>
        <div class="dim" style="font-size:11.5px;margin-bottom:8px">${esc(g.detail)}</div>
        ${status}
        <button class="btn ${isRunning ? 'btn-sec' : ''}" data-game-start="${esc(g.id)}" style="width:100%" ${isRunning ? 'disabled' : ''}>
          ${isRunning ? 'Running…' : session ? 'Switch to this' : 'Start game'}
        </button>
      </div>`;
  }).join('');

  const challengeRows = challenges.map((c) => `
      <div class="stat" title="${esc(c.detail)}">
        <span class="dim">${c.done ? '<span class="green">✓</span> ' : ''}${esc(c.label)}${c.completions ? ` <span class="tag">${c.completions}×</span>` : ''}</span>
        <span class="mono">${c.done && c.target === 1 ? '<span class="green">DONE</span>' : `${c.progress}/${c.target}`}</span>
      </div>`).join('');

  const badgeCase = badges.map((b) => {
    const when = b.earnedAt ? ` — ${formatDateTime(b.earnedAt)}` : '';
    return `<span class="tag badge${b.earned ? ' earned' : ''}" title="${esc(b.detail + (b.earned ? when : ''))}">${esc(b.label)}</span>`;
  }).join('');

  el.innerHTML = `
    <div class="game-tape-bg" aria-hidden="true"><span>${'“PAPER TRENCH” · SIMULATED FUNDS · '.repeat(5)}</span></div>
    ${sessionPanel}
    <div class="card"${session ? ' style="margin-top:16px"' : ''}>
      <h3>Trench profile
        <span style="margin-left:auto;font-weight:700;color:var(--amber)">TIER ${r.tier} · ${esc(r.name.toUpperCase())}</span>
      </h3>
      <div class="dim" style="font-size:11.5px;margin-bottom:10px">LVL ${rep.level} · ${fmt(rep.total, 1)} reps · next level at ${fmt(rep.nextLevelAt, 0)}</div>
      <div class="game-ladder">${ladder}</div>
      ${r.next ? `<div class="lab" style="font-size:9.5px;font-weight:700;letter-spacing:1.1px;text-transform:uppercase;color:var(--faint);margin:10px 0 6px">Next gate: ${esc(r.next.name)}</div>${gates}`
    : '<div class="green" style="font-size:12.5px;margin-top:8px">Graduated. The bar is passed — the next step is a small, careful real start, not another level here.</div>'}
      <div class="rank-streaks">
        ${streakStat('Journal streak', st.journal)}
        ${streakStat('Clean exits', st.cleanExit)}
        ${streakStat('No revenge', st.noRevenge)}
      </div>
    </div>
    <div class="lab game-lab">Trading games — played on the live charts you already trade</div>
    <div class="grid3">${gameCards}</div>
    <div class="grid2" style="margin-top:16px">
      <div class="card">
        <h3>Challenges</h3>
        ${challengeRows}
        <div class="stat" title="${esc(drill.detail)}">
          <span class="dim">Today’s drill: ${esc(drill.label)}</span>
          <span class="mono">${drill.done ? '<span class="green">DONE</span>' : drill.progress >= drill.target ? '<span class="red">NOT MET</span>' : `${drill.progress}/${drill.target}`}</span>
        </div>
      </div>
      <div class="card">
        <h3>Process, last ${graded || 30} graded rounds</h3>
        ${distro}
      </div>
    </div>
    <div class="card" style="margin-top:16px">
      <h3>Badge case</h3>
      <div class="rank-badges" style="margin-top:2px">${badgeCase}</div>
      <div class="dim" style="font-size:11px;margin-top:10px">There are no badges for profit, win streaks, or volume — those train the habits this trainer exists to break.</div>
    </div>`;
}

/**
 * Equity curve, drawn crisply on a device-pixel-ratio-scaled canvas.
 *
 * D-01: the points come from E.equityCurvePoints, which debits buy-side fees
 * as the journal is walked. The old accumulation summed sell pnlSol alone —
 * net of sell fees but NOT buy fees — so the curve floated above true equity
 * by the cumulative buy fees, visibly disagreeing with the equitySol KPI on
 * the same screen. The final point now equals E.equitySol (cash + marked
 * positions) exactly.
 */
function drawEquityCurve() {
  const cvs = document.getElementById('eq-canvas');
  if (!cvs || typeof cvs.getContext !== 'function') return;
  const ctx = cvs.getContext('2d');
  if (!ctx) return;

  // Match the backing store to the CSS box so lines land on real pixels.
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssW = cvs.clientWidth || 760;
  const cssH = cvs.clientHeight || 260;
  cvs.width = Math.round(cssW * dpr);
  cvs.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const start = Number(settings.balanceStartSol) || 0;
  const pts = E.equityCurvePoints(state, start);

  if ((state.journal || []).length === 0) {
    ctx.fillStyle = '#5A6273';
    ctx.textAlign = 'center';
    ctx.font = '500 12px ui-sans-serif, system-ui, sans-serif';
    ctx.fillText('No trades yet — your equity curve will appear here.', cssW / 2, cssH / 2);
    return;
  }

  const padL = 52, padR = 16, padT = 16, padB = 26;
  const xs = pts.map((p) => p.t);
  const ys = pts.map((p) => p.eq);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  let lo = Math.min(...ys, start), hi = Math.max(...ys, start);
  const span = (hi - lo) || Math.abs(hi) * 0.04 || 1;
  lo -= span * 0.14; hi += span * 0.14;

  const X = (t) => padL + (cssW - padL - padR) * (x1 === x0 ? 1 : (t - x0) / (x1 - x0));
  const Y = (v) => padT + (cssH - padT - padB) * (1 - (v - lo) / (hi - lo));

  // horizontal grid + value labels
  ctx.font = '500 10px ui-monospace, monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const v = lo + (hi - lo) * (i / 4);
    const y = Y(v);
    ctx.strokeStyle = 'rgba(255,255,255,0.055)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(cssW - padR, y); ctx.stroke();
    ctx.fillStyle = '#5A6273';
    ctx.fillText(v.toFixed(2), padL - 9, y);
  }

  const profitable = pts[pts.length - 1].eq >= start;
  const stroke = profitable ? '#34D399' : '#FF5F56';

  // gradient area under the curve
  const grad = ctx.createLinearGradient(0, padT, 0, cssH - padB);
  grad.addColorStop(0, profitable ? 'rgba(52,211,153,0.30)' : 'rgba(255,95,86,0.30)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.beginPath();
  ctx.moveTo(X(pts[0].t), Y(pts[0].eq));
  for (const p of pts) ctx.lineTo(X(p.t), Y(p.eq));
  ctx.lineTo(X(pts[pts.length - 1].t), cssH - padB);
  ctx.lineTo(X(pts[0].t), cssH - padB);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // starting-balance reference
  ctx.setLineDash([4, 5]);
  ctx.strokeStyle = 'rgba(255,157,69,0.5)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(padL, Y(start)); ctx.lineTo(cssW - padR, Y(start)); ctx.stroke();
  ctx.setLineDash([]);

  // the curve itself, with a soft glow
  ctx.shadowColor = profitable ? 'rgba(52,211,153,0.45)' : 'rgba(255,95,86,0.45)';
  ctx.shadowBlur = 11;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  pts.forEach((p, i) => (i === 0 ? ctx.moveTo(X(p.t), Y(p.eq)) : ctx.lineTo(X(p.t), Y(p.eq))));
  ctx.stroke();
  ctx.shadowBlur = 0;

  // head marker
  const last = pts[pts.length - 1];
  ctx.fillStyle = stroke;
  ctx.beginPath(); ctx.arc(X(last.t), Y(last.eq), 3.5, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(X(last.t), Y(last.eq), 3.5, 0, Math.PI * 2); ctx.stroke();
}

function renderMiniRounds() {
  const rounds = (state.rounds || []).slice(0, 9);
  if (!rounds.length) return emptyState('No closed round trips yet', 'Complete a paper trade to see it here.');
  const peak = Math.max(...rounds.map((r) => Math.abs(r.pnlSol)), 1e-9);
  return rounds.map((r) => {
    const win = r.pnlSol >= 0;
    const w = Math.max(3, (Math.abs(r.pnlSol) / peak) * 100);
    return `
      <div class="stat" style="align-items:center">
        <span style="min-width:0;color:var(--text)">
          <strong>${esc(r.symbol)}</strong>
          <span class="dim" style="font-size:11px"> · ${(r.heldMs / 60000).toFixed(1)}m</span>
          <span style="display:block;margin-top:5px;height:3px;width:${w}%;border-radius:99px;background:${win ? 'var(--green)' : 'var(--red)'};opacity:.65"></span>
        </span>
        <span class="${win ? 'green' : 'red'}" style="font-weight:750;white-space:nowrap">
          ${win ? '+' : ''}${fmt(r.pnlSol, 3)} SOL
          <span style="display:block;font-size:10.5px;opacity:.7;font-weight:600">${win ? '+' : ''}${r.pnlPct.toFixed(1)}%</span>
        </span>
      </div>`;
  }).join('');
}

function renderOpenPositions() {
  const mints = Object.keys(state.positions || {});
  if (!mints.length) return emptyState('No open positions', 'Your live paper positions will appear here.');
  return mints.map((m) => {
    const p = state.positions[m];
    const pnl = E.unrealizedPnl(p);
    // D-08: percentage on the gross-invested basis — the same denominator
    // closed rounds use (engine closeRound: returned/investedSol − 1). The
    // old pnl/costSol (net-of-fee) basis made the % jump ~2×feeBps at the
    // moment of close with no price move.
    const pct = E.positionPnlPct(p);
    const win = pnl >= 0;
    // D-28: data-pos-row/-pnl/-qty mark the nodes refreshLiveDerived updates
    // in place on each heartbeat — the section itself is never rebuilt for a
    // price tick.
    return `
      <div class="stat" style="align-items:center" data-pos-row="${esc(p.mint)}">
        <span style="min-width:0;color:var(--text)">
          <strong style="font-size:14px">${esc(p.symbol)}</strong>
          <span class="dim mono" style="display:block;font-size:10.5px;margin-top:2px">${esc(E.short(p.mint))} · ${esc(p.site)}</span>
        </span>
        <span style="text-align:right;white-space:nowrap">
          <span class="mono" style="font-size:12px" data-pos-qty>${fmt(p.qty, 2)} tokens</span>
          <span class="${win ? 'green' : 'red'}" style="display:block;margin-top:3px;font-weight:800;font-size:14px" data-pos-pnl>${win ? '+' : ''}${fmt(pnl)} SOL (${win ? '+' : ''}${pct.toFixed(1)}%)</span>
        </span>
        <button class="btn-sec share-open-btn" data-mint="${esc(p.mint)}" style="margin-left:12px">Share</button>
      </div>`;
  }).join('');
}

function emptyState(title, sub) {
  return `<div class="empty"><strong>${esc(title)}</strong><span style="font-size:12px">${esc(sub || '')}</span></div>`;
}

/* ---------- P&L calendar ----------
 *
 * The daily performance grid Axiom/Padre/GMGN show for real wallets, fed by
 * the paper journal instead. Layout follows theirs: Monday-start weeks, a
 * weekly-total column, and month navigation bounded by the journal's span.
 */

// The month currently on screen; null means "the month containing today".
let calendarView = null;

function monthIndex(y, m) { return y * 12 + m; }

function renderCalendar(el) {
  const range = E.pnlCalendarRange(state);
  const now = new Date();
  const requested = calendarView || { year: now.getFullYear(), month: now.getMonth() };
  const viewIdx = Math.max(
    monthIndex(range.min.year, range.min.month),
    Math.min(monthIndex(range.max.year, range.max.month), monthIndex(requested.year, requested.month))
  );
  const view = { year: Math.floor(viewIdx / 12), month: ((viewIdx % 12) + 12) % 12 };
  calendarView = view;

  const cal = E.pnlCalendar(state, view.year, view.month);
  const t = cal.totals;
  const isCurrentMonth = cal.todayDay !== null;
  const monthName = new Date(view.year, view.month, 1)
    .toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  // D-33: the best/worst-day chip needs a SHORT month name. Deriving it by
  // splitting/slicing the long locale string breaks wherever the year comes
  // first (ja-JP, hu-HU render "2026…" → "202"); ask the locale directly.
  const monthShort = new Date(view.year, view.month, 1)
    .toLocaleDateString(undefined, { month: 'short' });
  const atMin = viewIdx <= monthIndex(range.min.year, range.min.month);
  const atMax = viewIdx >= monthIndex(range.max.year, range.max.month);
  const cls = (v) => (v > 0 ? 'green' : v < 0 ? 'red' : 'dim');
  const signed = (v) => `${v > 0 ? '+' : ''}${fmt(v, 2)}`;

  const summary = `
    <div class="cal-summary">
      <span>Realized <strong class="${cls(t.realizedSol)}">${signed(t.realizedSol)} SOL</strong></span>
      <span>Days <strong>${t.winDays}<span class="green">W</span> · ${t.lossDays}<span class="red">L</span>${t.flatDays ? ` · ${t.flatDays} flat` : ''}</strong></span>
      ${t.bestDay ? `<span>Best <strong class="green">${signed(t.bestDay.pnlSol)}</strong> <span class="dim">(${monthShort} ${t.bestDay.day})</span></span>` : ''}
      ${t.worstDay && t.worstDay.pnlSol < 0 ? `<span>Worst <strong class="red">${signed(t.worstDay.pnlSol)}</strong> <span class="dim">(${monthShort} ${t.worstDay.day})</span></span>` : ''}
      ${isCurrentMonth ? `<span>Open <strong class="${cls(cal.openPnlSol)}">${signed(cal.openPnlSol)} SOL</strong> <span class="dim">unrealized</span></span>` : ''}
    </div>`;

  const header = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
    .map((d) => `<div class="cal-head">${d}</div>`).join('') + '<div class="cal-head cal-week-head">Week</div>';

  // Dominant PROCESS grade per day (GAMIFY.md): bucketed by the LOCAL day of
  // closedAt, the same bucketing the calendar itself uses (D-49 class) — a
  // UTC bucket here would pin dots on the wrong cell across midnight. Grades
  // come from one pass over the month's rounds; ties round DOWN to the worse
  // letter — a split day is not rounded up to the better story.
  const G = window.PTGamify;
  const dayGrades = new Map();
  if (G) {
    for (const r of state.rounds || []) {
      if (!(Number(r.closedAt) > 0)) continue;
      const d = new Date(r.closedAt);
      if (d.getFullYear() !== view.year || d.getMonth() !== view.month) continue;
      const g = G.roundGrade(state, r);
      if (!g) continue;
      const list = dayGrades.get(d.getDate()) || [];
      list.push(g.letter);
      dayGrades.set(d.getDate(), list);
    }
  }
  const GRADE_ORDER = ['S', 'A', 'B', 'C', 'D', 'F'];
  const GRADE_DOT = { S: 'var(--violet)', A: 'var(--green)', B: 'var(--blue)', C: 'var(--amber)', D: 'var(--red)', F: 'var(--red)' };
  const gradeDot = (day) => {
    const letters = dayGrades.get(day);
    if (!letters || !letters.length) return '';
    const counts = {};
    for (const l of letters) counts[l] = (counts[l] || 0) + 1;
    let pick = null;
    for (const l of GRADE_ORDER) {
      if (!counts[l]) continue;
      if (!pick || counts[l] > counts[pick] || (counts[l] === counts[pick] && GRADE_ORDER.indexOf(l) > GRADE_ORDER.indexOf(pick))) pick = l;
    }
    const isTie = Object.keys(counts).some((l) => l !== pick && counts[l] === counts[pick]);
    const tip = isTie
      ? `Process: split day — ties round down to ${pick} (${letters.length} rounds)`
      : `Process: mostly ${pick} (${letters.length} round${letters.length > 1 ? 's' : ''})`;
    return `<span class="cal-grade" style="background:${GRADE_DOT[pick]}" title="${esc(tip)}"></span>`;
  };

  const body = cal.weeks.map((week) => {
    const cells = week.days.map((c) => {
      if (!c) return '<div class="cal-day blank" aria-hidden="true"></div>';
      const tone = !c.hasTrades ? '' : c.realizedSol > 0 ? 'win' : c.realizedSol < 0 ? 'loss' : 'flat';
      const today = c.day === cal.todayDay ? ' today' : '';
      const tip = c.sells
        ? Object.entries(c.symbols).map(([s, p]) => `${s} ${signed(p)}`).join('  ·  ')
        : (c.buys ? 'Open entries only — nothing realized yet' : '');
      const parts = [];
      if (c.buys) parts.push(`${c.buys} buy${c.buys > 1 ? 's' : ''}`);
      if (c.sells) parts.push(`${c.sells} sell${c.sells > 1 ? 's' : ''}`);
      return `<div class="cal-day ${tone}${today}"${tip ? ` title="${esc(tip)}"` : ''}>
        <span class="cal-date">${c.day}</span>${gradeDot(c.day)}
        ${c.sells
          ? `<span class="cal-pnl">${signed(c.realizedSol)}</span>`
          : '<span class="cal-pnl cal-zero">0</span>'}
        ${parts.length ? `<span class="cal-trades">${parts.join(' · ')}</span>` : ''}
      </div>`;
    }).join('');
    const wk = week.hasTrades
      ? `<span class="${cls(week.totalSol)}">${signed(week.totalSol)}</span>`
      : '<span class="cal-week-empty">0</span>';
    return cells + `<div class="cal-week">${wk}</div>`;
  }).join('');

  el.innerHTML = `
    <div class="card">
      <h3>P&amp;L calendar
        <span class="cal-nav">
          <button class="cal-nav-btn" data-cal="-1" ${atMin ? 'disabled' : ''} aria-label="Previous month">‹</button>
          <span class="cal-month">${monthName}</span>
          <button class="cal-nav-btn" data-cal="1" ${atMax ? 'disabled' : ''} aria-label="Next month">›</button>
        </span>
      </h3>
      ${summary}
      ${(state.journal || []).length === 0
        ? '<div class="cal-summary"><span class="dim">No paper trades yet — your daily results will fill in as you buy and sell.</span></div>'
        : ''}
      <div class="cal-grid">${header}${body}</div>
    </div>`;
}

function bindCalendar(el) {
  el.querySelectorAll('.cal-nav-btn').forEach((button) => {
    button.addEventListener('click', () => {
      const cur = calendarView || { year: new Date().getFullYear(), month: new Date().getMonth() };
      const next = cur.month + Number(button.dataset.cal);
      calendarView = { year: cur.year + Math.floor(next / 12), month: ((next % 12) + 12) % 12 };
      renderSection('calendar');
    });
  });
}

/* ---------- journal ---------- */

function renderJournal(el) {
  const rows = (state.journal || []).map((t) => `
    <tr>
      <td><span class="${t.side === 'buy' ? 'side-buy' : 'side-sell'}">${t.side.toUpperCase()}</span></td>
      <td><strong>${esc(t.symbol)}</strong></td>
      <td class="dim">${esc(t.site)}</td>
      <td class="num">${fmt(t.qty, 4)}</td>
      <td class="num">${mcapLevel(t)}</td>
      <td class="num">${fmt(t.solGross, 4)}</td>
      <td class="num dim">${t.feeSol != null ? fmt(t.feeSol, 4) : (t.solNet != null ? fmt(t.solGross - t.solNet, 4) : '—')}</td>
      <td class="num ${t.pnlSol === undefined ? 'dim' : t.pnlSol >= 0 ? 'green' : 'red'}" style="font-weight:750">
        ${t.pnlSol !== undefined ? (t.pnlSol >= 0 ? '+' : '') + fmt(t.pnlSol) : '—'}
      </td>
      <td class="dim"><span data-rel-ts="${Number(t.ts) || 0}" title="${esc(formatDateTime(t.ts))}">${timeAgo(t.ts)}</span></td>
    </tr>`).join('');
  el.innerHTML = `
    <div class="card"><h3>All fills <span class="tag">${(state.journal || []).length}</span>
      <button class="btn-sec" id="journal-export" style="margin-left:auto" ${(state.journal || []).length ? '' : 'disabled'}>Export CSV</button></h3>
      <div class="log">
        <table>
          <thead><tr><th>Side</th><th>Token</th><th>Site</th><th class="num">Qty</th><th class="num">Market cap</th><th class="num">Gross</th><th class="num">Fee</th><th class="num">P&L</th><th>When</th></tr></thead>
          <tbody>${rows || `<tr><td colspan="9">${emptyState('No fills yet', 'Paper trades will be journaled here.')}</td></tr>`}</tbody>
        </table>
      </div>
    </div>`;
}

/* ---------- rounds ---------- */

/**
 * "The After": what the coin actually did in the hour AFTER the exit —
 * observed extremes only, sample count in the tooltip, an em-dash while the
 * watch is still running or when nothing was observed. The most expensive
 * guesswork in this market, replaced with a measured number.
 */
function renderAfterCell(r) {
  const a = r.afterExit;
  if (!a) {
    const watching = (state.postWatch || []).some((w) => w.roundId === r.id);
    return watching
      ? '<span class="dim" title="Still watching the hour after your exit">watching…</span>'
      : '<span class="dim">—</span>';
  }
  const up = Number(a.maxPct) || 0;
  const down = Number(a.minPct) || 0;
  const title = `Observed over ${a.samples} sample${a.samples === 1 ? '' : 's'} in the hour after your exit`;
  return `<span title="${esc(title)}" style="font-size:11.5px">
    <span class="${up >= 100 ? 'red' : 'dim'}">↑${up >= 0 ? '+' : ''}${up.toFixed(0)}%</span>
    <span class="dim">/</span>
    <span class="${down <= -30 ? 'green' : 'dim'}">↓${down.toFixed(0)}%</span>
  </span>`;
}

/* ---------------------------------------------------------------- perps
 *
 * A SEPARATE BOOK, shown separately. The perps wallet, its rounds and its
 * totals are never added to the spot numbers anywhere in this dashboard —
 * F-30's rule, applied to the thing it was written about: two books must
 * never be indistinguishable. A leveraged run of luck must not flatter the
 * spot track record that graduation is measured on, and vice versa. Every
 * figure here is labelled as perps and lives under its own tab.
 *
 * The user report this answers: "on the perp trade it doesn't transfer" —
 * the fills were being recorded correctly in pt_perps and simply had
 * nowhere to appear.
 */

function perpsUsd(n, opts) {
  if (!Number.isFinite(n)) return '—';
  const sign = n < 0 ? '-' : (opts && opts.signed && n > 0 ? '+' : '');
  const a = Math.abs(n);
  const digits = a >= 1000 ? 2 : a >= 1 ? 2 : a >= 0.01 ? 4 : 6;
  return sign + '$' + a.toFixed(digits).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function perpsPx(n) {
  if (!Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  return n.toFixed(a >= 1000 ? 1 : a >= 10 ? 2 : a >= 0.1 ? 4 : 6)
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

const PERPS_VENUE_LABEL = { hyperliquid: 'Hyperliquid', jupiter: 'Jupiter', axiom: 'Axiom' };

function renderPerps(el) {
  const P = window.PaperPerps;
  const book = perpsState;
  const positions = book && book.positions ? Object.values(book.positions) : [];
  const rounds = book && Array.isArray(book.rounds) ? book.rounds : [];
  const totals = (book && book.totals) || {};
  const archived = (book && book.archived) || {};

  if (!book) {
    el.innerHTML = `
      <div class="card">
        <h2>Perps</h2>
        <p class="dim">No perps book yet. Open the ticket on a supported venue
        (Hyperliquid or Jupiter Perps) and your first paper position will
        appear here.</p>
      </div>`;
    return;
  }

  // Equity is marked at each position's LAST OBSERVED price, which is not
  // necessarily current — the dashboard has no venue feed of its own. Say so
  // rather than implying a live mark.
  let openEquity = 0;
  let anyMark = false;
  const posRows = positions.map((pos) => {
    const m = P && Number.isFinite(pos.lastPx) && pos.lastPx > 0 ? P.perpMark(pos, pos.lastPx) : null;
    const uPnl = m && m.ok ? m.uPnlUsd : null;
    const equity = m && m.ok ? m.equityUsd : null;
    if (Number.isFinite(equity)) { openEquity += equity; anyMark = true; }
    const liqPx = m && m.ok ? m.liqPx : pos.liqPx;
    const long = pos.side === 1;
    const gap = Number(pos.unverifiedGapSec) > 0
      ? `<br><span class="dim" style="font-size:10.5px">${Math.round(pos.unverifiedGapSec / 60)} min unobserved — real carry would be higher</span>`
      : '';
    return `
      <tr>
        <td><strong>${esc(pos.market || '?')}</strong><br><span class="dim" style="font-size:10.5px">${esc(PERPS_VENUE_LABEL[pos.venue] || pos.venue || '')}</span></td>
        <td class="${long ? 'green' : 'red'}" style="font-weight:700">${long ? 'LONG' : 'SHORT'} ${esc(String(pos.leverage || ''))}x</td>
        <td class="num">${perpsUsd(pos.marginUsd0)}</td>
        <td class="num">${perpsPx(pos.entryPx)}</td>
        <td class="num">${perpsPx(pos.lastPx)}</td>
        <td class="num red">${perpsPx(liqPx)}</td>
        <td class="num ${Number(uPnl) >= 0 ? 'green' : 'red'}" style="font-weight:800">${perpsUsd(uPnl, { signed: true })}</td>
        <td class="num">${perpsUsd(equity)}${gap}</td>
      </tr>`;
  }).join('');

  const roundRows = rounds.slice().reverse().map((r) => {
    const win = Number(r.netUsd) >= 0;
    const liquidated = r.cause === 'liquidated';
    const prov = r.provenance
      ? `<br><span class="dim" style="font-size:10.5px">${esc(String(r.provenance).split(';')[0])}</span>`
      : '';
    return `
      <tr>
        <td><strong>${esc(r.market || '?')}</strong><br><span class="dim" style="font-size:10.5px">${esc(PERPS_VENUE_LABEL[r.venue] || r.venue || '')}</span></td>
        <td class="${r.side === 'long' ? 'green' : 'red'}" style="font-weight:700">${esc(String(r.side || '').toUpperCase())} ${esc(String(r.leverage || ''))}x</td>
        <td class="num">${perpsUsd(r.marginUsd)}</td>
        <td class="num">${perpsPx(r.entryPx)} <span class="dim">→</span> ${perpsPx(r.exitPx)}</td>
        <td class="num ${win ? 'green' : 'red'}" style="font-weight:800">${perpsUsd(r.netUsd, { signed: true })}</td>
        <td class="num dim">${perpsUsd(r.feesUsd)}</td>
        <td class="num dim">${perpsUsd(r.carryUsd)}</td>
        <td>${liquidated
          ? '<span class="red" style="font-weight:700">LIQUIDATED</span>'
          : '<span class="dim">closed</span>'}${prov}</td>
      </tr>`;
  }).join('');

  // Coerced to a NUMBER before it reaches the template. Everything rendered
  // here is either esc()'d or numeric by construction, never "safe because
  // the value happens to be a number today" — stored records are data, and
  // data is the thing that turns out to be attacker-shaped later.
  const archivedRounds = Number(archived.roundsCount) > 0 ? Math.floor(Number(archived.roundsCount)) : 0;
  const trimmed = archivedRounds > 0
    ? `<p class="dim" style="font-size:11.5px">${archivedRounds} older round${archivedRounds === 1 ? '' : 's'} archived out of this table. Totals below still include them.</p>`
    : '';

  el.innerHTML = `
    <div class="card">
      <h2>Perps <span class="dim" style="font-weight:400;font-size:13px">— a separate book</span></h2>
      <p class="dim">These numbers never mix with your spot wallet. Leverage results
      do not flatter (or damage) the spot track record that graduation is measured
      on, so both stay honest.</p>
      <div class="stats">
        <div class="stat"><span class="stat-label">Paper balance</span><span class="stat-value">${perpsUsd(book.cashUsd)}</span></div>
        <div class="stat"><span class="stat-label">Open positions</span><span class="stat-value">${positions.length}</span></div>
        <div class="stat"><span class="stat-label">Closed rounds</span><span class="stat-value">${rounds.length}</span></div>
        <div class="stat"><span class="stat-label">Realized</span><span class="stat-value ${Number(totals.realizedUsd) >= 0 ? 'green' : 'red'}">${perpsUsd(totals.realizedUsd, { signed: true })}</span></div>
      </div>
      <div class="stats">
        <div class="stat"><span class="stat-label">Fees paid</span><span class="stat-value">${perpsUsd(totals.feesUsd)}</span></div>
        <div class="stat"><span class="stat-label">Funding paid</span><span class="stat-value">${perpsUsd(totals.fundingPaidUsd)}</span></div>
        <div class="stat"><span class="stat-label">Borrow paid</span><span class="stat-value">${perpsUsd(totals.borrowPaidUsd)}</span></div>
      </div>
    </div>

    <div class="card">
      <h3>Open positions</h3>
      ${positions.length ? `
      <p class="dim" style="font-size:11.5px">Marked at each position's last OBSERVED
      price${anyMark ? '' : ' (none recorded yet)'} — this page has no live venue feed,
      so these are not live ticks.</p>
      <div class="table-wrap"><table>
        <thead><tr>
          <th>Market</th><th>Side</th><th class="num">Margin</th><th class="num">Entry</th>
          <th class="num">Last mark</th><th class="num">Liq.</th><th class="num">Unrealized</th><th class="num">Equity</th>
        </tr></thead>
        <tbody>${posRows}</tbody>
      </table></div>` : '<p class="dim">Nothing open.</p>'}
    </div>

    <div class="card">
      <h3>Closed rounds</h3>
      ${trimmed}
      ${rounds.length ? `
      <div class="table-wrap"><table>
        <thead><tr>
          <th>Market</th><th>Side</th><th class="num">Margin</th><th class="num">Entry → Exit</th>
          <th class="num">Net</th><th class="num">Fees</th><th class="num">Carry</th><th>Outcome</th>
        </tr></thead>
        <tbody>${roundRows}</tbody>
      </table></div>` : '<p class="dim">No closed perps rounds yet.</p>'}
    </div>`;
}

function renderRounds(el) {
  // Grades are computed in ONE pass over the table's rounds: roundGrade scans
  // priors per call, so a naive per-cell call inside nested templates is the
  // O(n²)-of-O(n) shape that starves renders at the 500-round cap.
  const G = window.PTGamify;
  const gradeById = new Map();
  if (G) for (const r of state.rounds || []) gradeById.set(r.id, G.roundGrade(state, r));
  const rows = (state.rounds || []).map((r) => {
    const replay = RP.findReplay(replays, r.sessionId || '');
    const win = r.pnlSol >= 0;
    // D-04: three buttons in this row share the round id; the AI-review
    // button carries its own data-review-id so runReview can never grab (and
    // disable) the notes button instead.
    // D-05: replay.checkpoints is initialised [] and written nowhere, so a
    // count-based label always read "▶ 0 moments". Plain "▶ Replay" — the
    // replay view itself shows the real fill/frame timeline.
    return `
      <tr data-id="${esc(r.id)}">
        <td><strong>${esc(r.symbol)}</strong><br><span class="dim mono" style="font-size:10.5px">${esc(E.short(r.mint))}</span></td>
        <td class="dim">${esc(r.site)}</td>
        <td class="num">${(r.heldMs / 60000).toFixed(1)}m</td>
        <td class="num">${fmt(r.investedSol, 4)}</td>
        <td class="num">${fmt(r.returnedSol, 4)}</td>
        <td class="num ${win ? 'green' : 'red'}" style="font-weight:800">${win ? '+' : ''}${fmt(r.pnlSol)}</td>
        <td class="num ${win ? 'green' : 'red'}">${win ? '+' : ''}${r.pnlPct.toFixed(1)}%</td>
        ${G ? `<td>${renderGradeCell(gradeById.get(r.id), r)}</td>` : ''}
        <td class="num" style="font-size:11.5px"><span class="green">+${fmt(r.peakPnlSol)}</span> <span class="dim">/</span> <span class="red">${fmt(r.troughPnlSol)}</span></td>
        <td>${renderAfterCell(r)}</td>
        <td>${renderExitCell(r)}</td>
        <td>${renderThesisCell(r)}</td>
        <td>${renderNoteCell(r)}</td>
        <td>${r.aiReview ? '<span class="tag" style="color:var(--green);border-color:rgba(52,211,153,.3)">reviewed</span>' : '<button class="btn-sec review-btn" data-review-id="' + esc(r.id) + '">AI review</button>'}</td>
        <td>${replay ? `<button class="btn-sec replay-btn" data-session="${esc(replay.sessionId)}">▶ Replay</button>` : '<span class="dim">—</span>'}</td>
        <td><button class="btn-sec share-btn" data-id="${esc(r.id)}">Share</button></td>
        <td class="dim" style="font-size:11px">${esc(r.recordingFile || '—')}</td>
      </tr>`;
  }).join('');
  el.innerHTML = `
    <div class="card"><h3>Closed round trips <span class="tag">${(state.rounds || []).length}</span>
      <button class="btn-sec" id="rounds-export" style="margin-left:auto" ${(state.rounds || []).length ? '' : 'disabled'}>Export CSV</button></h3>
      <div class="log"><table>
        <thead><tr><th>Token</th><th>Site</th><th class="num">Held</th><th class="num">In</th><th class="num">Out</th><th class="num">P&L SOL</th><th class="num">%</th>${G ? '<th>Grade</th>' : ''}<th class="num">Peak/Worst</th><th>After (1h)</th><th>Exit</th><th>Thesis</th><th>Notes</th><th>Review</th><th>Replay</th><th>Share</th><th>Recording</th></tr></thead>
        <tbody>${rows || `<tr><td colspan="${G ? 17 : 16}">${emptyState('No closed round trips yet', 'Close a paper position to bank a round trip.')}</td></tr>`}</tbody>
      </table></div>
    </div>`;
  // Handlers are attached in rebindSection() after the element is live.
}


/**
 * Whether the exit respected the plan the thesis declared.
 *
 * A win on a broken plan is flagged as luck, because rewarding it teaches the
 * wrong lesson — which is the entire reason for journaling a thesis up front.
 */

/**
 * The round's PROCESS grade (PTGamify.roundGrade). The tooltip is the
 * receipt: every deduction's note, or the clean statement. A red round can
 * wear an S; a lucky win says so out loud (GAMIFY.md doctrine).
 */
function renderGradeCell(grade, round) {
  if (!grade) return '<span class="dim">—</span>';
  const tone = {
    S: ['var(--violet)', 'rgba(167,139,250,.4)'],
    A: ['var(--green)', 'rgba(52,211,153,.35)'],
    B: ['var(--blue)', 'rgba(106,169,255,.35)'],
    C: ['var(--amber)', 'rgba(255,157,69,.35)'],
    D: ['var(--red)', 'rgba(255,95,86,.25)'],
    F: ['var(--red)', 'rgba(255,95,86,.45)'],
  }[grade.letter] || ['var(--dim)', 'var(--line)'];
  const receipt = grade.parts.length
    ? grade.parts.map((p) => p.note).join(' ')
    : (round.pnlSol < 0 ? 'Red round, clean process — that’s the job.' : 'Clean process.');
  const lucky = grade.luckyWin ? ' <span class="tag" style="color:var(--amber);border-color:rgba(255,157,69,.35)" title="Green P&L on broken process — that habit pays until it doesn’t.">lucky</span>' : '';
  return `<span class="tag mono" style="font-weight:800;color:${tone[0]};border-color:${tone[1]}" title="${esc(receipt)}">${grade.letter}</span>${lucky}`;
}

/** How much of the available move the exit actually captured. */
function renderExitCell(round) {
  const q = E.exitQuality(round);
  if (!q) return '<span class="dim">—</span>';
  const label = {
    excellent: ['excellent', 'var(--green)', 'rgba(52,211,153,.3)'],
    good: ['good', 'var(--green)', 'rgba(52,211,153,.25)'],
    early: ['sold early', 'var(--amber)', 'rgba(255,157,69,.35)'],
    'round-tripped': ['round-tripped', 'var(--red)', 'rgba(255,95,86,.35)'],
    'no-run': ['no run', 'var(--dim)', 'var(--line)'],
    'never-worked': ['never worked', 'var(--dim)', 'var(--line)'],
  }[q.verdict] || ['—', 'var(--dim)', 'var(--line)'];

  const title = q.capturedPct === null
    ? 'The position never went green.'
    : `Captured ${q.capturedPct.toFixed(0)}% of the peak · left ${fmt(q.leftOnTableSol, 3)} SOL on the table`;
  return `<span class="tag" style="color:${label[1]};border-color:${label[2]}" title="${esc(title)}">${label[0]}</span>`;
}

function renderThesisCell(round) {
  const grade = E.gradeThesis(round);
  if (!grade) return '<span class="dim">—</span>';
  if (grade.luckyWin) {
    return `<span class="tag" style="color:var(--amber);border-color:rgba(255,157,69,.35)" title="${esc(grade.notes.join(' '))}">lucky</span>`;
  }
  if (grade.followedPlan === true) {
    return `<span class="tag" style="color:var(--green);border-color:rgba(52,211,153,.3)" title="${esc(grade.notes.join(' '))}">on plan</span>`;
  }
  if (grade.followedPlan === false) {
    return `<span class="tag" style="color:var(--red);border-color:rgba(255,95,86,.3)" title="${esc(grade.notes.join(' '))}">off plan</span>`;
  }
  return `<span class="tag" title="${esc(grade.notes.join(' '))}">logged</span>`;
}

/**
 * Post-close notes: the thesis is written BEFORE the outcome, but plenty of
 * lessons only exist AFTER it. Every closed round can carry a retrospective
 * note, editable any time, and the AI coach reads it too.
 */
function renderNoteCell(round) {
  const editBtn = `<button class="btn-sec note-btn" data-id="${esc(round.id)}">${round.note && round.note.text ? 'Edit' : 'Add note'}</button>`;
  if (round.note && round.note.text) {
    return `<span class="round-note" title="${esc(round.note.text)}">${esc(round.note.text)}</span> ${editBtn}`;
  }
  return editBtn;
}

function editRoundNote(button) {
  const roundId = button.dataset.id;
  const cell = button.closest('td');
  const round = (state.rounds || []).find((r) => r.id === roundId);
  if (!cell || !round) return;

  cell.textContent = '';
  const input = document.createElement('textarea');
  input.className = 'note-input';
  input.rows = 3;
  input.placeholder = 'What did this trade teach you?';
  input.value = (round.note && round.note.text) || '';

  const actions = document.createElement('div');
  actions.className = 'note-actions';
  const save = document.createElement('button');
  save.className = 'btn';
  save.textContent = 'Save note';
  const cancel = document.createElement('button');
  cancel.className = 'btn-sec';
  cancel.textContent = 'Cancel';
  actions.append(save, cancel);
  cell.append(input, actions);
  input.focus();

  cancel.addEventListener('click', () => renderSection('rounds'));
  save.addEventListener('click', async () => {
    const text = input.value.trim();
    try {
      // D-22: mutate-with-retry. A fill can land while the note is being
      // written; mutateState re-reads the FRESHEST state inside its retry
      // loop and re-applies the note on it, so saving a note can never
      // clobber a trade (and a concurrent seq bump triggers a re-apply
      // instead of a lost write).
      await mutateState((fresh) => {
        const target = (fresh.rounds || []).find((r) => r.id === roundId);
        if (!target) throw new Error('round no longer exists');
        if (text) target.note = { text, t: Date.now() };
        else delete target.note;
      });
    } catch (err) {
      // D-15/D-25: keep the editor (and the typed text) on screen instead of
      // silently dropping the note when storage is unreadable/unwritable.
      save.textContent = 'Save failed — retry';
      return;
    }
    lastFingerprint = dataFingerprint();
    renderSidebar();
    renderSection('rounds');
  });
}

async function runReview(roundId) {
  // D-04: the notes/share buttons and the row itself share this round id via
  // data-id — a bare [data-id=...] selector grabbed the NOTES button and
  // disabled/relabelled that instead. The review button has its own
  // data-review-id attribute, so this can only ever hit the review button.
  const b = document.querySelector(`button.review-btn[data-review-id="${roundId}"]`);
  // D-21: any failure must re-enable the button, restore its label, and show
  // the error — an unhandled rejection used to leave it (well, the notes
  // button, per D-04) stuck at "Analyzing…" forever.
  const fail = (err) => {
    if (!b) return;
    b.disabled = false;
    b.textContent = 'AI review';
    const cell = b.closest('td');
    if (cell) {
      let out = cell.querySelector('.review-error');
      if (!out) {
        out = document.createElement('div');
        out.className = 'review-error red';
        out.style.cssText = 'margin-top:4px;font-size:11px;max-width:200px;white-space:normal';
        cell.appendChild(out);
      }
      out.textContent = 'Review failed: ' + ((err && err.message) ? err.message : String(err));
    }
  };
  if (b) { b.disabled = true; b.textContent = 'Analyzing…'; }
  const round = (state.rounds || []).find((r) => r.id === roundId);
  if (!round) { fail(new Error('round not found')); return; }
  try {
    const trades = (state.journal || []).filter((t) => round.tradeIds.includes(t.id));
    const { pt_frames = [] } = (await store.get(['pt_frames'])) || {};
    const roundFrames = pt_frames.filter((frame) =>
      frame.sessionId ? frame.sessionId === round.sessionId :
        frame.mint === round.mint && frame.t >= round.openedAt && frame.t <= round.closedAt
    );
    const messages = buildCoachMessages(round, trades, roundFrames);
    const resp = await chrome.runtime.sendMessage({ type: 'pt_ai_chat', messages, maxTokens: 2000 });
    // The AI call takes seconds, and a fill can land in storage while it runs.
    // D-22: mutateState annotates the FRESHEST state inside its retry loop —
    // and retries on a concurrent seq bump — so saving the review can never
    // clobber a trade the user made mid-review.
    await mutateState((fresh) => {
      const target = (fresh.rounds || []).find((r) => r.id === roundId);
      if (!target) throw new Error('round no longer exists');
      target.aiReview = {
        t: Date.now(),
        text: resp?.reply || ('Error: ' + (resp?.error || 'unknown')),
        ok: !resp?.error,
      };
    });
  } catch (err) {
    fail(err);
    return;
  }
  lastFingerprint = dataFingerprint();
  renderSection('rounds');
}

function buildCoachMessages(round, trades, roundFrames) {
  // D-49: local time with an explicit UTC offset, matching the calendar's
  // local-day buckets — never bare UTC ISO.
  const fillText = trades.sort((a, b) => a.ts - b.ts).map((t) =>
    `${formatLocalStamp(t.ts)} ${t.side.toUpperCase()} ${t.qty.toFixed(4)} ${t.symbol} @ ${t.priceNative} SOL (gross ${t.solGross.toFixed(3)} SOL${t.pnlSol !== undefined ? `, realized ${t.pnlSol >= 0 ? '+' : ''}${t.pnlSol.toFixed(4)}` : ''})`
  ).join('\n');
  const frameText = roundFrames.length
    ? `\n\nPaperTrench captured ${roundFrames.length} timestamped chart frames during this round.`
    : '';
  // The pre-trade thesis is the strongest review material available: it states
  // the intent, so the coach can judge process rather than just outcome.
  const grade = E.gradeThesis(round);
  const thesisText = round.thesis
    ? `Stated thesis (written before the outcome was known): ${round.thesis.text || '(no note)'}\n` +
      `Setup tags: ${(round.thesis.tags || []).join(', ') || 'none'}` +
      (round.thesis.plan ? ` · plan: ${round.thesis.plan}` : '') +
      (round.thesis.targetPct ? ` · target +${round.thesis.targetPct}%` : '') +
      (round.thesis.stopPct ? ` · stop -${round.thesis.stopPct}%` : '') +
      (grade ? `\nPlan outcome: ${grade.notes.join(' ') || 'no explicit target or stop'}` : '')
    : '';
  return [
    {
      role: 'system',
      content: 'You are a no-BS Solana memecoin trading coach reviewing one paper-trade round trip. Be concrete, cite numbers, and name exactly one bad habit and one fix. If a pre-trade thesis is supplied, judge PROCESS against it: a profitable trade that broke its own plan is a process failure, and a losing trade that followed the plan is not. If a post-trade note is supplied, engage with it directly — confirm it, correct it, or sharpen it. Keep it under 350 words.',
    },
    {
      role: 'user',
      content:
        `Review this round trip:\n\n` +
        `Token: ${round.symbol} (${round.mint}) on ${round.site}\n` +
        `Held: ${(round.heldMs / 60000).toFixed(1)} minutes\n` +
        `Invested: ${round.investedSol.toFixed(4)} SOL, returned: ${round.returnedSol.toFixed(4)} SOL\n` +
        `P&L: ${round.pnlSol >= 0 ? '+' : ''}${round.pnlSol.toFixed(4)} SOL (${round.pnlPct.toFixed(1)}%)\n` +
        `Peak unrealized P&L: +${round.peakPnlSol.toFixed(4)} SOL, worst: ${round.troughPnlSol.toFixed(4)} SOL\n\n` +
        `Fills:\n${fillText}${frameText}\n\n` +
        (thesisText ? `${thesisText}\n\n` : '') +
        (round.note && round.note.text ? `Post-trade note (written after the outcome): ${round.note.text}\n\n` : '') +
        `Output: Verdict, what was done right, what was done wrong, one bad habit, and one actionable fix for next time.`,
    },
  ];
}

/* ---------- session replay ---------- */

function openReplay(sessionId) {
  selectedReplayId = sessionId;
  replayCursor = 0;
  currentSection = 'replay';
  document.querySelectorAll('nav button').forEach((button) => {
    button.classList.toggle('active', button.dataset.section === 'replay');
  });
  SECTIONS.forEach((id) => document.getElementById(id).classList.toggle('hidden', id !== 'replay'));
  renderSection('replay');
}

/**
 * Pull stored recordings into memory, keyed by round.
 *
 * Only rounds that actually have a video are loaded, and IndexedDB failures
 * degrade to the frame-based view rather than breaking the dashboard.
 */
async function loadRecordings() {
  try {
    // list() returns metadata only. Video blobs are pulled lazily and cached,
    // so a refresh does not drag tens of megabytes out of IndexedDB each time.
    const stored = await RC.list();
    const next = {};
    for (const item of stored) {
      const cached = recordings[item.id];
      if (cached && cached.blob) { next[item.id] = cached; continue; }
      const full = await RC.get(item.id);
      if (full && full.blob) next[item.id] = full;
    }
    // Release object URLs for recordings that no longer exist.
    for (const id of Object.keys(recordingUrls)) {
      if (next[id]) continue;
      try { URL.revokeObjectURL(recordingUrls[id]); } catch (_) {}
      delete recordingUrls[id];
    }
    recordings = next;
  } catch (_) {
    recordings = {};
  }
  // D-40: cached views hold a `recording` reference from the old map.
  invalidateReplayView();
}

/**
 * Playback control.
 *
 * When a recording exists the VIDEO is the clock: it plays at its natural rate
 * and a requestAnimationFrame loop maps its currentTime onto the timeline, so
 * the tape follows playback smoothly. Only when there is no video do we fall
 * back to stepping through events on a timer.
 */
function replayPlaying() {
  if (replayShell && replayShell.video) return !replayShell.video.paused && !replayShell.video.ended;
  return Boolean(replayTimer);
}

function stopReplayPlayback() {
  if (replayTimer) { clearInterval(replayTimer); replayTimer = null; }
  if (replayShell && replayShell.video && !replayShell.video.paused) {
    try { replayShell.video.pause(); } catch (_) {}
  }
}

function toggleReplayPlayback() {
  const shell = replayShell;
  if (!shell) return;

  if (shell.video) {
    if (shell.video.paused || shell.video.ended) {
      if (shell.video.ended) { try { shell.video.currentTime = 0; } catch (_) {} }
      shell.video.play().catch(() => {});
    } else {
      shell.video.pause();
    }
    updateReplayView(buildReplayView(currentReplay()));
    return;
  }

  if (replayTimer) {
    stopReplayPlayback();
    renderReplay(shell.el);
    return;
  }
  const view = buildReplayView(currentReplay());
  if (replayCursor >= view.events.length - 1) replayCursor = 0;
  replayTimer = setInterval(() => {
    // D-26: replays can empty mid-playback (wallet reset from the popup).
    // Without this guard the tick called buildReplayView(undefined) and threw
    // a TypeError every 1.1 s forever.
    const replay = currentReplay();
    if (!replay) { stopReplayPlayback(); return; }
    const current = buildReplayView(replay);
    if (replayCursor >= current.events.length - 1) stopReplayPlayback();
    else replayCursor += 1;
    updateReplayView(buildReplayView(replay));
  }, 1100);
  updateReplayView(buildReplayView(currentReplay()));
}

function currentReplay() {
  return RP.findReplay(replays, selectedReplayId || '') || replays[0];
}

/**
 * Move the timeline. When a video is present the seek is expressed as a video
 * seek, keeping a single source of truth for "where are we".
 */
function seekReplay(index, opts) {
  const shell = replayShell;
  if (!shell) return;
  const view = buildReplayView(currentReplay());
  const next = Math.max(0, Math.min(index, view.events.length - 1));
  const event = view.events[next];

  if (shell.video && event && (opts && opts.fromUser)) {
    const offset = RC.offsetForMoment(view.recording, event.at);
    if (offset !== null) {
      try { shell.video.currentTime = offset; } catch (_) {}
      // The rAF loop will pick the cursor up from the video's own time.
      replayCursor = next;
      updateReplayView(buildReplayView(currentReplay()));
      return;
    }
  }

  if (opts && opts.fromUser && !shell.video) stopReplayPlayback();
  replayCursor = next;
  updateReplayView(buildReplayView(currentReplay()));
}

/** Attach the video and start following its playback clock. */
function attachReplayVideo(view) {
  const shell = replayShell;
  const video = shell.media.querySelector('[data-r="video"]');
  if (!video) return;
  shell.video = video;

  const startOffset = RC.offsetForMoment(view.recording, view.at);
  const seekInitial = () => {
    if (startOffset === null) return;
    try { video.currentTime = startOffset; } catch (_) {}
  };
  if (video.readyState >= 1) seekInitial();
  else video.addEventListener('loadedmetadata', seekInitial, { once: true });

  const onPlayState = () => updateReplayView(buildReplayView(currentReplay()));
  video.addEventListener('play', () => { startVideoSync(); onPlayState(); });
  video.addEventListener('pause', () => { stopVideoSync(); onPlayState(); });
  video.addEventListener('ended', () => { stopVideoSync(); onPlayState(); });
  // A manual scrub of the video's own control bar must move the tape too.
  video.addEventListener('seeked', () => syncCursorToVideo(true));
}

/**
 * Follow the video's clock with requestAnimationFrame.
 *
 * rAF is frame-aligned, so the highlight advances in step with the picture
 * instead of on an arbitrary interval that beats against the frame rate.
 */
function startVideoSync() {
  stopVideoSync();
  const step = () => {
    if (!replayShell || !replayShell.video) return;
    syncCursorToVideo(false);
    replayRaf = requestAnimationFrame(step);
  };
  replayRaf = requestAnimationFrame(step);
}

function stopVideoSync() {
  if (replayRaf) { cancelAnimationFrame(replayRaf); replayRaf = null; }
}

/** Map the video's current time onto the active event, cheaply. */
function syncCursorToVideo(force) {
  const shell = replayShell;
  if (!shell || !shell.video) return;
  const view = buildReplayView(currentReplay());
  if (!view.recording) return;

  const at = RC.momentForOffset(view.recording, shell.video.currentTime);
  if (at === null) return;

  const label = shell.media.querySelector('[data-r="videoAt"]');
  if (label) {
    label.textContent = `Synced to +${formatDuration(shell.video.currentTime * 1000)} · ${formatDateTime(at)}`;
  }

  const index = RC.activeEventIndex(view.events, at);
  const next = index < 0 ? 0 : index;
  // Only touch the DOM when the active event actually changes.
  if (!force && next === replayCursor) return;
  replayCursor = next;
  updateReplayView(buildReplayView(currentReplay()));
}

function detachReplayVideo() {
  stopVideoSync();
  if (replayShell) replayShell.video = null;
}

/** Free object URLs and timers when the replay shell goes away. */
function releaseReplayShell() {
  stopVideoSync();
  if (replayTimer) { clearInterval(replayTimer); replayTimer = null; }
  replayShell = null;
}

function replayRound(replay) {
  return (state.rounds || []).find((round) =>
    (replay.roundId && round.id === replay.roundId) ||
    (replay.sessionId && round.sessionId === replay.sessionId)
  ) || null;
}

function replayTrades(replay) {
  const round = replayRound(replay);
  const ids = new Set(round?.tradeIds || []);
  return (state.journal || []).filter((trade) =>
    trade.sessionId ? trade.sessionId === replay.sessionId :
      ids.has(trade.id) || (trade.mint === replay.mint && trade.ts >= replay.openedAt && trade.ts <= (replay.closedAt || Date.now()))
  );
}

function replayFrames(replay) {
  return frames.filter((frame) =>
    frame.sessionId ? frame.sessionId === replay.sessionId :
      frame.mint === replay.mint && frame.t >= replay.openedAt && frame.t <= (replay.closedAt || Date.now())
  );
}

/**
 * Render the replay view.
 *
 * The shell is built ONCE per session and thereafter only the parts that
 * actually change are updated. Rebuilding innerHTML on every cursor move —
 * which is what the previous version did — destroyed and recreated the <video>
 * element each time, so the picture flashed, playback restarted, and scrubbing
 * felt like it was fighting the player.
 */
function renderReplay(el) {
  if (!replays.length) {
    // D-26: replays can empty while frame playback runs (wallet reset from
    // the popup). Nulling the shell alone left replayTimer firing
    // buildReplayView(undefined) every 1.1 s — stop playback and release the
    // shell (which clears the timer and the video-sync rAF) first.
    stopReplayPlayback();
    releaseReplayShell();
    el.innerHTML = `
      <div class="card">
        <h3>Session replay</h3>
        <div class="empty" style="padding:52px 24px">
          <div style="font-size:34px;line-height:1;margin-bottom:6px">⏱</div>
          <strong style="font-size:15px">No timestamped replay captured yet</strong>
          <span style="font-size:12.5px;max-width:440px;line-height:1.6">
            Your next paper position records every fill and chart frame — and the screen
            recording if you enable it — then plays the whole trade back as one timeline.
          </span>
          <button class="btn" id="replay-settings" style="margin-top:10px">Open settings</button>
        </div>
      </div>`;
    document.getElementById('replay-settings').addEventListener('click', () => {
      document.querySelector('nav button[data-section="settings"]').click();
    });
    return;
  }

  let replay = RP.findReplay(replays, selectedReplayId || '');
  if (!replay) replay = replays[0];
  selectedReplayId = replay.sessionId;

  const view = buildReplayView(replay);
  // Reuse the existing DOM whenever we are still on the same session, so the
  // video element survives and keeps playing — but the shell identity also
  // covers the round OUTCOME and the session count (DEFECT D-12): a round
  // closing while the user watches must rebuild the hero (it showed OPEN
  // forever), and a new session must appear in the list. The video only
  // restarts on those semantic changes, never on cursor moves.
  const shellKey = `${replay.sessionId}·${replay.status}·${replay.roundId || ''}·${replays.length}`;
  if (!replayShell || replayShell.root.parentNode !== el || replayShell.key !== shellKey) {
    mountReplayShell(el, replay, view);
    if (replayShell) replayShell.key = shellKey;
  }
  updateReplayView(view);
}

/**
 * D-40: the scrub path calls buildReplayView twice per input event and the
 * video-sync rAF calls it once per frame — and every call re-filtered the
 * whole journal and re-sorted every frame. The built view is memoized per
 * (replay identity, sessionId, cursor) and invalidated whenever the data
 * underneath it changes: loadAll()/loadRecordings() (fresh journal, frames,
 * replays, recordings), mutateState() (fresh state adopted), and reset. The
 * replay OBJECT identity is part of the key, so a reloaded replay list can
 * never serve a stale view even for an unchanged sessionId/cursor.
 */
let replayViewCache = null; // { replayRef, sessionId, cursor, view }

function invalidateReplayView() { replayViewCache = null; }

/** Everything the replay needs for the current cursor position. */
function buildReplayView(replay) {
  // D-26: a missing replay (list emptied mid-playback) degrades to an empty
  // view instead of a TypeError — callers stop or render the empty state.
  // The degraded view is a cheap literal and is never cached (D-40).
  if (!replay) {
    return { replay: null, round: null, events: [], event: null, at: 0, relatedFrame: null, recording: null };
  }
  if (replayViewCache
      && replayViewCache.replayRef === replay
      && replayViewCache.sessionId === replay.sessionId
      && replayViewCache.cursor === replayCursor) {
    return replayViewCache.view;
  }
  const round = replayRound(replay);
  const trades = replayTrades(replay);
  const frames = replayFrames(replay);
  const events = RP.buildReplayEvents(replay, trades, frames);
  replayCursor = Math.max(0, Math.min(replayCursor, Math.max(0, events.length - 1)));
  const event = events[replayCursor] || null;
  const at = event ? Number(event.at) : Number(replay.openedAt);
  const framesSoFar = frames
    .filter((frame) => Number(frame.t) <= at)
    .sort((a, b) => Number(b.t) - Number(a.t));
  const view = {
    replay,
    round,
    events,
    event,
    at,
    // Never leak a future chart into an earlier replay moment.
    relatedFrame: event?.frame || framesSoFar[0] || null,
    recording: replayRecording(replay),
  };
  // The cursor is stored POST-clamp, so a hit always compares real indices.
  replayViewCache = { replayRef: replay, sessionId: replay.sessionId, cursor: replayCursor, view };
  return view;
}

/** Build the replay DOM once for a session and wire its permanent handlers. */
function mountReplayShell(el, replay, view) {
  releaseReplayShell();

  const heroPnl = view.round?.pnlSol ?? replay.result?.pnlSol;
  const hasHeroResult = heroPnl !== null && heroPnl !== undefined;

  el.innerHTML = `
    <div class="replay-layout">
      <div class="card replay-list-card">
        <h3>Timestamped sessions</h3>
        <div class="replay-session-list" data-r="sessions"></div>
      </div>
      <div class="replay-main">
        <div class="card replay-hero">
          <div>
            <h2>${esc(replay.symbol || E.short(replay.mint))} moment replay</h2>
            <div class="dim">${formatDateTime(replay.openedAt)} → ${replay.closedAt ? formatDateTime(replay.closedAt) : 'open now'} · ${esc(replay.mint)}</div>
          </div>
          <div class="replay-result ${hasHeroResult ? (Number(heroPnl) >= 0 ? 'green' : 'red') : 'dim'}">
            ${hasHeroResult ? `${Number(heroPnl) >= 0 ? '+' : ''}${fmt(heroPnl, 4)} SOL` : esc(replay.status.toUpperCase())}
          </div>
        </div>
        <div data-r="media"></div>
        <div class="card replay-controls">
          <div class="replay-now">
            <strong data-r="nowLabel"></strong>
            <span data-r="nowTime"></span>
          </div>
          <input data-r="scrubber" type="range" min="0" max="0" value="0" aria-label="Replay position">
          <div class="replay-actions">
            <button class="btn-sec" data-r="prev">←</button>
            <button class="btn" data-r="play" style="min-width:104px">▶ Play</button>
            <button class="btn-sec" data-r="next">→</button>
            <span class="dim" data-r="counter"></span>
          </div>
          <div class="replay-ticks" data-r="ticks"></div>
        </div>
        <div class="card"><h3>Session tape</h3><div class="tape" data-r="tape"></div></div>
        <div data-r="errors"></div>
      </div>
    </div>`;

  const q = (name) => el.querySelector(`[data-r="${name}"]`);
  replayShell = {
    root: el.firstElementChild,
    sessionId: replay.sessionId,
    el,
    sessions: q('sessions'),
    media: q('media'),
    nowLabel: q('nowLabel'),
    nowTime: q('nowTime'),
    scrubber: q('scrubber'),
    prev: q('prev'),
    play: q('play'),
    next: q('next'),
    counter: q('counter'),
    ticks: q('ticks'),
    tape: q('tape'),
    errors: q('errors'),
    tapeRows: [],
    tickEls: [],
    video: null,
    mediaKey: '',
    lastCursor: -1,
  };

  // Session list: static for the lifetime of the shell.
  replayShell.sessions.innerHTML = replays.map((item) => {
    const itemRound = replayRound(item);
    const result = itemRound || item.result || {};
    const hasResult = result.pnlSol !== null && result.pnlSol !== undefined;
    return `
      <button class="replay-session ${item.sessionId === replay.sessionId ? 'active' : ''}" data-session="${esc(item.sessionId)}">
        <span><strong>${esc(item.symbol || E.short(item.mint))}</strong><small>${formatDateTime(item.openedAt)} · ${esc(item.site || 'unknown')}</small></span>
        <span class="${hasResult ? (Number(result.pnlSol) >= 0 ? 'green' : 'red') : 'dim'}">${hasResult ? `${Number(result.pnlSol) >= 0 ? '+' : ''}${fmt(result.pnlSol, 3)} SOL` : (item.status === 'open' ? 'OPEN' : '—')}</span>
      </button>`;
  }).join('');

  replayShell.sessions.querySelectorAll('.replay-session').forEach((button) => {
    button.addEventListener('click', () => {
      stopReplayPlayback();
      selectedReplayId = button.dataset.session;
      replayCursor = 0;
      renderReplay(el);
    });
  });

  replayShell.scrubber.addEventListener('input', () => {
    seekReplay(Number(replayShell.scrubber.value), { fromUser: true });
  });
  replayShell.prev.addEventListener('click', () => seekReplay(replayCursor - 1, { fromUser: true }));
  replayShell.next.addEventListener('click', () => seekReplay(replayCursor + 1, { fromUser: true }));
  replayShell.play.addEventListener('click', toggleReplayPlayback);
}

/** Update only what changed for the current cursor. */
function updateReplayView(view) {
  if (!replayShell) return;
  const { events, event, replay } = view;
  const shell = replayShell;

  syncReplayMedia(view);

  shell.nowLabel.innerHTML = `${eventIcon(event)} ${esc(event ? eventLabel(event) : 'No captured events')}`;
  shell.nowTime.textContent = event
    ? `+${formatDuration(Math.max(0, event.at - replay.openedAt))} · ${formatDateTime(event.at)}`
    : '';
  shell.counter.textContent = `${events.length ? replayCursor + 1 : 0} / ${events.length}`;

  const max = Math.max(0, events.length - 1);
  if (Number(shell.scrubber.max) !== max) shell.scrubber.max = String(max);
  shell.scrubber.disabled = events.length < 2;
  if (Number(shell.scrubber.value) !== replayCursor) shell.scrubber.value = String(replayCursor);
  shell.prev.disabled = replayCursor <= 0;
  shell.next.disabled = replayCursor >= events.length - 1;
  shell.play.disabled = events.length < 2;
  shell.play.textContent = replayPlaying() ? '❚❚ Pause' : '▶ Play';

  syncTicks(events);
  syncTape(view);

  // Heavier context panels only rebuild when the moment actually changes.
  if (shell.lastCursor !== replayCursor) {
    shell.errors.innerHTML = (replay.errors || []).length
      ? `<div class="card replay-errors"><h3>Capture warnings</h3>${replay.errors.map((error) => `<p><strong>${formatDateTime(error.at)}</strong> ${esc(error.message)}</p>`).join('')}</div>`
      : '';
    shell.lastCursor = replayCursor;
  }
}

/** Timeline ticks are created once, then only their active class changes. */
function syncTicks(events) {
  const shell = replayShell;
  if (shell.tickEls.length !== events.length) {
    shell.ticks.innerHTML = events.map((item, index) =>
      `<button class="replay-tick ${esc(item.source)}" data-index="${index}" title="${esc(eventLabel(item))}" aria-label="${esc(eventLabel(item))}"></button>`
    ).join('');
    shell.tickEls = [...shell.ticks.children];
    shell.tickEls.forEach((node, index) => {
      node.addEventListener('click', () => seekReplay(index, { fromUser: true }));
    });
  }
  shell.tickEls.forEach((node, index) => {
    node.classList.toggle('active', index === replayCursor);
  });
}

/** Session tape rows are created once; only the highlight moves. */
function syncTape(view) {
  const shell = replayShell;
  const { events, replay } = view;

  if (shell.tapeRows.length !== events.length) {
    shell.tape.innerHTML = events.map((item, index) => {
      const offset = Math.max(0, item.at - replay.openedAt);
      const detail = item.trade
        ? `${fmt(item.trade.solGross, 3)} SOL @ ${fillLevel(item.trade)}${
            item.trade.pnlSol !== undefined && item.trade.pnlSol !== null
              ? ` · <span class="${item.trade.pnlSol >= 0 ? 'green' : 'red'}">${item.trade.pnlSol >= 0 ? '+' : ''}${fmt(item.trade.pnlSol, 3)} SOL</span>` : ''}`
        : item.frame ? 'chart frame captured'
        : 'context snapshot';
      return `
        <button class="tape-row" data-index="${index}">
          <span class="tape-time mono">+${formatDuration(offset)}</span>
          <span class="tape-icon">${eventIcon(item)}</span>
          <span class="tape-label">${esc(eventLabel(item))}</span>
          <span class="tape-detail dim mono">${detail}</span>
        </button>`;
    }).join('');
    shell.tapeRows = [...shell.tape.children];
    shell.tapeRows.forEach((node, index) => {
      node.addEventListener('click', () => seekReplay(index, { fromUser: true }));
    });
  }

  shell.tapeRows.forEach((node, index) => {
    const active = index === replayCursor;
    if (node.classList.contains('active') !== active) {
      node.classList.toggle('active', active);
      // Keep the current row in view without yanking the whole page.
      if (active) node.scrollIntoView({ block: 'nearest' });
    }
  });
}

/**
 * Mount the video (or frame) once per media source.
 *
 * The <video> element is only replaced when the underlying source changes, so
 * moving through the timeline never interrupts playback.
 */
function syncReplayMedia(view) {
  const shell = replayShell;
  const { recording, relatedFrame, replay } = view;
  const useVideo = Boolean(recording) && !(preferFrameOverVideo && relatedFrame);
  const key = useVideo ? `video:${recording.id}` : relatedFrame ? `frame:${relatedFrame.t}` : 'none';

  if (shell.mediaKey !== key) {
    detachReplayVideo();
    shell.mediaKey = key;

    if (useVideo) {
      shell.media.innerHTML = `
        <div class="card replay-video">
          <h3>Screen recording
            ${relatedFrame ? '<span class="replay-source-tabs" style="margin-left:auto"><button class="active" data-media="video">Video</button><button data-media="frame">Frame</button></span>' : ''}
          </h3>
          <video data-r="video" src="${esc(recordingUrl(recording))}" controls preload="metadata" playsinline></video>
          <div class="replay-video-meta">
            <span data-r="videoAt"></span>
            <span>${esc(recording.file || '')} · ${(Number(recording.size) / 1048576).toFixed(1)} MB</span>
          </div>
        </div>`;
      attachReplayVideo(view);
    } else if (relatedFrame) {
      shell.media.innerHTML = `
        <div class="card replay-frame">
          <h3>Chart at this moment${recording ? '<span class="replay-source-tabs" style="margin-left:auto"><button data-media="video">Video</button><button class="active" data-media="frame">Frame</button></span>' : ''}</h3>
          <img src="${esc(relatedFrame.dataUrl)}" alt="PaperTrench chart frame at ${formatDateTime(relatedFrame.t)}">
          <div class="dim">${formatDateTime(relatedFrame.t)} · ${esc(relatedFrame.kind || 'frame')}</div>
        </div>`;
    } else {
      shell.media.innerHTML = '';
    }

    shell.media.querySelectorAll('.replay-source-tabs button').forEach((button) => {
      button.addEventListener('click', () => {
        preferFrameOverVideo = button.dataset.media === 'frame';
        renderReplay(shell.el);
      });
    });
  } else if (!useVideo && relatedFrame) {
    // Same frame source, nothing to do.
  }

  const label = shell.media.querySelector('[data-r="videoAt"]');
  if (label && shell.video) {
    const offset = RC.offsetForMoment(recording, view.at);
    label.textContent = offset === null
      ? 'This moment falls outside the recorded window'
      : `Synced to +${formatDuration(offset * 1000)} · ${formatDateTime(view.at)}`;
  }
  void replay;
}

/* D-46: renderMomentMedia (superseded by syncReplayMedia) deleted — it was
 * dead code with zero call sites, and dead render paths drift from the live
 * ones until a future edit resurrects the wrong copy. */

/** The stored recording for a replay's round, if one was captured. */
function replayRecording(replay) {
  const round = replayRound(replay);
  const id = (round && round.id) || replay.roundId;
  if (!id) return null;
  return recordings[id] || null;
}

/** Object URLs are created once per recording and revoked on reload. */
function recordingUrl(recording) {
  if (!recording || !recording.blob) return '';
  if (!recordingUrls[recording.id]) {
    recordingUrls[recording.id] = URL.createObjectURL(recording.blob);
  }
  return recordingUrls[recording.id];
}

/* D-46: renderReplayTape (superseded by syncTape) deleted — same reason as
 * renderMomentMedia above. */

/** A glyph per event type so the timeline reads at a glance. */
function eventIcon(event) {
  if (!event) return '';
  if (event.trade) return event.trade.side === 'buy'
    ? '<span class="green" style="font-size:12px">▲</span>'
    : '<span class="red" style="font-size:12px">▼</span>';
  if (event.frame) return '<span class="dim" style="font-size:12px">▣</span>';
  return '<span class="amber" style="font-size:12px">◆</span>';
}

function eventLabel(event) {
  if (!event) return 'Moment';
  if (event.source === 'papertrench' && event.trade) {
    return `${event.trade.side === 'buy' ? 'Paper buy' : 'Paper sell'} · ${fmt(event.trade.solGross, 3)} SOL @ ${fillLevel(event.trade)}`;
  }
  if (event.frame) return `Chart frame · ${event.frame.kind || 'interval'}`;
  return `Moment · ${event.kind}`;
}



/* ---------- shareable P&L card ---------- */

let cardMedia = null;      // the user's chosen background image/GIF
let cardMediaUrl = null;   // its object URL, revoked when replaced (D-44)
let cardModelCurrent = null;
let cardSourceCurrent = null;  // engine-derived numbers the model is rebuilt from
let cardPrefs = null;          // working copy of settings.cardPrefs while the modal is open
let cardUploads = [];          // gallery records ({id, name, blob, addedAt}) from IndexedDB

/* Customize checkboxes ↔ cardPrefs keys. An absent key means SHOWN. The
 * branding (PAPER watermark + brand bar) deliberately has no entry here and
 * no pref anywhere — pnlcard.js draws it unconditionally, last. */
const CARD_FLAG_INPUTS = [
  ['card-flag-symbol', 'showSymbol'],
  ['card-flag-invested', 'showInvested'],
  ['card-flag-returned', 'showReturned'],
  ['card-flag-percent', 'showPercent'],
  ['card-flag-usd', 'showUsd'],
  ['card-flag-date', 'showDate'],
  ['card-flag-after', 'showAfter'],
  ['card-flag-trench', 'showTrench'],
];

let cardTrenchCurrent = null;  // PTGamify-derived rank/grade/badges for the open card

/**
 * Rank, badges and (for a closed round) the process grade for the card being
 * composed — computed by PTGamify from the same state every surface reads,
 * then passed into cardModel so the overlay composer and this one can never
 * disagree (the one-derivation doctrine, extended to derived display).
 */
function trenchCardOpts(round) {
  const G = window.PTGamify;
  if (!G) return null;
  const grade = round ? G.roundGrade(state, round) : null;
  const r = G.rank(state);
  const earned = G.badges(state).filter((b) => b.earned).slice(0, 4).map((b) => b.label);
  if (!grade && !r && !earned.length) return null;
  return {
    gradeLetter: grade ? grade.letter : null,
    luckyWin: Boolean(grade && grade.luckyWin),
    rankName: r ? r.name : null,
    badges: earned,
  };
}

/* ---- background gallery store (IndexedDB) ----
 *
 * User-uploaded card backgrounds persist in 'pt-cardmedia' / 'backgrounds' as
 * {id, name, blob, addedAt}. chrome.storage cannot hold image blobs;
 * IndexedDB stores them natively (same reasoning as recordings.js).
 * Admission is PC.admitUpload — pure, tested: 2 MB per image, 10 stored, and
 * a FULL gallery REFUSES the new image with a visible reason. Nothing is
 * silently evicted; the user decides what goes. */
const CARD_DB_NAME = 'pt-cardmedia';
const CARD_DB_STORE = 'backgrounds';

function cardDbOpen() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB unavailable')); return; }
    let settled = false;
    const finish = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value); } };
    // Bounded open, like recordings.js: a stalled IndexedDB must degrade to
    // "no gallery", never hang the composer.
    const timer = setTimeout(() => finish(reject, new Error('IndexedDB open timed out')), 5000);
    let request;
    try {
      request = indexedDB.open(CARD_DB_NAME, 1);
    } catch (err) {
      finish(reject, err instanceof Error ? err : new Error('IndexedDB open failed'));
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CARD_DB_STORE)) {
        db.createObjectStore(CARD_DB_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => finish(resolve, request.result);
    request.onerror = () => finish(reject, request.error || new Error('IndexedDB open failed'));
    request.onblocked = () => finish(reject, new Error('IndexedDB open blocked by another tab'));
  });
}

function cardDbRequest(db, mode, run) {
  return new Promise((resolve, reject) => {
    const request = run(db.transaction(CARD_DB_STORE, mode).objectStore(CARD_DB_STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

async function cardBgList() {
  const db = await cardDbOpen();
  try {
    const entries = await cardDbRequest(db, 'readonly', (store) => store.getAll());
    return (entries || []).sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
  } finally {
    try { db.close(); } catch (_) {}
  }
}

async function cardBgAdd(file) {
  // Admission is re-checked here, not only at the drop site, so no future
  // call path can slip past the 2 MB / 10-image doctrine.
  const verdict = PC.admitUpload(file, cardUploads.length);
  if (!verdict.ok) return { ok: false, reason: verdict.reason, record: null };
  const record = {
    id: 'bg' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    name: String(file.name || 'background'),
    blob: file,
    addedAt: Date.now(),
  };
  const db = await cardDbOpen();
  try {
    await cardDbRequest(db, 'readwrite', (store) => store.put(record));
    return { ok: true, reason: '', record };
  } finally {
    try { db.close(); } catch (_) {}
  }
}

async function cardBgRemove(id) {
  const db = await cardDbOpen();
  try {
    await cardDbRequest(db, 'readwrite', (store) => store.delete(String(id)));
  } finally {
    try { db.close(); } catch (_) {}
  }
}

/**
 * Open the share composer for one closed round.
 *
 * The card is drawn from the round the engine actually recorded, so the numbers
 * on a shared image are the same ones the journal holds — there is no separate
 * "display" figure that could drift from the real result.
 */
/**
 * Share an OPEN position — the "still holding" card. Every number is the
 * live mark the dashboard already shows: value = qty x last RECORDED price,
 * unrealized P&L from the engine, USD only where fills genuinely carried it.
 * The card states OPEN and its middle column reads POSITION, not RETURNED.
 */
function openShareCardForPosition(mint) {
  const pos = (state.positions || {})[mint];
  if (!pos) return;
  // The derivation lives in pnlcard.js (PC.positionCardSource) and is shared
  // with the overlay's in-page composer — same numbers wherever the card is
  // opened. Only the engine-derived P&L figures are computed here.
  cardSourceCurrent = PC.positionCardSource(pos, state.journal, {
    pnlSol: E.unrealizedPnl(pos),
    pnlPct: E.positionPnlPct(pos),
    avgBuyNative: (E.averageFillPrices(state, mint) || {}).avgBuyNative,
  }, Date.now());
  if (!cardSourceCurrent) return;
  cardTrenchCurrent = trenchCardOpts(null); // open position: rank/badges, no grade yet
  cardPrefs = { ...(settings.cardPrefs || {}) };

  cardMedia = null;
  if (cardMediaUrl) { try { URL.revokeObjectURL(cardMediaUrl); } catch (_) {} cardMediaUrl = null; }

  if (!paintShareCard()) return;
  document.getElementById('card-modal').classList.add('open');
  showCardMessage('');
  syncCardCustomize();
  refreshCardGallery();
}

function openShareCard(roundId) {
  const round = (state.rounds || []).find((r) => r.id === roundId);
  if (!round) return;

  // Weighted entry/exit, mcaps and honest USD totals all come from ONE
  // derivation — PC.roundCardSource — shared with the overlay's in-page
  // composer, so the same round cards identically everywhere.
  cardSourceCurrent = PC.roundCardSource(round, state.journal);
  if (!cardSourceCurrent) return;
  cardTrenchCurrent = trenchCardOpts(round);
  // Absent key = everything shown; the working copy is adopted per-modal so
  // half-toggled prefs never leak into settings without a persist.
  cardPrefs = { ...(settings.cardPrefs || {}) };

  cardMedia = null;
  if (cardMediaUrl) { try { URL.revokeObjectURL(cardMediaUrl); } catch (_) {} cardMediaUrl = null; }

  if (!paintShareCard()) return;
  document.getElementById('card-modal').classList.add('open');
  showCardMessage('');
  syncCardCustomize();
  refreshCardGallery();
}

/**
 * Rebuild the model and repaint. The model is re-derived on every paint so a
 * flag/accent/background change re-computes the exact strings — the numbers
 * themselves still come only from the round record.
 */
function paintShareCard() {
  const canvas = document.getElementById('card-canvas');
  if (!canvas || !cardSourceCurrent) return false;
  cardModelCurrent = PC.cardModel(cardSourceCurrent, {
    handle: (settings.leaderboardIdentity || {}).handle || '',
    prefs: cardPrefs || settings.cardPrefs || {},
    trench: cardTrenchCurrent,
  });
  if (!cardModelCurrent) return false;
  PC.drawCard(canvas.getContext('2d'), cardModelCurrent, cardMedia);
  return true;
}

function closeShareCard() {
  document.getElementById('card-modal').classList.remove('open');
}

/** The composer's one honest message line (refusals, copy failures). */
function showCardMessage(text) {
  const line = document.getElementById('card-msg');
  if (!line) return;
  line.textContent = text || '';
  line.style.display = text ? '' : 'none';
}

/**
 * Persist the composer prefs as pt_settings.cardPrefs — ONE key laid over a
 * FRESH read (D-19 discipline), refused while storage is unreadable (D-15).
 * engine.js never learns the key: unknown keys ride through mergeSettings,
 * exactly like onboardingDismissed.
 */
async function persistCardPrefs() {
  if (!cardPrefs || storageReadFailed) return;
  const stored = await store.get(['pt_settings']);
  if (stored === null) return;
  const fresh = E.mergeSettings(stored.pt_settings);
  fresh.cardPrefs = { ...cardPrefs };
  try {
    await store.set({ pt_settings: fresh });
    settings = fresh;
  } catch (_) {
    // Card prefs are cosmetic — a failed save keeps the session copy and
    // costs nothing real.
  }
}

/** Reflect cardPrefs into the customize panel (absent key = checked). */
function syncCardCustomize() {
  const prefs = cardPrefs || {};
  for (const [id, key] of CARD_FLAG_INPUTS) {
    const input = document.getElementById(id);
    if (input) input.checked = prefs[key] !== false;
  }
  const active = PC.ACCENTS[prefs.accent] ? prefs.accent : 'amber';
  document.querySelectorAll('#card-accents .accent-swatch').forEach((swatch) => {
    swatch.classList.toggle('selected', swatch.dataset.accent === active);
  });
}

/** Load a stored blob into an <img> the painter can cover-fit. */
function showUploadOnCard(record) {
  return new Promise((resolve) => {
    let url;
    try {
      url = URL.createObjectURL(record.blob);
    } catch (_) {
      resolve(false);
      return;
    }
    const img = new Image();
    img.onload = () => {
      // Replacing the media orphaned the previous object URL (DEFECT D-44).
      if (cardMediaUrl) { try { URL.revokeObjectURL(cardMediaUrl); } catch (_) {} }
      cardMediaUrl = url;
      cardMedia = img;
      resolve(true);
    };
    // A broken/unsupported file must not wipe the card.
    img.onerror = () => { try { URL.revokeObjectURL(url); } catch (_) {} resolve(false); };
    img.src = url;
  });
}

/** Adopt a gallery selection: a built-in id or 'upload:<id>'. */
async function selectCardBackground(choice) {
  if (!cardPrefs) return;
  if (String(choice).startsWith('upload:')) {
    const record = cardUploads.find((r) => 'upload:' + r.id === choice);
    if (!record || !(await showUploadOnCard(record))) return;
  } else {
    cardMedia = null;
    if (cardMediaUrl) { try { URL.revokeObjectURL(cardMediaUrl); } catch (_) {} cardMediaUrl = null; }
  }
  cardPrefs.background = choice;
  paintShareCard();
  renderCardGallery();
  persistCardPrefs().catch(() => {});
}

/** Load stored uploads, restore a persisted upload selection, render the strip. */
async function refreshCardGallery() {
  try {
    cardUploads = await cardBgList();
  } catch (_) {
    cardUploads = [];
    showCardMessage('The background gallery is unavailable (IndexedDB failed) — drops still work for this card only.');
  }
  const chosen = cardPrefs && cardPrefs.background;
  if (typeof chosen === 'string' && chosen.startsWith('upload:')) {
    const record = cardUploads.find((r) => 'upload:' + r.id === chosen);
    if (record) {
      if (await showUploadOnCard(record)) paintShareCard();
    } else {
      // The stored pick was deleted elsewhere; fall back to the plain card.
      cardPrefs.background = null;
    }
  }
  renderCardGallery();
}

function renderCardGallery() {
  const host = document.getElementById('card-gallery');
  if (!host) return;
  const selected = (cardPrefs && cardPrefs.background) || 'void';
  host.textContent = '';
  for (const bg of PC.BACKGROUNDS) {
    host.appendChild(cardThumb(bg.id, bg.name, null, selected));
  }
  for (const record of cardUploads) {
    host.appendChild(cardThumb('upload:' + record.id, record.name, record, selected));
  }
  host.appendChild(cardUploadTile());
}

/** One gallery tile: a built-in (painted procedurally) or a stored upload. */
function cardThumb(choice, name, record, selected) {
  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'card-thumb' + (choice === selected ? ' selected' : '');
  tile.title = name;
  const canvas = document.createElement('canvas');
  canvas.width = 120;
  canvas.height = 68;
  tile.appendChild(canvas);
  const tctx = canvas.getContext('2d');
  if (record) {
    try {
      // The thumbnail URL lives only until the blob is drawn.
      const url = URL.createObjectURL(record.blob);
      const img = new Image();
      img.onload = () => {
        const box = PC.coverRect(img.naturalWidth, img.naturalHeight, 120, 68);
        tctx.drawImage(img, box.x, box.y, box.width, box.height);
        try { URL.revokeObjectURL(url); } catch (_) {}
      };
      img.onerror = () => { try { URL.revokeObjectURL(url); } catch (_) {} };
      img.src = url;
    } catch (_) { /* an unreadable blob shows an empty tile */ }
    const del = document.createElement('span');
    del.className = 'del';
    del.textContent = '×';
    del.title = 'Delete this background';
    del.addEventListener('click', (event) => {
      event.stopPropagation();
      deleteCardUpload(choice);
    });
    tile.appendChild(del);
  } else if (tctx) {
    PC.paintBackground(tctx, choice, 120, 68);
  }
  tile.addEventListener('click', () => { selectCardBackground(choice); });
  return tile;
}

/** The "Upload image — Max 2 MB · N/10" tile at the end of the strip. */
function cardUploadTile() {
  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'card-thumb card-upload-tile';
  const label = document.createElement('span');
  label.textContent = 'Upload image';
  const sub = document.createElement('small');
  sub.textContent = `Max 2 MB · ${cardUploads.length}/${PC.MAX_UPLOADS}`;
  tile.append(label, sub);
  tile.addEventListener('click', () => {
    const file = document.getElementById('card-file');
    if (file) file.click();
  });
  return tile;
}

async function deleteCardUpload(choice) {
  const id = String(choice).replace(/^upload:/, '');
  try {
    await cardBgRemove(id);
  } catch (_) {
    // The re-render below reflects whatever actually remains stored.
  }
  cardUploads = cardUploads.filter((r) => r.id !== id);
  if (cardPrefs && cardPrefs.background === choice) {
    // The selected background is gone; drop to the plain card, honestly.
    await selectCardBackground('void');
  } else {
    renderCardGallery();
  }
}

/**
 * A dropped/picked file goes THROUGH the gallery: admitted (2 MB / 10 max —
 * refusals get a visible reason, never a silent eviction), persisted to
 * IndexedDB, then selected as the background. If IndexedDB itself fails the
 * image is still used for this one card, so the drop keeps working — it just
 * cannot persist.
 */
async function adoptCardUpload(chosen) {
  if (!chosen) return;
  const verdict = PC.admitUpload(chosen, cardUploads.length);
  if (!verdict.ok) { showCardMessage(verdict.reason); return; }
  showCardMessage('');
  let added = null;
  try {
    added = await cardBgAdd(chosen);
  } catch (_) {
    added = null;
  }
  if (added && added.ok && added.record) {
    cardUploads.push(added.record);
    await selectCardBackground('upload:' + added.record.id);
    return;
  }
  if (added && !added.ok) { showCardMessage(added.reason); return; }
  showCardMessage('Could not save to the gallery — using the image for this card only.');
  if (await showUploadOnCard({ blob: chosen })) paintShareCard();
}

/**
 * Copy the card PNG to the clipboard. The ClipboardItem is created inside
 * the click gesture with a Promise<Blob> payload — awaiting toBlob first
 * would leave the gesture and Chrome would refuse the write. Failures get an
 * honest message pointing at Download, which always works.
 */
function copyCard() {
  const canvas = document.getElementById('card-canvas');
  const button = document.getElementById('card-copy');
  if (!canvas || !cardModelCurrent) return;
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard || !navigator.clipboard.write) {
    showCardMessage('Copying images is not supported in this browser — use Download PNG instead.');
    return;
  }
  const png = new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('PNG encode failed'));
    }, 'image/png');
  });
  navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
    .then(() => {
      showCardMessage('');
      if (button) {
        button.textContent = 'Copied ✓';
        setTimeout(() => { button.textContent = 'Copy'; }, 2000);
      }
    })
    .catch(() => {
      showCardMessage('Copy failed — the browser refused clipboard access. Use Download PNG instead.');
    });
}

/** Wire the composer once, at startup — the modal lives outside the sections. */
function bindShareCard() {
  const modal = document.getElementById('card-modal');
  if (!modal) return;
  const drop = document.getElementById('card-drop');
  const file = document.getElementById('card-file');

  file.addEventListener('change', () => {
    adoptCardUpload(file.files && file.files[0]);
    // Re-picking the same file must fire change again.
    file.value = '';
  });
  drop.addEventListener('dragover', (event) => { event.preventDefault(); drop.classList.add('hot'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('hot'));
  drop.addEventListener('drop', (event) => {
    event.preventDefault();
    drop.classList.remove('hot');
    adoptCardUpload(event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0]);
  });

  document.getElementById('card-close').addEventListener('click', closeShareCard);
  modal.addEventListener('click', (event) => { if (event.target === modal) closeShareCard(); });

  document.getElementById('card-customize').addEventListener('click', () => {
    document.getElementById('card-custom').classList.toggle('hidden');
  });
  for (const [id, key] of CARD_FLAG_INPUTS) {
    const input = document.getElementById(id);
    if (!input) continue;
    input.addEventListener('change', () => {
      if (!cardPrefs) return;
      // Stored as `false` only when hidden — an absent key stays "shown", so
      // settings blobs from before this feature keep meaning "everything on".
      if (input.checked) delete cardPrefs[key];
      else cardPrefs[key] = false;
      paintShareCard();
      persistCardPrefs().catch(() => {});
    });
  }
  document.querySelectorAll('#card-accents .accent-swatch').forEach((swatch) => {
    swatch.addEventListener('click', () => {
      if (!cardPrefs) return;
      cardPrefs.accent = swatch.dataset.accent;
      syncCardCustomize();
      paintShareCard();
      persistCardPrefs().catch(() => {});
    });
  });

  document.getElementById('card-copy').addEventListener('click', copyCard);
  document.getElementById('card-download').addEventListener('click', () => {
    const canvas = document.getElementById('card-canvas');
    if (!canvas || !cardModelCurrent) return;
    const link = document.createElement('a');
    link.download = `papertrench-${cardModelCurrent.symbol}-${cardModelCurrent.multipleText}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  });
}

/* ---------- leaderboard ---------- */

/**
 * Leaderboard.
 *
 * Paper-trading results are trivially forgeable, so this screen is built around
 * evidence rather than self-reported numbers. Every fill is committed to a
 * hash chain at the moment it happens; the panel re-derives the result from
 * that chain and shows the user exactly what a verifier would compute. If the
 * two disagree, stored state has been altered.
 */
/**
 * D-18: the cheap fingerprint chain verification is memoized by. Length plus
 * head hash pins the chain contents (each link commits to its predecessor),
 * and the claim inputs are included because claimMatchesChain depends on
 * them. SHA-256 over the whole chain only re-runs when this key changes.
 */
function lbVerifyKey(chain, stats) {
  const head = chain.length ? String(chain[chain.length - 1].hash || '') : '';
  return [
    chain.length,
    head,
    Number(stats.realizedPnlSol) || 0,
    Number(settings.balanceStartSol) || 0,
  ].join('|');
}

/**
 * The verify panel's markup for the CURRENT cache state, rendered
 * synchronously into the staged section. When the memoized result matches
 * the live chain the resolved verdict is painted directly — no "Checking…"
 * placeholder ever flickers back (D-18) — and a mismatch reads as one
 * coherent sentence instead of the absurd "0 problems found · derived P&L
 * differs by X SOL" (D-03).
 */
function lbVerifyView(chain, stats) {
  if (!chain.length) {
    return {
      cls: 'lb-verify',
      html: '<div class="lb-badge">·</div><div><div class="t">No trades committed yet</div><div class="s">Your first paper fill will start the chain.</div></div>',
      derivedHtml: '<span class="dim">—</span>',
    };
  }
  const cached = lbVerifyCache && lbVerifyCache.key === lbVerifyKey(chain, stats)
    ? lbVerifyCache : null;
  if (!cached) {
    return {
      cls: 'lb-verify',
      html: '<div class="lb-badge">…</div><div><div class="t">Checking your trade chain…</div><div class="s">Re-deriving your result from committed fills.</div></div>',
      derivedHtml: '<span class="dim">…</span>',
    };
  }
  const ok = cached.valid && cached.ok;
  const diffText = `${fmt(cached.diff, 4)} SOL`;
  let detail;
  if (ok) {
    detail = `${chain.length} fills verified · displayed P&L matches the committed history`;
  } else if (!cached.valid && !cached.ok) {
    detail = `${cached.problems} problem${cached.problems === 1 ? '' : 's'} found in the chain, and the P&L it derives differs from the displayed figure by ${diffText}`;
  } else if (!cached.valid) {
    detail = `${cached.problems} problem${cached.problems === 1 ? '' : 's'} found in the chain`;
  } else {
    detail = `every hash verifies, but the displayed realized P&L differs from the chain-derived result by ${diffText}`;
  }
  return {
    cls: 'lb-verify ' + (ok ? 'ok' : 'bad'),
    html: `<div class="lb-badge">${ok ? '✓' : '!'}</div><div><div class="t">${ok ? 'Chain intact' : 'Chain does not match local state'}</div><div class="s">${detail}</div></div>`,
    derivedHtml: `<span class="${cached.derivedPnlSol >= 0 ? 'green' : 'red'}" style="font-weight:750">${cached.derivedPnlSol >= 0 ? '+' : ''}${fmt(cached.derivedPnlSol, 3)} SOL</span>`,
  };
}

function renderLeaderboard(el) {
  const chain = attestChain; // F-14: loaded from the segmented store
  const stats = E.sessionStats(state, settings);
  const identity = settings.leaderboardIdentity || null;
  // Absolute P&L flatters big bankrolls, so every figure is shown alongside
  // the return ON the declared starting balance — the comparable number.
  const roiPct = settings.balanceStartSol > 0
    ? (stats.realizedPnlSol / settings.balanceStartSol) * 100
    : 0;
  const verify = lbVerifyView(chain, stats);

  el.innerHTML = `
    <div class="grid2">
      <div class="card">
        <h3>Verified record</h3>
        <div id="lb-verify" class="${verify.cls}">${verify.html}</div>
        <div class="stat" style="margin-top:14px"><span>Committed fills</span><span style="font-weight:750">${chain.length}</span></div>
        <div class="stat"><span>Claimed realized P&amp;L</span><span class="${stats.realizedPnlSol >= 0 ? 'green' : 'red'}" style="font-weight:750">${stats.realizedPnlSol >= 0 ? '+' : ''}${fmt(stats.realizedPnlSol, 3)} SOL · ${roiPct >= 0 ? '+' : ''}${roiPct.toFixed(1)}% ROI</span></div>
        <div class="stat"><span>Declared starting bankroll</span><span style="font-weight:750">${fmt(settings.balanceStartSol, 2)} SOL</span></div>
        <div class="stat" id="lb-derived"><span>Derived from chain</span>${verify.derivedHtml}</div>
        <h4>Chain head</h4>
        <div class="lb-proof" id="lb-head">${chain.length
          ? esc(chain[chain.length - 1].hash)
          : '<span class="dim">Not started — your first paper fill anchors the chain.</span>'}</div>
      </div>

      <div class="card">
        <h3>Identity</h3>
        ${identity ? `
          <div class="stat"><span>Linked account</span><span style="font-weight:750">@${esc(identity.handle)}
            <span class="lb-x ${identity.verified ? 'verified' : ''}">${identity.verified ? 'verified' : 'not verified yet'}</span></span></div>
          <div class="stat"><span>Linked at</span><span class="dim">${formatDateTime(identity.linkedAt)}</span></div>
          ${identity.verified ? '' : `
          <p class="dim" style="font-size:12px;line-height:1.55;margin:12px 0 0">
            Verification happens on papertrench.com, not here: sign in with X there and
            this chip goes green on its own — the signed-in page hands your handle to
            the extension, which is the one direction that keeps the extension from
            ever phoning a server. The board still goes by the site's word, not this
            chip.
          </p>
          <a class="btn" href="https://papertrench.com/leaderboard.html" target="_blank" rel="noopener"
             style="margin-top:10px;display:inline-block">Sign in on papertrench.com →</a>
          `}
          <p class="dim" style="font-size:12px;line-height:1.55;margin:12px 0 0">
            Ranking is bound to this account, so competing under many identities costs
            a real, publicly visible X account each time.
          </p>
          <button class="btn-sec" id="lb-unlink" style="margin-top:12px">Unlink</button>
        ` : `
          <p class="dim" style="font-size:12.5px;line-height:1.6;margin-top:0">
            Link your X account to appear on the leaderboard. The easy way: sign in with X
            on <a href="https://papertrench.com/leaderboard.html" target="_blank" rel="noopener"
            style="color:var(--orange2)">papertrench.com</a> and this links itself. Or type
            the handle below — stored locally, submitted with your signed chain; a server
            verifies ownership before ranking you either way.
          </p>
          <div class="field">
            <label for="lb-handle">X handle</label>
            <input id="lb-handle" type="text" placeholder="yourhandle" autocomplete="off">
            <small>Without the @. Verification is completed by the leaderboard service.</small>
          </div>
          <button class="btn" id="lb-link">Link account</button>
        `}
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <h3>Standings</h3>
      <div id="lb-standings">
        ${renderStandingsPlaceholder(identity, stats)}
      </div>
    </div>

    <div class="card" style="margin-top:16px">
      <details>
      <summary>How ranking is kept honest</summary>
      <ul style="margin:8px 0 0;padding-left:18px;color:var(--dim);font-size:12.5px;line-height:1.65">
        <li><strong>Ordering is provable.</strong> Each fill commits to the hash of the one before it, so a trade cannot be inserted, removed, or reordered afterwards.</li>
        <li><strong>Entries are pre-committed.</strong> A fill is hashed when it is made, before the outcome is known, so a winning entry cannot be backdated.</li>
        <li><strong>Prices are re-checkable.</strong> Every fill records mint, price and timestamp, so a verifier can re-fetch real price history and reject fills at prices that never existed.</li>
        <li><strong>Identity costs something.</strong> One ranked record per verified X account.</li>
        <li><strong>Bankroll travels with the record.</strong> Your declared starting balance is part of the committed data, so results are compared by return on bankroll — not by absolute SOL, which a bigger deposit would inflate for free.</li>
        <li><strong>Stated plainly:</strong> this is evidence, not proof. Anyone can run modified code locally, so final standings must be recomputed server-side from the chain — never from the number this app displays.</li>
      </ul>
      </details>
    </div>`;
}

function renderStandingsPlaceholder(identity, stats) {
  // Remote standings are never invented here: this card shows YOUR row and
  // the two hand-off paths to the board at papertrench.com. The extension
  // still never phones home — export is a local file, and Site sync only
  // ANSWERS a request the site makes when you click over there.
  const roiPct = settings.balanceStartSol > 0
    ? (stats.realizedPnlSol / settings.balanceStartSol) * 100
    : 0;
  const chain = attestChain;
  return `
    <div class="lb-rank me">
      <span class="pos">—</span>
      <span class="lb-handle">${identity ? '@' + esc(identity.handle) : 'You (unlinked)'}
        <small>${stats.rounds} round trips · ${stats.winRate === null ? '—' : stats.winRate.toFixed(0) + '% win rate'} · ${fmt(settings.balanceStartSol, 2)} SOL bankroll</small></span>
      <span class="${stats.realizedPnlSol >= 0 ? 'green' : 'red'}" style="font-weight:800">
        ${stats.realizedPnlSol >= 0 ? '+' : ''}${fmt(stats.realizedPnlSol, 3)} SOL
        <small style="font-weight:700;opacity:.8">(${roiPct >= 0 ? '+' : ''}${roiPct.toFixed(1)}% ROI)</small>
      </span>
    </div>
    <p class="dim" style="font-size:12px;line-height:1.6;margin:14px 0 0">
      Global standings live at <a href="https://papertrench.com/leaderboard.html" target="_blank" rel="noopener" style="color:var(--orange2)">papertrench.com/leaderboard</a>,
      recomputed server-side from submitted chains — never from a self-reported
      number. The same chain also feeds the weekly Sprint and head-to-head
      duels; there is no second record to keep. ROI is shown next to absolute
      P&amp;L because the starting bankroll is a free choice: +10 SOL on 10 is
      not +10 SOL on 1,000.
    </p>
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:14px">
      <button class="btn-sec" id="lb-export" ${chain.length ? '' : 'disabled'}>Export record (JSON)</button>
      <a class="btn-sec" href="https://papertrench.com/leaderboard.html" target="_blank" rel="noopener" style="text-decoration:none">Leaderboard ↗</a>
      <a class="btn-sec" href="https://papertrench.com/sprint.html" target="_blank" rel="noopener" style="text-decoration:none">Weekly Sprint ↗</a>
      <a class="btn-sec" href="https://papertrench.com/duels.html" target="_blank" rel="noopener" style="text-decoration:none">Duels ↗</a>
    </div>
    <div class="field field-check" style="margin-top:14px"><label><input type="checkbox" id="lb-bridge" ${settings.leaderboardBridge === true ? 'checked' : ''}> Site sync</label><small>Lets papertrench.com read your verified record when you click Sync there — nothing is sent anywhere on its own, and no other site can ask. Off means the site tells you to use the exported file instead.</small></div>`;
}

/** Verify the chain and show the user exactly what a server would compute. */
async function bindLeaderboard(el) {
  const link = el.querySelector('#lb-link');
  if (link) {
    link.addEventListener('click', async () => {
      const input = el.querySelector('#lb-handle');
      const handle = (input.value || '').trim().replace(/^@+/, '');
      if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) {
        input.focus();
        return;
      }
      settings.leaderboardIdentity = { handle, verified: false, linkedAt: Date.now() };
      // A refused save (storage unreadable, D-15) must not reject unhandled.
      try { await saveSettings(); } catch (err) { console.error('PaperTrench: identity save failed', err); }
      renderSection('leaderboard');
    });
  }
  const unlink = el.querySelector('#lb-unlink');
  if (unlink) {
    unlink.addEventListener('click', async () => {
      delete settings.leaderboardIdentity;
      try { await saveSettings(); } catch (err) { console.error('PaperTrench: identity save failed', err); }
      renderSection('leaderboard');
    });
  }

  // Manual hand-off path: the same buildSubmission() payload the site bridge
  // serves, as a local file the user carries to papertrench.com themselves.
  const exportBtn = el.querySelector('#lb-export');
  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      const chain = attestChain; // F-14: loaded from the segmented store
      if (!chain.length) return;
      const payload = AT.buildSubmission({
        chain,
        identity: settings.leaderboardIdentity || null,
        startingBalanceSol: settings.balanceStartSol,
        stats: E.sessionStats(state, settings),
      });
      downloadJson(`papertrench-record-${csvStamp()}.json`, JSON.stringify(payload, null, 2));
    });
  }

  const bridge = el.querySelector('#lb-bridge');
  if (bridge) {
    bridge.addEventListener('change', async () => {
      settings.leaderboardBridge = bridge.checked === true;
      try { await saveSettings(); } catch (err) { console.error('PaperTrench: bridge save failed', err); }
    });
  }

  const chain = attestChain; // F-14: loaded from the segmented store
  if (!chain.length) return;
  const stats = E.sessionStats(state, settings);
  const key = lbVerifyKey(chain, stats);
  // D-18: memoized — the render already painted the resolved verdict for
  // this exact chain, so there is nothing to hash again.
  if (lbVerifyCache && lbVerifyCache.key === key) return;
  // A verify for this same chain is already in flight; it re-renders on
  // landing, so starting another would only burn CPU.
  if (lbVerifyInFlightKey === key) return;
  lbVerifyInFlightKey = key;
  try {
    const result = await AT.verifyChain(chain);
    const match = AT.claimMatchesChain(
      { realizedPnlSol: stats.realizedPnlSol }, chain, settings.balanceStartSol, 1e-6
    );
    lbVerifyCache = {
      key,
      valid: result.valid,
      problems: result.problems.length,
      ok: match.ok,
      diff: match.diff,
      derivedPnlSol: match.replayed.realizedPnlSol,
    };
  } finally {
    lbVerifyInFlightKey = null;
  }
  // D-18: this await can outlive the markup it was bound to (a staged refresh
  // replaced the section, or the user navigated away). Never write into a
  // possibly-detached node — re-render from the cache instead, which paints
  // the resolved verdict synchronously. The rebind's cache hit above stops
  // any recursion.
  if (currentSection === 'leaderboard') renderSection('leaderboard');
}

/* ---------- coach ---------- */

function renderCoach(el) {
  // D-17: #coach-session-out is filled FROM module state (sessionReview), so
  // the answer is part of every staged render — a background refresh can no
  // longer wipe it seconds after it lands.
  const reviewed = (state.rounds || []).filter((r) => r.aiReview);
  const reviewedCount = reviewed.length;
  const summary = buildSummaryForCoach();
  const wins = (state.rounds || []).filter((r) => r.pnlSol > 0).length;
  const losses = (state.rounds || []).filter((r) => r.pnlSol <= 0).length;

  el.innerHTML = `
    <div class="grid2">
      <div class="card">
        <h3>Session-level AI review</h3>
        <p class="dim" style="margin-top:0;font-size:12.5px;line-height:1.55">
          Analyzes every closed round trip together to surface the habits that repeat
          across trades rather than one-off outcomes.
        </p>
        <button class="btn" id="coach-session">Run session review</button>
        <div id="coach-session-out" style="margin-top:14px" class="review${sessionReview && sessionReview.error ? ' error' : ''}">${sessionReview ? esc(sessionReview.text) : ''}</div>
      </div>
      <div class="card">
        <h3>Session stats</h3>
        <div class="stat"><span>Round trips</span><span style="font-weight:750">${state.rounds.length}</span></div>
        <div class="stat"><span>With AI review</span><span style="font-weight:750">${reviewedCount}</span></div>
        <div class="stat"><span>Avg hold time</span><span style="font-weight:750">${avgHold()}m</span></div>
        <div class="stat"><span>Wins / Losses</span><span style="font-weight:750"><span class="green">${wins}</span> / <span class="red">${losses}</span></span></div>
      </div>
    </div>
    ${renderDisciplinePanel()}
    ${renderGraduationPanel()}
    ${renderThesisPanel()}
    ${reviewedCount ? `
      <div class="card" style="margin-top:16px">
        <h3>Latest reviews</h3>
        ${reviewed.slice(0, 3).map((r) => `
          <div style="padding:12px 0;border-bottom:1px solid rgba(255,255,255,.05)">
            <div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:6px">
              <strong>${esc(r.symbol)}</strong>
              <span class="${r.pnlSol >= 0 ? 'green' : 'red'}" style="font-weight:750">${r.pnlSol >= 0 ? '+' : ''}${fmt(r.pnlSol, 3)} SOL</span>
            </div>
            <div class="review ${r.aiReview.ok ? '' : 'error'}" style="font-size:12.5px;color:var(--dim)">${esc(r.aiReview.text)}</div>
          </div>`).join('')}
      </div>` : ''}
    <div class="card" style="margin-top:16px">
      <h3>Captured frames <span class="tag">${frames.length}</span></h3>
      <div class="frames">${frames.slice(-12).reverse().map((f) => `<img src="${esc(f.dataUrl)}" title="${esc(new Date(f.t).toLocaleTimeString() + ' · ' + (f.kind || '') + ' ' + (f.symbol || ''))}" />`).join('')
        || emptyState('No frames captured yet', 'Enable frame capture in Settings to give the coach visual context.')}</div>
    </div>
  `;

}


/** Journaling payoff: which setups you actually trade, and how they do. */

/* Phase 6: the graduation bar — docs/GRADUATION.md evaluated over the user's
 * own journal by mastery.js. The doctrine holds here too: ○ (unknown) means
 * missing evidence and never counts as a pass. */
function gradValue(c) {
  if (c.value === null || c.value === undefined) return '—';
  switch (c.id) {
    case 'sample': return String(c.value) + ' closed';
    case 'expectancy': return (c.value >= 0 ? '+' : '') + Number(c.value).toFixed(3) + ' SOL/round';
    case 'lossSize': return Number(c.value).toFixed(2) + '× win size';
    case 'holdSymmetry': return Number(c.value).toFixed(1) + '× longer';
    case 'revenge': return c.value === 0 ? 'none' : String(c.value) + ' found';
    case 'thesis': return Math.round(c.value * 100) + '%';
    case 'coldStreak': return c.value ? String(c.value) + ' losses' : '—';
    default: return String(c.value);
  }
}

function renderGraduationPanel() {
  const M = window.PTMastery;
  if (!M) return '';
  const g = M.graduation(state);
  const passCount = g.criteria.filter((c) => c.status === 'pass').length;
  const icon = (s) => (s === 'pass'
    ? '<span class="green" style="font-weight:800">✓</span>'
    : s === 'fail'
      ? '<span class="red" style="font-weight:800">✗</span>'
      : '<span class="dim" style="font-weight:800">○</span>');
  return `
    <div class="card" style="margin-top:16px">
      <h3>Graduation bar ${g.overall
        ? '<span class="tag" style="background:rgba(52,211,153,.15);color:var(--green)">CLEARED</span>'
        : `<span class="tag">${passCount}/${g.criteria.length}</span>`}</h3>
      <p class="dim" style="margin-top:0;font-size:12.5px;line-height:1.55">
        The honest "am I ready for real money?" checklist, computed from your own
        journal. Paper failure is definitive; clearing this bar earns a small,
        careful start — not a bankroll. ○ means not enough evidence yet, and
        missing evidence never counts as a pass.
      </p>
      ${g.criteria.map((c) => `
        <div class="stat" title="${esc(c.detail)}">
          <span>${icon(c.status)} ${esc(c.label)}</span>
          <span style="font-weight:750">${esc(gradValue(c))}</span>
        </div>`).join('')}
      <p class="dim" style="font-size:11.5px;margin-bottom:0">The reasoning behind every line: docs/GRADUATION.md in the repo.</p>
    </div>`;
}

/**
 * The two habits that most often separate a learning trader from a consistent
 * one: exiting far below the peak, and oversizing a single trade.
 */
function renderDisciplinePanel() {
  const exits = E.exitStats(state);
  const risk = E.riskProfile(state, settings);
  if (!exits.count) return '';

  const captured = exits.avgCapturedPct;
  const tone = captured === null ? 'dim' : captured >= 60 ? 'green' : captured >= 35 ? 'amber' : 'red';

  return `
    <div class="grid2" style="margin-top:16px">
      <div class="card">
        <h3>Exit discipline</h3>
        <div class="stat">
          <span>Average of peak captured</span>
          <span class="${tone}" style="font-weight:750">${captured === null ? '—' : captured.toFixed(0) + '%'}</span>
        </div>
        <div class="stat">
          <span>Left on the table</span>
          <span class="${exits.leftOnTableSol > 0 ? 'amber' : 'dim'}" style="font-weight:750">${fmt(exits.leftOnTableSol, 3)} SOL</span>
        </div>
        <div class="stat">
          <span>Went green, closed red</span>
          <span class="${exits.roundTripped ? 'red' : 'green'}" style="font-weight:750">${exits.roundTripped}</span>
        </div>
        ${exits.roundTripped ? '<p class="dim" style="margin:10px 0 0;font-size:12px;line-height:1.55">Round-tripping a winner is the costliest habit on this list — the trade was profitable and the exit gave it back.</p>' : ''}
        ${renderAfterAggregate()}
      </div>
      <div class="card">
        <h3>Position sizing</h3>
        <div class="stat"><span>Average size</span><span style="font-weight:750">${risk.avgSizePct === null ? '—' : risk.avgSizePct.toFixed(1) + '%'} <span class="dim">of starting book</span></span></div>
        <div class="stat"><span>Largest single trade</span><span style="font-weight:750">${risk.maxSizePct === null ? '—' : risk.maxSizePct.toFixed(1) + '%'}</span></div>
        <div class="stat"><span>Trades over 25%</span><span class="${risk.oversized ? 'red' : 'green'}" style="font-weight:750">${risk.oversized}</span></div>
        ${risk.oversized ? '<p class="dim" style="margin:10px 0 0;font-size:12px;line-height:1.55">Oversized entries make one bad read expensive enough to end a run. Consistent size is what makes a win rate meaningful.</p>' : ''}
      </div>
    </div>`;
}

/**
 * The After, aggregated: across rounds with an observed post-exit hour, how
 * often did the exit dodge a dump, and what was the median further upside?
 * Median (not mean) so one 40x can't flatter or shame the whole record.
 */
function renderAfterAggregate() {
  const observed = (state.rounds || []).filter((r) => r.afterExit && r.afterExit.samples > 0);
  if (observed.length < 3) return '';
  const ups = observed.map((r) => Number(r.afterExit.maxPct) || 0).sort((a, b) => a - b);
  const medianUp = ups[Math.floor(ups.length / 2)];
  const dodged = observed.filter((r) => Number(r.afterExit.minPct) <= -30).length;
  return `
    <div class="stat" style="margin-top:6px">
      <span>After your exits (1h, observed)</span>
      <span style="font-weight:750">median further upside <span class="${medianUp >= 100 ? 'red' : 'dim'}">+${medianUp.toFixed(0)}%</span></span>
    </div>
    <div class="stat">
      <span>Dumps dodged (−30%+ after you sold)</span>
      <span class="green" style="font-weight:750">${dodged} of ${observed.length}</span>
    </div>`;
}

function renderThesisPanel() {
  const stats = E.thesisStats(state);
  if (!stats.total) return '';

  if (!stats.withThesis) {
    return `
      <div class="card" style="margin-top:16px">
        <h3>Trade theses</h3>
        <div class="empty" style="padding:26px">
          <strong>No theses logged yet</strong>
          <span style="font-size:12px;max-width:460px;line-height:1.6">
            Write why you are taking a trade in the overlay while the position is open.
            Because it is captured before the outcome is known, it can be graded honestly afterwards.
          </span>
        </div>
      </div>`;
  }

  const rows = stats.tags.slice(0, 8).map((tag) => {
    const win = tag.avgPnlSol >= 0;
    return `
      <div class="stat" style="align-items:center">
        <span style="color:var(--text)"><strong>${esc(tag.tag)}</strong>
          <span class="dim" style="font-size:11px"> · ${tag.count} trade${tag.count === 1 ? '' : 's'}</span></span>
        <span style="text-align:right;white-space:nowrap">
          <span class="mono" style="font-size:12px">${tag.winRate.toFixed(0)}% win</span>
          <span class="${win ? 'green' : 'red'}" style="display:block;font-weight:750">
            ${win ? '+' : ''}${fmt(tag.avgPnlSol, 3)} SOL avg
          </span>
        </span>
      </div>`;
  }).join('');

  return `
    <div class="grid2" style="margin-top:16px">
      <div class="card">
        <h3>Setups traded</h3>
        ${rows}
      </div>
      <div class="card">
        <h3>Plan discipline</h3>
        <div class="stat"><span>Rounds with a thesis</span><span style="font-weight:750">${stats.withThesis} / ${stats.total} <span class="dim">(${stats.coverage.toFixed(0)}%)</span></span></div>
        <div class="stat"><span>Exited on plan</span><span class="green" style="font-weight:750">${stats.followedPlan}</span></div>
        <div class="stat"><span>Broke the plan</span><span class="red" style="font-weight:750">${stats.brokePlan}</span></div>
        <div class="stat"><span>Won anyway (luck)</span><span class="amber" style="font-weight:750">${stats.luckyWins}</span></div>
        ${stats.luckyWins ? '<p class="dim" style="margin:10px 0 0;font-size:12px;line-height:1.55">Profitable trades that broke their own plan are counted separately — repeating them is a habit, not an edge.</p>' : ''}
      </div>
    </div>`;
}

function buildSummaryForCoach() {
  const rounds = state.rounds || [];
  if (!rounds.length) return null;
  const wins = rounds.filter((r) => r.pnlSol > 0);
  const losses = rounds.filter((r) => r.pnlSol <= 0);
  const avgWin = wins.length ? wins.reduce((s, r) => s + r.pnlPct, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, r) => s + r.pnlPct, 0) / losses.length : 0;
  const avgHold = rounds.length ? rounds.reduce((s, r) => s + r.heldMs, 0) / rounds.length / 60000 : 0;
  const roundText = rounds.map((r) =>
    `- ${r.symbol}: ${r.pnlSol >= 0 ? '+' : ''}${r.pnlSol.toFixed(4)} SOL (${r.pnlPct.toFixed(1)}%), held ${(r.heldMs / 60000).toFixed(1)}m, peak +${r.peakPnlSol.toFixed(4)}, worst ${r.troughPnlSol.toFixed(4)}`
  ).join('\n');
  return {
    roundText,
    avgHold,
    avgWin,
    avgLoss,
  };
}

function avgHold() {
  const rounds = state.rounds || [];
  if (!rounds.length) return '—';
  return (rounds.reduce((s, r) => s + r.heldMs, 0) / rounds.length / 60000).toFixed(1);
}

/**
 * D-17: every stage of the session review goes through module state, and the
 * coach section is re-rendered FROM that state. The old flow wrote the answer
 * into the live DOM only; the next staged refresh (whose markup still held an
 * empty box) discarded it seconds after it rendered.
 */
function setSessionReview(text, error) {
  sessionReview = { text, error: Boolean(error) };
  if (currentSection === 'coach') renderSection('coach');
}

async function runSessionReview() {
  setSessionReview('Analyzing session…', false);
  const summary = buildSummaryForCoach();
  if (!summary) { setSessionReview('No closed round trips yet.', false); return; }
  const messages = [
    { role: 'system', content: 'You are a Solana memecoin trading coach. Given a set of paper-trade round trips, identify recurring patterns and the #1 bad habit hurting the trader. Suggest one drill or rule to fix the habit. Be concise and specific.' },
    { role: 'user', content: `Here are all my round trips:\n${summary.roundText}\n\nWin avg: ${summary.avgWin.toFixed(1)}%, loss avg: ${summary.avgLoss.toFixed(1)}%, avg hold: ${summary.avgHold.toFixed(1)}m.\n\nWhat is my biggest bad habit, and what is one concrete rule to fix it?` },
  ];
  let resp;
  try {
    resp = await chrome.runtime.sendMessage({ type: 'pt_ai_chat', messages, maxTokens: 1800 });
  } catch (err) {
    // D-21: a service-worker failure used to reject unhandled, leaving the
    // box stuck at "Analyzing session…" forever. Land it in the output.
    setSessionReview('Error: ' + ((err && err.message) ? err.message : String(err)), true);
    return;
  }
  setSessionReview(resp?.reply || ('Error: ' + (resp?.error || 'unknown')), Boolean(resp?.error));
}

/* ---------- Turbo receipts: dashboard card (pure helpers, testable) --------
 *
 * Same house rule as the popup one-liner: the headline number is the
 * background's ROUTING latency — click message received → warm tab told
 * where to go — and it is stated as exactly that, never dressed up as
 * page-ready time. Everything below reads pt_turbo_stats (written only by
 * background.js: route timings from turboNote, per-site long-task
 * aggregates from turboJankNote); computed here, shown here, sent nowhere.
 */
const TURBO_ROUTE_LABELS = [
  ['x:spa', 'X link — warm in-page hop'],
  ['x:already_open', 'X link — already on screen'],
  ['x:warm_reload', 'X link — warm tab reload'],
  ['x:cold_tab', 'X link — cold tab (first open)'],
  ['dest:warm_nav', 'Terminal / viewer — warm navigate'],
  ['dest:already_open', 'Terminal / viewer — already open'],
  ['dest:cold_tab', 'Terminal / viewer — cold tab (first open)'],
];

/** Median of a numeric ring, or null when there are no samples. */
function turboMedian(ring) {
  const sorted = (Array.isArray(ring) ? ring : [])
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
}

/** Route rows with counts and medians; routes never taken are omitted. */
function turboRouteRows(stats) {
  return TURBO_ROUTE_LABELS.map(([key, label]) => {
    const entry = (stats && stats[key]) || null;
    return {
      key,
      label,
      count: (entry && Number(entry.count)) || 0,
      medianMs: turboMedian(entry && entry.ring),
    };
  }).filter((row) => row.count > 0);
}

/**
 * Per-site long-task rows from pageJank. A rate is only computed over at
 * least JANK_MIN_RATE_MS of watched time — a five-second sample would print
 * an absurd per-minute rate with a straight face; until then the site is
 * simply omitted. "Lately" is the last up-to-JANK_RECENT_WINDOWS flush
 * windows (roughly that many minutes actually watched); "earlier" is
 * everything before them — computed from the lifetime totals minus the
 * recent windows, so it still counts windows the bounded ring has already
 * dropped rather than silently forgetting history.
 */
const JANK_MIN_RATE_MS = 30_000;
const JANK_RECENT_WINDOWS = 15;
function jankRows(pageJank) {
  const perMin = (count, ms) => (ms >= JANK_MIN_RATE_MS ? count / (ms / 60_000) : null);
  return Object.keys(pageJank || {}).map((site) => {
    const e = pageJank[site] || {};
    const count = Number(e.count) || 0;
    const blockedMs = Number(e.blockedMs) || 0;
    const sampledMs = Number(e.sampledMs) || 0;
    const ring = Array.isArray(e.ring) ? e.ring : [];
    const recent = ring.slice(-JANK_RECENT_WINDOWS);
    const recentCount = recent.reduce((n, w) => n + ((w && Number(w.c)) || 0), 0);
    const recentMs = recent.reduce((n, w) => n + ((w && Number(w.s)) || 0), 0);
    return {
      site,
      ratePerMin: perMin(count, sampledMs),
      blockedMsPerMin: sampledMs >= JANK_MIN_RATE_MS ? blockedMs / (sampledMs / 60_000) : null,
      recentPerMin: perMin(recentCount, recentMs),
      earlierPerMin: perMin(count - recentCount, sampledMs - recentMs),
      sampledMs,
    };
  })
    .filter((row) => row.ratePerMin !== null)
    .sort((a, b) => b.sampledMs - a.sampledMs);
}

/** The whole receipts card, empty state included. Markup only — no handlers. */
function renderTurboCard() {
  const routes = turboRouteRows(turboStats);
  const jank = jankRows(turboStats && turboStats.pageJank);
  const fmtRate = (v) => (v === null ? '—' : v.toFixed(1));
  const routeRows = routes.map((row) => `
        <div style="display:flex;justify-content:space-between;gap:10px;padding:3px 0;font-size:12px">
          <span>${esc(row.label)}</span>
          <span class="mono dim">${row.count}&times;${row.medianMs === null ? '' : ` &middot; median ${row.medianMs} ms`}</span>
        </div>`).join('');
  const jankLines = jank.map((row) => {
    const beforeAfter = (row.recentPerMin !== null && row.earlierPerMin !== null)
      ? ` <span class="dim">(earlier ${fmtRate(row.earlierPerMin)}/min → lately ${fmtRate(row.recentPerMin)}/min)</span>`
      : '';
    return `
        <div style="padding:3px 0;font-size:12px"><strong>${fmtRate(row.ratePerMin)}</strong> long tasks/min on ${esc(row.site)}${beforeAfter}
          <span class="dim mono" style="font-size:11px">&middot; ${Math.round(row.blockedMsPerMin)} ms blocked/min over ${Math.round(row.sampledMs / 60_000)} min watched</span>
        </div>`;
  }).join('');
  return `
      <div class="card">
        <h3>Turbo receipts</h3>
        <p class="dim" style="margin-top:0;font-size:12px;line-height:1.55">Measured on this machine, stored locally, never sent anywhere. Speed claims get receipts or they do not get made.</p>
        ${routes.length ? routeRows : '<div class="dim" style="font-size:12px;padding:3px 0">No warm opens recorded yet — Instant X links and terminal hops will record here as you use them.</div>'}
        <div class="field" style="margin:10px 0 0"><label></label><small><strong>What the number is:</strong> background routing latency — the time from your click reaching PaperTrench to the warm tab being told where to go. It is NOT page-ready time: the page still draws itself after routing. Median over the last 50 samples per route.</small></div>
        <div class="lab" style="margin-top:16px;font-size:9.5px;font-weight:700;letter-spacing:1.1px;text-transform:uppercase;color:var(--faint)">Main-thread stalls</div>
        ${jank.length ? jankLines : '<div class="dim" style="font-size:12px;padding:3px 0">No pages watched long enough yet — at least 30 seconds of visible time on a trading site is needed before a rate is shown.</div>'}
        <div class="field" style="margin:10px 0 0"><label></label><small><strong>What the number is:</strong> the browser's own "long task" measure — any main-thread task over 50 ms — counted only while the page is visible and flushed at most once a minute. PaperTrench does not claim credit for this number in either direction; "earlier → lately" is your before/after context: change one thing (a PaperTrench toggle, a site setting), trade a while, compare.</small></div>
      </div>`;
}

/* ---------- settings ---------- */

function renderSettings(el) {
  // D-24: a corrupt backup can leave presetsBuy/sellPcts as non-arrays. An
  // unguarded .join() threw mid-render, leaving Settings blank AND unbound —
  // no working form left to repair the corruption with. Fall back to the
  // defaults at render time; nothing is written until the user saves.
  const sellPctsList = Array.isArray(settings.sellPcts) ? settings.sellPcts : DEFAULTS.sellPcts;
  const presetsBuyList = Array.isArray(settings.presetsBuy) ? settings.presetsBuy : DEFAULTS.presetsBuy;
  el.innerHTML = `
    <div class="card" style="margin-bottom:16px">
      <h3>Modes</h3>
      <div class="dim" style="font-size:11.5px;margin-bottom:8px">PaperTrench is three tools in one — turn on only what you came for.</div>
      <div class="field field-check"><label><input type="checkbox" id="set-gaming-mode" ${settings.gamingModeEnabled === true ? 'checked' : ''}> Gaming on the charts</label><small>Grade toasts, streak chips and ambient game furniture on the trading sites. The Game tab here in the dashboard is always available either way — and a game you start from it always shows its HUD while it runs.</small></div>
      <div class="dim" style="font-size:11px;margin-top:2px">Paper trading lives in Overlay settings; the speed features (Instant links, warm viewers) live in Turbo — both below.</div>
    </div>
    <div class="grid2">
      <div class="card">
        <h3>Wallet &amp; Trading</h3>
        <div class="field"><label for="set-balance">Starting paper balance (SOL)</label><input id="set-balance" type="number" min="0.1" step="0.1" value="${settings.balanceStartSol}"></div>
        <div class="field"><label for="set-sellpcts">Quick-sell presets (%)</label><input id="set-sellpcts" type="text" value="${esc(sellPctsList.join(', '))}"></div>
      </div>
      <div class="card">
        <h3>Fees &amp; costs</h3>
        <p class="dim" style="margin-top:0;font-size:12px;line-height:1.55">Make paper fills cost what real fills cost. Copy YOUR settings from the site you trade on — on small entries the flat costs below matter more than the percentage.</p>
        <div class="field"><label for="set-fee-preset">Quick fill-in</label>
          <select id="set-fee-preset">
            <option value="">— pick a rough starting point —</option>
            <option value="bot">≈ Axiom/Padre-style bot (1% + 0.001 gas + 0.001 tip)</option>
            <option value="fast">≈ Aggressive sniper (1% + 0.003 gas + 0.005 tip)</option>
            <option value="zero">No costs (pure price practice)</option>
          </select>
          <small>Fills the fields below — they stay yours to edit. Real fees drift; the site's own settings are the truth.</small>
        </div>
        <div class="field"><label for="set-fee">Platform fee per side (bps — 100 = 1%)</label><input id="set-fee" type="number" min="0" step="1" value="${settings.feeBps}"></div>
        <div class="field"><label for="set-gas">Network fee per trade (SOL)</label><input id="set-gas" type="number" min="0" max="0.5" step="0.0001" value="${Number(settings.gasSolPerTx) > 0 ? settings.gasSolPerTx : ''}" placeholder="0"><small>Charged on every buy AND sell, like real gas.</small></div>
        <div class="field"><label for="set-tip">Validator tip per trade (SOL)</label><input id="set-tip" type="number" min="0" max="0.5" step="0.0001" value="${Number(settings.tipSolPerTx) > 0 ? settings.tipSolPerTx : ''}" placeholder="0"><small>Jito-style inclusion tip. Flat, per transaction.</small></div>
        <div class="field"><label for="set-slippage">Slippage (bps — 100 = 1%)</label><input id="set-slippage" type="number" min="0" step="1" value="${settings.slippageBps}"><small>Extra price impact on fills. 0 fills at the live tick.</small></div>
      </div>
      <div class="card">
        <h3>Buying</h3>
        <div class="field"><label for="set-presets">Quick-buy presets (SOL)</label><input id="set-presets" type="text" value="${esc(presetsBuyList.join(', '))}"><small>Comma separated, shown as buttons in the overlay.</small></div>
        <div class="field field-check"><label><input type="checkbox" id="set-instant-buy" ${settings.instantBuyEnabled !== false ? 'checked' : ''}> One-click quick buy</label><small>Tapping a preset amount fires the buy immediately, like Axiom and Padre. Off makes presets only select the amount for the BUY button.</small></div>
        <div class="field field-check"><label><input type="checkbox" id="set-list-quick-buy" ${settings.listQuickBuyEnabled !== false ? 'checked' : ''}> One-tap buy buttons on token lists</label><small>A "P" button on every token row of Axiom Pulse, Padre Trenches and GMGN Trenches — buys the first preset amount without opening the chart.</small></div>
    <div class="field"><label for="set-list-quick-buy-size">Buy-button size on lists <span id="val-list-quick-buy-size">${(settings.listQuickBuySize || 1).toFixed(2)}</span>x</label><input id="set-list-quick-buy-size" type="range" min="0.6" max="1.5" step="0.05" value="${Number(settings.listQuickBuySize || 1).toFixed(2)}"><small>Make the list buy buttons larger or smaller to fit your screen density.</small></div>
    <div class="field"><label for="set-list-quick-buy-placement">Buy-button position on lists</label><select id="set-list-quick-buy-placement"><option value="auto" ${settings.listQuickBuyPlacement !== 'bottom' ? 'selected' : ''}>Auto — next to each row (moves if it covers something)</option><option value="bottom" ${settings.listQuickBuyPlacement === 'bottom' ? 'selected' : ''}>Corner — always bottom-right of the row</option></select><small>Corner pins the P button to the row's bottom-right, clear of the market-cap readout on compact/ultra list formats.</small></div>
        <div class="field field-check"><label><input type="checkbox" id="set-panel-buy" ${settings.panelBuyEnabled !== false ? 'checked' : ''}> Buy section in the trade tab</label><small>Shows the quick-buy presets, custom amount and BUY button in the overlay. Off makes the trade tab view-only.</small></div>
        <div class="field field-check"><label><input type="checkbox" id="set-panel-presets" ${settings.panelPresetsEnabled !== false ? 'checked' : ''}> Quick-buy preset buttons</label><small>The one-tap SOL amount buttons. Off keeps the custom amount and BUY button.</small></div>
      </div>
      <div class="card">
        <h3>Exits — take profit &amp; stop loss</h3>
        <p class="dim" style="margin-top:0;font-size:12px;line-height:1.55">Arm a level on the chart and the position exits itself when the market gets there. Drag the line to place it exactly, the way a terminal does it.</p>
        <div class="field field-check"><label><input type="checkbox" id="set-chart-orders" ${settings.chartOrdersEnabled !== false ? 'checked' : ''}> Take profit / stop loss on the chart</label><small>Adds a TP/SL section to the trade panel and draggable order lines to the chart. Costs nothing until a level is actually armed.</small></div>
        <div class="field"><label for="set-chart-line-thickness">Order-line thickness</label><select id="set-chart-line-thickness"><option value="1" ${(settings.chartOrderLineThickness || 2) === 1 ? 'selected' : ''}>Thin (1px)</option><option value="2" ${(settings.chartOrderLineThickness || 2) === 2 ? 'selected' : ''}>Standard (2px)</option><option value="3" ${(settings.chartOrderLineThickness || 3) === 3 ? 'selected' : ''}>Thick (3px)</option><option value="4" ${(settings.chartOrderLineThickness || 4) === 4 ? 'selected' : ''}>Extra thick (4px)</option></select><small>Width of TP/SL and average-cost lines on the chart. Thicker lines are easier to grab and drag.</small></div>
        <p class="dim" style="font-size:11.5px;line-height:1.6;margin:8px 0 0"><strong>When a level is watched:</strong> while a page feeding that token's price is open. PaperTrench checks armed levels against the prices your own tabs are already receiving — nothing runs in the background, and an armed level says so on the chart.</p>
        <p class="dim" style="font-size:11.5px;line-height:1.6;margin:8px 0 0"><strong>How a paper stop fills:</strong> at the next price this machine actually observed after your level was crossed — never at the level itself. On an illiquid coin a stop can gap well past where you put it, and the journal records both numbers (“stop 180K → filled 154K”). A paper stop that always fills exactly where you placed it would teach an exit quality that does not exist.</p>
      </div>
      <div class="card">
        <h3>AI &amp; Recording</h3>
        <div class="field"><label for="set-endpoint">AI server address</label><input id="set-endpoint" type="text" value="${esc(settings.aiEndpoint)}" placeholder="https://api.openai.com/v1 or http://127.0.0.1:8765/v1"><small>Blank turns the AI coach off. Paste any OpenAI-compatible endpoint; if it runs on localhost or your LAN, also tick the local toggle below, then Save.</small></div>
        <div class="field field-check"><label><input type="checkbox" id="set-ai-allow-local" ${settings.aiAllowLocalEndpoint ? 'checked' : ''}> Allow local/private AI endpoints</label><small>Enable only if you run a self-hosted (localhost, 127.0.0.1, or LAN) AI server. Off blocks requests to private/internal addresses.</small></div>
        <div class="field"><label for="set-model">AI model</label><input id="set-model" type="text" value="${esc(settings.aiModel || '')}" placeholder="endpoint default"><small>Optional override. Blank uses the endpoint's own default.</small></div>
        <div class="field"><label for="set-key">API key</label><input id="set-key" type="password" value="${esc(settings.aiApiKey || '')}" autocomplete="off" placeholder="optional"><small>Only if your AI server needs a key.</small></div>
        <div class="field"><label for="set-rpc">Price connection</label><input id="set-rpc" type="text" value="${esc(settings.rpcUrl || '')}" placeholder="blank = built-in keyless public pool"><small>Blank uses the free public pool — fine for most. If new coins feel slow where you live (public endpoints throttle by region), paste a free personal endpoint: two minutes, no card — <a href="https://github.com/OnlyTerp/papertrench/blob/main/docs/RPC-SPEEDUP.md" target="_blank" rel="noopener" style="color:var(--orange2)">the 2-minute guide</a>. Your endpoint stays on this machine and is only ever used to read prices.</small></div>
        <div class="field field-check"><label><input type="checkbox" id="set-rec" ${settings.recordingEnabled ? 'checked' : ''}> Record screen while a position is open</label><small>Chrome asks for screen permission once per session.</small></div>
        <div class="field field-check"><label><input type="checkbox" id="set-frames" ${settings.framesEnabled ? 'checked' : ''}> Capture key frames on fills</label></div>
        <div class="field field-check"><label><input type="checkbox" id="set-autorev" ${settings.autoReview ? 'checked' : ''}> Auto-run AI review when a round closes</label></div>
      </div>
      <div class="card">
        <h3>Forge — generate the banner inside the dex's own box</h3>
        <p class="dim" style="margin-top:0;font-size:12px;line-height:1.55">When a paid upload box appears on a dex — fund, boost, enhance token info — PaperTrench puts a <strong>Generate</strong> chip on the image slot. It reads what the coin is about, draws the art at the size that box asks for, and drops the file straight into the uploader. Bring your own keys; the calls are yours and so are the bills.</p>
        <div class="field field-check"><label><input type="checkbox" id="set-forge" ${settings.forgeEnabled === true ? 'checked' : ''}> Show the Generate chip on image upload boxes</label><small>Off by default. Nothing is generated, and no key is used, until you click Generate yourself.</small></div>
        <p class="dim" style="font-size:11.5px;line-height:1.6;margin:10px 0 4px"><strong>1 · The narrative AI (optional).</strong> Reads what the coin is actually about and writes the art direction. Grok is the interesting one: with X search on, it looks at the live timeline first, so the art matches the joke people are actually posting. Leave this blank and you just describe the picture yourself.</p>
        <div class="field"><label for="set-forge-brain">Narrative AI</label><select id="set-forge-brain">${forgeOptions(FG.BRAINS, settings.forgeBrainProvider)}</select><small>${esc(forgeBlurb(FG.BRAINS, settings.forgeBrainProvider))}</small></div>
        <div class="field"><label for="set-forge-brain-endpoint">Narrative endpoint</label><input id="set-forge-brain-endpoint" type="text" value="${esc(settings.forgeBrainEndpoint || '')}" placeholder="${esc(forgeEndpointHint(FG.BRAINS, settings.forgeBrainProvider))}"><small>Blank uses that provider's usual address.</small></div>
        <div class="field"><label for="set-forge-brain-model">Narrative model</label><input id="set-forge-brain-model" type="text" value="${esc(settings.forgeBrainModel || '')}" placeholder="${esc(forgeModelHint(FG.BRAINS, settings.forgeBrainProvider))}"><small>Model names change often — the placeholder is a hint, not a promise. Use whatever your account can call.</small></div>
        <div class="field"><label for="set-forge-brain-key">Narrative API key</label><input id="set-forge-brain-key" type="password" value="${esc(settings.forgeBrainKey || '')}" autocomplete="off" placeholder="sk-…"><small>Stored on this machine only, never synced, and only ever sent to the endpoint above.</small></div>
        <div class="field field-check"><label><input type="checkbox" id="set-forge-search" ${settings.forgeSearchX !== false ? 'checked' : ''}> Let Grok search X for the narrative</label><small>Uses xAI's server-side <code>x_search</code> tool on <code>/v1/responses</code> — Grok runs the search itself and answers with citations you can click. Costs more per call. If your key is not entitled to it, PaperTrench retries once without the tool and still returns a brief rather than failing.</small></div>
        <p class="dim" style="font-size:11.5px;line-height:1.6;margin:12px 0 4px"><strong>2 · The image AI (required).</strong> Draws the picture. Anything with an OpenAI-style <code>/images/generations</code> endpoint works as-is; Gemini and Stability have their own adapters. For anything else — Higgsfield, a private model, next month's release — pick <em>Custom</em> and paste the request shape.</p>
        <div class="field"><label for="set-forge-image">Image AI</label><select id="set-forge-image">${forgeOptions(FG.HANDS, settings.forgeImageProvider)}</select><small>${esc(forgeBlurb(FG.HANDS, settings.forgeImageProvider))}</small></div>
        <div class="field"><label for="set-forge-image-endpoint">Image endpoint</label><input id="set-forge-image-endpoint" type="text" value="${esc(settings.forgeImageEndpoint || '')}" placeholder="${esc(forgeEndpointHint(FG.HANDS, settings.forgeImageProvider))}"><small>Required for a custom provider; blank uses the provider's usual address otherwise.</small></div>
        <div class="field"><label for="set-forge-image-model">Image model</label><input id="set-forge-image-model" type="text" value="${esc(settings.forgeImageModel || '')}" placeholder="${esc(forgeModelHint(FG.HANDS, settings.forgeImageProvider))}"></div>
        <div class="field"><label for="set-forge-image-key">Image API key</label><input id="set-forge-image-key" type="password" value="${esc(settings.forgeImageKey || '')}" autocomplete="off" placeholder="sk-…"></div>
        <div class="field"><label for="set-forge-image-headers">Custom: extra headers (JSON)</label><input id="set-forge-image-headers" type="text" value="${esc(settings.forgeImageHeaders || '')}" placeholder='{"x-api-key":"…"}'><small>Only used by the Custom provider. Leave blank to send just <code>Authorization: Bearer &lt;key&gt;</code>.</small></div>
        <div class="field"><label for="set-forge-image-body">Custom: request body template</label><input id="set-forge-image-body" type="text" value="${esc(settings.forgeImageBody || '')}" placeholder='{"prompt":"{{prompt}}","width":{{width}},"height":{{height}}}'><small>JSON with <code>{{prompt}}</code>, <code>{{width}}</code>, <code>{{height}}</code>, <code>{{n}}</code>, <code>{{model}}</code> substituted in.</small></div>
        <div class="field"><label for="set-forge-image-path">Custom: where the image is in the reply</label><input id="set-forge-image-path" type="text" value="${esc(settings.forgeImagePath || '')}" placeholder="data.0.b64_json"><small>A dotted path to a base64 string or an image URL. Blank means PaperTrench guesses from the shapes it already knows.</small></div>
        <div class="field"><label for="set-forge-style">Default style</label><select id="set-forge-style">${FG.STYLES.map((s) => `<option value="${esc(s.id)}" ${settings.forgeStyle === s.id ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</select><small>Changeable per generation from the panel.</small></div>
        <div class="field"><label for="set-forge-variants">Options per click</label><input id="set-forge-variants" type="number" min="1" max="4" step="1" value="${Number(settings.forgeVariants) || 2}"><small>Rendered in parallel, so four is barely slower than one — but it is four times the bill.</small></div>
        <p class="dim" style="font-size:11.5px;line-height:1.6;margin:10px 0 0"><strong>What PaperTrench will not do here:</strong> it never sizes the image from a table of numbers we made up. It reads the required dimensions off the box in front of you and says so on the panel; when a box states nothing, the panel says the size is our preset instead. It never pays for anything, never submits the form, and never touches the site's own DOM — the chip floats over the upload slot rather than being injected into it.</p>
      </div>
      <div class="card">
        <h3>Feedback &amp; alerts</h3>
        <div class="field field-check"><label><input type="checkbox" id="set-effects" ${settings.tradeEffectsEnabled ? 'checked' : ''}> Buy/sell screen effects</label><small>Confetti burst and a brief color flash on each fill.</small></div>
        <div class="field field-check"><label><input type="checkbox" id="set-sounds" ${settings.tradeSoundsEnabled ? 'checked' : ''}> Trade sounds</label><small>Synthesized locally — no audio files, no network calls.</small></div>
        <div class="field field-check"><label><input type="checkbox" id="set-profit-alerts" ${settings.profitAlertsEnabled ? 'checked' : ''}> Profit sound when the tab is hidden</label><small>Rings once per new profit threshold while the tab is in the background.</small></div>
        <div class="field"><label for="set-profit-alert-pct">Profit bell interval (%)</label><input id="set-profit-alert-pct" type="number" min="1" max="1000" step="1" value="${settings.profitAlertPct || 10}"><small>10 rings at +10%, +20%, +30%. Crossed levels never repeat.</small></div>
        <div class="field field-check"><label><input type="checkbox" id="set-mc-alerts" ${settings.mcAlertsEnabled !== false ? 'checked' : ''}> Market cap alerts</label><small>Arm “alert above / alert below” on any token from the panel — including ones you do not hold. Watched from whichever trading tab you have open, so a level still fires while you are looking at a different chart.</small></div>
        <div class="field field-check"><label><input type="checkbox" id="set-mc-alert-desktop" ${settings.mcAlertDesktopEnabled !== false ? 'checked' : ''}> Desktop notification when one fires</label><small>Posted through the trading site's own notification permission, exactly as its built-in alerts are — PaperTrench asks for no notification permission of its own. If a site has notifications blocked, the alert still appears in the panel.</small></div>
        <div class="field field-check"><label><input type="checkbox" id="set-avg-lines" ${settings.averagePriceLinesEnabled ? 'checked' : ''}> Average entry/exit lines on the chart</label><small>Native “Avg. Fill Price” and “Avg. Exit Price” lines from your paper fills.</small></div>
        <div class="field field-check"><label><input type="checkbox" id="set-positions-bar" ${settings.positionsBarEnabled !== false ? 'checked' : ''}> Positions bar</label><small>A top rail on every trading page showing all open paper positions and their live P&amp;L. Click a position to jump to its chart.</small></div>
      </div>
      <div class="card">
        <h3>Guardrails</h3>
        <p class="dim" style="margin-top:0;font-size:12px;line-height:1.55">The three rules every surviving trader eventually adopts — practicable here while the money is fake. Each blocks the buy with an honest message; each is yours to switch off.</p>
        <div class="field field-check"><label><input type="checkbox" id="set-guard-tilt" ${settings.guardTiltEnabled === true ? 'checked' : ''}> Loss-streak cooldown</label><small>After a streak of straight losses, buying pauses for a cooldown. Revenge trades are how small losses become big ones.</small></div>
        <div class="field"><label for="set-guard-tilt-losses">Tilt: losses in a row</label><input id="set-guard-tilt-losses" type="number" min="2" max="10" step="1" value="${Number(settings.guardTiltLosses) || 4}"></div>
        <div class="field"><label for="set-guard-tilt-minutes">Tilt: cooldown minutes</label><input id="set-guard-tilt-minutes" type="number" min="1" max="120" step="1" value="${Number(settings.guardTiltMinutes) || 10}"></div>
        <div class="field"><label for="set-guard-max-pct">Max position size (% of book)</label><input id="set-guard-max-pct" type="number" min="1" max="100" step="1" value="${Number(settings.guardMaxPositionPct) > 0 ? settings.guardMaxPositionPct : ''}" placeholder="blank = off"><small>A single buy larger than this share of your equity is refused.</small></div>
        <div class="field"><label for="set-guard-daily-loss">Daily loss limit (SOL)</label><input id="set-guard-daily-loss" type="number" min="0.01" step="0.01" value="${Number(settings.guardDailyLossSol) > 0 ? settings.guardDailyLossSol : ''}" placeholder="blank = off"><small>Once today's realized paper losses reach this, buying stops until tomorrow.</small></div>
        <div class="field field-check"><label><input type="checkbox" id="set-guard-rug" ${settings.guardRugEnabled !== false ? 'checked' : ''}> Rug guard (on by default)</label><small>Reads holder concentration from chain state; when the top wallets (excluding the pool) control more than the % below, a paper BUY is refused with a 🚩 RUG WARNING naming the number. Sells are never blocked, and a chain read that fails blocks nothing.</small></div>
        <div class="field"><label for="set-guard-rug-pct">Rug guard — block when the top 10 wallets hold over this %</label><input id="set-guard-rug-pct" type="number" min="10" max="90" step="1" value="${Number(settings.guardRugTopPct) || 40}"></div>
        <div class="field field-check"><label><input type="checkbox" id="set-post-exit-watch" ${settings.postExitWatchEnabled !== false ? 'checked' : ''}> The After — track the hour after each exit</label><small>Records what the coin actually did after you sold (observed extremes, on the round). Measured truth instead of FOMO guesswork.</small></div>
      </div>
      <div class="card">
        <h3>Overlay</h3>
        <div class="field field-check"><label><input type="checkbox" id="set-app-enabled" ${settings.appEnabled !== false ? 'checked' : ''}> Enable PaperTrench</label><small>The app-wide master switch. Off means PaperTrench shows up nowhere at all — no overlay, no positions bar, no chart drawings, no instant X links — until you turn it back on. Your wallet, journal, and every other setting are kept.</small></div>
        <div class="field field-check"><label><input type="checkbox" id="set-overlay" ${settings.overlayEnabled !== false ? 'checked' : ''}> Enable overlay</label><small>The trade panel itself. Off hides the panel on all pages (the switch above outranks this one).</small></div>
        <div class="field field-check"><label><input type="checkbox" id="set-overlay-auto-hide" ${settings.overlayHideWhenNoToken !== false ? 'checked' : ''}> Hide overlay when no token is detected</label><small>The panel disappears on home pages and screeners, then pops back when you open a coin.</small></div>
        <div class="field field-check"><label><input type="checkbox" id="set-focus-mode" ${settings.panelFocusMode === true ? 'checked' : ''}> Focus mode — minimal trade panel</label><small>Strips the banner, sparkline, thesis and last-close card from the trade tab — only token, price, balance and buy/sell controls remain. For distraction-free execution.</small></div>
      </div>
      <div class="card">
        <h3>Instant links</h3>
        <div class="field field-check"><label><input type="checkbox" id="set-warm-x" ${settings.warmXLinksEnabled === true ? 'checked' : ''}> Instant X links</label><small>X posts, profiles, communities, and CA searches clicked on a trading site open in a kept-warm viewer tab (~0.5s instead of ~3.5s), with hover prefetch. Keeps one muted background x.com tab while on. Ctrl/Cmd/middle-click always opens normal tabs.</small></div>
        <div class="field field-check"><label><input type="checkbox" id="set-warm-everywhere" ${settings.warmEverywhereEnabled === true ? 'checked' : ''}> Instant terminal links</label><small>The same warm-viewer treatment for pump.fun, Solscan and cross-terminal token links — now the whole matrix: Axiom, Padre, GMGN, Fomo, BullX, Photon, Dexscreener, Birdeye and Jupiter. Close a warm tab and it stays closed until you actually click that destination again.</small></div>
        <div class="field field-check"><label><input type="checkbox" id="set-instant-discord" ${settings.instantDiscordEnabled === true ? 'checked' : ''}> Instant links on Discord</label><small>Registers the link interceptor on discord.com, so token and X links pasted in channels route through the same warm viewers. Uses the two toggles above for what actually routes; only classified links are ever touched — every other click stays native.</small></div>
        <div class="field field-check"><label><input type="checkbox" id="set-instant-telegram" ${settings.instantTelegramEnabled === true ? 'checked' : ''}> Instant links on Telegram Web</label><small>Same treatment on web.telegram.org.</small></div>
        <div class="field field-check"><label><input type="checkbox" id="set-instant-everywhere" ${settings.instantAllSitesEnabled === true ? 'checked' : ''}> Instant links on every site</label><small>The maximal version: the interceptor registers on all https sites (terminals and x.com keep their built-ins). The cost is one small script per page while this is on; the contract is unchanged — a link that is not a token/X link is never touched, and nothing is ever injected with this off.</small></div>
        <div class="field field-check"><label><input type="checkbox" id="set-warm-cards" ${settings.warmHoverCardsEnabled === true ? 'checked' : ''}> Tweet preview card on hover</label><small>Hover an X link and a large readable preview of the post renders right on the page — the card itself is the click target, so no aiming at a 14px icon. Deleted posts say so before you click. Uses X's public oEmbed endpoint (no login, no tracking — see docs/PERMISSIONS.md).</small></div>
        <div class="field field-check"><label><input type="checkbox" id="set-warm-row" ${settings.warmHoverRowEnabled === true ? 'checked' : ''}> Preview from anywhere on the row</label><small>Rest the cursor about a third of a second anywhere on a token row and its X preview appears — no need to find the icon at all. Needs Instant X links on.</small></div>
        <div class="field field-check"><label><input type="checkbox" id="set-warm-buy" ${settings.warmHoverBuyEnabled === true ? 'checked' : ''}> Preview on the terminal's quick-buy button</label><small>Where a terminal hides the launch tweet behind a held hotkey, this puts it on the button your cursor is already on: hover the site's own quick-buy pill and the tweet appears in about a tenth of a second, no key held. The card is placed clear of the pill, never over it, so the buy click it was aiming at still lands. Works where the site's pill is a verified one — Axiom and Padre today. Needs Instant X links on.</small></div>
      </div>
      <div class="card">
        <h3>X-Ray</h3>
        <div class="field field-check"><label><input type="checkbox" id="set-xray" ${settings.xrayEnabled === true ? 'checked' : ''}> X-Ray account intel on x.com</label><small>On any X profile or post, a card appears immediately with account age, follower counts, bio / display-name / @handle changes, contract addresses the account has posted, and Smart Following (its biggest followers). Built from the data the X page itself loads — no third-party service, no account of yours is used to follow anyone, nothing leaves this device.</small></div>
        <div class="field field-check"><label><input type="checkbox" id="set-xray-deep" ${settings.xrayDeepScanEnabled !== false ? 'checked' : ''}> Deep scan (read further back)</label><small>Lets X-Ray ask X for a few more pages of the account's posts and its follower list — the same requests the page makes when you scroll, throttled hard and only while you are looking at that account. Off means X-Ray only uses what the page loads on its own.</small></div>
        <p class="dim" style="font-size:11.5px;line-height:1.6;margin:8px 0 0"><strong>Honest limits:</strong> change history starts the first time this device sees an account — X-Ray cannot know a bio it never saw, and the card always states the date it started watching. CA history and Smart Following come from posts and follower lists actually read, so they are a floor, never a complete record.</p>
      </div>
      ${renderTurboCard()}
    </div>
    <div class="card" style="margin-top:16px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
      <button class="btn" id="save-settings">Save settings</button>
      <span id="save-status" class="dim" style="font-size:12px" role="status"></span>
      <button class="btn-sec" id="test-ai">Test AI endpoint</button>
      <span id="ai-test-result" class="dim" style="font-size:12px"></span>
      <button class="btn-red" id="reset-all" style="margin-left:auto">Reset wallet &amp; history</button>
    </div>
  `;
  // Handlers are attached by rebindSection() once the markup is live in the
  // document; binding here would target the detached staging element.
}

/** Wire the settings form. Called after the section is in the document. */
function bindSettings() {
  document.getElementById('save-settings').addEventListener('click', saveFromForm);
  // Fees & costs quick fill-in: writes the fields, never storage — Save still
  // owns persistence, and the numbers stay the user's to edit.
  const feePreset = document.getElementById('set-fee-preset');
  if (feePreset) {
    feePreset.addEventListener('change', () => {
      const presets = {
        bot: { fee: 100, gas: 0.001, tip: 0.001, slip: 0 },
        fast: { fee: 100, gas: 0.003, tip: 0.005, slip: 50 },
        zero: { fee: 0, gas: 0, tip: 0, slip: 0 },
      };
      const p = presets[feePreset.value];
      if (!p) return;
      document.getElementById('set-fee').value = p.fee;
      document.getElementById('set-gas').value = p.gas || '';
      document.getElementById('set-tip').value = p.tip || '';
      document.getElementById('set-slippage').value = p.slip;
    });
  }
  const sizeSlider = document.getElementById('set-list-quick-buy-size');
  const sizeVal = document.getElementById('val-list-quick-buy-size');
  if (sizeSlider && sizeVal) {
    sizeSlider.addEventListener('input', () => { sizeVal.textContent = Number(sizeSlider.value).toFixed(2); });
  }
  document.getElementById('reset-all').addEventListener('click', async () => {
    if (!confirm('Wipe all paper positions, trades, round trips, screenshots, and session replays?')) return;
    // D-38: honour the starting balance typed into the (possibly unsaved)
    // form — resetting to the stale saved value while the form shows another
    // number makes the fresh wallet and the form disagree. The accepted value
    // is persisted to settings as part of the reset so the reset balance and
    // the saved settings agree.
    const balanceInput = document.getElementById('set-balance');
    const formBalance = balanceInput ? Number(balanceInput.value) : NaN;
    const balanceChanged = Number.isFinite(formBalance) && formBalance >= 0.1
      && formBalance !== Number(settings.balanceStartSol);
    if (balanceChanged) settings = { ...settings, balanceStartSol: formBalance };
    // Inherit the current seq so a still-open trading tab (holding the
    // pre-reset wallet at a higher seq) adopts the reset instead of
    // resurrecting the old state with its next heartbeat write.
    state = E.resetState(settings, state.seq);
    replays = [];
    frames = [];
    stopReplayPlayback();
    invalidateReplayView(); // D-40: the wiped data invalidates any cached view
    // D-51: no extra seq bump here — engine resetState already advanced seq
    // past the inherited base; the engine owns that bump, and doubling it
    // here made the write counter lie about how many writes happened.
    state.updatedAt = Date.now();
    // F-14: an empty meta lands in the SAME write as the wallet wipe, so the
    // chain can never survive a reset the wallet did not. Orphaned segment
    // keys are unreachable once the meta says zero; they are swept after.
    let staleSegKeys = [];
    try {
      const meta = await AT.readChainMeta(async (keys) => {
        const value = await store.get(keys);
        if (value === null) throw new Error('attest store unreadable');
        return value;
      });
      staleSegKeys = AT.chainStorageKeys(meta).filter((key) => key !== AT.CHAIN_META_KEY);
    } catch (_) { /* segments unknown: the meta overwrite below still orphans them */ }
    const write = {
      pt_state: state, pt_frames: [], [RP.STORAGE_KEY]: [],
      [AT.CHAIN_META_KEY]: AT.normalizeChainMeta(null),
    };
    if (balanceChanged) write.pt_settings = settings;
    // The confirm text promises recordings go too — and orphaned videos used
    // to survive every reset, tens of MB forever (DEFECT D-36).
    try { await RC.clear(); } catch (_) {}
    recordings = {};
    try {
      await store.set(write);
    } catch (err) {
      const status = document.getElementById('save-status');
      if (status) status.textContent = 'Reset failed: ' + ((err && err.message) ? err.message : String(err));
      return;
    }
    // Sweep the orphaned segment bodies; harmless if this fails — the empty
    // meta already committed with the wallet wipe.
    if (staleSegKeys.length) {
      try { await new Promise((resolve) => chrome.storage.local.remove(staleSegKeys, () => resolve())); } catch (_) {}
    }
    attestChain = [];
    lbVerifyCache = null;
    chrome.runtime.sendMessage({ type: 'pt_settings_changed' }).catch(() => {});
    renderSidebar();
    renderSection('overview');
  });
  document.getElementById('test-ai').addEventListener('click', async () => {
    const out = document.getElementById('ai-test-result');
    // D-29: a connectivity TEST must not persist anything — the old code
    // committed the entire unsaved form to storage as a side effect. The form
    // values now travel as overrides on the message; the background validates
    // them through the same isAllowedEndpoint gate as saved settings and
    // writes nothing.
    const settingsNow = gatherSettingsFromForm([]);
    if (!settingsNow.aiEndpoint) {
      out.textContent = 'AI coach is off — no endpoint set. Paste one above (and enable the local toggle for localhost/LAN), then Save.';
      return;
    }
    out.textContent = 'Testing…';
    let models;
    try {
      models = await chrome.runtime.sendMessage({
        type: 'pt_ai_models',
        overrides: {
          endpoint: settingsNow.aiEndpoint,
          apiKey: settingsNow.aiApiKey,
          model: settingsNow.aiModel,
          aiAllowLocalEndpoint: settingsNow.aiAllowLocalEndpoint,
        },
      });
    } catch (err) {
      out.textContent = 'Error: ' + ((err && err.message) ? err.message : String(err));
      return;
    }
    if (models?.error) out.textContent = `Error: ${models.error}`;
    else if (models?.models?.length) out.textContent = `OK — ${models.models.length} model(s) found: ${models.models.slice(0, 3).join(', ')}`;
    else out.textContent = 'No models reachable. Check the endpoint URL, that the service is running, and that the local toggle is on for localhost/LAN endpoints.';
  });
}

/**
 * Read the settings form, validating every numeric field.
 *
 * D-10/D-11/D-23/D-42: raw form values used to flow straight into the engine.
 * Negative fee bps MINT free SOL on every fill (engine.js applies feeBps
 * arithmetically), slippage ≥ 10000 collapses every sell quote and throws a
 * misleading "No live price available", sell presets over 100% render buttons
 * that lie, and `Number(v) || 10` silently turned an invalid (or 0) balance
 * into 10. Every coercion or rejection is appended to `notes` so the save
 * status can SAY what happened instead of silently altering the input.
 *
 * D-19: returns ONLY the keys this form controls — it must never spread the
 * module `settings` object in. That object is frozen at dashboard-load time
 * while the Settings tab is open (the tab counts as busy), so spreading it
 * baked every stale value in and Save reverted whatever the content script
 * had written meanwhile: panel position, bar position/hidden, overlay size,
 * auto-hide. The caller lays these keys over a FRESH storage read instead.
 * `base` supplies the saved fallback for a rejected balance.
 */
function gatherSettingsFromForm(notes = [], base = settings) {
  const clampInt = (id, min, max, fallback, label) => {
    const raw = document.getElementById(id).value;
    const n = Math.round(Number(raw));
    if (String(raw).trim() === '' || !Number.isFinite(n)) {
      notes.push(`${label} was not a number — using ${fallback}`);
      return fallback;
    }
    if (n < min) { notes.push(`${label} raised to the minimum ${min}`); return min; }
    if (n > max) { notes.push(`${label} capped at ${max}`); return max; }
    return n;
  };
  // Preset lists: positive, bounded, deduplicated where repeats are
  // meaningless, and capped at 8 (500 presets would mean 500 overlay buttons).
  const numberList = (id, max, label, { dedupe = false } = {}) => {
    const parts = document.getElementById(id).value.split(',').map((s) => s.trim()).filter(Boolean);
    let values = parts.map((s) => parseFloat(s)).filter((n) => Number.isFinite(n) && n > 0 && n <= max);
    if (dedupe) values = [...new Set(values)];
    if (values.length > 8) values = values.slice(0, 8);
    if (values.length !== parts.length) {
      notes.push(`${label}: kept ${values.length} of ${parts.length} entries (each must be > 0 and ≤ ${max}, max 8${dedupe ? ', no repeats' : ''})`);
    }
    return values;
  };

  // D-42/D-06: an invalid balance keeps the SAVED value and says so — it
  // must never silently become 10 (or anything else the user did not type).
  const savedBalance = Number(base.balanceStartSol) >= 0.1
    ? Number(base.balanceStartSol)
    : DEFAULTS.balanceStartSol;
  const balanceRaw = document.getElementById('set-balance').value;
  const balanceNum = Number(balanceRaw);
  let balanceStartSol = savedBalance;
  if (Number.isFinite(balanceNum) && balanceNum >= 0.1) balanceStartSol = balanceNum;
  else notes.push(`starting balance "${balanceRaw}" rejected (must be ≥ 0.1 SOL) — kept ${savedBalance}`);

  const presets = numberList('set-presets', 1000, 'quick-buy presets');
  const sellPcts = numberList('set-sellpcts', 100, 'quick-sell presets', { dedupe: true });
  if (!presets.length) notes.push('quick-buy presets were empty — defaults restored');
  if (!sellPcts.length) notes.push('quick-sell presets were empty — defaults restored');

  return {
    balanceStartSol,
    // D-11: integers 0..1000 only — a negative fee inverts the arithmetic.
    feeBps: clampInt('set-fee', 0, 1000, DEFAULTS.feeBps, 'fee bps'),
    gasSolPerTx: (() => {
      const v = Number(document.getElementById('set-gas').value);
      return Number.isFinite(v) && v > 0 ? Math.min(v, 0.5) : 0;
    })(),
    tipSolPerTx: (() => {
      const v = Number(document.getElementById('set-tip').value);
      return Number.isFinite(v) && v > 0 ? Math.min(v, 0.5) : 0;
    })(),
    // D-23: integers 0..2000 only — ≥ 10000 breaks every sell.
    slippageBps: clampInt('set-slippage', 0, 2000, DEFAULTS.slippageBps, 'slippage bps'),
    presetsBuy: presets.length ? presets : [0.1, 0.5, 1, 2],
    instantBuyEnabled: document.getElementById('set-instant-buy').checked,
    listQuickBuyEnabled: document.getElementById('set-list-quick-buy').checked,
    listQuickBuySize: Math.max(0.6, Math.min(1.5, Number(document.getElementById('set-list-quick-buy-size').value) || 1)),
    listQuickBuyPlacement: document.getElementById('set-list-quick-buy-placement').value === 'bottom' ? 'bottom' : 'auto',
    chartOrderLineThickness: Math.max(1, Math.min(4, Math.round(Number(document.getElementById('set-chart-line-thickness').value) || 2))),
    panelBuyEnabled: document.getElementById('set-panel-buy').checked,
    panelPresetsEnabled: document.getElementById('set-panel-presets').checked,
    sellPcts: sellPcts.length ? sellPcts : [25, 50, 75, 100],
    aiEndpoint: document.getElementById('set-endpoint').value.trim() || DEFAULTS.aiEndpoint,
    aiAllowLocalEndpoint: document.getElementById('set-ai-allow-local').checked,
    rpcUrl: document.getElementById('set-rpc') ? document.getElementById('set-rpc').value.trim() : (settings.rpcUrl || ''),
    // Guardrails + The After. Bounds mirror engine clamps; blank means off.
    guardTiltEnabled: document.getElementById('set-guard-tilt').checked,
    guardTiltLosses: Math.min(10, Math.max(2, Math.round(Number(document.getElementById('set-guard-tilt-losses').value) || 4))),
    guardTiltMinutes: Math.min(120, Math.max(1, Math.round(Number(document.getElementById('set-guard-tilt-minutes').value) || 10))),
    guardMaxPositionPct: (() => {
      const v = Number(document.getElementById('set-guard-max-pct').value);
      return Number.isFinite(v) && v >= 1 && v <= 100 ? v : null;
    })(),
    guardDailyLossSol: (() => {
      const v = Number(document.getElementById('set-guard-daily-loss').value);
      return Number.isFinite(v) && v > 0 ? v : null;
    })(),
    chartOrdersEnabled: document.getElementById('set-chart-orders').checked,
    guardRugEnabled: document.getElementById('set-guard-rug').checked,
    guardRugTopPct: clampInt('set-guard-rug-pct', 10, 90, 40, 'rug guard threshold'),
    postExitWatchEnabled: document.getElementById('set-post-exit-watch').checked,
    aiModel: document.getElementById('set-model').value.trim(),
    aiApiKey: document.getElementById('set-key').value.trim(),
    recordingEnabled: document.getElementById('set-rec').checked,
    framesEnabled: document.getElementById('set-frames').checked,
    autoReview: document.getElementById('set-autorev').checked,
    forgeEnabled: document.getElementById('set-forge').checked,
    forgeBrainProvider: document.getElementById('set-forge-brain').value,
    forgeBrainEndpoint: document.getElementById('set-forge-brain-endpoint').value.trim(),
    forgeBrainModel: document.getElementById('set-forge-brain-model').value.trim(),
    forgeBrainKey: document.getElementById('set-forge-brain-key').value.trim(),
    forgeSearchX: document.getElementById('set-forge-search').checked,
    forgeImageProvider: document.getElementById('set-forge-image').value,
    forgeImageEndpoint: document.getElementById('set-forge-image-endpoint').value.trim(),
    forgeImageModel: document.getElementById('set-forge-image-model').value.trim(),
    forgeImageKey: document.getElementById('set-forge-image-key').value.trim(),
    forgeImageHeaders: document.getElementById('set-forge-image-headers').value.trim(),
    forgeImageBody: document.getElementById('set-forge-image-body').value.trim(),
    forgeImagePath: document.getElementById('set-forge-image-path').value.trim(),
    forgeStyle: document.getElementById('set-forge-style').value,
    forgeVariants: clampInt('set-forge-variants', 1, 4, 2, 'Forge options per click'),
    tradeEffectsEnabled: document.getElementById('set-effects').checked,
    tradeSoundsEnabled: document.getElementById('set-sounds').checked,
    profitAlertsEnabled: document.getElementById('set-profit-alerts').checked,
    profitAlertPct: Math.max(1, Number(document.getElementById('set-profit-alert-pct').value) || 10),
    mcAlertsEnabled: document.getElementById('set-mc-alerts').checked,
    mcAlertDesktopEnabled: document.getElementById('set-mc-alert-desktop').checked,
    averagePriceLinesEnabled: document.getElementById('set-avg-lines').checked,
    positionsBarEnabled: document.getElementById('set-positions-bar').checked,
    appEnabled: document.getElementById('set-app-enabled').checked,
    overlayEnabled: document.getElementById('set-overlay').checked,
    overlayHideWhenNoToken: document.getElementById('set-overlay-auto-hide').checked,
    panelFocusMode: document.getElementById('set-focus-mode').checked,
    gamingModeEnabled: document.getElementById('set-gaming-mode').checked,
    warmXLinksEnabled: document.getElementById('set-warm-x').checked,
    warmEverywhereEnabled: document.getElementById('set-warm-everywhere').checked,
    instantDiscordEnabled: document.getElementById('set-instant-discord').checked,
    instantTelegramEnabled: document.getElementById('set-instant-telegram').checked,
    instantAllSitesEnabled: document.getElementById('set-instant-everywhere').checked,
    warmHoverCardsEnabled: document.getElementById('set-warm-cards').checked,
    warmHoverRowEnabled: document.getElementById('set-warm-row').checked,
    warmHoverBuyEnabled: document.getElementById('set-warm-buy').checked,
    xrayEnabled: document.getElementById('set-xray').checked,
    xrayDeepScanEnabled: document.getElementById('set-xray-deep').checked,
  };
}

let saveStatusTimer = null;

async function saveFromForm() {
  const notes = [];
  // D-47: the save flow reports into its OWN status element — it used to
  // write "Saved." into the AI-test output span and never clear it.
  const status = document.getElementById('save-status');
  const show = (text, isError) => {
    if (!status) return;
    status.textContent = text;
    status.style.color = isError ? 'var(--red)' : '';
    if (saveStatusTimer) { clearTimeout(saveStatusTimer); saveStatusTimer = null; }
    // The plain confirmation clears itself; failures and adjustment reports
    // stay put — the user has to be able to read what was changed.
    if (!isError && !notes.length) {
      saveStatusTimer = setTimeout(() => {
        if (status.textContent === text) status.textContent = '';
      }, 2500);
    }
  };
  // D-19: re-read pt_settings FRESH at save time and lay only the
  // form-controlled keys over that copy. The module `settings` object is
  // frozen at dashboard-load time while this tab is open (the Settings tab
  // counts as busy), so `{...stale, ...form}` silently reverted every
  // content-script settings write made meanwhile — the user's dragged panel
  // and bar positions, overlay size, bar hidden state, auto-hide.
  const stored = await store.get(['pt_settings']);
  if (stored === null) {
    show('Save failed: storage is unreadable — nothing was saved. Reload the dashboard and try again.', true);
    return;
  }
  const freshSettings = E.mergeSettings(stored.pt_settings);
  settings = { ...freshSettings, ...gatherSettingsFromForm(notes, freshSettings) };
  try {
    await saveSettings();
  } catch (err) {
    // D-25: a failed save used to be completely invisible — the "Saved."
    // write happened after the await and nothing caught the rejection.
    show('Save failed: ' + ((err && err.message) ? err.message : String(err)), true);
    return;
  }
  chrome.runtime.sendMessage({ type: 'pt_settings_changed' }).catch(() => {});
  show(notes.length ? 'Saved — adjusted: ' + notes.join(' · ') : 'Saved.', false);
}

/* ---------- helpers ---------- */

function fmt(n, dp = 4) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: dp });
}

/**
 * How a fill is described to a trader.
 *
 * Every fill records the market cap it happened at, and that is the figure
 * traders quote ("in at 240K"). The unit price is only shown when a fill
 * predates market-cap capture.
 */
function fillLevel(trade) {
  if (!trade) return '—';
  const mcap = Number(trade.mcap);
  if (mcap > 0) return PC.formatMarketCap(mcap) + ' MC';
  const price = Number(trade.priceNative);
  // Never render the "— SOL" corpse a missing price used to produce.
  return price > 0 ? PC.formatPrice(price) + ' SOL' : '—';
}

/**
 * D-32: the journal's "Market cap" column must only ever contain a market
 * cap. fillLevel()'s SOL-price fallback is right for prose labels ("bought
 * @ …"), but under a "Market cap" header a unit price reads as a (wildly
 * wrong) market cap — a fill without one renders a plain em-dash instead.
 */
function mcapLevel(trade) {
  const mcap = Number(trade && trade.mcap);
  return mcap > 0 ? PC.formatMarketCap(mcap) + ' MC' : '—';
}

function timeAgo(ts) {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function formatDateTime(ms) {
  const value = Number(ms);
  return Number.isFinite(value) && value > 0 ? new Date(value).toLocaleString() : '—';
}

/**
 * D-49: coach prompts stamp fills in LOCAL time with an explicit UTC-offset
 * suffix (e.g. "2026-08-05 14:03:22 UTC+02:00"). The P&L calendar buckets
 * days in local time; stamping the prompt in UTC ISO meant the coach could
 * put a fill near midnight on a different day than the calendar the user is
 * looking at, and its "day" observations disagreed with the grid.
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

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

// D-16: catch boot failures — a bare init() left the page blank on any throw.
init().catch(renderInitError);
