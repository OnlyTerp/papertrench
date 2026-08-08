/* PaperTrench — prediction content script entry.
 *
 * Mounts the prediction overlay on supported venue pages. Runs in the
 * content script context (ISOLATED world) for each prediction venue.
 *
 * Detection: calls PaperPredictSites.detect() on the page's location.
 * If the page matches a prediction market and the master switch is on,
 * loads the trade ticket. Otherwise does nothing.
 *
 * Ported from amogus0471/Paper-Prediction @ e03f715 (MIT).
 */
(() => {
  'use strict';

  /* ── Detection ──────────────────────────────────────────────────── */

  function currentMarket() {
    const loc = window.location;
    return (typeof PaperPredictSites !== 'undefined')
      ? PaperPredictSites.detect(loc.hostname, loc.pathname, document.title)
      : null;
  }

  /* ── Settings check ─────────────────────────────────────────────── */

  let overlayEnabled = true;

  function loadSettings() {
    try {
      const raw = localStorage.getItem('pt_settings');
      if (raw) {
        const s = JSON.parse(raw);
        overlayEnabled = s.overlayEnabled !== false;
      }
    } catch { /* use default */ }
  }

  /* ── SIMULATED badge ────────────────────────────────────────────── */

  function createBadge() {
    const el = document.createElement('div');
    el.textContent = 'SIMULATED · NO REAL MONEY';
    el.style.cssText =
      'position:fixed;bottom:8px;left:8px;z-index:2147483647;' +
      'background:rgba(239,68,68,0.9);color:#fff;font:600 10px/1 monospace;' +
      'padding:2px 6px;border-radius:3px;pointer-events:none;letter-spacing:.5px;';
    return el;
  }

  /* ── Mount ──────────────────────────────────────────────────────── */

  let mounted = false;
  let badge = null;

  function mount() {
    if (mounted) return;
    if (!overlayEnabled) return;

    const market = currentMarket();
    if (!market) return;

    mounted = true;

    // Badge on every price-bearing surface
    badge = createBadge();
    document.body.appendChild(badge);

    // The ticket itself. Without this the whole feature is a red badge: the
    // engine, the scoring and the venue adapters all exist and are tested, but
    // nothing ever puts a panel on the page. The automated live pass
    // (tools/recon/.headless/livepass.mjs) reported `badge:true ticket:false`
    // on a real Kalshi market page, which is how this was found — no unit test
    // can see it, because every unit passes.
    if (typeof PaperPredictTicket !== 'undefined') {
      try {
        PaperPredictTicket.mount(market);
      } catch (e) {
        console.warn('[PaperTrench] prediction ticket failed to mount:', e);
      }
    }

    console.log('[PaperTrench] prediction overlay mounted:', market.venue, market.marketId || market.eventSlug || market.marketSlug || '');
  }

  function unmount() {
    if (!mounted) return;
    mounted = false;
    if (badge && badge.parentNode) badge.parentNode.removeChild(badge);
    badge = null;
    // Tear the ticket down with the badge, or an SPA route change leaves a
    // panel priced against the market you just navigated away from.
    if (typeof PaperPredictTicket !== 'undefined') {
      try { PaperPredictTicket.unmount(); } catch { /* already gone */ }
    }
  }

  /* ── Init ───────────────────────────────────────────────────────── */

  loadSettings();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }

  // Re-detect on navigation (SPAs)
  let lastUrl = location.href;
  const observer = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      unmount();
      mount();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
})();
