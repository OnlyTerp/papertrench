# Wiring price impact to live reserves

**Status:** not done. `slippage.js` is implemented and unit-tested, and
`engine.buyPrice`/`sellPrice` will walk the constant-product curve **when given
reserves** — but nothing supplies them yet, so every live fill still uses the
flat `settings.slippageBps`.

This is the same dead-code shape the fee wiring just fixed (commit `92f9d5e`),
found by the same check: grep for a caller outside `test/`.

```
$ grep -n "baseReserve\|reserves" extension/content.js
(no output)
```

The difference is that fees needed **no new plumbing** — `token.pumpCurve`,
`token.mcap` and `token.solUsdAtResolve` were already in content.js. Reserves
are **not**. They exist, but on the other side of the service-worker boundary.

---

## Where the reserves already are

`onchain-feed.js` decodes them for every watched pool and then throws them away
at emit time.

| Pool kind | Reserve source | Where |
|---|---|---|
| `pump-curve` | `curve.virtualSol`, `curve.virtualToken` | `O.decodePumpCurve(entry.raw)` in `priceFromEntry` (~line 265) |
| vault pairs (PumpSwap AMM) | `entry.baseAmount`, `entry.quoteAmount` | `priceFromEntry` (~line 271), fed by `getAccounts` on `baseVault`/`quoteVault` |
| `whirlpool` / `clmm` | sqrt-price, **not** x*y=k | not applicable — see below |

The emitted quote carries only:

```js
{ mint, priceNative, slot, source: 'onchain', poolKind, observedAt }
```

Four emit sites build that object (~410, ~509, ~676 and one more in
`onchain-feed.js` — grep `source: 'onchain'`). None of them include reserves.

---

## The work

1. **Emit reserves alongside the price.** Add `baseReserve`/`quoteReserve` to
   the quote object at all four emit sites, populated from the same decode
   `priceFromEntry` already performs. Do not re-read accounts for this — the
   bytes are in hand, and a second read would double the RPC cost of every tick.

2. **Carry them through the message boundary.** The quote crosses from the
   service worker to `content.js` via `sendMessage`. Confirm the receiving path
   preserves unknown fields rather than reconstructing a fixed shape.

3. **Thread them onto the order.** At the five `E.buy(` / `E.sell(` call sites,
   alongside the existing `...(feeContextForOrder() || {})`, supply
   `baseReserve`, `quoteReserve`, and `solIn`.

4. **`solIn` must be NET OF FEES.** `engine.buyPrice` documents this explicitly:
   fees are `fees.js`'s concern, and folding them in here double-charges. The
   fee is already resolved before the curve is walked (`engine.js` ~547: "Fee
   FIRST, price second").

---

## What must NOT happen

- **Never synthesize reserves from price.** `reserves = f(price)` is circular:
  it would produce an impact number that is a function of the price it claims to
  be adjusting. If a pool's reserves are unknown, the flat fallback is the
  honest answer — that fallback is why `settings.slippageBps` stays.

- **Whirlpool/CLMM are not constant-product.** They price from a sqrt-price and
  concentrated liquidity ranges. Feeding their notional reserves into an x*y=k
  quote yields a confidently wrong impact. Supply reserves for `pump-curve` and
  vault pairs only; leave everything else on the flat path.

- **A stale reserve is worse than none.** Reserves must come from the same slot
  as the price they accompany. `isNewerObservation` already guards the price
  path; the reserves must ride the same guard, not a later read.

---

## Proving it (the part that actually matters)

The fee wiring shipped with `test/feewiring.test.js`, which drives the **call
sites** rather than the module. Do the same here:

1. Assert the emit sites include reserve fields.
2. Assert the order call sites forward them.
3. Drive `engine.buyPrice` with a known pool and assert a hand-computed average
   price — not one the test recomputes with the same formula.
4. **Negative control:** remove the reserve fields from one emit site and
   confirm the test goes red. Restore and confirm green.

A test that passes both with and without the wiring is the exact failure this
document exists to prevent.

Hand-computable fixture (already used in `slippage.test.js`):

```
base = 1000, quote = 100, k = 100000
buy 10 SOL -> tokensOut = 1000 - 100000/110 = 90.909091
              avgPrice  = 10/90.909091      = 0.11
              impact                         = 10.00%
```

---

## Honest scope

Steps 1–3 are perhaps 40 lines of production code. The care is entirely in
*which* pools may supply reserves and in the slot discipline — get those wrong
and the model produces confident, precise, wrong numbers, which is strictly
worse than the flat fallback it replaces.
