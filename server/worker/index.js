/* PaperTrench leaderboard server — Cloudflare Worker entry.
 *
 * Thin adapter over the pure core (server/core): routing, CORS, sessions,
 * D1 persistence, edge caching, rate limits, and the pricing cron. Anything
 * that decides WHETHER a record is honest lives in core/ and runs identically
 * under `node --test`; this file only decides WHERE bytes go.
 *
 * Read traffic is the scale story: board and profile responses carry
 * s-maxage and are served from Cloudflare's edge cache, so ten users and ten
 * million cost about the same. Writes (submissions) are rate-limited and the
 * heavy half (re-pricing against market history) drains through the cron
 * under an external-API budget.
 */
import { fastChecks, priceRecord } from '../core/submission.js';
import { windowOf, sprintEntry } from '../core/sprint.js';
import { windowEntry } from '../core/window.js';
import { awarded } from '../core/achievements.js';
import * as duel from '../core/duel.js';
import * as clan from '../core/clan.js';
import * as streamer from '../core/streamer.js';
// Default-imported, not named: core/chain.js re-exports attest.js by property
// assignment (`GENESIS: AT.GENESIS`), which Node's CJS named-export lexer
// cannot see through — unlike the other cores, whose exports are literals.
import chainCore from '../core/chain.js';
import { sessionUser, startLogin, finishLogin, logout } from './auth.js';
import { makeGetCandles } from './candles.js';
import * as indeix from './indeix.js';
import * as replay from '../core/replay.js';
// Default-imported for the same CJS-lexer reason as core/chain.js above.
import xfeed from './xfeed.js';

const SEG_SIZE = 500;
const SUBMITS_PER_HOUR = 6;
const DUELS_PER_HOUR = 10;
const CLAN_ACTIONS_PER_HOUR = 12;
// Streamer signups need no account, so the leash is per-IP and deliberately
// low: a person applies once, and the only reason to send six is abuse.
const STREAMER_APPLIES_PER_HOUR = 5;
// The X feed endpoint: only cache MISSES cost an upstream fetch, so the
// per-IP leash sits on those, not on reads a cache can answer.
const XFEED_PER_HOUR = 120;
const XFEED_FRESH_MS = 20 * 60 * 1000;
const XFEED_STALE_MS = 7 * 24 * 3600 * 1000;
/** window_id for a clan's since-join season slice, alongside ISO week ids. */
const SEASON_WINDOW_ID = 'season';
const CANDLE_BUDGET_PER_RUN = 25;
// How long a record that made no pricing progress steps aside for.
const PRICING_BACKOFF_MS = 5 * 60 * 1000;
const BOARD_CACHE_SEC = 60;
const MAX_BODY_BYTES = 32 * 1024 * 1024;

/* ---------------- plumbing ---------------- */

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = [env.SITE_ORIGIN, env.SITE_ORIGIN_ALT].filter(Boolean);
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    // Authorization: the bearer-token session transport (auth.js) — without
    // it here the preflight rejects the header and every token-carrying
    // request dies before it leaves the browser.
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    Vary: 'Origin',
  };
  if (allowed.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
  }
  return headers;
}

/**
 * Every state-changing request must come from a page we ship.
 *
 * With a same-site deploy, SameSite=Lax already blocks cross-site POSTs. With
 * a workers.dev deploy the session cookie has to be SameSite=None, so the
 * browser WILL attach it to a cross-site POST and this check becomes the only
 * thing standing between a random page and a submission made in the visitor's
 * name. Enforced for both topologies rather than the one that needs it —
 * a guard that only exists in one configuration is a guard nobody remembers
 * when the configuration changes.
 */
function requireOrigin(request, env) {
  const origin = request.headers.get('Origin') || '';
  const allowed = [env.SITE_ORIGIN, env.SITE_ORIGIN_ALT].filter(Boolean);
  return allowed.includes(origin);
}

function json(data, status, extra) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json' }, extra || {}),
  });
}

/**
 * Fixed-window rate limit in D1. Returns true when the call is allowed.
 *
 * One statement, deliberately. The read-then-write version this replaces was a
 * check-then-act race: N requests fired together all read the same count,
 * all saw it under the cap, and all proceeded — which turns a 6/hour
 * submission limit into "6 per hour, or as many as you can open sockets for",
 * and the limit matters most exactly when someone is trying hard. The upsert
 * increments and reports the new count atomically, so the Nth caller sees N.
 */
async function allowRate(env, key, perHour) {
  const windowStart = Math.floor(Date.now() / 3600000) * 3600000;
  const row = await env.DB.prepare(`
    INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
    ON CONFLICT(key) DO UPDATE SET
      count = CASE WHEN rate_limits.window_start = excluded.window_start
                   THEN rate_limits.count + 1 ELSE 1 END,
      window_start = excluded.window_start
    RETURNING count`)
    .bind(key, windowStart).first();
  if (!row) {
    // RETURNING is the whole mechanism; without a row there is no count to
    // judge. Fail open rather than locking everyone out of a working API, but
    // say so — a rate limit that has quietly stopped limiting must not be
    // indistinguishable from one nobody is hitting.
    console.error('allowRate got no row back for', key, '— limit not enforced this call');
    return true;
  }
  return Number(row.count) <= perHour;
}

/**
 * A canonical cache key for a parameterised read.
 *
 * The Cache API keys on the request URL verbatim, so any route whose handler
 * normalizes its parameter must hand the cache the NORMALIZED spelling or it
 * stores one entry per spelling of the same answer.
 */
function cacheKey(url, params) {
  const canonical = new URL(url.pathname, url.origin);
  for (const [key, value] of Object.entries(params)) canonical.searchParams.set(key, value);
  return new Request(canonical.toString(), { method: 'GET' });
}

/** Serve a GET from the edge cache, computing + caching on miss. */
async function edgeCached(request, ctx, ttlSec, compute) {
  const cache = caches.default;
  const hit = await cache.match(request);
  // A Response handed back by the Cache API has IMMUTABLE headers, and the
  // caller applies CORS headers to whatever this returns. Returning the cached
  // object directly therefore threw on every cache hit — the first request
  // after a deploy succeeded (a miss) and the next sixty seconds of requests
  // died as Worker error 1101, which is exactly the shape that survives a
  // smoke test run against a cold cache. Hand back a mutable copy.
  if (hit) return new Response(hit.body, hit);
  const response = await compute();
  if (response.status === 200) {
    const cacheable = new Response(response.clone().body, response);
    cacheable.headers.set('Cache-Control', `public, max-age=30, s-maxage=${ttlSec}`);
    ctx.waitUntil(cache.put(request, cacheable.clone()));
    return cacheable;
  }
  return response;
}

/* ---------------- chain storage ---------------- */

/** The statements that replace a user's stored chain. Returned rather than
 * run so handleSubmit can put them in the same transaction as everything
 * else the submission changes (DEFECT L-07). */
function chainStatements(env, userId, chain) {
  const statements = [
    env.DB.prepare('DELETE FROM chain_segments WHERE user_id = ?').bind(userId),
  ];
  for (let i = 0; i < chain.length; i += SEG_SIZE) {
    statements.push(env.DB.prepare(
      'INSERT INTO chain_segments (user_id, seg_no, links_json) VALUES (?, ?, ?)')
      .bind(userId, Math.floor(i / SEG_SIZE), JSON.stringify(chain.slice(i, i + SEG_SIZE))));
  }
  return statements;
}

async function loadChain(env, userId) {
  const rows = await env.DB.prepare(
    'SELECT links_json FROM chain_segments WHERE user_id = ? ORDER BY seg_no')
    .bind(userId).all();
  const chain = [];
  for (const row of rows.results) chain.push(...JSON.parse(row.links_json));
  return chain;
}

/* ---------------- routes ---------------- */

async function handleSubmit(request, env) {
  const user = await sessionUser(request, env);
  if (!user) return json({ ok: false, reason: 'not-signed-in' }, 401);
  if (!(await allowRate(env, 'submit:' + user.id, SUBMITS_PER_HOUR))) {
    return json({ ok: false, reason: 'rate-limited' }, 429);
  }
  // Refuse on the DECLARED size before buffering. Checking after
  // `request.text()` meant a 32 MB body was read into the isolate in full in
  // order to be told it was too big: the rejection was correct, it was just
  // paid for first. Six of those an hour per account is the rate limit's
  // allowance, so the cost was bounded but never necessary.
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return json({ ok: false, reason: 'too-large' }, 413);
  }
  const raw = await request.text();
  // Backstop for a chunked body that declared no length.
  if (raw.length > MAX_BODY_BYTES) return json({ ok: false, reason: 'too-large' }, 413);
  let payload;
  try { payload = JSON.parse(raw); } catch { return json({ ok: false, reason: 'bad-json' }, 400); }

  const previousRow = await env.DB.prepare(
    `SELECT head, chain_len, starting_sol, status, stats_json
     FROM records WHERE user_id = ?`).bind(user.id).first();
  const previous = previousRow
    ? { head: previousRow.head, chainLen: previousRow.chain_len,
        startingSol: previousRow.starting_sol }
    : null;

  const result = await fastChecks(payload, previous);
  const now = Date.now();

  // An exact resubmission — same head, same length — of the chain already on
  // file. Detected BEFORE any write (DEFECT L-04): the old path treated it as
  // a fresh submission, resetting a 'verified' record to 'pending' and
  // throwing away every pricing verdict already earned, so double-clicking
  // the sync button knocked a player off the board for hours while the cron
  // re-derived what it already knew. Verification state is content-addressed
  // by (head, length); the same content keeps its verdict.
  const duplicate = !!(result.accepted && previousRow &&
    previousRow.head === payload.head &&
    previousRow.chain_len === payload.chain.length);

  await env.DB.prepare(
    'INSERT INTO submissions (user_id, head, chain_len, outcome, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(user.id, String(payload && payload.head || ''),
      payload && Array.isArray(payload.chain) ? payload.chain.length : 0,
      result.accepted ? (duplicate ? 'duplicate' : 'accepted') : result.reason, now)
    .run();
  if (!result.accepted) {
    return json({ ok: false, reason: result.reason, problems: result.problems || [] }, 422);
  }
  if (duplicate) {
    return json({
      ok: true,
      status: previousRow.status,
      duplicate: true,
      note: 'this exact chain is already on file; verification state unchanged',
      stats: previousRow.stats_json ? JSON.parse(previousRow.stats_json) : result.stats,
      claimMismatch: result.claimMismatch,
    });
  }

  const start = Number(payload.claim.startingBalanceSol);
  // Badges are chain-derived, so they are computed here rather than on every
  // profile view. The verification-dependent one ('unbroken') can only be
  // earned once re-pricing finishes, so this runs again at that point.
  const badges = awarded({
    chain: payload.chain, startingSol: start, chainLen: payload.chain.length,
    pricingStatus: 'pending', coverage: 0,
  });

  // EVERYTHING a submission changes — chain segments, the record row, the
  // sprint slice, duel slices, clan slices — commits in one transaction
  // (DEFECT L-07). These used to be five separate awaits, so an eviction or
  // error between any two left the store split-brained: segments holding a
  // chain the record row did not describe, or a record whose sprint entry
  // was computed from the PREVIOUS chain. D1's batch is transactional; if
  // any statement fails, none of them happened, and the client gets a clean
  // 500 to retry rather than a half-written identity.
  const statements = chainStatements(env, user.id, payload.chain);
  statements.push(env.DB.prepare(`
    INSERT INTO records (user_id, head, chain_len, starting_sol, status, claim_mismatch,
                         stats_json, badges_json, pricing_json, pricing_progress_json,
                         submitted_at, verified_at)
    VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, NULL, NULL, ?, NULL)
    ON CONFLICT(user_id) DO UPDATE SET
      head = excluded.head, chain_len = excluded.chain_len,
      starting_sol = excluded.starting_sol, status = 'pending',
      claim_mismatch = excluded.claim_mismatch, stats_json = excluded.stats_json,
      badges_json = excluded.badges_json,
      pricing_json = NULL, pricing_progress_json = NULL,
      submitted_at = excluded.submitted_at, verified_at = NULL`)
    .bind(user.id, payload.head, payload.chain.length, start,
      result.claimMismatch ? 1 : 0, JSON.stringify(result.stats),
      JSON.stringify(badges), now));

  // Sprint entry for the current window, derived from the same chain.
  const window = windowOf(now);
  const entry = sprintEntry(payload.chain, start, window);
  statements.push(env.DB.prepare(`
    INSERT INTO sprint_entries (week_id, user_id, entry_json, score, rounds, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(week_id, user_id) DO UPDATE SET
      entry_json = excluded.entry_json, score = excluded.score,
      rounds = excluded.rounds, updated_at = excluded.updated_at`)
    .bind(window.weekId, user.id, JSON.stringify(entry), entry.score, entry.rounds, now));

  // Refresh this player's slice of every duel they are in whose window has not
  // been settled. Computing it here — once per submission — is what keeps a
  // duel page from re-walking two lifetime chains on every view. `submitted_at`
  // rides along because it, not the entry, decides whether this may settle.
  const duels = await env.DB.prepare(`
    SELECT id, start_ts, end_ts FROM duels
    WHERE settled_at IS NULL AND accepted_at IS NOT NULL
      AND (challenger_id = ? OR opponent_id = ?)`).bind(user.id, user.id).all();
  for (const duel of duels.results) {
    const duelEntry = windowEntry(payload.chain, start,
      { startTs: duel.start_ts, endTs: duel.end_ts });
    statements.push(env.DB.prepare(`
      INSERT INTO duel_entries (duel_id, user_id, entry_json, submitted_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(duel_id, user_id) DO UPDATE SET
        entry_json = excluded.entry_json, submitted_at = excluded.submitted_at`)
      .bind(duel.id, user.id, JSON.stringify(duelEntry), now));
  }

  // And this player's clan slices, if they are in one. Same reason as the duel
  // refresh above: computed once per submission so a clan board is a read.
  statements.push(...await clanEntryStatements(env, user.id, payload.chain, start, now));

  await env.DB.batch(statements);

  return json({
    ok: true,
    status: 'pending',
    note: 'chain verified and replayed; prices now re-checking against market history',
    stats: result.stats,
    claimMismatch: result.claimMismatch,
    sprint: entry,
  });
}

