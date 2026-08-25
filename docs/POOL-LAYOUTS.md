# Verified on-chain pool layouts

Every offset in `onchain.js` is verified against **live mainnet accounts**,
not against a published spec or an IDL we downloaded. A spec can be stale, a
field can be reordered by an upgrade, and a decoder that is subtly wrong does
not throw — it produces a plausible price. That is the one failure mode this
product must never have, so the rule is: read a real account, prove the fields
land where we claim, and record the transcript here.

If you add a pool kind, add its transcript here in the same shape.

---

## PumpSwap AMM (`pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`)

Where a pump.fun coin lives **after** it graduates. Classified `cp-vaults`
(constant product, priced from the two vault balances).

| Field | Offset | Type |
|---|---|---|
| base mint | 43 | pubkey (32) |
| quote mint | 75 | pubkey (32) |
| base vault | 139 | pubkey (32) |
| quote vault | 171 | pubkey (32) |

Account size: **301 bytes**.

### Transcript — 2026-08-25

Coin `vH6HyoNGaWvKHsK1ENNCqFuZhLfR1cpw46TFeGVpump` ("中国石化"), which
pump.fun's own API reports as `pump_swap_pool: 7vEpDRUy5PSiBJNdBiiuMxN7KbM7HA3fxhFvgrjRrEnV`.

Scanning the pool account for known pubkeys:

```
owner  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA   kind cp-vaults   len 301
  base mint @ 43
  WSOL mint @ 75
  VAULT     @ 171   C991coUv   mint=So111111   amt=304518464111
```

Reading both vault accounts directly:

```
@139  owner TokenzQdBNbL  len 170  mint vH6HyoNGaW  amt 54631512811375
@171  owner TokenkegQfeZ  len 165  mint So11111111  amt 304836266120
```

**Note the vault programs differ.** The base vault is Token-2022
(`TokenzQdBNbL…`, 170 bytes); the quote vault is classic SPL
(`TokenkegQfeZ…`, 165 bytes). Both share the prefix `decodeTokenAccount`
reads (mint @0, amount @64), which is why one decoder serves both. Code that
assumed a 165-byte account would drop the base leg — and with it the price.

### Discovery

The pool address is **not** derived. Its PDA seeds include the creator and a
pool index we do not know, so the lookup asks the chain instead:

```js
getProgramAccounts(PUMP_AMM_PROGRAM, {
  filters: [{ memcmp: { offset: 43, bytes: mint } }],
})
```

An indexed memcmp on a single program — cheap enough to run on a click.

Validated across live migrated coins (2026-08-25): **9/9 discovered pools
matched pump.fun's reported `pump_swap_pool` exactly** before the public RPC
throttled the run, and driving the real `FEED.prewatch()` priced **4/4**
freshly migrated coins in ~2s each. See DEFECTS.md D-59.

Some RPC providers answer `getProgramAccounts` with the payload stripped
(`data: null`), so the discovered addresses are always re-read with
`getMultipleAccounts` rather than trusting the gPA response shape.

---

## Others

`whirlpool` (Orca), `clmm` (Raydium CLMM), `cp-vaults` (Raydium CP / CPMM)
and `pump-curve` (pump.fun bonding curve) offsets live in `onchain.js` with
their own inline notes. The bonding curve prices on **virtual** reserves —
never treat a curve's vault balances as a constant-product pool.
