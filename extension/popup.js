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
$('desk').addEventListener('click', async () => {
  // Docked desk (DELIGHT-MAP.md D1): open the side panel for the current
  // window. chrome.sidePanel.open requires a user gesture — this click is
  // one. Falls back to nothing if the API is unavailable (older Chrome).
  try {
    const win = await chrome.windows.getCurrent();
    await chrome.sidePanel.open({ windowId: win.id });
    await chrome.sidePanel.setOptions({ path: 'panel.html', enabled: true });
  } catch (e) {
    console.warn('[papertrench] side panel unavailable', e);
  }
  window.close();
});
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
$('sharelogs').addEventListener('click', shareDebugLogs);

/* ---- share debug logs -----------------------------------------------
 * One click -> a redacted JSON report on the clipboard, ready to paste in
 * Discord. Pulls BOTH halves of the error black box (the service worker's
 * ring and the active tab's content-script ring — separate worlds, separate
 * buffers), plus enough environment to reproduce: version, site, and the
 * live chip diagnostics that carry hideReason for every quick-buy chip.
 * Everything was redacted AT RECORD TIME (errors.js strips keys, tokens and
 * addresses before storage), so this report is safe by construction, not by
 * an export-time scrub that could miss a new field. Nothing is transmitted
 * anywhere: the user IS the transport. */
async function shareDebugLogs() {
  const btn = $('sharelogs');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Collecting…';
  try {
    const report = {
      app: 'papertrench-debug-report',
      format: 1,
      exportedAt: new Date().toISOString(),
      version: (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '?',
      ua: navigator.userAgent,
      errors: { background: [], content: [] },
      tab: null,
    };
    // Worker half. The worker also accepts forwarded content entries, but we
    // pull the tab half ourselves so a dead tab cannot block the report.
    try {
      const bg = await chrome.runtime.sendMessage({ type: 'pt_errors_snapshot' });
      if (bg && bg.ok) report.errors.background = bg.entries || [];
    } catch (_) { /* worker asleep: background half stays empty */ }
    // Content half + live chip diagnostics from the active tab, if it is a
    // page we run on. Every step is optional — a chrome:// tab or a page
    // without chips still yields a useful report.
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.id != null && /^https:/.test(tab.url || '')) {
        report.tab = { url: (tab.url || '').split('?')[0] };
        try {
          const ct = await chrome.tabs.sendMessage(tab.id, { type: 'pt_errors_snapshot_content' });
          if (ct && ct.ok) report.errors.content = ct.entries || [];
        } catch (_) { /* no content script on this tab */ }
        try {
          const chips = await chrome.tabs.sendMessage(tab.id, { type: 'pt_chip_debug' });
          if (chips && chips.ok) report.chips = chips.chips || null;
        } catch (_) { /* chip bridge absent (non-screener page) */ }
      }
    } catch (_) { /* tabs query denied: report still carries the worker half */ }
    const text = JSON.stringify(report, null, 1);
    await navigator.clipboard.writeText(text);
    const n = report.errors.background.length + report.errors.content.length;
    btn.textContent = `✓ Copied (${n} error${n === 1 ? '' : 's'}) — paste in Discord`;
  } catch (e) {
    btn.textContent = 'Copy failed — try again';
  } finally {
    setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 4000);
  }
}

