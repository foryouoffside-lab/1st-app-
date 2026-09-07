'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import { Volume2, VolumeX } from 'lucide-react';
import { scoreAction, calcEndBonuses, calcSessionXP, getGrade } from '../../../../../lib/scoringEngine';
import { applyHit, applyMistake, scoringLives } from '../../../../../lib/drillRules';
import { saveLeaderboardEntrySync } from '../../../../../lib/leaderboard';
import { lockPortrait, unlockOrientation } from '../../../../../lib/orientation';
import { previewDailyCompletion } from '../../../../../lib/dailyChallenge';
import { getPlayerName, getPlayerLevel } from '../../../../../lib/progressStore';
import { useShareCard } from '../../../../../components/ShareScoreCard';
import { Capacitor } from '@capacitor/core';
import { StatusBar } from '@capacitor/status-bar';
import DrillWrapper from '../../../../../components/DrillWrapper';
import { useDuelMatchStart, duelSecondsRemaining } from '../../../../../lib/challengeEngine';
import { APP_SHARE_URL } from '../../../../../lib/shareLinks';
import ResultScreen from '../../../../../components/drill/ResultScreen';
import DrillStartCard from '../../../../../components/drill/DrillStartCard';

// ============================================================
// TUNING CONSTANTS
// ============================================================
const TOTAL_TIME = 45.0;

// How a solo run is won and lost — the clock as the only fail state, what a hit
// earns, what a mistake costs — is defined once in lib/drillRules.js and shared
// by every drill. Read that file for the model and the reasoning.

const BASE_GRID_SIZE = 5;
const GRID_STEP_UP_THRESHOLD = 12;
const EXPANDED_GRID_SIZE = 6;
const MAX_LIT_CELLS = 20;
const MIN_LIT_CELLS = 5;
// The DISPLAYED level is the pattern size, which is capped by MAX_LIT_CELLS —
// a grid only has so many cells, and a phone only has so much screen. That
// ceiling is physical, so difficulty genuinely stops rising there.
//
// roundsRef is the level that does NOT stop: it counts boards cleared, and it
// is what the decaying time-per-hit payout keys off. Without it a player who
// could hold the biggest pattern would refill the clock forever at a difficulty
// that had stopped increasing, and the run would never end.
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
      } catch {}
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
    } catch {}
  }

  // 1. Hit sound
  playHit() { this.tone(880, 0.12, 'sine', 0.16, 1760); }

  // 2. Countdown tick sound
  playCountdownTick() { this.tone(440, 0.09, 'sine', 0.12, 440); }

  // GO — a struck wooden bar. Warm rather than urgent: this is the last beat
  // of 3-2-1, so it has to feel bigger than the 440Hz ticks without turning
  // the start of a focus drill into an alarm.
  //
  // Earlier versions chased impact and got harshness instead — a bright A5
  // mallet, a four-note arpeggio over a sub drop, a chord with a glide into
  // it. Next to the ticks they all read as ARCADE.
  //
  // What works is a marimba tap. A 12ms noise burst bandpassed at 900Hz is
  // the beater contacting wood — low and short enough that it never reads as
  // a drum, but without it the tone has no onset and nothing feels struck.
  // Behind it, three voices 5ms later: C5 as the bar, its octave for a little
  // air, C4 underneath for warmth. Each is a pair of sines detuned four cents
  // apart through a lowpass — the same construction as chimeVoice — which is
  // why nothing here buzzes. C is a minor third above the 440Hz ticks, so it
  // resolves upward and lands clearly without shouting. Decays over ~350ms.
  //
  // Scheduled on the AudioContext clock, not with setTimeout: the main thread
  // is setting the round up at exactly this instant.
  playGo() {
    if (!this.enabled || !this.ctx) return;
    try {
      const ctx = this.ctx;
      if (ctx.state === 'suspended') ctx.resume();
      const t0 = ctx.currentTime;

      // The beater. Linearly-decaying white noise through a bandpass — a
      // wooden knock, not a snare.
      const nLen = Math.max(1, Math.floor(ctx.sampleRate * 0.012));
      const nBuf = ctx.createBuffer(1, nLen, ctx.sampleRate);
      const nData = nBuf.getChannelData(0);
      for (let i = 0; i < nLen; i++) {
        nData[i] = (Math.random() * 2 - 1) * (1 - i / nLen);
      }
      const nSrc = ctx.createBufferSource();
      nSrc.buffer = nBuf;
      const nBand = ctx.createBiquadFilter();
      nBand.type = 'bandpass';
      nBand.frequency.setValueAtTime(900, t0);
      nBand.Q.setValueAtTime(1.6, t0);
      const nGain = ctx.createGain();
      nGain.gain.setValueAtTime(0.042, t0);
      nGain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.012);
      nSrc.connect(nBand);
      nBand.connect(nGain);
      nGain.connect(ctx.destination);
      nSrc.start(t0);
      nSrc.stop(t0 + 0.012);

      // The bar. 5ms behind the knock so the two read as one event.
      [
        // freq    at     dur   vol    cut   attack
        [523.25,  0.005, 0.35, 0.120, 2000, 0.008], // body — C5
        [1046.50, 0.005, 0.13, 0.034, 3200, 0.008], // octave — air
        [261.63,  0.005, 0.30, 0.040, 1200, 0.012]  // foundation — C4
      ].forEach(([freq, at, dur, vol, cut, attack]) => {
        const startAt = t0 + at;
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(cut, startAt);
        filter.Q.setValueAtTime(0.5, startAt);
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.0001, startAt);
        gain.gain.linearRampToValueAtTime(vol, startAt + attack);
        gain.gain.exponentialRampToValueAtTime(0.001, startAt + dur);
        filter.connect(gain);
        gain.connect(ctx.destination);
        [-4, 4].forEach((cents) => {
          const osc = ctx.createOscillator();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(freq, startAt);
          osc.detune.setValueAtTime(cents, startAt);
          osc.connect(filter);
          osc.start(startAt);
          osc.stop(startAt + dur);
        });
      });
    } catch {}
  }

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
    } catch {}
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
    } catch {}
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
    } catch {}
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
  } catch {
    return { bestScore: 0, bestCombo: 0, bestLevel: 1, totalSessions: 0 };
  }
};

