# External audit — prediction port (2026-08-08, ~05:00 UTC-4)

Auditor: Rosalie (Hermes Agent), at Terp's request. Read the last 12 commits,
the full uncommitted diff (5 files), the prediction modules end-to-end
(predict-venues/engine/score/sites/ticket/content, the PREDICT_QUOTE and
PREDICT_SUBMIT handlers in background.js, livepass.mjs), and **probed every
venue API live** to verify the new code's assumptions. Extension suite:
1501/1501 green.

This is written to be acted on. Every finding carries the evidence it was
derived from. Findings are ordered by severity, not by file.

---

## A. BLOCKERS — correctness bugs, evidence-verified

### A1. The Kalshi market picker sorts on a field that is always zero.

`kalshiResolveMarket` sorts event children by `liquidity_dollars` and claims
"most liquid first." Verified live 2026-08-08 against
`/events/KXGDP-26OCT30?with_nested_markets=true`: **all 9 children report
`liquidity_dollars: "0.0000"`** — while their orderbooks hold real depth
(T2.0 has ~1075 contracts of NO at 1c, etc.). The sort is a no-op; the pick
is whatever order the API returned. The comment describes an invariant the
code does not achieve.

**Fix:** the nested payload DOES carry usable signals — `yes_bid_size_fp` and
`yes_ask_size_fp` (top-of-book sizes, verified present), plus `last_price_dollars`.
Sort by `yes_bid_size_fp + yes_ask_size_fp`, or fetch books for candidates and
compare real depth. Add a lock test whose fake carries non-zero sizes and
asserts the biggest wins (mutation: reverse the sort → red).

### A2. The Kalshi path has no forecastable filter — it will open on near-certainties.

The Polymarket resolver filters markets priced outside (0.03, 0.97) before
picking, with an excellent comment about why ("the most liquid market in an
event is very often the one already priced at 1c or 99c… the panel opens on a
refusal"). **The Kalshi resolver does not apply the same filter.** The live
KXGDP-26OCT30 event's children are priced 0.96, 0.90, 0.90, 0.78, 0.60, 0.47,
0.35, 0.27, 0.22. Combined with A1's degenerate sort, the pick is the FIRST
child — the 96c one — and the panel opens straight into
`assertNotResolved`'s resolution lockout. Same failure mode, same venue
family, one path guarded and one not.

**Fix:** lift the forecastable filter into one helper used by both resolvers.

### A3. The Hyperliquid adapter is provably dead — it can only ever return null.

Three independent, live-verified failures:

1. **Coin lookup misses.** `hlOutcomesFetchCoin` searches `spotMeta.universe`
   for `name === market`. The site/title extractor yields `"BTC"`. Verified
   live: the 324-entry universe contains `PURR/USDC`, `@1`…`@19`, and outcome
   ids — **there is no `BTC`**. Lookup returns null → `fetchBook` returns null.
2. **Level parsing is wrong for the payload.** `hlL2Levels` reads `r[0]`/`r[1]`
   as array elements. Verified live: `l2Book` levels are `{px, sz, n}`
   OBJECTS. `r[0]` is `undefined` → NaN → every level filtered → empty book,
   even when a coin resolves.
3. **The outcome ids are not in spotMeta at all.** The remediation report's
   own hypothesis H6 is confirmed live: `allMids` carries exactly 16
   `#`-prefixed keys (`#10330`…`#10361`, 8 markets × 2 sides). But verified
   live: `spotMeta.universe` contains **zero** `#`-names — so even a correct
   lookup field cannot resolve an outcome market through that endpoint.

The adapter's data model does not match the venue. Every request path ends in
null, which surfaces as "No live book for this market right now" —
indistinguishable from a genuinely empty book, the exact ambiguity this codebase
elsewhere works hard to eliminate.

**Decide, don't defer:** either do the discovery work (find the endpoint that
maps a page/ticker to its `#` outcome ids, verify `l2Book` accepts a `#` coin,
rewrite the adapter, capture a live-ticking dossier) or delete the adapter and
its `verified:false` detect stub. A shipped adapter whose only possible output
is null is worse than an absent one: it mounts a badge and panel on
app.hyperliquid.xyz/outcomes that can never quote.

