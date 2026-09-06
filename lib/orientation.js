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

// ── Waiting for the viewport to stop moving ──────────────────────────────────
// Entering a drill fires three things that each resize the WebView: the
// Fullscreen API, StatusBar.setOverlaysWebView/hide, and the landscape lock's
// rotation animation. Every drill used to follow those with a blind
// `setTimeout(..., 200-350)` before showing the "3 · 2 · 1 · GO" overlay — a
// guess at how long Android would take. When the guess is short (a cold start,
// a slower phone, a rotation animation that runs long) the countdown mounts
// while the viewport is still moving: the centred "3" is laid out against a
// size that is about to change, so it visibly jumps/shrinks into place over the
// next few frames. That is the "shake" on the first digit.
//
// This waits for the real thing instead of guessing: it polls the viewport each
// frame and only runs the handler once the dimensions have held still for
// `settleMs`. `minWaitMs` keeps the pre-countdown beat that the fixed delays
// gave (so the start card doesn't snap straight into "3"), and `maxWaitMs` is a
// hard ceiling so a device that never stops reporting new sizes still starts.
//
// Deliberately polled rather than resize-event-driven: Android's WebView does
// not reliably fire `resize` for status-bar/overlay changes, and it is the
// missing event that produced the late layout in the first place.
export function afterViewportSettled(handler, { settleMs = 120, minWaitMs = 180, maxWaitMs = 1200 } = {}) {
  if (typeof window === 'undefined' || typeof requestAnimationFrame !== 'function') {
    handler({ width: 0, height: 0 });
    return () => {};
  }

  const startedAt = Date.now();
  let lastW = window.innerWidth;
  let lastH = window.innerHeight;
  let steadySince = startedAt;
  let raf = 0;
  let done = false;

  const tick = () => {
    if (done) return;
    const now = Date.now();
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (w !== lastW || h !== lastH) {
      lastW = w;
      lastH = h;
      steadySince = now;
    }
    const settled = now - steadySince >= settleMs && now - startedAt >= minWaitMs;
    if (settled || now - startedAt >= maxWaitMs) {
      done = true;
      raf = 0;
      handler({ width: w, height: h });
      return;
    }
    raf = requestAnimationFrame(tick);
  };

  raf = requestAnimationFrame(tick);

  return () => {
    done = true;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  };
}
