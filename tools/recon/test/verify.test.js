'use strict';
// Tests for the phase-2 one-shot layer: corpus classification + coverage, the
// adapter verifier (the crown jewel — proven here to catch missed-token-page
// and over-mount against a fake adapter), and the scaffold generator.
//   node --test tools/recon/test/verify.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { classifyUrl, buildCorpus } = require('../lib/corpus');
const { runVerify, assembleExamples, detectAt, chainsAgree } = require('../lib/verify');
const { scaffold } = require('../lib/scaffold');
const { checkWiring, registrable } = require('../lib/wiring');
const { diffDossiers } = require('../lib/driftdiff');
const { loadConfig, writeInitConfig, mergeDenylists, deepMerge, DEFAULTS } = require('../lib/config');

const ADDR = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const WALLET = 'MfDuWeqSHEqTFVYZ7LoexgAK9dxk7cy4DFJWjWMGVWa';

// A faithful mini-adapter: mounts on /token/<addr>, refuses everything else.
const GOOD_ADAPTER = `(() => {
  'use strict';
  const api = { currentSite: () => ({ id: 'fake', detect: () => {
    const m = location.pathname.match(/^\\/token\\/([1-9A-HJ-NP-Za-km-z]{32,44})/);
    return m ? { kind: 'mint', address: m[1], chain: 'solana' } : null;
  } }) };
  window.PaperTrenchSites = api; self.PaperTrenchSites = api;
})();`;

// A BUGGY adapter that refuses token pages (the miss we keep fixing by hand).
const BLIND_ADAPTER = `(() => {
  'use strict';
  const api = { currentSite: () => ({ id: 'fake', detect: () => null }) };
  window.PaperTrenchSites = api; self.PaperTrenchSites = api;
})();`;

// An OVER-MOUNTING adapter that mounts on anything with an address in the path,
// including wallets (the O-10 bug).
const GREEDY_ADAPTER = `(() => {
  'use strict';
  const api = { currentSite: () => ({ id: 'fake', detect: () => {
    const m = location.pathname.match(/([1-9A-HJ-NP-Za-km-z]{32,44})/);
    return m ? { kind: 'mint', address: m[1], chain: 'solana' } : null;
  } }) };
  window.PaperTrenchSites = api; self.PaperTrenchSites = api;
})();`;

// ---------------------------------------------------------------------------
// corpus
// ---------------------------------------------------------------------------

test('corpus: classifyUrl separates token / history / list pages', () => {
  const token = classifyUrl(`https://x.io/solana/${ADDR}`, { nodeCount: 1, hadLivePrice: true });
  assert.equal(token.looksTokenPage, true);
  assert.equal(token.looksHistoryPage, false);

  const wallet = classifyUrl(`https://x.io/wallet/${WALLET}`, null);
  assert.equal(wallet.looksHistoryPage, true);
  assert.equal(wallet.looksTokenPage, false);

  const screener = classifyUrl('https://x.io/trending', null);
  assert.equal(screener.looksListPage, true);

  // Many price nodes → list even without list vocabulary in the path.
  const dense = classifyUrl('https://x.io/board', { nodeCount: 20, hadLivePrice: true });
  assert.equal(dense.looksListPage, true);
});

test('corpus: coverage counts chains PRE-dedup and verdicts honestly', () => {
  const nav = [
    { ev: 'nav', href: `https://x.io/solana/${ADDR}` },
    { ev: 'nav', href: `https://x.io/base/${ADDR}` }, // same pattern, different chain
    { ev: 'nav', href: `https://x.io/wallet/${WALLET}` },
  ];
  const domsig = [
    { k: 'sig', href: `https://x.io/solana/${ADDR}`, prices: [['div.p', '$1.00']] },
    { k: 'sig', href: `https://x.io/solana/${ADDR}`, prices: [['div.p', '$1.02']] }, // ticked → live
  ];
  const { urls, coverage } = buildCorpus(nav, domsig, [], null);
  assert.equal(coverage.counts.chains, 2, 'both chains counted despite /{chain} dedup');
  assert.ok(coverage.counts.tokenPages >= 1);
  assert.ok(coverage.counts.historyPages >= 1);
  // token page ticked a price → tokenPagesWithLivePrice
  assert.ok(coverage.counts.tokenPagesWithLivePrice >= 1);
  assert.ok(urls.some((u) => u.looksTokenPage && u.hadLivePrice));
});

test('corpus: a DENSE token page stays a token page, not a list (regression)', () => {
  // A real trading page is thick with numbers (price, mcap, liq, vol, txns).
  // The ">=8 prices → list" heuristic must NOT reclassify an address-in-path
  // page as a list — that made §0 wrongly report "no token page" on a live
  // DexScreener token page.
  const dense = classifyUrl(`https://x.io/solana/${ADDR}`, { nodeCount: 40, hadLivePrice: true });
  assert.equal(dense.looksTokenPage, true, 'address in path wins over node count');
  assert.equal(dense.looksListPage, false);
  // A bare screener with many prices and NO address is still a list.
  const board = classifyUrl('https://x.io/board', { nodeCount: 40, hadLivePrice: true });
  assert.equal(board.looksListPage, true);
  assert.equal(board.looksTokenPage, false);
});

