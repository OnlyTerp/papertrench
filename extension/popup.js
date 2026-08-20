/* PaperTrench — popup script.
 *
 * Self-contained on purpose: the popup only reads storage and formats numbers,
 * so it does not depend on engine.js being loaded first. That removes a whole
 * class of "PaperEngine is undefined" load-order failures.
 */

'use strict';

const DEFAULTS = { appEnabled: true, balanceStartSol: 10, overlayEnabled: true, overlayHideWhenNoToken: true, warmXLinksEnabled: false, warmEverywhereEnabled: false, xrayEnabled: false, xrayDeepScanEnabled: true, presetsBuy: [0.1, 0.5, 1, 2], sellPcts: [25, 50, 75, 100], feeBps: 100, gasSolPerTx: 0, tipSolPerTx: 0, slippageBps: 0 };

// Same rough starting points the dashboard's Fees & costs card offers; the
// full form stays there, this is the one-tap version for mid-session fixes.
const FEE_PRESETS = {
  bot: { feeBps: 100, gasSolPerTx: 0.001, tipSolPerTx: 0.001, slippageBps: 0 },
  fast: { feeBps: 100, gasSolPerTx: 0.003, tipSolPerTx: 0.005, slippageBps: 50 },
  zero: { feeBps: 0, gasSolPerTx: 0, tipSolPerTx: 0, slippageBps: 0 },
};

function $(id) { return document.getElementById(id); }

// F-14: the attestation chain lives in segmented storage (pt_attest_seg_<n>
// + pt_attest_meta), so backup/restore/reset must carry it explicitly. Soft
// binding on purpose — the popup's fail-open principle (see header) means a
// missing attest.js must degrade to wallet-only handling, never a dead popup.
const AT = (typeof window !== 'undefined' && window.PTAttest) || null;

/** Promise-API storage get for the chain helpers. */
function chainGet(keys) { return chrome.storage.local.get(keys); }

$('dash').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('toggle').addEventListener('click', toggleOverlay);
$('reset').addEventListener('click', resetWallet);
$('backup').addEventListener('click', backupWallet);
$('restore').addEventListener('click', () => $('restoreFile').click());
$('restoreFile').addEventListener('change', restoreWallet);
$('overlay-window').addEventListener('click', openStreamOverlay);
$('warmx').addEventListener('click', toggleWarmXLinks);
$('warmdest').addEventListener('click', toggleWarmEverywhere);
$('xray').addEventListener('click', toggleXRay);
$('power').addEventListener('click', togglePower);
$('qs-apply').addEventListener('click', applyQuickSettings);

function fmt(n, dp = 4) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: dp });
}

function freshState(settings) {
  return {
    version: 1,
    seq: 0,
    cashSol: settings.balanceStartSol,
    startedAt: Date.now(),
    positions: {},
    rounds: [],
    journal: [],
    stats: { totalBuys: 0, totalSells: 0, realizedPnlSol: 0, feesPaidSol: 0 },
  };
}

/** jb (ideas): lifetime bought / held / sold SOL from the journal alone,
 * so historical wallets get correct numbers with no migration. Held is the
 * surviving cost basis of open positions (what actually went in and is
 * still at risk), not current mark — matching the dashboard sidebar. */
function journalFlow(journal, positions) {
  let boughtSol = 0;
  let soldSol = 0;
  // solGross = the order size the user placed (what they mean by "bought");
  // fall back to |solNet| for pre-gross legacy rows.
  for (const t of journal || []) {
    if (t.side === 'buy') boughtSol += Math.abs(Number(t.solGross) || Number(t.solNet) || 0);
    else if (t.side === 'sell') soldSol += Math.abs(Number(t.solGross) || Number(t.solNet) || 0);
  }
  let heldSol = 0;
  for (const p of Object.values(positions || {})) {
    heldSol += Number(p.grossOpenCostSol) || 0;
  }
  return { boughtSol, heldSol, soldSol };
}