### A4. The safety boundary fabricates market state — the closed-market guard can never fire.

`background.js` PREDICT_QUOTE builds:

```js
const market = {
  status: 'open',                      // hardcoded
  close_time: book.closeTime || null,  // no adapter EVER sets closeTime
  min_order_size: book.minOrderSize || 1, // no adapter EVER sets minOrderSize
};
```

So `assertTradeable`'s closed-market branch is unreachable, and venue minimums
are ignored. The only live protection is the price-based near-certainty
lockout. A resolved-but-not-yet-settled market with residual depth gets quoted
as open. The data exists — Kalshi's event payload carries `close_time` per
market (verified: `2026-10-30T12:29:00Z` on every KXGDP child), PM carries
`closed`/`endDate` — it just never crosses the boundary.

**Fix:** adapters return `closeTime` (and `marketStatus` when the venue gives
it); background threads them instead of fabricating `status:'open'`. Add a lock:
a book whose market closed an hour ago refuses with `market_closed`,
mutation-proved.

### A5. `checkResolution` is dead code — four checkers, zero callers.

`kalshiCheckResolution`, `pmCheckResolution`, `hlOutcomesCheckResolution`,
`limitlessCheckResolution` are exported and tested, but nothing calls them
outside tests. Until the settlement ledger exists, at minimum wire a
resolution check into the quote path (cheap: it's one extra fetch, and the
Kalshi/PM resolve calls already hold most of the data). This is the other half
of A4: status guards the future, resolution guards the past.

### A6. The prediction overlay's master switch is wired to the wrong storage.

`predict-content.js` reads settings from `localStorage.getItem('pt_settings')`.
Content-script `localStorage` is THE VENUE PAGE's origin storage (kalshi.com's
localStorage), not the extension's. Every other consumer of `pt_settings`
(background.js, popup.js, overlay.js) uses `chrome.storage.local`. Result:
`overlayEnabled` is always true; the user's toggle cannot turn the prediction
panel off. (It also means a hostile venue page could set `pt_settings` in its
own localStorage and flip the flag — low stakes, but it's venue-writable
configuration.)

**Fix:** read via `chrome.storage.local` (async before mount, or a
GET_SETTINGS message), matching the rest of the codebase.

### A7. PREDICT_SUBMIT doesn't exist — the product loop is open.

Quoting is real; the loop it exists to serve — quote → paper fill → position
ledger → settlement → Brier scoring — is not: no `pt_pred_` store, no fills,
no latency replay, no position cap (`POSITION_LIMIT_FRACTION` is defined in
the engine and unreferenced by any writer), no settlement, and predict-score.js
has no input it can ever score. The honest refusal in PREDICT_SUBMIT is well
written; the point here is sequencing — see §D.

---

## B. Product/harness defects worth fixing while you're in there

### B1. `livepass.mjs` fallback markets are dead or time-bombed.

Polymarket `fallbackMarket: /event/kraken-ipo-in-2025` — verified live
2026-08-08: **all 4 markets `closed:true`**. With the new verdict logic, a
closed event produces the refusal "This market has closed," which the
`guarded` regex MATCHES — so a dead fallback scores
`PASS (engine guard fired — pipeline healthy)`. The harness can now pass on a
venue whose entire fallback corpus is resolved. Kalshi's fallback
(KXGDP-26OCT30) closes 2026-10-30 — same bomb, longer fuse.

**Fix:** verify fallback liveness from the API at run time (you already fetch
these hosts); a fallback that is itself closed/refused is BLOCKED, not PASS.
Or drop fallbacks entirely and require listing resolution.

