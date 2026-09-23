/* PaperTrench server — fill re-pricing policy.
 *
 * This is the step that actually stops fabrication (LEADERBOARD.md). A chain
 * proves ordering and internal consistency; only comparing every fill against
 * independent market history proves the prices were real.
 *
 * Pure module: it never fetches. Callers hand it a candle lookup function and
 * it returns per-fill verdicts plus a record-level verdict. Fills are priced
 * in SOL-book units (priceNative = SOL per token), including EVM fills; public
 * candles are USD. A fill checks out when its committed price, converted
 * through the SOL/USD range for that same minute, overlaps its own chain's
 * token USD candle range. Interval-vs-interval — a fill is rejected only when
 * no point in those independent historical ranges reconciles its price.
 *
 * Verdicts are three-state on purpose. "no-data" is not a pass and not a
 * fail: pretending unpriceable fills verified would fake certainty, and
 * failing them would punish users for gaps in public data. Coverage is
 * reported honestly and the record tier reflects it.
 */
'use strict';

const { chainOf } = require('./chain.js');

/** Multiplicative slack on the token candle range. Covers pool-vs-aggregate
 * quote skew and rounding through the USD conversion — NOT wick room; the
 * candle's own high/low already bound the wicks. */
const DEFAULT_TOLERANCE = 0.025;

/** Floor of the minute containing ts (ms → ms). */
function minuteOf(ts) {
  return Math.floor(ts / 60000) * 60000;
}

/** The native-price interval consistent with the USD and SOL/USD candle ranges. */
function nativePriceRangeFromCandles(candles, tolerance) {
  const tok = candles && candles.tokenUsd;
  const sol = candles && candles.solUsd;
  if (!tok || !sol) return null;
  const tokLow = Number(tok.low), tokHigh = Number(tok.high);
  const solLow = Number(sol.low), solHigh = Number(sol.high);
  if (!(tokLow > 0) || !(tokHigh >= tokLow) || !(solLow > 0) || !(solHigh >= solLow)) return null;
  const tol = Number(tolerance) > 0 ? Number(tolerance) : DEFAULT_TOLERANCE;
  const range = {
    low: tokLow * (1 - tol) / solHigh,
    high: tokHigh * (1 + tol) / solLow,
  };
  return Number.isFinite(range.low) && Number.isFinite(range.high) && range.high >= range.low
    ? range : null;
}

const VERDICT_CODES = { ok: 'o', 'no-data': 'n', implausible: 'i' };
const CODE_VERDICTS = { o: 'ok', n: 'no-data', i: 'implausible' };

/** Per-fill verdicts fit in one byte each while preserving resumable prefixes. */
function compactVerdicts(verdicts) {
  if (!Array.isArray(verdicts)) return null;
  let codes = '';
  for (const item of verdicts) {
    const verdict = item && item.verdict;
    if (!Object.hasOwn(VERDICT_CODES, verdict)) return null;
    codes += VERDICT_CODES[verdict];
  }
  return codes;
}

/** Restore compact or pre-existing object verdicts against the stored chain. */
function expandVerdicts(encoded, links) {
  const chain = Array.isArray(links) ? links : [];
  if (Array.isArray(encoded)) {
    return encoded.every((item, index) => item && Number(item.index) === index
      && Object.hasOwn(VERDICT_CODES, item.verdict)) ? encoded : null;
  }
  if (typeof encoded !== 'string' || encoded.length > chain.length) return null;
  const out = [];
  for (let index = 0; index < encoded.length; index++) {
    const code = encoded[index];
    if (!Object.hasOwn(CODE_VERDICTS, code)) return null;
    const verdict = CODE_VERDICTS[code];
    out.push({ index, id: chain[index] && chain[index].id, verdict });
  }
  return out;
}

/**
 * Judge one fill against its minute's candles.
 *
 * candles: { tokenUsd: {low, high} | null, solUsd: {low, high} | null }
 * Returns 'ok' | 'implausible' | 'no-data'.
 */
function judgeFill(fill, candles, tolerance) {
  const price = Number(fill.priceNative) || 0;
  if (!(price > 0)) return 'implausible';
  const range = nativePriceRangeFromCandles(candles, tolerance);
  if (!range) return 'no-data';
  return price >= range.low && price <= range.high ? 'ok' : 'implausible';
}

/**
 * Re-price a whole chain.
 *
 * getCandles(mint, minuteTs, chain) -> Promise<{tokenUsd, solUsd} | null>;
 * the caller owns caching and rate limits. maxLookups bounds work per call so
 * a runtime can verify incrementally; fills beyond the budget stay 'unpriced'
 * and the caller re-enters with the returned cursor.
 *
 * The chain rides along because v2 links commit one (DEFECT L-09). Resolve it
 * through the shared attestation contract: a v1 link's chain label is not
 * hashed and can only mean Solana. Unsupported committed chains get 'no-data',
 * never another chain's market. No uncommitted priceUsd or resolve rate is
 * consulted: historical candles check the priceNative that the fill hashes.
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
    const chain = chainOf(link);
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

module.exports = {
  DEFAULT_TOLERANCE, minuteOf, nativePriceRangeFromCandles,
  compactVerdicts, expandVerdicts,
  judgeFill, priceChain, recordVerdict,
};
