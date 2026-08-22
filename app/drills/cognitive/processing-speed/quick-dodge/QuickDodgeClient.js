'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  Compass, Volume2, VolumeX, Heart,
  RotateCcw, Share2, ArrowLeft, Eye, Zap as ZapIcon, Ban
} from 'lucide-react';
import { calcEndBonuses, calcSessionXP, getGrade, getComboMultiplier } from '../../../../../lib/scoringEngine';
import { saveLeaderboardEntrySync } from '../../../../../lib/leaderboard';
import { lockLandscape, unlockOrientation, onOrientationSettled } from '../../../../../lib/orientation';
import { previewDailyCompletion } from '../../../../../lib/dailyChallenge';
import { getPlayerName } from '../../../../../lib/progressStore';
import { Capacitor } from '@capacitor/core';
import { StatusBar } from '@capacitor/status-bar';
import generateShareCard, { shareScoreCard } from '../../../../../components/ShareScoreCard';
import DrillWrapper from '../../../../../components/DrillWrapper';
import { useDuelMatchStart } from '../../../../../lib/challengeEngine';
import { motionDpr, createBackdropCache } from '../../../../../lib/canvasFx';

// ============================================================
// TUNING
// ============================================================
const TOTAL_TIME = 45;
const MAX_LIVES = 5;

// Thresholds compressed ~30% and speed/spawnDelay tightened at every tier —
// the old curve let a full 45s solo run pass at trivial difficulty (see
// PLAYER_HIT_R and homingRate below for the other half of the fix). Density
// (maxEnemies) ramps a little faster too so the board fills in sooner.
const LEVEL_TABLE = [
  { threshold: 0,     speed: 30,  spawnDelay: 0.72, maxEnemies: 9,  basePoints: 2 },
  { threshold: 8,     speed: 36,  spawnDelay: 0.62, maxEnemies: 11, basePoints: 3 },
  { threshold: 35,    speed: 44,  spawnDelay: 0.54, maxEnemies: 13, basePoints: 4 },
  { threshold: 100,   speed: 53,  spawnDelay: 0.46, maxEnemies: 16, basePoints: 5 },
  { threshold: 230,   speed: 63,  spawnDelay: 0.38, maxEnemies: 19, basePoints: 6 },
  { threshold: 420,   speed: 72,  spawnDelay: 0.32, maxEnemies: 22, basePoints: 8 },
  { threshold: 700,   speed: 81,  spawnDelay: 0.27, maxEnemies: 25, basePoints: 10 },
  { threshold: 1100,  speed: 82,  spawnDelay: 0.25, maxEnemies: 27, basePoints: 13 },
  { threshold: 1700,  speed: 92,  spawnDelay: 0.20, maxEnemies: 30, basePoints: 16 },
  { threshold: 2700,  speed: 103, spawnDelay: 0.15, maxEnemies: 34, basePoints: 20 },
  { threshold: 4200,  speed: 110, spawnDelay: 0.12, maxEnemies: 36, basePoints: 22 },
  { threshold: 6300,  speed: 117, spawnDelay: 0.10, maxEnemies: 38, basePoints: 25 },
  { threshold: 9200,  speed: 123, spawnDelay: 0.09, maxEnemies: 40, basePoints: 28 },
  { threshold: 13000, speed: 128, spawnDelay: 0.08, maxEnemies: 42, basePoints: 30 },
  { threshold: 18000, speed: 131, spawnDelay: 0.07, maxEnemies: 44, basePoints: 32 },
];

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

  // 4. Penalty / Miss / Hit sound
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
  playWrong() { this.playPenalty(); }

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

  setEnabled(status) { this.enabled = status; }
}

const audioSynth = typeof window !== 'undefined' ? new AudioSynthesizer() : null;

// ============================================================
// LOCAL STORAGE CONSOLIDATED KEY & MIGRATION
// ============================================================
const STORAGE_KEY = 'skilldrills_quick_dodge_v3';

const getSavedData = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
    const v2 = localStorage.getItem('skilldrills_quick_dodge_v2');
    if (v2) {
      const old = JSON.parse(v2);
      const migrated = { bestScore: old.bestScore || 0, bestCombo: old.bestCombo || 0, bestLevel: old.bestLevel || 1, totalSessions: old.totalSessions || 0 };
      saveData(migrated);
      return migrated;
    }
    return { bestScore: 0, bestCombo: 0, bestLevel: 1, totalSessions: 0 };
  } catch (e) {
    return { bestScore: 0, bestCombo: 0, bestLevel: 1, totalSessions: 0 };
  }
};
const saveData = (data) => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (e) {} };

