'use client';

// Distraction Fighter — animated card preview.
// The drill's own Stroop board, two trials on a loop:
//   1. "RED" printed in cyan ink over the drill's 2x2 answer grid
//   2. the CYAN button presses in — the ink, not the word
//   3. the next trial replaces it: "BLUE" printed in yellow, a fresh shuffle
//      with the answer in a different corner, and YELLOW presses in
//
// The board is the drill's, not a redesign of it: the word is the big black
// uppercase wide-tracked type it ships (same drop shadow, same slow pulse) in
// one of the drill's eight STROOP_COLORS, and the options are its real
// buttons — slate-900, a white/15 hairline, a big radius and the colour NAME
// in plain white. No coloured swatches and no tick: the drill has neither, and
// a correct answer there is confirmed by the press and the next word, not by a
// flash (see .fx-flash-cyan in globals.css, which is deliberately blank).
// Both trials keep the drill's rule that the word's own colour name is always
// among the options — the trap you have to inhibit.
//
// One trial layer is visible at a time (hard opacity steps, no cross-fade), so
// reduced motion parks on a complete, readable board rather than a blend.
// Everything is transform/opacity/background-color only — see `.df-prev*` in
// styles/globals.css.

// name, ink hex and the four options come straight from the drill's
// STROOP_COLORS; `pick` is the option that is the ink colour — the answer.
const TRIALS = [
  { cls: 'df-prev-t1', word: 'RED',  opts: ['Red', 'Cyan', 'Yellow', 'Blue'], pick: 1 },
  { cls: 'df-prev-t2', word: 'BLUE', opts: ['Yellow', 'Blue', 'Green', 'Pink'], pick: 0 },
];

export default function DistractionFighterPreview() {
  return (
    <div className="df-prev" aria-hidden="true">
      <div className="df-prev-board">
        {TRIALS.map(t => (
          <div key={t.cls} className={`df-prev-trial ${t.cls}`}>
            <span className="df-prev-word">{t.word}</span>
            <span className="df-prev-opts">
              {t.opts.map((name, i) => (
                <span
                  key={name}
                  className={i === t.pick ? 'df-prev-opt df-prev-pick' : 'df-prev-opt'}
                >
                  {name}
                </span>
              ))}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
