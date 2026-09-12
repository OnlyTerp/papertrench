// livepass verdict locks (audit B1 + B2-harness).
// Zero-dep: verdict.mjs imports nothing, so node --test needs no playwright.
import test from 'node:test';
import assert from 'node:assert/strict';
import { predictVerdict } from '../.headless/verdict.mjs';

const Q = (over = {}) => ({
  badge: 'SIMULATED', ticket: 'ticket', quote: 'QUOTED 55c on KX (cost P$5.50)', quoteCode: null, viaFallback: false, ...over,
});

// --- Audit B1: a dead fallback must be BLOCKED, never PASS ---

test('B1: closed fallback scores BLOCKED, not PASS (the kraken-ipo case)', () => {
  // Polymarket /event/kraken-ipo-in-2025: all 4 markets closed:true. The old
  // verdict regex matched "has closed" as guarded → PASS on a dead corpus.
  const s = predictVerdict(Q({ quote: 'refused [market_closed]: This market has closed.', quoteCode: 'market_closed', viaFallback: true }));
  assert.ok(s.startsWith('BLOCKED'), `dead fallback must be BLOCKED, got: ${s}`);
});

test('B1: fallback that quotes still proves the pipeline (PASS)', () => {
  assert.equal(predictVerdict(Q({ viaFallback: true })), 'PASS');
});

test('B1: fallback with nothing mounted is BLOCKED, not FAIL', () => {
  // A dead fallback URL (404/redirect) mounts nothing. FAIL would blame the
  // product for a dead corpus URL — both PASS and FAIL are lies here.
  const s = predictVerdict(Q({ badge: null, ticket: null, quote: 'no quote (state=unknown)', viaFallback: true }));
  assert.ok(s.startsWith('BLOCKED'), `got: ${s}`);
});

// --- B2-harness: codes first, prose regex as legacy fallback ---

test('B2: guard codes score PASS-guard on listing-resolved markets', () => {
  for (const code of ['resolution_lockout', 'no_liquidity', 'market_closed', 'depth_cap']) {
    const s = predictVerdict(Q({ quote: `refused [${code}]: whatever the prose says`, quoteCode: code }));
    assert.equal(s, 'PASS (engine guard fired — pipeline healthy)', code);
  }
});

test('B2: pipeline codes score FAIL-pipe even when the prose is friendly', () => {
  for (const code of ['stale_book', 'unknown_venue', 'venue_error']) {
    const s = predictVerdict(Q({ quote: `refused [${code}]: Temporary hiccup, try again`, quoteCode: code }));
    assert.ok(s.startsWith('FAIL'), `${code} got: ${s}`);
  }
});

test('legacy prose regexes still work when the ticket predates codes', () => {
  assert.equal(
    predictVerdict(Q({ quote: 'refused: already priced as a near-certainty', quoteCode: null })),
    'PASS (engine guard fired — pipeline healthy)');
  const s = predictVerdict(Q({ quote: 'refused: No live book for this market right now.', quoteCode: null }));
  assert.ok(s.startsWith('FAIL'), `got: ${s}`);
});

test('mount failures on listing-resolved markets keep their verdicts', () => {
  assert.equal(predictVerdict(Q({ ticket: null, quote: 'no quote (state=unknown)' })), 'PARTIAL — badge only, no ticket UI');
  assert.equal(predictVerdict(Q({ badge: null, ticket: null, quote: 'no quote (state=unknown)' })), 'FAIL — nothing mounted');
});
