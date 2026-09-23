const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../core/tournament.js');
const { appendFill, GENESIS, verifyChain } = require('../core/chain.js');
const { nativePriceRangeFromCandles } = require('../core/pricing.js');

const MIN = 60000;

async function chainOf(fills) {
  const chain = [];
  let previous = GENESIS;
  for (const fill of fills) {
    const link = await appendFill(previous, fill);
    link.seq = chain.length;
    chain.push(link);
    previous = link.hash;
  }
  return chain;
}

test('settled standings put verified finals above forfeits, rank by ROI, and scale P&L to stack', () => {
  const entrants = [
    { user_id: 1, handle: 'five', alive: 1, joined_at: 1 },
    { user_id: 2, handle: 'forty', alive: 1, joined_at: 2 },
    { user_id: 3, handle: 'ten', alive: 1, joined_at: 3 },
    { user_id: 4, handle: 'unverified', alive: 1, joined_at: 4 },
  ];
  const entries = new Map([
    [1, { verified: true, final: true, submittedAt: 200, entry: { pnlSol: 0.5, roiPct: 5 } }],
    [2, { verified: true, final: false, submittedAt: 99, entry: { pnlSol: 4, roiPct: 40 } }],
    [3, { verified: true, final: true, submittedAt: 200, entry: { pnlSol: 1, roiPct: 10 } }],
    [4, { verified: false, clientEquitySol: 900000000 }],
  ]);

  const settled = T.standings(entrants, entries, 20, { settled: true });
  assert.deepEqual(settled.map((row) => row.userId), [3, 1, 2, 4],
    'even the strongest provisional ROI ranks below every final');
  assert.equal(settled[0].pnlOnStackSol, 2);
  assert.equal(settled[1].pnlOnStackSol, 1);
  assert.equal(settled[2].finality, 'forfeited');
  assert.equal(settled[3].pnlOnStackSol, 0, 'unverified client equity is ignored');

  const live = T.standings(entrants, entries, 20);
  assert.deepEqual(live.map((row) => row.userId), [2, 3, 1, 4]);
  assert.ok(live.every((row) => row.finality === 'provisional'));
});

test('uncommitted client equity fields cannot change a verified window entry', async () => {
  const links = await chainOf([
    { id: 'buy', sessionId: 's', mint: 'M', chain: 'solana', side: 'buy',
      qty: 1, priceNative: 1, solGross: 1, solNet: 1, ts: 10 * MIN },
    { id: 'sell', sessionId: 's', mint: 'M', chain: 'solana', side: 'sell',
      qty: 1, priceNative: 2, solGross: 2, solNet: 2, ts: 20 * MIN },
  ]);
  assert.equal((await verifyChain(links)).valid, true);
  const forged = links.map((link) => ({ ...link, equitySol: 900000000, clientEquitySol: 900000000 }));
  assert.equal((await verifyChain(forged)).valid, true, 'the extra claim is unhashed');
  const window = { startTs: 0, endTs: 30 * MIN };
  const honest = T.entryForWindow(links, 10, window, 10);
  const forgedEntry = T.entryForWindow(forged, 10, window, 10);
  assert.equal(forgedEntry.pnlSol, honest.pnlSol);
  assert.equal(forgedEntry.roiPct, honest.roiPct);
  assert.equal(forgedEntry.pnlOnStackSol, honest.pnlOnStackSol);
});

test('markOpenAtBell prices from the USD/SOL candle range and flags a candle miss at gross cost', async () => {
  const links = await chainOf([{
    id: 'open-buy', sessionId: 'open', mint: 'MintOpen', chain: 'solana', side: 'buy',
    qty: 2, priceNative: 1, solGross: 2, solNet: 2, ts: 10 * MIN,
  }]);
  const window = { startTs: 0, endTs: 50 * MIN };
  const entry = T.entryForWindow(links, 10, window, 10);
  const calls = [];
  const hit = await T.markOpenAtBell(entry, window.endTs, 10, async (mint, minute, chain) => {
    calls.push({ mint, minute, chain });
    return {
      tokenUsd: { low: 200, high: 200 },
      solUsd: { low: 100, high: 100 },
    };
  });
  assert.deepEqual(calls, [{ mint: 'MintOpen', minute: 50 * MIN, chain: 'solana' }]);
  assert.equal(hit.unpricedOpenPosition, false);
  assert.ok(Math.abs(hit.openPositions[0].valueSol - 4) < 1e-9);
  assert.ok(Math.abs(hit.pnlSol - 2) < 1e-9);
  assert.ok(Math.abs(hit.roiPct - 20) < 1e-9);
  assert.ok(Math.abs(hit.pnlOnStackSol - 2) < 1e-9);

  const miss = await T.markOpenAtBell(entry, window.endTs, 10, async () => null);
  assert.equal(miss.unpricedOpenPosition, true);
  assert.equal(miss.openPositions[0].unpriced, true);
  assert.equal(miss.openPositions[0].valueSol, 2, 'missing price values the held bag at gross cost');
  assert.equal(miss.openPositions[0].pnlSol, 0);
  assert.equal(miss.pnlSol, 0);
  assert.equal(miss.pnlOnStackSol, 0);
  assert.equal(nativePriceRangeFromCandles({ tokenUsd: { low: 0, high: 0 }, solUsd: { low: 100, high: 100 } }), null);
});

test('settlement waits for grace and only a post-boundary verified submission is final', () => {
  const bracket = { start_ts: 1000, round_ms: 60 * MIN };
  const boundary = T.roundWindow(bracket, 1).endTs;
  assert.equal(T.SETTLE_GRACE_MS, 15 * MIN);
  assert.equal(T.settlementDue(bracket, 1, boundary + T.SETTLE_GRACE_MS - 1), false);
  assert.equal(T.settlementDue(bracket, 1, boundary + T.SETTLE_GRACE_MS), true);
  assert.equal(T.finalForBoundary('verified', boundary, boundary), true);
  assert.equal(T.finalForBoundary('verified', boundary - 1, boundary), false);
  assert.equal(T.finalForBoundary('pending', boundary + 1, boundary), false);
  assert.equal(T.finalForBoundary('partial', boundary + 1, boundary), false);

  const rows = [1, 2, 3, 4, 5].map((userId) => ({ userId, user_id: userId, alive: true }));
  const cut = T.boundaryPlan(rows, 2);
  assert.equal(cut.final, false);
  assert.deepEqual(cut.eliminated.map((row) => row.userId), [4, 5]);
  const crown = T.boundaryPlan(rows.slice(0, 2), 2);
  assert.equal(crown.final, true);
  assert.deepEqual(crown.placements.map((row) => row.userId), [1, 2]);
});
