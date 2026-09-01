/* Order-line thickness + list buy-button placement settings (feedback batch
 * 2026-08-20: "." thicker order lines; jb quick-buy position/size).
 *
 * Source-contract style: the settings must exist with sane defaults, the
 * dashboard must render controls for both, and the save handler must read
 * them back into storage — the same layered pins quickbuy.test.js uses.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const E = require('../engine.js');

const ROOT = path.join(__dirname, '..');
const content = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
const dashJs = fs.readFileSync(path.join(ROOT, 'dashboard.js'), 'utf8');

/* ---------------- defaults ---------------- */

test('chartOrderLineThickness defaults to 2 and merges for old installs', () => {
  assert.equal(E.DEFAULT_SETTINGS.chartOrderLineThickness, 2,
    'new installs land on the historical 2px width');
  assert.equal(E.mergeSettings({}).chartOrderLineThickness, 2,
    'an install from before the setting exists must merge to the default, not undefined');
  // A deliberate thick choice is never overridden.
  assert.equal(E.mergeSettings({ chartOrderLineThickness: 4 }).chartOrderLineThickness, 4);
});

test('listQuickBuyPlacement defaults to auto and merge-persists explicit choice', () => {
  assert.equal(E.DEFAULT_SETTINGS.listQuickBuyPlacement, 'auto');
  assert.equal(E.mergeSettings({}).listQuickBuyPlacement, 'auto');
  assert.equal(E.mergeSettings({ listQuickBuyPlacement: 'bottom' }).listQuickBuyPlacement, 'bottom',
    'a user who pinned the corner keeps it');
});

/* ---------------- content plumbing ---------------- */

test('the paper-orders payload carries the clamped lineWidth', () => {
  assert.match(content, /lineWidth: orderLineWidth,/,
    'the bridge reads spec.lineWidth; content must send it');
  assert.match(content, /'\|' \+ chartAxisBasis \+ '\|' \+ orderLineWidth;/,
    'thickness rides the repost signature so a settings change redraws existing lines');
});

test('the row-scan payload carries placementPref only for explicit choices', () => {
  assert.match(content, /const globalPlacement = source\.listQuickBuyPlacement === 'bottom' \? 'bottom'/,
    "'bottom' must reach the bridge as a pin");
  assert.match(content, /const placementPref = siteOverride\.placement === 'bottom' \? 'bottom'/,
    'a valid per-site pin must take precedence over the global setting');
  assert.match(content, /: siteOverride\.placement === 'auto' \? 'auto' : globalPlacement;/,
    "anything unset must send null so per-site defaults survive");
});

/* ---------------- dashboard controls ---------------- */

test('the dashboard offers a thickness select and a placement select', () => {
  assert.match(dashJs, /id="set-chart-line-thickness"/,
    'thickness control must exist');
  assert.match(dashJs, /id="set-list-quick-buy-placement"/,
    'placement control must exist');
  assert.match(dashJs, /chartOrderLineThickness: Math\.max\(1, Math\.min\(4, Math\.round\(Number\(document\.getElementById\('set-chart-line-thickness'\)\.value\) \|\| 2\)\)\)/,
    'the save handler must clamp the thickness to 1..4');
  assert.match(dashJs, /listQuickBuyPlacement: document\.getElementById\('set-list-quick-buy-placement'\)\.value === 'bottom' \? 'bottom' : 'auto',/,
    'the save handler must persist the placement choice');
});
