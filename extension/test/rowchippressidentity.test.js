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

function tapHarness({ href, address = 'MintSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS' } = {}) {
  const start = bridge.indexOf('const ROW_ADDR_RE');
  const end = bridge.indexOf("\n  for (const type of ['pointerdown'", start);
  assert.ok(start !== -1 && end > start, 'row-chip tap wiring must ship in the bridge');
  const emitted = [];
  const busy = [];
  const ctx = {
    Map,
    addressFromRowFiber: () => null,
    emit: (type, payload) => emitted.push({ type, payload }),
  };
  vm.createContext(ctx);
  vm.runInContext(`${bridge.slice(start, end)}
lastRowSpec = { linkSelectors: ['a'], containerMode: null };
this.rowChips = rowChips;
this.handleRowChipTap = handleRowChipTap;`, ctx);
  const row = {
    isConnected: true,
    matches: () => false,
    querySelector: () => href == null ? null : {
      getAttribute: () => href,
      href,
    },
  };
  const chip = {
    closest: () => chip,
    classList: { add: (name) => busy.push(name) },
  };
  const entry = {
    row,
    el: chip,
    address,
    verifiedAt: Date.now(),
  };
  ctx.rowChips.set(row, entry);
  const dispatch = (type, key, repeat = false) => {
    const event = {
      type,
      key,
      repeat,
      target: chip,
      preventDefault() { this.prevented = true; },
      stopPropagation() { this.propagated = true; },
      stopImmediatePropagation() { this.immediate = true; },
    };
    ctx.handleRowChipTap(event);
    return event;
  };
  return {
    entry,
    emitted,
    busy,
    setHref(next) { href = next; },
    key(key, repeat) { return dispatch('keydown', key, repeat); },
    click() { return dispatch('click'); },
  };
}

function entry(overrides = {}) {
  return {
    address: 'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    verifiedAt: 10_000,
    pressedAddress: 'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    pressedAt: 10_000,
    ...overrides,
  };
}

