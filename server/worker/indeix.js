/* PaperTrench server — Indeix adapter (Worker side).
 *
 * Live fill witnesses use whole-token quotes; real-trade replays use OHLCV
 * candles and trades (each carrying sender wallet, side, USD + SOL amounts).
 * All come from the same provider as TrenchBrain. The key is a
 * Worker secret (env.INDEIX_API_KEY), exactly as TrenchBrain keeps it in a
 * root-owned file — never in the browser, never in source.
 *
 * Replay accounting (wallet PnL and the replay curve) lives in core/replay.js.
 * Price batches stay in USD/SOL per WHOLE token; TrenchBrain's raw-unit fold
 * is not the extension's quote contract.
 *
 * Every price batch and replay has a per-request upstream budget.
 * Replay history usually takes a handful of calls (candles + trades windows).
 * `budget` object ({used,max}) bounds a single request's upstream spend.
 */
'use strict';

const BASE_URL = 'https://api.indeix.com';
const WSOL = 'So11111111111111111111111111111111111111112';
const PRICE_CACHE_TTL_SEC = 10;

// Public slugs resolve here only; quote and candle callers share this vocabulary.
const CHAIN_IDS = Object.freeze({
  solana: 'solana',
  bnb: 'evm:56',
  robinhood: 'evm:4663',
  ethereum: 'evm:1',
  base: 'evm:8453',
});

// Dexscreener chain slugs for the EVM fallback lane. Indeix's coverage of
// young EVM tokens — especially Robinhood — is thin (live 2026-09-12: every
// reported RH token quoted {}), and an EVM fill has NO chain-RPC witness,
// so the worker quote is its only second source. Dexscreener is free,
// keyless, and already the extension's EVM resolve upstream: the honest
// fallback, not a new dependency class. Solana never falls back here (it
// has the chain witness and Jupiter).
const DEXSCREENER_IDS = Object.freeze({ bnb: 'bsc', robinhood: 'robinhood', ethereum: 'ethereum', base: 'base' });
const DEXSCREENER_BASE_URL = 'https://api.dexscreener.com';

/**
 * Fetch a path from Indeix with one retry on the transient 5xx family that
 * their history endpoints are prone to (504 measured 100%-flaky during a
 * provider outage — TrenchBrain treats {429,500,502,503,504} as retryable and
 * retries). A 5xx that survives the retry is typed `indeix-degraded` so the
 * route can say "temporarily unavailable" rather than lying "no data".
 */
async function indeixJson(env, method, path, params, budget, retries = 3) {
  const key = env && env.INDEIX_API_KEY;
  if (!key) {
    const err = new Error('indeix-not-configured');
    err.code = 'indeix-not-configured';
    throw err;
  }
  const url = new URL(BASE_URL + path);
  const postBody = method === 'POST' ? JSON.stringify(params || {}) : undefined;
  if (method === 'GET') {
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  let lastStatus = 0;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (budget && budget.used >= budget.max) {
      const err = new Error('indeix-budget-exhausted');
      err.code = 'indeix-budget-exhausted';
      throw err;
    }
    // Reserve before awaiting: retries, failed fetches and concurrent calls
    // sharing this budget each spend one slot, never more than max.
    if (budget) budget.used++;
    const res = await fetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
        'User-Agent': 'PaperTrench/Replay-1.0',
        ...(postBody === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(postBody === undefined ? {} : { body: postBody }),
    });
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
    // down — retry before concluding it's degraded. Measured during the 8/25
    // outages: flapping tiers still answer ~1-in-4, so extra attempts convert
    // many user-visible failures into slow successes.
    if (res.status >= 500 && res.status < 600) {
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
        continue;
      }
      // Last resort: serve the edge-cached copy of this exact upstream call
      // if one exists. Stale real data beats no data — the response carries
      // no fabrication, it is simply the last truth we saw.
      const cached = method === 'GET' && await cacheGet(url.toString());
      if (cached) return cached;
      const err = new Error('indeix-degraded');
      err.code = 'indeix-degraded';
      err.status = res.status;
      throw err;
    }
    if (!res.ok) return null;
    const body = await res.json();
    // GET history keeps its outage cache. POST quotes cache their normalized
    // answer in prices(), keyed on the batch and with a short, honest age.
    if (method === 'GET') {
      try { await cachePut(url.toString(), body); } catch { /* best effort */ }
    }
    return body;
  }
  // Unreachable: the loop either returns or throws on its final attempt.
  const err = new Error('indeix-degraded');
  err.code = 'indeix-degraded';
  err.status = lastStatus;
  throw err;
}

