'use strict';
/* Bug 6 regression (Twitch 2026-08-22): "in PaperTrench with the new pairs,
 * in the Positions section it's picking up the links incorrectly, and because
 * of that it doesn't work."
 *
 * The failure: on pair-URL sites (Axiom /meme/<pool>, Photon /lp/<pool>) a
 * brand-new pair opens its chart under the PAIR stand-in address while the
 * resolver is still pending, so the buy that opens the position records
 * pairAddress: null. The position's pairAddress was write-once; every link
 * derived from it (positions-bar chip → openPositionChart → tokenUrlFor)
 * fell back to the MINT route, which on a fresh pair is not indexed yet —
 * a dead page.
 *
 * The fix: (1) E.buy heals the position's pairAddress on every subsequent
 * buy (engine.js), (2) openPositionChart prefers the live token identity
 * when this tab is showing the same token (content.js — covered by the
 * behavior test below via the engine half and S.tokenUrlFor directly).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const E = require(path.join(ROOT, 'engine.js'));
const vm = require('node:vm');
const src = fs.readFileSync(path.join(ROOT, 'engine.js'), 'utf8');
const SITES_SRC = fs.readFileSync(path.join(ROOT, 'sites.js'), 'utf8');

function loadSites() {
  const sandbox = { window: {}, self: {}, location: { hostname: 'axiom.trade' }, console };
  vm.createContext(sandbox);
  vm.runInContext(SITES_SRC, sandbox, { filename: 'sites.js' });
  return sandbox.window.PaperTrenchSites;
}

function freshState() {
  return {
    cashSol: 100,
    positions: {},
    journal: [],
    stats: { totalBuys: 0, totalSells: 0, feesPaidSol: 0 },
    settings: { feeBps: 0 },
  };
}

const MINT = 'So11111111111111111111111111111111111111112';
const PAIR = '7Xk9t2mQvB4nJ8hZcR1wYe5uD3aLpN6sKfHg9TxMqWzV';
const PAIR2 = '9Yl0u3nRwC5oK9iAdS2xZf6vE4bMqN7tLgIh0UyNrXaW';

function buy(state, over) {
  return E.buy(state, state.settings, Object.assign({
    ts: Date.now(), mint: MINT, pairAddress: null,
    symbol: 'FRESH', name: 'Fresh Launch', site: 'axiom',
    priceNative: 0.000001, priceUsd: 0.00015, mcap: 150000,
    solAmount: 1,
  }, over));
}

test('engine: buy on a pending fresh pair opens the position with pairAddress null (the bug precondition)', () => {
  const s = freshState();
  buy(s); // pairAddress omitted → null, exactly the fresh-pair window
  const pos = s.positions[MINT];
  assert.equal(pos.pairAddress, null, 'the opening buy in the pending window records null (precondition)');
});

test('engine: a later buy heals a null pairAddress onto the position (Bug 6 fix)', () => {
  const s = freshState();
  buy(s);                                    // pending window: null pair
  buy(s, { pairAddress: PAIR });             // resolver landed; page now knows the pool
  const pos = s.positions[MINT];
  assert.equal(pos.pairAddress, PAIR, 'the second buy must carry the resolved pool onto the bag');
});

test('engine: a healed pairAddress flows into a chip link via tokenUrlFor (Axiom pair route)', () => {
  const s = freshState();
  buy(s);
  buy(s, { pairAddress: PAIR });
  const pos = s.positions[MINT];
  // Mirror of openPositionChart's call: site from the position, pair from the
  // (healed) position when the live token is not on screen.
  const S = loadSites();
  const url = S.tokenUrlFor(MINT, {
    siteId: pos.site,
    pairAddress: pos.pairAddress,
    fallbackSite: null,
  });
  // 2026-09-04 multichain: tokenUrl() now carries the explicit ?chain= slug
  // (no ?chain= still means Solana, but emitting it makes the chain visible
  // in the URL — matching detect()'s own grammar).
  assert.equal(url, 'https://axiom.trade/meme/' + PAIR + '?chain=sol',
    'a healed pair must route to the pool page (/meme/), not the unindexed mint route (/t/)');
});

test('engine: the null-pair fallback still degrades to the mint route (no regression when never healed)', () => {
  const s = freshState();
  buy(s); // never learned the pool
  const pos = s.positions[MINT];
  const S = loadSites();
  const url = S.tokenUrlFor(MINT, { siteId: pos.site, pairAddress: pos.pairAddress || null });
  assert.equal(url, 'https://axiom.trade/t/' + MINT + '?chain=sol',
    'with no pool ever seen the mint route remains the fallback (explicit sol slug, 2026-09-04)');
});

test('engine: a stale pairAddress is corrected, not just filled (pool migration)', () => {
  const s = freshState();
  buy(s, { pairAddress: PAIR });   // learned an early pool
  buy(s, { pairAddress: PAIR2 });  // migration / relist: page now trades pool 2
  const pos = s.positions[MINT];
  assert.equal(pos.pairAddress, PAIR2, 'the page\'s current pool wins over the stale one');
});

test('engine: source order — the fix is a plain conditional, no exotic machinery', () => {
  assert.match(src, /if \(o\.pairAddress && o\.pairAddress !== pos\.pairAddress\) pos\.pairAddress = o\.pairAddress;/,
    'the heal line is present verbatim');
});
