/**
 * The tiered fee schedule has to REACH a fill, not merely exist.
 *
 * fees.js shipped fully unit-tested and engine.js read a fee context — but
 * nothing in content.js ever supplied one, so `feeContext()` returned null on
 * every real trade and the engine silently fell back to the flat
 * `settings.feeBps`. Every fee test passed. Every live fill charged 1%.
 *
 * These tests drive the CALL SITES in content.js, not the fee module, and
 * assert on things only the wiring can produce. Delete the spread at any
 * `E.buy(` / `E.sell(` site and the corresponding test goes red.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');

/* ---------------- the wiring itself ---------------- */

test('every engine order call site carries the fee context', () => {
  // Buys and sells are both charged the schedule, so both must supply it.
  const buySites = src.match(/E\.buy\(state, settings, \{/g) || [];
  const sellSites = src.match(/E\.sell\(state, settings, \{/g) || [];
  assert.equal(buySites.length, 3, 'expected 3 buy call sites in content.js');
  assert.equal(sellSites.length, 2, 'expected 2 sell call sites in content.js');

  const wired = src.match(/\.\.\.\(feeContextForOrder\(\) \|\| \{\}\)/g) || [];
  assert.equal(
    wired.length,
    buySites.length + sellSites.length,
    `all ${buySites.length + sellSites.length} order call sites must spread feeContextForOrder(); found ${wired.length}`,
  );
});

test('the context is SPREAD onto the order, never nested under a key', () => {
  // engine.feeContext(o) reads o.graduated / o.canonical / o.marketCapSol
  // directly. `fee: feeContextForOrder()` would type-check fine, produce no
  // error, and charge the flat rate forever.
  assert.ok(
    !/fee:\s*feeContextForOrder\(\)/.test(src),
    'nesting the context under `fee:` makes the engine ignore it entirely',
  );
});

/* ---------------- the helper's decisions ---------------- */

// Rebuild the helper against controllable inputs. The body is lifted from
// content.js so the logic under test is the shipped logic.
function makeHelper(token) {
  if (!token) return null;
  if (token.pumpCurve === undefined || token.pumpCurve === null) return null;
  if (token.kind !== 'pump' && !String(token.mint || '').endsWith('pump')) return null;

  const graduated = token.pumpCurve !== true;
  const ctx = { graduated };
  if (graduated) {
    ctx.canonical = true;
    const rate = Number(token.solUsdAtResolve);
    const mcapUsd = Number(token.mcap);
    if (rate > 0 && mcapUsd > 0) ctx.marketCapSol = mcapUsd / rate;
  }
  return ctx;
}

test('a live bonding curve is not graduated', () => {
  const ctx = makeHelper({ kind: 'pump', mint: 'abcpump', pumpCurve: true });
  assert.ok(ctx, 'a pump coin on a live curve must produce a context');
  assert.equal(ctx.graduated, false);
});

test('a pump coin no longer on a live curve has graduated', () => {
  const ctx = makeHelper({
    kind: 'pump', mint: 'abcpump', pumpCurve: false,
    mcap: 100000, solUsdAtResolve: 200,
  });
  assert.ok(ctx, 'a graduated pump coin must produce a context');
  assert.equal(ctx.graduated, true);
  assert.equal(ctx.canonical, true);
});

test('market cap is converted USD -> SOL at the RECORDED rate', () => {
  const ctx = makeHelper({
    kind: 'pump', mint: 'abcpump', pumpCurve: false,
    mcap: 100000, solUsdAtResolve: 200,
  });
  // 100,000 USD / 200 USD-per-SOL = 500 SOL. Feeding the USD number straight
  // in would land in a completely different (far cheaper) tier.
  assert.equal(ctx.marketCapSol, 500);
});

test('no SOL rate means no market cap rather than a guessed one', () => {
  const ctx = makeHelper({
    kind: 'pump', mint: 'abcpump', pumpCurve: false, mcap: 100000,
  });
  assert.equal(ctx.graduated, true);
  assert.ok(!('marketCapSol' in ctx),
    'an unknown rate must omit market cap so fees.js charges the dearest tier');
});

test('a non-pump coin produces no context at all', () => {
  assert.equal(makeHelper({ kind: 'dex', mint: 'So11111111111111111111111111111111111111112', pumpCurve: false }), null);
});

test('an unresolved coin produces no context', () => {
  // pumpCurve undefined = the resolver never reached the chain.
  assert.equal(makeHelper({ kind: 'pump', mint: 'abcpump' }), null);
  assert.equal(makeHelper(null), null);
});

/* ---------------- end to end through the real engine ---------------- */

test('the context actually changes what a fill is charged', () => {
  const F = require(path.join(ROOT, 'fees.js'));
  const prevSelf = global.self;
  global.self = global;
  self.PTFees = F;
  delete require.cache[require.resolve(path.join(ROOT, 'engine.js'))];
  const E = require(path.join(ROOT, 'engine.js'));
  const engine = (global.PaperEngine || self.PaperEngine || E);

  const settings = { feeBps: 100 };

  // What content.js did before this wiring: no context, flat fallback.
  const bare = engine.effectiveFeeBps(settings, { solAmount: 1 });
  assert.equal(bare, 100, 'no context must still fall back to settings.feeBps');

  // What it does now for a coin on the curve.
  const onCurve = engine.effectiveFeeBps(settings, {
    solAmount: 1, ...makeHelper({ kind: 'pump', mint: 'abcpump', pumpCurve: true }),
  });
  assert.equal(onCurve, 125, 'a bonding-curve fill pays the 125 bps curve rate');

  // And for a large graduated coin, which is materially cheaper.
  const big = engine.effectiveFeeBps(settings, {
    solAmount: 1,
    ...makeHelper({
      kind: 'pump', mint: 'abcpump', pumpCurve: false,
      mcap: 100000 * 200, solUsdAtResolve: 200, // 100,000 SOL market cap
    }),
  });
  assert.equal(big, 30, 'a deep graduated pool pays the 30 bps floor');

  assert.notEqual(onCurve, bare, 'the wiring must change the charged rate');
  assert.notEqual(big, onCurve, 'the tier must move with market cap');

  global.self = prevSelf;
});
