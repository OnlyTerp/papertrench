# PaperTrench — the delight map (2026-08-28)

Grounded in an 82-query research sweep (410+ sources) across habit design,
competition mechanics, trading-app ethics, and live-ops cadence. Every outside
claim carries a citation. Statements about what PaperTrench already ships were
verified against this repo (docs/, extension/, site/) on 2026-08-28. Every
proposal is checked against the product doctrine: discipline over PnL,
graduation as the win state, never store what can be derived, and the honest
brand ("not farming you, arming you"). The roadmap's rule applies here too —
an idea ships only if it **makes training honest or makes training stick**.

## Where the product already wins (do not rebuild)

Seasons, Survival mode, spoiler-free share cards, the streak ladder (rounds,
not days — absence never breaks a streak), the discipline KPI letter, clan
rules ("you bring your future, not your past"), The After, and the
graduation bar are all shipped and doctrine-clean. The D1 leaderboard,
clans, duels, and the Sprint window are live. The gap this map attacks is
**the daily loop and the social surface**, not the competitive core.

---

## A. The daily loop — give tomorrow a reason

**A1. The Trench Grid (contribution heatmap).** A GitHub-style year grid on
the dashboard: one cell per day, colored by *discipline grade* of that day's
rounds, never by PnL. GitHub's graph works because it turns presence into an
identity artifact you protect[17]. Fully derivable from the existing journal
(doctrine §4 — nothing new stored), and it gives a quiet reason to keep the
chain alive that has nothing to do with money. Pair each cell with The After
outcomes already recorded.

**A2. Daily Spark (once-a-day scenario).** The strongest once-a-day retention
pattern is shared-scarcity: everyone gets the same puzzle, once, and the
result card tells a story without spoiling it[1][9]. Concretely: each day the
server picks one historical coin-and-window from real candle data; the
extension plays it back blind (chart up to T, then you commit paper buys,
sells, or a pass); grading is deterministic from the candles that followed.
Result card: an emoji-grade grid (Wordle grammar[9]) with zero PnL — pass it
to the existing share-card pipeline, which already enforces no-PnL at the
painter layer. This is the single highest-leverage new ritual: it costs one
endpoint, reuses replay plumbing, and creates a 24-hour appointment.

