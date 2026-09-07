'use client';

import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  Volume2, VolumeX, RotateCcw
} from 'lucide-react';

import { scoreAction, calcEndBonuses, calcSessionXP, getGrade } from '../../../../../lib/scoringEngine';
import {
  rampUp, applyHit, applyMistake, startLevel,
  scoringMaxLevel, scoringLives,
} from '../../../../../lib/drillRules';
import { saveLeaderboardEntrySync } from '../../../../../lib/leaderboard';
import { afterViewportSettled, lockLandscape, unlockOrientation, onOrientationSettled } from '../../../../../lib/orientation';
import { previewDailyCompletion } from '../../../../../lib/dailyChallenge';
import { getPlayerName, getPlayerLevel } from '../../../../../lib/progressStore';
import { useShareCard } from '../../../../../components/ShareScoreCard';
import { Capacitor } from '@capacitor/core';
import { StatusBar } from '@capacitor/status-bar';
import DrillWrapper from '../../../../../components/DrillWrapper';
import { useDuelMatchStart } from '../../../../../lib/challengeEngine';
import { motionDpr, createLayeredSpriteCache, SPRITE_PAD } from '../../../../../lib/canvasFx';
import { APP_SHARE_URL } from '../../../../../lib/shareLinks';
import ResultScreen from '../../../../../components/drill/ResultScreen';
import DrillStartCard from '../../../../../components/drill/DrillStartCard';

// ============================================================
// TUNING CONSTANTS
// ============================================================
const TOTAL_TIME = 45.0;

// Seconds a correct action buys, overriding the shared TIME_PER_HIT.
//
// The shared 1.0s is calibrated for a STREAM drill — several targets alive at
// once, two to three actions a second. This drill is one action per round:
// a single intercept per round, the slowest per-round cadence at ~1.2s.
// Against a clock that drains 1s per second that cadence could not refill at
// any accuracy, so the run was a flat TOTAL_TIME every time and skill could
// not extend it — the endurance model silently doing nothing.
// 1.75 makes 80% accuracy the break-even bar. See rewardForActionRate() in
// lib/drillRules.js, and recompute this if the round window is retuned.
const TIME_PER_HIT = 1.75;

