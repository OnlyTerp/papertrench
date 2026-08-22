'use strict';
/* U4 (01jb, ideas 8/21: trade history "bought/held/sold") — the Levels
 * column quotes rounds the way traders do: entry → exit market cap, VWAP
 * per side from the round's own journal fills. Locks the derivation and
 * the honesty rules (pruned journal = em-dash, never a fake number). */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const E = require(path.join(ROOT, 'engine.js'));
const dashboard = fs.readFileSync(path.join(ROOT, 'dashboard.js'), 'utf8');

/** One round through the REAL engine API: E.buy / E.sell. */
function playRound(settings, buys, sells) {
  const state = E.defaultState(settings);
  const mint = 'SoL1aRyMintForTestingU4xxxxxxxxxxx';
  let t = 1_700_000_000_000;
  for (const [sol, mcap, priceNative] of buys) {
    state.seq++;
    E.buy(state, settings, { mint, symbol: 'TEST', name: 'Test', site: 'padre',
      ts: t += 1000, solAmount: sol, priceNative, priceUsd: priceNative * 150, mcap });
  }
  for (const [frac, mcap, priceNative] of sells) {
    state.seq++;
    E.sell(state, settings, { mint, ts: t += 1000, qtyFraction: frac, priceNative,
      priceUsd: priceNative * 150, mcap });
  }
  return state;
}

test('roundMcapPair: single buy / full sell quotes both sides', () => {
  const s = E.defaultState();
  const st = playRound(s, [[1, 40_000, 0.001]], [[1, 240_000, 0.006]]);
  const r = st.rounds[0];
  assert.ok(r, 'round closed');
  const m = E.roundMcapPair(st, r);
  assert.equal(Math.round(m.entryMcap), 40_000);
  assert.equal(Math.round(m.exitMcap), 240_000);
});

test('roundMcapPair: scaled exit is the SOL-weighted VWAP, not the last leg', () => {
  // Legs: 25% at 100k (priceNative 0.0025), 75% at 300k (priceNative 0.0075).
  // solNet weights are qty×price → 0.25·0.0025 vs 0.75·0.0075 = 1:9, so the
  // VWAP sits at (1·100k + 9·300k)/10 = 280k — NOT the last leg's 300k. The
  // point of the column: a scale-out quotes its true average, not the final
  // print's mcap.
  const s = E.defaultState();
  const st = playRound(s, [[1, 50_000, 0.001]], [[0.25, 100_000, 0.0025], [1, 300_000, 0.0075]]);
  const r = st.rounds[0];
  assert.ok(r);
  const m = E.roundMcapPair(st, r);
  assert.ok(Math.abs(m.exitMcap - 280_000) < 1_000,
    `SOL-weighted VWAP ≈280k (got ${Math.round(m.exitMcap)})`);
  assert.ok(m.exitMcap < 300_000, 'never just the last leg');
});

test('roundMcapPair: pruned journal yields nulls, never invented levels', () => {
  const s = E.defaultState();
  const st = playRound(s, [[1, 40_000, 0.001]], [[1, 240_000, 0.006]]);
  const r = st.rounds[0];
  const m = E.roundMcapPair({ journal: [] }, r);
  assert.equal(m.entryMcap, null);
  assert.equal(m.exitMcap, null);
});

test('roundMcapPair: defensive against malformed input', () => {
  assert.deepEqual(E.roundMcapPair(null, null), { entryMcap: null, exitMcap: null });
  assert.deepEqual(E.roundMcapPair({}, null), { entryMcap: null, exitMcap: null });
});

test('dashboard: Levels column exists before P&L', () => {
  assert.match(dashboard, /<th class="num">Levels<\/th>/, 'header present');
  assert.ok(dashboard.indexOf('Levels') < dashboard.indexOf('P&L SOL'), 'levels before P&L');
  assert.match(dashboard, /capStr\(mcaps\.entryMcap\)/, 'entry mcap rendered');
  assert.match(dashboard, /→ \$\{capStr\(mcaps\.exitMcap\)\}/, 'exit mcap rendered');
});

test('dashboard: CSV exports the mcaps too', () => {
  assert.match(dashboard, /'entryMcapUsd', 'exitMcapUsd'/, 'csv columns present');
  assert.match(dashboard, /roundMcapPair\(state \|\| \{ journal: \[\] \}, r\)/, 'csv derives with state');
});

test('dashboard: colspan grew with the new column', () => {
  assert.match(dashboard, /colspan="\$\{G \? 18 : 17\}"/, 'empty-state spans 17/18 now');
});
