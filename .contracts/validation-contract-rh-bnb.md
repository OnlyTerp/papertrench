# Validation contract — Robinhood Chain + BNB paper trading (D-72)

## Why (field evidence)

v3.19 opened display+detect+USD pricing for Robinhood Chain and BNB
(validation-contract-multichain.md), but the fill pipeline is Solana-gated
end to end: the witness ladder's two sources (`R.onchainQuote` RPC feed,
`R.workerQuote` → `/api/quote` hardcoded `chainId:"solana"`) are both
Solana-only, so every RH/BNB fill refuses with "no second source". Users in
Discord (2026-09-09) were promised "Robinhood and BNB ... near future" and
are "patiently waiting". The server candle verifier also fails closed
(chain!=='solana' → 'no-data'), so foreign fills cannot be verified.

## Grounded facts (live-probed 2026-09-10, do not re-derive)

- Indeix `/1/blockchains` vocabulary (Bearer-gated; probed from prod with the
  TrenchBrain key): `solana`, `evm:1` (ethereum), `evm:56` (bsc),
  `evm:137` (polygon), `evm:2741` (abstract), `evm:4326` (megaeth),
  `evm:4663` (robinhood), `evm:8453` (base), `evm:1329` (sei).
- `/2/token/price` POST batch WORKS for `evm:4663` and `evm:56`: live
  Robinhood token 0x99A90B1218419c62A2Fa7E427284C6c7D058d47a returned
  priceUSD 0.0015251 (Dexscreener 0.001521, same minute); BNB token
  0xfe189e97832da1573e4e4ff034f4ffc3a15c7777 (MarsCoin) priced 0.1077.
- Response item shape is chain-uniform: priceUSD, liquidityUSD,
  marketCapUSD, marketCapDilutedUSD, per-item nulls/errors possible.
- Unit amendment (worker/extension code inspection, 2026-09-10): EVM quotes and
  token candles are USD per whole token, but the wallet still books in SOL.
  `quote.js` derives `priceNative = priceUsd / solUsdAtResolve`; `attest.js`
  commits/stores `priceNative` but neither `priceUsd` nor `solUsdAtResolve`.
  Therefore neither absent field can be used as verification evidence.
  The 10^decimals TrenchBrain raw-unit fold is NOT reused.

## Contract

### W2 — `/api/quote` becomes chain-aware

- `GET /api/quote?mints=...&chain=<solana|bnb|robinhood>` — chain optional,
  defaults `solana` (byte-compatible with D-71). ONE chain per request
  (mints are homogeneous — a token page lives on one chain).
- Slug → Indeix chainId map lives in ONE place in the worker (route or
  adapter): `solana→solana`, `bnb→evm:56`, `robinhood→evm:4663`. Unknown
  chain → 400.
- Address validation per chain: base58 (32-44) for solana; `0x`+40 hex
  (case-insensitive) for EVM chains. Violations → 400.
- EVM responses: `priceSol: null` ALWAYS (never derived — there is no SOL
  pair), `priceUsd` authoritative, mcapUsd/fdvUsd from
  marketCapUSD/marketCapDilutedUSD. WSOL anchor is requested ONLY for
  solana batches. Honesty rules of D-71 unchanged (omit, never zero-fill;
  503 {error:"upstream"} on dead upstream).
- Cache keys MUST include the chain (a BNB mint must never serve from a
  solana-keyed entry).

### W3 — server candle verification covers foreign chains

- `candles.js getCandles` gains chain support via Indeix
  `/2/token/ohlcv-history` with the same slug→chainId map (W2's single
  map — import, do not duplicate). EVM token candles remain USD per whole
  token: NO token SOL conversion and NO 10^decimals fold.
- W3 unit amendment, approved by the integrator after inspecting the actual
  attestation: leave `judgeFill` unchanged. Compare committed `priceNative`
  times the fill minute's independent historical SOL/USD range from the
  existing GT cache against the same minute's Indeix EVM token USD band.
  SOL is the wallet accounting unit here, not an invented EVM SOL market.
  This is the same cross-source comparison already used for Solana fills.
- Missing either historical leg gives `no-data`, never a pass; thrown source
  errors pause/resume rather than asserting data absence. A divergent EVM
  price yields `implausible`, rejecting the record exactly as for Solana.
  `no-data` counts as uncovered: insufficient coverage gives `partial`
  (profile-visible, unranked), not rejection or fabricated verification.
  Submission acceptance/pending semantics and Solana pricing are unchanged.
- Chain selection uses shared `chainOf`: v1 labels are unhashed and cannot
  redirect historical Solana fills into EVM candle verification.

### E3 — extension witness + worker quote are chain-aware

- `background pt_worker_quote`: message gains `chain` (default solana);
  EVM addresses accepted (0x40-hex) when chain is EVM; forwards
  `?chain=` to the worker. Response per mint: for EVM, `priceUsd` is the
  witness number; worker priceNative stays null (no native SOL quote on EVM).
- `content.js corroborateForFill` + E2 host-supply corroboration: pass
  `token.chain` through. Solana compares SOL `priceNative`; EVM aggregator
  witnesses compare candidate `chosen.priceUsd` with worker `priceUsd` through
  unchanged `Q.witnessAgrees`. Correction from live source: EVM panel amounts
  display in USD, but `quote.js normalizePair` derives `priceNative =
  priceUsd / solUsd`; `requestBuy` converts the dollar amount into SOL book
  units. The SOL book, evidence and refusal shape stay unchanged; only a
  dissenting USD witness is translated to the candidate's SOL rate for the
  existing refusal display. Both action-time quote selection and witness
  corroboration skip `R.onchainQuote` entirely on EVM.
- Rug guard / RPC feed remain Solana-only and stand aside on EVM
  (documented doctrine: never fake onchainLive for a foreign chain).

## Acceptance

- Worker tests: chain routing (slug map, unknown→400), EVM address
  validation, EVM response shape (priceSol null, no WSOL anchor in the
  batch), cache isolation across chains, solana byte-compat (default chain
  = D-71 behavior). Negative controls documented per repo doctrine.
- Server tests: EVM candle verify passes an honest committed SOL-book fill
  through the independent historical USD conversion and REFUSES a divergent
  one; either missing USD leg stays `no-data`; Solana regression stays green.
- Extension tests: RH/BNB fill with agreeing worker USD witness PASSES;
  disagreeing witness REFUSES with the existing message shape; EVM address
  through pt_worker_quote; solana witness path unchanged (regression).
- Full preflight green once, run by the integrator.

## Non-goals

- No new chains beyond robinhood+bnb in the extension surface (the worker
  map MAY cover the full probed vocabulary — routes are cheap — but sites
  gating stays as shipped).
- No EVM RPC pool, no per-chain native balances (out-of-scope per
  validation-contract-multichain.md design B).
- No TrenchBrain prod changes.
