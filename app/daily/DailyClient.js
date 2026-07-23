'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Sparkles, Timer, CheckCircle2, ArrowRight,
  Flame, CalendarDays, Trophy, TrendingUp, Crosshair
} from 'lucide-react';
import { msUntilMidnight, getDailyChallenges } from '../../lib/dailyChallenge';
import { getStreak } from '../../lib/progressStore';
import { DRILL_INDEX } from '../../lib/drillIndex';

// Why each of today's 3 drills was picked — mirrors the `reason` tag
// lib/dailyChallenge.js attaches during personalization. 'random' (cold
// start, not enough local history yet) intentionally shows no badge rather
// than claim a personalization that hasn't happened yet.
const REASON_META = {
  focus:     { label: 'Your Focus',        icon: Crosshair,  className: 'text-violet-300 bg-violet-500/10 border-violet-500/20' },
  weakness:  { label: 'Growth Area',       icon: TrendingUp, className: 'text-amber-300 bg-amber-500/10 border-amber-500/20' },
  momentum:  { label: 'Your Strength',     icon: Trophy,     className: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/20' },
  discovery: { label: 'Try Something New', icon: Sparkles,   className: 'text-cyan-300 bg-cyan-500/10 border-cyan-500/20' },
};

function useMidnightCountdown() {
  const [countdown, setCountdown] = useState('');

  useEffect(() => {
    function update() {
      const ms = msUntilMidnight();
      if (ms <= 0) {
        setCountdown('00:00:00');
        return;
      }
      const hrs = String(Math.floor(ms / 3600000)).padStart(2, '0');
      const mins = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
      const secs = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
      setCountdown(`${hrs}:${mins}:${secs}`);
    }
    update();
    const interval = window.setInterval(update, 1000);
    return () => window.clearInterval(interval);
  }, []);

  return countdown;
}

export default function DailyClient() {
  const [challenges, setChallenges] = useState([]);
  const [streak, setStreak] = useState(0);
  const countdown = useMidnightCountdown();

  useEffect(() => {
    async function load() {
      try {
        const [dailyList, s] = await Promise.all([
          getDailyChallenges(),
          getStreak()
        ]);
        setChallenges(dailyList);
        setStreak(s.current);
      } catch (error) {
        console.error("Failed to load daily challenges:", error);
      }
    }
    load();
  }, []);

  const completedCount = challenges.filter(c => c.completed).length;
  const totalCount = challenges.length;
  const progressPercent = totalCount ? Math.round((completedCount / totalCount) * 100) : 0;

  return (
    <div className="min-h-screen pb-28 text-slate-100 bg-[#050508]" style={{ paddingTop: 'calc(16px + env(safe-area-inset-top))' }}>
      {/* Background Gradient */}
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[320px] bg-[radial-gradient(circle_at_50%_0%,rgba(139,92,246,0.18),transparent_55%)]" />

      <div className="relative px-4 pt-0 max-w-lg mx-auto space-y-6">
        
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-1.5 mb-1">
              <CalendarDays className="w-4 h-4 text-violet-400" />
              <span className="text-[10px] font-black text-violet-300 uppercase tracking-widest">Midnight Calibration</span>
            </div>
            <h1 className="text-2xl font-black text-white tracking-tight">Daily Routines</h1>
          </div>
          {streak > 0 && (
            <div className="flex items-center gap-1 px-3 py-1.5 rounded-2xl bg-orange-500/15 border border-orange-500/20">
              <Flame className="w-3.5 h-3.5 text-orange-400 animate-pulse" />
              <span className="text-xs font-black text-orange-300">{streak}d</span>
            </div>
          )}
        </div>

        {/* Progress Tracker Card */}
        <div className="rounded-3xl border border-neutral-800 bg-[#12131c] p-5 shadow-2xl relative overflow-hidden">
          <div className="absolute top-0 right-0 w-24 h-24 bg-violet-600/5 rounded-full blur-xl pointer-events-none" />
          <div className="flex justify-between items-center mb-3">
            <div>
              <span className="text-xs text-neutral-400 font-bold uppercase tracking-wider block">Today's Progress</span>
              <span className="text-lg font-black text-white mt-1 block">
                {completedCount} of {totalCount} Calibrations Complete
              </span>
            </div>
            <div className="text-right">
              <span className="text-xs text-neutral-500 font-bold block"><Timer className="w-3 h-3 inline mr-1" /> RESETS IN</span>
              <span className="text-sm font-black text-violet-300 tabular mt-0.5 block">{countdown || '--:--'}</span>
            </div>
          </div>
          <div className="h-2 rounded-full overflow-hidden bg-neutral-900">
            <div 
              className="h-full rounded-full bg-gradient-to-r from-violet-500 via-indigo-500 to-cyan-400 transition-all duration-500"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
          <p className="text-[11px] text-neutral-500 mt-3 leading-relaxed">
            {completedCount === totalCount
              ? "All routines finalized. Calibration parameters locked, streak preserved!"
              : "Each exercise below earns double XP on its own — finish all 3 for a bonus on top."}
          </p>
        </div>

        {/* 3 Daily Challenge Cards List */}
        <div className="space-y-4">
          <div className="text-xs font-bold text-neutral-500 uppercase tracking-widest">Active Routines</div>
          {challenges.map(({ drill, completed }, index) => {
            const details = DRILL_INDEX.find(d => d.id === drill.id) || drill;
            const difficulty = details.difficulty || 'intermediate';
            const duration = details.duration || '2 min';
            const reasonMeta = REASON_META[drill.reason] || null;

            return (
              <div 
                key={drill.id}
                className={`relative rounded-3xl border p-5 transition-all duration-300 ${
                  completed 
                    ? 'border-emerald-500/20 bg-emerald-950/5' 
                    : 'border-neutral-800 bg-[#12131c] hover:border-neutral-700'
                }`}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex gap-3.5">
                    {/* Emoji Box */}
                    <div className="w-12 h-12 rounded-2xl bg-neutral-900 flex items-center justify-center text-2xl shadow-inner shrink-0">
                      {drill.emoji || '🎯'}
                    </div>
                    <div>
                      <h3 className="text-base font-black text-white leading-snug">
                        {drill.name}
                      </h3>
                      <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
                        <span className={`diff-pill ${difficulty} text-[8.5px] px-2 py-0.5 rounded-full font-bold uppercase`}>
                          {difficulty}
                        </span>
                        <span className="text-[10px] text-neutral-500 font-semibold">{duration}</span>
                        {reasonMeta && (
                          <div className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[8.5px] font-black uppercase tracking-wider ${reasonMeta.className}`}>
                            <reasonMeta.icon className="w-2.5 h-2.5" />
                            {reasonMeta.label}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Completion Status Badge */}
                  {completed && (
                    <div className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-black text-[9px] uppercase tracking-wider shrink-0">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      Done
                    </div>
                  )}
                </div>

                {/* Bottom CTA */}
                {!completed && (
                  <Link 
                    href={drill.path || '/drills'} 
                    className="mt-4 flex items-center justify-center gap-2 w-full py-3 rounded-2xl text-xs font-black bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white shadow-lg shadow-violet-950/20 transition active:scale-[.98] cursor-pointer"
                  >
                    Start Challenge {index + 1}
                    <ArrowRight className="w-3.5 h-3.5" />
                  </Link>
                )}
              </div>
            );
          })}
        </div>

        {/* Informative Footer */}
        <div className="text-center py-4 text-[10px] text-neutral-600 space-y-1">
          <p>Each daily exercise triggers double XP yield on completion.</p>
          <p>Reset occurs automatically at local midnight.</p>
        </div>

      </div>
    </div>
  );
}
