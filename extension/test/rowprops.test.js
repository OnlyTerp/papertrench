/* Axiom row-props quotes must come from one coherent, tapped row record.
 *
 * The bridge walks the tapped row's React fiber only at click time. These
 * tests drive the shipped extractor against the record shape captured from
 * the logged-in Axiom board, including its separate USD props candidate.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const BRIDGE = fs.readFileSync(path.join(ROOT, 'price-bridge.js'), 'utf8');
const A = 'A'.repeat(32);
const B = 'B'.repeat(32);
const PAIR = 'P'.repeat(32);

function quoteExtractor() {
  const start = BRIDGE.indexOf('function rowQuoteFromFiber(');
  const end = BRIDGE.indexOf('function findRowContainer(', start);
  assert.ok(start !== -1 && end > start, 'rowQuoteFromFiber must ship in the bridge');
  const context = {
    BASE58_RE: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
    numberValue(value) {
      if (typeof value === 'number') return Number.isFinite(value) ? value : null;
      if (typeof value === 'string' && value.length <= 64) {
        const number = Number(value.replace(/[$,\s]/g, ''));
        return Number.isFinite(number) ? number : null;
      }
      return null;
    },
  };
  vm.createContext(context);
  vm.runInContext(BRIDGE.slice(start, end), context, { filename: 'price-bridge.js' });
  return context.rowQuoteFromFiber;
}

function makeRow(memoizedProps, memoizedState) {
  const row = {};
  row.__reactFiber$test = { memoizedProps, memoizedState };
  return row;
}

test('a tapped Axiom row yields its coherent mint, pair, SOL and USD quote', () => {
  const row = makeRow(
    {
      tokenPriceUsd: 0.003295168220388057,
      marketCapUsd: 3244624.7223963863,
      row: {
        tokenAddress: A,
        pairAddress: PAIR,
        priceSol: 0.00003229290690305818,
        marketCapSol: 31797.576660097864,
        supply: 984661329.98038,
      },
    },
    {},
  );
  const quote = quoteExtractor()(row, A);

  assert.deepEqual(JSON.parse(JSON.stringify(quote)), {
    mint: A,
    pair: PAIR,
    priceSol: 0.00003229290690305818,
    priceUsd: 0.003295168220388057,
    mcapUsd: 3244624.7223963863,
    supply: 984661329.98038,
  });
});

test('a record for another token is discarded by the tapped identity guard', () => {
  const row = makeRow({
    tokenAddress: B,
    pairAddress: PAIR,
    priceSol: 1,
    tokenPriceUsd: 100,
  });
  assert.equal(quoteExtractor()(row, A), null);
});

test('a richer neighboring fiber cannot replace the tapped row record', () => {
  const row = {};
  row.__reactFiber$test = {
    memoizedProps: { tokenAddress: A, priceSol: 0.1 },
    sibling: {
      memoizedProps: {
        tokenAddress: B,
        pairAddress: PAIR,
        priceSol: 9,
        tokenPriceUsd: 900,
        marketCapUsd: 900_000,
        supply: 100_000,
      },
    },
  };
  const quote = quoteExtractor()(row, A);
  assert.equal(quote.mint, A);
  assert.equal(quote.priceSol, 0.1);
  assert.equal(quote.priceUsd, null);
});

test('a parent price is not inherited by a descendant identity record', () => {
  const row = makeRow({
    priceSol: 9,
    child: { tokenAddress: A, pairAddress: PAIR },
  });
  assert.equal(
    quoteExtractor()(row, A),
    null,
    'identity and price must come from the same coherent record',
  );
});

test('unitless prices and percentage changes never become row quotes', () => {
  const extract = quoteExtractor();
  assert.equal(extract(makeRow({
    tokenAddress: A,
    pairAddress: PAIR,
    price: 1,
    price1minChange: 2,
    price24h: 3,
  }), A), null);
  assert.equal(extract(makeRow({
    tokenAddress: A,
    price1minChange: 1,
    price24hChange: 2,
  }), A), null);
});

test('the row-buy bridge message carries the quote from the tapped row', () => {
  assert.match(
    BRIDGE,
    /emit\('row-buy',\s*\{\s*address: entry\.address,\s*quote: rowQuoteFromFiber\(entry\.row, entry\.address\),/s,
  );
});
