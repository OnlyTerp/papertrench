/* F-53: the list buy-button chip must never paint over the row's content
 * (jb, #bug-reports 2026-08-18: "quick buy button is on top of the mc on
 * terminal if ur format is ultra").
 *
 * Drives the real sweep against the nativecharts harness DOM. The harness
 * fakes elementFromPoint; the test teaches it a new trick — a CONTENT hit
 * (an element inside the row that is neither the row nor the chip) — by
 * reaching into the vm context is not needed: the debug transform tells us
 * which anchor got applied, and the harness's default elementFromPoint
 * already returns the row itself (a clean gutter/row hit → float stays).
 *
 * For the content-hit case this file ships its own tiny harness reusing the
 * same makeChipNode shapes, running the REAL price-bridge.js positionRowChip
 * through a minimal vm — the bridge is a single IIFE, so instead we pin the
 * decision helper directly: extract rowAnchorHitsContent from the shipped
 * source and drive it with fake DOM nodes.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const bridgeSrc = fs.readFileSync(path.join(ROOT, 'price-bridge.js'), 'utf8');

/* ---------------- helper extraction ---------------- */

function extractHelper() {
  const start = bridgeSrc.indexOf('function rowAnchorHitsContent(');
  const end = bridgeSrc.indexOf('function positionRowChip(');
  assert.ok(start !== -1 && end > start, 'rowAnchorHitsContent must ship in the bridge');
  return bridgeSrc.slice(start, end);
}

function makeNode(tag, rect) {
  return {
    tag,
    children: [],
    classList: { add() {}, remove() {}, contains() { return false; } },
    contains(n) { return this === n || this.children.includes(n); },
    getBoundingClientRect: () => rect || { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 },
  };
}

function runHelper({ hit, stack, chip, chipWidth = 28, anchorX = 500, anchorY = 140, rowChildren = [] }) {
  const helper = extractHelper();
  const ctx = {
    window: { innerHeight: 900, innerWidth: 1200 },
    Math, Number, Boolean,
    document: {
      elementFromPoint: () => hit,
      elementsFromPoint: stack ? () => stack : undefined,
    },
  };
  vm.createContext(ctx);
  vm.runInContext(helper, ctx);
  const row = makeNode('div', { top: 100, left: 10, right: 510, bottom: 180, width: 500, height: 80 });
  for (const c of rowChildren) row.children.push(c);
  const ownChip = chip || makeNode('span', { top: 130, left: 470, right: 498, bottom: 150, width: chipWidth, height: 20 });
  const entry = { el: ownChip };
  return ctx.rowAnchorHitsContent({ x: anchorX, y: anchorY }, row.getBoundingClientRect(), row, entry);
}

/* ---------------- decisions ---------------- */

test('F-53: a hit on the row container itself is clean (float anchor stays)', () => {
  const row = makeNode('div', { top: 100, left: 10, right: 510, bottom: 180, width: 500, height: 80 });
  assert.equal(runHelper({ hit: row }), false,
    'the anchor over the row background means the gutter guess was right');
});

test('F-53: a hit on content inside the row forces the gutter fallback', () => {
  const mcText = makeNode('span', { top: 110, left: 420, right: 505, bottom: 130, width: 85, height: 20 });
  assert.equal(runHelper({ hit: mcText, rowChildren: [mcText] }), true,
    'the chip body over the MC text is exactly the ultra-format defect');
});

test('F-53: a hit on the chip itself or outside the row is clean', () => {
  const chip = makeNode('span', { top: 130, left: 470, right: 498, bottom: 150, width: 28, height: 20 });
  assert.equal(runHelper({ hit: chip }), false, 'the chip covering itself is not a collision');
  const foreign = makeNode('div', { top: 0, left: 0, right: 1200, bottom: 900, width: 1200, height: 900 });
  assert.equal(runHelper({ hit: foreign }), false,
    'content OUTSIDE the row (page background) is not the row\u2019s problem');
});

test('F-53: a failed probe (elementFromPoint throws) never blocks placement', () => {
  const helper = extractHelper();
  const ctx = {
    window: { innerHeight: 900, innerWidth: 1200 },
    Math, Number, Boolean,
    document: { elementFromPoint: () => { throw new Error('detached'); } },
  };
  vm.createContext(ctx);
  vm.runInContext(helper, ctx);
  const row = makeNode('div', { top: 100, left: 10, right: 510, bottom: 180, width: 500, height: 80 });
  const chip = makeNode('span', { top: 130, left: 470, right: 498, bottom: 150, width: 28, height: 20 });
  assert.equal(
    ctx.rowAnchorHitsContent({ x: 500, y: 140 }, row.getBoundingClientRect(), row, { el: chip }),
    false,
    'a broken probe must degrade to the old behaviour, never wedge the sweep');
});