### B2. Harness verdicts regex-match English prose; match codes instead.

The `guarded`/`brokenPipe` split is a regex over refusal MESSAGES. The engine
throws structured `{ code, message }` — the information you want already
exists, but the ticket publishes only `ptError` (the message) on its host
dataset. Publish the code too (`data-pt-error-code`) and let the harness
switch on `resolution_lockout | no_liquidity | market_closed | depth_cap`
(guards) vs `stale_book | unknown_venue` (pipeline). Prose is for users;
codes are for machines. As written, the next person who improves a refusal
sentence silently breaks the harness.

### B3. Product/harness gate mismatches — the harness can't see two product behaviors.

- `detectKalshi` accepts `/markets/` with **2+** segments and takes the last
  as the ticker. A series page (`/markets/kxgdp/us-gdp-growth`) therefore
  mounts badge + panel and can never quote (orderbook 404, event lookup 404,
  silent null). The harness `marketPattern` requires exactly **3** segments,
  so it never exercises the case the product accepts. Either tighten detect to
  the verified 3-segment market shape, or make the resolver handle series
  slugs — and make the harness pattern and the product regex the same animal.
- Hyperliquid: the harness plan expects `/outcomes/[A-Z0-9]+`, but
  `detectHyperliquidOutcomes`'s path fallback is `/outcomes/([A-Z]{2,10})` —
  letters only. An outcome id containing digits passes the harness and is
  refused by the product.

### B4. Quotes never expire on screen.

The response carries `quotedAt`, the engine enforces `MAX_BOOK_AGE_MS` — but
the ticket holds a quote indefinitely; a 5-minute-old price keeps rendering
with no staleness marker. When fills land (A7), recording a fill against a
stale quote is how calibration data gets poisoned. Expire the quote client-side
at MAX_BOOK_AGE_MS (grey it out / force re-quote), and put `quotedAt` in the
host dataset so the live pass can assert freshness too.

### B5. Every failure collapses to null → one user-facing sentence.

Rate limit (429), geo-block (403), shape change (500), dead market (404), and
genuinely-empty book all surface as "No live book for this market right now."
The codebase's own doctrine says a refusal should name its reason. Minimum:
`fetchJson` failures carry HTTP status into the adapter's refusal, so the
ticket (and the harness) can say "venue returned 429" instead of "no book."
This also protects the mutation work: right now a broken adapter and an empty
market are the same test outcome (null).

### B6. Small ones

- `pmFetchBook` builds `var market = { orderPriceMinTickSize: resolved.tickCents / 100 }`
  solely to read it back — dead circle; use `resolved.tickCents` directly.
- Kalshi `tickCents` is hardcoded 1. Nested event payloads don't carry
  `tick_size` (verified), but `/markets/<ticker>` does; sub-cent Kalshi markets
  exist. Thread it when available; 1c is a fallback, not a constant.
- PM's liquidity sort keys on `liquidityClob`, which is `None` on closed
  markets (verified) — harmless after the `!m.closed` filter, but `volumeClob`
  or `24hrVolume` would survive API field churn better.
- `predict-content.js` runs a subtree MutationObserver over `document.body` on
  high-churn SPAs, checking `location.href` per mutation. The check is cheap;
  the observer wakeups aren't. The token side has solved this before — reuse
  whatever it uses.
- The uncommitted diff adds `siblingCount`/`viaEvent` to the Kalshi and PM
  books and to the ticket's Market row — good. Limitless reuses `viaEvent` for
  `viaGroup`; consider naming it `viaGroup` at the source and mapping at the
  boundary, or a neutral `resolvedVia`. Three venues, one flag, two meanings
  is exactly the drift that produced the original `tokens` vs `clobTokenIds`
  class of bug.

---

## C. Test doctrine — one gap in the new diff

The remediation report's standard is the right one ("a lock that cannot fail
is worse than no lock"). Applying it to the UNCOMMITTED diff:

