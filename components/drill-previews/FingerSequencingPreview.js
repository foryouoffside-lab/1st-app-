'use client';

// Finger Sequencing — animated card preview.
// The drill's own board: a chain of nodes scattered across the field, joined by
// its dashed violet route, tapped one at a time in order. Whichever node is
// live carries the emerald ring and the white "1" — the drill's whole cue, and
// the only number on screen — and once it is taken it pops and is gone, the
// route now starting from the next one. The chain runs out and a fresh one
// spawns.
//
// Everything is the drill's, from its canvas draw pass: upcoming nodes are a
// violet-500 hairline over an almost-transparent fill, the live node is
// emerald-500 at 2px over a 15% emerald fill with the white "1" at 0.85 of its
// radius, and the route is its rgba(168,85,247,.25) dashed polyline drawn from
// the live node onward, so each segment goes when the node it leaves is taken.
//
// Left out: the per-node countdown ring, which is a timer readout, and the trap
// node, which only appears deeper into a run. The consumed node pops and fades
// where the drill throws eight emerald particles — at 13px of node a particle
// burst is a smudge, and the pop reads as the same beat.
//
// Transform, opacity, background-color and border-color only — see `.fs-prev*`
// in styles/globals.css. Node and segment geometry live in a fixed 2:1 board so
// the route holds its shape in both the 4:3 and 16:9 thumb.

const NODES = [1, 2, 3, 4, 5];
const SEGMENTS = [1, 2, 3, 4];

export default function FingerSequencingPreview() {
  return (
    <div className="fs-prev" aria-hidden="true">
      <div className="fs-prev-board">
        {SEGMENTS.map(i => <span key={`s${i}`} className={`fs-prev-seg fs-prev-s${i}`} />)}
        {NODES.map(i => (
          <span key={`n${i}`} className={`fs-prev-node fs-prev-n${i}`}>
            <i className="fs-prev-cue">1</i>
          </span>
        ))}
      </div>
    </div>
  );
}
