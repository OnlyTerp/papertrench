/* The rate-limit statement, run against real SQLite.
 *
 * D1 is SQLite, and the thing worth proving here is not JavaScript — it is
 * that ONE statement both increments and reports, so two callers can never
 * read the same count and both decide they are under the cap. The version this
 * replaced was SELECT-then-UPDATE, which is a check-then-act race: fire six
 * submissions together and all six read `count: 0`.
 *
 * node:sqlite is unavailable before Node 22.5, so this skips rather than fails
 * on an older runtime — the same choice the extension's live-API test makes
 * when it is offline. It is a check on the SQL, not a gate on the suite.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

let DatabaseSync = null;
try { ({ DatabaseSync } = require('node:sqlite')); } catch { /* older Node */ }

const SCHEMA = `
  CREATE TABLE rate_limits (
    key TEXT PRIMARY KEY,
    window_start INTEGER NOT NULL,
    count INTEGER NOT NULL
  );`;

// Kept character-for-character in step with allowRate() in worker/index.js.
const BUMP = `
  INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
  ON CONFLICT(key) DO UPDATE SET
    count = CASE WHEN rate_limits.window_start = excluded.window_start
                 THEN rate_limits.count + 1 ELSE 1 END,
    window_start = excluded.window_start
  RETURNING count`;

const WINDOW = 1770000000000;
const PER_HOUR = 6;

function limiter() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const stmt = db.prepare(BUMP);
  return (key, windowStart) => {
    const row = stmt.get(key, windowStart);
    return { allowed: Number(row.count) <= PER_HOUR, count: Number(row.count) };
  };
}

test('the statement both increments and reports, so the Nth caller sees N',
  { skip: !DatabaseSync && 'node:sqlite unavailable on this runtime' }, () => {
    const bump = limiter();
    const counts = [];
    for (let i = 0; i < 8; i++) counts.push(bump('submit:1', WINDOW).count);
    assert.deepEqual(counts, [1, 2, 3, 4, 5, 6, 7, 8],
      'no caller may observe a count another caller already claimed');
  });

test('the cap admits exactly perHour calls and refuses the rest',
  { skip: !DatabaseSync && 'node:sqlite unavailable on this runtime' }, () => {
    const bump = limiter();
    const verdicts = [];
    for (let i = 0; i < 8; i++) verdicts.push(bump('submit:1', WINDOW).allowed);
    assert.deepEqual(verdicts, [true, true, true, true, true, true, false, false]);
  });

test('a new window resets the counter rather than carrying it',
  { skip: !DatabaseSync && 'node:sqlite unavailable on this runtime' }, () => {
    const bump = limiter();
    for (let i = 0; i < PER_HOUR; i++) bump('submit:1', WINDOW);
    assert.equal(bump('submit:1', WINDOW).allowed, false, 'exhausted in this window');
    const next = bump('submit:1', WINDOW + 3600000);
    assert.equal(next.count, 1);
    assert.equal(next.allowed, true, 'the next hour starts clean');
  });

test('keys are independent, so one user cannot exhaust another',
  { skip: !DatabaseSync && 'node:sqlite unavailable on this runtime' }, () => {
    const bump = limiter();
    for (let i = 0; i < 8; i++) bump('submit:1', WINDOW);
    assert.equal(bump('submit:2', WINDOW).allowed, true);
    assert.equal(bump('clan:1', WINDOW).count, 1);
  });
