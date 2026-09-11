// lib/achievements.js
// SkillDrills — achievements with REAL, visible requirements and progress
// toward the next one.
//
// The old "achievements" strip on the Progress page reused lib/leaderboard.js's
// RANK_TIERS (a grade curve) and lit a badge up when best_score / 10 crossed
// its percent threshold — a number that meant nothing, with no requirement
// shown and no sense of what came next. This replaces it with a short ladder
// of things a player can actually see themselves progressing toward.
//
// Every rule reads off numbers the app already tracks (session count, longest
// streak, unique drills played, weekly badges). Cosmetic only — a badge on
// the profile, nothing that changes gameplay or scoring.

import { Award, Flame, Layers, Target, CalendarCheck } from 'lucide-react';

/**
 * @typedef {Object} AchievementDef
 * @property {string} id
 * @property {string} name
 * @property {string} requirement  human-readable, e.g. "Play 25 sessions"
 * @property {number} target
 * @property {(stats: Object) => number} progress  current value, 0..target+
 * @property {*} icon
 */

/** @type {AchievementDef[]} — kept short on purpose; more can be added once
 * the daily loop has data behind it. `short` is the compact tile label. */
export const ACHIEVEMENTS = [
  {
    id: 'first-run', name: 'Getting Started', requirement: 'Finish your first drill',
    short: 'First drill', target: 1, icon: Target, progress: (s) => s.sessions,
  },
  {
    id: 'all-ten', name: 'Full Sweep', requirement: 'Play all 10 drills at least once',
    short: 'All 10 drills', target: 10, icon: Layers, progress: (s) => s.drillsPlayed,
  },
  {
    id: 'streak-7', name: 'Seven Days', requirement: 'Reach a 7-day streak',
    short: '7-day streak', target: 7, icon: Flame, progress: (s) => s.longestStreak,
  },
  {
    id: 'sessions-25', name: 'Regular', requirement: 'Complete 25 sessions',
    short: '25 sessions', target: 25, icon: CalendarCheck, progress: (s) => s.sessions,
  },
  {
    id: 'weekly-1', name: 'First Five', requirement: 'Finish a full weekly goal',
    short: 'One weekly goal', target: 1, icon: Award, progress: (s) => s.weeksCompleted,
  },
];

/**
 * Resolve every achievement against a stats bag, plus the single "next" one to
 * highlight (the first not-yet-earned, by ladder order).
 *
 * @param {{ sessions:number, drillsPlayed:number, longestStreak:number, weeksCompleted:number }} stats
 */
export function resolveAchievements(stats) {
  const s = {
    sessions: stats.sessions || 0,
    drillsPlayed: stats.drillsPlayed || 0,
    longestStreak: stats.longestStreak || 0,
    weeksCompleted: stats.weeksCompleted || 0,
  };

  const resolved = ACHIEVEMENTS.map((a) => {
    const current = Math.max(0, a.progress(s));
    const earned = current >= a.target;
    return {
      ...a,
      current: Math.min(current, a.target),
      earned,
      pct: Math.min(100, Math.round((current / a.target) * 100)),
    };
  });

  const next = resolved.find((a) => !a.earned) || null;
  const earnedCount = resolved.filter((a) => a.earned).length;

  return { list: resolved, next, earnedCount, total: resolved.length };
}
