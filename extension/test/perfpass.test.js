/* Turbo III — the audit pass: contracts for the wins, so they cannot silently
 * regress.
 *
 * Each lock here guards a specific piece of work that was REMOVED from a hot
 * path. The failure mode for all of them is the same and it is quiet: someone
 * "simplifies" the gate away, nothing breaks, no test fails, and the megabyte
 * comes back. So every assertion below is written against the mechanism that
 * does the skipping, not against a timing.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const dashJs = fs.readFileSync(path.join(ROOT, 'dashboard.js'), 'utf8');
const perpsContentJs = fs.readFileSync(path.join(ROOT, 'perps-content.js'), 'utf8');
const perpsTicketJs = fs.readFileSync(path.join(ROOT, 'perps-ticket.js'), 'utf8');
const attestJs = fs.readFileSync(path.join(ROOT, 'attest.js'), 'utf8');

const AT = require('../attest.js');
const P = require('../perps.js');

/* ---------------- dashboard: stop re-reading the world ---------------- */

test('a HIDDEN dashboard does no work on a storage echo', () => {
  const watch = dashJs.slice(
    dashJs.indexOf('function watchDashboardStorage()'),
    dashJs.indexOf('async function loadAll(changedKeys)'),
  );
  assert.ok(watch, 'watchDashboardStorage must exist');
  assert.match(watch, /if \(document\.hidden\) return;/,
    'a hidden dashboard paints nothing — re-reading the wallet, the frame ring and the '
    + 'chain ~75x/min to repaint an invisible tab is pure cost');
  // Nothing may be missed by that early return: the visibility handler owns the
  // catch-up, and it must do a FULL read (no changedKeys) so a skipped echo
  // cannot leave a stale frame ring or chain on screen.
  const init = dashJs.slice(dashJs.indexOf('setInterval(() => {'), dashJs.indexOf('const flexMatch'));
  assert.match(init, /visibilitychange/, 'returning to the tab must refresh');
  assert.match(init, /if \(!document\.hidden\) refreshIfChanged\(\)/,
    'the visibility catch-up must call refreshIfChanged with NO changed-key set — a full read');
});

