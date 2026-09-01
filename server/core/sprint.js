/* PaperTrench server — weekly Trench Sprint.
 *
 * One shared window (ISO week, UTC), one comparable number. A sprint entry is
 * NOT a separate wallet: it is the slice of a player's committed chain whose
 * rounds both opened and closed inside the window (window.js owns that math,
 * shared with duels). The same chain that backs the all-time record backs the
 * sprint, so there is nothing extra to forge or to trust.
 */
'use strict';

const { windowEntry } = require('./window.js');

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// Thursday 1970-01-01 was week 1 day 4; ISO weeks start Monday. 1970-01-05
// (the first Monday of the epoch) anchors the grid.
const FIRST_MONDAY_MS = 4 * 24 * 60 * 60 * 1000;

/** "2026-W32"-style id for the ISO week (UTC) containing ts. */
function weekIdOf(ts) {
  const d = new Date(Math.trunc(Number(ts) || 0));
  // ISO week-numbering year: shift to the Thursday of this week.
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / 86400000 + 1) / 7);
  return t.getUTCFullYear() + '-W' + String(week).padStart(2, '0');
}

/** [start, end) of the UTC Monday-to-Monday window containing ts. */
function windowOf(ts) {
  const t = Math.trunc(Number(ts) || 0);
  const sinceAnchor = t - FIRST_MONDAY_MS;
  const start = FIRST_MONDAY_MS + Math.floor(sinceAnchor / WEEK_MS) * WEEK_MS;
  return { weekId: weekIdOf(start), startTs: start, endTs: start + WEEK_MS };
}

/** A player's sprint entry for a window, from their full chain. */
function sprintEntry(links, startingSol, window) {
  return Object.assign({ weekId: window.weekId }, windowEntry(links, startingSol, window));
}

/**
 * The most recently CLOSED window — the one a crown can be settled for.
 *
 * Settlement never touches the open week. A crown handed out mid-week would
 * name a leader, not a winner, and would have to be revoked when somebody
 * passed them — so the only week that can be settled is one whose endTs is
 * already in the past.
 */
function lastClosedWindow(now) {
  const t = Math.trunc(Number(now) || 0);
  return windowOf(t - WEEK_MS);
}

/**
 * Is this window finished and therefore settleable?
 *
 * Exclusive on endTs for the same reason the board is: a fill landing exactly
 * on the boundary belongs to the NEXT window, so the week is not closed until
 * the clock is strictly past it.
 */
function isClosed(window, now) {
  return Boolean(window) && Math.trunc(Number(now) || 0) >= Number(window.endTs);
}

/**
 * Pick the crown from a week's ranked entries.
 *
 * Deliberately the SAME order the Sprint board renders (score desc, then the
 * earlier entry, then handle) — DEFECT L-05's lesson was that a board whose
 * selection order differs from its ranking order silently crowns the wrong
 * row. Reusing one comparator is what keeps "top of the board" and "who got
 * the crown" from ever disagreeing.
 *
 * Returns null when nobody qualified: a week with no eligible entry is left
 * uncrowned rather than awarded to the least-bad record.
 */
function crownFrom(entries) {
  const list = (Array.isArray(entries) ? entries : []).filter(
    (e) => e && Number(e.rounds) > 0);
  if (!list.length) return null;
  const best = list.slice().sort((a, b) =>
    (Number(b.score) || 0) - (Number(a.score) || 0)
    || (Number(a.updatedAt) || 0) - (Number(b.updatedAt) || 0)
    || String(a.handle || '').localeCompare(String(b.handle || '')))[0];
  return best || null;
}

module.exports = {
  WEEK_MS, weekIdOf, windowOf, sprintEntry,
  lastClosedWindow, isClosed, crownFrom,
};
