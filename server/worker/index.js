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
import { sessionUser, startLogin, finishLogin, logout } from './auth.js';
import { makeGetCandles } from './candles.js';

const SEG_SIZE = 500;
const SUBMITS_PER_HOUR = 6;
const DUELS_PER_HOUR = 10;
const CLAN_ACTIONS_PER_HOUR = 12;
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
    'Access-Control-Allow-Headers': 'Content-Type',
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

async function storeChain(env, userId, chain) {
  const statements = [
    env.DB.prepare('DELETE FROM chain_segments WHERE user_id = ?').bind(userId),
  ];
  for (let i = 0; i < chain.length; i += SEG_SIZE) {
    statements.push(env.DB.prepare(
      'INSERT INTO chain_segments (user_id, seg_no, links_json) VALUES (?, ?, ?)')
      .bind(userId, Math.floor(i / SEG_SIZE), JSON.stringify(chain.slice(i, i + SEG_SIZE))));
  }
  await env.DB.batch(statements);
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
    'SELECT head, chain_len, starting_sol FROM records WHERE user_id = ?').bind(user.id).first();
  const previous = previousRow
    ? { head: previousRow.head, chainLen: previousRow.chain_len,
        startingSol: previousRow.starting_sol }
    : null;

  const result = await fastChecks(payload, previous);
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO submissions (user_id, head, chain_len, outcome, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(user.id, String(payload && payload.head || ''),
      payload && Array.isArray(payload.chain) ? payload.chain.length : 0,
      result.accepted ? 'accepted' : result.reason, now)
    .run();
  if (!result.accepted) {
    return json({ ok: false, reason: result.reason, problems: result.problems || [] }, 422);
  }

  const start = Number(payload.claim.startingBalanceSol);
  // Badges are chain-derived, so they are computed here rather than on every
  // profile view. The verification-dependent one ('unbroken') can only be
  // earned once re-pricing finishes, so this runs again at that point.
  const badges = awarded({
    chain: payload.chain, startingSol: start, chainLen: payload.chain.length,
    pricingStatus: 'pending', coverage: 0,
  });
  await storeChain(env, user.id, payload.chain);
  await env.DB.prepare(`
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
      JSON.stringify(badges), now)
    .run();

  // Sprint entry for the current window, derived from the same chain.
  const window = windowOf(now);
  const entry = sprintEntry(payload.chain, start, window);
  await env.DB.prepare(`
    INSERT INTO sprint_entries (week_id, user_id, entry_json, score, rounds, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(week_id, user_id) DO UPDATE SET
      entry_json = excluded.entry_json, score = excluded.score,
      rounds = excluded.rounds, updated_at = excluded.updated_at`)
    .bind(window.weekId, user.id, JSON.stringify(entry), entry.score, entry.rounds, now)
    .run();

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
    await env.DB.prepare(`
      INSERT INTO duel_entries (duel_id, user_id, entry_json, submitted_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(duel_id, user_id) DO UPDATE SET
        entry_json = excluded.entry_json, submitted_at = excluded.submitted_at`)
      .bind(duel.id, user.id, JSON.stringify(duelEntry), now)
      .run();
  }

  // And this player's clan slices, if they are in one. Same reason as the duel
  // refresh above: computed once per submission so a clan board is a read.
  await refreshClanEntries(env, user.id, payload.chain, start, now);

  return json({
    ok: true,
    status: 'pending',
    note: 'chain verified and replayed; prices now re-checking against market history',
    stats: result.stats,
    claimMismatch: result.claimMismatch,
    sprint: entry,
  });
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
    ORDER BY r.submitted_at DESC LIMIT 500`).all();
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
    .sort((a, b) => b.stats.score - a.stats.score);
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
    WHERE s.week_id = ? AND s.rounds > 0 AND r.status = 'verified'
    ORDER BY s.score DESC LIMIT 200`).bind(window.weekId).all();
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
async function handleActivity(env) {
  const [subs, verifications] = await Promise.all([
    env.DB.prepare(`
      SELECT s.outcome, s.chain_len, s.created_at, u.handle
      FROM submissions s JOIN users u ON u.id = s.user_id
      ORDER BY s.created_at DESC LIMIT 40`).all(),
    env.DB.prepare(`
      SELECT u.handle, r.status, r.chain_len, r.pricing_json, r.verified_at
      FROM records r JOIN users u ON u.id = r.user_id
      WHERE r.verified_at IS NOT NULL
      ORDER BY r.verified_at DESC LIMIT 25`).all(),
  ]);

  const events = [];
  for (const row of subs.results) {
    const accepted = row.outcome === 'accepted';
    events.push({
      kind: accepted ? 'accepted' : 'rejected',
      // Rejections are anonymous on purpose — see the note above.
      handle: accepted ? row.handle : null,
      detail: accepted ? `chain of ${row.chain_len} links re-hashed, book replayed` : row.outcome,
      ts: row.created_at,
    });
  }
  for (const row of verifications.results) {
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
async function refreshClanEntries(env, userId, chain, startingSol, now) {
  const membership = await membershipOf(env, userId);
  if (!membership) return;
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
    // Nothing verified this run; the next cron tick retries. Log it — a cron
    // that silently returns is indistinguishable from a cron that is not
    // firing, and the difference decides whether anyone goes looking.
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

/* ---------------- entry ---------------- */

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
      else if (path === '/api/auth/x/start') response = await startLogin(request, env);
      else if (path === '/api/auth/x/callback') response = await finishLogin(request, env);
      else if (path === '/api/auth/logout' && request.method === 'POST') response = await logout(request, env);
      else if (path === '/api/me') {
        const user = await sessionUser(request, env);
        response = user
          ? json({ signedIn: true, handle: user.handle, displayName: user.display_name, avatarUrl: user.avatar_url })
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
