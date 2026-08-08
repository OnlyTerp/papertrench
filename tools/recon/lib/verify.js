'use strict';
// The verifier — the one-shot payoff. It loads the REAL, shipped sites.js the
// same way the extension's own sitegating.test.js does (vm sandbox with a
// `location`), runs `currentSite().detect()` over every page the site actually
// served during the capture, and flags decisions that disagree with the
// evidence the capture recorded. It catches the exact class we keep fixing by
// hand — a token page the adapter refuses, a wallet/holders page it mounts —
// automatically, over the REAL url corpus, before the live pass.
//
// It reports. It does not decide: a flag is a "check this", grounded in what
// the capture saw, not a verdict. The sitegating locks still own the truth.

const vm = require('node:vm');
const { normalizeUrl } = require('./schema');
const { AUTH_RE } = require('./corpus');

const DEFAULT_ADAPTER = { global: 'PaperTrenchSites', currentSite: 'currentSite', detect: 'detect', shape: 'token' };

// Adapter SHAPES. A project can ship more than one kind of adapter: token
// terminals return {kind, address, chain}; prediction venues return
// {venue, <one market id>, verified}. The shape is DECLARED per site in
// ptrecon.config.json, never sniffed from the return value — guessing is how a
// verifier silently applies the wrong contract and reports a green run against
// a check it never made. An unknown shape is a loud error, not a fallback.
const SHAPES = new Set(['token', 'prediction']);

// The market identifier keys a prediction adapter may use, in priority order.
// Exactly one non-empty value is required for a mount to count.
const PREDICTION_ID_KEYS = ['marketId', 'eventSlug', 'marketSlug', 'market'];

function pathSegments(href) {
  try { return new URL(href).pathname.split('/').filter(Boolean).length; } catch { return 0; }
}

// Auth is a route shape, so the verifier derives it itself when the annotation
// does not carry it. Deriving it only in assembleExamples would make the
// contract depend on which caller built the examples — and a verifier whose
// rules change with its caller is not a contract.
function isAuthPage(ann, href) {
  if (ann && ann.looksAuthPage != null) return !!ann.looksAuthPage;
  try { return AUTH_RE.test(new URL(href).pathname); } catch { return false; }
}

function predictionId(m) {
  if (!m || typeof m !== 'object') return null;
  for (const k of PREDICTION_ID_KEYS) {
    const v = m[k];
    if (typeof v === 'string' && v.trim()) return { key: k, value: v.trim() };
  }
  return null;
}

