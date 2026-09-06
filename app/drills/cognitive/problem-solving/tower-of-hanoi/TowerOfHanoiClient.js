'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  Compass, Volume2, VolumeX, Move,
  Eye, Ban, Zap as ZapIcon, RotateCcw, Share2, ArrowLeft
} from 'lucide-react';
import { calcEndBonuses, calcSessionXP, getGrade, getComboMultiplier } from '../../../../../lib/scoringEngine';
import { saveLeaderboardEntrySync } from '../../../../../lib/leaderboard';
import { afterViewportSettled, lockLandscape, unlockOrientation, onOrientationSettled } from '../../../../../lib/orientation';
import { previewDailyCompletion } from '../../../../../lib/dailyChallenge';
import { getPlayerName } from '../../../../../lib/progressStore';
import { Capacitor } from '@capacitor/core';
import { StatusBar } from '@capacitor/status-bar';
import { useShareCard } from '../../../../../components/ShareScoreCard';
import DrillWrapper from '../../../../../components/DrillWrapper';
import { useDuelMatchStart, duelSecondsRemaining } from '../../../../../lib/challengeEngine';
import { APP_SHARE_URL } from '../../../../../lib/shareLinks';

// ============================================================
// TUNING
// ============================================================
const TOTAL_TIME = 45;
const OVERDRIVE_MS = 8000;
const MAX_LEVEL = 6;
const MIN_LEVEL = 1;
const COUNTDOWN_TICK_MS = 700;

// Disk skins, ordered so a full stack reads as one continuous spectrum from the
// smallest disk upward instead of an arbitrary rainbow.
//
// Flat `fill` + a lighter `rim` of the same hue + a coloured glow — the same
// idiom every other solid game piece in the catalog uses (see Memory Sequence's
// lit cell: bg-indigo-500 / border-indigo-400 / shadow 0 0 12px). Deliberately
// NO gradient, specular highlight or inset shading: glossy 3D pieces look
// nothing like the rest of the app.
const DISK_SKINS = [
  { fill: '#8b5cf6', rim: '#a78bfa', glow: '139,92,246' }, // violet
  { fill: '#6366f1', rim: '#818cf8', glow: '99,102,241' }, // indigo
  { fill: '#3b82f6', rim: '#60a5fa', glow: '59,130,246' }, // blue
  { fill: '#06b6d4', rim: '#22d3ee', glow: '6,182,212' },  // cyan
  { fill: '#10b981', rim: '#34d399', glow: '16,185,129' }, // emerald
  { fill: '#eab308', rim: '#facc15', glow: '234,179,8' },  // amber
  { fill: '#f97316', rim: '#fb923c', glow: '249,115,22' }, // orange
  { fill: '#f43f5e', rim: '#fb7185', glow: '244,63,94' },  // rose
];

const disksForLevel = (lvl) => lvl + 2;
const calcParMoves = (disks) => Math.pow(2, disks) - 1;

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
    } catch {}
  }

  // 1. Hit / Move sound
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

  // 4. Penalty / Invalid move sound
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

  setEnabled(status) { this.enabled = status; }
}

const audioSynth = typeof window !== 'undefined' ? new AudioSynthesizer() : null;

// ============================================================
// LOCAL STORAGE
// ============================================================
const STORAGE_KEY = 'skilldrills_hanoi_v3';

const getSavedData = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { bestScore: 0, bestCombo: 0, bestLevel: 1, totalSessions: 0, totalOverdrives: 0, totalPerfectSolves: 0 };
    return { bestScore: 0, bestCombo: 0, bestLevel: 1, totalSessions: 0, totalOverdrives: 0, totalPerfectSolves: 0, ...JSON.parse(raw) };
  } catch {
    return { bestScore: 0, bestCombo: 0, bestLevel: 1, totalSessions: 0, totalOverdrives: 0, totalPerfectSolves: 0 };
  }
};
const saveData = (data) => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch {} };

