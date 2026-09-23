/* PaperTrench server — elimination tournaments.
 *
 * A tournament is a fixed-field race through windows of the same verified
 * chain used by the other boards. The common stack scales displayed P&L; each
 * cut ranks window ROI, and no client equity claim enters the result. The
 * worker reads records and chain segments but never mutates the main record.
 *
 * This module is pure: no D1, no fetch, no clock but the `now` it is handed.
 * The worker decides where bytes go; this decides what the numbers mean.
 *
 * ---------------------------------------------------------------------------
 * THE RULES THAT KEEP IT HONEST
 *
 * 1. PnL IS DERIVED, NEVER SUBMITTED. Each entry is a windowEntry over a
 *    server-stored chain whose fills all passed independent re-pricing. A
 *    client equity or PnL claim never reaches the standings.
 *
 * 2. OPEN BAGS ARE MARKED AT THE BELL. Positions opened inside the window
 *    and still open at its end use the token and SOL/USD candle ranges for
 *    that boundary minute. Missing candles mean gross cost and an explicit
 *    unpriced flag, never a client mark or an invented price.
 *
 * 3. FINAL MEANS POST-CLOSE AND VERIFIED. A cut waits through its grace
 *    period. Only a verified chain submitted at or after the boundary is
 *    final for that cut; everyone else ranks below final entries by their
 *    latest verified provisional return and is marked forfeited.
 *
 * 4. BOUNDARIES SETTLE ONCE. The worker writes a tournament_rounds row with
 *    the standings it cut from plus their hash, keyed (tournament_id,
 *    round_no) — a retried cron cannot re-cut a settled boundary, and the
 *    frozen standings are the evidence for every elimination.
 *
 * 5. THE LAST ROUND CROWNS, IT DOES NOT CUT. When the survivors number no
 *    more than the cut, eliminating them would leave nobody to win. That
 *    round is the final: it settles by ranking instead of cutting, and the
 *    prize split pays down that order.
 * ---------------------------------------------------------------------------
 */
'use strict';

const { blockedContent } = require('./clan.js');
const { windowEntry } = require('./window.js');
const { walkCommitted } = require('./ranking.js');
const { minuteOf, nativePriceRangeFromCandles } = require('./pricing.js');

/* ------------------------------ parameters ------------------------------ */

const FIELD_MIN = 4;    // below this there is no bracket, just a queue
const FIELD_MAX = 250;  // payload + sanity bound; default field is 25
const FIELD_DEFAULT = 25;

const ROUND_MIN_MS = 60 * 60 * 1000;            // 1 hour
const ROUND_MAX_MS = 7 * 24 * 60 * 60 * 1000;   // 1 week
const ROUND_DEFAULT_MS = 24 * 60 * 60 * 1000;   // CEO-locked default: 24h

const CUT_MIN = 1;
const CUT_DEFAULT = 5;                          // CEO-locked default: bottom 5

const STACK_MIN = 0.1;
const STACK_MAX = 10000;
const STACK_DEFAULT = 10;                       // CEO-locked default: 10 ◎

const NAME_MIN = 3;
const NAME_MAX = 60;

/** Default prize split, top-down percents. CEO-locked 50/30/20. */
const PRIZE_SPLIT_DEFAULT = [50, 30, 20];

const STATUS = { OPEN: 'open', LIVE: 'live', DONE: 'done', CANCELLED: 'cancelled' };
const SETTLE_GRACE_MS = 15 * 60 * 1000;

/* ------------------------------ validation ------------------------------ */

function clampInt(value, min, max, fallback) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampField(value) { return clampInt(value, FIELD_MIN, FIELD_MAX, FIELD_DEFAULT); }
function clampRoundMs(value) { return clampInt(value, ROUND_MIN_MS, ROUND_MAX_MS, ROUND_DEFAULT_MS); }
function clampCut(value) { return clampInt(value, CUT_MIN, FIELD_MAX - 1, CUT_DEFAULT); }
function clampStack(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return STACK_DEFAULT;
  return Math.min(STACK_MAX, Math.max(STACK_MIN, n));
}

