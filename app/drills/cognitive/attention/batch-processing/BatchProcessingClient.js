'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  Layers, Volume2, VolumeX, Eye, Ban,
  Zap as ZapIcon, Share2, ArrowLeft,
  Sparkles, Heart
} from 'lucide-react';
import { scoreAction, calcEndBonuses, calcSessionXP, getGrade, isValidReactionTime } from '../../../../../lib/scoringEngine';
import { saveLeaderboardEntrySync } from '../../../../../lib/leaderboard';
import { getPlayerName } from '../../../../../lib/progressStore';
import { lockPortrait, unlockOrientation } from '../../../../../lib/orientation';
import { previewDailyCompletion } from '../../../../../lib/dailyChallenge';
import { Capacitor } from '@capacitor/core';
import { StatusBar } from '@capacitor/status-bar';
import generateShareCard, { shareScoreCard } from '../../../../../components/ShareScoreCard';
import DrillWrapper from '../../../../../components/DrillWrapper';
import { useDuelMatchStart } from '../../../../../lib/challengeEngine';
import { motionDpr, createBackdropCache, createLayeredSpriteCache, drawSprite } from '../../../../../lib/canvasFx';

// ============================================================
// TUNING CONSTANTS
// ============================================================
const TOTAL_TIME = 45.0; // 45 seconds total duration
const BASELINE_SESSION_SECONDS = 45.0;
const MAX_LIVES = 5;
const MAX_ON_SCREEN_ITEMS = 18;
const MAX_LEVEL = 20; // uncapped-feeling difficulty ceiling for skilled players
const POINTS_PER_LEVEL = 350; // lower = levels (and difficulty) climb faster within the 45s session
// >1 = slightly gentle ramp for new players early on, then curves upward for
// anyone still climbing levels — difficulty should never plateau on them.
const DIFFICULTY_CURVE_EXPONENT = 1.2;

const COLOR_HEX = {
  "RED": { main: "#ef4444", dark: "#991b1b", light: "#fca5a5" },
  "BLUE": { main: "#3b82f6", dark: "#1e3a8a", light: "#93c5fd" },
  "GREEN": { main: "#22c55e", dark: "#14532d", light: "#86efac" },
  "YELLOW": { main: "#eab308", dark: "#713f12", light: "#fef08a" }
};

// ============================================================
// ZERO-LATENCY AUDIO SYNTHESIZER
// ============================================================
class AudioSynthesizer {
  constructor() {
    this.ctx = null;
    this.enabled = true;
  }

  init() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
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

  playHit() {
    this.tone(880, 0.12, 'sine', 0.16, 1760);
  }

  // Warm unison voice (two sine oscillators a few cents apart through a
  // lowpass) — reads richer than a single bare oscillator without turning
  // harsh. Shared by every "soft" cue below (wrong tap, timeout, results).
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

  // "3, 2, 1" tick — same flat sine blip used in the divided-attention drill's countdown.
  playCountdownTick() { this.tone(440, 0.09, 'sine', 0.12, 440); }
  // "GO" — same single-tone() shape as the tick, not the flat robotic beep:
  // a touch higher, a quick upward glide, and a longer/louder release so it
  // lands as the energetic payoff of the countdown instead of a 4th tick.
  playGo() { this.tone(523.25, 0.18, 'triangle', 0.17, 784); }

  playBatchClear() {
    if (!this.enabled || !this.ctx) return;
    try {
      const t0 = this.ctx.currentTime;
      [523.25, 659.25, 783.99, 1046.50].forEach((freq, i) => {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, t0 + i * 0.06);
        gain.gain.setValueAtTime(0.12, t0 + i * 0.06);
        gain.gain.exponentialRampToValueAtTime(0.001, t0 + i * 0.06 + 0.3);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(t0 + i * 0.06);
        osc.stop(t0 + i * 0.06 + 0.3);
      });
    } catch (e) {}
  }

  playPenalty() {
    if (!this.enabled || !this.ctx) return;
    try {
      const t0 = this.ctx.currentTime;
      // Two rapid, crisp low-frequency rejections
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

  playResultsReveal() {
    // Rising arpeggio into a bright sustained top note — a clean "results
    // are in" reveal that works for the screen whether the run was strong
    // or not, instead of the old fail-buzzer sting that played every time.
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
      const vol = 0.04 + danger * 0.10;
      const t0 = this.ctx.currentTime;
      [0, 0.15].forEach((offset) => {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(65, t0 + offset);
        gain.gain.setValueAtTime(vol, t0 + offset);
        gain.gain.exponentialRampToValueAtTime(0.001, t0 + offset + 0.15);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(t0 + offset);
        osc.stop(t0 + offset + 0.15);
      });
    } catch (e) {}
  }

  setEnabled(status) {
    this.enabled = status;
  }
}

const audioSynth = typeof window !== 'undefined' ? new AudioSynthesizer() : null;

// ============================================================
// LOCAL STORAGE KEYS & LOADERS
// ============================================================
const STORAGE_KEY = 'skilldrills_batch_processing_v4';

const getSavedData = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const legacyBest = localStorage.getItem('skilldrills_batch_best_v3');
      return {
        bestScore: parseInt(legacyBest) || 0,
        bestCombo: 0,
        bestShiftStreak: 0,
        bestLevel: 1,
        totalSessions: 0
      };
    }
    return { bestScore: 0, bestCombo: 0, bestShiftStreak: 0, bestLevel: 1, totalSessions: 0, ...JSON.parse(raw) };
  } catch (e) {
    return { bestScore: 0, bestCombo: 0, bestShiftStreak: 0, bestLevel: 1, totalSessions: 0 };
  }
};

const saveData = (data) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) {}
};

