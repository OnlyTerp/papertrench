# Tournament API — Verified PnL contract

Base URL: `https://papertrench-api.onerobby.workers.dev`.

## Standings source

There is no tournament snapshot endpoint and no `tournament_snapshots` table.
The tournament never accepts equity, P&L, position value, or ranking data from a
client. Tournament-aware extension sync submits the ordinary extend-only
attestation chain through `POST /api/submit`; there is no tournament-specific
payload. The server verifies the chain, independently re-prices every fill, and
keeps the latest fully verified tournament entry. A pending or partial record
cannot replace the prior verified entry. The join-time token hand-off and
periodic extension auto-sync loop are a separate client phase.

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

## Submit authentication and rate limit

`POST /api/submit` accepts the normal leaderboard payload from
[`LEADERBOARD.md`](LEADERBOARD.md), including the complete `chain` and `head`.
Authentication is the site's signed session, carried as either:

- `pt_session` cookie; or
- `Authorization: Bearer <session-token>`.

A cookie-bearing POST from a foreign `Origin` is still refused. A cookie-free
Bearer POST to `/api/submit` may come from the extension origin: Bearer tokens
are explicit, non-ambient credentials, so that request does not carry the
cross-site-cookie threat the Origin gate prevents. The exception applies only
to `/api/submit`; other write routes remain Origin-gated.

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
`standingsHash` of the rows used for the cut.

## Tournament writes (authed, Origin-gated)

- `POST /api/tournament/create` — `{name, fieldSize, startStackSol, roundHours, cutPerRound, prizePoolSol?, startTs?}`; omit `startTs` for start-when-full.
- `POST /api/tournament/:code/join` — `{ok, code, started?}`; `started:true` when your join filled the last seat.
- `POST /api/tournament/:code/leave` — open brackets only.
- `POST /api/tournament/:code/cancel` — creator only, open brackets only.

A tournament-specific snapshot push is not supported. Tournament standings can
only change when a server-verified chain is submitted through `/api/submit`.
