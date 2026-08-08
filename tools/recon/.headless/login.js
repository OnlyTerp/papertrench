import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const SITES = {
  polymarket: 'https://polymarket.com',
  'hyperliquid-outcomes': 'https://app.hyperliquid.xyz',
  limitless: 'https://limitless.exchange',
};

const site = process.argv[2];
if (!SITES[site]) {
  console.error('usage: node login.js <' + Object.keys(SITES).join('|') + '>');
  process.exit(1);
}

const __repoRoot = process.env.PT_RECON_ROOT || path.resolve(process.cwd(), '..', '..', '..');
const profileDir = process.env.PT_RECON_PROFILE || path.resolve(__repoRoot, 'recon-data', 'profiles', site);
fs.mkdirSync(profileDir, { recursive: true });

console.error(`[login] opening a real browser for ${site}`);
console.error(`  profile will be saved: ${profileDir}`);
console.error('  1. Log in normally (wallet, Google, whatever).');
console.error('  2. Close the browser window.');
console.error('  3. Press Enter here.');

const context = await chromium.launchPersistentContext(profileDir, {
  headless: false,
  args: ['--disable-blink-features=AutomationControlled'],
  viewport: { width: 1440, height: 900 },
  locale: 'en-US',
  timezoneId: 'America/New_York',
});

const page = await context.newPage();
await page.goto(SITES[site], { waitUntil: 'domcontentloaded' });

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', async () => {
  process.stdin.setRawMode(false);
  process.stdin.pause();
  await context.close().catch(() => {});
});

await new Promise((resolve) => {
  context.on('close', resolve);
});

console.error(`[login] profile saved — ${profileDir}`);
console.error(`  next: node tools/recon/.headless/headless-capture.js ${site}`);
