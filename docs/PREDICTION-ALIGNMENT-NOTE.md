# Prediction Port — Phase 0 Alignment Note

> **Status:** Ready for execution. No deviations from PREDICTION-PORT.md.

## Read order completed

1. `docs/ADDING-A-SITE.md` — recon-first doctrine, touch list, lock discipline
2. `docs/RECON.md` — pt-recon pipeline, dossier contract, trust boundary
3. `docs/ARCHITECTURE.md` — module table, pure/I/O boundary, storage keys
4. `docs/PERPS-TA-SPEC.md` — the instrument-family precedent this port mirrors
5. `extension/perps-sites.js` — house adapter style (pure functions, evidence tags, `verified:false` stubs)
6. Reference repo: `README.md`, `packages/core/src/book.ts`, `packages/core/src/scoring.ts`, `packages/venues/src/kalshi.ts`

## Module list

| Module | Contents |
|---|---|
| `extension/predict-sites.js` | URL→market-identity per venue: `detect(host, pathname, title)` → `{venue, marketId, ...}` or `null`. Pure functions, dated evidence tags, `verified:false` stubs for unprobed routes. Perps-sites style. |
| `extension/predict-venues.js` | Background-side venue API clients: book fetch (batched, in-flight-coalesced), market meta, resolution checks. Every route cites its dossier line. Failures surface as named refusals, never stale numbers. |
| `extension/predict-engine.js` | Fill engine + book math. Ported from reference `packages/core/src/book.ts` + `supabase/functions/_shared/fill.ts` (attributed `e03f715`). `walkBook`, `depthNotional`, `checkBookInvariants`, `priceMovedAgainstUser`, `assertNotResolved`, `applyAdverseTicks`. Same `walkBook` as reference — no second implementation. |
| `extension/predict-score.js` | Brier calibration + Murphy decomposition + gates. Ported from reference `packages/core/src/scoring.ts` (attributed). `brier`, `brierSkillScore`, `murphyDecomposition`, `calibrationBins`, `summarizeCalibration`, gating constants (`MIN_N_FOR_BSS = 30`, `MIN_N_FOR_CATEGORY = 20`). |
| `extension/predict-ticket.js` | On-page trade ticket. Shadow root, `SIMULATED · NO REAL MONEY` badge on every price surface, draggable, master-switch aware. House overlay conventions. |
| `extension/predict-content.js` | Mount/refuse gating + content script entry. Routes match via `predict-sites.js` `detect()`. |
| Dashboard view | Prediction positions, resolutions, calibration panel in `dashboard.js`, following perps-view precedent. |

## Seams touched

| Where | What |
|---|---|
| `extension/manifest.json` | ONE new ISOLATED content-script entry for the four prediction origins. No MAIN-world entry unless a dossier proves need. No new permissions. |
| `extension/background.js` | Routing for predict fetches (book/meta/resolution). Settlement sweep on existing alarm cadence: only held markets, only past `closeTime`, per-market failures swallowed. `WARM_PLATFORM_URLS`/`WARM_DEST_FAMILIES` entries only if warm-open extended to these sites. |
| `extension/warmdest.js` | Host RegExp + `classify()` + `familyOfHost()` for the four origins IF they join warm-dest. Otherwise N/A (state in report). |
| `docs/PERMISSIONS.md` | Four origins with justification. |
| `README.md`, `site/index.html` | Supported-sites prose. Counter updates via preflight only. |
| `docs/QA-MATRIX.md` | Four new columns, empty until live pass. |
| `CHANGELOG.md` | Feature entry + attribution. |

## Bankroll decision

**Separate book.** Perps uses its own `pt_state.perps` state slice with its own starting balance (PERPS-TA-SPEC.md §3: "Perps get their own state slice, own starting balance, own rounds, own attestation chain segment, own rank track"). Prediction follows the same pattern: `pt_pred_`-prefixed storage namespace, own starting balance, own positions, own calibration corpus. Prediction results never touch token stats (winrate, mastery, gamify streaks) or perps stats, and vice versa. Journal entries carry an `instrument: 'prediction'` tag; every aggregate filters on it.

## Engine contract (traceable to PREDICTION-PORT.md §Phase 2)

| # | Rule | Reference source |
|---|---|---|
| 1 | Never fill beyond visible depth; partial fills only | `book.ts:1-13` (walkBook — the four rules) |
| 2 | Depth cap: 5% of visible ladder value | `fill.ts:54` (`MAX_DEPTH_FRACTION = 0.05`) |
| 3 | Latency replay: 250ms realistic / 750ms brutal, fresh cache-bypassing book, reject if >2% adverse | `fill.ts:56` (`PRICE_MOVE_TOLERANCE = 0.02`), engine.ts latency logic |
| 4 | Resolution lockout: ≥97¢/≤3¢ with spread <2¢ | `fill.ts:98-110` (assertNotResolved) |
| 5 | Mirror invariant checked on every snapshot | `book.ts:202-232` (checkBookInvariants) |
| 6 | Position cap 20% of bankroll; instant mode never scores | `0007_order_engine.sql:108-122`, `fill.ts:169-178` |
| 7 | Scoring gates: no BSS below n=30; categories n<20 greyed; voids/instant excluded | `scoring.ts:16-18` (MIN_N_FOR_BSS, MIN_N_FOR_CATEGORY) |

## Deviations from PREDICTION-PORT.md

**None.** The plan reads cleanly against the codebase. One observation:

- The reference repo's `perps-sites.js` precedent uses `verified:false` stubs for unprobed routes (Axiom perps returns `null` until logged-in recon). The prediction port will do the same for any venue where the dossier is THIN — the plan already accounts for this.

## Risks identified during read

1. **Kalshi bid-ladders-only trap** — the most dangerous normalization in the codebase. The ported `predict-venues.js` Kalshi adapter must synthesize ask ladders by mirroring bids. The reference `kalshi.ts:262-298` is the exact code; the lock must prove the mirror holds AND that element 1 is never read as a price.

2. **Polymarket book sort order** — the reference says bids ASCEND to best-at-END, asks DESCEND to best-at-END. Adapters must sort explicitly. The `walkBook` contract says levels must be sorted BEST FIRST. The Polymarket adapter must reverse/sort before passing to the engine.

3. **Storage isolation** — a prediction trade must never mutate `pt_state` (token state) or `pt_state.perps`. The isolation locks in Phase 4 must prove this in both directions.

## Ready to proceed

Phase 0 gate met. No deviations requiring Terp's explicit OK. Ready for Phase 1 recon captures.
