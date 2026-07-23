// The player journey is deliberately small and local-first. It gives a new
// player a clear first choice and turns saved drill results into a daily mission.

const FOCUS_KEY = 'sd_training_focus';

export const TRAINING_FOCUSES = [
  {
    id: 'memory',
    label: 'Memory & Recall',
    description: 'Working memory, spatial patterns, and sequence recall.',
    drills: [
      { id: 'memory-sequence', name: 'Memory Sequence', path: '/drills/cognitive/memory/memory-sequence' },
      { id: 'grid-memorization', name: 'Grid Memorization', path: '/drills/cognitive/memory/grid-memorization' },
      { id: 'card-matching', name: 'Card Matching', path: '/drills/cognitive/memory/card-matching' }
    ],
  },
  {
    id: 'speed',
    label: 'Processing Speed',
    description: 'Reaction times, visual decisions, and response speed.',
    drills: [
      { id: 'reaction-time-test', name: 'Reaction Time Test', path: '/drills/cognitive/processing-speed/reaction-time-test' },
      { id: 'symbol-matching', name: 'Symbol Matching', path: '/drills/cognitive/processing-speed/symbol-matching' },
      { id: 'light-reaction', name: 'Light Reaction', path: '/drills/cognitive/processing-speed/light-reaction' }
    ],
  },
  {
    id: 'focus',
    label: 'Attention & Focus',
    description: 'Concentration grid, distraction management, and dual tasking.',
    drills: [
      { id: 'concentration-grid', name: 'Concentration Grid', path: '/drills/cognitive/focus/concentration-grid' },
      { id: 'distraction-fighter', name: 'Distraction Fighter', path: '/drills/cognitive/focus/distraction-fighter' },
      { id: 'divided-attention', name: 'Divided Attention', path: '/drills/cognitive/attention/divided-attention' }
    ],
  },
];

function localDay(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function getTrainingFocus() {
  if (typeof window === 'undefined') return null;
  try {
    const id = localStorage.getItem(FOCUS_KEY);
    return TRAINING_FOCUSES.find(focus => focus.id === id) || null;
  } catch {
    return null;
  }
}

export function setTrainingFocus(id) {
  const focus = TRAINING_FOCUSES.find(item => item.id === id);
  if (!focus || typeof window === 'undefined') return null;
  try {
    localStorage.setItem(FOCUS_KEY, focus.id);
  } catch {
    return null;
  }
  return focus;
}

export function getDailyMission(progress = {}, focus = getTrainingFocus()) {
  const selectedFocus = focus || TRAINING_FOCUSES[0];
  const today = localDay();
  const drills = selectedFocus.drills.map(drill => {
    const lastPlayed = progress[drill.id]?.lastPlayed;
    return {
      ...drill,
      // lastPlayed is stored as a UTC ISO timestamp — compare local calendar
      // days, not a naive string slice, so this doesn't drift near midnight.
      complete: !!lastPlayed && localDay(new Date(lastPlayed)) === today,
    };
  });

  return {
    focus: selectedFocus,
    drills,
    completeCount: drills.filter(drill => drill.complete).length,
    total: drills.length,
  };
}
