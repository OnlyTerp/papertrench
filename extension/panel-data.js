/* Panel desk data (DELIGHT-MAP.md D1) — the pure half of the side panel.
 *
 * Assembles what the docked desk shows from state the extension already
 * stores: the live round card, streak chips (PTGamify), and the After
 * feed (rounds whose post-exit watch saw the coin run on without you).
 * No new storage, no permissions, no network — a read-only projection.
 *
 * The chrome-half (panel.js) owns storage reads and DOM; this module is
 * requireable so the desk assembly is unit-testable like every other PT
 * pure module.
 */
(function () {
  'use strict';

  /** SOL formatting shared with the dashboard's sidebar voice: 2dp here —
   *  the desk is glanceable, the dashboard is the precision surface. */
  function fmtSol(n) {
    const v = Number(n) || 0;
    const sign = v > 0 ? '+' : '';
    return sign + v.toFixed(2) + ' SOL';
  }

  /** Open cost basis of one position (popup.js grossOpenCostSol voice):
   *  what actually went in and is still at risk, not current mark. */
  function openCostSol(pos) {
    if (!pos) return 0;
    const invested = Number(pos.investedSol) || 0;
    const cost = Number(pos.costSol) || 0;
    const netInvested = Number(pos.netInvestedSol) || 0;
    if (netInvested > 0) return invested * (cost / netInvested);
    return invested;
  }

  /**
   * The active-round card: the freshest open position (max openedAt).
   * @returns {object|null} {mint, symbol, name, costSol, openedAt, heldMs,
   *   thesisMissing} — thesisMissing drives the nudge chip.
   */
  function activeRound(state, now) {
    const t = Number(now) || Date.now();
    let best = null;
    for (const p of Object.values((state && state.positions) || {})) {
      if (!p || !(Number(p.openedAt) > 0)) continue;
      if (!best || Number(p.openedAt) > Number(best.openedAt)) best = p;
    }
    if (!best) return null;
    const hasThesis = Boolean(best.thesis
      && (typeof best.thesis === 'object' || String(best.thesis).trim().length));
    return {
      mint: best.mint,
      symbol: best.symbol || '',
      name: best.name || '',
      costSol: openCostSol(best),
      openedAt: Number(best.openedAt),
      heldMs: Math.max(0, t - Number(best.openedAt)),
      thesisMissing: !hasThesis,
    };
  }

  /**
   * The After feed: recently CLOSED rounds with an afterExit observation —
   * what the coin did after you left. Newest first, newest 8.
   * afterExit arrives via engine.finalizePostWatches (maxPct/minPct vs
   * exit price); rounds without one are an honest gap and are skipped.
   * @returns {Array<{id,symbol,closedAt,pnlSol,leftPct,maxPct}>}
   */
  function afterFeed(state, limit) {
    const max = Math.max(1, Math.min(20, Number(limit) || 8));
    const rows = [];
    for (const r of (state && state.rounds) || []) {
      if (!(Number(r.closedAt) > 0) || !r.afterExit) continue;
      const ae = r.afterExit;
      rows.push({
        id: r.id,
        symbol: r.symbol || '',
        closedAt: Number(r.closedAt),
        pnlSol: Number(r.pnlSol) || 0,
        leftPct: Number(ae.maxPct) || 0,
        maxPct: Number(ae.maxPct) || 0,
        minPct: Number(ae.minPct) || 0,
      });
    }
    rows.sort((a, b) => b.closedAt - a.closedAt);
    return rows.slice(0, max);
  }

  /**
   * One-glance desk model. Chips surface the three PTGamify streak axes
   * with their tier labels; totals give the desk its header.
   */
  function deskModel(state, gamify, now) {
    const st = gamify && typeof gamify.streaks === 'function'
      ? gamify.streaks(state)
      : { journal: { current: 0, best: 0 }, cleanExit: { current: 0, best: 0 }, noRevenge: { current: 0, best: 0 } };
    return {
      active: activeRound(state, now),
      after: afterFeed(state),
      streaks: {
        journal: st.journal,
        cleanExit: st.cleanExit,
        noRevenge: st.noRevenge,
      },
      counts: {
        open: Object.keys((state && state.positions) || {}).length,
        rounds: ((state && state.rounds) || []).length,
      },
    };
  }

  const api = { deskModel, activeRound, afterFeed, openCostSol, fmtSol };
  if (typeof window !== 'undefined') window.PTPanel = api;
  if (typeof self !== 'undefined') self.PTPanel = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
