# Validation Contract — PT community fix wave (v3.18.0)

Corpus: 195 live Discord messages (4d) + 5 debug exports + 3 screenshots, pulled
2026-08-30 via bot REST. GitHub issues: 0 open.

## Reported defects (evidence-locked)

- **D-62 [P0]** "Fetching live price…" blocks buys on new pairs + migrated tokens,
  STILL LIVE on v3.17.1 (chimbarj 08-30, cheng.4848 08-29 "Why do I still have
  to wait 30 seconds", bgbtyslyr 08-26). Debug exports (ark 08-29 v3.17.1, gio
  08-29 v3.17.1, cheng 08-29 v3.17.1): `http 403 getMultipleAccounts @
  publicnode` dominates (65 hits in ark's, fn:prewatch AND fn:watch, 3.5h span).
  Live probe from this IP: small getMultipleAccounts passes everywhere → the
  block is per-IP weight/reputation (heavy users), not a global outage. Every
  HTTP read in the feed rides getMultipleAccounts; getAccountInfo is NEVER used.
  When the method dies for a user, prewatch can't classify the page's address,
  describePool can't watch, and pricing waits for aggregator indexing (20-30s+).
- **D-63 [P0]** Avg fill line wrong / unreadable (ark 08-29 "Avg fill line is
  not correct": panel says Avg entry $86.1K MC, chart line drawn at 56K on an
  mcap axis; dashgirn 08-30 "if price goes below 5k the avg rentry goes of the
  charts": fill 200.35 vs candles 5K-66K, label pinned at axis bottom).
- **D-64 [P1]** GMGN: "Marks feature enabled, but the Avg Price and Avg Exit
  lines never show up" (portifly 08-28). Line path depends on
  `#global-tv-overlay` React fiber walk — verify live whether GMGN still mounts
  that node (DOM rename = silent dead lane), else this is a has-no-position
  expectation to answer, not a code bug.
- **D-65 [needs-info]** "The filters. They don't work on new pairs or stretched
  on axiom" (craw9961 08-28). No product "filters" feature exists in the
  extension (guardrails ≠ filters; no filter settings anywhere). One-liner, no
  follow-up in channel. Action: ask which filter UI he means. NO guessed fix.

## VAL- assertions (executable unless noted)

- VAL-A-01: `extension/test/d62_gma_fallback.test.js` — when every pool endpoint
  method-blocks getMultipleAccounts, feed `getAccounts([addr])` and
  `getAccountsWithSlot([addr])` still return account data via getAccountInfo
  fallback; slot comes from the per-response context or 0 (honest).
- VAL-A-02: same test file — a >20-address batch is chunked (no single
  getMultipleAccounts call carries >20 keys) on the happy path too (WAF size
  avoidance).
- VAL-A-03: negative control — stash the fix, both A tests FAIL (red), restore,
  PASS. Recorded in the release evidence file.
- VAL-A-04: AMENDED 2026-08-30 (scope change, honest): no 4th live keyless
  endpoint exists — drpc/alchemy/ankr/rpcpool/shyft = paid, onfinality =
  instant 429, blockpi/everstake/llamarpc/ushnode/syndica/nobitex = dead DNS,
  okx = 405 (probe log in evidence). Replaced by: getAccountInfo fallback
  itself is the resilience lane (cheaper method, distinct weight class —
  ark's 3.5h log carries zero getAccountInfo errors; the extension simply
  never calls it). Pool ranking/method-block logic untouched.
- VAL-A-05: full extension suite green (baseline count recorded; no new fails).
- VAL-B-01: `extension/test/d63_linelevel.test.js` — on an mcap-basis spec with
  fresh currentMcap, lineLevelFor uses the resolver-cap-normalized level
  avgMcap × (close / currentMcap) when the native-ratio level diverges from it
  by >5% (stale currentPriceNative no longer skews the line); within 5% the
  existing F-32 frozen behavior is preserved.
- VAL-B-02: same file — off-range guard: a wanted level below 25% of the
  visible candle low (dashgirn case: 200 vs 5K candles) no longer draws a
  mid-axis order line pinned at a garbage position; the slot is cleared and the
  reason recorded (`off-scale`), panel keeps showing the true avg (already does).
- VAL-B-03: negative control for B (stash → red → restore → green).
- VAL-C-01: live DOM probe of gmgn.ai token page: `#global-tv-overlay` present
  (or not) + fiber chart exposing createOrderLine — verdict recorded in the
  evidence file. If the node is gone: fix findGmgnChart to the new anchor +
  VAL-C-02 harness test. If present: C is an expectation answer, not code.
- VAL-C-02 (conditional on C-01): pinned test for the new anchor.
- VAL-R-01: release train — version 3.18.0 in manifest, CHANGELOG entry,
  site/news.js entry (tagged only, exact heading match, newest-first order),
  tag cut at the FIXED tip (git rev-parse v3.18.0 == origin/main), zip
  SHA256 == SHA256SUMS.txt entry. [evidence: release-check output file]
- VAL-R-02: Discord replies posted (fix report in 🐛-bug-reports + needs-info
  answers to portifly/craw9961), verified by re-reading the channel after post.
- VAL-SAFE-01: no secrets in the diff or the evidence files (grep DISCORD_BOT_TOKEN etc).

## "Done" definition

Every VAL- above evidenced in `evidence-v3.18.0.md` next to this contract;
verdict per contract-first states. craw9961 (D-65) is DONE by asking, not by
guessing — a question posted is the deliverable for that lane.
