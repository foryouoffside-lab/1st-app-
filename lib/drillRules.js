// lib/drillRules.js
// SkillDrills — ONE place that decides how a solo run is won, lost and paced.
//
// Every drill imports these rules instead of hard-coding its own. Change a flag
// here and all 24 drills change together; that is the entire point of the file.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT LIVES HERE vs WHAT STAYS IN THE DRILL
// ─────────────────────────────────────────────────────────────────────────────
// Here:      the RULES — is there a lives system, do mistakes cost time, do hits
//            buy time, do levels have a ceiling — plus the shared curve maths.
// In drill:  its own DIAL VALUES. Selective Attention searches a board and
//            starts at a 1800ms window; Conflict Reflex resolves one arrow and
//            starts at 1100ms. Those aren't the same task, so one global number
//            would be wrong for both. Each drill passes its own start/floor into
//            the shared curve.
//
// The rule is universal, the tuning is local. Flattening the tuning into here
// too would just move 24 sets of magic numbers into one long file.
//
// ─────────────────────────────────────────────────────────────────────────────
// THESE ARE DEVELOPER SWITCHES, NOT A PLAYER-FACING SETTING
// ─────────────────────────────────────────────────────────────────────────────
// Deliberately not wired to a toggle in the app UI. Every one of these flags
// changes how hard a run is, and score is compared across players on a global
// leaderboard and in Arena. A player who switched lives on and the time penalty
// off would post easier, higher scores than everyone else on the same board —
// the leaderboard would stop measuring skill and start measuring settings.
//
// So: flip a flag here, rebuild, ship. Everyone plays the same game.
//
// ─────────────────────────────────────────────────────────────────────────────
// ARENA IS NOT GOVERNED BY THIS FILE
// ─────────────────────────────────────────────────────────────────────────────
// Duels run their own fixed rules — one shared 30s deadline that never refills,
// no lives, no time economy, a ramp capped at DUEL_MAX_LEVEL so both players
// face identical difficulty at identical moments. Drills must keep gating this
// file's behaviour behind `if (!isChallenge)`. A rule that made a duel's clock
// move for one player and not the other would break the score race itself.

// ─────────────────────────────────────────────────────────────────────────────
// THE SWITCHES
// ─────────────────────────────────────────────────────────────────────────────

