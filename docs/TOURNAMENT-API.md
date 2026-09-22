# Tournament API — extension contract

The snapshot push is the only extension-side requirement for v1 spectate.
Everything else is site/worker. Base URL: `https://papertrench-api.onerobby.workers.dev`.

## POST /api/tournament/:code/snapshot

Push a live position snapshot while a tournament you entered is `live`.

**Auth** — same session as the site:

- `pt_session` cookie — cross-site, so send `credentials: 'include'`, or
- `Authorization: Bearer <token>` — the token the OAuth callback puts in the
  URL fragment (`#token=...`) after sign-in.

**Origin** — must be `https://papertrench.com`. Extension background fetches
should set the `Origin` header explicitly; every POST enforces the allowlist.

**Body** (JSON, `Content-Type: application/json`):

```json
{
  "equitySol": 12.34,
  "cashSol": 5.0,
  "positions": [
    { "mint": "So111...", "symbol": "TK", "qty": 100, "valueSol": 7.34 }
  ]
}
```

| Field | Required | Notes |
|---|---|---|
| `equitySol` | yes | Cash + marked positions, in SOL. This is the only number that decides standings. |
| `cashSol` | no | Uninvested paper SOL. |
| `positions` | no | Array, sanitized and capped server-side. `mint` required per row; `symbol`, `qty`, `valueSol` optional. |

**Never sent, never stored**: client timestamps (`pushed_at` is server receive
time) and client-computed PnL (derived as `equitySol − startStackSol`).

**Responses**

| Status | `reason` | Meaning |
|---|---|---|
| 200 | — | Stored. |
| 401 | `not-signed-in` | No/expired session. |
| 404 | `not-found` | Bad code. |
| 409 | `not-entrant` | You hold no seat. |
| 409 | `not-live` | Eliminated, or the bracket is open/done/cancelled. |
| 429 | `rate-limited` | 20 pushes/hour per user. |

**Cadence**: every 30–60s while a tournament you're in is live. Discover your
seats with `GET /api/tournament/mine` (authed) — push only while
`status === 'live'` and your row is `alive`.

## Reads (public, edge-cached ~8s)

- `GET /api/tournaments` — directory: open/live first, then recent.
- `GET /api/tournament/:code/board` — card + standings + settled rounds
  (with `standingsHash` baselines) + eliminations + `serverTime`.
- `GET /api/tournament/:code/trader?handle=X` — one trader's live card.

## Writes (authed, Origin-gated)

- `POST /api/tournament/create` — `{name, fieldSize, startStackSol, roundHours, cutPerRound, prizePoolSol?, startTs?}`; omit `startTs` for start-when-full.
- `POST /api/tournament/:code/join` — `{ok, code, started?}`; `started:true` when your join filled the last seat.
- `POST /api/tournament/:code/leave` — open brackets only.
- `POST /api/tournament/:code/cancel` — creator only, open brackets only.