// ============================================================
// MAIN COMPONENT
// ============================================================
export default function TowerOfHanoiClient() {
  const searchParams = useSearchParams();
  const challengeId = searchParams ? searchParams.get('challengeId') : null;
  const isChallenge = !!challengeId;
  const totalTime = isChallenge ? 30 : TOTAL_TIME;

  const [isClient, setIsClient] = useState(false);
  const [loading, setLoading] = useState(true);
  const [soundEnabled, setSoundEnabled] = useState(true);

  const [phase, setPhase] = useState('start');
  // True from the instant START is tapped until the drill actually leaves the
  // start phase. Tapping START kicks off a fullscreen request, a status-bar
  // change, an await on the native landscape lock and then a settle timeout —
  // several hundred ms during which `phase` is still 'start', so the start
  // card stayed mounted and the user watched it get rotated into landscape
  // before the countdown replaced it. This unmounts it on the tap itself.
  const [launching, setLaunching] = useState(false);
  const [countdownValue, setCountdownValue] = useState(3);

  const [bestScore, setBestScore] = useState(0);
  const [bestCombo, setBestCombo] = useState(0);
  const [bestLevel, setBestLevel] = useState(1);

  const [score, setScore] = useState(0);
  const [level, setLevel] = useState(1);
  const [timeRemaining, setTimeRemaining] = useState(totalTime);
  const [dangerLevel, setDangerLevel] = useState(0);

  const [towers, setTowers] = useState([[3, 2, 1], [], []]);
  const [selectedTower, setSelectedTower] = useState(null);
  const [moves, setMoves] = useState(0);
  const [parMoves, setParMoves] = useState(7);

  const [flashes, setFlashes] = useState([]);
  const [bursts, setBursts] = useState([]);
  const [endSummary, setEndSummary] = useState(null);

  const mountedRef = useRef(false);
  const containerRef = useRef(null);
  const gameActiveRef = useRef(false);

  const scoreRef = useRef(0);
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

  const movesRef = useRef(0);
  const parMovesRef = useRef(7);
  const sessionMovesRef = useRef(0);
  const parMovesSumRef = useRef(0);
  const movesSumRef = useRef(0);
  const perfectSolvesRef = useRef(0);

  const clickCooldownRef = useRef(false);
  const heartbeatTempoRef = useRef(1100);

  const gameTimerRef = useRef(null);
  const heartbeatTimerRef = useRef(null);
  const overdriveTimeoutRef = useRef(null);
  const countdownTimerRef = useRef(null);
  const advanceTimerRef = useRef(null);

  useEffect(() => {
    setIsClient(true);
    mountedRef.current = true;
    try {
      const saved = getSavedData();
      setBestScore(saved.bestScore);
      setBestCombo(saved.bestCombo);
      setBestLevel(saved.bestLevel);
    } catch {}
    setTimeout(() => { if (mountedRef.current) setLoading(false); }, 200);

    return () => {
      mountedRef.current = false;
      gameActiveRef.current = false;
      [overdriveTimeoutRef, countdownTimerRef, advanceTimerRef, heartbeatTimerRef].forEach((r) => { if (r.current) clearTimeout(r.current); });
      if (gameTimerRef.current) clearInterval(gameTimerRef.current);
      try { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); } catch {}
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


  const spawnBurst = useCallback((x, y, color) => {
    const id = Date.now() + Math.random();
    setBursts((b) => [...b, { id, x, y, color }]);
    setTimeout(() => { if (mountedRef.current) setBursts((b) => b.filter((p) => p.id !== id)); }, 520);
  }, []);

  const activateOverdrive = useCallback(() => {
    overdriveActiveRef.current = true;
    overdriveMeterRef.current = 0;
    overdriveCountRef.current += 1;
    triggerFlash('gold');
    if (overdriveTimeoutRef.current) clearTimeout(overdriveTimeoutRef.current);
    overdriveTimeoutRef.current = setTimeout(() => { overdriveActiveRef.current = false; }, OVERDRIVE_MS);
  }, [triggerFlash]);

  const fillOverdrive = useCallback((amt) => {
    if (overdriveActiveRef.current) return;
    overdriveMeterRef.current = Math.min(100, overdriveMeterRef.current + amt);
    if (overdriveMeterRef.current >= 100) activateOverdrive();
  }, [activateOverdrive]);

  const initializeLevel = useCallback((lvl) => {
    const disks = disksForLevel(lvl);
    const nt = [[], [], []];
    for (let i = disks; i > 0; i--) nt[0].push(i);
    setTowers(nt);
    setSelectedTower(null);
    movesRef.current = 0;
    setMoves(0);
    parMovesRef.current = calcParMoves(disks);
    setParMoves(parMovesRef.current);
  }, []);

  const advanceLevel = useCallback(() => {
    if (levelRef.current < MAX_LEVEL) {
      levelRef.current += 1;
      bestLevelRunRef.current = Math.max(bestLevelRunRef.current, levelRef.current);
      setLevel(levelRef.current);
    }
    initializeLevel(levelRef.current);
  }, [initializeLevel]);

  const endGameRef = useRef(null);

  const endGame = useCallback(async (reason) => {
    if (!gameActiveRef.current) return;
    gameActiveRef.current = false;

    [overdriveTimeoutRef, advanceTimerRef, heartbeatTimerRef].forEach((r) => { if (r.current) { clearTimeout(r.current); r.current = null; } });
    if (gameTimerRef.current) { clearInterval(gameTimerRef.current); gameTimerRef.current = null; }

    audioSynth?.playResultsReveal();
    triggerFlash('red');

    const correct = correctActionsRef.current;
    const total = totalActionsRef.current;
    const accuracy = total > 0 ? Math.round((correct / total) * 100) : 0;

    const bonuses = calcEndBonuses({
      rawScore: scoreRef.current,
      accuracy,
      bestCombo: bestComboRef.current,
      totalActions: total,
      mistakes: mistakesRef.current,
      livesRemaining: null,
      maxLives: null,
      category: 'cognitive',
    });
    const finalScore = bonuses.finalScore;

    const prevSaved = getSavedData();
    const isNewBest = finalScore > prevSaved.bestScore;
    const firstPlay = prevSaved.totalSessions === 0;
    const daily = isChallenge
      ? { isDailyDrill: false, wouldCompleteSet: false }
      : await previewDailyCompletion('tower-of-hanoi');
    const xpResult = calcSessionXP({ finalScore, accuracy, isNewBest, firstPlay, dailyChallenge: daily.isDailyDrill, dailyChallengeSetComplete: daily.wouldCompleteSet });

    const updated = {
      bestScore: Math.max(prevSaved.bestScore, finalScore),
      bestCombo: Math.max(prevSaved.bestCombo, bestComboRef.current),
      bestLevel: Math.max(prevSaved.bestLevel, bestLevelRunRef.current),
      totalSessions: prevSaved.totalSessions + 1,
      totalOverdrives: (prevSaved.totalOverdrives || 0) + overdriveCountRef.current,
      totalPerfectSolves: (prevSaved.totalPerfectSolves || 0) + perfectSolvesRef.current,
    };
    saveData(updated);
    setBestScore(updated.bestScore);
    setBestCombo(updated.bestCombo);
    setBestLevel(updated.bestLevel);

    saveLeaderboardEntrySync({
      drillId: 'tower-of-hanoi',
      drillName: 'Tower of Hanoi',
      category: 'cognitive',
      score: finalScore,
      accuracy,
      bestCombo: bestComboRef.current,
    });

    setEndSummary({
      score: finalScore,
      accuracy,
      bestCombo: bestComboRef.current,
      isNewBest,
      xpEarned: xpResult.xp,
      prevBest: prevSaved.bestScore,
    });
    setPhase('ended');
  }, [triggerFlash]);

  useEffect(() => { endGameRef.current = endGame; }, [endGame]);

  // Completion-only score calculation
  const resolveLevelComplete = useCallback(() => {
    const lvl = levelRef.current;
    const currentMoves = movesRef.current;
    const par = parMovesRef.current;
    const perfect = currentMoves === par;

    // Base score per tower completion scaled by level/disks
    const basePoints = 120 * lvl;
    // Move efficiency penalty (ratio of par moves to actual moves, max 1.0)
    const efficiencyRatio = Math.min(1.0, par / Math.max(1, currentMoves));
    const efficiencyPoints = Math.round(basePoints * efficiencyRatio);

    // Perfect solve bonus
    const perfectBonus = perfect ? 150 : 0;
    // Time remaining bonus
    const timeBonus = Math.round(timeRemainingRef.current * 4);

    // Combo (consecutive clears with no invalid move in between) was being
    // tracked and displayed but never actually paid out — wire it into the
    // shared multiplier curve like every other drill does. No separate
    // level multiplier here: basePoints already scales 120x per level
    // directly, far beyond the engine's usual +50% max, so stacking the
    // engine's levelMultiplier on top would double-reward level.
    const comboMultiplier = getComboMultiplier(comboRef.current);
    let totalTowerScore = Math.round((efficiencyPoints + perfectBonus + timeBonus) * comboMultiplier);
    if (overdriveActiveRef.current) totalTowerScore = Math.round(totalTowerScore * 1.75);

    scoreRef.current += totalTowerScore;
    comboRef.current += 1;
    bestComboRef.current = Math.max(bestComboRef.current, comboRef.current);

    parMovesSumRef.current += par;
    movesSumRef.current += currentMoves;
    if (perfect) perfectSolvesRef.current += 1;

    setScore(scoreRef.current);

    audioSynth?.playHit();
    triggerFlash(perfect ? 'gold' : 'cyan');

    // Solo only: solving a tower refills the clock, so a good run keeps
    // going. A duel must NOT do this — both duelists share one fixed 30s
    // (ARENA_INTEGRATION.md rule 1), and refilling desynced the two clocks
    // completely: whoever kept solving extended their own match indefinitely
    // while the opponent's 30s expired and left them stuck on "Waiting for
    // opponent to finish..." for the rest of it.
    if (!isChallenge) {
      timeRemainingRef.current = totalTime;
      setTimeRemaining(totalTime);
    }

    // Was 1100ms — a leftover from when this pause existed to let a gold/cyan
    // "level clear" flash play before the board reset. That flash was later
    // made invisible catalog-wide (see the fx-flash-gold/fx-flash-cyan note
    // in globals.css) to stop rapid-scoring drills from strobing, but this
    // drill's pause was never shortened to match — so it sat there doing
    // nothing for over a second. Trimmed to a brief beat that still lets the
    // hit sound/score-tick register without feeling delayed.
    if (advanceTimerRef.current) clearTimeout(advanceTimerRef.current);
    advanceTimerRef.current = setTimeout(() => { if (gameActiveRef.current) advanceLevel(); }, 350);
  }, [advanceLevel, triggerFlash, totalTime, isChallenge]);

  // Valid move: NO score awarded for individual moves to prevent back-and-forth farming
  const resolveValidMove = useCallback((clearedTowers) => {
    sessionMovesRef.current += 1;
    correctActionsRef.current += 1;
    totalActionsRef.current += 1;

    fillOverdrive(8);

    audioSynth?.playHit();

    if (clearedTowers[2].length === disksForLevel(levelRef.current)) {
      resolveLevelComplete();
    }
  }, [fillOverdrive, resolveLevelComplete]);

  const resolveInvalidMove = useCallback(() => {
    comboRef.current = 0;
    mistakesRef.current += 1;
    totalActionsRef.current += 1;

    // Solo has zero score reduction on a mistake by design (combo reset is
    // the only cost) — but a duel has no lives, so it needs its own real
    // stake per ARENA_INTEGRATION.md rule 4: -5 score, floored at 0.
    if (isChallenge) {
      scoreRef.current = Math.max(0, scoreRef.current - 5);
      setScore(scoreRef.current);
    }

    triggerFlash('red');
    audioSynth?.playPenalty();

  }, [triggerFlash, isChallenge]);

  const handleTowerClick = useCallback((towerIndex, e) => {
    if (e) {
      e.stopPropagation();
      e.preventDefault();
      if (e.target.setPointerCapture && e.pointerId != null) {
        try { e.target.setPointerCapture(e.pointerId); } catch {}
      }
    }
    if (!gameActiveRef.current) return;
    if (clickCooldownRef.current) return;
    clickCooldownRef.current = true;
    setTimeout(() => { clickCooldownRef.current = false; }, 50);

    if (selectedTower === null) {
      if (towers[towerIndex].length > 0) {
        setSelectedTower(towerIndex);
        audioSynth?.playHit();
      }
      return;
    }

    const ft = selectedTower;
    const tt = towerIndex;
    if (ft === tt) { setSelectedTower(null); return; }

    const fd = towers[ft][towers[ft].length - 1];
    const td = towers[tt][towers[tt].length - 1];

    if (fd && (!td || fd < td)) {
      const nt = towers.map((t) => [...t]);
      nt[tt].push(nt[ft].pop());
      setTowers(nt);
      movesRef.current += 1;
      setMoves(movesRef.current);
      setSelectedTower(null);
      spawnBurst((tt + 0.5) * (100 / 3), 60, 'cyan');
      resolveValidMove(nt);
    } else {
      setSelectedTower(null);
      resolveInvalidMove();
    }
  }, [selectedTower, towers, resolveValidMove, resolveInvalidMove, spawnBurst]);

  const scheduleHeartbeat = useCallback(() => {
    if (isChallenge) return;
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
  }, [isChallenge]);

  const beginPlaying = useCallback(() => {
    if (!mountedRef.current) return;
    gameActiveRef.current = true;
    setPhase('playing');

    gameTimerRef.current = setInterval(() => {
      if (!gameActiveRef.current) { clearInterval(gameTimerRef.current); return; }
      // Duel: read the clock from the match's shared absolute end instant
      // rather than accumulating it locally — see duelSecondsRemaining. A
      // tick that lands late (busy frame, GC pause, the OS throttling a
      // backgrounded webview) has to cost this player frames, not extra
      // seconds of play their opponent never got.
      timeRemainingRef.current = duelDeadlineRef.current
        ? duelSecondsRemaining(duelDeadlineRef.current)
        : timeRemainingRef.current - 0.2;
      if (timeRemainingRef.current <= 0) {
        timeRemainingRef.current = 0;
        setTimeRemaining(0);
        endGameRef.current?.('time');
      } else {
        // Only when the DISPLAYED whole second changes — same fix as
        // DualTargetFlowClient/FingerSequencingClient/GridMemorizationClient.
        // This re-rendered the whole towers/disks tree 5x/sec unconditionally.
        setTimeRemaining((prev) => (
          Math.ceil(prev) === Math.ceil(timeRemainingRef.current) ? prev : timeRemainingRef.current
        ));
      }
    }, 200);
    scheduleHeartbeat();
  }, [scheduleHeartbeat]);

  const runCountdown = useCallback((n) => {
    if (countdownTimerRef.current) clearTimeout(countdownTimerRef.current);
    if (!mountedRef.current) return;
    setPhase('countdown');
    if (n <= 0) {
      setCountdownValue('GO');
      if (!isChallenge) audioSynth?.playGo();
      countdownTimerRef.current = setTimeout(() => beginPlaying(), 350);
      return;
    }
    setCountdownValue(n);
    if (!isChallenge) audioSynth?.playCountdownTick();
    countdownTimerRef.current = setTimeout(() => runCountdown(n - 1), COUNTDOWN_TICK_MS);
  }, [beginPlaying, isChallenge]);

  const enterDrill = useCallback(async () => {
    // Unmount the start card on the tap itself, before the rotation begins.
    setLaunching(true);
    try { audioSynth?.init(); } catch {}

    gameActiveRef.current = false;
    [overdriveTimeoutRef, countdownTimerRef, advanceTimerRef, heartbeatTimerRef].forEach((r) => { if (r.current) { clearTimeout(r.current); r.current = null; } });
    if (gameTimerRef.current) { clearInterval(gameTimerRef.current); gameTimerRef.current = null; }

    // Every run starts at the lowest difficulty. It used to start at 55% of the
    // player's best level, so improving once permanently raised the speed every
    // future run opened at - a silent spike with nothing on screen explaining it.
    // That head-start only existed because a fixed 45s was too short to climb the
    // ramp; the endurance clock replaces it.
    const startLevel = MIN_LEVEL;

    scoreRef.current = 0; comboRef.current = 0; bestComboRef.current = 0;
    levelRef.current = startLevel; bestLevelRunRef.current = startLevel; mistakesRef.current = 0; correctActionsRef.current = 0; totalActionsRef.current = 0;
    overdriveMeterRef.current = 0; overdriveActiveRef.current = false; overdriveCountRef.current = 0;
    timeRemainingRef.current = totalTime;
    sessionMovesRef.current = 0; parMovesSumRef.current = 0; movesSumRef.current = 0; perfectSolvesRef.current = 0;

    setScore(0); setLevel(startLevel); setTimeRemaining(totalTime);
    setDangerLevel(0); setEndSummary(null); setFlashes([]); setBursts([]);
    setCountdownValue(3);

    initializeLevel(startLevel);

    if (!isChallenge && !document.fullscreenElement && containerRef.current) {
      try { await containerRef.current.requestFullscreen(); } catch {}
    }
    if (Capacitor.isNativePlatform()) {
      StatusBar.setOverlaysWebView({ overlay: true }).catch(() => {});
      StatusBar.hide().catch(() => {});
    }

    try { await lockLandscape(); } catch {}

    // Wait for the viewport to actually stop moving before showing the countdown,
    // instead of guessing with a fixed delay — see afterViewportSettled in
    // lib/orientation.js. A blind timeout let the "3" mount mid-resize and jump.
    afterViewportSettled(() => {
      if (!mountedRef.current) return;
      if (window.innerHeight > window.innerWidth) {
        setPhase('rotate-hint');
      } else {
        runCountdown(isChallenge ? 0 : 3);
      }
    });
  }, [runCountdown, isChallenge, initializeLevel, bestLevel, totalTime]);

  useEffect(() => {
    const onOrientationChange = () => {
      if (phase === 'rotate-hint' && window.innerWidth > window.innerHeight) {
        setPhase('countdown');
        runCountdown(isChallenge ? 0 : 3);
      }
    };
    // Self-heal: if the device is ALREADY landscape, no further resize or
    // orientationchange event will ever fire, so the listener below can never
    // rescue this screen. That is reachable — the pre-countdown orientation check
    // used to run on a blind timer and could read a mid-rotation viewport as
    // portrait, leaving the drill parked on "Rotate your phone to play" with no
    // way back. Re-check once against settled dimensions.
    const cancelSettle = phase === 'rotate-hint' ? afterViewportSettled(onOrientationChange) : null;
    const stopListening = onOrientationSettled(onOrientationChange);
    return () => { if (cancelSettle) cancelSettle(); stopListening(); };
  }, [phase, runCountdown, isChallenge]);

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
    if (!isChallenge || !matchStartAt || phase !== 'start' || duelAutoStartedRef.current) return;
    const delay = Math.max(0, matchStartAt - Date.now());
    const t = setTimeout(() => {
      duelAutoStartedRef.current = true;
      enterDrill();
    }, delay);
    return () => clearTimeout(t);
  }, [isChallenge, matchStartAt, phase, enterDrill]);

  // Pre-warm the landscape lock as soon as we know a duel is about to
  // start, instead of waiting until the synchronized matchStartAt instant
  // to begin it. lockLandscape() calls into Android's native orientation
  // API, and how long it actually takes to finish rotating the device
  // varies meaningfully by device/current-orientation — doing this AT
  // matchStartAt meant the real game start happened at matchStartAt +
  // however long THIS device's rotation took, which differed between the
  // two duelists and showed up as a 1-2s gap between when their matches
  // visibly began. The shared countdown always has a few seconds of lead
  // time before matchStartAt (see MATCH_COUNTDOWN_MS in DrillWrapper.js),
  // so there's room to finish this well beforehand on both devices —
  // enterDrill's own lockLandscape() call then just resolves immediately
  // since the device is already there.
  useEffect(() => {
    if (!isChallenge || !matchStartAt) return;
    if (Capacitor.isNativePlatform()) {
      StatusBar.setOverlaysWebView({ overlay: true }).catch(() => {});
      StatusBar.hide().catch(() => {});
    }
    lockLandscape().catch(() => {});
  }, [isChallenge, matchStartAt]);

  // Rematch reuses this same route with only ?challengeId= changing — reset
  // all per-match state so the previous match doesn't leak into the new one.
  const prevChallengeIdRef = useRef(challengeId);
  useEffect(() => {
    if (challengeId === prevChallengeIdRef.current) return;
    prevChallengeIdRef.current = challengeId;
    duelAutoStartedRef.current = false;
    setPhase('start');
    setLaunching(false);
    setScore(0);
    setEndSummary(null);
    setTimeRemaining(totalTime);
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
    drillName: 'Tower of Hanoi',
    playerName: getPlayerName(),
  } : null, {
    url: APP_SHARE_URL,
    title: 'Tower of Hanoi — SkillDrills',
    text: endSummary ? `Scored ${endSummary.score} pts on Tower of Hanoi (${endSummary.accuracy}% accuracy, ${endSummary.bestCombo}x combo) — SkillDrills` : '',
  });

  const getDiskWidth = useCallback((ds, md) => {
    const mw = 132, miw = 36;
    return `${miw + ((ds - 1) / Math.max(1, md - 1)) * (mw - miw)}px`;
  }, []);

  if (loading || !isClient) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-[#050508]">
        <div className="text-center">
          <div className="w-14 h-14 border-4 border-violet-600 border-t-transparent rounded-full animate-spin mx-auto mb-4 shadow-[0_0_20px_rgba(139,92,246,0.5)]" />
          <p className="text-slate-500 font-bold tracking-widest uppercase text-[10px] animate-pulse">Loading Towers...</p>
        </div>
      </div>
    );
  }

  const diskCount = disksForLevel(level);
  const showBoard = phase === 'playing' || phase === 'countdown';

  return (
    <DrillWrapper
      drillName="Tower of Hanoi"
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
        onContextMenu={(e) => { if (gameActiveRef.current) e.preventDefault(); }}
        className={`absolute inset-0 select-none overflow-hidden bg-[#050508] text-white`}
        style={{ touchAction: gameActiveRef.current ? 'none' : 'auto', WebkitTapHighlightColor: 'transparent' }}
      >
        <div className="absolute inset-0 pointer-events-none" style={{ backgroundImage: 'linear-gradient(rgba(255,255,255,0.015) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.015) 1px, transparent 1px)', backgroundSize: '40px 40px' }} />

        {phase === 'playing' && dangerLevel > 0.06 && (
          <div className="fx-vignette" style={{ '--v-min': Math.max(0.05, dangerLevel * 0.25), '--v-max': Math.min(0.55, dangerLevel * 0.75), animationDuration: `${heartbeatTempoRef.current}ms` }} />
        )}

        {phase === 'rotate-hint' && !isChallenge && (
          <div className="absolute inset-0 z-[100] flex flex-col items-center justify-center bg-black/95 text-center p-6">
            <div className="animate-bounce mb-5 text-blue-500"><RotateCcw className="w-12 h-12 mx-auto" /></div>
            <p className="text-sm font-bold text-white">Rotate your phone to play</p>
            <p className="text-xs text-slate-500 mt-1.5 max-w-[220px] mx-auto">Please rotate your device to landscape mode for the optimal playing experience.</p>
          </div>
        )}

        {flashes.map((f) => (
          <div key={f.id} className={`fx-flash ${f.variant === 'gold' ? 'fx-flash-gold' : f.variant === 'cyan' ? 'fx-flash-cyan' : 'fx-flash-red'}`} />
        ))}

        {(phase === 'start' || phase === 'countdown' || phase === 'playing') && (
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); setSoundEnabled((v) => { audioSynth?.setEnabled(!v); return !v; }); }}
            className="absolute bottom-5 right-5 z-40 p-2 before:absolute before:top-0 before:left-0 before:-right-[14px] before:-bottom-[14px] before:content-[''] rounded-full bg-black/60 border border-white/10 text-slate-400 active:scale-90 transition-transform cursor-pointer"
          >
            {soundEnabled ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
          </button>
        )}

        {/* ── START SCREEN ── */}
        {phase === 'start' && !launching && !isChallenge && (
          <div className="relative h-full flex items-center justify-center p-5 overflow-y-auto z-40">
            <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(ellipse 420px 260px at 50% 8%, rgba(142,97,246,.16), transparent 70%)' }} />
            <div className="relative w-full max-w-[290px] rounded-[20px] border border-white/5 bg-[#0c0c16]/90 backdrop-blur-lg px-5 pt-5 pb-[18px] text-center shadow-[0_16px_40px_rgba(0,0,0,.5)] my-6">
              <div className="w-11 h-11 mx-auto rounded-[14px] bg-gradient-to-br from-violet-600 to-indigo-600 flex items-center justify-center mb-3 shadow-[0_0_22px_rgba(139,92,246,.35)]">
                <Compass className="w-[22px] h-[22px] text-white" />
              </div>
              <h1 className="font-display text-[32px] sm:text-[38px]">Tower of Hanoi</h1>
              <p className="text-[9px] label-tiny text-slate-500 mt-1">45s per level</p>

              <div className="flex flex-col gap-1.5 text-left mt-3.5">
                <HowToRow icon={<Eye className="w-3.5 h-3.5 text-cyan-400 flex-shrink-0" />} node={<>Tap a peg to lift, tap to place</>} />
                <HowToRow icon={<ZapIcon className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" />} node={<>One more disk every level</>} />
                <HowToRow icon={<Ban className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />} node={<>Never stack big on small</>} />
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

        {/* ── PLAYING / COUNTDOWN BOARD ── */}
        {showBoard && (
          <>
            <div className="absolute top-5 left-5 z-40 flex flex-col pointer-events-none select-none">
              <span className="text-2xl font-hud font-bold text-white leading-none tabular-nums">{score}</span>
              <div className="flex items-center gap-2 mt-1.5">
                <span className="text-[10px] font-black text-violet-300 bg-violet-500/10 border border-violet-500/20 px-1.5 py-0.5 rounded">{diskCount} Disks</span>
              </div>
            </div>

            {/* Timer — top-right corner */}
            <div className="absolute top-5 right-5 z-40 flex flex-col items-end pointer-events-none select-none">
              <span className={`text-3xl font-hud font-bold leading-none tabular-nums ${timeRemaining <= 10 ? 'text-red-500 animate-pulse' : 'text-slate-300'}`}>
                {Math.ceil(timeRemaining)}s
              </span>
              <span className="text-[8px] label-tiny text-slate-500 mt-1">Time Left</span>
            </div>

            {/* Moves counter — top-center */}
            <div className="absolute top-5 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 bg-black/50 border border-white/10 rounded-full px-3.5 py-1.5 pointer-events-none">
              <Move className="w-3.5 h-3.5 text-violet-300" />
              <span className="text-[11px] font-black text-slate-200">{moves}<span className="text-slate-500">/{parMoves} par</span></span>
            </div>

            <div className="relative w-full h-full flex flex-col items-center justify-center px-4 pt-20 pb-16">
              {bursts.map((b) => (
                <div key={b.id} className="fx-pop" style={{ left: `${b.x}%`, top: `${b.y}%`, width: 40, height: 40, marginLeft: -20, marginTop: -20, background: b.color === 'red' ? 'rgba(239,68,68,.5)' : 'rgba(34,211,238,.5)' }} />
              ))}

              <div className="flex w-full justify-around items-end px-2 mt-4">
                {[0, 1, 2].map((ti) => (
                  <button
                    key={ti}
                    onPointerDown={(e) => handleTowerClick(ti, e)}
                    className={`flex flex-col items-center transition-all duration-100 touch-none rounded-2xl p-2 w-[30%] ${selectedTower === ti ? 'bg-violet-500/10 ring-2 ring-violet-400/50 scale-105' : 'active:bg-white/5'}`}
                    aria-label={`Peg ${ti + 1}`}
                  >
                    <div className="relative flex flex-col items-center w-full" style={{ minHeight: `${diskCount * 30}px` }}>
                      <div
                        className="absolute bottom-0 left-1/2 -translate-x-1/2 w-3 rounded-t-full z-0"
                        style={{ height: `${diskCount * 30 + 26}px`, background: 'linear-gradient(135deg, #3a3a46 0%, #1c1c24 100%)' }}
                      />
                      <div className="flex flex-col-reverse items-center relative z-10 w-full" style={{ minHeight: `${diskCount * 30}px` }}>
                        {towers[ti].map((disk, di) => (
                          <Disk
                            key={di}
                            width={getDiskWidth(disk, diskCount)}
                            skin={DISK_SKINS[(disk - 1) % DISK_SKINS.length]}
                          />
                        ))}
                      </div>
                    </div>
                    <div className="w-[112%] h-3 rounded-full mt-1 border border-white/10" style={{ background: 'linear-gradient(135deg, #2c2c36 0%, #111116 100%)' }} />
                    <div className={`mt-3 text-[9px] font-black tracking-widest uppercase ${selectedTower === ti ? 'text-violet-400' : 'text-slate-600'}`}>Peg {ti + 1}</div>
                  </button>
                ))}
              </div>

            </div>
          </>
        )}

        {/* ── COUNTDOWN SCREEN ── */}
        {phase === 'countdown' && !isChallenge && (
          <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/60">
            <span className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-400">Get Ready</span>
            <div className="relative w-28 h-28 rounded-full border-[3px] border-violet-500/20 flex items-center justify-center">
              <div className="absolute -inset-[3px] rounded-full border-[3px] border-transparent border-t-violet-400 border-r-violet-400 animate-spin" style={{ animationDuration: '0.7s' }} />
              <span key={countdownValue} className="fx-pop-in text-5xl font-display bg-gradient-to-b from-white to-violet-300 bg-clip-text text-transparent">
                {countdownValue}
              </span>
            </div>
            <span className="text-[10px] text-slate-500">{disksForLevel(MIN_LEVEL)} disks — first tower loads at GO</span>
          </div>
        )}

        {/* ── RESULT SCREEN ── */}
        {phase === 'ended' && endSummary && !isChallenge && (
          <ResultScreen summary={endSummary} bestScore={bestScore} onPlayAgain={enterDrill} onShare={shareResult} />
        )}
      </div>
    </DrillWrapper>
  );
}

// ============================================================
// Subcomponents
// ============================================================
function Disk({ width, skin }) {
  return (
    <div
      className="rounded-lg mb-[3px] border transition-all duration-300"
      style={{
        width,
        height: '22px',
        background: skin.fill,
        borderColor: skin.rim,
        boxShadow: `0 0 12px rgba(${skin.glow},.5)`,
      }}
    />
  );
}

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
      <div className={`text-[12px] font-hud font-bold ${color}`}>{value}</div>
      <div className="text-[7.5px] label-tiny text-slate-500 mt-0.5">{label}</div>
    </div>
  );
}

