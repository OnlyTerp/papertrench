/* Window slicing is where the tournament money actually lives: Sprints,
 * duels and clan weeks are all windowEntry views of one chain. The tests
 * here lock the property that makes those slices payable — every number in
 * an entry, including the BASELINE equity the return divides by, must be
 * derived from hash-committed fields alone (DEFECT L-06).
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { windowEntry } = require('../core/window.js');
const { appendFill, GENESIS, verifyChain } = require('../core/chain.js');

async function chainOf(fills) {
  const links = [];
  let prev = GENESIS;
  for (const f of fills) {
    const link = await appendFill(prev, f);
    link.seq = links.length;
    links.push(link);
    prev = link.hash;
  }
  return links;
}

const MIN = 60000;
const WINDOW = { startTs: 100 * MIN, endTs: 200 * MIN };

test('window-start equity ignores every field the chain does not hash (L-06)', async () => {
  const links = await chainOf([
    // Carried-in position: bought before the window opened, still open.
    { id: 'w1', sessionId: 'sA', mint: 'M1', side: 'buy',
      qty: 2000, priceNative: 0.001, solGross: 2, solNet: 1.98, ts: 10 * MIN },
    // One clean round inside the window.
    { id: 'w2', sessionId: 'sB', mint: 'M2', side: 'buy',
      qty: 1000, priceNative: 0.001, solGross: 1, solNet: 0.99, ts: 110 * MIN },
    { id: 'w3', sessionId: 'sB', mint: 'M2', side: 'sell',
      qty: 1000, priceNative: 0.002, solGross: 2, solNet: 1.98, ts: 120 * MIN },
  ]);

  const honest = windowEntry(links, 10, WINDOW);
  // Committed flows: 10 − 2 (gross out) + 2 (that cost, still held) = 10.
  assert.ok(Math.abs(honest.equityAtStart - 10) < 1e-9);
  assert.equal(honest.rounds, 1);

  // The attack the old baseline allowed: inflate the pre-window buy's
  // UNCOMMITTED cash copy so the replayed baseline collapses, and the same
  // in-window P&L becomes a multiple of itself as a return. The tampered
  // chain still verifies — that is what made it dangerous.
  const tampered = links.map((l) => Object.assign({}, l));
  tampered[0].amount = 11;
  tampered[0].solNet = 11;
  tampered[0].txCostSol = 99;
  assert.equal((await verifyChain(tampered)).valid, true,
    'the tamper must be invisible to the hash check');

  const attacked = windowEntry(tampered, 10, WINDOW);
  assert.ok(Math.abs(attacked.equityAtStart - honest.equityAtStart) < 1e-12,
    `edited uncommitted fields moved the baseline from ${honest.equityAtStart} to ${attacked.equityAtStart}`);
  assert.ok(Math.abs(attacked.score - honest.score) < 1e-12,
    'and therefore must not move the windowed score either');
});

test('a rekeyed carry-in position prices into the baseline; its round stays outside', async () => {
  const links = await chainOf([
    // Opened before the window under the pair stand-in address…
    { id: 'k1', sessionId: 'sRK', mint: 'PAIRADDR', side: 'buy',
      qty: 1000, priceNative: 0.001, solGross: 1, solNet: 0.99, ts: 10 * MIN },
    // …closed inside the window under the real mint (rekeyed, F-51).
    { id: 'k2', sessionId: 'sRK', mint: 'REALMINT', side: 'sell',
      qty: 1000, priceNative: 0.003, solGross: 3, solNet: 2.97, ts: 110 * MIN },
  ]);
  const entry = windowEntry(links, 10, WINDOW);
  // Baseline: 10 − 1 committed out + 1 still-held cost = 10, session-matched
  // across the rename exactly like the season walk.
  assert.ok(Math.abs(entry.equityAtStart - 10) < 1e-9);
  // The round OPENED before the window, so it must not count inside it —
  // carried-in positions were decided before the window existed.
  assert.equal(entry.rounds, 0);
  assert.ok(Math.abs(entry.pnlSol) < 1e-12);
});
