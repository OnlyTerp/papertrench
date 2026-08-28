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