// lib/challengeEngine.js
// SkillDrills Pro — Real-time Online Challenge Matchmaking Engine

import { useState, useEffect } from 'react';
import { initFirebase } from './firebase';
import {
  collection,
  addDoc,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  getDoc,
  onSnapshot,
  query,
  where,
  limit,
  getDocs,
  runTransaction,
  serverTimestamp
} from 'firebase/firestore';

// ── Cross-device clock alignment ─────────────────────────────────────────────
//
// A duel's start instant is shared between the two players as one absolute
// timestamp (`matchStartAt`), which only makes them start together if both
// devices agree on what time it is. They frequently don't — phone clocks
// routinely sit seconds apart — and the old code stamped that timestamp from the
// HOST's clock while the guest measured the delay against its OWN clock. Every
// millisecond of disagreement became a head start for one player in a 30-second
// scored match: a guest whose clock ran 2s behind the host's began 2s late and
// simply had less time to score.
//
// So `matchStartAt` is written in SERVER time, and each client converts it using
// its own measured offset from the server clock. Measured once per session and
// cached. On any failure the offset is 0, which is exactly the old behaviour —
// this can never leave timing worse than it was.
let clockOffsetMs = null;
let clockOffsetInFlight = null;

// How many timing samples to take when measuring this device's clock offset,
// and how many of the fastest (lowest round-trip-time) samples to average.
// NTP-style: a sample with less time in transit leaves less room for
// asymmetric network delay (upload vs download taking different lengths of
// time) to bias the estimate, so the fastest samples are the most
// trustworthy. Averaging a few of them (not just taking the single best)
// smooths out the small remaining noise without needing many more round
// trips. Not verified against two real devices duelling side by side yet —
// only one test device was available when this was written — so treat the
// sample/keep counts as a reasoned starting point, not a tuned result.
const CLOCK_SYNC_SAMPLES = 5;
const CLOCK_SYNC_KEEP_BEST = 3;

/** How far this device's clock is from the server's, in ms (server − local). */
export async function getServerClockOffset() {
  if (clockOffsetMs !== null) return clockOffsetMs;
  if (clockOffsetInFlight) return clockOffsetInFlight;

  clockOffsetInFlight = (async () => {
    let measured = 0;
    try {
      const firebase = initFirebase();
      const uid = firebase?.auth?.currentUser?.uid;
      if (firebase && uid) {
        const ref = doc(firebase.db, 'users', uid);
        const samples = [];

        for (let i = 0; i < CLOCK_SYNC_SAMPLES; i++) {
          try {
            const before = Date.now();
            await updateDoc(ref, { clockSyncAt: serverTimestamp() });
            // Anchored to the WRITE's own round trip, not a separate
            // follow-up read below — the server stamps clockSyncAt at write
            // time, so an independent read afterward adds elapsed time that
            // has nothing to do with when that stamp actually happened and
            // only made the "midpoint of the whole trip" estimate worse.
            const afterWrite = Date.now();
            const rtt = afterWrite - before;

            const snap = await getDoc(ref);
            const serverMs = snap.data()?.clockSyncAt?.toMillis?.();
            if (serverMs) {
              samples.push({ rtt, offset: serverMs - (before + rtt / 2) });
            }
          } catch (err) {
            console.error(`Server clock sync sample ${i + 1} failed:`, err);
          }
        }

        if (samples.length > 0) {
          samples.sort((a, b) => a.rtt - b.rtt);
          const kept = samples.slice(0, CLOCK_SYNC_KEEP_BEST);
          measured = kept.reduce((sum, s) => sum + s.offset, 0) / kept.length;
        }
      }
    } catch (err) {
      console.error('Server clock sync failed — falling back to local time:', err);
    }
    // Cached either way, including the 0 fallback, so a failing measurement
    // can't turn into a write on every single match.
    clockOffsetMs = measured;
    clockOffsetInFlight = null;
    return clockOffsetMs;
  })();

  return clockOffsetInFlight;
}

/**
 * React hook: watches a challenge doc for the shared `matchStartAt` timestamp
 * (DrillWrapper.js writes it once both duelists are ready) so a duel-eligible
 * drill can auto-start itself directly, in sync with its opponent.
 *
 * This reads Firestore directly rather than via React Context on purpose: the
 * drill component that needs this value is the one that RENDERS
 * `<DrillWrapper>`, i.e. it's an ANCESTOR of DrillWrapper in the tree, not a
 * descendant — a Context Provider living inside DrillWrapper's own returned
 * JSX can never be observed by a useContext() call made in the drill's own
 * top-level component body, no matter how the JSX is nested textually.
 */
