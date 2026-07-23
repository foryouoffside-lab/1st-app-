'use client';

// app/drills/cognitive/CognitiveHubClient.js
// SkillDrills Pro — Cognitive Brain Training Sector

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  Brain, Clock, Play,
  Home, ChevronRight, Activity, Cpu, Sparkles, Search
} from 'lucide-react';
import { getAllDrillProgress } from '../../../lib/progressStore';
import { DRILL_INDEX } from '../../../lib/drillIndex';
import { SUB_GROUPS, getGroupMeta, getDrillGroup, getGroupIcon } from '../../../lib/drillGroups';

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

    const resize = () => {
      canvas.width = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
    };
    resize();
    window.addEventListener('resize', resize);

    const particles = [];
    const count = 25;
    for (let i = 0; i < count; i++) {
      particles.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        vx: (Math.random() - 0.5) * 0.25,
        vy: (Math.random() - 0.5) * 0.25,
        radius: Math.random() * 2 + 1
      });
    }

    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = 'rgba(142, 97, 246, 0.22)';
      ctx.strokeStyle = 'rgba(142, 97, 246, 0.05)';

      particles.forEach((p, index) => {
        p.x += p.vx;
        p.y += p.vy;

        if (p.x < 0 || p.x > canvas.width) p.vx *= -1;
        if (p.y < 0 || p.y > canvas.height) p.vy *= -1;

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

      animationFrameId = requestAnimationFrame(draw);
    };
    draw();

    return () => {
      cancelAnimationFrame(animationFrameId);
      window.removeEventListener('resize', resize);
    };
  }, [isLoaded]);

  // Filter Cognitive drills
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
  });

  // Calculate stats
  const totalDrills = scopedDrills.length;
  const playedCount = scopedDrills.filter(d => drillProgress[d.id]?.attempts > 0).length;

  const activeGroupMeta = activeGroup !== 'all' ? getGroupMeta(activeGroup) : null;
  const HeroIcon = activeGroupMeta ? activeGroupMeta.icon : Brain;

  const getDifficultyClass = (difficulty) => {
    const diff = String(difficulty).toLowerCase();
    if (diff === 'beginner' || diff === 'easy') return 'beginner';
    if (diff === 'intermediate' || diff === 'medium') return 'intermediate';
    if (diff === 'advanced' || diff === 'hard') return 'advanced';
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
    if (diff === 'elite') return 'Elite';
    return 'Intermediate';
  };

  if (!isLoaded) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#050508]">
        <div className="text-center space-y-3">
          <div className="w-10 h-10 border-2 border-violet-500 border-t-transparent rounded-full animate-spin mx-auto"></div>
          <p className="text-[10px] text-neutral-500 font-mono uppercase tracking-widest">Calibrating Synaptic Core...</p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="min-h-screen pb-28 text-slate-100 bg-[#050508] relative overflow-hidden"
      style={{ '--a': activeGroupMeta ? activeGroupMeta.accent : 'var(--c-cognitive)', paddingTop: 'calc(16px + env(safe-area-inset-top))' }}
    >
      {/* Background Gradient */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[320px] bg-[radial-gradient(circle_at_50%_0%,rgba(139,92,246,0.12),transparent_55%)]" />

      {/* Decorative Particle Canvas */}
      <canvas style={{ touchAction: 'none' }} ref={canvasRef} className="absolute inset-0 w-full h-full pointer-events-none z-0 opacity-30" />

      <div className="relative px-4 max-w-lg mx-auto space-y-6 z-10">
        
        {/* 1. Category Hero */}
        <div className="cat-hero">
          <div className="glowspot" />
          <div className="cat-hero-top">
            <div className="cat-hero-icon">
              <HeroIcon className="w-7 h-7" />
            </div>
            <div>
              <h1 className="font-black tracking-tight text-white leading-tight">
                {activeGroupMeta ? `${activeGroupMeta.name} Training` : 'Cognitive Sector'}
              </h1>
            </div>
          </div>
          <p className="desc text-xs mt-3 leading-relaxed text-slate-400">
            {activeGroupMeta
              ? activeGroupMeta.description
              : 'Overclock working memory metrics, reaction speeds, and selective attention thresholds using scientific cognitive modules.'}
          </p>
          {/* Only shown on the "All Drills" view — at the subcategory level
              the drill count just repeats what the picker card below already
              says, and a completion % out of 2-6 drills is too coarse to be
              a meaningful signal. */}
          {!activeGroupMeta && (
            <div className="cat-hero-stats mt-4 flex gap-6">
              <div>
                <b className="text-sm font-black text-white">{totalDrills}</b>
                <span className="text-[9px] uppercase tracking-wider text-slate-500 block">Total Drills</span>
              </div>
              <div>
                <b className="text-sm font-black text-white">{playedCount}</b>
                <span className="text-[9px] uppercase tracking-wider text-slate-500 block">Played By You</span>
              </div>
              <div>
                <b className="text-sm font-black text-white">{playedCount > 0 ? Math.round((playedCount / totalDrills) * 100) : 0}%</b>
                <span className="text-[9px] uppercase tracking-wider text-slate-500 block">Completion</span>
              </div>
            </div>
          )}
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

        {/* 4. Drill listing (Mobile Row List - standard for app layout) */}
        <div className="drill-list space-y-2">
          {filteredDrills.map(drill => {
            const progress = drillProgress[drill.id];
            const hasPlayed = progress?.attempts > 0;
            const bestScore = progress?.best || 0;

            const group = getDrillGroup(drill);
            const DrillIcon = getGroupIcon(group);
            const diffLabel = getDifficultyLabel(drill);
            const groupAccent = getGroupMeta(group).accent;

            return (
              <div key={drill.id} className="drill-row" style={{ '--a': groupAccent }}>
                <div className="glow" />
                <div className="ic shrink-0">
                  <DrillIcon className="w-4.5 h-4.5" />
                </div>
                <div className="info">
                  <span className="catlabel">{getGroupMeta(group).name}</span>
                  <h3 className="nm text-white">{drill.name}</h3>
                  <div className="meta">
                    <span className={`diff-pill ${getDifficultyClass(diffLabel)}`}>
                      {diffLabel}
                    </span>
                    <span className="dur">{drill.duration || '45s'}</span>
                  </div>
                </div>
                <div className="right shrink-0">
                  {hasPlayed ? (
                    <>
                      <span className="pb">Best: {bestScore}</span>
                      <div className="bar">
                        <i style={{ width: `${Math.min(100, (bestScore / 1.5))}%` }} />
                      </div>
                    </>
                  ) : (
                    <span className="notstarted">Not started</span>
                  )}
                </div>
                <Link href={drill.path} className="play-btn cursor-pointer shrink-0 ml-2">
                  <Play className="w-3.5 h-3.5 fill-current" />
                </Link>
              </div>
            );
          })}
        </div>

      </div>
    </div>
  );
}