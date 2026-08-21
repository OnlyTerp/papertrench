/* D-09: share-card entry/exit mcap must be all-or-nothing.
 *
 * A fresh-launch fill often pre-dates the mcap tick and carries mcap: null.
 * The old weighted() counted that fill's qty in the denominator but 0 in
 * the numerator — the card understated the entry/exit mcap (or showed a
 * bogus small number where the trader remembered "in at 240K"). The house
 * discipline (usdTotal / weightedUsd) is all-or-nothing: if even one fill
 * on the side lacks mcap, the average is null and the card falls back to
 * the price line. This locks that contract on the shared derivation both
 * card composers use. */
const test = require('node:test');
const assert = require('node:assert');
const PC = require('../pnlcard.js');

const ROUND = { id: 'r1', pnlSol: 2.5, tradeIds: ['t1', 't2', 't3'] };

function journal(extra) {
  return [
    { id: 't1', side: 'buy',  qty: 10, priceNative: 100, mcap: 240_000, priceUsd: null },
    { id: 't2', side: 'buy',  qty: 10, priceNative: 100, mcap: 260_000, priceUsd: null },
    { id: 't3', side: 'sell', qty: 20, priceNative: 140, mcap: 900_000, priceUsd: null },
    ...extra,
  ];
}

test('D-09: all fills carry mcap → weighted entry/exit mcap as before', () => {
  const src = PC.roundCardSource(ROUND, journal([]));
  assert.equal(src.entryMcap, 250_000);  // (240k*10 + 260k*10) / 20
  assert.equal(src.exitMcap, 900_000);
});

test('D-09: one buy missing mcap → entryMcap is null (never a partial average)', () => {
  const partial = journal([{ id: 't4', side: 'buy', qty: 5, priceNative: 110, mcap: null, priceUsd: null }]);
  const src = PC.roundCardSource({ ...ROUND, tradeIds: ['t1', 't2', 't4', 't3'] }, partial);
  // OLD behavior: (240k*10 + 260k*10 + 0*5) / 25 = 200_000 — a 20% lie.
  assert.equal(src.entryMcap, null);
  // The side without gaps still averages normally.
  assert.equal(src.exitMcap, 900_000);
});

test('D-09: one sell missing mcap → exitMcap is null, entry unaffected', () => {
  const partial = journal([{ id: 't5', side: 'sell', qty: 3, priceNative: 150, mcap: null, priceUsd: null }]);
  const src = PC.roundCardSource({ ...ROUND, tradeIds: ['t1', 't2', 't3', 't5'] }, partial);
  assert.equal(src.entryMcap, 250_000);
  assert.equal(src.exitMcap, null);
});

test('D-09: zero-qty fills do not poison the gate', () => {
  // A zero-qty fill with mcap: 0 must not block an otherwise complete set —
  // weighted() already excludes non-positive qty from the denominator.
  const withZero = journal([{ id: 't6', side: 'buy', qty: 0, priceNative: 0, mcap: 0, priceUsd: null }]);
  const src = PC.roundCardSource({ ...ROUND, tradeIds: ['t1', 't2', 't6', 't3'] }, withZero);
  assert.equal(src.entryMcap, 250_000);
});

test('D-09: cardModel falls back to the price line when mcap is null', () => {
  const partial = journal([{ id: 't4', side: 'buy', qty: 5, priceNative: 110, mcap: null, priceUsd: null }]);
  const src = PC.roundCardSource({
    ...ROUND,
    investedSol: 2, returnedSol: 4.5, closedAt: 1755700000000, pnlPct: 125,
    tradeIds: ['t1', 't2', 't4', 't3'],
  }, partial);
  const model = PC.cardModel(src, {});
  assert.ok(model, 'model builds');
  // entryMcap null → entryText derives from entryPrice (formatPrice), never
  // from a partial mcap. formatPrice output has no 'K'/'M' market-cap suffix.
  assert.ok(typeof model.entryText === 'string' && model.entryText.length > 0);
  assert.ok(!/\d(\.\d+)?K\b/.test(model.entryText), `entryText not price-shaped: ${model.entryText}`);
});
