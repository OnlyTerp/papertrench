/* Clans introduce exactly one new fact — joined_at — and the whole feature is
 * only honest if that fact actually BOUNDS what a chain contributes. So the
 * tests here are mostly attacks on the boundary: import a back catalogue by
 * joining late, launder a bad week by leaving and rejoining, out-rank a real
 * clan by fielding five lucky accounts, take a name that reads like someone
 * else's.
 *
 * The rest guard the two shapes that are easy to get subtly wrong and
 * impossible to notice: null-vs-zero contribution, and a clan being handed a
 * score before it has enough qualified members to have earned one.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const C = require('../core/clan.js');
const { appendFill, GENESIS } = require('../core/chain.js');
const { windowOf } = require('../core/sprint.js');

const H = 3600000;
const DAY = 24 * H;
const WEEK = windowOf(Date.UTC(2026, 7, 3, 12)); // a Monday-anchored week

async function chainOf(fills) {
  const links = [];
  let prev = GENESIS;
  for (const f of fills) {
    const link = await appendFill(prev, f);
    link.seq = links.length;
    links.push(link);
    prev = link.hash;
  }
  return links;
}

let seq = 0;
function buy(mint, sol, ts) {
  return { id: 'f' + (seq++), sessionId: 's', mint, side: 'buy',
           qty: sol * 1000, priceNative: 0.001, solGross: sol, solNet: sol * 0.99, ts };
}
function sell(mint, qty, price, ts) {
  const gross = qty * price;
  return { id: 'f' + (seq++), sessionId: 's', mint, side: 'sell',
           qty, priceNative: price, solGross: gross, solNet: gross * 0.99, ts };
}

/** One winning round opened and closed at `ts`. */
function round(mint, ts, multiple) {
  return [buy(mint, 1, ts), sell(mint, 1000, 0.001 * multiple, ts + H)];
}

/* ---------------- the boundary ---------------- */

test('joining late cannot import the back catalogue', async () => {
  // Ten winning rounds BEFORE the join, one after.
  const fills = [];
  for (let i = 0; i < 10; i++) fills.push(...round('m' + i, WEEK.startTs + i * H, 3));
  fills.push(...round('after', WEEK.startTs + 5 * DAY, 3));
  const chain = await chainOf(fills);

  const joinedAt = WEEK.startTs + 4 * DAY;
  const entry = C.memberEntry(chain, 10, joinedAt, C.SEASON_WINDOW);
  assert.equal(entry.rounds, 1, 'only the round after joining counts');
  assert.equal(entry.countsFrom, joinedAt);

  // The same chain, credited from the start of time, sees all eleven — proving
  // the difference above is the join bound and not a quirk of the fixture.
  const unbounded = C.memberEntry(chain, 10, 0, C.SEASON_WINDOW);
  assert.equal(unbounded.rounds, 11);
});

test('a member who was not in the clan during a window contributes null, not zero', () => {
  const joinedAfter = WEEK.endTs + DAY;
  assert.equal(C.memberEntry([], 10, joinedAfter, WEEK), null);
  // Present but idle is a DIFFERENT answer, and must not collapse into the
  // same one: it is a real zero.
  const idle = C.memberEntry([], 10, WEEK.startTs, WEEK);
  assert.notEqual(idle, null);
  assert.equal(idle.rounds, 0);
});

test('a mid-window join is credited from the join, not the window open', async () => {
  const chain = await chainOf([
    ...round('early', WEEK.startTs + 1 * DAY, 4),
    ...round('late', WEEK.startTs + 5 * DAY, 4),
  ]);
  const entry = C.memberEntry(chain, 10, WEEK.startTs + 3 * DAY, WEEK);
  assert.equal(entry.rounds, 1);
  assert.equal(entry.countsFrom, WEEK.startTs + 3 * DAY);
});

test('rejoining does not launder the losses that came before it', async () => {
  const chain = await chainOf([
    ...round('loser', WEEK.startTs + 1 * DAY, 0.2),   // a bad round, then "leave"
    ...round('winner', WEEK.startTs + 5 * DAY, 4),
  ]);
  // Rejoining after the loss does hide it from the clan — that is the design:
  // the clan only ever sees membership. What it must NOT do is change the
  // player's own record, which is the number the leaderboard ranks.
  const afterRejoin = C.memberEntry(chain, 10, WEEK.startTs + 3 * DAY, WEEK);
  assert.equal(afterRejoin.rounds, 1);
  const own = C.memberEntry(chain, 10, 0, WEEK);
  assert.equal(own.rounds, 2, 'the personal record still carries both rounds');
});

/* ---------------- standings ---------------- */

const member = (handle, score, rounds, pnlSol) => ({
  handle, avatarUrl: null, status: 'verified', joinedAt: 0,
  entry: { score, rounds, pnlSol, roiPct: score },
});

test('a clan is unranked until COUNTING_MEMBERS members qualify', () => {
  const four = [1, 2, 3, 4].map((i) => member('a' + i, 50, 20, 5));
  const standing = C.standing(four, { minRounds: C.MIN_SEASON_ROUNDS });
  assert.equal(standing.ranked, false);
  assert.equal(standing.score, null, 'no score is better than a score built from four');
  assert.equal(standing.needed, 1);

  const five = four.concat(member('a5', 50, 20, 5));
  assert.equal(C.standing(five, { minRounds: C.MIN_SEASON_ROUNDS }).ranked, true);
});

test('a member below the round floor cannot be one of the counting five', () => {
  const five = [1, 2, 3, 4].map((i) => member('a' + i, 50, 20, 5))
    .concat(member('lucky', 999, 1, 40));
  const standing = C.standing(five, { minRounds: C.MIN_SEASON_ROUNDS });
  assert.equal(standing.qualified, 4);
  assert.equal(standing.ranked, false, 'one lucky round does not complete a roster');
  assert.ok(!standing.counting.some((m) => m.handle === 'lucky'));
});

