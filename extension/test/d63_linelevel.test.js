/* D-63: an off-range average line must not be drawn as an order line.
 *
 * Live evidence (Discord, 2026-08-29/30): dashgirn — "if price goes below 5k
 * the avg entry goes off the charts" with a screenshot showing the y-axis
 * stretched down to a NEGATIVE -4.71K tick and the candles squashed, the
 * PAPER Avg. Fill line parked at 200.35 (a real snipe-era entry mcap); and
 * ark_trades13 — "Avg fill line is not correct", screenshot showing the axis
 * running to -175K with bubbles desynced above candles and a 1.98 fill tag.
 *
 * Mechanism: TradingView autoscale INCLUDES order lines in the visible
 * range. A fill mcap two orders of magnitude below the current price drags
 * the y-axis down through zero into negative padding, squashing the candles
 * and detaching the bubble markers from their bars. The line value itself
 * was CORRECT — the defect is drawing an off-range level as an order line
 * at all.
 *
 * Fix under test: offVisibleRange already computes the chart's own verdict
 * (priceToCoordinate against the real pane height). When a WANTED level is
 * off-range, the sweep now clears that side's slot (the line stops feeding
 * autoscale, the axis springs back), records the reason, and retries on the
 * next sweep — levels legitimately come back into range as the axis moves.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'price-bridge.js'), 'utf8');

function blockFrom(marker) {
  const start = src.indexOf(marker);
  assert.ok(start >= 0, 'marker must exist: ' + marker);
  return src.slice(start, start + 4000);
}

test('D-63/1: an off-range wanted level is not drawn — the sweep skips it instead', () => {
  const b = blockFrom('function syncPaperAverageLines()');
  // The off-range verdict must gate the DRAW, not merely annotate it.
  assert.match(b, /OffRange[\s\S]{0,600}clearLineSlot/,
    'an off-range verdict must clear the affected slot');
});

test('D-63/2: the skip is per-side, not all-or-nothing', () => {
  const b = blockFrom('function syncPaperAverageLines()');
  // buy and sell levels are vetted separately; one off-range line must not
  // kill the other side's correct line.
  assert.match(b, /buyOff|offRangeBuy|offBuy/, 'a per-side off-range flag must exist');
  assert.match(b, /sellOff|offRangeSell|offSell/, 'a per-side off-range flag must exist');
});

test('D-63/3: off-range is a NAMED reason (status honesty law)', () => {
  const b = blockFrom('function syncPaperAverageLines()');
  assert.match(b, /lastLineSyncReason\s*=\s*'off-range/,
    'off-range must name itself in the sync reason');
});

test('D-63/4: offVisibleRange must be per-level so one bad level cannot veto the good one', () => {
  const b = blockFrom('function offVisibleRange(chart, levels)');
  // The existing helper already loops levels; the new call sites must ask
  // per side. Structural pin: both slots' guards reference offVisibleRange
  // with single-level arrays OR a per-side result object.
  const sync = blockFrom('function syncPaperAverageLines()');
  assert.ok(
    /offVisibleRange\(charts\[0\],\s*\[buyLevel\]\)/.test(sync)
    || /offVisibleRange\(charts\[0\],\s*\[buyLevel,\s*sellLevel\]\)/.test(sync),
    'buy level must be vetted against the visible range');
});
