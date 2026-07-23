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
  onSnapshot,
  query,
  where,
  limit,
  getDocs,
  getDoc,
  serverTimestamp
} from 'firebase/firestore';

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

    // matchStartAt is written once, at the start of the match, and never
    // changes again — so this listener has nothing left to do once it's
    // captured that value. Unsubscribing immediately (instead of staying
    // open for the rest of the match) avoids running a second, redundant
    // live subscription on top of DrillWrapper's own listener on this same
    // doc for the whole duel.
    const unsubscribe = onSnapshot(doc(firebase.db, 'challenges', challengeId), (snap) => {
      const data = snap.data();
      if (data?.matchStartAt) {
        setMatchStartAt(data.matchStartAt);
        unsubscribe();
      }
    });
    return () => unsubscribe();
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
 * Decline (or cancel a sent) challenge. Declined/cancelled invites have no
 * lasting value — delete the document instead of leaving a permanent
 * "declined" record sitting in Firestore.
 */
export async function declineChallenge(challengeId) {
  const firebase = initFirebase();
  if (!firebase) return;
  const { db } = firebase;

  try {
    await deleteDoc(doc(db, 'challenges', challengeId));
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
    const q = query(collection(db, 'challenges'), where('status', 'in', ['pending', 'accepted']));
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
 * Submit user score and determine winner if both scores are ready
 */
export async function submitScore(challengeId, uid, score) {
  const firebase = initFirebase();
  if (!firebase) return;
  const { db } = firebase;

  if (!isPlausibleScore(score)) {
    console.error("Rejected implausible challenge score:", score);
    return;
  }

  try {
    const challengeRef = doc(db, 'challenges', challengeId);
    const challengeSnap = await getDoc(challengeRef);
    if (!challengeSnap.exists()) return;

    const data = challengeSnap.data();
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

    if (updatedFromScore !== null && updatedToScore !== null) {
      // Both submitted! Set status to completed and calculate winner
      updates.status = 'completed';
      
      let winnerUid = null;
      if (updatedFromScore > updatedToScore) {
        winnerUid = data.fromUid;
      } else if (updatedToScore > updatedFromScore) {
        winnerUid = data.toUid;
      } else {
        winnerUid = 'draw';
      }
      
      updates.winner = winnerUid;

      // Update win/loss/streak/EIQ for both players. EIQ is a competitive
      // ladder: the winner GAINS a swing and the loser LOSES the same swing
      // (see eiqSwing — sized by drill hardness × score margin), floored so no
      // one drops below 0. A draw moves no EIQ. wins/losses/streak move only
      // on a decisive result.
      try {
        const fromRef = doc(db, 'users', data.fromUid);
        const toRef = doc(db, 'users', data.toUid);
        const [fromSnap, toSnap] = await Promise.all([getDoc(fromRef), getDoc(toRef)]);

        if (fromSnap.exists() && toSnap.exists()) {
          const fromData = fromSnap.data();
          const toData = toSnap.data();
          const fromEiq = fromData.eiq || DEFAULT_EIQ;
          const toEiq = toData.eiq || DEFAULT_EIQ;

          // Signed EIQ change for each player: +swing to the winner, −swing to
          // the loser, 0 to both on a draw. New totals are floored at 0, and
          // the STAMPED delta reflects the real change after flooring (so a
          // loser at 5 EIQ who "loses 30" shows −5, not −30).
          let fromDelta = 0;
          let toDelta = 0;
          if (winnerUid !== 'draw') {
            const winnerScore = winnerUid === data.fromUid ? updatedFromScore : updatedToScore;
            const loserScore = winnerUid === data.fromUid ? updatedToScore : updatedFromScore;
            const winnerEiqBefore = winnerUid === data.fromUid ? fromEiq : toEiq;
            const loserEiqBefore = winnerUid === data.fromUid ? toEiq : fromEiq;
            const swing = eiqSwing(data.drillSlug, winnerScore, loserScore, winnerEiqBefore, loserEiqBefore);
            if (winnerUid === data.fromUid) {
              fromDelta = swing;
              toDelta = -Math.min(swing, toEiq);
            } else {
              toDelta = swing;
              fromDelta = -Math.min(swing, fromEiq);
            }
          }
          const fromUpdates = { eiq: Math.max(0, fromEiq + fromDelta) };
          const toUpdates = { eiq: Math.max(0, toEiq + toDelta) };

          // Stamp each player's EIQ change + new total onto the challenge doc
          // so the duel result screen can show "+34 EIQ" / "−34 EIQ" and the
          // new total without another Firestore read.
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

          await Promise.all([
            updateDoc(fromRef, fromUpdates),
            updateDoc(toRef, toUpdates),
          ]);
        }
      } catch (err) {
        console.error("Failed to update user challenge stats:", err);
      }
    }

    await updateDoc(challengeRef, updates);
  } catch (error) {
    console.error("Failed to submit score:", error);
    throw error;
  }
}

/**
 * Send a public challenge invite to the global matching pool
 */
export async function sendGlobalChallenge(fromUser, drillSlug, drillName) {
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
 * Subscribe to incoming challenges sent to the current user (includes global pool)
 */
export function listenForIncomingChallenges(uid, callback) {
  const firebase = initFirebase();
  if (!firebase) return () => {};
  const { db } = firebase;

  // Query only by status to avoid needing composite indexes on the server
  const q = query(
    collection(db, 'challenges'),
    where('status', '==', 'pending')
  );

  return onSnapshot(q, (snapshot) => {
    const challenges = [];
    snapshot.forEach((doc) => {
      const data = doc.data();
      // Only include targeted invites or global invites created by other players
      if (data.toUid === uid || (data.toUid === 'global' && data.fromUid !== uid)) {
        challenges.push({ id: doc.id, ...data });
      }
    });

    // Sort client-side by creation timestamp (newest first)
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
