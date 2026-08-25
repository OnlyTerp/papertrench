/* PaperTrench server — Indeix adapter (Worker side).
 *
 * The real-trade replay feature needs two things Indeix already serves (the
 * same TrenchBrain integration uses): the token's OHLCV candles and its trades
 * (each carrying the sender wallet, side, USD + SOL amounts). The key is a
 * Worker secret (env.INDEIX_API_KEY), exactly as TrenchBrain keeps it in a
 * root-owned file — never in the browser, never in source.
 *
 * This is transport + budget only. What the numbers MEAN (the wallet's PnL,
 * the replay curve) lives in core/replay.js, which runs identically under
 * `node --test`. Anything deciding whether a figure is honest is in core/.
 *
 * Budget honesty: the Worker is behind a per-IP rate limit (see worker/index.js)
 * and each replay is a handful of calls (1 candles + 1-2 trades windows). A
 * `budget` object ({used,max}) bounds a single request's upstream spend.
 */
'use strict';

const BASE_URL = 'https://api.indeix.com';

/**
 * Fetch a path from Indeix with one retry on the transient 5xx family that
 * their history endpoints are prone to (504 measured 100%-flaky during a
 * provider outage — TrenchBrain treats {429,500,502,503,504} as retryable and
 * retries). A 5xx that survives the retry is typed `indeix-degraded` so the
 * route can say "temporarily unavailable" rather than lying "no data".
 */
async function indeixJson(env, method, path, params, budget, retries = 1) {
  const key = env && env.INDEIX_API_KEY;
  if (!key) {
    const err = new Error('indeix-not-configured');
    err.code = 'indeix-not-configured';
    throw err;
  }
  if (budget && budget.used >= budget.max) {
    const err = new Error('indeix-budget-exhausted');
    err.code = 'indeix-budget-exhausted';
    throw err;
  }
  const url = new URL(BASE_URL + path);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  let lastStatus = 0;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
        'User-Agent': 'PaperTrench/Replay-1.0',
      },
    });
    if (budget) budget.used++;
    lastStatus = res.status;
    if (res.status === 401 || res.status === 403) {
      const err = new Error('indeix-auth-failed');
      err.code = 'indeix-auth-failed';
      throw err;
    }
    if (res.status === 429) {
      const err = new Error('indeix-rate-limited');
      err.code = 'indeix-rate-limited';
      err.rateLimited = true;
      throw err;
    }
    // A 5xx is the provider's own backend timing out (504) or being briefly
    // down — retry once before concluding it's degraded.
    if (res.status >= 500 && res.status < 600) {
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
        continue;
      }
      const err = new Error('indeix-degraded');
      err.code = 'indeix-degraded';
      err.status = res.status;
      throw err;
    }
    if (!res.ok) return null;
    return res.json();
  }
  // Unreachable: the loop either returns or throws on its final attempt.
  const err = new Error('indeix-degraded');
  err.code = 'indeix-degraded';
  err.status = lastStatus;
  throw err;
}

/**
 * Token OHLCV candles (1m) from launch-ish to now. Mirrors TrenchBrain's call.
 * `fromTs` is seconds; the API wants ms. `amount` caps the candle count.
 */
async function ohlcv(env, chainId, mint, fromTsSec, budget, amount = 720) {
  const data = await indeixJson(env, 'GET', '/2/token/ohlcv-history', {
    chainId, address: mint, period: '1m',
    from: Math.floor(fromTsSec) * 1000,
    to: Date.now(),
    amount, usd: 'true', fill: 'false',
  }, budget);
  if (!data) return null;
  // Normalize to the shape core/replay.js expects: [{ts(ms),o,h,l,c,v}].
  const items = Array.isArray(data) ? data : (data.data || data.items || []);
  const out = [];
  for (const it of items) {
    const o = Number(it.o ?? it.open), h = Number(it.h ?? it.high),
      l = Number(it.l ?? it.low), c = Number(it.c ?? it.close);
    const ts = Number(it.t ?? it.ts ?? it.time);
    if (Number.isFinite(ts) && h > 0 && l > 0) out.push({ ts: ts < 1e12 ? ts * 1000 : ts, o, h, l, c, v: Number(it.v ?? it.volume) || 0 });
  }
  return out;
}

/**
 * Trades for a mint, newest-first, each carrying the sender wallet. Mirrors
 * TrenchBrain's call (limit 50; 100 measured 504). Returns normalized fills.
 */
async function trades(env, chainId, mint, budget, limit = 50) {
  const data = await indeixJson(env, 'GET', '/2/token/trades', {
    chainId, address: mint, mode: 'asset', limit, sortOrder: 'desc',
  }, budget);
  if (!data) return null;
  const items = Array.isArray(data) ? data : (data.data || data.items || []);
  return items;
}

/** Aligned candles keyed by minute (ms), for unpriced-transfer marking. */
function candlesByMinute(candles) {
  const m = new Map();
  for (const c of (candles || [])) {
    const t = Number(c.ts);
    const ts = t < 1e12 ? t * 1000 : t;
    m.set(Math.floor(ts / 60000) * 60000, c);
  }
  return m;
}

const api = { indeixJson, ohlcv, trades, candlesByMinute, BASE_URL };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
