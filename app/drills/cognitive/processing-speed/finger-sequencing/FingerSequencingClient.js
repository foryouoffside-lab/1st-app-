'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  Target, Volume2, VolumeX,
  RotateCw
} from 'lucide-react';
import { scoreAction, calcEndBonuses, calcSessionXP, getGrade, isValidReactionTime } from '../../../../../lib/scoringEngine';
import {
  applyHit, applyMistake,
  scoringMaxLevel, scoringLives, stochasticRound,
} from '../../../../../lib/drillRules';
import { saveLeaderboardEntrySync } from '../../../../../lib/leaderboard';
import { afterViewportSettled, lockLandscape, unlockOrientation, onOrientationSettled } from '../../../../../lib/orientation';
import { previewDailyCompletion } from '../../../../../lib/dailyChallenge';
import { getPlayerName, getPlayerLevel } from '../../../../../lib/progressStore';
import { Capacitor } from '@capacitor/core';
import { StatusBar } from '@capacitor/status-bar';
import { useShareCard } from '../../../../../components/ShareScoreCard';
import DrillWrapper from '../../../../../components/DrillWrapper';
import { useDuelMatchStart, duelSecondsRemaining } from '../../../../../lib/challengeEngine';
import { canvasDpr } from '../../../../../lib/canvasFx';
import { APP_SHARE_URL } from '../../../../../lib/shareLinks';
import ResultScreen from '../../../../../components/drill/ResultScreen';
import DrillStartCard from '../../../../../components/drill/DrillStartCard';

// ============================================================
// ZERO-LATENCY AUDIO SYNTHESIZER
// ============================================================
class AudioSynthesizer {
  constructor() {
    this.ctx = null;
    this.enabled = true;
  }
  
