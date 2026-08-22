'use client';

// app/challenge/ChallengeArenaClient.js
// SkillDrills Pro — Multiplayer Arena & Rankings Hub

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useChallenge } from '../../contexts/ChallengeContext';
import {
  sendChallenge, sendGlobalChallenge, acceptChallenge, declineChallenge, cleanupStaleChallenges,
  joinMatchmakingQueue, leaveMatchmakingQueue, refreshMatchmakingQueue, scanForMatch, matchmakingEiqRange,
  tierForEiq, DUEL_DRILLS, getServerClockOffset,
} from '../../lib/challengeEngine';
import { collection, query, where, onSnapshot, orderBy, limit, getDocs } from 'firebase/firestore';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { ARENA_ENABLED } from '../../lib/featureFlags';
import {
  Swords, Trophy, Mail, Users, Zap, Check,
  LogOut, Search, Target, Sparkles, Flame, Award,
  Trash2, MessageSquare, ShieldAlert, BarChart3, Clock, X
} from 'lucide-react';

// How long to wait for a matched opponent to accept before withdrawing the
// invite and dropping back to idle, and how recent an incoming matchmaking
// invite has to be to count as belonging to the search running right now.
const MATCH_ACCEPT_TIMEOUT_MS = 20 * 1000;
const MATCHMAKING_INVITE_MAX_AGE_MS = 90 * 1000;

// How often a running search re-scans the queue. Every scan is a batch of
// Firestore reads, and a 60-second search repeats it for the whole minute, so
// this was the single most expensive thing one player could do — and unlike
// the listeners above, the cost lands once per searching player rather than
// once per visit.
//
// Widening it barely affects how fast matches are found, because the poll
// interval is NOT what catches most matches. Whoever joins the queue second
// scans immediately on joining (attemptMatchmakingScan runs once before this
// interval is ever set up) and finds the player already waiting — so the
// common case is settled in one round trip regardless of this value. The
// interval only governs the narrower case of noticing someone who arrived
// while you were already waiting, and their own join-time scan catches that
// pairing anyway, from the other side.
const MATCHMAKING_POLL_MS = 8000;

// Firestore hands `createdAt` back as a Timestamp object, not a date string or
// a number — so `new Date(createdAt)` produces an Invalid Date. That silently
// broke two things here: every duel-history row rendered the literal text
// "Invalid Date", and both list sorts compared NaN against NaN (a comparator
// returning NaN leaves the order untouched, so newest-first never happened).
// A serverTimestamp() also reads back as null in the writer's own first local
// snapshot, before the server value round-trips — hence the null guard.
const tsToMillis = (ts) => {
  if (!ts) return 0;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (typeof ts.seconds === 'number') return ts.seconds * 1000;
  const parsed = new Date(ts).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
};

