/* PaperTrench server — ranking math.
 *
 * Doctrine (gamify.js): process over outcome. A raw-P&L board crowns whoever
 * hit one lottery ticket, which teaches exactly the wrong lesson. The score
 * here starts from ROI on the declared bankroll (the comparable number the
 * dashboard already shows), then weights it by sustained evidence (round
 * count, log-scaled) and by discipline signals that are derivable from the
 * committed fills alone — the chain records only fills, so every metric here
 * must be provable from fill timing and P&L, never from self-reported state.
 *
 * The formula is public and deterministic on purpose: an open-source
 * leaderboard with a secret score would invite exactly the distrust the hash
 * chain exists to remove.
 */
'use strict';

/** Re-entry into a mint this soon after closing it at a loss reads as
 * revenge — the chase pattern mastery.js flags locally. */
const REVENGE_WINDOW_MS = 10 * 60 * 1000;

/** Fewer closed rounds than this is a sample, not a record. */
const MIN_RANKED_ROUNDS = 5;

/**
 * The cash amount a fill actually COMMITTED to the hash chain.
 *
 * attest.js's preimage hashes exactly one money field per fill: gross on a
 * buy, net on a sell. Everything else a link carries — buy-side `solNet`,
 * `txCostSol`, and the convenience `amount` copy — is stored but NOT hashed,
 * so all three can be edited to any value while every link still re-hashes
 * and the chain still verifies.
 *
 * The extension replays with those fields because a user has no reason to
 * lie to themselves. A leaderboard does: shrinking a buy's uncommitted
 * `solNet` toward zero drives the cost basis to nothing and inflates the
 * reported return without limit. So the ranked book is built only from what
 * the chain proves.
 *
 * That is also the more honest measure: gross out on a buy and net in on a
 * sell is the cash that genuinely left and entered the wallet, fees included.
 */
function committedAmount(link) {
  const value = link.side === 'buy' ? link.solGross : link.solNet;
  return Number(value) || 0;
}

/**
 * The lowest the wallet's cash ever got while replaying the chain.
 *
 * The declared starting bankroll is the denominator of ROI and the one input
 * the chain cannot prove — but it is not entirely unconstrained, because you
 * cannot spend SOL you never had. Replaying the committed cash flows from the
 * declared balance and watching for a negative gives a hard floor: a chain
 * whose buys total 4 SOL is proof the declarer started with at least 4, no
 * matter what number they typed.
 *
 * Committed amounts only, so the floor cannot be dodged by editing the fields
 * the preimage does not cover.
 */
function minCashDuringReplay(links, startingSol) {
  let cash = Number(startingSol) || 0;
  let lowest = cash;
  for (const link of Array.isArray(links) ? links : []) {
    const qty = Number(link.qty) || 0;
    const price = Number(link.priceNative) || 0;
    if (!(qty > 0) || !(price > 0)) continue;
    cash += link.side === 'buy' ? -committedAmount(link) : committedAmount(link);
    if (cash < lowest) lowest = cash;
  }
  return lowest;
}

/**
 * One walk over the chain on the committed cash basis: closed rounds, the
 * cost basis still open at the end, and the net committed cash flow.
 *
 * Positions are found by sessionId FIRST, mint second — the same priority
 * the engine's tradeInRound uses, for the same reason (DEFECT L-02). The
 * sessionId is hash-committed on every link (field four of the preimage) and
 * survives a rekeyMint rename (F-51): a fresh-launch buy is committed under
 * the PAIR stand-in address while the sells that close it are committed
 * under the real mint, so a walk that matches by mint alone silently drops
 * the exit — the round never closes, the board's round count and win rate
 * understate exactly the traders this product is for, and a five-round
 * record can read as unrankable. Safe to trust because the sessionId is
 * inside the preimage: editing it breaks the digest like editing the mint
 * would. Chains that predate sessionIds fall back to mint intact.
 */
