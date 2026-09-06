// components/shareCardRenderer.js
// SkillDrills — the drawing half of the shared score card.
//
// Deliberately pure and dependency-free (no Capacitor, no React): it takes a
// 2D context and data and draws. That keeps it renderable outside the app, so
// the card can be previewed and eyeballed at every grade tier without
// rebuilding the APK — the alternative was a ~50s build plus playing a drill
// to see one variant. components/ShareScoreCard.js owns the canvas creation,
// font resolution and the native share sheet.
//
// Layout is two-column and 16:9: the result (score, then grade) reads down the
// left, supporting numbers sit in their own panel on the right. That split is
// what keeps it from feeling crowded — the eye lands on the score first and
// nothing competes with it. There is deliberately NO full-width rule under the
// header; a thin line across the card read as an empty progress/timer bar.
//
// Typography matters more than resolution here: the card used to draw in plain
// Arial while the app itself renders in Inter / Anton, which is most of why it
// looked like a generic screenshot rather than part of the product. The
// caller passes the real families in via `fonts`.
//
// Everything is drawn in a 640x360 logical space; the caller supersamples via
// ctx.scale() so the exported PNG is many times that.

import { getGradeByLetter } from '../lib/scoringEngine';

export const CARD_W = 640;
export const CARD_H = 360;

// New-best gold. On a personal best the card's accent switches to this and the
// grade badge keeps its own tier colour, so the image carries both facts at a
// glance: gold frame = a best, badge = how well they played.
const PB_GOLD = '#facc15';
const MUTED = '#98a2b3';
const DIM = '#606b7e';

const FALLBACK_UI = 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif';

/** Draw `text` with per-character tracking; canvas has no portable letterSpacing. */
function trackedText(ctx, text, x, y, spacing, align = 'left') {
  const chars = [...String(text)];
  const width = chars.reduce((w, c) => w + ctx.measureText(c).width + spacing, 0) - spacing;
  let cursor = align === 'center' ? x - width / 2 : align === 'right' ? x - width : x;
  const prevAlign = ctx.textAlign;
  ctx.textAlign = 'left';
  for (const c of chars) {
    ctx.fillText(c, cursor, y);
    cursor += ctx.measureText(c).width + spacing;
  }
  ctx.textAlign = prevAlign;
  return width;
}

/** Width `trackedText` would occupy, without drawing. */
function trackedWidth(ctx, text, spacing) {
  const chars = [...String(text)];
  return chars.reduce((w, c) => w + ctx.measureText(c).width + spacing, 0) - spacing;
}

/** #rrggbb -> rgba() at the given alpha. */
function alpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {Object} data
 * @param {number} data.score
 * @param {number} data.bestScore
 * @param {number} data.accuracy
 * @param {number} data.bestCombo
 * @param {{letter:string,label:string,emoji:string}} data.rating
 * @param {boolean} data.isNewBest
 * @param {string} data.drillName
 * @param {string|null} data.playerName  — username, or null when signed out
 * @param {{ui:string, display:string}} [data.fonts] — resolved CSS families
 * @param {number} [data.visualHits]
 * @param {number} [data.numberHits]
 */
