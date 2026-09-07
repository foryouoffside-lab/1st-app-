'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  Volume2, VolumeX,
  RotateCcw, ArrowLeft
} from 'lucide-react';
import { calcEndBonuses, calcSessionXP, getGrade, getComboMultiplier } from '../../../../../lib/scoringEngine';
import {
  applyHit, applyMistake, scoringLives,
} from '../../../../../lib/drillRules';
import { saveLeaderboardEntrySync } from '../../../../../lib/leaderboard';
import { afterViewportSettled, lockLandscape, unlockOrientation, onOrientationSettled } from '../../../../../lib/orientation';
import { previewDailyCompletion } from '../../../../../lib/dailyChallenge';
import { getPlayerName, getPlayerLevel } from '../../../../../lib/progressStore';
import { Capacitor } from '@capacitor/core';
import { StatusBar } from '@capacitor/status-bar';
import { useShareCard } from '../../../../../components/ShareScoreCard';
import DrillWrapper from '../../../../../components/DrillWrapper';
import { useDuelMatchStart } from '../../../../../lib/challengeEngine';
import { motionDpr } from '../../../../../lib/canvasFx';
import { APP_SHARE_URL } from '../../../../../lib/shareLinks';
import ResultScreen from '../../../../../components/drill/ResultScreen';
import DrillStartCard from '../../../../../components/drill/DrillStartCard';

// ============================================================
// TUNING
// ============================================================
// Physics timestep. Fixed so difficulty and hit detection are deterministic
// regardless of frame rate; the renderer interpolates across it (see the alpha
// note in the canvas effect) so a fixed step does not mean stepped-looking
// motion.
const FIXED_DT = 1 / 60;

// Base classes for the countdown clock. Kept here because the physics step
// rewrites this node's className directly when the clock crosses 10s — see the
// HUD sync block — and both halves have to agree on the base string.
const TIME_CLS = 'text-3xl font-hud font-bold leading-none tabular-nums';
const TOTAL_TIME = 45;

// How a solo run is won and lost — the clock as the only fail state, what a hit
// earns, what a mistake costs — is defined once in lib/drillRules.js and shared
// by every drill. Read that file for the model and the reasoning.

// Thresholds compressed ~30% and speed/spawnDelay tightened at every tier —
// the old curve let a full 45s solo run pass at trivial difficulty (see
// PLAYER_HIT_R and homingRate below for the other half of the fix). Density
// (maxEnemies) ramps a little faster too so the board fills in sooner.
// Density pass, 2026-08-26. `maxEnemies` is a CEILING, not a rate — what
// actually decides how many hazards are on screen is spawnDelay against how
// long a hazard survives, and at the old numbers the ceiling was rarely the
// binding constraint. So the upper half of the curve spawns markedly faster,
// and the ceilings were raised to match so that a player who keeps dodging
// (homing hazards that miss can curve back and linger far longer than a
// straight crossing) actually gets the denser board instead of hitting the cap.
//
// One wrinkle worth knowing before retuning these: spawnDelay is QUANTISED to
// the fixed timestep, because the stepper resets spawnTimer to 0 rather than
// subtracting the delay. The real interval is
// (floor(spawnDelay / FIXED_DT) + 1) * FIXED_DT, so at the fast end 0.045 and
// 0.05 are the same number (3 frames = 20 spawns/sec) and anything between
// them changes nothing. The values below are picked to sit just under a frame
// boundary so they are stable rather than teetering between two rates.
const MAX_HAZARDS = 56;
// Used once the score runs off the end of LEVEL_TABLE.
const SPEED_CEILING = 165;
const SPAWN_FLOOR_S = 0.022;
const RAMP_DECAY = 0.94;
const OVERFLOW_POINTS_PER_LEVEL = 6000;
// Quick Dodge keeps its own hand-tuned table and this local decay for scores
// past the end of it. Deliberately excluded from the shared LEVEL_STEP runway.
//
// Two things used to make this drill spike, and neither was the speed column —
// that already stepped gently (14% of its range by level 3).
//
//  1. spawnDelay, which is the dial that actually decides how hard a dodge
//     board is, went 0.72 -> 0.62 -> 0.54: 27% of its whole range gone by
//     level 3 and 56% by level 5. Hazard density more than doubled while the
//     player was still reading the board. It now follows the 0.94 curve, so
//     level 3 sits at ~11% and level 5 at ~21%.
//
//  2. The thresholds. At 2-4 points a dodge, level 2 landed after ~3 dodges
//     and level 3 after ~12 — two step changes inside the opening seconds.
//     Early thresholds are stretched ~3x; the top of the table is unchanged,
//     so the endgame and every existing high score still mean the same thing.
//
// speed and maxEnemies keep their old values: both were already gentler than
// the target curve, and maxEnemies is the one dial with a real frame cost.
const LEVEL_TABLE = [
  { threshold: 0,     speed: 30,  spawnDelay: 0.72,  maxEnemies: 9,  basePoints: 2 },
  { threshold: 30,    speed: 36,  spawnDelay: 0.650, maxEnemies: 11, basePoints: 3 },
  { threshold: 90,    speed: 44,  spawnDelay: 0.584, maxEnemies: 13, basePoints: 4 },
  { threshold: 200,   speed: 53,  spawnDelay: 0.523, maxEnemies: 16, basePoints: 5 },
  { threshold: 380,   speed: 63,  spawnDelay: 0.465, maxEnemies: 20, basePoints: 6 },
  { threshold: 640,   speed: 72,  spawnDelay: 0.410, maxEnemies: 24, basePoints: 8 },
  { threshold: 1000,  speed: 81,  spawnDelay: 0.359, maxEnemies: 28, basePoints: 10 },
  { threshold: 1500,  speed: 86,  spawnDelay: 0.310, maxEnemies: 31, basePoints: 13 },
  { threshold: 2200,  speed: 92,  spawnDelay: 0.265, maxEnemies: 35, basePoints: 16 },
  { threshold: 3200,  speed: 103, spawnDelay: 0.223, maxEnemies: 40, basePoints: 20 },
  { threshold: 4600,  speed: 110, spawnDelay: 0.183, maxEnemies: 43, basePoints: 22 },
  { threshold: 6600,  speed: 117, spawnDelay: 0.145, maxEnemies: 46, basePoints: 25 },
  { threshold: 9400,  speed: 123, spawnDelay: 0.110, maxEnemies: 49, basePoints: 28 },
  { threshold: 13200, speed: 128, spawnDelay: 0.076, maxEnemies: 52, basePoints: 30 },
  { threshold: 18000, speed: 131, spawnDelay: 0.045, maxEnemies: MAX_HAZARDS, basePoints: 32 },
];

// ── Joystick tuning ────────────────────────────────────────────────────────
// Top speed of the dot at full stick deflection, in % of the field's WIDTH per
// second — i.e. 105 crosses the long axis in a shade under a second. Same unit
// as the obstacle `speed` column above, so the two are directly comparable: you
// outrun early hazards outright and, past level 11 or so, can only sidestep
// them. This is THE difficulty dial for the new controls; raise it if the top
// levels feel unwinnable, lower it if they feel tame.
//
// Applied ISOTROPICALLY (see the movement block in gameStep). The engine's
// coordinates are a percentage of each axis separately, so a plain `y += v*dt`
// would move the dot at the field's aspect ratio — on a landscape phone,
// vertical steering would come out roughly half the speed of horizontal, and a
// stick pushed at 45° would send the dot off at about 25°. A directional
// control has to move where it points.
// 105, up from 80. At 80 the dot could not outrun the mid-table hazards
// (speed 63-92 in LEVEL_TABLE), so from about level 5 the only way past a
// closing gap was to have already been there — which reads as the stick being
// slow rather than the dot being slow. 105 crosses the long axis in a shade
// under a second and keeps you genuinely faster than every hazard up to the
// level 12 band, so dodging stays a decision instead of a prediction.
const PLAYER_MAX_SPEED = 105;

// How quickly the dot's velocity chases the thumb, as exponential time
// constants in seconds. There are THREE of them, and which one is used depends
// on what the thumb is asking for relative to where the dot is already going.
//
// There used to be one constant, 0.05, for all three cases, and it is the
// single biggest reason this drill was reported as "the joystick has a lot of
// delay" and "the dot keeps moving in a straight line after I let go":
//
//   • Release. A 0.05 tau decaying to the old 0.004 park threshold takes
//     0.05 * ln(1/0.004) = 276ms. At the top speed below that is roughly 4% of
//     the field COASTED after the thumb has already come off the stick. The
//     player has stopped steering and the dot keeps going — which is exactly
//     the complaint, and it is not a latency bug, it is a glide.
//   • Reversal. Swinging from full one way to full the other passes through
//     zero on the same 0.05 curve, so a hard direction change took ~170ms and
//     ~7% of the field of travel the wrong way first. That reads as the dot
//     ignoring the stick.
//   • Acceleration from rest is the ONE case the smoothing was actually for:
//     without it the dot snapped 0 -> full and overshot every gap.
//
// So acceleration keeps (a slightly tightened) ease, and turning and stopping
// are made close to immediate. Written as an exponential approach against dt,
// so the feel is identical at 60, 90 and 120Hz.
const PLAYER_ACCEL_TAU = 0.034;
// Demand pointing more than ~60 deg away from the current heading. Cutting the
// old velocity almost dead and rebuilding it toward the new direction is what
// makes the dot feel like it pivots rather than banks.
const PLAYER_TURN_TAU = 0.012;
// Thumb lifted (or inside the dead zone). ~3 frames to a standstill instead of
// ~17, so the dot parks where the thumb left it.
const PLAYER_STOP_TAU = 0.014;
// cos(60 deg). Below this the demand counts as a turn, not an acceleration.
const PLAYER_TURN_COS = 0.5;
// Below this the dot is crawling on the asymptote of the ease-out; park it so
// it stops cleanly rather than creeping, and so movePlayer can early-out.
// Raised with the stop tau above — at 0.004 the tail of the decay was still a
// visible drift.
const PLAYER_VEL_EPSILON = 0.02;
// Fraction of the stick's radius that reads as "no input". Below this a resting
// thumb's micro-movement would drift the dot into a hazard. Kept small on
// purpose: a big dead zone is the other way a stick feels laggy, because the
// first part of every push does nothing at all.
const STICK_DEAD_ZONE = 0.05;

// Full-deflection radius, as a fraction of the field's SHORT side, and the px
// range it is clamped to. Was 0.15 / 44..78, which on a landscape phone put
// full speed roughly 60px — about 10mm of thumb travel — from the anchor. That
// is the "the joystick takes a lot of movement / it stretches" report: the
// stick was not slow, it was long. At 0.115 / 32..54 the same push reaches the
// rim in a little over half the distance, so the useful part of the throw sits
// inside one comfortable thumb sweep and full speed is genuinely reachable
// without re-planting.
const STICK_RADIUS_FRAC = 0.115;
const STICK_RADIUS_MIN = 32;
const STICK_RADIUS_MAX = 54;

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

  // 4. Penalty / Miss / Hit sound
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
  playWrong() { this.playPenalty(); }

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
// LOCAL STORAGE CONSOLIDATED KEY & MIGRATION
// ============================================================
const STORAGE_KEY = 'skilldrills_quick_dodge_v3';

const getSavedData = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
    const v2 = localStorage.getItem('skilldrills_quick_dodge_v2');
    if (v2) {
      const old = JSON.parse(v2);
      const migrated = { bestScore: old.bestScore || 0, bestCombo: old.bestCombo || 0, bestLevel: old.bestLevel || 1, totalSessions: old.totalSessions || 0 };
      saveData(migrated);
      return migrated;
    }
    return { bestScore: 0, bestCombo: 0, bestLevel: 1, totalSessions: 0 };
  } catch {
    return { bestScore: 0, bestCombo: 0, bestLevel: 1, totalSessions: 0 };
  }
};
const saveData = (data) => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch {} };

