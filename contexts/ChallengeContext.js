'use client';

// contexts/ChallengeContext.js
// SkillDrills Pro — single source of truth for Arena duel notifications.
//
// Two things were previously duplicated across components, causing
// competing/inconsistent notification UI:
//  1. Incoming-invite listening (ChallengeNotificationBanner + HomePageClient
//     each ran their own `listenForIncomingChallenges` and rendered their own
//     Accept/Decline card).
//  2. Outgoing-challenge status (whether a sender's own duel was accepted or
//     declined) was tracked as local component state keyed by a remembered
//     document id (ChallengeArenaClient, DrillWrapper) — lost the moment the
//     sender navigated away, refreshed, or backgrounded the app.
//
// This context owns exactly one Firestore listener in each direction, so
// notifications are consistent regardless of which screen the user is on.

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useAuth } from './AuthContext';
import { listenForIncomingChallenges, acceptChallenge, declineChallenge } from '../lib/challengeEngine';
import { collection, query, where, onSnapshot } from 'firebase/firestore';
import { ARENA_ENABLED } from '../lib/featureFlags';

const ChallengeContext = createContext(null);

export function ChallengeProvider({ children }) {
  const { user, db } = useAuth();
  const [incomingChallenges, setIncomingChallenges] = useState([]);
  const [outgoingChallenge, setOutgoingChallenge] = useState(null);

  // Personal direct invites only. Global open-lobby posts are intentionally
  // excluded here — those are for browsing in the Arena's Players tab, not an
  // interruptive popup for every other online user.
  //
  // Gated behind ARENA_ENABLED like every other Arena entry point (see
  // lib/featureFlags.js) — this Provider is mounted globally on every page,
  // including mid-drill, so without this guard these two Firestore realtime
  // listeners would keep running for every signed-in user even while Arena
  // is switched off, which was the actual source of the extra background
  // CPU/battery draw on phones.
  useEffect(() => {
    if (!ARENA_ENABLED || !user || !db) {
      setIncomingChallenges([]);
      return;
    }
    const unsubscribe = listenForIncomingChallenges(user.uid, (mine) => {
      // Only push a new array when the set of invites actually changed.
      //
      // The listener is now scoped server-side to this user's own invites, so
      // unrelated players' activity no longer reaches here at all — this guard
      // is the second layer: it keeps the array reference stable if the same
      // set is ever re-delivered (a reconnect, a metadata-only snapshot), which
      // otherwise re-renders every consumer of this Context, DrillWrapper
      // included, in the middle of a duel.
      //
      // Comparing ids is sufficient: the query is pinned to status == 'pending'
      // and a pending doc's other fields never change — accepting or declining
      // flips the status, which drops it out of the result set. Docs only ever
      // enter or leave.
      setIncomingChallenges((prev) => {
        if (prev.length === mine.length && prev.every((c, i) => c.id === mine[i].id)) return prev;
        return mine;
      });
    });
    return () => unsubscribe();
  }, [user, db]);

  // This user's own most recent sent challenge, live. Scoped server-side to
  // `fromUid` + the transient statuses this actually cares about — it used to
  // query every challenge this user had EVER sent with no status filter at
  // all, relying purely on a client-side filter below to ignore the
  // long-since-`completed`/`playing` ones. That result set only grows for the
  // life of the account, and this Provider is mounted globally on every page,
  // so every match ever played became permanent extra Firestore read cost +
  // main-thread iteration work on every single snapshot, forever. `status`
  // still transitions in place (accept/decline flips it without deleting the
  // doc), so a doc simply drops out of this filtered result set once it's no
  // longer pending/accepted/declined — exactly the same "observed as an
  // update" behavior as before, just without dragging the user's whole match
  // history along for the ride.
  useEffect(() => {
    if (!ARENA_ENABLED || !user || !db) {
      setOutgoingChallenge(null);
      return;
    }
    const q = query(
      collection(db, 'challenges'),
      where('fromUid', '==', user.uid),
      where('status', 'in', ['pending', 'accepted', 'declined'])
    );
    const unsubscribe = onSnapshot(q, (snapshot) => {
      let latest = null;
      snapshot.forEach((docSnap) => {
        const data = { id: docSnap.id, ...docSnap.data() };
        if (!latest || (data.createdAt?.seconds || 0) > (latest.createdAt?.seconds || 0)) latest = data;
      });
      // Every consumer of this value (ChallengeStatusToast, DrillWrapper,
      // ChallengeArenaClient) only reacts to `id`/`status` transitions. This
      // same doc also receives a live opponent-score write roughly every
      // 800ms for the whole duration of any match this user is hosting
      // (DrillWrapper's own score sync) — without this guard, every one of
      // those score ticks would re-create `latest` and push a fresh object
      // through this Context, re-rendering every consumer for a change
      // nobody downstream actually cares about. Bailing out when id/status
      // haven't moved keeps the object reference stable across those ticks.
      setOutgoingChallenge((prev) => {
        if (prev === latest) return prev;
        if (prev && latest && prev.id === latest.id && prev.status === latest.status) return prev;
        return latest;
      });
    }, (error) => console.error('Outgoing challenge listener error:', error));
    return () => unsubscribe();
  }, [user, db]);

  // Memoized so the two guards above actually pay off. A fresh object literal
  // here would re-render every consumer on ANY provider render regardless of
  // whether the values inside changed, which defeats the whole point of keeping
  // `incomingChallenges` and `outgoingChallenge` referentially stable.
  // acceptChallenge/declineChallenge are module-level imports, so they're
  // already stable.
  const value = useMemo(
    () => ({ incomingChallenges, outgoingChallenge, acceptChallenge, declineChallenge }),
    [incomingChallenges, outgoingChallenge]
  );
  return <ChallengeContext.Provider value={value}>{children}</ChallengeContext.Provider>;
}

export function useChallenge() {
  const ctx = useContext(ChallengeContext);
  if (!ctx) throw new Error('useChallenge must be used within a ChallengeProvider');
  return ctx;
}
