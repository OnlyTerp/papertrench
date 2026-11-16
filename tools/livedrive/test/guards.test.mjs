import test from 'node:test';
import assert from 'node:assert/strict';
import { NavBudget, detectChallenge, parseMcap, parseArgs, sameSiteTarget } from '../lib/guards.mjs';

test('NavBudget refuses past max and frees slots as the window rolls', () => {
  let now = 1_000_000;
  const b = new NavBudget({ max: 2, windowMs: 60_000, now: () => now });
  assert.equal(b.take('refresh').ok, true);
  assert.equal(b.take('load').ok, true);
  const refused = b.take('load');
  assert.equal(refused.ok, false);
  assert.equal(refused.used, 2);
  assert.equal(refused.retryInMs, 60_000);
  assert.equal(b.peek().used, 2, 'a refused take spends nothing');
  now += 60_001;
  assert.equal(b.take('load').ok, true);
  assert.equal(b.peek().used, 1);
});

test('detectChallenge flags Cloudflare interstitials', () => {
  assert.match(detectChallenge({ title: 'Just a moment...' }), /Just a moment/);
  assert.match(detectChallenge({ title: 'Attention Required! | Cloudflare' }), /Attention/);
  assert.match(detectChallenge({ url: 'https://axiom.trade/pulse?__cf_chl_rt_tk=abc' }), /challenge/);
  assert.match(detectChallenge({ bodyText: 'Verify you are human by completing the action below.', hasChallengeFrame: true }), /Verify you are human/i);
  assert.match(detectChallenge({ bodyText: 'axiom.trade needs to review the security of your connection before proceeding. Verify you are human' }), /interstitial/);
});

test('detectChallenge stays quiet on a normal page and on a lone Turnstile widget', () => {
  assert.equal(detectChallenge({ url: 'https://axiom.trade/pulse', title: 'Axiom', bodyText: 'Pulse New Pairs Final Stretch Migrated MC $15.8K' }), null);
  assert.equal(detectChallenge({ title: 'Axiom', bodyText: 'Sign in', hasChallengeFrame: true }), null);
  assert.equal(detectChallenge({ title: 'Axiom', bodyText: 'Verify you are human' }), null, 'wording without the frame or interstitial copy is not enough');
});

test('parseMcap reads row MC text', () => {
  assert.equal(parseMcap('$15.8K'), 15_800);
  assert.equal(parseMcap('9.79K'), 9_790);
  assert.equal(parseMcap('$1.2M'), 1_200_000);
  assert.equal(parseMcap('$987'), 987);
  assert.equal(parseMcap(''), null);
  assert.equal(parseMcap(null), null);
});

test('parseArgs handles flags, key=value and positionals', () => {
  assert.deepEqual(parseArgs(['--index', '2', '--watch=8000', '--dry', 'mint=abc', 'return', '1']), { _: ['return', '1'], index: 2, watch: 8000, dry: true, mint: 'abc' });
});

test('sameSiteTarget only allows https on the current host', () => {
  assert.equal(sameSiteTarget('https://axiom.trade/pulse', '/token/X'), 'https://axiom.trade/token/X');
  assert.equal(sameSiteTarget('https://axiom.trade/pulse', 'https://axiom.trade/discover'), 'https://axiom.trade/discover');
  assert.equal(sameSiteTarget('https://axiom.trade/pulse', 'https://evil.example/'), null);
  assert.equal(sameSiteTarget('https://axiom.trade/pulse', 'http://axiom.trade/'), null);
  assert.equal(sameSiteTarget('about:blank', '/x'), null);
});
