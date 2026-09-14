'use client';

/*
 * TEMP DEBUG — duel timing trace.  [DUEL-TRACE]
 *
 * Measures where the wall-clock time actually goes between "opponent accepted"
 * and "GO", so the 3-2-1 freeze can be fixed against numbers instead of guesses.
 *
 * Every line it prints is prefixed `[duel-trace]`, so both sides of a live test
 * can be read with:
 *    adb logcat -s chromium:D | grep duel-trace        (phone)
 *    browser devtools console filter: duel-trace       (laptop)
 *
 * Silent in production (see ENABLED below), so this is safe to leave in place.
 * To remove it for good once the Arena work is closed out:
 * `grep -rn "DUEL-TRACE"` finds every call site, then delete this file.
 */

// OFF in production builds, ON in development — decided at build time, so the
// bundler strips the check and a shipped app pays nothing for any of this.
//
// Not deleted outright because the Arena work isn't finished and this is what
// caught the two bugs that mattered most: the 6.4s clock probe freezing the
// 3-2-1, and the profile read that returned "exists:false" for an account that
// plainly existed and pushed a signed-in player to the name gate.
//
// The localStorage escape hatch means a weird report on a RELEASE build can be
// investigated without rebuilding and reinstalling anything. In the device's
// WebView console, or via adb:
//     localStorage.setItem('sd_debug_trace', '1')   // then reload
//     localStorage.removeItem('sd_debug_trace')     // back to silent
const ENABLED = (() => {
  if (typeof window === 'undefined') return false;
  try {
    if (window.localStorage.getItem('sd_debug_trace') === '1') return true;
  } catch {}
  return process.env.NODE_ENV !== 'production';
})();

let t0 = null;
let lastAt = null;
const seen = new Set();

/** Start a fresh timeline (called when a duel doc is first subscribed to). */
export function duelTraceReset(label = 'duel start') {
  if (!ENABLED) return;
  t0 = null;
  lastAt = null;
  seen.clear();
  duelTrace(label);
}

/**
 * Log a milestone. `since` is ms from the first milestone of this duel,
 * `delta` is ms since the previous one — the delta is the number that matters,
 * it's the gap the player is actually staring at.
 */
export function duelTrace(label, extra) {
  if (!ENABLED || typeof console === 'undefined') return;
  const now = Date.now();
  if (t0 == null) t0 = now;
  const since = now - t0;
  const delta = lastAt == null ? 0 : now - lastAt;
  lastAt = now;
  const body = extra ? `  ${JSON.stringify(extra)}` : '';
  console.log(
    `[duel-trace] +${String(since).padStart(5)}ms (+${String(delta).padStart(4)}) ${label}${body}`
  );
}

/** Log a milestone only the first time it happens in this duel. */
export function duelTraceOnce(label, extra) {
  if (!ENABLED) return;
  if (seen.has(label)) return;
  seen.add(label);
  duelTrace(label, extra);
}
