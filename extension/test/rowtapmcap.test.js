/* 3.27.1 — the market cap a tapped Pulse row was SHOWING rides the row-buy
 * message as a sanity bound (never a price). Live 2026-11-16 a chip booked
 * Jupiter's $708K on a row printing $16.5M. This runs the bridge's real
 * parser on the row text Axiom Unified renders (captured live). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'price-bridge.js'), 'utf8');
const start = src.indexOf('  function rowDisplayedMcap(row) {');
assert.ok(start > 0, 'rowDisplayedMcap exists in the bridge');
const end = src.indexOf('\n  }\n', start) + 4;
const parse = vm.runInNewContext(src.slice(start, end) + '\nrowDisplayedMcap;');
const row = (innerText) => ({ innerText });

test('reads the cap Axiom Unified Pulse rows print', () => {
  assert.equal(parse(row('0 SOL V $13 MC $1.08K F 0.032 NB +$8 TX 9')), 1080);
  assert.equal(parse(row('25 USDC MC\n$10.6K V $825')), 10600);
  assert.equal(parse(row('USPR V $143K MC $16.5M F 12.02')), 16_500_000);
  assert.equal(parse(row('MC $541.9 F 0.04')), 541.9);
  assert.equal(parse(row('MC $1,250 TX 3')), 1250);
});

test('no MC on the row means no bound, never a guess', () => {
  assert.equal(parse(row('V $13 F 0.032 TX 9')), null);
  assert.equal(parse(row('')), null);
  assert.equal(parse(null), null);
  assert.equal(parse(row('ATMC $5K')), null, 'MC must be its own word');
});