function canonicalBackupValue(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalBackupValue).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalBackupValue(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function stateFingerprint(state) {
  if (!state || typeof state !== 'object') return null;
  const copy = { ...state };
  // seq and updatedAt move on every heartbeat, not on durable wallet edits.
  delete copy.seq;
  delete copy.updatedAt;
  // markPosition writes these on price ticks; they are not backup content.
  if (copy.positions && typeof copy.positions === 'object') {
    copy.positions = Object.fromEntries(Object.entries(copy.positions).map(([key, position]) => {
      if (!position || typeof position !== 'object') return [key, position];
      const durable = { ...position };
      delete durable.lastPriceNative;
      delete durable.lastPriceUsd;
      delete durable.peakPnlSol;
      delete durable.troughPnlSol;
      return [key, durable];
    }));
  }
  // attestChain is embedded into the exported copy for downgrade safety.
  delete copy.attestChain;
  let hash = 0x811c9dc5;
  for (const char of canonicalBackupValue(copy)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/* ---- update nudge ---------------------------------------------------
 * PaperTrench ships as a zip from GitHub — no Chrome Web Store, so Chrome
 * never auto-updates it. Field reports from 8/16–19 described bugs fixed
 * on 8/6: stale installs, no discovery path. The popup now asks GitHub
 * (rate-limit-safe unauthenticated REST, cached in storage, checked at
 * most once a day) whether a newer release exists, and shows one amber
 * banner: the version, one line, the download link. Dismiss stores the
 * seen version so the nudge is quiet until the NEXT release.
 * Fail-open by design: any error (offline, rate-limited, schema drift)
 * leaves the popup exactly as it was.
 */

const UPDATER = (() => {
  const REL_URL = 'https://api.github.com/repos/OnlyTerp/papertrench/releases/latest';
  const DAY_MS = 24 * 60 * 60 * 1000;
  let downloadArmedUntil = 0;

  function vCmp(a, b) {
    const pa = String(a).split('.').map(Number);
    const pb = String(b).split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d) return d;
    }
    return 0;
  }

  function backupText(record, state) {
    const at = record && Number(record.at);
    if (!record) {
      return 'No backup yet — updating into a new folder looks like a fresh install.';
    }
    if (!state) {
      return 'Backup exists, but the wallet could not be read, so coverage cannot be confirmed. Back up again to be safe.';
    }
    if (!Number.isFinite(at)) {
      return 'Backup exists, but its date could not be read. Back up again to be safe.';
    }
    const date = new Date(at).toISOString().slice(0, 10);
    if (record.startedAt !== state.startedAt) {
      return `Last backup: ${date} — different wallet since. Back up again.`;
    }
    const trades = Array.isArray(state.journal) ? state.journal.length : 0;
    if (record.fingerprint && record.fingerprint === stateFingerprint(state)) {
      return `Last backup: ${date}`;
    }
    if (Number.isFinite(Number(record.trades)) && trades > Number(record.trades)) {
      const delta = trades - Number(record.trades);
      return `Last backup: ${date} — ${delta} ${delta === 1 ? 'trade' : 'trades'} since. Back up again.`;
    }
    if (!Number.isFinite(Number(record.trades)) || trades < Number(record.trades)) {
      return `Last backup: ${date} — wallet history changed. Back up again.`;
    }
    return `Last backup: ${date} — wallet changed since. Back up again.`;
  }

  async function check(force) {
    const now = Date.now();
    let cache = {};
    try { cache = (await chainGet(['pt_update_check']))['pt_update_check'] || {}; }
    catch (_) { /* storage read failed — treat as uncached */ }
    if (!force && cache.checkedAt && now - cache.checkedAt < DAY_MS) return null;
    // Reserve the slot even before the fetch: two popups opened in the same
    // day (or a hung fetch) must not re-hit GitHub.
    const stamp = { checkedAt: now };
    try { await chrome.storage.local.set({ pt_update_check: stamp }); } catch (_) {}
    try {
      const res = await fetch(REL_URL, { headers: { Accept: 'application/vnd.github+json' } });
      if (!res.ok) return null;
      const rel = await res.json();
      const latest = (rel.tag_name || '').replace(/^v/, '');
      const assetUrl = (rel.assets || []).find((a) => a && a.name && a.name.endsWith('.zip'))
        ? (rel.assets.find((a) => a.name.endsWith('.zip')) || {}).browser_download_url
        : null;
      return { latest, url: assetUrl || rel.html_url || 'https://github.com/OnlyTerp/papertrench/releases/latest' };
    } catch (_) {
      return null; // offline / rate-limited — silent, popup unchanged
    }
  }

  async function render() {
    const banner = document.getElementById('update-banner');
    const txt = document.getElementById('update-txt');
    const dismiss = document.getElementById('update-dismiss');
    const version = document.getElementById('update-version');
    const link = document.getElementById('update-link');
    const backupButton = document.getElementById('update-backup');
    const backupState = document.getElementById('update-backup-state');
    if (!banner || !txt || !dismiss || !version || !link || !backupButton || !backupState) return;
    let info = null;
    try { info = await check(); } catch (_) { return; }
    if (!info || !info.latest || vCmp(info.latest, chrome.runtime.getManifest().version) <= 0) {
      return;
    }
    let seen = {};
    try { seen = (await chainGet(['pt_update_seen']))['pt_update_seen'] || {}; } catch (_) {}
    let lastBackup = null;
    let liveState = null;
    try { lastBackup = (await chainGet(['pt_last_backup'])).pt_last_backup || null; }
    catch (_) { lastBackup = null; }
    try { liveState = (await chainGet(['pt_state'])).pt_state || null; }
    catch (_) { liveState = null; }
    const nowMs = Date.now();
    if (seen.version === info.latest && (seen.at || 0) > nowMs - 30 * DAY_MS) return;
    version.textContent = 'v' + info.latest + ' is out';
    link.href = info.url;
    link.textContent = 'Download the update →';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    backupState.textContent = backupText(lastBackup, liveState);
    const refreshBackupState = async () => {
      try { lastBackup = (await chainGet(['pt_last_backup'])).pt_last_backup || null; }
      catch (_) { lastBackup = null; }
      try { liveState = (await chainGet(['pt_state'])).pt_state || null; }
      catch (_) { liveState = null; }
      backupState.textContent = backupText(lastBackup, liveState);
    };
    const hasBackup = () => {
      const at = lastBackup && Number(lastBackup.at);
      return Number.isFinite(at) && liveState && lastBackup.fingerprint
        && lastBackup.fingerprint === stateFingerprint(liveState);
    };
    backupButton.addEventListener('click', async () => {
      try { await backupWallet(); } catch (_) {}
      await refreshBackupState();
    });
    link.addEventListener('click', (ev) => {
      if (hasBackup() || Date.now() < downloadArmedUntil) return;
      ev.preventDefault();
      downloadArmedUntil = Date.now() + 10 * 1000;
      backupState.textContent = 'No backup yet — click again to update anyway';
    });
    banner.hidden = false;
    const onDismiss = () => {
      try { chrome.storage.local.set({ pt_update_seen: { version: info.latest, at: Date.now() } }); } catch (_) {}
      banner.hidden = true;
    };
    dismiss.addEventListener('click', onDismiss);
  }

  return { check, render };
})();

UPDATER.render();

/* Pane switching. Every pane stays in the DOM — popup.js binds all of these
 * ids at load, and a pane that was removed rather than hidden would take its
 * controls with it. */
(() => {
  const tabs = document.querySelectorAll(".ptab");
  if (!tabs.length) return;
  tabs.forEach((tab) => tab.addEventListener("click", () => {
    tabs.forEach((t) => {
      const on = t === tab;
      t.classList.toggle("on", on);
      t.setAttribute("aria-selected", on ? "true" : "false");
      const pane = document.getElementById(t.dataset.pane);
      if (pane) pane.hidden = !on;
    });
  }));
})();


function fmt(n, dp = 4) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: dp });
}

