/* POST /api/streamer/add — the moderator's direct door onto the roster.
 *
 * The owner used to add a streamer by filing a GitHub issue against this very
 * repo and waiting for someone to translate it into an INSERT. These tests
 * pin the endpoint that replaces that round trip: mod-gated like every other
 * write on the queue page, landing rows APPROVED and attributed, refused when
 * the channel is already spoken for, and held to the same content rules the
 * public form faces — because an approved row is a public card either way.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { HATE_CODE } = require('../core/clan.js');

const ORIGIN = 'https://papertrench.com';
const SECRET = 'test-secret';
const MOD = { id: 7, x_id: 'mod-x-id-900', handle: 'terp', session_epoch: 1, banned_at: null };

/** A scripted D1: `route(sql, args)` decides every answer. */
function fakeDB(route) {
  const log = [];
  const statement = (sql) => {
    let bound = [];
    const stmt = {
      sql,
      get args() { return bound; },
      bind(...args) { bound = args; return stmt; },
      async first() { log.push({ sql, args: bound, via: 'first' }); return route(sql, bound) || null; },
      async all() { log.push({ sql, args: bound, via: 'all' }); const rows = route(sql, bound); return { results: Array.isArray(rows) ? rows : [] }; },
      async run() { log.push({ sql, args: bound, via: 'run' }); const out = route(sql, bound); return out && out.meta ? out : { meta: { changes: 1 } }; },
    };
    return stmt;
  };
  return { log, prepare: statement, batch: async () => [] };
}

function makeEnv(db) {
  // ADMIN_X_IDS carries the fixture moderator's x_id — this is the whole gate.
  return { DB: db, SESSION_SECRET: SECRET, SITE_ORIGIN: ORIGIN, ADMIN_X_IDS: MOD.x_id };
}

async function loadWorker() {
  globalThis.caches = globalThis.caches || {
    default: { match: async () => undefined, put: async () => {} },
  };
  return (await import('../worker/index.js')).default;
}

