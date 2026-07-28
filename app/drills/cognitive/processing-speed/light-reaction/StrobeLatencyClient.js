'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { 
  Compass, Volume2, VolumeX, Eye, Zap, Ban,
  Share2, ArrowLeft, Heart, RotateCcw
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
const MIN_FLASH_DURATION = 100;
const MAX_FLASH_DURATION = 400;
const FLASH_DURATION_SHRINK_ON_HIT = 30;
const MAX_LEVEL = 15;
const STORAGE_KEY = 'skilldrills_strobe_latency_v1';

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
// STORAGE HELPERS
// ==========================================
const getSavedData = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
    const sScore = localStorage.getItem('skilldrills_strobe_best_score_v3');
    const sCombo = localStorage.getItem('skilldrills_strobe_best_combo_v3');
    return {
      bestScore: sScore ? parseInt(sScore, 10) || 0 : 0,
      bestCombo: sCombo ? parseInt(sCombo, 10) || 0 : 0,
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
export default function StrobeLatencyClient() {
  const searchParams = useSearchParams();
  const challengeId = searchParams ? searchParams.get('challengeId') : null;
  const isChallenge = !!challengeId;
  const totalTime = isChallenge ? 30 : TOTAL_TIME;
  const matchStartAt = useDuelMatchStart(challengeId);
  const duelAutoStartedRef = useRef(false);

  // === UI State ===
  const [loading, setLoading] = useState(true);
  const [isClient, setIsClient] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);

  // === Game State ===
  const [phase, setPhase] = useState('start'); // 'start', 'rotate-hint', 'countdown', 'playing', 'ended'
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

  // === Strobe Mechanics ===
  const [isFlashing, setIsFlashing] = useState(false);
  const [perfectHits, setPerfectHits] = useState(0);
  const [failedHits, setFailedHits] = useState(0);
  const [bestReaction, setBestReaction] = useState(0);
  const [flashDuration, setFlashDuration] = useState(MAX_FLASH_DURATION);

  const [flashes, setFlashes] = useState([]);
  const [endSummary, setEndSummary] = useState(null);

  // === Decoupled Refs ===
  const mountedRef = useRef(false);
  const containerRef = useRef(null);

  const phaseRef = useRef('start');
  const scoreRef = useRef(0);
  const timeRef = useRef(totalTime);
  const comboRef = useRef(0);
  const bestComboRef = useRef(0);
  const livesRef = useRef(MAX_LIVES);
  const levelRef = useRef(1);
  const bestLevelRunRef = useRef(1);

  const perfectHitsRef = useRef(0);
  const failedHitsRef = useRef(0);
  const mistakesRef = useRef(0);
  const totalActionsRef = useRef(0);
  const bestReactionRef = useRef(0);

  const flashDurationRef = useRef(MAX_FLASH_DURATION);
  const isReactionWindowOpenRef = useRef(false);
  const startTimeRef = useRef(0);

  const globalTimerIntervalRef = useRef(null);
  const countdownTimerRef = useRef(null);

  const cycleTimeoutRef = useRef(null);
  const visualTimeoutRef = useRef(null);
  const reactionTimeoutRef = useRef(null);
  const activeFlashDurationRef = useRef(MAX_FLASH_DURATION);

  const heartbeatTimerRef = useRef(null);
  const heartbeatTempoRef = useRef(1100);

  useEffect(() => {
    if (audioSynth) audioSynth.setEnabled(soundEnabled);
  }, [soundEnabled]);

  const clearTimers = useCallback(() => {
    if (globalTimerIntervalRef.current) clearInterval(globalTimerIntervalRef.current);
    if (countdownTimerRef.current) clearTimeout(countdownTimerRef.current);
    if (cycleTimeoutRef.current) clearTimeout(cycleTimeoutRef.current);
    if (visualTimeoutRef.current) clearTimeout(visualTimeoutRef.current);
    if (reactionTimeoutRef.current) clearTimeout(reactionTimeoutRef.current);
    if (heartbeatTimerRef.current) clearTimeout(heartbeatTimerRef.current);
  }, []);

  const triggerFlash = useCallback((variant) => {
    const id = Date.now() + Math.random();
    setFlashes(prev => [...prev, { id, variant }]);
    setTimeout(() => {
      if (mountedRef.current) setFlashes(prev => prev.filter(f => f.id !== id));
    }, 150);
  }, []);

  const updateDifficulty = useCallback(() => {
    const calculatedLevel = Math.min(MAX_LEVEL, Math.floor(scoreRef.current / 50) + 1);
    if (calculatedLevel > levelRef.current) {
      levelRef.current = calculatedLevel;
      bestLevelRunRef.current = Math.max(bestLevelRunRef.current, calculatedLevel);
      setLevel(calculatedLevel);
    }
  }, []);

  const endGameRef = useRef(null);

  const endGame = useCallback(async (reason) => {
    clearTimers();
    setPhase('ended');
    phaseRef.current = 'ended';
    setIsFlashing(false);
    isReactionWindowOpenRef.current = false;

    audioSynth?.playResultsReveal();

    const total = totalActionsRef.current;
    const finalAccuracy = total > 0 ? Math.round((perfectHitsRef.current / total) * 100) : 100;

    const bonuses = calcEndBonuses({
      rawScore: scoreRef.current,
      accuracy: finalAccuracy,
      bestCombo: bestComboRef.current,
      totalActions: total,
      mistakes: mistakesRef.current,
      livesRemaining: Math.max(0, livesRef.current),
      maxLives: MAX_LIVES,
      category: 'cognitive',
    });

    const finalTotalScore = bonuses.finalScore;
    const saved = getSavedData();
    const isNew = finalTotalScore > saved.bestScore;

    const updated = {
      bestScore: Math.max(saved.bestScore, finalTotalScore),
      bestCombo: Math.max(saved.bestCombo, bestComboRef.current),
      bestLevel: Math.max(saved.bestLevel || 1, bestLevelRunRef.current),
      totalSessions: (saved.totalSessions || 0) + 1,
    };
    saveData(updated);

    setBestScore(updated.bestScore);
    setBestCombo(updated.bestCombo);
    setBestLevel(updated.bestLevel);

    const daily = isChallenge
      ? { isDailyDrill: false, wouldCompleteSet: false }
      : await previewDailyCompletion('light-reaction');

    const xpResult = calcSessionXP({
      finalScore: finalTotalScore,
      accuracy: finalAccuracy,
      isNewBest: isNew,
      firstPlay: saved.totalSessions === 0,
      dailyChallenge: daily.isDailyDrill,
      dailyChallengeSetComplete: daily.wouldCompleteSet,
    });

    saveLeaderboardEntrySync({
      drillId: 'light-reaction',
      drillName: 'Strobe Latency Lab',
      category: 'cognitive',
      score: finalTotalScore,
      accuracy: finalAccuracy,
      bestCombo: bestComboRef.current,
    });

    setEndSummary({
      score: finalTotalScore,
      accuracy: finalAccuracy,
      bestCombo: bestComboRef.current,
      bestReaction: bestReactionRef.current,
      xpEarned: xpResult.xp,
      isNewBest: isNew,
    });

    if (Capacitor.isNativePlatform()) StatusBar.show().catch(() => {});
  }, [clearTimers]);

  useEffect(() => { endGameRef.current = endGame; }, [endGame]);

  const scheduleNextFlash = useCallback(() => {
    if (phaseRef.current !== 'playing') return;
    
    if (cycleTimeoutRef.current) clearTimeout(cycleTimeoutRef.current);
    const delay = 800 + Math.random() * 2000; 
    cycleTimeoutRef.current = setTimeout(() => {
      if (phaseRef.current === 'playing') {
        startFlash();
      }
    }, delay);
  }, []);

  const startFlash = useCallback(() => {
    if (phaseRef.current !== 'playing') return;
    
    isReactionWindowOpenRef.current = true;
    setIsFlashing(true);

    activeFlashDurationRef.current = flashDurationRef.current;
    startTimeRef.current = performance.now();
    audioSynth?.playHit();

    if (visualTimeoutRef.current) clearTimeout(visualTimeoutRef.current);
    visualTimeoutRef.current = setTimeout(() => {
      setIsFlashing(false);
    }, activeFlashDurationRef.current);

    if (reactionTimeoutRef.current) clearTimeout(reactionTimeoutRef.current);
    reactionTimeoutRef.current = setTimeout(() => {
      if (phaseRef.current === 'playing' && isReactionWindowOpenRef.current) {
        isReactionWindowOpenRef.current = false;
        setIsFlashing(false);
        
        failedHitsRef.current += 1;
        mistakesRef.current += 1;
        totalActionsRef.current += 1;

        comboRef.current = 0;
        setCombo(0);

        if (isChallenge) {
          scoreRef.current = Math.max(0, scoreRef.current - 5);
        } else {
          livesRef.current = Math.max(0, livesRef.current - 1);
          setLives(livesRef.current);
        }

        audioSynth?.playPenalty();
        triggerFlash('red');

        if ((!isChallenge && livesRef.current <= 0) || timeRef.current <= 0) {
          endGameRef.current?.('lives');
        } else {
          scheduleNextFlash();
        }
      }
    }, activeFlashDurationRef.current);

  }, [scheduleNextFlash, triggerFlash, isChallenge]);

  const handleInteraction = useCallback((e) => {
    if (e.target.tagName === 'BUTTON' || e.target.closest('button')) return;
    if (phaseRef.current !== 'playing') return;
    
    e.stopPropagation();

    // CORRECT HIT
    if (isReactionWindowOpenRef.current) {
      const reaction = Math.floor(performance.now() - startTimeRef.current);
      if (reaction > activeFlashDurationRef.current) return;

      isReactionWindowOpenRef.current = false;
      setIsFlashing(false);
      
      if (visualTimeoutRef.current) clearTimeout(visualTimeoutRef.current);
      if (reactionTimeoutRef.current) clearTimeout(reactionTimeoutRef.current);
      if (cycleTimeoutRef.current) clearTimeout(cycleTimeoutRef.current);

      perfectHitsRef.current += 1;
      totalActionsRef.current += 1;
      
      if (bestReactionRef.current === 0 || reaction < bestReactionRef.current) {
        bestReactionRef.current = reaction;
        setBestReaction(reaction);
      }

      const comboBefore = comboRef.current;
      comboRef.current += 1;
      setCombo(comboRef.current);
      bestComboRef.current = Math.max(bestComboRef.current, comboRef.current);

      const pts = scoreAction({
        category: 'cognitive',
        combo: comboBefore,
        reactionMs: reaction,
        timeRemaining: timeRef.current,
        totalGameTime: totalTime,
        livesRemaining: livesRef.current,
        maxLives: MAX_LIVES,
        level: levelRef.current,
        maxLevel: MAX_LEVEL
      });

      scoreRef.current += pts.total;
      setScore(scoreRef.current);

      audioSynth?.playHit();

      flashDurationRef.current = Math.max(MIN_FLASH_DURATION, flashDurationRef.current - FLASH_DURATION_SHRINK_ON_HIT);
      setFlashDuration(flashDurationRef.current);

      triggerFlash('cyan');
      updateDifficulty();

      setTimeout(() => {
        if (phaseRef.current === 'playing') {
          scheduleNextFlash();
        }
      }, 300);

    } else {
      // EARLY CLICK PENALTY
      if (visualTimeoutRef.current) clearTimeout(visualTimeoutRef.current);
      if (reactionTimeoutRef.current) clearTimeout(reactionTimeoutRef.current);
      if (cycleTimeoutRef.current) clearTimeout(cycleTimeoutRef.current);

      isReactionWindowOpenRef.current = false;
      setIsFlashing(false);

      failedHitsRef.current += 1;
      mistakesRef.current += 1;
      totalActionsRef.current += 1;

      comboRef.current = 0;
      setCombo(0);

      if (isChallenge) {
        scoreRef.current = Math.max(0, scoreRef.current - 5);
      } else {
        livesRef.current = Math.max(0, livesRef.current - 1);
        setLives(livesRef.current);
      }

      audioSynth?.playPenalty();
      triggerFlash('red');

      if ((!isChallenge && livesRef.current <= 0) || timeRef.current <= 0) {
        endGameRef.current?.('lives');
      } else {
        setTimeout(() => {
          if (phaseRef.current === 'playing') {
            scheduleNextFlash();
          }
        }, 400);
      }
    }
  }, [scheduleNextFlash, triggerFlash, updateDifficulty, totalTime, isChallenge]);

  const scheduleHeartbeat = useCallback(() => {
    if (isChallenge) return;
    if (phaseRef.current !== 'playing') return;
    const dangerFromLives = (MAX_LIVES - livesRef.current) / MAX_LIVES;
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

  const runCountdown = useCallback((n) => {
    setPhase('countdown');
    phaseRef.current = 'countdown';
    if (countdownTimerRef.current) clearTimeout(countdownTimerRef.current);

    if (n === 0) {
      if (!isChallenge) audioSynth?.playGo();
      setCountdownVal('GO');
      countdownTimerRef.current = setTimeout(() => {
        setCountdownVal(null);
        setPhase('playing');
        phaseRef.current = 'playing';

        let lastTick = Date.now();
        globalTimerIntervalRef.current = setInterval(() => {
          if (phaseRef.current !== 'playing') return;
          const now = Date.now();
          const deltaMs = now - lastTick;
          lastTick = now;

          const nextTime = Math.max(0, timeRef.current - (deltaMs / 1000));
          timeRef.current = nextTime;
          setLocalTimeRemaining(nextTime);

          if (nextTime <= 0) {
            endGameRef.current?.('time');
          }
        }, 200);

        scheduleNextFlash();
        scheduleHeartbeat();
      }, 350);
      return;
    }

    if (!isChallenge) audioSynth?.playCountdownTick();
    setCountdownVal(n);
    countdownTimerRef.current = setTimeout(() => runCountdown(n - 1), 700);
  }, [scheduleNextFlash, scheduleHeartbeat, isChallenge]);

  const enterDrill = useCallback(() => {
    if (audioSynth) audioSynth.init();
    clearTimers();

    const saved = getSavedData();
    const startLevel = Math.max(1, Math.min(MAX_LEVEL, Math.round((saved.bestLevel || 1) * 0.55)));

    setPhase('countdown');
    phaseRef.current = 'countdown';

    scoreRef.current = 0;
    setScore(0);
    timeRef.current = totalTime;
    setLocalTimeRemaining(totalTime);
    comboRef.current = 0;
    setCombo(0);
    livesRef.current = MAX_LIVES;
    setLives(MAX_LIVES);
    levelRef.current = startLevel;
    bestLevelRunRef.current = startLevel;
    setLevel(startLevel);

    perfectHitsRef.current = 0;
    failedHitsRef.current = 0;
    mistakesRef.current = 0;
    totalActionsRef.current = 0;

    flashDurationRef.current = MAX_FLASH_DURATION;
    setFlashDuration(MAX_FLASH_DURATION);
    bestReactionRef.current = 0;
    setBestReaction(0);

    setDangerLevel(0);
    setFlashes([]);
    setEndSummary(null);

    lockPortrait().catch(() => {});
    if (Capacitor.isNativePlatform()) {
      StatusBar.hide().catch(() => {});
    }

    runCountdown(isChallenge ? 0 : 3);
  }, [clearTimers, runCountdown, isChallenge, totalTime]);

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
    clearTimers();
    setPhase('start');
    phaseRef.current = 'start';
    setScore(0);
    setCombo(0);
    setLives(MAX_LIVES);
    setLocalTimeRemaining(totalTime);
    timeRef.current = totalTime;
  }, [challengeId, totalTime, clearTimers]);

  const shareDrillLink = useCallback(async () => {
    if (!endSummary) return;
    const url = 'https://skilldrills.online/drills/cognitive/processing-speed/light-reaction';
    try {
      const grade = getGrade(endSummary.accuracy);
      const canvas = generateShareCard({
        score: endSummary.score,
        bestScore,
        accuracy: endSummary.accuracy,
        bestCombo: endSummary.bestCombo,
        rating: { letter: grade.grade, label: grade.label, emoji: grade.emoji },
        newBest: endSummary.isNewBest,
        drillName: 'Strobe Latency Lab',
        playerName: getPlayerName(),
      });
      await shareScoreCard(url, canvas);
    } catch (e) {
      const text = `Scored ${endSummary.score} on Strobe Latency Lab (${endSummary.accuracy}% accuracy, ${endSummary.bestCombo}x combo) — SkillDrills`;
      if (typeof navigator !== 'undefined' && navigator.share) {
        navigator.share({ title: 'Strobe Latency Lab — SkillDrills', text, url }).catch(() => {});
      } else if (typeof navigator !== 'undefined' && navigator.clipboard) {
        navigator.clipboard.writeText(`${text} ${url}`);
      }
    }
  }, [endSummary, bestScore]);

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
      clearTimers();
      unlockOrientation();
      if (Capacitor.isNativePlatform()) StatusBar.show().catch(() => {});
    };
  }, [clearTimers]);

  if (loading || !isClient) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#050508]">
        <div className="text-center">
          <div className="w-14 h-14 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin mx-auto mb-4 shadow-[0_0_20px_rgba(99,102,241,0.5)]"></div>
          <p className="text-slate-500 font-bold tracking-widest uppercase text-[10px] animate-pulse">Loading Latency Engine...</p>
        </div>
      </div>
    );
  }

  const timePct = Math.max(0, Math.min(100, (localTimeRemaining / totalTime) * 100));

  return (
    <DrillWrapper
      drillName="Strobe Latency Lab"
      category="cognitive"
      score={score}
      timeLeft={phase === 'ended' ? 0 : Math.ceil(localTimeRemaining)}
      soundEnabled={soundEnabled}
      onSoundToggle={() => setSoundEnabled(v => { audioSynth?.setEnabled(!v); return !v; })}
      backHref="/drills/cognitive"
      minimalChrome
    >
      <div
        ref={containerRef}
        onPointerDown={handleInteraction}
        className="absolute inset-0 select-none overflow-hidden bg-[#050508] text-white"
        style={{ 
          touchAction: phase === 'playing' ? 'none' : 'auto', 
          WebkitTapHighlightColor: 'transparent' 
        }}
      >
        {phase === 'playing' && dangerLevel > 0.06 && (
          <div className="fx-vignette" style={{ '--v-min': Math.max(0.05, dangerLevel * 0.25), '--v-max': Math.min(0.55, dangerLevel * 0.75), animationDuration: `${heartbeatTempoRef.current}ms` }} />
        )}

        <div className="absolute inset-0 pointer-events-none" style={{ backgroundImage: 'linear-gradient(rgba(255,255,255,0.015) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.015) 1px, transparent 1px)', backgroundSize: '40px 40px' }} />

        {flashes.map((f) => (
          <div key={f.id} className={`fx-flash ${f.variant === 'cyan' ? 'fx-flash-cyan' : 'fx-flash-red'}`} />
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
        {phase === 'start' && !isChallenge && (
          <div className="relative h-full flex items-center justify-center p-5 overflow-y-auto z-40">
            <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(ellipse 420px 260px at 50% 8%, rgba(99,102,241,.16), transparent 70%)' }} />
            <div className="relative w-full max-w-[290px] rounded-[20px] border border-white/5 bg-[#0c0c16]/90 backdrop-blur-lg px-5 pt-5 pb-[18px] text-center shadow-[0_16px_40px_rgba(0,0,0,.5)] my-6">
              <div className="w-11 h-11 mx-auto rounded-[14px] bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center mb-3 shadow-[0_0_22px_rgba(99,102,241,.35)]">
                <Compass className="w-[22px] h-[22px] text-white" />
              </div>
              <h1 className="text-[17px] font-bold tracking-tight text-white">Strobe Latency Lab</h1>

              <div className="flex flex-col gap-1.5 text-left mt-3.5">
                <HowToRow icon={<Eye className="w-3.5 h-3.5 text-cyan-400 flex-shrink-0" />} node={<>Focus on the centered visual sphere indicator</>} />
                <HowToRow icon={<Zap className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" />} node={<>Tap anywhere immediately when it flashes white</>} />
                <HowToRow icon={<Ban className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />} node={<>5 lives — early clicks and timeouts cost points and a life</>} />
              </div>

              <div className="grid grid-cols-3 gap-1.5 mt-3.5">
                <MiniStat label="Best" value={bestScore} color="text-yellow-400" />
                <MiniStat label="Combo" value={`${bestCombo}x`} color="text-orange-400" />
                <MiniStat label="Level" value={`Lv.${bestLevel}`} color="text-indigo-400" />
              </div>

              <button
                onClick={enterDrill}
                className="w-full mt-3.5 py-[11px] rounded-[13px] bg-gradient-to-r from-indigo-600 to-purple-600 font-bold text-[12.5px] tracking-wide active:scale-[0.97] transition-transform shadow-[0_0_20px_rgba(99,102,241,.3)] cursor-pointer text-white"
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
                    Lv.{level} ({flashDuration}ms)
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

            {/* Timer overlay top-right */}
            <div className="absolute top-5 right-5 z-40 flex flex-col items-end pointer-events-none select-none">
              <span className={`text-3xl font-black font-mono leading-none tabular-nums ${localTimeRemaining <= 10 ? 'text-red-500 animate-pulse' : 'text-slate-300'}`}>
                {Math.ceil(localTimeRemaining)}s
              </span>
              <span className="text-[8px] text-slate-500 font-bold uppercase tracking-widest mt-1">Time Left</span>
            </div>

            {/* Gameplay Area */}
            <div className="relative w-full h-[100dvh] flex flex-col items-center justify-center p-4">
              
              {/* Centered Strobe Target */}
              <div className="relative flex flex-col items-center justify-center">
                <div
                  aria-hidden
                  className={`w-28 h-28 sm:w-32 sm:h-32 rounded-full transition-colors duration-75 select-none pointer-events-none
                    ${isFlashing
                      ? 'bg-white border-4 border-white shadow-[0_0_30px_rgba(255,255,255,0.8)] scale-105'
                      : 'bg-neutral-900 border-2 border-white/10'
                    }`}
                />

              </div>

            </div>
          </>
        )}

        {/* ── COUNTDOWN SCREEN ── */}
        {phase === 'countdown' && !isChallenge && (
          <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/55 backdrop-blur-[2px]">
            <span className="text-[11px] font-black uppercase tracking-[0.2em] text-slate-400">Get Ready</span>
            <div className="relative w-28 h-28 rounded-full border-[3px] border-indigo-500/20 flex items-center justify-center">
              <div className="absolute -inset-[3px] rounded-full border-[3px] border-transparent border-t-indigo-400 border-r-indigo-400 animate-spin" style={{ animationDuration: '0.7s' }} />
              <span key={countdownVal} className="fx-pop-in text-5xl font-black bg-gradient-to-b from-white to-indigo-300 bg-clip-text text-transparent font-mono">
                {countdownVal}
              </span>
            </div>
            <span className="text-[10px] text-slate-500">Tap when sphere flashes white</span>
          </div>
        )}

        {/* ── RESULT SCREEN ── */}
        {phase === 'ended' && endSummary && !isChallenge && (
          <ResultScreen summary={endSummary} onPlayAgain={enterDrill} onShare={shareDrillLink} />
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
        <div className="grid grid-cols-4 gap-2">
          <ResultStat label="Accuracy" value={`${summary.accuracy}%`} color="text-blue-400" />
          <ResultStat label="Combo" value={`${summary.bestCombo}x`} color="text-orange-400" />
          <ResultStat label="Reflex" value={summary.bestReaction > 0 ? `${summary.bestReaction}ms` : '---'} color="text-rose-400" />
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