'use client';

// Shade Finder — animated card preview.
// The drill's own board, two rounds on a loop:
//   1. a 7x7 grid in one random hue, with a single cell nine lightness points
//      off the rest — the whole task
//   2. that cell presses in (the drill's active:scale-[0.93]) — found
//   3. the board re-rolls instantly into a new hue with the odd cell somewhere
//      else, and that one gets found too
//
// The board is the drill's: its rounded panel over #0c0c16/70 with the white/5
// hairline, its 7x7 opening grid (GRID_START) of rounded-md cells at the same
// gap, and colours built the way spawnRound builds them — one random hue at
// 65-85% saturation and 40-60% lightness for every cell, and SHADE_DELTA = 9
// points of lightness for the odd one. Two rounds in 6s is the drill's own
// opening pace (WINDOW_START_MS = 3000).
//
// No ring, no tick, no marker on the found cell: the drill has none. A correct
// find there is the press and the board re-rolling (its cyan flash is
// deliberately blank — see .fx-flash-cyan in globals.css), so that is what the
// preview shows.
//
// Pure CSS — background-color and transform only, see `.sf-prev*` in
// styles/globals.css. The base cells share one timeline, so the re-roll is one
// computed-value change rather than 49.

const CELLS = 49;          // 7x7, the drill's GRID_START board
const ODD_ROUND_1 = 16;    // row 3, col 3
const ODD_ROUND_2 = 32;    // row 5, col 5

export default function ShadeFinderPreview() {
  return (
    <div className="sf-prev" aria-hidden="true">
      <div className="sf-prev-board">
        <div className="sf-prev-grid">
          {Array.from({ length: CELLS }).map((_, i) => (
            <span
              key={i}
              className={
                i === ODD_ROUND_1 ? 'sf-prev-cell sf-prev-odd1'
                  : i === ODD_ROUND_2 ? 'sf-prev-cell sf-prev-odd2'
                    : 'sf-prev-cell'
              }
            />
          ))}
        </div>
      </div>
    </div>
  );
}
