'use client';

import React, { useEffect, useState, useRef, useCallback } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  Target, Volume2, VolumeX,
  RotateCcw, Share2, ArrowLeft, Eye, Zap as ZapIcon, Ban, Heart
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
import { canvasDpr } from '../../../../../lib/canvasFx';

// ============================================================
// TUNING CONSTANTS
// ============================================================
const TOTAL_TIME = 45;
const OVERDRIVE_MS = 5000;
const MAX_LEVEL = 15;
const MAX_LIVES = 5;

// ============================================================
// ZERO-LATENCY AUDIO SYNTHESIZER
// ============================================================
class AudioSynthesizer {
  ctx = null;
  enabled = true;
  
  init() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }
  
  tone(freq, dur, type = 'sine', vol = 0.15, sweepTo = null) {
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

  playHit() { this.tone(880, 0.12, 'sine', 0.16, 1760); }

  playCountdownTick() { this.tone(440, 0.09, 'sine', 0.12, 440); }
  playGo() { this.tone(523.25, 0.18, 'triangle', 0.17, 784); }

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

  chimeVoice(freq, startAt, dur, vol, filterFreq = 2600) {
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
  setEnabled(status) { this.enabled = status; }
}

const audioSynth = typeof window !== 'undefined' ? new AudioSynthesizer() : null;

// ============================================================
// CONSOLIDATED STORAGE KEY & MIGRATION
// ============================================================
const NEW_STORAGE_KEY = 'skilldrills_target_lock_v1';

const getSavedData = () => {
  try {
    const raw = localStorage.getItem(NEW_STORAGE_KEY);
    if (raw) {
      return { bestScore: 0, bestCombo: 0, bestLevel: 1, totalSessions: 0, totalOverdrives: 0, ...JSON.parse(raw) };
    }
    
    const legacyScore = localStorage.getItem('skilldrills_neuroswitch_v4');
    const migrated = {
      bestScore: legacyScore ? parseInt(legacyScore, 10) || 0 : 0,
      bestCombo: 0,
      bestLevel: 1,
      totalSessions: legacyScore ? 1 : 0,
      totalOverdrives: 0
    };
    
    if (legacyScore) {
      localStorage.setItem(NEW_STORAGE_KEY, JSON.stringify(migrated));
    }
    return migrated;
  } catch (e) {
    return { bestScore: 0, bestCombo: 0, bestLevel: 1, totalSessions: 0, totalOverdrives: 0 };
  }
};

const saveData = (data) => {
  try {
    localStorage.setItem(NEW_STORAGE_KEY, JSON.stringify(data));
  } catch (e) {}
};

// ============================================================
// MAIN COMPONENT
// ============================================================
export default function EliteNeuroSwitchClient() {
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
  const [lives, setLives] = useState(MAX_LIVES);
  const [timeRemaining, setTimeRemaining] = useState(totalTime);
  const [dangerLevel, setDangerLevel] = useState(0);

  const targetColor = '#ef4444';

  const [flashes, setFlashes] = useState([]);
  const [shakeCls, setShakeCls] = useState('');
  const [endSummary, setEndSummary] = useState(null);
  const [flashBg, setFlashBg] = useState(null);

  const [redPos, setRedPos] = useState({ x: 50, y: 50 });
  const [bluePos, setBluePos] = useState({ x: 20, y: 20 });

  const mountedRef = useRef(false);
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
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
  const timeRemainingRef = useRef(totalTime);

  const pairAppearedAtRef = useRef(0);
  const lastPointerTimeRef = useRef(0);
  const survivalStartTimeRef = useRef(0);
  const reactionTimesRef = useRef([]);
  const bestReactionTimeRef = useRef(9999);

  const redPosRef = useRef({ x: 0, y: 0 });
  const bluePosRef = useRef({ x: 0, y: 0 });

  const trackingState = useRef({
    lastTime: 0,
    particles: [],
    rings: [],
    // Set whenever something moves that the draw loop can't infer on its own
    // (target relocation, a resize). The loop skips drawing entirely when this
    // is false and no rings/particles are alive — see drawLoop.
    sceneDirty: true
  });

  const [isFullscreen, setIsFullscreen] = useState(false);

  const heartbeatTimerRef = useRef(null);
  const overdriveTimeoutRef = useRef(null);
  const countdownTimerRef = useRef(null);
  const mainLoopTimerRef = useRef(null);
  const gameTimerRef = useRef(null);
  const shakeToggleRef = useRef(0);
  const heartbeatTempoRef = useRef(1000);

  const phaseRef = useRef('start');

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  // Matches KineticInterceptClient.js's (Moving Target) own getTargetRadius
  // exactly — that drill's ball size was the reference the rest of the
  // processing-speed ball drills were sized up to match.
  const getTargetRadius = useCallback((W, H) => {
    return Math.max(24, Math.min(46, Math.min(W, H) * 0.075)) - 1;
  }, []);

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

    const handleFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handleFsChange);

    return () => {
      mountedRef.current = false;
      gameActiveRef.current = false;
      [heartbeatTimerRef, overdriveTimeoutRef, countdownTimerRef, mainLoopTimerRef].forEach((r) => { if (r.current) clearTimeout(r.current); });
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


  const triggerFlash = useCallback((variant) => {
    const id = Date.now() + Math.random();
    setFlashes((f) => [...f, { id, variant }]);
    setTimeout(() => { if (mountedRef.current) setFlashes((f) => f.filter((x) => x.id !== id)); }, 480);
  }, []);

  const triggerShake = useCallback((/* intensity */) => {}, []);

  // ── Difficulty scaling ────────────────────────────────────────────────────
  const updateDifficulty = useCallback(() => {
    const newLevel = Math.min(MAX_LEVEL, Math.floor(scoreRef.current / 40) + 1);
    if (newLevel > levelRef.current) {
      levelRef.current = newLevel;
      bestLevelRunRef.current = Math.max(bestLevelRunRef.current, newLevel);
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

  // ── Target Spawning ───────────────────────────────────────────────────────
  const spawnPair = useCallback(() => {
    if (phaseRef.current !== 'playing' || !gameActiveRef.current) return;

    const currentLevel = levelRef.current;
    const p = (currentLevel - 1) / 14;

    const minRedReloc = 25 + p * 15;
    const minRedBlueSep = 30 - p * 22;

    let rx = 50, ry = 50, bx = 20, by = 20;
    let attempts = 0;
    
    const prevRx = redPosRef.current.x;
    const prevRy = redPosRef.current.y;
    const isFirstSpawn = prevRx === 0 && prevRy === 0;

    attempts = 0;
    let bestRx = 50, bestRy = 50;
    let maxDistRed = -1;
    while (attempts < 50) {
      const cx = 10 + Math.random() * 80;
      const cy = 10 + Math.random() * 80;
      if (isFirstSpawn) {
        bestRx = cx;
        bestRy = cy;
        break;
      }
      const dist = Math.hypot(cx - prevRx, cy - prevRy);
      if (dist >= minRedReloc) {
        bestRx = cx;
        bestRy = cy;
        break;
      }
      if (dist > maxDistRed) {
        maxDistRed = dist;
        bestRx = cx;
        bestRy = cy;
      }
      attempts++;
    }
    rx = bestRx;
    ry = bestRy;

    attempts = 0;
    let bestBx = 20, bestBy = 20;
    let maxDistBlue = -1;
    while (attempts < 50) {
      const cx = 10 + Math.random() * 80;
      const cy = 10 + Math.random() * 80;
      const dist = Math.hypot(rx - cx, ry - cy);
      if (dist >= minRedBlueSep) {
        bestBx = cx;
        bestBy = cy;
        break;
      }
      if (dist > maxDistBlue) {
        maxDistBlue = dist;
        bestBx = cx;
        bestBy = cy;
      }
      attempts++;
    }
    bx = bestBx;
    by = bestBy;

    redPosRef.current = { x: rx, y: ry };
    bluePosRef.current = { x: bx, y: by };
    // The targets just moved — the draw loop needs one frame to show it.
    trackingState.current.sceneDirty = true;

    setRedPos({ x: rx, y: ry });
    setBluePos({ x: bx, y: by });

    pairAppearedAtRef.current = Date.now();

    if (mainLoopTimerRef.current) clearTimeout(mainLoopTimerRef.current);
    
    const deadlineMs = 1200 - p * 850;
    mainLoopTimerRef.current = setTimeout(() => {
      if (phaseRef.current === 'playing' && gameActiveRef.current) {
        resolveWrong('missed_target');
        spawnPair();
      }
    }, deadlineMs);
  }, []);

  const endGameRef = useRef(null);

  // ── Scoring resolution ────────────────────────────────────────────────────
  const resolveCorrect = useCallback(() => {
    if (!gameActiveRef.current) return;
    const reactionMs = pairAppearedAtRef.current ? Date.now() - pairAppearedAtRef.current : null;
    const comboBefore = comboRef.current;
    
    const pts = scoreAction({
      category: 'cognitive',
      combo: comboBefore,
      reactionMs,
      timeRemaining: timeRemainingRef.current,
      totalGameTime: totalTime,
      livesRemaining: Math.max(0, livesRef.current),
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

    if (reactionMs) {
      reactionTimesRef.current.push(reactionMs);
      bestReactionTimeRef.current = Math.min(bestReactionTimeRef.current, reactionMs);
    }

    audioSynth?.playHit();

    setScore(scoreRef.current);
    updateDifficulty();
    return total;
  }, [fillOverdrive, updateDifficulty, totalTime]);

  const resolveWrong = useCallback((kind) => {
    if (!gameActiveRef.current) return;

    comboRef.current = 0;
    mistakesRef.current += 1;
    totalActionsRef.current += 1;

    // Arena has no lives (a duel always runs the full clock) — a mistake
    // costs score instead, floored at 0. Solo takes a life as usual.
    if (isChallenge) {
      scoreRef.current = Math.max(0, scoreRef.current - 5);
    } else {
      livesRef.current -= 1;
    }

    setFlashBg('red');
    setTimeout(() => setFlashBg(null), 100);

    if (kind === 'wrong_target') {
      triggerShake('hard');
      triggerFlash('red-hard');
      audioSynth?.playWrongBoom();
    } else if (kind === 'miss_click') {
      triggerShake('hard');
      triggerFlash('red');
      audioSynth?.playWrongBoom();
    } else {
      triggerShake('soft');
      triggerFlash('red');
      audioSynth?.playMiss();
    }

    setScore(scoreRef.current);
    setLives(Math.max(0, livesRef.current));

    if (!isChallenge && livesRef.current <= 0) endGameRef.current?.('lives');
  }, [triggerShake, triggerFlash, isChallenge]);

  // ── Game over ──────────────────────────────────────────────────────────────
  const endGame = useCallback(async (reason) => {
    if (!gameActiveRef.current) return;
    gameActiveRef.current = false;

    [heartbeatTimerRef, overdriveTimeoutRef, mainLoopTimerRef].forEach((r) => { if (r.current) { clearTimeout(r.current); r.current = null; } });
    if (gameTimerRef.current) { clearInterval(gameTimerRef.current); gameTimerRef.current = null; }

    audioSynth?.playResultsReveal();
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

    const prevSaved = getSavedData();
    const isNewBest = finalScore > prevSaved.bestScore;
    const firstPlay = prevSaved.totalSessions === 0;
    const daily = isChallenge
      ? { isDailyDrill: false, wouldCompleteSet: false }
      : await previewDailyCompletion('reaction-time');
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
      drillId: 'reaction-time',
      drillName: 'Target Lock',
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
      lives: Math.max(0, livesRef.current),
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

    // The backdrop (flat fill + dot grid) never changes during a match, but
    // it was being rebuilt from scratch every single frame — one ctx.fillRect
    // per dot, which on a landscape phone is ~130+ draw calls per frame,
    // ~8,000/sec, for a completely static image. Render it once into an
    // offscreen canvas here and blit it with a single drawImage in the loop
    // (same technique already used for Conflict Reflex's background).
    const bgCanvas = document.createElement('canvas');
    const bgCtx = bgCanvas.getContext('2d', { alpha: false });

    const renderBackground = (W, H, dpr) => {
      if (!bgCtx || W <= 0 || H <= 0) return;
      bgCanvas.width = Math.round(W * dpr);
      bgCanvas.height = Math.round(H * dpr);
      bgCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      bgCtx.fillStyle = '#050508';
      bgCtx.fillRect(0, 0, W, H);
      bgCtx.fillStyle = 'rgba(167, 139, 250, 0.04)';
      const dotSpacing = 45;
      for (let gx = dotSpacing; gx < W; gx += dotSpacing) {
        for (let gy = dotSpacing; gy < H; gy += dotSpacing) {
          bgCtx.fillRect(gx - 0.5, gy - 0.5, 1, 1);
        }
      }
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
        renderBackground(W, H, dpr);
        // A resize wipes the canvas — force a redraw even if nothing moved.
        trackingState.current.sceneDirty = true;
      }

      if (redPosRef.current.x === 0 && redPosRef.current.y === 0) {
        redPosRef.current = { x: 50, y: 50 };
        bluePosRef.current = { x: 20, y: 20 };
        spawnPair();
      }
    };

    const ro = new ResizeObserver(updateDimensions);
    if (containerRef.current) ro.observe(containerRef.current);
    window.addEventListener('resize', updateDimensions);
    updateDimensions();

    trackingState.current.lastTime = 0;

    let animId = 0;

    let lastDrawTs = 0;
    const drawLoop = (ts) => {
      if (phaseRef.current !== 'playing') return;
      // ~60fps cap — no point redrawing faster than this on 90-120Hz phones.
      if (ts - lastDrawTs < 32) {
        animId = requestAnimationFrame(drawLoop);
        return;
      }

      // Skip the frame entirely when there is genuinely nothing to redraw.
      // Unlike a scrolling or physics game, this drill's scene is STATIC
      // between rounds: the two targets only move when spawnPair() relocates
      // them, so the loop was re-rendering a pixel-identical frame ~60x/sec
      // while the player sat looking for the red one — which is most of the
      // match. Rings and particles are the only continuously-animating parts,
      // so a frame is only needed when one of those is alive or something
      // explicitly marked the scene dirty.
      //
      // The 500ms floor is a deliberate safety net: if any future code path
      // moves something without setting the dirty flag, the worst case is a
      // half-second of staleness rather than a permanently frozen screen.
      const st = trackingState.current;
      const hasAnimating = (st.rings && st.rings.length > 0) || (st.particles && st.particles.length > 0);
      if (!st.sceneDirty && !hasAnimating && ts - lastDrawTs < 500) {
        animId = requestAnimationFrame(drawLoop);
        return;
      }
      st.sceneDirty = false;
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

      // One blit of the pre-rendered backdrop instead of re-fill + ~130
      // per-dot fillRects every frame (see renderBackground above).
      if (bgCanvas.width > 0) {
        ctx.drawImage(bgCanvas, 0, 0, W, H);
      } else {
        ctx.fillStyle = '#050508';
        ctx.fillRect(0, 0, W, H);
      }

      const radius = getTargetRadius(W, H);

      const rx = (redPosRef.current.x / 100) * W;
      const ry = (redPosRef.current.y / 100) * H;
      const bx = (bluePosRef.current.x / 100) * W;
      const by = (bluePosRef.current.y / 100) * H;

      // RED TARGET RENDER
      {
        ctx.save();
        ctx.globalAlpha = 0.2;
        ctx.strokeStyle = targetColor;
        ctx.lineWidth = 1.0;
        ctx.beginPath();
        ctx.arc(rx, ry, radius + 5, 0, Math.PI * 2);
        ctx.stroke();

        ctx.globalAlpha = 0.55;
        ctx.strokeStyle = targetColor;
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.arc(rx, ry, radius, 0, Math.PI * 2);
        ctx.stroke();

        ctx.globalAlpha = 0.88;
        ctx.fillStyle = targetColor;
        ctx.beginPath();
        ctx.arc(rx, ry, radius * 0.82, 0, Math.PI * 2);
        ctx.fill();

        ctx.globalAlpha = 0.3;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(rx - radius * 0.2, ry - radius * 0.2, radius * 0.28, 0, Math.PI * 2);
        ctx.fill();

        ctx.globalAlpha = 1.0;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(rx, ry, radius * 0.18, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // BLUE DISTRACTOR RENDER
      {
        const blueCol = '#3b82f6';
        ctx.save();
        ctx.globalAlpha = 0.2;
        ctx.strokeStyle = blueCol;
        ctx.lineWidth = 1.0;
        ctx.beginPath();
        ctx.arc(bx, by, radius + 5, 0, Math.PI * 2);
        ctx.stroke();

        ctx.globalAlpha = 0.55;
        ctx.strokeStyle = blueCol;
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.arc(bx, by, radius, 0, Math.PI * 2);
        ctx.stroke();

        ctx.globalAlpha = 0.88;
        ctx.fillStyle = blueCol;
        ctx.beginPath();
        ctx.arc(bx, by, radius * 0.82, 0, Math.PI * 2);
        ctx.fill();

        ctx.globalAlpha = 0.3;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(bx - radius * 0.2, by - radius * 0.2, radius * 0.28, 0, Math.PI * 2);
        ctx.fill();

        ctx.globalAlpha = 1.0;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(bx, by, radius * 0.18, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
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
  }, [phase, targetColor, getTargetRadius, spawnPair]);

  const handlePointerDown = (e) => {
    if (phaseRef.current !== 'playing') return;
    
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

    const rx = (redPosRef.current.x / 100) * W;
    const ry = (redPosRef.current.y / 100) * H;
    const bx = (bluePosRef.current.x / 100) * W;
    const by = (bluePosRef.current.y / 100) * H;

    const radius = getTargetRadius(W, H);
    const hitRadius = radius * 1.3;

    const distToRed = Math.hypot(x - rx, y - ry);
    const distToBlue = Math.hypot(x - bx, y - by);

    if (distToRed <= hitRadius) {
      const total = resolveCorrect();
      trackingState.current.rings.push({ x, y, startR: radius * 0.4, maxR: radius * 2.8, life: 0.28, maxLife: 0.28, color: targetColor });
      trackingState.current.particles.push({
        x, y, text: `+${total}`, color: '#4ade80', life: 1.0, maxLife: 1.0
      });
      spawnPair();
    } else if (distToBlue <= hitRadius) {
      resolveWrong('wrong_target');
      trackingState.current.rings.push({ x, y, startR: radius * 0.4, maxR: radius * 2.8, life: 0.28, maxLife: 0.28, color: '#3b82f6' });
      spawnPair();
    } else {
      resolveWrong('miss_click');
      spawnPair();
    }
  };

  // Danger Heartbeat Schedule
  const scheduleHeartbeat = useCallback(() => {
    // Arena has no lives and de-emphasizes tension cues so both duelists play
    // an identical, distraction-free board — no heartbeat audio or vignette.
    if (isChallenge) return;
    if (!gameActiveRef.current) return;

    // Trigger heartbeat danger from remaining lives (2 or fewer lives left)
    const dangerFromLives = livesRef.current <= 2
      ? (MAX_LIVES - livesRef.current) / MAX_LIVES
      : 0;

    // Trigger heartbeat danger from remaining time (10 seconds or fewer left)
    const dangerFromTime = timeRemainingRef.current <= 10 ? (10.0 - timeRemainingRef.current) / 10.0 : 0.0;

    // High danger value selection
    const danger = Math.min(1, Math.max(dangerFromLives * 0.7, dangerFromTime));

    const tempo = Math.max(350, Math.round(1100 - danger * 650));
    heartbeatTempoRef.current = tempo;

    if (danger > 0.08) audioSynth?.playHeartbeat(danger);
    if (mountedRef.current) setDangerLevel(danger);

    heartbeatTimerRef.current = setTimeout(scheduleHeartbeat, tempo);
  }, [isChallenge]);

  // Lifecycle
  const beginPlaying = useCallback(() => {
    gameActiveRef.current = true;
    gameTimerRef.current = setInterval(() => {
      if (!gameActiveRef.current) { clearInterval(gameTimerRef.current); return; }
      timeRemainingRef.current -= 0.2;
      if (timeRemainingRef.current <= 0) {
        timeRemainingRef.current = 0;
        setTimeRemaining(0);
        endGameRef.current?.('time');
      } else {
        // Only when the DISPLAYED whole second changes — same fix as
        // DualTargetFlowClient/FingerSequencingClient/GridMemorizationClient/
        // TowerOfHanoiClient. The play field here is canvas-driven so this
        // one only re-renders a small HUD tree, but it's free to make consistent.
        setTimeRemaining((prev) => (
          Math.ceil(prev) === Math.ceil(timeRemainingRef.current) ? prev : timeRemainingRef.current
        ));
      }
    }, 200);
    scheduleHeartbeat();
  }, [scheduleHeartbeat]);

  const runCountdown = useCallback((n) => {
    if (countdownTimerRef.current) clearTimeout(countdownTimerRef.current);
    if (n <= 0) {
      if (!isChallenge) audioSynth?.playGo();
      setPhase('playing');
      beginPlaying();
      return;
    }
    setCountdownValue(n);
    if (!isChallenge) audioSynth?.playCountdownTick();
    countdownTimerRef.current = setTimeout(() => runCountdown(n - 1), 700);
  }, [beginPlaying, isChallenge]);

  const enterDrill = useCallback(async () => {
    audioSynth?.init();

    gameActiveRef.current = false;
    [heartbeatTimerRef, overdriveTimeoutRef, countdownTimerRef, mainLoopTimerRef].forEach((r) => { if (r.current) { clearTimeout(r.current); r.current = null; } });
    if (gameTimerRef.current) { clearInterval(gameTimerRef.current); gameTimerRef.current = null; }

    // Duels always start BOTH players at the same, lowest difficulty — no
    // personal-best seeding — so the two scores are comparable and the match
    // is pure skill (ARENA_INTEGRATION.md rule 5 / matchmaking fairness).
    const startLevel = isChallenge
      ? 1
      : Math.max(1, Math.min(MAX_LEVEL, Math.round((bestLevel || 1) * 0.65)));

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
    timeRemainingRef.current = totalTime;
    reactionTimesRef.current = [];
    bestReactionTimeRef.current = 9999;
    survivalStartTimeRef.current = performance.now();

    setScore(0);
    setLives(MAX_LIVES);
    setTimeRemaining(totalTime);
    setDangerLevel(0);
    setEndSummary(null);
    setFlashes([]);
    setCountdownValue(3);

    trackingState.current.particles = [];
    trackingState.current.rings = [];
    redPosRef.current = { x: 0, y: 0 };
    bluePosRef.current = { x: 0, y: 0 };

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
        runCountdown(isChallenge ? 0 : 3);
      }
    }, 350);
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
    gameActiveRef.current = false;
    setPhase('start');
    setScore(0);
    setLives(MAX_LIVES);
    setEndSummary(null);
    setTimeRemaining(totalTime);
    timeRemainingRef.current = totalTime;
  }, [challengeId, totalTime]);

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
    const url = 'https://skilldrills.online/drills/cognitive/processing-speed/reaction-time';
    try {
      const grade = getGrade(endSummary.accuracy);
      const canvas = generateShareCard({
        score: endSummary.score,
        bestScore,
        accuracy: endSummary.accuracy,
        bestCombo: endSummary.bestCombo,
        rating: { letter: grade.grade, label: grade.label, emoji: grade.emoji },
        newBest: endSummary.isNewBest,
        drillName: 'Target Lock',
        playerName: getPlayerName(),
      });
      await shareScoreCard(url, canvas);
    } catch (e) {
      const text = `I scored ${endSummary.score} on Target Lock (${endSummary.accuracy}% accuracy, ${endSummary.bestCombo}x combo) — SkillDrills`;
      if (typeof navigator !== 'undefined' && navigator.share) {
        navigator.share({ title: 'Target Lock — SkillDrills', text, url }).catch(() => {});
      } else if (typeof navigator !== 'undefined' && navigator.clipboard) {
        navigator.clipboard.writeText(`${text} ${url}`);
      }
    }
  }, [endSummary, bestScore]);

  if (loading || !isClient) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-[#050508]">
        <div className="text-center">
          <div className="w-14 h-14 border-4 border-rose-500 border-t-transparent rounded-full animate-spin mx-auto mb-4 shadow-[0_0_20px_rgba(244,63,94,0.5)]" />
          <p className="text-slate-500 font-bold tracking-widest uppercase text-[10px] animate-pulse">Loading Target Lock Engine...</p>
        </div>
      </div>
    );
  }

  const timePct = Math.max(0, Math.min(100, (timeRemaining / totalTime) * 100));

  return (
    <DrillWrapper
      drillName="Target Lock"
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
        className="absolute inset-0 select-none overflow-hidden bg-[#050508] text-white"
        style={{
          touchAction: gameActiveRef.current ? 'none' : 'auto',
          WebkitTapHighlightColor: 'transparent',
          backgroundColor: flashBg === 'red' ? '#250508' : flashBg === 'green' ? '#052510' : '#050508',
          transition: 'background-color 0.1s ease-out'
        }}
      >
        {phase === 'playing' && dangerLevel > 0.06 && (
          <div className="fx-vignette" style={{ '--v-min': Math.max(0.05, dangerLevel * 0.25), '--v-max': Math.min(0.55, dangerLevel * 0.75), animationDuration: `${heartbeatTempoRef.current}ms` }} />
        )}

        {flashes.map((f) => (
          <div key={f.id} className={`fx-flash ${f.variant === 'gold' ? 'fx-flash-gold' : f.variant === 'cyan' ? 'fx-flash-cyan' : 'fx-flash-red'}`} />
        ))}

        {phase === 'rotate-hint' && !isChallenge && (
          <div className="absolute inset-0 z-[100] flex flex-col items-center justify-center bg-black/95 text-center p-6">
            <div className="animate-bounce mb-5 text-rose-500"><RotateCcw className="w-12 h-12 mx-auto" /></div>
            <p className="text-sm font-bold text-white">Rotate your phone to play</p>
            <p className="text-xs text-slate-500 mt-1.5 max-w-[220px] mx-auto">Your browser can't rotate this for you — turn your device to landscape.</p>
            <button 
              onClick={() => {
                setPhase('countdown');
                runCountdown(3);
              }}
              className="mt-5 px-6 py-2 bg-slate-900 border border-gray-800 text-slate-400 text-[9px] uppercase tracking-wider rounded-lg transition active:scale-95 cursor-pointer"
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
        {phase === 'start' && !isChallenge && (
          <div className="relative h-full flex items-center justify-center p-5 overflow-y-auto z-40">
            <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(ellipse 420px 260px at 50% 8%, rgba(244,63,94,.15), transparent 70%)' }} />
            <div className="relative w-full max-w-[290px] rounded-[20px] border border-white/5 bg-[#0c0c16]/90 backdrop-blur-lg px-5 pt-5 pb-[18px] text-center shadow-[0_16px_40px_rgba(0,0,0,.5)] my-6">
              <div className="w-11 h-11 mx-auto rounded-[14px] bg-gradient-to-br from-rose-500 to-red-600 flex items-center justify-center mb-3 shadow-[0_0_22px_rgba(244,63,94,.35)]">
                <Target className="w-[22px] h-[22px] text-white" />
              </div>
              <h1 className="text-[17px] font-bold tracking-tight">Target Lock</h1>

              <div className="flex flex-col gap-1.5 text-left mt-3.5">
                <HowToRow icon={<Eye className="w-3.5 h-3.5 text-rose-400 flex-shrink-0" />} node={<>Tap the RED target immediately when it spawns</>} />
                <HowToRow icon={<Ban className="w-3.5 h-3.5 text-blue-400 flex-shrink-0" />} node={<>Never tap BLUE decoy — costs points <b className="text-white">and a life</b>. 5 lives total</>} />
                <HowToRow icon={<ZapIcon className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" />} node={<>They sit closer together as you level up</>} />
              </div>

              <div className="grid grid-cols-3 gap-1.5 mt-3.5">
                <MiniStat label="Best" value={bestScore} color="text-yellow-400" />
                <MiniStat label="Combo" value={`${bestCombo}x`} color="text-orange-400" />
                <MiniStat label="Level" value={`Lv.${bestLevel}`} color="text-indigo-400" />
              </div>

              <button
                onClick={enterDrill}
                className="w-full mt-3.5 py-[11px] rounded-[13px] bg-gradient-to-r from-rose-500 to-red-600 font-bold text-[12.5px] tracking-wide active:scale-[0.97] transition-transform shadow-[0_0_20px_rgba(244,63,94,.3)] cursor-pointer"
              >
                START
              </button>
            </div>
          </div>
        )}

        {/* ── PLAYING ── */}
        {(phase === 'playing' || phase === 'countdown') && (
          <>
            <div className="absolute top-0 left-0 right-0 h-1.5 bg-neutral-950 z-[60] pointer-events-none">
              {/* scaleX, not width — a width animation forces layout + paint on
                  every clock tick for the whole match; a transform is composited.
                  duration-1000, not 100 — the state driving this only updates
                  once a second (see the throttle above), so a 100ms transition
                  meant the bar snapped quickly then sat frozen for ~900ms
                  instead of gliding the full second, matching DualTargetFlowClient's
                  already-correct 1000ms pairing. */}
              <div
                className={`h-full w-full origin-left transition-transform duration-1000 ease-linear ${timeRemaining <= 10 ? 'bg-red-500 animate-pulse' : 'bg-rose-500'}`}
                style={{ transform: `scaleX(${timePct / 100})` }}
              />
            </div>

            <div className="absolute top-5 left-5 z-40 flex flex-col pointer-events-none">
              <span className="text-2xl font-black text-white leading-none tabular-nums">{score}</span>
              <div className="flex items-center gap-2 mt-1.5">
                {/* No level badge in duels — see the note in ConcentrationGrid. */}
                {!isChallenge && (
                  <span className="flex items-center gap-0.5">
                    {Array.from({ length: MAX_LIVES }).map((_, i) => (
                      <Heart key={i} className={`w-3 h-3 ${i < lives ? 'fill-red-500 text-red-500' : 'text-white/15'}`} />
                    ))}
                  </span>
                )}
              </div>
            </div>

            <div className="absolute top-5 right-5 z-40 flex flex-col items-end pointer-events-none select-none">
              <span className={`text-3xl font-black font-mono leading-none tabular-nums ${timeRemaining <= 10 ? 'text-red-500 animate-pulse' : 'text-slate-300'}`}>
                {Math.ceil(timeRemaining)}s
              </span>
              <span className="text-[8px] text-slate-500 font-bold uppercase tracking-widest mt-1">Time Left</span>
            </div>

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
            <div className="relative w-28 h-28 rounded-full border-[3px] border-rose-500/20 flex items-center justify-center">
              <div className="absolute -inset-[3px] rounded-full border-[3px] border-transparent border-t-rose-400 border-r-rose-400 animate-spin" style={{ animationDuration: '0.7s' }} />
              <span key={countdownValue} className="fx-pop-in text-5xl font-black bg-gradient-to-b from-white to-rose-300 bg-clip-text text-transparent">
                {countdownValue > 0 ? countdownValue : 'GO'}
              </span>
            </div>
            <span className="text-[10px] text-slate-500">Tap RED, ignore BLUE decoy</span>
          </div>
        )}

        {/* ── RESULT SCREEN ── */}
        {phase === 'ended' && endSummary && !isChallenge && (
          <ResultScreen summary={endSummary} maxLives={MAX_LIVES} onPlayAgain={enterDrill} onShare={shareResult} />
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

function ResultScreen({ summary, maxLives, onPlayAgain, onShare }) {
  const grade = getGrade(summary.accuracy);
  const gradeColor = grade.grade === 'S+' || grade.grade === 'S' ? '#fbbf24' : '#f43f5e';

  return (
    <div className="absolute inset-0 z-40 flex animate-in fade-in duration-300" style={{ background: 'rgba(5,5,8,0.97)' }}>
      <div className="w-[36%] flex flex-col items-center justify-center gap-1.5 border-r border-white/5" style={{ background: 'radial-gradient(ellipse 260px 200px at 50% 30%, rgba(244,63,94,.08), transparent 70%)' }}>
        {summary.isNewBest && (
          <span className="text-[9.5px] font-bold text-yellow-400 bg-yellow-500/10 border border-yellow-500/25 px-2.5 py-0.5 rounded-full mb-1">NEW BEST</span>
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
          <ResultStat label="Lives" value={`${summary.lives}/${maxLives}`} color="text-red-400" />
          <ResultStat label="XP" value={`+${summary.xpEarned}`} color="text-violet-400" />
        </div>
        <div className="flex gap-2">
          <button onClick={onPlayAgain} className="flex-1 py-3 rounded-[13px] bg-gradient-to-r from-rose-600 to-red-600 text-white font-bold text-xs uppercase tracking-wide cursor-pointer">
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