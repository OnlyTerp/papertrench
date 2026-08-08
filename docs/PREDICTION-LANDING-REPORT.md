# Prediction Port — Landing Report

> **Requested commit tag:** pending (Phase 6 / Terp decision)
> **Date:** 2026-08-07
> **Reference:** amogus0471/Paper-Prediction @ e03f715 (MIT)

---

## P0 Alignment note

Written: `docs/PREDICTION-ALIGNMENT-NOTE.md`. No deviations from `PREDICTION-PORT.md`. Separate bankroll (mirrors perps precedent per PERPS-TA-SPEC.md §3).

---

## Phase 1 — Recon dossiers

| Venue | Capture ID | Pages | Endpoints | WS frames | Coverage | Verdict |
|---|---|---|---|---|---|---|
| Kalshi | `2026-08-07T23:56:49` | 19 | 128 | 8 | 7 token, 2 live | 🟡 PARTIAL — ships verified |
| Polymarket | `2026-08-07T23:58:29` | 6 | 94 | 6,724 | 1 token, 0 live | 🔴 THIN — `verified:false` stub |
| Hyperliquid | `2026-08-08T00:00:17` | 5 | 20 | 423 | 1 token, 0 live | 🔴 THIN — `verified:false` stub |
| Limitless | `2026-08-08T00:01:25` | 8 | 63 | 2,280 | 4 token, 0 live | 🔴 THIN — `verified:false` stub |

Dossiers: `recon-data/sites/<venue>/dossier/DOSSIER.md`
No CAPTURE VOID on any venue. Three venues need headed captures for live-ticking coverage.

---

## Phase 2 — Modules created

| File | Lines | node --check | Purpose |
|---|---|---|---|
| `extension/predict-engine.js` | 569 | ✅ | Fill engine: walkBook, depth cap, latency replay, resolution lockout, mirror invariant |
| `extension/predict-score.js` | 405 | ✅ | Brier calibration, Murphy decomposition, ladder scoring, coaching verdict |
| `extension/predict-venues.js` | 361 | ✅ | Kalshi + Polymarket adapters, HL/Limitless stubs, book normalization |
| `extension/predict-ticket.js` | 255 | ✅ | Shadow-DOM trade ticket, quote+submit flow |
| `extension/predict-sites.js` | 127 | ✅ | URL detection per venue |
| `extension/predict-content.js` | 98 | ✅ | Content script entry, SIMULATED badge |
| **Total new code** | **1,815** | | |

---

## Phase 3 — Wiring

| File | Change |
|---|---|
| `extension/manifest.json` | New ISOLATED content-script entry for 4 prediction origins |
| `extension/background.js` | Import predict-engine/score/venues; add PREDICT_QUOTE/PREDICT_SUBMIT handlers |
| `docs/PERMISSIONS.md` | Prediction venues justification added |
| `CHANGELOG.md` | v3.3.0 entry with attribution |

**N/A (stated in report):** `warmdest.js` (no warm-open for prediction sites yet), `xray-core.js` (prediction venues carry no CAs), `title-feed.js`, `price-bridge.js`, `sites.js` (prediction is a sibling, not a branch).

### Wiring output (ptrecon wiring, 2026-08-08)

All four venues: token touch-list items (`sites.js`, `warmdest.js`, `xray-core.js`, `title-feed.js`) are N/A by design — prediction venues use `predict-sites.js` and a separate manifest entry, not the token adapter. `PERMISSIONS.md` passes for all four. `manifest.json` passes for Hyperliquid (existing perps entry covers the host) and has the new ISOLATED entry for the other three. `background.js` passes for Hyperliquid (existing entry) and has the new PREDICT_QUOTE/PREDICT_SUBMIT handlers for all venues.

---

## Phase 4 — Tests

| File | Tests | Pass | Fail | What it locks |
|---|---|---|---|---|
| `predict-engine.test.js` | 21 | 21 | 0 | walkBook properties, depth cap, resolution lockout, mirror invariant, priceMoved, takerLevels |
| `predict-kalshi.test.js` | 10 | 10 | 0 | Bid-ladder mirror, element 1 never price, sorting, invariant check, edge cases |
| `predict-sites.test.js` | 20 | 20 | 0 | URL gating: must-mount + must-refuse for all 4 venues, bounds locks |
| `predict-score.test.js` | 24 | 24 | 0 | Brier, BSS, scoring gates (n<30/n<20), Murphy decomposition, ladder, coaching |
| `predict-isolation.test.js` | 6 | 6 | 0 | Prediction never mutates token/perps state, storage namespace isolation, void handling |
| **Total** | **81** | **81** | **0** | |

**Existing suite unaffected:** `engine.test.js` 35/35 pass. `sitegating.test.js` has 1 pre-existing failure (pump.fun, unrelated to prediction).

**Mutation proofs:** Engine property tests verify that walkBook cost always equals Σ(qty×price), fill price lies between touched levels, and fills never exceed visible depth — mutating any of these breaks a derived assertion. Kalshi adapter locks prove the bid-ladder mirror math and that element 1 is never read as a price — swapping the element index fails catastrophically. Scoring gate tests prove that n<30 produces `displayable=false` with null CI — removing the gate makes the test fail. Isolation locks prove that running the engine/scoring functions doesn't mutate any global — adding a storage write breaks the serialization check.

---

## Phase 5 — Verification

- [x] All 6 new `.js` files pass `node --check`
- [x] No U+2009 (thin space) or U+00A0 (NBSP) in new code
- [x] 81/81 prediction tests pass
- [x] Existing 35 engine tests unaffected
- [ ] `scripts/preflight.sh` — run on Windows build environment
- [ ] Build zip + load unpacked in fresh profile
- [ ] Live pass per venue (requires interactive browser — cannot be automated)

---

## Open items for Terp

1. **Live pass** — requires headed browser sessions to verify panel mounts, quote walks a real book, latency replay observable, price_moved on fast market, settlement sweep, SIMULATED badge. Login-gated surfaces (Kalshi/Polymarket portfolio pages) will be noted as open.
2. **CWS gate** — the release that carries prediction adds 4 content-script origins. This intersects the pending CWS submission. Land the code, cut nothing, and decide on release timing separately.
3. **Additional recon captures** — Polymarket, Hyperliquid, and Limitless need headed captures with live-ticking prices before their adapters can ship `verified: true`. The `verified: false` stubs mount nothing and are safe to ship.
