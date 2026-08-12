/* X feed ingestion — fetch, parse, and SANITIZE a trader's public posts.
 *
 * THREE sources, one output shape, because no single one reaches everyone.
 * They are tried cheapest-first (see worker/index.js handleXFeed):
 *
 *  1. X's syndication timeline (syndication.twitter.com) — the machinery X
 *     ships for its embedded widgets. No auth. Works for many handles, but
 *     silently serves ZERO entries for others (small/new/flagged accounts —
 *     observed live for @naskvr: 200, hasResults:true, empty timeline).
 *  2. X's LOGGED-OUT web page (x.com/<handle>) — the exact thing a browser
 *     with no account loads. Modern x-web streams the profile timeline into
 *     the initial HTML as a React-Server-Components flight payload; parsing
 *     it yields the same posts a logged-out visitor sees. This is the layer
 *     that reaches the syndication-invisible (verified live for @naskvr:
 *     5 real posts). It needs no token. It is also UNOFFICIAL and the shape
 *     drifts — every fragile constant lives in PUBLIC_SOURCE below, and a
 *     parse miss degrades to the next layer rather than erroring.
 *     (The classic guest-token GraphQL UserTweets flow is NOT used: in 2026
 *     it returns 200 with an empty timeline for guest tokens — X's guest
 *     lockdown — so it buys nothing the SSR page doesn't already give.)
 *  3. The user's OWN OAuth token against API v2 /users/:id/tweets — sign-in
 *     here IS X OAuth with tweet.read, so every account has handed us a key
 *     to its own posts. The last resort for anything even the logged-out
 *     page hides; user-context rate limits are per-user, so it scales.
 *
 * Sanitization happens HERE, at ingest, for EVERY source: what leaves this
 * module is plain text, numbers, post ids, and media URLs pinned to X's own
 * image CDN — never markup from the wire. The site escapes at render besides;
 * a tweet must not be able to carry script into a profile page from either
 * side of the cache.
 *
 * Tokens are write-only secrets: sealed with AES-GCM under a key derived
 * from SESSION_SECRET before they touch D1, opened only inside a fetch, and
 * never serialized into any response or log.
 */
'use strict';

const TIMELINE_URL = (handle) =>
  `https://syndication.twitter.com/srv/timeline-profile/screen-name/${handle}?showReplies=false`;

// A real browser UA: the syndication host serves widget traffic and answers
// bare library UAs inconsistently.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const MAX_POSTS = 8;
const MAX_TEXT = 600;
const MAX_PHOTOS = 4;

const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

/** Only X's own image CDN may appear in a media URL — anything else is
 *  dropped, not proxied, not "probably fine". */
function safePhoto(url) {
  const value = String(url || '');
  return value.startsWith('https://pbs.twimg.com/') ? value : null;
}

/** Control characters have no business in a tweet; newlines stay. */
function cleanText(text) {
  return String(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .trim().slice(0, MAX_TEXT);
}

/** Tweet text with t.co stubs swapped for what they stand for, as PLAIN TEXT.
 *  Media stubs (the trailing t.co that "is" the photo) are removed outright —
 *  the photo itself is in `photos`. */
function expandText(tweet) {
  let text = String(tweet.full_text != null ? tweet.full_text : (tweet.text || ''));
  const entities = tweet.entities || {};
  for (const u of Array.isArray(entities.urls) ? entities.urls : []) {
    const stub = String(u && u.url || '');
    const expanded = String(u && u.expanded_url || '');
    if (stub && /^https?:\/\//.test(expanded)) text = text.split(stub).join(expanded);
  }
  for (const m of Array.isArray(entities.media) ? entities.media : []) {
    const stub = String(m && m.url || '');
    if (stub) text = text.split(stub).join('');
  }
  return cleanText(text);
}

/**
 * The syndication page's embedded JSON → clean post objects.
 *
 * Keeps the trader's own posts (and quote-tweet shells); drops retweets —
 * the pane is captioned as THEIR feed, and a wall of other people's words
 * under their name would caption itself wrong.
 */
function sanitizeEntries(entries) {
  const posts = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const tweet = entry && entry.content && entry.content.tweet;
    if (!tweet || typeof tweet !== 'object') continue;
    if (tweet.retweeted_status) continue;
    const id = String(tweet.id_str || '');
    if (!/^[0-9]{1,25}$/.test(id)) continue;
    const createdAt = Date.parse(tweet.created_at || '');
    if (!Number.isFinite(createdAt)) continue;
    const photos = [];
    for (const photo of Array.isArray(tweet.photos) ? tweet.photos : []) {
      const url = safePhoto(photo && photo.url);
      if (url && photos.length < MAX_PHOTOS) photos.push(url);
    }
    posts.push({
      id,
      text: expandText(tweet),
      createdAt,
      photos,
      likes: Math.max(0, Number(tweet.favorite_count) || 0),
    });
  }
  posts.sort((a, b) => b.createdAt - a.createdAt);
  return posts.slice(0, MAX_POSTS);
}

/** The __NEXT_DATA__ payload out of the syndication HTML, or null. */
function parseTimelineHtml(html) {
  const match = String(html).match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) return null;
  try {
    const data = JSON.parse(match[1]);
    const entries = data && data.props && data.props.pageProps &&
      data.props.pageProps.timeline && data.props.pageProps.timeline.entries;
    return Array.isArray(entries) ? entries : null;
  } catch {
    return null;
  }
}

