'use client';

// app/challenge/ChallengeArenaClient.js
// SkillDrills Pro — Multiplayer Arena & Rankings Hub

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useChallenge } from '../../contexts/ChallengeContext';
import {
  sendChallenge, sendGlobalChallenge, acceptChallenge, declineChallenge, withdrawChallenge, cleanupStaleChallenges,
  joinMatchmakingQueue, leaveMatchmakingQueue, refreshMatchmakingQueue, scanForMatch, matchmakingEiqRange,
  tierForEiq, EIQ_TIERS, DUEL_DRILLS, getServerClockOffset, isInviteFresh,
  isPlayerBusy, arenaLockoutRemainingMs, FORFEIT_GRACE_COUNT,
} from '../../lib/challengeEngine';
import { collection, query, where, onSnapshot, orderBy, limit, getDocs, doc, updateDoc, serverTimestamp, getCountFromServer } from 'firebase/firestore';

// Leaderboard results survive tab switches and remounts for a minute. Opening
// the tab used to mean sitting on a spinner through a full network round trip
// every single time, for a Top 50 that barely moves minute to minute — and
// each user doc carries its own avatar inline (photoURL is a base64 data URI,
// capped at 300KB by firestore.rules), so that round trip is far heavier than
// 50 rows of text should be.
let leaderboardCache = { users: null, at: 0 };

// How many opponents the Players tab offers. Ten is a shortlist you can read at
// a glance and pick from; forty was a wall of names nobody scrolled. Paired
// with the EIQ-distance sort in the presence listener, these are the ten
// closest to your own rank.
const ARENA_OPPONENT_LIMIT = 10;
const LEADERBOARD_TTL_MS = 60000;

// Rank-change indicator tint. Scoped to just the rank number and the
// player's own leaderboard row — never the whole Your Standing card, and
// never the Bronze/Silver tier bar, which is a different system entirely
// and stays exactly as it is regardless of rank movement. Cyan for a climb
// rather than green/emerald: the app's existing positive color (win states,
// EIQ gains elsewhere) is already emerald, and this needed to read as its
// own signal rather than borrowing that one. Red is deliberately restrained
// (rose, low-opacity fills) rather than a saturated alert red.
const RANK_CHANGE_THEME = {
  up:   { text: 'text-cyan-300', ring: 'ring-1 ring-cyan-400/40', rowBg: 'bg-cyan-500/[0.06]', rowBorder: 'border-cyan-500/25', glow: '#22d3ee' },
  down: { text: 'text-rose-300', ring: 'ring-1 ring-rose-400/40', rowBg: 'bg-rose-500/[0.06]', rowBorder: 'border-rose-500/25', glow: '#fb7185' },
};

import { useRouter, useSearchParams } from 'next/navigation';
import { ARENA_ENABLED } from '../../lib/featureFlags';
import {
  Swords, Trophy, Mail, Users, Zap, Check, Search, Target, Flame,
  BarChart3, X, WifiOff, Crown, ArrowUp, ArrowDown
} from 'lucide-react';
import { useOnlineStatus, isOnline } from '../../lib/useOnlineStatus';

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

// Presence freshness. `online: true` is written at sign-in and cleared on
// visibilitychange/beforeunload — neither of which fires when Android kills a
// backgrounded app, so a player who never cleanly closed the app stayed
// listed as online indefinitely. Inviting one of those ghosts produced a
// perfectly normal-looking invite that could only ever time out.
//
// So `online` is treated as a claim that has to be renewed: this screen
// refreshes `lastSeen` on a slow heartbeat while it's open, and anyone whose
// last heartbeat is older than the cutoff is filtered out of the list no
// matter what their `online` flag says. The cutoff allows two missed
// heartbeats, so a real player on a flaky connection doesn't flicker out.
const PRESENCE_HEARTBEAT_MS = 3 * 60 * 1000;
const PRESENCE_FRESH_MS = 8 * 60 * 1000;

