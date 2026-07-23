'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  Compass, Volume2, VolumeX, Move,
  Eye, Ban, Zap as ZapIcon, RotateCcw, Share2, ArrowLeft
} from 'lucide-react';
import { calcEndBonuses, calcSessionXP, getGrade, getComboMultiplier } from '../../../../../lib/scoringEngine';
import { saveLeaderboardEntrySync } from '../../../../../lib/leaderboard';
import { lockLandscape, unlockOrientation } from '../../../../../lib/orientation';
import { previewDailyCompletion } from '../../../../../lib/dailyChallenge';
import { getPlayerName } from '../../../../../lib/progressStore';
import { Capacitor } from '@capacitor/core';
import { StatusBar } from '@capacitor/status-bar';
import generateShareCard, { shareScoreCard } from '../../../../../components/ShareScoreCard';
import DrillWrapper from '../../../../../components/DrillWrapper';
import { useDuelMatchStart } from '../../../../../lib/challengeEngine';

// ============================================================
// TUNING
// ============================================================
const TOTAL_TIME = 45;
const OVERDRIVE_MS = 8000;
const MAX_LEVEL = 6;
const MIN_LEVEL = 1;
const COUNTDOWN_TICK_MS = 700;

const DISK_COLORS = [
  'bg-red-500', 'bg-orange-500', 'bg-yellow-400', 'bg-green-500',
  'bg-cyan-400', 'bg-blue-500', 'bg-violet-500', 'bg-pink-500',
];

const disksForLevel = (lvl) => lvl + 2;
const calcParMoves = (disks) => Math.pow(2, disks) - 1;

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

  // 1. Hit / Move sound
  playHit() { this.tone(880, 0.12, 'sine', 0.16, 1760); }

  // 2. Countdown tick sound
  playCountdownTick() { this.tone(440, 0.09, 'sine', 0.12, 440); }

  // 3. "GO" start sound
  playGo() { this.tone(523.25, 0.18, 'triangle', 0.17, 784); }

  // 4. Penalty / Invalid move sound
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
// LOCAL STORAGE
// ============================================================
const STORAGE_KEY = 'skilldrills_hanoi_v3';

const getSavedData = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { bestScore: 0, bestCombo: 0, bestLevel: 1, totalSessions: 0, totalOverdrives: 0, totalPerfectSolves: 0 };
    return { bestScore: 0, bestCombo: 0, bestLevel: 1, totalSessions: 0, totalOverdrives: 0, totalPerfectSolves: 0, ...JSON.parse(raw) };
  } catch (e) {
    return { bestScore: 0, bestCombo: 0, bestLevel: 1, totalSessions: 0, totalOverdrives: 0, totalPerfectSolves: 0 };
  }
};
const saveData = (data) => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (e) {} };

