# Design — price fresh pairs from the host page's own payloads

Status: proposal. Target: kill the "Fetching live price" class of complaint at the root
rather than making the RPC pool more resilient one fault at a time.

## Why the extension re-fetches today

The panel is not scraping-blind — the page's own frames are already the primary live price
path (`price-bridge.js` hooks `fetch`/`XHR`/`WebSocket` in the MAIN world and forwards every
JSON frame to `collect()`). On an established coin the panel prices with zero RPC.

RPC is only load-bearing for the facts a chart tick cannot carry:

| Fact | Where it comes from now | Needed for |
| --- | --- | --- |
| What the on-screen number *is* (USD price / SOL price / market cap) | threshold heuristics in `quote.js` (`BOOTSTRAP_*`), else refuse | any fill on an unindexed coin |
| Token supply (turns an mcap reading into a price) | `getMultipleAccounts`/`getAccountInfo` on the mint (`onchainPrewatch`) or the pump.fun 1e9 constant | mcap-mode charts (Axiom, Padre, GMGN) |
| Which mint a **pair-address** page is showing | same RPC probe, or an aggregator | Axiom `/meme/<pair>`, BullX `terminal?address=<pair>` |
| Pool reserves | RPC | slippage / fill price |

So the starvation report is precisely: *pair page + unindexed coin + throttled RPC = no
identity, no supply, no fill*. Aggregators need 20–30 s; the terminal already knew all of it
at page load.

## The gap

`collect()` extracts prices, market caps, mints, symbols and names from host frames. It does
**not** extract `supply` / `decimals` / the pool↔mint association — the three facts that would
make the page self-sufficient. Padre and GMGN get named fast paths
(`padre-chart-bar`, `gmgn-ws-trade`, `gmgn-mcap-candle`); Axiom and BullX only get the generic
walk, whose ticks are `untrusted-source` for `bootstrapTick` on a pair page because the mint is
unknown.

## Proposal — a "host facts" layer under the tick layer

### 1. Extraction (`price-bridge.js`)

Extend the per-record walk with `SUPPLY_KEY` (`supply|totalSupply|circulatingSupply|tokenSupply`),
`DECIMALS_KEY`, and pool-ish address keys (`pairAddress|poolAddress|lpAddress|pool|pairId`).
Emit a **new** message type `facts` — never a `tick` — when a record ties the page's own
`srcAddress` to any of: a different mint, a supply, decimals, a pool address.

`facts` is identity/metadata only. It can never move a price by itself.

### 2. Adoption rules (`content.js`, pending token only)

These are the correctness core. Host payloads are untrusted input; each rule makes a fact
*self-checking* rather than believed.

- **R1 identity.** Adopt a mint from a `facts` message only when the same record also carries
  the page's own `srcAddress` (the pair address from the URL), the mint is base58 32–44 and is
  not the `srcAddress` itself. Reuse the existing `rekeyLiveState` path so an armed buy and any
  fill survive the rename, exactly as the RPC prewatch does today.
- **R2 supply.** Accept a supply only when the payload corroborates it *arithmetically*:
  the same record carries an unambiguously-united price (`priceUsd`-family key) **and** a
  market cap, and `|mcap / priceUsd − declaredSupply| / declaredSupply <= 1%`.
  - No declared supply field: the implied `mcap / priceUsd` may be used, but only when both
    keys are explicitly united (never an `unknown`-unit chart close).
  - Anything else: refuse. No new thresholds, no unit guessing — a refusal costs seconds,
    a wrong supply costs a 200x-wrong fill.
- **R3 provenance + reconciliation.** A fill priced through host facts records
  `priceSource: 'site-facts'` and a witness holding the frame URL, the keys read and their
  values. When the on-chain probe later returns a measured supply, reconcile: agreement within
  2% upgrades the provenance to `onchain`; disagreement stops all host-supply use for that
  token and flags the position, rather than silently re-pricing it.
- **R4 precedence.** Host facts never override a trusted anchor. Once the resolver or the
  chain probe has answered, `validateTick`'s band stays in charge and facts only fill gaps.

### 3. Quote layer (`quote.js`)

`bootstrapSupply` gains a third source, `t.hostSupplyUi`, ranked below the pump.fun protocol
constant and below `t.supplyUi` (measured on-chain), and subject to the same
`mcapUnitBand` sanity band. `bootstrapTick` needs no new trusted source: R1 makes
`tick.mint === pendingToken.mint` true on pair pages, which is already the trusted case.

### 4. Result

Four independent paths to a fillable price, none able to block the others:

```
host payload facts  (0 ms, needs the site's frame)
page chart tick     (validated against an anchor)
aggregator anchor   (Dexscreener / Jupiter / venue APIs, 20-30 s on a fresh coin)
on-chain read       (RPC pool, now throttle-tolerant)
```

"Fetching live price" then means *every* source is silent, which is an honest state rather
than a single throttled endpoint.

## What this does not do

- It does not trust a number because the site printed it. Every host fact is either tied to the
  page's own address (identity) or checked against a second number in the same payload (supply).
- It does not remove the RPC pool. Reserves, rug checks and reconciliation still need it.
- It does not change fill maths or the fee model.

## Work needed

1. Capture real logged-in frames from Axiom `/meme/<pair>` and BullX `terminal?address=<pair>`
   (which keys actually carry mint/supply/pool) — blocked on credentials.
2. Implement extraction + rules + tests using those captures as fixtures.
3. Reconciliation and provenance plumbing.
