'use client';

import React, { useEffect, useState, useRef, useCallback } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  RotateCcw, Share2, ArrowLeft, Heart,
  Volume2, VolumeX, Zap as ZapIcon, Ban, HelpCircle
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
import { AudioSynthesizer } from '../../../../../lib/audioSynth';
import { canvasDpr } from '../../../../../lib/canvasFx';
import { useDuelMatchStart } from '../../../../../lib/challengeEngine';

// Local subclass — lib/audioSynth.js is shared across drills, so its methods
// aren't touched here. Overrides GO/penalty to match BatchProcessingClient.js's
// redesigned cues, and adds the results-reveal chime as new (non-conflicting)
// methods; playHit/playCountdownTick/playHeartbeat are inherited untouched.
class ConflictReflexAudio extends AudioSynthesizer {
  // Same tone() shape as the tick, just a step higher with a quick upward
  // glide — matches BatchProcessingClient.js's GO exactly.
  playGo() { this.tone(523.25, 0.18, 'triangle', 0.17, 784); }

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
}

const audioSynth = typeof window !== 'undefined' ? new ConflictReflexAudio() : null;

// ============================================================
// TUNING
// ============================================================
const TOTAL_TIME = 45;
const MAX_LIVES = 5;
const MAX_LEVEL = 15;

const STORAGE_KEY = 'skilldrills_conflict_reflex_v1';

const getSavedData = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      return { bestScore: 0, bestCombo: 0, bestLevel: 1, totalSessions: 0, ...JSON.parse(raw) };
    }
    return { bestScore: 0, bestCombo: 0, bestLevel: 1, totalSessions: 0 };
  } catch (e) {
    return { bestScore: 0, bestCombo: 0, bestLevel: 1, totalSessions: 0 };
  }
};

const saveData = (data) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) {}
};

// Layered circle treatment helper matching spec
const drawLayeredCircle = (ctx, cx, cy, r, colorHex) => {
  ctx.save();
  // Ghost outer ring
  ctx.globalAlpha = 0.2;
  ctx.strokeStyle = colorHex;
  ctx.lineWidth = 1.0;
  ctx.beginPath();
  ctx.arc(cx, cy, r + 5, 0, Math.PI * 2);
  ctx.stroke();
  
  // Tactical ring
  ctx.globalAlpha = 0.55;
  ctx.strokeStyle = colorHex;
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  
  // Filled body
  ctx.globalAlpha = 0.88;
  ctx.fillStyle = colorHex;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.82, 0, Math.PI * 2);
  ctx.fill();
  
  // Highlight sheen
  ctx.globalAlpha = 0.3;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(cx - r * 0.2, cy - r * 0.2, r * 0.28, 0, Math.PI * 2);
  ctx.fill();
  
  // Bright center core
  ctx.globalAlpha = 1.0;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(cx, cy, r * 0.18, 0, Math.PI * 2);
  ctx.fill();
  
  ctx.restore();
};

