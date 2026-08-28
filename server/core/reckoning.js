/* PaperTrench server — the Friday reckoning (DELIGHT-MAP.md B2).
 *
 * The Sprint closes Monday-to-Monday; clans get a NAMED Friday close — the
 * weekly ritual, not another notification stream. Live-ops law [21]: a
 * sustainable cadence beats event spam — one anchored weekly ritual per
 * community. So the bell is fixed (Friday 20:00 UTC), the window is the
 * SAME shared slice every competitive mode reads (sprint.js owns the week
 * math), and the digest is derived from standing data that already exists —
 * nothing new is stored and nothing new is trusted.
 *
 * THE NO-PNL LAW: the digest is process, never money. A clan's week is told
 * through its score, its rounds, and its board — the same facts the public
 * clan page shows. PnL and roi exist in the underlying entries but the
 * digest builder never copies them out; a test pins the payload shape.
 *
 * IDEMPOTENCE LAW: the bell is a WINDOW, not an instant. It opens Friday
 * 20:00 UTC and the post is claimed by writing the row first (the mark IS
 * the claim), so a retried cron firing, a worker restart, or a second
 * concurrent event can never double-post a clan's week. An outage is
 * absorbed by the window staying open until Saturday 20:00 UTC — after
 * that the week is left unposted (honest absence), never posted late.
 */
'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The bell: Friday 20:00 UTC. getUTCDay: Friday = 5. */
const BELL_UTC = { day: 5, hour: 20 };

/** The post window stays open 24 hours (through Saturday 20:00 UTC) so a
 * deploy or an upstream outage on Friday night doesn't skip the ritual. */
const WINDOW_HOURS = 24;

/** Friday 20:00 UTC of the week containing ts (the Monday-anchored week). */
function bellTs(ts) {
  const t = Math.trunc(Number(ts) || 0);
  const d = new Date(t);
  // This week's Monday 00:00 UTC (sprint.js anchors weeks on Mondays).
  const mondayUtc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
    - ((d.getUTCDay() || 7) - 1) * DAY_MS;
  // Monday + 4 days = Friday 00:00, then + 20h lands the bell.
  return mondayUtc + 4 * DAY_MS + BELL_UTC.hour * 3600000;
}

/** True when ts sits inside [bell, bell + WINDOW_HOURS). */
function isDue(ts) {
  const t = Math.trunc(Number(ts) || 0);
  const bell = bellTs(t);
  return t >= bell && t < bell + WINDOW_HOURS * 3600000;
}

/** week_id for the week whose bell is due at/covering ts. */
function weekIdFor(ts) {
  const { weekIdOf } = require('./sprint.js');
  return weekIdOf(bellTs(ts));
}

/* ---------------------------------------------------------- the digest --- */

/** Discord's embed-field cap; keep the board inside it. */
const BOARD_MAX = 5;

/** The digest: a clan's week told through process only. Consumes the clan's
 * PUBLIC week standing (clan.standing output) — the same shape the public
 * clan page renders. Returns { content, embeds: [embed] }; the caller owns
 * the transport. */
function buildDigest(clan, week, standing) {
  const s = standing || {};
  const lines = [];

  if (!s.ranked) {
    lines.push(`needs ${s.needed ?? 'COUNTING_MEMBERS'} more qualified member(s) to rank`);
  } else if (s.score != null) {
    lines.push(`clan score **${s.score.toFixed(1)}** (mean of the top ${s.counting ? s.counting.length : '5'})`);
  }

  if (Number(s.rounds) > 0) {
    lines.push(`${s.rounds} round${s.rounds === 1 ? '' : 's'} closed this week`);
  } else {
    lines.push('no rounds closed this week yet — the window is still open');
  }

  const top = (Array.isArray(s.counting) ? s.counting : []).slice(0, BOARD_MAX);
  const board = top.length
    ? top.map((m, i) =>
        `${i + 1}. ${m.handle || 'anon'} — score ${Number(m.score) || 0}`)
    : [];

  const embed = {
    title: `The Friday Reckoning — ${clan && clan.name ? clan.name : 'A clan'} [${clan && clan.tag ? clan.tag : ''}]`,
    // One sentence of identity, not a stat dump: the ritual names the week.
    description: `Week ${week && week.weekId ? week.weekId : ''} — the week's ledger, as it stands before the Monday close.`,
    color: 0x8b5cf6,
    fields: [
      { name: 'The week', value: lines.join('\n') || 'nothing to report', inline: false },
      ...(board.length ? [{
        name: 'Top board', value: board.join('\n'), inline: false,
      }] : []),
    ],
    footer: { text: 'PaperTrench — process, never profit' },
    timestamp: new Date(week && week.endTs ? week.endTs : Date.now()).toISOString(),
  };

  return { content: '', embeds: [embed] };
}

module.exports = { BELL_UTC, WINDOW_HOURS, BOARD_MAX, bellTs, isDue, weekIdFor, buildDigest };
