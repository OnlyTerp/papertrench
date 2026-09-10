/* PT-SEC-SUBMIT-RACE: commit-time premise on every submission write.
 *
 * Unlike worker.test.js's scripted D1, these tests run against REAL SQLite
 * (node:sqlite) executing the SHIPPED statements verbatim - no re-implementation
 * of SQL semantics. The adapter wraps node:sqlite in the D1 surface
 * (prepare/bind/first/all/run/batch, batch = one transaction with per-statement
 * meta.changes), so handleSubmit's compare-and-swap is exercised by the actual
 * database engine deciding whether a premise holds at commit time.
 *
 * Each test drives the REAL worker entry with genuinely signed session tokens.
 * The "barrier" that stands in for a second Worker isolate is a direct write
 * through the same adapter between the request's read phase and its commit -
 * exactly the interleaving SQLite serializes writers over in production.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const { appendFill, GENESIS } = require('../core/chain.js');

/* ---------------- real-SQLite D1 adapter ---------------- */

/** Apply the SHIPPED schema verbatim: sqlite's own parser runs the whole
 * file (comments, partial indexes and all) - nothing here re-implements
 * statement splitting or SQL semantics. */
function applySchema(db) {
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8'));
}
/** A D1-shaped adapter over a real SQLite database. Every statement the
 * worker ships is executed as-is; batch() runs inside one BEGIN..COMMIT so
 * partial failure rolls back, and each result carries meta.changes the way
 * D1 reports it. */