export const SOLO_RULES = {
  // -- How a run ends ---------------------------------------------------------
  // false = the clock is the ONLY fail state (current design). Set true to
  // bring hearts back; drills read LIVES_ENABLED for both the HUD and the
  // end-of-run check, so nothing else needs touching.
  LIVES_ENABLED: false,
  MAX_LIVES: 5,

  // -- What a mistake costs ---------------------------------------------------
  // With LIVES_ENABLED false, at least one of these MUST stay on. If a mistake
  // costs nothing at all, spam-tapping becomes strictly better than playing:
  // wrong taps are free and stray correct ones still buy time, so the run never
  // ends and accuracy stops meaning anything.
  TIME_PENALTY_ENABLED: true,
  TIME_PER_MISTAKE: 1.0,

  // Off in solo by long-standing design — a mistake breaks your combo, it does
  // not claw back points you already earned. Arena applies its own −5 instead,
  // which lives in the drills' isChallenge branches, not here.
  SCORE_PENALTY_ENABLED: false,
  SCORE_PER_MISTAKE: 5,

  // -- What a hit earns -------------------------------------------------------
  // The endurance clock. Turn this off and every drill reverts to a plain fixed
  // countdown of TOTAL_TIME seconds.
  TIME_REWARD_ENABLED: true,
  // 1.0, up from 0.6.
  //
  // The break-even accuracy for holding the clock is NOT penalty/(penalty+
  // reward) — that leaves out the fact that the clock also drains one second
  // per second on its own. The real condition is
  //
  //     rate * acc * reward  >=  1 + rate * (1 - acc) * penalty
  //
  // which makes the answer depend on how fast the drill lets you act:
  //
  //     reward     1/sec   1.5/sec   2/sec   2.5/sec   3/sec
  //       0.6      never    never     94%      88%      83%
  //       0.8      never     93%      83%      78%      74%
  //       1.0       100%     83%      75%      70%      67%
  //
  // At 0.6 a two-action-per-second drill demanded 94% accuracy just to stay
  // alive, so essentially every run was a flat 45 seconds regardless of skill
  // and the level ramp was decoration. 1.0 asks for 75%, which is a real bar
  // that good play clears and sloppy play does not.
  //
  // WATCH: drills that only allow about one action per second (Shade Finder is
  // the clearest) still cannot hold the clock at any accuracy. Those need a
  // per-drill reward above this shared one — see the note in the pass summary.
  TIME_PER_HIT: 1.0,
  TIME_CAP: 60.0,

  // A hit buys less time the deeper you are, and this decay has no floor.
  // It is what guarantees a run ENDS. The difficulty ramp now stops at
  // SOLO_MAX_LEVEL, so it can no longer be the thing that ends a run — every
  // dial is fixed from level 40 on. The economy takes over from there: the
  // board never becomes impossible, it just gets stingier until nobody's hands
  // are fast enough to break even.
  //
  // NOTE this decays on CORRECT ACTIONS, not on level — see timePerHit(). Level
  // is capped, hits are not, so keying it to level would floor the payout at
  // level 40 and a strong player would refill the clock forever.
  //
  // 0.99 against the 1.0 reward gives, at two actions per second:
  //     65% accuracy -> 1.4 min   78% -> 2.7 min   88% -> 4.1 min   95% -> 4.8 min
  // Anything from average up reaches the level 40 cap; below that you still
  // climb into the high twenties. Lower this to shorten every run.
  TIME_PER_HIT_DECAY: 0.99,

  // -- Difficulty progression -------------------------------------------------
  // Levels are earned per CORRECT ACTION, not per point — see levelForHits().
  //
  // Scoring off points looked equivalent and was not. Points per hit are not
  // constant: base 6 is multiplied by the combo tier (to x3), a speed bonus (to
  // +150%) and the level multiplier, so one hit is worth 6 points cold and ~99
  // deep into a clean run. Against a flat POINTS_PER_LEVEL of 40 that meant a
  // cold start took ~7 hits per level while a hot streak took less than one —
  // capped to +1 per hit, but that is still a 7x acceleration in
  // how fast difficulty arrives, triggered by playing WELL.
  //
  // That was the "it suddenly becomes impossible" report. Not a step in any
  // curve — the curves are smooth — but the ramp itself speeding up under a
  // player whose combo was climbing, and then ratcheting so it never came back
  // down when the combo broke.
  //
  // Hits per second is roughly constant, so levelling on hits makes difficulty
  // arrive at a constant rate for everyone, cold or hot.
  //
  // 6, up from 4.
  //
  // At 4 a strong run (measured: ~283 correct hits, 30,000 points) hit the
  // level 40 cap after 160 hits — 57% of the way in — and then spent the
  // ENTIRE back half of the run at a difficulty that had stopped rising. That
  // is the "it never gets harder" report, and it was literally true: the ramp
  // had finished while the player was still going.
  //
  // 6 puts level 40 at ~234 hits, so the cap now lands near the end of a strong
  // run instead of halfway through it, and reaching it is an achievement rather
  // than a formality. Weaker runs still climb into the high teens or twenties,
  // so progression stays visible for everyone.
  HITS_PER_LEVEL: 6,

  // Kept for Arena and for Quick Dodge, which owns its own score-keyed table.
  UNCAPPED_LEVELS: true,
  POINTS_PER_LEVEL: 40,

  // Every run starts at level 1. The old behaviour seeded returning players at
  // ~75% of their best level; under an uncapped ramp that seed climbs every
  // session, so each run opens harder than the last, at a difficulty reached
  // once on a best day. It also makes two runs of the same drill incomparable,
  // which matters because the run IS the score.
  CARRY_OVER_START_LEVEL: false,
  CARRY_OVER_FRACTION: 0.75,
};

// Duels ramp over a fixed number of steps and never past it — both players must
// face identical difficulty at identical moments.
//
// 40, matching SOLO_MAX_LEVEL, so Arena and solo run the ONE curve. It was 15
// against the old decay ramp, and the two land in almost the same place: a duel
// used to reach 58% of a drill's range by its last step, which for Selective
// Attention's 1800ms window was ~1000ms — the new level 40 is 1007ms. So this
// is a granularity change, not a difficulty change, and it removes the need for
// a second curve shape to exist at all.
//
// Scoring is unaffected: scoreAction normalises its level multiplier against
// whatever maxLevel it is handed, so a duel still spans x1.0 to x1.5.
export const DUEL_MAX_LEVEL = 40;

