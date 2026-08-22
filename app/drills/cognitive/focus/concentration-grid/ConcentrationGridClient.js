'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { 
  Compass, Volume2, VolumeX, Eye, Zap, Ban,
  Share2, ArrowLeft, Heart
} from 'lucide-react';
import { scoreAction, calcEndBonuses, calcSessionXP, getGrade, getComboMultiplier } from '../../../../../lib/scoringEngine';
import { saveLeaderboardEntrySync } from '../../../../../lib/leaderboard';
import { lockPortrait, unlockOrientation } from '../../../../../lib/orientation';
import { previewDailyCompletion } from '../../../../../lib/dailyChallenge';
import { getPlayerName } from '../../../../../lib/progressStore';
import generateShareCard, { shareScoreCard } from '../../../../../components/ShareScoreCard';
import { Capacitor } from '@capacitor/core';
import { StatusBar } from '@capacitor/status-bar';
import DrillWrapper from '../../../../../components/DrillWrapper';
import { useDuelMatchStart } from '../../../../../lib/challengeEngine';

// ============================================================
// TUNING CONSTANTS
// ============================================================
const TOTAL_TIME = 45.0;
const MAX_LIVES = 5;
const STORAGE_KEY = 'skilldrills_concentration_grid_v1';

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
      try {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      } catch (e) {}
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
  }

  tone(freq, dur, type = 'sine', vol = 0.15, sweepTo = null) {
    if (!this.enabled || !this.ctx) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    try {
      const osc = this.ctx.createOscillator();
      const gainNode = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
      if (sweepTo) {
        osc.frequency.exponentialRampToValueAtTime(sweepTo, this.ctx.currentTime + dur);
      }
      gainNode.gain.setValueAtTime(vol, this.ctx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + dur);
      osc.connect(gainNode);
      gainNode.connect(this.ctx.destination);
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
        const gainNode = this.ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, t0 + delay);
        gainNode.gain.setValueAtTime(0, t0 + delay);
        gainNode.gain.linearRampToValueAtTime(0.12, t0 + delay + 0.01);
        gainNode.gain.exponentialRampToValueAtTime(0.001, t0 + delay + 0.08);
        osc.connect(gainNode);
        gainNode.connect(this.ctx.destination);
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
        const gainNode = this.ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(65, t0 + offset);
        gainNode.gain.setValueAtTime(vol, t0 + offset);
        gainNode.gain.exponentialRampToValueAtTime(0.001, t0 + offset + 0.15);
        osc.connect(gainNode);
        gainNode.connect(this.ctx.destination);
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
    const gainNode = this.ctx.createGain();
    gainNode.gain.setValueAtTime(0.0001, t0);
    gainNode.gain.linearRampToValueAtTime(vol, t0 + 0.015);
    gainNode.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    filter.connect(gainNode);
    gainNode.connect(this.ctx.destination);
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

  setEnabled(status) {
    this.enabled = status;
  }
}

const audioSynth = typeof window !== 'undefined' ? new AudioSynthesizer() : null;

