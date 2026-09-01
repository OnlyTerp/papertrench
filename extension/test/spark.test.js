'use strict';
// Daily Spark client tests (DELIGHT-MAP.md A2) — extension/spark.js.
// The pure model + the share-card model are behaviour-tested here against
// the REAL module (no stubs): shape validation, blind-window math, the
// no-PnL card law, and the grade/tone mapping.

const test = require('node:test');
const assert = require('node:assert/strict');

const S = require('../spark.js');

const MIN = 60000;
function blindApi({ bars: count = 90, tTsOff = 75, day = '2026-08-28' } = {}) {
  const bars = [];
  for (let i = 0; i < count; i++) {
    const c = 100 + i * 0.1;
    bars.push({ ts: 1_700_000_000_000 + i * MIN, o: c - 0.1, h: c + 0.5, l: c - 0.5, c, v: 1000 });
  }
  const tTs = bars[tTsOff].ts;
  return { ok: true, day, mint: 'MintA', tTs, bars };
}

test('sparkModel: valid payload -> display model', () => {
  const api = blindApi();
  const m = S.sparkModel(api);
  assert.ok(m, 'model exists');
  assert.equal(m.day, '2026-08-28');
  assert.equal(m.mint, 'MintA');
  assert.equal(m.tTs, api.tTs);
  assert.equal(m.bars.length, 90);
  assert.equal(m.lastClose, 100 + 89 * 0.1);
  assert.ok(m.changePct > 0, 'change is positive for a rising chart');
});

test('sparkModel: invalid shapes are null, never garbage', () => {
  assert.equal(S.sparkModel(null), null);
  assert.equal(S.sparkModel({}), null);
  assert.equal(S.sparkModel({ ok: true, day: 'x', mint: 'm', tTs: 1, bars: [] }), null);
  assert.equal(S.sparkModel({ ok: true, day: 'x', mint: 'm', tTs: 1, bars: [{ bad: true }] }), null);
});

test('sparkCardModel: grade + axes, NO PnL field ever', () => {
  const v = {
    grade: 'A',
    axes: [
      { key: 'entry', label: 'Entry', tone: 'green' },
      { key: 'exit', label: 'Exit', tone: 'yellow' },
    ],
    story: 'Clean floor fill, early top exit.',
  };
  const card = S.sparkCardModel(v, '2026-08-28');
  assert.ok(card);
  assert.equal(card.kind, 'spark');
  assert.equal(card.grade, 'A');
  assert.equal(card.gradeLabel, 'A — strong read');
  assert.ok(card.axisLine.includes('Entry: good'));
  assert.ok(card.axisLine.includes('Exit: okay'));
  assert.equal(card.story, 'Clean floor fill, early top exit.');
  // The no-PnL law: a spark card carries no profit/loss/roi figure.
  for (const key of ['pnl', 'profit', 'loss', 'roi', 'usd', 'sol']) {
    assert.ok(!(key in card), 'card must not carry ' + key);
  }
});

test('sparkCardModel: unknown grade is null', () => {
  assert.equal(S.sparkCardModel({ grade: 'X', axes: [] }, 'd'), null);
  assert.equal(S.sparkCardModel(null, 'd'), null);
});

test('fmtPrice: compact across magnitudes, honest for tiny prices', () => {
  assert.equal(S.fmtPrice(0.001), '0.001');
  assert.equal(S.fmtPrice(0.000001), '0.000001');
  assert.ok(S.fmtPrice(3.969e-8).startsWith('0.0000000'), 'sub-cent prices stay readable');
  assert.equal(S.fmtPrice(-1), '—');
  assert.equal(S.fmtPrice(0), '—');
});

/* ---- the plan: minutes-after-the-cutoff picks ---- */

test('planActions: pass / entry-only / entry+exit map to the server contract', () => {
  const T = 1_700_000_000_000;
  // A pass still needs an in-window ts (validateActions checks even pass).
  assert.deepEqual(S.planActions({ pass: true, entryMin: null, exitMin: null }, T),
    [{ type: 'pass', ts: T + 60000 }]);
  // Entry only = held to the window end.
  assert.deepEqual(S.planActions({ pass: false, entryMin: 7, exitMin: null }, T),
    [{ type: 'buy', ts: T + 7 * 60000 }]);
  assert.deepEqual(S.planActions({ pass: false, entryMin: 7, exitMin: 23 }, T),
    [{ type: 'buy', ts: T + 7 * 60000 }, { type: 'sell', ts: T + 23 * 60000 }]);
  // Nothing placed, or garbage: null, never a request.
  assert.equal(S.planActions({ pass: false, entryMin: null, exitMin: null }, T), null);
  assert.equal(S.planActions(null, T), null);
  assert.equal(S.planActions({ pass: false, entryMin: 7, exitMin: 23 }), null);
});

