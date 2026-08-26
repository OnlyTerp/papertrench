/* Tests for worker/solana.js - the chain lane that rebuilds a wallet's fill
 * history from parsed transactions. Fixtures mirror the REAL parsed-tx shape
 * returned by getTransaction(jsonParsed) - verified live 8/26 on CATE. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const solana = require('../worker/solana.js');

const W = 'AgmLJBMDCqWynYnQiPCuj9ewsNNsBJXyzoUhD9LJzN51';
const M = 'Ai66LHZG9MCzg1WKdawwqduVAXpNDUuV8M3uyq5ppump';
const WSOL = 'So11111111111111111111111111111111111111112';

function mkTx({ tokenPre = 0, tokenPost = 0, solPre = 5e9, solPost = 5e9, wsolDelta = 0, err = null, blockTime = 1787726767 }) {
  const pre = [], post = [];
  if (tokenPre || tokenPost) {
    pre.push({ accountIndex: 3, owner: W, mint: M, uiTokenAmount: { uiAmount: tokenPre } });
    post.push({ accountIndex: 3, owner: W, mint: M, uiTokenAmount: { uiAmount: tokenPost } });
  }
  if (wsolDelta) {
    pre.push({ accountIndex: 4, owner: W, mint: WSOL, uiTokenAmount: { uiAmount: 2 } });
    post.push({ accountIndex: 4, owner: W, mint: WSOL, uiTokenAmount: { uiAmount: 2 + wsolDelta } });
  }
  return {
    blockTime,
    meta: {
      err,
      fee: 5000,
      preBalances: [solPre, 0, 0, 0, 0],
      postBalances: [solPost, 0, 0, 0, 0],
      preTokenBalances: pre,
      postTokenBalances: post,
    },
    transaction: {
      signatures: ['SigTest1111'],
      message: { accountKeys: [W, 'Fee111', 'Prog111', 'Ata111', 'Wsol111'] },
    },
  };
}

test('decodeFill: a buy = tokens in, SOL out', () => {
  const tx = mkTx({ tokenPre: 0, tokenPost: 31.0004, solPre: 5e9, solPost: 4.977e9 });
  const f = solana.decodeFill(tx, W, M);
  assert.ok(f, 'fill decoded');
  assert.strictEqual(f.side, 'buy');
  assert.ok(Math.abs(f.base - 31.0004) < 1e-6);
  assert.ok(f.solDelta < 0, 'buy spends SOL');
  assert.strictEqual(f.ts, 1787726767000, 'blockTime seconds -> ms');
});

test('decodeFill: USDC counter-leg is dollars (zero SOL moved)', () => {
  // Live shape 8/26: CATE tape's top trader swapped token<->USDC with no
  // native SOL delta at all - the old decoder called that a transfer and the
  // whole ledger showed $0. The USDC delta IS the dollar price.
  const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const tx = mkTx({ tokenPre: 0, tokenPost: 5708 });
  tx.meta.preTokenBalances.push({ accountIndex: 5, owner: W, mint: USDC, uiTokenAmount: { uiAmount: 500 } });
  tx.meta.postTokenBalances.push({ accountIndex: 5, owner: W, mint: USDC, uiTokenAmount: { uiAmount: 92.43 } });
  const f = solana.decodeFill(tx, W, M);
  assert.strictEqual(f.side, 'buy');
  assert.ok(Math.abs(f.stableUsd - 407.57) < 0.01, `USDC leg priced (got ${f.stableUsd})`);
});

test('decodeFill: a sell = tokens out, SOL in', () => {
  const tx = mkTx({ tokenPre: 31.0004, tokenPost: 0, solPre: 4.977e9, solPost: 4.999e9 });
  const f = solana.decodeFill(tx, W, M);
  assert.strictEqual(f.side, 'sell');
  assert.ok(f.solDelta > 0, 'sell receives SOL');
});

test('decodeFill: WSOL counter-leg is folded into the SOL delta', () => {
  const tx = mkTx({ tokenPre: 0, tokenPost: 100, wsolDelta: -0.5 });
  const f = solana.decodeFill(tx, W, M);
  assert.ok(Math.abs(f.solDelta + 0.5) < 1e-9, `wsol leg counted (got ${f.solDelta})`);
});

test('decodeFill negative control: failed tx decodes to nothing', () => {
  const tx = mkTx({ tokenPre: 0, tokenPost: 31, err: { InstructionError: [0, 'Custom'] } });
  assert.strictEqual(solana.decodeFill(tx, W, M), null);
});

test('decodeFill negative control: tx that moved no tokens for the wallet', () => {
  const tx = mkTx({ tokenPre: 10, tokenPost: 10 });
  assert.strictEqual(solana.decodeFill(tx, W, M), null);
});

test('decodeFill: another wallet\'s balances never leak in', () => {
  const tx = mkTx({ tokenPre: 0, tokenPost: 31 });
  tx.meta.postTokenBalances[0].owner = 'SomeoneElse1111111111111111111111111111111';
  assert.strictEqual(solana.decodeFill(tx, W, M), null);
});
