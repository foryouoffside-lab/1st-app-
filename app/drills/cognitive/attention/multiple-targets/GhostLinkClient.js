'use client';

import React, { useEffect, useState, useRef, useCallback } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { 
  Eye, Zap, Timer, Trophy, Volume2, VolumeX, 
  Target, Activity, Info, RotateCcw, Share2, 
  ArrowLeft, Layers, Sparkles, Compass
} from 'lucide-react';

import { calcEndBonuses, calcSessionXP, getGrade } from '../../../../../lib/scoringEngine';
import { saveLeaderboardEntrySync } from '../../../../../lib/leaderboard';
import { lockLandscape, unlockOrientation } from '../../../../../lib/orientation';
import { previewDailyCompletion } from '../../../../../lib/dailyChallenge';
import { getPlayerName } from '../../../../../lib/progressStore';
import { Capacitor } from '@capacitor/core';
import { StatusBar } from '@capacitor/status-bar';
import generateShareCard, { shareScoreCard } from '../../../../../components/ShareScoreCard';
import DrillWrapper from '../../../../../components/DrillWrapper';
import { canvasDpr } from '../../../../../lib/canvasFx';

// ==========================================
// ERROR BOUNDARY
// ==========================================
class GameErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) { return { hasError: true, error }; }
  componentDidCatch(error, errorInfo) { console.error('Ghost-Link Error:', error, errorInfo); }
  render() {
    if (this.state.hasError) {
      return (
        <div className="absolute inset-0 flex items-center justify-center bg-black/95 rounded-xl z-50 border border-purple-500/30">
          <div className="text-center p-6 max-w-sm">
            <Info className="w-12 h-12 text-purple-500 mx-auto mb-4 animate-pulse" />
            <h3 className="text-white text-lg font-bold mb-2">Memory Engine Desync</h3>
            <p className="text-gray-400 text-sm mb-4">The visual engine encountered a frame error. Let's reboot the runtime.</p>
            <button 
              onClick={() => { this.setState({ hasError: false }); window.location.reload(); }} 
              className="w-full py-2.5 bg-purple-600 hover:bg-purple-500 text-white font-bold rounded-xl transition-colors shadow-[0_0_15px_rgba(168,85,247,0.4)]"
            >
              Restart Sequence
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// ==========================================
// ZERO-LATENCY AUDIO SYNTHESIZER
// ==========================================
class AudioSynthesizer {
  constructor() { this.ctx = null; this.enabled = true; }
  
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

  // 1. Hit / Select sound
  playHit() { this.tone(880, 0.12, 'sine', 0.16, 1760); }
  playSelect() { this.playHit(); }
  playDeselect() { this.tone(440, 0.12, 'sine', 0.08); }

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
  playFail() { this.playPenalty(); }

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

  playMemorize() { this.tone(660, 0.3, 'triangle', 0.08); }
  playBonus() { this.playResultsReveal(); }

  setEnabled(status) { this.enabled = status; }
}

const audioSynth = typeof window !== 'undefined' ? new AudioSynthesizer() : null;

// ==========================================
// STORAGE CONFIG
// ==========================================
const STORAGE_KEY = 'skilldrills_multiple_targets_v1';
const DRILL_DURATION = 45;

const getRankInfo = (score, accuracy) => {
  if (score >= 60 && accuracy >= 90) return { name: 'Grandmaster', color: 'text-fuchsia-400 font-extrabold' };
  if (score >= 60 && accuracy >= 82) return { name: 'Master', color: 'text-red-400 font-extrabold' };
  if (score >= 40 && accuracy >= 75) return { name: 'Diamond', color: 'text-cyan-400 font-extrabold' };
  if (score >= 40 && accuracy >= 65) return { name: 'Platinum', color: 'text-indigo-400 font-extrabold' };
  if (score >= 20 && accuracy >= 55) return { name: 'Gold', color: 'text-yellow-400 font-extrabold' };
  if (score >= 20) return { name: 'Silver', color: 'text-gray-300 font-extrabold' };
  return { name: 'Bronze', color: 'text-slate-500 font-medium' };
};

const getSavedData = () => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);

    const legacyBest = localStorage.getItem('ghostLinkBestScore');
    const bestScore = legacyBest ? parseInt(legacyBest, 10) : 0;
    const bestAccuracy = bestScore > 0 ? 100 : 0;
    
    const initial = {
      bestScore,
      bestAccuracy,
      bestRank: getRankInfo(bestScore, bestAccuracy).name,
      totalSessions: legacyBest ? 1 : 0
    };
    saveData(initial);
    return initial;
  } catch (e) {
    return { bestScore: 0, bestAccuracy: 0, bestRank: 'Bronze', totalSessions: 0 };
  }
};

