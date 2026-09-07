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
// Layout is the "Instrument" card, 16:9: near-black ground with a faint dot
// grid, the score set huge and clamped by the drill's corner brackets, a mono
// readout row above and a single accent challenge/link line below. The score is
// the whole card; nothing competes with it.
//
// Typography matters more than resolution here: the card used to draw in plain
// Arial while the app itself renders in Inter / Anton / IBM Plex Mono, which is
// most of why it looked like a generic screenshot rather than part of the
// product. The caller passes the real families in via `fonts` (ui, display, mono).
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
// One accent for the card chrome — the brand violet, same as the app. The
// grade BADGE keeps its own tier colour (that's information); everything else
// — the top edge, the score brackets, the link — is violet, or gold on a
// personal best.
const BRAND = '#8b5cf6';
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
 * @param {string} [data.linkText]  — the link shown on the card (default SKILLDRILLS.ONLINE)
 * @param {{ui:string, display:string, mono:string}} [data.fonts] — resolved CSS families
 */
export function drawShareCard(ctx, data) {
  const {
    score = 0, bestScore = 0, accuracy = 0, bestCombo = 0,
    rating, isNewBest = false, drillName = 'Drill', playerName = null,
    linkText = 'SKILLDRILLS.ONLINE', fonts,
  } = data;

  const UI = fonts?.ui || FALLBACK_UI;
  const DISPLAY = fonts?.display || UI;
  const MONO = fonts?.mono || UI;

  // The drills only forward letter/label/emoji, so the tier (and its colour)
  // is recovered from the letter here rather than changing 24 call sites.
  const tier = getGradeByLetter(rating?.letter);
  const tierHex = tier?.hex || MUTED;
  // Encouraging wording on the public image; the in-app screen keeps `label`.
  const label = (tier?.shareLabel || rating?.label || tier?.label || '').toUpperCase();
  const letter = rating?.letter || '—';
  const accent = isNewBest ? PB_GOLD : BRAND;

  ctx.textBaseline = 'alphabetic';

  // ══ "Instrument" layout ════════════════════════════════════════════════
  // The signature look: near-black ground, a faint dot grid, the score as the
  // whole card clamped by the drill's corner brackets, everything else a quiet
  // mono readout around it. One accent line at the foot carries the challenge
  // and the link. See the options deck this was chosen from.

  // ── Ground ─────────────────────────────────────────────────────────────
  const bg = ctx.createLinearGradient(0, 0, 0, CARD_H);
  bg.addColorStop(0, '#0b0c13');
  bg.addColorStop(1, '#050508');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  // The Field — a faint dot grid, drawn once. 1.6px squares are the smallest
  // that survive the toBlob() downsample without shimmering.
  ctx.fillStyle = 'rgba(255, 255, 255, 0.032)';
  for (let y = 22; y < CARD_H; y += 22) {
    for (let x = 22; x < CARD_W; x += 22) ctx.fillRect(x, y, 1.6, 1.6);
  }

  // Accent glow behind the score, faded fully within the card so it never
  // reads as a band. Full-card fill because the radial already ends at 0.
  const glow = ctx.createRadialGradient(210, 180, 10, 210, 180, 250);
  glow.addColorStop(0, alpha(accent, isNewBest ? 0.18 : 0.13));
  glow.addColorStop(1, alpha(accent, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  // Vignette — stops the flat corners reading as a screenshot. No drawn
  // border: the shared image is already a rectangle, and a rounded accent
  // frame inside it read as a sticker slapped on the chat.
  const vig = ctx.createRadialGradient(CARD_W / 2, CARD_H / 2, CARD_H * 0.4, CARD_W / 2, CARD_H / 2, CARD_W * 0.8);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(0,0,0,0.5)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  // A single hairline top edge in the accent — a channel indicator, not a
  // frame. Full width, 3px, at the very top.
  ctx.fillStyle = alpha(accent, isNewBest ? 0.95 : 0.8);
  ctx.fillRect(0, 0, CARD_W, 3);

  // ── Top row: accent tick · drill (left) · handle (right) ────────────────
  ctx.fillStyle = accent;
  ctx.fillRect(44, 42, 4, 15);

  ctx.font = `600 12px ${MONO}`;
  ctx.fillStyle = MUTED;
  trackedText(ctx, drillName.toUpperCase(), 60, 54, 2.2);

  // The handle is the reason the card feels like someone's result. No "@" —
  // Google display names are often "First Last" and "@First Last" reads wrong.
  const handle = (playerName || 'A SKILLDRILLS PLAYER').toUpperCase();
  let hSize = 12;
  ctx.font = `500 ${hSize}px ${MONO}`;
  const hRoom = 210;
  let hShown = handle;
  while (trackedWidth(ctx, hShown, 2) > hRoom && hShown.length > 5) {
    hShown = hShown.slice(0, -2);
  }
  if (hShown !== handle) hShown += '…';
  ctx.fillStyle = DIM;
  trackedText(ctx, hShown, CARD_W - 44 - trackedWidth(ctx, hShown, 2), 54, 2);

  // ── Score — the hero, clamped by the Lock ──────────────────────────────
  const scoreText = score.toLocaleString();
  let scoreSize = 96;
  ctx.font = `${scoreSize}px ${DISPLAY}`;
  while (ctx.measureText(scoreText).width > 400 && scoreSize > 52) {
    scoreSize -= 4;
    ctx.font = `${scoreSize}px ${DISPLAY}`;
  }
  const sx = 44;
  const sy = 206;
  const sw = ctx.measureText(scoreText).width;
  ctx.fillStyle = '#ffffff';
  ctx.fillText(scoreText, sx, sy);

  // Corner brackets: top-left and bottom-right, in the accent. Box tracks the
  // Anton cap height (~0.72 of the size, no descender) so it hugs the digits.
  const lx = sx - 14;
  const ly = sy - Math.round(scoreSize * 0.73);
  const lw = sw + 28;
  const lh = Math.round(scoreSize * 0.80);
  const len = 20;
  ctx.strokeStyle = accent;
  ctx.lineWidth = 3;
  ctx.lineCap = 'butt';
  ctx.beginPath();
  ctx.moveTo(lx, ly + len); ctx.lineTo(lx, ly); ctx.lineTo(lx + len, ly);
  ctx.moveTo(lx + lw - len, ly + lh); ctx.lineTo(lx + lw, ly + lh); ctx.lineTo(lx + lw, ly + lh - len);
  ctx.stroke();

  // POINTS + the delta on a personal best.
  ctx.font = `500 11px ${MONO}`;
  ctx.fillStyle = DIM;
  const ptsW = trackedText(ctx, 'POINTS', sx, sy + 28, 3);
  if (isNewBest && bestScore > 0 && score > bestScore) {
    ctx.fillStyle = '#34d399';
    trackedText(ctx, `NEW BEST  ·  +${(score - bestScore).toLocaleString()}`, sx + ptsW + 20, sy + 28, 2);
  } else if (isNewBest) {
    ctx.fillStyle = '#34d399';
    trackedText(ctx, 'NEW BEST', sx + ptsW + 20, sy + 28, 2);
  }

  // ── Grade badge (right) ────────────────────────────────────────────────
  const bSize = 92;
  const bx = CARD_W - 44 - bSize;
  const by = 82;
  roundRectPath(ctx, bx, by, bSize, bSize, 14);
  ctx.fillStyle = alpha(tierHex, 0.12);
  ctx.fill();
  ctx.strokeStyle = alpha(tierHex, 0.85);
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.fillStyle = tierHex;
  ctx.font = `${letter.length > 1 ? 40 : 52}px ${DISPLAY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(letter, bx + bSize / 2, by + bSize / 2 + 3);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';

  if (label) {
    ctx.fillStyle = alpha(tierHex, 0.9);
    ctx.font = `500 10px ${MONO}`;
    trackedText(ctx, label, bx + bSize / 2, by + bSize + 18, 2, 'center');
  }

  // ── Foot: the challenge + the link ─────────────────────────────────────
  const fy = 292;
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(44, fy - 22);
  ctx.lineTo(CARD_W - 44, fy - 22);
  ctx.stroke();

  ctx.fillStyle = '#ffffff';
  ctx.font = `22px ${DISPLAY}`;
  ctx.fillText('CAN YOU BEAT THIS?', 44, fy + 6);

  ctx.fillStyle = accent;
  ctx.font = `600 12px ${MONO}`;
  const linkW = trackedWidth(ctx, linkText, 2);
  trackedText(ctx, linkText, CARD_W - 44 - linkW, fy + 4, 2);
  ctx.fillRect(CARD_W - 44 - linkW, fy + 11, linkW, 2);
}
