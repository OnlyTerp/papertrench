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
    card: $('prevCard'),
    initials: $('prevInitials'),
    name: $('prevName'),
    handle: $('prevHandle'),
    blurb: $('prevBlurb'),
  };
  const blurbCount = $('blurbCount');

  /* ---------- platform → channel URL ----------
   *
   * The domain is the part nobody should have to type and the part typos
   * land in, so the platform picker supplies it and the input takes only the
   * handle. The server still derives the real platform from the finished URL
   * (streamer.js platformOf) — this selector is an input aid, never the
   * authority, so a mismatched pair cannot mislabel anything downstream.
   */
  const PLATFORMS = {
    twitch: {
      prefix: 'twitch.tv/', placeholder: 'yourname',
      hint: 'Just the part after the slash. Pasting the full link works too.',
      note: 'Twitch channels can be played inline on the streams page — the other platforms get a card that links out.',
    },
    kick: {
      prefix: 'kick.com/', placeholder: 'yourname',
      hint: 'Just the part after the slash. Pasting the full link works too.',
      note: 'Kick channels get a roster card that links straight to your channel.',
    },
    youtube: {
      prefix: 'youtube.com/', placeholder: '@yourhandle',
      hint: 'Your @handle, or the full link to your channel page.',
      note: 'YouTube channels get a roster card that links straight to your channel.',
    },
    other: {
      prefix: '', placeholder: 'https://your-channel-link',
      hint: 'Paste the full link to your channel, including https://.',
      note: 'Anywhere else works too — the card links out to whatever you paste.',
    },
  };

  const platformSel = $('f-platform');
  const channelInput = $('f-channel');
  const urlGroup = $('urlGroup');
  const urlPrefix = $('urlPrefix');

  const platformKey = () =>
    (platformSel && PLATFORMS[platformSel.value]) ? platformSel.value : 'twitch';

  /** Strip a pasted full URL back to the handle for the selected platform. */
  function unwrapForPlatform(raw, key) {
    let s = String(raw || '').trim().replace(/^@(?=[^/]*$)/, (m) => (key === 'youtube' ? '@' : ''));
    if (key === 'other') return s;
    s = s.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
    const host = { twitch: 'twitch.tv/', kick: 'kick.com/', youtube: 'youtube.com/' }[key];
    if (host && s.toLowerCase().startsWith(host)) s = s.slice(host.length);
    // youtu.be and /c//channel/ forms are left intact rather than guessed at.
    return s.replace(/^\/+/, '');
  }

  /** The full URL the server is sent, composed from platform + handle. */
  function composedUrl() {
    const key = platformKey();
    const raw = String(channelInput ? channelInput.value : '').trim();
    if (!raw) return '';
    if (key === 'other') return raw;
    // Somebody pasted a link for a DIFFERENT platform than the one selected:
    // send what they actually typed. The server reads the URL, not the picker,
    // so honouring the paste is what keeps the two in agreement.
    if (/^https?:\/\//i.test(raw) || /^[a-z0-9-]+\.[a-z]{2,}\//i.test(raw)) return raw;
    return PLATFORMS[key].prefix + raw.replace(/^\/+/, '');
  }

  function applyPlatform() {
    const key = platformKey();
    const spec = PLATFORMS[key];
    if (!urlGroup || !urlPrefix || !channelInput) return;

    urlPrefix.textContent = spec.prefix;
    urlPrefix.className = 'url-prefix ' + key;
    urlGroup.classList.toggle('bare', !spec.prefix);
    channelInput.placeholder = spec.placeholder;
    channelInput.inputMode = key === 'other' ? 'url' : 'text';
    const hint = $('channelHint');
    if (hint) hint.textContent = spec.hint;
    const note = $('platformHint');
    if (note) note.textContent = spec.note;

    // Re-unwrap what is already typed so switching platforms does not leave a
    // handle sitting behind the wrong domain.
    channelInput.value = unwrapForPlatform(channelInput.value, key);
    renderPreview();
  }

  if (platformSel) platformSel.addEventListener('change', applyPlatform);

  // Unwrap a pasted URL on the way out of the field, not while they type —
  // rewriting the value mid-keystroke fights the cursor. Only a paste that
  // matches the SELECTED platform collapses; a link to somewhere else is left
  // whole, because composedUrl() forwards it verbatim.
  if (channelInput) {
    channelInput.addEventListener('blur', () => {
      const key = platformKey();
      if (key === 'other') return;
      const host = { twitch: 'twitch.tv/', kick: 'kick.com/', youtube: 'youtube.com/' }[key];
      const bare = channelInput.value.trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '');
      if (!host || !bare.toLowerCase().startsWith(host)) return;
      channelInput.value = unwrapForPlatform(channelInput.value, key);
      renderPreview();
    });
  }

  /* ---------- contact method → what we still need ----------
   * "Other" is the case that used to strand people: they picked it and the
   * next field still said "Profile link", which is not what Other means. */
  const CONTACT_ASK = {
    '': null, // no preference — nothing more is needed
    'Discord DM': null, // already answered by the Discord field above
    'Email': {
      label: 'Your email address',
      placeholder: 'you@example.com',
      hint: 'Where a moderator should email you about this application.',
    },
    'Twitter/X': {
      label: 'Your X profile link',
      placeholder: 'https://x.com/yourhandle',
      hint: 'The account a moderator should DM.',
    },
    'Other': {
      label: 'How should we reach you?',
      placeholder: 'Telegram @you, Instagram link, anything…',
      hint: 'Name the platform and the handle or link — a moderator has no other way to guess it.',
    },
  };

  const methodSel = $('f-method');
  const linkField = $('contactLinkField');

  function applyContactMethod() {
    if (!methodSel || !linkField) return;
    const ask = CONTACT_ASK[methodSel.value] || null;
    linkField.hidden = !ask;
    if (!ask) return;
    $('contactLinkLabel').textContent = ask.label;
    $('contactLinkHint').textContent = ask.hint;
    $('f-contactlink').placeholder = ask.placeholder;
    // Email and free-text answers are not URLs, and the server only URL-checks
    // contactLink when it looks like one — so the input type stays text.
    $('f-contactlink').inputMode = methodSel.value === 'Email' ? 'email' : 'text';
  }

  if (methodSel) methodSel.addEventListener('change', applyContactMethod);

  /** Same normalisation streams.js applies before it renders a roster card. */
  function previewHandle(raw) {
    const url = composedUrl();
    if (!url) return PLATFORMS[platformKey()].prefix + 'you' || 'your-channel-link';
    return url.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  }

  function initialsOf(name) {
    return String(name).trim().split(/\s+/).map((w) => w[0] || '').join('').slice(0, 2).toUpperCase();
  }

  /**
   * Which platform the card should be COLOURED as.
   *
   * Not simply the dropdown: composedUrl() forwards a pasted link for another
   * platform verbatim, and the server derives the real platform from that URL.
   * So the preview reads the finished URL the same way, and a Kick link pasted
   * while "Twitch" is selected previews green — which is the card that would
   * actually be built.
   */
  function previewPlatform() {
    const url = composedUrl().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '');
    if (url.startsWith('twitch.tv/')) return 'twitch';
    if (url.startsWith('kick.com/')) return 'kick';
    if (url.startsWith('youtube.com/') || url.startsWith('youtu.be/')) return 'youtube';
    if (url) return 'other';
    return platformKey();   // nothing typed yet — follow the picker
  }

  function renderPreview() {
    if (!preview.name) return; // preview markup absent — form still works
    const name = String(form.elements.name.value || '').trim();
    const blurb = String(form.elements.blurb.value || '').trim();

    if (preview.card) preview.card.className = 'prev-card ' + previewPlatform();

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
  applyPlatform();
  applyContactMethod();
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

    // The input holds a handle; the server wants a URL. Compose it here so the
    // stored channel_url is whole, and drop the picker itself — it is an input
    // aid, and letting it ride along would invite a future reader to trust it
    // over the URL that streamer.js actually derives the platform from.
    data.channelUrl = composedUrl();
    delete data.platform;

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
