// lib/progressStore.js
// SkillDrills Pro — All Game Progress Storage
// Stores: best scores, XP, streak, session history. Everything lives locally
// on the device — solo drill practice only counts toward the player's own
// level/profile, never a leaderboard (the real leaderboard is Arena duel
// wins, tracked separately in lib/challengeEngine.js).

import { Storage } from './storage';
import { calcSessionXP } from './scoringEngine';
import { completeDailyChallenge, isTodaysDailyDrill, todayStr } from './dailyChallenge';
import { logEvent } from './analytics';
import { getPlayerNameOrNull } from './playerIdentity';

// ─── Storage Keys ──────────────────────────────────────────────────────────
const KEYS = {
  SCORES:    'sd_scores',      // { drillId: { best, last, attempts, firstPlayed } }
  XP:        'sd_xp',          // number — total XP earned lifetime
  STREAK:    'sd_streak',      // { current, longest, lastDate }
  HISTORY:   'sd_history',     // { drillId: [{ score, accuracy, combo, date }] } (last 30/drill)
  SETTINGS:  'sd_settings',    // { soundEnabled: true }
};

const MAX_HISTORY_PER_DRILL = 30;
const STREAK_MILESTONES = [3, 7, 14, 30];

export function dispatchCelebration(detail) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('sd:celebration', { detail }));
}

