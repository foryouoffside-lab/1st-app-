// lib/leaderboard.js
// SkillDrills Pro — Compatibility shim
// All drill components that import from this file will still work.
// Actual storage now goes through progressStore.js

import { Trophy, Zap, Star, Dumbbell, ThumbsUp, TrendingUp, Target } from 'lucide-react';

export { getPlayerName } from './progressStore';

// These are kept for backward compatibility with existing drill components
// that call saveLeaderboardEntry at the end of a game session.

export const RANK_TIERS = [
  { id: 'legendary', name: 'Legendary', minScore: 95,  icon: Trophy,     color: 'text-yellow-400',  bg: 'bg-yellow-500/20', border: 'border-yellow-500/30' },
  { id: 'elite',     name: 'Elite',     minScore: 85,  icon: Zap,        color: 'text-cyan-400',    bg: 'bg-cyan-500/20',   border: 'border-cyan-500/30'   },
  { id: 'excellent', name: 'Excellent', minScore: 75,  icon: Star,       color: 'text-blue-400',    bg: 'bg-blue-500/20',   border: 'border-blue-500/30'   },
  { id: 'great',     name: 'Great',     minScore: 60,  icon: Dumbbell,   color: 'text-green-400',   bg: 'bg-green-500/20',  border: 'border-green-500/30'  },
  { id: 'good',      name: 'Good',      minScore: 45,  icon: ThumbsUp,   color: 'text-indigo-400',  bg: 'bg-indigo-500/20', border: 'border-indigo-500/30' },
  { id: 'keep-going',name: 'Keep Going',minScore: 30,  icon: TrendingUp, color: 'text-orange-400',  bg: 'bg-orange-500/20', border: 'border-orange-500/30' },
  { id: 'practice',  name: 'Practice',  minScore: 0,   icon: Target,     color: 'text-red-400',     bg: 'bg-red-500/20',    border: 'border-red-500/30'    },
];

export function getRankTier(scorePercentage) {
  return RANK_TIERS.find(t => scorePercentage >= t.minScore) || RANK_TIERS[RANK_TIERS.length - 1];
}

/**
 * Save a score entry. Delegates to progressStore for actual persistence.
 * Kept for backward compat with existing drill components.
 */
export async function saveLeaderboardEntry(entry) {
  try {
    const { saveDrillResult } = await import('./progressStore');
    await saveDrillResult({
      drillId:   entry.drillId || entry.drill || 'unknown',
      drillName: entry.drillName || 'Drill',
      category:  entry.category || 'cognitive',
      finalScore: entry.score || 0,
      accuracy:   entry.accuracy || 0,
      bestCombo:  entry.bestCombo || 0,
      isDailyChallenge: false,
    });
  } catch {}
  return entry;
}

/** Sync version used by components that can't await. */
export function saveLeaderboardEntrySync(entry) {
  // Fire-and-forget
  saveLeaderboardEntry(entry).catch(() => {});
  return entry;
}

