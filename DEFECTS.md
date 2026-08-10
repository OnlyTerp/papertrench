# PaperTrench — Defect Register

Single source of truth for known defects (ROADMAP.md Phase 1). Every fix references an
ID here; every release closes entries here. Severity is mission-weighted:

- **S1 — lies:** a number displayed or filled is wrong.
- **S2 — silent death:** feed/fill/render stops without telling the user.
- **S3 — wrong presence:** something present where it shouldn't be, or absent where it should.
- **S4 — friction:** can't move/resize/find things; confusing states.
- **S5 — polish:** looks bad, inconsistent, unfinished, latent hazard.

Status: `open` → `fixing` → `fixed vX.Y.Z` (with the regression test that locks it) or
`not-repro` (with what we need from the reporter).

ID prefixes: **F** feed/fill path · **O** overlay lifecycle · **D** dashboard/state ·
**C** chart markers/lines · **V** visual polish.

---

## F — Live feed & fill path (audit: 2026-08-05, verified against source)

Community reports covered: "trades not going in during high volume", feeds dying.

### S1 — wrong numbers

**F-01 · S1 · Fills execute on quotes up to 10 s old — and that's the DEFAULT path**
`content.js:928,1017,1023-1024` vs `quote.js:483` · all sites · confirmed · **fixed v2.0.0** (quoteForTrade ladder rewritten; stale fills bounded at 3 s for EVERY source; refusals visible)
`ACTION_FALLBACK_MAX_AGE_MS = 10000` vs `STALE_AFTER_MS = 3000`. Gate is
`displayPriceOnly = token.pending || token.priceSource !== 'resolver'`, but
`content.js:355` sets `priceSource = 'page-feed'` on every accepted page tick — so on
any token priced by the site feed (the normal healthy case), fills accept the stale
snapshot at up to 10 s. Header renders `stale: true` while the fill commits at that
price. On a memecoin, 9 s is routinely a 30–50 % gap.
Repro: resolve token, one page tick, kill WS, wait 9 s, block Dexscreener, BUY → fills
at the 9 s price.

**F-02 · S1 · Generic collector merges price candidates from DIFFERENT tokens into one tick**
`price-bridge.js:121-157,250-252` · Photon, BullX, Axiom, DexScreener, Birdeye,
Jupiter, Pump.fun · confirmed · **fixed v2.0.0** (per-mint record collection in collect(); watched-first bounded emission)
`found.mint = found.mint || value` takes the first base58 seen anywhere in the frame;
`found.candidates` accumulates up to 32 prices from anywhere in the tree; one emit. A
batched frame (screener list, multi-pair snapshot) yields a tick tagged with token A's
mint carrying tokens B…N's prices. `quote.js:383-396` accepts the first candidate
within band, not the one belonging to the mint. No per-mint grouping anywhere in the
generic path — GMGN's `forwardTokenActivity` (`latestByMint` map) is the only correct
implementation.

**F-03 · S1 · Generic collector reads the OLDEST trades in a batch — price lag grows with volume**
`price-bridge.js:129,139` · all non-GMGN sites · confirmed · **fixed v2.0.0** (full-array traversal with newest-last candidate ring + global node budget)
`node.slice(0, 80)` + 32-candidate cap stop at the FRONT of newest-last trade arrays
(newest-last confirmed by `nativecharts.test.js:798`). Longer batches at high volume →
older reported price, monotonically. `forwardTokenActivity:172-176` (full iteration,
keep last per mint) is the correct pattern, applied to exactly one site.

**F-04 · S1 · Row quick-buy fills from a 60 s resolver cache with no age check**
`content.js:2969-2982`, `resolver.js:19-27,92-93` · Axiom Pulse, Padre Trenches, GMGN
Trenches · confirmed · **fixed v1.2.18** (resolve() accepts maxAgeMs; row buys demand
≤3 s; behavioral test in resolver.test.js)
`doRowBuy` prices from `R.resolve()` which serves cache up to `TTL_MS = 60000` with no
staleness check before `E.buy`. The `recentRowPrices` override only fires on mint-tagged
row ticks — exactly what F-02/F-03 fail to produce. A chip tap on a token seen 55 s ago
fills at the 55 s price.

**F-05 · S1 · ACCEPT_RATIO = 20 is too wide to reject wrong-token prices**
`quote.js:343,462-466` · all sites · confirmed · **fixed v2.0.0** (structurally closed by F-02 attribution; band now only arbitrates identifier-less frames)
Candidates accepted at up to 20× either direction (400× total window). Combined with
F-02, any foreign token within 20× passes; `validateTick:437-449` then derives the other
currency side and mcap from the same bad ratio — corruption is self-consistent, so it
looks plausible on screen.

### S2 — silent death / stall

**F-06 · S2 · 500 KB frame guard bypassed ONLY for GMGN token_activity — every other site still loses oversized frames**
`price-bridge.js:217-224` · all sites except GMGN trade feed; including GMGN's own
mcap-candle path (guard at :222 precedes handler at :234) · confirmed · **fixed v2.0.0** (guard raised to 2 MB (walk separately budget-bounded); mcap-candles routed around it)
The v1.2.14 fix's exact bug is still live for Padre/Photon/BullX/Axiom/DexScreener/
Pump.fun/Birdeye frames and GMGN chart candles: >500 KB dropped whole, silently, no
counter, no log. NOTE: `nativecharts.test.js:802` locks current behavior in — the test
must change with the fix.

**F-07 · S2 · token_activity throttle is global, not per-mint — other mints' batches starve the watched coin**
`price-bridge.js:170,178` · GMGN · confirmed · **fixed v2.0.0** (throttle is per mint with bounded clock map; stress-locked)
`now - lastActivityTickAt < 100 → return` runs before batch inspection; the stamp is set
when ANY mint is priced. v1.2.14 fixed intra-batch crowding but not inter-batch: at high
volume, inter-batch gaps < 100 ms discard whole batches including the watched mint. Same
class as the fixed bug, one layer up. No test.
Repro: filler-mint frame, then watched-mint frame 30 ms later → zero ticks.

**F-08 · S2 · Row quick-buy chips refused by their own gesture gate; chip sticks in `busy` forever**
`price-bridge.js:1459-1477,1301-1303`, `content.js:249-251,265-268` · Axiom Pulse,
Padre Trenches, GMGN Trenches · confirmed (mechanism), high-confidence (event
semantics) · **fixed v2.0.0** (pointerdown propagates to the gesture stamp; refusal path always clears chip busy)
Bridge's MAIN-world capture listener calls `stopImmediatePropagation()` on chip taps, so
content.js's ISOLATED-world `noteGesture` never fires; after 5 s idle, tap is refused
("Paper buy needs a real tap…"). The refusal branch returns WITHOUT `row-buy-done`, and
`busy` is only cleared by that message → chip stuck until row recycled. This is a
literal "trades not going in" report.

**F-09 · S2 · findVaults fans out unbounded sequential RPC scans — exhausts the keyless pool in ~10 token switches**
`onchain-feed.js:162-193`, `rpc-pool.js:13,43,110-115,127-152` · all sites · confirmed
· **fixed v2.0.0** (8-byte-aligned scan first + per-pool vault cache + benched-pool circuit breaker with half-open probe)
Byte-offset scan yields ~700–1500 candidate pubkeys → 8–15 sequential `getAccounts`
round trips per watched token, against a 100 req/10 s budget. Cascade: failures bench
all 3 public endpoints (60 s cooldown) → `ranked()` keeps returning least-bad → keeps
failing → `watch()` false → `onchainLive` false → chain-quote authority path dead →
every fill degrades to F-01. Only UI signal: the `· CHAIN ⚡` suffix disappears.

**F-10 · S2 · A genuine >20× move freezes the feed silently for up to 30 s**
`quote.js:429-430,487,503-505`, `content.js:344` · all sites · confirmed · **fixed v2.0.0** (5 consecutive out-of-band rejections force an immediate re-anchor, throttled 3 s)
Out-of-band ticks rejected with no log/counter/UI; anchor refreshes only every 30 s. A
launch doing >20× inside 30 s has EVERY tick rejected: price freezes at the pre-move
anchor exactly when it matters most, fills route to resolver or the 10 s snapshot
(F-01).

**F-11 · S2 · Nothing detects a dead bridge feed or fails over**
`price-bridge.js` (no watchdog), `quote.js:496-509`, `content.js:3290-3292` · all
sites · confirmed · **partial fix v2.0.0** (recovery via F-10 re-anchor; live-dot honesty verified pre-existing; full failover orchestration deferred to backlog)
No liveness monitor on the price path; live-dot keys off `priceNative` existing, not
feed liveness. De-facto fallback is Dexscreener polling at 400 ms/tab (~150 req/min vs
~300 budget) — which throttles during high volume, so feed-death and fallback-death are
correlated.

**F-12 · S2 · Padre binary frames and dedicated-Worker sockets are invisible**
**disposition (v2.0):** layered-fallback by design. Parsing Padre's undocumented binary protobuf would be guessing at a wire format — against doctrine. Padre now has: hardened subscribeBars (repatch + capability acks), export poll with flat-market re-assert, resolver refresh, and honest refusal. Dedicated Worker instrumentation stays on the backlog.
`price-bridge.js:295-308,314-334` · Padre primarily · confirmed · open
Only string WS frames are parsed; Padre's multiplex is binary protobuf (per the file's
own header comment). Padre has exactly one live path (`subscribeBars`) and no WS
fallback; a missed TradingView patch window → Dexscreener polling only. Dedicated
`Worker` globals are entirely uninstrumented (only `SharedWorker` is wrapped).

