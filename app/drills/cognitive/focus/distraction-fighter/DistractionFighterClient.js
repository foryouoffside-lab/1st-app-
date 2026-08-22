'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
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

// ============================================================
// TUNING CONSTANTS
// ============================================================
const TOTAL_TIME = 45.0;
const MAX_LIVES = 5;
const MAX_LEVEL = 12;

const STROOP_COLORS = [
  { name: 'Red', hex: '#ef4444' },
  { name: 'Blue', hex: '#3b82f6' },
  { name: 'Green', hex: '#22c55e' },
  { name: 'Yellow', hex: '#eab308' },
  { name: 'Purple', hex: '#a855f7' },
  { name: 'Orange', hex: '#f97316' },
  { name: 'Pink', hex: '#ec4899' },
  { name: 'Cyan', hex: '#06b6d4' },
];

const deadlineForLevel = (lvl) => Math.max(400, 1500 - (lvl - 1) * 100);

const getOptionCountForLevel = (lvl) => {
  if (lvl <= 3) return 4;
  if (lvl <= 6) return 5;
  return 6;
};

// Fisher-Yates Shuffle
const fisherYatesShuffle = (arr) => {
  const array = [...arr];
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
};

// Both the ink color AND the word's own color name are guaranteed a slot
// among the options — not just the ink color. Whichever rule is live for
// this trial (see spawnTrial's ruleMode), the correct button has to actually
// be on screen, and revealing the rule via "is the answer even present"
// would give it away for free.
const getOptionsForTrial = (targetColor, textColor, optionCount) => {
  const excludeNames = new Set([targetColor.name, textColor.name]);
  const otherColors = STROOP_COLORS.filter(c => !excludeNames.has(c.name));
  const shuffledOthers = fisherYatesShuffle(otherColors);
  const decoys = shuffledOthers.slice(0, Math.max(0, optionCount - 2));
  return fisherYatesShuffle([targetColor, textColor, ...decoys]);
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
const STORAGE_KEY = 'skilldrills_distraction_fighter_v8';

const getSavedData = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
    return { bestScore: 0, bestCombo: 0, bestLevel: 1, totalSessions: 0 };
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
// MAIN CLIENT COMPONENT
// ============================================================
export default function DistractionFighterClient() {
  const searchParams = useSearchParams();
  const challengeId = searchParams ? searchParams.get('challengeId') : null;
  const isChallenge = !!challengeId;
  const totalTime = isChallenge ? 30 : TOTAL_TIME;

  // === Phase Machine State ===
  const [phase, setPhase] = useState('start'); // 'start' | 'countdown' | 'playing' | 'ended'
  const [countdownValue, setCountdownValue] = useState(3);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [isClient, setIsClient] = useState(false);

  // === Gameplay / Stroop States ===
  const [currentTrial, setCurrentTrial] = useState(null);
  const [options, setOptions] = useState([]);
  const [speedLevel, setSpeedLevel] = useState(1);

  // HUD variables
  const [score, setScore] = useState(0);
  const [timeRemaining, setTimeRemaining] = useState(totalTime);
  const [combo, setCombo] = useState(0);
  const [lives, setLives] = useState(MAX_LIVES);
  const [dangerLevel, setDangerLevel] = useState(0);

  // === Best stats ===
  const [bestScore, setBestScore] = useState(0);
  const [bestCombo, setBestCombo] = useState(0);
  const [bestLevel, setBestLevel] = useState(1);

  // === Result Summary & Feedback ===
  const [endSummary, setEndSummary] = useState(null);
  const [flashes, setFlashes] = useState([]);

  // === Engine Refs ===
  const containerRef = useRef(null);
  const animationRef = useRef(null);
  const gameActiveRef = useRef(false);
  const mountedRef = useRef(false);

  const lastTimeRef = useRef(0);
  const countdownTimerRef = useRef(null);
  const heartbeatTimerRef = useRef(null);
  const heartbeatTempoRef = useRef(1100);

  const scoreRef = useRef(0);
  const timeLeftRef = useRef(totalTime);
  const comboRef = useRef(0);
  const livesRef = useRef(MAX_LIVES);
  const maxStreakRef = useRef(0);
  const totalFramesRef = useRef(0);

  const deadlineRef = useRef(1500);
  const startDeadlineRef = useRef(1500);

  const trialActiveRef = useRef(false);
  const trialSpawnedAtRef = useRef(0);
  
  const correctCountRef = useRef(0);
  const wrongCountRef = useRef(0);
  const timeoutCountRef = useRef(0);

  const flashIdRef = useRef(0);
  const phaseRef = useRef('start');

  useEffect(() => {
    setIsClient(true);
    mountedRef.current = true;
    lockPortrait();
    const data = getSavedData();
    setBestScore(data.bestScore);
    setBestCombo(data.bestCombo);
    setBestLevel(data.bestLevel);

    const timer = setTimeout(() => setLoading(false), 150);
    return () => {
      clearTimeout(timer);
      mountedRef.current = false;
      gameActiveRef.current = false;
      if (countdownTimerRef.current) clearTimeout(countdownTimerRef.current);
      if (heartbeatTimerRef.current) clearTimeout(heartbeatTimerRef.current);
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
      unlockOrientation();
    };
  }, []);

  // Hide floating close controls during play
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

  useEffect(() => { if (audioSynth) audioSynth.setEnabled(soundEnabled); }, [soundEnabled]);

  const triggerFlash = (variant) => {
    flashIdRef.current += 1;
    const id = `${Date.now()}-${flashIdRef.current}`;
    setFlashes(prev => [...prev, { id, variant }]);
    setTimeout(() => {
      if (mountedRef.current) setFlashes(prev => prev.filter(f => f.id !== id));
    }, 150);
  };

  // DIFFICULTY RATCHET: Increases only on correct answers, never decreases on mistakes
  const updateStaircase = useCallback((isCorrect) => {
    if (isCorrect) {
      deadlineRef.current = Math.max(400, deadlineRef.current - 100);
    }

    const cosmeticLvl = Math.max(1, Math.floor((1500 - deadlineRef.current) / 100) + 1);
    setSpeedLevel(cosmeticLvl);
  }, []);

  const spawnTrial = useCallback(() => {
    if (timeLeftRef.current <= 0 || livesRef.current <= 0 || phaseRef.current !== 'playing') return;

    const targetColorObj = STROOP_COLORS[Math.floor(Math.random() * STROOP_COLORS.length)];

    let textColorObj;
    do {
      textColorObj = STROOP_COLORS[Math.floor(Math.random() * STROOP_COLORS.length)];
    } while (textColorObj.name === targetColorObj.name);

    // Two rules, picked fresh each trial: 'ink' is the original mechanic
    // (tap the physical ink color, ignore the word). 'word' flips it — tap
    // the color the word itself names, ignoring what it's actually printed
    // in. Randomizing per-trial (rather than fixing one rule for the whole
    // run) is the actual difficulty add the player asked for: autopilot on a
    // single fixed rule stops working, since the rule banner has to be read
    // every round.
    const ruleMode = Math.random() < 0.5 ? 'ink' : 'word';

    const cosmeticLvl = Math.max(1, Math.floor((1500 - deadlineRef.current) / 100) + 1);
    const optCount = getOptionCountForLevel(cosmeticLvl);
    const trialOptions = getOptionsForTrial(targetColorObj, textColorObj, optCount);

    const newTrial = {
      displayWord: textColorObj.name.toUpperCase(),
      hex: targetColorObj.hex,
      trueColorName: ruleMode === 'ink' ? targetColorObj.name : textColorObj.name,
      ruleMode,
      options: trialOptions,
      spawnedAt: performance.now()
    };

    setCurrentTrial(newTrial);
    setOptions(trialOptions);
    trialActiveRef.current = true;
    trialSpawnedAtRef.current = performance.now();
  }, []);

  const endGame = useCallback(async () => {
    if (phaseRef.current === 'ended') return;
    phaseRef.current = 'ended';
    setPhase('ended');
    gameActiveRef.current = false;

    if (animationRef.current) cancelAnimationFrame(animationRef.current);
    if (heartbeatTimerRef.current) clearTimeout(heartbeatTimerRef.current);

    audioSynth?.playResultsReveal();

    const totalClicks = correctCountRef.current + wrongCountRef.current + timeoutCountRef.current;
    const accuracyVal = totalClicks > 0 ? Math.round((correctCountRef.current / totalClicks) * 100) : 100;

    const bonuses = calcEndBonuses({
      rawScore: scoreRef.current,
      accuracy: accuracyVal,
      bestCombo: maxStreakRef.current,
      totalActions: totalClicks,
      mistakes: wrongCountRef.current + timeoutCountRef.current,
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
      : await previewDailyCompletion('distraction-fighter');

    const xpResult = calcSessionXP({
      finalScore,
      accuracy: accuracyVal,
      isNewBest,
      firstPlay,
      dailyChallenge: daily.isDailyDrill,
      dailyChallengeSetComplete: daily.wouldCompleteSet
    });

    const cosmeticLvl = Math.max(1, Math.floor((1500 - deadlineRef.current) / 100) + 1);

    const updated = {
      bestScore: Math.max(prev.bestScore, finalScore),
      bestCombo: Math.max(prev.bestCombo, maxStreakRef.current),
      bestLevel: Math.max(prev.bestLevel, cosmeticLvl),
      totalSessions: prev.totalSessions + 1,
    };
    saveData(updated);

    setBestScore(updated.bestScore);
    setBestCombo(updated.bestCombo);
    setBestLevel(updated.bestLevel);

    saveLeaderboardEntrySync({
      drillId: 'distraction-fighter',
      drillName: 'Distraction Fighter',
      category: 'cognitive',
      score: finalScore,
      accuracy: accuracyVal,
      bestCombo: maxStreakRef.current
    });

    setEndSummary({
      score: finalScore,
      accuracy: accuracyVal,
      bestCombo: maxStreakRef.current,
      xpEarned: xpResult.xp,
      isNewBest,
    });
  }, []);

  const resolveCorrect = useCallback(() => {
    audioSynth?.playHit();
    correctCountRef.current += 1;
    comboRef.current += 1;
    setCombo(comboRef.current);
    if (comboRef.current > maxStreakRef.current) {
      maxStreakRef.current = comboRef.current;
    }

    const reactionTimeMs = performance.now() - trialSpawnedAtRef.current;
    const cosmeticLvl = Math.max(1, Math.floor((1500 - deadlineRef.current) / 100) + 1);

    let pointsObj = { total: 6 };
    try {
      pointsObj = scoreAction({
        category: 'cognitive',
        reactionMs: reactionTimeMs,
        combo: comboRef.current,
        livesRemaining: livesRef.current,
        maxLives: MAX_LIVES,
        timeRemaining: timeLeftRef.current,
        totalGameTime: 45,
        level: cosmeticLvl,
        maxLevel: MAX_LEVEL
      });
    } catch (err) {
      const base = 6;
      const comboMult = getComboMultiplier(comboRef.current);
      const speedBonus = reactionTimeMs < 1200 ? Math.round(base * (1200 - reactionTimeMs) / 1200) : 0;
      pointsObj = { total: Math.round((base + speedBonus) * comboMult) };
    }

    scoreRef.current += pointsObj.total;
    setScore(scoreRef.current);

    updateStaircase(true);

    setTimeout(() => {
      if (phaseRef.current === 'playing') spawnTrial();
    }, 120);
  }, [spawnTrial, updateStaircase]);

  const resolveWrong = useCallback((kind) => {
    audioSynth?.playPenalty();
    comboRef.current = 0;
    setCombo(0);
    
    livesRef.current -= 1;
    setLives(Math.max(0, livesRef.current));

    if (kind === 'timeout') {
      timeoutCountRef.current += 1;
    } else {
      wrongCountRef.current += 1;
    }

    updateStaircase(false);
    triggerFlash('red');

    if (livesRef.current <= 0 || timeLeftRef.current <= 0) {
      endGame();
    } else {
      setTimeout(() => {
        if (phaseRef.current === 'playing') spawnTrial();
      }, 120);
    }
  }, [spawnTrial, endGame, updateStaircase]);

  useEffect(() => {
    if (phase !== 'playing') return;
    let lastTime = performance.now();

    const loop = (time) => {
      if (!gameActiveRef.current) return;
      // ~30fps cap — matches the rest of the catalog; dt still measures real
      // elapsed time between drawn frames since lastTime updates below.
      if (time - lastTime < 32) {
        animationRef.current = requestAnimationFrame(loop);
        return;
      }
      const dt = Math.min((time - lastTime) / 1000, 0.033);
      lastTime = time;

      totalFramesRef.current++;

      timeLeftRef.current -= dt;
      if (timeLeftRef.current <= 0) {
        timeLeftRef.current = 0;
        endGame();
        return;
      }

      if (trialActiveRef.current) {
        const elapsed = time - trialSpawnedAtRef.current;
        if (elapsed >= deadlineRef.current) {
          trialActiveRef.current = false;
          resolveWrong('timeout');
        }
      }

      if (totalFramesRef.current % 6 === 0) {
        setTimeRemaining(timeLeftRef.current);
        setScore(scoreRef.current);
      }

      animationRef.current = requestAnimationFrame(loop);
    };

    lastTimeRef.current = performance.now();
    animationRef.current = requestAnimationFrame(loop);

    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  }, [phase, endGame, resolveWrong]);

  const scheduleHeartbeat = useCallback(() => {
    if (isChallenge) return;
    if (!gameActiveRef.current) return;
    const dangerFromLives = (MAX_LIVES - livesRef.current) / MAX_LIVES;
    const dangerFromTime = timeLeftRef.current <= 10 ? (10 - timeLeftRef.current) / 10 : 0;
    const danger = Math.max(dangerFromLives * 0.7, dangerFromTime);
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

  const handleAnswer = (selectedName) => {
    if (phaseRef.current !== 'playing' || !trialActiveRef.current) return;
    trialActiveRef.current = false;

    const isCorrect = selectedName === currentTrial.trueColorName;
    if (isCorrect) {
      resolveCorrect();
    } else {
      resolveWrong('wrong');
    }
  };

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
      livesRef.current = MAX_LIVES;
      maxStreakRef.current = 0;
      totalFramesRef.current = 0;
      deadlineRef.current = startDeadlineRef.current;

      trialActiveRef.current = false;
      correctCountRef.current = 0;
      wrongCountRef.current = 0;
      timeoutCountRef.current = 0;

      const startLvl = Math.max(1, Math.floor((1500 - deadlineRef.current) / 100) + 1);

      setScore(0);
      setTimeRemaining(totalTime);
      setCombo(0);
      setLives(MAX_LIVES);
      setSpeedLevel(startLvl);
      setDangerLevel(0);
      setFlashes([]);

      spawnTrial();
      scheduleHeartbeat();
      return;
    }
    if (!isChallenge) audioSynth?.playCountdownTick();
    setCountdownValue(n);
    countdownTimerRef.current = setTimeout(() => runCountdown(n - 1), 700);
  }, [spawnTrial, scheduleHeartbeat, totalTime, isChallenge]);

  const enterDrill = useCallback(() => {
    audioSynth?.init();
    lockPortrait();

    gameActiveRef.current = false;
    if (countdownTimerRef.current) clearTimeout(countdownTimerRef.current);
    if (heartbeatTimerRef.current) clearTimeout(heartbeatTimerRef.current);
    if (animationRef.current) cancelAnimationFrame(animationRef.current);

    const saved = getSavedData();
    const savedBestLevel = Math.max(1, saved.bestLevel || 1);
    const startLevel = Math.max(1, Math.min(MAX_LEVEL, Math.round(savedBestLevel * 0.55)));
    startDeadlineRef.current = deadlineForLevel(startLevel);

    setScore(0);
    setTimeRemaining(totalTime);
    setCombo(0);
    setLives(MAX_LIVES);
    setDangerLevel(0);
    setFlashes([]);
    setEndSummary(null);

    setPhase('countdown');
    phaseRef.current = 'countdown';
    runCountdown(isChallenge ? 0 : 3);
  }, [runCountdown, isChallenge, totalTime]);

  const shareResult = useCallback(() => {
    if (!endSummary) return;
    const text = `Scored ${endSummary.score} on Distraction Fighter (${endSummary.accuracy}% accuracy, ${endSummary.bestCombo}x combo) — SkillDrills`;
    const url = 'https://skilldrills.online/drills/cognitive/focus/distraction-fighter';
    if (typeof navigator !== 'undefined' && navigator.share) {
      navigator.share({ title: 'Distraction Fighter — SkillDrills', text, url }).catch(() => {});
    } else if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(`${text} ${url}`);
    }
  }, [endSummary]);

  if (loading || !isClient) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-[#050508]">
        <div className="text-center">
          <div className="w-14 h-14 border-4 border-cyan-600 border-t-transparent rounded-full animate-spin mx-auto mb-4 shadow-[0_0_20px_rgba(6,182,212,0.5)]" />
          <p className="text-slate-500 font-bold tracking-widest uppercase text-[10px] animate-pulse">Loading Inhibition Engine...</p>
        </div>
      </div>
    );
  }

  return (
    <DrillWrapper
      drillName="Distraction Fighter"
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
        <div className="absolute inset-0 pointer-events-none" style={{ backgroundImage: 'linear-gradient(rgba(255,255,255,0.01) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.01) 1px, transparent 1px)', backgroundSize: '40px 40px' }} />

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
              <h1 className="text-[17px] font-bold tracking-tight text-white">Distraction Fighter</h1>
              <p className="text-[9px] font-bold text-slate-500 uppercase tracking-widest mt-1">45-second run</p>

              <div className="flex flex-col gap-1.5 text-left mt-3.5">
                <HowToRow icon={<Eye className="w-3.5 h-3.5 text-cyan-400 flex-shrink-0" />} node={<>Read the RULE banner every round</>} />
                <HowToRow icon={<Zap className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" />} node={<>It flips · tap the ink or the word</>} />
                <HowToRow icon={<Ban className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />} node={<>Wrong taps cost a life · 5 lives</>} />
              </div>

              <div className="grid grid-cols-3 gap-1.5 mt-3.5">
                <MiniStat label="Best" value={bestScore} color="text-yellow-400" />
                <MiniStat label="Combo" value={`${bestCombo}x`} color="text-orange-400" />
                <MiniStat label="Level" value={`Lv.${bestLevel}`} color="text-cyan-400" />
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
                {isChallenge ? (
                  <span className="text-[10px] font-black text-cyan-300 bg-cyan-500/15 border border-cyan-500/25 px-1.5 py-0.5 rounded">
                    Lv.{speedLevel}
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
              <span className={`text-3xl font-black font-mono leading-none tabular-nums ${timeRemaining <= 10 ? 'text-red-500 animate-pulse' : 'text-slate-300'}`}>
                {Math.ceil(timeRemaining)}s
              </span>
              <span className="text-[8px] text-slate-500 font-bold uppercase tracking-widest mt-1">Time Left</span>
            </div>

            {/* Main Stroop Word Display Area */}
            <div className="relative w-full h-[100dvh] flex flex-col items-center justify-center p-4">
              <div className="flex-1 flex flex-col items-center justify-center">
                {currentTrial && (
                  <div
                    className={`mb-4 px-3.5 py-1.5 rounded-full border text-[10px] font-black uppercase tracking-wider select-none ${
                      currentTrial.ruleMode === 'ink'
                        ? 'border-cyan-500/30 bg-cyan-500/10 text-cyan-300'
                        : 'border-amber-500/30 bg-amber-500/10 text-amber-300'
                    }`}
                  >
                    Rule: {currentTrial.ruleMode === 'ink' ? 'Select the Color of Text' : 'Select the Color'}
                  </div>
                )}
                {currentTrial && (
                  <span
                    className="text-6xl sm:text-7xl font-black uppercase tracking-widest transition-all drop-shadow-[0_2px_15px_rgba(0,0,0,0.6)] animate-pulse select-none"
                    style={{ color: currentTrial.hex }}
                  >
                    {currentTrial.displayWord}
                  </span>
                )}
              </div>


              {/* Color Options Grid */}
              <div className="w-full max-w-sm flex flex-col items-center select-none mb-2">
                {currentTrial && (
                  <div 
                    className={`grid gap-2.5 w-full ${
                      options.length === 4 ? 'grid-cols-2' : 'grid-cols-3'
                    }`}
                  >
                    {options.map((opt) => (
                      <button
                        key={opt.name}
                        onPointerDown={() => handleAnswer(opt.name)}
                        disabled={phase === 'countdown'}
                        className="py-3.5 px-2 bg-slate-900 border border-white/15 rounded-2xl text-white font-black text-sm active:scale-95 hover:bg-slate-800 transition-all cursor-pointer shadow-[0_4px_10px_rgba(0,0,0,0.3)] select-none text-center"
                      >
                        {opt.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
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
            <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">Inhibition Mode</span>
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
// UTILITY SUBCOMPONENTS
// ==========================================

function HowToRow({ icon, node }) {
  return (
    <div className="flex items-center gap-2 bg-white/[0.02] border border-white/5 rounded-[10px] px-2.5 py-[7px]">
      {icon}
      <span className="text-[10.5px] text-slate-300 leading-tight font-medium whitespace-nowrap">{node}</span>
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