#!/usr/bin/env node
'use strict';
// pt-recon autopilot — drives an attached, already-logged-in Chrome through the
// full dossier coverage script: live market pages, resolved market, must-refuse
// routes, list pages. Works alongside `ptrecon.js capture --attach`.

const { spawn } = require('node:child_process');
const { connectToRunning } = require('./lib/cdp');

const SITES = {
  polymarket: {
    base: 'https://polymarket.com',
    liveUrl: async () => {
      const https = require('node:https');
      const fetchJson = (u) => new Promise((resolve, reject) => {
        https.get(u, { headers: { Accept: 'application/json' } }, (res) => {
          let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
        }).on('error', reject).setTimeout(15000, function () { this.destroy(); reject(new Error('timeout')); });
      });
      const live = await fetchJson('https://gamma-api.polymarket.com/events?active=true&closed=false&limit=5');
      const closed = await fetchJson('https://gamma-api.polymarket.com/events?active=true&closed=true&limit=2');
      const slugs = (live || []).map(e => e.slug).filter(Boolean);
      const cslugs = (closed || []).map(e => e.slug).filter(Boolean);
      const out = [];
      for (const s of slugs.slice(0, 3)) out.push({ url: `https://polymarket.com/event/${s}`, dwell: 30000, type: 'live' });
      for (const s of cslugs.slice(0, 1)) out.push({ url: `https://polymarket.com/event/${s}`, dwell: 12000, type: 'resolved' });
      out.push({ url: 'https://polymarket.com/leaderboard', dwell: 8000, type: 'refuse' });
      out.push({ url: 'https://polymarket.com/rewards', dwell: 8000, type: 'refuse' });
      out.push({ url: 'https://polymarket.com/new', dwell: 8000, type: 'list' });
      out.push({ url: 'https://polymarket.com/politics', dwell: 8000, type: 'list' });
      return out;
    },
  },
  'hyperliquid-outcomes': {
    base: 'https://app.hyperliquid.xyz',
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
    base: 'https://limitless.exchange',
    liveUrl: async () => {
      const https = require('node:https');
      const fetchJson = (u) => new Promise((resolve, reject) => {
        https.get(u, { headers: { Accept: 'application/json' } }, (res) => {
          let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
        }).on('error', reject).setTimeout(15000, function () { this.destroy(); reject(new Error('timeout')); });
      });
      let slugs = [];
      try {
        const s = await fetchJson('https://api.limitless.exchange/markets/active/slugs');
        const arr = Array.isArray(s) ? s : (s && Array.isArray(s.data) ? s.data : (s && Array.isArray(s.slugs) ? s.slugs : []));
        slugs = arr.map((x) => (typeof x === 'string' ? x : (x && x.slug ? x.slug : String(x)))).filter((x) => x && typeof x === 'string');
      } catch (e) { /* fall through to hardcoded */ }
      const hard = ['will-btc-hit-100k', 'will-eth-hit-4k', 'will-trump-win-2024', 'hype-hourly-price', 'doge-hourly-price'];
      for (const h of hard) if (!slugs.includes(h)) slugs.push(h);
      const out = [];
      for (const s of slugs.slice(0, 4)) out.push({ url: `https://limitless.exchange/markets/${s}`, dwell: 30000, type: 'live' });
      out.push({ url: 'https://limitless.exchange/leaderboard', dwell: 8000, type: 'refuse' });
      out.push({ url: 'https://limitless.exchange/rewards', dwell: 8000, type: 'refuse' });
      out.push({ url: 'https://limitless.exchange/', dwell: 8000, type: 'list' });
      out.push({ url: 'https://limitless.exchange/crypto', dwell: 8000, type: 'list' });
      return out;
    },
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForLine(proc, needle) {
  return new Promise((resolve, reject) => {
    const onData = (c) => {
      const text = c.toString();
      if (needle && text.includes(needle)) resolve();
    };
    const t = setTimeout(() => { proc.stdout.off('data', onData); proc.stderr.off('data', onData); resolve(); }, 15000);
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('exit', () => { clearTimeout(t); resolve(); });
  });
}

async function main(site) {
  const cfg = SITES[site];
  if (!cfg) throw new Error(`unknown site: ${site}`);

  const urls = await cfg.liveUrl();
  console.error(`[autopilot] ${site}: ${urls.length} pages to visit`);

  // Start pt-recon attach in the background with enough minutes for navigation.
  const totalDwell = urls.reduce((a, s) => a + s.dwell, 0) + 60000; // overhead + buffer
  const minutes = Math.max(6, Math.ceil(totalDwell / 60000));
  const recon = spawn('node', [
    'tools/recon/ptrecon.js', 'capture', '--site', site,
    '--attach', 'http://127.0.0.1:9222',
    '--minutes', String(minutes),
  ], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });

  await waitForLine(recon, 'BROWSE THE SITE');
  await sleep(2500); // let it attach and enable domains

  // Create a fresh tab so pt-recon sees the full lifecycle of each page.
  const { cdp } = await connectToRunning('http://127.0.0.1:9222');
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Network.enable', {}, sessionId);

  for (const step of urls) {
    console.error(`[autopilot] nav → ${step.url} (${step.dwell}ms)`);
    try {
      await cdp.send('Page.navigate', { url: step.url }, sessionId);
      await sleep(2500);
      for (let i = 0; i < 3; i++) {
        await cdp.send('Runtime.evaluate', {
          expression: 'window.scrollBy(0, Math.round(window.innerHeight*0.85))',
        }, sessionId).catch(() => {});
        await sleep(1200);
      }
      await sleep(Math.max(0, step.dwell - 2500 - 3600));
    } catch (e) {
      console.error(`[autopilot] error on ${step.url}: ${e.message}`);
    }
  }

  cdp.close();
  console.error('[autopilot] navigation complete; letting pt-recon finish via its minutes timer');
  // Do not SIGINT — the --minutes timer will clean up and write manifest.json.
  await new Promise((resolve) => recon.on('exit', resolve));
  console.error('[autopilot] pt-recon finished');

  // Find the capture we just made by latest mtime.
  const fs = require('node:fs');
  const path = require('node:path');
  const capRoot = path.join(process.cwd(), 'recon-data', 'sites', site, 'captures');
  const latest = fs.readdirSync(capRoot)
    .filter((d) => fs.statSync(path.join(capRoot, d)).isDirectory())
    .sort((a, b) => fs.statSync(path.join(capRoot, b)).mtimeMs - fs.statSync(path.join(capRoot, a)).mtimeMs)[0];
  if (!latest) throw new Error('no capture directory found');

  console.error(`[autopilot] distilling ${latest}...`);
  const dist = spawn('node', ['tools/recon/ptrecon.js', 'distill', '--site', site, '--capture', path.join(capRoot, latest)], { cwd: process.cwd(), stdio: 'inherit' });
  await new Promise((resolve) => dist.on('exit', resolve));
}

main(process.argv[2] || 'polymarket').catch((e) => { console.error(e.message); process.exit(1); });