export default function ConflictReflexClient() {
  const searchParams = useSearchParams();
  const challengeId = searchParams ? searchParams.get('challengeId') : null;
  const isChallenge = !!challengeId;
  const totalTime = isChallenge ? 30 : TOTAL_TIME;
  const matchStartAt = useDuelMatchStart(challengeId);
  const duelAutoStartedRef = useRef(false);

  const [isClient, setIsClient] = useState(false);
  const [loading, setLoading] = useState(true);
  const [soundEnabled, setSoundEnabled] = useState(true);

  const [phase, setPhase] = useState('start'); // 'start' | 'countdown' | 'playing' | 'rotate-hint' | 'ended'
  const [countdownValue, setCountdownValue] = useState(3);

  const [bestScore, setBestScore] = useState(0);
  const [bestCombo, setBestCombo] = useState(0);
  const [bestLevel, setBestLevel] = useState(1);

  const [score, setScore] = useState(0);
  const [combo, setCombo] = useState(0);
  const [level, setLevel] = useState(1);
  const [lives, setLives] = useState(MAX_LIVES);
  const [timeRemaining, setTimeRemaining] = useState(totalTime);
  const [dangerLevel, setDangerLevel] = useState(0);

  const [flashes, setFlashes] = useState([]);
  const [shakeCls, setShakeCls] = useState('');
  const [endSummary, setEndSummary] = useState(null);
  const [flashBg, setFlashBg] = useState(null);

  const mountedRef = useRef(false);
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const gameActiveRef = useRef(false);

  const scoreRef = useRef(0);
  const comboRef = useRef(0);
  const bestComboRef = useRef(0);
  const levelRef = useRef(1);
  const bestLevelRunRef = useRef(1);
  const mistakesRef = useRef(0);
  const correctActionsRef = useRef(0);
  const totalActionsRef = useRef(0);
  const timeRemainingRef = useRef(totalTime);
  const livesRef = useRef(MAX_LIVES);

  // Reaction cost and accuracy tracking refs
  const congruentAttemptsRef = useRef(0);
  const congruentCorrectRef = useRef(0);
  const incongruentAttemptsRef = useRef(0);
  const incongruentCorrectRef = useRef(0);
  const congruentReactionTimesRef = useRef([]);
  const incongruentReactionTimesRef = useRef([]);

  const targetAppearedAtRef = useRef(0);
  const lastPointerTimeRef = useRef(0);
  const survivalStartTimeRef = useRef(0);

  // Particle and Ring Burst arrays for screen juice
  const trackingState = useRef({
    lastTime: 0,
    particles: [],
    rings: [],
    targetActive: false,
    
    // Trial parameters
    arrowDirection: 'right', // 'up' | 'down' | 'left' | 'right'
    arrowColor: 'red',       // 'red' | 'blue'
    isCongruent: true,
    
    // Ball positions & colors
    frontX: 0,
    frontY: 0,
    backX: 0,
    backY: 0,
    frontColor: 'red',
    backColor: 'blue',
  });

  const [deviceScale, setDeviceScale] = useState(1.0);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const heartbeatTimerRef = useRef(null);
  const countdownTimerRef = useRef(null);
  const foreperiodTimerRef = useRef(null);
  const gameTimerRef = useRef(null);
  const shakeToggleRef = useRef(0);
  const heartbeatTempoRef = useRef(1000);

  const phaseRef = useRef('start');

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  // responsive ball size
  const getBallRadius = useCallback((W, H) => {
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent || '') || ('ontouchstart' in window);
    const baseSize = isMobile ? Math.min(W, H) * 0.08 : Math.min(W, H) * 0.07;
    return Math.max(22, Math.min(50, baseSize)) * deviceScale;
  }, [deviceScale]);

  // Mount/cleanup
  useEffect(() => {
    setIsClient(true);
    mountedRef.current = true;
    try {
      const saved = getSavedData();
      setBestScore(saved.bestScore);
      setBestCombo(saved.bestCombo);
      setBestLevel(saved.bestLevel);
    } catch (e) {}

    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent || '') || ('ontouchstart' in window);
    setDeviceScale(isMobile ? 0.8 : 1.25);
    setTimeout(() => { if (mountedRef.current) setLoading(false); }, 200);

    const handleFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handleFsChange);

    return () => {
      mountedRef.current = false;
      gameActiveRef.current = false;
      [heartbeatTimerRef, countdownTimerRef, foreperiodTimerRef].forEach((r) => { if (r.current) clearTimeout(r.current); });
      if (gameTimerRef.current) clearInterval(gameTimerRef.current);
      document.removeEventListener('fullscreenchange', handleFsChange);
      try { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); } catch (e) {}
      if (Capacitor.isNativePlatform()) {
        StatusBar.setOverlaysWebView({ overlay: false }).catch(() => {});
        StatusBar.show().catch(() => {});
      }
      unlockOrientation();
    };
  }, []);

  // Screen juice helpers
  const triggerFlash = useCallback((variant) => {
    const id = Date.now() + Math.random();
    setFlashes((f) => [...f, { id, variant }]);
    setTimeout(() => { if (mountedRef.current) setFlashes((f) => f.filter((x) => x.id !== id)); }, 480);
  }, []);

  const triggerShake = useCallback((intensity) => {
    shakeToggleRef.current = shakeToggleRef.current === 0 ? 1 : 0;
    setShakeCls(`fx-shake-${intensity}-${shakeToggleRef.current === 0 ? 'a' : 'b'}`);
  }, []);

  // Difficulty scaling (every 40 points = 1 level up)
  const updateDifficulty = useCallback(() => {
    const newLevel = Math.min(MAX_LEVEL, Math.floor(scoreRef.current / 40) + 1);
    if (newLevel > levelRef.current) {
      levelRef.current = newLevel;
      bestLevelRunRef.current = Math.max(bestLevelRunRef.current, newLevel);
      setLevel(newLevel);
    }
  }, []);

  // Keep track of streaks to avoid 3 congruent or 3 incongruent trials in a row
  const streakTypeRef = useRef(null); // 'congruent' | 'incongruent'
  const streakCountRef = useRef(0);
  const lastDirectionRef = useRef(null);

  // Spawn next trial
  const spawnTarget = useCallback((W, H) => {
    if (!gameActiveRef.current) return;

    // Pick Arrow Direction (avoid repeating immediately)
    const directions = ['up', 'down', 'left', 'right'];
    let dir = directions[Math.floor(Math.random() * directions.length)];
    while (dir === lastDirectionRef.current) {
      dir = directions[Math.floor(Math.random() * directions.length)];
    }
    lastDirectionRef.current = dir;

    // Pick Arrow Color (50/50)
    const color = Math.random() < 0.5 ? 'red' : 'blue';

    // Pick Congruence (50/50, anti-streak guard)
    let congruent = Math.random() < 0.5;
    if (streakTypeRef.current !== null && streakCountRef.current >= 2) {
      congruent = streakTypeRef.current === 'congruent' ? false : true;
    }

    // Update streak state
    const currentTrialType = congruent ? 'congruent' : 'incongruent';
    if (streakTypeRef.current === currentTrialType) {
      streakCountRef.current += 1;
    } else {
      streakTypeRef.current = currentTrialType;
      streakCountRef.current = 1;
    }

    trackingState.current.arrowDirection = dir;
    trackingState.current.arrowColor = color;
    trackingState.current.isCongruent = congruent;

    // Deriving ball colors & placement
    const otherColor = color === 'red' ? 'blue' : 'red';
    let frontColor, backColor;
    if (congruent) {
      frontColor = color;
      backColor = otherColor;
    } else {
      frontColor = otherColor;
      backColor = color;
    }

    trackingState.current.frontColor = frontColor;
    trackingState.current.backColor = backColor;

    // Ball offsets: single W/H min-based offset to prevent aspect-ratio difficulty skew
    const offset = Math.min(W, H) * 0.35;
    const cx = W / 2;
    const cy = H / 2;

    let fx = cx, fy = cy, bx = cx, by = cy;
    if (dir === 'up') {
      fy = cy - offset;
      by = cy + offset;
    } else if (dir === 'down') {
      fy = cy + offset;
      by = cy - offset;
    } else if (dir === 'left') {
      fx = cx - offset;
      bx = cx + offset;
    } else if (dir === 'right') {
      fx = cx + offset;
      bx = cx - offset;
    }

    trackingState.current.frontX = fx;
    trackingState.current.frontY = fy;
    trackingState.current.backX = bx;
    trackingState.current.backY = by;

    trackingState.current.targetActive = false;

    // Random foreperiod before showing stimulus: 150-350ms
    const foreMs = 150 + Math.random() * 200;
    if (foreperiodTimerRef.current) clearTimeout(foreperiodTimerRef.current);
    foreperiodTimerRef.current = setTimeout(() => {
      if (phaseRef.current === 'playing' && gameActiveRef.current) {
        trackingState.current.targetActive = true;
        targetAppearedAtRef.current = Date.now();
      }
    }, foreMs);
  }, []);

  // Scoring resolution
  const resolveCorrect = useCallback((appearedAt, tapX, tapY, hitColor) => {
    if (!gameActiveRef.current) return;
    const reactionMs = appearedAt ? Date.now() - appearedAt : null;
    const comboBefore = comboRef.current;

    // Track congruent vs incongruent stats
    if (trackingState.current.isCongruent) {
      congruentAttemptsRef.current += 1;
      congruentCorrectRef.current += 1;
      if (reactionMs) congruentReactionTimesRef.current.push(reactionMs);
    } else {
      incongruentAttemptsRef.current += 1;
      incongruentCorrectRef.current += 1;
      if (reactionMs) incongruentReactionTimesRef.current.push(reactionMs);
    }

    const pts = scoreAction({
      category: 'cognitive',
      combo: comboBefore,
      reactionMs,
      timeRemaining: timeRemainingRef.current,
      totalGameTime: totalTime,
      livesRemaining: livesRef.current,
      maxLives: MAX_LIVES,
    });
    const total = pts.total;

    scoreRef.current += total;
    comboRef.current = comboBefore + 1;
    bestComboRef.current = Math.max(bestComboRef.current, comboRef.current);
    correctActionsRef.current += 1;
    totalActionsRef.current += 1;

    setFlashBg('green');
    setTimeout(() => setFlashBg(null), 100);

    // Every correct tap plays the same hit sound now — no separate combo
    // chime, and no text popup; the green background flash below is the
    // only correct-tap signal.
    audioSynth?.playHit();

    setScore(scoreRef.current);
    setCombo(comboRef.current);
    updateDifficulty();
    return total;
  }, [updateDifficulty, totalTime]);

  const endGameRef = useRef(null);

  const resolveWrong = useCallback((kind) => {
    if (!gameActiveRef.current) return;

    comboRef.current = 0;
    mistakesRef.current += 1;
    totalActionsRef.current += 1;
    // No score penalty on a mistake — it just breaks your combo. Solo loses a
    // life instead (floored at 0 so negative lives can't corrupt lives-derived
    // math); duels run the full shared 30s with no cost.
    if (!isChallenge) livesRef.current = Math.max(0, livesRef.current - 1);

    // Track congruent vs incongruent wrong attempts
    if (trackingState.current.isCongruent) {
      congruentAttemptsRef.current += 1;
    } else {
      incongruentAttemptsRef.current += 1;
    }

    if (kind === 'wrong_ball' || kind === 'miss_click') {
      triggerShake('hard');
      triggerFlash('red-hard');
      audioSynth?.playPenalty();
    } else {
      // Timeout
      triggerShake('soft');
      triggerFlash('red');
      audioSynth?.playPenalty();
    }

    setFlashBg('red');
    setTimeout(() => setFlashBg(null), 100);

    setScore(scoreRef.current);
    setCombo(0);
    setLives(Math.max(0, livesRef.current));

    if (!isChallenge && livesRef.current <= 0) {
      endGameRef.current?.();
    }
  }, [triggerShake, triggerFlash, isChallenge]);

  // Game over
  const endGame = useCallback(async () => {
    if (!gameActiveRef.current) return;
    gameActiveRef.current = false;

    if (gameTimerRef.current) { clearInterval(gameTimerRef.current); gameTimerRef.current = null; }
    [heartbeatTimerRef, countdownTimerRef, foreperiodTimerRef].forEach((r) => { if (r.current) { clearTimeout(r.current); r.current = null; } });

    audioSynth?.playResultsReveal();
    // StatusBar deliberately not reverted here — the result screen still
    // renders inside the same fullscreen, landscape-locked container as
    // gameplay. Reverting now would force a resize/shake right as results
    // appear; it's restored in the mount-effect cleanup instead, alongside
    // exitFullscreen()/unlockOrientation(), which are already deferred to
    // actually leaving the drill.
    triggerFlash('red-hard');

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

    const prevSaved = getSavedData();
    const isNewBest = finalScore > prevSaved.bestScore;
    const firstPlay = prevSaved.totalSessions === 0;
    const daily = isChallenge
      ? { isDailyDrill: false, wouldCompleteSet: false }
      : await previewDailyCompletion('conflict-reflex');
    const xpResult = calcSessionXP({ finalScore, accuracy, isNewBest, firstPlay, dailyChallenge: daily.isDailyDrill, dailyChallengeSetComplete: daily.wouldCompleteSet });

    const updated = {
      bestScore: Math.max(prevSaved.bestScore, finalScore),
      bestCombo: Math.max(prevSaved.bestCombo, bestComboRef.current),
      bestLevel: Math.max(prevSaved.bestLevel, bestLevelRunRef.current),
      totalSessions: prevSaved.totalSessions + 1,
    };
    saveData(updated);
    setBestScore(updated.bestScore);
    setBestCombo(updated.bestCombo);
    setBestLevel(updated.bestLevel);

    saveLeaderboardEntrySync({
      drillId: 'conflict-reflex',
      drillName: 'Conflict Reflex',
      category: 'cognitive',
      score: finalScore,
      accuracy,
      bestCombo: bestComboRef.current,
    });

    // Calculate Conflict Cost
    const rtsCongruent = congruentReactionTimesRef.current;
    const rtsIncongruent = incongruentReactionTimesRef.current;
    const avgCongruent = rtsCongruent.length > 0 ? rtsCongruent.reduce((a, b) => a + b, 0) / rtsCongruent.length : 0;
    const avgIncongruent = rtsIncongruent.length > 0 ? rtsIncongruent.reduce((a, b) => a + b, 0) / rtsIncongruent.length : 0;
    const conflictCostMs = avgCongruent > 0 && avgIncongruent > 0 ? Math.round(avgIncongruent - avgCongruent) : null;

    const congruentAcc = congruentAttemptsRef.current > 0 ? Math.round((congruentCorrectRef.current / congruentAttemptsRef.current) * 100) : 100;
    const incongruentAcc = incongruentAttemptsRef.current > 0 ? Math.round((incongruentCorrectRef.current / incongruentAttemptsRef.current) * 100) : 100;
    const conflictCostAcc = congruentAcc - incongruentAcc;

    let costDisplay = '0ms';
    if (conflictCostMs !== null) {
      costDisplay = conflictCostMs >= 0 ? `+${conflictCostMs}ms` : `${conflictCostMs}ms`;
    } else if (conflictCostAcc !== 0) {
      costDisplay = `${conflictCostAcc}% Acc`;
    }

    setEndSummary({
      score: finalScore,
      accuracy,
      bestCombo: bestComboRef.current,
      lives: Math.max(0, livesRef.current),
      isNewBest,
      perfectRun: mistakesRef.current === 0 && correct >= 5,
      xpEarned: xpResult.xp,
      conflictCost: costDisplay,
    });
    setPhase('ended');
  }, [triggerFlash]);

  useEffect(() => { endGameRef.current = endGame; }, [endGame]);

  // Main canvas loop
  useEffect(() => {
    if (phase !== 'playing') return;
    const cvs = canvasRef.current;
    if (!cvs) return;
    const ctx = cvs.getContext('2d', { alpha: false });
    if (!ctx) return;

    // Static background (base fill + dot-matrix grid + CRT scanlines)
    // pre-rendered once per resize. Drawing it live cost ~400 tiny fillRect
    // calls EVERY frame for pixels that never change; now it's one
    // drawImage per frame. (The scanlines used to be painted over the game
    // objects; at 1.5% alpha the difference from baking them under is
    // invisible.)
    let bgLayer = null;
    const buildBgLayer = (W, H, dpr) => {
      const bg = document.createElement('canvas');
      bg.width = Math.round(W * dpr);
      bg.height = Math.round(H * dpr);
      const bctx = bg.getContext('2d');
      bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      bctx.fillStyle = '#050508';
      bctx.fillRect(0, 0, W, H);
      bctx.fillStyle = 'rgba(139, 92, 246, 0.04)';
      const dotSpacing = 40;
      for (let gx = dotSpacing; gx < W; gx += dotSpacing) {
        for (let gy = dotSpacing; gy < H; gy += dotSpacing) {
          bctx.fillRect(gx - 0.5, gy - 0.5, 1, 1);
        }
      }
      bctx.fillStyle = 'rgba(255, 255, 255, 0.015)';
      for (let y = 0; y < H; y += 4) {
        bctx.fillRect(0, y, W, 1.5);
      }
      return bg;
    };

    const updateDimensions = () => {
      const ct = containerRef.current;
      if (!ct) return;
      const rect = ct.getBoundingClientRect();
      const dpr = canvasDpr();
      const W = rect.width;
      const H = rect.height;

      const newCanvasW = Math.round(W * dpr);
      const newCanvasH = Math.round(H * dpr);
      if (cvs.width !== newCanvasW || cvs.height !== newCanvasH) {
        cvs.width = newCanvasW;
        cvs.height = newCanvasH;
        cvs.style.width = W + 'px';
        cvs.style.height = H + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        bgLayer = buildBgLayer(W, H, dpr);
      }
    };

    const ro = new ResizeObserver(updateDimensions);
    if (containerRef.current) ro.observe(containerRef.current);
    window.addEventListener('resize', updateDimensions);
    updateDimensions();

    trackingState.current.lastTime = 0;
    let animId = 0;

    const drawLoop = (ts) => {
      if (phaseRef.current !== 'playing') return;
      if (!trackingState.current.lastTime) {
        trackingState.current.lastTime = ts;
      } else if (ts - trackingState.current.lastTime < 15) {
        // ~60fps cap — high-refresh phones fire rAF at 90-120Hz, doubling
        // the draw cost for no visual gain. dt below is real elapsed time,
        // so nothing game-visible changes speed.
        animId = requestAnimationFrame(drawLoop);
        return;
      }
      let dt = (ts - trackingState.current.lastTime) / 1000;
      if (dt > 0.15) dt = 0.016;
      trackingState.current.lastTime = ts;

      const dpr = canvasDpr();
      const W = cvs.width / dpr;
      const H = cvs.height / dpr;

      // Static background — one blit instead of ~400 fillRects per frame.
      if (!bgLayer) bgLayer = buildBgLayer(W, H, dpr);
      ctx.drawImage(bgLayer, 0, 0, W, H);

      // Check reaction deadline if target is active
      if (trackingState.current.targetActive) {
        const elapsedSinceSpawn = Date.now() - targetAppearedAtRef.current;
        const progress = Math.min(1, (totalTime - timeRemainingRef.current) / totalTime);
        
        // 1100ms at start -> ~400ms at end
        const deadlineMs = 1100 - progress * 700;

        if (elapsedSinceSpawn > deadlineMs) {
          resolveWrong('timeout');
          spawnTarget(W, H);
        }
      }

      // Draw Arrow and Balls
      if (trackingState.current.targetActive) {
        const cx = W / 2;
        const cy = H / 2;
        const arrowColor = trackingState.current.arrowColor;
        const arrowColorHex = arrowColor === 'red' ? '#ef4444' : '#3b82f6';

        // 1. Draw Arrow at Center
        ctx.save();
        ctx.translate(cx, cy);

        const rotations = {
          right: 0,
          down: Math.PI / 2,
          left: Math.PI,
          up: -Math.PI / 2
        };
        ctx.rotate(rotations[trackingState.current.arrowDirection]);

        // Soft halo behind the arrow instead of shadowBlur — a real,
        // nonzero shadowBlur is a CPU-bound blur convolution re-run every
        // frame on mobile WebViews; a translucent circle reads the same.
        ctx.fillStyle = arrowColorHex;
        ctx.globalAlpha = 0.14;
        ctx.beginPath();
        ctx.arc(0, 0, 42, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1.0;

        ctx.strokeStyle = arrowColorHex;
        ctx.lineWidth = 1.2;

        ctx.beginPath();
        ctx.moveTo(-25, -9);
        ctx.lineTo(4, -9);
        ctx.lineTo(4, -20);
        ctx.lineTo(28, 0);
        ctx.lineTo(4, 20);
        ctx.lineTo(4, 9);
        ctx.lineTo(-25, 9);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();

        // 2. Draw Balls
        const r = getBallRadius(W, H);
        const frontColorHex = trackingState.current.frontColor === 'red' ? '#ef4444' : '#3b82f6';
        const backColorHex = trackingState.current.backColor === 'red' ? '#ef4444' : '#3b82f6';

        drawLayeredCircle(ctx, trackingState.current.frontX, trackingState.current.frontY, r, frontColorHex);
        drawLayeredCircle(ctx, trackingState.current.backX, trackingState.current.backY, r, backColorHex);
      }

      // (CRT scanlines are baked into bgLayer above.)

      // Draw Hit Ring Bursts
      const rings = trackingState.current.rings;
      if (rings && rings.length > 0) {
        for (let i = rings.length - 1; i >= 0; i--) {
          const ring = rings[i];
          ring.life -= dt;
          if (ring.life <= 0) { rings.splice(i, 1); continue; }
          const progress = 1 - ring.life / ring.maxLife;
          const currentR = ring.startR + (ring.maxR - ring.startR) * progress;
          ctx.save();
          ctx.globalAlpha = (ring.life / ring.maxLife) * 0.75;
          ctx.strokeStyle = ring.color;
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.arc(ring.x, ring.y, currentR, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }
      }

      // Draw Feedback Particles
      const particles = trackingState.current.particles;
      if (particles) {
        ctx.save();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = 'bold 15px monospace';
        
        for (let i = particles.length - 1; i >= 0; i--) {
          const pt = particles[i];
          pt.life -= dt;
          pt.y -= dt * 38;
          
          const alpha = Math.max(0, pt.life / pt.maxLife);
          let rgb = '255, 255, 255';
          if (pt.color === '#ef4444') rgb = '239, 68, 68';
          else if (pt.color === '#4ade80') rgb = '74, 222, 128';
          else if (pt.color === '#3b82f6') rgb = '59, 130, 246';
          
          ctx.fillStyle = `rgba(${rgb}, ${alpha})`;
          ctx.fillText(pt.text, pt.x, pt.y);
          
          if (pt.life <= 0) particles.splice(i, 1);
        }
        ctx.restore();
      }

      animId = requestAnimationFrame(drawLoop);
    };

    animId = requestAnimationFrame(drawLoop);

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener('resize', updateDimensions);
      ro.disconnect();
    };
  }, [phase, getBallRadius, spawnTarget, totalTime]);

  // Handle click/tap events
  const handlePointerDown = (e) => {
    if (phaseRef.current !== 'playing') return;
    
    // 80ms tap debounce
    const now = Date.now();
    if (now - lastPointerTimeRef.current < 80) return;
    lastPointerTimeRef.current = now;

    const cvs = canvasRef.current;
    if (!cvs) return;
    const rect = cvs.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const dpr = canvasDpr();
    const W = cvs.width / dpr;
    const H = cvs.height / dpr;

    // Tap too early or during foreperiod
    if (!trackingState.current.targetActive) {
      trackingState.current.rings.push({ x, y, startR: 10, maxR: 45, life: 0.28, maxLife: 0.28, color: '#ef4444' });
      resolveWrong('miss_click');
      spawnTarget(W, H);
      return;
    }

    const fx = trackingState.current.frontX;
    const fy = trackingState.current.frontY;
    const bx = trackingState.current.backX;
    const by = trackingState.current.backY;
    const r = getBallRadius(W, H);

    const distFront = Math.hypot(x - fx, y - fy);
    const distBack = Math.hypot(x - bx, y - by);

    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent || '') || ('ontouchstart' in window);
    const hitRadius = r * (isMobile ? 2.25 : 1.75);

    const targetColor = trackingState.current.arrowColor;

    if (distFront <= hitRadius) {
      // Tapped front ball
      if (trackingState.current.frontColor === targetColor) {
        const total = resolveCorrect(targetAppearedAtRef.current, fx, fy, targetColor);
        trackingState.current.rings.push({ x: fx, y: fy, startR: r * 0.4, maxR: r * 2.8, life: 0.28, maxLife: 0.28, color: targetColor === 'red' ? '#ef4444' : '#3b82f6' });
        trackingState.current.particles.push({
          x: fx, y: fy, text: `+${total}`, color: '#4ade80', life: 1.0, maxLife: 1.0
        });
      } else {
        resolveWrong('wrong_ball');
        trackingState.current.rings.push({ x: fx, y: fy, startR: r * 0.4, maxR: r * 2.2, life: 0.28, maxLife: 0.28, color: '#ef4444' });
      }
      spawnTarget(W, H);
    } else if (distBack <= hitRadius) {
      // Tapped back ball
      if (trackingState.current.backColor === targetColor) {
        const total = resolveCorrect(targetAppearedAtRef.current, bx, by, targetColor);
        trackingState.current.rings.push({ x: bx, y: by, startR: r * 0.4, maxR: r * 2.8, life: 0.28, maxLife: 0.28, color: targetColor === 'red' ? '#ef4444' : '#3b82f6' });
        trackingState.current.particles.push({
          x: bx, y: by, text: `+${total}`, color: '#4ade80', life: 1.0, maxLife: 1.0
        });
      } else {
        resolveWrong('wrong_ball');
        trackingState.current.rings.push({ x: bx, y: by, startR: r * 0.4, maxR: r * 2.2, life: 0.28, maxLife: 0.28, color: '#ef4444' });
      }
      spawnTarget(W, H);
    } else {
      // Tapped empty space
      trackingState.current.rings.push({ x, y, startR: 10, maxR: 45, life: 0.28, maxLife: 0.28, color: '#ef4444' });
      resolveWrong('miss_click');
      spawnTarget(W, H);
    }
  };

  // Heartbeat / Danger tempo loop for the last 10 seconds
  const scheduleHeartbeat = useCallback(() => {
    // Duels have NO heartbeat audio and NO danger vignette at all — the
    // match must feel and perform exactly like solo play minus the extras.
    if (isChallenge) return;
    if (!gameActiveRef.current) return;
    const dangerFromTime = timeRemainingRef.current <= 10 ? (10 - timeRemainingRef.current) / 10 : 0;
    const danger = dangerFromTime;
    const tempo = Math.round(1100 - danger * 650);
    heartbeatTempoRef.current = tempo;
    if (danger > 0.08) audioSynth?.playHeartbeat(danger);
    if (mountedRef.current) setDangerLevel(danger);
    heartbeatTimerRef.current = setTimeout(scheduleHeartbeat, tempo);
  }, [isChallenge]);

  // Game starts
  const beginPlaying = useCallback(() => {
    setPhase('playing');
    gameActiveRef.current = true;

    // Spawn first target — read layout size straight from the container
    // (already laid out by CSS), not canvasRef.current.width/height. The
    // canvas's own backing-store size is only set by the resize effect
    // below, which is gated on phase==='playing' and therefore hasn't run
    // yet the first time beginPlaying() fires — reading it here would get
    // the browser's default 300x150 canvas size, placing the first target
    // inside that tiny phantom box instead of the real screen.
    const ct = containerRef.current;
    if (ct) {
      const rect = ct.getBoundingClientRect();
      spawnTarget(rect.width, rect.height);
    }

    gameTimerRef.current = setInterval(() => {
      if (!gameActiveRef.current) { clearInterval(gameTimerRef.current); return; }
      timeRemainingRef.current -= 0.2;
      if (timeRemainingRef.current <= 0) {
        timeRemainingRef.current = 0;
        setTimeRemaining(0);
        endGameRef.current?.();
      } else {
        setTimeRemaining(timeRemainingRef.current);
      }
    }, 200);
    scheduleHeartbeat();
  }, [scheduleHeartbeat, spawnTarget]);

  const runCountdown = useCallback((n) => {
    if (countdownTimerRef.current) clearTimeout(countdownTimerRef.current);
    if (n <= 0) {
      setCountdownValue('GO');
      audioSynth?.playGo();
      countdownTimerRef.current = setTimeout(() => beginPlaying(), 350);
      return;
    }
    setCountdownValue(n);
    audioSynth?.playCountdownTick();
    countdownTimerRef.current = setTimeout(() => runCountdown(n - 1), 700);
  }, [beginPlaying]);

  const enterDrill = useCallback(async () => {
    audioSynth?.init();

    gameActiveRef.current = false;
    [heartbeatTimerRef, countdownTimerRef, foreperiodTimerRef].forEach((r) => { if (r.current) { clearTimeout(r.current); r.current = null; } });
    if (gameTimerRef.current) { clearInterval(gameTimerRef.current); gameTimerRef.current = null; }

    // Duels always start both players at level 1 — seeding from each
    // player's own saved best would give the two duelists different pacing.
    const startLevel = isChallenge ? 1 : Math.max(1, Math.min(MAX_LEVEL, Math.round((bestLevel || 1) * 0.75)));

    scoreRef.current = 0;
    comboRef.current = 0;
    bestComboRef.current = 0;
    levelRef.current = startLevel;
    bestLevelRunRef.current = startLevel;
    mistakesRef.current = 0;
    correctActionsRef.current = 0;
    totalActionsRef.current = 0;
    timeRemainingRef.current = totalTime;
    livesRef.current = MAX_LIVES;

    congruentAttemptsRef.current = 0;
    congruentCorrectRef.current = 0;
    incongruentAttemptsRef.current = 0;
    incongruentCorrectRef.current = 0;
    congruentReactionTimesRef.current = [];
    incongruentReactionTimesRef.current = [];

    streakTypeRef.current = null;
    streakCountRef.current = 0;
    lastDirectionRef.current = null;

    setScore(0);
    setCombo(0);
    setLevel(startLevel);
    setLives(MAX_LIVES);
    setTimeRemaining(totalTime);
    setDangerLevel(0);
    setEndSummary(null);
    setFlashes([]);
    setCountdownValue(3);

    trackingState.current.particles = [];
    trackingState.current.rings = [];
    trackingState.current.targetActive = false;

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
      const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent || '') || ('ontouchstart' in window);
      if (isMobile && window.innerHeight > window.innerWidth) {
        setPhase('rotate-hint');
      } else {
        setPhase('countdown');
        runCountdown(isChallenge ? 0 : 3);
      }
    }, 350);
  }, [runCountdown, isChallenge, bestLevel, totalTime]);

  useEffect(() => {
    const onOrientationChange = () => {
      if (phase === 'rotate-hint' && window.innerWidth > window.innerHeight) {
        setPhase('countdown');
        runCountdown(isChallenge ? 0 : 3);
      }
    };
    window.addEventListener('resize', onOrientationChange);
    window.addEventListener('orientationchange', onOrientationChange);
    return () => {
      window.removeEventListener('resize', onOrientationChange);
      window.removeEventListener('orientationchange', onOrientationChange);
    };
  }, [phase, runCountdown, isChallenge]);

  // Duel auto-start: both clients begin at the exact shared matchStartAt
  // wall-clock instant written once by the host (see DrillWrapper).
  useEffect(() => {
    if (!isChallenge || !matchStartAt || phase !== 'start' || duelAutoStartedRef.current) return;
    const delay = Math.max(0, matchStartAt - Date.now());
    const t = setTimeout(() => {
      duelAutoStartedRef.current = true;
      enterDrill();
    }, delay);
    return () => clearTimeout(t);
  }, [isChallenge, matchStartAt, phase, enterDrill]);

  // "Challenge Again" reuses this same route with only ?challengeId= changing —
  // Next.js doesn't remount on a search-param-only navigation, so reset all
  // per-match state when the id changes.
  const prevChallengeIdRef = useRef(challengeId);
  useEffect(() => {
    if (challengeId === prevChallengeIdRef.current) return;
    prevChallengeIdRef.current = challengeId;
    duelAutoStartedRef.current = false;
    gameActiveRef.current = false;
    setPhase('start');
    setScore(0);
    setLives(MAX_LIVES);
    setEndSummary(null);
    setTimeRemaining(totalTime);
    timeRemainingRef.current = totalTime;
  }, [challengeId, totalTime]);

  const shareResult = useCallback(async () => {
    if (!endSummary) return;
    const url = 'https://skilldrills.online/drills/cognitive/attention/conflict-reflex';

    try {
      const grade = getGrade(endSummary.accuracy);
      const canvas = generateShareCard({
        score: endSummary.score,
        bestScore,
        accuracy: endSummary.accuracy,
        bestCombo: endSummary.bestCombo,
        rating: { letter: grade.grade, label: grade.label, emoji: grade.emoji },
        newBest: endSummary.isNewBest,
        drillName: 'Conflict Reflex',
        playerName: getPlayerName(),
      });
      await shareScoreCard(url, canvas);
    } catch (e) {
      const text = `Scored ${endSummary.score} on Conflict Reflex (${endSummary.accuracy}% accuracy, ${endSummary.bestCombo}x combo) — SkillDrills`;
      if (typeof navigator !== 'undefined' && navigator.share) {
        navigator.share({ title: 'Conflict Reflex — SkillDrills', text, url }).catch(() => {});
      } else if (typeof navigator !== 'undefined' && navigator.clipboard) {
        navigator.clipboard.writeText(`${text} ${url}`);
      }
    }
  }, [endSummary, bestScore]);

  if (loading || !isClient) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-[#050508]">
        <div className="text-center">
          <div className="w-14 h-14 border-4 border-violet-500 border-t-transparent rounded-full animate-spin mx-auto mb-4 shadow-[0_0_20px_rgba(139,92,246,0.5)]" />
          <p className="text-slate-500 font-bold tracking-widest uppercase text-[10px] animate-pulse">Initializing Cognitive Matrix...</p>
        </div>
      </div>
    );
  }

  const timePct = Math.max(0, Math.min(100, (timeRemaining / totalTime) * 100));

  return (
    <DrillWrapper
      drillName="Conflict Reflex"
      category="cognitive"
      score={score}
      timeLeft={phase === 'ended' ? 0 : Math.ceil(timeRemaining)}
      soundEnabled={soundEnabled}
      onSoundToggle={() => setSoundEnabled((v) => { audioSynth?.setEnabled(!v); return !v; })}
      backHref="/drills/cognitive"
      minimalChrome
    >
      <div
        ref={containerRef}
        onContextMenu={(e) => { if (gameActiveRef.current) e.preventDefault(); }}
        className={`absolute inset-0 select-none overflow-hidden bg-[#050508] text-white`}
        style={{
          touchAction: gameActiveRef.current ? 'none' : 'auto',
          WebkitTapHighlightColor: 'transparent',
          backgroundColor: flashBg === 'red' ? '#250508' : flashBg === 'green' ? '#052510' : '#050508',
          transition: 'background-color 0.1s ease-out'
        }}
      >
        {/* Vignette effect for final 10 seconds of danger */}
        {phase === 'playing' && dangerLevel > 0.06 && (
          <div className="fx-vignette" style={{ '--v-min': Math.max(0.05, dangerLevel * 0.25), '--v-max': Math.min(0.55, dangerLevel * 0.75), animationDuration: `${heartbeatTempoRef.current}ms` }} />
        )}

        {flashes.map((f) => (
          <div key={f.id} className={`fx-flash ${f.variant === 'red-hard' ? 'fx-flash-red-hard' : 'fx-flash-red'}`} />
        ))}

        {phase === 'rotate-hint' && (
          <div className="absolute inset-0 z-[100] flex flex-col items-center justify-center bg-black/95 text-center p-6">
            <div className="animate-bounce mb-5 text-violet-500"><RotateCcw className="w-12 h-12 mx-auto" /></div>
            <p className="text-sm font-bold text-white">Rotate your phone to play</p>
            <p className="text-xs text-slate-500 mt-1.5 max-w-[220px] mx-auto">Please rotate your device to landscape mode to run the reflex field.</p>
            <button 
              onClick={() => {
                setPhase('countdown');
                runCountdown(3);
              }}
              className="mt-5 px-6 py-2 bg-slate-900 border border-gray-800 text-slate-400 font-mono text-[9px] uppercase tracking-wider rounded-lg transition active:scale-95 cursor-pointer"
            >
              Continue Anyway
            </button>
          </div>
        )}

        {(phase === 'start' || phase === 'countdown' || phase === 'playing') && (
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); setSoundEnabled((v) => { audioSynth?.setEnabled(!v); return !v; }); }}
            className="absolute bottom-5 right-5 z-40 p-2 rounded-full bg-black/60 border border-white/10 text-slate-400 active:scale-90 transition-transform cursor-pointer"
          >
            {soundEnabled ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
          </button>
        )}

        {/* ── START SCREEN ── */}
        {phase === 'start' && !isChallenge && (
          <div className="relative h-full flex items-center justify-center p-5 overflow-y-auto z-40">
            <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(ellipse 420px 260px at 50% 8%, rgba(139,92,246,.15), transparent 70%)' }} />
            <div className="relative w-full max-w-[290px] rounded-[20px] border border-white/5 bg-[#0c0c16]/90 backdrop-blur-lg px-5 pt-5 pb-[18px] text-center shadow-[0_16px_40px_rgba(0,0,0,.5)] my-6">
              <div className="w-11 h-11 mx-auto rounded-[14px] bg-gradient-to-br from-violet-500 to-indigo-600 flex items-center justify-center mb-3 shadow-[0_0_22px_rgba(139,92,246,.35)]">
                <ZapIcon className="w-[22px] h-[22px] text-white" />
              </div>
              <h1 className="text-[17px] font-bold tracking-tight">Conflict Reflex</h1>

              <div className="flex flex-col gap-1.5 text-left mt-3.5">
                <HowToRow icon={<ZapIcon className="w-3.5 h-3.5 text-violet-400 flex-shrink-0" />} node={<>Tap the ball matching the arrow's color</>} />
                <HowToRow icon={<HelpCircle className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" />} node={<>Ignore arrow direction — it points to the wrong ball on incongruent trials</>} />
                <HowToRow icon={<Ban className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />} node={<>5 lives maximum — wrong clicks and timeouts cost 1 life</>} />
              </div>

              <div className="grid grid-cols-3 gap-1.5 mt-4">
                <MiniStat label="Best" value={bestScore} color="text-yellow-400" />
                <MiniStat label="Combo" value={`${bestCombo}x`} color="text-orange-400" />
                <MiniStat label="Level" value={`Lv.${bestLevel}`} color="text-indigo-400" />
              </div>

              <button
                onClick={enterDrill}
                className="w-full mt-4 py-[11px] rounded-[13px] bg-gradient-to-r from-violet-600 to-indigo-600 font-bold text-[12.5px] tracking-wide active:scale-[0.97] transition-transform shadow-[0_0_20px_rgba(139,92,246,.3)] cursor-pointer"
              >
                START
              </button>
            </div>
          </div>
        )}

        {/* ── PLAYING (and COUNTDOWN) ── */}
        {(phase === 'playing' || phase === 'countdown') && (
          <>
            <div className="absolute top-0 left-0 right-0 h-1.5 bg-neutral-950 z-[60] pointer-events-none">
              <div className={`h-full transition-all duration-100 ease-linear ${timeRemaining <= 10 ? 'bg-red-500 animate-pulse' : 'bg-violet-500'}`} style={{ width: `${timePct}%` }} />
            </div>

            <div className="absolute top-5 left-5 z-40 flex flex-col pointer-events-none">
              <span className="text-2xl font-black text-white leading-none tabular-nums">{score}</span>
              <div className="flex items-center gap-2 mt-1.5">
                {isChallenge ? (
                  <span className="text-[10px] font-black text-violet-300 bg-violet-500/15 border border-violet-500/25 px-1.5 py-0.5 rounded">Lv.{level}</span>
                ) : (
                  <span className="flex items-center gap-0.5">
                    {Array.from({ length: MAX_LIVES }).map((_, i) => (
                      <Heart key={i} className={`w-3 h-3 ${i < lives ? 'fill-red-500 text-red-500' : 'text-white/15'}`} />
                    ))}
                  </span>
                )}
              </div>
            </div>

            {/* Timer HUD */}
            <div className="absolute top-5 right-5 z-40 flex flex-col items-end pointer-events-none select-none">
              <span className={`text-3xl font-black font-mono leading-none ${timeRemaining <= 10 ? 'text-red-500 animate-pulse' : 'text-slate-300'}`}>
                {Math.ceil(timeRemaining)}s
              </span>
              <span className="text-[8px] text-slate-500 font-bold uppercase tracking-widest mt-1">Time Left</span>
            </div>

            {/* Main Interactive Canvas */}
            <canvas 
              ref={canvasRef} 
              className="block w-full h-full cursor-crosshair z-30 absolute top-0 left-0" 
              style={{ touchAction: 'none' }}
              onPointerDown={handlePointerDown}
            />
          </>
        )}

        {/* ── COUNTDOWN SCREEN ── */}
        {phase === 'countdown' && !isChallenge && (
          <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/55 backdrop-blur-[2px]">
            <span className="text-[11px] font-black uppercase tracking-[0.2em] text-slate-400">Get Ready</span>
            <div className="relative w-28 h-28 rounded-full border-[3px] border-violet-500/20 flex items-center justify-center">
              <div className="absolute -inset-[3px] rounded-full border-[3px] border-transparent border-t-violet-400 border-r-violet-400 animate-spin" style={{ animationDuration: '0.7s' }} />
              <span key={countdownValue} className="fx-pop-in text-5xl font-black bg-gradient-to-b from-white to-violet-300 bg-clip-text text-transparent">
                {countdownValue > 0 ? countdownValue : 'GO'}
              </span>
            </div>
            <span className="text-[10px] text-slate-500">Suppress your reflex at GO</span>
          </div>
        )}

        {/* ── RESULT SCREEN ── */}
        {phase === 'ended' && endSummary && !isChallenge && (
          <ResultScreen summary={endSummary} onPlayAgain={enterDrill} onShare={shareResult} />
        )}
      </div>
    </DrillWrapper>
  );
}

