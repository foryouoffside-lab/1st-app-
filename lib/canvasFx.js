// lib/canvasFx.js
// Shared canvas-drawing helpers for duel drills that render their moving
// game pieces on a single <canvas> instead of individually-animated DOM
// elements (see ARENA_CANVAS_PERFORMANCE_PLAN.md). Pulled out of
// QuickDodgeClient.js so Divided Attention, Multi-Tasking, and Selective
// Attention don't each reimplement the same pulse-ring/hit-test math.

// Expanding, fading ring — the canvas equivalent of Tailwind's `animate-ping`
// on an `absolute inset-0 rounded-full` div. Cycles over `periodSec` using
// `(time + seed) % periodSec` so multiple simultaneous rings (e.g. two
// on-screen targets) don't pulse in perfect lockstep.
export function drawPulseRing(ctx, x, y, baseR, color, time, seed, periodSec, maxScale, alphaStart) {
  const cycle = ((time + seed) % periodSec) / periodSec;
  const ringR = baseR * (1 + cycle * (maxScale - 1));
  const alpha = alphaStart * (1 - cycle);
  if (alpha <= 0) return;
  ctx.beginPath();
  ctx.arc(x, y, ringR, 0, Math.PI * 2);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.globalAlpha = alpha;
  ctx.stroke();
  ctx.globalAlpha = 1.0;
}

// Plain circular hit test — works in whatever coordinate space the caller
// passes (pixels or percentage), since it's just Euclidean distance vs. radius.
export function hitTestCircle(px, py, cx, cy, r) {
  return Math.hypot(px - cx, py - cy) <= r;
}

// Backing-store scale for game canvases, capped at 2. Phones report
// devicePixelRatio of 2.6-3.5, and canvas pixel work grows with the SQUARE
// of this — a DPR-3 phone pays 2.25x the fill cost of DPR-2 for a sharpness
// difference that's invisible in a fast-moving game. Every place that sizes,
// scales, or hit-tests one of these canvases must use this same value.
export function canvasDpr() {
  return Math.min(window.devicePixelRatio || 1, 2);
}
