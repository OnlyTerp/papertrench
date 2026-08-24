/* F-59 — pulse-page instant-buy fills booked prices the row never printed.
 * Field report (Ski + sedna, 8/16): quick research on the pulse page, instant
 * buy, entry market cap wrong — the real 20k MC showed as 6k. Chart-page
 * fills were much closer, because the chart path runs the full witness
 * ladder while the row path filled on whatever the cascade returned.
 *
 * Three holes, one family:
 *   1. The post-cascade price override looked the row tick up by the
 *      resolver's MINT only — but pulse frames key records by whichever
 *      mint-shaped key they carry, often the PAIR. The fresh row print the
 *      trader was looking at missed the lookup, and the resolver's stale
 *      snapshot booked the fill.
 *   2. Even when the override fired, `mcap` was never rescaled: the toast
 *      and the position reported the resolver's stale cap while the price
 *      was the row's fresh one.
 *   3. F-56's witness anchors only on an EXISTING position — a first buy
 *      (the quick-research flow) filled blind on a lagging aggregator
 *      snapshot with nothing corroborating it.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const ROOT = path.resolve(import.meta.dirname, '..');
const content = readFileSync(path.join(ROOT, 'content.js'), 'utf8');

function bodyOf(marker, span = 9000) {
  const start = content.indexOf(marker);
  assert.ok(start > 0, `${marker} exists`);
  return content.slice(start, start + span);
}

/* ---------------- hole 1: the identity-keyed lookup ---------------- */

test('the row-price override tries every identity the token answers to', () => {
  const body = bodyOf('async function doRowBuy(');
  const override = body.slice(
    body.indexOf('The screener\'s own realtime price wins'),
    body.indexOf('await fillRowBuy(address, data, amount)')
  );
  assert.match(override, /recentRowPrices\.get\(data\.mint\)/, 'the mint is tried');
  assert.match(override, /recentRowPrices\.get\(data\.pairAddress\)/,
    'the resolver\'s pair address is tried (pulse frames often key by pair)');
  assert.match(override, /recentRowPrices\.get\(address\)/,
    'the click\'s own address is tried');
});

test('the armed-row flush override tries every identity too', () => {
  const body = bodyOf('async function flushRowArmed()');
  const override = body.slice(
    body.indexOf('The screener\'s own realtime price wins'),
    body.indexOf('await fillRowBuy(armed.address, data, armed.amount)')
  );
  assert.match(override, /recentRowPrices\.get\(data\.mint\)/);
  assert.match(override, /recentRowPrices\.get\(data\.pairAddress\)/);
  assert.match(override, /recentRowPrices\.get\(armed\.address\)/);
});

/* ---------------- hole 2: the cap must ride the price ---------------- */

test('a row-tick price override rescales the market cap with it', () => {
  const body = bodyOf('async function doRowBuy(');
  const override = body.slice(
    body.indexOf('The screener\'s own realtime price wins'),
    body.indexOf('await fillRowBuy(address, data, amount)')
  );
  // Supply is constant across the two reads, so mcap scales by exactly the
  // price ratio — the toast/position must never report the stale cap.
  assert.match(override, /const scale = live\.usd \/ Number\(data\.priceUsd\)/,
    'the scale is the fresh row USD over the cascade\'s USD');
  assert.match(override, /if \(Number\(data\.mcap\) > 0\) data\.mcap = Number\(data\.mcap\) \* scale/,
    'a present cap is rescaled');
  assert.ok(!/const rate = data\.priceUsd \/ data\.priceNative/.test(override),
    'the old rate-division (which left mcap stale) is gone');
});

test('the armed-row flush override rescales the cap too', () => {
  const body = bodyOf('async function flushRowArmed()');
  const override = body.slice(
    body.indexOf('The screener\'s own realtime price wins'),
    body.indexOf('await fillRowBuy(armed.address, data, armed.amount)')
  );
  assert.match(override, /const scale = live\.usd \/ Number\(data\.priceUsd\)/);
  assert.match(override, /if \(Number\(data\.mcap\) > 0\) data\.mcap = Number\(data\.mcap\) \* scale/);
});

/* ---------------- hole 3: the first-buy witness ---------------- */

test('a first buy with no position anchors on the row\'s own print', () => {
  const body = bodyOf('async function rowPrintVouchesFirstBuy(');
  assert.match(body, /if \(posAnchor\) return true/,
    'an existing position keeps the F-56 anchor and skips this gate');
  assert.match(body, /data\.priceSource === 'row-feed' \|\| data\.priceSource === 'row-onchain'/,
    'row-fed and chain-fed candidates are exempt (the print IS their source)');
  assert.match(body, /recentRowPrices\.get\(data\.pairAddress\)/,
    'the row print is looked up by every identity');
  assert.match(body, /> 2/, 'an aggregator diverging >2x from the print needs a witness');
  assert.match(body, /rowChainQuote\(/, 'the witness is the CHAIN (the resolver cannot vouch for itself)');
  assert.match(body, /<= 1\.6/, 'the witness must agree within 1.6x');
});

test('fillRowBuy consults the first-buy witness before booking', () => {
  const body = bodyOf('async function fillRowBuy(');
  const gate = body.slice(0, body.indexOf('E.guardCheck'));
  assert.match(gate, /if \(!\(await rowPrintVouchesFirstBuy\(address, data, posAnchor\)\)\) return null/,
    'the witness refusal books nothing');
});

test('the witness refuses visibly, in the family\'s own voice', () => {
  const body = bodyOf('async function rowPrintVouchesFirstBuy(');
  assert.match(body, /toast\('Price sources disagree — paper fill refused\. Try again in a moment\.'\)/);
});

test('an ancient row print never gates the fill', () => {
  const body = bodyOf('async function rowPrintVouchesFirstBuy(');
  // A coin long gone from the board (print older than the research window)
  // says nothing about the price now — the gate must not fire on it.
  assert.match(body, /ROW_ANCHOR_MAX_AGE_MS = 120_000/);
  assert.match(body, /Date\.now\(\) - rowPrint\.at > ROW_ANCHOR_MAX_AGE_MS\) return true/);
});
