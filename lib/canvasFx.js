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

// Cache for a canvas backdrop that never changes during play — the flat fill
// plus whatever grid/dot pattern a drill sits its game on top of.
//
// Drills were rebuilding these every single frame: dozens of stroked grid lines,
// or in the worst cases a nested loop laying down one fillRect per dot (150+
// draw calls a frame, ~9,000 a second) to reproduce a picture that is pixel-for-
// pixel identical to the previous frame. Render it once here, then each frame is
// a single drawImage.
//
// `drawFn(ctx, w, h)` is called with a context already scaled for the device
// pixel ratio, so it can draw in plain CSS pixels. It re-runs only when the
// canvas size actually changes.
//
// Usage:
//   const backdrop = createBackdropCache((c, w, h) => { ...draw... });
//   if (backdrop.ensure(W, H, dpr)) ctx.drawImage(backdrop.canvas, 0, 0, W, H);
export function createBackdropCache(drawFn) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { alpha: false });
  let cachedW = 0;
  let cachedH = 0;

  return {
    canvas,
    ensure(w, h, dpr) {
      if (!ctx || w <= 0 || h <= 0) return false;
      if (cachedW === w && cachedH === h && canvas.width > 0) return true;
      cachedW = w;
      cachedH = h;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawFn(ctx, w, h);
      return true;
    },
  };
}

// Backing-store scale for game canvases, capped at 2. Phones report
// devicePixelRatio of 2.6-3.5, and canvas pixel work grows with the SQUARE
// of this — a DPR-3 phone pays 2.25x the fill cost of DPR-2 for a sharpness
// difference that's invisible in a fast-moving game. Every place that sizes,
// scales, or hit-tests one of these canvases must use this same value.
export function canvasDpr() {
  return Math.min(window.devicePixelRatio || 1, 2);
}

// Backing-store scale for MOTION-heavy game canvases. Same cap as canvasDpr().
//
// This used to cap at 1.5 on the theory that backing-store size sets sustained
// GPU load and therefore heat. That was measured on the real device (Realme
// RMX3630, Chrome 150 WebView) and is wrong: a full worst-case Quick Dodge
// frame — full-screen backdrop blit plus 42 obstacles with every layer — costs
//
//     dpr 1.5 -> 0.37ms      dpr 2 -> 0.41ms      dpr 2.55 (native) -> 0.45ms
//
// against a 16.7ms budget. The whole 1.5 -> native range is under 3% of a
// frame, so the cap saved ~0.08ms/frame and in exchange rendered every motion
// drill at 59% linear resolution and upscaled it, which is visible as softness
// on exactly the fast-moving edges it was supposed to be hiding behind.
//
// Frame timing on the device with the 1.5 cap in place was already a flat
// 59.4fps with zero dropped frames, so there was no headroom problem to solve.
// See [[project-drill-perf-measurements]] for the full numbers.
//
// Kept as a separate function from canvasDpr() so the "one canvas must use ONE
// of these consistently for sizing, scaling and hit-testing" contract at the
// call sites stays intact, and so the motion drills can be re-tuned as a group
// if a genuinely slower device ever turns up.
export function motionDpr() {
  return Math.min(window.devicePixelRatio || 1, 2);
}

// Pre-renders the shared "layered circle" target (ghost ring + tactical ring +
// filled body + white sheen + white core dot) once per colour/radius pair and
// hands back an offscreen canvas to blit.
//
// Every one of these drills was drawing that target with five arc() calls —
// two strokes and three fills — per object per frame. Batch Processing carries
// up to 18 objects, so that was ~90 path fills per frame, ~5,400 a second, to
// re-draw shapes that are pixel-for-pixel identical every time; only their
// x/y changes. Rasterising a path is the expensive half of that work, and it
// was being repeated for no reason.
//
// Cached, each object costs ONE drawImage of a small pre-rasterised bitmap.
// The cache is keyed on colour+radius+dpr and these drills use a fixed radius
// (or a couple of them), so it fills up within the first frame and never
// grows again.
//
// Draw with drawSprite() below rather than by hand — the sprite is padded, so
// its centre is not at (0,0) and blitting it at the object's raw x/y would
// offset every target by the padding amount.
export function createLayeredSpriteCache() {
  const cache = new Map();
  const PAD = 8; // room for the r+5 ghost ring and its stroke width

  return {
    get(color, radius, dpr) {
      const r = Math.round(radius);
      const key = color + '|' + r + '|' + dpr;
      const hit = cache.get(key);
      if (hit) return hit;

      const half = r + PAD;
      const size = half * 2;
      const cvs = document.createElement('canvas');
      cvs.width = Math.max(1, Math.round(size * dpr));
      cvs.height = Math.max(1, Math.round(size * dpr));
      const c = cvs.getContext('2d');
      if (!c) return null;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Flat fills only — no gradient/shadowBlur. That combination is a known
      // Android WebView rendering bug (see DividedAttentionClient.js's notes),
      // and this preserves the exact look the drills already shipped with.
      c.globalAlpha = 0.2;
      c.strokeStyle = color;
      c.lineWidth = 1.0;
      c.beginPath();
      c.arc(half, half, r + 5, 0, Math.PI * 2);
      c.stroke();

      c.globalAlpha = 0.55;
      c.strokeStyle = color;
      c.lineWidth = 1.8;
      c.beginPath();
      c.arc(half, half, r, 0, Math.PI * 2);
      c.stroke();

      c.globalAlpha = 0.88;
      c.fillStyle = color;
      c.beginPath();
      c.arc(half, half, r * 0.82, 0, Math.PI * 2);
      c.fill();

      c.globalAlpha = 0.3;
      c.fillStyle = '#ffffff';
      c.beginPath();
      c.arc(half - r * 0.2, half - r * 0.2, r * 0.28, 0, Math.PI * 2);
      c.fill();

      c.globalAlpha = 1.0;
      c.fillStyle = '#ffffff';
      c.beginPath();
      c.arc(half, half, r * 0.18, 0, Math.PI * 2);
      c.fill();

      const sprite = { canvas: cvs, half, size };
      cache.set(key, sprite);
      return sprite;
    },
  };
}

// Blits a sprite from createLayeredSpriteCache() centred on (x, y).
export function drawSprite(ctx, sprite, x, y) {
  if (!sprite) return;
  ctx.drawImage(sprite.canvas, x - sprite.half, y - sprite.half, sprite.size, sprite.size);
}
