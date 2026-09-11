// lib/sessionFlow.js
// SkillDrills — presents today's three daily drills as ONE guided session.
//
// This is a thin read-layer over lib/dailyChallenge.js. It does NOT own any
// completion or reward state: what counts as "done" is still decided solely by
// completeDailyChallenge() inside progressStore.saveDrillResult, so retries,
// reloads and re-completions can't duplicate anything through this path.
//
// The only thing this file persists is sd_daily_session — a one-field record
// of whether the player has STARTED today's session, used for the Home CTA's
// "Start" vs "Continue" wording and for the session_start analytics event.
// Losing it is harmless (worst case the CTA says "Start" when "Continue" would
// be truer).

import { Storage } from './storage';
import { getDailyChallenge, todayStr } from './dailyChallenge';
import { getDrillGroup, getGroupMeta } from './drillGroups';
import { drillTimeHint } from './drillMeta';
import { getWeeklyGoal } from './weeklyGoal';

const SESSION_KEY = 'sd_daily_session'; // { date, startedAt }

/** Add the session marker to a drill route so ResultScreen shows the guided flow. */
export function sessionDrillHref(pathOrDrill) {
  const path = typeof pathOrDrill === 'string' ? pathOrDrill : (pathOrDrill?.path || '/drills');
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}session=1`;
}

/** True when the current route is a daily-session run (ResultScreen reads this). */
export function isSessionRoute(searchParams) {
  if (!searchParams) return false;
  const v = searchParams.get ? searchParams.get('session') : searchParams.session;
  return v === '1' || v === 'true';
}

export async function markSessionStarted() {
  const today = todayStr();
  const cur = await Storage.getJSON(SESSION_KEY, null);
  if (cur?.date === today && cur?.startedAt) return false; // already marked
  await Storage.setJSON(SESSION_KEY, { date: today, startedAt: new Date().toISOString() });
  return true;
}

async function wasSessionStarted() {
  const today = todayStr();
  const cur = await Storage.getJSON(SESSION_KEY, null);
  return cur?.date === today && !!cur?.startedAt;
}

// Short, parallel tags — each becomes "<Category> (<tag>)" in the sentence.
const REASON_TAG = {
  weakness:  'your weakest area',
  momentum:  'your strongest area',
  discovery: 'rarely trained',
};

/**
 * A one-line, honest explanation of why these three. Personalised only when
 * the selector actually personalised (a non-'rotation' reason present) and
 * there is enough history behind it; neutral otherwise.
 */
function describeSelection(drills) {
  const personalisedPicks = drills.filter((d) => d.reason && REASON_TAG[d.reason]);
  const groups = drills.map((d) => getGroupMeta(getDrillGroup(d)).name);
  const spread = [...new Set(groups)];

  if (personalisedPicks.length === 0) {
    return {
      personalized: false,
      text: spread.length >= 2
        ? `A balanced set across ${listWords(spread)}. Your picks get personal as your history builds.`
        : `Today's set. Your picks get personal as your history builds.`,
    };
  }

  const parts = personalisedPicks.slice(0, 2).map((d) => {
    const cat = getGroupMeta(getDrillGroup(d)).name;
    return `${cat} (${REASON_TAG[d.reason]})`;
  });
  return {
    personalized: true,
    text: `This set targets ${listWords(parts)}.`,
  };
}

function listWords(arr) {
  if (arr.length <= 1) return arr[0] || '';
  if (arr.length === 2) return `${arr[0]} and ${arr[1]}`;
  return `${arr.slice(0, -1).join(', ')} and ${arr[arr.length - 1]}`;
}

/**
 * Everything Home and Daily need to render the guided session in one call.
 *
 * @param {Object} [opts]
 * @param {string} [opts.assumeDoneId] — treat this drill as already complete
 *   even if its write hasn't landed yet (ResultScreen passes the drill that
 *   just finished, since saveDrillResult is fire-and-forget in the drills).
 */
export async function getSessionState(opts = {}) {
  const { assumeDoneId = null } = opts;
  const [daily, started, weekly] = await Promise.all([
    getDailyChallenge(),
    wasSessionStarted(),
    getWeeklyGoal().catch(() => null),
  ]);

  const drills = daily.drills.map((d, i) => {
    const completed = d.completed || d.id === assumeDoneId;
    return {
      id: d.id,
      name: d.name,
      path: d.path,
      emoji: d.emoji,
      reason: d.reason || 'rotation',
      group: getDrillGroup(d),
      groupName: getGroupMeta(getDrillGroup(d)).name,
      timeHint: drillTimeHint(d.id), // null for endurance drills — never a fake number
      completed,
      index: i,
      href: sessionDrillHref(d.path),
    };
  });

  const completedCount = drills.filter((d) => d.completed).length;
  const allComplete = drills.length > 0 && completedCount === drills.length;
  const nextDrill = drills.find((d) => !d.completed) || null;
  const selection = describeSelection(daily.drills);

  const groups = [...new Set(drills.map((d) => d.groupName))];
  const purpose = groups.length >= 2
    ? `Three drills across ${listWords(groups)}.`
    : `Three drills to train ${groups[0] || 'focus'}.`;

  return {
    date: daily.date,
    drills,
    total: drills.length,
    completedCount,
    allComplete,
    started: started || completedCount > 0,
    nextDrill,
    nextIndex: nextDrill ? nextDrill.index : drills.length,
    purpose,
    explanation: selection.text,
    personalized: selection.personalized,
    // State-specific CTA label — the caller just renders this.
    ctaLabel: allComplete
      ? 'Session complete'
      : (started || completedCount > 0)
        ? `Continue — ${drills.length - completedCount} drill${drills.length - completedCount === 1 ? '' : 's'} left`
        : "Start today's session",
    weekly: weekly ? { completed: weekly.completed, target: weekly.target, allDone: weekly.allDone } : null,
  };
}