/** A tournament name, or the reason it cannot be used. */
function nameProblem(raw) {
  const name = String(raw == null ? '' : raw).trim().replace(/\s+/g, ' ');
  if (name.length < NAME_MIN) return 'name-too-short';
  if (name.length > NAME_MAX) return 'name-too-long';
  if (blockedContent(name)) return 'name-blocked';
  return null;
}
function cleanName(raw) {
  return String(raw == null ? '' : raw).trim().replace(/\s+/g, ' ').slice(0, NAME_MAX);
}

/**
 * A prize split as stored: an array of percents, top-down, summing to 100.
 * Anything else falls back to the default rather than failing creation —
 * the split is presentation, not mechanism, and a malformed one must not
 * block a tournament.
 */
function cleanPrizeSplit(raw) {
  if (!Array.isArray(raw) || !raw.length) return PRIZE_SPLIT_DEFAULT.slice();
  const parts = raw.slice(0, 10).map((n) => Math.trunc(Number(n)));
  if (parts.some((n) => !Number.isFinite(n) || n <= 0)) return PRIZE_SPLIT_DEFAULT.slice();
  const total = parts.reduce((a, b) => a + b, 0);
  if (total !== 100) return PRIZE_SPLIT_DEFAULT.slice();
  return parts;
}

/* ------------------------------ clock ----------------------------------- */

/**
 * The [start, end) of round `roundNo` (1-indexed). Boundaries fold off the
 * stored start_ts and round_ms — never off "when the last round happened to
 * settle" — so a stalled cron compresses the schedule it owes, it does not
 * drift it. A boundary that fired late still ends where it always ended.
 */
function roundWindow(tournament, roundNo) {
  const start = Number(tournament.start_ts) + (roundNo - 1) * Number(tournament.round_ms);
  return { startTs: start, endTs: start + Number(tournament.round_ms) };
}

/** Is round `roundNo`'s boundary due (or overdue) at `now`? */
function boundaryDue(tournament, roundNo, now) {
  return Math.trunc(Number(now) || 0) >= roundWindow(tournament, roundNo).endTs;
}

/** Settlement waits for the post-boundary verified-chain grace window. */
function settlementDue(tournament, roundNo, now) {
  return Math.trunc(Number(now) || 0)
    >= roundWindow(tournament, roundNo).endTs + SETTLE_GRACE_MS;
}

/** Only a verified chain received on or after the boundary can be final. */
function finalForBoundary(status, submittedAt, boundaryTs) {
  return status === 'verified' && Number(submittedAt) >= Number(boundaryTs);
}

/** The closed-round window result plus its open, in-window bags at a bell. */
function entryForWindow(links, startingSol, window, startStackSol) {
  const endTs = Number(window && window.endTs) || 0;
  const startTs = Number(window && window.startTs) || 0;
  const slice = (Array.isArray(links) ? links : []).filter((link) => Number(link.ts) < endTs);
  const entry = windowEntry(slice, startingSol, { startTs, endTs });
  const openPositions = walkCommitted(slice).openPositions
    .filter((position) => position.openedTs >= startTs)
    .map((position) => ({ ...position }));
  return {
    ...entry,
    basePnlSol: entry.pnlSol,
    startStackSol: Number(startStackSol) || 0,
    windowStartTs: startTs,
    windowEndTs: endTs,
    openPositions,
  };
}

/**
 * Apply the tournament's one open-position rule at a boundary: use the
 * independent token/SOL candle range's midpoint; if either candle is absent
 * or unavailable, keep gross remaining cost as value (zero open P&L) and flag it.
 */