// ─────────────────────────────────────────────────────────────────────────────
// HOW FAST DIFFICULTY CLIMBS — the single most player-visible number here
// ─────────────────────────────────────────────────────────────────────────────
//
// Solo difficulty now ramps LINEARLY over exactly SOLO_MAX_LEVEL levels: every
// level is the same size step as every other level. From 40 on, nothing gets
// harder — the board is fixed and the time economy carries the run from there.
//
// "Linear" here means constant PERCENTAGE, not constant absolute step, and the
// difference is the whole point. A reaction window taken from 1800ms to 420ms
// in 39 equal 35ms steps reads as accelerating, because a 35ms cut off 1800ms
// is nothing and the same cut off 455ms is huge:
//
//   constant absolute:  L1>2 -2.0%   L20>21 -3.1%   L39>40 -7.8%   <- lurches
//   constant percent:   L1>2 -1.5%   L20>21 -1.5%   L39>40 -1.5%   <- flat
//
// Perceived change is proportional, so equal ratios are what actually feel
// even. Every dial in every drill therefore moves by the same step per
// level, in the same direction, forever — one number, whole catalogue.
//
// The old model decayed 6% of the REMAINING gap per level, forever, and so
// never actually reached any drill's floor — it just crept at an ever-smaller
// rate while the level number kept climbing without limit.
export const SOLO_MAX_LEVEL = 40;

// The per-level step is FRONT-LOADED: ~6% at the start, easing to ~2% by the
// end. Three numbers, one shape.
//
// This replaced a flat 1.5%, which was a mistake in the opposite direction from
// the original spike. Two measurements killed it:
//
//  1. People notice a change in speed or timing at roughly 7% (Weber's law).
//     At 1.5% a player had to climb FIVE levels — about 20 seconds — before
//     anything felt different at all. A ramp you cannot perceive reads as no
//     progression, which is as bad as a cliff and considerably more boring.
//  2. 39 levels of 1.5% is only x1.79 total, so Selective Attention's window
//     bottomed out at 1007ms against a 420ms design floor. The hard end of
//     every drill was literally unreachable — the player never got to meet the
//     drill's real difficulty, only its opening.
//
// Front-loading fixes both without bringing the spike back, because the step
// only ever DECREASES. Level 1->2 is the biggest jump a player will ever take;
// nothing later can surprise them. That is the opposite failure mode from the
// original bug, which was the levelling RATE accelerating ~7x under a combo —
// and that is fixed independently, in levelForHits().
//
//   level:      1     2     5    12    20    30    40
//   step:    6.0%  5.7%  5.0%  3.8%  3.0%  2.5%  2.2%
//   window:  1800  1698  1448  1069   817   623   494 ms
//
// Tuning: raise LEVEL_STEP_START for more bite in the opening seconds, raise
// LEVEL_STEP_FLOOR to make the late game climb harder, lower LEVEL_STEP_DECAY
// to reach the calm part sooner.
export const LEVEL_STEP_START = 0.06;
export const LEVEL_STEP_FLOOR = 0.02;
export const LEVEL_STEP_DECAY = 0.93;

// Cumulative difficulty factor for every level, built once at module load.
//
// The curve has no closed form (it is a running product of a decaying step), and
// rampToFloor is called from inside render loops in the canvas drills — so this
// is a 40-entry table rather than a loop per call.
const LEVEL_FACTOR = (() => {
  const out = new Float64Array(SOLO_MAX_LEVEL + 1);
  out[0] = 1;
  out[1] = 1;
  let f = 1;
  for (let l = 2; l <= SOLO_MAX_LEVEL; l++) {
    const step = LEVEL_STEP_FLOOR
      + (LEVEL_STEP_START - LEVEL_STEP_FLOOR) * Math.pow(LEVEL_STEP_DECAY, l - 2);
    f *= 1 + step;
    out[l] = f;
  }
  return out;
})();

/**
 * How many times harder level `level` is than level 1, clamped at SOLO_MAX_LEVEL.
 *
 * Interpolates between table entries: several drills carry a FRACTIONAL level —
 * Kinetic Intercept's is a float, and anything using stepRelief() feeds back a
 * fractional effective level — and snapping those to whole numbers would put a
 * visible stair back into exactly the dials the relief exists to smooth.
 */
export function levelFactor(level, maxLevel = SOLO_MAX_LEVEL) {
  const cap = Math.min(maxLevel, SOLO_MAX_LEVEL);
  const L = Math.max(1, Math.min(cap, level));
  const lo = Math.floor(L);
  if (lo >= cap) return LEVEL_FACTOR[cap];
  return LEVEL_FACTOR[lo] + (LEVEL_FACTOR[lo + 1] - LEVEL_FACTOR[lo]) * (L - lo);
}