// ============================================================
// MAIN COMPONENT
// ============================================================
export default function TowerOfHanoiClient() {
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
  const [timeRemaining, setTimeRemaining] = useState(totalTime);
  const [dangerLevel, setDangerLevel] = useState(0);

  const [towers, setTowers] = useState([[3, 2, 1], [], []]);
  const [selectedTower, setSelectedTower] = useState(null);
  const [moves, setMoves] = useState(0);
  const [parMoves, setParMoves] = useState(7);

  const [flashes, setFlashes] = useState([]);
  const [bursts, setBursts] = useState([]);
  const [shakeCls, setShakeCls] = useState('');
  const [endSummary, setEndSummary] = useState(null);

  const mountedRef = useRef(false);
  const containerRef = useRef(null);
  const gameActiveRef = useRef(false);

  const scoreRef = useRef(0);
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

  const movesRef = useRef(0);
  const parMovesRef = useRef(7);
  const sessionMovesRef = useRef(0);
  const parMovesSumRef = useRef(0);
  const movesSumRef = useRef(0);
  const perfectSolvesRef = useRef(0);

  const shakeToggleRef = useRef(0);
  const clickCooldownRef = useRef(false);
  const heartbeatTempoRef = useRef(1100);

  const gameTimerRef = useRef(null);
  const heartbeatTimerRef = useRef(null);
  const overdriveTimeoutRef = useRef(null);
  const countdownTimerRef = useRef(null);
  const advanceTimerRef = useRef(null);

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
      [overdriveTimeoutRef, countdownTimerRef, advanceTimerRef, heartbeatTimerRef].forEach((r) => { if (r.current) clearTimeout(r.current); });
      if (gameTimerRef.current) clearInterval(gameTimerRef.current);
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

  const triggerShake = useCallback((intensity) => {
    shakeToggleRef.current = shakeToggleRef.current === 0 ? 1 : 0;
    setShakeCls(`fx-shake-${intensity}-${shakeToggleRef.current === 0 ? 'a' : 'b'}`);
  }, []);

  const spawnBurst = useCallback((x, y, color) => {
    const id = Date.now() + Math.random();
    setBursts((b) => [...b, { id, x, y, color }]);
    setTimeout(() => { if (mountedRef.current) setBursts((b) => b.filter((p) => p.id !== id)); }, 520);
  }, []);

  const activateOverdrive = useCallback(() => {
    overdriveActiveRef.current = true;
    overdriveMeterRef.current = 0;
    overdriveCountRef.current += 1;
    triggerFlash('gold');
    if (overdriveTimeoutRef.current) clearTimeout(overdriveTimeoutRef.current);
    overdriveTimeoutRef.current = setTimeout(() => { overdriveActiveRef.current = false; }, OVERDRIVE_MS);
  }, [triggerFlash]);

  const fillOverdrive = useCallback((amt) => {
    if (overdriveActiveRef.current) return;
    overdriveMeterRef.current = Math.min(100, overdriveMeterRef.current + amt);
    if (overdriveMeterRef.current >= 100) activateOverdrive();
  }, [activateOverdrive]);

  const initializeLevel = useCallback((lvl) => {
    const disks = disksForLevel(lvl);
    const nt = [[], [], []];
    for (let i = disks; i > 0; i--) nt[0].push(i);
    setTowers(nt);
    setSelectedTower(null);
    movesRef.current = 0;
    setMoves(0);
    parMovesRef.current = calcParMoves(disks);
    setParMoves(parMovesRef.current);
  }, []);

  const advanceLevel = useCallback(() => {
    if (levelRef.current < MAX_LEVEL) {
      levelRef.current += 1;
      bestLevelRunRef.current = Math.max(bestLevelRunRef.current, levelRef.current);
      setLevel(levelRef.current);
    }
    initializeLevel(levelRef.current);
  }, [initializeLevel]);

  const endGameRef = useRef(null);

  const endGame = useCallback(async (reason) => {
    if (!gameActiveRef.current) return;
    gameActiveRef.current = false;

    [overdriveTimeoutRef, advanceTimerRef, heartbeatTimerRef].forEach((r) => { if (r.current) { clearTimeout(r.current); r.current = null; } });
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
      livesRemaining: null,
      maxLives: null,
      category: 'cognitive',
    });
    const finalScore = bonuses.finalScore;

    const prevSaved = getSavedData();
    const isNewBest = finalScore > prevSaved.bestScore;
    const firstPlay = prevSaved.totalSessions === 0;
    const daily = isChallenge
      ? { isDailyDrill: false, wouldCompleteSet: false }
      : await previewDailyCompletion('tower-of-hanoi');
    const xpResult = calcSessionXP({ finalScore, accuracy, isNewBest, firstPlay, dailyChallenge: daily.isDailyDrill, dailyChallengeSetComplete: daily.wouldCompleteSet });

    const updated = {
      bestScore: Math.max(prevSaved.bestScore, finalScore),
      bestCombo: Math.max(prevSaved.bestCombo, bestComboRef.current),
      bestLevel: Math.max(prevSaved.bestLevel, bestLevelRunRef.current),
      totalSessions: prevSaved.totalSessions + 1,
      totalOverdrives: (prevSaved.totalOverdrives || 0) + overdriveCountRef.current,
      totalPerfectSolves: (prevSaved.totalPerfectSolves || 0) + perfectSolvesRef.current,
    };
    saveData(updated);
    setBestScore(updated.bestScore);
    setBestCombo(updated.bestCombo);
    setBestLevel(updated.bestLevel);

    saveLeaderboardEntrySync({
      drillId: 'tower-of-hanoi',
      drillName: 'Tower of Hanoi',
      category: 'cognitive',
      score: finalScore,
      accuracy,
      bestCombo: bestComboRef.current,
    });

    setEndSummary({
      score: finalScore,
      accuracy,
      bestCombo: bestComboRef.current,
      isNewBest,
      xpEarned: xpResult.xp,
    });
    setPhase('ended');
  }, [triggerFlash]);

  useEffect(() => { endGameRef.current = endGame; }, [endGame]);

  // Completion-only score calculation
  const resolveLevelComplete = useCallback(() => {
    const lvl = levelRef.current;
    const currentMoves = movesRef.current;
    const par = parMovesRef.current;
    const perfect = currentMoves === par;

    // Base score per tower completion scaled by level/disks
    const basePoints = 120 * lvl;
    // Move efficiency penalty (ratio of par moves to actual moves, max 1.0)
    const efficiencyRatio = Math.min(1.0, par / Math.max(1, currentMoves));
    const efficiencyPoints = Math.round(basePoints * efficiencyRatio);

    // Perfect solve bonus
    const perfectBonus = perfect ? 150 : 0;
    // Time remaining bonus
    const timeBonus = Math.round(timeRemainingRef.current * 4);

    // Combo (consecutive clears with no invalid move in between) was being
    // tracked and displayed but never actually paid out — wire it into the
    // shared multiplier curve like every other drill does. No separate
    // level multiplier here: basePoints already scales 120x per level
    // directly, far beyond the engine's usual +50% max, so stacking the
    // engine's levelMultiplier on top would double-reward level.
    const comboMultiplier = getComboMultiplier(comboRef.current);
    let totalTowerScore = Math.round((efficiencyPoints + perfectBonus + timeBonus) * comboMultiplier);
    if (overdriveActiveRef.current) totalTowerScore = Math.round(totalTowerScore * 1.75);

    scoreRef.current += totalTowerScore;
    comboRef.current += 1;
    bestComboRef.current = Math.max(bestComboRef.current, comboRef.current);

    parMovesSumRef.current += par;
    movesSumRef.current += currentMoves;
    if (perfect) perfectSolvesRef.current += 1;

    setScore(scoreRef.current);
    setCombo(comboRef.current);

    audioSynth?.playHit();
    triggerFlash(perfect ? 'gold' : 'cyan');

    timeRemainingRef.current = totalTime;
    setTimeRemaining(totalTime);

    if (advanceTimerRef.current) clearTimeout(advanceTimerRef.current);
    advanceTimerRef.current = setTimeout(() => { if (gameActiveRef.current) advanceLevel(); }, 1100);
  }, [advanceLevel, triggerFlash, totalTime]);

  // Valid move: NO score awarded for individual moves to prevent back-and-forth farming
  const resolveValidMove = useCallback((clearedTowers) => {
    sessionMovesRef.current += 1;
    correctActionsRef.current += 1;
    totalActionsRef.current += 1;

    fillOverdrive(8);

    audioSynth?.playHit();

    if (clearedTowers[2].length === disksForLevel(levelRef.current)) {
      resolveLevelComplete();
    }
  }, [fillOverdrive, resolveLevelComplete]);

  const resolveInvalidMove = useCallback(() => {
    comboRef.current = 0;
    mistakesRef.current += 1;
    totalActionsRef.current += 1;

    // Solo has zero score reduction on a mistake by design (combo reset is
    // the only cost) — but a duel has no lives, so it needs its own real
    // stake per ARENA_INTEGRATION.md rule 4: -5 score, floored at 0.
    if (isChallenge) {
      scoreRef.current = Math.max(0, scoreRef.current - 5);
      setScore(scoreRef.current);
    }

    triggerShake('hard');
    triggerFlash('red');
    audioSynth?.playPenalty();

    setCombo(0);
  }, [triggerShake, triggerFlash, isChallenge]);

  const handleTowerClick = useCallback((towerIndex, e) => {
    if (e) {
      e.stopPropagation();
      e.preventDefault();
      if (e.target.setPointerCapture && e.pointerId != null) {
        try { e.target.setPointerCapture(e.pointerId); } catch (err) {}
      }
    }
    if (!gameActiveRef.current) return;
    if (clickCooldownRef.current) return;
    clickCooldownRef.current = true;
    setTimeout(() => { clickCooldownRef.current = false; }, 50);

    if (selectedTower === null) {
      if (towers[towerIndex].length > 0) {
        setSelectedTower(towerIndex);
        audioSynth?.playHit();
      }
      return;
    }

    const ft = selectedTower;
    const tt = towerIndex;
    if (ft === tt) { setSelectedTower(null); return; }

    const fd = towers[ft][towers[ft].length - 1];
    const td = towers[tt][towers[tt].length - 1];

    if (fd && (!td || fd < td)) {
      const nt = towers.map((t) => [...t]);
      nt[tt].push(nt[ft].pop());
      setTowers(nt);
      movesRef.current += 1;
      setMoves(movesRef.current);
      setSelectedTower(null);
      spawnBurst((tt + 0.5) * (100 / 3), 60, 'cyan');
      resolveValidMove(nt);
    } else {
      setSelectedTower(null);
      resolveInvalidMove();
    }
  }, [selectedTower, towers, resolveValidMove, resolveInvalidMove, spawnBurst]);

  const scheduleHeartbeat = useCallback(() => {
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

  const beginPlaying = useCallback(() => {
    if (!mountedRef.current) return;
    gameActiveRef.current = true;
    setPhase('playing');

    gameTimerRef.current = setInterval(() => {
      if (!gameActiveRef.current) { clearInterval(gameTimerRef.current); return; }
      timeRemainingRef.current -= 0.2;
      if (timeRemainingRef.current <= 0) {
        timeRemainingRef.current = 0;
        setTimeRemaining(0);
        endGameRef.current?.('time');
      } else {
        setTimeRemaining(timeRemainingRef.current);
      }
    }, 200);
    scheduleHeartbeat();
  }, [scheduleHeartbeat]);

  const runCountdown = useCallback((n) => {
    if (countdownTimerRef.current) clearTimeout(countdownTimerRef.current);
    if (!mountedRef.current) return;
    setPhase('countdown');
    if (n <= 0) {
      setCountdownValue('GO');
      if (!isChallenge) audioSynth?.playGo();
      countdownTimerRef.current = setTimeout(() => beginPlaying(), 350);
      return;
    }
    setCountdownValue(n);
    if (!isChallenge) audioSynth?.playCountdownTick();
    countdownTimerRef.current = setTimeout(() => runCountdown(n - 1), COUNTDOWN_TICK_MS);
  }, [beginPlaying, isChallenge]);

  const enterDrill = useCallback(async () => {
    try { audioSynth?.init(); } catch (e) {}

    gameActiveRef.current = false;
    [overdriveTimeoutRef, countdownTimerRef, advanceTimerRef, heartbeatTimerRef].forEach((r) => { if (r.current) { clearTimeout(r.current); r.current = null; } });
    if (gameTimerRef.current) { clearInterval(gameTimerRef.current); gameTimerRef.current = null; }

    // Duels always start every player at the same, lowest difficulty — no
    // personal-best seeding — so scores are pure skill (ARENA_INTEGRATION.md
    // rule 5 / matchmaking fairness).
    const startLevel = isChallenge ? MIN_LEVEL : Math.max(1, Math.min(MAX_LEVEL, Math.round((bestLevel || 1) * 0.55)));

    scoreRef.current = 0; comboRef.current = 0; bestComboRef.current = 0;
    levelRef.current = startLevel; bestLevelRunRef.current = startLevel; mistakesRef.current = 0; correctActionsRef.current = 0; totalActionsRef.current = 0;
    overdriveMeterRef.current = 0; overdriveActiveRef.current = false; overdriveCountRef.current = 0;
    timeRemainingRef.current = totalTime;
    sessionMovesRef.current = 0; parMovesSumRef.current = 0; movesSumRef.current = 0; perfectSolvesRef.current = 0;

    setScore(0); setCombo(0); setLevel(startLevel); setTimeRemaining(totalTime);
    setDangerLevel(0); setEndSummary(null); setFlashes([]); setBursts([]);
    setCountdownValue(3);

    initializeLevel(startLevel);

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
        runCountdown(isChallenge ? 0 : 3);
      }
    }, 350);
  }, [runCountdown, isChallenge, initializeLevel, bestLevel, totalTime]);

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

  // Duel auto-start — both clients begin at the exact same wall-clock
  // instant via the shared matchStartAt timestamp (ARENA_INTEGRATION.md rule 2).
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

  // Rematch reuses this same route with only ?challengeId= changing — reset
  // all per-match state so the previous match doesn't leak into the new one.
  const prevChallengeIdRef = useRef(challengeId);
  useEffect(() => {
    if (challengeId === prevChallengeIdRef.current) return;
    prevChallengeIdRef.current = challengeId;
    duelAutoStartedRef.current = false;
    setPhase('start');
    setScore(0);
    setEndSummary(null);
    setTimeRemaining(totalTime);
  }, [challengeId, totalTime]);

  const shareResult = useCallback(async () => {
    if (!endSummary) return;
    const url = 'https://skilldrills.online/drills/cognitive/problem-solving/tower-of-hanoi';

    try {
      const grade = getGrade(endSummary.accuracy);
      const canvas = generateShareCard({
        score: endSummary.score,
        bestScore,
        accuracy: endSummary.accuracy,
        bestCombo: endSummary.bestCombo,
        rating: { letter: grade.grade, label: grade.label, emoji: grade.emoji },
        newBest: endSummary.isNewBest,
        drillName: 'Tower of Hanoi',
        playerName: getPlayerName(),
      });
      await shareScoreCard(url, canvas);
    } catch (e) {
      const text = `Scored ${endSummary.score} pts on Tower of Hanoi (${endSummary.accuracy}% accuracy, ${endSummary.bestCombo}x combo) — SkillDrills`;
      if (typeof navigator !== 'undefined' && navigator.share) {
        navigator.share({ title: 'Tower of Hanoi — SkillDrills', text, url }).catch(() => {});
      } else if (typeof navigator !== 'undefined' && navigator.clipboard) {
        navigator.clipboard.writeText(`${text} ${url}`);
      }
    }
  }, [endSummary, bestScore]);

  const getDiskWidth = useCallback((ds, md) => {
    const mw = 132, miw = 36;
    return `${miw + ((ds - 1) / Math.max(1, md - 1)) * (mw - miw)}px`;
  }, []);

  if (loading || !isClient) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-[#050508]">
        <div className="text-center">
          <div className="w-14 h-14 border-4 border-violet-600 border-t-transparent rounded-full animate-spin mx-auto mb-4 shadow-[0_0_20px_rgba(139,92,246,0.5)]" />
          <p className="text-slate-500 font-bold tracking-widest uppercase text-[10px] animate-pulse">Loading Towers...</p>
        </div>
      </div>
    );
  }

  const timePct = Math.max(0, Math.min(100, (timeRemaining / totalTime) * 100));
  const diskCount = disksForLevel(level);
  const showBoard = phase === 'playing' || phase === 'countdown';

  return (
    <DrillWrapper
      drillName="Tower of Hanoi"
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
        className={`absolute inset-0 select-none overflow-hidden bg-[#050508] text-white ${shakeCls}`}
        style={{ touchAction: gameActiveRef.current ? 'none' : 'auto', WebkitTapHighlightColor: 'transparent' }}
      >
        <div className="absolute inset-0 pointer-events-none" style={{ backgroundImage: 'linear-gradient(rgba(255,255,255,0.015) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.015) 1px, transparent 1px)', backgroundSize: '40px 40px' }} />

        {phase === 'playing' && dangerLevel > 0.06 && (
          <div className="fx-vignette" style={{ '--v-min': Math.max(0.05, dangerLevel * 0.25), '--v-max': Math.min(0.55, dangerLevel * 0.75), animationDuration: `${heartbeatTempoRef.current}ms` }} />
        )}

        {phase === 'rotate-hint' && !isChallenge && (
          <div className="absolute inset-0 z-[100] flex flex-col items-center justify-center bg-black/95 text-center p-6">
            <div className="animate-bounce mb-5 text-blue-500"><RotateCcw className="w-12 h-12 mx-auto" /></div>
            <p className="text-sm font-bold text-white">Rotate your phone to play</p>
            <p className="text-xs text-slate-500 mt-1.5 max-w-[220px] mx-auto">Please rotate your device to landscape mode for the optimal playing experience.</p>
          </div>
        )}

        {flashes.map((f) => (
          <div key={f.id} className={`fx-flash ${f.variant === 'gold' ? 'fx-flash-gold' : f.variant === 'cyan' ? 'fx-flash-cyan' : 'fx-flash-red'}`} />
        ))}

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
            <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(ellipse 420px 260px at 50% 8%, rgba(142,97,246,.16), transparent 70%)' }} />
            <div className="relative w-full max-w-[290px] rounded-[20px] border border-white/5 bg-[#0c0c16]/90 backdrop-blur-lg px-5 pt-5 pb-[18px] text-center shadow-[0_16px_40px_rgba(0,0,0,.5)] my-6">
              <div className="w-11 h-11 mx-auto rounded-[14px] bg-gradient-to-br from-violet-600 to-indigo-600 flex items-center justify-center mb-3 shadow-[0_0_22px_rgba(139,92,246,.35)]">
                <Compass className="w-[22px] h-[22px] text-white" />
              </div>
              <h1 className="text-[17px] font-bold tracking-tight">Tower of Hanoi</h1>

              <div className="flex flex-col gap-1.5 text-left mt-3.5">
                <HowToRow icon={<Eye className="w-3.5 h-3.5 text-cyan-400 flex-shrink-0" />} node={<>Tap a peg to lift disk, tap another to place it</>} />
                <HowToRow icon={<ZapIcon className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" />} node={<>Disk count increases as you solve each level</>} />
                <HowToRow icon={<Ban className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />} node={<>Never place a larger disk on a smaller disk</>} />
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
          </div>
        )}

        {/* ── PLAYING / COUNTDOWN BOARD ── */}
        {showBoard && (
          <>
            <div className="absolute top-0 left-0 right-0 h-1.5 bg-neutral-950 z-[60] pointer-events-none">
              <div className={`h-full transition-all duration-100 ease-linear ${timeRemaining <= 10 ? 'bg-red-500 animate-pulse' : 'bg-violet-500'}`} style={{ width: `${timePct}%` }} />
            </div>

            <div className="absolute top-5 left-5 z-40 flex flex-col pointer-events-none select-none">
              <span className="text-2xl font-black text-white leading-none tabular-nums">{score}</span>
              <div className="flex items-center gap-2 mt-1.5">
                <span className="text-[10px] font-black text-violet-300 bg-violet-500/10 border border-violet-500/20 px-1.5 py-0.5 rounded font-mono">{diskCount} Disks</span>
              </div>
            </div>

            {/* Timer — top-right corner */}
            <div className="absolute top-5 right-5 z-40 flex flex-col items-end pointer-events-none select-none">
              <span className={`text-3xl font-black font-mono leading-none tabular-nums ${timeRemaining <= 10 ? 'text-red-500 animate-pulse' : 'text-slate-300'}`}>
                {Math.ceil(timeRemaining)}s
              </span>
              <span className="text-[8px] text-slate-500 font-bold uppercase tracking-widest mt-1">Time Left</span>
            </div>

            {/* Moves counter — top-center */}
            <div className="absolute top-5 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 bg-black/50 border border-white/10 rounded-full px-3.5 py-1.5 pointer-events-none">
              <Move className="w-3.5 h-3.5 text-violet-300" />
              <span className="text-[11px] font-black font-mono text-slate-200">{moves}<span className="text-slate-500">/{parMoves} par</span></span>
            </div>

            <div className="relative w-full h-full flex flex-col items-center justify-center px-4 pt-20 pb-16">
              {bursts.map((b) => (
                <div key={b.id} className="fx-pop" style={{ left: `${b.x}%`, top: `${b.y}%`, width: 40, height: 40, marginLeft: -20, marginTop: -20, background: b.color === 'red' ? 'rgba(239,68,68,.5)' : 'rgba(34,211,238,.5)' }} />
              ))}

              <div className="flex w-full justify-around items-end px-2 mt-4">
                {[0, 1, 2].map((ti) => (
                  <button
                    key={ti}
                    onPointerDown={(e) => handleTowerClick(ti, e)}
                    className={`flex flex-col items-center transition-all duration-100 touch-none rounded-2xl p-2 w-[30%] ${selectedTower === ti ? 'bg-violet-500/10 ring-2 ring-violet-400/50 scale-105' : 'active:bg-white/5'}`}
                    aria-label={`Peg ${ti + 1}`}
                  >
                    <div className="relative flex flex-col items-center w-full" style={{ minHeight: `${diskCount * 30}px` }}>
                      <div
                        className="absolute bottom-0 left-1/2 -translate-x-1/2 w-3 rounded-t-full z-0"
                        style={{ height: `${diskCount * 30 + 26}px`, background: 'linear-gradient(135deg, #3a3a46 0%, #1c1c24 100%)' }}
                      />
                      <div className="flex flex-col-reverse items-center relative z-10 w-full" style={{ minHeight: `${diskCount * 30}px` }}>
                        {towers[ti].map((disk, di) => (
                          <div
                            key={di}
                            className={`${DISK_COLORS[(disk - 1) % DISK_COLORS.length]} rounded-lg mb-[3px] transition-all duration-300 shadow-[0_3px_8px_rgba(0,0,0,0.5)] border border-white/20 flex items-center justify-center`}
                            style={{ width: getDiskWidth(disk, diskCount), height: '22px' }}
                          >
                            <div className="w-2/3 h-[3px] bg-white/30 rounded-full" />
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="w-[112%] h-3 rounded-full mt-1 border border-white/10" style={{ background: 'linear-gradient(135deg, #2c2c36 0%, #111116 100%)' }} />
                    <div className={`mt-3 text-[9px] font-black tracking-widest uppercase ${selectedTower === ti ? 'text-violet-400' : 'text-slate-600'}`}>Peg {ti + 1}</div>
                  </button>
                ))}
              </div>

            </div>
          </>
        )}

        {/* ── COUNTDOWN SCREEN ── */}
        {phase === 'countdown' && !isChallenge && (
          <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/60 backdrop-blur-[2px]">
            <span className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-400">Get Ready</span>
            <div className="relative w-28 h-28 rounded-full border-[3px] border-violet-500/20 flex items-center justify-center">
              <div className="absolute -inset-[3px] rounded-full border-[3px] border-transparent border-t-violet-400 border-r-violet-400 animate-spin" style={{ animationDuration: '0.7s' }} />
              <span key={countdownValue} className="fx-pop-in text-5xl font-black bg-gradient-to-b from-white to-violet-300 bg-clip-text text-transparent">
                {countdownValue}
              </span>
            </div>
            <span className="text-[10px] text-slate-500">{disksForLevel(MIN_LEVEL)} disks — first tower loads at GO</span>
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
          <button onClick={onPlayAgain} className="flex-1 py-3 rounded-[13px] bg-gradient-to-r from-violet-600 to-indigo-600 text-white font-bold text-xs uppercase tracking-wide cursor-pointer">
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