async function markOpenAtBell(entry, boundaryTs, startStackSol, getCandles) {
  const source = entry || {};
  const at = Math.trunc(Number(boundaryTs) || 0);
  const minuteTs = minuteOf(at);
  const candlesByKey = new Map();
  const marked = [];
  let openPnlSol = 0;
  let unpricedOpenPosition = false;
  let lookupFailed = false;

  for (const position of Array.isArray(source.openPositions) ? source.openPositions : []) {
    const mint = String(position.mint || '');
    const chain = String(position.chain || 'solana');
    const qty = Math.max(0, Number(position.qty) || 0);
    const costSol = Math.max(0, Number(position.costSol) || 0);
    const key = chain + '|' + mint + '|' + minuteTs;
    if (!candlesByKey.has(key)) {
      let candles = null;
      if (!lookupFailed && typeof getCandles === 'function') {
        try { candles = await getCandles(mint, minuteTs, chain); }
        catch { lookupFailed = true; }
      }
      candlesByKey.set(key, candles);
    }
    const range = nativePriceRangeFromCandles(candlesByKey.get(key));
    if (!range || !(qty > 0) || !mint) {
      unpricedOpenPosition = true;
      marked.push({
        ...position, valueSol: costSol, pnlSol: 0,
        priceNative: null, unpriced: true,
      });
      continue;
    }
    const priceNative = (range.low + range.high) / 2;
    const valueSol = qty * priceNative;
    const pnlSol = valueSol - costSol;
    openPnlSol += pnlSol;
    marked.push({ ...position, valueSol, pnlSol, priceNative, unpriced: false });
  }

  const basePnlSol = Number(source.basePnlSol ?? source.pnlSol) || 0;
  const pnlSol = basePnlSol + openPnlSol;
  const equityAtStart = Number(source.equityAtStart) || 0;
  const roiPct = equityAtStart > 0 ? (pnlSol / equityAtStart) * 100 : 0;
  const stack = Number(startStackSol ?? source.startStackSol) || 0;
  return {
    ...source,
    pnlSol,
    roiPct,
    pnlOnStackSol: (roiPct / 100) * stack,
    openPnlSol,
    openPositions: marked,
    unpricedOpenPosition,
    markTs: at,
  };
}

/* ------------------------------ standings ------------------------------- */

/**
 * Rank verified tournament entries. `entries` maps user_id to
 * { verified, final, submittedAt, entry }; no client amount participates.
 * At a settled cut final records rank before forfeits, then ROI breaks ties
 * within each group. Seniority and handle make the order total and stable.
 */
function standings(entrants, entries, startStackSol, options) {
  const stack = Number(startStackSol) || 0;
  const settled = Boolean(options && options.settled);
  const rows = (Array.isArray(entrants) ? entrants : []).map((entrant) => {
    const source = entries && entries.get ? entries.get(entrant.user_id) : null;
    const entry = source && source.verified !== false && source.entry ? source.entry : null;
    const final = settled && Boolean(source && source.final);
    const finality = settled
      ? (final ? 'final' : 'forfeited')
      : (source && source.finality === 'forfeited' ? 'forfeited' : 'provisional');
    const roiPct = entry && Number.isFinite(Number(entry.roiPct)) ? Number(entry.roiPct) : 0;
    const pnlOnStackSol = (roiPct / 100) * stack;
    return {
      userId: entrant.user_id,
      handle: entrant.handle,
      displayName: entrant.display_name,
      avatarUrl: entrant.avatar_url,
      alive: Number(entrant.alive) === 1,
      eliminatedRound: entrant.eliminated_round == null ? null : Number(entrant.eliminated_round),
      finalRank: entrant.final_rank == null ? null : Number(entrant.final_rank),
      joinedAt: Number(entrant.joined_at) || 0,
      verified: Boolean(entry),
      recordStatus: source && source.recordStatus || (entry ? 'verified' : 'pending'),
      submittedAt: source && Number(source.submittedAt) || null,
      rounds: entry ? Number(entry.rounds) || 0 : 0,
      pnlSol: entry ? Number(entry.pnlSol) || 0 : 0,
      roiPct,
      pnlOnStackSol,
      equityAtStart: entry ? Number(entry.equityAtStart) || 0 : null,
      unpricedOpenPosition: Boolean(entry && entry.unpricedOpenPosition),
      openPositions: entry && Array.isArray(entry.openPositions) ? entry.openPositions : [],
      final,
      provisional: finality === 'provisional',
      forfeited: finality === 'forfeited',
      finality,
    };
  });
  rows.sort((a, b) => {
    if (settled && a.final !== b.final) return a.final ? -1 : 1;
    if (!settled && a.alive !== b.alive) return a.alive ? -1 : 1;
    return (b.roiPct - a.roiPct) ||
      (a.joinedAt - b.joinedAt) ||
      String(a.handle || '').localeCompare(String(b.handle || ''));
  });
  return rows;
}

