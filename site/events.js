/* PaperTrench — /events.
 *
 * The page is one event and a short strip; this file supplies the two clocks
 * and the entrant count, and wires the share button.
 *
 * Two rules carried from the first pass, because they are what stop an events
 * page becoming a page of promises:
 *
 *   1. Clocks are DERIVED, never hardcoded. Each deadline is a function of
 *      now, using the same window rule the server folds, so the page stays
 *      correct with nobody maintaining it. The Sprint takes the real endTs
 *      once the API answers and falls back to that shared rule meanwhile —
 *      the two agree even when the fetch fails.
 *   2. A number that cannot be READ is not printed as a number. "nobody yet"
 *      and "the server did not answer" are different claims, and the second
 *      must never render as the first.
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

  /* ---------------- clocks ---------------- */

  const WEEK_MS = 7 * 86400000;
  // Thursday 1970-01-01 was an ISO week day 4, so the first Monday of the
  // epoch anchors the same grid server/core/sprint.js uses.
  const FIRST_MONDAY_MS = 4 * 86400000;

  /** Next Monday 00:00 UTC — the window rollover, fallback for the Sprint. */
  function nextWeekStart(now) {
    return FIRST_MONDAY_MS + (Math.floor((now - FIRST_MONDAY_MS) / WEEK_MS) + 1) * WEEK_MS;
  }

  /** Next 00:00 UTC — the Spark rollover. */
  function nextUtcMidnight(now) {
    const d = new Date(now);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  }

  /** "6d 05h", "05h 12m", "12m 40s" — two units is enough to act on. */
  function countdown(ms) {
    if (ms <= 0) return 'any moment';
    const s = Math.floor(ms / 1000);
    const pad = (n) => String(n).padStart(2, '0');
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return d + 'd ' + pad(h) + 'h';
    if (h > 0) return pad(h) + 'h ' + pad(m) + 'm';
    return pad(m) + 'm ' + pad(s % 60) + 's';
  }

  let sprintEnd = 0;   // real endTs once /api/sprint/current answers

  function tick() {
    const now = Date.now();
    const end = sprintEnd > now ? sprintEnd : nextWeekStart(now);
    $('ev-clock').textContent = countdown(end - now);
    const spark = $('spark-clock');
    if (spark) spark.textContent = countdown(nextUtcMidnight(now) - now);
  }
  tick();
  setInterval(tick, 1000);

  /* ---------------- the board ---------------- */

  (async () => {
    try {
      const sprint = await get('/api/sprint/current');
      const end = Number(sprint && sprint.endTs) || 0;
      if (end > 0) sprintEnd = end;

      const n = Array.isArray(sprint && sprint.entries) ? sprint.entries.length : null;
      if (n !== null) {
        $('ev-entrants').textContent = n === 0 ? 'nobody yet' : String(n);
      }
      // A window already past must not still read "Open now".
      if (end > 0 && end <= Date.now()) {
        const state = $('ev-state');
        state.textContent = 'Settling';
        state.className = 'tag';
      }
      tick();
    } catch (_) {
      // Leave it unread. A failed fetch is not "nobody entered".
      $('ev-entrants').textContent = 'unavailable';
    }
  })();

  /* ---------------- share ---------------- */

  let toastTimer = 0;
  function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('on'), 2200);
  }

  $('ev-share').addEventListener('click', async () => {
    const url = 'https://papertrench.com/events';
    const share = {
      title: 'Top of the Trench',
      text: 'Finish #1 on the weekly PaperTrench board and the tag is yours. Free, paper money, real charts.',
      url,
    };
    // navigator.share is the good path on phones and needs the user gesture
    // we are already inside. A cancelled sheet rejects with AbortError, which
    // is a choice rather than a failure — it must not fall through to a
    // "copied" toast for a link the user just declined to send.
    if (navigator.share) {
      try { await navigator.share(share); return; }
      catch (err) { if (err && err.name === 'AbortError') return; }
    }
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied — send it to someone');
    } catch (_) {
      // Clipboard blocked (insecure origin, or permission refused): say what
      // happened rather than claiming a copy that did not occur.
      toast('Copy blocked — the link is papertrench.com/events');
    }
  });
})();
