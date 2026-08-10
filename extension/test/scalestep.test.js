/* F-50 — one tick may not re-scale the market.
 *
 * Caught by featurepass on lute (2026-08-10, BONK, receipts in the journal):
 * lute displays a ~10x supply-convention cap, ACCEPT_RATIO is a deliberate
 * 20x (memecoins genuinely 10x between anchor refreshes), so chart and title
 * values at lute's scale VALIDATED and rescaled the whole token — the panel
 * flip-flopped $214M ⇄ $2.15B and an immediate round trip booked -90.2%
 * (buy leg priceSource=padre-chart-bar at $2,151,142,047; sell leg ws at
 * $214,646,482; 3.9 seconds apart; both receipts fresh).
 *
 * The discipline under test: a genuine 10x arrives as many small steps; a
 * scale flip arrives as ONE step. A single tick beyond SCALE_STEP_RATIO of
 * the freshest accepted evidence is refused — unless it sits CLOSER to the
 * resolver anchor than the stream does, in which case the stream was the
 * wrong scale and snapping back to the anchor's side is the honest move.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

global.window = global.window || {};
const Q = require('../quote.js');

// The receipts' own numbers, verbatim.
const N_WS = 3.1849365472463804e-8;    // ws leg — the market's scale
const N_CHART = 3.191876644514063e-7;  // chart leg — lute's ~10x scale
const ANCHOR = 3.2e-8;                 // resolver anchor, market scale

test('F-50: the lute chart tick that priced the -90.2% round is refused', () => {
  assert.equal(Q.scaleStepVerdict(N_CHART, N_WS, 1500, ANCHOR), 'scale-step',
    'a 10x single step away from the anchor side must not move the market');
});

test('F-50: cold start on the WRONG scale snaps back to the anchor side', () => {
  // The chart tick got in first (stream at lute scale); the ws tick arrives.
  assert.equal(Q.scaleStepVerdict(N_WS, N_CHART, 1500, ANCHOR), 'ok',
    'the newcomer sits closer to the anchor — the STREAM was the wrong scale');
});

test('F-50: a real pump in small steps never trips', () => {
  let last = ANCHOR;
  for (let i = 0; i < 8; i++) {
    const next = last * 1.5; // 1.5x per tick → ~25x cumulative, honestly
    assert.equal(Q.scaleStepVerdict(next, last, 900, ANCHOR), 'ok',
      `step ${i} of a genuine move must pass`);
    last = next;
  }
});

test('F-50: a violent single step inside the ratio still passes', () => {
  assert.equal(Q.scaleStepVerdict(ANCHOR * 2.9, ANCHOR, 900, ANCHOR), 'ok',
    'the band must not tax honest volatility');
});

test('F-50: stale evidence stands aside — the anchor band governs alone', () => {
  assert.equal(Q.scaleStepVerdict(N_CHART, N_WS, Q.SCALE_STEP_WINDOW_MS + 1, ANCHOR), 'ok',
    'beyond the window the stream is history, not evidence');
});

test('F-50: missing numbers never veto', () => {
  assert.equal(Q.scaleStepVerdict(null, N_WS, 900, ANCHOR), 'ok');
  assert.equal(Q.scaleStepVerdict(N_CHART, null, 900, ANCHOR), 'ok');
  assert.equal(Q.scaleStepVerdict(N_CHART, N_WS, -1, ANCHOR), 'ok',
    'a clock fault is not evidence');
});

test('F-50: with no anchor, a big step is still refused (no arbiter, no re-scale)', () => {
  assert.equal(Q.scaleStepVerdict(N_CHART, N_WS, 900, null), 'scale-step',
    'without an anchor to vouch for the newcomer, the stream stands');
});

test('F-50: both acceptance sites consult the verdict', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'content.js'), 'utf8');
  // The tick path: after validation, before any token mutation.
  const tickAt = src.indexOf('rejected as scale-step vs accepted');
  const adoptAt = src.indexOf('token.priceNative = verdict.priceNative;');
  assert.ok(tickAt !== -1 && adoptAt !== -1 && tickAt < adoptAt,
    'the tick guard must run before the tick mutates the token');
  // The title path: the rescale AND token.mcap are both behind the guard.
  const titleAt = src.indexOf('title cap ');
  const titleAdopt = src.indexOf('token.mcap = mcap;', titleAt);
  assert.ok(titleAt !== -1 && titleAdopt !== -1,
    'the title guard must run before the cap is adopted');
  const calls = src.match(/Q\.scaleStepVerdict\(/g) || [];
  assert.ok(calls.length >= 2, 'both sites must use the pure, tested judgment');
  // The verdict must actually GATE: each call compares to the rejecting
  // value and returns. A comparison to anything else is a disarmed guard.
  const gates = src.match(/\) === 'scale-step'\) \{\s*\n\s*console\.debug\('PaperTrench: (tick|title cap) /g) || [];
  assert.equal(gates.length, 2,
    `both sites must reject on 'scale-step' exactly (found ${gates.length})`);
});
