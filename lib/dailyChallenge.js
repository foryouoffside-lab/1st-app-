import { Storage } from './storage';
import { DRILL_INDEX } from './drillIndex';
import { SUB_GROUPS, getDrillGroup } from './drillGroups';
import { getTrainingFocus } from './playerJourney';
// Reads only — computeGroupStats() runs the numbers behind today's picks off
// each drill's local score/history data. progressStore.js imports back from
// this file (completeDailyChallenge/isTodaysDailyDrill/todayStr), so this is
// a deliberate two-way import between the two modules; safe because neither
// side calls the other's functions at module load time, only later, from
// inside async functions triggered by user action.
import { getAllDrillProgress, getAllDrillHistory } from './progressStore';

const DAILY_KEY       = 'sd_daily_challenge';        // { date, drillId, completed, completedAt }
const MULTI_DAILY_KEY = 'sd_daily_challenges_multi';  // { date, completedIds: [] }
const DAILY_POOL_KEY  = 'sd_daily_pool';              // { date, drills: [{...drill, reason}] }

// Below this many total local sessions (or with fewer than 2 sub-groups
// played at all), there isn't enough signal to personalize responsibly —
// fall back to the plain random rotation until there's real data.
const COLD_START_MIN_SESSIONS = 6;
// A sub-group needs at least this many scored sessions before its average
// accuracy is trusted enough to call it "weakest" — one unlucky run
// shouldn't brand a whole skill area as a weak spot.
const MIN_SAMPLES_FOR_WEAKNESS = 2;

// Maps the existing manual "Training Focus" picker (playerJourney.js) onto
// the sub-group ids used here, so an explicit user choice can pin a slot.
const FOCUS_TO_GROUP = { memory: 'memory', speed: 'processing-speed', focus: 'focus' };

// Derived from DRILL_INDEX (the real, live drill list) instead of a hand-maintained
// array, so this pool can't drift into pointing at deleted/renamed drills again.
const CHALLENGE_POOL = DRILL_INDEX.map(d => ({
  id: d.id,
  name: d.name,
  category: d.category,
  path: d.path,
  emoji: d.emoji,
}));

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/**
 * Local (device) calendar day as "YYYY-MM-DD". This is the one canonical
 * "what day is it" used across daily challenge, streak, and mission logic —
 * always local time, never UTC, so it matches what the player sees on their clock.
 */
