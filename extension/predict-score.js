/**
 * predict-score.js — Calibration scoring for prediction markets.
 *
 * Ported from amogus0471/Paper-Prediction @ e03f715 (MIT)
 *
 * P&L tells you whether you got lucky. A Brier Skill Score against the market's
 * own price tells you whether you were *right*: did the forecast you paid for
 * beat the forecast the market was already offering for free?
 *
 * Statistical honesty is a hard requirement here. Every function that can
 * produce a misleading number at low n returns the n alongside it so the UI can
 * refuse to render.
 */
;(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Helpers (ported from decimal.ts)
  // ---------------------------------------------------------------------------

  /** Clamp into [min, max]. */
  function clamp(v, min, max) {
    return v < min ? min : v > max ? max : v;
  }

  /**
   * Multiply `value` by 10^exp without ever going through float multiplication.
   *
   * Naively writing `Number(\`${value}e${exp}\`)` breaks the moment a number's
   * own toString is already exponential: `${1e-7}` is "1e-7", so appending "e8"
   * produces the string "1e-7e8", which parses to NaN. Small Brier scores land
   * there constantly, so this splits off any existing exponent and adds to it.
   */
  function shiftExponent(value, exp) {
    if (value === 0 || !Number.isFinite(value)) return value;
    var parts = ('' + value).split('e');
    var mantissa = parts[0];
    var existing = parts[1];
    var nextExp = (existing ? Number(existing) : 0) + exp;
    return Number(mantissa + 'e' + nextExp);
  }

  /**
   * Round half-away-from-zero at `dp` decimal places.
   *
   * `Math.round(x * 10 ** dp)` alone is wrong when the float representation
   * lands just below a .5 boundary (the classic 1.005 case). Shifting through
   * the decimal string repairs that before rounding.
   */
  function roundTo(value, dp) {
    if (!Number.isFinite(value)) return 0;
    var scaled = shiftExponent(value, dp);
    if (!Number.isFinite(scaled)) return 0;
    var rounded = Math.sign(scaled) * Math.round(Math.abs(scaled));
    var out = shiftExponent(rounded, -dp);
    return !Number.isFinite(out) || out === 0 ? 0 : out;
  }

  function mean(xs) {
    return xs.length === 0 ? 0 : xs.reduce(function (a, b) { return a + b; }, 0) / xs.length;
  }

  function stddevSample(xs) {
    var k = xs.length;
    if (k < 2) return 0;
    var m = mean(xs);
    return Math.sqrt(xs.reduce(function (s, x) { return s + (x - m) * (x - m); }, 0) / (k - 1));
  }

  function binIndex(p, binCount) {
    var pc = clamp(p, 0, 1);
    // Include 1.0 in the top bin rather than spilling into an empty bin above it.
    return Math.min(binCount - 1, Math.floor(pc * binCount));
  }

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------

  /** Minimum resolved positions before a Brier Skill Score may be displayed at all. */
  var MIN_N_FOR_BSS = 30;

  /** Minimum resolved positions before a per-category breakdown is trustworthy. */
  var MIN_N_FOR_CATEGORY = 20;

  var LADDER_WEIGHTS = Object.freeze({
    normalizedReturn: 0.45,
    brierSkill: 0.35,
    discipline: 0.1,
    activity: 0.1,
  });

  // ---------------------------------------------------------------------------
  // Single-forecast scoring
  // ---------------------------------------------------------------------------

  /** Brier score for a single binary forecast. Lower is better; 0 is perfect. */
  function brier(p, outcome) {
    var pc = clamp(p, 0, 1);
    return roundTo(Math.pow(pc - outcome, 2), 8);
  }

  /** Logarithmic score. Punishes confident wrongness far harder than Brier does. */
  function logScore(p, outcome) {
    var eps = 1e-9;
    var pc = clamp(p, eps, 1 - eps);
    return roundTo(-Math.log(outcome === 1 ? pc : 1 - pc), 8);
  }

  /**
   * Brier Skill Score: how much better than the reference forecast you were.
   * > 0 means you beat the market. 0 means you were the market. < 0 means you
   * paid a spread to be worse than a free price.
   */
  function brierSkillScore(brierUser, brierReference) {
    if (!(brierReference > 0)) return null;
    return roundTo(1 - brierUser / brierReference, 6);
  }

  /** Signed edge in basis points: how far your price sat from the market's. */
  function edgeBps(pUser, pMarket) {
    return roundTo((pMarket - pUser) * 10000, 4);
  }

  // ---------------------------------------------------------------------------
  // Calibration decomposition
  // ---------------------------------------------------------------------------

  var EMPTY_MURPHY = { reliability: 0, resolution: 0, uncertainty: 0, brier: 0 };

  /**
   * Murphy's three-way decomposition of the Brier score:
   *   BS = reliability - resolution + uncertainty
   *
   * It separates "your probabilities mean what they say" (reliability) from
   * "your probabilities are informative at all" (resolution), which is the
   * difference between a well-calibrated coin flipper and a forecaster.
   *
   * @param {{ pUser: number, pMarket: number, outcome: (0|1), category?: string, notional?: number }[]} records
   * @param {number} [binCount=10]
   * @returns {{ reliability: number, resolution: number, uncertainty: number, brier: number }}
   */
  function murphyDecomposition(records, binCount) {
    binCount = binCount || 10;
    var n = records.length;
    if (n === 0) return EMPTY_MURPHY;

    var baseRate = records.reduce(function (s, r) { return s + r.outcome; }, 0) / n;
    var buckets = {};
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      var bin = binIndex(r.pUser, binCount);
      if (!buckets[bin]) buckets[bin] = [];
      buckets[bin].push(r);
    }

    var reliability = 0;
    var resolution = 0;
    var keys = Object.keys(buckets);
    for (var ki = 0; ki < keys.length; ki++) {
      var group = buckets[keys[ki]];
      var nk = group.length;
      var pk = group.reduce(function (s, g) { return s + clamp(g.pUser, 0, 1); }, 0) / nk;
      var ok = group.reduce(function (s, g) { return s + g.outcome; }, 0) / nk;
      reliability += nk * Math.pow(pk - ok, 2);
      resolution += nk * Math.pow(ok - baseRate, 2);
    }
    reliability /= n;
    resolution /= n;
    var uncertainty = baseRate * (1 - baseRate);

    return {
      reliability: roundTo(reliability, 6),
      resolution: roundTo(resolution, 6),
      uncertainty: roundTo(uncertainty, 6),
      brier: roundTo(reliability - resolution + uncertainty, 6),
    };
  }

  /**
   * @param {{ pUser: number, pMarket: number, outcome: (0|1) }[]} records
   * @param {number} [binCount=10]
   * @returns {{ bin: number, binMid: number, n: number, meanPredicted: number, observedFrequency: number }[]}
   */
  function calibrationBins(records, binCount) {
    binCount = binCount || 10;
    var buckets = {};
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      var bin = binIndex(r.pUser, binCount);
      if (!buckets[bin]) buckets[bin] = [];
      buckets[bin].push(r);
    }
    var out = [];
    for (var b = 0; b < binCount; b++) {
      var group = buckets[b];
      if (!group || group.length === 0) continue;
      var nk = group.length;
      out.push({
        bin: b,
        binMid: roundTo((b + 0.5) / binCount, 4),
        n: nk,
        meanPredicted: roundTo(group.reduce(function (s, g) { return s + clamp(g.pUser, 0, 1); }, 0) / nk, 6),
        observedFrequency: roundTo(group.reduce(function (s, g) { return s + g.outcome; }, 0) / nk, 6),
      });
    }
    return out;
  }

  var EMPTY_CALIBRATION = {
    n: 0,
    brierUser: 0,
    brierMarket: 0,
    brierSkill: null,
    ciLow: null,
    ciHigh: null,
    baseRate: 0,
    bins: [],
    murphy: EMPTY_MURPHY,
    displayable: false,
    meanEdgeBps: 0,
  };

  /**
   * Full calibration summary. The CI is a normal approximation on the difference
   * of Brier scores — good enough for an in-app display, and labelled
   * "approximate" in the UI. Swap for a bootstrap before publishing anything.
   *
   * @param {{ pUser: number, pMarket: number, outcome: (0|1) }[]} records
   * @returns {{ n: number, brierUser: number, brierMarket: number, brierSkill: number|null, ciLow: number|null, ciHigh: number|null, baseRate: number, bins: object[], murphy: object, displayable: boolean, meanEdgeBps: number }}
   */
  function summarizeCalibration(records) {
    var n = records.length;
    if (n === 0) return EMPTY_CALIBRATION;

    var bu = records.map(function (r) { return brier(r.pUser, r.outcome); });
    var bm = records.map(function (r) { return brier(r.pMarket, r.outcome); });
    var diffs = bu.map(function (v, i) { return v - bm[i]; });

    var meanBu = mean(bu);
    var meanBm = mean(bm);
    var skill = brierSkillScore(meanBu, meanBm);
    var baseRate = records.reduce(function (s, r) { return s + r.outcome; }, 0) / n;

    var ciLow = null;
    var ciHigh = null;
    if (n >= MIN_N_FOR_BSS && meanBm > 0) {
      // Skill = 1 - Bu/Bm, so the uncertainty in skill is the uncertainty in the
      // paired difference (Bu - Bm), scaled by Bm.
      var se = stddevSample(diffs) / Math.sqrt(n);
      var halfWidth = (1.96 * se) / meanBm;
      ciLow = roundTo((skill || 0) - halfWidth, 6);
      ciHigh = roundTo((skill || 0) + halfWidth, 6);
    }

    return {
      n: n,
      brierUser: roundTo(meanBu, 6),
      brierMarket: roundTo(meanBm, 6),
      brierSkill: skill,
      ciLow: ciLow,
      ciHigh: ciHigh,
      baseRate: roundTo(baseRate, 6),
      bins: calibrationBins(records),
      murphy: murphyDecomposition(records),
      displayable: n >= MIN_N_FOR_BSS,
      meanEdgeBps: roundTo(mean(records.map(function (r) { return edgeBps(r.pUser, r.pMarket); })), 4),
    };
  }

  // ---------------------------------------------------------------------------
  // Leaderboard / ladder helpers
  // ---------------------------------------------------------------------------

  /** Percentile of a numeric sample using linear interpolation. */
  function percentile(sorted, q) {
    if (sorted.length === 0) return 0;
    var xs = sorted.slice().sort(function (a, b) { return a - b; });
    var pos = clamp(q, 0, 1) * (xs.length - 1);
    var lo = Math.floor(pos);
    var hi = Math.ceil(pos);
    if (lo === hi) return xs[lo];
    return xs[lo] + (xs[hi] - xs[lo]) * (pos - lo);
  }

  /**
   * Winsorize a value into the cohort's 5th-95th percentile band, then normalize
   * to [0,1]. This is what stops one lottery ticket on a 2c market from owning
   * the leaderboard.
   */
  function winsorizedNormalizedReturn(value, cohort) {
    if (cohort.length === 0) return 0.5;
    var p5 = percentile(cohort, 0.05);
    var p95 = percentile(cohort, 0.95);
    var clamped = clamp(value, p5, p95);
    if (!(p95 > p5)) return 0.5;
    return roundTo((clamped - p5) / (p95 - p5), 6);
  }

  /** Map a Brier Skill Score in [-0.25, +0.25] onto [0,1] for the ladder formula. */
  function normalizeBrierSkill(bss) {
    if (bss == null) return 0;
    return roundTo(clamp((bss + 0.25) / 0.5, 0, 1), 6);
  }

  /**
   * Discipline: 1 - the coefficient of variation of stake size.
   * Consistent position sizing scores well; going all-in on one trade does not.
   */
  function disciplineScore(stakeNotionals) {
    if (stakeNotionals.length < 2) return 0;
    var m = mean(stakeNotionals);
    if (!(m > 0)) return 0;
    var cv = stddevSample(stakeNotionals) / m;
    return roundTo(clamp(1 - cv, 0, 1), 6);
  }

  /** Activity saturates at 15 trades, so grinding volume buys nothing past that. */
  function activityScore(tradeCount, saturateAt) {
    saturateAt = saturateAt || 15;
    return roundTo(clamp(tradeCount / saturateAt, 0, 1), 6);
  }

  /**
   * Ladder points, 0-1000.
   *
   * Return is under half the weight on purpose: the point of the product is that
   * being right is worth more than being lucky.
   *
   * @param {{ normalizedReturn: number, brierSkillNormalized: number, discipline: number, activity: number }} i
   * @returns {number}
   */
  function ladderPoints(i) {
    var raw =
      LADDER_WEIGHTS.normalizedReturn * clamp(i.normalizedReturn, 0, 1) +
      LADDER_WEIGHTS.brierSkill * clamp(i.brierSkillNormalized, 0, 1) +
      LADDER_WEIGHTS.discipline * clamp(i.discipline, 0, 1) +
      LADDER_WEIGHTS.activity * clamp(i.activity, 0, 1);
    return roundTo(1000 * raw, 4);
  }

  /** Plain-English verdict. The Record screen leads with this, not with a number. */
  function coachingVerdict(s) {
    if (s.n < MIN_N_FOR_BSS) {
      return 'Building your record — ' + s.n + '/' + MIN_N_FOR_BSS + ' resolved positions. Keep trading; a skill score before 30 would be noise.';
    }
    var bss = s.brierSkill != null ? s.brierSkill : 0;
    var overconfident = s.murphy.reliability > 0.02;

    if (bss > 0.05) {
      return overconfident
        ? 'You are beating the market price, but your confidence runs ahead of your accuracy. Size down on your strongest convictions.'
        : 'You are genuinely beating the market price. Your forecasts carry information the price did not.';
    }
    if (bss > -0.02) {
      return 'You are roughly matching the market. That is harder than it sounds — but the spread you pay makes it a losing trade over time.';
    }
    return overconfident
      ? 'You are paying for confidence you have not earned. Your extreme forecasts miss most often — try trading closer to the mid.'
      : 'The market price is beating your forecasts. Look for categories where you actually have an edge instead of trading everything.';
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  var api = {
    // Constants
    MIN_N_FOR_BSS: MIN_N_FOR_BSS,
    MIN_N_FOR_CATEGORY: MIN_N_FOR_CATEGORY,
    LADDER_WEIGHTS: LADDER_WEIGHTS,
    EMPTY_CALIBRATION: EMPTY_CALIBRATION,

    // Single-forecast scoring
    brier: brier,
    logScore: logScore,
    brierSkillScore: brierSkillScore,
    edgeBps: edgeBps,

    // Calibration decomposition
    murphyDecomposition: murphyDecomposition,
    calibrationBins: calibrationBins,
    summarizeCalibration: summarizeCalibration,

    // Leaderboard / ladder helpers
    percentile: percentile,
    winsorizedNormalizedReturn: winsorizedNormalizedReturn,
    normalizeBrierSkill: normalizeBrierSkill,
    disciplineScore: disciplineScore,
    activityScore: activityScore,
    ladderPoints: ladderPoints,
    coachingVerdict: coachingVerdict,
  };

  // UMD-ish export: browser globals, Web Worker, and Node.
  if (typeof root !== 'undefined') {
    root.PaperPredictScore = api;
  }
  if (typeof self !== 'undefined') {
    self.PaperPredictScore = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this);
