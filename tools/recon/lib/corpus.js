'use strict';
// The URL corpus: the distinct pages the site actually served during a capture,
// each annotated with what the capture SAW there (did prices tick? how many?
// does it look like a token page / list / history page?). Two consumers:
//   - the coverage scorecard (§0): is this capture landable, or too thin?
//   - the verifier (`check`): run the real adapter over these real URLs and
//     flag decisions that disagree with the evidence.
// Keeping the classification here (not in distill) keeps both honest and lets
// the verifier reuse the exact same annotations the dossier showed.

const { normalizeUrl } = require('./schema');

const HISTORY_RE = /\b(wallet|holders?|holding|portfolio|leaderboard|positions?|activity|history|txns?|transactions?|pnl|top-?traders?|trader|profile|account|settings|watchlist)\b/i;
const LIST_RE = /\b(trending|screener|pulse|memescope|discover|explore|new-?pairs?|gainers|losers|movers|feed|home|markets?|tokens?|pairs?)\b/i;
// Auth/consent routes. These often render a venue's live prices behind or
// beside the form, so the live-price signal alone would read them as a
// tradable page — and an adapter that mounts a ticket on a sign-in screen is
// the same class of bug as mounting on a wallet page.
const AUTH_RE = /\b(sign-?in|sign-?up|log-?in|log-?out|register|auth|oauth|callback|connect-?wallet|verify-?email|reset-?password|onboarding)\b/i;