/**
 * Which attestation versions this DEPLOYMENT can verify — proven, not declared.
 *
 * Exists because of a real ordering hazard: `core/chain.js` re-exports
 * `attest.js`, so a worker running older logic rebuilds a newer link's
 * preimage under the old rules and rejects it as `hash-mismatch`. The worker
 * must therefore always be deployed BEFORE an extension release that bumps the
 * format — and until this route existed, "is the new worker actually live?"
 * could only be answered by the person who ran the deploy saying so, or by
 * submitting a real chain, which is a write to production.
 *
 * It builds a synthetic link at each version and re-verifies it here, so the
 * answer is behaviour rather than a constant a stale build would also report.
 * `writes` comes from appendFill rather than a hardcoded number, so this
 * cannot drift when the format bumps again.
 *
 * Bounded at `writes` on purpose: the preimage builder treats any unknown
 * version as the newest rules, so probing v99 would "pass" by tautology and
 * advertise support for a format nobody has defined.
 */
async function attestSupport() {
  const { GENESIS, sha256, fillPreimage, appendFill, verifyChain } = chainCore;
  const probe = {
    id: 'version-probe', sessionId: 'version-probe', mint: 'PROBE', side: 'buy',
    qty: 1, priceNative: 1, solGross: 1, solNet: 1, ts: 0, chain: 'solana',
  };
  let writes = 0;
  try { writes = Number((await appendFill(GENESIS, probe)).version) || 0; } catch {}

  const verifies = [];
  for (let version = 1; version <= writes; version++) {
    try {
      const link = { ...probe, version, prev: GENESIS, seq: 0 };
      link.hash = await sha256(fillPreimage(link, GENESIS));
      if ((await verifyChain([link])).valid) verifies.push(version);
    } catch { /* a version this build cannot round-trip is simply not claimed */ }
  }
  return { ok: true, attest: { writes, verifies } };
}

async function handleLeaderboard(env) {
  const rows = await env.DB.prepare(`
    SELECT u.handle, u.display_name, u.avatar_url,
           r.status, r.stats_json, r.badges_json, r.chain_len,
           r.verified_at, r.submitted_at,
           cl.tag AS clan_tag, cl.name AS clan_name
    FROM records r JOIN users u ON u.id = r.user_id
    LEFT JOIN clan_members cm ON cm.user_id = r.user_id
    LEFT JOIN clans cl ON cl.id = cm.clan_id
    -- ONLY verified records rank.
    --
    -- attest.js is open source, so a determined user can fabricate fills AND
    -- compute valid hashes for them; the chain check cannot tell that apart
    -- from an honest record. Re-pricing against real market history is what
    -- actually catches it — but a fill whose mint has no public candle data
    -- comes back 'no-data', not 'implausible', so a chain built entirely from
    -- unlisted mints lands at 'partial' with nothing disproved.
    --
    -- Ranking anything below 'verified' therefore ranks the one class of
    -- record we could not check, which is exactly the class a fabricator
    -- would choose. Unverified records still appear on their own profile,
    -- labeled — they simply do not take a position on the board.
    WHERE r.status = 'verified'
      AND json_extract(r.stats_json, '$.rankable')
      -- Moderation, applied where the ranking happens rather than in the page.
      -- A banned account and a disqualified record both stop counting here, so
      -- there is no board, cache or export that can still be showing them.
      --
      -- These columns are added by the ALTERs in DEPLOY.md, which must be run
      -- BEFORE this version of the Worker is deployed: SQLite fails a query
      -- naming a column that does not exist, so a deploy that runs ahead of
      -- the migration takes the board down rather than degrading. COALESCE
      -- here is about the NULL that means "never actioned", nothing else.
      AND COALESCE(u.banned_at, 0) = 0
      AND COALESCE(r.dq_at, 0) = 0
    -- The ORDER decides WHO makes the cut, so it must be the ranking order
    -- (DEFECT L-05): the old ORDER BY submitted_at DESC LIMIT 500 selected
    -- the five hundred most RECENT records and only then sorted by score —
    -- meaning entrant #501 silently pushed the season's best score off the
    -- board if it had not resubmitted lately. Ties break by verified_at
    -- (first to prove the score keeps the rank — a later submitter cannot
    -- displace them by equalling them), then handle, so two reads of the
    -- board never disagree about order.
    ORDER BY json_extract(r.stats_json, '$.score') DESC,
             r.verified_at ASC, u.handle ASC
    LIMIT 500`).all();
  const entries = rows.results
    .map((row) => {
      const stats = JSON.parse(row.stats_json);
      const badges = row.badges_json ? JSON.parse(row.badges_json) : [];
      return {
        handle: row.handle,
        displayName: row.display_name,
        avatarUrl: row.avatar_url,
        status: row.status,
        chainLen: row.chain_len,
        verifiedAt: row.verified_at,
        clanTag: row.clan_tag || null,
        clanName: row.clan_name || null,
        stats,
        // Only the ids and tiers ride on the board; full evidence lives on
        // the profile, where there is room to show why each was earned.
        badges: badges.map((b) => ({ id: b.id, name: b.name, tier: b.tier.name })),
      };
    })
    .filter((e) => e.stats.rankable)
    .sort((a, b) =>
      (b.stats.score - a.stats.score) ||
      ((a.verifiedAt || 0) - (b.verifiedAt || 0)) ||
      String(a.handle).localeCompare(String(b.handle)));
  return json({ board: 'global', entries });
}

async function handleSprint(env) {
  const window = windowOf(Date.now());
  const rows = await env.DB.prepare(`
    SELECT u.handle, u.display_name, u.avatar_url, r.status, s.entry_json,
           cl.tag AS clan_tag
    FROM sprint_entries s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN records r ON r.user_id = s.user_id
    LEFT JOIN clan_members cm ON cm.user_id = s.user_id
    LEFT JOIN clans cl ON cl.id = cm.clan_id
    -- Same rule as the season board: a week's slice of an unverified record
    -- is still an unverified record.
    -- ...and a banned account or disqualified record is off this board too,
    -- or a moderator would have to remember that the Sprint is a second place
    -- the same name can still be showing.
    WHERE s.week_id = ? AND s.rounds > 0 AND r.status = 'verified'
      AND COALESCE(u.banned_at, 0) = 0
      AND COALESCE(r.dq_at, 0) = 0
    -- Deterministic ties, same doctrine as the season board (DEFECT L-05):
    -- the earlier entry keeps the rank, then handle as the fixed final key.
    ORDER BY s.score DESC, s.updated_at ASC, u.handle ASC LIMIT 200`)
    .bind(window.weekId).all();
  return json({
    weekId: window.weekId,
    startTs: window.startTs,
    endTs: window.endTs,
    entries: rows.results.map((row) => ({
      handle: row.handle,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      status: row.status || 'pending',
      clanTag: row.clan_tag || null,
      entry: JSON.parse(row.entry_json),
    })),
  });
}

async function handleProfile(env, handle) {
  const user = await env.DB.prepare(
    'SELECT id, handle, display_name, avatar_url, created_at FROM users WHERE handle = ? COLLATE NOCASE')
    .bind(handle).first();
  if (!user) return json({ ok: false, reason: 'not-found' }, 404);
  const record = await env.DB.prepare(
    `SELECT head, chain_len, starting_sol, status, claim_mismatch, stats_json,
            badges_json, pricing_json, submitted_at, verified_at
     FROM records WHERE user_id = ?`)
    .bind(user.id).first();
  const sprints = await env.DB.prepare(
    'SELECT week_id, entry_json FROM sprint_entries WHERE user_id = ? ORDER BY week_id DESC LIMIT 12')
    .bind(user.id).all();
  // Their clan, and what they have actually contributed to it since joining —
  // which is a different number from their record above, and says so.
  const clanRow = await env.DB.prepare(`
    SELECT c.tag, c.name, m.joined_at, m.role, e.entry_json
    FROM clan_members m
    JOIN clans c ON c.id = m.clan_id
    LEFT JOIN clan_entries e ON e.clan_id = m.clan_id AND e.user_id = m.user_id
                            AND e.window_id = ?
    WHERE m.user_id = ?`).bind(SEASON_WINDOW_ID, user.id).first();
  return json({
    handle: user.handle,
    displayName: user.display_name,
    avatarUrl: user.avatar_url,
    joinedAt: user.created_at,
    clan: clanRow ? {
      tag: clanRow.tag,
      name: clanRow.name,
      role: clanRow.role,
      joinedAt: clanRow.joined_at,
      contribution: clanRow.entry_json ? JSON.parse(clanRow.entry_json) : null,
    } : null,
    record: record ? {
      head: record.head,
      chainLen: record.chain_len,
      startingSol: record.starting_sol,
      status: record.status,
      claimMismatch: !!record.claim_mismatch,
      stats: JSON.parse(record.stats_json),
      badges: record.badges_json ? JSON.parse(record.badges_json) : [],
      pricing: record.pricing_json ? JSON.parse(record.pricing_json) : null,
      submittedAt: record.submitted_at,
      verifiedAt: record.verified_at,
    } : null,
    sprints: sprints.results.map((row) => ({ weekId: row.week_id, entry: JSON.parse(row.entry_json) })),
  });
}

