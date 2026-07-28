'use client';

import { Component, useEffect, useState, useRef, useCallback } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  Compass, Volume2, VolumeX, RotateCcw, Share2, ArrowLeft,
  Eye, Zap as ZapIcon, Ban, Heart, AlertTriangle
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

// ============================================================
// TUNING CONSTANTS
// ============================================================
const TOTAL_TIME = 45.0;
const MAX_LIVES = 5;
const MIN_GRID_SIZE = 4;
const MAX_GRID_SIZE = 7;

// ============================================================
// IRREGULAR JIGSAW REGION GENERATOR (For prime sizes 5 and 7)
// ============================================================
const generateJigsawRegions = (size) => {
  const total = size * size;
  let regions = Array(total).fill(null);
  
  for (let attempt = 0; attempt < 50; attempt++) {
    regions.fill(null);
    let regionCells = Array.from({ length: size }, () => []);
    
    let seeds = [];
    while (seeds.length < size) {
      let r = Math.floor(Math.random() * total);
      if (!seeds.includes(r)) seeds.push(r);
    }
    
    seeds.forEach((seed, rIdx) => {
      regions[seed] = rIdx;
      regionCells[rIdx].push(seed);
    });
    
    let unassigned = total - size;
    let stuck = false;
    
    while (unassigned > 0) {
      let progress = false;
      let regionOrder = Array.from({ length: size }, (_, i) => i).sort(() => Math.random() - 0.5);
      
      for (const rIdx of regionOrder) {
        if (regionCells[rIdx].length >= size) continue;
        
        let adj = [];
        for (const cell of regionCells[rIdx]) {
          const row = Math.floor(cell / size);
          const col = cell % size;
          
          const neighbors = [];
          if (row > 0) neighbors.push((row - 1) * size + col);
          if (row < size - 1) neighbors.push((row + 1) * size + col);
          if (col > 0) neighbors.push(row * size + col - 1);
          if (col < size - 1) neighbors.push(row * size + col + 1);
          
          for (const n of neighbors) {
            if (regions[n] === null && !adj.includes(n)) {
              adj.push(n);
            }
          }
        }
        
        if (adj.length > 0) {
          let chosen = adj[Math.floor(Math.random() * adj.length)];
          regions[chosen] = rIdx;
          regionCells[rIdx].push(chosen);
          unassigned--;
          progress = true;
          break;
        }
      }
      
      if (!progress) {
        stuck = true;
        break;
      }
    }
    
    if (!stuck) {
      return regions;
    }
  }
  
  for (let i = 0; i < total; i++) {
    regions[i] = Math.floor(i / size);
  }
  return regions;
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

  setEnabled(status) {
    this.enabled = status;
  }
}

const audioSynth = typeof window !== 'undefined' ? new AudioSynthesizer() : null;