/** Fetch + parse + sanitize one handle's public posts. Throws on any upstream
 *  refusal — the CALLER decides whether a stale cache beats the error. */
async function fetchPosts(handle) {
  if (!HANDLE_RE.test(String(handle))) throw new Error('bad handle');
  const response = await fetch(TIMELINE_URL(handle), { headers: { 'User-Agent': UA } });
  if (!response.ok) throw new Error('upstream ' + response.status);
  const entries = parseTimelineHtml(await response.text());
  if (entries === null) throw new Error('upstream shape changed');
  return sanitizeEntries(entries);
}

/* ---------------- the logged-out web-page layer (SSR flight) ----------------
 *
 * EVERYTHING fragile about scraping x.com's logged-out page lives in this one
 * object, because X reshapes it without warning. If posts stop coming back,
 * this is the first and usually only place to look. Confirmed 2026-08-12
 * against x.com/naskvr (5 real posts) from real egress.
 */
const PUBLIC_SOURCE = {
  // The page a browser with no account loads. Its initial HTML streams the
  // profile timeline as an RSC "flight" payload (a normalized cache, Relay
  // style: objects keyed by base64 ids across :details / :counts facets).
  profileUrl: (handle) => `https://x.com/${handle}`,
  // A real browser UA + language: the page shells differently for bare UAs.
  headers: {
    'User-Agent': UA,
    'Accept-Language': 'en-US,en;q=0.9',
    Accept: 'text/html',
  },
  // How a tweet's fields are spelled in the flight payload today.
  detailsKey: /"client:([A-Za-z0-9+\/=]+):details"/g,
  tweetIdFromCacheKey: /^Tweet:(\d{1,25})$/,
  createdAtMs: /created_at_ms:(\d{10,16})/,
  fullText: /full_text:"((?:\\.|[^"\\])*)"/,
  favoriteCount: /favorite_count:(\d+)/,
  mediaUrl: /media_url_https:"((?:\\.|[^"\\])*)"/g,
  // A tweet that IS a repost carries a non-null retweeted_status_results —
  // those are someone else's words and are dropped.
  isRepost: /retweeted_status_results:(?!null)/,
};

const b64decode = (text) => {
  try { return decodeURIComponent(escape(atob(String(text)))); }
  catch { try { return atob(String(text)); } catch { return ''; } }
};

/** A JS-string-literal body → its real characters (\n, \uXXXX, …). */
function unescapeJsString(body) {
  try { return JSON.parse('"' + body + '"'); } catch { return String(body); }
}

/** The one facet OBJECT for a cache key. Each key appears twice in the
 *  payload — as a {__ref:"…"} pointer and as the real "…":$R[n]={…}
 *  definition; only the definition carries fields. */
function facetBody(html, cacheKey) {
  const marker = '"client:' + cacheKey + '"';
  let at = html.indexOf(marker + ':$R');
  if (at < 0) at = html.indexOf(marker + ':{');
  if (at < 0) return '';
  let end = html.indexOf(',"client:', at + marker.length);
  if (end < 0 || end - at > 4000) end = at + 4000;
  return html.slice(at, end);
}

