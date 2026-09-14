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

const ROTATING_CLASS = 'sd-rotating';

/**
 * Start masking rotations. Returns a teardown function.
 *
 * settleMs  how long the viewport must hold one size before we call the
 *           rotation finished. Android emits a burst of resizes during the
 *           turn and innerWidth/innerHeight cross over partway through, so
 *           reacting to the first event lands mid-animation — the same reason
 *           onOrientationSettled in lib/orientation.js waits.
 * maxHoldMs hard ceiling. A device that never stops reporting new sizes must
 *           still get its content back, so the cover always lifts.
 */
export function installRotationTransition({ settleMs = 120, maxHoldMs = 900 } = {}) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};

  const root = document.documentElement;
  const isLandscape = () => window.innerWidth > window.innerHeight;

  let orientation = isLandscape();
  let raf = 0;
  let holding = false;

  const release = () => {
    holding = false;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    root.classList.remove(ROTATING_CLASS);
  };

  const hold = () => {
    if (holding) return; // already covering this rotation
    holding = true;
    root.classList.add(ROTATING_CLASS);

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
        orientation = isLandscape();
        release();
        return;
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
  };

  // orientationchange is the reliable signal on native; the resize check is the
  // fallback for the browser build and for the lock/unlock calls in
  // lib/orientation.js, which change the shape of the viewport without the
  // device having physically turned.
  const onOrientationChange = () => hold();
  const onResize = () => {
    if (isLandscape() !== orientation) hold();
  };

  window.addEventListener('orientationchange', onOrientationChange);
  window.addEventListener('resize', onResize);

  return () => {
    window.removeEventListener('orientationchange', onOrientationChange);
    window.removeEventListener('resize', onResize);
    release();
  };
}
