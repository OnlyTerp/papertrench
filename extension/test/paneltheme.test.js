/* Panel themes (ark_trades13, 8/17: "on Lute can you change the main theme
 * of the page?"). Source-contract style per chartlinesettings.test.js:
 * themes exist, tokens only (never a site-page touch), the dashboard exposes
 * the picker, the save handler persists it, and the live switch is an
 * attribute set — no remount, no flicker.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const E = require('../engine.js');

const ROOT = path.join(__dirname, '..');
const content = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
const dashJs = fs.readFileSync(path.join(ROOT, 'dashboard.js'), 'utf8');

/* ---------------- theme definitions ---------------- */

test('three themes ship: trench (default), lute, solana', () => {
  assert.match(content, /const THEMES = \{/, 'theme table exists');
  assert.match(content, /trench: null/, 'trench is the null default');
  for (const name of ['lute', 'solana']) {
    assert.match(content, new RegExp(`${name}: \\{`), `theme ${name} exists`);
  }
});

test('themes override tokens only — never a document.body or page style touch', () => {
  // Extract the THEMES block and verify every override is a --pt-* token.
  const start = content.indexOf('const THEMES = {');
  const end = content.indexOf('function themeCss');
  assert.ok(start > -1 && end > start, 'THEMES block found');
  const block = content.slice(start, end);
  const props = [...block.matchAll(/^\s+'(--pt-[a-z0-9-]+)':/gm)].map((m) => m[1]);
  assert.ok(props.length >= 20, `expected >=20 token overrides, found ${props.length}`);
  for (const p of props) assert.match(p, /^--pt-/, `override ${p} is a --pt-* token`);
  // The dangerous thing would be a theme touching the host page.
  assert.doesNotMatch(block, /document\.body|documentElement|insertRule|styleSheets/,
    'themes must never touch the host page');
});

test('every token override value is a plausible color', () => {
  const start = content.indexOf('const THEMES = {');
  const end = content.indexOf('function themeCss');
  const block = content.slice(start, end);
  const vals = [...block.matchAll(/'--pt-[a-z0-9-]+':\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(vals.length >= 20);
  const hex = /^#[0-9a-fA-F]{6}$/;
  const rgba = /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\)$/;
  // U5 skins: the panel rim is a gradient token (--pt-rim) — every channel
  // inside it must still be a validated rgba() color, but the wrapper is a
  // linear-gradient, not a flat color.
  const grad = /^linear-gradient\([\s\S]*\)$/;
  for (const v of vals) {
    assert.ok(hex.test(v) || rgba.test(v) || (grad.test(v) && !/[;'`]}{]/.test(v) && /rgba?\(/.test(v)),
      `value "${v.slice(0, 60)}" is a #rrggbb, rgba() color, or rgba-only gradient`);
    if (rgba.test(v) || grad.test(v)) {
      const parts = (v.match(/rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}/g) || [])
        .join(',').match(/\d{1,3}/g).map(Number);
      for (const n of parts) assert.ok(n <= 255, `rgba channel ${n} in "${v.slice(0, 60)}" <= 255`);
    }
  }
});

test('themeCss emits attribute-gated :host blocks for each non-default theme', () => {
  assert.match(content, /:host\(\[data-pt-theme="\$\{name\}"\]\)/,
    'overrides are gated on the host attribute');
  assert.match(content, /<style>\$\{CSS\}\$\{themeCss\(\)\}<\/style>/,
    'theme css rides the single shadow style tag');
});

test('applyTheme falls back to trench for unknown names and never throws', () => {
  assert.match(content, /const theme = THEMES\[name\] \? name : 'trench';/,
    'unknown theme names fall back to the default');
  assert.match(content, /if \(host\) host\.setAttribute\('data-pt-theme', theme\);/,
    'live switch is an attribute set on the existing host');
});

/* ---------------- settings + dashboard ---------------- */

test('panelTheme persists through mergeSettings for old and new installs', () => {
  assert.equal(E.mergeSettings({}).panelTheme, undefined,
    'old installs keep the default (trench) — no forced re-choose');
  assert.equal(E.mergeSettings({ panelTheme: 'lute' }).panelTheme, 'lute',
    'an explicit choice survives the merge');
});

test('the dashboard offers the theme picker and the save handler persists it', () => {
  assert.match(dashJs, /id="set-panel-theme"/, 'picker exists');
  assert.match(dashJs, /panelTheme: document\.getElementById\('set-panel-theme'\)\.value,/,
    'save handler reads the picker');
});

test('watchStorage re-applies the theme on every settings write', () => {
  assert.match(content, /applyTheme\(settings\.panelTheme\);/,
    'settings writes flow into the live theme switch');
});
