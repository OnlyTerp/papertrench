/* PaperTrench — X-Ray panel, x.com side (ISOLATED world).
 *
 * The card the trader sees. Three responsibilities:
 *  1. Know which account the current X route is about (profile page, or the
 *     author of an open post) and keep up with X's SPA navigation.
 *  2. Shuttle: MAIN-world digests → background ledger; ledger intel → card.
 *  3. Render instantly. On a profile the user has opened before, the card is
 *     painted from the background's stored ledger in the same beat the route
 *     is recognized — no spinner, no click, no "analyze" button. Live digests
 *     from the page's own load then update it in place.
 *  4. Live where the eye already is. On a profile the card is a real block
 *     in the header flow — inserted above the Posts/Replies bar, taking its
 *     own space and pushing the timeline down, styled like one of X's own
 *     cards so it reads as part of the profile. The fixed top-right float
 *     survives only where there is no profile tab bar to sit above — post
 *     pages, or a header that has not rendered yet.
 *
 * Everything on the card is either a fact from X's own payloads or a labeled
 * statement about what this device has observed. Watch-window fields (bio /
 * name / @handle changes) always render with their since-date, because a
 * change counter without a since-date reads as "never changed" when the
 * truth is "not seen changing yet" — and on this product a misread like that
 * is the difference between buying a fresh rename and skipping it.
 */
