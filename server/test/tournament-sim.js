/* Tournament simulation — drives the REAL worker (fetch + scheduled) against
 * a real SQLite database (node:sqlite) with the production schema applied.
 *
 * 25 fake traders, compressed rounds: create → join → live board → boundary
 * eliminates bottom 5 → snapshots flow → next boundary → … → final standings.
 * Every assertion is on observable API output or DB state, never internals.
 *
 * Run: node test/tournament-sim.js   (throwaway verification, not a suite test)
 */
'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const SECRET = 'sim-secret';
const ORIGIN = 'https://papertrench.com';
const MIN = 60000;

/* ---------------- D1 shim over node:sqlite ---------------- */

function d1(db) {
  const prepare = (sql) => {
    let bound = [];
    const stmt = {
      sql,
      bind(...args) { bound = args; return stmt; },
      async run() {
        const s = db.prepare(sql);
        const r = s.run(...bound);
        return { meta: { changes: Number(r.changes), last_rowid: Number(r.lastInsertRowid) } };
      },
      async first() { return db.prepare(sql).get(...bound) || null; },
      async all() { return { results: db.prepare(sql).all(...bound) }; },
    };
    return stmt;
  };
  return {
    prepare,
    async batch(stmts) {
      const out = [];
      db.exec('BEGIN');
      try {
        for (const s of stmts) out.push(await s.run());
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      return out;
    },
  };
}

/* ---------------- harness ---------------- */

function b64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sessionToken(uid, epoch) {
  const body = b64url(new TextEncoder().encode(
    JSON.stringify({ uid, epoch, exp: Date.now() + 3600000 })));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  return body + '.' + sig;
}

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log('  PASS', name); }
  else { failures++; console.log('  FAIL', name, detail == null ? '' : '— ' + detail); }
}