/** Equity = cash + mark-to-market value of every open position. */
function computeStats(state, settings) {
  const positions = Object.values(state.positions || {});
  const rounds = state.rounds || [];
  const openValue = positions.reduce((s, p) => s + (p.qty || 0) * (p.lastPriceNative || 0), 0);
  const equity = (state.cashSol || 0) + openValue;
  // D-02: realized P&L is the engine's per-sell accumulator, which credits
  // partial exits the moment they happen — the same definition the dashboard
  // sidebar, calendar, journal, and the attest chain replay use. The old
  // rounds-only sum showed +0 here while the calendar showed the banked
  // partial. Legacy states can miss the accumulator; the journal's per-sell
  // pnlSol entries are the same definition and back-fill it.
  let realized = Number((state.stats || {}).realizedPnlSol);
  if (!Number.isFinite(realized)) {
    realized = (state.journal || []).reduce(
      (s, t) => s + (t.side === 'sell' ? (Number(t.pnlSol) || 0) : 0), 0
    );
  }
  const flow = journalFlow(state.journal || [], state.positions || {});
  return {
    equitySol: equity,
    openPositions: positions.length,
    realizedPnlSol: realized,
    rounds: rounds.length,
    equityVsStart: equity - settings.balanceStartSol,
    boughtSol: flow.boughtSol,
    heldSol: flow.heldSol,
    soldSol: flow.soldSol,
  };
}

/* Turbo receipts: measured on THIS machine, stored locally, no telemetry.
 * The number is the background's routing latency (click message → navigation
 * dispatched / viewer revealed) — stated as exactly that, never dressed up as
 * page-ready time. Counts are the headline because they are unambiguous:
 * how many opens took a warm route instead of a cold tab. */
function renderTurboReceipts(stats) {
  const el = $('turbo-receipts');
  if (!el) return;
  const s = stats || {};
  const warmRoutes = ['x:spa', 'x:already_open', 'x:warm_reload', 'dest:warm_nav', 'dest:already_open'];
  const coldRoutes = ['x:cold_tab', 'dest:cold_tab'];
  const count = (keys) => keys.reduce((n, k) => n + ((s[k] && s[k].count) || 0), 0);
  const warm = count(warmRoutes);
  const cold = count(coldRoutes);
  if (!warm && !cold) { el.style.display = 'none'; return; }
  const ring = warmRoutes.flatMap((k) => (s[k] && s[k].ring) || []).sort((a, b) => a - b);
  const median = ring.length ? ring[Math.floor(ring.length / 2)] : null;
  el.style.display = 'block';
  el.textContent = `⚡ Receipts: ${warm} warm open${warm === 1 ? '' : 's'} · ${cold} cold`
    + (median !== null ? ` · median routing ${median}ms` : '');
  el.title = 'Measured on this machine, stored locally, never sent anywhere. '
    + '"Routing" is the time from your click reaching PaperTrench to the warm tab being told where to go — '
    + 'the page itself then hydrates on top of an already-warm session.';
}

