/* Tests for the perps chart producer (perps-chart.js).
 *
 * The drawing itself lives in price-bridge.js and is shared with spot. What
 * is tested here is the seam: that a perps fill is described to the bridge in
 * the ONE unit a perp actually has (absolute USD), that a fill draws once and
 * only once, and that the two lines are the two numbers that matter — entry
 * and liquidation.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

global.window = global.window || {};
require('../perps-venues.js');
require('../perps.js');
require('../perps-chart.js');
const P = global.window.PaperPerps;
const C = global.window.PaperPerpsChart;

const HL = { maxLeverage: 20 };
const CLOSE = 1e-9;

/* Capture what the producer posts, the way the bridge would receive it. */
function captureMessages(fn) {
  const sent = [];
  const prior = global.window.postMessage;
  global.window.postMessage = (msg) => sent.push(msg);
  try { fn(); } finally { global.window.postMessage = prior; }
  return sent;
}

/* Each fixture is a genuinely DIFFERENT fill (its own timestamp, hence its
 * own id), and the producer's dedupe memory is reset between them — the
 * "one fill, one bubble" rule is what the dedupe test exercises on purpose,
 * so it must not leak into the others by accident. */
let fixtureClock = 1_700_000_000;
function bookWithFill() {
  captureMessages(() => C.clearChart());
  fixtureClock += 3600;
  const s = P.defaultPerpsState({ perpsStartUsd: 1000 });
  const r = P.openPerp(s, {
    venue: 'hyperliquid', market: 'SOL', side: 'long',
    marginUsd: 10, leverage: 20, price: 100, t: fixtureClock, params: HL,
  });
  return { state: s, id: r.id, pos: r.position };
}

test('the producer installs its API and posts under the content source tag', () => {
  assert.equal(typeof C.syncChart, 'function');
  const { state } = bookWithFill();
  const sent = captureMessages(() => C.syncChart({ state, venue: 'hyperliquid', market: 'SOL', px: 100 }));
  assert.ok(sent.length > 0, 'something must be posted');
  for (const m of sent) {
    assert.equal(m.source, 'papertrench-content', 'the bridge only listens to its own tag');
  }
});

test('a perps fill is quoted in absolute USD, never in SOL or market cap', () => {
  // The memecoin unit machinery exists because price and cap sit ~14 orders
  // of magnitude apart. A perp axis is USD and only USD; borrowing that
  // guesswork is how a marker lands 150x off its candle.
  const { state } = bookWithFill();
  const sent = captureMessages(() => C.syncChart({ state, venue: 'hyperliquid', market: 'SOL', px: 100 }));
  const markers = sent.filter((m) => m.type === 'paper-marker');
  assert.equal(markers.length, 1, 'the open fill draws one marker');
  const p = markers[0].payload;
  assert.equal(p.quote, 'usd-abs', 'the payload must declare its unit');
  assert.ok(Math.abs(p.priceUsd - 100) < CLOSE, 'at the USD fill price');
  assert.equal(p.priceNative, undefined, 'a perp has no SOL price to claim');
  assert.equal(p.mcap, undefined, 'and no market cap');
  assert.equal(p.side, 'long');
  assert.equal(p.symbol, 'SOL', 'the symbol needle gates drawing to the right chart');

  const lines = sent.filter((m) => m.type === 'paper-lines');
  assert.equal(lines[0].payload.axisBasis, 'usd-abs');
});

test('the two lines are the entry and the LIQUIDATION price', () => {
  const { state, pos } = bookWithFill();
  const sent = captureMessages(() => C.syncChart({ state, venue: 'hyperliquid', market: 'SOL', px: 100 }));
  const spec = sent.filter((m) => m.type === 'paper-lines').pop().payload;
  assert.ok(Math.abs(spec.avgBuyUsd - 100) < CLOSE, 'entry line at the entry price');
  // The liquidation line must be the live computed one, not a stale stored copy.
  const live = P.perpMark(pos, 100).liqPx;
  assert.ok(Math.abs(spec.avgSellUsd - live) < CLOSE, 'liquidation line at the computed liq price');
  assert.match(spec.buyLabel, /PAPER/, 'a paper artifact must never be mistakable for a real one');
  assert.match(spec.sellLabel, /Liquidation/);
});

test('one fill, one bubble — a redraw never mints a second', () => {
  const { state } = bookWithFill();
  const first = captureMessages(() => C.syncChart({ state, venue: 'hyperliquid', market: 'SOL', px: 100 }));
  assert.equal(first.filter((m) => m.type === 'paper-marker').length, 1);
  // A render handoff, a storage echo, a tick — all re-run the sync.
  const second = captureMessages(() => {
    C.syncChart({ state, venue: 'hyperliquid', market: 'SOL', px: 101 });
    C.syncChart({ state, venue: 'hyperliquid', market: 'SOL', px: 102 });
  });
  assert.equal(second.filter((m) => m.type === 'paper-marker').length, 0,
    'the same fill must never be posted twice');
});

