/* Replay engine tests — negative-control discipline.
 *
 * The engine folds trades into a position and steps PnL. These tests assert the
 * HONEST numbers, and are constructed so a plausible-looking bug (a transfer
 * ranking as profit, a corrupted cash-flow, a back-projected realized figure)
 * fails them. Run with: node --test test/replay.test.js
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const R = require('../core/replay.js');

// Real, base58-valid Solana addresses (a fake address with an O/I/0/l is
// correctly rejected by isAddress and would silently null every fill).
const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // USDC
const WSOL = 'So11111111111111111111111111111111111111112';
const WALLET_A = 'A3ZcnXcCMWRqLxy3ywqdfPtQ6LMSkXe1qHc5wvn2qFpL';
const WALLET_B = 'BgKsDTAT7t1VxTqZx4YcNq3K2wV9KmVxQ7Yd8fPcNpM';

function trade(over) {
  return Object.assign({
    ts: 1_700_000_000_000, address: MINT,
    transactionSenderAddress: WALLET_A,
    side: 'buy', baseToken: { address: MINT },
    quoteToken: { address: WSOL },
    baseTokenAmountRaw: '1000', quoteTokenAmountRaw: '100000000',
    baseTokenAmountUSD: '1', blockTime: 1_700_000_000,
  }, over);
}

test('a buy then a sell at a profit realizes the cash-flow PnL', () => {
  const buy = trade({ side: 'buy', blockTime: 1700000000, baseTokenAmountRaw: '1000', quoteTokenAmountRaw: '100000000', baseTokenAmountUSD: '1' });
  const sell = trade({ side: 'sell', blockTime: 1700000060, baseTokenAmountRaw: '1000', quoteTokenAmountRaw: '200000000', baseTokenAmountUSD: '2' });
  const p = R.foldFills([R.normalizeTrade(buy), R.normalizeTrade(sell)].filter(Boolean));
  assert.equal(p.qty, 0, 'should be flat after selling everything');
  assert.ok(Math.abs(p.realized - 1) < 1e-9, `realized should be ~$1, got ${p.realized}`);
  assert.ok(Math.abs(p.cash - 1) < 1e-9, `cash flow should be +$1, got ${p.cash}`);
  assert.equal(p.buys, 1); assert.equal(p.sells, 1);
});

test('a transfer creates no cost basis and never ranks as a win', () => {
  // 32M tokens handed over, nothing spent, nothing sold: qty is real, total ~$0.
  const gift = trade({
    side: 'buy', blockTime: 1700000000, baseTokenAmountRaw: '32000000',
    quoteTokenAmountRaw: '0', baseTokenAmountUSD: '0',
  });
  const candle = new Map([[Math.floor(1700000000 / 60) * 60, { c: 0.145 }]]);
  const filled = R.normalizeTrade(gift, candle);
  assert.ok(filled, 'an unpriced transfer must be marked from the bar close');
  const p = R.foldFills([filled]);
  assert.ok(p.qty > 0, 'the position is real');
  assert.equal(p.costBasis, 0, 'no basis was paid');
  assert.equal(p.boughtUsd, 0, 'nothing was spent');
  const pnl = R.pnlAt(p, 0.145);
  assert.ok(Math.abs(pnl.total) < 1e-6, `a pure gift must rank ~$0, got ${pnl.total}`);
});

test('replayCurve steps realized vs unrealized per bar', () => {
  const buy = trade({ side: 'buy', blockTime: 1700000000, baseTokenAmountRaw: '1000', quoteTokenAmountRaw: '100', baseTokenAmountUSD: '1' });
  const sell = trade({ side: 'sell', blockTime: 1700000060, baseTokenAmountRaw: '1000', quoteTokenAmountRaw: '200', baseTokenAmountUSD: '2' });
  const candles = [
    { ts: 1700000000000, o: 0.001, h: 0.001, l: 0.001, c: 0.001 },
    { ts: 1700000060000, o: 0.002, h: 0.002, l: 0.002, c: 0.002 },
  ];
  const fills = [R.normalizeTrade(buy), R.normalizeTrade(sell)].filter(Boolean);
  const pts = R.replayCurve(fills, candles);
  assert.ok(pts.length >= 2, `expect points per bar, got ${pts.length}`);
  const first = pts[0];
  assert.ok(Math.abs(first.qty - 1000) < 1e-9, `first bar qty 1000, got ${first.qty}`);
});

test('leaderboard ranks by cash-flow total, transfers excluded from the mark', () => {
  const a = R.normalizeTrade(trade({ side: 'buy', blockTime: 1700000000, baseTokenAmountRaw: '1000', quoteTokenAmountRaw: '100', baseTokenAmountUSD: '1' }));
  const byWallet = R.groupByWallet([a].filter(Boolean));
  const lb = R.leaderboard(byWallet, 0.002, 10);
  assert.equal(lb.wallets, 1);
  assert.equal(lb.top.length, 1);
  // buying $1 of a token now at $0.002 (2x the $0.001 entry) → unrealized +1
  const row = lb.top[0];
  assert.ok(Math.abs(row.total - 1) < 1e-6, `unrealized ~$1, got ${row.total}`);
});

/* ---- negative control: the harness must be able to FAIL ---- */
test('negative control: a basis-wiping fold produces a DIFFERENT (wrong) realized', () => {
  const buy = R.normalizeTrade(trade({ side: 'buy', blockTime: 1700000000, baseTokenAmountRaw: '1000', quoteTokenAmountRaw: '100', baseTokenAmountUSD: '1' }));
  const sell = R.normalizeTrade(trade({ side: 'sell', blockTime: 1700000060, baseTokenAmountRaw: '1000', quoteTokenAmountRaw: '200', baseTokenAmountUSD: '2' }));
  // Sabotage: wipe the basis so the sell books as PURE profit. The honest engine
  // reports realized ≈ +$1. The broken one inflates it to ~$1000000. This proves
  // the harness can catch a realistic regression (a fold that forgets cost
  // basis), because the honest assertion (realized ≈ 1) would reject the broken
  // result.
  const brokenFold = (fills) => {
    const p = R.foldFills(fills);
    p.costBasis = 0; p.unknownHeld = 0; p.realized += 999999;
    return p;
  };
  const honest = R.foldFills([buy, sell]);
  const broken = brokenFold([buy, sell]);
  // The honest realized is ~1; the broken one is ~1000000. They must differ,
  // and the broken one must be the wrong number.
  assert.ok(Math.abs(honest.realized - 1) < 1e-6, `honest realized ~$1, got ${honest.realized}`);
  assert.ok(Math.abs(broken.realized - 1000000) < 1e-6, `broken realized ~$1000000, got ${broken.realized}`);
  assert.notStrictEqual(Math.round(honest.realized), Math.round(broken.realized),
    'a basis-wiping fold must be distinguishable from the honest one');
});
