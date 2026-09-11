// lib/progressCloud.js
// "I deleted the app and lost my level" — the fix.
//
// THE PROBLEM THIS SOLVES
// Every scrap of solo progress in this app is stored ON THE DEVICE (see
// lib/progressStore.js). XP, and therefore the training level and the rank
// badge derived from it (lib/levelBadge.js), live in `sd_xp`; the streak in
// `sd_streak`; per-drill bests in `sd_scores`; the weekly badge ladder in
// `sd_weekly`. On Android those go through @capacitor/preferences into the
// app's SharedPreferences file.
//
// Uninstalling the app deletes that file outright. Android's backup service
// does not save it either, unless the user has cloud backup enabled AND the
// restore happens on the very next install. So the normal case — player
// uninstalls, reinstalls a week later, signs back in with the same Google
// account — used to hand them a Level 1 "Recruit" account with zero bests and
// no streak, with everything they had earned gone for good. That is exactly
// the moment a returning player quits for the second and final time.
//
// So the account carries it now. The player is already signed in with Google
// (the whole app sits behind AuthGate), so their uid is a stable identity
// across installs and across devices. This file keeps a small private mirror
// of the four progress records at users/{uid}/private/progress, restores it
// on sign-in, and re-uploads it after each session.
//
// COST SHAPE (this app is on the free Spark plan — see SCALING_PLAYBOOK.md)
// One READ per app open, and one WRITE per drill result, debounced so a burst
// of finishes coalesces into a single write, and skipped entirely when the
// payload is byte-identical to what is already up there. A typical session is
// therefore 1 read + ~1-3 writes, the same order as the presence heartbeat.
// No history is mirrored (`sd_history` is 30 entries per drill and only feeds
// the Progress trend lines) — this is about not losing the things a player
// feels ownership of, not a full device backup.
//
// MERGE RULE: RESTORE NEVER LOWERS ANYTHING.
// Local and cloud are merged field by field, always toward the better value —
// max XP, max best, longest streak, union of badges. A restore therefore
// cannot destroy progress made offline, and re-running it is a no-op. The one
// case this deliberately over-credits is two different Google accounts sharing
// one phone: the second account inherits the device's local progress. Wiping a
// real person's progress because they signed in with their other account is
// the far worse failure, so it merges upward and we accept the other.

import { doc, getDoc, setDoc, deleteDoc, serverTimestamp } from 'firebase/firestore';
import { initFirebase } from './firebase';
import { Storage } from './storage';
import { reconcileDrillBests } from './bestScoreSync';

// Bump only if the payload shape changes incompatibly. Readers must tolerate
// an older `v` — an old app version must never be handed data it can't merge.
const BACKUP_VERSION = 1;

const KEYS = {
  XP:      'sd_xp',
  STREAK:  'sd_streak',
  SCORES:  'sd_scores',
  WEEKLY:  'sd_weekly',
};

// Which record on the device the last successful restore/backup belonged to.
// Purely diagnostic — nothing branches on it — but it is the first thing worth
// looking at if a player ever reports progress appearing from nowhere.
const OWNER_KEY = 'sd_cloud_owner';

// A finished drill fires the change event; wait this long for the rest of the
// session's writes to settle before spending a write. Flushed early whenever
// the app is backgrounded, so a player who finishes and immediately swipes the
// app away still gets their run saved.
const BACKUP_DEBOUNCE_MS = 15000;

const PROGRESS_CHANGED_EVENT  = 'sd:progress-changed';
const PROGRESS_RESTORED_EVENT = 'sd:progress-restored';

