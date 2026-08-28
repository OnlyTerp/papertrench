/* PaperTrench worker — the Friday reckoning lane (DELIGHT-MAP.md B2).
 *
 * Cron half of the ritual: when the bell window is open, post each ranked
 * clan's digest to its Discord webhook and mark the week done. The mark IS
 * the claim — the row is written before the POST fires, so a retried firing
 * can never double-post a clan's week. The window stays open 24h (core law)
 * so a Friday-night deploy or outage doesn't skip the ritual; after that the
 * week is left unposted, never posted late.
 *
 * The digest is derived from clan_entries exactly the way the public clan
 * page is (clanEntries → clan.standing) — there is no second book. Transport
 * laws inherited from bot/run.js: DRY_RUN defaults TRUE (nothing sends until
 * a deploy deliberately flips it), KILL_SWITCH=true polls but never sends.
 * The webhook URL is per-clan config in D1 (clans.reckoning_webhook), never
 * a per-call argument, so a caller can't point the ritual at someone else's
 * channel.
 */
'use strict';

const reckoning = require('../core/reckoning.js');
const clan = require('../core/clan.js');
const { windowOf } = require('../core/sprint.js');

/** Post one payload. Injectable for tests; default = Discord webhook. */
function defaultPost(url, payload) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/** Ranked clans' week standings, derived the same way the public clan page
 * derives them (clanEntries → clan.standing) — read here as its own query so
 * the cron shares the clan.standing math without touching request-path
 * helpers. */
async function weekStandings(env, weekId) {
  // Two jobs, one shape. Driving from clans (LEFT JOIN) rather than from
  // clan_entries (inner join) fixes two defects at once:
  //   (a) an opted-in clan whose members closed no rounds this week still
  //       gets its digest — "no rounds closed, streaks held" is a real
  //       message, not an absence; the inner join made that branch
  //       unreachable dead code;
  //   (b) a disbanded clan can never post again — the soft flag was written
  //       by admin and read by nothing.
  const rows = await env.DB.prepare(`
    SELECT c.id AS clan_id, c.tag, c.name, c.reckoning_webhook, c.created_at,
           e.entry_json, u.handle, m.joined_at, r.status
    FROM clans c
    LEFT JOIN clan_entries e ON e.clan_id = c.id AND e.window_id = ?
    LEFT JOIN clan_members m ON m.user_id = e.user_id AND m.clan_id = c.id
    LEFT JOIN users u ON u.id = e.user_id
    LEFT JOIN records r ON r.user_id = e.user_id
    WHERE c.disbanded_at IS NULL`).bind(weekId).all();
  const list = (rows && rows.results) || [];

  const byClan = new Map();
  for (const row of list) {
    if (!byClan.has(row.clan_id)) {
      byClan.set(row.clan_id, {
        clan_id: row.clan_id, tag: row.tag, name: row.name,
        reckoning_webhook: row.reckoning_webhook, created_at: row.created_at,
        members: [],
      });
    }
    // LEFT JOIN miss = no entry row for this member in the window; the clan
    // still counts its roster, the member just closed nothing. A member with
    // a null entry is not a real member row — skip it. Same for a stale entry
    // whose user has since left the clan (membership row gone, handle null):
    // the old inner join dropped those, and the digest must not resurrect a
    // departed trader's week.
    if (row.entry_json == null || row.handle == null) continue;
    byClan.get(row.clan_id).members.push({
      handle: row.handle,
      status: row.status || 'pending',
      joinedAt: row.joined_at,
      entry: JSON.parse(row.entry_json),
    });
  }

  const out = [];
  for (const c of byClan.values()) {
    // Only clans that wired a webhook get the ritual — an unset webhook is
    // an operator choice, not an error to log as a failure.
    if (!c.reckoning_webhook) continue;
    out.push({
      ...c,
      standing: clan.standing(c.members, { minRounds: clan.MIN_WEEK_ROUNDS }),
    });
  }
  out.sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
  return out;
}

/** The lane. `deps` overrides the clock, the fetch, and the gates for tests. */
async function postDueReckonings(env, deps) {
  const d = deps || {};
  const now = Number.isFinite(d.now) ? d.now : Date.now();
  const post = d.post || defaultPost;
  const killSwitch = d.killSwitch === true;
  const dryRun = d.dryRun !== false; // default true, like bot/run.js

  // Clock gate FIRST: the common case (23h of the week) exits without a
  // single query. scheduled() shares every tick with the pricing drain.
  if (!reckoning.isDue(now)) return { posted: 0, skipped: 'not-due', weekId: null };

  const weekId = reckoning.weekIdFor(now);
  const week = windowOf(reckoning.bellTs(now));

  const clans = await weekStandings(env, weekId);
  if (!clans.length) return { posted: 0, skipped: 'no-clans', weekId };

  // Already-posted marks for this week — the idempotence set.
  const postedRows = await env.DB.prepare(
    'SELECT clan_id FROM reckoning_posts WHERE week_id = ?').bind(weekId).all();
  const done = new Set(((postedRows && postedRows.results) || []).map((r) => r.clan_id));

  const log = [];
  let posted = 0;

  for (const c of clans) {
    if (done.has(c.clan_id)) {
      log.push({ clan: c.tag, action: 'already-posted' });
      continue;
    }
    // THE MARK IS THE CLAIM: write first. A crash between mark and POST
    // loses this week's post for the clan (honest absence); a crash after
    // the mark can never double-post. A failed HTTP call leaves the mark —
    // the log says 'post-failed' and the week is NOT silently re-fired next
    // minute (that would risk double-posting); the operator re-runs by hand.
    await env.DB.prepare(
      'INSERT INTO reckoning_posts (week_id, clan_id, posted_at) VALUES (?, ?, ?)')
      .bind(weekId, c.clan_id, now).run();

    if (killSwitch || dryRun) {
      log.push({ clan: c.tag, action: killSwitch ? 'kill-switch' : 'dry-run' });
      continue;
    }

    const payload = reckoning.buildDigest({ name: c.name, tag: c.tag }, week, c.standing);
    try {
      const res = await post(c.reckoning_webhook, payload);
      if (res && res.ok) {
        posted += 1;
        log.push({ clan: c.tag, action: 'posted', status: res.status });
      } else {
        log.push({ clan: c.tag, action: 'post-failed', status: res ? res.status : 'no-response' });
      }
    } catch (e) {
      log.push({ clan: c.tag, action: 'post-error', error: String((e && e.message) || e) });
    }
  }

  return { posted, weekId, log };
}

module.exports = { postDueReckonings, weekStandings, defaultPost };
