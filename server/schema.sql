-- PaperTrench leaderboard server — D1 (SQLite) schema.
-- Apply with: wrangler d1 execute papertrench --file=schema.sql

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  x_id TEXT NOT NULL UNIQUE,          -- immutable X user id; handles can change
  handle TEXT NOT NULL,               -- current @handle, refreshed on login
  display_name TEXT,
  avatar_url TEXT,
  session_epoch INTEGER NOT NULL DEFAULT 0,  -- bump to revoke all sessions
  x_tokens TEXT,                      -- AES-GCM-sealed OAuth pair; WRITE-ONLY
                                      -- (read only inside the x-feed token
                                      -- layer, never serialized outward)
  created_at INTEGER NOT NULL,
  last_login_at INTEGER NOT NULL
);

-- One ranked record per identity (LEADERBOARD.md rule 4). The stored head is
-- the anti-replacement anchor: the next submission must extend it.
CREATE TABLE IF NOT EXISTS records (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  head TEXT NOT NULL,
  chain_len INTEGER NOT NULL,
  starting_sol REAL NOT NULL,
  status TEXT NOT NULL,               -- pending | verified | partial | rejected
  claim_mismatch INTEGER NOT NULL DEFAULT 0,
  stats_json TEXT NOT NULL,           -- ranking.recordStats output
  badges_json TEXT,                   -- achievements.awarded output, recomputed
                                      -- at submit and again after re-pricing
  pricing_json TEXT,                  -- pricing.recordVerdict output once done
  pricing_progress_json TEXT,         -- resumable priceRecord cursor state
  submitted_at INTEGER NOT NULL,
  verified_at INTEGER
);

-- The full chain, segmented like the extension stores it (500 links/segment),
-- so re-verification and sprint slicing never need the client again.
CREATE TABLE IF NOT EXISTS chain_segments (
  user_id INTEGER NOT NULL REFERENCES users(id),
  seg_no INTEGER NOT NULL,
  links_json TEXT NOT NULL,
  PRIMARY KEY (user_id, seg_no)
);

-- Append-only audit log of every submission attempt, accepted or not.
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  head TEXT,
  chain_len INTEGER,
  outcome TEXT NOT NULL,              -- accepted | reason string
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_submissions_user ON submissions(user_id, created_at);

