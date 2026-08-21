/* Market-cap alerts — "tell me when it hits 500K".
 *
 * Requested by a user (meestershrek) as "alert above / alert below". What
 * separates an alert from the take-profit / stop-loss orders it resembles,
 * and what is locked here:
 *
 *   - AN ALERT NEEDS NO POSITION. addOrder refuses a mint with nothing
 *     behind it; addAlert must not, because the token you most want a ping
 *     on is the one you have not bought yet. This map IS the watchlist.
 *   - AN ALERT IS COMPARED IN MARKET CAP. Orders are deliberately
 *     price-anchored because a FILL must be reproducible under a moving
 *     supply figure. An alert claims no fill, and the trader asked their
 *     question in market cap, so the cap is the compared quantity.
 *   - IT FIRES ONCE. An alert that re-fired every tick above its level
 *     trains the trader to ignore it, which is worse than no alert at all.
 *   - ONE PING PER LEVEL, not one per open terminal tab.
 *
 * The delivery channel is the HOST PAGE's notification permission — the same
 * road the terminals' own alerts travel, and the reason this feature adds no
 * extension permission. That road is only sometimes open, so the tests below
 * are strict about what happens when it is shut: presence of a Notification
 * constructor is not permission to use one (F-39), and a page that hands
 * back a throwing stub must be treated as having none.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');

global.window = global.window || {};
require('../engine.js');
const E = global.window.PaperEngine;

const ROOT = path.join(__dirname, '..');
const MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const OTHER = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const T0 = 1_700_000_000_000;

const CONTENT = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');

/** A wallet with nothing in it — the normal case for an alert. */
function emptyWallet() {
  const settings = E.mergeSettings(null);
  return { state: E.defaultState(settings), settings };
}

/** Arm one alert and hand back the object the engine stored. */
function arm(state, kind, mcap, ref) {
  return E.addAlert(state, MINT, { kind, mcap, symbol: 'BONK' }, ref, T0);
}

/* ---------------- arming ---------------- */

test('an alert needs no position behind it — that is the whole point', () => {
  const { state } = emptyWallet();
  assert.equal(Object.keys(state.positions).length, 0);

  const alert = arm(state, 'above', 500_000, { mcap: 210_000, priceNative: 0.001 });
  assert.equal(alert.kind, 'above');
  assert.equal(alert.mcap, 500_000);
  assert.deepEqual(E.alertMints(state), [MINT],
    'a watched mint with no position must still reach the poller work list');

  // The contrast that makes the rule worth a test: the same wallet cannot
  // arm an ORDER on that mint, because an order has something to sell.
  assert.throws(() => E.addOrder(state, MINT, { kind: 'sl', triggerPrice: 0.0005 }, 0.001, T0),
    /No open paper position/);
});

test('a level already behind the market is refused, not armed', () => {
  const { state } = emptyWallet();
  const ref = { mcap: 600_000, priceNative: 0.001 };

  // Both of these would fire on the very next poll — a notification with
  // extra steps, not an alert.
  assert.throws(() => arm(state, 'above', 500_000, ref), /already behind the market/);
  assert.throws(() => arm(state, 'below', 700_000, ref), /already behind the market/);
  // And the refusal says what the market actually reads, so the number the
  // user has to beat is not a guessing game.
  assert.throws(() => arm(state, 'above', 500_000, ref), /\$600\.0K/);

  assert.ok(arm(state, 'above', 700_000, ref));
  assert.ok(arm(state, 'below', 500_000, ref));
});

test('an alert arms fine when the market cap is not yet known', () => {
  const { state } = emptyWallet();
  // No reference cap means nothing to contradict — refusing here would make
  // a brand-new pair, the exact case people want alerts for, un-armable.
  const alert = arm(state, 'above', 500_000, { mcap: null, priceNative: null });
  assert.equal(alert.mcap, 500_000);
  assert.equal(alert.basisPrice, null);
  assert.equal(alert.armedAtMcap, null);
});

test('junk never arms', () => {
  const ref = { mcap: 100_000, priceNative: 0.001 };
  assert.equal(E.normalizeAlert(null, ref, T0), null);
  assert.equal(E.normalizeAlert({ kind: 'sideways', mcap: 5e5 }, ref, T0), null);
  assert.equal(E.normalizeAlert({ kind: 'above', mcap: 0 }, ref, T0), null);
  assert.equal(E.normalizeAlert({ kind: 'above', mcap: NaN }, ref, T0), null);
  assert.equal(E.normalizeAlert({ kind: 'above', mcap: -5e5 }, ref, T0), null);
});