// ============================================================
// MAIN COMPONENT
// ============================================================
export default function QuickDodgeClient() {
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
  // The live "Lv." HUD badge was the only thing that ever READ the level as
  // React state, so the state went with it. The real level lives on the
  // mutable engine object (engine.current.level), which updateDifficulty and
  // the game loop already drive; a useState kept in step with it only bought
  // a re-render of the whole drill on every level-up, mid-play, for nothing.
  const [timeRemaining, setTimeRemaining] = useState(totalTime);
  const [dangerLevel, setDangerLevel] = useState(0);

  const [flashes, setFlashes] = useState([]);
  const [endSummary, setEndSummary] = useState(null);

  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const canvasSizeRef = useRef({ width: 0, height: 0 });
  // The hazard layer and the player dot are DOM elements the compositor moves,
  // not canvas paint. See the render block for why. The canvas below them is
  // now only ever touched on the frames where a hit effect is on screen.
  const obLayerRef = useRef(null);
  const playerElRef = useRef(null);
  // Live HUD nodes. Score and the clock move constantly, so the physics step
  // writes them straight into the DOM instead of routing them through state —
  // see the HUD sync block in runGameLoop for why.
  const scoreElRef = useRef(null);
  const timeElRef = useRef(null);
  // Last value pushed to each HUD node, so an unchanged frame writes nothing.
  const hudScoreRef = useRef(-1);
  const hudTimeRef = useRef(-1);
  const hudLevelRef = useRef(1);
  const hudStateTimeRef = useRef(-1);
  const gameActiveRef = useRef(false);
  // The draw loop needs to know whether the round has actually started, but
  // it must NOT be re-created when that changes — see the canvas effect's
  // dependency note. Read through a ref instead of the `phase` closure.
  const phaseRef = useRef('start');
  const mountedRef = useRef(false);
  // The physics stepper, installed by runGameLoop and driven from the single
  // rAF loop in the canvas effect. There is no separate physics rAF any more.
  const stepRef = useRef(null);
  // The same stepper, but held unconditionally so the countdown can execute it
  // against dummy obstacles before the round starts (see the warm-up block in
  // the draw loop). stepRef stays the "is the round live" signal; this is just
  // a handle on the function.
  const gameStepRef = useRef(null);
  const drawAnimRef = useRef(null);
  const lastTimeRef = useRef(0);
  const countdownTimerRef = useRef(null);
  const heartbeatTimerRef = useRef(null);
  const heartbeatTempoRef = useRef(1100);
  const particlesRef = useRef([]);
  const shockwavesRef = useRef([]);

  // ── Virtual joystick ──────────────────────────────────────────────────
  // Movement used to be a 1:1 drag: the dot tracked the finger's delta, which
  // meant the finger sat on top of the thing it was steering and covered the
  // hazards closing in on it. This is the floating thumbstick the console and
  // battle-royale phone games settled on instead — press anywhere, the base
  // snaps under your thumb, and the stick's deflection is a VELOCITY, so the
  // hand never has to be near the dot.
  const stickElRef = useRef(null);
  const stickKnobRef = useRef(null);
  // Live stick state. Never React state: this is written on every pointermove
  // and read by every physics step, so a re-render here would be a re-render
  // of the whole drill mid-run.
  //
  // The event handlers below do NOT touch the DOM at all — not one read, not
  // one write. They only record numbers here. Everything visual is done once
  // per frame from the rAF loop. That split is the whole design: pointermove
  // fires two or three times per frame on this WebView, and the first version
  // of this widget called getBoundingClientRect() and then wrote a transform in
  // every one of those calls. Reading layout right after writing to it forces
  // the browser to recompute layout synchronously, mid-input — with 40+ hazard
  // nodes on screen that is a dropped frame every time the thumb moves, which
  // is exactly when the drill can least afford one.
  const stickRef = useRef({
    pointerId: null,    // the one pointer that owns the stick (multi-touch safe)
    active: false,
    fieldX: 0, fieldY: 0, // field origin in client px, sampled once per press
    baseX: 0, baseY: 0,   // anchor, field-relative px
    curX: 0, curY: 0,     // live thumb position, field-relative px
    radius: 60,           // full-deflection distance, in px
    vx: 0, vy: 0,         // normalised input, -1..1, dead zone already removed
    dirty: true,          // the widget's DOM is behind the numbers above
    shown: false,         // class state we last wrote, so we toggle only on change
  });

  // Engine state
  const engine = useRef({
    // vx/vy are the SMOOTHED velocity (see movePlayer), not the raw stick.
    player: { x: 50, y: 50, vx: 0, vy: 0 },
    obstacles: [],
    obstacleIdCounter: 0,

    score: 0,
    streak: 0,
    maxStreak: 0,
    dodges: 0,
    hitsTaken: 0,
    nearMisses: 0,
    runOver: false,

    timeLeft: totalTime,
    elapsedTime: 0,
    speed: LEVEL_TABLE[0].speed,
    spawnDelay: LEVEL_TABLE[0].spawnDelay,
    maxEnemies: LEVEL_TABLE[0].maxEnemies,
    basePoints: LEVEL_TABLE[0].basePoints,
    spawnTimer: 0,
    level: 1,
    // Fractional level — the real difficulty position, see updateDifficulty.
    fracLevel: 1,

    containerW: 0,
    containerH: 0,
  });

  useEffect(() => {
    setIsClient(true);
    mountedRef.current = true;
    const data = getSavedData();
    setBestScore(data.bestScore);
    setBestCombo(data.bestCombo);
    setBestLevel(data.bestLevel);
    
    const t = setTimeout(() => setLoading(false), 150);
    return () => {
      clearTimeout(t);
      mountedRef.current = false;
      gameActiveRef.current = false;
      if (countdownTimerRef.current) clearTimeout(countdownTimerRef.current);
      if (heartbeatTimerRef.current) clearTimeout(heartbeatTimerRef.current);
      stepRef.current = null;
      if (drawAnimRef.current) cancelAnimationFrame(drawAnimRef.current);
      try { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); } catch {}
      if (Capacitor.isNativePlatform()) {
        StatusBar.setOverlaysWebView({ overlay: false }).catch(() => {});
        StatusBar.show().catch(() => {});
      }
      unlockOrientation();
    };
  }, []);

  useEffect(() => { phaseRef.current = phase; }, [phase]);

  useEffect(() => { if (audioSynth) audioSynth.setEnabled(soundEnabled); }, [soundEnabled]);

  // ── Joystick input ────────────────────────────────────────────────────
  // Handlers record numbers only. See the note on stickRef for why nothing
  // here is allowed to read or write the DOM.

  const handlePointerDown = useCallback((e) => {
    // Live through the COUNTDOWN as well as the round. Planting a thumb during
    // "3, 2, 1" and already pushing on GO is how people actually hold this
    // drill, and refusing the press here meant the stick did not exist until
    // they lifted and pressed again — so the first half-second of every round
    // had no controls at all. That is most of the reported "delay": not a slow
    // stick, a dead one. Movement itself is still gated on the round having
    // started (see movePlayer's call site), so anchoring early cannot move the
    // dot early.
    if (!gameActiveRef.current && phaseRef.current !== 'countdown') return;
    const s = stickRef.current;
    // First finger down owns the stick. A second finger is ignored outright
    // rather than stealing the anchor mid-dodge.
    if (s.pointerId !== null) return;

    // The one layout read in the whole input path, and it happens once per
    // press rather than once per move. The field cannot move while a finger is
    // held down, so this stays valid for the life of the gesture.
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    s.fieldX = rect.left;
    s.fieldY = rect.top;

    // Radius scales with the field so the stick is the same physical size on a
    // phone and a tablet, clamped to the range a thumb can actually sweep.
    s.radius = Math.max(STICK_RADIUS_MIN, Math.min(STICK_RADIUS_MAX, Math.min(rect.width, rect.height) * STICK_RADIUS_FRAC));

    // Anchor EXACTLY where the thumb landed. The first version clamped this
    // inward so the base ring could never overhang the screen edge, and that
    // was the "it pulls to one side" bug: press anywhere near an edge and the
    // anchor jumped inward by up to a full radius, so the stick was already
    // deflected before the thumb had moved at all, and the dot set off on its
    // own. A floating stick's whole contract is that the anchor is the point
    // you touched. If the ring overhangs the edge, it overhangs — the CSS
    // clips it and the input stays honest.
    s.baseX = e.clientX - rect.left;
    s.baseY = e.clientY - rect.top;
    s.curX = s.baseX;
    s.curY = s.baseY;
    s.pointerId = e.pointerId;
    s.active = true;
    s.vx = 0; s.vy = 0;
    s.dirty = true;

    // Capture, so a thumb that slides past the edge of the field (or over the
    // sound button) keeps steering instead of dropping the stick.
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
  }, []);

  const handlePointerMove = useCallback((e) => {
    const s = stickRef.current;
    if (!s.active || e.pointerId !== s.pointerId) return;
    // e.clientX is already the newest sample. When the WebView coalesces a
    // burst of moves it dispatches the LAST one and files the rest under
    // getCoalescedEvents() — that history matters for drawing a stroke, but a
    // stick only ever wants "where is the thumb now", and asking for it would
    // allocate an array of events on every move for nothing.
    s.curX = e.clientX - s.fieldX;
    s.curY = e.clientY - s.fieldY;
    s.dirty = true;
  }, []);

  const handlePointerUp = useCallback((e) => {
    const s = stickRef.current;
    if (e && e.pointerId !== undefined && s.pointerId !== null && e.pointerId !== s.pointerId) return;
    s.pointerId = null;
    s.active = false;
    s.vx = 0; s.vy = 0;
    s.curX = s.baseX;
    s.curY = s.baseY;
    s.dirty = true;
  }, []);

  // Turn the recorded thumb position into the input vector. Pure arithmetic,
  // called once per frame from the rAF loop just before physics, so the vector
  // the step reads is always built from the newest sample — and built once,
  // not once per pointermove.
  const sampleStick = useCallback(() => {
    const s = stickRef.current;
    if (!s.active) { s.vx = 0; s.vy = 0; return; }
    const dx = s.curX - s.baseX;
    const dy = s.curY - s.baseY;
    const dist = Math.hypot(dx, dy);
    const dead = s.radius * STICK_DEAD_ZONE;
    if (dist <= dead) { s.vx = 0; s.vy = 0; return; }
    // Rescale past the dead zone so the first millimetre of real travel is a
    // genuine crawl rather than a jump straight to dead-zone speed.
    const mag = Math.min(1, (dist - dead) / (s.radius - dead));
    s.vx = (dx / dist) * mag;
    s.vy = (dy / dist) * mag;
  }, []);

  // The widget's only DOM writes, batched into the frame. Writes and nothing
  // else — no getBoundingClientRect, no getComputedStyle, no classList read.
  const paintStick = useCallback(() => {
    const s = stickRef.current;
    if (!s.dirty) return;
    s.dirty = false;
    const el = stickElRef.current;
    const knob = stickKnobRef.current;
    if (!el || !knob) return;

    if (s.active) {
      const dx = s.curX - s.baseX;
      const dy = s.curY - s.baseY;
      const dist = Math.hypot(dx, dy);
      // The knob clamps to the ring; pushing past it is just "full speed that
      // way", which is what the vector above already encodes.
      const k = dist > s.radius ? s.radius / dist : 1;
      knob.style.transform = 'translate3d(' + (dx * k) + 'px,' + (dy * k) + 'px,0)';
    } else {
      knob.style.transform = 'translate3d(0px,0px,0)';
    }

    if (s.shown !== s.active) {
      s.shown = s.active;
      // Only on the two frames a gesture starts and ends, never mid-drag: a
      // class change invalidates style for the subtree, and doing that on every
      // move was half the cost of the old handler.
      if (s.active) {
        el.style.setProperty('--qd-stick-r', s.radius + 'px');
        el.style.transform = 'translate3d(' + s.baseX + 'px,' + s.baseY + 'px,0)';
        el.classList.add('qd-stick-on');
      } else {
        el.classList.remove('qd-stick-on');
      }
    }
  }, []);

  // Keyboard fallback. Feeds the SAME vector the stick does, so desktop and
  // touch now share one movement model instead of the old discrete 3%-per-
  // keypress hop, which moved in visible steps and ignored held keys.
  useEffect(() => {
    const held = new Set();
    const apply = () => {
      const s = stickRef.current;
      if (s.active) return; // a live thumb always wins over the keyboard
      let x = (held.has('right') ? 1 : 0) - (held.has('left') ? 1 : 0);
      let y = (held.has('down') ? 1 : 0) - (held.has('up') ? 1 : 0);
      if (x && y) { const k = Math.SQRT1_2; x *= k; y *= k; }
      s.vx = x; s.vy = y;
    };
    const dirOf = (key) => {
      switch (key) {
        case 'ArrowLeft': case 'a': case 'A': return 'left';
        case 'ArrowRight': case 'd': case 'D': return 'right';
        case 'ArrowUp': case 'w': case 'W': return 'up';
        case 'ArrowDown': case 's': case 'S': return 'down';
        default: return null;
      }
    };
    const onDown = (e) => {
      if (!gameActiveRef.current) return;
      const d = dirOf(e.key);
      if (!d) return;
      e.preventDefault();
      held.add(d);
      apply();
    };
    const onUp = (e) => {
      const d = dirOf(e.key);
      if (!d) return;
      held.delete(d);
      apply();
    };
    // A tab-out leaves keys "held" forever otherwise, and the dot drifts into a
    // hazard while the player is not even looking at the page.
    const onBlur = () => { held.clear(); apply(); };
    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onDown);
      window.removeEventListener('keyup', onUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  // Expanding hollow ring left at an impact point. Same visual language as the
  // obstacles themselves (a ring rising out of a centre dot), so a hit reads as
  // the hazard discharging rather than as a separate particle effect.
  const spawnShockwave = useCallback((xPct, yPct, color) => {
    // rgb built once here, not per frame in the draw loop (see the note there).
    shockwavesRef.current.push({ x: xPct, y: yPct, life: 1, color, rgb: `rgb(${color})` });
  }, []);

  const spawnBurst = useCallback((xPct, yPct, color, count = 12) => {
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 0.4 + Math.random() * 1.3;
      particlesRef.current.push({
        x: xPct, y: yPct,
        vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
        r: 0.6 + Math.random() * 0.8, alpha: 1, color,
      });
    }
  }, []);

  const spawnObstacle = useCallback(() => {
    const e = engine.current;
    const side = Math.floor(Math.random() * 4);
    let x = 0, y = 0;

    if (side === 0) { x = Math.random() * 100; y = -8; }
    else if (side === 1) { x = 108; y = Math.random() * 100; }
    else if (side === 2) { x = Math.random() * 100; y = 108; }
    else { x = -8; y = Math.random() * 100; }

    const angle = Math.atan2(e.player.y - y, e.player.x - x);
    const id = ++e.obstacleIdCounter;
    // Clamped: levels keep climbing past the end of LEVEL_TABLE (see the
    // overflow branch in updateDifficulty), so this fraction ran straight past
    // 1.0 and hazards kept inflating forever — 2x their intended size by
    // level 30, on a board that is already at MAX_HAZARDS. 1.5x is the cap the
    // 0.5 coefficient was always meant to express.
    const levelProgress = Math.min(1, (e.fracLevel - 1) / (LEVEL_TABLE.length - 1));
    const sizeScale = 1.0 + levelProgress * 0.5;
    // Every radius in this drill is a percentage of the field's short side, so
    // "one pixel bigger" is not a constant here — it depends on how big the
    // field actually is. Converting it from the live container keeps it exactly
    // one CSS pixel on every device and at every level, instead of a fudged
    // percentage that would be a pixel on this phone and something else on a
    // tablet. Added AFTER sizeScale so it stays one pixel rather than growing
    // to one and a half with the level ramp.
    const minDim = Math.min(e.containerW, e.containerH) || 400;
    const maxR = 4.95 * sizeScale + (100 / minDim);

    e.obstacles.push({
      id, x, y,
      px: x, py: y,   // previous position, for render interpolation
      vx: Math.cos(angle) * e.speed,
      vy: Math.sin(angle) * e.speed,
      speed: e.speed,
      r: maxR * 0.3,
      maxR,
      nearMissTriggered: false,
      // Index of the pooled DOM node currently drawing this hazard. -1 means
      // "not yet claimed"; the render pass claims one on the first frame the
      // hazard is seen and the sweep at the end of that pass hands it back the
      // frame after the hazard stops appearing — so every removal path
      // (escaped, cleared by a hit, wiped by a round reset) is covered without
      // any of them having to know the renderer exists.
      nodeIdx: -1,
    });
  }, []);

  const updateDifficulty = useCallback(() => {
    const e = engine.current;
    let newLevel = 1;
    for (let i = LEVEL_TABLE.length - 1; i >= 0; i--) {
      if (e.score >= LEVEL_TABLE[i].threshold) { newLevel = i + 1; break; }
    }
    // Beyond the final row, keep awarding levels on a fixed score interval so
    // the ramp (and the decaying time payout) has something to keep climbing.
    const last = LEVEL_TABLE[LEVEL_TABLE.length - 1];
    if (e.score > last.threshold) {
      newLevel = LEVEL_TABLE.length + Math.floor((e.score - last.threshold) / OVERFLOW_POINTS_PER_LEVEL);
    }
    if (newLevel > e.level) {
      e.level = newLevel;
    }

    // Past the last row the table simply runs out, so extrapolate — otherwise
    // difficulty would stop dead at the top bracket and a good enough player
    // could survive there indefinitely.
    //
    // maxEnemies is deliberately NOT extrapolated. It is the one dial here with
    // a real cost: every extra hazard is another moving DOM node, and this is
    // the drill with the jitter and heat history. It stays pinned at
    // MAX_HAZARDS. Speed and spawn rate are free, so they keep going — toward
    // limits they never cross, so the board stays dodgeable.
    // ── Fractional level ──────────────────────────────────────────────────
    // The table is a set of brackets, so reading dials straight out of a
    // bracket meant every level-up stepped speed ~20% and hazard count +2..4
    // in the same instant. The rows are now WAYPOINTS, not plateaus: the score
    // gives a position BETWEEN two rows and every dial is interpolated across
    // it, so the same curve is delivered continuously. The table's numbers are
    // untouched — a player at exactly a threshold sees exactly the old values.
    //
    // Ratcheted like e.level: an Arena penalty that dips the score must never
    // walk difficulty back down.
    let frac = e.level;
    if (e.level < LEVEL_TABLE.length) {
      const cur = LEVEL_TABLE[e.level - 1];
      const nxt = LEVEL_TABLE[e.level];
      const span = nxt.threshold - cur.threshold;
      if (span > 0) {
        frac = e.level + Math.max(0, Math.min(1, (e.score - cur.threshold) / span));
      }
    }
    if (frac > e.fracLevel) e.fracLevel = frac;

    const over = Math.max(0, e.level - LEVEL_TABLE.length);
    const lo = LEVEL_TABLE[Math.min(LEVEL_TABLE.length, Math.floor(e.fracLevel)) - 1];
    const hi = LEVEL_TABLE[Math.min(LEVEL_TABLE.length - 1, Math.floor(e.fracLevel))];
    const t = Math.max(0, Math.min(1, e.fracLevel - Math.floor(e.fracLevel)));
    const lerp = (a, b) => a + (b - a) * t;

    e.speed = over === 0 ? lerp(lo.speed, hi.speed) : SPEED_CEILING - (SPEED_CEILING - last.speed) * Math.pow(RAMP_DECAY, over);
    e.spawnDelay = over === 0 ? lerp(lo.spawnDelay, hi.spawnDelay) : SPAWN_FLOOR_S + (last.spawnDelay - SPAWN_FLOOR_S) * Math.pow(RAMP_DECAY, over);
    // Whole hazards only — but arrived at one at a time, spread across the
    // bracket, instead of four landing together on a level-up.
    e.maxEnemies = Math.round(over === 0 ? lerp(lo.maxEnemies, hi.maxEnemies) : last.maxEnemies);
    // basePoints stays stepped ON PURPOSE: it is scoring, not difficulty, and
    // interpolating it would shift what every existing high score means.
    e.basePoints = over === 0 ? lo.basePoints : Math.round(last.basePoints * (1 + over * 0.1));
  }, []);

  const endGame = useCallback(async (reason) => {
    gameActiveRef.current = false;
    setPhase('ended');
    stepRef.current = null;
    // Drop the stick with the round. The thumb is very often still down at the
    // instant the clock runs out, and the handlers go inert the moment
    // gameActiveRef flips — so nothing else would ever clear it.
    stickRef.current.pointerId = null;
    stickRef.current.active = false;
    stickRef.current.vx = 0; stickRef.current.vy = 0;
    stickRef.current.dirty = true;
    stickRef.current.shown = false;
    stickElRef.current?.classList.remove("qd-stick-on");
    if (heartbeatTimerRef.current) clearTimeout(heartbeatTimerRef.current);

    const e = engine.current;
    // Flush the ref-driven HUD values into state. DrillWrapper submits the
    // `score` prop the moment it sees `timeLeft` reach 0, so the final pair has
    // to land together and be current — the 1Hz sync in the step may be up to
    // a second stale at this point.
    setScore(e.score);
    setTimeRemaining(Math.max(0, Math.ceil(e.timeLeft)));

    audioSynth?.playResultsReveal();

    const totalEvents = e.dodges + e.hitsTaken;
    const accuracy = totalEvents > 0 ? Math.round((e.dodges / totalEvents) * 100) : 0;

    const bonuses = calcEndBonuses({
      rawScore: e.score,
      accuracy,
      bestCombo: e.maxStreak,
      totalActions: e.dodges,
      mistakes: e.hitsTaken,
      livesRemaining: scoringLives(0),
      category: 'cognitive',
    });

    const finalScore = bonuses.finalScore;
    const prev = getSavedData();
    const isNewBest = finalScore > prev.bestScore;
    const firstPlay = prev.totalSessions === 0;

    const daily = isChallenge
      ? { isDailyDrill: false, wouldCompleteSet: false }
      : await previewDailyCompletion('quick-dodge');

    // Captured BEFORE the run is banked: the result screen's XP bar animates
    // from the level the player walked in with to the one they walk out with.
    const progress = await getPlayerLevel();

    const xpResult = calcSessionXP({ finalScore, accuracy, isNewBest, firstPlay, dailyChallenge: daily.isDailyDrill, dailyChallengeSetComplete: daily.wouldCompleteSet });

    const updated = {
      bestScore: Math.max(prev.bestScore, finalScore),
      bestCombo: Math.max(prev.bestCombo, e.maxStreak),
      bestLevel: Math.max(prev.bestLevel, e.level),
      totalSessions: prev.totalSessions + 1,
    };
    saveData(updated);
    setBestScore(updated.bestScore);
    setBestCombo(updated.bestCombo);
    setBestLevel(updated.bestLevel);

    saveLeaderboardEntrySync({ drillId: 'quick-dodge', drillName: 'Quick Dodge', category: 'cognitive', score: finalScore, accuracy, bestCombo: e.maxStreak });

    setEndSummary({
      progress,
      score: finalScore,
      accuracy,
      bestCombo: e.maxStreak,
      level: e.level,
      isNewBest,
      xpEarned: xpResult.xp,
      prevBest: prev.bestScore,
    });
  }, []);

  const scheduleHeartbeat = useCallback(() => {
    if (isChallenge) return;
    if (!gameActiveRef.current) return;
    const e = engine.current;
    const dangerFromLives = 0;   // lives are gone; time is the only danger now
    const dangerFromTime = e.timeLeft <= 10 ? (10 - e.timeLeft) / 10 : 0;
    const danger = Math.min(1, Math.max(dangerFromLives * 0.7, dangerFromTime));
    const tempo = Math.max(350, Math.round(1100 - danger * 650));
    heartbeatTempoRef.current = tempo;
    if (danger > 0.08) audioSynth?.playHeartbeat(danger);
    // Quantised to 0.1 steps. The raw float re-rendered the whole component on
    // every heartbeat, and that re-render rewrites the vignette's inline
    // --v-min/--v-max AND its animation-duration. Changing a running CSS
    // animation's duration restarts it on the main thread and drops it off the
    // compositor's fast path, so a full-screen layer over the play field was
    // being re-resolved roughly once a second. Bucketed, the style string is
    // identical between buckets and the animation just keeps running.
    const bucket = Math.round(danger * 10) / 10;
    setDangerLevel((d) => (d === bucket ? d : bucket));
    heartbeatTimerRef.current = setTimeout(scheduleHeartbeat, tempo);
  }, [isChallenge]);

  const triggerFlash = (variant) => {
    const id = Date.now();
    setFlashes(prev => [...prev, { id, variant }]);
    setTimeout(() => setFlashes(prev => prev.filter(f => f.id !== id)), 350);
  };

  // ── Move the dot ────────────────────────────────────────────────────────
  // Deliberately NOT part of the fixed physics step, and this is the other half
  // of the "the stick lags my thumb" fix.
  //
  // gameStep runs on a fixed 1/60 clock so hit detection and the difficulty
  // ramp stay deterministic, and the renderer hides the unevenness of that by
  // INTERPOLATING the hazards across it. The player was never interpolated — it
  // was drawn at the raw stepped position — so on any frame where the
  // accumulator did not reach a whole step, the dot did not move while
  // everything around it did. On a 60Hz panel that is the odd stalled frame; on
  // the 90 and 120Hz phones this ships to it is structural, because a 1/60 step
  // can only land on two frames in three (90Hz) or one in two (120Hz). The
  // thumb was being sampled every frame and acted on a fraction of them, which
  // is exactly what "the joystick has a delay" feels like.
  //
  // A directly controlled object does not need to be deterministic, it needs to
  // be immediate. This integrates once per RENDERED frame against the display
  // interval, so the dot advances on every single vsync. Nothing is smoothed
  // and nothing is interpolated: where the thumb is this frame is where the dot
  // is this frame.
  const movePlayer = useCallback((dt) => {
    const s = stickRef.current;
    const e = engine.current;
    const pl = e.player;

    // Pick the response constant from what the thumb is asking for RELATIVE to
    // where the dot is already going — see the three-tau note at the top of the
    // file. Speeding up is eased (so the dot does not snap to full and overshoot
    // every gap); turning and stopping are near-immediate (so the dot never
    // coasts on past the point the player stopped steering it).
    let tau;
    if (s.vx === 0 && s.vy === 0) {
      tau = PLAYER_STOP_TAU;
    } else {
      const dot = s.vx * pl.vx + s.vy * pl.vy;
      // Guard the zero case: from a standstill any demand is an acceleration,
      // and dot/mag would be 0/0.
      const mag = Math.hypot(pl.vx, pl.vy) * Math.hypot(s.vx, s.vy);
      tau = (mag > 0 && dot < mag * PLAYER_TURN_COS) ? PLAYER_TURN_TAU : PLAYER_ACCEL_TAU;
    }

    // Exponential approach against dt rather than a fixed per-frame fraction,
    // so the feel is identical at 60, 90 and 120Hz — a plain lerp would make
    // the dot accelerate twice as fast on a 120Hz panel.
    const k = 1 - Math.exp(-dt / tau);
    pl.vx += (s.vx - pl.vx) * k;
    pl.vy += (s.vy - pl.vy) * k;

    // Stop cleanly. Without this the ease-out never quite reaches zero and the
    // dot creeps for the rest of the round.
    if (s.vx === 0 && s.vy === 0 &&
        Math.abs(pl.vx) < PLAYER_VEL_EPSILON && Math.abs(pl.vy) < PLAYER_VEL_EPSILON) {
      pl.vx = 0; pl.vy = 0;
    }
    if (pl.vx === 0 && pl.vy === 0) return;

    // Per-axis scale that turns one pixel speed into the two percentage speeds
    // this coordinate system needs. x is the reference axis, so it is 1; y is
    // stretched by the aspect ratio, which is exactly the factor the render
    // divides back out for the field height. This is what keeps the dot moving
    // at the same speed in every direction rather than at the field's aspect.
    const aspect = (e.containerH > 0) ? e.containerW / e.containerH : 1;

    // Same 3..97 walls as before, but the velocity into a wall is zeroed as
    // well as the position. With momentum in the system, clamping position
    // alone would let the dot bank a full tank of unspent speed while held
    // against an edge and then fling itself off the moment the thumb turned.
    const nx = pl.x + pl.vx * PLAYER_MAX_SPEED * dt;
    if (nx <= 3)       { pl.x = 3;  if (pl.vx < 0) pl.vx = 0; }
    else if (nx >= 97) { pl.x = 97; if (pl.vx > 0) pl.vx = 0; }
    else               { pl.x = nx; }

    const ny = pl.y + pl.vy * PLAYER_MAX_SPEED * aspect * dt;
    if (ny <= 3)       { pl.y = 3;  if (pl.vy < 0) pl.vy = 0; }
    else if (ny >= 97) { pl.y = 97; if (pl.vy > 0) pl.vy = 0; }
    else               { pl.y = ny; }
  }, []);

  // Hoisted out of runGameLoop. It used to be re-created on every round, which
  // handed V8 a brand-new closure to profile and optimise each time the player
  // pressed Play Again — and, more importantly, made it impossible to warm this
  // exact function during the countdown. One instance now serves every round.
  const gameStep = useCallback((dt) => {
      const e = engine.current;

      e.timeLeft -= dt;
      e.elapsedTime += dt;

      // The elapsed-time stop is the duel's fixed window. In solo the run is
      // bounded by the clock and the lives, not by a wall-clock ceiling.
      if (e.timeLeft <= 0 || (isChallenge && e.elapsedTime >= totalTime)) {
        e.timeLeft = Math.max(0, e.timeLeft);
        endGame('time');
        return true;
      }

      updateDifficulty();

      // The dot is NOT moved here any more — see movePlayer, which the render
      // loop runs once per rendered frame just before this step. Everything
      // below still reads e.player, and reads it AFTER the move, so collisions
      // are tested against the position the player can already see.

      e.spawnTimer += dt;
      if (e.spawnTimer > e.spawnDelay && e.obstacles.length < e.maxEnemies) {
        spawnObstacle();
        e.spawnTimer = 0;
      }

      // Floor raised from 0.15 to 0.28 (and ceiling from 0.85 to 1.13
      // rad/sec) — even level-1 obstacles now visibly curve toward the
      // player instead of nearly flying past in a straight line, and top-level
      // obstacles track aggressively enough that standing still is a losing
      // move.
      // Clamped for the same reason as sizeScale in spawnObstacle: levels keep
      // climbing past the end of LEVEL_TABLE, so this fraction ran past 1.0 and
      // the homing rate kept growing without limit — by level 30 obstacles
      // turned toward the player more than twice as hard as the 1.13 rad/sec
      // the comment above describes as the top of the range, which is fast
      // enough that no amount of dodging helps.
      const homingRate = 0.28 + Math.min(1, (e.level - 1) / (LEVEL_TABLE.length - 1)) * 0.85;
      let playerHit = false;
      const px = e.player.x;
      const py = e.player.y;
      // Was 1.5 — smaller than the player dot actually renders at (pr =
      // minDim * 0.024, i.e. ~2.4% of minDim in this same percentage-of-field
      // space). A near-miss that visibly grazed the dot wasn't registering as
      // a hit, which was a big part of why the drill felt too forgiving.
      // 2.6 now matches (slightly exceeds) the rendered dot.
      const PLAYER_HIT_R = 2.6;

      for (let i = e.obstacles.length - 1; i >= 0; i--) {
        const o = e.obstacles[i];

        if (homingRate > 0) {
          const currentAngle = Math.atan2(o.vy, o.vx);
          const targetAngle = Math.atan2(py - o.y, px - o.x);
          let diff = targetAngle - currentAngle;
          diff = Math.atan2(Math.sin(diff), Math.cos(diff));
          const maxSteer = homingRate * dt;
          const steer = Math.max(-maxSteer, Math.min(maxSteer, diff));
          const newAngle = currentAngle + steer;
          o.vx = Math.cos(newAngle) * o.speed;
          o.vy = Math.sin(newAngle) * o.speed;
        }

        // Previous position, for render interpolation. See the alpha note in
        // the render loop: physics advances in discrete 1/60 steps, but frames
        // do not land on those steps, so the renderer draws between them.
        o.px = o.x;
        o.py = o.y;

        o.x += o.vx * dt;
        o.y += o.vy * dt;
        o.r += (o.maxR - o.r) * 2.0 * dt;

        const dist = Math.hypot(px - o.x, py - o.y);
        const hitRadius = o.r + PLAYER_HIT_R;

        if (dist < hitRadius) {
          playerHit = true;
          break;
        }

        if (o.x < -15 || o.x > 115 || o.y < -15 || o.y > 115) {
          e.obstacles.splice(i, 1);
          e.dodges++;
          e.streak++;
          if (e.streak > e.maxStreak) e.maxStreak = e.streak;

          const comboMult = getComboMultiplier(e.streak);
          const pts = Math.floor(e.basePoints * comboMult);
          e.score += pts;
          // Buy back a slice of the clock. Solo only - in a duel the clock comes from
          // duelDeadlineRef (the match's shared absolute end instant), which nothing
          // local may move. No state is set here; the existing tick redraws the
          // seconds when the displayed number changes, so this costs nothing per hit.
          if (!isChallenge) {
            e.timeLeft = applyHit({ timeRemaining: e.timeLeft, level: e.level });
          }

          if (e.streak > 0 && e.streak % 5 === 0) {
            audioSynth?.playHit();
            spawnBurst(px, py, '#fbbf24', 14);
          }
        }
      }

      if (playerHit) {
        e.hitsTaken++;
        if (!isChallenge) {
          const after = applyMistake({ timeRemaining: e.timeLeft });
          e.timeLeft = after.timeRemaining;
          e.runOver = after.runOver;
        } else {
          e.score = Math.max(0, e.score - 5);
        }
        e.streak = 0;

        audioSynth?.playPenalty();
        triggerFlash('red');
        spawnShockwave(px, py, '254,202,202');
        spawnBurst(px, py, '#fecaca', 10);

        // Was 12 — the post-hit mercy clear was wiping out most of the
        // nearby board on every hit, which combined with the weak hitbox
        // above made getting hit almost consequence-free for the next second.
        const clearRadius = 8;
        e.obstacles = e.obstacles.filter(o => Math.hypot(px - o.x, py - o.y) > clearRadius);

        if (!isChallenge && e.runOver) {
          endGame('time');
          return true;
        }
      }

      // HUD sync.
      //
      // This used to be five setState calls at 15Hz, guarded by functional
      // updates so React could bail out when a value was unchanged. The
      // bail-out never fired for the two values that matter: `score` moves on
      // almost every dodge and `timeLeft` moves every second, so in practice
      // the whole component re-rendered ~15 times a SECOND, from inside the
      // physics loop. Each of those renders rebuilt the entire JSX tree —
      // DrillWrapper, the level badge, the vignette, every wrapper div —
      // allocating a few hundred short-lived objects a second purely to repaint
      // two numbers. That is what produced the stutter every couple of seconds:
      // not the render loop, but the garbage collector catching up with it.
      //
      // Score and the clock are now written straight to their text nodes. A
      // textContent assignment touches one DOM node and never re-enters React,
      // so it costs nothing measurable and produces no garbage.
      const shownTime = Math.ceil(e.timeLeft);
      if (scoreElRef.current && hudScoreRef.current !== e.score) {
        hudScoreRef.current = e.score;
        scoreElRef.current.textContent = String(e.score);
      }
      if (timeElRef.current && hudTimeRef.current !== shownTime) {
        hudTimeRef.current = shownTime;
        timeElRef.current.textContent = shownTime + 's';
        // The clock turns red under 10s. Toggling a class on one node is still
        // cheaper than a React render, and it only happens once per run.
        timeElRef.current.className = TIME_CLS + (shownTime <= 10 ? ' text-red-500 animate-pulse' : ' text-slate-300');
      }

      // Level changes a handful of times per run, so it stays on state.
      // Still guarded, so an unchanged value costs nothing.
      if (hudLevelRef.current !== e.level) { hudLevelRef.current = e.level;}

      // Score and time only need to reach React state in a DUEL: DrillWrapper
      // watches timeLeft hitting 0 and submits whatever `score` holds. Nothing
      // on screen reads them (the HUD above is ref-driven), so in SOLO this was
      // a full re-render of this component AND DrillWrapper once every second,
      // for two values nobody rendered — the largest recurring main-thread cost
      // and garbage source left in the round. endGame flushes the final pair, so
      // solo results are unaffected.
      if (isChallenge && hudStateTimeRef.current !== shownTime) {
        hudStateTimeRef.current = shownTime;
        setScore(e.score);
        setTimeRemaining(shownTime);
      }

      return false;
  }, [endGame, spawnObstacle, updateDifficulty, spawnBurst, spawnShockwave, totalTime, isChallenge]);

  useEffect(() => { gameStepRef.current = gameStep; }, [gameStep]);

  const runGameLoop = useCallback(() => {
    // Physics used to own a SECOND requestAnimationFrame loop of its own,
    // running alongside the canvas one. Two rAF callbacks per frame is double
    // the scheduling and wake-up cost for no benefit — and because the two were
    // independent, the renderer sampled the world at an arbitrary point
    // relative to a physics step, which added jitter of its own on top of the
    // stepping problem described in the render loop. The stepper is just handed
    // over here and driven from the single loop that draws.
    stepRef.current = gameStep;
    lastTimeRef.current = 0;
  }, [gameStep]);

  const runCountdown = useCallback((n) => {
    if (countdownTimerRef.current) clearTimeout(countdownTimerRef.current);
    if (n <= 0) {
      if (!isChallenge) audioSynth?.playGo();
      setPhase('playing');
      gameActiveRef.current = true;

      const e = engine.current;
      // Every run starts at the lowest difficulty. It used to start at 55% of the
      // player's best level, so improving once permanently raised the speed every
      // future run opened at - a silent spike with nothing on screen explaining it.
      // That head-start only existed because a fixed 45s was too short to climb the
      // ramp; the endurance clock replaces it.
      const startLevel = 1;
      const startBracket = LEVEL_TABLE[startLevel - 1];

      e.player = { x: 50, y: 50, vx: 0, vy: 0 };
      // A round must never open with the previous round's stick still pushed —
      // the pointer that set it was released on the result screen, where the
      // handlers are inert. But a thumb that is STILL DOWN keeps its stick:
      // the countdown anchors one now, and wiping it here would put the dead
      // half-second straight back at the start of every round.
      {
        const st = stickRef.current;
        if (!st.active) {
          st.pointerId = null;
          st.vx = 0; st.vy = 0;
        }
        st.dirty = true;
      }
      e.obstacles = [];
      e.obstacleIdCounter = 0;
      e.score = 0; e.streak = 0; e.maxStreak = 0;
      e.dodges = 0; e.hitsTaken = 0; e.nearMisses = 0; e.runOver = false;
      e.timeLeft = totalTime; e.elapsedTime = 0;
      e.level = startLevel;
      e.fracLevel = startLevel;
      e.speed = startBracket.speed; e.spawnDelay = startBracket.spawnDelay;
      e.maxEnemies = startBracket.maxEnemies; e.basePoints = startBracket.basePoints;
      e.spawnTimer = 0;

      particlesRef.current = [];
    shockwavesRef.current = [];
      setScore(0); setTimeRemaining(totalTime);
      // Mirrors for the ref-driven HUD, so the first step after the countdown
      // is guaranteed to write both nodes rather than think they are current.
      hudScoreRef.current = -1;
      hudTimeRef.current = -1;
      hudStateTimeRef.current = -1;
      hudLevelRef.current = startLevel;

      runGameLoop();
      scheduleHeartbeat();
      return;
    }
    setCountdownValue(n);
    if (!isChallenge) audioSynth?.playCountdownTick();
    countdownTimerRef.current = setTimeout(() => runCountdown(n - 1), 700);
  }, [runGameLoop, scheduleHeartbeat, bestLevel, totalTime, isChallenge]);

  const enterDrill = useCallback(async () => {
    // Unmount the start card on the tap itself, before the rotation begins.
    setLaunching(true);
    try { if (audioSynth) audioSynth.init(); } catch {}

    gameActiveRef.current = false;
    if (countdownTimerRef.current) clearTimeout(countdownTimerRef.current);
    if (heartbeatTimerRef.current) clearTimeout(heartbeatTimerRef.current);
    stepRef.current = null;

    setScore(0); setTimeRemaining(totalTime);
setDangerLevel(0); setEndSummary(null);
    // The countdown HUD seeds itself straight off the engine, so clear the
    // previous run's leftovers before it paints.
    engine.current.score = 0;
    engine.current.timeLeft = totalTime;
    // Cleared here as well as at the end of the countdown, because the
    // countdown's warm-up now runs the real stepper — and the stepper's first
    // act is `if (e.elapsedTime >= totalTime) endGame()`. Left at the previous
    // run's ~45 it would end the round before it started.
    engine.current.elapsedTime = 0;
    setFlashes([]);

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
        runCountdown(isChallenge ? 0 : 3);
      }
    });
  }, [runCountdown, isChallenge, totalTime]);

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
    setLaunching(false);
    setScore(0);
    setEndSummary(null);
    setTimeRemaining(totalTime);
  }, [challengeId, totalTime]);

  useEffect(() => {
    const handleResize = () => {
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
    const cancelSettle = phase === 'rotate-hint' ? afterViewportSettled(handleResize) : null;
    const stopListening = onOrientationSettled(handleResize);
    return () => { if (cancelSettle) cancelSettle(); stopListening(); };
  }, [phase, runCountdown, isChallenge]);

  // The score/clock nodes render empty (see the note on them in the JSX), so
  // they need one seed write when the play layer mounts — otherwise the HUD is
  // blank through the whole countdown, until the first physics step lands.
  useEffect(() => {
    if (phase !== 'playing' && phase !== 'countdown') return;
    const e = engine.current;
    hudScoreRef.current = -1;
    hudTimeRef.current = -1;
    if (scoreElRef.current) scoreElRef.current.textContent = String(e.score);
    if (timeElRef.current) {
      timeElRef.current.textContent = Math.ceil(e.timeLeft) + 's';
      timeElRef.current.className = TIME_CLS + ' text-slate-300';
    }
  }, [phase]);

  // Canvas render loop
  const playLayerMounted = phase === 'playing' || phase === 'countdown';

  useEffect(() => {
    if (!playLayerMounted) {
      if (drawAnimRef.current) { cancelAnimationFrame(drawAnimRef.current); drawAnimRef.current = null; }
      return;
    }

    const resizeCanvas = () => {
      const cvs = canvasRef.current;
      const el = containerRef.current;
      if (!cvs || !el) return;
      const rect = el.getBoundingClientRect();
      const dpr = motionDpr();
      const bw = Math.round(rect.width * dpr);
      const bh = Math.round(rect.height * dpr);
      // Writing canvas.width/height ALWAYS reallocates the backing store and
      // clears it, even when assigning the identical number. Landscape here is
      // ~2.6MP, and Android fires a BURST of resize events through the rotation
      // animation at drill start, so this was reallocating a 2.6MP surface many
      // times in the frames right before the countdown. Guard on real change.
      if (cvs.width !== bw || cvs.height !== bh) {
        cvs.width = bw;
        cvs.height = bh;
      }
      canvasSizeRef.current = { width: rect.width, height: rect.height };
      engine.current.containerW = rect.width;
      engine.current.containerH = rect.height;
    };

    resizeCanvas();
    const ro = new ResizeObserver(resizeCanvas);
    if (containerRef.current) ro.observe(containerRef.current);
    window.addEventListener('resize', resizeCanvas);
    window.addEventListener('orientationchange', resizeCanvas);

    // ── Hazard node pool ───────────────────────────────────────────────
    // One pooled DOM node per hazard, built once and reused for the whole
    // session. Sized off LEVEL_TABLE's ceiling with four spare, which covers
    // the frame where a spawn lands before an escape is reaped.
    //
    // Each node is a zero-sized origin div (which is what the per-frame
    // transform moves) holding a trail, a body circle, a core dot and a pulse
    // ring. Only the origin's translate and the body's scale are ever written
    // from JS; the pulse ring is a CSS animation the compositor owns outright.
    const POOL = MAX_HAZARDS + 4;
    // Passed to renderObstacles when the intent is purely "release everything"
    // — a frozen literal so the release sweep never allocates.
    const EMPTY = [];
    const nodes = [];
    const nodeFree = new Uint8Array(POOL).fill(1);
    const nodeGen = new Int32Array(POOL);
    // 1 = the node is display:none, i.e. it has no compositor layer at all.
    const nodeDark = new Uint8Array(POOL).fill(1);
    // Timestamp a node became free, for the grace period below.
    const nodeFreeAt = new Float64Array(POOL);
    let gen = 0;

    // ── Why freeing a node does not immediately hide it ──────────────────
    // A hazard's node is released the frame after the hazard stops appearing,
    // and reclaimed the frame a new hazard spawns. Going straight to
    // display:none on release meant every one of those round-trips destroyed a
    // compositor layer and then built a fresh one: style recalc, paint of the
    // body / core / ring, layer promotion, texture upload.
    //
    // At the TOP of LEVEL_TABLE spawnDelay is 0.045s — twenty spawns a second,
    // and twenty reaps to match — so that was ~40 layer teardowns and rebuilds
    // every second, on the main thread, in the drill that can least afford
    // them. At the BOTTOM it is the first thing that happens after GO: the
    // countdown's warm-up promoted all 56 layers and then threw every one of
    // them away, so the opening hazards each paid full layer-creation cost
    // exactly where the jitter was being reported.
    //
    // So a freed node is only made CHEAP straight away — opacity 0 and its
    // pulse-ring keyframes stopped, which is what the heat fix was really
    // about (an invisible node running an animation is compositor work for
    // something nobody can see). It keeps its layer for a grace period, and a
    // spawn inside that window reclaims it for three style writes instead of a
    // rebuild. Only a node that has genuinely gone idle goes fully dark.
    //
    // 1200ms is picked to span the gap between the end of the countdown
    // warm-up and the first spawns of the round, so the round opens on layers
    // that are already promoted.
    const NODE_HIDE_MS = 1200;

    const buildPool = () => {
      const layer = obLayerRef.current;
      if (!layer || nodes.length) return;
      const frag = document.createDocumentFragment();
      for (let i = 0; i < POOL; i++) {
        const root = document.createElement('div');
        root.className = 'qd-ob';
        // Free nodes are display:none, not merely transparent. This is the
        // second half of the heat fix. The pool is sized off LEVEL_TABLE's
        // ceiling (60 nodes), but level 1 uses NINE — and an opacity:0 node
        // still has a compositor layer (it is will-change'd and translated in
        // 3D) and still runs its pulse-ring keyframes, which the compositor
        // ticks on every single frame. That is ~50 layers being animated for
        // something nobody can see, for most of a run. display:none takes them
        // out of the layer tree entirely and stops their animations dead, and
        // costs one style write on the frames a hazard spawns or is reaped.
        root.style.display = 'none';
        const trail = document.createElement('div');
        trail.className = 'qd-ob-trail';
        const body = document.createElement('div');
        body.className = 'qd-ob-body';
        const core = document.createElement('div');
        core.className = 'qd-ob-core';
        const ring = document.createElement('div');
        ring.className = 'qd-ob-ring';
        body.appendChild(core);
        body.appendChild(ring);
        root.appendChild(trail);
        root.appendChild(body);
        frag.appendChild(root);
        // sizedR / sizedTrail / rot are the last values written, so a frame
        // that would write the same thing writes nothing at all. Only the
        // origin's translate genuinely changes on every single frame.
        // tx/ty are the last translate actually written, so a hazard that has
        // not moved a tenth of a pixel since the previous frame writes nothing
        // — see the note at the write site.
        nodes.push({ root, trail, body, ring, sizedR: -1, sizedTrail: -1, rot: 999, scaled: -1, tx: NaN, ty: NaN });
      }
      layer.appendChild(frag);
    };

    // ── Player dot ─────────────────────────────────────────────────────
    // The body used to be a sprite blit and the halo and pulse ring were two
    // live arc() passes per frame, driven off `time`. All three are static
    // pictures whose only animation is a scale and a fade, so they are CSS
    // now: the halo breathes on a 2.094s ease (the old sin(time*3)) and the
    // ring expands to 2.4x over 1.5s (the old drawPulseRing arguments). The
    // compositor runs both, which means they keep their timing even on a frame
    // where the main thread is busy — and the loop's whole job for the player
    // is one transform write.
    //
    // Sized in px whenever the radius changes, which is on a resize and
    // otherwise never.
    let playerSizedR = -1;
    // Last translate written to the player node; see the skip at the write site.
    let playerTx = NaN;
    let playerTy = NaN;
    const ensurePlayerSize = (pr) => {
      const el = playerElRef.current;
      if (!el || playerSizedR === pr) return;
      playerSizedR = pr;
      const body = el.children[2];
      const ring = el.children[1];
      const halo = el.children[0];
      if (!body || !ring || !halo) return;
      // Halo: the old radius swung between pr*1.8 and pr*2.34, so the element
      // is the larger of the two and the keyframes scale it down to 0.77.
      const hr = pr * 2.34;
      halo.style.cssText = `position:absolute;border-radius:9999px;background:rgba(16,185,129,.14);left:${-hr}px;top:${-hr}px;width:${hr * 2}px;height:${hr * 2}px;animation:qdHalo 2.094s ease-in-out infinite;`;
      ring.style.left = -pr + 'px';
      ring.style.top = -pr + 'px';
      ring.style.width = pr * 2 + 'px';
      ring.style.height = pr * 2 + 'px';
      body.style.left = -pr + 'px';
      body.style.top = -pr + 'px';
      body.style.width = pr * 2 + 'px';
      body.style.height = pr * 2 + 'px';
      el.style.opacity = '1';
    };

    // Physics runs on a fixed 1/60 timestep so difficulty and hit detection
    // are deterministic. That is correct, but it is ALSO why the obstacles
    // juddered: real frames do not arrive exactly 1/60 apart, so an accumulator
    // yields 2 steps on one frame and 0 on the next. A 0-step frame redraws the
    // obstacles at the identical position — a freeze — and the following
    // 2-step frame jumps them double the distance. Several times a second.
    //
    // The fix is not to change the timestep, it is to stop drawing the raw
    // physics state: `alpha` is how far the clock sits between the last
    // completed step and the next one, and obstacles are drawn interpolated
    // across that fraction. Frames then show even motion no matter how the
    // steps fall.
    let accumulator = 0;
    let alpha = 1;

    // Learned display interval, for the vsync quantiser in the draw loop.
    // 0 = not learned yet. Tracked off `prevTs`, which ticks on every frame
    // including the countdown, so the round opens with a converged estimate
    // instead of learning one from its own first (slow) frames.
    let vsyncMs = 0;
    let prevTs = 0;
    let vsyncOutliers = 0;
    // Parity for the high-refresh throttle in the draw loop.
    let frameParity = 0;


    // ── Cold-path warm-up state ────────────────────────────────────────
    // Dummy obstacles the countdown runs the real render and physics code
    // against. Built with the SAME property set in the SAME order as
    // spawnObstacle produces, so V8 sees one hidden class from the warm-up
    // straight through into the round — a differently-shaped warm-up object
    // would make the real loop polymorphic and cost more than it saved.
    // Parked on a ring 30 units from the centre: inside the field (so the
    // escape branch never fires) and well clear of the player (so the hit
    // branch never fires) when the stepper is run at dt = 0.
    const WARM_FRAMES = 40;
    let warmFrames = WARM_FRAMES;
    let warmObstacles = null;
    // Drives the once-every-eighth-frame keep-alive pass that holds the
    // warm-up's layers open for the rest of the countdown.
    let keepAliveTick = 0;
    const buildWarmObstacles = () => {
      const list = [];
      for (let i = 0; i < MAX_HAZARDS; i++) {
        const ang = (i / MAX_HAZARDS) * Math.PI * 2;
        const maxR = 4.95 * 1.4;
        list.push({
          id: 100000 + i,
          x: 50 + Math.cos(ang) * 30,
          y: 50 + Math.sin(ang) * 30,
          px: 50 + Math.cos(ang) * 30,
          py: 50 + Math.sin(ang) * 30,
          vx: Math.cos(ang + Math.PI) * 20,
          vy: Math.sin(ang + Math.PI) * 20,
          speed: 20,
          r: maxR * 0.6,
          maxR,
          nearMissTriggered: false,
          nodeIdx: -1,
        });
      }
      return list;
    };

    // Fetched once, not per frame. getContext returns the same object every
    // time, so calling it 60x a second was pure overhead.
    // Transparent: the play-field backdrop is a static CSS layer behind this
    // canvas now (see the render block), so it MUST show through — see the
    // alpha:false note in lib/canvasFx.js.
    //
    // This canvas no longer carries the game. It holds ONLY the hit effects
    // (shockwave rings and sparks), so on a clean run it is never touched at
    // all: no clearRect, no paths, and above all no full-screen surface being
    // re-rasterised sixty times a second underneath the hazards.
    let ctx = canvasRef.current?.getContext('2d', { alpha: true }) || null;
    let fxWasDrawn = false;

    // ── Hazard pass ────────────────────────────────────────────────────
    // This replaces the four batched canvas passes that used to draw the
    // hazards (wash, outline, core dot, pulse rings). Those were already about
    // as cheap as canvas gets — measured at well under 1.5ms of a 16.7ms frame
    // — and the drill still juddered, because the cost was never the paths. It
    // was that a full-screen canvas whose pixels change every frame has to be
    // re-rasterised and handed to the compositor every frame, and any hitch on
    // the main thread (a GC pause, the audio scheduler, a React render) lands
    // directly on the position of every hazard on screen.
    //
    // visual-tracking-speed-test is smooth because its moving object is a DOM
    // element: the main thread writes a transform, the compositor does the
    // rest, and nothing is rasterised. Same thing here — the only difference
    // is that this drill has up to 44 of them, so the nodes are pooled and
    // sized once rather than created per spawn.
    //
    // What the loop writes per hazard per frame:
    //   • the origin node's translate       — always
    //   • the body's scale                  — only while it is still growing in
    //   • the trail's rotation              — only when the heading moved
    // and nothing else. The pulse ring is a CSS animation the compositor owns,
    // so it costs the main thread literally nothing and cannot judder.
    //
    // `a` is the render interpolation fraction; see the alpha note above.
    // `offY` shoves the whole pass off-screen for the countdown warm-up.
    // `now` is the frame timestamp, for the release grace period.
    // `hardHide` skips the grace and darkens every free node this frame — used
    // when the round is over and nothing may be left holding a layer.
    let layerCls = '';
    let ringPeriod = -1;
    const renderObstacles = (obs, a, levelProgress, w, h, minDim, offY, now, hardHide) => {
      const layer = obLayerRef.current;
      if (!layer) return;
      if (!nodes.length) buildPool();

      // Level-dependent styling, written to the LAYER rather than to each
      // node — one class write retimes and recolours all 44 at once.
      // qd-calm drops the per-hazard pulse rings from the level where the
      // board stops being sparse (~20 hazards). See the note in globals.css:
      // they are the biggest GPU cost left in this drill and they cost the
      // most exactly where the device is already hottest.
      // qd-calm at 0.18 rather than 0.25 — the rings now come off from about
      // level 3 instead of level 4.5. They are the drill's most expensive
      // decoration per hazard and the board is already at 13 hazards there.
      const cls = 'qd-layer' + (levelProgress >= 0.4 ? ' qd-trails' : '') + (levelProgress >= 0.65 ? ' qd-glow' : '') + (levelProgress >= 0.18 ? ' qd-calm' : '');
      if (cls !== layerCls) { layerCls = cls; layer.className = cls; }
      const period = Math.max(0.55, 1.3 - levelProgress * 0.75);
      if (period !== ringPeriod) {
        ringPeriod = period;
        layer.style.setProperty('--qd-ring-period', period + 's');
      }

      // Trail length. The canvas version scaled vx by width and vy by height
      // independently, which stretched the trail in landscape; a rotated
      // element can only have one length, so it uses the mean of the two axes.
      // Speed is a level constant, so this changes on a level-up and never
      // otherwise.
      const trailLen = Math.round(((obs.length ? obs[0].speed : 0) / 100) * ((w + h) * 0.5) * 0.05);

      gen++;
      for (let i = 0; i < obs.length; i++) {
        const o = obs[i];

        // Claim a node. `nodeFree` is the authority, so a hazard holding a
        // stale index (its node was reclaimed while it was off the list) is
        // simply given a fresh one rather than fighting over someone else's.
        let n = o.nodeIdx;
        if (n < 0 || nodeFree[n] === 1) {
          n = -1;
          for (let k = 0; k < POOL; k++) { if (nodeFree[k] === 1) { n = k; break; } }
          // Pool exhausted (it cannot be — POOL is LEVEL_TABLE's ceiling plus
          // four — but if it ever were, clearing the index is what stops this
          // hazard reclaiming a slot that now belongs to someone else and
          // having the two of them fight over one node's transform).
          if (n < 0) { o.nodeIdx = -1; continue; }
          nodeFree[n] = 0;
          o.nodeIdx = n;
          const fresh = nodes[n];
          fresh.sizedR = -1; fresh.sizedTrail = -1; fresh.rot = 999; fresh.scaled = -1;
          // Stagger the ring so 44 hazards do not pulse in lockstep. A
          // negative delay starts the animation already part-way through,
          // which is the CSS equivalent of the old `(time + id*0.37) % period`.
          fresh.ring.style.animationDelay = (-((o.id * 0.37) % period)) + 's';
          // '' rather than 'block', so `.qd-calm .qd-ob-ring { display:none }`
          // still wins on a busy board — an inline 'block' here would put
          // every pulse ring back exactly where they were turned off for heat.
          fresh.ring.style.display = '';
          // Only touched when the node had actually gone dark. Inside the
          // grace window this is the whole cost of a reclaim: one opacity
          // write, on a layer that already exists.
          if (nodeDark[n]) { nodeDark[n] = 0; fresh.root.style.display = 'block'; }
          fresh.root.style.opacity = '1';
        }
        nodeGen[n] = gen;
        const nd = nodes[n];

        // Interpolated centre. Physics advances in discrete 1/60 steps but
        // frames do not land on those steps, so the node is placed between
        // them — the same reason the canvas version interpolated.
        const opx = o.px === undefined ? o.x : o.px;
        const opy = o.py === undefined ? o.y : o.py;
        const cx = ((opx + (o.x - opx) * a) / 100) * w;
        const cy = ((opy + (o.y - opy) * a) / 100) * h + offY;

        // Full-size radius in px. Changes on a level-up and on a resize; the
        // grow-in from spawn size is the scale below, not a resize.
        const R = (o.maxR / 100) * minDim;
        if (nd.sizedR !== R) {
          nd.sizedR = R;
          const bs = nd.body.style;
          const d = R * 2;
          bs.left = -R + 'px';
          bs.top = -R + 'px';
          bs.width = d + 'px';
          bs.height = d + 'px';
        }
        if (nd.sizedTrail !== trailLen) {
          nd.sizedTrail = trailLen;
          nd.trail.style.width = trailLen + 'px';
        }

        // Rounding is unchanged at a tenth of a pixel — this drill has a long
        // history of judder introduced by quantising things, and the fix here
        // is NOT to round harder. It is to notice when the rounded value is
        // the value already on the node and write nothing.
        //
        // Building this string is five concatenations, and at 56 hazards times
        // 60fps that is on the order of 17,000 short-lived strings a second
        // for the transforms alone — which is what the young generation fills
        // up with between the scavenges that show as a dropped frame every few
        // seconds. Every hazard that is momentarily still (a slow level-1
        // crossing advances well under a tenth of a pixel per frame) and every
        // parked node in the countdown keep-alive now costs nothing at all.
        const tx = Math.round(cx * 10) / 10;
        const ty = Math.round(cy * 10) / 10;
        if (tx !== nd.tx || ty !== nd.ty) {
          nd.tx = tx; nd.ty = ty;
          nd.root.style.transform = 'translate3d(' + tx + 'px,' + ty + 'px,0)';
        }

        // Grow-in. Once it is within half a percent of full size it is pinned
        // at 1 and never written again for the rest of this hazard's life.
        if (nd.scaled !== 1) {
          let s = o.r / o.maxR;
          if (s > 0.995) s = 1;
          const q = Math.round(s * 100) / 100;
          if (q !== nd.scaled) {
            nd.scaled = q;
            nd.body.style.transform = q === 1 ? 'scale(1)' : 'scale(' + q + ')';
          }
        }

        // Trail heading, pointing back along the direction of travel.
        // Quantised to 3 degrees: the trail is a 4px bar, so 3 degrees is not
        // visible on it, and the homing rate tops out near 65 deg/sec — which
        // means this writes on roughly one frame in three instead of all of
        // them, and the node's layer is repainted that much less often.
        if (levelProgress >= 0.4) {
          const deg = Math.round(Math.atan2(-o.vy, -o.vx) * 19.098593171027442) * 3;
          if (deg !== nd.rot) {
            nd.rot = deg;
            nd.trail.style.transform = 'rotate(' + deg + 'deg)';
          }
        }
      }

      // Hand back every node that was not claimed this frame. This is what
      // makes the pool correct without spawnObstacle, gameStep or the round
      // reset having to know it exists: whatever stops appearing in the list
      // has its node released on the next frame, whichever way it left.
      //
      // Release is two-stage — see the NODE_HIDE_MS note above. Stage one is
      // free + invisible + no running animation, and happens immediately.
      // Stage two is display:none, which destroys the layer, and waits out the
      // grace period so a spawn can reclaim the node without a rebuild.
      for (let k = 0; k < POOL; k++) {
        if (nodeFree[k] === 0 && nodeGen[k] !== gen) {
          nodeFree[k] = 1;
          nodeFreeAt[k] = now;
          const nd = nodes[k];
          nd.root.style.opacity = '0';
          // Stops the pulse-ring keyframes dead. This is the half of the old
          // display:none that was actually buying anything: a hidden node that
          // is still animating is compositor work every frame for nothing.
          nd.ring.style.display = 'none';
        }
        if (nodeFree[k] === 1 && nodeDark[k] === 0 && (hardHide || now - nodeFreeAt[k] > NODE_HIDE_MS)) {
          nodeDark[k] = 1;
          nodes[k].root.style.display = 'none';
        }
      }
    };

    const draw = (timestamp) => {
      if (!ctx) {
        ctx = canvasRef.current?.getContext('2d', { alpha: true }) || null;
        if (!ctx) { drawAnimRef.current = requestAnimationFrame(draw); return; }
      }

      // ── Display-interval estimate ────────────────────────────────────
      // Kept up to date on EVERY frame, countdown included, and off its own
      // timestamp rather than the physics clock (which resets to 0 at the
      // start of a round and would feed this a bogus zero-length gap).
      //
      // The snap-down branch used to have no floor and no way back. A single
      // sub-millisecond gap — the WebView does emit them, e.g. two rAFs
      // coalesced after a stall — set vsyncMs to that value permanently: real
      // 16.7ms gaps then fell outside the 0.6x-1.6x tracking band, so the EWMA
      // could never pull it back, and every frame afterwards quantised to the
      // clamp of 3 "vsyncs" of a wrong base. That is a game that judders for
      // the rest of the round from one bad frame. The floor rejects the short
      // gaps outright, the snap-down now needs three in a row to be believed,
      // and a long run of gaps that fit nothing at all re-seeds from scratch.
      if (prevTs) {
        const gap = timestamp - prevTs;
        if (gap > 4 && gap < 40) {
          if (!vsyncMs) {
            vsyncMs = gap;
            vsyncOutliers = 0;
          } else if (gap > vsyncMs * 0.75 && gap < vsyncMs * 1.35) {
            vsyncMs += (gap - vsyncMs) * 0.05;
            vsyncOutliers = 0;
          } else if (gap < vsyncMs * 0.75) {
            // Genuinely faster than we thought, or a bad seed — but only after
            // three consecutive frames agree.
            if (++vsyncOutliers >= 3) { vsyncMs = gap; vsyncOutliers = 0; }
          } else {
            // A multiple of the interval (a dropped frame) is normal and must
            // not move the estimate. A long run of them means the estimate is
            // simply wrong; throw it away and learn again.
            if (++vsyncOutliers >= 20) { vsyncMs = 0; vsyncOutliers = 0; }
          }
        }
      }
      prevTs = timestamp;

      // ── High-refresh throttle ────────────────────────────────────────
      // On a 120Hz+ panel every layer in this drill — up to 56 hazard nodes,
      // the player, the stick and the danger vignette — is composited twice as
      // often as it is on the 60Hz phones this was tuned against. That is
      // double the GPU work for the same game, and it is the largest single
      // reason the device gets hot enough to start thermal-throttling
      // mid-run. Rendering on every OTHER vsync there puts the drill back at
      // the ~60fps it was designed for and roughly halves the frame cost.
      //
      // This is NOT the old `if (timestamp - lastDrawTs < 14) skip` cap, which
      // is what used to make the hazards snag. That compared a jittery
      // timestamp against a fixed millisecond threshold, so WHICH frames got
      // dropped was effectively random and the survivors advanced by uneven
      // amounts. This is a fixed COUNT — every second vsync, always — so the
      // gap between rendered frames is exactly two display intervals and the
      // quantiser below advances the clock by exactly two. Motion stays even.
      //
      // 90Hz panels are deliberately left alone: halving one lands at 45fps,
      // which costs more in feel than it saves in heat. Only genuine 120Hz+
      // (an interval under 10.5ms) is throttled, and only once the estimate
      // has actually converged.
      if (vsyncMs && vsyncMs < 10.5) {
        frameParity ^= 1;
        if (frameParity) { drawAnimRef.current = requestAnimationFrame(draw); return; }
      } else if (frameParity) {
        frameParity = 0;
      }

      // Build this frame's input vector from the newest thumb sample, once,
      // before physics reads it. Pure arithmetic — the DOM side of the widget
      // is written further down with the rest of the frame's style writes.
      sampleStick();

      // Physics, stepped from this same callback (see runGameLoop).
      const stepFn = stepRef.current;
      if (gameActiveRef.current && stepFn) {
        if (!lastTimeRef.current) lastTimeRef.current = timestamp;
        let deltaMs = timestamp - lastTimeRef.current;
        lastTimeRef.current = timestamp;
        if (deltaMs > 250) deltaMs = 250;

        // ── Vsync quantiser ────────────────────────────────────────────
        // The fixed timestep keeps the SIMULATION even, but what actually
        // reaches the screen is the INTERPOLATED position, and that is a
        // continuous function of `accumulator` — i.e. of the raw rAF
        // timestamp. The Android WebView puts a couple of ms of jitter on
        // those timestamps, so obstacle step length wobbled frame to frame
        // even though every frame was delivered on time (measured on device:
        // p50 16.9ms, p90 16.9ms, p99 17ms, ~0 drops — yet the motion still
        // read as snagging). The fixed timestep did not protect the visuals;
        // interpolation handed the jitter straight back to them.
        //
        // What reaches the screen is always a WHOLE number of vsyncs, so
        // learn the panel's interval and advance the clock in exact multiples
        // of it. Same approach as batch-processing. Real-time speed is
        // preserved (the estimate tracks the true interval), but consecutive
        // frames now advance by identical amounts.
        // The estimate itself is maintained at the top of this callback, not
        // here — it has to keep learning through the countdown, and it must
        // not see the deltaMs of 0 that the first frame of a round produces.
        const baseMs = vsyncMs || 16.667;
        let vsyncs = Math.round(deltaMs / baseMs);
        if (vsyncs < 1) vsyncs = 1; else if (vsyncs > 3) vsyncs = 3;
        const frameDt = (vsyncs * baseMs) / 1000;
        accumulator += frameDt;

        // The dot moves HERE, once per rendered frame against the display
        // interval, and before the fixed steps below read its position. See
        // the long note on movePlayer: this is what stops the stick feeling
        // like it is a frame or two behind the thumb.
        movePlayer(frameDt);

        let steps = 0;
        let ended = false;
        while (accumulator >= FIXED_DT && steps < 8) {
          if (stepFn(FIXED_DT)) { ended = true; break; }
          accumulator -= FIXED_DT;
          steps++;
        }
        if (ended || steps >= 8) accumulator = 0;
        alpha = ended ? 1 : accumulator / FIXED_DT;
      } else {
        alpha = 1;
      }

      // There is deliberately NO frame cap here any more.
      //
      // It used to be `if (timestamp - lastDrawTs < 14) skip`. Desktop Chrome
      // hands rAF timestamps almost exactly 16.667ms apart, so a 14ms floor
      // never trips there — which is why this always looked fine on a laptop.
      // The Android WebView jitters, so any frame arriving 13.x ms after the
      // last one was THROWN AWAY, and the following frame showed obstacles
      // two steps further along. In a dodging game that reads as the hazards
      // snagging on something as they cross the field. Rendering every vsync
      // removes the skip entirely, and the frame is cheaper than it was when
      // that cap was written (the full-screen backdrop blit is gone below).
      const w = canvasSizeRef.current.width;
      const h = canvasSizeRef.current.height;
      const dpr = motionDpr();
      const minDim = Math.min(w, h);
      const e = engine.current;
      // Nothing samples a clock here any more: every idle animation in this
      // drill (the hazard pulse rings, the player halo and ring) is a CSS
      // animation the compositor times for itself.

      // ── Countdown: size the player and warm the cold paths ─────────────
      // Everything the loop touches for the PLAYER is warm by the time the
      // round starts, because this effect spans both phases. The hazard paths
      // were not: they cannot run before a hazard exists, so V8 was still
      // interpreting and then tiering up the hazard pass and the hazard half
      // of the stepper during the opening seconds of play. That is the "the
      // first obstacles are jittery and then it settles" report, and it is not
      // something frame pacing can fix — the frames really were more expensive
      // at the start of the round.
      //
      // It now matters for a second reason too: the first frame a pooled node
      // becomes visible is the frame the compositor has to create a layer for
      // it. Doing that for 44 nodes during the round would be a stall exactly
      // where this drill cannot afford one, so the warm-up runs the real
      // render pass against dummy hazards — with the whole pass pushed three
      // screens above the field, so every layer is created, promoted and
      // transformed for real without a pixel of it landing inside the
      // (overflow-hidden) play area.
      if (phaseRef.current === 'countdown' && minDim > 0) {
        ensurePlayerSize(minDim * 0.024);
        // The stick anchors during the countdown now (see handlePointerDown),
        // so it has to be drawn during the countdown too — otherwise the thumb
        // is steering a control that is not on screen yet.
        paintStick();

        if (w > 0 && h > 0) {
          if (!warmObstacles) warmObstacles = buildWarmObstacles();

          if (warmFrames > 0) {
            warmFrames--;

            // Alternate the level so BOTH sides of the `glowing` / `showTrails`
            // branches get profiled. If only one is ever seen here, the flip
            // partway through a real round hits an unprofiled path and can
            // deoptimise the function at the worst possible moment.
            //
            // Every EIGHTH frame, not every frame. `lp` decides the layer's
            // class, and flipping it alternately meant rewriting the class on
            // a 60-node subtree forty times in a row — which invalidates style
            // for all of them, toggles 56 trails between display:none and
            // block and starts and stops 56 ring animations, once per frame,
            // through the whole "3 2 1". That is a heavy countdown for no
            // extra coverage: V8 needs to SEE both branches, not see them
            // twenty times each.
            const lp = (warmFrames & 8) ? 0.15 : 0.8;
            renderObstacles(warmObstacles, 0.5, lp, w, h, minDim, -h * 3, timestamp, false);

            // And the physics half. dt = 0 means nothing integrates, nothing
            // spawns, no obstacle can drift out of bounds and none can close on
            // the player, so this is pure code execution against real state —
            // but the board and the player are swapped out and back regardless,
            // because the round has not been reset yet at this point and the
            // engine may still be holding the previous run's values.
            const warmStep = gameStepRef.current;
            const eng = engine.current;
            if (warmStep && eng.timeLeft > 1 && eng.elapsedTime < 1) {
              const savedObstacles = eng.obstacles;
              const savedX = eng.player.x;
              const savedY = eng.player.y;
              eng.obstacles = warmObstacles;
              eng.player.x = 50;
              eng.player.y = 50;
              warmStep(0);
              eng.player.x = savedX;
              eng.player.y = savedY;
              eng.obstacles = savedObstacles;
            }
          } else if ((keepAliveTick++ & 7) === 0) {
            // Warm-up done, round not started. Keep the dummies CLAIMED — one
            // cheap transform pass every eighth frame — so all 56 layers are
            // still promoted when GO lands.
            //
            // This used to be the opposite: the frame the warm-up finished, it
            // released every node and let them go display:none, throwing away
            // everything it had just built roughly a second before the round
            // needed it. The opening hazards then paid full layer-creation
            // cost one by one, which is exactly the "the first obstacles judder
            // and then it settles" report — the frames really were more
            // expensive at the start of the round.
            //
            // Nothing is visible: the pass is still shoved three screens above
            // the field. The dummies are freed naturally by the first frame of
            // play, and NODE_HIDE_MS then holds their layers open across the
            // gap to the first spawn.
            renderObstacles(warmObstacles, 1, 0, w, h, minDim, -h * 3, timestamp, false);
          }
        }
      }

      // ── The round itself ───────────────────────────────────────────────
      // Two style writes for the player and one per hazard. No canvas, no
      // clear, no paths — see the note on renderObstacles for why that is the
      // whole point of this rewrite.
      if (phaseRef.current === 'playing') {
        const pr = minDim * 0.024;
        ensurePlayerSize(pr);
        const pel = playerElRef.current;
        if (pel) {
          // Same skip-if-unchanged as the hazards. The dot is stationary
          // whenever the thumb is off the stick, which over a run is a lot of
          // frames writing the identical string.
          const px = Math.round(((e.player.x / 100) * w) * 10) / 10;
          const py = Math.round(((e.player.y / 100) * h) * 10) / 10;
          if (px !== playerTx || py !== playerTy) {
            playerTx = px; playerTy = py;
            pel.style.transform = 'translate3d(' + px + 'px,' + py + 'px,0)';
          }
        }
        // Grouped with the other style writes on purpose: every write in this
        // block lands in one batch, so the browser recomputes style and layout
        // once for the frame instead of once per pointermove.
        paintStick();
        renderObstacles(e.obstacles, alpha, Math.min(1, (e.level - 1) / (LEVEL_TABLE.length - 1)), w, h, minDim, 0, timestamp, false);
      } else if (phaseRef.current !== 'countdown') {
        // Round over (or not started): let go of every node so nothing is left
        // frozen on screen behind the result card. hardHide, so the grace
        // period is skipped and no layer outlives the round.
        if (nodes.length) renderObstacles(EMPTY, 1, 0, w, h, minDim, 0, timestamp, true);
        const pel = playerElRef.current;
        if (pel) pel.style.opacity = '0';
        playerSizedR = -1;
        playerTx = NaN; playerTy = NaN;
      }

      // ── Hit effects ────────────────────────────────────────────────────
      // The only thing left on the canvas. On a clean run both lists are empty
      // and this whole block — including the clearRect — is skipped, so the
      // canvas surface is never rasterised and never re-uploaded. `fxWasDrawn`
      // buys exactly one more pass after the last spark dies, to wipe it.
      const hasFx = shockwavesRef.current.length > 0 || particlesRef.current.length > 0;
      if (hasFx || fxWasDrawn) {
        fxWasDrawn = hasFx;

        // setTransform, not save()/scale()/restore(): save() snapshots the
        // whole 2D state into a fresh object, and every path below sets the
        // style it needs anyway. globalAlpha is explicitly restored to 1 by
        // each pass that touches it, so there is nothing for restore() to undo.
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);

        // Shockwaves: a ring that grows out of the impact point and fades.
        // Drawn before the sparks so the sparks read as travelling over it.
        for (let i = shockwavesRef.current.length - 1; i >= 0; i--) {
          const sw = shockwavesRef.current[i];
          sw.life -= 0.045;
          if (sw.life <= 0) { shockwavesRef.current.splice(i, 1); continue; }
          const t01 = 1 - sw.life;                 // 0 -> 1 over the ring's life
          const sx = (sw.x / 100) * w;
          const sy = (sw.y / 100) * h;
          const rr = minDim * (0.012 + t01 * 0.13);
          ctx.beginPath();
          ctx.arc(sx, sy, rr, 0, Math.PI * 2);
          // Was a template literal plus toFixed(3) — two fresh strings per
          // shockwave per frame. The colour is fixed for the ring's life, so
          // it is built once at spawn and the fade rides on globalAlpha.
          ctx.strokeStyle = sw.rgb;
          ctx.globalAlpha = sw.life * 0.9;
          ctx.lineWidth = 2.5 * sw.life + 0.5;
          ctx.stroke();
          ctx.globalAlpha = 1.0;
        }

        for (let i = particlesRef.current.length - 1; i >= 0; i--) {
          const p = particlesRef.current[i];
          p.x += p.vx;
          p.y += p.vy;
          p.alpha -= 0.045;
          if (p.alpha <= 0) { particlesRef.current.splice(i, 1); continue; }
          const ppx = (p.x / 100) * w;
          const ppy = (p.y / 100) * h;
          ctx.beginPath();
          ctx.arc(ppx, ppy, p.r * (minDim / 100), 0, Math.PI * 2);
          ctx.globalAlpha = p.alpha;
          ctx.fillStyle = p.color;
          ctx.fill();
          ctx.globalAlpha = 1.0;
        }
      }

      drawAnimRef.current = requestAnimationFrame(draw);
    };

    drawAnimRef.current = requestAnimationFrame(draw);
    return () => {
      if (drawAnimRef.current) cancelAnimationFrame(drawAnimRef.current);
      ro.disconnect();
      window.removeEventListener('resize', resizeCanvas);
      window.removeEventListener('orientationchange', resizeCanvas);
    };
    // Deliberately NOT [phase]. This effect owns the canvas backing store, both
    // ring sprites, the player sprite, the 2D context, a ResizeObserver and the
    // rAF loop. Keying it on `phase` meant the countdown -> playing transition
    // tore all of that down and rebuilt it at the exact instant the round began
    // — a canvas reallocation plus three sprite rasterisations plus the React
    // mount of the play layer, all in one frame. That was the measured ~79ms
    // long task / 117ms frame at round start. `playLayerMounted` is true across
    // BOTH phases, so the whole round is now one uninterrupted setup, and the
    // loop reads the live phase from phaseRef instead.
  }, [playLayerMounted]);

  // Score card. Drawn and encoded while the result screen sits idle,
  // not on the tap - see useShareCard in components/ShareScoreCard.js.
  const shareResult = useShareCard(endSummary ? {
    score: endSummary.score,
    bestScore: endSummary.prevBest ?? bestScore,
    accuracy: endSummary.accuracy,
    bestCombo: endSummary.bestCombo,
    rating: getGrade(endSummary.accuracy),
    newBest: endSummary.isNewBest,
    drillName: 'Quick Dodge',
    playerName: getPlayerName(),
  } : null, {
    url: APP_SHARE_URL,
    title: 'Quick Dodge — SkillDrills',
    text: endSummary ? `Scored ${endSummary.score} on Quick Dodge (${endSummary.accuracy}% accuracy, ${endSummary.bestCombo}x combo) — SkillDrills` : '',
  });

  if (loading || !isClient) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-[#050508]">
        <div className="text-center">
          <div className="w-14 h-14 border-4 border-emerald-600 border-t-transparent rounded-full animate-spin mx-auto mb-4 shadow-[0_0_20px_rgba(16,185,129,0.5)]" />
          <p className="text-slate-500 font-bold tracking-widest uppercase text-[10px] animate-pulse">Loading Evasion Engine...</p>
        </div>
      </div>
    );
  }

  return (
    <DrillWrapper
      drillName="Quick Dodge"
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
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onContextMenu={(e) => { if (gameActiveRef.current) e.preventDefault(); }}
        className={`absolute inset-0 select-none overflow-hidden bg-[#050508] text-white`}
        // touch-action is read off `phase`, not off gameActiveRef. A ref does
        // not re-render, and in SOLO nothing else sets React state during a
        // round, so this attribute was whatever it happened to be at the last
        // render — one missed render and the WebView goes back to holding
        // pointermove until it has decided the gesture is not a scroll, which
        // is a real, visible lag on the first push of every stick gesture.
        // It also has to be 'none' through the COUNTDOWN now that the stick
        // anchors there.
        style={{ touchAction: (phase === 'countdown' || phase === 'playing') ? 'none' : 'auto', WebkitTapHighlightColor: 'transparent' }}
      >
        {phase === 'playing' && dangerLevel > 0.06 && (
          <div className="fx-vignette" style={{ '--v-min': Math.max(0.06, dangerLevel * 0.3), '--v-max': Math.min(0.8, dangerLevel * 0.95), animationDuration: `${Math.max(350, Math.round(1100 - dangerLevel * 650))}ms` }} />
        )}

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

        {phase === 'rotate-hint' && !isChallenge && (
          <div className="absolute inset-0 z-[100] flex flex-col items-center justify-center bg-black/95 text-center p-6">
            <div className="animate-bounce mb-5 text-emerald-400"><RotateCcw className="w-12 h-12 mx-auto" /></div>
            <p className="text-sm font-bold text-white">Rotate your phone to play</p>
            <p className="text-xs text-slate-500 mt-1.5 max-w-[220px] mx-auto">Turn your device to landscape to begin the evasion drill.</p>
          </div>
        )}

        {/* ── START SCREEN ── */}
        {phase === 'start' && !launching && !isChallenge && (
          <DrillStartCard
            drillName="Quick Dodge"
            tagline="Hold to steer · dodge the hunters"
            rules={[
              'Hold anywhere to steer your dot',
              'Red circles hunt you down',
              'Dodging adds time, hits cost it',
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

        {/* ── PLAYING / COUNTDOWN LAYER ── */}
        {(phase === 'playing' || phase === 'countdown') && (
          <>
            <div className="absolute top-5 left-5 z-40 flex flex-col pointer-events-none">
              {/* Deliberately childless. React only rewrites a text node it
                  actually rendered, so leaving these empty hands ownership to
                  the physics step's textContent writes and a re-render (a life
                  lost, a level up) can no longer clobber them. */}
              <span ref={scoreElRef} className="text-2xl font-hud font-bold text-white leading-none tabular-nums" />
            </div>

            <div className="absolute top-5 right-5 z-40 flex flex-col items-end pointer-events-none select-none">
              <span ref={timeElRef} className={`${TIME_CLS} text-slate-300`} />
              <span className="text-[8px] label-tiny text-slate-500 mt-1">Time Left</span>
            </div>

            <div className="relative w-full h-full">
              {/* Play-field grid. Static CSS the browser paints once — the
                  canvas above used to blit this same picture every frame. */}
              <div
                className="absolute inset-0 z-0 pointer-events-none"
                style={{
                  backgroundImage: 'linear-gradient(rgba(255,255,255,0.015) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.015) 1px, transparent 1px)',
                  backgroundSize: '40px 40px'
                }}
              />
              {/* Hazard layer. Empty in the markup on purpose: the nodes are a
                  pool the render loop builds once and reuses, so React never
                  sees them and a re-render can never touch them. */}
              <div ref={obLayerRef} className="qd-layer" />

              {/* The player dot. A zero-sized origin the loop translates, with
                  the halo, the pulse ring and the body hanging off it — the
                  first two animated entirely in CSS. */}
              <div ref={playerElRef} className="qd-player">
                <div className="qd-player-halo" />
                <div className="qd-player-ring" />
                <div className="qd-player-body"><div className="qd-player-sheen" /></div>
              </div>

              {/* Hit effects only. Sits ABOVE the hazards so a shockwave reads
                  as discharging over them, and is left completely untouched on
                  every frame where nothing has been hit. */}
              <canvas
                ref={canvasRef}
                className="absolute inset-0 z-20 w-full h-full block pointer-events-none"
              />

              {/* The floating thumbstick. Rendered once and parked at opacity 0
                  — the pointer handlers move it and fade it in, so it costs
                  nothing on the frames nobody is touching the screen and never
                  goes through React. Above the canvas so a hit flash can't wash
                  it out mid-dodge. */}
              <div ref={stickElRef} className="qd-stick">
                <div className="qd-stick-base" />
                <div ref={stickKnobRef} className="qd-stick-knob">
                  <div className="qd-stick-knob-dot" />
                </div>
              </div>
            </div>
          </>
        )}

        {/* ── COUNTDOWN ──
            No backdrop-blur on this overlay. A full-screen backdrop-filter
            forces the compositor to keep a readback surface over the play
            canvas for the entire countdown, and then tears that surface down
            on the exact frame the round begins — landing a compositor stall on
            the first frame of play. bg-black/55 alone reads the same. */}
        {phase === 'countdown' && !isChallenge && (
          <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/55">
            <span className="text-[11px] font-black uppercase tracking-[0.2em] text-slate-400">Get Ready</span>
            <div className="relative w-28 h-28 rounded-full border-[3px] border-emerald-500/20 flex items-center justify-center">
              <div className="absolute -inset-[3px] rounded-full border-[3px] border-transparent border-t-emerald-400 border-r-emerald-400 animate-spin" style={{ animationDuration: '0.7s' }} />
              <span key={countdownValue} className="fx-pop-in text-5xl font-display bg-gradient-to-b from-white to-emerald-300 bg-clip-text text-transparent">
                {countdownValue > 0 ? countdownValue : 'GO'}
              </span>
            </div>
            <span className="text-[10px] text-slate-500">Drag to dodge incoming threats</span>
          </div>
        )}

        {/* ── RESULT SCREEN ── */}
        {phase === 'ended' && endSummary && !isChallenge && (
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