(() => {
  'use strict';
  if (window.__ptXRayPanel) return;
  window.__ptXRayPanel = true;

  const DIGEST_TAG = 'papertrench-xray-digest';
  const SCAN_TAG = 'papertrench-xray-scan';
  const STATE_TAG = 'papertrench-xray-state';
  const HOST_ID = 'papertrench-xray';

  const ROUTE_POLL_MS = 400;
  const SCAN_SETTLE_MS = 700;

  let enabled = false;
  let deepScanEnabled = true;
  let route = null;          // { kind, handle, postId }
  let subject = null;        // { restId, handle } once identity is known
  let intel = null;
  let host = null;
  let shadow = null;
  let body = null;
  let collapsed = false;
  let routeTimer = 0;
  let scanTimer = 0;
  let torn = false;

  function contextAlive() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (_) { return false; }
  }

  function send(message) {
    if (!contextAlive()) return Promise.resolve(null);
    try {
      return chrome.runtime.sendMessage(message).catch(() => null);
    } catch (_) {
      return Promise.resolve(null);
    }
  }

  /* -------------------- route -------------------- */

  const PROFILE_RE = /^\/([A-Za-z0-9_]{1,15})\/?$/;
  const POST_RE = /^\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d+)/;
  const RESERVED = new Set([
    'home', 'explore', 'notifications', 'messages', 'compose', 'settings',
    'search', 'hashtag', 'i', 'intent', 'share', 'login', 'logout', 'signup',
    'account', 'about', 'tos', 'privacy', 'jobs', 'download', 'help',
    'follower_requests', 'communities', 'places', 'topics',
  ]);

  /** The account this route is ABOUT. A post page counts: vetting a launch
   * tweet is exactly when the poster's history matters most. */
  function readRoute() {
    const path = window.location.pathname;
    const post = POST_RE.exec(path);
    if (post && !RESERVED.has(post[1].toLowerCase())) {
      return { kind: 'post', handle: post[1].toLowerCase(), postId: post[2] };
    }
    const profile = PROFILE_RE.exec(path);
    if (profile && !RESERVED.has(profile[1].toLowerCase())) {
      return { kind: 'profile', handle: profile[1].toLowerCase(), postId: null };
    }
    return null;
  }

  function sameRoute(a, b) {
    if (!a || !b) return a === b;
    return a.kind === b.kind && a.handle === b.handle && a.postId === b.postId;
  }

  /* -------------------- formatting -------------------- */

  function ago(ms, now) {
    const d = Math.max(0, now - ms);
    const min = d / 60000;
    if (min < 1) return 'just now';
    if (min < 60) return Math.round(min) + 'm ago';
    const hours = min / 60;
    if (hours < 24) return Math.round(hours) + 'h ago';
    const days = hours / 24;
    if (days < 30) return Math.round(days) + 'd ago';
    const months = days / 30.44;
    if (months < 12) return Math.round(months) + 'mo ago';
    return (days / 365.25).toFixed(1) + 'y ago';
  }

  function dateLabel(ms) {
    try {
      return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch (_) {
      return '';
    }
  }

  function compact(n) {
    if (!Number.isFinite(n)) return '—';
    if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
    return String(n);
  }

  function shortCa(ca) {
    return ca.length > 12 ? ca.slice(0, 4) + '…' + ca.slice(-4) : ca;
  }

  /* -------------------- card shell -------------------- */

  const CSS = [
    ':host{all:initial}',
    // Placement lives on the host (see place()); the wrap only shapes the box.
    '.wrap{position:relative;width:100%;max-height:calc(100vh - 96px);',
    'box-sizing:border-box;background:#0E1219;color:#EAEFF7;',
    'border:1px solid rgba(255,255,255,.13);border-radius:12px;overflow:hidden;',
    'font:12.5px/1.45 ui-sans-serif,-apple-system,"Segoe UI",Inter,sans-serif;',
    'box-shadow:0 14px 44px -12px rgba(0,0,0,.75);display:flex;flex-direction:column}',
    '.hd{display:flex;align-items:center;gap:7px;padding:9px 11px;cursor:default;',
    'background:linear-gradient(180deg,rgba(255,157,69,.13),rgba(255,157,69,0));',
    'border-bottom:1px solid rgba(255,255,255,.07);flex:0 0 auto}',
    '.hd .t{font-weight:800;font-size:11.5px;letter-spacing:.6px;text-transform:uppercase;color:#FF9D45}',
    '.hd .h{color:#8D97A9;font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}',
    '.hd button{all:unset;cursor:pointer;color:#8D97A9;font-size:14px;line-height:1;padding:2px 4px;border-radius:5px}',
    '.hd button:hover{color:#EAEFF7;background:rgba(255,255,255,.08)}',
    '.bd{padding:4px 11px 11px;overflow-y:auto;flex:1 1 auto}',
    '.sec{padding:8px 0;border-top:1px solid rgba(255,255,255,.06)}',
    '.sec:first-child{border-top:0}',
    '.lbl{font-size:10.5px;letter-spacing:.5px;text-transform:uppercase;color:#7C8698;font-weight:700}',
    '.row{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-top:3px}',
    '.big{font-size:14px;font-weight:750}',
    '.dim{color:#8D97A9}',
    '.warn{color:#FFB35C}',
    '.hot{color:#FF8A80}',
    '.ok{color:#7FD1A0}',
    '.note{margin-top:4px;font-size:11px;color:#6F7A8C}',
    '.prev{margin-top:4px;font-size:11.5px;color:#A9B3C4;white-space:pre-wrap;overflow-wrap:break-word;',
    'max-height:74px;overflow:hidden;border-left:2px solid rgba(255,255,255,.12);padding-left:7px}',
    '.chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:5px}',
    '.chip{font:600 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;padding:4px 6px;border-radius:5px;',
    'background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.09);color:#D7DEEA;cursor:pointer}',
    '.chip:hover{border-color:rgba(255,157,69,.5);color:#fff}',
    '.chip .d{color:#7C8698;font-weight:500;margin-left:4px}',
    // Inline in the header flow, the card must read as one of X's own: their
    // card border and radius, page-black background, no overlay shadow — and
    // at column width the sections sit two-up so it reads as a panel, not a
    // stretched sidebar.
    '.wrap.dock{background:#000;border-radius:16px;border-color:rgba(255,255,255,.12);box-shadow:none}',
    '.dock .bd{display:grid;grid-template-columns:1fr 1fr;column-gap:24px;align-items:start;padding:4px 16px 12px}',
    '.dock .bd .sec:nth-child(2){border-top:0}',
    '.dock .bd .sec:only-child{grid-column:1/-1}',
    '.who{display:flex;align-items:center;gap:6px;margin-top:5px}',
    '.who img{width:19px;height:19px;border-radius:50%;flex:0 0 auto;background:#222}',
    '.who .n{font-weight:650;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.who .f{margin-left:auto;color:#8D97A9;font-size:11px;flex:0 0 auto}',
    '.who a{color:inherit;text-decoration:none}',
    '.who a:hover .n{color:#FF9D45}',
    '.star{color:#FF9D45}',
    '.empty{margin-top:3px;color:#6F7A8C;font-size:11.5px}',
    '.wrap.col .bd{display:none}',
  ].join('');

  function ensureCard() {
    if (host && host.isConnected) return true;
    if (!document.body) return false;
    host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = FLOAT_CSS;
    shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS;
    const wrap = document.createElement('div');
    wrap.className = 'wrap' + (collapsed ? ' col' : '');

    const head = document.createElement('div');
    head.className = 'hd';
    const title = document.createElement('span');
    title.className = 't';
    title.textContent = '⌖ X-Ray';
    const who = document.createElement('span');
    who.className = 'h';
    const fold = document.createElement('button');
    fold.textContent = collapsed ? '▸' : '▾';
    fold.title = 'Collapse';
    fold.addEventListener('click', () => {
      collapsed = !collapsed;
      wrap.classList.toggle('col', collapsed);
      fold.textContent = collapsed ? '▸' : '▾';
      try { chrome.storage.local.set({ pt_xray_collapsed: collapsed }); } catch (_) {}
    });
    head.append(title, who, fold);

    body = document.createElement('div');
    body.className = 'bd';
    wrap.append(head, body);
    shadow.append(style, wrap);
    document.body.appendChild(host);
    shadow.__who = who;
    shadow.__wrap = wrap;
    return true;
  }

  function removeCard() {
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = null; shadow = null; body = null;
    placement = null;
  }

  /* -------------------- placement -------------------- */

  // The card is a real block in the profile header flow — inserted above the
  // Posts/Replies bar, taking its own space and pushing the timeline down,
  // exactly like the inline profile panels the trenches already know
  // (TwitterScan, Uxento) and like PaperTrench's own panels on the trading
  // sites. Geometry-free: nothing to measure, nothing to overlap, nothing to
  // cover. Inserting into X's React-managed column is deliberate; when a
  // re-render sweeps the host out, the 400ms poll seats it again. The fixed
  // top-right float survives only where there is no profile tab bar at all —
  // post pages, or a header not rendered yet — and every float names its
  // reason on the host (data-pt-dock="float:<why>") so a report is one
  // devtools glance, not a guessing game.
  const FLOAT_CSS = 'z-index:2147483645;position:fixed;top:64px;right:14px;width:310px;';
  const INLINE_CSS = 'display:block;margin:4px 16px 12px;';
  const INLINE_MAX_H = '420px';   // the header grows by this at most; the card scrolls inside

  let placement = null;     // 'inline' | 'float' — last applied mode
  let dockWhy = '';         // why the last placement floated — surfaced as data-pt-dock

  /** The profile tab bar names its own profile: its tab links point at
   * /<handle> and /<handle>/…, so one element both locates the insertion
   * slot and proves it belongs to the routed account — a lingering bar from
   * the previous profile fails the handle match and is never used. This is
   * the ONLY DOM assumption the dock makes (role=tablist with <a href> tabs;
   * verified against real x.com markup 2026-08-05). */
  function headerSlot() {
    if (!route || route.kind !== 'profile') { dockWhy = 'route'; return null; }
    if (!document.querySelectorAll) { dockWhy = 'no-dom'; return null; }
    try {
      const base = '/' + route.handle;
      for (const tabs of document.querySelectorAll('[role="tablist"]')) {
        for (const a of tabs.querySelectorAll('a[href]')) {
          const href = (a.getAttribute('href') || '').toLowerCase();
          if (href === base || href.indexOf(base + '/') === 0) {
            // Logged-in X wraps the tab strip in a <nav>; insert above that.
            // Shells without the wrapper get the strip itself as the marker.
            const ref = (tabs.closest && tabs.closest('nav')) || tabs;
            if (!ref.parentNode) { dockWhy = 'no-slot'; return null; }
            return ref;
          }
        }
      }
      dockWhy = 'no-tabs';
      return null;
    } catch (_) {
      dockWhy = 'error';
      return null;
    }
  }

  function place() {
    if (!host || !shadow) return;
    const ref = headerSlot();
    if (ref) {
      if (host.parentNode !== ref.parentNode || host.nextSibling !== ref) {
        ref.parentNode.insertBefore(host, ref);
      }
      if (placement !== 'inline') {
        placement = 'inline';
        host.style.cssText = INLINE_CSS;
        shadow.__wrap.classList.add('dock');
        shadow.__wrap.style.maxHeight = INLINE_MAX_H;
        host.setAttribute('data-pt-dock', 'inline');
      }
    } else {
      if (document.body && host.parentNode !== document.body) document.body.appendChild(host);
      if (placement !== 'float') {
        placement = 'float';
        host.style.cssText = FLOAT_CSS;
        shadow.__wrap.classList.remove('dock');
        shadow.__wrap.style.maxHeight = '';
      }
      host.setAttribute('data-pt-dock', 'float:' + (dockWhy || 'unknown'));
    }
  }

  /* -------------------- rendering -------------------- */

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function section(label) {
    const sec = el('div', 'sec');
    sec.appendChild(el('div', 'lbl', label));
    return sec;
  }

  /** A watch-window section: an observed-change count that always states the
   * window it was observed over. */
  function changeSection(label, hist, watchedSince, now, opts) {
    const sec = section(label);
    const row = el('div', 'row');
    const count = hist.changes;
    const headline = count === 0
      ? 'No change seen'
      : count + (count === 1 ? ' change' : ' changes') + ' seen';
    const strong = el('span', 'big ' + (count === 0 ? 'dim' : (opts && opts.hot ? 'hot' : 'warn')), headline);
    row.appendChild(strong);
    if (hist.lastChangeAt) row.appendChild(el('span', 'dim', ago(hist.lastChangeAt, now)));
    sec.appendChild(row);
    if (hist.previous.length) {
      const prev = el('div', 'prev', 'was: ' + hist.previous[0].v);
      sec.appendChild(prev);
    }
    sec.appendChild(el('div', 'note',
      'watching since ' + dateLabel(watchedSince) + ' (' + ago(watchedSince, now) + ')'));
    return sec;
  }

  function render() {
    if (!enabled || !route) { removeCard(); return; }
    if (!ensureCard()) return;
    place();
    const now = Date.now();
    shadow.__who.textContent = '@' + (intel ? intel.handle : route.handle);
    body.replaceChildren();

    if (!intel) {
      const sec = section('Reading this account');
      sec.appendChild(el('div', 'empty',
        'X-Ray builds from this page’s own data. Give it a second — or scroll the profile once.'));
      body.appendChild(sec);
      return;
    }

    /* identity */
    {
      const sec = section('Account');
      const row = el('div', 'row');
      row.appendChild(el('span', 'big', intel.createdAt ? 'Created ' + dateLabel(intel.createdAt) : 'Age unknown'));
      if (intel.createdAt) row.appendChild(el('span', 'dim', ago(intel.createdAt, now)));
      sec.appendChild(row);
      const row2 = el('div', 'row');
      row2.appendChild(el('span', 'dim', Number.isFinite(intel.followers) || Number.isFinite(intel.following)
        ? compact(intel.followers) + ' followers · ' + compact(intel.following) + ' following'
        : 'Follower counts not in this page’s data yet'));
      if (intel.verified) row2.appendChild(el('span', 'dim', '✓ blue'));
      sec.appendChild(row2);
      body.appendChild(sec);
    }

    body.appendChild(changeSection('Bio', intel.bio, intel.firstSeenAt, now, { hot: true }));
    body.appendChild(changeSection('Display name', intel.name, intel.firstSeenAt, now));
    if (intel.handleHist.changes > 0) {
      body.appendChild(changeSection('@handle', intel.handleHist, intel.firstSeenAt, now, { hot: true }));
    }

    /* contract addresses */
    {
      const sec = section('Contract addresses posted');
      const total = intel.cas.length + intel.casDropped;
      const row = el('div', 'row');
      // No posts read is not a clean bill: say so instead of a green "None".
      const postsRead = Number.isFinite(intel.newestTweetAt) || Number.isFinite(intel.scannedBackTo);
      row.appendChild(el('span', 'big ' + (total ? 'warn' : (postsRead ? 'ok' : 'dim')),
        total ? total + (total === 1 ? ' CA' : ' CAs') + ' found'
          : (postsRead ? 'None found' : 'No posts read yet')));
      if (intel.cas.length) row.appendChild(el('span', 'dim', ago(intel.cas[0].lastAt, now)));
      sec.appendChild(row);
      if (intel.bioCas.length) {
        const bioRow = el('div', 'row');
        bioRow.appendChild(el('span', 'hot', '⚑ CA in bio right now'));
        sec.appendChild(bioRow);
      }
      if (intel.cas.length) {
        const chips = el('div', 'chips');
        for (const entry of intel.cas.slice(0, 6)) {
          const chip = el('div', 'chip', shortCa(entry.address));
          chip.appendChild(el('span', 'd', dateLabel(entry.lastAt)));
          chip.title = entry.address + ' — click to copy';
          chip.addEventListener('click', () => {
            try {
              navigator.clipboard.writeText(entry.address);
              chip.firstChild.textContent = 'copied';
              setTimeout(() => { chip.firstChild.textContent = shortCa(entry.address); }, 900);
            } catch (_) {}
          });
          chips.appendChild(chip);
        }
        sec.appendChild(chips);
      }
      sec.appendChild(el('div', 'note', intel.scannedBackTo
        ? 'from posts read back to ' + dateLabel(intel.scannedBackTo)
        : 'from posts read on this device'));
      body.appendChild(sec);
    }

    /* smart following */
    {
      const sec = section('Smart Following');
      if (!intel.smart.length) {
        sec.appendChild(el('div', 'empty', intel.smartAt
          ? 'No sizable accounts seen in the follower lists read so far.'
          : 'Not read yet. Open this account’s Followers tab once and X-Ray reads the list from there.'));
      } else {
        for (const f of intel.smart) {
          const line = el('div', 'who');
          if (f.avatar) {
            const img = document.createElement('img');
            img.src = f.avatar;
            img.alt = '';
            img.referrerPolicy = 'no-referrer';
            line.appendChild(img);
          }
          const link = document.createElement('a');
          link.href = 'https://x.com/' + f.handle;
          const name = el('span', 'n', (f.big ? '★ ' : '') + (f.name || '@' + f.handle));
          if (f.big) name.classList.add('star');
          link.appendChild(name);
          line.appendChild(link);
          line.appendChild(el('span', 'f', compact(f.followers)));
          sec.appendChild(line);
        }
      }
      const sources = intel.smartSources.includes('you_follow')
        ? 'from followers you know, plus follower lists read here'
        : 'ranked by follower count, from follower lists read on this device';
      sec.appendChild(el('div', 'note', sources));
      body.appendChild(sec);
    }
  }

  /* -------------------- data flow -------------------- */

  function applyIntel(next) {
    if (!next) return;
    if (route && next.handle && next.handle !== route.handle
        && (!subject || next.restId !== subject.restId)) return; // stale route
    intel = next;
    subject = { restId: next.restId, handle: next.handle };
    render();
  }

  async function loadCached() {
    if (!route) return;
    const res = await send({ type: 'pt_xray_get', handle: route.handle });
    if (!res || !res.ok || !res.intel) return;
    if (!route || res.intel.handle !== route.handle) return;
    applyIntel(res.intel);
  }

  /** Ask the background what (if anything) is worth fetching for this
   * account, then hand the command to the MAIN world. The background owns
   * the budget; this side only relays and never loops on its own. */
  function scheduleScan() {
    clearTimeout(scanTimer);
    if (!deepScanEnabled) return;
    scanTimer = setTimeout(async () => {
      if (!enabled || !subject) return;
      const res = await send({ type: 'pt_xray_plan', restId: subject.restId, handle: subject.handle });
      if (!res || !res.ok || !res.scan) return;
      if (!subject || res.scan.userId !== subject.restId) return;
      try {
        window.postMessage({
          source: SCAN_TAG,
          requestId: res.scan.requestId,
          op: res.scan.op,
          userId: res.scan.userId,
          cursor: res.scan.cursor || null,
          count: res.scan.count || null,
          shape: res.scan.shape || null,
        }, window.location.origin);
      } catch (_) {}
    }, SCAN_SETTLE_MS);
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || !enabled) return;
    const data = event.data;
    if (!data || data.source !== DIGEST_TAG || !data.digest) return;
    // MAIN-world data is page-controlled. It is forwarded as-is and the
    // background revalidates every field before it touches the ledger.
    send({
      type: 'pt_xray_observe',
      digest: data.digest,
      handle: route ? route.handle : null,
      postId: route ? route.postId : null,
    }).then((res) => {
      if (!res || !res.ok) return;
      // A first visit only learns who the account is HERE; without this the
      // plan was never asked for until a later visit (ticket-0014).
      const firstSight = !subject;
      if (res.intel) applyIntel(res.intel);
      if (res.scanAgain || (firstSight && subject)) scheduleScan();
    });
  });

  function pushState() {
    try {
      window.postMessage({ source: STATE_TAG, enabled }, window.location.origin);
    } catch (_) {}
  }

  function onRoute() {
    const next = readRoute();
    if (sameRoute(next, route)) return;
    route = next;
    subject = null;
    intel = null;
    placement = null;
    clearTimeout(scanTimer);
    if (!route) { removeCard(); return; }
    render();       // instant frame: the shell, then cache, then live data
    loadCached().then(() => { if (subject) scheduleScan(); });
  }

  function start() {
    pushState();
    clearInterval(routeTimer);
    // X's router does not emit a navigation event this side can trust, and a
    // body-wide MutationObserver on x.com is a CPU tax during a scroll storm.
    // A 400ms path poll costs nothing and never misses a route.
    routeTimer = setInterval(() => {
      if (!contextAlive()) { teardown(); return; }
      onRoute();
      // The tab bar mounts late on a cold load, and X's re-renders can sweep
      // the host out of the header. Re-seating is a cheap no-op when nothing
      // moved — the same poll-over-observer trade as the route check above.
      place();
    }, ROUTE_POLL_MS);
    onRoute();
  }

  function teardown() {
    clearInterval(routeTimer);
    clearTimeout(scanTimer);
    routeTimer = 0;
    route = null; subject = null; intel = null;
    removeCard();
    if (!torn) {
      torn = true;
      enabled = false;
      pushState();
    }
  }

  function applySettings(settings) {
    const on = !!(settings && settings.appEnabled !== false && settings.xrayEnabled);
    deepScanEnabled = !settings || settings.xrayDeepScanEnabled !== false;
    if (on === enabled) return;
    enabled = on;
    if (on) { torn = false; start(); } else { clearInterval(routeTimer); routeTimer = 0; route = null; subject = null; intel = null; removeCard(); pushState(); }
  }

  try {
    chrome.storage.local.get(['pt_settings', 'pt_xray_collapsed'], (value) => {
      if (chrome.runtime && chrome.runtime.lastError) return;
      collapsed = value.pt_xray_collapsed === true;
      applySettings(value.pt_settings);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.pt_settings) return;
      applySettings(changes.pt_settings.newValue);
    });
  } catch (_) {
    // No extension context at all (orphaned injection): stay dormant.
  }
})();