test('corpus: a QUERY-string address is a token page (BullX/Jupiter), not a list (audit regression)', () => {
  // neo.bullx.io/terminal?address=<pair> — address in the QUERY, dense with prices.
  const bullx = classifyUrl(`https://neo.bullx.io/terminal?chainId=1399811149&address=${ADDR}`, { nodeCount: 30, hadLivePrice: true });
  assert.equal(bullx.hasVar, true, 'query address counts as a variable');
  assert.equal(bullx.looksTokenPage, true);
  assert.equal(bullx.looksListPage, false);
  // Jupiter mounts on ?buy=<mint>/?sell=<mint> — buy/sell must be address keys.
  const jup = classifyUrl(`https://jup.ag/swap?buy=${ADDR}&sell=So11111111111111111111111111111111111111112`, { nodeCount: 12 });
  assert.equal(jup.looksTokenPage, true, 'Jupiter ?buy=<mint> is a token page, not a list');
  assert.equal(jup.looksListPage, false);
});

test('corpus: /address/<wallet> is HISTORY; a token page with a history TAB stays a token page', () => {
  const gmgnWallet = classifyUrl(`https://gmgn.ai/sol/address/${WALLET}`, { nodeCount: 5 });
  assert.equal(gmgnWallet.looksHistoryPage, true, 'GMGN /address/<w> is a wallet page (O-10 refuse)');
  assert.equal(gmgnWallet.looksTokenPage, false);
  // A token page with ?tab=holders still has the token address in its path — the
  // adapter MUST mount it (the holders data is a §6 pollution concern, not a
  // reason to refuse the page). Treating it as history caused a false OVER_MOUNT.
  const holdersTab = classifyUrl(`https://x.io/token/${ADDR}?tab=holders`, { nodeCount: 5 });
  assert.equal(holdersTab.looksTokenPage, true, 'a token page with a history tab is still a token page');
  assert.equal(holdersTab.looksHistoryPage, false);
});

test('corpus: a token-only capture is PARTIAL/THIN, never silently complete', () => {
  const nav = [{ ev: 'nav', href: `https://x.io/solana/${ADDR}` }];
  const { coverage } = buildCorpus(nav, [], [], null);
  assert.notEqual(coverage.verdict, 'LANDABLE');
  assert.ok(coverage.gaps.length > 0);
});

// ---------------------------------------------------------------------------
// verify — the crown jewel
// ---------------------------------------------------------------------------

test('verify: a good adapter AGREES — token mounts, wallet refuses, no flags', () => {
  const examples = [
    { rawUrl: `https://x.io/token/${ADDR}`, display: `https://x.io/token/${ADDR}`, ann: { looksTokenPage: true, hadLivePrice: true } },
    { rawUrl: `https://x.io/wallet/${WALLET}`, display: `https://x.io/wallet/${WALLET}`, ann: { looksHistoryPage: true } },
  ];
  const { rows, summary } = runVerify(GOOD_ADAPTER, examples);
  assert.equal(rows[0].mounted, true);
  assert.equal(rows[0].kind, 'mint');
  assert.equal(rows[1].mounted, false);
  assert.equal(summary.high, 0);
  assert.equal(summary.verdict, 'AGREES with the capture');
});

test('verify: catches a MISSED token page (address+live but refused) as HIGH', () => {
  const examples = [
    { rawUrl: `https://x.io/token/${ADDR}`, display: 'd', ann: { looksTokenPage: true, hadLivePrice: true } },
  ];
  const { rows, summary } = runVerify(BLIND_ADAPTER, examples);
  assert.equal(rows[0].mounted, false);
  assert.ok(rows[0].flags.some((f) => f.code === 'MISSED_TOKEN_PAGE' && f.level === 'high'));
  assert.equal(summary.high, 1);
  assert.match(summary.verdict, /DISAGREEMENTS/);
});

test('verify: catches an OVER_MOUNT on a wallet/history page as HIGH (O-10)', () => {
  const examples = [
    { rawUrl: `https://x.io/wallet/${WALLET}`, display: 'd', ann: { looksHistoryPage: true } },
  ];
  const { rows, summary } = runVerify(GREEDY_ADAPTER, examples);
  assert.equal(rows[0].mounted, true);
  assert.ok(rows[0].flags.some((f) => f.code === 'OVER_MOUNT' && f.level === 'high'));
  assert.equal(summary.high, 1);
});

test('verify: flags a list/screener page that mounts as MEDIUM', () => {
  const examples = [
    { rawUrl: `https://x.io/trending/${ADDR}`, display: 'd', ann: { looksListPage: true } },
  ];
  const { rows } = runVerify(GREEDY_ADAPTER, examples);
  assert.ok(rows[0].flags.some((f) => f.code === 'LIST_MOUNT'));
});

test('verify: an adapter that REFUSES a token page is REVIEW, never AGREES (audit regression)', () => {
  // Even a token page with no live price (only a medium flag) must downgrade the
  // verdict — an adapter refusing every token page must not read as "AGREES".
  const examples = [
    { rawUrl: `https://x.io/token/${WALLET}`, display: 'd', ann: { looksTokenPage: true, hadLivePrice: false } },
  ];
  const { summary } = runVerify(BLIND_ADAPTER, examples);
  assert.match(summary.verdict, /REVIEW/);
  assert.notEqual(summary.verdict, 'AGREES with the capture');
});

