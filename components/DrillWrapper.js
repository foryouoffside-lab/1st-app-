'use client';

// components/DrillWrapper.js
// SkillDrills Pro — Universal Mobile Drill Shell with Multiplayer Challenge Support
// Wraps every drill with header, HUD, and optional Real-time 1vs1 Challenge synchronizer.

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { useAuth } from '../contexts/AuthContext';
import { useChallenge } from '../contexts/ChallengeContext';
import { sendChallenge, sendGlobalChallenge, acceptChallenge, declineChallenge, submitScore, resolveAbandonedMatch, forfeitMatch, getServerClockOffset, DUEL_DRILLS, tierForEiq } from '../lib/challengeEngine';
import { ARENA_ENABLED } from '../lib/featureFlags';
import { doc, onSnapshot, updateDoc, collection, query, where, limit, getDoc } from 'firebase/firestore';
import {
  ArrowLeft,
  Volume2,
  VolumeX,
  Swords,
  CheckCircle2,
  Play,
  Clock,
  Trophy,
  Home,
  Zap,
  X,
  Users,
  Repeat
} from 'lucide-react';

// How often a live duel pushes this player's running score to the challenge
// doc (effect 5 below).
//
// This was 800ms, which made it by far the most expensive thing in the app:
// ~37 writes per player over a 30s match, ~75 per match, each one also
// delivered to the opponent as a read. That single number set the ceiling on
// how many duels a day the whole app could support.
//
// It bought nothing at that rate. The mid-match score is NOT displayed
// anywhere — the snapshot listener (effect 3) deliberately swallows
// playing→playing updates, and the result screen uses the final scores
// submitted separately by submitScore at match end. The only thing that ever
// reads this running value is resolveAbandonedMatch, settling a match whose
// opponent vanished; a few seconds of staleness there just means an abandoned
// match's history row shows the score from moments before they left, which is
// as truthful as the value it replaced.
const SCORE_SYNC_INTERVAL_MS = 5000;

// How long to wait for an opponent's final score before settling the match
// without them (see effect 6b). Both duelists' clocks start at the same shared
// matchStartAt and run a fixed 30s, so a connected opponent's submit lands
// within a second or two — this window only has to absorb a slow network, not
// a difference in how long each player actually played.
const ABANDONED_MATCH_GRACE_MS = 20 * 1000;

// How long to hold the "Connecting Players" lobby open waiting for the other
// duelist to actually load the drill. Without a bound this screen waited
// forever, and a duel deliberately renders no header/back button, so a player
// whose opponent never showed up had nothing to do but back out of the app.
const LOBBY_WAIT_SECONDS = 30;

// Lead time between "both players are ready" and the match actually starting —
// the shared 3-2-1. Stamped in server time (see getServerClockOffset).
const MATCH_COUNTDOWN_MS = 3000;

// Duel-eligible drills read their own auto-start timing directly via
// lib/challengeEngine.js's useDuelMatchStart(challengeId) hook (a direct
// Firestore subscription), NOT via React Context — a drill component is the
// one that RENDERS <DrillWrapper>, i.e. it's an ANCESTOR of DrillWrapper in
// the tree, not a descendant, so a Context Provider living inside
// DrillWrapper's own returned JSX can never be seen by a useContext() call in
// the drill's own top-level component body.

