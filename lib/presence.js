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

import { doc, updateDoc, serverTimestamp } from 'firebase/firestore';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import { initFirebase } from './firebase';

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
  const mark = (isOnline) => {
    if (stopped && isOnline) return;
    // Coalesce bursts (a resume often fires visibilitychange AND appStateChange).
    const now = Date.now();
    if (isOnline && now - lastWrite < 5000) return;
    lastWrite = now;
    updateDoc(ref, { online: isOnline, lastSeen: serverTimestamp() }).catch(() => {});
  };

  mark(true);
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
      .then((h) => { appHandle = h; })
      .catch(() => {});
  }

  return () => {
    stopped = true;
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('pagehide', onHide);
    window.removeEventListener('beforeunload', onHide);
    try { appHandle && appHandle.remove(); } catch (e) {}
    mark(false);
  };
}
