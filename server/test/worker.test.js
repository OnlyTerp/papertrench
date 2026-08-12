/* The worker glue is where tournament money meets infrastructure: rate
 * limits, duplicate handling, transactional writes, board ordering, and the
 * pricing queue. Each test here drives the REAL worker entry through a
 * scripted D1 fake and a genuinely signed session token — the same code path
 * a production request takes, minus the network.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { appendFill, GENESIS } = require('../core/chain.js');

/* ---------------- harness ---------------- */

const SECRET = 'test-secret';
const ORIGIN = 'https://papertrench.com';
const USER_ROW = {
  id: 7, x_id: 'x7', handle: 'terp', display_name: 'Terp',
  avatar_url: '', session_epoch: 1,
};

function b64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A session token signed exactly the way auth.js signs them. */
async function sessionToken() {
  const body = b64url(new TextEncoder().encode(
    JSON.stringify({ uid: USER_ROW.id, epoch: 1, exp: Date.now() + 3600000 })));
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = b64url(await crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(body)));
  return body + '.' + sig;
}

/**
 * A scripted D1: `route(sql, args)` decides every answer (or throws), and
 * everything the worker does is written to `log` / `batches` so a test can
 * assert not just WHAT was answered but HOW the store was driven.
 */
function fakeDB(route) {
  const log = [];
  const batches = [];
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
  return {
    log,
    batches,
    prepare: statement,
    batch: async (statements) => {
      batches.push(statements.map((s) => ({ sql: s.sql, args: s.args })));
      return statements.map(() => ({ meta: { changes: 1 } }));
    },
  };
}

async function loadWorker() {
  // edgeCached needs the Workers cache API; a permanent miss is fine here.
  globalThis.caches = globalThis.caches || {
    default: { match: async () => undefined, put: async () => {} },
  };
  return (await import('../worker/index.js')).default;
}

function makeEnv(db) {
  return { DB: db, SESSION_SECRET: SECRET, SITE_ORIGIN: ORIGIN };
}

