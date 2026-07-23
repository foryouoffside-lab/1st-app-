'use client';

// components/DrillWrapper.js
// SkillDrills Pro — Universal Mobile Drill Shell with Multiplayer Challenge Support
// Wraps every drill with header, HUD, and optional Real-time 1vs1 Challenge synchronizer.

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { useAuth } from '../contexts/AuthContext';
import { useChallenge } from '../contexts/ChallengeContext';
import { sendChallenge, sendGlobalChallenge, acceptChallenge, declineChallenge, submitScore, DUEL_DRILLS, tierForEiq } from '../lib/challengeEngine';
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

  // Invite Sender Drawer states (Solo Mode)
  const [showInviteDrawer, setShowInviteDrawer] = useState(false);
  const [onlinePlayers, setOnlinePlayers] = useState([]);
  const [sentChallengeId, setSentChallengeId] = useState(null);
  const [matchmakingMessage, setMatchmakingMessage] = useState('');

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
    lastUploadedScoreRef.current = -1;
    lastUploadTimeRef.current = 0;
    lastChallengeStatusRef.current = null;
  }, [challengeId]);

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
      setOpponentPhoto(host ? data.toPhoto : data.fromPhoto);

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
            updateDoc(challengeRef, { matchStartAt: Date.now() + 3000 }).catch(console.error);
          }
        } else {
          setChallengeStatus('lobby');
        }
      } else if (data.status === 'playing') {
        setChallengeStatus('playing');
      } else if (data.status === 'completed') {
        setChallengeStatus('finished');
      }
    });

    // Mark current user as ready on loading the page
    const markAsReady = async () => {
      try {
        const challengeSnap = await getDoc(challengeRef);
        if (!challengeSnap.exists()) return;
        
        const challengeData = challengeSnap.data();
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

  // 3. React to the sent challenge status via the shared ChallengeContext
  // (for solo host who invited someone). The route into the match on accept
  // is handled once, globally, by ChallengeStatusToast — this just closes
  // this page's own invite drawer and shows contextual waiting-drawer copy.
  useEffect(() => {
    if (!sentChallengeId || !outgoingChallenge || outgoingChallenge.id !== sentChallengeId) return;
    if (outgoingChallenge.status === 'accepted') {
      setSentChallengeId(null);
      setShowInviteDrawer(false);
    } else if (outgoingChallenge.status === 'declined') {
      setMatchmakingMessage("Challenge declined by opponent.");
      setTimeout(() => {
        setSentChallengeId(null);
      }, 3000);
    }
  }, [outgoingChallenge, sentChallengeId]);

  // 4. Countdown sync — both clients tick down against the same shared
  // matchStartAt timestamp (set once, above, by the host) instead of each
  // running an independent local 3-2-1. The wrapped drill itself watches
  // this same matchStartAt via useDuelMatchStart(challengeId) and calls its
  // own entry function directly once it arrives — DrillWrapper no longer
  // reaches into the DOM to synthetically click a start button.
  useEffect(() => {
    const matchStartAt = challengeData?.matchStartAt;
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
  }, [challengeStatus, challengeData?.matchStartAt, isHost, db, challengeId]);

  // 5. Real-time Score sync during gameplay
  useEffect(() => {
    if (!isChallengeMode || challengeStatus !== 'playing' || score === null || !db || !challengeId) return;

    if (score === lastUploadedScoreRef.current) return;

    const now = Date.now();
    if (now - lastUploadTimeRef.current > 800) {
      lastUploadedScoreRef.current = score;
      lastUploadTimeRef.current = now;

      const challengeRef = doc(db, 'challenges', challengeId);
      const updates = {};
      if (isHost) {
        updates.fromScore = score;
      } else {
        updates.toScore = score;
      }
      updateDoc(challengeRef, updates).catch(console.error);
    }
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
      setMatchmakingMessage("Failed to send invite.");
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
      setMatchmakingMessage("Failed to post global challenge.");
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
        router.push(`/drills/${challengeData.drillSlug}?challengeId=${newChallengeId}`);
      }
    } catch (err) {
      console.error("Failed to send rematch challenge:", err);
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
              className="flex items-center justify-center w-9 h-9 rounded-xl active:scale-90 transition-transform duration-100"
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
                className="flex items-center justify-center w-9 h-9 rounded-xl active:scale-90 transition-transform duration-100"
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
            <div className="w-16 h-16 bg-purple-600/10 border border-purple-500/30 rounded-2xl flex items-center justify-center mb-6 animate-pulse">
              <Swords className="w-8 h-8 text-purple-400" />
            </div>
            
            <h2 className="text-xl font-bold text-white mb-2">Connecting Players</h2>
            <p className="text-xs text-neutral-400 max-w-xs leading-relaxed mb-8">
              Waiting for both you and <span className="text-purple-400 font-bold">{opponentName}</span> to load into the lobby.
            </p>

            <div className="flex gap-8 items-center bg-neutral-900/40 border border-neutral-800 p-6 rounded-2xl">
              <div className="flex flex-col items-center gap-2">
                <img src={user?.photoURL} className="w-12 h-12 rounded-full border border-purple-500" />
                <span className="text-xs text-neutral-300">{user?.displayName?.split(' ')[0]}</span>
                <span className="text-[9px] bg-emerald-500/10 text-emerald-400 px-2 py-0.5 rounded-full border border-emerald-500/20 font-bold flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3" /> Ready
                </span>
              </div>
              <div className="text-xs text-neutral-500 font-black font-mono">VS</div>
              <div className="flex flex-col items-center gap-2">
                {opponentPhoto ? (
                  <img src={opponentPhoto} className="w-12 h-12 rounded-full border border-neutral-700" />
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

                  {/* Score comparison */}
                  <div className="grid grid-cols-2 gap-3 mt-4">
                    <div className={`px-4 py-4 rounded-2xl border text-center ${
                      won ? 'bg-purple-950/25 border-purple-500/40 shadow-lg shadow-purple-500/10' : 'bg-neutral-900/50 border-neutral-800'
                    }`}>
                      {user?.photoURL ? (
                        <img src={user.photoURL} className="w-11 h-11 rounded-full border border-purple-500/50 mx-auto mb-2 object-cover" />
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
                        <img src={opponentPhoto} className="w-11 h-11 rounded-full border border-neutral-700 mx-auto mb-2 object-cover" />
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

                  {/* Actions — side-by-side in landscape/wide, stacked in portrait */}
                  <div className="mt-5 flex flex-col sm:flex-row gap-2.5">
                    <button
                      onClick={() => router.push('/challenge')}
                      className="flex-1 py-3.5 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white font-bold rounded-2xl text-sm flex items-center justify-center gap-2 shadow-lg transition duration-200"
                    >
                      <Home className="w-4 h-4" />
                      Back to Arena
                    </button>
                    {challengeData?.toUid !== 'global' && (
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
                          <img src={player.photoURL} className="w-8 h-8 rounded-full border border-purple-500/20" />
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