// ─────────────────────────────────────────────────────────────────────────────
// CURVE MATHS — shared by every drill, fed each drill's own dial values
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE solo level function. Levels come from correct ACTIONS, not points.
 *
 * Use this everywhere in solo. Arena ramps on elapsed time instead (see
 * duelLevelForElapsed), and Quick Dodge owns a hand-tuned table of its own.
 *
 * Why not points: see HITS_PER_LEVEL in SOLO_RULES. Points per hit swing 16x
 * across a run as combo and speed bonuses stack, so a score-keyed level ramps
 * ~7x faster for a player on a streak than for the same player cold. Hits per
 * second barely moves, so this arrives at a constant rate.
 *
 * Monotonic by construction — a hit counter only goes up — so this needs no
 * ratchet of its own, which is why the old score-keyed pair it replaced
 * (levelForScore + a +1-per-hit stepLevel) is gone.
 */
export function levelForHits(correctHits, hitsPerLevel = SOLO_RULES.HITS_PER_LEVEL) {
  const level = 1 + Math.floor(Math.max(0, correctHits) / hitsPerLevel);
  return Math.min(SOLO_MAX_LEVEL, level);
}

/**
 * Where a level sits on the 0..1 difficulty runway. Clamped at both ends, so
 * every dial simply stops moving at SOLO_MAX_LEVEL instead of running past its
 * designed limit.
 */
export function levelSpan(level, maxLevel = SOLO_MAX_LEVEL) {
  const cap = Math.min(maxLevel, SOLO_MAX_LEVEL);
  if (cap <= 1) return 0;
  // Normalised against the SAME front-loaded curve the value dials use, so a
  // probability that fades in (a hazard, a trap, a multi-drop) arrives on the
  // same schedule as the speeds and windows around it. When this was a plain
  // linear fraction those two families drifted apart mid-run.
  const top = levelFactor(cap, cap);
  if (top <= 1) return 0;
  return (levelFactor(level, cap) - 1) / (top - 1);
}

/**
 * Duel level: ramps over elapsed time, capped. Safe because a duel clock only
 * ever counts DOWN — see rampToFloor's warning about refilling clocks.
 */
export function duelLevelForElapsed(totalTime, timeRemaining) {
  const progress = Math.max(0, Math.min(1, (totalTime - timeRemaining) / totalTime));
  return Math.min(DUEL_MAX_LEVEL, 1 + Math.floor(progress * DUEL_MAX_LEVEL));
}

/**
 * The one difficulty curve every drill should use: decays from `start` toward
 * `floor`, forever, never crossing it.
 *
 * Replaces the `start - progress * range` shape that was everywhere, where
 * `progress` was normalised against a MAX_LEVEL of 15. That form is only valid
 * while a ceiling exists — uncapped, `progress` runs past 1 and the value walks
 * straight through its floor into zero and then negative. A reaction window of
 * 0ms isn't hard, it's broken: nothing is ever hittable.
 *
 * This form is correct at level 1 and at level 500.
 *
 * NEVER derive `level` for this from remaining time in solo. The endurance clock
 * refills, so a time-based ramp runs BACKWARDS — playing well raises the clock,
 * which lowers progress, which makes the drill easier. That bug shipped in
 * Conflict Reflex; don't reintroduce it.
 *
 * @param {number} level  1-based, uncapped
 * @param {number} start  value at level 1
 * @param {number} floor  hard limit, approached but never crossed
 * @param {number} decay  per-level factor, 0..1 (lower = ramps harder/faster)
 */
export function rampToFloor(level, start, end, maxLevel = SOLO_MAX_LEVEL) {
  // A dial that starts at 0 (a hazard probability, a spawn chance) has no ratio
  // to hold constant, so those are genuinely linear in value.
  if (start <= 0 || end <= 0) return start + (end - start) * levelSpan(level, maxLevel);

  const factor = levelFactor(level, maxLevel);
  // Symmetric: shrinking divides by the same factor growing multiplies by, so
  // "5% harder this level" means the same thing to a window and to a speed. The
  // floor/ceiling clamps rather than being interpolated toward — most drills now
  // DO reach theirs in the late thirties, which is the point.
  return end < start ? Math.max(end, start / factor) : Math.min(end, start * factor);
}

