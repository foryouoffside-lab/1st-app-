'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { 
  Compass, Volume2, VolumeX, Eye, Zap, Ban,
  Share2, ArrowLeft, Heart, Star, Circle, Square, Triangle, 
  Diamond, Target, Award, Hexagon, Grid, Activity, Clock
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
const TOTAL_TIME = 45;
const OVERDRIVE_MS = 5000;
const STORAGE_KEY = 'skilldrills_card_matching_v1';

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
// STORAGE HELPERS
// ============================================================
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
  const [gridCols, setGridCols] = useState(3);
  const [flippedIndices, setFlippedIndices] = useState([]);
  const [matchedIndices, setMatchedIndices] = useState([]);

  // Stats
  const [score, setScore] = useState(0);
  const [combo, setCombo] = useState(0);
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

  const initGrid = useCallback(() => {
    const newDeck = getCardIcons();
    cardsRef.current = newDeck;
    setCards(newDeck);
    
    flippedIndicesRef.current = [];
    matchedIndicesRef.current = [];
    flipCountsRef.current = {}; 
    
    setFlippedIndices([]);
    setMatchedIndices([]);
  }, [getCardIcons]);

  // === END GAME ===
  const endGame = useCallback(async () => {
    gameActiveRef.current = false;
    setPhase('ended');

    if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
    if (overdriveTimeoutRef.current) clearTimeout(overdriveTimeoutRef.current);
    if (heartbeatTimerRef.current) clearTimeout(heartbeatTimerRef.current);

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
      score: finalTotalScore,
      accuracy: finalAccuracy,
      bestCombo: bestComboVal,
      xpEarned: xpResult.xp,
      isNewBest: isNew,
    });

    if (Capacitor.isNativePlatform()) StatusBar.show().catch(() => {});
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
      setCombo(comboRef.current);

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
      // MISMATCH
      audioSynth?.playPenalty();
      comboRef.current = 0;
      setCombo(0);

      triggerFlash('red');

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

      let lastTick = Date.now();
      timerIntervalRef.current = setInterval(() => {
        if (!gameActiveRef.current) {
          clearInterval(timerIntervalRef.current);
          return;
        }
        const now = Date.now();
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
  }, [endGame, scheduleHeartbeat]);

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

    const saved = getSavedData();

    const startLevel = Math.max(1, Math.min(MAX_LEVEL, Math.round((saved.bestLevel || 1) * 0.55)));
    const startPairs = BASE_PAIRS + (startLevel - 1) * LEVEL_STEP;

    setScore(0);
    setCombo(0);
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
  const shareResult = useCallback(async () => {
    if (!endSummary) return;
    const url = 'https://skilldrills.online/drills/cognitive/memory/card-matching';
    try {
      const grade = getGrade(endSummary.accuracy);
      const canvas = generateShareCard({
        score: endSummary.score,
        bestScore,
        accuracy: endSummary.accuracy,
        bestCombo: endSummary.bestCombo,
        rating: { letter: grade.grade, label: grade.label, emoji: grade.emoji },
        newBest: endSummary.isNewBest,
        drillName: 'Card Matching',
        playerName: getPlayerName(),
      });
      await shareScoreCard(url, canvas);
    } catch (e) {
      const text = `Scored ${endSummary.score} on Card Matching (${endSummary.accuracy}% accuracy, ${endSummary.bestCombo}x combo) — SkillDrills`;
      if (typeof navigator !== 'undefined' && navigator.share) {
        navigator.share({ title: 'Card Matching — SkillDrills', text, url }).catch(() => {});
      } else if (typeof navigator !== 'undefined' && navigator.clipboard) {
        navigator.clipboard.writeText(`${text} ${url}`);
      }
    }
  }, [endSummary, bestScore]);

  // === HIDE FLOATING EXIT BUTTON WHILE IN DRILL ===
  useEffect(() => {
    if (typeof window !== 'undefined') {
      document.body.classList.add('hide-drill-controls');
    }
    return () => {
      if (typeof window !== 'undefined') {
        document.body.classList.remove('hide-drill-controls');
      }
    };
  }, []);

  // === ON MOUNT ===
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
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
      if (countdownTimerRef.current) clearTimeout(countdownTimerRef.current);
      if (overdriveTimeoutRef.current) clearTimeout(overdriveTimeoutRef.current);
      if (heartbeatTimerRef.current) clearTimeout(heartbeatTimerRef.current);
      unlockOrientation();
      if (Capacitor.isNativePlatform()) StatusBar.show().catch(() => {});
    };
  }, []);

  if (loading || !isClient) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#050508]">
        <div className="text-center">
          <div className="w-14 h-14 border-4 border-pink-500 border-t-transparent rounded-full animate-spin mx-auto mb-4 shadow-[0_0_20px_rgba(236,72,153,0.5)]"></div>
          <p className="text-slate-500 font-bold tracking-widest uppercase text-[10px] animate-pulse">Loading Memory Engine...</p>
        </div>
      </div>
    );
  }

  const timePct = Math.max(0, Math.min(100, (timeRemaining / TOTAL_TIME) * 100));

  return (
    <DrillWrapper
      drillName="Card Matching"
      category="cognitive"
      score={score}
      timeLeft={phase === 'ended' ? 0 : Math.ceil(timeRemaining)}
      soundEnabled={soundEnabled}
      onSoundToggle={() => setSoundEnabled(v => { audioSynth?.setEnabled(!v); return !v; })}
      backHref="/drills/cognitive"
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
          @keyframes flash-cyan {
            0% { background-color: rgba(6, 182, 212, 0.2); }
            100% { background-color: transparent; }
          }
          @keyframes flash-red {
            0% { background-color: rgba(239, 68, 68, 0.2); }
            100% { background-color: transparent; }
          }
          @keyframes flash-gold {
            0% { background-color: rgba(234, 179, 8, 0.2); }
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
          /* success flashes are intentionally inert — see globals.css */
          .fx-flash-cyan { animation-name: none; background: none; }
          .fx-flash-red { animation-name: flash-red; }
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
            className="absolute bottom-5 right-5 z-40 p-2 rounded-full bg-black/60 border border-white/10 text-slate-400 active:scale-90 transition-transform cursor-pointer"
          >
            {soundEnabled ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
          </button>
        )}

        {/* ── START SCREEN ── */}
        {phase === 'start' && (
          <div className="relative h-full flex items-center justify-center p-5 overflow-y-auto z-40">
            <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(ellipse 420px 260px at 50% 8%, rgba(236,72,153,.16), transparent 70%)' }} />
            <div className="relative w-full max-w-[290px] rounded-[20px] border border-white/5 bg-[#0c0c16]/90 backdrop-blur-lg px-5 pt-5 pb-[18px] text-center shadow-[0_16px_40px_rgba(0,0,0,.5)] my-6">
              <div className="w-11 h-11 mx-auto rounded-[14px] bg-gradient-to-br from-pink-500 to-rose-600 flex items-center justify-center mb-3 shadow-[0_0_22px_rgba(236,72,153,.35)]">
                <Compass className="w-[22px] h-[22px] text-white" />
              </div>
              <h1 className="text-[17px] font-bold tracking-tight text-white">Card Matching</h1>

              <div className="flex flex-col gap-1.5 text-left mt-3.5">
                <HowToRow icon={<Eye className="w-3.5 h-3.5 text-cyan-400 flex-shrink-0" />} node={<>Memorize card positions and match identical pairs</>} />
                <HowToRow icon={<Zap className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" />} node={<>Grid expands with more pairs as you clear each level</>} />
                <HowToRow icon={<Ban className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />} node={<>Mismatches reset your combo streak</>} />
              </div>

              <div className="grid grid-cols-3 gap-1.5 mt-3.5">
                <MiniStat label="Best" value={bestScore} color="text-yellow-400" />
                <MiniStat label="Combo" value={`${bestCombo}x`} color="text-orange-400" />
                <MiniStat label="Level" value={`Lv.${bestLevel}`} color="text-pink-400" />
              </div>

              <button
                onClick={enterDrill}
                className="w-full mt-3.5 py-[11px] rounded-[13px] bg-gradient-to-r from-pink-500 to-rose-600 font-bold text-[12.5px] tracking-wide active:scale-[0.97] transition-transform shadow-[0_0_20px_rgba(236,72,153,.3)] cursor-pointer text-white"
              >
                START
              </button>
            </div>
          </div>
        )}

        {/* ── PLAYING ── */}
        {(phase === 'playing' || phase === 'countdown') && (
          <>
            <div className="absolute top-0 left-0 right-0 h-1.5 bg-neutral-950 z-[60] pointer-events-none">
              <div className={`h-full transition-all duration-100 ease-linear ${timeRemaining <= 10 ? 'bg-red-500 animate-pulse' : 'bg-pink-500'}`} style={{ width: `${timePct}%` }} />
            </div>

            <div className="absolute top-5 left-5 z-40 flex flex-col pointer-events-none select-none">
              <span className="text-2xl font-black text-white leading-none tabular-nums">{score}</span>
            </div>

            {/* Timer overlay at top-right */}
            <div className="absolute top-5 right-5 z-40 flex flex-col items-end pointer-events-none select-none">
              <span className={`text-3xl font-black font-mono leading-none tabular-nums ${timeRemaining <= 10 ? 'text-red-500 animate-pulse' : 'text-slate-300'}`}>
                {Math.ceil(timeRemaining)}s
              </span>
              <span className="text-[8px] text-slate-500 font-bold uppercase tracking-widest mt-1">Time Left</span>
            </div>

            {/* Grid cells */}
            <div className="relative w-full h-[100dvh] flex flex-col items-center justify-center p-4">
              <div
                className="grid mx-auto max-h-full max-w-full relative transition-all duration-300"
                style={{
                  gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))`,
                  width: 'min(62vw, 38vh)',
                  gap: cards.length >= 24 ? '4px' : '6px'
                }}
              >
                {cards.map((card, index) => {
                  const isFlipped = flippedIndices.includes(index);
                  const isMatched = matchedIndices.includes(index);
                  const IconComp = card.icon;

                  return (
                    <button
                      key={index}
                      onPointerDown={(e) => handleCardClick(index, e)}
                      disabled={isMatched || isFlipped || phase === 'countdown'}
                      className={`
                        aspect-square w-full h-full rounded-xl transition-all duration-300 flex items-center justify-center focus:outline-none touch-none relative overflow-hidden
                        ${isMatched ? 'opacity-0 pointer-events-none scale-50' : ''}
                        ${isFlipped ? 'bg-slate-800 border border-slate-600 scale-95 shadow-inner' : 'bg-gradient-to-br from-pink-500 to-rose-600 border border-pink-400 hover:scale-[1.03] active:scale-95 shadow-md cursor-pointer'}
                      `}
                      style={{
                        minHeight: '26px',
                        maxHeight: '74px'
                      }}
                      aria-label="Card"
                    >
                      {isFlipped && (
                        <div className="animate-in zoom-in fade-in duration-200">
                          <IconComp className={`w-5 h-5 sm:w-7 sm:h-7 ${card.color}`} />
                        </div>
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
          <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/55 backdrop-blur-[2px]">
            <span className="text-[11px] font-black uppercase tracking-[0.2em] text-slate-400">Get Ready</span>
            <div className="relative w-28 h-28 rounded-full border-[3px] border-pink-500/20 flex items-center justify-center">
              <div className="absolute -inset-[3px] rounded-full border-[3px] border-transparent border-t-pink-400 border-r-pink-400 animate-spin" style={{ animationDuration: '0.7s' }} />
              <span key={countdownValue} className="fx-pop-in text-5xl font-black bg-gradient-to-b from-white to-pink-300 bg-clip-text text-transparent">
                {countdownValue > 0 ? countdownValue : 'GO'}
              </span>
            </div>
            <span className="text-[10px] text-slate-500">Cards spawn at GO</span>
          </div>
        )}

        {/* ── RESULT SCREEN ── */}
        {phase === 'ended' && endSummary && (
          <ResultScreen summary={endSummary} onPlayAgain={enterDrill} onShare={shareResult} />
        )}
      </div>
    </DrillWrapper>
  );
}

// ==========================================
// SUBCOMPONENTS
// ==========================================

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
          <button onClick={onPlayAgain} className="flex-1 py-3 rounded-[13px] bg-gradient-to-r from-pink-500 to-rose-600 text-white font-bold text-xs uppercase tracking-wide cursor-pointer">
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