// lib/bestScoreSync.js
// Keeps each drill's own "BEST" in step with the canonical score store.
//
// THE PROBLEM THIS SOLVES
// There are two places a personal best lives, and they can drift apart:
//
//  1. `sd_scores` — written by progressStore.saveDrillResult, and on Android it
//     goes through lib/storage.js into @capacitor/preferences, i.e. the
//     SharedPreferences file. This is the canonical record and it is what the
//     Progress screen reads.
//  2. Each drill's OWN `skilldrills_*` record, written straight to localStorage
//     by the drill itself. This is what the start card and the result screen's
//     "BEST SCORE" tile read.
//
// Those two stores sit on opposite sides of Android's backup line: a device
// transfer carries SharedPreferences across but deliberately excludes the
// WebView's localStorage (it holds the cached session — see
// android/app/src/main/res/xml/data_extraction_rules.xml). Reinstalling for any
// reason has the same effect. The result is a phone where the Progress screen
// correctly says "Level 15, 23 drills played" while every single start card
// reads BEST 0 — the bests were not lost, the drill just cannot see them.
//
// So on boot we copy the canonical best back into whichever record the drill
// reads. This only ever RAISES a drill's best, never lowers it, so it cannot
// destroy a genuine local record that happens to be ahead of sd_scores.

import { Storage } from './storage';

// drillId -> where that drill keeps its own copy.
//   kind 'json'   : a JSON blob with a `bestScore` field
//   kind 'number' : the score on its own, as a string
//
// drillId is the id each drill passes to saveLeaderboardEntry, verified against
// the drill sources rather than assumed from the folder name.
const DRILL_BEST_KEYS = {
  'card-matching':              { key: 'skilldrills_card_matching_v1',              kind: 'json' },
  'concentration-grid':         { key: 'skilldrills_concentration_grid_v1',         kind: 'json' },
  'distraction-fighter':        { key: 'skilldrills_distraction_fighter_v8',        kind: 'json' },
  'grid-memorization':          { key: 'skilldrills_grid_memorization_v1',          kind: 'json' },
  'moving-target':              { key: 'skilldrills_kinetic_intercept_v2',          kind: 'json' },
  'multi-tasking':              { key: 'skilldrills_multi_tasking_v1',              kind: 'json' },
  'quick-dodge':                { key: 'skilldrills_quick_dodge_v3',                kind: 'json' },
  'shade-finder':               { key: 'skilldrills_shade_finder_v1',               kind: 'json' },
  'tower-of-hanoi':             { key: 'skilldrills_hanoi_v3',                      kind: 'json' },
  // The two that predate the shared shape and store a bare number.
  'finger-sequencing':          { key: 'sequenceAim_bestScore',                     kind: 'number' },
};

/**
 * Raise each drill's own best to match `sd_scores` where it has fallen behind.
 *
 * Safe to call on every boot: it is a no-op when the two stores already agree,
 * which is the normal case. Never throws — a failure here must not stop the app
 * from starting, and the only cost of it failing is a start card reading 0.
 *
 * @returns {Promise<number>} how many drill records were repaired
 */
export async function reconcileDrillBests() {
  if (typeof localStorage === 'undefined') return 0;

  let scores;
  try {
    scores = await Storage.getJSON('sd_scores', {});
  } catch {
    return 0;
  }
  if (!scores || typeof scores !== 'object') return 0;

  let repaired = 0;

  for (const [drillId, entry] of Object.entries(scores)) {
    const target = DRILL_BEST_KEYS[drillId];
    const canonical = Number(entry?.best) || 0;
    if (!target || canonical <= 0) continue;

    try {
      const raw = localStorage.getItem(target.key);

      if (target.kind === 'number') {
        const local = raw == null ? 0 : parseInt(raw, 10) || 0;
        if (canonical > local) {
          localStorage.setItem(target.key, String(canonical));
          repaired += 1;
        }
        continue;
      }

      // kind 'json' — preserve every other field the drill keeps in there
      // (bestCombo, bestLevel, totalSessions...), only lift bestScore.
      const parsed = raw ? JSON.parse(raw) : {};
      const record = parsed && typeof parsed === 'object' ? parsed : {};
      const local = Number(record.bestScore) || 0;
      if (canonical > local) {
        record.bestScore = canonical;
        // When there was NO local record at all (device transfer / reinstall —
        // the exact case this file exists for), the drill would read back a
        // blob with only bestScore set and render "undefined×" for combo and
        // "undefined" for level on its start card. Seed the shared shape so a
        // repaired record still looks like one the drill wrote itself.
        if (!raw) {
          if (record.bestCombo === undefined) record.bestCombo = 0;
          if (record.bestLevel === undefined) record.bestLevel = 1;
          if (record.totalSessions === undefined) record.totalSessions = 0;
        }
        localStorage.setItem(target.key, JSON.stringify(record));
        repaired += 1;
      }
    } catch {
      // A single unreadable record must not stop the rest being repaired.
    }
  }

  return repaired;
}