async function load() {
  try {
    const stored = await chrome.storage.local.get(['pt_state', 'pt_settings', 'pt_turbo_stats']);
    const settings = { ...DEFAULTS, ...(stored.pt_settings || {}) };
    renderTurboReceipts(stored.pt_turbo_stats);
    const state = stored.pt_state || freshState(settings);
    const stats = computeStats(state, settings);

    const up = stats.equityVsStart >= 0;

    $('equity').innerHTML = `${fmt(stats.equitySol, 2)} <small>SOL</small>`;
    $('equity').className = 'equity ' + (up ? 'green' : 'red');

    const deltaEl = $('delta');
    const pct = settings.balanceStartSol ? (stats.equityVsStart / settings.balanceStartSol) * 100 : 0;
    deltaEl.textContent = `${up ? '▲' : '▼'} ${up ? '+' : ''}${fmt(stats.equityVsStart, 3)} SOL (${up ? '+' : ''}${pct.toFixed(1)}%)`;
    deltaEl.className = 'delta ' + (up ? 'green' : 'red');

    // jb (ideas): lifetime bought / held / sold, journal-derived.
    const flowEl = $('flow');
    if (flowEl) {
      flowEl.textContent = `In ${fmt(stats.boughtSol, 2)} · holding ${fmt(stats.heldSol, 2)} · out ${fmt(stats.soldSol, 2)} SOL`;
      flowEl.title = 'Lifetime flow: total bought, cost still held open, total sold back out.';
    }

    $('toggle').textContent = settings.overlayEnabled !== false
      ? 'Disable overlay'
      : 'Enable overlay';

    $('warmx').textContent = settings.warmXLinksEnabled
      ? '⚡ Instant X links: On'
      : '⚡ Instant X links: Off';

    $('warmdest').textContent = settings.warmEverywhereEnabled
      ? '⚡ Instant terminal links: On'
      : '⚡ Instant terminal links: Off';

    $('xray').textContent = settings.xrayEnabled
      ? '⌖ X-Ray on x.com: On'
      : '⌖ X-Ray on x.com: Off';

    // The master switch outranks everything; the popup must show it loudly.
    const appOn = settings.appEnabled !== false;
    const power = $('power');
    power.textContent = appOn ? '⏻ Turn PaperTrench off' : '⏻ Turn PaperTrench on';
    power.className = appOn ? 'btn-backup' : 'btn-pri';
    const badge = $('badge');
    badge.textContent = appOn ? 'PAPER' : 'OFF';
    badge.classList.toggle('badge-off', !appOn);

    $('cash').textContent = fmt(state.cashSol, 2);
    $('open').textContent = stats.openPositions;
    $('rounds').textContent = stats.rounds;

    const pnlEl = $('pnl');
    pnlEl.textContent = (stats.realizedPnlSol >= 0 ? '+' : '') + fmt(stats.realizedPnlSol, 3);
    pnlEl.className = 'v ' + (stats.realizedPnlSol >= 0 ? 'green' : 'red');

    fillQuickSettings(settings);

    const rounds = (state.rounds || []).slice(0, 6);
    $('recent').innerHTML = rounds.length
      ? rounds.map((r) => `
          <div class="row">
            <span><strong>${escapeHtml(r.symbol || '?')}</strong><span class="dim"> · ${((r.heldMs || 0) / 60000).toFixed(1)}m</span></span>
            <span class="${r.pnlSol >= 0 ? 'green' : 'red'}" style="font-weight:700">${r.pnlSol >= 0 ? '+' : ''}${fmt(r.pnlSol, 3)} SOL</span>
          </div>`).join('')
      : '<div class="row dim">No closed round trips yet</div>';
  } catch (err) {
    $('status').textContent = 'Error: ' + err.message;
    console.error('PaperTrench popup load failed', err);
  }
}

/* ------------------------- quick settings -------------------------
 * The handful of knobs people re-tune mid-session — starting balance, the
 * preset rows, a fee profile — editable right here (lev: "it will be nice to
 * have these on the tab for quick fixes"). Validation mirrors the dashboard
 * exactly: a bad value keeps the SAVED value and says so, never a silent
 * default (D-42/D-06). The full Fees & costs form stays on the dashboard.
 */
let qsFilled = false;

function fillQuickSettings(settings) {
  // Only on the first load(): the toggles re-run load() and re-filling every
  // time would clobber whatever the user is mid-typing in these fields.
  if (qsFilled) return;
  qsFilled = true;
  $('qs-balance').value = settings.balanceStartSol;
  $('qs-presets').value = (settings.presetsBuy || DEFAULTS.presetsBuy).join(', ');
  $('qs-sellpcts').value = (settings.sellPcts || DEFAULTS.sellPcts).join(', ');
  const match = Object.keys(FEE_PRESETS).find((key) => {
    const p = FEE_PRESETS[key];
    return Number(settings.feeBps) === p.feeBps
      && (Number(settings.gasSolPerTx) || 0) === p.gasSolPerTx
      && (Number(settings.tipSolPerTx) || 0) === p.tipSolPerTx
      && (Number(settings.slippageBps) || 0) === p.slippageBps;
  });
  $('qs-fees').value = match || 'custom';
}

