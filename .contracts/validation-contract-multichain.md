# Multichain Gate Opening — Robinhood Chain + EVM on GMGN/Axiom/Padre/Lute

## VERDICT: DONE (2026-09-04)
- VAL-1 venue support: PASS (live research: GMGN robinhood slug live-verified
  via indexed token page + gmgn-skills chain table; Axiom robinhood shipped
  7/11 (chain selector SOL/HOOD/BNB/ETH, captured URL params); Lute supports
  RH as a VENUE but its foreign URL shape is unverifiable anonymously (307
  /login on both address families) — stays Solana-only, no guessing; Padre
  has NO robinhood (its own copy: SOL/ETH/Base/BNB) — wired eth/base/bnb).
- VAL-2 detection: PASS (13/13 corpus smoke; O-11 shape-strictness intact).
- VAL-3 gate: PASS (MULTICHAIN_ENABLED = true; negative control: flipping
  back to false refuses RH+ETH and leaves Solana untouched — MULTI-2).
- VAL-4 pricing/wallet: PASS (LIVE: HOOD on robinhood resolved through the
  real resolver — priceNative 6.63e-7 SOL = priceUsd 0.0000685 / rate
  103.37, recorded; engine equity identity holds with a foreign position;
  chips return to gmgn/robinhood, axiom ?chain=robinhood, padre /trade/eth).
- VAL-5 SOL/USD fallback: PASS (LIVE: dexscreener deepest USDC/USDT SOL pool
  as the fallback when Jupiter is down; jup+dx agree <0.01%; single-flight
  guard added). Warm foreign resolve proven 103.5281 from the fallback path.
- VAL-6 RPC pool: PASS (re-verified all 3 endpoints live: gMA-VALID + WS for
  publicnode/solana-labs, gMA-VALID tatum; 12 additional public endpoints
  probed and honestly REFUSED — none added; evidence in session log).
- VAL-7 tests: PASS (2423/2423 ext incl. 7 new MULTI- tests + inverted gate
  matrices; 314/314 server; 20/20 bot; negative control in MULTI-2).
- PERF: P1 venue-fallback parallelization — cold-miss 1867ms → 389ms (4.8x,
  live measured, stash-revert negative control); P2 batchPrices rate-fetch
  parallelized with the chunks (tail-case win under Jupiter outages).

## Order
Terp, 2026-09-04: "gmgn, axiom, padre, and lute have a button that switches it
from sol to robinhood eth coins, can u add the functionality for those to work
also in papertrench... requested alot lately since robinhood is popping off."

This supersedes the sites.js gate comment (8/6: "land per-chain native
balances first"). The implemented book model is design A (SOL-denominated,
foreign fills derived priceUsd/solUsd with the rate RECORDED — never guessed).
Design B remains a future migration; the comment is updated to record the
supersession, not deleted.

## Live-verified research (2026-09-04)
- GMGN: full Robinhood Chain support (gmgn.ai blog + indexed token page
  gmgn.ai/robinhood/token/0xcd1c...). Slugs: sol/eth/bsc/base/robinhood.
- Axiom: RH support 7/11/2026; chain selector SOL/HOOD/BNB/ETH. URL vocab from
  our own logged-in capture (docs, 8/7): ?chain=sol & pulseChains/trackerChains
  list robinhood — the slug IS 'robinhood'.
- Padre: NO Robinhood Chain (padre.gg + docs: Solana, Ethereum, Base, BNB).
  Padre scope = EVM (eth/base/bnb), NOT robinhood.
- Lute: RH + ETH live (official X). Token page /trade/<addr> 307s to /login
  for anonymous probes — URL shape for EVM tokens NOT yet live-verified.

## VAL- contract
- VAL-1 GATE OPEN: flipping MULTICHAIN_ENABLED makes every corpus foreign URL
  detect with its true chain (fomo robinhood/bnb/ethereum, gmgn eth, axiom
  ?chain=eth, dexscreener ethereum) — the existing chainrouting
  "flip restores routing" test must pass unmodified in that direction.
- VAL-2 SHAPE STRICTNESS SURVIVES: base58 under an EVM slug refused; hex under
  solana slug refused; unknown slug refused; short/non-hex refused (O-11).
- VAL-3 VENUE COVERAGE:
  - gmgn: /robinhood/token/<0x> detects chain robinhood; tokenUrl builds
    gmgn.ai/robinhood/token/<0x> for a robinhood position.
  - axiom: tokenUrl carries ?chain=<axiomSlug> (sol/eth/bnb/robinhood);
    /meme/ and /t/ with ?chain=robinhood detect chain robinhood.
  - padre: /trade/<chain>/<0x> for ethereum/base/bnb detects; tokenUrl builds
    trade.padre.gg/trade/<slug>/<addr>; Solana routes unchanged.
  - lute: EVM detection ONLY if the URL shape is live-verified this session
    (docs or indexed URL). Otherwise lute stays Solana-only and the blocker is
    recorded — a guessed chain is the O-11 failure class.
- VAL-4 PRICING HONESTY (existing multichain.test.js must stay green
  unmodified): foreign priceNative = priceUsd/solUsd, rate recorded, no rate →
  no record.
- VAL-5 SOL/USD RESILIENCE: the foreign lane gates on one source (Jupiter).
  Add a verified fallback source (live-probed this session) so a Jupiter
  outage degrades to slower pricing, never to none. Unit test with scripted
  fetch + negative control (fallback off → resolve fails).
- VAL-6 RPC POOL RESILIENCE: probe 3-4 candidate keyless Solana endpoints
  live with a real getMultipleAccounts; add only ones answering 200 + valid
  JSON. Each addition named with its probe evidence.
- VAL-7 SUITE: full extension suite green; sitegating MATRIX refusal rows
  inverted to opened behavior (never deleted); perfpass pins intact.
- VAL-8 SHIP: preflight, release v3.19.0, tag, verify zip hash + the shipped
  gate value inside the artifact.

## Explicitly out of scope (recorded, not silently dropped)
- Design B per-chain native balances (future migration).
- Lute EVM if unverified (BLOCKED lane — one honest attempt made, per law).
- Robinhood Chain RPC pool watching (foreign pricing rides dexscreener; no
  RH-chain RPC in the pool — never fake onchainLive for a foreign chain).
