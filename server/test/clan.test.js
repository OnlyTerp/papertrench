/* Clans add the first thing in this product that a person can put on a
 * leaderboard without having traded it themselves: other people's records. So
 * every test here is an attack on that seam — donate a past record to a clan,
 * carry a clan with one hero, buy a rank by recruiting bodies, raise a score by
 * expelling the weak, hide a rejected record inside a roster, or impersonate
 * another clan with a character nobody can see.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const C = require('../core/clan.js');
const { appendFill, GENESIS } = require('../core/chain.js');
const { windowOf } = require('../core/sprint.js');

const H = 3600000;
const T0 = Date.UTC(2026, 6, 6, 0); // a Monday, so week windows line up cleanly

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

/** `count` closed rounds, one per hour from `startTs`, each 1 ◎ in at `price` out. */
async function closedRounds(tag, count, price, startTs) {
  const fills = [];
  for (let i = 0; i < count; i++) {
    const mint = tag + i;
    fills.push(buy(mint, 1, startTs + i * 2 * H));
    fills.push(sell(mint, 1000, price, startTs + i * 2 * H + H));
  }
  return chainOf(fills);
}

/** A member row in the shape `standing()` consumes. */
function member(handle, entry, extra) {
  return Object.assign({ handle, userId: handle.length, status: 'verified',
                         joinedAt: T0, entry }, extra || {});
}

/** A synthetic entry — enough for the aggregation tests, which are about which
 * members count, not about re-deriving window math already covered elsewhere. */
const entryOf = (score, rounds) => ({ score, rounds, roiPct: score, pnlSol: score / 10 });

/* ================= rule 1: you bring your future, not your past ========== */

test('a lifetime record joins a clan and contributes NOTHING from before the join', async () => {
  seq = 0;
  // Nine profitable rounds, all closed before the clan ever recruited them.
  const chain = await closedRounds('OLD', 9, 0.002, T0);
  const joinedAt = T0 + 40 * H; // after every one of those rounds closed

  const entry = C.memberEntry(chain, 10, joinedAt, C.SEASON_WINDOW);
  assert.equal(entry.rounds, 0, 'pre-join rounds must not count for the clan');
  assert.equal(entry.pnlSol, 0);
  assert.equal(entry.score, 0);

  // The same chain, for a member who was there the whole time, is the control.
  const founder = C.memberEntry(chain, 10, T0 - H, C.SEASON_WINDOW);
  assert.equal(founder.rounds, 9, 'the control must see the same rounds');
  assert.ok(founder.score > 0);
});

test('the same rounds cannot be donated to a second clan by switching', async () => {
  seq = 100;
  const chain = await closedRounds('SW', 6, 0.002, T0);
  const lastClose = T0 + 5 * 2 * H + H;

  const inFirstClan = C.memberEntry(chain, 10, T0 - H, C.SEASON_WINDOW);
  const inSecondClan = C.memberEntry(chain, 10, lastClose + H, C.SEASON_WINDOW);

  assert.equal(inFirstClan.rounds, 6);
  assert.equal(inSecondClan.rounds, 0,
    'a round belongs to the clan you were in when you closed it, and to no other');
});

test('a round straddling the join is not counted — it was opened elsewhere', async () => {
  seq = 200;
  const chain = await chainOf([
    buy('STRADDLE', 1, T0),
    sell('STRADDLE', 1000, 0.002, T0 + 10 * H),
  ]);
  const entry = C.memberEntry(chain, 10, T0 + 5 * H, C.SEASON_WINDOW);
  assert.equal(entry.rounds, 0,
    'the window rule is open AND close inside — half a round is not a contribution');
});

test('joining after a window has closed contributes null, not a zeroed row', async () => {
  seq = 300;
  const chain = await closedRounds('LATE', 5, 0.002, T0);
  const lastWeek = windowOf(T0);
  const entry = C.memberEntry(chain, 10, lastWeek.endTs + H, lastWeek);
  assert.equal(entry, null,
    'someone who was not in the clan that week did not "trade zero" that week');
});

