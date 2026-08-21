/* N1 — the update-notice channel. Unpacked extensions never auto-update;
 * three users asked publicly how to update (Discord 8/21). The SW polls the
 * GitHub releases feed (opt-out), stores pt_update_notice, and both the
 * dashboard and the chart page surface it. */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

const ROOT = path.resolve(import.meta.dirname, '..');
const bg = readFileSync(path.join(ROOT, 'background.js'), 'utf8');
const dash = readFileSync(path.join(ROOT, 'dashboard.js'), 'utf8');
const content = readFileSync(path.join(ROOT, 'content.js'), 'utf8');
const manifest = JSON.parse(readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

test('the SW polls the releases feed on install and twice daily', () => {
  assert.match(bg, /runUpdateCheck\(\)\.catch\(\(\) => \{\}\);/,
    'the check runs on install/update (directly — a self-rescheduling timer would hold unit-harness processes open forever; that hung CI)');
  assert.ok(!/scheduleUpdateCheck/.test(bg), 'no timer chain re-scheduling the check');
  assert.match(bg, /chrome\.alarms\.create\('pt_update_check', \{ periodInMinutes: 360 \}\)/,
    'an alarm wakes a sleeping SW twice a day');
  assert.match(bg, /api\.github\.com\/repos\/OnlyTerp\/papertrench\/releases\/latest/,
    'the feed is the repo’s own releases endpoint');
  assert.ok(manifest.permissions.includes('alarms'),
    'the alarms permission backs the wake-up');
});

test('the notice never nags on failure and honors the opt-out instantly', () => {
  assert.match(bg, /if \(!rel\) return; \/\/ network\/refusal\/down — silent; never nag on failure/,
    'a failed fetch writes nothing');
  assert.match(bg, /settings\.updateCheckEnabled === false/,
    'the opt-out kills the check and clears any standing notice');
  assert.match(bg, /chrome\.storage\.local\.remove\('pt_update_notice'\)/,
    'opting out removes an existing notice');
});

test('version comparison is segment-wise, not string equality', () => {
  assert.match(bg, /function isNewerVersion\(latest, current\)/);
  // 3.10.0 > 3.9.17 must be TRUE (string compare would say '3.10' < '3.9').
  const start = bg.indexOf('function isNewerVersion');
  const open = bg.indexOf('{', start);
  let depth = 0, end = -1;
  for (let i = open; i < bg.length; i += 1) {
    if (bg[i] === '{') depth += 1;
    else if (bg[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end > 0, 'function body found');
  const fnSrc = bg.slice(open + 1, end);
  const isNewer = new Function('latest', 'current', fnSrc);
  assert.equal(isNewer('3.10.0', '3.9.17'), true, '3.10.0 beats 3.9.17');
  assert.equal(isNewer('3.9.17', '3.9.17'), false, 'same version is not newer');
  assert.equal(isNewer('3.9.16', '3.9.17'), false, 'older is not newer');
});

test('the dashboard leads with the banner when a newer release exists', () => {
  assert.match(dash, /async function renderUpdateBanner\(\)/);
  assert.match(dash, /chrome\.storage\.local\.get\('pt_update_notice'\)/);
  assert.match(dash, /Unpacked extensions never auto-update/,
    'the banner explains WHY it is telling the user');
});

test('the chart page says it once per page session, not per token', () => {
  assert.match(content, /let updateNoticeShown = false;/,
    'a session latch exists');
  assert.match(content, /async function notifyUpdateOnce\(\)/);
  assert.match(content, /if \(updateNoticeShown\) return;/,
    'the latch short-circuits repeat calls');
  assert.match(content, /notifyUpdateOnce\(\)\.catch\(\(\) => \{\}\);/,
    'init fires it fire-and-forget');
});