// ---------------------------------------------------------------------------
// verify — the PREDICTION shape
//
// Prediction venues return {venue, <one market id>, verified} instead of
// {kind, address, chain}. The shape is DECLARED in config, never sniffed, so
// these tests also pin the fail-closed behaviour on an unknown shape: guessing
// is how a verifier applies the wrong contract and reports green against a
// check it never ran.
// ---------------------------------------------------------------------------

const PREDICT_CFG = { global: 'FakePredictSites', shape: 'prediction', venue: 'kalshi' };

// A faithful prediction adapter: mounts on /markets/<series>/<market>,
// refuses everything else, and returns null (never a half-object) when it
// cannot name a market.
const GOOD_PREDICT = `(() => {
  'use strict';
  const api = { detect: (host, pathname) => {
    const m = pathname.match(/^\\/markets\\/([a-z0-9-]+)\\/([a-z0-9-]+)$/);
    return m ? { venue: 'kalshi', marketId: m[2], verified: true } : null;
  } };
  window.FakePredictSites = api; self.FakePredictSites = api;
})();`;

// Refuses everything — the missed-market-page bug.
const BLIND_PREDICT = `(() => {
  'use strict';
  const api = { detect: () => null };
  window.FakePredictSites = api; self.FakePredictSites = api;
})();`;

// Mounts on ANY path, including portfolios — the over-mount bug.
const GREEDY_PREDICT = `(() => {
  'use strict';
  const api = { detect: (host, pathname) => ({ venue: 'kalshi', marketId: pathname.slice(1) || 'x', verified: true }) };
  window.FakePredictSites = api; self.FakePredictSites = api;
})();`;

// Returns an object with no market identifier — the half-mount that reads as
// "we are on a market" and then has nothing to price.
const NO_ID_PREDICT = `(() => {
  'use strict';
  const api = { detect: () => ({ venue: 'kalshi', market: null, verified: false }) };
  window.FakePredictSites = api; self.FakePredictSites = api;
})();`;

test('verify/prediction: a good adapter AGREES — market mounts, portfolio refuses', () => {
  const examples = [
    { rawUrl: 'https://kalshi.com/markets/kxgdp/kxgdp-26oct30', display: 'd', ann: { hadLivePrice: true } },
    { rawUrl: 'https://kalshi.com/portfolio', display: 'd', ann: { looksHistoryPage: true } },
  ];
  const { rows, summary } = runVerify(GOOD_PREDICT, examples, PREDICT_CFG);
  assert.equal(rows[0].mounted, true);
  assert.equal(rows[0].kind, 'marketId');
  assert.equal(rows[0].address, 'kxgdp-26oct30');
  assert.equal(rows[1].mounted, false);
  assert.equal(summary.shape, 'prediction');
  assert.equal(summary.high, 0);
  assert.equal(summary.verdict, 'AGREES with the capture');
});

test('verify/prediction: catches a MISSED market page (live + multi-segment, refused) as HIGH', () => {
  const examples = [
    { rawUrl: 'https://kalshi.com/markets/kxgdp/kxgdp-26oct30', display: 'd', ann: { hadLivePrice: true } },
  ];
  const { rows, summary } = runVerify(BLIND_PREDICT, examples, PREDICT_CFG);
  assert.equal(rows[0].mounted, false);
  assert.ok(rows[0].flags.some((f) => f.code === 'MISSED_MARKET_PAGE' && f.level === 'high'));
  assert.equal(summary.high, 1);
  assert.match(summary.verdict, /DISAGREEMENTS/);
});

test('verify/prediction: catches an OVER_MOUNT on a portfolio page as HIGH', () => {
  const examples = [
    { rawUrl: 'https://kalshi.com/portfolio', display: 'd', ann: { looksHistoryPage: true } },
  ];
  const { rows, summary } = runVerify(GREEDY_PREDICT, examples, PREDICT_CFG);
  assert.equal(rows[0].mounted, true);
  assert.ok(rows[0].flags.some((f) => f.code === 'OVER_MOUNT' && f.level === 'high'));
  assert.equal(summary.high, 1);
});

test('verify/prediction: an auth page that mounts is an OVER_MOUNT, and never counts as a market page', () => {
  // Sign-in screens tick the venue's live prices behind the form, so the
  // live-price signal alone would read them as tradable. The URL here is
  // deliberately MULTI-segment: a single-segment auth route is already
  // excluded by the category-route rule, which would let this lock pass while
  // the auth rule itself was gone.
  const examples = [
    { rawUrl: 'https://kalshi.com/account/sign-in?redirect=%2Fportfolio', display: 'd', ann: { hadLivePrice: true } },
  ];
  const greedy = runVerify(GREEDY_PREDICT, examples, PREDICT_CFG);
  assert.ok(greedy.rows[0].flags.some((f) => f.code === 'OVER_MOUNT' && f.level === 'high'));

  const blind = runVerify(BLIND_PREDICT, examples, PREDICT_CFG);
  assert.equal(blind.rows[0].isMarketPage, false, 'an auth page is never a market page');
  assert.equal(blind.summary.marketPagesTotal, 0, 'an auth page is never a market page');
  assert.equal(blind.summary.high, 0, 'refusing an auth page is correct, not a miss');
});

test('verify/prediction: an object with no market identifier is RETURNED_NO_ID, not a silent refusal', () => {
  const examples = [
    { rawUrl: 'https://app.hyperliquid.xyz/outcomes', display: 'd', ann: { looksListPage: true } },
  ];
  const { rows, summary } = runVerify(NO_ID_PREDICT, examples, PREDICT_CFG);
  assert.equal(rows[0].mounted, false, 'no identifier means not mounted');
  assert.ok(rows[0].flags.some((f) => f.code === 'RETURNED_NO_ID' && f.level === 'high'));
  assert.equal(summary.high, 1);
});

