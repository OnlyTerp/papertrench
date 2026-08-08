/* Site gating — where the overlay may exist (DEFECTS O-09..O-13, F-24).
 *
 * The Phase-1 audit mapped every URL shape that wrongly mounted the panel:
 * wallet/portfolio/leaderboard routes ending in base58 addresses, EVM routes
 * whose hex addresses contain base58-passing runs (~13% of them), and — via
 * the <all_urls> manifest — literally any page on the internet with an
 * address-shaped string in its URL. This file is the overlay presence matrix
 * from ROADMAP.md Phase 3, as an executable table.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'sites.js'), 'utf8');

const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const PAIR = 'PooLAddress1111111111111111111111111111111';
const WALLET = 'MfDuWeqSHEqTFVYZ7LoexgAK9dxk7cy4DFJWjWMGVWa';
// An EVM address whose 40 hex chars contain no '0': the whole run passes
// base58, which is exactly how EVM routes leaked into the Solana resolver.
const EVM_B58ISH = '0xabcdef1234567891abcdef1234567891abcdef12';

function detectAt(href) {
  const url = new URL(href);
  const sandbox = {
    window: {},
    self: {},
    location: {
      href,
      hostname: url.hostname,
      pathname: url.pathname,
      search: url.search,
    },
    URLSearchParams,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'sites.js' });
  const site = sandbox.window.PaperTrenchSites.currentSite();
  return { id: site.id, token: site.detect() };
}

/* [href, expected site id, expected kind|null, expected address|null, why] */
const MATRIX = [
  // Axiom — token page is /meme|/t/<address>?chain=<slug>, chain in the QUERY
  // (live logged-in capture 2026-08-07, pt-recon). No ?chain= means Solana, so
  // old links and Axiom's own tokenUrl() output still resolve unchanged.
  ['https://axiom.trade/meme/' + PAIR, 'axiom', 'pair', PAIR, 'meme route is a pair page (no chain = solana)'],
  ['https://axiom.trade/meme/' + PAIR + '?chain=sol', 'axiom', 'pair', PAIR, 'explicit sol slug is solana'],
  ['https://axiom.trade/t/' + MINT, 'axiom', 'mint', MINT, '/t/ carries a MINT — was mislabeled kind:pair (O-13)'],
  ['https://axiom.trade/t/' + MINT + '?chain=sol', 'axiom', 'mint', MINT, '/t/ mint under an explicit sol slug'],
  ['https://axiom.trade/', 'axiom', null, null, 'home is not a token page'],
  ['https://axiom.trade/pulse', 'axiom', null, null, 'screener is not a token page'],
  ['https://axiom.trade/tracker/' + WALLET, 'axiom', null, null, 'wallet tracker must not mount (O-10)'],
  // Foreign chains are GATED OFF for v3.0.0 — recognised via ?chain= and
  // declined, never misparsed (O-11). The slugs are Axiom's own vocabulary.
  ['https://axiom.trade/meme/' + EVM_B58ISH + '?chain=bnb', 'axiom', null, null, 'bnb (BSC) recognised and declined while gated (O-11)'],
  ['https://axiom.trade/meme/' + EVM_B58ISH + '?chain=eth', 'axiom', null, null, 'eth declined; the base58-passing hex is refused by CHAIN, not a failed parse (O-11)'],
  ['https://axiom.trade/meme/' + EVM_B58ISH + '?chain=robinhood', 'axiom', null, null, 'robinhood (tokenized equities) recognised and declined while gated'],
  ['https://axiom.trade/meme/' + MINT + '?chain=eth', 'axiom', null, null, 'a base58 mint under an EVM slug is refused (O-11, shape-strict)'],
  ['https://axiom.trade/meme/' + EVM_B58ISH + '?chain=sol', 'axiom', null, null, 'an EVM address under the sol slug is refused (O-11, shape-strict)'],
  ['https://axiom.trade/meme/' + PAIR + '?chain=notachain', 'axiom', null, null, 'an unknown chain slug fails closed'],
  // Padre
  ['https://trade.padre.gg/trade/solana/' + MINT, 'padre', 'mint', MINT, 'trade route'],
  ['https://trade.padre.gg/trade/' + MINT, 'padre', 'mint', MINT, 'trade route without chain segment'],
  ['https://trade.padre.gg/trenches', 'padre', null, null, 'screener is not a token page'],
  ['https://trade.padre.gg/wallet/' + WALLET, 'padre', null, null, 'wallet route must not mount (O-10)'],
  ['https://trade.padre.gg/leaderboard/' + WALLET, 'padre', null, null, 'leaderboard must not mount (O-10)'],
  // Photon
  ['https://photon-sol.tinyastro.io/en/lp/' + PAIR, 'photon', 'pair', PAIR, 'lp route'],
  ['https://photon-sol.tinyastro.io/en/r/' + MINT, 'photon', 'mint', MINT, "Photon's own tokenUrl shape must detect (O-12)"],
  ['https://photon-sol.tinyastro.io/en/memescope', 'photon', null, null, 'screener is not a token page'],
  // GMGN
  ['https://gmgn.ai/sol/token/' + MINT, 'gmgn', 'mint', MINT, 'token route'],
  ['https://gmgn.ai/sol/address/' + WALLET, 'gmgn', null, null, 'wallet analysis must not mount (O-10)'],
  // Foreign chains are GATED OFF for v3.0.0 (per-chain native balances land
  // first — see MULTICHAIN_ENABLED in sites.js). This address is the one
  // whose hex passes base58, and it is refused because we recognise the
  // chain and decline it, not because a parse failed. The full per-chain
  // matrix, including proof that flipping the gate resolves these to their
  // real chains, lives in test/chainrouting.test.js.
  ['https://gmgn.ai/eth/token/' + EVM_B58ISH, 'gmgn', null, null, 'EVM chains are gated off; refused by CHAIN, never mistaken for a Solana mint (O-11)'],
  // BullX
  ['https://neo.bullx.io/terminal?chainId=1399811149&address=' + PAIR, 'bullx', 'pair', PAIR, 'solana terminal'],
  ['https://neo.bullx.io/terminal?address=' + PAIR, 'bullx', 'pair', PAIR, 'no chainId defaults to accepting solana'],
  ['https://neo.bullx.io/terminal?chainId=1&address=' + EVM_B58ISH, 'bullx', null, null, 'EVM chainId is not ours (O-11)'],
  ['https://neo.bullx.io/terminal?chainId=1399811149&address=' + EVM_B58ISH, 'bullx', null, null, 'address must be WHOLE base58, not contain a run (O-11)'],
  ['https://neo.bullx.io/portfolio/' + WALLET, 'bullx', null, null, 'portfolio must not mount (O-10)'],
  // Dexscreener
  ['https://dexscreener.com/solana/' + PAIR, 'dexscreener', 'pair', PAIR, 'solana pair page'],
  ['https://dexscreener.com/ethereum/' + EVM_B58ISH, 'dexscreener', null, null, 'EVM chains gated off; refused by chain, never reaching the Solana resolver (O-11)'],
  ['https://dexscreener.com/watchlist', 'dexscreener', null, null, 'watchlist is not a token page'],
  // Birdeye
  ['https://birdeye.so/token/' + MINT + '?chain=solana', 'birdeye', 'mint', MINT, 'token route'],
  // A base58 mint under an explicit ethereum chain is a contradiction, and
  // shape-strictness still refuses it outright.
  ['https://birdeye.so/token/' + MINT + '?chain=ethereum', 'birdeye', null, null, 'a base58 mint under an EVM chain is refused (O-11, shape-strict)'],
  ['https://birdeye.so/profile/' + WALLET, 'birdeye', null, null, 'profile must not mount (O-10)'],
  // Jupiter
  ['https://jup.ag/swap?inputMint=So11111111111111111111111111111111111111112&outputMint=' + MINT, 'jupiter', 'mint', MINT, 'swap output mint'],
  ['https://jup.ag/portfolio/' + WALLET, 'jupiter', null, null, 'portfolio must not mount (O-10)'],
  // Pump.fun — had NO adapter at all (F-24)
  ['https://pump.fun/coin/' + MINT, 'pumpfun', 'mint', MINT, 'coin route'],
  ['https://pump.fun/' + MINT, 'pumpfun', 'mint', MINT, 'legacy bare mint route'],
  ['https://pump.fun/board', 'pumpfun', null, null, 'board is not a token page'],
  // Fomo (fomo.family) — multichain app, token pages at /tokens/<chain>/<address>
  ['https://fomo.family/tokens/solana/' + MINT, 'fomo', 'mint', MINT, 'token route (solana chain slug + whole-mint address)'],
  ['https://fomo.family/tokens/solana/' + MINT + '?ref=abc', 'fomo', 'mint', MINT, 'query strings do not change the route'],
  // MULTICHAIN (maintainer order, docs/MULTICHAIN.md): every corpus slug
  // mounts — with O-11 surviving as strict per-chain shape validation.
  // GATED for v3.0.0: these live-corpus EVM pages parse correctly and are
  // declined by chain until per-chain native balances ship. The addresses
  // stay here on purpose — they are the real corpus, and the rows invert
  // back when the gate opens (see sites.js MULTICHAIN_ENABLED).
  ['https://fomo.family/tokens/robinhood/0xdc29db7d4396ed738710a5373a30afc197e7268a', 'fomo', null, null, 'live-captured robinhood token is recognised and declined (gated)'],
  ['https://fomo.family/tokens/bnb/0xfe189e97832da1573e4e4ff034f4ffc3a15c7777', 'fomo', null, null, 'live-corpus bnb token declined (gated)'],
  ['https://fomo.family/tokens/ethereum/0x32708538a107253b51a735a724330a23106ca4ca', 'fomo', null, null, 'live-corpus ethereum token declined (gated)'],
  ['https://fomo.family/tokens/base/' + EVM_B58ISH, 'fomo', null, null, 'a base58-passing EVM address is declined by CHAIN, never read as a mint (O-11)'],
  ['https://fomo.family/tokens/base/0x' + 'gg'.repeat(20), 'fomo', null, null, 'non-hex under an EVM slug is refused (O-11, shape-strict)'],
  ['https://fomo.family/tokens/base/0x' + 'ab'.repeat(19), 'fomo', null, null, 'a short 0x run is refused (O-11, shape-strict)'],
  ['https://fomo.family/tokens/ethereum/' + MINT, 'fomo', null, null, 'a base58 mint under an EVM slug is still refused (O-11, shape-strict)'],
  ['https://fomo.family/tokens/solana/0x32708538a107253b51a735a724330a23106ca4ca', 'fomo', null, null, 'an EVM address under the solana slug is refused (O-11, shape-strict)'],
  ['https://fomo.family/tokens/notachain/0x32708538a107253b51a735a724330a23106ca4ca', 'fomo', null, null, 'unknown chain slugs never mount'],
  ['https://fomo.family/u/sometrader', 'fomo', null, null, 'profile routes must not mount (O-10)'],
  ['https://fomo.family/profile/sometrader', 'fomo', null, null, 'profile routes must not mount (O-10)'],
  ['https://fomo.family/prices/bonk', 'fomo', null, null, 'ticker-slug price pages carry no mint — never guess'],
  ['https://fomo.family/', 'fomo', null, null, 'landing page is not a token page'],
  // Lute (lute.gg) — Solana-only terminal, token pages at /trade/<base58>
  ['https://lute.gg/trade/' + MINT, 'lute', 'mint', MINT, 'token route'],
  ['https://lute.gg/trade/' + MINT + '?ref=abc', 'lute', 'mint', MINT, 'query strings do not change the route'],
  ['https://lute.gg/trade/compass', 'lute', null, null, 'named route compass must not mount (O-10)'],
  ['https://lute.gg/trade/momentum', 'lute', null, null, 'named route momentum must not mount (O-10)'],
  ['https://lute.gg/trade/portfolio', 'lute', null, null, 'named route portfolio must not mount (O-10)'],
  ['https://lute.gg/trade/discover', 'lute', null, null, 'named route discover must not mount (O-10)'],
  ['https://lute.gg/trade/predict', 'lute', null, null, 'named route predict must not mount (O-10; live-verified 2026-08-06, missed by the landing corpus)'],
  ['https://lute.gg/trade', 'lute', null, null, 'bare /trade is the terminal home, not a token page'],
  ['https://lute.gg/', 'lute', null, null, 'landing page is not a token page'],
  ['https://lute.gg/login', 'lute', null, null, 'login page must not mount (O-10)'],
  ['https://lute.gg/signup', 'lute', null, null, 'signup page must not mount (O-10)'],
];