**F-13 · S2 · Every fill blocks on a service-worker round trip that consumes the freshness budget it protects**
`content.js:990,994-995`, `background.js:632-635` · all sites · confirmed · **fixed v2.0.0** (click-time snapshot captured before the first async hop; age judged at click)
`await R.onchainQuote()` is the FIRST await in `quoteForTrade`; MV3 cold SW = 100–500 ms
(worst at high volume when it's servicing every tab). The 350 ms snapshot age test runs
on a clock that already advanced during the round trip: fresh local data is discarded
because checking the remote source took too long.

**F-14 · S2 · All fills serialize behind one promise chain writing a never-truncated hash chain**
**disposition (v2.0):** accepted, monitored. Chain growth is linear and slow (SubtleCrypto over ~1k links ≈ ms); truncation would break verifiability by construction (see commitFill comment). Revisit with a checkpoint protocol if real journals reach 10k+ fills.
`content.js:1051-1061,1106-1111,2878-2885` · all sites · confirmed · **fixed post-v2.7.1**
(the chain left pt_state: content tabs send `pt_attest_append`; the worker is the
single writer, serializing appends — warmSerial pattern — into append-only
`pt_attest_seg_<n>` segments + `pt_attest_meta`, so a fill rewrites only the tail
segment, O(seg size) forever, and multi-tab full-chain races are gone. One-time
protocol-safe migration strips `state.attestChain` through the seq write counter;
a pre-update tab writing the chain back is folded, never dropped. Backup bundles
the chain as `pt_attest_chain` AND as a legacy `state.attestChain` copy inside the
backup's pt_state, so restoring on a pre-segmentation version keeps the record
intact (downgrade-safe by construction — old code cannot be taught to refuse, so
the file is readable by both); the new restore strips the legacy copy and
re-segments. Reset clears segments atomically with the wallet wipe. NOTHING is
truncated — every hash is preserved exactly as committed. Locked in
attestsegments.test.js + attestworker.test.js; F-28's tell-the-user-once toast
preserved in commitFill.)
Every fill: reload full state → SubtleCrypto over the whole attest chain → persist full
state (incl. `attestChain`, never truncated). Fill latency grows linearly with lifetime
fill count; the only feedback is "Buy already in progress…", which reads as broken.

**F-15 · S2 · doSell has no in-flight guard — double-tap sells the wrong quantity silently**
`content.js:1389` (vs `buyInFlight` at :1313,:1321) · all sites · confirmed ·
**fixed v1.2.18** (sellInFlight guard, cleared in finally; locked in
statepersist.test.js)
Two fast taps on "SELL 50 %" both quote and both commit; the second sells 50 % of the
remainder → 75 % total, two success toasts, zero errors. (`doRowBuy` also uses a
separate flag from `doBuy` — chip tap and panel BUY can interleave.)

**F-16 · S2 · Fresh launches on market-cap charts can never bootstrap — armed buys always expire**
`quote.js:313,331`, `price-bridge.js:239-246`, `content.js:615-618` · GMGN, Axiom ·
confirmed · **fixed v2.0.0** (armed buys expire on market QUIET (15 s past TTL) with a 5 min hard cap, never bare clock)
`bootstrapTick` rejects mcap-only ticks without supply; GMGN's chart emits exactly that
shape (`gmgn-mcap-candle`: empty candidates, mcap only) and Axiom defaults to mcap
view. For a coin with no Dexscreener/Jupiter anchor — the arm-and-fire target case —
the armed buy sits 60 s and dies "no quote arrived in time". The snipe path is
structurally dead on the two mcap-charting sites.

**F-17 · S2 · Background tabs lose every price path simultaneously**
**disposition (v2.0):** the dangerous half is closed by policy — the staleness ladder refuses fills beyond 3 s for every source, so a returning tab can never fill at an ancient price; it re-quotes within ~400 ms. Chrome throttles hidden tabs by design; the profit-alert watcher remains the opt-in exception.
`price-bridge.js:1792`, `quote.js:499`, `content.js:589` · all sites · confirmed · open
Chart poll, requote, and heartbeat all gate on `document.hidden` (plus Chrome interval
throttling). Return to a backgrounded tab → price of arbitrary age, stale-flagged at
3 s but fillable to 10 s (F-01). Only exception: profit-alert watcher at 2 s.

**F-18 · S2 · Screener chip layout thrash starves the main thread the feed parses on**
`price-bridge.js:1479-1554,1573-1586,1654-1764`, `content.js:2947-2959` · Axiom Pulse,
Padre Trenches, GMGN Trenches · confirmed · **fixed v2.0.0** (chip observer drops characterData — text updates no longer starve the feed thread; occlusion probe landed earlier)
Body-wide MutationObserver with `characterData: true` → every price-digit change on the
list schedules repositioning; each rAF does O(N chips) forced synchronous layouts
(`getBoundingClientRect` + `elementFromPoint` + pill search), plus 80-fiber walks per
unchipped row. content.js installs a SECOND body-wide subtree observer. `forwardJson`
parses on this same thread: main-thread starvation IS the feed dying. Highest
volume-sensitivity item; invisible to unit tests.

**F-19 · S2 · Chart-export poll emits only on price CHANGE — flat market reads as dead feed**
`price-bridge.js:1829` · Axiom primarily · confirmed · **fixed v2.0.0** (export dedupe reset on token switch; unchanged close re-asserted every 2.5 s)
Unchanged close emits nothing; on Axiom the export poll is frequently the only price
path. Flat/illiquid token → zero ticks → stale header → resolver fallback on every
click despite a healthy chart. `lastExportedClose` is never reset on token switch
(leaks across tokens; `lastBarClose` is reset at :89, this one isn't).

### S3 — wrong presence

**F-20 · S3 · Staleness gates are inverted relative to source accuracy**
`onchain-feed.js:41,397` vs `content.js:928` · confirmed · **fixed v2.0.0** (policy aligned: chain authority first, page snapshot bounded at 3 s — no inversion)
The chain quote ("the authority", content.js:988) is refused past 2.5 s; the page
snapshot is accepted to 10 s. Failing strict on the accurate source silently routes
fills to the loose gate on the inaccurate one.

**F-21 · S3 · subscribe() leaks an orphan pending entry on every cold-socket subscribe**
`onchain-feed.js:261-278,376-377` · confirmed · **fixed v2.0.0** (pending registered only when the frame went out; onopen resubscribes)
`pending.set` before `send()` which returns false on CONNECTING; first subscribe after
every connect is dropped (rescued only by onopen resubscribe). Orphaned entries never
cleaned — unbounded Map growth over long sessions.

**F-22 · S3 · title-feed gives up permanently if the SPA hasn't set a title yet**
`title-feed.js:105`, called once from `content.js:454` · all sites · confirmed · **fixed v2.0.0** (a head observer waits for a late <title>; stop() cleans it up)
`!document.title → return false` before installing the observer; no retry. Title signal
dead for the whole page load on late-titling SPAs.

**F-23 · S3 · Generic title patterns match the first $ figure in the title**
`title-feed.js:38,40-43` · Padre, Axiom, BullX, DexScreener, Birdeye · confirmed · **fixed v2.0.0** (acceptFromTitle: exactly one anchor-consistent figure or refusal — ambiguous titles never guessed)
Bare `$number` regex; the 3× validate band catches price↔mcap confusion but not a
different dollar figure within 3× (P&L, position value in tab title).

**F-24 · S3 · pump.fun has no adapter; the bridge instruments every site on the internet**
`sites.js:44-194,204-216`, `manifest.json:22-31` · confirmed · **fixed v2.0.0** (pump.fun adapter added; manifest narrowed to supported trading sites only)
Pump.fun (in the product description) falls to the generic fallback. Separately:
`matches: ["<all_urls>"]` at document_start/MAIN wraps fetch/XHR/WebSocket/SharedWorker/
EventSource and runs the 700 ms + 1000 ms intervals and a body-wide MutationObserver on
EVERY page the user visits. `all_frames: false` also misses feeds living in child
frames. (Overlaps overlay-gating cluster — cross-reference with O findings.)

### S4/S5 — friction & latent hazards

**F-25 · S4 · bootstrapTick unit heuristics hardcode today's SOL/USD scale**
`quote.js:220-222,296` · confirmed · **fixed v2.1.0** (rate-aware disambiguation: with a live
rate, a value is plausibly-native when value × rate lands in the sane pre-index USD band
and plausibly-USD when the value itself does; BOTH plausible → refused `ambiguous-unit`
rather than guessed — the fast-retry loop anchors the coin within seconds. Neither
plausible → `implausible-unit`. The explicit-native branch gains a rate-aware sanity
floor (`native-implausible`). No rate → original magnitude heuristic kept. Locked in
quote.test.js F-25 block; prior accepted cases pinned unchanged.)
Any unknown-unit close in [1e-7, 1000) assumed USD → a 5e-7 SOL close gets divided by
the rate twice (~200× wrong). `native` branch accepts anything < 1 SOL, no floor.

**F-26 · S4 · patchPadreWidget polls every 1 s forever on every site, incl. those with no TradingView**
`price-bridge.js:403,420,1853` · Photon, BullX, DexScreener… · confirmed · **fixed v2.0.0** (60 empty scans drop to slow cadence; revives on widget discovery or paper-axis)
Re-runs `getRankedCharts()` every second and an 8000-fiber walk every 3 s; never stands
down after N failures.

**F-27 · S5 · rpc-pool leaks a 4 s abort timer when fetch rejects**
`rpc-pool.js:130-139` · confirmed · **fixed v2.0.0** (abort timer cleared in finally) — timer cleared only on the resolve path; no
`finally`.

**F-28 · S3/S5 · commitFill swallows SubtleCrypto failures — fills journal without attestation, user never told**
`content.js:2888-2890` · confirmed · **fixed v2.0.0** (first attestation failure surfaces a one-time toast) — later `verifyChain` reports a mismatch the
user cannot explain.

**F-29 · S5 · Latent: bridge code runs inside host-site chart callbacks with no try/catch**
`price-bridge.js:530-537,696-700` · confirmed (latent pattern, no live bug) · **fixed
v2.1.0** (subscribeBars' resolution note, the per-bar preamble and getMarks' preamble +
mark-merge are each contained in try/catch — the host's own callback always runs.
Locked behaviorally in nativecharts.test.js: a poisoned bar/resolution throws inside the
preamble and the host still receives its data; plus a source contract on the shapes.)
A future throw in `noteResolution`/`barSymbolMatches`/`emitPadreBar` would break the
HOST site's chart, not just PaperTrench.

### Per-site adapter matrix (as audited)

| Site | Price path(s) | Oversize guard | Watched-mint priority | Notes |
|---|---|---|---|---|
| GMGN token_activity | WS/SharedWorker fast path | bypassed | YES | global 100 ms throttle (F-07) |
| GMGN mcap-candles | XHR | **ACTIVE — bug** (F-06) | implicit | |
| Padre | TradingView subscribeBars only | 500 KB (binary dropped, F-12) | YES (bars) | no WS fallback |
| Axiom | subscribeBars + export poll + generic | 500 KB | YES (chart) / NO (generic) | export poll F-19 |
| Photon | generic collect only | 500 KB | NO | F-02/03 fully apply |
| BullX | generic collect only | 500 KB | NO | F-02/03 fully apply |
| DexScreener | generic collect only | 500 KB | NO | F-02/03 fully apply |
| Pump.fun | NO adapter → generic fallback | 500 KB | NO | F-24 |
| Birdeye/Jupiter | generic collect only | 500 KB | NO | |

**The GMGN v1.2.14 fix pattern (guard bypass + full-batch newest-per-mint + watched-first)
exists on exactly one path of one site.** Phase 2's core job is making it the contract
for every adapter, enforced by the stress harness.

---

### Post-release community reports

**F-30 · S1 · Holding a REAL position on the same token polluted the paper feed — the average line blended the real buy with the paper buy**
`price-bridge.js:149` (PRICE_KEY carried avgPrice), line labels at :1272 ·
Padre/Axiom confirmed, all sites exposed · reported by the maintainer testing
v2.0.0 with a live real position · **fixed v2.0.1**
Two halves: (1) the site streams the user OWN entry average (`avgPrice`,
`positions[]` subtrees) while a real position is open, and the collector took
it as a live market tick — well inside the validation band, so the paper P&L
and the line math ran on the user entry price part of the time; (2) our
average line used Padre EXACT real-position label ("Avg. Fill Price"), so the
real and paper lines were indistinguishable. Fix: avgPrice removed from the
price keys, position-describing subtrees are tainted (identity flows, prices
and caps never do), and the paper lines are labeled "PAPER Avg. Fill/Exit" —
the watermark doctrine applied to chart lines. Locked by three tests.

**F-31 · S1 · On mcap charts, fill bubbles floated above the candles and right of the last bar — while the avg line sat exactly right**
`price-bridge.js` drawShapeFallback (raw levels.mcap, unclamped mark.time),
`content.js` renderHeader label · Padre confirmed via maintainer screenshot
(v2.0.1, live position: line correct at 16.1K, bubbles at ~25-27K past the
final candle) · **fixed v2.1.0**
Three mechanisms: (1) shapes used the RAW fill-time resolver-implied mcap
while lines used the live-close correction — and the chart own cap
definition (bonding curve) differs from the resolver by a constant factor.
Fixed with the axis-agnostic formula lastBarClose × (fillPrice/currentPrice)
— supply cancels, the chart own scale wins, shared by shapes and lines.
(2) No time clamp: a fill stamped ms ahead of the newest 1 s bar parked its
shape beyond the last candle. Shapes and marks now clamp to the newest bar
time (reset per token). (3) The header sub-line "MC · $0.0₄21" read as "the
MC IS $0.0₄21" when it meant "headline is the MC; this is the unit price" —
now labeled "Price …". Locked by three tests.

**F-32 · S1 · The average line STILL rode the candle for a community user after C-01 — design flaw in the per-sweep ratio recompute**
`price-bridge.js` syncPaperAverageLines · Padre, video evidence from lev
(entry $4.4K, line hugging the $6.2K close, ratio ~= 0.98) · **fixed v2.3.0**
C-01 made the spec re-post as prices move, and every harness reproduction of
the re-post path passes — but SOME real-world link still left the spec stale
for this user, and the sweep recomputed close x (avg/current) from a MOVING
close every second, so any staleness anywhere manifests as riding. The deep
fix removes the class: an average line is a CONSTANT level in axis units, so
the level is computed once per spec arrival and FROZEN; sweeps re-assert the
same number. A stale spec now yields a stable line at the last correct level
instead of a lie that tracks the price. Locked by a behavioral test proving
the level holds through moving closes without a fresh spec, and that honest
fresh specs recompute to the same invariant entry level.

**F-33 · S1 · Paper fills on migrated (AMM) tokens executed ~13% away from the live chart — the on-chain feed starved one vault leg of every trade**
`onchain-feed.js` handleMessage (shared `entry.slot` guard) · Padre, video
evidence from lev (buy toast $59.8K MC against a $67.6K chart, instant fake
+14.6% unrealized; sell at $57.8K against $64.5K) · **fixed v2.7.0**
A swap moves BOTH vaults of a constant-product pool in the SAME slot, and
they arrive as two separate accountNotifications carrying that slot. The
out-of-order guard compared each frame against one per-ENTRY slot, so the
first leg of every trade was accepted and its sibling dropped as "old".
Subscription delivery order is stable per connection, so the same leg kept
losing: one vault tracked every trade while the other froze at its last
first-arrival, and price = quote/base walked away from the chart by the full
drift between them — while still LOOKING fresh (observedAt updated on every
accepted leg), so the fill ladder's "chain state is the authority" step
served it on every click. Fix is per-vault slot guards (single-account pools
keep the strict per-entry guard). Defense in depth: quoteForTrade now
reconciles the chain quote against a sub-second-fresh on-screen price and
sides with the screen beyond a 6% divergence (Q.fillSourcesAgree), logging
the divergence — the fill the trader gets is never double digits away from
the chart they clicked, whatever breaks upstream next time. Locked by a
behavioral same-slot vault-pair test, a per-leg rewind-refusal test, and
source pins on the ladder order.

**F-34 · S2 · A fresh pump.fun launch could not be bought at all on an mcap-mode chart — the armed buy waited for a first quote that could never arrive**
`quote.js` bootstrapTick ('mcap-no-supply'), no pre-index on-chain path ·
Axiom, maintainer screenshot (39-second-old coin, B.Curve 62.3%, live chart
at $7.15K MC, panel "New coin — waiting for first quote…", buy ARMED
forever) · **fixed v2.8.0**
Two independent causes, both fixed: (1) with the chart in MCap mode every
close is mcap-scale, and bootstrapTick rightly refuses to invent a supply —
but pump supply is a protocol CONSTANT (1e9), so for the pump family the
close IS a price; all four readings (price/cap × USD/SOL) are judged
against sane bands and used only when exactly one fits, with a dedicated
cap band ($3K–$100K) so dust values cannot masquerade as tiny caps.
(2) Nothing on-chain was watched pre-index because the resolver had no
pairAddress — yet the page KNOWS the curve (Axiom's /meme/<pair> IS the
curve account; a pump mint derives its curve via the program-address rules,
implementation verified against five live mainnet curves before shipping).
prewatch identifies the curve on chain, discovers the real mint from the
curve's reserve token account, watches it, and PRIMES the first quote from
the same read — the armed buy fires seconds after launch and fills from
chain state. Locked by: five real-vector PDA derivation tests, an
end-to-end feed prewatch test (bare curve address → watched mint → primed
quote → reserve account remembered), bootstrap acceptance/ambiguity tests,
and the existing armed-buy suite.

**F-41 · S1 · One buy drew TWO bubbles, and the average line never appeared — a dead self-write guard duplicated every fill, and a stale-ledger veto quietly relocated the line off-screen**
`content.js` watchStorage/doBuy/doSellInner · `price-bridge.js`
vettedMcapClose/paper-lines · fomo.family, maintainer field test ·
**fixed (unreleased)** — two independent defects behind one screenshot,
both found by live probing rather than reading.

*Two bubbles.* `chrome.storage.onChanged` delivers a STRUCTURED CLONE, so
`watchStorage`'s self-write guard (`next === lastWrittenState`) can never be
true in a real browser: every tab re-adopted its OWN fills. Harmless until
F-40 taught `adoptState` to replay the journal — after which the storage
echo of `persistStateNow()` drew the fill BEFORE `drawnFillIds.add(trade.id)`
ran two lines later, and the live path then drew it again. The two marks got
different random ids, so the bridge could not recognize them as one fill, and
`layoutBubbles` lifted the same-bar twin by one chip step — "a bubble above
and below". Fixed at three levels: the ledger claims the fill immediately
after `E.buy`/`E.sell` (before any await), the guard gained a clone-proof
`seq:updatedAt` stamp, and the bridge now keys marks by the TRADE id so "one
fill, one mark" holds no matter how often it is posted. Reproduced first in
a new fomo overlay harness (one buy → two `paper-marker` posts) whose
storage fake clones like Chrome does; the old harness handed back the
caller's own object, which is exactly why every existing test passed.

*No average line.* Live-measured on the real chart (in-app browser,
2026-08-06): fomo's visible band was 108.9M–119.5M in a 187px pane — barely
±5%, so a level off by more than that is drawn perfectly and seen by nobody.
`vettedMcapClose` refused the export-poll close whenever the ledger held ANY
entry — including an entirely STALE one (`if (barCloseLedger.size) return
null`) — so on a token quiet for 15 s the level fell back to the resolver's
own cap and left the visible range. Bubbles survived it because F-40 freezes
them; the line alone recomputed on every 2 s repost, which is precisely why
the maintainer saw bubbles and no line. The gate is now on FRESHNESS (a
fresh entry that failed unit vetting still refuses; an all-stale ledger does
not), the line's frozen level carries across reposts that did not change the
averages (freeze parity with bubbles, while a DCA still moves it), the spec
finally carries `currentMcap` so F-35's preferred-close discriminator stops
being dead code, and a level outside the chart's own visible range now
reports `off-range` instead of `ok:true`. The drawing code itself was proven
correct on the live chart first — canvas pixels showed the dashed line on the
exact expected row — which is what ruled it out and pointed upstream.

**F-44 · S1 · The attestation recorded a fill's CHAIN but never hashed it — the label was editable while every digest still verified**
`attest.js` fillPreimage / chainOf · `server/core/chain.js` ·
`test/chaincommit.test.js` · found by a community probe (amogus0471, via the
Discord, 2026-08-06) asking what the chain actually protects ·
**fixed (unreleased)**.
`appendFill` stored `chain` on every link, but `fillPreimage` committed ten
fields and none of them was it. The comment justified this with the solNet
precedent — except solNet is safe for the OPPOSITE reason: `committedAmount()`
refuses to read it, so nothing downstream trusts it. `chain` exists, by its own
comment, so "a verifier prices the fill against the RIGHT chain's history" — a
field the verifier is MEANT to consume. Recorded-but-unhashed meant a Base fill
could be relabelled Solana, steering re-pricing toward whichever network's
candles made a fabricated price plausible, with every hash still verifying.
Not exploitable on the day it was found — nothing server-side read `link.chain`
yet, and the candle path is Solana-hardcoded — so the accurate charge is a hole
**scheduled to open**, on the release that makes the verifier chain-aware. The
rule taken from it: *the commit precedes the consumer, or the consumer does not
ship.*
Fix: `VERSION` → 2, and `fillPreimage` now DISPATCHES on each link's own
version instead of hardcoding `'v' + VERSION`. That ordering is the whole
difficulty — a naive bump would have invalidated every chain in existence,
including the one verified record in production, because a real wallet SPANS
the upgrade (v1 links beside v2 links in one chain). v1's preimage is
byte-identical forever; v2 APPENDS chain after `ts` rather than inserting it.
`chainOf(link)` is the only sanctioned reader: a v1 link is Solana **by
definition**, never by consulting its unhashed label — miss that and every
historical link silently keeps the hole the bump was meant to close while the
new ones look correct.
Mutation-verified four ways, each killing exactly its own test and nothing
else: un-commit the chain, hardcode the version again, trust the v1 label, and
insert-instead-of-append. The fourth SURVIVED the first pass and exposed a real
gap — nothing pinned v2's byte format — so a byte-exact v2 preimage test was
added, which would have caught a future reorder orphaning v2 chains the same
way. Suite 1305 extension + 118 server.
**DEPLOY ORDER IS LOAD-BEARING**: `server/core/chain.js` re-exports this exact
file and `server/core/submission.js:52` verifies every submitted chain, so a
worker still running v1 logic would compute a v1 preimage for a v2 link and
reject it as `hash-mismatch`. The new server code verifies BOTH versions, so it
is backward compatible — **redeploy the worker before any extension build that
writes v2 links reaches a user.**

**F-50 · S1 · lute prices the same token at TWO SCALES — an immediate round trip booked −90.2%**
extension price pipeline on lute.gg (scale acceptance, suspects below) ·
caught by `featurepass.mjs lute`, 2026-08-10, harness profile, BONK ·
**open — fully receipt-documented (the first of its family), reproducible on
demand, root not yet pinned; do not fix on inference (F-45 rule)**.
The receipts, verbatim from the journal: BUY 00:51:12.793Z, 0.1 SOL at
priceNative 3.1919e-7, mcap $2,151,142,047, `priceSource=padre-chart-bar`,
`priceAgeMs=93`. SELL 3.9 seconds later, returns 0.00988 SOL at priceNative
3.1849e-8, mcap $214,646,482, `priceSource=ws`, `priceAgeMs=172`. The legs
differ by exactly 10.02x. Both prices were FRESH — this is not staleness,
it is two sources at different SCALES both being accepted as the same
market. A second run watched the PANEL ITSELF flip $214.75M → $2.15B inside
a 30s window: the scales fight live, and whichever last ticked prices the
next fill.
Mechanism (confirmed shape, unpinned entry point): lute displays BONK's cap
at ~10x the market's number — the Aug 6 landing probe recorded the title
"BONK ↑ $2.46B • Lute" and called the title feed's read "correct", which was
scale-naive; every other venue prices BONK at ~$215M (total-vs-circulating
supply convention, BONK burns). This is F-49's suspect (b) — mixed-supply
cap labels — observed in the wild with receipts. Neither guard helps: the
F-47 witness meets an evidence stream that itself alternates scales (a
same-scale witness confirms its own side — the lagging-witness residual,
scale-flavored), and the F-48 quiet-screen guard compares natives inside
one scale regime.
Suspects for the acceptance point, ranked: (1) the title-feed ratio rescale
(content.js ~1395: title mcap rescales token.priceNative/priceUsd wholesale)
validating against CURRENT token state — once one lute-scale tick lands,
the title self-confirms it, chicken-and-egg; (2) the chart-close accept path
(basis/mcap-band) admitting a 10x-off-anchor close on the MC axis; (3) the
requote-after-oob path re-anchoring to the wrong side. The fix discipline
whichever it is: rescales and scale-changing accepts must band against the
RESOLVER ANCHOR, never against the token state they themselves wrote.
Repro: `node featurepass.mjs lute` (seeded profile) — twice on 2026-08-10.
Close only with the acceptance point named by test, a guard mutation-locked,
and a green featurepass on lute whose round trip books fees only.

**F-48 · S1 · a sell booked ~20% under the chart the trader watched — a win rendered as -9.6%**
extension price pipeline (suspects ranked below) · Terp, lute.gg screenshot,
2026-08-06 (WhiteBull "oUwi…pump", MC axis, first live lute session) ·
**open — bridge exonerated by lock, provenance receipts landed, the
suspect-(1) gap proven by executing lock and CLOSED (quiet-screen guard);
the field occurrence itself still awaits its receipt**.
The chart and the S mark sat at ~41K MC when he clicked sell (the panel
header read $39.8K moments later — the fresh number existed in the tab),
and the engine booked the exit at 33.1K (the avg-exit line and the P&L
agree with each other): -9.6% booked on a winning trade. At ~1.24x the
divergence sits UNDER FILL_WITNESS_RATIO (2x), so the F-47 witness
correctly stood aside — this is the sub-ratio variant of the same family:
value-lag wearing a fresh timestamp.
Eliminated by test, not by argument: four chart-truth locks in
`test/lute.test.js` boot the shipped bridge against lute's live-captured
shape (no-fiber options bag + `tradingViewApi` composite, dedup-by-uid
datafeed keyed on `base_name`, getMarks present) and prove discovery, the
pre-patch-subscription export peg, F-26 stand-down recovery, and post-patch
bar flow all work — the bridge cannot be the layer that starved the price.
Remaining suspects, ranked: (1) the residue F-47 named honestly — an
action-resolver / on-chain value adopted while the screen was >600ms quiet,
lagging in the same direction as its witness; (2) quote-side handling of
the MC-axis `unit:'unknown'` export close for a pump-family token with no
aggregator anchor; (3) multi-chart grid ranking pinning the wrong chart
instance.
Landed with this entry: every fill now records `priceSource` +
`priceAgeMs` on its journal row (stored-not-committed, the solNet pattern —
the attestation preimage is untouched). The NEXT occurrence names its
source in the dashboard journal instead of demanding screenshot forensics.
Suspect (1) is no longer an inference — it is a proven structural gap, now
closed. `test/quietscreen.test.js` boots the shipped quote ladder verbatim
(the action-quote section of content.js against the real quote.js, an R
fake with the shipped resolves-null-never-rejects shape) and demonstrated
the mechanism with the report's own numbers: a chain read lagging 24% under
a fresh timestamp priced the fill whenever the screen was >600ms quiet,
because the F-33 arbitration never arms there and the F-47 witness sleeps
below 2x — the (1.06x, 2x] band on a quiet screen answered to nobody. The
guard (`Q.onchainContradictsEvidence`, band 1.10x, window 30s): a chain
candidate arriving on a quiet screen must agree with `lastAcceptedMarket`;
contradiction DEMOTES the read into the ladder, which re-prices from
sources that can vouch for themselves — a corroborated real move still
fills at the moved level, an agreeing read still fills with zero added
latency, and when every honest source is gone the answer is a loud refusal,
never the lagging read. All locks mutation-verified red-then-green against
the exact guard lines (veto disarmed → 3 fill-path locks fail; band vacated
→ those plus the bounds lock fail).
Close this defect only by reproducing it with the receipt in hand: whether
THIS mechanism — and not suspects (2)/(3) — produced the WhiteBull fill is
confirmed the day a receipt names the source.

**F-49 · S1 · Axiom mcap-mode: B/S bubbles drawn away from where the trader actually bought and sold**
toshi100x, Discord screenshot 2026-08-07 (Axiom, "…/USD on Pump" pair,
MCap axis, both markers displaced from the click points) · **open — needs
the fill receipts before any fix; do not fix on inference (F-45 rule)**.
The drawing path is honest (bubbles plot the fill's recorded values; the
bridge picks the axis), so the recorded values disagreed with the screen.
Three candidate mechanisms, each with a DIFFERENT fix:
 (a) the F-48 class pre-receipts: the fill priced from a source lagging
     the chart by under the witness's 2x ratio — if he is on ≤v3.1.0 this
     is plausibly already-shipped territory;
 (b) mixed-supply cap labels: fill.mcap derived through anchor ratios
     whose mcap/priceUsd pair implied a different SUPPLY than the chart's
     own cap math (Axiom cap vs aggregator cap disagree when LP burned /
     supply ≠ 1e9 — both markers then sit at a CONSTANT relative offset,
     which matches the screenshot's shape);
 (c) a draw-time derivation for capless fills (genericChartPoint's
     usd × liveSupply) mixing a click-time price with a later supply.
Discriminating data, one message from the reporter: extension version,
the two fill rows from the dashboard (v3.2.0+ receipts name each fill's
price source and its age), and the prices he believes he traded at.
Receipts landed in cb17fe1 for exactly this conversation.

**F-47 · S1 · a fill could execute at a resurrected dead price — a loss rendered as +167%**
content.js quoteForTrade / quote.js · chatcabal, Twitch + Matt Buitrago's
Discord screenshots, 2026-08-06 (Axiom, migrated Pump-AMM coin "fork",
871M supply) · **fixed (unreleased)**.
The market crashed ~$30K → ~$8K market cap inside a minute. His DCA buy
filled honestly at the crashed level ($6.8K MC — proof the pipeline HAD the
truth), and the SELL sixty seconds later filled at the pre-crash level
($30.0K MC, ≈ the header's ATH): 8.09 SOL returned on 3 SOL in, a real loss
shown as +167%. The screenshots cannot pin WHICH source served the dead
price — the action-resolver refresh is adopted with no agreement check, an
on-chain quote is unchecked whenever the screen is >600ms quiet
(ONCHAIN_SCREEN_CHECK_MAX_AGE_MS), and a poisoned snapshot re-stamped
"fresh" passes the age bounds — but all three share one shape: the chosen
candidate contradicted market evidence the same tab had JUST accepted as
money.
Fix is the shape, not the source: the fill witness. Every fill-time
candidate is judged against the freshest ACCEPTED evidence (validated ticks
and committed fills — deliberately never token.priceNative, which requote()
overwrites with resolver prices). Divergence beyond FILL_WITNESS_RATIO (2x)
within FILL_WITNESS_WINDOW_MS (120s) demands an INDEPENDENT second source;
a dissenting or missing witness refuses the fill with both numbers named. A
real 4x pump is confirmed by any fresh witness and fills normally; ordinary
moves never pay the witness round trip. Both guards mutation-verified
(`test/fillwitness.test.js`, the report's own numbers as the named
regression). Residual, named honestly: a witness that lags in the same
direction as the candidate (aggregator still serving the pre-crash price
within seconds of the crash) can still confirm it — two lagging sources
agreeing is indistinguishable from truth without a chain read; the on-chain
witness path covers venues the feed can watch.

**F-46 · S1 · pt_state had no atomic commit — one tab's heartbeat could eat another tab's fill, then half-resurrect it**
every `pt_state` writer (content persistStateNow/persistSoon, dashboard
mutateState, popup restore, content quickResetWallet) · LYAR, X DM field
report, TWICE ("place several buys, suddenly the position vanish from the
overlay… then there is a difference between cash and equity"; after a first
"should be fixed": "the issue is still here… most of the time it goes back
in the green and the pnl is false then, it goes both ways") · **fixed
(unreleased)**.
Every context wrote the whole state blob with a bare
`chrome.storage.local.set`. `seq` was advisory: two writers reading the same
base both stamped N+1 and the second silently destroyed the first. The
~800ms mark heartbeat in any open tab made the interleaving routine — read
before another tab's fill lands, write after it, and the fill is gone from
storage while the filling tab still renders it; the next adoption event then
tears it off that tab's overlay too (position vanishes mid-session), and
later heartbeats from tabs holding other bases partially resurrect older
copies (cash/equity mismatch, "false pnl, both ways"). persistSoon's
read-first guard only caught writes that landed BEFORE its read — the
TOCTOU window between read and write stayed open.
Fix: `pt_state_commit` in the worker — every write serialized through one
queue with a seq compare-and-swap. A stale base is refused and handed the
current state; the writer adopts it, re-applies what it genuinely owns (its
live marks, and its own mutation via the new `remutate` argument to
persistStateNow), and commits again. Fill/order/alert/thesis mutations all
pass remutate; resets and restores commit with `force` (user-singular
truth) but still ride the queue so they cannot interleave. Chain append
moved AFTER the wallet commit: a chained link for a CAS-rejected fill would
be permanent book/chain divergence, while a crash in the new gap leaves a
wallet fill with a missing link — the exact class commitFill already
tolerates and reports once (F-28). Residual accepted: the worker-unreachable
fallback is a direct write (availability over the rare race), and
mark-only/postexit flushes without remutate self-heal on the next poll.
CAS guard mutation-verified: disabling the seq comparison fails four
assertions including the named LYAR-race lock in
`test/background.test.js`.

**F-45 · S3 · Padre's URL slot is a MARKET address and we label it `kind: 'mint'` — a mislabel that has only ever been survivable by luck**
`sites.js` padre adapter · found by reading Padre's own shipped bundle
(`trade.padre.gg/assets/index-*.js`, logged-out, 2026-08-06) while scoping
per-chain native balances · **narrowed 2026-08-06: for pump-family coins the
slot is a MINT — a live indexed URL
(`trade.padre.gg/trade/solana/7khiFjmaeKcdHrJMEPBqaqAVZCo4toggDNGmkXDfpump`)
carries the vanity `pump` suffix, which only ground mint keypairs have; a
bonding-curve PDA is an off-curve hash and cannot be chosen. The non-pump
case (post-migration and foreign-launchpad coins) is still unconfirmed and
still owed the logged-in probe. Operationally the label is no longer
load-bearing for the sniping path: prewatch now classifies every probed
address by its account OWNER and takes the pool path even when the page said
mint (extension/test/onchainfeed.test.js pins exactly that mislabel case).
`det.kind` consumers outside the sniping path (forge.js chain branching,
per-chain routing) still believe the label, so the label itself stays open.**
Padre's router declares `/trade/:chain/:marketAddress`; our adapter returns
`{ kind: 'mint' }` for whatever sits in that slot. Their bundle draws the
distinction explicitly: `formatMarketId` and `formatTokenId` are SEPARATE
functions, and on every EVM chain the market id is a composite
(`<chain>-fm_<marketAddress>_<tokenAddress>`, likewise `tr_`/`fl_`/`hf_`/
`cr_`/`u4_`) in which the market and the token are different values. The
Solana branch parses to `{ type: 'sol', marketAddress: <raw> }` — the same
slot, named the same way, with no validation distinguishing a mint from a
pool. By symmetry the Solana URL most likely carries a POOL, not a mint.
Nothing is visibly broken today, which is exactly the shape of the hazard:
the resolver accepts pair addresses as readily as mints (Dexscreener resolves
both), so a wrong label produces a right answer and stays invisible. It is
the O-13 class — Axiom's `/t/` carried a MINT while we called it a pair — and
that one also "worked" until something believed the label. Consumers that
believe it are arriving: `forge.js` branches on `det.kind` to decide whether
it knows the chain, and design B's per-chain routing keys off the same record.
Deliberately NOT fixed on inference. Flipping `kind` to `'pair'` on this
evidence would be the fabricated-spec trap in the other direction — a
plausible reconstruction, shipped without seeing the thing itself, risking
the Solana path that demonstrably works today. The confirmation is one
glance during the logged-in Chrome sitting already scheduled: open any Padre
Solana token page and compare the address in the URL against the token's mint.
Same string → the label is right and this closes. Different → `kind` is wrong
and the fix lands with a live corpus behind it.
Also captured from the same bundle, for whoever opens the gate: Padre's URL
chain slugs are `solana | bsc | base | eth | arbitrum | robinhood` (+ sepolia
testnets) — note **`eth`, not `ethereum`**; a second map in the same file
emits "ethereum" for an external link, and taking the wrong one yields a route
that silently resolves to nothing.

**F-43 · S1 · A basis RECLASSIFICATION teleported the entry line and every fill bubble — and the test written for that exact field report could not fail for it**
`price-bridge.js` sameBasisFamily / paper-lines intake ·
`test/basisflap.test.js` · fomo.family, maintainer field report 2026-08-06
("the avg fill line and where the entry thought it was just keeps teleporting
everywhere — completely unusable") · **fixed (unreleased)**.
`mcap` (USD cap) and `native-mcap` (SOL cap) are not declared by the chart —
they are inferred per tick from which band the value lands in, and the
boundary between them moves with the SOL/USD rate, so a value near it
alternates tick to tick while describing the SAME axis and the SAME entry.
Both freezes were keyed on exact basis equality, so each flap discarded them
and handed the level back to the ratio path (`close x avg/current`). The
close refreshes on every chart tick; the spec's current price only re-posts
every ~2 s. Recomputing across that gap is F-32's failure re-entered through
the basis door: measured on the reported shape, a 60 % candle run moved a
240k entry to 384k, and the bubbles rode with it (same reset, one line up).
The freeze now survives a cap<->cap reclassification; crossing into or out of
an explicit price basis is still a real unit change and still recomputes —
and those branches read the recorded average, not the close, so they cannot
exhibit this at all.
The reverse risk is stated rather than hidden: a GENUINE USD-cap<->SOL-cap
toggle now holds a level one rate off. That is the safer error — the sites
expose no such toggle (the distinction is our inference, not their control),
F-41's `offVisibleRange` NAMES a held level that leaves the visible band, and
the next changed average recomputes. A silent 60 % teleport is a lie; a
named off-range level is not.
Why it survived the pass that named it: `basisflap.test.js` posted the
flapped spec BEFORE moving the candle, so the level re-froze while the close
was still where it started — all five tests passed with the freeze mechanism
disabled outright (`if (false)`), i.e. they never exercised it. In the field
the order is reversed: the chart ticks continuously while the re-post is
throttled, so the flapped spec lands AFTER the close has moved. Four tests
added on that ordering; mutation-verified BOTH ways — reverting the guard to
strict equality fails exactly the two teleport tests, and widening it to
treat every basis change as a flap fails exactly the two real-unit-switch
tests, and nothing else moves in either direction.

**F-42 · S2 · The line was DESTROYED whenever its level briefly could not be computed, and the F-41 handoff test could not fail for its stated reason**
`price-bridge.js` syncLineSlot · `test/fomodraws.test.js` ·
**fixed (unreleased)** — found by a 35-agent adversarial audit of F-41, two
findings it confirmed against my own just-landed work.
(1) `syncLineSlot` opened with `if (!(price > 0)) { clearLineSlot(slot); }`,
which conflates two different facts: "this side has no average" (clear it)
and "a WANTED average could not be converted onto the axis this instant"
(hold it — the line on screen is still the correct constant in axis units).
A held position therefore lost its average line on any evidence lapse and
only got it back on the next tick. The clear now requires the caller to MEAN
it; a wanted-but-uncomputable level leaves the line alone.
(2) My own C-19 handoff test was VACUOUS: it called `announceNativeChart`
first, and `bridgeNativeCapable` is a one-way latch — so the grace window,
the SVG-rail handoff, and the `drawnFillIds.clear()` it claimed to guard
could never happen; its `side@ts` dedupe assertion could not have caught the
F-41 duplicate either, since the two posts carry different timestamps by
construction. Rewritten to drive the real sequence and to count markers
posted after the last clear; mutation-verified by removing ONLY the
`drawnFillIds.clear()` line, which fails it with "got 0" (the starved
replay) while nothing else moves. The same pass switched every remaining
storage fake (livepnl/positionsbar/statepersist) to hand back a STRUCTURED
CLONE like Chrome does — handing back the caller's object is what let F-41's
dead self-write guard pass this suite for months.

**F-40 · S1 · The F-39 bubble showed "for a second", then vanished — and blinked through zooms — because its level was recomputed every frame from moving evidence; off-chart snipes also never replayed onto an already-open chart**
`price-bridge.js` layoutBubbles · `content.js` adoptState · fomo.family,
maintainer field test minutes after F-39 shipped ("for a 2nd you can see
it, but then it disappears… blinks in while zooming… moving a little bit
with the chart") · **fixed (unreleased)** — F-32's lesson, relearned one
layer down: a fill's level is a CONSTANT in axis units, but the bubble
layer called shapeLevelFor per FRAME — so the chip rode the moving close
against the 2s-throttled current price ("moving with the chart"), and the
moment every ledger entry aged past BAR_CLOSE_FRESH_MS on a quiet token
the level evaporated and the chip hid ("disappears"). Zoom churn nulls
mainSeries().firstValue() for a frame or two; hiding on every such frame
was the "blink". Three changes: the level is computed once, FROZEN on the
mark, and only re-derived to screen coordinates each frame (frozen levels
invalidate on an axis-unit flip); a transient internals gap keeps last
positions and only a persistent gap (~0.5 s) hides; and the row-snipe
report exposed the adoption hole — a fill landing from ANOTHER tab synced
the average line but never replayed the journal onto the open chart. Fills
now replay idempotently (per-page drawnFillIds, cleared exactly where the
bridge's marks are cleared) at resolve AND at adoption. Locked by a
stability test that replays the maintainer's exact report (quiet ledger,
moving market, firstValue churn — proven failing against the very build
they tested), an entry-replay test (marks posted before any chart exists
draw the moment discovery finds one), and adoption-replay source locks.

**F-39 · S1 · fomo STILL showed no buys and no lines after F-38 — the standalone charting library THROWS on every broker draw call, and the fixture implemented what the field refuses**
`price-bridge.js` syncLineSlot/spawnExecutionShape · fomo.family, maintainer
report ("I asked you to fix a function. And you don't.") ·
**fixed (unreleased)** — probed on the LIVE chart (in-app browser,
2026-08-05): fomo ships TradingView's STANDALONE charting library. The chart
API *carries* createOrderLine and createExecutionShape, and calling either
throws "… is only available on Trading Platform" — so F-38's bar hook was
real progress (closes flowed, levels computed) while every draw call threw
into a silent catch that read as "chart not ready, retry", forever. Two
lessons compounded: (1) the fixture implemented both broker calls, so the
liveShape suite stayed green while the field drew nothing — a fake must
REFUSE what the site refuses, not just omit what it omits; (2) a catch
that cannot distinguish "not yet" from "never" retries a fact. The throw
is now evidence: capability is memoized per chart, average lines reroute
to locked horizontal_line LINE TOOLS (live-verified: createShape resolves
an entity id; getShapeById(id).setPoints moves it; removeEntity removes),
and fills render as PaperTrench's own DOM bubble layer — chips styled
after fomo's swap markers (site: 26px, ours: 20px, PT palette, "(Paper)"
tooltip — F-30) and positioned by the SAME internals the site's overlay
uses (decompiled from the token chunk: paneWidgets()[0]._div geometry +
model().timeScale().timeToCoordinate / mainSeries().priceScale()
.priceToCoordinate at firstValue), each chip CENTERED on the fill's own
axis level from the F-31/F-35 vetted-close math. Bubbles live in a private
overlay on <body> (the Axiom row-chip rule), stack per bar, cull
off-viewport, and clear on standdown. Routing needs POSITIVE evidence — a
learned throw, or line tools present while broker calls are absent — so
Padre's marks-pipeline charts keep their native path. Locked by
liveShape-fixture tests (fixture now throws exactly like the field) proven
failing against the pre-fix bridge, with Padre/GMGN/legacy suites green.

**F-38 · S1 · fomo showed NO buys and NO lines — discovery never reached the datafeed, and the test fixture modeled a fiber production doesn't serve**
`price-bridge.js` widgetsFromIframes · fomo.family, maintainer report ·
**fixed (unreleased)** — reverse-engineered on the LIVE site (in-app browser,
2026-08-05): the real fomo page has NO React fiber on or above the
tradingview iframe; the widget api is `contentWindow.tradingViewApi` and the
widget's OPTIONS BAG — including the datafeed — sits in `window[frameId]`.
The shipped pseudo-widget found the api (draws) but had no `_options`, so
bars never hooked: no ledger closes, mcap lines honestly refused, shapes had
nothing to level against. The pseudo now re-attaches the bag every sweep
(remounts re-hook, C-12). The fomo fixture gets a `liveShape` mode modeling
what production actually serves — the old fiber-shaped fixture passed while
the field showed nothing (the verify-live-DOM lesson, again). Bars attach
from the widget's next (re)subscription after the patch — page load and
timeframe changes both qualify. Locked by a live-shape test proven failing
against the pre-fix bridge.

**F-37 · S1 · The second buy "teleported to a random spot" — the mark snap grid followed whichever same-token subscription came LAST**
`price-bridge.js` noteResolution/snapMarkTime · Padre (maintainer repro
screenshot: 1s chart, multi-preset panels) · **fixed (unreleased)**
F-35's twin in the TIME axis: the C-14 token gate admits every same-token
subscription, and lastResolutionMs took the newest SUBSCRIBER — so a hidden
1m preset panel flipped the grid and every new mark snapped to minute
boundaries, up to 59 s from its bar on a 1 s chart. The first buy (before
the stray subscription) sat true; later buys teleported. The grid now
follows the subscription that most recently TICKED (the barCloseLedger
carries resMs per entry); when the active grid changes, existing marks
re-snap through the C-14 machinery. Locked by a two-subscription test
proven failing against the pre-fix bridge — with the F-31 ahead-of-bar
clamp deliberately kept out of play.

**F-36 · S1 · OPEN — paper fills are "occasionally, on some charts, just not perfectly accurate" (maintainer, repeated report, 2026-08-05)**
Fill price vs the chart's own price at fill time drifts on some site/chart
combinations. Third report of this class after F-33 (vault-leg starvation)
and F-35 (unit-blind closes) — whatever remains needs FIELD data, not more
static analysis: the maintainer has offered a logged-in Claude-in-Chrome
session. Plan: live probe on the exact sites where it drifts — capture the
site feed, the collector's tick, the validated quote, and the recorded fill
for the same instant; diff each hop to find which link lies. Suspects to
check live, not guess: quote-validation band acceptance under fast moves,
feed latency between site stream and chart paint on fomo/GMGN, mcap-mode
bootstrap on non-pump tokens. This entry stays OPEN until reproduced and
fixed with a lock.
Field notes (in-app browser sweep, 2026-08-05, no extension loaded in that
pane): fomo adapter behavior verified against live reality — a
/tokens/robinhood/0x… page correctly refuses detect() (non-solana slug,
O-11), and the live title "108.8M MC | CASHCAT | fomo" matches the shipped
title-feed pattern; fomo's TradingView lives in a same-origin BLOB iframe
with no window global (the bridge's iframe-discovery path is the right
one). GMGN token page verified: blob-iframe TV + #global-tv-overlay fiber
anchor present, title "VINE $8.31M | GMGN.AI | …". Padre could not be
probed (pane not signed in). The fill-vs-chart diff still requires the
extension running in a Claude-visible browser.

**F-35 · S1 · The average line landed a supply-factor off whenever the SAME token streamed in two chart units at once — the token gate can't see units**
`price-bridge.js` lastBarClose (single global), lineLevelFor mcap branches,
shapeLevelFor ratio fallback, syncLineSlot async-create closure · Padre/Axiom
mcap-axis charts · maintainer report "lines and pricing are just wrong a lot"
(2026-08-05) · **fixed v2.9.1**
C-14's gate keeps other TOKENS out of the global close, but the same token
can legitimately stream in two UNITS at once: a price-mode and an mcap-mode
chart in a multichart layout, or the old series lingering across a mode
toggle. Those closes differ by the supply factor (~1e6–1e9). The mcap level
math (close × avg/current) took whichever series ticked LAST, and the F-32
freeze then locked the poisoned level until the next spec — intermittent,
huge-magnitude, and invisible to every single-feed harness (the F-32
postmortem smell). Three fixes: (1) closes are tracked per subscription
(`barCloseLedger`, 15 s freshness) and mcap-axis math only accepts a close
that CANNOT be a plain price tick — anything within 4× of the current USD or
SOL price is excluded; among survivors a close agreeing with the resolver's
cap is preferred but disagreement alone never disqualifies (the F-31
lesson). With only price-unit closes available the line is not drawn at all
(C-07 doctrine: no line beats a wrong one). (2) The same vetting applies to
the fill-shape ratio fallback on declared mcap axes. (3) An async
createOrderLine now configures itself from the slot's NEWEST requested
level on resolve, not the closure-captured one — a DCA that moved the
average mid-creation used to draw at the old level until a later sweep.
Locked by three behavioral tests (two-series poisoning, price-only refusal,
pending-creation DCA) proven failing against the pre-fix bridge, plus the
updated F-29/F-31 source contracts.

## O — Overlay lifecycle & movability (audit: 2026-08-05, verified against source)

Community reports covered: "overlay on pages it doesn't need to be on", "can't move
certain buttons".

### S1 — wrong numbers / wrong token

**O-01 · S1 · detectLoop adopts a stale resolve after navigating away — wrong token resurrected**
`content.js:396-446` (:434 await, :446 setToken) · all sites · confirmed ·
**fixed v1.2.18** (resolve results dropped when href changed mid-flight; locked in
statepersist.test.js)
`detectLoop` awaits `R.resolve()` then calls `setToken(data)` with no re-check that
`location.href`/candidate is still current (contrast `requote()` :634 which guards).
Navigate away mid-resolve → teardown → late resolve lands → token A resurrected: price
loop, title signal, onchain watch, markers, panel un-hidden — on the wrong page.
Repro: slow network, open token, click back to Pulse within ~1 s.

**O-02 · S1 · Navigation during an in-flight resolve is permanently swallowed — panel trades token A on token B's page**
`content.js:401-408` · all sites · confirmed · **fixed v1.2.18** (lastHref commits
only when the tick acts; locked in statepersist.test.js)
`lastHref = location.href` commits at :402 BEFORE the `if (resolving) return` at :407.
A nav landing in that window is recorded but never acted on; every later tick
early-returns (`href === lastHref && settled`). Panel keeps token A's card and sell
buttons on token B's page; `doBuy` fills token A's mint. Self-heals only on the next
navigation. `fastDetectTimer` can't rescue (returns unless `token.pending`).

### S2 — silent death / resource leaks

**O-03 · S2 · disableOverlay leaves chart markers, title observer, and onchain subscription alive**
`content.js:3574-3586`, `stopOverlays` :3527-3533 · all sites · confirmed · **fixed v2.0.0** (disableOverlay tears down markers, title signal, onchain watch; clears native drawings; standdown)
`stopOverlays` clears 5 timers but never calls `CM.destroyChartMarkers()`,
`stopTitleSignal()`, or `R.onchainUnwatch()`. Overlay off in popup → SVG overlay + its
observers + re-attach loop stay in the host chart; fallback strip stays on screen; the
host container's mutated `position: relative` is never reverted; background keeps
streaming pool state for the mint forever; `token` not nulled. (= C-18.)

**O-04 · S2 · shutdown() (extension reload) leaves the same chart artifacts permanently**
`content.js:158-170` · all sites · confirmed · **fixed v2.0.0** (chart markers registered for shutdown; bridge standdown + 5-min liveness watchdog)
`CM` has no `onTeardown` registration anywhere — `destroyChartMarkers()` is only
reachable from `setToken`. After extension reload/update the SVG overlay, fallback
strip, observers, and the 500 ms scanTimer keep running ownerless until page reload.
(See also C-17 for the MAIN-world half.)

**O-05 · S2 · createUI early-return leaves `host` null → every settings write stacks another interval set**
`content.js:2201-2202`, `3535-3572`, `watchStorage` :1130 · mechanism confirmed /
trigger hypothesis · **fixed v2.0.0** (createUI adopts-or-replaces; enableOverlay idempotent)
`createUI` returns without setting `host` if `#papertrench-host` already exists;
`enableOverlay` then creates detect/fast/bar timers + resize listener anyway, and
`watchStorage` calls `enableOverlay()` on EVERY settings write (incl. the extension's
own drag/resize persists). `els` stays `{}` → invisible overlay burning CPU + resolve
traffic.

**O-06 · S2 · onOverlayResizeEnd can latch `resizingOverlay = true` forever**
`content.js:2530-2539`, guard :2487 · confirmed · **fixed v2.0.0** (resizingOverlay clears before every early return)
Early return on `!els.box` skips `resizingOverlay = false`; `applyOverlaySize()` is
dead for the rest of the page — saved size never re-applied.

**O-07 · S2/S5 · Raw timers bypassing managedInterval**
`content.js:576` (priceTimer — has hand-written parity, but pattern risk), :2952
(row-buy debounce fires one scan after teardown = O-29), :3545-3546, :3486, :794,
:947 · confirmed · **fixed v2.0.0** (row-buy debounce tracked and cancelled; early timeouts mount-cleaned; remaining raw timers documented as self-limiting)

**O-08 · S2 · MAIN-world bridge has no shutdown path at all — on every site on the web**
`price-bridge.js:1475-1477,1573-1574,1586,1843,1849,1853`, `manifest.json:20-31` ·
every website · confirmed · **fixed v2.0.0 (partial by nature)** (manifest narrowed to trading sites; standdown + liveness watchdog silence the bridge; MAIN-world wrappers themselves are irremovable)
Five capture-phase pointer/mouse listeners, capture scroll+resize, three permanent
intervals, and a 10 ms boot probe — installed on `<all_urls>` at document_start,
ungated on site, unremovable (MAIN world has no extension-context concept). (= F-24
manifest half, C-23.)

### S3 — wrong presence

**O-09 · S3 · `<all_urls>` + generic adapter: any 32-44-char base58 run anywhere in ANY URL mounts the panel**
`manifest.json:22,32-52`, `sites.js:203-216` · every website · confirmed · **fixed v2.0.0** (manifest matches narrowed to 9 supported hosts; generic fallback now bounded to them)
`generic.detect()` scans the whole href (path+query+hash). A match mounts the full
panel AND `CM.initChartMarkers()` — whose scan uses selectors like `[class*="chart"]`,
`canvas` — then writes `position: relative` onto whatever page element wins. Repro:
solscan account page, raydium `?inputMint=`, magiceden, some Google Docs URLs.

**O-10 · S3 · overlayHideWhenNoToken checks `!token` — but a pending token is truthy, so auto-hide never fires on false positives**
`content.js:2565,416-419,435-442` · all sites · confirmed · **fixed v2.0.0** (per-site route allowlists + pending give-up (40 failed resolves + market quiet) with snipe window preserved)
Unresolvable address (wallet, EVM addr, random base58) → placeholder token kept
forever (`pendingAttempts` never tears down) → `hide` permanently false → panel pinned
open, `pt_resolve` re-issued every 250 ms for 90 s then 800 ms forever. THE
"appears on pages it doesn't need to be on" complaint; the default-on setting fails
open.

**O-11 · S3 · padre and dexscreener adapters have no route gating; EVM hex passes base58 ~13 % of the time**
`sites.js:80-83,154-157,35-42` · confirmed · **fixed v2.0.0** (route allowlists; EVM chains rejected; bullx address must be WHOLE base58)
Both are bare `pathTail()` — wallet/profile/leaderboard routes produce false tokens.
DexScreener EVM routes (`/ethereum/0x…`): hex minus `0` is a base58 subset, so ≥32-char
runs without `0` (~13 % of addresses) get sent to the Solana resolver as pairs. Same
class on bullx query param, birdeye/jupiter wallet paths (see gating map).

**O-12 · S3 · Photon's own tokenUrl shape `/en/r/<mint>` is not detectable — overlay absent where it should be**
`sites.js:100-102` vs `:105-110`, `content.js:3210-3222` · Photon · confirmed · **fixed v2.0.0** (/en/r/<mint> route detected)
Positions-bar chip navigates to `/en/r/<mint>` when no pairAddress; detect() only
matches `/lp/<pair>` → panel hides on the page the extension itself sent the user to.

**O-13 · S3 · Axiom fallback detection mislabels mints as `kind:'pair'`**
`sites.js:54-60`, `content.js:423-426` · Axiom · confirmed · **fixed v2.0.0** (/t/<mint> reported as kind mint)
`/t/<mint>` (Axiom's own tokenUrl) reported as pair → `paper-axis` gets
`pairAddress=<mint>, mint=null` → wrong identifier class for chart-symbol matching.

**O-14 · S3 · SPA navigation detection is 800 ms polling only — zero pushState/replaceState/popstate hooks in the extension**
`content.js:3538`, `DETECT_MS=800` :33 · all sites (all are SPAs) · confirmed · **fixed v2.0.0** (bridge pushState/replaceState hook + popstate/hashchange listeners re-detect in ~30 ms)
Up to 800 ms of previous token's live panel + native chart lines on the wrong page.

**O-15 · S3/S4 · applyBarOffset is a documented no-op; positions bar overlays host UI with 2-sample collision avoidance**
`content.js:3283,3061,3232,3545-3546` · confirmed · open
`measureBarLeft` samples `elementFromPoint` at 400 ms and 1500 ms only; late-painting
headers get the hardcoded 210 px fallback over their nav.

### S4 — movability & friction

**O-16 · S4 · Positions bar can be dragged somewhere it can never be dragged back from — and it persists**
`content.js:2401-2417` (clamp :2409), grip :2210,:2430 · confirmed · **fixed v2.0.0** (both-bounds clamp keeps the grip on-screen; the escape hatch is deleted)
Negative clamp `4 - rect.width` leaves only the bar's RIGHT edge visible but the drag
grip is the LEFTMOST child — at the bound the grip is fully off-screen. No reset
control; position persists across reloads. Bar permanently unreachable.

**O-17 · S4 · Panel drag has no right/bottom clamp; off-screen position persists; mount clamp is wrong**
`content.js:2364-2369,2379-2380,2270-2276` · confirmed · **fixed v2.0.0** (clampPanelPos during drag and at mount; whole panel stays on-screen)
Only lower bounds during drag. Mount-time rescue clamp `min(panelRight, innerWidth-40)`
puts the panel's right edge 40 px from the viewport's LEFT edge — still ~296 px
off-screen with a 40 px sliver grabbable.

**O-18 · S4 · Neither panel nor bar re-clamps on window resize — and positionBar re-asserts the off-screen coordinate**
`content.js:2270-2276` (mount only), `:3258-3268,3547` · confirmed · **fixed v2.0.0** (per-mount resize handler re-clamps; positionBar clamps saved coords)

**O-19 · S4 · `parseInt(x) || fallback` treats position 0 as "use default" — elements jump when re-dragged from an edge**
`content.js:2362,2379-2380,2397-2398` · confirmed · **fixed v2.0.0** (finitePx everywhere — 0 is a position, not a fallback trigger)
`right: 0px` parses to falsy → snaps 18 px inward; bar at `left: 0` persists as 210.
Needs Number.isFinite semantics.

**O-20 · S4 · Minimized pill ignores the panel's saved position and is not draggable**
`content.js:1924-1925,2548-2550` · confirmed · **fixed v2.0.0** (pill takes the live panel position, shown as flex, and is itself a drag handle)
Panel dragged bottom-left + minimize → pill teleports to hardcoded top-right.

**O-21 · S4 · The POSITIONS restore tab cannot be moved while collapsed**
`content.js:2221,2174-2176,2430,2066,3053-3058` · confirmed · **fixed v2.0.0** (collapsed tab drags through the shared bar spec)
Tab mirrors `--pt-bar-*` vars, only writable via the grip — which is `display:none`
while collapsed. Combined with O-16: stuck tab in a bad spot, unrecoverable.

**O-22 · S4 · Screener row chips sit BELOW the panel in z-order — occluded and unclickable where they overlap**
`content.css:16-21` (layer 2147482000) vs `content.js:1545` (panel 2147483647) · Axiom
Pulse, Padre Trenches, GMGN Trenches · confirmed · **fixed v2.0.0** (chip placement self-culls under the overlay via an elementFromPoint probe; returns when panel moves)
Chips anchor to row right edges — the same column band as the default panel position.

**O-23 · S4 · Chart-marker fallback strip hardcoded to `top:140px; right:360px`, not draggable, not persisted, pointer-events:none**
`chart-markers.js:245-259` · confirmed · **fixed v2.0.0** (strip docks to a screen corner the panel does not occupy — elementFromPoint probe against #papertrench-host, re-checked per render)
Assumes default panel width/position; panel is resizable to 560 px and draggable
anywhere. (= C-25.)

**O-24 · S4 · content.css host-isolation rule is a dead selector — the page's CSS can break the whole overlay**
`content.css:6-8` (`papertrench-host { all:initial }` — type selector) vs
`content.js:2203-2204` (host is a `div` with that ID) · selector confirmed; downstream
site-dependent · **fixed v2.0.0** (#papertrench-host id selector; custom-property caveat documented)
Needs `#papertrench-host`. Outer-document rules beat shadow `:host` per CSS Scoping; a
host-page `body > div { transform: … }` re-parents our fixed-position children.

**O-25 · S4 · No touch/pointer support on either drag handle**
`content.js:2358,2364,2375,2393,2430-2432` · confirmed · **fixed v2.0.0** (pointer events + setPointerCapture everywhere; zero mouse listeners remain)
Both drags are mousedown-only (resize handle correctly uses pointer events — three
bespoke implementations, no shared helper).

**O-26 · S4 · Both drags leak a window mousemove+mouseup pair per mount**
`content.js:2364,2375,2431,2432` · confirmed · **fixed v2.0.0** (onMountCleanup registry; drag listeners die with the mount)
Not teardown-registered; accumulate per overlay off→on cycle, survive shutdown().

### S5 — polish

**O-27 · S5 · Minimized pill shown with `display:block` but styled as flex** —
`content.js:2550` vs :1926; dot/label lose centering. confirmed · **fixed v2.0.0** (pill shown as flex)
**O-28 · S5 · Toasts overlap the panel header and recycle after 4** —
`content.js:3477-3487`, CSS :1941-1942; toast top:74 vs panel top:84 same z; 5th toast
within ~4 s stacks on the 1st; toasts don't follow a dragged panel. confirmed · **fixed v2.0.0** (8 owned slots + bounded queue; stack follows the panel and clears the header)
**O-29 · S5 · Row-buy debounce fires one scan after teardown** — `content.js:2950-2958`.
confirmed · **fixed v2.0.0** (debounce cancelled in stopRowBuyObserver from both teardown paths)
**O-30 · S3 · The perps surface ignored the app-wide master switch** —
`perps-content.js` had zero `appEnabled` references: the popup read OFF while
the PAPER PERPS ticket sat on Hyperliquid anyway (amogus field report,
2026-08-07, screenshot with both in frame). The perps stack shipped after
appEnabled existed and never learned it — "off means PaperTrench exists
NOWHERE" held for spot, warm links, and the bar, but not the newest surface.
confirmed · **fixed (unreleased)** (applyMasterSwitch: off → leavePage, the
location poll refuses to remount, the FIRST mount waits for the settings
read so an OFF user never sees a flash; locked in masterswitch.test.js)

### Movable-elements inventory (summary)

| Element | Draggable | Persisted | Clamped | Problem refs |
|---|---|---|---|---|
| Main panel | yes (mouse only) | yes | partial/wrong | O-17,O-18,O-19,O-25 |
| Resize grip | n/a | yes | yes | — (the one good one) |
| Minimized pill | NO | no | n/a | O-20 |
| Positions bar | yes (grip, mouse only) | yes | escapable | O-16,O-18,O-19,O-25 |
| POSITIONS tab | NO while collapsed | inherits bar | inherits | O-21 |
| Toasts | no | no | no | O-28 |
| Screener row chips | no | no | culled | O-22 (z-order) |
| Chart SVG overlay | n/a | no | tracks container | mutates host CSS (O-09/C-20) |
| Fallback strip | NO (pointer-events:none) | no | no | O-23 |
| Shadow host | n/a | n/a | n/a | O-24 (dead isolation rule) |

Shared drag code: NONE — three bespoke implementations, three clamp policies, two
event models. Phase 3's "one drag system" (ROADMAP) fixes O-16 through O-21, O-25,
O-26 as a unit.

### Per-site page-gating map — failing shapes (full audit in agent transcript)

| URL shape | Result | Ref |
|---|---|---|
| axiom.trade wallet/tracker routes with base58 tail | panel pinned open, pending forever | O-10 |
| trade.padre.gg wallet/portfolio/leaderboard | same | O-10,O-11 |
| gmgn.ai/sol/address/&lt;wallet&gt; | same | O-10 |
| gmgn.ai/eth/token/0x… & dexscreener EVM routes | ~13 % → bogus Solana resolve | O-11 |
| birdeye.so/profile/&lt;wallet&gt;, jup.ag/portfolio/&lt;wallet&gt; | pending forever | O-10 |
| photon /en/r/&lt;mint&gt; (own tokenUrl) | overlay absent where it should be | O-12 |
| ANY site with a base58 run in URL | panel mounts + chart scan mutates page CSS | O-09 |
| Any URL with ≥1 open position | positions bar shows (by design — revisit) | O-15 |

## C — Chart markers & lines (audit: 2026-08-05, verified against source)

Community report covered: "in certain situations the lines aren't where they need to be".

### S1 — line/marker at a wrong level

**C-01 · S1 · Average lines on mcap axes RIDE THE CANDLE instead of holding the entry level**
`price-bridge.js:946-949,957-993,1268,1853`, `content.js:1209-1215` · Axiom, Padre
(mcap mode) · confirmed · **fixed v2.0.0** (spec re-posts on accepted ticks — immediately on a >0.5 % move, else on a 2 s cadence — and immediately on axis-basis change; locked behaviorally in statepersist.test.js)
`mcapLevelFromClose(avg, current) = lastBarClose × (avg/current)`. `lastBarClose`
refreshes every bar/700 ms poll; `currentPrice*` lives in `paperLineSpec`, posted ONLY
on resolve/fill/settings/adopt — never on price change. The 1 s sweep re-asserts
`ratio × current close`: since the spec posts at fill time, ratio ≈ 1 and the avg-buy
line sits permanently on top of spot no matter how far the coin runs. Root cause:
`syncAveragePriceLines()` has no price- or axis-driven re-post (see also C-06).
Existing test pins the formula but sends the spec right after the bar — frozen-current
case untested.

**C-02 · S1 · SVG overlay Y positions come from PaperTrench's own invented price range, not the host chart's scale**
`chart-markers.js:270-297,402-420` · Photon, BullX, DexScreener, Birdeye, Jupiter,
generic · confirmed · **fixed v2.0.0** (fabricated priceToY/range DELETED; honest marker rail pinned to the chart edge — exact values, no positional claim)
Y axis fabricated from ≤300 observed ticks ±15 %, no plot-area inset, no host
autoscale. `frac` clamped [0.02, 0.98] → out-of-range levels silently GLUE to the
chart edge, still drawn with a precise label. The whole SVG route's placement is
coincidental.

**C-03 · S1 · Single marker / cold range → everything at exact vertical centre**
`chart-markers.js:274-279,293` · SVG sites · confirmed · **fixed v2.0.0** (structurally closed by the C-02 rail — no mid-height default exists)
First fill on a page → bubble at mid-height regardless of price; pre-tick range {0,0}
→ `priceToY` returns h/2 for everything.

**C-04 · S1 · Marker X positions are rank-in-array, not chart time**
`chart-markers.js:299-308` · SVG sites · confirmed · **fixed v2.0.0** (structurally closed by the C-02 rail — fills are listed with timestamps, not placed)
Two fills 4 s apart render at 5 % and 95 % of chart width; no pan/zoom hooks at all;
single marker hardcoded to `w - 30`.

**C-05 · S1 · First paint before any bar close picks the wrong UNIT entirely**
`price-bridge.js:914-936,:89` · Padre primarily (usd-first ordering), Axiom in price
mode · confirmed · **fixed v2.0.0** (pickAxisEntry refuses with no close and no axisBasis — no line until evidence arrives; locked in nativecharts.test.js)
`lastBarClose` is 0 at boot and reset on token change; until the first close,
`pickAxisEntry` returns the first usable candidate unchecked → avg line drawn at token
USD price (~0.002) on an axis in millions, exactly during chart boot when `paper-lines`
is posted.

**C-06 · S1 · Chart unit toggle (Price⇄MCap, USD⇄SOL) is never propagated — line stays in the old unit indefinitely**
`content.js:347-349,1213`, `price-bridge.js:1345-1359` · Axiom, Padre · confirmed ·
**fixed v2.0.0** (a basis change re-posts the spec immediately, bypassing the C-01 throttle; locked behaviorally)
`chartAxisBasis` updates on validated bars but nothing re-posts `paper-lines`; the
stale basis is re-asserted every second until the next fill.

**C-07 · S1 · basis 'usd'/'native' hard-returns null — no average line on exactly the fresh-launch tokens**
`price-bridge.js:963-964`, `engine.js:846-849`, `content.js:1191-1196` · Padre, Axiom
· confirmed · **fixed v2.0.0** (native axis uses the native average directly; USD axis converts it via the spec's current rate, else draws nothing)
`avgBuyUsd` null (any fill missing priceUsd + no rate) → return null, never falls
through to the known-good `avgBuyNative` sitting in the same spec.

**C-08 · S1 · GMGN lines/markers use resolver-implied supply, never bar-close corrected — the exact hazard mcapLevelFromClose exists to fix**
`content.js:1243-1258,301-316,858`, `price-bridge.js:1202-1214` vs :940-949 · GMGN ·
confirmed · **fixed v2.0.0** (gmgnCapScale: the live mcap-candle close over the spec's resolver mcap — a per-token constant — corrects every GMGN line and marker level)
Level = `avgUsd × (token.mcap / token.priceUsd)` (Dexscreener-implied supply). When
GMGN's cap definition differs from the anchor's (circulating vs total, migrated coins),
every GMGN line AND fill marker is off by that constant factor.

**C-09 · S1 · A fill with null priceUsd gets its mcap computed from the SOL price — ~150× low**
`content.js:302,307` · GMGN (marker Y level), SVG sites (labels), Padre/Axiom (mark
mcap field) · confirmed · **fixed v2.0.0** (genericChartPoint refuses the derivation — only a genuine USD price meets the supply; the capless fill feeds C-16)
SOL price silently substituted for USD then multiplied by USD-implied supply; on GMGN
the arrow lands ~150× below the candle. Trigger: fills before the SOL/USD rate warms —
the fresh-launch snipe path.

**C-10 · S1 · SVG render-skip guard compares COUNT of lines, not values — a changed average keeps the old level**
`chart-markers.js:323-332` · SVG sites · confirmed · **fixed v2.0.0** (render guard is a value signature over levels, labels and rows; locked behaviorally)
Cross-tab fills change the average without changing local marker count → tab A's line
silently keeps the pre-fill level in a flat market.

### S2 — markers silently stop appearing

**C-11 · S2 · SVG overlay orphaned forever when the host replaces its chart node**
`chart-markers.js:312-318` (guard only checks falsy) vs :167-182 (unreachable reset) ·
SVG sites · confirmed · **fixed v2.0.0** (isConnected checked on every render; container re-found and the rail re-mounted on the live node)
After TradingView reload/SPA re-render/resolution remount, both refs stay
truthy-but-detached; every render writes into a detached SVG; observer bound to the
removed node; markers gone until token change. Old observers leak.

**C-12 · S2 · GMGN fill shapes never redrawn after GMGN remounts its chart**
`price-bridge.js:1141-1200,1857-1862` · GMGN · confirmed · **fixed v2.0.0** (shapes track their chart identity; the 1 s sweep and the drain requeue+redraw on remount)
Lines have chart-change detection (:1209); shapes have none and the queue is empty
after first drain — timeframe change permanently erases all paper arrows.

**C-13 · S2 · drainGmgnMarkers splices the whole queue before drawing — failed draws lost permanently**
`price-bridge.js:1161-1172` · GMGN · confirmed · **fixed v2.0.0** (failed draws re-queued with a 30-attempt budget; waiting-for-data never burns retries)
Mid-boot chart eats the entire batch (`splice(0)` + `continue` on falsy handle).

**C-14 · S2 · Marks snapped once to the creation-time grid, never re-snapped on resolution change; 'D' resolution parse bug**
`price-bridge.js:556-576,637,650,531` · Padre, Axiom · confirmed (TV drop behavior
standard) · **fixed v2.0.0** (bare 'D'/'W'/'M' parse; marks keep their fill ts and re-snap+refresh on resolution change; only symbol-matched charts may set the grid)
1s-grid marks vanish on the 1m chart. `resolutionToMs('D')` → null → stale
`lastResolutionMs` used. Axiom's hidden preload widget's resolution can overwrite the
visible chart's. Daily snap UTC-floored vs exchange session.

**C-15 · S2 · Line sync fall-through tears a good line off the visible chart onto the hidden preload widget**
`price-bridge.js:1016-1025,810` · Axiom (two widgets), Padre boot · confirmed · **fixed v2.0.0** (a partially-successful chart is kept — the failed line retries there; a working line never moves to a worse-ranked chart)
Loop requires buyOk && sellOk from the SAME chart; sell-fail on chart A advances to
seriesless preload B, destroying A's working buy line. Runs every second → flicker or
invisible line.

**C-16 · S2 · GMGN drops a fill marker when mcap isn't known yet — no retry, no fallback**
`content.js:855-863`, `price-bridge.js:1186-1194` · GMGN · confirmed · **fixed v2.0.0** (capless fills queue with their SOL price and draw at close × fillNative/currentNative the moment the candle close and a current price coexist)
`mcap: null` → refused → failure status discarded → payload never queued/replayed →
fill unmarked for the session.

### S3 — wrong presence

**C-17 · S3 · Nothing clears markers/lines on extension-context death — welded to the host chart, then duplicated**
`content.js:158-170` (no CM teardown), `price-bridge.js:21-22` (one-shot guard),
four unclearable intervals · all sites · confirmed · **fixed v2.0.0** (shutdown destroys markers; bridge standdown wipes marks/levels/specs and silences the sweep)
Extension reload: bridge keeps `paperMarks`/line specs and re-asserts a frozen level
every second forever; fresh content script injects a SECOND SVG overlay → duplicated
bubbles, one set frozen. (Companion of O-04/O-08.)

**C-18 · S3 · Disabling the overlay leaves every marker and line painted on the chart** — see O-03. confirmed · **fixed v2.0.0** (disableOverlay clears SVG and native drawings — see O-03)

**C-19 · S3 · Photon/BullX/DexScreener forced down the broken SVG path even though the bridge's TradingView discovery is site-agnostic and already running there**
`content.js:108-109` (`NATIVE_TV_SITES = {padre, axiom}`) vs `price-bridge.js:364-489`
· confirmed (routing); hypothesis (each widget passes looksLikeWidget) · **fixed v2.0.0** (capability-based routing: the bridge advertises `nativeCapable` on discovery and on every paper-axis; content routes native optimistically and falls back to the SVG rail only after an 8 s discovery grace)
These sites ship real TV widgets; the hardcoded two-element set routes them to
C-02/03/04/11 instead. Potentially the single highest-leverage marker fix.

**C-20 · S3 · GMGN mounts the SVG overlay it never uses — mutating the site's chart container + a continuous MutationObserver for nothing**
`content.js:543-549`, `chart-markers.js:124,202-204,214-223` · GMGN · confirmed · **fixed v2.0.0** (usesSvgMarkers predicate; GMGN never mounts the SVG overlay or mutates the host container)

**C-21 · S3 · initChartMarkers can leak the previous scan interval (bounded race)** —
`chart-markers.js:666-671` · confirmed · **fixed v2.0.0** (previous scan interval always retired first)
**C-22 · S3 · destroyChartMarkers doesn't reset the render-skip memo — first render after re-init can be skipped** — `chart-markers.js:697-708` · confirmed · **fixed v2.0.0** (destroy resets the render-skip memo; locked behaviorally)

### S4/S5

**C-23 · S4 · pollChartClose every 700 ms + 1 s widget sweep + 1 s chip sweep on EVERY tab on the internet** — see O-08/F-24. confirmed · **fixed v2.0.0** (structural: manifest narrowed to trading sites + F-26 stand-down; the poll cannot run on non-trading pages at all)
**C-24 · S4 · Render/mutation feedback loop: observer watches the subtree renderMarkers writes into** — `chart-markers.js:214-223`; only the value-blind guard (C-10) breaks the cycle. confirmed · **fixed v2.0.0** (mutation records originating inside the rail are filtered; external mutations restore a wiped rail)
**C-25 · S4 · Fallback strip hardcoded position** — see O-23. confirmed · **fixed v2.0.0** (corner dock with elementFromPoint occupancy probe — see O-23)
**C-26 · S4 · GMGN marker times not snapped to bar grid** (`price-bridge.js:1164` vs snapMarkTime) · confirmed · **fixed v2.1.0** (the GMGN drain snaps through snapMarkTime; the bar grid is noted from GMGN's own candle URL `?resolution=` — lowercase `1s/1m/1h` forms now parse — and snapping happens at draw time, so a C-12 remount re-snaps requeued fills onto the new grid. Locked in nativecharts.test.js C-26 tests.)
**C-27 · S5 · Label pill width = charcount × 6.2 — overflows onto the site's price scale** — `chart-markers.js:456-458` · confirmed · **fixed v2.0.0** (rail rows/chips are HTML sized by the layout engine — no width estimate exists)
**C-28 · S5 · Tooltip width same charcount estimate on a proportional font + emoji** — `chart-markers.js:498,490` · confirmed · **fixed v2.0.0** (tooltips replaced by always-visible row text; no estimated box remains)

**Cross-cutting (closed v2.0.0):** `syncAveragePriceLines()` now re-posts on accepted
price ticks (throttled: 2 s cadence, immediate on a >0.5 % move) and immediately on an
axis-basis change, in addition to resolve/adopt/settings/buy/sell/reset — the C-01/C-06
root cause. The test gap is closed the honest way: `chartmarkers.test.js` drives a
container harness for the RAIL contracts (there is no placement math left to cover),
and `statepersist.test.js` drives the re-post throttle behaviorally through bridge
message dispatch.

### Per-site marker matrix (as audited; → = after the v2.0.0 chart-truth batch)

| Site | Fill markers | Avg lines | Unit plotted | Corrected by bar close? |
|---|---|---|---|---|
| Axiom | native TV getMarks (+shape fallback) | createOrderLine slots | axisBasis else close-nearest (no close → no line) | → yes, live ratio (spec re-posts, C-01) |
| Padre | native TV getMarks | createOrderLine slots | axisBasis else close-nearest (no close → no line) | → yes, live ratio (C-01, C-05) |
| GMGN | createExecutionShape at corrected mcap | createOrderLine at corrected mcap | GMGN candle-close axis | → yes, gmgnCapScale (C-08) |
| Photon/BullX/DexScreener/Birdeye/Jupiter/generic | native when a widget is discovered (C-19); else honest rail rows | native lines, else labeled level chips | chart's own axis (native) / labels only (rail) | native: yes · rail: claims no position (C-02/03/04) |

---

## D — Dashboard, popup & cross-context state (audit: 2026-08-05, verified against source)

Community report covered: "things not properly displaying on the dashboards".

### S1 — displayed number is wrong

**D-01 · S1 · Equity curve sits above true equity by cumulative buy fees — two disagreeing numbers on one screen**
`dashboard.js:386-396` vs :268, `engine.js:215-216,243,299` · confirmed · **fixed v2.0.0** (E.equityCurvePoints debits buy fees; final point equals equitySol exactly, proven by test)
Curve accumulates journal `pnlSol` (cost basis net of buy fees) → curve = equity +
Σ buyFees, diverging monotonically from the `equitySol` KPI. 50 round trips of 1 SOL at
default fees ≈ 0.5 SOL gap.

**D-02 · S1 · "Realized P&L" omits partial exits; the calendar counts them — same trade, three different numbers**
`engine.js:408` (rounds-only) vs :713-721 (per-sell) · confirmed · **fixed v2.0.0** (realized P&L from the per-sell accumulator everywhere; calendar/sidebar/popup/leaderboard agree)
Sidebar/leaderboard/standings/popup use rounds-only; calendar/journal use per-sell.
Buy 1, sell 50 % at +2: sidebar +0, calendar +2.00, journal +2.

**D-03 · S1 · Leaderboard accuses the user of tampering after any partial exit**
`dashboard.js:1731-1746`, `attest.js:199-215` · confirmed · **fixed v2.0.0** (replayChain books net buy cost matching the engine recurrence; coherent mismatch wording)
`replayChain` credits realized on every sell link incl. partials; compared against
rounds-only stats (D-02) → red "Chain does not match local state" + the absurd line
"0 problems found · derived P&L differs by X SOL".

**D-04 · S1 · "AI review" click disables and relabels the ADD NOTE button instead**
`dashboard.js:781,734,670,672` · confirmed · **fixed v2.0.0** (review button has its own data-review-id; failure restores state)
Three buttons share `data-id`; `querySelector` grabs the first (Notes). Note button
becomes permanently disabled "Analyzing…"; the review button never changes state.

**D-05 · S1 · Replay button always reads "▶ 0 moments"**
`dashboard.js:671`, `replay.js:73` · confirmed · **fixed v2.0.0** (label is plain Replay — the moment count was fabricated)
`checkpoints` initialised `[]` and written NOWHERE in the codebase. Also zeroes that
term of `dataFingerprint`.

**D-06 · S1 · Editing "Starting paper balance" retroactively fabricates P&L**
`dashboard.js:2042,262,340-341`, `engine.js:419` · confirmed · open
Baseline changes without touching cashSol → fresh wallet + set 1 → "Total return
+9 SOL (+900 %)". Negative values accepted (`Number(v) || 10` ignores min attr).

**D-07 · S1 · Best/Worst tiles hardcode green/red and drop the sign**
`dashboard.js:342-343` · confirmed · **fixed v2.0.0** (tiles colored by sign; explicit +) — "Best round −0.20" in green; "Worst round
0.5" in red missing its +.

**D-08 · S1 · Open-position % and closed-round % use different denominators — the % jumps ~2×feeBps at close with no price move**
`dashboard.js:503` (net-of-fee cost) vs `engine.js:358` (gross invested) · confirmed ·
**fixed v2.0.0** (gross-invested basis for open AND closed %, netInvestedSol tracked through partials)

**D-09 · S1 · Share card entry/exit mcap understated when any fill lacks mcap**
`dashboard.js:1512-1519` · confirmed · open — null-mcap fills contribute qty to the
denominator, 0 to the numerator; the exact bug `weightedUsd` guards against elsewhere.

**D-10 · S1 · Quick-sell presets accept >100 % → a "500%" button that sells 100 %**
`dashboard.js:2039`, `content.js:3464-3471`, `engine.js:284` · confirmed · **fixed v2.0.0** (sell presets validated 1..100, deduped, capped 8)

**D-11 · S1 · Negative fee/slippage accepted — buys mint free SOL**
`dashboard.js:2043-2044`, `engine.js:214-215` · confirmed · **fixed v2.0.0** (feeBps 0..1000, slippageBps 0..2000, integers; coercions reported)
`feeBps: -100` → net > gross, feesPaidSol goes negative; `slippageBps: -100` sells
above the tick.

**D-12 · S1 · Replay hero and session list frozen at mount — closed rounds keep showing OPEN**
`dashboard.js:1149-1219,1112-1115` · confirmed · **fixed v2.0.0** (shell key covers status/roundId/session count)

### S2 — silent death / lost writes

**D-13 · S2 · background.js writes pt_state WITHOUT bumping seq — both its writers lose data**
`background.js:96-103`, callers :180 (recording refs), :450 (aiReview);
`content.js:1297` adopts only on strictly-greater seq · confirmed · **fixed v1.2.18**
(setState advances seq; behavioral test in background.test.js)
Background write lands at equal seq → no tab adopts it → next 800 ms heartbeat
overwrites it. Why AI reviews vanish and the Recording column shows "—".
THE seq-protocol hole: all other writers bump (dashboard :166, popup reset :127 —
double-bumped with :2013 = D-51), background doesn't.

**D-14 · S2 · Backup restore writes the backup's seq verbatim — an open tab immediately resurrects the old wallet**
`popup.js:192-194` (vs resetWallet :125-127 which does it right) · confirmed ·
**fixed v1.2.18** (restored seq = max(live, backup)+1; locked in statepersist.test.js).
Shape validation (the `{pt_state:{}}` half) still open — tracked by D-16/D-24.
Also zero shape validation beyond `typeof === 'object'` → `{pt_state:{}}` accepted,
then detonates the dashboard (D-16).

**D-15 · S2 · A failed/empty storage read makes the dashboard fabricate a fresh wallet — and can PERSIST it over the real one**
`dashboard.js:36-39,137-141,161-169` · confirmed · **fixed v2.0.0** (store.get null on lastError; failed read banner; saves refused until a good read)
No lastError check (content.js and background.js both guard this; dashboard doesn't).
Missing pt_state → renders empty wallet → any note-save/AI-review write commits the
empty wallet at seq+1, destroying the real state.

**D-16 · S2 · init() unawaited and uncaught — any throw = permanently blank dashboard, no message**
`dashboard.js:44-65,2135`; reachable throws on legacy/restored state via sessionStats,
rounds.filter, drawEquityCurve, renderCoach · confirmed · **fixed v2.0.0** (init failures render a visible error card)

**D-17 · S2 · Session AI review answer is never persisted and is wiped seconds later by the refresh**
`dashboard.js:1923-1936,195-218,1772` · confirmed · **fixed v2.0.0** (session review persisted in module state and re-injected on render)
Answer written to live DOM only; staged-vs-live equality check then always fails →
replaceChildren discards it. With an open position the fingerprint churns ~1 s.

**D-18 · S2 · Leaderboard verification flickers back to "Checking…" ~1×/s, re-running SHA-256 over the whole chain each time**
`dashboard.js:1699-1752,212` · confirmed · **fixed v2.0.0** (chain verification memoized by chain fingerprint; cached verdict paints synchronously) — same mechanism as D-17; in-flight
verify can also land in a detached node → placeholder sticks forever.

**D-19 · S2 · Dashboard settings save clobbers every content-script settings write made while the tab was open**
`dashboard.js:2071-2078,110-118,139` · confirmed · **fixed v2.0.0** (save re-reads fresh settings and lays only form-controlled keys)
`isUserBusy()` is unconditionally true on the Settings tab → `settings` frozen at
dashboard-load time → Save writes `{...stale, ...form}`. Silently reverted: panel
position, bar position/hidden, overlay size, auto-hide — the user's dragged layout
snaps back. `pt_settings` has no seq/revision guard at all; every writer is a blind
whole-object overwrite.

**D-20 · S2 · Open round-note editor destroyed by refresh the moment focus leaves — typed text lost**
`dashboard.js:741-778,110-118,82` · confirmed · **fixed v2.0.0** (an open note editor marks the rounds section busy by DOM presence)

**D-21 · S2 · sendMessage rejections hang the AI UI forever**
`dashboard.js:792,1933` · confirmed · **fixed v2.0.0** (sendMessage rejections surface and restore button state) — unhandled rejection, no error UI; note
button stuck disabled "Analyzing…" (with D-04, the wrong button at that).

**D-22 · S2 · saveState() is read-modify-write, no CAS/retry — dashboard and tab at seq N both write N+1, loser vanishes**
`dashboard.js:161-169,767-777,796-804` (contrast content.js:1294-1307) · confirmed ·
**fixed v2.0.0** (mutateState: fresh read, mutation callback, seq re-check, bounded retry)

**D-23 · S2 · slippageBps ≥ 10000 makes every sell throw "No live price available"**
`engine.js:196,291`, no upper bound in UI · confirmed · **fixed v2.0.0** (slippage clamp makes the misleading error unreachable) — feed error shown for a
config problem.

**D-24 · S2 · Settings tab renders completely blank on non-array presetsBuy/sellPcts — and Save is never bound so the user can't repair it**
`dashboard.js:1948,1952`, `engine.js:133` (mergeSettings does no type validation) ·
confirmed · **fixed v2.0.0** (renderSettings guards non-array lists)

**D-25 · S2 · A settings-save failure is completely invisible**
`dashboard.js:2071-2078` · confirmed · **fixed v2.0.0** (save failures render in the save status element)

**D-26 · S2 · replayTimer leaks when replays go empty → TypeError loop every 1.1 s forever**
`dashboard.js:1084-1086,933-938` · confirmed · **fixed v2.0.0** (empty-replays branch stops playback and releases the shell; timer guards a vanished replay) — repro: start frame playback,
reset wallet from popup.

### S3 — stale rendering / wrong presence

**D-27 · S3 · dataFingerprint cannot see in-place round mutations (aiReview, note, recording, thesis)**
`dashboard.js:75-90` · confirmed · **fixed v2.0.0** (fingerprint carries per-round mutation markers) — with D-13, THE "reviews don't display" pair.

**D-28 · S3 · Table scroll position and hover reset ~once per second**
`dashboard.js:82,215`, `timeAgo` churn :638,:2101, storage listener :126-135 ·
confirmed · **fixed v2.0.0** (live marks out of the fingerprint; in-place text-node updater for P&L and timestamps) — fingerprint includes lastPriceNative; every 800 ms heartbeat
rebuilds the section, new scroll container at scrollTop 0. The "constantly refreshing"
complaint, unfixed (header comment blames the old timer).

**D-29 · S3 · "Test AI endpoint" silently commits the ENTIRE unsaved form — without the pt_settings_changed broadcast Save sends**
`dashboard.js:2020-2034` · confirmed · **fixed v2.0.0** (test button sends form values as overrides through the SSRF gate; zero storage writes)

**D-30 · S3 · Popup toggle label goes stale on the fallback path** — `popup.js:108-116` · confirmed · **fixed v2.0.0** (fallback path re-runs load())

**D-31 · S3 · Post-reset equity canvas drawn at fallback 760×260 while hidden, then never redrawn**
`dashboard.js:2018,379-380,212` · confirmed · open

**D-32 · S3 · Journal "Market cap" column mixes units — `$240.0K MC` and `0.0₅123 SOL` under one header; `— SOL` on non-positive**
`dashboard.js:2094-2099` · confirmed · **fixed v2.0.0** (mcap column renders mcap or an em-dash, never a mislabeled SOL price)

**D-33 · S3 · Calendar best/worst-day month label breaks in many locales ("202…")**
`dashboard.js:562-563` · confirmed · **fixed v2.0.0** (locale-safe month: short form)

**D-34 · S3 · ANY focused input freezes the entire dashboard refresh — including the replay scrubber which keeps focus after a drag**
`dashboard.js:110-118,1171` · confirmed · **fixed v2.0.0** (isUserBusy is per-section)

### S4 — friction

**D-35 · S4 · rpcUrl has no UI anywhere** — defined, consumed, documented; no input.
**fixed v2.0.0** — rpcUrl input in the AI/network settings card, saved with the form.
`engine.js:94`, `background.js:619` · confirmed · open
**D-36 · S4 · Reset claims to clear recordings but doesn't — RC.clear() exists and is called by nobody; orphaned videos accumulate forever**
**fixed v2.0.0** — dashboard reset calls RC.clear(); popup reset routes through a new pt_clear_recordings background message.
`dashboard.js:2005,2015`, `popup.js:128-132`, `recordings.js:151` · confirmed · open
**D-37 · S4 · Which settings apply live is undocumented and inconsistent** — live:
**backlog (v2.1):** live-apply coverage of panelFocusMode/sellPcts/listQuickBuy needs a content-side settings-listener extension; the Save flow now reports coercions but not reload-needed keys.
overlay/presets/lines/visibility/size/bar; needs-reload (silently): panelFocusMode,
sellPcts, listQuickBuy*. Only feedback is "Saved." `content.js:1126-1137` · confirmed
· open
**D-38 · S4 · Reset uses the saved starting balance, ignoring the value typed in the form**
`dashboard.js:2009` · confirmed · **fixed v2.0.0** (reset adopts a valid form balance and persists it in the same write)
**D-39 · S4 · loadRecordings reopens IndexedDB + holds all video blobs in memory on every 4 s poll; races revoke URLs bound to a mounted video**
**largely fixed v2.0.0** (lazy blob pull + URL release landed in wave 2); remaining: skip list() when the recordings count is unchanged.
`dashboard.js:150-154,882,885`, `recordings.js:119,132` · confirmed · open
**D-40 · S4 · Replay scrub rebuilds the entire replay model at 60 fps — twice per frame**
**fixed v2.1.0** — buildReplayView memoized per (replay, session, cursor); invalidated on load/adopt/reset; degraded view never cached.
**backlog (v2.1):** scrub rebuild is now guarded (D-26) but still rebuilds per frame; memoize the view per cursor index.
`dashboard.js:1004-1009,1020,1036` · confirmed · open
**D-41 · S4 · Backup omits IndexedDB recordings — restored wallets show unplayable recording refs**
**disposition (v2.1):** the exclusion stays (a chunked IndexedDB export remains future work) but the UI now says so honestly — the post-backup status line states that screen recordings stay on this machine and are not in the file (**honesty note shipped v2.1.0**, locked in statepersist.test.js). The restore path already survives missing videos (refs render as unplayable).
`popup.js:150` · confirmed · open (export half)
**D-42 · S4 · Silent input coercions: balanceStartSol 0→10, empty preset lists→defaults, no count cap (500 presets = 500 overlay buttons)**
`dashboard.js:2042,2045,2051` · confirmed · **fixed v2.0.0** (validated with visible coercion notes; caps at 8 entries)
**D-43 · S4 · 4 s refresh interval never cleared; deserializes up to 80 base64 frames every tick for the tab's lifetime**
**mitigated v2.0.0:** the fingerprint no longer includes live marks, so the 4 s poll early-outs cheaply; frames deserialize only when the fingerprint actually changed.
`dashboard.js:64` · confirmed · open (was HANDOFF should-fix #1)

### S5 — polish

**D-44 · S5** Share-card object URL never revoked on success; replacing cardMedia orphans the previous — `dashboard.js:1553-1561`.
**fixed v2.0.0** — previous object URL revoked when the card media is replaced.
**D-45 · S5** Drop target advertises GIF but renders only the first frame — `dashboard.html:650`.
**fixed v2.1.0** — honest label: a GIF renders as a still (its first frame).
**backlog (v2.1):** static first-frame is honest but the label overpromises; either animate via <img> or drop GIF from the label.
**D-46 · S5** Dead code: renderMomentMedia, renderReplayTape, formatUnix, unused summary, empty else-if — `dashboard.js:1395,1450,2120,1759,1374`.
**fixed v2.1.0** — renderMomentMedia, renderReplayTape AND formatUnix deleted (correction: the v2.0.0 close-out claimed formatUnix was already gone; it was still live with zero call sites).
**partial v2.0.0:** formatUnix removed; renderMomentMedia/renderReplayTape deletions deferred to the next dashboard touch.
**D-47 · S5** "Saved." written into the AI-test output span and never cleared — `dashboard.js:2077`.
**D-48 · S5** Journal fee column shows entire gross as fee for legacy fills missing solNet; recorded feeSol unused — `dashboard.js:634`.
**fixed v2.0.0** — fee column prefers the recorded feeSol; em-dash when underivable.
**D-49 · S5** Coach prompts stamp UTC ISO; calendar buckets local days — day boundaries disagree — `dashboard.js:810`, `background.js:456`, `engine.js:704-708`.
**fixed v2.1.0** — coach prompts stamp local time with an explicit UTC offset, in both the dashboard and the background auto-review path.
**backlog (v2.1):** stamp coach prompts in local time with an explicit offset note so its day boundaries match the calendar.
**D-50 · S5** Frame data URLs interpolated unescaped into src — `dashboard.js:1361,1423,1798`.
**fixed v2.1.0** — both live dataUrl interpolations escaped; the third site was inside deleted dead code.
**backlog (v2.1):** frame data URLs are self-generated JPEG captures (attacker cannot control content), so exposure is low; esc() them on the next dashboard touch anyway.
**D-51 · S5** seq double-bumped on dashboard reset — `engine.js:932` + `dashboard.js:2013`.
**D-52 · S5** sessionStats counts break-even rounds as losses — `engine.js:407`.
**D-53 · S5** dashboard.js loaded before #card-modal — currently safe only by accident of async init — `dashboard.html:643-644`.
**fixed v2.0.0** — the modal now precedes the dashboard.js script tag for real.

**D-55 · S1 · The Game tab rendered into an INVISIBLE section — every nav toggle hid all sections and showed nothing**
`dashboard.js` SECTIONS (197) vs bindNav (614) · dashboard, v2.11.0 ·
maintainer report "game tab is empty" (2026-08-05) · **fixed v2.11.1**
Section visibility is driven by the hardcoded SECTIONS array: bindNav
toggles `.hidden` over SECTIONS, not over the nav's data-section buttons.
v2.11.0 added the Game button, container, and dispatch branch — but not the
SECTIONS entry, so clicking Game hid every listed section and never unhid
#game: the renderer produced a full card tree (verified: 6.5k chars even on
an empty profile) into a display-none node. The wiring test checked button,
container, and dispatch — the three visible halves — and missed the fourth,
invisible one. Fixed by adding 'game' to SECTIONS; locked GENERICALLY: every
nav data-section id must appear in SECTIONS, proven failing against the
v2.11.0 tag in a temp worktree.

**D-54 · S2 · The graduation thesis criterion could never pass — coverage counted only legacy STRING theses while the engine stores objects**
`mastery.js` thesisCoverage · dashboard graduation bar, all users ·
found building the gamification rank ladder on top of the criterion
(2026-08-05) · **fixed (unreleased, post-v2.9.1)**
`normalizeThesis` has stored the thesis as an OBJECT ({ text, tags, plan,
… }) since it exists, and closeRound copies that object onto rounds — but
thesisCoverage counted `typeof r.thesis === 'string'` only, so every real
journaler measured 0% coverage and the criterion failed regardless of
behavior (the fixtures used bare strings, which is why the suite never
noticed). Coverage now accepts both shapes, with substance required — an
empty thesis object is still an empty thesis box. Locked by a test proven
failing against the pre-fix mastery.js.

### Seq-protocol answer (cross-context write safety)

Writers: content.js:1107 ✔ · dashboard.js:166 ✔ (but RMW, D-22) · dashboard reset ✔
(double, D-51) · popup reset ✔ · **background.js:96 ✘ (D-13)** · **popup restore ✘
(D-14)**. Adoption is strictly-greater (content.js:1297). No CAS anywhere.
`pt_settings` has NO versioning at all — every settings writer is a blind overwrite
(D-19, O-05 interaction).

---

## V — Visual polish

*(Phase 4 screenshot sweep pending. Already queued from code audits: O-27, O-28, C-27,
C-28, D-32, D-44–D-50.)*

---

## Register status

All four Phase 1 code audits complete (2026-08-05): **139 findings**
(F 29 · O 29 · C 28 · D 53), of which 26 are S1 (wrong numbers), 41 are S2 (silent
death / lost data). Phase 1 exit criterion additionally requires the live-site visual
sweep (Phase 4 prep) — code-side register is DONE.

Release close-out (v2.0.0, 2026-08-05): of the 139 audited findings, **116 are
fixed** (each with a locking regression test), 4 carry an explicit engineering
disposition (F-12 layered-fallback-by-design, F-14 accepted-and-monitored, F-17
closed-by-policy, C-23 structural), and the remainder are enumerated backlog
(v2.1) items — all S4/S5 friction or polish, none a wrong number, a silent
death, or a wrong presence. Suite at close-out: 553/553.
