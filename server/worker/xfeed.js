/* X feed ingestion — fetch, parse, and SANITIZE a trader's public posts.
 *
 * Source: X's own syndication timeline (syndication.twitter.com), the same
 * machinery X ships for its embedded widgets. Verified working from real
 * Cloudflare egress (2026-08-12: 200 + 101 entries for a live handle); it
 * needs no auth and no API key. It is also login-walled and rate-limited for
 * BROWSERS, which is exactly why the worker fetches it once and caches it
 * rather than every visitor's browser trying and failing.
 *
 * Sanitization happens HERE, at ingest, on purpose: what leaves this module
 * is plain text, numbers, post ids, and media URLs pinned to X's own image
 * CDN — never markup from the wire. The site escapes at render besides;
 * a tweet must not be able to carry script into a profile page from either
 * side of the cache.
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
  // Control characters have no business in a tweet; newlines stay.
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  return text.trim().slice(0, MAX_TEXT);
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

module.exports = {
  HANDLE_RE, MAX_POSTS, fetchPosts, parseTimelineHtml, sanitizeEntries, expandText,
};
