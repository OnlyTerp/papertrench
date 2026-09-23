# PaperTrench leaderboard server

The server half of [docs/LEADERBOARD.md](../docs/LEADERBOARD.md): it receives
the hash chains the extension commits locally, and turns them into public
standings **without ever trusting a self-reported number**.

## Trust pipeline

Every submission runs the same gauntlet:

1. **Shape gate** — malformed or absurd payloads bounce before any crypto.
2. **`verifyChain`** — every link re-hashed with the exact bytes the
   extension commits (the server imports `extension/attest.js` itself, so
   the contract cannot fork).
3. **Extend-only anchor** — a new submission must contain the previously
   committed head at the same position. Replacing a bad history with a
   fresh lucky one is rejected as `chain-replaced`.
4. **Replay** — standings come from `replayChain` over the raw fills. The
   claimed stats are only compared against the replay; a mismatch is
   recorded as a signal.
5. **Re-pricing** — every fill is checked against the token's real traded
   range (USD candles × the SOL/USD range for that same minute) via
   GeckoTerminal, drained by cron under a lookup budget. Any impossible
   price rejects the record; missing candle data is reported as coverage,
   never faked as a pass.

Ranking is process-weighted (`ROI × ln(1+rounds) × discipline`) with a
five-round floor — one lottery ticket does not top the board.

## Modes are windows, not books

Every competitive mode is the SAME committed chain seen through a different
time window (`core/window.js`). That is what makes the set of modes
uncheatable rather than each one separately: there is no per-mode book to
inflate, and a round counts only if it opened and closed inside the window.

- **Season** — the whole chain.
- **Weekly Trench Sprint** — the UTC Monday-to-Monday slice.
- **Duels** — a 1-hour-to-1-week head-to-head slice, started when the invite
  is accepted so both players face the same clock.
- **Clans** — the same slices again, intersected with each member's join
  date (`core/clan.js`).

### Clans store a roster, never a record

`clan_members.joined_at` is the only new fact clans introduce, and its whole
job is to bound an existing chain: a member's contribution window opens when
they joined, so a lifetime record cannot be recruited in and donated, and a
round counts for exactly one clan. A clan's score is the mean of its five best
member scores and it needs five qualified members to rank at all — summing
would make it a recruiting contest, and averaging the whole roster would charge
a clan for every beginner it takes in. The property that makes this safe to
play: **cutting a struggling member can never raise the score**, only cost the
clan its five-member minimum. Under five, the clan has no score rather than a
zero.

### The duel settlement rule

A duel settles only from a chain submitted **after** its window closed.

The chain is append-only locally and extend-only on the server, so a player
cannot delete a losing round from inside the window — the hashes break, and a
swapped-in history is rejected as `chain-replaced`. That leaves exactly one
vector: submit while you are up, then go quiet so the server's newest copy of
your chain predates your losses. Settling only from post-close submissions
closes it, because a post-close chain necessarily carries every fill made
inside the window. Refusing to submit forfeits rather than freezing a
flattering snapshot. Live standings during the window are shown and labeled
provisional; they never decide the result.

## Achievements

`core/achievements.js` awards badges derived from committed fills alone,
under the extension's own doctrine: **no profit badges, no win-streak badges,
no volume badges.** A badge for making money rewards the coin flip. Every
badge is a process claim (losses taken without chasing, a drawdown actually
recovered, sizing that did not grow after a loss, distinct days of reps) and
every award carries the evidence that earned it — a badge whose reasoning
cannot be shown is a badge that cannot be trusted.

## Activity feed

`/api/activity` streams the verifier's real work: chains accepted, records
verified, submissions rejected. Positive events carry the handle; **rejections
never do.** An automated verdict can fire on thin candle data as easily as on
fraud, and must not publicly brand a named person a cheat.

## Layout

```
core/     pure logic — no fetch, no storage, runs under `node --test`
  chain.js         re-exports extension/attest.js (single source of truth)
  pricing.js       candle plausibility policy (ok / implausible / no-data)
  ranking.js       rounds-from-chain, discipline metrics, season score
  window.js        the shared window slice every mode is built from
  sprint.js        ISO-week windows and sprint entries
  duel.js          head-to-head state machine and the settlement rule
  clan.js          since-join contribution windows, top-five aggregation
  achievements.js  chain-derived badges, process-only by doctrine
  submission.js    the trust pipeline above, as pure orchestration
worker/   Cloudflare adapters — routing, D1, X OAuth (PKCE), sessions,
          edge caching, rate limits, candle cache, pricing cron
test/     behavior locks, one cheat per test
schema.sql, wrangler.toml
```

## API

| Route | Purpose |
|---|---|
| `GET /api/leaderboard` | season standings, edge-cached 60s |
| `GET /api/sprint/current` | this week's Sprint window and standings |
| `GET /api/profile?handle=` | one public record: stats, badges, chain head, sprint history |
| `GET /api/activity` | recent verifier events (rejections anonymised) |
| `POST /api/submit` | the trust pipeline; also refreshes sprint, duel, clan and tournament entries |
| `POST /api/duel/create` | mint a share-link invite |
| `POST /api/duel/join` | accept an invite; starts the shared clock |
| `GET /api/duel?code=` | live duel view, never edge-cached |
| `GET /api/duel/mine` | the signed-in player's duels |
| `GET /api/auth/x/start`, `/callback`, `POST /api/auth/logout` | X sign-in |
| `GET /api/me`, `POST /api/me/delete` | session, and self-serve erasure |
| `POST /api/sync-token`, `POST /api/sync-token/revoke` | mint a 30-day tournament-sync grant once, or revoke all grants |
| `GET /api/tournament/mine` | the authenticated caller's tournament seats and next cuts |

## Running

```
node --test          # the whole core, no network, no Cloudflare
wrangler dev         # local worker against a local D1
```

Deployment (one-time setup, DNS, X OAuth app, secrets): see
[DEPLOY.md](DEPLOY.md).
