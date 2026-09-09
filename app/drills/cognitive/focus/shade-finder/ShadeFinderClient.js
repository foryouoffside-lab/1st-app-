'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import { Volume2, VolumeX } from 'lucide-react';

import { scoreAction, calcEndBonuses, calcSessionXP, getGrade } from '../../../../../lib/scoringEngine';
import {
  levelForHits, rampMs, rampToFloor, startLevel,
  scoringMaxLevel, scoringLives,
} from '../../../../../lib/drillRules';
import { saveLeaderboardEntrySync } from '../../../../../lib/leaderboard';
import { lockPortrait, unlockOrientation } from '../../../../../lib/orientation';
import { previewDailyCompletion } from '../../../../../lib/dailyChallenge';
import { getPlayerName, getPlayerLevel } from '../../../../../lib/progressStore';
import { useShareCard } from '../../../../../components/ShareScoreCard';
import { Capacitor } from '@capacitor/core';
import { StatusBar } from '@capacitor/status-bar';
import DrillWrapper from '../../../../../components/DrillWrapper';
import { useDuelMatchStart } from '../../../../../lib/challengeEngine';
import { APP_SHARE_URL } from '../../../../../lib/shareLinks';
import ResultScreen from '../../../../../components/drill/ResultScreen';
import DrillStartCard from '../../../../../components/drill/DrillStartCard';

// ============================================================
// TUNING CONSTANTS
// ============================================================
// A hard 45s. Skill cannot extend it (see the SPRINT note below) — this is a
// plain countdown, not the shared earn-time clock.
const TOTAL_TIME = 45.0;

// Drill-local difficulty dials. The ramp (window, shade delta, grid size) still
// runs off correct-action count so the board keeps escalating across the 45s;
// each value decays toward a floor rather than a fixed slope.
const WINDOW_START_MS = 3000;
const WINDOW_FLOOR_MS = 1250;
const SHADE_DELTA_FLOOR = 4.5;  // below this the two shades are indistinguishable
// This drill used to run a steeper curve than the rest of the catalogue (0.91
// against a 0.94 default) because it has only two dials that can move and both
// bottom out at values chosen for fairness rather than comfort. Under the
// shared front-loaded runway that override is gone: every drill now moves the same %
// per level, and a drill being "steeper" than its neighbours is exactly the
// inconsistency the pass set out to remove. If Shade Finder specifically ends
// up feeling flat, widen its range below — do not reintroduce a private curve.
const SHADE_DELTA = 9; // Base lightness percentage difference

// The board itself grows now — it was pinned at 7x7 for the whole run, so the
// only thing that ever got harder was the contrast. More cells is the honest
// way to make a visual search task harder: it lengthens the scan without
// pushing the two shades closer than the eye can actually separate.
//
// 9 is the ceiling because of the cell size, not the difficulty: the board is a
// square capped at min(100vw-32px, 100vh-220px), so on a ~390px-wide phone a
// 9x9 leaves ~34px cells and a 10x10 drops under 30px, which starts costing
// mis-taps rather than testing eyesight.
// Correct finds per level. 2, not the shared 4: one find per round is roughly
// 0.45 actions/sec, so the shared value would leave level 40 unreachable.
const HITS_PER_LEVEL = 2;

// ── Shade Finder runs the SPRINT format, not the shared endurance economy ────
// A "spot the odd shade" hunt is a chore stretched over four or five minutes —
// visual search is fatiguing and monotonous in a way the twitch drills aren't.
// So this drill alone: a hard 45-second clock that skill CANNOT extend (no
// earn-time), and 5 lives — a wrong tap or a missed round costs one, run over
// at zero. Because the clock is fixed, the lives are what make it a challenge:
// rush and lose lives, play safe and find fewer. The `if (!isChallenge)`
// branches keep duels on their own fixed rules, untouched.
const SPRINT_LIVES = 5;
const GRID_START = 7;
const GRID_MAX = 9;
// 15, not 3. The board is the one dial here that can only arrive whole, so it
// is the only step a player can feel. At 3 the grid hit its 9x9 ceiling by level
// 7 and never moved again; 15 spreads the two growth steps across the run.
const LEVELS_PER_GRID_STEP = 15;

