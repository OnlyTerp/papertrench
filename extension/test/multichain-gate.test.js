/* Multichain gate opening — Robinhood Chain on GMGN/Axiom (+ EVM on Padre).
 *
 * Terp order 2026-09-04: "gmgn, axiom, padre, and lute have a button that
 * switches it from sol to robinhood eth coins, can u add the functionality
 * for those to work also in papertrench" — the 8/6 gate (MULTICHAIN_ENABLED
 * = false) had been waiting on per-chain native balances; the intervening
 * sessions hardened the SOL-denominated book instead (multichain.test.js:
 * derived pricing with a RECORDED rate), so the gate opened without a wallet
 * migration. Contract: .contracts/validation-contract-multichain.md.
 *
 * What this file pins that no other file does:
 *   - the gate is OPEN and flipping it back to false refuses foreign chains
 *     with no other edit (the reversibility that makes it a gate);
 *   - a foreign record prices DERIVED (priceUsd / recorded rate) end-to-end
 *     through the real resolver against live-shaped payloads;
 *   - a foreign fill books honestly in the SOL book (equity identity holds);
 *   - a foreign position's chip returns to ITS chain's page on each venue;
 *   - Lute stays Solana-only (its foreign URL shape is unverifiable without
 *     an account — guessing would be the O-11 failure class).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const SITES = fs.readFileSync(path.join(ROOT, 'sites.js'), 'utf8');

const EVM = '0x45C83b37C5BAF4dad26f3845C28295e2DE010962';
const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

function loadSites(src) {
  const sandbox = {
    window: {}, self: {},
    location: { href: 'https://gmgn.ai/', hostname: 'gmgn.ai', pathname: '/', search: '' },
    URLSearchParams, console,
  };
  vm.createContext(sandbox);
  vm.runInContext(src || SITES, sandbox, { filename: 'sites.js' });
  return sandbox.window.PaperTrenchSites;
}

function detectAt(href, src) {
  const url = new URL(href);
  const sandbox = {
    window: {}, self: {},
    location: { href, hostname: url.hostname.replace(/^www\./, ''), pathname: url.pathname, search: url.search },
    URLSearchParams, console,
  };
  vm.createContext(sandbox);
  vm.runInContext(src || SITES, sandbox, { filename: 'sites.js' });
  return sandbox.window.PaperTrenchSites.currentSite().detect();
}

test('MULTI-1: the gate is OPEN in the shipped source', () => {
  assert.match(SITES, /const MULTICHAIN_ENABLED = true;/,
    'the 9/4 order opened the gate — a flipped-back constant means someone reverted without inverting the tests');
});

test('MULTI-2 NEGATIVE CONTROL: gate=false refuses every foreign chain, Solana untouched', () => {
  const closed = SITES.replace('const MULTICHAIN_ENABLED = true;', 'const MULTICHAIN_ENABLED = false;');
  assert.notEqual(closed, SITES, 'the gate constant must be the one switch');
  assert.equal(detectAt(`https://gmgn.ai/robinhood/token/${EVM}`, closed), null, 'RH refused when closed');
  assert.equal(detectAt(`https://gmgn.ai/eth/token/${EVM}`, closed), null, 'ETH refused when closed');
  assert.equal(detectAt(`https://axiom.trade/meme/${EVM}?chain=robinhood`, closed), null, 'axiom RH refused when closed');
  const sol = detectAt(`https://gmgn.ai/sol/token/${MINT}`, closed);
  assert.ok(sol && sol.chain === 'solana', 'Solana mounts either way');
});

test('MULTI-3: the O-11 hazard address resolves to its OWN chain, never Solana', () => {
  // Its hex passes base58 (~13% of EVM addresses) — under every venue.
  const cases = [
    `https://gmgn.ai/eth/token/${EVM}`,
    `https://gmgn.ai/robinhood/token/${EVM}`,
    `https://birdeye.so/ethereum/token/${EVM}`,
    `https://dexscreener.com/ethereum/${EVM}`,
    `https://axiom.trade/meme/${EVM}?chain=eth`,
  ];
  for (const href of cases) {
    const got = detectAt(href);
    assert.ok(got, `${href} must mount`);
    assert.notEqual(got.chain, 'solana', `${href}: must never be read as a Solana mint`);
  }
});

test('MULTI-4: a foreign fill books honestly in the SOL book (engine, behavioural)', () => {
  const w = {}; global.window = w; global.self = w;
  require(path.join(ROOT, 'engine.js'));
  const E = w.PaperEngine;
  const settings = E.defaultSettings();
  const state = E.defaultState(settings);
  const RATE = 103.37;
  const fill = E.buy(state, settings, {
    ts: 1, mint: EVM, symbol: 'HOOD', site: 'gmgn', chain: 'robinhood',
    solAmount: 0.5, priceNative: 0.0000685 / RATE, priceUsd: 0.0000685,
    priceSource: 'resolver', solUsdAtResolve: RATE,
  });
  assert.equal(fill.trade.chain, 'robinhood', 'the fill carries its chain');
  const pos = state.positions[EVM];
  assert.equal(pos.chain, 'robinhood', 'the position carries its chain for chips and re-quotes');
  // The equity identity: cash + qty * derived SOL price must equal birth − fees.
  const eq = E.equitySol(state);
  assert.ok(Math.abs(eq - (state.cashSol + pos.qty * pos.lastPriceNative)) < 1e-9,
    'the SOL book stays internally consistent with a foreign position in it');
});

test('MULTI-5: a foreign position chip returns to ITS chain on every wired venue', () => {
  const S = loadSites();
  const rh = 'https://gmgn.ai/robinhood/token/' + EVM;
  assert.equal(S.tokenUrlFor(EVM, { siteId: 'gmgn', chain: 'robinhood' }), rh, 'gmgn RH');
  assert.equal(S.tokenUrlFor(EVM, { siteId: 'axiom', chain: 'robinhood' }),
    `https://axiom.trade/t/${EVM}?chain=robinhood`, 'axiom RH');
  assert.equal(S.tokenUrlFor('0x32708538a107253b51a735a724330a23106ca4ca', { siteId: 'padre', chain: 'ethereum' }),
    'https://trade.padre.gg/trade/ethereum/0x32708538a107253b51a735a724330a23106ca4ca', 'padre ETH');
  // Legacy positions (no chain recorded) stay exactly where they always went.
  assert.equal(S.tokenUrlFor(MINT, { siteId: 'gmgn' }), `https://gmgn.ai/sol/token/${MINT}`,
    'absent a chain the answer is what it has always been: Solana');
});

test('MULTI-6: lute stays Solana-only — an unverifiable URL shape must not be guessed', () => {
  assert.equal(detectAt(`https://lute.gg/trade/${EVM}`), null,
    'lute foreign-chain pages must not mount: the shape was never verifiable anonymously (307 to /login on both families), and a guessed shape is the O-11 failure class');
  const sol = detectAt(`https://lute.gg/trade/${MINT}`);
  assert.ok(sol && sol.chain === 'solana', 'lute Solana is untouched');
});

test('MULTI-7: padre has NO robinhood — its RH slug must fail closed', () => {
  // Live-verified 2026-09-04: Padre trades Solana/Ethereum/Base/BNB. A
  // /trade/robinhood/<addr> page is a chain we cannot honestly price there.
  assert.equal(detectAt(`https://trade.padre.gg/trade/robinhood/${EVM}`), null,
    'an unlisted padre slug fails closed — tokenForSlug has no robinhood entry');
});
