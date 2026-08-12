/* Trade thesis — journaling and the learning loop.
 *
 * The value of a thesis comes from WHEN it is written: before the outcome is
 * known. That is what makes it possible to grade process separately from
 * result, so a profitable trade that broke its own plan is not mistaken for a
 * good decision.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

global.window = global.window || {};
require('../engine.js');
const E = global.window.PaperEngine;

const MINT = 'MintThesis';

function openPosition(over) {
  const settings = Object.assign(E.defaultSettings(), { feeBps: 0 }, over || {});
  const state = E.defaultState(settings);
  E.buy(state, settings, {
    ts: 1000, mint: MINT, symbol: 'BONK', site: 'padre', priceNative: 0.001, solAmount: 1,
  });
  return { settings, state };
}

/* ---------------- capture ---------------- */

test('a thesis is normalized and attached to the open position', () => {
  const { state } = openPosition();
  const saved = E.setThesis(state, MINT, {
    text: '  Narrative building, volume spike.  ',
    tags: ['narrative', 'volume-spike', 'narrative'],
    plan: 'swing', conviction: 4, targetPct: 50, stopPct: 20,
  }, 1500);

  assert.equal(saved.text, 'Narrative building, volume spike.', 'text is trimmed');
  assert.deepEqual(saved.tags, ['narrative', 'volume-spike'], 'duplicate tags collapse');
  assert.equal(saved.plan, 'swing');
  assert.equal(saved.conviction, 4);
  assert.equal(saved.at, 1500, 'the write time is recorded');
  assert.equal(state.positions[MINT].thesis.text, saved.text);
});

test('unknown tags and out-of-range values are rejected, not stored', () => {
  const thesis = E.normalizeThesis({
    text: 'x', tags: ['narrative', 'not-a-real-tag'], plan: 'nonsense',
    conviction: 99, targetPct: -5, stopPct: 0,
  }, 1);

  assert.deepEqual(thesis.tags, ['narrative'], 'only known tags survive');
  assert.equal(thesis.plan, null);
  assert.equal(thesis.conviction, null, 'conviction outside 1-5 is dropped');
  assert.equal(thesis.targetPct, null, 'a negative target is not a target');
  assert.equal(thesis.stopPct, null);
});

test('an empty thesis is null rather than a hollow journal entry', () => {
  assert.equal(E.normalizeThesis({ text: '   ', tags: [], plan: null }, 1), null);
  assert.equal(E.normalizeThesis(null, 1), null);
  assert.equal(E.normalizeThesis({ tags: ['bogus'] }, 1), null);
});

test('thesis text is capped so one entry cannot bloat stored state', () => {
  const thesis = E.normalizeThesis({ text: 'a'.repeat(5000) }, 1);
  assert.equal(thesis.text.length, E.THESIS_MAX);
});

test('setting a thesis with no open position is a no-op', () => {
  const { state } = openPosition();
  assert.equal(E.setThesis(state, 'NoSuchMint', { text: 'hi' }, 1), null);
});

/* ---------------- the chart snap that rides the thesis ----------------
 *
 * superski (Discord, 2026-08-11): "If there was a way to write an instant
 * thesis with a screenshot within the instant trader that would be nice,
 * esp since new pairs moves too quick to open a completely separate tab."
 * The composer was already in the trader; the snap now is too. The thesis
 * stores only the frame's TIMESTAMP — the JPEG lives in pt_frames (joined
 * by sessionId + time), because embedding it would balloon every pt_state
 * write.
 */

test('a chart snap reference is kept on the thesis, and junk is not', () => {
  const withFrame = E.normalizeThesis({ text: 'setup', frameAt: 1_800_000_000_123 }, 1_800_000_000_500);
  assert.equal(withFrame.frameAt, 1_800_000_000_123);

  assert.equal(E.normalizeThesis({ text: 'setup' }, 1).frameAt, null, 'no snap means no reference');
  assert.equal(E.normalizeThesis({ text: 'setup', frameAt: -5 }, 1).frameAt, null);
  assert.equal(E.normalizeThesis({ text: 'setup', frameAt: 'soon' }, 1).frameAt, null);
});

test('a snap alone is not a thesis — an image with no words is not a plan', () => {
  assert.equal(E.normalizeThesis({ text: '  ', tags: [], frameAt: 1_800_000_000_123 }, 1), null);
});

test('the snap reference travels onto the closed round with the rest of the thesis', () => {
  const { settings, state } = openPosition();
  E.setThesis(state, MINT, { text: 'Momentum', tags: ['momentum'], frameAt: 2000 }, 2100);
  const { round } = E.sell(state, settings, { ts: 4000, mint: MINT, qtyFraction: 1, priceNative: 0.002 });
  assert.equal(round.thesis.frameAt, 2000, 'the graded plan keeps its chart context');
});

