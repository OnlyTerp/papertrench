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

function makeFiberChain(length, targetIndex, targetProps) {
  const start = { memoizedProps: {} };
  let fiber = start;
  for (let index = 1; index <= length; index += 1) {
    fiber.sibling = { memoizedProps: index === targetIndex ? targetProps : {} };
    fiber = fiber.sibling;
  }
  const row = {};
  row.__reactFiber$test = start;
  return row;
}

test('a tapped Axiom row yields its coherent mint, pair, SOL and USD quote', () => {
  const row = makeRow(
    {
      tokenAddress: A,
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
    tokenPriceUsd: 900,
    marketCapUsd: 900_000,
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

test('a GMGN row proves its bare price is USD from supply and market cap', () => {
  const row = makeRow({
    data: {
      address: A,
      pool_address: PAIR,
      price: 0.0000028749178,
      usd_market_cap: 2874.92,
      total_supply: 1_000_000_000,
    },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(quoteExtractor()(row, A))), {
    mint: A,
    pair: PAIR,
    priceSol: null,
    priceUsd: 0.0000028749178,
    mcapUsd: 2874.92,
    supply: 1_000_000_000,
  });
});

test('an explicit mint wins over an unrelated generic address', () => {
  const row = makeRow({
    mint: A,
    address: B,
    pairAddress: PAIR,
    priceSol: 0.000032,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(quoteExtractor()(row, A))), {
    mint: A,
    pair: PAIR,
    priceSol: 0.000032,
    priceUsd: null,
    mcapUsd: null,
    supply: null,
  });
});

test('an explicit token address wins over an unrelated generic address', () => {
  const row = makeRow({
    tokenAddress: A,
    address: B,
    pairAddress: PAIR,
    priceSol: 0.000032,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(quoteExtractor()(row, A))), {
    mint: A,
    pair: PAIR,
    priceSol: 0.000032,
    priceUsd: null,
    mcapUsd: null,
    supply: null,
  });
});

test('a GMGN bare price without its USD cap is rejected', () => {
  assert.equal(quoteExtractor()(makeRow({
    address: A,
    price: 0.0000028749178,
    total_supply: 1_000_000_000,
  }), A), null);
});

test('a GMGN bare price that disagrees with supply and cap is rejected', () => {
  assert.equal(quoteExtractor()(makeRow({
    address: A,
    price: 0.00001,
    usd_market_cap: 2874.92,
    total_supply: 1_000_000_000,
  }), A), null);
});

test('an Axiom row can combine bounded ancestor records for the tapped token', () => {
  const start = {
    tokenAddress: A,
    pairAddress: PAIR,
    priceSol: 0.000032,
    tokenPriceUsd: 0.000032,
    supply: 1_000_000_000,
    tokenTicker: 'crap',
    tokenName: 'dinosaur crap',
  };
  const row = makeRow(start);
  let fiber = row.__reactFiber$test;
  for (let up = 1; up <= 7; up += 1) {
    fiber.return = { memoizedProps: up === 7
      ? { row: { tokenAddress: A, marketCapUsd: 32_000 } }
      : { row: { tokenAddress: A } } };
    fiber = fiber.return;
  }
  assert.deepEqual(JSON.parse(JSON.stringify(quoteExtractor()(row, A))), {
    mint: A,
    pair: PAIR,
    priceSol: 0.000032,
    priceUsd: 0.000032,
    mcapUsd: 32_000,
    supply: 1_000_000_000,
    symbol: 'crap',
    name: 'dinosaur crap',
  });
});

test('an ancestor record for another token cannot leak into the tapped row quote', () => {
  const row = makeRow({ tokenAddress: A, priceSol: 0.1 });
  row.__reactFiber$test.return = {
    memoizedProps: {
      row: { tokenAddress: B, priceSol: 9, marketCapUsd: 900_000, supply: 100_000 },
    },
  };
  const quote = quoteExtractor()(row, A);
  assert.equal(quote.mint, A);
  assert.equal(quote.priceSol, 0.1);
  assert.equal(quote.mcapUsd, null);
});

test('a GMGN record beyond 80 fibers is found within the 400-step bound', () => {
  const row = makeFiberChain(220, 211, {
    address: A,
    pool_address: PAIR,
    price: 0.000002,
    usd_market_cap: 2_000,
    total_supply: 1_000_000_000,
  });
  const quote = quoteExtractor()(row, A);
  assert.equal(quote.mint, A);
  assert.equal(quote.priceUsd, 0.000002);
});

test('a GMGN record beyond 400 fibers remains out of bounds', () => {
  const row = makeFiberChain(420, 411, {
    address: A,
    pool_address: PAIR,
    price: 0.000002,
    usd_market_cap: 2_000,
    total_supply: 1_000_000_000,
  });
  assert.equal(quoteExtractor()(row, A), null);
});

test('an incoherent USD cap is dropped while the coherent price remains', () => {
  const quote = quoteExtractor()(makeRow({
    tokenAddress: A,
    priceSol: 0.000032,
    tokenPriceUsd: 0.0032,
    marketCapUsd: 6_400,
    supply: 1_000_000,
  }), A);
  assert.equal(quote.priceUsd, 0.0032);
  assert.equal(quote.mcapUsd, null);
});

test('symbol and name values that look like addresses are rejected', () => {
  const quote = quoteExtractor()(makeRow({
    tokenAddress: A,
    priceSol: 0.000032,
    symbol: B,
    name: B,
  }), A);
  assert.equal(quote.symbol, undefined);
  assert.equal(quote.name, undefined);
});

test('Padre dev funding amounts never become row prices', () => {
  assert.equal(quoteExtractor()(makeRow({
    tokenAddress: A,
    marketAddress: PAIR,
    devFundTxnSolAmount: 0.9,
  }), A), null);
});

test('the row-buy bridge message carries the quote from the tapped row', () => {
  assert.match(
    BRIDGE,
    /emit\('row-buy',\s*\{\s*address: entry\.address,\s*quote: rowQuoteFromFiber\(entry\.row, entry\.address\),/s,
  );
});