test('verify/prediction: a venue that disagrees with the configured site is VENUE_MISMATCH', () => {
  const examples = [
    { rawUrl: 'https://kalshi.com/markets/kxgdp/kxgdp-26oct30', display: 'd', ann: { hadLivePrice: true } },
  ];
  const { rows, summary } = runVerify(GOOD_PREDICT, examples, { ...PREDICT_CFG, venue: 'polymarket' });
  assert.ok(rows[0].flags.some((f) => f.code === 'VENUE_MISMATCH' && f.level === 'high'));
  assert.equal(summary.high, 1);
});

test('verify/prediction: a single-segment category route that ticks live is MEDIUM, never HIGH', () => {
  // /politics and /new list markets and tick prices; flagging them HIGH every
  // run is how real flags get ignored.
  const examples = [
    { rawUrl: 'https://polymarket.com/politics', display: 'd', ann: { hadLivePrice: true } },
  ];
  const { rows, summary } = runVerify(BLIND_PREDICT, examples, { ...PREDICT_CFG, venue: 'polymarket' });
  assert.ok(rows[0].flags.some((f) => f.code === 'MAYBE_MISSED_MARKET' && f.level === 'medium'));
  assert.equal(summary.high, 0);
});

test('verify/prediction: an unknown adapter.shape is a loud error, never a silent token fallback', () => {
  const examples = [
    { rawUrl: 'https://kalshi.com/markets/kxgdp/kxgdp-26oct30', display: 'd', ann: { hadLivePrice: true } },
  ];
  const { rows, summary } = runVerify(GOOD_PREDICT, examples, { ...PREDICT_CFG, shape: 'sideways' });
  assert.ok(rows[0].error, 'an undeclared shape must not fall back to another contract');
  assert.match(rows[0].error, /unknown adapter\.shape/);
  assert.equal(summary.verdict, 'ADAPTER ERROR');
});

test('verify/prediction: a prediction adapter is not silently run through the token verifier', () => {
  // Same adapter, token shape declared: it exposes no currentSite(), so the
  // verifier must error rather than report every page as a clean refusal.
  const examples = [
    { rawUrl: 'https://kalshi.com/markets/kxgdp/kxgdp-26oct30', display: 'd', ann: { looksTokenPage: true, hadLivePrice: true } },
  ];
  const { summary } = runVerify(GOOD_PREDICT, examples, { global: 'FakePredictSites', shape: 'token' });
  assert.equal(summary.verdict, 'ADAPTER ERROR');
});

test('verify: a broken adapter surfaces as an error, not a false pass', () => {
  const { rows, summary } = runVerify('throw new Error("boom");', [
    { rawUrl: `https://x.io/token/${ADDR}`, display: 'd', ann: { looksTokenPage: true } },
  ]);
  assert.ok(rows[0].error);
  assert.equal(summary.verdict, 'ADAPTER ERROR');
});

test('verify: detectAt loads the vm sandbox and reads location', () => {
  const r = detectAt(GOOD_ADAPTER, `https://x.io/token/${ADDR}`);
  assert.equal(r.siteId, 'fake');
  assert.equal(r.token.address, ADDR);
});

test('verify: assembleExamples dedups by pattern and carries annotations', () => {
  const raw = [
    { url: `https://x.io/token/${ADDR}` },
    { url: `https://x.io/token/${WALLET}` }, // same pattern → deduped
    { url: `https://x.io/wallet/${WALLET}` },
  ];
  const corpusUrls = [
    { host: 'x.io', pattern: '/token/{address}', looksTokenPage: true, hadLivePrice: true },
    { host: 'x.io', pattern: '/wallet/{address}', looksHistoryPage: true },
  ];
  const ex = assembleExamples(raw, corpusUrls, null);
  assert.equal(ex.length, 2, 'two distinct patterns');
  const tok = ex.find((e) => e.rawUrl.includes('/token/'));
  assert.equal(tok.ann.looksTokenPage, true);
  assert.equal(tok.ann.hadLivePrice, true);
});

test('verify: chainsAgree canonicalizes slugs', () => {
  assert.equal(chainsAgree('sol', 'solana'), true);
  assert.equal(chainsAgree('eth', 'ethereum'), true);
  assert.equal(chainsAgree('solana', 'base'), false);
});

// ---------------------------------------------------------------------------
// scaffold
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// wiring — the landing-completeness checker
// ---------------------------------------------------------------------------

function fakeRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ptrecon-repo-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return root;
}

const MANIFEST_WIRED = JSON.stringify({
  content_scripts: [
    { world: 'MAIN', matches: ['https://newsite.io/*', 'https://*.newsite.io/*'] },
    { world: 'ISOLATED', matches: ['https://newsite.io/*'] },
  ],
  web_accessible_resources: [{ matches: ['https://newsite.io/*'], resources: ['x.js'] }],
});

