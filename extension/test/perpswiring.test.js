/* Wiring contracts for the perps surface.
 *
 * The perps feature must ride the extension's existing trust posture:
 * ZERO new permissions, ZERO new background message types, and a content
 * script stack whose load order satisfies each module's dependencies.
 * These are source contracts in the house style — a refactor that breaks
 * the posture fails here, not in a user's browser.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const contentSrc = fs.readFileSync(path.join(ROOT, 'perps-content.js'), 'utf8');

function perpsEntry() {
  return manifest.content_scripts.find((e) => (e.js || []).includes('perps-content.js'));
}

test('the manifest registers the perps stack on exactly the probed venue hosts', () => {
  const entry = perpsEntry();
  assert.ok(entry, 'a content_scripts entry must load perps-content.js');
  assert.deepEqual([...entry.matches].sort(), [
    'https://*.jup.ag/*',
    'https://app.hyperliquid.xyz/*',
    'https://jup.ag/*',
  ].sort());
  assert.equal(entry.world, 'ISOLATED');
  assert.equal(entry.run_at, 'document_idle');
  assert.equal(entry.all_frames, false);
});

test('the perps stack loads in dependency order', () => {
  const js = perpsEntry().js;
  const order = ['perps-venues.js', 'perps.js', 'bar-store.js', 'ta-core.js', 'perps-sites.js', 'perps-reconcile.js', 'perps-ticket.js', 'perps-chart.js', 'perps-content.js'];
  const positions = order.map((f) => js.indexOf(f));
  assert.ok(positions.every((p) => p >= 0), 'every perps module must be in the entry: ' + JSON.stringify(js));
  for (let i = 1; i < positions.length; i++) {
    assert.ok(positions[i] > positions[i - 1],
      order[i] + ' must load after ' + order[i - 1]);
  }
});

test('the perps feature adds ZERO new permissions', () => {
  // The permission list is the trust story; perps must not grow it. The
  // exact list is asserted by load.test.js — here we pin the deltas perps
  // could have been tempted to add. `alarms` exists since N1 (update check
  // + limit-buy TTL sweep); PERPS itself must never touch them.
  if (manifest.permissions.includes('alarms')) {
    assert.doesNotMatch(contentSrc, /chrome\.alarms/,
      'perps never reads alarms — reconciliation is on-wake only');
  }
  const war = JSON.stringify(manifest.web_accessible_resources || []);
  assert.ok(!war.includes('perps'), 'no perps module is web-accessible');
});

test('the feed talks to the venue API directly and adds no background message types', () => {
  assert.match(contentSrc, /api\.hyperliquid\.xyz/, 'direct CORS fetch (verified allow-origin: *)');
  assert.ok(!/chrome\.runtime\.sendMessage/.test(contentSrc),
    'no new background chatter: the perps surface is self-contained');
  const backgroundSrc = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  assert.ok(!/pt_perps/.test(backgroundSrc), 'background.js stays untouched by perps');
});

/* ---------------- carry: leverage is never free while you hold it ----------
 *
 * The ticket quotes a funding/borrow cost per hour before every entry. If the
 * surface never charges it, the paper position is permanently cheaper than
 * the real venue and its liquidation price never drifts the way the real one
 * does — the exact "free leverage" lesson this product exists to prevent.
 */