test('a member joining mid-week counts only the rest of that week', async () => {
  seq = 400;
  const week = windowOf(T0 + 12 * H);
  const joinedAt = week.startTs + 20 * H;
  // Two rounds before they joined, three after — one chain, in order.
  const chain = await chainOf([
    buy('BEF0', 1, week.startTs + H), sell('BEF0', 1000, 0.002, week.startTs + 2 * H),
    buy('BEF1', 1, week.startTs + 3 * H), sell('BEF1', 1000, 0.002, week.startTs + 4 * H),
    buy('AFT0', 1, joinedAt + H), sell('AFT0', 1000, 0.002, joinedAt + 2 * H),
    buy('AFT1', 1, joinedAt + 3 * H), sell('AFT1', 1000, 0.002, joinedAt + 4 * H),
    buy('AFT2', 1, joinedAt + 5 * H), sell('AFT2', 1000, 0.002, joinedAt + 6 * H),
  ]);
  const entry = C.memberEntry(chain, 10, joinedAt, week);
  assert.equal(entry.rounds, 3, 'only the rounds closed after the join, inside the week');
  assert.equal(entry.startTs, joinedAt, 'the slice starts at the join, not at the week');
  assert.equal(entry.endTs, week.endTs);
});

/* ============ rule 2: the mean of the top five, and five to rank ========= */

test('one hero cannot carry a clan — five have to clear the bar', () => {
  const hero = member('hero', entryOf(400, 30));
  const bench = [1, 2, 3, 4].map((i) => member('bench' + i, entryOf(0, 0)));
  const s = C.standing([hero, ...bench]);
  assert.equal(s.ranked, false);
  assert.equal(s.score, null, 'an unranked clan has no score — not a zero');
  assert.equal(s.qualified, 1);
  assert.equal(s.needed, 4);
});

test('recruiting bodies buys nothing: unqualified members never move the score', () => {
  const five = [90, 80, 70, 60, 50].map((v, i) => member('t' + i, entryOf(v, 10)));
  const alone = C.standing(five);
  assert.equal(alone.ranked, true);
  assert.equal(alone.score, 70);

  const padded = C.standing([...five, ...Array.from({ length: 20 },
    (_, i) => member('filler' + i, entryOf(5, 9)))]);
  assert.equal(padded.score, 70, 'twenty more members must not change the number');
  assert.equal(padded.roster, 25);
  assert.equal(padded.qualified, 25, 'they are counted honestly, they just do not score');
});

test('summing would have crowned the padded clan — the mean is why it does not', () => {
  const good = [90, 80, 70, 60, 50].map((v, i) => member('g' + i, entryOf(v, 10)));
  const many = Array.from({ length: 40 }, (_, i) => member('m' + i, entryOf(20, 10)));
  const sum = (list) => list.reduce((t, m) => t + m.entry.score, 0);
  assert.ok(sum(many) > sum(good), 'a sum-of-scores board would rank the mob first');
  assert.ok(C.standing(good).score > C.standing(many).score,
    'the top-five mean ranks the traders first');
});

test('CUTTING A STRUGGLING MEMBER CAN NEVER RAISE THE SCORE', () => {
  const strong = [90, 80, 70, 60, 50].map((v, i) => member('s' + i, entryOf(v, 10)));
  const struggling = member('learning', entryOf(-40, 12));

  const withThem = C.standing([...strong, struggling]);
  const withoutThem = C.standing(strong);
  assert.equal(withThem.score, withoutThem.score,
    'expelling the weakest changes nothing — there is no incentive to do it');

  // And when the roster is tight, expelling actively costs the clan its rank.
  const tight = C.standing([...strong.slice(0, 4), struggling]);
  assert.equal(tight.ranked, true);
  assert.equal(C.standing(strong.slice(0, 4)).ranked, false,
    'cutting a qualified member below the minimum unranks the clan');
});

