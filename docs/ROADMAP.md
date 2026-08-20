# PaperTrench — the trench map (roadmap)

Synthesis of the 2026-08-20 research pass: a competitor teardown (Axiom,
MockApe, GMGN, Photon, Trojan, Bonkbot, Padre — see the CEO research corpus)
and a retention-mechanics study (Moomoo contests, TradeLeague, Duolingo,
chess.com, Strava, TraderSync, fantasy leagues — 60-source corpus under
`pt_pages/`). This doc turns those findings into the next moves. It is a
plan, not a promise: items ship when they clear the bar of "makes training
honest or makes training stick."

## Positioning (locked)

**The trainer that tells the truth.** Nobody owns this lane. Every real
terminal hides true costs (5–8% round-trip on Solana); every paper sim
grades raw PnL with zero fees — training recklessness that blows up on
chain. Axiom (72% share) has no paper mode and an insider scandal; MockApe
(30k installs) is the only rival and doesn't frame itself as training.
PaperTrench's whole design already points this way: honest fills, gap-honest
stops, the PAPER watermark, graduation as the win state. The fee-honesty
line on the PnL card (v3.8.0) is the first brick made visible. Keep laying
bricks: every place the real world would charge, the trench says so.

## Retention — steal these mechanics (research → feature map)

The finding that matters most: **most winning mechanics already exist in
`extension/gamify.js` and are buried.** The roadmap is surfacing, not
building. Ranked by leverage:

1. **Trench Seasons (timeboxed leagues on the real simulator).** Moomoo's
   contest-on-the-real-product took 150k → 350k signups; TradeLeague's
   weekly "Friday reckoning" is the retention spike. Existing stack: the
   rank ladder + rounds ledger. Add: a season pointer (`activeGame` pattern
   already exists, GAMIFY.md §4), a Monday-reset window, and a season-end
   share card. Discipline-graded, never PnL-ranked (doctrine §1).
2. **Broad payouts, not winner-takes-all.** Moomoo paid 61k of ~150k
   entrants — nobody needs top-3 to feel like a winner. Season rewards
   should pay down a long tail (top 40% by discipline grade), matching the
   doctrine that a red round can grade A.
3. **Segmented boards (Strava's trick).** Small cohorts (5–20) retain
   casuals better than one global board. Segments: by tenure week, by
   discipline grade band, by home dex. All derivable from the journal —
   no new data collection.
4. **Discipline co-crown (TraderSync's trick).** Two boards, two kings:
   PnL board AND discipline board, same trophy. The discipline board is
   the on-brand one; the PnL board is the bait that gets looked at.
   Gamify.js already computes both grades — surface them side by side.
5. **Survival mode (opt-in).** Blow the season stake = eliminated from the
   season (not from the product). Scarcity makes the paper money feel
   real; elimination is the honest lesson. Opt-in, one season at a time.
6. **Spoiler-free share cards.** Wordle's grid beat its gameplay: the card
   must not spoil (no final PnL), must be legible in 2 seconds, must
   provoke "what happened?" The round card is close; season cards (item 1)
   get this treatment from day one.
7. **Streaks with status.** Duolingo: 60% of DAU have a 7-day+ streak.
   The overlay bar already has the streak chip; give it a visual ladder
   (ember → flame → blaze → torch) and a freeze mechanic (one rest day/week)
   so a missed day doesn't zero the identity. **v3.8.2: ladder shipped.**
   Freeze turned out to be unnecessary — our streaks count rounds, not
   days, so absence never breaks one (only an undisciplined round does);
   that is the better property and we keep it.

## Distribution (parallel track)

- **Streamer roster**: 4 live (onlyterp, ProfitableDegen, chillygmi,
  plahstickk). Each streamer = a segmented season (item 3) in potentia:
  the streamer's community is the 5–20 cohort. The Twitch overlay card is
  the hook; the season is the reason to stay.
- **GitHub issue triage → testimonial loop**: every closed issue is a
  possible changelog line; every changelog line is a tweet. The corpus
  (`pt_feedback`) is the fuel — keep mining it.
- **News discipline**: tagged releases only, numbers never inflated
  (news.js rules header). This is the brand being the brand.

## Done from this map

- v3.8.0 — fee honesty on the PnL card (#29 chart tab alongside).
- v3.8.1 — panel themes (ark_trades13's ask; comfort retains too).

## Explicitly not doing

- PnL-only leaderboards as the primary surface (trains the wrong habit;
  doctrine §1).
- Engagement loops without the graduation exit (doctrine §3).
- Any mechanic that stores what can be derived (doctrine §4).