test('the overlay composer snaps through the background capture, explicitly', () => {
  const contentSrc = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

  const editor = contentSrc.slice(
    contentSrc.indexOf('function renderThesis()'),
    contentSrc.indexOf('function flushArmedBuy')
  );
  assert.match(editor, /data-f="snap"/,
    'the thesis editor must offer the snap control in the trader itself');
  assert.match(editor, /type: 'pt_snap_frame'/,
    'the snap must reuse the existing frame-capture pipeline, not invent one');
  assert.match(editor, /kind: 'thesis'/,
    'thesis frames must be distinguishable in pt_frames');
  assert.match(editor, /explicit: true/,
    'a hand-triggered snap is its own consent and must say so');
  assert.match(editor, /frameAt: frameAt \|\| \(saved && saved\.frameAt\) \|\| null/,
    'a re-edit without a new snap must keep the original frame reference');
  assert.match(editor, /reply && reply\.ok && Number\(reply\.at\) > 0/,
    'the reference is stored only when the background confirms a frame actually landed');
});

/* ---------------- carried to the closed round ---------------- */

test('the thesis survives onto the closed round so it can be graded', () => {
  const { settings, state } = openPosition();
  E.setThesis(state, MINT, { text: 'Momentum continuation', tags: ['momentum'], targetPct: 50 }, 1200);
  const { round } = E.sell(state, settings, { ts: 4000, mint: MINT, qtyFraction: 1, priceNative: 0.002 });

  assert.ok(round.thesis, 'the plan must travel with the result');
  assert.equal(round.thesis.text, 'Momentum continuation');
  assert.ok(round.thesis.at < round.closedAt, 'the thesis predates the outcome');
});

/* ---------------- grading process, not outcome ---------------- */

test('hitting the stated target counts as following the plan', () => {
  const { settings, state } = openPosition();
  E.setThesis(state, MINT, { text: 'x', tags: ['momentum'], targetPct: 50 }, 1200);
  const { round } = E.sell(state, settings, { ts: 4000, mint: MINT, qtyFraction: 1, priceNative: 0.002 });

  const grade = E.gradeThesis(round);
  assert.equal(grade.followedPlan, true);
  assert.equal(grade.luckyWin, false);
  assert.match(grade.notes.join(' '), /target/i);
});

test('a profitable exit that abandoned the plan is flagged as luck', () => {
  const { settings, state } = openPosition();
  E.setThesis(state, MINT, { text: 'x', tags: ['fomo'], targetPct: 100 }, 1200);

  // Ran past the target in-trade, then exited well below it.
  E.markPosition(state, MINT, 0.0025);          // peak ≈ +150%
  const { round } = E.sell(state, settings, { ts: 4000, mint: MINT, qtyFraction: 1, priceNative: 0.0012 });

  const grade = E.gradeThesis(round);
  assert.ok(round.pnlSol > 0, 'the trade was profitable');
  assert.equal(grade.followedPlan, false, 'but the plan was not followed');
  assert.equal(grade.luckyWin, true,
    'a win on a broken plan must be separated from a good decision');
});

test('holding through the stated stop is recorded as breaking the plan', () => {
  const { settings, state } = openPosition();
  E.setThesis(state, MINT, { text: 'x', tags: ['dip-buy'], stopPct: 20 }, 1200);

  E.markPosition(state, MINT, 0.0005);          // deep drawdown
  const { round } = E.sell(state, settings, { ts: 4000, mint: MINT, qtyFraction: 1, priceNative: 0.0006 });

  const grade = E.gradeThesis(round);
  assert.equal(grade.followedPlan, false);
  assert.match(grade.notes.join(' '), /stop/i);
});

test('a round with no thesis has nothing to grade', () => {
  const { settings, state } = openPosition();
  const { round } = E.sell(state, settings, { ts: 4000, mint: MINT, qtyFraction: 1, priceNative: 0.002 });
  assert.equal(E.gradeThesis(round), null);
});

/* ---------------- aggregate learning ---------------- */

test('stats aggregate outcomes per setup tag', () => {
  const settings = Object.assign(E.defaultSettings(), { feeBps: 0 });
  const state = E.defaultState(settings);

  const play = (mint, tag, exitPrice, ts) => {
    E.buy(state, settings, { ts, mint, symbol: 'X', priceNative: 0.001, solAmount: 1 });
    E.setThesis(state, mint, { text: 'x', tags: [tag] }, ts);
    E.sell(state, settings, { ts: ts + 100, mint, qtyFraction: 1, priceNative: exitPrice });
  };

  play('A', 'momentum', 0.002, 1000);   // win
  play('B', 'momentum', 0.0015, 2000);  // win
  play('C', 'fomo', 0.0005, 3000);      // loss

  const stats = E.thesisStats(state);
  assert.equal(stats.total, 3);
  assert.equal(stats.withThesis, 3);
  assert.equal(stats.coverage, 100);

  const momentum = stats.tags.find((t) => t.tag === 'momentum');
  const fomo = stats.tags.find((t) => t.tag === 'fomo');
  assert.equal(momentum.count, 2);
  assert.equal(momentum.winRate, 100);
  assert.equal(fomo.winRate, 0);
  assert.ok(momentum.avgPnlSol > 0 && fomo.avgPnlSol < 0,
    'per-setup averages must reflect the actual results');
});