function walkCommitted(links) {
  const list = Array.isArray(links) ? links : [];
  const bySession = new Map(); // sessionId -> held bag
  const byMint = new Map();    // mint -> held bag
  const open = new Set();      // distinct open bags
  const rounds = [];
  let cashDelta = 0;

  const sessionOf = (link) =>
    (typeof link.sessionId === 'string' && link.sessionId ? link.sessionId : null);
  const findHeld = (link) => {
    const sid = sessionOf(link);
    if (sid && bySession.has(sid)) return bySession.get(sid);
    return byMint.get(link.mint) || null;
  };
  const adopt = (link, held) => {
    const sid = sessionOf(link);
    if (sid && bySession.get(sid) !== held) {
      held.sessions.push(sid);
      bySession.set(sid, held);
    }
    if (byMint.get(link.mint) !== held) {
      held.mints.push(link.mint);
      byMint.set(link.mint, held);
    }
  };
  const drop = (held) => {
    open.delete(held);
    for (const sid of held.sessions) if (bySession.get(sid) === held) bySession.delete(sid);
    for (const mint of held.mints) if (byMint.get(mint) === held) byMint.delete(mint);
  };

  for (const link of list) {
    const qty = Number(link.qty) || 0;
    const price = Number(link.priceNative) || 0;
    const amount = committedAmount(link);
    if (!(qty > 0) || !(price > 0)) continue;

    if (link.side === 'buy') {
      cashDelta -= amount;
      let held = findHeld(link);
      if (!held) {
        held = { qty: 0, cost: 0, openedTs: Number(link.ts) || 0,
                 realized: 0, costOut: 0, sessions: [], mints: [] };
        open.add(held);
      }
      if (held.qty <= 0) held.openedTs = Number(link.ts) || 0;
      held.qty += qty;
      held.cost += amount;
      adopt(link, held);
    } else if (link.side === 'sell') {
      const held = findHeld(link);
      if (!held || held.qty <= 0) continue;
      // Remember the sell's identifiers too: after a rekey the position's
      // remaining fills may arrive under either label.
      adopt(link, held);
      const share = Math.min(1, qty / held.qty);
      const costOut = held.cost * share;
      cashDelta += amount;
      held.qty -= qty;
      held.cost -= costOut;
      // Every leg accumulates. Scaling out is the disciplined exit this
      // product teaches, and booking only the FINAL leg's P&L understated the
      // round by every take-profit before it — which made the board's realized
      // P&L, ROI and win rate disagree with replayChain for exactly the
      // traders behaving best.
      held.realized += amount - costOut;
      held.costOut += costOut > 0 ? costOut : 0;
      if (held.qty <= 1e-12) {
        rounds.push({
          mint: String(link.mint),
          openedTs: held.openedTs,
          closedTs: Number(link.ts) || 0,
          costIn: held.costOut,
          pnlSol: held.realized,
          win: held.realized > 0,
        });
        drop(held);
      }
    }
  }

  let openCost = 0;
  for (const held of open) openCost += held.cost;
  return { rounds, openCost, cashDelta };
}

/**
 * Reconstruct closed rounds from chain links.
 *
 * A round is a position going flat, carrying entry/exit times, cost in, and
 * realized P&L — all on the committed cash basis above.
 */
function roundsFromChain(links) {
  return walkCommitted(links).rounds;
}

/** Largest peak-to-trough drop of the realized-equity curve, as a fraction
 * of the peak. 0 = never gave anything back. */
function maxDrawdown(rounds, startingSol) {
  let equity = Number(startingSol) > 0 ? Number(startingSol) : 0;
  if (!(equity > 0)) return 0;
  let peak = equity;
  let worst = 0;
  for (const r of rounds) {
    equity += r.pnlSol;
    if (equity > peak) peak = equity;
    else if (peak > 0) worst = Math.max(worst, (peak - equity) / peak);
  }
  return worst;
}

/** Fraction of losing rounds that were followed by re-entering the same mint
 * inside the revenge window. Derivable purely from fill times. */
function revengeRatio(rounds) {
  const losses = rounds.filter((r) => !r.win);
  if (!losses.length) return 0;
  let revenged = 0;
  for (const loss of losses) {
    const again = rounds.find((r) =>
      r.mint === loss.mint &&
      r.openedTs > loss.closedTs &&
      r.openedTs - loss.closedTs <= REVENGE_WINDOW_MS);
    if (again) revenged++;
  }
  return revenged / losses.length;
}

/**
 * The season score.
 *
 *   score = roiPct × ln(1 + rounds) × discipline
 *
 * ROI is the outcome; ln(1+rounds) rewards showing up repeatedly without
 * letting volume swamp skill; discipline (1 − ½·revengeRatio − ¼·drawdown)
 * discounts tilt and giving winnings back. A negative ROI sustained over many
 * rounds scores below a briefly negative one — sustained losing should sink,
 * not hide.
 */
function seasonScore(stats) {
  const roiPct = Number(stats.roiPct) || 0;
  const rounds = Math.max(0, Number(stats.rounds) || 0);
  const discipline = Math.max(0.25,
    1 - 0.5 * (Number(stats.revengeRatio) || 0) - 0.25 * (Number(stats.maxDrawdown) || 0));
  return roiPct * Math.log(1 + rounds) * discipline;
}

/** Everything the board shows for one record, from chain + declared start. */
function recordStats(links, startingSol) {
  const rounds = roundsFromChain(links);
  const wins = rounds.filter((r) => r.win).length;
  const pnl = rounds.reduce((s, r) => s + r.pnlSol, 0);
  const start = Number(startingSol) || 0;
  const roiPct = start > 0 ? (pnl / start) * 100 : 0;
  const perRound = rounds.filter((r) => r.costIn > 0);
  const expectancy = perRound.length
    ? perRound.reduce((s, r) => s + r.pnlSol / r.costIn, 0) / perRound.length
    : 0;
  const stats = {
    rounds: rounds.length,
    wins,
    losses: rounds.length - wins,
    winRate: rounds.length ? wins / rounds.length : 0,
    realizedPnlSol: pnl,
    roiPct,
    expectancy,
    maxDrawdown: maxDrawdown(rounds, start),
    revengeRatio: revengeRatio(rounds),
    rankable: rounds.length >= MIN_RANKED_ROUNDS,
  };
  stats.score = seasonScore(stats);
  return stats;
}

module.exports = {
  REVENGE_WINDOW_MS, MIN_RANKED_ROUNDS,
  committedAmount, minCashDuringReplay, walkCommitted, roundsFromChain,
  maxDrawdown, revengeRatio, seasonScore, recordStats,
};