-- Sprint standings are derived data (recomputed from chains on submission),
-- persisted so the board is a read, not a replay.
CREATE TABLE IF NOT EXISTS sprint_entries (
  week_id TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  entry_json TEXT NOT NULL,           -- sprint.sprintEntry output
  score REAL NOT NULL,
  rounds INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (week_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_sprint_score ON sprint_entries(week_id, score DESC);

-- Candle lookups are cached forever: historical minutes never change, and one
-- popular mint's minute serves every verifier that ever asks again.
CREATE TABLE IF NOT EXISTS candle_cache (
  mint TEXT NOT NULL,
  minute_ts INTEGER NOT NULL,
  candles_json TEXT,                  -- {tokenUsd:{low,high},solUsd:{low,high}} or null=no-data
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (mint, minute_ts)
);

-- Mint -> top pool resolution (GeckoTerminal), cached with a TTL because new
-- pools appear for young tokens.
CREATE TABLE IF NOT EXISTS pools (
  mint TEXT PRIMARY KEY,
  pool_id TEXT,
  fetched_at INTEGER NOT NULL
);

-- Head-to-head duels. The window opens when the invite is accepted, so both
-- players face the same clock from the same instant.
CREATE TABLE IF NOT EXISTS duels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  challenger_id INTEGER NOT NULL REFERENCES users(id),
  opponent_id INTEGER REFERENCES users(id),
  duration_ms INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  accepted_at INTEGER,
  start_ts INTEGER,
  end_ts INTEGER,
  settled_at INTEGER,
  winner_handle TEXT,
  result_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_duels_challenger ON duels(challenger_id, created_at);
CREATE INDEX IF NOT EXISTS idx_duels_opponent ON duels(opponent_id, created_at);

-- Each side's window slice, recomputed whenever that player submits. Storing
-- it keeps a duel view from re-walking two lifetime chains per page load;
-- submitted_at is what decides whether the entry may settle the duel.
CREATE TABLE IF NOT EXISTS duel_entries (
  duel_id INTEGER NOT NULL REFERENCES duels(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  entry_json TEXT NOT NULL,
  submitted_at INTEGER NOT NULL,
  PRIMARY KEY (duel_id, user_id)
);

-- Clans. A clan owns no results: it is a name, a roster, and the join times
-- that bound what each member's chain contributes (core/clan.js).
CREATE TABLE IF NOT EXISTS clans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tag TEXT NOT NULL UNIQUE,           -- [TAG], 2-5 uppercase alphanumerics
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,      -- lowercase alphanumerics only, so
                                      -- "Trench Rats" and "trenchrats" collide
  motto TEXT,
  founder_id INTEGER NOT NULL REFERENCES users(id),
  join_code TEXT NOT NULL UNIQUE,     -- invite code; never in a public payload
  open INTEGER NOT NULL DEFAULT 0,    -- 1 = anyone signed in may join
  created_at INTEGER NOT NULL,
  -- Per-clan Discord webhook for the Friday Reckoning (B2). Set by the clan
  -- founder from the clan page; NULL = the clan has not opted in and the
  -- cron skips it silently. Never served by any public route — a webhook
  -- URL is a posting credential.
  reckoning_webhook TEXT
);

-- One clan per trader, enforced structurally: user_id is the whole primary
-- key. Membership cannot be split across two clans by any code path, including
-- a buggy one, because the row simply cannot exist twice.
--
-- joined_at is load-bearing, not bookkeeping: it is the left edge of every
-- window this member's fills are scored through, which is what stops a
-- lifetime record from being donated to a clan it was never earned in.
CREATE TABLE IF NOT EXISTS clan_members (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  clan_id INTEGER NOT NULL REFERENCES clans(id),
  joined_at INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' -- founder | member
);
CREATE INDEX IF NOT EXISTS idx_clan_members_clan ON clan_members(clan_id);

-- Derived, exactly like sprint_entries: each member's contribution slice,
-- recomputed whenever they submit or join, so a clan board is a read rather
-- than a walk over fifty lifetime chains. window_id is 'season' or an ISO week.
CREATE TABLE IF NOT EXISTS clan_entries (
  clan_id INTEGER NOT NULL REFERENCES clans(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  window_id TEXT NOT NULL,
  entry_json TEXT NOT NULL,           -- clan.memberEntry output
  score REAL NOT NULL,
  rounds INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (clan_id, user_id, window_id)
);
CREATE INDEX IF NOT EXISTS idx_clan_entries_window ON clan_entries(window_id, clan_id, score DESC);

-- ---------------------------------------------------------------------------
-- Read-path indexes.
--
-- D1 bills on rows_read, so a table scan is charged as well as slow, and the
-- boards are the whole traffic story. Each index below exists because
-- EXPLAIN QUERY PLAN showed a specific query scanning or building a temp
-- B-tree; server/test/queryplan.test.js asserts they stay used.

-- Leaderboard (WHERE status = 'verified' ORDER BY submitted_at DESC) and the
-- pricing cron (WHERE status = 'pending' ORDER BY submitted_at ASC) are the
-- same two columns in opposite directions, so one index serves both — SQLite
-- walks it backwards for the ascending case. The cron runs every 60 seconds
-- forever, which is what makes its plan worth an index on its own.
CREATE INDEX IF NOT EXISTS idx_records_status_submitted
  ON records(status, submitted_at DESC);

-- The activity feed's verification half. Partial, because the query only ever
-- asks for rows where verified_at IS NOT NULL and a pending record has no
-- business taking up space in this index.
CREATE INDEX IF NOT EXISTS idx_records_verified
  ON records(verified_at DESC) WHERE verified_at IS NOT NULL;

-- Every profile view and the clan kick lookup resolve a handle, both with
-- COLLATE NOCASE — which the index has to declare too, or it is not eligible.
CREATE INDEX IF NOT EXISTS idx_users_handle
  ON users(handle COLLATE NOCASE);

-- The activity feed's submission half: newest 40 across all users. The
-- existing idx_submissions_user leads with user_id, so it cannot serve a
-- global ordering.
CREATE INDEX IF NOT EXISTS idx_submissions_created
  ON submissions(created_at DESC);
-- ---------------------------------------------------------------------------

-- Fixed-window rate limiting (per user and per IP).
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);

-- Daily Spark (DELIGHT-MAP.md A2): one puzzle per UTC day. The memo pins
-- the day's mint + reveal moment so every player faces the SAME window all
-- day, even if upstream candle data drifts. The pick itself is
-- deterministic (core/spark.js); this row is belt-and-braces.
CREATE TABLE IF NOT EXISTS spark_days (
  day TEXT PRIMARY KEY,
  mint TEXT NOT NULL,
  t_ts INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- L-19: the day's PINNED chart. Written once at pin time (first /today hit),
-- read on every later /today and /grade. This is what makes the game
-- deterministic: every player all day sees the exact bars the first player
-- saw, even if upstream later loses or rewrites history. Serve-stale is the
-- design, not a fallback: the pinned window is the product.
CREATE TABLE IF NOT EXISTS spark_charts (
  day TEXT PRIMARY KEY,
  chart_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Cached, ingest-sanitized X posts per handle (lowercased). One row per
-- trader; the JSON is the already-clean output of worker/xfeed.js, never
-- upstream markup. Fresh for ~20 minutes, servable stale for days.
CREATE TABLE IF NOT EXISTS x_feed_cache (
  handle TEXT PRIMARY KEY,
  fetched_at INTEGER NOT NULL,
  posts_json TEXT NOT NULL
);

-- The Friday Reckoning (DELIGHT-MAP.md B2): one mark per (week, clan). The
-- mark IS the claim — written before the webhook POST fires, so a retried
-- cron firing can never double-post a clan's week. No digest content is
-- stored: the digest is re-derived from clan_entries every time.
CREATE TABLE IF NOT EXISTS reckoning_posts (
  week_id TEXT NOT NULL,
  clan_id INTEGER NOT NULL,
  posted_at INTEGER NOT NULL,
  PRIMARY KEY (week_id, clan_id)
);

-- Streamer applications (site/streamer-signup.html), replacing the Google
-- Form + published-sheet pipeline. Rows land as 'pending'; a moderator moves
-- them to 'approved' or 'rejected' from site/admin.html.
--
-- This is the one table in the schema holding contact details for people who
-- are not users — a Discord handle, maybe an email in contact_link, and when
-- they are reachable. Nothing here is served by a public route: the roster
-- endpoint selects only name/twitch_login/blurb from approved rows, and
-- everything else leaves D1 solely through the moderator-gated read.
CREATE TABLE IF NOT EXISTS streamer_applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,               -- creator / channel name, public once approved
  channel_url TEXT NOT NULL,        -- normalized https URL
  platform TEXT NOT NULL,           -- twitch | youtube | kick | other
  twitch_login TEXT,                -- embeddable login, Twitch URLs only
  discord TEXT NOT NULL,
  viewers TEXT NOT NULL,            -- one of the form's buckets, verbatim
  blurb TEXT,                       -- one-liner the applicant agreed to publish
  notes TEXT,                       -- private message to the mod queue; NEVER served publicly
  contact_method TEXT,
  contact_link TEXT,
  best_time TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  reviewed_by INTEGER,              -- users.id of the moderator who decided
  reviewed_at INTEGER,
  created_at INTEGER NOT NULL,
  ip_hash TEXT                      -- salted hash, for abuse triage only
);

-- The roster read is "approved rows, newest first"; the mod queue is the same
-- shape per status. One index serves both.
CREATE INDEX IF NOT EXISTS idx_streamer_applications_status
  ON streamer_applications(status, created_at DESC);

-- A channel may only sit in the queue once. Partial index so a rejected
-- applicant can reapply later, but nobody can flood the queue with one URL.
CREATE UNIQUE INDEX IF NOT EXISTS idx_streamer_applications_open_channel
  ON streamer_applications(channel_url)
  WHERE status IN ('pending', 'approved');

-- ---------------------------------------------------------------- moderation
--
-- Two reversible switches and a ledger. Deliberately NOT a deletion tool: a
-- moderator needs to stop a bad record counting, and needs it undoable, but
-- nothing here removes a user's data or rewrites their chain.
--
-- The switches live as COLUMNS on users and records (added by the ALTERs in
-- DEPLOY.md, since this file is re-run against live databases and ADD COLUMN
-- is not idempotent):
--
--   users.banned_at / banned_reason / banned_by
--       the ACCOUNT is closed — sign-in refused, record off every board.
--   records.dq_at / dq_reason / dq_by
--       the RECORD does not rank, but the account is fine. For a chain that
--       is wrong rather than a person who is a problem.
--   clans.disbanded_at / disbanded_reason
--       the clan stops appearing; the roster stays readable.
--
-- Keeping ban and disqualify separate matters: collapsing them would force a
-- moderator to ban somebody in order to take a bad chain off the board, which
-- is a much bigger statement than the situation usually deserves.
--
-- The ledger is a real table, so it is created here.
CREATE TABLE IF NOT EXISTS moderation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER NOT NULL REFERENCES users(id),  -- the moderator
  action TEXT NOT NULL,             -- user.ban | user.unban | record.disqualify
                                    -- record.reinstate | clan.disband | clan.restore
  target_kind TEXT NOT NULL,        -- user | record | clan
  target_id INTEGER NOT NULL,
  target_label TEXT,                -- handle or [TAG] at the time, for reading
  reason TEXT NOT NULL,             -- mandatory at the route; never empty here
  created_at INTEGER NOT NULL
);

-- A moderation tool without a ledger is an invitation to argue about what
-- happened; with one, "who took this off the board and why" is a query.
CREATE INDEX IF NOT EXISTS idx_moderation_log_recent
  ON moderation_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_moderation_log_target
  ON moderation_log(target_kind, target_id, created_at DESC);
