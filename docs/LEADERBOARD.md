# Leaderboard protocol

Paper-trading results are trivially forgeable: every number lives on the user's
own machine. A leaderboard that trusts a self-reported P&L is worthless. This
document describes what PaperTrench produces instead, and what a server must do
with it.

## What the client produces

Every fill is committed to a hash chain **at the moment it happens**, before its
outcome is known. Each link commits to the hash of the previous one.

```js
preimage = [
  "v1", previousHash, id, sessionId, mint, side,
  qty.toFixed(12), priceNative.toExponential(12),
  solGross.toFixed(12), String(timestamp)
].join("|")

hash = sha256(preimage)
```

The preimage format is part of the contract: a verifier must be able to
reproduce it byte-for-byte from the public record alone.

## What that proves

| Property | Why it holds |
|---|---|
| **Ordering** | Each fill commits to its predecessor's hash, so inserting, deleting, or reordering a trade breaks every link that follows. |
| **Pre-commitment** | A fill is hashed when made. Backdating a winning entry invalidates the chain, and timestamps must move forward. |
| **Price claims** | Each fill records mint, side, quantity, price, and timestamp — enough for a verifier to re-fetch historical price data and reject fills at prices that never existed. |

## What it does NOT prove

**A determined user can run modified code and forge a locally consistent chain.**
There is no client-side fix for this, and pretending otherwise would be
dishonest. The chain proves *ordering and internal consistency*; it does not
prove the client was unmodified.

Therefore:

1. **Standings must be recomputed server-side** from the submitted chain, using
   `replayChain()`. Never rank on the `claim` field.
2. **Every fill's price must be re-verified** against independent historical
   data for that mint at that timestamp. This is the step that actually stops
   fabrication.
3. **Identity must cost something.** Binding a record to a verified X account
   makes sybil attacks expensive in a way that a local install is not.

## Submission payload

```json
{
  "version": 1,
  "submittedAt": 1754000000000,
  "identity": { "handle": "someone", "verified": true },
  "claim": {
    "equitySol": 12.4, "realizedPnlSol": 2.4,
    "rounds": 9, "wins": 6, "losses": 3,
    "startingBalanceSol": 10
  },
  "chain": [ /* every link */ ],
  "head": "<sha256 of the last link>",
  "trustModel": "client-generated evidence; server must re-verify every fill price"
}
```

`claim` is included only so a server can compare it against its own
recomputation. A mismatch is itself a signal.

## Suggested server checks

1. `verifyChain(chain)` — reject on any broken link, hash mismatch, or
   out-of-order timestamp.
2. `replayChain(chain, startingBalanceSol)` — compute the real result.
3. Re-price every fill against independent historical data; reject fills whose
   price is impossible for that mint at that second.
4. Enforce one ranked record per verified identity.
5. Rate-limit submissions and store the head hash, so a later submission must
   extend the chain it already committed to rather than replacing it.

## Current status

Both halves exist. The client half ships in the extension; the server half
lives in [`server/`](../server/README.md) (pure verification core +
Cloudflare Workers adapters) and implements every check above, plus:

- **Extend-only anchoring** (check 5 made concrete): the stored head must
  appear at its committed position in the next submission, so a chain can
  be extended but never replaced — including after a local reset.
- **The declared bankroll is pinned.** It is the denominator of ROI and
  therefore of the whole score, and it is the one input the chain cannot
  prove. Resubmitting identical fills under a smaller bankroll would
  multiply the return arbitrarily, so a changed figure is rejected as
  `bankroll-changed`; changing it means deleting the server record and
  starting over, which is self-serve and visible.
- **Ranked figures use only hash-committed fields.** The preimage above
  commits one money field per fill: gross on a buy, net on a sell. A link
  also carries `solNet` on buys, `txCostSol`, and an `amount` copy — stored
  but *not* hashed, so all three can be edited to any value while the chain
  still verifies end to end. The extension replays with them (a user has no
  reason to lie to themselves); the server must not, because driving a buy's
  uncommitted cost toward zero would inflate the return without bound. So
  the ranked book is gross-out on buys and net-in on sells — which is also
  the more honest measure: the cash that actually left and entered the
  wallet, fees included. It runs a little below the figure the dashboard
  shows, and that difference is the buy-side fee, not a discrepancy.
- **Three-state re-pricing.** Fills are checked against the token's USD
  minute candle crossed with the SOL/USD range for the same minute. An
  impossible price rejects the record; a minute with no public candle data
  is counted as coverage honestly (`partial` tier), never passed silently.
- **Process-weighted ranking** (`ROI × ln(1+rounds) × discipline`, five
  closed rounds minimum) and the weekly **Trench Sprint**, both computed
  from the same chain — there is no second record to game.

## Modes are windows, not books

Every competitive mode is the same committed chain seen through a different
time window: the season is the whole chain, the Sprint is a UTC
Monday-to-Monday slice, a duel is a 1-hour-to-1-week head-to-head slice. A
round counts only if it opened *and* closed inside the window. This is what
makes the set of modes uncheatable rather than each mode separately — there
is no per-mode book to inflate.

### Duels, and the one vector left open