// Load the project's adapter source into a fresh sandbox pinned to `href`, and
// return its detection at that URL. Mirrors how the project's own gating test
// loads the adapter, so the verifier sees exactly what the app sees. The
// adapter contract (which global it sets, which method returns the current
// site) comes from ptrecon.config.json's `adapter` block.
function detectAt(adapterSrc, href, adapterCfg, title) {
  const cfg = { ...DEFAULT_ADAPTER, ...(adapterCfg || {}) };
  if (!SHAPES.has(cfg.shape)) {
    return { error: `unknown adapter.shape "${cfg.shape}" — set it to one of: ${[...SHAPES].join(', ')} (ptrecon.config.json adapter block)` };
  }
  let url;
  try { url = new URL(href); } catch { return { error: 'bad url' }; }
  const sandbox = {
    window: {}, self: {}, globalThis: {},
    location: { href, hostname: url.hostname, pathname: url.pathname, search: url.search },
    document: { title: typeof title === 'string' ? title : '' },
    URL, URLSearchParams, console: { log() {}, warn() {}, error() {} },
  };
  if (!cfg.global) return { error: 'adapter.global not set in ptrecon.config.json (the global your adapter assigns, e.g. "MySites")' };
  try {
    vm.createContext(sandbox);
    vm.runInContext(adapterSrc, sandbox, { filename: cfg.file || 'adapter.js', timeout: 2000 });
    const api = sandbox.window[cfg.global] || sandbox.self[cfg.global] || sandbox.globalThis[cfg.global];
    if (!api) return { error: `adapter did not expose the global "${cfg.global}" (check ptrecon.config.json adapter block)` };

    // Prediction adapters are pure: detect(host, pathname, title) → market or
    // null. There is no currentSite() indirection to mirror, because a
    // prediction venue's identity is the venue, declared in config.
    if (cfg.shape === 'prediction') {
      if (typeof api[cfg.detect] !== 'function') return { error: `adapter did not expose ${cfg.global}.${cfg.detect}() (check ptrecon.config.json adapter block)` };
      let market = null;
      try {
        market = api[cfg.detect](url.hostname, url.pathname, typeof title === 'string' ? title : undefined);
      } catch (e) {
        return { siteId: cfg.venue || null, error: `${cfg.detect}() threw: ` + e.message };
      }
      return { siteId: cfg.venue || null, market: market || null };
    }

    if (typeof api[cfg.currentSite] !== 'function') return { error: `adapter did not expose ${cfg.global}.${cfg.currentSite}() (check ptrecon.config.json adapter block)` };
    const site = api[cfg.currentSite]();
    if (!site) return { siteId: null, token: null };
    let token = null;
    try { token = typeof site[cfg.detect] === 'function' ? site[cfg.detect]() : null; } catch (e) { return { siteId: site.id, error: `${cfg.detect}() threw: ` + e.message }; }
    return { siteId: site.id, token };
  } catch (e) {
    return { error: 'adapter failed to load: ' + e.message };
  }
}

