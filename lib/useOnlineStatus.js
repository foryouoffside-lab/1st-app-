'use client';

// lib/useOnlineStatus.js
// SkillDrills — "is there actually a connection?" for the online-only surfaces.
//
// Solo drills are 100% local and must keep working with no network, but the
// Arena is pure Firestore. Offline, Firestore does NOT reject a write — it
// queues it in the local cache and leaves the promise pending forever. That
// meant `await joinMatchmakingQueue(...)` in the Arena never resolved, so the
// poll/tick/60s-auto-cancel timers that are armed *after* it never started:
// the search modal sat on "Finding an Opponent... (0s)" with a frozen counter
// and no timeout, indefinitely. Verified on-device with wifi + mobile data
// disabled. There is no error to catch here — the only fix is to refuse to
// start in the first place, so every Arena entry point checks this.
//
// navigator.onLine is used rather than @capacitor/network because it needs no
// new native plugin (no rebuild of the native shell) and the Android WebView
// keeps it in sync with ConnectivityManager. It answers "is there a route to
// the internet", not "is Firestore reachable" — good enough to catch the
// airplane-mode/no-signal case this guards against, and everything past that
// still falls through to the existing error handling.

import { useEffect, useState } from 'react';

/** Point-in-time check, for use inside event handlers. */
export function isOnline() {
  if (typeof navigator === 'undefined') return true;
  return navigator.onLine !== false;
}

/**
 * Live online/offline flag.
 *
 * Starts `true` on the server and on the first client render so a
 * static-exported page hydrates to the same markup it was built with, then
 * corrects itself in the effect below.
 */
export function useOnlineStatus() {
  const [online, setOnline] = useState(true);

  useEffect(() => {
    const sync = () => setOnline(isOnline());
    sync();
    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
    return () => {
      window.removeEventListener('online', sync);
      window.removeEventListener('offline', sync);
    };
  }, []);

  return online;
}
