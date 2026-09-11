// lib/progressInsights.js
// SkillDrills — "am I actually getting better" read from real drill history.
//
// Every comparison in here is SAME DRILL vs SAME DRILL. Solo runs only —
// sd_history is written solely by progressStore.saveDrillResult (see the
// header note there), duels never touch it — so two entries for one drill are
// always the same mode and the same scoring rules, which is the only way a
// score delta means anything.
//
// Robustness: a single lucky run should never read as "improvement", so every
// figure is a MEDIAN of a small recent window, compared against the median of
// the window before it. A drill needs at least MIN_RUNS scored sessions before
// it says anything at all.
//
// Honesty caveat baked into the copy elsewhere: these are game-score trends,
// not a measure of real-world ability. Do not phrase them as the latter.

import { Storage } from './storage';
import { DRILL_INDEX } from './drillIndex';

const WINDOW = 5;              // runs per side of the comparison
const MIN_RUNS = WINDOW + 3;   // need a recent window + at least a partial older one

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/**
 * Per-drill score trend. history entries are newest-first (progressStore
 * unshift()s them), so [0..WINDOW) is the recent window.
 *
 * @returns {Promise<Array<{
 *   drillId, name, recent, earlier, deltaPct, direction: 'up'|'down'|'flat',
 *   runs, enough: boolean,
 * }>>}  sorted by |deltaPct| desc, drills with enough data first.
 */
export async function getDrillTrends() {
  const history = await Storage.getJSON('sd_history', {});
  const rows = [];

  for (const drill of DRILL_INDEX) {
    const list = (history[drill.id] || []).filter((e) => typeof e.score === 'number' && e.score > 0);
    const runs = list.length;
    const enough = runs >= MIN_RUNS;

    if (!enough) {
      rows.push({ drillId: drill.id, name: drill.name, recent: 0, earlier: 0, deltaPct: 0, direction: 'flat', runs, enough: false });
      continue;
    }

    const recentScores = list.slice(0, WINDOW).map((e) => e.score);
    const earlierScores = list.slice(WINDOW, WINDOW * 2).map((e) => e.score);
    const recent = median(recentScores);
    const earlier = median(earlierScores);
    const deltaPct = earlier > 0 ? Math.round(((recent - earlier) / earlier) * 100) : 0;
    const direction = deltaPct >= 5 ? 'up' : deltaPct <= -5 ? 'down' : 'flat';

    rows.push({ drillId: drill.id, name: drill.name, recent, earlier, deltaPct, direction, runs, enough: true });
  }

  return rows.sort((a, b) => {
    if (a.enough !== b.enough) return a.enough ? -1 : 1;
    return Math.abs(b.deltaPct) - Math.abs(a.deltaPct);
  });
}

/**
 * A single headline line for the top of the Progress page, or a neutral
 * insufficient-data message when nothing has enough runs yet.
 */
export async function getHeadlineTrend() {
  const trends = await getDrillTrends();
  const withData = trends.filter((t) => t.enough);

  if (withData.length === 0) {
    const anyRuns = trends.some((t) => t.runs > 0);
    return {
      enough: false,
      text: anyRuns
        ? 'Play a drill a few more times and its score trend shows up here.'
        : 'Your score trends appear here once you have a few runs of the same drill.',
    };
  }

  const improving = withData.filter((t) => t.direction === 'up').sort((a, b) => b.deltaPct - a.deltaPct);
  if (improving.length) {
    const t = improving[0];
    return {
      enough: true,
      text: `Your ${t.name} score is up ${t.deltaPct}% — recent runs median ${t.recent.toLocaleString()} vs ${t.earlier.toLocaleString()} before.`,
      drillId: t.drillId,
    };
  }

  // Nothing clearly improving — report the steadiest instead of a decline.
  const steady = withData.sort((a, b) => Math.abs(a.deltaPct) - Math.abs(b.deltaPct))[0];
  return {
    enough: true,
    text: `Your ${steady.name} score is holding steady (recent median ${steady.recent.toLocaleString()}). Keep runs consistent to see a trend.`,
    drillId: steady.drillId,
  };
}
