'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  Layers, Volume2, VolumeX,
  RotateCcw, ArrowLeft, Share2, Target, Repeat, Timer
} from 'lucide-react';
import { scoreAction, calcEndBonuses, calcSessionXP, getGrade } from '../../../../../lib/scoringEngine';
import {
  levelForHits, rampMs, rampUp, applyHit, applyMistake, startLevel,
  scoringMaxLevel, scoringLives, stepRelief,
} from '../../../../../lib/drillRules';
import { saveLeaderboardEntrySync } from '../../../../../lib/leaderboard';
import { afterViewportSettled, lockLandscape, unlockOrientation, onOrientationSettled } from '../../../../../lib/orientation';
import { previewDailyCompletion } from '../../../../../lib/dailyChallenge';
import { getPlayerName } from '../../../../../lib/progressStore';
import { Capacitor } from '@capacitor/core';
import { StatusBar } from '@capacitor/status-bar';
import { useShareCard } from '../../../../../components/ShareScoreCard';
import DrillWrapper from '../../../../../components/DrillWrapper';
import { useDuelMatchStart, duelSecondsRemaining } from '../../../../../lib/challengeEngine';
import { hitTestCircle } from '../../../../../lib/canvasFx';
import { APP_SHARE_URL } from '../../../../../lib/shareLinks';

// ============================================================
// TUNING
// ============================================================
const TOTAL_TIME = 45;      // fixed countdown — no add/remove-time gimmick

// How a solo run is won and lost — the clock as the only fail state, what a hit
// earns, what a mistake costs — is defined once in lib/drillRules.js and shared
// by every drill. Read that file for the model and the reasoning.
//
// Drill-local dials below. Each gets its own decay-to-a-ceiling curve rather
// than one shared `progress` fraction: that fraction was normalised against a
// MAX_LEVEL of 15 and, uncapped, would run past 1 — speed would grow without
// limit and spawn rate would go negative, which is a broken drill, not a hard
// one.
const OVERDRIVE_MS = 5000;
const SPEED_START = 3.0;
const SPEED_CEILING = 8.5;
const SPAWN_START_MS = 1000;
const SPAWN_FLOOR_MS = 330;
const COUNTDOWN_TICK_MS = 700;
// The one thing in this drill that cannot arrive by halves: the right lane's
// glyph becoming a DIFFERENT glyph from the left. You either hold one shape in
// mind or you hold two — there is no 1.5. It used to flip on at level 3 with
// every other dial continuing to climb underneath it, which is the "it suddenly
// got much harder" moment players hit at ~80 points.
//
// It still fires at level 3 (predictable, and early enough to be the drill's
// actual skill), but the moment it does, speed and spawn rate hand back
// DIVERGE_RELIEF_LEVELS rungs and climb back over the next few levels — the new
// rule arrives while the board is briefly calmer. See stepRelief in drillRules.
// 10, not 3. This is the drill's one discrete rule and its real skill, so it
// wants to land where the player is settled but the run is still young — not in
// the opening seconds, which is where level 3 falls on a 40-level runway.
const DIVERGE_LEVEL = 10;
const DIVERGE_RELIEF_LEVELS = 2.5;
const SHAPES = ['▲', '●', '■', '★', '◆', '⬣', '❖', '⏣'];

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
    } catch {}
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
    } catch {}
  }
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
    } catch {}
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
    } catch {}
  }

  setEnabled(status) { this.enabled = status; }
}

const audioSynth = typeof window !== 'undefined' ? new AudioSynthesizer() : null;

// ============================================================
// LOCAL BEST-STATS STORAGE (instant sync display on start card)
// ============================================================
const STORAGE_KEY = 'skilldrills_multi_tasking_v1';

const getSavedData = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { bestScore: 0, bestCombo: 0, bestLevel: 1, totalSessions: 0, totalOverdrives: 0 };
    return { bestScore: 0, bestCombo: 0, bestLevel: 1, totalSessions: 0, totalOverdrives: 0, ...JSON.parse(raw) };
  } catch {
    return { bestScore: 0, bestCombo: 0, bestLevel: 1, totalSessions: 0, totalOverdrives: 0 };
  }
};

const saveData = (data) => {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch {}
};

const isMobileUA = () => {
  if (typeof window === 'undefined') return false;
  const ua = navigator.userAgent || '';
  return /Mobi|Android|iPhone|iPad|iPod/i.test(ua) || window.innerWidth < 768;
};

const isPortraitNow = () => typeof window !== 'undefined' && window.innerHeight > window.innerWidth;

