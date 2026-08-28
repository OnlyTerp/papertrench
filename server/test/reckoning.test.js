'use strict';
/* Friday Reckoning tests (DELIGHT-MAP.md B2) — core + worker lanes.
 *
 * Drives the REAL worker entry (postDueReckonings) through the scripted D1
 * fake from spark-worker.test.js, and the REAL core bell math. Pins:
 *   - the bell law: Friday 20:00 UTC window, 24h wide, not due outside it
 *   - the no-PnL law: the digest payload NEVER carries pnlSol/roiPct
 *   - the mark-is-the-claim law: the mark row is written BEFORE the POST,
 *     so a second firing never double-posts
 *   - the gate laws: DRY_RUN default-true sends nothing; KILL_SWITCH polls
 *     but never sends; no webhook = skipped silently (operator choice)
 *   - honesty: weekId correct, log tells the truth about every action
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const reckoning = require('../core/reckoning.js');
const lane = require('../worker/reckoning.js');

/* ---------------- clock fixtures ---------------- */

// A real week: Monday 2026-08-03 .. Sunday 2026-08-09.
// Friday 20:00 UTC that week = 2026-08-07T20:00:00Z.
const FRI_BELL = Date.UTC(2026, 7, 7, 20, 0, 0);
const THURSDAY = Date.UTC(2026, 7, 6, 12, 0, 0);
const SATURDAY_NOON = Date.UTC(2026, 7, 8, 12, 0, 0);       // inside window
const SATURDAY_LATE = Date.UTC(2026, 7, 8, 21, 0, 0);       // outside window
const NEXT_MONDAY = Date.UTC(2026, 7, 10, 12, 0, 0);        // the next week

test('bell law: due exactly in [Fri 20:00 UTC, Sat 20:00 UTC)', () => {
  assert.equal(reckoning.isDue(THURSDAY), false, 'Thursday: not due');
  assert.equal(reckoning.isDue(FRI_BELL - 1), false, 'one ms before the bell: not due');
  assert.equal(reckoning.isDue(FRI_BELL), true, 'the bell itself: due');
  assert.equal(reckoning.isDue(SATURDAY_NOON), true, 'Saturday noon: inside the 24h window');
  assert.equal(reckoning.isDue(SATURDAY_LATE), false, 'Saturday 21:00: window has closed');
  assert.equal(reckoning.isDue(NEXT_MONDAY), false, 'next Monday: not due');
});

test('bell law: bellTs lands on a Friday at 20:00 UTC, every week', () => {
  for (const ts of [THURSDAY, FRI_BELL, SATURDAY_NOON, Date.UTC(2026, 11, 25)]) {
    const d = new Date(reckoning.bellTs(ts));
    assert.equal(d.getUTCDay(), 5, `bell is a Friday (${d.toISOString()})`);
    assert.equal(d.getUTCHours(), 20, 'bell is 20:00 UTC');
    assert.equal(d.getUTCMinutes(), 0, 'bell is on the hour');
  }
});

test('week law: weekIdFor matches sprint weekIdOf on the bell', () => {
  const { weekIdOf } = require('../core/sprint.js');
  assert.equal(reckoning.weekIdFor(FRI_BELL), weekIdOf(FRI_BELL));
  assert.equal(reckoning.weekIdFor(SATURDAY_NOON), weekIdOf(FRI_BELL),
    'Saturday noon still resolves to the SAME week as the Friday bell');
  assert.notEqual(reckoning.weekIdFor(NEXT_MONDAY), weekIdOf(FRI_BELL),
    'the next Monday is the NEXT week');
});

/* ---------------- no-PnL law ---------------- */

const STANDING = {
  roster: 7, active: 5, qualified: 5, needed: 0, ranked: true,
  score: 61.25,
  counting: [
    { handle: 'alpha', status: 'verified', joinedAt: 1, score: 80, roiPct: 12.5, rounds: 9 },
    { handle: 'bravo', status: 'verified', joinedAt: 2, score: 61, roiPct: 3.2, rounds: 12 },
  ],
  rounds: 21, pnlSol: 4.2,
};

