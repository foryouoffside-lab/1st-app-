// lib/drillMeta.js
// SkillDrills — how long a solo run of each drill actually takes, so the UI can
// stop promising "45s" for every drill when only one of them is fixed-length.
//
// There are three shapes in the catalogue, and this table is the ONE place
// that records which drill is which. Getting it wrong is not cosmetic: it is
// what the home card, the daily session card and the drill rail print BEFORE
// the player taps in, so a wrong entry is the app promising one game and
// then playing a different one.
//
//   endurance — the shared EARN-TIME clock (see lib/drillRules.js). Opens
//     with banked seconds, correct actions buy more, mistakes cost time, and a
//     decaying payout guarantees the run ends eventually. A strong player
//     holds it for minutes, a weak one is out in well under one, so there is
//     no honest single number: the UI shows the MODE, never a duration.
//   sprint — a PLAIN fixed countdown that nothing refills. Skill cannot
//     extend it, so the number is exact and worth printing.
//   lives — no clock at all in solo; a miss limit is the entire fail state,
//     so the card advertises THAT instead of a duration. What ends the run is
//     more useful to a player than what doesn't.
//
// HOW TO CHECK AN ENTRY (do this, don't assume): open the drill's client and
// look for applyHit/applyMistake from lib/drillRules. Present = endurance.
// Absent = the drill opted out and runs its own clock, and the header comment
// at the top of that file says which. This table previously listed ONLY
// shade-finder as a sprint, so five of the ten drills were being advertised as
// open-ended "Endurance" when they are in fact hard countdowns — a 45-second
// drill sold as a marathon, and an untimed one sold the same way.
//
// An Arena duel is separate again: a fixed shared 45-second deadline for both
// players, which is DUEL_SECONDS below and is not affected by any of this.

// Drill id -> pacing. Anything not listed runs the shared endurance clock.
// Verified against each drill's client on 2026-09-11 (see method above).
const PACING = {
  // Hard countdowns — nothing in the drill adds time back.
  'shade-finder':        { mode: 'sprint', seconds: 45 },   // SPRINT note in ShadeFinderClient
  'concentration-grid':  { mode: 'sprint', seconds: 45 },   // opts out of earn-time + MISS_LIMIT 3
  'distraction-fighter': { mode: 'sprint', seconds: 45 },   // opts out of earn-time + MISS_LIMIT 3
  'card-matching':       { mode: 'sprint', seconds: 60 },   // plain countdown, nothing refills it
  'tower-of-hanoi':      { mode: 'sprint', seconds: 120 },  // plain countdown, nothing refills it

  // No clock at all in solo — the clock is a stopwatch for a pace stat and
  // MISS_LIMIT wrong taps is what ends the run. `lives` MUST track MISS_LIMIT
  // in GridMemorizationClient.js; they are two copies of one number.
  'grid-memorization':   { mode: 'lives', seconds: null, lives: 5 },

  // Not listed, i.e. genuine earn-time endurance:
  //   multi-tasking, moving-target, finger-sequencing, quick-dodge
};

export const DUEL_SECONDS = 45;

/**
 * @param {string} drillId
 * @returns {{ mode: 'endurance'|'sprint', seconds: number|null, label: string, short: string }}
 *   label — for a card's meta line ("Endurance", "45s sprint")
 *   short — the tightest form ("Endurance", "45s")
 */
export function drillPacing(drillId) {
  const p = PACING[drillId];
  if (p && p.mode === 'sprint') {
    // Over a minute reads better as minutes — "120s" makes a 2-minute drill
    // look like a long sprint rather than the deliberate, unhurried puzzle it is.
    const mins = p.seconds / 60;
    const short = p.seconds >= 60 && Number.isInteger(mins) ? `${mins} min` : `${p.seconds}s`;
    return { mode: 'sprint', seconds: p.seconds, label: `${short} sprint`, short };
  }
  if (p && p.mode === 'lives') {
    const label = `${p.lives} lives`;
    return { mode: 'lives', seconds: null, lives: p.lives, label, short: label };
  }
  return { mode: 'endurance', seconds: null, label: 'Endurance', short: 'Endurance' };
}

/**
 * A short, HONEST time hint for a daily-session drill card. Returns null for
 * endurance drills rather than inventing a number — the caller shows the skill
 * area or the XP multiplier instead.
 */
export function drillTimeHint(drillId) {
  const p = drillPacing(drillId);
  // 'lives' returns its label too: "5 lives" is a true, useful thing to say
  // about a drill, and the alternative (null) made the caller fall back to a
  // generic duration guess — exactly the fake number this file exists to stop.
  return p.mode === 'endurance' ? null : p.short;
}

// Removed as dead code: sessionHasFixedLength() / estimateSessionMinutes(), the
// pair that summed a set into "~N min", and KNOWN_PACING_IDS.
//
// The estimator answered null for every real set anyway — it required EVERY
// drill to be a fixed-length sprint, and today's catalogue has exactly one — so
// each caller already showed "3 drills" instead and none of them ever called it.
// KNOWN_PACING_IDS was meant to catch a PACING entry outliving its drill, but
// nothing ever read the array, so it was a guard that could not fire while still
// walking PACING x DRILL_INDEX on every module load.
//
// If that stale-entry guard is wanted again, it belongs in a test that asserts
// on it, not in a module-scope const the app pays for and never inspects.
