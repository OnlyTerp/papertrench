/* PaperTrench server — fill re-pricing policy.
 *
 * This is the step that actually stops fabrication (LEADERBOARD.md). A chain
 * proves ordering and internal consistency; only comparing every fill against
 * independent market history proves the prices were real.
 *
 * Pure module: it never fetches. Callers hand it a candle lookup function and
 * it returns per-fill verdicts plus a record-level verdict. Fills are priced
 * in SOL (priceNative = SOL per token); public candle data is USD, so a fill
 * checks out when the SOL price, converted through the SOL/USD range for that
 * same minute, overlaps the token's USD candle range. Interval-vs-interval —
 * a fill is rejected only when NO point in the SOL/USD minute range can
 * reconcile it with the token's traded range.
 *
 * Verdicts are three-state on purpose. "no-data" is not a pass and not a
 * fail: pretending unpriceable fills verified would fake certainty, and
 * failing them would punish users for gaps in public data. Coverage is
 * reported honestly and the record tier reflects it.
 */
'use strict';

/** Multiplicative slack on the token candle range. Covers pool-vs-aggregate
 * quote skew and rounding through the USD conversion — NOT wick room; the
 * candle's own high/low already bound the wicks. */
const DEFAULT_TOLERANCE = 0.025;

/** Floor of the minute containing ts (ms → ms). */
function minuteOf(ts) {
  return Math.floor(ts / 60000) * 60000;
}

/**
 * Judge one fill against its minute's candles.
 *
 * candles: { tokenUsd: {low, high} | null, solUsd: {low, high} | null }
 * Returns 'ok' | 'implausible' | 'no-data'.
 */
function judgeFill(fill, candles, tolerance) {
  const tol = Number(tolerance) > 0 ? Number(tolerance) : DEFAULT_TOLERANCE;
  const price = Number(fill.priceNative) || 0;
  if (!(price > 0)) return 'implausible';
  const tok = candles && candles.tokenUsd;
  const sol = candles && candles.solUsd;
  if (!tok || !sol || !(tok.low > 0) || !(sol.low > 0)) return 'no-data';

  // The fill's implied USD range across the minute's SOL/USD range.
  const fillLow = price * sol.low;
  const fillHigh = price * sol.high;
  const tokLow = tok.low * (1 - tol);
  const tokHigh = tok.high * (1 + tol);
  return fillLow <= tokHigh && fillHigh >= tokLow ? 'ok' : 'implausible';
}

/**
 * Re-price a whole chain.
 *
 * getCandles(mint, minuteTs, chain) -> Promise<{tokenUsd, solUsd} | null>;
 * the caller owns caching and rate limits. maxLookups bounds work per call so
 * a runtime can verify incrementally; fills beyond the budget stay 'unpriced'
 * and the caller re-enters with the returned cursor.
 *
 * The chain rides along because v2 links commit one (DEFECT L-09): the
 * lookup used to be hardcoded to Solana's candle network, so a fill honestly
 * committed to any other chain would have been judged against a network its
 * token never traded on. No such fill exists yet — the extension's
 * multichain gate has been closed since v3.0.0 — but the chain field is
 * attacker-writable the day the gate opens, so the verifier resolves candles
 * for the chain the fill actually commits to, and a chain it cannot price is
 * answered 'no-data', never a pass. Absent chain means a v1 link, which
 * could only ever be Solana.
 */
async function priceChain(links, getCandles, opts) {
  const options = opts || {};
  const tolerance = options.tolerance;
  const maxLookups = Number(options.maxLookups) > 0 ? Number(options.maxLookups) : Infinity;
  const startAt = Number(options.startAt) > 0 ? Number(options.startAt) : 0;

  const list = Array.isArray(links) ? links : [];
  const verdicts = [];
  const cache = new Map(); // per-call memo: one lookup per (mint, minute)
  let lookups = 0;
  let cursor = list.length;
  let paused = false;

  for (let i = startAt; i < list.length; i++) {
    const link = list[i];
    const chain = typeof link.chain === 'string' && link.chain ? link.chain : 'solana';
    const key = chain + '|' + String(link.mint) + '|' + minuteOf(Number(link.ts) || 0);
    if (!cache.has(key)) {
      if (lookups >= maxLookups) { cursor = i; paused = true; break; }
      lookups++;
      let candles;
      try {
        candles = await getCandles(String(link.mint), minuteOf(Number(link.ts) || 0), chain);
      } catch (err) {
        // Failing to ASK is not evidence of absence. A thrown lookup means
        // exhausted budget, an upstream rate limit, or a network fault — none
        // of which tell us anything about whether the token traded. Recording
        // 'no-data' here would silently convert an infrastructure problem into
        // a permanent claim about the market, and would skip the re-pricing
        // gate that is the only real defence against fabricated fills. Pause
        // instead and resume from this exact index next run.
        cursor = i;
        paused = true;
        break;
      }
      // A null RESULT is different: the source answered, and there is no
      // public candle for that mint-minute. That genuinely is 'no-data'.
      cache.set(key, candles);
    }
    verdicts.push({ index: i, id: link.id, verdict: judgeFill(link, cache.get(key), tolerance) });
  }

  // Done means "reached the end of the list" — a resumed run (startAt > 0)
  // only ever judges the tail, so counting verdicts would never finish.
  return {
    done: !paused,
    cursor: paused ? cursor : list.length,
    lookups,
    verdicts,
  };
}

/**
 * Fold per-fill verdicts into a record verdict.
 *
 * Any implausible fill rejects the record — a price that never existed is
 * fabrication, not noise; the tolerance already absorbed the noise. Coverage
 * then decides the tier: >= minCoverage priced → 'verified', anything less →
 * 'partial' (shown, labeled, never ranked as fully verified).
 */
function recordVerdict(verdicts, opts) {
  const options = opts || {};
  const minCoverage = Number(options.minCoverage) > 0 ? Number(options.minCoverage) : 0.8;
  const list = Array.isArray(verdicts) ? verdicts : [];
  const implausible = list.filter((v) => v.verdict === 'implausible');
  const ok = list.filter((v) => v.verdict === 'ok');
  const noData = list.filter((v) => v.verdict === 'no-data');
  const coverage = list.length ? ok.length / list.length : 0;
  let status;
  if (implausible.length) status = 'rejected';
  else if (!list.length) status = 'partial';
  else if (coverage >= minCoverage) status = 'verified';
  else status = 'partial';
  return {
    status,
    coverage,
    counts: { ok: ok.length, implausible: implausible.length, noData: noData.length },
    implausible: implausible.slice(0, 20), // enough to show, bounded to store
  };
}

module.exports = { DEFAULT_TOLERANCE, minuteOf, judgeFill, priceChain, recordVerdict };
