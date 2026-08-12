/* PaperTrench server — window slicing.
 *
 * Every competitive mode in PaperTrench is the SAME committed chain viewed
 * through a different time window: the weekly Sprint is a UTC Monday-to-Monday
 * slice, a duel is a 24-hour slice, a season is the whole thing. Sharing this
 * math is not merely tidy — it is what makes the modes uncheatable as a set.
 * There is no second record to game, no per-mode book to inflate; a mode is a
 * question asked of evidence that already exists.
 *
 * The rule every window obeys: a round counts only if it OPENED and CLOSED
 * inside the window. A position carried in was decided before the window
 * existed, and a position carried out has no honest realized number yet.
 * Returns are measured against equity at the window's open, so a 10 SOL
 * bankroll and a 1,000 SOL bankroll compete on the same axis.
 */
'use strict';

const { walkCommitted, roundsFromChain, seasonScore, maxDrawdown, revengeRatio } =
  require('./ranking.js');

/** Cost basis still open after replaying `links` — the carried half of
 * window-start equity, on the same committed cash basis the rounds use. */
function openCostAfter(links) {
  return walkCommitted(links).openCost;
}

/**
 * One competitor's entry for one window, derived from their full chain.
 *
 * `window` is { startTs, endTs } plus any id the caller wants echoed back.
 */
function windowEntry(links, startingSol, window) {
  const list = Array.isArray(links) ? links : [];
  const before = list.filter((l) => Number(l.ts) < window.startTs);
  // Window-start equity from COMMITTED fields only (DEFECT L-06). The old
  // baseline replayed with replayChain, whose cash flow reads the unhashed
  // `amount` copy — so editing a pre-window link's uncommitted fields could
  // shrink the denominator of every Sprint, duel and clan return without
  // breaking a single digest. walkCommitted reads gross-out/net-in exactly
  // as the preimage commits them, and shares the sessionId-aware position
  // book, so a rekeyed carry-in position is priced into the baseline too.
  const baseline = walkCommitted(before);
  const equityAtStart = (Number(startingSol) || 0) + baseline.cashDelta + baseline.openCost;

  const rounds = roundsFromChain(list).filter((r) =>
    r.openedTs >= window.startTs && r.closedTs < window.endTs);
  const pnl = rounds.reduce((s, r) => s + r.pnlSol, 0);
  const wins = rounds.filter((r) => r.win).length;
  const roiPct = equityAtStart > 0 ? (pnl / equityAtStart) * 100 : 0;

  const entry = {
    rounds: rounds.length,
    wins,
    losses: rounds.length - wins,
    pnlSol: pnl,
    roiPct,
    equityAtStart,
    maxDrawdown: maxDrawdown(rounds, equityAtStart),
    revengeRatio: revengeRatio(rounds),
  };
  entry.score = seasonScore({
    roiPct, rounds: rounds.length,
    revengeRatio: entry.revengeRatio, maxDrawdown: entry.maxDrawdown,
  });
  return entry;
}

module.exports = { windowEntry, openCostAfter };
