A3-2 re-audit FINAL (2026-08-28): SUPERSEDED by lines 2314/2317 just found.

The replay routes are ALREADY edge-cached via edgeCached() (60s s-maxage,
200-only, mutable-copy header fix at 147-165). The "unthrottled replay
fan-out" claim is fully mitigated in current code:

- bounded budgets (8/12/30) per request,
- indeix-budget-exhausted -> 429,
- 60s edge cache on BOTH replay GETs (history + wallet),
- leaderboard/trench/sprint/profile/clans/x-feed/activity also cached.

Combined with re-check #1 (duel writes are session+rate guarded; GET /api/duel
is read-only with a benign one-time settlement write), the ENTIRE A3-2 audit
finding describes code that has since shipped its mitigation (or was a misread
of the router). NO FURTHER CODE CHANGE NEEDED for A3-2.

Retained for the ledger:
- The A3-2 disposition is: DUPLICATE-OF-SHIPPED (edge caching exists) +
  PARTIAL-MISREAD (duel write guard exists).
- ~45-subrequest figure: theoretical worst-case sum of two independent lanes
  (GT fallback + RPC pagination) that cannot both run at full depth for one
  request class; budgets + cache make real spend far lower.

A3-1 (backlog drain loop) = FIXED this session (server 235/235 green).
feeBps default pin = FIXED this session (10/10 + negative control proven).
Remaining from triage list: A3-3 (clan full-scan 300 cap) and fill-stall UX.

Evidence: worker/index.js:147-165 (edgeCached), 2258-2317 (wired routes),
2100-2171 (budgets + replayError mapping).