  init() {
    if (!this.ctx && typeof window !== 'undefined') {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    // Resume here, on the START tap, the way every other drill's init() does.
    // This one only created the context and left the resume to tone(), but
    // resume() is asynchronous: the first tone or two fired while the context
    // was still coming back from 'suspended' were scheduled against a clock
    // that had not started, and were simply never heard. That is the "some
    // taps make no sound" report.
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  tone(freq, dur, type = 'sine', vol = 0.15, sweepTo = null) {
    if (!this.enabled || !this.ctx) return;
    try {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
      if (sweepTo) {
        osc.frequency.exponentialRampToValueAtTime(sweepTo, this.ctx.currentTime + dur);
      }
      gain.gain.setValueAtTime(vol, this.ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + dur);
      osc.connect(gain); gain.connect(this.ctx.destination);
      osc.start(); osc.stop(this.ctx.currentTime + dur);
    } catch {}
  }

  // Identical to every other drill's hit cue. This one was alone on
  // tone(1200, 0.08, ..., 0.1, 1500) — higher, shorter and quieter than the
  // rest of the app, which is why this drill sounded like a different game.
  playHit() { this.tone(880, 0.12, 'sine', 0.16, 1760); }

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

  playPenalty() {
    if (!this.enabled || !this.ctx) return;
    try {
      if (this.ctx.state === 'suspended') this.ctx.resume();
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
  playFail() { this.playPenalty(); }
  playWrongOrder() { this.playPenalty(); }
  playTrapTap() { this.playPenalty(); }

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

  playResultsReveal() {
    if (!this.enabled || !this.ctx) return;
    try {
      if (this.ctx.state === 'suspended') this.ctx.resume();
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
      if (this.ctx.state === 'suspended') this.ctx.resume();
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

  setEnabled(status) {
    this.enabled = status;
  }
}

const audioSynth = typeof window !== 'undefined' ? new AudioSynthesizer() : null;
const GAME_DURATION = 45;

// How a solo run is won and lost — the clock as the only fail state, what a hit
// earns, what a mistake costs — is defined once in lib/drillRules.js and shared
// by every drill. Read that file for the model and the reasoning.
//
// Difficulty here is an ADAPTIVE TEMPO INDEX (0.1..1.0) derived from recent
// accuracy, pace and consistency, which maps to a displayed level of 1..10. It
// converges on the player's real limit, so it needs no level ramp of its own;
// the decaying time-per-hit payout in drillRules is what ends the run.
//
// Because that index is ONE dial, every setting keyed off it has to fade rather
// than switch — otherwise the chain length, the ordering hint and the trap node
// all change on the same tempo value and the board lurches.
const CUE_FADE_START = 0.20;   // ordering hint at full strength up to here
const CUE_FADE_END = 0.55;     // ordering hint fully gone from here on
const TRAP_FADE_IN_START = 0.45;
const TRAP_FADE_IN_END = 0.85;

const getComboMultiplier = (combo) => 1.0 + Math.floor(combo / 5) * 0.2;

export default function FingerSequencingClient() {
  const searchParams = useSearchParams();
  const challengeId = searchParams ? searchParams.get('challengeId') : null;
  const isChallenge = !!challengeId;
  const totalTime = isChallenge ? 30 : GAME_DURATION;

  // === UI & Viewport State ===
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

  // === Settings & Local Stats ===
  const [score, setScore] = useState(0);
  const [bestScore, setBestScore] = useState(0);
  const [bestCombo, setBestCombo] = useState(0);
  const [bestReadStreak, setBestReadStreak] = useState(0);
  const [bestLevel, setBestLevel] = useState(1);

  // === Live Stats (UI Sync) ===
  const [timeLeft, setTimeLeft] = useState(totalTime);
  const [level, setLevel] = useState(1);
  const [dangerLevel, setDangerLevel] = useState(0);

  // === Overlays & Summary ===
  const [endSummary, setEndSummary] = useState(null);

  // Mistake flashes. Same list-of-flashes pattern every other drill uses, so
  // this one gets the shared centred .fx-flash-red wash instead of the flat
  // full-canvas fill it used to paint itself (see triggerFlash).
  const [flashes, setFlashes] = useState([]);

  // === Refs ===
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const canvasSizeRef = useRef({ width: 0, height: 0 });

  // Gameplay session registers
  const scoreRef = useRef(0);
  const timeLeftRef = useRef(totalTime);
  const runOverRef = useRef(false);
  const elapsedRef = useRef(0);
  const nodeComboRef = useRef(0);
  const bestNodeComboRef = useRef(0);
  const readStreakRef = useRef(0);
  const bestReadStreakRef = useRef(0);
  const tempoIndexRef = useRef(0.2);
  const historyRef = useRef([]);
  const gameActiveRef = useRef(false);

  const chainRef = useRef([]);
  const activeIndexRef = useRef(0);
  const chainSpawnTimeRef = useRef(0);
  const nodeSpawnTimeRef = useRef(0);
  const chainMistakeCountRef = useRef(0);
  const lastResolveTimeRef = useRef(0);

  // Engine refs
  const particlesRef = useRef([]);
  const scorePopupsRef = useRef([]);
  const flashIdRef = useRef(0);
  const deviceTypeRef = useRef('desktop');
  const cueTierRef = useRef(1);
  const nodeWindowMsRef = useRef(2.5);
  const bestLevelRunRef = useRef(1);

  // Stat collectors
  const totalClicksRef = useRef(0);
  const hitsRef = useRef(0);
  const wrongOrderRef = useRef(0);
  const whiffsRef = useRef(0);
  const trapHitsRef = useRef(0);
  const timeoutsRef = useRef(0);
  const chainsCompletedRef = useRef(0);

  const countdownTimerRef = useRef(null);
  const heartbeatTimerRef = useRef(null);
  const heartbeatTempoRef = useRef(1000);
  const mountedRef = useRef(false);

  // Heartbeat scheduling
  const scheduleHeartbeat = useCallback(() => {
    if (isChallenge) return;
    if (!gameActiveRef.current) return;

    const dangerFromLives = 0;   // lives are gone; time is the only danger now
    const dangerFromTime = timeLeftRef.current <= 10 ? (10.0 - timeLeftRef.current) / 10.0 : 0.0;
    const danger = Math.min(1, Math.max(dangerFromLives * 0.7, dangerFromTime));

    const tempo = Math.max(350, Math.round(1100 - danger * 650));
    heartbeatTempoRef.current = tempo;

    if (danger > 0.08) audioSynth?.playHeartbeat(danger);
    if (mountedRef.current) setDangerLevel(danger);

    heartbeatTimerRef.current = setTimeout(scheduleHeartbeat, tempo);
  }, [isChallenge]);

  const cleanupTimers = () => {
    [countdownTimerRef, heartbeatTimerRef].forEach((r) => {
      if (r.current) {
        clearTimeout(r.current);
        r.current = null;
      }
    });
  };

  // Mount / cleanup
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cleanupTimers();
    };
  }, []);

  // Spawn visual particles
  // The shared mistake flash. This drill used to paint its own: a flat
  // ctx.fillRect over the entire canvas, which washed the whole screen edge to
  // edge instead of the soft centred bloom every other drill shows — it read as
  // a different, much harsher effect, and being canvas paint it also meant a
  // full-screen repaint on the exact frames the drill is busiest. The shared
  // .fx-flash-red is a CSS radial gradient on its own layer, so it is one
  // compositor node and identical in all 24 drills.
  const triggerFlash = useCallback(() => {
    const id = ++flashIdRef.current;
    setFlashes((prev) => [...prev, { id }]);
    // The CSS animation is 200ms; 350 clears the node well after it finishes.
    setTimeout(() => setFlashes((prev) => prev.filter((f) => f.id !== id)), 350);
  }, []);

  const spawnParticles = useCallback((x, y, color, count) => {
    const list = particlesRef.current;
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = Math.random() * 200 + 60;
      list.push({
        x, y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s,
        radius: Math.random() * 4 + 1.5,
        color,
        life: 0.3
      });
    }
  }, []);

  const spawnScorePopup = useCallback((x, y, text, color = '#4ade80') => {
    scorePopupsRef.current.push({ x, y, text, color, life: 1.0 });
  }, []);

  // Rolling event manager & Tempo Index calculations
  const recordEvent = useCallback((type, clickTimeMs = null) => {
    const history = historyRef.current;
    history.push({ type, time: clickTimeMs });
    if (history.length > 15) {
      history.shift();
    }

    if (history.length >= 5) {
      let hCount = 0;
      let wOrderCount = 0;
      let whiffCount = 0;
      let trapCount = 0;
      let toCount = 0;
      let sumPaceMs = 0;
      let countPaceHits = 0;

      history.forEach(e => {
        if (e.type === 'hit') {
          hCount++;
          if (e.time && e.time > 0) {
            sumPaceMs += e.time;
            countPaceHits++;
          }
        }
        else if (e.type === 'wrong-order') wOrderCount++;
        else if (e.type === 'whiff') whiffCount++;
        else if (e.type === 'trap') trapCount++;
        else if (e.type === 'timeout') toCount++;
      });

      const total = hCount + wOrderCount + whiffCount + trapCount + toCount;
      const accuracyFactor = total > 0 ? hCount / total : 1.0;

      const avgPaceMs = countPaceHits > 0 ? sumPaceMs / countPaceHits : 1500;
      const paceFactor = Math.max(0, Math.min(1.0, 1 - avgPaceMs / 1500));

      const consistencyFactor = Math.max(0, Math.min(1.0, nodeComboRef.current / 10));

      const composite = 0.5 * accuracyFactor + 0.3 * paceFactor + 0.2 * consistencyFactor;
      const newTempoIndex = Math.max(0.1, Math.min(1.0, composite));
      // Solo keeps the adaptive ramp (up AND down with recent performance).
      // A duel must never let a −5 penalty ease the difficulty back down, so
      // tempoIndex only ratchets upward there — see ARENA_INTEGRATION.md rule 5.
      // Ratchets UP only, in both modes. It used to fall again in solo when
      // recent performance dipped — with lives gone that becomes a trap: a
      // player who struggles gets an easier drill, which earns them time back,
      // which keeps a run alive that should have ended. Difficulty reached is
      // difficulty kept, which is also the rule everywhere else in the catalog.
      tempoIndexRef.current = Math.max(tempoIndexRef.current, newTempoIndex);

      const derivedLevel = 1 + Math.floor(tempoIndexRef.current * 9);
      setLevel(derivedLevel);
      if (derivedLevel > bestLevelRunRef.current) {
        bestLevelRunRef.current = derivedLevel;
      }
    }
  }, [isChallenge]);

  // End Game pipeline
  const endGame = useCallback(async () => {
    gameActiveRef.current = false;
    cleanupTimers();
    setPhase('ended');

    const finalAcc = totalClicksRef.current > 0 ? Math.round((hitsRef.current / totalClicksRef.current) * 100) : 0;
    const totalMistakes = wrongOrderRef.current + whiffsRef.current + trapHitsRef.current + timeoutsRef.current;

    const endBonuses = calcEndBonuses({
      rawScore: scoreRef.current,
      accuracy: finalAcc,
      bestCombo: bestNodeComboRef.current,
      totalActions: hitsRef.current,
      mistakes: totalMistakes,
      livesRemaining: scoringLives(0),
      category: 'cognitive'
    });

    const finalScore = endBonuses.finalScore;

    const daily = isChallenge
      ? { isDailyDrill: false, wouldCompleteSet: false }
      : await previewDailyCompletion('finger-sequencing');

    // Captured BEFORE the run is banked: the result screen's XP bar animates
    // from the level the player walked in with to the one they walk out with.
    const progress = await getPlayerLevel();

    const xpData = calcSessionXP({
      finalScore,
      accuracy: finalAcc,
      isNewBest: finalScore > bestScore,
      firstPlay: bestScore === 0,
      dailyChallenge: daily.isDailyDrill,
      dailyChallengeSetComplete: daily.wouldCompleteSet
    });

    setBestScore(prev => {
      if (finalScore > prev) {
        try {
          localStorage.setItem('sequenceAim_bestScore', finalScore.toString());
          localStorage.setItem('sequenceAim_bestCombo', bestNodeComboRef.current.toString());
          localStorage.setItem('sequenceAim_bestReadStreak', bestReadStreakRef.current.toString());
          localStorage.setItem('sequenceAim_bestLevel', bestLevelRunRef.current.toString());
        } catch{}
        return finalScore;
      }
      return prev;
    });

    saveLeaderboardEntrySync({
      drillId: 'finger-sequencing',
      drillName: 'Sequence Aim Trainer',
      category: 'cognitive',
      score: finalScore,
      accuracy: finalAcc,
      bestCombo: bestNodeComboRef.current,
    });

    setEndSummary({
      progress,
      score: finalScore,
      accuracy: finalAcc,
      bestCombo: bestNodeComboRef.current,
      bestReadStreak: bestReadStreakRef.current,
      xpEarned: xpData.xp,
      isNewBest: finalScore > bestScore,
      prevBest: bestScore,
    });

    audioSynth?.playResultsReveal();
  }, [bestScore]);

  const registerMiss = useCallback(() => {
    // Arena has no lives — mistakes cost score instead, and a duel always
    // runs the full shared time (see ARENA_INTEGRATION.md rules 3 & 4).
    if (isChallenge) {
      scoreRef.current = Math.max(0, scoreRef.current - 5);
      setScore(scoreRef.current);
      return;
    }
    const after = applyMistake({ timeRemaining: timeLeftRef.current });
    timeLeftRef.current = after.timeRemaining;
    runOverRef.current = after.runOver;
    setTimeLeft(Math.ceil(timeLeftRef.current));
    if (runOverRef.current) {
      endGame();
    }
  }, [endGame, isChallenge]);

  // Decoupled timeout trigger
  const triggerTimeout = useCallback(() => {
    chainMistakeCountRef.current++;
    timeoutsRef.current++;
    nodeComboRef.current = 0;
    readStreakRef.current = 0;

    triggerFlash();
    audioSynth?.playFail();

    recordEvent('timeout');
    registerMiss();

    if (canvasRef.current) {
      spawnChain(canvasSizeRef.current.width, canvasSizeRef.current.height);
    }

  }, [recordEvent, registerMiss, isChallenge, triggerFlash]);

  // Anti-clustering chain spawner
  const spawnChain = useCallback((W, H) => {
    const currentTempo = tempoIndexRef.current;
    
    // Chain length used to jump 3 -> 4 at tempo 0.35 and 4 -> 5 at 0.7. Two
    // cliffs, and the FIRST of them landed on the same threshold that deleted
    // the ordering cue below — two step-ups at once, which is what made this
    // drill lurch. It is now a fractional length rounded by coin flip per
    // chain, so the average walks 3 -> 5 continuously and 4-node chains show up
    // occasionally well before they become the norm.
    const length = Math.max(3, Math.min(5, stochasticRound(3 + currentTempo * 2)));

    // How strongly the "which node is next" hint is drawn: 1 = the full taper
    // and fade a beginner gets, 0 = no hint at all. This used to be the tier
    // 1/tier 2 boundary, so the entire hint vanished between one chain and the
    // next at tempo 0.35. It now dissolves gradually across a band.
    const cueStrength = Math.max(0, Math.min(1,
      (CUE_FADE_END - currentTempo) / (CUE_FADE_END - CUE_FADE_START)
    ));
    // cueTierRef still feeds the read-streak stat, which counts only chains
    // played without the hint. Derived from the same fade so the stat keeps its
    // meaning without reintroducing a difficulty step.
    cueTierRef.current = cueStrength > 0.5 ? 1 : (currentTempo >= 0.7 ? 3 : 2);

    // Node size tracks the CHAIN LENGTH, not the tempo.
    //
    // The distinction matters and this line has been both ways. It used to be
    // `Math.max(13, 25 - currentTempo * 16)` — targets shrinking steadily as
    // the clock ramped, which is difficulty arriving as a smaller thing to hit
    // rather than as a harder task, and it was removed for that reason. What
    // is left is a spatial fact: five nodes have to share the same board three
    // nodes had, so at full size a long chain is a more crowded, less legible
    // picture than a short one.
    //
    // So it steps only with the node count, and only a little — 25 at three
    // nodes down to a hard floor of 18 at five. Nothing here can reach the
    // 13px of the old tempo ramp; the tap window, the spread and the trap node
    // still carry the actual difficulty.
    const radius = Math.max(18, 25 - (length - 3) * 3.5);
    const windowTime = Math.max(0.6, 2.5 - currentTempo * 1.9);
    
    nodeWindowMsRef.current = windowTime;

    const spread = Math.min(500, 220 + currentTempo * 350);

    // The play area is the WHOLE canvas, minus only what a node physically
    // needs to stay on-screen.
    //
    // This used to be `pad = Math.max(80, radius + 25)` applied to all four
    // sides. That 80px floor is most of a phone: in landscape the canvas is
    // only ~360 CSS px tall, so 80 top + 80 bottom left ~200px of usable
    // height — the drill spawned inside the middle ~55% of the screen and the
    // edges were dead space. The inset only ever has to clear the node's own
    // radius and its glow.
    const padX = Math.min(radius + 14, W * 0.10);
    const padY = Math.min(radius + 14, H * 0.10);
    const boundsW = Math.max(10, W - padX * 2);
    const boundsH = Math.max(10, H - padY * 2);

    // The three HUD overlays are the real reason a blanket inset existed: the
    // score (top-left), the clock (top-right) and the sound toggle
    // (bottom-right, the only one that also swallows taps). They occupy
    // CORNERS, not whole edges, so they're excluded as boxes — that keeps the
    // entire top-centre of the board in play, which a uniform top inset threw
    // away. A candidate landing in a corner is slid vertically clear of it
    // rather than rejected, so the spawner can't run out of positions.
    const HUD_W = 96, HUD_TOP = 74, HUD_BOTTOM = 54;
    const clearHud = (cx, cy, r) => {
      const nearLeft = cx - r < HUD_W;
      const nearRight = cx + r > W - HUD_W;
      if ((nearLeft || nearRight) && cy - r < HUD_TOP) return Math.min(H - padY, HUD_TOP + r);
      if (nearRight && cy + r > H - HUD_BOTTOM) return Math.max(padY, H - HUD_BOTTOM - r);
      return cy;
    };

    const baseX = padX + Math.random() * boundsW;
    const baseY = clearHud(baseX, padY + Math.random() * boundsH, radius);

    const spawnedNodes = [];

    for (let i = 0; i < length; i++) {
      let bestX = baseX;
      let bestY = baseY;
      let bestMinDist = -1;

      for (let attempt = 0; attempt < 12; attempt++) {
        const dx = (Math.random() - 0.5) * spread;
        const dy = (Math.random() - 0.5) * spread;
        const cx = Math.max(padX, Math.min(W - padX, baseX + dx));
        const cy = clearHud(cx, Math.max(padY, Math.min(H - padY, baseY + dy)), radius);

        let minDist = 9999;
        spawnedNodes.forEach(n => {
          const d = Math.hypot(n.x - cx, n.y - cy);
          if (d < minDist) minDist = d;
        });

        if (minDist > bestMinDist) {
          bestMinDist = minDist;
          bestX = cx;
          bestY = cy;
        }
        if (minDist > radius * 3.5) break;
      }

      // Scaled by cueStrength rather than gated on the tier: at full strength
      // these are the exact old tier-1 values, at zero the exact old tier-2/3
      // values, and everything between is a real in-between.
      const nodeR = Math.max(10, radius - i * (radius * 0.22) * cueStrength);
      const nodeOpacity = Math.max(0.15, 1.0 - i * 0.25 * cueStrength);

      spawnedNodes.push({
        x: bestX,
        y: bestY,
        r: nodeR,
        opacity: nodeOpacity,
        isTrap: false,
        hit: false
      });
    }

    // The trap node used to appear on every chain from tempo 0.65 and on none
    // below it. Its odds now climb across a band, so the first traps arrive
    // earlier and occasionally, then become the norm.
    const trapChance = Math.max(0, Math.min(1,
      (currentTempo - TRAP_FADE_IN_START) / (TRAP_FADE_IN_END - TRAP_FADE_IN_START)
    ));
    if (Math.random() < trapChance) {
      let bestX = baseX;
      let bestY = baseY;
      let bestMinDist = -1;

      for (let attempt = 0; attempt < 15; attempt++) {
        const dx = (Math.random() - 0.5) * spread * 1.2;
        const dy = (Math.random() - 0.5) * spread * 1.2;
        const cx = Math.max(padX, Math.min(W - padX, baseX + dx));
        const cy = clearHud(cx, Math.max(padY, Math.min(H - padY, baseY + dy)), radius);

        let minDist = 9999;
        spawnedNodes.forEach(n => {
          const d = Math.hypot(n.x - cx, n.y - cy);
          if (d < minDist) minDist = d;
        });

        if (minDist > bestMinDist) {
          bestMinDist = minDist;
          bestX = cx;
          bestY = cy;
        }
        if (minDist > radius * 4.0) break;
      }

      spawnedNodes.push({
        x: bestX,
        y: bestY,
        r: radius,
        opacity: 1.0,
        isTrap: true,
        hit: false
      });
    }

    chainRef.current = spawnedNodes;
    activeIndexRef.current = 0;
    chainSpawnTimeRef.current = performance.now();
    nodeSpawnTimeRef.current = performance.now();
  }, []);

  // Pointer Down resolver (Hit logic)
  const handlePointerDown = useCallback((e) => {
    const now = performance.now();
    if (now - lastResolveTimeRef.current < 50) return;

    if (!gameActiveRef.current) return;

    const cvs = canvasRef.current;
    if (!cvs) return;

    const rect = cvs.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;

    const scaleX = canvasSizeRef.current.width / rect.width;
    const scaleY = canvasSizeRef.current.height / rect.height;

    const clickX = (clientX - rect.left) * scaleX;
    const clickY = (clientY - rect.top) * scaleY;

    lastResolveTimeRef.current = now;
    totalClicksRef.current++;

    const chain = chainRef.current;
    const activeIdx = activeIndexRef.current;

    if (chain.length === 0 || activeIdx >= chain.length) return;

    const activeNode = chain[activeIdx];
    const distToActive = Math.hypot(clickX - activeNode.x, clickY - activeNode.y);
    const hitTolerance = activeNode.r + 15;

    // 1. Correct Hit
    if (distToActive <= hitTolerance) {
      const reactionTime = now - nodeSpawnTimeRef.current;
      nodeSpawnTimeRef.current = now;

      // The anti-cheat window used to gate the WHOLE hit: a gap outside
      // 80-5000ms skipped the sound, the particles, the score and the index
      // advance, and the handler returned. Two nodes tapped less than 80ms
      // apart is not cheating — it is what drumming a memorised chain with two
      // fingers looks like — so a correct tap in the middle of a set just
      // vanished with no feedback at all. That is the "sometimes clicking
      // makes no sound" report.
      //
      // The tap always registers now. The guard is applied where it actually
      // belongs: an implausible gap earns no SPEED BONUS (reactionMs goes in
      // as null) and is left out of the adaptive tempo stats, so it still
      // cannot be farmed.
      const plausible = isValidReactionTime(reactionTime);
      {
        hitsRef.current++;
        nodeComboRef.current++;
        if (nodeComboRef.current > bestNodeComboRef.current) {
          bestNodeComboRef.current = nodeComboRef.current;
        }

        spawnParticles(activeNode.x, activeNode.y, '#10b981', 8);
        audioSynth?.playHit();

        const nodeScore = scoreAction({
          category: 'cognitive',
          combo: nodeComboRef.current - 1,
          reactionMs: plausible ? reactionTime : null,
          timeRemaining: timeLeftRef.current,
          totalGameTime: totalTime,
          livesRemaining: scoringLives(0),
          level: 1 + Math.floor(tempoIndexRef.current * 9),
          maxLevel: scoringMaxLevel(isChallenge),
        });

        scoreRef.current += nodeScore.total;
        // Buy back a slice of the clock. Solo only - in a duel the clock comes from
        // duelDeadlineRef (the match's shared absolute end instant), which nothing
        // local may move. No state is set here; the existing tick redraws the
        // seconds when the displayed number changes, so this costs nothing per hit.
        if (!isChallenge) {
          timeLeftRef.current = applyHit({ timeRemaining: timeLeftRef.current, level: 1 + Math.floor(tempoIndexRef.current * 9), hits: hitsRef.current });
        }
        setScore(scoreRef.current);
        spawnScorePopup(activeNode.x, activeNode.y, `+${nodeScore.total}`);
        if (plausible) recordEvent('hit', reactionTime);

        activeIndexRef.current++;

        if (activeIndexRef.current >= chain.length) {
          chainsCompletedRef.current++;
          // Solo only: finishing a chain buys back 1.5s, so a good run keeps
          // going. A duel must NOT do this — both duelists share one fixed
          // 30s (ARENA_INTEGRATION.md rule 1). Chaining faster than the clock
          // drains held the timer pinned at 30s, so a strong player's match
          // ran on well past the opponent's, who was left stuck on "Waiting
          // for opponent to finish..." the whole time.
          if (!isChallenge) {
            timeLeftRef.current = Math.min(totalTime, timeLeftRef.current + 1.5);
          }

          if (chainMistakeCountRef.current === 0) {
            if (cueTierRef.current === 2 || cueTierRef.current === 3) {
              readStreakRef.current++;
              if (readStreakRef.current > bestReadStreakRef.current) {
                bestReadStreakRef.current = readStreakRef.current;
              }
            }
          }
          chainMistakeCountRef.current = 0;

          const completionScore = Math.round(15 * getComboMultiplier(nodeComboRef.current));
          scoreRef.current += completionScore;
          setScore(scoreRef.current);

          audioSynth?.playHit();
          spawnParticles(activeNode.x, activeNode.y, '#34d399', 16);
          spawnChain(canvasSizeRef.current.width, canvasSizeRef.current.height);
        }
      }

      return;
    }

    // 2. Trap Node Tap
    const trapNodeIdx = chain.findIndex(n => n.isTrap && !n.hit);
    if (trapNodeIdx !== -1) {
      const trapNode = chain[trapNodeIdx];
      const distToTrap = Math.hypot(clickX - trapNode.x, clickY - trapNode.y);
      if (distToTrap <= trapNode.r + 15) {
        trapNode.hit = true;
        chainMistakeCountRef.current++;
        trapHitsRef.current++;

        nodeComboRef.current = 0;
        readStreakRef.current = 0;

        triggerFlash();
        audioSynth?.playTrapTap();
        spawnParticles(trapNode.x, trapNode.y, '#ef4444', 12);
        recordEvent('trap');
        registerMiss();

        return;
      }
    }

    // 3. Clicked other sequence nodes (Wrong Order)
    let wrongNodeClicked = false;
    for (let i = activeIdx + 1; i < chain.length; i++) {
      const n = chain[i];
      if (n.isTrap) continue;
      const d = Math.hypot(clickX - n.x, clickY - n.y);
      if (d <= n.r + 15) {
        wrongNodeClicked = true;
        chainMistakeCountRef.current++;
        wrongOrderRef.current++;

        nodeComboRef.current = 0;
        readStreakRef.current = 0;

        triggerFlash();
        audioSynth?.playWrongOrder();
        spawnParticles(n.x, n.y, '#f59e0b', 8);
        recordEvent('wrong-order');
        registerMiss();
        break;
      }
    }

    // 4. Whiff
    if (!wrongNodeClicked) {
      chainMistakeCountRef.current++;
      whiffsRef.current++;

      nodeComboRef.current = 0;
      readStreakRef.current = 0;

      triggerFlash();
      audioSynth?.playFail();
      recordEvent('whiff');
      registerMiss();
    }

  }, [spawnChain, spawnParticles, spawnScorePopup, recordEvent, registerMiss, isChallenge, totalTime, triggerFlash]);

  // Initial local stats extraction
  useEffect(() => {
    try {
      const savedBest = localStorage.getItem('sequenceAim_bestScore');
      if (savedBest) setBestScore(parseInt(savedBest, 10));
      const savedCombo = localStorage.getItem('sequenceAim_bestCombo');
      if (savedCombo) setBestCombo(parseInt(savedCombo, 10));
      const savedStreak = localStorage.getItem('sequenceAim_bestReadStreak');
      if (savedStreak) setBestReadStreak(parseInt(savedStreak, 10));
      const savedBestLevel = localStorage.getItem('sequenceAim_bestLevel');
      if (savedBestLevel) setBestLevel(parseInt(savedBestLevel, 10));
    } catch {}

    return () => {
      try { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); } catch {}
      if (Capacitor.isNativePlatform()) {
        StatusBar.setOverlaysWebView({ overlay: false }).catch(() => {});
        StatusBar.show().catch(() => {});
      }
      unlockOrientation();
    };
  }, []);

  // Device orientation / layout on mount
  useEffect(() => {
    const checkOrientation = () => {
      const width = window.innerWidth;
      const isTouch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;

      let type = 'desktop';
      if (width < 768 || (isTouch && width < 1024)) type = 'mobile';
      else if (width < 1280 && isTouch) type = 'tablet';

      deviceTypeRef.current = type;
    };

    checkOrientation();
    return onOrientationSettled(checkOrientation);
  }, []);

  // Shared countdown runner — duels skip the visible 3-2-1 (n=0) and its
  // audio, per ARENA_INTEGRATION.md rule 2.
  const runCountdown = useCallback((n) => {
    if (countdownTimerRef.current) clearTimeout(countdownTimerRef.current);
    setPhase('countdown');
    if (n <= 0) {
      if (!isChallenge) audioSynth?.playGo();
      setCountdownValue(0);
      setPhase('playing');
      scheduleHeartbeat();
      if (canvasRef.current) {
        spawnChain(canvasSizeRef.current.width, canvasSizeRef.current.height);
      }
      return;
    }
    setCountdownValue(n);
    if (!isChallenge) audioSynth?.playCountdownTick();
    countdownTimerRef.current = setTimeout(() => runCountdown(n - 1), 700);
  }, [spawnChain, scheduleHeartbeat, isChallenge]);

  // Listen to orientation rotate-hint to landscape transitions
  useEffect(() => {
    const onOrientationChange = () => {
      if (phase === 'rotate-hint' && window.innerWidth > window.innerHeight) {
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

  // Input listener registration
  useEffect(() => {
    const cvs = canvasRef.current;
    if (!cvs || phase !== 'playing') return;

    if (deviceTypeRef.current === 'desktop') {
      cvs.addEventListener('mousedown', handlePointerDown);
    } else {
      cvs.addEventListener('touchstart', handlePointerDown, { passive: true });
    }

    return () => {
      if (deviceTypeRef.current === 'desktop') {
        cvs.removeEventListener('mousedown', handlePointerDown);
      } else {
        cvs.removeEventListener('touchstart', handlePointerDown);
      }
    };
  }, [phase, handlePointerDown]);

  // Decoupled game interval clocks
  useEffect(() => {
    if (phase !== 'playing') return;

    const timer = setInterval(() => {
      // Duel: read the clock from the match's shared absolute end instant
      // rather than accumulating it locally — see duelSecondsRemaining. A
      // tick that lands late (busy frame, GC pause, the OS throttling a
      // backgrounded webview) has to cost this player frames, not extra
      // seconds of play their opponent never got.
      timeLeftRef.current = duelDeadlineRef.current
        ? duelSecondsRemaining(duelDeadlineRef.current)
        : Math.max(0, timeLeftRef.current - 0.2);
      elapsedRef.current += 200;

      // Push to React state only when the DISPLAYED whole second changes. The
      // clock is read to the second and the timer bar animates itself in CSS, so
      // the other four ticks each second were re-rendering the whole component
      // to paint an identical picture — five times the renders for no visible
      // difference. The ref keeps full precision for scoring maths.
      setTimeLeft((prev) => (
        Math.ceil(prev) === Math.ceil(timeLeftRef.current) ? prev : timeLeftRef.current
      ));

      if (timeLeftRef.current <= 0) {
        clearInterval(timer);
        endGame();
      }
    }, 200);

    return () => clearInterval(timer);
  }, [phase, endGame]);

  // Play initiator
  const startGame = useCallback(async () => {
    // Unmount the start card on the tap itself, before the rotation begins.
    setLaunching(true);
    if (audioSynth) audioSynth.init();


    if (!isChallenge && containerRef.current && !document.fullscreenElement) {
      try { await containerRef.current.requestFullscreen(); } catch {}
    }
    if (Capacitor.isNativePlatform()) {
      StatusBar.setOverlaysWebView({ overlay: true }).catch(() => {});
      StatusBar.hide().catch(() => {});
    }

    try { await lockLandscape(); } catch {}

    // Every run starts at the lowest difficulty. It used to start at 55% of the
    // player's best level, so improving once permanently raised the speed every
    // future run opened at - a silent spike with nothing on screen explaining it.
    // That head-start only existed because a fixed 45s was too short to climb the
    // ramp; the endurance clock replaces it.
    const runStartLevel = 1;
    const startTempoIndex = Math.max(0.1, Math.min(1.0, (runStartLevel - 0.5) / 9));

    setScore(0);
    setTimeLeft(totalTime);
    setLevel(runStartLevel);
    setDangerLevel(0);
    setEndSummary(null);

    scoreRef.current = 0;
    timeLeftRef.current = totalTime;
    runOverRef.current = false;
    elapsedRef.current = 0;
    nodeComboRef.current = 0;
    bestNodeComboRef.current = 0;
    readStreakRef.current = 0;
    bestReadStreakRef.current = 0;
    tempoIndexRef.current = startTempoIndex;
    historyRef.current = [];
    gameActiveRef.current = true;
    chainMistakeCountRef.current = 0;
    lastResolveTimeRef.current = 0;

    totalClicksRef.current = 0;
    hitsRef.current = 0;
    wrongOrderRef.current = 0;
    whiffsRef.current = 0;
    trapHitsRef.current = 0;
    timeoutsRef.current = 0;
    chainsCompletedRef.current = 0;
    bestLevelRunRef.current = runStartLevel;

    // Wait for the viewport to actually stop moving before showing the countdown,
    // instead of guessing with a fixed delay — see afterViewportSettled in
    // lib/orientation.js. A blind timeout let the "3" mount mid-resize and jump.
    afterViewportSettled(() => {
      if (window.innerHeight > window.innerWidth && ('ontouchstart' in window || navigator.maxTouchPoints > 0)) {
        setPhase('rotate-hint');
      } else {
        runCountdown(isChallenge ? 0 : 3);
      }
    });
  }, [runCountdown, bestLevel, isChallenge, totalTime]);

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
      startGame();
    }, delay);
    return () => clearTimeout(t);
  }, [isChallenge, matchStartAt, phase, startGame]);

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
  // so there's room to finish this well beforehand on both devices — the
  // startGame path's own lockLandscape() call then just resolves
  // immediately since the device is already there.
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
    setTimeLeft(totalTime);
  }, [challengeId, totalTime]);

  // Score card. Drawn and encoded while the result screen sits idle,
  // not on the tap - see useShareCard in components/ShareScoreCard.js.
  const shareScore = useShareCard(endSummary ? {
    score: endSummary.score,
    bestScore: endSummary.prevBest ?? bestScore,
    accuracy: endSummary.accuracy,
    bestCombo: endSummary.bestCombo,
    rating: getGrade(endSummary.accuracy),
    newBest: endSummary.isNewBest,
    drillName: 'Sequence Aim Trainer',
    playerName: getPlayerName(),
  } : null, {
    url: APP_SHARE_URL,
    title: 'My Mobile Aim Sequence Score',
    text: endSummary ? `🎯 I scored ${score} PTS (Level ${level}) in the Sequence Aim Trainer! Accuracy: ${endSummary.accuracy}%, Max Combo: ${endSummary.bestCombo}x, Streak: ${endSummary.bestReadStreak}. Get SkillDrills:` : '',
  });

  // RAF rendering loop.
  //
  // Only runs while there is actually something animating. It used to run for
  // the component's entire lifetime: the background fill + grid strokes below
  // are unconditional, so a full-screen canvas was being repainted 60x/sec
  // behind the start screen, the rotate hint, and the result screen — burning
  // CPU and battery indefinitely on screens where nothing moves. The
  // countdown is included because the board is already visible underneath it.
  useEffect(() => {
    if (phase !== 'playing' && phase !== 'countdown') return;
    const cvs = canvasRef.current;
    if (!cvs) return;
    const ctx = cvs.getContext('2d', { alpha: false });

    let animationFrameId;
    let lastDrawTs = 0;

    // Static backdrop (flat fill + 40px grid) rendered ONCE into an offscreen
    // canvas and blitted, instead of re-stroking ~40 line segments on every one
    // of 60 frames a second for an image that never changes. Same technique as
    // Target Lock's dot grid. Rebuilt only when the canvas is actually resized.
    const bgCanvas = document.createElement('canvas');
    const bgCtx = bgCanvas.getContext('2d', { alpha: false });
    let bgW = 0;
    let bgH = 0;

    const ensureBackground = (w, h, dpr) => {
      if (!bgCtx || w <= 0 || h <= 0) return false;
      if (bgW === w && bgH === h && bgCanvas.width > 0) return true;
      bgW = w;
      bgH = h;
      bgCanvas.width = Math.round(w * dpr);
      bgCanvas.height = Math.round(h * dpr);
      bgCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      bgCtx.fillStyle = '#050508';
      bgCtx.fillRect(0, 0, w, h);
      bgCtx.strokeStyle = 'rgba(255, 255, 255, 0.015)';
      bgCtx.lineWidth = 1;
      bgCtx.beginPath();
      for (let x = 0; x < w; x += 40) { bgCtx.moveTo(x, 0); bgCtx.lineTo(x, h); }
      for (let y = 0; y < h; y += 40) { bgCtx.moveTo(0, y); bgCtx.lineTo(w, y); }
      bgCtx.stroke();
      return true;
    };

    const render = (ts = performance.now()) => {
      // Adaptive cap: 14ms (~60fps) while particles are on screen, 32ms
      // (~30fps) otherwise. Gameplay objects here are static tap targets, so
      // 30 is right for the bulk of the run — but the tap burst is a real
      // animation and 31fps is visible on it. An uncapped loop would make
      // 90-120Hz phones redraw more than needed for the same visual result.
      // The timeout check below reads performance.now() directly, so it stays
      // accurate regardless.
      const capParticles = particlesRef.current && particlesRef.current.length > 0;
      if (ts - lastDrawTs < (capParticles ? 14 : 32)) {
        animationFrameId = requestAnimationFrame(render);
        return;
      }
      lastDrawTs = ts;

      const dpr = canvasDpr();
      const w = canvasSizeRef.current.width;
      const h = canvasSizeRef.current.height;

      ctx.save();
      ctx.scale(dpr, dpr);

      // 1 + 2. Backdrop and grid — one blit of the pre-rendered image.
      if (ensureBackground(w, h, dpr)) {
        ctx.drawImage(bgCanvas, 0, 0, w, h);
      } else {
        ctx.fillStyle = '#050508';
        ctx.fillRect(0, 0, w, h);
      }

      const activeIdx = activeIndexRef.current;
      const chain = chainRef.current;
      const isPlaying = gameActiveRef.current && phase === 'playing';

      // 3. Draw the dashed route line between the remaining sequence nodes.
      //
      // Shown on EVERY set now, at the owner's request — it used to be tier 1
      // only. Worth knowing what that costs: this line joins the nodes in
      // order, so it gives the whole route away exactly as plainly as the
      // numbers that used to be stamped on them, and the drill becomes tracing
      // a pre-drawn path rather than recalling a sequence. Tier 1 kept it
      // because tier 1 is the teaching set. If the reveal ever needs pulling
      // back without losing the line entirely, the middle ground is to stroke
      // only the segment from the active node to the next one.
      if (isPlaying && chain.length > 0) {
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(168, 85, 247, 0.25)';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 6]);
        let started = false;
        for (let i = activeIdx; i < chain.length; i++) {
          if (chain[i].isTrap) continue;
          if (!started) {
            ctx.moveTo(chain[i].x, chain[i].y);
            started = true;
          } else {
            ctx.lineTo(chain[i].x, chain[i].y);
          }
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // 4. Draw sequence nodes
      if (isPlaying && chain.length > 0) {
        const now = performance.now();
        const elapsedSinceSpawn = now - nodeSpawnTimeRef.current;
        const allowedMs = nodeWindowMsRef.current * 1000;

        if (elapsedSinceSpawn >= allowedMs) {
          triggerTimeout();
        }

        const timeRatio = Math.max(0, 1 - (elapsedSinceSpawn / allowedMs));

        chain.forEach((node, idx) => {
          if (idx < activeIdx && !node.isTrap) return;
          if (node.isTrap && node.hit) return;

          ctx.beginPath();
          ctx.arc(node.x, node.y, node.r, 0, Math.PI * 2);

          if (node.isTrap) {
            ctx.fillStyle = 'rgba(239, 68, 68, 0.08)';
            ctx.fill();
            ctx.strokeStyle = '#ef4444';
            ctx.lineWidth = 1.5;
            ctx.stroke();
            
            ctx.fillStyle = '#ef4444';
            ctx.font = `bold ${Math.round(node.r * 0.9)}px monospace`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('!', node.x, node.y);
          } else if (idx === activeIdx) {
            const pulse = 1 + Math.sin(now * 0.008) * 0.08;
            ctx.fillStyle = 'rgba(16, 185, 129, 0.15)';
            ctx.fill();
            ctx.strokeStyle = '#10b981';
            ctx.lineWidth = 2.5 * pulse;
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(node.x, node.y, 4, 0, Math.PI * 2);
            ctx.fillStyle = '#10b981';
            ctx.fill();

            ctx.beginPath();
            ctx.arc(node.x, node.y, node.r + 6, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * timeRatio);
            ctx.strokeStyle = timeRatio > 0.35 ? '#10b981' : '#ef4444';
            ctx.lineWidth = 3;
            ctx.stroke();

            // The live node is ALWAYS labelled, and it is always a 1.
            //
            // `idx - activeIdx + 1` is 1 by definition here (idx === activeIdx);
            // it is written out because the label is now the whole cue. It used
            // to vanish after 800ms at tier 3, which left the player with no
            // marker at all on the hardest tier — the number is the one thing
            // that should never blink out.
            ctx.fillStyle = '#ffffff';
            ctx.font = `bold ${Math.round(node.r * 0.85)}px sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText('1', node.x, node.y);
          } else {
            ctx.fillStyle = 'rgba(255, 255, 255, 0.02)';
            ctx.fill();
            ctx.strokeStyle = `rgba(168, 85, 247, ${node.opacity})`;
            ctx.lineWidth = 1;
            ctx.stroke();

            // Upcoming nodes carry NO number.
            //
            // Tiers 1 and 2 used to stamp 2, 3, 4... on the whole chain the
            // moment it spawned, so the entire route was readable up front and
            // the drill degraded into tracing a pre-drawn path. The order is
            // revealed one step at a time now: whichever node is live shows a
            // 1, you tap it, and the 1 appears on the next one. Nothing on
            // screen tells you where that will be until it happens, which is
            // the point of a sequencing drill.
          }
        });
      }

      // 5. Draw particles
      const particles = particlesRef.current;
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        p.life -= 0.016;
        if (p.life <= 0) {
          particles.splice(i, 1);
          continue;
        }
        p.x += p.vx * 0.016;
        p.y += p.vy * 0.016;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        ctx.fillStyle = p.color;
        ctx.fill();
      }

      // 5b. Draw score-release text
      const pops = scorePopupsRef.current;
      for (let i = pops.length - 1; i >= 0; i--) {
        const p = pops[i];
        p.life -= 0.0167;
        if (p.life <= 0) {
          pops.splice(i, 1);
          continue;
        }
        p.y -= 0.63;
        ctx.globalAlpha = p.life;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = 'bold 15px monospace';
        ctx.fillStyle = p.color;
        ctx.fillText(p.text, p.x, p.y);
        ctx.globalAlpha = 1.0;
      }

      // The mistake flash used to be painted here, as a full-canvas fillRect.
      // It is a CSS layer now (see triggerFlash), so the draw loop no longer
      // touches every pixel on the frames right after a miss.

      ctx.restore();
      animationFrameId = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [phase, triggerTimeout]);

  // Idle screens (start / rotate-hint / ended) get ONE static paint of the
  // same backdrop the loop above would draw, instead of the loop running
  // forever to redraw an unchanging image. The canvas is opaque
  // (`{ alpha: false }`) and covers the whole play area, so without this it
  // would sit as flat default-black rather than the drill's #050508 + grid.
  useEffect(() => {
    if (phase === 'playing' || phase === 'countdown') return;
    const cvs = canvasRef.current;
    const ctx = cvs?.getContext('2d', { alpha: false });
    if (!ctx) return;

    const paintIdle = () => {
      const dpr = canvasDpr();
      const w = canvasSizeRef.current.width;
      const h = canvasSizeRef.current.height;
      if (!w || !h) return;
      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.fillStyle = '#050508';
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.015)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x < w; x += 40) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
      for (let y = 0; y < h; y += 40) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
      ctx.stroke();
      ctx.restore();
    };

    // One frame late so it runs after the resize observer has sized the
    // backing store on first mount (otherwise width/height are still 0).
    const raf = requestAnimationFrame(paintIdle);
    return () => cancelAnimationFrame(raf);
  }, [phase]);

  // Canvas auto-resizer
  useEffect(() => {
    const cvs = canvasRef.current;
    const container = containerRef.current;
    if (!cvs || !container) return;

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          const dpr = canvasDpr();
          cvs.width = width * dpr;
          cvs.height = height * dpr;
          canvasSizeRef.current = { width, height };
        }
      }
    });

    resizeObserver.observe(container);
    return () => resizeObserver.disconnect();
  }, []);

  return (
    <DrillWrapper
      drillName="Sequence Aim Trainer"
      category="cognitive"
      score={score}
      timeLeft={phase === 'ended' ? 0 : Math.ceil(timeLeft)}
      soundEnabled={soundEnabled}
      onSoundToggle={() => setSoundEnabled(s => { audioSynth?.setEnabled(!s); return !s; })}
      backHref="/"
      minimalChrome
    >
      <div 
        ref={containerRef}
        className="absolute inset-0 select-none overflow-hidden bg-[#050508] text-white"
        style={{ touchAction: phase === 'playing' ? 'none' : 'auto', WebkitTapHighlightColor: 'transparent' }}
      >
        {/* Danger Heartbeat Vignette */}
        {phase === 'playing' && dangerLevel > 0.05 && (
          <div className="fx-vignette" style={{ '--v-min': Math.max(0.04, dangerLevel * 0.22), '--v-max': Math.min(0.55, dangerLevel * 0.70), animationDuration: `${heartbeatTempoRef.current}ms` }} />
        )}

        {/* Live Gameplay Canvas — draws its own opaque background + grid
            every frame (see the render() effect below), so a separate CSS
            grid layer underneath would always be fully hidden. */}
        <canvas
          ref={canvasRef}
          className="block absolute top-0 left-0 w-full h-full touch-none z-10"
        />

        {/* Mistake flash. Above the canvas (z-55 in the shared class) so it
            washes the board rather than being painted into it. */}
        {flashes.map((f) => (
          <div key={f.id} className="fx-flash fx-flash-red" />
        ))}

        {/* Rotate Gating Screen */}
        {phase === 'rotate-hint' && !isChallenge && (
          <div className="absolute inset-0 z-[100] flex flex-col items-center justify-center bg-black/95 text-center p-6 select-none">
            <div className="animate-bounce mb-5 text-emerald-400"><RotateCw className="w-12 h-12 mx-auto" /></div>
            <p className="text-sm font-bold text-white">Rotate your phone to play</p>
            <p className="text-xs text-slate-500 mt-1.5 max-w-[220px] mx-auto font-sans">Your browser can't rotate this for you — turn your device to landscape.</p>
          </div>
        )}

        {/* START SCREEN */}
        {phase === 'start' && !launching && !isChallenge && (
          <DrillStartCard
            drillName="Finger Sequencing"
            tagline="Tap the targets in number order"
            rules={[
              'Tap the targets in number order',
              'Numbers hide as you level up',
              'Chains buy time, slips cost it',
            ]}
            bestStrip={bestScore > 0 ? [
              { value: bestScore.toLocaleString(), label: 'Best · PTS' },
              { value: `${bestCombo}×`, label: 'Combo' },
              { value: String(bestReadStreak), label: 'Streak' },
            ] : null}
            orientation="landscape"
            onStart={startGame}
          />
        )}

        {/* PLAYING HUD OVERLAYS */}
        {phase === 'playing' && (
          <>
            {/* Live Stats Overlay (Top-Left) */}
            <div className="absolute top-5 left-5 z-40 flex flex-col pointer-events-none select-none">
              <span className="text-2xl font-hud font-bold text-white leading-none tabular-nums">{score}</span>
            </div>

            <div className="absolute top-5 right-5 z-40 flex flex-col items-end pointer-events-none select-none">
              <span className={`text-3xl font-hud font-bold leading-none tabular-nums ${timeLeft <= 10 ? 'text-red-500 animate-pulse' : 'text-slate-300'}`}>
                {Math.ceil(timeLeft)}s
              </span>
              <span className="text-[8px] label-tiny text-slate-500 mt-1">Time Left</span>
            </div>

            {/* Sound toggle */}
            <button
              onClick={() => setSoundEnabled(s => { audioSynth?.setEnabled(!s); return !s; })}
              className="absolute bottom-5 right-5 z-40 p-2 before:absolute before:top-0 before:left-0 before:-right-[14px] before:-bottom-[14px] before:content-[''] rounded-full bg-black/60 border border-white/10 text-slate-400 active:scale-90 transition-transform pointer-events-auto cursor-pointer"
            >
              {soundEnabled ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
            </button>

          </>
        )}

        {/* COUNTDOWN SCREEN */}
        {phase === 'countdown' && !isChallenge && (
          <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/55 select-none">
            <span className="text-[11px] font-black uppercase tracking-[0.2em] text-slate-400">Get Ready</span>
            <div className="relative w-28 h-28 rounded-full border-[3px] border-emerald-500/20 flex items-center justify-center">
              <div className="absolute -inset-[3px] rounded-full border-[3px] border-transparent border-t-emerald-400 border-r-emerald-400 animate-spin" style={{ animationDuration: '0.7s' }} />
              <span key={countdownValue} className="fx-pop-in text-5xl font-display bg-gradient-to-b from-white to-emerald-300 bg-clip-text text-transparent">
                {countdownValue > 0 ? countdownValue : 'GO'}
              </span>
            </div>
            <span className="text-[10px] text-slate-500 font-sans">First chain spawns at GO</span>
          </div>
        )}

        {/* RESULT SCREEN */}
        {phase === 'ended' && endSummary && !isChallenge && (
          <ResultScreen
            signature
            summary={endSummary}
            bestScore={bestScore}
            synth={audioSynth}
            onPlayAgain={startGame}
            onShare={shareScore}
          />
        )}
      </div>
    </DrillWrapper>
  );
}

