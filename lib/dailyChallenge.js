import { Storage } from './storage';
import { DRILL_INDEX } from './drillIndex';
import { SUB_GROUPS, getDrillGroup } from './drillGroups';
// Reads only — computeGroupStats() runs the numbers behind today's picks off
// each drill's local score/history data. progressStore.js imports back from
// this file (completeDailyChallenge/isTodaysDailyDrill/todayStr), so this is
// a deliberate two-way import between the two modules; safe because neither
// side calls the other's functions at module load time, only later, from
// inside async functions triggered by user action.
import { getAllDrillProgress, getAllDrillHistory } from './progressStore';

// ─────────────────────────────────────────────────────────────────────────────
// TODAY — THREE DRILLS, ONE CARD
// ─────────────────────────────────────────────────────────────────────────────
//
// One daily set of three drills, stable for the calendar day, owned entirely
// by this file. (It used to share the home screen with a separate "Today's
// Mission" checklist built from a player-chosen focus area — both that card
// and the focus feature are gone now.)
//
// The three slots are drawn differently from each other, because three picks
// made the same way would just be a longer list of one idea:
//
//   slots 1-3  ROLE picks — weakness, momentum or discovery, selected by the
//              date so the set differs day to day inside a stable skill
//              profile, and spread across categories so it isn't three drills
//              from one corner of the catalogue.
//
// Every slot falls back to plain deterministic rotation when there isn't
// enough local history to personalize honestly, and no drill can appear twice
// in the same day's set.

const DAILY_KEY    = 'sd_daily_challenge';  // { date, completedIds: [...], completedAt }
const DAILY_PICK   = 'sd_daily_pick';       // { date, drills: [...] }
const RECENT_KEY   = 'sd_daily_recent';     // { ids: [...] } most recent first

// How many drills the player is given each day.
export const DAILY_SET_SIZE = 3;

// How many days a drill sits out after being part of the daily set. At three
// picks a day this is four days of cooldown, and it still leaves half of the
// 24-drill catalog available as candidates on any given morning.
const RECENT_WINDOW = 12;

// Below this many total local sessions (or with fewer than 2 sub-groups
// played at all), there isn't enough signal to personalize responsibly —
// fall back to the plain deterministic rotation until there's real data.
const COLD_START_MIN_SESSIONS = 6;
// A sub-group needs at least this many scored sessions before its average
// accuracy is trusted enough to call it "weakest" — one unlucky run
// shouldn't brand a whole skill area as a weak spot.
const MIN_SAMPLES_FOR_WEAKNESS = 2;

// Derived from DRILL_INDEX (the real, live drill list) instead of a hand-maintained
// array, so this pool can't drift into pointing at deleted/renamed drills, and
// so a drill added in an update joins the rotation on its own.
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
 * Drills that have been in the daily set recently, as { id, date } pairs.
 *
 * The date is stored, not just the id, because TODAY's own picks are written
 * here the moment they are chosen. Excluding them blindly would mean that if
 * the day's cached set is ever lost mid-day — storage cleared, a failed write,
 * a reinstall — recomputing would deliberately avoid the very drills the
 * player was part-way through, hand them a different set, and orphan the
 * completions they had already earned. Entries dated today are therefore
 * never treated as "used up".
 */
async function recentEntries() {
  const stored = await Storage.getJSON(RECENT_KEY, null);
  if (!Array.isArray(stored?.ids)) return [];
  // Tolerates the older shape, where entries were bare id strings.
  return stored.ids
    .map(e => (typeof e === 'string' ? { id: e, date: null } : e))
    .filter(e => e && e.id)
    .slice(0, RECENT_WINDOW);
}

async function staleIds(today) {
  return (await recentEntries()).filter(e => e.date !== today).map(e => e.id);
}

async function rememberPicks(drillIds, today) {
  const entries = await recentEntries();
  const fresh = drillIds.map(id => ({ id, date: today }));
  await Storage.setJSON(RECENT_KEY, {
    ids: [...fresh, ...entries.filter(e => !drillIds.includes(e.id))].slice(0, RECENT_WINDOW),
  });
}

/**
 * Today's candidates: the whole catalog minus anything used recently. The
 * exclusion is dropped rather than allowed to starve the set — a player who
 * has seen most of the catalog must still get three drills.
 */
