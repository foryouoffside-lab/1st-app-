'use client';

// Tower of Hanoi — animated card preview.
// The drill's opening board — three pegs, three disks — solving itself:
// the seven-move optimal sequence, one legal move at a time (lift, across,
// drop), never a larger disk onto a smaller one. The stack lands complete on
// peg 3, which is the drill's clear condition, and the board reloads.
//
// Pieces are the drill's. Disks are its first three DISK_SKINS in order —
// violet, indigo, blue from the top down — built the way its Disk component
// builds them: flat fill, a lighter rim of the same hue, a coloured glow, and
// no gradient or gloss. Widths follow getDiskWidth (36px to 132px across the
// stack), the pegs are its rounded-top #3a3a46→#1c1c24 posts and the bases its
// darker capsules with the white/10 hairline.
//
// Two things are left out. The peg labels and the moves/par counter are chrome.
// And the drill re-renders a moved disk straight onto its new peg, where the
// preview carries it across: at a glance, on a thumbnail, an instant jump reads
// as a glitch rather than a move. The reload is a fresh 3-disk board rather
// than the drill's next level up, so the loop is one tower rather than a run.
//
// Transform and opacity only — see `.th-prev*` in styles/globals.css. Each disk
// rides a full-board track so its offsets resolve against the board.

export default function TowerOfHanoiPreview() {
  return (
    <div className="th-prev" aria-hidden="true">
      <div className="th-prev-board">
        <span className="th-prev-peg th-prev-p1" />
        <span className="th-prev-peg th-prev-p2" />
        <span className="th-prev-peg th-prev-p3" />
        <span className="th-prev-base th-prev-p1" />
        <span className="th-prev-base th-prev-p2" />
        <span className="th-prev-base th-prev-p3" />
        <span className="th-prev-track th-prev-t1"><i className="th-prev-disk th-prev-d1" /></span>
        <span className="th-prev-track th-prev-t2"><i className="th-prev-disk th-prev-d2" /></span>
        <span className="th-prev-track th-prev-t3"><i className="th-prev-disk th-prev-d3" /></span>
      </div>
    </div>
  );
}
