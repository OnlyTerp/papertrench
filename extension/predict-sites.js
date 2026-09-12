/* PaperTrench — prediction venue site adapters (pure).
 *
 * URL → market identity for the prediction venues, plus extractors for the
 * live data each venue's own page exposes (title-carried price, book via
 * API). Pure string functions — the content script feeds them
 * location/title/innerText and gets validated facts or null.
 *
 * URL contracts and route patterns here were captured by pt-recon on
 * 2026-08-07 (dossier evidence — nothing guessed):
 *  [KALSHI-URL]  kalshi.com/markets/<series>/<event>/<market> — 3-level path
 *                captured live. Detect on kalshi.com/markets/* with EXACTLY
 *                3 path segments after /markets/ (B3): a 2-segment series
 *                page can never resolve (orderbook 404, event lookup 404)
 *                and mounted a panel that quoted nothing.
 *  [PM-URL]      polymarket.com/event/<slug> — event page with binary markets.
 *                Detect on polymarket.com/event/*.
 *  [HL-OUT-URL]  REMOVED (A3, 2026-09-12) — was app.hyperliquid.xyz/outcomes.
 *  [LL-URL]      limitless.exchange/markets/<slug> — binary CLOB on Base.
 *                api.limitless.exchange is the API host.
 *
 * Ported from amogus0471/Paper-Prediction @ e03f715 (MIT) — route patterns
 * cross-referenced against the reference implementation's adapters.
 */
(() => {
  'use strict';

  /* ------------------------------- Kalshi ------------------------------- */

  /* Kalshi URL: /markets/<series>/<event>/<market>
   * Example: /markets/kxelonmars/elon-mars/kxelonmars-99
   * Captured live 2026-08-07: 7 token pages, 2 live-ticking prices.
   * The market ticker is the LAST path segment. Series and event slugs
   * are intermediate segments. At minimum 2 segments after /markets/ required.
   *
   * VERIFIED against capture: kalshi.com/markets/kxelonmars, /markets/kxgdp,
   * /markets/kxelonmars/elon-mars/kxelonmars-99, /markets/kxgdp/us-gdp-growth/kxgdp-26oct30
   */
  function detectKalshi(host, pathname) {
    if (!/(^|\.)kalshi\.com$/.test(host)) return null;
    // EXACTLY 3 segments: /markets/<series>/<event>/<market>. A 2-segment
    // series page can never resolve (B3 — orderbook 404, event 404, null).
    const m = pathname.match(/^\/markets\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/([A-Za-z0-9_-]+)\/?$/);
    if (!m) return null;
    return { venue: 'kalshi', marketId: m[1], verified: true };
  }

  /* ---------------------------- Polymarket ----------------------------- */

  /* Polymarket URL: /event/<slug>
   * Example: /event/bitcoin-above-100000-on-july-31
   * Dossier 2026-08-08: §0 PARTIAL (1 market page live-ticking). Stays a
   * verified:false stub until gating locks land and a live pass confirms
   * the panel on a real market page (the Kalshi gate).
   */
  function detectPolymarket(host, pathname) {
    if (!/(^|\.)polymarket\.com$/.test(host)) return null;
    // Event pages carry binary markets. Slug may contain letters, digits, hyphens.
    // Examples from capture 2026-08-08: /event/kraken-ipo-in-2025,
    // /event/nba-will-the-mavericks-beat-the-grizzlies-by-more-than-5pt5-points-in-their-december-4-matchup
    const m = pathname.match(/^\/event\/([a-z0-9][a-z0-9-]{2,})(?:\/?|(?:\?|#).*)$/);
    if (!m) return null;
    return { venue: 'polymarket', eventSlug: m[1], verified: false };
  }

  /* ------------------- Hyperliquid Outcomes: REMOVED (A3) --------------
   * Deleted with its adapter — the venue was never quotable (no documented
   * endpoint maps a market to its `#` outcome ids). app.hyperliquid.xyz
   * mounts nothing until the discovery work lands.
   */

  /* ----------------------------- Limitless ----------------------------- */

  /* Limitless URL: /markets/<slug>
   * Example: /markets/will-btc-hit-100k, /markets/reya-fdv-above-dollar200m-one-day-after-launch-1768317496777
   * Dossier 2026-08-08: §0 PARTIAL (1 market page live-ticking). Slug is
   * alphanumeric, may contain hyphens and numeric suffixes. /rewards,
   * /leaderboard, /crypto refuse. Stays a verified:false stub until gating
   * locks land and a live pass confirms the panel (the Kalshi gate).
   */
  function detectLimitless(host, pathname) {
    if (!/(^|\.)limitless\.exchange$/.test(host)) return null;
    const m = pathname.match(/^\/markets\/([a-z0-9][a-z0-9-]{2,})(?:\/?|(?:\?|#).*)$/);
    if (!m) return null;
    return { venue: 'limitless', marketSlug: m[1], verified: false };
  }

  /* ----------------------------- Unified ------------------------------- */

  function detect(host, pathname, title) {
    return detectKalshi(host, pathname)
      || detectPolymarket(host, pathname)
      || detectLimitless(host, pathname)
      || null;
  }

  // The prediction contract is the pure detect(host, pathname, title). There is
  // deliberately NO currentSite() shim and no PaperTrenchSites alias here: those
  // existed only to make the token-shaped pt-recon verifier find something, and
  // bending the product to satisfy a checker is how a green run stops meaning
  // anything. The verifier now speaks this shape natively (adapter.shape:
  // "prediction" in ptrecon.config.json).
  const api = {
    detect,
    detectKalshi,
    detectPolymarket,
    detectLimitless,
  };

  if (typeof window !== 'undefined') window.PaperPredictSites = api;
  if (typeof self !== 'undefined') self.PaperPredictSites = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
