'use client';

// Grid Memorization — animated card preview.
// A 4×4 board plays the drill's core loop on repeat:
//   1. six cells light indigo  — the pattern to memorize
//   2. the board goes dark     — recall phase begins
//   3. the same six pop cyan, one after another in a short cascade
//   4. snap back to step 1     — a fresh pattern
//
// All motion is CSS (see `.gm-prev*` in styles/globals.css). The six lit cells
// share one keyframe; a small negative animation-delay per cell (in play order)
// is what turns the single simultaneous "recall" beat into a cascade without a
// second timeline. Indices are hand-picked to sit apart on the board so the
// shape reads as a real pattern rather than a blob.

// Chosen to sit clear of the thumbnail's four corners (difficulty pill,
// play button, duration) and to spread across the board so the shape reads
// as a deliberate pattern.
const LIT = [2, 5, 7, 9, 10, 13];

export default function GridMemorizationPreview() {
  return (
    <div className="gm-prev" aria-hidden="true">
      <div className="gm-prev-grid">
        {Array.from({ length: 16 }).map((_, i) => {
          const order = LIT.indexOf(i);
          const on = order !== -1;
          return (
            <span
              key={i}
              className={on ? 'gm-prev-cell gm-prev-on' : 'gm-prev-cell'}
              style={on ? { animationDelay: `${(-0.055 * order).toFixed(3)}s` } : undefined}
            />
          );
        })}
      </div>
    </div>
  );
}
