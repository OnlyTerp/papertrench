'use strict';
// D-37 lock: settings that must apply live actually do — focus mode and the
// sell ladder react to a settings write without a page reload.
//
// Gap (S4): the content-script storage listener re-applied theme, visibility,
// size, presets, and the positions bar, but NOT panelFocusMode (applied only
// inside renders) and NOT sellPcts (read only when the position card is
// built). Saving new sell presets in the dashboard left the open position's
// sell buttons stale until reload — the trader clicks 75% and gets the old
// ladder.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');

test('the settings listener applies focus mode live', () => {
  const i = src.indexOf('function watchStorage');
  const blk = src.slice(i, i + 2600);
  assert.ok(i >= 0, 'watchStorage must exist');
  assert.ok(
    /applyFocusMode\(\);/.test(blk),
    'the settingsChanged handler must call applyFocusMode() live'
  );
});

test('a changed sellPcts list forces exactly one position-card rebuild', () => {
  const i = src.indexOf('function watchStorage');
  const blk = src.slice(i, i + 2600);
  assert.ok(
    /oldValue\.sellPcts/.test(blk),
    'the handler must compare oldValue.sellPcts against the new settings'
  );
  assert.ok(
    /posEls = null;[\s\S]*?renderPosition\(\);/.test(blk),
    'a changed ladder must null posEls and re-render the position card'
  );
  // The rebuild path must go through buildPositionCard (the only place the
  // ladder is constructed) — pinned by renderPosition nulling posEls first.
  // NB: anchor with the open paren — "renderPosition" alone first matches
  // inside renderPositionsBar.
  const r = src.indexOf('function renderPosition(');
  const rblk = src.slice(r, r + 600);
  assert.ok(
    /if \(!posEls\) buildPositionCard\(pos \|\| null\);/.test(rblk),
    'renderPosition must rebuild via buildPositionCard when posEls is null'
  );
});

test('listQuickBuy keeps applying live (regression guard for the wider D-37 class)', () => {
  const i = src.indexOf('function watchStorage');
  const blk = src.slice(i, i + 2600);
  assert.ok(
    /publishPageState\(\);/.test(blk),
    'the handler must republish page state so list quick-buy chips follow the toggle live'
  );
});