const gridSizeForLevel = (level) =>
  Math.min(GRID_MAX, GRID_START + Math.floor(Math.max(0, level - 1) / LEVELS_PER_GRID_STEP));

const STORAGE_KEY = 'skilldrills_shade_finder_v1';

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
export default function ShadeFinderClient() {
  const searchParams = useSearchParams();
  const challengeId = searchParams ? searchParams.get('challengeId') : null;
  const isChallenge = !!challengeId;
  const totalTime = isChallenge ? 30 : TOTAL_TIME;
  const matchStartAt = useDuelMatchStart(challengeId);
  const duelAutoStartedRef = useRef(false);

  const [isClient, setIsClient] = useState(false);
  const [loading, setLoading] = useState(true);
  const [soundEnabled, setSoundEnabled] = useState(true);

  const [phase, setPhase] = useState('start'); // 'start' | 'countdown' | 'playing' | 'ended'
  const [countdownValue, setCountdownValue] = useState(3);

  const [bestScore, setBestScore] = useState(0);
  const [bestCombo, setBestCombo] = useState(0);
  const [bestLevel, setBestLevel] = useState(1);

  const [score, setScore] = useState(0);
  const [lives, setLives] = useState(SPRINT_LIVES);
  // The live "Lv." HUD badge was the only thing that ever READ this, so the
  // React state went with it. The ramp itself runs off levelRef, which the
  // game loop already uses; keeping a useState in step with it only bought a
  // re-render of the whole drill on every level-up, mid-play, for nothing.
  const [timeRemaining, setTimeRemaining] = useState(totalTime);
  const [dangerLevel, setDangerLevel] = useState(0);

  const [gridSize, setGridSize] = useState(GRID_START);
  const [gridCells, setGridCells] = useState([]);

  const [flashes, setFlashes] = useState([]);
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
  const livesRef = useRef(SPRINT_LIVES);
  const correctActionsRef = useRef(0);
  const totalActionsRef = useRef(0);
  const timeRemainingRef = useRef(totalTime);
  const runOverRef = useRef(false);

  const roundStartAtRef = useRef(0);
  const heartbeatTempoRef = useRef(1100);

  const gameTimerRef = useRef(null);
  const heartbeatTimerRef = useRef(null);
  const countdownTimerRef = useRef(null);
  const roundTimerRef = useRef(null);

  const flashIdRef = useRef(0);

  useEffect(() => {
    setIsClient(true);

    // Take the status-bar area now, behind the 200ms loading screen, rather
    // than when the player taps START. overlaysWebView:true makes the window
    // layout size independent of whether the bar is showing, so this drill's
    // StatusBar.hide() no longer resizes the WebView under the "3 · 2 · 1 · GO"
    // overlay — which is what made the first digit shift into place.
    if (Capacitor.isNativePlatform()) StatusBar.setOverlaysWebView({ overlay: true }).catch(() => {});
    mountedRef.current = true;
    lockPortrait();
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
      [heartbeatTimerRef, countdownTimerRef, roundTimerRef].forEach((r) => { if (r.current) clearTimeout(r.current); });
      if (gameTimerRef.current) clearInterval(gameTimerRef.current);
      if (Capacitor.isNativePlatform()) {
        StatusBar.setOverlaysWebView({ overlay: false }).catch(() => {});
        StatusBar.show().catch(() => {});
      }
      unlockOrientation();
    };
  }, []);

  useEffect(() => { if (audioSynth) audioSynth.setEnabled(soundEnabled); }, [soundEnabled]);

  const triggerFlash = useCallback((variant) => {
    flashIdRef.current += 1;
    const id = `${Date.now()}-${flashIdRef.current}`;
    setFlashes((f) => [...f, { id, variant }]);
    setTimeout(() => { if (mountedRef.current) setFlashes((f) => f.filter((x) => x.id !== id)); }, 150);
  }, []);

  const updateDifficulty = useCallback(() => {
    const calculatedLevel = levelForHits(correctActionsRef.current, HITS_PER_LEVEL);
    if (calculatedLevel > levelRef.current) {
      levelRef.current = calculatedLevel;
      bestLevelRunRef.current = Math.max(bestLevelRunRef.current, calculatedLevel);

    }
  }, []);

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
      livesRemaining: scoringLives(0),
      level: levelRef.current,
      maxLevel: scoringMaxLevel(isChallenge),
    });

    let total = pts.total;

    scoreRef.current += total;
    // No earn-time in either mode: solo is the fixed 45s SPRINT (see
    // SPRINT_LIVES), Arena keeps its shared fixed deadline. The clock only ever
    // drains.
    comboRef.current = comboBefore + 1;
    bestComboRef.current = Math.max(bestComboRef.current, comboRef.current);
    correctActionsRef.current += 1;
    totalActionsRef.current += 1;

    triggerFlash('cyan');

    audioSynth?.playHit();

    setScore(scoreRef.current);
    updateDifficulty();
  }, [updateDifficulty, triggerFlash, totalTime]);

  const endGameRef = useRef(null);

  const resolveWrong = useCallback((kind = 'wrong') => {
    if (!gameActiveRef.current) return;
    comboRef.current = 0;
    mistakesRef.current += 1;
    totalActionsRef.current += 1;

    audioSynth?.playPenalty();

    if (isChallenge) {
      scoreRef.current = Math.max(0, scoreRef.current - 5);
    } else {
      // Sprint format: a wrong tap / missed round costs a life, not time.
      livesRef.current = Math.max(0, livesRef.current - 1);
      setLives(livesRef.current);
      runOverRef.current = livesRef.current <= 0;
    }

    triggerFlash('red');

    setScore(scoreRef.current);

    if (!isChallenge && runOverRef.current) endGameRef.current?.();
  }, [triggerFlash, isChallenge]);

  // Ends on the 45s clock or on losing the last life — the result screen is the
  // same either way, so callers pass a reason for readability only.
  const endGame = useCallback(async () => {
    if (!gameActiveRef.current) return;
    gameActiveRef.current = false;

    if (heartbeatTimerRef.current) { clearTimeout(heartbeatTimerRef.current); heartbeatTimerRef.current = null; }
    if (roundTimerRef.current) { clearTimeout(roundTimerRef.current); roundTimerRef.current = null; }
    if (gameTimerRef.current) { clearInterval(gameTimerRef.current); gameTimerRef.current = null; }

    audioSynth?.playResultsReveal();

    const correct = correctActionsRef.current;
    const total = totalActionsRef.current;
    const accuracy = total > 0 ? Math.round((correct / total) * 100) : 0;

    const bonuses = calcEndBonuses({
      rawScore: scoreRef.current,
      accuracy,
      bestCombo: bestComboRef.current,
      totalActions: total,
      mistakes: mistakesRef.current,
      livesRemaining: scoringLives(0),
      category: 'cognitive',
    });
    const finalScore = bonuses.finalScore;

    const prevSaved = getSavedData();
    const isNewBest = finalScore > prevSaved.bestScore;
    const firstPlay = prevSaved.totalSessions === 0;
    const daily = isChallenge
      ? { isDailyDrill: false, wouldCompleteSet: false }
      : await previewDailyCompletion('shade-finder');

    // Captured BEFORE the run is banked: the result screen's XP bar animates
    // from the level the player walked in with to the one they walk out with.
    const progress = await getPlayerLevel();

    const xpResult = calcSessionXP({ finalScore, accuracy, isNewBest, firstPlay, dailyChallenge: daily.isDailyDrill, dailyChallengeSetComplete: daily.wouldCompleteSet });

    const updated = {
      bestScore: Math.max(prevSaved.bestScore, finalScore),
      bestCombo: Math.max(prevSaved.bestCombo, bestComboRef.current),
      bestLevel: Math.max(prevSaved.bestLevel, bestLevelRunRef.current),
      totalSessions: prevSaved.totalSessions + 1,
    };
    saveData(updated);
    setBestScore(updated.bestScore);
    setBestCombo(updated.bestCombo);
    setBestLevel(updated.bestLevel);

    saveLeaderboardEntrySync({
      drillId: 'shade-finder',
      drillName: 'Shade Finder',
      category: 'cognitive',
      score: finalScore,
      accuracy,
      bestCombo: bestComboRef.current,
    });

    setEndSummary({
      progress,
      score: finalScore,
      accuracy,
      bestCombo: bestComboRef.current,
      level: bestLevelRunRef.current,
      livesLeft: livesRef.current,
      isNewBest,
      xpEarned: xpResult.xp,
      prevBest: prevSaved.bestScore,
    });

    // The status bar deliberately stays hidden here. Re-showing it resized the
    // WebView at the exact moment the result screen mounted, so the results
    // visibly jumped into place. It is restored on unmount instead (see the
    // mount effect), alongside unlockOrientation().
    setPhase('ended');
  }, []);

  useEffect(() => { endGameRef.current = endGame; }, [endGame]);

  const spawnRound = useCallback(() => {
    if (!gameActiveRef.current) return;

    const n = gridSizeForLevel(levelRef.current);
    setGridSize(n);

    const H = Math.floor(Math.random() * 360);
    const S = Math.floor(Math.random() * 20) + 65;
    const L = Math.floor(Math.random() * 20) + 40;

    const delta = rampToFloor(levelRef.current, SHADE_DELTA, SHADE_DELTA_FLOOR);
    const targetL = L + delta <= 82 ? L + delta : L - delta;

    const baseColor = `hsl(${H}, ${S}%, ${L}%)`;
    const targetColor = `hsl(${H}, ${S}%, ${targetL}%)`;

    const totalCells = n * n;
    const targetIndex = Math.floor(Math.random() * totalCells);

    const cells = [];
    for (let i = 0; i < totalCells; i++) {
      cells.push({
        id: i,
        color: i === targetIndex ? targetColor : baseColor,
        isTarget: i === targetIndex
      });
    }

    setGridCells(cells);
    roundStartAtRef.current = Date.now();

    if (roundTimerRef.current) clearTimeout(roundTimerRef.current);
    const windowMs = rampMs(levelRef.current, WINDOW_START_MS, WINDOW_FLOOR_MS);
    roundTimerRef.current = setTimeout(() => {
      if (!gameActiveRef.current || !mountedRef.current) return;
      resolveWrong('timeout');
      setTimeout(() => { if (gameActiveRef.current) spawnRound(); }, 120);
    }, windowMs);
  }, [resolveWrong]);

  const handleCellTap = useCallback((idx) => {
    if (!gameActiveRef.current) return;
    if (roundTimerRef.current) clearTimeout(roundTimerRef.current);

    const tappedCell = gridCells[idx];
    if (!tappedCell) return;

    if (tappedCell.isTarget) {
      resolveCorrect(roundStartAtRef.current);
    } else {
      resolveWrong('wrong');
    }

    setTimeout(() => { if (gameActiveRef.current) spawnRound(); }, 120);
  }, [resolveCorrect, resolveWrong, spawnRound, gridCells]);

  const scheduleHeartbeat = useCallback(() => {
    if (isChallenge) return;
    if (!gameActiveRef.current) return;
    // Danger pulses on either axis: the last 10 seconds, or the last 2 lives.
    const dangerFromTime = timeRemainingRef.current <= 10 ? (10 - timeRemainingRef.current) / 10 : 0;
    const dangerFromLives = livesRef.current <= 2 ? (3 - livesRef.current) / 3 : 0;
    const danger = Math.min(1, Math.max(0, dangerFromTime, dangerFromLives));
    // Clamped: an unclamped tempo goes NEGATIVE once danger exceeds ~1.69, and
    // a setTimeout with a negative delay fires
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
    gameActiveRef.current = true;
    gameTimerRef.current = setInterval(() => {
      if (!gameActiveRef.current) { clearInterval(gameTimerRef.current); return; }
      timeRemainingRef.current -= 0.2;
      if (timeRemainingRef.current <= 0) {
        timeRemainingRef.current = 0;
        setTimeRemaining(0);
        endGameRef.current?.('time');
      } else {
        // Quantised to the second it is DISPLAYED at.
        //
        // Every consumer of this state reads it through Math.ceil — the HUD
        // clock and DrillWrapper's timeLeft prop — so the fraction is never
        // shown. But a raw float differs from the previous one on every single
        // tick, so React could never bail out of the render, and this timer
        // re-rendered the entire play field several times a second for the
        // whole run just to repaint a number that had not changed. Rounded
        // first, the value is identical on most ticks and React skips the
        // render outright. Same pixels, a fraction of the main-thread work.
        const shown = Math.ceil(timeRemainingRef.current);
        setTimeRemaining((v) => (v === shown ? v : shown));
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
    if (!isChallenge) audioSynth?.playCountdownTick();
    setCountdownValue(n);
    countdownTimerRef.current = setTimeout(() => runCountdown(n - 1), 700);
  }, [beginPlaying, isChallenge]);

  const enterDrill = useCallback(() => {
    audioSynth?.init();
    lockPortrait();

    gameActiveRef.current = false;
    [heartbeatTimerRef, countdownTimerRef, roundTimerRef].forEach((r) => { if (r.current) { clearTimeout(r.current); r.current = null; } });
    if (gameTimerRef.current) { clearInterval(gameTimerRef.current); gameTimerRef.current = null; }

    // Every run starts at the lowest difficulty. It used to start at 55% of the
    // player's best level, so improving once permanently raised the speed every
    // future run opened at - a silent spike with nothing on screen explaining it.
    // That head-start only existed because a fixed 45s was too short to climb the
    // ramp; the endurance clock replaces it.
    const runStartLevel = isChallenge ? 1 : startLevel(bestLevel);

    scoreRef.current = 0; comboRef.current = 0; bestComboRef.current = 0;
    levelRef.current = runStartLevel; bestLevelRunRef.current = runStartLevel; mistakesRef.current = 0; correctActionsRef.current = 0; totalActionsRef.current = 0;
    livesRef.current = SPRINT_LIVES;
    timeRemainingRef.current = totalTime;
    runOverRef.current = false;

    setScore(0); setLives(SPRINT_LIVES); setTimeRemaining(totalTime);
    setDangerLevel(0);
    setGridCells([]);
    setEndSummary(null); setFlashes([]);
    setCountdownValue(3);

    if (Capacitor.isNativePlatform()) {
      StatusBar.hide().catch(() => {});
    }

    setPhase('countdown');
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
    setScore(0);
    setEndSummary(null);
    setTimeRemaining(totalTime);
    timeRemainingRef.current = totalTime;
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
    drillName: 'Shade Finder',
    playerName: getPlayerName(),
  } : null, {
    url: APP_SHARE_URL,
    title: 'Shade Finder — SkillDrills',
    text: endSummary ? `Scored ${endSummary.score} on Shade Finder (${endSummary.accuracy}% accuracy, ${endSummary.bestCombo}x combo) — SkillDrills` : '',
  });

  if (loading || !isClient) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-[#050508]">
        <div className="text-center">
          <div className="w-14 h-14 border-4 border-violet-600 border-t-transparent rounded-full animate-spin mx-auto mb-4 shadow-[0_0_20px_rgba(139,92,246,0.5)]" />
          <p className="text-slate-500 font-bold tracking-widest uppercase text-[10px] animate-pulse">Loading Visual Core...</p>
        </div>
      </div>
    );
  }

  return (
    <DrillWrapper
      drillName="Shade Finder"
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
        onContextMenu={(e) => { if (gameActiveRef.current) e.preventDefault(); }}
        className="absolute inset-0 select-none overflow-hidden bg-[#050508] text-white"
        style={{ touchAction: gameActiveRef.current ? 'none' : 'auto', WebkitTapHighlightColor: 'transparent' }}
      >
        <div className="absolute inset-0 pointer-events-none" style={{ backgroundImage: 'linear-gradient(rgba(255,255,255,0.015) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.015) 1px, transparent 1px)', backgroundSize: '40px 40px' }} />

        {phase === 'playing' && dangerLevel > 0.06 && (
          <div className="fx-vignette" style={{ '--v-min': Math.max(0.05, dangerLevel * 0.25), '--v-max': Math.min(0.55, dangerLevel * 0.75), animationDuration: `${heartbeatTempoRef.current}ms` }} />
        )}

        {flashes.map((f) => (
          <div key={f.id} className={`fx-flash ${f.variant === 'cyan' ? 'fx-flash-cyan' : 'fx-flash-red'}`} />
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
          <DrillStartCard
            drillName="Shade Finder"
            tagline="Find the one square that's a shade off"
            rules={[
              'Find the odd square out',
              '45-second sprint · grid grows',
              '5 lives · a wrong tap costs one',
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

        {/* ── PLAYING / COUNTDOWN SCREEN ── */}
        {(phase === 'playing' || phase === 'countdown') && (
          <>
            <div className="absolute top-5 left-5 z-40 flex flex-col gap-2 pointer-events-none select-none">
              <span className="text-2xl font-hud font-bold text-white leading-none tabular-nums">{score}</span>
              {/* Life pips — brand-violet bars, not hearts, to stay inside the
                  one-accent design. Empties dim, don't disappear, so the count
                  reads at a glance. */}
              <div className="flex gap-1">
                {Array.from({ length: SPRINT_LIVES }).map((_, i) => (
                  <span
                    key={i}
                    className={`h-1.5 w-3.5 rounded-full transition-colors ${i < lives ? 'bg-violet-400' : 'bg-white/12'}`}
                  />
                ))}
              </div>
            </div>

            {/* Timer overlay top-right */}
            <div className="absolute top-5 right-5 z-40 flex flex-col items-end pointer-events-none select-none">
              <span className={`text-3xl font-hud font-bold leading-none tabular-nums ${timeRemaining <= 10 ? 'text-red-500 animate-pulse' : 'text-slate-300'}`}>
                {Math.ceil(timeRemaining)}s
              </span>
              <span className="text-[8px] label-tiny text-slate-500 mt-1">Time Left</span>
            </div>

            {/* Playing Grid Container */}
            <div className="relative w-full h-[100dvh] flex flex-col items-center justify-center p-4">
              <div className="w-full max-w-[min(100vw-32px,100vh-220px)] aspect-square bg-[#0c0c16]/70 p-2.5 rounded-[22px] border border-white/5 shadow-2xl flex items-center justify-center">
                {gridCells.length > 0 && (
                  <div
                    className="grid w-full h-full"
                    style={{
                      gridTemplateColumns: `repeat(${gridSize}, 1fr)`,
                      gridTemplateRows: `repeat(${gridSize}, 1fr)`,
                      // Tightens as the board grows. A fixed 4px eats 32px of a
                      // 7x7 board but 36px of a 10x10, so holding it constant
                      // would shrink the cells twice over.
                      gap: gridSize >= 9 ? '2px' : gridSize >= 8 ? '3px' : '4px'
                    }}
                  >
                    {gridCells.map((cell, idx) => (
                      <button
                        key={cell.id}
                        onClick={() => handleCellTap(idx)}
                        style={{ backgroundColor: cell.color }}
                        className="w-full h-full rounded-md transition-transform duration-100 active:scale-[0.93] hover:brightness-[1.03] cursor-pointer focus:outline-none"
                        aria-label={`Grid cell ${idx + 1}`}
                      />
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
            <div className="relative w-28 h-28 rounded-full border-[3px] border-violet-500/20 flex items-center justify-center">
              <div className="absolute -inset-[3px] rounded-full border-[3px] border-transparent border-t-violet-400 border-r-violet-400 animate-spin" style={{ animationDuration: '0.7s' }} />
              <span key={countdownValue} className="fx-pop-in text-5xl font-display bg-gradient-to-b from-white to-violet-300 bg-clip-text text-transparent">
                {countdownValue > 0 ? countdownValue : 'GO'}
              </span>
            </div>
            <span className="text-[10px] text-slate-500">Spot the odd shade at GO</span>
          </div>
        )}

        {/* ── RESULT SCREEN ── */}
        {phase === 'ended' && endSummary && !isChallenge && (
          <ResultScreen
            signature
            summary={endSummary}
            bestScore={bestScore}
            synth={audioSynth}
            extraStats={[{ label: 'Lives Left', value: `${endSummary.livesLeft ?? 0}/${SPRINT_LIVES}` }]}
            onPlayAgain={enterDrill}
            onShare={shareResult}
          />
        )}
      </div>
    </DrillWrapper>
  );
}

