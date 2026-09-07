'use client';

// components/DrillWrapper.js
// SkillDrills Pro — Universal Mobile Drill Shell with Multiplayer Challenge Support
// Wraps every drill with header, HUD, and optional Real-time 1vs1 Challenge synchronizer.

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { useAuth } from '../contexts/AuthContext';
import { useChallenge } from '../contexts/ChallengeContext';
import { sendChallenge, sendGlobalChallenge, acceptChallenge, declineChallenge, withdrawChallenge, submitScore, resolveAbandonedMatch, forfeitMatch, getServerClockOffset, ensureMatchStart, markMatchPlaying, isInviteFresh, markInMatch, clearInMatch, BUSY_TTL_MS, DUEL_DRILLS, DUEL_DURATION_MS, tierForEiq, FORFEIT_GRACE_COUNT } from '../lib/challengeEngine';
import { ARENA_ENABLED } from '../lib/featureFlags';
import { keepAwake, allowSleep } from '../lib/keepAwake';
import { enterImmersive, exitImmersive } from '../lib/immersive';
import { useOnlineStatus } from '../lib/useOnlineStatus';
import DrillErrorBoundary from './DrillErrorBoundary';
import { doc, onSnapshot, updateDoc, collection, query, where, limit, orderBy, getDoc } from 'firebase/firestore';
import {
  ArrowLeft, Volume2, VolumeX, Swords, CheckCircle2, Trophy, Home, Zap, X,
  Repeat
} from 'lucide-react';

// There is deliberately no mid-duel score sync any more. One used to live here
// (at 800ms, then 5s) pushing this player's running score to the challenge doc,
// and it was the single most expensive thing in the app — ~6 writes per player
// per 30s match, each also delivered to the opponent as a read.
//
// Nothing ever displayed the running value: the snapshot listener (effect 3)
// swallows playing→playing updates, and the result screen uses the final
// scores submitted separately by submitScore at match end. The only place it
// surfaced was the history row of a match somebody walked out of — and both
// walk-out paths (forfeitMatch / resolveAbandonedMatch) FORCE the winner
// regardless of score, so that scoreline was decoration on an outcome it
// doesn't decide. Those rows now read 0–0 and lead with "won/lost by forfeit",
// which is the honest version anyway.
//
// Removing it cuts roughly a third of what a duel costs to run. Don't add it
// back to show a live opponent score without pricing that in first.

// How long to wait for an opponent's final score before settling the match
// without them (see effect 6b). Both duelists' clocks start at the same shared
// matchStartAt and run a fixed 30s, so a connected opponent's submit lands
// within a second or two — this window only has to absorb a slow network, not
// a difference in how long each player actually played.
// 8s, not 20s. 20s was the whole of the "stuck on a loading spinner and only
// got the result much later" complaint: if the opponent backgrounds the app
// mid-duel, effect 6c never runs (the component doesn't unmount, and duels are
// deliberately exempt from the visibilitychange exit), so THIS timer is the
// only thing that settles the match — and the player who sat through the duel
// then waited a further 20 seconds staring at "Waiting for opponent to
// finish...". The window's own justification above is that it only has to
// absorb a slow network, and a connected opponent's submit lands within a
// second or two, so 8s is still ~4x the realistic worst case while cutting the
// dead wait by more than half.
const ABANDONED_MATCH_GRACE_MS = 8 * 1000;

// How long to hold the "Connecting Players" lobby open waiting for the other
// duelist to actually load the drill. Without a bound this screen waited
// forever, and a duel deliberately renders no header/back button, so a player
// whose opponent never showed up had nothing to do but back out of the app.
const LOBBY_WAIT_SECONDS = 30;

// Lead time between "both players are ready" and the match actually starting —
// the shared 3-2-1. Stamped in server time (see getServerClockOffset).
//
// 4s rather than 3s: this lead has to cover the round trip of the stamp
// itself (writer -> server -> the OTHER player's snapshot listener) plus that
// device finishing its landscape rotation, and only what's left over is the
// visible countdown. On a slow mobile connection 3s could be entirely eaten
// by the round trip, which meant the second player's drill began a beat late
// — and in a fixed-length scored match, late is lost points.
const MATCH_COUNTDOWN_MS = 4000;

// The shared start instant and the 'playing' status are both stamped by the
// host first, since somebody has to go first and doing it from both sides at
// once is pure duplicated cost. But neither may DEPEND on the host: if that
// one device's write doesn't land, both players are stranded. So the guest
// stands by and does it instead after these delays, if it still hasn't
// happened. Both writes are transactional no-ops when the host got there
// first (see ensureMatchStart / markMatchPlaying), so the fallback can never
// double-stamp or move a value that's already set.
const MATCH_START_FALLBACK_MS = 1500;
const MATCH_PLAYING_FALLBACK_MS = 1500;