// ============================================================
// MAIN COMPONENT
// ============================================================
export default function BatchProcessingClient() {
  const searchParams = useSearchParams();
  const challengeId = searchParams ? searchParams.get('challengeId') : null;
  const isChallenge = !!challengeId;
  const totalTime = isChallenge ? 30 : TOTAL_TIME;
  const sessionSeconds = isChallenge ? 30 : BASELINE_SESSION_SECONDS;

  const matchStartAt = useDuelMatchStart(challengeId);

  // React View States
  const [isClient, setIsClient] = useState(false);
  const [loading, setLoading] = useState(true);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [phase, setPhase] = useState('start'); // start | countdown | playing | ended

  const [countdownValue, setCountdownValue] = useState(3);
  const [score, setScore] = useState(0);
  const [level, setLevel] = useState(1);
  const [timeRemaining, setTimeRemaining] = useState(totalTime);
  const [lives, setLives] = useState(MAX_LIVES);
  const [dangerLevel, setDangerLevel] = useState(0);

  // Stats for local bests display
  const [bestScore, setBestScore] = useState(0);
  const [bestCombo, setBestCombo] = useState(0);
  const [bestShiftStreak, setBestShiftStreak] = useState(0);
  const [bestLevel, setBestLevel] = useState(1);

  // Explosions & UI updates
  const [flashes, setFlashes] = useState([]);
  const [shakeCls, setShakeCls] = useState('');
  const [endSummary, setEndSummary] = useState(null);

  // Engine Refs
  const mountedRef = useRef(false);
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const gameActiveRef = useRef(false);
  const duelAutoStartedRef = useRef(false);

  // Scoring/State Tracker Refs
  const scoreRef = useRef(0);
  const timeRef = useRef(totalTime);
  const elapsedRef = useRef(0.0);
  const livesRef = useRef(MAX_LIVES);
  const comboRef = useRef(0);
  const bestComboRef = useRef(0);
  const shiftStreakRef = useRef(0);
  const bestShiftStreakRef = useRef(0);
  const levelRef = useRef(1);
  const highestLevelRef = useRef(1);
  const lastTapTimeRef = useRef(0);

  // Game Analytics Refs
  const hitsRef = useRef(0);
  const falseAlarmsRef = useRef(0);
  const missesRef = useRef(0);
  const resolvedBatchesRef = useRef([]); // holds recent rolling window data

  // Current Batch Context Refs
  const currentBatchRef = useRef('');
  const prevCategoryRef = useRef('');
  const batchSpawnedAtRef = useRef(0);
  const batchIsDirtyRef = useRef(false);

  // Spawn parameters derived from difficulty
  const batchWindowMsRef = useRef(1000); // Starts at exactly 1.0 second (1000ms)
  const hardestWindowMsRef = useRef(1050); // Ratchet floor — see updateDifficulty()
  const itemRadiusRef = useRef(26);
  const itemSpeedRef = useRef(1.8);
  const typesPoolRef = useRef(["RED", "BLUE", "GREEN"]);

  // Physics Arrays
  const itemsRef = useRef([]);
  const particlesRef = useRef([]);
  const scorePopupsRef = useRef([]); // floating "+N" text that rises from the tapped target
  const canvasSizeRef = useRef({ width: 0, height: 0 });

  // Timers
  const globalTimerRef = useRef(null);
  const batchTimerRef = useRef(null);
  const heartbeatTimerRef = useRef(null);
  const countdownTimerRef = useRef(null);
  const animationRef = useRef(null);
  const shakeToggleRef = useRef(0);
  const heartbeatTempoRef = useRef(1100);

  // Mount/Cleanup
  useEffect(() => {
    setIsClient(true);
    mountedRef.current = true;
    lockPortrait();
    try {
      const saved = getSavedData();
      setBestScore(saved.bestScore);
      setBestCombo(saved.bestCombo);
      setBestShiftStreak(saved.bestShiftStreak || 0);
      setBestLevel(saved.bestLevel);
    } catch (e) {}

    setTimeout(() => {
      if (mountedRef.current) setLoading(false);
    }, 200);

    return () => {
      mountedRef.current = false;
      gameActiveRef.current = false;
      cleanupTimers();
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
      if (Capacitor.isNativePlatform()) StatusBar.show().catch(() => {});
      unlockOrientation();
    };
  }, []);

  // Resize and Orientation Handlers
  const handleResize = useCallback(() => {
    const cvs = canvasRef.current;
    if (!cvs) return;
    const rect = cvs.getBoundingClientRect();
    const dpr = motionDpr();
    cvs.width = rect.width * dpr;
    cvs.height = rect.height * dpr;
    canvasSizeRef.current = { width: rect.width, height: rect.height };
  }, []);

  useEffect(() => {
    if (phase === 'playing') {
      handleResize();
      window.addEventListener('resize', handleResize);
      window.addEventListener('orientationchange', handleResize);
    }
    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('orientationchange', handleResize);
    };
  }, [phase, handleResize]);

  // Audio state watcher
  useEffect(() => {
    if (audioSynth) audioSynth.setEnabled(soundEnabled);
  }, [soundEnabled]);

  const cleanupTimers = () => {
    [batchTimerRef, heartbeatTimerRef, countdownTimerRef].forEach((r) => {
      if (r.current) {
        clearTimeout(r.current);
        r.current = null;
      }
    });
    if (globalTimerRef.current) {
      clearInterval(globalTimerRef.current);
      globalTimerRef.current = null;
    }
  };

  const triggerFlash = useCallback((variant) => {
    const id = Date.now() + Math.random();
    setFlashes((f) => [...f, { id, variant }]);
    setTimeout(() => {
      if (mountedRef.current) setFlashes((f) => f.filter((x) => x.id !== id));
    }, 480);
  }, []);

  const triggerShake = useCallback((intensity) => {
    shakeToggleRef.current = shakeToggleRef.current === 0 ? 1 : 0;
    setShakeCls(`fx-shake-${intensity}-${shakeToggleRef.current === 0 ? 'a' : 'b'}`);
  }, []);

  const spawnExplosion = useCallback((x, y, r, type) => {
    particlesRef.current.push({ x, y, r, alpha: 1.0, type });
  }, []);

  const spawnScorePopup = useCallback((x, y, text, color = '#4ade80') => {
    scorePopupsRef.current.push({ x, y, text, color, life: 1.0, maxLife: 1.0 });
  }, []);

  // Sync state variables back to React view
  const syncToUI = useCallback(() => {
    setScore(scoreRef.current);
    setLives(livesRef.current);
    setLevel(levelRef.current);
    setTimeRemaining(timeRef.current);
  }, []);

  // ============================================================
  // DIFFICULTY ENGINE: LEVEL & PARAMETER SCALING
  // ============================================================
  // Eased 0..1 progress through the level range — gentle early on, steep late,
  // so early levels stay approachable but a skilled player gets pushed hard.
  const getDifficultyProgress = () => {
    const linear = Math.min(1.0, (levelRef.current - 1) / (MAX_LEVEL - 1));
    return Math.pow(linear, DIFFICULTY_CURVE_EXPONENT);
  };

  const updateDifficulty = useCallback(() => {
    // Level up thresholds based on score performance milestone markers.
    // No soft cap — skilled players keep climbing instead of plateauing.
    // Duels ramp with TIME instead — both players must face identical
    // difficulty at every moment for the score race to be a pure skill
    // comparison.
    const newLevel = isChallenge
      ? Math.min(MAX_LEVEL, 1 + Math.floor(((totalTime - timeRef.current) / totalTime) * MAX_LEVEL))
      : Math.min(MAX_LEVEL, Math.floor(scoreRef.current / POINTS_PER_LEVEL) + 1);
    if (newLevel > levelRef.current) {
      levelRef.current = newLevel;
      highestLevelRef.current = Math.max(highestLevelRef.current, newLevel);
      setLevel(newLevel);
    }

    const progress = getDifficultyProgress();

    // Reaction window starts at 1050ms (a touch more forgiving than the old flat 1000ms), crushes down to 200ms at max level
    let windowMs = Math.round(1050 - progress * 850);

    // Scale down even faster for high-performing players on combo streaks
    if (comboRef.current >= 3) {
      const comboBonus = Math.min(200, (comboRef.current - 2) * 30); // reduce up to 200ms
      windowMs = Math.max(180, windowMs - comboBonus); // hard minimum floor of 180ms
    }

    // Ratchet: a mistake resets combo, and without this the very next
    // spawn's window would revert to the easier level-only baseline —
    // handing back difficulty a mistake just earned. Once a window this
    // tight has been reached, never hand back anything easier.
    windowMs = Math.min(windowMs, hardestWindowMsRef.current);
    hardestWindowMsRef.current = windowMs;

    batchWindowMsRef.current = windowMs;

    // Constant size regardless of difficulty (matches ConflictReflexClient.js's
    // getBallRadius approach) — kept below Conflict Reflex's own 22-50px
    // ceiling since up to 18 items can share the screen here at once (vs.
    // Conflict Reflex's 2); see the baseDistractors comment below for the
    // matching distractor-count cap that keeps this from overcrowding.
    itemRadiusRef.current = 22; // ~10% smaller for extra room to move
    itemSpeedRef.current = 1.3 + progress * 4.5; // items move faster from 1.3 to 5.8

    if (progress >= 0.45) {
      typesPoolRef.current = ["RED", "BLUE", "GREEN", "YELLOW"];
    } else {
      typesPoolRef.current = ["RED", "BLUE", "GREEN"];
    }
  }, [isChallenge, totalTime]);

  // ============================================================
  // GAMEPLAY ACTIONS: SPAWNING, TAPPING, RESOLUTION
  // ============================================================
  const spawnBatch = useCallback(() => {
    if (batchTimerRef.current) clearTimeout(batchTimerRef.current);
    if (!gameActiveRef.current) return;

    updateDifficulty();

    const progress = getDifficultyProgress();
    const batchSize = 1;

    // Distractor count scaling: starts at 3, climbs to 13 from difficulty
    // progress alone (lowered from 17 now that item size no longer shrinks
    // to compensate — see itemRadiusRef above). Sustained skilled play can
    // still push further via additionalDistractors below, up to the hard
    // MAX_ON_SCREEN_ITEMS ceiling.
    const baseDistractors = 3 + Math.floor(progress * 10); // 3 to 13
    const additionalDistractors = Math.floor(hitsRef.current / 2); // +1 distractor for every 2 correct clicks
    const distractorCount = Math.min(MAX_ON_SCREEN_ITEMS - 1, baseDistractors + additionalDistractors);
    
    const moveSpeed = itemSpeedRef.current;
    const radius = itemRadiusRef.current;

    const pool = typesPoolRef.current;
    let targetType = pool[Math.floor(Math.random() * pool.length)];
    if (prevCategoryRef.current && pool.length > 1) {
      while (targetType === prevCategoryRef.current) {
        targetType = pool[Math.floor(Math.random() * pool.length)];
      }
    }

    currentBatchRef.current = targetType;
    batchSpawnedAtRef.current = Date.now();
    batchIsDirtyRef.current = false;

    // Layout
    const w = canvasSizeRef.current.width || 800;
    const h = canvasSizeRef.current.height || 500;
    const padding = radius + 15;
    const topHUD = h < 400 ? 55 : 95;
    const safeW = Math.max(20, w - padding * 2);
    const safeH = Math.max(20, h - topHUD - padding * 2);

    itemsRef.current = [];
    const totalItems = Math.min(MAX_ON_SCREEN_ITEMS, batchSize + distractorCount);

    for (let i = 0; i < totalItems; i++) {
      const isTarget = i < batchSize;
      let type = targetType;
      if (!isTarget) {
        const distractors = pool.filter((t) => t !== targetType);
        type = distractors[Math.floor(Math.random() * distractors.length)] || "BLUE";
      }

      let bestX = padding + Math.random() * safeW;
      let bestY = topHUD + padding + Math.random() * safeH;
      let bestMinDist = -1;

      for (let attempt = 0; attempt < 8; attempt++) {
        const cx = padding + Math.random() * safeW;
        const cy = topHUD + padding + Math.random() * safeH;
        let minDist = 99999;

        for (const item of itemsRef.current) {
          const dist = Math.hypot(item.x - cx, item.y - cy);
          if (dist < minDist) minDist = dist;
        }

        if (minDist > bestMinDist) {
          bestMinDist = minDist;
          bestX = cx;
          bestY = cy;
        }
        if (minDist > radius * 3.5) break;
      }

      const angle = Math.random() * Math.PI * 2;
      const vx = Math.cos(angle) * moveSpeed;
      const vy = Math.sin(angle) * moveSpeed;
      const seed = Math.random() * 100;

      itemsRef.current.push({
        id: Date.now() + Math.random() + i,
        x: bestX,
        y: bestY,
        r: radius,
        type,
        vx,
        vy,
        speed: moveSpeed,
        seed,
        isTarget
      });
    }

    itemsRef.current.sort(() => Math.random() - 0.5);

    batchTimerRef.current = setTimeout(() => {
      resolveBatchTimeout();
    }, batchWindowMsRef.current);

    syncToUI();
  }, [updateDifficulty, syncToUI]);

  // Game over triggers
  const endGame = useCallback(async () => {
    if (!gameActiveRef.current) return;
    gameActiveRef.current = false;

    cleanupTimers();

    audioSynth?.playResultsReveal();
    triggerFlash('red-hard');

    const total = hitsRef.current + falseAlarmsRef.current + missesRef.current;
    const accPercent = total > 0 ? Math.round((hitsRef.current / total) * 100) : 100;

    const bonuses = calcEndBonuses({
      rawScore: scoreRef.current,
      accuracy: accPercent,
      bestCombo: bestComboRef.current,
      totalActions: total,
      mistakes: falseAlarmsRef.current + missesRef.current,
      livesRemaining: Math.max(0, livesRef.current),
      maxLives: MAX_LIVES,
      category: 'cognitive'
    });

    const finalScore = bonuses.finalScore;
    const prevSaved = getSavedData();
    const isNewBest = finalScore > prevSaved.bestScore;
    const firstPlay = prevSaved.totalSessions === 0;
    const daily = isChallenge
      ? { isDailyDrill: false, wouldCompleteSet: false }
      : await previewDailyCompletion('batch-processing');
    const xpResult = calcSessionXP({ finalScore, accuracy: accPercent, isNewBest, firstPlay, dailyChallenge: daily.isDailyDrill, dailyChallengeSetComplete: daily.wouldCompleteSet });

    const updated = {
      bestScore: Math.max(prevSaved.bestScore, finalScore),
      bestCombo: Math.max(prevSaved.bestCombo, bestComboRef.current),
      bestShiftStreak: Math.max(prevSaved.bestShiftStreak || 0, bestShiftStreakRef.current),
      bestLevel: Math.max(prevSaved.bestLevel || 1, highestLevelRef.current),
      totalSessions: prevSaved.totalSessions + 1
    };
    saveData(updated);

    setBestScore(updated.bestScore);
    setBestCombo(updated.bestCombo);
    setBestShiftStreak(updated.bestShiftStreak);
    setBestLevel(updated.bestLevel);

    saveLeaderboardEntrySync({
      drillId: 'batch-processing',
      drillName: 'Batch Processing',
      category: 'cognitive',
      score: finalScore,
      accuracy: accPercent,
      bestCombo: bestComboRef.current
    });

    setEndSummary({
      score: finalScore,
      accuracy: accPercent,
      bestCombo: bestComboRef.current,
      bestShiftStreak: bestShiftStreakRef.current,
      levelReached: highestLevelRef.current,
      lives: Math.max(0, livesRef.current),
      isNewBest,
      perfectRun: (falseAlarmsRef.current + missesRef.current) === 0 && hitsRef.current >= 15,
      xpEarned: xpResult.xp
    });

    if (Capacitor.isNativePlatform()) StatusBar.show().catch(() => {});
    setPhase('ended');
  }, [triggerFlash]);

  // Handle Correct Tap
  const resolveCorrectHit = (item) => {
    hitsRef.current += 1;
    if (batchTimerRef.current) clearTimeout(batchTimerRef.current);

    const now = Date.now();
    lastTapTimeRef.current = now;

    let reactionMs = now - batchSpawnedAtRef.current;
    if (!isValidReactionTime(reactionMs)) {
      reactionMs = 300;
    }

    const pts = scoreAction({
      category: 'cognitive',
      combo: comboRef.current,
      reactionMs,
      timeRemaining: Math.max(0.0, sessionSeconds - elapsedRef.current),
      totalGameTime: sessionSeconds,
      livesRemaining: Math.max(0, livesRef.current),
      maxLives: MAX_LIVES,
      level: levelRef.current,
      maxLevel: MAX_LEVEL
    });

    scoreRef.current += pts.total;
    comboRef.current += 1;
    bestComboRef.current = Math.max(bestComboRef.current, comboRef.current);

    spawnExplosion(item.x, item.y, item.r, 'correct');
    spawnScorePopup(item.x, item.y, `+${pts.total}`);

    // Clear screen immediately
    itemsRef.current = [];

    // Every correct tap plays the same hit sound now — no separate combo chime
    audioSynth?.playHit();

    const clearTimeMs = now - batchSpawnedAtRef.current;
    resolvedBatchesRef.current.push({
      accuracy: 1.0,
      clearTimeMs,
      isCleared: true
    });
    if (resolvedBatchesRef.current.length > 6) {
      resolvedBatchesRef.current.shift();
    }

    const isShift = prevCategoryRef.current && currentBatchRef.current !== prevCategoryRef.current;
    if (isShift && !batchIsDirtyRef.current) {
      shiftStreakRef.current += 1;
      bestShiftStreakRef.current = Math.max(bestShiftStreakRef.current, shiftStreakRef.current);
    }

    prevCategoryRef.current = currentBatchRef.current;

    setTimeout(() => {
      if (gameActiveRef.current) spawnBatch();
    }, 120);
  };

  // Handle Incorrect Tap (decoy click)
  const resolveFalseAlarm = (item) => {
    falseAlarmsRef.current += 1;
    batchIsDirtyRef.current = true;

    if (batchTimerRef.current) clearTimeout(batchTimerRef.current);

    comboRef.current = 0;
    shiftStreakRef.current = 0;

    // No score penalty on a wrong tap — it just breaks your combo. Solo loses
    // a life instead; duels run the full 30s with no life or score cost.
    if (isChallenge) {
      audioSynth?.playPenalty();
    } else {
      livesRef.current = Math.max(0, livesRef.current - 1);
      audioSynth?.playPenalty();
    }

    itemsRef.current = [];
    spawnExplosion(item.x, item.y, item.r, 'wrong');
    triggerShake('hard');
    triggerFlash('red');

    syncToUI();

    // Duels always run the full shared clock — a rough start shouldn't end
    // your side of the match early while the opponent keeps playing.
    if (!isChallenge && livesRef.current <= 0) {
      endGame();
      return;
    }

    prevCategoryRef.current = currentBatchRef.current;

    setTimeout(() => {
      if (gameActiveRef.current) spawnBatch();
    }, 120);
  };

  // Handle Batch Timeout Failure
  const resolveBatchTimeout = () => {
    if (!gameActiveRef.current || !mountedRef.current) return;

    missesRef.current += 1;
    batchIsDirtyRef.current = true;

    resolvedBatchesRef.current.push({
      accuracy: 0.0,
      clearTimeMs: 0,
      isCleared: false
    });
    if (resolvedBatchesRef.current.length > 6) {
      resolvedBatchesRef.current.shift();
    }

    comboRef.current = 0;
    shiftStreakRef.current = 0;

    // No score penalty on a timed-out batch — solo loses a life instead;
    // duels run the full 30s with no life or score cost.
    if (isChallenge) {
      audioSynth?.playPenalty();
    } else {
      livesRef.current = Math.max(0, livesRef.current - 1);
      audioSynth?.playPenalty();
    }

    itemsRef.current.forEach((it) => {
      if (it.type === currentBatchRef.current) {
        spawnExplosion(it.x, it.y, it.r, 'missed');
      }
    });

    itemsRef.current = [];
    triggerShake('soft');
    triggerFlash('red');

    syncToUI();

    if (!isChallenge && livesRef.current <= 0) {
      endGame();
      return;
    }

    prevCategoryRef.current = currentBatchRef.current;

  setTimeout(() => {
      if (gameActiveRef.current) spawnBatch();
    }, 120);
  };

  // Pointer Down Hit Testing
  const handlePointerDown = useCallback((e) => {
    if (!gameActiveRef.current) return;
    if (e) {
      e.preventDefault();
      e.stopPropagation();
      if (e.target.setPointerCapture) e.target.setPointerCapture(e.pointerId);
    }

    const cvs = canvasRef.current;
    if (!cvs) return;

    const rect = cvs.getBoundingClientRect();
    const clientX = e.clientX;
    const clientY = e.clientY;

    const x = clientX - rect.left;
    const y = clientY - rect.top;

    const now = Date.now();
    if (now - lastTapTimeRef.current < 55) return;

    let hitIdx = -1;
    for (let i = itemsRef.current.length - 1; i >= 0; i--) {
      const item = itemsRef.current[i];
      if (Math.hypot(item.x - x, item.y - y) <= item.r + 32) {
        hitIdx = i;
        break;
      }
    }

    if (hitIdx !== -1) {
      const item = itemsRef.current[hitIdx];
      if (item.type === currentBatchRef.current) {
        resolveCorrectHit(item);
      } else {
        resolveFalseAlarm(item);
      }
    }
  }, []);

  // ============================================================
  // 60FPS INTEGRATION & RENDERING LOOP
  // ============================================================
  useEffect(() => {
    if (phase !== 'playing' && phase !== 'countdown') {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
        animationRef.current = null;
      }
      return;
    }

    // 60fps cap (14ms, not 32ms). Movement below is per-frame
    // (it.x += it.vx), so without a cap a 120Hz phone both paid double the
    // draw cost AND ran the balls at double speed vs a 60Hz laptop.
    // frameScale keeps ball speed pinned to the 60fps baseline even when the
    // real frame gap isn't exactly 16.7ms (90Hz phones, or a device
    // throttling under load).
    //
    // The threshold was 32ms — a ~30fps cap — from a blanket CPU pass. That's
    // the wrong call here: these balls drift continuously, so halving the
    // frame rate doubled the distance each one jumps between frames and read
    // as stutter. 14, not 16, because a genuine 60Hz frame arrives every
    // ~16.7ms but jitters, and a 16ms threshold would occasionally skip one
    // and drop a frame; 14 passes every 60Hz frame while still halving a
    // 120Hz phone to 60.
    let lastDrawTs = 0;

    // Ball sprite cache — see the draw pass below. Four colours at one fixed
    // radius, so this is fully populated within the first frame.
    const sprites = createLayeredSpriteCache();

    // Static play-field backdrop (flat fill + grid), rendered once per size.
    // This grid used to be rebuilt every frame: ~30 full-length line segments
    // stroked across the canvas 60x/sec to reproduce an image that never
    // changes. It was already batched into a single stroke() call, but one
    // drawImage of a cached bitmap is cheaper again.
    const backdrop = createBackdropCache((c, w, h) => {
      c.fillStyle = '#050505';
      c.fillRect(0, 0, w, h);
      c.strokeStyle = 'rgba(255,255,255,0.015)';
      c.lineWidth = 1;
      c.beginPath();
      for (let x = 0; x < w; x += 40) { c.moveTo(x, 0); c.lineTo(x, h); }
      for (let y = 0; y < h; y += 40) { c.moveTo(0, y); c.lineTo(w, y); }
      c.stroke();
    });

    const draw = (timestamp) => {
      const cvs = canvasRef.current;
      if (!cvs) {
        animationRef.current = requestAnimationFrame(draw);
        return;
      }

      // alpha: false — this canvas repaints its whole area every frame and
      // has nothing behind it that should show through. Without it the
      // compositor alpha-blends a full-screen layer on every frame.
      const ctx = cvs.getContext('2d', { alpha: false });
      if (!ctx) {
        animationRef.current = requestAnimationFrame(draw);
        return;
      }

      if (timestamp - lastDrawTs < 14) {
        animationRef.current = requestAnimationFrame(draw);
        return;
      }
      const frameScale = lastDrawTs === 0 ? 1 : Math.min((timestamp - lastDrawTs) / 16.67, 2);
      lastDrawTs = timestamp;

      const w = canvasSizeRef.current.width;
      const h = canvasSizeRef.current.height;
      const dpr = motionDpr();

      ctx.save();
      ctx.scale(dpr, dpr);

      if (backdrop.ensure(w, h, dpr)) {
        ctx.drawImage(backdrop.canvas, 0, 0, w, h);
      } else {
        ctx.fillStyle = '#050505';
        ctx.fillRect(0, 0, w, h);
      }

      const time = performance.now() * 0.001;
      const topHUD = h < 400 ? 55 : 95;

      if (phase === 'playing' && currentBatchRef.current) {
        const c = COLOR_HEX[currentBatchRef.current] || COLOR_HEX["BLUE"];
        ctx.textAlign = "center";
        ctx.fillStyle = c.main;
        const textY = h < 400 ? 32 : 52;
        const textPt = h < 400 ? "32px" : "48px";
        ctx.font = `900 ${textPt} sans-serif`;
        ctx.fillText(currentBatchRef.current, w / 2, textY);

        const items = itemsRef.current;

        // Pass 1: movement — periodic wobble plus true random jitter so
        // paths never repeat the same drift pattern twice
        items.forEach((it) => {
          it.vx += Math.sin(time * 2 + it.seed) * 0.09 + (Math.random() - 0.5) * 0.08;
          it.vy += Math.cos(time * 2.5 + it.seed) * 0.09 + (Math.random() - 0.5) * 0.08;

          const currentVel = Math.hypot(it.vx, it.vy);
          if (currentVel > it.speed) {
            it.vx = (it.vx / currentVel) * it.speed;
            it.vy = (it.vy / currentVel) * it.speed;
          }

          it.x += it.vx * frameScale;
          it.y += it.vy * frameScale;

          if (it.x - it.r < 0) { it.x = it.r; it.vx *= -1; }
          if (it.x + it.r > w) { it.x = w - it.r; it.vx *= -1; }
          if (it.x + it.r < 0) { it.x = it.r; it.vx = Math.abs(it.vx); }
          if (it.y - it.r < topHUD) { it.y = topHUD + it.r; it.vy *= -1; }
          if (it.y + it.r > h) { it.y = h - it.r; it.vy *= -1; }
        });

        // Pass 2: ball-to-ball collisions — items deflect off each other
        // instead of drifting independently, so paths get harder to predict
        for (let i = 0; i < items.length; i++) {
          for (let j = i + 1; j < items.length; j++) {
            const a = items[i], b = items[j];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const dist = Math.hypot(dx, dy);
            const minDist = a.r + b.r;
            if (dist > 0 && dist < minDist) {
              const nx = dx / dist;
              const ny = dy / dist;
              const overlap = (minDist - dist) / 2;
              a.x -= nx * overlap;
              a.y -= ny * overlap;
              b.x += nx * overlap;
              b.y += ny * overlap;

              // Equal-mass elastic bounce: swap the velocity component along the collision normal
              const avn = a.vx * nx + a.vy * ny;
              const bvn = b.vx * nx + b.vy * ny;
              const diff = bvn - avn;
              a.vx += diff * nx;
              a.vy += diff * ny;
              b.vx -= diff * nx;
              b.vy -= diff * ny;
            }
          }
        }

        // Pass 3: draw — ONE drawImage per ball, blitted from the sprite
        // cache, instead of the five arc() paths each ball used to cost.
        // With up to 18 balls on screen that is ~90 path rasterisations a
        // frame (~5,400 a second) collapsed into 18 bitmap blits of shapes
        // that never change. This was the biggest per-frame cost in the drill.
        //
        // The sprite itself keeps the same layered-circle style as
        // ConflictReflexClient.js's drawLayeredCircle — flat fills only, no
        // gradient/shadowBlur, since that combination is a known Android
        // WebView rendering bug (see DividedAttentionClient.js's notes).
        items.forEach((it) => {
          const sphereColor = COLOR_HEX[it.type] || COLOR_HEX["BLUE"];
          drawSprite(ctx, sprites.get(sphereColor.main, it.r, dpr), it.x, it.y);
        });

        for (let i = particlesRef.current.length - 1; i >= 0; i--) {
          const p = particlesRef.current[i];
          p.r += p.type === 'clear' ? 3.5 : 2.5;
          p.alpha -= p.type === 'clear' ? 0.03 : 0.045;

          if (p.alpha <= 0) {
            particlesRef.current.splice(i, 1);
            continue;
          }

          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
          ctx.globalAlpha = p.alpha;

          let strokeColor = '#3b82f6';
          let fillColor = 'rgba(59, 130, 246, 0.2)';
          if (p.type === 'correct') {
            strokeColor = '#4ade80';
            fillColor = 'rgba(74, 222, 128, 0.2)';
          } else if (p.type === 'wrong') {
            strokeColor = '#f87171';
            fillColor = 'rgba(248, 113, 113, 0.2)';
          } else if (p.type === 'missed') {
            strokeColor = '#64748b';
            fillColor = 'rgba(100, 116, 139, 0.15)';
          } else if (p.type === 'clear') {
            strokeColor = '#22d3ee';
            fillColor = 'rgba(34, 211, 238, 0.1)';
          }

          ctx.strokeStyle = strokeColor;
          ctx.lineWidth = p.type === 'clear' ? 3.5 : 2;
          ctx.stroke();
          ctx.fillStyle = fillColor;
          ctx.fill();
          ctx.globalAlpha = 1.0;
        }

        // Score release: the "+N" earned on a correct tap rises and fades from
        // the exact spot it was scored — same in-canvas particle model as the
        // Reflex Training drill (life/maxLife-driven fade, ~38px/sec rise over
        // a ~1s life, bold monospace, middle baseline).
        for (let i = scorePopupsRef.current.length - 1; i >= 0; i--) {
          const s = scorePopupsRef.current[i];
          s.life -= 0.0167 * frameScale;
          s.y -= 0.63 * frameScale;

          if (s.life <= 0) {
            scorePopupsRef.current.splice(i, 1);
            continue;
          }

          ctx.globalAlpha = Math.max(0, s.life / s.maxLife);
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.font = "bold 15px monospace";
          ctx.fillStyle = s.color;
          ctx.fillText(s.text, s.x, s.y);
          ctx.globalAlpha = 1.0;
        }
      }

      ctx.restore();
      animationRef.current = requestAnimationFrame(draw);
    };

    animationRef.current = requestAnimationFrame(draw);
    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  }, [phase]);

  // ============================================================
  // TIMERS & METRONOME EVENTS
  // ============================================================
  const scheduleHeartbeat = useCallback(() => {
    // Duels have NO heartbeat audio and NO danger vignette at all — the
    // match must feel and perform exactly like solo play minus the extras.
    // (Solo keeps the clamps so the self-rescheduling delay can never
    // collapse toward zero.)
    if (isChallenge) return;
    if (!gameActiveRef.current) return;
    const dangerFromLives = livesRef.current <= 2
      ? (MAX_LIVES - livesRef.current) / MAX_LIVES
      : 0;
    const dangerFromTime = timeRef.current <= 10 ? (10.0 - timeRef.current) / 10.0 : 0.0;
    const danger = Math.min(1, Math.max(dangerFromLives * 0.7, dangerFromTime));

    const tempo = Math.max(350, Math.round(1100 - danger * 650));
    heartbeatTempoRef.current = tempo;

    if (danger > 0.08) audioSynth?.playHeartbeat(danger);
    if (mountedRef.current) setDangerLevel(danger);

    heartbeatTimerRef.current = setTimeout(scheduleHeartbeat, tempo);
  }, [isChallenge]);

  const beginPlaying = useCallback(() => {
    gameActiveRef.current = true;
    setPhase('playing');

    // 200ms rather than 100ms — the displayed clock only shows whole seconds,
    // so 5 ticks/sec looks identical to 10 while halving how often this
    // re-renders the whole play field for the entire match.
    globalTimerRef.current = setInterval(() => {
      if (!gameActiveRef.current) return;
      timeRef.current -= 0.2;
      elapsedRef.current += 0.2;

      if (timeRef.current <= 0) {
        timeRef.current = 0.0;
        setTimeRemaining(0.0);
        endGame();
      } else {
        setTimeRemaining(timeRef.current);
        // Duel difficulty is time-driven, so it must advance from the clock
        // itself — not only when a new batch spawns.
        if (isChallenge) updateDifficulty();
      }
    }, 200);

    scheduleHeartbeat();
    spawnBatch();
  }, [scheduleHeartbeat, spawnBatch, endGame, isChallenge, updateDifficulty]);

  const runCountdown = useCallback((n) => {
    if (countdownTimerRef.current) clearTimeout(countdownTimerRef.current);
    if (n <= 0) {
      if (!isChallenge) audioSynth?.playGo();
      beginPlaying();
      return;
    }
    setCountdownValue(n);
    if (!isChallenge) audioSynth?.playCountdownTick();
    countdownTimerRef.current = setTimeout(() => runCountdown(n - 1), 700);
  }, [beginPlaying, isChallenge]);

  const enterDrill = useCallback(() => {
    try { audioSynth?.init(); } catch (e) {}
    lockPortrait();

    gameActiveRef.current = false;
    cleanupTimers();

    // Returning players start closer to their proven skill level instead of
    // always grinding through level 1 again — ~55% of their best level reached.
    // First-time players (no saved bestLevel) still start at level 1.
    const savedForStart = getSavedData();
    const startLevel = Math.max(1, Math.min(MAX_LEVEL, Math.round((savedForStart.bestLevel || 1) * 0.55)));

    // Reset Engine variables
    scoreRef.current = 0;
    timeRef.current = totalTime;
    elapsedRef.current = 0.0;
    livesRef.current = MAX_LIVES;
    comboRef.current = 0;
    bestComboRef.current = 0;
    shiftStreakRef.current = 0;
    bestShiftStreakRef.current = 0;
    levelRef.current = startLevel;
    highestLevelRef.current = startLevel;
    hardestWindowMsRef.current = 1050;
    lastTapTimeRef.current = 0;

    hitsRef.current = 0;
    falseAlarmsRef.current = 0;
    missesRef.current = 0;
    resolvedBatchesRef.current = [];

    currentBatchRef.current = '';
    prevCategoryRef.current = '';
    itemsRef.current = [];
    particlesRef.current = [];
    scorePopupsRef.current = [];

    // Sync React states
    setScore(0);
    setTimeRemaining(totalTime);
    setLives(MAX_LIVES);
    setLevel(startLevel);
    setDangerLevel(0);
    setEndSummary(null);
    setFlashes([]);
    setCountdownValue(3);

    // Fire-and-forget: fullscreen + hiding the native status bar shouldn't
    // block starting the game — awaiting these caused a visible stall where
    // the Start button seemed to flash back before countdown began.
    if (!isChallenge && !document.fullscreenElement && containerRef.current) {
      containerRef.current.requestFullscreen().catch(() => {});
    }
    if (Capacitor.isNativePlatform()) {
      StatusBar.hide().catch(() => {});
    }

    setPhase('countdown');
    runCountdown(isChallenge ? 0 : 3);
  }, [isChallenge, runCountdown, totalTime, sessionSeconds]);

  useEffect(() => {
    if (!isChallenge || !matchStartAt || phase !== 'start' || duelAutoStartedRef.current) return;
    const delay = Math.max(0, matchStartAt - Date.now());
    const t = setTimeout(() => {
      duelAutoStartedRef.current = true;
      enterDrill();
    }, delay);
    return () => clearTimeout(t);
  }, [isChallenge, matchStartAt, phase, enterDrill]);

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

  const shareResult = useCallback(async () => {
    if (!endSummary) return;
    const url = 'https://skilldrills.online/drills/cognitive/attention/batch-processing';

    try {
      const grade = getGrade(endSummary.accuracy);
      const canvas = generateShareCard({
        score: endSummary.score,
        bestScore,
        accuracy: endSummary.accuracy,
        bestCombo: endSummary.bestCombo,
        rating: { letter: grade.grade, label: grade.label, emoji: grade.emoji },
        newBest: endSummary.isNewBest,
        drillName: 'Batch Processing',
        playerName: getPlayerName(),
      });
      await shareScoreCard(url, canvas);
    } catch (e) {
      const text = `Scored ${endSummary.score} on Batch Processing (${endSummary.accuracy}% accuracy, ${endSummary.bestCombo}x combo, ${endSummary.bestShiftStreak}x shift streak) — SkillDrills`;
      if (typeof navigator !== 'undefined' && navigator.share) {
        navigator.share({ title: 'Batch Processing — SkillDrills', text, url }).catch(() => {});
      } else if (typeof navigator !== 'undefined' && navigator.clipboard) {
        navigator.clipboard.writeText(`${text} ${url}`);
        alert('Score card copied to clipboard!');
      }
    }
  }, [endSummary, bestScore]);

  const handleExit = useCallback(() => {
    cleanupTimers();
    try {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    } catch (e) {}
    if (Capacitor.isNativePlatform()) StatusBar.show().catch(() => {});
    setPhase('start');
  }, []);

  if (loading || !isClient) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-[#050508]">
        <div className="text-center">
          <div className="w-14 h-14 border-4 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto mb-4 shadow-[0_0_20px_rgba(59,130,246,0.5)]" />
          <p className="text-slate-500 font-bold tracking-widest uppercase text-[10px] animate-pulse">Loading Batch Engine...</p>
        </div>
      </div>
    );
  }

  return (
    <DrillWrapper
      drillName="Batch Processing"
      category="cognitive"
      score={score}
      timeLeft={phase === 'ended' ? 0 : Math.ceil(timeRemaining)}
      lives={lives}
      maxLives={MAX_LIVES}
      soundEnabled={soundEnabled}
      onSoundToggle={() => setSoundEnabled((v) => !v)}
      backHref="/drills/cognitive"
      minimalChrome
    >
      <div
        ref={containerRef}
        onContextMenu={(e) => { if (gameActiveRef.current) e.preventDefault(); }}
        className={`absolute inset-0 select-none overflow-hidden bg-[#050508] text-white`}
        style={{ touchAction: gameActiveRef.current ? 'none' : 'auto', WebkitTapHighlightColor: 'transparent' }}
      >
        <div className="absolute inset-0 pointer-events-none" style={{ backgroundImage: 'linear-gradient(rgba(255,255,255,0.01) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.01) 1px, transparent 1px)', backgroundSize: '40px 40px' }} />

        {phase === 'playing' && dangerLevel > 0.05 && (
          <div className="fx-vignette" style={{ '--v-min': Math.max(0.04, dangerLevel * 0.22), '--v-max': Math.min(0.55, dangerLevel * 0.70), animationDuration: `${heartbeatTempoRef.current}ms` }} />
        )}

        {flashes.map((f) => (
          <div key={f.id} className={`fx-flash ${f.variant === 'cyan' ? 'fx-flash-cyan' : 'fx-flash-red'}`} />
        ))}

        {(phase === 'start' || phase === 'countdown' || phase === 'playing') && (
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); setSoundEnabled((v) => !v); }}
            className="absolute bottom-5 right-5 z-40 p-2 before:absolute before:top-0 before:left-0 before:-right-[14px] before:-bottom-[14px] before:content-[''] rounded-full bg-black/60 border border-white/10 text-slate-400 active:scale-90 transition-transform"
          >
            {soundEnabled ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
          </button>
        )}

        {/* ── START SCREEN ── */}
        {phase === 'start' && !isChallenge && (
          <div className="relative h-full flex items-center justify-center p-5 overflow-y-auto bg-[#050505] text-white">
            {/* Start game card ONLY - no extra header, breadcrumbs or instructions outside the card */}
            <div className="relative w-full max-w-[290px] mx-auto rounded-[20px] border border-white/5 bg-[#0c0c16]/90 backdrop-blur-lg px-5 pt-5 pb-[18px] text-center shadow-[0_16px_40px_rgba(0,0,0,.5)] my-6">
              <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(ellipse 420px 260px at 50% 8%, rgba(59,130,246,.12), transparent 70%)' }} />
              <div className="w-11 h-11 mx-auto rounded-[14px] bg-gradient-to-br from-blue-600 to-indigo-600 flex items-center justify-center mb-3 shadow-[0_0_22px_rgba(59,130,246,.3)]">
                <Layers className="w-[22px] h-[22px] text-white" />
              </div>
              <h2 className="text-[17px] font-bold tracking-tight">Batch Processing</h2>
              <p className="text-[9px] font-bold text-slate-500 uppercase tracking-widest mt-1">45-second run</p>

              <div className="flex flex-col gap-1.5 text-left mt-3.5">
                <HowToRow icon={<Eye className="w-3.5 h-3.5 text-cyan-400 flex-shrink-0" />} node={<>Tap the sphere matching the prompt</>} />
                <HowToRow icon={<Ban className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />} node={<>Ignore every other color</>} />
                <HowToRow icon={<ZapIcon className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" />} node={<>Faster taps score more · 5 lives</>} />
              </div>

              <div className="grid grid-cols-3 gap-1.5 mt-3.5">
                <MiniStat label="Best" value={bestScore} color="text-yellow-400" />
                <MiniStat label="Combo" value={`${bestCombo}x`} color="text-orange-400" />
                <MiniStat label="Shift" value={`${bestShiftStreak}x`} color="text-blue-400" />
              </div>

              <button
                onClick={enterDrill}
                className="w-full mt-3.5 py-[11px] rounded-[13px] bg-gradient-to-r from-blue-600 to-indigo-600 font-bold text-[12.5px] tracking-wide active:scale-[0.97] transition-transform shadow-[0_0_20px_rgba(59,130,246,.3)] cursor-pointer"
              >
                START
              </button>
            </div>
          </div>
        )}

        {/* ── PLAYING / COUNTDOWN LAYER ── */}
        {(phase === 'playing' || phase === 'countdown') && (
          <>
            {/* Own HUD — shown in BOTH modes: a duel plays exactly like solo
                (DrillWrapper renders no duel chrome mid-match anymore).
                Hearts are solo-only — duels have no lives. */}

            <div className="absolute top-5 left-5 z-40 flex flex-col pointer-events-none">
              <span className="text-2xl font-black text-white leading-none tabular-nums">{score}</span>
              <div className="flex items-center gap-2 mt-1.5">
                {isChallenge ? (
                  <span className="text-[10px] font-black text-blue-300 bg-blue-500/15 border border-blue-500/25 px-1.5 py-0.5 rounded">Lv.{level}</span>
                ) : (
                  <span className="flex items-center gap-0.5">
                    {Array.from({ length: MAX_LIVES }).map((_, i) => (
                      <Heart key={i} className={`w-3 h-3 ${i < lives ? 'fill-red-500 text-red-500' : 'text-white/15'}`} />
                    ))}
                  </span>
                )}
              </div>
            </div>

            <div className="absolute top-5 right-5 z-40 flex flex-col items-end pointer-events-none select-none">
              <span className={`text-3xl font-black font-mono leading-none ${timeRemaining <= 10 ? 'text-red-500 animate-pulse' : 'text-slate-300'}`}>
                {Math.ceil(timeRemaining)}s
              </span>
              <span className="text-[8px] text-slate-500 font-bold uppercase tracking-widest mt-1">Time Left</span>
            </div>

            <div className="relative w-full h-full">
              <canvas
                ref={canvasRef}
                onPointerDown={handlePointerDown}
                className={`absolute inset-0 z-10 w-full h-full block ${phase === 'playing' ? 'cursor-crosshair' : 'cursor-default'}`}
              />
            </div>
          </>
        )}

        {/* Countdown Phase */}
        {phase === 'countdown' && !isChallenge && (
          <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/55 backdrop-blur-[2px]">
            <span className="text-[11px] font-black uppercase tracking-[0.2em] text-slate-400">Get Ready</span>
            <div className="relative w-28 h-28 rounded-full border-[3px] border-blue-500/20 flex items-center justify-center">
              <div className="absolute -inset-[3px] rounded-full border-[3px] border-transparent border-t-blue-400 border-r-blue-400 animate-spin" style={{ animationDuration: '0.7s' }} />
              <span key={countdownValue} className="fx-pop-in text-5xl font-black bg-gradient-to-b from-white to-blue-300 bg-clip-text text-transparent">
                {countdownValue > 0 ? countdownValue : 'GO'}
              </span>
            </div>
            <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">Targets spawn at GO</span>
          </div>
        )}

        {/* ── RESULT SCREEN ── */}
        {phase === 'ended' && endSummary && !isChallenge && (
          <ResultScreen summary={endSummary} isChallenge={isChallenge} onPlayAgain={enterDrill} onShare={shareResult} onExit={handleExit} />
        )}
      </div>
    </DrillWrapper>
  );
}

