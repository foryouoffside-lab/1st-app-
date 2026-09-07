'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Volume2, VolumeX,
  Heart, Star, Circle, Square, Triangle,
  Diamond, Target, Award, Hexagon, Grid, Activity, Clock
} from 'lucide-react';
import { scoreAction, calcEndBonuses, calcSessionXP, getGrade } from '../../../../../lib/scoringEngine';
import { saveLeaderboardEntrySync } from '../../../../../lib/leaderboard';
import { lockPortrait, unlockOrientation } from '../../../../../lib/orientation';
import { previewDailyCompletion } from '../../../../../lib/dailyChallenge';
import { getPlayerName, getPlayerLevel } from '../../../../../lib/progressStore';
import { useShareCard } from '../../../../../components/ShareScoreCard';
import { Capacitor } from '@capacitor/core';
import { StatusBar } from '@capacitor/status-bar';
import DrillWrapper from '../../../../../components/DrillWrapper';
import { APP_SHARE_URL } from '../../../../../lib/shareLinks';
import ResultScreen from '../../../../../components/drill/ResultScreen';
import DrillStartCard from '../../../../../components/drill/DrillStartCard';

// ============================================================
// TUNING CONSTANTS
// ============================================================
const TOTAL_TIME = 45;
const STORAGE_KEY = 'skilldrills_card_matching_v1';

// How long a freshly dealt board is shown face-up before it flips down.
// Scaled by card count — a 24-card board is genuinely more to take in than a
// 12-card one, and a fixed duration would make the late levels unfair rather
// than harder. The game clock is PAUSED for this window (see the timer
// interval), so the preview never eats into the player's 45 seconds.
const previewMsFor = (cardCount) => Math.min(2800, 1400 + cardCount * 55);

