# Validation contract — RPC exit: server-backed quote witness (D-71)

## Why (field evidence, 64 debug reports 2026-08-27 → 2026-09-09)

Two failure classes dominate every report, both from the extension's direct
Solana RPC lane (publicnode/solana-labs/tatum):

1. `http 403/429 getMultipleAccounts` (2246× 403 on publicnode alone) — the
   free RPC pool is blocked/rate-limited; every RPC-backed feature degrades.
2. `host supply for <mint> lacks corroborating USD price and live market cap`
   and the fill refusal `Price sources disagree (0 vs recent 0, no second
   source)` — the fill witness (`R.onchainQuote` → `FEED.currentQuote`) and
   the host-supply corroboration both died with the pool.

Standing direction (Terp, 2026-09-10): the extension must not depend on
public RPC. Data already flows to the browser and to papertrench.com's
worker; reads come from there. TrenchBrain's `/clean/*` is gated in prod
(302 → /login), so the data plane is the papertrench worker, which already
holds the Indeix key (`env.INDEIX_API_KEY`, same provider TrenchBrain uses).

## Contract

### W1 — Worker route `GET /api/quote`

- `GET /api/quote?mints=<mint>[,<mint>...]` (1–16 base58 mints; 400 outside).
- Response 200: `{ "asOf": <ms epoch>, "quotes": { "<mint>": {
    "priceUsd": <USD per whole token>,
    "priceSol": <SOL per whole token | null>,
    "mcapUsd": <number | null>,
    "fdvUsd": <number | null>,
    "source": "indeix", "asOf": <ms> } } }`
- Upstream: `POST https://api.indeix.com/2/token/price` with
  `{"items":[{"chainId":"solana","address":<mint>}, ...]}` plus WSOL as the
  SOL/USD anchor; response `{payload:[...]}` positionally aligned; item fields
  `priceUSD`, `liquidityUSD`, `marketCapUSD`, `marketCapDilutedUSD`, per-item
  `error` possible. `priceSol = priceUsd / solUsd` (whole-token units —
  NO 10^decimals division; that is TrenchBrain's raw-unit fold, not ours).
- Honesty rules: an errored/zero item is OMITTED from `quotes` — never
  zero-filled, never invented. SOL anchor unavailable → `priceSol: null`,
  prices still served. Upstream dead → 503 `{error:"upstream"}`, no body of
  numbers. A per-request upstream budget bounds the spend (reuse the replay
  budget pattern).
- Caching: ~10s edge cache keyed on the normalized mint set (Cache API, same
  machinery as indeix.js helpers). GET stays origin-open like every other GET.

### E1 — Extension witness fallback (content.js `corroborateForFill`)

- Aggregator-sourced fill candidate: witness order becomes
  `R.onchainQuote(mint)` (chain, when alive) → `R.workerQuote(mint)`
  (Indeix via worker) — first positive witness wins. Non-aggregator branch
  unchanged (resolver refresh).
- `R.workerQuote` is a new background handler `pt_worker_quote`:
  `{mints:[...]}` → worker `/api/quote`, ~10s service-worker TTL cache,
  returns `{priceNative (SOL/whole token), priceUsd, mcapUsd, fdvUsd, at}`
  per mint or omits it. Network failure → null (never throws into the fill
  path). Witness agreement still judged by `Q.witnessAgrees` — this change
  only supplies a witness where the dead pool produced null.
- Independence doctrine preserved: Indeix is upstream-independent of
  Jupiter/Dexscreener/page feeds (the candidate sources) and of the chain
  lane. Regression pin: an aggregator candidate + dead RPC + live worker
  quote that agrees within FILL_WITNESS_AGREE_RATIO must PASS; one that
  disagrees must still REFUSE.

### E2 — Host-supply corroboration (content.js `handleHostFacts`)

- When `hostFactsDecision` returns `reason === 'no-united-price'` (host page
  gave supply but no usable priceUsd+mcap), fetch `R.workerQuote(mint)` once;
  if it carries `priceUsd > 0 && mcapUsd > 0`, re-run the decision with those
  united values merged into the facts and adopt `supplyUi` per existing
  rules (implied = mcap/priceUsd, 1% agreement). Cache per mint (do not
  re-fetch on every tick); failure keeps today's diagnostic-only behavior.

### Non-goals

- `rugScan`, `prewatch`, `identify`, and the WebSocket feed stay RPC-based;
  they already degrade to null/guard-aside (documented at the `pt_rug_check`
  handler) and are not the fill blocker. The uncommitted D-60/D-62/D-65
  resilience wave (refusal memory, per-account fallback, slow-pool notice)
  stays as-is.
- No TrenchBrain prod changes. No changes to the replay lanes
  (`/api/replay/*`, solana.js, candles.js).

## Acceptance (both lanes)

- New worker tests under `server/test/` (node --test, existing style):
  route shape, omitted-on-error honesty, SOL-anchor-missing → priceSol null,
  upstream-down → 503, budget bound. Negative control documented in the
  test file per repo doctrine (stashed fix → red, restored → green).
- New extension tests under `extension/test/`: witness fallback passes/
  refuses per E1 pins; host-supply corroboration per E2 pins; worker-fetch
  failure returns null and never blocks the fill path.
- Full preflight (`scripts/preflight.sh`) green — run ONCE by the integrator
  after both lanes land, not per lane.
