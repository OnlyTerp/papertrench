'use strict';
// Sprint crowns — the weekly #1 tag.
//
// The crown is the one award on the platform that is not derived from the
// chain at read time: it is WRITTEN once, when a week closes, and then it is
// history. That makes three properties load-bearing, and each is pinned here:
//
//   never mid-week   a crown handed out while the week runs names a leader,
//                    not a winner, and would have to be revoked
//   never twice      the cron fires every minute; a retry, a restart or two
//                    concurrent ticks must all collapse to one row
//   never invented   a week nobody qualified for stays uncrowned rather than
//                    being awarded to the least-bad entry

const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../core/sprint.js');

const WEEK = S.WEEK_MS;

test('only a CLOSED window is settleable', () => {
  const now = Date.UTC(2026, 8, 3, 12); // mid-week
  const open = S.windowOf(now);
  assert.equal(S.isClosed(open, now), false, 'the running week is never settleable');

  const closed = S.lastClosedWindow(now);
  assert.equal(S.isClosed(closed, now), true);
  assert.ok(closed.endTs <= now, 'lastClosedWindow must be behind us');
  assert.equal(closed.endTs, open.startTs, 'and must be the week immediately before');
});

test('the boundary belongs to the next week, so a week is not closed on its endTs-1', () => {
  const w = S.windowOf(Date.UTC(2026, 8, 3));
  assert.equal(S.isClosed(w, w.endTs - 1), false);
  assert.equal(S.isClosed(w, w.endTs), true, 'closed the instant the window ends');
});

test('lastClosedWindow walks back exactly one week, every week', () => {
  let now = Date.UTC(2026, 0, 7, 9, 30);
  for (let i = 0; i < 60; i++) {
    const prev = S.lastClosedWindow(now);
    const cur = S.windowOf(now);
    assert.equal(cur.startTs - prev.startTs, WEEK, 'no gap and no overlap at week ' + i);
    now += WEEK;
  }
});

test('the crown goes to the top of the SAME order the board renders', () => {
  const entries = [
    { handle: 'mid', score: 10, rounds: 6, updatedAt: 100 },
    { handle: 'top', score: 42, rounds: 9, updatedAt: 200 },
    { handle: 'low', score: -3, rounds: 5, updatedAt: 50 },
  ];
  assert.equal(S.crownFrom(entries).handle, 'top');
});

test('a tie is broken by the earlier entry, then by handle — never at random', () => {
  const first = { handle: 'zed', score: 10, rounds: 5, updatedAt: 100 };
  const later = { handle: 'abe', score: 10, rounds: 5, updatedAt: 900 };
  assert.equal(S.crownFrom([later, first]).handle, 'zed',
    'first to prove the score keeps it — a later submitter cannot displace by equalling');

  // Same score AND same instant: the fixed final key decides, so two reads
  // of the same week never disagree about who won it.
  const a = { handle: 'abe', score: 10, rounds: 5, updatedAt: 100 };
  const z = { handle: 'zed', score: 10, rounds: 5, updatedAt: 100 };
  assert.equal(S.crownFrom([z, a]).handle, 'abe');
  assert.equal(S.crownFrom([a, z]).handle, 'abe', 'input order must not matter');
});

test('a week with nobody eligible is left UNCROWNED', () => {
  assert.equal(S.crownFrom([]), null);
  assert.equal(S.crownFrom(null), null);
  // rounds: 0 is an entry that traded nothing inside the window — it is not
  // a winner, it is an absence, and the board does not rank it either.
  assert.equal(S.crownFrom([{ handle: 'nobody', score: 99, rounds: 0 }]), null,
    'a zero-round entry must never be crowned, however high its score sorts');
});

test('a negative week still has a winner — losing least is still first', () => {
  const entries = [
    { handle: 'bad', score: -50, rounds: 5, updatedAt: 1 },
    { handle: 'less-bad', score: -2, rounds: 5, updatedAt: 2 },
  ];
  assert.equal(S.crownFrom(entries).handle, 'less-bad',
    'a red week is a real week; refusing to crown it would quietly gate the tag on profit');
});

test('crownFrom does not mutate the caller array', () => {
  const entries = [
    { handle: 'a', score: 1, rounds: 5, updatedAt: 1 },
    { handle: 'b', score: 9, rounds: 5, updatedAt: 2 },
  ];
  const before = entries.map((e) => e.handle).join(',');
  S.crownFrom(entries);
  assert.equal(entries.map((e) => e.handle).join(','), before,
    'sorting in place would reorder the caller’s board');
});
