// lib/useCountUp.js
// SkillDrills — result-screen number roll.
//
// Eases a number from 0 up to `target` once, on mount. Deliberately scoped to
// the RESULT screen: this is the one place in the app where a per-frame rAF is
// free, because the drill's game loop has already stopped by the time the
// result card mounts. Do NOT reuse this inside a playing drill — the motion
// drills run their step on a ~14ms budget and every extra rAF subscriber eats
// into it.
//
// Reduced motion short-circuits to the final value on the first render, so the
// number is never mid-roll for a player who asked for no animation.

import { useEffect, useRef, useState } from 'react';

function prefersReducedMotion() {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * @param {number} target — the number to land on.
 * @param {number} ms — roll duration.
 * @returns {number} the current value, rounded.
 */
export default function useCountUp(target, ms = 600) {
  const safeTarget = Number.isFinite(target) ? target : 0;
  // Start AT the target when there is nothing to roll — a zero or negative
  // target counting up from 0 would just sit there. This has to be decided
  // from the DATA alone: the pages are prerendered (`output: 'export'`), so
  // any first-render value that depends on the browser — matchMedia included —
  // is a hydration mismatch. Reduced motion is therefore handled inside the
  // effect, one frame later, which never runs on the server.
  const skip = safeTarget <= 0 || ms <= 0;
  const [value, setValue] = useState(skip ? safeTarget : 0);
  const frameRef = useRef(0);

  useEffect(() => {
    if (skip || prefersReducedMotion()) {
      setValue(safeTarget);
      return undefined;
    }
    let start = 0;
    const step = (now) => {
      if (!start) start = now;
      const t = Math.min(1, (now - start) / ms);
      // ease-out cubic — fast off the line, settles onto the number.
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(Math.round(safeTarget * eased));
      if (t < 1) frameRef.current = requestAnimationFrame(step);
    };
    frameRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frameRef.current);
  }, [safeTarget, ms, skip]);

  return value;
}
