/* PaperTrench server — X OAuth 2.0 (PKCE) + stateless sessions.
 *
 * Identity must cost something (LEADERBOARD.md rule: one ranked record per
 * verified identity). X sign-in is the whole account system: no passwords,
 * no emails, nothing to breach beyond a public handle mapping.
 *
 * Sessions are HMAC-signed cookies — {uid, epoch, exp} — verified on every
 * request. Bumping users.session_epoch revokes everything outstanding.
 */
'use strict';

const xfeed = require('./xfeed.js');
const { blockedContent } = require('../core/clan.js');

const SESSION_COOKIE = 'pt_session';
const OAUTH_COOKIE = 'pt_oauth';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const enc = (s) => new TextEncoder().encode(s);

function b64url(bytes) {
  let s = '';
  const arr = new Uint8Array(bytes);
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(text) {
  const pad = text.length % 4 === 0 ? '' : '='.repeat(4 - (text.length % 4));
  return atob(text.replace(/-/g, '+').replace(/_/g, '/') + pad);
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', enc(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc(message)));
}

async function signPayload(secret, obj) {
  const body = b64url(enc(JSON.stringify(obj)));
  return body + '.' + (await hmac(secret, body));
}

async function verifyPayload(secret, token) {
  if (typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const expected = await hmac(secret, body);
  // Constant-time-ish compare; both sides are same-length base64url digests.
  if (expected.length !== token.length - dot - 1) return null;
  let diff = 0;
  const given = token.slice(dot + 1);
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  if (diff !== 0) return null;
  try { return JSON.parse(b64urlDecode(body)); } catch { return null; }
}

function readCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq) === name) return part.slice(eq + 1);
  }
  return null;
}

/**
 * Session cookie, correct under both deployment topologies.
 *
 * Same-site (api.papertrench.com under papertrench.com, which needs the zone
 * on Cloudflare) can use SameSite=Lax and scope the cookie to the parent
 * domain. A workers.dev deploy is CROSS-site to the pages, where Lax would
 * silently drop the session on every fetch and sign-in would appear to work
 * and then not — so there it must be None.
 *
 * SameSite=None re-opens the CSRF door that Lax closes, which is why every
 * state-changing route independently enforces the Origin allowlist
 * (requireOrigin in worker/index.js). Setting COOKIE_DOMAIN is what selects
 * the stricter mode.
 */
function cookieHeader(name, value, maxAgeSec, env) {
  const domain = env.COOKIE_DOMAIN ? `; Domain=${env.COOKIE_DOMAIN}` : '';
  const sameSite = env.COOKIE_DOMAIN ? 'Lax' : 'None';
  return `${name}=${value}; Path=/; Max-Age=${maxAgeSec}; HttpOnly; Secure; SameSite=${sameSite}${domain}`;
}

/**
 * The session token can arrive two ways: the cookie, or an Authorization:
 * Bearer header carrying the SAME signed payload.
 *
 * The header exists because the workers.dev topology makes the cookie
 * third-party to the pages — and Safari blocks, Firefox partitions, and
 * Brave/incognito/strict-Chrome profiles drop third-party cookies. On those
 * browsers the OAuth dance completed, the user record was written, and then
 * every /api/me read signed-out ("your website doesn't read that you made an
 * account" — live field report). The callback therefore also hands the token
 * to the page in its redirect FRAGMENT (never reaches a server or a log,
 * stripped from the URL on arrival) and the page sends it back as a header,
 * which no cookie policy can drop. A bearer header is also CSRF-inert; the
 * Origin allowlist on state-changing routes stays for both transports.
 */