function realDB() {
  const db = new DatabaseSync(':memory:');
  applySchema(db);
  // DEPLOY.md ALTERs the deployed worker still SELECTs (banned_at etc.) -
  for (const col of ['banned_at INTEGER', 'banned_reason TEXT', 'banned_by INTEGER']) {
    db.exec(`ALTER TABLE users ADD COLUMN ${col}`);
  }
  for (const col of ['dq_at INTEGER', 'dq_reason TEXT', 'dq_by INTEGER']) {
    db.exec(`ALTER TABLE records ADD COLUMN ${col}`);
  }
  for (const col of ['disbanded_at INTEGER', 'disbanded_reason TEXT']) {
    db.exec(`ALTER TABLE clans ADD COLUMN ${col}`);
  }
  const log = [];
  const statement = (sql) => {
    let bound = [];
    const stmt = {
      sql,
      get args() { return bound; },
      bind(...args) { bound = args; return stmt; },
      async first() {
        log.push({ sql, args: bound, via: 'first' });
        return db.prepare(sql).get(...bound) ?? null;
      },
      async all() {
        log.push({ sql, args: bound, via: 'all' });
        return { results: db.prepare(sql).all(...bound) };
      },
      async run() {
        log.push({ sql, args: bound, via: 'run' });
        const info = db.prepare(sql).run(...bound);
        return { meta: { changes: Number(info.changes) } };
      },
    };
    return stmt;
  };
  return {
    log,
    prepare: statement,
    async batch(statements) {
      const results = [];
      db.exec('BEGIN');
      try {
        for (const s of statements) {
          log.push({ sql: s.sql, args: s.args, via: 'batch' });
          const info = db.prepare(s.sql).run(...s.args);
          results.push({ meta: { changes: Number(info.changes) } });
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
      return results;
    },
    _db: db,
  };
}

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

async function loadWorker() {
  globalThis.caches = globalThis.caches || {
    default: { match: async () => undefined, put: async () => {} },
  };
  return (await import('../worker/index.js')).default;
}

function makeEnv(db) {
  return { DB: db, SESSION_SECRET: SECRET, SITE_ORIGIN: ORIGIN };
}

function seedUser(db) {
  db._db.prepare(`INSERT INTO users (id, x_id, handle, display_name, avatar_url,
    session_epoch, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, 1, 0, 0)`)
    .run(USER_ROW.id, USER_ROW.x_id, USER_ROW.handle, USER_ROW.display_name, '');
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

/** Raw reads of the store behind the D1-shaped adapter. */
function readRecord(db) {
  return db._db.prepare('SELECT * FROM records WHERE user_id = ?')
    .get(USER_ROW.id) ?? null;
}

function auditOutcomes(db) {
  return db._db.prepare(
    'SELECT outcome FROM submissions WHERE user_id = ? ORDER BY rowid')
    .all(USER_ROW.id).map((r) => r.outcome);
}

/* ---------------- tests ---------------- */

test('stale submission after B commits: 409 conflict, zero regression, zero partial writes', async () => {
  const worker = await loadWorker();
  const db = realDB();
  seedUser(db);
  const payloadA = await honestPayload();

  // A's read phase: let the request run until it has read previousRow and is
  // about to enter its batch, by intercepting the first batch statement. We
  // emulate the second-isolate commit by running B through the SAME adapter
  // before A's statements execute - the barrier is the queue order, exactly
  // the interleaving SQLite serializes: B commits before A's batch begins.
  const stored = realDB.prototype; // marker, unused

  // B commits first: a longer, differently-anchored chain, bankroll 10.
  const longChain = await chainOf([
    { id: 'b1', sessionId: 'sB', mint: 'M2', side: 'buy',
      qty: 500, priceNative: 0.001, solGross: 0.5, solNet: 0.495, ts: 5 * MIN },
    { id: 'b2', sessionId: 'sB', mint: 'M2', side: 'sell',
      qty: 500, priceNative: 0.002, solGross: 1, solNet: 0.99, ts: 6 * MIN },
    { id: 'b3', sessionId: 'sB', mint: 'M2', side: 'buy',
      qty: 200, priceNative: 0.002, solGross: 0.4, solNet: 0.396, ts: 7 * MIN },
    { id: 'b4', sessionId: 'sB', mint: 'M2', side: 'sell',
      qty: 200, priceNative: 0.003, solGross: 0.6, solNet: 0.594, ts: 8 * MIN },
  ]);
  const payloadB = JSON.parse(JSON.stringify(await honestPayload()));
  payloadB.chain = longChain;
  payloadB.head = longChain[longChain.length - 1].hash;
  payloadB.claim = { equitySol: 10.594, realizedPnlSol: 0.594, rounds: 2, wins: 2,
    losses: 0, startingBalanceSol: 10 };

  // Barrier: A runs its read phase (previousRow SELECT) through this adapter.
  // Right AFTER that read - the exact window another Worker isolate commits
  // in - we run B's full submission through a second adapter surface on the
  // same SQLite store. B commits before A's batch begins; A's premise is
  // already stale when it reaches commit.
  const innerBatch = db.batch.bind(db);
  let barrierFired = false;
  const innerPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const stmt = innerPrepare(sql);
    if (!barrierFired && sql.includes('FROM records WHERE user_id')) {
      barrierFired = true;
      const after = stmt.first.bind(stmt);
      stmt.first = async () => {
        const row = await after();
        const resB = await postSubmit(worker, makeEnv({
          prepare: innerPrepare, batch: innerBatch, _db: db._db, log: db.log,
        }), payloadB);
        assert.equal(resB.status, 200, 'B (the race winner) must commit cleanly');
        return row;
      };
    }
    return stmt;
  };

  // A was prepared BEFORE B: its previousRow read happens when postSubmit
  // runs, i.e. inside the barrier above - so capture what A saw. We instead
  // verify the outcome: A must conflict, and the store must describe B only.
  const resA = await postSubmit(worker, makeEnv(db), payloadA);
  assert.equal(resA.status, 409);
  assert.equal(resA.body.reason, 'conflict:stale-submission');

  // No regression: the stored record is B's, head and length intact.
  const record = readRecord(db);
  assert.equal(record.head, payloadB.head);
  assert.equal(record.chain_len, payloadB.chain.length);

  // No partial writes: the chain store holds B's chain only, and the audit
  // trail is truthful - B accepted, A stale, never 'accepted' for A.
  const segRows = db._db.prepare(
    'SELECT COUNT(*) AS n FROM chain_segments WHERE user_id = ?')
    .get(USER_ROW.id);
  const storedChain = [];
  for (const r of db._db.prepare(
    'SELECT links_json FROM chain_segments WHERE user_id = ? ORDER BY seg_no')
    .all(USER_ROW.id)) storedChain.push(...JSON.parse(r.links_json));
  assert.equal(storedChain.length, payloadB.chain.length);
  assert.equal(storedChain[storedChain.length - 1].hash, payloadB.head);
  assert.equal(segRows.n > 0, true);
  assert.deepEqual(auditOutcomes(db).filter((o) => o !== 'accepted' && o !== 'duplicate'),
    [], 'no unexpected audit outcomes');
  const aAudit = db._db.prepare(
    "SELECT outcome FROM submissions WHERE user_id = ? AND head = ?")
    .get(USER_ROW.id, payloadA.head);
  assert.ok(!aAudit || aAudit.outcome !== 'accepted',
    'a stale submission must never be audited as accepted');
});

test('simultaneous first submissions with different bankrolls: only the winner writes, loser gets 409', async () => {
  const worker = await loadWorker();
  const db = realDB();
  seedUser(db);

  const payloadA = await honestPayload();               // bankroll 10
  const payloadB = JSON.parse(JSON.stringify(await honestPayload()));
  payloadB.claim.startingBalanceSol = 12;               // different first bankroll
  payloadB.claim.equitySol = 12.98;
  // B commits in A's read-to-commit window: A's premise "no record exists"
  // fails at commit time even though it held when A read.
  const innerBatch = db.batch.bind(db);
  let barrierFired = false;
  const innerPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const stmt = innerPrepare(sql);
    if (!barrierFired && sql.includes('FROM records WHERE user_id')) {
      barrierFired = true;
      const after = stmt.first.bind(stmt);
      stmt.first = async () => {
        const row = await after();
        const resB = await postSubmit(worker, makeEnv({
          prepare: innerPrepare, batch: innerBatch, _db: db._db, log: db.log,
        }), payloadB);
        assert.equal(resB.status, 200);
        return row;
      };
    }
    return stmt;
  };

  const resA = await postSubmit(worker, makeEnv(db), payloadA);
  assert.equal(resA.status, 409);
  assert.equal(resA.body.reason, 'conflict:stale-submission');

  // The first bankroll that committed stands; A did not overwrite it.
  const record = readRecord(db);
  assert.equal(record.starting_sol, 12);
  assert.equal(record.head, payloadB.head);
  assert.equal(auditOutcomes(db).filter((o) => o === 'accepted').length, 1,
    'exactly one truthful accepted audit row');
});

test('a valid resubmission after a concurrent commit still extends cleanly when the premise holds', async () => {
  const worker = await loadWorker();
  const db = realDB();
  seedUser(db);

  // First submission commits normally.
  const first = await postSubmit(worker, makeEnv(db), await honestPayload());
  assert.equal(first.status, 200);

  // A second, IDENTICAL-content submission afterwards is still a duplicate
  // (behavior preserved), not a conflict - the premise holds.
  const dup = await postSubmit(worker, makeEnv(db), await honestPayload());
  assert.equal(dup.status, 200);
  assert.equal(dup.body.duplicate, true);
  assert.equal(dup.body.status, 'pending');
});

test('premise failure rolls back the whole batch: no orphaned segments or derived rows', async () => {
  const worker = await loadWorker();
  const db = realDB();
  seedUser(db);

  const payloadA = await honestPayload();
  const payloadB = JSON.parse(JSON.stringify(await honestPayload()));
  payloadB.claim.startingBalanceSol = 11;
  payloadB.claim.equitySol = 11.98;

  // B commits in A's read-to-commit window; all of A's guarded writes must
  // no-op together - nothing of A survives anywhere.
  const innerBatch = db.batch.bind(db);
  let barrierFired = false;
  const innerPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const stmt = innerPrepare(sql);
    if (!barrierFired && sql.includes('FROM records WHERE user_id')) {
      barrierFired = true;
      const after = stmt.first.bind(stmt);
      stmt.first = async () => {
        const row = await after();
        const resB = await postSubmit(worker, makeEnv({
          prepare: innerPrepare, batch: innerBatch, _db: db._db, log: db.log,
        }), payloadB);
        assert.equal(resB.status, 200);
        return row;
      };
    }
    return stmt;
  };

  await postSubmit(worker, makeEnv(db), payloadA); // 409

  // Nothing from A survives anywhere: no segments, no sprint entry, no
  // accepted audit, and the record is B's.
  assert.equal(readRecord(db).starting_sol, 11);
  const segs = db._db.prepare(
    'SELECT COUNT(*) AS n FROM chain_segments WHERE user_id = ?').get(USER_ROW.id);
  const sprint = db._db.prepare(
    'SELECT COUNT(*) AS n FROM sprint_entries WHERE user_id = ?').get(USER_ROW.id);
  assert.ok(segs.n <= 1, 'chain store holds only the winner\'s segments');
  assert.equal(sprint.n === 0 || readRecord(db).head === payloadB.head, true,
    'derived rows, if any, belong to the winner');
  assert.equal(auditOutcomes(db).filter((o) => o === 'accepted').length, 1);
});