/** A session token signed exactly the way auth.js signs them. */
async function sessionToken(uid) {
  const enc = (s) => new TextEncoder().encode(s);
  const b64 = (bytes) => Buffer.from(bytes).toString('base64url');
  const body = b64(enc(JSON.stringify({ uid, epoch: 1, exp: Date.now() + 3600000 })));
  const key = await crypto.subtle.importKey(
    'raw', enc(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = b64(await crypto.subtle.sign('HMAC', key, enc(body)));
  return body + '.' + sig;
}

/** The users row lookup every session check performs. */
const usersRoute = (sql) => {
  if (sql.includes('FROM users WHERE id = ?')) {
    return { id: MOD.id, x_id: MOD.x_id, handle: MOD.handle, display_name: 'Terp', avatar_url: null, session_epoch: 1, banned_at: null };
  }
  return null;
};

async function postAdd(worker, env, payload, { auth = true } = {}) {
  const headers = { Origin: ORIGIN, 'Content-Type': 'application/json' };
  if (auth) headers.Authorization = 'Bearer ' + await sessionToken(MOD.id);
  const res = await worker.fetch(new Request('https://api.test/api/streamer/add', {
    method: 'POST', headers, body: JSON.stringify(payload),
  }), env, { waitUntil: () => {} });
  return { status: res.status, body: await res.json() };
}

const VALID = Object.freeze({
  name: 'Ark1317',
  channelUrl: 'https://kick.com/ark1317',
  blurb: 'Fresh eyes on the trenches.',
});

test('the door is locked: no session, no add', async () => {
  const worker = await loadWorker();
  const db = fakeDB(usersRoute);
  const { status, body } = await postAdd(worker, makeEnv(db), VALID, { auth: false });
  assert.equal(status, 403);
  assert.equal(body.reason, 'not-a-moderator');
  assert.equal(db.log.filter((l) => l.sql.includes('INSERT INTO streamer_applications')).length, 0,
    'a refused caller must not have written a row');
});

test('a signed-in non-moderator is refused too', async () => {
  const worker = await loadWorker();
  // The session resolves to a real user whose x_id is NOT on the allowlist.
  const db = fakeDB(() => null);
  const env = makeEnv(db);
  env.ADMIN_X_IDS = 'someone-else';
  const { status } = await postAdd(worker, env, VALID);
  assert.equal(status, 403);
});

test('a direct add lands APPROVED, attributed, and platform-derived', async () => {
  const worker = await loadWorker();
  const db = fakeDB(usersRoute);
  const { status, body } = await postAdd(worker, makeEnv(db), VALID);
  assert.equal(status, 200);
  assert.equal(body.ok, true);

  const insert = db.log.find((l) => l.sql.includes('INSERT INTO streamer_applications'));
  assert.ok(insert, 'the handler must insert, not update its way in');
  assert.ok(insert.sql.includes("'approved'"), 'the row lands approved — that is the point of the door');
  // Bind order: name, channelUrl, platform, twitchLogin, blurb, reviewed_by, reviewed_at, created_at.
  assert.equal(insert.args[0], 'Ark1317');
  assert.equal(insert.args[1], 'https://kick.com/ark1317');
  assert.equal(insert.args[2], 'kick', 'the platform is read from the URL, never chosen by the caller');
  assert.equal(insert.args[3], null, 'a Kick channel gets no invented Twitch login');
  assert.equal(insert.args[5], MOD.id, 'the add is attributed to the moderator who made it');
  assert.equal(insert.args[6], insert.args[7], 'reviewed_at and created_at are the same moment');
});

test('a Twitch add extracts the embeddable login', async () => {
  const worker = await loadWorker();
  const db = fakeDB(usersRoute);
  await postAdd(worker, makeEnv(db), { name: 'Zurp52', channelUrl: 'twitch.tv/zurp52' });
  const insert = db.log.find((l) => l.sql.includes('INSERT INTO streamer_applications'));
  assert.equal(insert.args[2], 'twitch');
  assert.equal(insert.args[3], 'zurp52', 'the login is what the streams page embeds by');
});

test('a channel already pending or approved is a 409, not a double row', async () => {
  const worker = await loadWorker();
  // The partial unique index on channel_url rejects the INSERT — the index is
  // what decides, so the fake reproduces exactly that and nothing else.
  const db = fakeDB((sql) => {
    if (sql.includes('INSERT INTO streamer_applications')) {
      throw new Error('UNIQUE constraint failed: index idx_streamer_applications_open_channel');
    }
    return usersRoute(sql);
  });
  const { status, body } = await postAdd(worker, makeEnv(db), VALID);
  assert.equal(status, 409);
  assert.equal(body.reason, 'already-listed');
});

test('the public card rules hold for moderators too', async () => {
  const worker = await loadWorker();
  const db = fakeDB(usersRoute);
  const env = makeEnv(db);
  for (const [payload, reason] of [
    [{ channelUrl: 'https://kick.com/x' }, 'name-required'],
    [{ name: 'x', channelUrl: 'https://kick.com/x' }, 'name-required'],
    [{ name: `Stream ${HATE_CODE}`, channelUrl: 'https://kick.com/x' }, 'name-blocked'],
    [{ name: 'Ok Name', channelUrl: 'javascript:alert(1)' }, 'channel-url-invalid'],
    [{ name: 'Ok Name', channelUrl: 'https://kick.com/x', blurb: `gm ${HATE_CODE}` }, 'blurb-blocked'],
  ]) {
    const { status, body } = await postAdd(worker, env, payload);
    assert.equal(status, 422, JSON.stringify(payload));
    assert.equal(body.reason, reason, JSON.stringify(payload));
  }
  assert.equal(db.log.filter((l) => l.sql.includes('INSERT INTO streamer_applications')).length, 0,
    'none of the refused payloads may have written a row');
});