// ============================================================
// MAIN COMPONENT
// ============================================================
export default function MultiTaskingClient() {
  const searchParams = useSearchParams();
  const challengeId = searchParams ? searchParams.get('challengeId') : null;
  const isChallenge = !!challengeId;
  const totalTime = isChallenge ? 30 : TOTAL_TIME;
  const matchStartAt = useDuelMatchStart(challengeId);

  const [isClient, setIsClient] = useState(false);
  const [loading, setLoading] = useState(true);
  const [soundEnabled, setSoundEnabled] = useState(true);

  const [phase, setPhase] = useState('start'); // 'start' | 'countdown' | 'playing' | 'rotate-hint' | 'ended'
  // True from the instant START is tapped until the drill actually leaves the
  // start phase. Tapping START kicks off a fullscreen request, a status-bar
  // change, an await on the native landscape lock and then a settle timeout —
  // several hundred ms during which `phase` is still 'start', so the start
  // card stayed mounted and the user watched it get rotated into landscape
  // before the countdown replaced it. This unmounts it on the tap itself.
  const [launching, setLaunching] = useState(false);
  const [countdownValue, setCountdownValue] = useState(3);

  // Local best-stats (start card)
  const [bestScore, setBestScore] = useState(0);
  const [bestCombo, setBestCombo] = useState(0);
  const [bestLevel, setBestLevel] = useState(1);

  // Live HUD state
  const [score, setScore] = useState(0);
  // The live "Lv." HUD badge was the only thing that ever READ this, so the
  // React state went with it. The ramp itself runs off levelRef, which the
  // game loop already uses; keeping a useState in step with it only bought a
  // re-render of the whole drill on every level-up, mid-play, for nothing.
  const [timeRemaining, setTimeRemaining] = useState(totalTime);
  const [dangerLevel, setDangerLevel] = useState(0);

  // Lanes & targets
  const [leftTarget, setLeftTarget] = useState('▲');
  const [rightTarget, setRightTarget] = useState('▲');

  const [flashes, setFlashes] = useState([]);
  const [bursts, setBursts] = useState([]);
  const [endSummary, setEndSummary] = useState(null);

  const mountedRef = useRef(false);
  const containerRef = useRef(null);
  const gameActiveRef = useRef(false);
  const duelAutoStartedRef = useRef(false);
  // The duel's shared start instant, on this device's clock. Held in a ref so
  // the match clock can read it without rebuilding its interval, and null
  // outside a duel so solo play keeps its own local countdown.
  const duelDeadlineRef = useRef(null);
  useEffect(() => {
    duelDeadlineRef.current = isChallenge ? matchStartAt : null;
  }, [isChallenge, matchStartAt]);
  const isActiveRef = gameActiveRef;

  // The flying shapes have been through three designs. First: one DOM element
  // per shape, each with its OWN requestAnimationFrame loop writing inline
  // styles — N main-thread loops, the single biggest CPU cost in the app.
  // Then: one shared canvas and one draw loop (ARENA_CANVAS_PERFORMANCE_PLAN.md),
  // which fixed the N-loops problem but still moved every shape by hand on the
  // main thread, so any hitch elsewhere in the app landed on their position —
  // and it was capped at 30fps besides.
  //
  // Now: one DOM element per shape again, but with NO loop of any kind. Each
  // shape's whole flight is a single compositor animation (see mountShape), so
  // the main thread does nothing at all while a shape crosses the screen. Same
  // pattern that made moving-target and visual-tracking-speed-test smooth.
  const playFieldRef = useRef(null);
  const shapesRef = useRef([]);
  const shapeIdCounterRef = useRef(0);

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
  const runOverRef = useRef(false);

  // Difficulty scaling refs
  const speedRef = useRef(3.0);
  const spawnRateRef = useRef(1000);
  const isDifferentTargetsRef = useRef(false);
  // Level the second glyph appeared at, or null. Drives the dial relief above.
  const divergeLevelRef = useRef(null);

  const leftTargetRef = useRef('▲');
  const rightTargetRef = useRef('▲');
  const heartbeatTempoRef = useRef(1100);

  const leftSpawnTimerRef = useRef(null);
  const rightSpawnTimerRef = useRef(null);
  const targetChangeIntervalRef = useRef(null);
  const timerIntervalRef = useRef(null);
  const heartbeatTimerRef = useRef(null);
  const overdriveTimeoutRef = useRef(null);
  const countdownTimerRef = useRef(null);

  // ── Mount / cleanup ───────────────────────────────────────────────────────
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
      [leftSpawnTimerRef, rightSpawnTimerRef, targetChangeIntervalRef, heartbeatTimerRef, overdriveTimeoutRef, countdownTimerRef].forEach((r) => { if (r.current) clearTimeout(r.current); });
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
      clearShapesRef.current?.();
      try { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); } catch {}
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
    // Self-heal: if the device is ALREADY landscape, no further resize or
    // orientationchange event will ever fire, so the listener below can never
    // rescue this screen. That is reachable — the pre-countdown orientation check
    // used to run on a blind timer and could read a mid-rotation viewport as
    // portrait, leaving the drill parked on "Rotate your phone to play" with no
    // way back. Re-check once against settled dimensions.
    const cancelSettle = afterViewportSettled(check); // this effect only runs in rotate-hint
    const stopListening = onOrientationSettled(check);
    return () => { cancelSettle(); stopListening(); };
  }, [phase]);

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

  // Score release: the "+N" earned on a correct tap rises and fades from the
  // exact spot the shape was hit (x/y in the same 0-100 percentage space as
  // spawnBurst). Its own compositor animation, removed when it finishes —
  // there is no render loop left in this drill to draw it on.
  const spawnScorePopup = useCallback((x, y, text, color = '#4ade80') => {
    const field = playFieldRef.current;
    if (!field) return;
    const el = document.createElement('div');
    el.textContent = text;
    el.style.cssText = `position:absolute;left:${x}%;top:${y}%;z-index:30;pointer-events:none;will-change:transform,opacity;font:bold 15px monospace;color:${color};transform:translate(-50%,-50%);`;
    field.appendChild(el);
    const anim = el.animate(
      [{ transform: 'translate(-50%,-50%) translateY(0)', opacity: 1 },
       { transform: 'translate(-50%,-50%) translateY(-38px)', opacity: 0 }],
      { duration: 1000, easing: 'linear', fill: 'both' }
    );
    anim.onfinish = () => { if (el.parentNode) el.parentNode.removeChild(el); };
  }, []);

  // ── Shape layer ────────────────────────────────────────────────────────────
  // Each shape is a DOM element whose ENTIRE flight is handed to the
  // compositor as one animation, exactly like the moving-target and
  // visual-tracking drills. There is no render loop here any more.
  //
  // This is NOT a return to the original design this drill replaced. That one
  // gave every shape its own requestAnimationFrame loop writing inline styles
  // 60 times a second — N main-thread loops fighting each other. What follows
  // creates each element once, hands the compositor a straight line from A to
  // B, and never touches it again: the main thread does no work at all while a
  // shape crosses the screen, so nothing the game does elsewhere (React
  // re-rendering the HUD, the audio scheduler, a GC pause) can land on the
  // shape's position and make it stutter. A shape travels a straight line at
  // constant speed, which is precisely the case the compositor can own end to
  // end. Only ~3 shapes are ever in flight at once (duration/spawn rate), so
  // this is 3 elements, not a crowd.
  // Both are read from callbacks declared ABOVE these definitions (the unmount
  // cleanup, endGame, enterDrill), so they go through refs rather than being
  // called directly — a direct call would be a temporal-dead-zone reference.
  const resolveWrongRef = useRef(null);
  const clearShapesRef = useRef(null);

  const removeShape = useCallback((s) => {
    if (s.anim) { s.anim.onfinish = null; try { s.anim.cancel(); } catch {} s.anim = null; }
    if (s.el && s.el.parentNode) s.el.parentNode.removeChild(s.el);
    s.el = null; s.glyphEl = null;
    const arr = shapesRef.current;
    const i = arr.indexOf(s);
    if (i !== -1) arr.splice(i, 1);
  }, []);

  const clearShapes = useCallback(() => {
    shapesRef.current.slice().forEach((s) => removeShape(s));
    shapesRef.current = [];
  }, [removeShape]);

  // Returns false if there is nowhere to mount it yet. The caller must then
  // drop the shape rather than keep it in the array: a shape with no animation
  // has nothing to expire it, so it would sit in the hit-test list forever.
  const mountShape = useCallback((s) => {
    const field = playFieldRef.current;
    if (!field) return false;
    const w = field.clientWidth;
    const h = field.clientHeight;
    if (w <= 0 || h <= 0) return false;

    const el = document.createElement('div');
    el.style.cssText = 'position:absolute;left:0;top:0;z-index:10;pointer-events:none;will-change:transform;';
    const glyph = document.createElement('span');
    glyph.textContent = s.glyph;
    // Matches what the canvas drew: #d1d5db, sans-serif at the shape's own
    // size, centred on the point the tap hit-test solves for.
    glyph.style.cssText = `position:absolute;left:0;top:0;display:block;line-height:1;font-family:sans-serif;font-size:${s.fontSize}px;color:#d1d5db;transform:translate(-50%,-50%);`;
    el.appendChild(glyph);
    field.appendChild(el);

    s.el = el;
    s.glyphEl = glyph;
    s.anim = el.animate(
      [{ transform: `translate3d(${(s.startX / 100) * w}px, ${(s.y / 100) * h}px, 0)` },
       { transform: `translate3d(${(s.endX / 100) * w}px, ${(s.y / 100) * h}px, 0)` }],
      { duration: s.duration, easing: 'linear', fill: 'both' }
    );
    // onfinish IS the expiry — no loop is watching the clock for it.
    s.anim.onfinish = () => {
      if (!s.hitState && s.isTarget) resolveWrongRef.current?.('missed', null);
      removeShape(s);
    };
    return true;
  }, [removeShape]);

  // ── Difficulty scaling ────────────────────────────────────────────────────
  // Speed and spawn rate from one level. Called by updateDifficulty and again
  // at run start, so the first shapes use the right pacing instead of level-1
  // pacing while the HUD already shows a higher level.
  const applyLevelDials = useCallback((level) => {
    // Effective level, not the raw one: once the second glyph is in play this
    // sits below `level` and eases back up, so the two-target step doesn't land
    // on top of a speed step.
    const eff = stepRelief(level, divergeLevelRef.current, DIVERGE_RELIEF_LEVELS);
    speedRef.current = rampUp(eff, SPEED_START, SPEED_CEILING);
    spawnRateRef.current = rampMs(eff, SPAWN_START_MS, SPAWN_FLOOR_MS);
  }, []);

  const updateDifficulty = useCallback(() => {
    // Difficulty ramps with SCORE for everyone, duels included: speed, spawn
    // rate, and target divergence all escalate the more you score, so a
    // stronger duelist faces a harder board. Score still decides the winner
    // and thus the EIQ swing.
    const newLevel = levelForHits(correctActionsRef.current);
    if (newLevel > levelRef.current) {
      levelRef.current = newLevel;

      bestLevelRunRef.current = Math.max(bestLevelRunRef.current, newLevel);
    }
    // All difficulty is driven off levelRef.current (the ratcheted level),
    // never the raw current score — so an Arena −5 penalty that momentarily
    // dips the score can NEVER walk speed/spawn/divergence back down. Once
    // target divergence turns on at level 3 it stays on for the rest of the run.
    applyLevelDials(levelRef.current);

    if (levelRef.current >= DIVERGE_LEVEL && !isDifferentTargetsRef.current) {
      isDifferentTargetsRef.current = true;
      divergeLevelRef.current = levelRef.current;
      // Re-seed the dials so the relief applies from this instant rather than
      // from the next level-up — otherwise the spike still lands, just once.
      applyLevelDials(levelRef.current);
      setRandomTargets(true);
    }
  }, [applyLevelDials]);

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

  // `keepLeft` re-rolls ONLY the right lane. Used when target divergence turns
  // on mid-run: that moment is already a real difficulty step (two glyphs to
  // hold instead of one), and re-rolling both lanes on top of it made it a
  // double one — every shape already in flight on the left silently stopped
  // being a target, so the player's next few taps were wrong through no fault
  // of their own. Keeping the left glyph means exactly one new thing to learn.
  const setRandomTargets = useCallback((keepLeft = false) => {
    const shuffled = [...SHAPES].sort(() => 0.5 - Math.random());
    const newLeft = keepLeft ? leftTargetRef.current : shuffled[0];
    const newRight = isDifferentTargetsRef.current
      ? (shuffled.find((g) => g !== newLeft) || shuffled[1])
      : newLeft;

    leftTargetRef.current = newLeft;
    rightTargetRef.current = newRight;
    setLeftTarget(newLeft);
    setRightTarget(newRight);
  }, []);

  // ── Scoring resolution ────────────────────────────────────────────────────
  const resolveCorrect = useCallback((kind, pos) => {
    if (!gameActiveRef.current) return;
    const comboBefore = comboRef.current;
    const pts = scoreAction({
      category: 'cognitive',
      combo: comboBefore,
      reactionMs: null, // shapes flow continuously, so reactionMs is not applicable
      timeRemaining: timeRemainingRef.current,
      totalGameTime: totalTime,
      livesRemaining: scoringLives(0),
      level: levelRef.current,
      maxLevel: scoringMaxLevel(isChallenge),
    });
    let total = pts.total;
    
    if (overdriveActiveRef.current) {
      total = Math.round(total * 1.75);
    }

    scoreRef.current += total;
    // Buy back a slice of the clock. Solo only - in a duel the clock comes from
    // duelDeadlineRef (the match's shared absolute end instant), which nothing
    // local may move. No state is set here; the existing tick redraws the
    // seconds when the displayed number changes, so this costs nothing per hit.
    if (!isChallenge) {
      timeRemainingRef.current = applyHit({ timeRemaining: timeRemainingRef.current, level: levelRef.current, hits: correctActionsRef.current });
    }
    comboRef.current = comboBefore + 1;
    bestComboRef.current = Math.max(bestComboRef.current, comboRef.current);
    correctActionsRef.current += 1;
    totalActionsRef.current += 1;

    fillOverdrive(14);

    if (pos) {
      spawnBurst(pos.x, pos.y, 'cyan');
      spawnScorePopup(pos.x, pos.y, `+${total}`);
    }

    // Every correct tap shares this one hit sound now — no separate combo
    // chime. The "COMBO" text is the only thing that still calls out a
    // milestone; nothing else gets its own sound.
    audioSynth?.playPulseHit();

    setScore(scoreRef.current);
    updateDifficulty();
  }, [fillOverdrive, spawnBurst, spawnScorePopup, updateDifficulty]);

  const endGameRef = useRef(null);

  const resolveWrong = useCallback((kind, pos) => {
    if (!gameActiveRef.current) return;
    comboRef.current = 0;
    mistakesRef.current += 1;
    totalActionsRef.current += 1;

    // Arena has no lives, so a mistake costs score (−5, floored at 0) — that
    // penalty keeps careless play from winning and flows into your EIQ. Solo
    // loses a life instead (floored at 0 so a negative count can't feed the
    // heartbeat's danger formula unbounded). The score drop never lowers
    // difficulty — updateDifficulty only ratchets the level UP.
    if (isChallenge) {
      scoreRef.current = Math.max(0, scoreRef.current - 5);
    } else {
      const after = applyMistake({ timeRemaining: timeRemainingRef.current });
      timeRemainingRef.current = after.timeRemaining;
      runOverRef.current = after.runOver;
      setTimeRemaining(Math.ceil(timeRemainingRef.current));
    }

    triggerFlash('red');
    audioSynth?.playPenalty();

    if (pos) spawnBurst(pos.x, pos.y, 'red');

    setScore(scoreRef.current);

    // Solo: game over on empty lives. Duels always run the full clock.
    if (!isChallenge && runOverRef.current) endGameRef.current?.('lives');
  }, [triggerFlash, spawnBurst, isChallenge]);

  // ── Game over ──────────────────────────────────────────────────────────────
  // No `reason` argument — running out of time is the only way a solo run can
  // end now, so there is nothing left to distinguish.
  const endGame = useCallback(async () => {
    if (!gameActiveRef.current) return;
    gameActiveRef.current = false;

    [leftSpawnTimerRef, rightSpawnTimerRef, targetChangeIntervalRef, heartbeatTimerRef, overdriveTimeoutRef].forEach((r) => { if (r.current) { clearTimeout(r.current); r.current = null; } });
    if (timerIntervalRef.current) { clearInterval(timerIntervalRef.current); timerIntervalRef.current = null; }

    // Removes the elements too, not just the array — each shape owns a live
    // DOM node and a running compositor animation now.
    clearShapesRef.current?.();

    audioSynth?.playResultsReveal();
    // StatusBar deliberately not reverted here — the result screen still
    // renders inside the same fullscreen, landscape-locked container as
    // gameplay. Reverting now would force a resize/shake right as results
    // appear; it's restored in the mount-effect cleanup instead, alongside
    // exitFullscreen()/unlockOrientation(), which are already deferred to
    // actually leaving the drill.
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
      livesRemaining: scoringLives(0),
      category: 'cognitive',
    });
    const finalScore = bonuses.finalScore;
    const grade = getGrade(accuracy);

    const prevSaved = getSavedData();
    const isNewBest = finalScore > prevSaved.bestScore;
    const firstPlay = prevSaved.totalSessions === 0;
    const daily = isChallenge
      ? { isDailyDrill: false, wouldCompleteSet: false }
      : await previewDailyCompletion('multi-tasking');
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
      drillId: 'multi-tasking',
      drillName: 'Multi-Tasking',
      category: 'cognitive',
      score: finalScore,
      accuracy,
      bestCombo: bestComboRef.current,
    });

    setEndSummary({
      score: finalScore,
      accuracy,
      bestCombo: bestComboRef.current,
      level: bestLevelRunRef.current,
      isNewBest,
      grade,
      xpEarned: xpResult.xp,
      prevBest: prevSaved.bestScore,
    });
    setPhase('ended');
  }, [triggerFlash]);

  useEffect(() => { endGameRef.current = endGame; }, [endGame]);

  // ── Shape Spawn Loop ─────────────────────────────────────────────────────
  // Pushes shape data into the shared shapesRef array — the canvas resize/
  // draw effect below is what actually moves, hit-expires, and draws them,
  // on one shared loop instead of one rAF per shape. Positions are stored in
  // 0-100 percentage space (not pixels) so spawning never has to know the
  // canvas's actual pixel size — only the draw loop needs that, and it reads
  // it fresh every frame.
  const createShape = useCallback((side) => {
    if (!isActiveRef.current) return;
    const targetGlyph = side === 'left' ? leftTargetRef.current : rightTargetRef.current;

    const isMobile = window.innerWidth < 768;
    // This drill is landscape-locked (lockLandscape()), so "mobile" always
    // means landscape mobile in practice — the old isLandscape ? 24 : 35.2
    // split made shapes *smaller* in the orientation the drill actually
    // runs in than in the portrait fallback that's barely ever shown,
    // which is why they read as too-small-to-see-comfortably.
    const fontSize = isMobile ? 31.7 : 46.1; // ~10% smaller than the 2.2rem/3.2rem base, for extra room to move

    const isTarget = Math.random() < 0.35;
    let glyph = isTarget ? targetGlyph : SHAPES[Math.floor(Math.random() * SHAPES.length)];
    if (!isTarget && glyph === targetGlyph) glyph = SHAPES.find((s) => s !== targetGlyph) || '■';

    // Both lanes flow outward from the center divider (50%) to their own
    // far edge, mirroring the original's per-lane pixel offsets.
    const startX = side === 'left' ? 50 : 42;
    const endX = side === 'left' ? -8 : 108;
    const y = 18 + Math.random() * 68; // keeps clear of the HUD/combo zones

    const shape = {
      id: ++shapeIdCounterRef.current,
      side, glyph, isTarget, fontSize,
      startX, endX, y,
      spawnedAt: performance.now(),
      duration: 4000 / speedRef.current,
      hitState: null, // null | 'correct' | 'wrong'
      hitAt: null,
      el: null, glyphEl: null, anim: null,
    };
    if (!mountShape(shape)) return;
    shapesRef.current.push(shape);
  }, [mountShape]);

  // ONE timer alternating lanes, rather than a timer per lane.
  //
  // The two lanes used to run independent timeouts on the same interval,
  // offset by a fixed 300ms at run start. That offset is in milliseconds but
  // the interval shrinks as the level climbs, so the lanes drift: 300ms is a
  // third of a period at level 1 and most of a period by the time the rate is
  // near its floor. Whenever they drifted into phase the board got two shapes
  // in the same instant and then a long empty gap — the same average rate
  // arriving in clumps. That is what read as the drill "suddenly getting much
  // faster" a few levels in, and it had nothing to do with the speed dial.
  //
  // Alternating one timer at half the interval spawns exactly as many shapes
  // per second as before (2 / spawnRate) and can never bunch them, because the
  // gap between consecutive shapes is always half of the CURRENT interval —
  // it re-reads the rate on every tick, so a level-up retimes both lanes
  // together instead of nudging one of them out of phase.
  const nextSpawnSideRef = useRef('left');

  const scheduleSpawn = useCallback(() => {
    if (!isActiveRef.current) return;
    const side = nextSpawnSideRef.current;
    nextSpawnSideRef.current = side === 'left' ? 'right' : 'left';
    createShape(side);
    leftSpawnTimerRef.current = setTimeout(scheduleSpawn, spawnRateRef.current / 2);
  }, [createShape]);

  // ── Heartbeat / danger tempo ──────────────────────────────────────────────
  const scheduleHeartbeat = useCallback(() => {
    // Duels have NO heartbeat audio and NO danger vignette at all — the
    // match must feel and perform exactly like solo play minus the extras
    // (and the unclamped version of this loop was the "phone heating
    // rapidly + making noise" bug: danger > 1.7 from negative lives made
    // the tempo negative, turning this self-rescheduling callback into a
    // tight infinite loop spawning audio nodes at full CPU speed).
    if (isChallenge) return;
    if (!gameActiveRef.current) return;
    const dangerFromLives = 0;   // lives are gone; time is the only danger now
    const dangerFromTime = timeRemainingRef.current <= 10 ? (10 - timeRemainingRef.current) / 10 : 0;
    const danger = Math.min(1, Math.max(dangerFromLives * 0.7, dangerFromTime));
    const tempo = Math.max(350, Math.round(1100 - danger * 650));
    heartbeatTempoRef.current = tempo;
    if (danger > 0.08) audioSynth?.playHeartbeat(danger);
    // Audio follows `danger` exactly; the VIGNETTE only follows it in tenths.
    // Its custom properties and animation-duration both derive from this, and
    // changing either on a running CSS animation restarts it on the main
    // thread — dropping it off the compositor — so a fresh float on every
    // heartbeat (up to 3x a second) was the worst possible time to do it.
    const bucket = Math.round(danger * 10) / 10;
    if (mountedRef.current) setDangerLevel((d) => (d === bucket ? d : bucket));
    heartbeatTimerRef.current = setTimeout(scheduleHeartbeat, tempo);
  }, [isChallenge]);

  // ── Begin actual play ─────────────────────────────────────────────────────
  const beginPlaying = useCallback(() => {
    if (!mountedRef.current) return;
    gameActiveRef.current = true;
    setPhase('playing');

    // 200ms rather than 100ms — the displayed clock only shows whole seconds,
    // so 5 ticks/sec looks identical to 10 while halving how often this
    // re-renders the whole play field for the entire match.
    timerIntervalRef.current = setInterval(() => {
      if (!gameActiveRef.current) { clearInterval(timerIntervalRef.current); return; }
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
        // Only when the DISPLAYED whole second changes — the clock reads to the
        // second and the timer bar animates itself in CSS, so the other four
        // ticks each second were re-rendering the entire play field to paint an
        // identical picture. The ref keeps full precision for scoring maths.
        setTimeRemaining((prev) => (
          Math.ceil(prev) === Math.ceil(timeRemainingRef.current) ? prev : timeRemainingRef.current
        ));
      }
    }, 200);

    scheduleHeartbeat();
    setRandomTargets();

    nextSpawnSideRef.current = 'left';
    scheduleSpawn();

    // Scramble targets every 25 seconds
    targetChangeIntervalRef.current = setInterval(() => {
      if (isActiveRef.current) {
        setRandomTargets();
      }
    }, 25000);
  }, [scheduleHeartbeat, scheduleSpawn, setRandomTargets, isChallenge, updateDifficulty]);

  // ── 3-2-1-GO countdown ────────────────────────────────────────────────────
  const runCountdown = useCallback((n) => {
    if (countdownTimerRef.current) clearTimeout(countdownTimerRef.current);
    if (!mountedRef.current) return;
    setPhase('countdown');
    if (n <= 0) {
      setCountdownValue('GO');
      // Duels skip the visible 3-2-1 AND its audio — DrillWrapper renders the
      // shared countdown, so a local "GO" here fired after that one had
      // already finished (ARENA_INTEGRATION.md rule 2). Every other duel
      // drill guards these two calls; this one didn't.
      if (!isChallenge) audioSynth?.playGo();
      countdownTimerRef.current = setTimeout(() => beginPlaying(), 350);
      return;
    }
    setCountdownValue(n);
    if (!isChallenge) audioSynth?.playCountdownTick();
    countdownTimerRef.current = setTimeout(() => runCountdown(n - 1), COUNTDOWN_TICK_MS);
  }, [beginPlaying, isChallenge]);

  const runCountdownRef = useRef(null);
  useEffect(() => { runCountdownRef.current = runCountdown; }, [runCountdown]);

  // ── Entry point ───────────────────────────────────────────────────────────
  const enterDrill = useCallback(async () => {
    // Unmount the start card on the tap itself, before the rotation begins.
    setLaunching(true);
    try { audioSynth?.init(); } catch {}

    gameActiveRef.current = false;
    [leftSpawnTimerRef, rightSpawnTimerRef, targetChangeIntervalRef, heartbeatTimerRef, overdriveTimeoutRef, countdownTimerRef].forEach((r) => { if (r.current) { clearTimeout(r.current); r.current = null; } });
    if (timerIntervalRef.current) { clearInterval(timerIntervalRef.current); timerIntervalRef.current = null; }

    clearShapesRef.current?.();

    // Returning players start closer to their proven skill level instead of
    // always grinding through level 1 again — ~55% of their best level reached.
    // First-time players (no saved bestLevel) still start at level 1.
    //
    // Duels always start BOTH players at the same, lowest difficulty — no
    // personal-best seeding — so the two scores are comparable and the match
    // is pure skill (ARENA_INTEGRATION.md rule 5 / matchmaking fairness).
    // Without this a veteran opened the duel at level 8 with shapes flying at
    // near-max speed while their opponent got level 1, which is a different
    // game, not a fair race.
    // Every run starts at the lowest difficulty. It used to start at 55% of the
    // player's best level, so improving once permanently raised the speed every
    // future run opened at - a silent spike with nothing on screen explaining it.
    // That head-start only existed because a fixed 45s was too short to climb the
    // ramp; the endurance clock replaces it.
    const runStartLevel = isChallenge ? 1 : startLevel(bestLevel);

    scoreRef.current = 0; comboRef.current = 0; bestComboRef.current = 0;
    levelRef.current = runStartLevel; bestLevelRunRef.current = runStartLevel; mistakesRef.current = 0; correctActionsRef.current = 0; totalActionsRef.current = 0;
    overdriveMeterRef.current = 0; overdriveActiveRef.current = false; overdriveCountRef.current = 0;
    timeRemainingRef.current = totalTime;
    runOverRef.current = false;
    isDifferentTargetsRef.current = false;
    divergeLevelRef.current = null;
    isActiveRef.current = true;

    // Seed speed/spawn-rate from the starting level using the same curve as
    // updateDifficulty() (which only re-derives these after a correct hit,
    // not on every spawn) — otherwise the first shapes spawned this run
    // would use level-1 pacing while the HUD already shows a higher level.
    applyLevelDials(runStartLevel);

    setScore(0); setTimeRemaining(totalTime);
    setDangerLevel(0);
    setEndSummary(null); setFlashes([]); setBursts([]);

    if (!isChallenge && !document.fullscreenElement && containerRef.current) {
      try { await containerRef.current.requestFullscreen(); } catch {}
    }
    if (Capacitor.isNativePlatform()) {
      // overlaysWebView:true keeps the window's layout size stable regardless
      // of status-bar visibility, so a swipe-reveal from the top edge draws
      // the bar as an overlay instead of resizing the WebView and shoving
      // this fullscreen board down the screen.
      StatusBar.setOverlaysWebView({ overlay: true }).catch(() => {});
      StatusBar.hide().catch(() => {});
    }

    try { await lockLandscape(); } catch {}

    // Wait for the viewport to actually stop moving before showing the countdown,
    // instead of guessing with a fixed delay — see afterViewportSettled in
    // lib/orientation.js. A blind timeout let the "3" mount mid-resize and jump.
    afterViewportSettled(() => {
      if (!mountedRef.current) return;
      if (isMobileUA() && isPortraitNow()) {
        setPhase('rotate-hint');
      } else {
        runCountdown(isChallenge ? 0 : 3);
      }
    });
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

  // ── Shape layer lifecycle ─────────────────────────────────────────────────
  // No draw loop. Each shape animates itself on the compositor (see
  // mountShape), so all this effect has to do is keep those animations honest
  // across the two things that can invalidate them, and clean up afterwards.
  useEffect(() => {
    if (phase !== 'playing' && phase !== 'countdown') return;

    // 1. Resize / rotate. The keyframes are in pixels, resolved from the field's
    //    size at spawn time, so a size change mid-flight would leave a shape
    //    travelling to the wrong place. Re-issue each live animation against the
    //    new size and restore where it had got to.
    const rebuild = () => {
      const field = playFieldRef.current;
      if (!field) return;
      const w = field.clientWidth;
      const h = field.clientHeight;
      if (w <= 0 || h <= 0) return;
      shapesRef.current.forEach((s) => {
        if (!s.el || !s.anim) return;
        const at = s.anim.currentTime || 0;
        s.anim.onfinish = null;
        try { s.anim.cancel(); } catch {}
        s.anim = s.el.animate(
          [{ transform: `translate3d(${(s.startX / 100) * w}px, ${(s.y / 100) * h}px, 0)` },
           { transform: `translate3d(${(s.endX / 100) * w}px, ${(s.y / 100) * h}px, 0)` }],
          { duration: s.duration, easing: 'linear', fill: 'both' }
        );
        s.anim.currentTime = at;
        s.anim.onfinish = () => {
          if (!s.hitState && s.isTarget) resolveWrongRef.current?.('missed', null);
          removeShape(s);
        };
      });
    };

    const ro = new ResizeObserver(rebuild);
    if (playFieldRef.current) ro.observe(playFieldRef.current);
    window.addEventListener('resize', rebuild);
    window.addEventListener('orientationchange', rebuild);

    // 2. Backgrounding. Web Animations keep running while the app is hidden
    //    (requestAnimationFrame does not), so without this a phone call or a
    //    notification would cost the player every target that crossed the
    //    screen unseen.
    const onVisibility = () => {
      const hidden = document.visibilityState !== 'visible';
      shapesRef.current.forEach((s) => {
        if (!s.anim) return;
        try { hidden ? s.anim.pause() : s.anim.play(); } catch {}
      });
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      ro.disconnect();
      window.removeEventListener('resize', rebuild);
      window.removeEventListener('orientationchange', rebuild);
      document.removeEventListener('visibilitychange', onVisibility);
      clearShapesRef.current?.();
    };
  }, [phase, removeShape]);

  // Keeps the two ref-held callbacks current for the code above that has to
  // reach them through a ref (see resolveWrongRef / clearShapesRef).
  useEffect(() => {
    resolveWrongRef.current = resolveWrong;
    clearShapesRef.current = clearShapes;
  });

  // Single tap handler for the whole play field, replacing the old per-shape
  // el.onpointerdown. Hit-tests the tap (in the field's own pixel space)
  // against whichever shapes are currently live and unresolved, closest-
  // spawned-last (drawn on top) first, then resolves exactly as before —
  // only how resolution gets triggered has changed.
  const handlePlayFieldPointerDown = useCallback((e) => {
    if (!gameActiveRef.current || phase !== 'playing') return;
    const rect = playFieldRef.current?.getBoundingClientRect();
    if (!rect) return;
    const tapX = e.clientX - rect.left;
    const tapY = e.clientY - rect.top;
    const now = performance.now();

    const shapes = shapesRef.current;
    for (let i = shapes.length - 1; i >= 0; i--) {
      const s = shapes[i];
      if (s.hitState) continue;
      // Solve the position from the ANIMATION's own clock, not from
      // performance.now() - spawnedAt. The compositor is the thing actually
      // drawing the shape, and its clock pauses when the app is backgrounded
      // (see the visibilitychange handler) — so elapsed wall time would put
      // the hit circle somewhere the player can't see the shape.
      const at = s.anim ? (s.anim.currentTime || 0) : (now - s.spawnedAt);
      const progress = Math.min(1, at / s.duration);
      const xPct = s.startX + (s.endX - s.startX) * progress;
      const curX = (xPct / 100) * rect.width;
      const curY = (s.y / 100) * rect.height;
      const hitR = s.fontSize * 0.65;
      if (hitTestCircle(tapX, tapY, curX, curY, hitR)) {
        const isCorrect = s.glyph === (s.side === 'left' ? leftTargetRef.current : rightTargetRef.current);
        s.hitState = isCorrect ? 'correct' : 'wrong';
        s.hitAt = now;

        // Hit flash — the same 150ms colour/glow/scale the canvas used to
        // paint, as styles on the element. The scale rides on the glyph's own
        // transform, never the parent's: the parent's transform belongs to the
        // flight animation and writing to it would fight the compositor.
        if (s.glyphEl) {
          s.glyphEl.style.color = isCorrect ? '#60a5fa' : '#ef4444';
          s.glyphEl.style.textShadow = isCorrect ? '0 0 20px #60a5fa' : '0 0 10px #ef4444';
          if (isCorrect) s.glyphEl.style.transform = 'translate(-50%,-50%) scale(1.2)';
        }
        setTimeout(() => removeShape(s), 150);

        const burstPos = { x: xPct, y: s.y };
        if (isCorrect) resolveCorrect('hit', burstPos);
        else resolveWrong('wrong_shape', burstPos);
        break;
      }
    }
  }, [phase, resolveCorrect, resolveWrong, removeShape]);

  // Score card. Drawn and encoded while the result screen sits idle,
  // not on the tap - see useShareCard in components/ShareScoreCard.js.
  const shareResult = useShareCard(endSummary ? {
    score: endSummary.score,
    bestScore: endSummary.prevBest ?? bestScore,
    accuracy: endSummary.accuracy,
    bestCombo: endSummary.bestCombo,
    rating: endSummary.grade,
    newBest: endSummary.isNewBest,
    drillName: 'Multi-Tasking',
    playerName: getPlayerName(),
  } : null, {
    url: APP_SHARE_URL,
    title: 'Multi-Tasking — SkillDrills',
    text: endSummary ? `🧠 Scored ${endSummary.score} pts on Multi-Tasking — ${endSummary.accuracy}% accuracy, Grade ${endSummary.grade.grade}. Get SkillDrills:` : '',
  });

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

  const showBoard = phase === 'playing' || phase === 'countdown';

  return (
    <DrillWrapper
      drillName="Multi-Tasking"
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
        {/* ambient grid */}
        <div className="absolute inset-0 pointer-events-none" style={{ backgroundImage: 'linear-gradient(rgba(255,255,255,0.015) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.015) 1px, transparent 1px)', backgroundSize: '40px 40px' }} />

        {/* danger vignette */}
        {phase === 'playing' && dangerLevel > 0.06 && (
          <div className="fx-vignette" style={{ '--v-min': Math.max(0.05, dangerLevel * 0.25), '--v-max': Math.min(0.55, dangerLevel * 0.75), animationDuration: `${Math.max(350, Math.round(1100 - dangerLevel * 650))}ms` }} />
        )}

        {/* flashes */}
        {flashes.map((f) => (
          <div key={f.id} className={`fx-flash ${f.variant === 'gold' ? 'fx-flash-gold' : f.variant === 'cyan' ? 'fx-flash-cyan' : 'fx-flash-red'}`} />
        ))}

        {/* ── ROTATE HINT ── */}
        {phase === 'rotate-hint' && !isChallenge && (
          <div className="absolute inset-0 z-[100] flex flex-col items-center justify-center bg-black/95 text-center p-6 backdrop-blur-sm">
            <div className="animate-bounce mb-5 text-violet-500"><RotateCcw className="w-14 h-14 mx-auto" /></div>
            <h3 className="text-lg font-bold text-white mb-2">Rotate to play</h3>
            <p className="text-xs text-gray-400 max-w-xs mx-auto">This drill runs in landscape. Turn your device — it'll continue on its own.</p>
          </div>
        )}

        {/* ── START SCREEN ── */}
        {phase === 'start' && !launching && !isChallenge && (
          <div className="relative h-full flex items-center justify-center p-5 overflow-y-auto">
            <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(ellipse 420px 260px at 50% 8%, rgba(142,97,246,.16), transparent 70%)' }} />
            <div className="relative w-full max-w-[290px] rounded-[20px] border border-white/5 bg-[#0c0c16]/90 backdrop-blur-lg px-5 pt-5 pb-[18px] text-center shadow-[0_16px_40px_rgba(0,0,0,.5)] my-6">
              <div className="w-11 h-11 mx-auto rounded-[14px] bg-gradient-to-br from-violet-600 to-indigo-600 flex items-center justify-center mb-3 shadow-[0_0_22px_rgba(139,92,246,.35)]">
                <Layers className="w-[22px] h-[22px] text-white" />
              </div>
              <h1 className="font-display text-[32px] sm:text-[38px]">Multi-Tasking</h1>
              <p className="text-[9px] label-tiny text-slate-500 mt-1">Endurance run</p>

              <div className="flex flex-col gap-1.5 text-left mt-3.5">
                <div className="flex items-center gap-2 bg-white/[0.02] border border-white/5 rounded-[10px] px-2.5 py-[7px]">
                  <Target className="w-3.5 h-3.5 text-cyan-400 flex-shrink-0" />
                  <span className="text-[10.5px] text-slate-300 leading-tight whitespace-nowrap">Tap shapes matching your side</span>
                </div>
                <div className="flex items-center gap-2 bg-white/[0.02] border border-white/5 rounded-[10px] px-2.5 py-[7px]">
                  <Repeat className="w-3.5 h-3.5 text-violet-400 flex-shrink-0" />
                  <span className="text-[10.5px] text-slate-300 leading-tight whitespace-nowrap">Targets scramble every 25s</span>
                </div>
                <div className="flex items-center gap-2 bg-white/[0.02] border border-white/5 rounded-[10px] px-2.5 py-[7px]">
                  <Timer className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />
                  <span className="text-[10.5px] text-slate-300 leading-tight whitespace-nowrap">Hits add time, misses cost it</span>
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
              className="absolute bottom-3.5 right-4 w-[26px] h-[26px] before:absolute before:top-0 before:left-0 before:-right-[16px] before:-bottom-[14px] before:content-[''] rounded-full bg-white/[0.04] border border-white/[0.08] flex items-center justify-center text-slate-500 hover:text-white transition-colors cursor-pointer"
            >
              {soundEnabled ? <Volume2 className="w-3 h-3" /> : <VolumeX className="w-3 h-3" />}
            </button>
          </div>
        )}

        {/* ── COUNTDOWN VEIL ── */}
        {phase === 'countdown' && !isChallenge && (
          <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/60">
            <span className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-400">Get Ready</span>
            <div className="relative w-28 h-28 rounded-full border-[3px] border-violet-500/20 flex items-center justify-center">
              <div className="absolute -inset-[3px] rounded-full border-[3px] border-transparent border-t-violet-400 border-r-violet-400 animate-spin" style={{ animationDuration: '0.7s' }} />
              <span key={countdownValue} className="fx-pop-in text-5xl font-display bg-gradient-to-b from-white to-violet-300 bg-clip-text text-transparent">
                {countdownValue}
              </span>
            </div>
            <span className="text-[10px] text-slate-500">Targets spawn at GO</span>
          </div>
        )}

        {/* ── PLAYING / COUNTDOWN BOARD ── */}
        {showBoard && (
          <>
  
            {/* consolidated HUD cluster */}
            <div className="absolute top-5 left-5 z-40 flex flex-col pointer-events-none select-none">
              <span className="text-2xl font-hud font-bold text-white leading-none tabular-nums">{score}</span>
            </div>

            {/* Timer — top-right corner */}
            <div className="absolute top-5 right-5 z-40 flex flex-col items-end pointer-events-none select-none">
              <span className={`text-3xl font-hud font-bold leading-none tabular-nums ${timeRemaining <= 10 ? 'text-red-500 animate-pulse' : 'text-slate-300'}`}>
                {Math.ceil(timeRemaining)}s
              </span>
              <span className="text-[8px] label-tiny text-slate-500 mt-1">Time Left</span>
            </div>

            {/* Left Target Display */}
            {phase === 'playing' && (
              <div className="absolute top-5 left-36 z-40 flex flex-col items-center pointer-events-none select-none">
                <span className="text-[8px] font-bold text-gray-500 uppercase tracking-widest bg-gray-900/60 border border-gray-800 px-1.5 py-0.5 rounded">LEFT TARGET</span>
                <span className="text-4xl font-black text-white mt-1 leading-none drop-shadow-[0_0_10px_rgba(96,165,250,0.5)]">{leftTarget}</span>
              </div>
            )}

            {/* Right Target Display */}
            {phase === 'playing' && (
              <div className="absolute top-5 right-36 z-40 flex flex-col items-center pointer-events-none select-none">
                <span className="text-[8px] font-bold text-gray-500 uppercase tracking-widest bg-gray-900/60 border border-gray-800 px-1.5 py-0.5 rounded">RIGHT TARGET</span>
                <span className="text-4xl font-black text-white mt-1 leading-none drop-shadow-[0_0_10px_rgba(96,165,250,0.5)]">{rightTarget}</span>
              </div>
            )}

            {/* play field — shapes are appended here imperatively by
                mountShape, each carrying its own compositor animation for its
                whole flight; onPointerDown hit-tests taps against whichever
                shapes are currently live. React never re-renders during a
                flight, and there is no canvas and no render loop. */}
            <div
              ref={playFieldRef}
              onPointerDown={handlePlayFieldPointerDown}
              className="absolute inset-0 flex select-none overflow-hidden z-10 pointer-events-auto touch-none"
            >
              <div className="absolute top-0 left-1/2 w-px h-full bg-gradient-to-b from-transparent via-violet-500/30 to-transparent z-20 pointer-events-none" />

              {/* sound toggle */}
              <button
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); setSoundEnabled((v) => { audioSynth?.setEnabled(!v); return !v; }); }}
                className="absolute bottom-4 right-4 z-40 p-2 before:absolute before:top-0 before:left-0 before:-right-[14px] before:-bottom-[14px] before:content-[''] rounded-full bg-black/60 border border-white/10 text-slate-400 active:scale-90 transition-transform cursor-pointer"
              >
                {soundEnabled ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
              </button>

              {/* particles bursts */}
              {bursts.map((b) => (
                <div key={b.id} className="fx-pop" style={{ left: `${b.x}%`, top: `${b.y}%`, width: 40, height: 40, marginLeft: -20, marginTop: -20, background: b.color === 'red' ? 'rgba(239,68,68,.5)' : 'rgba(34,211,238,.5)', zIndex: 30 }} />
              ))}
            </div>
          </>
        )}

        {/* ── RESULT SCREEN — landscape two-column layout ── */}
        {phase === 'ended' && endSummary && !isChallenge && (
          <div className="absolute inset-0 z-40 flex" style={{ background: 'rgba(5,5,8,0.97)' }}>
            <div className="w-[36%] flex flex-col items-center justify-center gap-1.5 border-r border-white/5" style={{ background: 'radial-gradient(ellipse 260px 200px at 50% 30%, rgba(250,204,21,.08), transparent 70%)' }}>
              {endSummary.isNewBest && (
                <span className="text-[11px] font-display text-yellow-400 bg-yellow-500/10 border border-yellow-500/25 px-2.5 py-1 rounded-full mb-1">NEW BEST</span>
              )}
              <div className="text-5xl sm:text-6xl font-display leading-none" style={{ color: endSummary.grade.grade === 'S+' || endSummary.grade.grade === 'S' ? '#fbbf24' : '#a78bfa' }}>
                {endSummary.grade.grade}
              </div>
              <div className="text-[10px] label-tiny text-slate-500">{endSummary.grade.label}</div>
              <div className="text-3xl sm:text-4xl font-display text-white mt-1 tabular-nums">{endSummary.score.toLocaleString()}</div>
              <div className="text-[9px] label-tiny text-slate-500">Points</div>
            </div>

            <div className="flex-1 flex flex-col justify-center gap-3 px-6 sm:px-8 py-4 min-w-0">
              <div className="grid grid-cols-3 gap-2">
                <ResultStat label="Best Score" value={(bestScore ?? 0).toLocaleString()} color="text-yellow-400" />
                <ResultStat label="Accuracy" value={`${endSummary.accuracy}%`} color="text-blue-400" />
                  <ResultStat label="XP" value={`+${endSummary.xpEarned}`} color="text-violet-400" />
              </div>
              <div className="flex gap-2">
                {isChallenge ? (
                  <p className="flex-1 text-xs text-neutral-400 py-3 text-center">Waiting for your opponent to finish…</p>
                ) : (
                  <button onClick={enterDrill} className="flex-1 py-3 rounded-[13px] bg-gradient-to-r from-violet-600 to-indigo-600 text-white font-extrabold text-xs uppercase tracking-wider cursor-pointer">
                    Play Again
                  </button>
                )}
                <button onClick={shareResult} className="w-12 min-h-[46px] flex-shrink-0 rounded-[13px] bg-white/[0.04] border border-white/10 flex items-center justify-center text-slate-400 hover:text-white cursor-pointer">
                  <Share2 className="w-4 h-4" />
                </button>
                <Link href="/drills/cognitive" className="w-12 min-h-[46px] flex-shrink-0 rounded-[13px] bg-white/[0.04] border border-white/10 flex items-center justify-center text-slate-400 hover:text-white">
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
      <div className={`text-[12px] font-hud font-bold ${color}`}>{value}</div>
      <div className="text-[7.5px] label-tiny text-slate-500 mt-0.5">{label}</div>
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