test('fills from another market or venue are never drawn on this chart', () => {
  captureMessages(() => C.clearChart());
  const s = P.defaultPerpsState({ perpsStartUsd: 1000 });
  P.openPerp(s, {
    venue: 'hyperliquid', market: 'BTC', side: 'long',
    marginUsd: 10, leverage: 20, price: 64000, t: 1_700_000_000, params: { maxLeverage: 40 },
  });
  P.openPerp(s, {
    venue: 'jupiter', market: 'SOL', side: 'long',
    marginUsd: 10, leverage: 10, price: 100, t: 1_700_000_100,
    params: { impactScalarAdjUsd: 125000000000 },
  });
  const sent = captureMessages(() => C.syncChart({ state: s, venue: 'hyperliquid', market: 'SOL', px: 100 }));
  assert.equal(sent.filter((m) => m.type === 'paper-marker').length, 0,
    'a BTC fill and a Jupiter fill must not appear on the Hyperliquid SOL chart');
});

test('a closed book clears its lines instead of leaving them on the chart', () => {
  const { state, id } = bookWithFill();
  captureMessages(() => C.syncChart({ state, venue: 'hyperliquid', market: 'SOL', px: 100 }));
  const closed = P.closePerp(state, id, { price: 101, t: state.positions[id].openT + 60 });
  assert.equal(closed.ok, true, `the fixture must actually close (${closed.reason || ''})`);
  const sent = captureMessages(() => C.syncChart({ state, venue: 'hyperliquid', market: 'SOL', px: 101 }));
  assert.ok(sent.some((m) => m.type === 'paper-lines-clear'),
    'with no open position there is no entry and no liquidation to draw');
});

test('journal times are converted from seconds to the marker contract milliseconds', () => {
  const entry = { t: 1_700_000_000, venue: 'hyperliquid', market: 'SOL', id: 1, type: 'open', side: 'long', price: 100 };
  const m = C.markerFor(entry, 'SOL');
  assert.equal(m.ts, 1_700_000_000_000,
    'the perps journal stores seconds; the bridge contract is milliseconds');
});

test('a liquidation is drawn as a liquidation, not as a close', () => {
  const entry = { t: 1_700_000_000, venue: 'hyperliquid', market: 'SOL', id: 1, type: 'liquidation', side: 'long', price: 97 };
  assert.equal(C.markerFor(entry, 'SOL').kind, 'liquidation');
  const closed = C.markerFor({ ...entry, type: 'close' }, 'SOL');
  assert.equal(closed.kind, 'close');
});

/* ---------------- the bridge half of the seam ---------------- */

const bridgeSrc = fs.readFileSync(path.join(__dirname, '..', 'price-bridge.js'), 'utf8');

test('the bridge keeps the spot price gate intact and gives perps its own door', () => {
  // The spot gate refuses any mark without a SOL price, because a level
  // built from the wrong unit lands arrows orders of magnitude off. Perps
  // must not weaken it — it declares itself and takes a separate normalizer.
  assert.match(bridgeSrc, /if \(!payload \|\| !\(numberValue\(payload\.priceNative\) > 0\)\) return null;/,
    'the spot priceNative gate must survive');
  assert.match(bridgeSrc, /if \(payload && payload\.quote === 'usd-abs'\) return normalizePerpMark\(payload\);/,
    'and perps routes around it explicitly, not by loosening it');
});

test('the usd-abs basis returns the level verbatim, with no cap conversion', () => {
  assert.match(bridgeSrc, /if \(basis === 'usd-abs'\)/, 'lineLevelFor must know the basis');
  assert.match(bridgeSrc, /if \(levels\.perp \|\| basis === 'usd-abs'\) return levels\.usd > 0 \? levels\.usd : null;/,
    'shapeLevelFor must return the USD level unscaled');
});

test('a perps mark carries its own level — it does not wait for an axis spec', () => {
  // Observed live on Hyperliquid: a mark posted before any paper-lines
  // message could not be placed at all (shapesDrawn stayed 0), and a
  // lines-clear un-drew marks that had been drawn. A perps level is
  // absolute USD; it needs nothing else to be interpreted.
  assert.match(bridgeSrc, /perp: isPerp,/, 'the level record must know it is a perp level');
  assert.match(bridgeSrc, /if \(levels\.perp \|\| basis === 'usd-abs'\)/,
    'and the level must resolve from the mark alone, before any spec exists');

  // The producer also establishes the axis before posting fills.
  const src = fs.readFileSync(path.join(__dirname, '..', 'perps-chart.js'), 'utf8');
  const sync = src.slice(src.indexOf('function syncChart'), src.indexOf('function syncLines'));
  assert.ok(sync.indexOf('syncLines(o)') < sync.indexOf("post('paper-marker'"),
    'the axis spec is posted before any marker');
});