/** The private backup document for a player. */
function backupRef(db, uid) {
  return doc(db, 'users', uid, 'private', 'progress');
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Firestore-safe copy of a value: no `undefined` anywhere, null if empty. */
function clean(value) {
  if (value === undefined || value === null) return null;
  try { return JSON.parse(JSON.stringify(value)); } catch (err) { return null; }
}

/** Later of two ISO date strings — either may be missing. */
const later = (a, b) => {
  if (!a) return b || null;
  if (!b) return a;
  return a > b ? a : b;
};

/** Earlier of two ISO date strings — either may be missing. */
const earlier = (a, b) => {
  if (!a) return b || null;
  if (!b) return a;
  return a < b ? a : b;
};

// ─── MERGE ─────────────────────────────────────────────────────────────────

/**
 * Per-drill records. Local wins on anything not listed, because local is the
 * record of what this device just did; the listed fields all take the better
 * of the two.
 *
 * `attempts` takes the MAX rather than the sum on purpose: a sum would
 * double-count every session already reflected in both copies, and inflate
 * "total sessions" (and with it the achievement ladder) a little more on every
 * single restore.
 */
function mergeScores(local, cloud) {
  const out = { ...(local && typeof local === 'object' ? local : {}) };
  if (!cloud || typeof cloud !== 'object') return out;

  for (const [drillId, c] of Object.entries(cloud)) {
    if (!c || typeof c !== 'object') continue;
    const l = out[drillId];
    if (!l) { out[drillId] = c; continue; }
    out[drillId] = {
      ...c,
      ...l,
      best:        Math.max(num(l.best), num(c.best)),
      attempts:    Math.max(num(l.attempts), num(c.attempts)),
      firstPlayed: earlier(l.firstPlayed, c.firstPlayed),
      lastPlayed:  later(l.lastPlayed, c.lastPlayed),
      lastScored:  later(l.lastScored, c.lastScored),
      drillName:   l.drillName || c.drillName || drillId,
      category:    l.category || c.category || 'general',
    };
  }
  return out;
}

function normStreak(s) {
  const o = s && typeof s === 'object' ? s : {};
  return {
    current:  Number.isFinite(o.current) ? o.current : 0,
    longest:  Number.isFinite(o.longest) ? o.longest : 0,
    lastDate: typeof o.lastDate === 'string' ? o.lastDate : null,
  };
}

/**
 * The live streak belongs to whichever copy played most recently — a streak is
 * a claim about consecutive DAYS, so the copy with the later `lastDate` is the
 * one still standing. `longest` is a lifetime record and simply takes the max.
 */
function mergeStreak(local, cloud) {
  const l = normStreak(local);
  const c = normStreak(cloud);
  const longest = Math.max(l.longest, c.longest, l.current, c.current);

  let live = l;
  if ((c.lastDate || '') > (l.lastDate || '')) live = c;
  else if ((c.lastDate || '') === (l.lastDate || '') && c.current > l.current) live = c;

  return { current: live.current, longest, lastDate: live.lastDate };
}

/**
 * Weekly goal state (lib/weeklyGoal.js). `weeksCompleted` and `badges` are
 * cumulative and take the better value; `sessionDays` only means anything
 * within its own week, so it is unioned when both copies are on the same week
 * and otherwise taken from the later week.
 */
function mergeWeekly(local, cloud) {
  const l = local && typeof local === 'object' ? local : null;
  const c = cloud && typeof cloud === 'object' ? cloud : null;
  if (!l) return c;
  if (!c) return l;

  const lDays = Array.isArray(l.sessionDays) ? l.sessionDays : [];
  const cDays = Array.isArray(c.sessionDays) ? c.sessionDays : [];

  let week = l.week || c.week || null;
  let sessionDays = lDays;
  if (!l.week || (c.week || '') > (l.week || '')) {
    week = c.week;
    sessionDays = cDays;
  } else if (c.week === l.week) {
    sessionDays = Array.from(new Set([...lDays, ...cDays]));
  }

  return {
    week,
    sessionDays,
    weeksCompleted: Math.max(num(l.weeksCompleted), num(c.weeksCompleted)),
    badges: Array.from(new Set([
      ...(Array.isArray(l.badges) ? l.badges : []),
      ...(Array.isArray(c.badges) ? c.badges : []),
    ])),
  };
}

// ─── SNAPSHOT ──────────────────────────────────────────────────────────────

/** Read the four mirrored records off the device. */
async function readLocal() {
  const [xp, streak, scores, weekly] = await Promise.all([
    Storage.getJSON(KEYS.XP, 0),
    Storage.getJSON(KEYS.STREAK, null),
    Storage.getJSON(KEYS.SCORES, {}),
    Storage.getJSON(KEYS.WEEKLY, null),
  ]);
  return { xp: num(xp), streak, scores: scores && typeof scores === 'object' ? scores : {}, weekly };
}

/**
 * The comparable part of a payload — everything except the server timestamp,
 * which changes on every write and would defeat the "has anything actually
 * changed?" check that keeps this off the write budget.
 */
function signature(snap) {
  return JSON.stringify({
    xp: snap.xp,
    streak: snap.streak || null,
    weekly: snap.weekly || null,
    // Object key order is insertion order and can differ between two equal
    // stores (a merge rebuilds the object), so sort before comparing or every
    // open would look like a change and spend a write.
    scores: Object.keys(snap.scores || {}).sort().map((id) => {
      const s = snap.scores[id] || {};
      return [id, num(s.best), num(s.attempts), s.lastScored || null];
    }),
  });
}

// ─── RESTORE ───────────────────────────────────────────────────────────────

/**
 * Pull the cloud copy and merge it into the device, upward only.
 *
 * @returns {Promise<{ ok: boolean, changed: boolean, cloudSignature: string|null }>}
 *   ok=false means the cloud copy could not be read (offline, permissions) —
 *   the caller must NOT then back up, or a device that is behind would
 *   overwrite a good cloud record with a worse one.
 *
 *   cloudSignature describes what is ALREADY stored up there (null if nothing
 *   is). The caller seeds its change-detector with it, so the very next backup
 *   writes exactly when the device is ahead of the cloud and skips when it is
 *   not — including on a first-ever open, where there is nothing up there yet
 *   and the safety net should be created immediately.
 */
async function restore(db, uid) {
  let cloud = null;
  try {
    const snap = await getDoc(backupRef(db, uid));
    if (snap.exists()) cloud = snap.data();
  } catch (err) {
    return { ok: false, changed: false, cloudSignature: null };
  }

  const local = await readLocal();
  if (!cloud) return { ok: true, changed: false, cloudSignature: null };

  const cloudSignature = signature({
    xp: num(cloud.xp),
    streak: cloud.streak || null,
    scores: cloud.scores && typeof cloud.scores === 'object' ? cloud.scores : {},
    weekly: cloud.weekly || null,
  });

  const merged = {
    xp:     Math.max(local.xp, num(cloud.xp)),
    streak: mergeStreak(local.streak, cloud.streak),
    scores: mergeScores(local.scores, cloud.scores),
    weekly: mergeWeekly(local.weekly, cloud.weekly),
  };

  // Only write back what actually moved. On the normal open — device already
  // ahead of or equal to the cloud — this touches nothing at all.
  const writes = [];
  if (merged.xp !== local.xp) writes.push(Storage.setJSON(KEYS.XP, merged.xp));
  if (JSON.stringify(merged.streak) !== JSON.stringify(normStreak(local.streak))) {
    writes.push(Storage.setJSON(KEYS.STREAK, merged.streak));
  }
  if (JSON.stringify(merged.scores) !== JSON.stringify(local.scores)) {
    writes.push(Storage.setJSON(KEYS.SCORES, merged.scores));
  }
  if (merged.weekly && JSON.stringify(merged.weekly) !== JSON.stringify(local.weekly)) {
    writes.push(Storage.setJSON(KEYS.WEEKLY, merged.weekly));
  }

  if (!writes.length) return { ok: true, changed: false, cloudSignature };

  await Promise.all(writes);

  // `sd_scores` is the canonical best store, but each drill's start card reads
  // its OWN localStorage record — which a reinstall wiped too. Push the newly
  // restored bests back down into those, or the player sees the right level on
  // the Progress screen and BEST 0 on every start card (lib/bestScoreSync.js).
  try { await reconcileDrillBests(); } catch (err) { /* start cards only */ }

  return { ok: true, changed: true, cloudSignature };
}

// ─── BACKUP ────────────────────────────────────────────────────────────────

async function backup(db, uid, lastSignatureRef) {
  const snap = await readLocal();

  // Nothing to save. Guards the reinstall race specifically: an empty device
  // must never write an empty record over a real one.
  const hasProgress = snap.xp > 0 || Object.keys(snap.scores).length > 0;
  if (!hasProgress) return false;

  const sig = signature(snap);
  if (sig === lastSignatureRef.value) return false;

  await setDoc(backupRef(db, uid), {
    v: BACKUP_VERSION,
    xp: snap.xp,
    // JSON round-trip, not the raw object: Firestore REJECTS the whole write
    // if any field anywhere in it is `undefined`, and these blobs have been
    // through several schema versions on real devices (a record written by an
    // older build can be missing fields a newer one expects). Stringify drops
    // undefined keys outright, which is exactly the behaviour wanted here.
    streak: clean(snap.streak),
    scores: clean(snap.scores) || {},
    weekly: clean(snap.weekly),
    updatedAt: serverTimestamp(),
  });

  lastSignatureRef.value = sig;
  try { await Storage.setJSON(OWNER_KEY, { uid, at: new Date().toISOString() }); } catch (err) {}
  return true;
}

// ─── PUBLIC API ────────────────────────────────────────────────────────────

/**
 * Start keeping this player's progress mirrored to their account.
 *
 * Restores first (that is what makes a reinstall whole again), then backs up
 * after every drill result. Returns a stop function; safe to call with no uid,
 * outside the browser, or with Firebase unavailable — all no-ops.
 *
 * @param {string} uid
 * @returns {() => void} stop
 */
export function startProgressCloudSync(uid) {
  if (!uid || typeof window === 'undefined') return () => {};
  const fb = initFirebase();
  if (!fb || !fb.db) return () => {};
  const db = fb.db;

  let stopped = false;
  let ready = false;   // a successful restore has happened
  let timer = null;
  const lastSignature = { value: null };

  const flush = () => {
    if (stopped || !ready) return;
    if (timer) { clearTimeout(timer); timer = null; }
    backup(db, uid, lastSignature).catch(() => {
      // Offline or rejected — the next result (or the next app open) retries.
      // Deliberately silent: a failed backup must never surface to the player,
      // and nothing is lost, the device copy is still the live one.
    });
  };

  const schedule = () => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    // Still restoring: the timer simply fires into a flush() that no-ops until
    // `ready`, and the post-restore flush below covers the same state anyway.
    timer = setTimeout(() => { timer = null; flush(); }, BACKUP_DEBOUNCE_MS);
  };

  (async () => {
    const result = await restore(db, uid)
      .catch(() => ({ ok: false, changed: false, cloudSignature: null }));
    if (stopped) return;

    if (!result.ok) {
      // The cloud copy is unreadable this session (almost always: offline).
      // Stay dormant rather than risk uploading a device that may be behind.
      return;
    }

    ready = true;
    // Seed the change-detector with what is already stored, so the flush below
    // writes only when this device is genuinely ahead of it.
    lastSignature.value = result.cloudSignature;

    if (result.changed) {
      // Screens that already read their numbers at mount are now showing the
      // pre-restore values — tell them to read again.
      window.dispatchEvent(new Event(PROGRESS_RESTORED_EVENT));
    }

    // Establishes the safety net on a first-ever open, and catches anything
    // earned offline since the last successful backup.
    flush();
  })();

  const onChanged = () => schedule();
  const onHide = () => { if (document.visibilityState === 'hidden') flush(); };

  window.addEventListener(PROGRESS_CHANGED_EVENT, onChanged);
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', flush);

  return () => {
    stopped = true;
    if (timer) { clearTimeout(timer); timer = null; }
    window.removeEventListener(PROGRESS_CHANGED_EVENT, onChanged);
    document.removeEventListener('visibilitychange', onHide);
    window.removeEventListener('pagehide', flush);
  };
}

/**
 * Remove the cloud copy. Called from the account-deletion path — deleting
 * users/{uid} does NOT remove its subcollections, so without this the backup
 * would outlive the account and quietly restore itself if the same person ever
 * signed in again with the same Google account.
 *
 * Must run while still signed in as `uid` (the rules require it).
 */
export async function deleteCloudProgress(uid) {
  if (!uid || typeof window === 'undefined') return;
  const fb = initFirebase();
  if (!fb || !fb.db) return;
  try { await deleteDoc(backupRef(fb.db, uid)); } catch (err) { /* best effort */ }
  try { await Storage.remove(OWNER_KEY); } catch (err) {}
}