export function useDuelMatchStart(challengeId) {
  const [matchStartAt, setMatchStartAt] = useState(null);

  useEffect(() => {
    setMatchStartAt(null);
    if (!challengeId) return;
    const firebase = initFirebase();
    if (!firebase) return;
    let cancelled = false;

    // matchStartAt is written once, at the start of the match, and never
    // changes again — so this listener has nothing left to do once it's
    // captured that value. Unsubscribing immediately (instead of staying
    // open for the rest of the match) avoids running a second, redundant
    // live subscription on top of DrillWrapper's own listener on this same
    // doc for the whole duel.
    const unsubscribe = onSnapshot(doc(firebase.db, 'challenges', challengeId), (snap) => {
      const data = snap.data();
      // A finished match never starts again. `matchStartAt` stays on the doc
      // forever, so without this check, navigating back to a completed duel's
      // URL — after forfeiting it, or from history — re-triggered every drill's
      // auto-start and set the game running underneath the result overlay:
      // burning CPU on a match that was already decided, and inviting a second
      // attempt at one the player had already walked out of. Bailing out here
      // covers all six duel drills at once, since they all start from this hook.
      if (data?.status === 'completed') {
        unsubscribe();
        return;
      }
      if (data?.matchStartAt) {
        unsubscribe();
        // `matchStartAt` is stored in SERVER time. Hand callers back the same
        // instant expressed on THIS device's clock, so the plain
        // `matchStartAt - Date.now()` maths every duel drill already does stays
        // correct even when the two players' clocks disagree — one conversion
        // here rather than six copies of it out in the drills.
        getServerClockOffset().then((offset) => {
          if (!cancelled) setMatchStartAt(data.matchStartAt - offset);
        });
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [challengeId]);

  return matchStartAt;
}

// A pending/accepted challenge nobody ever started playing is abandoned —
// clean it up rather than let it sit in Firestore forever.
const STALE_CHALLENGE_MS = 20 * 60 * 1000; // 20 minutes

// Scores are still fundamentally client-reported (no server-side match
// verification exists), but this rejects the obviously-impossible values —
// NaN/Infinity, negatives, or numbers no real drill session could produce.
const MAX_PLAUSIBLE_SCORE = 999999;
function isPlausibleScore(score) {
  return typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= MAX_PLAUSIBLE_SCORE;
}

// EIQ ("Effective IQ") is the Arena rank — a competitive ladder earned ONLY
// from Arena duels. It works like a chess rating: the WINNER gains EIQ and the
// LOSER loses the same amount (one climbs, the other steps down). The size of
// that swing scales with the drill's hardness and how decisive the win was
// (see eiqSwing). EIQ starts at 0 and is floored at 0 — it can never go
// negative. A draw moves nobody.
export const DEFAULT_EIQ = 0;

// Drills that support duel mode (useDuelMatchStart-driven auto-start + a
// forced 30s duration, wired up in each file individually — see
// components/DrillWrapper.js and each drill's own client component).
//
// Roster curated for head-to-head fun. Every entry is understandable in 3
// seconds, scores continuously, and plays fairly on phone vs laptop. The
// FIRST entry is the auto-matchmaking default drill.
//
// `hardness` (relative cognitive load) sets how much EIQ is at stake per
// match — a win on a harder drill is worth a bigger swing than a win on an
// easy one.
//
// Removed from duels (all still playable solo): Symbol Matching (keyboard
// input advantage), Divided Attention & Light Reaction (device-test cuts),
// Conflict Reflex, Batch Processing, Selective Attention (2026-07-19), and —
// on user request (2026-07-22) — Quick Dodge and Shade Finder. Target Lock
// (reaction-time) was removed the same day and re-added shortly after on
// user request — its duel wiring was never touched, only the roster entry.
export const DUEL_DRILLS = [
  { slug: 'cognitive/focus/concentration-grid', name: 'Concentration Grid', hardness: 1.2 },
  { slug: 'cognitive/attention/multi-tasking', name: 'Multi-Tasking', hardness: 1.4 },
  { slug: 'cognitive/processing-speed/finger-sequencing', name: 'Sequence Aim Trainer', hardness: 1.1 },
  { slug: 'cognitive/memory/grid-memorization', name: 'Grid Memorization', hardness: 1.3 },
  { slug: 'cognitive/problem-solving/tower-of-hanoi', name: 'Tower of Hanoi', hardness: 1.5 },
  { slug: 'cognitive/processing-speed/reaction-time', name: 'Target Lock', hardness: 1.1 },
];

// Base EIQ at stake in a dead-even, fully-expected match on a hardness-1.0
// drill. Actual swing = BASE × hardness × marginFactor × upsetFactor — see
// eiqSwing() below.
const BASE_EIQ_STAKE = 30;

// Elo-style "expected outcome" tuning. RATING_SPREAD is the EIQ gap at which
// the higher-rated player is expected to win ~91% of the time — tuned to
// this app's EIQ scale (tiers span 0-5500+), not chess's 400. MIN_UPSET_FACTOR
// keeps a fully-expected win worth a small nonzero trickle rather than
// exactly 0, so it doesn't read as "blocked" — but small enough that
// grinding a low-ranked opponent for EIQ is structurally not worth doing.
const RATING_SPREAD = 600;
const MIN_UPSET_FACTOR = 0.03;

// Anti-abuse: repeatedly entering and immediately forfeiting Arena matches
// (to dodge a bad matchup, grief an opponent's queue time, etc.) locks a
// player out of STARTING OR ACCEPTING new ones for a while — 30 minutes per
// forfeit, escalating to a full hour once they've forfeited
// FORFEIT_ESCALATION_STREAK matches in a row without a single one actually
// played out to completion. The streak (and any standing lockout) resets the
// moment they genuinely finish a match, win or lose — this only punishes an
// unbroken run of quits, not one bad match after a long clean history.
const FORFEIT_LOCKOUT_BASE_MS = 30 * 60 * 1000;
const FORFEIT_LOCKOUT_ESCALATED_MS = 60 * 60 * 1000;
const FORFEIT_ESCALATION_STREAK = 7;

// A forfeited/abandoned match was never actually played out, so the player
// who stayed shouldn't earn anywhere near a real win's EIQ from it — flat
// and low regardless of drill, so leaving can never be used to hand a friend
// (or an alt account) a big rank boost. The player who quit still loses the
// FULL normal swing though (see completeMatchInTx) — that's what makes the
// lockout above a real deterrent rather than a free pass.
const FORFEIT_WINNER_EIQ_CAP = 8;

/**
 * How much longer (ms) `user` is locked out of starting or accepting a new
 * Arena match, or 0 if they're clear. `user` is the live-synced profile
 * object from AuthContext (its onSnapshot merge already picks up
 * arenaLockedUntil automatically, same as eiq/wins/losses).
 *
 * This is a client-side gate for a fast, friendly message — not the actual
 * security boundary. That's firestore.rules, which is what stops a player
 * from just clearing arenaLockedUntil on their own doc: the field can only
 * ever move forward in time, and only from inside the bounded match-stat
 * branch a forfeit resolution writes through (see completeMatchInTx).
 */
export function arenaLockoutRemainingMs(user) {
  const until = user?.arenaLockedUntil || 0;
  return Math.max(0, until - Date.now());
}

function arenaLockoutError(user) {
  const remaining = arenaLockoutRemainingMs(user);
  if (remaining <= 0) return null;
  const mins = Math.max(1, Math.ceil(remaining / 60000));
  const err = new Error(`You left recent Arena matches early — try again in ${mins} minute${mins === 1 ? '' : 's'}.`);
  err.code = 'arena/locked-out';
  return err;
}

/**
 * How much EIQ the winner gains and the loser loses for one decisive Arena
 * match, Elo-style: gain scales with how "expected" the win was given both
 * players' EIQ going in — beating someone far below you nets almost
 * nothing, upsetting someone far above you nets a lot. This makes farming a
 * low-ranked opponent (e.g. a cooperating friend) self-defeating instead of
 * profitable: the old formula ignored the opponent's rank entirely and
 * actually paid MORE for a lopsided blowout, which is exactly the shape
 * that made repeatedly beating a weak opponent worthwhile.
 *
 * Score margin still nudges the swing a little (a squeaker matters less
 * than a rout), but only as a minor secondary factor now — it can't
 * dominate the way it used to, so it can't reopen the farming loophole on
 * its own. Returns a positive integer.
 */
export function eiqSwing(drillSlug, winnerScore, loserScore, winnerEiq = DEFAULT_EIQ, loserEiq = DEFAULT_EIQ) {
  const drill = DUEL_DRILLS.find((d) => d.slug === drillSlug);
  const hardness = drill?.hardness ?? 1.0;
  const w = isPlausibleScore(winnerScore) ? winnerScore : 0;
  const l = isPlausibleScore(loserScore) ? loserScore : 0;
  const total = w + l;
  const margin = total > 0 ? Math.abs(w - l) / total : 0; // 0 (tied) → ~1 (blowout)
  const marginFactor = 0.85 + margin * 0.3;               // 0.85 → ~1.15, minor nudge only

  const expectedWinnerScore = 1 / (1 + Math.pow(10, (loserEiq - winnerEiq) / RATING_SPREAD));
  const upsetFactor = Math.max(MIN_UPSET_FACTOR, 1 - expectedWinnerScore);

  return Math.max(1, Math.round(BASE_EIQ_STAKE * hardness * marginFactor * upsetFactor));
}

// EIQ rank tiers — now purely cosmetic badges (Bronze → Diamond) keyed to a
// player's total accumulated EIQ. In-match difficulty is no longer set from a
// fixed tier; each drill ramps its own difficulty from the live score (see
// each drill's updateDifficulty), so these thresholds only drive the rank
// badge shown on the leaderboard and result screen.
export const EIQ_TIERS = [
  { id: 'bronze',   name: 'Bronze',   minEiq: 0 },
  { id: 'silver',   name: 'Silver',   minEiq: 400 },
  { id: 'gold',     name: 'Gold',     minEiq: 1200 },
  { id: 'platinum', name: 'Platinum', minEiq: 2800 },
  { id: 'diamond',  name: 'Diamond',  minEiq: 5500 },
];

/** Which EIQ rank tier a given total EIQ maps to. */
export function tierForEiq(eiq) {
  let tier = EIQ_TIERS[0];
  for (const t of EIQ_TIERS) {
    if ((eiq ?? DEFAULT_EIQ) >= t.minEiq) tier = t;
  }
  return tier;
}

/**
 * Send a live challenge invite to another online player.
 * @param {object} [options]
 * @param {boolean} [options.matchmaking] — true when this invite was created
 * automatically by the matchmaking queue rather than a manual player pick,
 * so the matched (waiting) client can tell it apart from a real friend invite.
 */
export async function sendChallenge(fromUser, toUser, drillSlug, drillName, options = {}) {
  const lockoutErr = arenaLockoutError(fromUser);
  if (lockoutErr) throw lockoutErr;

  const firebase = initFirebase();
  if (!firebase) return null;
  const { db } = firebase;

  try {
    const challengeData = {
      fromUid: fromUser.uid,
      fromName: fromUser.displayName || 'Anonymous Player',
      fromPhoto: fromUser.photoURL || '',
      toUid: toUser.uid,
      toName: toUser.displayName || 'Anonymous Player',
      toPhoto: toUser.photoURL || '',
      drillSlug: drillSlug,
      drillName: drillName || 'Reaction Speed Duel',
      status: 'pending',
      fromScore: null,
      toScore: null,
      winner: null,
      matchmaking: !!options.matchmaking,
      // Cosmetic rank badge stamped from the challenger's EIQ tier at match
      // creation. In-match difficulty ramps from each player's live score
      // instead (see each drill's updateDifficulty), so this no longer drives
      // gameplay — only the badge shown on the result screen. See EIQ_TIERS.
      difficultyTier: tierForEiq(fromUser.eiq).id,
      createdAt: serverTimestamp(),
      startTime: null
    };

    const docRef = await addDoc(collection(db, 'challenges'), challengeData);
    return docRef.id;
  } catch (error) {
    console.error("Failed to send challenge:", error);
    throw error;
  }
}

/**
 * Accept an incoming challenge
 */
export async function acceptChallenge(challengeId, acceptingUser) {
  const lockoutErr = arenaLockoutError(acceptingUser);
  if (lockoutErr) throw lockoutErr;

  const firebase = initFirebase();
  if (!firebase) return;
  const { db } = firebase;

  try {
    const challengeRef = doc(db, 'challenges', challengeId);
    const updates = {
      status: 'accepted',
      startTime: serverTimestamp()
    };

    if (acceptingUser) {
      updates.toUid = acceptingUser.uid;
      updates.toName = acceptingUser.displayName || 'Anonymous Player';
      updates.toPhoto = acceptingUser.photoURL || '';
    }

    await updateDoc(challengeRef, updates);
  } catch (error) {
    console.error("Failed to accept challenge:", error);
    throw error;
  }
}

/**
 * Decline (or cancel a sent) challenge. Marks the doc 'declined' rather than
 * deleting it outright — ChallengeStatusToast, DrillWrapper, and
 * ChallengeArenaClient all watch the sender's own outgoing challenge for a
 * transition to status:'declined' so they can notify the sender / close
 * their waiting modal. Deleting immediately (the old behavior) meant that
 * transition never happened — the doc just vanished from the query results,
 * so the sender's listener saw nothing and their "waiting for response" UI
 * hung forever. Declined docs have no lasting value, so they're still swept
 * up shortly after by cleanupStaleChallenges (see STALE_CHALLENGE_MS) —
 * this just delays the deletion long enough for the status transition to
 * actually be observed.
 */
export async function declineChallenge(challengeId) {
  const firebase = initFirebase();
  if (!firebase) return;
  const { db } = firebase;

  try {
    await updateDoc(doc(db, 'challenges', challengeId), { status: 'declined' });
  } catch (error) {
    console.error("Failed to decline challenge:", error);
    throw error;
  }
}

/**
 * Delete any of this user's (or the global pool's) challenge documents that
 * are still 'pending' or 'accepted' — i.e. nobody ever started the match —
 * and are older than STALE_CHALLENGE_MS. Safe to call opportunistically;
 * never touches 'playing' (a match may genuinely be in progress) or
 * 'completed' (real duel history shown on the Results tab).
 */
export async function cleanupStaleChallenges(uid) {
  const firebase = initFirebase();
  if (!firebase || !uid) return;
  const { db } = firebase;

  try {
    const cutoff = Date.now() - STALE_CHALLENGE_MS;
    // 'declined' included so decline notices (see declineChallenge — marked
    // rather than deleted, so the sender's listener can observe the
    // transition) don't sit in Firestore forever once they've served their
    // purpose.
    // Bounded read. This runs every time anyone opens the Arena, and without a
    // limit it pulled down EVERY unfinished challenge in the collection — so
    // the cost of opening the Arena grew with the total number of players and
    // lobbies live at that moment, for what is only opportunistic housekeeping.
    // A capped slice per visit still clears the backlog across visits, since
    // whatever it misses is picked up by the next one.
    const q = query(
      collection(db, 'challenges'),
      where('status', 'in', ['pending', 'accepted', 'declined']),
      limit(60)
    );
    const snap = await getDocs(q);

    const deletions = [];
    snap.forEach((docSnap) => {
      const data = docSnap.data();
      const involvesUser = data.fromUid === uid || data.toUid === uid || data.toUid === 'global';
      if (!involvesUser) return;

      const createdMs = data.createdAt?.toMillis ? data.createdAt.toMillis() : 0;
      if (createdMs && createdMs < cutoff) {
        deletions.push(deleteDoc(docSnap.ref).catch(() => {}));
      }
    });

    await Promise.all(deletions);
  } catch (error) {
    console.error("Stale challenge cleanup failed:", error);
  }
}

/**
 * Shared match-completion step, run INSIDE an existing Firestore transaction:
 * decide the winner from the two final scores, move both players' EIQ and
 * win/loss/streak, and stamp everything onto the challenge doc.
 *
 * Used by every ending a match can have — submitScore (both players reported),
 * forfeitMatch (someone walked out mid-duel), and resolveAbandonedMatch (an
 * opponent who never reported at all). Kept in one place so those paths can't
 * drift apart on how EIQ is calculated. Mutates and returns `updates` for the
 * caller to write.
 *
 * `forcedWinnerUid` overrides the score comparison — that's how a forfeit is
 * expressed: whoever walked out loses regardless of what the scoreboard said.
 *
 * Firestore requires every read in a transaction to happen before any write,
 * which is why this reads both user docs itself and leaves all the writing to
 * the caller.
 */
async function completeMatchInTx(tx, db, data, fromScore, toScore, updates, forcedWinnerUid = null) {
  let winnerUid;
  if (forcedWinnerUid) {
    winnerUid = forcedWinnerUid;
  } else if (fromScore > toScore) {
    winnerUid = data.fromUid;
  } else if (toScore > fromScore) {
    winnerUid = data.toUid;
  } else {
    winnerUid = 'draw';
  }
  updates.status = 'completed';
  updates.winner = winnerUid;
  updates.fromScore = fromScore;
  updates.toScore = toScore;

  const fromRef = doc(db, 'users', data.fromUid);
  const toRef = doc(db, 'users', data.toUid);
  const [fromSnap, toSnap] = await Promise.all([tx.get(fromRef), tx.get(toRef)]);
  if (!fromSnap.exists() || !toSnap.exists()) return updates;

  const fromData = fromSnap.data();
  const toData = toSnap.data();
  const fromEiq = fromData.eiq || DEFAULT_EIQ;
  const toEiq = toData.eiq || DEFAULT_EIQ;
  const isForfeit = !!forcedWinnerUid;

  // Signed EIQ change for each player: +swing to the winner, −swing to the
  // loser, 0 to both on a draw. New totals are floored at 0, and the STAMPED
  // delta reflects the real change after flooring (so a loser at 5 EIQ who
  // "loses 30" shows −5, not −30).
  let fromDelta = 0;
  let toDelta = 0;
  if (winnerUid !== 'draw') {
    const winnerScore = winnerUid === data.fromUid ? fromScore : toScore;
    const loserScore = winnerUid === data.fromUid ? toScore : fromScore;
    const winnerEiqBefore = winnerUid === data.fromUid ? fromEiq : toEiq;
    const loserEiqBefore = winnerUid === data.fromUid ? toEiq : fromEiq;
    const fullSwing = eiqSwing(data.drillSlug, winnerScore, loserScore, winnerEiqBefore, loserEiqBefore);
    // A forfeit win is capped low for the winner (see FORFEIT_WINNER_EIQ_CAP)
    // — but the quitter still loses the FULL swing below. That asymmetry is
    // deliberate: it keeps forfeiting a real cost for the quitter while
    // making it worthless as a way to hand the other side a big rank boost.
    const winnerGain = isForfeit ? Math.min(fullSwing, FORFEIT_WINNER_EIQ_CAP) : fullSwing;
    if (winnerUid === data.fromUid) {
      fromDelta = winnerGain;
      toDelta = -Math.min(fullSwing, toEiq);
    } else {
      toDelta = winnerGain;
      fromDelta = -Math.min(fullSwing, fromEiq);
    }
  }
  const fromUpdates = { eiq: Math.max(0, fromEiq + fromDelta) };
  const toUpdates = { eiq: Math.max(0, toEiq + toDelta) };

  // Stamp each player's EIQ change + new total onto the challenge doc so the
  // duel result screen can show "+34 EIQ" / "−34 EIQ" and the new total
  // without another Firestore read.
  updates.fromEiqGained = fromDelta;
  updates.toEiqGained = toDelta;
  updates.fromEiqAfter = fromUpdates.eiq;
  updates.toEiqAfter = toUpdates.eiq;

  if (winnerUid === data.fromUid) {
    fromUpdates.wins = (fromData.wins || 0) + 1;
    fromUpdates.streak = (fromData.streak || 0) + 1;
    toUpdates.losses = (toData.losses || 0) + 1;
    toUpdates.streak = 0;
  } else if (winnerUid === data.toUid) {
    toUpdates.wins = (toData.wins || 0) + 1;
    toUpdates.streak = (toData.streak || 0) + 1;
    fromUpdates.losses = (fromData.losses || 0) + 1;
    fromUpdates.streak = 0;
  }

  // Forfeit-streak escalation (see the constants above). A genuinely
  // completed match — including one settled the moment someone forfeited it,
  // for the player who DIDN'T quit — resets that player's own streak, since
  // this only punishes an unbroken run of quits. The quitter's streak bumps
  // by one and their lockout is set (or escalated past
  // FORFEIT_ESCALATION_STREAK).
  if (isForfeit) {
    const quitterIsFrom = forcedWinnerUid !== data.fromUid;
    const quitterData = quitterIsFrom ? fromData : toData;
    const quitterUpdates = quitterIsFrom ? fromUpdates : toUpdates;
    const stayedUpdates = quitterIsFrom ? toUpdates : fromUpdates;

    const newStreak = (quitterData.forfeitStreak || 0) + 1;
    const lockoutMs = newStreak >= FORFEIT_ESCALATION_STREAK ? FORFEIT_LOCKOUT_ESCALATED_MS : FORFEIT_LOCKOUT_BASE_MS;
    quitterUpdates.forfeitStreak = newStreak;
    quitterUpdates.arenaLockedUntil = Date.now() + lockoutMs;
    stayedUpdates.forfeitStreak = 0;
  } else {
    fromUpdates.forfeitStreak = 0;
    toUpdates.forfeitStreak = 0;
  }

  tx.update(fromRef, fromUpdates);
  tx.update(toRef, toUpdates);
  return updates;
}

/**
 * Walking out of a live duel forfeits it: the player who left LOSES, the player
 * who stayed WINS, and EIQ moves accordingly — regardless of what the scoreboard
 * said at the moment they left.
 *
 * This is the deliberate rule (matching how ranked play works everywhere else):
 * quitting is not an escape hatch. An earlier version resolved these matches by
 * comparing the two last-synced scores, which meant a player who was ahead could
 * bail out and still bank the win, denying their opponent the match — the exact
 * behaviour this prevents.
 *
 * Called by the leaving client itself, so resolution is immediate rather than
 * making the other player wait out the grace timer. If this never runs (app
 * killed outright, connection lost), the opponent's own
 * resolveAbandonedMatch below reaches the same verdict a few seconds later.
 *
 * Only forfeits a match that is actually in progress — backing out of the lobby
 * before anyone has played stakes nothing and is handled as a plain decline.
 */
export async function forfeitMatch(challengeId, uid) {
  const firebase = initFirebase();
  if (!firebase || !challengeId || !uid) return;
  const { db } = firebase;
  const challengeRef = doc(db, 'challenges', challengeId);

  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(challengeRef);
      if (!snap.exists()) return;
      const data = snap.data();
      if (data.status !== 'playing') return;
      if (data.fromUid !== uid && data.toUid !== uid) return;

      const opponentUid = data.fromUid === uid ? data.toUid : data.fromUid;
      if (!opponentUid || opponentUid === 'global') return;

      // Real scores are kept for an honest history row; the winner is forced.
      const fromScore = isPlausibleScore(data.fromScore) ? data.fromScore : 0;
      const toScore = isPlausibleScore(data.toScore) ? data.toScore : 0;

      const updates = { abandoned: true, forfeitedBy: uid };
      await completeMatchInTx(tx, db, data, fromScore, toScore, updates, opponentUid);
      tx.update(challengeRef, updates);
    });
  } catch (error) {
    console.error('Failed to forfeit match:', error);
  }
}

/**
 * Settle a match whose opponent never reported a final score — they killed the
 * app, lost connection, or otherwise vanished without forfeitMatch running.
 *
 * Without this the match sits on status:'playing' forever: submitScore only
 * completes a match once BOTH scores are present, so the player who did finish
 * was left staring at "Waiting for opponent to finish..." with no winner, no
 * EIQ, and no way out but the Android back gesture.
 *
 * The verdict matches forfeitMatch deliberately: the player who saw it through
 * WINS and the one who vanished LOSES, whatever the last-synced scores were.
 * Both exits have to reach the same answer or the outcome would depend on the
 * irrelevant detail of whether the quitter's client got a write out before it
 * died — and scoring it on last-synced values let a player quit while ahead to
 * deny their opponent the win.
 *
 * Requires the caller's own score to be in, so this can't be used to end a
 * match early.
 */
export async function resolveAbandonedMatch(challengeId, uid) {
  const firebase = initFirebase();
  if (!firebase || !challengeId || !uid) return;
  const { db } = firebase;
  const challengeRef = doc(db, 'challenges', challengeId);

  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(challengeRef);
      if (!snap.exists()) return;
      const data = snap.data();
      // Already resolved (the opponent's own submit or forfeit landed while we
      // waited), or never actually started — nothing to rescue either way.
      if (data.status !== 'playing') return;
      if (data.fromUid !== uid && data.toUid !== uid) return;

      const isHost = data.fromUid === uid;
      const ownScore = isHost ? data.fromScore : data.toScore;
      if (ownScore === null || ownScore === undefined) return;

      const opponentUid = isHost ? data.toUid : data.fromUid;
      if (!opponentUid || opponentUid === 'global') return;

      const fromScore = isPlausibleScore(data.fromScore) ? data.fromScore : 0;
      const toScore = isPlausibleScore(data.toScore) ? data.toScore : 0;

      // The caller finished the match; the absent player forfeits it.
      const updates = { abandoned: true, forfeitedBy: opponentUid };
      await completeMatchInTx(tx, db, data, fromScore, toScore, updates, uid);
      tx.update(challengeRef, updates);
    });
  } catch (error) {
    console.error('Failed to resolve abandoned match:', error);
  }
}

