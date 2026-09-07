'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  Compass, Volume2, VolumeX, Eye, Zap, Ban
} from 'lucide-react';

import { scoreAction, calcEndBonuses, calcSessionXP, getGrade, getComboMultiplier } from '../../../../../lib/scoringEngine';
import {
  applyHit, applyMistake, scoringMaxLevel, scoringLives,
} from '../../../../../lib/drillRules';
import { saveLeaderboardEntrySync } from '../../../../../lib/leaderboard';
import { lockPortrait, unlockOrientation } from '../../../../../lib/orientation';
import { previewDailyCompletion } from '../../../../../lib/dailyChallenge';
import { getPlayerName, getPlayerLevel } from '../../../../../lib/progressStore';
import { useShareCard } from '../../../../../components/ShareScoreCard';
import DrillWrapper from '../../../../../components/DrillWrapper';
import { APP_SHARE_URL } from '../../../../../lib/shareLinks';
import ResultScreen from '../../../../../components/drill/ResultScreen';

// ============================================================
// TUNING CONSTANTS
// ============================================================
const TOTAL_TIME = 45.0;

// Seconds a correct action buys, overriding the shared TIME_PER_HIT.
//
// The shared 1.0s is calibrated for a STREAM drill — several targets alive at
// once, two to three actions a second. This drill is one action per round:
// one Stroop answer per round (~0.75s).
// Against a clock that drains 1s per second that cadence could not refill at
// any accuracy, so the run was a flat TOTAL_TIME every time and skill could
// not extend it — the endurance model silently doing nothing.
// 1.2 makes 80% accuracy the break-even bar. See rewardForActionRate() in
// lib/drillRules.js, and recompute this if the round window is retuned.
const TIME_PER_HIT = 1.2;


// How a solo run is won and lost — the clock as the only fail state, what a hit
// earns, what a mistake costs — is defined once in lib/drillRules.js and shared
// by every drill. Read that file for the model and the reasoning.
//
// This drill needs no level ramp of its own: its difficulty is an ADAPTIVE
// STAIRCASE (updateStaircase) that tightens the response deadline when you get
// answers right and loosens it when you don't, already floored at
// DEADLINE_FLOOR_MS. That converges on each player's real limit, which is what
// the shared ramp is trying to do anyway — so it stays as it is. What a
// staircase can't do is END a run: by design it settles at a deadline you CAN
// sustain. The decaying time-per-hit payout in drillRules does that instead,
// keyed off the staircase's own speed level.
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

const DEADLINE_FLOOR_MS = 400;
// How much shorter the word stays on screen after each correct answer.
const DEADLINE_STEP_MS = 50;

const deadlineForLevel = (lvl) => Math.max(DEADLINE_FLOOR_MS, 1500 - (lvl - 1) * 100);