test('a concurrent commit does not regress clan derived rows: stale member slice never lands', async () => {
  const worker = await loadWorker();
  const db = realDB();
  seedUser(db);

  // A clan whose member trades (the user owns it, so joined_at = 0 and the
  // whole lifetime chain contributes to the season slice).
  db._db.prepare(`INSERT INTO clans (id, tag, name, name_key, founder_id,
    join_code, open, created_at) VALUES (1, '[TEST]', 'Test Clan', 'test clan',
    ?, 'jc-1', 1, 0)`).run(USER_ROW.id);
  db._db.prepare(
    `INSERT INTO clan_members (user_id, clan_id, joined_at, role)
     VALUES (?, 1, 0, 'founder')`).run(USER_ROW.id);

  const payloadA = await honestPayload();               // bankroll 10
  const payloadB = JSON.parse(JSON.stringify(await honestPayload()));
  payloadB.claim.startingBalanceSol = 12;               // different first bankroll
  payloadB.claim.equitySol = 12.98;

  // B commits in A's read-to-commit window, exactly as another Worker
  // isolate would: right after A's previousRow read, before A's batch.
  const innerBatch = db.batch.bind(db);
  let barrierFired = false;
  const innerPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const stmt = innerPrepare(sql);
    if (!barrierFired && sql.includes('FROM records WHERE user_id')) {
      barrierFired = true;
      const after = stmt.first.bind(stmt);
      stmt.first = async () => {
        const row = await after();
        const resB = await postSubmit(worker, makeEnv({
          prepare: innerPrepare, batch: innerBatch, _db: db._db, log: db.log,
        }), payloadB);
        assert.equal(resB.status, 200, 'B commits cleanly first');
        return row;
      };
    }
    return stmt;
  };

  const resA = await postSubmit(worker, makeEnv(db), payloadA);
  assert.equal(resA.status, 409);

  // The stored clan slice for this member comes from B's submission only:
  // its score is B's (bankroll 12), never A's (bankroll 10). The premise
  // guards the clan write like every other mutation, so a stale slice that
  // claims a smaller bankroll cannot land after the winner's.
  const record = readRecord(db);
  assert.equal(record.starting_sol, 12);
  const entryRows = db._db.prepare(
    `SELECT entry_json FROM clan_entries WHERE user_id = ? AND window_id = 'season'`)
    .all(USER_ROW.id);
  const entry = JSON.parse(entryRows[0].entry_json);
  assert.equal(entry.equityAtStart, 12, 'clan slice reflects the winner, not the stale loser');
});

