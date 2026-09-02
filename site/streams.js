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
  // `login` is the Twitch login. Kick and YouTube entries carry `platform` +
  // `channelUrl`; what can be mounted from that is decided per platform in
  // PLATFORMS below, not by the presence of a Twitch login.
  //
  // YouTube is the one platform that needs more than a channel URL: the embed
  // keys off the UC… channel id, which cannot be derived from a /@handle URL
  // without the Data API. Give such an entry an explicit `channelId` (copy it
  // from the channel's "Share channel → Copy channel ID"), or leave it off and
  // accept a link-out card.
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
    {
      login: 'zurp52',                   // twitch.tv/<login> — lowercase
      name: 'Zurp52',                    // display name on the card
      blurb: 'Streaming PaperTrench on a regular schedule.',
    },
    {
      // Kick: plays inline. `login` stays absent on purpose — it is the Twitch
      // login, and inventing one would mount a dead Twitch player. The Kick
      // slug is read from channelUrl.
      name: 'Ark1317',
      platform: 'kick',
      channelUrl: 'https://kick.com/ark1317',
      blurb: 'PaperTrench streamer on Kick.',
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
   * Two capabilities, deliberately separate, because they are not the same
   * question and the platforms disagree about them:
   *
   *   embeddable — can a player be mounted on this page at all?
   *   liveSignal — can live/offline be OBSERVED without a server-side key?
   *
   * They used to be one flag, which forced an all-or-nothing call on YouTube:
   * either claim a live status nothing can back, or refuse to play a stream
   * that embeds perfectly well. Splitting them lets each platform be handled
   * for what it actually supports (verified live from this origin, 2026-08-26):
   *
   *   Twitch  embed + live. Live comes from the public preview CDN.
   *   Kick    embed + live. player.kick.com mounts, and kick.com/api/v2 answers
   *           a cross-origin fetch with CORS headers — livestream:null offline,
   *           a livestream object (with a real thumbnail) when live.
   *   YouTube embed only. /embed/live_stream?channel=<UC id> always mounts the
   *           channel's current broadcast without a key, but NOTHING key-free
   *           reports whether that broadcast exists: the channel /live page and
   *           the RSS feed are both CORS-blocked, and oEmbed 404s on the
   *           live_stream URL. Real status needs a Data API key this static
   *           site has nowhere to keep.
   *
   * A platform with no live signal never claims one and is never auto-promoted
   * into the featured player — an autoplaying "video unavailable" shown to
   * every visitor is exactly the confident-wrong-answer this project refuses.
   * Its card plays on a click, which is the visitor asking, and the embed
   * itself then reports the truth.
   */
  const PLATFORMS = {
    twitch: {
      label: 'Twitch', host: 'twitch.tv/', embeddable: true, liveSignal: true, chat: true,
      // The Twitch login IS the embed handle.
      handle: (s) => s.login || null,
      url: (s) => 'https://twitch.tv/' + encodeURIComponent(s.login),
      player: (h) => 'https://player.twitch.tv/?channel=' + encodeURIComponent(h) +
        '&parent=' + encodeURIComponent(PARENT) + '&muted=true&autoplay=true',
      chatUrl: (h) => 'https://www.twitch.tv/embed/' + encodeURIComponent(h) +
        '/chat?parent=' + encodeURIComponent(PARENT) + '&darkpopout',
    },
    kick: {
      label: 'Kick', host: 'kick.com/', embeddable: true, liveSignal: true, chat: false,
      // kick.com/<slug> — the slug is the embed handle and the API key alike.
      handle: (s) => s.channel || slugFromUrl(s.channelUrl, 'kick.com'),
      url: (s) => s.channelUrl || ('https://kick.com/' + encodeURIComponent(s.channel || '')),
      player: (h) => 'https://player.kick.com/' + encodeURIComponent(h) + '?muted=true&autoplay=true',
    },
    youtube: {
      label: 'YouTube', host: 'youtube.com/', embeddable: true, liveSignal: false, chat: false,
      // Only a UC… id can be embedded. A /@handle URL has no client-side route
      // to one, so such an entry stays a link-out rather than mounting a player
      // keyed on a guess.
      handle: (s) => ytChannelId(s),
      url: (s) => s.channelUrl,
      player: (h) => 'https://www.youtube.com/embed/live_stream?channel=' +
        encodeURIComponent(h) + '&autoplay=1&mute=1',
    },
    other: {
      label: 'Stream', host: '', embeddable: false, liveSignal: false, chat: false,
      handle: () => null,
      url: (s) => s.channelUrl,
    },
  };

  const platformOf = (s) => PLATFORMS[s && s.platform] || PLATFORMS.twitch;

  /** First path segment of a URL on `host` — "kick.com/Ark1317?x=1" -> "ark1317". */
  function slugFromUrl(raw, host) {
    try {
      const url = new URL(String(raw || ''));
      if (!url.hostname.replace(/^www\./i, '').toLowerCase().endsWith(host)) return null;
      const seg = url.pathname.split('/').filter(Boolean)[0] || '';
      const slug = seg.toLowerCase();
      return /^[a-z0-9_-]{1,60}$/.test(slug) ? slug : null;
    } catch { return null; }
  }

  /** The UC… channel id for a YouTube entry, from `channelId` or a /channel/ URL. */
  function ytChannelId(s) {
    const explicit = String((s && s.channelId) || '').trim();
    if (/^UC[A-Za-z0-9_-]{22}$/.test(explicit)) return explicit;
    try {
      const url = new URL(String((s && s.channelUrl) || ''));
      const parts = url.pathname.split('/').filter(Boolean);
      const i = parts.indexOf('channel');
      const id = i >= 0 ? parts[i + 1] : '';
      return /^UC[A-Za-z0-9_-]{22}$/.test(id || '') ? id : null;
    } catch { return null; }
  }

  /** The handle this entry plays under, or null when it cannot be mounted. */
  const embedHandle = (s) => {
    const spec = platformOf(s);
    return spec.embeddable ? (spec.handle(s) || null) : null;
  };

  /** Can this entry mount a player on the page? */
  const canEmbed = (s) => embedHandle(s) !== null;

  /** Can live/offline be observed for this entry? */
  const hasLiveSignal = (s) => platformOf(s).liveSignal && canEmbed(s);

  /** The href a card points at, or null when there is nothing safe to link. */
  function channelHref(s) {
    const spec = platformOf(s);
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
    if (spec === PLATFORMS.twitch && s.login) return spec.host + s.login;
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

  /* ---------- state ----------
   * Keyed by keyOf(), not by Twitch login: a Kick entry has no login, and two
   * platforms can carry the same name. */
  const live = new Map();       // key -> true | false | null (unknown)
  const preview = new Map();    // key -> live thumbnail URL, when the platform gives one
  let roster = [...STREAMERS];  // manual entries + approved sheet rows

  /** Identity for dedupe: a Twitch login, else the channel it points at. */
  const keyOf = (s) => (s.login ? 'twitch:' + s.login : 'url:' + String(s.channelUrl || '').toLowerCase());
  let featured = null;          // key currently in the big player
  let userPinned = false;       // stop auto-promotion once the viewer chose

  const entryFor = (key) => roster.find((s) => keyOf(s) === key) || null;

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
          // Optional and YouTube-only: the UC… id that makes an entry
          // playable. Absent, a YouTube row is still a perfectly good
          // link-out card.
          channelId: String(row.channelId || '').trim() || null,
          name: String(row.name || '').trim() || login || '',
          blurb: String(row.blurb || '').trim(),
        };
        // An entry we can neither embed nor link is not a card, it is a
        // name with nowhere to go — drop it rather than render a dead tile.
        if (!canEmbed(entry) && !channelHref(entry)) continue;
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
   * Per platform, and only where a status can actually be observed without a
   * key. Every probe returns true / false / null, and null means "unknown" —
   * a failed probe must never render as OFFLINE, which is a claim.
   *
   * Twitch: no API key on a static page, so we lean on the public preview CDN:
   * a live channel's thumbnail resolves normally, an offline one redirects to
   * Twitch's 404_preview image. If the CDN ever stops sending CORS headers
   * this degrades to "unknown" and the page simply shows no live badges. */
  async function isLiveTwitch(login) {
    try {
      const r = await fetch(
        `https://static-cdn.jtvnw.net/previews-ttv/live_user_${encodeURIComponent(login)}-80x45.jpg?t=${Date.now()}`,
        { mode: 'cors', cache: 'no-store' }
      );
      if (!r.ok) return null;
      return !r.url.includes('404_preview');
    } catch (_) { return null; }
  }

  /* Kick answers a cross-origin GET with CORS headers, so the status is a
   * plain read rather than an inference: `livestream` is null when the channel
   * is off and an object (carrying a real preview frame) when it is on. A 404
   * is a channel that does not exist — false, not unknown. Anything else, and
   * any thrown fetch, stays unknown. */
  async function isLiveKick(slug, key) {
    try {
      const r = await fetch('https://kick.com/api/v2/channels/' + encodeURIComponent(slug), {
        mode: 'cors', cache: 'no-store',
      });
      if (r.status === 404) return false;
      if (!r.ok) return null;
      const body = await r.json();
      const stream = body && body.livestream;
      if (!stream || stream.is_live !== true) return false;
      const thumb = stream.thumbnail && (stream.thumbnail.url || stream.thumbnail);
      if (typeof thumb === 'string' && /^https:\/\//i.test(thumb)) preview.set(key, thumb);
      return true;
    } catch (_) { return null; }
  }

  /** Dispatch to the probe for `s`'s platform. Unknown when there is none. */
  async function probeLive(s) {
    const spec = platformOf(s);
    const handle = embedHandle(s);
    if (!spec.liveSignal || !handle) return null;
    if (spec === PLATFORMS.twitch) return isLiveTwitch(handle);
    if (spec === PLATFORMS.kick) return isLiveKick(handle, keyOf(s));
    return null;
  }

  /** The live preview frame for a card, or null when the platform gives none. */
  function thumbUrl(s) {
    const spec = platformOf(s);
    if (spec === PLATFORMS.twitch) {
      const login = embedHandle(s);
      return login
        ? `https://static-cdn.jtvnw.net/previews-ttv/live_user_${encodeURIComponent(login)}-440x248.jpg?t=${Math.floor(Date.now() / LIVE_POLL_MS)}`
        : null;
    }
    return preview.get(keyOf(s)) || null;
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

    const s = entryFor(featured);
    if (!s) { featured = null; renderFeatured(); return; }

    const spec = platformOf(s);
    const handle = embedHandle(s);
    const href = channelHref(s);
    const label = esc(channelLabel(s));
    const who = esc(s.name);

    $('playerWho').textContent = s.name;
    $('playerHandle').textContent = channelLabel(s);
    $('playerOut').textContent = `Watch on ${spec.label} ↗`;
    if (href) { $('playerOut').href = href; $('playerOut').style.display = ''; }
    else { $('playerOut').removeAttribute('href'); $('playerOut').style.display = 'none'; }
    bar.style.display = '';

    // Twitch is the only platform whose chat embeds, and its chat — like its
    // player — needs the parent domain.
    const wantChat = spec.chat && !!PARENT;
    chatShell.style.display = wantChat ? '' : 'none';
    if (wantChat) {
      $('chatFrame').innerHTML = `<iframe
        src="${esc(spec.chatUrl(handle))}"
        title="${esc(spec.label)} chat: ${who}"></iframe>`;
    } else {
      $('chatFrame').innerHTML = '';
    }

    // Twitch refuses embeds without a parent domain, which file:// has no way
    // to supply. Kick and YouTube do not take a parent, so they still play.
    if (spec === PLATFORMS.twitch && !PARENT) {
      frame.innerHTML = `
        <div class="player-empty">
          <div class="inner">
            ${MARK_EXTERNAL}
            <h3>Embeds need a web origin</h3>
            <p>Open this page from papertrench.com (or localhost) to watch inline,
            ${href ? `or head straight to <a href="${esc(href)}" target="_blank" rel="noopener">${label}</a>.` : 'or open the channel directly.'}</p>
          </div>
        </div>`;
      return;
    }

    if (!handle || !spec.player) {
      frame.innerHTML = `
        <div class="player-empty">
          <div class="inner">
            ${MARK_EXTERNAL}
            <h3>${who} streams on ${esc(spec.label)}</h3>
            <p>This channel cannot be played here.
            ${href ? `Watch it at <a href="${esc(href)}" target="_blank" rel="noopener">${label}</a>.` : ''}</p>
          </div>
        </div>`;
      return;
    }

    // THE LIVE GATE. The probes already answer whether this channel is live;
    // mounting the player anyway is what produced Kick's "This embed seems to
    // be misconfigured" — its player's answer to being pointed at a channel
    // that is not broadcasting. Only a DEFINITIVE offline answer blocks the
    // mount: an unknown state (probe failed, or the first poll has not
    // landed) mounts as before and lets the player self-report, so a flaky
    // probe can never black out a channel that is actually live.
    // Signal-less platforms are exempt entirely: nobody reports YouTube's
    // state, so its own player is the honest one (see the boot note below).
    if (hasLiveSignal(s) && live.get(keyOf(s)) === false) {
      frame.innerHTML = `
        <div class="player-empty">
          <div class="inner">
            ${MARK_EXTERNAL}
            <h3>${who} is offline</h3>
            <p>Nobody is behind the mic right now. When ${who} goes live it plays
            right here${href ? ` — meanwhile, the channel lives at <a href="${esc(href)}" target="_blank" rel="noopener">${label}</a>` : ''}.
            Pick a LIVE card below to watch someone who is.</p>
          </div>
        </div>`;
      return;
    }

    frame.innerHTML = `<iframe
      src="${esc(spec.player(handle))}"
      allowfullscreen allow="autoplay; fullscreen"
      title="${esc(spec.label)} stream: ${who}"></iframe>`;
  }

  function setFeatured(key, { pinned = false, scroll = false } = {}) {
    if (pinned) userPinned = true;
    if (featured === key) return;
    featured = key;
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
      if (live.get(keyOf(s)) === true) return 0;    // live now
      if (canEmbed(s)) return 1;                    // playable, status off or unknown
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
      const key = keyOf(s);
      const plat = PLATFORMS[s.platform] ? s.platform : 'twitch';
      const status = hasLiveSignal(s) ? live.get(key) : undefined;
      const isUp = status === true;
      const frame = isUp ? thumbUrl(s) : null;

      // A status is only ever printed where one can be observed. Everywhere
      // else the slot names the platform rather than guessing.
      const badge = isUp
        ? '<span class="s-live on"><span class="dot"></span>LIVE</span>'
        : status === false
          ? '<span class="s-live off">OFFLINE</span>'
          : `<span class="s-live plat ${esc(plat)}">${esc(spec.label)}</span>`;

      const thumb = frame
        ? `<img src="${esc(frame)}" alt="Live preview of ${esc(s.name)}" loading="lazy">`
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
      if (canEmbed(s)) {
        const handleLine = href
          ? `<a class="s-handle" href="${esc(href)}" target="_blank" rel="noopener"
               data-out title="Open ${esc(channelLabel(s))}">${esc(channelLabel(s))} ↗</a>`
          : `<span class="s-handle">${esc(channelLabel(s))}</span>`;
        return `
        <div class="s-card plat-${esc(plat)}" data-key="${esc(key)}" role="button" tabindex="0"
             title="Watch ${esc(s.name)} here">
          <div class="s-thumb">${thumb}${badge}${MARK_PLAY}</div>
          ${body(handleLine)}
        </div>`;
      }

      // Link-out → the WHOLE card is the anchor, so the channel line must be
      // a span. An <a> inside an <a> is not nestable markup: the parser closes
      // the outer one early and splits a single card into two broken tiles.
      return `
        <a class="s-card link plat-${esc(plat)}" href="${esc(href)}" target="_blank" rel="noopener"
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

    grid.querySelectorAll('.s-card[data-key]').forEach((card) => {
      const open = () => setFeatured(card.dataset.key, { pinned: true, scroll: true });
      card.addEventListener('click', open);
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
    });
  }

  /* ---------- live badge refresh loop ---------- */
  async function refreshLive() {
    if (!roster.length) return;
    // Only platforms with a real signal are probed, and each is asked its own
    // way — putting a Kick slug to Twitch's preview CDN would answer about a
    // Twitch channel that happens to share the name.
    const checkable = roster.filter(hasLiveSignal);
    await Promise.all(checkable.map(async (s) => live.set(keyOf(s), await probeLive(s))));

    const liveCount = checkable.filter((s) => live.get(keyOf(s)) === true).length;
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
      const firstLive = orderedRoster().find((s) => live.get(keyOf(s)) === true);
      if (firstLive && live.get(featured) !== true) setFeatured(keyOf(firstLive));
    }
    // When the FEATURED channel's own state flips, the gate in renderFeatured
    // must re-judge it: offline → live mounts the stream, live → offline
    // swaps the player for the honest card. Only a flip re-renders — a poll
    // that rebuilt the iframe every 60s would restart the stream mid-watch.
    const current = featured && entryFor(featured);
    if (current && hasLiveSignal(current)) {
      const wantsIframe = live.get(keyOf(current)) !== false;
      if (wantsIframe !== !!document.querySelector('#playerFrame iframe')) renderFeatured();
    }
    renderGrid();
  }

  /* ---------- boot ---------- */
  async function boot() {
    const requested = normalizeLogin(new URLSearchParams(location.search).get('channel'));

    const pickFeatured = () => {
      // ?channel=<login> stays a Twitch deep link — it shipped that way and
      // the links are in the wild.
      const asked = requested && roster.find((s) => s.login === requested);
      if (asked) {
        userPinned = true;
        featured = keyOf(asked);
      } else if (!featured) {
        // The opening pick happens before any probe has answered, so prefer a
        // platform that can eventually report one. A signal-less platform in
        // the player autoplays "video unavailable" whenever the channel is off,
        // which is a bad thing to hand every visitor unasked.
        //
        // It is still the fallback when the roster has nothing better, because
        // the alternative is the "roster is forming" empty state sitting above
        // a grid full of streamers — and that is a plainly false statement,
        // where YouTube's own player at least reports its real status.
        const order = orderedRoster();
        const first = order.find(hasLiveSignal) || order.find(canEmbed);
        if (first) featured = keyOf(first);
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
