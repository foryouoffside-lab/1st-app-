'use client';

import React, { useEffect, useState, useRef, useCallback } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  Compass, Volume2, VolumeX,
  RotateCcw, Share2, ArrowLeft, Eye, Zap as ZapIcon, Ban, Heart
} from 'lucide-react';
import { scoreAction, calcEndBonuses, calcSessionXP, getGrade } from '../../../../../lib/scoringEngine';
import { canvasDpr } from '../../../../../lib/canvasFx';
import { saveLeaderboardEntrySync } from '../../../../../lib/leaderboard';
import { lockLandscape, unlockOrientation } from '../../../../../lib/orientation';
import { previewDailyCompletion } from '../../../../../lib/dailyChallenge';
import { getPlayerName } from '../../../../../lib/progressStore';
import { Capacitor } from '@capacitor/core';
import { StatusBar } from '@capacitor/status-bar';
import generateShareCard, { shareScoreCard } from '../../../../../components/ShareScoreCard';
import DrillWrapper from '../../../../../components/DrillWrapper';

type Particle = { x: number; y: number; text: string; color: string; life: number; maxLife: number };
type RingBurst = { x: number; y: number; startR: number; maxR: number; life: number; maxLife: number; color: string };

// ============================================================
// TUNING
// ============================================================
const TOTAL_TIME = 45;
const OVERDRIVE_MS = 5000;
const MAX_LEVEL = 15;
const MAX_LIVES = 5;

// ============================================================
// ZERO-LATENCY AUDIO SYNTHESIZER
// ============================================================
class AudioSynthesizer {
  ctx: AudioContext | null = null;
  enabled = true;
  
