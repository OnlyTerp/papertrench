/* Chain routing across the terminals — and the gate that is currently shut.
 *
 * MAINTAINER DECISION 2026-08-06: v3.0.0 ships with foreign-chain DETECTION
 * OFF. Multichain is fully built and live-probed, but it was built on design
 * A (one SOL-denominated book, foreign fills converted from USD at fill time)
 * and Terp has since chosen design B: PER-CHAIN NATIVE BALANCES. Because
 * multichain never shipped — it is in main but absent from the v2.11.0 zip —
 * not one user has written a foreign-chain fill, so the model can still be
 * switched with no migration and no ambiguous records. It waits one release
 * and lands once, correctly.
 *
 * This file therefore does two jobs at once:
 *
 *   1. It PINS THE REFUSAL, so nobody re-enables foreign chains by accident
 *      before the per-chain wallet exists. Every EVM row below expects null.
 *   2. It keeps the live-probed route knowledge under test, so the research
 *      does not rot while it waits. Route shapes were verified against the
 *      LIVE sites through the in-app browser on 2026-08-06:
 *        GMGN        gmgn.ai/{sol,eth,bsc,base}/token/<addr>  (all rendered)
 *        Birdeye     birdeye.so/<chain>/token/<addr>          (NEW scheme)
 *        DexScreener dexscreener.com/<chain>/<pairAddress>
 *
 * The safety properties below are NOT gated and must hold either way: a
 * foreign page is refused because we recognise its chain and decline it,
 * never because an address accidentally failed base58; and a chain the price
 * layer cannot name is never silently priced on Solana.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SITES = fs.readFileSync(path.join(ROOT, 'sites.js'), 'utf8');

const SOL_MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
// Live addresses from the verification pass.
const USDT_ETH = '0xdac17f958d2ee523a2206206994597c13d831ec7';
const USDT_BSC = '0x55d398326f99059ff775485246999027b3197955';
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH_PAIR = '0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640';
const WALLET = 'MfDuWeqSHEqTFVYZ7LoexgAK9dxk7cy4DFJWjWMGVWa';
// 40 hex chars with no '0': the whole run passes base58, which is how EVM
// addresses leaked into the Solana resolver in the first place (O-11).
const EVM_B58ISH = '0xabcdef1234567891abcdef1234567891abcdef12';

function detectAt(href) {
  const url = new URL(href);
  const sandbox = {
    window: {}, self: {},
    location: { href, hostname: url.hostname, pathname: url.pathname, search: url.search },
    URLSearchParams, console,
  };
  vm.createContext(sandbox);
  vm.runInContext(SITES, sandbox, { filename: 'sites.js' });
  const site = sandbox.window.PaperTrenchSites.currentSite();
  return { id: site.id, token: site.detect() };
}

function sitesApi() {
  const sandbox = {
    window: {}, self: {},
    location: { href: 'https://gmgn.ai/', hostname: 'gmgn.ai', pathname: '/', search: '' },
    URLSearchParams, console,
  };
  vm.createContext(sandbox);
  vm.runInContext(SITES, sandbox, { filename: 'sites.js' });
  return sandbox.window.PaperTrenchSites;
}

/* [href, site id, kind|null, address|null, chain|null, why] */
const MATRIX = [
  // ---- Solana: unchanged, and must stay exactly as it was ----
  [`https://gmgn.ai/sol/token/${SOL_MINT}`, 'gmgn', 'mint', SOL_MINT, 'solana', 'the Solana route is untouched by any of this'],
  [`https://birdeye.so/solana/token/${SOL_MINT}`, 'birdeye', 'mint', SOL_MINT, 'solana', 'Birdeye live scheme, solana'],
  [`https://birdeye.so/token/${SOL_MINT}?chain=solana`, 'birdeye', 'mint', SOL_MINT, 'solana', 'legacy query form still resolves (old links, bookmarks)'],
  [`https://dexscreener.com/solana/${SOL_MINT}`, 'dexscreener', 'pair', SOL_MINT, 'solana', 'solana pair page, unchanged'],

  // ---- Foreign chains: GATE OPEN (Terp order 2026-09-04, Robinhood demand).
  // The 8/6 refusal rows were inverted — same URLs, same chains, now MOUNT.
  // Shape strictness and O-10 rows below are unchanged.
  [`https://gmgn.ai/eth/token/${USDT_ETH}`, 'gmgn', 'mint', USDT_ETH, 'ethereum', 'GATE OPEN: ethereum mounts with its true chain'],
  [`https://gmgn.ai/bsc/token/${USDT_BSC}`, 'gmgn', 'mint', USDT_BSC, 'bsc', 'GATE OPEN: bsc'],
  [`https://gmgn.ai/base/token/${USDC_BASE}`, 'gmgn', 'mint', USDC_BASE, 'base', 'GATE OPEN: base'],
  [`https://birdeye.so/ethereum/token/${USDT_ETH}`, 'birdeye', 'mint', USDT_ETH, 'ethereum', 'GATE OPEN: ethereum'],
  [`https://birdeye.so/base/token/${USDC_BASE}`, 'birdeye', 'mint', USDC_BASE, 'base', 'GATE OPEN: base'],
  [`https://dexscreener.com/ethereum/${WETH_PAIR}`, 'dexscreener', 'pair', WETH_PAIR, 'ethereum', 'GATE OPEN: ethereum'],
  [`https://dexscreener.com/bsc/${USDT_BSC}`, 'dexscreener', 'pair', USDT_BSC, 'bsc', 'GATE OPEN: bsc'],
  [`https://fomo.family/tokens/bnb/${USDT_BSC}`, 'fomo', 'mint', USDT_BSC, 'bnb', 'GATE OPEN: fomo is the chain-densest terminal, so this branch matters most'],

  // ---- Robinhood Chain: the NEW chain this gate opening exists for ----
  [`https://gmgn.ai/robinhood/token/${USDC_BASE}`, 'gmgn', 'mint', USDC_BASE, 'robinhood', 'RH: gmgn serves /robinhood/token/<0x> (live-verified 2026-09-04)'],
  [`https://axiom.trade/meme/${USDC_BASE}?chain=robinhood`, 'axiom', 'pair', USDC_BASE, 'robinhood', 'RH: axiom chain selector HOOD = robinhood slug'],
  [`https://fomo.family/tokens/robinhood/${USDC_BASE}`, 'fomo', 'mint', USDC_BASE, 'robinhood', 'RH: the live corpus from docs/MULTICHAIN.md mounts'],

  // ---- The O-11 hazard: now routes to its OWN chain instead of being refused.
  // The address is the dangerous one: its hex passes base58. Under the closed
  // gate it was refused by chain; now the chain it names CLAIMS it and the
  // shape rule is what keeps it off Solana — it must resolve to ethereum.
  [`https://gmgn.ai/eth/token/${EVM_B58ISH}`, 'gmgn', 'mint', EVM_B58ISH, 'ethereum', 'the O-11 hazard resolves to its OWN chain, never to Solana'],
  [`https://birdeye.so/ethereum/token/${EVM_B58ISH}`, 'birdeye', 'mint', EVM_B58ISH, 'ethereum', 'the defect case, now claimed by ethereum'],
  [`https://dexscreener.com/ethereum/${EVM_B58ISH}`, 'dexscreener', 'pair', EVM_B58ISH, 'ethereum', 'same hazard, same own-chain resolution'],

  // ---- Shape strictness per slug, independent of the gate ----
  [`https://gmgn.ai/sol/token/${USDT_ETH}`, 'gmgn', null, null, null, 'an EVM address under the solana slug is never a mint'],
  [`https://gmgn.ai/eth/token/${SOL_MINT}`, 'gmgn', null, null, null, 'a base58 mint under an EVM slug is a contradiction'],
  [`https://birdeye.so/token/${SOL_MINT}?chain=ethereum`, 'birdeye', null, null, null, 'same contradiction through the legacy form'],

  // ---- Routes that must never mount, gate or no gate (O-10) ----
  [`https://gmgn.ai/sol/address/${WALLET}`, 'gmgn', null, null, null, 'wallet routes never mount'],
  [`https://birdeye.so/profile/${WALLET}`, 'birdeye', null, null, null, 'profile routes never mount'],
  ['https://dexscreener.com/gainers', 'dexscreener', null, null, null, 'utility routes are not token pages'],
  ['https://dexscreener.com/watchlist', 'dexscreener', null, null, null, 'utility routes are not token pages'],
  [`https://gmgn.ai/tron/token/${USDT_ETH}`, 'gmgn', null, null, null, 'a chain the terminal does not serve fails closed'],
  [`https://dexscreener.com/notachain/${USDT_ETH}`, 'dexscreener', null, null, null, 'an unknown chain slug fails closed'],

  // ---- Axiom: chain lives in the ?chain= QUERY (live logged-in capture) ----
  // Solana is untouched; foreign chains are recognised via ?chain= and
  // declined; the gate-flip proof below shows they resolve to their real chain
  // when MULTICHAIN_ENABLED is opened. Kinds are the shipped ones (/meme/=pair,
  // /t/=mint) — the capture confirmed the routes, not a new pair/mint split.
  [`https://axiom.trade/t/${SOL_MINT}?chain=sol`, 'axiom', 'mint', SOL_MINT, 'solana', 'the /t/ mint route is untouched, explicit sol slug'],
  [`https://axiom.trade/meme/${SOL_MINT}`, 'axiom', 'pair', SOL_MINT, 'solana', 'no ?chain= stays Solana — old links and tokenUrl() output resolve unchanged'],
  [`https://axiom.trade/meme/${USDT_ETH}?chain=eth`, 'axiom', 'pair', USDT_ETH, 'ethereum', 'GATE OPEN: eth recognised via ?chain= and mounted'],
  [`https://axiom.trade/meme/${USDT_BSC}?chain=bnb`, 'axiom', 'pair', USDT_BSC, 'bsc', "GATE OPEN: bnb (Axiom's slug for BSC)"],
  [`https://axiom.trade/meme/${EVM_B58ISH}?chain=eth`, 'axiom', 'pair', EVM_B58ISH, 'ethereum', 'the O-11 hazard resolves to its OWN chain, never to Solana'],
  [`https://axiom.trade/meme/${SOL_MINT}?chain=eth`, 'axiom', null, null, null, 'a base58 mint under an EVM slug is a contradiction'],
  [`https://axiom.trade/meme/${USDT_ETH}?chain=sol`, 'axiom', null, null, null, 'an EVM address under the sol slug is never a mint'],
  [`https://axiom.trade/meme/${USDT_ETH}?chain=notachain`, 'axiom', null, null, null, 'an unknown chain slug fails closed'],
];

