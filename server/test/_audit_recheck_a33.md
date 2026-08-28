A3-3 disposition (2026-08-28): clans LIMIT 300, silent.

worker/index.js:1098 — `ORDER BY c.created_at ASC LIMIT 300`.
- The scan itself is fine (edge-cached BOARD_CACHE_SEC; one query).
- The DEFECT is honesty: clan #301+ silently vanishes from the directory —
  the site gives no signal that the list is truncated, so a clan that exists
  looks nonexistent to the people in it.
- Current clan count is far below 300 (this is a future-proofing fix).

Fix (minimal, honest): keep the 300 cap (D1 row economics + payload size)
but TELL the truth: return `clansTotal` alongside `entries` and a
`clansTruncated: true` flag when total > cap; site/clan.html renders a
footnote "showing 300 of N clans" when truncated. UI change is one element.

Note: handleClanGet(tag) is NOT capped (per-tag lookup) — unaffected.
clanStandings scans are per-window aggregates already bounded by clan set.