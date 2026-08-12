/* PaperTrench server — historical candle source (GeckoTerminal adapter).
 *
 * pricing.js asks one question: "what USD range did this token — and SOL —
 * trade in during this minute?" This adapter answers it from GeckoTerminal's
 * free OHLCV API with a D1 cache in front, because historical minutes never
 * change: one popular mint's minute, fetched once, serves every verifier
 * forever.
 *
 * Budget honesty: the free tier allows ~30 calls/min. The cron drains pricing
 * work under a per-run lookup budget, so a burst of submissions queues
 * instead of hammering the API. A mint with no pool or no candle data yields
 * null → pricing marks those fills 'no-data' (never a pass, never a fail).
 */
'use strict';

/**
 * Two hosts serve the same on-chain candle data, and only one of them can be
 * given a quota.
 *
 * api.geckoterminal.com is keyless and rate-limits by IP — which is fatal
 * here, because Cloudflare Workers egress from addresses shared with every
 * other Worker on the platform, so the quota is already spent by strangers
 * and it answers 429 more or less permanently. Verified: it also returns 200
 * for a request carrying a deliberately bogus API key, i.e. it ignores keys
 * entirely, so no header can rescue it.
 *
 * The identical dataset is exposed under CoinGecko's keyed API at
 * /api/v3/onchain, which 401s without a key — proof the key is actually read
 * there. A free Demo key therefore moves the quota from "whoever shares this
 * IP" to this account, which is the whole fix.
 */
const GT_KEYLESS = 'https://api.geckoterminal.com/api/v2';
const GT_DEMO = 'https://api.coingecko.com/api/v3/onchain';
const GT_PRO = 'https://pro-api.coingecko.com/api/v3/onchain';

/** Base URL and auth header for whatever credentials this deploy has. */
function endpoint(env) {
  if (env && env.GECKO_PRO_KEY) {
    return { base: GT_PRO, header: 'x-cg-pro-api-key', key: env.GECKO_PRO_KEY };
  }
  if (env && env.GECKO_API_KEY) {
    return { base: GT_DEMO, header: 'x-cg-demo-api-key', key: env.GECKO_API_KEY };
  }
  return { base: GT_KEYLESS, header: null, key: null };
}
// Raydium SOL/USDC — the deepest, oldest SOL pool; used for SOL/USD minutes.
const SOL_USD_POOL = '58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2';
const SOL_KEY = '__SOL_USD__';
const NO_DATA_RETRY_MS = 6 * 60 * 60 * 1000;
const POOL_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Fetch a PATH, resolved against whichever host this deploy has credentials
 * for. Without a key that is the keyless GeckoTerminal host, which works but
 * shares an IP quota with every other Cloudflare Worker; with one it is
 * CoinGecko's keyed mirror of the same data.
 */
async function gtJson(env, path) {
  const { base, header, key } = endpoint(env);
  const headers = { Accept: 'application/json' };
  if (header && key) headers[header] = key;
  const res = await fetch(base + path, { headers });
  if (res.status === 429) {
    const err = new Error('candle-source-rate-limited');
    err.rateLimited = true;
    throw err;
  }
  if (!res.ok) return null;
  return res.json();
}

/** Top pool for a mint, cached in D1 with a TTL (young tokens gain pools). */
async function poolFor(env, mint) {
  const now = Date.now();
  const cached = await env.DB.prepare('SELECT pool_id, fetched_at FROM pools WHERE mint = ?')
    .bind(mint).first();
  if (cached && (cached.pool_id || now - cached.fetched_at < POOL_TTL_MS)) {
    return cached.pool_id || null;
  }
  const data = await gtJson(env, `/networks/solana/tokens/${encodeURIComponent(mint)}/pools?page=1`);
  const pool = data && Array.isArray(data.data) && data.data[0]
    ? String(data.data[0].attributes.address) : null;
  await env.DB.prepare(`
    INSERT INTO pools (mint, pool_id, fetched_at) VALUES (?, ?, ?)
    ON CONFLICT(mint) DO UPDATE SET pool_id = excluded.pool_id, fetched_at = excluded.fetched_at`)
    .bind(mint, pool, now).run();
  return pool;
}

/**
 * A WINDOW of minute candles, not one minute.
 *
 * The endpoint returns up to 1000 candles for the same single request, and the
 * original code asked for five and used one. That made API cost scale with
 * FILLS, which the free quota cannot survive: a 40-fill record burned ~80
 * calls, and one series — SOL/USD — was re-fetched for every distinct minute
 * anyone had ever traded in.
 *
 * Asking for the maximum instead costs the same one request and covers ~16
 * hours of that pool. Since historical minutes never change and the D1 cache
 * is permanent, cost now scales with UNIQUE MINTS rather than fills — and a
 * memecoin's whole tradeable life usually fits inside a single window. The
 * SOL/USD series is shared by every record on the platform, so it collapses
 * to roughly one call per 16 hours forever.
 */
