'use strict';
// D-31 lock: the equity canvas must never be painted from a hidden section,
// and must be repainted when the section is revealed.
//
// Bug (S3): after a wallet reset from Settings, renderSection('overview')
// rendered into a display:none container, so cvs.clientWidth was 0 and the
// canvas fell back to a 760×260 backing store. When the trader later
// navigated to Overview, the identical-markup guard skipped rebindSection —
// no redraw ever happened — and the wrongly-sized bitmap stayed on screen.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'dashboard.js'), 'utf8');

test('drawEquityCurve refuses to paint a hidden canvas (zero client box)', () => {
  // The fallback constants were the carrier of the bug: a hidden canvas
  // was "sized" to 760×260 and painted anyway. The guard replaces them.
  assert.ok(
    /if\s*\(!cvs\.clientWidth\s*\|\|\s*!cvs\.clientHeight\)\s*return;/.test(src),
    'drawEquityCurve must bail when the canvas box is zero (section hidden)'
  );
  assert.ok(
    !/clientWidth\s*\|\|\s*760/.test(src),
    'the 760 fallback must be gone — it painted hidden canvases at the wrong size'
  );
  assert.ok(
    !/clientHeight\s*\|\|\s*260/.test(src),
    'the 260 fallback must be gone'
  );
});

test('navigating to overview repaints the equity curve even if markup is identical', () => {
  // The reveal-time redraw is the second half of the fix: even when
  // renderSection would early-out on identical markup, the canvas gets a
  // fresh draw at true layout size.
  const nav = src.slice(src.indexOf('currentSection = b.dataset.section'));
  const block = nav.slice(0, nav.indexOf('renderSection(currentSection);'));
  assert.ok(
    /drawEquityCurve\(\)/.test(block),
    'the nav handler must call drawEquityCurve() before renderSection when revealing overview'
  );
});

test('the post-reset path keeps rendering overview (hidden draw now safely skipped)', () => {
  // The reset handler still forces the fresh wallet onto the overview
  // section; with the guard, that render no longer poisons the bitmap.
  const reset = src.slice(src.indexOf("getElementById('reset-all')"));
  const block = reset.slice(0, 4000);
  assert.ok(
    /renderSection\('overview'\)/.test(block),
    'reset must still land the trader on the overview section'
  );
});
