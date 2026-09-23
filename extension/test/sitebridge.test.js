/* site-bridge.js — the papertrench.com page relay.
 *
 * The relay is a trust boundary: page messages are untrusted input even on
 * our own site (any script the page runs can postMessage), so what these
 * tests pin is mostly refusals — wrong origin, wrong window, malformed
 * handle/token, and above all the CLOSED op set: only manual bridge requests
 * and the explicit tournament-sync grant/revoke can cross from page context.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const ORIGIN = 'https://papertrench.com';

function loadRelay() {
  const messageListeners = [];
  const sent = [];      // chrome.runtime.sendMessage payloads
  const posted = [];    // window.postMessage frames
  const windowObj = {
    addEventListener: (type, fn) => { if (type === 'message') messageListeners.push(fn); },
    postMessage: (data, targetOrigin) => { posted.push({ data, targetOrigin }); },
  };
  const document = { documentElement: { dataset: {} } };
  const sandbox = {
    console, JSON, Object, String, Array, Promise, RegExp, document,
    location: { origin: ORIGIN },
    window: windowObj,
    chrome: {
      runtime: {
        sendMessage: (message) => {
          sent.push(message);
          return Promise.resolve({ ok: true, answered: message.type });
        },
      },
    },
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'site-bridge.js'), 'utf8'), context,
    { filename: 'site-bridge.js' });
  return {
    sent,
    posted,
    windowObj,
    document,
    // Deliver a message event the way the page would produce it. Source
    // defaults to the relay's own window (the only source it may trust).
    deliver(data, over) {
      const event = Object.assign({ source: windowObj, origin: ORIGIN, data }, over || {});
      for (const fn of messageListeners) fn(event);
    },
    // The bridge reply path resolves through a promise chain; one macrotask
    // is enough for it to land.
    tick: () => new Promise((resolve) => setImmediate(resolve)),
  };
}

test('the relay announces itself so the page can tell "absent" from "slow"', () => {
  const relay = loadRelay();
  assert.deepEqual(JSON.parse(JSON.stringify(relay.posted[0])), {
    data: { type: 'pt_site_bridge_ready' },
    targetOrigin: ORIGIN,
  });
  assert.equal(relay.document.documentElement.dataset.ptSiteBridge, 'ready',
    'the page can distinguish an installed relay from a missing extension');
});

test('a signed-in identity is forwarded to the background', () => {
  const relay = loadRelay();
  relay.deliver({ type: 'pt_site_identity', handle: 'amogus0471' });
  assert.deepEqual(JSON.parse(JSON.stringify(relay.sent)), [{ type: 'pt_site_identity', handle: 'amogus0471' }]);
});

test('wrong origin, foreign window, and malformed handles are all dropped silently', () => {
  const relay = loadRelay();
  relay.deliver({ type: 'pt_site_identity', handle: 'legit' }, { origin: 'https://evil.example' });
  relay.deliver({ type: 'pt_site_identity', handle: 'legit' }, { source: {} });
  relay.deliver({ type: 'pt_site_identity', handle: 'has spaces' });
  relay.deliver({ type: 'pt_site_identity', handle: 'x'.repeat(16) });
  relay.deliver({ type: 'pt_site_identity', handle: 42 });
  relay.deliver({ type: 'pt_site_identity' });
  assert.deepEqual(JSON.parse(JSON.stringify(relay.sent)), [], 'nothing observed may reach the background');
});

test('bridge requests round-trip with the caller\'s nonce', async () => {
  const relay = loadRelay();
  relay.deliver({ type: 'pt_site_bridge', nonce: 'n-123', request: { type: 'pt_bridge_ping' } });
  await relay.tick();
  assert.deepEqual(JSON.parse(JSON.stringify(relay.sent)), [{ type: 'pt_bridge_ping', viaSiteRelay: true }]);
  const reply = relay.posted.find((p) => p.data && p.data.type === 'pt_site_bridge_reply');
  assert.ok(reply, 'a reply frame must be posted back to the page');
  assert.equal(reply.data.nonce, 'n-123', 'the reply must carry the request nonce');
  assert.equal(reply.data.reply.answered, 'pt_bridge_ping');
  assert.equal(reply.targetOrigin, ORIGIN, 'replies are origin-locked, never *');
});

test('the site relay accepts a well-shaped sync grant and a revoke, but does not echo the token', async () => {
  const relay = loadRelay();
  const token = 'ptsync_' + 'ab'.repeat(32);
  relay.deliver({ type: 'pt_site_bridge', nonce: 'grant-1',
    request: { type: 'pt_tournament_sync_grant', token } });
  relay.deliver({ type: 'pt_site_bridge', nonce: 'revoke-1',
    request: { type: 'pt_tournament_sync_revoke' } });
  await relay.tick();
  assert.deepEqual(JSON.parse(JSON.stringify(relay.sent)), [
    { type: 'pt_tournament_sync_grant', viaSiteRelay: true, token },
    { type: 'pt_tournament_sync_revoke', viaSiteRelay: true },
  ]);
  const replies = relay.posted.filter((item) => item.data && item.data.type === 'pt_site_bridge_reply');
  assert.equal(replies.length, 2);
  assert.ok(replies.every((item) => !JSON.stringify(item).includes(token)),
    'the plaintext token is not copied into the page reply');
});

test('the site relay refuses malformed tokens and messages from other origins', async () => {
  const relay = loadRelay();
  relay.deliver({ type: 'pt_site_bridge', nonce: 'bad-token',
    request: { type: 'pt_tournament_sync_grant', token: 'not-a-sync-token' } });
  relay.deliver({ type: 'pt_site_bridge', nonce: 'foreign',
    request: { type: 'pt_tournament_sync_revoke' } }, { origin: 'https://evil.example' });
  await relay.tick();
  assert.deepEqual(JSON.parse(JSON.stringify(relay.sent)), []);
});

test('the op set is CLOSED — no other background message type can be smuggled through', async () => {
  const relay = loadRelay();
  for (const op of ['pt_attest_append', 'pt_site_identity', 'pt_resolve', 'pt_state', '']) {
    relay.deliver({ type: 'pt_site_bridge', nonce: 'n-evil', request: { type: op } });
  }
  relay.deliver({ type: 'pt_site_bridge', request: { type: 'pt_bridge_ping' } }); // no nonce
  await relay.tick();
  assert.deepEqual(JSON.parse(JSON.stringify(relay.sent)), [],
    'only ping, record, grant, and revoke can relay');
});