/** Same curve, rounded — for millisecond windows and pixel sizes. */
export function rampMs(level, start, floor, maxLevel = SOLO_MAX_LEVEL) {
  return Math.round(rampToFloor(level, start, floor, maxLevel));
}


/**
 * Ramp that grows instead of shrinking — speeds, spawn counts, hazard rates.
 * Approaches `ceiling` and never exceeds it. Pass a `hardMax` for anything with
 * a real cost (object counts: more items means more DOM/CPU, and a board can
 * physically run out of non-overlapping positions).
 */
export function rampUp(level, start, ceiling, hardMax = null, maxLevel = SOLO_MAX_LEVEL) {
  const v = rampToFloor(level, start, ceiling, maxLevel);
  return hardMax === null ? v : Math.min(hardMax, v);
}

/**
 * A 0..1 "how deep are we" fraction: 0 at level 1, exactly 1 at SOLO_MAX_LEVEL,
 * and clamped there.
 *
 * ONLY for dials that genuinely start at zero and grow to a cap — a multi-drop
 * chance, a trap probability, a minimum separation of 0. Those have no ratio to
 * hold constant, so linear in value is the correct shape and `p * SOME_CAP`
 * reads exactly as written.
 *
 * Do NOT use it to interpolate a dial between two non-zero values. Writing
 * `1400 - p * 1000` gives a constant ABSOLUTE step, which is the accelerating
 * shape described at SOLO_MAX_LEVEL above — a 2% change per level early and
 * nearly 8% per level at the end. Use rampToFloor/rampUp for those; they hold
 * the percentage constant instead.
 */
export function levelProgress(level, maxLevel = SOLO_MAX_LEVEL) {
  return levelSpan(level, maxLevel);
}

/**
 * Round to an integer WITHOUT the stair-step.
 *
 * Any dial that must be a whole number — how many distractors spawn, how long a
 * chain is, how many symbols reshuffle — jumps by a full unit when a plain
 * `Math.round` crosses .5, and that jump is a difficulty cliff the player feels
 * as "it suddenly got harder". Rolling the fraction instead keeps the AVERAGE
 * exactly equal to `value`, so 4.3 distractors means 4 seven times out of ten
 * and 5 the other three — the load rises smoothly across rounds even though
 * every individual round is a whole number.
 *
 * Use for per-round counts that are re-rolled often. Do NOT use for anything
 * persistent (a grid size, a disk count) — there the flicker would read as a
 * bug, not as a ramp.
 */
export function stochasticRound(value) {
  const base = Math.floor(value);
  return base + (Math.random() < value - base ? 1 : 0);
}

/**
 * The "difficulty budget" transfer for a rule that can only arrive whole.
 *
 * Some steps genuinely cannot be fractional: a second target glyph to hold in
 * memory, a fourth colour in the pool, a trap node on the board. The moment one
 * of those turns on, total load jumps even though every continuous dial around
 * it moved smoothly.
 *
 * So hand a slice back. Feed this effective level to the continuous dials
 * (speed, spawn rate, reaction window) instead of the real level: at the
 * instant the rule fires they drop `levels` rungs, then climb back over the
 * following levels as `decay` fades the relief out. The new rule arrives while
 * everything else is briefly gentler, which is the difference between a spike
 * and a slope.
 *
 * @param {number} level      current level
 * @param {number|null} stepLevel  level the discrete rule fired at, or null
 * @param {number} levels     how many rungs to hand back at the moment it fires
 * @param {number} decay      per-level fade, 0..1 (lower = relief ends sooner)
 */
export function stepRelief(level, stepLevel, levels = 2, decay = 0.72) {
  if (stepLevel === null || stepLevel === undefined || level < stepLevel) return level;
  return Math.max(1, level - levels * Math.pow(decay, level - stepLevel));
}

/**
 * Seconds a hit buys. Honours TIME_REWARD_ENABLED.
 *
 * Pass `hits` (the run's correct-action count) wherever you have it. Difficulty
 * now stops climbing at SOLO_MAX_LEVEL, so the payout can no longer key off the
 * level: it would floor at level 40 and a player holding ~65% accuracy would
 * refill the clock forever. The hit count keeps rising, so it keeps the economy
 * tightening after the board has stopped changing — that is what ends a run now.
 *
 * Falls back to the level for callers with no hit counter (Quick Dodge, and the
 * board-growth drills whose "level" is a grid size).
 */
