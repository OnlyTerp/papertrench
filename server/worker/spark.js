/* PaperTrench worker — Daily Spark (DELIGHT-MAP.md A2) routes.
 *
 * One puzzle per UTC day, picked deterministically from REAL candle data.
 * The client plays blind: it sees bars only up to the reveal moment T, then
 * submits its actions and gets a process-grade verdict (never a PnL figure).
 *
 * The pick itself is a pure function of the day + candidate set
 * (core/spark.js). This file adds the transport: which candidates are
 * eligible, the blind window, and the D1 day-memo that makes the pick
 * stable across the day (the memo is advisory — the core pick is
 * deterministic, so the memo only protects against upstream drift).
 */

'use strict';

/* Daily Spark (DELIGHT-MAP.md A2). One shared puzzle per UTC day, picked
 * deterministically from real candle data (core/spark.js). The worker lane
 * adds: the candidate pool (mints with real data), the blind window, and the
 * D1 day-memo that pins the day's mint + T so every player faces the SAME
 * window all day.
 */
const spark = require('../core/spark.js');

/** JSON response helper (mirrors worker/index.js's module-scoped json). */
function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

const SPARK_CHAIN = 'solana';

/** Fresh upstream budget per REQUEST — indeix.js's own contract is "bounds a
 * single request's upstream spend". A module-scoped budget never resets, so
 * the sixth upstream call of an isolate's life would silently strip the spark
 * lane of its primary source for the rest of the isolate's life (days). Each
 * handler mints its own; the /today candidate loop shares one across its
 * bounded 5-candidate scan. (L-20) */
function freshBudget() {
  return { used: 0, max: 6 };
}

/* How far back the blind window reaches. The core pick needs a chart with
 * enough bars that the interesting shape lives inside the playable window;
 * 720 bars ≈ 12h of 1m candles. */
const SPARK_BARS = 720;

