'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import { 
  Compass, Volume2, VolumeX, Eye, Zap, Ban
} from 'lucide-react';
import { scoreAction, calcEndBonuses, calcSessionXP, getGrade, getComboMultiplier } from '../../../../../lib/scoringEngine';
import {
  rampToFloor, applyHit, applyMistake, scoringMaxLevel, scoringLives,
} from '../../../../../lib/drillRules';
import { saveLeaderboardEntrySync } from '../../../../../lib/leaderboard';
import { lockPortrait, unlockOrientation } from '../../../../../lib/orientation';
import { previewDailyCompletion } from '../../../../../lib/dailyChallenge';
import { getPlayerName, getPlayerLevel } from '../../../../../lib/progressStore';
import { useShareCard } from '../../../../../components/ShareScoreCard';
import DrillWrapper from '../../../../../components/DrillWrapper';
import { useDuelMatchStart, duelSecondsRemaining } from '../../../../../lib/challengeEngine';
import { APP_SHARE_URL } from '../../../../../lib/shareLinks';
import ResultScreen from '../../../../../components/drill/ResultScreen';

// ============================================================
// TUNING CONSTANTS
// ============================================================
const TOTAL_TIME = 45.0;

// How a solo run is won and lost — the clock as the only fail state, what a hit
// earns, what a mistake costs — is defined once in lib/drillRules.js and shared
// by every drill. Read that file for the model and the reasoning.
//
// This drill is the one exception to "difficulty ramps forever". Its difficulty
// IS the grid size, and grid size is capped by the PHONE SCREEN, not by taste —
// an 11x11 grid of tappable numbers does not fit on a handset (see
// getMaxGridCeiling: 7 on narrow devices, 8 otherwise). So the board stops
// growing at level 5-6 and cannot be pushed further.
//
// The ramp therefore moves to the clock instead. Level counts BOARDS CLEARED,
// not grid size, so it keeps climbing after the grid caps out; clearing a board
// used to hand back a flat full 45s, which meant a player who could clear the
// biggest grid refilled faster than the clock drained and would never finish.
// Now the refill decays toward a floor, forever. The board stays humane, the
// clock gets meaner, and the run always ends.
const BOARD_REFILL_START = 45.0;
const BOARD_REFILL_FLOOR = 6.0;
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
  } catch {
    return { bestScore: 0, bestGrid: 3, bestCombo: 0, totalSessions: 0 };
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
export default function ConcentrationGridClient() {
  const searchParams = useSearchParams();
  const challengeId = searchParams ? searchParams.get('challengeId') : null;
  const isChallenge = !!challengeId;
  const totalTime = isChallenge ? 30 : TOTAL_TIME;
  const matchStartAt = useDuelMatchStart(challengeId);
  const duelAutoStartedRef = useRef(false);
  // The duel's shared start instant, on this device's clock. Held in a ref so
  // the match clock below can read it without rebuilding its interval, and
  // null outside a duel so solo play keeps its own local countdown.
  const duelDeadlineRef = useRef(null);
  useEffect(() => {
    duelDeadlineRef.current = isChallenge ? matchStartAt : null;
  }, [isChallenge, matchStartAt]);

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
  // The live "Lv." HUD badge was the only thing that ever READ this, so the
  // React state went with it. The ramp itself runs off levelRef, which the
  // game loop already uses; keeping a useState in step with it only bought a
  // re-render of the whole drill on every level-up, mid-play, for nothing.
  const [timeRemaining, setTimeRemaining] = useState(totalTime);
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
  const runOverRef = useRef(false);
  const comboRef = useRef(0);
  const maxStreakRef = useRef(0);
  const gridSizeRef = useRef(3);
  // Boards cleared + 1. This is the real level — it keeps rising after the grid
  // stops growing, which is what lets the clock keep tightening.
  const levelRef = useRef(1);
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
    const accuracyVal = totalClicks > 0 ? Math.round((correctClicksRef.current / totalClicks) * 100) : 0;

    const bonuses = calcEndBonuses({
      rawScore: scoreRef.current,
      accuracy: accuracyVal,
      bestCombo: maxStreakRef.current,
      totalActions: totalClicks,
      mistakes: penaltyCountRef.current,
      livesRemaining: scoringLives(0),
      category: 'cognitive'
    });

    const finalScore = bonuses.finalScore;

    const prev = getSavedData();
    const isNewBest = finalScore > prev.bestScore;
    const firstPlay = prev.totalSessions === 0;

    const daily = isChallenge
      ? { isDailyDrill: false, wouldCompleteSet: false }
      : await previewDailyCompletion('concentration-grid');

    // Captured BEFORE the run is banked: the result screen's XP bar animates
    // from the level the player walked in with to the one they walk out with.
    const progress = await getPlayerLevel();

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
      progress,
      score: finalScore,
      accuracy: accuracyVal,
      peakGrid: gridSizeRef.current,
      bestCombo: maxStreakRef.current,
      xpEarned: xpResult.xp,
      isNewBest,
      prevBest: prev.bestScore,
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
          livesRemaining: scoringLives(0),
          timeRemaining: timeLeftRef.current,
          totalGameTime: totalTime,
          level: levelRef.current,
          maxLevel: scoringMaxLevel(isChallenge)
        });
      } catch {
        const base = 6;
        const comboMult = getComboMultiplier(comboRef.current);
        const speedBonus = reactionTimeMs < 1200 ? Math.round(base * (1200 - reactionTimeMs) / 1200) : 0;
        pointsObj = { total: Math.round((base + speedBonus) * comboMult) };
      }

      let pointsToAdd = pointsObj.total;
      scoreRef.current += pointsToAdd;
      // Buy back a slice of the clock. Solo only - in a duel the clock comes from
      // duelDeadlineRef (the match's shared absolute end instant), which nothing
      // local may move. No state is set here; the existing tick redraws the
      // seconds when the displayed number changes, so this costs nothing per hit.
      // Clamped to this drill's own 45s, not the shared SOLO_RULES.TIME_CAP of
      // 60 that applyHit() enforces. The endurance economy is unchanged — hits
      // and board clears still buy the clock back — but the bar a player is
      // playing against is the one the start card promises ("45s per board"),
      // instead of quietly banking up to a further 15 seconds on a strong run.
      if (!isChallenge) {
        timeLeftRef.current = Math.min(
          totalTime,
          applyHit({ timeRemaining: timeLeftRef.current, level: levelRef.current })
        );
      }

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
          const refill = rampToFloor(levelRef.current, BOARD_REFILL_START, BOARD_REFILL_FLOOR);
          // Same 45s ceiling as the per-hit reward above.
          timeLeftRef.current = Math.min(totalTime, timeLeftRef.current + refill);
          runOverRef.current = false;
          setTimeRemaining(Math.ceil(timeLeftRef.current));
        }

        // Clearing a board is a level, whether or not the grid can still grow.
        levelRef.current += 1;

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

      triggerFlash('red');

      if (isChallenge) {
        scoreRef.current = Math.max(0, scoreRef.current - 5);
        setScore(scoreRef.current);
        syncGridDataToState();
        return;
      }

      const after = applyMistake({ timeRemaining: timeLeftRef.current });
      timeLeftRef.current = after.timeRemaining;
      runOverRef.current = after.runOver;
      setTimeRemaining(Math.ceil(timeLeftRef.current));

      if (runOverRef.current) {
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
      // In a duel the clock is read from the match's shared absolute end
      // instant, never accumulated locally — see duelSecondsRemaining. A
      // tick that lands late (busy frame, GC pause, the OS throttling a
      // backgrounded webview) must cost this player frames, not extra
      // seconds of play their opponent never got.
      timeLeftRef.current = duelDeadlineRef.current
        ? duelSecondsRemaining(duelDeadlineRef.current)
        : Math.max(0, timeLeftRef.current - 0.2);
      // Flush the authoritative score alongside the clock so DrillWrapper's
      // duel score-sync and final submit always see the latest value. Guarded
      // so an unchanged score costs nothing — between taps this fires 5 times a
      // second with the same number.
      setScore((v) => (v === scoreRef.current ? v : scoreRef.current));
      if (timeLeftRef.current <= 0) {
        setTimeRemaining(0);
        endGame();
        return;
      }
      // Quantised to the second it is DISPLAYED at. The clock is only ever read
      // through Math.ceil (the HUD and DrillWrapper's timeLeft prop), but a raw
      // float differs on every tick, so React could never bail out and this
      // re-rendered the whole 5x5 grid 5 times a second for the entire run.
      const shown = Math.ceil(timeLeftRef.current);
      setTimeRemaining((v) => (v === shown ? v : shown));
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
      runOverRef.current = false;
      comboRef.current = 0;
      maxStreakRef.current = 0;
      gridSizeRef.current = startGridRef.current;
      levelRef.current = 1;

      currentNumberRef.current = 1;
      foundNumbersSetRef.current.clear();
      correctClicksRef.current = 0;
      totalClicksRef.current = 0;
      penaltyCountRef.current = 0;

      setScore(0);
      setTimeRemaining(totalTime);
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
      // Every run starts at the lowest difficulty. It used to start at 55% of the
      // player's best level, so improving once permanently raised the speed every
      // future run opened at - a silent spike with nothing on screen explaining it.
      // That head-start only existed because a fixed 45s was too short to climb the
      // ramp; the endurance clock replaces it.
      startGridRef.current = 3;
    }

    setScore(0);
    setTimeRemaining(totalTime);
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
    setEndSummary(null);
    setTimeRemaining(totalTime);
    timeLeftRef.current = totalTime;
    runOverRef.current = false;
  }, [challengeId, totalTime]);

  // Score card. Drawn and encoded while the result screen sits idle,
  // not on the tap - see useShareCard in components/ShareScoreCard.js.
  const shareResult = useShareCard(endSummary ? {
    score: endSummary.score,
    bestScore: endSummary.prevBest ?? bestScore,
    accuracy: endSummary.accuracy,
    bestCombo: endSummary.bestCombo,
    rating: getGrade(endSummary.accuracy),
    newBest: endSummary.isNewBest,
    drillName: 'Concentration Grid',
    playerName: getPlayerName(),
  } : null, {
    url: APP_SHARE_URL,
    title: 'Concentration Grid — SkillDrills',
    text: endSummary ? `Scored ${endSummary.score} on Concentration Grid (${endSummary.accuracy}% accuracy, ${endSummary.bestCombo}x combo) — SkillDrills` : '',
  });

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
      soundEnabled={soundEnabled}
      onSoundToggle={() => setSoundEnabled((v) => { audioSynth?.setEnabled(!v); return !v; })}
      backHref="/"
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
              <h1 className="lock-mark snap font-display text-[32px] sm:text-[38px] text-white mx-auto" style={{ '--lm': '#06b6d4' }}>Concentration Grid</h1>
              <p className="text-[9px] rdg-unit text-slate-500 mt-2">45s per board</p>

              <div className="flex flex-col gap-1.5 text-left mt-3.5">
                <HowToRow icon={<Eye className="w-3.5 h-3.5 text-cyan-400 flex-shrink-0" />} node={<>Tap the numbers in order from 1</>} />
                <HowToRow icon={<Zap className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" />} node={<>Grid grows with each board</>} />
                <HowToRow icon={<Ban className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />} node={<>Hits add time, misses cost it</>} />
              </div>

              {bestScore > 0 && (
                <div className="grid grid-cols-3 gap-1.5 mt-3.5">
                  <MiniStat label="Best" value={bestScore} color="text-yellow-400" />
                  <MiniStat label="Combo" value={`${bestCombo}x`} color="text-orange-400" />
                  <MiniStat label="Level" value={`Lv.${bestGrid - 2}`} color="text-cyan-400" />
                </div>
              )}

              <button
                onClick={enterDrill}
                className="lock-btn mt-3.5"
                style={{ '--lb': '#06b6d4' }}
              >
                Start
              </button>
            </div>
          </div>
        )}

        {/* ── PLAYING ── */}
        {(phase === 'playing' || phase === 'countdown') && (
          <>
            <div className="absolute top-5 left-5 z-40 flex flex-col pointer-events-none select-none">
              <span className="text-2xl font-hud font-bold text-white leading-none tabular-nums">{score}</span>
            </div>

            {/* Timer overlay top-right */}
            <div className="absolute top-5 right-5 z-40 flex flex-col items-end pointer-events-none select-none">
              <span className={`text-3xl font-hud font-bold leading-none tabular-nums ${timeRemaining <= 10 ? 'text-red-500 animate-pulse' : 'text-slate-300'}`}>
                {Math.ceil(timeRemaining)}s
              </span>
              <span className="text-[8px] label-tiny text-slate-500 mt-1">Time Left</span>
            </div>

            {/* Target indicator — solid fill instead of backdrop-blur: this
                badge is on-screen for the whole match, and blur compositing
                that runs continuously for the entire drill (unlike the
                start/countdown overlays' one-time blur) is a real CPU cost
                for zero visible difference against this near-opaque fill. */}
            <div className="absolute top-5 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 border border-white/10 rounded-full px-4 py-1.5 pointer-events-none select-none" style={{ background: 'rgba(5,5,8,0.94)' }}>
              <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider">Find</span>
              <span className="text-lg font-black text-cyan-400 leading-none">{currentNumber}</span>
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
          <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/55">
            <span className="text-[11px] font-black uppercase tracking-[0.2em] text-slate-400">Get Ready</span>
            <div className="relative w-28 h-28 rounded-full border-[3px] border-cyan-500/20 flex items-center justify-center">
              <div className="absolute -inset-[3px] rounded-full border-[3px] border-transparent border-t-cyan-400 border-r-cyan-400 animate-spin" style={{ animationDuration: '0.7s' }} />
              <span key={countdownValue} className="fx-pop-in text-5xl font-display bg-gradient-to-b from-white to-cyan-300 bg-clip-text text-transparent">
                {countdownValue > 0 ? countdownValue : 'GO'}
              </span>
            </div>
            <span className="text-[10px] text-slate-500">Grid generates at GO</span>
          </div>
        )}

        {/* ── RESULT SCREEN ── */}
        {phase === 'ended' && endSummary && !isChallenge && (
          <ResultScreen
            summary={endSummary}
            bestScore={bestScore}
            accent="from-cyan-600 to-blue-600"
            lockColor="#06b6d4"
            synth={audioSynth}
            onPlayAgain={enterDrill}
            onShare={shareResult}
          />
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
      <div className={`text-[16px] font-display tabular ${color}`}>{value}</div>
      <div className="text-[7px] rdg-unit text-slate-500 mt-0.5">{label}</div>
    </div>
  );
}