function freshState(settings) {
  return {
    version: 1,
    seq: 0,
    cashSol: settings.balanceStartSol,
    // D-06/D-56: snapshot the birth balance the way engine.defaultState does
    // (engine.js isn't loaded in the popup). Without it a wallet RESET FROM
    // THE POPUP would be born as a legacy wallet — anchoring on the live
    // setting for its whole life and re-opening the jb 100× hole on a
    // brand-new wallet.
    startSol: settings.balanceStartSol,
    startedAt: Date.now(),
    positions: {},
    rounds: [],
    journal: [],
    stats: { totalBuys: 0, totalSells: 0, realizedPnlSol: 0, feesPaidSol: 0 },
  };
}

/** The gross cost basis still open on one position — engine.grossOpenCostSol's
 * rule, duplicated here for the same reason derivedAnchor duplicates the birth
 * rule: the popup is self-contained on purpose (no engine.js dependency).
 *
 * It is a DERIVED quantity, never a stored field. Reading it as `pos.
 * grossOpenCostSol` yields undefined on every real position — the engine
 * stores costSol / investedSol / netInvestedSol and computes the rest.
 *
 * costSol shrinks proportionally on partial sells while netInvestedSol (total
 * net ever invested) does not, so costSol / netInvestedSol is the surviving
 * fraction of the stack and invested × that fraction is its gross cost.
 * Legacy positions predate netInvestedSol: without partial sells costSol ===
 * net invested and the full investedSol is exact, so it is the fallback.
 */