/* ---------------- activity feed ----------------
 *
 * The verifier's real work, streamed to the site: chains accepted, records
 * verified, submissions rejected. It exists because "we check everything" is
 * a claim, and watching the checks happen is evidence.
 *
 * One deliberate asymmetry: POSITIVE events carry the handle (those users
 * chose a public board), REJECTIONS never do. An automated verdict — which can
 * fire on thin candle data as easily as on fraud — must not publicly brand a
 * named person a cheat. The event and its reason are shown; the name is not.
 */
// How long a red verdict stays on the PUBLIC feed (DEFECT L-13). A rejection
// is operational evidence, not a trophy: on a quiet board, week-old REJECTED
// lines under a "LIVE" badge read as a product on fire, indefinitely. Fresh
// verdicts stream for three days — plenty for "watch the checks happen" — and
// then age out like any log line. Green events are achievements and persist.
const FEED_REJECTION_WINDOW_MS = 72 * 3600 * 1000;

async function handleActivity(env) {
  const redCutoff = Date.now() - FEED_REJECTION_WINDOW_MS;
  const [subs, verifications] = await Promise.all([
    // 'shape:unknown-version' is quarantined from the PUBLIC feed (DEFECT
    // L-12): for five days that reason was our own gate bug (L-01) firing on
    // every honest v3.4.0 export, and the feed rebroadcast all 54 of those
    // server-side failures as an anonymous wall of "REJECTED" — which reads
    // as either mass fraud or a broken product, and buried every real event
    // past the 40-row window. The rows stay in D1 as the audit trail, and a
    // submitter who trips the gate still gets the full reason in their 422;
    // it just isn't broadcast as a verdict about a trader. Real verdicts
    // (chain-invalid, chain-replaced, …) still stream — for the L-13 window.
    env.DB.prepare(`
      SELECT s.outcome, s.head, s.chain_len, s.created_at, u.handle
      FROM submissions s JOIN users u ON u.id = s.user_id
      WHERE s.outcome NOT IN ('duplicate', 'shape:unknown-version')
        AND (s.outcome = 'accepted' OR s.created_at > ?)
      ORDER BY s.created_at DESC LIMIT 40`).bind(redCutoff).all(),
    env.DB.prepare(`
      SELECT u.handle, r.status, r.chain_len, r.pricing_json, r.verified_at
      FROM records r JOIN users u ON u.id = r.user_id
      WHERE r.verified_at IS NOT NULL
        AND (r.status = 'verified' OR r.verified_at > ?)
      ORDER BY r.verified_at DESC LIMIT 25`).bind(redCutoff).all(),
  ]);

  const events = [];
  // One accepted line per distinct chain: before L-04, every resubmission of
  // the same head logged its own 'accepted' row, and nine copies of the same
  // green line are feed spam of a friendlier color. Rows arrive newest-first,
  // so the survivor is the most recent.
  const seenAccepted = new Set();
  for (const row of subs.results) {
    // A duplicate is a no-op, not a verdict — showing it as an anonymous
    // "rejection" would report an impatient double-click as suspected fraud.
    // Every SQL filter above is enforced here as well, so the behavior holds
    // even if the two layers ever drift apart.
    if (row.outcome === 'duplicate') continue;
    if (row.outcome === 'shape:unknown-version') continue;
    const accepted = row.outcome === 'accepted';
    if (!accepted && row.created_at <= redCutoff) continue;
    if (accepted) {
      const key = row.handle + '|' + row.head;
      if (seenAccepted.has(key)) continue;
      seenAccepted.add(key);
    }
    events.push({
      kind: accepted ? 'accepted' : 'rejected',
      // Rejections are anonymous on purpose — see the note above.
      handle: accepted ? row.handle : null,
      detail: accepted ? `chain of ${row.chain_len} links re-hashed, book replayed` : row.outcome,
      ts: row.created_at,
    });
  }
  for (const row of verifications.results) {
    if (row.status !== 'verified' && row.verified_at <= redCutoff) continue;
    const pricing = row.pricing_json ? JSON.parse(row.pricing_json) : null;
    events.push({
      kind: row.status === 'verified' ? 'verified' : row.status,
      handle: row.status === 'rejected' ? null : row.handle,
      detail: pricing
        ? `${pricing.counts.ok} fills re-priced against market history` +
          (pricing.counts.noData ? ` · ${pricing.counts.noData} without public candle data` : '')
        : 'verification complete',
      ts: row.verified_at,
    });
  }
  events.sort((a, b) => b.ts - a.ts);
  return json({ events: events.slice(0, 40) });
}

/* ---------------- X feed ----------------
 *
 * A trader's recent public posts, served to EVERY visitor. X's own widgets
 * are login-walled and adblocked client-side, so the worker fetches X's
 * syndication timeline once, sanitizes it at ingest (xfeed.js — plain text,
 * ids, timestamps, pbs.twimg.com media only), and caches it in D1. A stale
 * feed beats a hole; a hole beats an invented one.
 */
/** The user-token layer: the trader's own OAuth pair (sealed in D1 at login)
 *  reads their own timeline through API v2. Returns posts, or null when this
 *  user has no usable tokens — never throws, never lets a token escape. */
async function tokenPosts(env, user) {
  if (!user.x_tokens) return null;
  let tokens = await xfeed.openTokens(env.SESSION_SECRET, user.x_tokens);
  if (!tokens || !tokens.access) return null;
  const keep = async (next) => {
    tokens = next;
    await env.DB.prepare('UPDATE users SET x_tokens = ? WHERE id = ?')
      .bind(await xfeed.sealTokens(env.SESSION_SECRET, next), user.id).run();
  };
  try {
    if (tokens.exp && tokens.exp < Date.now() + 60000) {
      if (!tokens.refresh) return null;
      await keep(await xfeed.refreshAccess(env.X_CLIENT_ID, tokens.refresh));
    }
    try {
      return await xfeed.fetchUserTweets(user.x_id, tokens.access);
    } catch (error) {
      // One refresh-and-retry on a 401: the expiry stamp can lie (revoked
      // early, clock skew), the refresh token is the ground truth.
      if (!/ 401$/.test(String(error && error.message)) || !tokens.refresh) throw error;
      await keep(await xfeed.refreshAccess(env.X_CLIENT_ID, tokens.refresh));
      return await xfeed.fetchUserTweets(user.x_id, tokens.access);
    }
  } catch {
    return null;
  }
}

async function handleXFeed(request, env) {
  const url = new URL(request.url);
  const asked = String(url.searchParams.get('handle') || '').trim().replace(/^@+/, '');
  if (!xfeed.HANDLE_RE.test(asked)) return json({ ok: false, reason: 'bad-handle' }, 400);

  // Not an open proxy: only handles with an account HERE are ever asked
  // upstream, and the row's casing — X's casing — is the one echoed back.
  // x_tokens stays inside this handler; nothing below ever serializes it.
  const user = await env.DB.prepare(
    'SELECT id, x_id, handle, x_tokens FROM users WHERE handle = ? COLLATE NOCASE')
    .bind(asked).first();
  if (!user) return json({ ok: false, reason: 'unknown-handle' }, 404);
  const handle = user.handle;
  const cacheKey = handle.toLowerCase();

  const cached = await env.DB.prepare(
    'SELECT fetched_at, posts_json FROM x_feed_cache WHERE handle = ?').bind(cacheKey).first();
  const now = Date.now();
  const answer = (posts, fetchedAt) => json({ ok: true, handle, posts, fetchedAt });

  if (cached && now - Number(cached.fetched_at) < XFEED_FRESH_MS) {
    return answer(JSON.parse(cached.posts_json), Number(cached.fetched_at));
  }

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (!(await allowRate(env, 'xfeed:' + ip, XFEED_PER_HOUR))) {
    // Over the leash a stale answer still beats a refusal — the limit exists
    // to protect the upstream fetches, and serving the cache costs them nothing.
    if (cached) return answer(JSON.parse(cached.posts_json), Number(cached.fetched_at));
    return json({ ok: false, reason: 'rate-limited' }, 429);
  }

  // Layered cheapest-first. Syndication (free widget feed) → the logged-out
  // web page (free, reaches the syndication-invisible like @naskvr) → the
  // user's own token (last resort). A layer that throws or comes back empty
  // falls through to the next; only what a source actually produced is
  // cached, and only produced results beat a stale cache.
  let posts = null;
  const tryLayer = async (fn) => {
    if (posts && posts.length) return;
    try {
      const got = await fn();
      if (got && (got.length > 0 || posts === null)) posts = got;
    } catch { /* fall through to the next source */ }
  };
  await tryLayer(() => xfeed.fetchPosts(handle));
  await tryLayer(() => xfeed.fetchPublicPosts(handle));
  await tryLayer(() => tokenPosts(env, user));

  if (posts) {
    await env.DB.prepare(`
      INSERT INTO x_feed_cache (handle, fetched_at, posts_json) VALUES (?, ?, ?)
      ON CONFLICT(handle) DO UPDATE SET
        fetched_at = excluded.fetched_at, posts_json = excluded.posts_json`)
      .bind(cacheKey, now, JSON.stringify(posts)).run();
    return answer(posts, now);
  }
  if (cached && now - Number(cached.fetched_at) < XFEED_STALE_MS) {
    return answer(JSON.parse(cached.posts_json), Number(cached.fetched_at));
  }
  // No source and no cache: an empty list, which the site renders as the
  // presence card alone. Not an error — there is nothing wrong to report,
  // only nothing to show.
  return answer([], null);
}

/* ---------------- duels ---------------- */

// Unambiguous alphabet: no O/0/I/1, because these codes get read aloud on
// streams and retyped from screenshots.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function duelCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let code = '';
  for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return 'TRENCH-' + code;
}

/** A duel row plus both players, in the shape core/duel.js consumes. */
async function loadDuel(env, code) {
  const row = await env.DB.prepare(`
    SELECT d.*, c.handle AS c_handle, o.handle AS o_handle,
           cr.status AS c_status, orr.status AS o_status,
           ce.entry_json AS c_entry, ce.submitted_at AS c_submitted,
           oe.entry_json AS o_entry, oe.submitted_at AS o_submitted
    FROM duels d
    JOIN users c ON c.id = d.challenger_id
    LEFT JOIN users o ON o.id = d.opponent_id
    LEFT JOIN records cr ON cr.user_id = d.challenger_id
    LEFT JOIN records orr ON orr.user_id = d.opponent_id
    LEFT JOIN duel_entries ce ON ce.duel_id = d.id AND ce.user_id = d.challenger_id
    LEFT JOIN duel_entries oe ON oe.duel_id = d.id AND oe.user_id = d.opponent_id
    WHERE d.code = ?`).bind(String(code || '').toUpperCase()).first();
  if (!row) return null;

  const player = (handle, userId, status, entryJson, submittedAt) => ({
    handle, userId, status: status || 'pending',
    entry: entryJson ? JSON.parse(entryJson) : null,
    submittedAt: submittedAt || 0,
  });

  return {
    row,
    duel: {
      code: row.code, createdAt: row.created_at, acceptedAt: row.accepted_at,
      settledAt: row.settled_at, startTs: row.start_ts, endTs: row.end_ts,
      challengerId: row.challenger_id,
    },
    challenger: player(row.c_handle, row.challenger_id, row.c_status, row.c_entry, row.c_submitted),
    opponent: row.opponent_id
      ? player(row.o_handle, row.opponent_id, row.o_status, row.o_entry, row.o_submitted)
      : null,
  };
}

/** The public view, persisting the result the first time it becomes decidable
 * so a settled duel reads the same forever after. */