function candidatesFor(excludeIds) {
  const filtered = CHALLENGE_POOL.filter(d => !excludeIds.includes(d.id));
  return filtered.length >= DAILY_SET_SIZE ? filtered : CHALLENGE_POOL;
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

// The set rotates through three roles rather than only ever targeting
// weaknesses — pure "eat your vegetables" drilling reads as remedial and hurts
// retention. Which roles a given day takes is driven off the date, so the set
// feels different day to day even inside a stable skill profile.
const ROLES = ['weakness', 'momentum', 'discovery'];

/**
 * The best group for each role, or null where the local data can't support
 * that role yet. Returns null outright during cold start.
 */
async function roleGroups() {
  const stats = await computeGroupStats();
  const groupIds = SUB_GROUPS.filter(g => g.id !== 'all').map(g => g.id);

  const totalSessions = groupIds.reduce((sum, id) => sum + stats[id].attempts, 0);
  const playedGroups = groupIds.filter(id => stats[id].attempts > 0);
  if (totalSessions < COLD_START_MIN_SESSIONS || playedGroups.length < 2) {
    return null;
  }

  return {
    weakness: groupIds
      .filter(id => stats[id].accuracyCount >= MIN_SAMPLES_FOR_WEAKNESS)
      .sort((a, b) => (stats[a].accuracySum / stats[a].accuracyCount) - (stats[b].accuracySum / stats[b].accuracyCount))[0] || null,
    momentum: [...groupIds].sort((a, b) => stats[b].attempts - stats[a].attempts)[0],
    discovery: [...groupIds].sort((a, b) => stats[a].attempts - stats[b].attempts)[0],
  };
}

/**
 * Fill the remaining slots from the role groups, then from plain rotation.
 * `taken` is mutated as each slot is filled so no drill can appear twice.
 */
function fillSlots(dateStr, candidates, groups, taken, wanted, usedGroups) {
  const picked = [];

  // Prefer a category the day hasn't used yet, and only fall back to a repeat
  // when nothing else is left. Three drills out of one category is a narrower
  // day than the set is meant to be, and it happens easily by accident: two
  // roles can rank the same group top, and the plain rotation is blind to
  // category altogether.
  const spread = (pool) => {
    const fresh = pool.filter(d => !usedGroups.has(getDrillGroup(d)));
    return fresh.length > 0 ? fresh : pool;
  };

  if (groups) {
    // Start at the role the date selects and walk the whole list, so a role
    // with no usable group (or no candidate drill left in it) hands its slot
    // to the next role instead of leaving the set short.
    const start = hashString(dateStr) % ROLES.length;
    for (let i = 0; i < ROLES.length && picked.length < wanted; i++) {
      const role = ROLES[(start + i) % ROLES.length];
      const groupId = groups[role];
      if (!groupId) continue;
      if (usedGroups.has(groupId)) continue;
      const inGroup = candidates.filter(d => getDrillGroup(d) === groupId && !taken.has(d.id));
      if (inGroup.length === 0) continue;
      const drill = inGroup[hashString(dateStr + '_' + role) % inGroup.length];
      taken.add(drill.id);
      usedGroups.add(groupId);
      picked.push({ ...drill, reason: role });
    }
  }

  // Deterministic rotation for whatever is still unfilled — cold start, or a
  // profile where every role landed on a category the set already holds. The
  // offset in the hash keeps consecutive rotation picks independent of each
  // other instead of walking neighbours out of one corner of the catalog.
  let offset = 0;
  while (picked.length < wanted) {
    const remaining = candidates.filter(d => !taken.has(d.id));
    if (remaining.length === 0) break;
    const pool = spread(remaining);
    const drill = pool[hashString(dateStr + '_rotation_' + offset) % pool.length];
    taken.add(drill.id);
    usedGroups.add(getDrillGroup(drill));
    picked.push({ ...drill, reason: 'rotation' });
    offset += 1;
  }

  return picked;
}

/**
 * Today's daily set — DAILY_SET_SIZE drills, stable for the whole calendar day.
 *
 * Cached under DAILY_PICK so it stays put across reloads no matter what the
 * player does during the day: the personalized picks are computed from local
 * stats, and those stats change with every session, so recomputing would let
 * the set change out from under a player mid-day.
 *
 * @returns {Promise<Array<Object>>}
 */
export async function getTodaysChallengeDrills() {
  const today = todayStr();

  const cached = await Storage.getJSON(DAILY_PICK, null);
  // The `drills` test also handles the migration from the single-drill build,
  // whose cache held { date, drill }: that shape simply fails here and the day
  // is repicked, which is the right outcome — the player is owed three drills
  // today, not the one the old build chose.
  if (cached?.date === today && Array.isArray(cached.drills) && cached.drills.length === DAILY_SET_SIZE) {
    return cached.drills;
  }

  const stale = await staleIds(today);
  const candidates = candidatesFor(stale);
  const taken = new Set();

  const drills = [];
  // One category per slot, tracked across all three picks, so the set spreads
  // across the catalogue instead of handing the player three drills from one
  // corner of it.
  const usedGroups = new Set();

  drills.push(...fillSlots(today, candidates, await roleGroups(), taken, DAILY_SET_SIZE - drills.length, usedGroups));

  await Storage.setJSON(DAILY_PICK, { date: today, drills });
  await rememberPicks(drills.map(d => d.id), today);
  return drills;
}

/** Which of today's drills the player has already finished. */
async function completedIdsToday(today) {
  const stored = await Storage.getJSON(DAILY_KEY, null);
  if (stored?.date !== today) return [];
  // Tolerates the single-drill build's shape, { date, drillId, completed }, so
  // a player who finished today's old one-drill challenge before updating
  // keeps that tick instead of being asked to replay it.
  if (Array.isArray(stored.completedIds)) return stored.completedIds;
  return stored.completed && stored.drillId ? [stored.drillId] : [];
}

/**
 * Today's daily set and how much of it is done.
 *
 * `next` is the one drill the card actually asks for right now — the first of
 * the set the player hasn't finished today, or null once the set is complete.
 */
export async function getDailyChallenge() {
  const today = todayStr();
  const set = await getTodaysChallengeDrills();
  const done = await completedIdsToday(today);

  const drills = set.map(drill => ({ ...drill, completed: done.includes(drill.id) }));
  const completedCount = drills.filter(d => d.completed).length;

  return {
    drills,
    completedCount,
    total: drills.length,
    allComplete: completedCount === drills.length,
    next: drills.find(d => !d.completed) || null,
    date: today,
  };
}

/**
 * Read-only preview of what completing `drillId` right now would mean for
 * today's daily set — WITHOUT marking anything complete. Drills use this to
 * compute an accurate on-screen XP number (2x for a daily-set drill, plus the
 * flat all-three bonus) that matches what completeDailyChallenge() will
 * actually persist moments later via saveDrillResult(). Deliberately
 * non-mutating so it can never race with (or double-count against) that real
 * completion write — completeDailyChallenge() alone remains the single source
 * of truth for persisted state.
 *
 * @returns {Promise<{ isDailyDrill: boolean, wouldCompleteSet: boolean }>}
 */
export async function previewDailyCompletion(drillId) {
  const today = todayStr();
  const set = await getTodaysChallengeDrills();
  if (!set.some(d => d.id === drillId)) return { isDailyDrill: false, wouldCompleteSet: false };

  const done = await completedIdsToday(today);
  if (done.includes(drillId)) return { isDailyDrill: false, wouldCompleteSet: false };

  return {
    isDailyDrill: true,
    // The flat set bonus is claimable once, so it is only previewed on the run
    // that would actually close the set out.
    wouldCompleteSet: done.length + 1 === set.length,
  };
}

/**
 * Mark one of today's daily drills as complete.
 * @param {string} drillId — which drill was just completed.
 * @returns {Promise<{ isNewCompletion: boolean, allComplete: boolean }>}
 */
export async function completeDailyChallenge(drillId) {
  const today = todayStr();
  const set = await getTodaysChallengeDrills();

  // Only credit drills that are actually in today's set — playing an
  // unrelated drill shouldn't be able to claim the day's double XP.
  if (!set.some(d => d.id === drillId)) {
    return { isNewCompletion: false, allComplete: false };
  }

  const done = await completedIdsToday(today);
  if (done.includes(drillId)) {
    return { isNewCompletion: false, allComplete: done.length === set.length };
  }

  const completedIds = [...done, drillId];
  await Storage.setJSON(DAILY_KEY, {
    date:        today,
    completedIds,
    completedAt: new Date().toISOString(),
  });

  return { isNewCompletion: true, allComplete: completedIds.length === set.length };
}

/**
 * Check if a completed drill is one of today's daily set.
 */
export async function isTodaysDailyDrill(drillId) {
  const set = await getTodaysChallengeDrills();
  return set.some(d => d.id === drillId);
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
