/* X-Ray — the MAIN-world observer (v2.6.0).
 *
 * This is the layer that touches X's actual traffic, so it is the layer with
 * the most ways to be quietly wrong. Driven here through the real hook: a
 * stub fetch returns a realistic payload and the assertions are on what the
 * observer emits — and on what it refuses to emit.
 *
 * The load-bearing behaviours:
 *   - it reads ONLY allowlisted operations (a home-timeline response is never
 *     even parsed, let alone forwarded)
 *   - the page's response is passed through untouched — X must behave exactly
 *     as it would with the extension absent
 *   - digests carry derived facts, never post text
 *   - responses that arrive before the panel has reported the toggle are held,
 *     not dropped (X answers the profile request before an ISOLATED-world
 *     script at document_idle can possibly have spoken), and are discarded
 *     outright if the answer is "off"
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const CA = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const API = 'https://x.com/i/api/graphql/QID/';

function profilePayload() {
  return {
    data: {
      user: {
        result: {
          __typename: 'User',
          rest_id: '1450000000000000001',
          is_blue_verified: true,
          core: { created_at: 'Wed Oct 10 20:19:24 +0000 2018', name: 'Degen Labs', screen_name: 'degenlabs' },
          legacy: { description: 'trenches ' + CA, followers_count: 128_400, friends_count: 312 },
        },
      },
    },
  };
}

function tweetsPayload() {
  return {
    data: { list: [{
      rest_id: '1800000000000000001',
      legacy: {
        full_text: 'my private thoughts, ticker ' + CA,
        user_id_str: '1450000000000000001',
        created_at: 'Fri May 02 18:30:00 +0000 2025',
        entities: { urls: [] },
      },
    }] },
  };
}

function mountObserver(opts = {}) {
  const posted = [];
  const listeners = { message: [] };
  const fetched = [];

  const win = {
    location: { origin: 'https://x.com', href: 'https://x.com/degenlabs', pathname: '/degenlabs' },
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    postMessage: (data) => posted.push(data),
  };
  win.window = win;
  win.self = win;

  // The page's real fetch: records the call and answers with a payload.
  win.fetch = (url) => {
    fetched.push(String(url));
    const body = opts.bodyFor ? opts.bodyFor(String(url)) : JSON.stringify(profilePayload());
    const response = {
      ok: opts.ok !== false,
      status: opts.status || 200,
      text: async () => body,
    };
    response.clone = () => ({ text: async () => body });
    return Promise.resolve(response);
  };
  win.XMLHttpRequest = function () {};

  const sandbox = {
    window: win, self: win, location: win.location,
    document: { cookie: 'ct0=abc123; auth_token=zzz', location: { pathname: '/degenlabs' } },
    console: { debug: () => {}, warn: () => {}, error: () => {} },
    setTimeout: (fn) => 1, clearTimeout: () => {}, setInterval: () => 1, clearInterval: () => {},
    Promise, JSON, Math, Date, Number, String, Array, Object, Boolean, RegExp, Error, Set, Map,
    URL, URLSearchParams, isNaN, parseInt,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'xray-core.js'), 'utf8'), sandbox, { filename: 'xray-core.js' });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'xray-main.js'), 'utf8'), sandbox, { filename: 'xray-main.js' });

  return {
    win, posted, fetched,
    digests() { return posted.filter((m) => m && m.source === 'papertrench-xray-digest').map((m) => m.digest); },
    enable(on = true) {
      for (const fn of listeners.message) fn({ source: win, data: { source: 'papertrench-xray-state', enabled: on } });
    },
    scan(cmd) {
      for (const fn of listeners.message) fn({ source: win, data: { source: 'papertrench-xray-scan', ...cmd } });
    },
    settle() { return new Promise((resolve) => setImmediate(resolve)); },
  };
}

test('the page\'s own profile request becomes a digest, with the subject resolved', async () => {
  const obs = mountObserver();
  obs.enable(true);
  const vars = encodeURIComponent(JSON.stringify({ screen_name: 'degenlabs' }));
  await obs.win.fetch(API + 'UserByScreenName?variables=' + vars);
  await obs.settle();
  await obs.settle();

  const digests = obs.digests();
  assert.equal(digests.length, 1);
  assert.equal(digests[0].op, 'UserByScreenName');
  assert.equal(digests[0].subjectRestId, '1450000000000000001',
    'the account the request ASKED for is the subject — a payload can hold many users');
  assert.equal(digests[0].users[0].handle, 'degenlabs');
  assert.equal(digests[0].users[0].followers, 128_400);
});

test('the response the page receives is untouched — X behaves as if we were absent', async () => {
  const obs = mountObserver();
  obs.enable(true);
  const response = await obs.win.fetch(API + 'UserByScreenName?variables=%7B%7D');
  assert.equal(response.ok, true);
  const body = await response.text();
  assert.deepEqual(JSON.parse(body), profilePayload(),
    'the observer reads a CLONE; the page still gets its whole body');
});

test('nothing outside the allowlist is read at all', async () => {
  const obs = mountObserver({ bodyFor: () => JSON.stringify(tweetsPayload()) });
  obs.enable(true);
  for (const url of [
    API + 'HomeTimeline?variables=%7B%7D',
    API + 'DMInbox',
    'https://x.com/i/api/1.1/jot/client_event.json',
    'https://api.segment.io/v1/track',
  ]) {
    await obs.win.fetch(url);
  }
  await obs.settle();
  await obs.settle();
  assert.equal(obs.digests().length, 0, 'the rest of the user\'s life on X is not read');
});

test('a digest carries derived facts, never the text of the post', async () => {
  const obs = mountObserver({ bodyFor: () => JSON.stringify(tweetsPayload()) });
  obs.enable(true);
  await obs.win.fetch(API + 'UserTweets?variables=%7B%7D');
  await obs.settle();
  await obs.settle();

  const [digest] = obs.digests();
  assert.ok(digest, 'an allowlisted op does produce a digest');
  const wire = JSON.stringify(digest);
  assert.ok(!wire.includes('private thoughts'), 'post text must never leave the page world');
  assert.ok(wire.includes(CA), 'the derived fact — the contract address — is what travels');
  assert.equal(digest.tweets[0].createdAt, Date.parse('Fri May 02 18:30:00 +0000 2025'));
});

test('responses that land before the panel has spoken are held, not lost', async () => {
  // X answers the profile request within milliseconds; the ISOLATED-world
  // panel cannot report the toggle until document_idle. Dropping what arrives
  // in between would make the FIRST profile of every session blind.
  const obs = mountObserver();
  await obs.win.fetch(API + 'UserByScreenName?variables=%7B%7D');
  await obs.settle();
  await obs.settle();
  assert.equal(obs.digests().length, 0, 'nothing is emitted before the toggle is known');

  obs.enable(true);
  assert.equal(obs.digests().length, 1, 'and the held digest is released once it is');
});

test('when the toggle is off the queue is discarded and nothing more is read', async () => {
  const obs = mountObserver();
  await obs.win.fetch(API + 'UserByScreenName?variables=%7B%7D');
  await obs.settle();
  obs.enable(false);
  assert.equal(obs.digests().length, 0, 'the queue is dropped, not flushed');

  await obs.win.fetch(API + 'UserTweets?variables=%7B%7D');
  await obs.settle();
  await obs.settle();
  assert.equal(obs.digests().length, 0, 'and later responses are not parsed either');
});

test('a deep scan replays the page\'s own request shape, and only its own origin', async () => {
  const obs = mountObserver({
    bodyFor: (url) => JSON.stringify(url.includes('UserTweets') ? tweetsPayload() : profilePayload()),
  });
  obs.enable(true);

  // The page fires UserTweets itself: that is what teaches the shape.
  await obs.win.fetch(API + 'UserTweets?variables=%7B%22userId%22%3A%221%22%7D', {
    headers: { authorization: 'Bearer AAAA', 'x-twitter-auth-type': 'OAuth2Session' },
  });
  await obs.settle();
  await obs.settle();
  const learned = obs.digests().find((d) => d.opShape);
  assert.ok(learned, 'the replayable shape is announced once so the ledger can keep it');
  assert.equal(learned.opShape.headers.authorization, 'Bearer AAAA');

  const before = obs.fetched.length;
  obs.scan({ requestId: 'req-1', op: 'UserTweets', userId: '1450000000000000001', cursor: 'CURSOR-1' });
  await obs.settle();
  await obs.settle();

  const replay = obs.fetched[before];
  assert.ok(replay, 'the scan issues exactly one request');
  assert.equal(obs.fetched.length, before + 1);
  assert.ok(replay.startsWith('https://x.com/i/api/graphql/'), 'same origin, X\'s own API');
  const vars = JSON.parse(new URL(replay).searchParams.get('variables'));
  assert.equal(vars.userId, '1450000000000000001', 'retargeted at the account being viewed');
  assert.equal(vars.cursor, 'CURSOR-1', 'paging further back');

  const result = obs.digests().find((d) => d.scan && d.scan.requestId === 'req-1');
  assert.ok(result, 'the scan reports its outcome so the budget can be settled');
  assert.equal(result.scan.status, 200);
});

test('a scan for an op with no learned shape spends no request and says so', async () => {
  const obs = mountObserver();
  obs.enable(true);
  const before = obs.fetched.length;
  obs.scan({ requestId: 'req-2', op: 'FollowersYouKnow', userId: '1450000000000000001' });
  await obs.settle();
  assert.equal(obs.fetched.length, before, 'no shape means no request — never a guessed URL');
  const result = obs.digests().find((d) => d.scan && d.scan.requestId === 'req-2');
  assert.equal(result.scan.status, 'no_shape');
});

test('a scan command is ignored unless the feature is on and the op is replayable', async () => {
  const off = mountObserver();
  off.enable(false);
  off.scan({ requestId: 'r', op: 'UserTweets', userId: '1' });
  await off.settle();
  assert.equal(off.fetched.length, 0);

  const on = mountObserver();
  on.enable(true);
  // TweetDetail is observed but never replayed; a forged command naming it
  // (or naming no account at all) must do nothing.
  on.scan({ requestId: 'r', op: 'TweetDetail', userId: '1450000000000000001' });
  on.scan({ requestId: 'r2', op: 'UserTweets', userId: 'not-an-id' });
  await on.settle();
  assert.equal(on.fetched.length, 0);
});
