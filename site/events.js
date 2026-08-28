/* PaperTrench — /events.
 *
 * FIRST PASS. "Events" arrived without a spec, so this reads it as "the
 * calendar the product already implies" rather than as a new events system:
 * the Sprint window the verifier actually folds, who is streaming right now,
 * and what the verifier has been saying. Every panel is backed by a live
 * endpoint, and a panel that cannot read its endpoint says so — none of them
 * fall back to an invented event, because a fake scheduled event is a promise
 * the project has not made.
 */
(() => {
  'use strict';

  const API = 'https://papertrench-api.onerobby.workers.dev';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  async function get(path) {
    const res = await fetch(API + path, { credentials: 'omit', cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  const note = (el, text) => { el.innerHTML = `<p class="ar-note">${esc(text)}</p>`; };

  /* ---------- the open Sprint window ---------- */

  const pad = (n) => String(n).padStart(2, '0');

  function renderWindow(sprint) {
    const el = $('ev-now');
    const start = Number(sprint.startTs) || 0;
    const end = Number(sprint.endTs) || 0;
    if (!start || !end) { note(el, 'No window is open right now.'); return; }

    const entries = Array.isArray(sprint.entries) ? sprint.entries.length : 0;
    const fmtDay = (ts) => new Date(ts).toLocaleDateString(undefined,
      { month: 'short', day: 'numeric' });

    el.innerHTML = `
      <div class="ev-kicker">Sprint · ${esc(sprint.weekId || '')}</div>
      <div class="ev-title">The weekly window is open</div>
      <p class="ev-sub">One ISO week. Only fills inside it count, and the slice is
      computed by the same verifier that folds the main board — this is the one
      window the server actually windows.</p>
      <div class="ev-clock" id="ev-clock"></div>
      <div class="ev-bar"><i id="ev-fill" style="width:0%"></i></div>
      <div class="ev-barnote">
        <span>${esc(fmtDay(start))}</span>
        <span id="ev-pct">—</span>
        <span>${esc(fmtDay(end))}</span>
      </div>
      <p class="ev-sub" style="margin-top:14px">
        <b style="color:var(--text)">${entries}</b> record${entries === 1 ? '' : 's'} in
        this window so far · <a href="/sprint" style="color:var(--orange2)">open the Sprint →</a>
      </p>`;

    const clock = $('ev-clock');
    const fill = $('ev-fill');
    const pct = $('ev-pct');

    const tick = () => {
      const now = Date.now();
      const left = Math.max(0, end - now);
      const total = Math.max(1, end - start);
      const done = Math.min(1, Math.max(0, (now - start) / total));

      const d = Math.floor(left / 86400000);
      const h = Math.floor((left % 86400000) / 3600000);
      const m = Math.floor((left % 3600000) / 60000);
      const s = Math.floor((left % 60000) / 1000);

      clock.innerHTML = left > 0
        ? `<div class="ev-unit"><b>${d}</b><span>days</span></div>
           <div class="ev-unit"><b>${pad(h)}</b><span>hrs</span></div>
           <div class="ev-unit"><b>${pad(m)}</b><span>min</span></div>
           <div class="ev-unit"><b>${pad(s)}</b><span>sec</span></div>`
        : '<div class="ev-unit" style="min-width:auto;padding:10px 16px"><b>closed</b><span>window</span></div>';
      fill.style.width = (done * 100).toFixed(1) + '%';
      pct.textContent = Math.round(done * 100) + '% elapsed';
    };
    tick();
    setInterval(tick, 1000);
  }

  /* ---------- who is live ----------
   * Twitch and Kick are asked their own way, the same rule /streams uses:
   * a probe that fails is unknown and simply does not claim a status. */

  async function liveTwitch(login) {
    try {
      const r = await fetch(
        `https://static-cdn.jtvnw.net/previews-ttv/live_user_${encodeURIComponent(login)}-80x45.jpg?t=${Date.now()}`,
        { mode: 'cors', cache: 'no-store' });
      if (!r.ok) return null;
      return !r.url.includes('404_preview');
    } catch (_) { return null; }
  }

  async function liveKick(slug) {
    try {
      const r = await fetch('https://kick.com/api/v2/channels/' + encodeURIComponent(slug),
        { mode: 'cors', cache: 'no-store' });
      if (r.status === 404) return false;
      if (!r.ok) return null;
      const body = await r.json();
      return !!(body && body.livestream && body.livestream.is_live === true);
    } catch (_) { return null; }
  }

  async function renderLive() {
    const el = $('ev-live');
    let roster = [];
    try {
      const body = await get('/api/streamer/roster');
      roster = Array.isArray(body && body.streamers) ? body.streamers : [];
    } catch (_) { roster = []; }

    // The hand-maintained names on /streams are the floor: an empty or
    // unreachable roster API must not read as "nobody streams here".
    const seeds = [
      { name: 'OnlyTerp', platform: 'twitch', login: 'onlyterp' },
      { name: 'Ark1317', platform: 'kick', channel: 'ark1317' },
    ];
    for (const row of roster) {
      const login = String((row && row.login) || '').toLowerCase();
      if (login && !seeds.some((s) => s.login === login)) {
        seeds.push({ name: row.name || login, platform: 'twitch', login });
      }
    }

    const results = await Promise.all(seeds.map(async (s) => ({
      s,
      up: s.platform === 'kick' ? await liveKick(s.channel) : await liveTwitch(s.login),
    })));

    const live = results.filter((r) => r.up === true);
    if (!live.length) {
      el.innerHTML = `<p class="ar-note">Nobody is live this minute.
        <a href="/streams" style="color:var(--orange2)">The roster →</a></p>`;
      return;
    }
    el.innerHTML = '<div class="ev-list">'
      + live.map(({ s }) => `
        <a class="ev-item on" href="/streams">
          <span class="dot"></span>
          <span class="nm">${esc(s.name)}</span>
          <span class="mt">${esc(s.platform)}</span>
        </a>`).join('')
      + '</div>';
  }

  /* ---------- the tape ---------- */

  // Verb only: the subject is printed separately, and rejections deliberately
  // arrive with no handle, so the row has to read as a sentence either way —
  // "@someone · verified" and "A record · rejected".
  const KIND_LABEL = {
    accepted: 'accepted',
    rejected: 'rejected',
    verified: 'verified',
    joined: 'joined the trench',
  };

  function ago(ts) {
    const mins = Math.max(0, Math.round((Date.now() - Number(ts)) / 60000));
    if (mins < 60) return mins + 'm';
    const h = Math.round(mins / 60);
    return h < 48 ? h + 'h' : Math.round(h / 24) + 'd';
  }

  async function renderTape() {
    const el = $('ev-tape');
    let events = [];
    try {
      const body = await get('/api/activity');
      events = Array.isArray(body && body.events) ? body.events : [];
    } catch (_) {
      note(el, 'The tape is unreachable right now.');
      return;
    }
    if (!events.length) { note(el, 'Nothing on the tape yet.'); return; }

    el.innerHTML = '<div class="ev-list">'
      + events.slice(0, 8).map((e) => `
        <div class="ev-item">
          <span class="dot"></span>
          <span class="nm">${e.handle ? '@' + esc(e.handle) : 'A record'}</span>
          <span class="ev-sub" style="font-size:12px">${esc(KIND_LABEL[e.kind] || e.kind || '')}${e.detail ? ' — ' + esc(e.detail) : ''}</span>
          <span class="mt">${esc(ago(e.ts))}</span>
        </div>`).join('')
      + '</div>';
  }

  /* ---------- boot ---------- */

  (async () => {
    try { renderWindow(await get('/api/sprint/current')); }
    catch (_) { note($('ev-now'), 'The Sprint window is unreachable right now.'); }
  })();
  renderLive();
  renderTape();
})();
