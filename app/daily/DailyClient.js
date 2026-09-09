'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  CheckCircle2, Play, Flame, Swords,
  Layers, Grid3x3, Shield, Crosshair, Contrast, Copy, Brain, Puzzle, Fingerprint, Zap,
} from 'lucide-react';
import { getDailyChallenge } from '../../lib/dailyChallenge';
import { getArenaChallenge } from '../../lib/arenaChallenge';
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

// One card shape for both the daily drill set and the Arena Challenge set, so
// they read as siblings. `href` is where a tap goes (a drill page for the
// daily set, /challenge?duel=<slug> for an Arena Challenge); `meta` is the
// small line under the name.
function DrillCard({ drillId, name, meta, completed, href }) {
  const DrillLogo = DRILL_LOGO[drillId] || Zap;
  return (
    <div
      className="relative rounded-2xl border p-5 transition-colors duration-200"
      style={{
        '--a': completed ? '#22c55e' : 'var(--brand-2)',
        background: 'var(--card)',
        borderColor: completed ? 'color-mix(in srgb, #22c55e 34%, var(--line))' : 'var(--line)',
      }}
    >
      <div className="flex items-center gap-3.5">
        <div
          className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border"
          style={{ background: 'var(--card-raised)', borderColor: 'var(--line)', color: 'var(--a)' }}
        >
          <DrillLogo className="w-6 h-6" />
        </div>

        <div className="min-w-0 flex-1">
          <h3 className="font-display text-xl text-white leading-none truncate">{name}</h3>
          <div className="flex items-center gap-1.5 mt-1.5 text-[10px] text-white/60 font-semibold">
            {meta}
          </div>
        </div>

        {completed ? (
          <div
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border text-emerald-400"
            style={{ background: 'var(--card-raised)', borderColor: 'color-mix(in srgb, #22c55e 34%, var(--line))' }}
            aria-label={`${name} completed`}
          >
            <CheckCircle2 className="w-5 h-5" />
          </div>
        ) : (
          <Link
            href={href}
            aria-label={`Start ${name}`}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-white transition-transform duration-150 active:scale-90 cursor-pointer"
            style={{ background: 'var(--a)' }}
          >
            <Play className="w-[18px] h-[18px] ml-0.5" fill="currentColor" />
          </Link>
        )}
      </div>
    </div>
  );
}

export default function DailyClient() {
  const [challenge, setChallenge] = useState(null);
  const [arena, setArena] = useState(null);
  const [streak, setStreak] = useState(0);

  useEffect(() => {
    async function load() {
      try {
        const [today, a, s] = await Promise.all([
          getDailyChallenge(),
          getArenaChallenge(),
          getStreak()
        ]);
        setChallenge(today);
        setArena(a);
        setStreak(s.current);
      } catch (error) {
        console.error("Failed to load daily challenge:", error);
      }
    }
    load();
    // A duel finished in another tab/route updates the Arena set — refresh it
    // when the player returns to this page rather than showing a stale count.
    function refreshArena() {
      getArenaChallenge().then(setArena).catch(() => {});
    }
    window.addEventListener('focus', refreshArena);
    document.addEventListener('visibilitychange', refreshArena);
    return () => {
      window.removeEventListener('focus', refreshArena);
      document.removeEventListener('visibilitychange', refreshArena);
    };
  }, []);

  return (
    <div className="min-h-screen pb-28 text-slate-100 bg-[#050508]" style={{ paddingTop: 'calc(16px + env(safe-area-inset-top))' }}>
      <div className="relative px-4 pt-0 max-w-lg mx-auto space-y-6">

        {/* Header */}
        <div className="flex items-center justify-between">
          <h1 className="font-display text-[28px] text-white">Today&apos;s Drills</h1>
          {streak > 0 && (
            <div
              className="flex items-center gap-1 px-3 py-1.5 rounded-xl border"
              style={{ background: 'var(--card)', borderColor: 'var(--line)' }}
            >
              <Flame className="w-3.5 h-3.5 text-orange-400" />
              <span className="text-xs font-black text-orange-300">{streak}d</span>
            </div>
          )}
        </div>

        {/* Today's set. No section label above it — the page heading is
            already the words "Today's Drills", and a second copy in caps
            three inches below it just said the same thing twice. */}
        <div className="space-y-4">
          {(challenge?.drills || []).map((drill) => {
            const details = DRILL_INDEX.find(d => d.id === drill.id) || drill;
            return (
              <DrillCard
                key={drill.id}
                drillId={drill.id}
                name={drill.name}
                completed={drill.completed}
                href={drill.path || '/drills'}
                meta={<>
                  <span>{details.duration || '45s'}</span>
                  <span className="text-white/25">&bull;</span>
                  <span>2&times; XP</span>
                </>}
              />
            );
          })}
        </div>

        {/* Arena Challenges — a second daily set, cleared by duel play. Same
            card shape as the drills above; tapping one jumps to the Arena and
            auto-starts matchmaking for that drill (see ?duel= in
            ChallengeArenaClient). Finishing one never touches the daily drill
            set, the streak or best scores — it pays flat XP. */}
        {arena && arena.drills.length > 0 && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Swords className="w-4 h-4 text-violet-300" />
                <h2 className="font-display text-[22px] text-white">Arena Challenges</h2>
              </div>
              <span className="text-[11px] font-black tabular-nums text-white/50">
                {arena.completedCount}/{arena.total}
              </span>
            </div>

            {arena.drills.map((d) => (
              <DrillCard
                key={d.slug}
                drillId={d.id}
                name={d.name}
                completed={d.completed}
                href={`/challenge?duel=${encodeURIComponent(d.slug)}`}
                meta={<>
                  <span>Arena duel</span>
                  <span className="text-white/25">&bull;</span>
                  <span>2&times; XP</span>
                </>}
              />
            ))}
          </div>
        )}

      </div>
    </div>
  );
}