async function postSubmit(worker, env, payload) {
  const request = new Request('https://api.test/api/submit', {
    method: 'POST',
    headers: {
      Origin: ORIGIN,
      Authorization: 'Bearer ' + await sessionToken(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const response = await worker.fetch(request, env, { waitUntil: () => {} });
  return { status: response.status, body: await response.json() };
}

/* ---------------- fixtures ---------------- */

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

const MIN = 60000;

async function honestPayload() {
  const chain = await chainOf([
    { id: 'w1', sessionId: 's', mint: 'M1', side: 'buy',
      qty: 1000, priceNative: 0.001, solGross: 1, solNet: 0.99, ts: 10 * MIN },
    { id: 'w2', sessionId: 's', mint: 'M1', side: 'sell',
      qty: 1000, priceNative: 0.002, solGross: 2, solNet: 1.98, ts: 20 * MIN },
  ]);
  return {
    version: 1,
    submittedAt: 21 * MIN,
    identity: { handle: 'terp', verified: true },
    claim: { equitySol: 10.98, realizedPnlSol: 0.98, rounds: 1, wins: 1,
             losses: 0, startingBalanceSol: 10 },
    chain,
    head: chain[chain.length - 1].hash,
  };
}

/** The common answers a submit needs; overrides layer per test. */
function submitRoute(opts) {
  const options = opts || {};
  return (sql) => {
    if (sql.includes('FROM users WHERE id')) return USER_ROW;
    if (sql.includes('INSERT INTO rate_limits')) return { count: options.rateCount || 1 };
    if (sql.includes('FROM records WHERE user_id')) return options.record || null;
    if (sql.includes('FROM duels')) return [];
    if (sql.includes('FROM clan_members')) return null;
    return null;
  };
}

/* ---------------- rate limiting (DEFECT L-08) ---------------- */

test('the rate limiter is one atomic statement, and it actually limits', async () => {
  const worker = await loadWorker();

  // Over the limit: the RETURNING count says this is request #7 of 6.
  const over = fakeDB(submitRoute({ rateCount: 7 }));
  const denied = await postSubmit(worker, makeEnv(over), await honestPayload());
  assert.equal(denied.status, 429);
  assert.equal(denied.body.reason, 'rate-limited');

  // Under it: the same statement admits the request.
  const under = fakeDB(submitRoute({ rateCount: 1 }));
  const allowed = await postSubmit(worker, makeEnv(under), await honestPayload());
  assert.equal(allowed.status, 200);

  // The atomicity claim, asserted structurally: counting must be ONE upsert
  // with RETURNING — the old SELECT-then-UPDATE pair is what let N parallel
  // requests all read the same count and all pass.
  for (const db of [over, under]) {
    const rateOps = db.log.filter((e) => e.sql.includes('rate_limits'));
    assert.equal(rateOps.length, 1, 'exactly one statement may touch the counter');
    assert.ok(rateOps[0].sql.includes('ON CONFLICT'), 'increment and insert are one statement');
    assert.ok(rateOps[0].sql.includes('RETURNING'), 'the decision reads the count the write produced');
  }
});

/* ---------------- duplicate submissions (DEFECT L-04) ---------------- */

test('resubmitting the exact stored chain is a no-op, not a verification reset', async () => {
  const worker = await loadWorker();
  const payload = await honestPayload();
  const db = fakeDB(submitRoute({
    record: {
      head: payload.head, chain_len: payload.chain.length, starting_sol: 10,
      status: 'verified',
      stats_json: JSON.stringify({ score: 42, rankable: true }),
    },
  }));

  const res = await postSubmit(worker, makeEnv(db), payload);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.duplicate, true);
  assert.equal(res.body.status, 'verified',
    'the earned verdict must survive an impatient double-click');

  assert.equal(db.batches.length, 0, 'a duplicate writes nothing to the record');
  const audit = db.log.find((e) => e.sql.includes('INSERT INTO submissions'));
  assert.ok(audit, 'the attempt is still logged');
  assert.equal(audit.args[3], 'duplicate', 'and logged as what it was');
});

/* ---------------- transactional writes (DEFECT L-07) ---------------- */

test('everything a submission changes commits in ONE transaction', async () => {
  const worker = await loadWorker();
  const db = fakeDB(submitRoute({}));
  const res = await postSubmit(worker, makeEnv(db), await honestPayload());
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);

  assert.equal(db.batches.length, 1, 'one batch, one transaction');
  const sqls = db.batches[0].map((s) => s.sql);
  assert.ok(sqls.some((s) => s.includes('DELETE FROM chain_segments')));
  assert.ok(sqls.some((s) => s.includes('INSERT INTO chain_segments')));
  assert.ok(sqls.some((s) => s.includes('INSERT INTO records')));
  assert.ok(sqls.some((s) => s.includes('INSERT INTO sprint_entries')));

  // And none of those writes may ALSO run outside the transaction.
  const strays = db.log.filter((e) => e.via === 'run' &&
    /INSERT INTO (records|sprint_entries|chain_segments)|DELETE FROM chain_segments/.test(e.sql));
  assert.equal(strays.length, 0, 'no split-brain window between related writes');
});

/* ---------------- board ordering (DEFECT L-05) ---------------- */

test('the board ranks by score with deterministic ties, in SQL and in JS', async () => {
  const worker = await loadWorker();
  const row = (handle, score, verifiedAt) => ({
    handle, display_name: handle, avatar_url: '', status: 'verified',
    stats_json: JSON.stringify({ score, rankable: true }),
    badges_json: '[]', chain_len: 10,
    verified_at: verifiedAt, submitted_at: verifiedAt,
    clan_tag: null, clan_name: null,
  });
  const db = fakeDB((sql) => {
    if (sql.includes('FROM records r JOIN users u')) {
      // Deliberately scrambled: recent-but-mediocre first, and a tie in it.
      return [row('alice', 10, 2000), row('carol', 50, 3000), row('bob', 10, 1000)];
    }
    return null;
  });

  const response = await worker.fetch(
    new Request('https://api.test/api/leaderboard'), makeEnv(db), { waitUntil: () => {} });
  const body = await response.json();
  assert.deepEqual(body.entries.map((e) => e.handle), ['carol', 'bob', 'alice'],
    'score decides, then the EARLIER verification keeps the tied rank');

  const boardSql = db.log.find((e) => e.sql.includes('FROM records r JOIN users u')).sql;
  assert.ok(boardSql.includes("json_extract(r.stats_json, '$.score') DESC"),
    'the LIMIT must cut by rank, not by recency — #501 must not evict the season best');
  assert.ok(!/ORDER BY r\.submitted_at/.test(boardSql));
});

/* ---------------- pricing queue liveness (DEFECT L-10) ---------------- */

test('a record whose candle lookups fail backs off instead of pinning the queue', async () => {
  const worker = await loadWorker();
  const chain = await chainOf([
    { id: 'p1', sessionId: 's', mint: 'M1', side: 'buy',
      qty: 1000, priceNative: 0.001, solGross: 1, solNet: 0.99, ts: 10 * MIN },
  ]);
  let stallWrite = null;
  const db = fakeDB((sql, args) => {
    if (sql.includes("status = 'pending'")) {
      return { user_id: 7, starting_sol: 10, pricing_progress_json: null };
    }
    if (sql.includes('FROM chain_segments')) {
      return [{ links_json: JSON.stringify(chain) }];
    }
    if (sql.includes('FROM candle_cache')) throw new Error('d1-down');
    if (sql.includes('UPDATE records SET pricing_progress_json')) {
      stallWrite = args;
      return { meta: { changes: 1 } };
    }
    return null;
  });

  const waits = [];
  await worker.scheduled({}, makeEnv(db), { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);

  assert.ok(stallWrite, 'the failure must be recorded, never swallowed');
  const progress = JSON.parse(stallWrite[0]);
  assert.ok(progress.stalledUntil > Date.now(),
    'the stalled record steps aside so the queue keeps moving');

  // And the queue query itself must skip records that are backing off —
  // that filter is what turns the recorded stall into liveness.
  const pick = db.log.find((e) => e.sql.includes("status = 'pending'")).sql;
  assert.ok(pick.includes('stalledUntil'), 'the picker must honour the backoff');
});

/* ---------------- public feed hygiene (DEFECT L-12) ---------------- */

test('the public feed never rebroadcasts our own gate bug as a verdict', async () => {
  const worker = await loadWorker();
  const sub = (outcome, ts) => ({ outcome, chain_len: 5, created_at: ts, handle: 'terp' });
  const db = fakeDB((sql) => {
    if (sql.includes('FROM submissions s')) {
      // What five days of the L-01 gate bug actually left in the table: a
      // wall of unknown-version rejections on top, honest events underneath.
      return [
        sub('shape:unknown-version', 5000),
        sub('shape:unknown-version', 4000),
        sub('duplicate', 3000),
        sub('chain-invalid', 2000),
        sub('accepted', 1000),
      ];
    }
    if (sql.includes('FROM records r')) return [];
    return null;
  });

  const response = await worker.fetch(
    new Request('https://api.test/api/activity'), makeEnv(db), { waitUntil: () => {} });
  const body = await response.json();

  const details = body.events.map((e) => e.detail);
  assert.ok(!details.some((d) => d.includes('unknown-version')),
    'a server-side gate bug is not a verdict about a trader');
  assert.equal(body.events.filter((e) => e.kind === 'rejected').length, 1,
    'real verdicts still stream');
  assert.equal(body.events.find((e) => e.kind === 'rejected').detail, 'chain-invalid');
  assert.equal(body.events.find((e) => e.kind === 'accepted').handle, 'terp');

  // The quarantine must also live in the SQL, so the 40-row window is spent
  // on events worth showing rather than pre-filtered spam.
  const feedSql = db.log.find((e) => e.sql.includes('FROM submissions s')).sql;
  assert.ok(feedSql.includes("NOT IN ('duplicate', 'shape:unknown-version')"),
    'the window must not be crowded out by rows the feed will drop anyway');
});