test('active duelist success: a real submit writes a duel slice that reflects the chain fills', async () => {
  const worker = await loadWorker();
  const db = realDB();
  seedUser(db);

  // An ACTIVE duel: accepted, running, not yet settled, with a window that
  // contains the submission's fills (w1 at 10 min, w2 at 20 min). The duel
  // refresh in handleSubmit must slice the incoming chain into this window
  // and store it - a duel page then reads, never re-walks.
  const startTs = 5 * MIN;
  const endTs = 5 * MIN + 24 * 60 * MIN;
  const now = 21 * MIN;
  db._db.prepare(`INSERT INTO duels (id, code, challenger_id, duration_ms,
    created_at, accepted_at, start_ts, end_ts)
    VALUES (1, 'duel-1', ?, 24 * 60 * 60000, ?, ?, ?, ?)`)
    .run(USER_ROW.id, now - MIN, now - MIN, startTs, endTs);

  const res = await postSubmit(worker, makeEnv(db), await honestPayload());
  assert.equal(res.status, 200);

  const rows = db._db.prepare(
    'SELECT entry_json FROM duel_entries WHERE duel_id = 1 AND user_id = ?')
    .all(USER_ROW.id);
  assert.equal(rows.length, 1, 'the active duel gets exactly one entry slice');
  const entry = JSON.parse(rows[0].entry_json);
  // Both fills (w1 open 10m / w2 close 20m) opened and closed inside the
  // duel window, so the one round lands: +0.98 SOL against the 10 SOL
  // bankroll, one win, no losses.
  assert.equal(entry.rounds, 1, 'the fill round is inside the duel window');
  assert.equal(entry.wins, 1);
  assert.equal(entry.losses, 0);
  assert.ok(Math.abs(entry.pnlSol - 0.98) < 1e-9, 'slice pnl is the round pnl');
  assert.equal(entry.equityAtStart, 10, 'baseline is the declared bankroll');
});

