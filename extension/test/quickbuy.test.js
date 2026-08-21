/* One-click quick buy — tapping a preset amount fires the order immediately,
 * like Axiom and Padre, instead of only selecting it for the BUY button.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const E = require('../engine.js');

const ROOT = path.join(__dirname, '..');
const content = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
const dashJs = fs.readFileSync(path.join(ROOT, 'dashboard.js'), 'utf8');

test('instant buy defaults on and old settings merge to it', () => {
  assert.equal(E.DEFAULT_SETTINGS.instantBuyEnabled, true);
  assert.equal(E.mergeSettings({}).instantBuyEnabled, true,
    'an install from before the setting must land on the one-click default');
  assert.equal(E.mergeSettings({ instantBuyEnabled: false }).instantBuyEnabled, false,
    'a deliberate opt-out is never overridden');
});

test('preset taps route through the shared buy path when instant is on', () => {
  // The same requestBuy() must serve both the preset tap and the BUY button,
  // so arming for unresolved tokens and the in-flight guard apply to both.
  assert.match(content, /if \(instant\) requestBuy\(Number\(b\.dataset\.amt\)\)/,
    'a preset tap must fire the order when one-click quick buy is enabled');
  assert.match(content, /if \(!\(amt > 0\)\) return toast\(panelUsd\(\) \? 'Pick a dollar amount first' : 'Pick a SOL amount first'\);\s*\n\s*requestBuy\(amt\);/,
    'the BUY button must use the same shared path (currency-aware refusal)');
  assert.match(content, /let buyInFlight = false;/,
    'rapid taps must be guarded against stacking fills');
  assert.match(content, /buyInFlight = true;\s*\n\s*doBuy\(solAmount, quotedUsd\)\.finally\(\(\) => \{ buyInFlight = false; \}\);/,
    'the guard must release when the buy settles');
});

/* ---------------- foreign-chain dollar quick buys ---------------- */

test('foreign-chain panels quick-buy in DOLLARS at the recorded rate', () => {
  // Venue truth, read off the live BNB token panel 2026-08-05: fomo's own
  // quick buys are $10/$100/$500/$1000 with a $-prefixed amount box — every
  // non-Solana chain is priced in USD there. The paper panel mirrors the
  // venue: chips carry panel units, requestBuy converts ONCE at the
  // token's RECORDED solUsdAtResolve rate, and a missing rate is an honest
  // refusal — never a guessed conversion.
  assert.match(content, /return Boolean\(token && token\.chain && token\.chain !== 'solana'\);/,
    'the dollar panel is exactly the foreign-chain panel');
  assert.match(content, /const rate = Number\(token && token\.solUsdAtResolve\);/,
    'conversion uses the recorded rate, not a fresh guess');
  assert.match(content, /solAmount = amt \/ rate;/,
    'the tapped dollars become SOL book units before the engine sees them');
  assert.match(content, /No SOL\/USD rate for this chain — paper buy refused/,
    'a rateless record refuses instead of filling');
  assert.match(content, /usdMode \? `\$\$\{a\}` : `\$\{a\} SOL`/,
    'chips print the venue currency ($10, not 10 SOL) on foreign chains');
});

test('a dollar buy on a still-resolving token arms in dollars and converts at fire time', () => {
  assert.match(content, /armedBuy = \{ amount: solAmount, usd: quotedUsd, at: Date\.now\(\), mint: token\.mint \};/,
    'the armed intent remembers the currency it was placed in');
  assert.match(content, /amount = armedUsd \/ rate;/,
    'the fire-time quote brings the rate the click-time conversion lacked');
  assert.match(content, /if \(!guard\.ok\) \{ toast\(guard\.message\); return; \}/,
    'the guard deferred at request time must run at fire time');
});

