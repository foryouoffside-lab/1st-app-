// lib/progressStore.js
// SkillDrills Pro — All Game Progress Storage
// Stores: best scores, XP, streak, session history. Everything lives locally
// on the device — solo drill practice only counts toward the player's own
// level/profile, never a leaderboard (the real leaderboard is Arena duel
// wins, tracked separately in lib/challengeEngine.js).

import { Storage } from './storage';
import { calcSessionXP } from './scoringEngine';
import { completeDailyChallenge, isTodaysDailyDrill, todayStr } from './dailyChallenge';
import { getTrainingFocus, getDailyMission } from './playerJourney';
import { logEvent } from './analytics';

// ─── Storage Keys ──────────────────────────────────────────────────────────
const KEYS = {
  SCORES:    'sd_scores',      // { drillId: { best, last, attempts, firstPlayed } }
  XP:        'sd_xp',          // number — total XP earned lifetime
  STREAK:    'sd_streak',      // { current, longest, lastDate }
  HISTORY:   'sd_history',     // { drillId: [{ score, accuracy, combo, date }] } (last 30/drill)
  SETTINGS:  'sd_settings',    // { soundEnabled: true }
  MISSION_BONUS: 'sd_mission_bonus', // { date, focusId } — today's mission-complete XP already granted
};

const MAX_HISTORY_PER_DRILL = 30;
const STREAK_MILESTONES = [3, 7, 14, 30];

function dispatchCelebration(detail) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('sd:celebration', { detail }));
}

// ─── SCORES ────────────────────────────────────────────────────────────────

/**
 * Get progress for a specific drill.
 * @param {string} drillId
 * @returns {Promise<{ best: number, last: number, attempts: number, firstPlayed: string|null }>}
 */
export async function getDrillProgress(drillId) {
  const scores = await Storage.getJSON(KEYS.SCORES, {});
  return scores[drillId] || { best: 0, last: 0, attempts: 0, firstPlayed: null };
}

/**
 * Get progress for all drills at once.
 * @returns {Promise<Object>} { drillId: { best, last, attempts, firstPlayed } }
 */
export async function getAllDrillProgress() {
  return await Storage.getJSON(KEYS.SCORES, {});
}

/**
 * Save the result of a completed drill session.
 * Updates best score, last score, attempt count, and session history.
 *
 * @param {Object} params
 * @param {string}  params.drillId
 * @param {string}  params.drillName
 * @param {string}  params.category
 * @param {number}  params.finalScore       — post-bonus score
 * @param {number}  params.accuracy         — 0–100
 * @param {number}  params.bestCombo
 * @param {boolean} params.isDailyChallenge
 *
 * @returns {Promise<{ isNewBest: boolean, firstPlay: boolean, xpEarned: number, xpBreakdown: string[], streakMilestone: number|null, missionComplete: boolean, leveledUp: number|null }>}
 */
