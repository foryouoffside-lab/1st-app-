'use client';

// Multi-Tasking (Dual Target Flow) — animated card preview.
// The drill's own board: two lanes either side of the violet seam, glyphs
// streaming outward from it, and one target in each lane getting tapped:
//   • left lane hunts ★, right lane hunts ● — the drill's two-target rule
//   • a tapped target flashes blue-400 with its glow, scales up and is gone
//   • everything else just flies out past the edge and expires
//
// Straight from the drill (DualTargetFlowClient): the glyphs are its own
// SHAPES set drawn the way mountShape draws them (sans-serif, #d1d5db,
// centred on their point), the lanes run its exact spawn-to-exit path — left
// 50%→-8%, right 42%→108% of the field, linear — and the hit is its 150ms
// #60a5fa + `0 0 20px` glow + scale(1.2) before the shape is removed. The seam
// is the drill's own violet hairline.
//
// No HUD: the drill shows a LEFT/RIGHT TARGET readout up top, but that is
// chrome, and the pair being hunted reads from which glyphs get tapped.
//
// Motion is transform/opacity/colour on full-field track layers (`.dt-prev*`
// in styles/globals.css), so the % offsets resolve against the field and it
// stays on the compositor. Each flight is phased across the loop, so the
// reduced-motion still parks on a board with glyphs in both lanes.

// One flight per glyph: `l`/`r` is the lane and the number is its slot in the
// 6s loop, an eighth apart, alternating lanes the way the drill's single spawn
// timer does. `hit` marks the two the drill's rule is about — the target each
// lane is hunting. Non-targets are never the lane's own target, as in the drill.
const FLIGHTS = [
  { cls: 'dt-prev-l1', glyph: '▲' },
  { cls: 'dt-prev-r1', glyph: '◆' },
  { cls: 'dt-prev-l2', glyph: '★', hit: true },
  { cls: 'dt-prev-r2', glyph: '●', hit: true },
  { cls: 'dt-prev-l3', glyph: '■' },
  { cls: 'dt-prev-r3', glyph: '▲' },
  { cls: 'dt-prev-l4', glyph: '◆' },
  { cls: 'dt-prev-r4', glyph: '■' },
];

export default function MultiTaskingPreview() {
  return (
    <div className="dt-prev" aria-hidden="true">
      <span className="dt-prev-seam" />
      {FLIGHTS.map(f => (
        <span key={f.cls} className={`dt-prev-fly ${f.cls}`}>
          <i className={f.hit ? 'dt-prev-g dt-prev-hit' : 'dt-prev-g'}>{f.glyph}</i>
        </span>
      ))}
    </div>
  );
}
