/* PaperTrench — Live on Twitch page.
 *
 * The roster is the hand-maintained STREAMERS list below, plus every
 * application a moderator approved in site/admin.html (read from the Worker's
 * /api/streamer/roster). A legacy Google-Sheet CSV is still honoured for
 * deployments that ran on one, but nothing new needs it. Neither remote source
 * can break the page: on any failure the hand-maintained list stands alone.
 * Full setup walkthrough: docs/STREAMS.md.
 */
(() => {
  'use strict';

  /* ------------------------------------------------------------------ *
   *  CONFIG — edit this block when streamers sign up                     *
   * ------------------------------------------------------------------ */

  // Hand-maintained roster. Entries here always show, and they win over a
  // sheet row with the same login — useful for pinning or fixing a blurb.
  // `login` is the Twitch login and means "embeddable inline". Kick and
  // YouTube entries carry `platform` + `channelUrl` instead and render as
  // link-out cards — there is no login to invent for a player we cannot mount.
  const STREAMERS = [
    {
      login: 'onlyterp',                 // twitch.tv/<login> — lowercase
      name: 'OnlyTerp',                  // display name on the card
      blurb: 'Builds PaperTrench and trades the same paper wallet as everyone else — live launches, real charts, zero real money.',
    },
    {
      login: 'profitabledegen',          // twitch.tv/<login> — lowercase
      name: 'ProfitableDegen',           // display name on the card
      blurb: 'Unhinged trencher from NYC, streaming the challenge daily.',
    },
    {
      login: 'chillygmi',                // twitch.tv/<login> — lowercase
      name: 'Chillygmi',                 // display name on the card
      blurb: 'Heavy 2024–25 memecoin trader documenting the comeback run on TikTok and Twitch.',
    },
    {
      login: 'plahstickk',               // twitch.tv/<login> — lowercase
      name: 'plahstickk',                // display name on the card
      blurb: 'Weekend challenge runs — fresh eyes on the trenches.',
    },
  ];

  // Where "Sign up as a streamer" points — the on-site form, which posts to
  // the leaderboard Worker and lands in the moderator queue (site/admin.html).
  const SIGNUP_URL = '/streamer-signup';

  // The API roster: every application a moderator approved in site/admin.html.
  // This is the pipeline the signup form feeds, and it needs no configuration —
  // approving a streamer publishes their card within the 60s edge cache.
  const API = 'https://papertrench-api.onerobby.workers.dev';

  // Legacy approval-sheet roster (optional, and superseded by the API above).
  // Paste the "Publish to web → CSV" URL of a Google Sheet and the page pulls
  // every row whose Approved column says yes. Empty string disables it; on any
  // fetch/parse failure the page just runs on STREAMERS above. Kept so a
  // deployment already running on a sheet does not lose its roster on upgrade.
  const ROSTER_CSV_URL = '';

  const LIVE_POLL_MS = 60000;

  /* ------------------------------------------------------------------ */

  // Twitch embeds require the hosting domain as `parent`. Deriving it from
  // location works on papertrench.com, the github.io mirror, and localhost
  // alike. file:// has no hostname — embeds are replaced by plain links.
  const PARENT = location.hostname;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  /* ---------- drawn marks ----------
   * Emoji render as a different typeface per platform and carry an OS-level
   * colour we cannot theme, which is exactly wrong for a page whose job is to
   * look considered. These inherit currentColor and scale with the layout. */
  const MARK_CAMERA =
    '<svg class="mark" width="38" height="38" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="2" y="6" width="13" height="12" rx="2.5"/>' +
    '<path d="M15 10.5 22 7v10l-7-3.5z"/></svg>';
  const MARK_EXTERNAL =
    '<svg class="mark" width="34" height="34" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M14 4h6v6M20 4l-9 9"/>' +
    '<path d="M18 14v5a1.8 1.8 0 0 1-1.8 1.8H5.2A1.8 1.8 0 0 1 3.4 19V7.8A1.8 1.8 0 0 1 5.2 6H10"/></svg>';
  const MARK_PLAY =
    '<span class="s-play" aria-hidden="true">' +
    '<svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor">' +
    '<path d="M8 5.6v12.8a.7.7 0 0 0 1.07.6l10-6.4a.7.7 0 0 0 0-1.2l-10-6.4A.7.7 0 0 0 8 5.6z"/>' +
    '</svg></span>';

  const MARK_OUT =
    '<span class="s-play out" aria-hidden="true">' +
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M14 4.5h5.5V10M19.5 4.5 11 13"/>' +
    '<path d="M17.5 14v4.6a1.6 1.6 0 0 1-1.6 1.6H5.9a1.6 1.6 0 0 1-1.6-1.6V8.1A1.6 1.6 0 0 1 5.9 6.5h4.6"/>' +
    '</svg></span>';

  /* ---------- platforms ----------
   *
   * Only Twitch can be embedded, so only Twitch cards act as a player button.
   * The rest are links, and are drawn as links — a card that looks identical
   * to a playable one but silently opens a new tab teaches the visitor that
   * the whole grid is unpredictable. Live/offline is a Twitch-only signal too
   * (it comes from Twitch's preview CDN), so the other platforms show their
   * platform name where the badge would be rather than a guessed status.
   */
  const PLATFORMS = {
    twitch: {
      label: 'Twitch', host: 'twitch.tv/', embeddable: true,
      url: (s) => 'https://twitch.tv/' + encodeURIComponent(s.login),
    },
    kick: {
      label: 'Kick', host: 'kick.com/', embeddable: false,
      url: (s) => s.channelUrl,
    },
    youtube: {
      label: 'YouTube', host: 'youtube.com/', embeddable: false,
      url: (s) => s.channelUrl,
    },
    other: {
      label: 'Stream', host: '', embeddable: false,
      url: (s) => s.channelUrl,
    },
  };

  const platformOf = (s) => PLATFORMS[s && s.platform] || PLATFORMS.twitch;

  /** The href a card points at, or null when there is nothing safe to link. */
  function channelHref(s) {
    const spec = platformOf(s);
    if (spec.embeddable) return s.login ? spec.url(s) : null;
    const raw = spec.url(s);
    if (!raw) return null;
    // The roster is server-normalized, but this is the point where a string
    // becomes an href a visitor clicks. Re-check the scheme rather than
    // trusting the trip it took to get here.
    try {
      const url = new URL(String(raw));
      return (url.protocol === 'https:' || url.protocol === 'http:') ? url.toString() : null;
    } catch { return null; }
  }

  /** What to print under the name: "twitch.tv/name", or the bare host+path. */
  function channelLabel(s) {
    const spec = platformOf(s);
    if (spec.embeddable && s.login) return spec.host + s.login;
    const href = channelHref(s);
    if (!href) return spec.label;
    return href.replace(/^https?:\/\//i, '').replace(/^www\./i, '').replace(/\/$/, '');
  }

  /* ---------- scroll reveal (same behaviour as main.js) ---------- */
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    }
  }, { threshold: 0.12 });
  document.querySelectorAll('.reveal').forEach((el) => io.observe(el));

  /* ---------- state ---------- */
  const live = new Map();       // login -> true | false | null (unknown)
  let roster = [...STREAMERS];  // manual entries + approved sheet rows

  /** Identity for dedupe: a Twitch login, else the channel it points at. */
  const keyOf = (s) => (s.login ? 'twitch:' + s.login : 'url:' + String(s.channelUrl || '').toLowerCase());
  let featured = null;          // login currently in the big player
  let userPinned = false;       // stop auto-promotion once the viewer chose

  $('signupBtn').href = SIGNUP_URL;

  /* ---------- chat show/hide (desktop) ---------- */
  let chatHidden = false;
  try { chatHidden = localStorage.getItem('pt_chat_hidden') === '1'; } catch (_) {}
  function applyChatPref() {
    document.querySelector('.player-grid').classList.toggle('no-chat', chatHidden);
    $('chatToggle').textContent = chatHidden ? 'Show chat' : 'Hide chat';
  }
  $('chatToggle').addEventListener('click', () => {
    chatHidden = !chatHidden;
    try { localStorage.setItem('pt_chat_hidden', chatHidden ? '1' : '0'); } catch (_) {}
    applyChatPref();
  });
  applyChatPref();

  /* ---------- approval-sheet roster ----------
   * The sheet is the approval screen: form responses land as rows, and a row
   * ships the moment its Approved cell says yes. Published CSVs refresh on
   * Google's side within ~5 minutes of an edit. */

  // Minimal CSV parser that survives quoted fields with commas and newlines.
  function parseCsv(text) {
    const rows = [[]];
    let field = '', inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (c === '"') inQuotes = false;
        else field += c;
      } else if (c === '"') inQuotes = true;
      else if (c === ',') { rows[rows.length - 1].push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        rows[rows.length - 1].push(field); field = '';
        rows.push([]);
      } else field += c;
    }
    rows[rows.length - 1].push(field);
    return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
  }

  // "https://twitch.tv/SomeName", "@somename", "somename" -> "somename"
  function normalizeLogin(raw) {
    let s = String(raw || '').trim().toLowerCase();
    if (!s) return null;
    s = s.replace(/^@/, '');
    const m = s.match(/twitch\.tv\/([a-z0-9_]+)/);
    if (m) s = m[1];
    // Trim URL remnants only — anything else (spaces, punctuation) must fail
    // the test below, not get salvaged into a plausible-looking login.
    s = s.split(/[/?#]/)[0];
    return /^[a-z0-9_]{3,25}$/.test(s) ? s : null;
  }

  function findCol(headers, ...needles) {
    return headers.findIndex((h) => needles.some((n) => h.includes(n)));
  }

  /**
   * Approved applications from the Worker.
   *
   * Same contract as the sheet loader below: enhancement, never load-bearing.
   * A dead API leaves the hand-maintained STREAMERS list on the page rather
   * than emptying the roster — an empty grid would state "nobody streams this"
   * on the strength of a failed fetch.
   */
  async function loadApiRoster() {
    try {
      const res = await fetch(API + '/api/streamer/roster', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const body = await res.json();
      if (!body || !body.ok || !Array.isArray(body.streamers)) return;

      const seen = new Set(roster.map((s) => keyOf(s)));
      for (const row of body.streamers) {
        if (!row) continue;
        // The server normalizes these, but the page owns what it renders:
        // re-run the same login rule rather than trusting the shape.
        const login = normalizeLogin(row.login);
        const platform = PLATFORMS[row.platform] ? row.platform : (login ? 'twitch' : 'other');
        const entry = {
          login: login || null,
          platform,
          channelUrl: String(row.channelUrl || '').trim() || null,
          name: String(row.name || '').trim() || login || '',
          blurb: String(row.blurb || '').trim(),
        };
        // An entry we can neither embed nor link is not a card, it is a
        // name with nowhere to go — drop it rather than render a dead tile.
        if (!entry.login && !channelHref(entry)) continue;
        if (!entry.name) continue;
        const key = keyOf(entry);
        if (seen.has(key)) continue;
        seen.add(key);
        roster.push(entry);
      }
    } catch (err) {
      console.warn('PaperTrench: roster API unavailable —', err.message);
    }
  }

  async function loadSheetRoster() {
    if (!ROSTER_CSV_URL) return;
    try {
      const res = await fetch(ROSTER_CSV_URL, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const rows = parseCsv(await res.text());
      if (rows.length < 2) return;
      const headers = rows[0].map((h) => h.trim().toLowerCase());
      const colApproved = findCol(headers, 'approv', 'status');
      const colLogin = findCol(headers, 'twitch', 'channel', 'login', 'handle');
      const colName = headers.findIndex((h, i) => i !== colLogin && h.includes('name'));
      const colBlurb = findCol(headers, 'blurb', 'about', 'bio', 'describe', 'description');
      if (colApproved < 0 || colLogin < 0) throw new Error('sheet is missing an Approved or Twitch column');

      const seen = new Set(roster.map((s) => s.login));
      for (const row of rows.slice(1)) {
        const ok = /^(yes|y|true|1|x|approved|✓)$/i.test((row[colApproved] || '').trim());
        const login = normalizeLogin(row[colLogin]);
        if (!ok || !login || seen.has(login)) continue;
        seen.add(login);
        roster.push({
          login,
          name: (colName >= 0 && row[colName] || '').trim() || login,
          blurb: (colBlurb >= 0 && row[colBlurb] || '').trim(),
        });
      }
    } catch (err) {
      // The roster sheet is enhancement, not load-bearing: fall back silently
      // to the hand-maintained list rather than breaking the page.
      console.warn('PaperTrench: roster sheet unavailable —', err.message);
    }
  }

  /* ---------- live detection ----------
   * No Twitch API key on a static page, so we lean on the public preview CDN:
   * a live channel's thumbnail resolves normally, an offline one redirects to
   * Twitch's 404_preview image. If the CDN ever stops sending CORS headers
   * this degrades to "unknown" and the page simply shows no live badges. */
  async function isLive(login) {
    try {
      const r = await fetch(
        `https://static-cdn.jtvnw.net/previews-ttv/live_user_${encodeURIComponent(login)}-80x45.jpg?t=${Date.now()}`,
        { mode: 'cors', cache: 'no-store' }
      );
      if (!r.ok) return null;
      return !r.url.includes('404_preview');
    } catch (_) { return null; }
  }

  function thumbUrl(login) {
    return `https://static-cdn.jtvnw.net/previews-ttv/live_user_${encodeURIComponent(login)}-440x248.jpg?t=${Math.floor(Date.now() / LIVE_POLL_MS)}`;
  }

  function initials(name) {
    return name.split(/\s+/).map((w) => w[0] || '').join('').slice(0, 2).toUpperCase() || '?';
  }

  /* ---------- featured player ---------- */
  function renderFeatured() {
    const frame = $('playerFrame');
    const bar = $('playerBar');
    const chatShell = $('chatShell');

    if (!featured) {
      bar.style.display = 'none';
      chatShell.style.display = 'none';
      frame.innerHTML = `
        <div class="player-empty">
          <div class="inner">
            ${MARK_CAMERA}
            <h3>The roster is forming</h3>
            <p>Streamer applications for the PaperTrench Challenge are open. The
            first live runs land right here — and if you stream, that could be
            you. <a href="/streamer-signup">Apply for the roster</a>.</p>
          </div>
        </div>`;
      return;
    }

    const s = roster.find((x) => x.login === featured);
    const login = esc(featured);
    $('playerWho').textContent = s ? s.name : featured;
    $('playerHandle').textContent = 'twitch.tv/' + featured;
    $('playerOut').href = 'https://twitch.tv/' + encodeURIComponent(featured);
    bar.style.display = '';

    if (!PARENT) {
      // Opened from disk — Twitch refuses embeds without a parent domain.
      chatShell.style.display = 'none';
      frame.innerHTML = `
        <div class="player-empty">
          <div class="inner">
            ${MARK_EXTERNAL}
            <h3>Embeds need a web origin</h3>
            <p>Open this page from papertrench.com (or localhost) to watch inline,
            or head straight to <a href="https://twitch.tv/${login}" target="_blank" rel="noopener">twitch.tv/${login}</a>.</p>
          </div>
        </div>`;
      return;
    }

    frame.innerHTML = `<iframe
      src="https://player.twitch.tv/?channel=${encodeURIComponent(featured)}&parent=${encodeURIComponent(PARENT)}&muted=true&autoplay=true"
      allowfullscreen allow="autoplay; fullscreen"
      title="Twitch stream: ${login}"></iframe>`;
    chatShell.style.display = '';
    $('chatFrame').innerHTML = `<iframe
      src="https://www.twitch.tv/embed/${encodeURIComponent(featured)}/chat?parent=${encodeURIComponent(PARENT)}&darkpopout"
      title="Twitch chat: ${login}"></iframe>`;
  }

  function setFeatured(login, { pinned = false, scroll = false } = {}) {
    if (pinned) userPinned = true;
    if (featured === login) return;
    featured = login;
    renderFeatured();
    if (scroll) $('watch').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ---------- roster grid ---------- */

  // Intentional-looking empty slot instead of a half-empty row. The grid is
  // three-up, so we pad to a full row while the roster is still forming.
  const OPEN_SLOTS = 3;
  function openSlot() {
    return `
        <a class="s-card open" href="${esc(SIGNUP_URL)}">
          <div class="s-thumb"><div class="ph">+</div></div>
          <div class="s-body">
            <div class="s-name">Your stream here</div>
            <div class="s-handle">twitch.tv/you</div>
            <div class="s-blurb">An open slot on the challenge roster. Applications are reviewed by hand.</div>
          </div>
        </a>`;
  }

  /* The order the grid is read in.
   *
   * Live first, so a visitor who came to watch something lands on something
   * watchable; embeddable before link-out inside each band, because a card
   * that plays here is a better first click than one that leaves the site;
   * then name, so two loads of a quiet board never disagree about order.
   *
   * There is deliberately no viewer-count sort: the live signal comes from
   * Twitch's public preview CDN, which reports whether a channel is up and
   * nothing else. Ranking by a number we do not have would mean inventing
   * one, and a made-up "top stream" is exactly the kind of claim this site
   * refuses everywhere else.
   */
  function orderedRoster() {
    const rank = (s) => {
      if (live.get(s.login) === true) return 0;     // live now
      if (platformOf(s).embeddable) return 1;       // playable, currently off
      return 2;                                     // link-out
    };
    return [...roster].sort((a, b) =>
      rank(a) - rank(b) || String(a.name).localeCompare(String(b.name)));
  }

  function renderGrid() {
    const grid = $('streamerGrid');

    const cards = orderedRoster().map((s) => {
      const spec = platformOf(s);
      const href = channelHref(s);
      const status = spec.embeddable ? live.get(s.login) : undefined;
      const isUp = status === true;

      // Live/offline is a Twitch-only fact. Off Twitch the slot names the
      // platform instead of guessing a status we cannot observe.
      const badge = isUp
        ? '<span class="s-live on"><span class="dot"></span>LIVE</span>'
        : status === false
          ? '<span class="s-live off">OFFLINE</span>'
          : `<span class="s-live plat ${esc(s.platform || 'twitch')}">${esc(spec.label)}</span>`;

      const thumb = isUp
        ? `<img src="${thumbUrl(s.login)}" alt="Live preview of ${esc(s.name)}" loading="lazy">`
        : `<div class="ph">${esc(initials(s.name))}</div>`;

      const body = (handleLine) => `
          <div class="s-body">
            <div class="s-name">${esc(s.name)}</div>
            ${handleLine}
            ${s.blurb ? `<div class="s-blurb">${esc(s.blurb)}</div>` : ''}
          </div>`;

      // Embeddable → a card that mounts the player, with the channel line as
      // its own link so reaching someone's actual channel does not mean
      // promoting them into the player first (two clicks and a scroll for
      // what is just a URL). stopPropagation keeps it from doing both.
      if (spec.embeddable && s.login) {
        const handleLine = href
          ? `<a class="s-handle" href="${esc(href)}" target="_blank" rel="noopener"
               data-out title="Open ${esc(channelLabel(s))}">${esc(channelLabel(s))} ↗</a>`
          : `<span class="s-handle">${esc(channelLabel(s))}</span>`;
        return `
        <div class="s-card" data-login="${esc(s.login)}" role="button" tabindex="0"
             title="Watch ${esc(s.name)} here">
          <div class="s-thumb">${thumb}${badge}${MARK_PLAY}</div>
          ${body(handleLine)}
        </div>`;
      }

      // Link-out → the WHOLE card is the anchor, so the channel line must be
      // a span. An <a> inside an <a> is not nestable markup: the parser closes
      // the outer one early and splits a single card into two broken tiles.
      return `
        <a class="s-card link" href="${esc(href)}" target="_blank" rel="noopener"
           title="Open ${esc(s.name)} on ${esc(spec.label)}">
          <div class="s-thumb">${thumb}${badge}${MARK_OUT}</div>
          ${body(`<span class="s-handle">${esc(channelLabel(s))} ↗</span>`)}
        </a>`;
    });

    while (cards.length < OPEN_SLOTS) cards.push(openSlot());
    grid.innerHTML = cards.join('');

    // The channel link must not also trigger the card behind it.
    grid.querySelectorAll('a[data-out]').forEach((a) => {
      a.addEventListener('click', (e) => e.stopPropagation());
    });

    grid.querySelectorAll('.s-card[data-login]').forEach((card) => {
      const open = () => setFeatured(card.dataset.login, { pinned: true, scroll: true });
      card.addEventListener('click', open);
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
    });
  }

  /* ---------- live badge refresh loop ---------- */
  async function refreshLive() {
    if (!roster.length) return;
    // Only Twitch has a live signal; asking the preview CDN about a Kick
    // login would answer about a Twitch channel of the same name.
    const checkable = roster.filter((s) => platformOf(s).embeddable && s.login);
    await Promise.all(checkable.map(async (s) => live.set(s.login, await isLive(s.login))));

    const liveCount = checkable.filter((s) => live.get(s.login) === true).length;
    $('liveCountLabel').textContent = liveCount > 0
      ? `${liveCount} streamer${liveCount === 1 ? '' : 's'} live right now`
      : 'The PaperTrench Challenge';
    // The pill only goes red when something is genuinely live — a permanently
    // red "LIVE" dot on an empty roster is the cheapest kind of lie.
    $('liveCount').classList.toggle('on', liveCount > 0);

    // Put a live channel in the player unless the viewer picked one themself.
    // orderedRoster() already sorts live to the front, so its first entry IS
    // the one to feature — and when exactly one channel is live, that is the
    // channel, which is the behaviour a single streamer should get for free.
    if (!userPinned) {
      const firstLive = orderedRoster().find((s) => live.get(s.login) === true);
      if (firstLive && live.get(featured) !== true) setFeatured(firstLive.login);
    }
    renderGrid();
  }

  /* ---------- boot ---------- */
  async function boot() {
    const requested = normalizeLogin(new URLSearchParams(location.search).get('channel'));

    const pickFeatured = () => {
      if (requested && roster.some((s) => s.login === requested)) {
        userPinned = true;
        featured = requested;
      } else if (!featured) {
        // Only an embeddable entry can go in the player; a Kick card at the
        // top of the order must not blank the player out.
        const first = orderedRoster().find((s) => platformOf(s).embeddable && s.login);
        if (first) featured = first.login;
      }
    };

    // Fast paint from the hand-maintained list, then fold in the sheet.
    pickFeatured();
    renderFeatured();
    renderGrid();

    const before = `${featured}:${roster.length}`;
    // Both are optional and independent; neither can fail the page.
    await Promise.all([loadApiRoster(), loadSheetRoster()]);
    pickFeatured();
    if (`${featured}:${roster.length}` !== before) {
      renderFeatured();
      renderGrid();
    }

    refreshLive();
    setInterval(refreshLive, LIVE_POLL_MS);
  }

  boot();
})();
