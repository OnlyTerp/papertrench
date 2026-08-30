/* D-64: GMGN average lines must survive a missing supply (the portifly report).
 *
 * Live evidence (Discord 🐛-bug-reports, 2026-08-28, portifly): "I'm having an
 * issue on GMGN. The Marks feature is definitely enabled, but the 'Avg Price'
 * and 'Avg Exit' lines never show up. Is that normal? I'm definitely using the
 * latest version."
 *
 * Root cause: the gmgn-lines spec computes avgBuyMcap as
 * `supply && avgBuyUsd ? avgBuyUsd * supply : null`, where supply =
 * token.mcap / token.priceUsd. On a fresh launch the resolver often has
 * priceNative but NO mcap/priceUsd yet — supply is null, so avgBuyMcap
 * arrives null, and gmgnLineLevel() returns null with NO fallback, unlike
 * gmgn markers which have the C-16 native-ratio fallback
 * (close x fillNative/currentNative) for exactly this case. Worse, the
 * retry loop gives up silently after 30 x 500ms and the periodic sweep only
 * re-arms when avgBuyMcap > 0 — so a level that can never compute never
 * retries and never reports why.
 *
 * Fix under test: the bridge's gmgn line level gains the same C-16 lane —
 * when avg{Side}Mcap is absent but currentPriceNative + avg{Side}Native are
 * present, the level is candleClose x (avgNative / currentNative). The spec
 * carries avg{Side}Native from the content script (it already computes
 * averages.avgBuyNative). The sweep re-arms while ANY wanted side has no
 * line, not only when the mcap candidate is positive.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'price-bridge.js'), 'utf8');

function blockFrom(marker, span = 3000) {
  const start = src.indexOf(marker);
  assert.ok(start >= 0, 'marker must exist: ' + marker);
  return src.slice(start, start + span);
}

test('D-64/1: gmgnLineLevel has a native-ratio fallback (C-16 parity)', () => {
  const b = blockFrom('function gmgnLineLevel(side)');
  assert.match(b, /avg' \+ side \+ 'Native/,
    'the native average candidate must be read');
  assert.match(b, /currentPriceNative/,
    'the current native price must be read');
});

test('D-64/2: the gmgn-lines handler accepts avg{Side}Native from the spec', () => {
  const b = blockFrom("if (type === 'gmgn-lines')", 1600);
  assert.match(b, /avgBuyNative/,
    'spec must carry the native buy average');
  assert.match(b, /avgSellNative/,
    'spec must carry the native sell average');
});

test('D-64/3: the sweep re-arms while a WANTED side has no line', () => {
  const b = blockFrom('if (gmgnLineSpec && gmgnLineSpec.enabled && !gmgnRetryTimer)');
  assert.match(b, /wantsBuy|avgBuyNative|avgBuyUsd/,
    'want-detection must consider more than avgBuyMcap');
});

test('D-64/4: the content script posts native averages in the gmgn-lines spec', () => {
  const c = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  const start = c.indexOf("sendPadreMarker('gmgn-lines', {");
  assert.ok(start >= 0, 'gmgn-lines spec build must exist');
  const block = c.slice(start, start + 900);
  assert.match(block, /avgBuyNative/,
    'the spec must include the native buy average');
  assert.match(block, /avgSellNative/,
    'the spec must include the native sell average');
});
