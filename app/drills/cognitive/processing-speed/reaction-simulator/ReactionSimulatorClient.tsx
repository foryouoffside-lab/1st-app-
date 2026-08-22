'use client';

import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import {
  Target, Volume2, VolumeX, ArrowLeft,
  RotateCcw, Share2, Eye, Zap as ZapIcon, Heart
} from 'lucide-react';
import { scoreAction, calcEndBonuses, calcSessionXP, getGrade } from '../../../../../lib/scoringEngine';
import { motionDpr, createBackdropCache, createLayeredSpriteCache, drawSprite } from '../../../../../lib/canvasFx';
import { saveLeaderboardEntrySync } from '../../../../../lib/leaderboard';
import { lockLandscape, unlockOrientation } from '../../../../../lib/orientation';
import { previewDailyCompletion } from '../../../../../lib/dailyChallenge';
import { getPlayerName } from '../../../../../lib/progressStore';
import { Capacitor } from '@capacitor/core';
import { StatusBar } from '@capacitor/status-bar';
import generateShareCard, { shareScoreCard } from '../../../../../components/ShareScoreCard';
import DrillWrapper from '../../../../../components/DrillWrapper';

// ============================================================
// TUNING CONSTANTS
// ============================================================
const TOTAL_TIME = 45;
const OVERDRIVE_MS = 5000;
const MAX_LEVEL = 15;
const MAX_LIVES = 5;

const FALL_SPEED_FACTOR_CAP = 1.20;
const SPAWN_INTERVAL_MS_FLOOR = 350;
const MULTI_DROP_CHANCE_CAP = 0.70;
const MICRO_CHANCE_CAP = 0.25;
const SPEED_BURST_CHANCE_CAP = 0.30;

const MICRO_SCORE_MULT = 1.3;
const SPEED_BURST_SCORE_MULT = 1.2;

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
  
  setEnabled(status: boolean) { this.enabled = status; }
}

const audioSynth = typeof window !== 'undefined' ? new AudioSynthesizer() : null;

// ============================================================
// CONSOLIDATED STORAGE KEY & MIGRATION
// ============================================================
const NEW_STORAGE_KEY = 'skilldrills_reaction_simulator_v1';

const getSavedData = () => {
  try {
    const raw = localStorage.getItem(NEW_STORAGE_KEY);
    if (raw) {
      return JSON.parse(raw);
    }
    const legacyBest = localStorage.getItem('skilldrills_reaction-simulator_bestScore') || localStorage.getItem('skilldrills_reaction-simulator_best');
    if (legacyBest) {
      const best = parseInt(legacyBest, 10) || 0;
      const initial = { bestScore: best, bestCombo: 0, bestLevel: 1 };
      localStorage.setItem(NEW_STORAGE_KEY, JSON.stringify(initial));
      return initial;
    }
  } catch (e) {}
  return { bestScore: 0, bestCombo: 0, bestLevel: 1 };
};

const saveBestStats = (score: number, combo: number, level: number) => {
  try {
    const data = getSavedData();
    let updated = false;
    if (score > data.bestScore) { data.bestScore = score; updated = true; }
    if (combo > data.bestCombo) { data.bestCombo = combo; updated = true; }
    if (level > data.bestLevel) { data.bestLevel = level; updated = true; }
    if (updated) {
      localStorage.setItem(NEW_STORAGE_KEY, JSON.stringify(data));
    }
  } catch (e) {}
};

// ============================================================
// TARGET OBJECT DEFINITION
// ============================================================
interface TargetItem {
  id: number;
  dropId: number;
  x: number;
  y: number;
  vy: number;
  isMicro: boolean;
  isSpeedBurst: boolean;
  spawnTime: number;
}

interface Particle {
  id: number;
  x: number;
  y: number;
  text: string;
  color: string;
  life: number;
  maxLife: number;
}

interface RingBurst {
  id: number;
  x: number;
  y: number;
  startR: number;
  maxR: number;
  life: number;
  maxLife: number;
  color: string;
}

interface FakeWarning {
  id: number;
  x: number;
  timer: number;
}