test('averaging the whole roster would punish teaching; this does not', () => {
  const core = [90, 80, 70, 60, 50].map((v, i) => member('c' + i, entryOf(v, 10)));
  const beginners = Array.from({ length: 10 }, (_, i) => member('new' + i, entryOf(-30, 8)));
  const mean = (list) => list.reduce((t, m) => t + m.entry.score, 0) / list.length;
  assert.ok(mean([...core, ...beginners]) < mean(core),
    'a whole-roster mean would charge the clan for every beginner it takes in');
  assert.equal(C.standing([...core, ...beginners]).score, C.standing(core).score);
});

test('a rejected record cannot hide inside a roster', () => {
  const four = [90, 80, 70, 60].map((v, i) => member('r' + i, entryOf(v, 10)));
  const cheat = member('rejected_one', entryOf(999, 40), { status: 'rejected' });
  const s = C.standing([...four, cheat]);
  assert.equal(s.ranked, false, 'a rejected record is not a fifth member');
  assert.ok(!s.counting.some((m) => m.handle === 'rejected_one'));
});

test('below verified, a member contributes NOTHING — not score, not volume', () => {
  // This test used to assert the opposite ("verification tier is not a
  // filter"), faithfully mirroring the season board of its day. The board
  // moved: attest.js is public, so fabricated fills hash fine, and a chain
  // of unlisted mints re-prices to all 'no-data' → 'partial' with nothing
  // disproved. If partial counted here, the clan mean would be the
  // laundering path for exactly the records the boards stopped ranking.
  const five = [90, 80, 70, 60, 50].map((v, i) => member('v' + i, entryOf(v, 10)));
  const s0 = C.standing(five);

  const fabricated = member('fab', entryOf(9999, 40), { status: 'partial' });
  const unpriced = member('pend', entryOf(500, 20), { status: 'pending' });
  const s = C.standing([...five, fabricated, unpriced]);

  assert.equal(s.score, s0.score, 'a partial monster record must not move the mean');
  assert.ok(!s.counting.some((m) => m.handle === 'fab' || m.handle === 'pend'));
  assert.equal(s.rounds, s0.rounds, 'nor pad the printed activity lines');
  assert.equal(s.pnlSol, s0.pnlSol);
  assert.equal(s.qualified, 5, 'qualified counts records that can rank, only');
  assert.equal(s.roster, 7, 'they are still on the roster — labeled, not hidden');

  // And a below-verified record cannot be the qualifying fifth member either.
  assert.equal(C.standing([...five.slice(0, 4), fabricated]).ranked, false);
});

test('the payload contract: a sub-verified member ships no figures at all', () => {
  // standing() refusing them a position is one defense; the payload is the
  // other. The clan page once printed a partial member's rounds and return
  // pixel-identical to a contributor's — because the payload carried them.
  // publicEntry is what the worker routes every member slice through, so
  // numbers no client may legitimately display never leave the server.
  const entry = entryOf(9999, 40);
  assert.equal(C.publicEntry('verified', entry), entry);
  assert.equal(C.publicEntry('partial', entry), null, 'withheld, not just unlabeled');
  assert.equal(C.publicEntry('pending', entry), null);
  assert.equal(C.publicEntry('rejected', entry), null);
  assert.equal(C.publicEntry('verified', undefined), null, 'absence is null, never undefined');
});

test('the five that make the number are named, best first', () => {
  const roster = [10, 90, 50, 70, 30, 60].map((v, i) => member('n' + i, entryOf(v, 10)));
  const s = C.standing(roster);
  assert.deepEqual(s.counting.map((m) => m.score), [90, 70, 60, 50, 30]);
  assert.equal(s.score, (90 + 70 + 60 + 50 + 30) / 5);
});

test('the round floor is the season board floor, and a week is looser', () => {
  const roster = [90, 80, 70, 60, 50].map((v, i) => member('f' + i, entryOf(v, 3)));
  assert.equal(C.standing(roster).ranked, false, 'three rounds is a sample, not a season record');
  assert.equal(C.standing(roster, { minRounds: C.MIN_WEEK_ROUNDS }).ranked, true);
  assert.equal(C.MIN_SEASON_ROUNDS, 5);
});

