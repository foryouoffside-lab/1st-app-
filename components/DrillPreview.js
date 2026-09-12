'use client';

// Animated drill previews — a hand-built, pure-CSS loop that shows the drill's
// actual mechanic in the card's thumbnail slot, in place of the static image.
//
// Why CSS and not a canvas/rAF mini-demo: the home rail and the hub grid can
// show a dozen of these at once on a scrolling list. A keyframe animation on
// transform/opacity can run on the compositor; shadow animations still paint.
// Offscreen previews are paused to avoid spending work on invisible cards; the blanket `prefers-reduced-motion` rule in globals.css collapses every
// duration to ~0, which parks each preview on its first keyframe (a clean,
// legible still). Any drill not listed here keeps its static webp.

import { useEffect, useRef } from 'react';

import GridMemorizationPreview from './drill-previews/GridMemorizationPreview';
import MovingTargetPreview from './drill-previews/MovingTargetPreview';
import CardMatchingPreview from './drill-previews/CardMatchingPreview';
import QuickDodgePreview from './drill-previews/QuickDodgePreview';
import DistractionFighterPreview from './drill-previews/DistractionFighterPreview';
import MultiTaskingPreview from './drill-previews/MultiTaskingPreview';
import ShadeFinderPreview from './drill-previews/ShadeFinderPreview';
import TowerOfHanoiPreview from './drill-previews/TowerOfHanoiPreview';
import ConcentrationGridPreview from './drill-previews/ConcentrationGridPreview';
import FingerSequencingPreview from './drill-previews/FingerSequencingPreview';

const ANIMATED = {
  'grid-memorization': GridMemorizationPreview,
  'moving-target': MovingTargetPreview,
  'card-matching': CardMatchingPreview,
  'quick-dodge': QuickDodgePreview,
  'distraction-fighter': DistractionFighterPreview,
  'multi-tasking': MultiTaskingPreview,
  'shade-finder': ShadeFinderPreview,
  'tower-of-hanoi': TowerOfHanoiPreview,
  'concentration-grid': ConcentrationGridPreview,
  'finger-sequencing': FingerSequencingPreview,
};

export function hasAnimatedPreview(id) {
  return Object.prototype.hasOwnProperty.call(ANIMATED, id);
}

export default function DrillPreview({ drillId }) {
  const rootRef = useRef(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let visible = false;
    const sync = () => {
      root.dataset.paused = String(!visible || document.visibilityState !== 'visible');
    };
    const observer = typeof IntersectionObserver === 'function'
      ? new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; sync(); })
      : null;
    if (observer) observer.observe(root);
    else visible = true;
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => {
      observer?.disconnect();
      document.removeEventListener('visibilitychange', sync);
    };
  }, [drillId]);
  const Anim = ANIMATED[drillId];
  if (!Anim) return null;
  return <div ref={rootRef} className="drill-preview-viewport absolute inset-0" data-paused="true"><Anim /></div>;
}
