/* PaperTrench — streamer application form.
 *
 * Posts to the leaderboard Worker (POST /api/streamer/apply), which validates
 * with the same core module the server tests exercise. Nothing is validated
 * *only* here: this file exists to tell the applicant what went wrong without
 * a round trip, and the server re-checks every field regardless.
 *
 * Operator notes: docs/STREAMS.md.
 */
(() => {
  'use strict';

  // Same API origin as arena.js — see the comment there on why the API lives
  // on workers.dev rather than api.papertrench.com.
  const API = 'https://papertrench-api.onerobby.workers.dev';

  const $ = (id) => document.getElementById(id);
  const form = $('applyForm');
  const msg = $('formMsg');
  const button = $('submitBtn');

  /* ---------- scroll reveal (same behaviour as main.js) ---------- */
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    }
  }, { threshold: 0.12 });
  document.querySelectorAll('.reveal').forEach((el) => io.observe(el));

  /* ---------- live preview of the published card ----------
   *
   * The form asks for personal details on the promise that only three of the
   * answers are ever published. A promise is worth less than the artefact, so
   * the sidebar renders the actual card from the actual public fields as they
   * are typed. Anything absent from this preview does not go on the site.
   *
   * Every write below is textContent, never innerHTML: this is untrusted input
   * being echoed back into the page, and the preview must not become the one
   * place on the site where it executes.
   */
  const preview = {
    initials: $('prevInitials'),
    name: $('prevName'),
    handle: $('prevHandle'),
    blurb: $('prevBlurb'),
  };
  const blurbCount = $('blurbCount');

  /** Same normalisation streams.js applies before it renders a roster card. */
  function previewHandle(raw) {
    const s = String(raw || '').trim().toLowerCase().replace(/^@/, '');
    if (!s) return 'twitch.tv/you';
    const m = s.match(/twitch\.tv\/([a-z0-9_]+)/);
    if (m) return 'twitch.tv/' + m[1];
    // A full URL to somewhere else is shown as typed — the card links out to
    // whatever platform they gave, so inventing a twitch.tv/ prefix would
    // preview a card that will never exist.
    if (/^https?:\/\//.test(s) || s.includes('.')) return s.replace(/^https?:\/\//, '');
    return /^[a-z0-9_]{3,25}$/.test(s) ? 'twitch.tv/' + s : s;
  }

  function initialsOf(name) {
    return String(name).trim().split(/\s+/).map((w) => w[0] || '').join('').slice(0, 2).toUpperCase();
  }

  function renderPreview() {
    if (!preview.name) return; // preview markup absent — form still works
    const name = String(form.elements.name.value || '').trim();
    const blurb = String(form.elements.blurb.value || '').trim();

    preview.name.textContent = name || 'Your channel name';
    preview.handle.textContent = previewHandle(form.elements.channelUrl.value);

    // The initials tile keeps its OFFLINE chip child, so replace only the text
    // node rather than clearing the element.
    preview.initials.firstChild.nodeValue = initialsOf(name) || '?';

    preview.blurb.textContent = blurb || 'Your one-liner appears here.';
    preview.blurb.classList.toggle('empty', !blurb);

    if (blurbCount) {
      blurbCount.textContent = blurb.length + ' / 160';
      blurbCount.classList.toggle('near', blurb.length > 140);
    }
  }

  ['name', 'channelUrl', 'blurb'].forEach((field) => {
    const el = form.elements[field];
    if (el) el.addEventListener('input', renderPreview);
  });
  renderPreview();

  /**
   * Server reason code -> what the applicant should read.
   *
   * The server returns codes, not sentences, so the wording lives here and can
   * change without touching validation. An unmapped code must still say
   * something true, which is what the fallback is for — never a blank toast
   * that leaves someone staring at a form that did nothing.
   */
  const REASONS = {
    'name-required': 'Add the name your channel goes by.',
    'name-blocked': 'That channel name can’t be used here.',
    'blurb-blocked': 'That one-line blurb can’t be used here.',
    'channel-url-invalid': 'That channel link doesn’t look like a URL — try twitch.tv/yourname.',
    'discord-required': 'Add your Discord username so we can reach you.',
    'viewers-invalid': 'Pick an average viewer count.',
    'contact-method-invalid': 'Pick a contact method from the list.',
    'contact-link-invalid': 'That profile link doesn’t look like a URL.',
    'already-applied': 'That channel already has an application in the queue.',
    'rate-limited': 'Too many applications from this connection. Try again in an hour.',
  };

  const FIELD_FOR = {
    'name-required': 'name',
    'name-blocked': 'name',
    'blurb-blocked': 'blurb',
    'channel-url-invalid': 'channelUrl',
    'discord-required': 'discord',
    'viewers-invalid': 'viewers',
    'contact-method-invalid': 'contactMethod',
    'contact-link-invalid': 'contactLink',
    'already-applied': 'channelUrl',
  };

  function say(text, kind) {
    msg.textContent = text || '';
    msg.className = 'form-msg' + (kind ? ' ' + kind : '');
  }

  /** Put the cursor where the problem is — a message alone makes them hunt. */
  function focusField(reason) {
    const name = FIELD_FOR[reason];
    if (!name) return;
    const el = form.elements[name];
    if (el && el.focus) el.focus();
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (button.disabled) return;

    const data = Object.fromEntries(new FormData(form).entries());

    // A cheap local pass on the three required text fields, so the obvious
    // omission does not cost a round trip. The server owns the real verdict.
    if (!String(data.name || '').trim()) {
      say(REASONS['name-required'], 'err'); focusField('name-required'); return;
    }
    if (!String(data.channelUrl || '').trim()) {
      say(REASONS['channel-url-invalid'], 'err'); focusField('channel-url-invalid'); return;
    }
    if (!String(data.discord || '').trim()) {
      say(REASONS['discord-required'], 'err'); focusField('discord-required'); return;
    }
    if (!String(data.viewers || '').trim()) {
      say(REASONS['viewers-invalid'], 'err'); focusField('viewers-invalid'); return;
    }

    button.disabled = true;
    say('Sending…');

    let status = 0;
    let body = null;
    try {
      const res = await fetch(API + '/api/streamer/apply', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      status = res.status;
      body = await res.json().catch(() => null);
    } catch (_) {
      // Network-level failure: the application did NOT land, and saying
      // anything else would be inventing an outcome.
      button.disabled = false;
      say('Couldn’t reach the server. Check your connection and try again.', 'err');
      return;
    }

    if (status >= 200 && status < 300 && body && body.ok) {
      $('formPane').hidden = true;
      $('donePane').hidden = false;
      $('donePane').scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    button.disabled = false;
    const reason = body && body.reason;
    say(REASONS[reason] || 'Something went wrong sending that — try again in a moment.', 'err');
    focusField(reason);
  });
})();
