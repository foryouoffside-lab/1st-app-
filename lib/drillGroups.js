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
