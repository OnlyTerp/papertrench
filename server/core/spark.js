/* PaperTrench server — Daily Spark (DELIGHT-MAP.md A2).
 *
 * One shared puzzle per UTC day, picked deterministically from real candle
 * data: every player worldwide faces the same coin and the same window, once
 * (shared-scarcity; Wordle grammar). The extension plays the chart forward
 * from T blind; the player commits paper actions (one buy, one full exit, or
 * a pass); grading is DETERMINISTIC from the candles that followed.
 *
 * Doctrine this module enforces by construction:
 *   - ZERO PnL in the result. The grade grades the process (entry, exit,
 *     nerve), never money. No output field carries a price, a SOL figure, or
 *     a percentage. Move ratios exist ONLY inside the rubric as grading
 *     inputs and never escape this module.
 *   - Determinism: the same (dayKey, chart, actions) always grade the same,
 *     and the day's pick is a pure function of the day key over a mint-sorted
 *     candidate list — the worker pins it in D1 so list churn during the day
 *     cannot change a live puzzle.
 *   - Honesty about what a replay can know: the grade compares the player's
 *     actions to the full aftermath, which a live trader cannot see. The
 *     result card says so ("graded against what followed") instead of
 *     pretending the player had the aftermath on screen.
 *
 * This module is PURE — no fetch, no env, no I/O. The worker only routes
 * bytes and owns the day pin (spark_days).
 */
'use strict';

const BAR_MS = 60000;            // the candles are 1m OHLCV
const AFTERMATH_BARS = 60;       // bars from T forward the puzzle covers
const PRE_BARS = 90;             // bars of history shown before T (the setup)
const MIN_BARS = PRE_BARS + AFTERMATH_BARS + 10; // a chart must host the window
const STEP_BARS = 15;            // one reveal step = 15 bars (4 steps total)
const ENTRY_WINDOW_BARS = 30;    // entry-timing axis measures this far forward

/** UTC YYYY-MM-DD for a ts (ms). The spark day is a UTC day worldwide. */
function dayKeyOf(ts) {
  const d = new Date(Math.trunc(Number(ts) || 0));
  return d.getUTCFullYear() + '-' +
    String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
    String(d.getUTCDate()).padStart(2, '0');
}

