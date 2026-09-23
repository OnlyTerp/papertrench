/* Drive tournament cuts through the real Worker and a local SQLite D1 shim. */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { appendFill, GENESIS } = require('../core/chain.js');
const { recordStats } = require('../core/ranking.js');
const { windowEntry } = require('../core/window.js');
const tournament = require('../core/tournament.js');

const SECRET = 'sim-secret';
const ORIGIN = 'https://papertrench.com';
const MIN = 60000;
const HOUR = 60 * MIN;
const STARTING_SOL = 10;

function d1(db) {
  const prepare = (sql) => {
    let bound = [];
    const stmt = {
      sql,
      bind(...args) { bound = args; return stmt; },
      async run() {
        const result = db.prepare(sql).run(...bound);
        return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
      },
      async first() { return db.prepare(sql).get(...bound) || null; },
      async all() { return { results: db.prepare(sql).all(...bound) }; },
    };
    return stmt;
  };
  return {
    prepare,
    async batch(statements) {
      const results = [];
      db.exec('BEGIN');
      try {
        for (const statement of statements) results.push(await statement.run());
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      return results;
    },
  };
}

function b64url(bytes) {
  let out = '';
  for (const byte of new Uint8Array(bytes)) out += String.fromCharCode(byte);
  return btoa(out).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sessionToken(uid) {
  const body = b64url(new TextEncoder().encode(JSON.stringify({
    uid, epoch: 0, exp: Date.now() + 30 * 86400000,
  })));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = b64url(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  return body + '.' + signature;
}

async function append(chain, fill) {
  const previous = chain.length ? chain[chain.length - 1].hash : GENESIS;
  const link = await appendFill(previous, fill);
  link.seq = chain.length;
  chain.push(link);
  return link;
}

function payloadFor(chain) {
  const stats = recordStats(chain, STARTING_SOL);
  return {
    version: 1,
    submittedAt: Date.now(),
    identity: { handle: 'verified-trader', verified: true },
    claim: {
      equitySol: 900000000,
      realizedPnlSol: stats.realizedPnlSol,
      rounds: stats.rounds,
      wins: stats.wins,
      losses: stats.losses,
      startingBalanceSol: STARTING_SOL,
    },
    chain,
    head: chain[chain.length - 1].hash,
    equitySol: 900000000,
  };
}

test('tournament cuts use verified submissions end to end, not client equity', async () => {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8'));
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tournament_entries'").get());
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sync_tokens'").get());
    const creatorColumn = db.prepare('PRAGMA table_info(tournaments)').all()
      .find((column) => column.name === 'creator_id');
    assert.equal(creatorColumn.notnull, 0, 'erasure can detach a creator without dropping a tournament');
    const tournamentUserFks = db.prepare('PRAGMA foreign_key_list(tournaments)').all();
    assert.ok(tournamentUserFks.some((fk) => fk.from === 'creator_id' && fk.on_delete === 'SET NULL'));
    assert.ok(tournamentUserFks.some((fk) => fk.from === 'winner_user_id' && fk.on_delete === 'SET NULL'));
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tournament_snapshots'").get(), undefined);
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
    const ctx = { pending: [], waitUntil(promise) { this.pending.push(promise); } };
    const tick = async () => {
      ctx.pending = [];
      await worker.scheduled({}, env, ctx);
      await Promise.all(ctx.pending);
    };
    const get = async (endpoint, user) => {
      const headers = user ? { Authorization: 'Bearer ' + user.token } : {};
      const response = await worker.fetch(new Request('https://api.test' + endpoint, { headers }), env, ctx);
      return { status: response.status, body: await response.json() };
    };
    const post = async (endpoint, user, body) => {
      const headers = { Origin: ORIGIN, 'Content-Type': 'application/json' };
      if (user) headers.Authorization = 'Bearer ' + user.token;
      const response = await worker.fetch(new Request('https://api.test' + endpoint, {
        method: 'POST', headers, body: JSON.stringify(body || {}),
      }), env, ctx);
      return { status: response.status, body: await response.json() };
    };

    const users = [];
    for (let id = 1; id <= 25; id++) {
      db.prepare(`INSERT INTO users
        (x_id, handle, display_name, avatar_url, session_epoch, created_at, last_login_at)
        VALUES (?, ?, ?, '', 0, ?, ?)`)
        .run('x' + id, 'trader' + id, 'Trader ' + id, now, now);
      users.push({ id, handle: 'trader' + id, token: await sessionToken(id) });
    }

    const created = await post('/api/tournament/create', users[0], {
      name: 'Verified Trench Open', fieldSize: 25, startStackSol: 10,
      roundHours: 1, cutPerRound: 5, prizePoolSol: 100,
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.ok, true);
    const code = created.body.code;
    for (let index = 1; index < users.length; index++) {
      const joined = await post('/api/tournament/' + code + '/join', users[index], {});
      assert.equal(joined.status, 200);
      assert.equal(joined.body.ok, true);
    }

    const tournamentRow = db.prepare('SELECT * FROM tournaments WHERE code = ?').get(code);
    assert.equal(tournamentRow.status, 'live');
    const tournamentId = tournamentRow.id;
    const startTs = Number(tournamentRow.start_ts);
    const chains = new Map(users.map((user) => [user.id, []]));
    const cacheCandle = db.prepare(`
      INSERT INTO candle_cache (mint, minute_ts, candles_json, fetched_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(mint, minute_ts) DO UPDATE SET
        candles_json = excluded.candles_json, fetched_at = excluded.fetched_at`);
    function putCandle(mint, ts, priceNative, missing) {
      const minute = Math.floor(ts / MIN) * MIN;
      const token = missing ? null : JSON.stringify({ low: priceNative * 100, high: priceNative * 100 });
      cacheCandle.run(mint, minute, token, now);
      cacheCandle.run('__SOL_USD__', minute, JSON.stringify({ low: 100, high: 100 }), now);
    }

    const initial = await get('/api/tournament/' + code + '/board');
    assert.equal(initial.status, 200);
    assert.equal(initial.body.standings.length, 25);
    assert.ok(initial.body.standings.every((standing) =>
      standing.pnlOnStackSol === 0 && standing.finality === 'provisional' && !standing.verified));

    const removedSnapshot = await post('/api/tournament/' + code + '/snapshot', users[0], {
      equitySol: 900000000,
    });
    assert.equal(removedSnapshot.status, 404, 'client equity has no tournament write route');

    async function appendRound(userId, roundNo) {
      const chain = chains.get(userId);
      const window = tournament.roundWindow({ start_ts: startTs, round_ms: HOUR }, roundNo);
      const equityAtStart = windowEntry(chain, STARTING_SOL, window).equityAtStart;
      const roi = (13 - userId) * 0.005;
      const cost = 2;
      const proceeds = cost + equityAtStart * roi;
      const qty = 0.1;
      const mint = 'Mint' + userId;
      const sessionId = 'session-' + userId + '-' + roundNo;
      const buyTs = window.startTs + 20 * MIN;
      const sellTs = window.startTs + 21 * MIN;
      const buyPrice = cost / qty;
      const sellPrice = proceeds / qty;
      putCandle(mint, buyTs, buyPrice, false);
      putCandle(mint, sellTs, sellPrice, userId === 24 && roundNo === 1);
      await append(chain, {
        id: 'buy-' + userId + '-' + roundNo, sessionId, mint, chain: 'solana',
        side: 'buy', qty, priceNative: buyPrice,
        solGross: cost, solNet: cost, ts: buyTs,
      });
      await append(chain, {
        id: 'sell-' + userId + '-' + roundNo, sessionId, mint, chain: 'solana',
        side: 'sell', qty, priceNative: sellPrice,
        solGross: proceeds, solNet: proceeds, ts: sellTs,
      });
    }

    async function submitChain(userId) {
      const response = await post('/api/submit', users[userId - 1], payloadFor(chains.get(userId)));
      assert.equal(response.status, 200, 'submit trader' + userId + ': ' + JSON.stringify(response.body));
      assert.equal(response.body.ok, true);
      assert.equal(response.body.status, 'pending');
      return response.body;
    }

    const expectedAlive = [20, 15, 10, 5, 5];
    for (let roundNo = 1; roundNo <= 5; roundNo++) {
      const alive = db.prepare(`SELECT user_id FROM tournament_entrants
        WHERE tournament_id = ? AND alive = 1 ORDER BY user_id`).all(tournamentId)
        .map((row) => Number(row.user_id));
      assert.equal(alive.length, roundNo === 1 ? 25 : expectedAlive[roundNo - 2]);
      const window = tournament.roundWindow({ start_ts: startTs, round_ms: HOUR }, roundNo);
      now = Math.max(now, window.startTs + 22 * MIN);

      const previousLengths = new Map();
      for (const userId of alive) {
        const previous = db.prepare('SELECT chain_len FROM records WHERE user_id = ?').get(userId);
        previousLengths.set(userId, previous ? Number(previous.chain_len) : 0);
        await appendRound(userId, roundNo);
      }

      if (roundNo === 2) {
        const userId = 1;
        const replacement = [];
        const ts = window.startTs + 10 * MIN;
        const mint = 'ReplacementMint';
        const qty = 0.1;
        await append(replacement, {
          id: 'replacement-buy', sessionId: 'replacement', mint, chain: 'solana',
          side: 'buy', qty, priceNative: 20, solGross: 2, solNet: 2, ts,
        });
        await append(replacement, {
          id: 'replacement-sell', sessionId: 'replacement', mint, chain: 'solana',
          side: 'sell', qty, priceNative: 20, solGross: 2, solNet: 2, ts: ts + MIN,
        });
        const rejected = await post('/api/submit', users[userId - 1], payloadFor(replacement));
        assert.equal(rejected.status, 422);
        assert.equal(rejected.body.reason, 'chain-replaced');
      }

      const preBoundary = roundNo === 1 ? new Set([21, 22, 23, 25]) : new Set();
      for (const userId of alive.filter((id) => preBoundary.has(id))) {
        now = window.endTs - MIN;
        await submitChain(userId);
      }
      for (const userId of alive.filter((id) => !preBoundary.has(id))) {
        now = window.endTs + MIN;
        await submitChain(userId);
        if (roundNo === 2 && userId === 1) {
          const record = db.prepare(`SELECT status, chain_len, pricing_progress_json
            FROM records WHERE user_id = ?`).get(userId);
          const progress = JSON.parse(record.pricing_progress_json);
          assert.equal(record.status, 'pending', 'an extended chain stays pending during suffix pricing');
          assert.equal(progress.cursor, previousLengths.get(userId));
          assert.equal(progress.verdicts.length, previousLengths.get(userId));
        }
      }

      now = window.endTs + 5 * MIN;
      await tick();
      const beforeGrace = db.prepare('SELECT COUNT(*) AS n FROM tournament_rounds WHERE tournament_id = ?')
        .get(tournamentId).n;
      assert.equal(beforeGrace, roundNo - 1, 'the boundary cannot settle before its 15-minute grace');
      for (const userId of alive) {
        const record = db.prepare('SELECT status, chain_len, pricing_progress_json FROM records WHERE user_id = ?')
          .get(userId);
        if (roundNo === 1 && userId === 24) {
          assert.equal(record.status, 'partial', 'a missing candle is not a verified final chain');
        } else {
          assert.equal(record.status, 'verified');
          const progress = JSON.parse(record.pricing_progress_json);
          assert.equal(progress.cursor, Number(record.chain_len));
          assert.equal(progress.verdicts.length, Number(record.chain_len));
        }
      }

      now = window.endTs + tournament.SETTLE_GRACE_MS;
      await tick();
      const board = (await get('/api/tournament/' + code + '/board')).body;
      assert.equal(board.rounds.length, roundNo);
      assert.match(board.rounds[roundNo - 1].standingsHash, /^[0-9a-f]{64}$/);
      if (roundNo === 1) {
        assert.equal(board.tournament.aliveCount, 20);
        assert.deepEqual(board.eliminations.filter((item) => item.roundNo === 1)
          .map((item) => Number(item.userId)).sort((a, b) => a - b), [21, 22, 23, 24, 25]);
        const frozen = JSON.parse(db.prepare(`SELECT standings_json FROM tournament_rounds
          WHERE tournament_id = ? AND round_no = 1`).get(tournamentId).standings_json);
        assert.equal(frozen.filter((item) => item.finality === 'final').length, 20);
        assert.equal(frozen.find((item) => item.userId === 25).finality, 'forfeited',
          'a verified pre-boundary submission is not final');
        assert.equal(frozen.find((item) => item.userId === 24).finality, 'forfeited',
          'a post-boundary partial record is not final');
        const winnerOfCut = board.standings.find((item) => item.handle === 'trader1');
        assert.equal(winnerOfCut.finality, 'provisional', 'the next live window starts provisional');
        assert.ok(Math.abs(winnerOfCut.pnlOnStackSol - winnerOfCut.roiPct / 100 * 10) < 1e-9);
        assert.ok(winnerOfCut.pnlOnStackSol < 10, 'the forged client equity did not enter the board');
      } else if (roundNo < 5) {
        assert.equal(board.tournament.aliveCount, expectedAlive[roundNo - 1]);
      } else {
        assert.equal(board.tournament.status, 'done');
        assert.equal(board.standings[0].handle, 'trader1');
        assert.equal(board.standings[0].finalRank, 1);
        assert.equal(board.standings[0].finality, 'final');
        assert.deepEqual(board.standings.map((standing) => standing.finalRank).sort((a, b) => a - b),
          Array.from({ length: 25 }, (_, index) => index + 1));
        assert.equal(board.final.awards.length, 3);
        assert.equal(board.final.awards[0].amountSol, 50);
        assert.equal(board.final.awards[1].amountSol, 30);
        assert.equal(board.final.awards[2].amountSol, 20);
      }

      await tick();
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tournament_rounds WHERE tournament_id = ?')
        .get(tournamentId).n, roundNo, 'a settled boundary is not cut twice');
    }

    const trader = await get('/api/tournament/' + code + '/trader?handle=trader1');
    assert.equal(trader.status, 200);
    assert.equal(trader.body.rank, 1);
    assert.equal(trader.body.trader.finality, 'final');
    const directory = await get('/api/tournaments');
    assert.ok(directory.body.tournaments.some((item) => item.code === code && item.status === 'done'));

    const second = await post('/api/tournament/create', users[0], {
      name: 'Fill-Up Bracket', fieldSize: 4, startStackSol: 10,
      roundHours: 1, cutPerRound: 1,
    });
    assert.equal(second.status, 200);
    const code2 = second.body.code;
    await post('/api/tournament/' + code2 + '/join', users[1], {});
    assert.equal((await post('/api/tournament/' + code2 + '/leave', users[1], {})).status, 200);
    const join2 = await post('/api/tournament/' + code2 + '/join', users[1], {});
    const join3 = await post('/api/tournament/' + code2 + '/join', users[2], {});
    const join4 = await post('/api/tournament/' + code2 + '/join', users[3], {});
    assert.equal(join2.body.ok && join3.body.ok && join4.body.started, true);
    assert.equal((await get('/api/tournament/' + code2)).body.tournament.status, 'live');
    assert.equal((await post('/api/tournament/' + code2 + '/leave', users[1], {})).status, 409);

    const cancelled = await post('/api/tournament/create', users[4], {
      name: 'Cancelled Bracket', fieldSize: 8, startStackSol: 10,
      roundHours: 1, cutPerRound: 2,
    });
    assert.equal(cancelled.status, 200);
    assert.equal((await post('/api/tournament/' + cancelled.body.code + '/cancel', users[4], {})).status, 200);
    assert.equal((await get('/api/tournament/' + cancelled.body.code)).body.tournament.status, 'cancelled');

    const grant = await post('/api/sync-token', users[0], {});
    assert.equal(grant.status, 200);
    assert.match(grant.body.token, /^ptsync_[0-9a-f]{64}$/);
    const tokenBeforeErase = db.prepare('SELECT token_hash FROM sync_tokens WHERE user_id = ?')
      .get(users[0].id);
    assert.equal(tokenBeforeErase.token_hash,
      Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(grant.body.token))),
        (byte) => byte.toString(16).padStart(2, '0')).join(''));
    const mineResponse = await worker.fetch(new Request('https://api.test/api/tournament/mine', {
      headers: { Authorization: 'Bearer ' + grant.body.token },
    }), env, ctx);
    assert.equal(mineResponse.status, 200, 'the cookie-free sync token reads its own seats');
    const mineBody = await mineResponse.json();
    const finishedSeat = mineBody.tournaments.find((seat) => seat.code === code);
    assert.equal(finishedSeat.status, 'done');
    assert.equal(finishedSeat.alive, true);
    assert.equal(finishedSeat.nextBoundaryTs, null);
    const liveSeat = mineBody.tournaments.find((seat) => seat.status === 'live' && seat.alive);
    assert.ok(liveSeat && liveSeat.nextBoundaryTs > 0, 'mine exposes the next boundary for a live seat');
    assert.ok(db.prepare('SELECT last_used_at FROM sync_tokens WHERE user_id = ?')
      .get(users[0].id).last_used_at);

    const frozenBeforeErase = db.prepare(`SELECT standings_json, standings_hash FROM tournament_rounds
      WHERE tournament_id = ? AND round_no = 5`).get(tournamentId);
    const frozenRows = JSON.parse(frozenBeforeErase.standings_json);
    assert.ok(frozenRows.every((item) => !Object.hasOwn(item, 'handle')
      && !Object.hasOwn(item, 'displayName') && !Object.hasOwn(item, 'avatarUrl')),
    'the hash input freezes user IDs and tournament facts, never identity fields');
    const erased = await post('/api/me/delete', users[0], {});
    assert.equal(erased.status, 200);
    assert.equal(db.prepare('SELECT id FROM users WHERE id = ?').get(users[0].id), undefined);
    const erasedTournament = db.prepare('SELECT creator_id, winner_user_id FROM tournaments WHERE id = ?').get(tournamentId);
    assert.equal(erasedTournament.creator_id, null, 'creator identity is detached without removing the bracket');
    assert.equal(erasedTournament.winner_user_id, null, 'winner identity is detached without changing final JSON');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sync_tokens WHERE user_id = ?').get(users[0].id).n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tournament_entrants WHERE user_id = ?').get(users[0].id).n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tournament_entries WHERE user_id = ?').get(users[0].id).n, 0);
    const frozenAfterErase = db.prepare(`SELECT standings_json, standings_hash FROM tournament_rounds
      WHERE tournament_id = ? AND round_no = 5`).get(tournamentId);
    assert.equal(frozenAfterErase.standings_json, frozenBeforeErase.standings_json,
      'account erasure does not rewrite frozen hashed standings');
    assert.equal(frozenAfterErase.standings_hash, frozenBeforeErase.standings_hash);
    const frozenDigest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
      new TextEncoder().encode(frozenAfterErase.standings_json))),
    (byte) => byte.toString(16).padStart(2, '0')).join('');
    assert.equal(frozenDigest, frozenAfterErase.standings_hash);
    const erasedBoard = (await get('/api/tournament/' + code + '/board')).body;
    const deletedTrader = erasedBoard.standings.find((item) => Number(item.userId) === users[0].id);
    assert.equal(deletedTrader.handle, 'deleted trader');
    assert.equal(deletedTrader.deleted, true);
    assert.equal(deletedTrader.finalRank, 1);
    assert.equal(erasedBoard.final.standings.find((item) => Number(item.userId) === users[0].id).handle,
      'deleted trader');
  } finally {
    Date.now = realNow;
    db.close();
  }
});