// ==========================================
// STORAGE CONFIG
// ==========================================
const getSavedData = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);

    const legacyBest = localStorage.getItem('skilldrills_concentration_bestScore_v3');
    const bestScore = legacyBest ? parseInt(legacyBest, 10) : 0;
    const bestGrid = bestScore > 0 ? 4 : 3;
    const bestCombo = bestScore > 0 ? 10 : 0;
    
    const initial = {
      bestScore,
      bestGrid,
      bestCombo,
      totalSessions: legacyBest ? 1 : 0
    };
    saveData(initial);
    return initial;
  } catch (e) {
    return { bestScore: 0, bestGrid: 3, bestCombo: 0, totalSessions: 0 };
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
export default function ConcentrationGridClient() {
  const searchParams = useSearchParams();
  const challengeId = searchParams ? searchParams.get('challengeId') : null;
  const isChallenge = !!challengeId;
  const totalTime = isChallenge ? 30 : TOTAL_TIME;
  const matchStartAt = useDuelMatchStart(challengeId);
  const duelAutoStartedRef = useRef(false);

  // === Phase Machine State ===
  const [phase, setPhase] = useState('start'); // 'start' | 'countdown' | 'playing' | 'ended'
  const [countdownValue, setCountdownValue] = useState(3);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [isClient, setIsClient] = useState(false);

  // === Dynamic Gameplay / Grid States ===
  const [gridSize, setGridSize] = useState(3);
  const [gridData, setGridData] = useState([]);
  // No separate "found cells" state: the board derives it from currentNumber,
  // since this drill is strictly sequential (see GridBoard).
  const [currentNumber, setCurrentNumber] = useState(1);
  
  // HUD variables
  const [score, setScore] = useState(0);
  const [combo, setCombo] = useState(0);
  const [timeRemaining, setTimeRemaining] = useState(totalTime);
  const [lives, setLives] = useState(MAX_LIVES);
  const [dangerLevel, setDangerLevel] = useState(0);

  // === Best stats ===
  const [bestScore, setBestScore] = useState(0);
  const [bestGrid, setBestGrid] = useState(3);
  const [bestCombo, setBestCombo] = useState(0);

  // === Result Summary & Feedback ===
  const [endSummary, setEndSummary] = useState(null);
  const [flashes, setFlashes] = useState([]);

  // === Engine Refs ===
  const containerRef = useRef(null);
  const clockTimerRef = useRef(null);
  const gameActiveRef = useRef(false);
  const mountedRef = useRef(false);

  const countdownTimerRef = useRef(null);
  const heartbeatTimerRef = useRef(null);
  const heartbeatTempoRef = useRef(1100);

  const scoreRef = useRef(0);
  const timeLeftRef = useRef(totalTime);
  const comboRef = useRef(0);
  const livesRef = useRef(MAX_LIVES);
  const maxStreakRef = useRef(0);
  const gridSizeRef = useRef(3);
  const startGridRef = useRef(3);
  const currentNumberRef = useRef(1);
  
  const foundNumbersSetRef = useRef(new Set());
  const correctClicksRef = useRef(0);
  const totalClicksRef = useRef(0);
  const penaltyCountRef = useRef(0);
  
  const lastTapTimeRef = useRef(0);
  const flashIdRef = useRef(0);
  
  const phaseRef = useRef('start');

  useEffect(() => {
    setIsClient(true);
    mountedRef.current = true;
    const data = getSavedData();
    setBestScore(data.bestScore);
    setBestGrid(data.bestGrid);
    setBestCombo(data.bestCombo);
    const timer = setTimeout(() => setLoading(false), 150);
    return () => {
      clearTimeout(timer);
      mountedRef.current = false;
      gameActiveRef.current = false;
      if (countdownTimerRef.current) clearTimeout(countdownTimerRef.current);
      if (heartbeatTimerRef.current) clearTimeout(heartbeatTimerRef.current);
      if (clockTimerRef.current) clearInterval(clockTimerRef.current);
      unlockOrientation();
    };
  }, []);

  useEffect(() => { if (audioSynth) audioSynth.setEnabled(soundEnabled); }, [soundEnabled]);

  const triggerFlash = (variant) => {
    flashIdRef.current += 1;
    const id = `${Date.now()}-${flashIdRef.current}`;
    setFlashes(prev => [...prev, { id, variant }]);
    setTimeout(() => {
      if (mountedRef.current) setFlashes(prev => prev.filter(f => f.id !== id));
    }, 150);
  };

  const syncGridDataToState = useCallback(() => {
    setCurrentNumber(currentNumberRef.current);
  }, []);

  const getMaxGridCeiling = () => {
    if (typeof window !== 'undefined' && window.innerWidth < 380) {
      return 7;
    }
    return 8;
  };

  const generateNewGrid = useCallback((size) => {
    const totalCells = size * size;
    const numbers = Array.from({ length: totalCells }, (_, i) => i + 1);

    for (let i = numbers.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [numbers[i], numbers[j]] = [numbers[j], numbers[i]];
    }

    const cells = numbers.map(num => {
      let rotation = 0;
      if (size === 5 || size === 6) {
        rotation = Math.floor(Math.random() * 24) - 12;
      } else if (size >= 7) {
        rotation = Math.floor(Math.random() * 40) - 20;
      }
      return { num, rotation };
    });

    setGridData(cells);
    setGridSize(size);
    gridSizeRef.current = size;
    currentNumberRef.current = 1;
    foundNumbersSetRef.current.clear();
    correctClicksRef.current = 0;
    totalClicksRef.current = 0;
    penaltyCountRef.current = 0;
    lastTapTimeRef.current = performance.now();

    syncGridDataToState();
  }, [syncGridDataToState]);

  const endGame = useCallback(async () => {
    if (phaseRef.current === 'ended') return;
    phaseRef.current = 'ended';
    setPhase('ended');
    gameActiveRef.current = false;

    if (clockTimerRef.current) { clearInterval(clockTimerRef.current); clockTimerRef.current = null; }
    if (heartbeatTimerRef.current) clearTimeout(heartbeatTimerRef.current);

    // Flush the authoritative score to state before the wrapper reads it —
    // during a duel DrillWrapper submits the `score` prop the moment the
    // clock hits 0, so anything scored since the last 200ms tick would
    // otherwise be dropped from the submitted result.
    setScore(scoreRef.current);

    audioSynth?.playResultsReveal();

    const totalClicks = correctClicksRef.current + penaltyCountRef.current;
    const accuracyVal = totalClicks > 0 ? Math.round((correctClicksRef.current / totalClicks) * 100) : 100;

    const bonuses = calcEndBonuses({
      rawScore: scoreRef.current,
      accuracy: accuracyVal,
      bestCombo: maxStreakRef.current,
      totalActions: totalClicks,
      mistakes: penaltyCountRef.current,
      livesRemaining: Math.max(0, livesRef.current),
      maxLives: MAX_LIVES,
      category: 'cognitive'
    });

    const finalScore = bonuses.finalScore;

    const prev = getSavedData();
    const isNewBest = finalScore > prev.bestScore;
    const firstPlay = prev.totalSessions === 0;

    const daily = isChallenge
      ? { isDailyDrill: false, wouldCompleteSet: false }
      : await previewDailyCompletion('concentration-grid');

    const xpResult = calcSessionXP({
      finalScore,
      accuracy: accuracyVal,
      isNewBest,
      firstPlay,
      dailyChallenge: daily.isDailyDrill,
      dailyChallengeSetComplete: daily.wouldCompleteSet
    });

    const updated = {
      bestScore: Math.max(prev.bestScore, finalScore),
      bestGrid: Math.max(prev.bestGrid, gridSizeRef.current),
      bestCombo: Math.max(prev.bestCombo, maxStreakRef.current),
      totalSessions: prev.totalSessions + 1
    };
    saveData(updated);

    setBestScore(updated.bestScore);
    setBestGrid(updated.bestGrid);
    setBestCombo(updated.bestCombo);

    saveLeaderboardEntrySync({
      drillId: 'concentration-grid',
      drillName: 'Concentration Grid',
      category: 'cognitive',
      score: finalScore,
      accuracy: accuracyVal,
      bestCombo: maxStreakRef.current
    });

    setEndSummary({
      score: finalScore,
      accuracy: accuracyVal,
      peakGrid: gridSizeRef.current,
      bestCombo: maxStreakRef.current,
      xpEarned: xpResult.xp,
      isNewBest,
    });
  }, []);

  const handleCellClick = (num, e) => {
    e.stopPropagation();
    e.preventDefault();

    if (phaseRef.current !== 'playing' || timeLeftRef.current <= 0) return;
    if (foundNumbersSetRef.current.has(num)) return;

    totalClicksRef.current += 1;

    if (num === currentNumberRef.current) {
      audioSynth?.playHit();
      correctClicksRef.current += 1;
      foundNumbersSetRef.current.add(num);
      currentNumberRef.current += 1;
      comboRef.current += 1;
      setCombo(comboRef.current);
      if (comboRef.current > maxStreakRef.current) {
        maxStreakRef.current = comboRef.current;
      }
      const tapTime = performance.now();
      const reactionTimeMs = lastTapTimeRef.current ? (tapTime - lastTapTimeRef.current) : 1000;
      lastTapTimeRef.current = tapTime;

      let pointsObj = { total: 6 };
      try {
        pointsObj = scoreAction({
          category: 'cognitive',
          reactionMs: reactionTimeMs,
          combo: comboRef.current,
          livesRemaining: livesRef.current,
          maxLives: MAX_LIVES,
          timeRemaining: timeLeftRef.current,
          totalGameTime: totalTime,
          level: gridSizeRef.current - 2,
          maxLevel: getMaxGridCeiling() - 2
        });
      } catch (err) {
        const base = 6;
        const comboMult = getComboMultiplier(comboRef.current);
        const speedBonus = reactionTimeMs < 1200 ? Math.round(base * (1200 - reactionTimeMs) / 1200) : 0;
        pointsObj = { total: Math.round((base + speedBonus) * comboMult) };
      }

      let pointsToAdd = pointsObj.total;
      scoreRef.current += pointsToAdd;

      const totalCells = gridSizeRef.current * gridSizeRef.current;

      // GRID CLEAR COMPLETION -> RESET TIMER TO 45s
      if (foundNumbersSetRef.current.size === totalCells) {
        triggerFlash('cyan');

        const scaleFactor = totalCells / 9;
        const clearBonus = Math.round(20 * scaleFactor);
        scoreRef.current += clearBonus;

        // Solo only: clearing a board refills the clock, so a good run keeps
        // going. A duel must NOT do this — both duelists share one fixed 30s
        // (ARENA_INTEGRATION.md rule 1), and refilling desynced the two
        // clocks completely: whoever cleared boards kept extending their own
        // match while the opponent's 30s expired and left them stuck on
        // "Waiting for opponent to finish..." for the rest of it.
        if (!isChallenge) {
          timeLeftRef.current = totalTime;
          setTimeRemaining(totalTime);
        }

        const maxCeiling = getMaxGridCeiling();
        if (gridSizeRef.current < maxCeiling) {
          gridSizeRef.current += 1;
        }

        generateNewGrid(gridSizeRef.current);
      } else {
        syncGridDataToState();
      }
      // A tap already re-renders this component (the grid's found/current
      // state changes), so folding the score in here is free and keeps the
      // readout instant rather than waiting up to 200ms for the clock tick.
      setScore(scoreRef.current);
    } else {
      // WRONG CELL CLICKED
      audioSynth?.playPenalty();
      penaltyCountRef.current += 1;
      comboRef.current = 0;
      setCombo(0);

      triggerFlash('red');

      if (isChallenge) {
        scoreRef.current = Math.max(0, scoreRef.current - 5);
        setScore(scoreRef.current);
        syncGridDataToState();
        return;
      }

      livesRef.current = Math.max(0, livesRef.current - 1);
      setLives(livesRef.current);

      if (livesRef.current <= 0) {
        endGame();
      } else {
        syncGridDataToState();
      }
    }
  };

  // handleCellClick is rebuilt on every render (it closes over plenty of
  // state), so handing it to GridBoard directly would break the memo on every
  // clock tick — the exact thing the memo exists to prevent. Pass a stable ref
  // instead and let the board read the current function at tap time.
  const handleCellClickRef = useRef(null);
  handleCellClickRef.current = handleCellClick;

  // Match clock — a 200ms setInterval, not a requestAnimationFrame loop.
  // Nothing in this drill is drawn per frame (the board is plain DOM
  // buttons), so this loop's only job is decrementing the clock and pushing
  // it to React state. Running that at the display refresh rate meant a
  // float `timeRemaining` landed in state ~10x/sec, re-rendering the entire
  // board — up to 64 grid buttons — plus the DrillWrapper subtree, for a
  // readout that only ever shows whole seconds. That made this the single
  // hottest drill in Arena. 200ms is the same cadence every other duel drill
  // already uses, and it wakes the CPU 5x/sec instead of 60.
  useEffect(() => {
    if (phase !== 'playing') return;

    const tick = () => {
      if (!gameActiveRef.current) return;
      timeLeftRef.current = Math.max(0, timeLeftRef.current - 0.2);
      // Flush the authoritative score alongside the clock so DrillWrapper's
      // duel score-sync and final submit always see the latest value.
      setScore(scoreRef.current);
      if (timeLeftRef.current <= 0) {
        setTimeRemaining(0);
        endGame();
        return;
      }
      setTimeRemaining(timeLeftRef.current);
    };

    clockTimerRef.current = setInterval(tick, 200);

    return () => {
      if (clockTimerRef.current) { clearInterval(clockTimerRef.current); clockTimerRef.current = null; }
    };
  }, [phase, endGame]);

  const scheduleHeartbeat = useCallback(() => {
    if (isChallenge) return;
    if (!gameActiveRef.current) return;
    const danger = timeLeftRef.current <= 10 ? (10 - timeLeftRef.current) / 10 : 0;
    // Clamped: an unclamped tempo goes NEGATIVE once danger exceeds ~1.69 (which
    // negative lives can produce), and a setTimeout with a negative delay fires
    // immediately — turning this self-rescheduling callback into a tight loop
    // spawning audio nodes at full CPU. That was the "phone heats up and makes
    // noise" bug already fixed in the other drills; this brings the rest in line.
    const tempo = Math.max(350, Math.round(1100 - danger * 650));
    heartbeatTempoRef.current = tempo;
    if (danger > 0.08) {
      audioSynth?.playHeartbeat(danger);
    }
    setDangerLevel(danger);
    heartbeatTimerRef.current = setTimeout(scheduleHeartbeat, tempo);
  }, [isChallenge]);

  const runCountdown = useCallback((n) => {
    if (countdownTimerRef.current) clearTimeout(countdownTimerRef.current);
    if (n <= 0) {
      if (!isChallenge) audioSynth?.playGo();
      setPhase('playing');
      phaseRef.current = 'playing';
      gameActiveRef.current = true;

      scoreRef.current = 0;
      timeLeftRef.current = totalTime;
      comboRef.current = 0;
      setCombo(0);
      livesRef.current = MAX_LIVES;
      maxStreakRef.current = 0;
      gridSizeRef.current = startGridRef.current;
      currentNumberRef.current = 1;
      foundNumbersSetRef.current.clear();
      correctClicksRef.current = 0;
      totalClicksRef.current = 0;
      penaltyCountRef.current = 0;

      setScore(0);
      setTimeRemaining(totalTime);
      setLives(MAX_LIVES);
      setDangerLevel(0);
      setFlashes([]);

      generateNewGrid(startGridRef.current);
      scheduleHeartbeat();
      return;
    }
    if (!isChallenge) audioSynth?.playCountdownTick();
    setCountdownValue(n);
    countdownTimerRef.current = setTimeout(() => runCountdown(n - 1), 700);
  }, [generateNewGrid, scheduleHeartbeat, totalTime, isChallenge]);

  const enterDrill = useCallback(() => {
    audioSynth?.init();
    lockPortrait();

    gameActiveRef.current = false;
    if (countdownTimerRef.current) clearTimeout(countdownTimerRef.current);
    if (heartbeatTimerRef.current) clearTimeout(heartbeatTimerRef.current);
    if (clockTimerRef.current) { clearInterval(clockTimerRef.current); clockTimerRef.current = null; }

    if (isChallenge) {
      startGridRef.current = 3;
    } else {
      const saved = getSavedData();
      const maxLevel = getMaxGridCeiling() - 2;
      const savedBestLevel = Math.max(1, (saved.bestGrid || 3) - 2);
      const startLevel = Math.max(1, Math.min(maxLevel, Math.round(savedBestLevel * 0.55)));
      startGridRef.current = startLevel + 2;
    }

    setScore(0);
    setCombo(0);
    setTimeRemaining(totalTime);
    setLives(MAX_LIVES);
    setDangerLevel(0);
    setFlashes([]);
    setEndSummary(null);

    setPhase('countdown');
    phaseRef.current = 'countdown';
    runCountdown(isChallenge ? 0 : 3);
  }, [runCountdown, isChallenge, totalTime]);

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
    gameActiveRef.current = false;
    setPhase('start');
    phaseRef.current = 'start';
    setScore(0);
    setCombo(0);
    setLives(MAX_LIVES);
    setEndSummary(null);
    setTimeRemaining(totalTime);
    timeLeftRef.current = totalTime;
  }, [challengeId, totalTime]);

  // Hide floating controls during play
  useEffect(() => {
    if (typeof window !== 'undefined') {
      if (phase === 'playing' || phase === 'countdown') {
        document.body.classList.add('hide-drill-controls');
      } else {
        document.body.classList.remove('hide-drill-controls');
      }
    }
    return () => {
      if (typeof window !== 'undefined') {
        document.body.classList.remove('hide-drill-controls');
      }
    };
  }, [phase]);

  const shareResult = useCallback(() => {
    if (!endSummary) return;
    const text = `Scored ${endSummary.score} on Concentration Grid (${endSummary.accuracy}% accuracy, ${endSummary.bestCombo}x combo) — SkillDrills`;
    const url = 'https://skilldrills.online/drills/cognitive/focus/concentration-grid';
    if (typeof navigator !== 'undefined' && navigator.share) {
      navigator.share({ title: 'Concentration Grid — SkillDrills', text, url }).catch(() => {});
    } else if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(`${text} ${url}`);
    }
  }, [endSummary]);

  if (loading || !isClient) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-[#050508]">
        <div className="text-center">
          <div className="w-14 h-14 border-4 border-cyan-600 border-t-transparent rounded-full animate-spin mx-auto mb-4 shadow-[0_0_20px_rgba(6,182,212,0.5)]" />
          <p className="text-slate-500 font-bold tracking-widest uppercase text-[10px] animate-pulse">Loading Focus Engine...</p>
        </div>
      </div>
    );
  }

  return (
    <DrillWrapper
      drillName="Concentration Grid"
      category="cognitive"
      score={score}
      timeLeft={phase === 'ended' ? 0 : Math.ceil(timeRemaining)}
      lives={isChallenge || phase === 'start' || phase === 'countdown' ? null : lives}
      maxLives={isChallenge ? null : MAX_LIVES}
      soundEnabled={soundEnabled}
      onSoundToggle={() => setSoundEnabled((v) => { audioSynth?.setEnabled(!v); return !v; })}
      backHref="/drills/cognitive"
      minimalChrome
    >
      <div
        ref={containerRef}
        onContextMenu={(e) => { if (phase === 'playing') e.preventDefault(); }}
        className="absolute inset-0 select-none overflow-hidden bg-[#050508] text-white"
        style={{ touchAction: phase === 'playing' ? 'none' : 'auto', WebkitTapHighlightColor: 'transparent' }}
      >
        <div className="absolute inset-0 pointer-events-none" style={{ backgroundImage: 'linear-gradient(rgba(255,255,255,0.015) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.015) 1px, transparent 1px)', backgroundSize: '40px 40px' }} />

        {phase === 'playing' && dangerLevel > 0.06 && (
          <div className="fx-vignette" style={{ '--v-min': Math.max(0.05, dangerLevel * 0.25), '--v-max': Math.min(0.55, dangerLevel * 0.75), animationDuration: `${heartbeatTempoRef.current}ms` }} />
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

        {/* ── START SCREEN ── */}
        {phase === 'start' && !isChallenge && (
          <div className="relative h-full flex items-center justify-center p-5 overflow-y-auto z-40 pointer-events-auto">
            <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(ellipse 420px 260px at 50% 8%, rgba(6,182,212,.16), transparent 70%)' }} />
            <div className="relative w-full max-w-[290px] rounded-[20px] border border-white/5 bg-[#0c0c16]/90 backdrop-blur-lg px-5 pt-5 pb-[18px] text-center shadow-[0_16px_40px_rgba(0,0,0,.5)] my-6">
              <div className="w-11 h-11 mx-auto rounded-[14px] bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center mb-3 shadow-[0_0_22px_rgba(6,182,212,.35)]">
                <Compass className="w-[22px] h-[22px] text-white" />
              </div>
              <h1 className="text-[17px] font-bold tracking-tight text-white">Concentration Grid</h1>
              <p className="text-[9px] font-bold text-slate-500 uppercase tracking-widest mt-1">45s per board</p>

              <div className="flex flex-col gap-1.5 text-left mt-3.5">
                <HowToRow icon={<Eye className="w-3.5 h-3.5 text-cyan-400 flex-shrink-0" />} node={<>Tap the numbers in order from 1</>} />
                <HowToRow icon={<Zap className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" />} node={<>Grid grows with each board</>} />
                <HowToRow icon={<Ban className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />} node={<>Wrong taps cost a life · 3 lives</>} />
              </div>

              <div className="grid grid-cols-3 gap-1.5 mt-3.5">
                <MiniStat label="Best" value={bestScore} color="text-yellow-400" />
                <MiniStat label="Combo" value={`${bestCombo}x`} color="text-orange-400" />
                <MiniStat label="Level" value={`Lv.${bestGrid - 2}`} color="text-cyan-400" />
              </div>

              <button
                onClick={enterDrill}
                className="w-full mt-3.5 py-[11px] rounded-[13px] bg-gradient-to-r from-cyan-600 to-blue-600 font-bold text-[12.5px] tracking-wide active:scale-[0.97] transition-transform shadow-[0_0_20px_rgba(6,182,212,.3)] cursor-pointer text-white"
              >
                START
              </button>
            </div>
          </div>
        )}

        {/* ── PLAYING ── */}
        {(phase === 'playing' || phase === 'countdown') && (
          <>
            <div className="absolute top-5 left-5 z-40 flex flex-col pointer-events-none select-none">
              <span className="text-2xl font-black text-white leading-none tabular-nums">{score}</span>
              <div className="flex items-center gap-2 mt-1.5">
                {/* Duels show no level badge — the play area stays clean, and a
                    rising number tells an opponent nothing useful mid-match. */}
                {!isChallenge && (
                  <span className="flex items-center gap-0.5">
                    {Array.from({ length: MAX_LIVES }).map((_, i) => (
                      <Heart key={i} className={`w-3 h-3 ${i < lives ? 'fill-red-500 text-red-500' : 'text-white/15'}`} />
                    ))}
                  </span>
                )}
              </div>
            </div>

            {/* Timer overlay top-right */}
            <div className="absolute top-5 right-5 z-40 flex flex-col items-end pointer-events-none select-none">
              <span className={`text-3xl font-black font-mono leading-none tabular-nums ${timeRemaining <= 10 ? 'text-red-500 animate-pulse' : 'text-slate-300'}`}>
                {Math.ceil(timeRemaining)}s
              </span>
              <span className="text-[8px] text-slate-500 font-bold uppercase tracking-widest mt-1">Time Left</span>
            </div>

            {/* Target indicator — solid fill instead of backdrop-blur: this
                badge is on-screen for the whole match, and blur compositing
                that runs continuously for the entire drill (unlike the
                start/countdown overlays' one-time blur) is a real CPU cost
                for zero visible difference against this near-opaque fill. */}
            <div className="absolute top-5 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 border border-white/10 rounded-full px-4 py-1.5 pointer-events-none select-none" style={{ background: 'rgba(5,5,8,0.94)' }}>
              <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">Find</span>
              <span className="text-lg font-black text-cyan-400 font-mono leading-none">{currentNumber}</span>
            </div>

            {/* Grid cells area — see GridBoard's own note on why the board is
                a separate memoized component rather than inlined here. */}
            <div className="relative w-full h-[100dvh] flex flex-col items-center justify-center p-4">
              <GridBoard
                gridData={gridData}
                gridSize={gridSize}
                currentNumber={currentNumber}
                disabled={phase === 'countdown'}
                onCellClick={handleCellClickRef}
              />
            </div>
          </>
        )}

        {/* ── COUNTDOWN ── */}
        {phase === 'countdown' && !isChallenge && (
          <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/55 backdrop-blur-[2px]">
            <span className="text-[11px] font-black uppercase tracking-[0.2em] text-slate-400">Get Ready</span>
            <div className="relative w-28 h-28 rounded-full border-[3px] border-cyan-500/20 flex items-center justify-center">
              <div className="absolute -inset-[3px] rounded-full border-[3px] border-transparent border-t-cyan-400 border-r-cyan-400 animate-spin" style={{ animationDuration: '0.7s' }} />
              <span key={countdownValue} className="fx-pop-in text-5xl font-black bg-gradient-to-b from-white to-cyan-300 bg-clip-text text-transparent">
                {countdownValue > 0 ? countdownValue : 'GO'}
              </span>
            </div>
            <span className="text-[10px] text-slate-500">Grid generates at GO</span>
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

// ==========================================
// SUBCOMPONENTS
// ==========================================

// The number board, deliberately split out and memoized.
//
// The match clock pushes a new time into state 5x/sec for the whole match, and
// every one of those renders used to rebuild all of these buttons — up to 64 of
// them at the largest grid size, each with its own transition, shadow and
// rotate transform. That made a drill whose board only changes when you tap
// something one of the most expensive things in Arena. Memoizing on the four
// values that actually affect the board means a clock tick re-renders the HUD
// text and nothing else.
//
// `isFound` is derived from `currentNumber` rather than a list of found cells:
// this drill is strictly sequential (you can only ever tap the next number), so
// the found set is always exactly {1 … currentNumber-1}. That removes a state
// array whose identity changed on every sync, and replaces an `Array.includes`
// scan per cell — O(cells²) per render — with one integer compare.
const GridBoard = React.memo(function GridBoard({ gridData, gridSize, currentNumber, disabled, onCellClick }) {
  const fontSize = `${Math.max(10, Math.min(22, 92 / gridSize))}px`;
  return (
    <div
      className="grid mx-auto max-h-full max-w-full relative transition-all duration-300"
      style={{
        gridTemplateColumns: `repeat(${gridSize}, minmax(0, 1fr))`,
        width: 'min(70vw, 42vh)',
        height: 'min(70vw, 42vh)',
        aspectRatio: '1/1',
        gap: gridSize >= 6 ? '3px' : '6px',
      }}
    >
      {gridData.map((cell) => {
        const isFound = cell.num < currentNumber;
        return (
          <button
            key={cell.num}
            onPointerDown={(e) => onCellClick.current?.(cell.num, e)}
            disabled={isFound || disabled}
            className={`
              w-full h-full rounded-xl font-black transition-all duration-100 flex items-center justify-center touch-none select-none
              ${isFound
                ? 'bg-green-500/20 text-green-500 border border-green-500/30 scale-95 opacity-55 cursor-default shadow-none'
                : 'bg-slate-900 border border-white/15 text-white hover:bg-slate-800 hover:scale-105 active:scale-95 shadow-[0_4px_10px_rgba(0,0,0,0.3)] cursor-pointer'}
            `}
            style={{
              fontSize,
              transform: !isFound ? `rotate(${cell.rotation}deg)` : 'none'
            }}
          >
            {cell.num}
          </button>
        );
      })}
    </div>
  );
});

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
          <button onClick={onPlayAgain} className="flex-1 py-3 rounded-[13px] bg-gradient-to-r from-cyan-600 to-blue-600 text-white font-bold text-xs uppercase tracking-wide cursor-pointer">
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