/** Comma list -> bounded positive numbers, dashboard rules: > 0, ≤ max,
 * at most 8, optional dedupe. Returns null (keep saved) for an empty field. */
function parseNumberList(raw, max, label, notes, { dedupe = false } = {}) {
  const parts = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  let values = parts.map((s) => parseFloat(s)).filter((n) => Number.isFinite(n) && n > 0 && n <= max);
  if (dedupe) values = [...new Set(values)];
  if (values.length > 8) values = values.slice(0, 8);
  if (!values.length) { notes.push(`${label}: no valid entries — kept the saved list`); return null; }
  if (values.length !== parts.length) {
    notes.push(`${label}: kept ${values.length} of ${parts.length} entries (each must be > 0 and ≤ ${max}, max 8${dedupe ? ', no repeats' : ''})`);
  }
  return values;
}

async function applyQuickSettings() {
  const stored = await chrome.storage.local.get(['pt_settings']);
  const settings = { ...DEFAULTS, ...(stored.pt_settings || {}) };
  const notes = [];
  const patch = {};

  const balanceRaw = $('qs-balance').value;
  const balanceNum = Number(balanceRaw);
  if (String(balanceRaw).trim() === '') {
    // untouched/cleared: keep saved
  } else if (Number.isFinite(balanceNum) && balanceNum >= 0.1) {
    if (balanceNum !== Number(settings.balanceStartSol)) {
      patch.balanceStartSol = balanceNum;
      notes.push('starting balance saved — the % baseline moves now, cash changes on the next reset');
    }
  } else {
    notes.push(`starting balance "${balanceRaw}" rejected (must be ≥ 0.1 SOL) — kept ${settings.balanceStartSol}`);
  }

  const presets = parseNumberList($('qs-presets').value, 1000, 'quick-buy presets', notes);
  if (presets) patch.presetsBuy = presets;
  const sellPcts = parseNumberList($('qs-sellpcts').value, 100, 'quick-sell presets', notes, { dedupe: true });
  if (sellPcts) patch.sellPcts = sellPcts;

  const feeChoice = $('qs-fees').value;
  if (FEE_PRESETS[feeChoice]) Object.assign(patch, FEE_PRESETS[feeChoice]);

  if (!Object.keys(patch).length) {
    $('status').textContent = notes.length ? notes.join(' · ') : 'Nothing to change.';
    return;
  }
  await chrome.storage.local.set({ pt_settings: { ...settings, ...patch } });
  chrome.runtime.sendMessage({ type: 'pt_settings_changed' }).catch(() => {});
  qsFilled = false; // re-fill from what was actually saved
  await load();
  $('status').textContent = ['Applied — open trading tabs pick it up live.', ...notes].join(' · ');
}

async function toggleOverlay() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  // Try to flip the active tab's master overlay switch. If the content script
  // is not running, update storage directly so the next page load respects it.
  if (tab) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'pt_toggle_overlay' });
      window.close();
      return;
    } catch (_) {}
  }
  const stored = await chrome.storage.local.get(['pt_settings']);
  const settings = { ...DEFAULTS, ...(stored.pt_settings || {}) };
  const newSettings = { ...settings, overlayEnabled: !settings.overlayEnabled };
  await chrome.storage.local.set({ pt_settings: newSettings });
  chrome.runtime.sendMessage({ type: 'pt_settings_changed' }).catch(() => {});
  // D-30: the button label ("Enable overlay"/"Disable overlay") is rendered
  // by load() from stored settings; without re-running it the label kept
  // describing the state this click just flipped away from.
  await load();
  $('status').textContent = tab
    ? 'Updated — the overlay will respond once you reload this page.'
    : 'Updated.';
}

/** THE off switch. One click and PaperTrench goes fully dormant everywhere —
 * no overlay, no positions bar, no chart drawings, no title feed, no instant
 * X links (the hidden viewer is released too) — live, in every open tab,
 * until it is turned back on. Sub-settings are preserved, so switching back
 * on restores exactly the configuration the user had. */