// A project's wiring config (what ptrecon.config.json declares). The tool reads
// the touch list from here, not from hardcoded PaperTrench paths.
const WIRING_CFG = {
  touchList: [
    { file: 'extension/sites.js', label: 'adapter', kind: 'code', required: true },
    { file: 'extension/manifest.json', label: 'manifest', kind: 'manifest', required: true, lists: ['main-content-scripts', 'isolated-content-scripts', 'web-accessible-resources'] },
    { file: 'extension/background.js', label: 'warm', kind: 'code', required: true },
    { file: 'extension/warmdest.js', label: 'warmdest', kind: 'code', required: true },
    { file: 'extension/xray-core.js', label: 'xray', kind: 'code', required: true },
    { file: 'extension/title-feed.js', label: 'title', kind: 'code', requiredWhenFalse: 'titleDefaultFits', noteFits: 'default fits', noteMiss: 'REQUIRED: title differs' },
    { file: 'docs/PERMISSIONS.md', label: 'permissions', kind: 'code', required: true },
    { file: 'docs/QA-MATRIX.md', label: 'qa', kind: 'prose', required: true },
    { file: 'README.md', label: 'readme', kind: 'prose', required: true },
    { file: 'site/index.html', label: 'site', kind: 'prose', required: true },
  ],
};

