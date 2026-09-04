/* Modes pane (popup): one switch per mode.
 *
 * The popup used to expose the Speed mode's three internals (warm X links,
 * warm terminal links, X-Ray) as three off-by-default buttons, next to two
 * different kinds of "off". docs/UI-OVERHAUL.md's north star is "three
 * personas, three products, one binary" — so the pane is three cards, one
 * switch each: Turbo (speed), Paper (the master switch), Gaming. These pins
 * are about the SEMANTICS of the Turbo switch over its three stored keys,
 * which the dashboard still tunes individually:
 *   - all off  -> tap -> all on
 *   - mixed    -> tap -> all on   (rounds UP; a partial Turbo is never "off")
 *   - all on   -> tap -> all off
 *   - the master switch and every other setting are untouched by the flip
 *   - the receipts render on the card only when there is something to say
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function loadPopup(settings, turboStats) {
  const stored = new Map();
  if (settings !== undefined) stored.set('pt_settings', settings);
  if (turboStats !== undefined) stored.set('pt_turbo_stats', turboStats);
  const listeners = new Map();
  const els = {};
  function makeEl(id) {
    const attrs = {};
    const el = {
      id, children: [], hidden: true, innerHTML: '', textContent: '', title: '', style: {},
      className: '',
      classList: { toggle() {}, add() {}, remove() {} },
      addEventListener: (t, fn) => { listeners.set(id + ':' + t, fn); },
      appendChild(child) { this.children.push(child); this.textContent += (child.textContent || ''); },
      setAttribute(k, v) { attrs[k] = String(v); },
      getAttribute(k) { return attrs[k]; },
      click() {}, remove() {},
    };
    return el;
  }
  const document = {
    getElementById: (id) => (els[id] || (els[id] = makeEl(id))),
    createElement: (tag) => makeEl('el-' + tag),
    createTextNode: (t) => ({ textContent: t }),
    querySelectorAll: () => [],
    body: { appendChild() {} },
  };
  const sandbox = {
    document, console, setTimeout, Date, Number, String, JSON, Math,
    fetch: async () => ({ ok: false }),
    chrome: {
      storage: { local: {
        get: async (keys) => { const out = {}; for (const k of keys) if (stored.has(k)) out[k] = stored.get(k); return out; },
        set: async (obj) => { for (const [k, v] of Object.entries(obj)) stored.set(k, v); },
      } },
      tabs: { create: async () => ({}) },
      runtime: { getManifest: () => ({ version: '0.0.0' }), openOptionsPage() {}, sendMessage: () => ({ catch() {} }) },
    },
    Blob: class Blob {}, URL: { createObjectURL: () => '', revokeObjectURL() {} },
    PTAttest: {
      readChainMeta: async () => ({ segCount: 0, length: 0, head: 'papertrench-genesis-v1' }),
      readChainStore: async () => ({ meta: { segCount: 0, length: 0, head: 'papertrench-genesis-v1' }, chain: [] }),
    },
  };
  sandbox.window = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'popup.js'), 'utf8'), ctx, { filename: 'popup.js' });
  const settle = () => new Promise((r) => setTimeout(r, 5));
  const click = async (id) => { await listeners.get(id + ':click')(); await settle(); };
  return { els, stored, click, settle, settings: () => stored.get('pt_settings') };
}

const KEYS = ['warmXLinksEnabled', 'warmEverywhereEnabled', 'warmSameSiteEnabled', 'xrayEnabled'];

test('Turbo off -> tap -> every speed key on; master switch untouched', async () => {
  const p = loadPopup({ appEnabled: true, warmXLinksEnabled: false, warmEverywhereEnabled: false, xrayEnabled: false, feeBps: 42 });
  await p.settle();
  assert.equal(p.els.turbo.getAttribute('aria-pressed'), 'false');
  await p.click('turbo');
  for (const k of KEYS) assert.equal(p.settings()[k], true, `${k} must be on`);
  assert.equal(p.settings().appEnabled, true, 'the flip never touches the master switch');
  assert.equal(p.settings().feeBps, 42, 'the flip spreads existing settings');
  assert.equal(p.els.turbo.getAttribute('aria-pressed'), 'true');
  assert.equal(p.els.badge.textContent, 'PAPER ⚡', 'the header badge shows Turbo');
});

test('a partial Turbo (dashboard-set) shows as mixed and rounds UP on tap', async () => {
  const p = loadPopup({ warmXLinksEnabled: true, warmEverywhereEnabled: false, xrayEnabled: false });
  await p.settle();
  assert.equal(p.els.turbo.getAttribute('aria-pressed'), 'mixed');
  assert.match(p.els['turbo-sub'].textContent, /Partly on/);
  await p.click('turbo');
  for (const k of KEYS) assert.equal(p.settings()[k], true, `${k} must be on`);
});

test('Turbo on -> tap -> every speed key off, and the status says what is released', async () => {
  const p = loadPopup({ warmXLinksEnabled: true, warmEverywhereEnabled: true, warmSameSiteEnabled: true, xrayEnabled: true });
  await p.settle();
  await p.click('turbo');
  for (const k of KEYS) assert.equal(p.settings()[k], false, `${k} must be off`);
  assert.match(p.els.status.textContent, /viewer tab is released/);
  assert.match(p.els.status.textContent, /nothing further is read from X pages/);
});

test('the Turbo opt-in status keeps the honest-cost disclosure', async () => {
  const p = loadPopup({});
  await p.settle();
  await p.click('turbo');
  const s = p.els.status.textContent;
  assert.match(s, /muted, in the background/, 'the hidden viewer tabs are disclosed at opt-in');
  assert.match(s, /X page's own data on this device/, 'what X-Ray reads is disclosed at opt-in');
  assert.match(s, /Ctrl\/Cmd\/middle-click still opens normal tabs/, 'the escape hatch is stated');
});

test('Gaming is its own switch over gamingModeEnabled only', async () => {
  const p = loadPopup({ gamingModeEnabled: false, warmXLinksEnabled: true });
  await p.settle();
  assert.equal(p.els.gaming.getAttribute('aria-pressed'), 'false');
  await p.click('gaming');
  assert.equal(p.settings().gamingModeEnabled, true);
  assert.equal(p.settings().warmXLinksEnabled, true, 'other modes untouched');
  assert.equal(p.els.gaming.getAttribute('aria-pressed'), 'true');
});

test('the Paper switch is the master switch, reflected as pressed state', async () => {
  const p = loadPopup({ appEnabled: false });
  await p.settle();
  assert.equal(p.els.power.getAttribute('aria-pressed'), 'false');
  assert.equal(p.els.badge.textContent, 'OFF');
  assert.match(p.els['paper-sub'].textContent, /wallet, journal and settings kept/);
  await p.click('power');
  assert.equal(p.settings().appEnabled, true);
  assert.equal(p.els.power.getAttribute('aria-pressed'), 'true');
});

test('receipts live on the Turbo card and stay hidden until there is a count', async () => {
  const quiet = loadPopup({}, {});
  await quiet.settle();
  assert.equal(quiet.els['turbo-receipts'].hidden, true);

  const p = loadPopup({}, { 'x:spa': { count: 3, ring: [9, 12, 30] }, 'dest:cold_tab': { count: 1, ring: [] } });
  await p.settle();
  const el = p.els['turbo-receipts'];
  assert.equal(el.hidden, false);
  assert.match(el.textContent, /3 warm opens/);
  assert.match(el.textContent, /1 cold/);
  assert.match(el.textContent, /median routing 12ms/);
  assert.match(el.title, /never sent anywhere/);
});

test('the pane is three mode cards with one switch each, plus tools — no toggle buttons', () => {
  const html = fs.readFileSync(path.join(ROOT, 'popup.html'), 'utf8');
  const pane = html.slice(html.indexOf('id="pane-features"'), html.indexOf('id="pane-setup"'));
  for (const id of ['turbo', 'power', 'gaming']) {
    assert.equal(pane.split(`id="${id}"`).length - 1, 1, `${id} switch present once`);
  }
  assert.equal((pane.match(/class="mode-hit"/g) || []).length, 3, 'exactly three mode switches');
  assert.doesNotMatch(pane, /Instant X links|Instant terminal links|X-Ray on x\.com/, 'the three internals are no longer separate buttons');
  assert.match(pane, /id="turbo-receipts"/, 'receipts sit inside the Turbo card');
  assert.ok(pane.indexOf('id="turbo-receipts"') < pane.indexOf('id="mode-paper"'), '...inside the Turbo card, not after it');
});
