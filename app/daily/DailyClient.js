'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  CheckCircle2, Play, Flame,
  Layers, Grid3x3, Shield, Crosshair, Contrast, Copy, Brain, Puzzle, Fingerprint, Zap,
} from 'lucide-react';
import { getDailyChallenge } from '../../lib/dailyChallenge';
import { getStreak } from '../../lib/progressStore';
import { DRILL_INDEX } from '../../lib/drillIndex';

// One small original mark per drill, not a shared category icon — a wall of
// three identical icons said nothing about which game was which. These are
// SkillDrills' own picks from the app's existing lucide set (Grid3x3 for a
// grid, Crosshair for a moving target, Fingerprint for a finger-tap drill,
// and so on), not anything borrowed from a competitor's icon set.
const DRILL_LOGO = {
  'multi-tasking': Layers,
  'concentration-grid': Grid3x3,
  'distraction-fighter': Shield,
  'moving-target': Crosshair,
  'shade-finder': Contrast,
  'card-matching': Copy,
  'grid-memorization': Brain,
  'tower-of-hanoi': Puzzle,
  'finger-sequencing': Fingerprint,
  'quick-dodge': Zap,
};

export default function DailyClient() {
  const [challenge, setChallenge] = useState(null);
  const [streak, setStreak] = useState(0);

  useEffect(() => {
    async function load() {
      try {
        const [today, s] = await Promise.all([
          getDailyChallenge(),
          getStreak()
        ]);
        setChallenge(today);
        setStreak(s.current);
      } catch (error) {
        console.error("Failed to load daily challenge:", error);
      }
    }
    load();
  }, []);

  return (
    <div className="min-h-screen pb-28 text-slate-100 bg-[#050508]" style={{ paddingTop: 'calc(16px + env(safe-area-inset-top))' }}>
      <div className="relative px-4 pt-0 max-w-lg mx-auto space-y-6">

        {/* Header */}
        <div className="flex items-center justify-between">
          <h1 className="font-display text-[28px] text-white">Today&apos;s Drills</h1>
          {streak > 0 && (
            <div className="flex items-center gap-1 px-3 py-1.5 rounded-2xl bg-orange-500/15 border border-orange-500/20">
              <Flame className="w-3.5 h-3.5 text-orange-400 animate-pulse" />
              <span className="text-xs font-black text-orange-300">{streak}d</span>
            </div>
          )}
        </div>

        {/* Today's set. No section label above it — the page heading is
            already the words "Today's Drills", and a second copy in caps
            three inches below it just said the same thing twice. */}
        <div className="space-y-4">
          {(challenge?.drills || []).map((drill) => {
            const completed = drill.completed;
            const details = DRILL_INDEX.find(d => d.id === drill.id) || drill;
            const duration = details.duration || '45s';
            const DrillLogo = DRILL_LOGO[drill.id] || Zap;

            return (
              // One accent for all three cards, not one per category. The
              // per-category version made the set look like three unrelated
              // offers; today's drills are a single set, so they read as one.
              // Completed cards still swap to green — that is a state, not a
              // category, and it needs to stand out from the other two.
              <div
                key={drill.id}
                className="viewfinder-box relative rounded-3xl border p-5 transition-all duration-300"
                style={{
                  '--a': completed ? '#22c55e' : 'var(--brand-2)',
                  background: 'linear-gradient(135deg, color-mix(in srgb, var(--a) 14%, transparent), transparent 62%), var(--card)',
                  borderColor: 'color-mix(in srgb, var(--a) 26%, transparent)',
                }}
              >
                <div className="viewfinder-corner tl" />
                <div className="viewfinder-corner tr" />
                {/* [ logo ]  [ name + metadata, flexes ]  [ play ] — three
                    fixed-purpose zones so a long name never reaches the
                    button; it truncates in its own middle column instead. */}
                <div className="flex items-center gap-3.5">
                  <div
                    className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl"
                    style={{ background: 'color-mix(in srgb, var(--a) 18%, transparent)', color: 'var(--a)' }}
                  >
                    <DrillLogo className="w-6 h-6" />
                  </div>

                  <div className="min-w-0 flex-1">
                    <h3 className="font-display text-xl text-white leading-none truncate">
                      {drill.name}
                    </h3>
                    <div className="flex items-center gap-1.5 mt-1.5 text-[10px] text-white/60 font-semibold">
                      <span>{duration}</span>
                      <span className="text-white/25">&bull;</span>
                      <span>2&times; XP</span>
                    </div>
                  </div>

                  {/* The play button IS the "start" control — completed
                      drills show a static checkmark instead of a link,
                      since replaying from here was never something the old
                      full-width button offered either. */}
                  {completed ? (
                    <div
                      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl text-emerald-400 bg-emerald-500/10 border border-emerald-500/20"
                      aria-label={`${drill.name} completed`}
                    >
                      <CheckCircle2 className="w-5 h-5" />
                    </div>
                  ) : (
                    <Link
                      href={drill.path || '/drills'}
                      aria-label={`Start ${drill.name}`}
                      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl text-white shadow-md transition-transform duration-150 active:scale-90 cursor-pointer"
                      style={{ background: 'var(--a)' }}
                    >
                      <Play className="w-[18px] h-[18px] ml-0.5" fill="currentColor" />
                    </Link>
                  )}
                </div>
              </div>
            );
          })}
        </div>

      </div>
    </div>
  );
}