**A3. Session Recap ("The Debrief").** End-of-session summary screen: rounds
closed, grade wheel, one After outcome, one process note ("you sized down
after the red — that's the skill"). Game-design "juice" research says the
recap moment is where a session cements into a memory[1]; the FCA's trading
experiment is the boundary condition — celebrate process, never Manufacture
FOMO[5].

**A4. Session-time honesty nudge.** A gentle "that's the session" note after
prolonged activity, consistent with the risk-budget framing: fintech
gamification needs a deliberate budget of persuasive pressure, spent on
learning rather than volume[12]. This is the brand made mechanical.

---

## B. The social surface — make it a place, not a scoreboard

**B1. Trench Wrapped (monthly mirror card).** Spotify Wrapped works as an
identity ritual: your own data reflected back, formatted for sharing, timed
as an event[16]. PaperTrench already has every input in the journal. A
monthly recap card — rounds, discipline letter, longest recovery, hold-time
symmetry, "the one that got away" (After data) — with no PnL fields, sharing
the season-card pipeline. Once a month, not a notification stream.

**B2. Clan reckoning night.** The Sprint already closes Monday-to-Monday;
give clans a named Friday close ("the Friday reckoning" pattern — the
retention spike in competitive leagues[7]) with a per-clan digest posted to
Discord by the existing bot. Live-ops research is blunt: a sustainable
cadence beats event spam — one anchored weekly ritual per community[21].

**B3. Inter-clan pairings.** Clan standings exist; add weekly clan-vs-clan
matchmaking by roster size and grade band, not by rank. Engagement-optimized
matchmaking (EOMM) shows pairing for *engagement* rather than pure skill
raises retention measurably[4]. Same uncheatable set of rules: a pairing is a
window over chains, nothing new stored.

**B4. Trench buddies (accountability pairs).** KAIST's commitment-device
studies show paired users with mutual visibility stick to behavior-change
goals at higher rates than solo users with the same tools[10]. Opt-in pair:
each sees the other's streak, round count, and journaled-today flag — never
each other's PnL (keeps it process-graded and low-stakes).

**B5. Soft-reset duel ladder.** Duels are live; adopt FACEIT's personalized
soft reset for season starts — new players aren't thrown to wolves, veterans
still earn their seat[22].

**B6. Watch-party predictions (stream lane).** The streams page, overlay,
and roster are live. Add chat predictions on the streamer's next paper move
("send or pass?"), scored by what the chain actually did — StreamPredict
shows the format works for livestreams[20], and Trade Royale is already
running two-player same-chart trading esports as a spectator product[8].
It converts viewers into install users; the Twitch overlay card is the
hook, and this makes watching participatory.

---

## C. Progression — make the graduation bar the game

**C1. The Path (visible skill tree toward graduation).** GRADUATION.md
defines the bar (50+ round trips, positive expectancy, loss<win, hold-time
symmetry, no revenge pattern). Map each criterion to a visible node with
live progress derived from the journal. Habit research says the window to
automaticity is measured in weeks, and visible progress through that window
is what carries people[18]. This is doctrine §3 made concrete: every
engagement surface points at the exit.

**C2. Season track, discipline-tiered (battle-pass shape, honest payload).**
The Deconstructor-of-Fun battle-pass analysis: the pass works because it
compresses play into a season window and pays the long tail[7]. PaperTrench's
seasons already exist; add a visible tier track (free, no purchase, no
currency) whose tiers are discipline grades and journal consistency, with
cosmetic + status payload. Risk-budget rule[12] and the loot-box literature
set the line: no randomization, no money, earnable only through process[13].

**C3. Badge display case.** Thirteen process badges exist and are buried.
Give them a showcase on the profile — collectible presentation, zero
randomness, each badge carrying its evidence link (already computed by
gamify.js). Collection mechanics drive return visits when items are earned,
not bought[13].

---

## D. Channels — live where the user already is

**D1. chrome.sidePanel as the trading-desk home.** The popup is a transient
surface; the side panel API gives PaperTrench a persistent, dockable home
while a user trades on Axiom/Photon/Dexscreener[19]. Content: active round,
streak chip, season standing, The After feed, today's Spark. This is the
biggest "open it every day" lever in the extension itself.

**D2. Opt-in New Tab ("Trench Today").** chrome_url_overrides newtab is a
proven habit surface[11] — and a permission-sensitive one. Opt-in only,
consistent with the manifest's narrow-permission doctrine (PERMISSIONS.md
O-09), and clearly framed as replaceable.

**D3. Discord digest + challenge commands.** papertrench#0996 exists. Add:
weekly clan digest embed (B2), `/challenge @user` posting a duel offer,
streak milestone announcements. Keep it digest-shaped (one post, high
signal), not notification-shaped — streak-reminder research shows timing
quality beats frequency[24] and finance-app push benchmarks
are unforgiving of spam[15].

**D4. The badge as ambient pulse.** The action badge (already available
under MV3) counts *unread After outcomes* and open duel turns — things that
expire socially, not money. Cheap, no new permission, pulls the user back
into a live game state.

---

## E. The honesty moat — market the anti-dark-pattern doctrine

**E1. Publish the risk budget.** A public page: what we deliberately don't do
(no confetti on PnL[6], no loss-leader FOMO counters, no streak punishment,
no loot boxes[13]), alongside the FCA's findings on engagement-optimized
trading design[5]. Every competitor's dark pattern is a marketing beat for
the trainer that tells the truth. This is the "confetti regulation" debate
turned into brand: we celebrate recovered drawdowns, not red-and-green
slot-machine spins[6].

**E2. Discipline co-crown completed.** Roadmap item 4's server half: two
boards, two kings, side by side. The PnL board is the bait that gets looked
at; the discipline board is the one the product calls *the* board.
Leaderboard-design research supports segmenting boards and de-emphasizing
pure rank to protect casuals from demotivation[26][4].

---

## Sequencing (leverage-ordered, dependency-aware)

1. **A1 Trench Grid** — pure derivation, no backend. Ships alone.
2. **D1 side panel** — biggest daily-open lever; reuses dashboard sections.
3. **A2 Daily Spark** — needs one worker endpoint + replay wiring; the
   ritual the loop needs. Weeks 2–3.
