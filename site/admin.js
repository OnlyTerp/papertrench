/* PaperTrench — moderator queue for streamer applications.
 *
 * This page is a VIEW of a server-side decision, never the decision itself.
 * The Worker checks the caller's x_id against ADMIN_X_IDS on every request
 * (/api/streamer/applications, /api/streamer/review) and returns 403 to
 * everyone else, so hiding the queue here is a courtesy to the user — not the
 * control. Editing this file, or the DOM, gets an attacker exactly nothing.
 *
 * Operator setup: docs/STREAMS.md.
 */
(() => {
  'use strict';

  // Same API origin and session transport as arena.js — see the comments there
  // on why the API is cross-site and why the token rides in localStorage as
  // well as a cookie.
  const API = 'https://papertrench-api.onerobby.workers.dev';
  const TOKEN_KEY = 'pt_session_token';

  const $ = (id) => document.getElementById(id);

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  /**
   * An href we are willing to put in the DOM.
   *
   * The server already rejects non-http(s) schemes at submission time, so this
   * is the second lock on the same door: every string here was typed by a
   * member of the public and is about to become a link a moderator clicks. If
   * the server-side check is ever loosened, this is what keeps `javascript:`
   * out of the mod page.
   */
  function safeHref(raw) {
    try {
      const url = new URL(String(raw));
      return (url.protocol === 'https:' || url.protocol === 'http:') ? url.toString() : null;
    } catch { return null; }
  }

  function sessionToken() {
    try { return localStorage.getItem(TOKEN_KEY) || null; } catch { return null; }
  }

  async function api(path, options) {
    const opts = Object.assign({ credentials: 'include' }, options || {});
    const token = sessionToken();
    if (token) opts.headers = Object.assign({}, opts.headers, { Authorization: 'Bearer ' + token });
    const res = await fetch(API + path, opts);
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  }

  // The OAuth callback lands on the leaderboard, not here — but the token it
  // stores is per-origin, so arriving with one already in hand is the norm.
  // Handle the fragment anyway in case a future callback returns to this page.
  const authReturn = window.location.hash.match(/^#authed(?:=(.+))?$/);
  if (authReturn) {
    if (authReturn[1]) { try { localStorage.setItem(TOKEN_KEY, authReturn[1]); } catch {} }
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  $('signInBtn').href = API + '/api/auth/x/start';

  function show(paneId) {
    for (const id of ['loading', 'gateSignedOut', 'gateNotMod', 'queue']) {
      $(id).hidden = (id !== paneId);
    }
  }

  /* ---------------- rendering ---------------- */

  const when = (ms) => {
    if (!ms) return '';
    const d = new Date(Number(ms));
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  };

  /** A <dd>, or an italic "not answered" — never a blank row that reads as data. */
  function value(text) {
    const clean = String(text == null ? '' : text).trim();
    return clean ? `<dd>${esc(clean)}</dd>` : '<dd class="empty">not answered</dd>';
  }

  function linkValue(raw) {
    const href = safeHref(raw);
    if (!href) return value(raw);
    return `<dd><a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(href)}</a></dd>`;
  }

  function cardFor(app) {
    const platform = ['twitch', 'youtube', 'kick'].includes(app.platform) ? app.platform : 'other';
    const chan = safeHref(app.channelUrl);
    const chanHtml = chan
      ? `<a href="${esc(chan)}" target="_blank" rel="noopener noreferrer">${esc(chan)}</a>`
      : esc(app.channelUrl || '');

    // Every platform is approvable now that the roster serves link-out cards
    // for the ones we cannot embed (handleStreamerRoster). Approving a Kick
    // application used to set a status that never became anything: the button
    // was disabled to admit that, which left a moderator with a valid
    // application and nothing to do about it.
    const actions = [];
    if (app.status !== 'approved') {
      actions.push(`<button class="ar-btn good" type="button" data-act="approved" data-id="${app.id}">✓ Approve</button>`);
    }
    if (app.status !== 'rejected') {
      actions.push(`<button class="ar-btn bad" type="button" data-act="rejected" data-id="${app.id}">✕ Reject</button>`);
    }
    if (app.status !== 'pending') {
      actions.push(`<button class="ar-btn" type="button" data-act="pending" data-id="${app.id}">↩ Move back to pending</button>`);
    }

    const reviewed = app.reviewedAt
      ? `<span class="act-msg">${esc(app.status)} by @${esc(app.reviewedBy || 'a moderator')} · ${esc(when(app.reviewedAt))}</span>`
      : '';

    return `
      <article class="app" data-card="${app.id}">
        <div class="app-top">
          <div>
            <div class="app-name">${esc(app.name)} <span class="plat ${platform}">${esc(platform)}</span></div>
            <div class="app-chan">${chanHtml}</div>
          </div>
          <div class="app-when">${esc(when(app.createdAt))}</div>
        </div>

        <dl class="rows">
          <dt>Public blurb</dt>${value(app.blurb)}
          <dt>Twitch login</dt>${app.twitchLogin
            ? `<dd>${esc(app.twitchLogin)}</dd>`
            : '<dd class="empty">not a Twitch channel — cannot be embedded</dd>'}
          <dt>Avg. viewers</dt>${value(app.viewers)}
        </dl>

        <div class="private-note">
          <div class="cap">Private — moderators only</div>
          <dl class="rows">
            <dt>Discord</dt>${value(app.discord)}
            <dt>Contact via</dt>${value(app.contactMethod)}
            <dt>Profile link</dt>${linkValue(app.contactLink)}
            <dt>Best time</dt>${value(app.bestTime)}
            <dt>Notes</dt>${value(app.notes)}
          </dl>
        </div>

        <div class="app-acts">${actions.join('')}${reviewed}</div>
      </article>`;
  }

  /* ---------------- state ---------------- */

  let current = 'pending';

  function setCounts(counts) {
    $('nPending').textContent = counts.pending ? ` ${counts.pending}` : '';
    $('nApproved').textContent = counts.approved ? ` ${counts.approved}` : '';
    $('nRejected').textContent = counts.rejected ? ` ${counts.rejected}` : '';
  }

  const EMPTY = {
    pending: ['📭', 'Nothing waiting. New applications land here.'],
    approved: ['🎬', 'No approved streamers yet.'],
    rejected: ['🗂️', 'Nothing rejected.'],
  };

  async function loadQueue() {
    const box = $('apps');
    box.innerHTML = '<div class="state"><div class="big">⏳</div>Loading…</div>';

    const { status, body } = await api('/api/streamer/applications?status=' + encodeURIComponent(current));

    if (status === 403) { await boot(); return; }   // access changed under us
    if (status < 200 || status >= 300 || !body || !body.ok) {
      // Say the read failed. "No applications" would be an affirmative claim
      // about the queue, made while we cannot see it.
      box.innerHTML = '<div class="state"><div class="big">⚠️</div>'
        + 'Couldn’t load the queue. Refresh to try again.</div>';
      return;
    }

    setCounts(body.counts || {});
    const apps = body.applications || [];
    if (!apps.length) {
      const [icon, text] = EMPTY[current] || EMPTY.pending;
      box.innerHTML = `<div class="state"><div class="big">${icon}</div>${text}</div>`;
      return;
    }
    box.innerHTML = apps.map(cardFor).join('');
  }

  $('apps').addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-act]');
    if (!button || button.disabled) return;

    const card = button.closest('[data-card]');
    const buttons = card ? card.querySelectorAll('button[data-act]') : [button];
    buttons.forEach((b) => { b.disabled = true; });

    const { status, body } = await api('/api/streamer/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: Number(button.dataset.id), status: button.dataset.act }),
    });

    if (status >= 200 && status < 300 && body && body.ok) { await loadQueue(); return; }

    buttons.forEach((b) => { b.disabled = false; });
    const note = card && card.querySelector('.act-msg');
    const text = body && body.reason === 'already-listed'
      ? 'That channel is already on the roster.'
      : 'That didn’t save — try again.';
    if (note) { note.textContent = text; note.className = 'act-msg err'; }
    else if (card) {
      card.querySelector('.app-acts').insertAdjacentHTML('beforeend',
        `<span class="act-msg err">${esc(text)}</span>`);
    }
  });

  $('tabs').addEventListener('click', (event) => {
    const tab = event.target.closest('.tab');
    if (!tab) return;
    current = tab.dataset.status;
    $('tabs').querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t === tab));
    loadQueue();
  });

  $('refreshBtn').addEventListener('click', loadQueue);

  /* ---------------- boot ---------------- */

  async function boot() {
    let session = null;
    try {
      const reply = await api('/api/me');
      session = reply.body;
    } catch (_) { session = null; }

    if (!session || !session.signedIn) { show('gateSignedOut'); return; }

    if (!session.isMod) {
      $('notModHandle').textContent = '@' + (session.handle || 'unknown');
      // Their own X id, so getting added does not require a third-party lookup.
      $('notModId').textContent = session.xId || 'unavailable';
      show('gateNotMod');
      return;
    }

    $('whoHandle').textContent = '@' + (session.handle || 'you');
    if (session.avatarUrl && safeHref(session.avatarUrl)) {
      $('whoAvatar').src = session.avatarUrl;
      $('whoAvatar').hidden = false;
    }
    show('queue');
    loadQueue();
  }

  boot();
})();