test('a live Jupiter position is actually charged the borrow the ticket quoted', () => {
  assert.match(contentSrc, /P\.accrueJupBorrow\(/,
    'the content script must charge Jupiter borrow, not merely display a rate');
  assert.match(contentSrc, /hourlyRateFrac: jupBorrowFrac/,
    'and it must charge the venue\'s own displayed rate');
  const fn = contentSrc.slice(
    contentSrc.indexOf('async function accrueJupBorrowLive'),
    contentSrc.indexOf('async function reconcileOnBoot'),
  );
  assert.ok(fn, 'accrueJupBorrowLive must exist');
  assert.match(fn, /if \(!Number\.isFinite\(jupBorrowFrac\)/,
    'no live rate means no charge — an invented rate is worse than an honest gap');
});

test('the observed-until stamp advances ONLY as part of applying carry', () => {
  // A bare heartbeat that stamped lastSeenMs consumed the very window the
  // funding replay reads, so an open tab paid no funding at all. The stamp
  // must therefore live inside the carry paths, and nowhere else.
  const stamps = contentSrc.match(/lastSeenMs = nowMs/g) || [];
  assert.ok(stamps.length >= 3, 'the carry paths each stamp their own settlement');
  assert.ok(!/function persistSeen/.test(contentSrc),
    'the bare heartbeat must be gone — it silently skipped the carry window');
  const carry = contentSrc.slice(
    contentSrc.indexOf('async function carryTick()'),
    contentSrc.indexOf('/* ------------------------------- UI ---'),
  );
  assert.ok(carry, 'carryTick must exist');
  assert.match(carry, /reconcileHlPosition/, 'HL settles through the venue-history reconciler');
  assert.match(carry, /accrueJupBorrowLive/, 'Jupiter accrues at the live displayed rate');
  assert.match(contentSrc, /managedInterval\(carryTick, CARRY_TICK_MS\)/,
    'and the carry must run on its own cadence, not only at boot');
});

test('funding is applied with an explicit mark, never a stale stored one', () => {
  const calls = contentSrc.match(/P\.applyHlFunding\([^;]*?\);/gs) || [];
  assert.ok(calls.length >= 2, 'both reconciler verdicts settle funding');
  for (const call of calls) {
    assert.match(call, /markPx:/,
      'the caller observes the mark; the engine must not reach into stored state for it');
  }
});

/* ---------------- entry: a blocked venue must not die silently ---------- */

test('an entry blocked on the venue API is actually retried, not abandoned', () => {
  // The location poll consumes the href BEFORE entry runs, so an entry that
  // bailed waiting on the venue was never retried — one slow or blocked API
  // call at load meant the ticket never appeared at all, forever. That is a
  // silent death, not a slow start.
  const enter = contentSrc.slice(
    contentSrc.indexOf('async function enterPage()'),
    contentSrc.indexOf('function leavePage()'),
  );
  assert.ok(enter, 'enterPage must exist');
  assert.match(enter, /venueParamsPending = true;/,
    'a bail waiting on the venue must mark itself retryable');
  assert.match(enter, /adapter = null;\s*\n\s*venueParamsPending = true;/,
    'and must clear the adapter, or the retry early-returns on the stale one');

  const poll = contentSrc.slice(
    contentSrc.indexOf('function pollLocation()'),
    contentSrc.indexOf('chrome.storage.onChanged.addListener'),
  );
  assert.match(poll, /venueParamsPending && now - lastEntryAt >= ENTRY_RETRY_MS/,
    'the poll must retry a pending entry on its own cadence');
  assert.match(poll, /ENTRY_ATTEMPTS_BEFORE_NOTICE/,
    'and after a fair chance, say so rather than stay blank');
});

test('an unmounted page keeps looking — a first failed detect is never permanent', () => {
  // These are SPAs. At document_idle the route may not have resolved, and on
  // Hyperliquid the title that NAMES the market is often not written yet. The
  // href never changes afterwards, so a detect that failed once used to stay
  // failed forever and the ticket only appeared if the user navigated — the
  // "had to refresh and click around before it popped up" report.
  const poll = contentSrc.slice(
    contentSrc.indexOf('function pollLocation()'),
    contentSrc.indexOf('chrome.storage.onChanged.addListener'),
  );
  assert.match(poll, /if \(!adapter && !venueParamsPending\) \{/,
    'while nothing is mounted the poll must keep trying');
  assert.match(poll, /if \(S\.detect\(location\.hostname, location\.pathname, document\.title\)\)/,
    'and it must re-run detection against the CURRENT title, not a cached one');
  // The cheap check gates the expensive one: detect is string matching, but
  // enterPage does storage and network work.
  //
  // Asserted on the nesting rather than on byte offsets. The previous form
  // compared indexOf('S.detect(') against indexOf('enterPage();\n      }') —
  // a literal carrying both a newline and an exact indent, so it matched
  // nothing on a CRLF checkout, indexOf returned -1, and `1670 < -1` failed on
  // every Windows clone while passing in CI. The repo now pins source to LF
  // (.gitattributes), and this no longer depends on either.
  const guarded = /if \(S\.detect\([^)]*\)\) \{\s*[^}]*?enterPage\(\);\s*\}/.test(poll);
  assert.ok(guarded,
    'detection must gate entry, not the other way round — enterPage() must sit '
    + 'INSIDE the if (S.detect(...)) block');
});

test('a market switch is caught without depending on a title observer', () => {
  // On Hyperliquid the market lives only in the title and the URL never
  // changes, so a switch is invisible to the location poll. A
  // MutationObserver catches it only while it is still attached to the live
  // <title> node — an app that REPLACES that node silently orphans it. The
  // one-second string compare needs no observer at all.
  const poll = contentSrc.slice(
    contentSrc.indexOf('function pollLocation()'),
    contentSrc.indexOf('chrome.storage.onChanged.addListener'),
  );
  assert.match(poll, /if \(adapter && adapter\.venue === 'hyperliquid'\) \{/,
    'the poll itself must check the current market');
  assert.match(poll, /if \(nowMarket && nowMarket !== adapter\.market\)/,
    'and re-enter when it changed');
  assert.ok(poll.indexOf('nowMarket !== adapter.market') < poll.indexOf('if (!adapter && !venueParamsPending)'),
    'the switch check runs while mounted, before the unmounted-retry branch');
});

test('one unreadable moment does not tear the chart down', () => {
  // leavePage() clears every drawn fill and both lines. These pages
  // re-render constantly — a title briefly without its market, a route
  // mid-redirect — so a single failed detect used to wipe the chart and the
  // user watched their marks vanish.
  const enter = contentSrc.slice(
    contentSrc.indexOf('async function enterPage()'),
    contentSrc.indexOf('function leavePage()'),
  );
  assert.match(enter, /missedDetects \+= 1;/, 'a miss is counted, not acted on');
  assert.match(enter, /if \(missedDetects >= DETECT_MISSES_BEFORE_LEAVE\) leavePage\(\);/,
    'only a sustained absence tears down');
  assert.match(enter, /missedDetects = 0;/, 'and a successful detect resets the count');
  assert.match(contentSrc, /const DETECT_MISSES_BEFORE_LEAVE = \d+;/);
});

test('a missing venue number is chased every second, not every thirty', () => {
  // A freshly loaded Jupiter page prints its borrow rate only once its app
  // renders. Reading it on the slow cadence left the ticket CLOSED for up to
  // 30s with "borrow rate unavailable", which reads as broken.
  assert.match(contentSrc, /const VENUE_PARAM_POLL_MS = 1000;/);
  assert.match(contentSrc, /managedInterval\(pollVenueParams, VENUE_PARAM_POLL_MS\)/);
  const fn = contentSrc.slice(
    contentSrc.indexOf('function pollVenueParams()'),
    contentSrc.indexOf('/* --------------------------- storage ---'),
  );
  assert.ok(fn, 'pollVenueParams must exist');
  assert.match(fn, /jupiter' && !Number\.isFinite\(jupBorrowFrac\)/,
    'chase the borrow rate only while it is missing');
  assert.match(fn, /hyperliquid' && !\(hlAssets && hlAssets\[adapter\.market\]\)/,
    'and the leverage tiers likewise');
});

test('the leverage slider only offers leverage the venue accepts', () => {
  // Jupiter refuses below 1.1x. A slider that bottoms out at 1x hands the
  // user a setting that can only ever be rejected, so the ticket reads as
  // broken when it is merely being asked for something impossible.
  const render = contentSrc.slice(contentSrc.indexOf('function render()'));
  assert.match(render, /const venueMin = adapter\.venue === 'jupiter' \? 2 : 1;/,
    'Jupiter must not offer a sub-minimum setting');
  assert.match(render, /if \(inputs\.leverage < venueMin\)/, 'and an out-of-range value is clamped up');
  assert.match(render, /if \(inputs\.leverage > venueMax\)/, 'as well as down');
  assert.match(render, /els\.lev\.min !== String\(venueMin\)/, 'the control itself carries the floor');
});

test('a known borrow rate survives an unlucky read', () => {
  // The venue re-renders its header; a single blank read must not close a
  // ticket that was open a moment ago.
  assert.match(contentSrc, /if \(Number\.isFinite\(seen\)\) jupBorrowFrac = seen;/,
    'only a real reading may replace a real reading');
});

test('a venue that never answers produces a visible reason, not an empty page', () => {
  assert.match(contentSrc, /venueUnreachable = true/,
    'the unreachable state must be recorded');
  assert.match(contentSrc, /not answering from this network/,
    'and rendered as a calm, specific message the user can act on');
  // It must still refuse to trade — an unreachable venue cannot price a fill.
  const block = contentSrc.slice(contentSrc.indexOf('if (venueUnreachable'));
  assert.match(block.slice(0, 700), /openBtn\.disabled = true/,
    'an unreachable venue must not leave the open button live');
});

/* ---------------- fill feedback: confirmation, not decoration ---------- */

test('effects fire on the FILL, never on the click', () => {
  const onOpen = contentSrc.slice(
    contentSrc.indexOf('function onOpen()'),
    contentSrc.indexOf('function onClose('),
  );
  assert.ok(onOpen, 'onOpen must exist');
  // The effect must sit inside the applyOp callback, after the ok check —
  // celebrating a click that storage then refused would assert a position
  // the user does not have.
  const afterApply = onOpen.slice(onOpen.indexOf('applyOp('));
  assert.match(afterApply, /if \(r && !r\.ok\) \{[^}]*return; \}/,
    'a refused open must bail before any confirmation');
  assert.ok(afterApply.indexOf('runPerpEffect') > afterApply.indexOf('!r.ok'),
    'the effect must come after the refusal check, not before');
  assert.ok(!/runPerpEffect/.test(onOpen.slice(0, onOpen.indexOf('applyOp('))),
    'nothing may fire before the write is attempted');
});

test('a liquidation never celebrates', () => {
  // Confetti for a margin call is the product congratulating a user for
  // losing everything.
  const watch = contentSrc.slice(
    contentSrc.indexOf('function watchLiquidations()'),
    contentSrc.indexOf('/* ---------------------------- fill feedback'),
  );
  assert.ok(watch, 'watchLiquidations must exist');
  assert.match(watch, /playPerpSound\('liquidation'\)/, 'it is announced');
  assert.ok(!/runPerpEffect/.test(watch),
    'but never with the celebration burst');
});

test('fill feedback obeys the same two settings as the spot overlay', () => {
  assert.match(contentSrc, /tradeEffectsEnabled/, 'effects share the spot toggle');
  assert.match(contentSrc, /tradeSoundsEnabled/, 'sounds share the spot toggle');
  assert.match(contentSrc, /changes\.pt_settings\) loadUiSettings\(\)/,
    'and a toggle change must take effect without a reload');
});

test('the content script honors the orphaned-script doctrine', () => {
  assert.match(contentSrc, /chrome\.runtime\.id/, 'context-invalidation guard');
  assert.match(contentSrc, /visibilityState/, 'intervals defer while hidden');
});

test('storage writes are revision-guarded, and tick state persists lazily', () => {
  assert.match(contentSrc, /rev/, 'revision-guarded read-modify-write');
  assert.ok(!/set\(\{ \[STORE_KEY\][^}]*\}\)[\s\S]{0,80}onTitle/.test(contentSrc),
    'no storage write on the tick path');
});
