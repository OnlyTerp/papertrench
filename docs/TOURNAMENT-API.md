# Tournament API — Verified PnL contract

Base URL: `https://papertrench-api.onerobby.workers.dev`.

## Standings source

There is no tournament snapshot endpoint and no `tournament_snapshots` table.
The tournament never accepts equity, P&L, position value, or ranking data from a
client. Tournament-aware extension sync submits the ordinary extend-only
attestation chain through `POST /api/submit`; there is no tournament-specific
payload. The server verifies the chain, independently re-prices every fill, and
keeps the latest fully verified tournament entry. A pending or partial record
cannot replace the prior verified entry.

Each cut is a `windowEntry` over the verified chain in `[tournament.start_ts, boundaryTs)`.
A round counts only when it opened and closed inside that window, and ROI is
measured against verified equity at the window start. Rows rank by ROI. The
board's SOL figure is `pnlOnStackSol = roiPct / 100 * startStackSol`, so every
entrant's displayed P&L uses the tournament's common stack.

Open positions opened inside the window and still held at a bell are marked at
the boundary minute using the verifier's token-USD and SOL/USD candle ranges.
The compatible native-price interval uses the same conversion and tolerance as
fill re-pricing; its midpoint is the mark. If the independent candle is absent
or unavailable, the position is valued at its remaining gross cost (zero open
P&L) and the row is flagged `unpricedOpenPosition`. The same rule applies at every cut and the
final bell.

Live standings are **provisional** and use each entrant's latest verified chain,
with the window ending at server time. A boundary settles only once
`serverTime >= boundaryTs + 15 minutes`. For that cut, a row is **final** only
when the current stored record was submitted at or after the boundary and its
record status is `verified`; the entry is recomputed from that chain sliced at
the boundary. Everyone else is **forfeited** for the cut and ranks below all
final rows, with provisional ROI breaking ties among non-final rows. The final
round still crowns instead of cutting, and the configured prize split is
unchanged.

## Scoped tournament-sync token

`POST /api/sync-token` and `POST /api/sync-token/revoke` require the normal
signed site session and an allowed `Origin`. Mint returns one plaintext token
once; it contains 32 cryptographically random bytes (`ptsync_` + hex), is
stored server-side only as a SHA-256 hash, and expires after 30 days. Revoke
revokes all sync tokens belonging to the signed-in account.

A sync token authorizes **exactly** cookie-free `POST /api/submit` and
`GET /api/tournament/mine`; successful uses update `last_used_at`. `/mine` is
read-only and returns only the caller's seats, their tournament status and
alive flag, the next boundary, record status, and latest server submission
time. Other routes ignore sync tokens. A session-token Bearer still requires an
allowed `Origin` for writes; it does not receive the phase-1 Origin exception.
A Cookie on a foreign-origin request remains a 403 even if Authorization also
contains a token.

The extension stores a granted token only in `chrome.storage.local` and omits
cookies on API fetches. It polls `/mine` every five minutes while a grant
exists, submits a new head when it changes, and schedules boundary submissions
at +30 seconds with retries at +3 and +8 minutes inside the 15-minute grace.
A 429 waits for the next scheduled alarm; a 401 drops the local grant. The
tournament page revokes all server tokens; the dashboard's Turn off control
removes this device's local grant.

## Submit authentication and rate limit

`POST /api/submit` accepts the normal leaderboard payload from
[`LEADERBOARD.md`](LEADERBOARD.md), including the complete `chain` and `head`.
Authentication is either the site's session (`pt_session` cookie or
`Authorization: Bearer <session-token>`) with the normal Origin requirement, or
the scoped tournament-sync Bearer described above. A duplicate verified chain
can refresh its server receive time without resetting its verification state;
this is how a post-boundary submission of an unchanged chain can qualify as
final for a cut.

Ordinary accounts may submit 6 chains per hour. An alive entrant in a live
tournament may submit 30 per hour so verified chain sync can keep up with play.
Re-pricing resumes from persisted per-fill verdicts for an unchanged chain
prefix, but the record remains `pending` until its new suffix finishes.

## Tournament reads (public, edge-cached ~8s)

- `GET /api/tournaments` — directory: open/live first, then recent.
- `GET /api/tournament/:code/board` — tournament card, standings, settled rounds
  and their `standingsHash`, eliminations, final placements and prizes, plus
  `serverTime`.
- `GET /api/tournament/:code/trader?handle=X` — one trader's verified window
  entry and currently marked open positions.
- `GET /api/tournament/mine` — the caller's seats (authenticated, not cached).

A standing includes `finality` (`final`, `provisional`, or `forfeited`),
`roiPct`, `pnlOnStackSol`, `unpricedOpenPosition`, whether a verified entry is
available, and the server receive time of that entry. Settled `rounds` include
`roundNo`, `startTs`, `endTs`, `settledAt`, and the full SHA-256
`standingsHash` of the rows used for the cut. The hashed JSON stores user IDs
and settled numbers only — never handles, display names, or avatars. Public
reads join the ID to the current `users` row; after erasure, the row is shown as
`deleted trader` without changing the stored JSON or its hash. Phase 1 had put
handles into frozen rows, so phase 2 removes them before any deployment. Phase
1 was local-only; no deployed round hashes were rewritten.

## Tournament writes (authed, Origin-gated)

- `POST /api/tournament/create` — `{name, fieldSize, startStackSol, roundHours, cutPerRound, prizePoolSol?, startTs?}`; omit `startTs` for start-when-full.
- `POST /api/tournament/:code/join` — `{ok, code, started?}`; `started:true` when your join filled the last seat.
- `POST /api/tournament/:code/leave` — open brackets only.
- `POST /api/tournament/:code/cancel` — creator only, open brackets only.

A tournament-specific snapshot push is not supported. Tournament standings can
only change when a server-verified chain is submitted through `/api/submit`.
