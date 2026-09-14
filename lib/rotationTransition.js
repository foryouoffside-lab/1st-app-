// lib/rotationTransition.js
// SkillDrills — smooth the hard cut when the screen rotates.
//
// WHY THIS EXISTS
//
// AndroidManifest declares `configChanges="orientation|screenSize|..."` on
// MainActivity, which is correct — it stops Android destroying and recreating
// the Activity (and with it the whole WebView and the running drill) every time
// the device turns. The trade-off is that Android then skips its own rotation
// cross-fade: the window is resized in one step, and the WebView re-lays-out
// live in front of the player. For a fraction of a second the old layout is
// stretched into the new dimensions before the reflow lands, which reads as the
// app blanking and rebuilding itself.
//
// Nothing is actually being destroyed. React does not remount, the drill's rAF
// loop keeps running, and state is intact — it is purely what the eye catches
// mid-reflow. So the fix belongs in the view, not the lifecycle: cover the
// reflow with a short fade through the app's own background colour, and let go
// once the viewport has stopped moving.
//
// The cover is a fixed, pointer-events:none element that AppShellClient always
// renders (see .sd-rotate-cover in styles/globals.css). It sits at opacity 0
// and costs nothing until `html.sd-rotating` turns it on, which is why this
// works during a drill without touching the canvas or the game loop.
//
// Deliberately NOT an opacity transition on <body>: opacity below 1 creates a
// stacking context, which re-anchors every position:fixed descendant (the
// bottom nav, the drill HUD) to the body box for the duration of the fade and
// visibly shifts them. A separate overlay has no such effect.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE RACE THIS FILE EXISTED WITH UNTIL IT WAS DEVICE-TESTED (2026-09-14)
//
// The first version only raised the cover from `orientationchange` / `resize`.
// Those fire when the rotation has ALREADY STARTED, so entering a landscape
// drill went: lockLandscape() -> Android begins reflowing -> flash -> event ->
// cover fades in over 80ms -> settle -> cover lifts. The cover was arriving
// after the thing it exists to hide, and on a real phone the flash was still
// plainly visible.
//
// An event-driven cover can never win that race, because the event is downstream
// of the reflow. So the hold is now something a CALLER can start: anything that
// is about to ask the OS to rotate raises the cover FIRST, synchronously, and
// only then requests the lock — see lockLandscape/lockPortrait/unlockOrientation
// in lib/orientation.js. The listeners below stay as the fallback for rotations
// nobody asked for (the player physically turning the device).
//
// That is also why the cover no longer fades IN at all (0ms; see globals.css).
// Fading in is only correct if you have time in hand — here the whole point is
// to be opaque before the next frame paints. It still fades OUT slowly, which
// is the half the player actually perceives.
// ─────────────────────────────────────────────────────────────────────────────

const ROTATING_CLASS = 'sd-rotating';

// Module-scope, not per-install: `beginRotationHold` is called from
// lib/orientation.js, which has no reference to whatever AppShellClient's
// effect closed over. One app, one cover, one hold at a time.
let holding = false;
let raf = 0;

function releaseHold() {
  holding = false;
  if (raf) {
    cancelAnimationFrame(raf);
    raf = 0;
  }
  if (typeof document !== 'undefined') {
    document.documentElement.classList.remove(ROTATING_CLASS);
  }
}

/**
 * Raise the cover NOW and hold it until the viewport stops changing size.
 *
 * Call this immediately before anything that will rotate the screen. It is
 * synchronous: the class is on the html element before this returns, so the
 * next frame paints opaque and the reflow happens underneath it.
 *
 * Safe to call repeatedly — a hold already in flight keeps its own settle
 * timer rather than restarting, so a caller-initiated hold is not cut short by
 * the orientationchange that follows it a moment later.
 *
 * settleMs  how long the viewport must hold one size before we call the
 *           rotation finished. Android emits a burst of resizes during the
 *           turn and innerWidth/innerHeight cross over partway through, so
 *           reacting to the first event lands mid-animation — the same reason
 *           onOrientationSettled in lib/orientation.js waits.
 * maxHoldMs hard ceiling. A device that never stops reporting new sizes must
 *           still get its content back, so the cover always lifts.
 */
export function beginRotationHold({ settleMs = 120, maxHoldMs = 900 } = {}) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (holding) return; // already covering this rotation

  holding = true;
  document.documentElement.classList.add(ROTATING_CLASS);

  const startedAt = Date.now();
  let lastW = window.innerWidth;
  let lastH = window.innerHeight;
  let steadySince = startedAt;

  const tick = () => {
    if (!holding) return;
    const now = Date.now();
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (w !== lastW || h !== lastH) {
      lastW = w;
      lastH = h;
      steadySince = now;
    }
    if (now - steadySince >= settleMs || now - startedAt >= maxHoldMs) {
      releaseHold();
      return;
    }
    raf = requestAnimationFrame(tick);
  };

  raf = requestAnimationFrame(tick);
}

/**
 * Mask rotations the app did not initiate — i.e. the player turning the phone.
 * Returns a teardown function.
 *
 * Rotations the app DOES initiate are covered ahead of time by whoever calls
 * the lock (see the race note above); this is the safety net for the rest.
 */
export function installRotationTransition({ settleMs = 120, maxHoldMs = 900 } = {}) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};

  const isLandscape = () => window.innerWidth > window.innerHeight;
  let orientation = isLandscape();

  // orientationchange is the reliable signal on native; the resize check is the
  // fallback for the browser build and for the lock/unlock calls in
  // lib/orientation.js, which change the shape of the viewport without the
  // device having physically turned.
  const onOrientationChange = () => beginRotationHold({ settleMs, maxHoldMs });
  const onResize = () => {
    if (isLandscape() !== orientation) {
      orientation = isLandscape();
      beginRotationHold({ settleMs, maxHoldMs });
    }
  };

  window.addEventListener('orientationchange', onOrientationChange);
  window.addEventListener('resize', onResize);

  return () => {
    window.removeEventListener('orientationchange', onOrientationChange);
    window.removeEventListener('resize', onResize);
    releaseHold();
  };
}