// examples: [{ rawUrl, display, ann }] where ann is the corpus annotation
// { looksTokenPage, looksListPage, looksHistoryPage, hadLivePrice, priceNodeCount, chain }.
// Returns { rows, summary }.
function runVerify(adapterSrc, examples, adapterCfg) {
  const cfg = { ...DEFAULT_ADAPTER, ...(adapterCfg || {}) };
  if (cfg.shape === 'prediction') return runVerifyPrediction(adapterSrc, examples, cfg);

  const rows = [];
  for (const ex of examples) {
    const res = detectAt(adapterSrc, ex.rawUrl, adapterCfg, ex.title);
    const mounted = !!(res.token && (res.token.kind || res.token.address));
    const flags = [];

    if (res.error) {
      flags.push({ level: 'error', code: 'ADAPTER_ERROR', why: res.error });
    } else {
      const a = ex.ann || {};
      // A page with an address in its path AND a live-ticking price that the
      // adapter refuses is the highest-confidence miss.
      if (!mounted && a.looksTokenPage && a.hadLivePrice) {
        flags.push({ level: 'high', code: 'MISSED_TOKEN_PAGE', why: 'address-in-path page with a LIVE price, but detect() refused it' });
      } else if (!mounted && a.looksTokenPage) {
        flags.push({ level: 'medium', code: 'MAYBE_MISSED', why: 'address-in-path page, but detect() refused (no live price was seen here — confirm it is a token page)' });
      }
      // A wallet/holders/portfolio page that mounts is the O-10 over-mount bug.
      if (mounted && a.looksHistoryPage) {
        flags.push({ level: 'high', code: 'OVER_MOUNT', why: 'history/wallet/holders page MOUNTED — O-10: these must refuse' });
      }
      // A pure list/screener page that mounts is usually wrong too.
      if (mounted && a.looksListPage && !a.looksTokenPage) {
        flags.push({ level: 'medium', code: 'LIST_MOUNT', why: 'list/screener page mounted — usually should refuse (confirm against the route)' });
      }
      // Detected a chain the URL did not name (post-canonicalization mismatch
      // is expected; only flag when the adapter names a chain and the URL named
      // a different, recognizable one).
      if (mounted && res.token.chain && a.chain && !chainsAgree(res.token.chain, a.chain)) {
        flags.push({ level: 'low', code: 'CHAIN_NAME', why: `detect() said chain "${res.token.chain}" but the URL segment was "${a.chain}" — confirm the slug map` });
      }
    }

    rows.push({
      display: ex.display || ex.rawUrl,
      siteId: res.siteId || null,
      mounted,
      kind: res.token ? res.token.kind : null,
      address: res.token ? res.token.address : null,
      chain: res.token ? res.token.chain : null,
      ann: ex.ann || {},
      error: res.error || null,
      flags,
    });
  }

  const summary = {
    total: rows.length,
    mounted: rows.filter((r) => r.mounted).length,
    refused: rows.filter((r) => !r.mounted && !r.error).length,
    tokenPagesMounted: rows.filter((r) => r.ann.looksTokenPage && r.mounted).length,
    tokenPagesTotal: rows.filter((r) => r.ann.looksTokenPage).length,
    refuseCandidatesRefused: rows.filter((r) => (r.ann.looksHistoryPage || (r.ann.looksListPage && !r.ann.looksTokenPage)) && !r.mounted).length,
    refuseCandidatesTotal: rows.filter((r) => r.ann.looksHistoryPage || (r.ann.looksListPage && !r.ann.looksTokenPage)).length,
    high: rows.reduce((n, r) => n + r.flags.filter((f) => f.level === 'high').length, 0),
    medium: rows.reduce((n, r) => n + r.flags.filter((f) => f.level === 'medium').length, 0),
    errors: rows.filter((r) => r.error).length,
  };
  // A token page the adapter REFUSED but which had no live price only raised a
  // medium (MAYBE_MISSED), not a high — but it is still a token page the adapter
  // does not handle. The verdict must not say "AGREES" while that is true, or an
  // adapter that refuses every token page reads as fine. Any unmounted token
  // page downgrades the verdict to REVIEW.
  const tokenPagesRefused = summary.tokenPagesTotal - summary.tokenPagesMounted;
  summary.shape = 'token';
  summary.subjectNoun = 'token page';
  summary.subjectMounted = summary.tokenPagesMounted;
  summary.subjectTotal = summary.tokenPagesTotal;
  summary.verdict = summary.errors ? 'ADAPTER ERROR'
    : summary.high ? 'DISAGREEMENTS — review the high flags'
    : summary.tokenPagesTotal === 0 ? 'INCONCLUSIVE — no token page in the corpus to test against'
    : tokenPagesRefused > 0 ? `REVIEW — ${tokenPagesRefused}/${summary.tokenPagesTotal} token page(s) refused (confirm they are real token pages)`
    : 'AGREES with the capture';
  return { rows, summary };
}

