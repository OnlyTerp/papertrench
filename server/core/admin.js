/* PaperTrench server — moderation console list reads.
 *
 * The console shows accounts and clans a moderator acts on, so what it does
 * NOT show is a correctness problem rather than a cosmetic one. Both lists
 * shipped as a bare `LIMIT` — 100 accounts, 200 clans — with no paging and no
 * total, which produced the failure this file exists to fix:
 *
 *   - Past the cap the rows simply were not there. The accounts view has a
 *     search box, so a moderator who knew a handle could still reach it; the
 *     clans view has no search at all, so clan 201 was unreachable from the
 *     console entirely.
 *   - Nothing said the list was cut. A hundred rows and a hundred-and-first
 *     account look identical from the page, so "no such account" and "beyond
 *     the limit" were the same screen. That is exactly the confidently-wrong
 *     answer the rest of this project refuses to give.
 *
 * So the queries page, and they report `total` — the console can then say what
 * it is showing out of what exists, rather than implying it is showing all.
 *
 * THE ORDERING TIEBREAK IS LOAD-BEARING. `last_login_at` and `created_at` are
 * not unique, and SQLite gives no stable order among equal keys. Paging on a
 * non-deterministic ORDER BY silently drops rows and repeats others across
 * page boundaries — the same class of bug as the missing rows above, and the
 * reason every ORDER BY here ends in a unique id.
 */
'use strict';

/** Rows per page when the caller does not say. */
const DEFAULT_PAGE = 100;

/** Ceiling on a caller-supplied page size, so one request cannot ask for the
 *  whole table and bill D1 for it. Paging past this is free; asking for it in
 *  one shot is not. */
const MAX_PAGE = 200;

/** A page size: a positive integer, clamped to MAX_PAGE, else the default. */
function pageSize(raw) {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PAGE;
  return Math.min(n, MAX_PAGE);
}

/** An offset: a non-negative integer, else 0. Garbage must not become SQL. */
function pageOffset(raw) {
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n;
}

/** LIKE pattern for a search term, with the wildcards the user typed removed
 *  so a bare `%` cannot match every account. */
function likeTerm(term) {
  return '%' + String(term == null ? '' : term).replace(/[%_]/g, '') + '%';
}

/**
 * The accounts list, paged.
 *
 * The joins are all 1:1 — `records.user_id` and `clan_members.user_id` are
 * both PRIMARY KEY — so LIMIT counts accounts rather than joined rows. Adding
 * a one-to-many join here without a GROUP BY would quietly turn the page size
 * back into a lie.
 */
function adminUsersQuery(options) {
  const opts = options || {};
  const term = String(opts.term == null ? '' : opts.term).trim().toLowerCase();
  const limit = pageSize(opts.limit);
  const offset = pageOffset(opts.offset);
  const like = likeTerm(term);

  const where = `WHERE (?1 = '' OR LOWER(u.handle) LIKE ?2
                     OR LOWER(COALESCE(u.display_name, '')) LIKE ?2
                     OR u.x_id LIKE ?2)`;

  return {
    limit,
    offset,
    sql: `
    SELECT u.id, u.handle, u.display_name, u.x_id, u.avatar_url,
           u.created_at, u.last_login_at, u.banned_at, u.banned_reason,
           r.status AS record_status, r.chain_len, r.stats_json, r.dq_at, r.dq_reason,
           cl.tag AS clan_tag
      FROM users u
      LEFT JOIN records r ON r.user_id = u.id
      LEFT JOIN clan_members cm ON cm.user_id = u.id
      LEFT JOIN clans cl ON cl.id = cm.clan_id
     ${where}
     ORDER BY u.last_login_at DESC, u.id DESC
     LIMIT ?3 OFFSET ?4`,
    binds: [term, like, limit, offset],
    countSql: `SELECT COUNT(*) AS n FROM users u ${where}`,
    countBinds: [term, like],
  };
}

/**
 * The clans list, paged.
 *
 * No search box exists for clans, which is what made the old cap absolute
 * rather than merely inconvenient — paging is the whole route to a clan past
 * the first page.
 */
function adminClansQuery(options) {
  const opts = options || {};
  const limit = pageSize(opts.limit);
  const offset = pageOffset(opts.offset);

  return {
    limit,
    offset,
    sql: `
    SELECT c.id, c.tag, c.name, c.motto, c.open, c.created_at,
           c.disbanded_at, c.disbanded_reason,
           f.handle AS founder,
           (SELECT COUNT(*) FROM clan_members m WHERE m.clan_id = c.id) AS members
      FROM clans c LEFT JOIN users f ON f.id = c.founder_id
     ORDER BY c.created_at DESC, c.id DESC
     LIMIT ?1 OFFSET ?2`,
    binds: [limit, offset],
    countSql: `SELECT COUNT(*) AS n FROM clans`,
    countBinds: [],
  };
}

/**
 * What the page needs to know about where it sits in the list.
 *
 * `total` is the honest denominator; `hasMore` is derived from the offset and
 * the rows actually returned rather than from the requested limit, so a short
 * final page ends the walk instead of offering a "Load more" that fetches
 * nothing.
 */
function pageInfo(total, offset, returned) {
  const n = Math.max(0, Math.floor(Number(total)) || 0);
  const from = Math.max(0, Math.floor(Number(offset)) || 0);
  const got = Math.max(0, Math.floor(Number(returned)) || 0);
  const next = from + got;
  return { total: n, offset: from, returned: got, hasMore: got > 0 && next < n, nextOffset: next };
}

module.exports = {
  DEFAULT_PAGE,
  MAX_PAGE,
  pageSize,
  pageOffset,
  likeTerm,
  adminUsersQuery,
  adminClansQuery,
  pageInfo,
};