test('press and click identity wins over a differently-derived sweep address', () => {
  assert.deepEqual(
    { ...rowChipTapDecision(entry({
      address: 'MintBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      pressedAddress: 'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    }), 'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 10_500) },
    { address: 'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
  );
});

test('a recycled row refuses instead of buying the old coin', () => {
  const out = rowChipTapDecision(
    entry({ address: 'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }),
    'MintBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    10_500,
  );
  assert.deepEqual({ ...out.refuse }, {
    was: 'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    now: 'MintBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    swept: 'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    reason: 'row-changed',
  });
});

test('Enter activation binds and fills the focused chip identity', () => {
  const pressed = 'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const h = tapHarness({
    href: `/trade/${pressed}`,
    address: 'MintSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS',
  });
  const key = h.key('Enter');
  assert.equal(key.prevented, undefined, 'keyboard binding must not suppress native activation');
  h.click();
  assert.equal(h.emitted.length, 1);
  assert.equal(h.emitted[0].type, 'row-buy');
  assert.equal(h.emitted[0].payload.address, pressed);
  assert.deepEqual(h.busy, ['busy']);
});

test('Space activation binds and fills the focused chip identity', () => {
  const pressed = 'MintBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
  const h = tapHarness({
    href: `/trade/${pressed}`,
    address: 'MintSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS',
  });
  const key = h.key(' ');
  assert.equal(key.prevented, undefined, 'keyboard binding must not suppress native activation');
  h.click();
  assert.equal(h.emitted.length, 1);
  assert.equal(h.emitted[0].type, 'row-buy');
  assert.equal(h.emitted[0].payload.address, pressed);
  assert.deepEqual(h.busy, ['busy']);
});

test('a row recycled between keyboard press and activation refuses', () => {
  const pressed = 'MintCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
  const current = 'MintDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';
  const h = tapHarness({ href: `/trade/${pressed}` });
  h.key('Enter');
  h.setHref(`/trade/${current}`);
  h.click();
  assert.equal(h.emitted[0].type, 'row-buy-refused');
  assert.deepEqual({ ...h.emitted[0].payload }, {
    was: pressed,
    now: current,
    swept: 'MintSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS',
    reason: 'row-changed',
  });
  assert.deepEqual(h.busy, []);
});

test('a repeated Enter cannot rebind a recycled row', () => {
  const pressed = 'MintEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE';
  const current = 'MintFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF';
  const h = tapHarness({ href: `/trade/${pressed}` });
  h.key('Enter');
  h.setHref(`/trade/${current}`);
  h.key('Enter', true);
  h.click();
  assert.equal(h.emitted[0].type, 'row-buy-refused');
  assert.equal(h.emitted[0].payload.reason, 'row-changed');
  assert.equal(h.emitted[0].payload.was, pressed);
  assert.equal(h.emitted[0].payload.now, current);
  assert.deepEqual(h.busy, []);
});

test('an unreadable press refuses even when sweep verification is fresh', () => {
  const h = tapHarness({
    href: null,
    address: 'MintSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS',
  });
  h.key('Enter');
  h.click();
  assert.deepEqual({ ...h.emitted[0].payload }, {
    was: null,
    now: null,
    swept: 'MintSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSSS',
    reason: 'unverifiable',
  });
  assert.deepEqual(h.busy, []);
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
    swept: 'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    reason: 'unverifiable',
  });
});

test('a press older than five seconds refuses', () => {
  const out = rowChipTapDecision(entry(), 'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 15_001);
  assert.deepEqual({ ...out.refuse }, {
    was: 'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    now: 'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    swept: 'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    reason: 'stale-press',
  });
});

test('a second click without a new press is stale after the first decision', () => {
  const state = entry();
  assert.deepEqual(
    { ...rowChipTapDecision(state, state.pressedAddress, 10_500) },
    { address: state.pressedAddress },
  );
  state.pressedAt = 0;
  state.pressedAddress = null;
  const out = rowChipTapDecision(state, state.address, 10_501);
  assert.deepEqual({ ...out.refuse }, {
    was: null,
    now: state.address,
    swept: state.address,
    reason: 'stale-press',
  });
});

test('the bridge records current row identity on pointerdown', () => {
  assert.match(bridge, /entry\.pressedAddress = currentRowAddress\(entry\);/);
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

test('keyboard activation records identity without swallowing native click', () => {
  assert.match(bridge, /if \(ev\.type === 'keydown'\) \{[\s\S]{0,420}entry\.pressedAddress = currentRowAddress\(entry\);[\s\S]{0,180}return;/);
  assert.match(bridge, /if \(ev\.repeat \|\| \(ev\.key !== 'Enter' && ev\.key !== ' ' && ev\.key !== 'Spacebar'\)\) return;/);
  assert.match(bridge, /'click', 'keydown'\]/);
  const start = bridge.indexOf("if (ev.type === 'keydown')");
  const end = bridge.indexOf("\n    if (ev.type === 'pointerdown')", start);
  assert.doesNotMatch(bridge.slice(start, end), /preventDefault|stopPropagation|stopImmediatePropagation/);
});

test('a refusal emits no busy state and uses the refusal bridge message', () => {
  const start = bridge.indexOf("if (ev.type !== 'click') return;");
  const end = bridge.indexOf('\n    }\n  }\n  for (const type', start);
  const click = bridge.slice(start, end);
  assert.match(click, /const decision = rowChipTapDecision\(entry, currentRowAddress\(entry\), Date\.now\(\)\)/);
  assert.match(click, /entry\.pressedAt = 0;\s*\n\s*entry\.pressedAddress = null;/,
    'every click decision must consume the press authorization');
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
  assert.match(refusal, /swept: p\.swept \|\| null/);
  assert.match(refusal, /reason: p\.reason \|\| null/);
  assert.doesNotMatch(refusal, /sendPadreMarker\('row-buy-done'/,
    'a refusal never entered the busy state');
});
