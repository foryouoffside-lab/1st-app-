'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  Layers, Volume2, VolumeX, Heart,
  Eye, Ban, Zap as ZapIcon, RotateCcw, Share2, ArrowLeft,
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
import { hitTestCircle, canvasDpr } from '../../../../../lib/canvasFx';

// ============================================================
// TUNING
// ============================================================
const TOTAL_TIME = 45;
const MAX_LIVES = 5;
const OVERDRIVE_MS = 5000;
const MAX_LEVEL = 15;

const COLOR_CLASS = {
  red: 'bg-red-500', blue: 'bg-blue-500', green: 'bg-green-500', yellow: 'bg-yellow-400',
  purple: 'bg-purple-500', orange: 'bg-orange-500', pink: 'bg-pink-500', cyan: 'bg-cyan-400',
};
// Canvas can't read Tailwind classes, so the same palette needs a hex table
// too — kept in sync with COLOR_CLASS above.
const COLOR_HEX = {
  red: '#ef4444', blue: '#3b82f6', green: '#22c55e', yellow: '#facc15',
  purple: '#a855f7', orange: '#f97316', pink: '#ec4899', cyan: '#22d3ee',
};
const SHAPE_EMOJI = { circle: '⚪', square: '⬛', triangle: '🔺', star: '⭐', heart: '❤️', diamond: '💎' };
const COLORS = Object.keys(COLOR_CLASS);
const SHAPES = Object.keys(SHAPE_EMOJI);