// The PREDICTION contract, checked against the same real captured corpus.
//
// A prediction venue has no address in its path, so "is this a market page"
// cannot be answered by the token heuristic. The capture's own signal is used
// instead: a page that ticked a LIVE price and is not a list/screener or a
// wallet/history page is a market page, and refusing it is a miss.
//
// Two failure modes matter here and neither exists in the token shape:
//   RETURNED_NO_ID — detect() returned an object with no market identifier.
//     A caller reads that as "mounted on a market" and then has nothing to
//     price. The contract is: return null, or return an identified market.
//   VENUE_MISMATCH — the venue field disagrees with the venue declared for
//     this site in config. A copy-pasted adapter branch fails exactly here.
function runVerifyPrediction(adapterSrc, examples, cfg) {
  const rows = [];
  for (const ex of examples) {
    const res = detectAt(adapterSrc, ex.rawUrl, cfg, ex.title);
    const id = predictionId(res.market);
    const returned = !!(res.market && typeof res.market === 'object');
    const mounted = !!id;
    const flags = [];
    // Computed once and carried on the row: the summary must count market
    // pages by the same rule the flags use, or it can report "1/3 mounted, 0
    // disagreements" and contradict itself.
    const ann0 = ex.ann || {};
    const marketPage = !res.error && !!ann0.hadLivePrice
      && !ann0.looksListPage && !ann0.looksHistoryPage && !isAuthPage(ann0, ex.rawUrl)
      && pathSegments(ex.rawUrl) >= 2;

    if (res.error) {
      flags.push({ level: 'error', code: 'ADAPTER_ERROR', why: res.error });
    } else {
      const a = ex.ann || {};
      // A live-ticking page that is not a list/wallet/auth route is a market
      // page candidate. One more generic route-shape rule separates a real
      // market from a section index: an individual market lives at a path with
      // at least two segments (/event/<slug>, /markets/<series>/<market>),
      // while /new, /politics, /crypto are category routes that tick live
      // prices because they list markets. Deliberate tradeoff: a venue that
      // serves markets at a single bare segment gets a MEDIUM here instead of
      // a HIGH — under-flagging one exotic layout beats crying wolf on every
      // category page, which is how flags get ignored.
      const authPage = isAuthPage(a, ex.rawUrl);
      const liveTradablePage = !!a.hadLivePrice && !a.looksListPage && !a.looksHistoryPage && !authPage;
      const isMarketPage = marketPage;

      if (returned && !mounted) {
        flags.push({ level: 'high', code: 'RETURNED_NO_ID', why: `detect() returned a ${res.market.venue || '?'} object with no market identifier (${PREDICTION_ID_KEYS.join('|')}) — it must return null instead` });
      }
      if (mounted && cfg.venue && res.market.venue !== cfg.venue) {
        flags.push({ level: 'high', code: 'VENUE_MISMATCH', why: `detect() said venue "${res.market.venue}" but this site is configured as "${cfg.venue}"` });
      }
      if (!mounted && !returned && isMarketPage) {
        flags.push({ level: 'high', code: 'MISSED_MARKET_PAGE', why: 'page ticked a LIVE price and is not a list/wallet page, but detect() refused it' });
      } else if (!mounted && !returned && liveTradablePage) {
        flags.push({ level: 'medium', code: 'MAYBE_MISSED_MARKET', why: 'single-segment route ticked a LIVE price and detect() refused it — confirm it is a category index and not a market' });
      }
      if (mounted && (a.looksHistoryPage || authPage)) {
        flags.push({ level: 'high', code: 'OVER_MOUNT', why: `${authPage ? 'auth/sign-in' : 'portfolio/history/wallet'} page MOUNTED — these must refuse` });
      }
      if (mounted && a.looksListPage && !a.hadLivePrice) {
        flags.push({ level: 'medium', code: 'LIST_MOUNT', why: 'list/screener page mounted — usually should refuse (confirm against the route)' });
      }
      if (mounted && typeof res.market.verified !== 'boolean') {
        flags.push({ level: 'medium', code: 'NO_VERIFIED_FLAG', why: 'mounted market has no boolean `verified` field — the honest-gating flag is part of the contract' });
      }
    }

    rows.push({
      display: ex.display || ex.rawUrl,
      siteId: res.siteId || null,
      mounted,
      isMarketPage: marketPage,
      kind: mounted ? id.key : null,
      address: mounted ? id.value : null,
      chain: null,
      venue: res.market ? res.market.venue || null : null,
      verified: res.market ? res.market.verified : undefined,
      ann: ex.ann || {},
      error: res.error || null,
      flags,
    });
  }

  // Counted exactly the way the flag logic decides a market page, or the
  // summary would contradict its own flags ("1/3 mounted, 0 disagreements").
  const marketPages = rows.filter((r) => r.isMarketPage);
  const refuseCandidates = rows.filter((r) => r.ann.looksHistoryPage || r.ann.looksAuthPage || (r.ann.looksListPage && !r.ann.hadLivePrice));
  const summary = {
    shape: 'prediction',
    subjectNoun: 'market page',
    total: rows.length,
    mounted: rows.filter((r) => r.mounted).length,
    refused: rows.filter((r) => !r.mounted && !r.error).length,
    marketPagesMounted: marketPages.filter((r) => r.mounted).length,
    marketPagesTotal: marketPages.length,
    tokenPagesMounted: 0,
    tokenPagesTotal: 0,
    refuseCandidatesRefused: refuseCandidates.filter((r) => !r.mounted).length,
    refuseCandidatesTotal: refuseCandidates.length,
    high: rows.reduce((n, r) => n + r.flags.filter((f) => f.level === 'high').length, 0),
    medium: rows.reduce((n, r) => n + r.flags.filter((f) => f.level === 'medium').length, 0),
    errors: rows.filter((r) => r.error).length,
  };
  summary.subjectMounted = summary.marketPagesMounted;
  summary.subjectTotal = summary.marketPagesTotal;
  const missed = summary.marketPagesTotal - summary.marketPagesMounted;
  summary.verdict = summary.errors ? 'ADAPTER ERROR'
    : summary.high ? 'DISAGREEMENTS — review the high flags'
    : summary.marketPagesTotal === 0 ? 'INCONCLUSIVE — no live-ticking market page in the corpus to test against'
    : missed > 0 ? `REVIEW — ${missed}/${summary.marketPagesTotal} market page(s) refused (confirm they are real market pages)`
    : 'AGREES with the capture';
  return { rows, summary };
}