export default function ReactionSimulatorClient() {
  const searchParams = useSearchParams();
  const challengeId = searchParams ? searchParams.get('challengeId') : null;
  const isChallenge = !!challengeId;

  const [phase, setPhase] = useState<'start' | 'countdown' | 'playing' | 'rotate-hint' | 'ended'>('start');
  const [countdownValue, setCountdownValue] = useState(3);
  const [soundEnabled, setSoundEnabled] = useState(true);

  const targetColor = '#ef4444';

  const [bestScore, setBestScore] = useState(0);
  const [bestCombo, setBestCombo] = useState(0);
  const [bestLevel, setBestLevel] = useState(1);
  const [isNewBest, setIsNewBest] = useState(false);

  const [score, setScore] = useState(0);
  const [level, setLevel] = useState(1);
  const [lives, setLives] = useState(MAX_LIVES);
  const [timeRemaining, setTimeRemaining] = useState(TOTAL_TIME);
  const [dangerLevel, setDangerLevel] = useState(0);

  const [flashes, setFlashes] = useState<{ id: number; variant: string }[]>([]);
  const [shakeCls, setShakeCls] = useState('');
  const [flashBg, setFlashBg] = useState<'red' | 'green' | 'none'>('none');

  const [endSummary, setEndSummary] = useState<{
    score: number;
    accuracy: number;
    avgReaction: number;
    bestReaction: number;
    maxCombo: number;
    survivalTime: number;
    grade: { grade: string; label: string; color: string; bg: string; border: string; glow: string };
    level: number;
    xpEarned: number;
  } | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const clockIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const heartbeatTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const countdownTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastPointerTimeRef = useRef<number>(0);
  const mountedRef = useRef(true);
  const isMobileRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    isMobileRef.current = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent || '') || ('ontouchstart' in window);
    return () => {
      mountedRef.current = false;
      if (heartbeatTimeoutRef.current) clearTimeout(heartbeatTimeoutRef.current);
      if (countdownTimerRef.current) clearTimeout(countdownTimerRef.current);
      try { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); } catch (e) {}
      if (Capacitor.isNativePlatform()) {
        StatusBar.setOverlaysWebView({ overlay: false }).catch(() => {});
        StatusBar.show().catch(() => {});
      }
      unlockOrientation();
    };
  }, []);

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
  }, [phase]);

  const phaseRef = useRef(phase);
  const scoreRef = useRef(0);
  const comboRef = useRef(0);
  const maxComboRef = useRef(0);
  const levelRef = useRef(1);
  const livesRef = useRef(MAX_LIVES);
  const timeRemainingRef = useRef(TOTAL_TIME);
  const overdriveMeterRef = useRef(0);
  const overdriveActiveRef = useRef(false);
  const overdriveTimerRef = useRef(0);

  const hitsRef = useRef(0);
  const missesRef = useRef(0);
  const reactionTimesRef = useRef<number[]>([]);
  const bestReactionTimeRef = useRef(9999);
  const survivalStartTimeRef = useRef(0);

  const activeDropsRef = useRef<Record<number, { total: number; hitCount: number; failed: boolean }>>({});
  const dropClearedThisSessionRef = useRef(false);

  const trackingState = useRef({
    lastTime: 0,
    targets: [] as TargetItem[],
    particles: [] as Particle[],
    rings: [] as RingBurst[],
    fakeWarnings: [] as FakeWarning[],
    spawnTimer: 0
  });

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    const data = getSavedData();
    setBestScore(data.bestScore);
    setBestCombo(data.bestCombo);
    setBestLevel(data.bestLevel);
  }, []);

  useEffect(() => {
    audioSynth?.setEnabled(soundEnabled);
  }, [soundEnabled]);

  const getDifficultyParameters = (lvl: number) => {
    const p = Math.max(0, Math.min(1, (lvl - 1) / (MAX_LEVEL - 1)));

    const fallSpeedFactor = 0.22 + p * (FALL_SPEED_FACTOR_CAP - 0.22);
    const spawnIntervalMs = 1500 - p * (1500 - SPAWN_INTERVAL_MS_FLOOR);

    const multiDropChance = p * MULTI_DROP_CHANCE_CAP;
    const microChance = p * MICRO_CHANCE_CAP;
    const speedBurstChance = p * SPEED_BURST_CHANCE_CAP;

    return {
      fallSpeedFactor,
      spawnIntervalMs,
      multiDropChance,
      microChance,
      speedBurstChance
    };
  };

  // Base radius matches KineticInterceptClient.js's (Moving Target) own
  // getTargetRadius — that drill's ball size was the reference the rest of
  // the processing-speed ball drills were sized up to match. Micro targets
  // (the smaller decoy variant) stay a fixed fraction of that.
  const getTargetRadius = (W: number, H: number, isMicro = false) => {
    const base = Math.max(24, Math.min(46, Math.min(W, H) * 0.075)) - 1;
    return isMicro ? Math.round(base * 0.6) : base;
  };

  const triggerShake = (type: 'soft' | 'hard') => {
    setShakeCls(type === 'hard' ? 'shake-hard' : 'shake-soft');
    setTimeout(() => setShakeCls(''), 250);
  };

  const triggerFlash = (variant: 'red' | 'green' | 'gold') => {
    const id = Math.random();
    setFlashes((prev) => [...prev, { id, variant }]);
    setFlashBg(variant === 'red' ? 'red' : variant === 'green' ? 'green' : 'none');
    setTimeout(() => {
      setFlashes((prev) => prev.filter((x) => x.id !== id));
      setFlashBg('none');
    }, 150);
  };

  const resolveCorrect = (reactionMs: number, pos: { x: number; y: number }, target: TargetItem) => {
    hitsRef.current += 1;
    reactionTimesRef.current.push(reactionMs);
    bestReactionTimeRef.current = Math.min(bestReactionTimeRef.current, reactionMs);

    const baseScoreResult = scoreAction({
      category: 'cognitive',
      combo: comboRef.current,
      reactionMs,
      timeRemaining: timeRemainingRef.current,
      totalGameTime: TOTAL_TIME,
      livesRemaining: livesRef.current,
      maxLives: MAX_LIVES,
      level: levelRef.current,
      maxLevel: MAX_LEVEL,
    });

    const variantMult = (target.isMicro ? MICRO_SCORE_MULT : 1.0) * (target.isSpeedBurst ? SPEED_BURST_SCORE_MULT : 1.0);
    let pts = Math.round(baseScoreResult.total * variantMult);

    if (overdriveActiveRef.current) {
      pts = Math.round(pts * 1.75);
    }

    scoreRef.current += pts;
    setScore(scoreRef.current);

    let floatText = `+${pts}`;
    let particleColor = target.isSpeedBurst ? '#f59e0b' : targetColor;
    if (overdriveActiveRef.current) {
      floatText += ' CRIT!';
      particleColor = '#ec4899';
    } else if (reactionMs < 300) {
      floatText += ' FAST!';
    }
    trackingState.current.particles.push({
      id: Math.random(),
      x: pos.x,
      y: pos.y - 10,
      text: floatText,
      color: particleColor,
      life: 1.0,
      maxLife: 1.0
    });

    comboRef.current += 1;
    if (comboRef.current > maxComboRef.current) {
      maxComboRef.current = comboRef.current;
    }

    if (comboRef.current > 0 && comboRef.current % 10 === 0) {
      if (audioSynth) audioSynth.playHit();
    }

    if (!overdriveActiveRef.current) {
      overdriveMeterRef.current = Math.min(100, overdriveMeterRef.current + 14);
      if (overdriveMeterRef.current === 100) {
        overdriveActiveRef.current = true;
        overdriveTimerRef.current = OVERDRIVE_MS;
      }
    }

    const drop = activeDropsRef.current[target.dropId];
    if (drop && !drop.failed) {
      drop.hitCount++;
      if (drop.hitCount === drop.total && drop.total >= 2) {
        if (!dropClearedThisSessionRef.current) {
          dropClearedThisSessionRef.current = true;
        }
      }
    }

    if (audioSynth) audioSynth.playHit();

    const nextLvl = Math.min(MAX_LEVEL, Math.floor(scoreRef.current / 40) + 1);
    if (nextLvl > levelRef.current) {
      levelRef.current = nextLvl;
      setLevel(nextLvl);
    }
  };

  const resolveWrong = (kind: 'miss_click' | 'missed_target') => {
    comboRef.current = 0;
    overdriveMeterRef.current = 0;
    livesRef.current -= 1;

    if (kind === 'miss_click') {
      missesRef.current += 1;
      if (isChallenge) scoreRef.current = Math.max(0, scoreRef.current - 5);
      setScore(scoreRef.current);

      triggerShake('hard');
      triggerFlash('red');
      if (audioSynth) audioSynth.playWrongBoom();
    } else {
      triggerShake('soft');
      triggerFlash('red');
      if (audioSynth) audioSynth.playMiss();
    }

    setLives(Math.max(0, livesRef.current));
    if (!isChallenge && livesRef.current <= 0) {
      endGame();
    }
  };

  // ── Corrected Heartbeat Schedule Loop ──
  const scheduleHeartbeat = useCallback(() => {
    if (!mountedRef.current || phaseRef.current !== 'playing') return;

    const dangerFromLives = livesRef.current <= 2
      ? (MAX_LIVES - livesRef.current) / MAX_LIVES
      : 0;
    const dangerFromTime = timeRemainingRef.current <= 10
      ? (10.0 - timeRemainingRef.current) / 10.0
      : 0.0;

    const danger = Math.min(1, Math.max(dangerFromLives * 0.7, dangerFromTime));
    const tempo = Math.max(350, Math.round(1100 - danger * 650));

    if (danger > 0.08) audioSynth?.playHeartbeat(danger);
    if (mountedRef.current) setDangerLevel(danger);

    heartbeatTimeoutRef.current = setTimeout(scheduleHeartbeat, tempo);
  }, []);

  const beginPlaying = useCallback(() => {
    setPhase('playing');
    phaseRef.current = 'playing';
    
    survivalStartTimeRef.current = performance.now();
    trackingState.current.targets = [];
    trackingState.current.particles = [];
    trackingState.current.rings = [];
    trackingState.current.fakeWarnings = [];
    trackingState.current.spawnTimer = 0;

    clockIntervalRef.current = setInterval(() => {
      timeRemainingRef.current = Math.max(0, timeRemainingRef.current - 0.1);
      setTimeRemaining(timeRemainingRef.current);

      if (overdriveActiveRef.current) {
        overdriveTimerRef.current = Math.max(0, overdriveTimerRef.current - 100);
        if (overdriveTimerRef.current <= 0) {
          overdriveActiveRef.current = false;
          overdriveMeterRef.current = 0;
        }
      }

      if (timeRemainingRef.current <= 0) {
        endGame();
      }
    }, 100);

    scheduleHeartbeat();
  }, [scheduleHeartbeat]);

  const runCountdown = useCallback((n: number) => {
    if (countdownTimerRef.current) clearTimeout(countdownTimerRef.current);
    setCountdownValue(n);
    if (n > 0) {
      if (audioSynth) audioSynth.playCountdownTick();
      countdownTimerRef.current = setTimeout(() => runCountdown(n - 1), 700);
    } else {
      if (audioSynth) audioSynth.playGo();
      beginPlaying();
    }
  }, [beginPlaying]);

  const enterDrill = async () => {
    if (audioSynth) audioSynth.init();

    const startLevel = Math.max(1, Math.min(MAX_LEVEL, Math.round((bestLevel || 1) * 0.65)));

    scoreRef.current = 0;
    comboRef.current = 0;
    levelRef.current = startLevel;
    livesRef.current = MAX_LIVES;
    timeRemainingRef.current = TOTAL_TIME;
    overdriveMeterRef.current = 0;
    overdriveActiveRef.current = false;
    hitsRef.current = 0;
    missesRef.current = 0;
    reactionTimesRef.current = [];
    bestReactionTimeRef.current = 9999;
    activeDropsRef.current = {};
    dropClearedThisSessionRef.current = false;

    setScore(0);
    setLevel(startLevel);
    setLives(MAX_LIVES);
    setTimeRemaining(TOTAL_TIME);
    setIsNewBest(false);

    if (!isChallenge && containerRef.current && !document.fullscreenElement) {
      try {
        await containerRef.current.requestFullscreen();
      } catch (e) {}
    }

    if (Capacitor.isNativePlatform()) {
      StatusBar.setOverlaysWebView({ overlay: true }).catch(() => {});
      StatusBar.hide().catch(() => {});
    }

    try {
      await lockLandscape();
    } catch (e) {}

    setTimeout(() => {
      if (!mountedRef.current) return;
      const isMobile = isMobileRef.current;
      const isPortrait = window.innerHeight > window.innerWidth;
      
      if (isMobile && isPortrait) {
        setPhase('rotate-hint');
      } else {
        setPhase('countdown');
        runCountdown(3);
      }
    }, 350);
  };

  const endGame = async () => {
    if (clockIntervalRef.current) clearInterval(clockIntervalRef.current);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);

    if (audioSynth) audioSynth.playResultsReveal();

    const survivalSec = survivalStartTimeRef.current > 0
      ? parseFloat(((performance.now() - survivalStartTimeRef.current) / 1000).toFixed(1))
      : 0;

    const totalActions = hitsRef.current + missesRef.current;
    const acc = totalActions > 0 ? Math.round((hitsRef.current / totalActions) * 100) : 0;
    const avgReact = reactionTimesRef.current.length > 0
      ? Math.round(reactionTimesRef.current.reduce((a, b) => a + b, 0) / reactionTimesRef.current.length)
      : 0;
    const bestReact = bestReactionTimeRef.current === 9999 ? 0 : Math.round(bestReactionTimeRef.current);

    const bonuses = calcEndBonuses({
      rawScore: scoreRef.current,
      accuracy: acc,
      bestCombo: maxComboRef.current,
      totalActions,
      mistakes: missesRef.current,
      livesRemaining: Math.max(0, livesRef.current),
      maxLives: MAX_LIVES,
      category: 'cognitive'
    });
    const finalScore = bonuses.finalScore;

    const isNew = finalScore > bestScore;
    const daily = isChallenge
      ? { isDailyDrill: false, wouldCompleteSet: false }
      : await previewDailyCompletion('reaction-simulator');
    const xpResult = calcSessionXP({
      finalScore,
      accuracy: acc,
      isNewBest: isNew,
      firstPlay: bestScore === 0,
      dailyChallenge: daily.isDailyDrill,
      dailyChallengeSetComplete: daily.wouldCompleteSet
    });
    const xp = xpResult.xp;

    saveLeaderboardEntrySync({
      drillId: 'reaction-simulator',
      drillName: 'Reaction Simulator',
      category: 'cognitive',
      score: finalScore,
      accuracy: acc,
      bestCombo: maxComboRef.current,
      xpEarned: xp,
      level: levelRef.current
    });

    saveBestStats(finalScore, maxComboRef.current, levelRef.current);

    setEndSummary({
      score: finalScore,
      accuracy: acc,
      avgReaction: avgReact,
      bestReaction: bestReact,
      maxCombo: maxComboRef.current,
      survivalTime: survivalSec,
      grade: getGrade(acc),
      level: levelRef.current,
      xpEarned: xp
    });

    const updatedStats = getSavedData();
    setBestScore(updatedStats.bestScore);
    setBestCombo(updatedStats.bestCombo);
    setBestLevel(updatedStats.bestLevel);
    setIsNewBest(isNew);

    setPhase('ended');
  };

  const shareResult = async () => {
    if (!endSummary) return;
    const url = 'https://skilldrills.online/drills/cognitive/processing-speed/reaction-simulator';
    try {
      const grade = getGrade(endSummary.accuracy);
      const canvas = generateShareCard({
        score: endSummary.score,
        bestScore,
        accuracy: endSummary.accuracy,
        bestCombo: endSummary.maxCombo,
        rating: { letter: grade.grade, label: grade.label, emoji: grade.emoji },
        newBest: isNewBest,
        drillName: 'Reaction Simulator',
        playerName: getPlayerName(),
      });
      await shareScoreCard(url, canvas);
    } catch (e) {
      const txt = `🎮 I scored ${endSummary.score} PTS on Reaction Simulator! Avg reaction: ${endSummary.avgReaction}ms. Play at skilldrills.online! ⚡`;
      if (navigator.share) {
        navigator.share({ title: 'Reaction Simulator', text: txt, url }).catch(() => {});
      } else if (navigator.clipboard) {
        navigator.clipboard.writeText(txt);
        alert('Score card copied to clipboard!');
      }
    }
  };

  useEffect(() => {
    if (phase !== 'playing') return;
    const cvs = canvasRef.current;
    if (!cvs) return;
    const ctx = cvs.getContext('2d', { alpha: false });
    if (!ctx) return;

    const resizeHandler = () => {
      const ct = containerRef.current;
      if (!ct) return;
      const rect = ct.getBoundingClientRect();
      const dpr = motionDpr();
      cvs.width = rect.width * dpr;
      cvs.height = rect.height * dpr;
      cvs.style.width = rect.width + 'px';
      cvs.style.height = rect.height + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const resizeObserver = new ResizeObserver(resizeHandler);
    if (containerRef.current) resizeObserver.observe(containerRef.current);
    window.addEventListener('resize', resizeHandler);
    resizeHandler();

    trackingState.current.lastTime = 0;

    let lastDrawTsRef = 0;

    // Target sprite cache — see the draw pass in mainLoop below.
    const sprites = createLayeredSpriteCache();

    // Static play-field backdrop, rendered once per size instead of per frame.
    const backdrop = createBackdropCache((c: CanvasRenderingContext2D, w: number, h: number) => {
      c.fillStyle = '#05060b';
      c.fillRect(0, 0, w, h);
      c.fillStyle = 'rgba(239, 68, 68, 0.04)';
      for (let gx = 40; gx < w; gx += 40) {
        for (let gy = 40; gy < h; gy += 40) {
          c.fillRect(gx - 0.5, gy - 0.5, 1, 1);
        }
      }
    });

    // Overdrive vignette gradient — depends only on canvas size, not on
    // anything that changes frame to frame, so it's cached and only rebuilt
    // when the canvas is resized instead of allocating a new CanvasGradient
    // every single frame for the whole ~5s overdrive window (which can recur
    // several times a session).
    let overdriveGrad: CanvasGradient | null = null;
    let overdriveGradW = 0;
    let overdriveGradH = 0;
    const ensureOverdriveGrad = (w: number, h: number) => {
      if (overdriveGrad && overdriveGradW === w && overdriveGradH === h) return overdriveGrad;
      overdriveGradW = w;
      overdriveGradH = h;
      overdriveGrad = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.45, w / 2, h / 2, Math.max(w, h) * 0.85);
      overdriveGrad.addColorStop(0, 'rgba(236, 72, 153, 0)');
      overdriveGrad.addColorStop(1, 'rgba(236, 72, 153, 0.12)');
      return overdriveGrad;
    };

    const mainLoop = (timestamp: number) => {
      if (phaseRef.current !== 'playing') return;
      // 60fps cap (14ms, not 32ms). The 32ms value was a ~30fps cap from a
      // blanket CPU pass; wrong here because the targets fall continuously
      // (t.y += t.vy * dt), so halving the frame rate doubled the distance
      // each one jumps between frames and read as stutter. 14, not 16: a real
      // 60Hz frame arrives every ~16.7ms but jitters, and a 16ms threshold
      // would occasionally skip one and drop a frame; 14 passes every 60Hz
      // frame while still halving a 120Hz phone to 60.
      //
      // Frame-skipping happens BEFORE lastTime is touched, so the physics
      // delta below still measures real elapsed time between drawn frames.
      if (timestamp - lastDrawTsRef < 14) {
        rafRef.current = requestAnimationFrame(mainLoop);
        return;
      }
      lastDrawTsRef = timestamp;
      if (!trackingState.current.lastTime) trackingState.current.lastTime = timestamp;
      let dt = (timestamp - trackingState.current.lastTime) / 1000;
      if (dt > 0.15) dt = 0.016;
      trackingState.current.lastTime = timestamp;

      const dpr = motionDpr();
      const W = cvs.width / dpr;
      const H = cvs.height / dpr;

      const currentLevel = levelRef.current;
      const diffParams = getDifficultyParameters(currentLevel);

      const baseRadius = getTargetRadius(W, H);
      const microRadius = getTargetRadius(W, H, true);

      // Backdrop blitted from cache — this was a nested loop laying down one
      // fillRect per dot every frame (150+ draw calls a frame, ~9,000 a second)
      // to reproduce an image that never changes.
      if (backdrop.ensure(W, H, dpr)) {
        ctx.drawImage(backdrop.canvas, 0, 0, W, H);
      } else {
        ctx.fillStyle = '#05060b';
        ctx.fillRect(0, 0, W, H);
      }

      const targets = trackingState.current.targets;
      for (let i = targets.length - 1; i >= 0; i--) {
        const t = targets[i];
        t.y += t.vy * dt;

        const visualRad = t.isMicro ? microRadius : baseRadius;
        if (t.y >= H + visualRad + 5) {
          const drop = activeDropsRef.current[t.dropId];
          if (drop) drop.failed = true;

          targets.splice(i, 1);
          resolveWrong('missed_target');
        }
      }

      const warnings = trackingState.current.fakeWarnings;
      for (let i = warnings.length - 1; i >= 0; i--) {
        warnings[i].timer -= dt;
        if (warnings[i].timer <= 0) {
          warnings.splice(i, 1);
        }
      }

      trackingState.current.spawnTimer += dt * 1000;
      if (trackingState.current.spawnTimer >= diffParams.spawnIntervalMs) {
        trackingState.current.spawnTimer = 0;

        let dropCount = 1;
        const dropRoll = Math.random();
        if (dropRoll < diffParams.multiDropChance) {
          dropCount = dropRoll < diffParams.multiDropChance * 0.4 ? 3 : 2;
        }

        const dropId = Math.random();
        activeDropsRef.current[dropId] = { total: dropCount, hitCount: 0, failed: false };

        const edgeMargin = 50;
        const spawnedXs: number[] = [];

        for (let d = 0; d < dropCount; d++) {
          let targetX = 0;
          let attempts = 0;
          const minXDist = W * 0.12;

          do {
            targetX = edgeMargin + Math.random() * (W - edgeMargin * 2);
            attempts++;
          } while (
            attempts < 10 && 
            spawnedXs.some((x) => Math.abs(x - targetX) < minXDist)
          );

          spawnedXs.push(targetX);

          const isMicro = Math.random() < diffParams.microChance;
          const isSpeedBurst = Math.random() < diffParams.speedBurstChance;

          const baseSpeed = H * diffParams.fallSpeedFactor;
          const speedMod = (0.85 + Math.random() * 0.3) * (isSpeedBurst ? 1.25 : 1.0);
          const vy = baseSpeed * speedMod;

          targets.push({
            id: Math.random(),
            dropId,
            x: targetX,
            y: -30,
            vy,
            isMicro,
            isSpeedBurst,
            spawnTime: performance.now()
          });
        }

        if (Math.random() < 0.10) {
          warnings.push({
            id: Math.random(),
            x: 50 + Math.random() * (W - 100),
            timer: 0.6
          });
        }
      }

      // One drawImage per falling target instead of five arc() paths each.
      // Only two radii and two colours are ever in play, so the cache is fully
      // populated within the first frame and never grows after that.
      for (const t of targets) {
        const visualRad = t.isMicro ? microRadius : baseRadius;
        const col = t.isSpeedBurst ? '#f59e0b' : targetColor;

        drawSprite(ctx, sprites.get(col, visualRad, dpr), t.x, t.y);

        if (t.isSpeedBurst) {
          ctx.save();
          ctx.globalAlpha = 0.6;
          ctx.strokeStyle = '#f59e0b';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(t.x, t.y, visualRad + 9, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }
      }

      for (const w of warnings) {
        ctx.fillStyle = 'rgba(239, 68, 68, 0.8)';
        ctx.strokeStyle = '#ef4444';
        ctx.lineWidth = 1.5;

        ctx.strokeRect(w.x - 15, 10, 30, 20);
        ctx.font = 'bold 12px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('!', w.x, 20);

        if (Math.floor(w.timer * 10) % 2 === 0) {
          ctx.beginPath();
          ctx.moveTo(w.x - 8, 35);
          ctx.lineTo(w.x, 43);
          ctx.lineTo(w.x + 8, 35);
          ctx.stroke();
        }
      }

      if (overdriveActiveRef.current) {
        ctx.save();
        ctx.fillStyle = ensureOverdriveGrad(W, H);
        ctx.fillRect(0, 0, W, H);
        ctx.restore();
      }

      const rings = trackingState.current.rings;
      for (let i = rings.length - 1; i >= 0; i--) {
        const ring = rings[i];
        ring.life -= dt;
        if (ring.life <= 0) {
          rings.splice(i, 1);
          continue;
        }
        const prog = 1.0 - ring.life / ring.maxLife;
        const currentR = ring.startR + (ring.maxR - ring.startR) * prog;
        ctx.save();
        ctx.globalAlpha = (ring.life / ring.maxLife) * 0.75;
        ctx.strokeStyle = ring.color;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(ring.x, ring.y, currentR, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }

      const particles = trackingState.current.particles;
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.life -= dt;
        p.y -= dt * 38;
        if (p.life <= 0) {
          particles.splice(i, 1);
          continue;
        }
        const alpha = Math.max(0, p.life / p.maxLife);
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = p.color;
        ctx.font = 'bold 15px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(p.text, p.x, p.y);
        ctx.restore();
      }

      rafRef.current = requestAnimationFrame(mainLoop);
    };

    rafRef.current = requestAnimationFrame(mainLoop);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      window.removeEventListener('resize', resizeHandler);
      resizeObserver.disconnect();
    };
  }, [phase, targetColor]);

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (phaseRef.current !== 'playing') return;
    const now = Date.now();
    if (now - lastPointerTimeRef.current < 80) return;
    lastPointerTimeRef.current = now;

    const cvs = canvasRef.current;
    if (!cvs) return;
    const rect = cvs.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    let hitAny = false;
    const targets = trackingState.current.targets;

    for (let i = targets.length - 1; i >= 0; i--) {
      const t = targets[i];
      const radius = getTargetRadius(rect.width, rect.height, t.isMicro);

      const dx = x - t.x;
      const dy = y - t.y;
      const dist = Math.hypot(dx, dy);

      const hitRadius = radius * (isMobileRef.current ? 1.9 : 1.5);

      if (dist <= hitRadius) {
        hitAny = true;
        
        trackingState.current.rings.push({
          id: Math.random(),
          x: t.x,
          y: t.y,
          startR: radius * 0.4,
          maxR: radius * 2.8,
          life: 0.28,
          maxLife: 0.28,
          color: t.isSpeedBurst ? '#f59e0b' : targetColor
        });

        const reactionMs = Math.round(performance.now() - t.spawnTime);
        resolveCorrect(reactionMs, { x: t.x, y: t.y }, t);
        targets.splice(i, 1);
        break;
      }
    }

    if (!hitAny) {
      resolveWrong('miss_click');
    }
  };

  useEffect(() => {
    return () => {
      if (clockIntervalRef.current) clearInterval(clockIntervalRef.current);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  return (
    <DrillWrapper
      drillName="Reaction Simulator"
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
        className={`absolute inset-0 select-none overflow-hidden bg-[#050508] text-white`}
        style={{
          touchAction: 'none',
          WebkitTapHighlightColor: 'transparent',
          backgroundColor: flashBg === 'red' ? '#250508' : flashBg === 'green' ? '#052510' : '#050508',
          transition: 'background-color 0.1s ease-out'
        }}
      >
        {phase === 'playing' && dangerLevel > 0.06 && (
          <div
            className="fx-vignette"
            style={{
              animationDuration: '750ms',
              boxShadow: `inset 0 0 ${40 + dangerLevel * 60}px rgba(239, 68, 68, ${0.15 + dangerLevel * 0.45})`
            }}
          />
        )}

        {flashes.map((f) => (
          <div key={f.id} className={`fx-flash ${f.variant === 'gold' ? 'fx-flash-gold' : f.variant === 'cyan' ? 'fx-flash-cyan' : 'fx-flash-red'}`} />
        ))}

        {phase === 'rotate-hint' && (
          <div className="absolute inset-0 z-[100] flex flex-col items-center justify-center bg-black/95 text-center p-6">
            <div className="animate-bounce mb-5 text-rose-500"><RotateCcw className="w-12 h-12 mx-auto" /></div>
            <p className="text-sm font-bold text-white uppercase tracking-wider">Rotate to Landscape</p>
            <p className="text-xs text-slate-500 mt-2 max-w-[240px] mx-auto">Please rotate your device horizontally for better visual tracking and gameplay spacing.</p>
            <button
              onClick={() => {
                setPhase('countdown');
                runCountdown(3);
              }}
              className="mt-6 px-6 py-2.5 bg-slate-900 border border-gray-800 text-slate-400 text-[9px] uppercase tracking-wider rounded-lg transition active:scale-95 cursor-pointer"
            >
              Continue Anyway
            </button>
          </div>
        )}

        {phase === 'start' && (
          <div className="relative h-full flex items-center justify-center p-5 overflow-y-auto z-40">
            <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(ellipse 420px 260px at 50% 8%, rgba(239,68,68,.12), transparent 70%)' }} />
            <div className="relative w-full max-w-[290px] rounded-[20px] border border-white/5 bg-[#0c0c16]/90 backdrop-blur-lg px-5 pt-5 pb-[18px] text-center shadow-[0_16px_40px_rgba(0,0,0,.5)] my-6">
              <div className="w-11 h-11 mx-auto rounded-[14px] bg-gradient-to-br from-red-500 to-orange-500 flex items-center justify-center mb-3 shadow-[0_0_22px_rgba(239,68,68,.35)]">
                <Target className="w-[22px] h-[22px] text-white" />
              </div>
              <h1 className="text-[17px] font-bold tracking-tight">Reaction Simulator</h1>
              <p className="text-[9px] font-bold text-slate-500 uppercase tracking-widest mt-1">45-second run</p>
              <p className="text-[10px] text-slate-500 uppercase tracking-widest mt-1">Multi-Target Vertical Intercept</p>

              <div className="flex flex-col gap-1.5 text-left mt-3.5">
                <div className="flex items-center gap-2 bg-white/[0.02] border border-white/5 rounded-[10px] px-2.5 py-[7px]">
                  <Eye className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />
                  <span className="text-[10.5px] text-slate-300 leading-tight whitespace-nowrap">Hit the targets before they fall</span>
                </div>
                <div className="flex items-center gap-2 bg-white/[0.02] border border-white/5 rounded-[10px] px-2.5 py-[7px]">
                  <ZapIcon className="w-3.5 h-3.5 text-orange-400 flex-shrink-0" />
                  <span className="text-[10.5px] text-slate-300 leading-tight whitespace-nowrap">Micro and speed targets score more</span>
                </div>
                <div className="flex items-center gap-2 bg-white/[0.02] border border-white/5 rounded-[10px] px-2.5 py-[7px]">
                  <Target className="w-3.5 h-3.5 text-yellow-400 flex-shrink-0" />
                  <span className="text-[10.5px] text-slate-300 leading-tight whitespace-nowrap">Misses cost a life · 5 lives</span>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-1.5 mt-3.5">
                <MiniStat label="Best" value={bestScore} color="text-yellow-400" />
                <MiniStat label="Combo" value={`${bestCombo}x`} color="text-orange-400" />
                <MiniStat label="Level" value={`Lv.${bestLevel}`} color="text-indigo-400" />
              </div>

              <button
                onClick={enterDrill}
                className="w-full mt-3.5 py-[11px] rounded-[13px] bg-gradient-to-r from-red-500 to-orange-600 font-bold text-[12.5px] tracking-wide active:scale-[0.97] transition-transform shadow-[0_0_20px_rgba(239,68,68,.3)] cursor-pointer"
              >
                START
              </button>
            </div>

            <button
              onClick={() => setSoundEnabled((v) => { audioSynth?.setEnabled(!v); return !v; })}
              className="absolute bottom-3.5 right-4 w-[26px] h-[26px] before:absolute before:top-0 before:left-0 before:-right-[16px] before:-bottom-[14px] before:content-[''] rounded-full bg-white/[0.04] border border-white/[0.08] flex items-center justify-center text-slate-500 hover:text-white transition-colors cursor-pointer"
            >
              {soundEnabled ? <Volume2 className="w-3 h-3" /> : <VolumeX className="w-3 h-3" />}
            </button>
          </div>
        )}

        {phase === 'countdown' && (
          <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/55 backdrop-blur-[2px]">
            <span className="text-[11px] font-black uppercase tracking-[0.2em] text-slate-400">Get Ready</span>
            <div className="relative w-28 h-28 rounded-full border-[3px] border-red-500/20 flex items-center justify-center">
              <div className="absolute -inset-[3px] rounded-full border-[3px] border-transparent border-t-red-500 border-r-red-500 animate-spin" style={{ animationDuration: '0.7s' }} />
              <span key={countdownValue} className="fx-pop-in text-5xl font-black bg-gradient-to-b from-white to-red-300 bg-clip-text text-transparent">
                {countdownValue > 0 ? countdownValue : 'GO'}
              </span>
            </div>
            <span className="text-[10px] text-slate-500">Targets drop at GO</span>
          </div>
        )}

        {(phase === 'playing' || phase === 'countdown') && (
          <>
            <div className="absolute top-5 left-5 z-40 flex flex-col pointer-events-none">
              <span className="text-2xl font-black text-white leading-none tabular-nums">{score}</span>
              {isChallenge ? (
                <div className="flex items-center gap-2 mt-1.5">
                  <span className="text-[10px] font-black text-red-300 bg-red-500/15 border border-red-500/25 px-1.5 py-0.5 rounded font-mono">Lv.{level}</span>
                </div>
              ) : (
                <span className="flex items-center gap-0.5 mt-1.5">
                  {Array.from({ length: MAX_LIVES }).map((_, i) => (
                    <Heart key={i} className={`w-3 h-3 ${i < lives ? 'fill-red-500 text-red-500' : 'text-white/15'}`} />
                  ))}
                </span>
              )}
            </div>

            <div className="absolute top-5 right-5 z-40 flex flex-col items-end pointer-events-none select-none">
              <span className={`text-3xl font-black font-mono leading-none tabular-nums ${timeRemaining <= 10 ? 'text-red-500 animate-pulse' : 'text-slate-300'}`}>
                {Math.ceil(timeRemaining)}s
              </span>
              <span className="text-[8px] text-slate-500 font-bold uppercase tracking-widest mt-1">Time Left</span>
            </div>

            {(phase === 'countdown' || phase === 'playing') && (
              <button
                onClick={() => setSoundEnabled((v) => { audioSynth?.setEnabled(!v); return !v; })}
                className="absolute bottom-5 right-5 z-40 p-2 before:absolute before:top-0 before:left-0 before:-right-[14px] before:-bottom-[14px] before:content-[''] rounded-full bg-black/60 border border-white/10 text-slate-400 active:scale-90 transition-transform pointer-events-auto cursor-pointer"
              >
                {soundEnabled ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
              </button>
            )}
          </>
        )}

        {phase === 'playing' && (
          <canvas
            ref={canvasRef}
            onPointerDown={handlePointerDown}
            className="absolute inset-0 w-full h-full cursor-crosshair z-30"
          />
        )}

        {phase === 'ended' && endSummary && (
          <ResultScreen summary={endSummary} isNewBest={isNewBest} onPlayAgain={enterDrill} onShare={shareResult} />
        )}

      </div>
    </DrillWrapper>
  );
}

function ResultScreen({ summary, isNewBest, onPlayAgain, onShare }: any) {
  const gradeColor = summary.grade.grade === 'S+' || summary.grade.grade === 'S' ? '#fbbf24' : '#ef4444';

  return (
    <div className="absolute inset-0 z-40 flex" style={{ background: 'rgba(5,5,8,0.97)' }}>
      <div className="w-[36%] flex flex-col items-center justify-center gap-1.5 border-r border-white/5" style={{ background: 'radial-gradient(ellipse 260px 200px at 50% 30%, rgba(239,68,68,.08), transparent 70%)' }}>
        {isNewBest && (
          <span className="text-[9.5px] font-bold text-yellow-400 bg-yellow-500/10 border border-yellow-500/25 px-2.5 py-0.5 rounded-full mb-1">NEW BEST</span>
        )}
        <div className="text-5xl sm:text-6xl font-black leading-none" style={{ color: gradeColor }}>
          {summary.grade.grade}
        </div>
        <div className="text-[10px] uppercase tracking-widest text-slate-500">{summary.grade.label}</div>
        <div className="text-3xl sm:text-4xl font-black text-white mt-1 tabular-nums">{summary.score.toLocaleString()}</div>
        <div className="text-[9px] uppercase tracking-widest text-slate-500">Points</div>
      </div>

      <div className="flex-1 flex flex-col justify-center gap-3 px-6 sm:px-8 py-4 min-w-0">
        <div className="grid grid-cols-3 gap-2">
          <ResultStat label="Accuracy" value={`${summary.accuracy}%`} color="text-blue-400" />
          <ResultStat label="Combo" value={`${summary.maxCombo}x`} color="text-orange-400" />
          <ResultStat label="XP" value={`+${summary.xpEarned}`} color="text-emerald-400" />
        </div>
        <div className="flex gap-2">
          <button onClick={onPlayAgain} className="flex-1 py-3 rounded-[13px] bg-gradient-to-r from-red-500 to-orange-600 text-white font-bold text-xs uppercase tracking-wide cursor-pointer">
            Play Again
          </button>
          <button onClick={onShare} className="w-11 flex-shrink-0 rounded-[13px] bg-white/[0.04] border border-white/10 flex items-center justify-center text-slate-400 hover:text-white cursor-pointer">
            <Share2 className="w-4 h-4" />
          </button>
          <Link href="/drills/cognitive" className="w-11 flex-shrink-0 rounded-[13px] bg-white/[0.04] border border-white/10 flex items-center justify-center text-slate-400 hover:text-white">
            <ArrowLeft className="w-4 h-4" />
          </Link>
        </div>
      </div>
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

function ResultStat({ label, value, color }: { label: string; value: string | number; color: string }) {
  return (
    <div className="rounded-[11px] border border-white/5 bg-white/[0.03] py-2 px-1 text-center">
      <div className={`text-sm font-black ${color} tabular-nums`}>{value}</div>
      <div className="text-[7.5px] uppercase tracking-wide text-slate-500 font-bold mt-0.5">{label}</div>
    </div>
  );
}