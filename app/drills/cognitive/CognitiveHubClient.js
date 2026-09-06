'use client';

// app/drills/cognitive/CognitiveHubClient.js
// SkillDrills Pro — Cognitive Brain Training Sector

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Brain, Play, Search } from 'lucide-react';
import { getAllDrillProgress } from '../../../lib/progressStore';
import { DRILL_INDEX, byEngagement } from '../../../lib/drillIndex';
import { SUB_GROUPS, getGroupMeta, getDrillGroup, getGroupIcon, HUB_GROUP_KEY } from '../../../lib/drillGroups';
import { canvasDpr } from '../../../lib/canvasFx';

const NO_TRAINING_SUFFIX = new Set(['processing-speed', 'problem-solving']);

// Remembers which category the user was last browsing.
//
// The hub only ever learned its category from `?group=` in the URL, and the
// picker changes `activeGroup` WITHOUT rewriting the URL. Every route back
// into the hub from a drill is a bare `/drills/cognitive` (DrillWrapper's
// backHref, the hardware back button, and the result screen's exit link all
// use it), so returning from a drill always landed on "All Drills" — the user
// picked Attention, played an Attention drill, and came back somewhere else.
//
// sessionStorage rather than localStorage on purpose: "where I was" should
// survive going into a drill and back, not a full relaunch of the app, where
// the neutral All Drills view is the better starting point.
// (key itself now lives in lib/drillGroups.js as HUB_GROUP_KEY, so the
// hub and DrillWrapper cannot drift apart.)