async function main() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8'));
  // The moderation columns live in DEPLOY.md ALTERs, not schema.sql — apply
  // them the way production did, because sessionUser selects banned_at.
  for (const sql of [
    'ALTER TABLE users ADD COLUMN banned_at INTEGER',
    'ALTER TABLE users ADD COLUMN banned_reason TEXT',
    'ALTER TABLE users ADD COLUMN banned_by INTEGER',
    'ALTER TABLE records ADD COLUMN dq_at INTEGER',
    'ALTER TABLE records ADD COLUMN dq_reason TEXT',
    'ALTER TABLE records ADD COLUMN dq_by INTEGER',
    'ALTER TABLE clans ADD COLUMN disbanded_at INTEGER',
    'ALTER TABLE clans ADD COLUMN disbanded_reason TEXT',
  ]) db.exec(sql);

  const DB = d1(db);

  const env = { DB, SESSION_SECRET: SECRET, SITE_ORIGIN: ORIGIN, SITE_ORIGIN_ALT: '' };
  globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
  const worker = (await import('../worker/index.js')).default;
  const ctx = { waitUntil: (p) => { ctx.pending = p; } };

  // 25 users.
  const users = [];
  const now0 = Date.now();
  for (let i = 1; i <= 25; i++) {
    db.prepare(`INSERT INTO users (x_id, handle, display_name, avatar_url, session_epoch, created_at, last_login_at)
      VALUES (?, ?, ?, '', 0, ?, ?)`).run('x' + i, 'trader' + i, 'Trader ' + i, now0, now0);
    users.push({ id: i, handle: 'trader' + i, token: await sessionToken(i, 0) });
  }

  const get = async (p, token) => {
    const res = await worker.fetch(new Request('https://api.test' + p, {
      headers: token ? { Authorization: 'Bearer ' + token } : {},
    }), env, ctx);
    return { status: res.status, body: await res.json() };
  };
  const post = async (p, token, payload) => {
    const res = await worker.fetch(new Request('https://api.test' + p, {
      method: 'POST',
      headers: { Origin: ORIGIN, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    }), env, ctx);
    return { status: res.status, body: await res.json() };
  };
  const tick = async () => { await worker.scheduled({}, env, ctx); await ctx.pending; };

  /* ---- create ---- */
  console.log('\n== create ==');
  const created = await post('/api/tournament/create', users[0].token, {
    name: 'Simulated Trench Open', fieldSize: 25, startStackSol: 10,
    roundHours: 24, cutPerRound: 5, prizePoolSol: 100,
    startTs: Date.now() + 365 * 86400000, // far future; we compress by editing start_ts
  });
  check('create returns ok+code', created.status === 200 && created.body.ok && /^[A-Z2-9]{6}$/.test(created.body.code), JSON.stringify(created.body));
  const CODE = created.body.code;

  const noAuth = await post('/api/tournament/create', null, { name: 'Nope' });
  check('create without session refused', noAuth.status === 401);
  const badOrigin = await worker.fetch(new Request('https://api.test/api/tournament/create', {
    method: 'POST', headers: { Origin: 'https://evil.example', Authorization: 'Bearer ' + users[1].token },
    body: '{}',
  }), env, ctx);
  check('create with foreign origin refused', badOrigin.status === 403);

  /* ---- join ---- */
  console.log('\n== join ==');
  for (let i = 1; i < 25; i++) {
    const r = await post('/api/tournament/' + CODE + '/join', users[i].token);
    if (!r.body.ok) { check('join trader' + (i + 1), false, JSON.stringify(r.body)); }
  }
  let board = (await get('/api/tournament/' + CODE + '/board')).body;
  check('25 seats filled', board.tournament.entrantCount === 25, String(board.tournament.entrantCount));
  check('still open until start', board.tournament.status === 'open');

  // 26th seat must refuse.
  db.prepare(`INSERT INTO users (x_id, handle, session_epoch, created_at, last_login_at) VALUES ('x26','trader26',0,?,?)`).run(now0, now0);
  const t26 = await sessionToken(26, 0);
  const full = await post('/api/tournament/' + CODE + '/join', t26);
  check('26th entrant refused (full)', full.status === 409 && full.body.reason === 'full', JSON.stringify(full.body));
  const rejoin = await post('/api/tournament/' + CODE + '/join', users[5].token);
  check('double join is idempotent', rejoin.status === 200 && rejoin.body.ok && rejoin.body.already === true);

  /* ---- start (compress: pull start_ts to now) ---- */
  console.log('\n== start ==');
  db.prepare('UPDATE tournaments SET start_ts = ? WHERE code = ?').run(Date.now() - 1000, CODE);
  await tick();
  board = (await get('/api/tournament/' + CODE + '/board')).body;
  check('tournament live after boundary tick', board.tournament.status === 'live' && board.tournament.currentRound === 1,
    board.tournament.status + ' r' + board.tournament.currentRound);
  check('all 25 alive, no snapshots → PnL 0', board.standings.length === 25 &&
    board.standings.every((r) => r.alive && r.pnlSol === 0 && !r.hasSnapshot));

  const lateJoin = await post('/api/tournament/' + CODE + '/join', t26);
  check('join after start refused', lateJoin.status === 409 && lateJoin.body.reason === 'not-open');

  /* ---- rounds ---- */
  // Deterministic PnL per trader per round: trader i pushes equity that keeps
  // them ranked i (trader1 strongest). Each round the bottom 5 must be cut.
  const equityFor = (i, round) => 10 + (25 - i) * 0.5 + round * 0.01; // trader index 0..24
  const expectedAlive = [25, 20, 15, 10, 5];
  const expectedCut = [5, 5, 5, 5];

  for (let round = 1; round <= 4; round++) {
    console.log('\n== round ' + round + ' ==');
    // Alive traders push snapshots (skip trader24 in round 1 to cover no-data).
    const aliveRows = db.prepare(
      'SELECT user_id FROM tournament_entrants WHERE tournament_id = (SELECT id FROM tournaments WHERE code = ?) AND alive = 1')
      .all(CODE).map((r) => r.user_id);
    for (const uid of aliveRows) {
      const i = uid - 1;
      if (round === 1 && uid === 25) continue; // trader25 never pushes
      const r = await post('/api/tournament/' + CODE + '/snapshot', users[i].token, {
        equitySol: equityFor(i, round),
        cashSol: 5,
        positions: [{ mint: 'MINT' + i, symbol: 'TK' + i, qty: 100, valueSol: equityFor(i, round) - 5 }],
        pnlSol: 9999, // must be ignored — server derives
      });
      if (!r.body.ok) check('snapshot trader' + uid + ' r' + round, false, JSON.stringify(r.body));
    }
    // A pushed snapshot's PnL is derived, not the client's 9999.
    board = (await get('/api/tournament/' + CODE + '/board')).body;
    const t1 = board.standings.find((r) => r.handle === 'trader1');
    check('client-supplied pnl ignored, derived instead',
      Math.abs(t1.pnlSol - (equityFor(0, round) - 10)) < 1e-9, String(t1.pnlSol));

    // Advance past the boundary and tick.
    db.prepare('UPDATE tournaments SET start_ts = ? WHERE code = ?')
      .run(Date.now() - round * 24 * 3600000 - 1000, CODE);
    await tick();

    board = (await get('/api/tournament/' + CODE + '/board')).body;
    const alive = board.standings.filter((r) => r.alive).length;
    if (round <= 4 && expectedAlive[round] !== undefined) {
      check('round ' + round + ' cut leaves ' + expectedAlive[round], alive === expectedAlive[round],
        'alive=' + alive);
    }
    const elims = board.eliminations.filter((e) => e.roundNo === round);
    if (round <= 3) {
      check('round ' + round + ' eliminated exactly 5', elims.length === 5, String(elims.length));
      const cutHandles = elims.map((e) => e.handle).sort();
      const expectHandles = [25, 24, 23, 22, 21].map((n) => 'trader' + (n - (round - 1) * 5)).sort();
      check('round ' + round + ' cut the bottom five', JSON.stringify(cutHandles) === JSON.stringify(expectHandles),
        cutHandles.join(',') + ' vs ' + expectHandles.join(','));
    }
    // Idempotence: a second tick must not re-cut.
    await tick();
    const again = (await get('/api/tournament/' + CODE + '/board')).body;
    check('round ' + round + ' settlement is idempotent',
      again.eliminations.filter((e) => e.roundNo === round).length === elims.length &&
      again.standings.filter((r) => r.alive).length === alive);
  }

  /* ---- final ---- */
  console.log('\n== final ==');
  // 5 alive: trader1..trader5. Push final-round equities, cross the boundary.
  for (let uid = 1; uid <= 5; uid++) {
    await post('/api/tournament/' + CODE + '/snapshot', users[uid - 1].token, {
      equitySol: 10 + (6 - uid) * 2, cashSol: 10, positions: [],
    });
  }
  db.prepare('UPDATE tournaments SET start_ts = ? WHERE code = ?')
    .run(Date.now() - 5 * 24 * 3600000 - 1000, CODE);
  await tick();
  board = (await get('/api/tournament/' + CODE + '/board')).body;
  check('tournament done', board.tournament.status === 'done', board.tournament.status);
  check('winner is trader1', board.standings[0].handle === 'trader1' && board.standings[0].finalRank === 1,
    JSON.stringify(board.standings[0]));
  check('final ranks are a permutation 1..25',
    JSON.stringify(board.standings.map((r) => r.finalRank).sort((a, b) => a - b)) ===
    JSON.stringify(Array.from({ length: 25 }, (_, i) => i + 1)),
    board.standings.map((r) => r.handle + ':' + r.finalRank).join(','));
  check('prize awards 50/30/20 of 100 to top 3',
    board.final && board.final.awards.length === 3 &&
    board.final.awards[0].amountSol === 50 && board.final.awards[1].amountSol === 30 &&
    board.final.awards[2].amountSol === 20, JSON.stringify(board.final && board.final.awards));
  check('rounds ledger has 5 settled boundaries with hashes',
    board.rounds.length === 5 && board.rounds.every((r) => /^[0-9a-f]{64}$/.test(r.standingsHash)),
    String(board.rounds.length));

  // Eliminated trader's snapshot push is refused.
  const deadPush = await post('/api/tournament/' + CODE + '/snapshot', users[24].token, { equitySol: 50 });
  check('eliminated/done push refused', deadPush.status === 409, JSON.stringify(deadPush.body));

  // Trader live view.
  const trader = await get('/api/tournament/' + CODE + '/trader?handle=trader2');
  check('trader view returns rank + positions', trader.status === 200 && trader.body.trader.handle === 'trader2' && trader.body.rank === 2,
    JSON.stringify({ status: trader.status, rank: trader.body.rank }));

  // Directory lists it as done.
  const dir = await get('/api/tournaments');
  check('directory lists the finished tournament', dir.status === 200 &&
    dir.body.tournaments.some((t) => t.code === CODE && t.status === 'done'));

  /* ---- second bracket: start-when-full, leave, cancel, mine ---- */
  console.log('\n== start-when-full / leave / cancel ==');
  const c2 = await post('/api/tournament/create', users[0].token, {
    name: 'Fill-Up Bracket', fieldSize: 4, startStackSol: 10,
    roundHours: 24, cutPerRound: 1, // no startTs → starts when full
  });
  check('second create ok', c2.status === 200 && c2.body.ok, JSON.stringify(c2.body));
  const CODE2 = c2.body.code;

  // mine lists the creator's seat before anyone else joins.
  const mine = await get('/api/tournament/mine', users[0].token);
  check('/mine lists both seats for creator', mine.status === 200 &&
    mine.body.tournaments.some((t) => t.code === CODE) &&
    mine.body.tournaments.some((t) => t.code === CODE2), JSON.stringify(mine.body));

  // A non-creator can leave an open bracket; the seat is freed.
  await post('/api/tournament/' + CODE2 + '/join', users[1].token);
  const leave = await post('/api/tournament/' + CODE2 + '/leave', users[1].token);
  check('leave an open bracket works', leave.status === 200 && leave.body.ok, JSON.stringify(leave.body));
  let b2 = (await get('/api/tournament/' + CODE2 + '/board')).body;
  check('seat freed after leave', b2.tournament.entrantCount === 1, String(b2.tournament.entrantCount));

  // Fill it: creator + 3 more = 4 seats → starts the moment the last lands.
  await post('/api/tournament/' + CODE2 + '/join', users[1].token);
  await post('/api/tournament/' + CODE2 + '/join', users[2].token);
  const last = await post('/api/tournament/' + CODE2 + '/join', users[3].token);
  check('last join reports started', last.body.ok && last.body.started === true, JSON.stringify(last.body));
  b2 = (await get('/api/tournament/' + CODE2 + '/board')).body;
  check('start-when-full went live on the fill', b2.tournament.status === 'live' && b2.tournament.currentRound === 1,
    b2.tournament.status);
  const leaveLive = await post('/api/tournament/' + CODE2 + '/leave', users[1].token);
  check('leaving a live bracket refused', leaveLive.status === 409, JSON.stringify(leaveLive.body));

  // Third bracket: creator cancels while open.
  const c3 = await post('/api/tournament/create', users[4].token, {
    name: 'Cancelled Bracket', fieldSize: 8, startStackSol: 10, roundHours: 24, cutPerRound: 2,
  });
  const CODE3 = c3.body.code;
  const notCreator = await post('/api/tournament/' + CODE3 + '/cancel', users[5].token);
  check('non-creator cannot cancel', notCreator.status === 403, JSON.stringify(notCreator.body));
  const cancel = await post('/api/tournament/' + CODE3 + '/cancel', users[4].token);
  check('creator cancels an open bracket', cancel.status === 200 && cancel.body.ok, JSON.stringify(cancel.body));
  const joinCancelled = await post('/api/tournament/' + CODE3 + '/join', users[6].token);
  check('joining a cancelled bracket refused', joinCancelled.status === 409, JSON.stringify(joinCancelled.body));

  /* ---- negative control: prove the sim can fail ---- */
  console.log('\n== negative control ==');
  db.prepare(`UPDATE tournament_entrants SET final_rank = 99 WHERE user_id = 2`).run();
  const broken = (await get('/api/tournament/' + CODE + '/board')).body;
  const isBroken = JSON.stringify(broken.standings.map((r) => r.finalRank).sort((a, b) => a - b)) !==
    JSON.stringify(Array.from({ length: 25 }, (_, i) => i + 1));
  check('sim detects a corrupted final_rank', isBroken);
  db.prepare(`UPDATE tournament_entrants SET final_rank = 2 WHERE user_id = 2`).run();

  console.log('\n' + (failures ? failures + ' FAILURES' : 'ALL GREEN'));
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('SIM CRASH:', e); process.exit(2); });
