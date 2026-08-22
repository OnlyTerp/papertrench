# Deploying the leaderboard server

One-time setup, in order. Everything here is a **maintainer action on real
accounts** — none of it is automated on purpose.

## 1. Cloudflare

```bash
cd server
npx wrangler login
npx wrangler d1 create papertrench
# → paste the printed database_id into wrangler.toml (database_id = "…")
npx wrangler d1 execute papertrench --remote --file=schema.sql
npx wrangler secret put SESSION_SECRET     # paste output of: openssl rand -hex 32
```

`schema.sql` is idempotent (`CREATE TABLE IF NOT EXISTS`), so re-running it
after a release that adds tables is safe. It does **not** add columns to
tables that already exist — if you deployed before duels landed, also run:

```bash
npx wrangler d1 execute papertrench --remote \
  --command "ALTER TABLE records ADD COLUMN badges_json TEXT"
```

**Clans add three tables** (`clans`, `clan_members`, `clan_entries`) and no
columns to existing ones, so an already-deployed database needs nothing but a
re-run of the idempotent schema:

```bash
npx wrangler d1 execute papertrench --remote --file=schema.sql
```

> **Run this BEFORE `wrangler deploy`, not after.** The `[TAG]` chip on the
> leaderboard and Sprint comes from a `LEFT JOIN clan_members` inside those
> boards' own queries, and SQLite fails a statement that names a missing table
> at prepare time — a LEFT JOIN does not degrade to nulls, it errors. Deploying
> the Worker against an un-migrated database therefore takes down `/api/
> leaderboard` and `/api/sprint/current`, not just the clan routes. Verified
> failure: `no such table: clan_members`.

### Why workers.dev and not api.papertrench.com

papertrench.com's nameservers are at GoDaddy (`domaincontrol.com`), and
Cloudflare can only route a zone it hosts — so a Worker route on
`api.papertrench.com` is not available without moving the whole domain's DNS,
which would take the live GitHub Pages site with it. The API therefore answers
on `papertrench-api.<subdomain>.workers.dev`, which needs no DNS at all.

The cost is that the API is **cross-site** to the pages, which is why
`COOKIE_DOMAIN` is deliberately unset (auth.js then selects `SameSite=None`,
because `Lax` would silently drop the session on every cross-site fetch) and
why every state-changing request independently enforces the Origin allowlist.

To move to `api.papertrench.com` later, no code changes are needed: put the
zone on Cloudflare, add a `[[routes]]` block, set `COOKIE_DOMAIN`, and change
the one `API` constant in `site/arena.js`.

## 2. X (Twitter) OAuth app

1. <https://developer.x.com> → create a project + app (free tier is fine —
   the server only calls `GET /2/users/me` at sign-in).
2. User authentication settings:
   - Type: **Public client** (PKCE; there is no client secret and the flow does not use one)
   - Callback URI: `https://papertrench-api.onerobby.workers.dev/api/auth/x/callback`
   - Website: `https://papertrench.com`
   - Scopes: `users.read tweet.read` (X requires tweet.read for /users/me)
3. Paste the OAuth 2.0 Client ID into `wrangler.toml` → `X_CLIENT_ID`.

## 3. Deploy

```bash
npx wrangler deploy
curl https://papertrench-api.onerobby.workers.dev/api/health   # → {"ok":true}
```

The cron trigger (every minute) starts draining pricing work automatically;
it is a no-op while there are no pending records.

## 4. Site config

`site/arena.js` → `EXTENSION_IDS`: put the stable extension id the Chrome Web
Store assigns after the listing goes live. Until then the Sync button
honestly reports "extension not detected" for unpacked installs and points
users at the exported-file path, which always works.

### Known limitation: link previews

Profile and duel pages set `og:title`/`og:description` from the loaded
record, but social crawlers do not run JavaScript, so a shared link unfurls
with the site-wide preview rather than that trader's numbers. Fixing it
properly needs server-rendered OG tags plus a rasterised image (satori +
resvg-wasm on the Worker), which is a real chunk of work and cannot be
verified without deploying — so it is deliberately NOT shipped rather than
half-shipped. In the meantime the profile page's **share card** renders the
record to a PNG the user downloads or copies, which is how traders actually
post results anyway.

## 5. Smoke checklist (after deploy)

**Hit every edge-cached route at least three times.** This is not padding. The
first request after a deploy is a cache MISS and takes a different code path
from every request after it; a bug that only appears on cache hits will pass a
single-shot smoke test and then break the site for the next sixty seconds of
real visitors. That is exactly what shipped once already — `caches.default`
hands back a Response with immutable headers, the CORS pass then threw, and
every hit died as Worker error 1101 while the cold-cache smoke test read
green. Wait ~15s after `wrangler deploy` before judging results, too: edges
serve the previous version briefly and produce a confusing mix.

```bash
API=https://papertrench-api.onerobby.workers.dev
for p in /api/leaderboard /api/sprint/current /api/activity /api/clans; do
  for i in 1 2 3 4 5; do
    curl -s -o /dev/null -w "$p %{http_code}\n" -H "Origin: https://papertrench.com" "$API$p"
  done
done   # every line must read 200
```


- [ ] `GET /api/health` returns ok over the custom domain
- [ ] Sign in with X on papertrench.com/leaderboard round-trips and
      shows your handle
- [ ] Submitting an exported record from a real install returns
      `status: pending` with replayed stats
- [ ] Within a few minutes the record flips to `verified` on your profile
      (watch: `npx wrangler d1 execute papertrench --remote
      --command "SELECT user_id,status FROM records"`)
- [ ] A second submission with a shorter chain is rejected `chain-shrunk`
- [ ] "delete my data" removes the account and the board row disappears
      after the 60s edge cache expires
- [ ] `/api/activity` returns events, and rejection events carry no handle
- [ ] Create a duel, open the invite link in a second browser profile signed
      in as a different X account, join it — the clock starts on join and
      both sides show as provisional until the window closes
- [ ] A duel whose window has closed shows `awaiting` until a post-close
      submission lands, then settles with a plain-language reason
- [ ] `/api/leaderboard` still returns 200 after the clan migration — this is
      the check that catches a Worker deployed ahead of the schema
- [ ] Found a clan on clans.html; the `[TAG]` appears beside your handle on
      the leaderboard once the 60s edge cache expires
- [ ] The new clan reads **forming · 1 of 5**, with no score anywhere — not a
      zero, on the board or the clan page
- [ ] Joining with the invite code from a second X account works, and joining
      a second clan is refused `already-in-a-clan`
- [ ] A member's clan contribution starts at 0 rounds even when their record
      already has hundreds — the since-join rule, visible on the clan page
- [ ] Leaving as founder passes the clan to the longest-standing member;
      leaving as the last member disbands it (`/api/clan?tag=` then 404s)

## Costs, honestly

Reads are edge-cached (60s) so board traffic is ~free at any scale. Writes
are rate-limited (6 submissions/user/hour). The only external dependency is
GeckoTerminal's free OHLCV API, consumed at ≤25 lookups/minute by the cron
with permanent candle caching in D1. Expected bill on Workers Free: $0.
If sustained load ever exceeds the free tier, Workers Paid is $5/mo — that
is the whole worst case.
