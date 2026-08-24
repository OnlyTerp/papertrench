/* PaperTrench — stream overlay.
 *
 * A capture-friendly window for streamers: OBS window-captures it, chroma-keys
 * the background, and the widget floats over the stream showing live paper
 * equity, session P&L, and open positions.
 *
 * Self-contained like popup.js: reads storage and formats numbers only, no
 * engine.js load-order dependency. Renders live off chrome.storage.onChanged —
 * every fill and heartbeat the trading tab writes repaints this window.
 *
 * The PAPER badge, watermark, and footer are deliberately not configurable:
 * a stream overlay that could pass as real-money P&L would be a lie with an
 * audience. Same rule as the P&L cards.
 */

'use strict';

const DEFAULTS = { balanceStartSol: 10 };
const PREFS_KEY = 'pt_overlay_prefs';
const LAYOUTS = ['card', 'bar'];
const BACKGROUNDS = ['green', 'magenta', 'dark'];
const SPARK_ROUNDS = 30;   // most recent closed rounds in the sparkline
const MAX_POS_CARD = 4;
const MAX_POS_BAR = 3;

function $(id) { return document.getElementById(id); }

function fmt(n, dp = 4) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '—';
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: dp });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* ------------------------------ preferences ------------------------------ */

function loadPrefs() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch (_) {}
  const params = new URLSearchParams(location.search);
  const layout = params.get('layout') || saved.layout;
  const bg = params.get('bg') || saved.bg;
  return {
    layout: LAYOUTS.includes(layout) ? layout : 'card',
    bg: BACKGROUNDS.includes(bg) ? bg : 'green',
  };
}

let prefs = loadPrefs();

function applyPrefs() {
  document.body.className = `layout-${prefs.layout} bg-${prefs.bg}`;
  document.querySelectorAll('#layoutGrp button').forEach((b) =>
    b.classList.toggle('on', b.dataset.layout === prefs.layout));
  document.querySelectorAll('#bgGrp button').forEach((b) =>
    b.classList.toggle('on', b.dataset.bg === prefs.bg));
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (_) {}
}

document.querySelectorAll('#layoutGrp button').forEach((b) => {
  b.addEventListener('click', () => { prefs.layout = b.dataset.layout; applyPrefs(); render(); });
});
document.querySelectorAll('#bgGrp button').forEach((b) => {
  b.addEventListener('click', () => { prefs.bg = b.dataset.bg; applyPrefs(); });
});
$('helpBtn').addEventListener('click', () => $('setup').classList.toggle('open'));

/* ------------------------------ stats ------------------------------ */

/** D-56: the birth balance re-derived from the fill journal alone — the
 * anchor for LEGACY wallets that predate D-06's state.startSol snapshot
 * (created before v3.9.5). Mirrors engine.derivedBirthSol / popup's
 * derivedAnchor (the overlay is self-contained on purpose — no engine.js
 * load-order dependency — so the rule is duplicated here and the test
 * suite pins all three to the same fixture):
 * equity = birth + Σ(buy fees) + Σ(sell pnl) + open P&L →
 * birth = equity − open P&L − Σ steps. Null when the journal can't support
 * the derivation; null defers to the setting fallback. */
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

/** D-06 + D-56: the honest "% since start" denominator, in one place. */
function anchorFor(state, settings) {
  const birth = Number(state && state.startSol);
  if (Number.isFinite(birth) && birth > 0) return birth;
  const derived = derivedAnchor(state);
  if (derived !== null && derived > 1e-6) return derived;
  const setting = Number(settings && settings.balanceStartSol);
  return Number.isFinite(setting) && setting > 0 ? setting : 0;
}

function computeStats(state, settings) {
  const positions = Object.values(state.positions || {});
  const rounds = state.rounds || [];
  const openValue = positions.reduce((s, p) => s + (p.qty || 0) * (p.lastPriceNative || 0), 0);
  const equity = (state.cashSol || 0) + openValue;
  const wins = rounds.filter((r) => r.pnlSol > 0).length;
  return {
    equitySol: equity,
    // D-06 + D-56: birth snapshot → journal-derived birth (legacy wallets)
    // → live setting, all through anchorFor.
    equityVsStart: equity - anchorFor(state, settings),
    realizedPnlSol: rounds.reduce((s, r) => s + (r.pnlSol || 0), 0),
    rounds: rounds.length,
    winRate: rounds.length ? (wins / rounds.length) * 100 : null,
    positions,
  };
}

/* ------------------------------ sparkline ------------------------------ */