- **The Kalshi event path (`kalshiResolveMarket`) has no lock.** The diff adds
  PM and Limitless event/group tests, but `test/predict-venues.test.js` has no
  Kalshi event case (grep: the only "Kalshi" in that file is the header
  comment). It is the largest new logic block (~60 lines): case-sensitivity
  uppercase, empty-direct-book → event fallback, child selection, title
  threading. By the report's own mutation list it needs: sort reversed → red;
  uppercase removed → red; event fallback removed → red; marketTitle dropped
  → red.
- The PM event test asserts the liquidity pick with fakes carrying distinct
  `liquidityClob` — good — but see A1: the equivalent Kalshi assertion would
  currently PASS for the wrong reason (all-zero sizes), which is exactly the
  "vacuous lock" failure the report documents. Build the fake from the
  verified live shape (sizes in `yes_bid_size_fp`/`yes_ask_size_fp`,
  `liquidity_dollars: "0.0000"` present and useless) so the test encodes
  reality, not a hoped-for API.
- No test locks A4's fabrication: a fake book with a past `close_time`
  currently quotes fine. After the fix, it must refuse.
- No test locks A6: settings read from `chrome.storage.local` with the toggle
  off → no mount. (Content-script storage bugs are invisible to node tests;
  this one wants a livepass row or at minimum a code-review checklist item.)

---

## D. Sequencing advice — the one strategic point

The instinct driving the current session (resolve event→market correctly,
name the market in the UI, teach the harness guard-vs-defect) is the right
instinct and the fixes are high quality. But the feature's center of gravity
is not quoting: it's the **positions ledger**. Every module above the quote
exists and is tested; every module below it (fill, latency replay, position
cap, settlement, Brier input, dashboard surface) does not. Time spent making
quote display perfect is time the loop stays open, and the loop is what the
user is actually waiting on ("the goal of papertool was to make it so agents
can do all this for me").

Suggested order:

1. **A1+A2+A6** — small, self-contained, un-break the Kalshi pick and the
   settings switch (each with its lock).
2. **A4+A5** — real status/close_time/resolution across the boundary; the
   safety rules become live rules.
3. **A3** — decide Hyperliquid: rewrite against `#`-id discovery or delete.
   Don't leave a null-machine in the adapter table.
4. **The ledger.** `pt_pred_` namespace in chrome.storage.local, paper fill at
   quote+latency (the engine already has `priceMovedAgainstUser` and the
   realism modes), position cap wired to `POSITION_LIMIT_FRACTION`, settlement
   poller on the existing `checkResolution` adapters, predict-score fed real
   resolved positions. The perps stack (`pt_perps`, perps-reconcile.js) is the
   in-repo reference for exactly this shape — reconcile-on-wake, gap
   accounting, unverified-gap verdicts. Copy the doctrine, not the code.
5. **B1/B2** harness hardening once fills exist, so the live pass can assert
   the whole loop, not the panel.

---

## E. What's genuinely good — keep doing it

- The mount-discovery story (1498 tests green, panel never mounted, found by
  the harness not a human) is the best failure mode a test culture can have:
  the tool you built caught the thing the tests couldn't.
- The mirror-invariant check, the walk's `exhaustedBook` vs budget-left
  distinction, floor-never-round on qty, `shiftExponent` precision hygiene —
  the engine internals are built like someone has been burned before. Good.
- Naming the market in the UI when the URL named an event (`marketTitle`,
  `siblingCount`, "1 of N") is the right fix for wrong-number-on-screen.
- `escapeHtml` on venue-controlled strings before innerHTML: correct and
  commented.
- The refusal messages are written for users and passed through untouched.
- The report's habit of recording its own near-misses (the `git checkout --`
  data loss, the sed that didn't match, the vacuous locks) is worth more than
  the fixes themselves. Keep it.

— Rosalie
