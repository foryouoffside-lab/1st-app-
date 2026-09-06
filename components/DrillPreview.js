'use client';

// Animated drill previews — a hand-built, pure-CSS loop that shows the drill's
// actual mechanic in the card's thumbnail slot, in place of the static image.
//
// Why CSS and not a canvas/rAF mini-demo: the home rail and the hub grid can
// show a dozen of these at once on a scrolling list. A keyframe animation on
// transform/opacity/box-shadow runs on the compositor and costs no main-thread
// time; the blanket `prefers-reduced-motion` rule in globals.css collapses every
// duration to ~0, which parks each preview on its first keyframe (a clean,
// legible still). Any drill not listed here keeps its static webp.

import GridMemorizationPreview from './drill-previews/GridMemorizationPreview';
import MovingTargetPreview from './drill-previews/MovingTargetPreview';
import CardMatchingPreview from './drill-previews/CardMatchingPreview';
import QuickDodgePreview from './drill-previews/QuickDodgePreview';
import DistractionFighterPreview from './drill-previews/DistractionFighterPreview';
import MultiTaskingPreview from './drill-previews/MultiTaskingPreview';
import ShadeFinderPreview from './drill-previews/ShadeFinderPreview';
import TowerOfHanoiPreview from './drill-previews/TowerOfHanoiPreview';

const ANIMATED = {
  'grid-memorization': GridMemorizationPreview,
  'moving-target': MovingTargetPreview,
  'card-matching': CardMatchingPreview,
  'quick-dodge': QuickDodgePreview,
  'distraction-fighter': DistractionFighterPreview,
  'multi-tasking': MultiTaskingPreview,
  'shade-finder': ShadeFinderPreview,
  'tower-of-hanoi': TowerOfHanoiPreview,
};

export function hasAnimatedPreview(id) {
  return Object.prototype.hasOwnProperty.call(ANIMATED, id);
}

export default function DrillPreview({ drillId }) {
  const Anim = ANIMATED[drillId];
  if (!Anim) return null;
  return <Anim />;
}