test('planWithEntry/Exit: the exit invariant survives every placement', () => {
  // Entry ahead of the exit pushes the exit after it.
  let p = S.planWithExit(S.planWithEntry({ pass: false, entryMin: null, exitMin: null }, 10), 5);
  assert.equal(p.exitMin, 11, 'exit clamps forward of a later entry');
  // Exit before entry clamps up to entry+1.
  p = S.planWithExit(S.planWithEntry({ pass: false, entryMin: null, exitMin: null }, 10), 2);
  assert.equal(p.exitMin, 11);
  // Entry on the last minute leaves no legal exit — it drops, plan stays valid.
  p = S.planWithEntry({ pass: false, entryMin: 10, exitMin: 30 }, S.FUTURE_MIN);
  assert.equal(p.entryMin, 60);
  assert.equal(p.exitMin, null);
  assert.equal(S.planWithExit({ pass: false, entryMin: 60, exitMin: null }, 60), null,
    'no exit can follow an entry on the last minute');
  // No entry yet: an exit has nothing to exit from.
  assert.equal(S.planWithExit({ pass: false, entryMin: null, exitMin: null }, 5), null);
  // Bounds: minutes clamp into 1..60, never outside the graded window.
  assert.equal(S.planWithEntry({ pass: false, entryMin: null, exitMin: null }, 0).entryMin, 1);
  assert.equal(S.planWithEntry({ pass: false, entryMin: null, exitMin: null }, 99).entryMin, 60);
});

test('geometry + hit-testing: a tap in the lane rounds to a legal minute; the seen tape rejects', () => {
  const geom = S.chartGeom(760, 230, 90);
  assert.ok(geom.tX > 0 && geom.tX < 760);
  // Inside the lane -> 1..60, monotonic in x.
  const m1 = S.xToMinute(geom.tX + 1, geom);
  const mMid = S.xToMinute((geom.tX + 760 - geom.pad) / 2, geom);
  const mEnd = S.xToMinute(759, geom);
  assert.ok(m1 >= 1 && m1 <= 3, 'just past the line is minute ~1');
  assert.ok(mMid > m1 && mMid < mEnd, 'minutes increase across the lane');
  assert.equal(mEnd, 60, 'the right edge is the window end');
  // minuteX is the inverse: the marker lands where the tap read.
  assert.ok(Math.abs(S.xToMinute(S.chartGeom(760, 230, 90).minuteX(7), geom) - 7) <= 1);
  // A tap on the seen tape places nothing.
  assert.equal(S.xToMinute(geom.tX - 5, geom), null);
  assert.equal(S.xToMinute(0, geom), null);
});

test('revealModel: aftermath bars arrive only with an ok grade response', () => {
  const bars = [{ ts: 1, o: 1, h: 2, l: 0.5, c: 1.5 }, { ts: 2, o: 1.5, h: 3, l: 1, c: 2 }];
  const r = S.revealModel({ ok: true, verdict: { grade: 'B' }, reveal: { bars } });
  assert.ok(r && r.bars.length === 2);
  assert.equal(S.revealModel({ ok: false, reveal: { bars } }), null, 'a refused grade reveals nothing');
  assert.equal(S.revealModel({ ok: true, reveal: {} }), null);
  assert.equal(S.revealModel(null), null);
});

test('gradeErrorCopy: every failure speaks a sentence, never a bare reason code', () => {
  for (const reason of ['bad-body', 'wrong-day', 'no-data', 'no-window', 'rate-limited', 'busy',
    'bad-action', 'action-out-of-window', 'empty', 'pass-not-alone', 'must-open', 'must-close',
    'too-many', 'non-monotonic', 'server-error', 'HTTP 500', '']) {
    const copy = S.gradeErrorCopy(reason);
    assert.ok(typeof copy === 'string' && copy.length > 10 && /[.!?]$/.test(copy),
      'reason ' + JSON.stringify(reason) + ' needs a full human sentence');
    assert.notEqual(copy, reason, 'the copy must never be the bare reason code');
  }
  // The two known-but-different situations say their specific thing.
  assert.ok(S.gradeErrorCopy('wrong-day').includes('Reload'));
  assert.ok(S.gradeErrorCopy('network').includes('connection'));
});