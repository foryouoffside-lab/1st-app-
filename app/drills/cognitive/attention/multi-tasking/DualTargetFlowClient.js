'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  Layers, Volume2, VolumeX, Heart,
  RotateCcw, ArrowLeft, Share2, Target, Repeat
} from 'lucide-react';
import { scoreAction, calcEndBonuses, calcSessionXP, getGrade } from '../../../../../lib/scoringEngine';
import { saveLeaderboardEntrySync } from '../../../../../lib/leaderboard';
import { lockLandscape, unlockOrientation } from '../../../../../lib/orientation';
import { previewDailyCompletion } from '../../../../../lib/dailyChallenge';
import { getPlayerName } from '../../../../../lib/progressStore';
import { Capacitor } from '@capacitor/core';
import { StatusBar } from '@capacitor/status-bar';
import generateShareCard, { shareScoreCard } from '../../../../../components/ShareScoreCard';
import DrillWrapper from '../../../../../components/DrillWrapper';
import { useDuelMatchStart } from '../../../../../lib/challengeEngine';
import { hitTestCircle, canvasDpr } from '../../../../../lib/canvasFx';

// ============================================================
// TUNING
// ============================================================
const TOTAL_TIME = 45;      // fixed countdown — no add/remove-time gimmick
const MAX_LIVES = 5;        // matches CATEGORY_CONFIG.cognitive.maxLives in scoringEngine.js
const OVERDRIVE_MS = 5000;
const MAX_LEVEL = 15;
const COUNTDOWN_TICK_MS = 700;
const SHAPES = ['▲', '●', '■', '★', '◆', '⬣', '❖', '⏣'];

// ============================================================
// ZERO-LATENCY AUDIO SYNTHESIZER
// ============================================================
class AudioSynthesizer {
  constructor() {
    this.ctx = null;
    this.enabled = true;
  }

  init() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  tone(freq, dur, type = 'sine', vol = 0.15, sweepTo = null) {
    if (!this.enabled || !this.ctx) return;
    try {
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
      if (sweepTo) osc.frequency.exponentialRampToValueAtTime(sweepTo, this.ctx.currentTime + dur);
      gain.gain.setValueAtTime(vol, this.ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + dur);
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start();
      osc.stop(this.ctx.currentTime + dur);
    } catch (e) {}
  }

  playPulseHit() { this.tone(880, 0.12, 'sine', 0.16, 1760); }

  // Two rapid, crisp low-frequency rejections — same "bad" cue used across
  // every drill's wrong-tap/timeout now (see BatchProcessingClient.js).
  playPenalty() {
    if (!this.enabled || !this.ctx) return;
    try {
      const t0 = this.ctx.currentTime;
      [
        { freq: 220, delay: 0 },
        { freq: 165, delay: 0.06 }
      ].forEach(({ freq, delay }) => {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, t0 + delay);
        gain.gain.setValueAtTime(0, t0 + delay);
        gain.gain.linearRampToValueAtTime(0.12, t0 + delay + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.001, t0 + delay + 0.08);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(t0 + delay);
        osc.stop(t0 + delay + 0.08);
      });
    } catch (e) {}
  }
  playCountdownTick() { this.tone(440, 0.09, 'sine', 0.12, 440); }
  // Same tone() shape as the tick, just a step higher with a quick upward
  // glide — matches BatchProcessingClient.js's GO exactly.
  playGo() { this.tone(523.25, 0.18, 'triangle', 0.17, 784); }

  // Warm unison voice (two detuned sine oscillators through a lowpass) used
  // for the results reveal below — same helper as BatchProcessingClient.js.
  chimeVoice(freq, startAt, dur, vol, filterFreq = 2600) {
    if (!this.ctx) return;
    const t0 = startAt;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(filterFreq, t0);
    filter.Q.setValueAtTime(0.5, t0);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(vol, t0 + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    filter.connect(gain);
    gain.connect(this.ctx.destination);
    [-4, 4].forEach((cents) => {
      const osc = this.ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, t0);
      osc.detune.setValueAtTime(cents, t0);
      osc.connect(filter);
      osc.start(t0);
      osc.stop(t0 + dur);
    });
  }

  // Rising arpeggio into a bright sustained top note — a clean "results are
  // in" reveal that works whether the run was strong or not, replacing the
  // old sawtooth fail-buzzer that played on every ending regardless.
  playResultsReveal() {
    if (!this.enabled || !this.ctx) return;
    try {
      const t0 = this.ctx.currentTime;
      [523.25, 659.25, 783.99].forEach((freq, i) => {
        this.chimeVoice(freq, t0 + i * 0.08, 0.24, 0.13, 3200);
      });
      this.chimeVoice(1046.50, t0 + 0.26, 0.6, 0.16, 4200);
    } catch (e) {}
  }

  playHeartbeat(danger = 0) {
    if (!this.enabled || !this.ctx || danger <= 0) return;
    try {
      const vol = 0.05 + danger * 0.12;
      const t0 = this.ctx.currentTime;
      [0, 0.14].forEach((offset) => {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(70, t0 + offset);
        gain.gain.setValueAtTime(vol, t0 + offset);
        gain.gain.exponentialRampToValueAtTime(0.001, t0 + offset + 0.12);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(t0 + offset);
        osc.stop(t0 + offset + 0.12);
      });
    } catch (e) {}
  }

  setEnabled(status) { this.enabled = status; }
}

const audioSynth = typeof window !== 'undefined' ? new AudioSynthesizer() : null;

// ============================================================
// LOCAL BEST-STATS STORAGE (instant sync display on start card)
// ============================================================
const STORAGE_KEY = 'skilldrills_multi_tasking_v1';

const getSavedData = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { bestScore: 0, bestCombo: 0, bestLevel: 1, totalSessions: 0, totalOverdrives: 0 };
    return { bestScore: 0, bestCombo: 0, bestLevel: 1, totalSessions: 0, totalOverdrives: 0, ...JSON.parse(raw) };
  } catch (e) {
    return { bestScore: 0, bestCombo: 0, bestLevel: 1, totalSessions: 0, totalOverdrives: 0 };
  }
};

const saveData = (data) => {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (e) {}
};