/* Edge cache for upstream answers, keyed on a synthetic GET (the Cache API
 * ignores non-GET). History defaults to 6h; live price batches use 10s.
 * Both helpers are no-ops where `caches` is absent (node tests). */
const CACHE_TTL_SEC = 6 * 3600;
/* Volatile params (to=Date.now()) would make every call a unique key and the
 * fallback would never hit — caught by the outage-replay test. Strip them. */
const CACHE_KEY_IGNORE = new Set(['to']);
function cacheKey(upstreamUrl) {
  const u = new URL(upstreamUrl);
  for (const k of CACHE_KEY_IGNORE) u.searchParams.delete(k);
  u.searchParams.sort();
  return new Request('https://indeix-cache.papertrench.internal/' +
    encodeURIComponent(u.toString()));
}
async function cachePut(upstreamUrl, body, ttlSec = CACHE_TTL_SEC) {
  if (typeof caches === 'undefined' || !caches.default) return;
  await caches.default.put(cacheKey(upstreamUrl), new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${ttlSec}` },
  }));
}
async function cacheGet(upstreamUrl) {
  if (typeof caches === 'undefined' || !caches.default) return null;
  const hit = await caches.default.match(cacheKey(upstreamUrl));
  if (!hit) return null;
  try { return await hit.json(); } catch { return null; }
}

/** A missing, errored or non-finite provider figure is never a zero quote. */
function positiveNumber(value) {
  const n = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** One Dexscreener batch for the mints Indeix could not price, or null.
 *
 * GET /tokens/v1/{chain}/{addr,addr} answers a bare pairs array (verified
 * live 2026-09-12 against a Robinhood token). Per mint we take the deepest-
 * liquidity pair quoting it as BASE — a token that only appears as someone
 * else's quote leg does not vouch for its own price. Keyed by the REQUEST
 * string so the caller's round-trip lookup holds under any casing.
 * Fail-closed in every direction: non-JSON, non-array, no base match, rate
 * limit, spent budget — all null, and the Indeix partials stand as answered.
 */
async function dexscreenerPrices(mints, budget, chain) {
  const dexChain = DEXSCREENER_IDS[chain];
  if (!dexChain || !mints.length) return null;
  if (budget && budget.used >= budget.max) return null;
  if (budget) budget.used++;
  const url = `${DEXSCREENER_BASE_URL}/tokens/v1/${dexChain}/${mints.map(encodeURIComponent).join(',')}`;
  let res;
  try {
    res = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'PaperTrench/Quote-1.0' },
    });
  } catch { return null; }
  if (!res.ok) return null;
  let pairs;
  try { pairs = await res.json(); } catch { return null; }
  if (!Array.isArray(pairs)) return null;
  const byMint = new Map();
  for (const p of pairs) {
    const base = p && p.baseToken && p.baseToken.address;
    if (typeof base !== 'string') continue;
    const priceUsd = positiveNumber(p.priceUsd);
    if (priceUsd === null) continue;
    const liq = Number(p && p.liquidity && p.liquidity.usd);
    const key = base.toLowerCase();
    const prev = byMint.get(key);
    if (prev && !(liq > prev.liq)) continue;
    byMint.set(key, {
      priceUsd,
      mcapUsd: positiveNumber(p.marketCap),
      fdvUsd: positiveNumber(p.fdv),
      liq: Number.isFinite(liq) ? liq : 0,
    });
  }
  if (!byMint.size) return null;
  const quotes = {};
  for (const mint of mints) {
    const hit = byMint.get(String(mint).toLowerCase());
    if (!hit) continue;
    quotes[mint] = {
      priceUsd: hit.priceUsd, priceSol: null,
      mcapUsd: hit.mcapUsd, fdvUsd: hit.fdvUsd,
      source: 'dexscreener', asOf: Date.now(),
    };
  }
  return quotes;
}

/** Batched whole-token prices: USD for every chain, SOL only for Solana. */
async function prices(env, mints, budget, chain = 'solana') {
  if (!Object.hasOwn(CHAIN_IDS, chain)) throw new Error('indeix-unknown-chain');
  const chainId = CHAIN_IDS[chain];
  const isSolana = chain === 'solana';
  const normalized = [...new Set(mints)].sort();
  const upstreamUrl = new URL(BASE_URL + '/2/token/price');
  upstreamUrl.searchParams.set('mints', normalized.join(','));
  upstreamUrl.searchParams.set('chain', chain);
  const cached = await cacheGet(upstreamUrl.toString());
  if (cached) return cached;

  // Keep the anchor last even when WSOL is itself requested; never request it
  // twice or shift the positional mapping by filtering errored payload items.
  const addresses = isSolana ? normalized.filter((mint) => mint !== WSOL) : normalized;
  const solIndex = addresses.length;
  if (isSolana) addresses.push(WSOL);
  const data = await indeixJson(env, 'POST', '/2/token/price', {
    items: addresses.map((address) => ({ chainId, address })),
  }, budget);
  if (!data || data.error || !Array.isArray(data.payload)) {
    throw new Error('indeix-price-shape');
  }
  const solItem = isSolana ? data.payload[solIndex] : null;
  const solUsd = solItem && !solItem.error ? positiveNumber(solItem.priceUSD) : null;
  const asOf = Date.now();
  const quotes = {};
  const end = normalized.includes(WSOL) ? addresses.length : solIndex;
  for (let i = 0; i < end; i++) {
    const item = data.payload[i];
    if (!item || item.error) continue;
    const priceUsd = positiveNumber(item.priceUSD);
    if (priceUsd === null) continue;
    const priceSol = !isSolana || solUsd === null ? null : positiveNumber(priceUsd / solUsd);
    quotes[addresses[i]] = {
      priceUsd, priceSol,
      mcapUsd: positiveNumber(item.marketCapUSD),
      fdvUsd: positiveNumber(item.marketCapDilutedUSD),
      source: 'indeix', asOf,
    };
  }
  // EVM-only gap fill: mints Indeix could not price get one Dexscreener
  // batch before we answer. Without this an unindexed token refuses every
  // divergent fill with "no second source" — the live RH outage. (An
  // Indeix outage itself still 503s: a wholesale provider swap would
  // silently change witness semantics, while a gap fill only completes an
  // answer Indeix already gave.)
  if (!isSolana) {
    const missing = normalized.filter((mint) => !Object.hasOwn(quotes, mint));
    if (missing.length) {
      const fallback = await dexscreenerPrices(missing, budget, chain).catch(() => null);
      if (fallback) {
        for (const [mint, q] of Object.entries(fallback)) {
          if (!Object.hasOwn(quotes, mint)) quotes[mint] = { ...q, asOf };
        }
      }
    }
  }
  const answer = { asOf, quotes };
  try { await cachePut(upstreamUrl.toString(), answer, PRICE_CACHE_TTL_SEC); } catch { /* best effort */ }
  return answer;
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

const api = { indeixJson, prices, ohlcv, trades, candlesByMinute, BASE_URL, CHAIN_IDS };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
