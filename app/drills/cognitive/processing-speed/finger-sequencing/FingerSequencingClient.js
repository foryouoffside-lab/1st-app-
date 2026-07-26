'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  Activity, AlertCircle, ArrowLeft, BarChart3, ChevronRight,
  Clock, Eye, GraduationCap, Info, Lightbulb,
  Maximize2, Minimize2, Play, RefreshCw, Target,
  Timer, TrendingUp, Trophy, Volume2, VolumeX,
  Share2, CheckCircle2, Zap, Users, Sparkles, XCircle, GitBranch, RotateCw, Heart
} from 'lucide-react';
import { scoreAction, calcEndBonuses, calcSessionXP, getGrade, isValidReactionTime } from '../../../../../lib/scoringEngine';
import { saveLeaderboardEntrySync } from '../../../../../lib/leaderboard';
import { lockLandscape, unlockOrientation } from '../../../../../lib/orientation';
import { previewDailyCompletion } from '../../../../../lib/dailyChallenge';
import { getPlayerName } from '../../../../../lib/progressStore';
import { Capacitor } from '@capacitor/core';
import { StatusBar } from '@capacitor/status-bar';
import generateShareCard, { shareScoreCard } from '../../../../../components/ShareScoreCard';
import DrillWrapper from '../../../../../components/DrillWrapper';
import { useDuelMatchStart } from '../../../../../lib/challengeEngine';
import { canvasDpr } from '../../../../../lib/canvasFx';

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
    } catch(e) {}
  }

  playHit() {
    this.tone(1200, 0.08, 'sine', 0.1, 1500);
  }

  playCountdownTick() { this.tone(440, 0.09, 'sine', 0.12, 440); }
  playGo() { this.tone(523.25, 0.18, 'triangle', 0.17, 784); }

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
    } catch (e) {}
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
    } catch (e) {}
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
    } catch (e) {}
  }

  setEnabled(status) {
    this.enabled = status;
  }
}

const audioSynth = typeof window !== 'undefined' ? new AudioSynthesizer() : null;
const GAME_DURATION = 45;
const MAX_LIVES = 5;
const MAX_LEVEL = 10;
const getComboMultiplier = (combo) => 1.0 + Math.floor(combo / 5) * 0.2;