/** FNV-1a 32-bit of a string — small, stable, dependency-free. */
function fnv1a(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/** The day's 32-bit seed: a pure function of the day key. */
function daySeed(dayKey) {
  return fnv1a('spark:' + String(dayKey));
}

/**
 * Pick the day's puzzle from candidate charts.
 *
 * `candidates` is [{ mint, chart }] — chart = [{ts,o,h,l,c,v}] ascending.
 * The list is sorted by mint INTERNALLY, so the pick is a pure function of
 * the candidate SET (dayKey + set): caller order can never change a live
 * puzzle. Candidates whose chart cannot host a full window are skipped in a
 * stable probe order (start at seed % len, walk forward), so a skipped
 * candidate yields the NEXT stable choice rather than chaos.
 *
 * Returns null when nothing qualifies — the worker answers 'no-pool' and the
 * client shows an honest empty state. Never fabricates a chart.
 */
function pickForDay(dayKey, candidates) {
  const list = (Array.isArray(candidates) ? candidates : []).filter((c) =>
    c && typeof c.mint === 'string' && Array.isArray(c.chart) && c.chart.length >= MIN_BARS);
  if (!list.length) return null;
  list.sort((a, b) => (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0));
  const seed = daySeed(dayKey);
  const start = seed % list.length;
  for (let i = 0; i < list.length; i++) {
    const idx = (start + i) % list.length;
    const cand = list[idx];
    const window = windowForChart(seed + i, cand.chart);
    if (window) return { mint: cand.mint, window };
  }
  return null;
}

/**
 * Choose T inside one chart: enough pre-chart to read, enough aftermath to
 * grade. The offset is a pure function of the seed and anchored to the
 * chart's FIRST bar — history is immutable, so the window never drifts
 * within a day. The first ten bars are skipped (launch prints are noise).
 */
function windowForChart(seed, chart) {
  const n = Array.isArray(chart) ? chart.length : 0;
  if (n < MIN_BARS) return null;
  // Anchor T inside the chart's INTERESTING region: charts used by the
  // server are ~2-4h of 1m bars where the shape lives mid-file. The seed
  // window spans the quartiles so T always has real shape on BOTH sides —
  // a blind chart with a playable aftermath.
  const first = Math.floor(n / 4);
  const last = Math.floor(n * 3 / 4) - AFTERMATH_BARS;
  if (last < first) return null;
  const span = last - first;
  const off = first + (Math.floor(seed) % (span + 1));
  return { tTs: chart[off].ts, off, aftermath: AFTERMATH_BARS };
}

/** Bars the BLIND payload may carry: strictly ts <= tTs, at most PRE_BARS. */
function sliceBlind(chart, tTs) {
  const out = [];
  for (const bar of (chart || [])) {
    if (bar.ts <= tTs) out.push(bar);
  }
  return out.slice(-PRE_BARS);
}

/** The step-th forward slice: bars (tTs, tTs + step*STEP_BARS], max 4 steps. */
function forwardSlice(chart, tTs, step) {
  const maxStep = Math.floor(AFTERMATH_BARS / STEP_BARS);
  const s = Math.max(1, Math.min(maxStep, Math.trunc(Number(step) || 0)));
  const endTs = tTs + s * STEP_BARS * BAR_MS;
  const out = [];
  for (const bar of (chart || [])) {
    if (bar.ts > tTs && bar.ts <= endTs) out.push(bar);
  }
  return out;
}

/**
 * Validate one player's action list against the window. Legal runs:
 *   [{pass}]      — declined before entering
 *   [{buy},{sell}]— entered, then exited
 *   [{buy}]       — held to the window end (auto-exit at the close)
 * Timestamps are bar-aligned by the client; they must be monotonic and land
 * inside (tTs, tTs + AFTERMATH]. Returns {ok,...} or {error}.
 */
function validateActions(actions, tTs) {
  const list = Array.isArray(actions) ? actions : [];
  const endTs = tTs + AFTERMATH_BARS * BAR_MS;
  const norm = [];
  for (const a of list) {
    if (!a || (a.type !== 'buy' && a.type !== 'sell' && a.type !== 'pass')) {
      return { error: 'bad-action' };
    }
    const ts = Math.trunc(Number(a.ts) || 0);
    if (!(ts > tTs && ts <= endTs)) return { error: 'action-out-of-window' };
    norm.push({ type: a.type, ts });
  }
  if (!norm.length) return { error: 'empty' };
  if (norm[0].type === 'pass') {
    return norm.length === 1 ? { ok: true, actions: norm, passed: true } : { error: 'pass-not-alone' };
  }
  if (norm[0].type !== 'buy') return { error: 'must-open' };
  if (norm.length > 2) return { error: 'too-many' };
  if (norm.length === 2 && norm[1].type !== 'sell') return { error: 'must-close' };
  for (let i = 1; i < norm.length; i++) {
    if (norm[i].ts < norm[i - 1].ts) return { error: 'non-monotonic' };
  }
  return { ok: true, actions: norm, passed: false, heldToEnd: norm.length === 1 };
}

/* ---------------- the rubric ----------------
 *
 * Three graded axes on a buy run — the things a live trader controls — plus
 * one axis when the player passes. Every threshold lives in these tables so
 * the tests pin the WHOLE contract, and the card explains a verdict in words
 * without ever printing a number.
 */
const AXIS = {
  entry: {
    label: 'Entry',
    green: 'you bought the floor',
    yellow: 'near the floor, not on it',
    red: 'you chased the spike',
  },
  exit: {
    label: 'Exit',
    green: 'out before the giveback',
    yellow: 'left some on the table',
    red: 'sold a run that kept running',
  },
  nerve: {
    label: 'Nerve',
    green: 'held through the shake',
    yellow: 'never truly tested',
    red: 'the shakeout worked on you',
  },
  read: {
    label: 'Read',
    green: 'the pass dodged the bleed',
    yellow: 'nothing was there — fair pass',
    red: 'it paid to be in',
  },
};
const AXIS_SCORE = { green: 3, yellow: 2, red: 1 };
const EMOJI = { green: '🟩', yellow: '🟨', red: '🟥' };

/** Overall letter from the axis sum (3..9): S A B C C D D — worst-facet
 * weighting via the sum; the story names the weakest axis in words. */
function letterForScore(sum) {
  if (sum >= 9) return 'S';
  if (sum === 8) return 'A';
  if (sum === 7) return 'B';
  if (sum === 6 || sum === 5) return 'C';
  return 'D';
}

/* --- chart readers (internal) --- */
/** The bar in force at ts: the last bar with bar.ts <= ts. */
function barAt(chart, ts) {
  let found = null;
  for (const b of chart) {
    if (b.ts <= ts) found = b; else break;
  }
  return found;
}
/** Extreme value of `key` over bars in (fromTs, toTs]. */
function extremeOver(chart, fromTs, toTs, key, pick) {
  let best = null;
  for (const b of chart) {
    if (b.ts > fromTs && b.ts <= toTs) {
      if (best === null || (pick === 'max' ? b[key] > best : b[key] < best)) best = b[key];
    }
  }
  return best;
}
/** The ts of the lowest low in (fromTs, toTs], or null. */
function tsOfLow(chart, fromTs, toTs) {
  let ts = null, low = null;
  for (const b of chart) {
    if (b.ts > fromTs && b.ts <= toTs && (low === null || b.l < low)) { low = b.l; ts = b.ts; }
  }
  return ts;
}

/**
 * Grade one validated run. Deterministic; PURE. Returns the result-card
 * model: { grade, passed, heldToEnd, axes:[{key,label,emoji,text}], story }.
 * NO numeric outcome fields — see the doctrine header.
 */
function gradeRun(valid, chart, tTs) {
  if (!valid || !valid.ok || !Array.isArray(valid.actions)) {
    return { error: 'invalid-run:' + ((valid && valid.error) || 'unknown') };
  }
  const list = Array.isArray(chart) ? chart : [];
  const endTs = tTs + AFTERMATH_BARS * BAR_MS;
  if (valid.passed) return gradePass(list, tTs, endTs);
  return gradeTrade(valid, list, tTs, endTs);
}

function gradePass(chart, tTs, endTs) {
  const entryBar = barAt(chart, tTs);
  const entry = entryBar ? entryBar.c : 0;
  const minLow = extremeOver(chart, tTs, endTs, 'l', 'min');
  const maxHigh = extremeOver(chart, tTs, endTs, 'h', 'max');
  const dip = entry > 0 && minLow > 0 ? entry / minLow : 1;  // >1: it bled
  const rip = entry > 0 && maxHigh > 0 ? maxHigh / entry : 1; // >1: it ran
  let tone;
  if (dip >= 1.3) tone = 'green';        // it was a trap; the pass dodged it
  else if (rip < 1.15) tone = 'yellow';  // nothing was there — fair pass
  else tone = 'red';                     // it paid to be in
  return {
    grade: letterForScore(AXIS_SCORE[tone]),
    passed: true, heldToEnd: false,
    axes: [{ key: 'read', tone, label: AXIS.read.label, emoji: EMOJI[tone], text: AXIS.read[tone] }],
    story: PASS_STORY[tone],
  };
}

function gradeTrade(valid, chart, tTs) {
  const endTs = tTs + AFTERMATH_BARS * BAR_MS;
  const buy = valid.actions[0];
  const sell = valid.actions[1] || { ts: endTs };
  const entryBar = barAt(chart, buy.ts);
  const exitBar = barAt(chart, sell.ts);
  if (!entryBar || !exitBar) return { error: 'no-bars' };
  return gradeTradeInner(valid, chart, tTs, endTs, entryBar.c, exitBar.c, buy, sell);
}

function gradeTradeInner(valid, chart, tTs, endTs, entry, exit, buy, sell) {
  // ENTRY: the player's fill vs the floor of the window that followed.
  const winEnd = Math.min(buy.ts + ENTRY_WINDOW_BARS * BAR_MS, endTs);
  const winLow = extremeOver(chart, buy.ts - BAR_MS, winEnd, 'l', 'min');
  let entryTone;
  if (winLow > 0) {
    const chase = entry / winLow; // 1.0 = perfect floor fill
    entryTone = chase <= 1.05 ? 'green' : chase <= 1.25 ? 'yellow' : 'red';
  } else entryTone = 'yellow';

  // EXIT: what the path did after the exit bar.
  //   gaveUp   = postHigh / exit  — how much higher it went after you left
  //   airBelow = exit / postLow   — the dump below your exit you dodged
  const postHigh = extremeOver(chart, sell.ts - BAR_MS, endTs, 'h', 'max');
  const postLow = extremeOver(chart, sell.ts - BAR_MS, endTs, 'l', 'min');
  let exitTone;
  if (postHigh > 0 && postLow > 0) {
    const gaveUp = postHigh / exit;
    const airBelow = exit / postLow;
    exitTone = (gaveUp <= 1.10 || airBelow >= 1.5) ? 'green'
      : (gaveUp >= 1.6 && airBelow <= 1.1) ? 'red' : 'yellow';
  } else exitTone = 'yellow';

  // NERVE: the deepest adverse excursion WHILE HELD, and whether the player
  // dumped within 2 bars of that low (the shakeout worked).
  const heldLow = extremeOver(chart, buy.ts - BAR_MS, sell.ts, 'l', 'min');
  let nerveTone;
  if (heldLow > 0) {
    const dip = entry / heldLow;
    const lowTs = tsOfLow(chart, buy.ts - BAR_MS, sell.ts);
    const panic = lowTs !== null && Math.abs(sell.ts - lowTs) <= 2 * BAR_MS && dip >= 1.15;
    nerveTone = panic ? 'red' : (dip >= 1.15 ? 'green' : 'yellow');
  } else nerveTone = 'green';

  const axes = [
    { key: 'entry', tone: entryTone, label: AXIS.entry.label, emoji: EMOJI[entryTone], text: AXIS.entry[entryTone] },
    { key: 'exit', tone: exitTone, label: AXIS.exit.label, emoji: EMOJI[exitTone], text: AXIS.exit[exitTone] },
    { key: 'nerve', tone: nerveTone, label: AXIS.nerve.label, emoji: EMOJI[nerveTone], text: AXIS.nerve[nerveTone] },
  ];
  const sum = AXIS_SCORE[entryTone] + AXIS_SCORE[exitTone] + AXIS_SCORE[nerveTone];
  return {
    grade: letterForScore(sum),
    passed: false, heldToEnd: !!valid.heldToEnd,
    axes,
    story: storyFor(entryTone, exitTone, nerveTone, valid.heldToEnd),
  };
}

function storyFor(entryTone, exitTone, nerveTone, heldToEnd) {
  const parts = [];
  if (entryTone === 'red') parts.push('the entry was the crime');
  if (entryTone === 'green' && exitTone === 'green') parts.push('clean entry-to-exit');
  if (nerveTone === 'red') parts.push('the shakeout worked on you');
  if (heldToEnd) parts.push('you rode the whole window');
  if (!parts.length) parts.push('read the tape, took the exit');
  parts.push('graded against what followed — the replay knows what you could not');
  return parts.join('. ');
}

const PASS_STORY = {
  green: 'the best trade was the one you skipped. The chart bled after T.',
  yellow: 'nothing was there either way — the pass cost nothing and proved nothing.',
  red: 'the chart paid after T. The pass was the miss. Next window, trust the read.',
};

module.exports = {
  dayKeyOf, daySeed, fnv1a, pickForDay, windowForChart,
  sliceBlind, forwardSlice, validateActions, gradeRun,
  BAR_MS, AFTERMATH_BARS, PRE_BARS, STEP_BARS, MIN_BARS, EMOJI,
};