async function duelView(env, loaded) {
  const now = Date.now();
  if (loaded.row.settled_at) {
    const view = duel.view(loaded.duel, loaded.challenger, loaded.opponent, now);
    view.result = loaded.row.result_json ? JSON.parse(loaded.row.result_json) : view.result;
    view.status = duel.STATUS.SETTLED;
    return view;
  }
  const view = duel.view(loaded.duel, loaded.challenger, loaded.opponent, now);
  if (view.result && view.result.decided) {
    await env.DB.prepare(
      'UPDATE duels SET settled_at = ?, winner_handle = ?, result_json = ? WHERE id = ?')
      .bind(now, view.result.winner, JSON.stringify(view.result), loaded.row.id)
      .run();
  }
  return view;
}

async function handleDuelCreate(request, env) {
  const user = await sessionUser(request, env);
  if (!user) return json({ ok: false, reason: 'not-signed-in' }, 401);
  if (!(await allowRate(env, 'duel:' + user.id, DUELS_PER_HOUR))) {
    return json({ ok: false, reason: 'rate-limited' }, 429);
  }
  let body = {};
  try { body = await request.json(); } catch {}
  const durationMs = duel.clampDuration(Number(body.durationHours) * 3600000);
  const now = Date.now();
  const code = duelCode();
  await env.DB.prepare(`
    INSERT INTO duels (code, challenger_id, duration_ms, created_at) VALUES (?, ?, ?, ?)`)
    .bind(code, user.id, durationMs, now).run();
  return json({
    ok: true, code, durationMs,
    expiresAt: now + duel.INVITE_TTL_MS,
    url: env.SITE_ORIGIN + '/duel.html?code=' + code,
  });
}

async function handleDuelJoin(request, env) {
  const user = await sessionUser(request, env);
  if (!user) return json({ ok: false, reason: 'not-signed-in' }, 401);
  // Joining was the one duel route with no limit, and it is the one that can
  // be driven by guesswork: a bare loop over the code alphabet is a valid
  // series of join attempts. Same bucket as create — a person doing this by
  // hand never reaches ten an hour.
  if (!(await allowRate(env, 'duel:' + user.id, DUELS_PER_HOUR))) {
    return json({ ok: false, reason: 'rate-limited' }, 429);
  }
  let body = {};
  try { body = await request.json(); } catch {}
  const loaded = await loadDuel(env, body.code);
  if (!loaded) return json({ ok: false, reason: 'not-found' }, 404);

  const now = Date.now();
  const problem = duel.joinProblem(loaded.duel, user.id, now);
  if (problem) return json({ ok: false, reason: problem }, 409);

  const window = duel.duelWindow(now, loaded.row.duration_ms);
  // Guarded by the same open-state predicate the check above used, so two
  // people racing the same invite cannot both become the opponent.
  const claim = await env.DB.prepare(`
    UPDATE duels SET opponent_id = ?, accepted_at = ?, start_ts = ?, end_ts = ?
    WHERE id = ? AND opponent_id IS NULL`)
    .bind(user.id, now, window.startTs, window.endTs, loaded.row.id)
    .run();
  if (!claim.meta || claim.meta.changes !== 1) {
    return json({ ok: false, reason: 'already-accepted' }, 409);
  }
  return json({ ok: true, code: loaded.row.code, window });
}

async function handleDuelGet(env, code) {
  const loaded = await loadDuel(env, code);
  if (!loaded) return json({ ok: false, reason: 'not-found' }, 404);
  return json(await duelView(env, loaded));
}

async function handleDuelsMine(request, env) {
  const user = await sessionUser(request, env);
  if (!user) return json({ ok: false, reason: 'not-signed-in' }, 401);
  const rows = await env.DB.prepare(
    `SELECT code FROM duels WHERE challenger_id = ? OR opponent_id = ?
     ORDER BY created_at DESC LIMIT 20`).bind(user.id, user.id).all();
  const duels = [];
  for (const row of rows.results) {
    const loaded = await loadDuel(env, row.code);
    if (loaded) duels.push(await duelView(env, loaded));
  }
  return json({ duels });
}

/* ---------------- clans ----------------
 *
 * A clan stores no results. `clan_members.joined_at` is the only new fact in
 * the system, and its whole job is to bound what an existing chain contributes
 * (core/clan.js). Everything a clan page shows is `clan.memberEntry` — the same
 * window slice the Sprint and duels use — aggregated by `clan.standing`.
 */

function clanCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let code = '';
  for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return 'CLAN-' + code;
}

/** The caller's membership row, or null. One clan per trader, so this is at
 * most one row by primary key. */
function membershipOf(env, userId) {
  return env.DB.prepare(`
    SELECT m.clan_id, m.joined_at, m.role, c.tag, c.name, c.motto, c.open,
           c.join_code, c.founder_id
    FROM clan_members m JOIN clans c ON c.id = m.clan_id
    WHERE m.user_id = ?`).bind(userId).first();
}

/** Every member of a clan, with the verification tier of their own record. */
async function clanRoster(env, clanId) {
  const rows = await env.DB.prepare(`
    SELECT m.user_id, m.joined_at, m.role, u.handle, u.display_name, u.avatar_url,
           r.status
    FROM clan_members m
    JOIN users u ON u.id = m.user_id
    LEFT JOIN records r ON r.user_id = m.user_id
    WHERE m.clan_id = ?
    ORDER BY m.joined_at ASC`).bind(clanId).all();
  return rows.results;
}

/**
 * Recompute this member's contribution slices for their clan.
 *
 * Called on submission and on join — the two moments the answer can change.
 * Storing it is the same trade the Sprint and duels already make: a clan board
 * is then a read, not a walk over fifty lifetime chains.
 */
async function clanEntryStatements(env, userId, chain, startingSol, now) {
  const membership = await membershipOf(env, userId);
  if (!membership) return [];
  const week = windowOf(now);
  const slices = [
    { id: SEASON_WINDOW_ID, window: clan.SEASON_WINDOW },
    { id: week.weekId, window: { startTs: week.startTs, endTs: week.endTs } },
  ];
  const statements = [];
  for (const slice of slices) {
    const entry = clan.memberEntry(chain, startingSol, membership.joined_at, slice.window);
    // A null slice means they were not in the clan for any of that window.
    // Writing a zeroed row would claim they were there and did nothing.
    if (!entry) continue;
    statements.push(env.DB.prepare(`
      INSERT INTO clan_entries (clan_id, user_id, window_id, entry_json, score, rounds, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(clan_id, user_id, window_id) DO UPDATE SET
        entry_json = excluded.entry_json, score = excluded.score,
        rounds = excluded.rounds, updated_at = excluded.updated_at`)
      .bind(membership.clan_id, userId, slice.id, JSON.stringify(entry),
        entry.score, entry.rounds, now));
  }
  return statements;
}

async function refreshClanEntries(env, userId, chain, startingSol, now) {
  const statements = await clanEntryStatements(env, userId, chain, startingSol, now);
  if (statements.length) await env.DB.batch(statements);
}

/** Recompute a member's slices from their stored chain (used on join, where
 * the caller has no payload in hand). No record yet is not an error — they
 * simply contribute nothing until they submit one. */
async function refreshClanEntriesFromStored(env, userId, now) {
  const record = await env.DB.prepare(
    'SELECT starting_sol FROM records WHERE user_id = ?').bind(userId).first();
  if (!record) return;
  const chain = await loadChain(env, userId);
  if (!chain.length) return;
  await refreshClanEntries(env, userId, chain, record.starting_sol, now);
}

/**
 * Standings for every clan over one window.
 *
 * The membership join is doing real work: an entry belonging to someone who has
 * since left is dropped, so a departed member's numbers can never linger in a
 * clan's total even if their rows outlive them.
 *
 * This reads every current entry for the window and groups in JS. At the
 * present scale (clans × 50 members) that is a few thousand rows behind a 60s
 * edge cache; if the roster count ever makes that untrue, the replacement is a
 * ROW_NUMBER() OVER (PARTITION BY clan_id) window function, not a stored clan
 * score — a clan must never get a book of its own.
 */
async function clanStandings(env, windowId, minRounds) {
  const rows = await env.DB.prepare(`
    SELECT e.clan_id, e.entry_json, u.handle, u.avatar_url, m.joined_at, r.status
    FROM clan_entries e
    JOIN clan_members m ON m.user_id = e.user_id AND m.clan_id = e.clan_id
    JOIN users u ON u.id = e.user_id
    LEFT JOIN records r ON r.user_id = e.user_id
    WHERE e.window_id = ?`).bind(windowId).all();

  const byClan = new Map();
  for (const row of rows.results) {
    if (!byClan.has(row.clan_id)) byClan.set(row.clan_id, []);
    byClan.get(row.clan_id).push({
      handle: row.handle,
      avatarUrl: row.avatar_url,
      status: row.status || 'pending',
      joinedAt: row.joined_at,
      entry: JSON.parse(row.entry_json),
    });
  }

  const standings = new Map();
  for (const [clanId, members] of byClan) {
    standings.set(clanId, clan.standing(members, { minRounds }));
  }
  return standings;
}

/** Roster sizes for every clan, so a clan with no entries yet still counts its
 * members honestly rather than reading as empty. */
async function clanRosterSizes(env) {
  const rows = await env.DB.prepare(
    'SELECT clan_id, COUNT(*) AS n FROM clan_members GROUP BY clan_id').all();
  const sizes = new Map();
  for (const row of rows.results) sizes.set(row.clan_id, row.n);
  return sizes;
}

async function handleClans(env) {
  const week = windowOf(Date.now());
  const [clans, sizes, season, weekly] = await Promise.all([
    env.DB.prepare(`
      SELECT c.id, c.tag, c.name, c.motto, c.open, c.created_at, u.handle AS founder
      FROM clans c JOIN users u ON u.id = c.founder_id
      ORDER BY c.created_at ASC LIMIT 300`).all(),
    clanRosterSizes(env),
    clanStandings(env, SEASON_WINDOW_ID, clan.MIN_SEASON_ROUNDS),
    clanStandings(env, week.weekId, clan.MIN_WEEK_ROUNDS),
  ]);

  const empty = { roster: 0, active: 0, qualified: 0, needed: clan.COUNTING_MEMBERS,
                  ranked: false, score: null, counting: [], rounds: 0, pnlSol: 0 };
  const entries = clans.results.map((row) => {
    const roster = sizes.get(row.id) || 0;
    const withRoster = (standing) => Object.assign({}, standing || empty, { roster });
    return {
      tag: row.tag,
      name: row.name,
      motto: row.motto || '',
      open: !!row.open,
      founder: row.founder,
      createdAt: row.created_at,
      season: withRoster(season.get(row.id)),
      week: withRoster(weekly.get(row.id)),
    };
  });

  return json({
    weekId: week.weekId,
    startTs: week.startTs,
    endTs: week.endTs,
    countingMembers: clan.COUNTING_MEMBERS,
    maxMembers: clan.MAX_MEMBERS,
    minSeasonRounds: clan.MIN_SEASON_ROUNDS,
    entries,
  });
}

