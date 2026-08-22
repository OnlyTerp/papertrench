/* The round ledger: invested / sold / remaining / change.
 *
 * Requested from a venue screenshot — INVESTED, SOLD, REMAINING, PNL CHANGE.
 * The question it answers is not the one positionMark answers. A bag sold
 * halfway down shows a RED unrealized P&L on what is left while the round as
 * a whole is up, so the card stated one thing and the trader meant the other.
 *
 * Derived, never stored, so the tests are about what it must never count.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Q = require('../quote.js');
const content = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');

const POS = { mint: 'MINT', sessionId: 'S1', openedAt: 1000, investedSol: 2, qty: 10, costSol: 1 };
// mint rides on every real journal fill, and the sessionId-less fallback path
// matches on it — a fixture without one exercises neither branch.
const sell = (o) => Object.assign(
  { side: 'sell', mint: 'MINT', sessionId: 'S1', ts: 2000, solNet: 0, pnlSol: 0 }, o);

test('no sells yet means no ledger to show', () => {
  const led = Q.positionLedger([], POS, 3);
  assert.equal(led.sells, 0, 'nothing has come back');
  assert.equal(led.soldSol, 0);
});

test('the change is money back plus money still held, against money in', () => {
  const led = Q.positionLedger([sell({ solNet: 1.5, pnlSol: 0.5 })], POS, 1.2);
  assert.equal(led.investedSol, 2);
  assert.equal(led.soldSol, 1.5);
  assert.equal(led.remainingSol, 1.2);
  // 1.5 returned + 1.2 still held − 2 in = +0.7
  assert.ok(Math.abs(led.changeSol - 0.7) < 1e-9);
  assert.ok(Math.abs(led.changePct - 35) < 1e-9);
});

test('a previous round in the same token is not counted', () => {
  // sessionId is stamped per position-open, so the earlier round has its own.
  const led = Q.positionLedger([
    sell({ solNet: 1, pnlSol: 0.4 }),
    sell({ sessionId: 'OLD-ROUND', solNet: 99, pnlSol: 99 }),
  ], POS, 0.5);
  assert.equal(led.sells, 1);
  assert.equal(led.soldSol, 1, 'the old round must not inflate this one');
});

test('a sell older than the position is not counted, even without a sessionId', () => {
  // Chains predating sessionIds fall back to matching by mint, which alone
  // would sweep in every earlier round the token ever had.
  const led = Q.positionLedger([
    sell({ sessionId: null, ts: 500, solNet: 50, pnlSol: 50 }),
    sell({ sessionId: null, ts: 3000, solNet: 1, pnlSol: 0.2 }),
  ], POS, 0.5);
  assert.equal(led.sells, 1, 'only the sell that belongs to THIS open round');
  assert.equal(led.soldSol, 1);
});

test('buys are never mistaken for money coming back', () => {
  const led = Q.positionLedger([
    { side: 'buy', sessionId: 'S1', ts: 1500, solNet: 5 },
    sell({ solNet: 1, pnlSol: 0.1 }),
  ], POS, 0.5);
  assert.equal(led.soldSol, 1);
});

test('house money is the sells alone covering what went in', () => {
  const under = Q.positionLedger([sell({ solNet: 1.99, pnlSol: 0.2 })], POS, 5);
  assert.equal(under.houseMoney, false, 'unrealised value must not count toward it');
  const over = Q.positionLedger([sell({ solNet: 2.0, pnlSol: 0.3 })], POS, 0.1);
  assert.equal(over.houseMoney, true);
});

test('a zero-invested position cannot produce an infinite percentage', () => {
  const led = Q.positionLedger([sell({ solNet: 1 })], { ...POS, investedSol: 0 }, 1);
  assert.equal(led.changePct, 0, 'no denominator means no percentage claim');
  assert.ok(Number.isFinite(led.changeSol));
});

test('the panel renders it in the venue currency, and only after a sell', () => {
  const fn = content.slice(
    content.indexOf('function renderPositionLedger('),
    content.indexOf('\n  }', content.indexOf('function renderPositionLedger(')) + 4);
  assert.match(fn, /led\.sells === 0/, 'it must stay hidden until something has been sold');
  assert.match(fn, /panelUsd\(\)/, 'dollars off Solana');
  assert.match(fn, /E\.fmt\(sol, 3\)} SOL/, 'SOL on Solana');
  assert.match(fn, /pt-house/, 'and it must mark the house-money state');
});
