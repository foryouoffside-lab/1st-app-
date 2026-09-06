// lib/drillGroups.js
// SkillDrills Pro — shared subcategory metadata for Cognitive drills.
// Single source of truth for group ids/names/icons/accents, used by the
// home page category tiles, the Cognitive hub's filter bar, and the
// Progress page's radar chart.

import { Brain, Target, Eye, Puzzle, Zap } from 'lucide-react';

export const SUB_GROUPS = [
  { id: 'all', name: 'All Drills' },
  { id: 'attention', name: 'Attention' },
  { id: 'focus', name: 'Focus' },
  { id: 'memory', name: 'Memory' },
  { id: 'problem-solving', name: 'Problem Solving' },
  { id: 'processing-speed', name: 'Processing Speed' },
];

// Real, browsable top-level categories on the home page (excludes 'all').
export const DRILL_GROUPS = [
  {
    id: 'attention',
    name: 'Attention',
    emoji: '🧠',
    icon: Eye,
    accent: 'var(--c-cognitive)',
    description: 'Filter noise, track multiple targets, hold focus under load.',
  },
  {
    id: 'focus',
    name: 'Focus',
    emoji: '🔷',
    icon: Target,
    accent: 'var(--c-visual)',
    description: 'Concentration, distraction resistance, sustained tracking.',
  },
  {
    id: 'memory',
    name: 'Memory',
    emoji: '🔢',
    icon: Brain,
    accent: 'var(--c-memory)',
    description: 'Recall sequences, spatial layouts, and matched pairs.',
  },
  {
    id: 'problem-solving',
    name: 'Problem Solving',
    emoji: '🧩',
    icon: Puzzle,
    accent: 'var(--c-academic)',
    description: 'Logic, planning, and multi-step reasoning drills.',
  },
  {
    id: 'processing-speed',
    name: 'Processing Speed',
    emoji: '⚡',
    icon: Zap,
    accent: 'var(--c-reaction)',
    description: 'Reaction time, quick decisions, motor response speed.',
  },
];

export function getGroupMeta(id) {
  return DRILL_GROUPS.find(g => g.id === id) || DRILL_GROUPS[0];
}

// Derives a drill's subcategory from its path, e.g.
// /drills/cognitive/attention/multi-tasking -> 'attention'
export function getDrillGroup(drill) {
  const parts = drill.path.split('/');
  return parts[3] || 'attention';
}

// Where the Cognitive hub remembers which category to show on a return visit.
// Shared so DrillWrapper (which writes it) and the hub (which reads it) can
// never drift onto different keys.
export const HUB_GROUP_KEY = 'skilldrills_cognitive_group';

// The subcategory a raw pathname belongs to — i.e. the category of the drill
// you are actually IN — or null if the path isn't a cognitive drill.
//
// Distinct from getDrillGroup() above, which takes a DRILL_INDEX entry and
// falls back to 'attention' for anything it can't parse. That fallback is
// wrong for this job: silently answering "attention" for an unrecognised path
// is exactly how exiting Sudoku landed the user in Attention. Here an
// unrecognised path returns null and the caller leaves the stored value alone.
export function groupFromPath(pathname) {
  const parts = (pathname || '').split('/');
  if (parts[1] !== 'drills' || parts[2] !== 'cognitive') return null;
  const group = parts[3];
  return SUB_GROUPS.some(g => g.id === group && g.id !== 'all') ? group : null;
}

export function getGroupIcon(group) {
  switch (group) {
    case 'attention': return Eye;
    case 'focus': return Target;
    case 'memory': return Brain;
    case 'problem-solving': return Puzzle;
    case 'processing-speed': return Zap;
    default: return Brain;
  }
}