/* ---------------- F-60: the chip must not shadow its own probe ---------------- */

test('F-60: a chip painted over the MC still reads as a collision — elementsFromPoint looks THROUGH the chip', () => {
  // The chip is already painted at the float anchor (live ultra-format
  // switch, row recycle, late-mounting MC): the chip's own body tops the
  // hit-test at the probe point, with the MC text directly beneath it.
  // elementsFromPoint must be consulted and the chip skipped, so the sweep
  // sees the MC it is covering and drops the chip to the gutter.
  const mcText = makeNode('span', { top: 110, left: 420, right: 505, bottom: 130, width: 85, height: 20 });
  const chip = makeNode('span', { top: 130, left: 470, right: 498, bottom: 150, width: 28, height: 20 });
  const layer = makeNode('div', { top: 0, left: 0, right: 1200, bottom: 900, width: 1200, height: 900 });
  assert.equal(
    runHelper({ hit: chip, chip, stack: [chip, mcText, layer], rowChildren: [mcText] }),
    true,
    'the painted chip must not mask the MC underneath — that is the F-60 recurrence of the F-53 defect');
});

test('F-60: a chip over clean gutter stays clean — the stack below the chip is page background', () => {
  const chip = makeNode('span', { top: 130, left: 470, right: 498, bottom: 150, width: 28, height: 20 });
  const layer = makeNode('div', { top: 0, left: 0, right: 1200, bottom: 900, width: 1200, height: 900 });
  const foreign = makeNode('div', { top: 0, left: 0, right: 1200, bottom: 900, width: 1200, height: 900 });
  assert.equal(
    runHelper({ hit: chip, chip, stack: [chip, foreign, layer] }),
    false,
    'skipping the chip must not invent a collision where the page background sits');
});

test('F-60: no elementsFromPoint (older engines) — elementFromPoint hit on the chip degrades to clean', () => {
  // The legacy fallback keeps the pre-F-60 behaviour when the stack API is
  // missing: never wedge the sweep on an engine without elementsFromPoint.
  const chip = makeNode('span', { top: 130, left: 470, right: 498, bottom: 150, width: 28, height: 20 });
  assert.equal(runHelper({ hit: chip }), false,
    'without the stack API the chip self-hit still reads clean — the documented degradation');
});

test('F-60 source contract: the probe reads the stack and never writes styles', () => {
  const helper = extractHelper();
  assert.match(helper, /elementsFromPoint/,
    'the probe must read the hit-test stack so a painted chip cannot shadow it');
  assert.doesNotMatch(helper, /\.style\./,
    'READ-phase only: the probe must never write styles');
  assert.match(helper, /elementsFromPoint\(bodyX, bodyY\)/,
    'the stack read uses the same body-midpoint point as the top-hit read');
});

/* ---------------- the anchor drop is actually applied ---------------- */

test('F-53 source contract: both anchor modes consult the probe or the pin', () => {
  const measure = bridgeSrc.slice(
    bridgeSrc.indexOf('function positionRowChip('),
    bridgeSrc.indexOf('function applyRowChip('),
  );
  // float mode
  assert.match(measure, /anchor = \{ x: rect\.right - 6, y: rect\.top \+ 6, align: 'right-top' \};/);
  assert.match(measure, /rowAnchorHitsContent\(anchor, rect, row, entry\)/,
    'float mode must probe its top-right guess');
  // pill mode
  assert.match(measure, /rowAnchorHitsContent\(anchor, rect, row, entry, pr\)/,
    'the pill-anchored mode must probe the chip body midpoint too');
  // the pin
  assert.match(measure, /placementPref === 'bottom'/,
    "an explicit 'bottom' preference must skip the probe and pin the gutter");
  // probes must not write styles
  assert.doesNotMatch(measure.slice(measure.indexOf('function rowAnchorHitsContent')), /\.style\./);
});

test('F-53: the sweep reads placementPref from the row-scan spec', () => {
  assert.match(bridgeSrc, /spec\.placementPref === 'bottom' \|\| spec\.placementPref === 'auto'/,
    'only the two explicit values are honoured; anything else keeps site defaults');
});