// How recent a player's presence heartbeat has to be for them to still count
// as invitable in the duel drawer. Must match the Arena's own cutoff — see
// PRESENCE_FRESH_MS in app/challenge/ChallengeArenaClient.js.
const PRESENCE_FRESH_MS = 8 * 60 * 1000;

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
  backHref      = '/',
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
  // The visible countdown is always 3 -> 2 -> 1, even though the real lead is
  // MATCH_COUNTDOWN_MS (4s, sized to cover the stamp's round trip). The extra
  // second is absorbed by holding on 3, which is why the display is capped
  // below rather than showing the raw remaining seconds.
  const [countdownNum, setCountdownNum] = useState(3);
  const [finalScoreSubmitted, setFinalScoreSubmitted] = useState(false);
  // Every retry inside submitScore failed — the result never reached the
  // server. Surfaced on the waiting screen with a manual retry.
  const [submitFailed, setSubmitFailed] = useState(false);
  // The Arena already refuses to START a search offline; this is the other
  // half — knowing the connection dropped DURING a duel, so the failure card
  // can say what actually happened instead of guessing.
  const online = useOnlineStatus();
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
    setSubmitFailed(false);
    setLobbySecondsLeft(LOBBY_WAIT_SECONDS);
    setPendingRematch(null);
    setSentChallengeId(null);
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

    // Ordered by lastSeen, same fix (and same fallback) as the Arena's own
    // online list — see the long note on that effect in ChallengeArenaClient.
    // Unordered, this pulled an arbitrary 20 out of a permanently-growing
    // `online == true` set, then discarded the stale ones below, so the
    // drawer could show nobody while players were genuinely online.
    let cancelled = false;
    let unsub = null;
    let usedFallback = false;

    const handleSnapshot = (snapshot) => {
      const players = [];
      const cutoff = Date.now() - PRESENCE_FRESH_MS;
      snapshot.forEach((docSnap) => {
        // The document ID *is* the uid. Reading a `uid` FIELD instead (what
        // this did) meant a profile doc written without one came through as
        // undefined, failed this "not me" check, and listed the player as
        // their own opponent — the same bug already fixed in the Arena's
        // copy of this listener.
        const data = { ...docSnap.data(), uid: docSnap.id };
        if (data.uid === user.uid) return;
        // `online: true` is cleared on visibilitychange/beforeunload, neither
        // of which fires when Android kills a backgrounded app — so that flag
        // alone lists players who left hours ago, and inviting one produces
        // an invite that can only ever time out. Require a recent heartbeat
        // too (written by the Arena screen; accounts with no lastSeen at all
        // predate it and are trusted as-is).
        const seen = data.lastSeen?.toMillis ? data.lastSeen.toMillis() : 0;
        if (seen && seen < cutoff) return;
        players.push(data);
      });
      setOnlinePlayers(players);
    };

    const subscribe = (ordered) => {
      const q = ordered
        ? query(collection(db, 'users'), where('online', '==', true), orderBy('lastSeen', 'desc'), limit(20))
        : query(collection(db, 'users'), where('online', '==', true), limit(20));
      return onSnapshot(q, handleSnapshot, (error) => {
        if (ordered && !usedFallback && !cancelled) {
          usedFallback = true;
          unsub = subscribe(false);
          return;
        }
        console.error('Online players fetch failed:', error);
      });
    };

    unsub = subscribe(true);

    return () => {
      cancelled = true;
      if (unsub) unsub();
    };
  }, [db, user, showInviteDrawer]);

  // 2. Check if challenge mode is active and set role
  useEffect(() => {
    if (!challengeId || !db || !user) return;

    setIsChallengeMode(true);
    const challengeRef = doc(db, 'challenges', challengeId);

    // Sync state. Nothing writes to this doc during live play any more (the
    // mid-duel score sync is gone — see the note by ABANDONED_MATCH_GRACE_MS),
    // so playing→playing updates should never arrive. The guard stays as
    // cheap insurance: it stops any stray same-status update re-rendering the
    // whole wrapper (and the drill subtree) mid-duel. Status transitions
    // (accepted/playing/completed) always pass through, so the finished
    // screen still gets the final scores/winner/EIQ fields.
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
          // Both clients must count down to — and auto-start — the exact
          // same wall-clock instant. Each client's own onSnapshot listener
          // observes "both ready" at a slightly different real time (network
          // latency), so a local "start a 3-2-1 the moment I see this" timer
          // makes the two players' drills begin a beat or two apart. Instead
          // ONE shared target timestamp is stamped on the doc (effect 2c
          // below) and both clients count down against that same value.
          setChallengeStatus('countdown');
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

  // 2b. Hold an "in a duel right now" claim on this player's profile for as
  // long as they are inside this match, and release it on the way out.
  //
  // Without it a duelling player stayed in every other player's Arena
  // opponent list: presence is a `lastSeen` stamp that keeps them listed for
  // PRESENCE_FRESH_MS (8 minutes), while a whole duel — lobby, 30 seconds of
  // play, result screen — fits inside that easily. So they were pickable, and
  // an invite sent to them was one they could never answer, because the
  // invite banner is deliberately unmounted on drill routes (AppShellClient)
  // and so never rendered. The sender just watched the invite time out.
  //
  // Covers BOTH duellists, which is why it lives here rather than only in
  // acceptChallenge: the player who SENT the invite never calls that — they
  // are routed in by ChallengeStatusToast the moment it is accepted.
  //
  // The claim is a self-expiring stamp rather than a flag (see BUSY_TTL_MS),
  // and is renewed at half its TTL so a duel that outlives it — a long
  // sit on the result screen, a rematch — never quietly makes the player
  // visible again mid-match. The cleanup clears it on any exit; if the app is
  // killed outright and the cleanup never runs, the stamp expires on its own
  // and the Arena's presence heartbeat clears it on the player's return.
  useEffect(() => {
    if (!ARENA_ENABLED || !isChallengeMode || !user?.uid) return;
    const uid = user.uid;
    markInMatch(uid);
    const renew = setInterval(() => markInMatch(uid), BUSY_TTL_MS / 2);
    return () => {
      clearInterval(renew);
      clearInMatch(uid);
    };
  }, [isChallengeMode, user?.uid]);

  // 2c. Stamp the shared match-start instant once both players have readied
  // up. Written in SERVER time (each client converts it back through its own
  // measured clock offset), so a phone whose clock is off by seconds no
  // longer starts seconds early or late — see getServerClockOffset.
  //
  // The host goes first; the guest re-attempts it shortly after if nothing
  // has appeared, so one stalled connection can't strand both players in the
  // lobby. ensureMatchStart is transactional and refuses to overwrite an
  // existing value, so the two attempts can never disagree about when the
  // match starts.
  useEffect(() => {
    if (!isChallengeMode || challengeStatus !== 'countdown') return;
    if (challengeData?.matchStartAt) return;
    if (!challengeId) return;

    const t = setTimeout(() => {
      ensureMatchStart(challengeId, MATCH_COUNTDOWN_MS).catch(console.error);
    }, isHost ? 0 : MATCH_START_FALLBACK_MS);
    return () => clearTimeout(t);
  }, [isChallengeMode, challengeStatus, challengeData?.matchStartAt, isHost, challengeId]);

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
      // A cancellation this player made themselves also lands as 'declined'
      // (see withdrawChallenge) — reporting that back as "declined by
      // opponent" blamed the opponent for the player's own Cancel.
      if (outgoingChallenge.withdrawnBySender) return;
      setMatchmakingMessage("Challenge declined by opponent.");
      setPendingRematch((prev) => (prev ? { ...prev, declined: true } : prev));
      // Clear everything the decline put on screen, not just the invite id.
      // This timer already existed but only reset sentChallengeId, so the
      // "X declined the rematch" panel it raises on the result screen had
      // nothing to take it away again and simply stayed there for good.
      const t = setTimeout(() => {
        setSentChallengeId(null);
        setPendingRematch(null);
        setMatchmakingMessage('');
      }, 3000);
      return () => clearTimeout(t);
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
    let fallbackTimer = null;
    const tick = () => {
      const remainingMs = matchStartAt - Date.now();
      if (remainingMs <= 0) {
        if (fired) return;
        fired = true;
        setCountdownNum(0);
        // Move the match to 'playing'. The host writes it immediately; the
        // guest re-attempts shortly after if it still hasn't landed. This
        // status is what gates the live score sync AND the final-score
        // submit below, so leaving it to the host alone meant a host whose
        // write failed left the GUEST unable to report the result of a match
        // they had just played in full. markMatchPlaying only ever moves
        // 'accepted' → 'playing', so the second attempt is a harmless no-op.
        if (!challengeId) return;
        if (isHost) {
          markMatchPlaying(challengeId).catch(console.error);
        } else {
          fallbackTimer = setTimeout(() => {
            if (lastChallengeStatusRef.current !== 'playing' && lastChallengeStatusRef.current !== 'completed') {
              markMatchPlaying(challengeId).catch(console.error);
            }
          }, MATCH_PLAYING_FALLBACK_MS);
        }
      } else {
        // Monotonic on purpose: a countdown may only ever go DOWN. The inputs
        // here settle at different times — matchStartAt arrives from Firestore
        // and clockOffset from the server-time probe — so the first tick can
        // legitimately compute a LARGER number than the tick before it, and
        // the player watched "3" become "4" before counting down properly.
        // Clamping to the minimum seen makes a late-arriving correction show
        // up as the countdown holding on a number for an extra beat, which
        // reads as normal, instead of running backwards.
        // Capped at 3 so the 4s lead never renders as a "4", and clamped
        // monotonic so a late-arriving matchStartAt/clockOffset correction
        // can only ever hold the number still, never run it backwards.
        //
        // The lead is divided into three EQUAL beats rather than counted in
        // whole seconds. Ticking per-second against a 4s lead spent the first
        // two seconds on "3" (4000-3001ms ceilings to 4, capped to 3; then
        // 3000-2001ms is 3 again) and only one second each on "2" and "1" —
        // which reads on device as the countdown freezing on 3 before
        // suddenly rushing. MATCH_COUNTDOWN_MS stays 4s because the sync
        // round trip needs it; only the pacing of the digits changes.
        const stepMs = MATCH_COUNTDOWN_MS / 3;
        setCountdownNum((prev) => {
          const next = Math.min(3, Math.ceil(remainingMs / stepMs));
          return prev == null ? next : Math.min(prev, next);
        });
      }
    };

    tick();
    const timer = setInterval(tick, 150);
    return () => {
      clearInterval(timer);
      if (fallbackTimer) clearTimeout(fallbackTimer);
    };
  }, [challengeStatus, challengeData?.matchStartAt, clockOffset, isHost, db, challengeId]);

  // The shared start instant, expressed on THIS device's clock.
  const matchStartLocal = challengeData?.matchStartAt != null
    ? challengeData.matchStartAt - clockOffset
    : null;

  // Is the match actually under way? Normally that's just status 'playing',
  // written at the start instant — but the drill itself doesn't wait for that
  // write (it auto-starts off matchStartAt directly, see useDuelMatchStart),
  // so between the start instant and the status write landing there's a
  // window where the player is genuinely playing while this component still
  // thinks the match hasn't begun. Everything gated on "the match is live"
  // — above all the final-score submit — has to be true in that window too,
  // or a whole match can be played and never reported.
  const duelUnderway = challengeStatus === 'playing'
    || (challengeStatus === 'countdown' && matchStartLocal != null && countdownNum === 0);

  // 6. Final Score submit on game end.
  //
  // `submitScore` retries internally, so a dropped request no longer costs
  // the player the match. If every attempt still fails, `submitFailed` puts a
  // real explanation on screen and offers a manual retry instead of leaving
  // them on an eternal "waiting for opponent" spinner while the opponent's
  // abandoned-match rescue quietly takes the win.
  const submitFinalScore = async () => {
    setFinalScoreSubmitted(true);
    setSubmitFailed(false);
    try {
      await submitScore(challengeId, user.uid, score || 0);
    } catch (err) {
      console.error("Failed to submit final score:", err);
      setSubmitFailed(true);
    }
  };
  const submitFinalScoreRef = useRef(submitFinalScore);
  submitFinalScoreRef.current = submitFinalScore;

  // 6-0. Resend the moment the connection comes back.
  //
  // The submit is a Firestore TRANSACTION, and unlike a plain write a
  // transaction needs a server round-trip — so offline it fails fast rather
  // than queueing. Three attempts over ~3.6s and the player is looking at a
  // failure card with a Retry button that, while they are still offline, can
  // only fail again. Firing on the offline->online edge means turning wifi
  // back on resends by itself.
  //
  // Edge-triggered on purpose: keyed off the transition, not the state, so a
  // write that keeps failing for some other reason (a rule saying no) cannot
  // turn this into a retry loop.
  const wasOfflineRef = useRef(false);
  useEffect(() => {
    if (!online) { wasOfflineRef.current = true; return; }
    if (!wasOfflineRef.current) return;
    wasOfflineRef.current = false;
    if (submitFailed) submitFinalScoreRef.current();
  }, [online, submitFailed]);

  useEffect(() => {
    const isTimedOut = timeLeft === 0;
    if (!isChallengeMode || !duelUnderway || finalScoreSubmitted) return;
    if (!isTimedOut && !isGameOver) return;
    submitFinalScoreRef.current();
  }, [timeLeft, isGameOver, isChallengeMode, duelUnderway, finalScoreSubmitted, challengeId, user, score]);

  // 6a. Match-end watchdog — the wrapper's own copy of the shared deadline.
  //
  // Normally the drill closes the match itself: its clock reaches zero and it
  // reports `timeLeft === 0`, which effect 6 above turns into a submit. That
  // clock now runs off the same shared end instant, so in the ordinary case
  // this watchdog never fires. It exists for the case where the drill DOESN'T
  // get there — a round transition that never completes, a stuck render, a
  // paused loop — because a duel that never ends is the one failure the
  // opponent cannot recover from except by sitting out the abandon timer and
  // taking a win the match never actually decided.
  //
  // Deliberately a second past the true deadline, so the drill's own submit
  // (carrying its final, fully-flushed score) wins the race whenever it's
  // working normally.
  useEffect(() => {
    if (!isChallengeMode || !duelUnderway || finalScoreSubmitted) return;
    if (matchStartLocal == null) return;
    const msUntilClose = (matchStartLocal + DUEL_DURATION_MS + 1000) - Date.now();
    const t = setTimeout(() => submitFinalScoreRef.current(), Math.max(0, msUntilClose));
    return () => clearTimeout(t);
  }, [isChallengeMode, duelUnderway, finalScoreSubmitted, matchStartLocal]);

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
    // Our OWN score never reached the server, so there is nothing to settle
    // in our favour — resolveAbandonedMatch would no-op anyway (it requires
    // the caller's score to be present), and calling it here would only
    // paper over the real problem with a second failed write.
    if (submitFailed) return;
    const t = setTimeout(() => {
      resolveAbandonedMatch(challengeId, user.uid).catch(console.error);
    }, ABANDONED_MATCH_GRACE_MS);
    return () => clearTimeout(t);
  }, [isChallengeMode, challengeStatus, finalScoreSubmitted, submitFailed, challengeId, user]);

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
    // `duelUnderway`, not the 'playing' status: walking out in the moment
    // between the shared start instant and that status write landing is
    // still walking out of a live match. forfeitMatch itself only acts on a
    // doc that really is 'playing', so this can never forfeit a match that
    // hasn't begun.
    duelUnderway,
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
      // withdrawChallenge, not declineChallenge: if the opponent accepted the
      // rematch in the same instant we walked away, a blind "declined" write
      // would tear down a match they were already being routed into. This
      // only cancels an invite still sitting unanswered.
      if (s.pendingRematchId) {
        withdrawChallenge(s.pendingRematchId).catch(console.error);
      }

      if (!s.isChallengeMode || !s.duelUnderway) return;
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

  // 6e. Hold the screen awake for as long as a drill route is open.
  //
  // Plenty of drills go tens of seconds with no touch at all - the player is
  // tracking a ball, memorising a grid, waiting on a stimulus - so Android
  // sees an idle screen, dims it, and then locks it in the middle of a run.
  // FLAG_KEEP_SCREEN_ON (native) / the wake-lock sentinel (browser) is
  // released the moment this wrapper unmounts, so it costs nothing once the
  // player is back in the menus. See lib/keepAwake.js.
  useEffect(() => {
    keepAwake();
    return () => allowSleep();
  }, []);

  // 6f. Edge-to-edge full screen for the whole drill route.
  //
  // The drills hid the status bar individually but nothing ever hid the
  // navigation bar, so every board was drawn into the screen minus the gesture
  // pill, and two drills never went full screen at all. Doing it once here is
  // what makes all 24 consistent.
  //
  // On mount rather than at START on purpose: hiding the bars changes the
  // WebView's usable height, and that resize has to land while the start card
  // is up, not under the 3-2-1 overlay (see the countdown-shake work in
  // afterViewportSettled). The bars come back on unmount.
  useEffect(() => {
    enterImmersive();
    return () => exitImmersive();
  }, []);

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
    ? (incomingChallenges || []).find((c) => c.fromUid === opponentUid && isInviteFresh(c)) || null
    : null;

  const acceptRematchInvite = async (invite) => {
    try {
      await acceptChallenge(invite.id, user);
      router.push(`/drills/${invite.drillSlug}?challengeId=${invite.id}`);
    } catch (err) {
      console.error("Failed to accept rematch invite:", err);
      if (err?.code === 'arena/locked-out' || err?.code === 'challenge/taken' || err?.code === 'challenge/expired') {
        alert(err.message);
      }
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
      try { await withdrawChallenge(id); } catch (err) { console.error(err); }
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
        {/* One boundary for every drill — a crash in here used to unmount the
            whole subtree and leave the black screen with nothing to tap. */}
        <DrillErrorBoundary drillName={drillName} backHref={backHref}>
          {children}
        </DrillErrorBoundary>

        {/* ──────── MULTIPLAYER SCREEN OVERLAYS ──────── */}
        
        {/* LOBBY WAITING SCREEN */}
        {isChallengeMode && challengeStatus === 'lobby' && (
          <div className="absolute inset-0 bg-black flex flex-col items-center justify-center p-6 z-40 text-center">
            {/* Stops pulsing once we've given up — a live "still working on it"
                animation under a "didn't join" message reads as a stuck screen. */}
            {/* The two-player card IS the status — it names who is still
                missing — so the 64px pulsing icon and the sentence restating
                it are both gone. Same card-with-VS-divider shape as the result
                screen, and it now fits the 423px landscape viewport the duel
                drills actually run in. */}
            <h2 className="font-display text-[28px] text-white">
              {lobbySecondsLeft > 0 ? 'Connecting Players' : 'Opponent Didn’t Join'}
            </h2>

            {/* FACE-OFF, on ONE line in every orientation.
                The two players sit opposite each other side by side — including
                in portrait, where this previously stacked one above the other.
                Stacking was the wrong call twice over: it read as a list rather
                than a matchup, and because each row was centred as a unit, the
                two avatars landed at different x-positions whenever the names
                were different lengths ("biradar" vs "For"), which looked
                misaligned. Equal flex-1 columns with the VS between them keeps
                both avatars on the same optical line whatever the names are.
                No card chrome at all — no border, no panel background, no
                rounded box. On a black screen the boxed version read as a grey
                square floating on top of the drill; the two players and the VS
                between them are enough structure on their own. */}
            <div className="mt-5 w-full max-w-xl">
              <div className="flex flex-row items-stretch">
                <div className="flex flex-col items-center justify-start gap-2.5 px-3 py-4 flex-1 min-w-0">
                  <img src={user?.photoURL} referrerPolicy="no-referrer" className="w-16 h-16 rounded-full object-cover ring-2 ring-emerald-400/70 shrink-0" />
                  <div className="text-center min-w-0 w-full">
                    <span className="block text-[12.5px] font-bold text-white truncate">{user?.displayName?.split(' ')[0]}</span>
                    <span className="mt-1.5 inline-flex items-center gap-1 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[9px] font-black uppercase tracking-wider text-emerald-400">
                      <CheckCircle2 className="w-3 h-3" /> Ready
                    </span>
                  </div>
                </div>

                <div className="flex flex-col items-center justify-center gap-2 px-1 shrink-0">
                  <div className="w-px flex-1 bg-neutral-800" />
                  <span className="text-[9px] label-tiny text-neutral-600">vs</span>
                  <div className="w-px flex-1 bg-neutral-800" />
                </div>

                <div className={`flex flex-col items-center justify-start gap-2.5 px-3 py-4 flex-1 min-w-0 transition-opacity duration-300 ${
                  challengeData?.[isHost ? 'toReady' : 'fromReady'] ? '' : 'opacity-55'
                }`}>
                  {opponentPhoto ? (
                    <img src={opponentPhoto} referrerPolicy="no-referrer" className={`w-16 h-16 rounded-full object-cover shrink-0 ring-2 ${
                      challengeData?.[isHost ? 'toReady' : 'fromReady'] ? 'ring-emerald-400/70' : 'ring-amber-400/50'
                    }`} />
                  ) : (
                    <div className={`w-16 h-16 rounded-full bg-neutral-900 flex items-center justify-center shrink-0 ring-2 ${
                      challengeData?.[isHost ? 'toReady' : 'fromReady'] ? 'ring-emerald-400/70' : 'ring-amber-400/50'
                    }`}>
                      <Swords className="w-5 h-5 text-neutral-500" />
                    </div>
                  )}
                  <div className="text-center min-w-0 w-full">
                  <span className="block text-[12.5px] font-bold text-white truncate">{opponentName?.split(' ')[0]}</span>
                  <span className={`mt-1.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[9px] font-black uppercase tracking-wider ${
                    challengeData?.[isHost ? 'toReady' : 'fromReady']
                      ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                      : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                  }`}>
                  {/* A live dot ONLY while we're genuinely still waiting. Once
                      the lobby has given up, everything stops moving — a
                      "still working on it" animation under an "Opponent Didn't
                      Join" heading reads as a stuck screen (same reason the
                      old 64px pulsing icon was removed). */}
                  {!challengeData?.[isHost ? 'toReady' : 'fromReady'] && lobbySecondsLeft > 0 && (
                    <span className="w-1 h-1 rounded-full bg-amber-400 animate-pulse" />
                  )}
                    {challengeData?.[isHost ? 'toReady' : 'fromReady'] ? 'Ready' : 'Connecting'}
                  </span>
                  </div>
                </div>
              </div>

            </div>

            {/* The remaining wait as plain quiet text, not a progress bar.
                A full-width purple bar was the brightest thing on an otherwise
                black screen and pulled the eye away from the two players, who
                are the point of this card. The wait is still bounded and still
                visible — it just doesn't shout. */}
            {lobbySecondsLeft > 0 && (
              <p className="mt-4 text-[11px] font-medium text-neutral-600 tabular-nums">
                Giving up in {lobbySecondsLeft}s
              </p>
            )}

            {lobbySecondsLeft <= 0 && (
              <>
                <p className="mt-3 max-w-xs text-xs leading-relaxed text-neutral-400">
                  <span className="font-bold text-purple-400">{opponentName?.split(' ')[0]}</span> never loaded in — they may have closed the app or lost connection. No EIQ was staked.
                </p>
                <button
                  onClick={abandonLobby}
                  className="mt-4 px-5 py-2.5 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white font-bold rounded-2xl text-sm flex items-center justify-center gap-2 shadow-lg transition duration-200"
                >
                  <Home className="w-4 h-4" />
                  Back to Arena
                </button>
              </>
            )}
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
            <h2 className="font-display text-2xl text-white mb-2">Duel Declined</h2>
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

        {/* START COUNTDOWN SCREEN. Dismissed on `duelUnderway`, not on the
            'playing' status write: the drill under this overlay auto-starts
            from matchStartAt directly, so waiting for that write to round-trip
            left a "GO" card sitting on top of a match that was already live
            and already scoring. */}
        {isChallengeMode && challengeStatus === 'countdown' && !duelUnderway && (
          <div className="absolute inset-0 bg-neutral-950/85 flex flex-col items-center justify-center gap-3 p-6 z-40 text-center backdrop-blur-sm">
            <span className="text-[11px] font-black uppercase tracking-[0.2em] text-purple-300">Get Ready</span>
            <div className="relative w-28 h-28 rounded-full border-[3px] border-purple-500/20 flex items-center justify-center">
              <div className="absolute -inset-[3px] rounded-full border-[3px] border-transparent border-t-purple-400 border-r-purple-400 animate-spin" style={{ animationDuration: '0.7s' }} />
              {/* Solid white, not `bg-clip-text text-transparent` over a
                  gradient. background-clip:text paints nothing at all in
                  Android's WebView when the element is also running a scale
                  animation inside a backdrop-filter parent — which is this
                  exact node — so the digit rendered as a transparent glyph
                  and the player saw an empty ring counting down. A plain
                  colour with a glow cannot fail to paint. */}
              <span
                key={countdownNum}
                className="fx-count-pop text-5xl font-display text-white tabular-nums"
                style={{ textShadow: '0 0 18px rgba(168,85,247,0.55)' }}
              >
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
        {isChallengeMode && duelUnderway && challengeStatus !== 'finished' && finalScoreSubmitted && (
          <div className="absolute inset-0 bg-neutral-950/90 flex flex-col items-center justify-center gap-4 p-6 z-40 text-center">
            {submitFailed ? (
              <>
                <div className="w-14 h-14 bg-red-950/40 border border-red-500/25 rounded-2xl flex items-center justify-center">
                  <X className="w-7 h-7 text-red-400" />
                </div>
                {/* Says which failure this is. Offline it used to advise
                    "check your connection and try again" next to a Retry that
                    could only fail the same way, with no other control on the
                    screen — the player's only way out was to kill the app. */}
                <div>
                  <h3 className="font-display text-lg text-white">
                    {online ? 'Couldn’t send your score' : 'You’re offline'}
                  </h3>
                  <p className="text-xs text-neutral-400 mt-1 max-w-[250px] mx-auto leading-relaxed">
                    Your final score of <span className="font-bold text-white tabular-nums">{score ?? 0}</span>{' '}
                    {online
                      ? 'didn’t reach the server. Try again.'
                      : 'can’t be sent without a connection. Turn wifi or mobile data back on and it sends itself.'}
                  </p>
                </div>
                <button
                  onClick={() => submitFinalScoreRef.current()}
                  disabled={!online}
                  className={`px-5 py-3 font-bold rounded-2xl text-sm flex items-center justify-center gap-2 shadow-lg ${
                    online
                      ? 'bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white'
                      : 'bg-neutral-800 text-neutral-500 cursor-not-allowed'
                  }`}
                >
                  <Repeat className="w-4 h-4" />
                  Retry
                </button>
                {/* An explicit exit. Force-quitting the app was already the
                    only escape, and it has exactly this outcome — the
                    opponent's abandoned-match rescue settles the duel after
                    the grace window. This changes nothing about the result,
                    it just stops the screen being a trap and says plainly
                    what leaving costs. */}
                <button
                  onClick={() => router.push('/challenge')}
                  className="text-[11px] font-bold text-neutral-500 hover:text-neutral-300 transition-colors"
                >
                  Leave duel — opponent takes the win
                </button>
              </>
            ) : (
              <>
                <div className="relative flex items-center justify-center">
                  <div className="absolute w-16 h-16 rounded-full border-4 border-t-purple-600 border-r-transparent border-b-transparent border-l-transparent animate-spin" />
                  <div className="w-11 h-11 bg-neutral-900 rounded-full flex items-center justify-center border border-neutral-800">
                    <Swords className="w-5 h-5 text-purple-400" />
                  </div>
                </div>
                <div>
                  <h3 className="font-display text-lg text-white">Time's up!</h3>
                  <p className="text-xs text-neutral-400 mt-1">Waiting for {opponentName?.split(' ')[0]} to finish...</p>
                  <p className="text-[10px] text-neutral-600 mt-2 max-w-[220px] mx-auto leading-relaxed">
                    If they’ve disconnected, the result is settled automatically in a few seconds.
                  </p>
                </div>
              </>
            )}
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
          return (
            <div className="absolute inset-0 bg-[#07070d] z-40 overflow-y-auto select-none" style={{ touchAction: 'pan-y', WebkitOverflowScrolling: 'touch' }}>
              <div className="min-h-full flex items-center justify-center p-4">
                {/* max-w-3xl, not max-w-md: a duel result renders in the 900x423
                    LANDSCAPE viewport the duel drills run in, and a 448px column
                    there left two thirds of the screen empty while crushing the
                    scoreline into a narrow strip. The card is laid out wide
                    below and falls back to stacked on genuinely narrow screens. */}
                <div className="w-full max-w-2xl my-auto text-center">

                  {/* Outcome. This is the one thing the player opened the
                      screen to find out, so it gets to be the biggest thing on
                      it — it used to be a 12px pill, smaller than the two score
                      numbers underneath it. */}
                  {/* Outcome as a colour-coded chip beside the drill name.
                      This used to be a 3xl glowing yellow word, deliberately
                      made "the biggest thing on the screen". That reasoning is
                      superseded rather than forgotten: the scoreline below is
                      now the hero at 5xl and the winning side is the only one
                      rendered in white, so the result still reads instantly —
                      while the glow (which read arcade rather than premium)
                      and the height it ate in a 423px landscape viewport are
                      both gone. */}
                  <div className="flex items-center justify-center gap-2.5">
                    <span className={`inline-flex items-center rounded-full border px-3 py-1 text-[11px] label-tiny ${
                      draw ? 'border-neutral-700 bg-white/[0.04] text-neutral-300'
                        : won ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-400'
                        : 'border-rose-500/25 bg-rose-500/10 text-rose-400'
                    }`}>
                      {draw ? 'Draw' : won ? 'Victory' : 'Defeat'}
                    </span>
                    <span className="text-[10px] label-tiny text-neutral-600 truncate">
                      {challengeData?.drillName}
                    </span>
                  </div>

                  {/* Why the match ended this way, when it wasn't the clock */}
                  {iForfeited && (
                    <div className="mt-2 text-[11px] text-red-400/90 font-semibold max-w-xs mx-auto leading-relaxed">
                      You left the duel — leaving forfeits the match and its EIQ.
                      {/* The lockout is forgiven for the first few in a row, so
                          the one that actually triggers it must not arrive
                          unannounced. Warned only on the last free one, which
                          is the moment the player can still act on it.
                          forfeitStreak is already the post-match value here. */}
                      {user?.forfeitStreak === FORFEIT_GRACE_COUNT && (
                        <span className="mt-1 block text-amber-400/90">
                          Leave one more in a row and the Arena locks for 30 minutes.
                        </span>
                      )}
                    </div>
                  )}
                  {/* A win where the opponent walked out is shown as an
                      ORDINARY win: no "you win by forfeit" line, and no
                      "duel ended early" panel replacing the scoreboard. The
                      winner sees the same card they'd see after any other
                      duel — the EIQ still moves, the player who left still
                      pays for it. Only the person who actually left is told
                      why (see iForfeited above), since they'd otherwise lose
                      EIQ with no explanation at all. */}
                  {(
                  /* One scoreboard instead of two floating boxes, with the
                     EIQ result carried in its own footer strip — the same
                     card-plus-footer shape as Your Standing on the Rankings
                     page. The winning side takes the accent wash, so the
                     result reads from the card's colour before any number is
                     parsed. */
                  <div className="mt-3 rounded-3xl border border-neutral-800 bg-[#12131c] overflow-hidden">
                    {/* "Broadcast" layout: the two players FACE each other across
                        the full width — avatar and name on the outside, scores
                        meeting in the middle — instead of two stacked centred
                        columns. A duel result renders in a 900x423 landscape
                        viewport, where the old narrow grid left most of the
                        width empty and shrank the scoreline to 3xl. Stacks
                        vertically below `sm` for any portrait case. */}
                    <div className="flex flex-col sm:flex-row sm:items-stretch">
                      <div className={`flex items-center gap-3 px-4 py-3.5 sm:flex-1 ${won ? 'bg-purple-500/[0.07]' : ''}`}>
                        {user?.photoURL ? (
                          <img src={user.photoURL} referrerPolicy="no-referrer" className={`w-12 h-12 rounded-full object-cover shrink-0 ${
                            won ? 'ring-2 ring-purple-400' : 'ring-1 ring-neutral-700'
                          }`} />
                        ) : (
                          <div className={`w-12 h-12 rounded-full bg-neutral-800 flex items-center justify-center shrink-0 ${
                            won ? 'ring-2 ring-purple-400' : 'ring-1 ring-neutral-700'
                          }`}>
                            <Swords className="w-5 h-5 text-purple-400" />
                          </div>
                        )}
                        <div className="min-w-0 text-left">
                          <div className="text-[13px] font-bold text-white truncate">{user?.displayName?.split(' ')[0] || 'You'}</div>
                          <div className="mt-0.5 text-[10px] label-tiny text-neutral-500">You</div>
                        </div>
                        <div className={`ml-auto text-4xl font-display tabular-nums leading-none ${
                          draw || won ? 'text-white' : 'text-neutral-600'
                        }`}>{myScore}</div>
                      </div>

                      {/* Divider carries the VS, so the two sides read as one
                          match rather than two separate results. */}
                      <div className="flex sm:flex-col items-center justify-center gap-2 px-3 sm:px-1">
                        <div className="hidden sm:block w-px flex-1 bg-neutral-800" />
                        <div className="sm:hidden h-px flex-1 bg-neutral-800" />
                        <span className="text-[9px] label-tiny text-neutral-600">vs</span>
                        <div className="hidden sm:block w-px flex-1 bg-neutral-800" />
                        <div className="sm:hidden h-px flex-1 bg-neutral-800" />
                      </div>

                      <div className={`flex items-center gap-3 px-4 py-3.5 sm:flex-1 sm:flex-row-reverse ${!won && !draw ? 'bg-rose-500/[0.07]' : ''}`}>
                        {opponentPhoto ? (
                          <img src={opponentPhoto} referrerPolicy="no-referrer" className={`w-12 h-12 rounded-full object-cover shrink-0 ${
                            !won && !draw ? 'ring-2 ring-rose-400' : 'ring-1 ring-neutral-700'
                          }`} />
                        ) : (
                          <div className={`w-12 h-12 rounded-full bg-neutral-800 flex items-center justify-center shrink-0 ${
                            !won && !draw ? 'ring-2 ring-rose-400' : 'ring-1 ring-neutral-700'
                          }`}>
                            <Swords className="w-5 h-5 text-neutral-400" />
                          </div>
                        )}
                        <div className="min-w-0 text-left sm:text-right">
                          <div className="text-[13px] font-bold text-white truncate">{opponentName?.split(' ')[0]}</div>
                          <div className="mt-0.5 text-[10px] label-tiny text-neutral-500">Opponent</div>
                        </div>
                        <div className={`ml-auto sm:ml-0 sm:mr-auto text-4xl font-display tabular-nums leading-none ${
                          draw || !won ? 'text-white' : 'text-neutral-600'
                        }`}>{theirScore}</div>
                      </div>
                    </div>

                    {/* Margin bar — the scoreline says WHO won, this says by how
                        much. Same two-tone split the Arena duel-history rows
                        already use, so a result reads identically in both
                        places. 3px, so it costs no meaningful height in the
                        423px landscape viewport these duels actually run in. */}
                    {(myScore + theirScore) > 0 && (
                      <div className="flex h-[3px] w-full overflow-hidden bg-neutral-800">
                        <div
                          className={won ? 'bg-purple-500' : 'bg-neutral-700'}
                          style={{ width: `${(myScore / (myScore + theirScore)) * 100}%` }}
                        />
                        <div className={`flex-1 ${!won && !draw ? 'bg-rose-500' : 'bg-neutral-700'}`} />
                      </div>
                    )}

                  </div>
                  )}

                  {/* EIQ change — written by submitScore onto the challenge
                      doc. Winner gains, loser loses (floored at 0), draw is 0.
                      Sits OUTSIDE the scoreline branch on purpose: a forfeit
                      that nobody finished still moves EIQ, so hiding this with
                      the scoreboard would drop the one number that did change.
                      Was two cryptic pills ("• 0 EIQ" next to "0 · BRONZE")
                      that never said which was the change and which the
                      total; now it is one labelled row. */}
                  {typeof myEiqGained === 'number' && (
                    <div className={`mt-2 flex items-center justify-between gap-3 rounded-2xl border px-4 py-2.5 ${
                      myEiqGained > 0 ? 'border-emerald-500/25 bg-emerald-500/[0.07]'
                        : myEiqGained < 0 ? 'border-rose-500/25 bg-rose-500/[0.07]'
                        : 'border-neutral-800 bg-[#12131c]'
                    }`}>
                      <span className={`text-sm font-hud font-bold tabular-nums ${
                        myEiqGained > 0 ? 'text-emerald-400' : myEiqGained < 0 ? 'text-rose-400' : 'text-neutral-400'
                      }`}>
                        {myEiqGained > 0 ? `+${myEiqGained}` : myEiqGained} EIQ
                      </span>
                      {typeof myEiqAfter === 'number' && (
                        <span className="flex items-center gap-1.5 text-[11px] font-bold text-neutral-400">
                          <Trophy className="w-3.5 h-3.5 text-yellow-400" />
                          <span className="font-hud text-white">{myEiqAfter}</span> total
                          {tier && <span className="text-[10px] label-tiny text-neutral-500">· {tier.name}</span>}
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
                      /* Violet, not the emerald gradient it used to be — green
                         is the app's "done/correct" colour everywhere else, and
                         a full-width pulsing green slab read as a success
                         banner rather than something to press. */
                      className="mt-3 w-full py-2.5 bg-violet-600 hover:bg-violet-500 text-white font-bold rounded-2xl text-sm flex items-center justify-center gap-2 shadow-lg transition active:scale-[.98]"
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

                  {/* Actions — side-by-side in landscape/wide, stacked in portrait.
                      Kept tight: the duel drills run landscape, where the whole
                      result has 423 CSS px of height to live in. */}
                  {/* Centred, fixed-width actions rather than two stretched
                      flex-1 slabs. Across the full landscape width a
                      full-bleed gradient button was the loudest thing on the
                      screen — louder than the scoreline it sits under. Still
                      full-width when stacked in portrait, where stretching is
                      correct. */}
                  <div className="mt-3 flex flex-col sm:flex-row sm:justify-center gap-2.5">
                    <button
                      onClick={() => router.push('/challenge')}
                      className="sm:flex-none sm:min-w-[180px] px-6 py-2.5 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white font-bold rounded-2xl text-sm flex items-center justify-center gap-2 shadow-lg transition duration-200"
                    >
                      <Home className="w-4 h-4" />
                      Back to Arena
                    </button>
                    {challengeData?.toUid !== 'global' && !pendingRematch && (
                      <button
                        onClick={handleChallengeAgain}
                        className="sm:flex-none sm:min-w-[150px] px-6 py-2.5 bg-neutral-900 border border-neutral-800 hover:border-purple-500/40 text-white font-bold rounded-2xl text-sm flex items-center justify-center gap-2 transition duration-200"
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
                        withdrawChallenge(sentChallengeId).catch(console.error);
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
        className={`text-sm font-hud font-bold tabular-nums ${urgent ? 'animate-pulse' : ''}`}
        style={{ color }}
      >
        {value}
      </span>
      <span className="text-[9px] font-semibold text-gray-700 uppercase tracking-wider">{label}</span>
    </div>
  );
}
