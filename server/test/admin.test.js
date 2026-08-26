/* The moderation console's list reads.
 *
 * The bug these exist for: both lists shipped as a bare LIMIT (100 accounts,
 * 200 clans) with no paging and no total, so past the cap the rows were simply
 * absent and nothing on the page said so. The clans view has no search box, so
 * clan 201 was unreachable from the console at all.
 *
 * Two things are asserted here, and the second is the subtle one:
 *
 *  1. Every row is REACHABLE by walking the pages — the count is derived from
 *     a simulated table rather than pasted, so it cannot bless an off-by-one.
 *  2. The walk is EXHAUSTIVE AND DISJOINT. Paging over a non-unique ORDER BY
 *     silently drops rows and repeats others across page boundaries, which
 *     looks exactly like the bug it was meant to fix. The ORDER BY therefore
 *     ends in a unique id, and the walk below is checked for both loss and
 *     duplication, not merely for total count.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const A = require('../core/admin.js');

/* ---------- page-size and offset clamping ---------- */

test('page size falls back to the default and is capped', () => {
  assert.equal(A.pageSize(undefined), A.DEFAULT_PAGE);
  assert.equal(A.pageSize(null), A.DEFAULT_PAGE);
  assert.equal(A.pageSize(''), A.DEFAULT_PAGE);
  assert.equal(A.pageSize('not a number'), A.DEFAULT_PAGE);
  assert.equal(A.pageSize(0), A.DEFAULT_PAGE);
  assert.equal(A.pageSize(-5), A.DEFAULT_PAGE);
  assert.equal(A.pageSize(25), 25);
  assert.equal(A.pageSize('25'), 25);
  // One request must not be able to ask for the whole table.
  assert.equal(A.pageSize(1e9), A.MAX_PAGE);
  assert.equal(A.pageSize(A.MAX_PAGE + 1), A.MAX_PAGE);
});

test('offset refuses garbage rather than passing it to SQL', () => {
  assert.equal(A.pageOffset(undefined), 0);
  assert.equal(A.pageOffset('abc'), 0);
  assert.equal(A.pageOffset(-10), 0);
  assert.equal(A.pageOffset('40'), 40);
  assert.equal(A.pageOffset(40.9), 40);
});

test('a search term cannot smuggle in LIKE wildcards', () => {
  // A bare % would otherwise match every account, which is the opposite of
  // what a moderator typing it means.
  assert.equal(A.likeTerm('%'), '%%');
  assert.equal(A.likeTerm('a_b%c'), '%abc%');
  assert.equal(A.likeTerm(''), '%%');
  assert.equal(A.likeTerm(null), '%%');
});

/* ---------- the ordering tiebreak ---------- */

test('both list queries order by a unique id last', () => {
  // Without this, equal last_login_at / created_at values have no defined
  // order, and a paged walk over them loses and repeats rows.
  assert.match(A.adminUsersQuery({}).sql, /ORDER BY u\.last_login_at DESC, u\.id DESC/);
  assert.match(A.adminClansQuery({}).sql, /ORDER BY c\.created_at DESC, c\.id DESC/);
});

test('both list queries page rather than truncating', () => {
  const users = A.adminUsersQuery({ limit: 10, offset: 30 });
  assert.match(users.sql, /LIMIT \?3 OFFSET \?4/);
  assert.deepEqual(users.binds.slice(2), [10, 30]);

  const clans = A.adminClansQuery({ limit: 10, offset: 30 });
  assert.match(clans.sql, /LIMIT \?1 OFFSET \?2/);
  assert.deepEqual(clans.binds, [10, 30]);
});

test('the accounts search also matches a display name', () => {
  // A moderator handed a display name had no way to find the account before.
  const { sql } = A.adminUsersQuery({ term: 'x' });
  assert.match(sql, /LOWER\(COALESCE\(u\.display_name, ''\)\) LIKE \?2/);
});

test('the count query counts the same set the page selects', () => {
  // A total taken from a different WHERE would be a confidently wrong
  // denominator — worse than no denominator.
  const { sql, countSql, binds, countBinds } = A.adminUsersQuery({ term: 'ab' });
  const whereOf = (s) => s.slice(s.indexOf('WHERE')).replace(/\s+/g, ' ').split('ORDER BY')[0].trim();
  assert.equal(whereOf(countSql), whereOf(sql));
  assert.deepEqual(countBinds, binds.slice(0, 2));
});

