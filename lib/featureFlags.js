// lib/featureFlags.js

// Single on/off switch for Arena/duel mode. Turned off for initial launch
// after live duels ran devices hot. Since then two optimization passes have
// landed: (1) the canvas rendering rewrite (see
// ARENA_CANVAS_PERFORMANCE_PLAN.md), and (2) the 2026-07-19 mobile pass —
// devicePixelRatio capped at 2, draw loops capped at 60fps for high-refresh
// phones, per-frame shadowBlur removed, Conflict Reflex's static background
// pre-rendered, and Batch Processing's frame-rate-dependent ball speed
// fixed. Flip to true to test on a real phone; every Arena entry point (the
// home page's live-duel list, the /challenge tab, and each drill's in-game
// "Duel" button) reads this one flag, so nothing else needs to change to
// bring it back.
export const ARENA_ENABLED = true;
