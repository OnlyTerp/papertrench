/* PaperTrench onboarding bot — pure core logic.
 *
 * No network imports. The caller (run.js) injects transport.send() and any
 * persistence needed, so the whole pipeline can be unit-tested offline.
 */

'use strict';

const { BOT_HANDLE, SHORT_TEMPLATE, LONG_TEMPLATE } = require('./template.js');

function nowHours() {
  return Date.now() / 36e5;
}

function defaultConfig(over) {
  return Object.assign({
    BOT_HANDLE: 'PaperTrenchBot',
    PREMIUM: false,
    DRY_RUN: true,
    KILL_SWITCH: false,
    BACKFILL: false,
    MAX_AGE_HOURS: 24,
    MAX_REPLIES_PER_HOUR: 15,
    HOURS_TO_MS: 36e5,
  }, over || {});
}

function makeEmptyState() {
  return {
    since_id: null,
    replied: {}, /* tweetId -> true; also conversationId -> true */
    lastReplyHour: 0,
    hourlyCount: 0,
  };
}

function mentionHour(m) {
  if (!m.created_at) return null;
  try {
    return new Date(m.created_at).getTime() / 36e5;
  } catch (e) {
    return null;
  }
}

/* Tweet ids are numeric snowflake strings. Compare as BigInt when both sides
 * are numeric so a shorter (older) id can never sort above a longer one; fall
 * back to string comparison for non-numeric ids (tests use them). */
function idGt(a, b) {
  const as = String(a);
  const bs = String(b);
  if (/^\d+$/.test(as) && /^\d+$/.test(bs)) return BigInt(as) > BigInt(bs);
  return as > bs;
}

function isReplied(store, id, conversationId) {
  if (!store) return false;
  return !!store[id] || (conversationId ? !!store[conversationId] : false);
}

function recordReply(store, id, conversationId) {
  store[id] = true;
  if (conversationId) store[conversationId] = true;
}

function chooseTemplate(config) {
  return config.PREMIUM ? LONG_TEMPLATE : SHORT_TEMPLATE;
}

function buildReply(config, mention) {
  const text = chooseTemplate(config).replace(/@PaperTrenchBot/g, '@' + BOT_HANDLE(config));
  return { text, reply: { in_reply_to_tweet_id: mention.id } };
}

async function processMentions(mentions, state, config, transport) {
  const cfg = defaultConfig(config);
  const st = state || makeEmptyState();
  const log = transport && transport.log ? transport.log : () => {};
  const now = nowHours();

  /* First-run / backfill guard: on a completely empty state, record the newest
   * mention id and reply to nothing. This prevents a backlog blast the first
   * time the bot starts. */
  if (st.since_id == null && mentions && mentions.length) {
    let newest = mentions[0].id;
    for (const m of mentions) {
      if (idGt(m.id, newest)) newest = m.id;
    }
    st.since_id = newest;
    if (!cfg.BACKFILL) {
      log('first-run guard: recorded since_id=' + newest + ', no replies sent');
      return { state: st, handled: 0, sent: 0, skipped: mentions.length };
    }
  }

  const results = {
    handled: 0,
    sent: 0,
    skipped: 0,
    errors: [],
  };

  if (!mentions || !mentions.length) {
    return { state: st, ...results };
  }

  /* Advance since_id to the newest mention we have seen, even if we don't
   * reply, so the next poll does not re-process the same window. */
  for (const m of mentions) {
    if (m.id && (!st.since_id || idGt(m.id, st.since_id))) st.since_id = m.id;
  }

  /* Oldest first. */
  const sorted = [...mentions].sort((a, b) => {
    const ai = a.id || '';
    const bi = b.id || '';
    if (idGt(bi, ai)) return -1;
    if (idGt(ai, bi)) return 1;
    return 0;
  });

  for (const m of sorted) {
    results.handled++;

    /* a) skip if tweet author is the bot itself */
    if (m.author_id && String(m.author_id) === String(cfg.BOT_SELF_ID || '')) {
      log('skip: author is bot', m.id);
      results.skipped++;
      continue;
    }

    /* b) skip if tweet id or conversation_id was already replied to */
    if (isReplied(st.replied, m.id, m.conversation_id)) {
      log('skip: already replied', m.id, m.conversation_id);
      results.skipped++;
      continue;
    }

    /* c) skip mentions older than MAX_AGE_HOURS */
    const h = mentionHour(m);
    if (h != null && now - h > cfg.MAX_AGE_HOURS) {
      log('skip: stale mention', m.id, now - h);
      results.skipped++;
      continue;
    }

    /* d) hourly cap. Over-cap mentions are DROPPED, not queued: since_id has
     * already advanced past them, and a mention burst beyond the cap is
     * exactly the scenario where silence is safer than a delayed flood.
     * Reset the counter if we have crossed into a new hour bucket. */
    if (Math.floor(now) !== Math.floor(st.lastReplyHour)) {
      st.hourlyCount = 0;
      st.lastReplyHour = Math.floor(now);
    }
    if (st.hourlyCount >= cfg.MAX_REPLIES_PER_HOUR) {
      log('hourly cap reached', m.id);
      results.skipped++;
      continue;
    }

    /* e) KILL_SWITCH or DRY_RUN: never call transport.send, log the would-be reply. */
    if (cfg.KILL_SWITCH) {
      log('KILL_SWITCH: would not reply to', m.id);
      results.skipped++;
      continue;
    }

    const payload = buildReply(cfg, m);

    if (cfg.DRY_RUN) {
      log('DRY_RUN: would reply to', m.id, 'with', payload.text.substring(0, 60) + '...');
      recordReply(st.replied, m.id, m.conversation_id);
      st.hourlyCount++;
      continue;
    }

    if (!transport || typeof transport.send !== 'function') {
      results.errors.push({ id: m.id, reason: 'no transport.send' });
      continue;
    }

    try {
      await transport.send(payload, m);
      recordReply(st.replied, m.id, m.conversation_id);
      st.hourlyCount++;
      results.sent++;
    } catch (err) {
      results.errors.push({ id: m.id, reason: err && err.message ? err.message : String(err) });
    }
  }

  return { state: st, ...results };
}

module.exports = {
  defaultConfig,
  makeEmptyState,
  processMentions,
  buildReply,
  isReplied,
  recordReply,
  BOT_HANDLE,
  SHORT_TEMPLATE,
  LONG_TEMPLATE,
};