async function handleClanGet(env, tag) {
  const row = await env.DB.prepare(`
    SELECT c.id, c.tag, c.name, c.motto, c.open, c.created_at, c.founder_id,
           u.handle AS founder
    FROM clans c JOIN users u ON u.id = c.founder_id
    WHERE c.tag = ?`).bind(clan.normalizeTag(tag)).first();
  if (!row) return json({ ok: false, reason: 'not-found' }, 404);

  const week = windowOf(Date.now());
  const roster = await clanRoster(env, row.id);
  const entryRows = await env.DB.prepare(
    'SELECT user_id, window_id, entry_json FROM clan_entries WHERE clan_id = ?')
    .bind(row.id).all();

  // A Map of Maps rather than a plain object: window_id is data, and `{}[key]`
  // resolves inherited keys like __proto__ to something truthy that is not a Map.
  const bySlice = new Map([[SEASON_WINDOW_ID, new Map()], [week.weekId, new Map()]]);
  for (const entry of entryRows.results) {
    const slice = bySlice.get(entry.window_id);
    if (slice) slice.set(entry.user_id, JSON.parse(entry.entry_json));
  }

  const membersFor = (sliceId) => roster.map((m) => ({
    handle: m.handle,
    displayName: m.display_name,
    avatarUrl: m.avatar_url,
    status: m.status || 'pending',
    role: m.role,
    joinedAt: m.joined_at,
    // Sub-verified figures are withheld at the source (clan.publicEntry),
    // not merely left for clients to skip — see the rationale in core.
    entry: clan.publicEntry(m.status || 'pending',
      bySlice.get(sliceId).get(m.user_id)),
  }));

  const seasonMembers = membersFor(SEASON_WINDOW_ID);
  const weekMembers = membersFor(week.weekId);
  // Both slices per member, so the page can switch views without one state
  // ever standing in for another. Three distinct facts, three renderings:
  // 0 = in the clan, closed nothing (a real result); a dash = not a member
  // for any of that window (memberEntry null); "not counted" = record below
  // verified (entry withheld by publicEntry). This comment previously said a
  // dash meant no closed round — the exact conflation the clan page had to
  // fix, so: a dash is absence from the window, never a zero.
  const members = seasonMembers.map((m, i) => ({
    handle: m.handle,
    displayName: m.displayName,
    avatarUrl: m.avatarUrl,
    status: m.status,
    role: m.role,
    joinedAt: m.joinedAt,
    season: m.entry,
    week: weekMembers[i].entry,
  }));
  return json({
    tag: row.tag,
    name: row.name,
    motto: row.motto || '',
    open: !!row.open,
    founder: row.founder,
    createdAt: row.created_at,
    weekId: week.weekId,
    startTs: week.startTs,
    endTs: week.endTs,
    countingMembers: clan.COUNTING_MEMBERS,
    maxMembers: clan.MAX_MEMBERS,
    minSeasonRounds: clan.MIN_SEASON_ROUNDS,
    season: clan.standing(seasonMembers, { minRounds: clan.MIN_SEASON_ROUNDS }),
    week: clan.standing(weekMembers, { minRounds: clan.MIN_WEEK_ROUNDS }),
    // The roster carries what every name actually contributed, in both windows,
    // instead of a bare list of handles. The join code is deliberately absent:
    // it lives on /api/clan/mine, which is never edge-cached.
    members,
  });
}

async function handleClanMine(request, env) {
  const user = await sessionUser(request, env);
  if (!user) return json({ ok: false, reason: 'not-signed-in' }, 401);
  const membership = await membershipOf(env, user.id);
  if (!membership) return json({ inClan: false });
  const size = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM clan_members WHERE clan_id = ?').bind(membership.clan_id).first();
  return json({
    inClan: true,
    tag: membership.tag,
    name: membership.name,
    motto: membership.motto || '',
    open: !!membership.open,
    role: membership.role,
    joinedAt: membership.joined_at,
    roster: size ? size.n : 0,
    maxMembers: clan.MAX_MEMBERS,
    // Only a member ever sees the invite code, which is the entire point of
    // an invite-only clan. It is not on the public clan payload.
    joinCode: membership.join_code,
    isFounder: Number(membership.founder_id) === Number(user.id),
  });
}

