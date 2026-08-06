-- PaperTrench leaderboard server — D1 (SQLite) schema.
-- Apply with: wrangler d1 execute papertrench --file=schema.sql

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  x_id TEXT NOT NULL UNIQUE,          -- immutable X user id; handles can change
  handle TEXT NOT NULL,               -- current @handle, refreshed on login
  display_name TEXT,
  avatar_url TEXT,
  session_epoch INTEGER NOT NULL DEFAULT 0,  -- bump to revoke all sessions
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

-- Clans. A clan holds a name, a policy and a founder — never a result. The
-- tag and name are immutable after creation (a clan that can rename itself can
-- collect a roster under one identity and become another), which is why
-- name_key exists: the folded, confusable-insensitive form that UNIQUE is
-- actually taken against.
CREATE TABLE IF NOT EXISTS clans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tag TEXT NOT NULL UNIQUE,           -- 2-5 chars, A-Z0-9, immutable
  name TEXT NOT NULL,                 -- display name, immutable
  name_key TEXT NOT NULL UNIQUE,      -- clan.nameKey(name); impersonation guard
  motto TEXT,                         -- founder-editable
  founder_id INTEGER NOT NULL REFERENCES users(id),
  join_code TEXT NOT NULL UNIQUE,     -- only ever served to a member
  open INTEGER NOT NULL DEFAULT 0,    -- 1 = anyone may join without the code
  created_at INTEGER NOT NULL
);

-- One clan per trader, enforced by the primary key rather than by a check the
-- next handler has to remember. joined_at is the only new fact a clan
-- introduces: it BOUNDS what an existing chain contributes (core/clan.js).
CREATE TABLE IF NOT EXISTS clan_members (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  clan_id INTEGER NOT NULL REFERENCES clans(id),
  joined_at INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' -- founder | member
);
CREATE INDEX IF NOT EXISTS idx_clan_members_clan ON clan_members(clan_id, joined_at);

-- A member's contribution slice per window, recomputed on submission and on
-- join. Same trade the sprint and duel entries make: a clan board is a read,
-- not a walk over fifty lifetime chains. window_id is an ISO week id or
-- 'season'. A member who was not in the clan for any of a window has NO ROW
-- here — a zeroed row would claim they were present and idle.
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
CREATE INDEX IF NOT EXISTS idx_clan_entries_window ON clan_entries(window_id, clan_id);

-- Fixed-window rate limiting (per user and per IP).
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
