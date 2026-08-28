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
const SPARK_BUDGET = { used: 0, max: 6 };

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
 * Load the chart for a mint via the same lane the replay uses: Indeix first,
 * GeckoTerminal fallback. Returns [{ts,o,h,l,c,v}] ascending, or null.
 */
async function sparkChart(env, mint) {
  const { chartBars: gtBars } = require('./candles.js');
  const indeix = require('./indeix.js');
  let candles = null;
  try {
    candles = await indeix.ohlcv(env, SPARK_CHAIN, mint, 0, SPARK_BUDGET, SPARK_BARS);
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
 * GET /api/spark/today
 * Blind puzzle: { day, mint, tTs, bars: [... up to tTs] }.
 * The bars are the ONLY data the client may see before acting. Anything
 * after tTs is a spoiler and must never leave this handler.
 */
async function handleSparkToday(request, env) {
  const url = new URL(request.url);
  const now = Date.now();
  const day = dayKey(now);
  const memo = await dayMemo(env, day);
  let mint = memo ? memo.mint : null;
  let tTs = memo ? memo.tTs : 0;

  if (!mint) {
    const mints = await candidateMints(env);
    if (!mints.length) return json({ ok: false, reason: 'no-pool' }, 404);
    // Load charts for candidates until the core pick succeeds. Bound the
    // work: 5 candidates is plenty for a deterministic pick, and each chart
    // is a real upstream call.
    const candidates = [];
    for (const m of mints.slice(0, 5)) {
      const chart = await sparkChart(env, m);
      if (chart) candidates.push({ mint: m, chart });
    }
    if (!candidates.length) return json({ ok: false, reason: 'no-data' }, 404);
    const pick = spark.pickForDay(day, candidates);
    if (!pick) return json({ ok: false, reason: 'no-pick' }, 404);
    mint = pick.mint;
    tTs = pick.window.tTs;
    await setDayMemo(env, day, mint, tTs);
  }

  // Load the chart (memo path may have a mint but no chart in this request).
  const chart = await sparkChart(env, mint);
  if (!chart) return json({ ok: false, reason: 'no-data' }, 404);

  // BLIND LAW: only bars with ts <= tTs may leave this handler. A bar at
  // exactly tTs is the reveal bar — the client may see it (it is the moment
  // they act on), but nothing after.
  const blind = chart.filter((c) => c.ts <= tTs);
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
 * POST /api/spark/grade
 * Body: { day, mint, actions: [{type:'buy'|'sell', ts}] }
 * Verdict: the process-grade (S/A/B/C/D/F) + the tone axes + the story.
 * Deterministic: same actions + same day => same grade. No PnL figure ever.
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
  const chart = await sparkChart(env, mint);
  if (!chart) return json({ ok: false, reason: 'no-data' }, 404);

  const valid = spark.validateActions(actions, memo.tTs);
  if (!valid || !valid.ok) {
    return json({ ok: false, reason: valid && valid.error ? valid.error : 'invalid-actions' }, 400);
  }
  const verdict = spark.gradeRun(valid, chart, memo.tTs);
  if (verdict.error) return json({ ok: false, reason: verdict.error }, 400);
  return json({ ok: true, day, mint, verdict });
}

module.exports = { handleSparkToday, handleSparkGrade, dayKey, candidateMints, dayMemo, setDayMemo, sparkChart };