4. **B2+B3 clan cadence + pairings** — leaderboard backend is live; this is
   presentation + one matchmaking view. After Spark stabilizes.
5. **C1 The Path** — derivation off GRADUATION.md; pairs with C3 badge
   showcase (same surface).
6. **B1 Wrapped** — monthly cadence; build once A1/A3 exist (same painter).
7. **B6 watch-party predictions** — stream lane; needs the duel engine and
   an overlay socket. Biggest production lift; schedule after the loop ships.
8. **E1 risk-budget page** — any time; pure site page + doc.

## Explicitly not doing (extends ROADMAP's list)

- Loot boxes, paid passes, randomized rewards of any kind[13].
- Notification volume as a growth metric; no FOMO counters, no "coins are
  moving without you" pushes[5].
- Confetti (or any celebration) tied to money outcomes — process moments
  only[6][5].
- Daily-login calendars paying escalating loot — the streak already counts
  rounds, not days, which is the honest version of this mechanic[2][3].
- Any surface that doesn't point at graduation[doctrine §3].

## Sources

[1] https://www.gamedeveloper.com/design/the-rise-of-once-a-day-games-lessons-learned-from-wordle-s-legacy — The rise of once-a-day games
[2] https://www.duolingo.com/help/what-is-a-streak — How we protect learner streaks from site issues
[3] https://knowledge.insead.edu/marketing/consumer-streaks-are-motivating-key-keeping-them-alive — Consumer Streaks Are Motivating - INSEAD
[4] https://web.cs.ucla.edu/~yzsun/papers/WWW17Chen_EOMM — EOMM: An Engagement Optimized Matchmaking Framework
[5] https://www.fca.org.uk/publications/fca-research/research-note-digital-engagement-practices-trading-apps-experiment — FCA: Digital engagement practices - a trading apps experiment
[6] https://builtformars.com/case-studies/chase — Why Confetti Celebrations Backfire
[7] https://www.deconstructoroffun.com/blog/2022/6/4/battle-passes-analysis — Battle Passes - Deconstructor of Fun
[8] https://traderoyale.com — Trade Royale - The Trading Esports League
[9] https://www.theverge.com/tldr/22881995/wordle-emoji-results-auto-generated-tell-a-story — The real beauty of Wordle emoji results
[10] https://ic.kaist.ac.kr/publications/papers/lee2019commitment.pdf — Commitment Devices in Online Behavior Change Support Systems
[11] https://developer.chrome.com/docs/extensions/develop/ui/override-chrome-pages — chrome.sidePanel API
[12] https://www.app-learning.com/blog/fintech-gamification-needs-risk-budget — Fintech Gamification Needs a Risk Budget
[13] https://link.springer.com/article/10.1007/s12525-021-00477-0 — Gamblified digital product offerings: loot box menu designs
[15] https://getbruin.com/use-cases/mobile-gaming/limited-time-game-mode-retention-effect — App Retention Benchmarks 2026: D1/D7/D30 by Industry
[16] https://thestrategysignal.com/p/mirror-loop-protocol-spotify-wrapped-marketing — The Mirror Loop Protocol: How Spotify Wrapped Works
[17] https://inithabits.com/blog/github-style-habit-tracker — GitHub-style habit tracker: why it works
[18] https://www.ucl.ac.uk/news/2009/aug/how-long-does-it-take-form-habit — How long does it take to form a habit? (UCL)
[19] https://developer.chrome.com/docs/extensions/reference/api/sidePanel — chrome.sidePanel API - Chrome for Developers
[20] https://streampredict.com — StreamPredict - prediction games for livestreams
[21] https://sarvotamsolutions.com/blog-liveops-events-cadence-offers-segmentation — Designing LiveOps Events That Do Not Burn Players Out
[22] https://support.faceit.com/hc/en-us/articles/28898322786076-Season-9-A-Lighter-Soft-Elo-Reset-Personalised-with-your-recent-win-rate-and-FACEIT-Rating — Season 9: A Lighter Soft Elo Reset - FACEIT
[24] https://dev.to/trophyapp/streak-reminder-emails-the-timing-that-drives-retention-2fl5 — Streak Reminder Emails: The Timing That Drives Retention
[26] https://www.sciencedirect.com/org/science/article/pii/S2291927921000404 — Leaderboard Design Principles (JMIR Serious Games, via ScienceDirect)
