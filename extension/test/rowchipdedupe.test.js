/* Bug 5 (live report 2026-08-22): "cards on the trenches page have 2 quick
 * buy buttons instead of 1".
 *
 * Probe evidence from the live padre Trenches DOM (dupe-geometry3 run):
 * every card's anchors climb to TWO nested rows that both fit
 * findRowContainer's size heuristic —
 *   chip 1: row = card       (x:354 y:336 w:472 h:98)
 *   chip 2: row = inner body (x:442 y:340 w:384 h:59)   [fully inside]
 * and both got keyed, so both wore a chip.
 *
 * This drives the shipped dedupeNestedRows() from price-bridge.js through a
 * vm with fake DOM nodes shaped exactly like that geometry.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const bridgeSrc = fs.readFileSync(path.join(ROOT, 'price-bridge.js'), 'utf8');

function extractHelper() {
  const start = bridgeSrc.indexOf('function dedupeNestedRows(');
  const end = bridgeSrc.indexOf('function scanScreenerRows(');
  assert.ok(start !== -1 && end > start, 'dedupeNestedRows must ship in the bridge');
  return bridgeSrc.slice(start, end);
}

function makeNode(name, children = []) {
  return {
    name,
    children,
    contains(n) {
      if (this === n) return true;
      return this.children.some((c) => c.contains(n));
    },
  };
}

function run(pairs) {
  const helper = extractHelper();
  const ctx = { Map };
  vm.createContext(ctx);
  vm.runInContext(helper, ctx);
  return ctx.dedupeNestedRows(pairs);
}

test('the probed padre geometry: card + inner body -> ONE row (the card)', () => {
  const body = makeNode('body');
  const card = makeNode('card', [body]);
  const out = run([[body, 'MintAAA'], [card, 'MintAAA']]);
  assert.equal(out.size, 1, 'one chip per card');
  assert.ok(out.has(card), 'the outermost row (the card) wins');
});

test('inner-first order still collapses (outer replaces the keyed inner)', () => {
  const body = makeNode('body');
  const card = makeNode('card', [body]);
  const out = run([[body, 'MintAAA'], [card, 'MintAAA']]);
  assert.equal(out.size, 1);
  // reversed insertion order — the rule must be order-independent
  const out2 = run([[card, 'MintAAA'], [body, 'MintAAA']]);
  assert.equal(out2.size, 1, 'order does not matter: one chip either way');
  assert.ok(out2.has(card), 'outer wins in both orders');
});

test('sibling cards keep their own chips', () => {
  const cardA = makeNode('cardA');
  const cardB = makeNode('cardB');
  const out = run([[cardA, 'MintAAA'], [cardB, 'MintBBB']]);
  assert.equal(out.size, 2);
  assert.equal(out.get(cardA), 'MintAAA');
  assert.equal(out.get(cardB), 'MintBBB');
});

test('three-deep nesting collapses to the outermost', () => {
  const leaf = makeNode('leaf');
  const mid = makeNode('mid', [leaf]);
  const card = makeNode('card', [mid]);
  const out = run([[leaf, 'M'], [mid, 'M'], [card, 'M']]);
  assert.equal(out.size, 1);
  assert.ok(out.has(card));
});

test('same row twice keeps one entry (idempotent for repeated anchors)', () => {
  const card = makeNode('card');
  const out = run([[card, 'MintAAA'], [card, 'MintAAA']]);
  assert.equal(out.size, 1);
});

test('nullish contains never throws (fiber-walk rows can be bare)', () => {
  const bare = { name: 'bare' }; // no .contains at all
  const card = makeNode('card');
  const out = run([[card, 'M'], [bare, 'M']]);
  // bare rows cannot prove nesting either way — both survive; the callers
  // filter such rows long before they reach here (addressFromRowFiber).
  assert.equal(out.size, 2);
});
