# Streams page & the PaperTrench Challenge — operator runbook

The live page is `site/streams.html` + `site/streams.js`. Everything an operator
touches lives in the CONFIG block at the top of `streams.js`:

| Constant | What it does |
| --- | --- |
| `STREAMERS` | Hand-maintained roster. Always shown; wins over an approved application with the same login. |
| `SIGNUP_URL` | Where "Sign up as a streamer" points — the on-site form, `streamer-signup.html`. |
| `API` | Worker origin the approved roster is read from. Same value as `arena.js`. |
| `ROSTER_CSV_URL` | Legacy Google-Sheet CSV roster. Empty = disabled, and it should stay empty on a new deploy. |

## Signup + approval pipeline (on-site form → D1 → mod queue → site)

Signups are a page on this site, not a Google Form. Three moving parts:

| Piece | Where |
| --- | --- |
| The form a streamer fills in | `site/streamer-signup.html` + `.js` |
| The moderator queue | `site/admin.html` + `.js` |
| Storage, validation, and the gate | `server/core/streamer.js`, `server/worker/index.js`, table `streamer_applications` |

Routes on the Worker:

| Route | Who can call it |
| --- | --- |
| `POST /api/streamer/apply` | Anyone. Rate-limited to 5/hour per IP. |
| `GET /api/streamer/applications?status=` | Moderators only (403 otherwise). |
| `POST /api/streamer/review` | Moderators only (403 otherwise). |
| `GET /api/streamer/roster` | Anyone. Approved rows, public columns only. |

### One-time setup

1. **Apply the schema** so the new table exists:
   ```
   wrangler d1 execute papertrench --file=server/schema.sql --remote
   ```
2. **Name your moderators.** `ADMIN_X_IDS` in `wrangler.toml` is a
   comma-separated list of **X user ids**, not handles. To find yours: sign in
   on the site, open `/admin`, and the page prints your own id. Paste it in and
   `wrangler deploy`.
3. That's it. Nothing to configure on the site side — `streams.js` already
   points at the form and reads the approved roster.

> An empty `ADMIN_X_IDS` authorises **nobody**. That is deliberate: the queue
> holds applicants' Discord handles and contact details, so a deploy that
> forgets the var closes the queue rather than opening it to every signed-in
> visitor. If `/admin` says you are not a moderator, this is usually why.

### Day-to-day approval

Open `/admin` and sign in with an allowlisted X account. Pending applications
are listed newest first, with **Approve** / **Reject** on each. Approving a
Twitch application publishes its card on the streams page within ~60 s (the
edge cache window). **Move back to pending** undoes a decision.

Rules the pipeline applies:

- Twitch logins are normalized (`https://twitch.tv/Name?x=1` → `name`) by the
  same rule `streams.js` uses; an application whose URL can't be normalized to
  a valid login is stored but **cannot be approved** — the streams page embeds
  Twitch, so approving it would set a status that never becomes a card. The
  Approve button is disabled on those, with a tooltip saying why.
- Duplicate logins are deduped and `STREAMERS` entries win, same as before.
- One application per channel URL may sit in the queue at a time (a partial
  unique index). A rejected applicant can reapply later.
- If the API is unreachable the page falls back to `STREAMERS` and logs
  `PaperTrench: roster API unavailable` — it can never break the page.

### What is published and what is not

The form labels every field **Public** or **Private**, and the split is
enforced in the SQL rather than in a convention:

| Published on approval | Never leaves the mod queue |
| --- | --- |
| Creator name, channel URL, Twitch login, the one-line blurb | Discord username, viewer count, contact method, profile link, best time to reach, and the free-text notes |

The one that matters is **blurb vs. notes**. "One line about your stream" says
it will be shown publicly and is the roster card's text. "Anything else you'd
like us to know?" is a message to moderators and is *never* served by a public
route — `GET /api/streamer/roster` does not select the column. If you ever need
a public bio, edit the blurb; do not repurpose notes.

Applications also store a salted one-way hash of the applicant's IP for abuse
triage. The raw address is never written.

### Migrating off the Google Sheet

`ROSTER_CSV_URL` still works and is read alongside the API, so an existing
deployment keeps its roster on upgrade. To finish the move: re-enter any
approved streamers via the form (or add them to `STREAMERS`), confirm they
show, then set `ROSTER_CSV_URL` back to `''` and unpublish the sheet.

## How the page decides who's "LIVE"

No Twitch API key: the page checks Twitch's public preview CDN. A live
channel's `live_user_<login>` thumbnail resolves; an offline one redirects to
the `404_preview` image. Checked every 60 s. If Twitch ever changes this, the
page degrades to showing no badges — never wrong ones. The featured player
auto-promotes the first live streamer unless the viewer clicked a specific one
(or arrived via `/streams?channel=<login>`).

## Stream overlay (what streamers use)

Ships in the extension (`extension/overlay.html`): extension popup or
dashboard → **🎥 Stream overlay** → chromeless window on a chroma-key
background with live equity, session P&L, win rate, positions, and a
realized-P&L sparkline. OBS: *Sources → Window Capture → pick the window →
Filters → Chroma Key*. Card and lower-third bar layouts; green, magenta, or
dark backgrounds. The PAPER badge, watermark, and footer are intentionally
not removable — same honesty rule as the P&L cards.

## Challenge / leaderboard status

What the streams page promises today is deliberately limited to what exists:
verified *records* (the extension's SHA-256 attest chain, see
`docs/LEADERBOARD.md`) and manually-run giveaways. Public automated standings
still need, in order:

1. A submission path for chain exports (the extension's backup already
   contains the full attest chain).
2. A verifier that replays chains and re-checks fills against market history
   (protocol in `docs/LEADERBOARD.md`).
3. A small standings service or a committed JSON the site renders.

Until then, a season can run manually: approved streamers submit their chain
export at season close, chains are verified offline, winners announced on
stream. Keep prize copy on the page vague-but-true (it currently says prizes
are "announced on the streams").
