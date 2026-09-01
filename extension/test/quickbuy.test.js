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
  assert.match(content, /els\.btnBuy\.style\.display = sectionOn && \(!instant \|\| customOn\) \? '' : 'none';/,
    'instant mode hides BUY unless custom sizing is enabled');
  assert.match(content, /const sel = !instant && els\.buyPresets\.querySelector\('\.pt-preset\.sel'\);/,
    'instant BUY must ignore a chip selection and read custom sizing only');
  assert.match(content, /let buyInFlight = false;/,
    'rapid taps must be guarded against stacking fills');
  assert.match(content, /buyInFlight = true;\s*\n\s*buyInFlightAt = Date\.now\(\);\s*\n\s*doBuy\(solAmount, quotedUsd\)\.finally\(\(\) => \{ buyInFlight = false; \}\);/,
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
  assert.match(content, /armedBuy = \{ amount: solAmount, usd: quotedUsd, at: Date\.now\(\), mint: token\.mint, fromClick: true \};/,
    'the armed intent remembers its currency and that a click created it (D-39)');
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
  for (const id of ['set-instant-buy', 'set-list-quick-buy', 'set-panel-buy', 'set-panel-presets']) {
    const at = dashJs.indexOf(`id="${id}"`);
    assert.ok(at !== -1, `${id} must exist`);
    assert.ok(at > cardOpen, `${id} must live inside the Buying card`);
  }
  // set-presets is no longer written as a literal id= in the card: it is a row
  // of one-value boxes emitted by renderPresetBoxes(), which also carries the
  // hidden comma-joined mirror that saveFromForm reads. The property under
  // test is unchanged — the control must sit inside the Buying card — so it is
  // located by the call that renders it.
  const presetsAt = dashJs.indexOf("renderPresetBoxes('set-presets'");
  assert.ok(presetsAt !== -1, 'the quick-buy preset row must be rendered');
  assert.ok(presetsAt > cardOpen, 'the quick-buy preset row must live inside the Buying card');
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
  assert.match(bridge, /emit\('row-buy', \{\s*address: decision\.address,\s*quote: typeof rowQuoteFromFiber/s);
  assert.match(content, /ev\.type === 'row-buy'/);
  // The chip shows a busy state until the content script settles the fill.
  assert.match(bridge, /type === 'row-buy-done'/);
  assert.match(content, /sendPadreMarker\('row-buy-done', null\)/);
  // Taps are seen at the WINDOW capture phase, registered at document_start:
  // Padre installs its own capturing click handler that stops propagation,
  // so a listener on the chip element itself never fires.
  assert.match(bridge, /function handleRowChipTap\(ev\)/);
  assert.match(bridge, /window\.addEventListener\(type, handleRowChipTap, true\)/);
  assert.match(bridge, /\['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'keydown'\]/,
    'press events must be swallowed so the row never navigates from a chip tap');
  // The tap must not trigger the row's own navigation or click handlers.
  assert.match(bridge, /ev\.preventDefault\(\);\s*\n\s*ev\.stopPropagation\(\);\s*\n\s*ev\.stopImmediatePropagation\(\);/);
  // The fill goes through the engine and the attestation chain, like any buy.
  // (Window widened when the D-38 CHAIN leg — rowChainQuote — joined the
  // cascade: a new-coin row is priced straight from the pool/curve on-chain.
  // D-40 moved the commit core into fillRowBuy so the direct fill and the
  // armed flush commit identically — the locks follow the extractor.
  // F-56 widened it again: chip fills now run the same witness gate as
  // panel fills — an existing position anchors the check, a >2x divergent
  // candidate needs a vouching second source or the fill refuses.)
  // F-61 widened it once more: a row-fed candidate with a missing/echoed
  // mint gets ONE bounded prewatch probe to heal the key before commit —
  // the stand-in stranding the 8/17 report chased (jb).
  assert.match(content, /async function fillRowBuy\(address, data, amount, ownerToken\)/,
    'the shared commit extractor exists (one commit path for click + armed flush)');
  assert.match(content, /fillRowBuy[\s\S]{0,5200}E\.buy\(state, settings/,
    'the extractor runs the engine buy');
  assert.match(content, /fillRowBuy[\s\S]{0,5600}commitFill\(filled\.trade\)/,
    'the extractor appends the attestation chain');
  assert.match(content, /await fillRowBuy\(address, data, amount, rowBuyToken\);/,
    'the click path commits through the shared extractor');
  // The screener's own realtime price is preferred when fresh.
  assert.match(content, /recentRowPrices/);
  // The new position surfaces immediately in the rail. (D-40: the rail
  // refresh lives in the extractor now — both paths surface it instantly.)
  assert.match(content, /fillRowBuy[\s\S]{0,3000}renderPositionsBar\(\)/);
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
  assert.match(content, /let d = await R\.resolve\(address, \{ maxAgeMs: 3000 \}\)/,
    'the fill path still demands feed-fresh prices first');
  assert.match(content, /if \(!d \|\| !\(d\.priceNative > 0\)\) d = await R\.resolve\(address\);/,
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
  assert.match(content, /ROW_CASCADE_TIMEOUT_MS = 10_000/,
    'the cascade is bounded — a hung source can never wedge the latch (D-41)');
  assert.match(content, /onchainPrewatch\(ids\)/,
    'the probe runs through the same prewatch the panel uses');
  assert.match(content, /priceSource: 'row-onchain'/,
    'a chain-filled row is attributed to the chain, never laundered');
  assert.match(content, /Bought .*E\.fmt\(amount, 3\).*SOL of/,
    'the confirmation still reads like a fill, not a placeholder');
});

test('a fresh-coin chip miss ARMS the intent — the row path never refuses (D-40)', () => {
  // Terp's standing rule (D-39, ported to the board 8/21): if the chart is
  // up, the site already has the price — a tap must NEVER be answered with
  // "Could not price that token yet". The click already happened; the intent
  // arms and fires the instant any source lands a fillable price.
  assert.doesNotMatch(content, /Could not price that token yet/,
    'the refusal string is scrubbed from the row path forever (D-40)');
  assert.match(content, /rowArmed\.push\(\{ address, amount, at: armedAt \}\);/,
    'a cascade miss arms the click instead of refusing');
  assert.match(content, /async function flushRowArmed\(preferAddress\)/,
    'the armed-row flush exists');
  // Wakes: the board's own mint-tagged tick is the fastest possible one.
  assert.match(content, /if \(rowArmed\.length\) flushRowArmed\(payload\.mint\);/,
    'a board tick wakes the armed snipe immediately');
  assert.match(content, /setTimeout\(\(\) => flushRowArmed\(\), 1200\);/,
    'a near-delayed re-probe follows the arm');
  assert.match(content, /setTimeout\(\(\) => flushRowArmed\(\), 4000\);/,
    'a second delayed re-probe bridges a quiet feed');
  // The bar heartbeat is the watchdog: keep probing, expire visibly.
  assert.match(content, /if \(rowArmed\.length\) flushRowArmed\(\);\s*\n\s*\/\/ D-41 latch hygiene/,
    'the 1s board heartbeat watchdog keeps the armed snipe honest');
  // TTL honesty — the same doctrine as the panel's armed buys.
  assert.match(content, /ARMED_ROW_TTL_MS = 60_000/,
    'the armed row intent is bounded by the same 60s TTL');
  assert.match(content, /Armed row buy expired — no fillable price arrived in time/,
    'expiry is stated, never a silent drop or a guessed fill');
  // The intent dies with the page context — no zombie fills from a
  // detached board.
  assert.match(content, /onTeardown\(\(\) => \{\s*\n\s*rowArmed\.length = 0;/,
    'the armed intent is torn down with the content script');
  // The commit core is ONE extractor shared by the click and the flush, so
  // an armed fill commits identically to a direct one.
  assert.match(content, /await fillRowBuy\(armed\.address, data, armed\.amount, rowBuyToken\);/,
    'the flush commits through the shared extractor');
});

test('the row chain probe tries BOTH shapes — pool then mint (D-40)', () => {
  // A fresh Trenches row can print either identity; the chain classifies
  // the account, not the page's kind label. The probe asks both.
  assert.match(content, /let ids = kind === 'pair' \? \{ pool: addr \} : \{ mint: addr \};/,
    'the first probe follows the kind guess');
  assert.match(content, /ids = kind === 'pair' \? \{ mint: addr \} : \{ pool: addr \};/,
    'the second probe asks the OPPOSITE shape');
  assert.match(content, /if \(!found \|\| !\(Number\(found\.priceNative\) > 0\)\) \{\s*\n\s*ids =/,
    'the second probe runs exactly when the first returned no price');
});

test('chip fills run the same honesty gate as panel fills (F-56)', () => {
  // soramonk 8/21 (AMERICOIN): paper-sell booked at 1.6M MC on a coin whose
  // ATH was 113k — a 14x phantom print priced a chip fill because the row
  // path had NO witness at all, and the panel gate keyed only on
  // lastAcceptedMarket (a fresh page has none → gate skipped). Two locks:
  assert.match(content, /posEvidence = token && state && state\.positions\[token\.mint\]/,
    'the panel witness falls back to the position\'s own last honest mark');
  assert.match(content, /const posAnchor = data\.mint && state\.positions\[data\.mint\]/,
    'the chip witness anchors on an existing position\'s last honest mark');
  assert.match(content, /Price sources disagree — paper fill refused\. Try again in a moment\./,
    'a divergent candidate with no vouching second source refuses visibly');
  // The witness must be INDEPENDENT of the candidate's source.
  assert.match(content, /if \(data\.priceSource === 'row-feed' \|\| data\.priceSource === 'row-props' \|\| !data\.priceSource\) \{\s*\n\s*const obs = await R\.resolve\(address/,
    'page-row candidates are witnessed by the resolver, not by themselves');
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
  assert.doesNotMatch(content, /Buy armed/,
    'arming must never narrate — no "Buy armed" wording of any kind (D-39)');
  assert.match(content, /fromClick === true|fromClick !== true|fromClick: true/,
    'the click-origin flag is wired through arming and flush');
});

test('a stuck in-flight latch heals within 20 s — "already in progress" can never wedge (D-41)', () => {
  // Live report: a snipe on a weird pair hung the resolver await forever, so
  // rowBuyInFlight stayed true and EVERY later chip buy answered "Row buy
  // already in progress…" until page reload. Two locks now bound it.
  assert.match(content, /ROW_CASCADE_TIMEOUT_MS = 10_000/,
    'the row cascade is raced against a hard 10 s bound — a hung RPC fails the click instead of wedging the latch');
  assert.match(content, /LATCH_MAX_AGE_MS = 20_000/,
    'the 1 s heartbeat frees any latch older than 20 s (row, panel buy, sell)');
  assert.match(content, /rowBuyInFlightAt = Date\.now\(\)/,
    'the row latch stamps when it was set');
  assert.match(content, /sellInFlightAt = Date\.now\(\)/,
    'the sell latch stamps when it was set');
});

test('a symbol-less new launch never shows "null" or "Unknown token" (D-41)', () => {
  // Live report: "Bought 0.1 SOL of (null)" + "Unknown token" header on a
  // fresh snipe. Identity now heals from the page's own ticks — and, when
  // the feed carries no identity at all (D-42/Bug 5), from the page's own
  // headline DOM, once, as the last resort before the short mint.
  assert.match(content, /if \(!token\.symbol\) \{\s*\n\s*let healed = false;/,
    'the identity-heal block opens on any unresolved symbol');
  assert.match(content, /token\.symbol = payload\.symbol\.trim\(\)\.slice\(0, 24\);/,
    'the first symbol-carrying tick backfills the panel token record');
  assert.match(content, /const scraped = scrapePageTokenName\(\);/,
    'a feed without identity falls back to scraping the page headline');
  assert.match(content, /if \(pos && !pos\.symbol && token\.symbol\) pos\.symbol = token\.symbol;/,
    'the position label heals with it');
  assert.match(content, /const sym = token\.symbol \|\| \(token\.mint && token\.mint\.length > 10/,
    'the panel buy toast falls back to the short mint, never null');
  const quote = fs.readFileSync(path.join(__dirname, '..', 'quote.js'), 'utf8');
  assert.match(quote, /const title = symbol \|\| name \|\| shortMint \|\| 'Unknown token'/,
    'the header title falls back to the short mint before the dead-end string');
});

test('a row-snipe intent survives the navigation to the coin chart (D-42 Bug 3)', () => {
  // Live report: chip buy on the board → open the chart → no position, no
  // line. The armed intent lived only in the board tab's context and died
  // with it. It must mirror into the SW and be adopted by the coin's page.
  assert.match(content, /type: 'pt_armed_row_arm'/,
    'arming a row snipe mirrors the intent to the service worker');
  assert.match(content, /const mirrored = await sendMessage\(\{ type: 'pt_armed_row_get' \}\)/,
    'the coin page asks the SW for a mirrored intent at detection');
  assert.match(content, /adoptedFromRow: true/,
    'an adopted intent is marked and runs the panel D-39 flush');
  assert.match(content, /type: 'pt_armed_row_clear'/,
    'fill/expiry clears the mirror — no double fill');
  const bg = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
  assert.match(bg, /case 'pt_armed_row_arm'|case 'pt_armed_row_get'/,
    'the service worker holds the intent in session storage');
});

test('armed row intents use a bounded selective service-worker mirror', () => {
  const bg = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  assert.match(content, /const ARMED_ROW_MAX = ROW_BUY_QUEUE_MAX;/,
    'content keeps armed intents on the same bound as queued taps');
  assert.match(content, /rowArmed\.find\(\(intent\) => intent\.address === address\)/,
    'same-address armed taps are deduplicated locally');
  assert.match(content, /if \(!rowArmed\.length\) \{\s*\n\s*clearInterval\(rowArmedFlushTimer\)/,
    'the armed probe self-clears when the list empties');
  assert.match(bg, /const ARMED_ROW_MAX = 3;/,
    'the service-worker mirror is bounded');
  assert.match(bg, /Array\.isArray\(value\) \? value : \(value && value\.address \? \[value\] : \[\]\)/,
    'legacy single-object storage is wrapped as a list');
  assert.match(bg, /list\.findIndex\(\(item\) => item\.address === intent\.address\)/,
    'the service-worker mirror deduplicates by address');
  assert.match(bg, /while \(list\.length > ARMED_ROW_MAX\) list\.shift\(\)/,
    'the service-worker mirror evicts the oldest entry');
  assert.match(bg, /function clearArmedRowIntent\(address\)/,
    'mirror clear accepts an optional address');
  assert.match(bg, /let armedRowChain = Promise\.resolve\(\)/,
    'mirror updates serialize through one chain');
  assert.match(bg, /function readArmedRowList\(\)/,
    'mirror reads expose controlled success state');
  assert.match(content, /type: 'pt_armed_row_clear',\s*\n\s*address: intent\.address/,
    'chart adoption clears only the matching intent');
  assert.match(content, /&& Date\.now\(\) - candidate\.at <= ARMED_ROW_TTL_MS/,
    'chart adoption ignores expired candidates before selecting one');
});

test('an armed row snipe keeps probing until filled or expired (D-42 Bug 4)', () => {
  // Live report: "some coins still not instant". Two one-shot timers left
  // gaps; the repeating probe closes them inside the TTL.
  assert.match(content, /rowArmedFlushTimer = managedInterval\(\(\) => \{/,
    'the armed intent runs a repeating 1.5 s flush probe');
  assert.match(content, /if \(!rowArmed\.length\) \{\s*\n\s*clearInterval\(rowArmedFlushTimer\)/,
    'the probe self-clears when the intent fills or expires');
});
/* ------------------------------------------------------------------------
 * One box per preset.
 *
 * The list was a single text field holding "0.1, 0.5, 1, 2" — the user had to
 * know the delimiter, spot a stray comma, and edit four numbers inside one
 * string. Whatever failed to parse was dropped, which reads as the app
 * forgetting a value rather than refusing it.
 * ---------------------------------------------------------------------- */

test('both preset lists render as boxes, not a comma-separated string', () => {
  for (const id of ['set-presets', 'set-sellpcts']) {
    assert.ok(dashJs.includes(`renderPresetBoxes('${id}'`), `${id} must render as boxes`);
  }
  // The old shape must be gone, or the change is cosmetic on one of them.
  assert.ok(!/id="set-presets" type="text"/.test(dashJs), 'the SOL text field must be gone');
  assert.ok(!/id="set-sellpcts" type="text"/.test(dashJs), 'the % text field must be gone');
});

test('the hidden mirror keeps the existing save path intact', () => {
  // saveFromForm reads these through numberList(), which splits a comma
  // string. Keeping that contract is what makes this a UI change only —
  // validation, the coercion notes and their tests all stay put.
  const helper = dashJs.slice(
    dashJs.indexOf('function renderPresetBoxes('),
    dashJs.indexOf('\n}', dashJs.indexOf('function renderPresetBoxes(')));
  assert.match(helper, /type="hidden" id="\$\{id\}"/, 'a hidden mirror must carry the id');
  assert.match(helper, /values\.join\(', '\)/, 'and hold the comma-joined value numberList expects');
  assert.match(dashJs, /numberList\('set-presets'/, 'the save path must be unchanged');
  assert.match(dashJs, /numberList\('set-sellpcts'/, 'for both lists');
});

test('the mirror is resynced on every edit, before any save can read it', () => {
  const bind = dashJs.slice(
    dashJs.indexOf('function bindPresetRows('),
    dashJs.indexOf('\nfunction bindSettings()'));
  assert.match(bind, /addEventListener\('input'/, 'typing in a box must resync the mirror');
  assert.match(bind, /mirror\.value = values\.join\(', '\)/, 'the mirror is rewritten from the boxes');
  // Removal is a committed edit, but a hidden input fires no change of its
  // own — without this, deleting a preset would not autosave.
  assert.match(bind, /dispatchEvent\(new Event\('change'/,
    'removing a box must announce itself as a change');
});

test('a preset row can never be emptied to nothing', () => {
  // saveFromForm restores defaults for an empty list, so an empty row reads
  // as the app ignoring the edit rather than accepting it.
  const bind = dashJs.slice(
    dashJs.indexOf('function bindPresetRows('),
    dashJs.indexOf('\nfunction bindSettings()'));
  assert.match(bind, /length > 1/, 'the last remaining box must not be removable');
});

test('the row stops offering more boxes than the save path will keep', () => {
  // numberList() truncates past 8; offering a 9th box would accept input that
  // is silently discarded on save.
  const bind = dashJs.slice(
    dashJs.indexOf('function bindPresetRows('),
    dashJs.indexOf('\nfunction bindSettings()'));
  assert.match(bind, /MAX_BOXES = 8/, 'the cap must match numberList()');
  assert.match(bind, />= MAX_BOXES/, 'and be enforced on add');
});
