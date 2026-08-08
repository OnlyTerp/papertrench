import { chromium } from 'playwright';
import { stealth } from '@mr_ozio/playwright-stealth';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

const __repoRoot = process.env.PT_RECON_ROOT || path.resolve(process.cwd(), '..', '..', '..');

const SITES = {
  polymarket: {
    liveUrl: async () => {
      const res = await fetch('https://gamma-api.polymarket.com/events?active=true&closed=false&limit=5');
      const live = await res.json();
      const res2 = await fetch('https://gamma-api.polymarket.com/events?active=true&closed=true&limit=2');
      const closed = await res2.json();
      const slugs = (live || []).map(e => e.slug).filter(Boolean);
      const cslugs = (closed || []).map(e => e.slug).filter(Boolean);
      const out = [];
      for (const s of slugs.slice(0, 3)) out.push({ url: 'https://polymarket.com/event/' + s, dwell: 30000, type: 'live' });
      for (const s of cslugs.slice(0, 1)) out.push({ url: 'https://polymarket.com/event/' + s, dwell: 12000, type: 'resolved' });
      out.push({ url: 'https://polymarket.com/leaderboard', dwell: 8000, type: 'refuse' });
      out.push({ url: 'https://polymarket.com/rewards', dwell: 8000, type: 'refuse' });
      out.push({ url: 'https://polymarket.com/new', dwell: 8000, type: 'list' });
      out.push({ url: 'https://polymarket.com/politics', dwell: 8000, type: 'list' });
      return out;
    },
  },
  'hyperliquid-outcomes': {
    liveUrl: async () => [
      { url: 'https://app.hyperliquid.xyz/outcomes/BTC', dwell: 30000, type: 'live' },
      { url: 'https://app.hyperliquid.xyz/outcomes/ETH', dwell: 25000, type: 'live' },
      { url: 'https://app.hyperliquid.xyz/outcomes/SOL', dwell: 25000, type: 'live' },
      { url: 'https://app.hyperliquid.xyz/trade/BTC', dwell: 10000, type: 'refuse' },
      { url: 'https://app.hyperliquid.xyz/portfolio', dwell: 10000, type: 'refuse' },
      { url: 'https://app.hyperliquid.xyz/outcomes', dwell: 10000, type: 'list' },
    ],
  },
  limitless: {
    liveUrl: async () => {
      const res = await fetch('https://api.limitless.exchange/feed?page=1&limit=30');
      const data = await res.json();
      const slugs = ((data && data.data) || []).map(x => x.data && x.data.slug).filter(Boolean);
      const hard = ['will-btc-hit-100k', 'will-eth-hit-4k', 'will-trump-win-2024', 'hype-hourly-price', 'doge-hourly-price'];
      for (const h of hard) if (!slugs.includes(h)) slugs.push(h);
      const out = [];
      for (const s of slugs.slice(0, 4)) out.push({ url: 'https://limitless.exchange/markets/' + s, dwell: 30000, type: 'live' });
      out.push({ url: 'https://limitless.exchange/leaderboard', dwell: 8000, type: 'refuse' });
      out.push({ url: 'https://limitless.exchange/rewards', dwell: 8000, type: 'refuse' });
      out.push({ url: 'https://limitless.exchange/', dwell: 8000, type: 'list' });
      out.push({ url: 'https://limitless.exchange/crypto', dwell: 8000, type: 'list' });
      return out;
    },
  },
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

async function main(site, opts = {}) {
  if (!SITES[site]) throw new Error('unknown site: ' + site);
  const profileDir = process.env.PT_RECON_PROFILE || path.resolve(__repoRoot, 'recon-data', 'profiles', site);
  const capDir = process.env.PT_RECON_CAP || path.resolve(__repoRoot, 'recon-data', 'sites', site, 'captures', stamp());
  fs.mkdirSync(profileDir, { recursive: true });
  fs.mkdirSync(capDir, { recursive: true });
  const rawDir = path.join(capDir, 'raw');
  const blobDir = path.join(rawDir, 'blobs');
  const snapDir = path.join(rawDir, 'snapshots');
  for (const d of [rawDir, blobDir, snapDir]) fs.mkdirSync(d, { recursive: true });

  const startedAt = new Date().toISOString();
  fs.writeFileSync(path.join(capDir, 'manifest-open.json'), JSON.stringify({ rig: 'pt-recon/0.1.0-headless', site, startedAt, mode: 'headless', headless: true }, null, 2));

  const urls = await SITES[site].liveUrl();
  console.error('[headless] ' + site + ': ' + urls.length + ' pages');

  const timeoutMinutes = parseInt(process.env.PT_RECON_TIMEOUT || '10', 10);

  const chromiumStealth = stealth(chromium, {
    headless: true,
    args: ['--disable-blink-features=AutomationControlled'],
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    geolocation: { latitude: 40.7128, longitude: -74.0060 },
    permissions: ['geolocation'],
  });

  const context = await chromiumStealth.launchPersistentContext(profileDir);
  const page = await context.newPage();

  // Inject the page probe so distiller sees live price ticks. We do not have the
  // CDP __ptrecon binding, so we stream to a local JSONL file.
  const domsigFile = path.join(rawDir, 'domsig.jsonl');
  const domsig = fs.createWriteStream(domsigFile, { flags: 'a' });
  await page.exposeFunction('__ptrecon', (payload) => { domsig.write(payload + '\n'); });
  const { PROBE_SOURCE } = await import(path.join(__repoRoot, 'tools', 'recon', 'lib', 'pageprobe.js'));
  const probeScript = PROBE_SOURCE;
  await page.addInitScript(probeScript);
  // In case the page already loaded, run it now too.
  await page.evaluate(probeScript).catch(() => {});

  const streams = {};
  for (const name of ['events', 'network', 'ws', 'domsig', 'mutations']) {
    streams[name] = fs.createWriteStream(path.join(rawDir, `${name}.jsonl`), { flags: 'a' });
  }
  const counts = { requests: 0, bodies: 0, wsFrames: 0, sseMessages: 0, sigTicks: 0, snapshots: 0, pages: 0 };
  let blobSeq = 0;
  const pending = new Map();
  const wsUrls = new Map();

  const line = (stream, obj) => streams[stream].write(JSON.stringify(obj) + '\n');
  const writeBlob = (prefix, data) => {
    const file = `${String(++blobSeq).padStart(5, '0')}-${prefix.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40)}.bin`;
    fs.writeFileSync(path.join(blobDir, file), data);
    return path.join('blobs', file);
  };

  page.on('request', (req) => {
    counts.requests++;
    const postData = req.postData() || undefined;
    pending.set(req, {
      url: req.url(),
      method: req.method(),
      resourceType: req.resourceType(),
      t: Date.now(),
      postData: typeof postData === 'string' ? postData.slice(0, 65536) : undefined,
      reqHeaders: req.headers(),
    });
  });

  page.on('response', async (res) => {
    const req = res.request();
    const meta = pending.get(req);
    pending.delete(req);
    const lineObj = {
      t: (meta && meta.t) || Date.now(),
      tDone: Date.now(),
      url: req.url(),
      method: req.method(),
      resourceType: req.resourceType(),
      status: res.status(),
      mimeType: res.headers()['content-type'] || '',
      reqHeaders: (meta && meta.reqHeaders) || req.headers(),
      resHeaders: res.headers(),
    };
    if (meta && meta.postData) lineObj.postData = meta.postData;
    try {
      const b = await res.body().catch(() => null);
      if (b && b.length) {
        counts.bodies++;
        lineObj.bodyFile = writeBlob(req.url().slice(0, 60) + '-' + Date.now(), b);
        lineObj.bodyBytes = b.length;
      }
    } catch (e) {
      lineObj.bodyError = e.message.slice(0, 120);
    }
    line('network', lineObj);
  });

  page.on('websocket', (ws) => {
    wsUrls.set(ws.url(), ws);
    line('ws', { t: Date.now(), ev: 'open', url: ws.url() });
    ws.on('framereceived', (payload) => {
      counts.wsFrames++;
      const p = typeof payload === 'string' ? payload : '';
      line('ws', { t: Date.now(), dir: 'in', url: ws.url(), payload: p.length > 128000 ? p.slice(0, 128000) : p, truncated: p.length > 128000 ? p.length : undefined });
    });
    ws.on('framesent', (payload) => {
      counts.wsFrames++;
      const p = typeof payload === 'string' ? payload : '';
      line('ws', { t: Date.now(), dir: 'out', url: ws.url(), payload: p.length > 128000 ? p.slice(0, 128000) : p, truncated: p.length > 128000 ? p.length : undefined });
    });
  });

  page.on('framenavigated', (f) => {
    if (f.parentFrame()) return;
    line('events', { t: Date.now(), ev: 'nav', url: f.url() });
  });

  const finishTimer = setTimeout(() => { console.error('[headless] minutes timeout'); context.close().catch(() => {}); browser.close().catch(() => {}); }, timeoutMinutes * 60 * 1000);

  for (const step of urls) {
    console.error('[headless] nav → ' + step.url);
    try {
      await page.goto(step.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(3000);
      for (let i = 0; i < 3; i++) {
        await page.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 0.85)));
        await sleep(1200);
      }
      const html = await page.content();
      const file = `${Date.now()}-interval-main.html.gz`;
      fs.writeFileSync(path.join(snapDir, file), zlib.gzipSync(html));
      counts.snapshots++;
      line('events', { t: Date.now(), ev: 'snapshot', sid: 'main', file: path.join('snapshots', file), bytes: html.length, url: page.url() });
      await sleep(Math.max(0, step.dwell - 3000 - 3600 - 1000));
    } catch (e) {
      console.error('[headless] error on ' + step.url + ': ' + e.message);
    }
  }

  clearTimeout(finishTimer);
  await context.close().catch(() => {});
  await Promise.all(Object.values(streams).map(s => new Promise(r => s.end(r))));

  const manifest = {
    rig: 'pt-recon/0.1.0-headless', site, mode: 'headless', headless: true, startedAt,
    endedAt: new Date().toISOString(), endReason: 'complete',
    thin: counts.requests === 0,
    counts,
  };
  fs.writeFileSync(path.join(capDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.rmSync(path.join(capDir, 'manifest-open.json'), { force: true });
  console.error('[headless] done → ' + capDir);
}

main(process.argv[2] || 'polymarket').catch(e => { console.error(e); process.exit(1); });