  init() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }
  
  tone(freq: number, dur: number, type: OscillatorType = 'sine', vol = 0.15, sweepTo: number | null = null) {
    if (!this.enabled || !this.ctx) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
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

  // 1. Hit sound
  playHit() { this.tone(880, 0.12, 'sine', 0.16, 1760); }

  // 2. Countdown tick sound
  playCountdownTick() { this.tone(440, 0.09, 'sine', 0.12, 440); }

  // 3. "GO" start sound
  playGo() { this.tone(523.25, 0.18, 'triangle', 0.17, 784); }

  // 4. Penalty / Miss sound
  playPenalty() {
    if (!this.enabled || !this.ctx) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
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
  playMiss() { this.playPenalty(); }
  playWrongBoom() { this.playPenalty(); }

  // 5. Heartbeat sound
  playHeartbeat(danger = 0) {
    if (!this.enabled || !this.ctx || danger <= 0) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
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

  chimeVoice(freq: number, startAt: number, dur: number, vol: number, filterFreq = 2600) {
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
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

  // 6. Results reveal sound
  playResultsReveal() {
    if (!this.enabled || !this.ctx) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    try {
      const t0 = this.ctx.currentTime;
      [523.25, 659.25, 783.99].forEach((freq, i) => {
        this.chimeVoice(freq, t0 + i * 0.08, 0.24, 0.13, 3200);
      });
      this.chimeVoice(1046.50, t0 + 0.26, 0.6, 0.16, 4200);
    } catch (e) {}
  }

  setEnabled(status: boolean) { this.enabled = status; }
}

const audioSynth = typeof window !== 'undefined' ? new AudioSynthesizer() : null;

// ============================================================
// LOCAL STORAGE CONSOLIDATED KEY & MIGRATION
// ============================================================
const NEW_STORAGE_KEY = 'skilldrills_visual_tracking_speed_test_v1';

const getSavedData = () => {
  try {
    const raw = localStorage.getItem(NEW_STORAGE_KEY);
    if (raw) {
      return { bestScore: 0, bestCombo: 0, bestLevel: 1, totalSessions: 0, totalOverdrives: 0, ...JSON.parse(raw) };
    }
    
    const legacyScore = localStorage.getItem('skilldrills_slide-dash-acceleration_best');
    const legacyCombo = localStorage.getItem('skilldrills_slide-dash-acceleration_best_combo');
    const legacyLvl = localStorage.getItem('skilldrills_slide-dash-acceleration_best_lvl');
    const legacySessions = localStorage.getItem('skilldrills_slide-dash-acceleration_sessions');
    
    const migrated = {
      bestScore: legacyScore ? parseInt(legacyScore, 10) || 0 : 0,
      bestCombo: legacyCombo ? parseInt(legacyCombo, 10) || 0 : 0,
      bestLevel: legacyLvl ? parseInt(legacyLvl, 10) || 1 : 1,
      totalSessions: legacySessions ? parseInt(legacySessions, 10) || 0 : 0,
      totalOverdrives: 0
    };
    
    if (legacyScore || legacyCombo || legacyLvl || legacySessions) {
      localStorage.setItem(NEW_STORAGE_KEY, JSON.stringify(migrated));
    }
    return migrated;
  } catch (e) {
    return { bestScore: 0, bestCombo: 0, bestLevel: 1, totalSessions: 0, totalOverdrives: 0 };
  }
};

const saveData = (data: any) => {
  try {
    localStorage.setItem(NEW_STORAGE_KEY, JSON.stringify(data));
  } catch (e) {}
};

// ============================================================
// MAIN COMPONENT
// ============================================================
export default function VisualTrackingSpeedTestClient() {
  const searchParams = useSearchParams();
  const challengeId = searchParams ? searchParams.get('challengeId') : null;
  const isChallenge = !!challengeId;

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
  const [timeRemaining, setTimeRemaining] = useState(TOTAL_TIME);
  const [dangerLevel, setDangerLevel] = useState(0);

  const targetColor = '#ef4444';
  const trailEffect = true;
  const scanlinesActive = true;

  const [flashes, setFlashes] = useState<{ id: number; variant: string }[]>([]);
  const [shakeCls, setShakeCls] = useState('');
  const [endSummary, setEndSummary] = useState<any>(null);
  const [flashBg, setFlashBg] = useState<string | null>(null);

  const mountedRef = useRef(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const gameActiveRef = useRef(false);

  const scoreRef = useRef(0);
  const comboRef = useRef(0);
  const bestComboRef = useRef(0);
  const levelRef = useRef(1);
  const bestLevelRunRef = useRef(1);
  const livesRef = useRef(MAX_LIVES);
  const mistakesRef = useRef(0);
  const correctActionsRef = useRef(0);
  const totalActionsRef = useRef(0);
  const overdriveMeterRef = useRef(0);
  const overdriveActiveRef = useRef(false);
  const overdriveCountRef = useRef(0);
  const timeRemainingRef = useRef(TOTAL_TIME);

  const missClicksRef = useRef(0);
  const missedTargetsRef = useRef(0);

  const lastTargetSpawnTimeRef = useRef(0);
  const lastPointerTimeRef = useRef(0);
  const survivalStartTimeRef = useRef(0);
  const reactionTimesRef = useRef<number[]>([]);
  const bestReactionTimeRef = useRef(9999);
  const reacquisitionGraceActiveRef = useRef(false);
  const hasTriggeredDashInterceptRef = useRef(false);
  const shakeToggleRef = useRef(0);
  const heartbeatTempoRef = useRef(1000);

  // Physics engine states
  const trackingState = useRef({
    lastTime: 0,
    particles: [] as Particle[],
    rings: [] as RingBurst[],
    px: 0,
    py: 0,
    currentSpeed: 120,
    dirX: 1,
    dirY: 1,
    isDashing: false,
    timer: 0,
    lifeTimer: 0,
    cruiseLimit: 0,
    dashLimit: 0
  });

  const [deviceScale, setDeviceScale] = useState(1.0);

  const roundTimerRef = useRef<any>(null);
  const gameTimerRef = useRef<any>(null);
  const heartbeatTimerRef = useRef<any>(null);
  const overdriveTimeoutRef = useRef<any>(null);
  const countdownTimerRef = useRef<any>(null);

  const phaseRef = useRef('start');

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  // Radius helper — constant regardless of level (matches the sibling
  // ReactionTimeTestClient.tsx and ConflictReflexClient.js's getBallRadius
  // approach); only one target is ever on screen here, so there's no
  // crowding constraint forcing it smaller at high difficulty.
  const getTargetRadius = useCallback((W: number, H: number) => {
    if (deviceScale < 1) {
      const screenFactor = Math.min(W / 800, H / 450);
      return Math.max(14, Math.round(22 * screenFactor * deviceScale));
    } else {
      const baseRadius = 48;
      if (document.fullscreenElement) {
        return Math.max(20, Math.round(baseRadius));
      } else {
        return Math.max(20, Math.round(baseRadius * (H / 1080)));
      }
    }
  }, [deviceScale]);

  // ── Mount / cleanup ────────────────────────────────────────
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
    setDeviceScale(isMobile ? 0.8 : 1.2);
    setTimeout(() => { if (mountedRef.current) setLoading(false); }, 200);

    return () => {
      mountedRef.current = false;
      gameActiveRef.current = false;
      [roundTimerRef, heartbeatTimerRef, overdriveTimeoutRef, countdownTimerRef].forEach((r) => { if (r.current) clearTimeout(r.current); });
      if (gameTimerRef.current) clearInterval(gameTimerRef.current);
      try { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); } catch (e) {}
      if (Capacitor.isNativePlatform()) {
        StatusBar.setOverlaysWebView({ overlay: false }).catch(() => {});
        StatusBar.show().catch(() => {});
      }
      unlockOrientation();
    };
  }, []);

  // ── Juice helpers ─────────────────────────────────────────────────────────
  const triggerFlash = useCallback((variant: string) => {
    const id = Date.now() + Math.random();
    setFlashes((f) => [...f, { id, variant }]);
    setTimeout(() => { if (mountedRef.current) setFlashes((f) => f.filter((x) => x.id !== id)); }, 480);
  }, []);

  const triggerShake = useCallback((intensity: string) => {
    shakeToggleRef.current = shakeToggleRef.current === 0 ? 1 : 0;
    setShakeCls(`fx-shake-${intensity}-${shakeToggleRef.current === 0 ? 'a' : 'b'}`);
  }, []);

  // ── Difficulty scaling ────────────────────────────────────────────────────
  const updateDifficulty = useCallback(() => {
    const newLevel = Math.min(MAX_LEVEL, Math.floor(scoreRef.current / 40) + 1);
    if (newLevel > levelRef.current) {
      levelRef.current = newLevel;
      bestLevelRunRef.current = Math.max(bestLevelRunRef.current, newLevel);
      setLevel(newLevel);
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

  const fillOverdrive = useCallback((amt: number) => {
    if (overdriveActiveRef.current) return;
    overdriveMeterRef.current = Math.min(100, overdriveMeterRef.current + amt);
    if (overdriveMeterRef.current >= 100) activateOverdrive();
  }, [activateOverdrive]);

  // ── Scoring resolution ────────────────────────────────────────────────────
  const resolveCorrect = useCallback((spawnedAt: number) => {
    if (!gameActiveRef.current) return;
    const reactionMs = spawnedAt ? Date.now() - spawnedAt : null;
    const comboBefore = comboRef.current;
    
    const pts = scoreAction({
      category: 'cognitive',
      combo: comboBefore,
      reactionMs,
      timeRemaining: timeRemainingRef.current,
      totalGameTime: TOTAL_TIME,
      livesRemaining: livesRef.current,
      maxLives: MAX_LIVES,
      level: levelRef.current,
      maxLevel: MAX_LEVEL,
    });
    let total = pts.total;
    if (overdriveActiveRef.current) total = Math.round(total * 1.75);

    scoreRef.current += total;
    comboRef.current = comboBefore + 1;
    bestComboRef.current = Math.max(bestComboRef.current, comboRef.current);
    correctActionsRef.current += 1;
    totalActionsRef.current += 1;

    fillOverdrive(14);

    setFlashBg('green');
    setTimeout(() => setFlashBg(null), 100);

    audioSynth?.playHit();

    if (trackingState.current.isDashing && !hasTriggeredDashInterceptRef.current) {
      hasTriggeredDashInterceptRef.current = true;
    }

    setScore(scoreRef.current);
    setCombo(comboRef.current);
    updateDifficulty();
    return total;
  }, [fillOverdrive, updateDifficulty]);

  const endGameRef = useRef<any>(null);

  const resolveWrong = useCallback((kind: string) => {
    if (!gameActiveRef.current) return;

    comboRef.current = 0;
    mistakesRef.current += 1;
    totalActionsRef.current += 1;
    livesRef.current -= 1;

    if (kind === 'miss_click') {
      missClicksRef.current += 1;
      if (isChallenge) scoreRef.current = Math.max(0, scoreRef.current - 5);
      triggerShake('hard');
      triggerFlash('red-hard');
      audioSynth?.playWrongBoom();
    } else {
      missedTargetsRef.current += 1;
      triggerShake('soft');
      triggerFlash('red');
      audioSynth?.playMiss();
      reacquisitionGraceActiveRef.current = true;
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

  // ── Game over ──────────────────────────────────────────────────────────────
  const endGame = useCallback(async () => {
    if (!gameActiveRef.current) return;
    gameActiveRef.current = false;

    if (gameTimerRef.current) { clearInterval(gameTimerRef.current); gameTimerRef.current = null; }
    audioSynth?.playResultsReveal();
    triggerFlash('red');

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
      : await previewDailyCompletion('visual-tracking-speed-test');
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
      drillId: 'visual-tracking-speed-test',
      drillName: 'Visual Tracking Speed Test',
      category: 'cognitive',
      score: finalScore,
      accuracy,
      bestCombo: bestComboRef.current,
    });

    const times = reactionTimesRef.current;
    const avgRt = times.length > 0 ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : 0;
    const bestRt = bestReactionTimeRef.current === 9999 ? 0 : Math.round(bestReactionTimeRef.current);
    const survivalTime = parseFloat(((performance.now() - survivalStartTimeRef.current) / 1000).toFixed(1));

    setEndSummary({
      score: finalScore,
      accuracy,
      bestCombo: bestComboRef.current,
      isNewBest,
      perfectRun: mistakesRef.current === 0 && correct >= 5,
      xpEarned: xpResult.xp,
      avgReactionTime: avgRt,
      bestReactionTime: bestRt,
      survivalTime,
    });
    setPhase('ended');
  }, [triggerFlash]);

  useEffect(() => { endGameRef.current = endGame; }, [endGame]);

  // ── Render & Cycle Physics ────────────────────────────────────────────────
  useEffect(() => {
    if (phase !== 'playing') return;
    const cvs = canvasRef.current;
    if (!cvs) return;
    const ctx = cvs.getContext('2d', { alpha: false });
    if (!ctx) return;

    const updateDimensions = () => {
      const ct = containerRef.current;
      if (!ct) return;
      const rect = ct.getBoundingClientRect();
      const dpr = canvasDpr();
      cvs.width = rect.width * dpr;
      cvs.height = rect.height * dpr;
      cvs.style.width = rect.width + 'px';
      cvs.style.height = rect.height + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const W = rect.width;
      const H = rect.height;
      
      const p = (levelRef.current - 1) / 14;
      const radius = getTargetRadius(W, H);
      trackingState.current.px = radius + Math.random() * (W - radius * 2);
      trackingState.current.py = radius + Math.random() * (H - radius * 2);
      trackingState.current.currentSpeed = 120 + p * 330;
      trackingState.current.dirX = Math.random() > 0.5 ? 1 : -1;
      trackingState.current.dirY = (Math.random() - 0.5) * 2;
      trackingState.current.isDashing = false;
      trackingState.current.timer = 0;
      trackingState.current.lifeTimer = 0;
      trackingState.current.cruiseLimit = 0;
      trackingState.current.dashLimit = 0;
    };

    const ro = new ResizeObserver(updateDimensions);
    if (containerRef.current) ro.observe(containerRef.current);
    window.addEventListener('resize', updateDimensions);
    updateDimensions();

    trackingState.current.lastTime = 0;
    lastTargetSpawnTimeRef.current = Date.now();

    // Static backdrop (flat fill + dot-matrix grid), rendered once and blitted
    // each frame rather than rebuilt dot by dot. Rebuilt only on resize.
    const backdropCanvas = document.createElement('canvas');
    const backdropCtx = backdropCanvas.getContext('2d', { alpha: false });
    let backdropW = 0;
    let backdropH = 0;

    const ensureBackdrop = (w: number, h: number, dpr: number) => {
      if (!backdropCtx || w <= 0 || h <= 0) return false;
      if (backdropW === w && backdropH === h && backdropCanvas.width > 0) return true;
      backdropW = w;
      backdropH = h;
      backdropCanvas.width = Math.round(w * dpr);
      backdropCanvas.height = Math.round(h * dpr);
      backdropCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      backdropCtx.fillStyle = '#050508';
      backdropCtx.fillRect(0, 0, w, h);
      backdropCtx.fillStyle = 'rgba(139, 92, 246, 0.04)';
      const dotSpacing = 40;
      for (let gx = dotSpacing; gx < w; gx += dotSpacing) {
        for (let gy = dotSpacing; gy < h; gy += dotSpacing) {
          backdropCtx.fillRect(gx - 0.5, gy - 0.5, 1, 1);
        }
      }
      return true;
    };

    let animId = 0;
    // ~60fps cap. This loop was uncapped, so on a 90Hz or 120Hz phone it ran
    // 1.5-2x more frames than the game needs for an identical result — pure
    // heat. Frame-skipping happens BEFORE lastTime is touched, so the physics
    // delta below still measures real elapsed time between drawn frames.
    let lastDrawTs = 0;

    const drawLoop = (ts: number) => {
      if (phaseRef.current !== 'playing') return;
      if (ts - lastDrawTs < 15) { animId = requestAnimationFrame(drawLoop); return; }
      lastDrawTs = ts;
      if (!trackingState.current.lastTime) {
        trackingState.current.lastTime = ts;
      }
      let dt = (ts - trackingState.current.lastTime) / 1000;
      if (dt > 0.15) dt = 0.016; 
      trackingState.current.lastTime = ts;

      const dpr = canvasDpr();
      const W = cvs.width / dpr;
      const H = cvs.height / dpr;
      const currentLevel = levelRef.current;
      const p = (currentLevel - 1) / 14;

      // Background + dot-matrix grid — one blit of a pre-rendered image.
      //
      // This used to rebuild the grid from scratch every frame: a nested loop of
      // one fillRect per dot, which on a landscape phone is 150+ draw calls per
      // frame, ~9,000 a second, for a picture that never changes. Rendered once
      // into an offscreen canvas instead (see ensureBackdrop).
      if (ensureBackdrop(W, H, dpr)) {
        ctx.drawImage(backdropCanvas, 0, 0, W, H);
      } else {
        ctx.fillStyle = '#050508';
        ctx.fillRect(0, 0, W, H);
      }

      const cruiseSpeed = 120 + p * 330;
      const dashSpeed = 700 + p * 1500;
      const radius = getTargetRadius(W, H);

      // Physics State transitions
      trackingState.current.timer += dt * 1000;

      if (!trackingState.current.isDashing) {
        if (!trackingState.current.cruiseLimit) {
          trackingState.current.cruiseLimit = (1600 - p * 900) * (0.7 + Math.random() * 0.6);
        }
        if (trackingState.current.timer > trackingState.current.cruiseLimit) {
          trackingState.current.isDashing = true;
          trackingState.current.currentSpeed = dashSpeed;
          trackingState.current.timer = 0;
          trackingState.current.cruiseLimit = 0;
          trackingState.current.dashLimit = (250 + p * 150) * (0.7 + Math.random() * 0.6);
        }
      } else {
        if (!trackingState.current.dashLimit) {
          trackingState.current.dashLimit = (250 + p * 150) * (0.7 + Math.random() * 0.6);
        }
        if (trackingState.current.timer > trackingState.current.dashLimit) {
          trackingState.current.isDashing = false;
          trackingState.current.currentSpeed = cruiseSpeed;
          trackingState.current.timer = 0;
          trackingState.current.dashLimit = 0;
          trackingState.current.dirY = (Math.random() - 0.5) * 2;
        }
      }

      trackingState.current.px += trackingState.current.currentSpeed * trackingState.current.dirX * dt;
      trackingState.current.py += (trackingState.current.currentSpeed * 0.5) * trackingState.current.dirY * dt;

      // Bounce bounds
      if (trackingState.current.px < radius) {
        trackingState.current.px = radius;
        trackingState.current.dirX = 1;
      } else if (trackingState.current.px > W - radius) {
        trackingState.current.px = W - radius;
        trackingState.current.dirX = -1;
      }
      if (trackingState.current.py < radius) {
        trackingState.current.py = radius;
        trackingState.current.dirY = Math.abs(trackingState.current.dirY);
      } else if (trackingState.current.py > H - radius) {
        trackingState.current.py = H - radius;
        trackingState.current.dirY = -Math.abs(trackingState.current.dirY);
      }

      // Exposure Lifespan limits
      const deadlineSec = (1800 - p * 1400) / 1000;
      let currentLifespanLimit = deadlineSec;
      if (reacquisitionGraceActiveRef.current) {
        currentLifespanLimit += 0.25;
      }

      trackingState.current.lifeTimer += dt;
      if (trackingState.current.lifeTimer > currentLifespanLimit) {
        resolveWrong('missed_target');
        
        trackingState.current.px = radius + Math.random() * (W - radius * 2);
        trackingState.current.py = radius + Math.random() * (H - radius * 2);
        trackingState.current.timer = 0;
        trackingState.current.isDashing = false;
        trackingState.current.lifeTimer = 0;
        trackingState.current.cruiseLimit = 0;
        trackingState.current.dashLimit = 0;
      }

      const cx = trackingState.current.px;
      const cy = trackingState.current.py;

      // Draw target
      const r = radius;
      ctx.save();
      // Ghost outer ring
      ctx.globalAlpha = 0.2;
      ctx.strokeStyle = targetColor;
      ctx.lineWidth = 1.0;
      ctx.beginPath();
      ctx.arc(cx, cy, r + 5, 0, Math.PI * 2);
      ctx.stroke();
      // Tactical ring
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = targetColor;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
      // Filled body
      ctx.globalAlpha = 0.88;
      ctx.fillStyle = targetColor;
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

      // Render Trail Effect
      if (trailEffect) {
        ctx.strokeStyle = `rgba(${parseInt(targetColor.slice(1,3), 16) || 239}, ${parseInt(targetColor.slice(3,5), 16) || 68}, ${parseInt(targetColor.slice(5,7), 16) || 68}, 0.15)`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(cx, cy, radius + 8, 0, Math.PI * 2);
        ctx.stroke();
      }

      // CRT overlay scanlines
      if (scanlinesActive) {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.01)';
        for (let y = 0; y < H; y += 4) {
          ctx.fillRect(0, y, W, 1.5);
        }
      }

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

      // Draw In-Canvas Feedback Particles
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
          let cr = 255, cg = 255, cb = 255;
          if (pt.color.startsWith('#') && pt.color.length === 7) {
            cr = parseInt(pt.color.slice(1, 3), 16);
            cg = parseInt(pt.color.slice(3, 5), 16);
            cb = parseInt(pt.color.slice(5, 7), 16);
          }
          
          ctx.fillStyle = `rgba(${cr}, ${cg}, ${cb}, ${alpha})`;
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
  }, [phase, targetColor, trailEffect, scanlinesActive, getTargetRadius, resolveWrong]);

  // Pointer click handler
  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (phaseRef.current !== 'playing') return;
    
    // 80ms debounce
    const now = Date.now();
    if (now - lastPointerTimeRef.current < 80) return;
    lastPointerTimeRef.current = now;

    const cvs = canvasRef.current;
    if (!cvs) return;
    const rect = cvs.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    
    const cx = trackingState.current.px;
    const cy = trackingState.current.py;
    const dist = Math.hypot(x - cx, y - cy);
    
    const dpr = canvasDpr();
    const W = cvs.width / dpr;
    const H = cvs.height / dpr;
    const radius = getTargetRadius(W, H);

    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent || '') || ('ontouchstart' in window);
    const hitRadius = radius * (isMobile ? 2.25 : 1.75);

    if (dist <= hitRadius) {
      const rt = Date.now() - lastTargetSpawnTimeRef.current;
      if (rt > 0) {
        reactionTimesRef.current.push(rt);
        bestReactionTimeRef.current = Math.min(bestReactionTimeRef.current, rt);
      }
      
      const ptsEarned = resolveCorrect(lastTargetSpawnTimeRef.current);

      trackingState.current.rings.push({ x, y, startR: radius * 0.4, maxR: radius * 2.8, life: 0.28, maxLife: 0.28, color: targetColor });
      trackingState.current.particles.push({
        x, y, text: `+${ptsEarned}`, color: '#4ade80', life: 1.0, maxLife: 1.0
      });

      // Force relocation
      trackingState.current.px = radius + Math.random() * (W - radius * 2);
      trackingState.current.py = radius + Math.random() * (H - radius * 2);
      trackingState.current.timer = 0;
      trackingState.current.isDashing = false;
      trackingState.current.lifeTimer = 0;
      trackingState.current.cruiseLimit = 0;
      trackingState.current.dashLimit = 0;

      lastTargetSpawnTimeRef.current = Date.now();
    } else {
      resolveWrong('miss_click');
    }
  };

  // ── Heartbeat / danger tempo ──────────────────────────────────────────────
  const scheduleHeartbeat = useCallback(() => {
    if (!gameActiveRef.current) return;

    // Check danger from remaining lives (2 or fewer lives left)
    const dangerFromLives = livesRef.current <= 2
      ? (MAX_LIVES - livesRef.current) / MAX_LIVES
      : 0;

    // Check danger from remaining time (10 seconds or fewer left)
    const dangerFromTime = timeRemainingRef.current <= 10 ? (10.0 - timeRemainingRef.current) / 10.0 : 0.0;

    // Use whichever danger source is higher
    const danger = Math.min(1, Math.max(dangerFromLives * 0.7, dangerFromTime));

    const tempo = Math.max(350, Math.round(1100 - danger * 650));
    heartbeatTempoRef.current = tempo;

    if (danger > 0.08) audioSynth?.playHeartbeat(danger);
    if (mountedRef.current) setDangerLevel(danger);

    heartbeatTimerRef.current = setTimeout(scheduleHeartbeat, tempo);
  }, []);

  // ── Start / lifecycle ──────────────────────────────────────────────────────
  const beginPlaying = useCallback(() => {
    gameActiveRef.current = true;
    gameTimerRef.current = setInterval(() => {
      if (!gameActiveRef.current) { clearInterval(gameTimerRef.current); return; }
      timeRemainingRef.current -= 0.1;
      if (timeRemainingRef.current <= 0) {
        timeRemainingRef.current = 0;
        setTimeRemaining(0);
        endGameRef.current?.();
      } else {
        setTimeRemaining(timeRemainingRef.current);
      }
    }, 100);
    scheduleHeartbeat();
  }, [scheduleHeartbeat]);

  const runCountdown = useCallback((n: number) => {
    if (countdownTimerRef.current) clearTimeout(countdownTimerRef.current);
    if (n <= 0) {
      audioSynth?.playGo();
      setPhase('playing');
      beginPlaying();
      return;
    }
    setCountdownValue(n);
    audioSynth?.playCountdownTick();
    countdownTimerRef.current = setTimeout(() => runCountdown(n - 1), 700);
  }, [beginPlaying]);

  const enterDrill = useCallback(async () => {
    audioSynth?.init();

    gameActiveRef.current = false;
    [roundTimerRef, heartbeatTimerRef, overdriveTimeoutRef, countdownTimerRef].forEach((r) => { if (r.current) { clearTimeout(r.current); r.current = null; } });
    if (gameTimerRef.current) { clearInterval(gameTimerRef.current); gameTimerRef.current = null; }

    const startLevel = Math.max(1, Math.min(MAX_LEVEL, Math.round((bestLevel || 1) * 0.65)));

    scoreRef.current = 0;
    comboRef.current = 0;
    bestComboRef.current = 0;
    levelRef.current = startLevel;
    bestLevelRunRef.current = startLevel;
    livesRef.current = MAX_LIVES;
    mistakesRef.current = 0;
    correctActionsRef.current = 0;
    totalActionsRef.current = 0;
    overdriveMeterRef.current = 0;
    overdriveActiveRef.current = false;
    overdriveCountRef.current = 0;
    timeRemainingRef.current = TOTAL_TIME;
    missClicksRef.current = 0;
    missedTargetsRef.current = 0;
    reactionTimesRef.current = [];
    bestReactionTimeRef.current = 9999;
    survivalStartTimeRef.current = performance.now();
    reacquisitionGraceActiveRef.current = false;
    hasTriggeredDashInterceptRef.current = false;

    setScore(0);
    setCombo(0);
    setLevel(startLevel);
    setLives(MAX_LIVES);
    setTimeRemaining(TOTAL_TIME);
    setDangerLevel(0);
    setEndSummary(null);
    setFlashes([]);
    setCountdownValue(3);

    trackingState.current.particles = [];
    trackingState.current.rings = [];

    if (!isChallenge && !document.fullscreenElement && containerRef.current) {
      try { await containerRef.current.requestFullscreen(); } catch (e) {}
    }
    if (Capacitor.isNativePlatform()) {
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
        runCountdown(3);
      }
    }, 350);
  }, [runCountdown, isChallenge, bestLevel]);

  useEffect(() => {
    const onOrientationChange = () => {
      if (phase === 'rotate-hint' && window.innerWidth > window.innerHeight) {
        setPhase('countdown');
        runCountdown(3);
      }
    };
    window.addEventListener('resize', onOrientationChange);
    window.addEventListener('orientationchange', onOrientationChange);
    return () => {
      window.removeEventListener('resize', onOrientationChange);
      window.removeEventListener('orientationchange', onOrientationChange);
    };
  }, [phase, runCountdown]);

  const shareResult = useCallback(async () => {
    if (!endSummary) return;
    const url = 'https://skilldrills.online/drills/cognitive/processing-speed/visual-tracking-speed-test';

    try {
      const grade = getGrade(endSummary.accuracy);
      const canvas = generateShareCard({
        score: endSummary.score,
        bestScore,
        accuracy: endSummary.accuracy,
        bestCombo: endSummary.bestCombo,
        rating: { letter: grade.grade, label: grade.label, emoji: grade.emoji },
        newBest: endSummary.isNewBest,
        drillName: 'Visual Tracking Speed Test',
        playerName: getPlayerName(),
      });
      await shareScoreCard(url, canvas);
    } catch (e) {
      const text = `Scored ${endSummary.score} on Visual Tracking Speed Test (${endSummary.accuracy}% accuracy, ${endSummary.bestCombo}x combo) — SkillDrills`;
      if (typeof navigator !== 'undefined' && navigator.share) {
        navigator.share({ title: 'Visual Tracking Speed Test — SkillDrills', text, url }).catch(() => {});
      } else if (typeof navigator !== 'undefined' && navigator.clipboard) {
        navigator.clipboard.writeText(`${text} ${url}`);
      }
    }
  }, [endSummary, bestScore]);

  if (loading || !isClient) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-[#050508]">
        <div className="text-center">
          <div className="w-14 h-14 border-4 border-amber-500 border-t-transparent rounded-full animate-spin mx-auto mb-4 shadow-[0_0_20px_rgba(245,158,11,0.5)]" />
          <p className="text-slate-500 font-bold tracking-widest uppercase text-[10px] animate-pulse">Loading Ocular Aim Engine...</p>
        </div>
      </div>
    );
  }

  const timePct = Math.max(0, Math.min(100, (timeRemaining / TOTAL_TIME) * 100));

  return (
    <DrillWrapper
      drillName="Visual Tracking Speed Test"
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
        className={`fixed inset-0 w-screen h-screen select-none overflow-hidden bg-[#050508] text-white z-30`}
        style={{
          touchAction: gameActiveRef.current ? 'none' : 'auto',
          WebkitTapHighlightColor: 'transparent',
          backgroundColor: flashBg === 'red' ? '#250508' : flashBg === 'green' ? '#052510' : '#050508',
          transition: 'background-color 0.1s ease-out'
        }}
      >
        {/* Scanlines layer */}
        {scanlinesActive && (
          <div className="absolute inset-0 z-20 pointer-events-none opacity-20" style={{ backgroundImage: 'linear-gradient(rgba(18, 16, 16, 0) 50%, rgba(0, 0, 0, 0.25) 50%), linear-gradient(90deg, rgba(255, 0, 0, 0.06), rgba(0, 255, 0, 0.02), rgba(0, 0, 255, 0.06))', backgroundSize: '100% 4px, 6px 100%' }} />
        )}

        {phase === 'playing' && dangerLevel > 0.06 && (
          <div className="fx-vignette" style={{ '--v-min': Math.max(0.05, dangerLevel * 0.25), '--v-max': Math.min(0.55, dangerLevel * 0.75), animationDuration: `${heartbeatTempoRef.current}ms` }} />
        )}

        {flashes.map((f) => (
          <div key={f.id} className={`fx-flash ${f.variant === 'gold' ? 'fx-flash-gold' : f.variant === 'cyan' ? 'fx-flash-cyan' : 'fx-flash-red'}`} />
        ))}

        {phase === 'rotate-hint' && (
          <div className="absolute inset-0 z-[100] flex flex-col items-center justify-center bg-black/95 text-center p-6">
            <div className="animate-bounce mb-5 text-amber-500"><RotateCcw className="w-12 h-12 mx-auto" /></div>
            <p className="text-sm font-bold text-white">Rotate your phone to play</p>
            <p className="text-xs text-slate-500 mt-1.5 max-w-[220px] mx-auto">Your browser can't rotate this for you — turn your device to landscape.</p>
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

        {(phase === 'countdown' || phase === 'playing') && (
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); setSoundEnabled((v) => { audioSynth?.setEnabled(!v); return !v; }); }}
            className="absolute bottom-5 right-5 z-40 p-2 rounded-full bg-black/60 border border-white/10 text-slate-400 active:scale-90 transition-transform cursor-pointer"
          >
            {soundEnabled ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
          </button>
        )}

        {/* ── START SCREEN ── */}
        {phase === 'start' && (
          <div className="relative h-full flex items-center justify-center p-5 overflow-y-auto z-40">
            <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(ellipse 420px 260px at 50% 8%, rgba(245,158,11,.15), transparent 70%)' }} />
            <div className="relative w-full max-w-[290px] rounded-[20px] border border-white/5 bg-[#0c0c16]/90 backdrop-blur-lg px-5 pt-5 pb-[18px] text-center shadow-[0_16px_40px_rgba(0,0,0,.5)] my-6">
              <div className="w-11 h-11 mx-auto rounded-[14px] bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center mb-3 shadow-[0_0_22px_rgba(245,158,11,.35)]">
                <Compass className="w-[22px] h-[22px] text-white" />
              </div>
              <h1 className="text-[17px] font-bold tracking-tight">Visual Tracking Speed Test</h1>

              <div className="flex flex-col gap-1.5 text-left mt-3.5">
                <HowToRow icon={<Eye className="w-3.5 h-3.5 text-cyan-400 flex-shrink-0" />} node={<>Track the moving target smoothly with your eyes</>} />
                <HowToRow icon={<ZapIcon className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" />} node={<>Click/tap the target as it bounces and speeds up</>} />
                <HowToRow icon={<Ban className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />} node={<>5 lives — miss-clicks and timeouts cost points, combo, and a life</>} />
              </div>

              <div className="grid grid-cols-3 gap-1.5 mt-3.5">
                <MiniStat label="Best" value={bestScore} color="text-yellow-400" />
                <MiniStat label="Combo" value={`${bestCombo}x`} color="text-orange-400" />
                <MiniStat label="Level" value={`Lv.${bestLevel}`} color="text-indigo-400" />
              </div>

              <button
                onClick={enterDrill}
                className="w-full mt-3.5 py-[11px] rounded-[13px] bg-gradient-to-r from-amber-500 to-orange-600 font-bold text-[12.5px] tracking-wide active:scale-[0.97] transition-transform shadow-[0_0_20px_rgba(245,158,11,.3)] cursor-pointer"
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
              <div className={`h-full transition-all duration-100 ease-linear ${timeRemaining <= 10 ? 'bg-red-500 animate-pulse' : 'bg-amber-500'}`} style={{ width: `${timePct}%` }} />
            </div>

            <div className="absolute top-5 left-5 z-40 flex flex-col pointer-events-none">
              <span className="text-2xl font-black text-white leading-none tabular-nums">{score}</span>
              {isChallenge ? (
                <div className="flex items-center gap-2 mt-1.5">
                  <span className="text-[10px] font-black text-amber-300 bg-amber-500/15 border border-amber-500/25 px-1.5 py-0.5 rounded">Lv.{level}</span>
                </div>
              ) : (
                <span className="flex items-center gap-0.5 mt-1.5">
                  {Array.from({ length: MAX_LIVES }).map((_, i) => (
                    <Heart key={i} className={`w-3 h-3 ${i < lives ? 'fill-red-500 text-red-500' : 'text-white/15'}`} />
                  ))}
                </span>
              )}
            </div>

            {/* Timer */}
            <div className="absolute top-5 right-5 z-40 flex flex-col items-end pointer-events-none select-none">
              <span className={`text-3xl font-black font-mono leading-none tabular-nums ${timeRemaining <= 10 ? 'text-red-500 animate-pulse' : 'text-slate-300'}`}>
                {Math.ceil(timeRemaining)}s
              </span>
              <span className="text-[8px] text-slate-500 font-bold uppercase tracking-widest mt-1">Time Left</span>
            </div>

            {/* Canvas screen */}
            <canvas 
              ref={canvasRef} 
              className="block w-full h-full cursor-crosshair z-30 absolute top-0 left-0" 
              style={{ touchAction: 'none' }}
              onPointerDown={handlePointerDown}
            />
          </>
        )}

        {/* ── COUNTDOWN SCREEN ── */}
        {phase === 'countdown' && (
          <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/55 backdrop-blur-[2px]">
            <span className="text-[11px] font-black uppercase tracking-[0.2em] text-slate-400">Get Ready</span>
            <div className="relative w-28 h-28 rounded-full border-[3px] border-amber-500/20 flex items-center justify-center">
              <div className="absolute -inset-[3px] rounded-full border-[3px] border-transparent border-t-amber-400 border-r-amber-400 animate-spin" style={{ animationDuration: '0.7s' }} />
              <span key={countdownValue} className="fx-pop-in text-5xl font-black bg-gradient-to-b from-white to-amber-300 bg-clip-text text-transparent">
                {countdownValue > 0 ? countdownValue : 'GO'}
              </span>
            </div>
            <span className="text-[10px] text-slate-500">Target moves at GO</span>
          </div>
        )}

        {/* ── RESULT SCREEN ── */}
        {phase === 'ended' && endSummary && (
          <ResultScreen summary={endSummary} onPlayAgain={enterDrill} onShare={shareResult} />
        )}
      </div>
    </DrillWrapper>
  );
}

// ============================================================
// Subcomponents
// ============================================================
function HowToRow({ icon, node }: { icon: React.ReactNode; node: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 bg-white/[0.02] border border-white/5 rounded-[10px] px-2.5 py-[7px]">
      {icon}
      <span className="text-[10.5px] text-slate-300 leading-tight">{node}</span>
    </div>
  );
}

function MiniStat({ label, value, color }: { label: string; value: string | number; color: string }) {
  return (
    <div className="rounded-[9px] border border-white/5 bg-white/[0.02] py-1.5 px-1 text-center">
      <div className={`text-[12px] font-bold ${color}`}>{value}</div>
      <div className="text-[7.5px] uppercase tracking-wide text-slate-500 font-bold mt-0.5">{label}</div>
    </div>
  );
}

function ResultScreen({ summary, onPlayAgain, onShare }: { summary: any; onPlayAgain: () => void; onShare: () => void }) {
  const grade = getGrade(summary.accuracy);
  const gradeColor = grade.grade === 'S+' || grade.grade === 'S' ? '#fbbf24' : '#a78bfa';

  return (
    <div className="absolute inset-0 z-40 flex" style={{ background: 'rgba(5,5,8,0.97)' }}>
      <div className="w-[36%] flex flex-col items-center justify-center gap-1.5 border-r border-white/5" style={{ background: 'radial-gradient(ellipse 260px 200px at 50% 30%, rgba(250,204,21,.08), transparent 70%)' }}>
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
          <ResultStat label="XP" value={`+${summary.xpEarned}`} color="text-violet-400" />
        </div>
        <div className="flex gap-2">
          <button onClick={onPlayAgain} className="flex-1 py-3 rounded-[13px] bg-gradient-to-r from-amber-500 to-orange-600 text-white font-bold text-xs uppercase tracking-wide cursor-pointer">
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

function ResultStat({ label, value, color }: { label: string; value: string | number; color: string }) {
  return (
    <div className="rounded-[11px] border border-white/5 bg-white/[0.03] py-2 px-1 text-center">
      <div className={`text-sm font-black ${color} tabular-nums`}>{value}</div>
      <div className="text-[7.5px] uppercase tracking-wide text-slate-500 font-bold mt-0.5">{label}</div>
    </div>
  );
}