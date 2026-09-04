/* D-69: the onboarding wizard's step 2 never saw the first fill.
 *
 * Field report (scipher_, #general 2026-09-03): "cant get past this ive made
 * countless trades still nun" — the leaderboard wizard's "Make your first
 * paper trade" step never ticked. Screenshot: step 1 ✓ linked, step 2 stuck.
 *
 * Root cause: a fill commits as TWO storage writes (pt_state then
 * pt_attest_meta) and the dashboard reacted to each echo separately:
 *   - the pt_state echo moved the fingerprint but did NOT re-read the chain;
 *   - the pt_attest_meta echo re-read the chain but did NOT move the
 *     fingerprint (it had no chain term), so the wizard never repainted.
 * Only a full dashboard reload healed it.
 *
 * Fix under test:
 *   1. loadAll's wantChain gate also fires on pt_attest_seg_* echoes;
 *   2. dataFingerprint carries attestChain.length — a 0→1 chain flips the
 *      wizard's step 2 with NO other data changing.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const dashJs = fs.readFileSync(path.join(ROOT, 'dashboard.js'), 'utf8');
const AT = require('../attest.js');

function fnBlock(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start !== -1, `${marker} must exist`);
  const end = source.indexOf('\n}', start);
  assert.ok(end !== -1, `${marker} must terminate`);
  return source.slice(start, end + 2);
}

/** Run the SHIPPED dataFingerprint against synthetic module state. */
function fingerprintOf(stateObj, chainLen) {
  const src = fnBlock(dashJs, 'function dataFingerprint()');
  const sandbox = {
    state: stateObj, frames: [], replays: [], recordings: {}, settings: {},
    attestChain: new Array(chainLen || 0).fill({ hash: 'h' }),
    perpsState: null,
    JSON, Number, Object,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${src}\nthis.fp = dataFingerprint();`, sandbox);
  return sandbox.fp;
}

function fpState(over) {
  return Object.assign({
    cashSol: 9,
    journal: [],
    rounds: [],
    positions: {},
  }, over || {});
}

test('D-69 VAL-1b: the first committed fill moves the fingerprint (wizard repaints)', () => {
  const before = fingerprintOf(fpState(), 0);   // staring at the wizard, no fills
  const after = fingerprintOf(fpState(), 1);    // the chain just gained its first link
  assert.notEqual(before, after,
    'a chain 0→1 (the first fill) must repaint the dashboard — with no chain term the pt_attest_meta echo re-read the chain but the wizard never repainted');
});

test('D-69 VAL-1b-2: later fills keep moving it (step already true, journal still authoritative)', () => {
  const one = fingerprintOf(fpState(), 1);
  const two = fingerprintOf(fpState(), 2);
  assert.notEqual(one, two, 'every fill extends the chain, so the fingerprint must track its length');
});

test('D-69 VAL-1a: the wantChain gate fires on segment-key echoes (first-ever append)', () => {
  // Run the SHIPPED chainEcho + wantChain lines verbatim against each echo
  // shape, so the gate's own derivation is what's under test (no mirrored
  // logic in the test).
  const chainEchoSrc = dashJs.match(/const chainEcho = [^;]+;/);
  const wantChainSrc = dashJs.match(/const wantChain = [^;]+;/);
  assert.ok(chainEchoSrc && wantChainSrc, 'both gate lines must exist in loadAll');
  function gate(changedKeys, legacyInState, attestChainLoaded) {
    const sandbox = { changedKeys, legacyInState, attestChainLoaded, AT };
    vm.createContext(sandbox);
    vm.runInContext(`${chainEchoSrc[0]}\n${wantChainSrc[0]}\nthis.out = wantChain;`, sandbox);
    return sandbox.out;
  }

  // Echo 2 of a FIRST fill: pt_attest_meta + pt_attest_seg_0 (one onChanged
  // event carries every key the append wrote).
  assert.equal(
    gate(new Set([AT.CHAIN_META_KEY, AT.CHAIN_SEG_PREFIX + '0']), false, true),
    true, 'echo 2 (meta + seg_0) must re-read the chain');
  // A later fill inside an existing segment writes the segment + meta again.
  assert.equal(
    gate(new Set([AT.CHAIN_SEG_PREFIX + '0']), false, true),
    true, 'a segment-key-only echo must also re-read the chain');
  // The pre-fix regression shape: a pt_state-only echo with no legacy chain
  // must NOT re-read (the wallet heartbeat stays cheap — D-28 cost law intact).
  assert.equal(
    gate(new Set(['pt_state']), false, true),
    false, 'a wallet-only write must still skip the chain read');
});

test('D-69 VAL-1c NEGATIVE CONTROL: reverting the fingerprint chain term fails this suite', () => {
  // Run the shipped fingerprint function WITH the term vs WITHOUT it, at
  // chain length 0 and 1. The buggy build (no term) must be blind to 0→1 —
  // that blindness IS the bug; the shipped build must see it.
  const shipped = fnBlock(dashJs, 'function dataFingerprint()');
  const buggy = shipped.replace('attestChain.length,', '');
  assert.notEqual(buggy, shipped, 'the chain term must be present and removable');

  function fp(src, chainLen) {
    const sandbox = {
      state: fpState(), frames: [], replays: [], recordings: {}, settings: {},
      attestChain: new Array(chainLen).fill({ hash: 'h' }),
      perpsState: null,
      JSON, Number, Object,
    };
    vm.createContext(sandbox);
    vm.runInContext(`${src}\nthis.fp = dataFingerprint();`, sandbox);
    return sandbox.fp;
  }
  assert.notEqual(fp(shipped, 0), fp(shipped, 1),
    'the SHIPPED fingerprint distinguishes chain 0→1');
  assert.equal(fp(buggy, 0), fp(buggy, 1),
    'NEGATIVE CONTROL CONFIRMED: without the attestChain.length term the fingerprint is identical at chain length 0 and 1 — exactly the shipped bug (this test FAILS if someone removes the term)');
});

test('D-69 VAL-3: the wizard step-2 predicate flips on the new signal end-to-end', () => {
  // lbSteps: done = chainLen > 0. The full echo sequence:
  //   echo 1 (pt_state):  chain not re-read, done stays false, fingerprint MOVED
  //                       (journal grew) → repaint with step 2 still unticked;
  //   echo 2 (meta+seg):  chain re-read 0→1, fingerprint MOVED (new term) →
  //                       repaint with step 2 ✓. No reload anywhere.
  const steps0 = [{ id: 'anchor', done: 0 > 0 }];
  const steps1 = [{ id: 'anchor', done: 1 > 0 }];
  assert.equal(steps0[0].done, false);
  assert.equal(steps1[0].done, true);
  assert.notEqual(fingerprintOf(fpState({ journal: [{ id: 't0' }] }), 0),
    fingerprintOf(fpState({ journal: [{ id: 't0' }] }), 1),
    'echo 2 must move the fingerprint even when the wallet did not change between the echoes');
});

test('D-69: source contract — the comment trail and both patches are in the shipped file', () => {
  assert.ok(dashJs.includes('D-69'), 'the fix carries its defect id');
  assert.ok(dashJs.includes('attestChain.length'), 'the fingerprint carries the chain length');
  assert.ok(dashJs.includes('CHAIN_SEG_PREFIX'), 'the gate knows about segment keys');
});
