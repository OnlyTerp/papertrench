'use strict';
// Side-panel desk (DELIGHT-MAP.md D1) — contract tests for the chrome
// half. The desk's DATA assembly is behaviour-tested in paneldata.test.js
// against the real modules; this file pins the wiring contracts: the
// manifest declares the side panel, the popup can open it, the panel
// page loads the real modules, and PERMISSIONS.md justifies the
// permission (the permissionsdoc test covers the table row; here we pin
// that the row's claims match what the code actually does).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const EXT = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
const panelHtml = fs.readFileSync(path.join(EXT, 'panel.html'), 'utf8');
const panelJs = fs.readFileSync(path.join(EXT, 'panel.js'), 'utf8');
const popupJs = fs.readFileSync(path.join(EXT, 'popup.js'), 'utf8');
const popupHtml = fs.readFileSync(path.join(EXT, 'popup.html'), 'utf8');
const permissionsMd = fs.readFileSync(path.join(EXT, '..', 'docs', 'PERMISSIONS.md'), 'utf8');

test('manifest declares the sidePanel permission and default panel path', () => {
  assert.ok(manifest.permissions.includes('sidePanel'),
    'sidePanel permission missing — chrome.sidePanel.* would throw');
  assert.equal(manifest.side_panel && manifest.side_panel.default_path, 'panel.html',
    'side_panel.default_path must point at panel.html');
});

test('panel.html loads the real modules it renders through', () => {
  assert.match(panelHtml, /<script src="gamify\.js"><\/script>/);
  assert.match(panelHtml, /<script src="panel-data\.js"><\/script>/);
  assert.match(panelHtml, /<script src="panel\.js"><\/script>/);
  assert.ok(panelHtml.indexOf('gamify.js') < panelHtml.indexOf('panel.js'),
    'gamify must load before panel.js uses it');
});

test('panel.js renders through the pure PTPanel module — no inline streak math', () => {
  assert.match(panelJs, /PTPanel\.deskModel\(/,
    'must assemble via the real deskModel');
  assert.doesNotMatch(panelJs, /rounds\.filter|reduced\.|\.reduce\(/,
    'desk assembly belongs in panel-data.js, not the chrome half');
});

test('panel.js reads ONLY local chrome storage and rides storage change events', () => {
  assert.match(panelJs, /chrome\.storage\.local\.get\(\['pt_state'\]\)/);
  assert.match(panelJs, /chrome\.storage\.onChanged\.addListener/);
  assert.doesNotMatch(panelJs, /chrome\.tabs|chrome\.scripting|fetch\(/,
    'the desk is a read-only projection — no tabs, no injection, no network');
});

test('popup offers the desk behind a user-gesture sidePanel.open', () => {
  assert.match(popupHtml, /id="desk"/, 'popup button missing');
  assert.match(popupJs, /chrome\.sidePanel\.open\(\{ windowId/,
    'sidePanel.open must be called with a windowId');
  // setOptions keeps the default path pinned for this window.
  assert.match(popupJs, /sidePanel\.setOptions\(\{ path: 'panel\.html'/);
});

test('PERMISSIONS.md row claims match the panel implementation', () => {
  assert.match(permissionsMd, /`sidePanel` \| Shows the docked PaperTrench desk \(panel\.html\)/,
    'sidePanel row missing from the permissions table');
  // The row promises no network and no content scripts — enforce it.
  assert.doesNotMatch(panelJs, /fetch\(|XMLHttpRequest/,
    'PERMISSIONS.md promises no network calls from the panel');
  assert.equal((panelHtml.match(/<script src=/g) || []).length, 3,
    'PERMISSIONS.md names the desk scripts; panel.html must load exactly those');
});
