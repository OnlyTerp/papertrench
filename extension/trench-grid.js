/* Trench Grid — the year-scale discipline heatmap (DELIGHT-MAP.md A1).
 *
 * One cell per LOCAL day of the current year, colored by the dominant
 * PROCESS grade of rounds closed that day — never P&L. Derives everything
 * from state (rounds) the dashboard already holds: no new storage, no
 * backend, no permission.
 *
 * Laws carried over from the calendar (D-49): days bucket by LOCAL time of
 * closedAt, never UTC. Ties round DOWN to the worse letter — a split day
 * is never rounded up to the better story (same tie law as renderCalendar).
 * Empty days render as empty cells, not zeros — an honest gap.
 */
(function () {
  'use strict';

  const GRADE_ORDER = ['S', 'A', 'B', 'C', 'D', 'F'];

  /** Ints rank S=0 … F=5. Unknown letters rank worst — can't happen via
   *  roundGrade, but a corrupt store must not flatter itself. */
  function gradeRank(letter) {
    const i = GRADE_ORDER.indexOf(String(letter || '').toUpperCase());
    return i === -1 ? GRADE_ORDER.length - 1 : i;
  }

  /**
   * Derive the year of cells for the Trench Grid.
   * @param {object} state  PT state (uses .rounds, newest-first like storage)
   * @param {object} gamify window.PTGamify (roundGrade, streaks)
   * @param {Date}   now    injectable clock for tests
   * @returns {object} { year, cells: [{date:'YYYY-MM-DD', grade, count,
   *   rounds, bestRun}], streak: {journal, cleanExit, noRevenge}, totals }
   *   cells[] is every day Jan 1 → today inclusive, oldest first.
   *   rounds[] inside a cell is the per-round letter list, oldest first.
   */
  function derive(state, gamify, now) {
    const today = now instanceof Date ? now : new Date();
    const year = today.getFullYear();
    const rounds = Array.isArray(state && state.rounds) ? state.rounds : [];

    // LOCAL day-key helper: the calendar's D-49 bucketing.
    const keyOf = (d) => d.getFullYear() + '-'
      + String(d.getMonth() + 1).padStart(2, '0') + '-'
      + String(d.getDate()).padStart(2, '0');

    // Seed every day of the year so empty days exist as honest gaps.
    // Walk CALENDAR days (setDate), not 24h ms-steps — a ms step lands at
    // 23:00 the previous day across a DST spring-forward and silently
    // drops/swaps a cell (caught by test: 73 vs 74).
    const cells = new Map();
    const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    for (let cur = new Date(year, 0, 1); cur <= end; cur.setDate(cur.getDate() + 1)) {
      const key = keyOf(cur);
      cells.set(key, { date: key, letters: [] });
    }

    let graded = 0;
    for (const r of rounds) {
      if (!(Number(r && r.closedAt) > 0)) continue;
      const d = new Date(r.closedAt);
      if (d.getFullYear() !== year) continue;
      const cell = cells.get(keyOf(d));
      if (!cell) continue;
      const g = gamify && typeof gamify.roundGrade === 'function'
        ? gamify.roundGrade(state, r)
        : null;
      if (!g || !g.letter) continue;
      // rounds storage is newest-first; unshift keeps cell lists oldest-first.
      cell.letters.unshift(g.letter);
      graded += 1;
    }

    // Dominant grade per day: worst letter wins ties (rounds DOWN law).
    // bestRun on a cell = the consecutive-graded-day run ENDING at that day
    // (0 on gap days); totals.bestRun keeps the year max.
    let bestRun = 0, run = 0;
    for (const cell of cells.values()) {
      if (cell.letters.length) {
        let worst = cell.letters[0];
        for (const L of cell.letters) if (gradeRank(L) > gradeRank(worst)) worst = L;
        cell.grade = worst;
        cell.count = cell.letters.length;
        run += 1;
        if (run > bestRun) bestRun = run;
        cell.bestRun = run;
      } else {
        cell.grade = null;
        cell.count = 0;
        run = 0;
        cell.bestRun = 0;
      }
      delete cell.letters;
    }

    const streak = gamify && typeof gamify.streaks === 'function'
      ? gamify.streaks(state)
      : { journal: { current: 0, best: 0 }, cleanExit: { current: 0, best: 0 }, noRevenge: { current: 0, best: 0 } };

    return {
      year,
      cells: [...cells.values()],
      streak,
      totals: { gradedDays: [...cells.values()].filter((c) => c.grade).length, gradedRounds: graded, bestRun },
    };
  }

  /** Class name for a cell — the palette lives in dashboard CSS (var tokens). */
  function cellClass(cell) {
    if (!cell || !cell.grade) return 'tg-cell tg-empty';
    return 'tg-cell tg-' + String(cell.grade).toLowerCase();
  }

  /** Month-start offset in a Mon-first grid, given the day-of-week of Jan 1. */
  function monthOffsets(year) {
    const offs = [];
    for (let m = 0; m < 12; m++) {
      const first = new Date(year, m, 1);
      offs.push((first.getDay() + 6) % 7); // Mon=0 … Sun=6
    }
    return offs;
  }

  const api = { derive, cellClass, gradeRank, monthOffsets, GRADE_ORDER };
  if (typeof window !== 'undefined') window.PTGrid = api;
  if (typeof self !== 'undefined') self.PTGrid = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