// How often the invite list re-evaluates which invites have aged out. Invites
// expire while the player is looking at them (see INVITE_TTL_MS), and nothing
// else re-renders this screen in the meantime.
const INVITE_SWEEP_MS = 15 * 1000;

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
  const { user, db } = useAuth();
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
  // Bumped on a slow timer so presence freshness and invite expiry are
  // re-evaluated while the player sits on this screen — neither changes on
  // its own, and without this a ghost player or a dead invite stayed on
  // screen until something unrelated caused a re-render.
  const [presenceCheckedAt, setPresenceCheckedAt] = useState(0);
  const [leaderboardUsers, setLeaderboardUsers] = useState([]);
  // Rank of the current user when they are NOT in the top 50. The board shows
  // fifty profile rows and no more — past that the rows stop being a ranking
  // anyone reads and start being a scroll — but everyone still HAS a rank, and
  // not showing a player their own position is the one thing a leaderboard
  // must never do. So: fifty profiles, plus your own number if you are below
  // them. Resolved with a server-side count, which reads no documents.
  const [ownRank, setOwnRank] = useState(null);
  // Open-lobby posts from other players only. Direct invites addressed to this
  // user arrive separately via ChallengeContext; the two are merged into
  // `pendingInvites` below.
  const [globalInvites, setGlobalInvites] = useState([]);
  const [challengeHistory, setChallengeHistory] = useState([]);
  const [searchTerm, setSearchTerm] = useState('');
  
  // Challenge creation state
  const [selectedOpponent, setSelectedOpponent] = useState(null);
  const [sentChallengeId, setSentChallengeId] = useState(null);
  const [challengeStatusMessage, setChallengeStatusMessage] = useState('');
  const [hiddenGlobalInvites, setHiddenGlobalInvites] = useState([]);
  // Set when the player cancels the waiting modal before the invite's own
  // addDoc has come back with an id. Without it there was nothing to cancel
  // yet — the write landed a moment later and left a live invite up that the
  // player had already dismissed, so an opponent could accept a duel the
  // sender had walked away from.
  const sendAbortedRef = useRef(false);
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
  // The invite this search created for a matched opponent, so "Cancel" during
  // the "Opponent Found!" step can take it back down. Cleared whenever the
  // search resets.
  const matchedChallengeIdRef = useRef(null);

  // The Arena is online-only. Offline, Firestore silently queues writes
  // instead of failing, which stranded the search modal forever — see
  // lib/useOnlineStatus.js. Every entry point below refuses to start and says
  // why, rather than letting the player walk into that.
  const online = useOnlineStatus();
  const [offlineNotice, setOfflineNotice] = useState('');
  useEffect(() => {
    if (!offlineNotice) return;
    const t = setTimeout(() => setOfflineNotice(''), 4000);
    return () => clearTimeout(t);
  }, [offlineNotice]);
  // Re-checks navigator.onLine at tap time rather than trusting the rendered
  // flag: the connection can drop between paint and tap.
  const blockedOffline = (message) => {
    if (isOnline()) return false;
    setOfflineNotice(message);
    return true;
  };

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

  // 0c. Renew this player's own presence claim while the Arena is open, and
  // re-check everyone else's as time passes.
  //
  // Deliberately scoped to this screen and this screen only. Presence exists
  // so other players can invite someone who will actually answer, which
  // matters exactly here — running it app-wide would charge every solo player
  // in the app a repeating write they get nothing from, and each of those
  // writes also fans out as a read to every other player watching the online
  // list. See PRESENCE_HEARTBEAT_MS.
  useEffect(() => {
    if (!ARENA_ENABLED || !db || !uid) return;

    const beat = () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      // `busyUntil: 0` rides along on the heartbeat that was happening
      // anyway, so it costs nothing extra. Sitting on this screen is proof
      // you are not in a duel, which makes this the natural place to release
      // an in-match claim that outlived its match — the app being killed
      // mid-duel is exactly the case markInMatch's cleanup can never run for,
      // and without this the player would stay hidden from everyone else's
      // opponent list for the rest of BUSY_TTL_MS after coming back.
      updateDoc(doc(db, 'users', uid), { online: true, lastSeen: serverTimestamp(), busyUntil: 0 })
        .catch(() => {});
    };
    beat();
    const heartbeat = setInterval(beat, PRESENCE_HEARTBEAT_MS);
    // Separate, much faster timer: this one writes nothing, it only nudges a
    // re-render so stale players and expired invites drop off the screen on
    // their own rather than lingering until something else re-renders.
    const sweep = setInterval(() => setPresenceCheckedAt(Date.now()), INVITE_SWEEP_MS);

    return () => {
      clearInterval(heartbeat);
      clearInterval(sweep);
    };
  }, [db, uid]);

  // 1. Subscribe to online players list (excluding current user)
  useEffect(() => {
    if (!ARENA_ENABLED || !db || !user) return;

    // Ordered by `lastSeen` DESC, with a fallback to the unordered query.
    //
    // This used to fetch an arbitrary 40 of `online == true` with no ordering
    // at all, and that is a real bug, not a preference. `online` is set true
    // on sign-in and only ever set false by a clean sign-out / beforeunload /
    // tab-hide — none of which fire when Android kills a backgrounded app. So
    // the `online == true` set fills up with players who left days ago and
    // never shrinks. An unordered `limit(40)` returns an ARBITRARY forty of
    // those, `freshPlayers` then drops every one whose `lastSeen` is over
    // PRESENCE_FRESH_MS old, and the screen says "Nobody else online" while
    // someone genuinely online is sitting right there — which is exactly what
    // we saw on device, with a live invite from that player on screen at the
    // same time. It can only get worse as the playerbase grows.
    //
    // Ordering by `lastSeen` puts the 40 most-recently-seen players in the
    // window, so anyone actually online is always in it.
    //
    // The original note here was right that this needs a composite index and
    // that a missing one fails the query outright (FAILED_PRECONDITION) and
    // empties the list. Two things answer that now: the index is declared in
    // firestore.indexes.json (wired into firebase.json), and if the ordered
    // query fails for ANY reason this falls back to the old unordered one —
    // so the worst case is exactly today's behaviour, never worse.
    let cancelled = false;
    let unsub = null;
    let usedFallback = false;

    const handleSnapshot = (snapshot) => {
      const players = [];
      snapshot.forEach((doc) => {
        // The document ID *is* the uid — users/{uid} — so take it from there
        // rather than trusting a `uid` field inside the document. A profile
        // written without that field (a migrated or hand-edited doc) used to
        // come through with `uid: undefined`, which meant it failed the
        // "not me" check below and listed the player as their own opponent,
        // and gave React an undefined key — two of those and the list had
        // duplicate keys, which is the warning this was throwing.
        const data = { ...doc.data(), uid: doc.id };
        if (data.uid !== user.uid) {
          players.push(data);
        }
      });
      // The whole candidate window is kept here, unsorted and untrimmed.
      //
      // It used to be sorted by EIQ distance and cut to ARENA_OPPONENT_LIMIT
      // right at this line — BEFORE `freshPlayers` below drops the stale
      // entries and the players already in a duel. Those two filters then ran
      // against the surviving ten and could only shrink them further, so the
      // list was ten minus however many of your ten nearest happened to be
      // ghosts. `online == true` is a sticky flag that Android never clears
      // when it kills a backgrounded app, so ghosts are the common case, not
      // the rare one: the screen could say "Nobody else online" with thirty
      // genuinely-online players sitting just outside the cut.
      //
      // Filter first, THEN rank, THEN trim — see `freshPlayers`. Ranking a
      // list of forty on the phone is nothing; ranking the wrong forty was
      // the entire bug.
      setOnlinePlayers(players);
      // Also used to re-check freshness as time passes — see freshPlayers.
      setPresenceCheckedAt(Date.now());
    };

    const subscribe = (ordered) => {
      const q = ordered
        ? query(collection(db, 'users'), where('online', '==', true), orderBy('lastSeen', 'desc'), limit(40))
        : query(collection(db, 'users'), where('online', '==', true), limit(40));
      return onSnapshot(q, handleSnapshot, (error) => {
        if (ordered && !usedFallback && !cancelled) {
          usedFallback = true;
          console.warn('Ordered presence query failed — falling back to unordered:', error?.code);
          unsub = subscribe(false);
          return;
        }
        console.error("Online players fetch failed:", error);
      });
    };

    unsub = subscribe(true);

    return () => {
      cancelled = true;
      if (unsub) unsub();
    };
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

    // Paint the last result instantly, then only go to the network if it has
    // gone stale. A re-open inside the TTL costs nothing and shows no spinner.
    if (leaderboardCache.users) {
      setLeaderboardUsers(leaderboardCache.users);
      if (Date.now() - leaderboardCache.at < LEADERBOARD_TTL_MS) return;
    }

    (async () => {
      try {
        const snap = await getDocs(query(collection(db, 'users'), orderBy('eiq', 'desc'), limit(50)));
        if (cancelled) return;
        const users = [];
        snap.forEach((doc) => users.push(doc.data()));
        leaderboardCache = { users, at: Date.now() };
        setLeaderboardUsers(users);

        // Only when the player is outside the fifty rows just fetched.
        const inTop = user && users.some((u) => u.uid === user.uid);
        if (user && !inTop) {
          try {
            const higher = await getCountFromServer(
              query(collection(db, 'users'), where('eiq', '>', user.eiq || 0))
            );
            if (!cancelled) setOwnRank(higher.data().count + 1);
          } catch {
            // A count that fails is not worth failing the board over.
            if (!cancelled) setOwnRank(null);
          }
        } else if (!cancelled) {
          setOwnRank(null);
        }
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
    }
  }, [outgoingChallenge, sentChallengeId]);

  // ─── Automated Matchmaking ──────────────────────────────────────────────
  // Both players independently poll the queue. To avoid two clients both
  // creating a challenge for the same pairing at once, only the
  // lexicographically-lower uid of the two ever initiates — the other side
  // just keeps waiting and picks up the resulting invite via the existing
  // incomingChallenges listener below, exactly like a manual invite.
  // Firestore writes neither resolve nor reject while the connection is dead —
  // they sit queued in the local cache. Anything the search UI depends on
  // therefore has to be bounded, or the modal waits on a promise that never
  // settles. Rejects with code 'arena/no-connection' so callers can tell a
  // dead connection apart from a real Firestore error.
  const QUEUE_JOIN_TIMEOUT_MS = 8000;
  const withConnectionTimeout = (promise, ms = QUEUE_JOIN_TIMEOUT_MS) => {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const err = new Error('No connection to the duel server.');
        err.code = 'arena/no-connection';
        reject(err);
      }, ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  };

  const stopMatchmakingTimers = () => {
    if (matchmakingPollRef.current) { clearInterval(matchmakingPollRef.current); matchmakingPollRef.current = null; }
    if (matchmakingTickRef.current) { clearInterval(matchmakingTickRef.current); matchmakingTickRef.current = null; }
    if (matchmakingTimeoutRef.current) { clearTimeout(matchmakingTimeoutRef.current); matchmakingTimeoutRef.current = null; }
    if (matchmakingHeartbeatRef.current) { clearInterval(matchmakingHeartbeatRef.current); matchmakingHeartbeatRef.current = null; }
  };

  const cancelMatchmaking = async () => {
    stopMatchmakingTimers();
    // An invite we minted for a matched opponent goes with the search. Without
    // this, cancelling from "Opponent Found!" left it live: the opponent could
    // accept it minutes later and land in a lobby alone.
    const matchedId = matchedChallengeIdRef.current;
    matchedChallengeIdRef.current = null;
    if (matchedId) withdrawChallenge(matchedId).catch(() => {});
    // Close the modal FIRST. This used to await leaveMatchmakingQueue before
    // resetting state, and offline that write never resolves (Firestore
    // queues it silently), so "Cancel Search" — the only way out of the
    // search modal — did nothing at all. The queue entry is left to the
    // fire-and-forget delete below; it also ages out on its own via
    // MATCHMAKING_FRESHNESS_MS, so a dropped cleanup is harmless.
    setMatchmakingState('idle');
    setMatchmakingDrill(null);
    setMatchmakingSeconds(0);
    if (user) leaveMatchmakingQueue(user.uid).catch(() => {});
  };

  const attemptMatchmakingScan = async (drill) => {
    // Ranked pairing: tight ±300 EIQ window for the first 15s, then
    // progressively wider so a small player pool still finds matches.
    const candidate = await scanForMatch(user, drill.slug, matchmakingEiqRange(matchmakingElapsedRef.current));
    if (!candidate || user.uid >= candidate.uid) return; // not found, or the other side will initiate

    stopMatchmakingTimers();
    try {
      const newChallengeId = await sendChallenge(user, candidate, drill.slug, drill.name, { matchmaking: true });
      matchedChallengeIdRef.current = newChallengeId;
      await leaveMatchmakingQueue(user.uid);
      setMatchmakingState('found');
      // ChallengeStatusToast (mounted globally) auto-routes us in the moment
      // the matched opponent accepts. But if they never do — they cancelled
      // their own search in the same instant, or dropped off — nothing else
      // would ever move this modal off "Opponent Found! Connecting you both
      // to the lobby...", and its Cancel button only renders while
      // 'searching'. That left the player stranded with no way out. Bound the
      // wait, then withdraw the invite we created and reset to idle.
      matchmakingTimeoutRef.current = setTimeout(async () => {
        // withdrawChallenge only cancels an invite still sitting unanswered.
        // A blind decline here raced the opponent's accept: they were already
        // being routed into the drill when this fired, and arrived to find
        // the duel marked declined out from under them.
        if (newChallengeId) {
          matchedChallengeIdRef.current = null;
          const withdrawn = await withdrawChallenge(newChallengeId).catch(() => false);
          // They accepted just as we gave up — follow them in rather than
          // dropping a match both players are now expecting.
          if (!withdrawn) {
            stopMatchmakingTimers();
            await leaveMatchmakingQueue(user.uid).catch(() => {});
            router.push(`/drills/${drill.slug}?challengeId=${newChallengeId}`);
            return;
          }
        }
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
      await withConnectionTimeout(joinMatchmakingQueue(user, drill.slug, drill.name));
    } catch (e) {
      if (e?.code === 'arena/locked-out') {
        alert(e.message);
      } else if (e?.code === 'arena/no-connection') {
        // Reached with the radios on but no working route out (dead Wi-Fi,
        // captive portal) — navigator.onLine can't see that, so the entry
        // guard lets it through and it lands here instead.
        setOfflineNotice('Could not reach the duel server. Check your internet connection and try again.');
      } else {
        console.error('Failed to join matchmaking queue:', e);
      }
      setMatchmakingState('idle');
      setMatchmakingDrill(null);
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

  // Losing the connection mid-search can't produce a match, and none of the
  // polling can report the failure — scanForMatch just returns nothing while
  // offline, so the search would run its clock out looking healthy. End it
  // immediately and say why.
  useEffect(() => {
    if (online || matchmakingState === 'idle') return;
    cancelMatchmaking();
    setOfflineNotice('Your search stopped because the connection dropped. Reconnect to Wi-Fi or mobile data to duel.');
  }, [online, matchmakingState]);

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

        // Turn down any OTHER matchmaking invite aimed at us in the same
        // wave. Several searchers can spot the same waiting player at once
        // and each send an invite; only one can be accepted, and every other
        // sender was left staring at "Opponent Found! Connecting you both..."
        // for the full accept timeout before their search reset. Declining
        // now bounces them straight back into the queue.
        incomingChallenges
          .filter((c) => c.id !== match.id && c.matchmaking === true)
          .forEach((c) => { declineChallenge(c.id).catch(() => {}); });

        router.push(`/drills/${match.drillSlug}?challengeId=${match.id}`);
      } catch (e) {
        // 'challenge/taken' means the sender withdrew it in the same instant
        // — not an error worth surfacing, just keep searching.
        if (e?.code !== 'challenge/taken' && e?.code !== 'challenge/expired') {
          console.error('Failed to auto-accept matched challenge:', e);
        }
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
  const handleDuelPlayer = (player) => {
    if (blockedOffline('You need an internet connection to challenge a player. Turn on Wi-Fi or mobile data and try again.')) return;
    setDuelPickerFor({ mode: 'direct', player });
  };
  const handlePostOpenChallenge = () => {
    if (blockedOffline('You need an internet connection to post an open challenge. Turn on Wi-Fi or mobile data and try again.')) return;
    setDuelPickerFor({ mode: 'global' });
  };
  const handleFindDuel = () => {
    if (blockedOffline('You need an internet connection to find a duel. Turn on Wi-Fi or mobile data and try again.')) return;
    setDuelPickerFor({ mode: 'matchmaking' });
  };

  const handlePickDuelDrill = async (drill) => {
    const target = duelPickerFor;
    setDuelPickerFor(null);
    if (!target || !user || !db) return;
    // Checked again here, not just at the button: the picker sits open for as
    // long as the player takes to choose, and the connection can drop in that
    // window. Everything below this line is a Firestore write.
    if (blockedOffline('You went offline. Reconnect to Wi-Fi or mobile data to start a duel.')) return;

    if (target.mode === 'matchmaking') {
      await startMatchmaking(drill);
    } else if (target.mode === 'direct') {
      const player = target.player;
      sendAbortedRef.current = false;
      setSelectedOpponent(player);
      setChallengeStatusMessage(`Pinging ${player.displayName}...`);
      try {
        const challengeId = await sendChallenge(user, player, drill.slug, drill.name);
        // Cancelled while the write was still in the air — take the invite
        // straight back down instead of leaving a live one behind.
        if (sendAbortedRef.current) {
          if (challengeId) withdrawChallenge(challengeId).catch(console.error);
          return;
        }
        setSentChallengeId(challengeId);
        setChallengeStatusMessage(`Invited ${player.displayName.split(' ')[0]} to duel. Waiting for response...`);
      } catch (e) {
        console.error(e);
        alert(e?.code === 'arena/locked-out' ? e.message : "Failed to send challenge invitation.");
        setSelectedOpponent(null);
      }
    } else {
      const opponent = { uid: 'global', displayName: 'Global Matchmaking Pool' };
      sendAbortedRef.current = false;
      setSelectedOpponent(opponent);
      setChallengeStatusMessage('Opening your challenge lobby...');
      try {
        const challengeId = await sendGlobalChallenge(user, drill.slug, drill.name);
        if (sendAbortedRef.current) {
          if (challengeId) withdrawChallenge(challengeId).catch(console.error);
          return;
        }
        setSentChallengeId(challengeId);
        setChallengeStatusMessage("Your challenge lobby is now open. Waiting for a challenger to connect...");
      } catch (e) {
        console.error(e);
        alert(e?.code === 'arena/locked-out' ? e.message : "Failed to send challenge invitation.");
        setSelectedOpponent(null);
      }
    }
  };

  // Take down an invite this player sent. Closes the modal on the same frame
  // as the tap and does the Firestore work afterwards — the withdraw is a
  // transaction, i.e. a full server round trip, and awaiting it before
  // dismissing anything left the modal sitting there for seconds on a slow
  // connection as though Cancel had not registered.
  const cancelSentChallenge = () => {
    const id = sentChallengeId;
    sendAbortedRef.current = true;
    setSentChallengeId(null);
    setSelectedOpponent(null);
    setChallengeStatusMessage('');
    // withdrawChallenge, not declineChallenge: if the opponent accepted in
    // the same instant, this leaves their live match alone instead of tearing
    // it down under them. It also marks the doc `withdrawnBySender`, which is
    // what stops our own cancel coming back to us as "<opponent> declined
    // your duel" (see ChallengeStatusToast).
    if (id) withdrawChallenge(id).catch(console.error);
  };

  const handleAcceptInvite = async (invite) => {
    try {
      await acceptChallenge(invite.id, user);
      router.push(`/drills/${invite.drillSlug}?challengeId=${invite.id}`);
    } catch (e) {
      // An open-lobby post is visible to everyone, so losing the race for one
      // is completely ordinary — say so plainly and drop the dead post out of
      // this player's inbox rather than reporting a failure.
      if (e?.code === 'challenge/taken' || e?.code === 'challenge/expired') {
        setHiddenGlobalInvites((prev) => [...prev, invite.id]);
        alert(e.message);
        return;
      }
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

  // The actual opponent list: who is really here, ranked by how close they
  // are to you, capped at ARENA_OPPONENT_LIMIT.
  //
  // Three steps, and the order of them is load-bearing (see the note in the
  // presence listener above):
  //
  //  1. Drop the ghosts. `online == true` survives an app Android killed in
  //     the background, so presence is only trustworthy alongside a `lastSeen`
  //     inside PRESENCE_FRESH_MS. A player with no lastSeen at all is a
  //     pre-heartbeat account — trust their flag rather than hiding them.
  //  2. Drop anyone already in a duel. They are online and their presence is
  //     fresh, so nothing above this catches them, but an invite sent to a
  //     player mid-match is one they cannot even see: the invite banner is
  //     deliberately unmounted on drill routes (AppShellClient), so it never
  //     renders, and the sender sits through the full two-minute invite TTL
  //     waiting on an answer that was never possible. See markInMatch.
  //  3. Rank by EIQ distance and take the nearest ARENA_OPPONENT_LIMIT.
  //     Recency only breaks ties. Sorting by "seen most recently" instead —
  //     which is what this did originally — put whoever last opened the app
  //     at the top regardless of skill, so a new player's first duel was as
  //     likely to be against the best player online as anyone else, and
  //     losing every opening duel is the fastest way to stop playing.
  //
  // `presenceCheckedAt` is what makes this re-evaluate as time passes, so
  // ghosts and finished duels fall off on their own.
  const freshPlayers = useMemo(() => {
    const cutoff = Date.now() - PRESENCE_FRESH_MS;
    const myEiq = user?.eiq || 0;
    return onlinePlayers
      .filter((p) => {
        const seen = tsToMillis(p.lastSeen);
        if (seen && seen < cutoff) return false;
        return !isPlayerBusy(p);
      })
      .sort((a, b) => {
        const da = Math.abs((a.eiq || 0) - myEiq);
        const dbb = Math.abs((b.eiq || 0) - myEiq);
        if (da !== dbb) return da - dbb;
        return tsToMillis(b.lastSeen) - tsToMillis(a.lastSeen);
      })
      .slice(0, ARENA_OPPONENT_LIMIT);
  }, [onlinePlayers, presenceCheckedAt, user?.eiq]);

  const filteredPlayers = freshPlayers.filter(p =>
    (p.displayName || '').toLowerCase().includes(searchTerm.toLowerCase())
  );

  // How long this player is still barred from starting or accepting a duel
  // after repeatedly walking out of live ones — see arenaLockoutRemainingMs.
  //
  // The engine already refused these actions, but only at the very end of the
  // flow: every entry point opened the drill picker, waited for a drill to be
  // chosen, fired the write, and only then turned the thrown error into an
  // alert(). So the one thing the player needed to know — that the Arena is
  // closed to them for a few more minutes — was three taps and a round trip
  // away, and looked like a failure rather than a rule. Reading it here puts
  // it on screen before anything is tapped, and the alert() paths stay as the
  // real enforcement for the case where the lock lands mid-flow.
  //
  // `presenceCheckedAt` (bumped every INVITE_SWEEP_MS) is what makes this
  // count down and then clear itself without the player having to leave and
  // come back.
  const lockoutMs = useMemo(
    () => arenaLockoutRemainingMs(user),
    [user, presenceCheckedAt]
  );
  const lockedOut = lockoutMs > 0;
  const lockoutMinutes = Math.max(1, Math.ceil(lockoutMs / 60000));

  // Open-lobby posts the user has dismissed from their own inbox are filtered
  // out here, at render, rather than inside the invites listener — see the
  // note on that effect. Invites that have aged past INVITE_TTL_MS go too:
  // the sender has long since moved on, so accepting one only drops the
  // accepter into an empty lobby to wait out the "opponent didn't join"
  // timer.
  const visibleInvites = useMemo(
    () => pendingInvites.filter((i) => !hiddenGlobalInvites.includes(i.id) && isInviteFresh(i)),
    [pendingInvites, hiddenGlobalInvites, presenceCheckedAt]
  );

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
    
    // Read the recorded WINNER, not the scoreline.
    //
    // A forfeit is settled by who walked out, not by who was ahead when they
    // did (see forfeitMatch / resolveAbandonedMatch), so re-deriving the
    // outcome from the two scores here contradicted the match itself: a
    // player who quit while leading got a "Victory" row in their own history
    // for a match they had actually lost, and the EIQ on their profile
    // disagreed with the list showing it.
    if (challenge.winner === 'draw') {
      return { label: 'Draw', color: 'text-slate-400 bg-slate-500/10 border-slate-500/20' };
    }
    if (challenge.winner === user.uid) {
      return {
        label: challenge.forfeitedBy && challenge.forfeitedBy !== user.uid ? 'Win — forfeit' : 'Victory',
        color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20',
      };
    }
    if (challenge.winner) {
      return {
        label: challenge.forfeitedBy === user.uid ? 'Loss — left' : 'Defeat',
        color: 'text-red-400 bg-red-500/10 border-red-500/20',
      };
    }

    // No winner recorded at all (a legacy row from before winners were
    // stamped) — fall back to the scoreline.
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

  // Tier pill colours, shared by the standings card and every board row so a
  // player's Bronze looks identical in both places.
  const TIER_CLS = {
    bronze:   'text-amber-600 bg-amber-600/10 border-amber-600/25',
    silver:   'text-slate-300 bg-slate-400/10 border-slate-400/25',
    gold:     'text-yellow-400 bg-yellow-400/10 border-yellow-400/30',
    platinum: 'text-cyan-300 bg-cyan-400/10 border-cyan-400/30',
    diamond:  'text-violet-300 bg-violet-400/10 border-violet-400/30',
  };
  const tierClsFor = (id) => TIER_CLS[id] || 'text-neutral-400 bg-neutral-800/40 border-neutral-700';

  // Solid equivalents of the pill colours, for the dot that replaced the TIER
  // column on each row.
  const TIER_DOT = {
    bronze: '#d97706', silver: '#cbd5e1', gold: '#facc15',
    platinum: '#67e8f9', diamond: '#c4b5fd',
  };

  // The board's column widths, declared once. The header row and every player
  // row share this grid, which is the only reason RANK / PLAYER / EIQ line up
  // with what sits under them. TIER used to be a fourth column here — it is
  // computed from EIQ, so it was the column beside it restated, and it cost
  // 72px of the width the names needed.
  const BOARD_COLS = 'grid grid-cols-[1.75rem_1fr_3.5rem] items-center gap-3';

  // Standard competition ranking: equal EIQ shares a position (1, 1, 3), so a
  // tie is not handed out as 1st/2nd/3rd in whatever order the query returned.
  const boardRanks = useMemo(() => {
    const out = [];
    let lastEiq = null;
    let lastRank = 0;
    leaderboardUsers.forEach((u, i) => {
      const e = u.eiq || 0;
      if (e !== lastEiq) { lastRank = i + 1; lastEiq = e; }
      out.push(lastRank);
    });
    return out;
  }, [leaderboardUsers]);

  // Nobody has scored at all. The board is then a list of names in arbitrary
  // order, and it must not dress itself up as a ranking.
  const boardUnplayed = leaderboardUsers.length > 0 && leaderboardUsers.every(u => !(u.eiq > 0));

  const myEiq = user?.eiq || 0;
  const myTier = tierForEiq(myEiq);
  const nextTier = EIQ_TIERS.find(t => t.minEiq > myEiq) || null;
  const tierProgress = nextTier ? Math.min(100, Math.round((myEiq / nextTier.minEiq) * 100)) : 100;

  // Where the player sits. Inside the top fifty that is just their row index;
  // below it, `ownRank` carries the server-side count (it is deliberately null
  // whenever the player IS on the board, so neither source covers both cases
  // on its own).
  const myBoardIdx = user ? leaderboardUsers.findIndex(u => u.uid === user.uid) : -1;
  const myRank = myBoardIdx >= 0 ? boardRanks[myBoardIdx] : ownRank;

  // Rank-CHANGE state for the Your Standing card: did the player's board
  // position move since they last opened Rankings? Compared against a single
  // stored number, not a history — this is a glance-level signal, not an
  // audit trail, and it drives a one-shot animation, never a continuous one.
  //
  // Guarded to run once per mount rather than on every change to myRank:
  // myRank recomputes on every leaderboard snapshot while this tab stays
  // open (onSnapshot keeps streaming), and comparing on each one would call
  // a single duel's climb "up" the instant the snapshot lands, then flip
  // back to "no change" a moment later once storage catches up to itself
  // mid-session. rankChange is null until this resolves, and stays null
  // forever when nothing moved — "no change" renders no animation, not a
  // neutral one.
  const rankCompared = useRef(false);
  const [rankChange, setRankChange] = useState(null);

  useEffect(() => {
    if (rankCompared.current || myRank === null || typeof myRank === 'undefined') return;
    rankCompared.current = true;
    try {
      const key = 'sd_arena_last_rank';
      const prev = localStorage.getItem(key);
      if (prev !== null) {
        const prevRank = Number(prev);
        if (Number.isFinite(prevRank) && prevRank !== myRank) {
          setRankChange({
            direction: myRank < prevRank ? 'up' : 'down',
            from: prevRank,
            delta: Math.abs(prevRank - myRank),
          });
        }
      }
      localStorage.setItem(key, String(myRank));
    } catch {
      // Storage unavailable — the card just shows the plain rank, no
      // functional loss beyond losing this one glance-level signal.
    }
  }, [myRank]);

  const rankTheme = rankChange ? RANK_CHANGE_THEME[rankChange.direction] : null;

  if (!ARENA_ENABLED) {
    return (
      <div className="min-h-screen bg-[#050508] text-slate-100 flex flex-col items-center justify-center p-6 text-center" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
        <div className="w-16 h-16 bg-purple-600/10 border border-purple-500/30 rounded-2xl flex items-center justify-center mb-6">
          <Swords className="w-8 h-8 text-purple-400" />
        </div>
        <h1 className="font-display text-2xl text-white mb-2">Arena — Coming Soon</h1>
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
            <div className="space-y-5 arena-view-in">
              {/* Ranks Header. The "GLOBAL STANDINGS" kicker that sat above
                  the h1 restated it, and then "Your Standing" said the word a
                  third time two inches down. The explainer line under it
                  ("Ranked by EIQ...") is gone too — the board itself and the
                  EIQ column heading already say that. */}
              <div className="flex items-center gap-2">
                <Trophy className="w-5 h-5 text-yellow-500 shrink-0" />
                <h1 className="font-display text-[28px] text-white">Arena Rankings</h1>
              </div>

              {/* Your Standing — the board is fifty rows deep and the player's
                  own row can be anywhere in it (or off it entirely). This puts
                  their tier, EIQ and the distance to the next tier at the top,
                  so the one row they always care about never has to be hunted
                  for. */}
              {user && (
                <div className="relative overflow-hidden rounded-3xl border border-purple-500/25 bg-gradient-to-br from-purple-950/30 via-[#0d0a17] to-[#09090e] shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_16px_40px_-16px_rgba(126,34,206,0.45)]">
                  {/* Summit motif — an original SkillDrills mark: angular
                      ridgelines rising to a lit apex, standing for rank,
                      progression and the climb. Purely decorative: it sits
                      behind the numbers on the right and is masked so it
                      fades out well before the name, and it is never touched
                      by the rank-change work below. */}
                  <div className="pointer-events-none absolute inset-0" aria-hidden="true">
                    <div
                      className="absolute inset-y-0 right-0 w-44"
                      style={{
                        WebkitMaskImage: 'linear-gradient(to right, transparent, #000 62%)',
                        maskImage: 'linear-gradient(to right, transparent, #000 62%)',
                      }}
                    >
                      <svg viewBox="0 0 220 170" preserveAspectRatio="xMaxYMax slice" className="h-full w-full">
                        <defs>
                          <linearGradient id="sd-summit-a" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0" stopColor="#a855f7" stopOpacity="0.42" />
                            <stop offset="1" stopColor="#a855f7" stopOpacity="0" />
                          </linearGradient>
                          <linearGradient id="sd-summit-b" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0" stopColor="#c4b5fd" stopOpacity="0.32" />
                            <stop offset="1" stopColor="#7c3aed" stopOpacity="0" />
                          </linearGradient>
                        </defs>
                        <path d="M20 170 L104 44 L188 170 Z" fill="url(#sd-summit-b)" />
                        <path d="M96 170 L150 66 L210 170 L150 170 Z" fill="url(#sd-summit-a)" />
                        <path d="M150 66 L161 82 L150 89 L139 82 Z" fill="#ede9fe" fillOpacity="0.8" />
                        <line x1="150" y1="66" x2="150" y2="34" stroke="#ede9fe" strokeOpacity="0.38" strokeWidth="1.5" />
                      </svg>
                    </div>
                  </div>

                  <div className="relative p-4">
                    <div className="mb-3.5 flex items-start justify-between">
                      <div className="flex items-center gap-1.5">
                        <Crown className="h-3.5 w-3.5 text-purple-300" />
                        <span className="text-[10px] font-black uppercase tracking-widest text-purple-300">Your Standing</span>
                      </div>
                      <span className="text-[9px] font-black uppercase tracking-[0.2em] text-neutral-500">EIQ</span>
                    </div>

                    <div className="flex items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-3">
                        {/* Position on the board — deliberately the strongest
                            element on the card, set in Anton (display face)
                            and given its own column rather than sitting inline
                            with the avatar/name. Absent only while the rank is
                            still resolving. Font size steps down for longer
                            rank numbers so it never crowds the EIQ value on a
                            narrow phone.

                            The up/down badge under the number renders only
                            when rankChange is non-null, i.e. only when this
                            visit's rank actually differs from the one stored
                            on the LAST visit (see the effect above) — never on
                            every render, and never invented when nothing
                            moved. rank-climb-in / rank-fall-in are one-shot
                            mount animations (see globals.css); they don't loop
                            and don't need to be manually removed afterward. */}
                        {myRank !== null && (
                          <div className="shrink-0">
                            <span className="mb-1 block text-[8px] font-black uppercase tracking-[0.22em] text-neutral-500">Rank</span>
                            <span
                              className={`block font-display text-white ${
                                myRank >= 1000 ? 'text-[27px]' : myRank >= 100 ? 'text-[33px]' : 'text-[42px]'
                              } ${rankChange ? (rankChange.direction === 'up' ? 'rank-climb-in' : 'rank-fall-in') : ''}`}
                            >
                              #{myRank.toLocaleString()}
                            </span>
                            {rankChange && (
                              <div
                                className={`rank-badge-in mt-1.5 inline-flex items-center gap-0.5 rounded-full border px-1.5 py-[1px] text-[8px] font-black tabular-nums ${rankTheme.text} ${rankTheme.rowBorder} ${rankTheme.rowBg}`}
                              >
                                {rankChange.direction === 'up'
                                  ? <ArrowUp className="h-2 w-2" strokeWidth={3} />
                                  : <ArrowDown className="h-2 w-2" strokeWidth={3} />}
                                {rankChange.delta}
                              </div>
                            )}
                          </div>
                        )}
                        {renderAvatar(user, 'w-11 h-11 border border-purple-500/20 shrink-0')}
                        <div className="min-w-0">
                          <div className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate text-sm font-semibold text-white">{user.displayName}</span>
                            <span className="shrink-0 rounded-full border border-purple-400/30 bg-purple-500/20 px-1.5 py-0.5 text-[8px] font-black uppercase tracking-wider text-purple-200">
                              You
                            </span>
                          </div>
                          <span className={`mt-1.5 inline-block rounded border px-1.5 py-0.5 text-[8.5px] font-black uppercase tracking-wider ${tierClsFor(myTier.id)}`}>
                            {myTier.name}
                          </span>
                        </div>
                      </div>
                      {/* EIQ is what the whole page ranks on, so on your own
                          card it stays a hero number — set in IBM Plex Mono
                          (the numeric HUD face) and kept the app-wide EIQ
                          yellow so it reads as the same value as the fifty
                          rows directly beneath it. Steps down for large
                          scores so it never collides with the rank. */}
                      <div className="shrink-0 text-right leading-none">
                        <span
                          className={`block font-hud font-semibold tabular-nums text-yellow-400 ${
                            myEiq >= 10000 ? 'text-[22px]' : myEiq >= 1000 ? 'text-[26px]' : 'text-[32px]'
                          }`}
                        >
                          {myEiq.toLocaleString()}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Footer strip: how far to the next rung. Deliberately
                      untouched by the rank-movement work above — tier and
                      rank are two different systems (see the comment on
                      RANK_CHANGE_THEME), and this bar's own progress
                      animation already existed and does its own job. Hidden
                      at Diamond, where there is no next tier to count
                      toward. */}
                  {nextTier && (
                    <div className="border-t border-purple-500/15 bg-black/20">
                      {/* A 0%-wide fill is an invisible bar, which is exactly
                          the state a new player is in. The track keeps a
                          visible floor so there is always something to grow. */}
                      <div className="h-0.5 bg-white/[.06]">
                        <div
                          className="h-full bg-purple-400 transition-all duration-500"
                          style={{ width: `${Math.max(tierProgress, 2)}%` }}
                        />
                      </div>
                      <div className="flex items-center justify-between gap-3 px-4 py-2.5">
                        <span className="text-[11px] text-neutral-400">
                          Next tier: <span className="font-bold text-white">{nextTier.name}</span>
                        </span>
                        {/* The remaining distance, not the raw fraction — the
                            hexagon that used to sit here meant nothing. */}
                        <span className="shrink-0 text-[11px] tabular-nums text-neutral-400">
                          <span className="font-bold text-white">{(nextTier.minEiq - myEiq).toLocaleString()}</span> EIQ to go
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {leaderboardUsers.length === 0 ? (
                <div className="text-center py-16 bg-[#12131c] border border-neutral-800/60 rounded-3xl">
                  <div className="w-12 h-12 bg-neutral-900 rounded-full flex items-center justify-center border border-neutral-800 mx-auto mb-3">
                    <Trophy className="w-5 h-5 text-neutral-500 animate-pulse" />
                  </div>
                  <h3 className="font-display text-base text-neutral-300">Calculating Standings</h3>
                  <p className="text-xs text-neutral-500 mt-1 max-w-xs mx-auto">
                    Play multiplayer reflex games to populate the rankings database!
                  </p>
                </div>
              ) : (
                <div className="space-y-2.5">
                  {/* Nobody has any EIQ yet, so the order below is the order
                      the query returned, not a ranking. Saying so is better
                      than printing 1st / 2nd / 3rd over a three-way tie. */}
                  {boardUnplayed && (
                    <div className="rounded-2xl border border-neutral-800/60 bg-[#12131c] px-4 py-3">
                      <p className="text-[11px] leading-relaxed text-neutral-400">
                        No duels played yet — everyone is on 0 EIQ.
                        <span className="text-white font-bold"> The first win takes the top spot.</span>
                      </p>
                    </div>
                  )}


                  {leaderboardUsers.map((userObj, idx) => {
                    const isCurrentUser = user && user.uid === userObj.uid;
                    const tier = tierForEiq(userObj.eiq);
                    const rank = boardRanks[idx];

                    // Podium accents only where a podium has actually been
                    // earned — on an all-zero board the top three rows are just
                    // the first three names.
                    const podiumBorder = boardUnplayed
                      ? 'border-neutral-800/60'
                      : rank === 1 ? 'border-yellow-500/30' : rank === 2 ? 'border-slate-400/25' : rank === 3 ? 'border-amber-600/25' : 'border-neutral-800/60';

                    // Same rank-change event as the Your Standing card above
                    // (see rankChange/RANK_CHANGE_THEME), applied here only
                    // to the player's own row. The flash animation carries
                    // its own directional entrance AND its own settle-back-
                    // to-normal keyframe (see rank-row-flash-up/-down in
                    // globals.css), so it fully replaces the plain
                    // arena-row-in entrance for this one row rather than
                    // stacking with it — two `animation` declarations on the
                    // same element would just have the second win outright,
                    // not run both. Every other row gets the plain
                    // staggered fade-in.
                    const rowAnim = isCurrentUser && rankChange
                      ? (rankChange.direction === 'up' ? 'rank-row-flash-up' : 'rank-row-flash-down')
                      : 'arena-row-in';

                    return (
                      <div
                        key={userObj.uid}
                        className={`${BOARD_COLS} p-3.5 rounded-3xl border transition-all duration-300 ${rowAnim} ${
                          isCurrentUser
                            ? 'bg-purple-950/10 border-purple-500/30 shadow-[0_0_15px_rgba(139,92,246,0.05)]'
                            : `bg-[#12131c] ${podiumBorder} hover:border-neutral-700`
                        }`}
                        style={{ animationDelay: `${Math.min(idx, 12) * 18}ms` }}
                      >
                        {/* Rank — plain numbers; first place keeps a thin gold
                            ring. Nothing at all while the board is unplayed,
                            because there is no position to report. */}
                        {boardUnplayed ? (
                          <span className="text-center text-xs font-black text-neutral-700">—</span>
                        ) : rank === 1 ? (
                          <span className="flex h-6 w-6 items-center justify-center rounded-full border border-yellow-500/50 text-[11px] font-black tabular-nums text-yellow-400">
                            1
                          </span>
                        ) : (
                          <span className="text-center text-xs font-black tabular-nums text-neutral-500">
                            {rank}
                          </span>
                        )}

                        {/* Player. The tier is a dot here rather than the pill
                            it used to be: same information, none of the width. */}
                        <div className="flex items-center gap-2.5 min-w-0">
                          {renderAvatar(userObj, 'w-9 h-9 border border-neutral-800 shrink-0')}
                          <span
                            className="h-2 w-2 shrink-0 rounded-full"
                            style={{ background: TIER_DOT[tier.id] || '#525252' }}
                            title={tier.name}
                          />
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
                        </div>

                        {/* EIQ */}
                        <span className="text-right text-sm font-black text-yellow-400 tabular-nums">
                          {(userObj.eiq || 0).toLocaleString()}
                        </span>
                      </div>
                    );
                  })}

                  {/* Outside the top fifty: a rank, deliberately without a
                      profile row. The board is a list of the fifty best, not a
                      directory of everyone — but a player still needs to see
                      where they stand and how far the climb is. */}
                  {/* The "#N" panel that used to sit here is gone — the Your
                      Standing card at the top now carries the rank in every
                      case, so this was the same number a second time. The
                      explanation for why a below-fifty player has no row of
                      their own still earns its place. */}
                  {ownRank !== null && (
                    <p className="mt-4 pt-4 border-t border-neutral-800/80 text-center text-[11px] text-neutral-600">
                      Only the top 50 are listed. Climb into them to appear on the board.
                    </p>
                  )}

                  {/* A short board leaves most of the screen black below this
                      point. Rather than let that read as an unfinished page,
                      the empty space carries the one thing it should: the way
                      to change what is on the board. */}
                  {leaderboardUsers.length < 10 && (
                    <div className="mt-4 rounded-3xl border border-neutral-800/60 bg-[#12131c] p-5 text-center">
                      <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-2xl border border-purple-500/25 bg-purple-500/10">
                        <Swords className="h-5 w-5 text-purple-300" />
                      </div>
                      <h3 className="font-display text-lg text-white">
                        {leaderboardUsers.length === 1
                          ? 'You are the only player ranked'
                          : `Only ${leaderboardUsers.length} players ranked`}
                      </h3>
                      <p className="mx-auto mt-1 max-w-xs text-[11px] leading-relaxed text-neutral-500">
                        EIQ only moves in the Arena. Win a duel and this board changes.
                      </p>
                      <button
                        onClick={() => setActiveTab('players')}
                        className="mt-4 inline-flex items-center gap-2 rounded-2xl bg-violet-600 px-5 py-2.5 text-xs font-black text-white transition hover:bg-violet-500 active:scale-[.98]"
                      >
                        Find an opponent
                        <Swords className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ──────────────────────────────────────────────────────── */}
          {/* B. MULTIPLAYER ARENA VIEW (activeTab !== 'leaderboard') */}
          {/* ──────────────────────────────────────────────────────── */}
          {activeTab !== 'leaderboard' && (
            <div className="space-y-6">
              
              {/* Arena Header. Same shape as the Rankings header: icon inline
                  with the title, no kicker above it. "Multiplayer Room" was
                  the h1 said twice, and the pulsing icon animated forever on a
                  static page. */}
              {/* No sign-out button here. Signing out is an account action,
                  not an Arena one, and a one-tap logout sitting in the corner
                  of a game screen is a misfire waiting to happen. It lives on
                  Progress, under Account, with the rest of them. */}
              <div className="flex items-center gap-2">
                <Swords className="w-5 h-5 text-purple-400 shrink-0" />
                <h1 className="font-display text-[28px] text-white">Reflex Arena</h1>
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
                  Online ({freshPlayers.length})
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

              {/* Offline state. The Arena is the one online-only surface in the
                  app — without this the screen looked completely healthy with
                  no connection, right down to "No Online Players", which reads
                  as "nobody's around" rather than "you have no internet". */}
              {!online && (
                <div className="mb-4 bg-amber-500/10 border border-amber-500/30 rounded-2xl p-4 flex items-start gap-3">
                  <div className="w-9 h-9 bg-amber-500/15 border border-amber-500/25 rounded-xl flex items-center justify-center text-amber-400 shrink-0">
                    <WifiOff className="w-4 h-4" />
                  </div>
                  <div>
                    <h4 className="text-xs font-black text-amber-300 uppercase tracking-wide">You&apos;re Offline</h4>
                    <p className="text-[11px] text-amber-200/70 mt-0.5 leading-relaxed">
                      The Arena needs an internet connection to find opponents. Turn on Wi-Fi or mobile data to duel — solo drills still work offline.
                    </p>
                  </div>
                </div>
              )}

              {/* ARENA TAB 1: FIND PLAYERS */}
              {activeTab === 'players' && (
                <div className="space-y-4">
                  {/* One "start a duel" card, not two. These were two full
                      cards with identical structure sitting on top of each
                      other — same job, one automatic and one manual — and the
                      green button put a colour the app uses nowhere else
                      (except "done") next to a violet one, so neither read as
                      the primary action. Now: one card, one primary button,
                      one quiet secondary. */}
                  <div className="rounded-3xl border border-purple-500/20 bg-[#12131c] p-5">
                    <div className="flex items-center gap-3">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-purple-500/20 bg-purple-500/10 text-purple-400">
                        <Swords className="h-5 w-5" />
                      </div>
                      <div className="min-w-0">
                        <h4 className="text-sm font-black text-white">Start a duel</h4>
                        <p className="mt-0.5 text-[11px] text-neutral-500">Get matched by EIQ, or post an invite anyone can take.</p>
                      </div>
                    </div>

                    {/* Says the rule out loud instead of letting the player
                        discover it as a failed action at the end of the flow.
                        Amber, not red: this is a cooldown that clears on its
                        own, not an error and not a punishment to alarm
                        somebody over. */}
                    {lockedOut && (
                      <p className="mt-3 rounded-2xl border border-amber-500/25 bg-amber-500/10 px-3.5 py-2.5 text-[11px] font-semibold leading-relaxed text-amber-300">
                        You left {FORFEIT_GRACE_COUNT + 1} duels early in a row. Duelling reopens in {lockoutMinutes} minute{lockoutMinutes === 1 ? '' : 's'} — finishing a match resets this.
                      </p>
                    )}

                    <div className="mt-4 flex gap-2.5">
                      <button
                        onClick={handleFindDuel}
                        disabled={!online || lockedOut}
                        className={`flex flex-1 items-center justify-center gap-2 rounded-2xl px-4 py-2.5 text-xs font-black transition active:scale-[.98] ${
                          online && !lockedOut
                            ? 'bg-violet-600 text-white hover:bg-violet-500 cursor-pointer'
                            : 'bg-neutral-800 text-neutral-500 cursor-not-allowed'
                        }`}
                      >
                        <Target className="h-3.5 w-3.5" />
                        Find Duel
                      </button>
                      <button
                        onClick={handlePostOpenChallenge}
                        disabled={!online || lockedOut}
                        className={`flex flex-1 items-center justify-center rounded-2xl border px-4 py-2.5 text-xs font-black transition active:scale-[.98] ${
                          online && !lockedOut
                            ? 'border-purple-500/30 bg-purple-500/10 text-purple-300 hover:bg-purple-500/20 cursor-pointer'
                            : 'border-neutral-800 bg-neutral-900 text-neutral-600 cursor-not-allowed'
                        }`}
                      >
                        Post Invite
                      </button>
                    </div>
                  </div>

                  {/* Search moved below the actions, and only shown when there
                      is a list to search. A search box over zero players is a
                      control that cannot do anything. */}
                  {freshPlayers.length > 0 && (
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
                  )}

                  {/* Online Opponents list */}
                  {filteredPlayers.length === 0 ? (
                    <div className="rounded-3xl border border-neutral-800/60 bg-[#12131c] px-5 py-8 text-center">
                      <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-2xl border border-neutral-800 bg-neutral-900 text-neutral-500">
                        <Users className="h-5 w-5" />
                      </div>
                      <h3 className="font-display text-lg text-white">
                        {searchTerm.trim() ? 'No match' : 'Nobody else online'}
                      </h3>
                      <p className="mx-auto mt-1 max-w-xs text-[11px] leading-relaxed text-neutral-500">
                        {searchTerm.trim()
                          ? 'No online player by that name right now.'
                          : 'Post an invite above — it stays up for anyone who comes online.'}
                      </p>
                    </div>
                  ) : (
                    <div className="grid gap-3">
                      {filteredPlayers.map((player) => {
                        const playerTier = tierForEiq(player.eiq);

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
                                {/* EIQ and tier only. The old line packed
                                    "0 EIQ · 0W - 0L (0% WR)" into ten-point
                                    text — four numbers to decide one thing:
                                    is this opponent near my level. */}
                                <p className="mt-1 flex items-center gap-1.5 text-[10px] text-neutral-500">
                                  <strong className="text-yellow-400">{(player.eiq || 0).toLocaleString()}</strong> EIQ
                                  <span
                                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                                    style={{ background: TIER_DOT[playerTier.id] || '#525252' }}
                                  />
                                  {playerTier.name}
                                </p>
                              </div>
                            </div>

                            <button
                              onClick={() => handleDuelPlayer(player)}
                              disabled={lockedOut}
                              className={`flex items-center gap-1 border px-3.5 py-2.5 rounded-xl text-xs font-black transition duration-200 shadow-md ${
                                lockedOut
                                  ? 'border-neutral-800 bg-neutral-900 text-neutral-600 cursor-not-allowed'
                                  : 'bg-purple-600/10 hover:bg-purple-600 text-purple-400 hover:text-white border-purple-500/20 active:scale-95 cursor-pointer'
                              }`}
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
                    /* Half the height it was, and it ends on a way out. The
                       old copy — "Your challenge request inbox is currently
                       empty" — was the heading above it reworded, and left the
                       tab as a dead end. */
                    <div className="rounded-3xl border border-neutral-800/60 bg-[#12131c] px-5 py-8 text-center">
                      <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-2xl border border-neutral-800 bg-neutral-900 text-neutral-500">
                        <Mail className="h-5 w-5" />
                      </div>
                      <h3 className="font-display text-lg text-white">No invites waiting</h3>
                      <p className="mx-auto mt-1 max-w-xs text-[11px] leading-relaxed text-neutral-500">
                        Duel requests sent to you land here. You don&apos;t have to wait for one.
                      </p>
                      <button
                        onClick={() => router.push('/challenge')}
                        className="mt-4 inline-flex items-center gap-2 rounded-2xl bg-violet-600 px-5 py-2.5 text-xs font-black text-white transition hover:bg-violet-500 active:scale-[.98]"
                      >
                        Start a duel
                        <Swords className="h-3.5 w-3.5" />
                      </button>
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

                            {/* Accepting is barred by the same lockout that
                                bars starting one (acceptChallenge throws
                                'arena/locked-out'), so the button says so
                                rather than failing on tap. Decline stays
                                live — turning an invite down is always
                                allowed, and is the useful action here. */}
                            <button
                              onClick={() => handleAcceptInvite(invite)}
                              disabled={lockedOut}
                              title={lockedOut ? `Duelling reopens in ${lockoutMinutes} minute${lockoutMinutes === 1 ? '' : 's'}` : undefined}
                              className={`flex items-center gap-1 px-4 py-2 text-xs font-bold rounded-xl shadow-md transition ${
                                lockedOut
                                  ? 'bg-neutral-900 border border-neutral-800 text-neutral-600 cursor-not-allowed'
                                  : 'bg-purple-600 hover:bg-purple-500 text-white cursor-pointer'
                              }`}
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
                  {/* Your Record. The old card said the same W-L three times —
                      a "0W · 0L" pill at the top, a win-rate bar, and two big
                      Wins/Losses boxes — over a record of nothing. One hero
                      number (EIQ, which is what the Arena actually ranks on)
                      and one row of three supporting stats replaces all of it.
                      Laid out to match the Your Standing card on Rankings, so
                      your EIQ looks the same on both screens. */}
                  <div className="rounded-3xl border border-neutral-800 bg-[#12131c] overflow-hidden">
                    <div className="p-5">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-1.5">
                          <Trophy className="w-3.5 h-3.5 text-yellow-500" />
                          <span className="text-[10px] font-black uppercase tracking-widest text-neutral-500">Your Record</span>
                        </div>
                        <span className={`text-[8.5px] px-1.5 py-0.5 rounded border font-black uppercase tracking-wider ${tierClsFor(myTier.id)}`}>
                          {myTier.name}
                        </span>
                      </div>

                      <div className="mt-4 leading-none">
                        <span className="block text-4xl font-black text-yellow-400 tabular-nums tracking-tight">
                          {myEiq.toLocaleString()}
                        </span>
                        <span className="mt-1.5 block text-[9px] font-black uppercase tracking-widest text-neutral-500">EIQ</span>
                      </div>
                    </div>

                    {/* The supporting three, given equal weight — none of them
                        is the headline, and the old layout made Wins/Losses
                        look like it. */}
                    <div className="grid grid-cols-3 divide-x divide-neutral-800/80 border-t border-neutral-800/80 bg-black/20">
                      <div className="px-3 py-3 text-center">
                        <span className="block text-[9px] font-black uppercase tracking-wider text-neutral-500">Wins</span>
                        <span className="mt-1 block text-base font-black tabular-nums text-emerald-400">{user?.wins || 0}</span>
                      </div>
                      <div className="px-3 py-3 text-center">
                        <span className="block text-[9px] font-black uppercase tracking-wider text-neutral-500">Losses</span>
                        <span className="mt-1 block text-base font-black tabular-nums text-red-400">{user?.losses || 0}</span>
                      </div>
                      <div className="px-3 py-3 text-center">
                        <span className="block text-[9px] font-black uppercase tracking-wider text-neutral-500">Win Rate</span>
                        <span className="mt-1 block text-base font-black tabular-nums text-violet-300">{winRate}%</span>
                      </div>
                    </div>
                  </div>

                  {/* Duel History List */}
                  <div className="space-y-3">
                    <div className="text-xs font-bold text-neutral-500 uppercase tracking-widest">Duel History</div>

                    {challengeHistory.length === 0 ? (
                      /* Was a 16-unit-tall empty box whose only job was to say
                         it was empty — the section heading above it already
                         said "Duel History", so a big card repeating "No Duel
                         History" was the same words in a bigger font. Half the
                         height now, and it ends on the way out of the empty
                         state instead of a dead end. */
                      <div className="rounded-3xl border border-neutral-800/60 bg-[#12131c] px-5 py-8 text-center">
                        <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-2xl border border-purple-500/25 bg-purple-500/10">
                          <Swords className="h-5 w-5 text-purple-300" />
                        </div>
                        <h3 className="font-display text-lg text-white">No duels yet</h3>
                        <p className="mx-auto mt-1 max-w-xs text-[11px] leading-relaxed text-neutral-500">
                          Win a duel and it lands here, with the score and the EIQ it moved.
                        </p>
                        <button
                          onClick={() => router.push('/challenge')}
                          className="mt-4 inline-flex items-center gap-2 rounded-2xl bg-violet-600 px-5 py-2.5 text-xs font-black text-white transition hover:bg-violet-500 active:scale-[.98]"
                        >
                          Find an opponent
                          <Swords className="h-3.5 w-3.5" />
                        </button>
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
                          // Someone walked out before either player finished, so
                          // no final score was ever submitted by either side.
                          // The bar would render a meaningless 0-vs-0; the
                          // outcome chip already says what happened.
                          const endedEarly = Boolean(item.forfeitedBy) && !userScore && !oppScore;
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
                                    <span className="text-[10px] text-neutral-500 font-bold shrink-0">({formattedDate})</span>
                                  </h4>
                                  <p className="text-xs text-neutral-500 mt-0.5 leading-snug truncate">
                                    <strong className="text-neutral-300 font-semibold">{item.drillName}</strong>
                                  </p>
                                  {item.status === 'completed' && endedEarly && (
                                    <p className="mt-2 text-[11px] text-neutral-500 italic">
                                      Ended early — no final scores
                                    </p>
                                  )}
                                  {item.status === 'completed' && !endedEarly && (
                                    <div className="mt-2 flex items-center gap-2 tabular-nums">
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
      {selectedOpponent && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm">
          <div className="w-full max-w-sm bg-[#0a0a12] border border-neutral-800/80 rounded-3xl p-6 text-center shadow-2xl relative">
            <div className="relative flex items-center justify-center mx-auto mb-6">
              <div className="absolute w-20 h-20 rounded-full border-4 border-t-purple-600 border-r-transparent border-b-transparent border-l-transparent animate-spin"></div>
              <div className="w-14 h-14 bg-neutral-900 rounded-full flex items-center justify-center border border-neutral-800">
                <Swords className="w-6 h-6 text-purple-500 animate-pulse" />
              </div>
            </div>

            <h3 className="font-display text-lg text-white mb-2">
              {sentChallengeId ? 'Challenge Sent' : 'Sending Challenge'}
            </h3>
            <p className="text-xs text-neutral-400 px-4 leading-relaxed">
              {challengeStatusMessage}
            </p>

            <button
              onClick={cancelSentChallenge}
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

            <h3 className="font-display text-lg text-white mb-2">
              {matchmakingState === 'found' ? 'Opponent Found!' : 'Finding an Opponent'}
            </h3>
            <p className="text-xs text-neutral-400 px-4 leading-relaxed">
              {matchmakingState === 'found'
                ? 'Connecting you both to the lobby...'
                : `Searching for a similarly-rated duelist for ${matchmakingDrill?.name || 'your drill'}... (${matchmakingSeconds}s)`}
            </p>

            {/* Also offered on 'found'. That step waits up to
                MATCH_ACCEPT_TIMEOUT_MS for the matched player to answer, and
                with no button here the only thing the player could do for
                those 20 seconds was back out of the app. */}
            <button
              onClick={cancelMatchmaking}
              className="mt-6 w-full py-2.5 bg-neutral-900 border border-neutral-800 rounded-xl text-xs font-semibold text-neutral-400 hover:text-red-400 hover:border-red-500/20 transition-all duration-200 cursor-pointer"
            >
              {matchmakingState === 'found' ? 'Cancel' : 'Cancel Search'}
            </button>
          </div>
        </div>
      )}

      {/* Transient "you're offline" notice, raised when a duel action is
          refused. Sits above the bottom nav so it isn't hidden behind it. */}
      {offlineNotice && (
        <div className="fixed bottom-24 left-4 right-4 z-[60] flex justify-center pointer-events-none">
          <div className="w-full max-w-sm bg-[#12131c] border border-amber-500/30 rounded-2xl px-4 py-3 shadow-2xl flex items-start gap-3">
            <WifiOff className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <p className="text-[11px] text-amber-100/90 leading-relaxed">{offlineNotice}</p>
          </div>
        </div>
      )}
    </div>
  );
}
