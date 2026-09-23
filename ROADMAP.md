# PaperTrench — Road out of Alpha

> Historical v2.0 road-out-of-alpha plan. The current plan is [docs/ROADMAP.md](docs/ROADMAP.md).

> **Status (2026-08-05): SHIPPED as v2.0.0.** All phases executed. 116 of the
> 139 audited defects fixed with locking regression tests; 4 carry explicit
> engineering dispositions; the remainder is the enumerated v2.1 polish
> backlog in DEFECTS.md. Suite: 553/553. Remaining human step: a
> docs/QA-MATRIX.md pass on the built zip against the live sites.

**Mission:** memecoins are minting losers faster than any market in history because
newcomers have nowhere to practice. Every existing tool wants them funded and bleeding.
PaperTrench is the free, open-source flight simulator for the trenches: real sites, real
feeds, real heat — zero money at risk — plus the journal/replay/coach loop that turns
reps into skill. The product succeeds when a newcomer can install it, practice honestly,
and *know* when they're ready for real money.

**Quality bar for "production":** boring reliability. Every number on screen is true or
absent — never wrong. Nothing silently dies. Nothing appears where it shouldn't. Nothing
looks half-built. A wrong number in a simulator teaches a wrong lesson with real-money
consequences later — correctness here is a safety property, not a nicety.

**Version target:** the exit of this roadmap is **v2.0 — out of alpha**.

---

## Current state (honest)

- v1.2.16 shipped; suite green at 435/435 including two hardening patches
  (engine settings-migration rev 7, background lastError handling) — **unshipped, ready
  as v1.2.17**.
- Release history to date is reactive: community reports a break → we patch. Six
  patch releases in three days, all triggered by user reports. Good responsiveness,
  wrong posture: users are our QA. That inverts on this roadmap.
- Known complaint clusters from the community: dashboard display bugs; trades not
  filling during high volume; chart lines misplaced; overlay appearing on pages it
  shouldn't; elements that can't be moved; visual roughness.
- Known backlog (from the partial audit, HANDOFF.md §5): frame capture writes to
  `chrome.storage` every capture with no quota handling; `dashboard.js` refresh
  interval never cleared; unmanaged intervals in `price-bridge.js` and `content.js`;
  popup object-URL leaks; weak input validation in dashboard settings.

---

## Phase 0 — Clean baseline (immediate)

Ship **v1.2.17**: the two hardening patches + test fixes already green.

**Exit:** tagged release, hash-verified, mirror synced. *(Awaiting go-ahead — release
push is a public action.)*

## Phase 1 — Truth audit: turn complaints into a defect register

Convert every vague community complaint into a reproducible, ranked defect. Four
parallel code audits (overlay gating/lifecycle, high-volume trade path, dashboard
correctness, chart marker placement) plus a live-site visual sweep across all seven
supported platforms. Everything lands in **DEFECTS.md**: one entry per defect —
severity, affected sites, repro, root-cause hypothesis, file:line.

Severity scale (mission-weighted):
- **S1 — lies:** a number displayed wrong (P&L, avg fill, balance, marker position).
- **S2 — silent death:** feed/fill/render stops without telling the user.
- **S3 — wrong presence:** overlay where it shouldn't be, missing where it should.
- **S4 — friction:** can't move/resize/find things; confusing states.
- **S5 — polish:** looks bad, inconsistent, unfinished.

**Exit:** DEFECTS.md exists, every known complaint mapped to a concrete entry or
explicitly marked not-reproducible with what we need from the reporter.

## Phase 2 — Correctness under fire (the money paths)

The paths where wrongness teaches wrong lessons. Fix S1/S2 defects from Phase 1, plus:

- **Feed resilience per adapter.** The GMGN high-volume fix (v1.2.14) was one instance
  of a *class*: frame-size guards, tick budgets, and parse assumptions that break
  exactly at peak volume. Audit the same class on every adapter (Axiom, Padre, Photon,
  BullX, Pump.fun, DexScreener). Build a **synthetic feed-replay stress harness**:
  recorded real frames replayed at 10× observed peak rate; contract for every adapter —
  never silently die, always recover, watched mint always ticks.
- **Fill integrity.** "Trades not going in during high volume" — every fill either
  executes against a validated price or is *refused with a visible reason*. No third
  state. Trace the full buy path under feed gaps, stale quotes, and storage contention.
- **State integrity.** Property tests over the write-counter protocol: multi-tab races,
  reset, backup/restore round-trip, dashboard-vs-tab write ordering.
- **Marker/line placement contract.** Per site: which axis (price vs mcap), which unit,
  which bar alignment. Locked with regression tests per adapter.

**Exit:** stress harness in CI (`node --test`), zero known S1/S2 defects, every fix
carries a regression test that failed before the fix.

## Phase 3 — Overlay lifecycle & UX correctness

- **Page gating.** Strict per-site rules for where the overlay may exist. Never on home
  pages, settings, portfolio, or non-token pages; instant appear/disappear on SPA
  navigation. Site-detection contract tests with real URL fixtures per platform.
- **One drag system.** Panel, positions bar, and any floating element share a single
  drag + persist + viewport-clamp code path. Everything floating is movable; everything
  movable remembers its place; nothing can be dragged off-screen or trapped under
  site UI.