async function togglePower() {
  const stored = await chrome.storage.local.get(['pt_settings']);
  const settings = { ...DEFAULTS, ...(stored.pt_settings || {}) };
  const next = { ...settings, appEnabled: settings.appEnabled === false };
  await chrome.storage.local.set({ pt_settings: next });
  chrome.runtime.sendMessage({ type: 'pt_settings_changed' }).catch(() => {});
  await load();
  $('status').textContent = next.appEnabled
    ? 'PaperTrench is back on — your panels return per your settings.'
    : 'PaperTrench is off everywhere. Nothing shows up on any site until you turn it back on. Your wallet, journal, and settings are untouched.';
}

/** Opt-in warm viewer for X links clicked on trading sites. The status line
 * spells out the cost (one muted background x.com tab) — a hidden tab a user
 * discovers by surprise is the kind of thing that erodes trust in an
 * extension, so it is disclosed at the exact moment of opt-in. */
async function toggleWarmXLinks() {
  const stored = await chrome.storage.local.get(['pt_settings']);
  const settings = { ...DEFAULTS, ...(stored.pt_settings || {}) };
  const next = { ...settings, warmXLinksEnabled: !settings.warmXLinksEnabled };
  await chrome.storage.local.set({ pt_settings: next });
  chrome.runtime.sendMessage({ type: 'pt_settings_changed' }).catch(() => {});
  await load();
  $('status').textContent = next.warmXLinksEnabled
    ? 'On — X links on trading sites now open in a kept-warm viewer tab (~0.5s instead of ~3.5s). PaperTrench keeps one muted background x.com tab for this; Ctrl/Cmd/middle-click still opens normal tabs.'
    : 'Off — the background X tab is released and links open normally.';
}

/* Same honest-cost disclosure pattern as the X toggle: the price of the
 * feature is stated at the exact moment of opt-in. */
async function toggleWarmEverywhere() {
  const stored = await chrome.storage.local.get(['pt_settings']);
  const settings = { ...DEFAULTS, ...(stored.pt_settings || {}) };
  const next = { ...settings, warmEverywhereEnabled: !settings.warmEverywhereEnabled };
  await chrome.storage.local.set({ pt_settings: next });
  chrome.runtime.sendMessage({ type: 'pt_settings_changed' }).catch(() => {});
  await load();
  $('status').textContent = next.warmEverywhereEnabled
    ? 'On — Axiom, Padre, GMGN, pump.fun and Solscan links across terminals open in kept-warm viewer tabs, and positions-bar hops to another terminal stop replacing the tab you are on. pump.fun and Solscan pre-warm (up to two muted background tabs); terminal viewers appear on first use. Ctrl/Cmd/middle-click still opens normal tabs.'
    : 'Off — all viewer tabs are released and links open normally.';
}

/** Account intel on X itself. The status line states the two things a user
 * deserves to know at the moment of opt-in: where the data comes from (the X
 * page's own responses, on this device) and what it cannot know (any change
 * that happened before X-Ray first saw the account). */
async function toggleXRay() {
  const stored = await chrome.storage.local.get(['pt_settings']);
  const settings = { ...DEFAULTS, ...(stored.pt_settings || {}) };
  const next = { ...settings, xrayEnabled: !settings.xrayEnabled };
  await chrome.storage.local.set({ pt_settings: next });
  chrome.runtime.sendMessage({ type: 'pt_settings_changed' }).catch(() => {});
  await load();
  $('status').textContent = next.xrayEnabled
    ? 'On — open any X profile or post and the intel card is already there: account age, bio/name/@handle changes, CAs posted, and Smart Following. It reads the X page\'s own data on this device; change history starts from the first time you view an account, and the card says so.'
    : 'Off — no card on X, and nothing further is read from X pages.';
}

/** Chromeless window sized for the card layout — OBS window-captures it. */
function openStreamOverlay() {
  chrome.windows.create({
    url: chrome.runtime.getURL('overlay.html'),
    type: 'popup',
    width: 440,
    height: 560,
  });
  window.close();
}

