// lib/keepAwake.js
// SkillDrills — keep the screen awake while a drill is being played.
//
// Several drills (Ghost Link, Divided Attention, the tracking drills) can run
// for tens of seconds without a single touch — the player is watching, not
// tapping. Android sees no input and dims, then locks the screen mid-run,
// which reads as the app crashing.
//
// Two paths, same reason as lib/orientation.js:
//
//  - Native: a tiny in-repo Capacitor plugin (KeepAwakePlugin.java) that
//    toggles FLAG_KEEP_SCREEN_ON on the activity window. Android's WebView
//    does not ship the Screen Wake Lock API — navigator.wakeLock is simply
//    undefined there — so the web call below would silently do nothing
//    inside the packaged app, which is exactly where the bug is.
//  - Browser (skilldrills.online, and `next dev` on the desktop): the
//    standard navigator.wakeLock sentinel.
//
// Both are best-effort: a failure here must never break a drill, so every
// path swallows its own errors.

import { Capacitor, registerPlugin } from '@capacitor/core';

const KeepAwakeNative = registerPlugin('KeepAwake');

// The browser sentinel, held so it can be released again. The OS drops it
// on its own whenever the page is hidden, hence the re-acquire below.
let sentinel = null;
// How many callers currently want the screen up. Ref-counted because a duel
// result screen can mount while the drill underneath is still tearing down.
let holders = 0;
let visibilityBound = false;

async function acquireWebLock() {
  try {
    if (typeof navigator === 'undefined' || !navigator.wakeLock) return;
    if (sentinel && !sentinel.released) return;
    sentinel = await navigator.wakeLock.request('screen');
    sentinel.addEventListener('release', () => { sentinel = null; });
  } catch {
    // NotAllowedError when the tab isn't visible, unsupported elsewhere.
  }
}

// Backgrounding the app makes Android release the browser sentinel outright.
// Coming back to a still-running drill has to take it again or the screen
// starts dimming from that point on.
function onVisibility() {
  if (holders > 0 && document.visibilityState === 'visible') acquireWebLock();
}

export function keepAwake() {
  holders += 1;
  if (holders > 1) return;

  if (Capacitor.isNativePlatform()) {
    KeepAwakeNative.keepAwake().catch(() => {});
    return;
  }

  if (typeof document !== 'undefined' && !visibilityBound) {
    document.addEventListener('visibilitychange', onVisibility);
    visibilityBound = true;
  }
  acquireWebLock();
}

export function allowSleep() {
  holders = Math.max(0, holders - 1);
  if (holders > 0) return;

  if (Capacitor.isNativePlatform()) {
    KeepAwakeNative.allowSleep().catch(() => {});
    return;
  }

  if (typeof document !== 'undefined' && visibilityBound) {
    document.removeEventListener('visibilitychange', onVisibility);
    visibilityBound = false;
  }
  try { sentinel?.release(); } catch {}
  sentinel = null;
}
