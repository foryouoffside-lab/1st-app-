'use client';

// Card Matching — animated card preview.
// A 2×2 board of the drill's own cards, on a loop:
//   1. all face-down (the drill's violet gradient backs with the centre emblem)
//   2. the top pair flips up to matching stars → they pulse cyan and vanish
//   3. the bottom pair flips up — a heart and a circle → no match, they flip back
// Same card faces, colours (lucide Star/Heart/Circle at the drill's tints) and
// 3D flip the drill uses. Motion is CSS transforms (see `.cm-prev*` in
// globals.css); reduced-motion parks it on the all-face-down frame.

import { Star, Heart, Circle } from 'lucide-react';

export default function CardMatchingPreview() {
  return (
    <div className="cm-prev" aria-hidden="true">
      <div className="cm-prev-board">
        <Card cls="cm-prev-a"><Star /></Card>
        <Card cls="cm-prev-a"><Star /></Card>
        <Card cls="cm-prev-c"><Heart /></Card>
        <Card cls="cm-prev-c cm-prev-c2"><Circle /></Card>
      </div>
    </div>
  );
}

function Card({ cls, children }) {
  return (
    <div className={`cm-prev-card ${cls}`}>
      <div className="cm-prev-inner">
        <div className="cm-prev-face cm-prev-back" />
        <div className="cm-prev-face cm-prev-front">{children}</div>
      </div>
    </div>
  );
}