- **Error surfacing.** Every failure a user can hit produces a calm, visible message.
  Inventory every `catch`/early-return in the user path; kill every silent no-op.
- **Interval/resource hygiene.** All timers through `managedInterval`; dashboard
  intervals cleared on close; frame capture moved off `chrome.storage` to IndexedDB
  with a quota policy (backlog items #3, should-fix #1–3).

**Exit:** overlay presence matrix (7 sites × page types) passes; drag audit clean;
zero unmanaged timers; frame capture quota-safe.

## Phase 4 — Visual quality bar

The product must look like it respects its users. Full design pass:

- Design tokens in `content.css` (spacing, type scale, color roles) — one visual
  language across overlay, positions bar, dashboard, popup.
- Dashboard redesign to product-grade: real empty states, loading states, error states.
- Screenshot review: 7 sites × light/dark × small-window, before/after every change.
- Thesis counter, preset-input validation, and the rest of the polish backlog.

**Exit:** screenshot matrix reviewed; no screen ships that we wouldn't put on the
landing page.

## Phase 5 — Production infrastructure

- **Test depth:** adapter contract tests from recorded fixtures; property tests for
  engine math; the stress harness from Phase 2 running in every `node --test`.
- **Release discipline:** one scripted build+verify path (test → zip → hash → smoke
  checklist); the 7-site QA matrix scripted as a per-release checklist stored with the
  release.
- **Community intake:** GitHub issue templates that capture site/version/console
  output; in-extension "Report a bug" that assembles a local diagnostic bundle the user
  pastes themselves (no telemetry, ever — privacy is part of the trust story).
- **Docs:** user guide; honest FAQ; **graduation guidance** — what the stats have to
  look like before real money is rational. This is mission-core, not marketing.
- **Chrome Web Store readiness:** permissions audit, privacy policy, listing assets.

**Exit:** a release can ship start-to-finish through the scripted path with zero
improvisation; a stranger can report a usable bug in two minutes.

## Phase 6 — Mastery features (post-stability, gated on Phases 1–5)

The mission payload, only on a stable base: coach depth (per-round critique against
the user's own thesis), stats that predict real-world survival (expectancy, hold-time
discipline, tilt detection, revenge-trade flags), practice drills, and explicit
graduation criteria surfaced in the dashboard.

## Phase 7.5 — Multichain paper trading (maintainer, 2026-08-05)

fomo (and the market) is multichain; PaperTrench refuses non-Solana tokens
by design today (O-11: the fomo adapter only mounts on /tokens/solana/).
The maintainer wants non-Solana coins tradeable. This is a designed
release, not a patch: the wallet is SOL-denominated, and the resolver,
quote validation, on-chain feed, and attestation chain are Solana-shaped
end to end. Sketch: per-chain quote sources (Dexscreener covers EVM
chains), fills recorded in USD with the book still SOL-denominated at a
recorded conversion, no on-chain feed for non-SOL at first (aggregator
prices only, stated honestly on the panel), attestation chain carrying the
chain id per fill. Until it ships, non-Solana pages stay panel-less on
purpose — mounting a Solana paper wallet on an EVM token would fake it.

## Phase 7 — Paper copy trader (community request, TheRedShark123 2026-08-05)

"A simulated copy trader to test if some wallets are worth it" — exactly the
product's shape: find out a wallet is mid with fake money instead of real.
Design constraints, honesty-first:

- **Watch, don't guess.** The user pastes a wallet; the on-chain feed
  (rpc-pool + onchain-feed, the F-33 vault machinery) observes that wallet's
  actual swaps and mirrors them into a SEPARATE paper book ("shadow book"),
  filled at the price WE observe when WE see the trade — the copier's
  realistic fill, not the leader's. The gap between the leader's entry and
  our observed fill IS the finding: copy latency is most of why copy trading
  loses. Both numbers get recorded and shown.
- **Separate book, never blended.** Shadow books never touch the user's own
  wallet, rounds, streaks, grades, rank, or attestation chain (F-30's lesson
  as a design rule: two books must be indistinguishable never). Per-wallet
  verdict card: expectancy, hold symmetry, revenge pattern, drawdown — the
  mastery stats applied to the copied wallet, plus "what you'd have paid in
  fees" through the existing cost model.
- **Bounded honestly.** Watching starts when the user adds the wallet and the
  card says so (X-Ray's "observed since" doctrine); no backfilled history, no
  pretending we saw trades we didn't. Hard cap on watched wallets (RPC
  budget); everything local, nothing phones home.
- **Not before the on-chain feed is boringly stable** on the sites people
  actually copy from (pump.fun launches + AMM tokens, F-33/F-34 class).

---

## Execution model

- Work happens in **big autonomous passes**, each one: audit slice → fixes → regression
  tests → full green suite → changelog entry. No drip-feeding.
- **DEFECTS.md is the single source of truth.** Community reports get triaged into it;
  fixes reference it; releases close entries from it.
- Every fix ships with a test that failed before the fix. No fix without a lock.
- Releases at meaningful checkpoints (maintainer confirms each public push).
- Site-adapter work is verified against the live sites in-browser, not just in tests.