/**
 * Submit user score and determine winner if both scores are ready.
 *
 * Both duelists' clocks are synced to the same matchStartAt and run a fixed
 * 30s, so both clients call this within milliseconds of each other at match
 * end. A plain read-then-write here used to race: both clients could read
 * the challenge doc before either write landed, each seeing the other's
 * score as still absent, and NEITHER would ever run the "both scores in ->
 * completed + EIQ" step — leaving the match stuck on 'playing' forever, both
 * players staring at "Waiting for opponent to finish...", no winner and no
 * EIQ change ever recorded. Wrapping the whole read-check-write (challenge
 * doc AND both players' user docs) in one Firestore transaction makes it
 * atomic: if two calls race, Firestore commits one and automatically retries
 * the other against the now-current data, so exactly one call ever performs
 * the completion + EIQ write, and it always sees the other player's score.
 */
export async function submitScore(challengeId, uid, score) {
  const firebase = initFirebase();
  if (!firebase) return;
  const { db } = firebase;

  if (!isPlausibleScore(score)) {
    console.error("Rejected implausible challenge score:", score);
    return;
  }

  const challengeRef = doc(db, 'challenges', challengeId);

  try {
    await runTransaction(db, async (tx) => {
      const challengeSnap = await tx.get(challengeRef);
      if (!challengeSnap.exists()) return;

      const data = challengeSnap.data();
      // Already resolved (e.g. this call is a stray retry) — nothing left to do.
      if (data.status === 'completed') return;

      const isHost = data.fromUid === uid;
      const updates = {};
      if (isHost) {
        updates.fromScore = score;
      } else {
        updates.toScore = score;
      }

      // Check if both scores are now present
      const updatedFromScore = isHost ? score : data.fromScore;
      const updatedToScore = isHost ? data.toScore : score;
      const bothIn = updatedFromScore !== null && updatedFromScore !== undefined
        && updatedToScore !== null && updatedToScore !== undefined;

      if (!bothIn) {
        tx.update(challengeRef, updates);
        return;
      }

      // Both submitted — decide the winner and move both players' EIQ and
      // win/loss/streak. EIQ is a competitive ladder: the winner GAINS a
      // swing and the loser LOSES the same swing (see eiqSwing — sized by
      // drill hardness, score margin, and how expected the result was),
      // floored so no one drops below 0. A draw moves no EIQ.
      await completeMatchInTx(tx, db, data, updatedFromScore, updatedToScore, updates);

      tx.update(challengeRef, updates);
    });
  } catch (error) {
    console.error("Failed to submit score:", error);
    throw error;
  }
}