// ============================================================
// ERROR BOUNDARY
// ============================================================
class GameErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) { return { hasError: true, error }; }
  componentDidCatch(error, errorInfo) { console.error('Game Error:', error, errorInfo); }
  render() {
    if (this.state.hasError) {
      return (
        <div className="absolute inset-0 flex items-center justify-center bg-[#050508] rounded-2xl z-[100] border border-red-500/30">
          <div className="text-center p-6">
            <AlertTriangle className="w-12 h-12 text-red-500 mx-auto mb-4 animate-pulse" />
            <h3 className="text-white text-lg font-bold mb-2">Engine Fault Detected</h3>
            <p className="text-gray-400 text-sm mb-6">The logic solver encountered a fatal error.</p>
            <button onClick={() => { this.setState({ hasError: false }); window.location.reload(); }} className="px-6 py-3 bg-red-600 text-white rounded-xl font-bold hover:bg-red-500 transition-colors shadow-[0_0_20px_rgba(239,68,68,0.3)]">Reboot Engine</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// ============================================================
// MAIN COMPONENT
// ============================================================
export default function SudokuClient() {
  const [loading, setLoading] = useState(true);
  const [isClient, setIsClient] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);

  const [gameState, setGameState] = useState('start'); // 'start', 'countdown', 'playing', 'ended'
  const [score, setScore] = useState(0);
  const [bestScore, setBestScore] = useState(0);
  const [isNewBest, setIsNewBest] = useState(false);
  const [bestStreak, setBestStreak] = useState(0);
  const [xpEarned, setXpEarned] = useState(0);
  const [localTimeRemaining, setLocalTimeRemaining] = useState(TOTAL_TIME);
  const [accuracy, setAccuracy] = useState(100);
  const [lives, setLives] = useState(MAX_LIVES);
  const [countdownVal, setCountdownVal] = useState(null);
  const [overdriveProgress, setOverdriveProgress] = useState(0);
  const [overdriveActive, setOverdriveActive] = useState(false);

  const [gridSize, setGridSize] = useState(MIN_GRID_SIZE);
  const [grid, setGrid] = useState([]);
  const [solution, setSolution] = useState([]);
  const [initialIndices, setInitialIndices] = useState(new Set());
  const [selectedCell, setSelectedCell] = useState(null);
  const [regionsArray, setRegionsArray] = useState(null);
  
  const [shakeCls, setShakeCls] = useState('');
  const [flashes, setFlashes] = useState([]);
  const [stats, setStats] = useState({ roundsCompleted: 0, totalCorrect: 0, totalAttempts: 0 });

  const mountedRef = useRef(false);
  const containerRef = useRef(null);

  const gameStateRef = useRef('start');
  const scoreRef = useRef(0);
  const timeRef = useRef(TOTAL_TIME);
  const livesRef = useRef(MAX_LIVES);
  const streakRef = useRef(0);
  const bestStreakRef = useRef(0);
  const gridSizeRef = useRef(MIN_GRID_SIZE);
  const peakGridSizeRef = useRef(MIN_GRID_SIZE);

  const statsRef = useRef({ roundsCompleted: 0, totalCorrect: 0, totalAttempts: 0 });

  const overdriveProgressRef = useRef(0);
  const overdriveActiveRef = useRef(false);

  const globalTimerIntervalRef = useRef(null);
  const countdownTimerRef = useRef(null);
  const overdriveTimeoutRef = useRef(null);
  const heartbeatTimerRef = useRef(null);
  const heartbeatTempoRef = useRef(1100);

  const lastInputTimeRef = useRef(0);
  const cellWrongAttemptsRef = useRef({});

  // Next round's puzzle, generated ahead of time in the browser's idle time
  // while the player is still solving the current board — keyed by grid
  // size. Solving a jigsaw board (5x5/7x7) is a real backtracking search, and
  // punching unique-solution holes into it calls that same solver again once
  // per candidate cell — at 7x7 that's a noticeably heavy synchronous
  // computation. Running it synchronously the instant a round clears is
  // exactly what produced the "next grid takes a moment, some boxes don't
  // appear instantly" lag: the main thread blocks on the solve before React
  // can paint the new board. Pre-warming one round ahead means that cost is
  // already paid by the time the player clears the board.
  const nextPuzzleCacheRef = useRef({});
  const precomputeTimeoutRef = useRef(null);

  const syncToUI = useCallback(() => {
    setScore(scoreRef.current);
    setStats({ ...statsRef.current });
    setGridSize(gridSizeRef.current);

    if (statsRef.current.totalAttempts > 0) {
      setAccuracy(Math.round((statsRef.current.totalCorrect / statsRef.current.totalAttempts) * 100));
    }
  }, []);

  useEffect(() => {
    if (audioSynth) audioSynth.setEnabled(soundEnabled);
  }, [soundEnabled]);

  const clearTimers = useCallback(() => {
    if (globalTimerIntervalRef.current) clearInterval(globalTimerIntervalRef.current);
    if (countdownTimerRef.current) clearTimeout(countdownTimerRef.current);
    if (overdriveTimeoutRef.current) clearTimeout(overdriveTimeoutRef.current);
    if (heartbeatTimerRef.current) clearTimeout(heartbeatTimerRef.current);
    if (precomputeTimeoutRef.current) clearTimeout(precomputeTimeoutRef.current);
  }, []);

  useEffect(() => {
    setIsClient(true);
    mountedRef.current = true;
    lockPortrait().catch(() => {});

    try {
      const sScore = localStorage.getItem('skilldrills_sudoku_best_score_v3');
      const sStreak = localStorage.getItem('skilldrills_sudoku_best_streak_v3');
      const sPeakGrid = localStorage.getItem('skilldrills_sudoku_peak_grid_v1');
      if (sScore) setBestScore(parseInt(sScore, 10) || 0);
      if (sStreak) {
        const streakParsed = parseInt(sStreak, 10) || 0;
        setBestStreak(streakParsed);
        bestStreakRef.current = streakParsed;
      }
      if (sPeakGrid) {
        peakGridSizeRef.current = Math.max(MIN_GRID_SIZE, parseInt(sPeakGrid, 10) || MIN_GRID_SIZE);
        setGridSize(peakGridSizeRef.current);
      }
    } catch (e) {}

    setTimeout(() => { if (mountedRef.current) setLoading(false); }, 200);

    return () => {
      mountedRef.current = false;
      clearTimers();
      unlockOrientation();
      if (Capacitor.isNativePlatform()) StatusBar.show().catch(() => {});
    };
  }, [clearTimers]);

  const triggerShake = useCallback(() => {
    setShakeCls('animate-shake');
    setTimeout(() => {
      if (mountedRef.current) setShakeCls('');
    }, 300);
  }, []);

  const triggerFlash = useCallback((variant) => {
    const id = Date.now();
    setFlashes(prev => [...prev, { id, variant }]);
    setTimeout(() => {
      if (mountedRef.current) setFlashes(prev => prev.filter(f => f.id !== id));
    }, 150);
  }, []);

  const fillOverdrive = useCallback((amount) => {
    if (overdriveActiveRef.current) return;
    overdriveProgressRef.current = Math.min(100, overdriveProgressRef.current + amount);
    setOverdriveProgress(overdriveProgressRef.current);
    
    if (overdriveProgressRef.current >= 100) {
      overdriveActiveRef.current = true;
      setOverdriveActive(true);
      triggerFlash('gold');
      
      if (overdriveTimeoutRef.current) clearTimeout(overdriveTimeoutRef.current);
      overdriveTimeoutRef.current = setTimeout(() => {
        if (mountedRef.current) {
          overdriveActiveRef.current = false;
          setOverdriveActive(false);
          overdriveProgressRef.current = 0;
          setOverdriveProgress(0);
        }
      }, 5000);
    }
  }, [triggerFlash]);

  const scheduleHeartbeat = useCallback(() => {
    if (gameStateRef.current !== 'playing') return;
    const dangerFromLives = (MAX_LIVES - livesRef.current) / MAX_LIVES;
    const dangerFromTime = timeRef.current <= 10 ? (10.0 - timeRef.current) / 10.0 : 0.0;
    const danger = Math.min(1, Math.max(dangerFromLives * 0.7, dangerFromTime));

    const tempo = Math.max(350, Math.round(1100 - danger * 650));
    heartbeatTempoRef.current = tempo;

    if (danger > 0.08) audioSynth?.playHeartbeat(danger);

    heartbeatTimerRef.current = setTimeout(scheduleHeartbeat, tempo);
  }, []);

  const endGame = useCallback(async () => {
    clearTimers();
    setGameState('ended');
    gameStateRef.current = 'ended';
    audioSynth?.playResultsReveal();
    if (Capacitor.isNativePlatform()) StatusBar.show().catch(() => {});

    document.body.classList.remove('hide-drill-controls');

    const rawScore = scoreRef.current;
    const finalAccuracy = statsRef.current.totalAttempts > 0
      ? Math.round((statsRef.current.totalCorrect / statsRef.current.totalAttempts) * 100)
      : 100;

    const bonuses = calcEndBonuses({
      rawScore,
      accuracy: finalAccuracy,
      bestCombo: bestStreakRef.current,
      totalActions: statsRef.current.totalCorrect,
      mistakes: Math.max(0, statsRef.current.totalAttempts - statsRef.current.totalCorrect),
      livesRemaining: livesRef.current,
      maxLives: MAX_LIVES,
      category: 'cognitive',
    });
    const finalScore = bonuses.finalScore;

    try {
      saveLeaderboardEntrySync({
        drillId: 'sudoku',
        drillName: 'Sudoku Speed-Logic',
        category: 'cognitive',
        score: finalScore,
        accuracy: finalAccuracy,
        bestCombo: bestStreakRef.current,
      });
    } catch (e) {
      console.error(e);
    }

    let isNewBestScore = false;
    let sessionsPlayed = 0;

    try {
      const sScore = localStorage.getItem('skilldrills_sudoku_best_score_v3');
      const bestScoreVal = sScore ? parseInt(sScore, 10) : 0;
      isNewBestScore = finalScore > bestScoreVal;
      if (isNewBestScore) {
        setBestScore(finalScore);
        setIsNewBest(true);
        localStorage.setItem('skilldrills_sudoku_best_score_v3', finalScore.toString());
      } else {
        setBestScore(bestScoreVal);
        setIsNewBest(false);
      }

      const sStreak = localStorage.getItem('skilldrills_sudoku_best_streak_v3');
      const bestStreakVal = sStreak ? parseInt(sStreak, 10) : 0;
      if (bestStreakRef.current > bestStreakVal) {
        setBestStreak(bestStreakRef.current);
        localStorage.setItem('skilldrills_sudoku_best_streak_v3', bestStreakRef.current.toString());
      } else {
        setBestStreak(bestStreakVal);
      }

      const sPeakGrid = localStorage.getItem('skilldrills_sudoku_peak_grid_v1');
      const peakGridVal = sPeakGrid ? parseInt(sPeakGrid, 10) : MIN_GRID_SIZE;
      if (peakGridSizeRef.current > peakGridVal) {
        localStorage.setItem('skilldrills_sudoku_peak_grid_v1', peakGridSizeRef.current.toString());
      }

      const sSessions = localStorage.getItem('skilldrills_sudoku_total_sessions_v1');
      sessionsPlayed = sSessions ? parseInt(sSessions, 10) || 0 : 0;
      localStorage.setItem('skilldrills_sudoku_total_sessions_v1', (sessionsPlayed + 1).toString());
    } catch (e) {}

    const daily = await previewDailyCompletion('sudoku');

    const xpResult = calcSessionXP({
      finalScore,
      accuracy: finalAccuracy,
      isNewBest: isNewBestScore,
      firstPlay: sessionsPlayed === 0,
      dailyChallenge: daily.isDailyDrill,
      dailyChallengeSetComplete: daily.wouldCompleteSet,
    });
    setXpEarned(xpResult.xp);

    syncToUI();
    setScore(finalScore);
    setGridSize(peakGridSizeRef.current);
  }, [clearTimers, syncToUI]);

  // === SUDOKU CORE LOGIC ===

  const isValid = useCallback((checkGrid, row, col, num, size, regionsArray) => { 
    for (let x = 0; x < size; x++) { if (checkGrid[row * size + x] === num) return false; } 
    for (let x = 0; x < size; x++) { if (checkGrid[x * size + col] === num) return false; } 
    
    if (size === 4) { 
      const br = Math.floor(row / 2); const bc = Math.floor(col / 2); 
      for (let i = 0; i < 2; i++) { 
        for (let j = 0; j < 2; j++) { if (checkGrid[(br * 2 + i) * size + (bc * 2 + j)] === num) return false; } 
      } 
    } else if (size === 6) { 
      const br = Math.floor(row / 2); const bc = Math.floor(col / 3); 
      for (let i = 0; i < 2; i++) { 
        for (let j = 0; j < 3; j++) { if (checkGrid[(br * 2 + i) * size + (bc * 3 + j)] === num) return false; } 
      } 
    } else if (regionsArray) {
      const cellIdx = row * size + col;
      const targetRegion = regionsArray[cellIdx];
      for (let i = 0; i < size * size; i++) {
        if (i !== cellIdx && regionsArray[i] === targetRegion && checkGrid[i] === num) {
          return false;
        }
      }
    }
    return true; 
  }, []);

  const solveSudoku = useCallback((gridToSolve, size, regionsArray) => { 
    const solve = (ga) => { 
      for (let i = 0; i < size * size; i++) { 
        if (ga[i] === null) { 
          const row = Math.floor(i / size); const col = i % size; 
          const nums = Array.from({ length: size }, (_, n) => n + 1); 
          for (let k = nums.length - 1; k > 0; k--) { const j = Math.floor(Math.random() * (k + 1)); [nums[k], nums[j]] = [nums[j], nums[k]]; } 
          for (const num of nums) { 
            if (isValid(ga, row, col, num, size, regionsArray)) { ga[i] = num; if (solve(ga)) return true; ga[i] = null; } 
          } 
          return false; 
        } 
      } 
      return true; 
    }; 
    const gc = [...gridToSolve]; 
    solve(gc); 
    return gc; 
  }, [isValid]);

  const solveSudokuCount = useCallback((gridToSolve, size, regionsArray) => { 
    let solutionCount = 0;
    const solve = (ga) => { 
      for (let i = 0; i < size * size; i++) { 
        if (ga[i] === null) { 
          const row = Math.floor(i / size); const col = i % size; 
          for (let num = 1; num <= size; num++) { 
            if (isValid(ga, row, col, num, size, regionsArray)) { 
              ga[i] = num; 
              solve(ga); 
              if (solutionCount >= 2) return; 
              ga[i] = null; 
            } 
          } 
          return; 
        } 
      } 
      solutionCount++;
    }; 
    const gc = [...gridToSolve]; 
    solve(gc); 
    return solutionCount; 
  }, [isValid]);

  // Pure puzzle builder — identical logic to the old generateSudoku, just
  // returning its result instead of pushing straight into React state, so it
  // can run either synchronously (fallback) or ahead of time in idle time
  // (the normal path — see schedulePrecompute below).
  const buildPuzzle = useCallback((size) => {
    const tc = size * size;
    let regions = null;
    let solved = null;

    if (size === 5 || size === 7) {
      const MAX_ATTEMPTS = 15;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const candidateRegions = generateJigsawRegions(size);
        const candidateSolved = solveSudoku(Array(tc).fill(null), size, candidateRegions);
        if (!candidateSolved.includes(null)) {
          regions = candidateRegions;
          solved = candidateSolved;
          break;
        }
      }
      if (!solved) {
        regions = Array.from({ length: tc }, (_, i) => Math.floor(i / size));
        solved = solveSudoku(Array(tc).fill(null), size, regions);
      }
    } else {
      solved = solveSudoku(Array(tc).fill(null), size, regions);
    }

    const puzzle = [...solved];
    const initial = new Set();

    let ctk;
    if (size === 4) ctk = 8;
    else if (size === 5) ctk = 10;
    else if (size === 6) ctk = 14;
    else ctk = 18;

    const cellsToBlank = Array.from({ length: tc }, (_, i) => i).sort(() => Math.random() - 0.5);
    let blankedCount = 0;
    for (const cellIdx of cellsToBlank) {
      if (blankedCount >= tc - ctk) break;
      const oldVal = puzzle[cellIdx];
      puzzle[cellIdx] = null;

      const solutions = solveSudokuCount(puzzle, size, regions);
      if (solutions !== 1) {
        puzzle[cellIdx] = oldVal;
      } else {
        blankedCount++;
      }
    }

    for (let i = 0; i < tc; i++) {
      if (puzzle[i] !== null) {
        initial.add(i);
      }
    }

    return { puzzle, solved, initial, regions };
  }, [solveSudoku, solveSudokuCount]);

  // Warms nextPuzzleCacheRef for `size` during browser idle time, so the
  // heavy solve/uniqueness-check work is already done by the time the player
  // actually reaches that size. requestIdleCallback isn't available in every
  // WebView, so a short setTimeout is the fallback — still off the frame
  // that's busy rendering the current round's clear celebration.
  const schedulePrecompute = useCallback((size) => {
    if (nextPuzzleCacheRef.current[size]) return;
    const run = () => {
      if (!mountedRef.current || nextPuzzleCacheRef.current[size]) return;
      nextPuzzleCacheRef.current[size] = buildPuzzle(size);
    };
    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(run, { timeout: 1000 });
    } else {
      precomputeTimeoutRef.current = setTimeout(run, 50);
    }
  }, [buildPuzzle]);

  const generateSudoku = useCallback((size) => {
    const cached = nextPuzzleCacheRef.current[size];
    const { puzzle, solved, initial, regions } = cached || buildPuzzle(size);
    if (cached) delete nextPuzzleCacheRef.current[size];

    setRegionsArray(regions);
    setSolution(solved);
    setGrid(puzzle);
    setInitialIndices(initial);
    setSelectedCell(null);
    cellWrongAttemptsRef.current = {};
    lastInputTimeRef.current = Date.now();

    // Get a head start on whichever size the player will hit next (either
    // this same size again, if already at the 7x7 cap, or one bigger).
    schedulePrecompute(Math.min(MAX_GRID_SIZE, size + 1));
  }, [buildPuzzle, schedulePrecompute]);

  const handleCellClick = useCallback((index, e) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    if (initialIndices.has(index) || gameStateRef.current !== 'playing') return;
    setSelectedCell(index);
  }, [initialIndices]);

  const handleNumberInput = useCallback((num, e) => {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }

    if (selectedCell === null || gameStateRef.current !== 'playing') return;
    
    const isCorrect = solution[selectedCell] === num;
    
    if (!isCorrect) {
      audioSynth?.playPenalty();
      triggerShake();
      triggerFlash('red');

      let penaltySeconds = 2.0;

      const prevAttempts = cellWrongAttemptsRef.current[selectedCell] || 0;
      const nextAttempts = prevAttempts + 1;
      cellWrongAttemptsRef.current[selectedCell] = nextAttempts;

      if (nextAttempts >= 3) {
        penaltySeconds += 3.0;
      }

      timeRef.current -= penaltySeconds;
      livesRef.current = Math.max(0, livesRef.current - 1);
      setLives(livesRef.current);
      streakRef.current = 0;

      overdriveProgressRef.current = 0;
      setOverdriveProgress(0);
      overdriveActiveRef.current = false;
      setOverdriveActive(false);

      timeRef.current = Math.max(0, timeRef.current);
      statsRef.current.totalAttempts += 1;

      syncToUI();

      if (livesRef.current <= 0 || timeRef.current <= 0) {
        setLocalTimeRemaining(timeRef.current);
        endGame();
      } else {
        setLocalTimeRemaining(timeRef.current);
      }
      return;
    }

    // CORRECT INPUT
    audioSynth?.playHit();
    triggerFlash('cyan');

    const newGrid = [...grid];
    newGrid[selectedCell] = num;
    setGrid(newGrid);
    setSelectedCell(null);

    const reactionMs = Date.now() - lastInputTimeRef.current;
    lastInputTimeRef.current = Date.now();
    
    const scoreResult = scoreAction({
      category: 'cognitive',
      combo: streakRef.current,
      reactionMs,
      timeRemaining: timeRef.current,
      totalGameTime: TOTAL_TIME,
      livesRemaining: livesRef.current,
      maxLives: MAX_LIVES,
      // Normalized to a 1-based scale — gridSizeRef never drops below
      // MIN_GRID_SIZE, so passing it straight through would floor the
      // levelMultiplier above 1.0x even on the easiest board.
      level: gridSizeRef.current - MIN_GRID_SIZE + 1,
      maxLevel: MAX_GRID_SIZE - MIN_GRID_SIZE + 1
    });

    let pointsEarned = scoreResult.total;
    if (overdriveActiveRef.current) {
      pointsEarned = Math.round(pointsEarned * 1.75);
    }

    scoreRef.current += pointsEarned;
    setScore(scoreRef.current);

    statsRef.current.totalCorrect += 1;
    statsRef.current.totalAttempts += 1;
    
    streakRef.current += 1;
    if (streakRef.current > bestStreakRef.current) {
      bestStreakRef.current = streakRef.current;
      setBestStreak(streakRef.current);
      try { localStorage.setItem('skilldrills_sudoku_best_streak_v3', streakRef.current.toString()); } catch (e) {}
    }
    
    fillOverdrive(8);

    // GRID COMPLETION CHECK
    if (!newGrid.includes(null)) {
      const clearScale = (gridSize * gridSize) / 16.0;
      const clearBonus = Math.round(20 * clearScale);
      
      scoreRef.current += clearBonus;
      setScore(scoreRef.current);
      
      statsRef.current.roundsCompleted += 1;
      
      if (gridSizeRef.current < MAX_GRID_SIZE) {
        gridSizeRef.current += 1;
        setGridSize(gridSizeRef.current);
        peakGridSizeRef.current = Math.max(peakGridSizeRef.current, gridSizeRef.current);
      }

      timeRef.current = TOTAL_TIME;
      setLocalTimeRemaining(TOTAL_TIME);

      syncToUI();
      
      setTimeout(() => {
        if (gameStateRef.current === 'playing') {
          generateSudoku(gridSizeRef.current);
        }
      }, 500);
    }
  }, [grid, selectedCell, solution, gridSize, syncToUI, triggerShake, triggerFlash, fillOverdrive, endGame, generateSudoku]);

  const runCountdown = useCallback((n, callback) => {
    setGameState('countdown');
    gameStateRef.current = 'countdown';
    if (countdownTimerRef.current) clearTimeout(countdownTimerRef.current);
    
    if (n === 0) {
      audioSynth?.playGo();
      setCountdownVal('GO');
      countdownTimerRef.current = setTimeout(() => {
        setCountdownVal(null);
        setGameState('playing');
        gameStateRef.current = 'playing';
        callback();
      }, 350);
      return;
    }
    
    audioSynth?.playCountdownTick();
    setCountdownVal(n);
    countdownTimerRef.current = setTimeout(() => runCountdown(n - 1, callback), 700);
  }, []);

  const startGame = useCallback(() => {
    if (audioSynth) audioSynth.init(); 
    clearTimers();
    
    scoreRef.current = 0;
    setScore(0);
    timeRef.current = TOTAL_TIME;
    setLocalTimeRemaining(TOTAL_TIME);
    livesRef.current = MAX_LIVES;
    setLives(MAX_LIVES);
    streakRef.current = 0;

    const startSize = MIN_GRID_SIZE;
    gridSizeRef.current = startSize;
    setGridSize(startSize);

    overdriveActiveRef.current = false;
    setOverdriveActive(false);
    overdriveProgressRef.current = 0;
    setOverdriveProgress(0);
    setIsNewBest(false);
    setXpEarned(0);

    statsRef.current = { roundsCompleted: 0, totalCorrect: 0, totalAttempts: 0 };
    setStats({ ...statsRef.current });
    setAccuracy(100);

    lockPortrait().catch(() => {});
    if (Capacitor.isNativePlatform()) {
      StatusBar.hide().catch(() => {});
    }

    runCountdown(3, () => {
      let lastTick = Date.now();

      globalTimerIntervalRef.current = setInterval(() => {
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
      generateSudoku(startSize);
    });
  }, [clearTimers, runCountdown, generateSudoku, endGame, scheduleHeartbeat]);

  const shareDrillLink = useCallback(async () => {
    const url = 'https://skilldrills.online/drills/cognitive/problem-solving/sudoku';
    try {
      const grade = getGrade(accuracy);
      const canvas = generateShareCard({
        score,
        bestScore,
        accuracy,
        bestCombo: bestStreak,
        rating: { letter: grade.grade, label: grade.label, emoji: grade.emoji },
        newBest: isNewBest,
        drillName: 'Sudoku Speed-Logic',
        playerName: getPlayerName(),
      });
      await shareScoreCard(url, canvas);
    } catch (e) {
      const text = `I scored ${scoreRef.current} points with a max streak of ${bestStreakRef.current} in Sudoku Speed-Logic! Can you beat my constraint-satisfaction speed?`;
      if (navigator.share) {
        navigator.share({ title: 'Sudoku Speed Score', text, url }).catch(() => {});
      } else {
        navigator.clipboard.writeText(`${text} ${url}`)
          .then(() => alert('Score card copied to clipboard!'))
          .catch(() => prompt('Copy score:', `${text} ${url}`));
      }
    }
  }, [score, bestScore, accuracy, bestStreak, isNewBest]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (gameState === 'playing' || gameState === 'countdown') {
      document.body.classList.add('hide-drill-controls');
    } else {
      document.body.classList.remove('hide-drill-controls');
    }
    return () => {
      document.body.classList.remove('hide-drill-controls');
    };
  }, [gameState]);

  if (loading || !isClient) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#050505]">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-indigo-600 border-t-transparent rounded-full animate-spin mx-auto mb-4 shadow-[0_0_20px_rgba(99,102,241,0.5)]"></div>
          <p className="text-gray-400 font-medium tracking-widest uppercase text-sm animate-pulse">Loading Engine...</p>
        </div>
      </div>
    );
  }

  return (
    <DrillWrapper
      drillName="Sudoku Speed-Logic"
      category="cognitive"
      score={score}
      timeLeft={gameState === 'ended' ? 0 : Math.ceil(localTimeRemaining)}
      lives={gameState === 'start' || gameState === 'countdown' ? null : lives}
      maxLives={MAX_LIVES}
      soundEnabled={soundEnabled}
      onSoundToggle={() => setSoundEnabled(v => { audioSynth?.setEnabled(!v); return !v; })}
      backHref="/drills/cognitive"
      minimalChrome
    >
      <div
        ref={containerRef}
        onContextMenu={(e) => { if(gameState === 'playing') e.preventDefault(); }}
        className={`absolute inset-0 select-none overflow-hidden bg-[#050508] text-white ${shakeCls}`}
        style={{ 
          touchAction: gameState === 'playing' ? 'none' : 'auto', 
          WebkitTapHighlightColor: 'transparent' 
        }}
      >
        <style>{`
          @keyframes shake {
            0%, 100% { transform: translateX(0); }
            20%, 60% { transform: translateX(-6px); }
            40%, 80% { transform: translateX(6px); }
          }
          .animate-shake {
            animation: shake 0.3s ease-in-out;
          }

          @keyframes flash-fade {
            0% { opacity: 1; }
            100% { opacity: 0; }
          }
          .fx-flash {
            position: absolute;
            inset: 0;
            pointer-events: none;
            z-index: 55;
            animation-name: flash-fade;
            animation-duration: 0.2s;
            animation-timing-function: ease-out;
            animation-fill-mode: forwards;
          }
          /* Radial + sized at 30% (not a flat full-screen tint) so it fades
             to fully transparent before reaching the edges — the grid's own
             numbers stay fully readable through a mistake flash now. */
          .fx-flash-red { background: radial-gradient(ellipse 30% 30% at 50% 50%, rgba(239,68,68,.35) 0%, rgba(239,68,68,.35) 30%, rgba(239,68,68,.15) 60%, transparent 92%); }
          /* success flashes are intentionally inert — see globals.css */
          .fx-flash-cyan { animation-name: none; background: none; }
          .fx-flash-gold { animation-name: none; background: none; }
        `}</style>

        <div className="absolute inset-0 pointer-events-none" style={{ backgroundImage: 'linear-gradient(rgba(255,255,255,0.015) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.015) 1px, transparent 1px)', backgroundSize: '40px 40px' }} />

        {flashes.map((f) => (
          <div key={f.id} className={`fx-flash fx-flash-${f.variant}`} />
        ))}

        {/* ── START SCREEN ── */}
        {gameState === 'start' && (
          <div className="relative h-full flex items-center justify-center p-5 overflow-y-auto z-40 pointer-events-auto">
            <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(ellipse 420px 260px at 50% 8%, rgba(99,102,241,.14), transparent 70%)' }} />
            <div className="relative w-full max-w-[290px] rounded-[20px] border border-white/5 bg-[#0c0c16]/90 backdrop-blur-lg px-5 pt-5 pb-[18px] text-center shadow-[0_16px_40px_rgba(0,0,0,.5)] my-6">
              <div className="w-11 h-11 mx-auto rounded-[14px] bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center mb-3 shadow-[0_0_22px_rgba(99,102,241,.35)]">
                <Compass className="w-[22px] h-[22px] text-white" />
              </div>
              <h1 className="text-[17px] font-bold tracking-tight text-white">Sudoku Speed-Logic</h1>

              <div className="flex flex-col gap-1.5 text-left mt-3.5">
                <HowToRow icon={<Eye className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" />} node={<>Solve Sudoku constraints under time pressure</>} />
                <HowToRow icon={<ZapIcon className="w-3.5 h-3.5 text-purple-400 flex-shrink-0" />} node={<>Clears expand board size (4x4 → 5x5 → 6x6 → 7x7)</>} />
                <HowToRow icon={<Ban className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />} node={<>5 lives — wrong guesses and timeouts cost a life</>} />
              </div>

              <div className="grid grid-cols-3 gap-1.5 mt-3.5">
                <MiniStat label="Best" value={bestScore} color="text-yellow-400" />
                <MiniStat label="Combo" value={`${bestStreak}x`} color="text-orange-400" />
                <MiniStat label="Level" value={`${gridSize}x${gridSize}`} color="text-indigo-400" />
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
        {gameState === 'countdown' && (
          <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/55 backdrop-blur-[2px]">
            <span className="text-[11px] font-black uppercase tracking-[0.2em] text-slate-400">Get Ready</span>
            <div className="relative w-28 h-28 rounded-full border-[3px] border-indigo-500/20 flex items-center justify-center">
              <div className="absolute -inset-[3px] rounded-full border-[3px] border-transparent border-t-indigo-400 border-r-indigo-400 animate-spin" style={{ animationDuration: '0.7s' }} />
              <span key={countdownVal} className="fx-pop-in text-5xl font-black bg-gradient-to-b from-white to-indigo-300 bg-clip-text text-transparent font-mono">
                {countdownVal}
              </span>
            </div>
            <span className="text-[10px] text-slate-500">Board generates at GO</span>
          </div>
        )}

        {/* ── PLAYING ── */}
        {gameState === 'playing' && (
          <>
            <div className="absolute top-0 left-0 right-0 h-1.5 bg-neutral-950 z-[60] pointer-events-none">
              <div 
                className={`h-full transition-all duration-100 ease-linear ${localTimeRemaining <= 10 ? 'bg-red-500 animate-pulse' : 'bg-indigo-500'}`} 
                style={{ width: `${(localTimeRemaining / TOTAL_TIME) * 100}%` }}
              />
            </div>

            <div className="absolute top-5 left-5 z-40 flex flex-col pointer-events-none select-none">
              <span className="text-3xl font-black text-white leading-none tabular-nums">{score}</span>
              <div className="flex items-center gap-2 mt-2">
                <span className="flex items-center gap-0.5">
                  {Array.from({ length: MAX_LIVES }).map((_, i) => (
                    <Heart key={i} className={`w-3.5 h-3.5 ${i < lives ? 'fill-red-500 text-red-500' : 'text-white/15'}`} />
                  ))}
                </span>
              </div>
            </div>

            <div className="absolute top-5 right-5 z-40 flex flex-col items-end pointer-events-none select-none">
              <span className={`text-3xl font-black font-mono leading-none ${localTimeRemaining <= 10 ? 'text-red-500 animate-pulse' : 'text-slate-300'}`}>
                {Math.ceil(localTimeRemaining)}s
              </span>
              <span className="text-[8px] text-slate-500 font-bold uppercase tracking-widest mt-1">Time Left</span>
            </div>

            {/* HIGH VISIBILITY GAMEPLAY BOARD */}
            <div className="w-full h-full flex flex-col items-center justify-center p-4 z-10">
              <div className="h-4 mb-2" />

              {/* Main Outer Board Box */}
              <div className="p-2 bg-[#0a0a16] rounded-2xl border-2 border-indigo-500/40 shadow-[0_0_30px_rgba(99,102,241,0.2)]">
                <div 
                  className="grid mx-auto gap-1.5"
                  style={{ 
                    gridTemplateColumns: `repeat(${gridSize}, 1fr)`,
                    width: 'min(78vw, 40vh)',
                    aspectRatio: '1/1'
                  }}
                >
                  {grid.map((val, i) => {
                    const isInitial = initialIndices.has(i);
                    const isSelected = selectedCell === i;
                    
                    // High-contrast Region Tints & Cell Styling
                    let regionTint = "bg-[#121224] border border-white/10";
                    
                    if (gridSize === 4) {
                      const br = Math.floor(Math.floor(i / 4) / 2);
                      const bc = Math.floor((i % 4) / 2);
                      const boxIdx = br * 2 + bc;
                      const tints = [
                        "bg-indigo-950/70 border-indigo-500/30",
                        "bg-purple-950/70 border-purple-500/30",
                        "bg-rose-950/70 border-rose-500/30",
                        "bg-amber-950/70 border-amber-500/30",
                      ];
                      regionTint = tints[boxIdx];
                    } else if (gridSize === 6) {
                      const br = Math.floor(Math.floor(i / 6) / 2);
                      const bc = Math.floor((i % 6) / 3);
                      const boxIdx = br * 2 + bc;
                      const tints = [
                        "bg-indigo-950/70 border-indigo-500/30",
                        "bg-purple-950/70 border-purple-500/30",
                        "bg-rose-950/70 border-rose-500/30",
                        "bg-amber-950/70 border-amber-500/30",
                        "bg-cyan-950/70 border-cyan-500/30",
                        "bg-emerald-950/70 border-emerald-500/30",
                      ];
                      regionTint = tints[boxIdx];
                    } else if ((gridSize === 5 || gridSize === 7) && regionsArray) {
                      const rIdx = regionsArray[i];
                      const tints = [
                        "bg-indigo-950/70 border-indigo-500/30",
                        "bg-purple-950/70 border-purple-500/30",
                        "bg-rose-950/70 border-rose-500/30",
                        "bg-amber-950/70 border-amber-500/30",
                        "bg-cyan-950/70 border-cyan-500/30",
                        "bg-emerald-950/70 border-emerald-500/30",
                        "bg-violet-950/70 border-violet-500/30",
                      ];
                      regionTint = tints[rIdx % tints.length];
                    }

                    let cellStyle = regionTint;
                    if (isInitial) {
                      cellStyle = "bg-[#18182b] border border-slate-600/60 text-slate-200 font-bold cursor-default shadow-inner";
                    } else if (val !== null) {
                      cellStyle = "bg-emerald-950/80 text-emerald-300 border-2 border-emerald-400/80 font-black shadow-[0_0_10px_rgba(16,185,129,0.3)] cursor-default";
                    } else {
                      cellStyle = `${regionTint} border border-white/15 hover:border-white/40 text-white cursor-pointer active:scale-95 transition-all`;
                    }

                    if (isSelected) {
                      cellStyle = "bg-indigo-600/50 text-white border-2 border-indigo-300 ring-4 ring-indigo-500/50 transform scale-105 z-20 shadow-[0_0_20px_rgba(99,102,241,0.8)]";
                    }

                    return (
                      <button
                        key={i}
                        onPointerDown={(e) => handleCellClick(i, e)}
                        disabled={isInitial || val !== null}
                        className={`w-full h-full rounded-xl font-black text-center flex items-center justify-center relative touch-none select-none text-xl md:text-2xl lg:text-3xl focus:outline-none ${cellStyle}`}
                      >
                        {val}
                        {isSelected && !val && (
                          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                            <div className="w-2.5 h-2.5 bg-indigo-300 rounded-full animate-ping shadow-[0_0_12px_rgba(255,255,255,0.9)]" />
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Number Input Pad */}
              <div className="mt-5 flex justify-center gap-2 flex-wrap w-full max-w-[320px]">
                {Array.from({ length: gridSize }).map((_, i) => {
                  const num = i + 1;
                  return (
                    <button
                      key={num}
                      onPointerDown={(e) => handleNumberInput(num, e)}
                      disabled={selectedCell === null}
                      className="flex-1 py-3 rounded-xl text-xl font-black transition-all bg-gradient-to-br from-indigo-600 to-purple-600 border border-indigo-300 text-white hover:bg-indigo-500 active:scale-95 focus:outline-none shadow-md shadow-indigo-500/30 disabled:opacity-30 disabled:scale-100 cursor-pointer"
                    >
                      {num}
                    </button>
                  );
                })}
              </div>
            </div>
          </>
        )}

        {/* ── RESULT SCREEN ── */}
        {gameState === 'ended' && (
          <ResultScreen
            score={score}
            accuracy={accuracy}
            streak={bestStreak}
            xpEarned={xpEarned}
            isNewBest={isNewBest}
            onPlayAgain={startGame}
            onShare={shareDrillLink}
          />
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

function MiniStat({ label, value, color = "text-indigo-400" }) {
  return (
    <div className="rounded-[9px] border border-white/5 bg-white/[0.02] py-1.5 px-1 text-center">
      <div className={`text-[12px] font-bold ${color}`}>{value}</div>
      <div className="text-[7.5px] uppercase tracking-wide text-slate-500 font-bold mt-0.5">{label}</div>
    </div>
  );
}

function ResultScreen({ score, accuracy, streak, xpEarned, isNewBest, onPlayAgain, onShare }) {
  const grade = getGrade(accuracy);
  const gradeColor = grade.grade === 'S+' || grade.grade === 'S' ? '#fbbf24' : '#a78bfa';

  return (
    <div className="absolute inset-0 z-40 flex" style={{ background: 'rgba(5,5,8,0.97)' }}>
      <div className="w-[36%] flex flex-col items-center justify-center gap-1.5 border-r border-white/5" style={{ background: 'radial-gradient(ellipse 260px 200px at 50% 30%, rgba(99,102,241,.08), transparent 70%)' }}>
        {isNewBest && (
          <span className="text-[9.5px] font-bold text-yellow-400 bg-yellow-500/10 border border-yellow-500/25 px-2.5 py-0.5 rounded-full mb-1">NEW BEST</span>
        )}
        <div className="text-5xl sm:text-6xl font-black leading-none" style={{ color: gradeColor }}>{grade.grade}</div>
        <div className="text-[10px] uppercase tracking-widest text-slate-500">{grade.label}</div>
        <div className="text-3xl sm:text-4xl font-black text-white mt-1 tabular-nums">{score.toLocaleString()}</div>
        <div className="text-[9px] uppercase tracking-widest text-slate-500">Points</div>
      </div>

      <div className="flex-1 flex flex-col justify-center gap-3 px-6 sm:px-8 py-4 min-w-0">
        <div className="grid grid-cols-3 gap-2">
          <ResultStat label="Accuracy" value={`${accuracy}%`} color="text-blue-400" />
          <ResultStat label="Combo" value={`${streak}x`} color="text-orange-400" />
          <ResultStat label="XP" value={`+${xpEarned}`} color="text-violet-400" />
        </div>
        <div className="flex gap-2">
          <button
            onClick={onPlayAgain}
            className="flex-1 py-3 rounded-[13px] bg-gradient-to-r from-indigo-600 to-purple-600 text-white font-bold text-xs uppercase tracking-wide cursor-pointer"
          >
            Play Again
          </button>
          <button
            onClick={onShare}
            className="w-11 flex-shrink-0 rounded-[13px] bg-white/[0.04] border border-white/10 flex items-center justify-center text-slate-400 hover:text-white cursor-pointer"
          >
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