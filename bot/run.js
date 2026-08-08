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
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
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
  const h = cfg.BOT_HANDLE.replace(/^@+/, '');
  const token = cfg.X_ACCESS_TOKEN;
  const secret = cfg.X_ACCESS_SECRET;
  const consumerKey = cfg.X_API_KEY;
  const consumerSecret = cfg.X_API_SECRET;
  if (!token || !secret || !consumerKey || !consumerSecret) {
    throw new Error('X API credentials are not fully configured');
  }
  /* NOTE: real X posting requires OAuth 1.0a or OAuth 2.0 user-context signing.
   * This function is a DRY_RUN-safe shell: in DRY_RUN mode xbot.js never calls
   * transport.send(), so the signing implementation can be filled in later with
   * a verified library (e.g. oauth-1.0a) without changing core logic. */
  throw new Error('live posting not implemented in this DRY_RUN-only build');
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
  const url = new URL('https://api.x.com/2/users/' + userId + '/mentions');
  url.searchParams.set('tweet.fields', 'conversation_id,author_id,created_at');
  if (sinceId) url.searchParams.set('since_id', sinceId);
  /* VERIFY against current X API docs: the endpoint path, pagination keys, and
   * field names change over time. */
  const data = await xGet(url.toString(), cfg);
  return (data.data || []).map((m) => ({
    id: m.id,
    author_id: m.author_id,
    conversation_id: m.conversation_id,
    created_at: m.created_at,
    text: m.text,
  }));
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
      console.error('bot cycle error:', e.message || e);
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
