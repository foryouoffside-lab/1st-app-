// lib/orientation.js
// SkillDrills Pro — Dynamic Orientation Controller
// Handles locking/unlocking device screen orientation programmatically.
//
// Android's WebView has never reliably implemented the web Screen
// Orientation API (screen.orientation.lock() silently fails as
// "NotSupportedError" on many real devices) — so on native platforms this
// goes through @capacitor/screen-orientation instead, which calls Android's
// native orientation lock directly and always works. The web API is kept as
// the path for the actual browser site (skilldrills.online).

import { Capacitor } from '@capacitor/core';
import { ScreenOrientation } from '@capacitor/screen-orientation';

export async function lockLandscape() {
  try {
    if (Capacitor.isNativePlatform()) {
      await ScreenOrientation.lock({ orientation: 'landscape' });
      return true;
    }
    if (typeof window !== 'undefined' && window.screen && window.screen.orientation) {
      await window.screen.orientation.lock('landscape');
      return true;
    }
  } catch (e) {
    console.warn("Screen orientation lock failed: ", e);
  }
  return false;
}

export async function lockPortrait() {
  try {
    if (Capacitor.isNativePlatform()) {
      await ScreenOrientation.lock({ orientation: 'portrait' });
      return true;
    }
    if (typeof window !== 'undefined' && window.screen && window.screen.orientation) {
      await window.screen.orientation.lock('portrait');
      return true;
    }
  } catch (e) {
    console.warn("Screen orientation lock failed: ", e);
  }
  return false;
}

export async function unlockOrientation() {
  try {
    if (Capacitor.isNativePlatform()) {
      await ScreenOrientation.unlock();
      return true;
    }
    if (typeof window !== 'undefined' && window.screen && window.screen.orientation) {
      window.screen.orientation.unlock();
      return true;
    }
  } catch (e) {
    console.warn("Screen orientation unlock failed: ", e);
  }
  return false;
}

// ── Rotation settling ────────────────────────────────────────────────────────
// Android fires a burst of resize events while the rotation animation runs,
// and window.innerWidth/innerHeight cross over partway through it. A handler
// that reacts to the first "we're landscape now" event therefore lays the game
// out against dimensions that are still moving, and lays it out again once
// they stop — that second layout is the visible shake on rotate.
//
// This waits for the viewport to actually stop changing before calling the
// handler: every resize restarts a short timer, and the handler only runs once
// a measurement comes back identical to the previous one. Costs ~120ms of
// delay that the rotation animation itself already covers.
export function onOrientationSettled(handler, { settleMs = 120 } = {}) {
  if (typeof window === 'undefined') return () => {};

  let timer = 0;
  let lastW = window.innerWidth;
  let lastH = window.innerHeight;

  const settle = () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (w !== lastW || h !== lastH) {
      // Still moving — keep waiting rather than acting on a mid-animation size.
      lastW = w;
      lastH = h;
      timer = window.setTimeout(settle, settleMs);
      return;
    }
    timer = 0;
    handler({ width: w, height: h });
  };

  const schedule = () => {
    lastW = window.innerWidth;
    lastH = window.innerHeight;
    if (timer) clearTimeout(timer);
    timer = window.setTimeout(settle, settleMs);
  };

  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', schedule);

  return () => {
    if (timer) clearTimeout(timer);
    window.removeEventListener('resize', schedule);
    window.removeEventListener('orientationchange', schedule);
  };
}