// ============================================================
// MAIN COMPONENT
// ============================================================
export default function QuickDodgeClient() {
  const searchParams = useSearchParams();
  const challengeId = searchParams ? searchParams.get('challengeId') : null;
  const isChallenge = !!challengeId;
  const totalTime = isChallenge ? 30 : TOTAL_TIME;

  const [isClient, setIsClient] = useState(false);
  const [loading, setLoading] = useState(true);
  const [soundEnabled, setSoundEnabled] = useState(true);

  const [phase, setPhase] = useState('start');
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

  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const canvasSizeRef = useRef({ width: 0, height: 0 });
  const gameActiveRef = useRef(false);
  const mountedRef = useRef(false);
  const animationRef = useRef(null);
  const drawAnimRef = useRef(null);
  const lastTimeRef = useRef(0);
  const countdownTimerRef = useRef(null);
  const heartbeatTimerRef = useRef(null);
  const heartbeatTempoRef = useRef(1100);
  const particlesRef = useRef([]);
  const shockwavesRef = useRef([]);

  // Touch tracking
  const touchActiveRef = useRef(false);
  const touchStartRef = useRef({ x: 0, y: 0 });
  const playerStartRef = useRef({ x: 50, y: 50 });

  // Engine state
  const engine = useRef({
    player: { x: 50, y: 50 },
    obstacles: [],
    obstacleIdCounter: 0,

    score: 0,
    streak: 0,
    maxStreak: 0,
    dodges: 0,
    hitsTaken: 0,
    nearMisses: 0,
    lives: MAX_LIVES,

    timeLeft: totalTime,
    elapsedTime: 0,
    speed: LEVEL_TABLE[0].speed,
    spawnDelay: LEVEL_TABLE[0].spawnDelay,
    maxEnemies: LEVEL_TABLE[0].maxEnemies,
    basePoints: LEVEL_TABLE[0].basePoints,
    spawnTimer: 0,
    level: 1,

    containerW: 0,
    containerH: 0,
  });

  useEffect(() => {
    setIsClient(true);
    mountedRef.current = true;
    const data = getSavedData();
    setBestScore(data.bestScore);
    setBestCombo(data.bestCombo);
    setBestLevel(data.bestLevel);
    
    const t = setTimeout(() => setLoading(false), 150);
    return () => {
      clearTimeout(t);
      mountedRef.current = false;
      gameActiveRef.current = false;
      if (countdownTimerRef.current) clearTimeout(countdownTimerRef.current);
      if (heartbeatTimerRef.current) clearTimeout(heartbeatTimerRef.current);
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
      if (drawAnimRef.current) cancelAnimationFrame(drawAnimRef.current);
      try { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); } catch (e) {}
      if (Capacitor.isNativePlatform()) {
        StatusBar.setOverlaysWebView({ overlay: false }).catch(() => {});
        StatusBar.show().catch(() => {});
      }
      unlockOrientation();
    };
  }, []);

  useEffect(() => { if (audioSynth) audioSynth.setEnabled(soundEnabled); }, [soundEnabled]);

  // Touch / Pointer Handlers
  const handlePointerDown = useCallback((e) => {
    if (!gameActiveRef.current) return;
    e.preventDefault();
    touchActiveRef.current = true;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    touchStartRef.current = { x: e.clientX, y: e.clientY };
    playerStartRef.current = { x: engine.current.player.x, y: engine.current.player.y };
  }, []);

  const handlePointerMove = useCallback((e) => {
    if (!touchActiveRef.current || !gameActiveRef.current) return;
    e.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const dx = ((e.clientX - touchStartRef.current.x) / rect.width) * 100;
    const dy = ((e.clientY - touchStartRef.current.y) / rect.height) * 100;
    const nx = Math.max(3, Math.min(97, playerStartRef.current.x + dx));
    const ny = Math.max(3, Math.min(97, playerStartRef.current.y + dy));
    engine.current.player.x = nx;
    engine.current.player.y = ny;
  }, []);

  const handlePointerUp = useCallback(() => {
    touchActiveRef.current = false;
  }, []);

  // Keyboard fallback
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (!gameActiveRef.current) return;
      const step = 3;
      const p = engine.current.player;
      let moved = false;
      if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') { p.x = Math.max(3, p.x - step); moved = true; }
      if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') { p.x = Math.min(97, p.x + step); moved = true; }
      if (e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') { p.y = Math.max(3, p.y - step); moved = true; }
      if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') { p.y = Math.min(97, p.y + step); moved = true; }
      if (moved) e.preventDefault();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Expanding hollow ring left at an impact point. Same visual language as the
  // obstacles themselves (a ring rising out of a centre dot), so a hit reads as
  // the hazard discharging rather than as a separate particle effect.
  const spawnShockwave = useCallback((xPct, yPct, color) => {
    shockwavesRef.current.push({ x: xPct, y: yPct, life: 1, color });
  }, []);

  const spawnBurst = useCallback((xPct, yPct, color, count = 12) => {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 0.4 + Math.random() * 1.3;
      particlesRef.current.push({
        x: xPct, y: yPct,
        vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
        r: 0.6 + Math.random() * 0.8, alpha: 1, color,
      });
    }
  }, []);

  const spawnObstacle = useCallback(() => {
    const e = engine.current;
    const side = Math.floor(Math.random() * 4);
    let x = 0, y = 0;

    if (side === 0) { x = Math.random() * 100; y = -8; }
    else if (side === 1) { x = 108; y = Math.random() * 100; }
    else if (side === 2) { x = Math.random() * 100; y = 108; }
    else { x = -8; y = Math.random() * 100; }

    const angle = Math.atan2(e.player.y - y, e.player.x - x);
    const id = ++e.obstacleIdCounter;
    const levelProgress = (e.level - 1) / (LEVEL_TABLE.length - 1);
    const sizeScale = 1.0 + levelProgress * 0.5;
    const maxR = 4.95 * sizeScale; // ~10% smaller for extra room to move

    e.obstacles.push({
      id, x, y,
      vx: Math.cos(angle) * e.speed,
      vy: Math.sin(angle) * e.speed,
      speed: e.speed,
      r: maxR * 0.3,
      maxR,
      nearMissTriggered: false,
    });
  }, []);

  const updateDifficulty = useCallback(() => {
    const e = engine.current;
    let newLevel = 1;
    for (let i = LEVEL_TABLE.length - 1; i >= 0; i--) {
      if (e.score >= LEVEL_TABLE[i].threshold) { newLevel = i + 1; break; }
    }
    if (newLevel > e.level) {
      e.level = newLevel;
    }

    const bracket = LEVEL_TABLE[e.level - 1];
    e.speed = bracket.speed;
    e.spawnDelay = bracket.spawnDelay;
    e.maxEnemies = bracket.maxEnemies;
    e.basePoints = bracket.basePoints;
  }, []);

  const endGame = useCallback(async (reason) => {
    gameActiveRef.current = false;
    setPhase('ended');
    if (animationRef.current) cancelAnimationFrame(animationRef.current);
    if (heartbeatTimerRef.current) clearTimeout(heartbeatTimerRef.current);

    const e = engine.current;
    audioSynth?.playResultsReveal();

    const totalEvents = e.dodges + e.hitsTaken;
    const accuracy = totalEvents > 0 ? Math.round((e.dodges / totalEvents) * 100) : 100;

    const bonuses = calcEndBonuses({
      rawScore: e.score,
      accuracy,
      bestCombo: e.maxStreak,
      totalActions: e.dodges,
      mistakes: e.hitsTaken,
      livesRemaining: Math.max(0, e.lives),
      maxLives: MAX_LIVES,
      category: 'cognitive',
    });

    const finalScore = bonuses.finalScore;
    const prev = getSavedData();
    const isNewBest = finalScore > prev.bestScore;
    const firstPlay = prev.totalSessions === 0;

    const daily = isChallenge
      ? { isDailyDrill: false, wouldCompleteSet: false }
      : await previewDailyCompletion('quick-dodge');

    const xpResult = calcSessionXP({ finalScore, accuracy, isNewBest, firstPlay, dailyChallenge: daily.isDailyDrill, dailyChallengeSetComplete: daily.wouldCompleteSet });

    const updated = {
      bestScore: Math.max(prev.bestScore, finalScore),
      bestCombo: Math.max(prev.bestCombo, e.maxStreak),
      bestLevel: Math.max(prev.bestLevel, e.level),
      totalSessions: prev.totalSessions + 1,
    };
    saveData(updated);
    setBestScore(updated.bestScore);
    setBestCombo(updated.bestCombo);
    setBestLevel(updated.bestLevel);

    saveLeaderboardEntrySync({ drillId: 'quick-dodge', drillName: 'Quick Dodge', category: 'cognitive', score: finalScore, accuracy, bestCombo: e.maxStreak });

    setEndSummary({
      score: finalScore,
      accuracy,
      bestCombo: e.maxStreak,
      level: e.level,
      isNewBest,
      xpEarned: xpResult.xp,
    });
  }, []);

  const scheduleHeartbeat = useCallback(() => {
    if (isChallenge) return;
    if (!gameActiveRef.current) return;
    const e = engine.current;
    const dangerFromLives = (MAX_LIVES - e.lives) / MAX_LIVES;
    const dangerFromTime = e.timeLeft <= 10 ? (10 - e.timeLeft) / 10 : 0;
    const danger = Math.min(1, Math.max(dangerFromLives * 0.7, dangerFromTime));
    const tempo = Math.max(350, Math.round(1100 - danger * 650));
    heartbeatTempoRef.current = tempo;
    if (danger > 0.08) audioSynth?.playHeartbeat(danger);
    setDangerLevel(danger);
    heartbeatTimerRef.current = setTimeout(scheduleHeartbeat, tempo);
  }, [isChallenge]);

  const triggerShake = () => {
    setShakeCls('fx-shake');
    setTimeout(() => setShakeCls(''), 350);
  };

  const triggerFlash = (variant) => {
    const id = Date.now();
    setFlashes(prev => [...prev, { id, variant }]);
    setTimeout(() => setFlashes(prev => prev.filter(f => f.id !== id)), 350);
  };

  const runGameLoop = useCallback(() => {
    const FIXED_DT = 1 / 60;

    const step = (dt) => {
      const e = engine.current;

      e.timeLeft -= dt;
      e.elapsedTime += dt;

      if (e.timeLeft <= 0 || e.elapsedTime >= totalTime) {
        e.timeLeft = Math.max(0, e.timeLeft);
        endGame('time');
        return true;
      }

      updateDifficulty();

      e.spawnTimer += dt;
      if (e.spawnTimer > e.spawnDelay && e.obstacles.length < e.maxEnemies) {
        spawnObstacle();
        e.spawnTimer = 0;
      }

      // Floor raised from 0.15 to 0.28 (and ceiling from 0.85 to 1.13
      // rad/sec) — even level-1 obstacles now visibly curve toward the
      // player instead of nearly flying past in a straight line, and top-level
      // obstacles track aggressively enough that standing still is a losing
      // move.
      const homingRate = 0.28 + ((e.level - 1) / (LEVEL_TABLE.length - 1)) * 0.85;
      let playerHit = false;
      const px = e.player.x;
      const py = e.player.y;
      // Was 1.5 — smaller than the player dot actually renders at (pr =
      // minDim * 0.024, i.e. ~2.4% of minDim in this same percentage-of-field
      // space). A near-miss that visibly grazed the dot wasn't registering as
      // a hit, which was a big part of why the drill felt too forgiving.
      // 2.6 now matches (slightly exceeds) the rendered dot.
      const PLAYER_HIT_R = 2.6;

      for (let i = e.obstacles.length - 1; i >= 0; i--) {
        const o = e.obstacles[i];

        if (homingRate > 0) {
          const currentAngle = Math.atan2(o.vy, o.vx);
          const targetAngle = Math.atan2(py - o.y, px - o.x);
          let diff = targetAngle - currentAngle;
          diff = Math.atan2(Math.sin(diff), Math.cos(diff));
          const maxSteer = homingRate * dt;
          const steer = Math.max(-maxSteer, Math.min(maxSteer, diff));
          const newAngle = currentAngle + steer;
          o.vx = Math.cos(newAngle) * o.speed;
          o.vy = Math.sin(newAngle) * o.speed;
        }

        o.x += o.vx * dt;
        o.y += o.vy * dt;
        o.r += (o.maxR - o.r) * 2.0 * dt;

        const dist = Math.hypot(px - o.x, py - o.y);
        const hitRadius = o.r + PLAYER_HIT_R;

        if (dist < hitRadius) {
          playerHit = true;
          break;
        }

        if (o.x < -15 || o.x > 115 || o.y < -15 || o.y > 115) {
          e.obstacles.splice(i, 1);
          e.dodges++;
          e.streak++;
          if (e.streak > e.maxStreak) e.maxStreak = e.streak;

          const comboMult = getComboMultiplier(e.streak);
          const pts = Math.floor(e.basePoints * comboMult);
          e.score += pts;

          if (e.streak > 0 && e.streak % 5 === 0) {
            audioSynth?.playHit();
            spawnBurst(px, py, '#fbbf24', 14);
          }
        }
      }

      if (playerHit) {
        e.hitsTaken++;
        if (!isChallenge) {
          e.lives = Math.max(0, e.lives - 1);
        } else {
          e.score = Math.max(0, e.score - 5);
        }
        e.streak = 0;

        audioSynth?.playPenalty();
        triggerShake();
        triggerFlash('red');
        spawnShockwave(px, py, '254,202,202');
        spawnBurst(px, py, '#fecaca', 10);

        // Was 12 — the post-hit mercy clear was wiping out most of the
        // nearby board on every hit, which combined with the weak hitbox
        // above made getting hit almost consequence-free for the next second.
        const clearRadius = 8;
        e.obstacles = e.obstacles.filter(o => Math.hypot(px - o.x, py - o.y) > clearRadius);

        if (!isChallenge && e.lives <= 0) {
          endGame('lives');
          return true;
        }
      }

      if (Math.round(e.elapsedTime * 60) % 4 === 0) {
        setScore(e.score);
        setCombo(e.streak);
        setTimeRemaining(e.timeLeft);
        setLevel(e.level);
        setLives(e.lives);
      }

      return false;
    };

    let accumulator = 0;
    const loop = (time) => {
      if (!gameActiveRef.current) return;
      let deltaMs = time - lastTimeRef.current;
      lastTimeRef.current = time;
      if (deltaMs > 250) deltaMs = 250;
      accumulator += deltaMs / 1000;

      let steps = 0;
      while (accumulator >= FIXED_DT && steps < 8) {
        if (step(FIXED_DT)) return;
        accumulator -= FIXED_DT;
        steps++;
      }
      if (steps >= 8) accumulator = 0;

      animationRef.current = requestAnimationFrame(loop);
    };

    lastTimeRef.current = performance.now();
    animationRef.current = requestAnimationFrame(loop);
  }, [endGame, spawnObstacle, updateDifficulty, spawnBurst, spawnShockwave, totalTime, isChallenge]);

  const runCountdown = useCallback((n) => {
    if (countdownTimerRef.current) clearTimeout(countdownTimerRef.current);
    if (n <= 0) {
      if (!isChallenge) audioSynth?.playGo();
      setPhase('playing');
      gameActiveRef.current = true;

      const e = engine.current;
      const startLevel = Math.max(1, Math.min(LEVEL_TABLE.length, Math.round(bestLevel * 0.55)));
      const startBracket = LEVEL_TABLE[startLevel - 1];

      e.player = { x: 50, y: 50 };
      e.obstacles = [];
      e.obstacleIdCounter = 0;
      e.score = 0; e.streak = 0; e.maxStreak = 0;
      e.dodges = 0; e.hitsTaken = 0; e.nearMisses = 0; e.lives = MAX_LIVES;
      e.timeLeft = totalTime; e.elapsedTime = 0;
      e.level = startLevel;
      e.speed = startBracket.speed; e.spawnDelay = startBracket.spawnDelay;
      e.maxEnemies = startBracket.maxEnemies; e.basePoints = startBracket.basePoints;
      e.spawnTimer = 0;

      particlesRef.current = [];
    shockwavesRef.current = [];
      setScore(0); setCombo(0); setTimeRemaining(totalTime); setLevel(startLevel); setLives(MAX_LIVES);

      runGameLoop();
      scheduleHeartbeat();
      return;
    }
    setCountdownValue(n);
    if (!isChallenge) audioSynth?.playCountdownTick();
    countdownTimerRef.current = setTimeout(() => runCountdown(n - 1), 700);
  }, [runGameLoop, scheduleHeartbeat, bestLevel, totalTime, isChallenge]);

  const enterDrill = useCallback(async () => {
    try { if (audioSynth) audioSynth.init(); } catch (e) {}

    gameActiveRef.current = false;
    if (countdownTimerRef.current) clearTimeout(countdownTimerRef.current);
    if (heartbeatTimerRef.current) clearTimeout(heartbeatTimerRef.current);
    if (animationRef.current) cancelAnimationFrame(animationRef.current);

    setScore(0); setCombo(0); setTimeRemaining(totalTime);
    setLevel(1); setLives(MAX_LIVES); setDangerLevel(0); setEndSummary(null);
    setFlashes([]); setShakeCls('');

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
      if (window.innerHeight > window.innerWidth) {
        setPhase('rotate-hint');
      } else {
        setPhase('countdown');
        runCountdown(isChallenge ? 0 : 3);
      }
    }, 200);
  }, [runCountdown, isChallenge, totalTime]);

  const matchStartAt = useDuelMatchStart(challengeId);
  const duelAutoStartedRef = useRef(false);
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

  useEffect(() => {
    const handleResize = () => {
      if (phase === 'rotate-hint' && window.innerWidth > window.innerHeight) {
        setPhase('countdown');
        runCountdown(isChallenge ? 0 : 3);
      }
    };
    return onOrientationSettled(handleResize);
  }, [phase, runCountdown, isChallenge]);

  // Canvas render loop
  useEffect(() => {
    if (phase !== 'playing' && phase !== 'countdown') {
      if (drawAnimRef.current) { cancelAnimationFrame(drawAnimRef.current); drawAnimRef.current = null; }
      return;
    }

    const resizeCanvas = () => {
      const cvs = canvasRef.current;
      const el = containerRef.current;
      if (!cvs || !el) return;
      const rect = el.getBoundingClientRect();
      const dpr = motionDpr();
      cvs.width = rect.width * dpr;
      cvs.height = rect.height * dpr;
      canvasSizeRef.current = { width: rect.width, height: rect.height };
      engine.current.containerW = rect.width;
      engine.current.containerH = rect.height;
    };

    resizeCanvas();
    const ro = new ResizeObserver(resizeCanvas);
    if (containerRef.current) ro.observe(containerRef.current);
    window.addEventListener('resize', resizeCanvas);
    window.addEventListener('orientationchange', resizeCanvas);

    // Static play-field backdrop (flat fill + grid), rendered once per size
    // instead of redrawn from scratch every frame — same pattern as the other
    // canvas drills (see createBackdropCache in lib/canvasFx.js).
    const backdrop = createBackdropCache((c, w, h) => {
      c.fillStyle = '#050508';
      c.fillRect(0, 0, w, h);
      c.strokeStyle = 'rgba(255,255,255,0.015)';
      c.lineWidth = 1;
      c.beginPath();
      for (let x = 0; x < w; x += 40) { c.moveTo(x, 0); c.lineTo(x, h); }
      for (let y = 0; y < h; y += 40) { c.moveTo(0, y); c.lineTo(w, y); }
      c.stroke();
    });

    // Pre-rendered ring sprites, one per obstacle color — this replaces a
    // live arc()+stroke() PER OBSTACLE PER FRAME (up to 44 of them at max
    // level, each forcing its own circle tessellation and anti-aliased line
    // rasterization) with a cheap drawImage blit. This was the single
    // biggest per-frame cost once the board filled up at higher levels —
    // exactly the "the red things look great but cost CPU" tradeoff, now
    // paid once at setup instead of 30-40x every frame. The one visible
    // difference: the ring's line thickness now scales with its radius
    // (baked into the bitmap) instead of staying a fixed 1.5px — barely
    // perceptible on a fast-expanding, fading ping like this.
    const RING_SPRITE_SIZE = 64;
    const makeRingSprite = (color) => {
      const s = document.createElement('canvas');
      s.width = RING_SPRITE_SIZE;
      s.height = RING_SPRITE_SIZE;
      const sctx = s.getContext('2d');
      const lw = RING_SPRITE_SIZE * 0.045;
      sctx.strokeStyle = color;
      sctx.lineWidth = lw;
      sctx.beginPath();
      sctx.arc(RING_SPRITE_SIZE / 2, RING_SPRITE_SIZE / 2, RING_SPRITE_SIZE / 2 - lw, 0, Math.PI * 2);
      sctx.stroke();
      return s;
    };
    const ringSpriteGlow = makeRingSprite('#fecaca');
    const ringSpriteBase = makeRingSprite('#f87171');

    const drawPulseRing = (ctx, x, y, baseR, glowing, time, seed, periodSec, maxScale, alphaStart) => {
      const cycle = ((time + seed) % periodSec) / periodSec;
      const ringR = baseR * (1 + cycle * (maxScale - 1));
      const alpha = alphaStart * (1 - cycle);
      if (alpha <= 0) return;
      const d = ringR * 2;
      ctx.globalAlpha = alpha;
      ctx.drawImage(glowing ? ringSpriteGlow : ringSpriteBase, x - ringR, y - ringR, d, d);
      ctx.globalAlpha = 1.0;
    };

    let lastDrawTs = 0;
    const draw = (timestamp) => {
      const cvs = canvasRef.current;
      // alpha: false — the backdrop blit below covers the full canvas every
      // frame, so nothing behind it can show through anyway. Declaring it
      // opaque stops the compositor alpha-blending a full-screen layer 60x/sec.
      const ctx = cvs?.getContext('2d', { alpha: false });
      if (!ctx) { drawAnimRef.current = requestAnimationFrame(draw); return; }

      // 60fps cap (14ms) on the canvas repaint. Physics (runGameLoop) stays on
      // its own fixed-timestep accumulator, so difficulty and hit-detection
      // precision are identical either way — this changes how smoothly the
      // player SEES the field, nothing about how it plays out.
      //
      // Was 32ms (~30fps). That saved real work back when each obstacle drew
      // its pulse ring as a live arc()+stroke() every frame, but those are
      // pre-rendered sprites blitted with drawImage now, so a frame is far
      // cheaper than it was when 30 was chosen. And 30fps is the worst place
      // to economise in THIS drill specifically: it's a dodging game, so
      // seeing an obstacle's approach smoothly is the core mechanic — at 30fps
      // each one steps across the field in visible jumps, which reads as lag
      // and makes close gaps genuinely harder to judge than intended.
      //
      // 14, not 16: a real 60Hz frame arrives every ~16.7ms but jitters, and a
      // 16ms threshold would occasionally skip one and drop a frame; 14 passes
      // every 60Hz frame while still halving a 120Hz phone to 60.
      if (timestamp - lastDrawTs < 14) {
        drawAnimRef.current = requestAnimationFrame(draw);
        return;
      }
      lastDrawTs = timestamp;

      const w = canvasSizeRef.current.width;
      const h = canvasSizeRef.current.height;
      const dpr = motionDpr();
      const minDim = Math.min(w, h);
      const e = engine.current;
      const time = performance.now() * 0.001;

      ctx.save();
      ctx.scale(dpr, dpr);

      if (backdrop.ensure(w, h, dpr)) {
        ctx.drawImage(backdrop.canvas, 0, 0, w, h);
      } else {
        ctx.fillStyle = '#050508';
        ctx.fillRect(0, 0, w, h);
      }

      if (phase === 'playing') {
        const px = (e.player.x / 100) * w;
        const py = (e.player.y / 100) * h;
        const pr = minDim * 0.024;
        const pulse = Math.sin(time * 3) * 0.15 + 1.15;

        ctx.beginPath();
        ctx.arc(px, py, pr * pulse * 1.8, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(16,185,129,0.14)';
        ctx.fill();

        const pGrad = ctx.createLinearGradient(px - pr, py - pr, px + pr, py + pr);
        pGrad.addColorStop(0, '#6ee7b7');
        pGrad.addColorStop(1, '#059669');
        ctx.beginPath();
        ctx.arc(px, py, pr, 0, Math.PI * 2);
        ctx.fillStyle = pGrad;
        ctx.fill();
        ctx.strokeStyle = '#a7f3d0';
        ctx.lineWidth = 1.8;
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(px - pr * 0.3, py - pr * 0.3, pr * 0.22, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();

        drawPulseRing(ctx, px, py, pr, 'rgba(52,211,153,1)', time, 0, 1.5, 2.4, 0.3);

        const levelProgress = (e.level - 1) / (LEVEL_TABLE.length - 1);
        const glowing = levelProgress >= 0.65;
        const showTrails = levelProgress >= 0.4;

        // Batched obstacle rendering — at max difficulty this drill spawns
        // up to 42 obstacles (LEVEL_TABLE's maxEnemies), and every
        // obstacle's color only depends on `glowing`/`showTrails` (level
        // state, identical for all of them in a given frame), never on the
        // individual obstacle. So instead of a fresh gradient object plus
        // ~6 separate draw calls PER obstacle per frame (250+ draw calls
        // and 42 gradient allocations/frame at the hardest levels — the
        // exact point where lag was worst), every obstacle's shape for a
        // given layer goes into one shared path and gets drawn with a
        // single fill()/stroke() call for the whole batch.
        // Obstacles are drawn HOLLOW: a bright core dot, an open middle, and a
        // light outline sitting exactly on the collision radius, with a ring
        // that rises out of the dot and expands to that outline. The old solid
        // red disc hid the play field behind it and filled a large area every
        // frame; an outline costs only its own perimeter, and the open middle
        // lets the player see hazards overlapping each other.
        //
        // Batched by layer: every obstacle's shape for a given layer goes into
        // ONE path and is drawn with a single fill()/stroke() for the whole
        // batch, so obstacle count costs paths, not draw calls.
        //
        // Read straight off e.obstacles with an index loop — the previous
        // version built a throwaway array of 42 fresh objects every frame
        // purely to hold the scaled coordinates.
        const obs = e.obstacles;
        const CORE = 0.2;   // core dot, as a fraction of the collision radius

        if (showTrails) {
          ctx.beginPath();
          for (let i = 0; i < obs.length; i++) {
            const o = obs[i];
            const ox = (o.x / 100) * w;
            const oy = (o.y / 100) * h;
            ctx.moveTo(ox, oy);
            ctx.lineTo(ox - (o.vx / 100) * w * 0.05, oy - (o.vy / 100) * h * 0.05);
          }
          ctx.strokeStyle = 'rgba(239,68,68,0.5)';
          ctx.lineWidth = 4;
          ctx.stroke();
        }

        // Faint wash inside the outline — just enough that the hazard reads as
        // a body rather than a floating circle, while staying see-through.
        ctx.beginPath();
        for (let i = 0; i < obs.length; i++) {
          const o = obs[i];
          const ox = (o.x / 100) * w;
          const oy = (o.y / 100) * h;
          const or_ = (o.r / 100) * minDim;
          ctx.moveTo(ox + or_, oy);
          ctx.arc(ox, oy, or_, 0, Math.PI * 2);
        }
        ctx.fillStyle = glowing ? 'rgba(239,68,68,0.16)' : 'rgba(239,68,68,0.10)';
        ctx.fill();

        // The boundary, on the exact collision radius so what you see is what
        // kills you.
        ctx.strokeStyle = glowing ? '#fca5a5' : '#f87171';
        ctx.lineWidth = glowing ? 2.4 : 1.8;
        ctx.stroke();

        // Bright core dot — the point the ring rises out of.
        ctx.beginPath();
        for (let i = 0; i < obs.length; i++) {
          const o = obs[i];
          const ox = (o.x / 100) * w;
          const oy = (o.y / 100) * h;
          const or_ = (o.r / 100) * minDim;
          ctx.moveTo(ox + or_ * CORE, oy);
          ctx.arc(ox, oy, or_ * CORE, 0, Math.PI * 2);
        }
        ctx.fillStyle = glowing ? '#ffffff' : '#fecaca';
        ctx.fill();

        // The rising ring: expands from the core dot out to the boundary and
        // fades, so each hazard reads as pulsing outward from its centre.
        // maxScale is 1/CORE, which lands the ring exactly on the outline.
        const period = Math.max(0.55, 1.3 - levelProgress * 0.75);
        const ringColor = glowing ? 'rgba(254,202,202,1)' : 'rgba(248,113,113,1)';
        for (let i = 0; i < obs.length; i++) {
          const o = obs[i];
          const ox = (o.x / 100) * w;
          const oy = (o.y / 100) * h;
          const or_ = (o.r / 100) * minDim;
          // NOTE: the 5th argument is the COLOUR. It used to be passed the
          // boolean `glowing`, which Canvas silently ignores as a strokeStyle,
          // so these rings inherited whatever colour was last set.
          drawPulseRing(ctx, ox, oy, or_ * CORE, ringColor, time, o.id * 0.37, period, 1 / CORE, 0.45);
        }
      }

      // Shockwaves: a ring that grows out of the impact point and fades. Drawn
      // before the sparks so the sparks read as travelling over it.
      for (let i = shockwavesRef.current.length - 1; i >= 0; i--) {
        const sw = shockwavesRef.current[i];
        sw.life -= 0.045;
        if (sw.life <= 0) { shockwavesRef.current.splice(i, 1); continue; }
        const t01 = 1 - sw.life;                 // 0 -> 1 over the ring's life
        const sx = (sw.x / 100) * w;
        const sy = (sw.y / 100) * h;
        const rr = minDim * (0.012 + t01 * 0.13);
        ctx.beginPath();
        ctx.arc(sx, sy, rr, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${sw.color},${(sw.life * 0.9).toFixed(3)})`;
        ctx.lineWidth = 2.5 * sw.life + 0.5;
        ctx.stroke();
      }

      for (let i = particlesRef.current.length - 1; i >= 0; i--) {
        const p = particlesRef.current[i];
        p.x += p.vx;
        p.y += p.vy;
        p.alpha -= 0.045;
        if (p.alpha <= 0) { particlesRef.current.splice(i, 1); continue; }
        const ppx = (p.x / 100) * w;
        const ppy = (p.y / 100) * h;
        ctx.beginPath();
        ctx.arc(ppx, ppy, p.r * (minDim / 100), 0, Math.PI * 2);
        ctx.globalAlpha = p.alpha;
        ctx.fillStyle = p.color;
        ctx.fill();
        ctx.globalAlpha = 1.0;
      }

      ctx.restore();
      drawAnimRef.current = requestAnimationFrame(draw);
    };

    drawAnimRef.current = requestAnimationFrame(draw);
    return () => {
      if (drawAnimRef.current) cancelAnimationFrame(drawAnimRef.current);
      ro.disconnect();
      window.removeEventListener('resize', resizeCanvas);
      window.removeEventListener('orientationchange', resizeCanvas);
    };
  }, [phase]);

  const shareResult = useCallback(async () => {
    if (!endSummary) return;
    const url = 'https://skilldrills.online/drills/cognitive/processing-speed/quick-dodge';

    try {
      const grade = getGrade(endSummary.accuracy);
      const canvas = generateShareCard({
        score: endSummary.score,
        bestScore,
        accuracy: endSummary.accuracy,
        bestCombo: endSummary.bestCombo,
        rating: { letter: grade.grade, label: grade.label, emoji: grade.emoji },
        newBest: endSummary.isNewBest,
        drillName: 'Quick Dodge',
        playerName: getPlayerName(),
      });
      await shareScoreCard(url, canvas);
    } catch (e) {
      const text = `Scored ${endSummary.score} on Quick Dodge (${endSummary.accuracy}% accuracy, ${endSummary.bestCombo}x combo) — SkillDrills`;
      if (typeof navigator !== 'undefined' && navigator.share) {
        navigator.share({ title: 'Quick Dodge — SkillDrills', text, url }).catch(() => {});
      } else if (typeof navigator !== 'undefined' && navigator.clipboard) {
        navigator.clipboard.writeText(`${text} ${url}`);
      }
    }
  }, [endSummary, bestScore]);

  if (loading || !isClient) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-[#050508]">
        <div className="text-center">
          <div className="w-14 h-14 border-4 border-emerald-600 border-t-transparent rounded-full animate-spin mx-auto mb-4 shadow-[0_0_20px_rgba(16,185,129,0.5)]" />
          <p className="text-slate-500 font-bold tracking-widest uppercase text-[10px] animate-pulse">Loading Evasion Engine...</p>
        </div>
      </div>
    );
  }

  return (
    <DrillWrapper
      drillName="Quick Dodge"
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
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onContextMenu={(e) => { if (gameActiveRef.current) e.preventDefault(); }}
        className={`absolute inset-0 select-none overflow-hidden bg-[#050508] text-white`}
        style={{ touchAction: gameActiveRef.current ? 'none' : 'auto', WebkitTapHighlightColor: 'transparent' }}
      >
        {phase === 'playing' && dangerLevel > 0.06 && (
          <div className="fx-vignette" style={{ '--v-min': Math.max(0.06, dangerLevel * 0.3), '--v-max': Math.min(0.8, dangerLevel * 0.95), animationDuration: `${heartbeatTempoRef.current}ms` }} />
        )}

        {flashes.map((f) => (
          <div key={f.id} className={`fx-flash ${f.variant === 'gold' ? 'fx-flash-gold' : f.variant === 'cyan' ? 'fx-flash-cyan' : 'fx-flash-red'}`} />
        ))}

        {(phase === 'countdown' || phase === 'playing') && (
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); setSoundEnabled((v) => { audioSynth?.setEnabled(!v); return !v; }); }}
            className="absolute bottom-5 right-5 z-40 p-2 before:absolute before:top-0 before:left-0 before:-right-[14px] before:-bottom-[14px] before:content-[''] rounded-full bg-black/60 border border-white/10 text-slate-400 active:scale-90 transition-transform cursor-pointer"
          >
            {soundEnabled ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
          </button>
        )}

        {phase === 'rotate-hint' && !isChallenge && (
          <div className="absolute inset-0 z-[100] flex flex-col items-center justify-center bg-black/95 text-center p-6">
            <div className="animate-bounce mb-5 text-emerald-400"><RotateCcw className="w-12 h-12 mx-auto" /></div>
            <p className="text-sm font-bold text-white">Rotate your phone to play</p>
            <p className="text-xs text-slate-500 mt-1.5 max-w-[220px] mx-auto">Turn your device to landscape to begin the evasion drill.</p>
          </div>
        )}

        {/* ── START SCREEN ── */}
        {phase === 'start' && !isChallenge && (
          <div className="relative h-full flex items-center justify-center p-5 overflow-y-auto z-40">
            <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(ellipse 420px 260px at 50% 8%, rgba(16,185,129,.16), transparent 70%)' }} />
            <div className="relative w-full max-w-[290px] rounded-[20px] border border-white/5 bg-[#0c0c16]/90 backdrop-blur-lg px-5 pt-5 pb-[18px] text-center shadow-[0_16px_40px_rgba(0,0,0,.5)] my-6">
              <div className="w-11 h-11 mx-auto rounded-[14px] bg-gradient-to-br from-emerald-600 to-cyan-600 flex items-center justify-center mb-3 shadow-[0_0_22px_rgba(16,185,129,.35)]">
                <Compass className="w-[22px] h-[22px] text-white" />
              </div>
              <h1 className="text-[17px] font-bold tracking-tight">Quick Dodge</h1>
              <p className="text-[9px] font-bold text-slate-500 uppercase tracking-widest mt-1">45-second run</p>

              <div className="flex flex-col gap-1.5 text-left mt-3.5">
                <HowToRow icon={<Eye className="w-3.5 h-3.5 text-cyan-400 flex-shrink-0" />} node={<>Drag your green dot to safety</>} />
                <HowToRow icon={<ZapIcon className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" />} node={<>Red circles hunt you down</>} />
                <HowToRow icon={<Ban className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />} node={<>Each hit costs a life · 5 lives</>} />
              </div>

              <div className="grid grid-cols-3 gap-1.5 mt-3.5">
                <MiniStat label="Best" value={bestScore} color="text-yellow-400" />
                <MiniStat label="Combo" value={`${bestCombo}x`} color="text-orange-400" />
                <MiniStat label="Level" value={`Lv.${bestLevel}`} color="text-emerald-400" />
              </div>

              <button
                onClick={enterDrill}
                className="w-full mt-3.5 py-[11px] rounded-[13px] bg-gradient-to-r from-emerald-600 to-cyan-600 font-bold text-[12.5px] tracking-wide active:scale-[0.97] transition-transform shadow-[0_0_20px_rgba(16,185,129,.3)] cursor-pointer"
              >
                START
              </button>
            </div>
          </div>
        )}

        {/* ── PLAYING / COUNTDOWN LAYER ── */}
        {(phase === 'playing' || phase === 'countdown') && (
          <>
            <div className="absolute top-5 left-5 z-40 flex flex-col pointer-events-none">
              <span className="text-2xl font-black text-white leading-none tabular-nums">{score}</span>
              <div className="flex items-center gap-2 mt-1.5">
                {isChallenge ? (
                  <span className="text-[10px] font-black text-emerald-300 bg-emerald-500/15 border border-emerald-500/25 px-1.5 py-0.5 rounded">Lv.{level}</span>
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
              <span className={`text-3xl font-black font-mono leading-none tabular-nums ${timeRemaining <= 10 ? 'text-red-500 animate-pulse' : 'text-slate-300'}`}>
                {Math.ceil(timeRemaining)}s
              </span>
              <span className="text-[8px] text-slate-500 font-bold uppercase tracking-widest mt-1">Time Left</span>
            </div>

            <div className="relative w-full h-full">
              <canvas
                ref={canvasRef}
                className="absolute inset-0 z-10 w-full h-full block pointer-events-none"
              />
            </div>
          </>
        )}

        {/* ── COUNTDOWN ── */}
        {phase === 'countdown' && !isChallenge && (
          <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/55 backdrop-blur-[2px]">
            <span className="text-[11px] font-black uppercase tracking-[0.2em] text-slate-400">Get Ready</span>
            <div className="relative w-28 h-28 rounded-full border-[3px] border-emerald-500/20 flex items-center justify-center">
              <div className="absolute -inset-[3px] rounded-full border-[3px] border-transparent border-t-emerald-400 border-r-emerald-400 animate-spin" style={{ animationDuration: '0.7s' }} />
              <span key={countdownValue} className="fx-pop-in text-5xl font-black bg-gradient-to-b from-white to-emerald-300 bg-clip-text text-transparent">
                {countdownValue > 0 ? countdownValue : 'GO'}
              </span>
            </div>
            <span className="text-[10px] text-slate-500">Drag to dodge incoming threats</span>
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

function ResultScreen({ summary, onPlayAgain, onShare }) {
  const grade = getGrade(summary.accuracy);
  const gradeColor = grade.grade === 'S+' || grade.grade === 'S' ? '#fbbf24' : '#a78bfa';

  return (
    <div className="absolute inset-0 z-40 flex" style={{ background: 'rgba(5,5,8,0.97)' }}>
      <div className="w-[36%] flex flex-col items-center justify-center gap-1.5 border-r border-white/5" style={{ background: 'radial-gradient(ellipse 260px 200px at 50% 30%, rgba(16,185,129,.08), transparent 70%)' }}>
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
          <button onClick={onPlayAgain} className="flex-1 py-3 rounded-[13px] bg-gradient-to-r from-emerald-600 to-cyan-600 text-white font-bold text-xs uppercase tracking-wide cursor-pointer">
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