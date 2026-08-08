# Prediction port — remediation report (2026-08-08)

Remediation of the findings in `f79aba6`, executed against
`docs/PREDICTION-PORT.md` Phase 4. Three commits:

| Commit | What |
|---|---|
| `69de0f8` | pt-recon learns a prediction shape; the half-mount it immediately caught |
| `8c68a62` | locks for the three untested adapters; every API host documented |
| (this file) | the report |

**Suites:** extension **1498/1498** (was 1460 — +38 tests), pt-recon **72/72**.
Both run in full, not filtered. The pre-existing failure in
`tools/recon/test/ws-live.integration.js` is a live-network file that fails
offline; confirmed pre-existing by stashing every change and re-running.

---

## 1. The checker no longer bends the product

`ff01d5d` had added a `currentSite()` shim and a `PaperTrenchSites` alias to
`predict-sites.js` so the token-shaped verifier would find something, and
`682d12c` repointed `adapter.file` at `predict-sites.js` — which silently
broke `check` for **every token site** (axiom, gmgn, dexscreener…). Both are
reverted.

pt-recon now speaks two shapes, **declared** per site in
`ptrecon.config.json` under `adapter.bySite`, never sniffed from the return
value. An unknown shape is a loud error, not a fallback to the wrong
contract. The prediction verifier checks the real contract — `{venue, one
market identifier, verified}` — and adds the failure modes the token shape
has no words for:

- `RETURNED_NO_ID` — an object with no market identifier, which every caller
  reads as "mounted on a market" and then has nothing to price
- `VENUE_MISMATCH` — the venue disagrees with the site's configured venue
- auth routes — sign-in screens tick live prices behind the form, so the
  live-price signal alone reads them as tradable

### What it found on the real corpora

| Site | Verdict |
|---|---|
| kalshi | AGREES — 2/2 market pages mount, 5/5 refuse-candidates refuse |
| polymarket | AGREES — 1/1, with 2 medium notes on category routes |
| limitless | AGREES — 1/1, 2/2 |
| hyperliquid-outcomes | **INCONCLUSIVE** — no live-ticking market page in the corpus, exactly as its §0 THIN dossier says |
| axiom (token shape) | works again — REVIEW, unchanged from before the regression |

**A real bug, caught by the new verifier on its first run:**
`detectHyperliquidOutcomes` returned `{venue, market: null}` on the
`/outcomes` **index** page — a mount with nothing behind it. It now refuses.
The existing test asserted that half-object: it encoded the bug, and now
asserts the refusal.

---

## 2. Hyperliquid host — decided by measurement

`predict-venues.js` fetched `api-ui.hyperliquid.xyz`, the venue's own
frontend host, undocumented and absent from `PERMISSIONS.md`. Both hosts were
probed live on 2026-08-08:

| Request | `api.hyperliquid.xyz` | `api-ui.hyperliquid.xyz` |
|---|---|---|
| `allMids` | 200, keys `#10330 #10331 #10340 #10341` | 200, identical |
| `l2Book BTC` | 200, `{coin,time,levels}` | 200, identical |
| `l2Book @1` | 200, `{coin,time,levels}` | 200, identical |

Identical, so the documented host wins — it is also the one the perps stack
already reads, leaving one Hyperliquid host to reason about instead of two.
`allMids` incidentally confirms hypothesis **H6** first-hand: outcome assets
really are keyed `#{outcome}{side}`.

`docs/PERMISSIONS.md` now tables all five prediction API hosts with what each
is used for.

---

## 3. Locks — and the two that were vacuous

38 new tests. Every one mutation-proved on its exact current line: break →
red, restore → green.

**Adapters** (`predict-venues.test.js`, 13 tests, strict fakes from live
payload shapes; the fake returns `{ok:false,status}` for failures because
`fetchJson` turns non-2xx into a throw — a rejecting fake would exercise a
path the venue never takes):

