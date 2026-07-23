'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  Layers, Volume2, VolumeX, Heart,
  AlertTriangle, Target, Hash, RotateCcw, ArrowLeft, Share2,
} from 'lucide-react';
import { scoreAction, calcEndBonuses, calcSessionXP, getGrade } from '../../../../../lib/scoringEngine';
import { saveLeaderboardEntrySync } from '../../../../../lib/leaderboard';
import { lockLandscape, unlockOrientation } from '../../../../../lib/orientation';
import { previewDailyCompletion } from '../../../../../lib/dailyChallenge';
import { getPlayerName } from '../../../../../lib/progressStore';
import { Capacitor } from '@capacitor/core';
import { StatusBar } from '@capacitor/status-bar';
import generateShareCard, { shareScoreCard } from '../../../../../components/ShareScoreCard';
import DrillWrapper from '../../../../../components/DrillWrapper';
import { useDuelMatchStart } from '../../../../../lib/challengeEngine';
import { drawPulseRing, hitTestCircle, canvasDpr } from '../../../../../lib/canvasFx';

// ============================================================
// TUNING
// ============================================================
const TOTAL_TIME = 45;      // fixed countdown — no add/remove-time gimmick
const MAX_LIVES = 5;        // matches CATEGORY_CONFIG.cognitive.maxLives in scoringEngine.js
const OVERDRIVE_MS = 5000;
const MAX_LEVEL = 15;
const COUNTDOWN_TICK_MS = 700;

// ============================================================
// ZERO-LATENCY AUDIO SYNTHESIZER
// ============================================================
class AudioSynthesizer {
  constructor() {
    this.ctx = null;
    this.enabled = true;
  }

