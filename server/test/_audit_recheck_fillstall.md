Fill-stall UX disposition (2026-08-28): CLOSED — verified fixed by prior waves; no new defect.

Evidence trail:
1. pt_feedback/messages.json — ZERO new fill-stall complaints after 8/24.
   ark_trades13: "working fine now". The pre-8/24 complaint ("Says 'Fetching
   live price' 100% of the time" on fresh coins) was addressed by the
   D-38/D-59/D-60/D-60S waves.
2. Header-honesty hypothesis (this session's candidate bug) DISPROVEN on code
   read: during prewatch probe backoff (2s->30s) the 800ms detect loop and the
   250ms fast-retry KEEP resolving via aggregators (content.js detectLoop),
   so the header text "Fetching live price…" remains literally true. Fixing
   it would have been an invented fix for a nonexistent bug.
3. Slippage-threshold suspicion CLEARED with live math (slippage.js +
   engine.js buyPrice/sellPrice):
   - quoteBuy 0.5 SOL into 12 SOL / 206M token pool -> 4.1667% impact (exact
     V2 math), 6 SOL -> 50.0% impact. Curve REPLACES the flat slippageBps
     cushion when reserves are visible; flat setting remains the fallback for
     unseen pools (documented in engine.js).
   - Oversized trades are PRICED, never rejected (undrainable invariant).
   - Degenerate inputs return null, never a plausible number.
4. Every stall branch in the fill path is bounded and self-announcing:
   lastQuoteRefusal toasts (content.js:3220/3463), F-16 expiry toast,
   D-39 first-quote fill, F-52/F-57 provenance stamps; quote ages bounded by
   ACTION_QUOTE_MAX_AGE_MS=350 / PENDING_ACTION_MAX_AGE_MS=2000 /
   STALE_FILL_MAX_AGE_MS=3000.

Conclusion: no code change warranted. A3-1 (worker backlog drain) removes the
server-side stall analog; the client-side fill path was already honest.