test('coverage reports honestly when most rounds were not journaled', () => {
  const settings = Object.assign(E.defaultSettings(), { feeBps: 0 });
  const state = E.defaultState(settings);
  for (let i = 0; i < 4; i++) {
    const mint = 'M' + i;
    E.buy(state, settings, { ts: 1000 * (i + 1), mint, symbol: 'X', priceNative: 0.001, solAmount: 1 });
    if (i === 0) E.setThesis(state, mint, { text: 'only one', tags: ['gut'] }, 1000);
    E.sell(state, settings, { ts: 1000 * (i + 1) + 50, mint, qtyFraction: 1, priceNative: 0.0011 });
  }

  const stats = E.thesisStats(state);
  assert.equal(stats.withThesis, 1);
  assert.equal(stats.total, 4);
  assert.equal(stats.coverage, 25);
});

test('empty state produces zeros rather than dividing by zero', () => {
  const stats = E.thesisStats(E.defaultState(E.defaultSettings()));
  assert.equal(stats.total, 0);
  assert.equal(stats.coverage, 0);
  assert.equal(Number.isFinite(stats.coverage), true);
  assert.deepEqual(stats.tags, []);
});

/* ---------------- exit quality & risk sizing ---------------- */

test('selling far below the peak is identified as an early exit', () => {
  const { settings, state } = openPosition();
  E.markPosition(state, MINT, 0.002);   // ran to +100%
  E.sell(state, settings, { ts: 4000, mint: MINT, qtyFraction: 1, priceNative: 0.0011 });

  const q = E.exitQuality(state.rounds[0]);
  assert.equal(q.verdict, 'early');
  // Derived: captured ~0.1 of a ~1.0 SOL peak.
  assert.ok(q.capturedPct < 25, `expected a low capture, got ${q.capturedPct}`);
  assert.ok(q.leftOnTableSol > 0.5, 'the unrealized gain given back must be quantified');
  assert.equal(q.roundTripped, false);
});

test('holding a winner to near its peak grades as excellent', () => {
  const { settings, state } = openPosition();
  E.markPosition(state, MINT, 0.002);
  E.sell(state, settings, { ts: 4000, mint: MINT, qtyFraction: 1, priceNative: 0.00195 });

  const q = E.exitQuality(state.rounds[0]);
  assert.equal(q.verdict, 'excellent');
  assert.ok(q.capturedPct >= 80);
});

test('a position that went green then closed red is flagged as round-tripped', () => {
  const { settings, state } = openPosition();
  E.markPosition(state, MINT, 0.002);   // was up
  E.sell(state, settings, { ts: 4000, mint: MINT, qtyFraction: 1, priceNative: 0.0008 });

  const q = E.exitQuality(state.rounds[0]);
  assert.equal(q.roundTripped, true, 'giving back a winner is the costliest habit');
  assert.equal(q.verdict, 'round-tripped');
});

test('a trade that never went green is not blamed for a bad exit', () => {
  const { settings, state } = openPosition();
  E.sell(state, settings, { ts: 4000, mint: MINT, qtyFraction: 1, priceNative: 0.0005 });

  const q = E.exitQuality(state.rounds[0]);
  assert.equal(q.verdict, 'never-worked');
  assert.equal(q.capturedPct, null, 'there was no peak to capture');
  assert.equal(q.roundTripped, false);
});

test('exit stats aggregate across rounds without dividing by zero', () => {
  const empty = E.exitStats(E.defaultState(E.defaultSettings()));
  assert.equal(empty.count, 0);
  assert.equal(empty.avgCapturedPct, null);
  assert.equal(empty.leftOnTableSol, 0);
});

test('position sizing is measured against the starting book', () => {
  const settings = Object.assign(E.defaultSettings(), { feeBps: 0, balanceStartSol: 10 });
  const state = E.defaultState(settings);

  // 10% and then an oversized 40% entry.
  E.buy(state, settings, { ts: 1, mint: 'A', symbol: 'A', priceNative: 0.001, solAmount: 1 });
  E.sell(state, settings, { ts: 2, mint: 'A', qtyFraction: 1, priceNative: 0.0011 });
  E.buy(state, settings, { ts: 3, mint: 'B', symbol: 'B', priceNative: 0.001, solAmount: 4 });
  E.sell(state, settings, { ts: 4, mint: 'B', qtyFraction: 1, priceNative: 0.0011 });

  const risk = E.riskProfile(state, settings);
  assert.equal(risk.count, 2);
  assert.equal(risk.maxSizePct, 40);
  assert.equal(risk.avgSizePct, 25);
  assert.equal(risk.oversized, 1, 'a single 40% entry must be flagged');
});
