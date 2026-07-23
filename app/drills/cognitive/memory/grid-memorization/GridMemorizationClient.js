'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { 
  Compass, Volume2, VolumeX, Eye, Zap, Ban,
  Share2, ArrowLeft, Heart
} from 'lucide-react';
import { scoreAction, calcEndBonuses, calcSessionXP, getGrade } from '../../../../../lib/scoringEngine';
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
const BASE_GRID_SIZE = 5;
const GRID_STEP_UP_THRESHOLD = 12;
const EXPANDED_GRID_SIZE = 6;
const MAX_LIT_CELLS = 20;
const MIN_LIT_CELLS = 5;
const MAX_LEVEL = 15;
const STORAGE_KEY = 'skilldrills_grid_memorization_v1';

function sizeForLitCells(litCells) {
  return litCells > GRID_STEP_UP_THRESHOLD ? EXPANDED_GRID_SIZE : BASE_GRID_SIZE;
}

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

// ============================================================
// STORAGE HELPERS
// ============================================================
const getSavedData = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
    const sScore = localStorage.getItem('skilldrills_grid_best_score_v2');
    const sStreak = localStorage.getItem('skilldrills_grid_best_streak_v2');
    return {
      bestScore: sScore ? parseInt(sScore, 10) || 0 : 0,
      bestCombo: sStreak ? parseInt(sStreak, 10) || 0 : 0,
      bestLevel: 1,
      totalSessions: 0
    };
  } catch (e) {
    return { bestScore: 0, bestCombo: 0, bestLevel: 1, totalSessions: 0 };
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
export default function GridMemorizationClient() {
  const searchParams = useSearchParams();
  const challengeId = searchParams ? searchParams.get('challengeId') : null;
  const isChallenge = !!challengeId;
  const totalTime = isChallenge ? 30 : TOTAL_TIME;

  const [loading, setLoading] = useState(true);
  const [isClient, setIsClient] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);

  // === Game State ===
  const [gameState, setGameState] = useState('start'); // 'start' | 'countdown' | 'playing' | 'ended'
  const [score, setScore] = useState(0);
  const [combo, setCombo] = useState(0);
  const [bestScore, setBestScore] = useState(0);
  const [bestCombo, setBestCombo] = useState(0);
  const [bestLevel, setBestLevel] = useState(1);
  const [level, setLevel] = useState(1);

  const [localTimeRemaining, setLocalTimeRemaining] = useState(totalTime);
  const [accuracy, setAccuracy] = useState(100);
  const [lives, setLives] = useState(MAX_LIVES);
  const [countdownVal, setCountdownVal] = useState(null);
  const [dangerLevel, setDangerLevel] = useState(0);
  const [wrongCellIndex, setWrongCellIndex] = useState(null);

  // === Grid State ===
  const [gridSize, setGridSize] = useState(BASE_GRID_SIZE);
  const [litCells, setLitCells] = useState(MIN_LIT_CELLS);
  const [cellStates, setCellStates] = useState([]);
  const [phase, setPhase] = useState("ready"); // "ready", "memorize", "recall", "result"
  const [memorizeTime, setMemorizeTime] = useState(2.0);
  const [userSelections, setUserSelections] = useState(new Set());
  const [isProcessing, setIsProcessing] = useState(false);
  const [flashes, setFlashes] = useState([]);
  const [endSummary, setEndSummary] = useState(null);

  // === Decoupled Engine Refs ===
  const mountedRef = useRef(false);
  const gameActiveRef = useRef(false);

  const gameStateRef = useRef('start');
  const phaseRef = useRef('ready');
  const scoreRef = useRef(0);
  const timeRef = useRef(totalTime);
  const streakRef = useRef(0);
  const bestStreakRef = useRef(0);
  const livesRef = useRef(MAX_LIVES);
  const levelRef = useRef(1);
  const bestLevelRunRef = useRef(1);

  const gridSizeRef = useRef(5);
  const litCellsRef = useRef(5);
  const correctPatternRef = useRef(new Set());
  const userSelectionsRef = useRef(new Set());

  const globalTimerIntervalRef = useRef(null);
  const memorizeTimerIntervalRef = useRef(null);
  const countdownTimerRef = useRef(null);
  const overdriveTimeoutRef = useRef(null);
  const heartbeatTimerRef = useRef(null);

  const totalCorrectClicksRef = useRef(0);
  const totalAttemptsRef = useRef(0);
  const lastTapTimeRef = useRef(0);
  const heartbeatTempoRef = useRef(1100);

  useEffect(() => {
    if (audioSynth) audioSynth.setEnabled(soundEnabled);
  }, [soundEnabled]);

  const clearTimers = useCallback(() => {
    if (globalTimerIntervalRef.current) clearInterval(globalTimerIntervalRef.current);
    if (memorizeTimerIntervalRef.current) clearInterval(memorizeTimerIntervalRef.current);
    if (countdownTimerRef.current) clearTimeout(countdownTimerRef.current);
    if (overdriveTimeoutRef.current) clearTimeout(overdriveTimeoutRef.current);
    if (heartbeatTimerRef.current) clearTimeout(heartbeatTimerRef.current);
  }, []);

  const triggerFlash = useCallback((variant) => {
    const id = Date.now() + Math.random();
    setFlashes(prev => [...prev, { id, variant }]);
    setTimeout(() => {
      if (mountedRef.current) setFlashes(prev => prev.filter(f => f.id !== id));
    }, 150);
  }, []);

  const endGame = useCallback(async () => {
    gameActiveRef.current = false;
    clearTimers();
    setGameState('ended');
    gameStateRef.current = 'ended';

    audioSynth?.playResultsReveal();

    const finalScore = scoreRef.current;
    const finalAccuracy = totalAttemptsRef.current > 0 
      ? Math.round((totalCorrectClicksRef.current / totalAttemptsRef.current) * 100)
      : 100;

    const bonuses = calcEndBonuses({
      rawScore: finalScore,
      accuracy: finalAccuracy,
      bestCombo: bestStreakRef.current,
      totalActions: totalCorrectClicksRef.current,
      mistakes: totalAttemptsRef.current - totalCorrectClicksRef.current,
      livesRemaining: Math.max(0, livesRef.current),
      maxLives: MAX_LIVES,
      category: 'cognitive',
    });

    const finalTotalScore = bonuses.finalScore;
    const saved = getSavedData();
    const isNew = finalTotalScore > saved.bestScore;

    const updated = {
      bestScore: Math.max(saved.bestScore, finalTotalScore),
      bestCombo: Math.max(saved.bestCombo, bestStreakRef.current),
      bestLevel: Math.max(saved.bestLevel || 1, bestLevelRunRef.current),
      totalSessions: (saved.totalSessions || 0) + 1,
    };
    saveData(updated);

    setBestScore(updated.bestScore);
    setBestCombo(updated.bestCombo);
    setBestLevel(updated.bestLevel);

    const daily = isChallenge
      ? { isDailyDrill: false, wouldCompleteSet: false }
      : await previewDailyCompletion('grid-memorization');

    const xpResult = calcSessionXP({
      finalScore: finalTotalScore,
      accuracy: finalAccuracy,
      isNewBest: isNew,
      firstPlay: saved.totalSessions === 0,
      dailyChallenge: daily.isDailyDrill,
      dailyChallengeSetComplete: daily.wouldCompleteSet,
    });

    saveLeaderboardEntrySync({
      drillId: 'grid-memorization',
      drillName: 'Grid Memorization',
      category: 'cognitive',
      score: finalTotalScore,
      accuracy: finalAccuracy,
      bestCombo: bestStreakRef.current,
    });

    setEndSummary({
      score: finalTotalScore,
      accuracy: finalAccuracy,
      bestCombo: bestStreakRef.current,
      xpEarned: xpResult.xp,
      isNewBest: isNew,
    });

    if (Capacitor.isNativePlatform()) StatusBar.show().catch(() => {});
  }, [clearTimers]);

  const generatePattern = useCallback((size, litCount) => {
    const totalCells = size * size;
    const pattern = new Set();
    while (pattern.size < litCount) {
      pattern.add(Math.floor(Math.random() * totalCells));
    }
    return pattern;
  }, []);

  const startRecall = useCallback(() => {
    if (memorizeTimerIntervalRef.current) clearInterval(memorizeTimerIntervalRef.current);
    setPhase("recall");
    phaseRef.current = "recall";
    setUserSelections(new Set());
    userSelectionsRef.current = new Set();
    lastTapTimeRef.current = Date.now();
  }, []);

  const generateRound = useCallback((size, litCount) => {
    const pattern = generatePattern(size, litCount);
    correctPatternRef.current = pattern;
    
    const states = Array(size * size).fill(false);
    pattern.forEach(idx => { states[idx] = true; });
    
    setCellStates(states);
    gridSizeRef.current = size;
    setGridSize(size);
    setLitCells(litCount);
    litCellsRef.current = litCount;

    const memDuration = Math.max(0.6, 2.0 - (litCount - MIN_LIT_CELLS) * 0.1);
    setMemorizeTime(memDuration);
    setPhase("memorize");
    phaseRef.current = "memorize";
    setIsProcessing(false);
    setUserSelections(new Set());
    userSelectionsRef.current = new Set();
    setWrongCellIndex(null);

    const memStart = Date.now();

    if (memorizeTimerIntervalRef.current) clearInterval(memorizeTimerIntervalRef.current);
    memorizeTimerIntervalRef.current = setInterval(() => {
      const elapsed = (Date.now() - memStart) / 1000;
      const remaining = Math.max(0, memDuration - elapsed);
      setMemorizeTime(remaining);

      if (remaining <= 0) {
        clearInterval(memorizeTimerIntervalRef.current);
        startRecall();
      }
    }, 100);

  }, [generatePattern, startRecall]);

  const advanceRound = useCallback(() => {
    const nextLitCells = Math.min(MAX_LIT_CELLS, litCellsRef.current + 1);
    levelRef.current = Math.min(MAX_LEVEL, nextLitCells - MIN_LIT_CELLS + 1);
    bestLevelRunRef.current = Math.max(bestLevelRunRef.current, levelRef.current);
    setLevel(levelRef.current);
    generateRound(sizeForLitCells(nextLitCells), nextLitCells);
  }, [generateRound]);

  const toggleCell = useCallback((index, e) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }

    if (phaseRef.current !== "recall" || isProcessing) return;
    if (userSelectionsRef.current.has(index)) return;
    
    const correctPattern = correctPatternRef.current;
    
    // WRONG CELL CLICKED
    if (!correctPattern.has(index)) {
      setIsProcessing(true);
      audioSynth?.playPenalty();

      // Arena has no lives — mistakes cost score instead, and a duel always
      // runs the full shared time (ARENA_INTEGRATION.md rules 3 & 4).
      if (isChallenge) {
        scoreRef.current = Math.max(0, scoreRef.current - 5);
        setScore(scoreRef.current);
      } else {
        livesRef.current = Math.max(0, livesRef.current - 1);
        setLives(livesRef.current);
      }

      totalAttemptsRef.current += 1;
      streakRef.current = 0;
      setCombo(0);

      setWrongCellIndex(index);

      triggerFlash('red');

      setPhase("result");
      phaseRef.current = "result";

      if ((!isChallenge && livesRef.current <= 0) || timeRef.current <= 0) {
        endGame();
      } else {
        setTimeout(() => {
          if (gameActiveRef.current) {
            generateRound(sizeForLitCells(litCellsRef.current), litCellsRef.current);
          }
        }, 800);
      }
      return;
    }
    
    // VALID CELL SELECTION
    const newSelections = new Set(userSelectionsRef.current);
    newSelections.add(index);
    
    userSelectionsRef.current = newSelections;
    setUserSelections(newSelections);
    audioSynth?.playHit();
    
    const reactionMs = Date.now() - lastTapTimeRef.current;
    lastTapTimeRef.current = Date.now();
    const scoreResult = scoreAction({
      category: 'cognitive',
      combo: streakRef.current,
      reactionMs,
      timeRemaining: timeRef.current,
      totalGameTime: totalTime,
      livesRemaining: livesRef.current,
      maxLives: MAX_LIVES,
      level: litCellsRef.current,
      maxLevel: MAX_LIT_CELLS
    });

    let pointsEarned = scoreResult.total;

    scoreRef.current += pointsEarned;
    setScore(scoreRef.current);

    totalCorrectClicksRef.current += 1;
    totalAttemptsRef.current += 1;
    
    // CHECK GRID COMPLETION
    if (newSelections.size === correctPattern.size) {
      setIsProcessing(true);
      
      const P = litCellsRef.current;
      const scaleFactor = P / 5;
      const clearBonus = Math.round(30 * scaleFactor);
      
      scoreRef.current += clearBonus;
      setScore(scoreRef.current);
      
      streakRef.current += 1;
      setCombo(streakRef.current);
      if (streakRef.current > bestStreakRef.current) {
        bestStreakRef.current = streakRef.current;
        setBestCombo(streakRef.current);
      }
      
      setPhase("result");
      phaseRef.current = "result";

      setTimeout(() => {
        if (gameActiveRef.current) advanceRound();
      }, 500);
    }
  }, [isProcessing, endGame, generateRound, advanceRound, triggerFlash, isChallenge, totalTime]);

  const scheduleHeartbeat = useCallback(() => {
    if (isChallenge) return;
    if (!gameActiveRef.current) return;
    const dangerFromLives = (MAX_LIVES - livesRef.current) / MAX_LIVES;
    const dangerFromTime = timeRef.current <= 10 ? (10 - timeRef.current) / 10 : 0;
    const danger = Math.max(dangerFromLives * 0.7, dangerFromTime);
    const tempo = Math.round(1100 - danger * 650);
    heartbeatTempoRef.current = tempo;
    if (danger > 0.08) audioSynth?.playHeartbeat(danger);
    if (mountedRef.current) setDangerLevel(danger);
    heartbeatTimerRef.current = setTimeout(scheduleHeartbeat, tempo);
  }, [isChallenge]);

  const runCountdown = useCallback((n, callback) => {
    setGameState('countdown');
    gameStateRef.current = 'countdown';
    if (countdownTimerRef.current) clearTimeout(countdownTimerRef.current);
    
    if (n === 0) {
      if (!isChallenge) audioSynth?.playGo();
      setCountdownVal('GO');
      countdownTimerRef.current = setTimeout(() => {
        setCountdownVal(null);
        setGameState('playing');
        gameStateRef.current = 'playing';
        gameActiveRef.current = true;
        callback();
      }, 350);
      return;
    }

    if (!isChallenge) audioSynth?.playCountdownTick();
    setCountdownVal(n);
    countdownTimerRef.current = setTimeout(() => runCountdown(n - 1, callback), 700);
  }, [isChallenge]);

  const startGame = useCallback(() => {
    audioSynth?.init(); 
    clearTimers();

    const saved = getSavedData();
    // Duels always start every player at the same, lowest difficulty — no
    // personal-best seeding — so scores are pure skill (ARENA_INTEGRATION.md
    // rule 5 / matchmaking fairness).
    const startLevel = isChallenge ? 1 : Math.max(1, Math.min(MAX_LEVEL, Math.round((saved.bestLevel || 1) * 0.55)));
    const startLitCells = MIN_LIT_CELLS + (startLevel - 1);

    scoreRef.current = 0;
    setScore(0);
    timeRef.current = totalTime;
    setLocalTimeRemaining(totalTime);
    streakRef.current = 0;
    bestStreakRef.current = 0;
    setCombo(0);
    livesRef.current = MAX_LIVES;
    setLives(MAX_LIVES);
    levelRef.current = startLevel;
    bestLevelRunRef.current = startLevel;
    setLevel(startLevel);
    setDangerLevel(0);
    setWrongCellIndex(null);
    setFlashes([]);

    totalCorrectClicksRef.current = 0;
    totalAttemptsRef.current = 0;
    setAccuracy(100);

    lockPortrait().catch(() => {});
    if (Capacitor.isNativePlatform()) {
      StatusBar.hide().catch(() => {});
    }

    runCountdown(isChallenge ? 0 : 3, () => {
      let lastTick = Date.now();

      globalTimerIntervalRef.current = setInterval(() => {
        if (!gameActiveRef.current) return;
        const now = Date.now();
        const deltaMs = now - lastTick;
        lastTick = now;

        const nextTime = Math.max(0, timeRef.current - (deltaMs / 1000));
        timeRef.current = nextTime;
        setLocalTimeRemaining(nextTime);

        if (nextTime <= 0) {
          endGame();
        }
      }, 200);

      scheduleHeartbeat();
      generateRound(sizeForLitCells(startLitCells), startLitCells);
    });
  }, [clearTimers, runCountdown, generateRound, endGame, scheduleHeartbeat, isChallenge, totalTime]);

  const shareDrillLink = useCallback(async () => {
    if (!endSummary) return;
    const url = 'https://skilldrills.online/drills/cognitive/memory/grid-memorization';
    try {
      const grade = getGrade(endSummary.accuracy);
      const canvas = generateShareCard({
        score: endSummary.score,
        bestScore,
        accuracy: endSummary.accuracy,
        bestCombo: endSummary.bestCombo,
        rating: { letter: grade.grade, label: grade.label, emoji: grade.emoji },
        newBest: endSummary.isNewBest,
        drillName: 'Grid Memorization',
        playerName: getPlayerName(),
      });
      await shareScoreCard(url, canvas);
    } catch (e) {
      const text = `Scored ${endSummary.score} on Grid Memorization (${endSummary.accuracy}% accuracy, ${endSummary.bestCombo}x combo) — SkillDrills`;
      if (typeof navigator !== 'undefined' && navigator.share) {
        navigator.share({ title: 'Grid Memorization — SkillDrills', text, url }).catch(() => {});
      } else if (typeof navigator !== 'undefined' && navigator.clipboard) {
        navigator.clipboard.writeText(`${text} ${url}`);
      }
    }
  }, [endSummary, bestScore]);

  // Hide floating close/rotate controls during play
  useEffect(() => {
    if (typeof window !== 'undefined') {
      if (gameState === 'playing' || gameState === 'countdown') {
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
  }, [gameState]);

  useEffect(() => {
    setIsClient(true);
    mountedRef.current = true;
    
    const saved = getSavedData();
    setBestScore(saved.bestScore || 0);
    setBestCombo(saved.bestCombo || 0);
    setBestLevel(saved.bestLevel || 1);

    setTimeout(() => {
      if (mountedRef.current) setLoading(false);
    }, 200);

    return () => {
      mountedRef.current = false;
      gameActiveRef.current = false;
      clearTimers();
      unlockOrientation();
      if (Capacitor.isNativePlatform()) StatusBar.show().catch(() => {});
    };
  }, [clearTimers]);

  // Duel auto-start — both clients begin at the exact same wall-clock
  // instant via the shared matchStartAt timestamp (ARENA_INTEGRATION.md rule 2).
  const matchStartAt = useDuelMatchStart(challengeId);
  const duelAutoStartedRef = useRef(false);
  useEffect(() => {
    if (!isChallenge || !matchStartAt || gameState !== 'start' || duelAutoStartedRef.current) return;
    const delay = Math.max(0, matchStartAt - Date.now());
    const t = setTimeout(() => {
      duelAutoStartedRef.current = true;
      startGame();
    }, delay);
    return () => clearTimeout(t);
  }, [isChallenge, matchStartAt, gameState, startGame]);

  // Rematch reuses this same route with only ?challengeId= changing — reset
  // all per-match state so the previous match doesn't leak into the new one.
  const prevChallengeIdRef = useRef(challengeId);
  useEffect(() => {
    if (challengeId === prevChallengeIdRef.current) return;
    prevChallengeIdRef.current = challengeId;
    duelAutoStartedRef.current = false;
    setGameState('start');
    gameStateRef.current = 'start';
    setScore(0);
    setLives(MAX_LIVES);
    setEndSummary(null);
    setLocalTimeRemaining(totalTime);
  }, [challengeId, totalTime]);

  if (loading || !isClient) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#050508]">
        <div className="text-center">
          <div className="w-14 h-14 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin mx-auto mb-4 shadow-[0_0_20px_rgba(99,102,241,0.5)]"></div>
          <p className="text-slate-500 font-bold tracking-widest uppercase text-[10px] animate-pulse">Loading Engine...</p>
        </div>
      </div>
    );
  }

  const timePct = Math.max(0, Math.min(100, (localTimeRemaining / totalTime) * 100));

  return (
    <DrillWrapper
      drillName="Grid Memorization"
      category="cognitive"
      score={score}
      timeLeft={gameState === 'ended' ? 0 : Math.ceil(localTimeRemaining)}
      soundEnabled={soundEnabled}
      onSoundToggle={() => setSoundEnabled(v => { audioSynth?.setEnabled(!v); return !v; })}
      backHref="/drills/cognitive"
      minimalChrome
    >
      <div
        onContextMenu={(e) => { if (gameState === 'playing') e.preventDefault(); }}
        className="absolute inset-0 select-none overflow-hidden bg-[#050508] text-white"
        style={{ 
          touchAction: gameState === 'playing' ? 'none' : 'auto', 
          WebkitTapHighlightColor: 'transparent' 
        }}
      >
        <style>{`
          @keyframes flash-red {
            0% { background-color: rgba(239, 68, 68, 0.25); }
            100% { background-color: transparent; }
          }
          .fx-flash {
            position: absolute;
            inset: 0;
            pointer-events: none;
            z-index: 55;
            animation-duration: 0.15s;
            animation-timing-function: ease-out;
            animation-fill-mode: forwards;
          }
          .fx-flash-red { animation-name: flash-red; }
        `}</style>

        {gameState === 'playing' && dangerLevel > 0.06 && (
          <div className="fx-vignette" style={{ '--v-min': Math.max(0.05, dangerLevel * 0.25), '--v-max': Math.min(0.55, dangerLevel * 0.75), animationDuration: `${heartbeatTempoRef.current}ms` }} />
        )}

        <div className="absolute inset-0 pointer-events-none" style={{ backgroundImage: 'linear-gradient(rgba(255,255,255,0.015) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.015) 1px, transparent 1px)', backgroundSize: '40px 40px' }} />

        {flashes.map((f) => (
          <div key={f.id} className={`fx-flash ${f.variant === 'red' ? 'fx-flash-red' : ''}`} />
        ))}

        {(gameState === 'countdown' || gameState === 'playing') && (
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); setSoundEnabled((v) => { audioSynth?.setEnabled(!v); return !v; }); }}
            className="absolute bottom-5 right-5 z-40 p-2 rounded-full bg-black/60 border border-white/10 text-slate-400 active:scale-90 transition-transform cursor-pointer"
          >
            {soundEnabled ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
          </button>
        )}

        {/* ── START SCREEN ── */}
        {gameState === 'start' && !isChallenge && (
          <div className="relative h-full flex items-center justify-center p-5 overflow-y-auto z-40">
            <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(ellipse 420px 260px at 50% 8%, rgba(99,102,241,.16), transparent 70%)' }} />
            <div className="relative w-full max-w-[290px] rounded-[20px] border border-white/5 bg-[#0c0c16]/90 backdrop-blur-lg px-5 pt-5 pb-[18px] text-center shadow-[0_16px_40px_rgba(0,0,0,.5)] my-6">
              <div className="w-11 h-11 mx-auto rounded-[14px] bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center mb-3 shadow-[0_0_22px_rgba(99,102,241,.35)]">
                <Compass className="w-[22px] h-[22px] text-white" />
              </div>
              <h1 className="text-[17px] font-bold tracking-tight text-white">Grid Memorization</h1>

              <div className="flex flex-col gap-1.5 text-left mt-3.5">
                <HowToRow icon={<Eye className="w-3.5 h-3.5 text-cyan-400 flex-shrink-0" />} node={<>Memorize the highlighted cell pattern before it disappears</>} />
                <HowToRow icon={<Zap className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" />} node={<>Grid size and target count scale as you complete rounds</>} />
                <HowToRow icon={<Ban className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />} node={<>5 lives — wrong clicks cost points, combo, and a life</>} />
              </div>

              <div className="grid grid-cols-3 gap-1.5 mt-3.5">
                <MiniStat label="Best" value={bestScore} color="text-yellow-400" />
                <MiniStat label="Combo" value={`${bestCombo}x`} color="text-orange-400" />
                <MiniStat label="Level" value={`Lv.${bestLevel}`} color="text-indigo-400" />
              </div>

              <button
                onClick={startGame}
                className="w-full mt-3.5 py-[11px] rounded-[13px] bg-gradient-to-r from-indigo-600 to-purple-600 font-bold text-[12.5px] tracking-wide active:scale-[0.97] transition-transform shadow-[0_0_20px_rgba(99,102,241,.3)] cursor-pointer text-white"
              >
                START
              </button>
            </div>
          </div>
        )}

        {/* ── COUNTDOWN SCREEN ── */}
        {gameState === 'countdown' && !isChallenge && (
          <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/55 backdrop-blur-[2px]">
            <span className="text-[11px] font-black uppercase tracking-[0.2em] text-slate-400">Get Ready</span>
            <div className="relative w-28 h-28 rounded-full border-[3px] border-indigo-500/20 flex items-center justify-center">
              <div className="absolute -inset-[3px] rounded-full border-[3px] border-transparent border-t-indigo-400 border-r-indigo-400 animate-spin" style={{ animationDuration: '0.7s' }} />
              <span key={countdownVal} className="fx-pop-in text-5xl font-black bg-gradient-to-b from-white to-indigo-300 bg-clip-text text-transparent">
                {countdownVal}
              </span>
            </div>
            <span className="text-[10px] text-slate-500">Pattern generates at GO</span>
          </div>
        )}

        {/* ── PLAYING ── */}
        {gameState === 'playing' && (
          <>
            <div className="absolute top-0 left-0 right-0 h-1.5 bg-neutral-950 z-[60] pointer-events-none">
              <div 
                className={`h-full transition-all duration-100 ease-linear ${localTimeRemaining <= 10 ? 'bg-red-500 animate-pulse' : 'bg-indigo-500'}`} 
                style={{ width: `${timePct}%` }}
              />
            </div>

            <div className="absolute top-5 left-5 z-40 flex flex-col pointer-events-none select-none">
              <span className="text-2xl font-black text-white leading-none tabular-nums">{score}</span>
              <div className="flex items-center gap-2 mt-1.5">
                {isChallenge ? (
                  <span className="text-[10px] font-black text-indigo-300 bg-indigo-500/15 border border-indigo-500/25 px-1.5 py-0.5 rounded">
                    Lv.{level} ({litCells} Targets)
                  </span>
                ) : (
                  <span className="flex items-center gap-0.5">
                    {Array.from({ length: MAX_LIVES }).map((_, i) => (
                      <Heart key={i} className={`w-3 h-3 ${i < lives ? 'fill-red-500 text-red-500' : 'text-white/15'}`} />
                    ))}
                  </span>
                )}
              </div>
            </div>

            {/* Timer overlay at top-right */}
            <div className="absolute top-5 right-5 z-40 flex flex-col items-end pointer-events-none select-none">
              <span className={`text-3xl font-black font-mono leading-none tabular-nums ${localTimeRemaining <= 10 ? 'text-red-500 animate-pulse' : 'text-slate-300'}`}>
                {Math.ceil(localTimeRemaining)}s
              </span>
              <span className="text-[8px] text-slate-500 font-bold uppercase tracking-widest mt-1">Time Left</span>
            </div>

            {/* GAMEPLAY CANVAS */}
            <div className="w-full h-full flex flex-col items-center justify-center p-4 z-10">
              
              {phase === "recall" && (
                <div className="flex gap-1.5 mb-4 justify-center w-full max-w-[280px] flex-wrap">
                  {Array.from({ length: litCells }).map((_, i) => (
                    <div 
                      key={i} 
                      className={`w-2 h-2 rounded-full transition-all duration-300 ${i < userSelections.size ? 'bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.8)] scale-110' : 'bg-neutral-800'}`} 
                    />
                  ))}
                </div>
              )}

              {(phase === "memorize" || phase === "result") && (
                <div className="h-6 mb-4" />
              )}

              {/* Memory Grid */}
              <div 
                className="grid mx-auto gap-1.5"
                style={{ 
                  gridTemplateColumns: `repeat(${gridSize}, 1fr)`,
                  width: 'min(82vw, 42vh)',
                  aspectRatio: '1/1'
                }}
              >
                {cellStates.map((isLit, i) => {
                  let cellStyle = "bg-neutral-900/60 border border-white/[0.03]";
                  
                  if (phase === "memorize") {
                    if (isLit) cellStyle = "bg-indigo-500 shadow-[0_0_12px_rgba(99,102,241,0.5)] border-indigo-400 scale-[0.98]";
                  } 
                  else if (phase === "recall") {
                    if (userSelections.has(i)) cellStyle = "bg-cyan-500 shadow-[0_0_12px_rgba(6,182,212,0.5)] border-cyan-400 scale-[0.96]";
                    else cellStyle = "bg-neutral-900/80 border border-white/[0.04] active:scale-95 active:bg-neutral-800 transition-all pointer-events-auto cursor-pointer";
                  } 
                  else if (phase === "result") {
                    if (isLit) cellStyle = "bg-green-500 shadow-[0_0_12px_rgba(34,197,94,0.5)] border-green-400 scale-[0.98]";
                    else if (i === wrongCellIndex) cellStyle = "bg-red-500 shadow-[0_0_12px_rgba(239,68,68,0.6)] border-red-400 scale-[0.98]";
                  }

                  return (
                    <button
                      key={i}
                      onPointerDown={(e) => toggleCell(i, e)}
                      disabled={phase !== "recall" || isProcessing}
                      className={`w-full h-full rounded-xl transition-all duration-150 ease-out focus:outline-none touch-none ${cellStyle}`}
                      aria-label="Memory Cell"
                    />
                  );
                })}
              </div>

            </div>
          </>
        )}

        {/* ── RESULT SCREEN ── */}
        {gameState === 'ended' && endSummary && !isChallenge && (
          <ResultScreen summary={endSummary} onPlayAgain={startGame} onShare={shareDrillLink} />
        )}
      </div>
    </DrillWrapper>
  );
}

// === Subcomponents ===

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
          <button onClick={onPlayAgain} className="flex-1 py-3 rounded-[13px] bg-gradient-to-r from-indigo-600 to-purple-600 text-white font-bold text-xs uppercase tracking-wide cursor-pointer">
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