export async function saveDrillResult({
  drillId,
  drillName,
  category,
  finalScore,
  accuracy,
  bestCombo,
  isDailyChallenge = false,
}) {
  const completedDaily = isDailyChallenge || await isTodaysDailyDrill(drillId);
  // --- Scores ---
  const scores = await Storage.getJSON(KEYS.SCORES, {});
  const prev = scores[drillId] || { best: 0, last: 0, attempts: 0, firstPlayed: null };
  const isNewBest  = finalScore > prev.best;
  const firstPlay  = prev.attempts === 0;

  scores[drillId] = {
    best:        isNewBest ? finalScore : prev.best,
    last:        finalScore,
    attempts:    prev.attempts + 1,
    firstPlayed: prev.firstPlayed || new Date().toISOString(),
    lastPlayed:  new Date().toISOString(),
    drillName:   drillName || prev.drillName || drillId,
    category:    category || prev.category || 'general',
  };
  await Storage.setJSON(KEYS.SCORES, scores);

  // --- History ---
  const history = await Storage.getJSON(KEYS.HISTORY, {});
  if (!history[drillId]) history[drillId] = [];
  history[drillId].unshift({
    score:    finalScore,
    accuracy,
    combo:    bestCombo,
    date:     new Date().toISOString(),
  });
  if (history[drillId].length > MAX_HISTORY_PER_DRILL) {
    history[drillId] = history[drillId].slice(0, MAX_HISTORY_PER_DRILL);
  }
  await Storage.setJSON(KEYS.HISTORY, history);

  // --- Streak ---
  const streakMilestone = await _updateStreak();

  // A daily challenge should resolve from the result itself. This keeps the
  // home dashboard correct even when a drill does not pass a special flag.
  // Only a *new* completion (not a replay of an already-completed slot) earns
  // the daily-challenge XP bonus below.
  let dailyXpEligible = false;
  let dailyChallengeSetComplete = false;
  if (completedDaily) {
    const result = await completeDailyChallenge(drillId);
    dailyXpEligible = result.isNewCompletion;
    dailyChallengeSetComplete = result.isNewCompletion && result.allComplete;
  }

  // --- Daily training mission bonus (once per day, when the last mission
  // drill for the player's chosen focus completes) ---
  let missionComplete = false;
  const focus = getTrainingFocus();
  if (focus) {
    const mission = getDailyMission(scores, focus);
    if (mission.total > 0 && mission.completeCount === mission.total) {
      const todayKey = todayStr();
      const bonusRecord = await Storage.getJSON(KEYS.MISSION_BONUS, null);
      const alreadyAwarded = bonusRecord?.date === todayKey && bonusRecord?.focusId === focus.id;
      if (!alreadyAwarded) {
        missionComplete = true;
        await Storage.setJSON(KEYS.MISSION_BONUS, { date: todayKey, focusId: focus.id });
      }
    }
  }

  // --- XP ---
  const { xp, breakdown } = calcSessionXP({
    finalScore,
    accuracy,
    isNewBest,
    firstPlay,
    dailyChallenge: dailyXpEligible,
    dailyChallengeSetComplete,
    streakMilestone,
    missionComplete,
  });
  const currentXP = await Storage.getJSON(KEYS.XP, 0);
  const levelBefore = Math.floor(currentXP / 1000) + 1;
  const newXP = currentXP + xp;
  const levelAfter = Math.floor(newXP / 1000) + 1;
  await Storage.setJSON(KEYS.XP, newXP);
  const leveledUp = levelAfter > levelBefore ? levelAfter : null;

  if (dailyXpEligible || streakMilestone || missionComplete || leveledUp) {
    dispatchCelebration({
      dailyChallengeCompleted: dailyXpEligible,
      dailyChallengeSetComplete,
      streakMilestone,
      missionComplete,
      leveledUp,
      xpEarned: xp,
    });
  }

  // The one event that actually answers "which drills do people play" —
  // everything else in this app funnels through this function (see
  // components/DrillWrapper.js and friends), so this is the single place
  // to log it rather than touching every individual drill file.
  logEvent('drill_completed', {
    drill_id: drillId,
    category: category || 'general',
    score: finalScore,
    is_new_best: isNewBest,
    is_daily_challenge: completedDaily,
  });

  return { isNewBest, firstPlay, xpEarned: xp, xpBreakdown: breakdown, streakMilestone, missionComplete, leveledUp };
}

// ─── XP ────────────────────────────────────────────────────────────────────

/**
 * Get total XP.
 * @returns {Promise<number>}
 */
export async function getTotalXP() {
  return await Storage.getJSON(KEYS.XP, 0);
}

/**
 * Get player level from XP (1 level per 1000 XP).
 * @returns {Promise<{ level: number, xp: number, xpInLevel: number, xpToNext: number }>}
 */
