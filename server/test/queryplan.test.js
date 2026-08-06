/* Every hot read must be index-backed, and must stay that way.
 *
 * D1 bills on rows_read, so an unindexed board is charged as well as slow —
 * and the failure is invisible in every other test, because a scan over eleven
 * rows is instant. It only shows up as a bill and a latency graph once there
 * are enough records to matter, which is exactly when nobody wants to be
 * adding indexes.
 *
 * So the assertion is on the PLAN, not on a timing: run EXPLAIN QUERY PLAN
 * against the real schema.sql and refuse a full table scan or a temp B-tree
 * sort. Add a query to a board without an index and this goes red on the PR.
 *
 * Skips rather than fails where node:sqlite is unavailable (< 22.5), the same
 * choice the extension's live-API test makes when it is offline.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let DatabaseSync = null;
try { ({ DatabaseSync } = require('node:sqlite')); } catch { /* older Node */ }

const skip = !DatabaseSync && 'node:sqlite unavailable on this runtime';

function planner() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8'));
  return (sql) => db.prepare('EXPLAIN QUERY PLAN ' + sql).all().map((r) => r.detail);
}

/** A full table scan: "SCAN <table>" with no index. An ordered walk of an
 * index ("SCAN x USING INDEX ...") under a LIMIT is fine and is not this. */
const fullScan = (lines) => lines.filter((d) => /^SCAN (?!.*USING (COVERING )?INDEX)/.test(d));
const tempSort = (lines) => lines.filter((d) => /USE TEMP B-TREE/.test(d));

function assertIndexed(plan, sql, label) {
  const lines = plan(sql);
  assert.deepEqual(fullScan(lines), [], `${label}: full table scan\n  ${lines.join('\n  ')}`);
  assert.deepEqual(tempSort(lines), [], `${label}: temp B-tree sort\n  ${lines.join('\n  ')}`);
}

test('the leaderboard is index-backed', { skip }, () => {
  assertIndexed(planner(), `
    SELECT u.handle, r.status, r.stats_json, r.chain_len, r.verified_at, cl.tag
    FROM records r JOIN users u ON u.id = r.user_id
    LEFT JOIN clan_members cm ON cm.user_id = r.user_id
    LEFT JOIN clans cl ON cl.id = cm.clan_id
    WHERE r.status = 'verified'
    ORDER BY r.submitted_at DESC LIMIT 500`, 'leaderboard');
});

test('the sprint board is index-backed', { skip }, () => {
  assertIndexed(planner(), `
    SELECT u.handle, r.status, s.entry_json, cl.tag
    FROM sprint_entries s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN records r ON r.user_id = s.user_id
    LEFT JOIN clan_members cm ON cm.user_id = s.user_id
    LEFT JOIN clans cl ON cl.id = cm.clan_id
    WHERE s.week_id = ? AND s.rounds > 0 AND r.status = 'verified'
    ORDER BY s.score DESC LIMIT 200`, 'sprint');
});

test('a profile resolves its handle by index, not by scanning users', { skip }, () => {
  // COLLATE NOCASE on the query means the INDEX has to declare it too, or it
  // is simply not eligible and the planner falls back to a scan without
  // saying so anywhere except here.
  assertIndexed(planner(), 'SELECT id, handle FROM users WHERE handle = ? COLLATE NOCASE',
    'profile handle');
});

test('the activity feed is index-backed on both halves', { skip }, () => {
  const plan = planner();
  assertIndexed(plan, `
    SELECT u.handle, r.status, r.pricing_json, r.verified_at
    FROM records r JOIN users u ON u.id = r.user_id
    WHERE r.verified_at IS NOT NULL
    ORDER BY r.verified_at DESC LIMIT 25`, 'activity/verifications');

  // The submissions half walks idx_submissions_created in order and stops at
  // 40. That is an ordered index scan, not a table scan, and crucially not a
  // sort — the whole feed used to build a temp B-tree over every submission
  // ever made in order to return the newest forty.
  const lines = plan(`
    SELECT s.outcome, s.chain_len, s.created_at, u.handle
    FROM submissions s JOIN users u ON u.id = s.user_id
    ORDER BY s.created_at DESC LIMIT 40`);
  assert.deepEqual(tempSort(lines), [], 'activity/submissions must not sort');
  assert.ok(lines.some((d) => /idx_submissions_created/.test(d)),
    'activity/submissions must walk the created_at index\n  ' + lines.join('\n  '));
});

test('the pricing cron does not scan records once a minute forever', { skip }, () => {
  assertIndexed(planner(), `
    SELECT user_id, starting_sol, pricing_progress_json FROM records
    WHERE status = 'pending'
      AND COALESCE(json_extract(pricing_progress_json, '$.stalledUntil'), 0) <= ?
    ORDER BY submitted_at ASC LIMIT 1`, 'pricing cron');
});

test('one index serves both directions of status + submitted_at', { skip }, () => {
  // The board reads it DESC and the cron reads it ASC. If a future change
  // splits these into two indexes, this test still passes — it is here to
  // record WHY there is only one, so nobody adds the second by reflex.
  const plan = planner();
  const board = plan(`SELECT user_id FROM records WHERE status = 'verified'
                      ORDER BY submitted_at DESC LIMIT 500`);
  const cron = plan(`SELECT user_id FROM records WHERE status = 'pending'
                     ORDER BY submitted_at ASC LIMIT 1`);
  for (const [label, lines] of [['DESC', board], ['ASC', cron]]) {
    assert.ok(lines.some((d) => /idx_records_status_submitted/.test(d)),
      `${label} should use idx_records_status_submitted\n  ` + lines.join('\n  '));
    assert.deepEqual(tempSort(lines), [], `${label} must not sort`);
  }
});
