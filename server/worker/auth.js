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

/** The signed-in user for a request, or null. */
async function sessionUser(request, env) {
  const token = readCookie(request, SESSION_COOKIE);
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
  authorize.searchParams.set('scope', 'users.read tweet.read');
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
async function finishLogin(request, env) {
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
  await env.DB.prepare(`
    INSERT INTO users (x_id, handle, display_name, avatar_url, created_at, last_login_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(x_id) DO UPDATE SET
      handle = excluded.handle,
      display_name = excluded.display_name,
      avatar_url = excluded.avatar_url,
      last_login_at = excluded.last_login_at`)
    .bind(me.id, me.username, me.name || me.username, me.profile_image_url || null, now, now)
    .run();
  const user = await env.DB.prepare('SELECT id, session_epoch FROM users WHERE x_id = ?')
    .bind(me.id).first();

  const session = await signPayload(env.SESSION_SECRET, {
    uid: user.id, epoch: user.session_epoch, exp: now + SESSION_TTL_MS,
  });
  const headers = new Headers({ Location: env.SITE_ORIGIN + '/leaderboard.html' });
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
