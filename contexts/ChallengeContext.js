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

import { createContext, useContext, useEffect, useState } from 'react';
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
    const unsubscribe = listenForIncomingChallenges(user.uid, (challenges) => {
      setIncomingChallenges(challenges.filter(c => c.toUid === user.uid));
    });
    return () => unsubscribe();
  }, [user, db]);

  // This user's own most recent sent challenge, live. Queried by `fromUid`
  // only (no status filter) so a decline/accept transition is observed as an
  // update rather than the doc dropping out of the result set.
  useEffect(() => {
    if (!ARENA_ENABLED || !user || !db) {
      setOutgoingChallenge(null);
      return;
    }
    const q = query(collection(db, 'challenges'), where('fromUid', '==', user.uid));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      let latest = null;
      snapshot.forEach((docSnap) => {
        const data = { id: docSnap.id, ...docSnap.data() };
        if (!['pending', 'accepted', 'declined'].includes(data.status)) return;
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

  const value = { incomingChallenges, outgoingChallenge, acceptChallenge, declineChallenge };
  return <ChallengeContext.Provider value={value}>{children}</ChallengeContext.Provider>;
}

export function useChallenge() {
  const ctx = useContext(ChallengeContext);
  if (!ctx) throw new Error('useChallenge must be used within a ChallengeProvider');
  return ctx;
}
