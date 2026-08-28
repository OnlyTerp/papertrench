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

function fmtAgo(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h';
  return Math.floor(h / 24) + 'd';
}

function chipHtml(label, st, tierLabel) {
  const cur = st && st.current ? st.current : 0;
  const best = st && st.best ? st.best : 0;
  const tier = tierLabel ? ` · ${tierLabel}` : '';
  return `<span class="chip"><strong>${cur}</strong> ${label}${tier} <span style="opacity:0.55">(best ${best})</span></span>`;
}

function activeHtml(a) {
  if (!a) return '<div class="empty">No open position. The desk rests with you.</div>';
  const nudge = a.thesisMissing
    ? '<div class="nudge">No thesis on this entry — write one in the popup before the exit. Discipline is the asset.</div>'
    : '';
  return `
    <div class="card">
      <div class="sym">${a.symbol || a.name || 'Token'}</div>
      <div class="meta">open ${fmtSol(a.costSol)} · held ${fmtSol(a.heldMs).replace(' SOL', '')}</div>
      ${nudge}
    </div>`;
}

function afterHtml(rows) {
  if (!rows.length) {
    return '<div class="empty">Nothing yet. Close a round and its After watch lands here — what the coin did after you left.</div>';
  }
  return rows.map((r) => {
    const pnlCls = r.pnlSol > 0 ? 'pos' : (r.pnlSol < 0 ? 'neg' : '');
    const ran = r.maxPct >= 20
      ? `<span class="amber">ran +${r.maxPct.toFixed(0)}% after you left</span>`
      : `<span class="what">didn't run (+${r.maxPct.toFixed(0)}% max)</span>`;
    return `
      <div class="row">
        <div><span class="sym">${r.symbol || 'Token'}</span>
          <span class="what">· ${fmtAgo(Date.now() - r.closedAt)} ago</span></div>
        <div><span class="${pnlCls}">${P.fmtSol(r.pnlSol)}</span> ${ran}</div>
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