const saveData = (data) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch (e) {}
};

// ==========================================
// MAIN COMPONENT
// ==========================================
export default function GhostLinkClient() {
  const searchParams = useSearchParams();
  const challengeId = searchParams ? searchParams.get('challengeId') : null;

  // === Phase machine state ===
  const [phase, setPhase] = useState('start'); // 'start' | 'rotate-hint' | 'countdown' | 'playing' | 'ended'
  const [subPhase, setSubPhase] = useState('MEMORIZE'); // 'MEMORIZE' | 'TRACKING' | 'IDENTIFY'
  const [countdownValue, setCountdownValue] = useState(3);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [isClient, setIsClient] = useState(false);

  // === Configurations ===
  const [ballSpeed, setBallSpeed] = useState(5);
  const [totalBalls, setTotalBalls] = useState(8);

  // === Dynamic HUD / Live State ===
  const [score, setScore] = useState(0);
  const [timeRemaining, setTimeRemaining] = useState(DRILL_DURATION);
  const [accuracy, setAccuracy] = useState(100);
  const [dangerLevel, setDangerLevel] = useState(0);

  // === Best stats ===
  const [bestScore, setBestScore] = useState(0);
  const [bestAccuracy, setBestAccuracy] = useState(0);
  const [bestRank, setBestRank] = useState('Bronze');

  // === Result Summary state ===
  const [endSummary, setEndSummary] = useState(null);

  // === React states to mirror refs ===
  const [selectedBalls, setSelectedBalls] = useState([]);
  const selectedBallsRef = useRef([]);
  const handleSetSelectedBalls = useCallback((val) => {
    const newVal = typeof val === 'function' ? val(selectedBallsRef.current) : val;
    selectedBallsRef.current = newVal;
    setSelectedBalls(newVal);
  }, []);

  const [showResults, setShowResults] = useState(false);
  const showResultsRef = useRef(false);
  const handleSetShowResults = useCallback((val) => {
    showResultsRef.current = val;
    setShowResults(val);
  }, []);

  const [correctCount, setCorrectCount] = useState(0);
  const correctCountRef = useRef(0);
  const handleSetCorrectCount = useCallback((val) => {
    correctCountRef.current = val;
    setCorrectCount(val);
  }, []);

  // === Mutable engine references ===
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const animationRef = useRef(null);
  const countdownTimerRef = useRef(null);
  const gameActiveRef = useRef(false);
  const mountedRef = useRef(false);
  const lastTimeRef = useRef(0);
  const canvasSizeRef = useRef({ width: 0, height: 0 });

  const ballsRef = useRef([]);
  const targetIndicesRef = useRef([]);
  const phaseRef = useRef("MEMORIZE");
  const memorizeTimerRef = useRef(2.0);
  const trackingTimerRef = useRef(DRILL_DURATION);
  const heartbeatCooldownRef = useRef(0);

  // Constants
  const TARGET_COUNT = 3;
  const HIT_POINTS = 20;
  const MISS_PENALTY = 0;

  // === Load initial data ===
  useEffect(() => {
    setIsClient(true);
    mountedRef.current = true;
    const data = getSavedData();
    setBestScore(data.bestScore);
    setBestAccuracy(data.bestAccuracy);
    setBestRank(data.bestRank);
    const timer = setTimeout(() => setLoading(false), 150);
    return () => {
      clearTimeout(timer);
      mountedRef.current = false;
      gameActiveRef.current = false;
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
      if (countdownTimerRef.current) clearTimeout(countdownTimerRef.current);
      try { if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); } catch (e) {}
      if (Capacitor.isNativePlatform()) {
        StatusBar.setOverlaysWebView({ overlay: false }).catch(() => {});
        StatusBar.show().catch(() => {});
      }
      unlockOrientation();
    };
  }, []);

  // Hide floating controls during play
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

  useEffect(() => { if (audioSynth) audioSynth.setEnabled(soundEnabled); }, [soundEnabled]);

  // Adaptive difficulty preview variables
  const adaptiveBonus = Math.floor(bestScore / 30);
  const dynamicBallsCount = Math.min(13, totalBalls + adaptiveBonus);
  const dynamicSpeed = Math.min(13, ballSpeed + adaptiveBonus);

  // === Initialize Round variables ===
  const initDrillVariables = useCallback((w, h) => {
    ballsRef.current = [];
    targetIndicesRef.current = [];
    handleSetSelectedBalls([]);
    handleSetShowResults(false);
    handleSetCorrectCount(0);
    setScore(0);
    setAccuracy(100);

    // Bumped from the old 12/22px — those were noticeably harder to tap
    // than ConflictReflexClient.js's balls. Kept below Conflict Reflex's own
    // 22-50px ceiling since up to 13 balls share the screen here at once
    // (vs. Conflict Reflex's 2), and collision physics below already keeps
    // them from permanently overlapping at this size.
    const radius = w < 768 ? 18 : 28;

    const indices = [];
    while (indices.length < TARGET_COUNT) {
      const idx = Math.floor(Math.random() * dynamicBallsCount);
      if (!indices.includes(idx)) indices.push(idx);
    }
    targetIndicesRef.current = indices;

    for (let i = 0; i < dynamicBallsCount; i++) {
      const angle = Math.random() * Math.PI * 2;
      ballsRef.current.push({
        x: radius + Math.random() * (w - radius * 2),
        y: radius + Math.random() * (h - radius * 2),
        r: radius,
        dx: Math.cos(angle),
        dy: Math.sin(angle),
        isTarget: targetIndicesRef.current.includes(i)
      });
    }

    phaseRef.current = "MEMORIZE";
    setSubPhase("MEMORIZE");
    memorizeTimerRef.current = 2.0;
    trackingTimerRef.current = DRILL_DURATION;
    setTimeRemaining(DRILL_DURATION);
    setDangerLevel(0);
    heartbeatCooldownRef.current = 0;
    audioSynth?.playMemorize();
  }, [dynamicBallsCount, handleSetSelectedBalls, handleSetShowResults, handleSetCorrectCount]);

  // === Calculate score and submit telemetry ===
  const calculateResults = useCallback(() => {
    let cCount = 0;
    let errors = 0;

    selectedBallsRef.current.forEach(idx => {
      if (targetIndicesRef.current.includes(idx)) cCount++;
      else errors++;
    });

    const netScore = Math.max(0, (cCount * HIT_POINTS) - (errors * MISS_PENALTY));

    handleSetCorrectCount(cCount);
    setScore(netScore);
    const calculatedAccuracy = Math.round((cCount / TARGET_COUNT) * 100);
    setAccuracy(calculatedAccuracy);
    handleSetShowResults(true);

    if (netScore > 0) audioSynth?.playBonus();
    else audioSynth?.playFail();

    setTimeout(async () => {
      if (!mountedRef.current) return;

      const bonuses = calcEndBonuses({
        rawScore: netScore,
        accuracy: calculatedAccuracy,
        bestCombo: cCount,
        totalActions: TARGET_COUNT,
        mistakes: errors,
        livesRemaining: null,
        maxLives: null,
        category: 'cognitive'
      });

      // calcEndBonuses' perfect-run bonus requires totalActions >= 5 (see
      // lib/scoringEngine.js), which this drill's fixed 3-target format can
      // never reach — award the same flat bonus manually so a flawless
      // identification isn't structurally unrewardable.
      const manualPerfectBonus = (errors === 0 && cCount === TARGET_COUNT && bonuses.perfectBonus === 0) ? 500 : 0;
      const finalScore = bonuses.finalScore + manualPerfectBonus;
      const prev = getSavedData();
      const isNewBest = finalScore > prev.bestScore;
      const firstPlay = prev.totalSessions === 0;

      const daily = await previewDailyCompletion('multiple-targets');

      const xpResult = calcSessionXP({
        finalScore,
        accuracy: calculatedAccuracy,
        isNewBest,
        firstPlay,
        dailyChallenge: daily.isDailyDrill,
        dailyChallengeSetComplete: daily.wouldCompleteSet
      });

      const updated = {
        bestScore: Math.max(prev.bestScore, finalScore),
        bestAccuracy: isNewBest ? calculatedAccuracy : prev.bestAccuracy,
        bestRank: getRankInfo(Math.max(prev.bestScore, finalScore), isNewBest ? calculatedAccuracy : prev.bestAccuracy).name,
        totalSessions: prev.totalSessions + 1
      };
      saveData(updated);

      setBestScore(updated.bestScore);
      setBestAccuracy(updated.bestAccuracy);
      setBestRank(updated.bestRank);

      saveLeaderboardEntrySync({
        drillId: 'multiple-targets',
        drillName: 'Multiple Targets',
        category: 'cognitive',
        score: finalScore,
        accuracy: calculatedAccuracy,
        bestCombo: cCount
      });

      setEndSummary({
        score: finalScore,
        accuracy: calculatedAccuracy,
        correctCount: cCount,
        xpEarned: xpResult.xp,
        isNewBest,
      });

      setPhase('ended');
      gameActiveRef.current = false;
    }, 2500);
  }, [handleSetCorrectCount, handleSetShowResults]);

  // === Click / Pointer Selection logic ===
  const handleInputStrikes = useCallback((e) => {
    if (e.target.tagName === 'BUTTON' || e.target.closest('button')) return;
    if (!gameActiveRef.current || phaseRef.current !== 'IDENTIFY' || showResultsRef.current) return;

    e.stopPropagation();

    const cvs = canvasRef.current;
    if (!cvs) return;

    const rect = cvs.getBoundingClientRect();
    const clickX = (e.clientX - rect.left) * (canvasSizeRef.current.width / rect.width);
    const clickY = (e.clientY - rect.top) * (canvasSizeRef.current.height / rect.height);

    const currentSelected = selectedBallsRef.current;

    // Check Confirm Button First
    if (currentSelected.length === TARGET_COUNT) {
      const bx = canvasSizeRef.current.width / 2 - 80;
      const by = canvasSizeRef.current.height - 85;
      if (clickX >= bx && clickX <= bx + 160 && clickY >= by && clickY <= by + 50) {
        calculateResults();
        return;
      }
    }

    // Check Balls Selection
    ballsRef.current.forEach((b, i) => {
      if (Math.hypot(clickX - b.x, clickY - b.y) <= b.r + 20) {
        if (currentSelected.includes(i)) {
          handleSetSelectedBalls(prev => prev.filter(item => item !== i));
          audioSynth?.playDeselect();
        } else if (currentSelected.length < TARGET_COUNT) {
          handleSetSelectedBalls(prev => [...prev, i]);
          audioSynth?.playSelect();
        }
      }
    });
  }, [calculateResults, handleSetSelectedBalls]);

  // === Frame and Animation physics loop ===
  useEffect(() => {
    if (phase !== 'playing') return;
    const cvs = canvasRef.current;
    if (!cvs) return;
    const ctx = cvs.getContext('2d');
    let lastTime = performance.now();

    // Layered-circle style matching ConflictReflexClient.js's
    // drawLayeredCircle — flat fills only, no gradient/shadowBlur (that
    // combination is a known Android WebView rendering bug, see
    // DividedAttentionClient.js's notes on the same fix).
    // No save()/restore() here — only globalAlpha/strokeStyle/fillStyle/
    // lineWidth change, all explicitly overwritten on every call, so the
    // push/pop of the full canvas state per ball (up to 13x/frame) was
    // pure overhead.
    const drawBall = (b, colorHex) => {
      const r = b.r;
      ctx.globalAlpha = 0.2;
      ctx.strokeStyle = colorHex;
      ctx.lineWidth = 1.0;
      ctx.beginPath();
      ctx.arc(b.x, b.y, r + 5, 0, Math.PI * 2);
      ctx.stroke();

      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = colorHex;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
      ctx.stroke();

      ctx.globalAlpha = 0.88;
      ctx.fillStyle = colorHex;
      ctx.beginPath();
      ctx.arc(b.x, b.y, r * 0.82, 0, Math.PI * 2);
      ctx.fill();

      ctx.globalAlpha = 0.3;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(b.x - r * 0.2, b.y - r * 0.2, r * 0.28, 0, Math.PI * 2);
      ctx.fill();

      ctx.globalAlpha = 1.0;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(b.x, b.y, r * 0.18, 0, Math.PI * 2);
      ctx.fill();
    };

    const setupDimensions = () => {
      const container = containerRef.current;
      if (!container) return;
      const w = container.clientWidth;
      const h = container.clientHeight;
      const dpr = canvasDpr();
      cvs.width = w * dpr;
      cvs.height = h * dpr;
      canvasSizeRef.current = { width: w, height: h };

      if (ballsRef.current.length > 0) {
        ballsRef.current.forEach(b => {
          if (b.x > w - b.r) b.x = w - b.r;
          if (b.x < b.r) b.x = b.r;
          if (b.y > h - b.r) b.y = h - b.r;
          if (b.y < b.r) b.y = b.r;
        });
      } else {
        initDrillVariables(w, h);
      }
    };

    window.addEventListener('resize', setupDimensions);
    setupDimensions();

    const frameLoop = (time) => {
      if (!gameActiveRef.current) return;
      // ~60fps cap — an uncapped loop makes 90-120Hz phones redraw (and
      // run collision checks on up to 13 balls) 1.5-2x more than needed.
      if (time - lastTime < 15) {
        animationRef.current = requestAnimationFrame(frameLoop);
        return;
      }
      let dt = (time - lastTime) / 1000;
      if (dt > 0.05) dt = 0.05;
      lastTime = time;

      // Sub-Phase Timing
      if (phaseRef.current === "MEMORIZE") {
        memorizeTimerRef.current -= dt;
        if (memorizeTimerRef.current <= 0) {
          phaseRef.current = "TRACKING";
          setSubPhase("TRACKING");
          audioSynth?.playSelect();
        }
      } else if (phaseRef.current === "TRACKING") {
        trackingTimerRef.current -= dt;
        if (trackingTimerRef.current <= 0) {
          trackingTimerRef.current = 0;
          phaseRef.current = "IDENTIFY";
          setSubPhase("IDENTIFY");
          setDangerLevel(0);
          audioSynth?.playSelect();
        }
        if (Math.round(trackingTimerRef.current * 60) % 12 === 0) {
          setTimeRemaining(Math.ceil(trackingTimerRef.current));
        }

        const danger = trackingTimerRef.current <= 10 ? (10 - trackingTimerRef.current) / 10 : 0;
        setDangerLevel(danger);
        if (danger > 0.08) {
          heartbeatCooldownRef.current -= dt;
          if (heartbeatCooldownRef.current <= 0) {
            audioSynth?.playHeartbeat(danger);
            heartbeatCooldownRef.current = Math.max(0.35, 1.1 - danger * 0.65);
          }
        }
      }

      // Movement & Physics
      if (phaseRef.current === "TRACKING") {
        const balls = ballsRef.current;
        const w = canvasSizeRef.current.width;
        const h = canvasSizeRef.current.height;
        const speedMultiplier = dynamicSpeed * 60 * dt;

        for (let i = 0; i < balls.length; i++) {
          const b = balls[i];
          b.x += b.dx * speedMultiplier;
          b.y += b.dy * speedMultiplier;

          if (b.x <= b.r) { b.x = b.r; b.dx *= -1; }
          else if (b.x >= w - b.r) { b.x = w - b.r; b.dx *= -1; }

          if (b.y <= b.r) { b.y = b.r; b.dy *= -1; }
          else if (b.y >= h - b.r) { b.y = h - b.r; b.dy *= -1; }
        }

        for (let i = 0; i < balls.length; i++) {
          for (let j = i + 1; j < balls.length; j++) {
            const b1 = balls[i];
            const b2 = balls[j];

            let dx = b2.x - b1.x;
            let dy = b2.y - b1.y;
            let dist = Math.hypot(dx, dy);
            const minDist = b1.r + b2.r;

            if (dist < minDist) {
              if (dist === 0) { dx = 1; dist = 1; }
              const overlap = minDist - dist;
              const nx = dx / dist;
              const ny = dy / dist;

              b1.x -= nx * (overlap / 2);
              b1.y -= ny * (overlap / 2);
              b2.x += nx * (overlap / 2);
              b2.y += ny * (overlap / 2);

              const kx = b1.dx - b2.dx;
              const ky = b1.dy - b2.dy;
              const p = nx * kx + ny * ky;

              b1.dx -= p * nx;
              b1.dy -= p * ny;
              b2.dx += p * nx;
              b2.dy += p * ny;
            }
          }
        }
      }

      // Canvas Rendering
      const dpr = canvasDpr();
      const W = canvasSizeRef.current.width;
      const H = canvasSizeRef.current.height;
      ctx.save();
      ctx.scale(dpr, dpr);

      ctx.fillStyle = "#050508";
      ctx.fillRect(0, 0, W, H);

      ctx.strokeStyle = "rgba(168, 85, 247, 0.02)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let gx = 0; gx < W; gx += 50) { ctx.moveTo(gx, 0); ctx.lineTo(gx, H); }
      for (let gy = 0; gy < H; gy += 50) { ctx.moveTo(0, gy); ctx.lineTo(W, gy); }
      ctx.stroke();

      ballsRef.current.forEach((b, i) => {
        const isSelected = selectedBallsRef.current.includes(i);
        let colorHex;

        if (phaseRef.current === "IDENTIFY") {
          if (showResultsRef.current) {
            colorHex = b.isTarget ? '#10b981' : '#475569';
          } else {
            colorHex = isSelected ? '#f97316' : '#64748b';
          }
        } else if (phaseRef.current === "MEMORIZE") {
          colorHex = b.isTarget ? '#10b981' : '#475569';
        } else {
          colorHex = '#cbd5e1';
        }

        drawBall(b, colorHex);

        if (phaseRef.current === "IDENTIFY" && !showResultsRef.current && isSelected) {
          ctx.font = "bold 13px system-ui, sans-serif";
          ctx.fillStyle = "#ffffff";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText("✓", b.x, b.y + 0.5);
        }
      });

      if (phaseRef.current === "IDENTIFY") {
        ctx.font = "bold 15px system-ui, -apple-system, sans-serif";
        ctx.fillStyle = "#ffffff";
        ctx.textAlign = "center";
        ctx.textBaseline = "top";

        if (showResultsRef.current) {
          ctx.fillText(`Target Acquired: ${correctCountRef.current}/${TARGET_COUNT}`, W / 2, 25);
        } else {
          ctx.fillText(`Identify the Targets (${selectedBallsRef.current.length}/${TARGET_COUNT})`, W / 2, 25);

          if (selectedBallsRef.current.length === TARGET_COUNT) {
            const bx = W / 2 - 80;
            const by = H - 85;

            ctx.save();
            ctx.fillStyle = "#a855f7";
            ctx.shadowBlur = 20;
            ctx.shadowColor = "#a855f7";
            ctx.beginPath();
            ctx.roundRect(bx, by, 160, 50, 12);
            ctx.fill();
            ctx.restore();

            ctx.fillStyle = "#ffffff";
            ctx.font = "bold 13px system-ui, sans-serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText("CONFIRM", W / 2, by + 25);
          }
        }
      } else if (phaseRef.current === "MEMORIZE") {
        ctx.font = "bold 15px system-ui, sans-serif";
        ctx.fillStyle = "#ffffff";
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText("Memorize the Targets", W / 2, 25);
      }

      ctx.restore();
      animationRef.current = requestAnimationFrame(frameLoop);
    };

    lastTimeRef.current = performance.now();
    animationRef.current = requestAnimationFrame(frameLoop);

    return () => {
      cancelAnimationFrame(animationRef.current);
      window.removeEventListener('resize', setupDimensions);
    };
  }, [phase, dynamicSpeed, initDrillVariables]);

  const beginPlaying = useCallback(() => {
    if (!mountedRef.current) return;
    ballsRef.current = [];
    handleSetSelectedBalls([]);
    handleSetShowResults(false);
    setPhase('playing');
    gameActiveRef.current = true;
  }, [handleSetSelectedBalls, handleSetShowResults]);

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
    countdownTimerRef.current = setTimeout(() => runCountdown(n - 1), 700);
  }, [beginPlaying]);

  const handleStartGame = useCallback(async () => {
    audioSynth?.init();

    if (!document.fullscreenElement && containerRef.current) {
      try { await containerRef.current.requestFullscreen(); } catch (e) {}
    }
    if (Capacitor.isNativePlatform()) {
      StatusBar.setOverlaysWebView({ overlay: true }).catch(() => {});
      StatusBar.hide().catch(() => {});
    }

    try { await lockLandscape(); } catch (e) {}

    setTimeout(() => {
      if (!mountedRef.current) return;
      if (window.innerHeight > window.innerWidth) {
        setPhase('rotate-hint');
      } else {
        runCountdown(3);
      }
    }, 200);
  }, [runCountdown]);

  useEffect(() => {
    const handleResize = () => {
      if (phase === 'rotate-hint' && window.innerWidth > window.innerHeight) {
        runCountdown(3);
      }
    };
    window.addEventListener('resize', handleResize);
    window.addEventListener('orientationchange', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('orientationchange', handleResize);
    };
  }, [phase, runCountdown]);

  const shareResult = useCallback(async () => {
    if (!endSummary) return;
    const url = 'https://skilldrills.online/drills/cognitive/attention/multiple-targets';

    try {
      const grade = getGrade(endSummary.accuracy);
      const canvas = generateShareCard({
        score: endSummary.score,
        bestScore,
        accuracy: endSummary.accuracy,
        bestCombo: 0,
        rating: { letter: grade.grade, label: grade.label, emoji: grade.emoji },
        newBest: endSummary.isNewBest,
        drillName: 'Multiple Targets',
        playerName: getPlayerName(),
      });
      await shareScoreCard(url, canvas);
    } catch (e) {
      const text = `Scored ${endSummary.score} on Multiple Targets (${endSummary.accuracy}% accuracy) — SkillDrills`;
      if (typeof navigator !== 'undefined' && navigator.share) {
        navigator.share({ title: 'Multiple Targets — SkillDrills', text, url }).catch(() => {});
      } else if (typeof navigator !== 'undefined' && navigator.clipboard) {
        navigator.clipboard.writeText(`${text} ${url}`);
      }
    }
  }, [endSummary, bestScore]);

  if (loading || !isClient) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-[#050508]">
        <div className="text-center">
          <div className="w-14 h-14 border-4 border-purple-600 border-t-transparent rounded-full animate-spin mx-auto mb-4 shadow-[0_0_20px_rgba(139,92,246,0.5)]" />
          <p className="text-slate-500 font-bold tracking-widest uppercase text-[10px] animate-pulse">Loading Tracker Engine...</p>
        </div>
      </div>
    );
  }

  return (
    <DrillWrapper
      drillName="Multiple Targets"
      category="cognitive"
      score={score}
      timeLeft={phase === 'ended' ? 0 : Math.ceil(timeRemaining)}
      lives={null}
      maxLives={null}
      soundEnabled={soundEnabled}
      onSoundToggle={() => setSoundEnabled((v) => { audioSynth?.setEnabled(!v); return !v; })}
      backHref="/drills/cognitive"
      minimalChrome
    >
      <div
        ref={containerRef}
        onPointerDown={handleInputStrikes}
        onContextMenu={(e) => { if (phase === 'playing') e.preventDefault(); }}
        className="absolute inset-0 select-none overflow-hidden bg-[#050508] text-white"
        style={{ touchAction: phase === 'playing' ? 'none' : 'auto', WebkitTapHighlightColor: 'transparent' }}
      >
        <div className="absolute inset-0 pointer-events-none" style={{ backgroundImage: 'linear-gradient(rgba(255,255,255,0.01) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.01) 1px, transparent 1px)', backgroundSize: '40px 40px' }} />

        {(phase === 'countdown' || phase === 'playing') && (
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); setSoundEnabled((v) => { audioSynth?.setEnabled(!v); return !v; }); }}
            className="absolute bottom-5 right-5 z-40 p-2 rounded-full bg-black/60 border border-white/10 text-slate-400 active:scale-90 transition-transform cursor-pointer"
          >
            {soundEnabled ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
          </button>
        )}

        {/* ── ROTATE HINT ── */}
        {phase === 'rotate-hint' && (
          <div className="absolute inset-0 z-[100] flex flex-col items-center justify-center bg-black/95 text-center p-6">
            <div className="animate-bounce mb-5 text-purple-400"><RotateCcw className="w-12 h-12 mx-auto" /></div>
            <p className="text-sm font-bold text-white">Rotate your phone to play</p>
            <p className="text-xs text-slate-500 mt-1.5 max-w-[220px] mx-auto">Turn your device to landscape to begin tracking.</p>
          </div>
        )}

        {/* ── START SCREEN ── */}
        {phase === 'start' && (
          <div className="relative h-full flex items-center justify-center p-5 overflow-y-auto z-40 pointer-events-auto">
            <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(ellipse 420px 260px at 50% 8%, rgba(168,85,247,.16), transparent 70%)' }} />
            <div className="relative w-full max-w-[290px] rounded-[20px] border border-white/5 bg-[#0c0c16]/90 backdrop-blur-lg px-5 pt-5 pb-[18px] text-center shadow-[0_16px_40px_rgba(0,0,0,.5)] my-6">
              <div className="w-11 h-11 mx-auto rounded-[14px] bg-gradient-to-br from-purple-600 to-pink-600 flex items-center justify-center mb-3 shadow-[0_0_22px_rgba(168,85,247,.35)]">
                <Compass className="w-[22px] h-[22px] text-white" />
              </div>
              <h1 className="text-[17px] font-bold tracking-tight text-white">Multiple Targets</h1>

              <div className="flex flex-col gap-1.5 text-left mt-3.5">
                <HowToRow icon={<Eye className="w-3.5 h-3.5 text-purple-400 flex-shrink-0" />} node={<>Memorize the 3 green targets shown</>} />
                <HowToRow icon={<Activity className="w-3.5 h-3.5 text-pink-400 flex-shrink-0" />} node={<>Track them as they turn neutral and bounce</>} />
                <HowToRow icon={<Target className="w-3.5 h-3.5 text-cyan-400 flex-shrink-0" />} node={<>Identify all 3 original targets when they freeze</>} />
              </div>

              <div className="flex flex-col gap-3 text-left mt-3.5 border-t border-white/5 pt-3.5">
                <div className="flex flex-col gap-1">
                  <div className="flex justify-between items-center text-[9px] uppercase font-bold text-slate-500 tracking-wider">
                    <span className="flex items-center gap-1"><Zap className="w-3 h-3 text-pink-400" /> Velocity</span>
                    <span className="text-pink-400 font-mono font-bold">
                      Lvl {ballSpeed} {adaptiveBonus > 0 && `(+${adaptiveBonus})`} = {dynamicSpeed}
                    </span>
                  </div>
                  <input 
                    type="range" min="2" max="12" step="1" 
                    value={ballSpeed} 
                    onChange={(e) => setBallSpeed(parseInt(e.target.value))} 
                    className="w-full h-1 bg-white/10 rounded-lg appearance-none cursor-pointer accent-pink-500" 
                  />
                </div>

                <div className="flex flex-col gap-1">
                  <div className="flex justify-between items-center text-[9px] uppercase font-bold text-slate-500 tracking-wider">
                    <span className="flex items-center gap-1"><Layers className="w-3 h-3 text-cyan-400" /> Total Balls</span>
                    <span className="text-cyan-400 font-mono font-bold">
                      {totalBalls} {adaptiveBonus > 0 && `(+${adaptiveBonus})`} = {dynamicBallsCount}
                    </span>
                  </div>
                  <input 
                    type="range" min="4" max="10" step="1" 
                    value={totalBalls} 
                    onChange={(e) => setTotalBalls(parseInt(e.target.value))} 
                    className="w-full h-1 bg-white/10 rounded-lg appearance-none cursor-pointer accent-cyan-500" 
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-1.5 mt-3.5 border-t border-white/5 pt-3.5">
                <MiniStat label="Best Score" value={bestScore} color="text-yellow-400" />
                <MiniStat label="Best Accuracy" value={`${bestAccuracy}%`} color="text-orange-400" />
              </div>

              <button
                onClick={handleStartGame}
                className="w-full mt-3.5 py-[11px] rounded-[13px] bg-gradient-to-r from-purple-600 to-pink-600 font-bold text-[12.5px] tracking-wide active:scale-[0.97] transition-transform shadow-[0_0_20px_rgba(168,85,247,.3)] cursor-pointer text-white"
              >
                START
              </button>
            </div>
          </div>
        )}

        {/* ── COUNTDOWN VEIL ── */}
        {phase === 'countdown' && (
          <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/60 backdrop-blur-[2px]">
            <span className="text-[11px] font-black uppercase tracking-[0.16em] text-slate-400">Get Ready</span>
            <div className="relative w-28 h-28 rounded-full border-[3px] border-purple-500/20 flex items-center justify-center">
              <div className="absolute -inset-[3px] rounded-full border-[3px] border-transparent border-t-purple-400 border-r-purple-400 animate-spin" style={{ animationDuration: '0.7s' }} />
              <span key={countdownValue} className="fx-pop-in text-5xl font-black bg-gradient-to-b from-white to-purple-300 bg-clip-text text-transparent">
                {countdownValue}
              </span>
            </div>
            <span className="text-[10px] text-slate-500">Memorize the green targets at GO</span>
          </div>
        )}

        {/* ── PLAYING ── */}
        {phase === 'playing' && (
          <>
            {subPhase === 'TRACKING' && dangerLevel > 0.06 && (
              <div className="fx-vignette" style={{ '--v-min': Math.max(0.05, dangerLevel * 0.25), '--v-max': Math.min(0.55, dangerLevel * 0.75), animationDuration: '900ms' }} />
            )}

            {subPhase === 'TRACKING' && (
              <div className="absolute top-0 left-0 right-0 h-1.5 bg-neutral-950 z-[60] pointer-events-none">
                <div className={`h-full transition-all duration-100 ease-linear ${timeRemaining <= 10 ? 'bg-red-500 animate-pulse' : 'bg-purple-500'}`} style={{ width: `${Math.min(100, (timeRemaining / DRILL_DURATION) * 100)}%` }} />
              </div>
            )}

            <div className="absolute top-5 left-5 z-40 flex flex-col pointer-events-none text-white">
              {subPhase === 'IDENTIFY' && (
                <span className="text-2xl font-black leading-none tabular-nums">{score}</span>
              )}
              <div className="flex items-center gap-2 mt-1.5">
                <span className="text-[10px] font-black text-purple-300 bg-purple-500/15 border border-purple-500/25 px-1.5 py-0.5 rounded uppercase tracking-wider">{subPhase}</span>
              </div>
            </div>

            {/* Standardized Timer top-right overlay during TRACKING phase */}
            {subPhase === 'TRACKING' && (
              <div className="absolute top-5 right-5 z-40 flex flex-col items-end pointer-events-none select-none">
                <span className={`text-3xl font-black font-mono leading-none tabular-nums ${timeRemaining <= 10 ? 'text-red-500 animate-pulse' : 'text-slate-300'}`}>
                  {Math.ceil(timeRemaining)}s
                </span>
                <span className="text-[8px] text-slate-500 font-bold uppercase tracking-widest mt-1">Time Left</span>
              </div>
            )}

            <canvas 
              ref={canvasRef} 
              className="block absolute top-0 left-0 w-full h-full z-10" 
            />
          </>
        )}

        {/* ── RESULT SCREEN ── */}
        {phase === 'ended' && endSummary && (
          <ResultScreen summary={endSummary} onPlayAgain={handleStartGame} onShare={shareResult} />
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
        <div className="grid grid-cols-3 gap-2">
          <ResultStat label="Accuracy" value={`${summary.accuracy}%`} color="text-blue-400" />
          <ResultStat label="Correct" value={`${summary.correctCount}/3`} color="text-emerald-400" />
          <ResultStat label="XP" value={`+${summary.xpEarned}`} color="text-violet-400" />
        </div>
        <div className="flex gap-2">
          <button onClick={onPlayAgain} className="flex-1 py-3 rounded-[13px] bg-gradient-to-r from-purple-600 to-pink-600 text-white font-bold text-xs uppercase tracking-wide cursor-pointer">
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