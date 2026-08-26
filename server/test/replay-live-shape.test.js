/* Live-wire shape tests — the fixture is REAL Indeix output captured 8/25
 * during the outage recovery (50 trades, CATE mint, 9 distinct wallets).
 * These tests drive the REAL normalizeTrade + groupByWallet + leaderboard
 * pipeline with the exact bytes the provider serves, so a wire-shape drift
 * (field renames, seconds-vs-ms, side conventions) fails HERE, not in prod.
 */
'use strict';

const assert = require('node:assert');
const test = require('node:test');
const path = require('node:path');
const fs = require('node:fs');
const replay = require('../core/replay.js');

const MINT = 'Ai66LHZG9MCzg1WKdawwqduVAXpNDUuV8M3uyq5ppump';
const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'indeix-trades-live.json'), 'utf8'));
const items = Array.isArray(raw) ? raw : (raw.data || raw.items || []);

test('live fixture is intact (50 real trades)', () => {
  assert.strictEqual(items.length, 50);
  assert.ok(items.every((t) => t.baseToken && t.baseToken.address === MINT),
    'every trade in this capture is about the CATE mint as baseToken');
});

test('every live trade normalizes: no field-shape drift', () => {
  const fills = items.map((t) => replay.normalizeTrade(t, null, MINT)).filter(Boolean);
  // Every trade carries baseTokenAmountUSD + amounts on the live wire, so all
  // 50 must price WITHOUT candle marks. If this drops, the wire shape drifted.
  assert.strictEqual(fills.length, 50, `expected all 50 to normalize, got ${fills.length}`);
  for (const f of fills) {
    assert.ok(f.ts > 1e12 && f.ts < 4e12, `ts must be epoch ms, got ${f.ts}`);
    assert.ok(f.base > 0, 'qty positive');
    assert.ok(f.priceUsd > 0, 'priced');
    assert.ok(f.usd > 0, 'usd value positive');
    assert.ok(['buy', 'sell'].includes(f.side));
    assert.ok(replay.isAddress(f.wallet), 'wallet is a real address');
    assert.strictEqual(f.isTransfer, false, 'swaps are not transfers');
  }
});

test('sides map from the live `type` field (buy AND sell both present)', () => {
  const fills = items.map((t) => replay.normalizeTrade(t, null, MINT)).filter(Boolean);
  const sides = new Set(fills.map((f) => f.side));
  assert.ok(sides.has('buy') && sides.has('sell'), `need both sides, got ${[...sides]}`);
  // Cross-check against the wire's own labels: counts must match exactly.
  const wireSells = items.filter((t) => t.type === 'sell').length;
  const oursSells = fills.filter((f) => f.side === 'sell').length;
  assert.strictEqual(oursSells, wireSells, 'sell count must match the wire labels');
});

test('normalized price agrees with the wire baseTokenPriceUSD within 1%', () => {
  const fills = items.map((t) => replay.normalizeTrade(t, null, MINT)).filter(Boolean);
  for (let i = 0; i < items.length; i++) {
    const wirePrice = Number(items[i].baseTokenPriceUSD);
    const f = fills[i];
    if (!(wirePrice > 0) || !f) continue;
    const rel = Math.abs(f.priceUsd - wirePrice) / wirePrice;
    assert.ok(rel < 0.01, `trade ${i}: price ${f.priceUsd} vs wire ${wirePrice} (rel ${rel})`);
  }
});

test('the full pipeline builds a leaderboard from real trades', () => {
  const fills = items.map((t) => replay.normalizeTrade(t, null, MINT)).filter(Boolean);
  const byWallet = replay.groupByWallet(fills);
  const walletCount = byWallet instanceof Map ? byWallet.size : Object.keys(byWallet).length;
  assert.strictEqual(walletCount, 9, 'the capture has exactly 9 distinct senders');
  const lastPrice = fills[0].priceUsd; // newest-first capture
  const lb = replay.leaderboard(byWallet, lastPrice, 10);
  const rows = Array.isArray(lb) ? lb : lb.top;
  assert.ok(Array.isArray(rows) && rows.length > 0 && rows.length <= 9,
    `leaderboard rows out of range: ${rows && rows.length}`);
  for (const row of rows) {
    assert.ok(replay.isAddress(row.wallet));
    assert.ok(Number.isFinite(row.total), 'PnL total must be a real number');
  }
});

/* ---- negative control: the harness must catch wire drift ---- */
test('negative control: renaming a live field breaks normalization', () => {
  const sab = JSON.parse(JSON.stringify(items[0]));
  delete sab.date; // simulate the timestamp field being renamed
  delete sab.blockTime;
  delete sab.timestamp;
  const f = replay.normalizeTrade(sab, null, MINT);
  assert.strictEqual(f, null, 'a trade with no recognizable timestamp must be rejected, not fabricated');
});