function grossOpenCostSol(pos) {
  if (!pos) return 0;
  const invested = Number(pos.investedSol) || 0;
  const cost = Number(pos.costSol) || 0;
  const netInvested = Number(pos.netInvestedSol) || 0;
  if (netInvested > 0) return invested * (cost / netInvested);
  return invested;
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
    heldSol += grossOpenCostSol(p);
  }
  return { boughtSol, heldSol, soldSol };
}

/** D-56: the birth balance re-derived from the fill journal alone — the
 * anchor for LEGACY wallets that predate D-06's state.startSol snapshot
 * (created before v3.9.5). Same identity the engine's equity curve uses:
 * equity = birth + Σ(buy fees) + Σ(sell pnl) + open P&L, so
 * birth = equity − open P&L − Σ steps. Mirrors engine.derivedBirthSol: the
 * popup is self-contained on purpose (no engine.js dependency), so the
 * rule is duplicated here and the test suite pins both to the same
 * fixture. Returns null when the journal can't support the derivation
 * (empty or non-finite) — null defers to the setting fallback, it never
 * overrides a real startSol. */
function derivedAnchor(state) {
  const journal = ((state && state.journal) || [])
    .slice().sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
  if (!journal.length) return null;
  const positions = Object.values((state && state.positions) || {});
  let openValue = 0;
  let openPnl = 0;
  for (const p of positions) {
    const qty = Number(p.qty) || 0;
    const px = Number(p.lastPriceNative) || 0;
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
  return Number.isFinite(derived) ? derived : null;
}

/** D-06 + D-56: the honest "% since start" denominator, in one place.
 * Birth snapshot first (D-06), the journal-derived birth second (D-56,
 * legacy wallets), the live setting LAST. */
function anchorFor(state, settings) {
  const birth = Number(state && state.startSol);
  if (Number.isFinite(birth) && birth > 0) return birth;
  const derived = derivedAnchor(state);
  if (derived !== null && derived > 1e-6) return derived;
  const setting = Number(settings && settings.balanceStartSol);
  return Number.isFinite(setting) && setting > 0 ? setting : 0;
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
    // D-06 + D-56: birth snapshot → journal-derived birth (legacy wallets)
    // → live setting, all through anchorFor.
    equityVsStart: equity - anchorFor(state, settings),
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
    // D-06 + D-56: % change is judged against the wallet's birth balance —
    // the snapshot when one exists, the journal-derived birth for legacy
    // wallets, the live setting only as the last resort.
    const anchor = anchorFor(state, settings);
    const pct = anchor ? (stats.equityVsStart / anchor) * 100 : 0;
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
      notes.push('starting balance saved — applies to the NEXT wallet reset; this wallet\u2019s % return stays anchored to the balance it was born with');
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
  const fingerprint = stateFingerprint(stored.pt_state);
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
  try {
    const state = stored.pt_state || null;
    await chrome.storage.local.set({
      pt_last_backup: {
        at: Date.now(),
        version: chrome.runtime.getManifest().version,
        startedAt: state && state.startedAt != null ? state.startedAt : null,
        trades: state && Array.isArray(state.journal) ? state.journal.length : 0,
        fingerprint,
      },
    });
  } catch (_) {}
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
