'use client';

// Moving Target — animated card preview.
// The drill's own red glowing orb, flying a looping path across the field and
// flashing white once per lap (a hit). No reticle, no HUD — just the target and
// its movement, matching what the drill actually looks like.
//
// Motion is `transform: translate()` on a full-field track layer (see
// `.mt-prev*` in styles/globals.css) so the % offsets resolve against the field
// and it stays on the compositor. Reduced-motion parks it mid-path.

export default function MovingTargetPreview() {
  return (
    <div className="mt-prev" aria-hidden="true">
      <div className="mt-prev-field">
        <div className="mt-prev-track">
          <span className="mt-prev-orb" />
        </div>
      </div>
    </div>
  );
}