/**
 * The logged-out profile page's flight payload → clean post objects.
 *
 * Anchors on each tweet's :details facet (which holds full_text +
 * created_at_ms), joins :counts for likes and any media facet for photos,
 * dedupes (facets repeat across stream chunks), drops reposts, and keeps at
 * most MAX_POSTS newest. A shape the parser no longer recognizes yields [],
 * which the pipeline treats as "this source had nothing", not an error.
 */
function parseTimelineFlight(html) {
  const text = String(html);
  const seen = new Set();
  const posts = [];
  for (const match of text.matchAll(PUBLIC_SOURCE.detailsKey)) {
    const cacheKey = match[1];
    if (seen.has(cacheKey)) continue;
    seen.add(cacheKey);
    const idMatch = PUBLIC_SOURCE.tweetIdFromCacheKey.exec(b64decode(cacheKey));
    if (!idMatch) continue;

    const details = facetBody(text, cacheKey + ':details');
    if (!details || PUBLIC_SOURCE.isRepost.test(details)) continue;
    const at = PUBLIC_SOURCE.createdAtMs.exec(details);
    const body = PUBLIC_SOURCE.fullText.exec(details);
    if (!at || !body) continue;

    const counts = facetBody(text, cacheKey + ':counts');
    const fav = counts && PUBLIC_SOURCE.favoriteCount.exec(counts);

    const photos = [];
    const mediaScope = details + facetBody(text, cacheKey + ':media');
    for (const m of mediaScope.matchAll(PUBLIC_SOURCE.mediaUrl)) {
      const url = safePhoto(unescapeJsString(m[1]));
      if (url && photos.length < MAX_PHOTOS) photos.push(url);
    }

    posts.push({
      id: idMatch[1],
      text: cleanText(unescapeJsString(body[1])),
      createdAt: Number(at[1]),
      photos,
      likes: fav ? Math.max(0, Number(fav[1])) : 0,
    });
  }
  posts.sort((a, b) => b.createdAt - a.createdAt);
  return posts.slice(0, MAX_POSTS);
}

/** Fetch + parse the logged-out profile page. Throws on an HTTP refusal (so
 *  the caller can fall through); returns [] when the page loaded but carried
 *  no recognizable timeline (protected, empty, or a reshape). */
async function fetchPublicPosts(handle) {
  if (!HANDLE_RE.test(String(handle))) throw new Error('bad handle');
  const response = await fetch(PUBLIC_SOURCE.profileUrl(handle), { headers: PUBLIC_SOURCE.headers });
  if (!response.ok) throw new Error('public ' + response.status);
  return parseTimelineFlight(await response.text());
}

/* ------------------- the user-token layer (API v2) ------------------- */

const encode = (s) => new TextEncoder().encode(s);

function toB64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(text) {
  const pad = text.length % 4 === 0 ? '' : '='.repeat(4 - (text.length % 4));
  const raw = atob(String(text).replace(/-/g, '+').replace(/_/g, '/') + pad);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function tokenKey(secret) {
  // Derived, not reused: the session HMAC secret and the token cipher key
  // must not be the same bytes doing two jobs.
  const digest = await crypto.subtle.digest('SHA-256', encode(secret + '|x-tokens-v1'));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** OAuth tokens → opaque ciphertext, the only form that ever touches D1. */
async function sealTokens(secret, tokens) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await tokenKey(secret);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, encode(JSON.stringify(tokens)));
  return toB64url(iv) + '.' + toB64url(ct);
}

/** Ciphertext → tokens, or null. GCM authenticates, so a tampered or
 *  wrong-key blob is a null, never a garbage token sent to X. */
async function openTokens(secret, sealed) {
  try {
    const dot = String(sealed).indexOf('.');
    if (dot < 1) return null;
    const key = await tokenKey(secret);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromB64url(String(sealed).slice(0, dot)) },
      key, fromB64url(String(sealed).slice(dot + 1)));
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    return null;
  }
}

/** Exchange a refresh token for a fresh pair (PKCE public client: client_id
 *  in the body, no secret). X rotates refresh tokens — keep the new one. */