export default function CognitiveHubClient() {
  const searchParams = useSearchParams();
  const [searchQuery, setSearchQuery] = useState('');
  const [drillProgress, setDrillProgress] = useState({});
  const [activeGroup, setActiveGroup] = useState(() => {
    const requested = searchParams.get('group');
    return SUB_GROUPS.some(g => g.id === requested) ? requested : 'all';
  });
  const [isLoaded, setIsLoaded] = useState(false);
  const canvasRef = useRef(null);
  const didRestoreGroupRef = useRef(false);

  // Restore the remembered category, but only when the URL doesn't name one —
  // an explicit ?group= (how the Home screen's category cards link in) is a
  // deliberate request and always wins.
  //
  // Done in an effect rather than in the useState initializer above because
  // this page is prerendered by the static export, where sessionStorage does
  // not exist; reading it during the initial render would also make the
  // client's first paint disagree with the prerendered HTML. The hub renders
  // its loading state until `isLoaded`, so this resolves before anything is
  // visible.
  useEffect(() => {
    if (didRestoreGroupRef.current) return;
    didRestoreGroupRef.current = true;

    const requested = searchParams.get('group');
    if (SUB_GROUPS.some(g => g.id === requested)) return;

    try {
      const saved = sessionStorage.getItem(HUB_GROUP_KEY);
      if (SUB_GROUPS.some(g => g.id === saved)) setActiveGroup(saved);
    } catch {}
  }, [searchParams]);

  // Remember every change, so the next return to the hub lands back here.
  useEffect(() => {
    if (!didRestoreGroupRef.current) return;
    try { sessionStorage.setItem(HUB_GROUP_KEY, activeGroup); } catch {}
  }, [activeGroup]);

  useEffect(() => {
    async function load() {
      try {
        const [progress] = await Promise.all([
          getAllDrillProgress()
        ]);
        setDrillProgress(progress || {});
      } catch (err) {
        console.error('Failed to load Cognitive page data', err);
      } finally {
        setIsLoaded(true);
      }
    }
    load();
  }, []);

  // Neural connection background animation
  useEffect(() => {
    if (!isLoaded) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let animationFrameId;
    let width = 0;
    let height = 0;

    const resize = () => {
      const dpr = canvasDpr();
      width = canvas.offsetWidth;
      height = canvas.offsetHeight;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);

    const particles = [];
    const count = 25;
    for (let i = 0; i < count; i++) {
      particles.push({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.25,
        vy: (Math.random() - 0.5) * 0.25,
        radius: Math.random() * 2 + 1
      });
    }

    let lastFrameTime = 0;
    const draw = (time) => {
      animationFrameId = requestAnimationFrame(draw);

      // This is a decorative background on a MENU. It has no gameplay value and
      // no deadline, but it was clearing and repainting a full-screen canvas —
      // 25 filled arcs plus up to 300 stroked links — 30 times a second for as
      // long as the hub was open. That is sustained GPU compositing to animate
      // something nobody is looking at while they read a drill list.
      //
      // 20fps: the particles drift at 0.25px/frame, so this is invisible.
      if (time - lastFrameTime < 50) return;

      // rAF is usually throttled when the tab is hidden, but "hidden" is not
      // guaranteed in a Capacitor WebView the way it is in a browser tab — an
      // app sitting behind the lock screen or in the recents switcher kept
      // painting. Cheap explicit check.
      if (typeof document !== 'undefined' && document.hidden) return;

      lastFrameTime = time;

      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = 'rgba(142, 97, 246, 0.22)';
      ctx.strokeStyle = 'rgba(142, 97, 246, 0.05)';

      particles.forEach((p, index) => {
        p.x += p.vx;
        p.y += p.vy;

        if (p.x < 0 || p.x > width) p.vx *= -1;
        if (p.y < 0 || p.y > height) p.vy *= -1;

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        ctx.fill();

        for (let j = index + 1; j < particles.length; j++) {
          const p2 = particles[j];
          const dist = Math.hypot(p.x - p2.x, p.y - p2.y);
          if (dist < 120) {
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(p2.x, p2.y);
            ctx.stroke();
          }
        }
      });
    };
    animationFrameId = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(animationFrameId);
      window.removeEventListener('resize', resize);
    };
  }, [isLoaded]);

  // Filter Cognitive drills — one row per drill, no folded pairs.
  const allCognitiveDrills = DRILL_INDEX.filter(d => d.categorySlug === 'cognitive');

  // Stats/recommendation scope to the active group (so a preset group reads
  // as its own dedicated category), while the visible list also respects search.
  const scopedDrills = activeGroup === 'all'
    ? allCognitiveDrills
    : allCognitiveDrills.filter(d => getDrillGroup(d) === activeGroup);

  const filteredDrills = allCognitiveDrills.filter(drill => {
    if (activeGroup !== 'all' && getDrillGroup(drill) !== activeGroup) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const matchesName = drill.name.toLowerCase().includes(q);
      const matchesKeywords = drill.keywords && drill.keywords.some(kw => kw.includes(q));
      return matchesName || matchesKeywords;
    }
    return true;
  }).sort(byEngagement);

  // Drives the search placeholder. The hero's played/completion counters that
  // used to live beside this are gone — see the hero block below.
  const totalDrills = scopedDrills.length;

  const activeGroupMeta = activeGroup !== 'all' ? getGroupMeta(activeGroup) : null;
  const HeroIcon = activeGroupMeta ? activeGroupMeta.icon : Brain;

  const getDifficultyClass = (difficulty) => {
    const diff = String(difficulty).toLowerCase();
    if (diff === 'beginner' || diff === 'easy') return 'beginner';
    if (diff === 'intermediate' || diff === 'medium') return 'intermediate';
    if (diff === 'advanced' || diff === 'hard') return 'advanced';
    if (diff === 'impossible') return 'impossible';
    return 'elite';
  };

  // Reads the same `difficulty` field lib/drillIndex.js already carries per
  // drill, so this badge can never drift out of sync with it the way the old
  // hand-listed drill-id arrays here did (they'd gone stale — e.g. still
  // referencing 'logic-puzzles', a ghost entry removed from DRILL_INDEX).
  const getDifficultyLabel = (drill) => {
    const diff = String(drill.difficulty || '').toLowerCase();
    if (diff === 'easy' || diff === 'beginner') return 'Beginner';
    if (diff === 'hard' || diff === 'advanced') return 'Advanced';
    if (diff === 'impossible') return 'Impossible';
    if (diff === 'elite') return 'Elite';
    return 'Intermediate';
  };

  if (!isLoaded) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#050508]">
        <div className="text-center space-y-3">
          <div className="w-10 h-10 border-2 border-violet-500 border-t-transparent rounded-full animate-spin mx-auto"></div>
          <p className="text-[10px] text-neutral-500 uppercase tracking-widest">Calibrating Synaptic Core...</p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="min-h-screen pb-28 text-slate-100 bg-[#050508] relative overflow-hidden"
      style={{ '--a': activeGroupMeta ? activeGroupMeta.accent : 'var(--c-cognitive)', paddingTop: 'calc(16px + env(safe-area-inset-top))' }}
    >
      {/* Decorative Particle Canvas */}
      <canvas style={{ touchAction: 'none' }} ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none z-0 opacity-30" />

      <div className="relative px-4 max-w-lg mx-auto space-y-6 z-10">
        
        {/* 1. Category Hero */}
        <div className="cat-hero">
          <div className="cat-hero-top">
            <div className="cat-hero-icon">
              <HeroIcon className="w-5 h-5" />
            </div>
            <div>
              <h1 className="font-display text-[32px] text-white leading-[0.9]">
                {activeGroupMeta
                  // 'Processing Speed' and 'Problem Solving' are long enough that
                  // appending 'Training' wraps the heading onto a second line, so
                  // those two stand on their own.
                  ? (NO_TRAINING_SUFFIX.has(activeGroupMeta.id) ? activeGroupMeta.name : `${activeGroupMeta.name} Training`)
                  : 'Cognitive Sector'}
              </h1>
            </div>
          </div>
          {/* Two lines, and that is the budget. The old copy ran to three
              lines of "overclock ... scientific cognitive modules", and the
              Total Drills / Played By You / Completion row under it added a
              fourth — between them they pushed the first drill card off the
              bottom of the screen on every single visit to the hub. The
              drill count still appears, in the search placeholder below,
              where it is actually doing a job. */}
          <p className="desc text-xs mt-3 leading-relaxed text-slate-400">
            {activeGroupMeta
              ? activeGroupMeta.description
              : 'Train working memory, reaction speed, and selective attention with short, focused drills.'}
          </p>
        </div>

        {/* 2. Category picker — each subgroup gets its own accent color and
             icon (from DRILL_GROUPS) plus a live drill count, so Attention/
             Focus/Memory/Problem Solving/Processing Speed read as real
             categories instead of same-color filter pills. */}
        <div className="group-picker">
          {SUB_GROUPS.map(group => {
            const isAll = group.id === 'all';
            const meta = isAll ? null : getGroupMeta(group.id);
            const Icon = isAll ? Brain : meta.icon;
            const accent = isAll ? 'var(--c-cognitive)' : meta.accent;
            const count = isAll
              ? allCognitiveDrills.length
              : allCognitiveDrills.filter(d => getDrillGroup(d) === group.id).length;

            return (
              <button
                key={group.id}
                onClick={() => setActiveGroup(group.id)}
                className={`group-card ${activeGroup === group.id ? 'active' : ''}`}
                style={{ '--a': accent }}
              >
                <span className="group-card-ic">
                  <Icon className="w-4 h-4" />
                </span>
                <span className="group-card-name">{group.name}</span>
                <span className="group-card-count">{count} drills</span>
              </button>
            );
          })}
        </div>

        {/* Search Bar */}
        <div className="relative">
          <Search className="absolute left-3.5 top-3 w-4 h-4 text-neutral-500" />
          <input
            type="text"
            placeholder={`Search ${totalDrills} drills...`}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 bg-white/[0.02] border border-white/5 rounded-2xl text-xs text-white placeholder-gray-600 focus:outline-none focus:border-white/10 transition-colors"
          />
        </div>

        {/* 3. Section Label */}
        <div className="section-label mt-2">
          {activeGroupMeta ? `All ${activeGroupMeta.name} drills` : 'All Cognitive drills'}
        </div>

        {/* 4. Drill listing — two-up preview cards.
             A row of text told a new player nothing: "Ghost Link" and "Batch
             Processing" are unguessable names next to a category icon shared
             by five other drills. Each card now leads with a frame of the
             drill actually running (captured by scripts/capture-previews.js),
             so the picture answers "what is this?" before the name has to. */}
        <div className="drill-grid">
          {filteredDrills.map(drill => {
            const progress = drillProgress[drill.id];
            const hasPlayed = progress?.attempts > 0;
            const bestScore = progress?.best || 0;

            const group = getDrillGroup(drill);
            const DrillIcon = getGroupIcon(group);
            const diffLabel = getDifficultyLabel(drill);
            const groupAccent = getGroupMeta(group).accent;

            return (
              <div key={drill.id} className="drill-card" style={{ '--a': groupAccent }}>
                <Link href={drill.path} className="thumb">
                  {/* Difficulty rides the thumbnail's top-left corner rather
                      than the body: it is a property of the drill you are
                      looking at, and up here it costs the name row nothing. */}
                  <span className={`diff-pill ${getDifficultyClass(diffLabel)}`}>
                    {diffLabel}
                  </span>
                  <img
                    src={`/previews/cards/${drill.id}.webp`}
                    alt=""
                    width={640}
                    height={360}
                    loading="lazy"
                    decoding="async"
                  />
                  <span className="dur">{drill.duration || '45s'}</span>
                  {/* Same idea as the watched-progress bar on a video
                      thumbnail: how far this player has got, at a glance. */}
                  {hasPlayed && (
                    <i className="seen" style={{ width: `${Math.min(100, bestScore / 15)}%` }} />
                  )}
                  <span className="play">
                    <Play className="w-3.5 h-3.5 fill-current" />
                  </span>
                </Link>

                <div className="body">
                  <span className="ic">
                    <DrillIcon className="w-3.5 h-3.5" />
                  </span>
                  {/* Name only. A personal best next to it was noise on a
                      picking screen — it says nothing about what the drill is,
                      and "New" on everything unplayed made a wall of cards all
                      shout the same word. The progress bar on the thumbnail
                      already carries "you have played this". */}
                  <div className="info">
                    <h3 className="nm text-white">{drill.name}</h3>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

      </div>
    </div>
  );
}