test('a storage echo only re-reads the keys that actually changed', () => {
  const watch = dashJs.slice(
    dashJs.indexOf('function watchDashboardStorage()'),
    dashJs.indexOf('async function loadAll(changedKeys)'),
  );
  assert.match(watch, /refreshIfChanged\(new Set\(Object\.keys\(changes\)\)\)/,
    'the echo must hand its changed-key set down so the read can be scoped');

  const load = dashJs.slice(
    dashJs.indexOf('async function loadAll(changedKeys)'),
    dashJs.indexOf('let lastRecordingsFingerprint'),
  );
  // The frame ring is up to 80 base64 JPEGs and changes only on a fill; the
  // wallet heartbeat writes ~75x/min while a position is open.
  assert.match(load, /const wantFrames = !changedKeys \|\| changedKeys\.has\('pt_frames'\)/,
    'frames are re-read only when the frames key changed');
  assert.match(load, /if \(wantFrames\) frames = /,
    'and the in-memory ring is kept untouched when the read was skipped');
  assert.ok(!/const s = await store\.get\(\['pt_state', 'pt_settings', 'pt_frames'/.test(load),
    'the frame ring must no longer ride the unconditional key list');

  // Same for the attestation chain, with the two cases that MUST still read it.
  // D-69: the gate also fires on pt_attest_seg_* echoes — a first-ever append
  // creates a segment key, and the onboarding wizard renders from the chain.
  assert.match(load, /const chainEcho = changedKeys && \(changedKeys\.has\(AT\.CHAIN_META_KEY\)/,
    'the chain is re-read when its own meta key changed');
  assert.match(load, /\|\| \[\.\.\.changedKeys\]\.some\(\(k\) => String\(k\)\.startsWith\(AT\.CHAIN_SEG_PREFIX\)\)/,
    'and when a chain segment changed (D-69: the first append creates seg_0)');
  assert.match(load, /\|\| legacyInState \|\| !attestChainLoaded/,
    'a legacy in-state chain, and the very first load, must always read');
  assert.match(load, /attestChainLoaded = true/,
    'the loaded flag must latch only after a SUCCESSFUL read, so a failed read retries');
});

test('D-15 survives the scoping: a failed read is still not "empty storage"', () => {
  const load = dashJs.slice(
    dashJs.indexOf('async function loadAll(changedKeys)'),
    dashJs.indexOf('let lastRecordingsFingerprint'),
  );
  assert.match(load, /if \(s === null\)/, 'a null read is still detected');
  assert.match(load, /storageReadFailed = true/, 'and still raises the banner and blocks writes');
  // Skipping a read is knowing the answer already; it must never be conflated
  // with a read that FAILED.
  assert.ok(load.indexOf('storageReadFailed = true') < load.indexOf('const wantChain'),
    'the failed-read bail must come before any scoped work');
});

/* ------- receipts: the jank rate must not count what it cannot divide ----- */

test('long tasks are attributed to the visible window they ran in', () => {
  const contentJs = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  const observer = contentJs.slice(
    contentJs.indexOf('jankObserver = new PerformanceObserver('),
    contentJs.indexOf('jankObserver.observe('),
  );
  assert.ok(observer, 'the jank observer must exist');

  // The published rate is blockedMs / sampledMs, and sampledMs counts VISIBLE
  // time only. Counting a task with no visible time to divide by inflates the
  // number the dashboard prints — an honest-numbers defect, not a perf one.
  assert.match(observer, /if \(jankVisibleSince < 0\) return;/,
    'nothing may be counted while hidden — there is no open window to attribute it to');
  assert.match(observer, /if \(entry\.startTime < jankVisibleSince\) continue;/,
    'a hidden tab delivers its deferred entries in a batch when re-shown, so entries '
    + 'must be attributed by startTime, not by whether we happen to be visible at delivery');

  // The denominator must still be visible-time-only, or the fix is pointless.
  const closeWindow = contentJs.slice(
    contentJs.indexOf('function jankCloseWindow()'),
    contentJs.indexOf('function onJankVisibility()'),
  );
  assert.match(closeWindow, /jankVisibleMs \+= Math\.max\(0, performance\.now\(\) - jankVisibleSince\)/,
    'sampledMs accrues only across open visible windows');
});

/* ---------------- attest: parallel digests, identical verdicts ---------- */

test('verifyChain hashes in parallel and reports problems in the same order', async () => {
  // The digests are independent, so they must not be awaited one at a time.
  // (Bounded batching is the required shape — see the batching test below.)
  assert.match(attestJs, /await Promise\.all\(\s*list\.slice\(start, start \+ DIGEST_BATCH\)\.map\(/,
    'the digests are independent — they must be computed in parallel, not one await per link');
  const verify = attestJs.slice(attestJs.indexOf('async function verifyChain('));
  assert.ok(!/for \(let i = 0; i < list\.length; i\+\+\) \{[\s\S]{0,400}await sha256\(/.test(verify),
    'no awaited digest may return to the sequential loop');

  // A good chain verifies. appendFill returns ONE link; the caller owns the
  // chain, so build it the way the engine does.
  const chain = [];
  let prev = null;
  for (let i = 0; i < 6; i++) {
    const link = await AT.appendFill(prev, {
      id: 'f' + i, ts: 1000 + i * 10, mint: 'M' + i, side: i % 2 ? 'sell' : 'buy',
      qty: 1 + i, priceNative: 0.01 * (i + 1), solGross: 0.5,
    });
    chain.push(link);
    prev = link.hash;
  }
  const clean = await AT.verifyChain(chain);
  assert.equal(clean.valid, true, 'an untampered chain must verify');
  assert.equal(clean.length, 6);
  assert.equal(clean.head, chain[5].hash);

  // Editing a payload field breaks THAT link's digest.
  const edited = chain.map((l) => ({ ...l }));
  edited[2] = { ...edited[2], qty: 999 };
  const bad = await AT.verifyChain(edited);
  assert.equal(bad.valid, false, 'an altered fill must not verify');
  assert.ok(bad.problems.some((p) => p.index === 2 && p.reason === 'hash-mismatch'),
    'the altered link is named by index');

  // Re-pointing a link breaks the CHAINING check, which is the sequential half
  // the parallel digests must not have disturbed.
  const relinked = chain.map((l) => ({ ...l }));
  relinked[3] = { ...relinked[3], prev: relinked[0].hash };
  const broken = await AT.verifyChain(relinked);
  assert.ok(broken.problems.some((p) => p.index === 3 && p.reason === 'broken-link'),
    'a re-pointed link is still caught as broken-link');

  // A backdated fill is the classic cheat and is still caught.
  const backdated = chain.map((l) => ({ ...l }));
  backdated[4] = { ...backdated[4], ts: 0 };
  const outOfOrder = await AT.verifyChain(backdated);
  assert.ok(outOfOrder.problems.some((p) => p.index === 4 && p.reason === 'out-of-order-timestamp'),
    'a backdated fill is still caught');

  // Whatever the problems are, they must be reported index-ascending — the
  // parallel pass must not have reordered the sequential report.
  for (const result of [bad, broken, outOfOrder]) {
    const indexes = result.problems.map((p) => p.index);
    assert.deepEqual(indexes, [...indexes].sort((a, b) => a - b),
      'problems must stay in index order');
  }
});

test('digests are batched, so a very long chain cannot launch unbounded work', async () => {
  // attest.js is imported DIRECTLY by the leaderboard server (server/core/chain.js)
  // so the hash contract cannot fork between client and server — and that server
  // accepts chains far longer than any local wallet. An unbounded Promise.all
  // would launch one digest per link at once and materialise every preimage
  // before the first resolved.
  assert.match(attestJs, /const DIGEST_BATCH = \d+/, 'the batch size must be a named constant');
  assert.match(attestJs, /for \(let start = 0; start < list\.length; start \+= DIGEST_BATCH\)/,
    'digests must be computed in bounded batches, not one unbounded map');

  // And batching must not disturb results across a boundary. Build a chain
  // longer than one batch and verify it end to end.
  const batchSize = Number(/const DIGEST_BATCH = (\d+)/.exec(attestJs)[1]);
  const n = batchSize * 2 + 3; // crosses two boundaries and lands mid-batch
  const chain = [];
  let prev = null;
  for (let i = 0; i < n; i++) {
    const link = await AT.appendFill(prev, {
      id: 'b' + i, ts: 1000 + i, mint: 'M', side: 'buy', qty: 1, priceNative: 0.5, solGross: 0.1,
    });
    chain.push(link);
    prev = link.hash;
  }
  const clean = await AT.verifyChain(chain);
  assert.equal(clean.valid, true, `a ${n}-link chain must verify across batch boundaries`);
  assert.equal(clean.length, n);

  // Tamper a link that sits in the SECOND batch — the boundary is where an
  // off-by-one in the batching would hide.
  const tampered = chain.map((l) => ({ ...l }));
  const victim = batchSize + 1;
  tampered[victim] = { ...tampered[victim], qty: 4242 };
  const bad = await AT.verifyChain(tampered);
  assert.ok(bad.problems.some((p) => p.index === victim && p.reason === 'hash-mismatch'),
    'a tampered link past the first batch boundary must still be caught, at the right index');
});

test('an empty chain still verifies to GENESIS', async () => {
  const empty = await AT.verifyChain([]);
  assert.equal(empty.valid, true);
  assert.equal(empty.length, 0);
  assert.ok(typeof empty.head === 'string' && empty.head.length > 0);
});

/* ---------------- perps: the read paths hold no book at all ------------
 *
 * The original form of this lock pinned a one-position CLONE passed to the
 * mutating markPerp. That was a convention two callers had to keep in step;
 * it is now structural. P.perpMark takes the position record and no book, so
 * a read path cannot reach cash, the journal, totals, or a sibling position,
 * and it writes nothing — which is why neither caller needs a clone to stay
 * non-destructive, and why neither pays a cost that grows with history.
 * The behavioural equivalence lives in perps.test.js (perpMark vs markPerp,
 * on a sibling book AND a lone book); these are the source contracts.
 */

test('the tick-path liquidation check holds no book and clones nothing', () => {
  const fn = perpsContentJs.slice(
    perpsContentJs.indexOf('function watchLiquidations()'),
    perpsContentJs.indexOf('/* ------------------------------- UI ---'),
  );
  assert.ok(fn, 'watchLiquidations must exist');
  assert.ok(!/JSON\.parse\(JSON\.stringify\(/.test(fn),
    'asking "am I liquidated?" must not deep-copy anything — the pure mark needs no clone');
  assert.match(fn, /P\.perpMark\(pos, lastPx\)/,
    'the pure mark takes the position record, not the book');
  assert.ok(!/P\.markPerp\(/.test(fn),
    'the committing twin belongs to the applyOp path below, never to the read');
});

test('the render path holds no book clone and prints the mark it computed', () => {
  const fn = perpsTicketJs.slice(
    perpsTicketJs.indexOf('function buildPositionRows(state, o)'),
    perpsTicketJs.indexOf('/* The TA strip'),
  );
  assert.ok(fn, 'buildPositionRows must exist');
  assert.ok(!/JSON\.parse\(JSON\.stringify\(/.test(fn),
    'a render cloned the whole book — journal, rounds and all — so drawing rows cost more '
    + 'the longer the account had existed; the pure mark removes the reason for the clone');
  assert.match(fn, /P\.perpMark\(pos, o\.px\)/, 'rows mark through the pure read');
  assert.ok(!/P\.markPerp\(/.test(fn), 'a render must never commit a write');
  assert.ok(!/pos\.liqPx/.test(fn),
    'the row must print m.liqPx — the answer this mark just computed. A pure mark writes '
    + 'nothing back, so pos.liqPx is only as fresh as the last COMMITTED write, and printing '
    + 'it would put a stale liquidation price on screen');
});
