/* Trench Wrapped — the monthly discipline recap (DELIGHT-MAP.md B1).
 *
 * Spotify Wrapped works because it reflects your OWN data back, formatted
 * for sharing, timed as an event. This is the PaperTrench version: a
 * monthly recap card derived entirely from the journal the dashboard
 * already holds — rounds, discipline letter, longest recovery, hold-time
 * symmetry, "the one that got away" (After data). Once a month, not a
 * notification stream.
 *
 * LAWS (carried from the grid, A1):
 *   - The monthly window is LOCAL calendar time of closedAt, never UTC.
 *   - The discipline letter is the WORST letter of the month (rounds DOWN
 *     on ties — a mixed month is never rounded up to the better story).
 *   - The payload NEVER carries a PnL figure. Money is not the story; the
 *     process is. (Same no-PnL law as the Spark card, A2.)
 *
 * Pure derivation: no DOM, no storage writes, no backend.
 */
(function () {
  'use strict';

  const GRADE_ORDER = ['S', 'A', 'B', 'C', 'D', 'F'];

  function num(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  /** Ints rank S=0 … F=5. Unknown letters rank worst (grid's law). */
  function gradeRank(letter) {
    const i = GRADE_ORDER.indexOf(String(letter || '').toUpperCase());
    return i === -1 ? GRADE_ORDER.length - 1 : i;
  }

  /** Local calendar month key: 'YYYY-MM'. */
  function monthKey(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  /**
   * Derive the Wrapped model for the month containing `now`.
   * @param {object} state    PT state (uses .rounds, newest-first like storage)
   * @param {object} gamify   window.PTGamify (roundGrade)
   * @param {Date}   now      injectable clock for tests
   * @returns {object|null} model, or null when the month has no closed rounds
   *   {
   *     month: 'YYYY-MM', monthName, year,
   *     rounds, gradedRounds,
   *     letter,            // worst letter of the month (rounds DOWN law)
   *     letterCounts,      // {S,A,B,C,D,F}
   *     journalRate,       // fraction of rounds with a written thesis
   *     longestRecovery,   // longest red->green span (days), or null
   *     holdSymmetry,      // {greenAvgMs, redAvgMs, ratio} or null
   *     oneThatGotAway,    // {symbol, maxPct} from After data, or null
   *     cleanExits,        // count of non-round-tripped exits
   *     noRevengeRounds,   // count of non-revenge rounds
   *   }
   */
  function derive(state, gamify, now) {
    const today = now instanceof Date ? now : new Date();
    const month = monthKey(today);
    const rounds = Array.isArray(state && state.rounds) ? state.rounds : [];

    const monthRounds = rounds.filter((r) => {
      if (!(Number(r && r.closedAt) > 0)) return false;
      return monthKey(new Date(r.closedAt)) === month;
    });
    if (!monthRounds.length) return null;

    // Discipline letter: worst letter wins (rounds DOWN law).
    const letterCounts = { S: 0, A: 0, B: 0, C: 0, D: 0, F: 0 };
    let worst = null;
    let graded = 0;
    let journaled = 0;
    let cleanExits = 0;
    let noRevenge = 0;
    const grades = [];
    for (const r of monthRounds) {
      const g = gamify && typeof gamify.roundGrade === 'function'
        ? gamify.roundGrade(state, r)
        : null;
      if (g && g.letter) {
        const L = String(g.letter).toUpperCase();
        letterCounts[L] = (letterCounts[L] || 0) + 1;
        grades.push(L);
        graded += 1;
        if (!worst || gradeRank(L) > gradeRank(worst)) worst = L;
      }
      // Journal rate: a thesis with substance (same rule as mastery).
      const t = r.thesis;
      const hasSubstance = (typeof t === 'string' && t.trim().length > 0)
        || (t && typeof t === 'object' && Boolean(
          (typeof t.text === 'string' && t.text.trim().length > 0)
          || (Array.isArray(t.tags) && t.tags.length > 0)
          || t.plan));
      if (hasSubstance) journaled += 1;
      // Clean exit: not a round-trip (verdict from roundGrade's exitQuality).
      if (g && g.verdict && g.verdict !== 'round-tripped') cleanExits += 1;
      // No revenge: not flagged by the grade.
      if (g && !g.parts.some((p) => p.id === 'revenge')) noRevenge += 1;
    }

    // Longest recovery: longest span (in days) from a red close to the next
    // green close, walking oldest->newest. A recovery is the discipline of
    // coming back; the span is calendar days between the two closes.
    const chrono = monthRounds.slice().reverse();
    let longestRecovery = null;
    let redAt = null;
    for (const r of chrono) {
      const pnl = num(r.pnlSol);
      const closed = num(r.closedAt);
      if (pnl === null || closed === null) continue;
      if (pnl < 0) {
        redAt = closed;
      } else if (pnl > 0 && redAt !== null) {
        const days = Math.max(1, Math.round((closed - redAt) / 86400000));
        if (!longestRecovery || days > longestRecovery.days) {
          longestRecovery = { days, from: redAt, to: closed };
        }
        redAt = null;
      }
    }

    // Hold-time symmetry: average hold of green rounds vs red rounds.
    let greenSum = 0, greenN = 0, redSum = 0, redN = 0;
    for (const r of monthRounds) {
      const pnl = num(r.pnlSol);
      const held = num(r.heldMs);
      if (pnl === null || held === null) continue;
      if (pnl > 0) { greenSum += held; greenN += 1; }
      else if (pnl < 0) { redSum += held; redN += 1; }
    }
    const greenAvgMs = greenN ? greenSum / greenN : null;
    const redAvgMs = redN ? redSum / redN : null;
    const holdSymmetry = (greenAvgMs !== null && redAvgMs !== null)
      ? { greenAvgMs, redAvgMs, ratio: greenAvgMs / redAvgMs }
      : null;

    // "The one that got away": the After feed's biggest maxPct after exit
    // this month — what the coin did after you left.
    let oneThatGotAway = null;
    for (const r of monthRounds) {
      const ae = r.afterExit;
      if (!ae) continue;
      const maxPct = num(ae.maxPct);
      if (maxPct === null) continue;
      if (!oneThatGotAway || maxPct > oneThatGotAway.maxPct) {
        oneThatGotAway = { symbol: r.symbol || '', maxPct };
      }
    }

    return {
      month,
      monthName: today.toLocaleString('en-US', { month: 'long' }),
      year: today.getFullYear(),
      rounds: monthRounds.length,
      gradedRounds: graded,
      letter: worst,
      letterCounts,
      journalRate: monthRounds.length ? journaled / monthRounds.length : 0,
      longestRecovery,
      holdSymmetry,
      oneThatGotAway,
      cleanExits,
      noRevengeRounds: noRevenge,
      // NO PNL FIELDS. Deliberately absent: pnlSol, profit, loss, roi.
    };
  }

  /** Month name for a 'YYYY-MM' key. */
  function monthNameOf(key) {
    const [y, m] = String(key || '').split('-').map(Number);
    if (!y || !m) return '';
    return new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'long' });
  }

  /** Format a duration (ms) as a compact human string: '2h 14m'. */
  function fmtDuration(ms) {
    const v = num(ms);
    if (v === null || v < 0) return '—';
    const mins = Math.round(v / 60000);
    if (mins < 60) return mins + 'm';
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? h + 'h ' + m + 'm' : h + 'h';
  }

  const api = { derive, gradeRank, monthKey, monthNameOf, fmtDuration, GRADE_ORDER };
  if (typeof window !== 'undefined') window.PTWrapped = api;
  if (typeof self !== 'undefined') self.PTWrapped = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();