export function drawShareCard(ctx, data) {
  const {
    score = 0, bestScore = 0, accuracy = 0, bestCombo = 0,
    rating, isNewBest = false, drillName = 'Drill', playerName = null,
    visualHits, numberHits, fonts,
  } = data;

  const UI = fonts?.ui || FALLBACK_UI;
  const DISPLAY = fonts?.display || UI;

  // The drills only forward letter/label/emoji, so the tier (and its colour)
  // is recovered from the letter here rather than changing 24 call sites.
  const tier = getGradeByLetter(rating?.letter);
  const tierHex = tier?.hex || MUTED;
  // Encouraging wording on the public image; the in-app screen keeps `label`.
  const label = (tier?.shareLabel || rating?.label || tier?.label || '').toUpperCase();
  const letter = rating?.letter || '—';
  const accent = isNewBest ? PB_GOLD : tierHex;

  ctx.textBaseline = 'alphabetic';

  // ── Background ──────────────────────────────────────────────────────────
  const bg = ctx.createLinearGradient(0, 0, CARD_W, CARD_H);
  bg.addColorStop(0, '#161b2d');
  bg.addColorStop(0.5, '#0c1020');
  bg.addColorStop(1, '#05070f');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  // Accent glow behind the score, so the tier colour reads even at thumbnail
  // size in a chat list without putting a coloured band across the card.
  const glow = ctx.createRadialGradient(160, 195, 10, 160, 195, 320);
  glow.addColorStop(0, alpha(accent, isNewBest ? 0.22 : 0.17));
  glow.addColorStop(1, alpha(accent, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  // Soft vignette — stops the flat corners reading as a screenshot.
  const vig = ctx.createRadialGradient(CARD_W / 2, CARD_H / 2, CARD_H * 0.35, CARD_W / 2, CARD_H / 2, CARD_W * 0.78);
  vig.addColorStop(0, 'rgba(0, 0, 0, 0)');
  vig.addColorStop(1, 'rgba(0, 0, 0, 0.55)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  // Frame: a soft halo plus a crisp hairline.
  //
  // The halo is faked with three concentric strokes at falling alpha rather
  // than ctx.shadowBlur. shadowBlur looks marginally softer but is brutally
  // expensive: canvas draw commands are deferred, so the blur was actually
  // rasterised during toBlob() and showed up as ~13s of "encode" time on a
  // mid-range Android device (it measured 25x slower than these strokes even
  // on desktop). Never reintroduce shadowBlur here.
  const halo = isNewBest ? 0.5 : 0.32;
  for (let i = 3; i >= 1; i--) {
    ctx.strokeStyle = alpha(accent, (halo / 6) * (4 - i));
    ctx.lineWidth = i * 2.5;
    roundRectPath(ctx, 2, 2, CARD_W - 4, CARD_H - 4, 22);
    ctx.stroke();
  }
  ctx.strokeStyle = alpha(accent, isNewBest ? 0.9 : 0.6);
  ctx.lineWidth = 2;
  roundRectPath(ctx, 2, 2, CARD_W - 4, CARD_H - 4, 22);
  ctx.stroke();

  // ── Header ──────────────────────────────────────────────────────────────
  ctx.font = `27px ${DISPLAY}`;
  ctx.fillStyle = '#ffffff';
  const skillW = trackedText(ctx, 'SKILL', 44, 62, 0.4);
  ctx.fillStyle = accent;
  trackedText(ctx, 'DRILLS', 44 + skillW + 0.4, 62, 0.4);

  ctx.fillStyle = DIM;
  ctx.font = `bold 9px ${UI}`;
  trackedText(ctx, 'TRAIN. FOCUS. IMPROVE.', 45, 80, 2.2);

  // Right side: who + which drill. The username is the reason the card feels
  // like someone's result rather than a generic screenshot.
  if (playerName) {
    const handle = playerName;
    let size = 17;
    ctx.font = `bold ${size}px ${UI}`;
    const room = CARD_W - 44 - (44 + skillW + 96);
    while (ctx.measureText(handle).width > room && size > 12) {
      size -= 1;
      ctx.font = `bold ${size}px ${UI}`;
    }
    let shown = handle;
    while (shown.length > 4 && ctx.measureText(shown).width > room) shown = shown.slice(0, -2);
    if (shown !== handle) shown = `${shown}…`;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'right';
    ctx.fillText(shown, CARD_W - 44, 60);
    ctx.textAlign = 'left';
  }

  ctx.fillStyle = MUTED;
  ctx.font = `13px ${UI}`;
  ctx.textAlign = 'right';
  ctx.fillText(drillName, CARD_W - 44, 80);
  const dotX = CARD_W - 48 - ctx.measureText(drillName).width - 9;
  ctx.textAlign = 'left';
  ctx.beginPath();
  ctx.arc(dotX, 76, 3, 0, Math.PI * 2);
  ctx.fillStyle = accent;
  ctx.fill();

  // ── Left column: personal best → score → grade ──────────────────────────
  // Without the ribbon the whole block shifts up so the column stays visually
  // centred instead of hanging off the top.
  const shift = isNewBest ? 0 : -16;

  if (isNewBest && score > 0) {
    // The single reason someone shares. A tagged ribbon, not a small pill.
    ctx.font = `bold 12px ${UI}`;
    const rw = trackedWidth(ctx, 'NEW PERSONAL BEST', 2) + 34;
    const rh = 27;
    const rx = 44;
    const ry = 108;
    ctx.fillStyle = PB_GOLD;
    ctx.beginPath();
    ctx.moveTo(rx, ry);
    ctx.lineTo(rx + rw, ry);
    ctx.lineTo(rx + rw - 11, ry + rh / 2);
    ctx.lineTo(rx + rw, ry + rh);
    ctx.lineTo(rx, ry + rh);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#231b02';
    trackedText(ctx, 'NEW PERSONAL BEST', rx + 15, ry + 18, 2);
  }

  // Score — the hero. Shrinks for long numbers so it can never reach the panel.
  const scoreText = score.toLocaleString();
  let scoreSize = 88;
  ctx.font = `${scoreSize}px ${DISPLAY}`;
  while (ctx.measureText(scoreText).width > 254 && scoreSize > 46) {
    scoreSize -= 3;
    ctx.font = `${scoreSize}px ${DISPLAY}`;
  }
  ctx.fillStyle = '#ffffff';
  ctx.fillText(scoreText, 44, 214 + shift);

  // Grade below the score: the real grade letter, big, then the word.
  const badge = 46;
  const bx = 46;
  const by = 236 + shift;
  roundRectPath(ctx, bx, by, badge, badge, 13);
  ctx.fillStyle = alpha(tierHex, 0.16);
  ctx.fill();
  ctx.strokeStyle = alpha(tierHex, 0.9);
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = tierHex;
  ctx.font = `${letter.length > 1 ? 22 : 27}px ${DISPLAY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(letter, bx + badge / 2, by + badge / 2 + 1);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';

  ctx.fillStyle = tierHex;
  ctx.font = `19px ${DISPLAY}`;
  trackedText(ctx, label, bx + badge + 16, by + 31, 2);

  // ── Right column: the supporting numbers, boxed off on their own ────────
  const px = 336;
  const pw = CARD_W - 44 - px;
  const py = 112;
  const ph = 158;
  roundRectPath(ctx, px, py, pw, ph, 18);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // On a personal best the score IS the best, so repeating it is wasted space
  // — that column becomes the previous best, which is what makes the jump
  // legible to someone reading the card.
  const stats = [
    { label: 'ACCURACY', value: `${accuracy}%` },
    { label: 'BEST COMBO', value: `${bestCombo}x` },
    isNewBest && bestScore > 0
      ? { label: 'PREV. BEST', value: bestScore.toLocaleString() }
      : { label: 'BEST SCORE', value: Math.max(bestScore, score).toLocaleString() },
  ];

  const colW = pw / 3;
  stats.forEach((s, i) => {
    const cx = px + colW * i + colW / 2;

    // Labels are near-identical in length but not identical; shrink any that
    // would otherwise run into the neighbouring column's label.
    let ls = 10;
    let track = 1.2;
    for (;;) {
      ctx.font = `bold ${ls}px ${UI}`;
      if (trackedWidth(ctx, s.label, track) <= colW - 12 || ls <= 7) break;
      ls -= 0.5;
      track = Math.max(0.4, track - 0.1);
    }
    ctx.fillStyle = DIM;
    ctx.font = `bold ${ls}px ${UI}`;
    trackedText(ctx, s.label, cx, py + 62, track, 'center');

    let vs = 30;
    ctx.font = `${vs}px ${DISPLAY}`;
    while (ctx.measureText(s.value).width > colW - 16 && vs > 16) {
      vs -= 2;
      ctx.font = `${vs}px ${DISPLAY}`;
    }
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.fillText(s.value, cx, py + 102);
    ctx.textAlign = 'left';

    if (i > 0) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px + colW * i, py + 30);
      ctx.lineTo(px + colW * i, py + ph - 30);
      ctx.stroke();
    }
  });

  // Optional per-drill extras (only Divided Attention-style drills pass these),
  // tucked under the panel so they never disturb the main layout.
  if (visualHits !== undefined || numberHits !== undefined) {
    const extras = [];
    if (visualHits !== undefined) extras.push(`Ball hits ${visualHits}`);
    if (numberHits !== undefined) extras.push(`Number hits ${numberHits}`);
    ctx.fillStyle = DIM;
    ctx.font = `11px ${UI}`;
    ctx.textAlign = 'center';
    ctx.fillText(extras.join('   ·   '), px + pw / 2, py + ph + 20);
    ctx.textAlign = 'left';
  }

  // ── Footer: one call to action, nothing else ────────────────────────────
  const fy = 296;
  const fh = 44;
  roundRectPath(ctx, 44, fy, CARD_W - 88, fh, 14);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.035)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.07)';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = MUTED;
  ctx.font = `bold 12px ${UI}`;
  trackedText(ctx, 'CAN YOU BEAT THIS?', 66, fy + 27, 1.6);

  ctx.fillStyle = accent;
  ctx.font = `bold 13px ${UI}`;
  trackedText(ctx, 'GET IT ON GOOGLE PLAY  ›', CARD_W - 66, fy + 27, 1.6, 'right');
}
