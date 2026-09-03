'use strict';
/* Every pass graded D — including the perfect one.
 *
 * Field report while playtesting: "why is it always a bad grade — I get a D
 * when I skip because I knew it was going down anyway".
 *
 * letterForScore reads a THREE-axis sum and its table only starts awarding
 * above D at 5:
 *
 *   >=9 S | 8 A | 7 B | 6,5 C | else D
 *
 * gradePass judges ONE axis and handed that table AXIS_SCORE[tone] directly —
 * 3, 2 or 1. All three fall into the `else`, so green, yellow and red all
 * returned 'D'. The tone and the story were computed correctly the whole
 * time, which is what made it so confusing to play: the card printed a green
 * "the pass dodged the bleed" next to a big red D, while TRADING that same
 * trap scored a B.
 *
 * That inverted the product's own doctrine. Not taking the trade is the
 * discipline this thing exists to teach, and it was the one call that could
 * never be rewarded.
 *
 * The existing rubric test asserted the pass's axis emoji and story but never
 * its letter, which is exactly the gap this shipped through — so these tests
 * are about the LETTER, and one of them pins that a pass can reach the top.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../core/spark.js');

const MIN = 60000;

/** A chart that is flat until T, then dips to `dipTo` and rips to `ripTo`. */
function chartWith({ dipTo, ripTo }) {
  const bars = [];
  const t0 = Date.UTC(2026, 0, 1);
  for (let i = 0; i < 130; i++) {
    bars.push({ ts: t0 + i * MIN, o: 100, h: 100, l: 100, c: 100 });
  }
  for (let i = 0; i <= 60; i++) {
    bars.push({
      ts: t0 + (130 + i) * MIN,
      o: 100, c: 100,
      h: i === 40 ? ripTo : 100,
      l: i === 20 ? dipTo : 100,
    });
  }
  return bars;
}

const gradePassOn = (shape) => {
  const chart = chartWith(shape);
  const tTs = chart[130].ts;
  return S.gradeRun(
    S.validateActions([{ type: 'pass', ts: tTs + MIN }], tTs), chart, tTs);
};

test('a pass that dodged a real bleed is the best read available, not a D', () => {
  const g = gradePassOn({ dipTo: 60, ripTo: 100 });   // -40%
  assert.equal(g.axes[0].emoji, S.EMOJI.green, 'the tone was always right');
  assert.equal(g.grade, 'S',
    'the letter must agree with the tone — a green read cannot print a D');
});

test('a pass on a chart where nothing happened is unremarkable, not failing', () => {
  const g = gradePassOn({ dipTo: 98, ripTo: 105 });
  assert.equal(g.axes[0].emoji, S.EMOJI.yellow);
  assert.equal(g.grade, 'C', 'a fair pass sits in the middle of the scale');
});

test('a pass on a chart that ran without you is the one that deserves a D', () => {
  const g = gradePassOn({ dipTo: 100, ripTo: 160 });  // +60%
  assert.equal(g.axes[0].emoji, S.EMOJI.red);
  assert.equal(g.grade, 'D');
});

test('the three pass tones produce three DIFFERENT letters', () => {
  // The whole defect in one assertion: the outcomes must be distinguishable.
  const letters = [
    gradePassOn({ dipTo: 60, ripTo: 100 }).grade,
    gradePassOn({ dipTo: 98, ripTo: 105 }).grade,
    gradePassOn({ dipTo: 100, ripTo: 160 }).grade,
  ];
  assert.equal(new Set(letters).size, 3,
    'a rubric that returns the same letter for every outcome grades nothing: '
    + 'got ' + JSON.stringify(letters));
});

test('a correct pass is not out-scored by trading the same trap', () => {
  // The doctrine check. Dodging a -40% trap must not be worth less than
  // taking it — that is the lesson the product is built to teach.
  const shape = { dipTo: 60, ripTo: 100 };
  const chart = chartWith(shape);
  const tTs = chart[130].ts;
  const RANK = { S: 6, A: 5, B: 4, C: 3, D: 2, F: 1 };

  const pass = gradePassOn(shape);
  const traded = S.gradeRun(S.validateActions([
    { type: 'buy', ts: tTs + 20 * MIN },
    { type: 'sell', ts: tTs + 40 * MIN },
  ], tTs), chart, tTs);

  assert.ok(RANK[pass.grade] >= RANK[traded.grade],
    `dodging the trap (${pass.grade}) must not score below trading it (${traded.grade})`);
});

test('a pass still reports exactly one axis and no numbers', () => {
  // The fix changes the LETTER only — the shape of the verdict and the
  // no-PnL doctrine are untouched.
  const g = gradePassOn({ dipTo: 60, ripTo: 100 });
  assert.equal(g.passed, true);
  assert.equal(g.axes.length, 1);
  assert.equal(g.axes[0].key, 'read');
  assert.doesNotMatch(JSON.stringify(g), /pnl|profit|roi|[0-9]+\.[0-9]+%/i,
    'a verdict never carries a money figure');
});
