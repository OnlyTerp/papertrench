# D-69 Contract — Onboarding wizard never sees the first fill (scipher_, 9/3)

## Field report
scipher_ (#general, 2026-09-03): "cant get past this ive made countless trades
still nun" — the leaderboard wizard's Step 2 "Make your first paper trade"
never ticks. Screenshot: Step 1 (Link X) ✓ green, Step 2 stuck, wizard says
"Come back here and this step ticks itself." Terp promised "I will fix today!"

## Root cause (verified in source, dashboard.js)
A fill commits in TWO storage writes from the trading tab, in order:
  1. `pt_state` (wallet/journal)   2. `pt_attest_meta` (chain head)
The dashboard reacts to each `storage.onChanged` echo:
  - Echo 1 (`pt_state`): fingerprint changes → repaint. But `loadAll`'s
    `wantChain` gate does not include a `pt_state`-only change → chain NOT
    re-read → step still unticked.
  - Echo 2 (`pt_attest_meta`): chain IS re-read (`wantChain` true). But
    `dataFingerprint()` has NO chain term → fingerprint unchanged → NO repaint.
The two events never coincide, so a user staring at the wizard sees Step 2
unticked forever. Only a full dashboard reload (or an unrelated change that
both re-reads the chain and moves the fingerprint) heals it.

## Fix (atomic, one commit)
1. `loadAll`: re-read the chain when `pt_attest_seg_*` keys change too (a
   first-ever append creates a segment; meta changes anyway, but the guard is
   free and makes the gate truthful).
2. `dataFingerprint()`: append `attestChain.length` (cheap, already loaded)
   as a fingerprint term. First fill → chain length 0→1 → fingerprint moves →
   wizard repaints with Step 2 ✓.

## VAL- checks (all must pass)
- VAL-1 (unit, new d69_onboard_wizard.test.js):
  a) `loadAll({pt_attest_meta})` re-reads the chain (length 0→1 visible to
     the renderer without any other key changing).
  b) `dataFingerprint()` differs before/after a chain re-read with a longer
     chain — i.e. a fill while the wizard is open repaints it.
  c) NEGATIVE CONTROL: revert dataFingerprint's chain term → (b) FAILS.
- VAL-2 (regression): existing suites stay green —
  `node --test` in extension/test (at minimum: attest*, dashboardfixes,
  d65_refusal_memory, d66_quickbuy_gate) — fingerprint change must not break
  any test that pins its exact output.
- VAL-3 (behavior): simulation of the two-echo sequence
  (pt_state echo → no chain read; pt_attest_meta echo → chain read + repaint)
  shows the wizard's step-2 `done` flag flips true after echo 2 with NO
  dashboard reload.

## Done definition
VAL-1a/1b/1c + VAL-2 green on a clean run; fix described in DEFECTS.md as
D-69 with the regression test named; commit ready; release bump prepared.

## Explicitly out of scope (tracked separately, see sweep notes)
- RPC 403 informational notes counted as errors in debug exports (cosmetic).
- prewatch abort-storm backoff tuning (76× in one giovinastro log — data
  still thin; not part of this fix).