test('volume figures describe activity and never feed the score', () => {
  const roster = [
    member('a', { score: 50, rounds: 10, roiPct: 50, pnlSol: 4 }),
    member('b', { score: 40, rounds: 6, roiPct: 40, pnlSol: 3 }),
    member('idle', { score: 0, rounds: 0, roiPct: 0, pnlSol: 0 }),
  ];
  const s = C.standing(roster);
  assert.equal(s.rounds, 16, 'idle members contribute no rounds');
  assert.equal(s.active, 2);
  assert.equal(s.pnlSol, 7);
  assert.equal(s.score, null, 'volume does not rank a clan that has not fielded five');
});

/* ========================= identity and impersonation ==================== */

test('tags are short, uppercase, alphanumeric — and some are not for sale', () => {
  assert.equal(C.tagProblem('rats'), null);
  assert.equal(C.normalizeTag(' rats '), 'RATS');
  assert.equal(C.tagProblem('TRENCH'), 'tag-shape', 'six characters is a name, not a tag');
  assert.equal(C.tagProblem('T'), 'tag-shape');
  assert.equal(C.tagProblem('TOOLONG'), 'tag-shape');
  assert.equal(C.tagProblem('T-T'), 'tag-shape');
  assert.equal(C.tagProblem('ADMIN'), 'tag-reserved');
  assert.equal(C.tagProblem('staff'), 'tag-reserved');
});

test('a name cannot impersonate PaperTrench itself, however it is spelled', () => {
  assert.equal(C.nameProblem('PaperTrench Official'), 'name-reserved');
  assert.equal(C.nameProblem('paper trench'), 'name-reserved',
    'the check runs on the uniqueness key, so spacing does not defeat it');
  assert.equal(C.nameProblem('p a p e r t r e n c h'), 'name-reserved');
  assert.equal(C.nameProblem('Trench Rats'), null, 'ordinary names are unaffected');
});

test('invisible characters cannot fork a name into a lookalike', () => {
  // U+2009 THIN SPACE between the words: renders as a space, is not one.
  // Written as an escape on purpose: a literal thin space here is invisible,
  // and an editor 'tidying' it into a plain space would delete the test.
  const sneaky = 'Trench Rats';
  assert.notEqual(sneaky, 'Trench Rats', 'the fixture must really hold a non-ASCII space');
  assert.equal(C.nameProblem(sneaky), null, 'it is normalised, not rejected');
  assert.equal(C.normalizeName(sneaky), 'Trench Rats');
  assert.equal(C.nameKey(sneaky), C.nameKey('Trench Rats'));
  assert.equal(C.nameKey('trenchrats'), C.nameKey('Trench-Rats!'),
    'the uniqueness key collapses cosmetic differences so both cannot exist');
});

test('non-ASCII names are refused rather than rendered next to verified numbers', () => {
  assert.equal(C.nameProblem('Тrench Rats'), 'name-charset'); // Cyrillic Т
  assert.equal(C.nameProblem('Trench 🐀'), 'name-charset');
  assert.equal(C.nameProblem('..'), 'name-too-short');
  assert.equal(C.nameProblem('a'.repeat(25)), 'name-too-long');
});

test('mottos are bounded and plain text', () => {
  assert.equal(C.mottoProblem(''), null);
  assert.equal(C.mottoProblem('We take the loss and move on.'), null);
  assert.equal(C.mottoProblem('<script>alert(1)</script>'), 'motto-charset');
  assert.equal(C.mottoProblem('x'.repeat(C.MOTTO_MAX + 1)), 'motto-too-long');
});

/* ============================== membership =============================== */

test('you can only be in one clan, and creating one is joining one', () => {
  assert.equal(C.createProblem({ tag: 'RATS', name: 'Trench Rats' }), null);
  assert.equal(C.createProblem({ tag: 'RATS', name: 'Trench Rats', alreadyInClan: true }),
    'already-in-a-clan');
  assert.equal(C.joinProblem({ open: true }, 3, { alreadyInClan: true }), 'already-in-a-clan');
});