async function refreshAccess(clientId, refreshToken) {
  const response = await fetch('https://api.x.com/2/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId,
    }),
  });
  if (!response.ok) throw new Error('refresh ' + response.status);
  const t = await response.json();
  return {
    access: String(t.access_token || ''),
    refresh: String(t.refresh_token || refreshToken),
    exp: Date.now() + (Number(t.expires_in) || 7200) * 1000,
  };
}

/** API v2 timeline payload → the exact same post shape syndication ingest
 *  produces; the cache and the renderer never learn which source filled it. */
function sanitizeV2(payload) {
  const mediaByKey = new Map();
  const included = payload && payload.includes && payload.includes.media;
  for (const m of Array.isArray(included) ? included : []) {
    if (m && m.media_key) mediaByKey.set(m.media_key, m);
  }
  const posts = [];
  for (const t of Array.isArray(payload && payload.data) ? payload.data : []) {
    const id = String(t && t.id || '');
    if (!/^[0-9]{1,25}$/.test(id)) continue;
    const createdAt = Date.parse(t.created_at || '');
    if (!Number.isFinite(createdAt)) continue;

    let text = String(t.text || '');
    const urls = t.entities && Array.isArray(t.entities.urls) ? t.entities.urls : [];
    for (const u of urls) {
      const stub = String(u && u.url || '');
      const expanded = String(u && u.expanded_url || '');
      if (!stub) continue;
      // A t.co that expands to the tweet's own /photo/N or /video/N is the
      // media stub — drop it, the media rides in `photos`.
      if (/\/(photo|video)\/\d+$/.test(expanded)) text = text.split(stub).join('');
      else if (/^https?:\/\//.test(expanded)) text = text.split(stub).join(expanded);
    }

    const photos = [];
    const keys = t.attachments && Array.isArray(t.attachments.media_keys)
      ? t.attachments.media_keys : [];
    for (const key of keys) {
      const m = mediaByKey.get(key);
      const url = m && m.type === 'photo' ? safePhoto(m.url) : null;
      if (url && photos.length < MAX_PHOTOS) photos.push(url);
    }

    posts.push({
      id,
      text: cleanText(text),
      createdAt,
      photos,
      likes: Math.max(0, Number(t.public_metrics && t.public_metrics.like_count) || 0),
    });
  }
  posts.sort((a, b) => b.createdAt - a.createdAt);
  return posts.slice(0, MAX_POSTS);
}

/** The user's own recent posts, fetched with THEIR token. Throws on refusal
 *  (including 401 — the caller owns the refresh-and-retry decision). */
async function fetchUserTweets(xId, accessToken) {
  const params = 'max_results=10&exclude=replies,retweets' +
    '&tweet.fields=created_at,public_metrics,entities' +
    '&expansions=attachments.media_keys&media.fields=media_key,type,url,preview_image_url';
  const response = await fetch(
    `https://api.x.com/2/users/${encodeURIComponent(String(xId))}/tweets?${params}`,
    { headers: { Authorization: 'Bearer ' + accessToken } });
  if (!response.ok) throw new Error('v2 ' + response.status);
  return sanitizeV2(await response.json());
}

/** Login-time priming: the freshest token the user will ever have just
 *  arrived, so spend it at once — the feed is on their profile before they
 *  have navigated there. Failures are swallowed by design: a login must
 *  never break because a timeline read did. */
async function primeFeedCache(env, xId, handle, accessToken) {
  const posts = await fetchUserTweets(xId, accessToken);
  await env.DB.prepare(`
    INSERT INTO x_feed_cache (handle, fetched_at, posts_json) VALUES (?, ?, ?)
    ON CONFLICT(handle) DO UPDATE SET
      fetched_at = excluded.fetched_at, posts_json = excluded.posts_json`)
    .bind(String(handle).toLowerCase(), Date.now(), JSON.stringify(posts)).run();
}

module.exports = {
  HANDLE_RE, MAX_POSTS, fetchPosts, parseTimelineHtml, sanitizeEntries, expandText,
  PUBLIC_SOURCE, parseTimelineFlight, fetchPublicPosts,
  sealTokens, openTokens, refreshAccess, sanitizeV2, fetchUserTweets, primeFeedCache,
};