/** UTC day key, e.g. '2026-08-28'. */
function dayKey(now) {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * The candidate set for a day: every mint the replay feature has ever been
 * asked about, from the `pools` table (mints with a resolved pool are exactly
 * the mints with real candle data). Freshness is not a requirement — the
 * puzzle is a historical window, so a mint that traded last week is still a
 * fair puzzle today.
 */
async function candidateMints(env) {
  const rows = await env.DB.prepare('SELECT mint FROM pools ORDER BY mint').all();
  const mints = [];
  for (const r of rows.results || []) {
    const m = String(r.mint || '');
    if (m && m !== 'So11111111111111111111111111111111111111112') mints.push(m);
  }
  return mints;
}

/**
 * The day's memo: the picked mint (and its T) persisted in D1 so the same
 * puzzle is served all day even if the upstream candle data drifts. The core
 * pick is deterministic, so this is belt-and-braces — and it lets us serve
 * the SAME window to every player even if the chart source changes mid-day.
 * Returns { mint, tTs } or null when no memo exists.
 */
async function dayMemo(env, day) {
  const row = await env.DB.prepare(
    'SELECT mint, t_ts FROM spark_days WHERE day = ?').bind(day).first();
  if (!row || !row.mint) return null;
  return { mint: row.mint, tTs: Number(row.t_ts) || 0 };
}

async function setDayMemo(env, day, mint, tTs) {
  await env.DB.prepare(
    'INSERT INTO spark_days (day, mint, t_ts, created_at) VALUES (?, ?, ?, ?) ' +
    'ON CONFLICT(day) DO UPDATE SET mint = excluded.mint, t_ts = excluded.t_ts')
    .bind(day, mint, tTs, Date.now()).run();
}

/**
 * The day's PINNED CHART: the exact candles fetched at pick time, stored next
 * to the memo. This is what makes the puzzle deterministic for real: the memo
 * alone pinned (mint, T) but every later request re-fetched the chart
 * anchored to NOW, so a still-trading mint's 720-bar window slid forward —
 * hours later T left the window, /today 404'd with 'no-window', and a grade
 * would have run against different candles than the player saw. (L-19)
 */
async function dayChart(env, day) {
  const row = await env.DB.prepare(
    'SELECT chart_json FROM spark_charts WHERE day = ?').bind(day).first();
  if (!row || !row.chart_json) return null;
  try {
    const chart = JSON.parse(row.chart_json);
    return Array.isArray(chart) && chart.length ? chart : null;
  } catch {
    return null; // corrupt row: behave as absent, re-pin below
  }
}

async function setDayChart(env, day, chart) {
  await env.DB.prepare(
    'INSERT INTO spark_charts (day, chart_json, created_at) VALUES (?, ?, ?) ' +
    'ON CONFLICT(day) DO UPDATE SET chart_json = excluded.chart_json')
    .bind(day, JSON.stringify(chart), Date.now()).run();
}

/**
 * Load the chart for a mint via the same lane the replay uses: Indeix first,
 * GeckoTerminal fallback. Returns [{ts,o,h,l,c,v}] ascending, or null.
 */
async function sparkChart(env, mint, budget) {
  const { chartBars: gtBars } = require('./candles.js');
  const indeix = require('./indeix.js');
  let candles = null;
  try {
    candles = await indeix.ohlcv(env, SPARK_CHAIN, mint, 0, budget || freshBudget(), SPARK_BARS);
  } catch (e) {
    candles = null;
  }
  if (!candles || !candles.length) {
    try { candles = await gtBars(env, mint); } catch (e) { candles = null; }
  }
  if (!candles || !candles.length) return null;
  // Normalize: ascending, finite, positive.
  const out = candles
    .map((c) => ({ ts: Number(c.ts), o: Number(c.o), h: Number(c.h), l: Number(c.l), c: Number(c.c), v: Number(c.v) || 0 }))
    .filter((c) => Number.isFinite(c.ts) && Number.isFinite(c.h) && Number.isFinite(c.l) && c.h > 0 && c.l > 0)
    .sort((a, b) => a.ts - b.ts);
  return out.length ? out : null;
}

/**
 * The puzzle for a day key: memo -> candidates -> deterministic pick -> pin.
 * Shared by the daily puzzle (day = UTC date) and practice rounds
 * (day = 'practice-<seed>') — the ONLY difference between the two is the key,
 * which is exactly the point: grading needs no special case either.
 * Returns the json Response: { ok, day, mint, tTs, bars } or an honest error.
 */
async function puzzleFor(env, day) {
  const memo = await dayMemo(env, day);
  let mint = memo ? memo.mint : null;
  let tTs = memo ? memo.tTs : 0;
  let chart = await dayChart(env, day);

  if (!mint) {
    const mints = await candidateMints(env);
    if (!mints.length) return json({ ok: false, reason: 'no-pool' }, 404);
    // Load charts for candidates until the core pick succeeds. Bound the
    // work: 5 candidates is plenty for a deterministic pick, and each chart
    // is a real upstream call (shared budget bounds the whole scan).
    const budget = freshBudget();
    const candidates = [];
    for (const m of mints.slice(0, 5)) {
      const chart = await sparkChart(env, m, budget);
      if (chart) candidates.push({ mint: m, chart });
    }
    if (!candidates.length) return json({ ok: false, reason: 'no-data' }, 404);
    const pick = spark.pickForDay(day, candidates);
    if (!pick) return json({ ok: false, reason: 'no-pick' }, 404);
    const picked = candidates.find((c) => c.mint === pick.mint);
    mint = pick.mint;
    tTs = pick.window.tTs;
    // Pin EVERYTHING the puzzle needs at pick time: (mint, T) in spark_days
    // and the exact chart in spark_charts. From here on, the day plays and
    // grades against THIS copy — upstream drift cannot touch it.
    await setDayMemo(env, day, mint, tTs);
    await setDayChart(env, day, picked.chart);
    chart = picked.chart;
  }

  // Serve from the PINNED chart when it exists; a legacy memo (written before
  // spark_charts did) re-fetches — and BACKFILLS the pinned copy so the day's
  // grading becomes drift-proof from the very next hit instead of staying
  // exposed until midnight.
  let effective = chart || (await dayChart(env, day));
  if (!effective && memo) {
    effective = await sparkChart(env, mint, freshBudget());
    if (effective) await setDayChart(env, day, effective);
  }
  if (!effective) return json({ ok: false, reason: 'no-data' }, 404);

  // BLIND LAW: only bars with ts <= tTs may leave this handler. A bar at
  // exactly tTs is the reveal bar — the client may see it (it is the moment
  // they act on), but nothing after.
  const blind = effective.filter((c) => c.ts <= tTs);
  if (!blind.length) return json({ ok: false, reason: 'no-window' }, 404);

  return json({
    ok: true,
    day,
    mint,
    tTs,
    bars: blind,
  });
}

/**
 * GET /api/spark/today
 * Blind puzzle: { day, mint, tTs, bars: [... up to tTs] }.
 * The bars are the ONLY data the client may see before acting. Anything
 * after tTs is a spoiler and must never leave this handler.
 */
async function handleSparkToday(request, env) {
  return puzzleFor(env, dayKey(Date.now()));
}

/**
 * GET /api/spark/practice[?seed=N]
 * The same puzzle machinery keyed on a seed instead of the calendar: the
 * ritual stays daily, the practice is infinite. Deterministic per seed — the
 * same seed is the same chart for every player, so a round can be shared by
 * sharing its number — and pinned in D1 exactly like the daily pick, so the
 * grade path needs no special case at all. The client supplies a fresh
 * random seed per round; the server mints one when asked without.
 */
async function handleSparkPractice(request, env) {
  const url = new URL(request.url);
  const raw = Number(url.searchParams.get('seed'));
  const seed = Number.isInteger(raw) && raw >= 0 && raw < 2 ** 31
    ? raw
    : Math.floor(Math.random() * 2 ** 31);
  return puzzleFor(env, 'practice-' + seed);
}

/**
 * POST /api/spark/grade
 * Body: { day, mint, actions: [{type:'buy'|'sell', ts}] }
 * Verdict: the process-grade (S/A/B/C/D/F) + the tone axes + the story.
 * Deterministic: same actions + same day => same grade. No PnL figure ever.
 *
 * The response also carries `reveal.bars` — the pinned chart's bars AFTER T,
 * up to the window end. Until grading these are a spoiler and never leave the
 * worker; once the verdict is computed the run is committed and showing the
 * player what they were graded against is the point. (Re-grading a day is
 * allowed — this is a practice tool, and the share card is self-reported —
 * but the reveal arrives only WITH a verdict, never before it.)
 */
async function handleSparkGrade(request, env) {
  const url = new URL(request.url);
  const body = await request.json().catch(() => null);
  if (!body) return json({ ok: false, reason: 'bad-body' }, 400);
  const { day, mint, actions } = body || {};
  if (!day || !mint || !Array.isArray(actions)) {
    return json({ ok: false, reason: 'bad-body' }, 400);
  }
  // The memo pins the day's mint + T. Grade against the SAME window the
  // player saw — a deterministic function of (day, actions), never of the
  // current time or the caller's identity.
  const memo = await dayMemo(env, day);
  if (!memo || memo.mint !== mint) {
    return json({ ok: false, reason: 'wrong-day' }, 400);
  }
  // L-19: grade against the PINNED chart — the exact bars the player saw.
  // Upstream fetch only as recovery when both stores miss (drift relief);
  // a successful recovery BACKFILLS the pinned copy for every later hit.
  let chart = await dayChart(env, day);
  if (!chart) {
    chart = await sparkChart(env, mint, freshBudget());
    if (chart) await setDayChart(env, day, chart);
  }
  if (!chart) return json({ ok: false, reason: 'no-data' }, 503);

  const valid = spark.validateActions(actions, memo.tTs);
  if (!valid || !valid.ok) {
    return json({ ok: false, reason: valid && valid.error ? valid.error : 'invalid-actions' }, 400);
  }
  const verdict = spark.gradeRun(valid, chart, memo.tTs);
  if (verdict.error) return json({ ok: false, reason: verdict.error }, 400);
  return json({
    ok: true,
    day,
    mint,
    verdict,
    reveal: { bars: spark.forwardSlice(chart, memo.tTs, 4) },
  });
}

module.exports = { handleSparkToday, handleSparkPractice, handleSparkGrade, dayKey, candidateMints, dayMemo, setDayMemo, sparkChart, puzzleFor };