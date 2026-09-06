'use client';

// Quick Dodge — animated card preview.
// The drill's own opening board: three hollow red hazards drifting across the
// field on straight headings while the emerald player dot weaves between them.
// Every pass is a near miss — nothing is ever hit, because dodging is the whole
// mechanic and a hit is the fail state.
//
// Everything here is lifted from the drill rather than invented (see `.qd-ob*`
// and `.qd-player*` in globals.css, and ensurePlayerSize in QuickDodgeClient):
// the hazard is a hollow circle whose border sits on the collision radius, with
// a bright core and a ring rising out of it; the player is the green gradient
// dot with its white sheen, its breathing halo and its expanding pulse ring.
// The halo, both pulse rings and the ring period are the drill's own keyframes
// (qdHalo / qdPlayerRing / qdRing), reused as-is.
//
// Deliberately absent: the motion trails and the brighter `qd-glow` tint. The
// drill only switches those on from ~40% and ~65% through its level table, and
// this is a sparse opening board — so is the stick, which is only drawn while a
// thumb is down.
//
// Motion is transform-only on full-field track layers (`.qd-prev-h1/2/3`,
// `.qd-prev-dot` in globals.css) so the % offsets resolve against the field and
// the whole thing stays on the compositor. Reduced motion parks it on the 0%
// frame: three hazards spread across the board and the dot between them.

export default function QuickDodgePreview() {
  return (
    <div className="qd-prev" aria-hidden="true">
      <div className="qd-prev-field">
        <Hazard cls="qd-prev-h1" />
        <Hazard cls="qd-prev-h2" />
        <Hazard cls="qd-prev-h3" />
        <div className="qd-prev-dot">
          <span className="qd-prev-player">
            <i className="qd-prev-halo" />
            <i className="qd-prev-pulse" />
            <i className="qd-prev-body"><i className="qd-prev-sheen" /></i>
          </span>
        </div>
      </div>
    </div>
  );
}

function Hazard({ cls }) {
  return (
    <div className={`qd-prev-haz ${cls}`}>
      <span className="qd-prev-ob">
        <i className="qd-prev-ob-body">
          <i className="qd-prev-ob-core" />
          <i className="qd-prev-ob-ring" />
        </i>
      </span>
    </div>
  );
}