// ============================================================
// ZERO-LATENCY AUDIO SYNTHESIZER (same bank as Divided Attention)
// ============================================================
class AudioSynthesizer {
  constructor() { this.ctx = null; this.enabled = true; }
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
  playHit() { this.tone(880, 0.12, 'sine', 0.16, 1760); }
  playCountdownTick() { this.tone(440, 0.09, 'sine', 0.12, 440); }
  // Same tone() shape as the tick, just a step higher with a quick upward
  // glide — matches BatchProcessingClient.js's GO exactly.
  playGo() { this.tone(523.25, 0.18, 'triangle', 0.17, 784); }

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
// LOCAL BEST-STATS STORAGE
// ============================================================
const STORAGE_KEY = 'skilldrills_selective_attention_v1';

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

function pickPositions(count) {
  const pts = [];
  for (let i = 0; i < count; i++) {
    let best = null, bestMinDist = -1;
    for (let attempt = 0; attempt < 8; attempt++) {
      const cand = { x: 12 + Math.random() * 76, y: 18 + Math.random() * 66 };
      const minDist = pts.length === 0 ? 999 : Math.min(...pts.map((p) => Math.hypot(p.x - cand.x, p.y - cand.y)));
      if (minDist > bestMinDist) { bestMinDist = minDist; best = cand; }
      if (minDist > 20) break;
    }
    pts.push(best);
  }
  return pts;
}

// ============================================================
// MAIN COMPONENT
// ============================================================
export default function SelectiveAttentionClient() {
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

  const [bestScore, setBestScore] = useState(0);
  const [bestCombo, setBestCombo] = useState(0);
  const [bestLevel, setBestLevel] = useState(1);

  const [score, setScore] = useState(0);
  const [lives, setLives] = useState(MAX_LIVES);
  const [combo, setCombo] = useState(0);
  const [level, setLevel] = useState(1);
  const [timeRemaining, setTimeRemaining] = useState(totalTime);
  const [dangerLevel, setDangerLevel] = useState(0);

  const [targetColor, setTargetColor] = useState(COLORS[0]);
  const [targetShape, setTargetShape] = useState(SHAPES[0]);

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

  const roundWindowRef = useRef(1800);
  const distractorCountRef = useRef(5);

  const targetColorRef = useRef(COLORS[0]);
  const targetShapeRef = useRef(SHAPES[0]);
  const roundStartAtRef = useRef(0);
  const shakeToggleRef = useRef(0);
  const heartbeatTempoRef = useRef(1100);

  const roundTimerRef = useRef(null);
  const gameTimerRef = useRef(null);
  const heartbeatTimerRef = useRef(null);
  const overdriveTimeoutRef = useRef(null);
  const countdownTimerRef = useRef(null);

  // Canvas rendering for the round's items — replaces individually-animated
  // DOM elements (5-8 simultaneous, mounted/unmounted every round) with one
  // shared <canvas> + one draw loop, matching QuickDodgeClient.js's pattern.
  // See ARENA_CANVAS_PERFORMANCE_PLAN.md.
  const gameFieldRef = useRef(null);
  const itemCanvasRef = useRef(null);
  const itemCanvasSizeRef = useRef({ width: 0, height: 0 });
  const itemDrawAnimRef = useRef(null);
  const itemLastDrawRef = useRef(0);
  const itemsRef = useRef([]);
  const scorePopupsRef = useRef([]);

  // ── Mount / cleanup ────────────────────────────────────────
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
  // exact spot the item was tapped (x/y in the same 0-100 percentage space as
  // spawnBurst), drawn on the item canvas instead of a static center banner.
  const spawnScorePopup = useCallback((x, y, text, color = '#4ade80') => {
    scorePopupsRef.current.push({ x, y, text, color, spawnedAt: performance.now() });
  }, []);

  // ── Difficulty scaling ────────────────────────────────────────────────────
  const updateDifficulty = useCallback(() => {
    // Duels ramp with TIME, not score — both players must face identical
    // difficulty at every moment for the score race (and the leaderboard
    // built on it) to be a pure skill comparison. Solo keeps the score ramp.
    const newLevel = isChallenge
      ? Math.min(MAX_LEVEL, 1 + Math.floor(((totalTime - timeRemainingRef.current) / totalTime) * MAX_LEVEL))
      : Math.min(MAX_LEVEL, Math.floor(scoreRef.current / 40) + 1);
    if (newLevel > levelRef.current) {
      levelRef.current = newLevel;
      bestLevelRunRef.current = Math.max(bestLevelRunRef.current, newLevel);
      setLevel(newLevel);
    }
    const progress = Math.min(1, (levelRef.current - 1) / (MAX_LEVEL - 1));
    roundWindowRef.current = Math.round(1800 - progress * 1100);
    distractorCountRef.current = Math.min(8, 5 + Math.floor(progress * 3));
  }, [isChallenge, totalTime]);

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
  const resolveCorrect = useCallback((spawnedAt, item) => {
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
    if (item) {
      spawnBurst(item.x, item.y, 'cyan');
      spawnScorePopup(item.x, item.y, `+${total}`);
    }

    // Every correct tap plays the same hit sound now — no separate combo
    // chime — the "COMBO" text is kept, the extra sound layer was noise.
    audioSynth?.playHit();

    setScore(scoreRef.current);
    setCombo(comboRef.current);
    updateDifficulty();
  }, [fillOverdrive, spawnBurst, spawnScorePopup, updateDifficulty, totalTime]);

  const endGameRef = useRef(null);

  const resolveWrong = useCallback((kind, item) => {
    if (!gameActiveRef.current) return;
    comboRef.current = 0;
    mistakesRef.current += 1;
    totalActionsRef.current += 1;
    // Duels have no lives at all — every match runs the full shared 30s.
    // (Solo floor at 0: a negative count fed the heartbeat's danger
    // formula unbounded — see scheduleHeartbeat.)
    if (!isChallenge) livesRef.current = Math.max(0, livesRef.current - 1);

    if (kind === 'wrong_item') {
      triggerShake('hard');
      triggerFlash('red-hard');
      audioSynth?.playPenalty();
      if (item) spawnBurst(item.x, item.y, 'red');
    } else {
      triggerShake('soft');
      triggerFlash('red');
      audioSynth?.playPenalty();
    }

    setScore(scoreRef.current);
    setCombo(0);
    setLives(Math.max(0, livesRef.current));

    // Solo: game over on empty lives. Duels always run the full clock.
    if (!isChallenge && livesRef.current <= 0) endGameRef.current?.('lives');
  }, [triggerShake, triggerFlash, spawnBurst, isChallenge]);

  // ── Game over ──────────────────────────────────────────────────────────────
  const endGame = useCallback(async (reason) => {
    if (!gameActiveRef.current) return;
    gameActiveRef.current = false;

    [roundTimerRef, heartbeatTimerRef, overdriveTimeoutRef].forEach((r) => { if (r.current) { clearTimeout(r.current); r.current = null; } });
    if (gameTimerRef.current) { clearInterval(gameTimerRef.current); gameTimerRef.current = null; }

    audioSynth?.playResultsReveal();
    // StatusBar deliberately not reverted here — the result screen still
    // renders inside the same fullscreen, landscape-locked container as
    // gameplay. Reverting now would force a resize/shake right as results
    // appear; it's restored in the mount-effect cleanup instead, alongside
    // exitFullscreen()/unlockOrientation(), which are already deferred to
    // actually leaving the drill.
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

    const prevSaved = getSavedData();
    const isNewBest = finalScore > prevSaved.bestScore;
    const firstPlay = prevSaved.totalSessions === 0;
    const daily = isChallenge
      ? { isDailyDrill: false, wouldCompleteSet: false }
      : await previewDailyCompletion('selective-attention');
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
      drillId: 'selective-attention',
      drillName: 'Selective Attention',
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

  // ── Round spawning ────────────────────────────────────────────────────────
  const spawnRound = useCallback(() => {
    if (roundTimerRef.current) clearTimeout(roundTimerRef.current);
    if (!gameActiveRef.current) return;

    const nc = COLORS[Math.floor(Math.random() * COLORS.length)];
    const ns = SHAPES[Math.floor(Math.random() * SHAPES.length)];
    targetColorRef.current = nc; targetShapeRef.current = ns;
    setTargetColor(nc); setTargetShape(ns);

    const count = distractorCountRef.current;
    const positions = pickPositions(count + 1);
    const list = [{ id: Date.now() + Math.random(), color: nc, shape: ns, isTarget: true, x: positions[0].x, y: positions[0].y, spawnedAt: performance.now() }];
    for (let i = 0; i < count; i++) {
      let dc, ds;
      if (Math.random() > 0.5) {
        const rest = COLORS.filter((c) => c !== nc);
        dc = rest[Math.floor(Math.random() * rest.length)];
        ds = ns;
      } else {
        dc = nc;
        const rest = SHAPES.filter((s) => s !== ns);
        ds = rest[Math.floor(Math.random() * rest.length)];
      }
      list.push({ id: Date.now() + Math.random() + i + 1, color: dc, shape: ds, isTarget: false, x: positions[i + 1].x, y: positions[i + 1].y, spawnedAt: performance.now() });
    }
    itemsRef.current = list;
    roundStartAtRef.current = Date.now();

    roundTimerRef.current = setTimeout(() => {
      if (!gameActiveRef.current || !mountedRef.current) return;
      itemsRef.current = [];
      resolveWrong('timeout', null);
      setTimeout(() => { if (gameActiveRef.current) spawnRound(); }, 120);
    }, roundWindowRef.current);
  }, [resolveWrong]);

  const handleItemTap = useCallback((item, e) => {
    if (e) { e.stopPropagation(); e.preventDefault(); }
    if (!gameActiveRef.current) return;
    if (roundTimerRef.current) clearTimeout(roundTimerRef.current);
    itemsRef.current = [];
    if (item.isTarget) resolveCorrect(roundStartAtRef.current, item);
    else resolveWrong('wrong_item', item);
    setTimeout(() => { if (gameActiveRef.current) spawnRound(); }, 120);
  }, [resolveCorrect, resolveWrong, spawnRound]);

  // ── Heartbeat / danger tempo ──────────────────────────────────────────────
  const scheduleHeartbeat = useCallback(() => {
    // Duels have NO heartbeat audio and NO danger vignette at all — the
    // match must feel and perform exactly like solo play minus the extras.
    // (Solo keeps the clamps: an unclamped danger > ~1.7 made the tempo
    // negative and turned this self-rescheduling callback into a tight
    // infinite loop — 100% CPU + a wall of heartbeat audio on phones.)
    if (isChallenge) return;
    if (!gameActiveRef.current) return;
    const dangerFromLives = livesRef.current <= 2
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

  // ── Start / lifecycle ──────────────────────────────────────────────────────
  const beginPlaying = useCallback(() => {
    setPhase('playing');
    gameActiveRef.current = true;
    // 200ms rather than 100ms — the displayed clock only shows whole seconds,
    // so 5 ticks/sec looks identical to 10 while halving how often this
    // re-renders the whole play field for the entire match.
    gameTimerRef.current = setInterval(() => {
      if (!gameActiveRef.current) { clearInterval(gameTimerRef.current); return; }
      timeRemainingRef.current -= 0.2;
      if (timeRemainingRef.current <= 0) {
        timeRemainingRef.current = 0;
        setTimeRemaining(0);
        endGameRef.current?.('time');
      } else {
        setTimeRemaining(timeRemainingRef.current);
        // Duel difficulty is time-driven, so it must advance from the clock
        // itself — not only on correct actions like the solo score ramp.
        if (isChallenge) updateDifficulty();
      }
    }, 200);
    scheduleHeartbeat();
    spawnRound();
  }, [scheduleHeartbeat, spawnRound, isChallenge, updateDifficulty]);

  const runCountdown = useCallback((n) => {
    if (countdownTimerRef.current) clearTimeout(countdownTimerRef.current);
    if (n <= 0) {
      setCountdownValue('GO');
      audioSynth?.playGo();
      countdownTimerRef.current = setTimeout(() => beginPlaying(), 350);
      return;
    }
    setCountdownValue(n);
    audioSynth?.playCountdownTick();
    countdownTimerRef.current = setTimeout(() => runCountdown(n - 1), 700);
  }, [beginPlaying]);

  const enterDrill = useCallback(async () => {
    try { audioSynth?.init(); } catch (e) {}

    gameActiveRef.current = false;
    [roundTimerRef, heartbeatTimerRef, overdriveTimeoutRef, countdownTimerRef].forEach((r) => { if (r.current) { clearTimeout(r.current); r.current = null; } });
    if (gameTimerRef.current) { clearInterval(gameTimerRef.current); gameTimerRef.current = null; }

    // Returning players start closer to their proven skill level instead of
    // always grinding through level 1 again — ~75% of their best level reached.
    // First-time players (no saved bestLevel) still start at level 1.
    const savedForStart = getSavedData();
    const startLevel = Math.max(1, Math.min(MAX_LEVEL, Math.round((savedForStart.bestLevel || 1) * 0.75)));

    scoreRef.current = 0; livesRef.current = MAX_LIVES; comboRef.current = 0; bestComboRef.current = 0;
    levelRef.current = startLevel; bestLevelRunRef.current = startLevel; mistakesRef.current = 0; correctActionsRef.current = 0; totalActionsRef.current = 0;
    overdriveMeterRef.current = 0; overdriveActiveRef.current = false; overdriveCountRef.current = 0;
    timeRemainingRef.current = totalTime;

    // Apply this level's round window / distractor count immediately (same
    // formula as updateDifficulty) so the very first round reflects the
    // seeded level instead of starting at level-1 pacing for one round.
    const startProgress = Math.min(1, (startLevel - 1) / (MAX_LEVEL - 1));
    roundWindowRef.current = Math.round(1800 - startProgress * 1100);
    distractorCountRef.current = Math.min(8, 5 + Math.floor(startProgress * 3));

    const nc = COLORS[Math.floor(Math.random() * COLORS.length)];
    const ns = SHAPES[Math.floor(Math.random() * SHAPES.length)];
    targetColorRef.current = nc; targetShapeRef.current = ns;

    setScore(0); setLives(MAX_LIVES); setCombo(0); setLevel(startLevel); setTimeRemaining(totalTime);
    setDangerLevel(0);
    setTargetColor(nc); setTargetShape(ns); itemsRef.current = []; scorePopupsRef.current = [];
    setEndSummary(null); setFlashes([]); setBursts([]);
    setCountdownValue(3);

    // Skip real Fullscreen API during a live 1v1 duel — DrillWrapper's header/opponent-score bar
    // live outside this element, and the Fullscreen API would hide them for the whole match.
    try { if (!isChallenge && !document.fullscreenElement && containerRef.current) await containerRef.current.requestFullscreen(); } catch (e) {}
    if (Capacitor.isNativePlatform()) {
      // overlaysWebView:true keeps the window's layout size stable regardless
      // of status-bar visibility, so a swipe-reveal from the top edge draws
      // the bar as an overlay instead of resizing the WebView and shoving
      // this fullscreen board down the screen.
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
    window.addEventListener('resize', onOrientationChange);
    window.addEventListener('orientationchange', onOrientationChange);
    return () => {
      window.removeEventListener('resize', onOrientationChange);
      window.removeEventListener('orientationchange', onOrientationChange);
    };
  }, [phase, runCountdown]);

  // ── Item canvas: sizing + draw loop ────────────────────────────────────────
  // Items don't move during their lifetime (they just appear for one round
  // and disappear), so this mainly replaces per-item DOM mount/unmount with
  // canvas draws — still capped to ~30fps and keyed off itemsRef directly
  // rather than React state, same pattern as the other duel drills.
  useEffect(() => {
    if (phase !== 'playing' && phase !== 'countdown') {
      if (itemDrawAnimRef.current) { cancelAnimationFrame(itemDrawAnimRef.current); itemDrawAnimRef.current = null; }
      return;
    }

    const resizeItemCanvas = () => {
      const cvs = itemCanvasRef.current;
      const el = gameFieldRef.current;
      if (!cvs || !el) return;
      const rect = el.getBoundingClientRect();
      const dpr = canvasDpr();
      cvs.width = rect.width * dpr;
      cvs.height = rect.height * dpr;
      itemCanvasSizeRef.current = { width: rect.width, height: rect.height };
    };

    resizeItemCanvas();
    const ro = new ResizeObserver(resizeItemCanvas);
    if (gameFieldRef.current) ro.observe(gameFieldRef.current);
    window.addEventListener('resize', resizeItemCanvas);
    window.addEventListener('orientationchange', resizeItemCanvas);

    const baseItemRadius = () => (window.innerWidth >= 640 ? 22 : 18); // ~10% smaller for extra room to move

    const draw = (timestamp) => {
      const cvs = itemCanvasRef.current;
      const ctx = cvs?.getContext('2d');
      if (!ctx) { itemDrawAnimRef.current = requestAnimationFrame(draw); return; }

      if (timestamp - itemLastDrawRef.current < 33) {
        itemDrawAnimRef.current = requestAnimationFrame(draw);
        return;
      }
      itemLastDrawRef.current = timestamp;

      const w = itemCanvasSizeRef.current.width;
      const h = itemCanvasSizeRef.current.height;
      const dpr = canvasDpr();

      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, w, h);

      if (phase === 'playing') {
        const baseR = baseItemRadius();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        let lastFontStr = '';
        itemsRef.current.forEach((item) => {
          const cx = (item.x / 100) * w;
          const cy = (item.y / 100) * h;

          // Entrance pop — canvas equivalent of the CSS fx-pop-in scale-in.
          const popT = Math.min(1, (performance.now() - item.spawnedAt) / 180);
          const scale = popT < 1 ? 0.5 + 0.5 * popT + Math.sin(popT * Math.PI) * 0.08 : 1;
          const r = baseR * scale;

          // No shadowBlur here — a real, nonzero shadowBlur is a CPU-bound
          // blur convolution per item per frame on mobile WebViews, paid for
          // a dark drop shadow that's near-invisible on this dark background.
          ctx.beginPath();
          ctx.arc(cx, cy, r, 0, Math.PI * 2);
          ctx.fillStyle = COLOR_HEX[item.color];
          ctx.fill();
          ctx.strokeStyle = 'rgba(255,255,255,0.25)';
          ctx.lineWidth = 2;
          ctx.stroke();

          const fontStr = `${Math.round(r * 0.9)}px sans-serif`;
          if (fontStr !== lastFontStr) { ctx.font = fontStr; lastFontStr = fontStr; }
          ctx.fillText(SHAPE_EMOJI[item.shape], cx, cy);
        });

        // Score release: the "+N" earned on a correct tap rises and fades
        // from the exact spot it was scored — same in-canvas model as
        // BatchProcessingClient.js / DividedAttentionClient.js. Uses the rAF
        // timestamp (performance.now()-based, same epoch as spawnedAt above).
        const pops = scorePopupsRef.current;
        for (let i = pops.length - 1; i >= 0; i--) {
          const p = pops[i];
          const elapsed = (timestamp - p.spawnedAt) / 1000;
          if (elapsed >= 1) { pops.splice(i, 1); continue; }
          const px = (p.x / 100) * w;
          const py = (p.y / 100) * h - elapsed * 38;
          ctx.save();
          ctx.globalAlpha = 1 - elapsed;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.font = 'bold 15px monospace';
          ctx.fillStyle = p.color;
          ctx.fillText(p.text, px, py);
          ctx.restore();
        }
      }

      ctx.restore();
      itemDrawAnimRef.current = requestAnimationFrame(draw);
    };

    itemLastDrawRef.current = 0;
    itemDrawAnimRef.current = requestAnimationFrame(draw);

    return () => {
      if (itemDrawAnimRef.current) cancelAnimationFrame(itemDrawAnimRef.current);
      ro.disconnect();
      window.removeEventListener('resize', resizeItemCanvas);
      window.removeEventListener('orientationchange', resizeItemCanvas);
    };
  }, [phase]);

  // Single tap handler for the whole game field, replacing the old per-item
  // <button onPointerDown>. Hit-tests the tap (in the field's own pixel
  // space) against whichever items are currently live, reusing
  // handleItemTap exactly as before — only how it gets invoked has changed.
  const handleFieldPointerDown = useCallback((e) => {
    if (!gameActiveRef.current || phase !== 'playing') return;
    const rect = gameFieldRef.current?.getBoundingClientRect();
    if (!rect) return;
    const tapX = e.clientX - rect.left;
    const tapY = e.clientY - rect.top;
    const r = window.innerWidth >= 640 ? 24 : 20;

    const items = itemsRef.current;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      const ix = (item.x / 100) * rect.width;
      const iy = (item.y / 100) * rect.height;
      if (hitTestCircle(tapX, tapY, ix, iy, r)) {
        handleItemTap(item, e);
        return;
      }
    }
  }, [phase, handleItemTap]);

  const shareResult = useCallback(async () => {
    if (!endSummary) return;
    const url = 'https://skilldrills.online/drills/cognitive/attention/selective-attention';
    try {
      const grade = getGrade(endSummary.accuracy);
      const canvas = generateShareCard({
        score: endSummary.score,
        bestScore,
        accuracy: endSummary.accuracy,
        bestCombo: endSummary.bestCombo,
        rating: { letter: grade.grade, label: grade.label, emoji: grade.emoji },
        newBest: endSummary.isNewBest,
        drillName: 'Selective Attention',
        playerName: getPlayerName(),
      });
      await shareScoreCard(url, canvas);
    } catch (e) {
      const text = `Scored ${endSummary.score} on Selective Attention (${endSummary.accuracy}% accuracy, ${endSummary.bestCombo}x combo) — SkillDrills`;
      if (typeof navigator !== 'undefined' && navigator.share) {
        navigator.share({ title: 'Selective Attention — SkillDrills', text, url }).catch(() => {});
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
          <p className="text-slate-500 font-bold tracking-widest uppercase text-[10px] animate-pulse">Loading Filter Engine...</p>
        </div>
      </div>
    );
  }

  const timePct = Math.max(0, Math.min(100, (timeRemaining / totalTime) * 100));

  return (
    <DrillWrapper
      drillName="Selective Attention"
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
      <div className="absolute inset-0 pointer-events-none" style={{ backgroundImage: 'linear-gradient(rgba(255,255,255,0.015) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.015) 1px, transparent 1px)', backgroundSize: '40px 40px' }} />

      {phase === 'playing' && dangerLevel > 0.06 && (
        <div className="fx-vignette" style={{ '--v-min': Math.max(0.05, dangerLevel * 0.25), '--v-max': Math.min(0.55, dangerLevel * 0.75), animationDuration: `${heartbeatTempoRef.current}ms` }} />
      )}

      {flashes.map((f) => (
        <div key={f.id} className={`fx-flash ${f.variant === 'gold' ? 'fx-flash-gold' : f.variant === 'cyan' ? 'fx-flash-cyan' : 'fx-flash-red'}`} />
      ))}

      {phase === 'rotate-hint' && (
        <div className="absolute inset-0 z-[100] flex flex-col items-center justify-center bg-black/95 text-center p-6">
          <div className="animate-bounce mb-5 text-violet-400"><RotateCcw className="w-12 h-12 mx-auto" /></div>
          <p className="text-sm font-bold text-white">Rotate your phone to play</p>
          <p className="text-xs text-slate-500 mt-1.5 max-w-[220px] mx-auto">Your browser can't rotate this for you — turn your device to landscape.</p>
        </div>
      )}

      {(phase === 'start' || phase === 'countdown' || phase === 'playing') && (
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); setSoundEnabled((v) => { audioSynth?.setEnabled(!v); return !v; }); }}
          className="absolute bottom-5 right-5 z-40 p-2 rounded-full bg-black/60 border border-white/10 text-slate-400 active:scale-90 transition-transform"
        >
          {soundEnabled ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
        </button>
      )}

      {/* ── START SCREEN ── */}
      {phase === 'start' && !isChallenge && (
        <div className="relative h-full flex items-center justify-center p-5 overflow-y-auto">
          <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(ellipse 420px 260px at 50% 8%, rgba(142,97,246,.16), transparent 70%)' }} />
          <div className="relative w-full max-w-[280px] rounded-[20px] border border-white/5 bg-[#0c0c16]/90 backdrop-blur-lg px-5 pt-5 pb-[18px] text-center shadow-[0_16px_40px_rgba(0,0,0,.5)] my-6">
            <div className="w-11 h-11 mx-auto rounded-[14px] bg-gradient-to-br from-violet-600 to-indigo-600 flex items-center justify-center mb-3 shadow-[0_0_22px_rgba(139,92,246,.35)]">
              <Layers className="w-[22px] h-[22px] text-white" />
            </div>
            <h1 className="text-[17px] font-bold tracking-tight">Selective Attention</h1>

            <div className="flex flex-col gap-1.5 text-left mt-3.5">
              <HowToRow icon={<Eye className="w-3.5 h-3.5 text-cyan-400 flex-shrink-0" />} node={<>Tap the item matching <b className="text-white">both</b> the color and shape shown</>} />
              <HowToRow icon={<Ban className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />} node={<>Distractors match <b className="text-white">only one</b> — don't tap those</>} />
              <HowToRow icon={<ZapIcon className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" />} node={<>Faster taps score more — the window <b className="text-white">shrinks</b> each level</>} />
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

      {/* ── PLAYING (and COUNTDOWN, which reuses this same idle field) ── */}
      {(phase === 'playing' || phase === 'countdown') && (
        <>
          {/* Own HUD — shown in BOTH modes: a duel plays exactly like solo
              (DrillWrapper renders no duel chrome mid-match anymore).
              Hearts are solo-only — duels have no lives. */}
          <div className="absolute top-0 left-0 right-0 h-1.5 bg-neutral-950 z-[60] pointer-events-none">
            <div className={`h-full transition-all duration-100 ease-linear ${timeRemaining <= 10 ? 'bg-red-500 animate-pulse' : 'bg-violet-500'}`} style={{ width: `${timePct}%` }} />
          </div>

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

          {/* Timer — top-right corner */}
          <div className="absolute top-5 right-5 z-40 flex flex-col items-end pointer-events-none select-none">
            <span className={`text-3xl font-black font-mono leading-none ${timeRemaining <= 10 ? 'text-red-500 animate-pulse' : 'text-slate-300'}`}>
              {Math.ceil(timeRemaining)}s
            </span>
            <span className="text-[8px] text-slate-500 font-bold uppercase tracking-widest mt-1">Time Left</span>
          </div>

          {/* target swatch — top-center, clear of the stat cluster and the reserved top-right corner */}
          <div className="absolute top-5 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 bg-black/50 border border-white/10 rounded-full pl-2 pr-3.5 py-1.5 pointer-events-none">
            <span className={`w-5 h-5 rounded-full border border-white/30 ${COLOR_CLASS[targetColor]}`} />
            <span className="text-lg leading-none">{SHAPE_EMOJI[targetShape]}</span>
          </div>

          {/* game field — items draw on one shared canvas (see the resize/
              draw effect above) instead of as individually-animated DOM
              elements; onPointerDown hit-tests taps against whichever items
              are currently live. */}
          <div ref={gameFieldRef} onPointerDown={handleFieldPointerDown} className="relative w-full h-full touch-none">
            {bursts.map((b) => (
              <div key={b.id} className="fx-pop" style={{ left: `${b.x}%`, top: `${b.y}%`, width: 40, height: 40, marginLeft: -20, marginTop: -20, background: b.color === 'red' ? 'rgba(239,68,68,.5)' : 'rgba(34,211,238,.5)' }} />
            ))}
            <canvas ref={itemCanvasRef} className="absolute inset-0 z-20 w-full h-full block pointer-events-none" />
          </div>
        </>
      )}

      {phase === 'countdown' && !isChallenge && (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/55 backdrop-blur-[2px]">
          <span className="text-[11px] font-black uppercase tracking-[0.2em] text-slate-400">Get Ready</span>
          <div className="relative w-28 h-28 rounded-full border-[3px] border-violet-500/20 flex items-center justify-center">
            <div className="absolute -inset-[3px] rounded-full border-[3px] border-transparent border-t-violet-400 border-r-violet-400 animate-spin" style={{ animationDuration: '0.7s' }} />
            <span key={countdownValue} className="fx-pop-in text-5xl font-black bg-gradient-to-b from-white to-violet-300 bg-clip-text text-transparent">
              {countdownValue > 0 ? countdownValue : 'GO'}
            </span>
          </div>
          <span className="text-[10px] text-slate-500">Items spawn at GO</span>
        </div>
      )}

      {/* ── RESULT SCREEN ── */}
      {phase === 'ended' && endSummary && !isChallenge && (
        <ResultScreen summary={endSummary} maxLives={MAX_LIVES} isChallenge={isChallenge} onPlayAgain={enterDrill} onShare={shareResult} />
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

function ResultScreen({ summary, maxLives, isChallenge, onPlayAgain, onShare }) {
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
          <ResultStat label="Lives" value={`${summary.lives}/${maxLives}`} color="text-red-400" />
          <ResultStat label="XP" value={`+${summary.xpEarned}`} color="text-violet-400" />
        </div>
        <div className="flex gap-2">
          {isChallenge ? (
            <p className="text-xs text-neutral-400 py-3 text-center flex-1">Waiting for your opponent to finish…</p>
          ) : (
            <button onClick={onPlayAgain} className="flex-1 py-3 rounded-[13px] bg-gradient-to-r from-violet-600 to-indigo-600 text-white font-bold text-xs uppercase tracking-wide cursor-pointer">
              Play Again
            </button>
          )}
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