export function todayStr(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Deterministic, content-agnostic selection of 3 different drills for a
 * given date. Used as the cold-start fallback before there's enough local
 * history to personalize, and as the tie-breaker for which specific drill
 * represents a chosen sub-group on a given day.
 */
export function getDailyChallengesList(dateStr) {
  const idx1 = hashString(dateStr) % CHALLENGE_POOL.length;
  let idx2 = hashString(dateStr + '_2') % CHALLENGE_POOL.length;
  if (idx2 === idx1) idx2 = (idx2 + 1) % CHALLENGE_POOL.length;

  let idx3 = hashString(dateStr + '_3') % CHALLENGE_POOL.length;
  if (idx3 === idx1 || idx3 === idx2) {
    idx3 = (idx3 + 1) % CHALLENGE_POOL.length;
    if (idx3 === idx1 || idx3 === idx2) {
      idx3 = (idx3 + 1) % CHALLENGE_POOL.length;
    }
  }

  return [
    CHALLENGE_POOL[idx1],
    CHALLENGE_POOL[idx2],
    CHALLENGE_POOL[idx3],
  ];
}

function pickDrillForGroup(dateStr, groupId) {
  const candidates = CHALLENGE_POOL.filter(d => getDrillGroup(d) === groupId);
  if (candidates.length === 0) return null;
  const idx = hashString(`${dateStr}_${groupId}`) % candidates.length;
  return candidates[idx];
}

/**
 * Average accuracy and total play count per cognitive sub-group (Attention,
 * Focus, Memory, Problem Solving, Processing Speed), computed from this
 * device's own local score/history data. Accuracy (0-100) is the one metric
 * every drill already reports on the same scale, regardless of how wildly
 * each drill's raw score numbers differ — that's what makes it usable as a
 * fair cross-drill "how good am I at this domain" signal.
 */
async function computeGroupStats() {
  const [progress, historyMap] = await Promise.all([getAllDrillProgress(), getAllDrillHistory()]);

  const stats = {};
  for (const group of SUB_GROUPS) {
    if (group.id === 'all') continue;
    stats[group.id] = { attempts: 0, accuracySum: 0, accuracyCount: 0 };
  }

  for (const drill of DRILL_INDEX) {
    const bucket = stats[getDrillGroup(drill)];
    if (!bucket) continue;

    bucket.attempts += progress[drill.id]?.attempts || 0;

    for (const entry of historyMap[drill.id] || []) {
      if (typeof entry.accuracy === 'number') {
        bucket.accuracySum += entry.accuracy;
        bucket.accuracyCount += 1;
      }
    }
  }

  return stats;
}

/**
 * Build today's 3 drills from the player's own local performance, mixing
 * three roles rather than only ever targeting weaknesses — pure "eat your
 * vegetables" drilling reads as remedial and hurts retention:
 *  - weakness:  lowest average accuracy sub-group  → real growth
 *  - momentum:  most-played sub-group              → a win they're good at
 *  - discovery: least-played (or never played)      → breadth + more signal
 * An explicit Training Focus (playerJourney.js), if set, pins its sub-group
 * first so that deliberate user choice always wins over the algorithm.
 * @returns {Promise<Array|null>} 3 drills with a `reason` tag, or null if
 * there isn't enough local history yet to personalize responsibly.
 */
async function buildPersonalizedPool(dateStr) {
  const stats = await computeGroupStats();
  const groupIds = SUB_GROUPS.filter(g => g.id !== 'all').map(g => g.id);

  const totalSessions = groupIds.reduce((sum, id) => sum + stats[id].attempts, 0);
  const playedGroups = groupIds.filter(id => stats[id].attempts > 0);
  if (totalSessions < COLD_START_MIN_SESSIONS || playedGroups.length < 2) {
    return null;
  }

  const weakestGroup = groupIds
    .filter(id => stats[id].accuracyCount >= MIN_SAMPLES_FOR_WEAKNESS)
    .sort((a, b) => (stats[a].accuracySum / stats[a].accuracyCount) - (stats[b].accuracySum / stats[b].accuracyCount))[0] || null;

  const mostPlayedGroup = [...groupIds].sort((a, b) => stats[b].attempts - stats[a].attempts)[0];
  const leastPlayedGroup = [...groupIds].sort((a, b) => stats[a].attempts - stats[b].attempts)[0];

  const focus = getTrainingFocus();
  const focusGroup = focus ? FOCUS_TO_GROUP[focus.id] : null;

  const picked = [];
  const tryAdd = (groupId, reason) => {
    if (groupId && picked.length < 3 && !picked.some(p => p.groupId === groupId)) {
      picked.push({ groupId, reason });
    }
  };

  tryAdd(focusGroup, 'focus');
  tryAdd(weakestGroup, 'weakness');
  tryAdd(mostPlayedGroup, 'momentum');
  tryAdd(leastPlayedGroup, 'discovery');
  for (const id of groupIds) {
    tryAdd(id, 'discovery');
  }

  const drills = picked
    .map(({ groupId, reason }) => {
      const drill = pickDrillForGroup(dateStr, groupId);
      return drill ? { ...drill, reason } : null;
    })
    .filter(Boolean);

  return drills.length === 3 ? drills : null;
}

/**
 * Today's 3 drills, personalized once local history is rich enough,
 * otherwise the plain random rotation. Computed once per calendar day and
 * cached locally so it stays stable across reloads within the same day,
 * regardless of sessions played later that same day.
 */
export async function getTodaysDrillPool() {
  const today = todayStr();
  const cached = await Storage.getJSON(DAILY_POOL_KEY, null);
  if (cached?.date === today && Array.isArray(cached.drills) && cached.drills.length === 3) {
    return cached.drills;
  }

  const personalized = await buildPersonalizedPool(today);
  const drills = personalized || getDailyChallengesList(today).map(d => ({ ...d, reason: 'random' }));

  await Storage.setJSON(DAILY_POOL_KEY, { date: today, drills });
  return drills;
}

/**
 * Get today's daily challenge drill (primary variant).
 */
export async function getDailyChallenge() {
  const today = todayStr();
  const pool = await getTodaysDrillPool();
  const drill = pool[0];

  const stored = await Storage.getJSON(DAILY_KEY, null);
  const completed   = stored?.date === today && stored?.completed === true;
  const completedAt = completed ? stored.completedAt : null;

  return { drill, completed, completedAt, date: today };
}

/**
 * Get all 3 today's daily challenges and their completion statuses.
 */
export async function getDailyChallenges() {
  const today = todayStr();
  const drills = await getTodaysDrillPool();

  const stored = await Storage.getJSON(MULTI_DAILY_KEY, null);
  const completedIds = stored?.date === today ? (stored?.completedIds || []) : [];

  return drills.map(drill => ({
    drill,
    completed: completedIds.includes(drill.id),
    date: today
  }));
}

/**
 * Read-only preview of what completing `drillId` right now would mean for
 * today's daily challenges — WITHOUT marking anything complete. Drills use
 * this to compute an accurate on-screen XP number (2x for a daily-challenge
 * drill, plus the all-3-complete bonus when this session would be the one
 * that finishes the set) that matches what completeDailyChallenge() will
 * actually persist moments later via saveDrillResult(). Deliberately
 * non-mutating so it can never race with (or double-count against) that
 * real completion write — completeDailyChallenge() alone remains the single
 * source of truth for persisted state.
 * @returns {Promise<{ isDailyDrill: boolean, wouldCompleteSet: boolean }>}
 */
export async function previewDailyCompletion(drillId) {
  const today = todayStr();
  const pool = await getTodaysDrillPool();
  const isDailyDrill = pool.some(d => d.id === drillId);
  if (!isDailyDrill) return { isDailyDrill: false, wouldCompleteSet: false };

  const stored = await Storage.getJSON(MULTI_DAILY_KEY, null);
  const completedIds = stored?.date === today ? (stored?.completedIds || []) : [];
  const alreadyCompleted = completedIds.includes(drillId);
  const wouldCompleteSet = !alreadyCompleted &&
    pool.every(d => d.id === drillId || completedIds.includes(d.id));

  return { isDailyDrill: !alreadyCompleted, wouldCompleteSet };
}

/**
 * Mark a daily challenge as complete.
 * @param {string} [drillId] — which drill was just completed. Falls back to the
 * primary (legacy single-daily) drill when omitted.
 * @returns {Promise<{ isNewCompletion: boolean, allComplete: boolean }>}
 */
export async function completeDailyChallenge(drillId) {
  const today = todayStr();
  const pool = await getTodaysDrillPool();
  const primaryDrill = pool[0];
  const targetId = drillId || primaryDrill.id;

  // Only credit drills that are actually part of today's 3-drill pool —
  // playing an unrelated drill shouldn't be able to complete a daily slot.
  if (!pool.some(d => d.id === targetId)) {
    return { isNewCompletion: false, allComplete: false };
  }

  // Maintain old compatibility for the single daily key
  if (targetId === primaryDrill.id) {
    await Storage.setJSON(DAILY_KEY, {
      date:        today,
      drillId:     primaryDrill.id,
      completed:   true,
      completedAt: new Date().toISOString(),
    });
  }

  // Multi daily key update
  const stored = await Storage.getJSON(MULTI_DAILY_KEY, null);
  let completedIds = stored?.date === today ? (stored?.completedIds || []) : [];
  const isNewCompletion = !completedIds.includes(targetId);
  if (isNewCompletion) {
    completedIds.push(targetId);
  }
  await Storage.setJSON(MULTI_DAILY_KEY, {
    date: today,
    completedIds
  });

  return { isNewCompletion, allComplete: completedIds.length >= pool.length };
}

/**
 * Check if a completed drill is one of today's daily challenges.
 */
export async function isTodaysDailyDrill(drillId) {
  const pool = await getTodaysDrillPool();
  return pool.some(d => d.id === drillId);
}

/**
 * Get milliseconds until midnight.
 */
export function msUntilMidnight() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  return midnight - now;
}