test('a fill made off-chart appears when the chart is entered — and never draws twice', () => {
  // Maintainer report: row-snipe a coin from a list page, open its chart —
  // bubble and average line must be there on load-in. Two halves: resolve
  // replays the journal (page entry), and ADOPTION replays it too (fill
  // landed from another tab while this chart was open). Idempotence rides
  // drawnFillIds, which forgets exactly when the bridge is told to forget.
  const adoptAt = content.indexOf('function adoptState(');
  assert.ok(adoptAt !== -1);
  const adoptBlock = content.slice(adoptAt, content.indexOf('\n  }', adoptAt) + 4);
  assert.match(adoptBlock, /restoreMarkersFromJournal\(\);/,
    'adopting external state must replay new fills onto the open chart');
  const restoreAt = content.indexOf('function restoreMarkersFromJournal(');
  const restoreBlock = content.slice(restoreAt, content.indexOf('\n  }', restoreAt) + 4);
  assert.match(restoreBlock, /if \(f\.id && drawnFillIds\.has\(f\.id\)\) continue;/,
    'replay must skip fills already on this chart');
  const liveNotes = content.match(/drawnFillIds\.add\((?:filled\.)?trade\.id\);/g) || [];
  assert.ok(liveNotes.length >= 2,
    'live buy AND sell paths must register their fills with the replay ledger');
  const clears = content.match(/drawnFillIds\.clear\(\);/g) || [];
  assert.ok(clears.length >= 5,
    'every bridge marker-clear site must also clear the replay ledger — token switch, no-token, SVG handoff, wallet reset, teardown');
});

test('the engine defaults the USD ladder and records the dollars the trader tapped', () => {
  assert.deepEqual(E.DEFAULT_SETTINGS.presetsBuyUsd, [10, 100, 500, 1000],
    'the default USD ladder is the venue\'s own');
  assert.deepEqual(E.mergeSettings({}).presetsBuyUsd, [10, 100, 500, 1000],
    'installs from before the setting must land on the venue ladder');
  const settings = E.defaultSettings();
  const state = E.defaultState(settings);
  const { trade } = E.buy(state, settings, {
    ts: 1_800_000_000_000, mint: '0x' + 'a'.repeat(40), symbol: 'MC', site: 'fomo',
    priceNative: 0.00025, priceUsd: 0.05, chain: 'bnb', solAmount: 0.5, quotedUsd: 100,
  });
  assert.equal(trade.quotedUsd, 100, 'receipts must echo the order as it was placed');
  const sol = E.buy(state, settings, {
    ts: 1_800_000_060_000, mint: 'So11111111111111111111111111111111111111112',
    symbol: 'SOL', site: 'padre', priceNative: 1, solAmount: 1,
  });
  assert.equal(sol.trade.quotedUsd, undefined, 'SOL panels never carry a dollar quote');
});

test('the settings page exposes the one-click toggle', () => {
  assert.match(dashJs, /id="set-instant-buy"/);
  assert.match(dashJs, /instantBuyEnabled: document\.getElementById\('set-instant-buy'\)\.checked/,
    'the toggle must be persisted with the rest of the settings');
});

test('the quick-buy controls live in their own labeled card (discoverability)', () => {
  // Reported: a user could not FIND the QB toggle. The controls existed but
  // were buried mid-list inside "Wallet & Trading". They live in one card —
  // renamed "Buying" in the Wave-1 de-jargon pass (UI-OVERHAUL.md).
  const cardOpen = dashJs.indexOf('<h3>Buying</h3>');
  assert.ok(cardOpen !== -1, 'a "Buying" settings card must exist');
  // Every QB control must come AFTER the card heading (i.e. inside the card,
  // not scattered elsewhere in the page).
  for (const id of ['set-presets', 'set-instant-buy', 'set-list-quick-buy', 'set-panel-buy', 'set-panel-presets']) {
    const at = dashJs.indexOf(`id="${id}"`);
    assert.ok(at !== -1, `${id} must exist`);
    assert.ok(at > cardOpen, `${id} must live inside the Buying card`);
  }
});

/* ---------------- screener row quick buys ---------------- */

