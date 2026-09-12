/* Row-chip self-retrigger freeze (v3.23.0).
 *
 * Field report (Discord #general, cheng + ark, 2026-09-11): Axiom/GMGN
 * pages freeze with the extension on — "can't click anything, even F12
 * gets no response" — and work normally with it off. F12 dead means the
 * renderer's main thread is saturated.
 *
 * Mechanism: chips live in a plain-DOM layer under body, so every chip
 * add/remove is a body-subtree childList mutation — observed by BOTH the
 * ISOLATED rowBuyObserver (content.js, driving full MAIN-world list scans
 * at several Hz) and the MAIN rowChipObserver (price-bridge.js, driving
 * forced-layout reposition sweeps). Each side's paint re-fired both
 * observers: a perpetual loop that never idles on churning lists.
 *
 * Fix under test: both observers ignore mutations rooted in the chip
 * layer (only site mutations schedule work), the content observer is a
 * first-paint accelerator that disconnects after 8 s (the 1 s bar-scan
 * owns steady state), and hidden tabs skip scans/sweeps entirely.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const CONTENT = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
const BRIDGE = fs.readFileSync(path.join(ROOT, 'price-bridge.js'), 'utf8');

/** A top-level function declaration, sliced out and runnable standalone. */
function sliceFn(src, name) {
  const at = src.indexOf('function ' + name + '(');
  assert.ok(at >= 0, 'function must exist: ' + name);
  const end = src.indexOf('\n  }', at);
  assert.ok(end > at, 'function must close: ' + name);
  return src.slice(at, end) + '\n  }';
}

function filterHarness(src, name) {
  const chip = { id: '', nodeType: 1 };
  const layer = {
    id: 'pt-rowbuy-layer', nodeType: 1,
    contains: (node) => node === layer || node === chip,
  };
  const siteRow = { id: 'row-1', nodeType: 1 };
  const sandbox = {
    document: {
      hidden: false,
      getElementById: (id) => (id === 'pt-rowbuy-layer' ? layer : null),
    },
    console,
  };
  vm.createContext(sandbox);
  const fn = vm.runInContext(
    sliceFn(src, name) + '\n;' + name + ';', sandbox, { filename: name + '.slice.js' });
  return { fn, chip, layer, siteRow, sandbox };
}

for (const [src, name, where] of [
  [CONTENT, 'rowMutationIsOurs', 'content.js'],
  [BRIDGE, 'chipMutationIsOurs', 'price-bridge.js'],
]) {
  test(`${where}: chip-layer mutations are ours, site mutations are not`, () => {
    const { fn, chip, layer, siteRow } = filterHarness(src, name);
    assert.equal(fn({ target: layer }), true, 'paint on the layer itself is ours');
    assert.equal(fn({ target: chip }), true, 'paint on a chip inside the layer is ours');
    assert.equal(fn({ target: siteRow }), false, 'a site row shifting is site work');
    assert.equal(fn({ target: null }), false);
    assert.equal(fn({}), false);
    assert.equal(fn(null), false);
  });

  test(`${where}: without a layer, everything counts as site work`, () => {
    const { fn, chip, sandbox } = filterHarness(src, name);
    sandbox.document.getElementById = () => null;
    assert.equal(fn({ target: chip }), false,
      'fail-open: no layer means no paint of ours exists, so scans proceed');
  });
}

test('content.js: the row observer is a first-paint accelerator, not a perpetual driver', () => {
  const at = CONTENT.indexOf('function startRowBuyObserver()');
  assert.ok(at >= 0, 'the observer starter must exist');
  const body = CONTENT.slice(at, CONTENT.indexOf('\n  function stopRowBuyObserver', at));
  assert.match(body, /rowMutationIsOurs\(record\)/,
    'site mutations — and only site mutations — schedule a scan');
  assert.match(body, /setTimeout\(\(\) => \{ stopRowBuyObserver\(\); \}, 8000\)/,
    'the observer disconnects after hydration; the 1 s bar-scan owns steady state');
});

test('content.js + bridge: hidden tabs skip scans and sweeps', () => {
  const scanAt = CONTENT.indexOf('function scanRowBuys()');
  const scanBody = CONTENT.slice(scanAt, CONTENT.indexOf('\n  }', scanAt));
  assert.match(scanBody, /document\.hidden/,
    'scanRowBuys must stand down while hidden');
  const sweepAt = BRIDGE.indexOf('function sweepRowChips()');
  const sweepBody = BRIDGE.slice(sweepAt, BRIDGE.indexOf('\n  }', sweepAt));
  assert.match(sweepBody, /document\.hidden/,
    'sweepRowChips must stand down while hidden');
});