/**
 * Send a public challenge invite to the global matching pool
 */
export async function sendGlobalChallenge(fromUser, drillSlug, drillName) {
  const lockoutErr = arenaLockoutError(fromUser);
  if (lockoutErr) throw lockoutErr;

  const firebase = initFirebase();
  if (!firebase) return null;
  const { db } = firebase;

  try {
    const challengeData = {
      fromUid: fromUser.uid,
      fromName: fromUser.displayName || 'Anonymous Player',
      fromPhoto: fromUser.photoURL || '',
      toUid: 'global',
      toName: 'Global Arena Pool',
      toPhoto: '',
      drillSlug: drillSlug,
      drillName: drillName || 'Reaction Speed Duel',
      status: 'pending',
      fromScore: null,
      toScore: null,
      winner: null,
      difficultyTier: tierForEiq(fromUser.eiq).id,
      createdAt: serverTimestamp(),
      startTime: null
    };

    const docRef = await addDoc(collection(db, 'challenges'), challengeData);
    return docRef.id;
  } catch (error) {
    console.error("Failed to send global challenge:", error);
    throw error;
  }
}

// How close in EIQ a match has to be, and how fresh a queue entry has to be
// to still count as "actively searching right now" rather than an abandoned
// leftover. The EIQ window WIDENS the longer a player has been searching
// (standard ranked-queue behavior): a tight window first so matches feel
// fair, then progressively looser so nobody waits forever in a small pool.
const MATCHMAKING_EIQ_RANGE = 300;
const MATCHMAKING_FRESHNESS_MS = 45 * 1000;

