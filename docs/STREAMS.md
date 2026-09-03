# Streams page & the PaperTrench Challenge — operator runbook

The live page is `site/streams.html` + `site/streams.js`. Everything an operator
touches lives in the CONFIG block at the top of `streams.js`:

| Constant | What it does |
| --- | --- |
| `STREAMERS` | Hand-maintained roster. Always shown; wins over an approved application with the same login. Twitch entries carry `login`; Kick and YouTube carry `platform` + `channelUrl` (plus `channelId` for a YouTube channel that should play inline). |
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
| `POST /api/streamer/add` | Moderators only (403 otherwise). Lands the row **approved**, attributed to the calling moderator — the direct door from the `/admin` form, replacing the add-a-streamer-by-GitHub-issue ritual. |
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
are listed newest first as summary rows — name, channel, platform, viewer
bucket, age — and expand on click into the full record: what would be
published (including a preview of the card itself), the private contact block,
and the applicant's message to the mod team. **Approve** / **Reject** sit on
each row, and **Move back to pending** undoes a decision. An approval publishes
the card within ~60 s (the edge cache window).

Rules the pipeline applies:

- **Every platform can be approved.** Twitch and Kick channels embed and play
  inline. YouTube plays inline too, but only when the entry carries the UC…
  channel id (see *Which platforms play inline* below); without one it is a
  link-out card. Anything else links out.
  This used to be Twitch-only — `handleStreamerRoster` filtered on
  `twitch_login IS NOT NULL`, so an approved Kick creator became a row nobody
  could see, and the queue admitted it by disabling Approve for them.
- Twitch logins are normalized (`https://twitch.tv/Name?x=1` → `name`) by the
  same rule `streams.js` uses. A URL that cannot be normalized to a valid
  login is still approvable — it simply becomes a link-out card rather than a
  player, and `login` stays null to say so.
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
| Creator name, channel URL, platform, Twitch login, the one-line blurb | Discord username, viewer count, contact method, contact answer, best time to reach, and the free-text notes |

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

## Which platforms play inline

`PLATFORMS` in `streams.js` tracks two separate capabilities, because the
platforms disagree about them:

| Platform | Embeds a player | Reports live/offline | Needs |
| --- | --- | --- | --- |
| Twitch | yes | yes — preview CDN | `login` |
| Kick | yes | yes — `kick.com/api/v2/channels/<slug>` | slug, read from `channelUrl` |
| YouTube | yes | **no** | the UC… channel id |
| other | no | no | — |

They were one flag until multi-platform embeds landed, which forced an
all-or-nothing call on YouTube: either claim a status nothing can back, or
refuse to play a stream that embeds perfectly well.

**YouTube needs the channel id.** `/embed/live_stream?channel=<UC…>` mounts
whatever the channel is currently broadcasting, with no key — but it keys off
the `UC…` id, and a `/@handle` URL cannot be resolved to one client-side. Put
the id in the entry's `channelId` (YouTube: *Share channel → Copy channel ID*)
or use the `/channel/UC…` form of the URL, and the card plays. Neither, and it
stays a link-out card, which is the honest fallback rather than a player keyed
on a guess.

## How the page decides who's "LIVE"

No API keys, so each platform is asked in whatever public way it answers, and
every probe returns live / offline / **unknown** — a failed probe renders as no
badge, never as OFFLINE, because OFFLINE is a claim.

- **Twitch** — the public preview CDN. A live channel's `live_user_<login>`
  thumbnail resolves; an offline one redirects to the `404_preview` image.
- **Kick** — `kick.com/api/v2/channels/<slug>` answers a cross-origin fetch
  with CORS headers. `livestream` is `null` when the channel is off and an
  object when it is on, and it carries a real preview frame, so a live Kick
  card gets a thumbnail exactly like a Twitch one.
- **YouTube** — nothing. The channel `/live` page and the RSS feed are both
  CORS-blocked, and oEmbed 404s on the `live_stream` URL. Real status needs a
  Data API key this static site has nowhere to keep, so a YouTube card shows
  its platform name where the badge would be, forever.

Checked every 60 s. If a platform changes its endpoint the page degrades to
showing no badge for it — never a wrong one.

Each platform is asked its own way and never another's: a Kick slug put to
Twitch's CDN answers about a Twitch channel that happens to share the name.

**A platform with no live signal is never auto-promoted into the featured
player.** It would sit there autoplaying "video unavailable" for every visitor
whenever the channel is off. Clicking its card still plays it — that is the
visitor asking, and the embed then reports its own truth.

### Card order

Live first, then playable-but-offline, then link-out, then by name so two
loads of the board never disagree. The featured player takes the first live
channel from that same order unless the viewer clicked one (or arrived via
`/streams?channel=<login>`) — which means a single live streamer is always the
one in the player.

There is deliberately **no viewer-count sort**. The preview-CDN signal reports
whether a channel is up and nothing else, so ranking by viewers would mean
inventing a number. Real counts need Twitch API credentials
(`TWITCH_CLIENT_ID` / secret → Helix `GET /streams`); until those exist,
live-first is the honest ordering.

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

## Moderation console (`/admin-mod`)

Behind the same `ADMIN_X_IDS` gate as the queue. Three reversible switches,
each requiring a written reason, each recorded in an append-only ledger shown
on the page:

| Switch | Column | Effect |
|---|---|---|
| Ban account | `users.banned_at` | Sign-in refused (checked in `sessionUser`, so it holds on every route); record drops off every board. Bumps `session_epoch`, so live sessions end on the next request. |
| Disqualify record | `records.dq_at` | The record stops ranking. The account is untouched. |
| Disband clan | `clans.disbanded_at` | The clan stops appearing; membership rows are kept, so restoring puts the roster back exactly as it was. |

Ban and disqualify are separate deliberately: collapsed into one flag, taking a
duplicate chain off the board would require banning its owner.

Both lists **page**, 100 rows at a time, and print what they are showing out of
what exists ("Showing 100 of 347 accounts"). They used to take a flat
`LIMIT 100` / `LIMIT 200` with no paging and no total, so past the cap the rows
were simply absent with nothing on the page saying so — and since the clans view
has no search box, a clan past the first 200 could not be reached from the
console at all. `server/core/admin.js` owns the queries; note that every
ORDER BY there ends in a unique id, because paging over a non-unique sort key
drops and repeats rows across page boundaries.

Enforcement is in SQL on the leaderboard and Sprint queries, not in the page —
there is no board, cache or export that can still be showing a banned account.

**Not available, on purpose:** delete, score editing, chain rewriting, and any
way to add a moderator. Moderators stay a deploy-time decision in
`ADMIN_X_IDS` — a console that can promote its own users only has to be
breached once.

The columns are added by the ALTERs in `server/DEPLOY.md`, which must run
**before** the Worker is deployed: SQLite fails a query naming a column that
does not exist, and both the session lookup and the leaderboard name these.