export async function getPlayerLevel() {
  const xp = await getTotalXP();
  const level = Math.floor(xp / 1000) + 1;
  const xpInLevel = xp % 1000;
  return { level, xp, xpInLevel, xpToNext: 1000 - xpInLevel };
}

// ─── STREAK ────────────────────────────────────────────────────────────────

/**
 * @returns {Promise<number|null>} the streak day-count if today's play just
 * reached a milestone (3/7/14/30), otherwise null.
 */
async function _updateStreak() {
  const today = todayStr();
  const streak = await Storage.getJSON(KEYS.STREAK, { current: 0, longest: 0, lastDate: null });

  if (streak.lastDate === today) return null; // Already counted today

  const yesterday = todayStr(new Date(Date.now() - 86400000));
  const isConsecutive = streak.lastDate === yesterday;

  streak.current  = isConsecutive ? streak.current + 1 : 1;
  streak.longest  = Math.max(streak.longest, streak.current);
  streak.lastDate = today;

  await Storage.setJSON(KEYS.STREAK, streak);

  return STREAK_MILESTONES.includes(streak.current) ? streak.current : null;
}

/**
 * Get current play streak.
 * @returns {Promise<{ current: number, longest: number }>}
 */
export async function getStreak() {
  const streak = await Storage.getJSON(KEYS.STREAK, { current: 0, longest: 0, lastDate: null });
  return { current: streak.current, longest: streak.longest };
}

// ─── HISTORY ───────────────────────────────────────────────────────────────

/**
 * Get session history for a drill (most recent first).
 * @param {string} drillId
 * @returns {Promise<Array>}
 */
export async function getDrillHistory(drillId) {
  const history = await Storage.getJSON(KEYS.HISTORY, {});
  return history[drillId] || [];
}

/**
 * Get session history for every drill at once.
 * @returns {Promise<Object>} { drillId: [{ score, accuracy, combo, date }] }
 */
export async function getAllDrillHistory() {
  return await Storage.getJSON(KEYS.HISTORY, {});
}

/**
 * Get all-time best scores across all drills, sorted by score desc.
 * @param {number} limit
 * @returns {Promise<Array<{ drillId, best, attempts }>>}
 */
export async function getTopScores(limit = 20) {
  const scores = await Storage.getJSON(KEYS.SCORES, {});
  return Object.entries(scores)
    .map(([drillId, data]) => ({ drillId, ...data }))
    .sort((a, b) => b.best - a.best)
    .slice(0, limit);
}

/**
 * Count total sessions played across all drills.
 * @returns {Promise<number>}
 */
export async function getTotalSessions() {
  const scores = await Storage.getJSON(KEYS.SCORES, {});
  return Object.values(scores).reduce((sum, d) => sum + (d.attempts || 0), 0);
}

/**
 * Count unique drills played.
 * @returns {Promise<number>}
 */
export async function getDrillsPlayed() {
  const scores = await Storage.getJSON(KEYS.SCORES, {});
  return Object.keys(scores).length;
}

// ─── SETTINGS ──────────────────────────────────────────────────────────────

export async function getSettings() {
  return await Storage.getJSON(KEYS.SETTINGS, { soundEnabled: true });
}

export async function updateSettings(partial) {
  const current = await getSettings();
  await Storage.setJSON(KEYS.SETTINGS, { ...current, ...partial });
}

// ─── CLEAR DATA ────────────────────────────────────────────────────────────

/**
 * Wipe all stored progress. Irreversible.
 */
export async function clearAllProgress() {
  await Promise.all([
    Storage.remove(KEYS.SCORES),
    Storage.remove(KEYS.XP),
    Storage.remove(KEYS.STREAK),
    Storage.remove(KEYS.HISTORY),
  ]);
}

// ─── HELPERS ───────────────────────────────────────────────────────────────

// Legacy leaderboard compat (keeps existing drills that call getPlayerName/saveLeaderboardEntry working)
export function getPlayerName() {
  return 'You'; // No names in this app — just "You"
}
