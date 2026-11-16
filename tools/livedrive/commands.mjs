/* livedrive commands — loaded fresh on every call (the daemon imports this
 * file by mtime), so fixing or adding a command never relaunches Chrome.
 * `d` is the daemon's live context: ctx, main, swEval, spend, ring, ... */
import path from 'node:path';
import { parseMcap, sameSiteTarget } from './lib/guards.mjs';

export const SITE_SAFE = new Set(['status', 'events', 'journal', 'positions', 'eval-sw', 'screenshot', 'stop', 'tabs']);

export function makeCommands(d) {
  async function historyStep(delta) {
    const h = await d.pageCdp.send('Page.getNavigationHistory');
    const target = h.entries[h.currentIndex + delta];
    if (!target) throw new d.Refusal('NOT_FOUND', `no history entry ${delta < 0 ? 'back' : 'forward'}`);
    const here = new URL(d.main.url());
    let there = null;
    try { there = new URL(target.url); } catch { /* about:blank etc. */ }
    if (!there || there.hostname !== here.hostname) throw new d.Refusal('OFF_SITE', `history ${delta < 0 ? 'back' : 'forward'} would leave ${here.hostname} (to ${target.url.slice(0, 80)})`);
    await d.pageCdp.send('Page.navigateToHistoryEntry', { entryId: target.id });
    await d.main.waitForURL((u) => u.href === target.url, { timeout: 10_000 }).catch(() => {});
    await d.wait(1500);
    return { url: d.main.url() };
  }

  async function readState() {
    return d.swEval(async () => (await chrome.storage.local.get('pt_state')).pt_state || {});
  }
  async function journalFor(mint, sinceTs = 0, n = 10) {
    return d.swEval(async ([m, since, k]) => {
      const st = (await chrome.storage.local.get('pt_state')).pt_state || {};
      return (st.journal || []).filter((e) => (!m || e.mint === m) && (e.ts || 0) >= since).slice(0, k);
    }, [mint || null, sinceTs, n]);
  }
  const fillView = (e) => ({ id: e.id, side: e.side, mint: e.mint, symbol: e.symbol, mcap: e.mcap, priceSource: e.priceSource, priceAgeMs: e.priceAgeMs, priceNative: e.priceNative, qty: e.qty, solGross: e.solGross, ts: e.ts });
  function eventsSince(t0, types) { return d.ring.filter((e) => e.t >= t0 && (!types || types.includes(e.type))); }

  async function rowMcap(mint) {
    return d.main.evaluate((addr) => {
      const r = document.querySelector(`[data-pulse-token-address="${addr}"]`);
      if (!r) return null;
      return (r.innerText.match(/MC\s*\$([\d.,]+[KMB]?)/) || [])[1] || null;
    }, mint);
  }

  async function listChips(filter) {
    return d.main.evaluate((rx) => {
      const re = rx ? new RegExp(rx) : null;
      const out = [];
      for (const c of document.querySelectorAll('.pt-rowbuy')) {
        const rc = c.getBoundingClientRect();
        if (!rc.width || getComputedStyle(c).display === 'none') continue;
        if (rc.bottom < 0 || rc.top > innerHeight) continue;
        const x = rc.left + rc.width / 2, y = rc.top + rc.height / 2;
        const row = document.elementsFromPoint(x, y).map((e) => e.closest && e.closest('[data-pulse-token-address]')).find(Boolean);
        if (!row) continue;
        const mint = row.getAttribute('data-pulse-token-address');
        if (re && !re.test(mint)) continue;
        const text = row.innerText.replace(/\s+/g, ' ');
        out.push({ mint, x, y, mc: (text.match(/MC\s*\$([\d.,]+[KMB]?)/) || [])[1] || null, name: text.slice(0, 40) });
      }
      return out;
    }, filter || null);
  }

  async function panelButton(label) {
    return d.main.evaluate((l) => {
      const h = document.getElementById('papertrench-host');
      if (!h || !h.shadowRoot) return null;
      const b = [...h.shadowRoot.querySelectorAll('button')].find((x) => x.textContent.replace(/\s+/g, ' ').trim() === l && x.getBoundingClientRect().width);
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, label);
  }

  async function watchFills(mint, t0, ms) {
    const deadline = Date.now() + ms;
    let fills = [];
    while (Date.now() < deadline) {
      fills = (await journalFor(mint, t0, 5)).map(fillView);
      if (fills.length) break;
      await d.wait(250);
    }
    return fills;
  }

  return {
    async status() {
      const disk = d.buildOnDisk();
      const visibility = await d.main.evaluate(() => document.visibilityState).catch(() => 'unknown');
      const now = Date.now();
      return {
        pid: process.pid,
        url: d.main.url(),
        title: await d.main.title().catch(() => ''),
        visibility,
        pages: d.ctx.pages().length,
        tabs: { ...d.tabEvents, log: d.tabEvents.log.slice(-5) },
        navBudget: d.budget.peek(),
        blocked: d.blocked,
        build: { loaded: d.loadedBuild, disk, stale: disk.hash !== d.loadedBuild.hash },
        lastEventAgeMs: Object.fromEntries(Object.entries(d.lastByType).map(([k, v]) => [k, now - v])),
        ringSize: d.ring.length,
      };
    },

    async tabs() { return { pages: d.ctx.pages().map((p) => p.url()), ...d.tabEvents }; },

    async refresh() {
      d.spend('refresh');
      await d.main.reload({ waitUntil: 'domcontentloaded' });
      d.pageMainHash = d.mainWorldHash();
      await d.wait(2500);
      return { url: d.main.url() };
    },

    async 'reload-ext'() {
      // Prove the reload really happened before stamping the disk build as
      // loaded: tag the live worker, send the reload from THAT worker, and
      // accept only a worker that comes up without the tag.
      const disk = d.buildOnDisk();
      const gen = 'ld' + Date.now();
      await d.swEval((g) => { self.__ldGen = g; return 1; }, gen);
      const old = d.sw;
      await old.evaluate((g) => {
        if (self.__ldGen !== g) throw new Error('worker restarted before the reload was sent');
        setTimeout(() => chrome.runtime.reload(), 50);
        return 1;
      }, gen);
      const t0 = Date.now();
      let fresh = null;
      while (!fresh) {
        if (Date.now() - t0 > 20_000) throw new Error('extension did not come back after reload');
        await d.wait(300);
        for (const w of d.ctx.serviceWorkers()) {
          if (w === old || !w.url().startsWith(`chrome-extension://${d.EXT_ID}/`)) continue;
          const tag = await w.evaluate(() => self.__ldGen || null).catch(() => 'dead');
          if (tag === null) { fresh = w; break; }
        }
      }
      d.sw = fresh;
      d.loadedBuild = disk;
      // No page load. The extension re-injects its isolated scripts into open
      // tabs on reload (reinjectOpenTabs), the same path a user's update takes.
      // Wait for the new content script to speak on this page.
      let contentBack = null;
      for (const until = Date.now() + 20_000; Date.now() < until && !contentBack; await d.wait(300)) {
        // 'standdown' is the OLD script tearing down; anything else is the new one.
        const ev = d.ring.find((e) => e.t > t0 && e.src === 'papertrench-content' && e.type !== 'standdown');
        if (ev) contentBack = { type: ev.type, afterMs: ev.t - t0 };
      }
      const hosts = await d.main.evaluate(() => document.querySelectorAll('#papertrench-host').length).catch(() => null);
      const bridgeStale = d.pageMainHash !== d.mainWorldHash();
      const st = await readState();
      return {
        loaded: d.loadedBuild, reloadMs: Date.now() - t0, pageReloaded: false,
        contentBack, overlayHosts: hosts,
        // Page-world files changed since this page loaded: their new code runs
        // only after a refresh. Ask the person at the window to press F5.
        bridgeStale,
        journalEntries: (st.journal || []).length, positions: Object.keys(st.positions || {}).length,
      };
    },

    /** Go somewhere on the same site by clicking a matching link on screen; refused if there is none. */
    async open({ path: target }) {
      if (!target) throw new d.Refusal('BAD_ARGS', 'open needs --path');
      const href = sameSiteTarget(d.main.url(), target);
      if (!href) throw new d.Refusal('OFF_SITE', `open only navigates within ${new URL(d.main.url()).hostname}`);
      const u = new URL(href);
      const link = await d.main.evaluate(([p, s]) => {
        const a = [...document.querySelectorAll('a[href]')].find((x) => { const h = new URL(x.href, location.href); return h.pathname === p && (!s || h.search === s) && x.getBoundingClientRect().width; });
        if (!a) return null;
        a.scrollIntoView({ block: 'center' });
        const r = a.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }, [u.pathname, u.search]);
      if (link) {
        await d.main.mouse.click(link.x, link.y);
        await d.main.waitForURL((x) => x.pathname === u.pathname, { timeout: 10_000 }).catch(() => {});
        await d.wait(1500);
        return { method: 'click', url: d.main.url() };
      }
      // Never a typed-URL load: people get around by clicking.
      throw new d.Refusal('NOT_ON_SCREEN', `no visible link to ${u.pathname}${u.search}; navigate by clicks (open-row, back) instead`);
    },

    /** History back/forward, refused when it would leave the site (e.g. to the
     *  blank page the session started on). */
    async back() { return historyStep(-1); },
    async forward() { return historyStep(1); },

    /** Click a Pulse row to open the coin in this tab, on a spot that is not a
     *  link or button inside the row (socials, copy icons). */
    async 'open-row'({ mint }) {
      const pt = await d.main.evaluate((addr) => {
        const r = document.querySelector(`[data-pulse-token-address="${addr}"]`);
        if (!r) return { missing: true };
        r.scrollIntoView({ block: 'center' });
        const rc = r.getBoundingClientRect();
        const bad = (el) => !el || !r.contains(el) || el.closest('a,button,[role="button"],[role="link"],input,svg,.pt-rowbuy');
        for (const fy of [0.5, 0.3, 0.7, 0.15, 0.85]) {
          for (const fx of [0.45, 0.55, 0.35, 0.65, 0.25, 0.75]) {
            const x = rc.left + rc.width * fx, y = rc.top + rc.height * fy;
            if (!bad(document.elementFromPoint(x, y))) return { x, y };
          }
        }
        return { noSpot: true };
      }, mint);
      if (pt.missing) throw new d.Refusal('NOT_FOUND', `row ${mint} is not on screen`);
      if (pt.noSpot) throw new d.Refusal('NOT_FOUND', `row ${mint} has no plain spot to click`);
      const from = d.main.url();
      await d.main.mouse.click(pt.x, pt.y);
      await d.main.waitForURL((u) => u.href !== from, { timeout: 10_000 }).catch(() => {});
      await d.wait(2000);
      const url = d.main.url();
      if (url === from) throw new d.Refusal('NOT_FOUND', 'row click did not open the coin', { url });
      return { url };
    },

    async chips({ filter }) { return { chips: await listChips(filter) }; },

    /** Tap a Pulse row's quick-buy chip and report what got booked against what the row showed. */
    async 'chip-buy'({ mint, index = 0, filter, unheld = false, watch = 70_000 }) {
      // Judged by END STATE, not a fixed window: a fill, a message from the
      // extension, or the timeout (an armed buy can legitimately wait ~60 s).
      let chips = await listChips(filter);
      if (unheld) {
        const held = new Set(Object.keys((await readState()).positions || {}));
        chips = chips.filter((c) => !held.has(c.mint));
      }
      const target = mint ? chips.find((c) => c.mint === mint) : chips[Number(index)];
      if (!target) throw new d.Refusal('NOT_FOUND', 'no matching visible chip', { visible: chips.map((c) => [c.mint.slice(0, 6), c.mc]) });
      const mcText = await rowMcap(target.mint);
      const t0 = Date.now();
      // The Pulse worker's last print for this coin before the tap, so a fill
      // can be judged against the row AND the feed that priced it.
      const feed = d.ring.filter((e) => e.type === 'row-tick' && e.t < t0
        && (e.payload?.mint === target.mint || e.payload?.pairAddress === target.mint)).pop();
      const feedAtTap = feed ? { mcap: feed.payload.mcap, ageMs: t0 - feed.t } : null;
      await d.main.mouse.click(target.x, target.y);
      const deadline = t0 + Number(watch);
      let fills = [], endState = 'timeout', outcome = null;
      const END_TOAST = /released|expired|refused|disagree|couldn|failed|needs a real tap|queue full|not enough|guard/i;
      while (Date.now() < deadline) {
        fills = (await journalFor(target.mint, t0, 5)).map(fillView);
        if (fills.length) { endState = 'filled'; break; }
        const line = eventsSince(t0, ['console']).map((e) => /row-buy source=(\S+) outcome=(\S+)/.exec(e.payload.text)).filter(Boolean).pop();
        if (line) outcome = { source: line[1], outcome: line[2] };
        const msg = eventsSince(t0, ['toast']).map((e) => e.payload.text).find((t) => END_TOAST.test(t));
        if (msg) { endState = 'message'; break; }
        await d.wait(300);
      }
      await d.wait(300);
      const rowMcUsd = parseMcap(mcText);
      return {
        mint: target.mint,
        rowMcAtTap: mcText,
        feedAtTap,
        endState,
        endMs: Date.now() - t0,
        outcome,
        fills: fills.map((f) => ({ ...f, vsRow: rowMcUsd && f.mcap ? +(f.mcap / rowMcUsd).toFixed(4) : null })),
        bridge: eventsSince(t0, ['row-buy']).map((e) => e.payload),
        toasts: eventsSince(t0, ['toast']).map((e) => e.payload.text),
        console: eventsSince(t0, ['console']).filter((e) => e.payload.world !== 'page').map((e) => e.payload.text.slice(0, 240)).slice(-8),
        build: d.loadedBuild,
      };
    },

    /** Click a button in the PaperTrench panel by its exact label (e.g. "0.1 SOL", "25%"). */
    async 'panel-click'({ label, mint, watch = 5000 }) {
      if (!label) throw new d.Refusal('BAD_ARGS', 'panel-click needs --label');
      const t0 = Date.now();
      let pt = null;
      while (!pt && Date.now() - t0 < 30_000) { pt = await panelButton(String(label)); if (!pt) await d.wait(200); }
      if (!pt) throw new d.Refusal('NOT_FOUND', `no visible panel button "${label}"`);
      const clickedAt = Date.now();
      await d.main.mouse.click(pt.x, pt.y);
      const fills = mint ? await watchFills(mint, clickedAt, Number(watch)) : (await d.wait(Number(watch)), []);
      return {
        label, waitedForButtonMs: clickedAt - t0, fills,
        title: await d.main.title().catch(() => ''),
        toasts: eventsSince(clickedAt, ['toast']).map((e) => e.payload.text),
        build: d.loadedBuild,
      };
    },

    /** Recorded events; --wait N first records for N ms. */
    async events({ types, mint, since, wait: w = 0, limit = 200 }) {
      const t0 = Date.now();
      if (w) await d.wait(Number(w));
      const tl = types ? String(types).split(',') : null;
      const from = since !== undefined ? Number(since) : (w ? t0 : 0);
      let evs = d.ring.filter((e) => e.t >= from && (!tl || tl.includes(e.type)));
      if (mint) evs = evs.filter((e) => e.payload && (e.payload.mint === mint || e.payload.address === mint || e.payload.pairAddress === mint));
      return { count: evs.length, events: evs.slice(-Number(limit)) };
    },

    async journal({ mint, n = 10, since = 0 }) { return { entries: (await journalFor(mint, Number(since), Number(n))).map(fillView) }; },

    async positions() {
      const st = await readState();
      return { cash: st.cash ?? st.balance, positions: Object.entries(st.positions || {}).map(([k, p]) => ({ mint: k, symbol: p.symbol, chain: p.chain, qty: p.qty, costSol: p.costSol ?? p.cost })) };
    },

    async 'eval-page'({ code }) { return { value: await d.main.evaluate(`(async () => { ${code} })()`) }; },
    async 'eval-sw'({ code }) { return { value: await d.swEval(`(async () => { ${code} })()`) }; },

    async screenshot({ name = 'shot' }) {
      const file = path.join(d.STATE_DIR, 'shots', String(name).replace(/[^\w.-]/g, '_') + '.png');
      await d.main.screenshot({ path: file });
      return { file };
    },

    async stop() { setTimeout(d.shutdown, 100); return { stopping: true }; },
  };
}