const sites = fs.readFileSync(path.join(ROOT, 'sites.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'content.css'), 'utf8');

test('row quick-buy chips are configured for Axiom, Padre and GMGN screener pages', () => {
  // Axiom Pulse / Discover rows link to /meme/<pair> and carry pump.fun icons;
  // the chip sits left of the site's own instant-buy button.
  assert.match(sites, /linkSelectors: \['a\[href\^="\/meme\/"\]', 'a\[href\*="pump\.fun\/coin\/"\]'/);
  assert.match(sites, /placement: 'before-buy-button'/);
  // GMGN Trenches cards navigate by JS but carry /sol/token/ + pump.fun links.
  assert.match(sites, /linkSelectors: \['a\[href\*="\/sol\/token\/"\]', 'a\[href\*="pump\.fun\/coin\/"\]'/);
  // Padre Trenches cards link absolutely to /trade/solana/<mint>.
  assert.match(sites, /linkSelectors: \['a\[href\*="\/trade\/solana\/"\]', 'a\[href\*="pump\.fun\/coin\/"\]'/);
  // Badge placement keeps the chip off the cards' content entirely.
  assert.match(sites, /placement: 'badge'/);
  // Coverage: icon-cluster links also carry the address (solscan).
  assert.match(sites, /solscan\.io\/token/);
  // Each is gated to its screener paths, never the chart pages.
  assert.match(sites, /listPaths:[\s\S]{0,40}pulse\|discover/);
});

test('row buys run the full fill pipeline and never navigate the row', () => {
  const bridge = fs.readFileSync(path.join(ROOT, 'price-bridge.js'), 'utf8');
  assert.match(content, /function scanRowBuys\(\)/);
  assert.match(content, /function doRowBuy\(/);
  // The MAIN-world bridge owns row scanning: only it can read React fibers.
  assert.match(bridge, /function scanScreenerRows\(spec\)/);
  assert.match(bridge, /function addressFromRowFiber\(row\)/);
  // Chips forward their tap back to the content script's fill pipeline.
  assert.match(bridge, /emit\('row-buy', \{ address: entry\.address \}\)/);
  assert.match(content, /ev\.type === 'row-buy'/);
  // The chip shows a busy state until the content script settles the fill.
  assert.match(bridge, /type === 'row-buy-done'/);
  assert.match(content, /sendPadreMarker\('row-buy-done', null\)/);
  // Taps are seen at the WINDOW capture phase, registered at document_start:
  // Padre installs its own capturing click handler that stops propagation,
  // so a listener on the chip element itself never fires.
  assert.match(bridge, /function handleRowChipTap\(ev\)/);
  assert.match(bridge, /window\.addEventListener\(type, handleRowChipTap, true\)/);
  assert.match(bridge, /\['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click'\]/,
    'press events must be swallowed so the row never navigates from a chip tap');
  // The tap must not trigger the row's own navigation or click handlers.
  assert.match(bridge, /ev\.preventDefault\(\);\s*\n\s*ev\.stopPropagation\(\);\s*\n\s*ev\.stopImmediatePropagation\(\);/);
  // The fill goes through the engine and the attestation chain, like any buy.
  // (Window widened when the D-38 CHAIN leg — rowChainQuote — joined the
  // cascade: a new-coin row is priced straight from the pool/curve on-chain.)
  assert.match(content, /doRowBuy[\s\S]{0,3400}E\.buy\(state, settings/);
  assert.match(content, /doRowBuy[\s\S]{0,3400}commitFill\(filled\.trade\)/);
  // The screener's own realtime price is preferred when fresh.
  assert.match(content, /recentRowPrices/);
  // The new position surfaces immediately in the rail. (Window widened when
  // the F-04 freshness fix added its rationale comment to doRowBuy, and again
  // when the D-38 cascade — fresh resolve → display cache → row-feed price —
  // grew the body so a just-launched coin fills the instant its row prints.)
  assert.match(content, /doRowBuy[\s\S]{0,4700}renderPositionsBar\(\)/);
  // The scanner runs on the positions-bar cadence, which works on pages with
  // no detected token — exactly the screener situation.
  assert.match(content, /renderPositionsBar\(\);\s*\n\s*\/\/ Screener rows render continuously; catch new ones on this cadence\.\s*\n\s*scanRowBuys\(\);/);
});

test('the row chip is styled for the page DOM and has a settings toggle', () => {
  assert.match(css, /\.pt-rowbuy \{/);
  assert.match(css, /\.pt-rowbuy\.busy/);
  assert.equal(E.DEFAULT_SETTINGS.listQuickBuyEnabled, true);
  assert.equal(E.mergeSettings({}).listQuickBuyEnabled, true);
  assert.equal(E.DEFAULT_SETTINGS.listQuickBuySize, 1.0);
  assert.equal(E.mergeSettings({}).listQuickBuySize, 1.0);
  assert.match(dashJs, /id="set-list-quick-buy"/);
  assert.match(dashJs, /listQuickBuyEnabled: document\.getElementById\('set-list-quick-buy'\)\.checked/);
  assert.match(dashJs, /id="set-list-quick-buy-size"/);
  assert.match(dashJs, /listQuickBuySize:/);
});

test('the row scan carries the user-chosen chip size to the bridge', () => {
  const bridge = fs.readFileSync(path.join(ROOT, 'price-bridge.js'), 'utf8');
  assert.match(content, /sendPadreMarker\('row-scan', \{[\s\S]{0,120}size:/,
    'content script must forward the chip size to the bridge');
  assert.match(bridge, /const size = Math\.max\(0\.6, Math\.min\(1\.5, numberValue\(spec && spec\.size\) \|\| 1\)\);/,
    'bridge must read the size from the scan spec');
  // The transform is composed in the measure phase's write plan and applied
  // by the diffed writer (Turbo read/write split) — same visual contract:
  // the user size ends up in the chip's transform scale.
  assert.match(bridge, /transform: \(anchor\.align[\s\S]{0,220}' scale\(' \+ size \+ '\)'/,
    'the write plan must scale the chip with the user setting');
  assert.match(bridge, /el\.style\.transform = plan\.transform/,
    'the applier must write the planned transform to the chip');
});

test('chips live in a fixed overlay layer and never enter the page DOM', () => {
  // Inserting foreign nodes into React-managed containers corrupts
  // reconciliation — on Axiom Pulse it crashed the whole list into an
  // error-boundary skeleton. Chips must render in our own layer only.
  const bridge = fs.readFileSync(path.join(ROOT, 'price-bridge.js'), 'utf8');
  assert.match(bridge, /rowChipLayer = document\.createElement\('div'\)/);
  assert.match(bridge, /rowChipLayer\.id = 'pt-rowbuy-layer'/);
  assert.match(bridge, /layer\.appendChild\(button\)/,
    'the chip must be appended to the layer, not to the row');
  assert.doesNotMatch(bridge, /row\.appendChild\(button\)/,
    'no code path may append a chip inside a page row');
  assert.doesNotMatch(bridge, /insertBefore\(button/,
    'no code path may splice a chip between page nodes');
  // The layer itself is inert; only the chips take pointer events.
  assert.match(css, /#pt-rowbuy-layer \{/);
  assert.match(css, /pointer-events: none/);
  assert.match(css, /pointer-events: auto/);
  // Chips are repositioned from row rects as the lists scroll and churn.
  assert.match(bridge, /function positionRowChip\(entry\)/);
  assert.match(bridge, /function sweepRowChips\(\)/);
  assert.match(bridge, /addEventListener\('scroll', scheduleRowChipReposition/);
  assert.match(bridge, /new MutationObserver\(scheduleRowChipReposition\)/);
});

test('fiber addresses accept only whole base58 values on address-like keys', () => {
  // Substring matches let EVM rows (0x…) and IPFS image CIDs sneak in as
  // fake Solana mints; image/url keys are never token identity.
  const bridge = fs.readFileSync(path.join(ROOT, 'price-bridge.js'), 'utf8');
  assert.match(bridge, /\^\[1-9A-HJ-NP-Za-km-z\]\{32,44\}\$/);
  assert.match(bridge, /image\|img\|logo\|icon\|uri\|url\|banner/);
});

/* ---------------- removing quick buys from the trade tab ----------------
 *
 * Two independent user toggles: hide the one-tap preset row on its own, or
 * hide the entire buy section (label, presets, custom amount, BUY button)
 * for a view-only trade tab. Both default on.
 */

test('the buy toggles default on and migrate onto existing installs', () => {
  assert.equal(E.DEFAULT_SETTINGS.panelBuyEnabled, true);
  assert.equal(E.DEFAULT_SETTINGS.panelPresetsEnabled, true);
  assert.equal(E.mergeSettings({}).panelBuyEnabled, true,
    'an install from before the toggles must keep its buy section');
  assert.equal(
    E.mergeSettings({ settingsRevision: E.SETTINGS_REVISION, panelBuyEnabled: false }).panelBuyEnabled,
    false,
    'a deliberate opt-out recorded at the current revision is never overridden'
  );
});

test('the overlay hides exactly what each toggle controls', () => {
  assert.match(content, /settings\.panelBuyEnabled !== false/,
    'the buy-section master toggle must gate the section');
  assert.match(content, /settings\.panelPresetsEnabled !== false/,
    'the preset-row toggle must gate the preset buttons');
  // The master switch hides every buy control, not just the presets.
  for (const el of ['buyLabel', 'custom', 'btnBuy', 'buyPresets']) {
    assert.match(content, new RegExp('els\\.' + el + '\\) els\\.' + el + '\\.style\\.display'),
      `the visibility pass must cover ${el}`);
  }
});

test('the settings page exposes both removal toggles', () => {
  assert.match(dashJs, /id="set-panel-buy"/);
  assert.match(dashJs, /id="set-panel-presets"/);
  assert.match(dashJs, /panelBuyEnabled: document\.getElementById\('set-panel-buy'\)\.checked/,
    'the buy-section toggle must be persisted with the rest of the settings');
  assert.match(dashJs, /panelPresetsEnabled: document\.getElementById\('set-panel-presets'\)\.checked/,
    'the preset-row toggle must be persisted with the rest of the settings');
});
test('a row tap prices from its own live feed when every resolver source is silent (D-38)', () => {
  // A coin minutes old is unindexed by every aggregator while the row's own
  // realtime feed already prints it. The row buy cascades: freshest network
  // read, then the 60 s display cache, then the row feed itself, then the
  // CHAIN — a new-coin row is on-chain the second the card exists — then
  // the honest refusal. Never a guessed price.
  assert.match(content, /let data = await R\.resolve\(address, \{ maxAgeMs: 3000 \}\)/,
    'the fill path still demands feed-fresh prices first');
  assert.match(content, /if \(!data \|\| !\(data\.priceNative > 0\)\) data = await R\.resolve\(address\);/,
    'a refetch miss may still use the display TTL cache');
  assert.match(content, /function rowLivePrice\(addr\)/,
    'the row-feed fallback exists as its own function');
  assert.match(content, /recentRowPrices\.get\(addr\)/,
    'it reads the mint-tagged USD price the row itself displays');
  assert.match(content, /priceSource: 'row-feed'/,
    'a row-feed fill is attributed to its source, never laundered');
  assert.match(content, /async function rowChainQuote\(addr, kind\)/,
    'the chain leg of the cascade exists');
  assert.match(content, /rowChainQuote\(address, site && site\.rowBuy && site\.rowBuy\.kind\)/,
    'the row buy asks the chain with the row kind that keys its probe');
  assert.match(content, /onchainPrewatch\(ids\)/,
    'the probe runs through the same prewatch the panel uses');
  assert.match(content, /priceSource: 'row-onchain'/,
    'a chain-filled row is attributed to the chain, never laundered');
  assert.match(content, /Bought .*E\.fmt\(amount, 3\).*SOL of/,
    'the confirmation still reads like a fill, not a placeholder');
});

test('a panel buy on a fresh coin acquires the quote on the click before arming (D-38)', () => {
  // "Buy armed" used to be the immediate answer for a coin the chart already
  // priced. Now the click itself drives one acquisition beat through every
  // resolver source (venue APIs included), and only a truly unpriced coin
  // still arms.
  assert.match(content, /async function requestBuy\(amt\)/,
    'the shared buy entry performs an awaited acquisition beat');
  assert.match(content, /async function acquireClickQuote\(/,
    'the click-time acquisition helper exists');
  assert.match(content, /await acquireClickQuote\(token\.mint \|\| token\.srcAddress, token\.chain\)/,
    'the beat resolves the token actually on the page');
  assert.match(content, /maxAgeMs: 0, chain/,
    'the beat forces a fresh resolver pass — no display-cache land');
  assert.match(content, /Buy armed — fires the instant the first quote lands/,
    'arming survives only as the last resort, unchanged in intent');
});