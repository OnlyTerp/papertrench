/* Tests for predict-score.js — calibration scoring module.
 *
 * Drives the real scoring functions. Every expectation is DERIVED from the
 * inputs, not pasted from a previous run. The scoring gates are the most
 * important contract: no BSS below n=30, no category breakdown below n=20.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

global.window = global.window || {};
require('../predict-score.js');
const S = require('../predict-score.js');

// ── Module exports ─────────────────────────────────────────────────

test('predict-score installs its public API', () => {
  assert.equal(typeof S, 'object');
  for (const fn of ['brier', 'logScore', 'brierSkillScore', 'edgeBps',
    'murphyDecomposition', 'calibrationBins', 'summarizeCalibration',
    'percentile', 'winsorizedNormalizedReturn', 'normalizeBrierSkill',
    'disciplineScore', 'activityScore', 'ladderPoints', 'coachingVerdict']) {
    assert.equal(typeof S[fn], 'function', `${fn} must be exported`);
  }
  assert.equal(typeof S.MIN_N_FOR_BSS, 'number');
  assert.equal(typeof S.MIN_N_FOR_CATEGORY, 'number');
  assert.equal(typeof S.LADDER_WEIGHTS, 'object');
});

// ── Brier score ────────────────────────────────────────────────────

test('brier: perfect forecast (p=1, outcome=1) → 0', () => {
  assert.ok(S.brier(1, 1) < 1e-9);
});

test('brier: worst forecast (p=1, outcome=0) → 1', () => {
  assert.ok(Math.abs(S.brier(1, 0) - 1) < 1e-9);
});

test('brier: base rate forecast (p=0.5, outcome=1) → 0.25', () => {
  assert.ok(Math.abs(S.brier(0.5, 1) - 0.25) < 1e-9);
});

test('brier: clamps p to [0,1]', () => {
  assert.ok(Math.abs(S.brier(-0.1, 1) - S.brier(0, 1)) < 1e-9);
  assert.ok(Math.abs(S.brier(1.5, 1) - S.brier(1, 1)) < 1e-9);
});

// ── Brier Skill Score ─────────────────────────────────────────────

test('BSS: same as market → 0', () => {
  const bss = S.brierSkillScore(0.25, 0.25);
  assert.ok(Math.abs(bss - 0) < 1e-6);
});

test('BSS: better than market → positive', () => {
  const bss = S.brierSkillScore(0.1, 0.25);
  assert.ok(bss > 0);
});

test('BSS: worse than market → negative', () => {
  const bss = S.brierSkillScore(0.3, 0.25);
  assert.ok(bss < 0);
});

test('BSS: zero reference → null (cannot divide)', () => {
  assert.equal(S.brierSkillScore(0.1, 0), null);
});

// ── Scoring gates ──────────────────────────────────────────────────

test('MIN_N_FOR_BSS is 30 — the hard gate', () => {
  assert.equal(S.MIN_N_FOR_BSS, 30);
});

test('MIN_N_FOR_CATEGORY is 20', () => {
  assert.equal(S.MIN_N_FOR_CATEGORY, 20);
});

test('summarizeCalibration: n<30 → displayable=false, CI=null', () => {
  const records = [];
  for (let i = 0; i < 20; i++) {
    records.push({ pUser: 0.6, pMarket: 0.5, outcome: i < 12 ? 1 : 0 });
  }
  const s = S.summarizeCalibration(records);
  assert.equal(s.n, 20);
  assert.equal(s.displayable, false, 'n<30 must not display BSS');
  assert.equal(s.ciLow, null, 'no CI below n=30');
  assert.equal(s.ciHigh, null, 'no CI below n=30');
});

test('summarizeCalibration: n>=30 → displayable=true, CI present', () => {
  const records = [];
  for (let i = 0; i < 35; i++) {
    records.push({ pUser: 0.6, pMarket: 0.5, outcome: i < 20 ? 1 : 0 });
  }
  const s = S.summarizeCalibration(records);
  assert.equal(s.n, 35);
  assert.equal(s.displayable, true, 'n>=30 is displayable');
  assert.ok(s.ciLow !== null, 'CI low present');
  assert.ok(s.ciHigh !== null, 'CI high present');
  assert.ok(s.ciLow < s.ciHigh, 'CI low < CI high');
});

test('summarizeCalibration: empty records → EMPTY_CALIBRATION', () => {
  const s = S.summarizeCalibration([]);
  assert.equal(s.n, 0);
  assert.equal(s.displayable, false);
  assert.equal(s.brierSkill, null);
});

// ── Murphy decomposition ───────────────────────────────────────────

test('murphyDecomposition: BS = reliability - resolution + uncertainty', () => {
  const records = [];
  for (let i = 0; i < 50; i++) {
    records.push({ pUser: 0.7, pMarket: 0.5, outcome: i < 30 ? 1 : 0 });
  }
  const m = S.murphyDecomposition(records);
  const reconstructed = Math.round((m.reliability - m.resolution + m.uncertainty) * 1e6) / 1e6;
  assert.ok(Math.abs(reconstructed - m.brier) < 1e-5,
    `Murphy decomposition must reconstruct Brier: ${reconstructed} vs ${m.brier}`);
});

// ── Ladder points ──────────────────────────────────────────────────

test('ladderPoints: all zeros → minimum', () => {
  const pts = S.ladderPoints({ normalizedReturn: 0, brierSkillNormalized: 0, discipline: 0, activity: 0 });
  assert.equal(pts, 0);
});

test('ladderPoints: all ones → maximum (1000)', () => {
  const pts = S.ladderPoints({ normalizedReturn: 1, brierSkillNormalized: 1, discipline: 1, activity: 1 });
  assert.equal(pts, 1000);
});

test('ladderPoints: brierSkill has 35% weight', () => {
  // If only brierSkill is 1, rest is 0: points = 0.35 * 1000 = 350
  const pts = S.ladderPoints({ normalizedReturn: 0, brierSkillNormalized: 1, discipline: 0, activity: 0 });
  assert.equal(pts, 350);
});

// ── Coaching verdict ───────────────────────────────────────────────

test('coachingVerdict: n<30 → building record message', () => {
  const s = { n: 15, brierSkill: null, murphy: { reliability: 0 } };
  const v = S.coachingVerdict(s);
  assert.ok(v.includes('15/30'), 'shows progress toward 30');
});

test('coachingVerdict: positive BSS + low overconfidence → beating market', () => {
  const s = { n: 40, brierSkill: 0.1, murphy: { reliability: 0.01 } };
  const v = S.coachingVerdict(s);
  assert.ok(v.includes('beating'), 'positive verdict for beating market');
});

test('coachingVerdict: negative BSS → market beating you', () => {
  const s = { n: 40, brierSkill: -0.1, murphy: { reliability: 0.01 } };
  const v = S.coachingVerdict(s);
  assert.ok(v.includes('market') || v.includes('beating'), 'negative verdict');
});

// ── Discipline and activity scores ─────────────────────────────────

test('disciplineScore: constant sizing → 1.0', () => {
  const d = S.disciplineScore([100, 100, 100, 100, 100]);
  assert.ok(d > 0.99, 'constant sizing should score near 1.0');
});

test('disciplineScore: single trade → 0', () => {
  assert.equal(S.disciplineScore([100]), 0);
});

test('activityScore: saturates at configured limit', () => {
  const a15 = S.activityScore(15);
  const a30 = S.activityScore(30);
  assert.ok(Math.abs(a15 - 1.0) < 1e-6, '15 trades saturates at default');
  assert.ok(Math.abs(a30 - 1.0) < 1e-6, '30 trades still 1.0 (saturated)');
});