function bearerToken(request) {
  const header = request.headers.get('Authorization') || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

/** The signed-in user for a request, or null. */
async function sessionUser(request, env) {
  const token = readCookie(request, SESSION_COOKIE) || bearerToken(request);
  if (!token) return null;
  const session = await verifyPayload(env.SESSION_SECRET, token);
  if (!session || !session.uid || session.exp < Date.now()) return null;
  const user = await env.DB.prepare(
    'SELECT id, x_id, handle, display_name, avatar_url, session_epoch FROM users WHERE id = ?')
    .bind(session.uid).first();
  if (!user || user.session_epoch !== session.epoch) return null;
  return user;
}

/** Step 1: redirect to X with PKCE, carrying state+verifier in a signed
 * short-lived cookie. */
async function startLogin(request, env) {
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', enc(verifier)));
  const authorize = new URL('https://x.com/i/oauth2/authorize');
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('client_id', env.X_CLIENT_ID);
  authorize.searchParams.set('redirect_uri', env.X_REDIRECT_URI);
  // offline.access buys the refresh token that keeps a user's own timeline
  // readable BETWEEN logins — the layer that reaches accounts X's public
  // syndication feed silently serves empty.
  authorize.searchParams.set('scope', 'users.read tweet.read offline.access');
  authorize.searchParams.set('state', state);
  authorize.searchParams.set('code_challenge', challenge);
  authorize.searchParams.set('code_challenge_method', 'S256');
  const carry = await signPayload(env.SESSION_SECRET, { state, verifier, exp: Date.now() + 600000 });
  return new Response(null, {
    status: 302,
    headers: {
      Location: authorize.toString(),
      'Set-Cookie': cookieHeader(OAUTH_COOKIE, carry, 600, env),
    },
  });
}

/** Step 2: exchange the code, upsert the user, set the session cookie. */
async function finishLogin(request, env, ctx) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const carry = await verifyPayload(env.SESSION_SECRET, readCookie(request, OAUTH_COOKIE));
  if (!code || !carry || carry.exp < Date.now() || carry.state !== state) {
    return new Response('Sign-in expired or tampered with — try again.', { status: 400 });
  }

  const tokenRes = await fetch('https://api.x.com/2/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: env.X_CLIENT_ID,
      redirect_uri: env.X_REDIRECT_URI,
      code_verifier: carry.verifier,
    }),
  });
  if (!tokenRes.ok) return new Response('X token exchange failed.', { status: 502 });
  const token = await tokenRes.json();

  const meRes = await fetch('https://api.x.com/2/users/me?user.fields=profile_image_url', {
    headers: { Authorization: 'Bearer ' + token.access_token },
  });
  if (!meRes.ok) return new Response('X profile fetch failed.', { status: 502 });
  const me = (await meRes.json()).data;

  const now = Date.now();
  // The OAuth pair is kept — SEALED (AES-GCM under a SESSION_SECRET-derived
  // key), written to D1, and never read anywhere but the x-feed token layer.
  // It is what lets the profile page show this user's own posts to visitors
  // even when X's public syndication feed pretends the account is empty.
  const sealed = await xfeed.sealTokens(env.SESSION_SECRET, {
    access: String(token.access_token || ''),
    refresh: token.refresh_token ? String(token.refresh_token) : null,
    exp: now + (Number(token.expires_in) || 7200) * 1000,
  });
  // The display name is the one identity field X lets a user set freely,
  // and it renders on profile pages right beside verified numbers — the same
  // surfaces the clan-content filter exists for. A slur worn in from X is the
  // same slur, so it trips the same list (core/clan.js — parity, not a second
  // copy of the list). The sign-in itself is never refused over it: identity
  // is not hostage to a display string, so the handle stands in until the
  // user changes their name on X. Non-ASCII names pass untouched — the check
  // reads tokens, it does not police charset.
  const displayName = blockedContent(String(me.name || ''))
    ? me.username : (me.name || me.username);
  await env.DB.prepare(`
    INSERT INTO users (x_id, handle, display_name, avatar_url, x_tokens, created_at, last_login_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(x_id) DO UPDATE SET
      handle = excluded.handle,
      display_name = excluded.display_name,
      avatar_url = excluded.avatar_url,
      x_tokens = excluded.x_tokens,
      last_login_at = excluded.last_login_at`)
    .bind(me.id, me.username, displayName, me.profile_image_url || null,
      sealed, now, now)
    .run();
  // Spend the freshest token the user will ever have right now: their feed
  // is cached before they have navigated anywhere. After the redirect, not
  // in its way — and a failed timeline read must never fail a login.
  const prime = xfeed.primeFeedCache(env, me.id, me.username, token.access_token)
    .catch(() => {});
  if (ctx && ctx.waitUntil) ctx.waitUntil(prime);
  const user = await env.DB.prepare('SELECT id, session_epoch FROM users WHERE x_id = ?')
    .bind(me.id).first();

  const session = await signPayload(env.SESSION_SECRET, {
    uid: user.id, epoch: user.session_epoch, exp: now + SESSION_TTL_MS,
  });
  // The #authed=<token> fragment carries the signed session token to the
  // page itself, because on a cross-site (workers.dev) deploy the cookie
  // alone is not enough: Safari blocks, Firefox partitions, and
  // Brave/incognito Chrome drop third-party cookies, so the cookie-only
  // flow "worked" and then every later /api/me read signed-out. The page
  // stores the token and sends it back as an Authorization header (see
  // bearerToken above). A fragment, not a query param, so it never reaches
  // any server log and dies in the client — the page strips it from the URL
  // on arrival. The token is base64url + '.' + base64url, fragment-safe
  // verbatim. The bare '#authed' marker semantics remain for pages served
  // before this change: token or not, the fragment still means "a sign-in
  // just completed".
  const headers = new Headers({ Location: env.SITE_ORIGIN + '/leaderboard.html#authed=' + session });
  headers.append('Set-Cookie', cookieHeader(SESSION_COOKIE, session, SESSION_TTL_MS / 1000, env));
  headers.append('Set-Cookie', cookieHeader(OAUTH_COOKIE, '', 0, env));
  return new Response(null, { status: 302, headers });
}

/**
 * Sign out, and mean it.
 *
 * Clearing the cookie only removes the browser's copy. The token itself is a
 * self-contained HMAC assertion valid for its full 30 days, so a copy taken
 * before signing out — off a shared machine, out of a proxy log, from anyone
 * who had the browser for a minute — kept working right through "log out"
 * and for a month afterwards. There was no way to revoke it: the epoch this
 * file has checked since it was written was never once incremented.
 *
 * Bumping it is the revocation. Every outstanding token for this user carries
 * the old epoch and stops verifying on the next request.
 */
async function logout(request, env) {
  const user = await sessionUser(request, env);
  if (user) {
    await env.DB.prepare('UPDATE users SET session_epoch = session_epoch + 1 WHERE id = ?')
      .bind(user.id).run();
  }
  return new Response(JSON.stringify({ ok: true }), {
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': cookieHeader(SESSION_COOKIE, '', 0, env),
    },
  });
}

module.exports = { sessionUser, startLogin, finishLogin, logout };