A duel settles **only from a chain submitted after its window closed.**

The chain is append-only locally and extend-only on the server, so a player
cannot delete a losing round from inside the window: removing a link breaks
every hash after it, and a swapped-in history is rejected as
`chain-replaced`. That leaves exactly one gaming vector — submit while you
are up, then go quiet so the server's newest copy of your chain predates
your losses. Settling only from post-close submissions closes it, because a
post-close chain necessarily carries every fill made inside the window.
Refusing to submit forfeits rather than freezing a flattering snapshot.
Live standings during the window are shown, labeled provisional, and decide
nothing.

## Clans

A clan is a roster, not a record. It stores exactly one new fact — when each
member joined — and every figure it displays is a member's `windowEntry`
sliced by that date. There is no clan-side ledger, which is the same reason
the modes above are uncheatable as a set.

Two rules carry the whole design.

**You bring your future, not your past.** A member's contribution window opens
at their join time, so rounds closed before they joined count for nothing.
Without this the dominant strategy is to recruit a strong record for a day and
import its entire history, repeated before every weekly close. With it, a round
counts for exactly one clan — the one you were in when you closed it — and
joining the night before the bell contributes nothing.

**The score is the mean of the top five, and five members are needed to rank.**
Summing member scores makes it a recruiting contest. Averaging the whole roster
is worse: it charges a clan for every beginner it takes in, and a product that
exists to give newcomers somewhere to practise must not make teaching them
expensive. The mean of the top five does neither — extra members are free, and
one hero cannot carry a clan.

That third property is the reason to prefer it over anything cleverer:
**cutting a struggling member can never raise a clan's score.** The top five is
the top five whether or not the people below it are on the roster; expelling
them can only cost the clan its five-member minimum. There is no version of
this board where dropping the worst trader is the winning move.

The honest cost, stated rather than hidden: depth is a mild advantage, because
thirty qualified members give more chances at five strong ones than exactly
five do. That has to be earned five verified records at a time.

Other rules that follow from the doctrine above:

- **Under five qualified members, a clan has no score** — it reads *forming*
  with the shortfall, never a zero. Not having fielded five is an absence.
- **A rejected record ranks nowhere,** including inside a roster.
- **One clan per trader,** enforced by the membership table's primary key
  rather than by a code path that could be wrong.
- **Tags and names are immutable** after creation, validated to a narrow ASCII
  charset with a normalised uniqueness key (so `Trench Rats` and `trenchrats`
  collide). A clan that could rename itself after collecting a roster could
  rename itself into an impersonation of another one.
- **Content moderation is deliberately narrow: slurs and sexualised-minor
  terms, and nothing else.** Profanity, crude sexual humour, drug references,
  violence as market metaphor, hostility to institutions and trash talk about
  rival traders all pass — that register is the product's own, and a filter
  that sanded it off would be a worse failure than a rude clan name.

  Matching is on **tokens**, not on the collapsed key: a blocked term has to
  *be* a word, not merely hide inside one. This is not a stylistic choice. A
  collapsed-key design was measured against a corpus of legitimate names and
  rejected between 10 and 23 of them — `Chin Kickers`, `Flame Retardant`,
  `Spicy Gains`, `Tycoon Society`. Substring matching survives only for a
  hand-audited handful of terms, each with its innocent English hosts carved
  out explicitly and each carve-out proven not to work as cover.

  The filter is a **floor, not a guarantee**. It does not read intent, and a
  spelling nobody has thought of will get through. The maintainer's ability to
  delete a clan is the real backstop, and saying so here is cheaper than
  implying a coverage that does not exist.
- **Clan standings are the current season and current week only.** No frozen
  historical clan tables are claimed, because membership changes and a past
  week's clan standing computed from today's roster would be a different
  number than the one that was true then.

## Achievements

Badges are derived from committed fills alone, under the extension's own
doctrine (`gamify.js`): **no profit badges, no win-streak badges, no volume
badges.** A badge for making money rewards the coin flip and teaches the
lesson this product exists to unteach. Each badge is a process claim —
losses taken without chasing, a drawdown actually recovered, sizing that did
not grow after a loss, distinct days of reps — and each award carries the
evidence that earned it.

One consequence worth stating: a badge must not be earnable by never being
tested. "Clean Hands" counts *losses not chased*, not a run of clean rounds,
because a record with no losses has demonstrated no revenge discipline at
all.

## Activity feed

The verifier's work is public: chains accepted, records verified,
submissions rejected. Positive events carry the handle; **rejections never
do.** An automated verdict can fire on thin candle data as easily as on
fraud, and must not publicly brand a named person a cheat.

## Getting the record to the server

The record reaches the site manually in two ways: a JSON export from the
dashboard, or the site's Sync button asking the extension over
`externally_connectable` — which the extension answers only for
papertrench.com and only when the dashboard's **Site sync** toggle is on
(off by default). Tournament entrants have a separate, optional join-time
auto-sync grant: a 30-day token scoped to the verified-chain submit and the
caller's tournament-seat read. With that grant only, the extension sends a
changed chain head every five minutes and after each cut. No grant means no
tournament mine/submit requests.
