/* F-51 — the position that "wiped" on the coin that was just bought.
 *
 * Field reports (Discord): "sometime when im in a coin it just wipes the
 * position like i never bought" (cantstoplarping, 2026-08-11) and "the paper
 * trade dissapears" (immreeper, 2026-08-09).
 *
 * On pair-URL sites (Axiom /meme/, Photon /lp/, BullX) a fresh launch trades
 * under the PAIR stand-in address until the prewatch probe or the resolver
 * discovers the real mint. A fill committed in that window keys the position
 * under the stand-in; the identity upgrade then renamed token.mint underneath
 * it, the card looked the position up under the NEW key, found nothing, and
 * rendered empty. The armed-buy intent survived this exact rename since the
 * "ARMED … but nothing executed" fix — the position never did.
 *
 * The fix is engine.rekeyMint: every LIVE mint-keyed structure (position,
 * orders, alerts, post-exit watches) moves with the rename. The journal and
 * closed rounds are deliberately untouched — fill rows are hashed into the
 * attestation chain, so rewriting their mint would fork the record. Round
 * arithmetic instead matches fills by sessionId (tradeInRound), which
 * survives the rename.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

global.window = global.window || {};
require('../engine.js');
const E = global.window.PaperEngine;

const ROOT = path.join(__dirname, '..');

// An Axiom /meme/ page: the URL carries the pool, the coin lives at the mint.
const PAIR = 'PooLStandIn11111111111111111111111111111111';
const MINT = '3PTQpne3b7kjJEvDYDMBHSuRjTDUh6HSin2xMyW3pump';
const T0 = 1_800_000_000_000;

function freshWallet() {
  const settings = E.defaultSettings();
  settings.feeBps = 0;
  const state = E.defaultState(settings);
  return { settings, state };
}

function buyUnderStandIn(state, settings, over) {
  return E.buy(state, settings, {
    ts: T0, mint: PAIR, symbol: 'BARK', site: 'axiom',
    pairAddress: PAIR, priceNative: 0.000001, solAmount: 1,
    ...(over || {}),
  });
}

/* ---------------- the position itself ---------------- */

test('F-51: the position follows the stand-in -> mint rename instead of vanishing', () => {
  const { settings, state } = freshWallet();
  const { position } = buyUnderStandIn(state, settings);
  assert.ok(state.positions[PAIR], 'the fill lands under the stand-in — that is the bug setup');

  assert.equal(E.rekeyMint(state, PAIR, MINT), true, 'the rename must report that it moved something');

  assert.equal(state.positions[PAIR], undefined, 'nothing may linger under the stand-in');
  const moved = state.positions[MINT];
  assert.ok(moved, 'the card looks the position up by the RESOLVED mint — it must be there');
  assert.equal(moved.mint, MINT, 'the record itself must carry its new identity');
  assert.equal(moved.qty, position.qty, 'the bag is the same bag');
  assert.equal(moved.sessionId, position.sessionId, 'the session survives — fills are matched by it');
});

test('F-51: rekey is honest about doing nothing', () => {
  const { settings, state } = freshWallet();
  assert.equal(E.rekeyMint(state, PAIR, MINT), false, 'an empty wallet has nothing to move');
  buyUnderStandIn(state, settings);
  assert.equal(E.rekeyMint(state, PAIR, PAIR), false, 'a rename to itself is not a rename');
  assert.equal(E.rekeyMint(state, null, MINT), false);
  assert.equal(E.rekeyMint(null, PAIR, MINT), false);
  assert.equal(E.rekeyMint(state, PAIR, MINT), true);
  assert.equal(E.rekeyMint(state, PAIR, MINT), false, 'a second identical rename finds nothing left');
});

/* ---------------- everything armed against the stand-in ---------------- */

test('F-51: orders and alerts armed under the stand-in move with the position', () => {
  const { settings, state } = freshWallet();
  buyUnderStandIn(state, settings);
  const order = E.addOrder(state, PAIR, { kind: 'tp', triggerPrice: 0.000002 }, 0.000001, T0 + 1);
  const alert = E.addAlert(state, PAIR, { kind: 'above', mcap: 500_000 }, { mcap: 210_000, priceNative: 0.000001 }, T0 + 2);

  E.rekeyMint(state, PAIR, MINT);

  assert.equal(E.ordersFor(state, PAIR).length, 0, 'no order may stay armed against the dead key');
  const movedOrders = E.ordersFor(state, MINT);
  assert.equal(movedOrders.length, 1, 'the armed level still exists after the rename');
  assert.equal(movedOrders[0].id, order.id);
  assert.equal(movedOrders[0].mint, MINT, 'the order record carries the new identity');

  assert.equal(E.alertsFor(state, PAIR).length, 0);
  const movedAlerts = E.alertsFor(state, MINT);
  assert.equal(movedAlerts.length, 1);
  assert.equal(movedAlerts[0].id, alert.id);
  assert.equal(movedAlerts[0].mint, MINT);
});

test('F-51: a post-exit watch keeps watching across the rename', () => {
  const { settings, state } = freshWallet();
  buyUnderStandIn(state, settings);
  E.sell(state, settings, { ts: T0 + 5_000, mint: PAIR, qtyFraction: 1, priceNative: 0.000002 });
  assert.equal(state.postWatch[0].mint, PAIR, 'the watch was armed under the stand-in');

  assert.equal(E.rekeyMint(state, PAIR, MINT), true,
    'a watch is a live structure too — moving it counts as movement');
  assert.equal(state.postWatch[0].mint, MINT);
  assert.equal(E.notePostExitPrice(state, MINT, 0.000004, T0 + 10_000), true,
    'prices now arrive tagged with the real mint and must still land on the watch');
});