export default function FingerSequencingClient() {
  const searchParams = useSearchParams();
  const challengeId = searchParams ? searchParams.get('challengeId') : null;
  const isChallenge = !!challengeId;
  const totalTime = isChallenge ? 30 : GAME_DURATION;

  // === UI & Viewport State ===
  const [phase, setPhase] = useState('start'); // 'start' | 'countdown' | 'playing' | 'rotate-hint' | 'ended'
  const [countdownValue, setCountdownValue] = useState(3);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [isStarting, setIsStarting] = useState(false);

  // === Settings & Local Stats ===
  const [score, setScore] = useState(0);
  const [bestScore, setBestScore] = useState(0);
  const [bestCombo, setBestCombo] = useState(0);
  const [bestReadStreak, setBestReadStreak] = useState(0);
  const [bestLevel, setBestLevel] = useState(1);

  // === Live Stats (UI Sync) ===
  const [timeLeft, setTimeLeft] = useState(totalTime);
  const [nodeCombo, setNodeCombo] = useState(0);
  const [readStreak, setReadStreak] = useState(0);
  const [level, setLevel] = useState(1);
  const [lives, setLives] = useState(MAX_LIVES);
  const [liveAccuracy, setLiveAccuracy] = useState(100);
  const [dangerLevel, setDangerLevel] = useState(0);
  const [deviceType, setDeviceType] = useState('desktop');

  // === Overlays & Summary ===
  const [endSummary, setEndSummary] = useState(null);

  // === Refs ===
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const canvasSizeRef = useRef({ width: 0, height: 0 });

  // Gameplay session registers
  const scoreRef = useRef(0);
  const timeLeftRef = useRef(totalTime);
  const elapsedRef = useRef(0);
  const nodeComboRef = useRef(0);
  const bestNodeComboRef = useRef(0);
  const readStreakRef = useRef(0);
  const bestReadStreakRef = useRef(0);
  const tempoIndexRef = useRef(0.2);
  const historyRef = useRef([]);
  const gameActiveRef = useRef(false);
  const livesRef = useRef(MAX_LIVES);

  const chainRef = useRef([]);
  const activeIndexRef = useRef(0);
  const chainSpawnTimeRef = useRef(0);
  const nodeSpawnTimeRef = useRef(0);
  const chainMistakeCountRef = useRef(0);
  const lastResolveTimeRef = useRef(0);

  // Engine refs
  const particlesRef = useRef([]);
  const scorePopupsRef = useRef([]);
  const screenShakeRef = useRef(0);
  const flashRedRef = useRef(0);
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

    const dangerFromLives = livesRef.current <= 2 ? (MAX_LIVES - livesRef.current) / MAX_LIVES : 0;
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
      tempoIndexRef.current = isChallenge
        ? Math.max(tempoIndexRef.current, newTempoIndex)
        : newTempoIndex;

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
      livesRemaining: Math.max(0, livesRef.current),
      maxLives: MAX_LIVES,
      category: 'cognitive'
    });

    const finalScore = endBonuses.finalScore;

    const daily = isChallenge
      ? { isDailyDrill: false, wouldCompleteSet: false }
      : await previewDailyCompletion('finger-sequencing');

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
        } catch(err){}
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
      score: finalScore,
      accuracy: finalAcc,
      bestCombo: bestNodeComboRef.current,
      bestReadStreak: bestReadStreakRef.current,
      xpEarned: xpData.xp,
      isNewBest: finalScore > bestScore,
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
    livesRef.current -= 1;
    setLives(Math.max(0, livesRef.current));
    if (livesRef.current <= 0) {
      endGame();
    }
  }, [endGame, isChallenge]);

  // Decoupled timeout trigger
  const triggerTimeout = useCallback(() => {
    chainMistakeCountRef.current++;
    timeoutsRef.current++;
    nodeComboRef.current = 0;
    readStreakRef.current = 0;

    flashRedRef.current = 0.25;
    screenShakeRef.current = 8;
    audioSynth?.playFail();

    recordEvent('timeout');
    registerMiss();

    if (canvasRef.current) {
      spawnChain(canvasSizeRef.current.width, canvasSizeRef.current.height);
    }

    setNodeCombo(0);
    setReadStreak(0);
  }, [recordEvent, registerMiss, isChallenge]);

  // Anti-clustering chain spawner
  const spawnChain = useCallback((W, H) => {
    const currentTempo = tempoIndexRef.current;
    
    let length = 3;
    if (currentTempo >= 0.7) length = 5;
    else if (currentTempo >= 0.35) length = 4;
    
    let tier = 1;
    if (currentTempo >= 0.7) tier = 3;
    else if (currentTempo >= 0.35) tier = 2;
    cueTierRef.current = tier;

    const radius = Math.max(14, 28 - currentTempo * 18);
    const windowTime = Math.max(0.6, 2.5 - currentTempo * 1.9);
    
    nodeWindowMsRef.current = windowTime;

    const spread = Math.min(500, 220 + currentTempo * 350);
    const pad = Math.max(80, radius + 25);
    const boundsW = Math.max(10, W - pad * 2);
    const boundsH = Math.max(10, H - pad * 2);
    const baseX = pad + Math.random() * boundsW;
    const baseY = pad + Math.random() * boundsH;

    const spawnedNodes = [];

    for (let i = 0; i < length; i++) {
      let bestX = baseX;
      let bestY = baseY;
      let bestMinDist = -1;

      for (let attempt = 0; attempt < 12; attempt++) {
        const dx = (Math.random() - 0.5) * spread;
        const dy = (Math.random() - 0.5) * spread;
        const cx = Math.max(pad, Math.min(W - pad, baseX + dx));
        const cy = Math.max(pad, Math.min(H - pad, baseY + dy));

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

      let nodeR = radius;
      let nodeOpacity = 1.0;
      if (tier === 1) {
        nodeR = Math.max(10, radius - i * (radius * 0.22));
        nodeOpacity = 1.0 - i * 0.25;
      }

      spawnedNodes.push({
        x: bestX,
        y: bestY,
        r: nodeR,
        opacity: nodeOpacity,
        isTrap: false,
        hit: false
      });
    }

    if (currentTempo >= 0.65) {
      let bestX = baseX;
      let bestY = baseY;
      let bestMinDist = -1;

      for (let attempt = 0; attempt < 15; attempt++) {
        const dx = (Math.random() - 0.5) * spread * 1.2;
        const dy = (Math.random() - 0.5) * spread * 1.2;
        const cx = Math.max(pad, Math.min(W - pad, baseX + dx));
        const cy = Math.max(pad, Math.min(H - pad, baseY + dy));

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

      if (isValidReactionTime(reactionTime)) {
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
          reactionMs: reactionTime,
          timeRemaining: timeLeftRef.current,
          totalGameTime: totalTime,
          livesRemaining: livesRef.current,
          maxLives: MAX_LIVES,
          level: 1 + Math.floor(tempoIndexRef.current * 9),
          maxLevel: MAX_LEVEL,
        });

        scoreRef.current += nodeScore.total;
        setScore(scoreRef.current);
        spawnScorePopup(activeNode.x, activeNode.y, `+${nodeScore.total}`);
        recordEvent('hit', reactionTime);

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

      setNodeCombo(nodeComboRef.current);
      setReadStreak(readStreakRef.current);
      setLiveAccuracy(Math.round((hitsRef.current / totalClicksRef.current) * 100));
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

        flashRedRef.current = 0.35;
        audioSynth?.playTrapTap();
        spawnParticles(trapNode.x, trapNode.y, '#ef4444', 12);
        recordEvent('trap');
        registerMiss();

        setNodeCombo(0);
        setReadStreak(0);
        setLiveAccuracy(Math.round((hitsRef.current / totalClicksRef.current) * 100));
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

        flashRedRef.current = 0.25;
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

      flashRedRef.current = 0.2;
      audioSynth?.playFail();
      recordEvent('whiff');
      registerMiss();
    }

    setNodeCombo(0);
    setReadStreak(0);
    setLiveAccuracy(Math.round((hitsRef.current / totalClicksRef.current) * 100));
  }, [spawnChain, spawnParticles, spawnScorePopup, recordEvent, registerMiss, isChallenge, totalTime]);

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
    } catch (e) {}

    return () => {
      try { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); } catch (e) {}
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

      setDeviceType(type);
      deviceTypeRef.current = type;
    };

    checkOrientation();
    window.addEventListener('resize', checkOrientation);
    window.addEventListener('orientationchange', checkOrientation);

    return () => {
      window.removeEventListener('resize', checkOrientation);
      window.removeEventListener('orientationchange', checkOrientation);
    };
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
    countdownTimerRef.current = setTimeout(() => runCountdown(n - 1), 800);
  }, [spawnChain, scheduleHeartbeat, isChallenge]);

  // Listen to orientation rotate-hint to landscape transitions
  useEffect(() => {
    const onOrientationChange = () => {
      if (phase === 'rotate-hint' && window.innerWidth > window.innerHeight) {
        runCountdown(isChallenge ? 0 : 3);
      }
    };
    window.addEventListener('resize', onOrientationChange);
    window.addEventListener('orientationchange', onOrientationChange);
    return () => {
      window.removeEventListener('resize', onOrientationChange);
      window.removeEventListener('orientationchange', onOrientationChange);
    };
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
      timeLeftRef.current = Math.max(0, timeLeftRef.current - 0.2);
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
    if (audioSynth) audioSynth.init();

    setIsStarting(true);
    setTimeout(() => setIsStarting(false), 800);

    if (!isChallenge && containerRef.current && !document.fullscreenElement) {
      try { await containerRef.current.requestFullscreen(); } catch (e) {}
    }
    if (Capacitor.isNativePlatform()) {
      StatusBar.setOverlaysWebView({ overlay: true }).catch(() => {});
      StatusBar.hide().catch(() => {});
    }

    try { await lockLandscape(); } catch (e) {}

    // Duels always start every player at the same, lowest difficulty — no
    // personal-best seeding — so scores are pure skill (ARENA_INTEGRATION.md
    // rule 5 / matchmaking fairness).
    const startLevel = isChallenge ? 1 : Math.max(1, Math.min(MAX_LEVEL, Math.round((bestLevel || 1) * 0.55)));
    const startTempoIndex = Math.max(0.1, Math.min(1.0, (startLevel - 0.5) / 9));

    setScore(0);
    setTimeLeft(totalTime);
    setNodeCombo(0);
    setReadStreak(0);
    setLevel(startLevel);
    setLives(MAX_LIVES);
    setLiveAccuracy(100);
    setDangerLevel(0);
    setEndSummary(null);

    scoreRef.current = 0;
    timeLeftRef.current = totalTime;
    elapsedRef.current = 0;
    nodeComboRef.current = 0;
    bestNodeComboRef.current = 0;
    readStreakRef.current = 0;
    bestReadStreakRef.current = 0;
    tempoIndexRef.current = startTempoIndex;
    historyRef.current = [];
    gameActiveRef.current = true;
    livesRef.current = MAX_LIVES;
    chainMistakeCountRef.current = 0;
    lastResolveTimeRef.current = 0;

    totalClicksRef.current = 0;
    hitsRef.current = 0;
    wrongOrderRef.current = 0;
    whiffsRef.current = 0;
    trapHitsRef.current = 0;
    timeoutsRef.current = 0;
    chainsCompletedRef.current = 0;
    bestLevelRunRef.current = startLevel;

    setTimeout(() => {
      if (window.innerHeight > window.innerWidth && ('ontouchstart' in window || navigator.maxTouchPoints > 0)) {
        setPhase('rotate-hint');
      } else {
        runCountdown(isChallenge ? 0 : 3);
      }
    }, 350);
  }, [runCountdown, bestLevel, isChallenge, totalTime]);

  // Duel auto-start — both clients begin at the exact same wall-clock
  // instant via the shared matchStartAt timestamp (ARENA_INTEGRATION.md rule 2).
  const matchStartAt = useDuelMatchStart(challengeId);
  const duelAutoStartedRef = useRef(false);
  useEffect(() => {
    if (!isChallenge || !matchStartAt || phase !== 'start' || duelAutoStartedRef.current) return;
    const delay = Math.max(0, matchStartAt - Date.now());
    const t = setTimeout(() => {
      duelAutoStartedRef.current = true;
      startGame();
    }, delay);
    return () => clearTimeout(t);
  }, [isChallenge, matchStartAt, phase, startGame]);

  // Rematch reuses this same route with only ?challengeId= changing — reset
  // all per-match state so the previous match doesn't leak into the new one.
  const prevChallengeIdRef = useRef(challengeId);
  useEffect(() => {
    if (challengeId === prevChallengeIdRef.current) return;
    prevChallengeIdRef.current = challengeId;
    duelAutoStartedRef.current = false;
    setPhase('start');
    setScore(0);
    setLives(MAX_LIVES);
    setEndSummary(null);
    setTimeLeft(totalTime);
  }, [challengeId, totalTime]);

  const shareScore = useCallback(async () => {
    if (!endSummary) return;
    const url = 'https://skilldrills.online/drills/cognitive/processing-speed/finger-sequencing';
    try {
      const grade = getGrade(endSummary.accuracy);
      const canvas = generateShareCard({
        score: endSummary.score,
        bestScore,
        accuracy: endSummary.accuracy,
        bestCombo: endSummary.bestCombo,
        rating: { letter: grade.grade, label: grade.label, emoji: grade.emoji },
        newBest: endSummary.isNewBest,
        drillName: 'Sequence Aim Trainer',
        playerName: getPlayerName(),
      });
      await shareScoreCard(url, canvas);
    } catch (e) {
      const text = `🎯 I scored ${score} PTS (Level ${level}) in the Sequence Aim Trainer! Accuracy: ${endSummary.accuracy}%, Max Combo: ${endSummary.bestCombo}x, Streak: ${endSummary.bestReadStreak}. Practice on mobile at skilldrills.online!`;
      if (typeof navigator !== 'undefined' && navigator.share) {
        navigator.share({ title: 'My Mobile Aim Sequence Score', text, url }).catch(() => {});
      } else if (typeof navigator !== 'undefined' && navigator.clipboard) {
        navigator.clipboard.writeText(text);
        alert('Score card copied to clipboard!');
      }
    }
  }, [score, level, endSummary, bestScore]);

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
      // ~60fps cap — an uncapped loop makes 90-120Hz phones redraw more
      // than needed for the same visual result. The timeout check below
      // reads performance.now() directly, so it stays accurate regardless.
      if (ts - lastDrawTs < 15) {
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

      // 3. Draw lines between remaining sequence nodes
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

            const showNumber = cueTierRef.current !== 3 || elapsedSinceSpawn < 800;
            if (showNumber) {
              ctx.fillStyle = '#ffffff';
              ctx.font = `bold ${Math.round(node.r * 0.85)}px sans-serif`;
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              ctx.fillText((idx - activeIdx + 1).toString(), node.x, node.y);
            }
          } else {
            ctx.fillStyle = 'rgba(255, 255, 255, 0.02)';
            ctx.fill();
            ctx.strokeStyle = `rgba(168, 85, 247, ${node.opacity})`;
            ctx.lineWidth = 1;
            ctx.stroke();

            const showNumber = cueTierRef.current === 1 || cueTierRef.current === 2;
            if (showNumber) {
              ctx.fillStyle = `rgba(255, 255, 255, ${node.opacity * 0.7})`;
              ctx.font = `bold ${Math.round(node.r * 0.8)}px sans-serif`;
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              ctx.fillText((idx - activeIdx + 1).toString(), node.x, node.y);
            }
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

      // 6. Draw red overlay flash on damage
      if (flashRedRef.current > 0) {
        ctx.fillStyle = `rgba(239, 68, 68, ${flashRedRef.current})`;
        ctx.fillRect(0, 0, w, h);
        flashRedRef.current = Math.max(0, flashRedRef.current - 0.035);
      }

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
      backHref="/drills/cognitive"
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

        {/* Rotate Gating Screen */}
        {phase === 'rotate-hint' && !isChallenge && (
          <div className="absolute inset-0 z-[100] flex flex-col items-center justify-center bg-black/95 text-center p-6 select-none">
            <div className="animate-bounce mb-5 text-violet-400"><RotateCw className="w-12 h-12 mx-auto" /></div>
            <p className="text-sm font-bold text-white">Rotate your phone to play</p>
            <p className="text-xs text-slate-500 mt-1.5 max-w-[220px] mx-auto font-sans">Your browser can't rotate this for you — turn your device to landscape.</p>
          </div>
        )}

        {/* START SCREEN */}
        {phase === 'start' && !isChallenge && (
          <div className="relative h-full flex items-center justify-center p-5 overflow-y-auto z-30 select-none">
            <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(ellipse 420px 260px at 50% 8%, rgba(142,97,246,.16), transparent 70%)' }} />
            <div className="relative w-full max-w-[280px] rounded-[20px] border border-white/5 bg-[#0c0c16]/90 backdrop-blur-lg px-5 pt-5 pb-[18px] text-center shadow-[0_16px_40px_rgba(0,0,0,.5)] my-6">
              <div className="w-11 h-11 mx-auto rounded-[14px] bg-gradient-to-br from-violet-600 to-indigo-600 flex items-center justify-center mb-3 shadow-[0_0_22px_rgba(139,92,246,.35)]">
                <GitBranch className="w-[22px] h-[22px] text-white" />
              </div>
              <h1 className="text-[17px] font-bold tracking-tight">Sequence Aim Trainer</h1>
              <p className="text-[9px] text-slate-500 uppercase tracking-widest mt-0.5 mb-3.5">Mobile Sequential Clicker</p>

              <div className="flex flex-col gap-1.5 text-left mb-3.5">
                <HowToRow icon={<Target className="w-3.5 h-3.5 text-cyan-400 flex-shrink-0" />} node={<>Tap targets in <b className="text-white">numerical order</b> (1, 2, 3...)</>} />
                <HowToRow icon={<Eye className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0" />} node={<>As you level up, <b className="text-white">numbers hide</b> & decoy trap nodes spawn</>} />
                <HowToRow icon={<Timer className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />} node={<>5 lives — mistakes cost a life. Chain completions <b className="text-white">buy time</b></>} />
              </div>

              <div className="grid grid-cols-3 gap-1.5 mb-3.5">
                <MiniStat label="Best" value={bestScore} color="text-yellow-400" />
                <MiniStat label="Combo" value={`${bestCombo}x`} color="text-orange-400" />
                <MiniStat label="Streak" value={`${bestReadStreak}`} color="text-indigo-400" />
              </div>

              <button
                onClick={startGame}
                className="w-full py-[11px] rounded-[13px] bg-gradient-to-r from-violet-600 to-indigo-600 font-bold text-[12.5px] tracking-wide active:scale-[0.97] transition-transform shadow-[0_0_20px_rgba(139,92,246,.3)] cursor-pointer text-white"
              >
                START
              </button>
            </div>
          </div>
        )}

        {/* PLAYING HUD OVERLAYS */}
        {phase === 'playing' && (
          <>
            {/* Live Stats Overlay (Top-Left) */}
            <div className="absolute top-5 left-5 z-40 flex flex-col pointer-events-none font-mono select-none">
              <span className="text-2xl font-black text-white leading-none tabular-nums">{score}</span>
              {/* No level badge in duels — see the note in ConcentrationGrid. */}
              {!isChallenge && (
                <span className="flex items-center gap-0.5 mt-1.5">
                  {Array.from({ length: MAX_LIVES }).map((_, i) => (
                    <Heart key={i} className={`w-3 h-3 ${i < lives ? 'fill-red-500 text-red-500' : 'text-white/15'}`} />
                  ))}
                </span>
              )}
            </div>

            <div className="absolute top-5 right-5 z-40 flex flex-col items-end pointer-events-none select-none">
              <span className={`text-3xl font-black font-mono leading-none tabular-nums ${timeLeft <= 10 ? 'text-red-500 animate-pulse' : 'text-slate-300'}`}>
                {Math.ceil(timeLeft)}s
              </span>
              <span className="text-[8px] text-slate-500 font-bold uppercase tracking-widest mt-1">Time Left</span>
            </div>

            {/* Sound toggle */}
            <button
              onClick={() => setSoundEnabled(s => { audioSynth?.setEnabled(!s); return !s; })}
              className="absolute bottom-5 right-5 z-45 p-2 rounded-full bg-black/60 border border-white/10 text-slate-400 active:scale-90 transition-transform pointer-events-auto cursor-pointer"
            >
              {soundEnabled ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
            </button>

          </>
        )}

        {/* COUNTDOWN SCREEN */}
        {phase === 'countdown' && !isChallenge && (
          <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/55 backdrop-blur-[2px] select-none">
            <span className="text-[11px] font-black uppercase tracking-[0.2em] text-slate-400">Get Ready</span>
            <div className="relative w-28 h-28 rounded-full border-[3px] border-violet-500/20 flex items-center justify-center">
              <div className="absolute -inset-[3px] rounded-full border-[3px] border-transparent border-t-violet-400 border-r-violet-400 animate-spin" style={{ animationDuration: '0.7s' }} />
              <span key={countdownValue} className="fx-pop-in text-5xl font-black bg-gradient-to-b from-white to-violet-300 bg-clip-text text-transparent">
                {countdownValue > 0 ? countdownValue : 'GO'}
              </span>
            </div>
            <span className="text-[10px] text-slate-500 font-sans">First chain spawns at GO</span>
          </div>
        )}

        {/* RESULT SCREEN */}
        {phase === 'ended' && endSummary && !isChallenge && (
          <ResultScreen 
            summary={endSummary} 
            onPlayAgain={startGame} 
            onShare={shareScore} 
          />
        )}
      </div>
    </DrillWrapper>
  );
}

// === Subcomponents ===
function HowToRow({ icon, node }) {
  return (
    <div className="flex items-center gap-2 bg-white/[0.02] border border-white/5 rounded-[10px] px-2.5 py-[7px]">
      {icon}
      <span className="text-[10.5px] text-slate-300 leading-tight font-sans">{node}</span>
    </div>
  );
}

function MiniStat({ label, value, color }) {
  return (
    <div className="rounded-[9px] border border-white/5 bg-white/[0.02] py-1.5 px-1 text-center font-mono">
      <div className={`text-[12px] font-bold ${color}`}>{value}</div>
      <div className="text-[7.5px] uppercase tracking-wide text-slate-500 font-bold mt-0.5">{label}</div>
    </div>
  );
}

function ResultScreen({ summary, onPlayAgain, onShare }) {
  const grade = getGrade(summary.accuracy);
  const gradeColor = grade.grade === 'S+' || grade.grade === 'S' ? '#fbbf24' : '#a78bfa';

  return (
    <div className="absolute inset-0 z-40 flex select-none font-mono" style={{ background: 'rgba(5,5,8,0.97)' }}>
      {/* Grade Side */}
      <div className="w-[36%] flex flex-col items-center justify-center gap-1.5 border-r border-white/5" style={{ background: 'radial-gradient(ellipse 260px 200px at 50% 30%, rgba(250,204,21,.08), transparent 70%)' }}>
        {summary.isNewBest && (
          <span className="text-[9.5px] font-bold text-yellow-400 bg-yellow-500/10 border border-yellow-500/25 px-2.5 py-0.5 rounded-full mb-1">NEW BEST</span>
        )}
        <div className="text-5xl sm:text-6xl font-black leading-none" style={{ color: gradeColor }}>{grade.grade}</div>
        <div className="text-[10px] uppercase tracking-widest text-slate-500">{grade.label}</div>
        <div className="text-3xl sm:text-4xl font-black text-white mt-1 tabular-nums">{summary.score.toLocaleString()}</div>
        <div className="text-[9px] uppercase tracking-widest text-slate-500">Points</div>
      </div>

      {/* Details Side */}
      <div className="flex-1 flex flex-col justify-center gap-3 px-6 sm:px-8 py-4 min-w-0">
        <div className="grid grid-cols-3 gap-2">
          <ResultStat label="Accuracy" value={`${summary.accuracy}%`} color="text-blue-400" />
          <ResultStat label="Combo" value={`${summary.bestCombo}x`} color="text-orange-400" />
          <ResultStat label="XP" value={`+${summary.xpEarned}`} color="text-violet-400" />
        </div>
        <div className="flex gap-2">
          <button 
            onClick={onPlayAgain} 
            className="flex-1 py-3 rounded-[13px] bg-gradient-to-r from-violet-600 to-indigo-600 text-white font-bold text-xs uppercase tracking-wide cursor-pointer hover:shadow-lg active:scale-95 transition-transform"
          >
            Play Again
          </button>
          <button 
            onClick={onShare} 
            className="w-11 flex-shrink-0 rounded-[13px] bg-white/[0.04] border border-white/10 flex items-center justify-center text-slate-400 hover:text-white cursor-pointer active:scale-95 transition-transform"
          >
            <Share2 className="w-4 h-4" />
          </button>
          <Link href="/drills/cognitive" className="w-11 flex-shrink-0 rounded-[13px] bg-white/[0.04] border border-white/10 flex items-center justify-center text-slate-400 hover:text-white active:scale-95 transition-transform">
            <ArrowLeft className="w-4 h-4 text-slate-400" />
          </Link>
        </div>
      </div>
    </div>
  );
}

function ResultStat({ label, value, color }) {
  return (
    <div className="rounded-[11px] border border-white/5 bg-white/[0.03] py-2 px-1 text-center font-mono">
      <div className={`text-sm font-black ${color} tabular-nums`}>{value}</div>
      <div className="text-[7.5px] uppercase tracking-wide text-slate-500 font-bold mt-0.5">{label}</div>
    </div>
  );
}