const OHLCV_WINDOW = 1000;

async function ohlcvWindow(env, pool, minuteTs) {
  // before_timestamp returns candles strictly BEFORE it, newest first, so
  // anchoring a full window ahead of the target makes the target the OLDEST
  // candle in the range — which covers a record moving forward in time.
  const beforeSec = Math.floor(minuteTs / 1000) + OHLCV_WINDOW * 60;
  const data = await gtJson(env,
    `/networks/solana/pools/${encodeURIComponent(pool)}/ohlcv/minute` +
    `?aggregate=1&before_timestamp=${beforeSec}&limit=${OHLCV_WINDOW}&currency=usd`);
  const rows = data && data.data && data.data.attributes && data.data.attributes.ohlcv_list;
  if (!Array.isArray(rows)) return null;
  const out = new Map();
  for (const row of rows) {
    // [ts, open, high, low, close, volume]
    const high = Number(row[2]);
    const low = Number(row[3]);
    if (high > 0 && low > 0) out.set(Number(row[0]) * 1000, { low, high });
  }
  return out;
}

/** One cache row. */
function upsertCandle(env, key, minuteTs, value, now) {
  return env.DB.prepare(`
    INSERT INTO candle_cache (mint, minute_ts, candles_json, fetched_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(mint, minute_ts) DO UPDATE SET
      candles_json = excluded.candles_json, fetched_at = excluded.fetched_at`)
    .bind(key, minuteTs, value ? JSON.stringify(value) : null, now);
}

/**
 * Read one minute from cache, and on a miss fetch a whole window and store all
 * of it. `fetchWindow` returns a Map of minuteTs -> {low,high} (or null).
 *
 * The requested minute is written even when the window did not contain it:
 * inside a covered range, an absent minute means the pool genuinely did not
 * trade then, and recording that stops the same empty minute being re-fetched
 * on every cron tick forever.
 */
async function cachedCandle(env, key, minuteTs, fetchWindow) {
  const now = Date.now();
  const hit = await env.DB.prepare(
    'SELECT candles_json, fetched_at FROM candle_cache WHERE mint = ? AND minute_ts = ?')
    .bind(key, minuteTs).first();
  if (hit) {
    const value = hit.candles_json ? JSON.parse(hit.candles_json) : null;
    if (value || now - hit.fetched_at < NO_DATA_RETRY_MS) return { value, fromCache: true };
  }

  const window = await fetchWindow();
  const value = (window && window.get(minuteTs)) || null;

  const writes = [upsertCandle(env, key, minuteTs, value, now)];
  if (window) {
    for (const [ts, candle] of window) {
      if (ts !== minuteTs) writes.push(upsertCandle(env, key, ts, candle, now));
    }
  }
  // D1 batches are bounded; a full 1000-candle window is chunked rather than
  // sent as one enormous statement list.
  for (let i = 0; i < writes.length; i += 100) {
    await env.DB.batch(writes.slice(i, i + 100));
  }
  return { value, fromCache: false };
}

/**
 * The getCandles function pricing.js consumes, bound to this environment.
 * Counts real API hits into `budget` ({ used, max }) and throws
 * 'candle-budget-exhausted' when the run's budget is gone, which the cron
 * treats as "stop here, resume next run".
 */
function makeGetCandles(env, budget) {
  return async function getCandles(mint, minuteTs, chain) {
    // Fail CLOSED on any chain this adapter cannot price (DEFECT L-09). Both
    // lookups below are Solana-only — the pool resolver queries the Solana
    // network and the conversion series is SOL/USD — so answering for another
    // chain would judge the fill against a market it never traded in. Null
    // means 'no-data': the fill never counts as verified, and it spends none
    // of the budget. Absent chain is a v1 link, which predates multichain
    // and can only be Solana.
    if (chain && chain !== 'solana') return null;
    const spend = async (fn) => {
      if (budget.used >= budget.max) throw new Error('candle-budget-exhausted');
      const result = await fn();
      return result;
    };

    const sol = await cachedCandle(env, SOL_KEY, minuteTs, () =>
      spend(() => ohlcvWindow(env, SOL_USD_POOL, minuteTs)));
    if (!sol.fromCache) budget.used++;

    const token = await cachedCandle(env, mint, minuteTs, async () => {
      const pool = await spend(() => poolFor(env, mint));
      if (!pool) return null;
      return spend(() => ohlcvWindow(env, pool, minuteTs));
    });
    if (!token.fromCache) budget.used++;

    if (!token.value || !sol.value) return null;
    return { tokenUsd: token.value, solUsd: sol.value };
  };
}

module.exports = { makeGetCandles, SOL_USD_POOL };