/* ---------- pageInfo ---------- */

test('pageInfo reports more only while rows remain', () => {
  assert.deepEqual(A.pageInfo(250, 0, 100), { total: 250, offset: 0, returned: 100, hasMore: true, nextOffset: 100 });
  assert.deepEqual(A.pageInfo(250, 100, 100), { total: 250, offset: 100, returned: 100, hasMore: true, nextOffset: 200 });
  // The last page is short: the walk ends here rather than offering a
  // "Load more" that would fetch nothing.
  assert.deepEqual(A.pageInfo(250, 200, 50), { total: 250, offset: 200, returned: 50, hasMore: false, nextOffset: 250 });
});

test('pageInfo never promises more after an empty page', () => {
  assert.equal(A.pageInfo(250, 250, 0).hasMore, false);
  assert.equal(A.pageInfo(0, 0, 0).hasMore, false);
});

/* ---------- the walk: every row reachable, exactly once ---------- */

/**
 * A stand-in table ordered exactly as the SQL orders it, then served through
 * the same limit/offset the handler computes. This is what proves the paging
 * contract without needing D1 — node:sqlite is unavailable on Node 20, which
 * is what CI runs.
 */
function walk(total, { pageLimit, ties = 1 }) {
  // `ties` collapses the sort key so many rows share one — the condition that
  // breaks a paged walk when the ORDER BY has no unique tiebreak.
  const rows = Array.from({ length: total }, (_, i) => ({
    id: i + 1,
    sortKey: Math.floor(i / ties),
  }));

  const seen = [];
  let offset = 0;
  for (let guard = 0; guard <= total + 2; guard++) {
    const q = A.adminUsersQuery({ limit: pageLimit, offset });

    // Order the way the QUERY says to, not the way this test would like. If
    // the SQL carries the unique tiebreak the order is total and stable; if it
    // does not, ties have no defined order and SQLite is free to return them
    // differently per statement. `spin` models exactly that freedom — it is
    // what turns a missing tiebreak into observable row loss below, instead of
    // a bug this helper quietly papers over.
    const stable = /ORDER BY[^]*?u\.id\b/.test(q.sql);
    // Alternate the tie order page to page: the mildest possible instability,
    // and enough to lose rows if the query relies on ties landing the same way
    // twice. A stable query is unaffected by it.
    const flip = !stable && Math.floor(q.offset / Math.max(1, q.limit)) % 2 === 1;
    const ordered = [...rows].sort((a, b) =>
      b.sortKey - a.sortKey || (flip ? a.id - b.id : b.id - a.id));

    const page = ordered.slice(q.offset, q.offset + q.limit);
    seen.push(...page.map((r) => r.id));
    const info = A.pageInfo(total, q.offset, page.length);
    if (!info.hasMore) return seen;
    offset = info.nextOffset;
  }
  throw new Error('page walk did not terminate');
}

test('a walk reaches every account past the old 100-row cap', () => {
  const total = 347;                       // more than the old LIMIT 100
  const seen = walk(total, { pageLimit: 100 });
  assert.equal(seen.length, total, 'walk did not return every row');
  assert.equal(new Set(seen).size, total, 'walk returned a row twice');
  // Derived from the input, not pasted: every id 1..total exactly once.
  assert.deepEqual([...seen].sort((a, b) => a - b), Array.from({ length: total }, (_, i) => i + 1));
});

test('a walk stays exhaustive when tied sort keys straddle a page edge', () => {
  // 150 rows per distinct sort-key value against a 100-row page, so a tie
  // group deliberately spans a page boundary — the only place a missing
  // ORDER BY tiebreak can actually lose a row. (Ties that align exactly with
  // the page size cannot show the bug, which is why this is 150 and not 100.)
  const total = 400;
  const seen = walk(total, { pageLimit: 100, ties: 150 });
  assert.equal(seen.length, total, 'tied sort keys returned the wrong row count');
  assert.equal(new Set(seen).size, total, 'tied sort keys lost or duplicated rows');
});

test('a walk terminates when the total is an exact multiple of the page', () => {
  // The off-by-one case: the final full page must not promise another one.
  const total = 200;
  const seen = walk(total, { pageLimit: 100 });
  assert.equal(seen.length, total);
  assert.equal(new Set(seen).size, total);
});

test('a single short page is the whole list', () => {
  const seen = walk(7, { pageLimit: 100 });
  assert.deepEqual(seen.sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7]);
});
