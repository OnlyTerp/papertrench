/* The profile control in the site header.
 *
 * Every page carries it, but only eight of the twenty-seven load arena.js, so
 * this is deliberately standalone — no shared module, no build step, and it
 * must never throw into a page that is otherwise static.
 *
 * Signed out it is a sign-in link; signed in it is the user's avatar and handle
 * pointing at their own profile. Both are one element in the same slot, so the
 * nav does not reflow when the answer arrives.
 */
(() => {
  'use strict';

  // Same origin and session transport as arena.js. See the comments there on
  // why the API is cross-site and why the token rides in localStorage as well
  // as a cookie.
  const API = 'https://papertrench-api.onerobby.workers.dev';
  const TOKEN_KEY = 'pt_session_token';
  const CACHE_KEY = 'pt_nav_identity';

  const slot = document.getElementById('nav-profile');
  if (!slot) return;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  /** Only an https image we serve or X serves may be used as an avatar. */
  function safeAvatar(url) {
    try {
      const u = new URL(String(url));
      return u.protocol === 'https:' ? u.toString() : null;
    } catch { return null; }
  }

  function renderSignedOut() {
    slot.innerHTML = `<a class="nav-profile signin" href="${API}/api/auth/x/start">Sign in</a>`;
  }

  function renderSignedIn(me) {
    const handle = String(me.handle || '').replace(/[^A-Za-z0-9_]/g, '');
    if (!handle) { renderSignedOut(); return; }
    const avatar = safeAvatar(me.avatarUrl);
    slot.innerHTML = `
      <a class="nav-profile" href="/profile?handle=${encodeURIComponent(handle)}" title="Your PaperTrench profile">
        ${avatar
          ? `<img src="${esc(avatar)}" alt="" width="22" height="22" loading="lazy">`
          : '<span class="nav-profile-dot" aria-hidden="true"></span>'}
        <span class="nav-profile-handle">@${esc(handle)}</span>
      </a>`;
  }

  // Paint from the last known answer first. The nav is above the fold on every
  // page, and a control that appears a beat late reads as the page still
  // loading — worse, one that flips from "Sign in" to a handle looks like it
  // signed you in on arrival.
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch (_) {}
  if (cached && cached.handle) renderSignedIn(cached); else renderSignedOut();

  (async () => {
    let me = null;
    try {
      const token = localStorage.getItem(TOKEN_KEY);
      const res = await fetch(API + '/api/me', {
        credentials: 'include',
        headers: token ? { Authorization: 'Bearer ' + token } : {},
      });
      if (!res.ok) return;              // transient: keep whatever is on screen
      me = await res.json();
    } catch (_) {
      return; // offline or blocked — the cached control stays, and it is honest
    }

    if (me && me.signedIn) {
      renderSignedIn(me);
      try { localStorage.setItem(CACHE_KEY, JSON.stringify({ handle: me.handle, avatarUrl: me.avatarUrl })); } catch (_) {}
    } else {
      // A definite signed-out answer is the one thing that may clear the cache.
      renderSignedOut();
      try { localStorage.removeItem(CACHE_KEY); } catch (_) {}
    }
  })();
})();
