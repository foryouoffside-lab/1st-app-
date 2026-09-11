// lib/weeklyGoal.js
// SkillDrills — the weekly progression loop.
//
// ONE loop, deliberately small: finish the daily session on five different
// days in a calendar week and you earn that week's named profile badge. That
// is the whole thing. No currency, no shop, no pass — those were explicitly
// out of scope, and the daily session has to be the reason to come back, not
// a metagame layered on top of it.
//
// Design rules this file keeps:
//   • NOT punitive. Missing a day never resets or subtracts anything. The
//     only number that can go down is "sessions so far THIS week", and only
//     because a new week started — last week's result is already banked.
//   • Progress and the reward are both visible before it is earned (the
//     Daily page renders getWeeklyGoal() whether or not allDone is true).
//   • Local week boundaries, matching lib/dailyChallenge.js's local todayStr
//     (never UTC) — a player's week rolls over on THEIR Monday.
//   • Additive storage only (sd_weekly). Nothing here reads or migrates an
//     existing key, so old accounts just start at week 0 of 5.
//
// This module intentionally imports nothing from progressStore: saveDrillResult
// there calls recordWeeklySession() and fires its own celebration with the
// result, which keeps the dependency one-way (progressStore -> weeklyGoal ->
// storage) and cycle-free.

import { Storage } from './storage';
import { todayStr } from './dailyChallenge';

const WEEKLY_KEY = 'sd_weekly';
// { week, sessionDays: ['YYYY-MM-DD'], weeksCompleted: N, badges: [id] }
// (Older data may also carry a `focus` field from the since-removed training-
// focus picker; it is simply ignored now.)

export const WEEKLY_TARGET = 5;

// A small named collection, unlocked by cumulative completed weeks. Cosmetic
// only — it shows as a badge on the Progress profile and nowhere else. The
// jumps (1, 2, 4, 8, 13) mean the next one is always a visible reach without
// ever being a grind; 13 is a full quarter of weeks.
export const WEEKLY_BADGES = [
  { id: 'wk-1',  weeks: 1,  name: 'First Five',   blurb: 'Completed a full week of daily sessions' },
  { id: 'wk-2',  weeks: 2,  name: 'Back to Back', blurb: 'Two weeks running' },
  { id: 'wk-4',  weeks: 4,  name: 'Locked In',    blurb: 'A month of weeks' },
  { id: 'wk-8',  weeks: 8,  name: 'Relentless',   blurb: 'Eight weeks' },
  { id: 'wk-13', weeks: 13, name: 'Ironclad',     blurb: 'A full quarter' },
];

/**
 * The local week id: the date string of that week's Monday. Local time, built
 * on the same todayStr() the daily set and the streak use, so every "what
 * period is it" answer in the app rolls over together.
 */
export function weekStr(input = new Date()) {
  const d = new Date(input.getFullYear(), input.getMonth(), input.getDate());
  const mondayOffset = (d.getDay() + 6) % 7; // Sun=6 … Mon=0
  d.setDate(d.getDate() - mondayOffset);
  return todayStr(d);
}

/** The 7 local date strings of the given week, Monday first. */
export function weekDays(weekId) {
  const [y, m, dd] = weekId.split('-').map(Number);
  const monday = new Date(y, m - 1, dd);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return todayStr(d);
  });
}

async function loadState() {
  const today = weekStr();
  const stored = await Storage.getJSON(WEEKLY_KEY, null);
  const base = { week: today, sessionDays: [], weeksCompleted: 0, badges: [] };
  if (!stored || typeof stored !== 'object') return base;

  const weeksCompleted = Number.isFinite(stored.weeksCompleted) ? stored.weeksCompleted : 0;
  const badges = Array.isArray(stored.badges) ? stored.badges : [];

  // New week: roll the per-week counter, KEEP everything cumulative.
  if (stored.week !== today) {
    return { week: today, sessionDays: [], weeksCompleted, badges };
  }
  return {
    week: today,
    sessionDays: Array.isArray(stored.sessionDays) ? stored.sessionDays : [],
    weeksCompleted,
    badges,
  };
}

function badgesForWeeks(n) {
  return WEEKLY_BADGES.filter((b) => b.weeks <= n).map((b) => b.id);
}

/** The next badge a player is working toward, or null once all are earned. */
export function nextWeeklyBadge(weeksCompleted) {
  return WEEKLY_BADGES.find((b) => b.weeks > weeksCompleted) || null;
}

/**
 * The weekly goal card's data. Safe to call anytime; never mutates.
 * @returns {Promise<{
 *   week: string, target: number, completed: number, remaining: number,
 *   days: Array<{ date: string, done: boolean, isToday: boolean }>,
 *   allDone: boolean,
 *   weeksCompleted: number, earnedBadges: Array, nextBadge: Object|null,
 * }>}
 */
export async function getWeeklyGoal() {
  const s = await loadState();
  const today = todayStr();
  const days = weekDays(s.week).map((date) => ({
    date,
    done: s.sessionDays.includes(date),
    isToday: date === today,
  }));
  const completed = s.sessionDays.length;
  const earnedIds = new Set(s.badges.length ? s.badges : badgesForWeeks(s.weeksCompleted));
  return {
    week: s.week,
    target: WEEKLY_TARGET,
    completed,
    remaining: Math.max(0, WEEKLY_TARGET - completed),
    days,
    allDone: completed >= WEEKLY_TARGET,
    weeksCompleted: s.weeksCompleted,
    earnedBadges: WEEKLY_BADGES.filter((b) => earnedIds.has(b.id)),
    nextBadge: nextWeeklyBadge(s.weeksCompleted),
  };
}

/**
 * Record that today's daily session was completed. Idempotent per local day —
 * finishing the set, reloading, or re-completing a slot all land on the same
 * single entry, so a week can never count past 7 or double-award a badge.
 *
 * Called once, from progressStore.saveDrillResult, at the moment the third
 * daily drill is banked (dailyChallengeSetComplete).
 *
 * @returns {Promise<{
 *   alreadyCounted: boolean, completed: number, target: number,
 *   weekJustCompleted: boolean, newBadge: Object|null,
 * }>}
 */
export async function recordWeeklySession() {
  const s = await loadState();
  const today = todayStr();

  if (s.sessionDays.includes(today)) {
    return { alreadyCounted: true, completed: s.sessionDays.length, target: WEEKLY_TARGET, weekJustCompleted: false, newBadge: null };
  }

  s.sessionDays = [...s.sessionDays, today];
  const completed = s.sessionDays.length;

  let weekJustCompleted = false;
  let newBadge = null;

  // completed can only equal the target on the FIFTH distinct day of the week
  // (a sixth/seventh day makes it 6/7, never 5 again), and the includes()
  // guard above means this day is new — so this branch fires exactly once per
  // completed week, which is what makes the badge award safe without a
  // separate "already banked" flag.
  if (completed === WEEKLY_TARGET) {
    s.weeksCompleted += 1;
    weekJustCompleted = true;
    const earnedNow = badgesForWeeks(s.weeksCompleted);
    const gained = earnedNow.filter((id) => !s.badges.includes(id));
    s.badges = earnedNow;
    if (gained.length) {
      newBadge = WEEKLY_BADGES.find((b) => b.id === gained[gained.length - 1]) || null;
    }
  }

  await Storage.setJSON(WEEKLY_KEY, s);
  return { alreadyCounted: false, completed, target: WEEKLY_TARGET, weekJustCompleted, newBadge };
}