  init() {
    if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  tone(freq, dur, type = 'sine', vol = 0.15, sweepTo = null) {
    if (!this.enabled || !this.ctx) return;
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

  playPulseHit() { this.tone(880, 0.12, 'sine', 0.16, 1760); }

  // Two rapid, crisp low-frequency rejections — same "bad" cue used across
  // every drill's wrong-tap/timeout now (see BatchProcessingClient.js).
  playPenalty() {
    if (!this.enabled || !this.ctx) return;
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
  // Hazard-tap shares the same rejection cue as every other "bad" event now.
  playHazardBoom() { this.playPenalty(); }

  playCountdownTick() { this.tone(440, 0.09, 'sine', 0.12, 440); }
  // Same tone() shape as the tick, just a step higher with a quick upward
  // glide — matches BatchProcessingClient.js's GO exactly.
  playGo() { this.tone(523.25, 0.18, 'triangle', 0.17, 784); }

  // Warm unison voice (two detuned sine oscillators through a lowpass) used
  // for the results reveal below — same helper as BatchProcessingClient.js.
  chimeVoice(freq, startAt, dur, vol, filterFreq = 2600) {
    if (!this.ctx) return;
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

  // Rising arpeggio into a bright sustained top note — a clean "results are
  // in" reveal that works whether the run was strong or not, replacing the
  // old sawtooth fail-buzzer that played on every ending regardless.
  playResultsReveal() {
    if (!this.enabled || !this.ctx) return;
    try {
      const t0 = this.ctx.currentTime;
      [523.25, 659.25, 783.99].forEach((freq, i) => {
        this.chimeVoice(freq, t0 + i * 0.08, 0.24, 0.13, 3200);
      });
      this.chimeVoice(1046.50, t0 + 0.26, 0.6, 0.16, 4200);
    } catch (e) {}
  }

  playHeartbeat(danger = 0) {
    if (!this.enabled || !this.ctx || danger <= 0) return;
    try {
      const vol = 0.05 + danger * 0.12;
      const t0 = this.ctx.currentTime;
      [0, 0.14].forEach((offset) => {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(70, t0 + offset);
        gain.gain.setValueAtTime(vol, t0 + offset);
        gain.gain.exponentialRampToValueAtTime(0.001, t0 + offset + 0.12);
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start(t0 + offset);
        osc.stop(t0 + offset + 0.12);
      });
    } catch (e) {}
  }

  setEnabled(status) { this.enabled = status; }
}

const audioSynth = typeof window !== 'undefined' ? new AudioSynthesizer() : null;

// ============================================================
// LOCAL BEST-STATS STORAGE (instant sync display on start card)
// ============================================================
const STORAGE_KEY = 'skilldrills_divided_attention_v7';

const getSavedData = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { bestScore: 0, bestCombo: 0, bestLevel: 1, totalSessions: 0, totalOverdrives: 0 };
    return { bestScore: 0, bestCombo: 0, bestLevel: 1, totalSessions: 0, totalOverdrives: 0, ...JSON.parse(raw) };
  } catch (e) {
    return { bestScore: 0, bestCombo: 0, bestLevel: 1, totalSessions: 0, totalOverdrives: 0 };
  }
};

const saveData = (data) => {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (e) {}
};

function pickPosition(avoid) {
  for (let i = 0; i < 6; i++) {
    const x = 12 + Math.random() * 76;
    const y = 16 + Math.random() * 70;
    if (!avoid || Math.hypot(x - avoid.x, y - avoid.y) > 24) return { x, y };
  }
  return { x: 12 + Math.random() * 76, y: 16 + Math.random() * 70 };
}

const isMobileUA = () => {
  if (typeof window === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /Mobi|Android|iPhone|iPad|iPod/i.test(ua) || window.innerWidth < 768;
};
const isPortraitNow = () => typeof window !== 'undefined' && window.innerHeight > window.innerWidth;

// ============================================================
// MAIN COMPONENT
// ============================================================
export default function DividedAttentionClient() {
  const searchParams = useSearchParams();
  const challengeId = searchParams ? searchParams.get('challengeId') : null;
  const isChallenge = !!challengeId;
  const totalTime = isChallenge ? 30 : TOTAL_TIME;
  const matchStartAt = useDuelMatchStart(challengeId);

  const [isClient, setIsClient] = useState(false);
  const [loading, setLoading] = useState(true);
  const [soundEnabled, setSoundEnabled] = useState(true);

  const [phase, setPhase] = useState('start'); // 'start' | 'countdown' | 'playing' | 'rotate-hint' | 'ended'
  const [countdownValue, setCountdownValue] = useState(3);

  // Local best-stats (start card)
  const [bestScore, setBestScore] = useState(0);
  const [bestCombo, setBestCombo] = useState(0);
  const [bestLevel, setBestLevel] = useState(1);

  // Live HUD state
  const [score, setScore] = useState(0);
  const [lives, setLives] = useState(MAX_LIVES);
  const [combo, setCombo] = useState(0);
  const [level, setLevel] = useState(1);
  const [timeRemaining, setTimeRemaining] = useState(totalTime);
  const [dangerLevel, setDangerLevel] = useState(0);

  const [currentNumber, setCurrentNumber] = useState(null);
  const [numberCycleMsUI, setNumberCycleMsUI] = useState(1900);

  const [flashes, setFlashes] = useState([]);
  const [bursts, setBursts] = useState([]);
  const [shakeCls, setShakeCls] = useState('');
  const [endSummary, setEndSummary] = useState(null);

  const mountedRef = useRef(false);
  const containerRef = useRef(null);
  const gameActiveRef = useRef(false);
  const duelAutoStartedRef = useRef(false);

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

  // Difficulty knobs (mutated by updateDifficulty)
  const targetLifeRef = useRef(1500);
  const numberCycleRef = useRef(1900);
  const hazardChanceRef = useRef(0);
  const dualChanceRef = useRef(0);
  const orbScaleRef = useRef(1);

  const primaryTargetRef = useRef(null);
  const secondaryTargetRef = useRef(null);
  const scorePopupsRef = useRef([]);
  const currentNumberRef = useRef(null);
  const numberSpawnedAtRef = useRef(0);
  const wasMatchedRef = useRef(true);
  const shakeToggleRef = useRef(0);
  const heartbeatTempoRef = useRef(1100);

  const primaryTimerRef = useRef(null);
  const secondaryTimerRef = useRef(null);
  const secondaryRetryRef = useRef(null);
  const numberTimerRef = useRef(null);
  const gameTimerRef = useRef(null);
  const heartbeatTimerRef = useRef(null);
  const overdriveTimeoutRef = useRef(null);
  const countdownTimerRef = useRef(null);

  // Canvas rendering for the two intercept-zone targets (primaryTarget/
  // secondaryTarget) — replaces individually-animated DOM elements
  // (animate-ping + box-shadow glow, mounted/unmounted every 1-2s) with one
  // shared <canvas> + one draw loop, matching QuickDodgeClient.js's pattern.
  // See ARENA_CANVAS_PERFORMANCE_PLAN.md.
  const interceptZoneRef = useRef(null);
  const orbCanvasRef = useRef(null);
  const orbCanvasSizeRef = useRef({ width: 0, height: 0 });
  const orbDrawAnimRef = useRef(null);
  const orbLastDrawRef = useRef(0);

  // ── Mount / cleanup ───────────────────────────────────────────────────────
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
      [primaryTimerRef, secondaryTimerRef, secondaryRetryRef, numberTimerRef, heartbeatTimerRef, overdriveTimeoutRef, countdownTimerRef].forEach((r) => { if (r.current) clearTimeout(r.current); });
      if (gameTimerRef.current) clearInterval(gameTimerRef.current);
      try { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); } catch (e) {}
      if (Capacitor.isNativePlatform()) {
        StatusBar.setOverlaysWebView({ overlay: false }).catch(() => {});
        StatusBar.show().catch(() => {});
      }
      unlockOrientation();
    };
  }, []);

  // ── Rotate-hint: auto-advance the instant the device is actually landscape ──
  useEffect(() => {
    if (phase !== 'rotate-hint') return;
    const check = () => { if (!isPortraitNow()) runCountdownRef.current?.(isChallenge ? 0 : 3); };
    window.addEventListener('resize', check);
    window.addEventListener('orientationchange', check);
    return () => {
      window.removeEventListener('resize', check);
      window.removeEventListener('orientationchange', check);
    };
  }, [phase]);

  // ── Juice helpers ─────────────────────────────────────────────────────────
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

  // Score release: the "+N" earned on a correct tap rises and fades from the
  // exact spot it was scored (x/y in the same 0-100 percentage space as
  // spawnBurst), drawn on the orb canvas instead of a static center banner.
  const spawnScorePopup = useCallback((x, y, text, color = '#4ade80') => {
    scorePopupsRef.current.push({ x, y, text, color, spawnedAt: Date.now() });
  }, []);

  // ── Difficulty scaling ────────────────────────────────────────────────────
  const updateDifficulty = useCallback(() => {
    const newLevel = Math.min(MAX_LEVEL, Math.floor(scoreRef.current / 40) + 1);
    if (newLevel > levelRef.current) {
      levelRef.current = newLevel;
      bestLevelRunRef.current = Math.max(bestLevelRunRef.current, newLevel);
      setLevel(newLevel);
    }
    const progress = Math.min(1, (levelRef.current - 1) / (MAX_LEVEL - 1));
    targetLifeRef.current = Math.round(1500 - progress * 850);
    numberCycleRef.current = Math.round(1900 - progress * 1100);
    hazardChanceRef.current = levelRef.current < 2 ? 0 : Math.min(0.45, (levelRef.current - 2) * 0.07);
    dualChanceRef.current = levelRef.current < 4 ? 0 : Math.min(0.5, (levelRef.current - 4) * 0.08);
    orbScaleRef.current = Math.max(0.65, 1 - progress * 0.35);
  }, []);

  // ── Overdrive ──────────────────────────────────────────────────────────────
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

  // ── Scoring resolution ────────────────────────────────────────────────────
  const resolveCorrect = useCallback((kind, spawnedAt, pos) => {
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
    if (kind === 'restraint') total = Math.round(total * 0.55);
    if (overdriveActiveRef.current) total = Math.round(total * 1.75);

    scoreRef.current += total;
    comboRef.current = comboBefore + 1;
    bestComboRef.current = Math.max(bestComboRef.current, comboRef.current);
    correctActionsRef.current += 1;
    totalActionsRef.current += 1;

    fillOverdrive(kind === 'restraint' ? 7 : 14);

    if (pos) {
      spawnBurst(pos.x, pos.y, 'cyan');
      spawnScorePopup(pos.x, pos.y, `+${total}`);
    }

    // Every correct action — pulse tap, number match, hazard restraint, combo
    // milestone — shares this one hit sound now. The "COMBO" text is the only
    // thing that still calls out a milestone; nothing else gets its own sound.
    audioSynth?.playPulseHit();

    setScore(scoreRef.current);
    setCombo(comboRef.current);
    updateDifficulty();
  }, [fillOverdrive, spawnBurst, spawnScorePopup, updateDifficulty]);

  const endGameRef = useRef(null);

  const resolveWrong = useCallback((kind, pos) => {
    if (!gameActiveRef.current) return;
    comboRef.current = 0;
    mistakesRef.current += 1;
    totalActionsRef.current += 1;
    // Floor at 0 — duels never end on empty lives, and a negative count
    // fed the heartbeat's danger formula unbounded (see scheduleHeartbeat).
    livesRef.current = Math.max(0, livesRef.current - 1);

    if (kind === 'hazard_tap') {
      triggerShake('hard');
      triggerFlash('red-hard');
      audioSynth?.playHazardBoom();
      if (pos) spawnBurst(pos.x, pos.y, 'red');
    } else {
      triggerShake('soft');
      triggerFlash('red');
      audioSynth?.playPenalty();
    }

    setScore(scoreRef.current);
    setCombo(0);
    setLives(Math.max(0, livesRef.current));

    // Duels always run the full shared clock — a rough start shouldn't end
    // your side of the match early while the opponent keeps playing.
    if (!isChallenge && livesRef.current <= 0) endGameRef.current?.('lives');
  }, [triggerShake, triggerFlash, spawnBurst]);

  // ── Game over ──────────────────────────────────────────────────────────────
  const endGame = useCallback(async (reason) => {
    if (!gameActiveRef.current) return;
    gameActiveRef.current = false;

    [primaryTimerRef, secondaryTimerRef, secondaryRetryRef, numberTimerRef, heartbeatTimerRef, overdriveTimeoutRef].forEach((r) => { if (r.current) { clearTimeout(r.current); r.current = null; } });
    if (gameTimerRef.current) { clearInterval(gameTimerRef.current); gameTimerRef.current = null; }

    audioSynth?.playResultsReveal();
    // Deliberately not reverting StatusBar here (unlike its hide() counterpart
    // in enterDrill) — the result screen rendered below still lives inside the
    // same fullscreen, landscape-locked container as gameplay. Reintroducing
    // the status bar now would force the exact resize/shake this was fixed to
    // avoid, right as results appear. It's restored in the mount-effect
    // cleanup instead (see top of file), matching exitFullscreen()/
    // unlockOrientation() there — both already deferred to actually leaving
    // the drill, not to game-over.
    triggerFlash(reason === 'lives' ? 'red-hard' : 'red');

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
    const grade = getGrade(accuracy);

    const prevSaved = getSavedData();
    const isNewBest = finalScore > prevSaved.bestScore;
    const firstPlay = prevSaved.totalSessions === 0;
    const daily = isChallenge
      ? { isDailyDrill: false, wouldCompleteSet: false }
      : await previewDailyCompletion('divided-attention');
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
      drillId: 'divided-attention',
      drillName: 'Divided Attention',
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
      grade,
      xpEarned: xpResult.xp,
    });
    setPhase('ended');
  }, [triggerFlash]);

  useEffect(() => { endGameRef.current = endGame; }, [endGame]);

  // ── Intercept zone spawn chains ────────────────────────────────────────────
  const spawnPrimary = useCallback(() => {
    if (primaryTimerRef.current) clearTimeout(primaryTimerRef.current);
    if (!gameActiveRef.current) return;
    const isHazard = Math.random() < hazardChanceRef.current;
    const pos = pickPosition(secondaryTargetRef.current);
    const target = { id: Date.now() + Math.random(), type: isHazard ? 'hazard' : 'pulse', x: pos.x, y: pos.y, spawnedAt: Date.now(), lifeMs: targetLifeRef.current };
    primaryTargetRef.current = target;

    primaryTimerRef.current = setTimeout(() => {
      if (!gameActiveRef.current || !mountedRef.current) return;
      const t = primaryTargetRef.current;
      primaryTargetRef.current = null;
      if (t) {
        if (t.type === 'pulse') resolveWrong('pulse_miss', t);
        else resolveCorrect('restraint', null, t);
      }
      spawnPrimary();
    }, target.lifeMs);
  }, [resolveWrong, resolveCorrect]);

  const attemptSecondary = useCallback(() => {
    if (secondaryRetryRef.current) clearTimeout(secondaryRetryRef.current);
    if (!gameActiveRef.current) return;
    if (Math.random() >= dualChanceRef.current) {
      secondaryRetryRef.current = setTimeout(attemptSecondary, 1100);
      return;
    }
    const isHazard = Math.random() < Math.max(0.25, hazardChanceRef.current);
    const pos = pickPosition(primaryTargetRef.current);
    const target = { id: Date.now() + Math.random(), type: isHazard ? 'hazard' : 'pulse', x: pos.x, y: pos.y, spawnedAt: Date.now(), lifeMs: Math.round(targetLifeRef.current * 0.85) };
    secondaryTargetRef.current = target;

    secondaryTimerRef.current = setTimeout(() => {
      if (!gameActiveRef.current || !mountedRef.current) return;
      const t = secondaryTargetRef.current;
      secondaryTargetRef.current = null;
      if (t) {
        if (t.type === 'pulse') resolveWrong('pulse_miss', t);
        else resolveCorrect('restraint', null, t);
      }
      secondaryRetryRef.current = setTimeout(attemptSecondary, 900 + Math.random() * 900);
    }, target.lifeMs);
  }, [resolveWrong, resolveCorrect]);

  const handlePrimaryTap = useCallback((id, e) => {
    if (e) { e.stopPropagation(); e.preventDefault(); }
    if (!gameActiveRef.current) return;
    const t = primaryTargetRef.current;
    if (!t || t.id !== id) return;
    if (primaryTimerRef.current) clearTimeout(primaryTimerRef.current);
    primaryTargetRef.current = null;
    if (t.type === 'pulse') resolveCorrect('pulse', t.spawnedAt, t);
    else resolveWrong('hazard_tap', t);
    spawnPrimary();
  }, [resolveCorrect, resolveWrong, spawnPrimary]);

  const handleSecondaryTap = useCallback((id, e) => {
    if (e) { e.stopPropagation(); e.preventDefault(); }
    if (!gameActiveRef.current) return;
    const t = secondaryTargetRef.current;
    if (!t || t.id !== id) return;
    if (secondaryTimerRef.current) clearTimeout(secondaryTimerRef.current);
    secondaryTargetRef.current = null;
    if (t.type === 'pulse') resolveCorrect('pulse', t.spawnedAt, t);
    else resolveWrong('hazard_tap', t);
    if (secondaryRetryRef.current) clearTimeout(secondaryRetryRef.current);
    secondaryRetryRef.current = setTimeout(attemptSecondary, 700 + Math.random() * 700);
  }, [resolveCorrect, resolveWrong, attemptSecondary]);

  // ── Parity stream ──────────────────────────────────────────────────────────
  const scheduleNumber = useCallback(() => {
    if (numberTimerRef.current) clearTimeout(numberTimerRef.current);
    if (!gameActiveRef.current) return;

    const prevNum = currentNumberRef.current;
    if (prevNum !== null && prevNum % 2 === 0 && !wasMatchedRef.current) {
      resolveWrong('missed_even', null);
    }

    let n;
    do { n = Math.floor(Math.random() * 10); } while (n === currentNumberRef.current);
    currentNumberRef.current = n;
    numberSpawnedAtRef.current = Date.now();
    wasMatchedRef.current = false;
    setCurrentNumber(n);
    setNumberCycleMsUI(numberCycleRef.current);

    numberTimerRef.current = setTimeout(() => {
      if (gameActiveRef.current && mountedRef.current) scheduleNumber();
    }, numberCycleRef.current);
  }, [resolveWrong]);

  const handleMatchTap = useCallback((e) => {
    if (e) { e.stopPropagation(); e.preventDefault(); }
    if (!gameActiveRef.current) return;
    const n = currentNumberRef.current;
    if (n === null) return;
    if (wasMatchedRef.current) { resolveWrong('double_tap', null); return; }
    wasMatchedRef.current = true;
    if (n % 2 === 0) resolveCorrect('number', numberSpawnedAtRef.current, null);
    else resolveWrong('wrong_match', null);
  }, [resolveCorrect, resolveWrong]);

  // ── Heartbeat / danger tempo ──────────────────────────────────────────────
  const scheduleHeartbeat = useCallback(() => {
    if (!gameActiveRef.current) return;
    // Duels: time pressure only (lives carry no stakes there). Solo: lives
    // thump only once actually low (≤2). Danger/tempo hard-clamped — an
    // unclamped danger > ~1.7 made the tempo negative and turned this
    // self-rescheduling callback into a tight infinite loop (100% CPU +
    // a wall of heartbeat audio on phones).
    const dangerFromLives = (!isChallenge && livesRef.current <= 2)
      ? (MAX_LIVES - livesRef.current) / MAX_LIVES
      : 0;
    const dangerFromTime = timeRemainingRef.current <= 10 ? (10 - timeRemainingRef.current) / 10 : 0;
    const danger = Math.min(1, Math.max(dangerFromLives * 0.7, dangerFromTime));
    const tempo = Math.max(350, Math.round(1100 - danger * 650));
    heartbeatTempoRef.current = tempo;
    if (danger > 0.08) audioSynth?.playHeartbeat(danger);
    if (mountedRef.current) setDangerLevel(danger);
    heartbeatTimerRef.current = setTimeout(scheduleHeartbeat, tempo);
  }, [isChallenge]);

  // ── Begin actual play (fires at the end of the countdown) ─────────────────
  const beginPlaying = useCallback(() => {
    if (!mountedRef.current) return;
    gameActiveRef.current = true;
    setPhase('playing');

    // 200ms rather than 100ms — the displayed clock only ever shows whole
    // seconds (Math.ceil) and the progress bar has its own CSS transition to
    // interpolate between updates, so 5 ticks/sec looks identical to 10 while
    // halving how often this re-renders the entire play field for the whole
    // match.
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
    spawnPrimary();
    scheduleNumber();
    attemptSecondary();
  }, [scheduleHeartbeat, spawnPrimary, scheduleNumber, attemptSecondary]);

  // ── 3-2-1-GO countdown (landscape is already active by the time this runs) ─
  const runCountdown = useCallback((n) => {
    if (countdownTimerRef.current) clearTimeout(countdownTimerRef.current);
    if (!mountedRef.current) return;
    setPhase('countdown');
    if (n <= 0) {
      setCountdownValue('GO');
      audioSynth?.playGo();
      countdownTimerRef.current = setTimeout(() => beginPlaying(), 350);
      return;
    }
    setCountdownValue(n);
    audioSynth?.playCountdownTick();
    countdownTimerRef.current = setTimeout(() => runCountdown(n - 1), COUNTDOWN_TICK_MS);
  }, [beginPlaying]);

  const runCountdownRef = useRef(null);
  useEffect(() => { runCountdownRef.current = runCountdown; }, [runCountdown]);

  // ── Entry point: tap START does everything — fullscreen, landscape, countdown ─
  const enterDrill = useCallback(async () => {
    try { audioSynth?.init(); } catch (e) {}

    gameActiveRef.current = false;
    [primaryTimerRef, secondaryTimerRef, secondaryRetryRef, numberTimerRef, heartbeatTimerRef, overdriveTimeoutRef, countdownTimerRef].forEach((r) => { if (r.current) { clearTimeout(r.current); r.current = null; } });
    if (gameTimerRef.current) { clearInterval(gameTimerRef.current); gameTimerRef.current = null; }

    // Returning players start closer to their proven skill level instead of
    // always grinding through level 1 again — ~75% of their best level reached.
    // First-time players (no saved bestLevel) still start at level 1.
    const startLevel = Math.max(1, Math.min(MAX_LEVEL, Math.round((bestLevel || 1) * 0.75)));

    scoreRef.current = 0; livesRef.current = MAX_LIVES; comboRef.current = 0; bestComboRef.current = 0;
    levelRef.current = startLevel; bestLevelRunRef.current = startLevel; mistakesRef.current = 0; correctActionsRef.current = 0; totalActionsRef.current = 0;
    overdriveMeterRef.current = 0; overdriveActiveRef.current = false; overdriveCountRef.current = 0;
    timeRemainingRef.current = totalTime;
    // Seed the difficulty knobs from the starting level using the same curve
    // as updateDifficulty() (which only re-derives these after a correct hit,
    // not on every spawn) — otherwise the first targets/numbers spawned this
    // run would use level-1 pacing while the HUD already shows a higher level.
    {
      const startProgress = Math.min(1, (startLevel - 1) / (MAX_LEVEL - 1));
      targetLifeRef.current = Math.round(1500 - startProgress * 850);
      numberCycleRef.current = Math.round(1900 - startProgress * 1100);
      hazardChanceRef.current = startLevel < 2 ? 0 : Math.min(0.45, (startLevel - 2) * 0.07);
      dualChanceRef.current = startLevel < 4 ? 0 : Math.min(0.5, (startLevel - 4) * 0.08);
      orbScaleRef.current = Math.max(0.65, 1 - startProgress * 0.35);
    }
    primaryTargetRef.current = null; secondaryTargetRef.current = null; scorePopupsRef.current = []; currentNumberRef.current = null; wasMatchedRef.current = true;

    setScore(0); setLives(MAX_LIVES); setCombo(0); setLevel(startLevel); setTimeRemaining(totalTime);
    setDangerLevel(0);
    setCurrentNumber(null);
    setEndSummary(null); setFlashes([]); setBursts([]);

    // Skip real Fullscreen API during a live 1v1 duel — DrillWrapper's header/opponent-score bar
    // live outside this element, and the Fullscreen API would hide them for the whole match.
    try { if (!isChallenge && !document.fullscreenElement && containerRef.current) await containerRef.current.requestFullscreen(); } catch (e) {}
    if (Capacitor.isNativePlatform()) {
      // overlaysWebView:true keeps the window's layout size stable regardless
      // of status-bar visibility (SYSTEM_UI_FLAG_LAYOUT_STABLE), so if a swipe
      // from the top edge brings the status bar back mid-drill, it draws as a
      // transient overlay on top of the game instead of physically resizing
      // the WebView and shoving this fullscreen board down the screen.
      StatusBar.setOverlaysWebView({ overlay: true }).catch(() => {});
      StatusBar.hide().catch(() => {});
    }
    try { await lockLandscape(); } catch (e) {}

    setTimeout(() => {
      if (!mountedRef.current) return;
      if (isMobileUA() && isPortraitNow()) {
        setPhase('rotate-hint');
      } else {
        runCountdown(isChallenge ? 0 : 3);
      }
    }, 300);
  }, [runCountdown, isChallenge, bestLevel, totalTime]);

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

  // ── Intercept-zone canvas: sizing + draw loop ──────────────────────────────
  // Mirrors QuickDodgeClient.js's canvas effect exactly — sized via
  // ResizeObserver once the canvas is actually in the DOM ('playing'/
  // 'countdown'), drawing primaryTarget/secondaryTarget read straight from
  // their refs (never synced to React state) every frame, capped to ~30fps
  // since these are a couple of slow-pulsing circles, not a physics scene.
  useEffect(() => {
    if (phase !== 'playing' && phase !== 'countdown') {
      if (orbDrawAnimRef.current) { cancelAnimationFrame(orbDrawAnimRef.current); orbDrawAnimRef.current = null; }
      return;
    }

    const resizeOrbCanvas = () => {
      const cvs = orbCanvasRef.current;
      const el = interceptZoneRef.current;
      if (!cvs || !el) return;
      const rect = el.getBoundingClientRect();
      const dpr = canvasDpr();
      cvs.width = rect.width * dpr;
      cvs.height = rect.height * dpr;
      orbCanvasSizeRef.current = { width: rect.width, height: rect.height };
    };

    resizeOrbCanvas();
    const ro = new ResizeObserver(resizeOrbCanvas);
    if (interceptZoneRef.current) ro.observe(interceptZoneRef.current);
    window.addEventListener('resize', resizeOrbCanvas);
    window.addEventListener('orientationchange', resizeOrbCanvas);

    const baseOrbRadius = () => (window.innerWidth >= 640 ? 28 : 22);

    const drawOrb = (ctx, t, r) => {
      const w = orbCanvasSizeRef.current.width;
      const h = orbCanvasSizeRef.current.height;
      const cx = (t.x / 100) * w;
      const cy = (t.y / 100) * h;
      const isHazard = t.type === 'hazard';
      const time = performance.now() * 0.001;

      // Entrance pop — canvas equivalent of the CSS fx-pop-in scale-in.
      const popT = Math.min(1, (Date.now() - t.spawnedAt) / 180);
      const popScale = popT < 1 ? 0.5 + 0.5 * popT + Math.sin(popT * Math.PI) * 0.08 : 1;
      const orbR = r * popScale;

      drawPulseRing(ctx, cx, cy, orbR, isHazard ? 'rgba(252,165,165,1)' : 'rgba(147,197,253,1)', time, t.id % 10, 1, 2, 0.5);

      // Layered-circle style matching Conflict Reflex's drawLayeredCircle —
      // blue for the correct-to-tap target, red for the hazard to avoid.
      // Flat fills only (no gradient, no shadowBlur), which also sidesteps
      // the Android WebView gradient+shadowBlur rendering bug the previous
      // glow-gradient version had to work around.
      const colorHex = isHazard ? '#ef4444' : '#3b82f6';
      ctx.save();
      ctx.globalAlpha = 0.2;
      ctx.strokeStyle = colorHex;
      ctx.lineWidth = 1.0;
      ctx.beginPath();
      ctx.arc(cx, cy, orbR + 5, 0, Math.PI * 2);
      ctx.stroke();

      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = colorHex;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.arc(cx, cy, orbR, 0, Math.PI * 2);
      ctx.stroke();

      ctx.globalAlpha = 0.88;
      ctx.fillStyle = colorHex;
      ctx.beginPath();
      ctx.arc(cx, cy, orbR * 0.82, 0, Math.PI * 2);
      ctx.fill();

      ctx.globalAlpha = 0.3;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(cx - orbR * 0.2, cy - orbR * 0.2, orbR * 0.28, 0, Math.PI * 2);
      ctx.fill();

      ctx.globalAlpha = 1.0;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(cx, cy, orbR * 0.18, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    };

    // Score release particles — same in-canvas model as
    // BatchProcessingClient.js / ReflexTrainingDrillClient.tsx: fades and
    // rises for ~1s, driven off real elapsed time rather than a per-frame
    // step, since this loop has no frame-scale/dt tracking of its own.
    const drawScorePopup = (ctx, p) => {
      const w = orbCanvasSizeRef.current.width;
      const h = orbCanvasSizeRef.current.height;
      const elapsed = (Date.now() - p.spawnedAt) / 1000;
      const life = 1 - elapsed;
      if (life <= 0) return;
      const cx = (p.x / 100) * w;
      const cy = (p.y / 100) * h - elapsed * 38;
      ctx.save();
      ctx.globalAlpha = life;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = 'bold 15px monospace';
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, cx, cy);
      ctx.restore();
    };

    const draw = (timestamp) => {
      const cvs = orbCanvasRef.current;
      const ctx = cvs?.getContext('2d');
      if (!ctx) { orbDrawAnimRef.current = requestAnimationFrame(draw); return; }

      // ~30fps cap — a couple of slow-pulsing circles don't need a full 60Hz
      // redraw; this halves the drawing work for free.
      if (timestamp - orbLastDrawRef.current < 33) {
        orbDrawAnimRef.current = requestAnimationFrame(draw);
        return;
      }
      orbLastDrawRef.current = timestamp;

      const w = orbCanvasSizeRef.current.width;
      const h = orbCanvasSizeRef.current.height;
      const dpr = canvasDpr();

      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, w, h);

      if (phase === 'playing') {
        const r = baseOrbRadius() * orbScaleRef.current;
        const p = primaryTargetRef.current;
        const s = secondaryTargetRef.current;
        if (p) drawOrb(ctx, p, r);
        if (s) drawOrb(ctx, s, r);

        const pops = scorePopupsRef.current;
        for (let i = pops.length - 1; i >= 0; i--) {
          if (Date.now() - pops[i].spawnedAt > 1000) { pops.splice(i, 1); continue; }
          drawScorePopup(ctx, pops[i]);
        }
      }

      ctx.restore();
      orbDrawAnimRef.current = requestAnimationFrame(draw);
    };

    orbLastDrawRef.current = 0;
    orbDrawAnimRef.current = requestAnimationFrame(draw);

    return () => {
      if (orbDrawAnimRef.current) cancelAnimationFrame(orbDrawAnimRef.current);
      ro.disconnect();
      window.removeEventListener('resize', resizeOrbCanvas);
      window.removeEventListener('orientationchange', resizeOrbCanvas);
    };
  }, [phase]);

  // Single tap handler for the whole intercept zone, replacing the old
  // per-orb <button onPointerDown>. Hit-tests the tap position (converted to
  // the zone's own pixel space) against whichever targets are currently live,
  // reusing handlePrimaryTap/handleSecondaryTap exactly as before — only how
  // they get invoked has changed, not what they do.
  const handleZonePointerDown = useCallback((e) => {
    if (!gameActiveRef.current || phase !== 'playing') return;
    const rect = interceptZoneRef.current?.getBoundingClientRect();
    if (!rect) return;
    const tapX = e.clientX - rect.left;
    const tapY = e.clientY - rect.top;
    const r = (window.innerWidth >= 640 ? 28 : 22) * orbScaleRef.current;

    const p = primaryTargetRef.current;
    if (p && hitTestCircle(tapX, tapY, (p.x / 100) * rect.width, (p.y / 100) * rect.height, r)) {
      handlePrimaryTap(p.id, e);
      return;
    }
    const s = secondaryTargetRef.current;
    if (s && hitTestCircle(tapX, tapY, (s.x / 100) * rect.width, (s.y / 100) * rect.height, r)) {
      handleSecondaryTap(s.id, e);
    }
  }, [phase, handlePrimaryTap, handleSecondaryTap]);

  const shareResult = useCallback(async () => {
    if (!endSummary) return;
    const url = 'https://skilldrills.online/drills/cognitive/attention/divided-attention';
    try {
      const grade = getGrade(endSummary.accuracy);
      const canvas = generateShareCard({
        score: endSummary.score,
        bestScore,
        accuracy: endSummary.accuracy,
        bestCombo: endSummary.bestCombo,
        rating: { letter: grade.grade, label: grade.label, emoji: grade.emoji },
        newBest: endSummary.isNewBest,
        drillName: 'Divided Attention',
        playerName: getPlayerName(),
      });
      await shareScoreCard(url, canvas);
    } catch (e) {
      const text = `🧠 Scored ${endSummary.score} pts on Divided Attention — ${endSummary.accuracy}% accuracy, Grade ${endSummary.grade.grade}. Play at skilldrills.online/drills/cognitive/attention/divided-attention`;
      if (typeof navigator !== 'undefined' && navigator.share) {
        navigator.share({ title: 'Divided Attention — SkillDrills', text }).catch(() => {});
      } else if (typeof navigator !== 'undefined' && navigator.clipboard) {
        navigator.clipboard.writeText(text);
      }
    }
  }, [endSummary, bestScore]);

  if (loading || !isClient) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-[#050508]">
        <div className="text-center">
          <div className="w-14 h-14 border-4 border-violet-600 border-t-transparent rounded-full animate-spin mx-auto mb-4 shadow-[0_0_20px_rgba(139,92,246,0.5)]" />
          <p className="text-slate-500 font-bold tracking-widest uppercase text-[10px] animate-pulse">Loading...</p>
        </div>
      </div>
    );
  }

  const timePct = Math.max(0, Math.min(100, (timeRemaining / totalTime) * 100));
  const showBoard = phase === 'playing' || phase === 'countdown';

  return (
    <DrillWrapper
      drillName="Divided Attention"
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
      style={{ touchAction: gameActiveRef.current ? 'none' : 'auto', WebkitTapHighlightColor: 'transparent' }}
    >
      {/* ambient grid */}
      <div className="absolute inset-0 pointer-events-none" style={{ backgroundImage: 'linear-gradient(rgba(255,255,255,0.015) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.015) 1px, transparent 1px)', backgroundSize: '40px 40px' }} />

      {/* danger vignette */}
      {phase === 'playing' && dangerLevel > 0.06 && (
        <div className="fx-vignette" style={{ '--v-min': Math.max(0.05, dangerLevel * 0.25), '--v-max': Math.min(0.55, dangerLevel * 0.75), animationDuration: `${heartbeatTempoRef.current}ms` }} />
      )}

      {/* flashes */}
      {flashes.map((f) => (
        <div key={f.id} className={`fx-flash ${f.variant === 'gold' ? 'fx-flash-gold' : f.variant === 'cyan' ? 'fx-flash-cyan' : 'fx-flash-red'}`} />
      ))}

      {/* ── ROTATE HINT (only if programmatic lock genuinely failed — mainly iOS) ── */}
      {phase === 'rotate-hint' && !isChallenge && (
        <div className="absolute inset-0 z-[100] flex flex-col items-center justify-center bg-black/95 text-center p-6 backdrop-blur-sm">
          <div className="animate-bounce mb-5 text-violet-500"><RotateCcw className="w-14 h-14 mx-auto" /></div>
          <h3 className="text-lg font-bold text-white mb-2">Rotate to play</h3>
          <p className="text-xs text-gray-400 max-w-xs mx-auto">This drill runs in landscape. Turn your device — it'll continue on its own.</p>
        </div>
      )}

      {/* ── START SCREEN ── */}
      {phase === 'start' && !isChallenge && (
        <div className="relative h-full flex items-center justify-center p-5 overflow-y-auto">
          <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(ellipse 420px 260px at 50% 8%, rgba(142,97,246,.16), transparent 70%)' }} />
          <div className="relative w-full max-w-[280px] rounded-[20px] border border-white/5 bg-[#0c0c16]/90 backdrop-blur-lg px-5 pt-5 pb-[18px] text-center shadow-[0_16px_40px_rgba(0,0,0,.5)] my-6">
            <div className="w-11 h-11 mx-auto rounded-[14px] bg-gradient-to-br from-violet-600 to-indigo-600 flex items-center justify-center mb-3 shadow-[0_0_22px_rgba(139,92,246,.35)]">
              <Layers className="w-[22px] h-[22px] text-white" />
            </div>
            <h1 className="text-[17px] font-bold tracking-tight">Divided Attention</h1>

            <div className="flex flex-col gap-1.5 text-left mt-3.5">
              <div className="flex items-center gap-2 bg-white/[0.02] border border-white/5 rounded-[10px] px-2.5 py-[7px]">
                <Target className="w-3.5 h-3.5 text-cyan-400 flex-shrink-0" />
                <span className="text-[10.5px] text-slate-300 leading-tight">Tap <b className="text-white">pulse</b> targets the instant they appear</span>
              </div>
              <div className="flex items-center gap-2 bg-white/[0.02] border border-white/5 rounded-[10px] px-2.5 py-[7px]">
                <AlertTriangle className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />
                <span className="text-[10.5px] text-slate-300 leading-tight"><b className="text-white">Avoid</b> red hazards — let them expire</span>
              </div>
              <div className="flex items-center gap-2 bg-white/[0.02] border border-white/5 rounded-[10px] px-2.5 py-[7px]">
                <Hash className="w-3.5 h-3.5 text-violet-400 flex-shrink-0" />
                <span className="text-[10.5px] text-slate-300 leading-tight">Match only when the number is <b className="text-white">even</b></span>
              </div>
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

          <button
            onClick={() => setSoundEnabled((v) => { audioSynth?.setEnabled(!v); return !v; })}
            className="absolute bottom-3.5 right-4 w-[26px] h-[26px] rounded-full bg-white/[0.04] border border-white/[0.08] flex items-center justify-center text-slate-500 hover:text-white transition-colors cursor-pointer"
          >
            {soundEnabled ? <Volume2 className="w-3 h-3" /> : <VolumeX className="w-3 h-3" />}
          </button>
        </div>
      )}

      {/* ── COUNTDOWN VEIL ── */}
      {phase === 'countdown' && !isChallenge && (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/60 backdrop-blur-[2px]">
          <span className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-400">Get Ready</span>
          <div className="relative w-28 h-28 rounded-full border-[3px] border-violet-500/20 flex items-center justify-center">
            <div className="absolute -inset-[3px] rounded-full border-[3px] border-transparent border-t-violet-400 border-r-violet-400 animate-spin" style={{ animationDuration: '0.7s' }} />
            <span key={countdownValue} className="fx-pop-in text-5xl font-black bg-gradient-to-b from-white to-violet-300 bg-clip-text text-transparent">
              {countdownValue}
            </span>
          </div>
          <span className="text-[10px] text-slate-500">Targets spawn at GO</span>
        </div>
      )}

      {/* ── PLAYING / COUNTDOWN BOARD ── */}
      {showBoard && (
        <>
          {!isChallenge && (
          <>
          {/* top time bar */}
          <div className="absolute top-0 left-0 right-0 h-1.5 bg-neutral-950 z-[60] pointer-events-none">
            <div className={`h-full transition-all duration-200 ease-linear ${timeRemaining <= 10 ? 'bg-red-500 animate-pulse' : 'bg-violet-500'}`} style={{ width: `${timePct}%` }} />
          </div>

          {/* Single consolidated HUD cluster — score, level, lives, timer all in one block */}
          <div className="absolute top-5 left-5 z-40 flex flex-col pointer-events-none select-none">
            <span className="text-2xl font-black text-white leading-none tabular-nums">{score}</span>
            <div className="flex items-center gap-2 mt-1.5">
              {isChallenge ? (
                <span className="text-[10px] font-black text-violet-300 bg-violet-500/10 border border-violet-500/20 px-1.5 py-0.5 rounded font-mono">Lv.{level}</span>
              ) : (
                <span className="flex items-center gap-0.5">
                  {Array.from({ length: MAX_LIVES }).map((_, i) => (
                    <Heart key={i} className={`w-[11px] h-[11px] ${i < lives ? 'fill-red-500 text-red-500' : 'fill-transparent text-white/20'}`} />
                  ))}
                </span>
              )}
            </div>
          </div>

          {/* Timer — top-right corner */}
          <div className="absolute top-5 right-5 z-40 flex flex-col items-end pointer-events-none select-none">
            <span className={`text-3xl font-black font-mono leading-none tabular-nums ${timeRemaining <= 10 ? 'text-red-500 animate-pulse' : 'text-slate-300'}`}>
              {Math.ceil(timeRemaining)}s
            </span>
            <span className="text-[8px] text-slate-500 font-bold uppercase tracking-widest mt-1">Time Left</span>
          </div>
          </>
          )}

          {/* play field */}
          <div className="flex flex-col sm:flex-row h-full">
            {/* intercept zone — sound toggle lives in here, so its position
                is relative to this zone's own edge and never depends on the match panel's width.
                Targets draw on a single canvas (see the resize/draw effect above) instead of as
                individually-animated DOM elements — onPointerDown here hit-tests taps against
                whichever targets are currently live. */}
            <div
              ref={interceptZoneRef}
              onPointerDown={handleZonePointerDown}
              className="relative flex-1 bg-transparent overflow-hidden touch-none"
            >
              {bursts.map((b) => (
                <div key={b.id} className="fx-pop" style={{ left: `${b.x}%`, top: `${b.y}%`, width: 40, height: 40, marginLeft: -20, marginTop: -20, background: b.color === 'red' ? 'rgba(239,68,68,.5)' : 'rgba(34,211,238,.5)' }} />
              ))}
              <canvas ref={orbCanvasRef} className="absolute inset-0 z-20 w-full h-full block pointer-events-none" />

              {/* sound toggle — icon only, bottom-right of the intercept zone */}
              <button
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); setSoundEnabled((v) => { audioSynth?.setEnabled(!v); return !v; }); }}
                className="absolute bottom-4 right-4 z-40 p-2 rounded-full bg-black/60 border border-white/10 text-slate-400 active:scale-90 transition-transform"
              >
                {soundEnabled ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
              </button>
            </div>

            {/* compact match panel — just the number and the button, no heading, no caption.
                Width scales with viewport instead of a fixed px value so narrow landscape
                phones still leave a real intercept zone. */}
            {/* Solid instead of backdrop-blur-md — at 92%+ opacity the blur was
                already invisible under the panel, but the browser still had
                to keep re-blurring whatever moved behind it for the entire
                match. A flat near-solid fill looks the same and costs nothing
                to composite. */}
            <div className="w-full sm:w-[26vw] sm:min-w-[152px] sm:max-w-[210px] h-[110px] sm:h-auto flex-shrink-0 bg-[#07070f] border-t sm:border-t-0 sm:border-l border-white/5 z-30 flex flex-row sm:flex-col items-center justify-center gap-3 sm:gap-3 p-3 sm:p-5">
              <div className="relative flex items-center justify-center w-[70px] h-[70px] sm:w-20 sm:h-20 rounded-2xl bg-black border border-violet-500/20 overflow-hidden">
                <div className="text-3xl sm:text-4xl font-black text-white font-mono pointer-events-none">
                  {currentNumber !== null ? (
                    <span key={currentNumber} className="fx-fade-up block">{currentNumber}</span>
                  ) : '?'}
                </div>
                {currentNumber !== null && phase === 'playing' && (
                  <div key={`bar-${currentNumber}`} className="absolute bottom-0 left-0 right-0 h-[3px] bg-white/5">
                    <div className="fx-shrink h-full bg-violet-400" style={{ animationDuration: `${numberCycleMsUI}ms` }} />
                  </div>
                )}
              </div>

              <button
                onPointerDown={handleMatchTap}
                className="flex-1 sm:flex-none sm:w-full py-3 sm:py-3 bg-gradient-to-r from-violet-600 to-indigo-700 text-white rounded-[13px] font-bold text-xs uppercase tracking-wide active:scale-95 transition-all border border-violet-400/20 touch-none focus:outline-none cursor-pointer text-center"
              >
                MATCH
              </button>
            </div>
          </div>
        </>
      )}

      {/* ── RESULT SCREEN — landscape two-column layout, nothing to scroll ── */}
      {phase === 'ended' && endSummary && !isChallenge && (
        <div className="absolute inset-0 z-40 flex" style={{ background: 'rgba(5,5,8,0.97)' }}>
          <div className="w-[36%] flex flex-col items-center justify-center gap-1.5 border-r border-white/5" style={{ background: 'radial-gradient(ellipse 260px 200px at 50% 30%, rgba(250,204,21,.08), transparent 70%)' }}>
            {endSummary.isNewBest && (
              <span className="text-[9.5px] font-bold text-yellow-400 bg-yellow-500/10 border border-yellow-500/25 px-2.5 py-0.5 rounded-full mb-1">NEW BEST</span>
            )}
            <div className="text-5xl sm:text-6xl font-black leading-none" style={{ color: endSummary.grade.grade === 'S+' || endSummary.grade.grade === 'S' ? '#fbbf24' : '#a78bfa' }}>
              {endSummary.grade.grade}
            </div>
            <div className="text-[10px] uppercase tracking-widest text-slate-500">{endSummary.grade.label}</div>
            <div className="text-3xl sm:text-4xl font-black text-white mt-1 tabular-nums">{endSummary.score.toLocaleString()}</div>
            <div className="text-[9px] uppercase tracking-widest text-slate-500">Points</div>
          </div>

          <div className="flex-1 flex flex-col justify-center gap-3 px-6 sm:px-8 py-4 min-w-0">
            <div className="grid grid-cols-4 gap-2">
              <ResultStat label="Accuracy" value={`${endSummary.accuracy}%`} color="text-blue-400" />
              <ResultStat label="Combo" value={`${endSummary.bestCombo}x`} color="text-orange-400" />
              <ResultStat label="Lives" value={`${endSummary.lives}/${MAX_LIVES}`} color="text-red-400" />
              <ResultStat label="XP" value={`+${endSummary.xpEarned}`} color="text-violet-400" />
            </div>
            <div className="flex gap-2">
              {isChallenge ? (
                <p className="flex-1 text-xs text-neutral-400 py-3 text-center">Waiting for your opponent to finish…</p>
              ) : (
                <button onClick={enterDrill} className="flex-1 py-3 rounded-[13px] bg-gradient-to-r from-violet-600 to-indigo-600 text-white font-bold text-xs uppercase tracking-wide cursor-pointer">
                  Play Again
                </button>
              )}
              <button onClick={shareResult} className="w-11 flex-shrink-0 rounded-[13px] bg-white/[0.04] border border-white/10 flex items-center justify-center text-slate-400 hover:text-white cursor-pointer">
                <Share2 className="w-4 h-4" />
              </button>
              <Link href="/drills/cognitive" className="w-11 flex-shrink-0 rounded-[13px] bg-white/[0.04] border border-white/10 flex items-center justify-center text-slate-400 hover:text-white">
                <ArrowLeft className="w-4 h-4" />
              </Link>
            </div>
          </div>
        </div>
      )}
    </div>
    </DrillWrapper>
  );
}

// ============================================================
// Subcomponents
// ============================================================
function MiniStat({ label, value, color }) {
  return (
    <div className="rounded-[9px] border border-white/5 bg-white/[0.02] py-1.5 px-1 text-center">
      <div className={`text-[12px] font-bold ${color}`}>{value}</div>
      <div className="text-[7.5px] uppercase tracking-wide text-slate-500 font-bold mt-0.5">{label}</div>
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
