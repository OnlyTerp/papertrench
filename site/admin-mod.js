/* PaperTrench — accounts, records and clans console.
 *
 * Like site/admin.js, this page is a VIEW of a server-side decision, never the
 * decision itself. Every route it calls re-checks the caller's x_id against
 * ADMIN_X_IDS and returns 403 to everyone else, so hiding the console here is
 * a courtesy — editing this file, or the DOM, gets an attacker nothing.
 *
 * The powers are deliberately few and all reversible: ban/unban an account,
 * disqualify/reinstate a record, disband/restore a clan. No delete, no score
 * edit, no chain rewrite, and no way to add a moderator.
 */
(() => {
  'use strict';

  const API = 'https://papertrench-api.onerobby.workers.dev';
  const TOKEN_KEY = 'pt_session_token';

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

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

  const authReturn = window.location.hash.match(/^#authed(?:=(.+))?$/);
  if (authReturn) {
    if (authReturn[1]) { try { localStorage.setItem(TOKEN_KEY, authReturn[1]); } catch {} }
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  $('signInBtn').href = API + '/api/auth/x/start';

  function show(paneId) {
    for (const id of ['loading', 'gateSignedOut', 'gateNotMod', 'console']) {
      $(id).hidden = (id !== paneId);
    }
  }

  const when = (ms) => {
    if (!ms) return '—';
    const d = new Date(Number(ms));
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  };

  function ago(ms) {
    if (!ms) return '';
    const mins = Math.max(0, Math.round((Date.now() - Number(ms)) / 60000));
    if (mins < 60) return mins + 'm ago';
    const h = Math.round(mins / 60);
    if (h < 48) return h + 'h ago';
    return Math.round(h / 24) + 'd ago';
  }

  const num = (v, digits) =>
    (typeof v === 'number' && Number.isFinite(v)) ? v.toFixed(digits == null ? 2 : digits) : '—';

  function value(text) {
    const clean = String(text == null ? '' : text).trim();
    return clean ? `<dd>${esc(clean)}</dd>` : '<dd class="empty">—</dd>';
  }

  const CHEV =
    '<span class="chev" aria-hidden="true"><svg width="12" height="12" viewBox="0 0 24 24" ' +
    'fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" ' +
    'stroke-linejoin="round"><path d="m9 5 7 7-7 7"/></svg></span>';

  /* ---------------- accounts ---------------- */

  function accountRow(u) {
    const flags = [];
    if (u.banned) flags.push('<span class="st banned">banned</span>');
    if (u.disqualified) flags.push('<span class="st dq">disqualified</span>');
    if (u.recordStatus) flags.push(`<span class="st ${esc(u.recordStatus)}">${esc(u.recordStatus)}</span>`);
    if (u.clanTag) flags.push(`<span class="st clan">[${esc(u.clanTag)}]</span>`);

    // Why a record is not on the board, said once, here — a moderator should
    // not have to reason it out from four separate fields.
    let why = '';
    if (u.banned) {
      why = `<div class="why"><b>Off every board:</b> the account is banned. ${esc(u.bannedReason || '')}</div>`;
    } else if (u.disqualified) {
      why = `<div class="why"><b>Off every board:</b> the record is disqualified. ${esc(u.dqReason || '')}</div>`;
    } else if (u.recordStatus && u.recordStatus !== 'verified') {
      why = `<div class="why"><b>Not ranked:</b> re-pricing returned <b>${esc(u.recordStatus)}</b>, and only verified records rank. Nothing a moderator did.</div>`;
    } else if (u.recordStatus === 'verified' && !u.rankable) {
      why = '<div class="why"><b>Not ranked:</b> fewer than five closed rounds. Nothing a moderator did.</div>';
    }

    return `
      <div class="rec ${u.banned || u.disqualified ? 'flagged' : ''}" data-user="${u.id}">
        <details>
          <summary class="rec-sum">
            ${CHEV}
            <span class="rec-id">
              <span class="rec-handle">@${esc(u.handle)}</span>
              <span class="rec-sub">x_id ${esc(u.xId)} · last seen ${esc(ago(u.lastLoginAt))}</span>
            </span>
            <span class="tagline">${flags.join('')}</span>
            <span class="rec-metrics">
              <span class="met"><b>${esc(u.rounds || 0)}</b>rounds</span>
              <span class="met"><b>${esc(num(u.score, 1))}</b>score</span>
              <span class="met"><b>${esc(u.chainLen || 0)}</b>links</span>
            </span>
          </summary>

          <div class="rec-body">
            ${why}
            <div class="split" style="margin-top:14px">
              <div>
                <div class="cap">Account</div>
                <dl class="rows">
                  <dt>Handle</dt><dd><a href="/profile?handle=${encodeURIComponent(u.handle)}" target="_blank" rel="noopener">@${esc(u.handle)} ↗</a></dd>
                  <dt>Display name</dt>${value(u.displayName)}
                  <dt>X user id</dt><dd><code>${esc(u.xId)}</code></dd>
                  <dt>Joined</dt><dd>${esc(when(u.joinedAt))}</dd>
                  <dt>Last login</dt><dd>${esc(when(u.lastLoginAt))}</dd>
                  <dt>Clan</dt>${u.clanTag ? `<dd>[${esc(u.clanTag)}]</dd>` : '<dd class="empty">none</dd>'}
                </dl>
              </div>
              <div>
                <div class="cap">Record</div>
                <dl class="rows">
                  <dt>Status</dt>${value(u.recordStatus || 'no record')}
                  <dt>Chain links</dt><dd>${esc(u.chainLen || 0)}</dd>
                  <dt>Rounds</dt><dd>${esc(u.rounds || 0)}</dd>
                  <dt>Score</dt><dd>${esc(num(u.score, 2))}</dd>
                  <dt>Rankable</dt><dd>${u.rankable ? 'yes' : 'no — needs 5 rounds'}</dd>
                  <dt>Disqualified</dt>${u.disqualified
                    ? `<dd>yes — ${esc(u.dqReason || '')}</dd>` : '<dd class="empty">no</dd>'}
                </dl>
              </div>
            </div>

            <div class="act-box">
              <div class="cap">Moderator actions — a reason is required</div>
              <input class="ar-input" type="text" data-reason placeholder="Why? This is recorded in the ledger and shown to other moderators." maxlength="500">
              <div class="act-row">
                ${u.disqualified
                  ? `<button class="ar-btn good" type="button" data-do="reinstate" disabled>Reinstate record</button>`
                  : `<button class="ar-btn warn" type="button" data-do="disqualify" disabled>Take record off boards</button>`}
                ${u.banned
                  ? `<button class="ar-btn good" type="button" data-do="unban" disabled>Unban account</button>`
                  : `<button class="ar-btn bad" type="button" data-do="ban" disabled>Ban account</button>`}
                <span class="act-msg" data-msg></span>
              </div>
              <p class="plat-note" style="margin-top:10px;font-size:11.5px;color:var(--dim)">
                Disqualifying removes the record from the leaderboard and Sprint without touching the account.
                Banning closes the account and ends its sessions. Both are reversible.
              </p>
            </div>
          </div>
        </details>
      </div>`;
  }

  /* ---------------- clans ---------------- */

  function clanRow(c) {
    const flags = [];
    if (c.disbanded) flags.push('<span class="st banned">disbanded</span>');
    if (c.open) flags.push('<span class="st open">open</span>');

    return `
      <div class="rec ${c.disbanded ? 'flagged' : ''}" data-clan="${c.id}">
        <details>
          <summary class="rec-sum">
            ${CHEV}
            <span class="rec-id">
              <span class="rec-handle">[${esc(c.tag)}] ${esc(c.name)}</span>
              <span class="rec-sub">founded by @${esc(c.founder || 'unknown')} · ${esc(ago(c.createdAt))}</span>
            </span>
            <span class="tagline">${flags.join('')}</span>
            <span class="rec-metrics"><span class="met"><b>${esc(c.members || 0)}</b>members</span></span>
          </summary>

          <div class="rec-body">
            ${c.disbanded
              ? `<div class="why"><b>Disbanded.</b> ${esc(c.disbandedReason || '')}</div>`
              : ''}
            <dl class="rows" style="margin-top:12px">
              <dt>Tag</dt><dd>[${esc(c.tag)}]</dd>
              <dt>Name</dt>${value(c.name)}
              <dt>Motto</dt>${value(c.motto)}
              <dt>Founder</dt>${value(c.founder ? '@' + c.founder : '')}
              <dt>Members</dt><dd>${esc(c.members || 0)}</dd>
              <dt>Join policy</dt><dd>${c.open ? 'open — anyone signed in may join' : 'invite code only'}</dd>
              <dt>Created</dt><dd>${esc(when(c.createdAt))}</dd>
            </dl>

            <div class="act-box">
              <div class="cap">Moderator actions — a reason is required</div>
              <input class="ar-input" type="text" data-reason placeholder="Why? This is recorded in the ledger." maxlength="500">
              <div class="act-row">
                ${c.disbanded
                  ? '<button class="ar-btn good" type="button" data-do="restore" disabled>Restore clan</button>'
                  : '<button class="ar-btn bad" type="button" data-do="disband" disabled>Disband clan</button>'}
                <span class="act-msg" data-msg></span>
              </div>
              <p class="plat-note" style="margin-top:10px;font-size:11.5px;color:var(--dim)">
                Disbanding hides the clan and its board entry. Membership rows are kept, so restoring puts the roster back exactly as it was.
              </p>
            </div>
          </div>
        </details>
      </div>`;
  }

  /* ---------------- ledger ---------------- */

  const UNDO_ACTIONS = ['user.unban', 'record.reinstate', 'clan.restore'];

  function logRow(l) {
    const kind = UNDO_ACTIONS.includes(l.action) ? 'undo' : 'hit';
    return `
      <div class="log-row">
        <span class="log-act ${kind}">${esc(l.action)}</span>
        <span class="log-target">${esc(l.target || '')}</span>
        <span class="log-reason">${esc(l.reason || '')}</span>
        <span class="log-when">@${esc(l.actor)} · ${esc(ago(l.at))}</span>
      </div>`;
  }

  /* ---------------- state ---------------- */

  let view = 'accounts';
  let term = '';

  async function loadRows() {
    const box = $('rows');
    box.innerHTML = '<div class="state"><div class="big">⏳</div>Loading…</div>';
    $('searchbar').hidden = (view !== 'accounts');

    const path = view === 'accounts'
      ? '/api/admin/users?q=' + encodeURIComponent(term)
      : '/api/admin/clans';
    const { status, body } = await api(path);

    if (status === 403) { await boot(); return; }
    if (status < 200 || status >= 300 || !body || !body.ok) {
      // Say the read failed. "No accounts" would be a claim about the data,
      // made while we cannot see it.
      box.innerHTML = '<div class="state"><div class="big">⚠️</div>'
        + 'Couldn’t load that. Refresh to try again.</div>';
      return;
    }

    const list = view === 'accounts' ? (body.users || []) : (body.clans || []);
    if (!list.length) {
      box.innerHTML = `<div class="state"><div class="big">🗂️</div>${
        view === 'accounts'
          ? (term ? 'No account matches that.' : 'No accounts yet.')
          : 'No clans yet.'}</div>`;
      return;
    }
    box.innerHTML = list.map(view === 'accounts' ? accountRow : clanRow).join('');
  }

  async function loadLog() {
    const { status, body } = await api('/api/admin/log');
    const box = $('log');
    if (status < 200 || status >= 300 || !body || !body.ok) {
      box.innerHTML = '<div class="state">Couldn’t load the ledger.</div>';
      return;
    }
    const log = body.log || [];
    box.innerHTML = log.length
      ? log.map(logRow).join('')
      : '<div class="state">Nothing has been actioned yet.</div>';
  }

  /* ---------------- interaction ---------------- */

  // A reason gates every button in its box. Wiring it on the container rather
  // than per-button means a re-render cannot leave a live button behind.
  $('rows').addEventListener('input', (event) => {
    const input = event.target.closest('[data-reason]');
    if (!input) return;
    const box = input.closest('.act-box');
    const ok = input.value.trim().length >= 3;
    box.querySelectorAll('button[data-do]').forEach((b) => { b.disabled = !ok; });
  });

  const CALLS = {
    ban:         { path: '/api/admin/user/ban', body: (id, r) => ({ userId: id, banned: true, reason: r }) },
    unban:       { path: '/api/admin/user/ban', body: (id, r) => ({ userId: id, banned: false, reason: r }) },
    disqualify:  { path: '/api/admin/record/disqualify', body: (id, r) => ({ userId: id, disqualified: true, reason: r }) },
    reinstate:   { path: '/api/admin/record/disqualify', body: (id, r) => ({ userId: id, disqualified: false, reason: r }) },
    disband:     { path: '/api/admin/clan/disband', body: (id, r) => ({ clanId: id, disbanded: true, reason: r }) },
    restore:     { path: '/api/admin/clan/disband', body: (id, r) => ({ clanId: id, disbanded: false, reason: r }) },
  };

  const REASONS = {
    'reason-required': 'Write a reason first — it is recorded, and it is what the next moderator reads.',
    'cannot-ban-self': 'You cannot ban the account you are moderating from.',
    'not-found': 'That row no longer exists. Refresh.',
    'no-record': 'That account has never submitted a record, so there is nothing to disqualify.',
    'not-a-moderator': 'Your moderator access ended. Refresh to sign in again.',
  };

  $('rows').addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-do]');
    if (!button || button.disabled) return;

    const card = button.closest('[data-user], [data-clan]');
    const box = button.closest('.act-box');
    const msg = box.querySelector('[data-msg]');
    const reason = box.querySelector('[data-reason]').value.trim();
    const id = Number(card.dataset.user || card.dataset.clan);
    const call = CALLS[button.dataset.do];
    if (!call) return;

    box.querySelectorAll('button[data-do]').forEach((b) => { b.disabled = true; });
    msg.textContent = 'Saving…';
    msg.className = 'act-msg';

    const { status, body } = await api(call.path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(call.body(id, reason)),
    });

    if (status >= 200 && status < 300 && body && body.ok) {
      msg.textContent = 'Done.';
      msg.className = 'act-msg ok';
      await Promise.all([loadRows(), loadLog()]);
      return;
    }

    box.querySelectorAll('button[data-do]').forEach((b) => { b.disabled = false; });
    msg.textContent = REASONS[body && body.reason] || 'That didn’t save — try again.';
    msg.className = 'act-msg err';
  });

  $('tabs').addEventListener('click', (event) => {
    const tab = event.target.closest('.tab');
    if (!tab) return;
    view = tab.dataset.view;
    $('tabs').querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t === tab));
    loadRows();
  });

  let searchTimer = 0;
  $('q').addEventListener('input', (event) => {
    term = event.target.value.trim();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadRows, 220);
  });

  $('refreshBtn').addEventListener('click', () => { loadRows(); loadLog(); });

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
      $('notModId').textContent = session.xId || 'unavailable';
      show('gateNotMod');
      return;
    }

    $('whoHandle').textContent = '@' + (session.handle || 'you');
    if (session.avatarUrl && safeHref(session.avatarUrl)) {
      $('whoAvatar').src = session.avatarUrl;
      $('whoAvatar').hidden = false;
    }
    show('console');
    loadRows();
    loadLog();
  }

  boot();
})();
