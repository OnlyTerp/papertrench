/* PaperTrench server — elimination tournaments.
 *
 * A tournament is a fixed-field race on an ISOLATED paper ledger: every
 * entrant starts on the same stack, the server folds round boundaries off
 * stored timestamps, and at each boundary the bottom N by tournament PnL are
 * eliminated until one name remains. Nothing here reads or writes the main
 * board's records — a tournament cannot borrow a lifetime record, and a bad
 * tournament cannot damage one.
 *
 * This module is pure: no D1, no fetch, no clock but the `now` it is handed.
 * The worker decides where bytes go; this decides what the numbers mean.
 *
 * ---------------------------------------------------------------------------
 * THE RULES THAT KEEP IT HONEST
 *
 * 1. PnL IS DERIVED, NEVER SUBMITTED. The extension pushes an equity figure
 *    (cash + marked positions); tournament PnL is equity minus the fixed
 *    start stack, computed here. A client that sends "pnl: 999" finds the
 *    field ignored — the only number that ranks is the one the server
 *    derived from the equity claim.
 *
 * 2. NO SNAPSHOT IS A NUMBER, NOT AN EXCUSE. An entrant who never pushes
 *    stands at exactly their start stack — PnL 0 — which is what the ledger
 *    can prove. The board labels them "no data yet" rather than printing a
 *    fabricated position list, but they rank like anyone else: a tournament
 *    that let silence dodge the cut would make not-playing the optimal
 *    strategy.
 *
 * 3. BOUNDARIES SETTLE ONCE. The worker writes a tournament_rounds row with
 *    the standings it cut from plus their hash, keyed (tournament_id,
 *    round_no) — a retried cron cannot re-cut a settled boundary, and the
 *    frozen standings are the evidence for every elimination.
 *
 * 4. THE LAST ROUND CROWNS, IT DOES NOT CUT. When the survivors number no
 *    more than the cut, eliminating them would leave nobody to win. That
 *    round is the final: it settles by ranking instead of cutting, and the
 *    prize split pays down that order.
 * ---------------------------------------------------------------------------
 */
'use strict';

const { blockedContent } = require('./clan.js');

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

/* ------------------------------ standings ------------------------------- */

/**
 * Rank entrants by tournament PnL, descending.
 *
 * `entrants`: rows with {user_id, handle, display_name, avatar_url, alive,
 *   eliminated_round, final_rank, joined_at}
 * `snapshots`: map user_id -> {equity_sol, cash_sol, positions_json, pushed_at}
 *
 * The order IS the elimination order, so it must be total and stable:
 * PnL desc, then the earlier join (seniority survives — a tie cannot be
 * resolved by re-joining), then handle, so two reads never disagree.
 */
function standings(entrants, snapshots, startStackSol) {
  const stack = Number(startStackSol) || 0;
  const rows = (Array.isArray(entrants) ? entrants : []).map((e) => {
    const snap = snapshots && snapshots.get ? snapshots.get(e.user_id) : null;
    const hasSnapshot = Boolean(snap) && Number.isFinite(Number(snap.equity_sol));
    const equity = hasSnapshot ? Number(snap.equity_sol) : stack;
    return {
      userId: e.user_id,
      handle: e.handle,
      displayName: e.display_name,
      avatarUrl: e.avatar_url,
      alive: Number(e.alive) === 1,
      eliminatedRound: e.eliminated_round == null ? null : Number(e.eliminated_round),
      finalRank: e.final_rank == null ? null : Number(e.final_rank),
      joinedAt: Number(e.joined_at) || 0,
      hasSnapshot,
      equitySol: equity,
      cashSol: snap && Number.isFinite(Number(snap.cash_sol)) ? Number(snap.cash_sol) : null,
      pnlSol: equity - stack,
      roiPct: stack > 0 ? ((equity - stack) / stack) * 100 : 0,
      positions: snap ? parsePositions(snap.positions_json) : [],
      pushedAt: snap ? Number(snap.pushed_at) || null : null,
    };
  });
  rows.sort((a, b) =>
    (b.pnlSol - a.pnlSol) ||
    (a.joinedAt - b.joinedAt) ||
    String(a.handle || '').localeCompare(String(b.handle || '')));
  return rows;
}

/** Positions as stored, back into an array — capped and shaped, never trusted. */
function parsePositions(raw) {
  if (!raw) return [];
  let list;
  try { list = JSON.parse(raw); } catch { return []; }
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_POSITIONS).map((p) => ({
    mint: String(p && p.mint || '').slice(0, 64),
    symbol: String(p && p.symbol || '').slice(0, 24),
    qty: Number(p && p.qty) || 0,
    valueSol: Number(p && p.valueSol) || 0,
  })).filter((p) => p.mint);
}

/* ------------------------------ snapshots ------------------------------- */

const MAX_POSITIONS = 50;
const MAX_EQUITY_SOL = 1e9; // a bound, not a target — above this the claim is noise

/**
 * Validate and sanitize one pushed snapshot. Returns { equitySol, cashSol,
 * positionsJson } or { problem }. The client's own PnL, timestamps, and rank
 * claims are dropped on the floor here — the server derives all three.
 */
function cleanSnapshot(body) {
  if (!body || typeof body !== 'object') return { problem: 'bad-body' };
  const equity = Number(body.equitySol);
  if (!Number.isFinite(equity) || equity < 0 || equity > MAX_EQUITY_SOL) {
    return { problem: 'bad-equity' };
  }
  const cash = Number(body.cashSol);
  const positions = Array.isArray(body.positions) ? body.positions.slice(0, MAX_POSITIONS) : [];
  const cleaned = [];
  for (const p of positions) {
    if (!p || typeof p !== 'object') continue;
    const mint = String(p.mint || '').slice(0, 64);
    if (!mint) continue;
    cleaned.push({
      mint,
      symbol: String(p.symbol || '').slice(0, 24),
      qty: Math.max(0, Number(p.qty) || 0),
      valueSol: Math.max(0, Number(p.valueSol) || 0),
    });
  }
  return {
    equitySol: equity,
    cashSol: Number.isFinite(cash) && cash >= 0 ? cash : null,
    positionsJson: JSON.stringify(cleaned),
  };
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
  NAME_MIN, NAME_MAX, PRIZE_SPLIT_DEFAULT, MAX_POSITIONS,
  STATUS,
  clampField, clampRoundMs, clampCut, clampStack,
  nameProblem, cleanName, cleanPrizeSplit,
  roundWindow, boundaryDue,
  standings, parsePositions, cleanSnapshot,
  boundaryPlan, finalPlacements, prizeAwards,
};