// ============================================================
// Subcomponents
// ============================================================
function HowToRow({ icon, node }) {
  return (
    <div className="flex items-center gap-2 bg-white/[0.02] border border-white/5 rounded-[10px] px-2.5 py-[7px]">
      {icon}
      <span className="text-[10.5px] text-slate-300 leading-tight">{node}</span>
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

function ResultScreen({ summary, onPlayAgain, onShare }) {
  const grade = getGrade(summary.accuracy);
  const gradeColor = grade.grade === 'S+' || grade.grade === 'S' ? '#fbbf24' : '#a78bfa';

  return (
    <div className="absolute inset-0 z-40 flex" style={{ background: 'rgba(5,5,8,0.97)' }}>
      <div className="w-[36%] flex flex-col items-center justify-center gap-1.5 border-r border-white/5" style={{ background: 'radial-gradient(ellipse 260px 200px at 50% 30%, rgba(139,92,246,.08), transparent 70%)' }}>
        {summary.isNewBest && (
          <span className="text-[9.5px] font-bold text-yellow-400 bg-yellow-500/10 border border-yellow-500/25 px-2.5 py-0.5 rounded-full mb-1">NEW BEST</span>
        )}
        <div className="text-5xl sm:text-6xl font-black leading-none" style={{ color: gradeColor }}>{grade.grade}</div>
        <div className="text-[10px] uppercase tracking-widest text-slate-500">{grade.label}</div>
        <div className="text-3xl sm:text-4xl font-black text-white mt-1 tabular-nums">{summary.score.toLocaleString()}</div>
        <div className="text-[9px] uppercase tracking-widest text-slate-500">Points</div>
      </div>

      <div className="flex-1 flex flex-col justify-center gap-3 px-6 sm:px-8 py-4 min-w-0">
        <div className="grid grid-cols-3 gap-2">
          <ResultStat label="Accuracy" value={`${summary.accuracy}%`} color="text-blue-400" />
          <ResultStat label="Combo" value={`${summary.bestCombo}x`} color="text-orange-400" />
          <ResultStat label="Conflict Cost" value={summary.conflictCost} color="text-violet-400" />
        </div>
        <div className="flex gap-2">
          <button onClick={onPlayAgain} className="flex-1 py-3 rounded-[13px] bg-gradient-to-r from-violet-600 to-indigo-600 text-white font-bold text-xs uppercase tracking-wide cursor-pointer animate-pulse">
            Play Again
          </button>
          <button onClick={onShare} className="w-11 flex-shrink-0 rounded-[13px] bg-white/[0.04] border border-white/10 flex items-center justify-center text-slate-400 hover:text-white cursor-pointer">
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
    <div className="rounded-[11px] border border-white/5 bg-white/[0.03] py-2 px-1 text-center">
      <div className={`text-sm font-black ${color} tabular-nums`}>{value}</div>
      <div className="text-[7.5px] uppercase tracking-wide text-slate-500 font-bold mt-0.5">{label}</div>
    </div>
  );
}
