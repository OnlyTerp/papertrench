/* PaperTrench — /events.
 *
 * The page is a static list of the recurring things the product actually
 * runs; this file only supplies what has to be live: the clocks, and the
 * three counts (Sprint entrants, clans, who is streaming).
 *
 * Two rules carried over from the first pass, because they are what stop an
 * events page becoming a page of promises:
 *
 *   1. Nothing here invents an event. Every card in events.html maps to code
 *      that exists, and the clocks are derived from the same window math the
 *      server folds — not from a hardcoded date somebody has to remember to
 *      update.
 *   2. A number that cannot be read is not printed as zero. "0 entrants" and
 *      "we could not reach the server" are different claims, and the second
 *      one must never render as the first.
 */
(() => {
  'use strict';

  const API = 'https://papertrench-api.onerobby.workers.dev';
  const $ = (id) => document.getElementById(id);

  async function get(path) {
    const res = await fetch(API + path, { credentials: 'omit', cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  /* ---------------- clocks ----------------
   *
   * Each deadline is a function of NOW rather than a stored date, so the page
   * stays correct with nobody maintaining it. The Sprint deadline is replaced
   * by the server's real endTs once that arrives; the fallback below is the
   * same ISO-week rule the server uses, so the two agree even offline. */

  const DAY = 86400000;

  /** Next 00:00 UTC — the Spark rollover. */
  function nextUtcMidnight(now) {
    const d = new Date(now);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  }

  /** Next Monday 00:00 UTC — the ISO week the Sprint and clan season share. */
  function nextIsoWeekStart(now) {
    const d = new Date(now);
    // getUTCDay: Sun=0 … Sat=6. Days until the next Monday, never 0.
    const ahead = ((8 - d.getUTCDay()) % 7) || 7;
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + ahead);
  }

  /** Next Friday 20:00 UTC — the Reckoning bell (server/core/reckoning.js). */
  function nextReckoning(now) {
    const d = new Date(now);
    const ahead = (5 - d.getUTCDay() + 7) % 7;
    let ts = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + ahead, 20);
    if (ts <= now) ts += 7 * DAY;
    return ts;
  }

  /** First of next month, 00:00 UTC — when a Wrapped month closes. */
  function nextMonth(now) {
    const d = new Date(now);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }

  // Sprint starts on the shared fallback and is overwritten by the API.
  const deadlines = {
    spark: nextUtcMidnight,
    sprint: nextIsoWeekStart,
    reckoning: nextReckoning,
    wrapped: nextMonth,
  };
  let sprintEnd = 0;   // real endTs once /api/sprint/current answers

  /** "6d 05h", "05h 12m", "12m 40s" — two units is enough to act on. */
  function countdown(ms) {
    if (ms <= 0) return 'any moment';
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    if (d > 0) return d + 'd ' + pad(h) + 'h';
    if (h > 0) return pad(h) + 'h ' + pad(m) + 'm';
    return pad(m) + 'm ' + pad(sec) + 's';
  }

  function tick() {
    const now = Date.now();
    for (const el of document.querySelectorAll('[data-cd]')) {
      const key = el.dataset.cd;
      const at = (key === 'sprint' && sprintEnd > now)
        ? sprintEnd
        : (deadlines[key] ? deadlines[key](now) : 0);
      el.textContent = at ? countdown(at - now) : '—';
    }
  }

  tick();
  setInterval(tick, 1000);

  /* ---------------- live counts ---------------- */

  (async () => {
    try {
      const sprint = await get('/api/sprint/current');
      const end = Number(sprint && sprint.endTs) || 0;
      if (end > 0) sprintEnd = end;
      const n = Array.isArray(sprint && sprint.entries) ? sprint.entries.length : null;
      if (n !== null) {
        $('ev-sprint-n').textContent = n === 0 ? 'nobody yet' : String(n);
      }
      // A window that has already closed must not still read "Open now".
      if (end > 0 && end <= Date.now()) {
        const state = $('ev-sprint-state');
        state.textContent = 'Between windows';
        state.className = 'tag';
      }
      tick();
    } catch (_) {
      // Leave the em-dash. A failed read is not "nobody entered".
      $('ev-sprint-n').textContent = 'unavailable';
    }
  })();

  (async () => {
    try {
      const body = await get('/api/clans');
      const n = Number(body && body.clansTotal);
      $('ev-clans-n').textContent = Number.isFinite(n) ? String(n) : 'unavailable';
    } catch (_) {
      $('ev-clans-n').textContent = 'unavailable';
    }
  })();

  /* ---------------- who is streaming ----------------
   * Same probes /streams uses, and the same rule: a channel we cannot reach
   * is UNKNOWN, never "offline". Only a positive answer counts as live. */

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

  (async () => {
    // The hand-maintained names on /streams are the floor: an empty or
    // unreachable roster API must not read as "nobody streams here".
    const seeds = [
      { name: 'OnlyTerp', platform: 'twitch', login: 'onlyterp' },
      { name: 'Ark1317', platform: 'kick', channel: 'ark1317' },
    ];
    try {
      const body = await get('/api/streamer/roster');
      for (const row of (Array.isArray(body && body.streamers) ? body.streamers : [])) {
        const login = String((row && row.login) || '').toLowerCase();
        if (login && !seeds.some((s) => s.login === login)) {
          seeds.push({ name: row.name || login, platform: 'twitch', login });
        }
      }
    } catch (_) { /* seeds stand */ }

    const results = await Promise.all(seeds.map(async (s) => (
      s.platform === 'kick' ? await liveKick(s.channel) : await liveTwitch(s.login)
    )));
    const live = results.filter((up) => up === true).length;
    const known = results.filter((up) => up !== null).length;

    const nEl = $('ev-live-n');
    const line = $('ev-live-line');
    const tags = $('ev-live-tags');

    if (!known) {
      nEl.textContent = 'unavailable';
      line.textContent = 'Live status could not be checked from here right now.';
      return;
    }

    nEl.textContent = String(live);
    if (live > 0) {
      line.textContent = live === 1
        ? 'Somebody is running the challenge live right now.'
        : `${live} streamers are running the challenge live right now.`;
      tags.innerHTML = '<span class="tag live"><span class="dot"></span>Live</span>';
    } else {
      line.textContent = 'Nobody is live this minute — the roster and past runs are on the streams page.';
    }
  })();
})();
