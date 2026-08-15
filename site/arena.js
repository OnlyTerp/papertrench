/* PaperTrench site — the Arena client.
 *
 * Talks to the API worker (api.papertrench.com) and, when the user clicks
 * Sync, to the extension over the externally_connectable bridge.
 *
 * The honesty rules from the product carry over verbatim: every number
 * rendered here came from the server's replay of a verified chain or it is
 * not rendered. No invented rows, no placeholder standings, no filler while
 * loading — a skeleton or an empty state instead. Unreachable says
 * unreachable.
 */
(() => {
  'use strict';

  // The site is on GitHub Pages with DNS at GoDaddy, so Cloudflare cannot
  // route api.papertrench.com without moving the whole domain's nameservers.
  // The API therefore answers on its workers.dev subdomain, which makes it
  // CROSS-site to these pages — hence SameSite=None session cookies and an
  // Origin allowlist enforced on every state-changing request server-side.
  const API = 'https://papertrench-api.onerobby.workers.dev';

  /**
   * Is the verifier deployed yet?
   *
   * Flip to true in the same change that deploys the Worker
   * (server/DEPLOY.md). Until then the Arena pages must not say the server is
   * "unreachable": that describes a service that exists and is down, and
   * claiming an outage we are not having is the same class of wrong number
   * this product refuses to print. Pre-launch is a different fact and gets
   * different words.
   *
   * This is a build-time flag rather than a probe on purpose — once the
   * Arena IS live, a failed request genuinely does mean an outage, and the
   * two states must never be conflated in either direction.
   */
  const API_LIVE = true;
  // The stable id the Chrome Web Store assigns the published extension.
  // Unpacked developer installs get per-machine ids the site cannot know —
  // those users use the exported-file path instead (server/DEPLOY.md).
  const EXTENSION_IDS = ['REPLACE_WITH_CWS_EXTENSION_ID'];

  /* ------------------------------------------------------------ format -- */

  const esc = (t) => String(t == null ? '' : t)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function fmt(n, digits) {
    const value = Number(n);
    if (!Number.isFinite(value)) return '—';
    return value.toLocaleString('en-US', {
      minimumFractionDigits: digits, maximumFractionDigits: digits,
    });
  }

  function signed(n, digits, suffix) {
    const value = Number(n);
    if (!Number.isFinite(value)) return '—';
    return (value >= 0 ? '+' : '') + fmt(value, digits) + (suffix || '');
  }

  const dirClass = (n) => (Number(n) >= 0 ? 'up' : 'down');

  /** "3m ago" / "2h ago" — short enough for a stream line. */
  function ago(ts) {
    const seconds = Math.max(0, (Date.now() - Number(ts)) / 1000);
    if (seconds < 60) return Math.floor(seconds) + 's ago';
    if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
    if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
    return Math.floor(seconds / 86400) + 'd ago';
  }

  function initials(handle) {
    return String(handle || '??').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || '??';
  }

  // Deterministic per-handle tint, so a trader keeps the same colour on every
  // surface and you learn to spot your rival by eye.
  const TONES = [
    ['rgba(255,157,69,.18)', 'var(--orange2)'],
    ['rgba(106,169,255,.18)', 'var(--blue)'],
    ['rgba(167,139,250,.18)', 'var(--violet)'],
    ['rgba(52,211,153,.18)', 'var(--green)'],
    ['rgba(224,67,58,.18)', '#ff8a80'],
    ['rgba(207,216,230,.16)', 'var(--silver)'],
  ];
  function tone(handle) {
    let hash = 0;
    const text = String(handle || '');
    for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
    return TONES[hash % TONES.length];
  }

  function face(entry, className) {
    const cls = className || 'ar-face';
    if (entry && entry.avatarUrl) {
      return `<span class="${cls}"><img src="${esc(entry.avatarUrl)}" alt="" loading="lazy"
        referrerpolicy="no-referrer"></span>`;
    }
    const [bg, fg] = tone(entry && entry.handle);
    return `<span class="${cls}" style="background:${bg};color:${fg}">${esc(initials(entry && entry.handle))}</span>`;
  }

  /* --------------------------------------------------------------- clans */

  /**
   * The [TAG] chip that rides beside a handle on every board.
   *
   * Returns an empty string when the trader is in no clan — deliberately not a
   * placeholder chip. An em dash where a clan would be reads as "unaffiliated"
   * to a designer and as a clan called "—" to everyone else.
   */
  function clanTag(tag, options) {
    if (!tag) return '';
    const opts = options || {};
    // The display floor applies here too: this chip rides beside handles on
    // every board, so a masked clan must not print its tag anywhere.
    if (clanLabelBlocked(tag)) return '';
    const [bg, fg] = tone('clan:' + tag);
    const style = `background:${bg};color:${fg};border-color:transparent`;
    const label = '[' + esc(tag) + ']';
    const title = esc(opts.title || ('Clan ' + tag));
    if (opts.plain) return `<span class="ar-clan-tag" style="${style}" title="${title}">${label}</span>`;
    return `<a class="ar-clan-tag" style="${style}" title="${title}"
      href="clan.html?tag=${encodeURIComponent(tag)}">${label}</a>`;
  }

  /* ------------------------------------------------- clan label floor ---
   *
   * A DISPLAY floor, not the filter. The server's word list
   * (server/core/clan.js) is the real gate and it is deliberately narrow and
   * clever — tokens, suffixes, leet readings — none of which belongs in a
   * browser bundle. This is the layer underneath it: if a spelling slips the
   * list (one did — a clan founded 2026-08-09 carried a respelled slur for
   * three days), no Arena page prints it either.
   *
   * Substrings only, and only the handful the server itself holds in its
   * substring tier because they have no innocent host word in English. That
   * keeps this check false-positive-free by construction rather than by
   * measurement, which matters here: there is no suite under this file, so
   * nothing would catch an over-broad entry refusing a legitimate clan name.
   *
   * Masked, never deleted — the row still renders (its members still exist),
   * and the maintainer's delete is the real backstop.
   */
  const CLAN_LABEL_BLOCKED = ['nigger', 'nigga', 'nigar', 'faggot', 'childporn', 'childrape'];

  /** Does this clan label carry a blocked term? */
  function clanLabelBlocked(raw) {
    let key = String(raw == null ? '' : raw).toLowerCase().replace(/[^a-z0-9]/g, '');
    // The innocent hosts the server carves out of its own substring tier
    // (core/clan.js ALLOWED_SUBSTRINGS). Stripping them first is what keeps
    // "Snigger Squad" passing — its collapsed key contains the base term by
    // accident of spelling. One pass is enough: a real occurrence wrapped in
    // a host ("sniggerniggersquad") survives the strip and still blocks.
    for (const host of ['snigger', 'niggard']) key = key.split(host).join('');
    return CLAN_LABEL_BLOCKED.some((term) => key.includes(term));
  }

  /** A clan name or tag as it may be printed, masked when it carries a
   * blocked term. Same output shape as esc() — a plain string. */
  function clanLabel(raw) {
    const text = String(raw == null ? '' : raw);
    if (clanLabelBlocked(text)) return 'clan-blocked';
    return esc(text);
  }

  /** The tag at crest size, tinted from the same hash as the chip so a clan
   * looks like itself on every surface. */
  function crest(tag, className) {
    const [bg, fg] = tone('clan:' + tag);
    return `<span class="ar-crest ${className || ''}" style="background:${bg};color:${fg}"
      aria-hidden="true">${clanLabel(tag)}</span>`;
  }

  /** "3 of 5" as countable pips, for a clan that has not fielded five yet. */
  function pips(filled, total) {
    const n = Math.max(0, Math.min(Number(total) || 0, Number(filled) || 0));
    return '<span class="ar-pips" aria-hidden="true">' +
      Array.from({ length: Number(total) || 0 }, (_, i) =>
        `<i class="${i < n ? 'on' : ''}"></i>`).join('') + '</span>';
  }

  /* -------------------------------------------------------- verification */

  const CHIP = {
    verified: '<span class="ar-chip verified" title="Every link re-hashed, book replayed, and every fill re-priced against real market history.">✓ Verified</span>',
    pending: '<span class="ar-chip pending" title="Chain re-hashed and replayed. Prices are still being re-checked against market history."><i class="spin"></i>Verifying</span>',
    partial: '<span class="ar-chip partial" title="Chain valid and replayed, but some fills had no public candle data to check against. Shown and labeled, but not ranked — a fill we could not check is not a fill we can rank.">◐ Partial data</span>',
    rejected: '<span class="ar-chip rejected" title="This record failed verification and does not rank.">✕ Rejected</span>',
  };
  const chipFor = (status) => CHIP[status] || CHIP.pending;

  /* ------------------------------------------------------------- network */

  /**
   * The session rides two transports at once: the cross-site cookie (kept
   * for a future same-site deploy) and a bearer token in localStorage. The
   * token is the one that works everywhere — the workers.dev API is
   * cross-site to these pages, and Safari blocks, Firefox partitions, and
   * Brave/incognito Chrome drop third-party cookies, which made a completed
   * sign-in render as signed-out ("the website doesn't read that you made
   * an account", live field report). localStorage over sessionStorage so
   * the sign-in survives the tab; the token expires server-side in 30 days
   * and dies instantly when the account's session epoch bumps.
   */
  const TOKEN_KEY = 'pt_session_token';
  function sessionToken() {
    try { return localStorage.getItem(TOKEN_KEY) || null; } catch { return null; }
  }
  function storeSessionToken(token) {
    try { localStorage.setItem(TOKEN_KEY, token); } catch {}
  }
  function dropSessionToken() {
    try { localStorage.removeItem(TOKEN_KEY); } catch {}
  }

  async function api(path, options) {
    const opts = Object.assign({ credentials: 'include' }, options || {});
    const token = sessionToken();
    if (token) opts.headers = Object.assign({}, opts.headers, { Authorization: 'Bearer ' + token });
    const res = await fetch(API + path, opts);
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  }

  /**
   * GET that throws on anything that is not a 2xx with a body.
   *
   * A caller that reads only `.body` cannot tell a 503 from an empty board:
   * `body.entries` is undefined either way, and the page then states "the
   * board is empty" — an affirmative claim about the world, made while the
   * verifier is unreachable. This is the read path for anything whose absence
   * would be rendered as a fact.
   */
  async function getOrThrow(path) {
    // Pre-launch there is nothing at the other end, so skip the request
    // rather than filling every visitor's console with failed fetches.
    if (!API_LIVE) throw new Error('api not live');
    const { status, body } = await api(path);
    if (status < 200 || status >= 300 || !body) throw new Error('api ' + status);
    return body;
  }

  // The OAuth callback lands here with #authed=<token> (older workers send
  // a bare #authed): the server wrote a session cookie AND handed the same
  // signed token in the fragment for the browsers whose cookie policies
  // drop it. Read once, store, then strip — the fragment never reached any
  // server, and leaving it in the URL would let a copied link hand the
  // session to someone it was never meant for.
  const authReturn = window.location.hash.match(/^#authed(?:=(.+))?$/);
  const returnedFromAuth = Boolean(authReturn);
  if (returnedFromAuth) {
    if (authReturn[1]) storeSessionToken(authReturn[1]);
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  async function me() {
    // `unreachable` is the flag every page already branches on to hide its
    // sign-in button; pre-launch reuses it so no page offers a control that
    // would navigate to a host that does not resolve.
    if (!API_LIVE) return { signedIn: false, unreachable: true };
    try {
      const reply = await api('/api/me');
      const session = reply.body || { signedIn: false };
      // A definite signed-out answer while we were sending a token means
      // the token is dead (30-day expiry, or an epoch bump revoked it).
      // Keep-and-resend would just repeat the same dead claim forever. A
      // non-200 is NOT that answer — a transient server error must never
      // cost a working sign-in.
      if (reply.status === 200 && !session.signedIn && sessionToken()) dropSessionToken();
      // Signed out, but the callback JUST completed: with the bearer
      // transport this should no longer happen — its remaining causes are
      // an old worker (no token in the fragment) plus a cookie the browser
      // refused cross-site. Without this flag that state is pixel-identical
      // to "never signed in", and the page would render a silent lie over a
      // sign-in that worked. `unreachable` stays separate — a dead API is a
      // different fact.
      if (!session.signedIn && returnedFromAuth) session.cookieBlocked = true;
      // Every page calls me() on load, so this is the one place the
      // extension's linked-account chip learns about a live session.
      announceIdentity(session);
      return session;
    }
    catch { return { signedIn: false, unreachable: true }; }
  }

  function signIn() {
    if (!API_LIVE) return;
    window.location.href = API + '/api/auth/x/start';
  }

  async function logout() {
    try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
    // The server clears the cookie; the token is ours to clear. Doing it
    // after the POST so the logout request itself still authenticates.
    dropSessionToken();
    window.location.reload();
  }

  async function submit(payload) {
    try {
      return await api('/api/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch {
      return { status: 0, body: { ok: false, reason: 'server-unreachable' } };
    }
  }

  /* ------------------------------------------------------ extension bridge */

  /**
   * The relay transport: the extension's papertrench.com content script
   * (site-bridge.js) answers the same two bridge requests over postMessage.
   * It exists because the direct path below needs the extension's id, which
   * unpacked installs cannot have — the relay reaches EVERY install, store
   * or zip. Same-window, same-origin, nonce-matched; a missing extension is
   * a clean null after the timeout.
   */
  /* How long each bridge request may take before it reads as "no extension"
   * (DEFECT L-11). A ping is a constant-time echo, so a short fuse is right
   * for it — that is what keeps the arena snappy when the extension truly is
   * absent. get_record is NOT constant-time: the service worker loads the
   * whole journal and hashes every link to build the attestation payload,
   * after a possible cold start. Under the old flat 1500ms fuse, the bigger
   * a trader's record, the more certainly the site told them the extension
   * was not installed — the board silently excluded exactly its most active
   * users, with a message that sent them off to reinstall a working
   * extension. The reply still arrived moments later; nobody was listening.
   */
  const BRIDGE_TIMEOUT_MS = { pt_bridge_ping: 1500, pt_bridge_get_record: 12000 };
  const bridgeTimeout = (message) =>
    (message && BRIDGE_TIMEOUT_MS[message.type]) || 2500;

  function relaySend(message) {
    return new Promise((resolve) => {
      let nonce = '';
      try {
        const bytes = new Uint8Array(12);
        crypto.getRandomValues(bytes);
        nonce = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
      } catch { nonce = String(Date.now()) + Math.random().toString(36).slice(2); }
      const done = (value) => {
        clearTimeout(timer);
        window.removeEventListener('message', onReply);
        resolve(value);
      };
      const onReply = (event) => {
        if (event.source !== window || event.origin !== window.location.origin) return;
        const data = event.data;
        if (!data || data.type !== 'pt_site_bridge_reply' || data.nonce !== nonce) return;
        done(data.reply || null);
      };
      const timer = setTimeout(() => done(null), bridgeTimeout(message));
      window.addEventListener('message', onReply);
      window.postMessage({ type: 'pt_site_bridge', nonce, request: message }, window.location.origin);
    });
  }

  async function bridgeSend(message) {
    // Relay first: it works for every install. The id path stays as the
    // fallback for the store build once EXTENSION_IDS carries the CWS id.
    const viaRelay = await relaySend(message);
    if (viaRelay) return viaRelay;
    return new Promise((resolve) => {
      if (!(window.chrome && chrome.runtime && chrome.runtime.sendMessage)) {
        resolve(null); // not a Chromium browser, or no extension API exposed
        return;
      }
      let settled = 0;
      const finish = (value) => { if (!settled++) resolve(value); };
      const tryId = (index) => {
        if (index >= EXTENSION_IDS.length) { finish(null); return; }
        try {
          chrome.runtime.sendMessage(EXTENSION_IDS[index], message, (response) => {
            if (chrome.runtime.lastError || !response) { tryId(index + 1); return; }
            finish(response);
          });
        } catch { tryId(index + 1); }
      };
      tryId(0);
      setTimeout(() => finish(null), bridgeTimeout(message));
    });
  }

  const bridgePing = () => bridgeSend({ type: 'pt_bridge_ping' });
  const bridgeGetRecord = () => bridgeSend({ type: 'pt_bridge_get_record' });

  /**
   * Tell the extension (when present) who this browser is signed in as, so
   * the dashboard's "Linked account" chip goes green on its own instead of
   * waiting for a hand-typed handle that can never verify locally (field
   * report: sign-in "only takes me to the website"). Fire-and-forget and
   * display-only — the extension stores the handle, never calls the server,
   * and the board still goes by the site's word alone.
   */
  function announceIdentity(session) {
    if (!session || !session.signedIn || !session.handle) return;
    try {
      window.postMessage({ type: 'pt_site_identity', handle: String(session.handle) }, window.location.origin);
    } catch {}
  }

  /* --------------------------------------------------------- rank deltas */
  /*
   * The server keeps no positional history, so a "▲2" against some global
   * yesterday would be invented. What IS knowable is where these handles sat
   * the last time YOU loaded the board — so that is exactly what this shows,
   * labeled as such. First visit shows nothing rather than a fabricated zero.
   */
  const SNAPSHOT_KEY = 'pt_board_positions_v1';

  function readSnapshot(board) {
    try {
      const all = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) || '{}');
      return all[board] || null;
    } catch { return null; }
  }

  function writeSnapshot(board, entries) {
    try {
      const all = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) || '{}');
      const positions = {};
      entries.forEach((entry, index) => { positions[entry.handle] = index; });
      all[board] = { at: Date.now(), positions };
      localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(all));
    } catch { /* private mode: deltas simply never appear */ }
  }

  function deltaCell(snapshot, handle, index) {
    if (!snapshot || !snapshot.positions) return '<span class="delta flat">·</span>';
    const was = snapshot.positions[handle];
    if (was === undefined) return '<span class="delta up" title="New on the board since your last visit">NEW</span>';
    const moved = was - index;
    if (moved === 0) return '<span class="delta flat">·</span>';
    const cls = moved > 0 ? 'up' : 'down';
    const arrow = moved > 0 ? '▲' : '▼';
    return `<span class="delta ${cls}" title="Moved ${Math.abs(moved)} since your last visit">${arrow}${Math.abs(moved)}</span>`;
  }

  /* ------------------------------------------------------------- pieces  */

  function skeleton(rows) {
    const lines = Array.from({ length: rows || 5 }, () => '<div class="line"></div>').join('');
    return `<div class="ar-skel" aria-busy="true" aria-label="Loading standings">${lines}</div>`;
  }

  function empty(mark, title, body) {
    return `<div class="ar-empty"><div class="mark">${mark}</div>
      <h4>${esc(title)}</h4><p>${body}</p></div>`;
  }

  function errorState(body) {
    // Pre-launch the caller's copy is discarded on purpose: every page words
    // its own outage message, and none of them are true before the verifier
    // has ever run. One accurate sentence beats five well-written wrong ones.
    if (!API_LIVE) {
      return `<div class="ar-empty"><div class="mark">⛓</div>
        <h4>The Arena hasn't opened yet.</h4>
        <p>The verifier that replays and re-prices every record isn't deployed yet, so there is
        nothing to show here — not an outage, just a thing that hasn't started. The extension is
        already committing your fills to the chain, so whatever you trade between now and opening
        day counts: nothing has to be reconstructed later.</p></div>`;
    }
    return `<div class="ar-empty error"><div class="mark">⚠</div>
      <h4>Can't reach the verifier</h4><p>${body}</p></div>`;
  }

  /**
   * Pre-launch notice, placed once at the top of an Arena page.
   *
   * The per-pane states above explain the local absence; this explains the
   * page. Injected from here so a single flag governs every surface and no
   * page can be forgotten when the Arena opens.
   */
  function mountPreLaunchBanner() {
    if (API_LIVE) return;
    const hero = document.querySelector('.ar-hero .wrap');
    if (!hero || document.getElementById('ar-prelaunch')) return;
    const note = document.createElement('div');
    note.id = 'ar-prelaunch';
    note.setAttribute('role', 'note');
    note.innerHTML = `<strong>Opening soon.</strong> Everything here is built and tested, but the
      verifier isn't deployed yet — so there are no standings to show and sign-in is closed. Your
      extension is already hash-committing every fill, so the record you build now is the record
      that ranks on day one.`;
    hero.insertBefore(note, hero.firstChild);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountPreLaunchBanner);
  } else {
    mountPreLaunchBanner();
  }

  /** Score contribution split, for the formula bar. */
  function scoreTerms(stats) {
    const rounds = Number(stats.rounds) || 0;
    const reps = Math.log(1 + rounds);
    const discipline = Math.max(0.25,
      1 - 0.5 * (Number(stats.revengeRatio) || 0) - 0.25 * (Number(stats.maxDrawdown) || 0));
    return { roiPct: Number(stats.roiPct) || 0, reps, rounds, discipline };
  }

  function formulaHtml(stats) {
    const t = scoreTerms(stats);
    return `<div class="ar-formula">
      <span class="term roi">${esc(fmt(t.roiPct, 1))}%<small>return</small></span>
      <span class="op">×</span>
      <span class="term reps">${esc(fmt(t.reps, 2))}<small>ln(1+${esc(String(t.rounds))})</small></span>
      <span class="op">×</span>
      <span class="term disc">${esc(fmt(t.discipline, 3))}<small>discipline</small></span>
      <span class="op">=</span>
      <span class="out">${esc(fmt(Number(stats.score) || 0, 1))}</span>
    </div>`;
  }

  /** Tier-coloured initials for the compact badge strip. Board payloads carry
   * {id, name, tier} only; the full evidence lives on the profile. */
  function badgeChips(badges, limit) {
    const list = (badges || []).slice(0, limit || 4);
    if (!list.length) return '';
    return '<span class="ar-badge-row">' + list.map((b) =>
      `<i class="ar-badge-mini t-${esc(b.tier)}" title="${esc(b.name)}" aria-label="${esc(b.name)}"
        >${esc(String(b.name || '?').slice(0, 1))}</i>`
    ).join('') + '</span>';
  }

  /* ----------------------------------------------------------- readout --- */
  /*
   * Headline figures SETTLE rather than count up.
   *
   * A counter sweeping from zero renders a series of numbers that were never
   * true, next to a real trader's handle, on pages built to be screenshotted —
   * and a screenshot caught mid-sweep is a false record of someone's results.
   * So the true value is in the DOM from the first paint and only its
   * presentation animates: a short blur-and-rise that reads as the figure
   * locking in, with nothing to misread at any frame.
   */
  function countUp(el, to, digits, suffix) {
    // A non-finite target must read as absent, never as "+NaN".
    if (!Number.isFinite(Number(to))) { el.textContent = '—'; return; }
    el.textContent = (to >= 0 ? '+' : '') + fmt(to, digits) + (suffix || '');
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    el.classList.remove('ar-settle');
    // Reflow so the class re-applies when a board repaints in place.
    void el.offsetWidth;
    el.classList.add('ar-settle');
  }

  window.PTArena = {
    API, API_LIVE, EXTENSION_IDS,
    esc, fmt, signed, dirClass, ago, initials, tone, face,
    clanTag, crest, pips, clanLabel,
    CHIP, chipFor,
    api, getOrThrow, me, signIn, logout, submit,
    bridgePing, bridgeGetRecord,
    readSnapshot, writeSnapshot, deltaCell,
    skeleton, empty, errorState,
    scoreTerms, formulaHtml, badgeChips, countUp,
  };
})();