test('an invite-only clan needs its code, and an empty code opens nothing', () => {
  const clan = { open: false, joinCode: 'TRENCH-ABC123', founderId: 1 };
  assert.equal(C.joinProblem(clan, 3, { code: 'trench-abc123' }), null, 'codes are case-blind');
  assert.equal(C.joinProblem(clan, 3, { code: 'TRENCH-WRONG' }), 'bad-code');
  assert.equal(C.joinProblem(clan, 3, {}), 'bad-code');
  assert.equal(C.joinProblem({ open: false, joinCode: '' }, 3, { code: '' }), 'bad-code',
    'a clan with no code must not be joinable by sending no code');
  assert.equal(C.joinProblem({ open: true, joinCode: '' }, 3, {}), null);
});

test('a full clan is full, and a missing one says so', () => {
  assert.equal(C.joinProblem({ open: true }, C.MAX_MEMBERS, {}), 'clan-full');
  assert.equal(C.joinProblem(null, 0, {}), 'not-found');
});

test('only the founder kicks, and never themselves', () => {
  const clan = { founderId: 7 };
  assert.equal(C.kickProblem(clan, 7, 9), null);
  assert.equal(C.kickProblem(clan, 9, 7), 'not-founder');
  assert.equal(C.kickProblem(clan, 7, 7), 'cannot-kick-founder');
});

test('a departing founder hands the clan to its longest-standing member', () => {
  const members = [
    { userId: 1, joinedAt: T0 },
    { userId: 4, joinedAt: T0 + 5 * H },
    { userId: 3, joinedAt: T0 + 2 * H },
  ];
  assert.equal(C.successor(members, 1).userId, 3);
  assert.equal(C.successor([{ userId: 1, joinedAt: T0 }], 1), null,
    'the last member out disbands the clan rather than leaving an ownerless shell');
});

test('successor ties break deterministically, so two servers agree', () => {
  const members = [{ userId: 9, joinedAt: T0 }, { userId: 2, joinedAt: T0 }, { userId: 5, joinedAt: T0 }];
  assert.equal(C.successor(members, 99).userId, 2);
});

/* ===================== end-to-end over real chains ======================= */

test('a real five-member clan ranks on the mean of five real window entries', async () => {
  seq = 1000;
  const roster = [];
  const prices = [0.0022, 0.0020, 0.0018, 0.0016, 0.0014];
  for (let i = 0; i < prices.length; i++) {
    seq = 2000 + i * 100;
    const chain = await closedRounds('M' + i, 6, prices[i], T0 + H);
    roster.push(member('trader' + i,
      C.memberEntry(chain, 10, T0, C.SEASON_WINDOW)));
  }
  const s = C.standing(roster);
  assert.equal(s.ranked, true);
  assert.equal(s.counting.length, 5);
  assert.equal(s.counting[0].handle, 'trader0', 'the best return leads the five');
  const mean = s.counting.reduce((t, m) => t + m.score, 0) / 5;
  assert.ok(Math.abs(s.score - mean) < 1e-12);
  assert.equal(s.rounds, 30);
});

test('a sixth member who joined yesterday cannot lift yesterday\'s standing', async () => {
  seq = 5000;
  const roster = [];
  for (let i = 0; i < 5; i++) {
    seq = 6000 + i * 100;
    const chain = await closedRounds('B' + i, 6, 0.0015, T0 + H);
    roster.push(member('base' + i, C.memberEntry(chain, 10, T0, C.SEASON_WINDOW)));
  }
  const before = C.standing(roster).score;

  seq = 7000;
  const star = await closedRounds('STAR', 20, 0.004, T0 + H); // a monster record
  const lastClose = T0 + H + 19 * 2 * H + H;
  roster.push(member('mercenary', C.memberEntry(star, 10, lastClose + H, C.SEASON_WINDOW)));

  assert.equal(C.standing(roster).score, before,
    'their record came with them; their past did not');
});