export default function DrillWrapper({
  drillName     = 'Drill',
  category      = 'cognitive',
  backHref      = '/drills',
  score         = null,
  combo         = null,
  timeLeft      = null,
  lives         = null,
  maxLives      = null,
  accuracy      = null,
  soundEnabled  = true,
  onSoundToggle,
  isGameOver    = false,
  // When the drill already renders its own in-canvas HUD (score/lives/timer) and relies on the
  // global app-shell's floating exit/rotate buttons, the generic header + bottom stat bar below
  // are pure duplication during solo play. Set true to hide both outside of an active challenge,
  // where they still carry real information (duel title, live opponent score).
  minimalChrome = false,
  children,
}) {
  const router = useRouter();
  const pathname = usePathname() || '';
  const searchParams = useSearchParams();
  const challengeId = searchParams ? searchParams.get('challengeId') : null;
  const drillSlug = pathname.replace('/drills/', '');
  const isDuelEligibleDrill = DUEL_DRILLS.some((d) => d.slug === drillSlug);

  const { user, db } = useAuth();
  const { outgoingChallenge, incomingChallenges } = useChallenge();
  
  // Multiplayer states
  const [isChallengeMode, setIsChallengeMode] = useState(false);
  const [challengeData, setChallengeData] = useState(null);
  const [isHost, setIsHost] = useState(false);
  const [opponentName, setOpponentName] = useState('Opponent');
  const [opponentPhoto, setOpponentPhoto] = useState('');
  const [challengeStatus, setChallengeStatus] = useState('lobby'); // lobby, countdown, playing, finished
  const [countdownNum, setCountdownNum] = useState(3);
  const [finalScoreSubmitted, setFinalScoreSubmitted] = useState(false);
  // Seconds left for the opponent to load into the lobby before we give up on
  // them; null once the wait is over (see effect 2b).
  const [lobbySecondsLeft, setLobbySecondsLeft] = useState(LOBBY_WAIT_SECONDS);
  // This device's clock offset from the server, used to read/write the shared
  // match start instant. 0 until measured, which is the pre-existing behaviour.
  const [clockOffset, setClockOffset] = useState(0);

  // Invite Sender Drawer states (Solo Mode)
  const [showInviteDrawer, setShowInviteDrawer] = useState(false);
  const [onlinePlayers, setOnlinePlayers] = useState([]);
  const [sentChallengeId, setSentChallengeId] = useState(null);
  const [matchmakingMessage, setMatchmakingMessage] = useState('');
  // A rematch this player has offered from the result screen, while we wait for
  // the opponent to answer: { name, declined }. Null when there's nothing
  // outstanding. Kept separate from the invite drawer so the result screen can
  // show its own inline waiting/declined state.
  const [pendingRematch, setPendingRematch] = useState(null);

  // Firestore update throttle control
  const lastUploadedScoreRef = useRef(-1);
  const lastUploadTimeRef = useRef(0);
  // Last seen challenge status — lets the snapshot handler swallow the
  // playing→playing opponent-score syncs (see the listener below).
  const lastChallengeStatusRef = useRef(null);

  // 0. "Challenge Again" (and any future rematch) reuses this exact same
  // route with only the ?challengeId= query changing — Next.js does not
  // remount the component for a search-param-only navigation, so every piece
  // of state this file tracks about the PREVIOUS match would otherwise leak
  // into the new one. Two of these are especially dangerous, not just
  // cosmetic: `finalScoreSubmitted` staying true forever blocks this player's
  // score from ever being submitted for the new match (so the match can never
  // reach "finished"), and a stale `countdownNum` briefly displays the OLD
  // match's last countdown value before the new one's own tick() corrects it.
  const prevChallengeIdRef = useRef(challengeId);
  useEffect(() => {
    if (challengeId === prevChallengeIdRef.current) return;
    prevChallengeIdRef.current = challengeId;
    setIsChallengeMode(false);
    setChallengeData(null);
    setIsHost(false);
    setOpponentName('Opponent');
    setOpponentPhoto('');
    setChallengeStatus('lobby');
    setCountdownNum(3);
    setFinalScoreSubmitted(false);
    setLobbySecondsLeft(LOBBY_WAIT_SECONDS);
    setPendingRematch(null);
    setSentChallengeId(null);
    lastUploadedScoreRef.current = -1;
    lastUploadTimeRef.current = 0;
    lastChallengeStatusRef.current = null;
  }, [challengeId]);

  // 0b. Measure this device's clock offset from the server as soon as we know a
  // duel is involved, so it's ready before the shared start instant is written
  // or read. Cached inside challengeEngine, so this is one round trip per
  // session no matter how many matches get played.
  useEffect(() => {
    if (!isChallengeMode || !user) return;
    let cancelled = false;
    getServerClockOffset().then((offset) => {
      if (!cancelled) setClockOffset(offset);
    });
    return () => { cancelled = true; };
  }, [isChallengeMode, user]);

  // 1. Subscribe to online players list for the challenge drawer (solo mode)
  useEffect(() => {
    if (!db || !user || !showInviteDrawer) return;

    const q = query(
      collection(db, 'users'),
      where('online', '==', true),
      limit(20)
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const players = [];
      snapshot.forEach((doc) => {
        const data = doc.data();
        if (data.uid !== user.uid) {
          players.push(data);
        }
      });
      setOnlinePlayers(players);
    });

    return () => unsubscribe();
  }, [db, user, showInviteDrawer]);

  // 2. Check if challenge mode is active and set role
  useEffect(() => {
    if (!challengeId || !db || !user) return;

    setIsChallengeMode(true);
    const challengeRef = doc(db, 'challenges', challengeId);

    // Sync state. During live play the ONLY thing changing on this doc is
    // the opponent's score sync (~every 800ms), and nothing mid-match
    // displays it anymore — so playing→playing updates are swallowed here
    // instead of re-rendering the whole wrapper (and drill subtree) every
    // sync for data nobody can see. Status transitions (accepted/playing/
    // completed) always pass through, so the finished screen still gets
    // the final scores/winner/EIQ fields.
    const unsubscribe = onSnapshot(challengeRef, (docSnap) => {
      if (!docSnap.exists()) return;
      const data = docSnap.data();
      if (lastChallengeStatusRef.current === 'playing' && data.status === 'playing') return;
      lastChallengeStatusRef.current = data.status;
      setChallengeData(data);

      const host = data.fromUid === user.uid;
      setIsHost(host);
      setOpponentName(host ? data.toName : data.fromName);
      const nextOpponentPhoto = host ? data.toPhoto : data.fromPhoto;
      setOpponentPhoto(nextOpponentPhoto);
      // Warm the browser's image cache the instant the opponent's photo is
      // known — well before the lobby/result screens that actually render
      // it — so it's much more likely to already be loaded by the time
      // either of those show up. no-referrer since Capacitor's unusual
      // origin (https://localhost) can get a Google photo URL rejected by
      // its CDN if the Referer header is sent.
      if (nextOpponentPhoto && typeof window !== 'undefined') {
        const img = new window.Image();
        img.referrerPolicy = 'no-referrer';
        img.src = nextOpponentPhoto;
      }

      // Handle match readiness
      if (data.status === 'accepted') {
        if (data.fromReady && data.toReady) {
          setChallengeStatus('countdown');
          // Both clients must count down to — and auto-start — the exact
          // same wall-clock instant. Each client's own onSnapshot listener
          // observes "both ready" at a slightly different real time (network
          // latency), so a local "start a 3-2-1 the moment I see this" timer
          // makes the two players' drills begin a beat or two apart. Instead
          // the host stamps one shared target timestamp once; both clients
          // then count down against that same value below.
          if (host && !data.matchStartAt) {
            // Stamped in SERVER time, not this device's time. Both clients
            // convert it back through their own measured clock offset, so a
            // phone whose clock is off by seconds no longer starts seconds
            // early or late (see getServerClockOffset).
            getServerClockOffset().then((offset) => {
              updateDoc(challengeRef, {
                matchStartAt: Date.now() + offset + MATCH_COUNTDOWN_MS,
              }).catch(console.error);
            });
          }
        } else {
          setChallengeStatus('lobby');
        }
      } else if (data.status === 'playing') {
        setChallengeStatus('playing');
      } else if (data.status === 'completed') {
        setChallengeStatus('finished');
      } else if (data.status === 'declined') {
        // The opponent turned this match down. This branch didn't exist, so a
        // declined match left the player sitting in "Connecting Players" until
        // the whole 30s lobby wait expired and then blamed it on the opponent
        // not loading — even though the answer had already arrived. Show it the
        // moment it lands instead.
        setChallengeStatus('declined');
      }
    });

    // Mark current user as ready on loading the page
    const markAsReady = async () => {
      try {
        const challengeSnap = await getDoc(challengeRef);
        if (!challengeSnap.exists()) return;
        
        const challengeData = challengeSnap.data();
        // Never re-ready into a match that's already over. matchStartAt lives
        // on the doc forever, so opening a finished duel's URL again lands
        // here; useDuelMatchStart already refuses to restart the game in that
        // case, but this write would still fire — and firestore.rules now
        // rejects any write to a completed challenge, making it a guaranteed
        // console error. 'declined' is included for the same reason: there's
        // nothing left to ready up for.
        if (challengeData.status === 'completed' || challengeData.status === 'declined') return;
        const isHost = challengeData.fromUid === user.uid;

        const readyUpdates = {};
        if (isHost && !challengeData.fromReady) {
          readyUpdates.fromReady = true;
        } else if (!isHost && !challengeData.toReady) {
          readyUpdates.toReady = true;
        }

        if (Object.keys(readyUpdates).length > 0) {
          await updateDoc(challengeRef, readyUpdates);
        }
      } catch (err) {
        console.error("Failed to mark player as ready:", err);
      }
    };
    markAsReady();

    return () => unsubscribe();
  }, [challengeId, db, user]);

  // 2b. Bound the lobby wait. Counts down while we're sitting in the lobby and
  // stops at 0, which flips the lobby overlay to its "didn't join" state with a
  // real way out (see the lobby overlay below). Any progress past 'lobby'
  // cancels this, and the counter resets so a rematch gets a fresh 30s.
  useEffect(() => {
    if (!isChallengeMode || challengeStatus !== 'lobby') {
      setLobbySecondsLeft(LOBBY_WAIT_SECONDS);
      return;
    }
    const timer = setInterval(() => {
      setLobbySecondsLeft((s) => {
        if (s <= 1) {
          clearInterval(timer);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [isChallengeMode, challengeStatus]);

  // Withdraw the match and head back to the Arena after giving up on an
  // opponent who never loaded in. Marking it 'declined' (rather than leaving it
  // 'accepted') means the other player's client — if it ever does wake up —
  // sees a resolved match instead of dropping them into a duel against someone
  // who has already left, and cleanupStaleChallenges sweeps the doc shortly
  // after.
  const abandonLobby = async () => {
    if (challengeId) {
      try { await declineChallenge(challengeId); } catch (err) { console.error(err); }
    }
    router.push('/challenge');
  };

  // 3. React to an invite this player sent, via the shared ChallengeContext.
  //
  // Covers both the solo invite drawer and the result-screen Rematch. Nobody
  // gets moved into a match until the other player has actually ACCEPTED it —
  // and a decline is surfaced the instant it arrives rather than leaving the
  // sender watching a spinner.
  //
  // ChallengeStatusToast normally handles the route-on-accept globally, but it's
  // deliberately unmounted on drill routes (see AppShellClient), which is
  // exactly where Rematch is used — so the navigation has to happen here.
  useEffect(() => {
    if (!sentChallengeId || !outgoingChallenge || outgoingChallenge.id !== sentChallengeId) return;
    if (outgoingChallenge.status === 'accepted') {
      setSentChallengeId(null);
      setShowInviteDrawer(false);
      setPendingRematch(null);
      router.push(`/drills/${outgoingChallenge.drillSlug}?challengeId=${outgoingChallenge.id}`);
    } else if (outgoingChallenge.status === 'declined') {
      setMatchmakingMessage("Challenge declined by opponent.");
      setPendingRematch((prev) => (prev ? { ...prev, declined: true } : prev));
      setTimeout(() => {
        setSentChallengeId(null);
      }, 3000);
    }
  }, [outgoingChallenge, sentChallengeId, router]);

  // 4. Countdown sync — both clients tick down against the same shared
  // matchStartAt timestamp (set once, above, by the host) instead of each
  // running an independent local 3-2-1. The wrapped drill itself watches
  // this same matchStartAt via useDuelMatchStart(challengeId) and calls its
  // own entry function directly once it arrives — DrillWrapper no longer
  // reaches into the DOM to synthetically click a start button.
  useEffect(() => {
    // Converted from server time onto this device's clock, matching what
    // useDuelMatchStart hands the drill itself — otherwise this visible
    // countdown and the drill's own start would disagree on a skewed device.
    const matchStartAt = challengeData?.matchStartAt != null
      ? challengeData.matchStartAt - clockOffset
      : null;
    if (challengeStatus !== 'countdown' || !matchStartAt) return;

    let fired = false;
    const tick = () => {
      const remainingMs = matchStartAt - Date.now();
      if (remainingMs <= 0) {
        if (fired) return;
        fired = true;
        setCountdownNum(0);
        // Set status to playing in Firestore (if host)
        if (isHost && db && challengeId) {
          updateDoc(doc(db, 'challenges', challengeId), {
            status: 'playing'
          }).catch(console.error);
        }
      } else {
        setCountdownNum(Math.ceil(remainingMs / 1000));
      }
    };

    tick();
    const timer = setInterval(tick, 150);
    return () => clearInterval(timer);
  }, [challengeStatus, challengeData?.matchStartAt, clockOffset, isHost, db, challengeId]);

  // 5. Real-time score sync during gameplay — at most one write per 800ms,
  // but now with a TRAILING flush as well as the leading one.
  //
  // It used to simply drop any score change that arrived inside the 800ms
  // window, with nothing scheduled to retry it: this effect only re-runs when
  // `score` changes again, so if a player scored and then stopped (or quit)
  // shortly after a sync, the last value written to the doc stayed behind
  // their real score indefinitely. That value is exactly what
  // resolveAbandonedMatch settles a disconnected opponent's match with (see
  // effect 6b), so it has to converge on the truth rather than whatever
  // happened to land on a window boundary. Scheduling the tail write fixes
  // that; if the score moves again first, the cleanup replaces the pending
  // write with a newer one.
  useEffect(() => {
    if (!isChallengeMode || challengeStatus !== 'playing' || score === null || !db || !challengeId) return;
    if (score === lastUploadedScoreRef.current) return;

    const pushScore = () => {
      // A completed match is final — never write a score into it. The effect
      // cleanup below cancels the pending trailing write when challengeStatus
      // changes, but that only fires once the snapshot carrying the new status
      // arrives; the match can already be completed (by this client's own
      // submitScore transaction, or by the opponent's) a network round trip
      // before that. Writing in that window would overwrite a settled match's
      // final score with a mid-game value — and firestore.rules now rejects it
      // outright (challenges are immutable once completed), so without this
      // guard it's also a guaranteed permission error in the console every
      // time it happens. lastChallengeStatusRef is updated by the snapshot
      // listener and covers both who-completed-it cases.
      if (lastChallengeStatusRef.current === 'completed') return;
      lastUploadedScoreRef.current = score;
      lastUploadTimeRef.current = Date.now();
      const updates = isHost ? { fromScore: score } : { toScore: score };
      updateDoc(doc(db, 'challenges', challengeId), updates).catch(console.error);
    };

    const sinceLastUpload = Date.now() - lastUploadTimeRef.current;
    if (sinceLastUpload >= SCORE_SYNC_INTERVAL_MS) {
      pushScore();
      return;
    }

    const t = setTimeout(pushScore, SCORE_SYNC_INTERVAL_MS - sinceLastUpload);
    return () => clearTimeout(t);
  }, [score, isChallengeMode, challengeStatus, db, challengeId, isHost]);

  // 6. Final Score submit on game end
  useEffect(() => {
    const isTimedOut = timeLeft === 0;
    if (!isChallengeMode || challengeStatus !== 'playing' || finalScoreSubmitted) return;
    if (!isTimedOut && !isGameOver) return;

    const submitFinal = async () => {
      setFinalScoreSubmitted(true);
      try {
        await submitScore(challengeId, user.uid, score || 0);
      } catch (err) {
        console.error("Failed to submit final score:", err);
      }
    };
    submitFinal();
  }, [timeLeft, isGameOver, isChallengeMode, challengeStatus, finalScoreSubmitted, challengeId, user, score]);

  // 6b. Abandoned-opponent rescue. submitScore only completes a match once
  // BOTH players have reported, so an opponent who force-quits, backgrounds
  // the app, or drops connection mid-duel used to leave this player on
  // "Waiting for opponent to finish..." forever — no winner, no EIQ, no exit
  // but the Android back gesture. Both clocks start at the same shared
  // matchStartAt and run a genuinely fixed 30s, so a live opponent lands
  // within a second or two; anything past this grace window means they aren't
  // coming back. resolveAbandonedMatch settles it using their last live-synced
  // score, and no-ops if their submit landed in the meantime.
  useEffect(() => {
    if (!isChallengeMode || challengeStatus !== 'playing' || !finalScoreSubmitted) return;
    if (!challengeId || !user) return;
    const t = setTimeout(() => {
      resolveAbandonedMatch(challengeId, user.uid).catch(console.error);
    }, ABANDONED_MATCH_GRACE_MS);
    return () => clearTimeout(t);
  }, [isChallengeMode, challengeStatus, finalScoreSubmitted, challengeId, user]);

  // 6c. Leaving a live duel forfeits it.
  //
  // A duel in progress has real stakes, so walking out has to settle the match
  // rather than just abandon it: the player who left loses EIQ, the player who
  // stayed wins it, and the match is closed for good — no coming back to the
  // same challengeId for another attempt (useDuelMatchStart refuses to start a
  // completed match).
  //
  // Read through refs inside a mount-scoped cleanup so this fires once, on the
  // real unmount (Android back gesture, navigating away, the app shell tearing
  // the route down) — and never on an incidental re-render. It's a no-op unless
  // a match was genuinely mid-play and unfinished: a completed match, the lobby,
  // and the normal "time ran out and I submitted" ending all skip it.
  const forfeitStateRef = useRef({});
  forfeitStateRef.current = {
    isChallengeMode,
    challengeStatus,
    finalScoreSubmitted,
    challengeId,
    uid: user?.uid,
    pendingRematchId: pendingRematch ? sentChallengeId : null,
  };
  useEffect(() => {
    return () => {
      const s = forfeitStateRef.current;

      // A rematch offer only stands while its sender is actually waiting on it.
      // Leaving the result screen withdraws it — otherwise the invite stayed
      // live after the sender had walked off, the opponent accepted it later,
      // and they ended up alone in a lobby for a duel the sender was no longer
      // expecting (which then read as the sender "exiting" a match they never
      // knowingly agreed to).
      if (s.pendingRematchId) {
        declineChallenge(s.pendingRematchId).catch(console.error);
      }

      if (!s.isChallengeMode || s.challengeStatus !== 'playing') return;
      if (s.finalScoreSubmitted) return;
      if (!s.challengeId || !s.uid) return;
      forfeitMatch(s.challengeId, s.uid).catch(console.error);
    };
  }, []);

  // 6d. Backgrounding a SOLO drill exits it outright. Putting the app away
  // (recent-apps tray, not force-closed) doesn't unmount this component —
  // the game loop kept ticking and the audio synth kept firing its short
  // tone cues with the screen off, which read as the drill "running behind"
  // and making noise nobody asked for. Routing back out stops it cold: the
  // whole drill subtree unmounts, taking every interval/rAF loop with it.
  //
  // A duel is deliberately exempt — leaving one mid-match already forfeits
  // it via effect 6c the instant this component unmounts, and the
  // abandoned-match rescue (effect 6b) exists specifically to give a
  // backgrounded opponent a real 20s grace window rather than an instant
  // loss. Exiting here on top of that would turn every backgrounded duel
  // into an immediate forfeit instead.
  useEffect(() => {
    if (isChallengeMode) return;
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        router.replace(backHref);
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [isChallengeMode, backHref, router]);

  // 7. Hide the global floating exit-X (AppShellClient's "hide-drill-controls"
  // body class) once a duel is actually in progress, so a mistimed tap can't
  // bail a player out of a live match.
  useEffect(() => {
    if (!isChallengeMode) return;
    if (challengeStatus === 'playing') {
      document.body.classList.add('hide-drill-controls');
    } else {
      document.body.classList.remove('hide-drill-controls');
    }
    return () => document.body.classList.remove('hide-drill-controls');
  }, [isChallengeMode, challengeStatus]);

  // This button only renders on drills in DUEL_DRILLS (see isDuelEligibleDrill
  // above), so it's always inviting to *this* specific drill — no ambiguity
  // about which drill the recipient will land in.
  const handleInvitePlayer = async (player) => {
    setMatchmakingMessage(`Challenging ${player.displayName}...`);
    try {
      const newChallengeId = await sendChallenge(user, player, drillSlug, drillName);
      if (newChallengeId) {
        setSentChallengeId(newChallengeId);
        setMatchmakingMessage(`Waiting for ${player.displayName} to accept...`);
      }
    } catch (err) {
      console.error(err);
      setMatchmakingMessage(err?.code === 'arena/locked-out' ? err.message : "Failed to send invite.");
    }
  };

  const handlePostGlobalChallenge = async () => {
    setMatchmakingMessage(`Posting open challenge to the global lobby...`);
    try {
      const newChallengeId = await sendGlobalChallenge(user, drillSlug, drillName);
      if (newChallengeId) {
        setSentChallengeId(newChallengeId);
        setMatchmakingMessage("Challenge posted! Waiting for any online player to accept...");
      }
    } catch (err) {
      console.error(err);
      setMatchmakingMessage(err?.code === 'arena/locked-out' ? err.message : "Failed to post global challenge.");
    }
  };

  // The global ChallengeNotificationBanner is deliberately unmounted on
  // drill routes (AppShellClient), so an incoming rematch invite would be
  // invisible while sitting on the duel result screen. Surface it here
  // instead: any pending direct invite from the player we just duelled is
  // treated as a rematch request.
  const opponentUid = challengeData ? (isHost ? challengeData.toUid : challengeData.fromUid) : null;
  const rematchInvite = (challengeStatus === 'finished' && opponentUid && opponentUid !== 'global')
    ? (incomingChallenges || []).find((c) => c.fromUid === opponentUid) || null
    : null;

  const acceptRematchInvite = async (invite) => {
    try {
      await acceptChallenge(invite.id, user);
      router.push(`/drills/${invite.drillSlug}?challengeId=${invite.id}`);
    } catch (err) {
      console.error("Failed to accept rematch invite:", err);
      if (err?.code === 'arena/locked-out') alert(err.message);
    }
  };

  // Rematch the same opponent in the same drill straight from the finished
  // screen. If the opponent ALREADY sent us a rematch invite, both players
  // have now pressed Rematch — accept theirs instead of creating a second,
  // competing invite (which would leave two challenges waiting forever).
  const handleChallengeAgain = async () => {
    if (!challengeData) return;
    if (!opponentUid || opponentUid === 'global') return;
    if (rematchInvite) {
      await acceptRematchInvite(rematchInvite);
      return;
    }
    try {
      const newChallengeId = await sendChallenge(
        user,
        { uid: opponentUid, displayName: opponentName, photoURL: opponentPhoto },
        challengeData.drillSlug,
        challengeData.drillName
      );
      if (newChallengeId) {
        // Wait here for an answer instead of navigating straight in. This used
        // to push into the new match's URL immediately, which dropped the
        // sender into a lobby for a duel the opponent hadn't agreed to yet —
        // so they sat through the full lobby wait whether the answer was going
        // to be yes, no, or nothing at all. Effect 3 routes us in on accept and
        // flips this to a declined message on reject.
        setSentChallengeId(newChallengeId);
        setPendingRematch({ name: opponentName?.split(' ')[0] || 'Opponent', declined: false });
      }
    } catch (err) {
      console.error("Failed to send rematch challenge:", err);
      if (err?.code === 'arena/locked-out') alert(err.message);
      setPendingRematch(null);
    }
  };

  // Withdraw a rematch offer the opponent hasn't answered.
  const cancelPendingRematch = async () => {
    const id = sentChallengeId;
    setPendingRematch(null);
    setSentChallengeId(null);
    if (id) {
      try { await declineChallenge(id); } catch (err) { console.error(err); }
    }
  };

  const CATEGORY_GRADIENTS = {
    fps:              'from-red-600 to-orange-500',
    'reaction-speed': 'from-amber-500 to-orange-500',
    cognitive:        'from-indigo-600 to-violet-600',
    memory:           'from-violet-600 to-purple-600',
    visual:           'from-blue-600 to-cyan-500',
    'visual-tracking':'from-cyan-600 to-blue-500',
    academic:         'from-emerald-600 to-teal-500',
    motor:            'from-orange-600 to-amber-500',
    physical:         'from-green-600 to-emerald-500',
  };
  const grad = CATEGORY_GRADIENTS[category] || 'from-indigo-600 to-violet-600';

  return (
    <div
      className="fixed inset-0 flex flex-col select-none"
      style={{
        background: '#050508',
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
        paddingLeft: 'env(safe-area-inset-left)',
        paddingRight: 'env(safe-area-inset-right)',
      }}
    >
      {/* Top Header — hidden entirely whenever minimalChrome is set (the drill
          renders its own HUD, and the global app-shell provides exit/rotate).
          It used to reappear during a duel's non-playing states, but that made
          <main> grow/shrink by the header's height on every status change —
          most visibly a shake+resize the instant the result screen mounted
          (playing→finished). The duel overlays (lobby/countdown/waiting/result)
          are full-screen and self-contained, so the header adds nothing during
          a duel anyway. Keeping <main> a constant size kills the resize. */}
      {!minimalChrome && (
        <header
          className="flex-shrink-0 flex items-center justify-between px-4 h-12 relative z-20"
          style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}
        >
          {/* No back button during a duel — every duel-eligible drill already
              renders its own floating sound toggle, and an accidental exit
              mid-match shouldn't be one tap away (Android's own back
              gesture/button still works as the real escape hatch). */}
          {isChallengeMode ? (
            <div className="w-9 h-9" />
          ) : (
            <Link
              href={backHref}
              className="relative flex items-center justify-center w-9 h-9 rounded-xl active:scale-90 transition-transform duration-100 before:absolute before:-inset-1 before:content-['']"
              style={{ background: 'rgba(255,255,255,0.06)' }}
              aria-label="Back to drills"
            >
              <ArrowLeft className="w-4 h-4 text-gray-300" />
            </Link>
          )}

          <div className="flex flex-col items-center">
            <span className="text-xs font-bold text-white truncate max-w-[160px]">{drillName}</span>
            <span
              className={`text-[10px] font-semibold capitalize bg-gradient-to-r ${grad} bg-clip-text`}
              style={{ WebkitTextFillColor: 'transparent' }}
            >
              {isChallengeMode ? '1vs1 Duel Challenge' : category.replace(/-/g, ' ')}
            </span>
          </div>

          <div className="flex items-center gap-2">
            {/* Duel Button in Solo Mode — only on drills that support duel mode,
                and only while Arena is enabled (see lib/featureFlags.js) */}
            {ARENA_ENABLED && !isChallengeMode && user && isDuelEligibleDrill && (
              <button
                onClick={() => setShowInviteDrawer(true)}
                className="flex items-center gap-1 px-2.5 h-9 bg-purple-600/10 hover:bg-purple-600 text-purple-400 hover:text-white border border-purple-500/20 rounded-xl text-xs font-bold transition-all duration-100"
              >
                <Swords className="w-3.5 h-3.5 fill-current" />
                <span>Duel</span>
              </button>
            )}

            {/* No header sound toggle during a duel — every duel-eligible
                drill already renders its own floating mute button, so a
                second one here would just be a duplicate control. */}
            {isChallengeMode ? (
              <div className="w-9 h-9" />
            ) : (
              <button
                onClick={onSoundToggle}
                className="relative flex items-center justify-center w-9 h-9 rounded-xl active:scale-90 transition-transform duration-100 before:absolute before:-inset-1 before:content-['']"
                style={{ background: 'rgba(255,255,255,0.06)' }}
                aria-label={soundEnabled ? 'Mute sound' : 'Unmute sound'}
              >
                {soundEnabled
                  ? <Volume2 className="w-4 h-4 text-gray-300" />
                  : <VolumeX className="w-4 h-4 text-gray-500" />
                }
              </button>
            )}
          </div>
        </header>
      )}

      {/* Main Game Screen */}
      <main className="flex-1 relative overflow-hidden" style={{ touchAction: 'none' }}>
        {children}

        {/* ──────── MULTIPLAYER SCREEN OVERLAYS ──────── */}
        
        {/* LOBBY WAITING SCREEN */}
        {isChallengeMode && challengeStatus === 'lobby' && (
          <div className="absolute inset-0 bg-neutral-950/95 flex flex-col items-center justify-center p-6 z-40 text-center">
            {/* Stops pulsing once we've given up — a live "still working on it"
                animation under a "didn't join" message reads as a stuck screen. */}
            <div className={`w-16 h-16 rounded-2xl flex items-center justify-center mb-6 ${
              lobbySecondsLeft > 0
                ? 'bg-purple-600/10 border border-purple-500/30 animate-pulse'
                : 'bg-neutral-900 border border-neutral-800'
            }`}>
              <Swords className={`w-8 h-8 ${lobbySecondsLeft > 0 ? 'text-purple-400' : 'text-neutral-500'}`} />
            </div>
            
            <h2 className="text-xl font-bold text-white mb-2">
              {lobbySecondsLeft > 0 ? 'Connecting Players' : 'Opponent Didn’t Join'}
            </h2>
            {lobbySecondsLeft > 0 ? (
              <p className="text-xs text-neutral-400 max-w-xs leading-relaxed mb-2">
                Waiting for both you and <span className="text-purple-400 font-bold">{opponentName}</span> to load into the lobby.
              </p>
            ) : (
              <p className="text-xs text-neutral-400 max-w-xs leading-relaxed mb-2">
                <span className="text-purple-400 font-bold">{opponentName?.split(' ')[0]}</span> never loaded in — they may have closed the app or lost connection. No EIQ was staked.
              </p>
            )}

            {/* A visible countdown, rather than an open-ended spinner, so the
                wait reads as bounded instead of broken. */}
            {lobbySecondsLeft > 0 ? (
              <p className="text-[11px] font-mono font-bold text-neutral-500 mb-6 tabular-nums">
                Giving up in {lobbySecondsLeft}s
              </p>
            ) : (
              <button
                onClick={abandonLobby}
                className="mt-4 mb-6 px-5 py-3 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white font-bold rounded-2xl text-sm flex items-center justify-center gap-2 shadow-lg transition duration-200"
              >
                <Home className="w-4 h-4" />
                Back to Arena
              </button>
            )}

            <div className="flex gap-8 items-center bg-neutral-900/40 border border-neutral-800 p-6 rounded-2xl">
              <div className="flex flex-col items-center gap-2">
                <img src={user?.photoURL} referrerPolicy="no-referrer" className="w-12 h-12 rounded-full border border-purple-500" />
                <span className="text-xs text-neutral-300">{user?.displayName?.split(' ')[0]}</span>
                <span className="text-[9px] bg-emerald-500/10 text-emerald-400 px-2 py-0.5 rounded-full border border-emerald-500/20 font-bold flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3" /> Ready
                </span>
              </div>
              <div className="text-xs text-neutral-500 font-black font-mono">VS</div>
              <div className="flex flex-col items-center gap-2">
                {opponentPhoto ? (
                  <img src={opponentPhoto} referrerPolicy="no-referrer" className="w-12 h-12 rounded-full border border-neutral-700" />
                ) : (
                  <div className="w-12 h-12 rounded-full bg-neutral-800 border border-neutral-700 flex items-center justify-center">
                    <Swords className="w-5 h-5 text-neutral-500" />
                  </div>
                )}
                <span className="text-xs text-neutral-300">{opponentName?.split(' ')[0]}</span>
                <span className={`text-[9px] px-2 py-0.5 rounded-full font-bold ${
                  challengeData?.[isHost ? 'toReady' : 'fromReady'] 
                    ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' 
                    : 'bg-yellow-500/10 text-yellow-400 border border-yellow-500/20'
                }`}>
                  {challengeData?.[isHost ? 'toReady' : 'fromReady'] ? 'Ready' : 'Connecting...'}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* DECLINED SCREEN — the opponent turned this match down. Shown the
            instant the decline lands rather than making the player wait out the
            lobby timer and then be told the opponent "didn't join". */}
        {isChallengeMode && challengeStatus === 'declined' && (
          <div className="absolute inset-0 bg-neutral-950/95 flex flex-col items-center justify-center p-6 z-40 text-center">
            <div className="w-16 h-16 bg-red-950/40 border border-red-500/25 rounded-2xl flex items-center justify-center mb-6">
              <X className="w-8 h-8 text-red-400" />
            </div>
            <h2 className="text-xl font-bold text-white mb-2">Duel Declined</h2>
            <p className="text-xs text-neutral-400 max-w-xs leading-relaxed">
              <span className="text-red-300 font-bold">{opponentName?.split(' ')[0] || 'Your opponent'}</span> turned down this duel. No EIQ was staked.
            </p>
            <button
              onClick={() => router.push('/challenge')}
              className="mt-6 px-5 py-3 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white font-bold rounded-2xl text-sm flex items-center justify-center gap-2 shadow-lg"
            >
              <Home className="w-4 h-4" />
              Back to Arena
            </button>
          </div>
        )}

        {/* START COUNTDOWN SCREEN */}
        {isChallengeMode && challengeStatus === 'countdown' && (
          <div className="absolute inset-0 bg-neutral-950/85 flex flex-col items-center justify-center gap-3 p-6 z-40 text-center backdrop-blur-sm">
            <span className="text-[11px] font-black uppercase tracking-[0.2em] text-purple-300">Get Ready</span>
            <div className="relative w-28 h-28 rounded-full border-[3px] border-purple-500/20 flex items-center justify-center">
              <div className="absolute -inset-[3px] rounded-full border-[3px] border-transparent border-t-purple-400 border-r-purple-400 animate-spin" style={{ animationDuration: '0.7s' }} />
              <span key={countdownNum} className="fx-pop-in text-5xl font-black bg-gradient-to-b from-white to-purple-300 bg-clip-text text-transparent">
                {countdownNum > 0 ? countdownNum : 'GO'}
              </span>
            </div>
            <span className="text-[10px] text-neutral-500 font-bold uppercase tracking-wider">The duel is starting</span>
          </div>
        )}

        {/* WAITING FOR OPPONENT — shown between submitting your own final
            score and the match completing (normally a second or two, since
            both clocks start at the same shared instant). Without this the
            player would stare at a frozen, chrome-less game field. */}
        {isChallengeMode && challengeStatus === 'playing' && finalScoreSubmitted && (
          <div className="absolute inset-0 bg-neutral-950/90 flex flex-col items-center justify-center gap-4 p-6 z-40 text-center">
            <div className="relative flex items-center justify-center">
              <div className="absolute w-16 h-16 rounded-full border-4 border-t-purple-600 border-r-transparent border-b-transparent border-l-transparent animate-spin" />
              <div className="w-11 h-11 bg-neutral-900 rounded-full flex items-center justify-center border border-neutral-800">
                <Swords className="w-5 h-5 text-purple-400" />
              </div>
            </div>
            <div>
              <h3 className="text-sm font-bold text-white">Time's up!</h3>
              <p className="text-xs text-neutral-400 mt-1">Waiting for {opponentName?.split(' ')[0]} to finish...</p>
              <p className="text-[10px] text-neutral-600 mt-2 max-w-[220px] mx-auto leading-relaxed">
                If they’ve disconnected, the result is settled automatically in a few seconds.
              </p>
            </div>
          </div>
        )}

        {/* GAME FINISHED SCORE COMPARISON SCREEN.
            Layout note: the outer layer scrolls and the inner wrapper uses
            min-h-full + m-auto centering — the old `justify-center` directly
            on the scroll container clipped the top of the card whenever the
            content was taller than the viewport (exactly what happened in
            landscape). This shape centers when it fits and scrolls when it
            doesn't. */}
        {isChallengeMode && challengeStatus === 'finished' && (() => {
          const myScore = (isHost ? challengeData?.fromScore : challengeData?.toScore) ?? 0;
          const theirScore = (isHost ? challengeData?.toScore : challengeData?.fromScore) ?? 0;
          const myEiqGained = isHost ? challengeData?.fromEiqGained : challengeData?.toEiqGained;
          const myEiqAfter = isHost ? challengeData?.fromEiqAfter : challengeData?.toEiqAfter;
          const won = challengeData?.winner === user?.uid;
          const draw = challengeData?.winner === 'draw';
          const tier = typeof myEiqAfter === 'number' ? tierForEiq(myEiqAfter) : null;
          // A forfeit result can show a scoreline that contradicts the outcome
          // (you can lose while "ahead" if you walked out), so say so outright
          // instead of leaving the player to think the scoring is broken.
          const forfeitedBy = challengeData?.forfeitedBy;
          const iForfeited = forfeitedBy && forfeitedBy === user?.uid;
          const theyForfeited = forfeitedBy && forfeitedBy !== user?.uid;
          return (
            <div className="absolute inset-0 bg-[#07070d] z-40 overflow-y-auto select-none" style={{ touchAction: 'pan-y', WebkitOverflowScrolling: 'touch' }}>
              <div className="min-h-full flex items-center justify-center p-4">
                <div className="w-full max-w-md my-auto text-center">

                  {/* Outcome banner */}
                  {draw ? (
                    <div className="inline-block bg-neutral-800 border border-neutral-700 text-neutral-200 text-xs font-black uppercase tracking-widest px-4 py-1.5 rounded-full">
                      🤝 Draw
                    </div>
                  ) : won ? (
                    <div className="inline-block bg-gradient-to-r from-yellow-400 to-amber-500 text-black text-xs font-black uppercase tracking-widest px-4 py-1.5 rounded-full shadow-[0_0_24px_rgba(234,179,8,0.35)]">
                      🏆 Victory
                    </div>
                  ) : (
                    <div className="inline-block bg-red-950 border border-red-500/25 text-red-400 text-xs font-black uppercase tracking-widest px-4 py-1.5 rounded-full">
                      Defeat
                    </div>
                  )}
                  <div className="text-[10px] text-neutral-500 font-bold uppercase tracking-widest mt-2">{challengeData?.drillName}</div>

                  {/* Why the match ended this way, when it wasn't the clock */}
                  {iForfeited && (
                    <div className="mt-2 text-[11px] text-red-400/90 font-semibold max-w-xs mx-auto leading-relaxed">
                      You left the duel — leaving forfeits the match and its EIQ.
                    </div>
                  )}
                  {theyForfeited && (
                    <div className="mt-2 text-[11px] text-emerald-400/90 font-semibold max-w-xs mx-auto leading-relaxed">
                      {opponentName?.split(' ')[0]} left the duel — you win by forfeit.
                    </div>
                  )}

                  {/* Score comparison */}
                  <div className="grid grid-cols-2 gap-3 mt-4">
                    <div className={`px-4 py-4 rounded-2xl border text-center ${
                      won ? 'bg-purple-950/25 border-purple-500/40 shadow-lg shadow-purple-500/10' : 'bg-neutral-900/50 border-neutral-800'
                    }`}>
                      {user?.photoURL ? (
                        <img src={user.photoURL} referrerPolicy="no-referrer" className="w-11 h-11 rounded-full border border-purple-500/50 mx-auto mb-2 object-cover" />
                      ) : (
                        <div className="w-11 h-11 rounded-full bg-neutral-800 border border-neutral-700 flex items-center justify-center mx-auto mb-2">
                          <Swords className="w-5 h-5 text-purple-400" />
                        </div>
                      )}
                      <span className="text-[10px] text-neutral-400 block uppercase tracking-wider font-bold">You</span>
                      <span className="text-3xl font-black text-white font-mono tabular-nums">{myScore}</span>
                    </div>

                    <div className={`px-4 py-4 rounded-2xl border text-center ${
                      !won && !draw ? 'bg-rose-950/20 border-rose-500/30' : 'bg-neutral-900/50 border-neutral-800'
                    }`}>
                      {opponentPhoto ? (
                        <img src={opponentPhoto} referrerPolicy="no-referrer" className="w-11 h-11 rounded-full border border-neutral-700 mx-auto mb-2 object-cover" />
                      ) : (
                        <div className="w-11 h-11 rounded-full bg-neutral-800 border border-neutral-700 flex items-center justify-center mx-auto mb-2">
                          <Swords className="w-5 h-5 text-neutral-400" />
                        </div>
                      )}
                      <span className="text-[10px] text-neutral-400 block uppercase tracking-wider font-bold truncate px-1">{opponentName?.split(' ')[0]}</span>
                      <span className="text-3xl font-black text-white font-mono tabular-nums">{theirScore}</span>
                    </div>
                  </div>

                  {/* EIQ change — written by submitScore onto the challenge doc.
                      Winner gains, loser loses (floored at 0), draw is 0. */}
                  {typeof myEiqGained === 'number' && (
                    <div className="mt-3 flex items-center justify-center gap-2">
                      <span className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-full border text-xs font-black font-mono ${
                        myEiqGained > 0
                          ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                          : myEiqGained < 0
                            ? 'bg-red-500/10 border-red-500/25 text-red-400'
                            : 'bg-neutral-900 border-neutral-800 text-neutral-400'
                      }`}>
                        {myEiqGained > 0 ? '▲' : myEiqGained < 0 ? '▼' : '•'} {myEiqGained > 0 ? `+${myEiqGained}` : myEiqGained} EIQ
                      </span>
                      {typeof myEiqAfter === 'number' && (
                        <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-neutral-900 border border-neutral-800 text-xs font-bold text-neutral-300 font-mono">
                          <Trophy className="w-3.5 h-3.5 text-yellow-400" />
                          {myEiqAfter}
                          {tier && <span className="text-[10px] uppercase tracking-wider text-neutral-500">· {tier.name}</span>}
                        </span>
                      )}
                    </div>
                  )}

                  {/* Incoming rematch request — the global invite banner is
                      unmounted on drill routes, so it must be shown here or
                      the player never sees it until they exit. */}
                  {rematchInvite && (
                    <button
                      onClick={() => acceptRematchInvite(rematchInvite)}
                      className="mt-4 w-full py-3.5 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white font-bold rounded-2xl text-sm flex items-center justify-center gap-2 shadow-[0_0_20px_rgba(16,185,129,0.25)] animate-pulse"
                    >
                      <Swords className="w-4 h-4" />
                      {opponentName?.split(' ')[0]} wants a rematch — Accept!
                    </button>
                  )}

                  {/* An outstanding rematch offer — the answer shows up right
                      here, so nobody is left guessing whether it was seen. */}
                  {pendingRematch && (
                    pendingRematch.declined ? (
                      <div className="mt-4 rounded-2xl border border-red-500/30 bg-red-950/30 px-4 py-3.5">
                        <p className="text-xs font-bold text-red-300">
                          {pendingRematch.name} declined the rematch
                        </p>
                        <p className="text-[11px] text-neutral-400 mt-1">
                          No EIQ was staked. Head back to the Arena to find another opponent.
                        </p>
                      </div>
                    ) : (
                      <div className="mt-4 rounded-2xl border border-neutral-800 bg-neutral-900/60 px-4 py-3.5 flex items-center gap-3">
                        <div className="w-5 h-5 rounded-full border-2 border-t-purple-500 border-r-transparent border-b-transparent border-l-transparent animate-spin shrink-0" />
                        <p className="text-xs text-neutral-300 flex-1 text-left">
                          Waiting for {pendingRematch.name} to accept the rematch...
                        </p>
                        <button
                          onClick={cancelPendingRematch}
                          className="text-[11px] font-bold text-neutral-500 hover:text-red-400 shrink-0"
                        >
                          Cancel
                        </button>
                      </div>
                    )
                  )}

                  {/* Actions — side-by-side in landscape/wide, stacked in portrait */}
                  <div className="mt-5 flex flex-col sm:flex-row gap-2.5">
                    <button
                      onClick={() => router.push('/challenge')}
                      className="flex-1 py-3.5 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white font-bold rounded-2xl text-sm flex items-center justify-center gap-2 shadow-lg transition duration-200"
                    >
                      <Home className="w-4 h-4" />
                      Back to Arena
                    </button>
                    {challengeData?.toUid !== 'global' && !pendingRematch && (
                      <button
                        onClick={handleChallengeAgain}
                        className="flex-1 py-3.5 bg-neutral-900 border border-neutral-800 hover:border-purple-500/40 text-white font-bold rounded-2xl text-sm flex items-center justify-center gap-2 transition duration-200"
                      >
                        <Repeat className="w-4 h-4" />
                        Rematch
                      </button>
                    )}
                  </div>

                </div>
              </div>
            </div>
          );
        })()}

        {/* SOLO CHALLENGE INVITE DRAWER */}
        {showInviteDrawer && (
          <div
            className="absolute inset-0 bg-black/60 z-50 flex items-end sm:items-center justify-center p-4"
            style={{ touchAction: 'auto' }}
          >
            <div
              className="w-full max-w-md bg-[#0a0a12] border border-neutral-800 rounded-t-3xl sm:rounded-3xl p-6 shadow-2xl relative flex flex-col"
              style={{ maxHeight: 'min(80dvh, 560px)' }}
            >
              
              <button
                onClick={() => {
                  setShowInviteDrawer(false);
                  setSentChallengeId(null);
                }}
                className="absolute top-4 right-4 w-8 h-8 bg-neutral-900 border border-neutral-800 rounded-full flex items-center justify-center text-neutral-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>

              <div className="flex items-center gap-2 mb-4 shrink-0">
                <Swords className="w-5 h-5 text-purple-500" />
                <h3 className="font-bold text-lg text-white">Challenge Online Player</h3>
              </div>

              {sentChallengeId ? (
                <div className="py-8 flex flex-col items-center justify-center text-center">
                  <div className="relative flex items-center justify-center mb-6">
                    <div className="absolute w-16 h-16 rounded-full border-4 border-t-purple-600 border-r-transparent border-b-transparent border-l-transparent animate-spin"></div>
                    <div className="w-11 h-11 bg-neutral-900 rounded-full flex items-center justify-center border border-neutral-800">
                      <Zap className="w-5 h-5 text-purple-500 animate-pulse" />
                    </div>
                  </div>
                  <h4 className="text-sm font-semibold text-neutral-200 mb-2">Awaiting Accept</h4>
                  <p className="text-xs text-neutral-400 max-w-xs">{matchmakingMessage}</p>
                  
                  <button
                    onClick={() => {
                      if (sentChallengeId) {
                        declineChallenge(sentChallengeId).catch(console.error);
                      }
                      setSentChallengeId(null);
                    }}
                    className="mt-6 px-4 py-2 bg-neutral-900 border border-neutral-800 rounded-xl text-xs font-semibold text-neutral-400 hover:text-red-400 transition"
                  >
                    Cancel Challenge
                  </button>
                </div>
              ) : (
                <div
                  className="flex-1 overflow-y-auto min-h-0 space-y-2 pr-1 select-none"
                  style={{ touchAction: 'pan-y', WebkitOverflowScrolling: 'touch', overscrollBehavior: 'contain' }}
                >
                  {/* Public Global Challenge Pool Quick-action */}
                  <div className="bg-gradient-to-r from-purple-950/20 via-indigo-950/20 to-neutral-900/60 border border-purple-500/20 rounded-xl p-3.5 flex flex-col items-center justify-center text-center gap-2 mb-4">
                    <h4 className="text-xs font-bold text-neutral-200">Post to Global Lobby</h4>
                    <p className="text-[10px] text-neutral-400 max-w-xs">
                      Send a public challenge for this drill. Anyone online can accept it from their dashboard or screen!
                    </p>
                    <button
                      onClick={handlePostGlobalChallenge}
                      className="w-full bg-purple-600 hover:bg-purple-500 text-white text-xs font-bold py-2.5 rounded-xl transition duration-200 shadow-md flex items-center justify-center gap-1.5"
                    >
                      <Swords className="w-3.5 h-3.5" />
                      Post Open Challenge
                    </button>
                  </div>

                  <p className="text-[10px] font-semibold text-neutral-400 uppercase tracking-wider mb-2">
                    Direct Invite Friend
                  </p>
                  
                  {onlinePlayers.length === 0 ? (
                    <div className="text-center py-10">
                      <p className="text-xs text-neutral-500">No other players are online right now.</p>
                    </div>
                  ) : (
                    onlinePlayers.map((player) => (
                      <div 
                        key={player.uid}
                        className="bg-neutral-900/60 border border-neutral-800/80 rounded-xl p-3 flex items-center justify-between gap-3"
                      >
                        <div className="flex items-center gap-2">
                          <img src={player.photoURL} referrerPolicy="no-referrer" className="w-8 h-8 rounded-full border border-purple-500/20" />
                          <span className="text-xs font-bold text-neutral-200">{player.displayName}</span>
                        </div>
                        
                        <button
                          onClick={() => handleInvitePlayer(player)}
                          className="flex items-center gap-1 bg-purple-600 hover:bg-purple-500 text-white px-3 py-1.5 rounded-lg text-[10px] font-bold shadow-md"
                        >
                          <Zap className="w-3 h-3 fill-current" /> Duel
                        </button>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>
        )}

      </main>

      {/* Bottom HUD Strip — solo, non-minimalChrome drills only. During a
          duel NOTHING extra renders here: the drill's own HUD shows the
          player's score/time exactly like solo play (the live opponent
          score was deliberately dropped from mid-match — it cost a
          persistent bar plus a re-render on every opponent sync, and the
          score comparison belongs on the result screen). Score sync to
          Firestore continues regardless — it reads the score prop, not
          this bar. */}
      {(!isChallengeMode && !minimalChrome) && (
        <div
          className="flex-shrink-0 flex items-center justify-around px-6 h-12 relative z-10"
          style={{
            background: 'rgba(5,5,8,0.98)',
            borderTop: '1px solid rgba(255,255,255,0.05)',
          }}
        >
          {score !== null && (
            <HUDStat label="Score" value={score.toLocaleString()} color="#fbbf24" />
          )}
          {combo !== null && combo > 0 && (
            <HUDStat label="Combo" value={`${combo}x`} color="#fb923c" />
          )}
          {timeLeft !== null && (
            <HUDStat label="Time" value={`${timeLeft}s`} color={timeLeft <= 10 ? '#f87171' : '#60a5fa'} urgent={timeLeft <= 10} />
          )}
          {accuracy !== null && (
            <HUDStat label="Acc" value={`${accuracy}%`} color="#a3e635" />
          )}
          {lives !== null && maxLives && (
            <div className="flex items-center gap-1">
              {Array.from({ length: maxLives }).map((_, i) => (
                <div
                  key={i}
                  className="w-2 h-2 rounded-full transition-colors duration-200"
                  style={{ background: i < lives ? '#f87171' : 'rgba(255,255,255,0.12)' }}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function HUDStat({ label, value, color, urgent }) {
  return (
    <div className="flex flex-col items-center">
      <span
        className={`text-sm font-black tabular-nums ${urgent ? 'animate-pulse' : ''}`}
        style={{ color }}
      >
        {value}
      </span>
      <span className="text-[9px] font-semibold text-gray-700 uppercase tracking-wider">{label}</span>
    </div>
  );
}