test('wiring: a fully-wired host reads FULLY WIRED', () => {
  const root = fakeRepo({
    'extension/sites.js': 'match: (h) => /newsite\\.io$/.test(h)',
    'extension/manifest.json': MANIFEST_WIRED,
    'extension/background.js': 'WARM: "https://newsite.io"',
    'extension/warmdest.js': 'const RE = /newsite\\.io/',
    'extension/xray-core.js': 'CA_HOST_RE = /(newsite\\.io|other)/',
    'extension/title-feed.js': '// no entry needed',
    'docs/PERMISSIONS.md': '- newsite.io — a memecoin terminal',
    'docs/QA-MATRIX.md': '| NewSite |',
    'README.md': 'overlays on NewSite and others',
    'site/index.html': '<span>NewSite</span>',
  });
  const res = checkWiring(root, 'newsite.io', { titleDefaultFits: true }, 'NewSite', WIRING_CFG);
  assert.equal(res.verdict, 'FULLY WIRED', JSON.stringify(res.missingRequired));
  assert.equal(res.missingRequired.length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test('wiring: catches a host missing from a code file (the left-on-the-table case)', () => {
  const root = fakeRepo({
    'extension/sites.js': 'match: /newsite\\.io$/',
    'extension/manifest.json': MANIFEST_WIRED,
    'extension/background.js': 'WARM newsite.io',
    'extension/warmdest.js': 'newsite.io',
    // xray-core.js DELIBERATELY missing the host
    'extension/xray-core.js': 'CA_HOST_RE = /(other\\.com)/',
    'extension/title-feed.js': '',
    'docs/PERMISSIONS.md': 'newsite.io',
    'docs/QA-MATRIX.md': 'NewSite', 'README.md': 'NewSite', 'site/index.html': 'NewSite',
  });
  const res = checkWiring(root, 'newsite.io', {}, 'NewSite', WIRING_CFG);
  assert.ok(res.missingRequired.some((r) => r.file === 'extension/xray-core.js'), 'xray-core must be flagged missing');
  assert.match(res.verdict, /REQUIRED code registration/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('wiring: matches an ESCAPED-regex host and a DISPLAY NAME (no false miss)', () => {
  const root = fakeRepo({
    'extension/sites.js': 'newsite.io', 'extension/manifest.json': MANIFEST_WIRED,
    'extension/background.js': 'newsite.io', 'extension/warmdest.js': 'newsite.io',
    'extension/xray-core.js': 'CA_HOST_RE = /(pump\\.fun|newsite\\.io)$/', // escaped dot
    'extension/title-feed.js': '',
    'docs/PERMISSIONS.md': 'newsite.io',
    'docs/QA-MATRIX.md': '| NewSite |', 'README.md': 'NewSite', 'site/index.html': 'NewSite',
  });
  const res = checkWiring(root, 'newsite.io', { titleDefaultFits: true }, 'NewSite', WIRING_CFG);
  const xray = res.rows.find((r) => r.file === 'extension/xray-core.js');
  assert.equal(xray.status, true, 'escaped-regex host must match (backslashes stripped)');
  fs.rmSync(root, { recursive: true, force: true });
});

test('wiring: manifest missing one of the three lists is flagged', () => {
  const root = fakeRepo({
    'extension/sites.js': 'newsite.io',
    'extension/manifest.json': JSON.stringify({
      content_scripts: [{ world: 'MAIN', matches: ['https://newsite.io/*'] }], // ISOLATED + WAR missing
      web_accessible_resources: [{ matches: ['https://other.com/*'] }],
    }),
    'extension/background.js': 'newsite.io', 'extension/warmdest.js': 'newsite.io',
    'extension/xray-core.js': 'newsite.io', 'extension/title-feed.js': '',
    'docs/PERMISSIONS.md': 'newsite.io', 'docs/QA-MATRIX.md': 'NewSite',
    'README.md': 'NewSite', 'site/index.html': 'NewSite',
  });
  const res = checkWiring(root, 'newsite.io', {}, 'NewSite', WIRING_CFG);
  const man = res.rows.find((r) => r.file === 'extension/manifest.json');
  assert.equal(man.status, false, 'manifest missing ISOLATED + WAR must fail');
  assert.match(man.note, /isolated/i);
  assert.match(man.note, /web-accessible/i);
  fs.rmSync(root, { recursive: true, force: true });
});

test('wiring: title-feed is REQUIRED when the dossier says the default title does not fit', () => {
  const base = {
    'extension/sites.js': 'newsite.io', 'extension/manifest.json': MANIFEST_WIRED,
    'extension/background.js': 'newsite.io', 'extension/warmdest.js': 'newsite.io',
    'extension/xray-core.js': 'newsite.io',
    'extension/title-feed.js': 'const TITLE_PATTERNS = { axiom: /x/ };', // no host here
    'docs/PERMISSIONS.md': 'newsite.io', 'docs/QA-MATRIX.md': 'NewSite',
    'README.md': 'NewSite', 'site/index.html': 'NewSite',
  };
  const fits = checkWiring(fakeRepo(base), 'newsite.io', { titleDefaultFits: true }, 'NewSite', WIRING_CFG);
  assert.ok(!fits.missingRequired.some((r) => r.file === 'extension/title-feed.js'), 'title optional when default fits');
  const noFit = checkWiring(fakeRepo(base), 'newsite.io', { titleDefaultFits: false }, 'NewSite', WIRING_CFG);
  assert.ok(noFit.missingRequired.some((r) => r.file === 'extension/title-feed.js'), 'title REQUIRED when default does not fit');
});

test('wiring: registrable() reduces a subdomain to its registrable domain', () => {
  assert.equal(registrable('trade.padre.gg'), 'padre.gg');
  assert.equal(registrable('gmgn.ai'), 'gmgn.ai');
  assert.equal(registrable('photon-sol.tinyastro.io'), 'tinyastro.io');
});

// ---------------------------------------------------------------------------
// portability — the tool works for a NON-PaperTrench project via config
// ---------------------------------------------------------------------------

test('config: loadConfig discovers a project config and merges over defaults', () => {
  const root = fakeRepo({ 'ptrecon.config.json': JSON.stringify({ project: 'other', adapter: { file: 'src/x.js', global: 'Foo' } }) });
  const { projectRoot, config, found } = loadConfig({ project: root }, '/nonexistent');
  assert.equal(found, true);
  assert.equal(projectRoot, root);
  assert.equal(config.project, 'other');
  assert.equal(config.adapter.global, 'Foo');
  assert.equal(config.adapter.currentSite, 'currentSite', 'default merged in');
  assert.equal(config.dataDir, 'recon-data', 'default dataDir');
  fs.rmSync(root, { recursive: true, force: true });
});

test('config: mergeDenylists — an EMPTY leftover cannot shadow the real list (audit CRITICAL)', () => {
  // The refactor briefly let an empty recon-data/DENYLIST.local shadow a populated
  // denylist in a relocated PT_RECON_DATA store → scrubber inert → leak. Merge, skip empties.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptrecon-deny-'));
  const empty = path.join(dir, 'empty.local');
  const real = path.join(dir, 'real.local');
  fs.writeFileSync(empty, '   \n\n'); // whitespace-only leftover
  fs.writeFileSync(real, 'satoshiwallet7000\n');
  // Empty listed FIRST (the shadowing position) must not win.
  const merged = mergeDenylists([empty, real]);
  assert.match(merged, /satoshiwallet7000/, 'the populated list is used even behind an empty leftover');
  // A missing file is skipped; identical paths deduped; all-empty → ''.
  assert.equal(mergeDenylists([empty, '/does/not/exist', empty]).trim(), '');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cdp: connectToRunning errors clearly on an unreachable endpoint (attach)', async () => {
  const { connectToRunning } = require('../lib/cdp');
  await assert.rejects(connectToRunning('http://127.0.0.1:1'), /could not reach a running Chrome/);
});

test('config: attach + chromeProfile are known keys (login-frictionless options)', () => {
  assert.ok('attach' in DEFAULTS, 'attach is a config key');
  assert.ok('chromeProfile' in DEFAULTS, 'chromeProfile is a config key');
  const merged = deepMerge(DEFAULTS, { attach: 'http://127.0.0.1:9222' });
  assert.equal(merged.attach, 'http://127.0.0.1:9222');
});

test('config: a MALFORMED config throws (never silently falls back to defaults)', () => {
  const root = fakeRepo({ 'ptrecon.config.json': '{ "adapter": { bad json ' });
  assert.throws(() => loadConfig({ project: root }, '/nope'), /malformed JSON/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('wiring: a string `required` naming a flag works like requiredWhenFalse', () => {
  const base = {
    'src/a.js': 'newsite.io', 'README.md': 'NewSite',
    'src/title.js': 'unrelated content',
  };
  const cfg = { touchList: [
    { file: 'src/a.js', label: 'adapter', kind: 'code', required: true },
    { file: 'README.md', label: 'docs', kind: 'prose', required: true },
    { file: 'src/title.js', label: 'title', kind: 'code', required: 'titleDefaultFits' }, // string-flag form
  ] };
  const fits = checkWiring(fakeRepo(base), 'newsite.io', { titleDefaultFits: true }, 'NewSite', cfg);
  assert.ok(!fits.missingRequired.some((r) => r.file === 'src/title.js'), 'optional when the flag is true');
  const noFit = checkWiring(fakeRepo(base), 'newsite.io', { titleDefaultFits: false }, 'NewSite', cfg);
  assert.ok(noFit.missingRequired.some((r) => r.file === 'src/title.js'), 'REQUIRED when the flag is false');
});

test('config: writeInitConfig scaffolds a config and never clobbers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptrecon-init-'));
  const a = writeInitConfig(dir);
  assert.equal(a.created, true);
  assert.ok(fs.existsSync(a.dest));
  const b = writeInitConfig(dir);
  assert.equal(b.created, false, 'second call must not overwrite');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('verify: a NON-PaperTrench adapter contract works via adapterCfg (universal)', () => {
  // A different project sets a DIFFERENT global and API method — declared in
  // ptrecon.config.json. The verifier must drive it, not assume PaperTrenchSites.
  const CURSOR_ADAPTER = `(() => {
    const api = { whichSite: () => ({ id: 'cursor', resolve: () => {
      const m = location.pathname.match(/^\\/coin\\/([1-9A-HJ-NP-Za-km-z]{32,44})/);
      return m ? { kind: 'mint', address: m[1] } : null;
    } }) };
    globalThis.CursorTerminals = api;
  })();`;
  const cfg = { global: 'CursorTerminals', currentSite: 'whichSite', detect: 'resolve', file: 'cursor.js' };
  const examples = [{ rawUrl: `https://x.io/coin/${ADDR}`, display: 'd', ann: { looksTokenPage: true, hadLivePrice: true } }];
  const { rows, summary } = runVerify(CURSOR_ADAPTER, examples, cfg);
  assert.equal(rows[0].mounted, true, 'the custom-global adapter mounted the token page');
  assert.equal(rows[0].address, ADDR);
  assert.equal(summary.verdict, 'AGREES with the capture');
});

test('wiring: works for a NON-PaperTrench project touch list (universal)', () => {
  // A completely different project shape — no extension/, different files.
  const root = fakeRepo({
    'src/adapters.ts': 'match host newsite.io',
    'app.manifest.json': JSON.stringify({ content_scripts: [{ matches: ['https://newsite.io/*'] }], host_permissions: ['https://newsite.io/*'] }),
    'SITES.md': 'we support NewSite',
  });
  const cfg = {
    touchList: [
      { file: 'src/adapters.ts', label: 'adapter', kind: 'code', required: true },
      { file: 'app.manifest.json', label: 'manifest', kind: 'manifest', required: true, lists: ['content_scripts', 'host_permissions'] },
      { file: 'SITES.md', label: 'docs', kind: 'prose', required: true },
      { file: 'missing.js', label: 'a file they forgot', kind: 'code', required: true },
    ],
  };
  const res = checkWiring(root, 'newsite.io', {}, 'NewSite', cfg);
  assert.ok(res.rows.find((r) => r.file === 'src/adapters.ts').status, 'adapter present');
  assert.ok(res.rows.find((r) => r.file === 'app.manifest.json').status, 'manifest lists present');
  assert.ok(res.missingRequired.some((r) => r.file === 'missing.js'), 'the forgotten file is flagged');
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// driftdiff — drift watch
// ---------------------------------------------------------------------------

function fakeDossier(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ptrecon-dos-'));
  for (const [name, obj] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), JSON.stringify(obj));
  return dir;
}

test('driftdiff: a removed route/endpoint/anchor is a REGRESSION, additions are not', () => {
  const oldD = fakeDossier({
    'routes.json': [{ host: 'x.io', pattern: '/{chain}/{address}' }, { host: 'x.io', pattern: '/lp/{address}' }],
    'endpoints.json': [{ method: 'GET', host: 'api.x.io', pattern: '/price/{address}' }],
    'ws.json': [{ url: 'wss://s.x.io/feed' }],
    'anchors.json': [{ path: 'div.price', count: 200 }, { path: 'div.rare', count: 2 }],
    'summary.json': { chains: ['solana'], titleDefaultFits: true, hasWsFrames: true },
  });
  const newD = fakeDossier({
    // /lp/{address} route REMOVED (a redesign); a new route added
    'routes.json': [{ host: 'x.io', pattern: '/{chain}/{address}' }, { host: 'x.io', pattern: '/t/{address}' }],
    'endpoints.json': [], // the price endpoint VANISHED
    'ws.json': [{ url: 'wss://s.x.io/feed' }],
    'anchors.json': [{ path: 'div.rare', count: 2 }], // div.price (stable, 200x) GONE
    'summary.json': { chains: ['solana', 'base'], titleDefaultFits: true, hasWsFrames: true },
  });
  const d = diffDossiers(oldD, newD);
  assert.ok(d.routes.removed.includes('x.io/lp/{address}'), 'removed route flagged');
  assert.ok(d.routes.added.includes('x.io/t/{address}'), 'added route noted');
  assert.equal(d.endpoints.removed.length, 1, 'vanished endpoint flagged');
  assert.ok(d.anchorsGone.some((a) => a.path === 'div.price'), 'the STABLE anchor that vanished is flagged');
  assert.ok(!d.anchorsGone.some((a) => a.path === 'div.rare'), 'a rarely-seen anchor is not a regression');
  assert.ok(d.shifts.some((s) => s.severity === 'info' && /base/.test(s.what)), 'new chain is info');
  assert.match(d.verdict, /review/);
  assert.ok(d.removedCount >= 3);
  fs.rmSync(oldD, { recursive: true, force: true }); fs.rmSync(newD, { recursive: true, force: true });
});

test('driftdiff: identical dossiers report NO DRIFT', () => {
  const files = {
    'routes.json': [{ host: 'x.io', pattern: '/t/{address}' }],
    'endpoints.json': [{ method: 'GET', host: 'api.x.io', pattern: '/p' }],
    'ws.json': [], 'anchors.json': [{ path: 'div.p', count: 50 }],
    'summary.json': { chains: ['solana'], titleDefaultFits: true },
  };
  const a = fakeDossier(files); const b = fakeDossier(files);
  const d = diffDossiers(a, b);
  assert.equal(d.verdict, 'NO DRIFT');
  assert.equal(d.removedCount, 0);
  fs.rmSync(a, { recursive: true, force: true }); fs.rmSync(b, { recursive: true, force: true });
});

test('driftdiff: a WS that stops delivering frames is a warning (live source moved)', () => {
  const oldD = fakeDossier({ 'summary.json': { hasWsFrames: true, chains: [] } });
  const newD = fakeDossier({ 'summary.json': { hasWsFrames: false, chains: [] } });
  const d = diffDossiers(oldD, newD);
  assert.ok(d.shifts.some((s) => s.severity === 'warn' && /WebSocket/.test(s.what)));
  assert.ok(d.removedCount >= 1);
  fs.rmSync(oldD, { recursive: true, force: true }); fs.rmSync(newD, { recursive: true, force: true });
});

test('scaffold: emits valid-JS gating test + fake stub grounded in the dossier', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ptrecon-scaf-'));
  const dossier = path.join(tmp, 'dossier');
  fs.mkdirSync(dossier, { recursive: true });
  fs.writeFileSync(path.join(dossier, 'corpus.json'), JSON.stringify({
    urls: [
      { example: `https://x.io/solana/${ADDR}`, host: 'x.io', pattern: '/{chain}/{address}', chain: 'solana', looksTokenPage: true, hadLivePrice: true, priceNodeCount: 1 },
      { example: `https://x.io/wallet/${WALLET}`, host: 'x.io', pattern: '/wallet/{address}', looksHistoryPage: true },
    ],
  }));
  fs.writeFileSync(path.join(dossier, 'endpoints.json'), JSON.stringify([
    { method: 'GET', host: 'api.x.io', pattern: '/price/{address}', statuses: { 200: 3 }, schema: ['$: object', '  price: number'], fixtureRef: 'fixtures/f.json' },
  ]));
  fs.writeFileSync(path.join(dossier, 'ws.json'), JSON.stringify([]));

  const out = path.join(tmp, 'scaffold');
  const res = scaffold(dossier, out, 'demosite');
  assert.equal(res.tokenPages, 1);
  assert.equal(res.refuseRoutes, 1);

  const gating = fs.readFileSync(path.join(out, 'demosite.gating.test.js'), 'utf8');
  // Generated file must be valid JS (the memory: node --check every inline script).
  assert.doesNotThrow(() => new (require('node:vm').Script)(gating, { filename: 'gen' }));
  assert.match(gating, new RegExp(ADDR));       // the real captured token URL is embedded
  assert.match(gating, /MOUNTS|REFUSALS/);
  assert.match(gating, /TODO/);                 // human-judgment markers present

  const stub = fs.readFileSync(path.join(out, 'demosite.fake.stub.js'), 'utf8');
  assert.doesNotThrow(() => new (require('node:vm').Script)(stub, { filename: 'gen' }));
  assert.match(stub, /price: number/);          // observed schema carried in
  assert.match(stub, /F-39/);                   // the honesty note survives
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('scaffold: a HOSTILE captured URL cannot break out of the generated JS (audit regression)', () => {
  // A captured URL containing a quote/newline/JS must not escape the string
  // literal into executable code in the generated test.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ptrecon-inj-'));
  const dossier = path.join(tmp, 'dossier');
  fs.mkdirSync(dossier, { recursive: true });
  const evil = "https://x.io/'+require('child_process').execSync('rm -rf /')+'/" + ADDR + "\n//";
  fs.writeFileSync(path.join(dossier, 'corpus.json'), JSON.stringify({
    urls: [
      { example: evil, host: 'x.io', pattern: '/{address}', looksTokenPage: true, hadLivePrice: true },
      { example: "https://x.io/wallet/`+process.exit(1)+`", host: 'x.io', pattern: '/wallet/{address}', looksHistoryPage: true },
    ],
  }));
  fs.writeFileSync(path.join(dossier, 'endpoints.json'), JSON.stringify([
    { method: 'GET', host: 'api.x.io', pattern: '/p', statuses: { 200: 1 }, schema: ['$: object', '  x: string */\nprocess.exit(1)//'] }, // hostile schema line
  ]));
  fs.writeFileSync(path.join(dossier, 'ws.json'), JSON.stringify([]));
  const out = path.join(tmp, 'scaffold');
  scaffold(dossier, out, 'evilsite');
  const gating = fs.readFileSync(path.join(out, 'evilsite.gating.test.js'), 'utf8');
  const stub = fs.readFileSync(path.join(out, 'evilsite.fake.stub.js'), 'utf8');
  // The generated files must still be VALID, non-executing JS (no break-out).
  assert.doesNotThrow(() => new (require('node:vm').Script)(gating, { filename: 'g' }), 'gating test must remain valid JS');
  assert.doesNotThrow(() => new (require('node:vm').Script)(stub, { filename: 's' }), 'fake stub must remain valid JS');
  // The hostile payload must be a quoted string, not live code.
  assert.ok(!/^\s*process\.exit/m.test(stub), 'no injected top-level statement in the stub');
  fs.rmSync(tmp, { recursive: true, force: true });
});