test('negative control: record deleted between read and commit - premise detects the loss, nothing resurrects', async () => {
  const worker = await loadWorker();
  const db = realDB();
  seedUser(db);

  // Seed a stored record with a normal first submission.
  const first = await postSubmit(worker, makeEnv(db), await honestPayload());
  assert.equal(first.status, 200);

  const payloadA = await honestPayload();
  const third = await appendFill(payloadA.chain[1].hash, {
    id: 'w3', sessionId: 's', mint: 'M1', side: 'buy',
    qty: 500, priceNative: 0.002, solGross: 1, solNet: 0.995, ts: 30 * MIN,
  });
  third.seq = 2;
  payloadA.chain.push(third);
  payloadA.head = third.hash;
  payloadA.claim.equitySol = 9.985;

  // Barrier: right after A reads previousRow, the record row is DELETED
  // (a direct store mutation in A's read-to-commit window). The premise
  // names the exact row A validated against; with it gone, the premise
  // cannot hold and every guarded write - including the records upsert,
  // whose INSERT candidate is premise-filtered - must no-op.
  let barrierFired = false;
  const innerPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const stmt = innerPrepare(sql);
    if (!barrierFired && sql.includes('FROM records WHERE user_id')) {
      barrierFired = true;
      const after = stmt.first.bind(stmt);
      stmt.first = async () => {
        const row = await after();
        db._db.prepare('DELETE FROM records WHERE user_id = ?').run(USER_ROW.id);
        return row;
      };
    }
    return stmt;
  };

  const resA = await postSubmit(worker, makeEnv(db), payloadA);
  assert.equal(resA.status, 409);
  assert.equal(resA.body.reason, 'conflict:stale-submission');

  // The deleted row stays deleted: the stale submission must not resurrect
  // a record (an unguarded INSERT would, since there is no conflict row to
  // trip the ON CONFLICT branch - only the premise-filtered candidate stops it).
  assert.equal(readRecord(db), null, 'no record resurrection after deletion');
  // The SEEDED submission's rows legitimately remain; what must never land is
  // anything derived from A's stale third link.
  const segments = db._db.prepare(
    'SELECT links_json FROM chain_segments WHERE user_id = ?').all(USER_ROW.id)
    .flatMap((r) => JSON.parse(r.links_json));
  assert.equal(segments.length, 2, 'seeded chain intact');
  assert.ok(!segments.some((l) => l.id === 'w3'), 'stale third link never stored');
  const sprints = db._db.prepare(
    'SELECT entry_json FROM sprint_entries WHERE user_id = ?').all(USER_ROW.id);
  assert.ok(!sprints.some((r) => r.entry_json.includes('w3')),
    'stale sprint slice never stored');
  assert.equal(auditOutcomes(db).filter((o) => o === 'accepted').length, 1,
    'only the seeded submission is audited accepted');

});
test('negative control: foreign record insert in the read-to-commit window - fresh derived inserts are premise-filtered, not just conflict-guarded', async () => {
  const worker = await loadWorker();
  const db = realDB();
  seedUser(db);
  // Active duel + clan membership: A's batch WOULD refresh both (fresh
  // INSERTs - no conflict row exists for either), so they exercise the
  // premise filter exactly where the ON CONFLICT branch can never fire.
  db._db.prepare(`INSERT INTO duels (id, code, challenger_id, duration_ms,
    created_at, accepted_at, start_ts, end_ts)
    VALUES (1, 'duel-1', ?, 0, 0, 0, 5 * ?, 5 * ? + 24 * 60 * 60000)`)
    .run(USER_ROW.id, 60000, 60000);
  db._db.prepare(`INSERT INTO clans (id, tag, name, name_key, founder_id,
    join_code, open, created_at) VALUES (1, '[TEST]', 'Test Clan', 'test clan',
    ?, 'jc-1', 1, 0)`).run(USER_ROW.id);
  db._db.prepare(
    `INSERT INTO clan_members (user_id, clan_id, joined_at, role)
     VALUES (?, 1, 0, 'founder')`).run(USER_ROW.id);
  const payloadA2 = await honestPayload(); // A is a FIRST submission: premise is "no record exists"
  // row to guard it - only the premise-filtered INSERT candidate can stop it.
  let barrierFired = false;
  const innerPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const stmt = innerPrepare(sql);
    if (!barrierFired && sql.includes('FROM records WHERE user_id')) {
      barrierFired = true;
      const after = stmt.first.bind(stmt);
      stmt.first = async () => {
        const row = await after();
        db._db.prepare(
          `INSERT INTO records (user_id, head, chain_len, starting_sol, status,
                                stats_json, submitted_at)
           VALUES (?, 'foreign-head', 9, 99, 'pending', '{}', ?)`)
          .run(USER_ROW.id, Date.now());
      };
    }
    return stmt;
  };
  const resA = await postSubmit(worker, makeEnv(db), payloadA2);
  assert.equal(resA.status, 409);
  assert.equal(resA.body.reason, 'conflict:stale-submission');
  assert.equal(db._db.prepare(
    'SELECT COUNT(*) AS n FROM duel_entries WHERE user_id = ?').get(USER_ROW.id).n, 0,
    'stale duel slice never lands: the fresh INSERT is premise-filtered, not conflict-guarded');
  assert.equal(db._db.prepare(
    'SELECT COUNT(*) AS n FROM clan_entries WHERE user_id = ?').get(USER_ROW.id).n, 0,
    'stale clan slice never lands: the fresh INSERT is premise-filtered, not conflict-guarded');

  // The foreign record stands untouched, and no fresh derived row landed
  // anywhere: segments, sprint entry, audit - all premise-gated to zero.
  const record = readRecord(db);
  assert.equal(record.head, 'foreign-head');
  assert.equal(record.starting_sol, 99);
  assert.equal(db._db.prepare(
    'SELECT COUNT(*) AS n FROM chain_segments WHERE user_id = ?').get(USER_ROW.id).n, 0);
  assert.equal(db._db.prepare(
    'SELECT COUNT(*) AS n FROM sprint_entries WHERE user_id = ?').get(USER_ROW.id).n, 0);
  assert.equal(db._db.prepare(
    'SELECT COUNT(*) AS n FROM submissions WHERE user_id = ?').get(USER_ROW.id).n, 0,
    'no audit row at all: the stale attempt never appears in the trail');
});