// ============================================================
// SUBCOMPONENTS
// ============================================================
function HowToRow({ icon, node }) {
  return (
    <div className="flex items-center gap-2 bg-white/[0.02] border border-white/5 rounded-[10px] px-2.5 py-[7px]">
      {icon}
      <span className="text-[10.5px] text-slate-300 leading-tight whitespace-nowrap">{node}</span>
    </div>
  );
}

function MiniStat({ label, value, color }) {
  return (
    <div className="rounded-[9px] border border-white/5 bg-white/[0.02] py-1.5 px-1 text-center">
      <div className={`text-[12px] font-bold ${color}`}>{value}</div>
      <div className="text-[7.5px] uppercase tracking-wide text-slate-500 font-bold mt-0.5">{label}</div>
    </div>
  );
}

function ResultScreen({ summary, isChallenge, onPlayAgain, onShare, onExit }) {
  const grade = getGrade(summary.accuracy);
  const gradeColor = grade.grade === 'S+' || grade.grade === 'S' ? '#fbbf24' : '#60a5fa';

  return (
    <div className="absolute inset-0 z-40 flex bg-neutral-950/98" style={{ background: 'rgba(5,5,8,0.97)' }}>
      <div className="w-[36%] flex flex-col items-center justify-center gap-1.5 border-r border-white/5" style={{ background: 'radial-gradient(ellipse 260px 200px at 50% 30%, rgba(59,130,246,.08), transparent 70%)' }}>
        {summary.isNewBest && (
          <span className="text-[9.5px] font-bold text-yellow-400 bg-yellow-500/10 border border-yellow-500/25 px-2.5 py-0.5 rounded-full mb-1 animate-pulse">NEW BEST</span>
        )}
        <div className="text-5xl sm:text-6xl font-black leading-none" style={{ color: gradeColor }}>{grade.grade}</div>
        <div className="text-[10px] uppercase tracking-widest text-slate-500">{grade.label}</div>
        <div className="text-3xl sm:text-4xl font-black text-white mt-1 tabular-nums">{summary.score.toLocaleString()}</div>
        <div className="text-[9px] uppercase tracking-widest text-slate-500">Points</div>
      </div>

      <div className="flex-1 flex flex-col justify-center gap-3 px-6 sm:px-8 py-4 min-w-0">
        <div className="grid grid-cols-4 gap-2">
          <ResultStat label="Accuracy" value={`${summary.accuracy}%`} color="text-blue-400" />
          <ResultStat label="Combo" value={`${summary.bestCombo}x`} color="text-orange-400" />
          <ResultStat label="Shifts" value={`${summary.bestShiftStreak}x`} color="text-indigo-400" />
          <ResultStat label="XP" value={`+${summary.xpEarned}`} color="text-violet-400" />
        </div>
        <div className="flex gap-2">
          {isChallenge ? (
            <p className="text-xs text-neutral-400 py-3 text-center flex-1">Waiting for your opponent to finish…</p>
          ) : (
            <button onClick={onPlayAgain} className="flex-1 py-3 rounded-[13px] bg-gradient-to-r from-blue-600 to-indigo-600 text-white font-bold text-xs uppercase tracking-wide cursor-pointer transition-transform active:scale-[0.98]">
              Play Again
            </button>
          )}
          <button onClick={onShare} className="w-11 flex-shrink-0 rounded-[13px] bg-white/[0.04] border border-white/10 flex items-center justify-center text-slate-400 hover:text-white cursor-pointer active:scale-90 transition-transform">
            <Share2 className="w-4 h-4" />
          </button>
          <Link href="/drills/cognitive" className="w-11 flex-shrink-0 rounded-[13px] bg-white/[0.04] border border-white/10 flex items-center justify-center text-slate-400 hover:text-white">
            <ArrowLeft className="w-4 h-4 text-slate-400" />
          </Link>
        </div>
      </div>
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
