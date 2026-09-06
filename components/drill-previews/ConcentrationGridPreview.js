'use client';

// Concentration Grid — animated card preview.
// The drill's board being cleared: a shuffled number grid, tapped 1, 2, 3, 4…
// in order, each cell taking the drill's "found" style as it goes — green-500
// at 20%, its green border and text, scaled to 95% and dimmed to 55%. The
// board finishes clear, holds, and a fresh one starts.
//
// The cells are the drill's GridBoard cells: slate-900 with a white/15
// hairline, rounded-xl, black numerals, and its found styling on the way out.
// A 4x4 is one of the drill's real boards — it opens at 3x3 and grows by one
// with every board cleared — chosen here because at 100-170px of thumbnail the
// numerals on a 5x5 stop being readable at all.
//
// The "Find N" badge is HUD, so it is not here: the order reads from the
// sequence itself. The board deals the same arrangement every lap where the
// drill deals a fresh shuffle after each clear — nothing in a six-second loop
// can show that, and one board that stays put is easier to read.
//
// background-color, border-color, color, transform and opacity only — see
// `.cg-prev*` in styles/globals.css.

// A shuffled board, as generateNewGrid produces (cells hold no rotation below
// 5x5). Index order is reading order; `.cg-prev-n<k>` carries the moment the
// number k is found.
const BOARD = [7, 13, 2, 10, 14, 4, 16, 5, 1, 11, 8, 15, 12, 6, 3, 9];

export default function ConcentrationGridPreview() {
  return (
    <div className="cg-prev" aria-hidden="true">
      <div className="cg-prev-grid">
        {BOARD.map(n => (
          <span key={n} className={`cg-prev-cell cg-prev-n${n}`}>{n}</span>
        ))}
      </div>
    </div>
  );
}