test('no-PnL law: digest payload never carries money figures', () => {
  const payload = reckoning.buildDigest(
    { name: 'Trench Rats', tag: 'RATS' },
    { weekId: '2026-W32', startTs: 1, endTs: 2 },
    STANDING);
  const text = JSON.stringify(payload);
  assert.ok(!/pnlSol/.test(text), 'no pnlSol anywhere in the payload');
  assert.ok(!/roiPct/.test(text), 'no roiPct anywhere in the payload');
  assert.ok(!/equity|drawdown/i.test(text), 'no equity/drawdown figures');
  // The board line names handle + score, never the roi behind it.
  const board = payload.embeds[0].fields.find((f) => f.name === 'Top board');
  assert.ok(/alpha/.test(board.value), 'board names the handle');
  assert.ok(!/12\.5/.test(board.value), 'board does NOT leak the roi figure');
});

test('digest: ranked clan shows score + rounds; unranked shows the gap', () => {
  const week = { weekId: '2026-W32', startTs: 1, endTs: 2 };
  const ranked = reckoning.buildDigest({ name: 'Trench Rats', tag: 'RATS' }, week, STANDING);
  assert.ok(/61\.3/.test(ranked.embeds[0].fields[0].value), 'score rendered');
  assert.ok(/21 rounds/.test(ranked.embeds[0].fields[0].value), 'rounds rendered');
  assert.ok(ranked.embeds[0].title.includes('RATS'), 'tag in the title');

  const thin = reckoning.buildDigest({ name: 'New Clan', tag: 'NEWB' }, week,
    { roster: 2, active: 1, qualified: 0, needed: 5, ranked: false, score: null,
      counting: [], rounds: 3, pnlSol: 9.9 });
  assert.ok(/needs 5/.test(thin.embeds[0].fields[0].value),
    'unranked clan sees the gap, not a zero');
  const thinText = JSON.stringify(thin);
  assert.ok(!/pnlSol|9\.9/.test(thinText), 'the thin clan digest also carries no money');
});

/* ---------------- worker lane ---------------- */

/** Scripted D1 (same shape as spark-worker.test.js's fakeDB). */
function fakeDB(route) {
  const log = [];
  const statement = (sql) => {
    let bound = [];
    const stmt = {
      sql,
      get args() { return bound; },
      bind(...args) { bound = args; return stmt; },
      async first() { log.push({ sql, args: bound, via: 'first' }); return route(sql, bound) || null; },
      async all() {
        log.push({ sql, args: bound, via: 'all' });
        const rows = route(sql, bound);
        return { results: Array.isArray(rows) ? rows : [] };
      },
      async run() {
        log.push({ sql, args: bound, via: 'run' });
        const out = route(sql, bound);
        return out && out.meta ? out : { meta: { changes: 1 } };
      },
    };
    return stmt;
  };
  return { log, prepare: statement };
}

const CLAN_ROWS = [
  {
    clan_id: 1, tag: 'RATS', name: 'Trench Rats',
    reckoning_webhook: 'https://discord.com/api/webhooks/1/abc', created_at: 100,
    entry_json: JSON.stringify({ score: 80, rounds: 9, roiPct: 12.5, pnlSol: 2 }),
    handle: 'alpha', joined_at: 1, status: 'verified',
  },
  {
    clan_id: 2, tag: 'NOWK', name: 'No Webhook Clan',
    reckoning_webhook: null, created_at: 200,
    entry_json: JSON.stringify({ score: 55, rounds: 6, roiPct: 1, pnlSol: 1 }),
    handle: 'bravo', joined_at: 2, status: 'verified',
  },
];

function dbWith(markRows) {
  return fakeDB((sql) => {
    if (/FROM clan_entries/.test(sql)) return CLAN_ROWS;
    if (/FROM reckoning_posts/.test(sql)) return markRows || [];
    return null;
  });
}

test('lane: not-due exits with ZERO queries', () => {
  const db = fakeDB(() => null);
  const sent = [];
  return lane.postDueReckonings({ DB: db }, {
    now: THURSDAY, post: async (u, p) => { sent.push(p); return { ok: true, status: 200 }; },
    dryRun: false,
  }).then((r) => {
    assert.equal(r.skipped, 'not-due');
    assert.equal(r.posted, 0);
    assert.equal(db.log.length, 0, 'no query ran outside the window');
    assert.equal(sent.length, 0);
  });
});

test('lane: dry-run (the DEFAULT) marks + logs but never sends', () => {
  const db = dbWith([]);
  const sent = [];
  return lane.postDueReckonings({ DB: db }, {
    now: FRI_BELL, post: async (u, p) => { sent.push(p); return { ok: true, status: 200 }; },
    // dryRun omitted — must default true.
  }).then((r) => {
    assert.equal(r.weekId, reckoning.weekIdFor(FRI_BELL));
    assert.equal(sent.length, 0, 'nothing posted under the default');
    assert.ok(r.log.every((e) => e.action === 'dry-run'), 'log says dry-run, honestly');
    const marks = db.log.filter((l) => /INSERT INTO reckoning_posts/.test(l.sql));
    assert.equal(marks.length, 1, 'only the opted-in (webhook) clan was claimed');
  });
});