test('the per-token cap counts only alerts still waiting', () => {
  const { state } = emptyWallet();
  const ref = { mcap: 100_000, priceNative: 0.001 };
  const armed = [];
  for (let i = 1; i <= E.MAX_ALERTS_PER_MINT; i++) armed.push(arm(state, 'above', 100_000 * (i + 1), ref));
  assert.throws(() => arm(state, 'above', 9e9, ref), /At most/);

  // A fired alert is history, not an occupied slot.
  E.markAlertFired(state, MINT, armed[0].id, T0, { mcap: 9e9 });
  assert.ok(arm(state, 'above', 9e9, ref), 'a fired alert must free its slot');
});

/* ---------------- firing ---------------- */

test('above fires at or above its level, below at or below', () => {
  const { state } = emptyWallet();
  const ref = { mcap: 300_000, priceNative: 0.001 };
  const hi = arm(state, 'above', 500_000, ref);
  const lo = arm(state, 'below', 100_000, ref);

  assert.deepEqual(E.triggeredAlerts(state, MINT, { mcap: 499_999 }).map((a) => a.id), []);
  assert.deepEqual(E.triggeredAlerts(state, MINT, { mcap: 500_000 }).map((a) => a.id), [hi.id],
    'the level itself counts as reached');
  assert.deepEqual(E.triggeredAlerts(state, MINT, { mcap: 100_000 }).map((a) => a.id), [lo.id]);
  // A crash straight through both is allowed to trip only the one it crossed.
  assert.deepEqual(E.triggeredAlerts(state, MINT, { mcap: 50_000 }).map((a) => a.id), [lo.id]);
});

test('a crossed level fires once and only once', () => {
  const { state } = emptyWallet();
  const alert = arm(state, 'above', 500_000, { mcap: 300_000, priceNative: 0.001 });
  const hit = { mcap: 720_000 };

  assert.equal(E.triggeredAlerts(state, MINT, hit).length, 1);
  assert.equal(E.markAlertFired(state, MINT, alert.id, T0, hit), true);

  // Still above the level on every later poll, and silent on all of them.
  assert.deepEqual(E.triggeredAlerts(state, MINT, hit), []);
  assert.deepEqual(E.triggeredAlerts(state, MINT, { mcap: 5_000_000 }), []);
  assert.deepEqual(E.armedAlertsFor(state, MINT), []);
  assert.deepEqual(E.alertMints(state), [],
    'a fired alert must stop costing a slot in the batch request');
});

test('two tabs racing the same level produce one ping, not two', () => {
  const { state } = emptyWallet();
  const alert = arm(state, 'above', 500_000, { mcap: 300_000, priceNative: 0.001 });
  const hit = { mcap: 640_000 };

  // Both tabs read "not yet fired" and both try to claim it. markAlertFired
  // returning false IS the losing tab being told to stay quiet.
  assert.equal(E.markAlertFired(state, MINT, alert.id, T0, hit), true, 'first claim wins');
  assert.equal(E.markAlertFired(state, MINT, alert.id, T0 + 5, hit), false, 'second claim loses');

  // Idempotent: a replayed claim cannot re-ping or rewrite the reading.
  assert.equal(E.alertsFor(state, MINT)[0].firedAt, T0);
  assert.equal(E.alertsFor(state, MINT)[0].firedAtMcap, 640_000);
});

test('the cap that actually tripped it is recorded beside the one asked for', () => {
  const { state } = emptyWallet();
  const alert = arm(state, 'above', 500_000, { mcap: 210_000, priceNative: 0.001 });
  // A memecoin does not stop politely at the level. Same both-numbers rule a
  // gapped stop follows: what you asked for AND what the market did.
  E.markAlertFired(state, MINT, alert.id, T0, { mcap: 1_180_000 });

  const stored = E.alertsFor(state, MINT)[0];
  assert.equal(stored.mcap, 500_000, 'the level asked for survives');
  assert.equal(stored.firedAtMcap, 1_180_000, 'the reading that tripped it is kept');
  assert.equal(stored.armedAtMcap, 210_000, 'and where it started');
});

/* ---------------- what gets compared ---------------- */

test('a live market cap is what decides, not a price frozen at arm time', () => {
  const { state } = emptyWallet();
  arm(state, 'above', 500_000, { mcap: 250_000, priceNative: 0.001 });

  // Supply doubled: the same unit price now represents twice the cap. The
  // trader asked about the CAP, so this must fire even though the price has
  // not reached the arm-time basis. Comparing the stored basis price here —
  // the rule chart orders correctly use — would answer a question nobody
  // asked and stay silent through a level the whole market can see.
  assert.equal(E.triggeredAlerts(state, MINT, { mcap: 520_000, priceNative: 0.0013 }).length, 1,
    'a cap past the level must fire regardless of where the unit price sits');
});