/** EIQ window for a search that has been running `elapsedSeconds`. */
export function matchmakingEiqRange(elapsedSeconds) {
  if (elapsedSeconds < 15) return MATCHMAKING_EIQ_RANGE;       // ±300 — fair match
  if (elapsedSeconds < 30) return MATCHMAKING_EIQ_RANGE * 2.5; // ±750 — looser
  return 1000000;                                              // anyone searching
}

/**
 * Join the automated matchmaking queue for a specific drill. One document
 * per user (doc id == uid) — searching again just overwrites your previous
 * entry, so the collection can never grow past one row per user who has
 * ever searched, regardless of how many searches they run.
 */
export async function joinMatchmakingQueue(user, drillSlug, drillName) {
  const lockoutErr = arenaLockoutError(user);
  if (lockoutErr) throw lockoutErr;

  const firebase = initFirebase();
  if (!firebase) return;
  const { db } = firebase;

  await setDoc(doc(db, 'matchmaking_queue', user.uid), {
    uid: user.uid,
    displayName: user.displayName || 'Anonymous Player',
    photoURL: user.photoURL || '',
    eiq: user.eiq || DEFAULT_EIQ,
    drillSlug,
    drillName: drillName || 'Reaction Speed Duel',
    createdAt: serverTimestamp(),
  });
}