/* ---------------- round arithmetic across the rename ---------------- */

test('F-51: a round that opened under the stand-in and closed under the mint stays whole', () => {
  const { settings, state } = freshWallet();
  const { trade: buyTrade } = buyUnderStandIn(state, settings);
  E.rekeyMint(state, PAIR, MINT);

  const { round } = E.sell(state, settings, {
    ts: T0 + 60_000, mint: MINT, qtyFraction: 1, priceNative: 0.000002,
  });
  assert.ok(round, 'a full exit closes the round');
  assert.ok(round.tradeIds.includes(buyTrade.id),
    'the opening fill was written under the stand-in — sessionId matching must still claim it');
  // 1 SOL in at 1e-6 -> 1e6 tokens; out at 2e-6 -> 2 SOL back. No fees here.
  assert.ok(Math.abs(round.pnlSol - 1) < 1e-9,
    `the round's money must add up across the rename (got ${round.pnlSol})`);
});

test('F-51: the chart average lines keep pricing fills made under the stand-in', () => {
  const { settings, state } = freshWallet();
  buyUnderStandIn(state, settings);
  E.rekeyMint(state, PAIR, MINT);

  const avg = E.averageFillPrices(state, MINT);
  assert.ok(avg, 'the open position must still have an average to draw');
  assert.ok(Math.abs(avg.avgBuyNative - 0.000001) / 0.000001 < 1e-9,
    'the stand-in buy is this round\'s opening fill — it IS the average');

  // The journal row itself is untouched: its mint is hashed into the
  // attestation chain, and history is not rewritten to fix a lookup.
  const fill = state.journal.find((t) => t.side === 'buy');
  assert.equal(fill.mint, PAIR, 'the committed fill keeps the identity it was attested under');
});

/* ---------------- both identities held at once ---------------- */

test('F-51: a stack under the real mint absorbs a stand-in stack — one bag, one card', () => {
  const { settings, state } = freshWallet();
  // An older buy under the real mint (a mint-URL site), still open…
  E.buy(state, settings, {
    ts: T0 - 60_000, mint: MINT, symbol: 'BARK', site: 'pumpfun',
    priceNative: 0.0000008, solAmount: 2,
  });
  const oldSession = state.positions[MINT].sessionId;
  // …then a fresh buy under the pair stand-in on Axiom.
  buyUnderStandIn(state, settings);
  const standInSession = state.positions[PAIR].sessionId;

  E.rekeyMint(state, PAIR, MINT);

  const merged = state.positions[MINT];
  assert.equal(Object.keys(state.positions).length, 1, 'one token, one position');
  assert.ok(Math.abs(merged.qty - (2 / 0.0000008 + 1 / 0.000001)) < 1e-6, 'both stacks\' tokens');
  assert.ok(Math.abs(merged.costSol - 3) < 1e-9, 'both stacks\' cost basis');
  assert.equal(merged.openedAt, T0 - 60_000, 'the round opened when the FIRST stack did');
  assert.equal(merged.sessionId, oldSession, 'the surviving session is the original one');
  assert.deepEqual(merged.mergedSessionIds, [standInSession],
    'the absorbed session is remembered so its fills still count in the round');

  const { round } = E.sell(state, settings, {
    ts: T0 + 120_000, mint: MINT, qtyFraction: 1, priceNative: 0.000002,
  });
  // 2 SOL @ 8e-7 -> 2.5e6 tokens; 1 SOL @ 1e-6 -> 1e6 tokens.
  // Exit 3.5e6 @ 2e-6 -> 7 SOL against 3 invested.
  assert.ok(Math.abs(round.pnlSol - 4) < 1e-9,
    `the merged round's money must add up (got ${round.pnlSol})`);
  assert.equal(round.tradeIds.length, 3, 'both buys and the exit all belong to the round');
});

/* ---------------- the wiring that must call this ---------------- */

test('F-51: content.js carries the rename through every identity-upgrade path', () => {
  const contentSrc = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');

  assert.match(contentSrc, /function rekeyLiveState\(/,
    'the overlay must own a rekey step for live state');
  assert.match(contentSrc, /E\.rekeyMint\(state, oldMint, newMint\)/,
    'the overlay rekey must be the tested engine move, not a re-implementation');

  // Both prewatch upgrade branches rename token.mint — each must rekey first.
  const prewatchStart = contentSrc.indexOf('function prewatchPending');
  const prewatchEnd = contentSrc.indexOf('async function detectLoop');
  const prewatchBody = contentSrc.slice(prewatchStart, prewatchEnd);
  const rekeyCalls = prewatchBody.match(/rekeyLiveState\(token\.mint, found\.mint\)/g) || [];
  assert.equal(rekeyCalls.length, 2,
    'both prewatch identity upgrades (unknown-pool and positive id) must carry the position');

  // The resolver path: the same sameTokenResolving test that rebinds the
  // armed buy must also carry the position.
  const setTokenBody = contentSrc.slice(
    contentSrc.indexOf('function setToken('),
    contentSrc.indexOf('function publishPageState')
  );
  assert.match(setTokenBody, /sameTokenResolving\) rekeyLiveState\(prevMint, token\.mint\)/,
    'setToken must rekey when a pending pair resolves into its base mint');

  // The write rides the serialized CAS commit and re-applies on contention,
  // like every other mutation (F-46).
  const rekeyFn = contentSrc.slice(
    contentSrc.indexOf('function rekeyLiveState('),
    contentSrc.indexOf('function setToken(')
  );
  assert.match(rekeyFn, /persistStateNow\(mutate\)/,
    'the rename must persist through the commit queue with a remutate');
  assert.match(rekeyFn, /posEls = null/,
    'the cached card nodes belong to the stand-in render and must be rebuilt');
});