// How a solo run is won and lost — the clock as the only fail state, what a hit
// earns, what a mistake costs — is defined once in lib/drillRules.js and shared
// by every drill. Read that file for the model and the reasoning.
//
// Drill-local dial: target speed. It was `4.0 + (level-1)/(MAX_LEVEL-1) * 12`,
// valid only while a level ceiling existed — uncapped that fraction runs past 1
// and the target accelerates without limit until it crosses the whole screen
// between two frames and is literally untouchable. It now approaches a ceiling
// it never reaches, so the drill keeps getting harder while staying playable.
const SPEED_START = 4.0;
const SPEED_CEILING = 17.0;
const STORAGE_KEY = 'skilldrills_kinetic_intercept_v2';

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
// STORAGE HELPERS
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
// MAIN COMPONENT
// ============================================================
export default function KineticInterceptClient() {
  const searchParams = useSearchParams();
  const challengeId = searchParams ? searchParams.get('challengeId') : null;
  const isChallenge = !!challengeId;
  const totalTime = isChallenge ? 30 : TOTAL_TIME;
  const matchStartAt = useDuelMatchStart(challengeId);
  const duelAutoStartedRef = useRef(false);

  // === UI State ===
  const [phase, setPhase] = useState('start'); // 'start' | 'countdown' | 'playing' | 'rotate-hint' | 'ended'
  // True from the instant START is tapped until the drill actually leaves the
  // start phase. Tapping START kicks off a fullscreen request, a status-bar
  // change, an await on the native landscape lock and then a settle timeout —
  // several hundred ms during which `phase` is still 'start', so the start
  // card stayed mounted and the user watched it get rotated into landscape
  // before the countdown replaced it. This unmounts it on the tap itself.
  const [launching, setLaunching] = useState(false);
  const [countdownValue, setCountdownValue] = useState(3);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [isClient, setIsClient] = useState(false);

  // === Gameplay States ===
  const [score, setScore] = useState(0);
  // The live "Lv." HUD badge was the only thing that ever READ this, so the
  // React state went with it. The ramp itself runs off levelRef, which the
  // game loop already uses; keeping a useState in step with it only bought a
  // re-render of the whole drill on every level-up, mid-play, for nothing.
  const [timeRemaining, setTimeRemaining] = useState(totalTime);
  const [dangerLevel, setDangerLevel] = useState(0);

  // === Best Stats ===
  const [bestScore, setBestScore] = useState(0);
  const [bestCombo, setBestCombo] = useState(0);
  const [bestLevel, setBestLevel] = useState(1);

  // === Feedback & Summary ===
  const [endSummary, setEndSummary] = useState(null);
  const [flashes, setFlashes] = useState([]);

  // === Engine Refs ===
  const containerRef = useRef(null);
  const gameActiveRef = useRef(false);
  const mountedRef = useRef(false);

  const countdownTimerRef = useRef(null);
  const heartbeatTimerRef = useRef(null);
  const gameTimerRef = useRef(null);
  const heartbeatTempoRef = useRef(1100);

  // Gameplay Engine State Refs
  const scoreRef = useRef(0);
  const timeRemainingRef = useRef(totalTime);
  const runOverRef = useRef(false);
  const comboRef = useRef(0);
  const bestComboRef = useRef(0);
  // levelRef is a FLOAT — the true, continuous difficulty position. displayLevelRef
  // is the whole number the HUD shows. Keeping them apart is what lets the speed
  // rise smoothly with every point while React still only re-renders when the
  // number on screen actually changes.
  const levelRef = useRef(1);
  const displayLevelRef = useRef(1);
  const bestLevelRunRef = useRef(1);

  const correctActionsRef = useRef(0);
  const totalActionsRef = useRef(0);
  const mistakesRef = useRef(0);

  const targetRadiusRef = useRef(20);
  // x0/y0 = flight origin, sx/sy = px per SECOND. The target's on-screen
  // position is always solvable from these plus the animation's currentTime —
  // nothing has to store a live x/y, because nothing runs per frame any more.
  const targetRef = useRef({ x0: -100, y0: -100, sx: 0, sy: 0, r: 20, active: false });
  const targetElRef = useRef(null);   // the small canvas the compositor moves
  const targetAnimRef = useRef(null); // its in-flight Animation
  const spriteCacheRef = useRef(null);
  const drawnForRef = useRef({ el: null, radius: 0 });
  const canvasSizeRef = useRef({ width: 0, height: 0 });
  const lastTapTimeRef = useRef(0);
  const flashIdRef = useRef(0);
  const phaseRef = useRef('start');

  useEffect(() => {
    setIsClient(true);
    mountedRef.current = true;
    const saved = getSavedData();
    setBestScore(saved.bestScore);
    setBestCombo(saved.bestCombo);
    setBestLevel(saved.bestLevel);

    setTimeout(() => setLoading(false), 150);

    return () => {
      mountedRef.current = false;
      gameActiveRef.current = false;
      [heartbeatTimerRef, countdownTimerRef].forEach((r) => { if (r.current) clearTimeout(r.current); });
      if (gameTimerRef.current) clearInterval(gameTimerRef.current);
      targetAnimRef.current?.cancel();
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

  // Difficulty is continuous, not stepped. It used to be floor(score/50)+1, so
  // speed sat flat for 50 points and then jumped 0.86 px/frame in one go. Now
  // every point nudges the ramp, which is the same curve end-to-end without the
  // stair-steps. The ramp only ever climbs — a mistake never walks it back.
  const updateDifficulty = useCallback(() => {
    const exact = 1 + scoreRef.current / 50;
    if (exact > levelRef.current) levelRef.current = exact;

    const shown = Math.floor(levelRef.current);
    if (shown > displayLevelRef.current) {
      displayLevelRef.current = shown;
      bestLevelRunRef.current = Math.max(bestLevelRunRef.current, shown);

    }
  }, []);

  // Paints the layered-circle target into its own small canvas — ONCE per
  // radius, not per frame. After this the element is never rasterised again;
  // the compositor only translates it. Same sprite the drill already shipped,
  // so the look is unchanged.
  const drawTargetSprite = useCallback((radius) => {
    const el = targetElRef.current;
    if (!el) return;
    // Keyed on the ELEMENT as well as the radius. Keying on radius alone was
    // a replay bug: this ref outlives the canvas, which unmounts with the
    // playing screen and comes back as a BRAND NEW element on Play Again. A
    // fresh canvas has the default width of 300 (so `el.width > 0` passed)
    // and the radius is unchanged between rounds, so the guard short-
    // circuited and the new element was never sized or painted — an
    // invisible target, with lives draining to a hazard nobody could see.
    if (drawnForRef.current.el === el && drawnForRef.current.radius === radius) return;

    if (!spriteCacheRef.current) spriteCacheRef.current = createLayeredSpriteCache();
    const dpr = motionDpr();
    const sprite = spriteCacheRef.current.get('#ef4444', radius, dpr);
    if (!sprite) return;

    const half = radius + SPRITE_PAD;
    const size = half * 2;
    el.style.width = `${size}px`;
    el.style.height = `${size}px`;
    el.width = Math.round(size * dpr);
    el.height = Math.round(size * dpr);
    const c = el.getContext('2d');
    if (!c) return;
    c.clearRect(0, 0, el.width, el.height);
    c.drawImage(sprite.canvas, 0, 0, el.width, el.height);
    drawnForRef.current = { el, radius };
  }, []);

  const resolveWrongRef = useRef(null);

  // Ends the current flight: drops the compositor animation and hides the
  // element. Called on a hit, a miss, and at game end so a target can never
  // outlive the round it belongs to.
  const clearTarget = useCallback(() => {
    targetRef.current.active = false;
    const anim = targetAnimRef.current;
    // cancel() drops the animation's hold on transform, so the element snaps
    // back to the parked off-screen transform in its style prop — that IS the
    // hide. No second visibility flag to keep in sync.
    if (anim) { anim.onfinish = null; anim.cancel(); targetAnimRef.current = null; }
  }, []);

  const spawnTarget = useCallback(() => {
    if (!gameActiveRef.current) return;
    const cw = canvasSizeRef.current.width || 800;
    const ch = canvasSizeRef.current.height || 450;

    const side = Math.floor(Math.random() * 4);
    const margin = 40;
    let spawnX, spawnY;

    if (side === 0) { spawnX = -margin; spawnY = Math.random() * ch; }
    else if (side === 1) { spawnX = cw + margin; spawnY = Math.random() * ch; }
    else if (side === 2) { spawnX = Math.random() * cw; spawnY = -margin; }
    else { spawnX = Math.random() * cw; spawnY = ch + margin; }

    const angleToCenter = Math.atan2((ch / 2) - spawnY, (cw / 2) - spawnX);
    const randomizedAngle = angleToCenter + (Math.random() - 0.5) * 0.8;

    // The jitter used to be a 2.0-wide random band. One whole level only moves
    // speed by 0.86, so consecutive targets at the SAME level varied by more
    // than two levels' worth of progress — the randomness buried the ramp and
    // made every speed-up feel arbitrary. 0.5 keeps spawns from feeling
    // metronomic without drowning out the climb.
    const calculatedSpeed = rampUp(levelRef.current, SPEED_START, SPEED_CEILING) + Math.random() * 0.5;
    // Constant size regardless of difficulty (matches ConflictReflexClient.js's
    // getBallRadius approach) — only one target is ever on screen here, so
    // there's no crowding constraint forcing it smaller at high difficulty.
    targetRadiusRef.current = Math.max(24, Math.min(46, Math.min(cw, ch) * 0.075));

    // Velocity in px/second. The drill authors speed as px per 60Hz frame,
    // which is what the old rAF integrator consumed.
    const sx = Math.cos(randomizedAngle) * calculatedSpeed * 60;
    const sy = Math.sin(randomizedAngle) * calculatedSpeed * 60;

    // Solve for when the target crosses the escape boundary, so the whole
    // flight is one straight A-to-B line with a known duration.
    const EXIT = 60;
    let tExit = Infinity;
    if (sx > 0) tExit = Math.min(tExit, (cw + EXIT - spawnX) / sx);
    if (sx < 0) tExit = Math.min(tExit, (-EXIT - spawnX) / sx);
    if (sy > 0) tExit = Math.min(tExit, (ch + EXIT - spawnY) / sy);
    if (sy < 0) tExit = Math.min(tExit, (-EXIT - spawnY) / sy);
    if (!isFinite(tExit) || tExit <= 0) tExit = 4; // degenerate angle guard

    const endX = spawnX + sx * tExit;
    const endY = spawnY + sy * tExit;

    targetRef.current = { x0: spawnX, y0: spawnY, sx, sy, r: targetRadiusRef.current, active: true };

    // ── Why there is no render loop ───────────────────────────────────────
    // This used to be a 60fps rAF loop repainting a full-screen canvas: a
    // 2400x1080 backdrop blit plus a sprite blit, every frame, to move ONE
    // circle. On desktop Chrome that is free and looked perfect. In the
    // Android WebView it is a ~2.6 megapixel repaint plus a texture upload on
    // every vsync, and it shares the main thread with React, the game clock
    // and the audio scheduler — so any hitch on that thread lands directly on
    // the target's position. That is the stutter, and no amount of frame-
    // pacing arithmetic inside the loop can fix it, because the loop itself
    // is the cost.
    //
    // The target's path is a straight line at constant speed, which is exactly
    // what the compositor can animate on its own. Handing the whole flight to
    // the Web Animations API as one linear transform means:
    //   - zero per-frame JavaScript (the rAF loop is gone entirely),
    //   - zero repaints — nothing is rasterised again after spawn, the
    //     compositor just moves an existing layer,
    //   - motion sampled on the compositor thread at true vsync, so main-
    //     thread jank (React re-render, GC, audio) can no longer touch it.
    // That is both the smoothness fix and the CPU/heat fix.
    const el = targetElRef.current;
    if (el) {
      drawTargetSprite(targetRadiusRef.current);
      const half = targetRadiusRef.current + SPRITE_PAD;
      targetAnimRef.current?.cancel();
      const anim = el.animate(
        [
          { transform: `translate3d(${spawnX - half}px, ${spawnY - half}px, 0)` },
          { transform: `translate3d(${endX - half}px, ${endY - half}px, 0)` }
        ],
        { duration: tExit * 1000, easing: 'linear', fill: 'both' }
      );
      anim.onfinish = () => {
        if (!gameActiveRef.current) return;
        if (!targetRef.current.active) return;
        targetRef.current.active = false;
        resolveWrongRef.current?.('escape');
      };
      targetAnimRef.current = anim;
    }

    lastTapTimeRef.current = Date.now();
  }, [drawTargetSprite]);

  const endGameRef = useRef(null);

  const resolveWrong = useCallback((kind = 'miss') => {
    if (!gameActiveRef.current) return;
    comboRef.current = 0;
    mistakesRef.current += 1;
    totalActionsRef.current += 1;

    audioSynth?.playPenalty();
    triggerFlash('red');
    clearTarget();

    if (isChallenge) {
      scoreRef.current = Math.max(0, scoreRef.current - 5);
    } else {
      const after = applyMistake({ timeRemaining: timeRemainingRef.current });
      timeRemainingRef.current = after.timeRemaining;
      runOverRef.current = after.runOver;
      setTimeRemaining(Math.ceil(timeRemainingRef.current));
    }

    setScore(scoreRef.current);

    if (!isChallenge && runOverRef.current) {
      endGameRef.current?.();
    } else {
      setTimeout(() => { if (gameActiveRef.current) spawnTarget(); }, 200);
    }
  }, [triggerFlash, isChallenge, spawnTarget, clearTarget]);

  const resolveCorrect = useCallback(() => {
    if (!gameActiveRef.current) return;

    audioSynth?.playHit();
    correctActionsRef.current += 1;
    totalActionsRef.current += 1;

    const comboBefore = comboRef.current;
    comboRef.current += 1;
    bestComboRef.current = Math.max(bestComboRef.current, comboRef.current);

    const reactionMs = Date.now() - lastTapTimeRef.current;
    const pts = scoreAction({
      category: 'cognitive',
      combo: comboBefore,
      reactionMs,
      timeRemaining: timeRemainingRef.current,
      totalGameTime: totalTime,
      livesRemaining: scoringLives(0),
      level: levelRef.current,
      maxLevel: scoringMaxLevel(isChallenge)
    });

    scoreRef.current += pts.total;
    setScore(scoreRef.current);

    // Buy back a slice of the clock. Solo only — challenge/Arena keeps its
    // fixed 30s deadline, which both duel players share and nothing may move.
    // No state is set here: the 200ms clock interval already redraws the
    // seconds when the displayed number changes, so this costs nothing per hit.
    if (!isChallenge) {
      timeRemainingRef.current = applyHit({ timeRemaining: timeRemainingRef.current, level: levelRef.current, hits: correctActionsRef.current, reward: TIME_PER_HIT });
    }

    triggerFlash('cyan');
    updateDifficulty();

    clearTarget();
    setTimeout(() => { if (gameActiveRef.current) spawnTarget(); }, 150);
  }, [triggerFlash, updateDifficulty, spawnTarget, totalTime, clearTarget, isChallenge]);

  const endGame = useCallback(async (reason) => {
    if (!gameActiveRef.current) return;
    gameActiveRef.current = false;

    if (heartbeatTimerRef.current) { clearTimeout(heartbeatTimerRef.current); heartbeatTimerRef.current = null; }
    if (gameTimerRef.current) { clearInterval(gameTimerRef.current); gameTimerRef.current = null; }

    audioSynth?.playResultsReveal();
    clearTarget();

    const correct = correctActionsRef.current;
    const total = totalActionsRef.current;
    const accuracyVal = total > 0 ? Math.round((correct / total) * 100) : 0;

    const bonuses = calcEndBonuses({
      rawScore: scoreRef.current,
      accuracy: accuracyVal,
      bestCombo: bestComboRef.current,
      totalActions: total,
      mistakes: mistakesRef.current,
      livesRemaining: scoringLives(0),
      category: 'cognitive'
    });

    const finalScore = bonuses.finalScore;

    const prevSaved = getSavedData();
    const isNewBest = finalScore > prevSaved.bestScore;
    const firstPlay = prevSaved.totalSessions === 0;

    const daily = isChallenge
      ? { isDailyDrill: false, wouldCompleteSet: false }
      : await previewDailyCompletion('moving-target');

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

    const updated = {
      bestScore: Math.max(prevSaved.bestScore, finalScore),
      bestCombo: Math.max(prevSaved.bestCombo, bestComboRef.current),
      bestLevel: Math.max(prevSaved.bestLevel, bestLevelRunRef.current),
      totalSessions: prevSaved.totalSessions + 1
    };
    saveData(updated);

    setBestScore(updated.bestScore);
    setBestCombo(updated.bestCombo);
    setBestLevel(updated.bestLevel);

    saveLeaderboardEntrySync({
      drillId: 'moving-target',
      drillName: 'Kinetic Intercept',
      category: 'cognitive',
      score: finalScore,
      accuracy: accuracyVal,
      bestCombo: bestComboRef.current
    });

    setEndSummary({
      progress,
      score: finalScore,
      accuracy: accuracyVal,
      bestCombo: bestComboRef.current,
      level: bestLevelRunRef.current,
      isNewBest,
      bestScore: updated.bestScore,
      xpEarned: xpResult.xp,
      prevBest: prevSaved.bestScore,
    });

    setPhase('ended');
  }, [clearTarget]);

  useEffect(() => { endGameRef.current = endGame; }, [endGame]);
  // spawnTarget's animation finish handler fires long after spawnTarget ran,
  // so it goes through a ref rather than capturing a stale resolveWrong.
  useEffect(() => { resolveWrongRef.current = resolveWrong; }, [resolveWrong]);

  const handlePointerDown = useCallback((e) => {
    if (!gameActiveRef.current || phaseRef.current !== 'playing') return;
    e.preventDefault();

    const field = containerRef.current;
    if (!field) return;

    const rect = field.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const tr = targetRef.current;
    if (tr.active) {
      // Solve the target's position from the animation's OWN clock rather than
      // a stored x/y. currentTime is the exact progress the compositor is
      // playing, so the hit-test always agrees with what the player can see —
      // and it stays correct across a pause/resume without extra bookkeeping.
      const anim = targetAnimRef.current;
      const elapsed = (anim && typeof anim.currentTime === 'number' ? anim.currentTime : 0) / 1000;
      const tx = tr.x0 + tr.sx * elapsed;
      const ty = tr.y0 + tr.sy * elapsed;
      const dist = Math.hypot(x - tx, y - ty);
      if (dist <= tr.r + 20) {
        resolveCorrect();
        return;
      }
    }
    resolveWrong('miss');
  }, [resolveCorrect, resolveWrong]);

  // ── Play-field sizing ──────────────────────────────────────────────────
  // All that is left of the old render loop. There is no per-frame JS in this
  // drill any more; see spawnTarget() for why the target moves without one.
  useEffect(() => {
    if (phase !== 'playing' && phase !== 'countdown') return;
    const measure = () => {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        canvasSizeRef.current = { width: rect.width, height: rect.height };
      }
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', measure);
    };
  }, [phase]);

  // A compositor animation keeps running on its own while the app is in the
  // background, so the target would finish its flight unseen and cost a life.
  // rAF used to stop instead, which is what the old loop relied on.
  useEffect(() => {
    if (phase !== 'playing') return;
    const onVisibility = () => {
      const anim = targetAnimRef.current;
      if (!anim) return;
      if (document.hidden) { if (anim.playState === 'running') anim.pause(); }
      else if (anim.playState === 'paused' && gameActiveRef.current) anim.play();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [phase]);

  const scheduleHeartbeat = useCallback(() => {
    if (isChallenge) return;
    if (!gameActiveRef.current) return;
    const dangerFromLives = 0;   // lives are gone; time is the only danger now
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
    // Quantised to 0.1 steps. The raw float re-rendered on every heartbeat, and
    // that re-render rewrites the vignette's inline --v-min/--v-max and its
    // animation-duration. Changing a running CSS animation's duration restarts
    // it on the main thread and drops it off the compositor's fast path, so a
    // full-screen layer over the canvas was being re-resolved once a second.
    // Bucketed, the style string is identical between buckets and the animation
    // just keeps running.
    const bucket = Math.round(danger * 10) / 10;
    if (mountedRef.current) setDangerLevel((d) => (d === bucket ? d : bucket));
    heartbeatTimerRef.current = setTimeout(scheduleHeartbeat, tempo);
  }, [isChallenge]);

  const beginPlaying = useCallback(() => {
    gameActiveRef.current = true;
    // The tick stays at 200ms so the clock ends the round promptly, but the
    // STATE only moves when the displayed second actually changes. It used to
    // setState 5x a second, and every one of those re-rendered this whole
    // component (plus DrillWrapper, plus the five life hearts) to paint an
    // identical number. Four in five were pure waste, and on a phone that main
    // -thread work lands on top of the render loop as a dropped frame — the
    // stutter felt like a regular hitch rather than random noise.
    let shownSecond = Math.ceil(timeRemainingRef.current);
    gameTimerRef.current = setInterval(() => {
      if (!gameActiveRef.current) { clearInterval(gameTimerRef.current); return; }
      timeRemainingRef.current -= 0.2;
      if (timeRemainingRef.current <= 0) {
        timeRemainingRef.current = 0;
        setTimeRemaining(0);
        endGameRef.current?.('time');
      } else {
        const sec = Math.ceil(timeRemainingRef.current);
        if (sec !== shownSecond) { shownSecond = sec; setTimeRemaining(sec); }
      }
    }, 200);
    scheduleHeartbeat();
    spawnTarget();
  }, [scheduleHeartbeat, spawnTarget]);

  const runCountdown = useCallback((n) => {
    if (countdownTimerRef.current) clearTimeout(countdownTimerRef.current);
    if (n <= 0) {
      if (!isChallenge) audioSynth?.playGo();
      setPhase('playing');
      phaseRef.current = 'playing';
      beginPlaying();
      return;
    }
    if (!isChallenge) audioSynth?.playCountdownTick();
    setCountdownValue(n);
    countdownTimerRef.current = setTimeout(() => runCountdown(n - 1), 700);
  }, [beginPlaying, isChallenge]);

  const enterDrill = useCallback(async () => {
    // Unmount the start card on the tap itself, before the rotation begins.
    setLaunching(true);
    audioSynth?.init();

    gameActiveRef.current = false;
    [heartbeatTimerRef, countdownTimerRef].forEach((r) => { if (r.current) { clearTimeout(r.current); r.current = null; } });
    if (gameTimerRef.current) { clearInterval(gameTimerRef.current); gameTimerRef.current = null; }

    // Every run starts at level 1. It used to start at 55% of the player's best
    // level, so improving once permanently raised the speed every future run
    // opened at — a silent difficulty spike with nothing on screen to explain
    // it. That head-start existed only because a fixed 45s was too short to
    // climb the ramp; the endurance clock above is what replaces it.
    const runStartLevel = isChallenge ? 1 : startLevel(bestLevel);

    scoreRef.current = 0; comboRef.current = 0; bestComboRef.current = 0;
    levelRef.current = runStartLevel; displayLevelRef.current = runStartLevel; bestLevelRunRef.current = runStartLevel;
    mistakesRef.current = 0; correctActionsRef.current = 0; totalActionsRef.current = 0;
    timeRemainingRef.current = totalTime;
    runOverRef.current = false;

    setScore(0); setTimeRemaining(totalTime);
    setDangerLevel(0);
    setEndSummary(null); setFlashes([]);
    setCountdownValue(3);

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
        setPhase('countdown');
        phaseRef.current = 'countdown';
        runCountdown(isChallenge ? 0 : 3);
      }
    });
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
    setLaunching(false);
    phaseRef.current = 'start';
    setScore(0);
    setEndSummary(null);
    setTimeRemaining(totalTime);
    timeRemainingRef.current = totalTime;
    runOverRef.current = false;
  }, [challengeId, totalTime]);

  useEffect(() => {
    const onOrientationChange = () => {
      if (phase === 'rotate-hint' && window.innerWidth > window.innerHeight) {
        setPhase('countdown');
        phaseRef.current = 'countdown';
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

  // Score card. Drawn and encoded while the result screen sits idle,
  // not on the tap - see useShareCard in components/ShareScoreCard.js.
  const shareResult = useShareCard(endSummary ? {
    score: endSummary.score,
    bestScore: endSummary.prevBest ?? bestScore,
    accuracy: endSummary.accuracy,
    bestCombo: endSummary.bestCombo,
    rating: getGrade(endSummary.accuracy),
    newBest: endSummary.isNewBest,
    drillName: 'Kinetic Intercept',
    playerName: getPlayerName(),
  } : null, {
    url: APP_SHARE_URL,
    title: 'Kinetic Intercept — SkillDrills',
    text: endSummary ? `Scored ${endSummary.score} on Kinetic Intercept (${endSummary.accuracy}% accuracy, ${endSummary.bestCombo}x combo) — SkillDrills` : '',
  });

  if (loading || !isClient) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-[#050508]">
        <div className="text-center">
          <div className="w-14 h-14 border-4 border-red-500 border-t-transparent rounded-full animate-spin mx-auto mb-4 shadow-[0_0_20px_rgba(239,68,68,0.5)]" />
          <p className="text-slate-500 font-bold tracking-widest uppercase text-[10px] animate-pulse">Loading Kinetic Core...</p>
        </div>
      </div>
    );
  }

  return (
    <DrillWrapper
      drillName="Kinetic Intercept"
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
        onPointerDown={handlePointerDown}
        className="absolute inset-0 select-none overflow-hidden bg-[#050508] text-white"
        style={{ touchAction: gameActiveRef.current ? 'none' : 'auto', WebkitTapHighlightColor: 'transparent' }}
      >
        {/* The play-field grid. This is the whole backdrop now — a CSS
            background the browser paints once and never touches again. The
            full-screen canvas that used to redraw it 60x/second is gone. */}
        <div className="absolute inset-0 pointer-events-none" style={{ backgroundImage: 'linear-gradient(rgba(255,255,255,0.015) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.015) 1px, transparent 1px)', backgroundSize: '40px 40px' }} />

        {/* Duration derived from the bucketed dangerLevel, not from the live
            heartbeatTempoRef — the ref changes on every tick and would restart
            the animation each time. See the note in scheduleHeartbeat. */}
        {phase === 'playing' && dangerLevel > 0.06 && (
          <div className="fx-vignette" style={{ '--v-min': Math.max(0.05, dangerLevel * 0.25), '--v-max': Math.min(0.55, dangerLevel * 0.75), animationDuration: `${Math.max(350, Math.round(1100 - dangerLevel * 650))}ms` }} />
        )}

        {flashes.map((f) => (
          <div key={f.id} className={`fx-flash ${f.variant === 'cyan' ? 'fx-flash-cyan' : 'fx-flash-red'}`} />
        ))}

        {phase === 'rotate-hint' && !isChallenge && (
          <div className="absolute inset-0 z-[100] flex flex-col items-center justify-center bg-black/95 text-center p-6">
            <div className="animate-bounce mb-5 text-red-500"><RotateCcw className="w-12 h-12 mx-auto" /></div>
            <p className="text-sm font-bold text-white">Rotate your phone to play</p>
            <p className="text-xs text-slate-500 mt-1.5 max-w-[220px] mx-auto">Turn your device to landscape to begin tracking moving targets.</p>
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
        {phase === 'start' && !launching && !isChallenge && (
          <DrillStartCard
            drillName="Moving Target"
            tagline="Track the orb, tap it before it escapes"
            rules={[
              'Track the target as it moves',
              'Tap it before it escapes',
              'Hits add time, misses cost it',
            ]}
            bestStrip={bestScore > 0 ? [
              { value: bestScore.toLocaleString(), label: 'Best · PTS' },
              { value: `${bestCombo}×`, label: 'Combo' },
              { value: String(bestLevel).padStart(2, '0'), label: 'Level' },
            ] : null}
            orientation="landscape"
            onStart={enterDrill}
          />
        )}

        {/* ── PLAYING / COUNTDOWN SCREEN ── */}
        {(phase === 'playing' || phase === 'countdown') && (
          <>
            <div className="absolute top-5 left-5 z-40 flex flex-col pointer-events-none select-none">
              <span className="text-2xl font-hud font-bold text-white leading-none tabular-nums">{score}</span>
            </div>

            {/* Timer overlay top-right */}
            <div className="absolute top-5 right-5 z-40 flex flex-col items-end pointer-events-none select-none">
              <span className={`text-3xl font-hud font-bold leading-none tabular-nums ${timeRemaining <= 10 ? 'text-red-500 animate-pulse' : 'text-slate-300'}`}>
                {Math.ceil(timeRemaining)}s
              </span>
              <span className="text-[8px] label-tiny text-slate-500 mt-1">Time Left</span>
            </div>

            {/* The target. Sprite-sized, not screen-sized: it is painted once
                per radius and then moved purely by a compositor transform, so
                nothing here rasterises during a flight. translate3d + a fixed
                will-change keep it on its own layer for the whole round rather
                than promoting and demoting it on every spawn. */}
            <canvas
              ref={targetElRef}
              className="absolute top-0 left-0 z-10 pointer-events-none"
              style={{ willChange: 'transform', transform: 'translate3d(-9999px,-9999px,0)' }}
            />
          </>
        )}

        {/* ── COUNTDOWN ── */}
        {phase === 'countdown' && !isChallenge && (
          <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/55">
            <span className="text-[11px] font-black uppercase tracking-[0.2em] text-slate-400">Get Ready</span>
            <div className="relative w-28 h-28 rounded-full border-[3px] border-red-500/20 flex items-center justify-center">
              <div className="absolute -inset-[3px] rounded-full border-[3px] border-transparent border-t-red-400 border-r-red-400 animate-spin" style={{ animationDuration: '0.7s' }} />
              <span key={countdownValue} className="fx-pop-in text-5xl font-display bg-gradient-to-b from-white to-red-300 bg-clip-text text-transparent">
                {countdownValue > 0 ? countdownValue : 'GO'}
              </span>
            </div>
            <span className="text-[10px] text-slate-500">Target spawns at GO</span>
          </div>
        )}

        {/* ── RESULT SCREEN ── */}
        {phase === 'ended' && endSummary && !isChallenge && (
          <ResultScreen
            signature
            summary={endSummary}
            bestScore={endSummary.bestScore}
            synth={audioSynth}
            onPlayAgain={enterDrill}
            onShare={shareResult}
          />
        )}
      </div>
    </DrillWrapper>
  );
}

