/* U6 (2026-08-22): Lute Instant-links parity + the dashboard bugs the live
 * gate surfaced.
 *
 * Terp: "instant link loading needs to be setup for lute also, i think we
 * jsu forgot to ad that feature for the site". Recon: Lute HAS had full
 * warm-dest parity since 83d1005 (8/6). What was actually missing:
 *   1. the "Instant terminal links" toggle copy enumerated 9 terminals and
 *      omitted Lute — the feature READ as missing. This pins the copy to
 *      the REAL registry so it can never silently drop a terminal again.
 *   2. The live gate's sw.jsonl exposed a pre-existing init crash:
 *      renderSidebar (and openSeasonShareCard) referenced a bare `G` that
 *      no scope ever defined — ReferenceError at dashboard init, sidebar
 *      KPIs dead on load since 5818010 (8/20).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const dash = fs.readFileSync(path.join(ROOT, 'dashboard.js'), 'utf8');
const bg = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');

test('every function that uses G defines it first (no bare-G ReferenceErrors)', () => {
  // Re-derive the failure mode the live gate caught: any function-scoped
  // block using `G.` without a binding in the same function throws at
  // runtime. The template usages (`${G && ...}`) throw at build time.
  const funcs = dash.split(/\n(?=(?:async )?function )/);
  const offenders = [];
  for (const f of funcs) {
    const m = f.match(/^(?:async )?function (\w+)/);
    if (!m) continue;
    const uses = (f.match(/\bG\./g) || []).length;
    const defs = (f.match(/\b(?:const|let|var) G\b/g) || []).length;
    if (uses > 0 && defs === 0) offenders.push(`${m[1]} (${uses} uses)`);
  }
  assert.deepEqual(offenders, [], `functions referencing bare G without a binding: ${offenders.join(', ')}`);
});

test('renderSidebar and openSeasonShareCard bind PTGamify explicitly', () => {
  for (const name of ['renderSidebar', 'openSeasonShareCard']) {
    const start = dash.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `${name} exists`);
    const end = dash.indexOf('\nfunction ', start + 1);
    const body = dash.slice(start, end > 0 ? end : undefined);
    assert.match(body, /const G = window\.PTGamify;/, `${name} binds G = window.PTGamify`);
  }
});

test('the Instant-terminal-links copy names every registry family', () => {
  // The real list comes from WARM_DEST_FAMILIES in background.js; the copy
  // must name each one so the feature never reads as missing for a site.
  const famBlock = bg.slice(bg.indexOf('const WARM_DEST_FAMILIES = {'), bg.indexOf('function readWarmDestTab'));
  const families = [...famBlock.matchAll(/^\s{2}(\w+):\s*\{/gm)].map((m) => m[1]);
  assert.ok(families.length >= 10, `registry parsed (${families.join(', ')})`);

  const copyStart = dash.indexOf('id="set-warm-everywhere"');
  assert.ok(copyStart >= 0, 'the Instant terminal links toggle exists');
  const copy = dash.slice(copyStart, copyStart + 1200);
  // pumpfun reads "pump.fun" and solscan reads "Solscan" in the copy; the
  // rest are single words. Map registry ids to the labels users see.
  const labelFor = { pumpfun: 'pump.fun', solscan: 'Solscan', jupiter: 'Jupiter' };
  const missing = families.filter((f) => {
    const label = labelFor[f] || f.charAt(0).toUpperCase() + f.slice(1);
    return !new RegExp(`\\b${label}\\b`, 'i').test(copy);
  });
  assert.deepEqual(missing, [], `toggle copy omits: ${missing.join(', ')}`);
});

test('lute is a full warm-dest family (regression pin for the parity claim)', () => {
  const famBlock = bg.slice(bg.indexOf('const WARM_DEST_FAMILIES = {'), bg.indexOf('function readWarmDestTab'));
  assert.match(famBlock, /lute:\s*\{[^}]*storageKey: 'pt_warm_tab_lute'/,
    'lute family registered with its own viewer storage');
  assert.ok(famBlock.includes('lute\\.gg$/'), 'lute host gate anchors on lute.gg');
});