export default function ChallengeArenaClient() {
  const { user, db, signOut, deleteAccount } = useAuth();
  const { outgoingChallenge, incomingChallenges } = useChallenge();
  // AuthContext live-syncs the profile doc and hands back a NEW `user` object
  // on every write to it (presence, lastSeen, eiq after a duel). Effects that
  // open Firestore listeners key off this stable uid instead, so an unrelated
  // profile write can't tear a subscription down and make it re-read
  // everything from scratch.
  const uid = user?.uid;
  const router = useRouter();
  const searchParams = useSearchParams();

  const [activeTab, setActiveTab] = useState('players'); // 'players', 'invites', 'results', 'leaderboard'
  const [onlinePlayers, setOnlinePlayers] = useState([]);
  const [leaderboardUsers, setLeaderboardUsers] = useState([]);
  // Open-lobby posts from other players only. Direct invites addressed to this
  // user arrive separately via ChallengeContext; the two are merged into
  // `pendingInvites` below.
  const [globalInvites, setGlobalInvites] = useState([]);
  const [challengeHistory, setChallengeHistory] = useState([]);
  const [searchTerm, setSearchTerm] = useState('');
  
  // Challenge creation state
  const [selectedOpponent, setSelectedOpponent] = useState(null);
  const [isSending, setIsSending] = useState(false);
  const [sentChallengeId, setSentChallengeId] = useState(null);
  const [challengeStatusMessage, setChallengeStatusMessage] = useState('');
  const [hiddenGlobalInvites, setHiddenGlobalInvites] = useState([]);
  // Which drill to duel in is picked right before sending — { mode: 'direct', player } for
  // a friend invite, { mode: 'global' } for an open lobby post, or null when the picker is closed.
  const [duelPickerFor, setDuelPickerFor] = useState(null);

  // Automated matchmaking state
  const [matchmakingState, setMatchmakingState] = useState('idle'); // 'idle' | 'searching' | 'found'
  const [matchmakingDrill, setMatchmakingDrill] = useState(null);
  const [matchmakingSeconds, setMatchmakingSeconds] = useState(0);
  const matchmakingPollRef = useRef(null);
  const matchmakingTickRef = useRef(null);
  const matchmakingTimeoutRef = useRef(null);
  // Keeps this player's queue entry fresh for the whole search — see
  // refreshMatchmakingQueue.
  const matchmakingHeartbeatRef = useRef(null);
  // Elapsed search seconds, readable from inside the poll callback — drives
  // the widening EIQ search window (see matchmakingEiqRange).
  const matchmakingElapsedRef = useRef(0);

  // URL Tab Synchronizer
  useEffect(() => {
    // Navigating tabs closes the drill picker. It's a `fixed` overlay rendered
    // outside the tab content, so it used to follow the player from Arena onto
    // Ranks/Invites/Results and sit on top of a screen it has nothing to do
    // with — a tab tap clearly means "I'm done with this sheet".
    setDuelPickerFor(null);
    const tab = searchParams.get('tab');
    if (tab === 'leaderboard') {
      setActiveTab('leaderboard');
    } else if (tab === 'invites') {
      setActiveTab('invites');
    } else if (tab === 'results') {
      setActiveTab('results');
    } else {
      setActiveTab('players');
    }
  }, [searchParams]);

  // 0. Opportunistically clean up this user's own abandoned pending/accepted
  // challenge docs (invites nobody ever responded to, lobbies nobody ever
  // joined) so they don't accumulate in Firestore forever.
  //
  // Keyed on `uid`, not the whole `user` object: this effect costs a batch of
  // Firestore reads plus a delete every time it runs, and depending on `user`
  // meant it re-ran on every presence/lastSeen/eiq write to the profile doc —
  // repeating that cost many times per Arena visit instead of once, and
  // yanking a queue entry out from under an in-flight search.
  useEffect(() => {
    if (!ARENA_ENABLED || !db || !uid) return;
    cleanupStaleChallenges(uid);
    // Also clear any matchmaking queue entry left behind by a previous
    // session that was closed mid-search rather than cancelled cleanly.
    leaveMatchmakingQueue(uid);
  }, [db, uid]);

  // Measure this device's clock drift from the server now, while the player is
  // browsing the Arena — long before a duel needs it. See getServerClockOffset
  // (lib/challengeEngine.js): it costs a couple of Firestore round trips, and
  // putting it on the critical path of a duel's start would add that delay to
  // the countdown. This used to be prewarmed in AuthContext for every signed-in
  // user on every app open, which charged the whole userbase — including the
  // majority who never duel — for something only the Arena uses. The result is
  // cached at module scope, so this is a no-op after the first call.
  useEffect(() => {
    if (!ARENA_ENABLED || !uid) return;
    getServerClockOffset().catch(() => {});
  }, [uid]);

  // 1. Subscribe to online players list (excluding current user)
  useEffect(() => {
    if (!ARENA_ENABLED || !db || !user) return;

    // No orderBy on the server here, deliberately. Combining an equality filter
    // (`online == true`) with an orderBy on a DIFFERENT field (`lastSeen`)
    // requires a composite Firestore index, which this project doesn't define
    // anywhere — there's no firestore.indexes.json, so it would only exist if
    // someone had hand-created it in the console. Without it the query fails
    // outright with FAILED_PRECONDITION and the entire Online Players list
    // silently renders empty in production. Sorting the (already limited)
    // result set on the client needs no index and cannot break on deploy.
    const q = query(
      collection(db, 'users'),
      where('online', '==', true),
      limit(40)
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const players = [];
      snapshot.forEach((doc) => {
        const data = doc.data();
        if (data.uid !== user.uid) {
          players.push(data);
        }
      });
      players.sort((a, b) => tsToMillis(b.lastSeen) - tsToMillis(a.lastSeen));
      setOnlinePlayers(players);
    }, (error) => {
      console.error("Online players fetch failed:", error);
    });

    return () => unsubscribe();
  }, [db, user]);

  // 2. Subscribe to incoming invites
  useEffect(() => {
    if (!ARENA_ENABLED || !db || !user) return;

    // Open-lobby posts ONLY, and bounded.
    //
    // This used to subscribe to EVERY pending challenge in the app and pick
    // out the relevant ones on the phone, which made the cost of simply
    // sitting on the Arena screen scale with the total number of players
    // online: N viewers each streaming N lobby posts. At a few hundred
    // concurrent players that's tens of thousands of document reads per
    // refresh wave — enough to exhaust a day's Firestore quota in minutes and
    // take the whole Arena offline — and the same unbounded list had to be
    // held in React state and rendered on a low-end phone.
    //
    // Two equality filters are served by merging single-field indexes, so this
    // needs no composite index (same reasoning as the online-players query
    // above, and as listenForIncomingChallenges in lib/challengeEngine.js).
    //
    // Direct invites addressed to this user are NOT lost: ChallengeContext
    // already runs exactly one server-scoped `toUid == uid` listener for them,
    // and they're merged back in at `pendingInvites` below.
    const q = query(
      collection(db, 'challenges'),
      where('toUid', '==', 'global'),
      where('status', '==', 'pending'),
      limit(30)
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const posts = [];
      snapshot.forEach((docSnap) => {
        const data = docSnap.data();
        // Your own open lobby post isn't an invite to yourself.
        if (data.fromUid !== uid) posts.push({ id: docSnap.id, ...data });
      });
      setGlobalInvites(posts);
    }, (error) => {
      console.error("Invites subscription error:", error);
    });

    return () => unsubscribe();
    // Deliberately NOT keyed on hiddenGlobalInvites — dismissing someone
    // else's open-lobby post is a purely local "hide this from my inbox"
    // action, but having it in the dependency list tore down this Firestore
    // listener and opened a fresh one (re-reading every lobby post) on
    // every dismissal. The hidden ids are applied where they belong, at render
    // time, via visibleInvites below.
    //
    // Keyed on `uid`, not the whole `user` object, for the same reason the
    // matchmaking cleanup effect below is — see the note there. Depending on
    // `user` meant every presence/lastSeen/eiq write to the profile doc tore
    // this listener down and re-read the entire lobby from scratch.
  }, [db, uid]);

  // The Invites inbox: direct invites (ChallengeContext's own server-scoped
  // `toUid == uid` listener) plus the open-lobby posts above, newest first.
  // The two sources are disjoint by construction — `toUid == uid` versus
  // `toUid == 'global'` — so there's nothing to de-duplicate. Memoized so the
  // list keeps a stable identity across unrelated re-renders.
  const pendingInvites = useMemo(
    () => [...incomingChallenges, ...globalInvites]
      .sort((a, b) => tsToMillis(b.createdAt) - tsToMillis(a.createdAt)),
    [incomingChallenges, globalInvites]
  );

  // 3. Fetch leaderboard (Top 50 users by EIQ). One-shot fetch each time the
  // tab is opened — the old realtime listener kept a live subscription on 50
  // user docs and re-rendered on every profile write anywhere in the app, for
  // a list that only needs to be fresh when you actually look at it. Cheaper
  // for both CPU and Firestore reads.
  useEffect(() => {
    if (!ARENA_ENABLED || !db || activeTab !== 'leaderboard') return;
    let cancelled = false;
    (async () => {
      try {
        const snap = await getDocs(query(collection(db, 'users'), orderBy('eiq', 'desc'), limit(50)));
        if (cancelled) return;
        const users = [];
        snap.forEach((doc) => users.push(doc.data()));
        setLeaderboardUsers(users);
      } catch (error) {
        console.error('Leaderboard fetch error:', error);
      }
    })();
    return () => { cancelled = true; };
  }, [db, activeTab]);

  // 5. Fetch this user's duel history (Results tab).
  //
  // Two targeted queries — one for duels this user started, one for duels they
  // were invited to. It used to read 30 documents from the challenges
  // collection with NO `where` clause at all and filter them client-side,
  // which meant it was showing whichever arbitrary 30 duels Firestore happened
  // to return: once more than a handful of players exist, a user's own matches
  // usually aren't in that set, so Duel History rendered empty or missing
  // recent matches. It was also a live listener on 30 mostly-unrelated docs.
  //
  // Neither query needs a composite index (single equality filter, sorted
  // client-side). One-shot rather than realtime, matching the leaderboard tab —
  // history only has to be fresh when you actually open it.
  useEffect(() => {
    if (!ARENA_ENABLED || !db || !user || activeTab !== 'results') return;
    let cancelled = false;

    (async () => {
      try {
        const [fromSnap, toSnap] = await Promise.all([
          getDocs(query(collection(db, 'challenges'), where('fromUid', '==', user.uid), limit(40))),
          getDocs(query(collection(db, 'challenges'), where('toUid', '==', user.uid), limit(40))),
        ]);
        if (cancelled) return;

        const byId = new Map();
        [fromSnap, toSnap].forEach((snap) => {
          snap.forEach((docSnap) => byId.set(docSnap.id, { id: docSnap.id, ...docSnap.data() }));
        });

        const list = Array.from(byId.values())
          .sort((a, b) => tsToMillis(b.createdAt) - tsToMillis(a.createdAt))
          .slice(0, 30);

        setChallengeHistory(list);
      } catch (error) {
        console.error('Duel history fetch failed:', error);
      }
    })();

    return () => { cancelled = true; };
  }, [db, user, activeTab]);

  // 4. Close this page's own "waiting for response" modal once the shared
  // ChallengeContext sees this sent challenge get accepted/declined. The
  // actual route/notification is handled once, globally, by
  // ChallengeStatusToast — this just tidies up local modal state so it
  // doesn't linger open after the outcome is already known elsewhere.
  useEffect(() => {
    if (!sentChallengeId || !outgoingChallenge || outgoingChallenge.id !== sentChallengeId) return;
    if (outgoingChallenge.status === 'accepted' || outgoingChallenge.status === 'declined') {
      setSentChallengeId(null);
      setSelectedOpponent(null);
      setIsSending(false);
    }
  }, [outgoingChallenge, sentChallengeId]);

  // ─── Automated Matchmaking ──────────────────────────────────────────────
  // Both players independently poll the queue. To avoid two clients both
  // creating a challenge for the same pairing at once, only the
  // lexicographically-lower uid of the two ever initiates — the other side
  // just keeps waiting and picks up the resulting invite via the existing
  // incomingChallenges listener below, exactly like a manual invite.
  const stopMatchmakingTimers = () => {
    if (matchmakingPollRef.current) { clearInterval(matchmakingPollRef.current); matchmakingPollRef.current = null; }
    if (matchmakingTickRef.current) { clearInterval(matchmakingTickRef.current); matchmakingTickRef.current = null; }
    if (matchmakingTimeoutRef.current) { clearTimeout(matchmakingTimeoutRef.current); matchmakingTimeoutRef.current = null; }
    if (matchmakingHeartbeatRef.current) { clearInterval(matchmakingHeartbeatRef.current); matchmakingHeartbeatRef.current = null; }
  };

  const cancelMatchmaking = async () => {
    stopMatchmakingTimers();
    if (user) await leaveMatchmakingQueue(user.uid);
    setMatchmakingState('idle');
    setMatchmakingDrill(null);
    setMatchmakingSeconds(0);
  };

  const attemptMatchmakingScan = async (drill) => {
    // Ranked pairing: tight ±300 EIQ window for the first 15s, then
    // progressively wider so a small player pool still finds matches.
    const candidate = await scanForMatch(user, drill.slug, matchmakingEiqRange(matchmakingElapsedRef.current));
    if (!candidate || user.uid >= candidate.uid) return; // not found, or the other side will initiate

    stopMatchmakingTimers();
    try {
      const newChallengeId = await sendChallenge(user, candidate, drill.slug, drill.name, { matchmaking: true });
      await leaveMatchmakingQueue(user.uid);
      setMatchmakingState('found');
      // ChallengeStatusToast (mounted globally) auto-routes us in the moment
      // the matched opponent accepts. But if they never do — they cancelled
      // their own search in the same instant, or dropped off — nothing else
      // would ever move this modal off "Opponent Found! Connecting you both
      // to the lobby...", and its Cancel button only renders while
      // 'searching'. That left the player stranded with no way out. Bound the
      // wait, then withdraw the invite we created and reset to idle.
      matchmakingTimeoutRef.current = setTimeout(() => {
        if (newChallengeId) declineChallenge(newChallengeId).catch(() => {});
        cancelMatchmaking();
      }, MATCH_ACCEPT_TIMEOUT_MS);
    } catch (e) {
      console.error('Failed to create matched challenge:', e);
      await cancelMatchmaking();
    }
  };

  const startMatchmaking = async (drill) => {
    setMatchmakingDrill(drill);
    setMatchmakingState('searching');
    setMatchmakingSeconds(0);
    matchmakingElapsedRef.current = 0;

    try {
      await joinMatchmakingQueue(user, drill.slug, drill.name);
    } catch (e) {
      console.error('Failed to join matchmaking queue:', e);
      if (e?.code === 'arena/locked-out') alert(e.message);
      setMatchmakingState('idle');
      return;
    }

    await attemptMatchmakingScan(drill);
    matchmakingPollRef.current = setInterval(() => attemptMatchmakingScan(drill), MATCHMAKING_POLL_MS);
    matchmakingTickRef.current = setInterval(() => {
      matchmakingElapsedRef.current += 1;
      setMatchmakingSeconds((s) => s + 1);
    }, 1000);
    // Comfortably inside the 45s freshness window other players scan against,
    // so this search never goes invisible while it's still running.
    matchmakingHeartbeatRef.current = setInterval(() => {
      refreshMatchmakingQueue(user.uid);
    }, 20000);
    matchmakingTimeoutRef.current = setTimeout(() => { cancelMatchmaking(); }, 60000);
  };

  // Higher-uid (waiting) side of a match: the lower-uid side's sendChallenge
  // call surfaces here as a normal incoming invite — auto-accept it rather
  // than making the user click through it, and navigate straight in.
  useEffect(() => {
    if (matchmakingState !== 'searching') return;
    // The invite must be for the drill we're actually searching for, and fresh
    // enough to belong to THIS search. Matching on `matchmaking === true`
    // alone meant a leftover matchmaking invite from an earlier session
    // (they're only swept up after 20 minutes — see STALE_CHALLENGE_MS) got
    // auto-accepted the instant the player pressed Find Duel, dragging them
    // straight into a dead match against an opponent who was long gone.
    const cutoff = Date.now() - MATCHMAKING_INVITE_MAX_AGE_MS;
    const match = incomingChallenges.find((c) => {
      if (c.matchmaking !== true) return false;
      if (matchmakingDrill && c.drillSlug !== matchmakingDrill.slug) return false;
      const createdMs = tsToMillis(c.createdAt);
      // 0 means the server timestamp hasn't resolved yet, i.e. brand new.
      return createdMs === 0 || createdMs >= cutoff;
    });
    if (!match) return;

    stopMatchmakingTimers();
    (async () => {
      try {
        await acceptChallenge(match.id, user);
        await leaveMatchmakingQueue(user.uid);
        router.push(`/drills/${match.drillSlug}?challengeId=${match.id}`);
      } catch (e) {
        console.error('Failed to auto-accept matched challenge:', e);
      }
      setMatchmakingState('idle');
      setMatchmakingDrill(null);
    })();
  }, [incomingChallenges, matchmakingState, matchmakingDrill]);

  // Leave the queue and stop polling if the player navigates away mid-search.
  //
  // Keyed on the uid, NOT the whole `user` object: AuthContext live-syncs the
  // signed-in user's profile doc and merges each snapshot into a brand-new
  // object, so `user`'s identity changes on any write to that doc — including
  // the presence/lastSeen updates and the eiq/wins writes a duel produces.
  // Depending on `user` meant this cleanup fired on those unrelated updates,
  // silently clearing the poll timers and pulling the player out of the
  // matchmaking queue while their search modal still said "Finding an
  // Opponent" — a search that could then never match anyone.
  const userUid = user?.uid;
  useEffect(() => {
    return () => {
      stopMatchmakingTimers();
      if (userUid) leaveMatchmakingQueue(userUid).catch(() => {});
    };
  }, [userUid]);

  // "Duel" on a player, "Post Open Challenge", and "Find Duel" all open the
  // drill picker first; the actual invite/queue-join only happens once a
  // drill is picked, below — matchmaking no longer silently defaults to
  // DUEL_DRILLS[0].
  const handleDuelPlayer = (player) => setDuelPickerFor({ mode: 'direct', player });
  const handlePostOpenChallenge = () => setDuelPickerFor({ mode: 'global' });
  const handleFindDuel = () => setDuelPickerFor({ mode: 'matchmaking' });

  const handlePickDuelDrill = async (drill) => {
    const target = duelPickerFor;
    setDuelPickerFor(null);
    if (!target || !user || !db) return;

    if (target.mode === 'matchmaking') {
      await startMatchmaking(drill);
    } else if (target.mode === 'direct') {
      const player = target.player;
      setSelectedOpponent(player);
      setIsSending(true);
      setChallengeStatusMessage(`Pinging ${player.displayName}...`);
      try {
        const challengeId = await sendChallenge(user, player, drill.slug, drill.name);
        setSentChallengeId(challengeId);
        setChallengeStatusMessage(`Invited ${player.displayName.split(' ')[0]} to duel. Waiting for response...`);
      } catch (e) {
        console.error(e);
        alert(e?.code === 'arena/locked-out' ? e.message : "Failed to send challenge invitation.");
        setIsSending(false);
        setSelectedOpponent(null);
      }
    } else {
      const opponent = { uid: 'global', displayName: 'Global Matchmaking Pool' };
      setSelectedOpponent(opponent);
      setIsSending(true);
      setChallengeStatusMessage(`Pinging ${opponent.displayName}...`);
      try {
        const challengeId = await sendGlobalChallenge(user, drill.slug, drill.name);
        setSentChallengeId(challengeId);
        setChallengeStatusMessage("Your challenge lobby is now open. Waiting for a challenger to connect...");
      } catch (e) {
        console.error(e);
        alert(e?.code === 'arena/locked-out' ? e.message : "Failed to send challenge invitation.");
        setIsSending(false);
        setSelectedOpponent(null);
      }
    }
  };

  const handleAcceptInvite = async (invite) => {
    try {
      await acceptChallenge(invite.id, user);
      router.push(`/drills/${invite.drillSlug}?challengeId=${invite.id}`);
    } catch (e) {
      console.error(e);
      alert(e?.code === 'arena/locked-out' ? e.message : "Failed to accept challenge.");
    }
  };

  const handleDeclineInvite = async (invite) => {
    try {
      if (invite.toUid === 'global') {
        // This is someone else's open lobby post, not a 1:1 invite to you —
        // "declining" it just hides it from your own inbox, it shouldn't
        // cancel the lobby for every other player who might still join.
        // (The poster cancels their own post via the "Cancel Request" modal.)
        setHiddenGlobalInvites(prev => [...prev, invite.id]);
      } else {
        await declineChallenge(invite.id);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleDeleteAccount = async () => {
    if (confirm("⚠️ WARNING: Are you sure you want to permanently delete your account? This deletes your profile, duel history, wins/losses stats, and sign-in — and cannot be undone.")) {
      try {
        const result = await deleteAccount();
        if (!result.ok) {
          alert("Failed to delete account: " + result.error);
          return;
        }
        alert("Your account has been deleted successfully.");
      } catch (e) {
        console.error("Failed to delete account:", e);
        alert("Failed to delete account: " + e.message);
      }
    }
  };

  const filteredPlayers = onlinePlayers.filter(p =>
    (p.displayName || '').toLowerCase().includes(searchTerm.toLowerCase())
  );

  // Open-lobby posts the user has dismissed from their own inbox are filtered
  // out here, at render, rather than inside the invites listener — see the
  // note on that effect.
  const visibleInvites = pendingInvites.filter(i => !hiddenGlobalInvites.includes(i.id));

  const renderAvatar = (userObj, sizeClass = "w-10 h-10", borderClass = "border border-neutral-800") => {
    if (userObj.photoURL) {
      return <img src={userObj.photoURL} alt={userObj.displayName} referrerPolicy="no-referrer" className={`${sizeClass} rounded-full ${borderClass} object-cover`} />;
    }
    const initials = userObj.displayName ? userObj.displayName.substring(0, 2).toUpperCase() : '??';
    return (
      <div className={`${sizeClass} rounded-full ${borderClass} flex items-center justify-center font-bold text-xs bg-violet-600 text-white shrink-0`}>
        {initials}
      </div>
    );
  };

  const getChallengeOutcome = (challenge) => {
    if (challenge.status !== 'completed') {
      return { 
        label: challenge.status === 'pending' ? 'Pending' : challenge.status === 'accepted' ? 'Active' : 'Declined', 
        color: 'text-neutral-400 bg-neutral-900/60 border-neutral-800' 
      };
    }
    
    const isSender = challenge.fromUid === user.uid;
    const userScore = isSender ? (challenge.fromScore || 0) : (challenge.toScore || 0);
    const oppScore = isSender ? (challenge.toScore || 0) : (challenge.fromScore || 0);

    if (userScore > oppScore) {
      return { label: 'Victory', color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' };
    } else if (userScore < oppScore) {
      return { label: 'Defeat', color: 'text-red-400 bg-red-500/10 border-red-500/20' };
    } else {
      return { label: 'Draw', color: 'text-slate-400 bg-slate-500/10 border-slate-500/20' };
    }
  };

  const winRate = user && (user.wins + user.losses > 0)
    ? Math.round((user.wins / (user.wins + user.losses)) * 100)
    : 0;

  if (!ARENA_ENABLED) {
    return (
      <div className="min-h-screen bg-[#050508] text-slate-100 flex flex-col items-center justify-center p-6 text-center" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
        <div className="w-16 h-16 bg-purple-600/10 border border-purple-500/30 rounded-2xl flex items-center justify-center mb-6">
          <Swords className="w-8 h-8 text-purple-400" />
        </div>
        <h1 className="text-xl font-bold text-white mb-2">Arena — Coming Soon</h1>
        <p className="text-sm text-neutral-400 max-w-xs leading-relaxed">
          Real-time 1v1 duels are being tuned up for mobile before launch. Keep training solo — Arena will unlock here once it's ready.
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#050508] text-slate-100 flex flex-col relative pb-28 overflow-x-hidden" style={{ paddingTop: 'calc(16px + env(safe-area-inset-top))' }}>
      {/* Main List Container */}
      <div className="flex-1 px-4 pt-0 pb-6 relative z-10">
        <div className="max-w-xl mx-auto">
          
          {/* ──────────────────────────────────────────────────────── */}
          {/* A. RANKINGS PAGE VIEW (tab === 'leaderboard') */}
          {/* ──────────────────────────────────────────────────────── */}
          {activeTab === 'leaderboard' && (
            <div className="space-y-5">
              {/* Ranks Header */}
              <div>
                <div className="flex items-center gap-1.5 mb-1">
                  <Trophy className="w-4 h-4 text-yellow-500" />
                  <span className="text-[10px] font-black text-yellow-500 uppercase tracking-widest">Global Standings</span>
                </div>
                <h1 className="text-2xl font-black text-white tracking-tight">Arena Rankings</h1>
                <p className="text-xs text-neutral-500 mt-1">Ranked by EIQ — win Arena duels to climb, lose and you drop. Harder drills and more decisive wins swing more EIQ.</p>
              </div>

              {leaderboardUsers.length === 0 ? (
                <div className="text-center py-16 bg-[#12131c] border border-neutral-800/60 rounded-3xl">
                  <div className="w-12 h-12 bg-neutral-900 rounded-full flex items-center justify-center border border-neutral-800 mx-auto mb-3">
                    <Trophy className="w-5 h-5 text-neutral-500 animate-pulse" />
                  </div>
                  <h3 className="font-bold text-neutral-300 text-sm">Calculating Standings</h3>
                  <p className="text-xs text-neutral-500 mt-1 max-w-xs mx-auto">
                    Play multiplayer reflex games to populate the rankings database!
                  </p>
                </div>
              ) : (
                <div className="space-y-2.5">
                  {leaderboardUsers.map((userObj, idx) => {
                    const playerWinRate = userObj.wins + userObj.losses > 0
                      ? Math.round((userObj.wins / (userObj.wins + userObj.losses)) * 100)
                      : 0;

                    const isCurrentUser = user && user.uid === userObj.uid;
                    const tier = tierForEiq(userObj.eiq);
                    const tierCls = {
                      bronze:   'text-amber-600 bg-amber-600/10 border-amber-600/25',
                      silver:   'text-slate-300 bg-slate-400/10 border-slate-400/25',
                      gold:     'text-yellow-400 bg-yellow-400/10 border-yellow-400/30',
                      platinum: 'text-cyan-300 bg-cyan-400/10 border-cyan-400/30',
                      diamond:  'text-violet-300 bg-violet-400/10 border-violet-400/30',
                    }[tier.id] || 'text-neutral-400 bg-neutral-800/40 border-neutral-700';

                    let winRateColor = "bg-orange-500";
                    if (playerWinRate >= 70) winRateColor = "bg-emerald-500";
                    else if (playerWinRate >= 50) winRateColor = "bg-indigo-500";

                    // Podium accents for the top three
                    const podiumBorder = idx === 0 ? 'border-yellow-500/30' : idx === 1 ? 'border-slate-400/25' : idx === 2 ? 'border-amber-600/25' : 'border-neutral-800/60';

                    return (
                      <div
                        key={userObj.uid}
                        className={`flex items-center justify-between p-3.5 rounded-3xl border transition-all duration-300 ${
                          isCurrentUser
                            ? 'bg-purple-950/10 border-purple-500/30 shadow-[0_0_15px_rgba(139,92,246,0.05)]'
                            : `bg-[#12131c] ${podiumBorder} hover:border-neutral-700`
                        }`}
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          {/* Rank Indicator — medals for the podium */}
                          <span className={`w-8 text-center shrink-0 ${idx < 3 ? 'text-lg' : 'text-sm font-black font-mono tracking-tight text-neutral-500'}`}>
                            {idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `#${idx + 1}`}
                          </span>

                          {/* Avatar */}
                          {renderAvatar(userObj, "w-10 h-10 border border-neutral-800 shrink-0")}

                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5 min-w-0">
                              <span className="text-sm font-black text-white leading-tight truncate">
                                {userObj.displayName}
                              </span>
                              {isCurrentUser && (
                                <span className="text-[8px] bg-purple-500/20 text-purple-300 border border-purple-500/30 px-1.5 py-0.5 rounded-full font-black uppercase tracking-wider shrink-0">
                                  You
                                </span>
                              )}
                            </div>
                            {/* Tier + win rate */}
                            <div className="flex items-center gap-2 mt-1.5">
                              <span className={`text-[8.5px] px-1.5 py-0.5 rounded border font-black uppercase tracking-wider shrink-0 ${tierCls}`}>
                                {tier.name}
                              </span>
                              <div className="w-14 h-1 rounded-full bg-neutral-950 overflow-hidden shrink-0">
                                <div className={`h-full rounded-full ${winRateColor}`} style={{ width: `${playerWinRate}%` }} />
                              </div>
                              <span className="text-[9px] text-neutral-500 font-bold font-mono shrink-0">{playerWinRate}%</span>
                            </div>
                          </div>
                        </div>

                        <div className="text-right shrink-0 font-mono pl-2">
                          <span className="text-sm font-black text-yellow-400 block">{userObj.eiq || 0} <span className="text-[9px] text-neutral-500 font-bold">EIQ</span></span>
                          <span className="text-[10px] text-neutral-500 block">{userObj.wins || 0}W - {userObj.losses || 0}L</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* ──────────────────────────────────────────────────────── */}
          {/* B. MULTIPLAYER ARENA VIEW (activeTab !== 'leaderboard') */}
          {/* ──────────────────────────────────────────────────────── */}
          {activeTab !== 'leaderboard' && (
            <div className="space-y-6">
              
              {/* Arena Header */}
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="flex items-center gap-1.5 mb-1">
                    <Swords className="w-4 h-4 text-purple-400 animate-pulse" />
                    <span className="text-[10px] font-black text-purple-300 uppercase tracking-widest">Multiplayer Room</span>
                  </div>
                  <h1 className="text-2xl font-black text-white tracking-tight">Reflex Arena</h1>
                </div>
                {user && (
                  <button 
                    onClick={signOut} 
                    className="w-9 h-9 bg-[#12131c] border border-neutral-800 hover:border-red-500/30 rounded-xl flex items-center justify-center text-neutral-400 hover:text-red-400 transition-colors cursor-pointer"
                    title="Sign Out"
                  >
                    <LogOut className="w-4 h-4" />
                  </button>
                )}
              </div>

              {/* Sub-tab controllers */}
              <div className="flex bg-neutral-950 p-1 border border-neutral-900 rounded-2xl">
                <button
                  onClick={() => router.push('/challenge')}
                  className={`flex-1 py-2 px-3 rounded-xl text-[11px] font-black transition duration-200 flex items-center justify-center gap-1 cursor-pointer ${
                    activeTab === 'players' 
                      ? 'bg-neutral-900 text-white border border-neutral-800' 
                      : 'text-neutral-500 hover:text-white'
                  }`}
                >
                  <Users className="w-3.5 h-3.5" />
                  Online ({onlinePlayers.length})
                </button>
                
                <button
                  onClick={() => router.push('/challenge?tab=invites')}
                  className={`flex-1 py-2 px-3 rounded-xl text-[11px] font-black transition duration-200 flex items-center justify-center gap-1 relative cursor-pointer ${
                    activeTab === 'invites' 
                      ? 'bg-neutral-900 text-white border border-neutral-800' 
                      : 'text-neutral-500 hover:text-white'
                  }`}
                >
                  <Mail className="w-3.5 h-3.5" />
                  Invites
                  {visibleInvites.length > 0 && (
                    <span className="absolute top-1.5 right-1 w-1.5 h-1.5 bg-purple-500 rounded-full" />
                  )}
                </button>

                <button
                  onClick={() => router.push('/challenge?tab=results')}
                  className={`flex-1 py-2 px-3 rounded-xl text-[11px] font-black transition duration-200 flex items-center justify-center gap-1 cursor-pointer ${
                    activeTab === 'results' 
                      ? 'bg-neutral-900 text-white border border-neutral-800' 
                      : 'text-neutral-500 hover:text-white'
                  }`}
                >
                  <BarChart3 className="w-3.5 h-3.5" />
                  Results
                </button>
              </div>

              {/* ARENA TAB 1: FIND PLAYERS */}
              {activeTab === 'players' && (
                <div className="space-y-4">
                  {/* Search input */}
                  <div className="relative">
                    <Search className="absolute left-4 top-1/2 transform -translate-y-1/2 w-4 h-4 text-neutral-600" />
                    <input
                      type="text"
                      placeholder="Search online users..."
                      value={searchTerm}
                      onChange={(e) => setSearchTerm(e.target.value)}
                      className="w-full bg-[#12131c] border border-neutral-800 rounded-2xl py-3 pl-11 pr-4 text-sm text-white placeholder-neutral-650 focus:outline-none focus:border-purple-500/40 transition-colors"
                    />
                  </div>

                  {/* Automated EIQ matchmaking */}
                  <div className="bg-[#12131c] border border-emerald-500/20 hover:border-emerald-500/30 rounded-3xl p-5 flex flex-col sm:flex-row items-center justify-between gap-4 transition relative overflow-hidden">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-emerald-500/10 border border-emerald-500/20 rounded-xl flex items-center justify-center text-emerald-400 shrink-0">
                        <Target className="w-5 h-5" />
                      </div>
                      <div>
                        <h4 className="text-xs font-black text-neutral-200 uppercase tracking-wide">Auto-Matchmaking</h4>
                        <p className="text-[10px] text-neutral-500 mt-0.5">Pick a drill and get paired instantly with a similarly-rated opponent.</p>
                      </div>
                    </div>
                    <button
                      onClick={handleFindDuel}
                      className="w-full sm:w-auto bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-black px-4 py-2.5 rounded-xl transition duration-200 shadow-md cursor-pointer shrink-0"
                    >
                      Find Duel
                    </button>
                  </div>

                  {/* Manual open challenge post */}
                  <div className="bg-[#12131c] border border-purple-500/20 hover:border-purple-500/30 rounded-3xl p-5 flex flex-col sm:flex-row items-center justify-between gap-4 transition relative overflow-hidden">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-purple-500/10 border border-purple-500/20 rounded-xl flex items-center justify-center text-purple-400 shrink-0">
                        <Swords className="w-5 h-5" />
                      </div>
                      <div>
                        <h4 className="text-xs font-black text-neutral-200 uppercase tracking-wide">Post Open Invite</h4>
                        <p className="text-[10px] text-neutral-500 mt-0.5">Post a duel that any online player can browse to and accept manually.</p>
                      </div>
                    </div>
                    <button
                      onClick={handlePostOpenChallenge}
                      className="w-full sm:w-auto bg-purple-600 hover:bg-purple-500 text-white text-xs font-black px-4 py-2.5 rounded-xl transition duration-200 shadow-md cursor-pointer shrink-0"
                    >
                      Post Open Challenge
                    </button>
                  </div>

                  {/* Online Opponents list */}
                  {filteredPlayers.length === 0 ? (
                    <div className="text-center py-16 bg-[#12131c] border border-neutral-800/60 rounded-3xl">
                      <div className="w-12 h-12 bg-neutral-900 rounded-full flex items-center justify-center border border-neutral-800 mx-auto mb-3">
                        <Swords className="w-5 h-5 text-neutral-500" />
                      </div>
                      <h3 className="font-bold text-neutral-400 text-xs">No Online Players</h3>
                      <p className="text-xs text-neutral-500 mt-1 max-w-xs mx-auto">
                        Share the link with a friend and ask them to log in to start a reflex duel!
                      </p>
                    </div>
                  ) : (
                    <div className="grid gap-3">
                      {filteredPlayers.map((player) => {
                        const playerWinRate = player.wins + player.losses > 0 
                          ? Math.round((player.wins / (player.wins + player.losses)) * 100) 
                          : 0;

                        return (
                          <div 
                            key={player.uid}
                            className="bg-[#12131c] border border-neutral-800/60 hover:border-purple-500/30 rounded-3xl p-4 flex items-center justify-between gap-4 transition-all duration-300"
                          >
                            <div className="flex items-center gap-3">
                              <div className="relative shrink-0">
                                {renderAvatar(player, "w-11 h-11 border border-neutral-800")}
                                <span className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-emerald-500 border border-[#12131c] rounded-full"></span>
                              </div>
                              <div>
                                <h4 className="font-bold text-sm text-neutral-100 flex items-center gap-1.5">
                                  <span>{player.displayName}</span>
                                  {player.streak >= 3 && (
                                    <span className="bg-orange-500/10 text-orange-400 text-[8.5px] px-1.5 py-0.5 rounded-full border border-orange-500/20 font-black uppercase tracking-wider flex items-center gap-0.5">
                                      <Flame className="w-2.5 h-2.5 fill-orange-400 animate-pulse" /> Hot
                                    </span>
                                  )}
                                </h4>
                                <p className="text-[10px] text-neutral-500 mt-1 font-mono">
                                  <strong className="text-yellow-400">{player.eiq || 0}</strong> EIQ · <strong className="text-purple-400">{player.wins || 0}W</strong> - <strong className="text-neutral-500">{player.losses || 0}L</strong> ({playerWinRate}% WR)
                                </p>
                              </div>
                            </div>

                            <button
                              onClick={() => handleDuelPlayer(player)}
                              className="flex items-center gap-1 bg-purple-600/10 hover:bg-purple-600 text-purple-400 hover:text-white border border-purple-500/20 px-3.5 py-2.5 rounded-xl text-xs font-black transition duration-200 active:scale-95 cursor-pointer shadow-md"
                            >
                              <Zap className="w-3.5 h-3.5 fill-current" />
                              Duel
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {/* ARENA TAB 2: INCOMING INVITES */}
              {activeTab === 'invites' && (
                <div className="space-y-3">
                  {visibleInvites.length === 0 ? (
                    <div className="text-center py-16 bg-[#12131c] border border-neutral-800/60 rounded-3xl">
                      <div className="w-12 h-12 bg-neutral-900 rounded-full flex items-center justify-center border border-neutral-800 mx-auto mb-3">
                        <Mail className="w-5 h-5 text-neutral-500" />
                      </div>
                      <h3 className="font-bold text-neutral-400 text-xs">No Pending Invites</h3>
                      <p className="text-xs text-neutral-500 mt-1">
                        Your challenge request inbox is currently empty.
                      </p>
                    </div>
                  ) : (
                    <div className="grid gap-3">
                      {visibleInvites.map((invite) => (
                        <div 
                          key={invite.id}
                          className="bg-[#12131c] border-2 border-purple-500/30 rounded-3xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
                        >
                          <div className="flex items-center gap-3">
                            {renderAvatar({ photoURL: invite.fromPhoto, displayName: invite.fromName }, "w-10 h-10 border border-purple-500/20")}
                            <div>
                              <div className="flex items-center gap-2">
                                <h4 className="font-bold text-sm text-neutral-100">{invite.fromName}</h4>
                                {invite.toUid === 'global' && (
                                  <span className="bg-purple-500/10 text-purple-400 border border-purple-500/20 text-[9px] px-1.5 py-0.5 rounded font-black uppercase tracking-wider">
                                    Open Lobby
                                  </span>
                                )}
                              </div>
                              <p className="text-xs text-neutral-400 mt-0.5">
                                {invite.toUid === 'global' 
                                  ? "Challenges anyone to a reflex battle in " 
                                  : "Challenges you to a reflex battle in "}
                                <strong className="text-purple-300">{invite.drillName}</strong>
                              </p>
                            </div>
                          </div>

                          {/* Decline pushed to the far left, Accept to the right,
                              rather than both bunched together on one side — the
                              gap makes the destructive choice harder to hit by
                              accident and reads as a clear either/or. */}
                          <div className="flex w-full items-center justify-between gap-3 sm:w-auto sm:justify-end">
                            <button
                              onClick={() => handleDeclineInvite(invite)}
                              className="px-3.5 py-2 bg-neutral-800 hover:bg-neutral-700 text-neutral-300 hover:text-white rounded-xl text-xs font-bold transition cursor-pointer"
                            >
                              Decline
                            </button>

                            <button
                              onClick={() => handleAcceptInvite(invite)}
                              className="flex items-center gap-1 px-4 py-2 bg-purple-600 hover:bg-purple-500 text-white text-xs font-bold rounded-xl shadow-md transition cursor-pointer"
                            >
                              <Check className="w-3.5 h-3.5" />
                              Accept
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* ARENA TAB 3: USER STATS & DUEL RESULTS */}
              {activeTab === 'results' && (
                <div className="space-y-6">
                  {/* Wins and Losses Stats Card */}
                  <div className="bg-[#12131c] border border-neutral-800 rounded-3xl p-5 relative overflow-hidden">
                    <div className="flex items-center justify-between relative">
                      <span className="text-[10px] text-neutral-500 font-black uppercase tracking-wider">Your Performance Summary</span>
                      <span className="text-[9px] text-neutral-500 font-bold uppercase tracking-widest bg-neutral-900/80 border border-neutral-800 px-2 py-0.5 rounded-full">
                        {user?.wins || 0}W · {user?.losses || 0}L
                      </span>
                    </div>

                    <div className="flex items-end justify-center gap-2 mt-4 mb-5 relative">
                      <Trophy className="w-6 h-6 text-yellow-400 mb-1" />
                      <span className="text-4xl font-black text-white font-mono tracking-tight">{user?.eiq || 0}</span>
                      <span className="text-[10px] text-neutral-500 uppercase tracking-widest font-bold mb-2">EIQ</span>
                    </div>

                    <div className="relative mb-1 flex items-center justify-between text-[10px] font-bold uppercase tracking-wider">
                      <span className="text-neutral-500">Win Rate</span>
                      <span className="text-violet-300 font-mono">{winRate}%</span>
                    </div>
                    <div className="relative w-full h-2 rounded-full bg-neutral-950 border border-neutral-800/80 overflow-hidden mb-5">
                      <div
                        className="h-full rounded-full bg-violet-500 transition-all duration-500"
                        style={{ width: `${winRate}%` }}
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-3 relative">
                      <div className="bg-neutral-950/50 p-3.5 rounded-2xl border border-neutral-800/80 text-center">
                        <span className="text-[10px] text-neutral-500 uppercase block font-black tracking-wider">Wins</span>
                        <span className="text-2xl font-black text-emerald-400 mt-1 block font-mono">{user?.wins || 0}</span>
                      </div>
                      <div className="bg-neutral-950/50 p-3.5 rounded-2xl border border-neutral-800/80 text-center">
                        <span className="text-[10px] text-neutral-500 uppercase block font-black tracking-wider">Losses</span>
                        <span className="text-2xl font-black text-red-400 mt-1 block font-mono">{user?.losses || 0}</span>
                      </div>
                    </div>
                  </div>

                  {/* Duel History List */}
                  <div className="space-y-3">
                    <div className="text-xs font-bold text-neutral-500 uppercase tracking-widest">Duel History</div>

                    {challengeHistory.length === 0 ? (
                      <div className="text-center py-16 bg-[#12131c] border border-neutral-800/60 rounded-3xl">
                        <div className="w-12 h-12 bg-neutral-900 rounded-full flex items-center justify-center border border-neutral-800 mx-auto mb-3">
                          <BarChart3 className="w-5 h-5 text-neutral-500" />
                        </div>
                        <h3 className="font-bold text-neutral-400 text-xs">No Duel History</h3>
                        <p className="text-xs text-neutral-500 mt-1">
                          You haven't participated in any reflex battles yet.
                        </p>
                      </div>
                    ) : (
                      <div className="space-y-2.5">
                        {challengeHistory.map((item) => {
                          const isSender = item.fromUid === user.uid;
                          const opponentName = isSender ? item.toName : item.fromName;
                          const userScore = isSender ? (item.fromScore || 0) : (item.toScore || 0);
                          const oppScore = isSender ? (item.toScore || 0) : (item.fromScore || 0);

                          const outcome = getChallengeOutcome(item);
                          const accentBar = outcome.label === 'Victory' ? 'bg-emerald-500'
                            : outcome.label === 'Defeat' ? 'bg-red-500'
                            : outcome.label === 'Draw' ? 'bg-slate-500'
                            : 'bg-neutral-700';
                          const scoreTotal = Math.max(userScore + oppScore, 1);
                          const createdMs = tsToMillis(item.createdAt);
                          const formattedDate = createdMs
                            ? new Date(createdMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
                            : 'Unknown Date';

                          return (
                            <div
                              key={item.id}
                              className="relative bg-[#12131c] border border-neutral-800/65 rounded-3xl pl-5 pr-4 py-4 flex items-center justify-between gap-4 overflow-hidden"
                            >
                              <div className={`absolute left-0 top-0 bottom-0 w-1 ${accentBar}`} />

                              <div className="flex items-center gap-3 min-w-0">
                                <div className="w-10 h-10 rounded-xl bg-neutral-950 border border-neutral-800/80 flex items-center justify-center text-lg shadow-inner shrink-0">
                                  {item.toUid === 'global' ? '🌐' : '⚔️'}
                                </div>
                                <div className="min-w-0">
                                  <h4 className="font-bold text-sm text-neutral-100 flex items-center gap-1.5 flex-wrap">
                                    <span className="truncate">vs {opponentName}</span>
                                    <span className="text-[10px] text-neutral-500 font-bold font-mono shrink-0">({formattedDate})</span>
                                  </h4>
                                  <p className="text-xs text-neutral-500 mt-0.5 leading-snug truncate">
                                    <strong className="text-neutral-300 font-semibold">{item.drillName}</strong>
                                  </p>
                                  {item.status === 'completed' && (
                                    <div className="mt-2 flex items-center gap-2 font-mono">
                                      <span className="text-xs font-black text-purple-300">{userScore}</span>
                                      <div className="flex-1 h-1 rounded-full bg-neutral-950 border border-neutral-800/60 overflow-hidden min-w-[48px] max-w-[80px]">
                                        <div
                                          className={`h-full rounded-full ${accentBar}`}
                                          style={{ width: `${Math.round((userScore / scoreTotal) * 100)}%` }}
                                        />
                                      </div>
                                      <span className="text-xs font-black text-neutral-400">{oppScore}</span>
                                    </div>
                                  )}
                                </div>
                              </div>

                              <div className="shrink-0">
                                <span className={`px-2.5 py-1 rounded-full text-[9.5px] font-black uppercase tracking-wider border ${outcome.color}`}>
                                  {outcome.label}
                                </span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                </div>
              )}

            </div>
          )}

        </div>
      </div>

      {/* MODAL: Pick which drill to duel in — shown before a direct invite,
          open lobby post, or matchmaking queue join actually goes out. */}
      {duelPickerFor && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75"
          style={{ padding: '16px', paddingBottom: 'calc(16px + env(safe-area-inset-bottom))' }}
        >
          {/* Height cap uses dvh (the VISIBLE viewport) plus a hard px cap —
              plain vh in the Capacitor WebView is measured against a viewport
              that extends under the system bars (StatusBar overlays the
              WebView), so a vh-capped sheet could fit its content exactly
              while its bottom sat hidden under the Android nav area: nothing
              overflowed, so nothing scrolled. */}
          <div
            className="w-full max-w-sm bg-[#0a0a12] border border-neutral-800/80 rounded-3xl p-6 shadow-2xl relative flex flex-col"
            style={{ maxHeight: 'min(70dvh, 460px)' }}
          >
            <button
              onClick={() => setDuelPickerFor(null)}
              className="absolute top-4 right-4 w-8 h-8 bg-neutral-900 border border-neutral-800 rounded-full flex items-center justify-center text-neutral-400 hover:text-white shrink-0"
            >
              <X className="w-4 h-4" />
            </button>

            <div className="flex items-center gap-2 mb-4 shrink-0">
              <Swords className="w-5 h-5 text-purple-500" />
              <h3 className="font-bold text-lg text-white">Pick a Drill</h3>
            </div>

            <div
              className="space-y-2 min-h-0 flex-1 -mr-2 pr-2"
              style={{ overflowY: 'auto', WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain', touchAction: 'pan-y' }}
            >
              {DUEL_DRILLS.map((drill) => (
                <button
                  key={drill.slug}
                  onClick={() => handlePickDuelDrill(drill)}
                  className="w-full flex items-center justify-between gap-3 bg-neutral-900/60 border border-neutral-800/80 hover:border-purple-500/40 rounded-xl p-3.5 text-left transition"
                >
                  <span className="text-sm font-bold text-neutral-100">{drill.name}</span>
                  <Zap className="w-3.5 h-3.5 text-purple-400 shrink-0" />
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* MODAL: Matchmaking Request Waiting Spinner */}
      {selectedOpponent && sentChallengeId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm">
          <div className="w-full max-w-sm bg-[#0a0a12] border border-neutral-800/80 rounded-3xl p-6 text-center shadow-2xl relative">
            <div className="relative flex items-center justify-center mx-auto mb-6">
              <div className="absolute w-20 h-20 rounded-full border-4 border-t-purple-600 border-r-transparent border-b-transparent border-l-transparent animate-spin"></div>
              <div className="w-14 h-14 bg-neutral-900 rounded-full flex items-center justify-center border border-neutral-800">
                <Swords className="w-6 h-6 text-purple-500 animate-pulse" />
              </div>
            </div>

            <h3 className="font-bold text-base text-white mb-2">Challenge Sent</h3>
            <p className="text-xs text-neutral-400 px-4 leading-relaxed">
              {challengeStatusMessage}
            </p>

            <button
              onClick={async () => {
                // Cancel matchmaking request
                try {
                  if (sentChallengeId) {
                    await declineChallenge(sentChallengeId);
                  }
                } catch(e) {
                  console.error(e);
                }
                setSentChallengeId(null);
                setSelectedOpponent(null);
                setIsSending(false);
              }}
              className="mt-3 w-full py-2.5 bg-neutral-900 border border-neutral-800 rounded-xl text-xs font-semibold text-neutral-400 hover:text-red-400 hover:border-red-500/20 transition-all duration-200 cursor-pointer"
            >
              Cancel Request
            </button>
          </div>
        </div>
      )}

      {/* MODAL: Automated Matchmaking Search */}
      {matchmakingState !== 'idle' && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm">
          <div className="w-full max-w-sm bg-[#0a0a12] border border-neutral-800/80 rounded-3xl p-6 text-center shadow-2xl relative">
            <div className="relative flex items-center justify-center mx-auto mb-6">
              <div className="absolute w-20 h-20 rounded-full border-4 border-t-emerald-500 border-r-transparent border-b-transparent border-l-transparent animate-spin"></div>
              <div className="w-14 h-14 bg-neutral-900 rounded-full flex items-center justify-center border border-neutral-800">
                <Target className="w-6 h-6 text-emerald-400 animate-pulse" />
              </div>
            </div>

            <h3 className="font-bold text-base text-white mb-2">
              {matchmakingState === 'found' ? 'Opponent Found!' : 'Finding an Opponent'}
            </h3>
            <p className="text-xs text-neutral-400 px-4 leading-relaxed">
              {matchmakingState === 'found'
                ? 'Connecting you both to the lobby...'
                : `Searching for a similarly-rated duelist for ${matchmakingDrill?.name || 'your drill'}... (${matchmakingSeconds}s)`}
            </p>

            {matchmakingState === 'searching' && (
              <button
                onClick={cancelMatchmaking}
                className="mt-6 w-full py-2.5 bg-neutral-900 border border-neutral-800 rounded-xl text-xs font-semibold text-neutral-400 hover:text-red-400 hover:border-red-500/20 transition-all duration-200 cursor-pointer"
              >
                Cancel Search
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