test('the arm-time basis stands in only when a quote carries no cap', () => {
  const { state } = emptyWallet();
  const alert = arm(state, 'above', 500_000, { mcap: 250_000, priceNative: 0.001 });
  // 500K is 2x the 250K it was armed at, so the basis price is 2x too.
  assert.equal(alert.basisPrice, 0.002);

  assert.equal(E.triggeredAlerts(state, MINT, { priceNative: 0.0019 }).length, 0);
  assert.equal(E.triggeredAlerts(state, MINT, { priceNative: 0.002 }).length, 1,
    'a source that quotes a price but no cap must still be able to fire the alert');
});

test('an observation carrying no usable number trips nothing', () => {
  const { state } = emptyWallet();
  arm(state, 'below', 100_000, { mcap: 300_000, priceNative: 0.001 });

  // A missing number must never read as a crossed level — this is the shape
  // of every "my stop fired at zero" bug.
  for (const junk of [null, undefined, {}, { mcap: 0 }, { mcap: null, priceNative: null },
    { mcap: NaN }, { priceNative: 0 }]) {
    assert.deepEqual(E.triggeredAlerts(state, MINT, junk), [],
      `${JSON.stringify(junk)} must not fire a below-alert`);
  }
});

test('alerts are per token and disarm independently', () => {
  const { state } = emptyWallet();
  const ref = { mcap: 300_000, priceNative: 0.001 };
  const a = arm(state, 'above', 500_000, ref);
  E.addAlert(state, OTHER, { kind: 'above', mcap: 500_000 }, ref, T0);

  assert.deepEqual(E.alertMints(state).sort(), [MINT, OTHER].sort());
  assert.equal(E.removeAlert(state, MINT, a.id), true);
  assert.equal(E.removeAlert(state, MINT, a.id), false, 'removing twice is not a second removal');
  assert.deepEqual(E.alertMints(state), [OTHER]);
  assert.deepEqual(E.alertsFor(state, MINT), [], 'an emptied mint leaves no husk behind');
});

/* ---------------- the panel's own helpers ----------------
 *
 * content.js is one large IIFE with no export surface, so these two are
 * lifted out of its source and run against fakes. That is worth the trouble
 * here because they are the functions that decide whether a ping is
 * DELIVERED, and a regex over the source cannot tell a working fallback from
 * a broken one. */