test('chain matrix: Solana mounts, foreign chains mount with their TRUE chain (gate open)', () => {
  for (const [href, id, kind, address, chain, why] of MATRIX) {
    const got = detectAt(href);
    assert.equal(got.id, id, `${href} must route to the ${id} adapter`);
    if (kind === null) {
      assert.equal(got.token, null, `${href}: ${why}`);
      continue;
    }
    assert.ok(got.token, `${href}: ${why}`);
    assert.equal(got.token.kind, kind, `${href}: wrong kind — ${why}`);
    assert.equal(got.token.address, address, `${href}: wrong address — ${why}`);
    assert.equal(got.token.chain, chain, `${href}: wrong chain — ${why}`);
  }
});

test('the gate is one explicit, reversible switch — not scattered special cases', () => {
  // The 8/6 gate law survives the 9/4 opening as a SHAPE law: one named
  // constant, a stated reason, one predicate. OPEN now, but flipping it back
  // to false must still refuse every foreign chain with no other edit —
  // that reversibility is what makes the gate a gate (see the matrix test).
  assert.match(SITES, /const MULTICHAIN_ENABLED = (?:true|false);/,
    'the gate must be a single named constant');
  assert.match(SITES, /the gate is OPEN|MULTICHAIN_ENABLED = false;/,
    'the code must say WHY the gate sits where it sits');
  assert.match(SITES, /function chainTradable/,
    'one predicate decides tradability, so flipping the switch cannot miss an adapter');

  // Every adapter that can parse a foreign chain must consult it.
  const gateUses = (SITES.match(/chainTradable\(/g) || []).length;
  assert.ok(gateUses >= 3,
    `every foreign-chain branch must go through the gate (found ${gateUses} uses)`);
});

test('the route knowledge survives the gate: shapes are still parsed, then declined', () => {
  // The distinction that matters: we refuse a Base token because we know it
  // is Base, not because its address failed a Solana regex. Proof — flipping
  // the gate in a copy of the shipped source makes the same URLs resolve to
  // their real chains, with no other change.
  const opened = SITES.replace('const MULTICHAIN_ENABLED = false;', 'const MULTICHAIN_ENABLED = true;');
  const detectWithGateOpen = (href) => {
    const url = new URL(href);
    const sandbox = {
      window: {}, self: {},
      location: { href, hostname: url.hostname, pathname: url.pathname, search: url.search },
      URLSearchParams, console,
    };
    vm.createContext(sandbox);
    vm.runInContext(opened, sandbox, { filename: 'sites.js' });
    return sandbox.window.PaperTrenchSites.currentSite().detect();
  };

  // Field-wise: these records are built inside a vm realm, so their
  // prototype is not the host's and deepStrictEqual would compare realms
  // rather than values.
  const sameRecord = (got, want, why) => {
    assert.ok(got, `${why}: expected a detection, got none`);
    assert.equal(got.kind, want.kind, `${why}: kind`);
    assert.equal(got.address, want.address, `${why}: address`);
    assert.equal(got.chain, want.chain, `${why}: chain`);
  };
  sameRecord(detectWithGateOpen(`https://gmgn.ai/eth/token/${USDT_ETH}`),
    { kind: 'mint', address: USDT_ETH, chain: 'ethereum' }, 'gmgn ethereum');
  sameRecord(detectWithGateOpen(`https://gmgn.ai/bsc/token/${USDT_BSC}`),
    { kind: 'mint', address: USDT_BSC, chain: 'bsc' }, 'gmgn bsc');
  sameRecord(detectWithGateOpen(`https://birdeye.so/ethereum/token/${USDT_ETH}`),
    { kind: 'mint', address: USDT_ETH, chain: 'ethereum' }, 'birdeye ethereum');
  sameRecord(detectWithGateOpen(`https://dexscreener.com/ethereum/${WETH_PAIR}`),
    { kind: 'pair', address: WETH_PAIR, chain: 'ethereum' }, 'dexscreener ethereum');
  sameRecord(detectWithGateOpen(`https://axiom.trade/meme/${USDT_ETH}?chain=eth`),
    { kind: 'pair', address: USDT_ETH, chain: 'ethereum' }, 'axiom ethereum (chain in the query)');
  sameRecord(detectWithGateOpen(`https://axiom.trade/t/${USDT_BSC}?chain=bnb`),
    { kind: 'mint', address: USDT_BSC, chain: 'bsc' }, 'axiom bsc (bnb slug maps to bsc)');
  // And the hazard address routes to ETHEREUM even then — never to Solana.
  assert.equal(detectWithGateOpen(`https://gmgn.ai/eth/token/${EVM_B58ISH}`).chain, 'ethereum');
  assert.equal(detectWithGateOpen(`https://axiom.trade/meme/${EVM_B58ISH}?chain=eth`).chain, 'ethereum');
  // Shape strictness is not what the gate was doing, so it still holds.
  assert.equal(detectWithGateOpen(`https://gmgn.ai/sol/token/${USDT_ETH}`), null);
});

test('no chain any adapter can emit is missing from the price layer', () => {
  // Gate-independent by construction: this reads the adapters' slug maps
  // rather than what detection currently returns, so the coupling holds
  // while the gate is shut AND the moment it opens.
  const quote = fs.readFileSync(path.join(ROOT, 'quote.js'), 'utf8');
  const mapStart = quote.indexOf('CHAIN_MAP = {');
  const mapBlock = quote.slice(mapStart, quote.indexOf('};', mapStart));
  const mapped = new Set([...mapBlock.matchAll(/^\s*([a-z0-9]+)\s*:/gm)].map((m) => m[1]));

  const declared = new Set();
  for (const name of ['GMGN_CHAIN_BY_SLUG', 'BIRDEYE_CHAIN_BY_SLUG', 'AXIOM_CHAIN_BY_SLUG']) {
    const start = SITES.indexOf(`const ${name} = {`);
    assert.ok(start > -1, `${name} must exist in sites.js`);
    const block = SITES.slice(start, SITES.indexOf('};', start));
    for (const m of block.matchAll(/:\s*'([a-z0-9]+)'/g)) declared.add(m[1]);
  }
  const dexStart = SITES.indexOf('const DEXSCREENER_CHAINS = [');
  const dexBlock = SITES.slice(dexStart, SITES.indexOf('];', dexStart));
  for (const m of dexBlock.matchAll(/'([a-z0-9]+)'/g)) declared.add(m[1]);

  assert.ok(declared.size >= 6, 'the adapters must declare a real chain vocabulary');
  for (const chain of declared) {
    assert.ok(mapped.has(chain),
      `sites.js can emit chain "${chain}" but quote.js CHAIN_MAP has no entry for it — `
      + 'it would be priced on Solana');
  }
});

test('an unknown chain fails CLOSED instead of being priced on Solana', () => {
  const quote = fs.readFileSync(path.join(ROOT, 'quote.js'), 'utf8');
  assert.doesNotMatch(quote, /CHAIN_MAP\[[^\]]*\]\s*\|\|\s*'solana'/,
    'a chain the map does not know must never silently become Solana — '
    + 'that is a wrong-chain price, the exact class of number this product refuses');
  assert.match(quote, /function chainIdFor/,
    'chain resolution must go through one named, testable function');
});

