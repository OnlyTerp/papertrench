/* predict-sites.test.js — URL gating locks for prediction venues
 *
 * Verifies that detect() correctly gates which pages mount each venue's
 * adapter and refuses non-market surfaces (homepage, portfolio, etc.).
 *
 * Framework: node:test + node:assert/strict (no deps).
 */
const test = require('node:test');
const assert = require('node:assert/strict');

/* Bootstrap: the module attaches to window in a browser-ish IIFE; fake it. */
global.window = global.window || {};
require('../predict-sites.js');
const S = global.window.PaperPredictSites;

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

/**
 * Parse a bare "host/path..." string into { host, pathname } matching
 * how content scripts feed detect().  A leading slash on the host is
 * absent (e.g. "kalshi.com/markets/kxgdp").
 */
function url(s) {
  const i = s.indexOf('/');
  if (i === -1) return { host: s, pathname: '/' };
  return { host: s.slice(0, i), pathname: s.slice(i) };
}

/* ================================================================== */
/*  1. Kalshi — must-mount pages                                      */
/* ================================================================== */

test('Kalshi — series page /markets/kxelonmars → refused (list page, not a market)', () => {  const u = url('kalshi.com/markets/kxelonmars');  assert.equal(S.detect(u.host, u.pathname), null);});

test('Kalshi — deep market /markets/kxelonmars/elon-mars/kxelonmars-99', () => {
  const u = url('kalshi.com/markets/kxelonmars/elon-mars/kxelonmars-99');
  assert.deepEqual(S.detect(u.host, u.pathname), {
    venue: 'kalshi',
    marketId: 'kxelonmars-99',
    verified: true,
  });
});

test('Kalshi — GDP market /markets/kxgdp/us-gdp-growth/kxgdp-26oct30', () => {
  const u = url('kalshi.com/markets/kxgdp/us-gdp-growth/kxgdp-26oct30');
  assert.deepEqual(S.detect(u.host, u.pathname), {
    venue: 'kalshi',
    marketId: 'kxgdp-26oct30',
    verified: true,
  });
});

/* ================================================================== */
/*  2. Kalshi — must-refuse pages                                     */
/* ================================================================== */

test('Kalshi — refuse homepage kalshi.com', () => {
  assert.equal(S.detect('kalshi.com', '/'), null);
});

test('Kalshi — refuse portfolio /portfolio', () => {
  assert.equal(S.detect('kalshi.com', '/portfolio'), null);
});

test('Kalshi — refuse bare /markets (no segments)', () => {
  assert.equal(S.detect('kalshi.com', '/markets'), null);
});

/* ================================================================== */
/*  3. Polymarket — must-mount pages                                  */
/* ================================================================== */

test('Polymarket — event page /event/bitcoin-above-100000-on-july-31', () => {
  const u = url('polymarket.com/event/bitcoin-above-100000-on-july-31');
  assert.deepEqual(S.detect(u.host, u.pathname), {
    venue: 'polymarket',
    eventSlug: 'bitcoin-above-100000-on-july-31',
    verified: true,
  });
});

/* ================================================================== */
/*  4. Polymarket — must-refuse pages                                 */
/* ================================================================== */

test('Polymarket — refuse homepage polymarket.com', () => {
  assert.equal(S.detect('polymarket.com', '/'), null);
});

test('Polymarket — refuse /portfolio', () => {
  assert.equal(S.detect('polymarket.com', '/portfolio'), null);
});

/* ================================================================== */
/*  5. Hyperliquid outcomes — must-mount pages                        */
/* ================================================================== */

test('Hyperliquid outcomes — /outcomes with title carrying BTC market', () => {
  assert.deepEqual(
    S.detect('app.hyperliquid.xyz', '/outcomes', '64,869 | BTC | Hyperliquid'),
    {
      venue: 'hyperliquid-outcomes',
      market: 'BTC',
      verified: true,
    },
  );
});

test('Hyperliquid outcomes — /outcomes with no title → market: null', () => {
  assert.deepEqual(
    S.detect('app.hyperliquid.xyz', '/outcomes'),
    {
      venue: 'hyperliquid-outcomes',
      market: null,
      verified: true,
    },
  );
});

/* ================================================================== */
/*  6. Hyperliquid — must-refuse pages                                */
/* ================================================================== */

test('Hyperliquid — refuse /trade/SOL (perps, not outcomes)', () => {
  assert.equal(S.detect('app.hyperliquid.xyz', '/trade/SOL'), null);
});

test('Hyperliquid — refuse homepage app.hyperliquid.xyz', () => {
  assert.equal(S.detect('app.hyperliquid.xyz', '/'), null);
});

/* ================================================================== */
/*  7. Limitless — must-mount pages                                   */
/* ================================================================== */

test('Limitless — market /markets/will-btc-hit-100k', () => {
  const u = url('limitless.exchange/markets/will-btc-hit-100k');
  assert.deepEqual(S.detect(u.host, u.pathname), {
    venue: 'limitless',
    marketSlug: 'will-btc-hit-100k',
    verified: true,
  });
});

/* ================================================================== */
/*  8. Limitless — must-refuse pages                                  */
/* ================================================================== */

test('Limitless — refuse homepage limitless.exchange', () => {
  assert.equal(S.detect('limitless.exchange', '/'), null);
});

test('Limitless — refuse /portfolio', () => {
  assert.equal(S.detect('limitless.exchange', '/portfolio'), null);
});

/* ================================================================== */
/*  9. Bounds locks — one char under minimum path segment → null      */
/* ================================================================== */

test('Bounds — Kalshi /markets/x (one segment, needs ≥2)', () => {
  assert.equal(S.detect('kalshi.com', '/markets/x'), null);
});

test('Bounds — Polymarket /event/a (slug too short)', () => {
  assert.equal(S.detect('polymarket.com', '/event/a'), null);
});

test('Bounds — Hyperliquid /outcome (missing trailing s)', () => {
  assert.equal(S.detect('app.hyperliquid.xyz', '/outcome'), null);
});

test('Bounds — Limitless /markets/a (slug too short)', () => {
  assert.equal(S.detect('limitless.exchange', '/markets/a'), null);
});