/** Lift `function name(...) {...}` out of a source file by brace matching. */
function sliceFunction(src, name) {
  let start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `content.js no longer defines ${name}()`);
  // Keep an `async` prefix, or the slice is a plain function full of `await`
  // and fails to parse — a confusing way to learn the source moved.
  if (src.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}()`);
}

function loadPanelHelpers(fakeWindow, settings) {
  const ctx = vm.createContext({
    window: fakeWindow, settings: settings || {},
    Number, String, Math, JSON, RegExp, Boolean,
  });
  vm.runInContext(
    [sliceFunction(CONTENT, 'parseCapInput'),
      sliceFunction(CONTENT, 'notificationCtor'),
      sliceFunction(CONTENT, 'desktopAlertState'),
      'globalThis.H = { parseCapInput, notificationCtor, desktopAlertState };',
    ].join('\n'), ctx);
  return ctx.H;
}

test('a market cap is read the way a trader types one', () => {
  const H = loadPanelHelpers({});
  assert.equal(H.parseCapInput('500k'), 500_000);
  assert.equal(H.parseCapInput('500K'), 500_000);
  assert.equal(H.parseCapInput('  $1.2M '), 1_200_000);
  assert.equal(H.parseCapInput('850000'), 850_000);
  assert.equal(H.parseCapInput('1,200,000'), 1_200_000, 'commas as thousands separators');
  assert.equal(H.parseCapInput('2,4M'), 2_400_000, 'comma as a decimal separator');
  assert.equal(H.parseCapInput('1.5b'), 1_500_000_000);
});

test('a bare number is never silently promoted to thousands', () => {
  const H = loadPanelHelpers({});
  // Reading "500" as 500K would arm a level a thousand times from the one
  // that was typed, and the user would never know until it did not fire.
  assert.equal(H.parseCapInput('500'), 500);
  for (const junk of ['', '   ', 'moon', '5x', 'k', '-500k', '1.2.3', 'NaN', null, undefined, 500]) {
    assert.equal(H.parseCapInput(junk), null, `${JSON.stringify(junk)} must not parse as a cap`);
  }
});

test('a Notification constructor that only LOOKS available is not used', () => {
  // F-39, again: presence is not capability. Each of these pages would throw
  // — or silently do nothing — at the moment an alert fired, which is the
  // worst possible time to find out.
  assert.equal(loadPanelHelpers({}).desktopAlertState(), 'unavailable',
    'a page with no Notification at all');
  assert.equal(loadPanelHelpers({ Notification: {} }).desktopAlertState(), 'unavailable',
    'a non-callable stub is not a constructor');
  assert.equal(loadPanelHelpers({ Notification: 'granted' }).desktopAlertState(), 'unavailable',
    'a string is not a constructor');

  // A page that traps property access on window must not take the panel down.
  const hostile = new Proxy({}, { get() { throw new Error('blocked by the page'); } });
  assert.equal(loadPanelHelpers(hostile).desktopAlertState(), 'unavailable');

  // And a constructor whose .permission getter throws.
  const ctor = function () {};
  Object.defineProperty(ctor, 'permission', { get() { throw new Error('nope'); } });
  assert.equal(loadPanelHelpers({ Notification: ctor }).desktopAlertState(), 'unavailable');
});

test('the real permission states are reported as themselves', () => {
  const withPermission = (p) => {
    const ctor = function () {};
    ctor.permission = p;
    return loadPanelHelpers({ Notification: ctor }).desktopAlertState();
  };
  assert.equal(withPermission('granted'), 'granted');
  assert.equal(withPermission('denied'), 'denied');
  assert.equal(withPermission('default'), 'default');
  // Anything unrecognized is treated as "not yet granted", never as granted.
  assert.equal(withPermission(undefined), 'default');
  assert.equal(withPermission('yes-please'), 'default');
});

/* ---------------- re-entrancy ---------------- */

/**
 * Run the panel's real evaluateMcAlerts against a controllable withState.
 *
 * One withState call == one full state read in the live extension, so
 * counting opens is counting the reads this guard exists to prevent.
 */
function loadAlertEvaluator(state, withState) {
  const ctx = vm.createContext({
    E, state, withState, Set, Promise, Date, Number,
    alertClaimsInFlight: new Set(),
    mcAlertsOn: () => true,
    persistStateNow: async () => {},
    announceMcAlert: () => { ctx.announced++; },
    renderAlerts: () => {},
    announced: 0,
  });
  vm.runInContext(sliceFunction(CONTENT, 'evaluateMcAlerts')
    + '\nglobalThis.run = evaluateMcAlerts;', ctx);
  return ctx;
}

test('a level crossed on three ticks in a row is claimed once, not three times', async () => {
  const { state } = emptyWallet();
  arm(state, 'above', 500_000, { mcap: 300_000, priceNative: 0.001 });
  const hit = { mcap: 640_000 };

  // Hold the claim open the way a real storage round trip does, so all three
  // ticks land inside the window where the alert is still "due".
  let opens = 0;
  let release;
  const held = new Promise((r) => { release = r; });
  const ctx = loadAlertEvaluator(state, async (fn) => { opens++; await held; return fn(); });

  const ticks = [ctx.run(MINT, hit), ctx.run(MINT, hit), ctx.run(MINT, hit)];
  assert.equal(opens, 1,
    `three ticks across one level opened ${opens} state reads; only the first may pay`);
  release();
  await Promise.all(ticks);

  assert.equal(ctx.announced, 1, 'and the trader is pinged exactly once');
  assert.equal(E.alertsFor(state, MINT)[0].firedAt > 0, true);
});

test('a claim that throws leaves the level armed and retryable', async () => {
  const { state } = emptyWallet();
  arm(state, 'above', 500_000, { mcap: 300_000, priceNative: 0.001 });
  const hit = { mcap: 640_000 };

  // A flag left set by a failed write would strand the alert forever — the
  // level would stay armed and never be looked at again.
  let opens = 0;
  const ctx = loadAlertEvaluator(state, async () => {
    opens++;
    throw new Error('storage unavailable');
  });

  await assert.rejects(() => ctx.run(MINT, hit), /storage unavailable/);
  assert.equal(E.triggeredAlerts(state, MINT, hit).length, 1, 'the level is still armed');
  await assert.rejects(() => ctx.run(MINT, hit), /storage unavailable/);
  assert.equal(opens, 2, 'the retry must actually re-attempt, not be swallowed by a stuck flag');
});

test('one coin firing does not stall another coin waiting on the same pass', async () => {
  const { state } = emptyWallet();
  const ref = { mcap: 300_000, priceNative: 0.001 };
  arm(state, 'above', 500_000, ref);
  E.addAlert(state, OTHER, { kind: 'above', mcap: 500_000, symbol: 'WIF' }, ref, T0);
  const hit = { mcap: 640_000 };

  // The batch poller walks several mints per pass. A single global latch —
  // the shape evaluateChartOrders can afford, because it only ever handles
  // the token on screen — would drop the second coin's ping to the next poll.
  let opens = 0;
  let release;
  const held = new Promise((r) => { release = r; });
  const ctx = loadAlertEvaluator(state, async (fn) => { opens++; await held; return fn(); });

  const passes = [ctx.run(MINT, hit), ctx.run(OTHER, hit)];
  assert.equal(opens, 2, 'two different coins must each get their own claim');
  release();
  await Promise.all(passes);
  assert.equal(ctx.announced, 2, 'both coins ping on the same pass');
});

/* ---------------- wiring ---------------- */

test('alert mints ride the batch request the positions bar already sends', () => {
  // The reach the feature was asked for: a level fires while you are looking
  // at a different chart. That works because watched mints join the poll
  // that is already going out — no background alarm, no second network path.
  assert.match(CONTENT, /const alertMints = !mcAlertsOn\(\) \? \[\] :\s*\n\s*E\.alertMints\(state\)/,
    'the poller must build its alert work list from the engine');
  assert.match(CONTENT, /const mints = positionMints\.concat\(watchMints, alertMints\);/,
    'alert mints must be part of the SAME batch request');
  assert.match(CONTENT, /if \(settings\.positionsBarEnabled === false && !postWatchActive\(\) && !alertsActive\(\)\) return;/,
    'an armed alert must keep the poller alive even with the positions bar off');
});

test('the chart on screen is judged too, not only the ones in the batch', () => {
  // The on-screen token is deliberately excluded from the batch poller, so
  // without this the one chart you are actually watching is the one that
  // never pings. (N2's evaluatePendingBuys sits between them — both are
  // tick-path judges; the order among them is not the property.)
  assert.match(CONTENT, /evaluateChartOrders\(\);\s*\n\s*\/\/[^\n]*\n\s*evaluatePendingBuys\(\);\s*\n\s*\/\/[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*evaluateMcAlerts\(token\.mint, token\);/,
    'the tick path must judge the on-screen token');
  assert.match(CONTENT, /evaluateMcAlerts\(token\.mint, token\);\s*\n\s*\/\/ C-01/,
    'an adopted resolver quote must judge it too');
});

test('the ping carries a per-alert tag so tabs cannot double it', () => {
  assert.match(CONTENT, /tag: `pt-mc-\$\{alert\.id\}`/,
    'same-tag notifications replace rather than stack — that is what closes '
    + 'the residual race between two tabs claiming one level');
});

test('the panel says it whether or not the desktop notification landed', () => {
  const announce = sliceFunction(CONTENT, 'announceMcAlert');
  assert.match(announce, /postDesktopAlert\(/);
  assert.match(announce, /toast\(/, 'the panel toast must be unconditional');
  assert.doesNotMatch(announce, /if\s*\(!?\s*posted\s*\)[^\n]*\n?\s*toast\(/,
    'the toast must not be gated on the notification having failed — a '
    + 'notification can be posted straight into Do-Not-Disturb and never seen');
});

test('a fired alert is never re-armed by the code that renders it', () => {
  // The list shows fired alerts struck through until they are cleared; that
  // display must not be able to resurrect one.
  const paint = sliceFunction(CONTENT, 'paintAlertList');
  assert.doesNotMatch(paint, /firedAt\s*=/, 'the renderer must never write firedAt');
  assert.match(paint, /a\.firedAt && a\.firedAtMcap/,
    'a fired row reports the cap that tripped it beside the level asked for');
});

test('the feature asks for no new extension permission', () => {
  // The delivery channel is the host page's own notification grant. If this
  // ever regresses to chrome.notifications the Web Store listing needs a new
  // justification, and that must not happen silently.
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  assert.ok(!manifest.permissions.includes('notifications'),
    'market-cap alerts must not add the notifications permission');
  // N1 (8/21) added `alarms` for the update check + limit-buy TTL sweep.
  // Alerts themselves still ride the existing tick/poller path — this lock
  // pins THAT: an alarm handler that fires alerts would be the regression.
  const bg = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  assert.doesNotMatch(bg, /pt_.*alarm[\s\S]{0,400}evaluateMcAlerts/,
    'no alarm handler may drive market-cap alerts — they ride the poller');
  assert.doesNotMatch(CONTENT, /chrome\.notifications/,
    'the content script must deliver through the page, not the extension API');
});