/* ------------------------------ settlement ------------------------------ */

/**
 * What a due boundary does to the field.
 *
 * `aliveCount` survivors, `cut` per round:
 *   aliveCount > cut  → eliminate the `cut` lowest-ranked rows.
 *   aliveCount <= cut → the round is the final: nobody is cut, the standing
 *                       order becomes the final placement, and the prize
 *                       split pays down it. A tournament that cut its last
 *                       five would crown nobody — the final round exists so
 *                       the bracket always ends with a winner.
 */
function boundaryPlan(standingRows, cut) {
  const alive = standingRows.filter((r) => r.alive);
  if (alive.length <= Math.max(1, Number(cut) || 1)) {
    return { final: true, eliminated: [], placements: alive };
  }
  const cutCount = Math.max(1, Number(cut) || 1);
  return {
    final: false,
    eliminated: alive.slice(alive.length - cutCount),
    placements: [],
  };
}

/**
 * Final placements for a settled tournament: the ranked survivors take
 * places 1..N, then the eliminated fill in below them by the round they fell
 * (later rounds place higher) and their PnL at elimination. Deterministic —
 * the same inputs always produce the same final board.
 */
function finalPlacements(standingRows, eliminations) {
  const alive = standingRows.filter((r) => r.alive);
  const out = alive.map((r, i) => ({ userId: r.user_id || r.userId, rank: i + 1 }));
  const elims = (Array.isArray(eliminations) ? eliminations : []).slice().sort((a, b) =>
    (Number(b.round_no) - Number(a.round_no)) ||
    (Number(b.pnl_sol) - Number(a.pnl_sol)) ||
    (Number(a.user_id) - Number(b.user_id)));
  let rank = alive.length + 1;
  for (const e of elims) out.push({ userId: e.user_id, rank: rank++ });
  return out;
}

/** Prize awards down the final order: split[i] percent of the pool to rank i+1. */
function prizeAwards(split, placements, poolSol) {
  const parts = Array.isArray(split) && split.length ? split : PRIZE_SPLIT_DEFAULT;
  const pool = Number(poolSol);
  if (!Number.isFinite(pool) || pool <= 0) return [];
  const byRank = new Map();
  for (const p of placements || []) byRank.set(p.rank, p.userId);
  const awards = [];
  for (let i = 0; i < parts.length; i++) {
    const userId = byRank.get(i + 1);
    if (userId == null) break; // fewer finishers than prize places — honest absence
    awards.push({ rank: i + 1, userId, pct: parts[i], amountSol: (pool * parts[i]) / 100 });
  }
  return awards;
}

module.exports = {
  FIELD_MIN, FIELD_MAX, FIELD_DEFAULT,
  ROUND_MIN_MS, ROUND_MAX_MS, ROUND_DEFAULT_MS,
  CUT_MIN, CUT_DEFAULT,
  STACK_MIN, STACK_MAX, STACK_DEFAULT,
  NAME_MIN, NAME_MAX, PRIZE_SPLIT_DEFAULT,
  STATUS, SETTLE_GRACE_MS,
  clampField, clampRoundMs, clampCut, clampStack,
  nameProblem, cleanName, cleanPrizeSplit,
  roundWindow, boundaryDue, settlementDue, finalForBoundary,
  entryForWindow, markOpenAtBell, standings,
  boundaryPlan, finalPlacements, prizeAwards,
};