// ─── SCORES ────────────────────────────────────────────────────────────────

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
 * @returns {Promise<{ isNewBest: boolean, firstPlay: boolean, xpEarned: number, xpBreakdown: string[], streakMilestone: number|null, leveledUp: number|null }>}
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
  // Wrapped: a throw anywhere in the daily-challenge computation (it reads
  // storage and rebuilds the day's picks) must NOT bubble out of
  // saveDrillResult and silently take the streak / XP / score writes down
  // with it — saveLeaderboardEntrySync calls this fire-and-forget with a
  // swallowing .catch, so that failure would be invisible.
  let completedDaily = isDailyChallenge;
  if (!completedDaily) {
    try { completedDaily = await isTodaysDailyDrill(drillId); }
    catch { completedDaily = false; }
  }
  // --- Scores ---
  const scores = await Storage.getJSON(KEYS.SCORES, {});
  const prev = scores[drillId] || { best: 0, last: 0, attempts: 0, firstPlayed: null };
  const isNewBest  = finalScore > prev.best;

  // Did the player actually play, or just open the drill and let the clock run
  // out? Every bonus in calcEndBonuses is proportional to the raw in-game
  // score, so a session where nothing was ever scored comes out at exactly 0.
  // The daily-challenge slot has always used this test; XP, the streak and the
  // mission bonus now use it too, so an idle run cannot farm any of them.
  const playedForReal = (finalScore || 0) > 0;

  // "First play" means the first run that actually SCORED, not the first run
  // recorded. Keyed off `best` rather than `attempts` on purpose: an idle run
  // still increments attempts, so keying off attempts would silently burn the
  // +50 first-play bonus on a run that was awarded no XP at all.
  const firstPlay  = playedForReal && prev.best === 0;

  scores[drillId] = {
    best:        isNewBest ? finalScore : prev.best,
    last:        finalScore,
    attempts:    prev.attempts + 1,
    firstPlayed: prev.firstPlayed || new Date().toISOString(),
    lastPlayed:  new Date().toISOString(),
    // Distinct from lastPlayed: the last time this drill was played to a real
    // score. Today's Mission ticks a drill off from THIS, so opening three
    // drills and letting them time out no longer completes the mission.
    lastScored:  playedForReal ? new Date().toISOString() : (prev.lastScored || null),
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
  // Only a run that scored counts toward the daily streak. Opening a drill and
  // letting it time out used to extend the streak — and could pay a milestone
  // bonus — for doing nothing at all.
  const streakMilestone = playedForReal ? await _updateStreak() : null;

  // A daily challenge should resolve from the result itself. This keeps the
  // home dashboard correct even when a drill does not pass a special flag.
  // Only a *new* completion (not a replay of an already-completed slot) earns
  // the daily-challenge XP bonus below.
  //
  // A daily slot only counts if the player ACTUALLY PLAYED. It used to be
  // credited by the mere existence of a saved session, so opening a daily drill
  // and backing straight out — or dying in the first second — ticked the slot
  // off and paid the 2x daily XP for doing nothing, and the slot could then
  // never be earned properly because it was already marked done.
  //
  // finalScore is a sound test for this: every bonus in calcEndBonuses is
  // proportional to the raw in-game score, so a session where the player never
  // scored comes out at exactly 0 no matter how many lives were left over.
  let dailyXpEligible = false;
  let dailyChallengeSetComplete = false;
  if (completedDaily && playedForReal) {
    try {
      const result = await completeDailyChallenge(drillId);
      dailyXpEligible = result.isNewCompletion;
      // The day's set is three drills again, so finishing the last one is a
      // genuinely separate achievement from the 2x this single run already
      // earned — but only on the run that actually closes it out, never on a
      // replay of a slot that was already ticked.
      dailyChallengeSetComplete = result.isNewCompletion && result.allComplete;
    } catch {
      // Daily bookkeeping failed — the base XP below and the streak above
      // still get banked; only the 2x bonus is missed.
    }
  }

  // A separate "daily training mission" bonus used to be awarded here, for
  // finishing the three drills of the player's chosen focus. That card is
  // gone: today's three drills ARE the mission now (see lib/dailyChallenge.js)
  // and dailyChallengeSetComplete above is what pays for finishing them.
  // Keeping the old bonus would have gone on paying — and firing a "mission
  // complete" toast — for a thing the player can no longer see anywhere.

  // --- XP ---
  // An idle run earns nothing; calcSessionXP returns 0 for any run that never
  // scored. The guard lives in there, not here, because all 24 drills call it
  // directly to render their "+N XP" tile — gating it only on this side would
  // show the player a number they never actually received.
  const { xp, breakdown } = calcSessionXP({
    finalScore,
    accuracy,
    isNewBest,
    firstPlay,
    dailyChallenge: dailyXpEligible,
    dailyChallengeSetComplete,
    streakMilestone,
  });
  const currentXP = await Storage.getJSON(KEYS.XP, 0);
  const levelBefore = Math.floor(currentXP / 1000) + 1;
  const newXP = currentXP + xp;
  const levelAfter = Math.floor(newXP / 1000) + 1;
  await Storage.setJSON(KEYS.XP, newXP);
  const leveledUp = levelAfter > levelBefore ? levelAfter : null;

  if (dailyXpEligible || streakMilestone || leveledUp) {
    dispatchCelebration({
      dailyChallengeCompleted: dailyXpEligible,
      dailyChallengeSetComplete,
      streakMilestone,
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

  return { isNewBest, firstPlay, xpEarned: xp, xpBreakdown: breakdown, streakMilestone, leveledUp };
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

/**
 * Add a flat amount of XP outside the drill-result path — used by the Arena
 * Challenge track (lib/arenaChallenge.js), which earns XP from duel play, not
 * from a solo run. Deliberately does NOT touch streak, best scores or the
 * daily set; the caller fires its own celebration.
 * @param {number} amount
 * @returns {Promise<{ xp: number, leveledUp: number|null }>}
 */
export async function addXp(amount) {
  const add = Math.max(0, Math.round(amount || 0));
  const before = await getTotalXP();
  const after = before + add;
  await Storage.setJSON(KEYS.XP, after);
  const levelBefore = Math.floor(before / 1000) + 1;
  const levelAfter = Math.floor(after / 1000) + 1;
  return { xp: after, leveledUp: levelAfter > levelBefore ? levelAfter : null };
}

// ─── STREAK ────────────────────────────────────────────────────────────────

/**
 * @returns {Promise<number|null>} the streak day-count if today's play just
 * reached a milestone (3/7/14/30), otherwise null.
 */
async function _updateStreak() {
  const today = todayStr();
  const stored = await Storage.getJSON(KEYS.STREAK, null) || {};
  // A stored value from an older/corrupted shape must not turn into NaN and
  // freeze the streak forever — coerce every field to a sane number first.
  const cur = Number.isFinite(stored.current) ? stored.current : 0;
  const longest = Number.isFinite(stored.longest) ? stored.longest : 0;
  const lastDate = typeof stored.lastDate === 'string' ? stored.lastDate : null;

  // Already counted today. Self-heal the one impossible state — a day is
  // marked played but the count is still 0 — so it never sticks at 0/1.
  if (lastDate === today) {
    if (cur < 1) {
      await Storage.setJSON(KEYS.STREAK, { current: 1, longest: Math.max(longest, 1), lastDate: today });
    }
    return null;
  }

  const yesterday = todayStr(new Date(Date.now() - 86400000));
  const next = lastDate === yesterday ? cur + 1 : 1;

  await Storage.setJSON(KEYS.STREAK, {
    current: next,
    longest: Math.max(longest, next),
    lastDate: today,
  });

  return STREAK_MILESTONES.includes(next) ? next : null;
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
// Prefixes owned by this app. Every drill names its own save key, so listing
// individual keys here guarantees the list goes stale the moment someone adds a
// drill or bumps a key's version suffix (skilldrills_quick_dodge_v2 -> _v3 has
// already happened). Sweeping by prefix cannot rot.
const OWNED_KEY_PREFIXES = ['sd_', 'skilldrills_', 'sequenceAim_'];
const OWNED_EXACT_KEYS = ['ghostLinkBestScore'];

function isOwnedKey(key) {
  if (!key) return false;
  if (OWNED_EXACT_KEYS.includes(key)) return true;
  return OWNED_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * Wipe every trace of this device's play data.
 *
 * This used to remove only SCORES/XP/STREAK/HISTORY, which was the smaller half
 * of the problem. Those four go through lib/storage.js, which on Android is
 * Capacitor Preferences — but the DRILLS bypass that adapter and write their own
 * best score, best combo, best level and session count straight to localStorage
 * (skilldrills_*, sequenceAim_*, ghostLinkBestScore). So "Delete Account & Wipe
 * Data" left roughly twenty per-drill records sitting on the device, and the
 * player was told "all associated data have been permanently deleted" while
 * their old bests were still showing on every start card.
 *
 * Both stores are cleared now: the known keys through Storage (so native
 * Preferences is really emptied), and a prefix sweep across localStorage and
 * Preferences for everything the drills wrote directly.
 */
export async function clearAllProgress() {
  // 1. The keys this module owns, through the adapter (Preferences on native).
  await Promise.all(Object.values(KEYS).map((key) => Storage.remove(key)));

  // 2. Sweep localStorage — where every drill actually keeps its bests.
  try {
    if (typeof localStorage !== 'undefined') {
      const doomed = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (isOwnedKey(key)) doomed.push(key);
      }
      doomed.forEach((key) => {
        try { localStorage.removeItem(key); } catch {}
      });
    }
  } catch {}

  // 3. Sweep native Preferences too. On Android the drills' localStorage and
  // this store are two different places, and a key can exist in either.
  try {
    const keys = await Storage.keys();
    await Promise.all(keys.filter(isOwnedKey).map((key) => Storage.remove(key)));
  } catch {}
}

// ─── HELPERS ───────────────────────────────────────────────────────────────

// Legacy leaderboard compat (keeps existing drills that call getPlayerName/saveLeaderboardEntry working)
//
// This used to hardcode 'You' with the note "No names in this app" — true when
// it was written, stale once real Google auth landed. Every drill passes the
// result of this straight to the shared score card, so every card anyone
// shared was signed "You" instead of their username. It now returns the real
// reserved handle (see lib/playerIdentity.js); the 'You' fallback remains for
// the signed-out case, where there is no handle to show.
export function getPlayerName() {
  return getPlayerNameOrNull() || 'You';
}
