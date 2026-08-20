/* PaperTrench — Live on Twitch page.
 *
 * The roster comes from two places: the hand-maintained STREAMERS list below,
 * plus (optionally) the approval Google Sheet behind the signup form — rows
 * whose Approved column says yes appear on the page without a deploy. Full
 * setup walkthrough: docs/STREAMS.md.
 */
(() => {
  'use strict';

  /* ------------------------------------------------------------------ *
   *  CONFIG — edit this block when streamers sign up                     *
   * ------------------------------------------------------------------ */

  // Hand-maintained roster. Entries here always show, and they win over a
  // sheet row with the same login — useful for pinning or fixing a blurb.
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

  // Where "Sign up as a streamer" points. Paste the Google Form share link
  // here once it exists (see docs/STREAMS.md); until then, GitHub issues.
  const SIGNUP_URL = 'https://github.com/OnlyTerp/papertrench/issues/new'
    + '?title=' + encodeURIComponent('Streamer signup: <your twitch handle>')
    + '&body=' + encodeURIComponent(
      'Twitch channel: https://twitch.tv/\n'
      + 'When do you stream the challenge?: \n'
      + 'Anything else we should know?: \n');

  // Approval-sheet roster (optional). Paste the "Publish to web → CSV" URL of
  // the Google Sheet behind the signup form and the page pulls every row whose
  // Approved column says yes — approving a streamer is typing "yes" in a cell,
  // no deploy needed. Empty string disables it; on any fetch/parse failure the
  // page just runs on STREAMERS above. Setup walkthrough: docs/STREAMS.md.
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
            <div class="big">🎥</div>
            <h3>The roster is forming</h3>
            <p>Streamer signups for the PaperTrench Challenge are open. The first
            live runs land right here — and if you stream, that could be you.</p>
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
            <div class="big">↗</div>
            <h3>Embeds need a web origin</h3>
            <p>Open this page from papertrench.com (or localhost) to watch inline,
            or head straight to <a style="color:var(--twitch2)" href="https://twitch.tv/${login}" target="_blank" rel="noopener">twitch.tv/${login}</a>.</p>
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
        <a class="s-card" href="${esc(SIGNUP_URL)}" target="_blank" rel="noopener"
           style="display:block;border-style:dashed;border-color:rgba(145,70,255,0.35)">
          <div class="s-thumb"><div class="ph">?</div></div>
          <div class="s-body">
            <div class="s-name">Your stream here</div>
            <div class="s-handle">twitch.tv/you</div>
            <div class="s-blurb">Open slot on the challenge roster — sign up below and it's yours.</div>
          </div>
        </a>`;
  }

  function renderGrid() {
    const grid = $('streamerGrid');

    const cards = roster.map((s) => {
      const status = live.get(s.login);
      const isUp = status === true;
      const badge = status === true
        ? '<span class="s-live on"><span class="dot"></span>LIVE</span>'
        : status === false
          ? '<span class="s-live off">OFFLINE</span>'
          : '';
      const thumb = isUp
        ? `<img src="${thumbUrl(s.login)}" alt="Live preview of ${esc(s.name)}" loading="lazy">`
        : `<div class="ph">${esc(initials(s.name))}</div>`;
      return `
        <button class="s-card" data-login="${esc(s.login)}" type="button" title="Watch ${esc(s.name)}">
          <div class="s-thumb">${thumb}${badge}</div>
          <div class="s-body">
            <div class="s-name">${esc(s.name)}</div>
            <div class="s-handle">twitch.tv/${esc(s.login)}</div>
            ${s.blurb ? `<div class="s-blurb">${esc(s.blurb)}</div>` : ''}
          </div>
        </button>`;
    });

    while (cards.length < OPEN_SLOTS) cards.push(openSlot());
    grid.innerHTML = cards.join('');

    grid.querySelectorAll('.s-card[data-login]').forEach((card) => {
      card.addEventListener('click', () =>
        setFeatured(card.dataset.login, { pinned: true, scroll: true }));
    });
  }

  /* ---------- live badge refresh loop ---------- */
  async function refreshLive() {
    if (!roster.length) return;
    await Promise.all(roster.map(async (s) => live.set(s.login, await isLive(s.login))));

    const liveCount = roster.filter((s) => live.get(s.login) === true).length;
    $('liveCountLabel').textContent = liveCount > 0
      ? `${liveCount} streamer${liveCount === 1 ? '' : 's'} live right now`
      : 'The PaperTrench Challenge';

    // Put a live channel in the player unless the viewer picked one themself.
    if (!userPinned) {
      const firstLive = roster.find((s) => live.get(s.login) === true);
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
      } else if (!featured && roster.length) {
        featured = roster[0].login;
      }
    };

    // Fast paint from the hand-maintained list, then fold in the sheet.
    pickFeatured();
    renderFeatured();
    renderGrid();

    const before = `${featured}:${roster.length}`;
    await loadSheetRoster();
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