| Mutation | Result |
|---|---|
| Polymarket sort → `.reverse()` | 🔴 1 red |
| missing NO side substituted with an empty book | 🔴 1 red |
| Hyperliquid null-`l2Book` guard removed | 🔴 1 red |
| unlisted market given an invented coin id | 🔴 1 red |
| Limitless NO mirror uses `p` instead of `100−p` | 🔴 2 red |
| level sanity filter dropped (0¢/100¢ tradable) | 🔴 1 red |

**Gating** (`predict-sites.test.js`): a 24-row matrix of routes pt-recon
really captured, paired bounds locks, and a lock that only Kalshi is
`verified:true`.

| Mutation | Result |
|---|---|
| widen Polymarket slug gate (min 3 → min 1) | 🔴 1 red |
| narrow Polymarket slug gate (min 3 → min 10) | 🔴 2 red |
| widen Hyperliquid ticker gate (`{2,10}` → `{1,32}`) | 🔴 1 red |
| let the perps `/trade` route mount | 🔴 1 red |
| Kalshi `verified` flipped off | 🔴 4 red |
| Polymarket flipped to `verified:true` (the `d5f71af` move) | 🔴 3 red |

### Two locks that did not bite when first written

Reported because a lock that cannot fail is worse than no lock — it reads as
coverage.

1. **The auth-page lock was vacuous.** Its URL was `/sign-in` — a single
   segment — so the category-route rule already excluded it and the auth rule
   itself could be deleted with the test still green. Rewritten against a
   multi-segment auth route, and the duplicated market-page computation that
   let the two rules mask each other was removed.
2. **The perps-route lock was vacuous.** `/trade/BTC` refused only because
   the test passed no title. Perps and outcomes share
   `app.hyperliquid.xyz`, and the perps tab title has the same
   `"<price> | <market> | Hyperliquid"` shape the outcomes adapter reads — so
   on a live perps page the extractor succeeds and the **route gate is the
   only thing** between a binary-outcome ticket and a leveraged perp. The
   lock now passes a real perps title.

One mutation (`A2`, dropping Polymarket's `!noBook` refusal) produced `null`
by crashing rather than by refusing, so it passed. The sharper mutation —
substituting an empty book — turns it red. Recorded rather than dressed up.

**Also recorded:** a `git checkout --` during mutation work discarded
uncommitted edits in `predict-sites.js` and had to be rebuilt. Mutation
work after that used file backups. And one mutation was initially reported
as not-biting when the `sed` had simply failed to match — re-run with a
verified edit, it bites. A mutation that "did not bite" must be checked for
having been applied at all.

---

## 4. What is still NOT done

- **The three venues remain `verified:false` stubs.** Locks are in, but the
  gate is locks **plus** a green dossier **plus** a live pass. Hyperliquid's
  dossier is still 🔴 THIN (0 live-ticking market pages) and its capture
  cannot support a flip at all.
- **No live pass** has been run for Polymarket, Hyperliquid outcomes or
  Limitless. QA-MATRIX cells for them stay open.
- **Polymarket category routes** (`/new`, `/politics`) raise medium notes
  every run. They are category indexes; the note is a "confirm this", not a
  bug.
- **`limitlessFetchMarket` fetches the entire `/markets` list to resolve one
  slug** and takes the first match. Worth a look before that venue goes live:
  a paginated or truncated list would silently fail to find real markets.
- The headless capture rig uses a **stealth plugin**. Nothing captured
  through bot-evasion has been used as evidence for a `verified:true` flip
  here, and the doctrine's position — a page you had to sneak past is not the
  page users see — is unchanged.

## 5. To earn the flips

1. Headed pt-recon capture per venue (attach to a real logged-in Chrome),
   §0 coverage green, especially a Hyperliquid outcomes market with a
   ticking book.
2. `ptrecon check --site <id>` AGREES against the fresh corpus.
3. Live pass in a real browser: panel mounts on a market page, `SIMULATED`
   badge present, a quote walks a live book, portfolio/auth routes refuse.
4. Flip in one commit citing the dossier lines and lock tests that earn it —
   and update the `verified:true` lock in `predict-sites.test.js`, which is
   deliberately written to fail when a flag moves without that evidence.
