/* F-56 — chip fills run the SAME honesty gates as panel fills.
 * Field reports (soramonk 8/21 — a fill priced at 14x the coin's ATH;
 * cheng.4848/arsedna — instant-buy fills at absurd prices): a board quick-buy
 * used the ROW's own price blind — no witness, no contradiction check.
 * Now an existing position anchors the check, and a diverging quote needs a
 * second independent source to vouch or the fill is refused visibly. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const ROOT = path.resolve(import.meta.dirname, '..');
const content = readFileSync(path.join(ROOT, 'content.js'), 'utf8');

function bodyOf(marker, span = 4000) {
  const start = content.indexOf(marker);
  assert.ok(start > 0, `${marker} exists`);
  return content.slice(start, start + span);
}

test('fillRowBuy anchors its witness on the position itself', () => {
  const body = bodyOf('async function fillRowBuy');
  assert.match(body, /state\.positions\[data\.mint\]/,
    'the anchor is the position for THIS mint');
  assert.match(body, /lastPriceNative/,
    'the anchor value is the wallet\'s last honest mark');
});

test('a quote diverging >2x from the anchor needs independent vouching', () => {
  const body = bodyOf('async function fillRowBuy');
  assert.match(body, /ratio > 2/, 'the divergence gate is 2x');
  assert.match(body, /data\.priceSource === 'row-feed' \|\| data\.priceSource === 'row-props' \|\| !data\.priceSource/,
    'page-row candidates are corroborated by the resolver');
  assert.match(body, /recentRowPrices\.get\(data\.mint\)/,
    'resolver-fed candidates are corroborated by the row feed');
  assert.match(body, /<= 1\.6/, 'vouching tolerance is 1.6x');
});

test('an unvouched chip fill is refused visibly, never priced blind', () => {
  const body = bodyOf('async function fillRowBuy');
  assert.match(body, /Price sources disagree — paper fill refused/,
    'the refusal says why');
  assert.match(body, /return null/, 'and books nothing');
});

test('a first buy with no anchor keeps the board price (nothing better exists at t=0)', () => {
  const body = bodyOf('async function fillRowBuy');
  // The whole anchor block is guarded by posAnchor existing — a fresh coin
  // (no position) must sail straight through to the guardrails.
  assert.match(body, /if \(posAnchor > 0 && Number\(data\.priceNative\) > 0\) \{/,
    'the witness only runs when an anchor exists');
});