/**
 * Keep an in-progress search visible to other players.
 *
 * scanForMatch treats any queue entry older than MATCHMAKING_FRESHNESS_MS (45s)
 * as an abandoned leftover and skips it — but a search runs for 60s, and the
 * entry's timestamp was only ever written once at join. So from 45s onward a
 * player was invisible to everyone else's scans while their own UI still said
 * "Finding an Opponent", and whether they could still be paired came down to
 * the arbitrary uid comparison that decides who initiates. Worse, that dead
 * window was the last 15s — exactly when the EIQ range has widened to "anyone
 * searching" and a match is most likely.
 *
 * Heartbeating the timestamp keeps a live search fresh while still letting a
 * genuinely abandoned entry (app closed mid-search) age out on its own.
 */
export async function refreshMatchmakingQueue(uid) {
  const firebase = initFirebase();
  if (!firebase || !uid) return;
  const { db } = firebase;
  try {
    await setDoc(doc(db, 'matchmaking_queue', uid), { createdAt: serverTimestamp() }, { merge: true });
  } catch (err) {
    console.error('Failed to refresh matchmaking queue entry:', err);
  }
}

/** Leave the matchmaking queue (cancel search, or clean up after a match is found). */
export async function leaveMatchmakingQueue(uid) {
  const firebase = initFirebase();
  if (!firebase || !uid) return;
  const { db } = firebase;
  try {
    await deleteDoc(doc(db, 'matchmaking_queue', uid));
  } catch (err) {
    console.error("Failed to leave matchmaking queue:", err);
  }
}

