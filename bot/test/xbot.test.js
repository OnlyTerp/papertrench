/* PaperTrench onboarding bot — test suite.
 *
 * Run with:  cd bot && node --test
 * scripts/preflight.sh runs this suite as a release gate alongside the
 * extension and server suites.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { processMentions, buildReply, makeEmptyState } = require('../xbot.js');
const { BOT_HANDLE, SITES_LINE, SHORT_TEMPLATE, LONG_TEMPLATE } = require('../template.js');

function mention(over) {
  return Object.assign({
    id: 't' + (over && over.id ? over.id : Math.random().toString(36).slice(2)),
    author_id: 'u-other',
    conversation_id: 'c' + (over && over.conversation_id ? over.conversation_id : Math.random().toString(36).slice(2)),
    created_at: new Date().toISOString(),
    text: '@PaperTrenchBot',
  }, over || {});
}

function makeTransport(throwOnSend) {
  const t = { sent: [], log: () => {} };
  t.send = async (payload, m) => {
    if (throwOnSend) throw new Error('transport.send should not be called');
    t.sent.push({ payload, mention: m });
  };
  return t;
}

const now = new Date().toISOString();

/* ---------------- dedupe ---------------- */

test('does not reply twice to the same tweet id', async () => {
  const m = mention({ id: '100', conversation_id: '900' });
  const state = makeEmptyState();
  const cfg = { BACKFILL: true, DRY_RUN: true };
  const t = makeTransport(true);

  const r1 = await processMentions([m], state, cfg, t);
  assert.equal(r1.sent, 0);

  const r2 = await processMentions([m], r1.state, cfg, t);
  assert.equal(r2.skipped, 1);
  assert.equal(t.sent.length, 0);
});

test('does not reply to a mention whose conversation_id was already answered (reply-loop guard)', async () => {
  const original = mention({ id: '100', conversation_id: 'c900' });
  const replyToBot = mention({ id: '101', conversation_id: 'c900' });
  const state = makeEmptyState();
  const cfg = { BACKFILL: true, DRY_RUN: true };
  const t = makeTransport(true);

  const r1 = await processMentions([original], state, cfg, t);
  assert.equal(r1.state.replied['100'], true);

  const r2 = await processMentions([replyToBot], r1.state, cfg, t);
  assert.equal(r2.skipped, 1);
  assert.equal(t.sent.length, 0);
});

/* ---------------- state restart ---------------- */

test('state survives a simulated restart (no double reply)', async () => {
  const m = mention({ id: '200', conversation_id: 'c200' });
  const state = makeEmptyState();
  const cfg = { BACKFILL: true, DRY_RUN: true };
  const t1 = makeTransport(true);

  const r1 = await processMentions([m], state, cfg, t1);

  /* Simulate: process exits, state is written and reloaded. */
  const reloaded = JSON.parse(JSON.stringify(r1.state));
  const t2 = makeTransport(true);
  const r2 = await processMentions([m], reloaded, cfg, t2);

  assert.equal(r2.skipped, 1);
  assert.equal(t2.sent.length, 0);
});

/* ---------------- first-run backfill guard ---------------- */

test('first-run guard: fresh state + 5 existing mentions => zero replies', async () => {
  const mentions = [
    mention({ id: '301', conversation_id: 'c300' }),
    mention({ id: '302', conversation_id: 'c301' }),
    mention({ id: '303', conversation_id: 'c302' }),
    mention({ id: '304', conversation_id: 'c303' }),
    mention({ id: '305', conversation_id: 'c304' }),
  ];
  const t = makeTransport(true);
  const r = await processMentions(mentions, makeEmptyState(), { DRY_RUN: true }, t);
  assert.equal(r.sent, 0);
  assert.equal(r.skipped, 5);
  assert.ok(r.state.since_id);
});

/* ---------------- hourly cap + stale drop ---------------- */

test('hourly cap lets oldest mentions through and drops the rest', async () => {
  const cfg = { BACKFILL: true, DRY_RUN: false, MAX_REPLIES_PER_HOUR: 2 };
  const t = makeTransport(false);
  const mentions = [
    mention({ id: '401', conversation_id: 'c400' }),
    mention({ id: '402', conversation_id: 'c401' }),
    mention({ id: '403', conversation_id: 'c402' }),
  ];
  const r = await processMentions(mentions, makeEmptyState(), cfg, t);
  assert.equal(r.sent, 2);
  assert.equal(r.skipped, 1);
  assert.equal(t.sent.length, 2);
});

