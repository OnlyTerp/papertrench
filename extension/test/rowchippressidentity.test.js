/*
 * A virtualized screener can reuse the same row element for another token
 * while the user is pressing a quick-buy chip. The bridge must bind identity
 * at press time and refuse if the row no longer proves that identity at click.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const bridge = fs.readFileSync(path.join(ROOT, 'price-bridge.js'), 'utf8');
const content = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');

function decision() {
  const start = bridge.indexOf('function rowChipTapDecision(');
  const end = bridge.indexOf('\n  /* Chip taps', start);
  assert.ok(start !== -1 && end > start, 'rowChipTapDecision must ship in the bridge');
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(`${bridge.slice(start, end)}\nthis.rowChipTapDecision = rowChipTapDecision;`, ctx);
  return ctx.rowChipTapDecision;
}

const rowChipTapDecision = decision();

function entry(overrides = {}) {
  return {
    address: 'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    verifiedAt: 10_000,
    pressedAddress: 'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    pressedAt: 10_000,
    ...overrides,
  };
}

test('a recycled row refuses instead of buying the old coin', () => {
  const out = rowChipTapDecision(
    entry({ address: 'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }),
    'MintBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    10_500,
  );
  assert.deepEqual({ ...out.refuse }, {
    was: 'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    now: 'MintBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    reason: 'row-changed',
  });
});

test('a stable row fills with the address verified at press time', () => {
  assert.deepEqual(
    { ...rowChipTapDecision(entry(), 'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 10_500) },
    { address: 'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
  );
});

test('an unreadable row can fill while its sweep verification is fresh', () => {
  assert.deepEqual(
    { ...rowChipTapDecision(entry(), null, 11_400) },
    { address: 'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
  );
});

test('an unreadable row with stale verification refuses', () => {
  const out = rowChipTapDecision(entry(), null, 11_501);
  assert.deepEqual({ ...out.refuse }, {
    was: 'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    now: null,
    reason: 'unverifiable',
  });
});

test('a press older than five seconds refuses', () => {
  const out = rowChipTapDecision(entry(), 'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 15_001);
  assert.deepEqual({ ...out.refuse }, {
    was: 'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    now: 'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    reason: 'stale-press',
  });
});

test('the bridge records current row identity on pointerdown', () => {
  assert.match(bridge, /entry\.pressedAddress = currentRowAddress\(entry\) \|\| entry\.address;/);
  assert.match(bridge, /entry\.pressedAt = Date\.now\(\);/);
  assert.match(bridge, /if \(ev\.type === 'pointerdown'\) \{[\s\S]{0,360}entry\.pressedAddress/);
  const start = bridge.indexOf("if (ev.type === 'pointerdown')");
  const end = bridge.indexOf('\n      return;', start);
  assert.doesNotMatch(
    bridge.slice(start, end),
    /stopImmediatePropagation/,
    'pointerdown must leave the content gesture stamp listener reachable',
  );
});

test('a refusal emits no busy state and uses the refusal bridge message', () => {
  const start = bridge.indexOf("if (ev.type !== 'click') return;");
  const end = bridge.indexOf('\n    }\n  }\n  for (const type', start);
  const click = bridge.slice(start, end);
  assert.match(click, /const decision = rowChipTapDecision\(entry, currentRowAddress\(entry\), Date\.now\(\)\)/);
  assert.match(click, /if \(decision\.address\) \{[\s\S]*chip\.classList\.add\('busy'\)[\s\S]*emit\('row-buy', \{ address: decision\.address \}\)/);
  const refusalStart = click.indexOf("else {\n          emit('row-buy-refused'");
  assert.ok(refusalStart >= 0, 'refusal branch must emit row-buy-refused');
  assert.doesNotMatch(click.slice(refusalStart), /classList\.add\('busy'\)/,
    'refusal must be handled without entering the busy path');
});

test('content toasts and records row-buy-refused without a fill completion', () => {
  const start = content.indexOf("else if (ev.type === 'row-buy-refused')");
  const end = content.indexOf("\n    else if (ev.type === 'nav')", start);
  assert.ok(start !== -1 && end > start, 'content refusal handler must ship');
  const refusal = content.slice(start, end);
  assert.match(refusal, /toast\('That row changed under your cursor/);
  assert.match(refusal, /EL\.record\('Paper buy refused: screener row identity changed'/);
  assert.match(refusal, /scope: 'content'/);
  assert.match(refusal, /was: p\.was \|\| null/);
  assert.match(refusal, /now: p\.now \|\| null/);
  assert.match(refusal, /reason: p\.reason \|\| null/);
  assert.doesNotMatch(refusal, /sendPadreMarker\('row-buy-done'/,
    'a refusal never entered the busy state');
});