const ADDR_VALUE_RE = /^(0x[a-fA-F0-9]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;
// Only an address-shaped value under an address-like KEY counts — a base58
// referral code or signature under a random key must not flag a token page.
const ADDR_KEY_RE = /^(address|tokenaddress|pairaddress|token|mint|pair|ca|contract|base|quote|outputmint|inputmint|out|in|buy|sell)$/i;

function classifyUrl(rawUrl, priceInfo) {
  const norm = normalizeUrl(rawUrl);
  if (!norm) return null;
  const path = norm.path || '';
  let u = null;
  try { u = new URL(rawUrl); } catch { /* keep null */ }
  // An address can live in the PATH (normalized to {address}/{evm}) OR in a
  // QUERY VALUE — BullX's real token page is neo.bullx.io/terminal?address=<pair>,
  // birdeye/jupiter do the same. Miss this and a live token page reads as a list.
  const addrInQuery = u && [...u.searchParams.entries()].some(([k, v]) => ADDR_KEY_RE.test(k) && ADDR_VALUE_RE.test(v));
  const hasVar = /\{(address|evm|uuid|mixed-id)\}/.test(norm.pattern) || !!addrInQuery;
  const priceNodeCount = priceInfo ? priceInfo.nodeCount : 0;
  const hadLivePrice = priceInfo ? priceInfo.hadLivePrice : false;
  // History if the PATH says so, OR it is a bare /address/<wallet> wallet route
  // (GMGN's /sol/address/<w> — an O-10 MUST-REFUSE that HISTORY_RE misses). We
  // do NOT treat a history TAB in the query/hash as a history page: a token page
  // with ?tab=holders still has the token address in its path and the adapter
  // MUST mount it — the holders DATA there is a §6 pollution concern, not a
  // reason to refuse the page (treating it as history caused a false OVER_MOUNT).
  const looksHistoryPage = HISTORY_RE.test(path) || /\/address(es)?(\/|$)/i.test(path);
  const looksAuthPage = AUTH_RE.test(path);
  // A token page is an address (path or query) that is not a wallet/history
  // route. This wins over node count: a real trading page is dense with numbers
  // (price, mcap, liquidity, volume, txns) — the ">=8 prices" heuristic must NOT
  // reclassify it as a list. (Found on a live DexScreener token page: 20+ nodes.)
  const looksTokenPage = hasVar && !looksHistoryPage;
  // A list/screener page has NO token address and shows many prices or names
  // itself a screener.
  const looksListPage = !hasVar && (LIST_RE.test(path) || priceNodeCount >= 8);
  return {
    host: norm.host,
    pattern: norm.pattern,
    chain: norm.chainCandidates.map((c) => c.seg)[0] || null,
    hasVar,
    priceNodeCount,
    hadLivePrice,
    looksHistoryPage,
    looksAuthPage,
    looksListPage,
    looksTokenPage,
  };
}

// domsigEvents: parsed domsig lines [{t, href, prices:[[path,txt],...]}]
// Returns Map<href, {nodeCount, hadLivePrice}>.
function pricesByHref(domsigEvents) {
  const perHref = new Map(); // href -> Map<path, Set<txt>>
  for (const ev of domsigEvents) {
    if (!ev.href || !Array.isArray(ev.prices)) continue;
    let m = perHref.get(ev.href);
    if (!m) { m = new Map(); perHref.set(ev.href, m); }
    for (const [pathSel, txt] of ev.prices) {
      if (!pathSel) continue;
      let s = m.get(pathSel);
      if (!s) { s = new Set(); m.set(pathSel, s); }
      if (s.size < 8) s.add(txt);
    }
  }
  const out = new Map();
  for (const [href, m] of perHref) {
    let live = false;
    for (const s of m.values()) if (s.size > 1) { live = true; break; }
    out.set(href, { nodeCount: m.size, hadLivePrice: live });
  }
  return out;
}

// Build the corpus from a capture's nav/doc URLs.
// navEvents: events with .href or .url ; network: Document entries.
function buildCorpus(navEvents, domsigEvents, docEntries, scrubber) {
  const priceMap = pricesByHref(domsigEvents);
  const seen = new Map(); // scrubbedUrl -> entry (deduped)
  const chainsSeen = new Set(); // every chain slug across ALL urls, pre-dedup

  const consider = (rawUrl) => {
    if (!rawUrl || /^about:|^chrome:|^data:/.test(rawUrl)) return;
    const cls = classifyUrl(rawUrl, priceMap.get(rawUrl));
    if (!cls) return;
    if (cls.chain) chainsSeen.add(cls.chain);
    const scrubbed = scrubber ? scrubber.scrubUrl(rawUrl) : rawUrl;
    // Dedup on the normalized pattern+host so ten token pages collapse to the
    // shape, but keep one concrete example (the first) for detect().
    const key = cls.host + cls.pattern;
    const existing = seen.get(key);
    if (existing) {
      existing.count++;
      // Prefer to remember an example that actually ticked a price.
      if (!existing.hadLivePrice && cls.hadLivePrice) { existing.example = scrubbed; existing.hadLivePrice = true; existing.priceNodeCount = Math.max(existing.priceNodeCount, cls.priceNodeCount); }
      existing.priceNodeCount = Math.max(existing.priceNodeCount, cls.priceNodeCount);
      return;
    }
    seen.set(key, {
      example: scrubbed, host: cls.host, pattern: cls.pattern, chain: cls.chain,
      count: 1, hasVar: cls.hasVar, priceNodeCount: cls.priceNodeCount, hadLivePrice: cls.hadLivePrice,
      looksHistoryPage: cls.looksHistoryPage, looksListPage: cls.looksListPage, looksTokenPage: cls.looksTokenPage,
    });
  };

  for (const e of navEvents) consider(e.href || e.url);
  for (const n of docEntries) consider(n.url);

  const urls = [...seen.values()].sort((a, b) => b.count - a.count);

  // Coverage buckets: is this capture landable? Chains come from ALL urls
  // (pre-dedup) — collapsing /solana and /base into /{chain} must not hide
  // that two chains were browsed.
  const chains = chainsSeen;
  const tokenPages = urls.filter((u) => u.looksTokenPage);
  const listPages = urls.filter((u) => u.looksListPage);
  const historyPages = urls.filter((u) => u.looksHistoryPage);
  const refuseCandidates = urls.filter((u) => u.looksHistoryPage || (u.looksListPage && !u.looksTokenPage));
  const tokenWithLivePrice = tokenPages.filter((u) => u.hadLivePrice);

  const gaps = [];
  if (tokenPages.length === 0) gaps.push('no token page captured (a page with an address in the path) — the adapter\'s main job is unverifiable');
  if (tokenWithLivePrice.length === 0) gaps.push('no token page showed a LIVE-ticking price — the market-vs-history call and the price bridge cannot be grounded (browse a token page and sit ~30s)');
  if (historyPages.length === 0) gaps.push('no holders/wallet/history page captured — the O-10 refuse corpus and the pollution locks have nothing to bite on');
  if (chains.size < 2) gaps.push(`only ${chains.size} chain slug seen — if the site is multichain, the slug vocabulary is incomplete (browse a second chain)`);
  if (refuseCandidates.length === 0) gaps.push('no must-refuse route captured (settings/screener/wallet) — sitegating has no negative rows');

  const verdict = gaps.length === 0 ? 'LANDABLE'
    : (tokenPages.length === 0 || tokenWithLivePrice.length === 0) ? 'THIN — not landable yet'
    : 'PARTIAL — usable but has gaps';

  return {
    urls,
    coverage: {
      verdict, gaps,
      counts: {
        distinctPages: urls.length,
        tokenPages: tokenPages.length,
        tokenPagesWithLivePrice: tokenWithLivePrice.length,
        listPages: listPages.length,
        historyPages: historyPages.length,
        refuseCandidates: refuseCandidates.length,
        chains: chains.size,
      },
      chains: [...chains],
    },
  };
}

module.exports = { buildCorpus, classifyUrl, pricesByHref, HISTORY_RE, LIST_RE, AUTH_RE };
