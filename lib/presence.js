// lib/presence.js
// "Is this player online right now" — an app-wide signal, true whenever the
// app is open on ANY screen with a live connection (not just the Arena).
//
// Cost shape: the heartbeat only writes while the app is FOREGROUNDED, and the
// moment it's backgrounded/closed we write `online:false` directly (event-
// driven, not polled). So a typical few-minute session costs ~3 writes total;
// the 3-minute heartbeat is only a backstop for the case Android kills the app
// without firing any lifecycle event.
//
// `online` is a claim that has to stay fresh, never a sticky flag — a hard
// kill leaves a stale `online:true` behind. isPresenceFresh() ignores the flag
// once the last heartbeat is older than PRESENCE_FRESH_MS.
//
// firestore.rules already lets any signed-in user write exactly
// { online, lastSeen } to any user doc (the presence-heartbeat branch), so
// this needs no rules deploy.
//
// WHO ACTUALLY RUNS THIS (2026-09-10)
// It used to run for every signed-in player. Counting the real calls, that
// made presence ~6 of the ~11 Firestore writes a player costs per session —
// the single biggest line on the free-tier budget (see SCALING_PLAYBOOK.md),
// and most of it was spent on behalf of players it could not possibly help.
// Presence exists to answer "can I duel this friend right now": the green dot
// and the Duel button on the Arena's Friends tab. A player with NO FRIENDS has
// nothing reading their presence at all.
//
// So AppShellClient now starts this only when the player has at least one
// friend, using the count cached below. Everyone else writes nothing.

import { doc, updateDoc, serverTimestamp } from 'firebase/firestore';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import { initFirebase } from './firebase';
import { Storage } from './storage';

// Renew every 3 min while foregrounded; treat anything past 7 min (two missed
// beats + slack) as offline.
export const PRESENCE_PING_MS = 3 * 60 * 1000;
export const PRESENCE_FRESH_MS = 7 * 60 * 1000;

/** Milliseconds since epoch for a Firestore Timestamp | {seconds} | number. */
function toMillis(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (typeof ts.seconds === 'number') return ts.seconds * 1000;
  if (typeof ts === 'number') return ts;
  return 0;
}

// ─── FRIEND COUNT (the gate) ───────────────────────────────────────────────
//
// How many friends this player had the last time the Arena's friends listener
// ran. Cached on the device because the gate has to be answered at app start,
// on every screen, and asking Firestore would cost the very read the gate
// exists to avoid.
//
// Being a device cache, it starts at 0 after a reinstall. A player with
// friends therefore looks offline to them until they open the Arena once,
// which repopulates it. That is the deliberate trade: a slightly stale dot for
// a returning player, against zero writes for every player who has no friends
// at all — the large majority.
const FRIEND_COUNT_KEY = 'sd_friend_count';

/** Fired when the cached count crosses in or out of zero. */
export const FRIEND_COUNT_EVENT = 'sd:friend-count';

/** @returns {Promise<number>} friends last seen on this device. 0 if unknown. */
export async function getKnownFriendCount() {
  const n = await Storage.getJSON(FRIEND_COUNT_KEY, 0);
  return Number.isFinite(Number(n)) ? Math.max(0, Number(n)) : 0;
}

/**
 * Record the current friend count. Called by the Arena whenever its live
 * friends list updates — that listener is the only place friends are ever
 * loaded, so it is the only place that can know.
 *
 * Announces the change so presence can start the moment a player accepts their
 * first friend, and stop when they remove their last, without an app restart.
 */
export async function setKnownFriendCount(count) {
  const next = Math.max(0, Math.floor(Number(count) || 0));
  const prev = await getKnownFriendCount();
  if (next === prev) return;
  await Storage.setJSON(FRIEND_COUNT_KEY, next);
  // Only the zero / non-zero transition changes what presence should do;
  // going 3 -> 4 friends is not worth waking anything up for.
  if (typeof window !== 'undefined' && (prev === 0) !== (next === 0)) {
    window.dispatchEvent(new Event(FRIEND_COUNT_EVENT));
  }
}

/** True if a user doc's presence heartbeat says they are online right now. */
export function isPresenceFresh(userDoc) {
  if (!userDoc || userDoc.online !== true) return false;
  const ms = toMillis(userDoc.lastSeen);
  return ms > 0 && Date.now() - ms < PRESENCE_FRESH_MS;
}

/**
 * Start the heartbeat for `uid`. Returns a stop function that also marks the
 * player offline. Safe to call with no uid / outside the browser (no-op).
 */
export function startPresence(uid) {
  if (!uid || typeof window === 'undefined') return () => {};
  const fb = initFirebase();
  if (!fb || !fb.db) return () => {};
  const ref = doc(fb.db, 'users', uid);

  let stopped = false;
  let lastWrite = 0;
  let lastOnline = null;
  const mark = (isOnline) => {
    if (stopped && isOnline) return;
    // Coalesce bursts (a resume often fires visibilitychange AND appStateChange).
    const now = Date.now();
    if (isOnline === lastOnline && now - lastWrite < 5000) return;
    lastOnline = isOnline;
    lastWrite = now;
    updateDoc(ref, { online: isOnline, lastSeen: serverTimestamp() }).catch(() => {});
  };

  mark(document.visibilityState === 'visible');
  const timer = setInterval(() => {
    if (document.visibilityState === 'visible') mark(true);
  }, PRESENCE_PING_MS);

  const onVisibility = () => mark(document.visibilityState === 'visible');
  document.addEventListener('visibilitychange', onVisibility);

  const onHide = () => mark(false);
  window.addEventListener('pagehide', onHide);
  window.addEventListener('beforeunload', onHide);

  // visibilitychange is unreliable inside Android's WebView when the whole app
  // goes to the background, so also follow the native app-state event.
  let appHandle;
  if (Capacitor.isNativePlatform()) {
    CapacitorApp.addListener('appStateChange', ({ isActive }) => mark(!!isActive))
      .then((h) => { if (stopped) h.remove().catch(() => {}); else appHandle = h; })
      .catch(() => {});
  }

  return () => {
    stopped = true;
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', onHide);
    window.removeEventListener('beforeunload', onHide);
    if (appHandle) appHandle.remove().catch(() => {});
    mark(false);
  };
}