// Site slugs canonicalize (sol→solana, eth→ethereum). Treat a slug as agreeing
// if one is a prefix of the other or they share a known alias.
const CHAIN_ALIASES = { sol: 'solana', eth: 'ethereum', bnb: 'bsc', matic: 'polygon', arb: 'arbitrum', avax: 'avalanche', op: 'optimism', trx: 'tron' };
function chainsAgree(a, b) {
  const na = CHAIN_ALIASES[a] || a;
  const nb = CHAIN_ALIASES[b] || b;
  return na === nb || na.startsWith(nb) || nb.startsWith(na);
}

// Assemble the examples list from raw capture URLs + corpus annotations.
// rawUrls: [{url}] distinct nav/doc urls (unscrubbed, local only).
// corpusUrls: the dossier corpus entries (annotations, keyed by host+pattern).
// scrub: scrubber for the DISPLAY url only (raw is used for detect()).
function assembleExamples(rawUrls, corpusUrls, scrub) {
  const annByKey = new Map();
  for (const c of corpusUrls) annByKey.set(c.host + c.pattern, c);
  const seen = new Map();
  for (const u of rawUrls) {
    const raw = u.url || u;
    if (!raw || /^about:|^chrome:|^data:/.test(raw)) continue;
    const norm = normalizeUrl(raw);
    if (!norm) continue;
    const key = norm.host + norm.pattern;
    if (seen.has(key)) continue; // one example per pattern
    const ann = annByKey.get(key) || {};
    seen.set(key, {
      rawUrl: raw,
      display: scrub ? scrub.scrubUrl(raw) : raw,
      // Prediction adapters may read the tab title (Hyperliquid carries the
      // market there). Only a title the capture actually recorded is passed —
      // never a synthesized one, or the verifier would test a page that never
      // existed.
      ...(typeof u.title === 'string' && u.title ? { title: u.title } : {}),
      ann: {
        looksTokenPage: !!ann.looksTokenPage,
        looksListPage: !!ann.looksListPage,
        looksHistoryPage: !!ann.looksHistoryPage,
        // Derived from the URL, not read from the corpus: auth routes are a
        // pure route shape, so this stays correct on corpora distilled before
        // the classifier learned the notion.
        looksAuthPage: ann.looksAuthPage != null ? !!ann.looksAuthPage : AUTH_RE.test(norm.path || ''),
        hadLivePrice: !!ann.hadLivePrice,
        priceNodeCount: ann.priceNodeCount || 0,
        chain: ann.chain || norm.chainCandidates.map((c) => c.seg)[0] || null,
      },
    });
  }
  return [...seen.values()];
}

module.exports = { detectAt, runVerify, assembleExamples, chainsAgree, predictionId, SHAPES, PREDICTION_ID_KEYS };