test('the score is the counting five, and recruiting cannot inflate it', () => {
  const five = [1, 2, 3, 4, 5].map((i) => member('a' + i, 60, 20, 5));
  const withPadding = five.concat([6, 7, 8, 9].map((i) => member('b' + i, 10, 20, 1)));
  const lean = C.standing(five, { minRounds: C.MIN_SEASON_ROUNDS });
  const padded = C.standing(withPadding, { minRounds: C.MIN_SEASON_ROUNDS });
  assert.equal(lean.score, 60);
  assert.equal(padded.score, 60, 'nine members, same five counting scores');
  // Totals still describe the whole clan, and are a different number on purpose.
  assert.equal(lean.rounds, 100);
  assert.equal(padded.rounds, 180);
});

test('roster, active and qualified are three different counts', () => {
  const members = [
    member('trader', 50, 20, 5),
    Object.assign(member('idle', 0, 0, 0)),
    { handle: 'absent', joinedAt: 0, entry: null },
  ];
  const standing = C.standing(members, { minRounds: 10 });
  assert.equal(standing.roster, 3, 'everyone on the roster');
  assert.equal(standing.active, 1, 'only those with a closed round');
  assert.equal(standing.qualified, 1);
});

/* ---------------- naming ---------------- */

test('confusable names collide, so a roster cannot be renamed into a rival', () => {
  assert.equal(C.nameKey('Trench Rats'), C.nameKey('trenchrats'));
  assert.equal(C.nameKey('Trench Rats'), C.nameKey('TrenchR4ts'));
  assert.equal(C.nameKey('Trench Rats'), C.nameKey('Tr3nch-R4ts!'));
  assert.notEqual(C.nameKey('Trench Rats'), C.nameKey('Trench Cats'));
});

test('tags are uppercase alphanumeric and bounded', () => {
  assert.equal(C.normalizeTag(' pt! '), 'PT');
  assert.equal(C.normalizeTag('abcdefgh'), 'ABCDE');
  assert.equal(C.createProblem({ tag: 'A', name: 'Long Enough' }), 'tag-too-short');
  assert.equal(C.createProblem({ tag: 'ABCDEFG', name: 'Long Enough' }), 'tag-too-long');
  assert.equal(C.createProblem({ tag: 'PT', name: 'no' }), 'name-too-short');
  assert.equal(C.createProblem({ tag: 'PT', name: '!!!!' }), 'name-invalid');
  assert.equal(C.createProblem({ tag: 'PT', name: 'Trench Rats' }), null);
  assert.equal(C.createProblem({ tag: 'PT', name: 'Trench Rats', alreadyInClan: true }),
    'already-in-a-clan');
});

test('a motto cannot smuggle newlines or control characters into a listing', () => {
  assert.equal(C.cleanMotto('we\ntrade\r\nthe\tplan'), 'we trade the plan');
  assert.equal(C.cleanMotto('  spaced   out  '), 'spaced out');
  assert.equal(C.cleanMotto(null), '');
  assert.equal(C.cleanMotto('x'.repeat(500)).length, C.MOTTO_MAX);
  assert.equal(C.mottoProblem('x'.repeat(5000)), 'motto-too-long');
  assert.equal(C.mottoProblem(null), null);
});

test('invite codes survive a round trip through a chat client', () => {
  assert.equal(C.normalizeCode('clan-ab2cd9'), C.normalizeCode('CLAN-AB2CD9'));
  assert.equal(C.normalizeCode(' clan ab2cd9 '), 'CLAN-AB2CD9');
  assert.equal(C.normalizeCode(''), '');
});

/* ---------------- membership rules ---------------- */

test('an invite-only clan says which of the two things went wrong', () => {
  const closed = { open: false, joinCode: 'CLAN-AB2CD9' };
  assert.equal(C.joinProblem(closed, 3, {}), 'invite-only');
  assert.equal(C.joinProblem(closed, 3, { code: 'CLAN-WRONG1' }), 'bad-code');
  assert.equal(C.joinProblem(closed, 3, { code: 'clan ab2cd9' }), null);
  assert.equal(C.joinProblem({ open: true }, 3, {}), null);
});

test('a join is refused for the reason that applies first', () => {
  assert.equal(C.joinProblem(null, 0, {}), 'not-found');
  assert.equal(C.joinProblem({ open: true }, 0, { alreadyInClan: true }), 'already-in-a-clan');
  assert.equal(C.joinProblem({ open: true }, C.MAX_MEMBERS, {}), 'clan-full');
});

test('only the founder kicks, and never themselves', () => {
  assert.equal(C.kickProblem({ founderId: 1 }, 1, 2), null);
  assert.equal(C.kickProblem({ founderId: 1 }, 2, 3), 'not-founder');
  assert.equal(C.kickProblem({ founderId: 1 }, 1, 1), 'cannot-kick-yourself');
  // String ids out of D1 must not defeat the ownership check.
  assert.equal(C.kickProblem({ founderId: '1' }, 1, 2), null);
});

test('the clan passes to its longest-standing member, or is disbanded', () => {
  const roster = [
    { userId: 1, joinedAt: 100 },  // founder
    { userId: 3, joinedAt: 300 },
    { userId: 2, joinedAt: 200 },
  ];
  assert.equal(C.successor(roster, 1).userId, 2);
  assert.equal(C.successor([{ userId: 1, joinedAt: 100 }], 1), null,
    'last one out disbands rather than leaving an ownerless shell');
});
