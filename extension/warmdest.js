/* PaperTrench — warm destination classifier (Instant Everything links).
 *
 * The X classifier (xlinks.js) proved the pattern: a tiny, shared, paranoid
 * URL classifier loaded by every layer that must agree on what a link IS —
 * the background (routing), and the terminal-side ISOLATED world (click and
 * hover interception). This is the same contract for every cold destination
 * a token row can carry:
 *
 *   pumpfun — pump.fun coin pages (and the board / profiles)
 *   solscan — solscan.io token / account / tx pages
 *   ...and token pages on every supported terminal. Turbo II closed the
 *   matrix (Axiom, Padre, GMGN, Fomo, BullX, Photon, Dexscreener, Birdeye,
 *   Jupiter): a token link between ANY two supported sites warm-routes.
 *
 * Contract, identical to xlinks.js:
 *   - https only; anything else is not ours.
 *   - Path and query pass through BYTE-FOR-BYTE onto the canonical host.
 *     Classification must never be the reason a page looks different.
 *   - Unknown shapes return null and the click stays native. A warm route
 *     that guesses is worse than a cold tab that works.
 */
(() => {
  'use strict';

  const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

  const PUMP_HOSTS = new Set(['pump.fun', 'www.pump.fun']);
  const SOLSCAN_HOSTS = new Set(['solscan.io', 'www.solscan.io']);
  // The main terminals people actually trade on (maintainer's call): a token
  // link to one of these clicked on ANOTHER terminal warm-routes instead of
  // cold-loading — and the positions-bar chip hop between terminals stops
  // costing the tab you were on. Route shapes mirror sites.js adapters
  // (same O-10/O-11 discipline: token routes only, wallet/portfolio never).
  const AXIOM_HOST_RE = /(^|\.)axiom\.trade$/;
  const PADRE_HOST_RE = /(^|\.)padre\.gg$/;
  const GMGN_HOST_RE = /(^|\.)gmgn\.ai$/;
  const FOMO_HOST_RE = /(^|\.)fomo\.family$/;
  // Turbo II: the rest of the supported-terminal matrix, same discipline —
  // token routes only, shapes mirrored from the sites.js adapters that live
  // on these pages every day (wallet/portfolio/EVM routes never warm-route).
  const BULLX_HOST_RE = /(^|\.)bullx\.io$/;
  const PHOTON_HOST_RE = /(^|\.)tinyastro\.io$/;
  const DEXSCREENER_HOST_RE = /(^|\.)dexscreener\.com$/;
  const BIRDEYE_HOST_RE = /(^|\.)birdeye\.so$/;
  const JUP_HOST_RE = /(^|\.)jup\.ag$/;
  const LUTE_HOST_RE = /(^|\.)lute\.gg$/;
  // Jupiter's swap routes name the quote side too — SOL/USDC/USDT are the
  // pair's other half, never the token the user meant to open.
  const QUOTE_MINTS = new Set([
    'So11111111111111111111111111111111111111112',  // WSOL
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  ]);

  function parse(href, baseHref) {
    try {
      const url = baseHref ? new URL(href, baseHref) : new URL(href);
      return url.protocol === 'https:' ? url : null;
    } catch (_) {
      return null;
    }
  }

  /**
   * Classify a link into a warm destination.
   * Returns { family, url, kind } or null. `url` is canonical (bare host),
   * path + search preserved byte-for-byte.
   */
  function classify(href, baseHref) {
    const url = parse(href, baseHref);
    if (!url) return null;
    const host = url.hostname.toLowerCase();
    const path = url.pathname;

    if (PUMP_HOSTS.has(host)) {
      // Coin pages: /coin/<mint> plus the legacy bare /<mint> route; profiles
      // and the board are cheap wins too (all fully public).
      const coin = path.match(/^\/coin\/([1-9A-HJ-NP-Za-km-z]{32,44})(?:$|[/?#])/);
      const bare = path.match(/^\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);
      const profile = /^\/profile\//.test(path);
      const board = path === '/board' || path === '/' || path === '/advanced';
      if (!coin && !bare && !profile && !board) return null;
      return {
        family: 'pumpfun',
        kind: coin || bare ? 'coin' : (profile ? 'profile' : 'board'),
        url: 'https://pump.fun' + path + url.search,
      };
    }

    if (AXIOM_HOST_RE.test(host)) {
      // axiom.trade/meme/<pair> and /t/<mint> — token pages only (the wallet
      // and profile routes also end in base58 and must never warm-route).
      const m = path.match(/^\/(meme|t)\/([1-9A-HJ-NP-Za-km-z]{32,44})(?:$|[/?#])/);
      if (!m) return null;
      return { family: 'axiom', kind: 'token', url: 'https://axiom.trade' + path + url.search };
    }

    if (PADRE_HOST_RE.test(host)) {
      // trade.padre.gg/trade/<chain>/<mint> (and legacy /terminal/ routes).
      const m = path.match(/^\/(?:trade|terminal)\/(?:[a-z0-9-]+\/)*([1-9A-HJ-NP-Za-km-z]{32,44})(?:$|[/?#])/);
      if (!m) return null;
      return { family: 'padre', kind: 'token', url: 'https://trade.padre.gg' + path + url.search };
    }

    if (GMGN_HOST_RE.test(host)) {
      // gmgn.ai/sol/token/<mint> — Solana only, same gate as the adapter.
      const m = path.match(/^\/sol\/token\/([1-9A-HJ-NP-Za-km-z]{32,44})(?:$|[/?#])/);
      if (!m) return null;
      return { family: 'gmgn', kind: 'token', url: 'https://gmgn.ai' + path + url.search };
    }

    if (FOMO_HOST_RE.test(host)) {
      // fomo.family/tokens/solana/<mint> — the solana chain slug only, same
      // gate as the sites.js adapter (fomo is multichain and its own /token
      // entry point lands users on EVM pages routinely), and token pages
      // only: /u/ and /profile/ handle routes are never warm-routed.
      const m = path.match(/^\/tokens\/solana\/([1-9A-HJ-NP-Za-km-z]{32,44})(?:$|[/?#])/);
      if (!m) return null;
      return { family: 'fomo', kind: 'token', url: 'https://fomo.family' + path + url.search };
    }

    if (BULLX_HOST_RE.test(host)) {
      // neo.bullx.io/terminal?chainId=1399811149&address=<pair|mint>. The
      // address param must be a WHOLE base58 value (O-11: EVM 0x addresses
      // can embed base58-passing runs) and any explicit non-Solana chainId
      // is not ours — the same gate as the sites.js adapter.
      if (path !== '/terminal' && path !== '/terminal/') return null;
      const chainId = url.searchParams.get('chainId');
      if (chainId && chainId !== '1399811149') return null;
      const address = url.searchParams.get('address') || '';
      if (!BASE58_RE.test(address)) return null;
      return { family: 'bullx', kind: 'token', url: 'https://neo.bullx.io/terminal' + url.search };
    }

    if (PHOTON_HOST_RE.test(host)) {
      // photon-sol.tinyastro.io/<locale>/lp/<pair> and /<locale>/r/<mint> —
      // the locale prefix varies, so the gate is the /lp/ | /r/ segment with
      // a WHOLE base58 tail (both shapes are real token pages, O-12).
      const m = path.match(/\/(lp|r)\/([1-9A-HJ-NP-Za-km-z]{32,44})(?:$|[/?#])/);
      if (!m) return null;
      return { family: 'photon', kind: 'token', url: 'https://photon-sol.tinyastro.io' + path + url.search };
    }

    if (DEXSCREENER_HOST_RE.test(host)) {
      // dexscreener.com/solana/<pair> — the /solana/ prefix is the gate.
      // EVM chain routes can embed base58-passing hex runs (O-11), and
      // watchlist/gainers/portfolio routes must never warm-route (O-10).
      const m = path.match(/^\/solana\/([1-9A-HJ-NP-Za-km-z]{32,44})(?:$|[/?#])/);
      if (!m) return null;
      return { family: 'dexscreener', kind: 'token', url: 'https://dexscreener.com' + path + url.search };
    }

    if (BIRDEYE_HOST_RE.test(host)) {
      // birdeye.so/token/<mint>?chain=solana — an explicit non-Solana chain
      // is not ours, and profile routes carry wallets, never tokens (O-10).
      const chain = url.searchParams.get('chain');
      if (chain && chain.toLowerCase() !== 'solana') return null;
      const m = path.match(/\/token\/([1-9A-HJ-NP-Za-km-z]{32,44})(?:$|[/?#])/);
      if (!m) return null;
      return { family: 'birdeye', kind: 'token', url: 'https://birdeye.so' + path + url.search };
    }

    if (JUP_HOST_RE.test(host)) {
      // jup.ag/swap/SOL-<mint>, /tokens/<mint>, and the query forms the app
      // rewrites itself into (?inputMint/?outputMint, later ?buy/?sell). A
      // candidate counts only as a WHOLE base58 value that is not a quote
      // mint; /portfolio/<wallet> and every other route refuses (O-10).
      const whole = (v) => (v && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v) ? v : null);
      const tokensRoute = path.match(/^\/tokens\/([1-9A-HJ-NP-Za-km-z]{32,44})(?:$|[/?#])/);
      const swapRoute = path.match(/^\/swap\/([^/?#]+)$/);
      const queryRoute = /^\/(?:swap|limit|dca)?\/?$/.test(path);
      const candidates = [];
      if (tokensRoute) candidates.push(tokensRoute[1]);
      if (swapRoute) candidates.push(...swapRoute[1].split('-').map(whole).filter(Boolean));
      if (queryRoute) {
        for (const key of ['outputMint', 'inputMint', 'buy', 'sell']) {
          const v = whole(url.searchParams.get(key));
          if (v) candidates.push(v);
        }
      }
      if (!candidates.some((mint) => !QUOTE_MINTS.has(mint))) return null;
      return { family: 'jupiter', kind: 'token', url: 'https://jup.ag' + path + url.search };
    }

    if (LUTE_HOST_RE.test(host)) {
      // lute.gg/trade/<base58> — Solana token pages only. Named routes
      // (compass, momentum, portfolio, discover) are rejected by the
      // {32,44} length constraint, same gate as the sites.js adapter.
      const m = path.match(/^\/trade\/([1-9A-HJ-NP-Za-km-z]{32,44})(?:$|[\/?#])/);
      if (!m) return null;
      return { family: 'lute', kind: 'token', url: 'https://lute.gg' + path + url.search };
    }

    if (SOLSCAN_HOSTS.has(host)) {
      const m = path.match(/^\/(token|account|address|tx)\/([^/?#]+)/);
      if (!m) return null;
      // Token/account segments must be whole base58; tx signatures are longer
      // base58 runs — accept 32..96 there.
      const seg = m[2];
      if (m[1] === 'tx') {
        if (!/^[1-9A-HJ-NP-Za-km-z]{43,96}$/.test(seg)) return null;
      } else if (!BASE58_RE.test(seg)) {
        return null;
      }
      return {
        family: 'solscan',
        kind: m[1],
        url: 'https://solscan.io' + path + url.search,
      };
    }

    return null;
  }

  function isWarmDestHost(hostname) {
    return familyOfHost(hostname) !== null;
  }

  /** Which family a hostname belongs to, or null. The terminal-side
   * interceptor uses this for the same-site guard: a pump.fun link clicked ON
   * pump.fun stays native — the site's own SPA router beats a tab swap. */
  function familyOfHost(hostname) {
    const h = String(hostname || '').toLowerCase();
    if (/(^|\.)pump\.fun$/.test(h)) return 'pumpfun';
    if (/(^|\.)solscan\.io$/.test(h)) return 'solscan';
    if (AXIOM_HOST_RE.test(h)) return 'axiom';
    if (PADRE_HOST_RE.test(h)) return 'padre';
    if (GMGN_HOST_RE.test(h)) return 'gmgn';
    if (FOMO_HOST_RE.test(h)) return 'fomo';
    if (BULLX_HOST_RE.test(h)) return 'bullx';
    if (PHOTON_HOST_RE.test(h)) return 'photon';
    if (DEXSCREENER_HOST_RE.test(h)) return 'dexscreener';
    if (BIRDEYE_HOST_RE.test(h)) return 'birdeye';
    if (JUP_HOST_RE.test(h)) return 'jupiter';
    if (LUTE_HOST_RE.test(h)) return 'lute';
    return null;
  }

  /* -------------------- socket pre-warm (Turbo III) -------------------- */

  // Canonical navigation origin per family — the host a viewer tab or a new
  // tab pays DNS+TCP+TLS for on its first load. The terminal page preconnects
  // these (no tabs, no requests, just warm sockets in the shared pool) so the
  // first cross-site click of the session stops paying the cold price. One
  // entry per family, kept next to the canonical hosts in classify() above —
  // if a canonical host moves, this table moves with it.
  const PRECONNECT_ORIGINS = [
    ['pumpfun', 'https://pump.fun'],
    ['solscan', 'https://solscan.io'],
    ['axiom', 'https://axiom.trade'],
    ['padre', 'https://trade.padre.gg'],
    ['gmgn', 'https://gmgn.ai'],
    ['fomo', 'https://fomo.family'],
    ['bullx', 'https://neo.bullx.io'],
    ['photon', 'https://photon-sol.tinyastro.io'],
    ['dexscreener', 'https://dexscreener.com'],
    ['birdeye', 'https://birdeye.so'],
    ['jupiter', 'https://jup.ag'],
    ['lute', 'https://lute.gg'],
  ];

  // x.com is the warm X viewer's destination and the most-clicked link on
  // every terminal. It is not a warmdest family (warmdest never runs on x.com
  // itself), so it is always included, never filtered. pbs/abs carry every
  // avatar, banner, and timeline image the viewer shows — a viewer tab that
  // connects to x.com but not its image hosts still stalls on media.
  const X_PRECONNECT_ORIGINS = ['https://x.com', 'https://pbs.twimg.com', 'https://abs.twimg.com'];

  /** Origins worth preconnecting from `currentHostname`: every family except
  * the page's own (same-origin sockets are already warm), plus the X origins.
  * Pure — runs under `node --test` with no browser. */
  function preconnectTargets(currentHostname) {
    const here = typeof currentHostname === 'string' ? familyOfHost(currentHostname) : null;
    const out = [];
    for (const pair of PRECONNECT_ORIGINS) {
      if (pair[0] === here) continue;
      out.push(pair[1]);
    }
    for (const o of X_PRECONNECT_ORIGINS) out.push(o);
    return out;
  }

  /* ------------ same-site dwell prefetch (Turbo III, round 2) ------------ */

  // A same-family token link stays native by design (the site's own SPA
  // router beats a tab swap) — but when the click IS a real navigation, a
  // speculation-rules prefetch started during the hover dwell makes it
  // instant. This selector answers only which URL may be prefetched; the
  // caller (warm-links.js) owns the dwell timer, the single-slot rule
  // element, and the strict same-origin check. `families` is caller-passed
  // so rollout stays scoped; cross-family and unclassified hrefs refuse.
  // Pure — runs under `node --test` with no browser.
  function sameSitePrefetchable(href, baseHref, currentHostname, families) {
    let target = null;
    try { target = classify(href, baseHref); } catch (_) { return null; }
    if (!target) return null;
    if (familyOfHost(currentHostname) !== target.family) return null;
    if (!Array.isArray(families) || families.indexOf(target.family) === -1) return null;
    return target.url;
  }

  const api = { classify, isWarmDestHost, familyOfHost, preconnectTargets, X_PRECONNECT_ORIGINS, sameSitePrefetchable };
  if (typeof window !== 'undefined') window.PTWarmDest = api;
  if (typeof self !== 'undefined') self.PTWarmDest = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
