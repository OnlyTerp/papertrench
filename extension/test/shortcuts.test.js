/* Keyboard shortcuts.
 *
 * Requested with an explicit limit: "make sure it's changeable in the settings
 * and only give a couple options in a dropdown so it doesn't affect the tab
 * like closing or opening new tabs with commands."
 *
 * So the tests that matter are the ones about what these keys must NEVER do.
 * They run on other people's trading pages, inside a document the user is also
 * typing into, and a keystroke that fires an order fires one by accident.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const content = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
const dashJs = fs.readFileSync(path.join(ROOT, 'dashboard.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

function handler() {
  const start = content.indexOf('function onShortcutKey(');
  assert.ok(start !== -1, 'onShortcutKey must exist');
  const end = content.indexOf('\n  }', start);
  return content.slice(start, end + 4);
}

test('shortcuts are in-page, not Chrome commands', () => {
  // A manifest `commands` entry is configured at chrome://extensions/shortcuts,
  // not in our settings, and cannot be limited to acting only on the page —
  // which is exactly the control that was asked for.
  assert.ok(!manifest.commands,
    'no manifest commands block: these must stay page-local and settings-controlled');
});

test('no shortcut can open, close or navigate a tab', () => {
  const fn = handler();
  for (const banned of ['chrome.tabs', 'window.open', 'location.href', 'location.assign', 'target="_blank"']) {
    assert.ok(!fn.includes(banned), `a shortcut must never reach for ${banned}`);
  }
});

test('no shortcut can place an order', () => {
  // The whole point of paper trading is that mistakes are cheap, but an
  // accidental fill still corrupts the journal it teaches from.
  const fn = handler();
  for (const banned of ['requestBuy', 'doBuy', 'doSell', 'requestSell']) {
    assert.ok(!fn.includes(banned), `a shortcut must never call ${banned}`);
  }
});

test('shortcuts are off until the user picks a scheme', () => {
  const fn = handler();
  assert.match(fn, /SHORTCUT_SCHEMES\[settings && settings\.shortcutScheme\]/,
    'the active scheme comes from settings');
  assert.match(fn, /if \(!test\b/, 'an unset or unknown scheme must disable them entirely');
  // 'off' is not a scheme, so the lookup misses and nothing binds.
  const table = content.slice(content.indexOf('const SHORTCUT_SCHEMES'), content.indexOf('function onShortcutKey('));
  assert.ok(!/\boff\s*:/.test(table), "'off' must not be a scheme — it is the absence of one");
});

test('keys are ignored while the user is typing', () => {
  const fn = handler();
  assert.match(fn, /INPUT\|TEXTAREA\|SELECT/, 'form fields must keep their keys');
  assert.match(fn, /isContentEditable/, 'and so must rich-text editors');
  assert.match(fn, /composedPath/,
    'the real target must be read through the shadow boundary, not the retarget');
});

test('the master switch and a disabled overlay both silence them', () => {
  const fn = handler();
  assert.match(fn, /masterOff/, 'the app-wide off switch outranks shortcuts');
  assert.match(fn, /overlayEnabled === false/, 'a hidden panel has nothing to toggle');
});

test('an unhandled combination is left for the site', () => {
  const fn = handler();
  const prevent = fn.indexOf('event.preventDefault()');
  const bail = fn.indexOf('} else return;');
  assert.ok(bail !== -1 && bail < prevent,
    'unrecognised keys must return BEFORE the event is claimed');
});

test('the settings dropdown offers exactly the schemes the page implements', () => {
  const table = content.slice(content.indexOf('const SHORTCUT_SCHEMES'), content.indexOf('function onShortcutKey('));
  const implemented = [...table.matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1]);
  const select = dashJs.slice(dashJs.indexOf('<select id="set-shortcuts">'), dashJs.indexOf('</select>', dashJs.indexOf('<select id="set-shortcuts">')));
  const offered = [...select.matchAll(/value="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(offered, ['off', ...implemented],
    'the dropdown and the implementation must not drift apart');
  assert.ok(offered.length <= 3, 'the request was for a couple of options, not a rebinding UI');
});

test('the saved scheme is validated against that same closed set', () => {
  assert.match(dashJs, /\['off', 'alt', 'ctrlshift'\]\.includes\(/,
    'an unrecognised value would disable shortcuts silently rather than refuse');
});