/**
 * One-shot scan for the closest compatible opponent currently searching for
 * the same drill. Returns that queue entry, or null. Doesn't create a
 * challenge itself — the caller decides whether to initiate (see
 * ChallengeArenaClient's matchmaking flow: only the lexicographically-lower
 * uid of the pair sends the challenge, so two clients that spot each other
 * at the same time can't both create a duplicate match).
 */
export async function scanForMatch(user, drillSlug, eiqRange = MATCHMAKING_EIQ_RANGE) {
  const firebase = initFirebase();
  if (!firebase) return null;
  const { db } = firebase;

  try {
    const q = query(
      collection(db, 'matchmaking_queue'),
      where('drillSlug', '==', drillSlug),
      limit(25)
    );
    const snap = await getDocs(q);

    const myEiq = user.eiq || DEFAULT_EIQ;
    const cutoff = Date.now() - MATCHMAKING_FRESHNESS_MS;
    let best = null;
    let bestDiff = Infinity;

    snap.forEach((docSnap) => {
      const candidate = docSnap.data();
      if (candidate.uid === user.uid) return;

      const createdMs = candidate.createdAt?.toMillis ? candidate.createdAt.toMillis() : 0;
      if (!createdMs || createdMs < cutoff) return;

      const diff = Math.abs((candidate.eiq || DEFAULT_EIQ) - myEiq);
      if (diff <= eiqRange && diff < bestDiff) {
        best = candidate;
        bestDiff = diff;
      }
    });

    return best;
  } catch (err) {
    console.error("Matchmaking scan failed:", err);
    return null;
  }
}