/* ===================== moderation: the narrowest filter ================== */
/*
 * Two directions, and the SECOND one is the one that matters more here.
 *
 * A slur on a public board is the obvious failure. The quieter failure is a
 * filter that rejects "Spicy Gains" — because the maintainer asked for the
 * minimum, the audience is degen crypto, and a trainer that sands the culture
 * off is a trainer nobody uses. The must-pass corpus below is therefore a
 * first-class contract, not a nicety: it is the measured list that killed an
 * earlier collapsed-key design which rejected 10-23 of these 54.
 */

/** Legitimate names that MUST survive. Every entry is here because a plausible
 * filter design rejected it. */
const MUST_PASS = [
  // Innocent words hosting a blocked substring — the Scunthorpe family.
  'Chin Kickers', 'Flame Retardant', 'Tardigrade Gang', 'Mustard Gains',
  'Suspicious Volume', 'Spicy Gains', 'Spice Traders', 'Tycoon Society',
  'Raccoon Raiders', 'Cocoon Capital', 'Transmission Repair', 'Turnip Farmers',
  'Torpedo Bags', 'Gypsum Miners', 'Squawk Box', 'Nutcracker', 'Mickey Mouse Money',
  // Place, nation and surname collisions. Global audience, not a US one.
  'Niger Delta Bulls', 'Japan Pump Squad', 'Pakistan Apes', 'Van Dyke Traders',
  'Honky Tonk Heroes', 'Sauerkraut Squad', 'Paddy Fields',
  // Ape culture is self-identification, not attack.
  'Indian Apes', 'Nigerian Apes',
  // The culture's own vocabulary, including its euphemisms.
  'With Regards To Entries', 'Regarded Traders', 'Autists Anonymous',
  'Dumb Money', 'Insane Leverage', 'Crazy Candles', 'Idiot Savants', 'Jeeted Again',
  // Profanity, crude humour, drugs, nihilism — all explicitly allowed.
  'Fuckin Bagholders', 'Cumrocket Capital', 'Coked Up Candles',
  'Financial Suicide Squad', 'Rugged And Reckless',
  // Violence as market metaphor, and hostility to institutions and rivals.
  'Nuke China Longs', 'Kill The Yen', 'Fuck The SEC', 'Your Exit Liquidity',
  'Punch Nazis', 'Grammar Nazi',
  // The 'nigar' entry's innocent neighbour: the ordinary verb keeps its
  // substring, the respelling does not (see the production-clan test below).
  'Denigrate Rivals',  // Found by a red team RUNNING the filter rather than reading it. Every one of
  // these was rejected by the first implementation.
  'Snigger Squad', 'Sniggering Bears', 'Spiced Rum Runners', 'Spicing Up The Chart',
  'Spicer Capital', 'Spicers Of Solana', 'Tardies And Tendies', 'Fire Retarding Bags',
  'Exhaust Retarder Gang', 'Jape Squad', 'Niggling Doubts',
  // Prices. The hate code lived in the token list until "14.88" - a number a
  // trader types constantly - came back refused. On a product whose pitch is
  // that its numbers are true, that was the worst-placed false positive here.
  '14.88 Club', '0.1488 Entry Club',
];

/** Mottos that must survive. The motto is 120 characters of free text, so it is
 * where an over-eager rule does the most damage. */
const MUST_PASS_MOTTOS = [
  'We snigger at your stop losses.',
  'We keep the charts spiced and the hands diamond.',
  'Filled at 14.88, sold at 3.',
  'Ran it up 1,488 percent, gave it back.',
  'Sharpe of 1.488 and a death wish.',
  // Joining adjacent words would block these three, which is why it is not
  // done: "shot as", "chin king" and "goo king" are all real word pairs.
  'we only get one shot as a team',
  'a chin king among traders',
  'fuck the fed, buy the dip',
  'we denigrate the competition, politely.',
];

test('the filter rejects NONE of the 54 legitimate names it was measured against', () => {
  const rejected = MUST_PASS.filter((name) => C.nameProblem(name) !== null);
  assert.deepEqual(rejected, [],
    'over-blocking is the primary failure mode for this product, not under-blocking');
});

