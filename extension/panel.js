/* Side-panel desk (DELIGHT-MAP.md D1) — the chrome half of the desk.
 *
 * Reads the same pt_state/pt_settings storage the popup and dashboard
 * read, assembles the view through the pure PTPanel module, and renders:
 * streak chips, the active-round card (with the thesis nudge), and the
 * After feed (what the coin did after you left). Open the side panel via
 * the popup's "Desk" button (chrome.sidePanel.open) — clicking in the
 * panel re-renders; storage changes re-render via chrome.storage.onChanged.
 */
'use strict';

const $ = (sel) => document.querySelector(sel);

/* The pure half, bound once. Both render helpers below used to reach for a
 * formatter that was never in scope — `fmtSol(...)` bare in activeHtml and
 * `P.fmtSol(...)` in afterHtml, where neither `fmtSol` nor `P` is declared
 * anywhere in this file and panel-data.js exports onto `window.PTPanel`.
 *
 * Both threw ReferenceError, so the desk rendered ONLY while it was empty:
 * the first open position or the first closed round with an after-watch
 * took render() down, leaving whatever had been on screen before. The empty
 * desk in the bug report was the only state that worked. */
const P = window.PTPanel;

function fmtAgo(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h';
  return Math.floor(h / 24) + 'd';
}

/* Held time is a DURATION. It was being run through fmtSol and then had the
 * unit stripped off the end — so a position held 90 minutes reported
 * "+5400000.00", a raw millisecond count wearing two decimal places. */
function fmtHeld(ms) {
  const total = Math.max(0, Math.floor(Number(ms) || 0) / 60000);
  const m = Math.floor(total % 60);
  const h = Math.floor(total / 60);
  if (h >= 24) {
    const d = Math.floor(h / 24);
    return d + 'd ' + (h % 24) + 'h';
  }
  if (h >= 1) return h + 'h ' + m + 'm';
  if (m >= 1) return m + 'm';
  return 'just opened';
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

const MARK_REST =
  '<svg class="mark" width="22" height="22" viewBox="0 0 24 24" fill="none" '
  + 'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" '
  + 'stroke-linejoin="round" aria-hidden="true">'
  + '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>';
const MARK_AFTER =
  '<svg class="mark" width="22" height="22" viewBox="0 0 24 24" fill="none" '
  + 'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" '
  + 'stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M3.5 16.5 9 11l3.5 3.5L20.5 6.5"/><path d="M15.5 6.5h5v5"/></svg>';

/* One streak axis. The count leads, the axis labels it, best is reference.
 * `on` is what earns the amber — a zero streak is not an achievement, and
 * colouring it like one lies to somebody who has not traded yet. */
function chipHtml(label, st, tierLabel) {
  const cur = st && st.current ? st.current : 0;
  const best = st && st.best ? st.best : 0;
  const tier = tierLabel ? `<span class="tier">${esc(tierLabel)}</span>` : '';
  return `<div class="streak${cur > 0 ? ' on' : ''}">
      <div class="n">${cur}</div>
      <div class="axis">${esc(label)}</div>
      <div class="best">best ${best}</div>
      ${tier}
    </div>`;
}

function activeHtml(a) {
  if (!a) {
    return `<div class="empty">${MARK_REST}
      <b>No open position</b>
      The desk rests with you. Your active round shows here the moment you buy.
    </div>`;
  }
  const nudge = a.thesisMissing
    ? '<div class="nudge">No thesis on this entry — write one in the popup before the exit. Discipline is the asset.</div>'
    : '';
  return `
    <div class="card">
      <div class="sym">${esc(a.symbol || a.name || 'Token')}</div>
      <div class="meta">open ${esc(P.fmtSol(a.costSol))} · held ${esc(fmtHeld(a.heldMs))}</div>
      ${nudge}
    </div>`;
}

function afterHtml(rows) {
  if (!rows.length) {
    return `<div class="empty">${MARK_AFTER}
      <b>Nothing yet</b>
      Close a round and its After watch lands here — what the coin did after you left.
    </div>`;
  }
  return rows.map((r) => {
    const pnlCls = r.pnlSol > 0 ? 'pos' : (r.pnlSol < 0 ? 'neg' : '');
    const ran = r.maxPct >= 20
      ? `<span class="what amber">ran +${r.maxPct.toFixed(0)}% after you left</span>`
      : `<span class="what">didn't run (+${r.maxPct.toFixed(0)}% max)</span>`;
    return `
      <div class="row">
        <div>
          <span class="sym">${esc(r.symbol || 'Token')}</span>
          <span class="when">${esc(fmtAgo(Date.now() - r.closedAt))} ago</span>
        </div>
        <div class="right">
          <span class="pnl ${pnlCls}">${esc(P.fmtSol(r.pnlSol))}</span>
          ${ran}
        </div>
      </div>`;
  }).join('');
}

function tierLabelOf(n) {
  const T = (window.PTGamify && window.PTGamify.STREAK_TIERS) || [];
  let out = null;
  for (const t of T) if (n >= t.at) out = t;
  return out ? out.label : null;
}

function render(d) {
  const s = d.streaks;
  $('#chips').innerHTML = [
    chipHtml('journal', s.journal, tierLabelOf(s.journal.current)),
    chipHtml('clean exit', s.cleanExit, tierLabelOf(s.cleanExit.current)),
    chipHtml('no-revenge', s.noRevenge, tierLabelOf(s.noRevenge.current)),
  ].join('');
  $('#active').innerHTML = activeHtml(d.active);
  $('#after').innerHTML = afterHtml(d.after);
}

async function refresh() {
  const stored = await chrome.storage.local.get(['pt_state']);
  const state = stored.pt_state || {};
  const d = window.PTPanel.deskModel(state, window.PTGamify, Date.now());
  render(d);
}

$('#dash').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.pt_state) refresh();
});

refresh();