test('perps marks draw as SHAPES, never via the host marks pipeline', () => {
  // Verified live on app.hyperliquid.xyz (2026-08-06): the datafeed has
  // getMarks, so the bridge patches it and reports marksHooked:true — but
  // the widget never calls it, and the bridge's own refreshMarks() makes the
  // host call it exactly once, which sets marksPipelineSeenAt and thereby
  // suppresses the shape-fallback watchdog forever. A mark was accepted with
  // ok:true and never appeared on screen. Both venues support
  // createExecutionShape, so perps take the shape path unconditionally.
  assert.match(bridgeSrc, /if \(isPerp\) perpsMarksPresent = true;/,
    'a perps mark must latch the flag');
  const start = bridgeSrc.indexOf('function ensureMarksRender()');
  const ensureRaw = bridgeSrc.slice(start, bridgeSrc.indexOf('\n  function ', start + 10));
  assert.ok(ensureRaw.length > 100, 'ensureMarksRender must be found');
  assert.match(ensureRaw, /if \(perpsMarksPresent\) \{[\s\S]*?shapeFallbackActive = true;[\s\S]*?drawShapeFallback\(\);/,
    'and force the shape path immediately, not wait on a watchdog that a '
    + 'self-triggered getMarks call can permanently disarm');
  // The gate must sit BEFORE the marksPipelineSeenAt check that defeated it.
  // Comments are stripped: prose about the defect must not satisfy a test
  // about the code that fixes it.
  const ensure = ensureRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(ensure.includes('marksPipelineSeenAt'), 'the heuristic still exists for spot');
  assert.ok(ensure.indexOf('perpsMarksPresent') < ensure.indexOf('marksPipelineSeenAt'),
    'the perps branch must precede the marks-pipeline heuristic');
});

test('perps fills render as OUR OWN dom bubbles, not host chart objects', () => {
  // Execution shapes belong to the host's chart: it can drop them on any
  // re-render, symbol change or widget remount, and nothing tells us they
  // are gone — the handles still look alive, so the redraw sweep sees a
  // full set and does nothing. That is "shows up then disappears". The
  // bubble layer is our own fixed overlay, repositioned every frame from
  // the chart's own scales, so there is nothing for the host to delete.
  const fn = bridgeSrc.slice(
    bridgeSrc.indexOf('function drawShapeFallback()'),
    bridgeSrc.indexOf('function clearShapeFallback()'),
  );
  assert.ok(fn, 'drawShapeFallback must exist');
  assert.match(fn, /if \(best && perpsMarksPresent\) \{\s*\n\s*const drawn = syncBubbleLayer\(best\);\s*\n\s*reportFallbackRenderStatus\(\);\s*\n\s*return drawn;/,
    'a perps fill must go to the bubble layer and report its render count');
  // And it must decide that BEFORE the execution-shape path.
  const body = fn.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(body.indexOf('perpsMarksPresent') < body.indexOf('createExecutionShape'),
    'the perps branch must precede the execution-shape branch');
});

test('a drawn perps fill is never handed back to the marks pipeline', () => {
  // The reported "it shows up then it disappears". The patched getMarks
  // hands rendering back to the native pipeline and DELETES the temporary
  // shapes — and it is reached by our own refreshPadreMarks() call. So the
  // sequence was: shapes draw, we ask the host to refresh, the host calls
  // getMarks, and we delete the only thing on screen. On Hyperliquid that
  // took the bubble and left the lines, which is exactly what was seen.
  assert.match(bridgeSrc, /if \(shapeFallbackActive && !perpsMarksPresent\) \{/,
    'the handback must never fire once a perps mark exists');
  // And the handback must still work for spot, where marks genuinely render.
  const handback = bridgeSrc.slice(
    bridgeSrc.indexOf('if (shapeFallbackActive && !perpsMarksPresent)'),
    bridgeSrc.indexOf('if (shapeFallbackActive && !perpsMarksPresent)') + 160,
  );
  assert.match(handback, /shapeFallbackActive = false;\s*\n\s*clearShapeFallback\(\);/,
    'spot still hands back when the host really is pulling marks');
});

test('a perps shape says Long/Short/Close/Liquidated, not Buy/Sell', () => {
  assert.match(bridgeSrc, /shapeText: isPerp \? perpShapeText\(payload\) : null/);
  assert.match(bridgeSrc, /text: levels\.shapeText \|\| \(levels\.side === 'sell' \? 'PT Sell' : 'PT Buy'\)/,
    'and spot keeps its own wording when no shape text is supplied');
  assert.match(bridgeSrc, /if \(payload\.kind === 'liquidation'\) return 'PT Liquidated';/);
});

test('a perps SHORT points like an entry, and a liquidation like an exit', () => {
  assert.match(bridgeSrc, /payload\.side === 'short' \|\| payload\.kind === 'liquidation' \? 'sell' : 'buy'/,
    'direction must follow the position, not a spot buy/sell vocabulary');
});

test('spot line labels are unchanged when a surface does not name its own', () => {
  assert.match(bridgeSrc, /typeof spec\.buyLabel === 'string' \? spec\.buyLabel : 'PAPER Avg\. Fill'/,
    'spot keeps PAPER Avg. Fill');
  assert.match(bridgeSrc, /typeof spec\.sellLabel === 'string' \? spec\.sellLabel : 'PAPER Avg\. Exit'/,
    'spot keeps PAPER Avg. Exit');
});