test('a blocked term must BE a word, not merely hide inside one', () => {
  // This is the whole reason matching is on tokens rather than the collapsed
  // key. Each of these contains a blocked term as a substring of a real word.
  for (const name of ['Chin Kickers', 'Flame Retardant', 'Spicy Gains', 'Tycoon Society']) {
    assert.equal(C.nameProblem(name), null, name + ' must pass');
  }
  assert.equal(C.blockedContent('chinkickers'), false,
    'the collapsed key must never be substring-matched against token-tier entries');
});

test('slurs are refused in a name, a tag and a motto alike', () => {
  assert.equal(C.nameProblem('Retard Squad'), 'name-blocked');
  assert.equal(C.tagProblem('SPIC'), 'tag-blocked');
  assert.equal(C.mottoProblem('we are the retards'), 'motto-blocked');
  // The motto is the only field editable after creation, so it is the one that
  // could otherwise be laundered past a create-time check.
  assert.equal(C.createProblem({ tag: 'OK', name: 'Fine Name', motto: 'pedo jokes' }),
    'motto-blocked');
});

test('the production slur clan is refused in every field it wore', () => {
  // Found live on the clan board (2026-08): name "nigar Rapers On chain",
  // tag NIGAR. The name reads as a slur only if you know the respelling, and
  // the tag was caught by nothing at all — which is the parity point: the
  // SAME list judges both fields, so a term refused as a name cannot
  // reappear as five uppercase characters. Deleting the live row is the
  // operator half of this fix (see the wave-1 PR runbook).
  assert.equal(C.nameProblem('nigar Rapers On chain'), 'name-blocked');
  assert.equal(C.tagProblem('NIGAR'), 'tag-blocked');
  // The respelling gets the same treatment as the term it imitates: plural
  // via the suffix set, digits via leet folding, compounds via the substring
  // tier.
  for (const name of ['Nigars On Chain', 'N1gar Crew', 'N1g4r Crew', 'Nlgar Rapers']) {
    assert.equal(C.nameProblem(name), 'name-blocked', name + ' must be refused');
  }
  // And the neighbours it must NOT catch.
  assert.equal(C.nameProblem('Niger Delta Bulls'), null);
  assert.equal(C.nameProblem('Nigerian Apes'), null);
  assert.equal(C.nameProblem('Denigrate Rivals'), null);
});

test('spelling around the list does not get you past it', () => {
  const attempts = [
    'R3tard Squad',        // digits read as letters
    'Reeeetard Squad',     // padded repeats
    'R.e.t.a.r.d Squad',   // separators inside a word
    'Team.Retard.Squad',   // separators as word breaks
    'R E T A R D Squad',   // letters spaced out
    'Retards Squad',       // plural via the suffix set
    'Retarded Squad',      // inflection via the suffix set
  ];
  for (const name of attempts) {
    assert.equal(C.nameProblem(name), 'name-blocked', name + ' must be refused');
  }
});

test('a refusal never names the term that matched', () => {
  // The code is the whole message. Naming the match turns every refusal into an
  // oracle for probing the list, and reads the term back to someone who may
  // have typed it by accident.
  const problem = C.nameProblem('Retard Squad');
  assert.equal(problem, 'name-blocked');
  assert.ok(!/retard/i.test(problem), 'the refusal must not echo the matched term');
});

test('the substring tier stays small enough to argue for entry by entry', () => {
  // It is the tier that manufactures false positives. A hand-audited list
  // cannot grow without a code review; a length heuristic can, which is why
  // this no longer asserts one - see the carve-out test below for the rule that
  // actually holds.
  assert.ok(C.BLOCKED_SUBSTRINGS.length <= 6,
    'if this list is growing, the growth belongs in BLOCKED_TOKENS instead');
});

test('every innocent host carved out of the substring tier actually needs it', () => {
  // This tier once claimed in a comment that its entries had no innocent host
  // in English. A scan of the full system dictionary proved that false. The
  // claim is now enforced rather than asserted: a carve-out that contains no
  // blocked term is dead weight, and a blocked term whose host is missing is a
  // false positive waiting for the user who types it.
  for (const host of C.ALLOWED_SUBSTRINGS) {
    assert.ok(C.BLOCKED_SUBSTRINGS.some((bad) => host.includes(bad)),
      host + ' contains no blocked term, so it carves out nothing');
  }
});

