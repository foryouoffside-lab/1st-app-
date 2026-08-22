'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  Compass, Volume2, VolumeX, Heart,
  Eye, Ban, Zap as ZapIcon, RotateCcw, Share2, ArrowLeft
} from 'lucide-react';
import { scoreAction, calcEndBonuses, calcSessionXP, getGrade } from '../../../../../lib/scoringEngine';
import { saveLeaderboardEntrySync } from '../../../../../lib/leaderboard';
import { lockLandscape, unlockOrientation, onOrientationSettled } from '../../../../../lib/orientation';
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
const MAX_LIVES = 5;
const OVERDRIVE_MS = 5000;
const MAX_LEVEL = 15;
const ORDER = ['Δ', 'Ω', 'Σ', 'Ψ', 'Γ', 'Ξ', 'Π', 'Θ', 'Φ'];

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

  setEnabled(status) { this.enabled = status; }
}

const audioSynth = typeof window !== 'undefined' ? new AudioSynthesizer() : null;

// ============================================================
// LOCAL STORAGE
// ============================================================
const STORAGE_KEY = 'skilldrills_symbol_matching_v4';

const getSavedData = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { bestScore: 0, bestCombo: 0, bestLevel: 1, totalSessions: 0, totalOverdrives: 0 };
    return { bestScore: 0, bestCombo: 0, bestLevel: 1, totalSessions: 0, totalOverdrives: 0, ...JSON.parse(raw) };
  } catch (e) {
    return { bestScore: 0, bestCombo: 0, bestLevel: 1, totalSessions: 0, totalOverdrives: 0 };
  }
};
const saveData = (data) => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (e) {} };

function shuffleArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ============================================================
// MAIN COMPONENT
// ============================================================
export default function SymbolMatchingClient() {
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
  const [lives, setLives] = useState(MAX_LIVES);
  const [combo, setCombo] = useState(0);
  const [level, setLevel] = useState(1);
  const [timeRemaining, setTimeRemaining] = useState(totalTime);
  const [dangerLevel, setDangerLevel] = useState(0);

  const [keyMap, setKeyMap] = useState([]);
  const [keypadOrder, setKeypadOrder] = useState([]);
  const [currentTarget, setCurrentTarget] = useState(null);

  const [flashes, setFlashes] = useState([]);
  const [bursts, setBursts] = useState([]);
  const [flashBg, setFlashBg] = useState(null);
  const [shakeCls, setShakeCls] = useState('');
  const [endSummary, setEndSummary] = useState(null);

  const mountedRef = useRef(false);
  const containerRef = useRef(null);
  const gameActiveRef = useRef(false);

  const scoreRef = useRef(0);
  const livesRef = useRef(MAX_LIVES);
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

  const wrongTapsRef = useRef(0);
  const timeoutsRef = useRef(0);

  const deadlineMsRef = useRef(2200);
  const legendSizeRef = useRef(6);
  const reshuffleMagnitudeRef = useRef(2);
  const keypadShuffleProbRef = useRef(0);

  const legendRef = useRef([]);
  const targetRef = useRef(null);
  const roundStartAtRef = useRef(0);
  const shakeToggleRef = useRef(0);
  const heartbeatTempoRef = useRef(1100);

  const reencodingGraceActiveRef = useRef(false);

  const roundTimerRef = useRef(null);
  const gameTimerRef = useRef(null);
  const heartbeatTimerRef = useRef(null);
  const overdriveTimeoutRef = useRef(null);
  const countdownTimerRef = useRef(null);

  const phaseRef = useRef('start');

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

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
      [roundTimerRef, heartbeatTimerRef, overdriveTimeoutRef, countdownTimerRef].forEach((r) => { if (r.current) clearTimeout(r.current); });
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

  const triggerBurstAtElement = useCallback((el, color) => {
    if (!el || !containerRef.current) return;
    try {
      const rect = el.getBoundingClientRect();
      const parentRect = containerRef.current.getBoundingClientRect();
      const x = ((rect.left + rect.width / 2 - parentRect.left) / parentRect.width) * 100;
      const y = ((rect.top + rect.height / 2 - parentRect.top) / parentRect.height) * 100;
      spawnBurst(x, y, color);
    } catch (e) {}
  }, [spawnBurst]);

  const updateDifficulty = useCallback(() => {
    const newLevel = Math.min(MAX_LEVEL, Math.floor(scoreRef.current / 40) + 1);
    if (newLevel > levelRef.current) {
      levelRef.current = newLevel;
      bestLevelRunRef.current = Math.max(bestLevelRunRef.current, newLevel);
      setLevel(newLevel);
    }
    const p = (levelRef.current - 1) / 14;
    
    deadlineMsRef.current = Math.round(2200 - p * 1300);
    legendSizeRef.current = Math.round(6 + p * 3);
    
    const size = legendSizeRef.current;
    reshuffleMagnitudeRef.current = Math.max(2, Math.min(size, Math.round(2 + p * (size - 2))));
    keypadShuffleProbRef.current = p;
  }, []);

  const activateOverdrive = useCallback(() => {
    overdriveActiveRef.current = true;
    overdriveMeterRef.current = 0;
    overdriveCountRef.current += 1;
    triggerFlash('gold');
    if (overdriveTimeoutRef.current) clearTimeout(overdriveTimeoutRef.current);
    overdriveTimeoutRef.current = setTimeout(() => {
      overdriveActiveRef.current = false;
    }, OVERDRIVE_MS);
  }, [triggerFlash]);

  const fillOverdrive = useCallback((amt) => {
    if (overdriveActiveRef.current) return;
    overdriveMeterRef.current = Math.min(100, overdriveMeterRef.current + amt);
    if (overdriveMeterRef.current >= 100) activateOverdrive();
  }, [activateOverdrive]);

  const resolveCorrect = useCallback((spawnedAt) => {
    if (!gameActiveRef.current) return;
    const reactionMs = spawnedAt ? Date.now() - spawnedAt : null;
    const comboBefore = comboRef.current;
    const pts = scoreAction({
      category: 'cognitive',
      combo: comboBefore,
      reactionMs,
      timeRemaining: timeRemainingRef.current,
      totalGameTime: totalTime,
      livesRemaining: livesRef.current,
      maxLives: MAX_LIVES,
      level: levelRef.current,
      maxLevel: MAX_LEVEL,
    });
    let total = pts.total;
    if (overdriveActiveRef.current) total = Math.round(total * 1.75);

    scoreRef.current += total;
    comboRef.current = comboBefore + 1;
    bestComboRef.current = Math.max(bestComboRef.current, comboRef.current);
    correctActionsRef.current += 1;
    totalActionsRef.current += 1;

    fillOverdrive(14);
    
    setFlashBg('green');
    setTimeout(() => setFlashBg(null), 100);

    audioSynth?.playHit();

    setScore(scoreRef.current);
    setCombo(comboRef.current);
    updateDifficulty();
  }, [fillOverdrive, updateDifficulty, totalTime]);

  const endGameRef = useRef(null);

  const resolveWrong = useCallback((kind) => {
    if (!gameActiveRef.current) return;
    comboRef.current = 0;
    mistakesRef.current += 1;
    totalActionsRef.current += 1;
    livesRef.current -= 1;

    if (kind === 'wrong_match') {
      wrongTapsRef.current += 1;
      triggerShake('hard');
      triggerFlash('red-hard');
      audioSynth?.playWrongBoom();
    } else {
      timeoutsRef.current += 1;
      triggerShake('soft');
      triggerFlash('red');
      audioSynth?.playMiss();
    }

    setFlashBg('red');
    setTimeout(() => setFlashBg(null), 100);

    setScore(scoreRef.current);
    setCombo(0);
    setLives(Math.max(0, livesRef.current));

    if (!isChallenge && livesRef.current <= 0) endGameRef.current?.('lives');
  }, [triggerShake, triggerFlash, isChallenge]);

  const endGame = useCallback(async (reason) => {
    if (!gameActiveRef.current) return;
    gameActiveRef.current = false;

    [roundTimerRef, heartbeatTimerRef, overdriveTimeoutRef].forEach((r) => { if (r.current) { clearTimeout(r.current); r.current = null; } });
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
      livesRemaining: Math.max(0, livesRef.current),
      maxLives: MAX_LIVES,
      category: 'cognitive',
    });
    const finalScore = bonuses.finalScore;

    const prevSaved = getSavedData();
    const isNewBest = finalScore > prevSaved.bestScore;
    const firstPlay = prevSaved.totalSessions === 0;
    const daily = isChallenge
      ? { isDailyDrill: false, wouldCompleteSet: false }
      : await previewDailyCompletion('symbol-matching');
    const xpResult = calcSessionXP({ finalScore, accuracy, isNewBest, firstPlay, dailyChallenge: daily.isDailyDrill, dailyChallengeSetComplete: daily.wouldCompleteSet });

    const updated = {
      bestScore: Math.max(prevSaved.bestScore, finalScore),
      bestCombo: Math.max(prevSaved.bestCombo, bestComboRef.current),
      bestLevel: Math.max(prevSaved.bestLevel, bestLevelRunRef.current),
      totalSessions: prevSaved.totalSessions + 1,
      totalOverdrives: (prevSaved.totalOverdrives || 0) + overdriveCountRef.current,
    };
    saveData(updated);
    setBestScore(updated.bestScore);
    setBestCombo(updated.bestCombo);
    setBestLevel(updated.bestLevel);

    saveLeaderboardEntrySync({
      drillId: 'symbol-matching',
      drillName: 'Symbol Matching',
      category: 'cognitive',
      score: finalScore,
      accuracy,
      bestCombo: bestComboRef.current,
    });

    setEndSummary({
      score: finalScore,
      accuracy,
      bestCombo: bestComboRef.current,
      lives: Math.max(0, livesRef.current),
      isNewBest,
      perfectRun: mistakesRef.current === 0 && correct >= 5,
      xpEarned: xpResult.xp,
    });
    setPhase('ended');
  }, [triggerFlash]);

  useEffect(() => { endGameRef.current = endGame; }, [endGame]);

  const spawnRound = useCallback(() => {
    if (roundTimerRef.current) clearTimeout(roundTimerRef.current);
    if (!gameActiveRef.current) return;

    const S = legendSizeRef.current;
    const M = reshuffleMagnitudeRef.current;

    if (legendRef.current.length !== S) {
      const digits = Array.from({ length: S }, (_, i) => i + 1);
      shuffleArray(digits);
      legendRef.current = ORDER.slice(0, S).map((symbol, idx) => ({
        symbol,
        number: digits[idx]
      }));
      reencodingGraceActiveRef.current = true;
    } else {
      const indices = Array.from({ length: S }, (_, i) => i);
      shuffleArray(indices);
      const selectedIndices = indices.slice(0, M);

      const selectedNumbers = selectedIndices.map(idx => legendRef.current[idx].number);
      shuffleArray(selectedNumbers);

      legendRef.current = legendRef.current.map((item, idx) => {
        const selIdx = selectedIndices.indexOf(idx);
        if (selIdx !== -1) {
          return { ...item, number: selectedNumbers[selIdx] };
        }
        return item;
      });
    }

    const activeLegend = legendRef.current;
    const targetItem = activeLegend[Math.floor(Math.random() * activeLegend.length)];
    targetRef.current = targetItem;

    let newOrder = Array.from({ length: S }, (_, i) => i + 1);
    if (Math.random() < keypadShuffleProbRef.current) {
      shuffleArray(newOrder);
    }

    setKeyMap(activeLegend);
    setCurrentTarget(targetItem);
    setKeypadOrder(newOrder);

    roundStartAtRef.current = Date.now();

    let roundDeadline = deadlineMsRef.current;
    if (reencodingGraceActiveRef.current) {
      roundDeadline += 300;
      reencodingGraceActiveRef.current = false;
    }

    const isFullReshuffle = (M === S);
    if (isFullReshuffle) {
      reencodingGraceActiveRef.current = true;
    }

    roundTimerRef.current = setTimeout(() => {
      if (!gameActiveRef.current || !mountedRef.current) return;
      setCurrentTarget(null);
      resolveWrong('timeout');
      setTimeout(() => { if (gameActiveRef.current) spawnRound(); }, 120);
    }, roundDeadline);

  }, [resolveWrong]);

  const handleInput = useCallback((num, btnElement) => {
    if (!gameActiveRef.current || (!isChallenge && livesRef.current <= 0)) return;

    const target = targetRef.current;
    if (!target) return;
    targetRef.current = null;

    if (roundTimerRef.current) clearTimeout(roundTimerRef.current);
    setCurrentTarget(null);

    if (num === target.number) {
      if (btnElement) {
        triggerBurstAtElement(btnElement, 'cyan');
      }
      resolveCorrect(roundStartAtRef.current);
    } else {
      if (btnElement) {
        triggerBurstAtElement(btnElement, 'red');
      }
      resolveWrong('wrong_match');
    }

    setTimeout(() => {
      if (gameActiveRef.current) spawnRound();
    }, 120);
  }, [resolveCorrect, resolveWrong, spawnRound, triggerBurstAtElement, isChallenge]);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (phaseRef.current !== 'playing') return;
      const n = parseInt(e.key);
      if (n >= 1 && n <= legendSizeRef.current) {
        e.preventDefault();
        const btn = containerRef.current?.querySelector(`[data-digit="${n}"]`);
        handleInput(n, btn);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleInput]);

  const scheduleHeartbeat = useCallback(() => {
    if (!gameActiveRef.current) return;
    const dangerFromLives = (MAX_LIVES - livesRef.current) / MAX_LIVES;
    const dangerFromTime = timeRemainingRef.current <= 10 ? (10 - timeRemainingRef.current) / 10 : 0;
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
  }, []);

  const beginPlaying = useCallback(() => {
    gameActiveRef.current = true;
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
    spawnRound();
  }, [scheduleHeartbeat, spawnRound]);

  const runCountdown = useCallback((n) => {
    if (countdownTimerRef.current) clearTimeout(countdownTimerRef.current);
    if (n <= 0) {
      if (!isChallenge) audioSynth?.playGo();
      setPhase('playing');
      beginPlaying();
      return;
    }
    setCountdownValue(n);
    if (!isChallenge) audioSynth?.playCountdownTick();
    countdownTimerRef.current = setTimeout(() => runCountdown(n - 1), 700);
  }, [beginPlaying, isChallenge]);

  const enterDrill = useCallback(async () => {
    try { audioSynth?.init(); } catch (e) {}

    gameActiveRef.current = false;
    [roundTimerRef, heartbeatTimerRef, overdriveTimeoutRef, countdownTimerRef].forEach((r) => { if (r.current) { clearTimeout(r.current); r.current = null; } });
    if (gameTimerRef.current) { clearInterval(gameTimerRef.current); gameTimerRef.current = null; }

    const startLevel = Math.max(1, Math.min(MAX_LEVEL, Math.round((bestLevel || 1) * 0.55)));

    scoreRef.current = 0;
    livesRef.current = MAX_LIVES;
    comboRef.current = 0;
    bestComboRef.current = 0;
    levelRef.current = startLevel;
    bestLevelRunRef.current = startLevel;
    mistakesRef.current = 0;
    correctActionsRef.current = 0;
    totalActionsRef.current = 0;
    overdriveMeterRef.current = 0;
    overdriveActiveRef.current = false;
    overdriveCountRef.current = 0;
    timeRemainingRef.current = totalTime;
    wrongTapsRef.current = 0;
    timeoutsRef.current = 0;
    legendRef.current = [];
    targetRef.current = null;
    reencodingGraceActiveRef.current = false;

    const startP = (startLevel - 1) / 14;
    deadlineMsRef.current = Math.round(2200 - startP * 1300);
    legendSizeRef.current = Math.round(6 + startP * 3);
    reshuffleMagnitudeRef.current = Math.max(2, Math.min(legendSizeRef.current, Math.round(2 + startP * (legendSizeRef.current - 2))));
    keypadShuffleProbRef.current = startP;

    setScore(0);
    setLives(MAX_LIVES);
    setCombo(0);
    setLevel(startLevel);
    setTimeRemaining(totalTime);
    setDangerLevel(0);
    setKeyMap([]);
    setKeypadOrder([]);
    setCurrentTarget(null);
    setEndSummary(null);
    setFlashes([]);
    setBursts([]);
    setCountdownValue(3);

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
        setPhase('countdown');
        runCountdown(isChallenge ? 0 : 3);
      }
    }, 350);
  }, [runCountdown, isChallenge, bestLevel, totalTime]);

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

  const prevChallengeIdRef = useRef(challengeId);
  useEffect(() => {
    if (challengeId === prevChallengeIdRef.current) return;
    prevChallengeIdRef.current = challengeId;
    duelAutoStartedRef.current = false;
    setPhase('start');
    setScore(0);
    setLives(MAX_LIVES);
    setEndSummary(null);
    setTimeRemaining(totalTime);
  }, [challengeId, totalTime]);

  useEffect(() => {
    const onOrientationChange = () => {
      if (phase === 'rotate-hint' && window.innerWidth > window.innerHeight) {
        setPhase('countdown');
        runCountdown(isChallenge ? 0 : 3);
      }
    };
    return onOrientationSettled(onOrientationChange);
  }, [phase, runCountdown, isChallenge]);

  const shareResult = useCallback(async () => {
    if (!endSummary) return;
    const url = 'https://skilldrills.online/drills/cognitive/processing-speed/symbol-matching';
    try {
      const grade = getGrade(endSummary.accuracy);
      const canvas = generateShareCard({
        score: endSummary.score,
        bestScore,
        accuracy: endSummary.accuracy,
        bestCombo: endSummary.bestCombo,
        rating: { letter: grade.grade, label: grade.label, emoji: grade.emoji },
        newBest: endSummary.isNewBest,
        drillName: 'Symbol Matching',
        playerName: getPlayerName(),
      });
      await shareScoreCard(url, canvas);
    } catch (e) {
      const text = `Scored ${endSummary.score} on Symbol Matching (${endSummary.accuracy}% accuracy, ${endSummary.bestCombo}x combo) — SkillDrills`;
      if (typeof navigator !== 'undefined' && navigator.share) {
        navigator.share({ title: 'Symbol Matching — SkillDrills', text, url }).catch(() => {});
      } else if (typeof navigator !== 'undefined' && navigator.clipboard) {
        navigator.clipboard.writeText(`${text} ${url}`);
      }
    }
  }, [endSummary, bestScore]);

  if (loading || !isClient) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-[#050508]">
        <div className="text-center">
          <div className="w-14 h-14 border-4 border-violet-600 border-t-transparent rounded-full animate-spin mx-auto mb-4 shadow-[0_0_20px_rgba(139,92,246,0.5)]" />
          <p className="text-slate-500 font-bold tracking-widest uppercase text-[10px] animate-pulse">Loading Decoders...</p>
        </div>
      </div>
    );
  }

  return (
    <DrillWrapper
      drillName="Symbol Matching"
      category="cognitive"
      score={score}
      timeLeft={phase === 'ended' ? 0 : Math.ceil(timeRemaining)}
      lives={lives}
      maxLives={MAX_LIVES}
      soundEnabled={soundEnabled}
      onSoundToggle={() => setSoundEnabled((v) => { audioSynth?.setEnabled(!v); return !v; })}
      backHref="/drills/cognitive"
      minimalChrome
    >
      <div
        ref={containerRef}
        onContextMenu={(e) => { if (gameActiveRef.current) e.preventDefault(); }}
        className={`absolute inset-0 select-none overflow-hidden bg-[#050508] text-white`}
        style={{
          touchAction: gameActiveRef.current ? 'none' : 'auto',
          WebkitTapHighlightColor: 'transparent',
          backgroundColor: flashBg === 'red' ? '#250508' : flashBg === 'green' ? '#052510' : '#050508',
          transition: 'background-color 0.1s ease-out'
        }}
      >
        <div className="absolute inset-0 pointer-events-none" style={{ backgroundImage: 'linear-gradient(rgba(255,255,255,0.015) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.015) 1px, transparent 1px)', backgroundSize: '40px 40px' }} />

        {phase === 'playing' && dangerLevel > 0.06 && (
          <div className="fx-vignette" style={{ '--v-min': Math.max(0.05, dangerLevel * 0.25), '--v-max': Math.min(0.55, dangerLevel * 0.75), animationDuration: `${heartbeatTempoRef.current}ms` }} />
        )}

        {flashes.map((f) => (
          <div key={f.id} className={`fx-flash ${f.variant === 'gold' ? 'fx-flash-gold' : f.variant === 'cyan' ? 'fx-flash-cyan' : 'fx-flash-red'}`} />
        ))}

        {phase === 'rotate-hint' && !isChallenge && (
          <div className="absolute inset-0 z-[100] flex flex-col items-center justify-center bg-black/95 text-center p-6">
            <div className="animate-bounce mb-5 text-violet-400"><RotateCcw className="w-12 h-12 mx-auto" /></div>
            <p className="text-sm font-bold text-white">Rotate your phone to play</p>
            <p className="text-xs text-slate-500 mt-1.5 max-w-[220px] mx-auto">Your browser can't rotate this for you — turn your device to landscape.</p>
          </div>
        )}

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
          <div className="relative h-full flex items-center justify-center p-5 overflow-y-auto z-40">
            <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(ellipse 420px 260px at 50% 8%, rgba(142,97,246,.16), transparent 70%)' }} />
            <div className="relative w-full max-w-[290px] rounded-[20px] border border-white/5 bg-[#0c0c16]/90 backdrop-blur-lg px-5 pt-5 pb-[18px] text-center shadow-[0_16px_40px_rgba(0,0,0,.5)] my-6">
              <div className="w-11 h-11 mx-auto rounded-[14px] bg-gradient-to-br from-violet-600 to-indigo-600 flex items-center justify-center mb-3 shadow-[0_0_22px_rgba(139,92,246,.35)]">
                <Compass className="w-[22px] h-[22px] text-white" />
              </div>
              <h1 className="text-[17px] font-bold tracking-tight">Symbol Matching</h1>
              <p className="text-[9px] font-bold text-slate-500 uppercase tracking-widest mt-1">45-second run</p>

              <div className="flex flex-col gap-1.5 text-left mt-3.5">
                <HowToRow icon={<Eye className="w-3.5 h-3.5 text-cyan-400 flex-shrink-0" />} node={<>Match the symbol to its number</>} />
                <HowToRow icon={<ZapIcon className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" />} node={<>The keypad reshuffles each level</>} />
                <HowToRow icon={<Ban className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />} node={<>Wrong keys cost a life · 5 lives</>} />
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

        {/* ── PLAYING (and COUNTDOWN) ── */}
        {(phase === 'playing' || phase === 'countdown') && (
          <>
            {!isChallenge && (
              <>
                <div className="absolute top-5 left-5 z-40 flex flex-col pointer-events-none">
                  <span className="text-2xl font-black text-white leading-none tabular-nums">{score}</span>
                  <div className="flex items-center gap-2 mt-1.5">
                    {isChallenge ? (
                      <span className="text-[10px] font-black text-violet-300 bg-violet-500/15 border border-violet-500/25 px-1.5 py-0.5 rounded">Lv.{level}</span>
                    ) : (
                      <span className="flex items-center gap-0.5">
                        {Array.from({ length: MAX_LIVES }).map((_, i) => (
                          <Heart key={i} className={`w-3 h-3 ${i < lives ? 'fill-red-500 text-red-500' : 'text-white/15'}`} />
                        ))}
                      </span>
                    )}
                  </div>
                </div>

                <div className="absolute top-5 right-5 z-40 flex flex-col items-end pointer-events-none select-none">
                  <span className={`text-3xl font-black font-mono leading-none tabular-nums ${timeRemaining <= 10 ? 'text-red-500 animate-pulse' : 'text-slate-300'}`}>
                    {Math.ceil(timeRemaining)}s
                  </span>
                  <span className="text-[8px] text-slate-500 font-bold uppercase tracking-widest mt-1">Time Left</span>
                </div>
              </>
            )}

            <div className="absolute top-5 left-1/2 -translate-x-1/2 z-40 flex items-center gap-1.5 sm:gap-2 max-w-[90vw] overflow-x-auto bg-black/85 border border-white/10 rounded-full px-3.5 py-1.5 pointer-events-none">
              {keyMap.map((item, idx) => (
                <div key={idx} className="flex flex-col items-center bg-white/[0.03] border border-white/5 rounded-xl px-2.5 py-1 min-w-[34px] sm:min-w-[42px]">
                  <span className="text-[13px] sm:text-base font-bold text-white leading-none">{item.symbol}</span>
                  <span className="text-[10px] sm:text-xs font-black text-violet-400 mt-1 leading-none">{item.number}</span>
                </div>
              ))}
            </div>

            <div className="relative w-full h-full flex flex-col justify-between pt-24 pb-8">
              <div className="flex-1 flex items-center justify-center relative min-h-0">
                {bursts.map((b) => (
                  <div key={b.id} className="fx-pop" style={{ left: `${b.x}%`, top: `${b.y}%`, width: 40, height: 40, marginLeft: -20, marginTop: -20, background: b.color === 'red' ? 'rgba(239,68,68,.5)' : 'rgba(34,211,238,.5)' }} />
                ))}

                {currentTarget && (
                  <div key={currentTarget.symbol} className="font-bold leading-none text-6xl sm:text-[6.5rem] md:text-[8rem] text-white animate-in zoom-in-75 duration-100 drop-shadow-[0_0_20px_rgba(255,255,255,0.15)] select-none">
                    {currentTarget.symbol}
                  </div>
                )}
              </div>

              {phase === 'playing' && keypadOrder.length > 0 && (
                <div className="w-full max-w-xl mx-auto px-4 z-40 shrink-0">
                  <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${keyMap.length || 6}, minmax(0, 1fr))` }}>
                    {keypadOrder.map((n) => (
                      <button
                        key={n}
                        data-digit={n}
                        onPointerDown={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          handleInput(n, e.currentTarget);
                        }}
                        className="h-10 sm:h-12 md:h-14 rounded-xl font-black flex items-center justify-center border border-white/10 bg-neutral-900/90 transition-all active:scale-95 text-sm sm:text-lg md:text-xl text-white hover:border-violet-500/50 hover:bg-white/[0.08] shadow-[0_0_15px_rgba(0,0,0,0.3)] touch-none cursor-pointer"
                        aria-label={`Digit ${n}`}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </>
        )}

        {/* ── COUNTDOWN SCREEN ── */}
        {phase === 'countdown' && !isChallenge && (
          <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/55 backdrop-blur-[2px]">
            <span className="text-[11px] font-black uppercase tracking-[0.2em] text-slate-400">Get Ready</span>
            <div className="relative w-28 h-28 rounded-full border-[3px] border-violet-500/20 flex items-center justify-center">
              <div className="absolute -inset-[3px] rounded-full border-[3px] border-transparent border-t-violet-400 border-r-violet-400 animate-spin" style={{ animationDuration: '0.7s' }} />
              <span key={countdownValue} className="fx-pop-in text-5xl font-black bg-gradient-to-b from-white to-violet-300 bg-clip-text text-transparent">
                {countdownValue > 0 ? countdownValue : 'GO'}
              </span>
            </div>
            <span className="text-[10px] text-slate-500">Legend shuffles at GO</span>
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