test('overlay presence matrix: every audited URL shape gates correctly', () => {
  for (const [href, id, kind, address, why] of MATRIX) {
    const got = detectAt(href);
    assert.equal(got.id, id, `${href} must route to the ${id} adapter`);
    if (kind === null) {
      assert.equal(got.token, null, `${href}: ${why}`);
    } else {
      assert.ok(got.token, `${href}: ${why}`);
      assert.equal(got.token.kind, kind, `${href}: wrong kind — ${why}`);
      assert.equal(got.token.address, address, `${href}: wrong address — ${why}`);
      // Multichain: fomo results carry their chain; EVM slugs must NEVER
      // come back tagged solana (that would route them to Solana pricing).
      if (id === 'fomo') {
        const slug = href.match(/\/tokens\/([a-z-]+)\//);
        assert.equal(got.token.chain, slug ? slug[1] : 'solana',
          `${href}: the detected chain must match the URL slug`);
      }
      // Lute is always Solana
      if (id === 'lute' && got.token) {
        assert.equal(got.token.chain, 'solana',
          `${href}: lute is Solana-only`);
      }
    }
  }
});

test('the manifest no longer injects into every page on the internet', () => {
  // DEFECTS O-08/O-09/F-24: <all_urls> ran the bridge's listeners, three
  // intervals and a body-wide MutationObserver on every website the user
  // visited, and the generic adapter mounted the panel wherever a URL
  // contained an address-shaped string. The manifest is the structural fix.
  //
  // v2.4.0 adds a second injection surface: passive viewer bridges on
  // x.com/twitter.com for the opt-in warm-links feature, joined in v2.6.0 by
  // the X-Ray observer and panel. The perps expansion adds a third: the
  // perps stack on its own venue hosts. The site relay adds a fourth: ONE
  // file on papertrench.com only, carrying the sign-in identity echo and
  // the Sync relay. The rule stays the same shape — every entry is the
  // trading surface, the X surface, the perps surface, or the site relay,
  // each pinned to its own CLOSED host list, and nothing runs anywhere
  // else. A new file only reaches a surface by being named here, which is
  // the review step that keeps each engine off the others' sites by
  // construction.
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const X_VIEWER_FILES = new Set([
    'xwarm-main.js', 'xwarm-relay.js',
    'xray-core.js', 'xray-main.js', 'xray-panel.js',
  ]);
  const PERPS_FILES = new Set([
    'perps-venues.js', 'perps.js', 'bar-store.js', 'ta-core.js',
    'perps-sites.js', 'perps-reconcile.js', 'perps-ticket.js',
    'perps-chart.js', 'perps-content.js',
  ]);
  const PERPS_HOSTS = new Set([
    'https://app.hyperliquid.xyz/*', 'https://jup.ag/*', 'https://*.jup.ag/*',
  ]);
  const RELAY_FILES = new Set(['site-bridge.js']);
  const RELAY_HOSTS = new Set([
    'https://papertrench.com/*', 'https://www.papertrench.com/*',
  ]);
  const isXEntry = (cs) => (cs.js || []).some((f) => X_VIEWER_FILES.has(f));
  const isPerpsEntry = (cs) => (cs.js || []).some((f) => PERPS_FILES.has(f));
  const isRelayEntry = (cs) => (cs.js || []).some((f) => RELAY_FILES.has(f));

  for (const script of manifest.content_scripts) {
    assert.ok(!script.matches.includes('<all_urls>'),
      'content scripts must be limited to supported sites');
  }

  const trading = manifest.content_scripts.filter((cs) => !isXEntry(cs) && !isPerpsEntry(cs) && !isRelayEntry(cs));
  const xViewer = manifest.content_scripts.filter(isXEntry);
  const perps = manifest.content_scripts.filter(isPerpsEntry);
  const relay = manifest.content_scripts.filter(isRelayEntry);
  assert.ok(trading.length >= 2 && xViewer.length === 3,
    'expected the two trading-surface entries plus the three X surface entries');
  assert.equal(perps.length, 1, 'the perps stack rides exactly one entry');
  assert.equal(relay.length, 1, 'the site relay rides exactly one entry');

  for (const script of relay) {
    assert.ok(script.matches.every((m) => RELAY_HOSTS.has(m)),
      'the site relay is pinned to papertrench.com and nowhere else');
    assert.ok(script.js.every((f) => RELAY_FILES.has(f)),
      'the relay entry may carry ONLY site-bridge.js — never an engine, overlay or bridge');
  }
  for (const script of trading.concat(xViewer, perps)) {
    assert.ok(!(script.js || []).some((f) => RELAY_FILES.has(f)),
      'the site relay must not leak onto any other surface');
  }

  for (const script of perps) {
    assert.ok(script.matches.every((m) => PERPS_HOSTS.has(m)),
      'the perps surface is pinned to its own closed venue host list');
    assert.ok(script.js.every((f) => PERPS_FILES.has(f)),
      'the perps entry may carry ONLY the perps stack — never the spot engine or overlay');
    assert.ok(!script.matches.some((m) => m.includes('x.com') || m.includes('twitter.com')),
      'the perps surface must never run on X');
  }
  for (const script of trading.concat(xViewer)) {
    assert.ok(!(script.js || []).some((f) => PERPS_FILES.has(f)),
      'the perps stack must not leak onto the spot or X surfaces');
  }

  for (const script of trading) {
    assert.ok(script.matches.includes('https://pump.fun/*'),
      'pump.fun is a first-class supported site');
    assert.ok(script.matches.includes('https://fomo.family/*'),
      'fomo.family is a first-class supported site');
    assert.ok(!script.matches.some((m) => m.includes('x.com') || m.includes('twitter.com')),
      'the trading overlay must never run on X itself');
  }
  for (const script of xViewer) {
    assert.ok(script.matches.every((m) => /https:\/\/(\*\.)?(x|twitter)\.com\/\*/.test(m)),
      'X viewer entries must match only x.com/twitter.com');
    assert.ok(script.js.every((f) => X_VIEWER_FILES.has(f)),
      'X entries may carry ONLY the passive viewer bridges — never the trading engine or overlay');
  }
  for (const resource of manifest.web_accessible_resources) {
    assert.ok(!resource.matches.includes('<all_urls>'),
      'web-accessible resources must be limited to supported sites');
    assert.ok(!resource.matches.some((m) => m.includes('x.com') || m.includes('twitter.com')),
      'nothing is web-accessible to X pages');
  }
});
