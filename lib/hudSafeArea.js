// lib/hudSafeArea.js
// Where a drill must NOT put a tappable target.
//
// DrillWrapper paints three things over the play field: the score (top-left),
// the endurance clock (top-right) and the mute button (bottom-right). Drills
// that place targets at a random point in the field had no idea those existed,
// so targets spawned behind the digits — unreadable, and on the mute button
// actually untappable, because the button swallowed the tap and muted the drill
// instead of scoring it.
//
// Sizing note: the boxes are fractions of the SHORT side, not of each axis.
// The HUD is a fixed physical size, so min(W,H) keeps these boxes the same real
// size in portrait and in landscape rather than stretching with the long axis.
// Fractions rather than pixels so the same numbers work whether the caller is
// measuring in CSS pixels or device pixels — both scale together.
//
// Only for drills whose targets STAY where they are put. A falling-object drill
// (none ship today) must not use this: excluding columns there would carve
// permanently dead lanes out of the field, which is a gameplay change, not a
// bug fix.

/**
 * The HUD keep-out rectangles for a field of W x H.
 * @returns {Array<{x0:number,y0:number,x1:number,y1:number}>}
 */
export function hudBlocks(W, H) {
  const u = Math.min(W, H);
  return [
    { x0: 0,            y0: 0,            x1: 0.26 * u, y1: 0.17 * u }, // score
    { x0: W - 0.42 * u, y0: 0,            x1: W,        y1: 0.20 * u }, // clock
    { x0: W - 0.20 * u, y0: H - 0.20 * u, x1: W,        y1: H        }, // mute
  ];
}

/**
 * True if a disc of radius r centred at (x, y) would touch any HUD box.
 * Callers should treat a true result as "reject this candidate and re-roll".
 */
export function clashesWithHud(x, y, r, W, H) {
  return hudBlocks(W, H).some(
    (b) => x + r > b.x0 && x - r < b.x1 && y + r > b.y0 && y - r < b.y1
  );
}

/**
 * A random point in the field that no HUD box covers.
 *
 * Falls back to the centre of the field after `tries` rejections — the centre
 * is the one spot no HUD box can ever reach, so this can't loop forever or
 * return a blocked point on a very small screen.
 *
 * @param {number} W field width
 * @param {number} H field height
 * @param {number} r target radius (kept clear of the boxes)
 * @param {number} [pad] edge padding; defaults to r + 20
 * @returns {{x:number, y:number}}
 */
export function pickClearPoint(W, H, r, pad, tries = 30) {
  const padding = pad == null ? r + 20 : pad;
  const spanW = Math.max(0, W - padding * 2);
  const spanH = Math.max(0, H - padding * 2);
  for (let i = 0; i < tries; i += 1) {
    const x = padding + Math.random() * spanW;
    const y = padding + Math.random() * spanH;
    if (!clashesWithHud(x, y, r, W, H)) return { x, y };
  }
  return { x: W / 2, y: H / 2 };
}