async function resetWallet() {
  if (!confirm('Reset the paper wallet and erase positions, trade history, frames, and session replays?')) return;
  const stored = await chrome.storage.local.get(['pt_settings', 'pt_state']);
  const settings = { ...DEFAULTS, ...(stored.pt_settings || {}) };
  // Inherit the current seq: a reset written at seq 0 looks OLDER than the
  // state a still-open trading tab holds, and its next heartbeat write
  // resurrects the pre-reset wallet.
  const baseSeq = (stored.pt_state && Number(stored.pt_state.seq)) || 0;
  const fresh = freshState(settings);
  fresh.seq = baseSeq + 1;
  // F-14: the attestation chain lives in its own segmented keys. The empty
  // meta rides the SAME write as the wallet wipe, so the chain can never
  // survive a reset the wallet did not; orphaned segment bodies (unreachable
  // once the meta says zero) are swept best-effort after.
  const wipe = {
    pt_state: fresh,
    pt_frames: [],
    pt_replays: [],
  };
  let staleSegKeys = [];
  if (AT) {
    wipe[AT.CHAIN_META_KEY] = AT.normalizeChainMeta(null);
    try {
      const meta = await AT.readChainMeta(chainGet);
      staleSegKeys = AT.chainStorageKeys(meta).filter((key) => key !== AT.CHAIN_META_KEY);
    } catch (_) { /* segments unknown: the meta overwrite still orphans them */ }
  }
  await chrome.storage.local.set(wipe);
  if (staleSegKeys.length) {
    try { await chrome.storage.local.remove(staleSegKeys); } catch (_) {}
  }
  // The confirm text promises recordings are erased too; the background owns
  // the IndexedDB store (DEFECT D-36).
  chrome.runtime.sendMessage({ type: 'pt_clear_recordings' }).catch(() => {});
  chrome.runtime.sendMessage({ type: 'pt_settings_changed' }).catch(() => {});
  load();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* ------------------------- backup / restore -------------------------
 * Unpacked extensions key their data by install folder. Re-downloading a
 * release into a NEW folder therefore looks like a fresh install and the
 * wallet disappears. Backup/Restore makes that a two-click recovery: the
 * snapshot carries every storage key, versioned so future formats can be
 * migrated on import.
 */
const BACKUP_KEYS = ['pt_state', 'pt_settings', 'pt_frames', 'pt_replays'];

async function backupWallet() {
  const stored = await chrome.storage.local.get(BACKUP_KEYS);
  // F-14: the attestation chain lives in segmented storage, not in pt_state.
  // The backup bundles it as ONE array (pt_attest_chain) so a restore can
  // re-segment it on any future segment size — and so the verifiable record
  // survives a reinstall exactly like the wallet does. A pre-migration
  // install still carries the chain inside pt_state; bundle that instead.
  let chainMissing = false;
  if (AT) {
    try {
      const { chain } = await AT.readChainStore(chainGet);
      if (chain.length) stored.pt_attest_chain = chain;
      else if (stored.pt_state && Array.isArray(stored.pt_state.attestChain) && stored.pt_state.attestChain.length) {
        stored.pt_attest_chain = stored.pt_state.attestChain;
      }
      // Downgrade safety: ALSO embed the chain inside the backup's pt_state
      // copy, exactly where a pre-segmentation extension expects it. An old
      // restore then keeps the record intact instead of silently dropping it
      // (and flagging a verification mismatch after the next fill); the new
      // restore strips this copy and re-segments pt_attest_chain. The file
      // carries the chain twice, but a backup that can lose the verifiable
      // record on the way back in is not a backup.
      if (stored.pt_attest_chain && stored.pt_state) {
        stored.pt_state = { ...stored.pt_state, attestChain: stored.pt_attest_chain };
      }
    } catch (_) { chainMissing = true; }
  }
  const backup = {
    app: 'papertrench-backup',
    format: 1,
    exportedAt: new Date().toISOString(),
    data: stored,
  };
  const blob = new Blob([JSON.stringify(backup)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `papertrench-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  // DEFECT D-41: screen recordings live in IndexedDB (tens of MB) and are
  // deliberately NOT exported. The status line must say so — silently
  // implying "everything is in the file" is an overpromise the user only
  // discovers after the original machine is gone.
  $('status').textContent = chainMissing
    // Same honesty rule for the chain: a backup that quietly lacks the
    // verifiable record would be discovered exactly when it matters most.
    ? 'Backup downloaded — but the verification chain could not be read and is NOT in the file. Screen recordings also stay on this machine.'
    : 'Backup downloaded — note that screen recordings stay on this machine and are not in the file.';
}

async function restoreWallet(ev) {
  const file = ev.target.files && ev.target.files[0];
  ev.target.value = ''; // allow re-selecting the same file later
  if (!file) return;
  let backup;
  try {
    backup = JSON.parse(await file.text());
  } catch (_) {
    $('status').textContent = 'That file is not valid JSON.';
    return;
  }
  // Accept both the versioned envelope and a bare {pt_state, ...} snapshot,
  // but refuse anything that does not look like our own export.
  const data = backup && backup.app === 'papertrench-backup' ? backup.data : backup;
  if (!data || typeof data !== 'object' || !data.pt_state || typeof data.pt_state !== 'object') {
    $('status').textContent = 'Not a PaperTrench backup — nothing was restored.';
    return;
  }
  const rounds = Array.isArray(data.pt_state.rounds) ? data.pt_state.rounds.length : 0;
  if (!confirm(`Restore this backup? It replaces your current wallet (${rounds} closed rounds in the backup).`)) return;
  const write = {};
  for (const key of BACKUP_KEYS) if (data[key] !== undefined) write[key] = data[key];
  // F-14: round-trip the attestation chain. New backups carry it as one
  // array (pt_attest_chain); pre-migration backups carry it inside pt_state.
  // Either way it is re-segmented into the store, and the restored pt_state
  // never ships a legacy in-state copy. Hashes are written exactly as they
  // were committed — a restore must not cost the record its verifiability.
  if (AT) {
    const chainLinks = Array.isArray(data.pt_attest_chain) ? data.pt_attest_chain
      : (Array.isArray(data.pt_state.attestChain) ? data.pt_state.attestChain : []);
    if (write.pt_state && write.pt_state.attestChain !== undefined) delete write.pt_state.attestChain;
    // A restore REPLACES the record: sweep the current segments first so a
    // shorter restored chain cannot leave stale tail segments behind.
    try {
      const meta = await AT.readChainMeta(chainGet);
      const staleKeys = AT.chainStorageKeys(meta).filter((key) => key !== AT.CHAIN_META_KEY);
      if (staleKeys.length) await chrome.storage.local.remove(staleKeys);
    } catch (_) { /* the meta written below orphans whatever remains */ }
    Object.assign(write, AT.chainSegments(chainLinks));
  }
  // The backup's own seq is meaningless in this browser: any open trading tab
  // holding a higher write counter would treat the restored wallet as stale
  // and overwrite it on its next heartbeat — resurrecting the wallet the user
  // just replaced. Land the restore strictly ahead of everything alive, the
  // same way resetWallet does.
  const current = await chrome.storage.local.get(['pt_state']);
  const liveSeq = Number(current.pt_state && current.pt_state.seq) || 0;
  const backupSeq = Number(write.pt_state.seq) || 0;
  write.pt_state.seq = Math.max(liveSeq, backupSeq) + 1;
  // The wallet goes through the worker's serialized commit queue (forced —
  // a restore is the new truth by user intent) so it cannot interleave with
  // a tab's heartbeat commit; the other keys have no concurrent writers.
  const restored = await chrome.runtime.sendMessage({
    type: 'pt_state_commit', state: write.pt_state, force: true,
  }).catch(() => null);
  const rest = { ...write };
  if (restored && restored.ok) delete rest.pt_state;
  await chrome.storage.local.set(rest);
  chrome.runtime.sendMessage({ type: 'pt_settings_changed' }).catch(() => {});
  $('status').textContent = 'Backup restored.';
  load();
}

load();