test('lane: KILL_SWITCH polls but never sends', () => {
  const db = dbWith([]);
  const sent = [];
  return lane.postDueReckonings({ DB: db }, {
    now: FRI_BELL, killSwitch: true, dryRun: false,
    post: async (u, p) => { sent.push(p); return { ok: true, status: 200 }; },
  }).then((r) => {
    assert.equal(sent.length, 0, 'kill switch sends nothing');
    assert.ok(r.log.every((e) => e.action === 'kill-switch'));
  });
});

test('lane: mark-is-the-claim — second firing never double-posts', () => {
  let marks = [];
  const db = fakeDB((sql) => {
    if (/FROM clan_entries/.test(sql)) return CLAN_ROWS;
    if (/FROM reckoning_posts/.test(sql)) return marks;
    if (/INSERT INTO reckoning_posts/.test(sql)) { marks.push({ clan_id: 1 }); return null; }
    return null;
  });
  const sent = [];
  // The claim-before-transport proof: at the MOMENT the webhook fires, the
  // mark row for this (week, clan) must already be durably in the store.
  let markAtPost = null;
  const post = async (u, p) => {
    markAtPost = marks.length;
    sent.push(p);
    return { ok: true, status: 200 };
  };
  const opts = { now: FRI_BELL, dryRun: false, post };
  return lane.postDueReckonings({ DB: db }, opts).then((first) => {
    assert.equal(first.posted, 1, 'first firing posts');
    assert.equal(sent.length, 1);
    assert.equal(markAtPost, 1, 'mark row already written when the POST fired');
    assert.ok(db.log.some((l) => /INSERT INTO reckoning_posts/.test(l.sql)),
      'the claim went through the store, not just the log');
    return lane.postDueReckonings({ DB: db }, opts).then((second) => {
      assert.equal(second.posted, 0, 'second firing posts NOTHING');
      assert.ok(second.log.some((e) => e.action === 'already-posted'));
      assert.equal(sent.length, 1, 'still exactly one POST total');
    });
  });
});

test('lane: failed POST leaves the mark (no silent re-fire next minute)', () => {
  const marks = [];
  const db = fakeDB((sql) => {
    if (/FROM clan_entries/.test(sql)) return CLAN_ROWS;
    if (/FROM reckoning_posts/.test(sql)) return marks;
    if (/INSERT INTO reckoning_posts/.test(sql)) { marks.push({ clan_id: 1 }); return null; }
    return null;
  });
  const post = async () => { throw new Error('upstream down'); };
  return lane.postDueReckonings({ DB: db }, { now: FRI_BELL, dryRun: false, post }).then((r) => {
    assert.equal(r.posted, 0);
    assert.ok(r.log.some((e) => e.action === 'post-error' && /upstream down/.test(e.error)),
      'the failure is NAMED in the log, not swallowed');
    return lane.postDueReckonings({ DB: db }, { now: FRI_BELL + 60000, dryRun: false, post })
      .then((r2) => {
        assert.equal(r2.posted, 0);
        assert.ok(r2.log.some((e) => e.action === 'already-posted'),
          'the mark holds across firings — no double-post risk');
      });
  });
});

test('lane: a clan with no webhook is skipped silently — operator choice', () => {
  const db = dbWith([]);
  const sent = [];
  return lane.postDueReckonings({ DB: db }, {
    now: FRI_BELL, dryRun: false,
    post: async (u, p) => { sent.push(p); return { ok: true, status: 200 }; },
  }).then((r) => {
    assert.ok(!r.log.some((e) => e.clan === 'NOWK'),
      'no-webhook clan never appears in the log');
    assert.equal(sent.length, 1, 'exactly the opted-in clan is posted');
  });
});

test('lane: the posted payload obeys the no-PnL law over the wire', () => {
  const db = dbWith([]);
  const sent = [];
  return lane.postDueReckonings({ DB: db }, {
    now: FRI_BELL, dryRun: false,
    post: async (u, p) => { sent.push(p); return { ok: true, status: 200 }; },
  }).then(() => {
    assert.equal(sent.length, 1);
    const text = JSON.stringify(sent[0]);
    assert.ok(!/pnlSol|roiPct/.test(text), 'wire payload carries no money figure');
  });
});
