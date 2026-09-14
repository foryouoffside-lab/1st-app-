// lib/leaderboard.js
// SkillDrills Pro — Compatibility shim
// All drill components that import from this file will still work.
// Actual storage now goes through progressStore.js

export { getPlayerName } from './progressStore';

// These are kept for backward compatibility with existing drill components
// that call saveLeaderboardEntry at the end of a game session.
//
// The old RANK_TIERS grade curve and its getRankTier() lookup used to live here
// too, each tier carrying a lucide icon. Both are gone: grading moved to
// getGrade() in scoringEngine.js and the badge ladder to levelBadge.js, and
// nothing had referenced either symbol since (see the note at the top of
// achievements.js). Dropping them also drops this module's only lucide-react
// import, so a file every drill pulls in no longer reaches for an icon set.

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

