// lib/arenaChallenge.js
// SkillDrills — Arena Challenges: a second daily set, parallel to the daily
// DRILL set (lib/dailyChallenge.js) but cleared by duel play instead of solo
// runs. Same shape as the daily set on purpose: TWO specific drills a day, and
// the goal for each is simply "finish an Arena duel in this drill". Tapping a
// card jumps to the Arena and auto-starts matchmaking for that drill (see the
// `?duel=` deep link in ChallengeArenaClient).
//
// Kept strictly separate from the daily drills:
//   - Playing a duel never ticks a daily-DRILL slot (the `if (!isChallenge)`
//     guard in each duel drill's endGame).
//   - Finishing an Arena Challenge never touches solo streak / best scores —
//     it pays flat XP and fires the celebration toast.
//
// All state is local (device), like the daily set. No server record.

import { Storage } from './storage';
import { todayStr } from './dailyChallenge';
import { addXp, dispatchCelebration } from './progressStore';
import { DUEL_DRILLS } from './challengeEngine';
import { DRILL_INDEX } from './drillIndex';

const ARENA_KEY = 'sd_arena_challenge';
// { date, recordedIds: [challengeId], doneSlugs: [slug], completedAt }

export const ARENA_SET_SIZE = 2;

// Flat XP for finishing one Arena Challenge drill. Sized to read as a "2x"-grade
// reward next to a daily drill's doubled run.
const XP_PER_DRILL = 200;

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  return hash;
}

// The short drill id (last path segment) — matches DRILL_INDEX ids and the
// DRILL_LOGO map in DailyClient.
function shortId(slug) {
  return String(slug || '').split('/').filter(Boolean).pop() || slug;
}

/** Today's two Arena Challenge drills — deterministic, distinct, from DUEL_DRILLS. */
export function drillsForDate(dateStr) {
  const pool = DUEL_DRILLS;
  const n = pool.length;
  if (n === 0) return [];
  const h = hashString(dateStr);
  const first = h % n;
  const second = (first + 1 + ((h >>> 3) % Math.max(1, n - 1))) % n;
  const picks = second === first ? [first] : [first, second];
  return picks.slice(0, ARENA_SET_SIZE).map((i) => {
    const d = pool[i];
    const id = shortId(d.slug);
    const indexEntry = DRILL_INDEX.find((e) => e.id === id);
    return {
      id,
      slug: d.slug,
      name: (indexEntry && indexEntry.name) || d.name,
      emoji: indexEntry && indexEntry.emoji,
      xp: XP_PER_DRILL,
    };
  });
}

function freshState(today) {
  return { date: today, recordedIds: [], doneSlugs: [], completedAt: null };
}

async function loadState(today) {
  const stored = await Storage.getJSON(ARENA_KEY, null);
  if (stored && stored.date === today && Array.isArray(stored.recordedIds)) {
    stored.doneSlugs = Array.isArray(stored.doneSlugs) ? stored.doneSlugs : [];
    return stored;
  }
  return freshState(today);
}

/**
 * Today's Arena Challenge set and how much of it is done.
 * @returns {Promise<{ drills: Array, completedCount: number, total: number, allComplete: boolean, date: string }>}
 */
export async function getArenaChallenge() {
  const today = todayStr();
  const state = await loadState(today);
  const drills = drillsForDate(today).map((d) => ({
    ...d,
    completed: state.doneSlugs.includes(d.slug),
  }));
  const completedCount = drills.filter((d) => d.completed).length;
  return {
    drills,
    completedCount,
    total: drills.length,
    allComplete: drills.length > 0 && completedCount === drills.length,
    date: today,
  };
}

/**
 * Record one finished duel and clear its Arena Challenge slot if the drill is
 * one of today's two. Idempotent per `challengeId` — DrillWrapper's listener
 * calls this on every 'completed' snapshot, for both players.
 *
 * @param {string} challengeId
 * @param {{ drillSlug: string }} outcome  (won/draw/eiqGained accepted but unused now)
 * @returns {Promise<{ completedDrill: object|null, xpAwarded: number, allComplete: boolean }>}
 */
export async function recordArenaMatch(challengeId, { drillSlug = '' } = {}) {
  const today = todayStr();
  const state = await loadState(today);
  const todays = drillsForDate(today);
  const allSlugs = todays.map((d) => d.slug);

  const already = () => ({
    completedDrill: null,
    xpAwarded: 0,
    allComplete: allSlugs.length > 0 && allSlugs.every((s) => state.doneSlugs.includes(s)),
  });

  if (challengeId && state.recordedIds.includes(challengeId)) return already();
  if (challengeId) state.recordedIds.push(challengeId);

  const match = todays.find((d) => d.slug === drillSlug);
  if (!match || state.doneSlugs.includes(match.slug)) {
    await Storage.setJSON(ARENA_KEY, state);
    return already();
  }

  state.doneSlugs.push(match.slug);
  const allComplete = allSlugs.every((s) => state.doneSlugs.includes(s));
  const setJustCompleted = allComplete && !state.completedAt;
  if (setJustCompleted) state.completedAt = new Date().toISOString();

  await Storage.setJSON(ARENA_KEY, state);

  let leveledUp = null;
  try {
    ({ leveledUp } = await addXp(match.xp));
  } catch { /* XP store unavailable — slot still counts */ }
  dispatchCelebration({
    arenaChallengeCompleted: true,
    arenaChallengeSetComplete: setJustCompleted,
    leveledUp,
    xpEarned: match.xp,
  });

  return { completedDrill: match, xpAwarded: match.xp, allComplete };
}