export function timePerHit(level, hits = null, reward = SOLO_RULES.TIME_PER_HIT) {
  if (!SOLO_RULES.TIME_REWARD_ENABLED) return 0;
  const depth = hits === null
    ? Math.max(0, level - 1)
    : Math.max(0, hits) / SOLO_RULES.HITS_PER_LEVEL;
  return reward * Math.pow(SOLO_RULES.TIME_PER_HIT_DECAY, depth);
}

/**
 * The per-hit reward a drill needs so that `targetAccuracy` is the bar for
 * holding the clock steady.
 *
 * The shared TIME_PER_HIT is calibrated for a drill you can act on roughly
 * twice a second. A drill with a slower cadence — one flash every two seconds,
 * one visual search per round — cannot refill against a clock that drains 1s
 * per second no matter how well it is played, so its run is a flat TOTAL_TIME
 * every time and the endurance model quietly does nothing. That is not a
 * difficulty problem, it is a units problem: the same 1.0s means something
 * completely different at 0.45 actions/sec than at 2.
 *
 * Solving  rate * acc * reward  ==  1 + rate * (1 - acc) * penalty  gives:
 */
export function rewardForActionRate(actionsPerSecond, targetAccuracy = 0.8) {
  const penalty = SOLO_RULES.TIME_PER_MISTAKE;
  return (1 + actionsPerSecond * (1 - targetAccuracy) * penalty)
       / (actionsPerSecond * targetAccuracy);
}

/** Level a run starts at. */
export function startLevel(bestLevel = 1) {
  if (!SOLO_RULES.CARRY_OVER_START_LEVEL) return 1;
  return Math.max(1, Math.min(DUEL_MAX_LEVEL, Math.round((bestLevel || 1) * SOLO_RULES.CARRY_OVER_FRACTION)));
}

// ─────────────────────────────────────────────────────────────────────────────
// STATE TRANSITIONS — the only two moments a rule actually fires
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply a correct action. Returns the new clock value.
 * Call ONLY in solo — a duel clock is a shared deadline and must never move.
 */
export function applyHit({ timeRemaining, level, hits = null, reward = SOLO_RULES.TIME_PER_HIT }) {
  if (!SOLO_RULES.TIME_REWARD_ENABLED) return timeRemaining;
  return Math.min(SOLO_RULES.TIME_CAP, timeRemaining + timePerHit(level, hits, reward));
}

/**
 * Apply a mistake. Returns the new clock, lives and score, plus whether the run
 * is now over. Every flag above is honoured here, so a drill's mistake handler
 * is the same three lines regardless of which rules are switched on.
 *
 * Call ONLY in solo.
 */
export function applyMistake({ timeRemaining, lives = SOLO_RULES.MAX_LIVES, score = 0 }) {
  let nextTime = timeRemaining;
  let nextLives = lives;
  let nextScore = score;

  if (SOLO_RULES.TIME_PENALTY_ENABLED) {
    nextTime = Math.max(0, nextTime - SOLO_RULES.TIME_PER_MISTAKE);
  }
  if (SOLO_RULES.LIVES_ENABLED) {
    // Floored at 0: a negative count used to feed the heartbeat's danger
    // formula unbounded, which drove its self-rescheduling setTimeout negative
    // and span it into a tight loop at full CPU.
    nextLives = Math.max(0, nextLives - 1);
  }
  if (SOLO_RULES.SCORE_PENALTY_ENABLED) {
    nextScore = Math.max(0, nextScore - SOLO_RULES.SCORE_PER_MISTAKE);
  }

  const runOver = nextTime <= 0 || (SOLO_RULES.LIVES_ENABLED && nextLives <= 0);
  return { timeRemaining: nextTime, lives: nextLives, score: nextScore, runOver };
}

/**
 * What to pass scoringEngine's `maxLevel`. null asks for its unbounded level
 * multiplier — without it, points stop growing at the old ceiling while the
 * drill keeps getting harder, so depth pays nothing.
 */
export function scoringMaxLevel(isChallenge) {
  if (isChallenge) return DUEL_MAX_LEVEL;
  return SOLO_RULES.UNCAPPED_LEVELS ? null : DUEL_MAX_LEVEL;
}

/** What to pass scoringEngine's `livesRemaining`. null disables survival bonuses. */
export function scoringLives(lives) {
  return SOLO_RULES.LIVES_ENABLED ? Math.max(0, lives) : null;
}