function ResultScreen({ summary, bestScore, onPlayAgain, onShare }) {
  const grade = getGrade(summary.accuracy);
  const gradeColor = grade.grade === 'S+' || grade.grade === 'S' ? '#fbbf24' : '#a78bfa';

  return (
    <div className="absolute inset-0 z-40 flex" style={{ background: 'rgba(5,5,8,0.97)' }}>
      <div className="w-[36%] flex flex-col items-center justify-center gap-1.5 border-r border-white/5" style={{ background: 'radial-gradient(ellipse 260px 200px at 50% 30%, rgba(250,204,21,.08), transparent 70%)' }}>
        {summary.isNewBest && (
          <span className="text-[11px] font-display text-yellow-400 bg-yellow-500/10 border border-yellow-500/25 px-2.5 py-1 rounded-full mb-1">NEW BEST</span>
        )}
        <div className="text-5xl sm:text-6xl font-display leading-none" style={{ color: gradeColor }}>{grade.grade}</div>
        <div className="text-[10px] label-tiny text-slate-500">{grade.label}</div>
        <div className="text-3xl sm:text-4xl font-display text-white mt-1 tabular-nums">{summary.score.toLocaleString()}</div>
        <div className="text-[9px] label-tiny text-slate-500">Points</div>
      </div>

      <div className="flex-1 flex flex-col justify-center gap-3 px-6 sm:px-8 py-4 min-w-0">
        <div className="grid grid-cols-3 gap-2">
          <ResultStat label="Best Score" value={(bestScore ?? 0).toLocaleString()} color="text-yellow-400" />
          <ResultStat label="Accuracy" value={`${summary.accuracy}%`} color="text-blue-400" />
          <ResultStat label="XP" value={`+${summary.xpEarned}`} color="text-violet-400" />
        </div>
        <div className="flex gap-2">
          <button onClick={onPlayAgain} className="flex-1 py-3 rounded-[13px] bg-gradient-to-r from-violet-600 to-indigo-600 text-white font-extrabold text-xs uppercase tracking-wider cursor-pointer">
            Play Again
          </button>
          <button onClick={onShare} className="w-12 min-h-[46px] flex-shrink-0 rounded-[13px] bg-white/[0.04] border border-white/10 flex items-center justify-center text-slate-400 hover:text-white cursor-pointer">
            <Share2 className="w-4 h-4" />
          </button>
          <Link href="/drills/cognitive" className="w-12 min-h-[46px] flex-shrink-0 rounded-[13px] bg-white/[0.04] border border-white/10 flex items-center justify-center text-slate-400 hover:text-white">
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
      <div className={`text-sm font-hud font-bold ${color} tabular-nums`}>{value}</div>
      <div className="text-[7.5px] label-tiny text-slate-500 mt-0.5">{label}</div>
    </div>
  );
}