const saveData = (data) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {}
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
  // The live "Lv." HUD badge was the only thing that ever READ this, so the
  // React state went with it. The ramp itself runs off levelRef, which the
  // game loop already uses; keeping a useState in step with it only bought a
  // re-render of the whole drill on every level-up, mid-play, for nothing.
  const [bestScore, setBestScore] = useState(0);
  const [bestCombo, setBestCombo] = useState(0);
  const [bestLevel, setBestLevel] = useState(1);

  const [localTimeRemaining, setLocalTimeRemaining] = useState(totalTime);
  const [countdownVal, setCountdownVal] = useState(null);
  const [dangerLevel, setDangerLevel] = useState(0);
  const [wrongCellIndex, setWrongCellIndex] = useState(null);

  // === Grid State ===
  const [gridSize, setGridSize] = useState(BASE_GRID_SIZE);
  const [litCells, setLitCells] = useState(MIN_LIT_CELLS);
  const [cellStates, setCellStates] = useState([]);
  const [phase, setPhase] = useState("ready"); // "ready", "memorize", "recall", "result"
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
  const roundsRef = useRef(1);
  const runOverRef = useRef(false);
  const levelRef = useRef(1);
  const bestLevelRunRef = useRef(1);

  const gridSizeRef = useRef(5);
  const litCellsRef = useRef(5);
  const correctPatternRef = useRef(new Set());
  const userSelectionsRef = useRef(new Set());

  const globalTimerIntervalRef = useRef(null);
  const memorizeTimerRef = useRef(null);
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

  const triggerFlash = useCallback((variant) => {
    const id = Date.now() + Math.random();
    setFlashes(prev => [...prev, { id, variant }]);
    setTimeout(() => {
      if (mountedRef.current) setFlashes(prev => prev.filter(f => f.id !== id));
    }, 150);
  }, []);

  const clearTimers = useCallback(() => {
    if (globalTimerIntervalRef.current) clearInterval(globalTimerIntervalRef.current);
    if (memorizeTimerRef.current) clearTimeout(memorizeTimerRef.current);
    if (countdownTimerRef.current) clearTimeout(countdownTimerRef.current);
    if (overdriveTimeoutRef.current) clearTimeout(overdriveTimeoutRef.current);
    if (heartbeatTimerRef.current) clearTimeout(heartbeatTimerRef.current);
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
      : 0;

    const bonuses = calcEndBonuses({
      rawScore: finalScore,
      accuracy: finalAccuracy,
      bestCombo: bestStreakRef.current,
      totalActions: totalCorrectClicksRef.current,
      mistakes: totalAttemptsRef.current - totalCorrectClicksRef.current,
      livesRemaining: scoringLives(0),
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

    // Captured BEFORE the run is banked: the result screen's XP bar animates
    // from the level the player walked in with to the one they walk out with.
    const progress = await getPlayerLevel();

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
      progress,
      score: finalTotalScore,
      accuracy: finalAccuracy,
      bestCombo: bestStreakRef.current,
      xpEarned: xpResult.xp,
      isNewBest: isNew,
      prevBest: saved.bestScore,
    });

    // The status bar deliberately stays hidden here. Re-showing it resized the
    // WebView at the exact moment the result screen mounted, so the results
    // visibly jumped into place. It is restored on unmount instead (see the
    // mount effect), alongside unlockOrientation().
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
    if (memorizeTimerRef.current) clearTimeout(memorizeTimerRef.current);
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
    setPhase("memorize");
    phaseRef.current = "memorize";
    setIsProcessing(false);
    setUserSelections(new Set());
    userSelectionsRef.current = new Set();
    setWrongCellIndex(null);

    // One timeout, not a 100ms interval.
    //
    // The interval existed to tick a `memorizeTime` countdown into React state
    // — but nothing ever rendered that value, so every memorize phase was
    // firing 6-20 full re-renders of the whole drill (including all 25-36 grid
    // cell buttons) purely to update state no one reads. The only thing
    // actually needed here is handing over to the recall phase once the
    // memorize window is up.
    if (memorizeTimerRef.current) clearTimeout(memorizeTimerRef.current);
    memorizeTimerRef.current = setTimeout(() => {
      startRecall();
    }, memDuration * 1000);

  }, [generatePattern, startRecall]);

  const advanceRound = useCallback(() => {
    const nextLitCells = Math.min(MAX_LIT_CELLS, litCellsRef.current + 1);
    // Counts boards cleared, so it keeps rising after the pattern size caps.
    roundsRef.current += 1;
    levelRef.current = nextLitCells - MIN_LIT_CELLS + 1;

    bestLevelRunRef.current = Math.max(bestLevelRunRef.current, levelRef.current);
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
        const after = applyMistake({ timeRemaining: timeRef.current });
        timeRef.current = after.timeRemaining;
        runOverRef.current = after.runOver;
        setLocalTimeRemaining(timeRef.current);
      }

      totalAttemptsRef.current += 1;
      streakRef.current = 0;

      setWrongCellIndex(index);
      triggerFlash('red');

      setPhase("result");
      phaseRef.current = "result";

      if ((!isChallenge && runOverRef.current) || timeRef.current <= 0) {
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
    // No full-screen flash on a correct cell. Unlike other drills, where a
    // flash marks one discrete scoring event, recall here is 5-20 taps in quick
    // succession — so this strobed the whole screen several times a second
    // while the player was still trying to read the grid. The cell lighting up
    // cyan under the finger is already clear confirmation. The red flash on a
    // wrong tap stays: that one is a single event that needs to be unmissable.

    const reactionMs = Date.now() - lastTapTimeRef.current;
    lastTapTimeRef.current = Date.now();
    const scoreResult = scoreAction({
      category: 'cognitive',
      combo: streakRef.current,
      reactionMs,
      timeRemaining: timeRef.current,
      totalGameTime: totalTime,
      livesRemaining: scoringLives(0),
      level: litCellsRef.current,
      maxLevel: MAX_LIT_CELLS
    });

    let pointsEarned = scoreResult.total;

    scoreRef.current += pointsEarned;
    // Buy back a slice of the clock. Solo only - a duel's clock is the match's
    // shared window and nothing local may move it. No state is set here; the
    // existing tick redraws the seconds when the displayed number changes.
    if (!isChallenge) {
      timeRef.current = applyHit({ timeRemaining: timeRef.current, level: roundsRef.current });
    }
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
    const dangerFromLives = 0;   // lives are gone; time is the only danger now
    const dangerFromTime = timeRef.current <= 10 ? (10 - timeRef.current) / 10 : 0;
    const danger = Math.max(dangerFromLives * 0.7, dangerFromTime);
    // Clamped: an unclamped tempo goes NEGATIVE once danger exceeds ~1.69 (which
    // negative lives can produce), and a setTimeout with a negative delay fires
    // immediately — turning this self-rescheduling callback into a tight loop
    // spawning audio nodes at full CPU. That was the "phone heats up and makes
    // noise" bug already fixed in the other drills; this brings the rest in line.
    const tempo = Math.max(350, Math.round(1100 - danger * 650));
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

    // Every run starts at the lowest difficulty. It used to start at 55% of the
    // player's best level, so improving once permanently raised the speed every
    // future run opened at - a silent spike with nothing on screen explaining it.
    // That head-start only existed because a fixed 45s was too short to climb the
    // ramp; the endurance clock replaces it.
    const runStartLevel = 1;
    const startLitCells = MIN_LIT_CELLS + (runStartLevel - 1);

    scoreRef.current = 0;
    setScore(0);
    timeRef.current = totalTime;
    setLocalTimeRemaining(totalTime);
    streakRef.current = 0;
    bestStreakRef.current = 0;
    roundsRef.current = 1;
    runOverRef.current = false;
    levelRef.current = runStartLevel;

    bestLevelRunRef.current = runStartLevel;
    setDangerLevel(0);
    setWrongCellIndex(null);
    setFlashes([]);

    totalCorrectClicksRef.current = 0;
    totalAttemptsRef.current = 0;

    lockPortrait().catch(() => {});
    if (Capacitor.isNativePlatform()) {
      StatusBar.hide().catch(() => {});
    }

    runCountdown(isChallenge ? 0 : 3, () => {
      let lastTick = Date.now();

      globalTimerIntervalRef.current = setInterval(() => {
        // Duel: read the clock from the match's shared absolute end instant
        // rather than accumulating it locally — see duelSecondsRemaining.
        // The gameActive check is deliberately skipped in a duel: this
        // drill pauses its clock between rounds, and each player's round
        // boundaries fall at different moments, so a paused clock meant the
        // two duelists' 30 seconds covered different amounts of real time.
        // In a duel the match window is fixed and shared, and it keeps
        // running through the round transitions.
        if (duelDeadlineRef.current) {
          const duelTime = duelSecondsRemaining(duelDeadlineRef.current);
          timeRef.current = duelTime;
          setLocalTimeRemaining((prev) => (Math.ceil(prev) === Math.ceil(duelTime) ? prev : duelTime));
          // gameStateRef, not gameActiveRef: gameActiveRef also goes false
          // during a normal round transition, and the match still has to end
          // at the deadline if the clock runs out mid-transition. endGame
          // clears this interval, so this only ever fires once.
          if (duelTime <= 0 && gameStateRef.current !== 'ended') endGame();
          return;
        }
        if (!gameActiveRef.current) return;
        const now = Date.now();
        const deltaMs = now - lastTick;
        lastTick = now;

        // The clock FREEZES while the pattern is being shown. During
        // "memorize" the player is watching and physically cannot act, so
        // draining then charges them for the drill's own animation. Survivable
        // when lives were the main fail state; now that time is the ONLY
        // resource it would decide runs. `lastTick` still advances above, so
        // unfreezing doesn't dump the paused seconds in at once. Duels return
        // earlier from their own branch and are unaffected — both players share
        // one absolute deadline that nothing local may pause.
        if (phaseRef.current === 'memorize') return;

        const nextTime = Math.max(0, timeRef.current - (deltaMs / 1000));
        timeRef.current = nextTime;
        // Only when the DISPLAYED whole second changes — same fix as
        // DualTargetFlowClient/FingerSequencingClient. This ran 5x/sec
        // unconditionally, re-rendering the whole component (including the
        // up-to-36-cell grid, with no memo boundary) to paint an identical
        // picture 4 times out of 5. The ref above still has full precision
        // for the 0-check and scoring.
        setLocalTimeRemaining((prev) => (Math.ceil(prev) === Math.ceil(nextTime) ? prev : nextTime));

        if (nextTime <= 0) {
          endGame();
        }
      }, 200);

      scheduleHeartbeat();
      generateRound(sizeForLitCells(startLitCells), startLitCells);
    });
  }, [clearTimers, runCountdown, generateRound, endGame, scheduleHeartbeat, isChallenge, totalTime]);

  // Score card. Drawn and encoded while the result screen sits idle,
  // not on the tap - see useShareCard in components/ShareScoreCard.js.
  const shareDrillLink = useShareCard(endSummary ? {
    score: endSummary.score,
    bestScore: endSummary.prevBest ?? bestScore,
    accuracy: endSummary.accuracy,
    bestCombo: endSummary.bestCombo,
    rating: getGrade(endSummary.accuracy),
    newBest: endSummary.isNewBest,
    drillName: 'Grid Memorization',
    playerName: getPlayerName(),
  } : null, {
    url: APP_SHARE_URL,
    title: 'Grid Memorization — SkillDrills',
    text: endSummary ? `Scored ${endSummary.score} on Grid Memorization (${endSummary.accuracy}% accuracy, ${endSummary.bestCombo}x combo) — SkillDrills` : '',
  });

  useEffect(() => {
    setIsClient(true);

    // Take the status-bar area now, behind the 200ms loading screen, rather
    // than when the player taps START. overlaysWebView:true makes the window
    // layout size independent of whether the bar is showing, so this drill's
    // StatusBar.hide() no longer resizes the WebView under the "3 · 2 · 1 · GO"
    // overlay — which is what made the first digit shift into place.
    if (Capacitor.isNativePlatform()) StatusBar.setOverlaysWebView({ overlay: true }).catch(() => {});
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
      if (Capacitor.isNativePlatform()) {
        StatusBar.setOverlaysWebView({ overlay: false }).catch(() => {});
        StatusBar.show().catch(() => {});
      }
    };
  }, [clearTimers]);

  // Duel auto-start — both clients begin at the exact same wall-clock
  // instant via the shared matchStartAt timestamp (ARENA_INTEGRATION.md rule 2).
  const matchStartAt = useDuelMatchStart(challengeId);
  const duelAutoStartedRef = useRef(false);
  // The duel's shared start instant, on this device's clock. Held in a ref so
  // the match clock can read it without rebuilding its interval, and null
  // outside a duel so solo play keeps its own local countdown.
  const duelDeadlineRef = useRef(null);
  useEffect(() => {
    duelDeadlineRef.current = isChallenge ? matchStartAt : null;
  }, [isChallenge, matchStartAt]);
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

  return (
    <DrillWrapper
      drillName="Grid Memorization"
      category="cognitive"
      score={score}
      timeLeft={gameState === 'ended' ? 0 : Math.ceil(localTimeRemaining)}
      soundEnabled={soundEnabled}
      onSoundToggle={() => setSoundEnabled(v => { audioSynth?.setEnabled(!v); return !v; })}
      backHref="/"
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
             to fully transparent before reaching the edges — the flat
             version tinted the whole board (incl. grid text) evenly, worst
             in portrait where the grid fills most of the screen. */
          .fx-flash-red { background: radial-gradient(ellipse 30% 30% at 50% 50%, rgba(239,68,68,.35) 0%, rgba(239,68,68,.35) 30%, rgba(239,68,68,.15) 60%, transparent 92%); }
          /* success flashes are intentionally inert — see globals.css */
          .fx-flash-cyan { animation-name: none; background: none; }
        `}</style>

        {gameState === 'playing' && dangerLevel > 0.06 && (
          <div className="fx-vignette" style={{ '--v-min': Math.max(0.05, dangerLevel * 0.25), '--v-max': Math.min(0.55, dangerLevel * 0.75), animationDuration: `${heartbeatTempoRef.current}ms` }} />
        )}

        <div className="absolute inset-0 pointer-events-none" style={{ backgroundImage: 'linear-gradient(rgba(255,255,255,0.015) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.015) 1px, transparent 1px)', backgroundSize: '40px 40px' }} />

        {flashes.map((f) => (
          <div key={f.id} className={`fx-flash fx-flash-${f.variant}`} />
        ))}

        {(gameState === 'countdown' || gameState === 'playing') && (
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); setSoundEnabled((v) => { audioSynth?.setEnabled(!v); return !v; }); }}
            className="absolute bottom-5 right-5 z-40 p-2 before:absolute before:top-0 before:left-0 before:-right-[14px] before:-bottom-[14px] before:content-[''] rounded-full bg-black/60 border border-white/10 text-slate-400 active:scale-90 transition-transform cursor-pointer"
          >
            {soundEnabled ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
          </button>
        )}

        {/* ── START SCREEN ── */}
        {gameState === 'start' && !isChallenge && (
          <DrillStartCard
            drillName="Grid Memorization"
            tagline="Memorise the lit cells, tap them back"
            rules={[
              'Memorise the lit cells',
              'Grid grows every round',
              'Hits add time, misses cost it',
            ]}
            bestStrip={bestScore > 0 ? [
              { value: bestScore.toLocaleString(), label: 'Best · PTS' },
              { value: `${bestCombo}×`, label: 'Combo' },
              { value: String(bestLevel).padStart(2, '0'), label: 'Level' },
            ] : null}
            orientation="portrait"
            onStart={startGame}
          />
        )}

        {/* ── COUNTDOWN SCREEN ── */}
        {gameState === 'countdown' && !isChallenge && (
          <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/55">
            <span className="text-[11px] font-black uppercase tracking-[0.2em] text-slate-400">Get Ready</span>
            <div className="relative w-28 h-28 rounded-full border-[3px] border-indigo-500/20 flex items-center justify-center">
              <div className="absolute -inset-[3px] rounded-full border-[3px] border-transparent border-t-indigo-400 border-r-indigo-400 animate-spin" style={{ animationDuration: '0.7s' }} />
              <span key={countdownVal} className="fx-pop-in text-5xl font-display bg-gradient-to-b from-white to-indigo-300 bg-clip-text text-transparent">
                {countdownVal}
              </span>
            </div>
            <span className="text-[10px] text-slate-500">Pattern generates at GO</span>
          </div>
        )}

        {/* ── PLAYING ── */}
        {gameState === 'playing' && (
          <>
            <div className="absolute top-5 left-5 z-40 flex flex-col pointer-events-none select-none">
              <span className="text-2xl font-hud font-bold text-white leading-none tabular-nums">{score}</span>
            </div>

            {/* Timer overlay at top-right */}
            <div className="absolute top-5 right-5 z-40 flex flex-col items-end pointer-events-none select-none">
              <span className={`text-3xl font-hud font-bold leading-none tabular-nums ${localTimeRemaining <= 10 ? 'text-red-500 animate-pulse' : 'text-slate-300'}`}>
                {Math.ceil(localTimeRemaining)}s
              </span>
              <span className="text-[8px] label-tiny text-slate-500 mt-1">Time Left</span>
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
                  // Idle cells were bg-neutral-900/60 over a #050508 page with a
                  // white/[0.03] edge — about #101010 on #050508, so the board read as a
                  // black void and the player could not see where the cells were until one
                  // lit up. These are opaque and carry a visibly lighter edge, so the grid
                  // is legible before anything flashes, while still sitting far enough
                  // below the indigo/green/red flash colours that a lit cell is unmistakable.
                  let cellStyle = "bg-[#161d2c] border border-[#2f3b52]";
                  
                  if (phase === "memorize") {
                    if (isLit) cellStyle = "bg-indigo-500 shadow-[0_0_12px_rgba(99,102,241,0.5)] border-indigo-400 scale-[0.98]";
                  } 
                  else if (phase === "recall") {
                    if (userSelections.has(i)) cellStyle = "bg-cyan-500 shadow-[0_0_12px_rgba(6,182,212,0.5)] border-cyan-400 scale-[0.96]";
                    else cellStyle = "bg-[#1c2537] border border-[#3d4c66] active:scale-95 active:bg-[#2a3650] transition-all pointer-events-auto cursor-pointer";
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
          <ResultScreen
            signature
            summary={endSummary}
            bestScore={bestScore}
            synth={audioSynth}
            onPlayAgain={startGame}
            onShare={shareDrillLink}
          />
        )}
      </div>
    </DrillWrapper>
  );
}