/**
 * Subscribe to the pending duel invites addressed to this specific user.
 *
 * Scoped on the SERVER to `toUid == uid`. It used to query every pending
 * challenge in the collection and narrow it down on the client, with a note
 * claiming that avoided needing a composite index — but that reasoning was
 * wrong. Firestore serves multiple equality filters by merging single-field
 * indexes; it's only an equality filter combined with an orderBy on a
 * DIFFERENT field (or a range filter) that needs a composite index. So the
 * broad query bought nothing and cost a great deal:
 *
 *  - every signed-in player streamed, and was billed reads for, every pending
 *    invite anywhere in the app, and
 *  - any other player's invite activity woke this listener, pushed a new value
 *    through ChallengeContext, and re-rendered its consumers — including
 *    DrillWrapper, in the middle of an unrelated duel. The more pairs playing
 *    at once, the more often that happened.
 *
 * Narrowing the query fixes both at the source: other players' invites now
 * never reach this client at all, so there is nothing to filter and no snapshot
 * to react to. The global open-lobby posts the old query also collected were
 * being discarded by the only caller (ChallengeContext keeps just this user's
 * direct invites), so nothing is lost — ChallengeArenaClient has its own
 * separate listener for browsing the open lobby.
 */
export function listenForIncomingChallenges(uid, callback) {
  const firebase = initFirebase();
  if (!firebase) return () => {};
  const { db } = firebase;

  const q = query(
    collection(db, 'challenges'),
    where('toUid', '==', uid),
    where('status', '==', 'pending')
  );

  return onSnapshot(q, (snapshot) => {
    const challenges = [];
    snapshot.forEach((docSnap) => {
      challenges.push({ id: docSnap.id, ...docSnap.data() });
    });

    // Sort client-side (newest first) — ordering on the server here WOULD need
    // a composite index, and the result set is tiny.
    challenges.sort((a, b) => {
      const timeA = a.createdAt?.seconds || 0;
      const timeB = b.createdAt?.seconds || 0;
      return timeB - timeA;
    });

    callback(challenges);
  }, (error) => {
    console.error("Error listening for incoming challenges:", error);
  });
}
