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

/* ---------------- trench roster (public floor, not the podium) ---------------- */

test('the trench lists signed-in people and submitted records without ranking numbers', async () => {
  const worker = await loadWorker();
  const db = fakeDB((sql) => {
    if (sql.includes('COUNT(*) AS n') && sql.includes('FROM users WHERE')) {
      return { n: 2 };
    }
    if (sql.includes('COUNT(*) AS n') && sql.includes('FROM records r JOIN users u')
        && sql.includes("r.status = 'verified'")) {
      return { n: 0 };
    }
    if (sql.includes('COUNT(*) AS n') && sql.includes('FROM records r JOIN users u')) {
      return { n: 1 };
    }
    if (sql.includes('FROM users u') && sql.includes('LEFT JOIN records')) {
      return [
        {
          handle: 'MeloXSol', display_name: 'Melo', avatar_url: 'https://x.test/a.jpg',
          created_at: 100, last_login_at: 200,
          status: 'rejected', chain_len: 27,
          stats_json: JSON.stringify({ rounds: 5, rankable: true, roiPct: 145.3, score: 259 }),
          submitted_at: 300, dq_at: 0,
        },
        {
          handle: 'newbie', display_name: 'New', avatar_url: '',
          created_at: 50, last_login_at: 50,
          status: null, chain_len: null, stats_json: null, submitted_at: null, dq_at: null,
        },
      ];
    }
    return null;
  });

  const response = await worker.fetch(
    new Request('https://api.test/api/trench'), makeEnv(db), { waitUntil: () => {} });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.signedIn, 2);
  assert.equal(body.submitted, 1);
  assert.equal(body.ranked, 0);
  assert.equal(body.people.length, 2);

  const rejected = body.people.find((p) => p.handle === 'MeloXSol');
  assert.equal(rejected.record.status, 'rejected');
  assert.equal(rejected.record.chainLen, 27);
  assert.equal(rejected.record.rounds, 5);
  assert.equal(rejected.record.ranked, false);
  assert.equal('roiPct' in rejected.record, false, 'rejected ROI must not ride the public floor');
  assert.equal('score' in rejected.record, false);
  assert.equal('realizedPnlSol' in rejected.record, false);

  const fresh = body.people.find((p) => p.handle === 'newbie');
  assert.equal(fresh.record, null);
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
  // Fresh timestamps: this test is about the REASON quarantine, so the rows
  // must all be inside the L-13 recency window or they would age out anyway.
  const NOW = Date.now();
  const sub = (outcome, ts) => ({ outcome, head: 'H' + ts, chain_len: 5, created_at: ts, handle: 'terp' });
  const db = fakeDB((sql) => {
    if (sql.includes('FROM submissions s')) {
      // What five days of the L-01 gate bug actually left in the table: a
      // wall of unknown-version rejections on top, honest events underneath.
      return [
        sub('shape:unknown-version', NOW - 1000),
        sub('shape:unknown-version', NOW - 2000),
        sub('duplicate', NOW - 3000),
        sub('chain-invalid', NOW - 4000),
        sub('accepted', NOW - 5000),
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

/* ---------------- feed freshness (DEFECT L-13) ---------------- */

test('red verdicts age out of the LIVE feed; green events persist and dedupe', async () => {
  const worker = await loadWorker();
  const NOW = Date.now();
  const OLD = NOW - 6 * 24 * 3600 * 1000;   // launch week
  const FRESH = NOW - 3600 * 1000;          // an hour ago
  const sub = (outcome, ts, head) => ({ outcome, head: head || 'H', chain_len: 3, created_at: ts, handle: 'terp' });
  const db = fakeDB((sql) => {
    if (sql.includes('FROM submissions s')) {
      return [
        sub('chain-invalid', FRESH),          // a fresh verdict must stream
        sub('accepted', OLD, 'HEAD-A'),       // pre-L-04: the same chain
        sub('accepted', OLD - 1, 'HEAD-A'),   // logged accepted nine times —
        sub('accepted', OLD - 2, 'HEAD-A'),   // the feed owes ONE green line
        sub('chain-replaced', OLD),           // launch-week red: aged out
        sub('chain-invalid', OLD),
      ];
    }
    if (sql.includes('FROM records r')) {
      return [
        { handle: 'terp', status: 'verified', chain_len: 3,
          pricing_json: null, verified_at: OLD },      // achievement: persists
        { handle: 'x', status: 'rejected', chain_len: 3,
          pricing_json: null, verified_at: OLD },      // old red: aged out
      ];
    }
    return null;
  });

  const response = await worker.fetch(
    new Request('https://api.test/api/activity'), makeEnv(db), { waitUntil: () => {} });
  const body = await response.json();

  const kinds = body.events.map((e) => e.kind);
  assert.deepEqual(kinds.filter((k) => k === 'rejected'), ['rejected'],
    'exactly one red line: the fresh verdict, not the launch-week wall');
  assert.equal(body.events.find((e) => e.kind === 'rejected').detail, 'chain-invalid');
  assert.equal(kinds.filter((k) => k === 'accepted').length, 1,
    'nine copies of the same accepted chain are one event');
  assert.equal(kinds.filter((k) => k === 'verified').length, 1,
    'a verified record is an achievement and does not age out');

  // The recency window must also live in the SQL, so old red rows cannot
  // crowd the 40-row window before the JS filter ever sees them.
  const feedSql = db.log.find((e) => e.sql.includes('FROM submissions s')).sql;
  assert.ok(/s\.outcome = 'accepted' OR s\.created_at > \?/.test(feedSql),
    'the query itself must refuse stale red rows');
});

/* ---------------- the X feed endpoint ---------------- */

/** The syndication page the worker scrapes, built from raw tweet objects. */
function syndicationHtml(tweets) {
  const data = { props: { pageProps: { timeline: {
    entries: tweets.map((tweet) => ({ content: { tweet } })) } } } };
  // Next.js escapes `<` inside the embedded JSON (so a tweet can never close
  // the script tag early); the fixture must be as honest as the real page.
  return '<html><body><script id="__NEXT_DATA__" type="application/json">' +
    JSON.stringify(data).replace(/</g, '\\u003c') + '</script></body></html>';
}

function xfeedRoute(opts) {
  const options = opts || {};
  return (sql) => {
    if (sql.includes('FROM users WHERE handle')) {
      return 'user' in options ? options.user : { handle: 'Terp_X' };
    }
    if (sql.includes('FROM x_feed_cache')) return options.cache || null;
    if (sql.includes('INSERT INTO rate_limits')) return { count: options.rateCount || 1 };
    return null;
  };
}

async function getFeed(worker, db, query) {
  const response = await worker.fetch(
    new Request('https://api.test/api/x-feed' + query), makeEnv(db), { waitUntil: () => {} });
  return { status: response.status, body: await response.json() };
}

/** Run fn with the upstream network replaced; returns [result, calls]. */
async function withUpstream(impl, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push(String(url)); return impl(url, init); };
  try { return [await fn(), calls]; } finally { globalThis.fetch = real; }
}

test('the X feed endpoint is not an open proxy', async () => {
  const worker = await loadWorker();
  const [, calls] = await withUpstream(() => { throw new Error('must not be reached'); }, async () => {
    const bad = await getFeed(worker, fakeDB(xfeedRoute()), '?handle=not%20a%20handle');
    assert.equal(bad.status, 400);
    const missing = await getFeed(worker, fakeDB(xfeedRoute({ user: null })), '?handle=stranger');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.reason, 'unknown-handle');
  });
  assert.equal(calls.length, 0, 'no upstream fetch may fire for a handle we do not host');
});

test('a fresh cache answers without touching X, in the row\'s own casing', async () => {
  const worker = await loadWorker();
  const cache = { fetched_at: Date.now() - 60000,
    posts_json: JSON.stringify([{ id: '1', text: 'hi', createdAt: 5, photos: [], likes: 0 }]) };
  const [res, calls] = await withUpstream(() => { throw new Error('cache was fresh'); },
    () => getFeed(worker, fakeDB(xfeedRoute({ cache })), '?handle=terp_x'));
  assert.equal(res.status, 200);
  assert.equal(res.body.handle, 'Terp_X', 'the users row decides the casing, not the query string');
  assert.equal(res.body.posts[0].text, 'hi');
  assert.equal(calls.length, 0);
});

test('ingest sanitizes: text stays text, foreign media drops, retweets skip, eight max', async () => {
  const worker = await loadWorker();
  const tweets = [{
    id_str: '111', created_at: '2026-08-10T12:00:00.000Z', favorite_count: 3,
    full_text: 'look <script>alert(1)</script> at https://t.co/abc',
    entities: { urls: [{ url: 'https://t.co/abc', expanded_url: 'https://example.com/x' }] },
    photos: [{ url: 'https://pbs.twimg.com/media/ok.jpg' }, { url: 'https://evil.example/x.jpg' }],
  }, {
    id_str: '222', created_at: '2026-08-09T12:00:00.000Z',
    full_text: 'RT @someone: not their words', retweeted_status: {},
  }];
  for (let i = 0; i < 10; i++) {
    tweets.push({ id_str: String(1000 + i), favorite_count: i,
      created_at: new Date(Date.UTC(2026, 7, 1 + i)).toISOString(), full_text: 'post ' + i });
  }
  const db = fakeDB(xfeedRoute());
  const [res] = await withUpstream(() => new Response(syndicationHtml(tweets)),
    () => getFeed(worker, db, '?handle=Terp_X'));

  assert.equal(res.status, 200);
  assert.equal(res.body.posts.length, 8, 'capped — a feed, not an archive');
  const marked = res.body.posts.find((p) => p.id === '111');
  assert.ok(marked.text.includes('<script>alert(1)</script>'),
    'markup survives as INERT TEXT in JSON — neutralizing it is the renderer\'s job, twice-guarded');
  assert.ok(marked.text.includes('https://example.com/x'), 't.co stubs expand to what they stand for');
  assert.deepEqual(marked.photos, ['https://pbs.twimg.com/media/ok.jpg'],
    'media not on X\'s own CDN is dropped, never proxied');
  assert.ok(!res.body.posts.some((p) => p.text.includes('not their words')),
    'retweets are other people\'s words and stay off the pane');
  const write = db.log.find((e) => e.sql.includes('INSERT INTO x_feed_cache'));
  assert.ok(write, 'a successful fetch is cached');
  assert.equal(write.args[0], 'terp_x', 'cache keys are case-folded');
});

test('a stale cache beats a broken upstream; an empty answer beats an invented one', async () => {
  const worker = await loadWorker();
  const stale = { fetched_at: Date.now() - 2 * 3600 * 1000,
    posts_json: JSON.stringify([{ id: '9', text: 'old but real', createdAt: 1, photos: [], likes: 0 }]) };
  const [kept] = await withUpstream(() => new Response('nope', { status: 503 }),
    () => getFeed(worker, fakeDB(xfeedRoute({ cache: stale })), '?handle=Terp_X'));
  assert.equal(kept.status, 200);
  assert.equal(kept.body.posts[0].text, 'old but real');

  const [empty] = await withUpstream(() => new Response('nope', { status: 503 }),
    () => getFeed(worker, fakeDB(xfeedRoute()), '?handle=Terp_X'));
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body.posts, [], 'no cache and no upstream is an empty list, not a 500');
});

/* ---------------- the logged-out web-page (SSR flight) layer ---------------- */

/** A minimal x.com logged-out flight payload for the given tweets. Mirrors
 *  the real normalized-cache shape: base64 Tweet ids across :details/:counts
 *  facets, comma-joined so facet-boundary detection works, each key appearing
 *  as both a __ref pointer and its real definition (as the live page does). */
function flightHtml(tweets) {
  const parts = ['"client:seed:seed":$R[0]={ok:true}'];
  for (const t of tweets) {
    const key = Buffer.from('Tweet:' + t.id).toString('base64');
    const media = (t.photos || []).map((u) => ',media_url_https:"' + u + '"').join('');
    const rt = t.repost ? 'retweeted_status_results:$R[8]={n:1}' : 'retweeted_status_results:null';
    // A pointer to the details object, as the real payload carries first.
    parts.push('parent:$R[7]={details:$R[6]={__ref:"client:' + key + ':details"}}');
    parts.push('"client:' + key + ':counts":$R[1]={__id:"client:' + key +
      ':counts",__typename:"ApiCounts",favorite_count:' + (t.likes || 0) + ',reply_count:0}');
    parts.push('"client:' + key + ':details":$R[2]={__id:"client:' + key +
      ':details",__typename:"TBirdData",' + rt + ',created_at_ms:' + t.at +
      ',display_text_range:$R[3]=[0,5],full_text:"' + t.text + '"' + media + '}');
  }
  parts.push('"client:tail:tail":$R[99]={done:true}');
  return '<html><body><script>window.x=(' + parts.join(',') + ')</script></body></html>';
}

test('the logged-out page parser: real posts in, sanitized posts out (@naskvr\'s class)', async () => {
  const xfeed = (await import('../worker/xfeed.js')).default;
  const html = flightHtml([
    { id: '2085358060785000550', at: 1785807080000, likes: 1, text: 'Where\\u2019s the memecoin crowd?' },
    { id: '2085205964588830730', at: 1785770817000, likes: 3,
      text: 'look <script>alert(1)</script> at it',
      photos: ['https://pbs.twimg.com/media/ok.jpg', 'https://evil.example/x.jpg'] },
    { id: '2082578205030932631', at: 1785360311000, likes: 0, repost: true, text: 'not my words' },
  ]);
  const posts = xfeed.parseTimelineFlight(html);
  assert.equal(posts.length, 2, 'two originals kept, the repost dropped');
  assert.equal(posts[0].id, '2085358060785000550', 'newest first');
  assert.equal(posts[0].text, 'Where\u2019s the memecoin crowd?', 'JS-string escapes decode to real chars');
  const withMedia = posts.find((p) => p.id === '2085205964588830730');
  assert.ok(withMedia.text.includes('<script>alert(1)</script>'),
    'markup survives as INERT TEXT in JSON; neutralizing it is the renderer\'s job');
  assert.deepEqual(withMedia.photos, ['https://pbs.twimg.com/media/ok.jpg'],
    'only X\'s own image CDN survives; foreign media is dropped');
  assert.equal(withMedia.likes, 3);
  assert.ok(!posts.some((p) => p.text.includes('not my words')), 'reposts stay off the pane');
});

test('a reshaped page yields no posts, never a throw', async () => {
  const xfeed = (await import('../worker/xfeed.js')).default;
  assert.deepEqual(xfeed.parseTimelineFlight('<html>totally different now</html>'), []);
  assert.deepEqual(xfeed.parseTimelineFlight(''), []);
});

test('layering: syndication-empty falls to the logged-out page, which wins', async () => {
  const worker = await loadWorker();
  const db = fakeDB(xfeedRoute());
  const html = flightHtml([{ id: '999', at: 1785807080000, likes: 5, text: 'served logged-out' }]);
  const [res, calls] = await withUpstream((url) => {
    if (String(url).includes('syndication.twitter.com')) return new Response(syndicationHtml([]));
    if (String(url) === 'https://x.com/Terp_X') return new Response(html);
    throw new Error('unexpected upstream ' + url);
  }, () => getFeed(worker, db, '?handle=Terp_X'));
  assert.equal(res.status, 200);
  assert.equal(res.body.posts.length, 1);
  assert.equal(res.body.posts[0].text, 'served logged-out');
  assert.ok(!calls.some((u) => u.includes('api.x.com')),
    'the logged-out page answered, so no user token was spent');
  assert.ok(db.log.some((e) => e.sql.includes('INSERT INTO x_feed_cache')));
});

test('layering: logged-out page empty falls through to the user token', async () => {
  const worker = await loadWorker();
  const user = await tokenUser({ access: 'tok-abc', refresh: 'r1', exp: Date.now() + 3600000 });
  const [res, calls] = await withUpstream((url) => {
    if (String(url).includes('syndication.twitter.com')) return new Response(syndicationHtml([]));
    if (String(url) === 'https://x.com/Terp_X') return new Response('<html>no timeline here</html>');
    if (String(url).includes('api.x.com/2/users/900/tweets')) return new Response(JSON.stringify(V2_PAYLOAD));
    throw new Error('unexpected upstream ' + url);
  }, () => getFeed(worker, fakeDB(xfeedRoute({ user })), '?handle=Terp_X'));
  assert.equal(res.status, 200);
  assert.equal(res.body.posts[0].id, '555', 'the token layer caught what the public page could not');
  assert.ok(calls.some((u) => u === 'https://x.com/Terp_X'), 'the public page was tried first');
});

test('sealed OAuth tokens survive the round trip and refuse tampering', async () => {
  const xfeed = (await import('../worker/xfeed.js')).default;
  const pair = { access: 'tok-abc', refresh: 'r1', exp: 123456789 };
  const sealed = await xfeed.sealTokens(SECRET, pair);
  assert.ok(!sealed.includes('tok-abc') && !sealed.includes('r1'),
    'ciphertext carries no plaintext token material');
  assert.deepEqual(await xfeed.openTokens(SECRET, sealed), pair);
  const mid = Math.floor(sealed.length / 2);
  const bent = sealed.slice(0, mid) + (sealed[mid] === 'A' ? 'B' : 'A') + sealed.slice(mid + 1);
  assert.equal(await xfeed.openTokens(SECRET, bent), null, 'GCM authenticates: a bent blob is a null');
  assert.equal(await xfeed.openTokens(SECRET, 'garbage'), null);
});

/** A user row whose sealed pair the token layer can actually open. */
async function tokenUser(pair) {
  const xfeed = (await import('../worker/xfeed.js')).default;
  return { id: 7, x_id: '900', handle: 'Terp_X',
    x_tokens: await xfeed.sealTokens(SECRET, pair) };
}

const V2_PAYLOAD = {
  data: [{
    id: '555', text: 'gm from the trenches https://t.co/pic https://t.co/link',
    created_at: '2026-08-11T10:00:00.000Z',
    public_metrics: { like_count: 12 },
    entities: { urls: [
      { url: 'https://t.co/pic', expanded_url: 'https://x.com/Terp_X/status/555/photo/1' },
      { url: 'https://t.co/link', expanded_url: 'https://papertrench.com' },
    ] },
    attachments: { media_keys: ['m1', 'm2'] },
  }],
  includes: { media: [
    { media_key: 'm1', type: 'photo', url: 'https://pbs.twimg.com/media/p.jpg' },
    { media_key: 'm2', type: 'photo', url: 'https://evil.example/p.jpg' },
  ] },
};

test('a syndication-invisible account is served through its own token, which never leaks', async () => {
  const worker = await loadWorker();
  const user = await tokenUser({ access: 'tok-abc', refresh: 'r1', exp: Date.now() + 3600000 });
  const db = fakeDB(xfeedRoute({ user }));
  const authSeen = [];
  const [res, calls] = await withUpstream((url, init) => {
    if (String(url).includes('syndication.twitter.com')) return new Response(syndicationHtml([]));
    if (String(url).includes('api.x.com/2/users/900/tweets')) {
      authSeen.push(init && init.headers && init.headers.Authorization);
      return new Response(JSON.stringify(V2_PAYLOAD));
    }
    throw new Error('unexpected upstream ' + url);
  }, () => getFeed(worker, db, '?handle=Terp_X'));

  assert.equal(res.status, 200);
  assert.equal(res.body.posts.length, 1);
  const post = res.body.posts[0];
  assert.equal(post.id, '555');
  assert.ok(post.text.includes('https://papertrench.com'), 't.co stubs expand, same as syndication ingest');
  assert.ok(!post.text.includes('t.co/pic'), 'the media stub leaves the text; the photo rides in photos');
  assert.deepEqual(post.photos, ['https://pbs.twimg.com/media/p.jpg'],
    'the v2 path holds the same CDN whitelist as the syndication path');
  assert.equal(post.likes, 12);
  assert.deepEqual(authSeen, ['Bearer tok-abc'], 'the token goes to api.x.com and nowhere else');
  assert.ok(!calls.some((u) => u.includes('syndication') && u.includes('tok-abc')));
  assert.ok(!JSON.stringify(res.body).includes('tok-abc'), 'no token material in any response');
  assert.ok(db.log.some((e) => e.sql.includes('INSERT INTO x_feed_cache')),
    'the token-sourced feed lands in the same cache');
});

test('an expired access token refreshes, rotates in sealed form, and never leaks', async () => {
  const worker = await loadWorker();
  const user = await tokenUser({ access: 'tok-old', refresh: 'r1', exp: Date.now() - 1000 });
  const db = fakeDB(xfeedRoute({ user }));
  const [res] = await withUpstream((url, init) => {
    if (String(url).includes('syndication.twitter.com')) return new Response(syndicationHtml([]));
    if (String(url).includes('api.x.com/2/oauth2/token')) {
      return new Response(JSON.stringify(
        { access_token: 'tok-new', refresh_token: 'r2', expires_in: 7200 }));
    }
    if (String(url).includes('api.x.com/2/users/900/tweets')) {
      const auth = init && init.headers && init.headers.Authorization;
      if (auth !== 'Bearer tok-new') return new Response('{}', { status: 401 });
      return new Response(JSON.stringify(V2_PAYLOAD));
    }
    throw new Error('unexpected upstream ' + url);
  }, () => getFeed(worker, db, '?handle=Terp_X'));

  assert.equal(res.status, 200);
  assert.equal(res.body.posts[0].id, '555');
  const rotated = db.log.find((e) => e.sql.includes('UPDATE users SET x_tokens'));
  assert.ok(rotated, 'the rotated pair is written back — X invalidates the old refresh token');
  // Scanning random ciphertext for plaintext fragments is probabilistic: a
  // base64 blob of this length contains the two-char sequence "r2" by pure
  // chance about 4% of the time, which made this test flake ~1/40 runs.
  // Prove the same thing deterministically: open the stored blob with the
  // secret and confirm it IS the rotated pair, sealed — not plaintext.
  const xfeedMod = await import('../worker/xfeed.js');
  const reopened = await xfeedMod.default.openTokens(SECRET, String(rotated.args[0]));
  assert.ok(reopened && reopened.access === 'tok-new' && reopened.refresh === 'r2',
    'what lands in D1 is the sealed rotated pair (opens back to it, never plaintext)');
  assert.ok(JSON.stringify(rotated.args[0]) !== JSON.stringify({ access: 'tok-new', refresh: 'r2' }),
    'the stored blob is not the bare JSON pair');
  assert.ok(!JSON.stringify(res.body).includes('tok-new') && !JSON.stringify(res.body).includes('r2'));
});

test('the token layer only fires when syndication comes back empty', async () => {
  const worker = await loadWorker();
  const user = await tokenUser({ access: 'tok-abc', refresh: 'r1', exp: Date.now() + 3600000 });
  const [res, calls] = await withUpstream((url) => {
    if (String(url).includes('syndication.twitter.com')) {
      return new Response(syndicationHtml([{ id_str: '777',
        created_at: '2026-08-11T09:00:00.000Z', full_text: 'free source first' }]));
    }
    throw new Error('unexpected upstream ' + url);
  }, () => getFeed(worker, fakeDB(xfeedRoute({ user })), '?handle=Terp_X'));
  assert.equal(res.body.posts[0].id, '777');
  assert.ok(!calls.some((u) => u.includes('api.x.com')),
    'the free source answered, so the user\'s token stays unspent');
});

test('sign-in asks for offline.access, so feeds outlive the two-hour token', async () => {
  const auth = (await import('../worker/auth.js')).default;
  const response = await auth.startLogin(
    new Request('https://api.test/api/auth/x/start'),
    { X_CLIENT_ID: 'cid', X_REDIRECT_URI: 'https://api.test/cb', SESSION_SECRET: SECRET });
  assert.equal(response.status, 302);
  const scope = new URL(response.headers.get('Location')).searchParams.get('scope');
  assert.equal(scope, 'users.read tweet.read offline.access');
});

test('the upstream leash is per IP and never blocks what the cache can answer', async () => {
  const worker = await loadWorker();
  const overDb = fakeDB(xfeedRoute({ rateCount: 999 }));
  const [denied] = await withUpstream(() => { throw new Error('leashed'); },
    () => getFeed(worker, overDb, '?handle=Terp_X'));
  assert.equal(denied.status, 429);
  const rateOp = overDb.log.find((e) => e.sql.includes('rate_limits'));
  assert.ok(String(rateOp.args[0]).startsWith('xfeed:'), 'keyed per requester, not globally');

  const stale = { fetched_at: Date.now() - 2 * 3600 * 1000,
    posts_json: JSON.stringify([{ id: '9', text: 'served anyway', createdAt: 1, photos: [], likes: 0 }]) };
  const [served] = await withUpstream(() => { throw new Error('leashed'); },
    () => getFeed(worker, fakeDB(xfeedRoute({ rateCount: 999, cache: stale })), '?handle=Terp_X'));
  assert.equal(served.status, 200);
  assert.equal(served.body.posts[0].text, 'served anyway',
    'the limit protects the upstream fetch; a cached answer costs it nothing');
});
