/* PaperTrench onboarding bot — wiring / X API transport.
 *
 * This file is the only one that touches the network and filesystem. It is
 * intentionally separate from xbot.js so the core logic can be tested without
 * any real X credentials or network calls.
 *
 * Environment:
 *   X_BEARER_TOKEN      — bearer token for GET /2/users/:id/mentions
 *   X_API_KEY           — OAuth 2.0 app-only or user-context API key
 *   X_API_SECRET        — paired secret
 *   X_ACCESS_TOKEN      — user access token (the bot account)
 *   X_ACCESS_SECRET     — paired access secret
 *   BOT_HANDLE          — @handle the bot answers to (default: PaperTrenchBot)
 *   DRY_RUN             — default true; set false only after manual checklist
 *   KILL_SWITCH         — emergency stop; when true the bot polls but never sends
 *   POLL_SECONDS        — default 60
 *   BACKFILL            — default false
 *   PREMIUM             — default false; use long template
 *   MAX_AGE_HOURS       — default 24
 *   MAX_REPLIES_PER_HOUR— default 15
 *
 * X API v2 endpoints used:
 *   - GET  /2/users/:id/mentions?since_id=...&tweet.fields=conversation_id,author_id,created_at
 *     VERIFY against current X API docs: field names and rate limits change.
 *   - POST /2/tweets with body { text, reply: { in_reply_to_tweet_id } }
 *     VERIFY against current X API docs: reply object shape and media handling.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { processMentions, defaultConfig, BOT_HANDLE } = require('./xbot.js');
const { sign } = require('./oauth.js');

const STATE_DIR = path.join(__dirname, 'state');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('state read error:', e.message);
    return {};
  }
}

function saveState(state) {
  /* R-02: the direct write truncated state.json BEFORE writing, so a crash /
   * ENOSPC mid-write left a corrupt file — and the `replied` map it holds is
   * the only thing standing between the community and duplicate replies.
   * Write-then-rename is atomic on POSIX and Windows: readers see either the
   * old state or the new one, never a half-file. */
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(tmp, STATE_FILE);
}

function envConfig() {
  return defaultConfig({
    BOT_HANDLE: process.env.BOT_HANDLE || 'PaperTrenchBot',
    DRY_RUN: !(process.env.DRY_RUN === 'false'),
    KILL_SWITCH: process.env.KILL_SWITCH === 'true',
    PREMIUM: process.env.PREMIUM === 'true',
    BACKFILL: process.env.BACKFILL === 'true',
    MAX_AGE_HOURS: parseInt(process.env.MAX_AGE_HOURS || '24', 10),
    MAX_REPLIES_PER_HOUR: parseInt(process.env.MAX_REPLIES_PER_HOUR || '15', 10),
    POLL_SECONDS: parseInt(process.env.POLL_SECONDS || '60', 10),
    X_BEARER_TOKEN: process.env.X_BEARER_TOKEN,
    X_API_KEY: process.env.X_API_KEY,
    X_API_SECRET: process.env.X_API_SECRET,
    X_ACCESS_TOKEN: process.env.X_ACCESS_TOKEN,
    X_ACCESS_SECRET: process.env.X_ACCESS_SECRET,
  });
}

async function xGet(url, cfg) {
  if (!cfg.X_BEARER_TOKEN) throw new Error('X_BEARER_TOKEN is not set');
  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: 'Bearer ' + cfg.X_BEARER_TOKEN },
  });
  if (res.status === 429) {
    const reset = res.headers.get('x-rate-limit-reset');
    const wait = reset ? Math.max(0, parseInt(reset, 10) * 1000 - Date.now()) : 900000;
    throw { retryAfterMs: wait, status: 429 };
  }
  if (res.status >= 500) {
    throw { retryAfterMs: 5000, status: res.status };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error('GET ' + res.status + ' ' + body);
  }
  return res.json();
}

async function xPost(url, body, cfg) {
  const token = cfg.X_ACCESS_TOKEN;
  const secret = cfg.X_ACCESS_SECRET;
  const consumerKey = cfg.X_API_KEY;
  const consumerSecret = cfg.X_API_SECRET;
  if (!token || !secret || !consumerKey || !consumerSecret) {
    throw new Error('X API credentials are not fully configured');
  }
  /* OAuth 1.0a user-context signing (bot/oauth.js, vector-locked by
   * bot/test/oauth.test.js). The JSON body is NOT part of the signature —
   * only oauth_* and query params are. VERIFY against current X API docs
   * before the first live post. */
  const { header } = sign('POST', url, null, {
    consumerKey,
    consumerSecret,
    accessToken: token,
    accessSecret: secret,
  });
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: header, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 429) {
    const reset = res.headers.get('x-rate-limit-reset');
    const wait = reset ? Math.max(0, parseInt(reset, 10) * 1000 - Date.now()) : 900000;
    throw { retryAfterMs: wait, status: 429 };
  }
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error('POST ' + res.status + ' ' + t);
  }
  return res.json();
}