test('an innocent host cannot be used as cover for the real term', () => {
  // Stripping the host has to leave a genuine occurrence behind, or the
  // carve-out above becomes the bypass it was added to avoid.
  assert.equal(C.nameProblem('sniggernigger squad'), 'name-blocked');
  assert.equal(C.nameProblem('Snigger Squad'), null);
});

test('the mottos a red team could break all pass', () => {
  const rejected = MUST_PASS_MOTTOS.filter((m) => C.mottoProblem(m) !== null);
  assert.deepEqual(rejected, [],
    'free text is where an over-eager rule does the most damage');
});

test('leet folding never runs across the COLLAPSED key', () => {
  // The regression that reached production. The substring tier used to read
  // leet variants of nameKey(), which strips separators — so "moon 1664 soon"
  // collapsed to "moon1664soon", the digits folded 1->i 6->g 4->a, and a slur
  // appeared across the junction of two innocent words. Fourteen out of
  // fourteen ordinary price lines were refused.
  //
  // The tier now sees the collapsed key LITERALLY (which still catches a term
  // split across a space) and the leet readings of each TOKEN separately
  // (which still catches a digit inside one word) — never both powers at once.
  const PRICE_TALK = [
    'moon 1664 soon', 'green 1664', 'position 1664', 'when 1664x',
    'been 1664 since open', 'run 1664 up', 'burn 1664 supply',
    'turn 1664 into 5k', 'sol on 1664', 'in 1664 out at 2x', 'on 1.664 avg',
    'clean 1664 fill', 'token 1664 avg', 'filled 1337 sold 4200',
  ];
  const refused = PRICE_TALK.filter((line) => C.mottoProblem(line) !== null);
  assert.deepEqual(refused, [],
    'digit-heavy price talk is the native register here and must never be refused');
});

test('splitting a term across a space is still caught', () => {
  // The other half of the same rule: the LITERAL collapsed key is what makes
  // these fail, so the fix above must not have bought its false positives back
  // by dropping the collapsed key entirely.
  for (const name of ['Nig Gas', 'Ni Gga Boys', 'N I G G E R']) {
    assert.equal(C.nameProblem(name), 'name-blocked', name + ' must be refused');
  }
});

test('the hate code is a word, not a price', () => {
  assert.equal(C.nameProblem('1488 gang'), 'name-blocked');
  assert.equal(C.tagProblem('1488'), 'tag-blocked');
  assert.equal(C.mottoProblem('Filled at 14.88, sold at 3.'), null);
  assert.equal(C.mottoProblem('Ran it up 1,488 percent, gave it back.'), null);
});

test('padding, digit insertion and compounds do not get past the list', () => {
  // Every one of these was an OPEN bypass in the first implementation, found by
  // running it. Digit deletion was documented and dead code; the run-collapse
  // made tripling a letter easier than doubling it.
  const attempts = [
    'Ni0gger Crew', 'Nig0ger Crew', 'N0igger Crew',   // a digit read as padding
    'Niigger Crew', 'Niggger Crew',                   // doubled, and tripled
    'Trannies Only',                                  // -ies rewrites its stem
    'Faggotry Capital', 'Nigganaut',                  // compounds
    'Nig Gas', 'Ni Gga Boys',                         // split across a space
    'Jap Traders', 'J.A.P Squad',                     // the tokenizer's own example
  ];
  for (const name of attempts) {
    assert.equal(C.nameProblem(name), 'name-blocked', name + ' must be refused');
  }
});

test('every blocked entry is stored in the form the matcher actually compares', () => {
  // A blocked entry that does not survive its own normalization would silently
  // never match, and nothing else would notice.
  for (const entry of C.BLOCKED_TOKENS) {
    if (/\s/.test(entry)) continue; // the spaced hate-code form is matched via tokenize
    assert.equal(entry, entry.toLowerCase(), entry + ' must be stored lowercase');
  }
});
// regression: live NIGAR clan from the 2026-08-14 audit