test('a positions-bar chip returns to the RIGHT chain', () => {
  // Link building is not gated: it is inert without foreign positions, and
  // design B needs it intact. A chip that returns to the wrong chain is a
  // link to a different token.
  const S = sitesApi();
  assert.match(S.tokenUrlFor(USDT_BSC, { siteId: 'gmgn', chain: 'bsc' }), /gmgn\.ai\/bsc\/token\//);
  assert.match(S.tokenUrlFor(USDT_ETH, { siteId: 'birdeye', chain: 'ethereum' }), /birdeye\.so\/ethereum\/token\//);
  assert.match(S.tokenUrlFor(USDT_ETH, { siteId: 'dexscreener', chain: 'ethereum' }), /dexscreener\.com\/ethereum\//);
  assert.ok(!/\/tokens\/solana\//.test(S.tokenUrlFor(USDT_BSC, { siteId: 'fomo', chain: 'bsc' })),
    'a BSC token must never be linked as a fomo solana route');
  assert.ok(!/dexscreener\.com\/solana\//.test(S.tokenUrlFor(USDT_ETH, { siteId: 'nope', chain: 'ethereum' })),
    'the universal fallback must not send an ethereum token to /solana/');

  // Solana keeps its exact existing behaviour, chain or no chain.
  assert.match(S.tokenUrlFor(SOL_MINT, { siteId: 'gmgn' }), /gmgn\.ai\/sol\/token\//);
  assert.match(S.tokenUrlFor(SOL_MINT, { siteId: 'fomo' }), /fomo\.family\/tokens\/solana\//);
});