function makeTransport(cfg) {
  return {
    log: (...args) => console.log(new Date().toISOString(), ...args),
    send: async (payload, mention) => {
      const url = 'https://api.x.com/2/tweets'; /* VERIFY against current X API docs */
      return xPost(url, payload, cfg);
    },
  };
}

async function botUserId(cfg) {
  /* The bot needs its own numeric user id to poll mentions. X's /2/users/by
   * endpoint resolves @handle -> id. VERIFY against current X API docs. */
  const h = cfg.BOT_HANDLE.replace(/^@+/, '');
  const url = 'https://api.x.com/2/users/by?usernames=' + h + '&user.fields=id';
  const data = await xGet(url, cfg);
  if (!data.data || !data.data.length) throw new Error('bot user not found: ' + h);
  return data.data[0].id;
}

async function fetchMentions(userId, sinceId, cfg) {
  /* R-01: X pages mentions (~10 per page by default) and this loop used to
   * fetch exactly one page. since_id advances to the newest id in the SAME
   * cycle, so everything past page one was skipped now and never seen
   * again — a mention burst (a streamer shoutout, a viral thread) silently
   * dropped most of the community's replies. Follow meta.next_token until
   * X says the pages are done (capped for safety). */
  const MAX_PAGES = 5;
  const out = [];
  let pageToken = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL('https://api.x.com/2/users/' + userId + '/mentions');
    url.searchParams.set('tweet.fields', 'conversation_id,author_id,created_at');
    url.searchParams.set('max_results', '100');
    if (sinceId) url.searchParams.set('since_id', sinceId);
    if (pageToken) url.searchParams.set('pagination_token', pageToken);
    /* VERIFY against current X API docs: the endpoint path, pagination keys, and
     * field names change over time. */
    const data = await xGet(url.toString(), cfg);
    for (const m of data.data || []) {
      out.push({
        id: m.id,
        author_id: m.author_id,
        conversation_id: m.conversation_id,
        created_at: m.created_at,
        text: m.text,
      });
    }
    pageToken = data.meta && data.meta.next_token;
    if (!pageToken) break;
  }
  return out;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function backoff(fn, cfg) {
  let wait = 1000;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const ms = e.retryAfterMs || wait;
      console.error('retry', attempt + 1, 'after', ms, 'ms', e.status || e.message);
      await delay(ms);
      wait = Math.min(wait * 2, 300000);
    }
  }
  throw new Error('max retries exceeded');
}

async function runOnce() {
  const cfg = envConfig();
  const state = loadState();
  let userId = state.bot_user_id;

  try {
    if (!userId) {
      userId = await backoff(() => botUserId(cfg), cfg);
      state.bot_user_id = userId;
      saveState(state);
    }

    const mentions = await backoff(() => fetchMentions(userId, state.since_id, cfg), cfg);
    const transport = makeTransport(cfg);

    const result = await processMentions(mentions, state,
      Object.assign({}, cfg, { BOT_SELF_ID: userId }), transport);
    saveState(result.state);
    console.log('cycle done', result);
    return result;
  } catch (e) {
    console.error('bot cycle failed:', e.message || e);
    throw e;
  }
}

async function runLoop() {
  const cfg = envConfig();
  const state = loadState();
  let userId = state.bot_user_id;
  if (!userId) {
    userId = await backoff(() => botUserId(cfg), cfg);
    state.bot_user_id = userId;
    saveState(state);
  }

  const transport = makeTransport(cfg);
  while (true) {
    try {
      const mentions = await backoff(() => fetchMentions(userId, state.since_id, cfg), cfg);
      const result = await processMentions(mentions, state,
        Object.assign({}, cfg, { BOT_SELF_ID: userId }), transport);
      Object.assign(state, result.state);
      saveState(state);
      console.log('cycle done', result);
    } catch (e) {
      /* R-03: cycle errors used to log as "[object Object]" when the thrown
       * value was one of the retry-shaped objects (xGet/xPost throw those on
       * 429/5xx) — diagnostics went blind exactly during rate limits. */
      console.error('bot cycle error:', e && e.status ? 'HTTP ' + e.status : (e && e.message) || e);
    }
    await delay(cfg.POLL_SECONDS * 1000);
  }
}

if (require.main === module) {
  (async () => {
    const once = process.argv.includes('--once');
    try {
      if (once) await runOnce();
      else await runLoop();
    } catch (e) {
      process.exitCode = 1;
    }
  })();
}

module.exports = { envConfig, loadState, saveState, fetchMentions, runOnce, backoff };