const BASE_PAIRS = 6;
const LEVEL_STEP = 2;
const MAX_PAIRS = 14;
const MAX_LEVEL = (MAX_PAIRS - BASE_PAIRS) / LEVEL_STEP + 1;

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
// MAIN COMPONENT
// ============================================================
export default function CardMatchingClient() {
  const [isClient, setIsClient] = useState(false);
  const [loading, setLoading] = useState(true);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [phase, setPhase] = useState('start'); // 'start' | 'countdown' | 'playing' | 'ended'
  const [countdownValue, setCountdownValue] = useState(3);

  // Gameplay visual states
  const [cards, setCards] = useState([]);
  // Face-up preview of a freshly dealt board. Kept separate from
  // flippedIndices so it can't be mistaken for a real pair-in-progress by the
  // matching logic — it only affects what a card RENDERS as.
  const [preview, setPreview] = useState(false);
  const previewRef = useRef(false);
  const previewTimerRef = useRef(null);
  // Bumped on every deal. Used as the grid's React key so a new board mounts
  // FRESH rather than transitioning out of the previous one — see initGrid.
  const [dealId, setDealId] = useState(0);
  const [gridCols, setGridCols] = useState(3);
  // Row count is implied by how many cards the level deals; the board's aspect
  // ratio depends on it, so it has to be derived rather than assumed square.
  const gridRows = Math.max(1, Math.ceil(cards.length / Math.max(1, gridCols)));
  const [flippedIndices, setFlippedIndices] = useState([]);
  const [matchedIndices, setMatchedIndices] = useState([]);

  // Stats
  const [score, setScore] = useState(0);
  const [timeRemaining, setTimeRemaining] = useState(TOTAL_TIME);
  const [dangerLevel, setDangerLevel] = useState(0);

  // Juice & Feedback
  const [flashes, setFlashes] = useState([]);
  const [bursts, setBursts] = useState([]);
  const [endSummary, setEndSummary] = useState(null);

  // High Scores
  const [bestScore, setBestScore] = useState(0);
  const [bestCombo, setBestCombo] = useState(0);
  const [bestLevel, setBestLevel] = useState(1);

  // Absolute Truth Refs
  const gameActiveRef = useRef(false);
  const mountedRef = useRef(false);
  const cardsRef = useRef([]);
  const flippedIndicesRef = useRef([]);
  const matchedIndicesRef = useRef([]);
  const flipCountsRef = useRef({}); 
  const waitingRef = useRef(false);

  const scoreRef = useRef(0);
  const comboRef = useRef(0);
  const bestComboRef = useRef(0);
  const levelRef = useRef(1);
  const bestLevelRunRef = useRef(1);
  const pairCountRef = useRef(6);
  const timeRemainingRef = useRef(TOTAL_TIME);
  const totalClicksRef = useRef(0);
  const correctMatchesRef = useRef(0);

  const timerIntervalRef = useRef(null);
  const countdownTimerRef = useRef(null);
  const overdriveTimeoutRef = useRef(null);
  const heartbeatTimerRef = useRef(null);

  const pairFirstFlipTimeRef = useRef(null);
  const heartbeatTempoRef = useRef(1100);

  // === JUICE HELPERS ===
  const triggerFlash = useCallback((variant) => {
    const id = Date.now() + Math.random();
    setFlashes((prev) => [...prev, { id, variant }]);
    setTimeout(() => {
      setFlashes((prev) => prev.filter((f) => f.id !== id));
    }, 150);
  }, []);

  const spawnBurst = useCallback((cardIndex, color) => {
    const id = Date.now() + Math.random();
    setBursts((prev) => [...prev, { id, index: cardIndex, color }]);
    setTimeout(() => {
      setBursts((prev) => prev.filter((b) => b.id !== id));
    }, 500);
  }, []);

  // === CARD GENERATION ===
  const getCardIcons = useCallback(() => {
    const iconSets = [
      { icon: Heart, name: 'heart', color: 'text-red-500' }, 
      { icon: Star, name: 'star', color: 'text-yellow-500' },
      { icon: Circle, name: 'circle', color: 'text-blue-500' }, 
      { icon: Square, name: 'square', color: 'text-green-500' },
      { icon: Triangle, name: 'triangle', color: 'text-purple-500' }, 
      { icon: Diamond, name: 'diamond', color: 'text-pink-500' },
      { icon: Target, name: 'target', color: 'text-orange-500' }, 
      { icon: Award, name: 'award', color: 'text-indigo-500' },
      { icon: Zap, name: 'zap', color: 'text-amber-500' }, 
      { icon: Hexagon, name: 'hexagon', color: 'text-cyan-500' }, 
      { icon: Grid, name: 'grid', color: 'text-teal-500' },
      { icon: Eye, name: 'eye', color: 'text-emerald-500' }, 
      { icon: Activity, name: 'activity', color: 'text-rose-500' },
      { icon: Clock, name: 'clock', color: 'text-sky-500' }
    ];
    
    const pairsCount = pairCountRef.current;
    const cols = pairsCount >= 8 ? 4 : 3;
    setGridCols(cols);

    const selectedIcons = iconSets.slice(0, pairsCount);
    let cardDeck = [];
    selectedIcons.forEach((iconSet) => { 
      cardDeck.push({ icon: iconSet.icon, name: iconSet.name, color: iconSet.color }); 
      cardDeck.push({ icon: iconSet.icon, name: iconSet.name, color: iconSet.color }); 
    });
    
    for (let i = cardDeck.length - 1; i > 0; i--) { 
      const j = Math.floor(Math.random() * (i + 1)); 
      [cardDeck[i], cardDeck[j]] = [cardDeck[j], cardDeck[i]]; 
    }
    
    return cardDeck;
  }, []);

  // Shows the dealt board face-up, then flips it down. previewRef is the
  // authority (the timer interval and the click handler read it synchronously);
  // the state mirror exists only so the cards re-render.
  const startPreview = useCallback((cardCount) => {
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
    previewRef.current = true;
    setPreview(true);
    previewTimerRef.current = setTimeout(() => {
      previewTimerRef.current = null;
      previewRef.current = false;
      setPreview(false);
    }, previewMsFor(cardCount));
  }, []);

  const initGrid = useCallback(() => {
    const newDeck = getCardIcons();
    cardsRef.current = newDeck;
    setCards(newDeck);
    // New key => the whole board REMOUNTS instead of animating out of the old
    // one. The previous deal left its cards mid-transition (matched cards sat
    // at opacity-0/scale-50, and a level that changes column count also changes
    // both grid track lengths), so the next board used to fade and resize its
    // way in over ~300ms — which is the partial, bottom-row-first load.
    setDealId((n) => n + 1);

    flippedIndicesRef.current = [];
    matchedIndicesRef.current = [];
    flipCountsRef.current = {};

    setFlippedIndices([]);
    setMatchedIndices([]);
    startPreview(newDeck.length);
  }, [getCardIcons, startPreview]);

  // === END GAME ===
  const endGame = useCallback(async () => {
    gameActiveRef.current = false;
    setPhase('ended');

    if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
    if (overdriveTimeoutRef.current) clearTimeout(overdriveTimeoutRef.current);
    if (heartbeatTimerRef.current) clearTimeout(heartbeatTimerRef.current);
    if (previewTimerRef.current) { clearTimeout(previewTimerRef.current); previewTimerRef.current = null; }
    previewRef.current = false;

    audioSynth?.playResultsReveal();

    const finalScore = scoreRef.current;
    const finalAccuracy = totalClicksRef.current > 0 
      ? Math.round(((correctMatchesRef.current * 2) / totalClicksRef.current) * 100) 
      : 0;
    const bestComboVal = bestComboRef.current;

    const bonuses = calcEndBonuses({
      rawScore: finalScore,
      accuracy: finalAccuracy,
      bestCombo: bestComboVal,
      totalActions: correctMatchesRef.current,
      mistakes: Math.max(0, totalClicksRef.current - (correctMatchesRef.current * 2)),
      livesRemaining: null,
      maxLives: null,
      category: 'cognitive',
    });

    const finalTotalScore = bonuses.finalScore;

    const saved = getSavedData();
    const isNew = finalTotalScore > saved.bestScore;
    const nextBestScore = Math.max(saved.bestScore, finalTotalScore);
    const nextBestCombo = Math.max(saved.bestCombo, bestComboVal);
    const nextBestLevel = Math.max(saved.bestLevel || 1, bestLevelRunRef.current);

    saveData({
      bestScore: nextBestScore,
      bestCombo: nextBestCombo,
      bestLevel: nextBestLevel,
      totalSessions: (saved.totalSessions || 0) + 1,
    });

    setBestScore(nextBestScore);
    setBestCombo(nextBestCombo);
    setBestLevel(nextBestLevel);

    const daily = await previewDailyCompletion('card-matching');

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
      drillId: 'card-matching',
      drillName: 'Card Matching',
      category: 'cognitive',
      score: finalTotalScore,
      accuracy: finalAccuracy,
      bestCombo: bestComboVal,
    });

    setEndSummary({
      progress,
      score: finalTotalScore,
      accuracy: finalAccuracy,
      bestCombo: bestComboVal,
      xpEarned: xpResult.xp,
      isNewBest: isNew,
      prevBest: saved.bestScore,
    });

    // The status bar deliberately stays hidden here. Re-showing it resized the
    // WebView at the exact moment the result screen mounted, so the results
    // visibly jumped into place. It is restored on unmount instead (see the
    // mount effect), alongside unlockOrientation().
  }, []);

  // === MATCH RESOLUTION ===
  const resolveMatch = useCallback((idx1, idx2) => {
    const c1 = cardsRef.current[idx1];
    const c2 = cardsRef.current[idx2];
    
    const reactionTimeMs = pairFirstFlipTimeRef.current ? Date.now() - pairFirstFlipTimeRef.current : 1000;
    pairFirstFlipTimeRef.current = null;

    if (c1.name === c2.name) {
      // MATCH
      correctMatchesRef.current += 1;
      const currentCombo = comboRef.current;
      comboRef.current += 1;

      if (comboRef.current > bestComboRef.current) {
        bestComboRef.current = comboRef.current;
      }

      audioSynth?.playHit();

      const scoreResult = scoreAction({
        category: 'cognitive',
        combo: currentCombo,
        reactionMs: reactionTimeMs,
        timeRemaining: timeRemainingRef.current,
        totalGameTime: TOTAL_TIME,
        livesRemaining: null,
        maxLives: null,
        level: levelRef.current,
        maxLevel: MAX_LEVEL,
      });

      let pointsEarned = scoreResult.total;
      scoreRef.current += pointsEarned;
      setScore(scoreRef.current);

      spawnBurst(idx2, 'cyan');
      triggerFlash('cyan');

      matchedIndicesRef.current = [...matchedIndicesRef.current, idx1, idx2];
      setMatchedIndices([...matchedIndicesRef.current]);

      if (matchedIndicesRef.current.length === cardsRef.current.length) {
        const P = pairCountRef.current;
        const scaleFactor = P / 6;
        
        const clearBonus = Math.round(20 * scaleFactor);
        scoreRef.current += clearBonus;
        setScore(scoreRef.current);

        if (pairCountRef.current < MAX_PAIRS) {
          pairCountRef.current += LEVEL_STEP;
          levelRef.current = (pairCountRef.current - BASE_PAIRS) / LEVEL_STEP + 1;
          bestLevelRunRef.current = Math.max(bestLevelRunRef.current, levelRef.current);
        }

        timeRemainingRef.current = TOTAL_TIME;
        setTimeRemaining(TOTAL_TIME);

        waitingRef.current = true;
        setTimeout(() => {
          waitingRef.current = false;
          initGrid();
        }, 800);
      } else {
        flippedIndicesRef.current = [];
        setFlippedIndices([]);
      }
    } else {
      // MISMATCH — no full-screen flash here (unlike most other drills):
      // a round can involve dozens of flip attempts, and a flash on every
      // single mismatch reads as constant strobing rather than a discrete
      // "you got it wrong" cue. The cards flipping back over is already
      // clear feedback.
      audioSynth?.playPenalty();
      comboRef.current = 0;

      waitingRef.current = true;
      setTimeout(() => {
        flippedIndicesRef.current = [];
        setFlippedIndices([]);
        waitingRef.current = false;
      }, 600);
    }
  }, [initGrid, triggerFlash, spawnBurst]);

  // === CELL CLICK ===
  const handleCardClick = useCallback((index, e) => {
    if (e) {
      e.stopPropagation();
      e.preventDefault();
    }

    if (phase !== 'playing' || timeRemainingRef.current <= 0) return;
    if (waitingRef.current) return;
    // Board is being shown face-up — taps here would flip a card the player can
    // already see, and would register as a real flip against their accuracy.
    if (previewRef.current) return;
    if (matchedIndicesRef.current.includes(index)) return;
    if (flippedIndicesRef.current.includes(index)) return;
    if (flippedIndicesRef.current.length >= 2) return;

    totalClicksRef.current += 1;

    audioSynth?.playHit();

    const newFlipped = [...flippedIndicesRef.current, index];
    flippedIndicesRef.current = newFlipped;
    setFlippedIndices(newFlipped);

    if (newFlipped.length === 1) {
      pairFirstFlipTimeRef.current = Date.now();
    }

    if (newFlipped.length === 2) {
      resolveMatch(newFlipped[0], newFlipped[1]);
    }
  }, [phase, resolveMatch]);

  // === HEARTBEAT SCHEDULER ===
  const scheduleHeartbeat = useCallback(() => {
    if (!gameActiveRef.current) return;
    const dangerFromTime = timeRemainingRef.current <= 10 ? (10 - timeRemainingRef.current) / 10 : 0;
    const danger = dangerFromTime;
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
  }, []);

  // === COUNTDOWN LOOP ===
  const runCountdown = useCallback((n) => {
    if (countdownTimerRef.current) clearTimeout(countdownTimerRef.current);
    if (n <= 0) {
      audioSynth?.playGo();
      setPhase('playing');
      gameActiveRef.current = true;
      // Opening board gets the same face-up preview as every later level. Done
      // here rather than at deal time because the deck is set before the 3-2-1
      // countdown, and the countdown overlay dims and blurs the board — showing
      // the preview behind it would be showing it through frosted glass.
      startPreview(cardsRef.current.length);

      let lastTick = Date.now();
      timerIntervalRef.current = setInterval(() => {
        if (!gameActiveRef.current) {
          clearInterval(timerIntervalRef.current);
          return;
        }
        const now = Date.now();
        // Clock is frozen while the board is shown face-up. Advancing lastTick
        // without spending it is what makes this a PAUSE rather than a debt
        // that gets deducted in one jump when the preview ends.
        if (previewRef.current) {
          lastTick = now;
          return;
        }
        const deltaMs = now - lastTick;
        lastTick = now;

        const nextTime = Math.max(0, timeRemainingRef.current - (deltaMs / 1000));
        timeRemainingRef.current = nextTime;
        setTimeRemaining(nextTime);

        if (nextTime <= 0) {
          clearInterval(timerIntervalRef.current);
          endGame();
        }
      }, 200);

      scheduleHeartbeat();
      return;
    }
    setCountdownValue(n);
    audioSynth?.playCountdownTick();
    countdownTimerRef.current = setTimeout(() => runCountdown(n - 1), 700);
  }, [endGame, scheduleHeartbeat, startPreview]);

  // === ENTER DRILL ===
  const enterDrill = useCallback(() => {
    audioSynth?.init();
    lockPortrait();
    if (Capacitor.isNativePlatform()) {
      StatusBar.hide().catch(() => {});
    }

    gameActiveRef.current = false;
    if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
    if (countdownTimerRef.current) clearTimeout(countdownTimerRef.current);
    if (overdriveTimeoutRef.current) clearTimeout(overdriveTimeoutRef.current);
    if (heartbeatTimerRef.current) clearTimeout(heartbeatTimerRef.current);
    if (previewTimerRef.current) { clearTimeout(previewTimerRef.current); previewTimerRef.current = null; }
    previewRef.current = false;

    const saved = getSavedData();

    // Every run starts at the lowest difficulty. It used to start at 55% of the
    // player's best level, so improving once permanently raised the speed every
    // future run opened at - a silent spike with nothing on screen explaining it.
    // That head-start only existed because a fixed 45s was too short to climb the
    // ramp; the endurance clock replaces it.
    const startLevel = 1;
    const startPairs = BASE_PAIRS + (startLevel - 1) * LEVEL_STEP;

    setScore(0);
    setTimeRemaining(TOTAL_TIME);
    setDangerLevel(0);
    setFlashes([]);
    setBursts([]);
    setFlippedIndices([]);
    setMatchedIndices([]);
    setEndSummary(null);

    scoreRef.current = 0;
    comboRef.current = 0;
    bestComboRef.current = 0;
    levelRef.current = startLevel;
    bestLevelRunRef.current = startLevel;
    pairCountRef.current = startPairs;
    timeRemainingRef.current = TOTAL_TIME;
    totalClicksRef.current = 0;
    correctMatchesRef.current = 0;

    flippedIndicesRef.current = [];
    matchedIndicesRef.current = [];
    flipCountsRef.current = {};
    waitingRef.current = false;

    setBestScore(saved.bestScore || 0);
    setBestCombo(saved.bestCombo || 0);
    setBestLevel(saved.bestLevel || 1);

    const newDeck = getCardIcons();
    cardsRef.current = newDeck;
    setCards(newDeck);

    setPhase('countdown');
    runCountdown(3);
  }, [getCardIcons, runCountdown]);

  // === SHARE SCORE ===
  // Score card. Drawn and encoded while the result screen sits idle,
  // not on the tap - see useShareCard in components/ShareScoreCard.js.
  const shareResult = useShareCard(endSummary ? {
    score: endSummary.score,
    bestScore: endSummary.prevBest ?? bestScore,
    accuracy: endSummary.accuracy,
    bestCombo: endSummary.bestCombo,
    rating: getGrade(endSummary.accuracy),
    newBest: endSummary.isNewBest,
    drillName: 'Card Matching',
    playerName: getPlayerName(),
  } : null, {
    url: APP_SHARE_URL,
    title: 'Card Matching — SkillDrills',
    text: endSummary ? `Scored ${endSummary.score} on Card Matching (${endSummary.accuracy}% accuracy, ${endSummary.bestCombo}x combo) — SkillDrills` : '',
  });

  // === ON MOUNT ===
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
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
      if (countdownTimerRef.current) clearTimeout(countdownTimerRef.current);
      if (overdriveTimeoutRef.current) clearTimeout(overdriveTimeoutRef.current);
      if (heartbeatTimerRef.current) clearTimeout(heartbeatTimerRef.current);
      if (previewTimerRef.current) { clearTimeout(previewTimerRef.current); previewTimerRef.current = null; }
      previewRef.current = false;
      unlockOrientation();
      if (Capacitor.isNativePlatform()) {
        StatusBar.setOverlaysWebView({ overlay: false }).catch(() => {});
        StatusBar.show().catch(() => {});
      }
    };
  }, []);

  if (loading || !isClient) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#050508]">
        <div className="text-center">
          <div className="w-14 h-14 border-4 border-violet-500 border-t-transparent rounded-full animate-spin mx-auto mb-4 shadow-[0_0_20px_rgba(139,92,246,0.5)]"></div>
          <p className="text-slate-500 font-bold tracking-widest uppercase text-[10px] animate-pulse">Loading Memory Engine...</p>
        </div>
      </div>
    );
  }

  return (
    <DrillWrapper
      drillName="Card Matching"
      category="cognitive"
      score={score}
      timeLeft={phase === 'ended' ? 0 : Math.ceil(timeRemaining)}
      soundEnabled={soundEnabled}
      onSoundToggle={() => setSoundEnabled(v => { audioSynth?.setEnabled(!v); return !v; })}
      backHref="/"
      minimalChrome
    >
      <div
        onContextMenu={(e) => { if (phase === 'playing') e.preventDefault(); }}
        className="absolute inset-0 select-none overflow-hidden bg-[#050508] text-white"
        style={{ 
          touchAction: phase === 'playing' ? 'none' : 'auto', 
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
          /* success flashes are intentionally inert — see globals.css */
          .fx-flash-cyan { animation-name: none; background: none; }
          /* Radial + sized at 30% (not a flat full-screen tint) so it fades
             to fully transparent before reaching the edges. */
          .fx-flash-red { background: radial-gradient(ellipse 30% 30% at 50% 50%, rgba(239,68,68,.35) 0%, rgba(239,68,68,.35) 30%, rgba(239,68,68,.15) 60%, transparent 92%); }
          .fx-flash-gold { animation-name: none; background: none; }

          @keyframes particle-fade {
            0% { transform: scale(0.6); opacity: 0.8; }
            100% { transform: scale(1.4); opacity: 0; }
          }
          .fx-burst {
            position: absolute;
            inset: 4px;
            border-radius: 12px;
            pointer-events: none;
            border: 2px solid;
            animation: particle-fade 0.5s ease-out forwards;
            z-index: 10;
          }
        `}</style>

        {phase === 'playing' && dangerLevel > 0.06 && (
          <div className="fx-vignette" style={{ '--v-min': Math.max(0.05, dangerLevel * 0.25), '--v-max': Math.min(0.55, dangerLevel * 0.75), animationDuration: `${heartbeatTempoRef.current}ms` }} />
        )}

        <div className="absolute inset-0 pointer-events-none" style={{ backgroundImage: 'linear-gradient(rgba(255,255,255,0.015) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.015) 1px, transparent 1px)', backgroundSize: '40px 40px' }} />

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
        {phase === 'start' && (
          <DrillStartCard
            drillName="Card Matching"
            tagline="Flip cards, remember, match the pairs"
            rules={[
              'Flip cards and match the pairs',
              'More pairs each level you clear',
              'A mismatch resets your combo',
            ]}
            bestStrip={bestScore > 0 ? [
              { value: bestScore.toLocaleString(), label: 'Best · PTS' },
              { value: `${bestCombo}×`, label: 'Combo' },
              { value: String(bestLevel).padStart(2, '0'), label: 'Level' },
            ] : null}
            orientation="portrait"
            onStart={enterDrill}
          />
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

            {/* Grid cells */}
            <div className="relative w-full h-[100dvh] flex flex-col items-center justify-center p-4">
              <div
                key={dealId}
                // No `transition-all` here. Animating the grid is what made a
                // new level resize into place instead of simply appearing; with
                // the per-deal key above, each board mounts at its final
                // geometry in one frame.
                className="grid mx-auto relative"
                style={(() => {
                  // Cards are square BY CONSTRUCTION: one cell edge is computed
                  // once and used for both the column and the row tracks, so
                  // neither axis is left to be inferred.
                  //
                  // Everything softer than this failed. `aspect-square` on the
                  // card lost to the grid's old `max-h-full`, which squeezed the
                  // rows; `aspectRatio` on the grid never resolved at all,
                  // because the grid is a flex item inside a
                  // `flex flex-col items-center justify-center` parent and so
                  // took its height from content regardless.
                  // Tight gaps so the board reads as one grid rather than
                  // scattered tiles.
                  const gapPx = cards.length >= 24 ? 2 : 3;
                  // A THIRD cap, on the cell rather than the board.
                  //
                  // The first two caps size the BOARD, which meant every level
                  // filled the same 78vw of screen and the cell size fell out
                  // of the column count: the 3-column board rendered ~108px
                  // cards while every 4-column board rendered ~80px ones. So a
                  // card visibly changed size between levels, and the 3x4 was
                  // the outlier that read as oversized.
                  //
                  // Capping the cell instead makes a card the same size at
                  // every level and lets the board shrink to fit its contents,
                  // which is what actually makes the 3x4 smaller. 84px stays
                  // far above the ~44px comfortable touch target.
                  const maxCellPx = 84;
                  const maxBoardPx = gridCols * maxCellPx + (gridCols - 1) * gapPx;
                  // Board width is capped on BOTH axes so taller layouts (more
                  // rows than columns) still fit on screen without compression.
                  const boardW = `min(78vw, ${(70 * gridCols / gridRows).toFixed(2)}vh, ${maxBoardPx}px)`;
                  const cell = `calc((${boardW} - ${(gridCols - 1) * gapPx}px) / ${gridCols})`;
                  return {
                    gridTemplateColumns: `repeat(${gridCols}, ${cell})`,
                    gridTemplateRows: `repeat(${gridRows}, ${cell})`,
                    gap: `${gapPx}px`,
                  };
                })()}
              >
                {cards.map((card, index) => {
                  // `preview` shows the whole board face-up on a fresh deal.
                  const isFlipped = preview || flippedIndices.includes(index);
                  const isMatched = matchedIndices.includes(index);
                  const IconComp = card.icon;

                  return (
                    <button
                      key={index}
                      onPointerDown={(e) => handleCardClick(index, e)}
                      disabled={isMatched || isFlipped || phase === 'countdown'}
                      className={`
                        w-full h-full rounded-xl transition-all duration-300 flex items-center justify-center focus:outline-none touch-none relative overflow-hidden
                        ${isMatched ? 'opacity-0 pointer-events-none scale-50' : ''}
                        ${isFlipped
                          // Revealed face: near-black, not the old slate grey.
                          // Grey sat halfway between the board and the back and
                          // muddied both; black reads as a genuine "hole" in the
                          // board and gives the coloured shape maximum contrast.
                          ? 'bg-[#07070d] border border-[#39325f] scale-95 shadow-inner'
                          // Face-down back: deliberately quiet. Every back is
                          // identical, so this surface carries NO information —
                          // and it covers most of the screen. The old saturated
                          // pink spent all that area on nothing and competed
                          // with the revealed icons, which are the thing the
                          // player is actually trying to encode. Deep slate with
                          // a violet edge keeps it on-theme while letting the
                          // faces win the contrast.
                          // Lifted from the first pass (#1e1b3a -> #141225),
                          // which went too far the other way and left the board
                          // reading as near-empty. This keeps the "quiet back"
                          // logic but puts real light in it, so a face-down card
                          // is clearly a card — while still sitting well below
                          // the revealed shapes in contrast.
                          : 'bg-gradient-to-br from-[#3b3474] to-[#251f47] border border-[#8272de] shadow-[0_2px_8px_rgba(0,0,0,0.45),inset_0_1px_0_rgba(196,181,253,0.30)] hover:scale-[1.03] active:scale-95 cursor-pointer'}
                      `}
                      // No inline height clamp here. A maxHeight of 74px used to
                      // sit on this button and was the reason the cards could
                      // never be square: an inline style beats both the utility
                      // classes and the grid track, so the height stayed pinned
                      // at 74px no matter what the grid asked for. The row track
                      // is already the same length as the column track, so
                      // w-full/h-full is all that is needed.
                      aria-label="Card"
                    >
                      {isFlipped ? (
                        // Sized as a FRACTION of the card, not a fixed px value.
                        // The cell is now a computed length that varies with
                        // level and screen, so a hardcoded w-7 filled a 108px
                        // card very differently from an 84px one. 46% keeps the
                        // shape the same visual weight on every board.
                        // Weight comes from a heavier STROKE, deliberately not
                        // from `fill-current`. Filling these lucide glyphs
                        // collapses distinct symbols into identical solids —
                        // Circle, Target and Clock all become the same disc, and
                        // Square and Grid the same square. In a matching drill
                        // that destroys the very thing the player is matching on.
                        <div className="animate-in zoom-in fade-in duration-200 w-[46%] h-[46%] flex items-center justify-center">
                          <IconComp className={`w-full h-full ${card.color}`} strokeWidth={2.25} />
                        </div>
                      ) : (
                        // Faint emblem so a face-down card still reads as a
                        // designed object rather than an empty tile — quiet
                        // enough that it never reads as a symbol to remember.
                        <span className="w-[26%] h-[26%] rounded-[6px] border-[1.5px] border-violet-300/40" />
                      )}
                      {bursts.filter(b => b.index === index).map(b => (
                        <div key={b.id} className="fx-burst" style={{ borderColor: b.color === 'cyan' ? '#06b6d4' : '#ef4444' }} />
                      ))}
                    </button>
                  );
                })}
              </div>

            </div>
          </>
        )}

        {/* ── COUNTDOWN ── */}
        {phase === 'countdown' && (
          <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/55">
            <span className="text-[11px] font-black uppercase tracking-[0.2em] text-slate-400">Get Ready</span>
            <div className="relative w-28 h-28 rounded-full border-[3px] border-violet-500/20 flex items-center justify-center">
              <div className="absolute -inset-[3px] rounded-full border-[3px] border-transparent border-t-violet-400 border-r-violet-400 animate-spin" style={{ animationDuration: '0.7s' }} />
              <span key={countdownValue} className="fx-pop-in text-5xl font-display bg-gradient-to-b from-white to-violet-300 bg-clip-text text-transparent">
                {countdownValue > 0 ? countdownValue : 'GO'}
              </span>
            </div>
            <span className="text-[10px] text-slate-500">Cards spawn at GO</span>
          </div>
        )}

        {/* ── RESULT SCREEN ── */}
        {phase === 'ended' && endSummary && (
          <ResultScreen
            signature
            summary={endSummary}
            bestScore={bestScore}
            synth={audioSynth}
            onPlayAgain={enterDrill}
            onShare={shareResult}
          />
        )}
      </div>
    </DrillWrapper>
  );
}