test('stale mentions are skipped', async () => {
  const t = makeTransport(true);
  const old = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  const mentions = [mention({ id: '500', conversation_id: 'c500', created_at: old })];
  const r = await processMentions(mentions, makeEmptyState(), { BACKFILL: true, DRY_RUN: true }, t);
  assert.equal(r.skipped, 1);
  assert.equal(t.sent.length, 0);
});

/* ---------------- DRY_RUN and KILL_SWITCH ---------------- */

test('DRY_RUN never calls transport.send', async () => {
  const t = makeTransport(true);
  const m = mention({ id: '600', conversation_id: 'c600' });
  const r = await processMentions([m], makeEmptyState(), { BACKFILL: true, DRY_RUN: true }, t);
  assert.equal(r.sent, 0);
  assert.equal(t.sent.length, 0);
});

test('KILL_SWITCH never calls transport.send', async () => {
  const t = makeTransport(true);
  const m = mention({ id: '601', conversation_id: 'c601' });
  const r = await processMentions([m], makeEmptyState(), { BACKFILL: true, DRY_RUN: false, KILL_SWITCH: true }, t);
  assert.equal(r.sent, 0);
  assert.equal(t.sent.length, 0);
});

/* ---------------- no reply to own tweets ---------------- */

test('never replies to the bot itself', async () => {
  const t = makeTransport(true);
  const m = mention({ id: '700', conversation_id: 'c700', author_id: 'u-bot' });
  const state = { since_id: '0', replied: {} };
  const r = await processMentions([m], state, { DRY_RUN: false, BOT_SELF_ID: 'u-bot' }, t);
  assert.equal(r.skipped, 1);
  assert.equal(t.sent.length, 0);
});

/* ---------------- template length / URL ---------------- */

/* X auto-links EVERY bare domain with a valid TLD (.fun, .family, … — not
 * just .com), and each counts as a 23-char t.co URL. Counting only the CTA
 * once hid a real rejection: "Pump.fun" in the sites line pushed the post to
 * 295 effective chars, so the API would have refused every free-tier reply. */
const AUTOLINK_RE = /\b[A-Za-z0-9-]+\.(?:com|net|org|io|fun|family|xyz|app|dev|gg|so)\b/g;

test('SHORT_TEMPLATE fits free-tier with every autolinkable domain counted as 23 chars', () => {
  const urls = SHORT_TEMPLATE.match(AUTOLINK_RE) || [];
  assert.deepEqual(urls, ['papertrench.com'],
    'short template must contain exactly one autolinkable domain: the CTA');
  const effective = [...SHORT_TEMPLATE].length
    - urls.reduce((sum, u) => sum + u.length, 0)
    + 23 * urls.length;
  assert.ok(effective <= 280, 'short template too long for free tier: ' + effective);
});

/* ---------------- copy lock: sites exist in extension/sites.js ---------------- */

test('every site named in SITES_LINE has an adapter in extension/sites.js', () => {
  const fs = require('fs');
  const path = require('path');
  const sitesSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'extension', 'sites.js'), 'utf8');
  const names = SITES_LINE.split(', ').map((s) => s.trim());
  for (const name of names) {
    /* Prefix match: the copy may shorten a display name ("BullX" for
     * "BullX NEO", "Padre" for "Padre / Terminal") but must never name a
     * site that has no adapter at all. */
    const re = new RegExp('name:\\s*\'' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^\']*\'');
    assert.ok(re.test(sitesSrc), 'site name not found in sites.js: ' + name);
  }
});

/* ---------------- docs/ONBOARDING-BOT.md contains exact template strings ---------------- */

test('docs/ONBOARDING-BOT.md contains the exact SHORT_TEMPLATE and LONG_TEMPLATE', () => {
  const fs = require('fs');
  const path = require('path');
  const doc = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'ONBOARDING-BOT.md'), 'utf8');
  assert.ok(doc.includes(SHORT_TEMPLATE),
    'docs must contain the exact SHORT_TEMPLATE text — a placeholder is not a copy anyone can paste');
  assert.ok(doc.includes(LONG_TEMPLATE),
    'docs must contain the exact LONG_TEMPLATE text');
});