async function handleClanCreate(request, env) {
  const user = await sessionUser(request, env);
  if (!user) return json({ ok: false, reason: 'not-signed-in' }, 401);
  if (!(await allowRate(env, 'clan:' + user.id, CLAN_ACTIONS_PER_HOUR))) {
    return json({ ok: false, reason: 'rate-limited' }, 429);
  }
  let body = {};
  try { body = await request.json(); } catch {}

  const membership = await membershipOf(env, user.id);
  const problem = clan.createProblem({
    tag: body.tag, name: body.name, motto: body.motto, alreadyInClan: !!membership,
  });
  if (problem) return json({ ok: false, reason: problem }, 422);

  const tag = clan.normalizeTag(body.tag);
  const name = clan.normalizeName(body.name);
  const key = clan.nameKey(name);
  const clash = await env.DB.prepare(
    'SELECT tag, name_key FROM clans WHERE tag = ? OR name_key = ?').bind(tag, key).first();
  if (clash) return json({ ok: false, reason: clash.tag === tag ? 'tag-taken' : 'name-taken' }, 409);

  const now = Date.now();
  const code = clanCode();
  try {
    await env.DB.prepare(`
      INSERT INTO clans (tag, name, name_key, motto, founder_id, join_code, open, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(tag, name, key, clan.cleanMotto(body.motto), user.id, code, body.open ? 1 : 0, now)
      .run();
  } catch {
    // The SELECT above races; the UNIQUE constraints are what actually decide.
    return json({ ok: false, reason: 'tag-taken' }, 409);
  }
  const created = await env.DB.prepare('SELECT id FROM clans WHERE tag = ?').bind(tag).first();
  await env.DB.prepare(
    `INSERT INTO clan_members (user_id, clan_id, joined_at, role) VALUES (?, ?, ?, 'founder')`)
    .bind(user.id, created.id, now).run();
  await refreshClanEntriesFromStored(env, user.id, now);
  return json({ ok: true, tag, name, joinCode: code });
}

async function handleClanJoin(request, env) {
  const user = await sessionUser(request, env);
  if (!user) return json({ ok: false, reason: 'not-signed-in' }, 401);
  if (!(await allowRate(env, 'clan:' + user.id, CLAN_ACTIONS_PER_HOUR))) {
    return json({ ok: false, reason: 'rate-limited' }, 429);
  }
  let body = {};
  try { body = await request.json(); } catch {}

  const code = clan.normalizeCode(body.code);
  const row = code
    ? await env.DB.prepare(
        'SELECT id, tag, open, join_code FROM clans WHERE join_code = ?').bind(code).first()
    : await env.DB.prepare(
        'SELECT id, tag, open, join_code FROM clans WHERE tag = ?')
        .bind(clan.normalizeTag(body.tag)).first();

  const membership = await membershipOf(env, user.id);
  const size = row
    ? await env.DB.prepare('SELECT COUNT(*) AS n FROM clan_members WHERE clan_id = ?')
        .bind(row.id).first()
    : null;
  const problem = clan.joinProblem(
    row ? { open: !!row.open, joinCode: row.join_code } : null,
    size ? size.n : 0,
    { alreadyInClan: !!membership, code: body.code });
  if (problem) {
    return json({ ok: false, reason: problem }, problem === 'not-found' ? 404 : 409);
  }

  const now = Date.now();
  // Guarded by the same cap the check above used, so a crowd racing the last
  // seat cannot all take it. The user_id primary key does the same job for
  // "one clan per trader" — a double join throws rather than splitting them.
  let claim;
  try {
    claim = await env.DB.prepare(`
      INSERT INTO clan_members (user_id, clan_id, joined_at, role)
      SELECT ?, ?, ?, 'member'
      WHERE (SELECT COUNT(*) FROM clan_members WHERE clan_id = ?) < ?`)
      .bind(user.id, row.id, now, row.id, clan.MAX_MEMBERS).run();
  } catch {
    return json({ ok: false, reason: 'already-in-a-clan' }, 409);
  }
  if (!claim.meta || claim.meta.changes !== 1) {
    return json({ ok: false, reason: 'clan-full' }, 409);
  }

  await refreshClanEntriesFromStored(env, user.id, now);
  return json({ ok: true, tag: row.tag, joinedAt: now });
}

/**
 * Remove a member and everything derived from their membership.
 *
 * When the founder goes, the clan passes to its longest-standing member; when
 * the last member goes, the clan is disbanded rather than left as an ownerless
 * shell with a name nobody can reclaim.
 */
async function removeMember(env, clanId, userId, founderId) {
  const statements = [
    env.DB.prepare('DELETE FROM clan_entries WHERE clan_id = ? AND user_id = ?')
      .bind(clanId, userId),
    env.DB.prepare('DELETE FROM clan_members WHERE user_id = ? AND clan_id = ?')
      .bind(userId, clanId),
  ];
  if (Number(founderId) === Number(userId)) {
    const roster = await clanRoster(env, clanId);
    const heir = clan.successor(roster.map((m) => ({ userId: m.user_id, joinedAt: m.joined_at })), userId);
    if (heir) {
      statements.push(
        env.DB.prepare('UPDATE clans SET founder_id = ? WHERE id = ?').bind(heir.userId, clanId),
        env.DB.prepare(`UPDATE clan_members SET role = 'founder' WHERE user_id = ?`)
          .bind(heir.userId));
    } else {
      statements.push(
        env.DB.prepare('DELETE FROM clan_entries WHERE clan_id = ?').bind(clanId),
        env.DB.prepare('DELETE FROM clans WHERE id = ?').bind(clanId));
    }
  }
  await env.DB.batch(statements);
}

async function handleClanLeave(request, env) {
  const user = await sessionUser(request, env);
  if (!user) return json({ ok: false, reason: 'not-signed-in' }, 401);
  // Leave/join cycling is the cheapest way to churn clan_entries and to walk
  // a founder succession around a roster, so it shares the clan bucket rather
  // than being the one clan action that is free.
  if (!(await allowRate(env, 'clan:' + user.id, CLAN_ACTIONS_PER_HOUR))) {
    return json({ ok: false, reason: 'rate-limited' }, 429);
  }
  const membership = await membershipOf(env, user.id);
  if (!membership) return json({ ok: false, reason: 'not-in-a-clan' }, 409);
  await removeMember(env, membership.clan_id, user.id, membership.founder_id);
  return json({ ok: true });
}

async function handleClanKick(request, env) {
  const user = await sessionUser(request, env);
  if (!user) return json({ ok: false, reason: 'not-signed-in' }, 401);
  if (!(await allowRate(env, 'clan:' + user.id, CLAN_ACTIONS_PER_HOUR))) {
    return json({ ok: false, reason: 'rate-limited' }, 429);
  }
  let body = {};
  try { body = await request.json(); } catch {}
  const membership = await membershipOf(env, user.id);
  if (!membership) return json({ ok: false, reason: 'not-in-a-clan' }, 409);

  const target = await env.DB.prepare(`
    SELECT m.user_id FROM clan_members m JOIN users u ON u.id = m.user_id
    WHERE m.clan_id = ? AND u.handle = ? COLLATE NOCASE`)
    .bind(membership.clan_id, String(body.handle || '')).first();
  if (!target) return json({ ok: false, reason: 'not-a-member' }, 404);

  const problem = clan.kickProblem(
    { founderId: membership.founder_id }, user.id, target.user_id);
  if (problem) return json({ ok: false, reason: problem }, 403);

  await removeMember(env, membership.clan_id, target.user_id, membership.founder_id);
  return json({ ok: true });
}

/**
 * Founder-editable clan settings.
 *
 * Motto and join policy only. The tag and name are deliberately immutable:
 * people joined a name, and a clan that can rename itself later can rename
 * itself into an impersonation of another one after collecting a roster.
 */
async function handleClanUpdate(request, env) {
  const user = await sessionUser(request, env);
  if (!user) return json({ ok: false, reason: 'not-signed-in' }, 401);
  if (!(await allowRate(env, 'clan:' + user.id, CLAN_ACTIONS_PER_HOUR))) {
    return json({ ok: false, reason: 'rate-limited' }, 429);
  }
  let body = {};
  try { body = await request.json(); } catch {}
  const membership = await membershipOf(env, user.id);
  if (!membership) return json({ ok: false, reason: 'not-in-a-clan' }, 409);
  if (Number(membership.founder_id) !== Number(user.id)) {
    return json({ ok: false, reason: 'not-founder' }, 403);
  }
  const problem = clan.mottoProblem(body.motto);
  if (problem) return json({ ok: false, reason: problem }, 422);
  await env.DB.prepare('UPDATE clans SET motto = ?, open = ? WHERE id = ?')
    .bind(clan.cleanMotto(body.motto), body.open ? 1 : 0, membership.clan_id).run();
  return json({ ok: true });
}

/* ---------------- pricing cron ---------------- */

async function drainPricing(env) {
  const now = Date.now();
  // Oldest pending record that is not backing off. Without the stall filter a
  // single record whose candles cannot be fetched would sit at the head of the
  // queue forever and no other record would ever be verified.
  const row = await env.DB.prepare(
    `SELECT user_id, starting_sol, pricing_progress_json FROM records
     WHERE status = 'pending'
       AND COALESCE(json_extract(pricing_progress_json, '$.stalledUntil'), 0) <= ?
     ORDER BY submitted_at ASC LIMIT 1`).bind(now).first();
  if (!row) return;
  const chain = await loadChain(env, row.user_id);
  if (!chain.length) return;

  const budget = { used: 0, max: CANDLE_BUDGET_PER_RUN };
  const progress = row.pricing_progress_json ? JSON.parse(row.pricing_progress_json) : null;
  const before = progress && Number(progress.cursor) > 0 ? Number(progress.cursor) : 0;
  let result;
  try {
    result = await priceRecord({ chain }, makeGetCandles(env, budget), progress, {
      // A lookup can cost up to three external calls (pool resolve, token
      // candle, SOL candle), so the per-run lookup cap is a third of the
      // call budget. Passing it is what makes priceChain pause cleanly at a
      // resumable cursor instead of running into the budget's own throw.
      maxLookups: Math.max(1, Math.floor(CANDLE_BUDGET_PER_RUN / 3)),
    });
  } catch (err) {
    // A throw here (candle source down, malformed stored progress) used to
    // return silently — which kept this record at the HEAD of the queue,
    // because the ORDER BY picks the oldest pending record and this one never
    // stopped being it. One permanently-throwing record therefore starved
    // every submission behind it, invisibly, forever (DEFECT L-10). Record a
    // stall so the queue moves on and the failure is visible in the row.
    const stalls = progress ? (Number(progress.stalls) || 0) + 1 : 1;
    await env.DB.prepare('UPDATE records SET pricing_progress_json = ? WHERE user_id = ?')
      .bind(JSON.stringify({
        cursor: before,
        verdicts: progress && Array.isArray(progress.verdicts) ? progress.verdicts : [],
        stalledUntil: now + PRICING_BACKOFF_MS,
        stalls,
        lastStallAt: now,
        lastError: String(err && err.message || err).slice(0, 200),
      }), row.user_id)
      .run();
    // Log it too — a cron that silently returns is indistinguishable from a
    // cron that is not firing, and the difference decides whether anyone
    // goes looking.
    console.error('drainPricing failed for user', row.user_id, err);
    return;
  }

  if (!result.done) {
    // A run that priced nothing new is stalling on something outside our
    // control. Back it off so the queue keeps moving, but keep every verdict
    // already earned — and record WHY, because a record parked at `pending`
    // with no explanation is indistinguishable from one that is progressing
    // slowly, and the difference decides whether anyone goes looking.
    const stalled = result.cursor <= before;
    let stalls = 0;
    if (stalled && progress) stalls = (Number(progress.stalls) || 0) + 1;
    await env.DB.prepare('UPDATE records SET pricing_progress_json = ? WHERE user_id = ?')
      .bind(JSON.stringify({
        cursor: result.cursor,
        verdicts: result.verdicts,
        stalledUntil: stalled ? now + PRICING_BACKOFF_MS : 0,
        stalls,
        lastStallAt: stalled ? now : 0,
      }), row.user_id)
      .run();
    return;
  }
  // Re-award badges now that verification has a verdict: 'unbroken' is only
  // earnable by a record whose every fill actually survived re-pricing.
  const badges = awarded({
    chain, startingSol: row.starting_sol, chainLen: chain.length,
    pricingStatus: result.verdict.status, coverage: result.verdict.coverage,
  });
  await env.DB.prepare(`
    UPDATE records SET status = ?, pricing_json = ?, pricing_progress_json = NULL,
                       badges_json = ?, verified_at = ? WHERE user_id = ?`)
    .bind(result.verdict.status, JSON.stringify(result.verdict),
      JSON.stringify(badges), Date.now(), row.user_id)
    .run();
}

/* ---------------- streamer applications ---------------- */

/**
 * The moderator behind a request, or null.
 *
 * Two gates, both required: a valid session, and an x_id on the ADMIN_X_IDS
 * allowlist. An unset or empty allowlist authorises nobody — a deploy that
 * forgets the var must close the mod queue, not open it to every signed-in
 * visitor, and "no admins configured" is the safe reading of an absent list.
 */
async function moderator(request, env) {
  const user = await sessionUser(request, env);
  if (!user) return null;
  return streamer.isAdmin(user.x_id, env.ADMIN_X_IDS) ? user : null;
}

/**
 * A salted, one-way trace of the applicant's IP.
 *
 * The raw address is never stored: applications come from members of the
 * public, and an IP column would be a standing log of where they live for a
 * feature whose actual need is only "did these six submissions come from one
 * person". A SESSION_SECRET-salted digest answers that and nothing else, and
 * it cannot be reversed or joined against anything outside this table.
 */
async function ipTrace(request, env) {
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip || !env.SESSION_SECRET) return null;
  const bytes = new TextEncoder().encode(env.SESSION_SECRET + ':' + ip);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].slice(0, 8)
    .map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function handleStreamerApply(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (!(await allowRate(env, 'streamerapply:' + ip, STREAMER_APPLIES_PER_HOUR))) {
    return json({ ok: false, reason: 'rate-limited' }, 429);
  }
  let body = {};
  try { body = await request.json(); } catch {}

  const problem = streamer.applyProblem(body);
  if (problem) return json({ ok: false, reason: problem }, 422);

  const app = streamer.normalizeApplication(body);
  try {
    await env.DB.prepare(`
      INSERT INTO streamer_applications
        (name, channel_url, platform, twitch_login, discord, viewers, blurb,
         notes, contact_method, contact_link, best_time, status, created_at, ip_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
      .bind(app.name, app.channelUrl, app.platform, app.twitchLogin, app.discord,
        app.viewers, app.blurb || null, app.notes || null, app.contactMethod,
        app.contactLink, app.bestTime || null, Date.now(), await ipTrace(request, env))
      .run();
  } catch {
    // The partial unique index on channel_url is what decides, not a prior
    // SELECT: two tabs submitted together would both pass a check-then-act.
    return json({ ok: false, reason: 'already-applied' }, 409);
  }
  return json({ ok: true });
}

/**
 * The mod queue. Every column, including contact details — which is exactly
 * why it is behind moderator() and why nothing else selects from this table.
 */
async function handleStreamerApplications(request, env) {
  const mod = await moderator(request, env);
  if (!mod) return json({ ok: false, reason: 'not-a-moderator' }, 403);

  const url = new URL(request.url);
  const status = url.searchParams.get('status') || 'pending';
  if (!streamer.isStatus(status)) return json({ ok: false, reason: 'bad-status' }, 422);

  const { results } = await env.DB.prepare(`
    SELECT a.id, a.name, a.channel_url, a.platform, a.twitch_login, a.discord,
           a.viewers, a.blurb, a.notes, a.contact_method, a.contact_link,
           a.best_time, a.status, a.created_at, a.reviewed_at, u.handle AS reviewed_by
      FROM streamer_applications a
      LEFT JOIN users u ON u.id = a.reviewed_by
     WHERE a.status = ?
     ORDER BY a.created_at DESC
     LIMIT 200`)
    .bind(status).all();

  const counts = await env.DB.prepare(
    'SELECT status, COUNT(*) AS n FROM streamer_applications GROUP BY status').all();

  return json({
    ok: true,
    applications: (results || []).map((r) => ({
      id: r.id,
      name: r.name,
      channelUrl: r.channel_url,
      platform: r.platform,
      twitchLogin: r.twitch_login,
      discord: r.discord,
      viewers: r.viewers,
      blurb: r.blurb || '',
      notes: r.notes || '',
      contactMethod: r.contact_method || '',
      contactLink: r.contact_link || '',
      bestTime: r.best_time || '',
      status: r.status,
      createdAt: r.created_at,
      reviewedAt: r.reviewed_at,
      reviewedBy: r.reviewed_by || null,
    })),
    counts: Object.fromEntries((counts.results || []).map((r) => [r.status, Number(r.n)])),
  });
}

async function handleStreamerReview(request, env) {
  const mod = await moderator(request, env);
  if (!mod) return json({ ok: false, reason: 'not-a-moderator' }, 403);

  let body = {};
  try { body = await request.json(); } catch {}
  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) return json({ ok: false, reason: 'bad-id' }, 422);
  // 'pending' is a legal target: it is how a decision gets undone.
  if (!streamer.isStatus(body.status)) return json({ ok: false, reason: 'bad-status' }, 422);

  try {
    const result = await env.DB.prepare(`
      UPDATE streamer_applications SET status = ?, reviewed_by = ?, reviewed_at = ?
       WHERE id = ?`)
      .bind(body.status, mod.id, Date.now(), id)
      .run();
    if (!result.meta || result.meta.changes === 0) {
      return json({ ok: false, reason: 'not-found' }, 404);
    }
  } catch {
    // Approving a channel that already holds the approved/pending slot trips
    // the partial unique index — a duplicate application, not a server fault.
    return json({ ok: false, reason: 'already-listed' }, 409);
  }
  return json({ ok: true });
}

/**
 * The public roster: approved applications, as streams.js consumes them.
 *
 * Deliberately a different column list from the mod queue above. An approved
 * applicant agreed to appear on the streams page — they did not agree to
 * publish the Discord handle and availability they gave us to be contacted
 * with, so those columns are simply not in this SELECT.
 *
 * `blurb` is here and `notes` is not, and that is the whole distinction: the
 * blurb is the field whose label promises it will be shown publicly, while
 * notes answers "anything else you'd like us to know?" — a message to the
 * moderators. Serving notes here would publish something written in private.
 */
/* The public roster: every approved application, whatever it streams on.
 *
 * This used to require `twitch_login IS NOT NULL`, because the streams page
 * could only render an embeddable Twitch player — so an approved Kick or
 * YouTube creator was accepted by a moderator and then silently never
 * appeared anywhere, which is the worst of both answers. The page now renders
 * a link-out card for the other platforms, so the roster serves them all and
 * says which is which. `login` stays null off Twitch: it means "embeddable
 * here", and inventing one for a platform we cannot embed would put a dead
 * player on the page.
 *
 * Still only the three columns the applicant was told become a card — the
 * private contact block is not in this SELECT and must never be.
 */
async function handleStreamerRoster(env) {
  const { results } = await env.DB.prepare(`
    SELECT name, twitch_login, blurb, platform, channel_url
      FROM streamer_applications
     WHERE status = 'approved'
     ORDER BY created_at DESC
     LIMIT 60`).all();
  return json({
    ok: true,
    streamers: (results || []).map((r) => ({
      login: r.twitch_login || null,
      name: r.name,
      blurb: r.blurb || '',
      platform: r.platform || 'other',
      channelUrl: r.channel_url || null,
    })),
  });
}

/* ---------------- moderation ----------------
 *
 * Everything here is behind the same `moderator()` gate as the streamer queue,
 * and every route is deliberately small. A moderator can:
 *
 *   - look up an account and read its record, clan and moderation history
 *   - ban / unban an account
 *   - disqualify / reinstate a RECORD without touching the account
 *   - disband / restore a clan
 *
 * and nothing else. There is no delete, no score edit, no chain rewrite, no
 * way to promote another moderator — that stays a deploy-time decision in
 * ADMIN_X_IDS. The powers that exist are the ones that are reversible, and
 * every one of them writes a moderation_log row with a mandatory reason.
 *
 * Reasons are required rather than encouraged: an unexplained ban is
 * indistinguishable from a mistake three weeks later, including to the
 * moderator who made it.
 */

/** Record one moderator action. Reason is pre-validated by the caller. */
function logModeration(env, actor, action, kind, id, label, reason) {
  return env.DB.prepare(`
    INSERT INTO moderation_log
      (actor_id, action, target_kind, target_id, target_label, reason, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(actor.id, action, kind, id, label || null, reason, Date.now())
    .run();
}

/** The reason string, or null when it is not usable. */
function moderationReason(raw) {
  const text = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  return text.length >= 3 ? text.slice(0, 500) : null;
}

/** Accounts, newest first, optionally filtered by handle or X id. */
async function handleAdminUsers(request, env) {
  const mod = await moderator(request, env);
  if (!mod) return json({ ok: false, reason: 'not-a-moderator' }, 403);

  const term = (new URL(request.url).searchParams.get('q') || '').trim().toLowerCase();
  const like = '%' + term.replace(/[%_]/g, '') + '%';
  const rows = await env.DB.prepare(`
    SELECT u.id, u.handle, u.display_name, u.x_id, u.avatar_url,
           u.created_at, u.last_login_at, u.banned_at, u.banned_reason,
           r.status AS record_status, r.chain_len, r.stats_json, r.dq_at, r.dq_reason,
           cl.tag AS clan_tag
      FROM users u
      LEFT JOIN records r ON r.user_id = u.id
      LEFT JOIN clan_members cm ON cm.user_id = u.id
      LEFT JOIN clans cl ON cl.id = cm.clan_id
     WHERE (?1 = '' OR LOWER(u.handle) LIKE ?2 OR u.x_id LIKE ?2)
     ORDER BY u.last_login_at DESC
     LIMIT 100`).bind(term, like).all();

  return json({
    ok: true,
    users: (rows.results || []).map((r) => {
      const stats = r.stats_json ? JSON.parse(r.stats_json) : null;
      return {
        id: r.id, handle: r.handle, displayName: r.display_name, xId: r.x_id,
        avatarUrl: r.avatar_url, joinedAt: r.created_at, lastLoginAt: r.last_login_at,
        banned: Boolean(r.banned_at), bannedReason: r.banned_reason || null,
        clanTag: r.clan_tag || null,
        recordStatus: r.record_status || null, chainLen: r.chain_len || 0,
        rounds: stats ? stats.rounds : 0,
        score: stats ? stats.score : null,
        rankable: stats ? Boolean(stats.rankable) : false,
        disqualified: Boolean(r.dq_at), dqReason: r.dq_reason || null,
      };
    }),
  });
}

/** One account in full, plus everything a moderator has ever done to it. */
async function handleAdminUser(request, env) {
  const mod = await moderator(request, env);
  if (!mod) return json({ ok: false, reason: 'not-a-moderator' }, 403);

  const handle = (new URL(request.url).searchParams.get('handle') || '').trim();
  if (!handle) return json({ ok: false, reason: 'handle-required' }, 422);

  const row = await env.DB.prepare(`
    SELECT u.id, u.handle, u.display_name, u.x_id, u.avatar_url,
           u.created_at, u.last_login_at, u.banned_at, u.banned_reason,
           r.status AS record_status, r.chain_len, r.starting_sol, r.stats_json,
           r.pricing_json, r.submitted_at, r.verified_at, r.dq_at, r.dq_reason,
           cl.tag AS clan_tag, cl.name AS clan_name, cm.role AS clan_role
      FROM users u
      LEFT JOIN records r ON r.user_id = u.id
      LEFT JOIN clan_members cm ON cm.user_id = u.id
      LEFT JOIN clans cl ON cl.id = cm.clan_id
     WHERE u.handle = ? COLLATE NOCASE`).bind(handle).first();
  if (!row) return json({ ok: false, reason: 'not-found' }, 404);

  const log = await env.DB.prepare(`
    SELECT m.action, m.reason, m.created_at, m.target_label, a.handle AS actor
      FROM moderation_log m LEFT JOIN users a ON a.id = m.actor_id
     WHERE (m.target_kind = 'user' AND m.target_id = ?1)
        OR (m.target_kind = 'record' AND m.target_id = ?1)
     ORDER BY m.created_at DESC LIMIT 50`).bind(row.id).all();

  return json({
    ok: true,
    user: {
      id: row.id, handle: row.handle, displayName: row.display_name, xId: row.x_id,
      avatarUrl: row.avatar_url, joinedAt: row.created_at, lastLoginAt: row.last_login_at,
      banned: Boolean(row.banned_at), bannedAt: row.banned_at, bannedReason: row.banned_reason,
      clanTag: row.clan_tag, clanName: row.clan_name, clanRole: row.clan_role,
      recordStatus: row.record_status, chainLen: row.chain_len,
      startingSol: row.starting_sol,
      stats: row.stats_json ? JSON.parse(row.stats_json) : null,
      pricing: row.pricing_json ? JSON.parse(row.pricing_json) : null,
      submittedAt: row.submitted_at, verifiedAt: row.verified_at,
      disqualified: Boolean(row.dq_at), dqAt: row.dq_at, dqReason: row.dq_reason,
    },
    log: (log.results || []).map((l) => ({
      action: l.action, reason: l.reason, at: l.created_at, actor: l.actor || 'a moderator',
    })),
  });
}

/** Close or reopen an account. */
async function handleAdminBan(request, env) {
  const mod = await moderator(request, env);
  if (!mod) return json({ ok: false, reason: 'not-a-moderator' }, 403);

  let body = {};
  try { body = await request.json(); } catch {}
  const target = await env.DB.prepare('SELECT id, handle FROM users WHERE id = ?')
    .bind(Number(body.userId)).first();
  if (!target) return json({ ok: false, reason: 'not-found' }, 404);
  // A moderator cannot ban themselves out of the room they are standing in.
  if (target.id === mod.id) return json({ ok: false, reason: 'cannot-ban-self' }, 422);

  const banning = Boolean(body.banned);
  const reason = moderationReason(body.reason);
  if (!reason) return json({ ok: false, reason: 'reason-required' }, 422);

  await env.DB.batch([
    env.DB.prepare(`
      UPDATE users SET banned_at = ?, banned_reason = ?, banned_by = ?,
                       session_epoch = session_epoch + ?
       WHERE id = ?`)
      // Bumping session_epoch revokes every live session for this account, so
      // a ban takes effect on the next request rather than whenever their
      // current token happens to expire.
      .bind(banning ? Date.now() : null, banning ? reason : null,
        banning ? mod.id : null, banning ? 1 : 0, target.id),
  ]);
  await logModeration(env, mod, banning ? 'user.ban' : 'user.unban',
    'user', target.id, target.handle, reason);

  return json({ ok: true });
}

/** Take a record off the boards, or put it back. The account is untouched. */
async function handleAdminDisqualify(request, env) {
  const mod = await moderator(request, env);
  if (!mod) return json({ ok: false, reason: 'not-a-moderator' }, 403);

  let body = {};
  try { body = await request.json(); } catch {}
  const target = await env.DB.prepare(`
    SELECT u.id, u.handle FROM users u
      JOIN records r ON r.user_id = u.id
     WHERE u.id = ?`).bind(Number(body.userId)).first();
  if (!target) return json({ ok: false, reason: 'no-record' }, 404);

  const dq = Boolean(body.disqualified);
  const reason = moderationReason(body.reason);
  if (!reason) return json({ ok: false, reason: 'reason-required' }, 422);

  await env.DB.prepare(`
    UPDATE records SET dq_at = ?, dq_reason = ?, dq_by = ? WHERE user_id = ?`)
    .bind(dq ? Date.now() : null, dq ? reason : null, dq ? mod.id : null, target.id)
    .run();
  await logModeration(env, mod, dq ? 'record.disqualify' : 'record.reinstate',
    'record', target.id, target.handle, reason);

  return json({ ok: true });
}

/** Clans, with size and standing. */
async function handleAdminClans(request, env) {
  const mod = await moderator(request, env);
  if (!mod) return json({ ok: false, reason: 'not-a-moderator' }, 403);

  const rows = await env.DB.prepare(`
    SELECT c.id, c.tag, c.name, c.motto, c.open, c.created_at,
           c.disbanded_at, c.disbanded_reason,
           f.handle AS founder,
           (SELECT COUNT(*) FROM clan_members m WHERE m.clan_id = c.id) AS members
      FROM clans c LEFT JOIN users f ON f.id = c.founder_id
     ORDER BY c.created_at DESC LIMIT 200`).all();

  return json({
    ok: true,
    clans: (rows.results || []).map((c) => ({
      id: c.id, tag: c.tag, name: c.name, motto: c.motto || '',
      open: Boolean(c.open), createdAt: c.created_at, founder: c.founder || null,
      members: c.members || 0,
      disbanded: Boolean(c.disbanded_at), disbandedReason: c.disbanded_reason || null,
    })),
  });
}

/** Disband a clan, or restore one. Membership rows are left intact. */
async function handleAdminClanDisband(request, env) {
  const mod = await moderator(request, env);
  if (!mod) return json({ ok: false, reason: 'not-a-moderator' }, 403);

  let body = {};
  try { body = await request.json(); } catch {}
  const clanRow = await env.DB.prepare('SELECT id, tag FROM clans WHERE id = ?')
    .bind(Number(body.clanId)).first();
  if (!clanRow) return json({ ok: false, reason: 'not-found' }, 404);

  const off = body.disbanded === undefined ? true : Boolean(body.disbanded);
  const reason = moderationReason(body.reason);
  if (!reason) return json({ ok: false, reason: 'reason-required' }, 422);

  await env.DB.prepare(
    'UPDATE clans SET disbanded_at = ?, disbanded_reason = ? WHERE id = ?')
    .bind(off ? Date.now() : null, off ? reason : null, clanRow.id).run();
  await logModeration(env, mod, off ? 'clan.disband' : 'clan.restore',
    'clan', clanRow.id, '[' + clanRow.tag + ']', reason);

  return json({ ok: true });
}

/** The whole ledger, newest first. */
async function handleAdminLog(request, env) {
  const mod = await moderator(request, env);
  if (!mod) return json({ ok: false, reason: 'not-a-moderator' }, 403);

  const rows = await env.DB.prepare(`
    SELECT m.action, m.target_kind, m.target_label, m.reason, m.created_at,
           a.handle AS actor
      FROM moderation_log m LEFT JOIN users a ON a.id = m.actor_id
     ORDER BY m.created_at DESC LIMIT 100`).all();

  return json({
    ok: true,
    log: (rows.results || []).map((l) => ({
      action: l.action, kind: l.target_kind, target: l.target_label,
      reason: l.reason, at: l.created_at, actor: l.actor || 'a moderator',
    })),
  });
}

/* ---------------- entry ---------------- */

/* ---------------- real-trade replay (Indeix) ---------------- */

/** Chain id for the replay endpoints. Only Solana is supported. */
function replayChain(url) {
  const chain = (url.searchParams.get('chain') || 'solana').toLowerCase();
  return chain === 'solana' ? 'solana' : null;
}

/** GET /api/replay/history?mint=...&chain=solana — candles + wallet leaderboard. */
async function handleReplayHistory(request, env) {
  const url = new URL(request.url);
  const chain = replayChain(url);
  const mint = (url.searchParams.get('mint') || '').trim();
  if (!chain) return json({ ok: false, reason: 'unsupported-chain' }, 400);
  if (!replay.isAddress(mint)) return json({ ok: false, reason: 'bad-mint' }, 400);
  const budget = { used: 0, max: 8 };
  try {
    const [candles, rawTrades] = await Promise.all([
      indeix.ohlcv(env, chain, mint, 0, budget),
      indeix.trades(env, chain, mint, budget, 50),
    ]);
    if (!candles || !rawTrades) return json({ ok: false, reason: 'no-data' }, 404);
    const byMinute = indeix.candlesByMinute(candles);
    const fills = rawTrades
      .map((t) => replay.normalizeTrade(t, byMinute))
      .filter(Boolean);
    const byWallet = replay.groupByWallet(fills);
    const finalPrice = candles.length ? candles[candles.length - 1].c : 0;
    const lb = replay.leaderboard(byWallet, finalPrice, 10);
    // Latest candle close is the mark price for the board's unrealized figure.
    return json({
      ok: true, mint,
      candles: candles.slice(-720),
      leaderboard: lb,
    });
  } catch (err) {
    return replayError(err);
  }
}

/** GET /api/replay/wallet?mint=...&wallet=...&chain=solana — one wallet's replay. */
async function handleReplayWallet(request, env) {
  const url = new URL(request.url);
  const chain = replayChain(url);
  const mint = (url.searchParams.get('mint') || '').trim();
  const wallet = (url.searchParams.get('wallet') || '').trim();
  if (!chain) return json({ ok: false, reason: 'unsupported-chain' }, 400);
  if (!replay.isAddress(mint) || !replay.isAddress(wallet)) {
    return json({ ok: false, reason: 'bad-address' }, 400);
  }
  const budget = { used: 0, max: 12 };
  try {
    const [candles, rawTrades] = await Promise.all([
      indeix.ohlcv(env, chain, mint, 0, budget),
      indeix.trades(env, chain, mint, budget, 50),
    ]);
    if (!candles || !rawTrades) return json({ ok: false, reason: 'no-data' }, 404);
    const byMinute = indeix.candlesByMinute(candles);
    const fills = rawTrades
      .map((t) => replay.normalizeTrade(t, byMinute))
      .filter((f) => f && f.wallet === wallet);
    const position = replay.foldFills(fills);
    const curve = replay.replayCurve(fills, candles);
    const finalPrice = candles.length ? candles[candles.length - 1].c : 0;
    const pnl = replay.pnlAt(position, finalPrice);
    return json({
      ok: true, mint, wallet,
      candles: candles.slice(-720),
      fills: fills.slice(-60),
      curve,
      position: {
        qty: position.qty, buys: position.buys, sells: position.sells,
        boughtUsd: position.boughtUsd, soldUsd: position.soldUsd,
      },
      pnl,
    });
  } catch (err) {
    return replayError(err);
  }
}

/** Map Indeix/replay errors to honest HTTP statuses (never leak the key). */
function replayError(err) {
  const code = err && err.code;
  if (code === 'indeix-not-configured') return json({ ok: false, reason: 'replay-unconfigured' }, 503);
  if (code === 'indeix-budget-exhausted') return json({ ok: false, reason: 'busy' }, 429);
  if (code === 'indeix-rate-limited') return json({ ok: false, reason: 'rate-limited' }, 429);
  if (code === 'indeix-auth-failed') return json({ ok: false, reason: 'replay-auth' }, 502);
  return json({ ok: false, reason: 'server-error' }, 500);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    // The OAuth callback is a top-level navigation from x.com and carries no
    // Origin; everything else that changes state must prove where it came from.
    if (request.method === 'POST' && !requireOrigin(request, env)) {
      const denied = json({ ok: false, reason: 'bad-origin' }, 403);
      for (const [key, value] of Object.entries(cors)) denied.headers.set(key, value);
      return denied;
    }

    let response;
    try {
      if (path === '/api/health') response = json({ ok: true });
      else if (path === '/api/version') response = json(await attestSupport());
      else if (path === '/api/auth/x/start') response = await startLogin(request, env);
      else if (path === '/api/auth/x/callback') response = await finishLogin(request, env, ctx);
      else if (path === '/api/auth/logout' && request.method === 'POST') response = logout(request, env);
      else if (path === '/api/me') {
        const user = await sessionUser(request, env);
        // xId is the caller's OWN X id — public on X, and the value an owner
        // needs to put in ADMIN_X_IDS. Without it, standing up the first
        // moderator means digging a numeric id out of a third-party lookup.
        response = user
          ? json({
            signedIn: true,
            handle: user.handle,
            displayName: user.display_name,
            avatarUrl: user.avatar_url,
            xId: user.x_id,
            isMod: streamer.isAdmin(user.x_id, env.ADMIN_X_IDS),
          })
          : json({ signedIn: false });
      }
      else if (path === '/api/me/delete' && request.method === 'POST') {
        // Self-serve erasure: the privacy story requires leaving to be as
        // easy as joining. Removes the account and everything derived.
        const user = await sessionUser(request, env);
        if (!user) response = json({ ok: false, reason: 'not-signed-in' }, 401);
        else {
          // Leave any clan FIRST, through the same path a voluntary leave uses:
          // erasure must not strand a clan without a founder, and it must not
          // leave this user's numbers inside someone else's standing.
          const membership = await membershipOf(env, user.id);
          if (membership) {
            await removeMember(env, membership.clan_id, user.id, membership.founder_id);
          }
          await env.DB.batch([
            env.DB.prepare('DELETE FROM chain_segments WHERE user_id = ?').bind(user.id),
            env.DB.prepare('DELETE FROM clan_entries WHERE user_id = ?').bind(user.id),
            env.DB.prepare('DELETE FROM sprint_entries WHERE user_id = ?').bind(user.id),
            env.DB.prepare('DELETE FROM submissions WHERE user_id = ?').bind(user.id),
            env.DB.prepare('DELETE FROM duel_entries WHERE user_id = ?').bind(user.id),
            env.DB.prepare('DELETE FROM duels WHERE challenger_id = ? OR opponent_id = ?')
              .bind(user.id, user.id),
            env.DB.prepare('DELETE FROM records WHERE user_id = ?').bind(user.id),
            env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id),
          ]);
          // The user row is already gone, so sessionUser finds nobody to bump
          // an epoch for — and does not need to: a token whose uid no longer
          // resolves stops verifying on its own. This only clears the cookie.
          response = await logout(request, env);
        }
      }
      else if (path === '/api/submit' && request.method === 'POST') response = await handleSubmit(request, env);
      else if (path === '/api/leaderboard') response = await edgeCached(request, ctx, BOARD_CACHE_SEC, () => handleLeaderboard(env));
      else if (path === '/api/sprint/current') response = await edgeCached(request, ctx, BOARD_CACHE_SEC, () => handleSprint(env));
      else if (path === '/api/profile') {
        // Normalize into the CACHE KEY, not just into the query. The lookup is
        // `COLLATE NOCASE`, so /api/profile?handle=bob and ?handle=BOB are one
        // profile behind an unbounded number of distinct cache entries — every
        // casing is a guaranteed miss straight through to D1 for a row the
        // edge is already holding.
        const handle = (url.searchParams.get('handle') || '').toLowerCase();
        response = await edgeCached(cacheKey(url, { handle }), ctx, BOARD_CACHE_SEC,
          () => handleProfile(env, handle));
      }
      else if (path === '/api/activity') response = await edgeCached(request, ctx, 20, () => handleActivity(env));
      // Keyed by full URL, so each handle caches separately at the edge; the
      // D1 layer inside the handler is what protects the upstream.
      else if (path === '/api/x-feed') response = await edgeCached(request, ctx, 300, () => handleXFeed(request, env));
      // Duels are live and per-viewer, so they are never edge-cached.
      else if (path === '/api/duel/create' && request.method === 'POST') response = await handleDuelCreate(request, env);
      else if (path === '/api/duel/join' && request.method === 'POST') response = await handleDuelJoin(request, env);
      else if (path === '/api/duel/mine') response = await handleDuelsMine(request, env);
      else if (path === '/api/duel') response = await handleDuelGet(env, url.searchParams.get('code') || '');
      // Clan boards are public reads and cache like the other boards. Anything
      // that names the caller — membership, invite code — never does.
      else if (path === '/api/clans') response = await edgeCached(request, ctx, BOARD_CACHE_SEC, () => handleClans(env));
      else if (path === '/api/clan/mine') response = await handleClanMine(request, env);
      else if (path === '/api/clan/create' && request.method === 'POST') response = await handleClanCreate(request, env);
      else if (path === '/api/clan/join' && request.method === 'POST') response = await handleClanJoin(request, env);
      else if (path === '/api/clan/leave' && request.method === 'POST') response = await handleClanLeave(request, env);
      else if (path === '/api/clan/kick' && request.method === 'POST') response = await handleClanKick(request, env);
      else if (path === '/api/clan/update' && request.method === 'POST') response = await handleClanUpdate(request, env);
      else if (path === '/api/clan') {
        // Same reason as /api/profile: the handler normalizes the tag, so the
        // cache key has to normalize it too or it caches per spelling.
        const tag = clan.normalizeTag(url.searchParams.get('tag') || '');
        response = await edgeCached(cacheKey(url, { tag }), ctx, BOARD_CACHE_SEC,
          () => handleClanGet(env, tag));
      }
      else if (path === '/api/streamer/apply' && request.method === 'POST') {
        response = await handleStreamerApply(request, env);
      }
      // Never edge-cached, unlike the boards: the response is scoped to a
      // moderator session, and a shared cache would serve the queue to the
      // next visitor who asked for the same URL.
      else if (path === '/api/streamer/applications') {
        response = await handleStreamerApplications(request, env);
      }
      else if (path === '/api/streamer/review' && request.method === 'POST') {
        response = await handleStreamerReview(request, env);
      }
      else if (path === '/api/streamer/roster') {
        response = await edgeCached(request, ctx, BOARD_CACHE_SEC, () => handleStreamerRoster(env));
      }
      // Real-trade replay (Indeix). Cached at the edge — a token's candle +
      // trade history is effectively immutable for a closed window.
      else if (path === '/api/replay/history') {
        response = await edgeCached(request, ctx, 60, () => handleReplayHistory(request, env));
      }
      else if (path === '/api/replay/wallet') {
        response = await edgeCached(request, ctx, 60, () => handleReplayWallet(request, env));
      }
      // Moderation. Every one of these re-checks `moderator()` itself — the
      // routing table is not the gate, the handler is.
      else if (path === '/api/admin/users') response = await handleAdminUsers(request, env);
      else if (path === '/api/admin/user') response = await handleAdminUser(request, env);
      else if (path === '/api/admin/log') response = await handleAdminLog(request, env);
      else if (path === '/api/admin/clans') response = await handleAdminClans(request, env);
      else if (path === '/api/admin/user/ban' && request.method === 'POST') {
        response = await handleAdminBan(request, env);
      }
      else if (path === '/api/admin/record/disqualify' && request.method === 'POST') {
        response = await handleAdminDisqualify(request, env);
      }
      else if (path === '/api/admin/clan/disband' && request.method === 'POST') {
        response = await handleAdminClanDisband(request, env);
      }
      else response = json({ ok: false, reason: 'not-found' }, 404);
    } catch (err) {
      // The visitor gets nothing useful (deliberately); `wrangler tail` gets
      // the route and the stack, without which a 500 is only ever reported as
      // "the site is broken" with nothing to go on.
      console.error('unhandled error on', request.method, path, err);
      response = json({ ok: false, reason: 'server-error' }, 500);
    }

    // Belt and braces: if any future response arrives with immutable headers,
    // fall back to a fresh copy rather than throwing a 1101 at the visitor.
    // Set-Cookie is preserved by copying onto the existing Headers object,
    // which a `new Headers(res.headers)` round-trip would fold into one value.
    try {
      for (const [key, value] of Object.entries(cors)) response.headers.set(key, value);
    } catch {
      const copy = new Response(response.body, response);
      for (const [key, value] of Object.entries(cors)) copy.headers.set(key, value);
      return copy;
    }
    return response;
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(drainPricing(env));
  },
};