function drawSpark(rounds) {
  const canvas = $('spark');
  const wrap = canvas.parentElement;
  // Cumulative realized P&L over the most recent rounds, oldest → newest.
  // rounds is stored newest-first.
  const recent = rounds.slice(0, SPARK_ROUNDS).reverse();
  if (recent.length < 2) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';

  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const pts = [0];
  let acc = 0;
  for (const r of recent) { acc += r.pnlSol || 0; pts.push(acc); }
  const min = Math.min(0, ...pts), max = Math.max(0, ...pts);
  const span = (max - min) || 1;
  const px = (i) => (i / (pts.length - 1)) * (w - 4) + 2;
  const py = (v) => h - 3 - ((v - min) / span) * (h - 6);

  // zero line
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.setLineDash([3, 4]);
  ctx.beginPath();
  ctx.moveTo(0, py(0));
  ctx.lineTo(w, py(0));
  ctx.stroke();
  ctx.setLineDash([]);

  const up = pts[pts.length - 1] >= 0;
  const line = up ? '#34D399' : '#FF5F56';

  // fill under the curve
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, up ? 'rgba(52,211,153,0.22)' : 'rgba(255,95,86,0.22)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.beginPath();
  ctx.moveTo(px(0), py(pts[0]));
  for (let i = 1; i < pts.length; i++) ctx.lineTo(px(i), py(pts[i]));
  ctx.lineTo(px(pts.length - 1), h);
  ctx.lineTo(px(0), h);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(px(0), py(pts[0]));
  for (let i = 1; i < pts.length; i++) ctx.lineTo(px(i), py(pts[i]));
  ctx.strokeStyle = line;
  ctx.lineWidth = 1.6;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // last point dot
  ctx.beginPath();
  ctx.arc(px(pts.length - 1), py(pts[pts.length - 1]), 2.4, 0, Math.PI * 2);
  ctx.fillStyle = line;
  ctx.fill();
}

/* ------------------------------ render ------------------------------ */

let lastEquity = null;

async function render() {
  let stored;
  try {
    stored = await chrome.storage.local.get(['pt_state', 'pt_settings']);
  } catch (err) {
    $('delta').textContent = 'Storage unavailable: ' + err.message;
    return;
  }
  const settings = { ...DEFAULTS, ...(stored.pt_settings || {}) };
  const state = stored.pt_state || { cashSol: settings.balanceStartSol, positions: {}, rounds: [] };
  const stats = computeStats(state, settings);

  const up = stats.equityVsStart >= 0;
  $('equity').innerHTML = `${fmt(stats.equitySol, 2)} <small>SOL</small>`;
  $('equity').style.color = up ? 'var(--green)' : 'var(--red)';

  const deltaEl = $('delta');
  // D-06 + D-56: % vs start uses the wallet's birth balance — the snapshot
  // when one exists, the journal-derived birth for legacy wallets, the
  // live setting only as the last resort.
  const anchor = anchorFor(state, settings);
  const pct = anchor > 0 ? (stats.equityVsStart / anchor) * 100 : 0;
  deltaEl.textContent = `${up ? '▲' : '▼'} ${up ? '+' : ''}${fmt(stats.equityVsStart, 3)} SOL (${up ? '+' : ''}${pct.toFixed(1)}%) vs start`;
  deltaEl.style.color = up ? 'var(--green)' : 'var(--red)';

  // pulse on change so a fill reads on stream even at small scale
  if (lastEquity !== null && stats.equitySol !== lastEquity) {
    deltaEl.classList.remove('flash-up', 'flash-down');
    void deltaEl.offsetWidth; // restart the animation
    deltaEl.classList.add(stats.equitySol > lastEquity ? 'flash-up' : 'flash-down');
  }
  lastEquity = stats.equitySol;

  const realizedEl = $('realized');
  realizedEl.textContent = (stats.realizedPnlSol >= 0 ? '+' : '') + fmt(stats.realizedPnlSol, 2);
  realizedEl.style.color = stats.realizedPnlSol >= 0 ? 'var(--green)' : 'var(--red)';

  $('winrate').textContent = stats.winRate === null ? '—' : stats.winRate.toFixed(0) + '%';
  $('rounds').textContent = stats.rounds;
  // ark_trades13 ask (8/20): "your total amount of SOL on the display
  // overlay" — the equity hero shows the sum; the tiles now show where it
  // sits. Cash + open value always re-sums to the equity number above, so
  // the split can never disagree with the hero.
  const openValue = stats.positions.reduce(
    (s, p) => s + (p.qty || 0) * (p.lastPriceNative || 0), 0);
  $('cash').textContent = fmt(state.cashSol || 0, 2);
  $('openval').textContent = fmt(openValue, 2);
  $('open').textContent = stats.positions.length;

  const maxPos = prefs.layout === 'bar' ? MAX_POS_BAR : MAX_POS_CARD;
  const shown = stats.positions.slice(0, maxPos);
  const extra = stats.positions.length - shown.length;
  const posEl = $('positions');
  if (!shown.length) {
    posEl.innerHTML = prefs.layout === 'bar' ? '' : '<div class="pos-row none">No open positions</div>';
  } else {
    posEl.innerHTML = shown.map((p) => {
      const pnl = (p.qty || 0) * (p.lastPriceNative || 0) - (p.costSol || 0);
      const pctPos = p.costSol > 0 ? (pnl / p.costSol) * 100 : 0;
      const cls = pnl >= 0 ? 'var(--green)' : 'var(--red)';
      return `<div class="pos-row">
        <span class="sym">${escapeHtml(p.symbol || '?')}</span>
        <span class="size">${fmt(p.investedSol, 2)} ◎</span>
        <span class="pnl" style="color:${cls}">${pnl >= 0 ? '+' : ''}${pctPos.toFixed(1)}%</span>
      </div>`;
    }).join('') + (extra > 0 ? `<div class="pos-row none">+${extra} more</div>` : '');
  }

  drawSpark(state.rounds || []);
}

/* ------------------------------ wiring ------------------------------ */

applyPrefs();
render();

if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.pt_state || changes.pt_settings)) render();
  });
}
// Repaint on focus/resize; onChanged covers the rest.
window.addEventListener('resize', () => render());
window.addEventListener('focus', () => render());