const isMobileUA = () => {
  if (typeof window === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /Mobi|Android|iPhone|iPad|iPod/i.test(ua) || window.innerWidth < 768;
};

const isPortraitNow = () => typeof window !== 'undefined' && window.innerHeight > window.innerWidth;

// ============================================================
// MAIN COMPONENT
// ============================================================
export default function MultiTaskingClient() {
  const searchParams = useSearchParams();
  const challengeId = searchParams ? searchParams.get('challengeId') : null;
  const isChallenge = !!challengeId;
  const totalTime = isChallenge ? 30 : TOTAL_TIME;
  const matchStartAt = useDuelMatchStart(challengeId);

  const [isClient, setIsClient] = useState(false);
  const [loading, setLoading] = useState(true);
  const [soundEnabled, setSoundEnabled] = useState(true);

  const [phase, setPhase] = useState('start'); // 'start' | 'countdown' | 'playing' | 'rotate-hint' | 'ended'
  const [countdownValue, setCountdownValue] = useState(3);

  // Local best-stats (start card)
  const [bestScore, setBestScore] = useState(0);
  const [bestCombo, setBestCombo] = useState(0);
  const [bestLevel, setBestLevel] = useState(1);

  // Live HUD state
  const [score, setScore] = useState(0);
  const [lives, setLives] = useState(MAX_LIVES);
  const [combo, setCombo] = useState(0);
  const [timeRemaining, setTimeRemaining] = useState(totalTime);
  const [dangerLevel, setDangerLevel] = useState(0);

  // Lanes & targets
  const [leftTarget, setLeftTarget] = useState('▲');
  const [rightTarget, setRightTarget] = useState('▲');

  const [flashes, setFlashes] = useState([]);
  const [bursts, setBursts] = useState([]);
  const [shakeCls, setShakeCls] = useState('');
  const [endSummary, setEndSummary] = useState(null);

  const mountedRef = useRef(false);
  const containerRef = useRef(null);
  const gameActiveRef = useRef(false);
  const duelAutoStartedRef = useRef(false);
  const isActiveRef = gameActiveRef;

  // Canvas rendering for the flying shapes — replaces createShape() building
  // a real DOM element per shape with its own individual requestAnimationFrame
  // loop (previously the single biggest CPU cost in the app: N concurrent rAF
  // loops + N DOM elements, each mutating inline styles every frame) with one
  // shared array of shape data + one draw loop, matching QuickDodgeClient.js's
  // pattern. See ARENA_CANVAS_PERFORMANCE_PLAN.md.
  const playFieldRef = useRef(null);
  const shapeCanvasRef = useRef(null);
  const shapeCanvasSizeRef = useRef({ width: 0, height: 0 });
  const shapeDrawAnimRef = useRef(null);
  const shapeLastDrawRef = useRef(0);
  const shapesRef = useRef([]);
  const shapeIdCounterRef = useRef(0);
  const scorePopupsRef = useRef([]);

  const scoreRef = useRef(0);
  const livesRef = useRef(MAX_LIVES);
  const comboRef = useRef(0);
  const bestComboRef = useRef(0);
  const levelRef = useRef(1);
  const bestLevelRunRef = useRef(1);
  const mistakesRef = useRef(0);
  const correctActionsRef = useRef(0);
  const totalActionsRef = useRef(0);
  const overdriveMeterRef = useRef(0);
  const overdriveActiveRef = useRef(false);
  const overdriveCountRef = useRef(0);
  const timeRemainingRef = useRef(totalTime);

  // Difficulty scaling refs
  const speedRef = useRef(3.0);
  const spawnRateRef = useRef(1000);
  const isDifferentTargetsRef = useRef(false);

  const leftTargetRef = useRef('▲');
  const rightTargetRef = useRef('▲');
  const shakeToggleRef = useRef(0);
  const heartbeatTempoRef = useRef(1100);

  const leftSpawnTimerRef = useRef(null);
  const rightSpawnTimerRef = useRef(null);
  const targetChangeIntervalRef = useRef(null);
  const timerIntervalRef = useRef(null);
  const heartbeatTimerRef = useRef(null);
  const overdriveTimeoutRef = useRef(null);
  const countdownTimerRef = useRef(null);

  // ── Mount / cleanup ───────────────────────────────────────────────────────
  useEffect(() => {
    setIsClient(true);
    mountedRef.current = true;
    try {
      const saved = getSavedData();
      setBestScore(saved.bestScore);
      setBestCombo(saved.bestCombo);
      setBestLevel(saved.bestLevel);
    } catch (e) {}
    setTimeout(() => { if (mountedRef.current) setLoading(false); }, 200);

    return () => {
      mountedRef.current = false;
      gameActiveRef.current = false;
      [leftSpawnTimerRef, rightSpawnTimerRef, targetChangeIntervalRef, heartbeatTimerRef, overdriveTimeoutRef, countdownTimerRef].forEach((r) => { if (r.current) clearTimeout(r.current); });
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
      shapesRef.current = [];
      try { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); } catch (e) {}
      if (Capacitor.isNativePlatform()) {
        StatusBar.setOverlaysWebView({ overlay: false }).catch(() => {});
        StatusBar.show().catch(() => {});
      }
      unlockOrientation();
    };
  }, []);

  // ── Rotate-hint: auto-advance the instant the device is actually landscape ──
  useEffect(() => {
    if (phase !== 'rotate-hint') return;
    const check = () => { if (!isPortraitNow()) runCountdownRef.current?.(isChallenge ? 0 : 3); };
    window.addEventListener('resize', check);
    window.addEventListener('orientationchange', check);
    return () => {
      window.removeEventListener('resize', check);
      window.removeEventListener('orientationchange', check);
    };
  }, [phase]);


  const triggerFlash = useCallback((variant) => {
    const id = Date.now() + Math.random();
    setFlashes((f) => [...f, { id, variant }]);
    setTimeout(() => { if (mountedRef.current) setFlashes((f) => f.filter((x) => x.id !== id)); }, 480);
  }, []);

  const triggerShake = useCallback((intensity) => {
    shakeToggleRef.current = shakeToggleRef.current === 0 ? 1 : 0;
    setShakeCls(`fx-shake-${intensity}-${shakeToggleRef.current === 0 ? 'a' : 'b'}`);
  }, []);

  const spawnBurst = useCallback((x, y, color) => {
    const id = Date.now() + Math.random();
    setBursts((b) => [...b, { id, x, y, color }]);
    setTimeout(() => { if (mountedRef.current) setBursts((b) => b.filter((p) => p.id !== id)); }, 520);
  }, []);

  // Score release: the "+N" earned on a correct tap rises and fades from the
  // exact spot the shape was hit (x/y in the same 0-100 percentage space as
  // spawnBurst), drawn on the shape canvas instead of a static center banner.
  const spawnScorePopup = useCallback((x, y, text, color = '#4ade80') => {
    scorePopupsRef.current.push({ x, y, text, color, spawnedAt: performance.now() });
  }, []);

  // ── Difficulty scaling ────────────────────────────────────────────────────
  const updateDifficulty = useCallback(() => {
    // Difficulty ramps with SCORE for everyone, duels included: speed, spawn
    // rate, and target divergence all escalate the more you score, so a
    // stronger duelist faces a harder board. Score still decides the winner
    // and thus the EIQ swing.
    const newLevel = Math.min(MAX_LEVEL, Math.floor(scoreRef.current / 40) + 1);
    if (newLevel > levelRef.current) {
      levelRef.current = newLevel;
      bestLevelRunRef.current = Math.max(bestLevelRunRef.current, newLevel);
    }
    // All difficulty is driven off levelRef.current (the ratcheted level),
    // never the raw current score — so an Arena −5 penalty that momentarily
    // dips the score can NEVER walk speed/spawn/divergence back down. Once
    // target divergence turns on at level 3 it stays on for the rest of the run.
    const p = Math.max(0, Math.min(1, (levelRef.current - 1) / (MAX_LEVEL - 1)));
    speedRef.current = 3.0 + p * 4.0;
    spawnRateRef.current = 1000 - p * 600;

    if (levelRef.current >= 3 && !isDifferentTargetsRef.current) {
      isDifferentTargetsRef.current = true;
      setRandomTargets();
    }
  }, []);

  // ── Overdrive ──────────────────────────────────────────────────────────────
  const activateOverdrive = useCallback(() => {
    overdriveActiveRef.current = true;
    overdriveMeterRef.current = 0;
    overdriveCountRef.current += 1;
    triggerFlash('gold');
    if (overdriveTimeoutRef.current) clearTimeout(overdriveTimeoutRef.current);
    overdriveTimeoutRef.current = setTimeout(() => {
      overdriveActiveRef.current = false;
    }, OVERDRIVE_MS);
  }, [triggerFlash]);

  const fillOverdrive = useCallback((amt) => {
    if (overdriveActiveRef.current) return;
    overdriveMeterRef.current = Math.min(100, overdriveMeterRef.current + amt);
    if (overdriveMeterRef.current >= 100) activateOverdrive();
  }, [activateOverdrive]);

  const setRandomTargets = useCallback(() => {
    const shuffled = [...SHAPES].sort(() => 0.5 - Math.random());
    const newLeft = shuffled[0];
    const newRight = isDifferentTargetsRef.current ? shuffled[1] : newLeft;
    
    leftTargetRef.current = newLeft;
    rightTargetRef.current = newRight;
    setLeftTarget(newLeft);
    setRightTarget(newRight);
  }, []);

  // ── Scoring resolution ────────────────────────────────────────────────────
  const resolveCorrect = useCallback((kind, pos) => {
    if (!gameActiveRef.current) return;
    const comboBefore = comboRef.current;
    const pts = scoreAction({
      category: 'cognitive',
      combo: comboBefore,
      reactionMs: null, // shapes flow continuously, so reactionMs is not applicable
      timeRemaining: timeRemainingRef.current,
      totalGameTime: totalTime,
      livesRemaining: livesRef.current,
      maxLives: MAX_LIVES,
      level: levelRef.current,
      maxLevel: MAX_LEVEL,
    });
    let total = pts.total;
    
    if (overdriveActiveRef.current) {
      total = Math.round(total * 1.75);
    }

    scoreRef.current += total;
    comboRef.current = comboBefore + 1;
    bestComboRef.current = Math.max(bestComboRef.current, comboRef.current);
    correctActionsRef.current += 1;
    totalActionsRef.current += 1;

    fillOverdrive(14);

    if (pos) {
      spawnBurst(pos.x, pos.y, 'cyan');
      spawnScorePopup(pos.x, pos.y, `+${total}`);
    }

    // Every correct tap shares this one hit sound now — no separate combo
    // chime. The "COMBO" text is the only thing that still calls out a
    // milestone; nothing else gets its own sound.
    audioSynth?.playPulseHit();

    setScore(scoreRef.current);
    setCombo(comboRef.current);
    updateDifficulty();
  }, [fillOverdrive, spawnBurst, spawnScorePopup, updateDifficulty]);

  const endGameRef = useRef(null);

  const resolveWrong = useCallback((kind, pos) => {
    if (!gameActiveRef.current) return;
    comboRef.current = 0;
    mistakesRef.current += 1;
    totalActionsRef.current += 1;

    // Arena has no lives, so a mistake costs score (−5, floored at 0) — that
    // penalty keeps careless play from winning and flows into your EIQ. Solo
    // loses a life instead (floored at 0 so a negative count can't feed the
    // heartbeat's danger formula unbounded). The score drop never lowers
    // difficulty — updateDifficulty only ratchets the level UP.
    if (isChallenge) {
      scoreRef.current = Math.max(0, scoreRef.current - 5);
    } else {
      livesRef.current = Math.max(0, livesRef.current - 1);
    }

    triggerShake('soft');
    triggerFlash('red');
    audioSynth?.playPenalty();

    if (pos) spawnBurst(pos.x, pos.y, 'red');

    setScore(scoreRef.current);
    setCombo(0);
    setLives(Math.max(0, livesRef.current));

    // Solo: game over on empty lives. Duels always run the full clock.
    if (!isChallenge && livesRef.current <= 0) endGameRef.current?.('lives');
  }, [triggerShake, triggerFlash, spawnBurst, isChallenge]);

  // ── Game over ──────────────────────────────────────────────────────────────
  const endGame = useCallback(async (reason) => {
    if (!gameActiveRef.current) return;
    gameActiveRef.current = false;

    [leftSpawnTimerRef, rightSpawnTimerRef, targetChangeIntervalRef, heartbeatTimerRef, overdriveTimeoutRef].forEach((r) => { if (r.current) { clearTimeout(r.current); r.current = null; } });
    if (timerIntervalRef.current) { clearInterval(timerIntervalRef.current); timerIntervalRef.current = null; }

    shapesRef.current = [];

    audioSynth?.playResultsReveal();
    // StatusBar deliberately not reverted here — the result screen still
    // renders inside the same fullscreen, landscape-locked container as
    // gameplay. Reverting now would force a resize/shake right as results
    // appear; it's restored in the mount-effect cleanup instead, alongside
    // exitFullscreen()/unlockOrientation(), which are already deferred to
    // actually leaving the drill.
    triggerFlash(reason === 'lives' ? 'red-hard' : 'red');

    const correct = correctActionsRef.current;
    const total = totalActionsRef.current;
    const accuracy = total > 0 ? Math.round((correct / total) * 100) : 100;

    const bonuses = calcEndBonuses({
      rawScore: scoreRef.current,
      accuracy,
      bestCombo: bestComboRef.current,
      totalActions: total,
      mistakes: mistakesRef.current,
      livesRemaining: Math.max(0, livesRef.current),
      maxLives: MAX_LIVES,
      category: 'cognitive',
    });
    const finalScore = bonuses.finalScore;
    const grade = getGrade(accuracy);

    const prevSaved = getSavedData();
    const isNewBest = finalScore > prevSaved.bestScore;
    const firstPlay = prevSaved.totalSessions === 0;
    const daily = isChallenge
      ? { isDailyDrill: false, wouldCompleteSet: false }
      : await previewDailyCompletion('multi-tasking');
    const xpResult = calcSessionXP({ finalScore, accuracy, isNewBest, firstPlay, dailyChallenge: daily.isDailyDrill, dailyChallengeSetComplete: daily.wouldCompleteSet });

    const updated = {
      bestScore: Math.max(prevSaved.bestScore, finalScore),
      bestCombo: Math.max(prevSaved.bestCombo, bestComboRef.current),
      bestLevel: Math.max(prevSaved.bestLevel, bestLevelRunRef.current),
      totalSessions: prevSaved.totalSessions + 1,
      totalOverdrives: (prevSaved.totalOverdrives || 0) + overdriveCountRef.current,
    };
    saveData(updated);
    setBestScore(updated.bestScore);
    setBestCombo(updated.bestCombo);
    setBestLevel(updated.bestLevel);

    saveLeaderboardEntrySync({
      drillId: 'multi-tasking',
      drillName: 'Multi-Tasking',
      category: 'cognitive',
      score: finalScore,
      accuracy,
      bestCombo: bestComboRef.current,
    });

    setEndSummary({
      score: finalScore,
      accuracy,
      bestCombo: bestComboRef.current,
      lives: Math.max(0, livesRef.current),
      isNewBest,
      grade,
      xpEarned: xpResult.xp,
    });
    setPhase('ended');
  }, [triggerFlash]);

  useEffect(() => { endGameRef.current = endGame; }, [endGame]);

  // ── Shape Spawn Loop ─────────────────────────────────────────────────────
  // Pushes shape data into the shared shapesRef array — the canvas resize/
  // draw effect below is what actually moves, hit-expires, and draws them,
  // on one shared loop instead of one rAF per shape. Positions are stored in
  // 0-100 percentage space (not pixels) so spawning never has to know the
  // canvas's actual pixel size — only the draw loop needs that, and it reads
  // it fresh every frame.
  const createShape = useCallback((side) => {
    if (!isActiveRef.current) return;
    const targetGlyph = side === 'left' ? leftTargetRef.current : rightTargetRef.current;

    const isMobile = window.innerWidth < 768;
    // This drill is landscape-locked (lockLandscape()), so "mobile" always
    // means landscape mobile in practice — the old isLandscape ? 24 : 35.2
    // split made shapes *smaller* in the orientation the drill actually
    // runs in than in the portrait fallback that's barely ever shown,
    // which is why they read as too-small-to-see-comfortably.
    const fontSize = isMobile ? 31.7 : 46.1; // ~10% smaller than the 2.2rem/3.2rem base, for extra room to move

    const isTarget = Math.random() < 0.35;
    let glyph = isTarget ? targetGlyph : SHAPES[Math.floor(Math.random() * SHAPES.length)];
    if (!isTarget && glyph === targetGlyph) glyph = SHAPES.find((s) => s !== targetGlyph) || '■';

    // Both lanes flow outward from the center divider (50%) to their own
    // far edge, mirroring the original's per-lane pixel offsets.
    const startX = side === 'left' ? 50 : 42;
    const endX = side === 'left' ? -8 : 108;
    const y = 18 + Math.random() * 68; // keeps clear of the HUD/combo zones

    shapesRef.current.push({
      id: ++shapeIdCounterRef.current,
      side, glyph, isTarget, fontSize,
      startX, endX, y,
      spawnedAt: performance.now(),
      duration: 4000 / speedRef.current,
      hitState: null, // null | 'correct' | 'wrong'
      hitAt: null,
    });
  }, []);

  const scheduleLeftSpawn = useCallback(() => {
    if (!isActiveRef.current) return;
    createShape('left');
    leftSpawnTimerRef.current = setTimeout(scheduleLeftSpawn, spawnRateRef.current);
  }, [createShape]);

  const scheduleRightSpawn = useCallback(() => {
    if (!isActiveRef.current) return;
    createShape('right');
    rightSpawnTimerRef.current = setTimeout(scheduleRightSpawn, spawnRateRef.current);
  }, [createShape]);

  // ── Heartbeat / danger tempo ──────────────────────────────────────────────
  const scheduleHeartbeat = useCallback(() => {
    // Duels have NO heartbeat audio and NO danger vignette at all — the
    // match must feel and perform exactly like solo play minus the extras
    // (and the unclamped version of this loop was the "phone heating
    // rapidly + making noise" bug: danger > 1.7 from negative lives made
    // the tempo negative, turning this self-rescheduling callback into a
    // tight infinite loop spawning audio nodes at full CPU speed).
    if (isChallenge) return;
    if (!gameActiveRef.current) return;
    const dangerFromLives = livesRef.current <= 2
      ? (MAX_LIVES - livesRef.current) / MAX_LIVES
      : 0;
    const dangerFromTime = timeRemainingRef.current <= 10 ? (10 - timeRemainingRef.current) / 10 : 0;
    const danger = Math.min(1, Math.max(dangerFromLives * 0.7, dangerFromTime));
    const tempo = Math.max(350, Math.round(1100 - danger * 650));
    heartbeatTempoRef.current = tempo;
    if (danger > 0.08) audioSynth?.playHeartbeat(danger);
    if (mountedRef.current) setDangerLevel(danger);
    heartbeatTimerRef.current = setTimeout(scheduleHeartbeat, tempo);
  }, [isChallenge]);

  // ── Begin actual play ─────────────────────────────────────────────────────
  const beginPlaying = useCallback(() => {
    if (!mountedRef.current) return;
    gameActiveRef.current = true;
    setPhase('playing');

    // 200ms rather than 100ms — the displayed clock only shows whole seconds,
    // so 5 ticks/sec looks identical to 10 while halving how often this
    // re-renders the whole play field for the entire match.
    timerIntervalRef.current = setInterval(() => {
      if (!gameActiveRef.current) { clearInterval(timerIntervalRef.current); return; }
      timeRemainingRef.current -= 0.2;
      if (timeRemainingRef.current <= 0) {
        timeRemainingRef.current = 0;
        setTimeRemaining(0);
        endGameRef.current?.('time');
      } else {
        // Only when the DISPLAYED whole second changes — the clock reads to the
        // second and the timer bar animates itself in CSS, so the other four
        // ticks each second were re-rendering the entire play field to paint an
        // identical picture. The ref keeps full precision for scoring maths.
        setTimeRemaining((prev) => (
          Math.ceil(prev) === Math.ceil(timeRemainingRef.current) ? prev : timeRemainingRef.current
        ));
      }
    }, 200);

    scheduleHeartbeat();
    setRandomTargets();

    scheduleLeftSpawn();
    setTimeout(scheduleRightSpawn, 300);

    // Scramble targets every 25 seconds
    targetChangeIntervalRef.current = setInterval(() => {
      if (isActiveRef.current) {
        setRandomTargets();
      }
    }, 25000);
  }, [scheduleHeartbeat, scheduleLeftSpawn, scheduleRightSpawn, setRandomTargets, isChallenge, updateDifficulty]);

  // ── 3-2-1-GO countdown ────────────────────────────────────────────────────
  const runCountdown = useCallback((n) => {
    if (countdownTimerRef.current) clearTimeout(countdownTimerRef.current);
    if (!mountedRef.current) return;
    setPhase('countdown');
    if (n <= 0) {
      setCountdownValue('GO');
      // Duels skip the visible 3-2-1 AND its audio — DrillWrapper renders the
      // shared countdown, so a local "GO" here fired after that one had
      // already finished (ARENA_INTEGRATION.md rule 2). Every other duel
      // drill guards these two calls; this one didn't.
      if (!isChallenge) audioSynth?.playGo();
      countdownTimerRef.current = setTimeout(() => beginPlaying(), 350);
      return;
    }
    setCountdownValue(n);
    if (!isChallenge) audioSynth?.playCountdownTick();
    countdownTimerRef.current = setTimeout(() => runCountdown(n - 1), COUNTDOWN_TICK_MS);
  }, [beginPlaying, isChallenge]);

  const runCountdownRef = useRef(null);
  useEffect(() => { runCountdownRef.current = runCountdown; }, [runCountdown]);

  // ── Entry point ───────────────────────────────────────────────────────────
  const enterDrill = useCallback(async () => {
    try { audioSynth?.init(); } catch (e) {}

    gameActiveRef.current = false;
    [leftSpawnTimerRef, rightSpawnTimerRef, targetChangeIntervalRef, heartbeatTimerRef, overdriveTimeoutRef, countdownTimerRef].forEach((r) => { if (r.current) { clearTimeout(r.current); r.current = null; } });
    if (timerIntervalRef.current) { clearInterval(timerIntervalRef.current); timerIntervalRef.current = null; }

    shapesRef.current = [];
    scorePopupsRef.current = [];

    // Returning players start closer to their proven skill level instead of
    // always grinding through level 1 again — ~55% of their best level reached.
    // First-time players (no saved bestLevel) still start at level 1.
    //
    // Duels always start BOTH players at the same, lowest difficulty — no
    // personal-best seeding — so the two scores are comparable and the match
    // is pure skill (ARENA_INTEGRATION.md rule 5 / matchmaking fairness).
    // Without this a veteran opened the duel at level 8 with shapes flying at
    // near-max speed while their opponent got level 1, which is a different
    // game, not a fair race.
    const startLevel = isChallenge
      ? 1
      : Math.max(1, Math.min(MAX_LEVEL, Math.round((bestLevel || 1) * 0.55)));

    scoreRef.current = 0; livesRef.current = MAX_LIVES; comboRef.current = 0; bestComboRef.current = 0;
    levelRef.current = startLevel; bestLevelRunRef.current = startLevel; mistakesRef.current = 0; correctActionsRef.current = 0; totalActionsRef.current = 0;
    overdriveMeterRef.current = 0; overdriveActiveRef.current = false; overdriveCountRef.current = 0;
    timeRemainingRef.current = totalTime;
    isDifferentTargetsRef.current = false;
    isActiveRef.current = true;

    // Seed speed/spawn-rate from the starting level using the same curve as
    // updateDifficulty() (which only re-derives these after a correct hit,
    // not on every spawn) — otherwise the first shapes spawned this run
    // would use level-1 pacing while the HUD already shows a higher level.
    const startP = Math.max(0, Math.min(1, (startLevel - 1) / (MAX_LEVEL - 1)));
    speedRef.current = 3.0 + startP * 4.0;
    spawnRateRef.current = 1000 - startP * 600;

    setScore(0); setLives(MAX_LIVES); setCombo(0); setTimeRemaining(totalTime);
    setDangerLevel(0);
    setEndSummary(null); setFlashes([]); setBursts([]);

    if (!isChallenge && !document.fullscreenElement && containerRef.current) {
      try { await containerRef.current.requestFullscreen(); } catch (e) {}
    }
    if (Capacitor.isNativePlatform()) {
      // overlaysWebView:true keeps the window's layout size stable regardless
      // of status-bar visibility, so a swipe-reveal from the top edge draws
      // the bar as an overlay instead of resizing the WebView and shoving
      // this fullscreen board down the screen.
      StatusBar.setOverlaysWebView({ overlay: true }).catch(() => {});
      StatusBar.hide().catch(() => {});
    }

    try { await lockLandscape(); } catch (e) {}

    setTimeout(() => {
      if (!mountedRef.current) return;
      if (isMobileUA() && isPortraitNow()) {
        setPhase('rotate-hint');
      } else {
        runCountdown(isChallenge ? 0 : 3);
      }
    }, 300);
  }, [runCountdown, isChallenge, bestLevel, totalTime]);

  useEffect(() => {
    if (!isChallenge || !matchStartAt || phase !== 'start' || duelAutoStartedRef.current) return;
    const delay = Math.max(0, matchStartAt - Date.now());
    const t = setTimeout(() => {
      duelAutoStartedRef.current = true;
      enterDrill();
    }, delay);
    return () => clearTimeout(t);
  }, [isChallenge, matchStartAt, phase, enterDrill]);

  // Pre-warm the landscape lock as soon as we know a duel is about to
  // start, instead of waiting until the synchronized matchStartAt instant
  // to begin it. lockLandscape() calls into Android's native orientation
  // API, and how long it actually takes to finish rotating the device
  // varies meaningfully by device/current-orientation — doing this AT
  // matchStartAt meant the real game start happened at matchStartAt +
  // however long THIS device's rotation took, which differed between the
  // two duelists and showed up as a 1-2s gap between when their matches
  // visibly began. The shared countdown always has a few seconds of lead
  // time before matchStartAt (see MATCH_COUNTDOWN_MS in DrillWrapper.js),
  // so there's room to finish this well beforehand on both devices —
  // enterDrill's own lockLandscape() call then just resolves immediately
  // since the device is already there.
  useEffect(() => {
    if (!isChallenge || !matchStartAt) return;
    if (Capacitor.isNativePlatform()) {
      StatusBar.setOverlaysWebView({ overlay: true }).catch(() => {});
      StatusBar.hide().catch(() => {});
    }
    lockLandscape().catch(() => {});
  }, [isChallenge, matchStartAt]);

  const prevChallengeIdRef = useRef(challengeId);
  useEffect(() => {
    if (challengeId === prevChallengeIdRef.current) return;
    prevChallengeIdRef.current = challengeId;
    duelAutoStartedRef.current = false;
    setPhase('start');
    setScore(0);
    setLives(MAX_LIVES);
    setEndSummary(null);
    setTimeRemaining(totalTime);
  }, [challengeId, totalTime]);

  // ── Shape canvas: sizing + draw loop ───────────────────────────────────────
  // One shared loop advances every live shape's position, expires/removes
  // ones that finished crossing or finished their post-tap flash, and resolves
  // "missed" targets — replacing what used to be a separate rAF loop PER
  // SHAPE. Capped to ~30fps since these are simple flat-color glyphs, not a
  // physics-heavy scene.
  useEffect(() => {
    if (phase !== 'playing' && phase !== 'countdown') {
      if (shapeDrawAnimRef.current) { cancelAnimationFrame(shapeDrawAnimRef.current); shapeDrawAnimRef.current = null; }
      return;
    }

    const resizeShapeCanvas = () => {
      const cvs = shapeCanvasRef.current;
      const el = playFieldRef.current;
      if (!cvs || !el) return;
      const rect = el.getBoundingClientRect();
      const dpr = canvasDpr();
      cvs.width = rect.width * dpr;
      cvs.height = rect.height * dpr;
      shapeCanvasSizeRef.current = { width: rect.width, height: rect.height };
    };

    resizeShapeCanvas();
    const ro = new ResizeObserver(resizeShapeCanvas);
    if (playFieldRef.current) ro.observe(playFieldRef.current);
    window.addEventListener('resize', resizeShapeCanvas);
    window.addEventListener('orientationchange', resizeShapeCanvas);

    // Avoids reassigning ctx.font between shapes in the same frame (setting
    // ctx.font forces a CSS-shorthand reparse). Only valid within one frame:
    // ctx.restore() at the end of each frame resets ctx.font to the 10px
    // default, so draw() clears this at the top of every frame — without
    // that reset every glyph after the first frame renders at 10px.
    let lastFontStr = '';

    const draw = (timestamp) => {
      const cvs = shapeCanvasRef.current;
      const ctx = cvs?.getContext('2d');
      if (!ctx) { shapeDrawAnimRef.current = requestAnimationFrame(draw); return; }

      if (timestamp - shapeLastDrawRef.current < 33) {
        shapeDrawAnimRef.current = requestAnimationFrame(draw);
        return;
      }
      shapeLastDrawRef.current = timestamp;

      const w = shapeCanvasSizeRef.current.width;
      const h = shapeCanvasSizeRef.current.height;
      const dpr = canvasDpr();

      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, w, h);
      lastFontStr = '';

      if (phase === 'playing') {
        const shapes = shapesRef.current;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        for (let i = shapes.length - 1; i >= 0; i--) {
          const s = shapes[i];

          if (s.hitState) {
            if (timestamp - s.hitAt >= 150) { shapes.splice(i, 1); continue; }
          } else if (timestamp - s.spawnedAt >= s.duration) {
            if (s.isTarget) resolveWrong('missed', null);
            shapes.splice(i, 1);
            continue;
          }

          const progress = Math.min(1, (timestamp - s.spawnedAt) / s.duration);
          const x = ((s.startX + (s.endX - s.startX) * progress) / 100) * w;
          const y = (s.y / 100) * h;

          // shadowBlur defaults to 0 (was 6) — a real, nonzero shadowBlur is
          // one of the most expensive Canvas2D operations on mobile (a
          // CPU-bound blur convolution with no hardware acceleration in most
          // mobile WebViews), and every shape on screen was paying that cost
          // every frame for a barely-visible glow. Only the ~150ms hit-flash
          // (correct/wrong) actually needs it now, matching QuickDodgeClient's
          // pattern of only glowing when something is actually glowing.
          let color = '#d1d5db';
          let glow = 0;
          let glowColor = null;
          let scale = 1;
          if (s.hitState === 'correct') { color = '#60a5fa'; glow = 20; glowColor = '#60a5fa'; scale = 1.2; }
          else if (s.hitState === 'wrong') { color = '#ef4444'; glow = 10; glowColor = '#ef4444'; }

          const fontStr = `${Math.round(s.fontSize * scale)}px sans-serif`;
          if (fontStr !== lastFontStr) { ctx.font = fontStr; lastFontStr = fontStr; }
          ctx.fillStyle = color;
          ctx.shadowBlur = glow;
          ctx.shadowColor = glowColor;
          ctx.fillText(s.glyph, x, y);
          ctx.shadowBlur = 0;
        }

        // Score release: the "+N" earned on a correct tap rises and fades
        // from the exact spot it was scored — same in-canvas model as
        // BatchProcessingClient.js / DividedAttentionClient.js. Uses the rAF
        // timestamp (performance.now()-based, same epoch as spawnedAt below)
        // rather than Date.now(), matching how shapes already track time here.
        const pops = scorePopupsRef.current;
        for (let i = pops.length - 1; i >= 0; i--) {
          const p = pops[i];
          const elapsed = (timestamp - p.spawnedAt) / 1000;
          if (elapsed >= 1) { pops.splice(i, 1); continue; }
          const px = (p.x / 100) * w;
          const py = (p.y / 100) * h - elapsed * 38;
          ctx.save();
          ctx.globalAlpha = 1 - elapsed;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.font = 'bold 15px monospace';
          ctx.fillStyle = p.color;
          ctx.fillText(p.text, px, py);
          ctx.restore();
        }
      }

      ctx.restore();
      shapeDrawAnimRef.current = requestAnimationFrame(draw);
    };

    shapeLastDrawRef.current = 0;
    shapeDrawAnimRef.current = requestAnimationFrame(draw);

    return () => {
      if (shapeDrawAnimRef.current) cancelAnimationFrame(shapeDrawAnimRef.current);
      ro.disconnect();
      window.removeEventListener('resize', resizeShapeCanvas);
      window.removeEventListener('orientationchange', resizeShapeCanvas);
    };
  }, [phase, resolveWrong]);

  // Single tap handler for the whole play field, replacing the old per-shape
  // el.onpointerdown. Hit-tests the tap (in the field's own pixel space)
  // against whichever shapes are currently live and unresolved, closest-
  // spawned-last (drawn on top) first, then resolves exactly as before —
  // only how resolution gets triggered has changed.
  const handlePlayFieldPointerDown = useCallback((e) => {
    if (!gameActiveRef.current || phase !== 'playing') return;
    const rect = playFieldRef.current?.getBoundingClientRect();
    if (!rect) return;
    const tapX = e.clientX - rect.left;
    const tapY = e.clientY - rect.top;
    const now = performance.now();

    const shapes = shapesRef.current;
    for (let i = shapes.length - 1; i >= 0; i--) {
      const s = shapes[i];
      if (s.hitState) continue;
      const progress = Math.min(1, (now - s.spawnedAt) / s.duration);
      const xPct = s.startX + (s.endX - s.startX) * progress;
      const curX = (xPct / 100) * rect.width;
      const curY = (s.y / 100) * rect.height;
      const hitR = s.fontSize * 0.65;
      if (hitTestCircle(tapX, tapY, curX, curY, hitR)) {
        const isCorrect = s.glyph === (s.side === 'left' ? leftTargetRef.current : rightTargetRef.current);
        s.hitState = isCorrect ? 'correct' : 'wrong';
        s.hitAt = now;
        const burstPos = { x: xPct, y: s.y };
        if (isCorrect) resolveCorrect('hit', burstPos);
        else resolveWrong('wrong_shape', burstPos);
        break;
      }
    }
  }, [phase, resolveCorrect, resolveWrong]);

  const shareResult = useCallback(async () => {
    if (!endSummary) return;
    const url = 'https://skilldrills.online/drills/cognitive/attention/multi-tasking';

    try {
      const canvas = generateShareCard({
        score: endSummary.score,
        bestScore,
        accuracy: endSummary.accuracy,
        bestCombo: endSummary.bestCombo,
        rating: { letter: endSummary.grade.grade, label: endSummary.grade.label, emoji: endSummary.grade.emoji },
        newBest: endSummary.isNewBest,
        drillName: 'Multi-Tasking',
        playerName: getPlayerName(),
      });
      await shareScoreCard(url, canvas);
    } catch (e) {
      const text = `🧠 Scored ${endSummary.score} pts on Multi-Tasking — ${endSummary.accuracy}% accuracy, Grade ${endSummary.grade.grade}. Play at skilldrills.online/drills/cognitive/attention/multi-tasking`;
      if (typeof navigator !== 'undefined' && navigator.share) {
        navigator.share({ title: 'Multi-Tasking — SkillDrills', text }).catch(() => {});
      } else if (typeof navigator !== 'undefined' && navigator.clipboard) {
        navigator.clipboard.writeText(text);
      }
    }
  }, [endSummary, bestScore]);

  if (loading || !isClient) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-[#050508]">
        <div className="text-center">
          <div className="w-14 h-14 border-4 border-violet-600 border-t-transparent rounded-full animate-spin mx-auto mb-4 shadow-[0_0_20px_rgba(139,92,246,0.5)]" />
          <p className="text-slate-500 font-bold tracking-widest uppercase text-[10px] animate-pulse">Loading...</p>
        </div>
      </div>
    );
  }

  const timePct = Math.max(0, Math.min(100, (timeRemaining / totalTime) * 100));
  const showBoard = phase === 'playing' || phase === 'countdown';

  return (
    <DrillWrapper
      drillName="Multi-Tasking"
      category="cognitive"
      score={score}
      timeLeft={phase === 'ended' ? 0 : Math.ceil(timeRemaining)}
      lives={lives}
      maxLives={MAX_LIVES}
      soundEnabled={soundEnabled}
      onSoundToggle={() => setSoundEnabled((v) => { audioSynth?.setEnabled(!v); return !v; })}
      backHref="/drills/cognitive"
      minimalChrome
    >
      <div
        ref={containerRef}
        onContextMenu={(e) => { if (gameActiveRef.current) e.preventDefault(); }}
        className={`absolute inset-0 select-none overflow-hidden bg-[#050508] text-white`}
        style={{ touchAction: gameActiveRef.current ? 'none' : 'auto', WebkitTapHighlightColor: 'transparent' }}
      >
        {/* ambient grid */}
        <div className="absolute inset-0 pointer-events-none" style={{ backgroundImage: 'linear-gradient(rgba(255,255,255,0.015) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.015) 1px, transparent 1px)', backgroundSize: '40px 40px' }} />

        {/* danger vignette */}
        {phase === 'playing' && dangerLevel > 0.06 && (
          <div className="fx-vignette" style={{ '--v-min': Math.max(0.05, dangerLevel * 0.25), '--v-max': Math.min(0.55, dangerLevel * 0.75), animationDuration: `${heartbeatTempoRef.current}ms` }} />
        )}

        {/* flashes */}
        {flashes.map((f) => (
          <div key={f.id} className={`fx-flash ${f.variant === 'gold' ? 'fx-flash-gold' : f.variant === 'cyan' ? 'fx-flash-cyan' : 'fx-flash-red'}`} />
        ))}

        {/* ── ROTATE HINT ── */}
        {phase === 'rotate-hint' && !isChallenge && (
          <div className="absolute inset-0 z-[100] flex flex-col items-center justify-center bg-black/95 text-center p-6 backdrop-blur-sm">
            <div className="animate-bounce mb-5 text-violet-500"><RotateCcw className="w-14 h-14 mx-auto" /></div>
            <h3 className="text-lg font-bold text-white mb-2">Rotate to play</h3>
            <p className="text-xs text-gray-400 max-w-xs mx-auto">This drill runs in landscape. Turn your device — it'll continue on its own.</p>
          </div>
        )}

        {/* ── START SCREEN ── */}
        {phase === 'start' && !isChallenge && (
          <div className="relative h-full flex items-center justify-center p-5 overflow-y-auto">
            <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(ellipse 420px 260px at 50% 8%, rgba(142,97,246,.16), transparent 70%)' }} />
            <div className="relative w-full max-w-[280px] rounded-[20px] border border-white/5 bg-[#0c0c16]/90 backdrop-blur-lg px-5 pt-5 pb-[18px] text-center shadow-[0_16px_40px_rgba(0,0,0,.5)] my-6">
              <div className="w-11 h-11 mx-auto rounded-[14px] bg-gradient-to-br from-violet-600 to-indigo-600 flex items-center justify-center mb-3 shadow-[0_0_22px_rgba(139,92,246,.35)]">
                <Layers className="w-[22px] h-[22px] text-white" />
              </div>
              <h1 className="text-[17px] font-bold tracking-tight">Multi-Tasking</h1>

              <div className="flex flex-col gap-1.5 text-left mt-3.5">
                <div className="flex items-center gap-2 bg-white/[0.02] border border-white/5 rounded-[10px] px-2.5 py-[7px]">
                  <Target className="w-3.5 h-3.5 text-cyan-400 flex-shrink-0" />
                  <span className="text-[10.5px] text-slate-300 leading-tight">Tap shapes only when they match your target for that side</span>
                </div>
                <div className="flex items-center gap-2 bg-white/[0.02] border border-white/5 rounded-[10px] px-2.5 py-[7px]">
                  <Repeat className="w-3.5 h-3.5 text-violet-400 flex-shrink-0" />
                  <span className="text-[10.5px] text-slate-300 leading-tight">Targets diverge at Lv.3+ and scramble every 25 seconds</span>
                </div>
                <div className="flex items-center gap-2 bg-white/[0.02] border border-white/5 rounded-[10px] px-2.5 py-[7px]">
                  <Heart className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />
                  <span className="text-[10.5px] text-slate-300 leading-tight">Avoid missing target shapes or tapping incorrect ones</span>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-1.5 mt-3.5">
                <MiniStat label="Best" value={bestScore} color="text-yellow-400" />
                <MiniStat label="Combo" value={`${bestCombo}x`} color="text-orange-400" />
                <MiniStat label="Level" value={`Lv.${bestLevel}`} color="text-indigo-400" />
              </div>

              <button
                onClick={enterDrill}
                className="w-full mt-3.5 py-[11px] rounded-[13px] bg-gradient-to-r from-violet-600 to-indigo-600 font-bold text-[12.5px] tracking-wide active:scale-[0.97] transition-transform shadow-[0_0_20px_rgba(139,92,246,.3)] cursor-pointer"
              >
                START
              </button>
            </div>

            <button
              onClick={() => setSoundEnabled((v) => { audioSynth?.setEnabled(!v); return !v; })}
              className="absolute bottom-3.5 right-4 w-[26px] h-[26px] rounded-full bg-white/[0.04] border border-white/[0.08] flex items-center justify-center text-slate-500 hover:text-white transition-colors cursor-pointer"
            >
              {soundEnabled ? <Volume2 className="w-3 h-3" /> : <VolumeX className="w-3 h-3" />}
            </button>
          </div>
        )}

        {/* ── COUNTDOWN VEIL ── */}
        {phase === 'countdown' && !isChallenge && (
          <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/60 backdrop-blur-[2px]">
            <span className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-400">Get Ready</span>
            <div className="relative w-28 h-28 rounded-full border-[3px] border-violet-500/20 flex items-center justify-center">
              <div className="absolute -inset-[3px] rounded-full border-[3px] border-transparent border-t-violet-400 border-r-violet-400 animate-spin" style={{ animationDuration: '0.7s' }} />
              <span key={countdownValue} className="fx-pop-in text-5xl font-black bg-gradient-to-b from-white to-violet-300 bg-clip-text text-transparent">
                {countdownValue}
              </span>
            </div>
            <span className="text-[10px] text-slate-500">Targets spawn at GO</span>
          </div>
        )}

        {/* ── PLAYING / COUNTDOWN BOARD ── */}
        {showBoard && (
          <>
            {/* Own HUD — shown in BOTH modes now. A duel plays exactly like
                solo: your score top-left, timer top-right (DrillWrapper no
                longer renders any duel chrome mid-match). Hearts are
                solo-only — duels have no lives. */}
            {/* top time bar */}
            <div className="absolute top-0 left-0 right-0 h-1.5 bg-neutral-950 z-[60] pointer-events-none">
              {/* scaleX, not width — a width animation forces layout + paint on
                  every clock tick for the whole match; a transform is composited.
                  The 1s linear glide lets the compositor interpolate between the
                  once-a-second state updates, so the bar still looks continuous
                  while React renders five times less often. */}
              <div
                className={`h-full w-full origin-left transition-transform duration-1000 ease-linear ${timeRemaining <= 10 ? 'bg-red-500 animate-pulse' : 'bg-violet-500'}`}
                style={{ transform: `scaleX(${timePct / 100})` }}
              />
            </div>

            {/* consolidated HUD cluster */}
            <div className="absolute top-5 left-5 z-40 flex flex-col pointer-events-none select-none">
              <span className="text-2xl font-black text-white leading-none tabular-nums">{score}</span>
              <div className="flex items-center gap-2 mt-1.5">
                {/* No level badge in duels — see the note in ConcentrationGrid. */}
                {!isChallenge && (
                  <span className="flex items-center gap-0.5">
                    {Array.from({ length: MAX_LIVES }).map((_, i) => (
                      <Heart key={i} className={`w-[11px] h-[11px] ${i < lives ? 'fill-red-500 text-red-500' : 'fill-transparent text-white/20'}`} />
                    ))}
                  </span>
                )}
              </div>
            </div>

            {/* Timer — top-right corner */}
            <div className="absolute top-5 right-5 z-40 flex flex-col items-end pointer-events-none select-none">
              <span className={`text-3xl font-black font-mono leading-none tabular-nums ${timeRemaining <= 10 ? 'text-red-500 animate-pulse' : 'text-slate-300'}`}>
                {Math.ceil(timeRemaining)}s
              </span>
              <span className="text-[8px] text-slate-500 font-bold uppercase tracking-widest mt-1">Time Left</span>
            </div>

            {/* Left Target Display */}
            {phase === 'playing' && (
              <div className="absolute top-5 left-36 z-40 flex flex-col items-center pointer-events-none select-none">
                <span className="text-[8px] font-bold text-gray-500 uppercase tracking-widest bg-gray-900/60 border border-gray-800 px-1.5 py-0.5 rounded">LEFT TARGET</span>
                <span className="text-4xl font-black text-white mt-1 leading-none drop-shadow-[0_0_10px_rgba(96,165,250,0.5)]">{leftTarget}</span>
              </div>
            )}

            {/* Right Target Display */}
            {phase === 'playing' && (
              <div className="absolute top-5 right-36 z-40 flex flex-col items-center pointer-events-none select-none">
                <span className="text-[8px] font-bold text-gray-500 uppercase tracking-widest bg-gray-900/60 border border-gray-800 px-1.5 py-0.5 rounded">RIGHT TARGET</span>
                <span className="text-4xl font-black text-white mt-1 leading-none drop-shadow-[0_0_10px_rgba(96,165,250,0.5)]">{rightTarget}</span>
              </div>
            )}

            {/* play field — flying shapes draw on one shared canvas (see the
                resize/draw effect above) instead of as individually-animated
                DOM elements; onPointerDown hit-tests taps against whichever
                shapes are currently live. */}
            <div
              ref={playFieldRef}
              onPointerDown={handlePlayFieldPointerDown}
              className="absolute inset-0 flex select-none overflow-hidden z-10 pointer-events-auto touch-none"
            >
              <div className="absolute top-0 left-1/2 w-px h-full bg-gradient-to-b from-transparent via-violet-500/30 to-transparent z-20 pointer-events-none" />
              <canvas ref={shapeCanvasRef} className="absolute inset-0 z-10 w-full h-full block pointer-events-none" />

              {/* sound toggle */}
              <button
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); setSoundEnabled((v) => { audioSynth?.setEnabled(!v); return !v; }); }}
                className="absolute bottom-4 right-4 z-40 p-2 rounded-full bg-black/60 border border-white/10 text-slate-400 active:scale-90 transition-transform cursor-pointer"
              >
                {soundEnabled ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
              </button>

              {/* particles bursts */}
              {bursts.map((b) => (
                <div key={b.id} className="fx-pop" style={{ left: `${b.x}%`, top: `${b.y}%`, width: 40, height: 40, marginLeft: -20, marginTop: -20, background: b.color === 'red' ? 'rgba(239,68,68,.5)' : 'rgba(34,211,238,.5)', zIndex: 30 }} />
              ))}
            </div>
          </>
        )}

        {/* ── RESULT SCREEN — landscape two-column layout ── */}
        {phase === 'ended' && endSummary && !isChallenge && (
          <div className="absolute inset-0 z-40 flex" style={{ background: 'rgba(5,5,8,0.97)' }}>
            <div className="w-[36%] flex flex-col items-center justify-center gap-1.5 border-r border-white/5" style={{ background: 'radial-gradient(ellipse 260px 200px at 50% 30%, rgba(250,204,21,.08), transparent 70%)' }}>
              {endSummary.isNewBest && (
                <span className="text-[9.5px] font-bold text-yellow-400 bg-yellow-500/10 border border-yellow-500/25 px-2.5 py-0.5 rounded-full mb-1 font-mono">NEW BEST</span>
              )}
              <div className="text-5xl sm:text-6xl font-black leading-none font-mono" style={{ color: endSummary.grade.grade === 'S+' || endSummary.grade.grade === 'S' ? '#fbbf24' : '#a78bfa' }}>
                {endSummary.grade.grade}
              </div>
              <div className="text-[10px] uppercase tracking-widest text-slate-500 font-mono">{endSummary.grade.label}</div>
              <div className="text-3xl sm:text-4xl font-black text-white mt-1 tabular-nums font-mono">{endSummary.score.toLocaleString()}</div>
              <div className="text-[9px] uppercase tracking-widest text-slate-500 font-mono">Points</div>
            </div>

            <div className="flex-1 flex flex-col justify-center gap-3 px-6 sm:px-8 py-4 min-w-0">
              <div className="grid grid-cols-4 gap-2">
                <ResultStat label="Accuracy" value={`${endSummary.accuracy}%`} color="text-blue-400" />
                <ResultStat label="Combo" value={`${endSummary.bestCombo}x`} color="text-orange-400" />
                <ResultStat label="Lives" value={`${endSummary.lives}/${MAX_LIVES}`} color="text-red-400" />
                <ResultStat label="XP" value={`+${endSummary.xpEarned}`} color="text-violet-400" />
              </div>
              <div className="flex gap-2">
                {isChallenge ? (
                  <p className="flex-1 text-xs text-neutral-400 py-3 text-center font-mono">Waiting for your opponent to finish…</p>
                ) : (
                  <button onClick={enterDrill} className="flex-1 py-3 rounded-[13px] bg-gradient-to-r from-violet-600 to-indigo-600 text-white font-bold text-xs uppercase tracking-wide cursor-pointer font-mono">
                    Play Again
                  </button>
                )}
                <button onClick={shareResult} className="w-11 flex-shrink-0 rounded-[13px] bg-white/[0.04] border border-white/10 flex items-center justify-center text-slate-400 hover:text-white cursor-pointer">
                  <Share2 className="w-4 h-4" />
                </button>
                <Link href="/drills/cognitive" className="w-11 flex-shrink-0 rounded-[13px] bg-white/[0.04] border border-white/10 flex items-center justify-center text-slate-400 hover:text-white">
                  <ArrowLeft className="w-4 h-4" />
                </Link>
              </div>
            </div>
          </div>
        )}
      </div>
    </DrillWrapper>
  );
}

// ============================================================
// Subcomponents
// ============================================================
function MiniStat({ label, value, color }) {
  return (
    <div className="rounded-[9px] border border-white/5 bg-white/[0.02] py-1.5 px-1 text-center font-mono">
      <div className={`text-[12px] font-bold ${color}`}>{value}</div>
      <div className="text-[7.5px] uppercase tracking-wide text-slate-500 font-bold mt-0.5">{label}</div>
    </div>
  );
}

function ResultStat({ label, value, color }) {
  return (
    <div className="rounded-[11px] border border-white/5 bg-white/[0.03] py-2 px-1 text-center font-mono">
      <div className={`text-sm font-black ${color} tabular-nums`}>{value}</div>
      <div className="text-[7.5px] uppercase tracking-wide text-slate-500 font-bold mt-0.5">{label}</div>
    </div>
  );
}