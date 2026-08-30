# D-65 Validation Contract — RPC refusal-memory fast-path (skip refused gMA batches)

Defect: ark_trades13 (v3.18.0) hard-blocked on getMultipleAccounts at publicnode —
2026-08-30T12:39 export: 294x "http 403 getMultipleAccounts @ publicnode" + 27x 429
publicnode + 14x 429 tatum; 2026-08-30T19:06 export: 1801x 403 gMA @ publicnode +
272x "rpc pool cooling down" + 64x 429 tatum; fn breakdown getAccounts-fallback 1858,
prewatch 339, watch 45. D-62 fallback works, but every batch read pays a fail-then-
fallback toll against a persistently policy-refused endpoint, and the error-log storm
(2,242 events/session) is itself part of the defect.

Fix shape: (endpoint, method) refusal-memory in the pool — FIRST 403 (kind 'method')
records a sliding 10-minute refusal-memory entry (any later 403 refreshes it), which
ranks that endpoint last for that method WITHOUT the two-strike evidence law (this is
NOT methodBlockedEverywhere; the hedge across the other endpoints stays). When every
pool endpoint carries live refusal-memory for getMultipleAccounts, getAccountsResilient
skips the batch attempt entirely and goes straight to getAccountsIndividually. A 200
clears the endpoint's refusal-memory instantly (batch lane restored after decay).
noteFeedError for fallback transitions is throttled to once per (fn, minute).

## Acceptance

- VAL-1: extension/test/d65_refusal_memory.test.js — pool with scripted endpoints:
  first gMA 403 on publicnode → the next ranked('getMultipleAccounts') call
  deprioritizes/skips publicnode; after the decay window it is eligible again; a 200
  clears memory immediately. Must FAIL on stashed fix (negative control, recorded).
- VAL-2: getAccountsResilient test — when every endpoint has live refusal-memory for
  gMA, ZERO getMultipleAccounts calls fire and per-account getAccountInfo reads still
  return the accounts (freshFeed/self-injection pattern as test/d62_gma_fallback.test.js).
- VAL-3: error-log throttle — 10 simulated consecutive fallback transitions produce
  <=2 noteFeedError (PTErrors.record) calls per (fn, minute).
- VAL-4: full extension suite green (record count; no new fails vs 2148 baseline +
  new tests).
- VAL-5: negative control recorded below: git stash push -- extension/rpc-pool.js
  extension/onchain-feed.js → new tests red → stash pop → green.

## Negative control record

Command: `git stash push -- extension/rpc-pool.js extension/onchain-feed.js`
→ `node --test test/d65_refusal_memory.test.js` → pass 3 / **fail 5**
(D-65/1..4, D-65/6 — the memory, decay, clear-on-200, sliding and non-universal
guards all correctly red on pre-fix code) → `git stash pop` → pass 8 / fail 0.

## Results

- VAL-1: PASS (D-65/1..4) — first 403 demotes for gMA, per-method entries, decay
  after 10 min (refusalMemoryLive flips false), 200 clears instantly, later 403
  refreshes the sliding window.
- VAL-2: PASS (D-65/5) — all endpoints refused → 0 getMultipleAccounts calls,
  per-account lane returns real account data.
- VAL-3: PASS (D-65/7) — 10 consecutive fallback transitions → 1 noteFeedError
  per (fn, minute) window (limit <=2).
- VAL-4: PASS — full extension suite `node --test`: **2156 tests, 2156 pass,
  0 fail** (2148 baseline + 8 new), ~6.4s.
- VAL-5: recorded above (red 5 on stash, green 8 on pop).