// Always four buttons, at every level. The drill's difficulty is the response
// deadline, not the size of the search. Adding a 5th and 6th option deeper in
// a run changes the task from "resolve the conflict" into "scan a bigger grid"
// — a different skill, on a two-column layout that also has to reflow to three
// columns mid-run, moving every button out from under the player's thumb at
// exactly the moment the clock is tightest.
const OPTION_COUNT = 4;

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
// among the options — not just the answer. The wrong one of the pair is the
// drill's whole point: it is the trap the rule tells you to ignore, and if it
// were sometimes absent the player could answer by elimination instead of by
// inhibition. The remaining two slots are unrelated decoys.
const getOptionsForTrial = (targetColor, textColor) => {
  const excludeNames = new Set([targetColor.name, textColor.name]);
  const otherColors = STROOP_COLORS.filter(c => !excludeNames.has(c.name));
  const shuffledOthers = fisherYatesShuffle(otherColors);
  const decoys = shuffledOthers.slice(0, OPTION_COUNT - 2);
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
const STORAGE_KEY = 'skilldrills_distraction_fighter_v8';

const getSavedData = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
    return { bestScore: 0, bestCombo: 0, bestLevel: 1, totalSessions: 0 };
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
  // The staircase's speed level. This used to be React state mirrored into a
  // ref; the live "Lv." HUD badge was the only thing that ever READ the state,
  // so it went with the badge. The ref is the real one — the game loop and the
  // callbacks read it directly, which also avoids the stale-value capture a
  // state read inside those callbacks would have had.
  const speedLevelRef = useRef(1);
  // HUD variables
  const [score, setScore] = useState(0);
  const [timeRemaining, setTimeRemaining] = useState(totalTime);
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
  const runOverRef = useRef(false);
  const comboRef = useRef(0);
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
  // Last values actually pushed to state from the render loop — see the HUD
  // sync note in the loop.
  const hudTimeRef = useRef(-1);
  const hudScoreRef = useRef(-1);

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

  useEffect(() => { if (audioSynth) audioSynth.setEnabled(soundEnabled); }, [soundEnabled]);

  const triggerFlash = (variant) => {
    flashIdRef.current += 1;
    const id = `${Date.now()}-${flashIdRef.current}`;
    setFlashes(prev => [...prev, { id, variant }]);
    setTimeout(() => {
      if (mountedRef.current) setFlashes(prev => prev.filter(f => f.id !== id));
    }, 150);
  };

  // DIFFICULTY RATCHET: the only thing that escalates is how long the word
  // stays on screen. It tightens on every correct answer and never loosens on
  // a mistake, so the drill gets harder as the player performs and a slip
  // costs a life rather than handing back time.
  //
  // The step used to be 100ms, which hit the 400ms floor after eleven correct
  // answers — about fifteen seconds into a 45-second run, leaving two thirds
  // of it flat at maximum speed. At 50ms the squeeze is spread across roughly
  // twenty-two answers, so it is still tightening right to the end and the
  // per-trial change is small enough to chase rather than trip over.
  const updateStaircase = useCallback((isCorrect) => {
    if (isCorrect) {
      deadlineRef.current = Math.max(DEADLINE_FLOOR_MS, deadlineRef.current - DEADLINE_STEP_MS);
    }

    const cosmeticLvl = Math.max(1, Math.floor((1500 - deadlineRef.current) / 100) + 1);
    speedLevelRef.current = cosmeticLvl;

  }, []);

  const spawnTrial = useCallback(() => {
    if (timeLeftRef.current <= 0 || runOverRef.current || phaseRef.current !== 'playing') return;

    const targetColorObj = STROOP_COLORS[Math.floor(Math.random() * STROOP_COLORS.length)];

    let textColorObj;
    do {
      textColorObj = STROOP_COLORS[Math.floor(Math.random() * STROOP_COLORS.length)];
    } while (textColorObj.name === targetColorObj.name);

    // ONE RULE, FULL STOP: tap the colour the word is PRINTED in, ignore what
    // it says. It is the same on every trial of every run, so there is nothing
    // on screen the player has to check before answering.
    //
    // There used to be a second rule ('word' — tap the colour the word NAMES)
    // rolled per run, with a banner in the play area saying which way round
    // this run was. Two rules means the player does two jobs: resolve the
    // Stroop conflict AND remember/re-read which direction applies. The second
    // job is banner-reading, not inhibition, and it drowns out the thing the
    // drill trains. Fixing the rule lets the automatic response form; the
    // escalating deadline in updateStaircase is what makes the run hard.
    const trialOptions = getOptionsForTrial(targetColorObj, textColorObj);

    const newTrial = {
      displayWord: textColorObj.name.toUpperCase(),
      hex: targetColorObj.hex,
      trueColorName: targetColorObj.name,
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
    const accuracyVal = totalClicks > 0 ? Math.round((correctCountRef.current / totalClicks) * 100) : 0;

    const bonuses = calcEndBonuses({
      rawScore: scoreRef.current,
      accuracy: accuracyVal,
      bestCombo: maxStreakRef.current,
      totalActions: totalClicks,
      mistakes: wrongCountRef.current + timeoutCountRef.current,
      livesRemaining: scoringLives(0),
      category: 'cognitive'
    });

    const finalScore = bonuses.finalScore;

    const prev = getSavedData();
    const isNewBest = finalScore > prev.bestScore;
    const firstPlay = prev.totalSessions === 0;

    const daily = isChallenge
      ? { isDailyDrill: false, wouldCompleteSet: false }
      : await previewDailyCompletion('distraction-fighter');

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
      progress,
      score: finalScore,
      accuracy: accuracyVal,
      bestCombo: maxStreakRef.current,
      xpEarned: xpResult.xp,
      isNewBest,
      prevBest: prev.bestScore,
    });
  }, []);

  const resolveCorrect = useCallback(() => {
    audioSynth?.playHit();
    correctCountRef.current += 1;
    comboRef.current += 1;
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
        livesRemaining: scoringLives(0),
        timeRemaining: timeLeftRef.current,
        totalGameTime: 45,
        level: cosmeticLvl,
        maxLevel: scoringMaxLevel(isChallenge)
      });
    } catch {
      const base = 6;
      const comboMult = getComboMultiplier(comboRef.current);
      const speedBonus = reactionTimeMs < 1200 ? Math.round(base * (1200 - reactionTimeMs) / 1200) : 0;
      pointsObj = { total: Math.round((base + speedBonus) * comboMult) };
    }

    scoreRef.current += pointsObj.total;
    // Buy back a slice of the clock. Solo only - in a duel the clock comes from
    // duelDeadlineRef (the match's shared absolute end instant), which nothing
    // local may move. No state is set here; the existing tick redraws the
    // seconds when the displayed number changes, so this costs nothing per hit.
    if (!isChallenge) {
      timeLeftRef.current = applyHit({ timeRemaining: timeLeftRef.current, level: speedLevelRef.current, reward: TIME_PER_HIT });
    }
    setScore(scoreRef.current);

    updateStaircase(true);

    setTimeout(() => {
      if (phaseRef.current === 'playing') spawnTrial();
    }, 120);
  }, [spawnTrial, updateStaircase]);

  const resolveWrong = useCallback((kind) => {
    audioSynth?.playPenalty();
    comboRef.current = 0;
    
    const after = applyMistake({ timeRemaining: timeLeftRef.current });
    timeLeftRef.current = after.timeRemaining;
    runOverRef.current = after.runOver;
    setTimeRemaining(Math.ceil(timeLeftRef.current));

    if (kind === 'timeout') {
      timeoutCountRef.current += 1;
    } else {
      wrongCountRef.current += 1;
    }

    updateStaircase(false);
    triggerFlash('red');

    if (runOverRef.current || timeLeftRef.current <= 0) {
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

      // HUD sync, straight out of the render loop.
      //
      // This was `every 6th frame, push both`, and both halves were wrong.
      // A frame counter is not a clock — 6 frames is 100ms on a steady 60Hz
      // panel but anything from 60ms to 200ms on a WebView that jitters — and
      // `timeLeftRef` is a raw float, so the pushed value ALWAYS differed from
      // the last one and React could never bail out. The result was a full
      // re-render of the trial, the option buttons, the vignette and the lives
      // row roughly ten times a second, scheduled from inside the animation
      // loop itself, for the entire run.
      //
      // Both values are now pushed only when what they DISPLAY changes: the
      // clock renders through Math.ceil, and the score is an integer that only
      // moves when the player answers. On a quiet frame this costs two integer
      // comparisons and no render at all.
      // Compared against a plain ref rather than handed to a functional
      // updater: this runs every frame, and a ref comparison is a couple of
      // instructions where entering React's update path at all is not.
      const shownTime = Math.ceil(timeLeftRef.current);
      if (hudTimeRef.current !== shownTime) {
        hudTimeRef.current = shownTime;
        setTimeRemaining(shownTime);
      }
      if (hudScoreRef.current !== scoreRef.current) {
        hudScoreRef.current = scoreRef.current;
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
    // Time is the only danger there is now — the lives term went with the lives.
    const dangerFromTime = timeLeftRef.current <= 10 ? (10 - timeLeftRef.current) / 10 : 0;
    const danger = Math.min(1, Math.max(0, dangerFromTime));
    // Clamped: an unclamped tempo goes NEGATIVE once danger exceeds ~1.69, and
    // a setTimeout with a negative delay fires
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
      maxStreakRef.current = 0;
      totalFramesRef.current = 0;
      hudTimeRef.current = -1;
      hudScoreRef.current = -1;
      deadlineRef.current = startDeadlineRef.current;

      trialActiveRef.current = false;
      correctCountRef.current = 0;
      wrongCountRef.current = 0;
      timeoutCountRef.current = 0;

        setScore(0);
      setTimeRemaining(totalTime);

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

    // Every run starts at the lowest difficulty. It used to start at 55% of the
    // player's best level, so improving once permanently raised the speed every
    // future run opened at - a silent spike with nothing on screen explaining it.
    // That head-start only existed because a fixed 45s was too short to climb the
    // ramp; the endurance clock replaces it.
    startDeadlineRef.current = deadlineForLevel(1);

    setScore(0);
    setTimeRemaining(totalTime);
    setDangerLevel(0);
    setFlashes([]);
    setEndSummary(null);

    setPhase('countdown');
    phaseRef.current = 'countdown';
    runCountdown(isChallenge ? 0 : 3);
  }, [runCountdown, isChallenge, totalTime]);

  // Score card. Drawn and encoded while the result screen sits idle,
  // not on the tap - see useShareCard in components/ShareScoreCard.js.
  const shareResult = useShareCard(endSummary ? {
    score: endSummary.score,
    bestScore: endSummary.prevBest ?? bestScore,
    accuracy: endSummary.accuracy,
    bestCombo: endSummary.bestCombo,
    rating: getGrade(endSummary.accuracy),
    newBest: endSummary.isNewBest,
    drillName: 'Distraction Fighter',
    playerName: getPlayerName(),
  } : null, {
    url: APP_SHARE_URL,
    title: 'Distraction Fighter — SkillDrills',
    text: endSummary ? `Scored ${endSummary.score} on Distraction Fighter (${endSummary.accuracy}% accuracy, ${endSummary.bestCombo}x combo) — SkillDrills` : '',
  });

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
              <h1 className="font-display text-[32px] sm:text-[38px] text-white">Distraction Fighter</h1>
              <p className="text-[9px] label-tiny text-slate-500 mt-1">Endurance run</p>

              <div className="flex flex-col gap-1.5 text-left mt-3.5">
                {/* Rules are capped at ~34 chars — the whitespace-nowrap in
                    HowToRow is load-bearing, longer strings overflow the card. */}
                <HowToRow icon={<Eye className="w-3.5 h-3.5 text-cyan-400 flex-shrink-0" />} node={<>Tap the INK color, not the word</>} />
                <HowToRow icon={<Zap className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" />} node={<>Same rule every run · no flips</>} />
                <HowToRow icon={<Ban className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />} node={<>Hits add time, misses cost it</>} />
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
              <span className="text-2xl font-hud font-bold text-white leading-none tabular-nums">{score}</span>
            </div>

            {/* Timer overlay at top-right */}
            <div className="absolute top-5 right-5 z-40 flex flex-col items-end pointer-events-none select-none">
              <span className={`text-3xl font-hud font-bold leading-none tabular-nums ${timeRemaining <= 10 ? 'text-red-500 animate-pulse' : 'text-slate-300'}`}>
                {Math.ceil(timeRemaining)}s
              </span>
              <span className="text-[8px] label-tiny text-slate-500 mt-1">Time Left</span>
            </div>

            {/* Main Stroop Word Display Area */}
            <div className="relative w-full h-[100dvh] flex flex-col items-center justify-center p-4">
              <div className="flex-1 flex flex-col items-center justify-center">
                {/* No rule banner in the play area. The rule never varies now
                    (see spawnTrial), so a permanent caption inside the board
                    is one more thing competing with the word for attention and
                    nothing to learn from it. It is stated on the start card
                    instead. */}
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
                  <div className="grid grid-cols-2 gap-2.5 w-full">
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
          <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/55">
            <span className="text-[11px] font-black uppercase tracking-[0.2em] text-slate-400">Get Ready</span>
            <div className="relative w-28 h-28 rounded-full border-[3px] border-cyan-500/20 flex items-center justify-center">
              <div className="absolute -inset-[3px] rounded-full border-[3px] border-transparent border-t-cyan-400 border-r-cyan-400 animate-spin" style={{ animationDuration: '0.7s' }} />
              <span key={countdownValue} className="fx-pop-in text-5xl font-display bg-gradient-to-b from-white to-cyan-300 bg-clip-text text-transparent">
                {countdownValue > 0 ? countdownValue : 'GO'}
              </span>
            </div>
            <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wider">Inhibition Mode</span>
          </div>
        )}

        {/* ── RESULT SCREEN ── */}
        {phase === 'ended' && endSummary && !isChallenge && (
          <ResultScreen
            summary={endSummary}
            bestScore={bestScore}
            accent="from-cyan-600 to-blue-600"
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
      <div className={`text-[12px] font-hud font-bold ${color}`}>{value}</div>
      <div className="text-[7.5px] label-tiny text-slate-500 mt-0.5">{label}</div>
    </div>
  );
}

