/* P&L calendar — the daily performance view.
 *
 * The contract Axiom/Padre/GMGN popularized: realized results bucketed by
 * LOCAL calendar day (their APIs take the browser's timezone offset), buy and
 * sell counts per day, weekly totals, and win/loss day tallies.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../engine.js');

function sell(ts, pnlSol, symbol, solGross = 1) {
  return { ts, side: 'sell', pnlSol, symbol, solGross, solNet: solGross * 0.99 };
}
function buy(ts, symbol, solGross = 1) {
  return { ts, side: 'buy', symbol, solGross, solNet: solGross * 0.99 };
}
const stateWith = (journal, positions = {}) => ({
  version: 1, cashSol: 10, startedAt: 0, positions, rounds: [], journal,
  stats: { totalBuys: 0, totalSells: 0, realizedPnlSol: 0, feesPaidSol: 0 },
});

// Local-time timestamps, so the bucketing is timezone-stable in tests.
const at = (y, m, d, h = 12) => new Date(y, m, d, h).getTime();

test('realized P&L lands on the local day of each sell', () => {
  const state = stateWith([
    buy(at(2026, 7, 3), 'BONK'),
    sell(at(2026, 7, 3, 18), 0.4, 'BONK'),
    sell(at(2026, 7, 3, 20), 0.1, 'BONK'),
    sell(at(2026, 7, 4), -0.25, 'AORA'),
    // Next month and next year entries must not leak in.
    sell(at(2026, 8, 1), 5, 'LATE'),
    sell(at(2025, 7, 3), 5, 'EARLY'),
  ]);

  const cal = E.pnlCalendar(state, 2026, 7); // August 2026
  assert.equal(cal.days.length, 31);
  assert.equal(cal.days[2].realizedSol, 0.5, 'both Aug 3 sells sum onto Aug 3');
  assert.equal(cal.days[2].sells, 2);
  assert.equal(cal.days[2].buys, 1);
  assert.equal(cal.days[2].volumeBuySol, 1);
  assert.equal(cal.days[2].symbols.BONK, 0.5);
  assert.equal(cal.days[3].realizedSol, -0.25);
  assert.equal(cal.days[4].hasTrades, false, 'untouched days stay empty');

  const t = cal.totals;
  assert.equal(t.realizedSol, 0.25);
  assert.equal(t.winDays, 1);
  assert.equal(t.lossDays, 1);
  assert.equal(t.tradeDays, 2);
  assert.deepEqual(t.bestDay, { day: 3, pnlSol: 0.5 });
  assert.deepEqual(t.worstDay, { day: 4, pnlSol: -0.25 });
});

test('a buy-only day is a flat trade day with no realized result', () => {
  const state = stateWith([buy(at(2026, 7, 10), 'BONK', 2)]);
  const cal = E.pnlCalendar(state, 2026, 7);

  const cell = cal.days[9];
  assert.equal(cell.hasTrades, true);
  assert.equal(cell.sells, 0);
  assert.equal(cell.realizedSol, 0);
  assert.equal(cell.volumeBuySol, 2);
  assert.equal(cal.totals.tradeDays, 1);
  assert.equal(cal.totals.flatDays, 1, 'trades happened but nothing was realized');
  assert.equal(cal.totals.winDays, 0);
  assert.equal(cal.totals.bestDay, null, 'no sell day means no best day');
});

test('weeks are Monday-start rows with weekly totals', () => {
  // August 2026 starts on a Saturday, so week 1 has two leading blanks and
  // only days 1 (Sat) and 2 (Sun); days 3..9 form the first full week.
  const state = stateWith([
    sell(at(2026, 7, 1), 0.1, 'A'),
    sell(at(2026, 7, 3), 0.3, 'A'),
    sell(at(2026, 7, 9), 0.6, 'A'),
    sell(at(2026, 7, 12), -0.2, 'A'),
  ]);
  const cal = E.pnlCalendar(state, 2026, 7);

  assert.equal(cal.weeks[0].days[0], undefined, 'Monday before the 1st is blank');
  assert.equal(cal.weeks[0].days[4], undefined, 'Friday before the 1st is blank');
  assert.equal(cal.weeks[0].days[5].day, 1);
  assert.equal(cal.weeks[0].days[6].day, 2);
  // Holes (bare new Array) would pass the undefined checks but are skipped
  // by .map() in the renderer, shifting every cell left. Blanks must be real.
  assert.equal(Object.keys(cal.weeks[0].days).length, 7, 'blank cells must be real array elements, not holes');
  assert.equal(cal.weeks[0].totalSol, 0.1);

  assert.ok(Math.abs(cal.weeks[1].totalSol - 0.9) < 1e-9, 'full Mon–Sun week sums its days');
  assert.ok(Math.abs(cal.weeks[2].totalSol - (-0.2)) < 1e-9);
  assert.equal(cal.weeks[1].hasTrades, true);
});

test('open unrealized and the today marker only apply to the current month', () => {
  const now = at(2026, 7, 15);
  const positions = {
    Mint1: { mint: 'Mint1', qty: 100, costSol: 1, investedSol: 1, netInvestedSol: 1, lastPriceNative: 0.012 },
    Mint2: { mint: 'Mint2', qty: 50, costSol: 1, investedSol: 1, netInvestedSol: 1, lastPriceNative: 0.01 },
  };
  const state = stateWith([sell(at(2026, 7, 15), 0.2, 'A')], positions);

  const current = E.pnlCalendar(state, 2026, 7, { now });
  assert.equal(current.todayDay, 15);
  // Mint1: 100*0.012-1 = +0.2 ; Mint2: 50*0.01-1 = -0.5 → -0.3
  assert.ok(Math.abs(current.openPnlSol - (-0.3)) < 1e-9);

  const other = E.pnlCalendar(state, 2026, 6, { now });
  assert.equal(other.todayDay, null, 'a different month has no today marker');
});

test('calendar range spans the journal, collapsing to this month when empty', () => {
  const state = stateWith([
    buy(at(2026, 5, 20), 'A'),
    sell(at(2026, 7, 3), 0.1, 'A'),
  ]);
  const range = E.pnlCalendarRange(state);
  const now = new Date();
  assert.deepEqual(range.min, { year: 2026, month: 5 });
  assert.deepEqual(range.max, { year: now.getFullYear(), month: now.getMonth() });

  const empty = E.pnlCalendarRange(stateWith([]));
  assert.deepEqual(empty.min, empty.max, 'no fills means a single-month range');
});

test('malformed journal entries cannot break the grid', () => {
  const state = stateWith([
    { ts: 'not-a-number', side: 'sell', pnlSol: 1 },
    { side: 'sell', pnlSol: 1 },
    sell(at(2026, 7, 2), 0.5, undefined),
  ]);
  const cal = E.pnlCalendar(state, 2026, 7);
  assert.equal(cal.totals.realizedSol, 0.5);
  assert.equal(cal.days[1].symbols['?'], 0.5, 'a missing symbol still buckets');
});

/* ---------------- wiring: the dashboard actually exposes it ---------------- */

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const dashHtml = fs.readFileSync(path.join(ROOT, 'dashboard.html'), 'utf8');
const dashJs = fs.readFileSync(path.join(ROOT, 'dashboard.js'), 'utf8');

test('the dashboard wires the calendar section end to end', () => {
  assert.match(dashHtml, /data-section="calendar"/, 'the nav must expose the section');
  assert.match(dashHtml, /<section id="calendar"/, 'the section element must exist');
  assert.match(dashJs, /SECTIONS = \[[^\]]*'calendar'/, 'the section must be registered');
  assert.match(dashJs, /E\.pnlCalendar\(/, 'the renderer must use the engine contract');
  assert.match(dashHtml, /cal-grid/, 'the month grid styles must exist');
});
